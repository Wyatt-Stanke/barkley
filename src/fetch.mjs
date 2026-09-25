#!/usr/bin/env node

// Fetches the pipeline's inputs into game/original/, skipping whatever is already there:
//
//   node src/fetch.mjs
//
// - the original v1.20 distribution (BarkleyV120.exe, bass.dll, bgm.dll, ReadMe.txt, Music/, Voice/, BG/), from the
//   Internet Archive's copy of the game, checked against its MD5;
// - the GM6 decompiler's Java source (ButterscotchRunner/GMDecompilerDecompiled), cloned at a pinned commit, which
//   virt/decompile.sh compiles.
//
// Needs curl, unzip and git on PATH.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ZIP_URL = 'https://archive.org/download/BarkleyShutUpAndJamGaiden/BarkleyV120.zip';
const ZIP_MD5 = '28f07c58d08b47979fdab7a6c571200f';
const DECOMPILER_REPO = 'https://github.com/ButterscotchRunner/GMDecompilerDecompiled.git';
const DECOMPILER_COMMIT = '92a646dd22123d8472645ff0d7073b8684b27b4d';

const root = path.resolve(import.meta.dirname, '..');
const original = path.join(root, 'game', 'original');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

export function fetchInputs() {
  fs.mkdirSync(original, { recursive: true });

  if (fs.existsSync(path.join(original, 'BarkleyV120.exe'))) console.log(`- game: already in ${original}`);
  else {
    const tmp = fs.mkdtempSync(path.join(path.dirname(original), '.fetch-'));
    try {
      const zip = path.join(tmp, 'BarkleyV120.zip');
      console.log(`- game: downloading ${ZIP_URL}`);
      run('curl', ['-fL', '--retry', '3', '--retry-all-errors', '-sS', '-o', zip, ZIP_URL]);
      const md5 = crypto.createHash('md5').update(fs.readFileSync(zip)).digest('hex');
      if (md5 !== ZIP_MD5) throw new Error(`BarkleyV120.zip has MD5 ${md5}, expected ${ZIP_MD5}`);
      run('unzip', ['-q', zip, '-d', tmp]);
      // the zip holds one folder, BarkleyV120/
      for (const f of fs.readdirSync(path.join(tmp, 'BarkleyV120')))
        fs.renameSync(path.join(tmp, 'BarkleyV120', f), path.join(original, f));
      console.log(`  unpacked into ${original}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const decompiler = path.join(original, 'GMDecompilerDecompiled');
  if (fs.existsSync(path.join(decompiler, 'src', 'main', 'java')))
    console.log(`- decompiler: already in ${decompiler}`);
  else {
    console.log(`- decompiler: cloning ${DECOMPILER_REPO} at ${DECOMPILER_COMMIT.slice(0, 7)}`);
    fs.rmSync(decompiler, { recursive: true, force: true });
    run('git', ['init', '-q', decompiler]);
    run('git', ['-C', decompiler, 'fetch', '-q', '--depth', '1', DECOMPILER_REPO, DECOMPILER_COMMIT]);
    run('git', ['-C', decompiler, 'checkout', '-q', 'FETCH_HEAD']);
  }
}

if (import.meta.main) fetchInputs();
