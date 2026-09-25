// Deploy an HTML5 build to GitHub Pages (github.com/Wyatt-Stanke/bsuajg-test) in one command:
//   node src/deploy.mjs <project .yyp | build dir> --message-file=<file> [--dry-run]
// 1. build: a .yyp is built with `fuzz.mjs build --minify` (the page is the current src/web); a build dir is used as
//    it is, with the current page and offline layer written over it. 2. check: the page is the custom one, and a
//    headless play-test boots it to the title screen with no uncaught exception. 3. commit: into the clone in
//    build/deploy/bsuajg-test (cloned on first use), reset to origin/main first, so a deploy pushed from elsewhere is
//    never dropped; the author is the previous deploy's.
// 4. push, and watch the Pages workflow. 5. verify: the live index.html, page app and game script match the build
//    (cache-busted, retried while the CDN catches up) and every html5game script answers 200.
// --dry-run stops after the commit, which stays local (the next deploy resets it away).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeBuild } from './offline.mjs';

const REPO = 'Wyatt-Stanke/bsuajg-test';
const SITE = 'https://wyatt-stanke.github.io/bsuajg-test/';
const CLONE = path.resolve(import.meta.dirname, '..', 'build', 'deploy', 'bsuajg-test');

const args = process.argv.slice(2);
const flag = (name) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const [src] = args.filter((a) => !a.startsWith('--'));
const messageFile = flag('message-file');
const dry = args.includes('--dry-run');
if (!src || !messageFile) {
  console.error('usage: node src/deploy.mjs <project .yyp | build dir> --message-file=<file> [--dry-run]');
  process.exit(1);
}
const message = readFileSync(messageFile, 'utf8');

const step = (s) => console.log(`\n== ${s}`);
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}`);
  return opts.capture ? r.stdout.toString().trim() : '';
}
const git = (...a) => run('git', ['-C', CLONE, ...a], { capture: true });
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

// 1. build
let dir = path.resolve(src),
  built; // the temp dir of a build made here, deleted once it is live
if (dir.endsWith('.yyp')) {
  step('build');
  built = mkdtempSync(path.join(tmpdir(), 'barkley-deploy-'));
  run('node', [path.join(import.meta.dirname, 'fuzz.mjs'), 'build', dir, path.join(built, 'build'), '--minify']);
  dir = path.join(built, 'build');
}
const index = readFileSync(path.join(dir, 'index.html'), 'utf8');
const game = index.match(/html5game\/([\w.-]+\.js)/)?.[1];
if (!game || !existsSync(path.join(dir, 'html5game', game))) throw new Error(`${dir} isn't an HTML5 build`);
// The page app, the service worker and its file list, made from the tree that is about to go up, whatever built it.
// Players on the live site download this build in full before it replaces the one they have (src/offline.mjs,
// src/web/public/sw.js).
const version = writeBuild(dir);
console.log(`version ${version.version}, build ${version.id}: ${version.files.length} files for offline play`);

// 2. check
step('check');
if (!index.includes('app/barkley.js')) throw new Error('index.html is the runtime default, not src/web/index.html');
const test = mkdtempSync(path.join(tmpdir(), 'barkley-deploy-test-'));
writeFileSync(path.join(test, 'probe.js'), "window.barkley && barkley.started ? 'game started' : 'not started'");
const pt = spawnSync('node', [
  path.join(import.meta.dirname, 'playtest.mjs'),
  dir,
  test,
  `wait:16000,js:${test}/probe.js,shot:title`,
]);
const ptLog = pt.stdout.toString();
if (pt.status !== 0 || !ptLog.includes('probe.js: game started'))
  throw new Error(`play-test failed:\n${ptLog.split('\n').slice(-15).join('\n')}`);
console.log(`play-test passed: booted, started, no exception (screenshot ${test}/title.png)`);

