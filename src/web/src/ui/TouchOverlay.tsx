// The touch overlay (extensions/touch.ts has its state and input): the direction control, A, B and START drawn in an
// SVG over the canvas, the settings button and its sheet (with a bug report, which needs a keyboard to type BUG
// otherwise), the layout editor the sheet opens, and the note SET KEYS needs on a device with no keyboard.
import { For, type JSX, Show } from 'solid-js';
import { askReport } from '../extensions/crash';
import {
	BASE_R,
	type Button,
	CONTEXTS,
	cfg,
	ctx,
	dir,
	doneEditing,
	editing,
	editLayout,
	grabbed,
	held,
	KNOB_R,
	type Layout,
	layout,
	live,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	type Part,
	resetLayout,
	restoreDefaultKeys,
	setSheetOpen,
	setting,
	sheetOpen,
	shown,
	THROW,
} from '../extensions/touch';
import { has } from '../page';
import { Backdrop, GameButton, GameDpad, GameGear, GameStick } from './TouchGame';
import './TouchOverlay.css';

export function TouchOverlay() {
	const viewBox = () => {
		const L = layout();
		return L ? `0 0 ${L.W} ${L.H}` : undefined;
	};
	// a context's opacity for the direction control (0) or the buttons (1); the editor shows everything
	const fade = (i: 0 | 1) => (editing() ? 1 : CONTEXTS[ctx()][i]);
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
								<Show
									when={cfg.theme === 'game'}
									fallback={
										<>
											<Show when={editing()}>
												<Scrim L={L()} />
											</Show>
											<g opacity={fade(0)} class="gmt-fade">
												<Show when={cfg.mode === 'dpad'} fallback={<Stick L={L()} />}>
													<Dpad L={L()} />
												</Show>
											</g>
											<g opacity={fade(1)} class="gmt-fade">
												<Gear L={L()} />
												<For each={L().buttons}>{(b) => <TouchButton b={b} />}</For>
											</g>
										</>
									}
								>
									<Backdrop L={L()} />
									<Show when={editing()}>
										<Scrim L={L()} />
									</Show>
									<g opacity={fade(0)} class="gmt-fade">
										<Show when={cfg.mode === 'dpad'} fallback={<GameStick L={L()} />}>
											<GameDpad L={L()} />
										</Show>
									</g>
									<g opacity={fade(1)} class="gmt-fade">
										<GameGear L={L()} />
										<For each={L().buttons}>{(b) => <GameButton b={b} u={L().unit} />}</For>
									</g>
								</Show>
								<Show when={editing()}>
									<Marks L={L()} />
								</Show>
							</Show>
						)}
					</Show>
				</svg>
				<Show when={sheetOpen()}>
					<Sheet />
				</Show>
				<Show when={editing() && layout()}>{(L) => <EditBar L={L()} />}</Show>
				<Show when={ctx() === 4 && live()}>
					<div id="gmtouch-note">
						<p>SET KEYS needs a keyboard: it waits for seven key presses.</p>
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
	const c = () => props.L.dirCenter;
	return (
		<Show
			when={dir.active}
			fallback={
				<Show when={editing()} fallback={<circle cx={c().x} cy={c().y} r={BASE_R} class="gmt-ghost" />}>
					<circle cx={c().x} cy={c().y} r={BASE_R} class="gmt-ring" />
					<circle cx={c().x} cy={c().y} r={KNOB_R} class="gmt-knob" />
				</Show>
			}
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

// The layout editor: the game dimmed, an outline round each control (solid while it is being dragged), and a bar over
// the picture to reset the layout or finish.
function Scrim(props: { L: Layout }) {
	return <rect x={-1} y={-1} width={props.L.W + 2} height={props.L.H + 2} class="gmt-scrim" />;
}
function Marks(props: { L: Layout }) {
	const ring = (part: Part, x: number, y: number, r: number) => (
		<circle cx={x} cy={y} r={r + 6} class="gmt-mark" classList={{ on: !!grabbed[part] }} />
	);
	return (
		<>
			{ring('dir', props.L.dirCenter.x, props.L.dirCenter.y, cfg.mode === 'dpad' ? props.L.dpadR : BASE_R)}
			{ring('gear', props.L.gear.x, props.L.gear.y, props.L.gear.r)}
			<For each={props.L.buttons}>
				{(b) => (
					<Show when={b.pill} fallback={ring(b.k as Part, b.x, b.y, b.r)}>
						<rect
							x={b.x - b.r * 1.7 - 6}
							y={b.y - b.r * 0.75 - 6}
							width={b.r * 3.4 + 12}
							height={b.r * 1.5 + 12}
							class="gmt-mark"
							classList={{ on: !!grabbed[b.k as Part] }}
						/>
					</Show>
				)}
			</For>
		</>
	);
}
function EditBar(props: { L: Layout }) {
	const g = () => props.L.game;
	return (
		<div id="gmtouch-edit" style={{ left: `${g().x + g().w / 2}px`, top: `${g().y + g().h / 2}px` }}>
			<p>Drag the controls to move them.</p>
			<div>
				<button type="button" id="gmtouch-reset" class="gmt-b" onClick={resetLayout}>
					Reset
				</button>
				<button type="button" id="gmtouch-edit-done" class="gmt-b on" onClick={doneEditing}>
					Done
				</button>
			</div>
		</div>
	);
}

// A row of the settings sheet: what it sets, and a segmented choice
function Choice<T extends string | number>(props: {
	label: string;
	options: [string, T][];
	value: T;
	set: (v: T) => void;
}): JSX.Element {
	return (
		<div class="gmt-row">
			<span>{props.label}</span>
			<div class="gmt-seg">
				<For each={props.options}>
					{([name, v]) => (
						<button
							type="button"
							class="gmt-opt"
							data-v={String(v)}
							aria-pressed={props.value === v}
							onClick={() => props.set(v)}
						>
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
			<div class="gmt-rows">
				<Choice
					label="Control"
					options={[
						['Joystick', 'stick'],
						['D-pad', 'dpad'],
					]}
					value={cfg.mode}
					set={(v) => setting('mode', v)}
				/>
				<Choice
					label="Style"
					options={[
						['Plain', 'plain'],
						['Game', 'game'],
					]}
					value={cfg.theme}
					set={(v) => setting('theme', v)}
				/>
				<Choice
					label="Side"
					options={[
						['Left', 'left'],
						['Right', 'right'],
					]}
					value={cfg.side}
					set={(v) => setting('side', v)}
				/>
				{/* iOS has no vibration */}
				<Show when={typeof navigator.vibrate === 'function'}>
					<Choice
						label="Vibration"
						options={[
							['On', 1],
							['Off', 0],
						]}
						value={cfg.haptics}
						set={(v) => setting('haptics', v)}
					/>
				</Show>
				{/* Auto hides them while a gamepad is connected; Off keeps the ≡ button, to bring them back */}
				<Choice
					label="Show"
					options={[
						['Auto', 2],
						['On', 1],
						['Off', 0],
					]}
					value={cfg.enabled}
					set={(v) => setting('enabled', v)}
				/>
			</div>
			<div class="gmt-acts">
				<Show when={live()}>
					<button type="button" id="gmtouch-layout" class="gmt-b" onClick={editLayout}>
						Move controls
					</button>
				</Show>
				<Show when={has('Crash')}>
					<button
						type="button"
						id="gmtouch-bug"
						class="gmt-b"
						onClick={() => {
							setSheetOpen(false);
							askReport();
						}}
					>
						Report a bug
					</button>
				</Show>
			</div>
		</div>
	);
}
