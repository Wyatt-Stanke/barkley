import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keysOnly } from './programs.mjs';
import { MENU_ROOMS } from './story.mjs';
import { bold, cyan, dur, red, rnd, yellow } from './util.mjs';

// What an episode found: new features and nodes, exits, milestones and crashes.
export const findings = {
	// Takes in what an episode started at `from` found. Returns what was new, for the log.
	absorb(from, _program, res) {
		const program = res.rec; // what actually ran (generators recorded as plain input)
		this.stats.episodes++;
		this.stats.frames += res.frames;
		this.stats.byPlot ??= {};
		this.stats.byPlot[from.probe.plot] = (this.stats.byPlot[from.probe.plot] ?? 0) + res.frames;
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
				if (d.length < 60) d.push(keysOnly(program.slice(0, find.seg)));
				else d[rnd(0, d.length - 1)] = keysOnly(program.slice(0, find.seg));
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
	},

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
	},

	crash(c, leaf) {
		const fn = (c.stack.match(/gml_(?:Object|Script|Room)_\w+/) ?? ['?'])[0];
		const sig = `${c.kind}: ${c.message
			.split('\n')[0]
			.replace(/ref (object|instance) [\w.]+/g, 'ref $1 X')
			.replace(/\d+/g, 'N')
			.replace(/_\w\w\b/g, '_')
			.slice(0, 160)} @ ${fn}`;
		let e = this.crashes.get(sig);
		// verify: a known crash that comes back is recorded and replayed as a new one is, so a fixed bug returning fails
		const record = !e || (e.old && this.opts.verify && !e.now);
		if (!e) {
			e = { n: this.crashes.size + 1, sig, count: 0 };
			this.crashes.set(sig, e);
		}
		if (record) {
			e.first = { ...c, leaf, at: Date.now() - this.stats.t0 };
			e.verify = undefined;
			e.dir = path.join(this.out, 'crashes', String(e.n));
			mkdirSync(e.dir, { recursive: true });
			const chain = this.chain(leaf);
			// the nearest step with a snapshot that the next step started from (a restore), so replaying from it is exact
			let a = chain.length - 2;
			while (a > 0 && !(this.nodes.get(chain[a].id)?.snap && chain[a + 1].loaded)) a--;
			e.snapAt = a;
			writeFileSync(path.join(e.dir, 'crash.json'), JSON.stringify({ sig, crash: c, snapshotStep: a, chain }, null, 1));
			writeFileSync(path.join(e.dir, 'snapshot.json.gz'), this.nodes.get(chain[a].id).snap);
			this.queue.unshift({ type: 'crash', e });
			this.say(`${red(`✖ ${e.old ? 'known' : 'new'} crash ${e.n}`)} ${red(sig)}\n  at ${JSON.stringify(c.probe)}`);
		}
		e.count++;
		e.now = (e.now ?? 0) + 1; // this run
		return e;
	},

	chain(leaf) {
		const out = [];
		for (let n = leaf; n; n = this.nodes.get(n.parent))
			out.unshift({ id: n.id, loaded: n.loaded, program: n.program, probe: n.probe });
		return out;
	},
};
