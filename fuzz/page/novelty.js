import { F, gml, safe } from './core.js';
import { seg, segList } from './coverage.js';
import { known, sync } from './known.js';
import { party } from './probe.js';
import { KEEP } from './snapshot.js';

const XP_STEP = 40;
// Where the player stands, in 32 px. In a room with monsters roaming (battle 1) also the third of the party's
// vitality left: every walk there is a fight, a cell was kept by whichever state reached it first, often with the
// party nearly dead, and the search never got a healthy party past RomSewer1's seven monsters.
// The party's vitality in thirds is part of a cell where it can change (monsters roam), in the room the next plot is
// reached in (where the bosses are), and anywhere at the story's frontier (fuzz.mjs sends the plot it starts at): a
// party healed at an inn is then a new state on every room of the way to the boss, not only when it gets there.
let goalRooms = {},
	tierFrom = Infinity;
const tiered = (p) => p.battle || p.plot >= tierFrom || goalRooms[p.plot + 1]?.includes(p.room);
export const spot = (p, x, y) => `${x >> 5},${y >> 5}${tiered(p) ? `:${p.hp >= 0.67 ? 2 : p.hp >= 0.34 ? 1 : 0}` : ''}`;
export const cellOf = (p) => `${p.room}|${p.plot}|${p.battle}|${p.foes ?? (p.x == null ? '-' : spot(p, p.x, p.y))}`;
// The globals' values as flags: 'name=value', 'name[i]=value', 'name[i][j]=value'
export const flagsNow = (out) => {
	const g = gml();
	const add = (k, v) => {
		if (typeof v === 'number') out.push(`${k}=${+v.toFixed(3)}`);
		else if (typeof v === 'string' || typeof v === 'boolean') out.push(`${k}=${v}`);
	};
	for (const k in g) {
		if (!k.startsWith('gml') || k.startsWith('gml__') || KEEP.test(k)) continue;
		const name = k.slice(3);
		if (known.volatile.has(name)) continue;
		const v = g[k];
		if (!Array.isArray(v)) add(name, v);
		else
			for (let i = 0; i < v.length && i < 256; i++)
				if (!Array.isArray(v[i])) add(`${name}[${i}]`, v[i]);
				else for (let j = 0; j < v[i].length && j < 64; j++) add(`${name}[${i}][${j}]`, v[i][j]);
	}
	out.push(`goal=${goalMask()}`);
	// The party's experience in steps of XP_STEP: char_xp churns too much to be a feature itself, so without this a
	// state that had won more fights was no different from one that hadn't, and the party met the plot-5 boss (level
	// 12) at level 2. Each step is new, so the search keeps a trail of ever stronger parties to explore from.
	out.push(`xp=${Math.floor(safe(party, { xp: 0 }).xp / XP_STEP)}`);
	return out;
};
// Which of the next plot's conditions (fuzz.mjs goalConds, sent with each episode) hold, as 'plot:bits'
let goalConds = {};
// What fuzz.mjs sends with an episode: the next plot's conditions, the rooms each plot is reached in, the frontier
export const setGoals = (req) => {
	if (req.goals) goalConds = req.goals;
	if (req.goalRooms) goalRooms = req.goalRooms;
	if (req.tierFrom != null) tierFrom = req.tierFrom;
};
const CMPS = {
	equal: (a, b) => a === b,
	notequal: (a, b) => a !== b,
	greater: (a, b) => a > b,
	greaterequal: (a, b) => a >= b,
	less: (a, b) => a < b,
	lessequal: (a, b) => a <= b,
};
export const goalMask = () => {
	const g = gml(),
		plot = g.gmlplot;
	let bits = '';
	for (const [name, i, op, v] of goalConds[plot + 1] ?? []) {
		const x = i === null ? g[`gml${name}`] : g[`gml${name}`]?.[i];
		bits += typeof x === 'number' && CMPS[op](x, v) ? 1 : 0;
	}
	return `${plot}:${bits}`;
};

// What the new game already has, so that isn't news: the cell, the functions it runs, the globals' values.
F.baseline = function (frames) {
	'use strict';
	for (const id of segList) seg[id] = 0;
	segList.length = 0;
	F.replay({ program: [[[], frames]] });
	const probe = F.probe();
	const out = { cell: cellOf(probe), cov: segList.map((id) => [probe.room, id]), flags: flagsNow([]) };
	sync({ cells: [out.cell], cov: out.cov, flags: out.flags });
	for (const id of segList) seg[id] = 0;
	segList.length = 0;
	return out;
};
