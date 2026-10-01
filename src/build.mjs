#!/usr/bin/env node
// An HTML5 build with obfuscation off (gml_* names kept), from a copy of the project and of the user folder, plus the
// page app and the offline layer (offline.mjs). --minify shrinks it with terser, keeping the names: that build is what
// gets deployed, so a crash report from a player carries readable GML stacks and the fuzzer can replay it.
//
//   node src/build.mjs <project .yyp> <build dir> [--minify]
//
// (fuzz.mjs build is the same.) It is its own file so that the fuzzer can change without changing what a build is:
// CI reuses a build whose inputs are unchanged (.github/actions/prebuilt), and fuzz.mjs is not one of them. The one
// thing it takes from the fuzzer is harness(), which only checks that the build is one the fuzzer can drive.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harness } from './fuzz.mjs';
import { writeBuild } from './offline.mjs';
import { igor } from './toolchain.mjs';

const HERE = import.meta.dirname;

export function build(yyp, outDir, minify = false) {
	if (existsSync(outDir) && !existsSync(path.join(outDir, 'html5game')))
		throw new Error(`${outDir} exists and isn't a build`);
	const tmp = mkdtempSync(path.join(tmpdir(), 'barkley-fuzz-build-'));
	try {
		const proj = path.join(tmp, 'project');
		cpSync(path.dirname(yyp), proj, { recursive: true, filter: (s) => !s.includes(`${path.sep}mvc`) });
		// The extensions' files have to be the one-line stubs import.mjs writes: the page app defines their functions. A
		// project whose extensions carry their own code would draw a second touch overlay and define everything twice.
		const extensions = path.join(proj, 'extensions');
		for (const name of existsSync(extensions) ? readdirSync(extensions) : [])
			for (const f of readdirSync(path.join(extensions, name)).filter((f) => f.endsWith('.js')))
				if (!readFileSync(path.join(extensions, name, f), 'utf8').includes('barkley.extension('))
					throw new Error(
						`${yyp}: extensions/${name}/${f} isn't a page stub; import the project again (src/import.mjs)`,
					);
		// the custom index.html, at an absolute path: always the current src/web/index.html, so a page change needs no
		// re-import (and an earlier Igor build may have deleted the project's copy); writeBuild adds the page app it loads
		const index = path.join(proj, 'options', 'html5', 'index.html');
		cpSync(path.join(HERE, 'web', 'index.html'), index);
		const opts = path.join(proj, 'options', 'html5', 'options_html5.yy');
		writeFileSync(
			opts,
			readFileSync(opts, 'utf8').replace(/("option_html5_index":)"[^"]*"/, `$1${JSON.stringify(index)}`),
		);
		const { igor: IGOR, runtime: RT, userFolder: UF } = igor();
		const uf = path.join(tmp, 'user');
		cpSync(UF, uf, { recursive: true });
		const settings = JSON.parse(readFileSync(path.join(uf, 'local_settings.json'), 'utf8'));
		settings['machine.Platform Settings.HTML5.obfuscate'] = false;
		settings['machine.Platform Settings.HTML5.pretty_print'] = !minify;
		writeFileSync(path.join(uf, 'local_settings.json'), JSON.stringify(settings, null, 4));
		const r = spawnSync(
			IGOR,
			[
				'-j=8',
				`--project=${path.join(proj, path.basename(yyp))}`,
				`--rp=${RT}`,
				`--uf=${uf}`,
				`--cache=${tmp}/cache`,
				`--temp=${tmp}/temp`,
				`--of=${tmp}/out/index.html`,
				`--tf=${tmp}/pkg`,
				'-r=VM',
				'--',
				'html5',
				'folder',
			],
			{ stdio: ['ignore', 'pipe', 'pipe'], cwd: tmp, maxBuffer: 1 << 28 },
		);
		const log = r.stdout.toString() + r.stderr.toString();
		if (r.status !== 0) throw new Error(`Igor exited ${r.status}:\n${log.slice(-3000)}`);
		if (!log.includes(`Copy: ${index}`)) console.warn('warning: Igor did not use the custom index.html');
		if (minify) {
			// -c -m without --keep-fnames would rename the gml_* functions a crash stack is made of; top-level names
			// (the runtime's own variables the harness looks for) are left alone either way.
			const game = readFileSync(path.join(tmp, 'out', 'index.html'), 'utf8').match(/html5game\/([\w.-]+\.js)/)[1];
			const js = path.join(tmp, 'out', 'html5game', game);
			const before = statSync(js).size;
			const t = spawnSync('npx', ['-y', 'terser@5', js, '-c', '-m', '--keep-fnames', '-o', js], {
				stdio: ['ignore', 'inherit', 'inherit'],
			});
			if (t.status !== 0) throw new Error(`terser exited ${t.status}`);
			console.log(`minified ${game}: ${before} -> ${statSync(js).size} bytes`);
		}
		rmSync(outDir, { recursive: true, force: true });
		cpSync(path.join(tmp, 'out'), outDir, { recursive: true });
		// the page app (src/web), the service worker and the file list it caches the build from (a page under the fuzz
		// harness never registers the worker)
		const v = writeBuild(outDir);
		harness(outDir); // checks it's fuzzable
		console.log(`built ${outDir}: v${v.version}, build ${v.id}, ${v.files.length} files to cache`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const pos = args.filter((a) => !a.startsWith('--'));
	if (pos.length !== 2 || args.some((a) => a.startsWith('--') && a !== '--minify')) {
		console.error('usage: node src/build.mjs <project .yyp> <build dir> [--minify]');
		process.exit(1);
	}
	build(path.resolve(pos[0]), path.resolve(pos[1]), args.includes('--minify'));
}
