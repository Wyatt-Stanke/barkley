import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ROOT } from './util.mjs';

// ---- the corpus in git: fuzz/corpus.json.gz ----
// What the search knows, packed into one file: the state and the nodes on the way to every node that owned features
// (the rest led nowhere), without snapshots. Snapshots only restore into the build that made them, and no two builds
// are byte-identical, so a run always makes them again from the paths (rebase). The bytes depend only on the content,
// so an unchanged corpus is an unchanged file.
export const PACK = path.join(ROOT, 'fuzz', 'corpus.json.gz');
const md5 = (b) => createHash('md5').update(b).digest('hex');
export function packCorpus(dir, file) {
	const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
	const nodes = JSON.parse(readFileSync(path.join(dir, 'nodes.json'), 'utf8'));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const keep = new Set();
	for (const n of nodes)
		if (n.progress !== undefined) for (let m = n; m && !keep.has(m.id); m = byId.get(m.parent)) keep.add(m.id);
	// a crash's directory is this machine's; its signature is what the next run needs
	const crashes = st.crashes.map(({ dir: _, ...c }) => c);
	const json = JSON.stringify({ state: { ...st, build: null, crashes }, nodes: nodes.filter((n) => keep.has(n.id)) });
	const gz = gzipSync(json, { level: 9 });
	gz[9] = 3; // the gzip header's OS byte, which differs by platform
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, gz);
	renameSync(`${file}.tmp`, file);
	writeFileSync(path.join(dir, 'packed.md5'), md5(gz));
}
// Makes dir the unpacked corpus. A dir last packed to (or unpacked from) this very file is kept as it is, with the
// snapshots its build made; otherwise it is replaced.
export function unpackCorpus(file, dir) {
	if (!existsSync(file)) return;
	const gz = readFileSync(file);
	const mark = path.join(dir, 'packed.md5');
	if (existsSync(mark) && readFileSync(mark, 'utf8') === md5(gz)) return;
	const { state, nodes } = JSON.parse(gunzipSync(gz).toString());
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(path.join(dir, 'nodes'), { recursive: true });
	writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
	writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes));
	writeFileSync(mark, md5(gz));
}

// Identifies a build: snapshots and function numbers only carry over to a run on the same one.
// HARNESS: bump when a harness change makes recorded paths play differently (the corpus then rebases)
const HARNESS = 3;
export const buildId = (root) => {
	const game = readFileSync(path.join(root, 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
	return createHash('md5')
		.update(readFileSync(path.join(root, 'html5game', game)))
		.update(`harness ${HARNESS}`)
		.digest('hex');
};
