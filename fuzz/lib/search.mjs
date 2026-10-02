import { GENERATORS, randomProgram, retime, trainTarget } from './programs.mjs';
import { MENU_ROOMS, STORY, storyFlags, VOLATILE_AFTER } from './story.mjs';
import { pick, rnd } from './util.mjs';

// Where to go next: each node's progress, which node to start from, and the program to play from it.
export const search = {
	score(n, snap) {
		const g = JSON.parse(JSON.parse(snap).resume).globals;
		const flags = storyFlags(g);
		this.rootFlags ??= flags;
		let changed = 0;
		for (const [k, v] of flags) if (this.rootFlags.get(k) !== v) changed++;
		// plot, then the next plot's conditions met (see __fuzz.goals), how much the party has fought (levels and
		// experience: the next boss may need a stronger party, not a better fight), how far a boss fight has got, rooms
		// on the path, story globals changed; all within the plot's thousand
		const plot = typeof g.plot === 'number' ? g.plot : 0;
		let xp = 0,
			lv = 0,
			low = Infinity,
			hp = 0,
			max = 0;
		for (let i = 0; i < 8 && Array.isArray(g.party) && g.party[i] >= 0; i++) {
			xp += Math.max(0, Number(g.char_xp?.[g.party[i]]) || 0);
			lv += Number(g.char_res1?.[g.party[i]]) || 0;
			low = Math.min(low, Number(g.char_res1?.[g.party[i]]) || 0);
			hp += Math.max(0, Number(g.char_chp?.[g.party[i]]) || 0);
			max += Math.max(0, Number(g.char_hp?.[g.party[i]]) || 0);
		}
		// (probes from before these fields, filled in from the snapshot)
		n.probe.xp ??= Math.floor(xp);
		n.probe.lv ??= lv;
		if (low < Infinity) n.probe.low ??= low;
		n.probe.hp ??= max ? Math.round((100 * hp) / max) / 100 : 1;
		// between fights, the party's vitality: it carries into the next fight, a boss's too
		const health = n.probe.foes === undefined && max ? Math.round((40 * hp) / max) : 0;
		n.progress =
			plot * 1000 +
			Math.min(
				999,
				this.goalsMet(g, plot + 1) * 100 +
					Math.min(lv * 25 + Math.floor(xp / 100), 600) +
					this.fightScore(n.probe) +
					health +
					Math.min(n.rooms.length, 10) * 5 +
					Math.min(changed, 9),
			);
	},

	get bosses() {
		this._bosses ??= new Set(this.goals?.bosses ?? []);
		return this._bosses;
	},

	// How far a boss fight has got (0-200): the boss's vitality taken, then the party's left. Ordinary fights score 0,
	// so they don't outweigh the map: their end is a return to it, which the cells see anyway.
	fightScore(probe) {
		const m = probe?.foes?.match(/^(\w+):([\d.]+):(\d+):?(\d*)$/);
		if (!m || !this.bosses.has(m[1])) return 0;
		const [e, sub] = m[2].split('.').map(Number);
		const left = sub ? sub / 64 : e / 8; // the boss's vitality left, 0-1
		return Math.round(150 * (1 - left) + 10 * Number(m[3]) + 5 * (Number(m[4]) || 0));
	},

	// A global becomes volatile once it (or one of its array elements) has had too many values; its flags stop being
	// features. Counting per element keeps story arrays (treasure[i] is 0 or 1) in.
	learnValue(flag) {
		const name = flag.slice(0, flag.search(/[[=]/));
		if (this.volatile.has(name)) return false;
		// the page's goal mask (goal=plot:bits) has few values and must stay a feature; its party experience (xp=<step>)
		// has many, every one of them progress
		if (name === 'goal' || name === 'xp') return true;
		const key = flag.slice(0, flag.indexOf('='));
		const set = this.values.get(key) ?? new Set();
		this.values.set(key, set.add(flag));
		if (set.size <= VOLATILE_AFTER) return true;
		this.volatile.add(name);
		this.log.push(['volatile', name]);
		for (const k of this.features.keys())
			if (k.startsWith(`f:${name}=`) || k.startsWith(`f:${name}[`)) this.features.delete(k);
		return false;
	},

	// A node to explore from: nodes chosen less often, found recently, that found more, and further in the story
	// weigh more; menu rooms hardly count. Most picks go to the furthest plot or the one before it (where the party
	// grows strong enough for what stops it), each plot's nodes taken together, so a thousand nodes of an old plot
	// don't outweigh the twenty of a new one; half of those look only at the plot's best nodes.
	choose() {
		const now = Date.now();
		const all = this.candidates.filter((n) => !n.bad);
		const top = (a) => a.reduce((m, n) => Math.max(m, n.progress), -Infinity);
		let pool = all;
		const r = Math.random();
		if (r < 0.85) {
			const plots = new Map();
			for (const n of all)
				if (!MENU_ROOMS.has(n.probe.room)) {
					const p = Math.floor(n.progress / 1000);
					plots.set(p, [...(plots.get(p) ?? []), n]);
				}
			const order = [...plots.keys()].sort((a, b) => b - a);
			const x = Math.random();
			const tier = x < 0.55 ? 0 : x < 0.85 ? 1 : 2 + Math.floor(Math.random() * Math.max(1, order.length - 2));
			const p = order[Math.min(tier, order.length - 1)];
			if (p !== undefined) {
				pool = plots.get(p);
				const t = top(pool);
				if (Math.random() < 0.5) pool = pool.filter((n) => n.progress >= t - 60);
			}
		}
		const hi = top(pool);
		const lo = pool.reduce((m, n) => Math.min(m, n.progress), Infinity);
		const w = pool.map(
			(n) =>
				(1 / Math.sqrt(1 + n.chosen)) *
				(1 + 0.25 * Math.log2(1 + Math.min(n.owns, 64))) *
				(1 + (hi > lo ? (3 * (n.progress - lo)) / (hi - lo) : 0)) *
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
	},

	// An input program: random macros (some starting with one that found something before), or a few generators
	// with bits of macros between them.
	program(node) {
		const frames = rnd(90, 1200);
		const fight = node.probe.foes !== undefined || node.probe.room === 'RomInter';
		if (Math.random() < (fight ? 0.1 : 0.35)) {
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
	},

	pickGenerator(node) {
		const w = Object.entries(GENERATORS).map(([g, base]) => {
			// a fight (global.battlers is also set in some map rooms, the catacombs', where walking is what's needed)
			if (node.probe.foes !== undefined || node.probe.room === 'RomInter')
				base = g === 'battle' ? 10 : g === 'dialog' ? 1 : 0;
			if (g === 'travel' && !this.goalRoom(node)) base = 0;
			if (g === 'heal' && node.probe.room !== 'RomInter') base = node.probe.hp < 0.8 ? 6 * (1 - node.probe.hp) : 0;
			// fudged levels, only where the search is stuck: the furthest plot and the one before it
			if (g === 'train' && node.probe.room !== 'RomInter')
				base = (node.probe.plot ?? 0) >= this.maxPlot - 1 && node.probe.low < trainTarget(node.probe.plot) ? 1 : 0;
			const s = this.genStats[g] ?? { found: 0, frames: 0 };
			return [g, base * (0.5 + Math.min(3, (s.found + 1) / (s.frames / 10000 + 1)))];
		});
		let x = Math.random() * w.reduce((a, [, v]) => a + v, 0);
		const pick = w.find(([, v]) => {
			x -= v;
			return x < 0;
		});
		return (pick ?? w[0])[0];
	},

	// The next plot's conditions on story state: array elements (scheme[0]) and story globals, not cinema/freeze flags
	goalConds(plot) {
		return (this.goals?.conds[plot] ?? []).filter(([name, i]) => i !== null || STORY.test(name));
	},

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
	},

	// A room where the story moves on from this node's plot (code there sets a higher plot), other than this one
	goalRoom(node) {
		const rooms = (this.goals?.rooms[node.probe.plot + 1] ?? []).filter((r) => r !== node.probe.room);
		return rooms.length ? pick(rooms) : undefined;
	},
};
