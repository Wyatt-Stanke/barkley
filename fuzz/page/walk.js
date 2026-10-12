import { gml, inst, roomName, safe } from './core.js';
import { fnNames } from './coverage.js';

// ---- generators: closed-loop policies that read the game and yield [keys, frames] chunks ----
// The episode records the chunks they yield, so what they did replays exactly without them.
export let rng = Math.random;
const seeded = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Each episode's generators draw from their own seeded generator
export const reseed = (seed) => {
	rng = seeded(seed);
};
export const choose = (a) => a[Math.floor(rng() * a.length)];
export const DIRS = ['up', 'down', 'left', 'right'];
let objParent = null;
export const objName = (i) => safe(() => object_get_name(i.object_index), '');
export const isA = (name, anc) => {
	if (!objParent) {
		objParent = new Map();
		for (const o of JSON_game.GMObjects) if (o) objParent.set(o.pName, JSON_game.GMObjects[o.parent]?.pName);
	}
	for (let n = name, k = 0; n && k < 20; n = objParent.get(n), k++) if (n === anc) return true;
	return false;
};
export const instances = () => {
	const a = GetWithArray(-3),
		out = [];
	for (const k in a) if (a[k] && !a[k].marked) out.push(a[k]);
	return out;
};
export const exists = (name) => safe(() => GetWithArray(asset_get_index(name)).length > 0, false);
export const busy = () => {
	const g = gml();
	// a GML flag is true or 1
	const on = (v) => Number(v) === 1;
	return on(g.gmlcinema) || on(g.gmlfreeze) || on(g.gmlmovefreeze) || exists('oDialog') || exists('oStartmenu');
};
export const bbox = (i) => [i.bbox_left, i.bbox_top, i.bbox_right, i.bbox_bottom];
const EXIT = /^(oExit\d+|oLDoor\d+|oSubwaydoor)$/;
export const isExit = (i) => EXIT.test(objName(i));
// Rooms the game sends the player to in the middle of a walk (a random battle, dying): never where a door leads.
// Recorded as a destination they made the same door seem to lead to two rooms, and loadCorpus drops such doors.
export const INTERRUPTS = new Set(['RomInter', 'RomGameover']);
// walk-on exits: oExitPar children, and exits with their own collision event with the player (oExit4); the rest need
// the action key
let collides = null;
export const byCollision = (i) => {
	collides ??= new Set(fnNames.map((f) => f.match(/^gml_Object_(\w+)_Collision_oBarkley$/)?.[1]).filter(Boolean));
	if (isA(objName(i), 'oExitPar')) return true; // (and fills objParent)
	for (let n = objName(i), k = 0; n && k < 20; n = objParent.get(n), k++) if (collides.has(n)) return true;
	return false;
};
export const isFollower = (n) => /^oFollower/.test(n);

