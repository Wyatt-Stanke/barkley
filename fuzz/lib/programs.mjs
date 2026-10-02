import { pick, rnd } from './util.mjs';

// ---- input programs: [[held keys, frames], ...] (the game runs at 60 frames a second) ----
const DIRS = ['up', 'down', 'left', 'right'];
const tap = (k, gap = rnd(2, 14)) => [
	[[k], rnd(1, 3)],
	[[], gap],
];
const MACROS = [
	[30, () => [[[pick(DIRS)], rnd(6, 90)]]], // walk
	[5, () => [[[pick(['up', 'down']), pick(['left', 'right'])], rnd(6, 60)]]], // diagonal
	[14, () => tap('z')], // action
	[14, () => Array.from({ length: rnd(3, 15) }, () => tap('z', rnd(3, 12))).flat()], // through dialog
	[6, () => tap('x')], // cancel
	[9, () => tap(pick(DIRS))], // menu cursor
	[8, () => [[[], rnd(10, 150)]]], // wait
	[
		8,
		() => {
			const d = pick(DIRS);
			return [
				[[d], rnd(4, 30)],
				[[d, 'z'], rnd(1, 3)],
				[[d], rnd(4, 30)],
			];
		},
	], // walk and act
	[4, () => [...tap('c'), ...Array.from({ length: rnd(1, 6) }, () => tap(pick([...DIRS, 'z']))).flat(), ...tap('x')]], // start menu
];
const MACRO_TOTAL = MACROS.reduce((a, [w]) => a + w, 0);
export function randomProgram(frames) {
	const p = [];
	for (let n = 0; n < frames; ) {
		let r = Math.random() * MACRO_TOTAL;
		const macro = MACROS.find(([w]) => {
			r -= w;
			return r < 0;
		});
		for (const s of macro[1]()) {
			p.push(s);
			n += s[1];
		}
	}
	return p;
}
// Generators run in the page (page/generators.js): dialog, exit, talk, seek, travel, battle. Their base weights; each is then
// scaled by how much it has found lately per frame played.
// heal only counts where the party is hurt (pickGenerator).
export const GENERATORS = { talk: 3, exit: 3, seek: 2, travel: 1.5, dialog: 0.5, battle: 0, heal: 0 };
export const retime = (prog) => prog.map(([k, n]) => [k, Math.max(1, Math.round(n * (0.7 + Math.random() * 0.6)))]);
export const frameCount = (prog) => prog.reduce((a, [, n]) => a + n, 0);
