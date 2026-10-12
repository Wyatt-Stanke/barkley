import { F, safe } from './core.js';
import { episodeOut } from './episode.js';
import { errText } from './snapshot.js';

// Known crash classes patched so the search can go on past them (fuzz.mjs --through): a number drawn as text,
// and real() of a string that isn't a number (GM6 gave 0; a handle's string gives its asset or instance number).
// Each patched spot is reported (patched, with the error it would have thrown), so it is still a finding.
export const patched = (e) => {
	if (!episodeOut) return;
	const { message } = errText(e);
	if (episodeOut.patched.some((p) => p.message === message)) return;
	episodeOut.patched.push({
		kind: 'patched',
		seg: episodeOut.rec.length,
		message,
		stack: new Error().stack,
		probe: safe(F.probe),
	});
};
F.through = () => {
	const sh = window.string_hash_to_newline;
	window.string_hash_to_newline = function (v) {
		'use strict';
		if (typeof v === 'string') return sh(v);
		try {
			sh(v);
		} catch (e) {
			patched(e);
		}
		return sh(string(v));
	};
	const re = window.real;
	window.real = function (v) {
		'use strict';
		try {
			return re(v);
		} catch (e) {
			if (typeof v !== 'string') throw e;
			patched(e);
			const m = v.match(/^ref (\w+) (\S+)/);
			if (!m) return 0;
			return /^\d+$/.test(m[2]) ? +m[2] : Number(asset_get_index(m[2]));
		}
	};
	// script_execute of a number that is no script (GM6 script ids were small numbers; here they index the runtime's
	// own functions): does nothing
	const se = window.script_execute;
	window.script_execute = function (_inst, _other, fn) {
		'use strict';
		if (typeof fn === 'number' && fn < 100000) {
			patched(new Error(`script_execute(${fn}): not a script`));
			return 0;
		}
		return se.apply(this, arguments);
	};
};
