import { F, N, nativeSetTimeout, safe, VSYNC } from './core.js';

// ---- virtual time ----
// The clock's state: the vsync count and virtual now, the frame callbacks and timers waiting, the frame callback the
// runtime registered, Math.random's seed, whether frames are still pumped in real time (loading) and the runtime's
// RNG state when they stopped
export const clock = {
	tick: 0,
	vnow: 0,
	inFrame: false,
	raf: [],
	timers: [],
	timerSeq: 0,
	frameCb: null,
	seed: 1,
	pumping: true,
	rng0: null,
};
performance.now = () => clock.vnow;
Date.now = () => 1.7e12 + clock.vnow;
// Only ever the runtime's frame: the touch overlay's loop that pins the canvas's CSS size and the gamepad's poll are
// dropped (had one re-registered after the runtime, it became frameCb, and a restart scheduled only it, so the game
// never ran another frame). The page no longer starts them under the harness; this is for builds from before that.
const OWN_LOOPS = new Set(['touch_pin', 'pad_poll']);
window.requestAnimationFrame = (cb) => {
	if (OWN_LOOPS.has(cb.name)) return 0;
	clock.frameCb = cb;
	return clock.raf.push(cb);
};
window.webkitRequestAnimationFrame = undefined;
window.setTimeout = function (fn, ms, ...args) {
	if (!clock.inFrame) return nativeSetTimeout(fn, ms, ...args); // asset loading
	clock.timers.push({ due: clock.vnow + (+ms || 0), seq: ++clock.timerSeq, fn: () => fn(...args) });
	return -clock.timerSeq;
};
Math.random = () => {
	clock.seed = (clock.seed + 0x6d2b79f5) | 0; // mulberry32
	let t = Math.imul(clock.seed ^ (clock.seed >>> 15), 1 | clock.seed);
	t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
window.alert = (m) => F.alerts.push(String(m));
window.confirm = () => true;
window.prompt = () => '';

// One game frame: fire due timers until a frame is requested, then run the frame at the next vsync.
// Strict, like everything here that calls into the game: yyError walks arguments.callee.caller up the stack, which
// stops (null) at a strict caller but throws at an arrow function, hiding the game's error.
export function step() {
	'use strict';
	while (!clock.raf.length) {
		if (!clock.timers.length) return false;
		clock.timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
		const t = clock.timers.shift();
		clock.vnow = Math.max(clock.vnow, t.due);
		clock.inFrame = true;
		try {
			t.fn();
		} finally {
			clock.inFrame = false;
		}
	}
	clock.tick = Math.floor(clock.vnow / VSYNC + 1e-9) + 1;
	clock.vnow = clock.tick * VSYNC;
	const q = clock.raf;
	clock.raf = [];
	clock.inFrame = true;
	try {
		for (const cb of q) cb(clock.vnow);
	} finally {
		clock.inFrame = false;
	}
	return true;
}
// Until the game runs, frames are pumped in real time so assets can load. They stop once Game Start has run: how
// many frames the intro would otherwise get depends on how fast the page loaded (a warm cache), and so would
// everything after. The runtime's RNG state there is kept for fresh starts (see hook).
(function pump() {
	if (!clock.pumping) return;
	if (safe(() => F.ready())) {
		clock.pumping = false;
		clock.rng0 = { state: window[N.state].map(Number), b: window[N.b], c: window[N.c] };
		return;
	}
	safe(step);
	nativeSetTimeout(pump, 2);
})();
