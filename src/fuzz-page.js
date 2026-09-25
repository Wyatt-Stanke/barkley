// In-page harness for fuzz.mjs, injected before the game's scripts load (Page.addScriptToEvaluateOnNewDocument).
// Needs an unobfuscated modernized build (gml_* names, resume_save). fuzz.mjs prepends window.__fuzzNames, the
// runtime's own variable names it found in the build.
//
// - Virtual time: performance.now/Date.now read a virtual clock, requestAnimationFrame callbacks run at the next
//   virtual 60 Hz vsync and timers set during a frame wait for virtual time, so the game steps synchronously, as fast
//   as the CPU allows, and deterministically. The game is delta-timed (oController's global.rendt comes from
//   current_time), so the virtual clock keeps its speed right. Math.random is seeded.
// - Coverage: every gml_* function (object events, scripts, room code) is wrapped to mark itself run in the current room.
// - Novelty: after each input segment the page checks for a new cell (room, plot, battle, player position), a new
//   (room, function) pair and new values of the game's globals, and snapshots the game when it finds one.
// - Snapshots are the game's own resume state (patch modernized/06) plus RNG states and save files; a restore is an
//   in-place game_restart that resumes from it, as after a reload.
(() => {
  const N = window.__fuzzNames;
  const nativeSetTimeout = window.setTimeout.bind(window);
  // A whole number of milliseconds: current_time then advances the same every frame, so the game's frame time
  // (global.rendt) doesn't depend on where a restore left the clock (1000/60 gave 16, 17, 17, ...)
  const VSYNC = 17;
  const KEYS = { up: 38, down: 40, left: 37, right: 39, z: 90, x: 88, c: 67 };
  const F = { frame: 0, crash: null, ended: false, alerts: [] };
  window.__fuzz = F;
  // Every page starts as a first visit: a browser profile keeps the save files and config of earlier pages (replays
  // from a fresh page would otherwise not be fresh). Snapshots carry their own.
  try {
    localStorage.clear();
  } catch {}
  const safe = (f, d = null) => {
    try {
      return f();
    } catch {
      return d;
    }
  };

  // ---- virtual time ----
  let tick = 0,
    vnow = 0,
    inFrame = false,
    raf = [],
    timers = [],
    timerSeq = 0,
    frameCb = null;
  performance.now = () => vnow;
  Date.now = () => 1.7e12 + vnow;
  // Only ever the runtime's frame: the touch overlay's loop that pins the canvas's CSS size and the gamepad's poll are
  // dropped (had one re-registered after the runtime, it became frameCb, and a restart scheduled only it, so the game
  // never ran another frame). The page no longer starts them under the harness; this is for builds from before that.
  const OWN_LOOPS = new Set(['touch_pin', 'pad_poll']);
  window.requestAnimationFrame = (cb) => {
    if (OWN_LOOPS.has(cb.name)) return 0;
    frameCb = cb;
    return raf.push(cb);
  };
  window.webkitRequestAnimationFrame = undefined;
  window.setTimeout = function (fn, ms, ...args) {
    if (!inFrame) return nativeSetTimeout(fn, ms, ...args); // asset loading
    timers.push({ due: vnow + (+ms || 0), seq: ++timerSeq, fn: () => fn(...args) });
    return -timerSeq;
  };
  let seed = 1;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0; // mulberry32
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  window.alert = (m) => F.alerts.push(String(m));
  window.confirm = () => true;
  window.prompt = () => '';

  // One game frame: fire due timers until a frame is requested, then run the frame at the next vsync.
  // Strict, like everything here that calls into the game: yyError walks arguments.callee.caller up the stack, which
  // stops (null) at a strict caller but throws at an arrow function, hiding the game's error.
  function step() {
    'use strict';
    while (!raf.length) {
      if (!timers.length) return false;
      timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const t = timers.shift();
      vnow = Math.max(vnow, t.due);
      inFrame = true;
      try {
        t.fn();
      } finally {
        inFrame = false;
      }
    }
    tick = Math.floor(vnow / VSYNC + 1e-9) + 1;
    vnow = tick * VSYNC;
    const q = raf;
    raf = [];
    inFrame = true;
    try {
      for (const cb of q) cb(vnow);
    } finally {
      inFrame = false;
    }
    return true;
  }
  // Until the game runs, frames are pumped in real time so assets can load. They stop once Game Start has run: how
  // many frames the intro would otherwise get depends on how fast the page loaded (a warm cache), and so would
  // everything after. The runtime's RNG state there is kept for fresh starts (see hook).
  let pumping = true,
    rng0 = null;
  (function pump() {
    if (!pumping) return;
    if (safe(() => F.ready())) {
      pumping = false;
      rng0 = { state: window[N.state].map(Number), b: window[N.b], c: window[N.c] };
      return;
    }
    safe(step);
    nativeSetTimeout(pump, 2);
  })();

  const gml = () => window.global;
  F.ready = () => !!(gml() && gml().gmlrendrate !== undefined);
  const roomName = () => room_get_name(g_pBuiltIn.get_current_room());
  const inst = (name) => GetWithArray(asset_get_index(name))[0];

  // ---- coverage ----
  // Wraps every gml_* function the runtime can reach: globals (direct calls) and JSON_game's references (events,
  // script_execute, room code). Call before GameMaker_Init.
  const fnNames = [],
    fnIds = new Map();
  let seg = new Uint8Array(0),
    segList = [];
  F.instrument = () => {
    const wrap = (fn) => {
      if (fnIds.has(fn)) return fnIds.get(fn);
      const id = fnNames.length;
      fnNames.push(fn.name);
      const w = {
        [fn.name]: function () {
          if (!seg[id]) {
            seg[id] = 1;
            segList.push(id);
          }
          return fn.apply(this, arguments);
        },
      }[fn.name];
      fnIds.set(fn, w).set(w, w);
      return w;
    };
    const isGml = (v) => typeof v === 'function' && /^gml_(Object|Script|Room)_/.test(v.name);
    for (const k of Object.getOwnPropertyNames(window))
      if (/^gml_(Object|Script|Room)_/.test(k) && isGml(window[k])) window[k] = wrap(window[k]);
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (isGml(v)) o[k] = wrap(v);
        else if (v && typeof v === 'object') walk(v);
      }
    })(JSON_game);
    seg = new Uint8Array(fnNames.length);
    return fnNames.length;
  };
  F.fnNames = () => fnNames;

  // ---- input ----
  let held = new Set();
  const ev = (k) => ({
    which: KEYS[k],
    keyCode: KEYS[k],
    key: k.length === 1 ? k : `Arrow${k[0].toUpperCase()}${k.slice(1)}`,
    preventDefault() {},
  });
  const setKeys = (keys) => {
    const next = new Set(keys);
    for (const k of held) if (!next.has(k)) window.onkeyup?.(ev(k));
    for (const k of next) if (!held.has(k)) window.onkeydown?.(ev(k));
    held = next;
  };
  // A key event from a crash report (crash.js): [step, type (0 up, 1 down, 2 blur, 3 focus), key code, key]
  const rawKey = ([, type, which, key]) => {
    if (type > 1) return window.dispatchEvent(new Event(type === 2 ? 'blur' : 'focus'));
    const e = { which, keyCode: which, key, repeat: false, preventDefault() {} };
    (type === 1 ? window.onkeydown : window.onkeyup)?.(e);
  };

  // ---- the game's own functions (declared after this script runs, so replaced once the game runs) ----
  let pending = '',
    hooked = false,
    paths0 = [],
    pathQueue = [];
  // replaying a crash report: resume_tick runs (its checkpoints reseed the random numbers and use up instance ids, as
  // in the recorded game), and crash_step hands the game the recorded frame time
  let reporting = false,
    rendtNext = null;
  const hook = () => {
    if (hooked) return;
    hooked = true;
    pumping = false;
    const realTick = window.gml_Script_resume_tick;
    window.resume_take = () => {
      const s = pending;
      pending = '';
      return s;
    };
    window.resume_put = () => 0; // nothing to keep for a reload
    // resume_restore ends with resume_put(resume_save()), a save for that reload, which the recorded or continuous game
    // didn't make: its instance id mark would be destroyed but not yet removed (the runtime does that near the end of
    // a frame) when the next instance takes that id back, which then can't be found by id
    const realRestore = window.gml_Script_resume_restore,
      realSave = window.gml_Script_resume_save;
    window.gml_Script_resume_restore = function () {
      'use strict';
      window.gml_Script_resume_save = () => '';
      try {
        return realRestore.apply(this, arguments);
      } finally {
        window.gml_Script_resume_save = realSave;
      }
    };
    // Quit Vidcon, Esc
    window.game_end = () => {
      F.ended = true;
    };
    // Game Start makes global.path with path_add, ten more on every restart: every restart gets the first ten back, so
    // every page numbers them alike whatever it ran before (instances' saved path_index are those numbers)
    paths0 = [...(gml().gmlpath ?? [])];
    const realAdd = window.path_add;
    window.path_add = function () {
      return pathQueue.length ? pathQueue.shift() : realAdd.apply(this, arguments);
    };
    // resume_tick without its periodic resume_save (a fifth of the frame time); snapshots are taken here instead.
    window.gml_Script_resume_tick = function () {
      'use strict';
      if (reporting) return realTick.apply(this, arguments);
      if (gml().gmlresume_phase === 3) gml().gmlresume_phase = 0;
    };
    // crash.js records nothing here
    window.crash_put = window.crash_end = window.crash_wanted = () => 0;
    window.crash_step = (r) => {
      const v = rendtNext ?? r;
      rendtNext = null;
      return v;
    };
    // Mouse events: there is no mouse, and the runtime checks every object for them each frame.
    if (N.mouse) window[N.mouse] = () => {};
    // A fresh start, the same on every page: Game Start again from a fixed clock, seeds and instance ids
    timers = [];
    raf = frameCb ? [frameCb] : raf;
    tick = BOOT_TICK;
    vnow = tick * VSYNC;
    seed = 1;
    window[N.ids] = 1000000;
    if (rng0) {
      const s = window[N.state];
      s.length = 0;
      s.push(...rng0.state);
      window[N.b] = rng0.b;
      window[N.c] = rng0.c;
    }
    localStorage.clear();
    pathQueue = [...paths0];
    game_restart();
  };
  const BOOT_TICK = 3e6; // past any frame the loading pump reaches (it steps a frame every 2 ms or so)

  // Drawing on or off. Off, the calls that rasterize do nothing; every other WebGL call still runs, since the runtime
  // caches GL state and creates surfaces as it goes. The fuzzer never looks at the picture.
  const glReal = new Map();
  const noop = () => {};
  F.draw = (on) => {
    for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      if (!glReal.has(P)) {
        const fns = {};
        for (const k of [
          'drawArrays',
          'drawElements',
          'drawArraysInstanced',
          'drawElementsInstanced',
          'drawRangeElements',
          'clear',
        ])
          if (typeof P[k] === 'function') fns[k] = P[k];
        glReal.set(P, fns);
      }
      for (const [k, fn] of Object.entries(glReal.get(P))) P[k] = on ? fn : noop;
    }
  };

  // Stops sound: the runtime mixes it in an AudioWorklet on the real-time audio thread, which in a dozen browsers at
  // once starves the game threads. With the audio clock stopped, sounds keep "playing" where they are.
  F.quiet = () => {
    const a = window.g_WebAudioContext;
    if (!a) return;
    a.suspend();
    a.resume = () => Promise.resolve();
  };

  // ---- snapshots ----
  F.save = function () {
    'use strict';
    const c = inst('oController');
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== 'barkley.resume') ls[k] = localStorage.getItem(k);
    }
    const s = window[N.state];
    const rng = { state: s.map(Number), b: window[N.b], c: window[N.c] };
    // keys latched by key_clear, which resume_save leaves out (a reload starts with every key up)
    const latch = [...(gml().gmlkey_latch ?? [])].flatMap((v, k) => (Number(v) === 1 ? [k] : []));
    // exact direction and speed of what moves: resume_restore sets hspeed and vspeed, and the runtime derives both
    // from them truncated to 6 decimals, so smog that keeps its own direction drifted
    const motion = GetWithArray(-3).flatMap((i) => (i.speed ? [[Number(i.id), i.direction, i.speed]] : []));
    // the runtime's frame pacing, from now: when the next frame is due, and its timer (or a frame already requested).
    // The due time keeps fractions of a millisecond, so at 30 frames a second on the 17 ms vsync every 25th frame or
    // so takes one vsync, not two; which one depends on it. (The only timers the game sets are the pacing's.)
    const pace = N.pace
      ? { due: window[N.pace] - vnow, timers: timers.map((t) => t.due - vnow), raf: raf.length }
      : null;
    return JSON.stringify({ resume: gml_Script_resume_save(c, c), rng, ls, latch, motion, pace, frame: F.frame });
  };
  // The runtime's own field behind a built-in instance variable (its getter returns this.<field>)
  const field = (i, k) => {
    for (let p = i; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d?.get) return /this\.(\w+)/.exec(d.get.toString())?.[1];
    }
  };
  const KEEP = /^gml(resume_|path$|key_latch$|displayx$|displayy$)/;
  // Restore: game_restart runs Game Start again, resume_start takes the state from resume_take and goes to its room,
  // and that room's first Room Start rebuilds the saved instances. Returns null or a crash.
  // A crash report's checkpoint (no rng) also has the keys held then (held) and latched (latch), and the key events
  // and frame time of its own step (first, rendt): the restore's frame runs that step, and F.reportRun plays the
  // steps after it. Instances the restore creates miss that frame's animation, as they do after a reload.
  F.load = function (snap) {
    'use strict';
    const d = JSON.parse(snap);
    const rep = d.rng ? null : d;
    hook();
    setKeys([]);
    reporting = !!rep;
    rendtNext = null;
    if (rep) {
      // held since before the checkpoint: their key press is used up in a frame of the old game
      for (const k of rep.held) rawKey([0, 1, k, '']);
      safe(step);
    }
    F.crash = null;
    F.ended = false;
    localStorage.clear();
    for (const [k, v] of Object.entries(d.ls ?? d.files ?? {})) localStorage.setItem(k, v);
    const saved = JSON.parse(d.resume).globals;
    const g = gml();
    for (const k of Object.keys(g)) if (k.startsWith('gml') && !KEEP.test(k) && !(k.slice(3) in saved)) delete g[k];
    pending = d.resume;
    // The same starting point whatever ran before: no pending timers, instance ids from the start (the restart
    // clears every instance), the same clock phase (current_time is whole milliseconds, so frame times alternate 16
    // and 17 ms) and the same Math.random seed.
    timers = [];
    raf = [frameCb];
    tick = (Math.floor(tick / 3) + 2) * 3;
    vnow = tick * VSYNC;
    seed = 1;
    window[N.ids] = 1000000;
    const surfaces = window[N.surfaces]; // left set by a crash in a Draw event
    while (surfaces?.length) surface_reset_target();
    if (rep) g.gmlresume_phase = 0;
    pathQueue = [...paths0];
    game_restart();
    // resume_start sets phase 1; in the saved room's first frame resume_restore clears resume_data, and the Begin
    // Step right after sets phase 0
    let seen = 0,
      armed = false;
    const done = () => seen && g.gmlresume_phase === 0 && g.gmlresume_data === undefined;
    for (let i = 0; i < 30 && !done(); i++) {
      if (rep && !armed && g.gmlresume_phase === 1) {
        // the next frame restores the checkpoint and runs its step
        armed = true;
        rep.first.forEach(rawKey);
        rendtNext = rep.rendt ?? null;
        const latch = new Array(256).fill(0);
        for (const k of rep.latch.split(' ').filter(Boolean)) latch[+k] = 1;
        g.gmlkey_latch = latch;
      }
      try {
        step();
      } catch (e) {
        F.crash = { kind: 'restore', ...errText(e) };
        return F.crash;
      }
      seen = Math.max(seen, g.gmlresume_phase);
    }
    if (!done()) {
      F.crash = { kind: 'restore', message: `restore did not finish (phase ${g.gmlresume_phase})`, stack: '' };
      return F.crash;
    }
    F.frame = d.frame ?? 0;
    if (rep) return null;
    // The restore's frame also ran a whole step on the rebuilt game (Begin Step to Draw, alarms, animation) with a
    // near-zero frame time, where continuous play goes straight from the saved state to the next step: animations came
    // back a frame ahead, alarms a tick behind, delta-timed counters a little ahead (vou by 0.006). Restoring again,
    // outside a frame and onto the same instances, puts the saved state back, the saved frame time (rendt, rd)
    // included, and destroys what that step created.
    const res = JSON.parse(d.resume);
    try {
      const c = inst('oController');
      g.gmlresume_data = json_parse(c, d.resume); // (self, string)
      gml_Script_resume_restore(c, c);
    } catch (e) {
      F.crash = { kind: 'restore', ...errText(e) };
      return F.crash;
    }
    // It sets what was saved but keeps variables that step created (a follower blocked for that frame set o, zx, zy)
    const vars = new Map(res.instances.map((e) => [e.iid, e.vars]));
    for (const i of GetWithArray(-3)) {
      const v = vars.get(Number(i.id));
      if (v) for (const k of Object.keys(i)) if (k.startsWith('gml') && !(k.slice(3) in v)) delete i[k];
    }
    for (const k of Object.keys(g))
      if (k.startsWith('gml') && !KEEP.test(k) && !(k.slice(3) in res.globals) && typeof g[k] !== 'function')
        delete g[k];
    const byId = new Map(GetWithArray(-3).map((i) => [Number(i.id), i]));
    for (const [id, dir, spd] of d.motion ?? []) {
      const i = byId.get(id);
      if (i) {
        i[field(i, 'direction')] = dir;
        i[field(i, 'speed')] = spd;
      }
    }
    // Instances destroyed outside a frame (what that step created, the restore's mark for the next id) stay in the
    // runtime's id map until the end of the next frame, and removing one then clears the entry for its id even when a
    // new instance has that id by then, as it would after the counter goes back below: remove them now
    if (!N.sweep) {
      F.crash = { kind: 'restore', message: "the runtime's sweep of destroyed instances wasn't found", stack: '' };
      return F.crash;
    }
    window[N.room][N.sweep]();
    // Instance ids go on from the saved counter (that step and the mark used some up), and keys latched
    // when the snapshot was taken stay latched, as in continuous play when the next step holds them again (the
    // restore's frame released them all, since no key was held)
    window[N.ids] = res.nextid;
    const latch = new Array(256).fill(0);
    for (const k of d.latch ?? []) latch[k] = 1;
    g.gmlkey_latch = latch;
    if (d.pace && N.pace) {
      window[N.pace] = vnow + d.pace.due;
      raf = d.pace.raf ? [frameCb] : [];
      timers = d.pace.timers.map((due) => ({ due: vnow + due, seq: ++timerSeq, fn: () => raf.push(frameCb) }));
    }
    const s = window[N.state];
    s.length = 0;
    s.push(...d.rng.state);
    window[N.b] = d.rng.b;
    window[N.c] = d.rng.c;
    for (const id of segList) seg[id] = 0; // what the restore itself ran isn't the program's
    segList = [];
    return null;
  };

  // A JS error, or the runtime's GML error object (gmlmessage, gmlstacktrace)
  const errText = (e) => {
    if (e == null) return { message: String(e), stack: '' };
    const msg = e.gmllongMessage ?? e.gmlmessage ?? e.message ?? safe(() => JSON.stringify(e), String(e));
    const stack = e.gmlstacktrace ?? e.stack ?? '';
    return {
      message: String(msg),
      stack: Array.isArray(stack) ? stack.map((l) => String(l).trim()).join('\n') : String(stack),
    };
  };

  // ---- novelty ----
  // What the fuzzer has already seen, kept in step with fuzz.mjs through each request's sync.
  const known = {
    cells: new Set(),
    cov: new Map(),
    flags: new Set(),
    volatile: new Set(),
    exits: new Set(),
    talked: new Set(),
    graph: new Map(),
  };
  const covOf = (r) => {
    if (!known.cov.has(r)) known.cov.set(r, new Uint8Array(fnNames.length));
    return known.cov.get(r);
  };
  const sync = (s) => {
    if (!s) return;
    for (const c of s.cells ?? []) known.cells.add(c);
    for (const [r, f] of s.cov ?? []) covOf(r)[f] = 1;
    for (const f of s.flags ?? []) known.flags.add(f);
    for (const v of s.volatile ?? []) known.volatile.add(v);
    for (const [from, via, to] of s.exits ?? []) {
      known.exits.add(`${from}|${via}`);
      const e = known.graph.get(from) ?? [];
      if (!e.some(([v, t]) => v === via && t === to)) e.push([via, to]);
      known.graph.set(from, e);
    }
    for (const t of s.talked ?? []) known.talked.add(t);
  };
  F.probe = () => {
    const g = gml();
    const p = safe(() => inst('oBarkley'));
    return {
      room: safe(roomName),
      plot: g.gmlplot ?? null,
      battle: g.gmlbattlers > 0 ? 1 : 0,
      x: p ? Math.round(p.x) : null,
      y: p ? Math.round(p.y) : null,
      frame: F.frame,
    };
  };
  const cellOf = (p) => `${p.room}|${p.plot}|${p.battle}|${p.x == null ? '-' : `${p.x >> 5},${p.y >> 5}`}`;
  // The globals' values as flags: 'name=value', 'name[i]=value', 'name[i][j]=value'
  const flagsNow = (out) => {
    const g = gml();
    const add = (k, v) => {
      if (typeof v === 'number') out.push(`${k}=${+v.toFixed(3)}`);
      else if (typeof v === 'string' || typeof v === 'boolean') out.push(`${k}=${v}`);
    };
    for (const k in g) {
      if (!k.startsWith('gml') || k.startsWith('gml__') || KEEP.test(k)) continue;
      const name = k.slice(3);
      if (known.volatile.has(name)) continue;
      const v = g[k];
      if (!Array.isArray(v)) add(name, v);
      else
        for (let i = 0; i < v.length && i < 256; i++)
          if (!Array.isArray(v[i])) add(`${name}[${i}]`, v[i]);
          else for (let j = 0; j < v[i].length && j < 64; j++) add(`${name}[${i}][${j}]`, v[i][j]);
    }
    out.push(`goal=${goalMask()}`);
    return out;
  };
  // Which of the next plot's conditions (fuzz.mjs goalConds, sent with each episode) hold, as 'plot:bits'
  let goalConds = {};
  const CMPS = {
    equal: (a, b) => a === b,
    notequal: (a, b) => a !== b,
    greater: (a, b) => a > b,
    greaterequal: (a, b) => a >= b,
    less: (a, b) => a < b,
    lessequal: (a, b) => a <= b,
  };
  const goalMask = () => {
    const g = gml(),
      plot = g.gmlplot;
    let bits = '';
    for (const [name, i, op, v] of goalConds[plot + 1] ?? []) {
      const x = i === null ? g[`gml${name}`] : g[`gml${name}`]?.[i];
      bits += typeof x === 'number' && CMPS[op](x, v) ? 1 : 0;
    }
    return `${plot}:${bits}`;
  };

  // What the new game already has, so that isn't news: the cell, the functions it runs, the globals' values.
  F.baseline = function (frames) {
    'use strict';
    for (const id of segList) seg[id] = 0;
    segList = [];
    F.replay({ program: [[[], frames]] });
    const probe = F.probe();
    const out = { cell: cellOf(probe), cov: segList.map((id) => [probe.room, id]), flags: flagsNow([]) };
    sync({ cells: [out.cell], cov: out.cov, flags: out.flags });
    for (const id of segList) seg[id] = 0;
    segList = [];
    return out;
  };

  // ---- generators: closed-loop policies that read the game and yield [keys, frames] chunks ----
  // The episode records the chunks they yield, so what they did replays exactly without them.
  let rng = Math.random;
  const seeded = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const choose = (a) => a[Math.floor(rng() * a.length)];
  const DIRS = ['up', 'down', 'left', 'right'];
  let objParent = null;
  const objName = (i) => safe(() => object_get_name(i.object_index), '');
  const isA = (name, anc) => {
    if (!objParent) {
      objParent = new Map();
      for (const o of JSON_game.GMObjects) if (o) objParent.set(o.pName, JSON_game.GMObjects[o.parent]?.pName);
    }
    for (let n = name, k = 0; n && k < 20; n = objParent.get(n), k++) if (n === anc) return true;
    return false;
  };
  const instances = () => {
    const a = GetWithArray(-3),
      out = [];
    for (const k in a) if (a[k] && !a[k].marked) out.push(a[k]);
    return out;
  };
  const exists = (name) => safe(() => GetWithArray(asset_get_index(name)).length > 0, false);
  const busy = () => {
    const g = gml();
    // a GML flag is true or 1
    const on = (v) => Number(v) === 1;
    return on(g.gmlcinema) || on(g.gmlfreeze) || on(g.gmlmovefreeze) || exists('oDialog') || exists('oStartmenu');
  };
  const bbox = (i) => [i.bbox_left, i.bbox_top, i.bbox_right, i.bbox_bottom];
  const EXIT = /^(oExit\d+|oLDoor\d+|oSubwaydoor)$/;
  const isExit = (i) => EXIT.test(objName(i));
  // Rooms the game sends the player to in the middle of a walk (a random battle, dying): never where a door leads.
  // Recorded as a destination they made the same door seem to lead to two rooms, and loadCorpus drops such doors.
  const INTERRUPTS = new Set(['RomInter', 'RomGameover']);
  // walk-on exits: oExitPar children, and exits with their own collision event with the player (oExit4); the rest need
  // the action key
  let collides = null;
  const byCollision = (i) => {
    collides ??= new Set(fnNames.map((f) => f.match(/^gml_Object_(\w+)_Collision_oBarkley$/)?.[1]).filter(Boolean));
    if (isA(objName(i), 'oExitPar')) return true; // (and fills objParent)
    for (let n = objName(i), k = 0; n && k < 20; n = objParent.get(n), k++) if (collides.has(n)) return true;
    return false;
  };
  const isFollower = (n) => /^oFollower/.test(n);

  // Breadth-first search over an 8 px grid of player positions, around solid instances. goal(x, y, box) says whether
  // a position is a goal and returns what to do there. Returns the path's positions (from the next one on) and the goal.
  const CELL = 8;
  function route(goal, ignore) {
    const p = inst('oBarkley');
    const rm = JSON_game.GMRooms.find((r) => r && r.pName === roomName());
    if (!p || !rm) return null;
    const off = [p.bbox_left - p.x, p.bbox_top - p.y, p.bbox_right - p.x, p.bbox_bottom - p.y];
    const ox = ((p.x % CELL) + CELL) % CELL,
      oy = ((p.y % CELL) + CELL) % CELL;
    const W = Math.ceil(rm.width / CELL) + 1,
      H = Math.ceil(rm.height / CELL) + 1;
    const blocked = new Uint8Array(W * H);
    for (const i of instances()) {
      if (!i.solid || i === p || ignore?.has(i) || isFollower(objName(i))) continue;
      const [l, t, r, b] = bbox(i);
      const x0 = Math.max(0, Math.ceil((l - off[2] - ox) / CELL)),
        x1 = Math.min(W - 1, Math.floor((r - off[0] - ox) / CELL));
      const y0 = Math.max(0, Math.ceil((t - off[3] - oy) / CELL)),
        y1 = Math.min(H - 1, Math.floor((b - off[1] - oy) / CELL));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) blocked[y * W + x] = 1;
    }
    const sx = Math.round((p.x - ox) / CELL),
      sy = Math.round((p.y - oy) / CELL);
    const prev = new Int32Array(W * H).fill(-1);
    const q = [sy * W + sx];
    prev[q[0]] = q[0];
    // q grows as it goes: an array's iterator reads its length on every step
    for (const c of q) {
      const cx = c % W,
        cy = (c / W) | 0;
      const px = cx * CELL + ox,
        py = cy * CELL + oy;
      const g = goal(px, py, [px + off[0], py + off[1], px + off[2], py + off[3]]);
      if (g) {
        const path = [];
        for (let k = c; k !== q[0]; k = prev[k]) path.unshift([(k % W) * CELL + ox, ((k / W) | 0) * CELL + oy]);
        return { path, goal: g };
      }
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx,
          ny = cy + dy,
          n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || blocked[n] || prev[n] !== -1) continue;
        prev[n] = c;
        q.push(n);
      }
    }
    return null;
  }
  // Walks a route; returns why it stopped: 'arrived', 'busy', 'room', 'stuck' or 'budget'.
  function* follow(goal, ignore, budget, sprint) {
    const room = roomName();
    let r = null,
      lastX = null,
      lastY = null,
      still = 0,
      lost = 0;
    for (let t = 0; t < budget; t += 4) {
      if (busy()) return 'busy';
      if (roomName() !== room) return 'room';
      const p = inst('oBarkley');
      if (!p) return 'stuck';
      if (!r || t % 48 === 0) r = route(goal, ignore);
      if (!r) {
        // someone walking may be in the way for a moment
        if (++lost > 3) return 'stuck';
        yield [[choose(DIRS)], 8];
        continue;
      }
      while (r.path.length && Math.abs(r.path[0][0] - p.x) < 2 && Math.abs(r.path[0][1] - p.y) < 2) r.path.shift();
      if (!r.path.length) return 'arrived';
      const [wx, wy] = r.path[Math.min(1, r.path.length - 1)];
      const keys = [];
      if (wx - p.x > 1) keys.push('right');
      if (wx - p.x < -1) keys.push('left');
      if (wy - p.y > 1) keys.push('down');
      if (wy - p.y < -1) keys.push('up');
      if (sprint) keys.push('x');
      still = p.x === lastX && p.y === lastY ? still + 4 : 0;
      [lastX, lastY] = [p.x, p.y];
      if (still >= 24) {
        yield [[choose(DIRS)], 8];
        r = null;
        still = 0;
        continue;
      }
      yield [keys, 4];
    }
    return 'budget';
  }
  // Positions next to an instance's box, facing it
  const beside = (i) => {
    const [l, t, r, b] = bbox(i);
    return (_px, _py, [pl, pt, pr, pb]) => {
      const xo = pl <= r && pr >= l,
        yo = pt <= b && pb >= t;
      // within a grid cell (routes are on an 8 px grid aligned to the player; act() closes the gap)
      if (xo && pb < t && t - pb <= CELL) return 'down';
      if (xo && pt > b && pt - b <= CELL) return 'up';
      if (yo && pr < l && l - pr <= CELL) return 'right';
      if (yo && pl > r && pl - r <= CELL) return 'left';
      return null;
    };
  };
  // Within a few pixels of an instance's box (on it, or where the grid gets closest)
  const near = (i) => {
    const [l, t, r, b] = bbox(i);
    return (_px, _py, [pl, pt, pr, pb]) =>
      Math.max(0, l - pr, pl - r) + Math.max(0, t - pb, pt - b) <= 6 ? 'near' : null;
  };
  // Walks into an instance's box (a walk-on exit): toward its centre until the room changes
  function* into(i) {
    const room = roomName();
    const [l, t, r, b] = bbox(i);
    for (let k = 0; k < 12 && roomName() === room; k++) {
      const p = inst('oBarkley');
      if (!p) return;
      const [pl, pt, pr, pb] = bbox(p);
      const dx = (l + r - pl - pr) / 2,
        dy = (t + b - pt - pb) / 2;
      const keys = [];
      if (dx > 1) keys.push('right');
      if (dx < -1) keys.push('left');
      if (dy > 1) keys.push('down');
      if (dy < -1) keys.push('up');
      yield [keys.length ? keys : [choose(DIRS)], 4];
    }
  }
  function* act(dir) {
    yield [[dir], 5];
    yield [['z'], 2];
    yield [[], 6];
  }
  const G = {
    // Presses action through dialog and cutscenes until the player can move again
    *dialog(a) {
      for (let k = 0; k < 6 && exists('oStartmenu'); k++)
        yield* [
          [['x'], 2],
          [[], 6],
        ];
      // Some cutscenes offer themselves to be skipped (global.skipper). Start twice runs oController's User Event 0,
      // which jumps straight to the story's next room: 23 of the game's transitions go through that table, and the
      // branch it takes there (sPos('load'), room_restart, sOvar) is hardly played any other way. The two presses need
      // a release between them - the first is swallowed by key_clear and only arms the skip (global.skip=0.5).
      const trySkip = rng() < 0.3;
      let skipped = false;
      for (let t = 0; t < a.n && busy() && !exists('oStartmenu'); t += 10) {
        if (trySkip && !skipped && gml().gmlskipper > 0) {
          skipped = true;
          yield [['c'], 2];
          yield [[], 6];
          yield [['c'], 2];
          yield [[], 10];
          continue;
        }
        if (rng() < 0.08) yield [[choose(['up', 'down'])], 2];
        yield [['z'], 2];
        yield [[], 8];
      }
    },
    // Walks to an exit (one not taken from this room yet, if there is one) and takes it
    *exit(a) {
      const room = roomName();
      const all = instances().filter(isExit);
      if (!all.length) return;
      const ok = all.filter((i) => !a.avoid?.has(objName(i)));
      const pool = ok.length ? ok : all;
      const fresh = pool.filter((i) => !known.exits.has(`${room}|${objName(i)}`));
      const via = a.via && all.find((i) => objName(i) === a.via);
      const e = via ?? (fresh.length && rng() < 0.8 ? choose(fresh) : choose(pool));
      const name = objName(e);
      a.avoid?.add(name);
      const same = new Set(all.filter((i) => objName(i) === name)); // a door can be several instances
      const coll = byCollision(e);
      // the player's box before each chunk in this room: on the way the player may walk onto another exit, and the
      // exit taken is the one nearest to where the player last was
      let box = null;
      const track = function* (gen) {
        let r = gen.next();
        while (!r.done) {
          const p = roomName() === room && inst('oBarkley');
          if (p) box = bbox(p);
          yield r.value;
          r = gen.next();
        }
        return r.value;
      };
      const why = yield* track(follow(coll ? near(e) : beside(e), same, a.n, rng() < 0.5));
      if (why === 'arrived' && !coll) {
        const r = route(beside(e), same);
        yield* track(act(r?.goal ?? 'up'));
      } else if (why === 'arrived') yield* track(into(e));
      yield* track(
        (function* () {
          for (let t = 0; t < 120 && roomName() === room; t += 10) yield [[], 10];
        })(),
      );
      if (roomName() !== room && !INTERRUPTS.has(roomName())) {
        const gap = (i) => {
          const [l, t, r, b] = bbox(i);
          return box ? Math.max(0, l - box[2], box[0] - r) + Math.max(0, t - box[3], box[1] - b) : 0;
        };
        const taken = box ? objName(all.reduce((m, i) => (gap(i) < gap(m) ? i : m))) : name;
        episodeOut.exits.push([room, taken, roomName()]);
        known.exits.add(`${room}|${taken}`);
        const e = known.graph.get(room) ?? [];
        if (!e.some(([v, t]) => v === taken && t === roomName())) known.graph.set(room, [...e, [taken, roomName()]]);
      }
      yield* G.dialog({ n: 300 });
    },
    // Walks up to something the player can use (a person, a sign, a pump...) and presses action
    *talk(a) {
      // what someone says can change with the story arrays (scheme[3] after talking to Larry), not only the plot
      const room = roomName(),
        plot = goalMask().replace(':', '.');
      const p = inst('oBarkley');
      const all = instances().filter((i) => {
        const n = objName(i);
        return i !== p && i.visible && isA(n, 'oItem') && !isExit(i) && !isFollower(n) && n !== 'oBarkley';
      });
      if (!all.length) return;
      const key = (i) => `${room}|${plot}|${objName(i)}`;
      const fresh = all.filter((i) => !known.talked.has(key(i)));
      const e = fresh.length && rng() < 0.8 ? choose(fresh) : choose(all);
      if ((yield* follow(beside(e), new Set([e]), a.n, rng() < 0.3)) !== 'arrived') return;
      const r = route(beside(e), new Set([e]));
      yield* act(r?.goal ?? 'up');
      if (busy()) {
        episodeOut.talked.push(key(e));
        known.talked.add(key(e));
      }
      yield* G.dialog({ n: 900 });
    },
    // Walks to a reachable spot the fuzzer hasn't been to
    *seek(a) {
      const p0 = F.probe();
      const k = (x, y) => `${p0.room}|${p0.plot}|${p0.battle}|${x >> 5},${y >> 5}`;
      const r = route((x, y) => !known.cells.has(k(x, y)) && rng() < 0.05 && 'new');
      if (!r) return;
      const [tx, ty] = r.path.at(-1) ?? [0, 0];
      yield* follow((x, y) => (Math.abs(x - tx) < 4 && Math.abs(y - ty) < 4 ? 'there' : null), null, a.n, rng() < 0.5);
    },
    // Heads for another room: through a known exit toward a.to (the story's next room), or any exit
    *travel(a) {
      const start = F.frame;
      let avoid0 = null;
      for (let hops = 0, fails = 0; hops < 8 && fails < 3 && F.frame - start < a.n && roomName() !== a.to; ) {
        const room = roomName();
        // after a failed try, another exit (the route's may be out of reach)
        if (!fails) avoid0 = new Set();
        const avoid = avoid0;
        const via = a.to && !fails ? nextHop(room, a.to) : null;
        yield* G.exit({ ...a, n: Math.min(900, a.n - (F.frame - start)), via, avoid });
        if (roomName() === room) fails++;
        else {
          hops++;
          fails = 0;
        }
      }
    },
    // In a battle: action, cancel and the arrows, with the rhythm menus and combos take
    *battle(a) {
      for (let t = 0; t < a.n; t += 12) {
        const r = rng();
        if (r < 0.55) yield [['z'], 2];
        else if (r < 0.7) yield [[choose(DIRS)], 2];
        else if (r < 0.8) yield [[choose(DIRS), 'z'], 2];
        else if (r < 0.87) yield [['x'], 2];
        yield [[], 10];
      }
    },
  };
  // First exit on the shortest known route between two rooms
  const nextHop = (from, to) => {
    const prev = new Map([[from, null]]);
    const q = [from];
    for (const r of q) {
      for (const [via, dest] of known.graph.get(r) ?? []) {
        if (prev.has(dest)) continue;
        prev.set(dest, [r, via]);
        if (dest === to) {
          let hop = null;
          for (let r = to; prev.get(r); r = prev.get(r)[0]) hop = prev.get(r)[1];
          return hop;
        }
        q.push(dest);
      }
    }
    return null;
  };

  // Where the story moves on: for each plot value some object's code sets, the rooms that place that object, and the
  // comparisons of globals with constants in its code (conds: [name, index or null, op, value]), e.g. plot 3 needs
  // scheme[0]>=2 and scheme[3]=1.
  F.goals = () => {
    const out = {},
      conds = {};
    const CMP =
      /yyf(equal|notequal|greater|greaterequal|less|lessequal)\(global\.gml(\w+)(?:\[__yy_gml_array_check_index\((\d+),[^\]]*\])?,(-?[\d.]+)\)/g;
    const byObj = new Map();
    for (const [fn] of fnIds) if (/^gml_Object_/.test(fn.name) && fnIds.get(fn) !== fn) byObj.set(fn.name, fn);
    for (const [fn] of fnIds) {
      if (!/^gml_Object_/.test(fn.name) || fnIds.get(fn) === fn) continue;
      for (const m of fn.toString().matchAll(/global\.gmlplot=(\d+)/g)) {
        const obj = JSON_game.GMObjects.find(
          (o) => o && fn.name.startsWith(`gml_Object_${o.pName}_`) && /^[A-Z]/.test(fn.name.slice(12 + o.pName.length)),
        );
        if (!obj) continue;
        const id = JSON_game.GMObjects.indexOf(obj);
        for (const r of JSON_game.GMRooms)
          if (r?.pInstances?.some((i) => i.index === id)) {
            out[m[1]] ??= [];
            out[m[1]].push(r.pName);
          }
        for (const [name, f] of byObj)
          if (name.startsWith(`gml_Object_${obj.pName}_`))
            for (const c of f.toString().matchAll(CMP))
              if (c[2] !== 'plot') {
                conds[m[1]] ??= [];
                conds[m[1]].push([c[2], c[3] === undefined ? null : +c[3], c[1], +c[4]]);
              }
      }
    }
    for (const k in out) out[k] = [...new Set(out[k])];
    for (const k in conds) conds[k] = [...new Map(conds[k].map((c) => [c.join(), c])).values()];
    return { rooms: out, conds };
  };

  // Known crash classes patched so the search can go on past them (fuzz.mjs --through): a number drawn as text,
  // and real() of a string that isn't a number (GM6 gave 0; a handle's string gives its asset or instance number).
  // Each patched spot is reported (patched, with the error it would have thrown), so it is still a finding.
  const patched = (e) => {
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

  // ---- an episode ----
  // req: { snap (restore it first; none: go on from here), program, sync, maxSnaps (default all), flags, seed }
  // program items: [keys, frames], or {g: generator name, n: frame budget, ...arguments}.
  // Runs the program and returns what ran (rec: the chunks, as a plain program), what was new at each checked chunk
  // boundary, with a snapshot there, the exits taken and the things talked to.
  let episodeOut = null;
  F.episode = function (req) {
    'use strict';
    hook();
    sync(req.sync);
    if (req.goals) goalConds = req.goals;
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
    rng = seeded(req.seed ?? 1);
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
      segList = [];
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
          segList = [];
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
      try {
        for (const [keys, n] of G[item.g](item)) {
          ok = run(keys, n, item.g);
          if (!ok) break;
        }
      } catch (e) {
        // a generator's own bug, not the game's: note it and go on
        out.genError = `${item.g}: ${e?.stack}`;
      }
      if (!ok) break;
    }
    if (!out.crash) setKeys([]);
    episodeOut = null;
    return out;
  };

  // For replays: the same program, a snapshot after each segment listed in saveAt (counted from 1), the game state at
  // a crash, and with drawLast, drawing on for the last frame (for a screenshot).
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
    if (!out.crash) setKeys([]);
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
      rendtNext = req.steps[i] ?? null;
      if (req.drawLast && i === req.to - 1) F.draw(true);
      try {
        step();
      } catch (e) {
        out.crash = { kind: 'exception', ...errText(e), probe: safe(F.probe), step: i };
      }
      rendtNext = null;
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
})();
