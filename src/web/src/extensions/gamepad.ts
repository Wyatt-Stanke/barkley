// Game controllers (patch modernized/11): key_doset calls pad_keys and oController's Begin Step pad_context. A pad
// sends the bound keys the way the touch overlay does (sendKey), so a pad press is indistinguishable from a key press,
// and rebinding (SET KEYS), the key latch, dialog and every menu treat it as one.
//
// The game's own joystick code (key_joyemu, GM6's joystick_*) is left alone: its one call site was already commented
// out in the original, and it read a fixed joystick 1 rather than the bound keys.
//
// The Gamepad API reports buttons only by polling, so state is read once a frame in pad_poll's own
// requestAnimationFrame loop. Not under the fuzz harness, which runs only the runtime's frames (a fuzz run has no pads).
import { fuzz } from '../page';
import { type Control, DEFAULT_KEYS, keysFrom, sendKey } from '../runtime/keys';

let key = DEFAULT_KEYS,
  started = false,
  ctx = 0,
  mute = false;
const held: Partial<Record<Control, boolean>> = {},
  downAt: Partial<Record<Control, number>> = {},
  pending: Partial<Record<Control, number>> = {},
  repeatAt: Partial<Record<Control, number>> = {};

// The stick must travel past PAD_DEAD to turn a direction on and fall back inside PAD_LIVE to turn it off, so a thumb
// resting near the edge doesn't chatter between two directions.
export const PAD_DEAD = 0.45;
const PAD_LIVE = 0.3;
const MIN_HOLD = 100; // the game reads held keys once per 30 fps step
const REPEAT_DELAY = 400,
  REPEAT_RATE = 110; // held directions repeat, as a held arrow key does
// Standard-mapping buttons. Both bottom/left faces confirm and both right/top faces cancel, so a pad laid out either
// way round works; the shoulders cancel as well, which is how the player runs.
export const PAD_BUTTON: Record<number, Control> = {
  0: 'action',
  2: 'action',
  1: 'cancel',
  3: 'cancel',
  4: 'cancel',
  5: 'cancel',
  8: 'start',
  9: 'start',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};
const DIRECTION: Partial<Record<Control, true>> = { up: true, down: true, left: true, right: true };

// ---- extension entry points

// Called at the end of key_doset, so a pad always sends the currently bound keys.
export function pad_keys(...codes: number[]) {
  key = keysFrom(...codes);
  started = true;
  return 0;
}

// The same context sTouchContext gives the touch overlay. 4 is SET KEYS, where a synthetic press would bind a control
// to the key it already has.
export function pad_context(n: number) {
  n = n | 0;
  if (n === ctx) return 0;
  ctx = n;
  if (n === 4) releaseAll();
  return 0;
}

// ---- key injection

// The Controls panel tests a pad on the Start screen, so while it is open the pad keeps being read (the panel shows
// that state) but sends nothing. Anything held when it opens is released first.
export function padQuiet(on: boolean) {
  if (on === mute) return;
  if (on) {
    releaseAll();
    mute = true;
  } else mute = false;
}
export const padMuted = () => mute;

const send = (code: number, down: boolean) => mute || sendKey(code, down);

function down(k: Control) {
  if (pending[k]) (clearTimeout(pending[k]), (pending[k] = 0)); // pressed again mid-release
  if (held[k]) {
    if (!DIRECTION[k]) return;
    const now = Date.now(); // a held direction repeats, as the keyboard's does
    if (now >= repeatAt[k]!) ((repeatAt[k] = now + REPEAT_RATE), send(key[k], true));
    return;
  }
  held[k] = true;
  downAt[k] = Date.now();
  repeatAt[k] = downAt[k] + REPEAT_DELAY;
  send(key[k], true);
}

function up(k: Control) {
  if (!held[k]) return;
  // A press the game never saw is a press that never happened, so hold it out the rest of a step first.
  const owed = Math.max(0, MIN_HOLD - (Date.now() - (downAt[k] || 0)));
  if (owed > 0) {
    if (!pending[k])
      pending[k] = setTimeout(() => {
        pending[k] = 0;
        up(k);
      }, owed);
    return;
  }
  held[k] = false;
  send(key[k], false);
}

function releaseAll() {
  for (const k of Object.keys(held) as Control[]) {
    if (pending[k]) (clearTimeout(pending[k]), (pending[k] = 0));
    if (held[k]) ((held[k] = false), send(key[k], false));
  }
}

// ---- polling

// Pressed, from a button of the Gamepad API (or a bare number, as some old implementations give)
export const pressed = (b: GamepadButton | number | null | undefined) =>
  typeof b === 'object' && b ? b.pressed || b.value > 0.5 : (b ?? 0) > 0.5;

function axis(v: number | undefined, want: Partial<Record<Control, boolean>>, neg: Control, pos: Control) {
  if (typeof v !== 'number') return;
  if (v <= -(held[neg] ? PAD_LIVE : PAD_DEAD)) want[neg] = true;
  else if (v >= (held[pos] ? PAD_LIVE : PAD_DEAD)) want[pos] = true;
}

function read(g: Gamepad, want: Partial<Record<Control, boolean>>) {
  const b = g.buttons || [];
  for (let i = 0; i < b.length; i++) {
    const n = PAD_BUTTON[i];
    if (n && pressed(b[i])) want[n] = true;
  }
  const ax = g.axes || [];
  axis(ax[0], want, 'left', 'right');
  axis(ax[1], want, 'up', 'down');
}

// The connected pads, never throwing
export function pads(): Gamepad[] {
  try {
    return [...(navigator.getGamepads?.() ?? [])].filter((g): g is Gamepad => !!g && g.connected !== false);
  } catch {
    return [];
  }
}

function pad_poll() {
  window.requestAnimationFrame(pad_poll);
  if (!started || ctx === 4 || document.hidden) return;
  const want: Partial<Record<Control, boolean>> = {};
  for (const g of pads()) read(g, want);
  for (const k of Object.keys(key) as Control[]) {
    if (want[k]) down(k);
    else up(k);
  }
}

export function enableGamepad() {
  addEventListener('blur', releaseAll);
  addEventListener('gamepaddisconnected', releaseAll);
  document.addEventListener('visibilitychange', () => document.hidden && releaseAll());
  if (!fuzz) window.requestAnimationFrame(pad_poll);
}
