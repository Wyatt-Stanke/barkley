// The touch overlay's Game style: the controls drawn as the game's menu boxes, at the game's own pixel size, on a blue
// screen with a white pixel border round the picture. Every shape is a grid of game pixels (one cell is Layout.unit, a
// whole number of device pixels), framed as the menu sprites are (sStartConfig, sTitle0): a grey pixel, two brown,
// then the fill. Labels are the menu font's (Courier8, GZFruit) own bitmaps.
import { createMemo, For, Show } from 'solid-js';
import { BASE_R, type Button, dir, editing, held, KNOB_R, type Layout, THROW } from '../extensions/touch';

// The menus' navy: the title menu, save boxes, game over and the battle HUD all fill with it (only the three
// Configuration boxes use #000080). The controls share it and stand out by their frames, as the menus do.
const SCREEN = '#000040',
	FILL = '#000040',
	FRAME = ['#9e9e9e', '#734b21', '#5a3818'],
	LIT = '#ffffff',
	ROUND = 2, // circles are drawn in cells of this many game pixels: finer, their steps read as smoothing
	INK = '#ffffff',
	SHADOW = '#000000';

// ---- pixel grids

interface Grid {
	w: number;
	h: number;
	on: Uint8Array;
}
function grid(w: number, h: number, f: (i: number, j: number) => boolean): Grid {
	const on = new Uint8Array(w * h);
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) on[j * w + i] = f(i, j) ? 1 : 0;
	return { w, h, on };
}
const at = (g: Grid, i: number, j: number) => i >= 0 && j >= 0 && i < g.w && j < g.h && g.on[j * g.w + i] === 1;
// One pixel in from the edge (4-neighbour), which is how the menu frame steps in: its corners stay square
function erode(g: Grid) {
	return grid(
		g.w,
		g.h,
		(i, j) => at(g, i, j) && at(g, i - 1, j) && at(g, i + 1, j) && at(g, i, j - 1) && at(g, i, j + 1),
	);
}
// A path of the grid's cells, a rectangle per horizontal run, its top-left at (x, y) in CSS pixels
function cells(g: Grid, x: number, y: number, u: number) {
	let d = '';
	for (let j = 0; j < g.h; j++)
		for (let i = 0; i < g.w; ) {
			if (!at(g, i, j)) {
				i++;
				continue;
			}
			let e = i;
			while (at(g, e, j)) e++;
			d += `M${x + i * u} ${y + j * u}h${(e - i) * u}v${u}h${-(e - i) * u}z`;
			i = e;
		}
	return d;
}
// A framed circle of radius r CSS pixels, centred on (cx, cy), in ROUND-sized cells
const round = (r: number, cx: number, cy: number, u: number) =>
	place(disc(Math.max(4, Math.round(r / (ROUND * u)))), cx, cy, ROUND * u);
const disc = (r: number) =>
	grid(2 * r, 2 * r, (i, j) => (i + 0.5 - r) ** 2 + (j + 0.5 - r) ** 2 <= r * r - 0.5 * r + 0.3);
// a menu box: the corner pixel is left out, as in the sprites
const box = (w: number, h: number) => grid(w, h, (i, j) => !((i === 0 || i === w - 1) && (j === 0 || j === h - 1)));
const cross = (n: number, a: number) => {
	const lo = (n - a) / 2,
		hi = lo + a;
	return grid(n, n, (i, j) => {
		const v = i >= lo && i < hi,
			h = j >= lo && j < hi;
		if (!(v || h)) return false;
		// the arm ends lose their corner pixels, like a box's
		const end = (k: number) => k === 0 || k === n - 1;
		return !((end(i) && (j === lo || j === hi - 1)) || (end(j) && (i === lo || i === hi - 1)));
	});
};

// The frame's layers, then the fill: what a framed shape draws, outermost first
function framed(g: Grid) {
	const out = [g];
	for (let k = 0; k < 3; k++) out.push(erode(out[k]));
	return out;
}

// ---- the menu font

