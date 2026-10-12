import { fnNames } from './coverage.js';

// ---- novelty ----
// What the fuzzer has already seen, kept in step with fuzz.mjs through each request's sync.
export const known = {
	cells: new Set(),
	cov: new Map(),
	flags: new Set(),
	volatile: new Set(),
	exits: new Set(),
	talked: new Set(),
	graph: new Map(),
};
export const covOf = (r) => {
	if (!known.cov.has(r)) known.cov.set(r, new Uint8Array(fnNames.length));
	return known.cov.get(r);
};
export const sync = (s) => {
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
