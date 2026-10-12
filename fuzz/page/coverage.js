import { F } from './core.js';

// ---- coverage ----
// Wraps every gml_* function the runtime can reach: globals (direct calls) and JSON_game's references (events,
// script_execute, room code). Call before GameMaker_Init.
export const fnNames = [],
	fnIds = new Map();
export let seg = new Uint8Array(0);
export const segList = [];
// A GML function's own code (the global is the coverage wrapper once instrumented)
export const sourceOf = (name) => {
	for (const [fn, w] of fnIds) if (fn !== w && fn.name === name) return fn.toString();
	return window[name]?.toString() ?? '';
};
F.instrument = () => {
	const wrap = (fn) => {
		if (fnIds.has(fn)) return fnIds.get(fn);
		const id = fnNames.length;
		fnNames.push(fn.name);
		const w = {
			[fn.name]: function () {
				if (!seg[id]) {
					seg[id] = 1;
					segList.push(id);
				}
				return fn.apply(this, arguments);
			},
		}[fn.name];
		fnIds.set(fn, w).set(w, w);
		return w;
	};
	const isGml = (v) => typeof v === 'function' && /^gml_(Object|Script|Room)_/.test(v.name);
	for (const k of Object.getOwnPropertyNames(window))
		if (/^gml_(Object|Script|Room)_/.test(k) && isGml(window[k])) window[k] = wrap(window[k]);
	const seen = new Set();
	(function walk(o) {
		if (!o || typeof o !== 'object' || seen.has(o)) return;
		seen.add(o);
		for (const k of Object.keys(o)) {
			const v = o[k];
			if (isGml(v)) o[k] = wrap(v);
			else if (v && typeof v === 'object') walk(v);
		}
	})(JSON_game);
	seg = new Uint8Array(fnNames.length);
	return fnNames.length;
};
F.fnNames = () => fnNames;
