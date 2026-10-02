import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Browser } from './browser.mjs';
import { frameCount } from './programs.mjs';
import { dur, red, sleep, yellow } from './util.mjs';

// Checking finds on separate browsers: replays from snapshots and from a fresh page, crashes and milestones.
export const verify = {
	// ---- replays on a separate browser ----
	// Plays chain steps in order: before a step that started with a restore, restores the previous step's snapshot;
	// after every step but the last, takes a snapshot as the fuzzer did (it uses up an instance id). A crash comes back
	// with the index of its step; probes are where each step ended.
	async replayChain(v, steps, snap) {
		const probes = [];
		let prev = snap,
			r = { crash: null, probe: null };
		if (snap) {
			const err = await v.call((s) => __fuzz.load(s), snap);
			if (err) return { crash: err, step: 0 };
		}
		for (const [i, s] of steps.entries()) {
			if (s.loaded && prev && i > 0) {
				const err = await v.call((x) => __fuzz.load(x), prev);
				if (err) return { crash: err, step: i };
			}
			const last = i === steps.length - 1;
			r = await v.call(
				(req) => __fuzz.replay(req),
				{ program: s.program, saveAt: last ? [] : [s.program.length], drawLast: last },
				600000,
			);
			if (r.crash) return { ...r, step: i };
			probes.push(r.probe);
			prev = r.saves[s.program.length] ?? prev;
		}
		return { ...r, probes };
	},

	// From a fresh page: the new game, then every step with no restores.
	fromBoot(v, chain) {
		return this.replayChain(
			v,
			[{ loaded: false, program: this.boot.program }, ...chain.slice(1).map((s) => ({ ...s, loaded: false }))],
			null,
		);
	},

	// verify: the longest path the rebase played, once more from a fresh page with no restores at all. The rebase played
	// it with the fuzzer's restores; continuous play has to end in the same place, or a restore is not what the game does
	// and every path, and every crash a restore led to, is in doubt. A few minutes on its own browser.
	async freshCheck() {
		const frames = (n) => frameCount(this.chain(n).flatMap((s) => s.program));
		const leaf = this.candidates.reduce((a, n) => (frames(n) > frames(a) ? n : a));
		const b = new Browser(80, path.join(this.work, 'browsers', 'fresh'), this.source, this.opts);
		this.children.push(b);
		const out = { id: leaf.id, frames: frames(leaf), want: leaf.probe };
		try {
			await b.start();
			const r = await this.fromBoot(b, this.chain(leaf));
			out.got = r.crash?.probe ?? r.probe;
			out.crash = r.crash?.message;
		} catch (err) {
			out.error = err.message.split('\n')[0];
		}
		b.kill();
		const g = out.got ?? {};
		out.room = !out.crash && !out.error && g.room === out.want.room && g.plot === out.want.plot;
		out.exact = out.room && ['x', 'y', 'battle'].every((k) => g[k] === out.want[k]);
		this.fresh = out;
	},

	async verifyCrash(v, e) {
		// a patched crash is replayed without the patches, where it should really crash
		v.through = this.opts.through && e.first.kind !== 'patched';
		const { chain, snapshotStep } = JSON.parse(readFileSync(path.join(e.dir, 'crash.json'), 'utf8'));
		const same = (r) =>
			r.crash &&
			r.crash.message.split('\n')[0].replace(/_\w\w\./, '') === e.first.message.split('\n')[0].replace(/_\w\w\./, '');
		const say = (r) =>
			same(r) ? 'reproduced' : r.crash ? `other crash: ${r.crash.message.split('\n')[0].slice(0, 80)}` : 'no crash';
		await v.start();
		let r = await this.replayChain(
			v,
			chain.slice(snapshotStep + 1),
			gunzipSync(readFileSync(path.join(e.dir, 'snapshot.json.gz'))).toString(),
		);
		const fromSnapshot = say(r);
		await v.shot(path.join(e.dir, 'from-snapshot.png'), true); // the frame after the crash (the crashed one wasn't drawn)
		await v.start();
		r = await this.fromBoot(v, chain);
		const fromBoot = say(r);
		await v.shot(path.join(e.dir, 'from-boot.png'), true);
		e.verify = `from its snapshot: ${fromSnapshot}; from a fresh page: ${fromBoot}`;
		e.bootProbe = r.crash?.probe ?? r.probe;
		this.crashReport(e, chain);
	},

	async verifyPath(v, m) {
		v.through = this.opts.through;
		const snap = gunzipSync(m.node.snap).toString();
		await v.start();
		await this.replayChain(v, [{ program: [[[], 1]] }], snap);
		await v.shot(path.join(m.dir, 'shot.png'));
		const chain = this.chain(m.node);
		await v.start();
		const r = await this.fromBoot(v, chain);
		await v.shot(path.join(m.dir, 'from-boot.png'));
		const p = m.node.probe,
			q = r.crash?.probe ?? r.probe;
		m.verify = r.crash
			? `crashed: ${r.crash.message.split('\n')[0].slice(0, 80)}`
			: q?.room === p.room && q?.plot === p.plot
				? `same room and plot${q.x === p.x && q.y === p.y ? ' and position' : ` at (${q.x},${q.y})`}`
				: `ended in ${q?.room} plot ${q?.plot}`;
		const frames = m.node.frames;
		const md = [
			`# Milestone ${m.n}: ${p.room}, plot ${p.plot}`,
			'',
			`- Why: ${m.why}; found after ${dur(m.at)} of fuzzing`,
			`- Where: ${JSON.stringify(p)}`,
			`- Path: ${chain.length} steps, ${frames} frames (${(frames / 60).toFixed(0)} s of play) from the new game; rooms on the way: ${m.node.rooms.join(' → ')}`,
			`- Played again from a fresh page with no restores: ${m.verify}`,
			'',
			'Files: `path.json` (every input step from the new game), `snapshot.json.gz` (the game state), `shot.png` (the',
			'snapshot restored), `from-boot.png` (the screen at the end of the fresh-page replay).',
			'',
			`Replay with screenshots: \`node fuzz/fuzz.mjs replay ${this.root} ${m.dir}\``,
		];
		writeFileSync(path.join(m.dir, 'report.md'), `${md.join('\n')}\n`);
	},

	async verifier(i) {
		const v = new Browser(99 - i, path.join(this.work, 'browsers', `verify${i}`), this.source, {
			shots: true,
			through: this.opts.through,
		});
		this.children.push(v);
		// (verify: once the search stops, the crashes still queued are replayed before it ends)
		while (!this.stopping || this.draining) {
			const job = this.queue.shift();
			if (!job) {
				if (this.stopping) return;
				await sleep(500);
				continue;
			}
			try {
				if (job.type === 'crash') {
					await this.verifyCrash(v, job.e);
					this.say(`${red(`✖ crash ${job.e.n}`)} replayed: ${job.e.verify}`);
				} else {
					await this.verifyPath(v, job.m);
					this.say(`${yellow(`★ milestone ${job.m.n}`)} replayed from a fresh page: ${job.m.verify}`);
				}
			} catch (err) {
				if (this.stopping && !this.draining) break;
				const what = job.e ?? job.m;
				what.verify = `replay failed: ${err.message.split('\n')[0]}`;
				this.say(yellow(`replay of ${job.type} ${what.n} failed: ${err.message.split('\n')[0]}`));
			}
		}
	},
};
