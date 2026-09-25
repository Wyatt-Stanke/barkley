// The Controls panel (ControlsPanel), which the Start screen's Controls link opens before the game runs: where a
// player who cannot work out how to drive it is actually standing. The game itself never opens it.
//
// The bindings come from the game's own controls.txt in browser storage (key_save writes it: a warning line, then one
// key code a line), so they are the player's own. With no such file, or an unreadable one, they are the defaults,
// which is what the game would use anyway.
import { createSignal } from 'solid-js';
import { storage } from '../page';
import { type Control, DEFAULT_KEYS, type Keys } from '../runtime/keys';
import { PAD_BUTTON, PAD_DEAD, pressed } from './gamepad';

export const CONTROLS: [Control, string][] = [
	['up', 'Up'],
	['down', 'Down'],
	['left', 'Left'],
	['right', 'Right'],
	['action', 'Action'],
	['cancel', 'Cancel'],
	['start', 'Menu'],
];
export const label = (c: Control) => CONTROLS.find((r) => r[0] === c)?.[1] ?? c;
// key_doset's aliases: these act as the control they name unless the player has bound them to something else.
const ALIAS: Record<number, Control> = { 87: 'up', 65: 'left', 83: 'down', 68: 'right', 74: 'action', 75: 'cancel' };
// biome-ignore format: laid out by hand
const NAMES: Record<number, string> = {
	8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 19: 'Pause', 20: 'Caps Lock',
	27: 'Esc', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home',
	37: '← Left', 38: '↑ Up', 39: '→ Right', 40: '↓ Down',
	45: 'Insert', 46: 'Delete', 91: 'Meta', 93: 'Menu', 144: 'Num Lock', 145: 'Scroll Lock',
	186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
	219: '[', 220: '\\', 221: ']', 222: "'",
};

export function keyName(code: number) {
	code |= 0;
	if (NAMES[code]) return NAMES[code];
	if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) return String.fromCharCode(code);
	if (code >= 96 && code <= 105) return `Numpad ${code - 96}`;
	if (code >= 112 && code <= 123) return `F${code - 111}`;
	return `Key ${code}`;
}

// The panel, and the keys it shows: the player's own when the game has ever saved them
export const [controlsOpen, setControlsOpen] = createSignal(false);
export const [bindings, setBindings] = createSignal({ keys: DEFAULT_KEYS, saved: false });

// The Start screen's Controls link. (Also the Controls extension's one function, though nothing in the GML calls it.)
export function controls_show() {
	const saved = stored();
	setBindings({ keys: saved || DEFAULT_KEYS, saved: !!saved });
	setControlsOpen(true);
	return 0;
}

// key_save's controls.txt, under whatever prefix the runtime gives the game's files in browser storage.
function stored(): Keys | null {
	let text: string | null = null;
	for (const k of storage.keys()) if (k.length > 12 && k.slice(-12) === 'controls.txt') text = storage.get(k);
	if (!text) return null;
	const lines = text.split(/\r?\n/),
		keys = {} as Keys;
	for (let i = 0; i < CONTROLS.length; i++) {
		const n = parseInt(lines[i + 1], 10); // line 0 is key_save's "Do not edit or delete this file."
		if (!(n > 0 && n < 256)) return null;
		keys[CONTROLS[i][0]] = n;
	}
	return keys;
}

// The control a key presses, if any. An alias only stands for its control while no control is bound to that key,
// exactly as key_alias decides it.
export function controlOf(keys: Keys, code: number): Control | null {
	for (const [c] of CONTROLS) if (keys[c] === code) return c;
	return aliasOf(keys, code);
}
function aliasOf(keys: Keys, code: number) {
	const name = ALIAS[code];
	if (!name) return null;
	for (const [c] of CONTROLS) if (keys[c] === code) return null;
	return name;
}
export const aliases = (keys: Keys, c: Control) =>
	Object.keys(ALIAS)
		.map(Number)
		.filter((code) => aliasOf(keys, code) === c)
		.map(keyName);

export function defaultsLine({ keys, saved }: { keys: Keys; saved: boolean }) {
	if (CONTROLS.every(([c]) => keys[c] === DEFAULT_KEYS[c]))
		return saved
			? 'These are the keys the game starts with, and yours are still those.'
			: 'These are the keys the game starts with.';
	return 'You have changed these; the keys the game starts with are ↑ ↓ ← →, Z, X and C.';
}

// The controls a set of pads is pressing, by the gamepad extension's own mapping, so the test cannot drift from the
// game. (Its own held state is no use on the Start screen: it starts tracking only once the game has run key_doset.)
export function padControls(list: Gamepad[], on: Partial<Record<Control, boolean>>) {
	for (const g of list) {
		const b = g.buttons || [],
			ax = g.axes || [];
		for (let j = 0; j < b.length; j++) {
			const n = PAD_BUTTON[j];
			if (n && pressed(b[j])) on[n] = true;
		}
		if (typeof ax[0] === 'number') {
			if (ax[0] <= -PAD_DEAD) on.left = true;
			else if (ax[0] >= PAD_DEAD) on.right = true;
		}
		if (typeof ax[1] === 'number') {
			if (ax[1] <= -PAD_DEAD) on.up = true;
			else if (ax[1] >= PAD_DEAD) on.down = true;
		}
	}
}
