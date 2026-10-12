#!/usr/bin/env node
// Coverage- and novelty-guided fuzzer for the HTML5 build, in headless Chromium over the DevTools protocol (no npm
// packages). It needs an unobfuscated modernized build, which `build` makes.
//
//   node fuzz/fuzz.mjs build  <project .yyp> <build dir> [--minify]
//   node fuzz/fuzz.mjs run    <build dir> [--save[=<dir>]] [--corpus[=<file|dir>]] [--through] [--verbose]
//                                            [--workers=N] [--minutes=M] [--port=N] [--draw]
//   node fuzz/fuzz.mjs verify <build dir> [--minutes=M] [--all] [--strict] [--save[=<dir>]] [--corpus=<file>] [...]
//   node fuzz/fuzz.mjs replay <build dir> <finding dir | crash report file> [--shots=<every N frames>] [--through]
//
// build: the same as node src/build.mjs, which says what it makes.
//
// run: a Go-Explore style search. A new game is started once and snapshotted (the root). Each worker (one browser
// each) then keeps picking an archived snapshot, restoring it in place, and playing a random input program built from
// macros (walks, taps, Z mashes, waits, programs that found something before). After each input segment the page
// reports what is new:
//   - a cell: room, plot, battle, player position in 32 px;
//   - a (room, GML function) pair, e.g. a cutscene step cin_0163 running in the apartment;
//   - a value of a game global never seen before (story flags: plot=3, treasure[3]=1, party[1]=2; globals whose
//     values churn are learned as volatile and ignored).
// What the new game has anyway is marked known first. The page snapshots the game wherever it finds something, and
// that node owns the new features. Picks favour nodes chosen less often, found recently, that found more, and further
// in the story (plot, rooms on the path, story globals changed since the root); the title, menus and the debug room
// hardly count.
// Crashes are grouped by message and GML function. The first of each kind is replayed on a separate browser from its
// nearest snapshot with the same restores (a determinism check) and from a fresh page with no restores at all,
// which tells a real crash from an artifact of the resume snapshots. Milestones (the first node in a new room or at
// a new plot) are replayed from a fresh page too, with screenshots.
//   --save       keep the findings in build/fuzz/<date-time>/ (or --save=<dir>): summary.md,
//                crashes/<n>/ and paths/<n>-<room>-p<plot>/ with a report, the inputs, a snapshot and screenshots.
//                Without it they go to the temporary work dir, which is printed at the start.
//   --verbose    a line per episode (new cells ◆, functions ƒ, flags ⚑), crashes and milestones as they happen.
//   --workers    browsers (default: physical cores - 2, leaving room for the two replay browsers);
//   --minutes    stop after M minutes (default: at Ctrl-C);
//   --corpus     start from the archive in git, fuzz/corpus.json.gz (or --corpus=<file.json.gz>), and keep it: it is
//                unpacked into build/fuzz/corpus (kept as it is, snapshots and all, when it came from this very file)
//                and packed again at every save, every 5 minutes and at the end. The paths, features, learned globals,
//                exits, known crashes; --corpus=<dir> keeps a plain directory instead. From another build, every path
//                is played again to make its snapshot again.
//   --through    patch known crash classes in the page (numbers drawn as text, real() of a non-number,
//                script_execute of a number that is no script) so the
//                search goes on past them. Each patched spot is still reported (kind "patched", once per signature)
//                and replayed without the patches; other crashes are caught as usual.
//   --draw       keep WebGL drawing (slower).
//   --port=N     serve the build on port N (default 8870) and give the browsers ports N+530 to N+629, so two fuzz
//                processes can run at once (run and replay take it).
//
// verify: checks the game against the corpus rather than looking for new things. It plays the corpus's paths again
// on this build (the furthest of each room and plot and the ones on their way; --all: every one), with --through, then
// explores for --minutes (default none), and replays any crash the corpus doesn't know. Exit 1 on a new crash that
// replays; paths that now end elsewhere and places no path reached are warnings (--strict: failures). The verdict is
// <findings>/verify.md, and is appended to $GITHUB_STEP_SUMMARY. The corpus is only read.
//
// replay: plays a finding's full input path from a fresh page with no restores, with screenshots in <finding>/replay.
// Given a crash report instead (the BARKLEY-CRASH-1: text a player sends, from crash.js and patch modernized/07), it
// restores the report's checkpoint and replays the recorded steps: their key events, frame times and, through the
// checkpoint's seed, the same random numbers. It says whether the crash came back, or, for a report the player asked
// for with BUG, what the game state differs in. The build should be the one the report came from.
//
// lib/ is the Node side (fuzzer.mjs the search, the rest by concern), page/ the in-page side (virtual clock, coverage,
// snapshots, restores, the generators), injected as one script; fuzz/README.md has the design.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { build } from '../src/build.mjs';
import { Browser } from './lib/browser.mjs';
import { PACK, packCorpus, unpackCorpus } from './lib/corpus.mjs';
import { Fuzzer } from './lib/fuzzer.mjs';
import { harness } from './lib/harness.mjs';
import { replay, replayReport } from './lib/replay.mjs';
import { serve, setPort } from './lib/serve.mjs';
import { ROOT, stamp } from './lib/util.mjs';

