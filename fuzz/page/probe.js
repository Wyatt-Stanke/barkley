import { F, gml, inst, roomName, safe } from './core.js';
import { fnIds, sourceOf } from './coverage.js';
import { objName } from './walk.js';

// In a battle: the first enemy, the eighths of the enemies' vitality left, the party members standing and the
// quarters of the party's vitality left, e.g. 'oBBallmonster:3:2:4'. As part of the cell it gives a battle somewhere
// to go: a state that got a boss lower is new, and so is one that got it as low with the party in better shape (with
// only the first two, whichever state got there first kept the cell, usually one with the party nearly dead, and the
// search could get a boss to its last 5% but never past it). Undefined outside a fight. (Not global.battlers: that
// counts the monsters roaming a map room, so it stays set in a fight that began there and is 0 in a boss fight a
// cutscene starts.)
const foes = () => {
	let n = 0,
		name = '',
		vp = 0,
		max = 0,
		up = 0,
		pvp = 0,
		pmax = 0;
	for (const i of GetWithArray(asset_get_index('oBattler'))) {
		if (!i || i.marked) continue;
		n++;
		const v = Math.max(0, Number(i.gml_vp) || 0);
		if (Number(i.gmlenemy) !== 1) {
			up += v > 0 ? 1 : 0;
			pvp += v;
			pmax += Math.max(v, Number(i.gml_rvp) || 0);
		} else {
			name ||= objName(i);
			vp += v;
			max += Math.max(v, Number(i.gml_rvp) || 0);
		}
	}
	// The last eighth in eighths of its own ('1.3'), so the search still sees a boss brought lower near the end
	const e = max ? Math.ceil((8 * vp) / max) : 0;
	const left = e === 1 ? `1.${Math.ceil((64 * vp) / max)}` : e;
	const hp = pmax ? Math.ceil((4 * pvp) / pmax) : 0;
	return n ? `${name}:${left}:${up}:${hp}` : undefined;
};
// The party's experience and levels (global.char_xp, char_res1), summed over its members, and the share of its
// vitality left between fights (char_chp of char_hp; a fight's vitality carries over, so the party can walk into
// a boss nearly dead: it met the plot-5 one at 79/418 and 1/290)
export const party = () => {
	const g = gml();
	let xp = 0,
		lv = 0,
		hp = 0,
		max = 0;
	for (let i = 0; i < 8 && Array.isArray(g.gmlparty) && Number(g.gmlparty[i]) >= 0; i++) {
		const m = Number(g.gmlparty[i]);
		xp += Math.max(0, Number(g.gmlchar_xp?.[m]) || 0);
		lv += Number(g.gmlchar_res1?.[m]) || 0;
		hp += Math.max(0, Number(g.gmlchar_chp?.[m]) || 0);
		max += Math.max(0, Number(g.gmlchar_hp?.[m]) || 0);
	}
	return { xp: Math.floor(xp), lv, hp: max ? Math.round((100 * hp) / max) / 100 : 1 };
};
// Items that restore vitality, by name, from refItem's own code ('Single, VP +%66')
let healing = null;
export const heals = () => {
	healing ??= new Set(
		[...sourceOf('gml_Script_refItem').matchAll(/yyfequal\(argument0,"([^"]+)"\)\)\s*\{[^}]*?gmltEffect="([^"]*)"/g)]
			.filter((m) => /VP \+/.test(m[2]))
			.map((m) => m[1]),
	);
	return healing;
};
// Objects that restore the whole party when talked to (an inn's keeper): their events call sFullheal, or a script
// that does (a cinema's 'code' step, cin_0387 for the Shark)
let healerObjs = null;
export const healers = () => {
	if (healerObjs) return healerObjs;
	const scripts = ['gml_Script_sFullheal'];
	for (const [fn, w] of fnIds)
		if (fn !== w && /^gml_Script_/.test(fn.name) && fn.toString().includes('gml_Script_sFullheal('))
			scripts.push(fn.name);
	const fns = [];
	for (const [fn, w] of fnIds)
		if (fn !== w && /^gml_Object_/.test(fn.name) && scripts.some((n) => fn.toString().includes(n))) fns.push(fn.name);
	healerObjs = new Set(
		JSON_game.GMObjects.filter(
			(o) =>
				o && fns.some((n) => n.startsWith(`gml_Object_${o.pName}_`) && /^[A-Z]/.test(n.slice(12 + o.pName.length))),
		).map((o) => o.pName),
	);
	return healerObjs;
};
F.probe = () => {
	const g = gml();
	const p = safe(() => inst('oBarkley'));
	const battle = g.gmlbattlers > 0 ? 1 : 0;
	return {
		room: safe(roomName),
		plot: g.gmlplot ?? null,
		battle,
		x: p ? Math.round(p.x) : null,
		y: p ? Math.round(p.y) : null,
		frame: F.frame,
		foes: safe(foes, undefined),
		...safe(party, {}),
	};
};
