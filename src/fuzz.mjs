#!/usr/bin/env node
// Coverage- and novelty-guided fuzzer for the HTML5 build, in headless Chromium over the DevTools protocol (no npm
// packages). It needs an unobfuscated modernized build, which `build` makes.
//
//   node src/fuzz.mjs build  <project .yyp> <build dir> [--minify]
//   node src/fuzz.mjs run    <build dir> [--save[=<dir>]] [--corpus[=<file|dir>]] [--through] [--verbose]
//                                            [--workers=N] [--minutes=M] [--port=N] [--draw]
//   node src/fuzz.mjs verify <build dir> [--minutes=M] [--all] [--strict] [--save[=<dir>]] [--corpus=<file>] [...]
//   node src/fuzz.mjs replay <build dir> <finding dir | crash report file> [--shots=<every N frames>] [--through]
//
// build: an Igor HTML5 build with obfuscation off (gml_* names kept), from a copy of the project and of the user folder.
// --minify shrinks it with terser, keeping the names: that build is what gets deployed, so a crash report from a player
// carries readable GML stacks and the fuzzer can replay it.
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
// fuzz-page.js is the in-page side (virtual clock, coverage, snapshots, restores).
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { writeBuild } from './offline.mjs';
import { chrome, igor } from './toolchain.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// --port: the build's server; the browsers' DevTools ports are port+530 to port+629 (default 8870, 9400-9499)
let HTTP_PORT = 8870;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
const dur = (ms) =>
	ms < 60000
		? `${(ms / 1000).toFixed(0)}s`
		: `${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;

const tty = process.stdout.isTTY || !!process.env.FORCE_COLOR;
const ansi = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const [dim, bold, red, green, yellow, blue, magenta, cyan] = [2, 1, '1;31', 32, 33, 34, 35, 36].map(ansi);

// ---- static server for the build ----
const TYPES = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css', // a style sheet served as anything else is ignored
	'.png': 'image/png',
	'.json': 'application/json',
	'.woff2': 'font/woff2',
};
function serve(root) {
	const server = createServer((req, res) => {
		const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
		if (!p.startsWith(root) || !existsSync(p) || !statSync(p).isFile()) return res.writeHead(404).end();
		res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
		res.end(readFileSync(p));
	});
	return new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', () => r(server)));
}

// The harness, with the runtime variable names it needs, found in the build.
function harness(root) {
	const game = readFileSync(path.join(root, 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
	const js = readFileSync(path.join(root, 'html5game', game), 'utf8');
	if (!js.includes('function gml_Script_resume_save'))
		throw new Error('needs an unobfuscated modernized build (fuzz.mjs build)');
	// both the pretty build and the minified one (fuzz.mjs build --minify, the deployed build), which writes 1e6 for
	// 1000000, turns the surface check into a conditional and folds loops and ifs
	const rng = js.match(/var state=\[\]\s*[;,]\s*(?:var\s+)?(\w+)\s*=\s*0\s*[;,]\s*(?:var\s+)?(\w+)\s*=\s*\w+\(0\)/);
	const ids = js.match(/(\w+)\s*=\s*(?:1000000|1e6)\s*[;,]\s*g_pBuiltIn\.game_id\s*=/);
	const surfaces =
		js.match(/if\((\w+)\.length!=0\)\s*\{\s*yyError\("Unbalanced surface stack/) ??
		js.match(/0==(\w+)\.length\?[^;]{0,300}?yyError\("Unbalanced surface stack/);
	const mouse = js.match(/function (\w+)\(\)\s*\{\s*if\(\w+\)\s*\{[\s\S]{0,200}?window_views_mouse_get_x\(\)/);
	// the room's method that removes destroyed instances (the runtime calls it near the end of a frame), and the room
	const sweep =
		js.match(
			/prototype\.(\w+)=\s*function\(\)\s*\{\s*var (\w+)=\[\];[\s\S]{0,200}?\.marked\)\s*\{\s*\2\[\2\.length\]=/,
		) ??
		js.match(
			/prototype\.(\w+)=function\(\)\{for\(var (\w+)=\[\],[^{}]{0,100}\{[^{}]{0,40}\.marked&&\(\2\[\2\.length\]=/,
		);
	const room = sweep && js.match(new RegExp(`(\\w+)\\.${sweep[1]}\\(\\)`));
	// frame pacing: when the next frame is due (delay = due + 1000/room_speed - now; due = now + delay)
	const pace =
		js.match(/var (\w+)=(\w+)\+1000\/(\w+)-now;\s*if\(\1<0\)\1=0;\s*\2=now\+\1;/) ??
		js.match(/(\w+)=(\w+)\+1e3\/(\w+)-(\w+);if\(\1<0&&\(\1=0\),\2=\4\+\1,/);
	if (!rng || !ids || !surfaces)
		throw new Error('RNG state, instance id counter or surface stack not found in the runtime');
	const names = { state: 'state', b: rng[1], c: rng[2], ids: ids[1], surfaces: surfaces[1], mouse: mouse?.[1] };
	Object.assign(names, { sweep: sweep?.[1], room: room?.[1], pace: pace?.[2] });
	return `window.__fuzzNames=${JSON.stringify(names)};\n${readFileSync(path.join(HERE, 'fuzz-page.js'), 'utf8')}`;
}

// ---- the corpus in git: fuzz/corpus.json.gz ----
// What the search knows, packed into one file: the state and the nodes on the way to every node that owned features
// (the rest led nowhere), without snapshots. Snapshots only restore into the build that made them, and no two builds
// are byte-identical, so a run always makes them again from the paths (rebase). The bytes depend only on the content,
// so an unchanged corpus is an unchanged file.
const PACK = path.join(HERE, '..', 'fuzz', 'corpus.json.gz');
const md5 = (b) => createHash('md5').update(b).digest('hex');
function packCorpus(dir, file) {
	const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
	const nodes = JSON.parse(readFileSync(path.join(dir, 'nodes.json'), 'utf8'));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const keep = new Set();
	for (const n of nodes)
		if (n.progress !== undefined) for (let m = n; m && !keep.has(m.id); m = byId.get(m.parent)) keep.add(m.id);
	// a crash's directory is this machine's; its signature is what the next run needs
	const crashes = st.crashes.map(({ dir: _, ...c }) => c);
	const json = JSON.stringify({ state: { ...st, build: null, crashes }, nodes: nodes.filter((n) => keep.has(n.id)) });
	const gz = gzipSync(json, { level: 9 });
	gz[9] = 3; // the gzip header's OS byte, which differs by platform
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, gz);
	renameSync(`${file}.tmp`, file);
	writeFileSync(path.join(dir, 'packed.md5'), md5(gz));
}
// Makes dir the unpacked corpus. A dir last packed to (or unpacked from) this very file is kept as it is, with the
// snapshots its build made; otherwise it is replaced.
function unpackCorpus(file, dir) {
	if (!existsSync(file)) return;
	const gz = readFileSync(file);
	const mark = path.join(dir, 'packed.md5');
	if (existsSync(mark) && readFileSync(mark, 'utf8') === md5(gz)) return;
	const { state, nodes } = JSON.parse(gunzipSync(gz).toString());
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(path.join(dir, 'nodes'), { recursive: true });
	writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
	writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
	writeFileSync(mark, md5(gz));
}

// Identifies a build: snapshots and function numbers only carry over to a run on the same one.
// HARNESS: bump when a harness change makes recorded paths play differently (the corpus then rebases)
const HARNESS = 3;
const buildId = (root) => {
	const game = readFileSync(path.join(root, 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
	return createHash('md5')
		.update(readFileSync(path.join(root, 'html5game', game)))
		.update(`harness ${HARNESS}`)
		.digest('hex');
};

// ---- one browser with one page ----
class Browser {
	// draw: keep drawing (otherwise only replays' screenshot frames are drawn); shots: a window for screenshots
	// through: patch known crash classes (__fuzz.through)
	constructor(id, dir, source, { draw = false, shots = false, through = false } = {}) {
		Object.assign(this, { id, dir, source, draw, shots, through, port: HTTP_PORT + 530 + id });
	}
	async start() {
		this.kill();
		mkdirSync(this.dir, { recursive: true });
		// No autoplay flag: the audio context stays suspended (see __fuzz.quiet).
		this.proc = spawn(
			chrome(),
			[
				'--no-sandbox',
				`--remote-debugging-port=${this.port}`,
				'--use-angle=swiftshader',
				'--enable-unsafe-swiftshader',
				'--mute-audio',
				'--disable-background-timer-throttling',
				'--disable-renderer-backgrounding',
				'--disable-backgrounding-occluded-windows',
				'--js-flags=--max-old-space-size=4096',
				`--window-size=${this.shots ? '640,480' : '320,240'}`,
				`--user-data-dir=${path.resolve(this.dir, 'profile')}`,
				'about:blank',
			],
			{ stdio: 'ignore' },
		);
		let page;
		for (let i = 0; i < 150 && !page; i++) {
			await sleep(100);
			page = await fetch(`http://127.0.0.1:${this.port}/json/list`)
				.then((r) => r.json())
				.then((l) => l.find((t) => t.type === 'page'))
				.catch(() => null);
		}
		if (!page) throw new Error(`browser ${this.id} did not start`);
		this.ws = new WebSocket(page.webSocketDebuggerUrl);
		await new Promise((r, j) => {
			this.ws.addEventListener('open', r);
			this.ws.addEventListener('error', j);
		});
		this.pending = new Map();
		this.seq = 0;
		this.ws.addEventListener('message', ({ data }) => {
			const m = JSON.parse(data);
			if (!m.id) return;
			const p = this.pending.get(m.id);
			this.pending.delete(m.id);
			if (m.error) p?.[1](new Error(m.error.message));
			else p?.[0](m.result);
		});
		this.ws.addEventListener('close', () => {
			for (const [, p] of this.pending) p[1](new Error('browser connection closed'));
			this.pending.clear();
		});
		await this.send('Page.enable');
		await this.send('Page.addScriptToEvaluateOnNewDocument', { source: this.source });
		await this.boot();
	}
	send(method, params = {}, timeout = 120000) {
		return new Promise((r, j) => {
			const id = ++this.seq;
			const t = setTimeout(() => {
				this.pending.delete(id);
				j(new Error(`timeout: ${method}`));
			}, timeout);
			const settle = (f) => (v) => {
				clearTimeout(t);
				f(v);
			};
			this.pending.set(id, [settle(r), settle(j)]);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	// Calls a function in the page with a JSON argument; throws on a page error or after the timeout.
	async call(fn, arg, timeout) {
		const expression = `(${fn})(${JSON.stringify(arg) ?? ''})`;
		const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }, timeout);
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	}
	// Loads the page, instruments the game, presses Start and waits until Game Start has run.
	async boot() {
		await this.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
		for (let i = 0; ; i++) {
			if (i > 900) throw new Error(`browser ${this.id}: the game did not start`);
			await sleep(100);
			const ok = await this.call(
				([draw, through]) => {
					const b = document.getElementById('start');
					if (window.__fuzz && b && !b.disabled) {
						__fuzz.instrument();
						b.click();
						return false;
					}
					if (b || !window.__fuzz?.ready()) return false;
					__fuzz.draw(draw); // after WebGL setup
					__fuzz.quiet();
					if (through) __fuzz.through();
					return true;
				},
				[this.draw, this.through],
			).catch(() => false);
			if (ok) break;
		}
	}
	// A screenshot; step: first run a frame with drawing on (when the last frame wasn't drawn)
	async shot(file, step = false) {
		if (step) await this.call(() => __fuzz.replay({ program: [[[], 1]], drawLast: true }));
		const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(file, Buffer.from(data, 'base64'));
	}
	kill() {
		this.proc?.kill('SIGKILL');
		this.ws?.close();
	}
}

