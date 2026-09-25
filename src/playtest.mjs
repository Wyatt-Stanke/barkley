#!/usr/bin/env node
// Real-time smoke test of an HTML5 build in headless Chromium over the DevTools protocol (no npm packages).
//
//   node src/playtest.mjs <build dir with index.html> <output dir> [steps]
//
// steps is a comma list of wait:<ms>, key:<Z|X|Enter|Space|Escape|ArrowUp|...>, shot:<label>, js:<file> (evaluates
// the file's JavaScript in the page and logs the result; with an unobfuscated build it can call gml_Script_* functions),
// and the touch steps tap:<x>x<y>, hold:<x>x<y>@<ms> and drag:<x1>x<y1>><x2>x<y2>[@<ms>]. Steps are comma
// separated, so touch coordinates use x and @ rather than commas.
// Screenshots land in <output dir>/<label>.png, console output and exceptions in <output dir>/console.txt.
// The game's keys: Z action, X cancel, arrows (a modernized build also takes W/A/S/D, J and K). The page is opened with
// ?nosw, which keeps the service worker out of the run; SW=1 leaves it in, to test offline play. CHROME overrides the
// browser binary; SIZE=<w>x<h> the window
// (default 1024x768). DEVICE=<w>x<h>[@<dpr>] emulates a phone instead (touch events, mobile viewport), which is what
// the touch overlay of patch modernized/09 needs. The browser is muted unless AUDIO=1.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chrome as browserPath } from './toolchain.mjs';

const [root, out, steps = 'wait:14000,shot:title'] = process.argv.slice(2);
if (!out) {
  console.error('usage: node playtest.mjs <build dir> <output dir> [steps]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const chromePath = browserPath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTTP = 'http://127.0.0.1:8766';

const server = spawn('python3', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const chrome = spawn(
  chromePath,
  [
    '--no-sandbox',
    '--remote-debugging-port=9333',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    ...(process.env.AUDIO === '1' ? [] : ['--mute-audio']),
    `--window-size=${(process.env.SIZE ?? '1024x768').replace('x', ',')}`,
    `--user-data-dir=${path.resolve(out, 'profile')}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  chrome.kill();
  server.kill();
});
for (const s of ['SIGTERM', 'SIGINT', 'SIGALRM']) process.on(s, () => process.exit(1)); // still runs the exit cleanup

const poll = async (fn) => {
  for (let i = 0; i < 50; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timed out waiting for the web server or browser');
};
await poll(() => fetch(`${HTTP}/index.html`).then((r) => r.ok));
const page = await poll(async () =>
  (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page'),
);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const log = [];
const t0 = Date.now();
const note = (kind, text) => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${kind}: ${text}`);
const pending = new Map();
let id = 0;
const send = (method, params = {}) =>
  new Promise((r) => {
    pending.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    // Skip asset loading chatter. (A 404 for BarkleyLTS.js in the log is its missing source map.)
    if (!/^(Loading: |ImageLoaded: |Audio_SoundReadyStateChange)/.test(text)) note(m.params.type, text);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    note('EXCEPTION', `${d.exception?.description ?? d.text} @${d.url}:${d.lineNumber}`);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level !== 'verbose') {
    note(`log.${m.params.entry.level}`, `${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// DEVICE=<w>x<h>[@dpr] makes the page think it is a phone, so the touch overlay comes up and the DPR fix bites.
const device = process.env.DEVICE?.match(/^(\d+)x(\d+)(?:@([\d.]+))?$/);
if (process.env.DEVICE && !device) throw new Error('DEVICE must look like 390x844 or 390x844@3');
if (device) {
  const [, w, h, dpr] = device;
  await send('Emulation.setDeviceMetricsOverride', {
    width: +w,
    height: +h,
    deviceScaleFactor: +(dpr ?? 1),
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
}
// ?nosw keeps the service worker out of a play-test: it would cache the whole build from the little python
// server on every run. SW=1 leaves it in, to test offline play itself.
await send('Page.navigate', { url: `${HTTP}/index.html${process.env.SW === '1' ? '' : '?nosw=1'}` });
// Builds from import.mjs wait for a click on their Start button (enabled once the game code loads); older builds have none.
for (let i = 0; i < 50; i++) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(b => b ? !b.disabled && (b.click(), true) : document.readyState === 'complete')(document.getElementById('start'))`,
    userGesture: true,
  });
  if (result.result.value === true) break;
  await sleep(200);
}

const KEYCODES = { Enter: 13, Space: 32, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
for (const step of steps.split(',')) {
  const [op, arg] = step.split(':');
  if (op === 'wait') await sleep(+arg);
  else if (op === 'shot') {
    const { result } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(out, `${arg}.png`), Buffer.from(result.data, 'base64'));
    note('shot', arg);
  } else if (op === 'key') {
    const letter = arg.length === 1;
    const key = { key: letter ? arg : arg === 'Space' ? ' ' : arg, code: letter ? `Key${arg.toUpperCase()}` : arg };
    const windowsVirtualKeyCode = KEYCODES[arg] ?? arg.toUpperCase().charCodeAt(0);
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, ...key, windowsVirtualKeyCode });
      await sleep(80);
    }
    note('key', arg);
  } else if (op === 'tap' || op === 'hold' || op === 'drag') {
    if (!device) throw new Error(`${op} needs DEVICE=<w>x<h> so touch events are enabled`);
    const point = (t) => {
      const m = t.match(/^(\d+)x(\d+)$/);
      if (!m) throw new Error(`bad touch point "${t}" in ${step}`);
      return { x: +m[1], y: +m[2] };
    };
    const [spec, msText] = arg.split('@');
    const ms = +(msText ?? (op === 'drag' ? 500 : 150));
    const [fromText, toText] = spec.split('>');
    const from = point(fromText),
      to = toText ? point(toText) : from;
    const touch = (type, p) =>
      send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y, id: 1 }],
      });
    await touch('touchStart', from);
    const frames = op === 'drag' ? Math.max(2, Math.round(ms / 40)) : 1;
    for (let i = 1; i <= frames; i++) {
      await sleep(ms / frames);
      await touch('touchMove', {
        x: Math.round(from.x + ((to.x - from.x) * i) / frames),
        y: Math.round(from.y + ((to.y - from.y) * i) / frames),
      });
    }
    await touch('touchEnd', to);
    note(op, arg);
  } else if (op === 'js') {
    const { result } = await send('Runtime.evaluate', {
      expression: readFileSync(arg, 'utf8'),
      returnByValue: true,
      awaitPromise: true,
    });
    const r = result.exceptionDetails?.exception?.description ?? result.result.value ?? result.result.description;
    note('js', `${arg}: ${typeof r === 'string' ? r : JSON.stringify(r)}`);
  } else throw new Error(`unknown step ${step}`);
  writeFileSync(path.join(out, 'console.txt'), `${log.join('\n')}\n`); // after every step, in case a later one hangs
}
console.log(log.join('\n'));
process.exit(log.some((l) => /EXCEPTION|Unhandled Exception/.test(l)) ? 1 : 0);