// Breadth-first search over an 8 px grid of player positions, around solid instances. goal(x, y, box) says whether
// a position is a goal and returns what to do there. Returns the path's positions (from the next one on) and the goal.
const CELL = 8;
export function route(goal, ignore) {
	const p = inst('oBarkley');
	const rm = JSON_game.GMRooms.find((r) => r && r.pName === roomName());
	if (!p || !rm) return null;
	const off = [p.bbox_left - p.x, p.bbox_top - p.y, p.bbox_right - p.x, p.bbox_bottom - p.y];
	const ox = ((p.x % CELL) + CELL) % CELL,
		oy = ((p.y % CELL) + CELL) % CELL;
	const W = Math.ceil(rm.width / CELL) + 1,
		H = Math.ceil(rm.height / CELL) + 1;
	const blocked = new Uint8Array(W * H);
	// The player's box is taken SLACK px smaller on each side: a gap exactly as wide as the box (a 16 px ladder
	// between walls) is passable at one position only, which the grid only has when the player happens to stand on
	// it. Walking into a wall within 13 px of a gap, the game slides the player into it (oPlayer's step), so the
	// route only needs to get close. Before this, the ladder up RomSewer1 was never climbed.
	const SLACK = CELL / 2;
	for (const i of instances()) {
		if (!i.solid || i === p || ignore?.has(i) || isFollower(objName(i))) continue;
		const [l, t, r, b] = bbox(i);
		const x0 = Math.max(0, Math.ceil((l - off[2] + SLACK - ox) / CELL)),
			x1 = Math.min(W - 1, Math.floor((r - off[0] - SLACK - ox) / CELL));
		const y0 = Math.max(0, Math.ceil((t - off[3] + SLACK - oy) / CELL)),
			y1 = Math.min(H - 1, Math.floor((b - off[1] - SLACK - oy) / CELL));
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blocked[y * W + x] = 1;
	}
	const sx = Math.round((p.x - ox) / CELL),
		sy = Math.round((p.y - oy) / CELL);
	const prev = new Int32Array(W * H).fill(-1);
	const q = [sy * W + sx];
	prev[q[0]] = q[0];
	// q grows as it goes: an array's iterator reads its length on every step
	for (const c of q) {
		const cx = c % W,
			cy = (c / W) | 0;
		const px = cx * CELL + ox,
			py = cy * CELL + oy;
		const g = goal(px, py, [px + off[0], py + off[1], px + off[2], py + off[3]]);
		if (g) {
			const path = [];
			for (let k = c; k !== q[0]; k = prev[k]) path.unshift([(k % W) * CELL + ox, ((k / W) | 0) * CELL + oy]);
			return { path, goal: g };
		}
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const nx = cx + dx,
				ny = cy + dy,
				n = ny * W + nx;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked[n] || prev[n] !== -1) continue;
			prev[n] = c;
			q.push(n);
		}
	}
	return null;
}
// Walks a route; returns why it stopped: 'arrived', 'busy', 'room', 'stuck' or 'budget'.
export function* follow(goal, ignore, budget, sprint) {
	const room = roomName();
	let r = null,
		lastX = null,
		lastY = null,
		still = 0,
		lost = 0;
	// Entering a room freezes the player for a moment (global.freeze, about 20 frames), and a snapshot is often taken
	// right there, where a new room's first cell is: wait that out rather than give up on the walk
	for (let t = 0; t < 90 && busy() && !exists('oDialog') && !exists('oStartmenu'); t += 4) yield [[], 4];
	for (let t = 0; t < budget; t += 4) {
		if (busy()) return 'busy';
		if (roomName() !== room) return 'room';
		const p = inst('oBarkley');
		if (!p) return 'stuck';
		if (!r || t % 48 === 0) r = route(goal, ignore);
		if (!r) {
			// someone walking may be in the way for a moment
			if (++lost > 3) return 'stuck';
			yield [[choose(DIRS)], 8];
			continue;
		}
		// within half a cell is there: the route's slack (see route) leaves the last few pixels to the game's slide
		const H = CELL / 2;
		while (r.path.length && Math.abs(r.path[0][0] - p.x) <= H && Math.abs(r.path[0][1] - p.y) <= H) r.path.shift();
		if (!r.path.length) return 'arrived';
		const [wx, wy] = r.path[Math.min(1, r.path.length - 1)];
		const keys = [];
		if (wx - p.x > H) keys.push('right');
		if (wx - p.x < -H) keys.push('left');
		if (wy - p.y > H) keys.push('down');
		if (wy - p.y < -H) keys.push('up');
		if (sprint) keys.push('x');
		still = p.x === lastX && p.y === lastY ? still + 4 : 0;
		[lastX, lastY] = [p.x, p.y];
		if (still >= 24) {
			yield [[choose(DIRS)], 8];
			r = null;
			still = 0;
			continue;
		}
		yield [keys, 4];
	}
	return 'budget';
}
// Positions next to an instance's box, facing it
export const beside = (i) => {
	const [l, t, r, b] = bbox(i);
	return (_px, _py, [pl, pt, pr, pb]) => {
		const xo = pl <= r && pr >= l,
			yo = pt <= b && pb >= t;
		// within a grid cell (routes are on an 8 px grid aligned to the player; act() closes the gap)
		if (xo && pb < t && t - pb <= CELL) return 'down';
		if (xo && pt > b && pt - b <= CELL) return 'up';
		if (yo && pr < l && l - pr <= CELL) return 'right';
		if (yo && pl > r && pl - r <= CELL) return 'left';
		return null;
	};
};
// Within a few pixels of an instance's box (on it, or where the grid gets closest)
export const near = (i) => {
	const [l, t, r, b] = bbox(i);
	return (_px, _py, [pl, pt, pr, pb]) =>
		Math.max(0, l - pr, pl - r) + Math.max(0, t - pb, pt - b) <= 6 ? 'near' : null;
};
// Walks into an instance's box (a walk-on exit): toward its centre until the room changes
export function* into(i) {
	const room = roomName();
	const [l, t, r, b] = bbox(i);
	for (let k = 0; k < 12 && roomName() === room; k++) {
		const p = inst('oBarkley');
		if (!p) return;
		const [pl, pt, pr, pb] = bbox(p);
		const dx = (l + r - pl - pr) / 2,
			dy = (t + b - pt - pb) / 2;
		const keys = [];
		if (dx > 1) keys.push('right');
		if (dx < -1) keys.push('left');
		if (dy > 1) keys.push('down');
		if (dy < -1) keys.push('up');
		yield [keys.length ? keys : [choose(DIRS)], 4];
	}
}
export function* act(dir) {
	yield [[dir], 5];
	yield [['z'], 2];
	yield [[], 6];
}
