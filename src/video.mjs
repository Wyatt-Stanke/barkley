// A video of one fuzz corpus path, played from a fresh page with the fuzzer's own restores (as fuzz.mjs replayChain).
//
//   node src/video.mjs <build dir> [out.mp4] [--node=<id>] [--corpus=<dir | corpus.json.gz>] [--speed=N] [--port=N]
//
// The build must be the unobfuscated or minified one the corpus was made on (fuzz.mjs build). --node picks the path's
// last node; the default is the longest path in the corpus, by steps. The game runs at 60 steps a second (oController
// sets room_speed 60; a few intro rooms run slower) and the video at 60 frames a second, so --speed=1 (the default) is
// real time and --speed=N draws every Nth step; a huge --speed only checks that the path replays. The canvas is
// captured after each drawn step and piped to ffmpeg, scaled 2x (nearest neighbour); there's no sound (the fuzz page
// runs the game muted). Writes <out>.txt beside it: when each room and plot is reached, in video time. Exits 1 on a
// crash or when the path ends anywhere but where the corpus recorded it.
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Browser, harness, serve, setPort } from './fuzz.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name, d) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d;
const [root, outArg] = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
if (!root) {
	console.error(
		readFileSync(new URL(import.meta.url), 'utf8')
			.split('\n')[2]
			.replace(/^\/\/ */, 'usage: '),
	);
	process.exit(1);
}
const speed = +flag('speed', 1);
if (flag('port')) setPort(+flag('port'));

// the corpus: by default the packed one in the repo, whose paths all replay to where they were recorded (fuzz.mjs
// verify checks them). The working copy (build/fuzz/corpus) has more paths, but one that owns nothing at its end can
// depend on snapshots that are gone and replay somewhere else (its longest, 122,450 steps, sticks at plot 2).
const corpusPath = path.resolve(flag('corpus', path.join(HERE, '..', 'fuzz', 'corpus.json.gz')));
const { state, nodes } = statSync(corpusPath).isDirectory()
	? {
			state: JSON.parse(readFileSync(path.join(corpusPath, 'state.json'), 'utf8')),
			nodes: JSON.parse(readFileSync(path.join(corpusPath, 'nodes.json'), 'utf8')),
		}
	: JSON.parse(gunzipSync(readFileSync(corpusPath)).toString());
const byId = new Map(nodes.map((n) => [n.id, n]));
const frames = (program) => program.reduce((a, s) => a + s[1], 0);
const chainOf = (n) => {
	const out = [];
	for (; n; n = byId.get(n.parent)) out.unshift(n);
	return out;
};
const leaf = flag('node')
	? byId.get(+flag('node'))
	: nodes
			.map((n) => [n, chainOf(n).reduce((a, c) => a + frames(c.program), 0)])
			.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
