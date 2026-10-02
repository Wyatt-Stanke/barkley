import { step } from './clock.js';
import { F, roomName, safe } from './core.js';
import { seg, segList } from './coverage.js';
import { G } from './generators.js';
import { hook } from './hooks.js';
import { setKeys } from './input.js';
import { covOf, known, sync } from './known.js';
import { cellOf, flagsNow, setGoals } from './novelty.js';
import { errText } from './snapshot.js';
import { reseed } from './walk.js';

// ---- an episode ----
// req: { snap (restore it first; none: go on from here), program, sync, maxSnaps (default all), flags, seed }
// program items: [keys, frames], or {g: generator name, n: frame budget, ...arguments}.
// Runs the program and returns what ran (rec: the chunks, as a plain program), what was new at each checked chunk
// boundary, with a snapshot there, the exits taken and the things talked to.
export let episodeOut = null;
F.episode = function (req) {
	'use strict';
	hook();
	sync(req.sync);
	setGoals(req);
	const out = {
		finds: [],
		rec: [],
		segs: 0,
		frames: 0,
		crash: null,
		ended: false,
		exits: [],
		talked: [],
		genFrames: {},
		patched: [],
	};
	episodeOut = out;
	reseed(req.seed ?? 1);
	if (req.snap) {
		const e = F.load(req.snap);
		if (e) return { ...out, crash: e };
	}
	let unchecked = 0,
		lastRoom = roomName();
	// one chunk; returns false to stop the episode
	const run = (keys, n, gen) => {
		setKeys(keys);
		out.rec.push([keys, n]);
		for (let i = 0; i < n; i++) {
			try {
				if (!step()) {
					F.crash = { kind: 'stall', message: 'no frame scheduled', stack: '' };
					break;
				}
			} catch (e) {
				F.crash = { kind: 'exception', ...errText(e) };
				break;
			}
			F.frame++;
			out.frames++;
			if (F.ended) break;
		}
		out.segs = out.rec.length;
		if (F.crash) {
			out.crash = { ...F.crash, probe: safe(F.probe), gen };
			return false;
		}
		if (F.ended) {
			out.ended = true;
			return false;
		}
		unchecked += n;
		out.genFrames[gen ?? 'macro'] = (out.genFrames[gen ?? 'macro'] ?? 0) + n;
		const room = roomName();
		if (gen && unchecked < 16 && room === lastRoom) return true;
		unchecked = 0;
		lastRoom = room;
		const probe = F.probe();
		const find = { seg: out.segs, probe, cell: null, cov: [], flags: [], gen };
		const cell = cellOf(probe);
		if (!known.cells.has(cell)) {
			find.cell = cell;
			known.cells.add(cell);
		}
		const rc = covOf(probe.room);
		for (const id of segList) {
			seg[id] = 0;
			if (!rc[id]) {
				rc[id] = 1;
				find.cov.push(id);
			}
		}
		segList.length = 0;
		if (req.flags !== false)
			for (const f of flagsNow([]))
				if (!known.flags.has(f)) {
					known.flags.add(f);
					find.flags.push(f);
				}
		if (find.cell || find.cov.length || find.flags.length) {
			if (out.finds.length < (req.maxSnaps ?? Infinity)) {
				find.snap = F.save();
				for (const id of segList) seg[id] = 0; // what the snapshot ran (resume_save) isn't the program's
				segList.length = 0;
			}
			out.finds.push(find);
		}
		return true;
	};
	for (const item of req.program) {
		if (Array.isArray(item)) {
			if (!run(item[0], item[1])) break;
			continue;
		}
		let ok = true;
		// A fight that began on the way (walking into an oColliderGuy, the end of a cutscene) is fought, whatever was
		// planned: a walking generator in a battle has no player to walk and would give the rest of the episode up.
		const g = item.g !== 'dialog' && safe(roomName) === 'RomInter' ? 'battle' : item.g;
		try {
			for (const [keys, n] of G[g](item)) {
				ok = run(keys, n, g);
				if (!ok) break;
			}
		} catch (e) {
			// a generator's own bug, not the game's: note it and go on
			out.genError = `${g}: ${e?.stack}`;
		}
		if (!ok) break;
	}
	if (!out.crash) setKeys([]);
	episodeOut = null;
	return out;
};
