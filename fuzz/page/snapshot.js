import { clock, step } from './clock.js';
import { F, gml, inst, N, safe, VSYNC } from './core.js';
import { seg, segList } from './coverage.js';
import { feed, hook } from './hooks.js';
import { rawKey, setKeys } from './input.js';

// ---- snapshots ----
F.save = function () {
	'use strict';
	const c = inst('oController');
	const ls = {};
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k !== 'barkley.resume') ls[k] = localStorage.getItem(k);
	}
	const s = window[N.state];
	const rng = { state: s.map(Number), b: window[N.b], c: window[N.c] };
	// keys latched by key_clear, which resume_save leaves out (a reload starts with every key up)
	const latch = [...(gml().gmlkey_latch ?? [])].flatMap((v, k) => (Number(v) === 1 ? [k] : []));
	// exact direction and speed of what moves: resume_restore sets hspeed and vspeed, and the runtime derives both
	// from them truncated to 6 decimals, so smog that keeps its own direction drifted
	const motion = GetWithArray(-3).flatMap((i) => (i.speed ? [[Number(i.id), i.direction, i.speed]] : []));
	// the runtime's frame pacing, from now: when the next frame is due, and its timer (or a frame already requested).
	// The due time keeps fractions of a millisecond, so at 30 frames a second on the 17 ms vsync every 25th frame or
	// so takes one vsync, not two; which one depends on it. (The only timers the game sets are the pacing's.)
	const pace = N.pace
		? { due: window[N.pace] - clock.vnow, timers: clock.timers.map((t) => t.due - clock.vnow), raf: clock.raf.length }
		: null;
	return JSON.stringify({ resume: gml_Script_resume_save(c, c), rng, ls, latch, motion, pace, frame: F.frame });
};
// The runtime's own field behind a built-in instance variable (its getter returns this.<field>)
const field = (i, k) => {
	for (let p = i; p; p = Object.getPrototypeOf(p)) {
		const d = Object.getOwnPropertyDescriptor(p, k);
		if (d?.get) return /this\.(\w+)/.exec(d.get.toString())?.[1];
	}
};
export const KEEP = /^gml(resume_|path$|key_latch$|displayx$|displayy$)/;
// Restore: game_restart runs Game Start again, resume_start takes the state from resume_take and goes to its room,
// and that room's first Room Start rebuilds the saved instances. Returns null or a crash.
// A crash report's checkpoint (no rng) also has the keys held then (held) and latched (latch), and the key events
// and frame time of its own step (first, rendt): the restore's frame runs that step, and F.reportRun plays the
// steps after it. Instances the restore creates miss that frame's animation, as they do after a reload.
F.load = function (snap) {
	'use strict';
	const d = JSON.parse(snap);
	const rep = d.rng ? null : d;
	hook();
	setKeys([]);
	feed.reporting = !!rep;
	feed.rendtNext = null;
	if (rep) {
		// held since before the checkpoint: their key press is used up in a frame of the old game
		for (const k of rep.held) rawKey([0, 1, k, '']);
		safe(step);
	}
	F.crash = null;
	F.ended = false;
	localStorage.clear();
	for (const [k, v] of Object.entries(d.ls ?? d.files ?? {})) localStorage.setItem(k, v);
	const saved = JSON.parse(d.resume).globals;
	const g = gml();
	for (const k of Object.keys(g)) if (k.startsWith('gml') && !KEEP.test(k) && !(k.slice(3) in saved)) delete g[k];
	feed.pending = d.resume;
	// The same starting point whatever ran before: no pending timers, instance ids from the start (the restart
	// clears every instance), the same clock phase (current_time is whole milliseconds, so frame times alternate 16
	// and 17 ms) and the same Math.random seed.
	clock.timers = [];
	clock.raf = [clock.frameCb];
	clock.tick = (Math.floor(clock.tick / 3) + 2) * 3;
	clock.vnow = clock.tick * VSYNC;
	clock.seed = 1;
	window[N.ids] = 1000000;
	const surfaces = window[N.surfaces]; // left set by a crash in a Draw event
	while (surfaces?.length) surface_reset_target();
	if (rep) g.gmlresume_phase = 0;
	feed.pathQueue = [...feed.paths0];
	game_restart();
	// resume_start sets phase 1; in the saved room's first frame resume_restore clears resume_data, and the Begin
	// Step right after sets phase 0
	let seen = 0,
		armed = false;
	const done = () => seen && g.gmlresume_phase === 0 && g.gmlresume_data === undefined;
	for (let i = 0; i < 30 && !done(); i++) {
		if (rep && !armed && g.gmlresume_phase === 1) {
			// the next frame restores the checkpoint and runs its step
			armed = true;
			rep.first.forEach(rawKey);
			feed.rendtNext = rep.rendt ?? null;
			const latch = new Array(256).fill(0);
			for (const k of rep.latch.split(' ').filter(Boolean)) latch[+k] = 1;
			g.gmlkey_latch = latch;
		}
		try {
			step();
		} catch (e) {
			F.crash = { kind: 'restore', ...errText(e) };
			return F.crash;
		}
		seen = Math.max(seen, g.gmlresume_phase);
	}
	if (!done()) {
		F.crash = { kind: 'restore', message: `restore did not finish (phase ${g.gmlresume_phase})`, stack: '' };
		return F.crash;
	}
	F.frame = d.frame ?? 0;
	if (rep) return null;
	// The restore's frame also ran a whole step on the rebuilt game (Begin Step to Draw, alarms, animation) with a
	// near-zero frame time, where continuous play goes straight from the saved state to the next step: animations came
	// back a frame ahead, alarms a tick behind, delta-timed counters a little ahead (vou by 0.006). Restoring again,
	// outside a frame and onto the same instances, puts the saved state back, the saved frame time (rendt, rd)
	// included, and destroys what that step created.
	const res = JSON.parse(d.resume);
	try {
		const c = inst('oController');
		g.gmlresume_data = json_parse(c, d.resume); // (self, string)
		gml_Script_resume_restore(c, c);
	} catch (e) {
		F.crash = { kind: 'restore', ...errText(e) };
		return F.crash;
	}
	// It sets what was saved but keeps variables that step created (a follower blocked for that frame set o, zx, zy)
	const vars = new Map(res.instances.map((e) => [e.iid, e.vars]));
	for (const i of GetWithArray(-3)) {
		const v = vars.get(Number(i.id));
		if (v) for (const k of Object.keys(i)) if (k.startsWith('gml') && !(k.slice(3) in v)) delete i[k];
	}
	for (const k of Object.keys(g))
		if (k.startsWith('gml') && !KEEP.test(k) && !(k.slice(3) in res.globals) && typeof g[k] !== 'function') delete g[k];
	const byId = new Map(GetWithArray(-3).map((i) => [Number(i.id), i]));
	for (const [id, dir, spd] of d.motion ?? []) {
		const i = byId.get(id);
		if (i) {
			i[field(i, 'direction')] = dir;
			i[field(i, 'speed')] = spd;
		}
	}
	// Instances destroyed outside a frame (what that step created, the restore's mark for the next id) stay in the
	// runtime's id map until the end of the next frame, and removing one then clears the entry for its id even when a
	// new instance has that id by then, as it would after the counter goes back below: remove them now
	if (!N.sweep) {
		F.crash = { kind: 'restore', message: "the runtime's sweep of destroyed instances wasn't found", stack: '' };
		return F.crash;
	}
	window[N.room][N.sweep]();
	// Instance ids go on from the saved counter (that step and the mark used some up), and keys latched
	// when the snapshot was taken stay latched, as in continuous play when the next step holds them again (the
	// restore's frame released them all, since no key was held)
	window[N.ids] = res.nextid;
	const latch = new Array(256).fill(0);
	for (const k of d.latch ?? []) latch[k] = 1;
	g.gmlkey_latch = latch;
	if (d.pace && N.pace) {
		window[N.pace] = clock.vnow + d.pace.due;
		clock.raf = d.pace.raf ? [clock.frameCb] : [];
		clock.timers = d.pace.timers.map((due) => ({
			due: clock.vnow + due,
			seq: ++clock.timerSeq,
			fn: () => clock.raf.push(clock.frameCb),
		}));
	}
	const s = window[N.state];
	s.length = 0;
	s.push(...d.rng.state);
	window[N.b] = d.rng.b;
	window[N.c] = d.rng.c;
	for (const id of segList) seg[id] = 0; // what the restore itself ran isn't the program's
	segList.length = 0;
	return null;
};

// A JS error, or the runtime's GML error object (gmlmessage, gmlstacktrace)
export const errText = (e) => {
	if (e == null) return { message: String(e), stack: '' };
	const msg = e.gmllongMessage ?? e.gmlmessage ?? e.message ?? safe(() => JSON.stringify(e), String(e));
	const stack = e.gmlstacktrace ?? e.stack ?? '';
	return {
		message: String(msg),
		stack: Array.isArray(stack) ? stack.map((l) => String(l).trim()).join('\n') : String(stack),
	};
};
