// The game's seven controls, and how the touch overlay and a game controller press them.
export type Control = 'up' | 'down' | 'left' | 'right' | 'action' | 'cancel' | 'start';
export type Keys = Record<Control, number>;

// The keys the game starts with (key_doset's defaults): arrows, Z, X, C.
export const DEFAULT_KEYS: Keys = { up: 38, down: 40, left: 37, right: 39, action: 90, cancel: 88, start: 67 };

// key_doset's arguments, in its order
export const keysFrom = (...codes: number[]): Keys => ({
	up: codes[0] | 0,
	down: codes[1] | 0,
	left: codes[2] | 0,
	right: codes[3] | 0,
	action: codes[4] | 0,
	cancel: codes[5] | 0,
	start: codes[6] | 0,
});

// Keys reach the game the way the fuzzer drives it: by calling the runtime's own window.onkeydown / window.onkeyup
// with {which, keyCode}. Those are DOM properties, so the names survive obfuscation, and a synthetic press is then
// indistinguishable from a physical key: rebinding, the key latch and menus all just work. The handler is looked up
// at the time, never cached: it is null until GameMaker_Init runs and is set back to null at game end.
export function sendKey(code: number, down: boolean) {
	const h = down ? window.onkeydown : window.onkeyup;
	if (!h) return;
	try {
		(h as (e: object) => void).call(window, {
			which: code,
			keyCode: code,
			key: '',
			repeat: false,
			preventDefault() {},
			stopPropagation() {},
		});
	} catch {}
}
