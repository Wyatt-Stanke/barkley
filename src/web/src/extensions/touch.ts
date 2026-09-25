// Touch controls (patch modernized/10): a joystick or D-pad and A/B/START over the canvas, which TouchOverlay draws from
// the state here. key_doset calls touch_keys, oController's Begin Step touch_context, and oScreenFill touch_dpr and
// touch_view_* to size the canvas and place the picture. Presses reach the game as the bound keys (sendKey).
//
// Two coordinate systems meet here. The overlay lives in CSS pixels; GML's window/canvas coordinates are device
// pixels once the DPR fix is on. px() is the only place that converts.
import { batch, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { fuzz, storage } from '../page';
import { type Control, DEFAULT_KEYS, keysFrom, sendKey } from '../runtime/keys';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Button {
  k: Control;
  label: string;
  x: number;
  y: number;
  r: number;
  pill?: boolean;
}
export interface Layout {
  W: number;
  H: number;
  game: Rect;
  dirZone: Rect;
  dirHit: Rect; // runs out to the screen edge, past the safe area, so a thumb beside the Dynamic Island still steers
  dirCenter: { x: number; y: number };
  dpadR: number;
  gear: { x: number; y: number; r: number };
  buttons: Button[];
  safe: Rect;
}
type Sector = 'right' | 'upright' | 'up' | 'upleft' | 'left' | 'downleft' | 'down' | 'downright';
interface Pointer {
  role: 'btn' | 'screen' | 'dir';
  k?: Control | null;
  up?: boolean;
}

export const BASE_R = 56,
  KNOB_R = 24,
  THROW = 48;
const HYST = 7,
  MIN_HOLD = 100,
  GW = 320,
  GH = 240;
// Cardinal-biased sectors: walking straight is the common case, so cardinals get 50 deg, diagonals 40.
// biome-ignore format: laid out by hand
const S8: [Sector, number, number][] = [
  ['right', 0, 25], ['upright', 45, 20], ['up', 90, 25], ['upleft', 135, 20],
  ['left', 180, 25], ['downleft', 225, 20], ['down', 270, 25], ['downright', 315, 20],
];
const S4: [Sector, number, number][] = [
  ['right', 0, 45],
  ['up', 90, 45],
  ['left', 180, 45],
  ['down', 270, 45],
];
// biome-ignore format: laid out by hand
const PAIR: Record<Sector, Control[]> = {
  up: ['up'], down: ['down'], left: ['left'], right: ['right'],
  upright: ['up', 'right'], upleft: ['up', 'left'], downright: ['down', 'right'], downleft: ['down', 'left'],
};
// context -> [direction opacity, button opacity, 8-way?]
export const CONTEXTS: [number, number, boolean][] = [
  [1, 1, true],
  [0.92, 1, false],
  [0.5, 0.92, true],
  [0.28, 0.34, true],
  [0, 0, true],
];

// ---- state (what TouchOverlay draws)

// The player's settings, kept in localStorage barkley.touch
export const [cfg, setCfg] = createStore({
  mode: 'stick' as 'stick' | 'dpad',
  side: 'right' as 'right' | 'left',
  haptics: 1,
  enabled: 2, // 2 auto (hidden while a gamepad is connected), 1 on, 0 off
});
let key = DEFAULT_KEYS;
const [started, setStarted] = createSignal(false); // the game has run key_doset: the overlay may come up
export const [live, setLive] = createSignal(false); // the controls are up (not just the settings button)
export const [ctx, setCtx] = createSignal(0);
export const [ready, setReady] = createSignal(false);
export const [layout, setLayout] = createSignal<Layout | null>(null);
export const [held, setHeld] = createStore<Partial<Record<Control, boolean>>>({});
export const [dir, setDir] = createStore({ active: false, bx: 0, by: 0, tx: 0, ty: 0, sector: null as Sector | null });
export const [sheetOpen, setSheetOpen] = createSignal(false);
const downAt: Partial<Record<Control, number>> = {},
  pending: Partial<Record<Control, number>> = {};
let ptr: Record<number, Pointer> = {};

// ---- extension entry points

// Called at the end of key_doset, so the overlay always sends the currently bound keys.
export function touch_keys(...codes: number[]) {
  key = keysFrom(...codes);
  setStarted(true);
  apply();
  return 0;
}

export function touch_context(n: number) {
  n |= 0;
  if (n === ctx()) return 0;
  setCtx(n);
  if (n === 4) releaseAll(); // SET KEYS: never let a synthetic press bind itself
  return 0;
}

export const touch_active = () => (live() ? 1 : 0);
// the picture's rectangle in device pixels, while the overlay lays it out
const gameRect = () => (live() ? layout()?.game : undefined);
export const touch_view_x = () => Math.round((gameRect()?.x ?? 0) * px());
export const touch_view_y = () => Math.round((gameRect()?.y ?? 0) * px());
export const touch_view_w = () => Math.round((gameRect()?.w ?? innerWidth) * px());
export const touch_view_h = () => Math.round((gameRect()?.h ?? innerHeight) * px());

// The runtime ignores devicePixelRatio, so the canvas is backed by CSS pixels and the browser upscales it.
// oScreenFill sizes the canvas to browser_* times this, and touch_pin puts the CSS size back.
export function touch_dpr() {
  const r = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(3, r)); // past 3x the final blit costs more than it returns
}
const px = touch_dpr;

