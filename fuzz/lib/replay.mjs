import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Browser } from './browser.mjs';
import { harness } from './harness.mjs';
import { serve } from './serve.mjs';
import { green, red, yellow } from './util.mjs';

// ---- replay a finding from a fresh page, with screenshots ----
export async function replay(root, dir, every, through) {
	const file = existsSync(path.join(dir, 'crash.json')) ? 'crash.json' : 'path.json';
	const { chain } = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
	const boot = JSON.parse(readFileSync(path.join(dir, '..', '..', 'boot.json'), 'utf8'));
	const out = path.join(dir, 'replay');
	mkdirSync(out, { recursive: true });
	const server = await serve(root);
	const b = new Browser(90, path.join(tmpdir(), `barkley-fuzz-replay-${process.pid}`), harness(root), {
		shots: true,
		through,
	});
	process.on('exit', () => b.kill());
	await b.start();
	// the steps as one program, with the fuzzer's snapshots at the same places (each uses up an instance id)
	const steps = [boot, ...chain.slice(1).map((s) => s.program)];
	const program = steps.flat();
	const saveAt = [];
	for (let i = 0, at = 0; i < steps.length - 1; i++) {
		at += steps[i].length;
		saveAt.push(at);
	}
	let frame = 0,
		shot = 0,
		seg = 0,
		res;
	while (seg < program.length) {
		const start = seg;
		for (let f = 0; seg < program.length && f < every; seg++) f += program[seg][1];
		res = await b.call(
			(req) => __fuzz.replay(req),
			{
				program: program.slice(start, seg),
				saveAt: saveAt.filter((s) => s > start && s <= seg).map((s) => s - start),
				drawLast: true,
			},
			600000,
		);
		frame += res.frames;
		await b.shot(path.join(out, `${String(shot++).padStart(4, '0')}-f${frame}.png`));
		const p = res.crash?.probe ?? res.probe;
		console.log(`frame ${String(frame).padStart(6)}: ${p.room} plot ${p.plot} (${p.x},${p.y})`);
		if (res.crash) break;
	}
	console.log(res.crash ? red(`crash: ${res.crash.message}\n${res.crash.stack}`) : 'no crash');
	console.log(`screenshots in ${out}`);
	server.close();
	b.kill();
	process.exit(res.crash ? 1 : 0);
}

// ---- replay a crash report from a player (crash.js) ----
function decodeReport(file) {
	const b64 = (readFileSync(file, 'utf8').match(/BARKLEY-CRASH-1:([A-Za-z0-9+/=\s]+)/) ?? [])[1];
	if (!b64) throw new Error(`${file} holds no crash report (BARKLEY-CRASH-1: ...)`);
	return JSON.parse(gunzipSync(Buffer.from(b64.replace(/\s+/g, ''), 'base64')).toString());
}

