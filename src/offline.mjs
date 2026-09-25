// The offline layer of the web build: the service worker and the manifest it reads.
//
// writeBuild(dir) copies the page (src/page.mjs: app/ with the page's script, style sheet and font, and sw.js) over an
// HTML5 build. sw.js goes at the root — a service worker only controls pages under its own path, so it can't ship
// from html5game/ as the game's own files do — and version.json is written beside it: the project's version
// (src/version.json, semver), an id that is the hash of the whole file list, and every file the page can ask for with
// its hash, its size, and whether the game needs it before the first frame. The id is what the worker compares to
// decide a build is new; the hashes are what lets it keep the files a new build didn't change.
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildPage } from './page.mjs';

export const VERSION = JSON.parse(readFileSync(path.join(import.meta.dirname, 'version.json'), 'utf8')).version;

// The page reports no Ogg support so the runtime loads the MP3 of every sound (Safari's Vorbis decoder clips them),
// which leaves the .ogg copies — 57 MB of a 157 MB build — never asked for, so they are never cached either.
// sw.js and version.json answer from the network: the worker can't be served by itself, and the manifest is the check.
const SKIP = /^\.|\/\.|\.ogg$|^sw\.js$|^version\.json$/;
// The music is streamed: the runtime downloads a track the first time it plays it. Everything else — the code, the
// texture pages and the ~190 small sounds — the game loads before its first frame, so it is what offline play needs
// first. Nothing else in a build comes near half a megabyte.
const streamed = (p, bytes) => /\.mp3$/.test(p) && bytes > 512 * 1024;

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

export function writeBuild(dir) {
  cpSync(buildPage(), dir, { recursive: true });
  const files = [];
  (function walk(rel) {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else {
        const full = path.join(dir, p);
        files.push([p, hash(readFileSync(full)), statSync(full).size, streamed(p, statSync(full).size) ? 0 : 1]);
      }
    }
  })('');
  const version = { version: VERSION, id: hash(files.map((f) => f.join(' ')).join('\n')), files };
  writeFileSync(path.join(dir, 'version.json'), JSON.stringify(version));
  return version;
}
