import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { packCorpus } from './corpus.mjs';
import { frameCount } from './programs.mjs';
import { MENU_ROOMS, storyFlags } from './story.mjs';
import { dim, dur, sleep, yellow } from './util.mjs';

// The archive: nodes and their snapshots, the corpus on disk (saved, loaded, and played again on a new build).
export const archive = {
	// ---- the corpus: the archive kept between runs (--corpus) ----
	// Function numbers depend on the build, so features and the page log store function names.
	vKey(k, map) {
		return k.startsWith('v:') ? k.replace(/:([^:]+)$/, (_, f) => `:${map(f)}`) : k;
	},

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
	},

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
	},

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
		// A battle or a death in the middle of a walk was once recorded as where the door led (page/walk.js INTERRUPTS);
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
	},

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
						// the steps on its way (no target is among them) now end where this build put them
						for (const [i, s] of steps.slice(0, -1).entries()) this.nodes.get(s.id).probe = res.probes[i];
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
		// Only the paths that came back are this build's. Every other node (one no target came through, or one past a
		// drift) still has the probe of the build it was recorded on, and a replay of it goes somewhere else: the working
		// copy kept a 122,450-step path that way, which ended at plot 5 on its old build and sticks at plot 2 on this one.
		if (!this.opts.spine) {
			const keep = new Set();
			for (const [id, s] of status)
				if (s === 'done')
					for (let n = this.nodes.get(id); n && !keep.has(n.id); n = this.nodes.get(n.parent)) keep.add(n.id);
			for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.nodes.delete(id);
		}
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
	},

	addSnap(n, snap) {
		this.score(n, snap);
		n.snap = gzipSync(snap);
		n.chosen ??= 0;
		n.t ??= Date.now();
		writeFileSync(path.join(this.work, 'nodes', `${n.id}.json.gz`), n.snap);
		this.candidates.push(n);
	},
};