// ---- input programs: [[held keys, frames], ...] (the game runs at 60 frames a second) ----
const DIRS = ['up', 'down', 'left', 'right'];
const tap = (k, gap = rnd(2, 14)) => [
	[[k], rnd(1, 3)],
	[[], gap],
];
const MACROS = [
	[30, () => [[[pick(DIRS)], rnd(6, 90)]]], // walk
	[5, () => [[[pick(['up', 'down']), pick(['left', 'right'])], rnd(6, 60)]]], // diagonal
	[14, () => tap('z')], // action
	[14, () => Array.from({ length: rnd(3, 15) }, () => tap('z', rnd(3, 12))).flat()], // through dialog
	[6, () => tap('x')], // cancel
	[9, () => tap(pick(DIRS))], // menu cursor
	[8, () => [[[], rnd(10, 150)]]], // wait
	[
		8,
		() => {
			const d = pick(DIRS);
			return [
				[[d], rnd(4, 30)],
				[[d, 'z'], rnd(1, 3)],
				[[d], rnd(4, 30)],
			];
		},
	], // walk and act
	[4, () => [...tap('c'), ...Array.from({ length: rnd(1, 6) }, () => tap(pick([...DIRS, 'z']))).flat(), ...tap('x')]], // start menu
];
const MACRO_TOTAL = MACROS.reduce((a, [w]) => a + w, 0);
function randomProgram(frames) {
	const p = [];
	for (let n = 0; n < frames; ) {
		let r = Math.random() * MACRO_TOTAL;
		const macro = MACROS.find(([w]) => {
			r -= w;
			return r < 0;
		});
		for (const s of macro[1]()) {
			p.push(s);
			n += s[1];
		}
	}
	return p;
}
// Generators run in the page (fuzz-page.js): dialog, exit, talk, seek, travel, battle. Their base weights; each is then
// scaled by how much it has found lately per frame played.
const GENERATORS = { talk: 3, exit: 3, seek: 2, travel: 1.5, dialog: 0.5, battle: 0 };
const retime = (prog) => prog.map(([k, n]) => [k, Math.max(1, Math.round(n * (0.7 + Math.random() * 0.6)))]);
const frameCount = (prog) => prog.reduce((a, [, n]) => a + n, 0);

