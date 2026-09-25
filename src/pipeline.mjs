#!/usr/bin/env node

// The whole port in one command, from the original executable to a playable HTML5 site:
//
//   node src/pipeline.mjs [--out=<dir>] [--mode=modernized|faithful] [--from=exe|pristine] [--no-playtest]
//
//   1. fetch     the original game (archive.org) and the GM6 decompiler's source  -> game/original/   (src/fetch.mjs)
//   2. export    BarkleyV120.exe -> .gm6 -> GMX, in containers                     -> <out>/BarkleyV120.gmx (virt/run.sh)
//   3. migrate   the GMX -> a GMX that GameMaker LTS can import                    -> <out>/barkley-<version>.gmx
//   4. import    -> a GameMaker LTS project, with the page and its extensions      -> <out>/barkley-<version>/
//   5. build     Igor HTML5, minified, plus the page (src/web) and offline layer  -> <out>/site/
//   6. play-test the site in headless Chromium: it boots, Start is clicked, the game runs with no uncaught exception
//
// <out> defaults to build/pipeline. A step whose output already exists is skipped, so a failed run picks up where it
// stopped; delete <out> (or one step's output) to redo it. --from=pristine starts from game/BarkleyV120.gmx instead of
// steps 1-2, when you have it. The GameMaker tools come from src/toolchain.mjs: the installed IDE and runtime on a Mac
// that has them, otherwise downloads into build/tools/ (which need GAMEMAKER_ACCESS_KEY for the licence).
//
// Needs Node 24+ and npm, curl, unzip, git, patch, ffmpeg/ffprobe, python3, and podman or docker (step 2).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fetchInputs } from './fetch.mjs';
import { VERSION } from './offline.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name, d) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const out = path.resolve(flag('out', path.join(root, 'build', 'pipeline')));
const mode = flag('mode', 'modernized');
const from = flag('from', 'exe');
const playtest = !args.includes('--no-playtest');
if (
  !['modernized', 'faithful'].includes(mode) ||
  !['exe', 'pristine'].includes(from) ||
  args.some((a) => !/^--(out|mode|from)=|^--no-playtest$/.test(a))
) {
  console.error(
    'usage: node src/pipeline.mjs [--out=<dir>] [--mode=modernized|faithful] [--from=exe|pristine] [--no-playtest]',
  );
  process.exit(1);
}

const started = Date.now();
const step = (name, output, fn) => {
  if (output && fs.existsSync(output)) return console.log(`\n== ${name}: keeping ${path.relative(root, output)}`);
  console.log(`\n== ${name}`);
  const t = Date.now();
  fn();
  console.log(`   (${Math.round((Date.now() - t) / 1000)} s)`);
};
function run(cmd, argv, { capture = false } = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: root,
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    maxBuffer: 1 << 28,
  });
  const text = capture ? r.stdout.toString() : '';
  if (capture) process.stdout.write(text);
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${argv.join(' ')} exited ${r.status ?? r.signal}`);
  return text;
}
const node = (script, ...argv) =>
  run(process.execPath, [path.join(import.meta.dirname, script), ...argv], { capture: true });

fs.mkdirSync(out, { recursive: true });
const gmx = from === 'exe' ? path.join(out, 'BarkleyV120.gmx') : path.join(root, 'game', 'BarkleyV120.gmx');
const migrated = path.join(out, `barkley-${VERSION}.gmx`);
const yyp = path.join(out, `barkley-${VERSION}`, 'BarkleyLTS.yyp');
const site = path.join(out, 'site');

try {
  step('fetch', null, fetchInputs);
  if (from === 'exe') step('export (virt/run.sh)', gmx, () => run(path.join(root, 'virt', 'run.sh'), [gmx]));
  else if (!fs.existsSync(gmx)) throw new Error(`--from=pristine needs ${gmx}`);
  step(`migrate (${mode})`, migrated, () => {
    try {
      const log = node('migrate.mjs', `--mode=${mode}`, gmx, path.join(root, 'game', 'original'), migrated);
      if (!log.includes('No items to review.')) throw new Error('the migration audit has items to review');
    } catch (e) {
      // so the next run redoes it rather than keeping a half-made migration
      for (const d of [migrated, `${migrated}.code`]) fs.rmSync(d, { recursive: true, force: true });
      throw e;
    }
  });
  step('import', path.dirname(yyp), () => {
    try {
      node('import.mjs', migrated, yyp);
    } catch (e) {
      fs.rmSync(path.dirname(yyp), { recursive: true, force: true });
      throw e;
    }
  });
  step('build (HTML5, minified)', site, () => node('fuzz.mjs', 'build', yyp, site, '--minify'));
  if (playtest)
    step('play-test', null, () => {
      const dir = path.join(out, 'playtest');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, 'probe.js');
      fs.writeFileSync(probe, "window.barkley && barkley.started ? 'game started' : 'not started'");
      const log = node('playtest.mjs', site, dir, `wait:16000,js:${probe},shot:title`);
      if (!log.includes('probe.js: game started')) throw new Error('the play-test did not start the game');
      console.log(`   screenshot: ${path.relative(root, path.join(dir, 'title.png'))}`);
    });
} catch (e) {
  console.error(`\npipeline failed: ${e.message}`);
  process.exit(1);
}
console.log(`\nv${VERSION} built in ${Math.round((Date.now() - started) / 60000)} min: ${site}`);
console.log(`play it: cd ${path.relative(process.cwd(), site) || '.'} && python3 -m http.server 8000 --bind 127.0.0.1`);