// 3. commit
step('commit');
if (!existsSync(path.join(CLONE, '.git'))) {
  mkdirSync(path.dirname(CLONE), { recursive: true });
  run('git', ['clone', '--depth', '1', `https://github.com/${REPO}.git`, CLONE]);
}
git('fetch', '--depth', '1', 'origin', 'main');
git('checkout', '-B', 'main', 'origin/main');
git('reset', '--hard', 'origin/main');
git('clean', '-fdx');
// A build that changed without its version changing leaves players unable to tell the two apart (their browsers
// still update: the check is on the build id, not the version).
const live = existsSync(path.join(CLONE, 'version.json'))
  ? JSON.parse(readFileSync(path.join(CLONE, 'version.json'), 'utf8'))
  : null;
if (live && live.id !== version.id && live.version === version.version)
  console.warn(`warning: the live site is already v${version.version} with different files; bump src/version.json`);
run('rsync', ['-a', '--delete', '--exclude=.git', '--exclude=.github', '--exclude=README.md', `${dir}/`, `${CLONE}/`]);
git('add', '-A');
if (!git('status', '--porcelain')) {
  console.log('the live site already has this build; nothing to deploy');
  process.exit(0);
}
console.log(git('diff', '--cached', '--stat').split('\n').slice(-1)[0]);
const author = git('log', '-1', '--format=%an <%ae>');
run('git', ['-C', CLONE, 'commit', '-q', '--author', author, '-F', '-'], {
  input: message,
  stdio: ['pipe', 'inherit', 'inherit'],
});
const sha = git('rev-parse', 'HEAD');
console.log(`committed ${sha.slice(0, 7)} as ${author}`);
if (dry) {
  console.log('dry run: not pushed');
  process.exit(0);
}

// 4. push and watch the workflow
step('push');
run('git', ['-C', CLONE, 'push', 'origin', 'main']);
let id;
for (let i = 0; i < 60 && !id; i++) {
  const runs = JSON.parse(
    run('gh', ['run', 'list', '-R', REPO, '-L', '5', '--json', 'databaseId,headSha'], { capture: true }),
  );
  id = runs.find((r) => r.headSha === sha)?.databaseId;
  if (!id) await new Promise((ok) => setTimeout(ok, 2000));
}
if (!id) throw new Error('no workflow run started for the push');
run('gh', ['run', 'watch', String(id), '-R', REPO, '--exit-status', '--interval', '5'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
console.log(`workflow run ${id} succeeded`);

// 5. verify the live site
step('verify');
// version.json is what a player's browser checks to find this build, and sw.js is what does the checking
const want = {
  'index.html': md5(index),
  'version.json': md5(readFileSync(path.join(dir, 'version.json'))),
  'sw.js': md5(readFileSync(path.join(dir, 'sw.js'))),
  'app/barkley.js': md5(readFileSync(path.join(dir, 'app', 'barkley.js'))),
  'app/barkley.css': md5(readFileSync(path.join(dir, 'app', 'barkley.css'))),
  [`html5game/${game}`]: md5(readFileSync(path.join(dir, 'html5game', game))),
};
for (const [file, sum] of Object.entries(want)) {
  let got;
  for (let i = 0; i < 36 && got !== sum; i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 5000));
    const r = await fetch(`${SITE}${file}?cb=${Date.now()}`, { cache: 'no-store' });
    got = r.ok ? md5(Buffer.from(await r.arrayBuffer())) : `HTTP ${r.status}`;
  }
  if (got !== sum) throw new Error(`live ${file} is ${got}, the build's is ${sum}`);
  console.log(`live ${file} matches (${sum})`);
}
for (const f of readdirSync(path.join(dir, 'html5game')).filter((f) => f.endsWith('.js') && f !== game)) {
  const r = await fetch(`${SITE}html5game/${f}?cb=${Date.now()}`, { method: 'HEAD' });
  if (!r.ok) throw new Error(`live html5game/${f}: HTTP ${r.status}`);
  console.log(`live html5game/${f}: 200`);
}
if (built) rmSync(built, { recursive: true, force: true });
console.log(`\ndeployed v${version.version} (${sha.slice(0, 7)}) to ${SITE}`);