// ---- the archive ----
// Rooms that hardly count: menus, the debug room and Game Over
const MENU_ROOMS = new Set([
	'RomInit',
	'RomStarter',
	'RomIntro0',
	'RomIntro1',
	'RomTitle',
	'RomLoad',
	'RomConfig',
	'RomTest',
	'RomGameover', // a dead end: it goes back to the title
]);
// Globals that churn: timers, scratch variables, cursors
const STATIC_VOLATILE = [
	'rendrate',
	'rendt',
	'rd',
	'startingTime',
	'seconds',
	'minutes',
	'hours',
	'did_action',
	'shake',
	'deltaTime',
	'temp',
	'temp2',
	'tempx',
	'tempy',
	'cvx',
	'cvy',
	'roomer',
	'lastname',
	'skip',
	'skipper',
	'selected',
	'selectedt',
	'tcou',
	'lookdir',
	'camera',
	'sprinter',
];
const VOLATILE_AFTER = 12; // values one global (or one array element) may take before the global counts as volatile
const STORY =
	/^(plot|treasure|party|scheme|aswitch|char_xp|char_eskill|item_id|item_amount|following|fogtimes|firstshen|victorian|croom)(\[|=|$)/;
const shortFn = (f) =>
	f
		.replace(/^gml_Script_/, '')
		.replace(
			/^gml_Object_(\w+?)_(Create|Destroy|Alarm|Step|Collision|Keyboard|Other|Draw|KeyPress|KeyRelease|Mouse|Trigger|CleanUp|PreCreate)_/,
			'$1.$2_',
		)
		.replace(/^gml_Room_/, 'room:');

function storyFlags(globals) {
	const out = new Map();
	for (const [name, v] of Object.entries(globals)) {
		if (!STORY.test(name)) continue;
		if (!Array.isArray(v)) out.set(name, v);
		else
			for (const [i, x] of v.entries())
				if (Array.isArray(x)) for (const [j, y] of x.entries()) out.set(`${name}[${i}][${j}]`, y);
				else out.set(`${name}[${i}]`, x);
	}
	return out;
}

class Fuzzer {
	constructor(root, opts) {
		Object.assign(this, { root, opts, work: opts.work, out: opts.save ?? path.join(opts.work, 'findings') });
		this.source = harness(root);
		this.nodes = new Map(); // id -> {id, parent, loaded, program, probe, rooms, progress, depth, frames, snap (gzip, when it owns features)}
		this.candidates = []; // nodes that own features (the ones with snapshots)
		this.features = new Map(); // key -> {key, node, chosen, t}
		this.log = []; // what the pages must learn, in order: [kind, value]
		this.volatile = new Set(STATIC_VOLATILE);
		this.values = new Map(); // global name -> flags seen
		this.crashes = new Map(); // signature -> {n, sig, count, first, verify}
		this.paths = []; // milestones
		this.dict = new Map(); // room -> programs that found something there
		this.rooms = new Set();
		this.storyRooms = new Set();
		this.stats = { episodes: 0, frames: 0, restarts: 0, t0: Date.now() };
		this.nextId = 0;
		this.maxPlot = -Infinity;
		this.queue = [];
		this.children = [];
		this.genStats = {}; // generator -> {found, frames}
		this.pastMilestones = 0; // from the corpus
		this.genErrors = new Set();
		this.build = buildId(root);
		this.exits = new Set(); // 'from|via|to'
		this.talked = new Set(); // 'room|plot.goal bits|object'
		for (const d of ['nodes', 'browsers']) mkdirSync(path.join(this.work, d), { recursive: true });
		for (const d of ['crashes', 'paths']) mkdirSync(path.join(this.out, d), { recursive: true });
		for (const v of this.volatile) this.log.push(['volatile', v]);
	}

	syncFor(w) {
		const s = { cells: [], cov: [], flags: [], volatile: [], exits: [], talked: [] };
		for (const [k, v] of this.log.slice(w.cursor)) s[k].push(v);
		w.cursor = this.log.length;
		return s;
	}

	addNode(n, snap) {
		n.id = this.nextId++;
		const parent = this.nodes.get(n.parent);
		n.depth = parent ? parent.depth + 1 : 0;
		n.frames = (parent?.frames ?? 0) + frameCount(n.program);
		n.rooms = parent?.rooms ?? [];
		if (!MENU_ROOMS.has(n.probe.room) && !n.rooms.includes(n.probe.room)) n.rooms = [...n.rooms, n.probe.room];
		if (snap) this.addSnap(n, snap);
		this.nodes.set(n.id, n);
		const { snap: _, ...meta } = n;
		appendFileSync(path.join(this.work, 'nodes.jsonl'), `${JSON.stringify(meta)}\n`);
		return n;
	}

	// ---- the corpus: the archive kept between runs (--corpus) ----
	// Function numbers depend on the build, so features and the page log store function names.
	vKey = (k, map) => (k.startsWith('v:') ? k.replace(/:([^:]+)$/, (_, f) => `:${map(f)}`) : k);

	saveCorpus() {
		const dir = this.opts.corpus;
		if (!dir || !this.boot) return;
		mkdirSync(path.join(dir, 'nodes'), { recursive: true });
		for (const n of this.candidates)
			if (!n.inCorpus) {
				writeFileSync(path.join(dir, 'nodes', `${n.id}.json.gz`), n.snap);
				n.inCorpus = true;
			}
		const write = (f, v) => {
			writeFileSync(`${f}.tmp`, JSON.stringify(v));
			renameSync(`${f}.tmp`, f);
		};
		write(
			path.join(dir, 'nodes.json'),
			[...this.nodes.values()].map(({ snap, inCorpus, ...m }) => m),
		);
		const name = (i) => this.fnNames[i];
		write(path.join(dir, 'state.json'), {
			build: this.build,
			saved: new Date().toISOString(),
			boot: this.boot.program,
			nextId: this.nextId,
			volatile: [...this.volatile],
			values: [...this.values].map(([k, v]) => [k, [...v]]),
			features: [...this.features].map(([k, f]) => [this.vKey(k, name), f.node?.id ?? null, f.chosen]),
			log: this.log.map(([k, v]) => (k === 'cov' ? [k, [v[0], name(v[1])]] : [k, v])),
			dict: [...this.dict],
			storyRooms: [...this.storyRooms],
			rooms: [...this.rooms],
			maxPlot: this.maxPlot,
			exits: [...this.exits],
			talked: [...this.talked],
			genStats: this.genStats,
			crashes: [...this.crashes.values()].map(({ n, sig, count, dir, verify }) => ({ n, sig, count, dir, verify })),
			milestones: this.pastMilestones + this.paths.length,
		});
		if (this.opts.pack) packCorpus(dir, this.opts.pack);
	}

	// Returns 'same' (the archive as it was), 'rebase' (another build: its snapshots must be made again) or null.
	loadCorpus() {
		const dir = this.opts.corpus;
		if (!dir || !existsSync(path.join(dir, 'state.json'))) return null;
		const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
		const meta = JSON.parse(readFileSync(path.join(dir, 'nodes.json'), 'utf8'));
		const same = st.build === this.build;
		const old = Date.now() - 3600000; // no recency boost for old nodes
		// the game's build stamp in a snapshot (resume_start refuses another build's): the root's is the current one
		const stamp = (gz) =>
			gunzipSync(gz)
				.toString()
				.match(/\\"build\\":([\d.e+-]+)/)?.[1];
		const rootFile = path.join(dir, 'nodes', '0.json.gz');
		const current = same && existsSync(rootFile) ? stamp(readFileSync(rootFile)) : null;
		for (const m of meta) {
			const n = { ...m, t: old };
			const f = path.join(dir, 'nodes', `${n.id}.json.gz`);
			const gz = same && n.progress !== undefined && existsSync(f) ? readFileSync(f) : null;
			if (gz && stamp(gz) === current) {
				n.snap = gz;
				n.inCorpus = true;
				this.candidates.push(n);
			} else if (gz) {
				rmSync(f);
				delete n.progress;
			}
			this.nodes.set(n.id, n);
		}
		this.nextId = st.nextId;
		this.volatile = new Set(st.volatile);
		this.values = new Map(st.values.map(([k, v]) => [k, new Set(v)]));
		this.dict = new Map(st.dict);
		this.storyRooms = new Set(st.storyRooms);
		this.rooms = new Set(st.rooms);
		this.maxPlot = st.maxPlot;
		// an exit that seems to lead to several rooms was recorded wrongly (before exits were matched to the player's
		// position); it's dropped and found again
		// A battle or a death in the middle of a walk was once recorded as where the door led (fuzz-page.js INTERRUPTS);
		// those go first, so the door's real destination is no longer counted as ambiguous
		const real = st.exits.filter((e) => !['RomInter', 'RomGameover'].includes(e.split('|')[2]));
		const dests = new Map();
		for (const e of real) ((k) => dests.set(k, (dests.get(k) ?? 0) + 1))(e.split('|').slice(0, 2).join('|'));
		this.exits = new Set(real.filter((e) => dests.get(e.split('|').slice(0, 2).join('|')) === 1));
		this.talked = new Set(st.talked);
		this.genStats = st.genStats;
		this.pastMilestones = st.milestones;
		for (const c of st.crashes) this.crashes.set(c.sig, { ...c, old: true, first: { at: 0 } });
		const fnId = new Map(this.fnNames.map((n, i) => [n, i]));
		const id = (f) => fnId.get(f) ?? -1;
		// The room a room-keyed feature belongs to ('c:<room>|…' and 'v:<room>:<fn>'); a flag has none.
		const featRoom = (k) => (k[0] === 'c' ? k.slice(2).split('|')[0] : k[0] === 'v' ? k.slice(2).split(':')[0] : null);
		// A feature is created with the probe of the node that owns it, so the two always name the same room. They can
		// only come apart through an older rebase, which replayed a path, let it drift somewhere else and kept the
		// ownership anyway (see rebase()). The owner then cannot reach the place it owns, nothing else can claim those
		// features, and no node there ever earns a snapshot - which walls the search out of that room for good. Give them
		// up so they can be found again.
		const released = new Set();
		if (same)
			for (const [k, nodeId] of st.features) {
				const r = featRoom(k),
					owner = this.nodes.get(nodeId);
				if (r && owner?.probe && owner.probe.room !== r) released.add(k);
			}
		if (same)
			for (const [k, nodeId, chosen] of st.features) {
				if (released.has(k)) continue;
				this.features.set(this.vKey(k, id), {
					key: this.vKey(k, id),
					node: this.nodes.get(nodeId) ?? null,
					chosen,
					t: 0,
				});
			}
		if (released.size)
			this.say(
				yellow(
					`corpus: ${released.size} features were owned by a path that drifted elsewhere; they are findable again`,
				),
			);
		this.corpusState = st;
		if (same) {
			this.log = st.log
				.filter(([k, v]) =>
					k === 'exits'
						? this.exits.has(v.join('|'))
						: k === 'cells'
							? !released.has(`c:${v}`)
							: k === 'cov'
								? !released.has(`v:${v[0]}:${v[1]}`)
								: true,
				)
				.map(([k, v]) => (k === 'cov' ? [k, [v[0], id(v[1])]] : [k, v]));
			this.boot = { program: st.boot, snap: gunzipSync(this.nodes.get(0).snap).toString() };
			this.rootFlags = storyFlags(JSON.parse(JSON.parse(this.boot.snap).resume).globals);
			// scores are stored, but the goals they count may have changed since
			for (const n of this.candidates) this.score(n, gunzipSync(n.snap).toString());
			return 'same';
		}
		this.log = [
			...[...this.volatile].map((v) => ['volatile', v]),
			...[...this.exits].map((e) => ['exits', e.split('|')]),
			...[...this.talked].map((t) => ['talked', t]),
		];
		return 'rebase';
	}

	// For another build: the new game is made again (root), then the archive's paths are played again on it to make
	// their snapshots. They are played as a tree, each node from the snapshot of the node its episode started from
	// (made again first), so every recorded frame is played once and the restores are the ones the search made.
	// With opts.spine only the furthest node of each room and plot is made again, with the nodes on its way (verify).
	// A replay can end somewhere else than the node recorded (another build or harness, or a change in the game). Then
	// it and everything recorded after it are dropped: their inputs were for a state that no longer happens, and kept
	// as candidates that own nothing they crowded the search (1,100 of 2,400 snapshots once stood in one room). The room
	// is the signal; the plot only counts when both sides have one (F.probe() reports null wherever global.plot is not
	// set yet). Features owned by nodes that didn't come back are forgotten, so the search finds them again, and the
	// next pack leaves those nodes out. this.rebased says how it went.
	async rebase() {
		const st = this.corpusState;
		const olds = [...this.nodes.values()].filter((n) => n.progress !== undefined && n.id !== 0);
		const had = new Set([0, ...olds.map((n) => n.id)]);
		const base = new Map(); // node -> the node its episode started from
		for (const n of olds) {
			let p = this.nodes.get(n.parent);
			while (p && !had.has(p.id)) p = this.nodes.get(p.parent);
			base.set(n.id, p?.id ?? 0);
		}
		let targets = olds;
		if (this.opts.spine) {
			const best = new Map();
			for (const n of olds) {
				const k = `${n.probe.room}|${n.probe.plot}`;
				if (!best.has(k) || best.get(k).progress < n.progress) best.set(k, n);
			}
			const want = new Set();
			for (let n of best.values())
				for (; n && n.id !== 0 && !want.has(n); n = this.nodes.get(base.get(n.id))) want.add(n);
			targets = olds.filter((n) => want.has(n));
		}
		this.rebaseTargets = targets.map((n) => ({ id: n.id, probe: n.probe }));
		for (const n of olds) delete n.progress;
		const pending = targets.sort((a, b) => a.id - b.id);
		const status = new Map([[0, 'done']]); // done (a snapshot was made), drifted, crashed, failed or skipped
		const r = { targets: targets.length, exact: 0, moved: 0, drifted: [], crashed: [], failed: 0, skipped: 0 };
		this.rebased = r;
		this.say(`corpus from another build: playing ${r.targets} paths again to make their snapshots`);
		const t0 = Date.now();
		const progress = setInterval(
			() => this.say(dim(`  rebase: ${r.targets - pending.length} of ${r.targets} paths, ${dur(Date.now() - t0)}`)),
			60000,
		);
		await Promise.all(
			this.workers.map(async (w) => {
				while (pending.length) {
					const i = pending.findIndex((n) => status.has(base.get(n.id)));
					if (i < 0) {
						await sleep(50);
						continue;
					}
					const [n] = pending.splice(i, 1);
					const from = base.get(n.id);
					if (status.get(from) !== 'done') {
						status.set(n.id, 'skipped');
						r.skipped++;
						continue;
					}
					try {
						const chain = this.chain(n);
						const steps = chain.slice(chain.findIndex((s) => s.id === from) + 1);
						const res = await this.replayChain(w.b, steps, gunzipSync(this.nodes.get(from).snap).toString());
						if (res.crash) {
							status.set(n.id, 'crashed');
							const s = steps[res.step ?? steps.length - 1];
							r.crashed.push({ id: n.id, at: s.id, probe: res.crash.probe ?? s.probe, message: res.crash.message });
							if (res.crash.kind !== 'restore')
								this.crash(res.crash, {
									parent: this.nodes.get(s.id).parent,
									loaded: s.loaded,
									program: s.program,
									probe: res.crash.probe ?? s.probe,
								});
							await this.restart(w);
							continue;
						}
						const probe = await w.b.call(() => __fuzz.probe());
						const p = n.probe;
						const samePlot = typeof probe.plot !== 'number' || typeof p.plot !== 'number' || probe.plot === p.plot;
						if (probe.room !== p.room || !samePlot) {
							status.set(n.id, 'drifted');
							r.drifted.push({ id: n.id, want: p, got: probe });
							continue;
						}
						if (probe.x === p.x && probe.y === p.y && probe.battle === p.battle) r.exact++;
						else r.moved++;
						const snap = await w.b.call(() => __fuzz.save());
						const m = { ...n, probe, snap: undefined, progress: undefined, inCorpus: false };
						this.nodes.set(n.id, m);
						this.addSnap(m, snap);
						status.set(n.id, 'done');
					} catch (err) {
						status.set(n.id, 'failed');
						r.failed++;
						this.say(yellow(`rebase of node ${n.id} failed: ${err.message.split('\n')[0]}`));
						await this.restart(w);
					}
				}
			}),
		);
		clearInterval(progress);
		// Not one path replayed: the harness or the build is broken, not the corpus. Saving now would mark the corpus as
		// this build's with none of its snapshots, so stop and leave it as it was.
		const made = [...status.values()].filter((s) => s === 'done').length - 1;
		if (r.targets && !made)
			throw new Error(
				`rebase made no snapshots from ${r.targets} paths; the corpus in ${this.opts.corpus} is unchanged`,
			);
		for (const n of olds) rmSync(path.join(this.opts.corpus, 'nodes', `${n.id}.json.gz`), { force: true });
		// the story so far is what came back, so reaching the rest again counts as a milestone again
		const back = this.candidates.map((n) => n.probe).filter((p) => !MENU_ROOMS.has(p.room));
		this.storyRooms = new Set(back.map((p) => p.room));
		this.maxPlot = Math.max(0, ...back.map((p) => p.plot ?? 0));
		const fnId = new Map(this.fnNames.map((n, i) => [n, i]));
		for (const [k, nodeId, chosen] of st.features) {
			if (status.get(nodeId) !== 'done') continue;
			const key = this.vKey(k, (f) => fnId.get(f) ?? -1);
			this.features.set(key, { key, node: this.nodes.get(nodeId), chosen, t: 0 });
			if (key.startsWith('c:')) this.log.push(['cells', key.slice(2)]);
			else if (key.startsWith('v:')) this.log.push(['cov', [key.split(':')[1], +key.split(':')[2]]]);
			else if (key.startsWith('f:')) this.log.push(['flags', key.slice(2)]);
		}
		this.say(
			`rebased ${made} of ${r.targets} paths in ${dur(Date.now() - t0)}: ${r.exact} exactly where they were recorded, ` +
				`${r.moved} in the same room at another spot, ${r.drifted.length} elsewhere, ` +
				`${r.crashed.length} crashed, ${r.failed} failed, ${r.skipped} skipped after those`,
		);
	}

	addSnap(n, snap) {
		this.score(n, snap);
		n.snap = gzipSync(snap);
		n.chosen ??= 0;
		n.t ??= Date.now();
		writeFileSync(path.join(this.work, 'nodes', `${n.id}.json.gz`), n.snap);
		this.candidates.push(n);
	}

	score(n, snap) {
		const g = JSON.parse(JSON.parse(snap).resume).globals;
		const flags = storyFlags(g);
		this.rootFlags ??= flags;
		let changed = 0;
		for (const [k, v] of flags) if (this.rootFlags.get(k) !== v) changed++;
		// plot, then the next plot's conditions met (see __fuzz.goals), rooms on the path, story globals changed
		const plot = typeof g.plot === 'number' ? g.plot : 0;
		n.progress = plot * 1000 + this.goalsMet(g, plot + 1) * 100 + n.rooms.length * 10 + Math.min(changed, 9);
	}

	// A global becomes volatile once it (or one of its array elements) has had too many values; its flags stop being
	// features. Counting per element keeps story arrays (treasure[i] is 0 or 1) in.
	learnValue(flag) {
		const name = flag.slice(0, flag.search(/[[=]/));
		if (this.volatile.has(name)) return false;
		if (name === 'goal') return true; // the page's goal mask (goal=plot:bits) has few values and must stay a feature
		const key = flag.slice(0, flag.indexOf('='));
		const set = this.values.get(key) ?? new Set();
		this.values.set(key, set.add(flag));
		if (set.size <= VOLATILE_AFTER) return true;
		this.volatile.add(name);
		this.log.push(['volatile', name]);
		for (const k of this.features.keys())
			if (k.startsWith(`f:${name}=`) || k.startsWith(`f:${name}[`)) this.features.delete(k);
		return false;
	}

	// A node to explore from: nodes chosen less often, found recently, that found more, and further in the story
	// weigh more; menu rooms hardly count. Some picks only look at the furthest plot, or at the furthest nodes.
	choose() {
		const now = Date.now();
		const all = this.candidates.filter((n) => !n.bad);
		const top = (a) => a.reduce((m, n) => Math.max(m, n.progress), -Infinity);
		let pool = all;
		const r = Math.random();
		if (r < 0.4) {
			const story = all.filter((n) => !MENU_ROOMS.has(n.probe.room));
			const t = top(story);
			const near = story.filter(
				(n) => Math.floor(n.progress / 1000) === Math.floor(t / 1000) && (r < 0.2 || n.progress >= t - 15),
			);
			if (near.length) pool = near;
		}
		const hi = top(pool);
		const lo = pool.reduce((m, n) => Math.min(m, n.progress), Infinity);
		const w = pool.map(
			(n) =>
				(1 / Math.sqrt(1 + n.chosen)) *
				(1 + 0.25 * Math.log2(1 + Math.min(n.owns, 64))) *
				(1 + (hi > lo ? (n.progress - lo) / (hi - lo) : 0)) *
				(1 + 2 * Math.exp(-(now - n.t) / 180000)) *
				(MENU_ROOMS.has(n.probe.room) ? 0.03 : 1),
		);
		let x = Math.random() * w.reduce((a, b) => a + b, 0);
		const n =
			pool[
				w.findIndex((v) => {
					x -= v;
					return x < 0;
				})
			] ?? pool[0];
		n.chosen++;
		return n;
	}

	// An input program: random macros (some starting with one that found something before), or a few generators
	// with bits of macros between them.
	program(node) {
		const frames = rnd(90, 1200);
		if (Math.random() < 0.35) {
			const d = this.dict.get(node.probe.room);
			if (d?.length && Math.random() < 0.25) return [...retime(pick(d)), ...randomProgram(frames / 2)];
			return randomProgram(frames);
		}
		const items = [{ g: 'dialog', n: 600 }];
		for (let k = rnd(1, 4); k > 0; k--) {
			const g = this.pickGenerator(node);
			items.push(g === 'travel' ? { g, n: rnd(600, 3000), to: this.goalRoom(node) } : { g, n: rnd(200, 900) });
			if (Math.random() < 0.4) items.push(...randomProgram(rnd(20, 120)));
		}
		return items;
	}

	pickGenerator(node) {
		const w = Object.entries(GENERATORS).map(([g, base]) => {
			// a fight (global.battlers is also set in some map rooms, the catacombs', where walking is what's needed)
			if (node.probe.foes !== undefined || node.probe.room === 'RomInter')
				base = g === 'battle' ? 10 : g === 'dialog' ? 1 : 0;
			if (g === 'travel' && !this.goalRoom(node)) base = 0;
			const s = this.genStats[g] ?? { found: 0, frames: 0 };
			return [g, base * (0.5 + Math.min(3, (s.found + 1) / (s.frames / 10000 + 1)))];
		});
		let x = Math.random() * w.reduce((a, [, v]) => a + v, 0);
		const pick = w.find(([, v]) => {
			x -= v;
			return x < 0;
		});
		return (pick ?? w[0])[0];
	}

	// The next plot's conditions on story state: array elements (scheme[0]) and story globals, not cinema/freeze flags
	goalConds(plot) {
		return (this.goals?.conds[plot] ?? []).filter(([name, i]) => i !== null || STORY.test(name));
	}

	goalsMet(g, plot) {
		const OPS = {
			equal: (a, b) => a === b,
			notequal: (a, b) => a !== b,
			greater: (a, b) => a > b,
			greaterequal: (a, b) => a >= b,
			less: (a, b) => a < b,
			lessequal: (a, b) => a <= b,
		};
		let met = 0;
		for (const [name, i, op, v] of this.goalConds(plot)) {
			const x = i === null ? g[name] : g[name]?.[i];
			if (typeof x === 'number' && OPS[op](x, v)) met++;
		}
		return Math.min(met, 9);
	}

	// A room where the story moves on from this node's plot (code there sets a higher plot), other than this one
	goalRoom(node) {
		const rooms = (this.goals?.rooms[node.probe.plot + 1] ?? []).filter((r) => r !== node.probe.room);
		return rooms.length ? pick(rooms) : undefined;
	}

	// Takes in what an episode started at `from` found. Returns what was new, for the log.
	absorb(from, _program, res) {
		const program = res.rec; // what actually ran (generators recorded as plain input)
		this.stats.episodes++;
		this.stats.frames += res.frames;
		for (const [g, f] of Object.entries(res.genFrames ?? {})) {
			this.genStats[g] ??= { found: 0, frames: 0 };
			this.genStats[g].frames += f;
		}
		for (const e of res.exits ?? []) {
			const k = e.join('|');
			if (!this.exits.has(k)) {
				this.exits.add(k);
				this.log.push(['exits', e]);
			}
		}
		for (const t of res.talked ?? [])
			if (!this.talked.has(t)) {
				this.talked.add(t);
				this.log.push(['talked', t]);
			}
		const news = { cells: [], fns: [], flags: [], milestones: [], crash: null };
		let parent = from.id,
			loaded = true,
			prevSeg = 0;
		// a patched crash (--through) gets the path up to its chunk, from the node before it
		const patches = [...(res.patched ?? [])];
		const flushPatches = (upto) => {
			while (patches.length && patches[0].seg <= upto) {
				const c = patches.shift();
				this.crash(c, { parent, loaded, program: program.slice(prevSeg, c.seg), probe: c.probe });
			}
		};
		for (const find of res.finds) {
			flushPatches(find.seg);
			const room = find.probe.room;
			this.rooms.add(room);
			const keys = [];
			if (find.cell) {
				keys.push(`c:${find.cell}`);
				this.log.push(['cells', find.cell]);
			}
			for (const fid of find.cov) {
				keys.push(`v:${room}:${fid}`);
				this.log.push(['cov', [room, fid]]);
			}
			for (const f of find.flags) {
				this.log.push(['flags', f]);
				if (this.learnValue(f)) keys.push(`f:${f}`);
			}
			const fresh = keys.filter((k) => !this.features.has(k));
			if (fresh.length) {
				const g = find.gen ?? 'macro';
				this.genStats[g] ??= { found: 0, frames: 0 };
				this.genStats[g].found += fresh.length;
			}
			for (const k of fresh) {
				if (k[0] === 'c') news.cells.push(k.slice(2));
				else if (k[0] === 'v') news.fns.push(this.fnNames[+k.split(':')[2]]);
				else news.flags.push(k.slice(2));
			}
			if (!find.snap) {
				for (const k of fresh) this.features.set(k, { key: k, node: null, chosen: 0, t: Date.now() });
				continue;
			}
			const node = this.addNode(
				{ parent, loaded, program: program.slice(prevSeg, find.seg), probe: find.probe, owns: fresh.length },
				fresh.length ? find.snap : null,
			);
			for (const k of fresh) this.features.set(k, { key: k, node, chosen: 0, t: Date.now() });
			if (fresh.length) {
				const d = this.dict.get(from.probe.room) ?? [];
				if (d.length < 60) d.push(program.slice(0, find.seg));
				else d[rnd(0, d.length - 1)] = program.slice(0, find.seg);
				this.dict.set(from.probe.room, d);
				if (!MENU_ROOMS.has(room) && (!this.storyRooms.has(room) || find.probe.plot > this.maxPlot)) {
					const why = !this.storyRooms.has(room) ? 'new room' : `plot ${find.probe.plot}`;
					this.storyRooms.add(room);
					this.maxPlot = Math.max(this.maxPlot, find.probe.plot ?? 0);
					news.milestones.push(this.milestone(node, why));
				}
			}
			parent = node.id;
			loaded = false;
			prevSeg = find.seg;
		}
		flushPatches(Infinity);
		if (res.crash) {
			const c = res.crash;
			const leaf = {
				parent,
				loaded,
				program: c.kind === 'restore' ? [] : program.slice(prevSeg, res.segs),
				probe: c.probe ?? from.probe,
			};
			if (c.kind === 'restore') {
				from.restoreFails = (from.restoreFails ?? 0) + 1;
				if (from.restoreFails >= 2) from.bad = true;
			}
			news.crash = this.crash(c, leaf);
		}
		return news;
	}

	milestone(node, why) {
		const p = node.probe;
		const m = { n: this.pastMilestones + this.paths.length + 1, node, why, at: Date.now() - this.stats.t0 };
		m.dir = path.join(this.out, 'paths', `${String(m.n).padStart(3, '0')}-${p.room}-p${p.plot}`);
		this.paths.push(m);
		mkdirSync(m.dir, { recursive: true });
		writeFileSync(path.join(m.dir, 'path.json'), JSON.stringify({ why, probe: p, chain: this.chain(node) }));
		writeFileSync(path.join(m.dir, 'snapshot.json.gz'), node.snap);
		if (!this.opts.verify) this.queue.push({ type: 'path', m });
		this.say(
			`${bold(yellow(`★ milestone ${m.n}`))} ${why}: ${cyan(p.room)} plot ${yellow(p.plot)} after ${dur(m.at)}, ${(node.frames / 60).toFixed(0)} s of play`,
		);
		return m;
	}

	crash(c, leaf) {
		const fn = (c.stack.match(/gml_(?:Object|Script|Room)_\w+/) ?? ['?'])[0];
		const sig = `${c.kind}: ${c.message
			.split('\n')[0]
			.replace(/ref (object|instance) [\w.]+/g, 'ref $1 X')
			.replace(/\d+/g, 'N')
			.replace(/_\w\w\b/g, '_')
			.slice(0, 160)} @ ${fn}`;
		let e = this.crashes.get(sig);
		if (!e) {
			e = { n: this.crashes.size + 1, sig, count: 0, first: { ...c, leaf, at: Date.now() - this.stats.t0 } };
			e.dir = path.join(this.out, 'crashes', String(e.n));
			this.crashes.set(sig, e);
			mkdirSync(e.dir, { recursive: true });
			const chain = this.chain(leaf);
			// the nearest step with a snapshot that the next step started from (a restore), so replaying from it is exact
			let a = chain.length - 2;
			while (a > 0 && !(this.nodes.get(chain[a].id)?.snap && chain[a + 1].loaded)) a--;
			e.snapAt = a;
			writeFileSync(path.join(e.dir, 'crash.json'), JSON.stringify({ sig, crash: c, snapshotStep: a, chain }, null, 1));
			writeFileSync(path.join(e.dir, 'snapshot.json.gz'), this.nodes.get(chain[a].id).snap);
			this.queue.unshift({ type: 'crash', e });
			this.say(`${red(`✖ new crash ${e.n}`)} ${red(sig)}\n  at ${JSON.stringify(c.probe)}`);
		}
		e.count++;
		e.now = (e.now ?? 0) + 1; // this run
		return e;
	}

	chain(leaf) {
		const out = [];
		for (let n = leaf; n; n = this.nodes.get(n.parent))
			out.unshift({ id: n.id, loaded: n.loaded, program: n.program, probe: n.probe });
		return out;
	}

	say(line) {
		if (this.opts.verbose || !/^\s*$/.test(line)) console.log(line);
	}

	// A line per episode for --verbose
	episodeLine(w, from, _program, res, news) {
		const p = from.probe;
		const bars = '▁▂▃▄▅▆▇█';
		const bar = bars[Math.min(7, Math.floor((res.frames / 1250) * 8))];
		const where = `${cyan(p.room.replace(/^Rom/, ''))}${dim('·')}${yellow(`p${p.plot}`)}`;
		const parts = [
			dim(`w${String(w.b.id).padStart(2, '0')}`),
			where.padEnd(tty ? 42 : 24),
			dim(`${bar} ${String(res.frames).padStart(4)}f`),
		];
		const list = (a, f, n) => a.slice(0, n).map(f).join(' ') + (a.length > n ? dim(` +${a.length - n}`) : '');
		if (news.cells.length)
			parts.push(
				green(`◆${news.cells.length}`) +
					' ' +
					green(list(news.cells, (c) => `${c.split('|').slice(0, 2).join('·')}@${c.split('|')[3]}`, 1)),
			);
		if (news.fns.length) parts.push(magenta(`ƒ ${list(news.fns, shortFn, 3)}`));
		if (news.flags.length) parts.push(blue(`⚑ ${list(news.flags, (f) => f, 3)}`));
		if (res.crash)
			parts.push(
				res.crash.kind === 'restore'
					? yellow(`↺ ${res.crash.message.slice(0, 60)}`)
					: red(`✖ #${news.crash.n} ${res.crash.message.split('\n')[0].slice(0, 70)}`),
			);
		if (res.ended) parts.push(dim('(game ended)'));
		if (parts.length === 3) parts.push(dim('·'));
		console.log(parts.join('  '));
	}

	status() {
		const s = this.stats;
		const t = Date.now() - s.t0;
		const kinds = { c: 0, v: 0, f: 0 };
		for (const k of this.features.keys()) kinds[k[0]] = (kinds[k[0]] ?? 0) + 1;
		const fps = s.frames / (t / 1000);
		const furthest = [...this.nodes.values()]
			.filter((n) => n.snap && !MENU_ROOMS.has(n.probe.room))
			.sort((a, b) => b.progress - a.progress)[0];
		const lines = [
			`${dur(t)}, ${this.workers.length} workers: ${s.episodes} episodes (${(s.episodes / (t / 1000)).toFixed(1)}/s), ${s.frames} frames (${fps.toFixed(0)}/s, ${(fps / 60).toFixed(0)}x real time, ${(s.frames / 216000).toFixed(1)} h of play), ${s.restarts} browser restarts`,
			`archive: ${this.nodes.size} nodes; features: ${kinds.c} cells, ${kinds.v} room×function, ${kinds.f} flags; ${this.volatile.size} volatile globals`,
			`furthest: ${furthest ? `${furthest.probe.room} plot ${furthest.probe.plot}, ${furthest.rooms.length} rooms on its path, ${(furthest.frames / 60).toFixed(0)} s of play` : '-'}`,
			`story rooms ${this.storyRooms.size}: ${[...this.storyRooms].join(' ')}; ${this.exits.size} exits taken, ${this.talked.size} things talked to`,
			`found per 10k frames: ${Object.entries(this.genStats)
				.map(([g, v]) => `${g} ${((v.found * 10000) / Math.max(1, v.frames)).toFixed(1)}`)
				.join(', ')}`,
			// known crashes from earlier runs only when they came back
			`crashes ${this.crashes.size} (${[...this.crashes.values()].filter((e) => e.old).length} from earlier runs)${[
				...this.crashes.values(),
			]
				.filter((e) => !e.old || e.now)
				.map(
					(e) => `\n  #${e.n} x${e.count}${e.old ? ` (${e.now} this run)` : ''} ${e.sig}  [${e.verify ?? 'replaying'}]`,
				)
				.join('')}`,
			`findings: ${this.out}`,
		];
		writeFileSync(path.join(this.out, 'status.txt'), `${lines.join('\n')}\n`);
		this.summary(t, lines);
		return lines;
	}

	summary(t, lines) {
		const md = [
			`# Fuzz run ${path.basename(this.out)}`,
			'',
			`- Build: \`${this.root}\``,
			`- Started ${new Date(this.stats.t0).toISOString()}, ran ${dur(t)}${this.stopping ? ' (finished)' : ' (running)'}`,
			...lines.slice(0, 5).map((l) => `- ${l}`),
			this.opts.through ? '- Known crash classes patched (--through)' : '',
			this.opts.corpus ? `- Corpus: \`${this.opts.corpus}\`` : '',
			'',
			'## Crashes',
			'',
			'| # | seen | first after | signature | replay |',
			'|---|---|---|---|---|',
			...[...this.crashes.values()].map(
				(e) =>
					`| ${e.old ? (e.dir ? `[${e.n}](${e.dir}/report.md)` : e.n) : `[${e.n}](crashes/${e.n}/report.md)`} | ${e.count} | ${e.old ? 'an earlier run' : dur(e.first.at)} | \`${e.sig.replace(/\|/g, '\\|')}\` | ${e.verify ?? 'replaying'} |`,
			),
			'',
			'## Milestones',
			'',
			'| # | why | room | plot | after | play time | from a fresh page |',
			'|---|---|---|---|---|---|---|',
			...this.paths.map(
				(m) =>
					`| [${m.n}](paths/${path.basename(m.dir)}/report.md) | ${m.why} | ${m.node.probe.room} | ${m.node.probe.plot} | ${dur(m.at)} | ${(m.node.frames / 60).toFixed(0)} s | ${m.verify ?? 'replaying'} |`,
			),
			'',
			'Replay a finding with screenshots: `node src/fuzz.mjs replay <build dir> <finding dir>`',
		];
		writeFileSync(path.join(this.out, 'summary.md'), `${md.join('\n')}\n`);
	}

	async worker(w) {
		while (!this.stopping) {
			const from = this.choose();
			const program = this.program(from);
			try {
				this.pageGoals ??= Object.fromEntries(Object.keys(this.goals?.conds ?? {}).map((p) => [p, this.goalConds(p)]));
				const res = await w.b.call(
					(req) => __fuzz.episode(req),
					{
						snap: gunzipSync(from.snap).toString(),
						program,
						sync: this.syncFor(w),
						seed: rnd(1, 2 ** 30),
						goals: this.pageGoals,
					},
					120000,
				);
				// After an exception the runtime may be left half way through a frame, so a restore that fails right after
				// one is the page's fault: it gets a fresh page and the episode doesn't count.
				if (res.crash?.kind === 'restore' && w.suspect) {
					w.suspect = false;
					await this.restart(w);
					continue;
				}
				w.suspect = res.crash?.kind === 'exception';
				const news = this.absorb(from, program, res);
				if (res.genError && !this.genErrors.has(res.genError.split('\n')[0])) {
					this.genErrors.add(res.genError.split('\n')[0]);
					this.say(
						yellow(
							`generator error (the fuzzer's bug, not the game's): ${res.genError.split('\n').slice(0, 3).join(' | ')}`,
						),
					);
				}
				if (this.opts.verbose) this.episodeLine(w, from, program, res, news);
			} catch (err) {
				if (this.stopping) break;
				// (a hang's inputs aren't known when generators ran, so it's kept only for plain programs)
				if (/timeout/.test(err.message) && program.every(Array.isArray))
					this.crash(
						{ kind: 'hang', message: 'an episode took over 120 s', stack: '', probe: from.probe },
						{ parent: from.id, loaded: true, program, probe: from.probe },
					);
				else if (/timeout/.test(err.message))
					this.say(yellow(`browser ${w.b.id}: an episode with generators hung; restarting`));
				else this.say(yellow(`browser ${w.b.id}: ${err.message.split('\n')[0]}; restarting`));
				await this.restart(w);
			}
		}
	}

	async restart(w) {
		for (let i = 0; ; i++) {
			this.stats.restarts++;
			w.cursor = 0;
			try {
				return await w.b.start();
			} catch (err) {
				this.say(yellow(`browser ${w.b.id}: ${err.message}`));
				if (i > 5) throw err;
				await sleep(2000);
			}
		}
	}

	// Title skip and New season: Z presses until the apartment. Returns the inputs and the root snapshot.
	async newGame(b) {
		const program = [];
		for (let i = 0; i < 40; i++) {
			const part = [
				[['z'], 3],
				[[], 120],
			];
			const r = await b.call((req) => __fuzz.replay(req), { program: part });
			program.push(...part);
			if (r.crash) throw new Error(`crash before the game started: ${r.crash.message}\n${r.crash.stack}`);
			if (r.probe.room === 'RomBarkleyApart') break;
		}
		return { program, snap: await b.call(() => __fuzz.save()) };
	}

	// ---- replays on a separate browser ----
	// Plays chain steps in order: before a step that started with a restore, restores the previous step's snapshot;
	// after every step but the last, takes a snapshot as the fuzzer did (it uses up an instance id). A crash comes back
	// with the index of its step.
	async replayChain(v, steps, snap) {
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
			prev = r.saves[s.program.length] ?? prev;
		}
		return r;
	}

	// From a fresh page: the new game, then every step with no restores.
	fromBoot(v, chain) {
		return this.replayChain(
			v,
			[{ loaded: false, program: this.boot.program }, ...chain.slice(1).map((s) => ({ ...s, loaded: false }))],
			null,
		);
	}

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
	}

	crashReport(e, chain) {
		const c = e.first;
		const gmlStack = c.stack
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => /gml_/.test(l) && !/<anonymous>/.test(l))
			.reduce((out, l) => {
				// the runtime's caller walk repeats a recursive frame; show it once
				const last = out.at(-1);
				if (last?.line === l) last.n++;
				else out.push({ line: l, n: 1 });
				return out;
			}, [])
			.map(({ line, n }) => (n > 1 ? `${line}  (×${n})` : line));
		const md = [
			`# Crash ${e.n}`,
			'',
			`\`${e.sig}\``,
			'',
			`- Kind: ${c.kind}; seen ${e.count} times; first after ${dur(c.at)} of fuzzing`,
			`- Where: ${JSON.stringify(c.probe)}`,
			`- Path: ${chain.length} steps from the new game, ${frameCount(chain.flatMap((s) => s.program))} frames (${(frameCount(chain.flatMap((s) => s.program)) / 60).toFixed(0)} s of play); the nearest snapshot is step ${e.snapAt}`,
			`- Replay: ${e.verify ?? 'not replayed yet'}`,
			e.bootProbe ? `- The fresh-page replay ended at ${JSON.stringify(e.bootProbe)}` : '',
			'',
			'## Message',
			'',
			'```',
			c.message,
			'```',
			'',
			'## GML stack',
			'',
			'```',
			...(gmlStack.length ? gmlStack : [c.stack]),
			'```',
			'',
			'Files: `crash.json` (the error and every input step from the new game), `snapshot.json.gz` (the game state at the',
			'nearest snapshot), `from-snapshot.png` and `from-boot.png` (the screen after each replay).',
			'',
			`Replay with screenshots: \`node src/fuzz.mjs replay ${this.root} ${e.dir}\``,
		];
		writeFileSync(path.join(e.dir, 'report.md'), `${md.join('\n')}\n`);
	}

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
			`Replay with screenshots: \`node src/fuzz.mjs replay ${this.root} ${m.dir}\``,
		];
		writeFileSync(path.join(m.dir, 'report.md'), `${md.join('\n')}\n`);
	}

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
	}

	async run() {
		const n = this.opts.workers;
		console.log(
			`${bold('barkley fuzz')}: ${n} workers on ${this.root}\n  findings: ${this.out}\n  work dir: ${this.work}`,
		);
		this.server = await serve(this.root);
		const w0 = { b: new Browser(0, path.join(this.work, 'browsers', '0'), this.source, this.opts), cursor: 0 };
		this.children.push(w0.b);
		await w0.b.start();
		this.fnNames = await w0.b.call(() => __fuzz.fnNames());
		this.goals = await w0.b.call(() => __fuzz.goals());
		const corpus = this.loadCorpus();
		if (corpus !== 'same') {
			this.boot = await this.newGame(w0.b);
			const probe = await w0.b.call(() => __fuzz.probe());
			if (corpus === 'rebase') {
				const root = this.nodes.get(0);
				Object.assign(root, { program: this.boot.program, probe });
				this.addSnap(root, this.boot.snap);
			} else this.addNode({ parent: null, loaded: false, program: this.boot.program, probe, owns: 1 }, this.boot.snap);
			// what the new game has anyway isn't news (two seconds of it, for the functions it runs)
			const base = await w0.b.call((n) => __fuzz.baseline(n), 120);
			this.log.push(['cells', base.cell], ...base.cov.map((c) => ['cov', c]), ...base.flags.map((f) => ['flags', f]));
			for (const f of base.flags) this.learnValue(f);
			this.storyRooms.add(probe.room);
			if (!corpus) this.maxPlot = probe.plot;
		}
		writeFileSync(path.join(this.out, 'boot.json'), JSON.stringify(this.boot.program));
		console.log(
			`  ${corpus === 'same' ? `corpus: ${this.candidates.length} snapshots, ${this.features.size} features, furthest plot ${this.maxPlot}` : `new game`}; ${this.fnNames.length} GML functions instrumented; story goals: ${Object.entries(
				this.goals.rooms,
			)
				.map(
					([p, r]) =>
						`plot ${p} in ${r.join('/')}${
							this.goalConds(p).length
								? ` if ${this.goalConds(p)
										.map(([n, i, o, v]) => `${n}${i === null ? '' : `[${i}]`} ${o} ${v}`)
										.join(', ')}`
								: ''
						}`,
				)
				.join(', ')}`,
		);
		this.workers = [w0];
		for (let i = 1; i < n; i++) {
			const w = { b: new Browser(i, path.join(this.work, 'browsers', String(i)), this.source, this.opts), cursor: 0 };
			this.children.push(w.b);
			this.workers.push(w);
		}
		for (let i = 1; i < n; i += 4) await Promise.all(this.workers.slice(i, i + 4).map((w) => w.b.start()));
		if (corpus === 'rebase') await this.rebase();
		this.saveCorpus();
		const saver = setInterval(() => this.saveCorpus(), 300000);
		// verify with no minutes: only the corpus replays (and their crashes)
		const explore = !this.opts.verify || this.opts.minutes > 0;
		const workers = explore ? this.workers.map((w) => this.worker(w)) : [];
		const verifiers = [this.verifier(0), this.verifier(1)];
		const every = this.opts.verbose ? 30000 : 60000;
		const box = (lines) => {
			const [head, ...rest] = lines;
			return [
				bold(`┌─ ${head}`),
				...rest.map((l) => `${bold('│')} ${l.replace(/\n/g, `\n${bold('│')} `)}`),
				bold('└─'),
			].join('\n');
		};
		const timer = setInterval(() => console.log(box(this.status())), every);
		const end = !explore ? 0 : this.opts.minutes ? Date.now() + this.opts.minutes * 60000 : Infinity;
		await new Promise((r) => {
			const check = setInterval(() => {
				if (Date.now() > end || this.stop) {
					clearInterval(check);
					r();
				}
			}, 500);
		});
		this.stopping = true;
		clearInterval(saver);
		this.saveCorpus();
		if (this.opts.verify) {
			for (const w of this.workers) w.b.kill();
			await Promise.allSettled(workers);
			this.draining = true;
			if (this.queue.length) this.say(`replaying ${this.queue.length} new crash(es) before the verdict`);
			await Promise.race([Promise.allSettled(verifiers), sleep(20 * 60000)]);
		}
		clearInterval(timer);
		this.draining = false;
		for (const b of this.children) b.kill();
		await Promise.allSettled([...workers, ...verifiers]);
		console.log(box(this.status()));
		this.server.close();
		if (this.opts.verify) return this.verdict();
	}

	// verify: whether the game still does what the corpus recorded, as markdown. It fails on a crash the corpus didn't
	// know that replays (or couldn't be replayed); crashes that only happened after the fuzzer's restores, paths that
	// now lead elsewhere and places no replayed path reached are warnings, unless --strict.
	verdict() {
		const r = this.rebased ?? { targets: 0, exact: 0, moved: 0, drifted: [], crashed: [], failed: 0, skipped: 0 };
		const fresh = [...this.crashes.values()].filter((e) => !e.old);
		const harness = (e) => ['restore', 'stall', 'hang'].includes(e.first.kind);
		const failing = fresh.filter((e) => !harness(e) && (!e.verify || /reproduced|replay failed/.test(e.verify)));
		const flaky = fresh.filter((e) => !failing.includes(e));
		const again = [...this.crashes.values()].filter((e) => e.old && e.now);
		// rooms and plots the replayed corpus paths were recorded in that none of them reached this time
		const where = (p) => `${p.room} plot ${p.plot}`;
		const want = new Set(this.rebaseTargets?.filter((n) => !MENU_ROOMS.has(n.probe.room)).map((n) => where(n.probe)));
		const got = new Set(this.candidates.map((n) => where(n.probe)));
		const lost = [...want].filter((w) => !got.has(w));
		const strict = this.opts.strict && (r.drifted.length || lost.length || r.failed);
		const ok = !failing.length && !strict;
		const s = this.stats;
		const md = [
			`## Fuzz verification: ${ok ? 'passed' : 'failed'}`,
			'',
			`- Build \`${path.basename(this.root)}\`; the corpus: ${this.nodes.size} nodes, ${this.pastMilestones} milestones, furthest plot ${this.maxPlot}`,
			`- Replayed ${r.targets} corpus paths (${this.opts.spine ? 'the furthest of each room and plot, and those on their way' : 'all of them'}): ` +
				`${r.exact} ended exactly where they were recorded, ${r.moved} in the same room elsewhere, ${r.drifted.length} went ` +
				`elsewhere, ${r.crashed.length} crashed, ${r.failed} failed to replay, ${r.skipped} skipped after those`,
			this.opts.minutes
				? `- Then explored for ${this.opts.minutes} min: ${s.episodes} episodes, ${(s.frames / 216000).toFixed(1)} h of play`
				: '',
			...(failing.length
				? ['', '### New crashes', '', ...failing.map((e) => `- \`${e.sig}\`: ${e.verify ?? 'not replayed'} (${e.dir})`)]
				: []),
			...(flaky.length
				? [
						'',
						'### New crashes that did not replay (warnings)',
						'',
						...flaky.map((e) => `- \`${e.sig}\`: ${e.verify ?? 'not replayed'}`),
					]
				: []),
			...(again.length
				? ['', '### Known crashes seen again', '', ...again.map((e) => `- \`${e.sig}\` (${e.now}×)`)]
				: []),
			...(r.drifted.length
				? [
						'',
						`### Paths that went elsewhere (${r.drifted.length})`,
						'',
						...r.drifted.slice(0, 20).map((d) => `- node ${d.id}: recorded in ${where(d.want)}, now ${where(d.got)}`),
					]
				: []),
			...(lost.length ? ['', '### Places no replayed path reached', '', ...lost.map((w) => `- ${w}`)] : []),
			'',
			`Findings: \`${this.out}\``,
		].filter((l, i, a) => l !== '' || a[i - 1] !== '');
		writeFileSync(path.join(this.out, 'verify.md'), `${md.join('\n')}\n`);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
		console.log(`\n${md.join('\n')}`);
		return ok;
	}
}