if (!leaf) throw new Error(`no node ${flag('node')} in ${corpusPath}`);
const chain = chainOf(leaf);
// the root's program is the boot (title skip and New season); every other step plays on from its parent
const steps = [state.boot, ...chain.slice(1).map((n) => n.program)];
const total = steps.reduce((a, p) => a + frames(p), 0);
const out = outArg ?? path.resolve(`fuzz-${leaf.id}.mp4`);
const time = (step) => {
	const s = Math.floor(step / 60 / speed);
	return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
console.log(
	`node ${leaf.id}: ${chain.length} steps, ${total} game steps, ending in ${leaf.probe.room} plot ${leaf.probe.plot}; ` +
		`video ${time(total)} at ${speed}x -> ${out}`,
);

const server = await serve(root);
const b = new Browser(95, path.join(tmpdir(), `barkley-video-${process.pid}`), harness(root), {
	shots: true,
	through: true, // as the corpus was recorded and as verify replays it (patched crash classes don't end the game)
});
const ffmpeg = spawn(
	'ffmpeg',
	[
		...['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-'],
		...['-vf', 'scale=iw*2:ih*2:flags=neighbor', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p'],
		...['-movflags', '+faststart', out],
	],
	{ stdio: ['pipe', 'inherit', 'inherit'] },
);
const ffmpegDone = new Promise((r) => ffmpeg.on('close', r));
process.on('exit', () => b.kill());
await b.start();

// Played as fuzz.mjs replayChain plays a path: after every step but the last the page snapshots as the fuzzer did (a
// snapshot uses up an instance id), and a step the fuzzer began by restoring a snapshot begins by restoring the one
// just taken (a restore is not quite continuous play, and verify replays paths this way). Calls end at every drawn step
// and at every step boundary; keys are released only at a step boundary, as each recorded episode ended.
const timeline = [];
let done = 0,
	where = '',
	prev,
	res;
const started = Date.now();
run: for (let s = 0; s < steps.length; s++) {
	if (s > 0 && chain[s].loaded && prev) {
		const err = await b.call((x) => __fuzz.load(x), prev);
		if (err) throw new Error(`restore before step ${s} failed: ${JSON.stringify(err)}`);
	}
	let piece = [];
	for (const [i, [keys, n]] of steps[s].entries()) {
		for (let left = n; left > 0; ) {
			const take = Math.min(left, speed - (done % speed));
			piece.push([keys, take]);
			left -= take;
			done += take;
			const draw = done % speed === 0;
			const stepEnd = left === 0 && i === steps[s].length - 1;
			if (!draw && !stepEnd) continue;
			// the canvas is read in the same call as the drawn step (before the page presents it, which would leave
			// the WebGL drawing buffer blank): about 15 ms a step, where a DevTools screenshot takes 50
			res = await b.call(
				(req) => {
					const r = __fuzz.replay(req);
					if (req.drawLast) r.png = document.querySelector('canvas').toDataURL('image/png').slice(22);
					return r;
				},
				{
					program: piece,
					drawLast: draw,
					hold: !stepEnd,
					saveAt: stepEnd && s < steps.length - 1 ? [piece.length] : [],
				},
				600000,
			);
			const p = res.crash?.probe ?? res.probe;
			if (stepEnd) prev = res.saves[piece.length] ?? prev;
			piece = [];
			if (`${p.room} ${p.plot}` !== where) {
				where = `${p.room} ${p.plot}`;
				timeline.push(`${time(done)}  ${p.room}  plot ${p.plot}`);
				console.log(`${time(done)}  ${p.room}  plot ${p.plot}  (step ${done}/${total})`);
			}
			if (draw) {
				if (!ffmpeg.stdin.write(Buffer.from(res.png, 'base64')))
					await new Promise((r) => ffmpeg.stdin.once('drain', r));
				if ((done / speed) % 1800 === 0) {
					const rate = done / ((Date.now() - started) / 1000);
					console.log(`  ${((done / total) * 100).toFixed(1)}%, ${Math.round((total - done) / rate / 60)} min left`);
				}
			}
			if (res.crash) break run;
		}
	}
}
ffmpeg.stdin.end();
await ffmpegDone;
server.close();
b.kill();

const p = res.crash?.probe ?? res.probe;
// Only the end is compared: the probes recorded on the way can be stale (a rebased path can pass through a step
// differently and still end where it was recorded), as fuzz.mjs verify only checks where paths end.
const same = ['room', 'plot', 'x', 'y'].every((k) => p[k] === leaf.probe[k]);
const end = `${same ? 'replayed as recorded' : 'DRIFTED'}: ended in ${p.room} plot ${p.plot} at (${p.x},${p.y}); the corpus recorded ${leaf.probe.room} plot ${leaf.probe.plot} at (${leaf.probe.x},${leaf.probe.y})`;
timeline.push('', res.crash ? `crash: ${res.crash.message}` : end);
writeFileSync(`${out}.txt`, `${timeline.join('\n')}\n`);
console.log(res.crash ? `crash at step ${done}: ${res.crash.message}` : end);
console.log(`${out} (${Math.round((Date.now() - started) / 60000)} min)`);
process.exit(res.crash || !same ? 1 : 0);