// ---- key injection

function down(k: Control) {
  // sliding back cancels the release
  if (pending[k]) {
    clearTimeout(pending[k]);
    pending[k] = 0;
  }
  if (held[k]) return;
  setHeld(k, true);
  downAt[k] = Date.now();
  sendKey(key[k], true);
}
// How much of the minimum hold this key still owes.
const owed = (k: Control) => (held[k] ? Math.max(0, MIN_HOLD - (Date.now() - (downAt[k] || 0))) : 0);
function up(k: Control) {
  if (!held[k]) return;
  // The game reads held state once per 30 fps step, so a tap shorter than a frame is invisible.
  const wait = owed(k);
  if (wait > 0) {
    if (!pending[k])
      pending[k] = setTimeout(() => {
        pending[k] = 0;
        up(k);
      }, wait);
    return;
  }
  setHeld(k, false);
  sendKey(key[k], false);
}
// Sliding between buttons must never hold both: the incoming key waits for the outgoing key to finish paying off its
// minimum hold, so a fast A->B roll still sends a real A press and then a real B press.
function swap(r: Pointer, k: Control | null) {
  let wait = 0;
  if (r.k) {
    wait = owed(r.k);
    up(r.k);
  }
  r.k = k;
  if (!k) return;
  if (wait <= 0) {
    down(k);
    buzz(8);
    return;
  }
  setTimeout(() => {
    if (r.k !== k) return; // the finger moved on again while the press was waiting
    down(k);
    buzz(8);
    if (r.up) up(k); // it already lifted: land it as a tap, never a stuck key
  }, wait + 1);
}
export function releaseAll() {
  batch(() => {
    for (const t of Object.keys(pending) as Control[])
      if (pending[t]) {
        clearTimeout(pending[t]);
        pending[t] = 0;
      }
    for (const k of Object.keys(held) as Control[])
      if (held[k]) {
        setHeld(k, false);
        sendKey(key[k], false);
      }
    setDir({ active: false, sector: null });
    ptr = {};
  });
}
function buzz(ms: number) {
  if (cfg.haptics && navigator.vibrate)
    try {
      navigator.vibrate(ms);
    } catch {}
}
function sector(next: Sector | null) {
  if (dir.sector === next) return;
  const was = dir.sector ? PAIR[dir.sector] : [],
    now = next ? PAIR[next] : [];
  for (const k of was)
    if (!now.includes(k)) {
      setHeld(k, false);
      sendKey(key[k], false);
    }
  for (const k of now) down(k);
  setDir('sector', next);
}

// ---- settings

