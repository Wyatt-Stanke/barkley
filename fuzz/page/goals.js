import { F } from './core.js';
import { fnIds, sourceOf } from './coverage.js';

// Where the story moves on: for each plot value some object's code sets, the rooms that place that object, and the
// comparisons of globals with constants in its code (conds: [name, index or null, op, value]), e.g. plot 3 needs
// scheme[0]>=2 and scheme[3]=1.
F.goals = () => {
	const out = {},
		conds = {};
	const CMP =
		/yyf(equal|notequal|greater|greaterequal|less|lessequal)\(global\.gml(\w+)(?:\[__yy_gml_array_check_index\((\d+),[^\]]*\])?,(-?[\d.]+)\)/g;
	const byObj = new Map();
	for (const [fn] of fnIds) if (/^gml_Object_/.test(fn.name) && fnIds.get(fn) !== fn) byObj.set(fn.name, fn);
	for (const [fn] of fnIds) {
		if (!/^gml_Object_/.test(fn.name) || fnIds.get(fn) === fn) continue;
		for (const m of fn.toString().matchAll(/global\.gmlplot=(\d+)/g)) {
			const obj = JSON_game.GMObjects.find(
				(o) => o && fn.name.startsWith(`gml_Object_${o.pName}_`) && /^[A-Z]/.test(fn.name.slice(12 + o.pName.length)),
			);
			if (!obj) continue;
			const id = JSON_game.GMObjects.indexOf(obj);
			for (const r of JSON_game.GMRooms)
				if (r?.pInstances?.some((i) => i.index === id)) {
					out[m[1]] ??= [];
					out[m[1]].push(r.pName);
				}
			for (const [name, f] of byObj)
				if (name.startsWith(`gml_Object_${obj.pName}_`))
					for (const c of f.toString().matchAll(CMP))
						if (c[2] !== 'plot') {
							conds[m[1]] ??= [];
							conds[m[1]].push([c[2], c[3] === undefined ? null : +c[3], c[1], +c[4]]);
						}
		}
	}
	for (const k in out) out[k] = [...new Set(out[k])];
	for (const k in conds) conds[k] = [...new Map(conds[k].map((c) => [c.join(), c])).values()];
	// the bosses: the battlers sBoss lines up ("oBBallmonster,12,56,112": object, level, position)
	const bosses = [
		...new Set([...sourceOf('gml_Script_sBoss').matchAll(/["'](oB\w+),\d+,\d+,\d+["']/g)].map((m) => m[1])),
	];
	return { rooms: out, conds, bosses };
};