// For one-off probe scripts (the command line runs only under import.meta.main)
export { Browser, Fuzzer, harness, packCorpus, serve, setPort, unpackCorpus };

// ---- command line ----
if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name, d) => {
		const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
		return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
	};
	const [cmd, ...pos] = args.filter((a) => !a.startsWith('--'));
	if (flag('port', false)) setPort(+flag('port'));
	if (cmd === 'build' && pos.length === 2) {
		build(path.resolve(pos[0]), path.resolve(pos[1]), !!flag('minify', false));
	} else if ((cmd === 'run' || cmd === 'verify') && pos.length === 1) {
		const verify = cmd === 'verify';
		const save = flag('save', false);
		const work = path.resolve(flag('work', path.join(tmpdir(), `barkley-fuzz-${stamp()}`)));
		// --corpus: the packed corpus in git, unpacked into build/fuzz/corpus and packed again on every save;
		// --corpus=<file.json.gz> another packed one; --corpus=<dir> a plain directory, not packed. verify reads the
		// packed one (or --corpus=<file>) into its work dir and never writes it.
		const c = flag('corpus', verify);
		const pack = c === true ? PACK : typeof c === 'string' && c.endsWith('.gz') ? path.resolve(c) : undefined;
		const corpus = verify
			? path.join(work, 'corpus')
			: c === false
				? undefined
				: pack
					? path.join(ROOT, 'build', 'fuzz', 'corpus')
					: path.resolve(c);
		if (verify && !existsSync(pack ?? '')) throw new Error(`verify needs a packed corpus (${pack ?? c})`);
		if (pack) unpackCorpus(pack, corpus);
		const cores = process.platform === 'darwin' ? +execSync('sysctl -n hw.physicalcpu') : availableParallelism();
		const f = new Fuzzer(path.resolve(pos[0]), {
			workers: +flag('workers', Math.max(1, cores - 2)),
			minutes: +flag('minutes', 0),
			draw: !!flag('draw', false),
			through: verify || !!flag('through', false),
			corpus,
			pack: verify ? undefined : pack,
			verify,
			spine: verify && !flag('all', false),
			strict: !!flag('strict', false),
			verbose: !!flag('verbose', false),
			work,
			save: save === false ? undefined : path.resolve(save === true ? path.join(ROOT, 'build', 'fuzz', stamp()) : save),
		});
		process.on('exit', () => {
			for (const b of f.children) b.kill();
		});
		process.on('SIGINT', () => {
			if (f.stop) process.exit(1);
			f.stop = true;
			console.log('\nstopping (Ctrl-C again to quit at once)');
		});
		process.on('SIGTERM', () => process.exit(1));
		const ok = await f.run();
		process.exit(ok === false ? 1 : 0);
	} else if (cmd === 'replay' && pos.length === 2) {
		const target = path.resolve(pos[1]);
		if (statSync(target).isFile()) await replayReport(path.resolve(pos[0]), target, +flag('shots', 600));
		else await replay(path.resolve(pos[0]), target, +flag('shots', 600), !!flag('through', false));
	} else {
		console.error(
			readFileSync(new URL(import.meta.url), 'utf8')
				.split('\n')
				.slice(1, 10)
				.join('\n')
				.replace(/^\/\/ ?/gm, ''),
		);
		process.exit(1);
	}
}