// ---- replay a finding from a fresh page, with screenshots ----
async function replay(root, dir, every, through) {
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

async function replayReport(root, file, every) {
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

// ---- an unobfuscated HTML5 build ----
function build(yyp, outDir, minify = false) {
	if (existsSync(outDir) && !existsSync(path.join(outDir, 'html5game')))
		throw new Error(`${outDir} exists and isn't a build`);
	const tmp = mkdtempSync(path.join(tmpdir(), 'barkley-fuzz-build-'));
	try {
		const proj = path.join(tmp, 'project');
		cpSync(path.dirname(yyp), proj, { recursive: true, filter: (s) => !s.includes(`${path.sep}mvc`) });
		// The extensions' files have to be the one-line stubs import.mjs writes: the page app defines their functions. A
		// project whose extensions carry their own code would draw a second touch overlay and define everything twice.
		const extensions = path.join(proj, 'extensions');
		for (const name of existsSync(extensions) ? readdirSync(extensions) : [])
			for (const f of readdirSync(path.join(extensions, name)).filter((f) => f.endsWith('.js')))
				if (!readFileSync(path.join(extensions, name, f), 'utf8').includes('barkley.extension('))
					throw new Error(
						`${yyp}: extensions/${name}/${f} isn't a page stub; import the project again (src/import.mjs)`,
					);
		// the custom index.html, at an absolute path: always the current src/web/index.html, so a page change needs no
		// re-import (and an earlier Igor build may have deleted the project's copy); writeBuild adds the page app it loads
		const index = path.join(proj, 'options', 'html5', 'index.html');
		cpSync(path.join(HERE, 'web', 'index.html'), index);
		const opts = path.join(proj, 'options', 'html5', 'options_html5.yy');
		writeFileSync(
			opts,
			readFileSync(opts, 'utf8').replace(/("option_html5_index":)"[^"]*"/, `$1${JSON.stringify(index)}`),
		);
		const { igor: IGOR, runtime: RT, userFolder: UF } = igor();
		const uf = path.join(tmp, 'user');
		cpSync(UF, uf, { recursive: true });
		const settings = JSON.parse(readFileSync(path.join(uf, 'local_settings.json'), 'utf8'));
		settings['machine.Platform Settings.HTML5.obfuscate'] = false;
		settings['machine.Platform Settings.HTML5.pretty_print'] = !minify;
		writeFileSync(path.join(uf, 'local_settings.json'), JSON.stringify(settings, null, 4));
		const r = spawnSync(
			IGOR,
			[
				'-j=8',
				`--project=${path.join(proj, path.basename(yyp))}`,
				`--rp=${RT}`,
				`--uf=${uf}`,
				`--cache=${tmp}/cache`,
				`--temp=${tmp}/temp`,
				`--of=${tmp}/out/index.html`,
				`--tf=${tmp}/pkg`,
				'-r=VM',
				'--',
				'html5',
				'folder',
			],
			{ stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp, maxBuffer: 1 << 28 },
		);
		const log = r.stdout.toString() + r.stderr.toString();
		if (r.status !== 0) throw new Error(`Igor exited ${r.status}:\n${log.slice(-3000)}`);
		if (!log.includes(`Copy: ${index}`)) console.warn('warning: Igor did not use the custom index.html');
		if (minify) {
			// -c -m without --keep-fnames would rename the gml_* functions a crash stack is made of; top-level names
			// (the runtime's own variables the harness looks for) are left alone either way.
			const game = readFileSync(path.join(tmp, 'out', 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
			const js = path.join(tmp, 'out', 'html5game', game);
			const before = statSync(js).size;
			const t = spawnSync('npx', ['-y', 'terser@5', js, '-c', '-m', '--keep-fnames', '-o', js], {
				stdio: ['ignore', 'inherit', 'inherit'],
			});
			if (t.status !== 0) throw new Error(`terser exited ${t.status}`);
			console.log(`minified ${game}: ${before} -> ${statSync(js).size} bytes`);
		}
		rmSync(outDir, { recursive: true, force: true });
		cpSync(path.join(tmp, 'out'), outDir, { recursive: true });
		// the page app (src/web), the service worker and the file list it caches the build from (a page under the fuzz
		// harness never registers the worker)
		const v = writeBuild(outDir);
		harness(outDir); // checks it's fuzzable
		console.log(`built ${outDir}: v${v.version}, build ${v.id}, ${v.files.length} files to cache`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// setPort: for probe scripts, like --port
const setPort = (n) => (HTTP_PORT = n);

export { Browser, Fuzzer, harness, packCorpus, serve, setPort, unpackCorpus };

// ---- command line ----
if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name, d) => {
		const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
		return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
	};
	const [cmd, ...pos] = args.filter((a) => !a.startsWith('--'));
	HTTP_PORT = +flag('port', HTTP_PORT);
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
					? path.join(HERE, '..', 'build', 'fuzz', 'corpus')
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
			save:
				save === false
					? undefined
					: path.resolve(save === true ? path.join(HERE, '..', 'build', 'fuzz', stamp()) : save),
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
