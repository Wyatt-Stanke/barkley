import { step } from './clock.js';
import { F, gml, inst, safe } from './core.js';
import { feed, hook } from './hooks.js';
import { rawKey, setKeys } from './input.js';
import { errText } from './snapshot.js';

// For replays: the same program, a snapshot after each segment listed in saveAt (counted from 1), the game state at
// a crash, and with drawLast, drawing on for the last frame (for a screenshot). hold: leave the last keys down (a
// program cut mid-segment, as video.mjs cuts it, carries on in the next call without a release and a fresh press).
F.replay = function (req) {
	'use strict';
	hook();
	const out = { frames: 0, saves: {}, crash: null };
	const last = req.program.length - 1;
	req.program.forEach(([keys, n], s) => {
		if (out.crash) return;
		setKeys(keys);
		for (let i = 0; i < n && !out.crash; i++) {
			if (req.drawLast && s === last && i === n - 1) F.draw(true);
			try {
				step();
			} catch (e) {
				out.crash = { kind: 'exception', ...errText(e), probe: safe(F.probe), seg: s, segFrame: i };
			}
			F.frame++;
			out.frames++;
		}
		if (!out.crash && req.saveAt?.includes(s + 1)) out.saves[s + 1] = F.save();
	});
	if (req.drawLast) F.draw(false);
	if (!out.crash && !req.hold) setKeys([]);
	out.probe = safe(F.probe);
	return out;
};

// For crash reports, after F.load of the checkpoint: its steps from..to-1 (step 0 was the restore's), with their
// key events (report.events) and frame times (report.steps; none for a step the game crashed in before crash_step).
F.reportRun = function (req) {
	'use strict';
	const out = { frames: 0, crash: null };
	for (let i = req.from; i < req.to && !out.crash; i++) {
		// the checkpoint's step ran with the restore; from here the step count follows the recorded game's, so the
		// checkpoints 30 steps apart land on the same steps and draw the same seeds
		if (i === 1) gml().gmlresume_count = 0;
		for (const e of req.events) if (e[0] === i) rawKey(e);
		feed.rendtNext = req.steps[i] ?? null;
		if (req.drawLast && i === req.to - 1) F.draw(true);
		try {
			step();
		} catch (e) {
			out.crash = { kind: 'exception', ...errText(e), probe: safe(F.probe), step: i };
		}
		feed.rendtNext = null;
		F.frame++;
		out.frames++;
	}
	if (req.drawLast) F.draw(false);
	out.probe = safe(F.probe);
	return out;
};
// The state after the last replayed step against the one the report ended with (the recorded game saved it in the
// step after its last recorded one, at the same point): what differs, as [what, now, then]
F.reportDiff = function (end) {
	'use strict';
	const c = inst('oController');
	const a = JSON.parse(gml_Script_resume_save(c, c)),
		b = JSON.parse(end);
	const out = [];
	// What resume_save writes differs harmlessly between a game that has run and one restored from that state: a
	// handle comes back as its asset or instance number, true/false as 1/0, undefined as a missing value. The clock
	// runs on the fuzzer's virtual time, so its values differ too.
	const CLOCK = /(^|\.)(rendrate|startingTime|seconds|deltaTime|time|__res)$/;
	const norm = (v) => {
		if (v === true) return 1;
		if (v === false) return 0;
		if (v === null || v === '~u') return;
		if (Array.isArray(v)) return v.map(norm);
		if (typeof v !== 'string') return v;
		const m = /^~ref (\w+) (\S+)$/.exec(v);
		if (!m) return v;
		return /^\d+$/.test(m[2]) ? +m[2] : safe(() => Number(asset_get_index(m[2])), v);
	};
	const cmp = (what, x, y) => {
		if (CLOCK.test(what)) return;
		const [sx, sy] = [JSON.stringify(norm(x)), JSON.stringify(norm(y))];
		if (sx !== sy) out.push([what, JSON.stringify(x)?.slice(0, 200), JSON.stringify(y)?.slice(0, 200)]);
	};
	cmp('room', a.room, b.room);
	for (const k of new Set([...Object.keys(a.globals), ...Object.keys(b.globals)]))
		cmp(`global.${k}`, a.globals[k], b.globals[k]);
	const byId = (l) => new Map(l.map((e) => [e.iid, e]));
	const [ia, ib] = [byId(a.instances), byId(b.instances)];
	for (const id of new Set([...ia.keys(), ...ib.keys()])) {
		const [x, y] = [ia.get(id), ib.get(id)];
		if (!x || !y || x.object !== y.object) {
			cmp(`instance ${id}`, x?.object, y?.object);
			continue;
		}
		cmp(`${x.object} ${id} built-ins`, x.builtin, y.builtin);
		for (const k of new Set([...Object.keys(x.vars ?? {}), ...Object.keys(y.vars ?? {})]))
			cmp(`${x.object} ${id}.${k}`, x.vars?.[k], y.vars?.[k]);
	}
	for (const k of ['paths', 'views', 'backgrounds', 'nextid']) cmp(k, a[k], b[k]);
	return out;
};
