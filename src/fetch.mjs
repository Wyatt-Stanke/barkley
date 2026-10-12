#!/usr/bin/env node

// Fetches the pipeline's inputs, skipping whatever is already there:
//
//   node src/fetch.mjs
//
// - the original v1.20 distribution (BarkleyV120.exe, bass.dll, bgm.dll, ReadMe.txt, Music/, Voice/, BG/), from the
//   Internet Archive's copy of the game, checked against its MD5, into game/original/;
// - the git submodules in virt/upstream/ (the GM6 decompiler's Java source and LateralGM, each pinned to a commit),
//   which virt/ compiles, for a checkout made without --recurse-submodules.
//
// Needs curl, unzip and git on PATH.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ZIP_URL = 'https://archive.org/download/BarkleyShutUpAndJamGaiden/BarkleyV120.zip';
const ZIP_MD5 = '28f07c58d08b47979fdab7a6c571200f';

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

	// A submodule that was never checked out shows as `-<commit> <path>`.
	const status = execFileSync('git', ['-C', root, 'submodule', 'status', '--recursive'], { encoding: 'utf8' });
	if (!/^-/m.test(status)) console.log('- upstream: already checked out in virt/upstream/');
	else {
		console.log('- upstream: checking out the submodules in virt/upstream/');
		run('git', ['-C', root, 'submodule', 'update', '--init', '--recursive']);
	}
}

if (import.meta.main) fetchInputs();
