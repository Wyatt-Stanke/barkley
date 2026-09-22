// Fetches the pinned third-party artifacts the guest needs into virt/cache/,
// once, and checks them against their hashes. Everything else the guest pulls
// (the GameMaker archive, the game, the scripts) already lives in the repo.
//
//   node virt/host/prepare.mjs [--force]
//
// A cached file whose hash does not match is an error, not something to
// overwrite: the whole point of the pin is that the bits do not drift.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VIRT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(VIRT, 'cache');

// What the guest needs beyond tools/ and game/. The Java 8 JDK that used to be
// here is gone with the decompile itself: that step runs on the host now, in a
// container (virt/decompile.sh), so nothing in the VM needs a JDK.
const ARTIFACTS = [
  {
    // 5piceIDE.exe -- the GameMaker IDE proper -- links against VCRUNTIME140,
    // and without it Windows answers the launch with "The code execution cannot
    // proceed because VCRUNTIME140.dll was not found" and nothing starts. The
    // IDE is a 32-bit binary, so this is the x86 redistributable.
    //
    // The URL is what https://aka.ms/vs/17/release/vc_redist.x86.exe redirects
    // to: a permanent, content-addressed path with this same hash in it.
    name: 'VC_redist.x86.exe',
    url: 'https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/0C09F2611660441084CE0DF425C51C11E147E6447963C3690F97E0B25C55ED64/VC_redist.x86.exe',
    sha256: '0c09f2611660441084ce0df425c51c11e147e6447963c3690f97e0b25c55ed64',
    size: 13867440,
  },
];

const force = process.argv.includes('--force');

function sha256(path) {
  return readFile(path).then((buf) => createHash('sha256').update(buf).digest('hex'));
}

await mkdir(CACHE, { recursive: true });

let updated = false;
for (const art of ARTIFACTS) {
  const dest = join(CACHE, art.name);
  const have = await stat(dest).catch(() => null);

  if (have && !force) {
    const digest = await sha256(dest);
    if (digest === art.sha256) {
      console.log(`ok       ${art.name}`);
      continue;
    }
    console.error(`MISMATCH ${art.name}`);
    console.error(`  cached ${digest}`);
    console.error(`  pinned ${art.sha256}`);
    console.error('  Delete it and re-run if you mean to take the new bits.');
    process.exitCode = 1;
    continue;
  }

  console.log(`fetch    ${art.name} (${(art.size / 1e6).toFixed(0)} MB)`);
  const res = await fetch(art.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${art.url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));

  const digest = await sha256(tmp);
  if (art.sha256 === 'PENDING') {
    console.log(`  sha256 ${digest}  <- pin this`);
  } else if (digest !== art.sha256) {
    await unlink(tmp);
    throw new Error(`hash mismatch for ${art.name}: got ${digest}, pinned ${art.sha256}`);
  }
  await rename(tmp, dest);
  updated = true;
}

console.log(updated ? 'cache updated' : 'cache is current');
