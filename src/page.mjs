// The page around the game, built from src/web (a Vite + SolidJS project, the one part of the port with npm
// dependencies) into build/web: app/barkley.js and app/barkley.css, the font, and the service worker. offline.mjs
// copies it over every HTML5 build, so a change to the page needs no re-import.
//
//   node src/page.mjs   builds it alone (npm install on first use, then type-check and bundle)
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const web = path.join(import.meta.dirname, 'web');
export const PAGE = path.resolve(import.meta.dirname, '..', 'build', 'web');

function npm(...args) {
	const r = spawnSync('npm', args, { cwd: web, stdio: ['ignore', 'inherit', 'inherit'] });
	if (r.status !== 0) throw new Error(`npm ${args.join(' ')} (in src/web) exited ${r.status ?? r.signal}`);
}

export function buildPage() {
	// npm keeps its own copy of the lockfile it installed from; an older one means package-lock.json has moved on
	const installed = path.join(web, 'node_modules', '.package-lock.json');
	if (!existsSync(installed) || statSync(installed).mtimeMs < statSync(path.join(web, 'package-lock.json')).mtimeMs)
		npm('ci', '--no-audit', '--no-fund');
	npm('run', '--silent', 'build');
	return PAGE;
}

if (import.meta.main) console.log(`page: ${buildPage()}`);
