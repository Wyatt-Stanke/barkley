import { clock } from './clock.js';
import { F, gml, N, VSYNC } from './core.js';

// ---- the game's own functions (declared after this script runs, so replaced once the game runs) ----
let hooked = false;
// What the replaced functions are fed: the state resume_take hands Game Start (pending), Game Start's path ids for
// path_add to give back on every restart (paths0, pathQueue); replaying a crash report, resume_tick runs (reporting:
// its checkpoints reseed the random numbers and use up instance ids, as in the recorded game) and crash_step hands the
// game the recorded frame time (rendtNext)
export const feed = { pending: '', paths0: [], pathQueue: [], reporting: false, rendtNext: null };
export const hook = () => {
	if (hooked) return;
	hooked = true;
	clock.pumping = false;
	const realTick = window.gml_Script_resume_tick;
	window.resume_take = () => {
		const s = feed.pending;
		feed.pending = '';
		return s;
	};
	window.resume_put = () => 0; // nothing to keep for a reload
	// resume_restore ends with resume_put(resume_save()), a save for that reload, which the recorded or continuous game
	// didn't make: its instance id mark would be destroyed but not yet removed (the runtime does that near the end of
	// a frame) when the next instance takes that id back, which then can't be found by id
	const realRestore = window.gml_Script_resume_restore,
		realSave = window.gml_Script_resume_save;
	window.gml_Script_resume_restore = function () {
		'use strict';
		window.gml_Script_resume_save = () => '';
		try {
			return realRestore.apply(this, arguments);
		} finally {
			window.gml_Script_resume_save = realSave;
		}
	};
	// Quit Vidcon, Esc
	window.game_end = () => {
		F.ended = true;
	};
	// Game Start makes global.path with path_add, ten more on every restart: every restart gets the first ten back, so
	// every page numbers them alike whatever it ran before (instances' saved path_index are those numbers)
	feed.paths0 = [...(gml().gmlpath ?? [])];
	const realAdd = window.path_add;
	window.path_add = function () {
		return feed.pathQueue.length ? feed.pathQueue.shift() : realAdd.apply(this, arguments);
	};
	// resume_tick without its periodic resume_save (a fifth of the frame time); snapshots are taken here instead.
	window.gml_Script_resume_tick = function () {
		'use strict';
		if (feed.reporting) return realTick.apply(this, arguments);
		if (gml().gmlresume_phase === 3) gml().gmlresume_phase = 0;
	};
	// crash.js records nothing here
	window.crash_put = window.crash_end = window.crash_wanted = () => 0;
	window.crash_step = (r) => {
		const v = feed.rendtNext ?? r;
		feed.rendtNext = null;
		return v;
	};
	// Mouse events: there is no mouse, and the runtime checks every object for them each frame.
	if (N.mouse) window[N.mouse] = () => {};
	// A fresh start, the same on every page: Game Start again from a fixed clock, seeds and instance ids
	clock.timers = [];
	clock.raf = clock.frameCb ? [clock.frameCb] : clock.raf;
	clock.tick = BOOT_TICK;
	clock.vnow = clock.tick * VSYNC;
	clock.seed = 1;
	window[N.ids] = 1000000;
	if (clock.rng0) {
		const s = window[N.state];
		s.length = 0;
		s.push(...clock.rng0.state);
		window[N.b] = clock.rng0.b;
		window[N.c] = clock.rng0.c;
	}
	localStorage.clear();
	feed.pathQueue = [...feed.paths0];
	game_restart();
};
const BOOT_TICK = 3e6; // past any frame the loading pump reaches (it steps a frame every 2 ms or so)
