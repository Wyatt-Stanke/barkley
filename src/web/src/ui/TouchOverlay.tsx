// The touch overlay (extensions/touch.ts has its state and input): the direction control, A, B and START drawn in an
// SVG over the canvas, the settings button and its sheet, and the note SET KEYS needs on a device with no keyboard.
import { For, type JSX, Show } from 'solid-js';
import {
  BASE_R,
  type Button,
  CONTEXTS,
  cfg,
  ctx,
  dir,
  held,
  KNOB_R,
  type Layout,
  layout,
  live,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  restoreDefaultKeys,
  setSheetOpen,
  setting,
  sheetOpen,
  shown,
  THROW,
} from '../extensions/touch';
import './TouchOverlay.css';

export function TouchOverlay() {
  const viewBox = () => {
    const L = layout();
    return L ? `0 0 ${L.W} ${L.H}` : undefined;
  };
  return (
    <Show when={shown()}>
      <div id="gmtouch">
        <div
          id="gmtouch-hit"
          on:pointerdown={onPointerDown}
          on:pointermove={onPointerMove}
          on:pointerup={onPointerUp}
          on:pointercancel={onPointerUp}
        />
        {/* A picture of the controls; the hit layer above takes the input */}
        <svg viewBox={viewBox()} aria-hidden="true">
          <Show when={ctx() !== 4 && layout()}>
            {(L) => (
              <Show
                when={live()}
                fallback={
                  // controls off: the settings button alone, faint
                  <g opacity={0.6}>
                    <Gear L={L()} />
                  </g>
                }
              >
                <g opacity={CONTEXTS[ctx()][0]} class="gmt-fade">
                  <Show when={cfg.mode === 'dpad'} fallback={<Stick L={L()} />}>
                    <Dpad L={L()} />
                  </Show>
                </g>
                <g opacity={CONTEXTS[ctx()][1]} class="gmt-fade">
                  <Gear L={L()} />
                  <For each={L().buttons}>{(b) => <TouchButton b={b} />}</For>
                </g>
              </Show>
            )}
          </Show>
        </svg>
        <Show when={sheetOpen()}>
          <Sheet />
        </Show>
        <Show when={ctx() === 4 && live()}>
          <div id="gmtouch-note">
            <p>SET KEYS needs a keyboard. It records the next seven keys you press and has no cancel.</p>
            <button type="button" class="ui-btn primary" onClick={restoreDefaultKeys}>
              Restore default keys
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function TouchButton(props: { b: Button }) {
  const b = props.b;
  const on = () => !!held[b.k];
  const w = b.r * 3.4,
    h = b.r * 1.5;
  return (
    <>
      <Show when={b.pill} fallback={<circle cx={b.x} cy={b.y} r={b.r} class="gmt-btn" classList={{ on: on() }} />}>
        <rect x={b.x - w / 2} y={b.y - h / 2} width={w} height={h} class="gmt-btn" classList={{ on: on() }} />
      </Show>
      <text
        x={b.x}
        y={b.y}
        class="gmt-label"
        classList={{ on: on() }}
        font-size={String(b.pill ? 10 : b.r > 32 ? 16 : 14)}
      >
        {b.label}
      </text>
    </>
  );
}

function Gear(props: { L: Layout }) {
  const g = () => props.L.gear;
  const icon = () => {
    const x = g().x - 6,
      y = g().y;
    return `M${x} ${y - 4}h12M${x} ${y}h12M${x} ${y + 4}h12`;
  };
  return (
    <>
      <circle cx={g().x} cy={g().y} r={g().r} class="gmt-gear" />
      <path class="gmt-icon" d={icon()} />
    </>
  );
}

function Stick(props: { L: Layout }) {
  // A thumb in the inset (beside the island) steers from where it is, but the stick is drawn inside the safe area.
  const base = () => {
    const S = props.L.safe,
      m = BASE_R + 4;
    return {
      x: Math.max(S.x + m, Math.min(S.x + S.w - m, dir.bx)),
      y: Math.max(S.y + m, Math.min(S.y + S.h - m, dir.by)),
    };
  };
  const knob = () => {
    let dx = dir.tx - dir.bx,
      dy = dir.ty - dir.by;
    const len = Math.hypot(dx, dy);
    if (len > THROW) {
      dx = (dx / len) * THROW;
      dy = (dy / len) * THROW;
    }
    return { x: base().x + dx, y: base().y + dy };
  };
  return (
    <Show
      when={dir.active}
      fallback={<circle cx={props.L.dirCenter.x} cy={props.L.dirCenter.y} r={BASE_R} class="gmt-ghost" />}
    >
      <circle cx={base().x} cy={base().y} r={BASE_R} class="gmt-ring" />
      <circle cx={knob().x} cy={knob().y} r={KNOB_R} class="gmt-knob" classList={{ on: !!dir.sector }} />
    </Show>
  );
}

// One rounded 12-gon. Two overlapping translucent rects would composite where they cross and show a lighter square
// in the middle.
function cross(cx: number, cy: number, L: number, w2: number, r: number) {
  // biome-ignore format: laid out by hand
  const V = [[-w2,-L],[w2,-L],[w2,-w2],[L,-w2],[L,w2],[w2,w2],[w2,L],[-w2,L],[-w2,w2],[-L,w2],[-L,-w2],[-w2,-w2]];
  let d = '';
  for (let i = 0; i < 12; i++) {
    const p = V[(i + 11) % 12],
      v = V[i],
      n = V[(i + 1) % 12];
    const e1 = Math.hypot(p[0] - v[0], p[1] - v[1]),
      e2 = Math.hypot(n[0] - v[0], n[1] - v[1]);
    const d1 = [(p[0] - v[0]) / e1, (p[1] - v[1]) / e1],
      d2 = [(n[0] - v[0]) / e2, (n[1] - v[1]) / e2];
    const rr = Math.min(r, e1 / 2, e2 / 2);
    const a = [cx + v[0] + d1[0] * rr, cy + v[1] + d1[1] * rr],
      b = [cx + v[0] + d2[0] * rr, cy + v[1] + d2[1] * rr];
    const sweep = d1[0] * d2[1] - d1[1] * d2[0] < 0 ? 1 : 0; // convex corners bulge outward
    d += `${i === 0 ? 'M' : 'L'}${a[0].toFixed(2)} ${a[1].toFixed(2)}`;
    d += `A${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 ${sweep} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

function Dpad(props: { L: Layout }) {
  const c = () => props.L.dirCenter,
    R = () => props.L.dpadR;
  const arm = () => R() * 0.92,
    w = () => R() * 0.68,
    r = () => w() * 0.08;
  // the lit arms of the sector held: [x, y, width, height]
  const lit = () => {
    const s = dir.sector,
      { x: cx, y: cy } = c(),
      a = arm(),
      ww = w(),
      rr = r(),
      out: number[][] = [];
    if (!s) return out;
    if (s.includes('up')) out.push([cx - ww / 2 + 2, cy - a + 2, ww - 4, a - ww / 2 + rr - 2]);
    if (s.includes('down')) out.push([cx - ww / 2 + 2, cy + ww / 2 - rr, ww - 4, a - ww / 2 + rr - 2]);
    if (s.includes('left')) out.push([cx - a + 2, cy - ww / 2 + 2, a - ww / 2 + rr - 2, ww - 4]);
    if (s.includes('right')) out.push([cx + ww / 2 - rr, cy - ww / 2 + 2, a - ww / 2 + rr - 2, ww - 4]);
    return out;
  };
  const ticks = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  return (
    <>
      <path d={cross(c().x, c().y, arm(), w() / 2, r())} class="gmt-dpad" />
      <For each={lit()}>{(q) => <rect x={q[0]} y={q[1]} width={q[2]} height={q[3]} rx={r()} class="gmt-arm" />}</For>
      <For each={ticks}>
        {(t) => <circle cx={c().x + t[0] * (arm() - 13)} cy={c().y + t[1] * (arm() - 13)} r={2} class="gmt-tick" />}
      </For>
    </>
  );
}

// A row of the settings sheet: what it sets, and a segmented choice
function Choice<T extends string | number>(props: {
  label: string;
  hint?: string;
  options: [string, T][];
  value: T;
  set: (v: T) => void;
}): JSX.Element {
  return (
    <div class="gmt-row">
      <div class="gmt-cell">
        <div class="gmt-lab">{props.label}</div>
        <Show when={props.hint}>
          <div class="gmt-hint">{props.hint}</div>
        </Show>
      </div>
      <div class="gmt-seg">
        <For each={props.options}>
          {([name, v]) => (
            <button type="button" data-v={String(v)} aria-pressed={props.value === v} onClick={() => props.set(v)}>
              {name}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function Sheet() {
  return (
    <div id="gmtouch-sheet">
      <div class="gmt-head">
        <h3>Touch controls</h3>
        <button type="button" id="gmtouch-done" class="ui-link" onClick={() => setSheetOpen(false)}>
          Done
        </button>
      </div>
      <Choice
        label="Control"
        hint="Joystick follows your thumb. D-pad stays put."
        options={[
          ['Joystick', 'stick'],
          ['D-pad', 'dpad'],
        ]}
        value={cfg.mode}
        set={(v) => setting('mode', v)}
      />
      <Choice
        label="Side"
        options={[
          ['Right', 'right'],
          ['Left', 'left'],
        ]}
        value={cfg.side}
        set={(v) => setting('side', v)}
      />
      <Choice
        label="Vibration"
        options={[
          ['On', 1],
          ['Off', 0],
        ]}
        value={cfg.haptics}
        set={(v) => setting('haptics', v)}
      />
      <Choice
        label="Show controls"
        hint="Auto hides them for a gamepad. Off keeps the ≡ button, to bring them back."
        options={[
          ['Auto', 2],
          ['On', 1],
          ['Off', 0],
        ]}
        value={cfg.enabled}
        set={(v) => setting('enabled', v)}
      />
    </div>
  );
}