export async function replayReport(root, file, every) {
	const r = decodeReport(file);
	const out = `${file}.replay`;
	mkdirSync(out, { recursive: true });
	writeFileSync(
		path.join(out, 'report.json'),
		JSON.stringify(
			{
				...r,
				checkpoint: r.checkpoint && { ...r.checkpoint, state: '(state.json)' },
				end: r.end ? '(end.json)' : null,
			},
			null,
			1,
		),
	);
	if (r.checkpoint) writeFileSync(path.join(out, 'state.json'), r.checkpoint.state);
	if (r.end) writeFileSync(path.join(out, 'end.json'), r.end);
	console.log(`${r.kind === 'crash' ? 'crash' : 'report asked for'} at ${r.time}`);
	console.log(`  page    ${r.page} (${r.bundle})`);
	console.log(`  browser ${r.agent}`);
	console.log(`  window  ${r.window?.join(' x ')}`);
	if (r.error)
		console.log(
			red(`  ${r.error.message}`),
			`\n${r.error.stack
				.split('\n')
				.map((l) => `    ${l.trim()}`)
				.join('\n')}`,
		);
	const state = r.checkpoint && JSON.parse(r.checkpoint.state);
	console.log(
		`  ${r.steps.length} steps and ${r.events.length} key events after the checkpoint${state ? ` in ${state.room}` : ''}`,
	);
	if (!state) return console.log('no checkpoint (the game was in the intro or a menu): nothing to replay');

	// the build: a report only restores into the one it was made with
	const game = readFileSync(path.join(root, 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
	const stamp = +readFileSync(path.join(root, 'html5game', game), 'utf8').match(
		/resume_data,"build"\)\),([\d.]+)\)/,
	)[1];
	if (Math.abs(state.build - stamp) > 1e-5) {
		console.log(
			yellow(`  the report is from another build (${state.build}, this one is ${stamp}): replaying it anyway`),
		);
		state.build = stamp;
	}
	const snap = JSON.stringify({
		resume: JSON.stringify(state),
		held: r.checkpoint.held,
		latch: r.checkpoint.latch,
		files: r.checkpoint.files,
		first: r.events.filter((e) => e[0] === 0),
		rendt: r.steps[0],
	});

	const server = await serve(root);
	const b = new Browser(90, path.join(tmpdir(), `barkley-fuzz-report-${process.pid}`), harness(root), { shots: true });
	process.on('exit', () => b.kill());
	await b.start();
	const line = (m) => m.split('\n')[0].trim();
	const err = await b.call((s) => __fuzz.load(s), snap, 600000);
	if (err) {
		// the checkpoint's own step is the restore's frame, so a crash in it comes back here
		const same = r.error && line(err.message) === line(r.error.message);
		console.log(
			same
				? green(`the crash came back, in the checkpoint's own step: ${err.message}`)
				: red(`the checkpoint did not restore: ${err.message}`),
		);
		server.close();
		b.kill();
		process.exit(same ? 0 : 1);
	}
	// step 0 ran with the restore. For a crash, one step past the recorded ones may hold it: the game stopped before
	// that step's frame time was recorded.
	const total = r.steps.length + (r.kind === 'crash' ? 1 : 0);
	let res = null,
		shot = 0;
	for (let from = 1; from < total && !res?.crash; from += every) {
		const to = Math.min(total, from + every);
		res = await b.call(
			(req) => __fuzz.reportRun(req),
			{
				events: r.events,
				steps: r.steps,
				from,
				to,
				drawLast: true,
			},
			600000,
		);
		await b.shot(path.join(out, `${String(shot++).padStart(4, '0')}-s${to}.png`));
		const p = res.crash?.probe ?? res.probe;
		console.log(`step ${String(to).padStart(6)}: ${p.room} plot ${p.plot} (${p.x},${p.y})`);
	}
	if (res?.crash) {
		const same = r.error && line(res.crash.message) === line(r.error.message);
		console.log(`${same ? green('the crash came back') : red('another crash')}: ${res.crash.message}`);
		console.log(
			res.crash.stack
				.split('\n')
				.map((l) => `    ${l.trim()}`)
				.join('\n'),
		);
	} else if (r.kind === 'crash') console.log(red('no crash'));
	if (r.end) {
		const diffs = await b.call((e) => __fuzz.reportDiff(e), r.end, 600000);
		writeFileSync(path.join(out, 'differences.json'), JSON.stringify(diffs, null, 1));
		console.log(
			diffs.length
				? yellow(`the replayed game differs in ${diffs.length} value(s):`)
				: green('the replayed game matches the report exactly'),
		);
		for (const [what, now, then] of diffs.slice(0, 20)) console.log(`    ${what}: ${now} (the report: ${then})`);
	}
	console.log(`screenshots in ${out}`);
	server.close();
	b.kill();
	process.exit(res?.crash && r.kind === 'crash' ? 0 : r.kind === 'crash' ? 1 : 0);
}
