import { F, gml, inst, roomName, safe } from './core.js';
import { episodeOut } from './episode.js';
import { actions } from './input.js';
import { known } from './known.js';
import { goalMask, spot } from './novelty.js';
import { healers, heals } from './probe.js';
import {
	act,
	bbox,
	beside,
	busy,
	byCollision,
	choose,
	DIRS,
	exists,
	follow,
	INTERRUPTS,
	instances,
	into,
	isA,
	isExit,
	isFollower,
	near,
	objName,
	rng,
	route,
} from './walk.js';

// A dialog that offers a choice (oDialog's option[], cursor cho): one of the options at random, the cursor moved to
// it. Pressing on through takes the first one, and some choices end the game (a wrong answer in a cutscene).
const chosen = new WeakMap();
function* pickOption() {
	const d = safe(() => inst('oDialog'));
	const opts = d?.gmloption;
	if (!Array.isArray(opts) || opts[0] === '0' || opts[0] === undefined) return;
	if (!chosen.has(d)) {
		let k = 0;
		while (k < opts.length && opts[k] !== '0' && opts[k] !== undefined) k++;
		chosen.set(d, Math.floor(rng() * k));
	}
	const want = chosen.get(d);
	for (let i = 0; i < 12 && Number(d.gmlcho) !== want; i++) {
		yield [[Number(d.gmlcho) < want ? 'down' : 'up'], 2];
		yield [[], 6];
	}
}
// A quick-time event (oQuicker: press the key it shows, key 0-5, within about 20 frames, or lose a life): the
// right key, but now and then a wrong one, so both ways are played.
const QUICK = ['right', 'up', 'left', 'down', 'z', 'x'];
// a battle's attack moves (oBBarkley's quick reference: free throw, pass, the three jumpers)
const ATTACKS = [['z'], ['x'], ['up'], ['up'], ['left', 'up'], ['right', 'up']];
function* quick() {
	for (let i = 0; i < 30; i++) {
		const q = safe(() => inst('oQuicker'));
		if (!q) return;
		if (Number(q.gmlgot) > 0 || !(Number(q.gmltime) > 0)) {
			yield [[], 2];
			continue;
		}
		yield [[rng() < 0.9 ? QUICK[Number(q.gmlkey)] : choose(QUICK)], 2];
		yield [[], 2];
	}
}
// Cyberdwarf's attack is a combo (oBComboMeter): a press starts it, then while he waits (stage 2.1) the meter fills by
// half a step a frame, and each press adds its move's cost and lands it: action a jab (7), cancel a kick (9), start a
// punch (11), a move unlike the last for a quarter more damage; a direction with action is a finisher (left 15, down
// 18, right 21) that ends it. A move that no longer fits ends it too. So: press as soon as he waits, alternate, and
// now and then finish. Returns the frames it took.
const COMBO = { z: 7, x: 9, c: 11 };
const FINISH = [
	['left', 15],
	['down', 18],
	['right', 21],
];
function* combo() {
	let frames = 0,
		last = 'z',
		started = false;
	const wait = function* (n) {
		frames += n;
		yield [[], n];
	};
	for (let i = 0; i < 300; i++) {
		const cd = safe(() => inst('oBCyberdwarf'));
		const meter = safe(() => inst('oBComboMeter'));
		if (!cd) break;
		const stage = Number(cd.gmlstage),
			doing = Number(cd.gmldoing);
		if (stage === 1.1 && !started) {
			started = true;
			frames += 2;
			yield [['z'], 2];
			yield* wait(1);
		} else if (stage === 2.1 && doing === 12 && meter) {
			const room = Number(meter.gmllength) - Number(meter.gmlfill);
			const ends = FINISH.filter(([, c]) => c < room);
			if (ends.length && Number(meter.gmlfill) >= 28 && rng() < 0.6) {
				frames += 1;
				yield [[choose(ends)[0], 'z'], 1];
				yield* wait(1);
				continue;
			}
			const moves = Object.keys(COMBO).filter((k) => k !== last && COMBO[k] < room);
			if (!moves.length) break;
			last = choose(moves);
			frames += 1;
			yield [[last], 1];
			yield* wait(1);
		} else if (doing === 12 || (!started && stage < 2)) yield* wait(1);
		else break;
	}
	yield* wait(20);
	return frames;
}
// Fudged levels (the user's call: a party the search can't grow strong enough leaves the later story unplayed).
// '!train' raises each party member below level 2·plot + 4 by up to two levels as the game itself levels one up
// (sBattleLevel's stats and skill, sBattleSkill), sets their experience to the new level's and heals them. It is a
// program step, so a path that trained trains again on every replay. global.__fuzz_trained counts the levels given
// (the flag scan skips gml__ names; snapshots keep it).
const TRAIN_STEP = 2;
const trainTarget = (plot) => 2 * (Number(plot) || 0) + 4;
actions.train = () => {
	'use strict';
	const g = gml();
	const self = safe(() => inst('oController'));
	if (!self || safe(roomName) === 'RomInter' || !Array.isArray(g.gmlparty)) return;
	const target = trainTarget(g.gmlplot);
	for (let i = 0; i < 8 && Number(g.gmlparty[i]) >= 0; i++) {
		const m = Number(g.gmlparty[i]);
		for (let k = 0; k < TRAIN_STEP && Number(g.gmlchar_res1[m]) < target; k++) {
			const lv = Number(g.gmlchar_res1[m]) + 1;
			g.gmlchar_res1[m] = lv;
			const skill = window.gml_Script_sBattleLevel(self, self, m, lv);
			if (skill) window.gml_Script_sBattleSkill(self, self, m, skill);
			g.gmlchar_xp[m] = Math.max(Number(g.gmlchar_xp[m]) || 0, 100 * (lv - 1) * lv);
			g.gml__fuzz_trained = (Number(g.gml__fuzz_trained) || 0) + 1;
		}
		g.gmlchar_chp[m] = g.gmlchar_hp[m];
		g.gmlchar_czp[m] = g.gmlchar_zp[m];
	}
};
export const G = {
	// Presses action through dialog and cutscenes until the player can move again
	*dialog(a) {
		for (let k = 0; k < 6 && exists('oStartmenu'); k++)
			yield* [
				[['x'], 2],
				[[], 6],
			];
		// Some cutscenes offer themselves to be skipped (global.skipper). Start twice runs oController's User Event 0,
		// which jumps straight to the story's next room: 23 of the game's transitions go through that table, and the
		// branch it takes there (sPos('load'), room_restart, sOvar) is hardly played any other way. The two presses need
		// a release between them - the first is swallowed by key_clear and only arms the skip (global.skip=0.5).
		const trySkip = rng() < 0.3;
		let skipped = false;
		for (let t = 0; t < a.n && busy() && !exists('oStartmenu'); t += 10) {
			if (trySkip && !skipped && gml().gmlskipper > 0) {
				skipped = true;
				yield [['c'], 2];
				yield [[], 6];
				yield [['c'], 2];
				yield [[], 10];
				continue;
			}
			if (exists('oQuicker')) {
				yield* quick();
				continue;
			}
			yield* pickOption();
			if (rng() < 0.08) yield [[choose(['up', 'down'])], 2];
			yield [['z'], 2];
			yield [[], 8];
		}
	},
	// Walks to an exit (one not taken from this room yet, if there is one) and takes it
	*exit(a) {
		const room = roomName();
		const all = instances().filter(isExit);
		if (!all.length) return;
		const ok = all.filter((i) => !a.avoid?.has(objName(i)));
		const pool = ok.length ? ok : all;
		const fresh = pool.filter((i) => !known.exits.has(`${room}|${objName(i)}`));
		const via = a.via && all.find((i) => objName(i) === a.via);
		const e = via ?? (fresh.length && rng() < 0.8 ? choose(fresh) : choose(pool));
		const name = objName(e);
		a.avoid?.add(name);
		const same = new Set(all.filter((i) => objName(i) === name)); // a door can be several instances
		const coll = byCollision(e);
		// the player's box before each chunk in this room: on the way the player may walk onto another exit, and the
		// exit taken is the one nearest to where the player last was
		let box = null;
		const track = function* (gen) {
			let r = gen.next();
			while (!r.done) {
				const p = roomName() === room && inst('oBarkley');
				if (p) box = bbox(p);
				yield r.value;
				r = gen.next();
			}
			return r.value;
		};
		const why = yield* track(follow(coll ? near(e) : beside(e), same, a.n, rng() < 0.5));
		if (why === 'arrived' && !coll) {
			const r = route(beside(e), same);
			yield* track(act(r?.goal ?? 'up'));
		} else if (why === 'arrived') yield* track(into(e));
		yield* track(
			(function* () {
				for (let t = 0; t < 120 && roomName() === room; t += 10) yield [[], 10];
			})(),
		);
		if (roomName() !== room && !INTERRUPTS.has(roomName())) {
			const gap = (i) => {
				const [l, t, r, b] = bbox(i);
				return box ? Math.max(0, l - box[2], box[0] - r) + Math.max(0, t - box[3], box[1] - b) : 0;
			};
			const taken = box ? objName(all.reduce((m, i) => (gap(i) < gap(m) ? i : m))) : name;
			episodeOut.exits.push([room, taken, roomName()]);
			known.exits.add(`${room}|${taken}`);
			const e = known.graph.get(room) ?? [];
			if (!e.some(([v, t]) => v === taken && t === roomName())) known.graph.set(room, [...e, [taken, roomName()]]);
		}
		yield* G.dialog({ n: 300 });
	},
	// Walks up to something the player can use (a person, a sign, a pump...) and presses action
	*talk(a) {
		// what someone says can change with the story arrays (scheme[3] after talking to Larry), not only the plot
		const room = roomName(),
			plot = goalMask().replace(':', '.');
		const p = inst('oBarkley');
		const all = instances().filter((i) => {
			const n = objName(i);
			return i !== p && i.visible && isA(n, 'oItem') && !isExit(i) && !isFollower(n) && n !== 'oBarkley';
		});
		if (!all.length) return;
		const key = (i) => `${room}|${plot}|${objName(i)}`;
		const fresh = all.filter((i) => !known.talked.has(key(i)));
		const e = fresh.length && rng() < 0.8 ? choose(fresh) : choose(all);
		if ((yield* follow(beside(e), new Set([e]), a.n, rng() < 0.3)) !== 'arrived') return;
		const r = route(beside(e), new Set([e]));
		yield* act(r?.goal ?? 'up');
		if (busy()) {
			episodeOut.talked.push(key(e));
			known.talked.add(key(e));
		}
		yield* G.dialog({ n: 900 });
	},
	// Walks to a reachable spot the fuzzer hasn't been to
	*seek(a) {
		const p0 = F.probe();
		const k = (x, y) => `${p0.room}|${p0.plot}|${p0.battle}|${spot(p0, x, y)}`;
		const r = route((x, y) => !known.cells.has(k(x, y)) && rng() < 0.05 && 'new');
		if (!r) return;
		const [tx, ty] = r.path.at(-1) ?? [0, 0];
		yield* follow((x, y) => (Math.abs(x - tx) < 4 && Math.abs(y - ty) < 4 ? 'there' : null), null, a.n, rng() < 0.5);
	},
	// Heads for another room: through a known exit toward a.to (the story's next room), or any exit
	*travel(a) {
		const start = F.frame;
		let avoid0 = null;
		for (let hops = 0, fails = 0; hops < 8 && fails < 3 && F.frame - start < a.n && roomName() !== a.to; ) {
			const room = roomName();
			// after a failed try, another exit (the route's may be out of reach)
			if (!fails) avoid0 = new Set();
			const avoid = avoid0;
			const via = a.to && !fails ? nextHop(room, a.to) : null;
			yield* G.exit({ ...a, n: Math.min(900, a.n - (F.frame - start)), via, avoid });
			if (roomName() === room) fails++;
			else {
				hops++;
				fails = 0;
			}
		}
	},
	// Fudged levels (actions.train above): one step, between fights and cutscenes
	*train() {
		for (let t = 0; t < 90 && busy(); t += 4) yield [[], 4];
		if (busy() || safe(roomName) === 'RomInter') return;
		yield [['!train'], 1];
	},
	// While the party is below 80% of its vitality: talks to a healer in the room, or uses a healing item from the
	// start menu on whoever is lowest: Start, Items (right of Party), the item (right steps through the list in
	// order), the party member, and out.
	*heal() {
		const g = gml();
		const ids = g.gmlitem_id,
			amounts = g.gmlitem_amount,
			party = g.gmlparty;
		for (let t = 0; t < 90 && busy() && !exists('oDialog') && !exists('oStartmenu'); t += 4) yield [[], 4];
		if (busy() || !Array.isArray(ids) || !Array.isArray(party) || safe(roomName) === 'RomInter') return;
		let worst = -1,
			frac = 0.8;
		for (let i = 0; i < 8 && Number(party[i]) >= 0; i++) {
			const f = Number(g.gmlchar_chp?.[party[i]]) / Number(g.gmlchar_hp?.[party[i]]);
			if (f < frac) [worst, frac] = [i, f];
		}
		const k = ids.findIndex((n, i) => heals().has(n) && Number(amounts?.[i]) > 0);
		if (worst < 0) return;
		// someone here restores the party (for a fee): talk to them and take the first answer, yes
		const healer = instances().find((i) => healers().has(objName(i)));
		if (healer && (k < 0 || rng() < 0.5)) {
			if ((yield* follow(beside(healer), new Set([healer]), 900, rng() < 0.5)) !== 'arrived') return;
			const r = route(beside(healer), new Set([healer]));
			yield* act(r?.goal ?? 'up');
			for (let t = 0; t < 900 && busy(); t += 10) {
				yield [['z'], 2];
				yield [[], 8];
			}
			return;
		}
		if (k < 0) return;
		const press = function* (key) {
			yield [[key], 2];
			yield [[], 6];
		};
		yield* press('c');
		const menu = () => safe(() => inst('oStartmenu'));
		if (!menu()) return;
		for (let i = 0; i < 4 && Number(menu()?.gmlpos0) !== 1; i++)
			yield* press(Number(menu()?.gmlpos0) < 1 ? 'right' : 'left');
		yield* press('z');
		if (Number(menu()?.gmlstage) === 2) {
			for (let i = 0; i < k; i++) yield* press('right');
			yield* press('z');
			if (Number(menu()?.gmlstage) === 3) {
				for (let i = 0; i < worst; i++) yield* press('down');
				yield* press('z');
			}
		}
		for (let i = 0; i < 6 && menu(); i++) yield* press('x');
	},
	// In a battle: action, cancel and the arrows, with the rhythm menus and combos take. Half the time it fights instead,
	// reading the battle menu: attack and the first target, then an attack move (they are timing moves: hold a key and
	// release it when the indicator lines up, so a tap barely ever hits), held for a random time.
	*battle(a) {
		// a party member standing with less than 40% of their vitality
		const low = () =>
			safe(
				() =>
					GetWithArray(asset_get_index('oBattler')).some(
						(i) =>
							i &&
							!i.marked &&
							Number(i.gmlenemy) !== 1 &&
							Number(i.gml_vp) > 0 &&
							Number(i.gml_vp) < 0.4 * Number(i.gml_rvp),
					),
				false,
			);
		if (rng() < 0.8) {
			for (let t = 0; t < a.n; ) {
				const menu = safe(() => inst('oBattleMenu'));
				const st = menu?.gmlstate;
				if (st === 'names') {
					// the menu is a cross: action alone attacks; with left held it opens skills, right items, up defends,
					// down runs. Someone low on vitality makes items (most are for healing) and running much likelier:
					// vitality carries from fight to fight, and a room's monsters (seven in RomSewer1) wear a party down.
					// A boss can't be run from (it says so and the menu comes back).
					const hurt = low();
					const r = rng() - (hurt ? 0.4 : 0);
					const keys =
						rng() < (hurt ? 0.3 : 0.06)
							? ['down', 'z']
							: r < 0.2
								? ['right', 'z']
								: r < 0.3
									? ['left', 'z']
									: r < 0.35
										? ['up', 'z']
										: ['z'];
					yield [keys, 2];
					yield [[], 6];
					t += 8;
				} else if (st === 'target' && menu.gmlpretarget === 'Ally' && rng() < 0.5) {
					// an item for someone else in the party
					yield [['down'], 2];
					yield [[], 4];
					yield [['z'], 2];
					yield [[], 6];
					t += 14;
				} else if ((st === 'items' || st === 'skills') && rng() < 0.25) {
					// back out: a skill the turn hasn't the points for ignores action, and nothing else leaves the menu
					yield [['x'], 2];
					yield [[], 6];
					t += 8;
				} else if (st === 'items' || st === 'skills') {
					for (let k = Math.floor(rng() * 3); k > 0; k--)
						yield* [
							[['down'], 2],
							[[], 4],
						];
					yield [['z'], 2];
					yield [[], 6];
					t += 20;
				} else if (st === 'target' || st === undefined) {
					yield [['z'], 2];
					yield [[], 6];
					t += 8;
				} else if (st === 'postattack') {
					// Barkley's attacks score on the release: a pass is strongest when oBTimer's side meter is at its end
					// (zy 4) as the throw reads it, one step after the release, so it lets go while the meter's next move
					// (5 + |zy-50|/5, downwards) lands there. A jump shot is best at the top of the jump (up held ~25
					// frames). Otherwise any move, held a while.
					// The others' attacks wait for a press: Vince's laser fires on action, Balthios picks with
					// action, cancel or start.
					const turn = objName(window.yyInst(null, null, gml().gmlturn) ?? {});
					if (turn === 'oBCyberdwarf' && rng() < 0.85) {
						const frames = yield* combo();
						t += frames;
						continue;
					}
					if (turn && turn !== 'oBBarkley' && rng() < 0.85) {
						const k = rng();
						yield [[k < 0.7 ? 'z' : k < 0.9 ? 'x' : 'c'], 2];
						yield [[], 30];
						t += 32;
						continue;
					}
					const r = rng();
					let hold = 0;
					if (r < 0.45) {
						for (; hold < 90; hold++) {
							const tm = safe(() => inst('oBTimer'));
							const zy = Number(tm?.gmlzy);
							if (hold > 6 && tm?.gmllr === 1 && Number(tm.gmlzdir) === 0 && zy - (5 + Math.abs(zy - 50) / 5) <= 4)
								break;
							yield [['x'], 1];
						}
					} else {
						hold = r < 0.65 ? 24 + Math.floor(rng() * 4) : 6 + Math.floor(rng() * 50);
						yield [r < 0.65 ? ['up'] : choose(ATTACKS), hold];
					}
					yield [[], 30];
					t += hold + 30;
				} else {
					yield [[], 6];
					t += 6;
				}
			}
			return;
		}
		for (let t = 0; t < a.n; t += 12) {
			const r = rng();
			if (r < 0.55) yield [['z'], 2];
			else if (r < 0.7) yield [[choose(DIRS)], 2];
			else if (r < 0.8) yield [[choose(DIRS), 'z'], 2];
			else if (r < 0.87) yield [['x'], 2];
			yield [[], 10];
		}
	},
};
// First exit on the shortest known route between two rooms
const nextHop = (from, to) => {
	const prev = new Map([[from, null]]);
	const q = [from];
	for (const r of q) {
		for (const [via, dest] of known.graph.get(r) ?? []) {
			if (prev.has(dest)) continue;
			prev.set(dest, [r, via]);
			if (dest === to) {
				let hop = null;
				for (let r = to; prev.get(r); r = prev.get(r)[0]) hop = prev.get(r)[1];
				return hop;
			}
			q.push(dest);
		}
	}
	return null;
};
