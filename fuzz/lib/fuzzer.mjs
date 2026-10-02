import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archive } from './archive.mjs';
import { Browser } from './browser.mjs';
import { buildId } from './corpus.mjs';
import { findings } from './findings.mjs';
import { harness } from './harness.mjs';
import { report } from './report.mjs';
import { search } from './search.mjs';
import { serve } from './serve.mjs';
import { STATIC_VOLATILE } from './story.mjs';
import { bold, rnd, sleep, yellow } from './util.mjs';
import { verify } from './verify.mjs';

export class Fuzzer {
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
						goalRooms: this.goals?.rooms,
						tierFrom: this.maxPlot > 0 ? this.maxPlot - 1 : null,
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
		const fresh = this.opts.verify && this.candidates.length > 1 ? this.freshCheck() : null;
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
			if (fresh && !this.fresh) this.say('waiting for the fresh-page replay of the longest path');
			await fresh;
			await Promise.allSettled(workers);
			this.draining = true;
			if (this.queue.length) this.say(`replaying ${this.queue.length} crash(es) before the verdict`);
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
}

// The rest of its methods, by concern
for (const group of [archive, search, findings, report, verify])
	Object.defineProperties(Fuzzer.prototype, Object.getOwnPropertyDescriptors(group));
