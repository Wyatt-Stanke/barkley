import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';

// The harness, with the runtime variable names it needs, found in the build.
export function harness(root) {
	const game = readFileSync(path.join(root, 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
	const js = readFileSync(path.join(root, 'html5game', game), 'utf8');
	if (!js.includes('function gml_Script_resume_save'))
		throw new Error('needs an unobfuscated modernized build (fuzz.mjs build)');
	// both the pretty build and the minified one (fuzz.mjs build --minify, the deployed build), which writes 1e6 for
	// 1000000, turns the surface check into a conditional and folds loops and ifs
	const rng = js.match(/var state=\[\]\s*[;,]\s*(?:var\s+)?(\w+)\s*=\s*0\s*[;,]\s*(?:var\s+)?(\w+)\s*=\s*\w+\(0\)/);
	const ids = js.match(/(\w+)\s*=\s*(?:1000000|1e6)\s*[;,]\s*g_pBuiltIn\.game_id\s*=/);
	const surfaces =
		js.match(/if\((\w+)\.length!=0\)\s*\{\s*yyError\("Unbalanced surface stack/) ??
		js.match(/0==(\w+)\.length\?[^;]{0,300}?yyError\("Unbalanced surface stack/);
	const mouse = js.match(/function (\w+)\(\)\s*\{\s*if\(\w+\)\s*\{[\s\S]{0,200}?window_views_mouse_get_x\(\)/);
	// the room's method that removes destroyed instances (the runtime calls it near the end of a frame), and the room
	const sweep =
		js.match(
			/prototype\.(\w+)=\s*function\(\)\s*\{\s*var (\w+)=\[\];[\s\S]{0,200}?\.marked\)\s*\{\s*\2\[\2\.length\]=/,
		) ??
		js.match(
			/prototype\.(\w+)=function\(\)\{for\(var (\w+)=\[\],[^{}]{0,100}\{[^{}]{0,40}\.marked&&\(\2\[\2\.length\]=/,
		);
	const room = sweep && js.match(new RegExp(`(\\w+)\\.${sweep[1]}\\(\\)`));
	// frame pacing: when the next frame is due (delay = due + 1000/room_speed - now; due = now + delay)
	const pace =
		js.match(/var (\w+)=(\w+)\+1000\/(\w+)-now;\s*if\(\1<0\)\1=0;\s*\2=now\+\1;/) ??
		js.match(/(\w+)=(\w+)\+1e3\/(\w+)-(\w+);if\(\1<0&&\(\1=0\),\2=\4\+\1,/);
	if (!rng || !ids || !surfaces)
		throw new Error('RNG state, instance id counter or surface stack not found in the runtime');
	const names = { state: 'state', b: rng[1], c: rng[2], ids: ids[1], surfaces: surfaces[1], mouse: mouse?.[1] };
	Object.assign(names, { sweep: sweep?.[1], room: room?.[1], pace: pace?.[2] });
	return `window.__fuzzNames=${JSON.stringify(names)};\n${pageScript()}`;
}

// The in-page side, fuzz/page/: written as modules (for reading, and for Biome), but the page needs one classic script
// that runs before the game's own (Page.addScriptToEvaluateOnNewDocument), whose 'use strict' functions stop the
// runtime's error trace (see biome.jsonc). So the files are joined in this order, which is the order their top-level
// code runs in, with their imports and exports dropped: inside one function they share one scope, and an import is
// just the name.
const PAGE = [
	'core',
	'clock',
	'coverage',
	'input',
	'hooks',
	'render',
	'snapshot',
	'known',
	'probe',
	'novelty',
	'walk',
	'generators',
	'goals',
	'through',
	'episode',
	'replay',
];
export function pageScript() {
	const dir = path.join(ROOT, 'fuzz', 'page');
	const missing = readdirSync(dir).filter((f) => f.endsWith('.js') && !PAGE.includes(f.slice(0, -3)));
	if (missing.length) throw new Error(`fuzz/page: ${missing.join(', ')} not in harness.mjs's PAGE`);
	const parts = PAGE.map((n) =>
		readFileSync(path.join(dir, `${n}.js`), 'utf8')
			.replace(/^import\s[\s\S]*?\sfrom\s+'[^']+';\n/gm, '')
			.replace(/^export /gm, ''),
	);
	return `(() => {\n${parts.join('\n')}})();\n`;
}