// Rows 2-8 of each glyph's 12 (the cap height), with its draw offset and advance, from Courier8.font.gmx and its PNG
// biome-ignore format: bitmaps
const GLYPHS: Record<string, [number, number, string[]]> = {
	A: [0, 6, ['...#....', '..#.#...', '..#.#...', '.#...#..', '.#####..', '.#...#..', '#.....#.']],
	B: [1, 6, ['###..', '#..#.', '#..#.', '####.', '#..#.', '#..#.', '###..']],
	S: [1, 6, ['.##..', '#..#.', '#....', '.##..', '...#.', '#..#.', '.##..']],
	T: [0, 5, ['#####.', '..#...', '..#...', '..#...', '..#...', '..#...', '..#...']],
	R: [1, 7, ['####...', '#...#..', '#...#..', '####...', '#..#...', '#...#..', '#...#..']],
};
// The text's ink, one cell per font pixel, with its width
function text(s: string) {
	const ink: [number, number][] = [];
	let pen = 0;
	for (const ch of s) {
		const [off, adv, rows] = GLYPHS[ch];
		rows.forEach((row, j) => {
			for (let i = 0; i < row.length; i++) if (row[i] === '#') ink.push([pen + off + i, j]);
		});
		pen += adv;
	}
	const x0 = Math.min(...ink.map((p) => p[0])),
		x1 = Math.max(...ink.map((p) => p[0]));
	const w = x1 - x0 + 1;
	const g = grid(w, 7, () => false);
	for (const [i, j] of ink) g.on[j * w + i - x0] = 1;
	return g;
}

// ---- drawing

const snap = (v: number, r: number) => Math.round(v * r) / r;
const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1)); // as touch_dpr
// how many game pixels to a font pixel, for a cap height of about target CSS pixels
const scale = (u: number, target: number) => Math.max(1, Math.round(target / (7 * u)));

// A framed shape centred on (cx, cy): its paths, outermost first, and where its top-left landed
function place(g: Grid, cx: number, cy: number, u: number) {
	const x = snap(cx - (g.w * u) / 2, dpr()),
		y = snap(cy - (g.h * u) / 2, dpr());
	return { x, y, layers: framed(g).map((l) => cells(l, x, y, u)) };
}
function Framed(props: { layers: string[]; lit?: boolean }) {
	return <For each={props.layers}>{(d, k) => <path d={d} fill={k() < 3 ? FRAME[k()] : props.lit ? LIT : FILL} />}</For>;
}
// White text with the menus' black drop shadow, one game pixel down and right; dark on a lit button
function Label(props: { s: string; cx: number; cy: number; u: number; k: number; lit?: boolean }) {
	const p = createMemo(() => {
		const g = text(props.s),
			c = props.u * props.k,
			x = snap(props.cx - (g.w * c) / 2, dpr()),
			y = snap(props.cy - (7 * c) / 2, dpr());
		return { ink: cells(g, x, y, c), shadow: cells(g, x + props.u, y + props.u, c) };
	});
	return (
		<>
			<Show when={!props.lit}>
				<path d={p().shadow} fill={SHADOW} />
			</Show>
			<path d={p().ink} fill={props.lit ? FILL : INK} />
		</>
	);
}