function load() {
  try {
    const s = JSON.parse(storage.get('barkley.touch') || '{}');
    for (const k of Object.keys(cfg) as (keyof typeof cfg)[]) if (s[k] !== undefined) setCfg(k, s[k]);
  } catch {}
}
// A setting from the sheet: kept, then laid out again
export function setting<K extends keyof typeof cfg>(k: K, v: (typeof cfg)[K]) {
  setCfg(k, v);
  if (k === 'enabled') apply();
  storage.set('barkley.touch', JSON.stringify(cfg));
  relayout();
}
function wanted() {
  if (cfg.enabled === 0) return false;
  if (cfg.enabled === 1) return true;
  if (padConnected()) return false; // a real controller is plugged in
  return capable();
}
const capable = () => navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
// With the controls off (or hidden for a gamepad), a touch device still gets the settings button, alone, or turning
// them off could never be undone.
export const shown = () => ready() && started() && (live() || capable());
function padConnected() {
  try {
    for (const g of navigator.getGamepads?.() ?? []) if (g) return true;
  } catch {}
  return false;
}
function apply() {
  const want = ready() && started() && wanted();
  if (want !== live()) {
    setLive(want);
    if (!want) releaseAll();
  }
  relayout();
}

// ---- layout

function inset(name: string) {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--touch-${name}`)) || 0;
}
// Everything drawn stays inside the safe area (clear of the Dynamic Island or notch, the rounded corners and the home
// indicator), but the direction control's hit zone (dirHit) runs out to the screen edge, so a thumb that lands in the
// inset beside the island still steers. In landscape the joystick's zone is the whole two-thirds of the screen on its
// side, over the picture too; the D-pad, which measures from its fixed centre, keeps its bar.
function relayout() {
  if (!ready()) return;
  const W = innerWidth,
    H = innerHeight;
  const it = inset('top'),
    ib = inset('bottom');
  let il = inset('left'),
    ir = inset('right');
  const safe = { x: il, y: it, w: W - il - ir, h: H - it - ib };
  if (!live()) {
    // no controls: the picture uses the whole window
    const none = { x: 0, y: 0, w: 0, h: 0 };
    // biome-ignore format: laid out by hand
    setLayout({
      W, H, safe, buttons: [], dpadR: 0,
      game: { x: 0, y: 0, w: W, h: H }, dirZone: none, dirHit: none, dirCenter: { x: 0, y: 0 },
      gear: shown() ? { x: W - ir - 30, y: it + 30, r: 15 } : { x: -99, y: -99, r: 0 },
    });
    return;
  }
  // Laid out right-handed and mirrored for side 'left', so each edge's inset goes with the controls that end up there
  if (cfg.side === 'left') [il, ir] = [ir, il];
  const wide = W / H > GW / GH,
    buttons: Button[] = [];
  let game: Rect, dirZone: Rect, dirHit: Rect, dirCenter: { x: number; y: number }, gear: Layout['gear'];
  if (!wide) {
    const s = W / GW;
    game = { x: 0, y: it, w: W, h: Math.round(GH * s) };
    const py = game.y + game.h;
    const panel = { x: 0, y: py, w: W, h: Math.max(0, H - py - ib) };
    dirZone = { x: il, y: py, w: (W - il - ir) * 0.52, h: panel.h };
    dirHit = { x: 0, y: py, w: il + dirZone.w, h: H - py };
    const bx = W - 74 - ir,
      by = py + panel.h - 180;
    buttons.push({ k: 'action', label: 'A', x: bx, y: by, r: 34 });
    buttons.push({ k: 'cancel', label: 'B', x: bx - 64, y: by - 45, r: 30 });
    buttons.push({ k: 'start', label: 'START', x: W / 2, y: py + 64, r: 22, pill: true });
    gear = { x: W - 50 - ir, y: py + 64, r: 15 };
    dirCenter = { x: dirZone.x + dirZone.w * 0.46, y: py + panel.h - 190 };
  } else {
    const sc = Math.min(W / GW, H / GH);
    const gw = Math.round(GW * sc),
      gh = Math.round(GH * sc);
    game = { x: Math.round((W - gw) / 2), y: Math.round((H - gh) / 2), w: gw, h: gh };
    const bar = game.x;
    const lw = Math.max(bar - il, 92),
      rEdge = W - ir,
      rw = Math.max(bar - ir, 92);
    dirZone = { x: il, y: it, w: lw, h: H - it - ib };
    dirHit = { x: 0, y: 0, w: cfg.mode === 'stick' ? Math.round((W * 2) / 3) : il + lw, h: H };
    // The cluster reaches 84 px left of A's centre (B is up-left by 54 at r 30). Keep that clear of the picture and
    // keep A on screen; if the bar cannot hold both, staying on screen wins.
    const gameR = game.x + game.w;
    const minAx = gameR + 6 + 84,
      maxAx = rEdge - 8 - 34;
    const ax = Math.min(maxAx, Math.max(minAx, rEdge - rw * 0.42)),
      ay = H - 104 - ib;
    buttons.push({ k: 'action', label: 'A', x: ax, y: ay, r: 34 });
    buttons.push({ k: 'cancel', label: 'B', x: ax - 54, y: ay - 46, r: 30 });
    // biome-ignore format: laid out by hand
    buttons.push({
      k: 'start', label: 'START', r: 20, pill: true,
      x: Math.min(maxAx, Math.max(gameR + 6 + 34, rEdge - rw * 0.5)), y: 42 + it,
    });
    gear = { x: Math.max(26 + il, il + lw / 2), y: 36 + it, r: 15 };
    dirCenter = { x: dirZone.x + lw / 2, y: H - 118 - ib };
  }
  const dpadR = Math.max(52, Math.min(78, dirZone.w / 2 - 6));
  if (cfg.side === 'left') {
    dirZone.x = W - (dirZone.x + dirZone.w);
    dirHit.x = W - (dirHit.x + dirHit.w);
    dirCenter.x = W - dirCenter.x;
    gear.x = W - gear.x;
    for (const b of buttons) b.x = W - b.x;
    [il, ir] = [ir, il]; // back to the real edges
  }
  for (const bt of [...buttons, gear] as (Button | Layout['gear'])[]) {
    const pill = 'pill' in bt && bt.pill;
    const hw = pill ? bt.r * 1.7 : bt.r,
      hh = pill ? bt.r * 0.75 : bt.r; // the pill is 3.4r x 1.5r
    bt.x = Math.max(il + hw + 8, Math.min(W - ir - hw - 8, bt.x));
    bt.y = Math.max(it + hh + 8, Math.min(H - ib - hh - 8, bt.y));
  }
  dirCenter.x = Math.max(dirZone.x + dpadR + 6, Math.min(dirZone.x + dirZone.w - dpadR - 6, dirCenter.x));
  dirCenter.y = Math.max(dirZone.y + dpadR + 6, Math.min(dirZone.y + dirZone.h - dpadR - 6, dirCenter.y));
  setLayout({ W, H, game, dirZone, dirHit, dirCenter, dpadR, gear, buttons, safe });
}

// ---- input

const inside = (p: { x: number; y: number }, z: Rect) =>
  p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
function over(p: { x: number; y: number }, b: Button, f: number) {
  const dx = p.x - b.x,
    dy = p.y - b.y;
  return b.pill
    ? Math.abs(dx) <= b.r * 2.4 * f && Math.abs(dy) <= b.r * 1.2 * f
    : dx * dx + dy * dy <= b.r * f * (b.r * f);
}
function buttonAt(p: { x: number; y: number }, cur: Control | null | undefined) {
  const bs = layout()?.buttons ?? [];
  // hysteresis: hold the current button until well outside it before acquiring another
  if (cur) for (const b of bs) if (b.k === cur && over(p, b, 1.32)) return cur;
  for (const b of bs) if (over(p, b, 1.1)) return b.k;
  return null;
}
const angdist = (a: number, c: number) => Math.abs(((a - c + 540) % 360) - 180);
function sectorFor(a: number, eight: boolean, cur: Sector | null) {
  const t = eight ? S8 : S4;
  if (cur) for (const s of t) if (s[0] === cur && angdist(a, s[1]) <= s[2] + HYST) return cur;
  for (const s of t) if (angdist(a, s[1]) <= s[2]) return s[0];
  return t[0][0];
}
function updateDir() {
  const eight = CONTEXTS[ctx()][2];
  let dx = dir.tx - dir.bx,
    dy = dir.ty - dir.by,
    dist = Math.hypot(dx, dy);
  if (cfg.mode === 'stick' && dist > THROW) {
    // follow: the base slides under the thumb
    setDir({ bx: dir.tx - (dx / dist) * THROW, by: dir.ty - (dy / dist) * THROW });
    dx = dir.tx - dir.bx;
    dy = dir.ty - dir.by;
    dist = THROW;
  }
  const dead = cfg.mode === 'stick' ? 12 : 14,
    out = cfg.mode === 'stick' ? 8 : 10;
  if (dist < (dir.sector ? out : dead)) return sector(null);
  const a = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
  const next = sectorFor(a, eight, dir.sector);
  if (next !== dir.sector) buzz(4);
  sector(next);
}

export function onPointerDown(e: PointerEvent) {
  const L = layout();
  if (!L || ctx() === 4) return;
  e.preventDefault();
  const p = { x: e.clientX, y: e.clientY };
  if (Math.hypot(p.x - L.gear.x, p.y - L.gear.y) <= L.gear.r * 1.6) return openSheet();
  if (!live()) return; // controls off: only the settings button answers
  batch(() => {
    const k = buttonAt(p, null);
    if (k) {
      // a finger that lands on a button stays in button mode
      ptr[e.pointerId] = { role: 'btn', k };
      down(k);
      buzz(8);
    } else if (inside(p, L.game) && ctx() === 2) {
      ptr[e.pointerId] = { role: 'screen' }; // dialog: the picture advances it, even inside dirHit
      down('action');
    } else if (inside(p, L.dirHit)) {
      // the stick's base is where the thumb lands, so a tap never moves; only its drawing keeps to the safe area
      const base = cfg.mode === 'dpad' ? { bx: L.dirCenter.x, by: L.dirCenter.y } : { bx: p.x, by: p.y };
      setDir({ active: true, tx: p.x, ty: p.y, ...base });
      ptr[e.pointerId] = { role: 'dir' };
      updateDir();
    }
  });
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {}
}
export function onPointerMove(e: PointerEvent) {
  const r = ptr[e.pointerId];
  if (!r) return;
  e.preventDefault();
  batch(() => {
    if (r.role === 'dir') {
      setDir({ tx: e.clientX, ty: e.clientY });
      updateDir();
    } else if (r.role === 'btn') {
      const k = buttonAt({ x: e.clientX, y: e.clientY }, r.k);
      if (k !== r.k) swap(r, k); // slide A -> B: release A, then press B, never both
    }
  });
}
export function onPointerUp(e: PointerEvent) {
  const r = ptr[e.pointerId];
  if (!r) return;
  delete ptr[e.pointerId];
  r.up = true; // a press still waiting on the minimum hold becomes a tap
  batch(() => {
    if (r.role === 'btn') {
      if (r.k) up(r.k);
    } else if (r.role === 'screen') up('action');
    else {
      sector(null);
      setDir('active', false);
    }
  });
}

// ---- the settings sheet and SET KEYS

function openSheet() {
  releaseAll();
  setSheetOpen(true);
}

// SET KEYS records the next seven keys pressed and has no cancel key, so on a device with no keyboard this is the only
// way out: replay the seven defaults, which restores the original bindings.
export function restoreDefaultKeys() {
  const seq = [38, 40, 37, 39, 90, 88, 67];
  let i = 0;
  const next = () => {
    if (i >= seq.length) return;
    const c = seq[i++];
    sendKey(c, true);
    setTimeout(() => {
      sendKey(c, false);
      setTimeout(next, 170);
    }, 170);
  };
  next();
}

// ---- boot

// window_set_size writes only the canvas backing store, so pin the CSS size to the window. The runtime's fullscreen
// path rewrites canvas.style.cssText, hence re-checking every frame.
function touch_pin() {
  const c = document.getElementById('canvas') || document.querySelector('canvas');
  if (c) {
    const w = `${innerWidth}px`,
      h = `${innerHeight}px`;
    if (c.style.width !== w) c.style.width = w;
    if (c.style.height !== h) c.style.height = h;
  }
  window.requestAnimationFrame(touch_pin);
}

export function enableTouch() {
  if (ready()) return;
  load();
  const reset = () => {
    releaseAll();
    relayout();
  };
  addEventListener('resize', reset);
  addEventListener('orientationchange', reset);
  addEventListener('blur', releaseAll);
  addEventListener('gamepadconnected', apply);
  addEventListener('gamepaddisconnected', apply);
  document.addEventListener('visibilitychange', () => document.hidden && releaseAll());
  setReady(true);
  apply();
  if (!fuzz) window.requestAnimationFrame(touch_pin);
}
