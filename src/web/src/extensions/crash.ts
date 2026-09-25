// Crash reports (patch modernized/07). The game hands over a checkpoint (its resume state) every 30 steps and each
// step's frame time; this records the key events between steps. After an uncaught error, or when the player types BUG
// (in capitals), the page shows a report (CrashPanel): the checkpoint about 10 s back, the frame times and key events
// since, and the error or the state the game has now, gzipped and Base64-encoded. `node src/fuzz.mjs replay <build>
// <report file>` replays it, so the report's format is fixed: change it only with the replay.
import { createSignal } from 'solid-js';
import { folder, storage } from '../page';
import { base64 } from './saves';

type Event = [type: number, which: number, key: string]; // type: 0 up, 1 down, 2 blur, 3 focus
type Checkpoint = { step: number; state: string; latch: string; held: number[] };

let steps: number[] = [], // frame times of steps base..n-1
  events: [number, ...Event][] = [],
  base = 0,
  n = 0;
let points: Checkpoint[] = [],
  pending: Event[] = [],
  held: Record<number, 1> = {},
  typed = '',
  typedAt = 0;
let want = 0,
  done = false;
const WINDOW = 300; // steps (10 s at 30 a second) a report reaches back

// The report on screen, if any
export const [crashReport, setCrashReport] = createSignal<{ kind: 'crash' | 'report'; text: string } | null>(null);

// A checkpoint in the step about to run (before its crash_step); state '' (a menu) forgets them all.
export function crash_put(state: string, latch: string) {
  if (done) return 0;
  if (state === '') points = [];
  else {
    points.push({ step: n, state, latch, held: Object.keys(held).map(Number) });
    while (points.length > 1 && points[1].step <= n - WINDOW) points.shift();
  }
  // without a checkpoint, the last 30 s of input are still worth showing
  trim(points.length ? points[0].step : n - 900);
  return 0;
}

// oController's Begin Step, every step: the step's frame time; the key events before it belong to it.
export function crash_step(rendt: number) {
  if (done) return rendt;
  for (const e of pending) {
    events.push([n, ...e]);
    if (e[0] === 1) held[e[1]] = 1;
    else if (e[0] === 0) delete held[e[1]];
    else if (e[0] === 2) held = {};
  }
  pending = [];
  steps.push(rendt);
  n++;
  if (steps.length > 20000) trim(n - 900); // a long time in a menu
  return rendt;
}

function trim(from: number) {
  if (from <= base) return;
  steps.splice(0, Math.min(from - base, steps.length));
  base = from;
  let k = 0;
  while (k < events.length && events[k][0] < from) k++;
  events.splice(0, k);
}

export function crash_wanted() {
  const w = want;
  want = 0;
  return w;
}

// The game's state when a report was asked for (BUG)
export function crash_end(state: string) {
  report('report', null, state);
  return 0;
}

function record(type: number, e: KeyboardEvent | null) {
  if (done || crashReport()) return;
  const which = e ? e.which || e.keyCode || 0 : 0;
  pending.push([type, which, e?.key || '']);
  if (type !== 1 || !e) return;
  if (e.key && e.key.length === 1 && e.key >= 'A' && e.key <= 'Z') {
    if (Date.now() - typedAt > 3000) typed = '';
    typed = (typed + e.key).slice(-3);
    typedAt = Date.now();
    if (typed === 'BUG') ((want = 1), (typed = ''));
  } else if (e.key && e.key.length === 1) typed = '';
}

export function enableCrash() {
  addEventListener('keydown', (e) => record(1, e), true);
  addEventListener('keyup', (e) => record(0, e), true);
  // the window's own (the runtime clears its keys on blur), not an element's
  addEventListener('blur', (e) => e.target === window && record(2, null), true);
  addEventListener('focus', (e) => e.target === window && record(3, null), true);
  addEventListener('error', (e) => {
    if (done) return;
    const x = e.error;
    let message: unknown, stack: unknown;
    if (x && typeof x === 'object') {
      message = x.gmllongMessage || x.gmlmessage || x.message;
      stack = x.gmlstacktrace || x.stack;
    }
    if (message === undefined) message = e.message;
    if (Array.isArray(stack)) stack = stack.join('\n');
    report('crash', { message: String(message), stack: String(stack || ''), file: e.filename, line: e.lineno });
  });
}

function report(kind: 'crash' | 'report', error: object | null, end?: string) {
  if (done) return;
  if (kind === 'crash') done = true; // the game has stopped
  const cp = points[0] || null,
    from = cp ? cp.step : base;
  // the game's own script (the runtime adds the extensions' scripts to the head, ahead of it)
  const script =
    document.querySelector(`script[src*="${folder}/"][src*="cachebust"]`) ||
    document.querySelector(`script[src*="${folder}/"]`);
  const report = {
    version: 1,
    kind,
    time: new Date().toISOString(),
    page: location.href,
    bundle: script ? script.getAttribute('src') : '',
    agent: navigator.userAgent,
    window: [innerWidth, innerHeight, devicePixelRatio],
    error,
    checkpoint: cp && { state: cp.state, latch: cp.latch, held: cp.held, files: files() },
    // frame times from the checkpoint's step on, key events [step - from, type (0 up, 1 down, 2 blur, 3 focus),
    // key code, key]; events after the last step go with a step that has no frame time
    steps: steps.slice(from - base),
    events: events
      .filter((e) => e[0] >= from)
      .map((e) => [e[0] - from, ...e.slice(1)])
      .concat(pending.map((e) => [n - from, ...e])),
    end: end || null,
  };
  encode(JSON.stringify(report)).then((text) => {
    storage.set('barkley.crash', text);
    setCrashReport({ kind, text });
  });
}

// The game's files (saves, settings): the runtime keeps them in browser storage
function files() {
  const out: Record<string, string | null> = {};
  for (const k of storage.keys()) if (k.indexOf('barkley.') !== 0) out[k] = storage.get(k);
  return out;
}

async function encode(json: string) {
  const gz = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return 'BARKLEY-CRASH-1:' + base64(new Uint8Array(await new Response(gz).arrayBuffer()));
}
