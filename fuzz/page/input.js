import { KEYS } from './core.js';

// ---- input ----
let held = new Set();
const ev = (k) => ({
	which: KEYS[k],
	keyCode: KEYS[k],
	key: k.length === 1 ? k : `Arrow${k[0].toUpperCase()}${k.slice(1)}`,
	preventDefault() {},
});
export const setKeys = (keys) => {
	const next = new Set(keys);
	for (const k of held) if (!next.has(k)) window.onkeyup?.(ev(k));
	for (const k of next) if (!held.has(k)) window.onkeydown?.(ev(k));
	held = next;
};
// A key event from a crash report (crash.js): [step, type (0 up, 1 down, 2 blur, 3 focus), key code, key]
export const rawKey = ([, type, which, key]) => {
	if (type > 1) return window.dispatchEvent(new Event(type === 2 ? 'blur' : 'focus'));
	const e = { which, keyCode: which, key, repeat: false, preventDefault() {} };
	(type === 1 ? window.onkeydown : window.onkeyup)?.(e);
};