// The blue screen, with a hole for the picture and a white border one game pixel wide round it
export function Backdrop(props: { L: Layout }) {
	const d = () => {
		const { W, H, pic: p, unit: u } = props.L;
		const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`;
		return {
			screen: rect(-1, -1, W + 2, H + 2) + rect(p.x - u, p.y - u, p.w + 2 * u, p.h + 2 * u),
			border: rect(p.x - u, p.y - u, p.w + 2 * u, p.h + 2 * u) + rect(p.x, p.y, p.w, p.h),
		};
	};
	return (
		<g shape-rendering="crispEdges">
			<path d={d().screen} fill={SCREEN} fill-rule="evenodd" />
			<path d={d().border} fill="#ffffff" fill-rule="evenodd" />
		</g>
	);
}

export function GameButton(props: { b: Button; u: number }) {
	const b = props.b;
	const on = () => !!held[b.k];
	const shape = createMemo(() => {
		const u = props.u;
		if (!b.pill) return round(b.r, b.x, b.y, u);
		const k = scale(u, 15),
			t = text(b.label);
		return place(box(t.w * k + 14, 7 * k + 12), b.x, b.y, u);
	});
	return (
		<g shape-rendering="crispEdges">
			<Framed layers={shape().layers} lit={on()} />
			<Label s={b.label} cx={b.x} cy={b.y} u={props.u} k={scale(props.u, b.pill ? 15 : 20)} lit={on()} />
		</g>
	);
}

export function GameGear(props: { L: Layout }) {
	const p = createMemo(() => {
		const g = props.L.gear,
			u = props.L.unit,
			n = Math.max(11, Math.round((2 * g.r) / u)),
			s = place(box(n, n), g.x, g.y, u);
		// three bars, a pixel tall, a pixel apart, inside the frame
		const w = n - 10,
			bars = grid(w, 5, (_, j) => j % 2 === 0);
		return { ...s, icon: cells(bars, s.x + 5 * u, snap(g.y - 2.5 * u, dpr()), u) };
	});
	return (
		<g shape-rendering="crispEdges">
			<Framed layers={p().layers} />
			<path d={p().icon} fill={INK} />
		</g>
	);
}

export function GameStick(props: { L: Layout }) {
	const u = () => props.L.unit;
	// both shapes drawn at the origin and moved, so a drag only changes a transform
	const base = createMemo(() => round(BASE_R, 0, 0, u()));
	const knob = createMemo(() => round(KNOB_R, 0, 0, u()));
	const at = () => {
		const A = props.L.stickArea,
			m = BASE_R + 4;
		if (!dir.active) return { bx: props.L.dirCenter.x, by: props.L.dirCenter.y, kx: 0, ky: 0 };
		let dx = dir.tx - dir.bx,
			dy = dir.ty - dir.by;
		const len = Math.hypot(dx, dy);
		if (len > THROW) {
			dx = (dx / len) * THROW;
			dy = (dy / len) * THROW;
		}
		return {
			bx: Math.max(A.x + m, Math.min(A.x + A.w - m, dir.bx)),
			by: Math.max(A.y + m, Math.min(A.y + A.h - m, dir.by)),
			kx: dx,
			ky: dy,
		};
	};
	const r = dpr();
	return (
		<g shape-rendering="crispEdges" opacity={dir.active || editing() ? 1 : 0.7}>
			<g transform={`translate(${snap(at().bx, r)} ${snap(at().by, r)})`}>
				<Framed layers={base().layers} />
				<g transform={`translate(${snap(at().kx, r)} ${snap(at().ky, r)})`}>
					<Framed layers={knob().layers} lit={!!dir.sector} />
				</g>
			</g>
		</g>
	);
}

export function GameDpad(props: { L: Layout }) {
	const p = createMemo(() => {
		const u = props.L.unit,
			R = props.L.dpadR;
		let n = Math.round((2 * R * 0.92) / u),
			a = Math.round((R * 0.68) / u);
		if ((n - a) % 2) a++; // centred: the arms' sides fall on whole pixels
		n = Math.max(n, a + 8);
		const s = place(cross(n, a), props.L.dirCenter.x, props.L.dirCenter.y, u);
		return { ...s, n, a, u, fill: framed(cross(n, a))[3] };
	});
	// the lit arms: the fill cells beyond the centre square, on the sector's sides
	const lit = () => {
		const sec = dir.sector;
		if (!sec) return '';
		const { n, a, fill, x, y, u } = p(),
			lo = (n - a) / 2,
			hi = lo + a;
		const g = grid(n, n, (i, j) => {
			if (!at(fill, i, j)) return false;
			return (
				(sec.includes('up') && j < lo) ||
				(sec.includes('down') && j >= hi) ||
				(sec.includes('left') && i < lo) ||
				(sec.includes('right') && i >= hi)
			);
		});
		return cells(g, x, y, u);
	};
	return (
		<g shape-rendering="crispEdges">
			<Framed layers={p().layers} />
			<path d={lit()} fill={LIT} />
		</g>
	);
}
