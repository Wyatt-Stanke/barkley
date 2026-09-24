#!/usr/bin/env node
// Finds the GameMaker tools and the browser the pipeline runs, and installs whatever is missing into build/tools/:
//
//   node src/toolchain.mjs    # installs what is missing and prints where everything is
//
// On a Mac with GameMaker LTS 2026 installed and signed in, everything is already there and nothing is downloaded.
// Anywhere else (a Linux CI runner, say) it installs, pinned:
//   - ProjectTool, the IDE's GMX importer, from GameMaker's package registry (gmpm.gamemaker.io);
//   - the Igor bootstrapper, then with it the runtime (html5 module only) from the LTS 2026 feed;
//   - a licence, fetched by Igor with the access key in GAMEMAKER_ACCESS_KEY
//     (make one at https://gamemaker.io/account/access_keys);
//   - chrome-headless-shell, for playtest.mjs and fuzz.mjs, through npx @puppeteer/browsers.
//
// Each can be pointed elsewhere instead: BARKLEY_PROJECTTOOL (the ProjectTool binary), BARKLEY_RUNTIME (a runtime
// dir), BARKLEY_USER_DIR (a user folder holding licence.plist and local_settings.json), CHROME (the browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const RUNTIME_VERSION = '2026.0.0.23';
const RUNTIME_FEED = 'https://gms.yoyogames.com/Zeus-Runtime-LTS2026.rss';
const PROJECTTOOL_VERSION = '2024.14.165'; // what the LTS 2026 IDE (2026.0.0.16) bundles
const CHROME_VERSION = '154.0.8037.57';

const TOOLS = path.resolve(import.meta.dirname, '..', 'build', 'tools');
const OS = { darwin: 'osx', linux: 'linux', win32: 'win' }[process.platform];
const ARCH = os.arch() === 'arm64' ? 'arm64' : 'x64';
const EXE = process.platform === 'win32' ? '.exe' : '';

// the local install of GameMaker LTS 2026, if there is one
const MAC_APP = `/Applications/GameMaker LTS 2026.app/Contents/MacOS/${ARCH === 'arm64' ? 'arm64' : 'x86_64'}`;
const MAC_RUNTIME = `/Users/Shared/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-${RUNTIME_VERSION}`;
const MAC_USERS = `${os.homedir()}/Library/Application Support/GameMakerStudio2-LTS2026`;
const MAC_CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const download = (url, file) => run('curl', ['-fL', '--retry', '3', '--retry-all-errors', '-sS', '-o', file, url]);
const found = (f) => f && fs.existsSync(f);

// ProjectTool must run with its own directory as the cwd.
export function projectTool() {
  if (process.env.BARKLEY_PROJECTTOOL) return process.env.BARKLEY_PROJECTTOOL;
  const mac = `${MAC_APP}/packages/project-tool-osx-${ARCH}/ProjectTool`;
  if (found(mac)) return mac;
  const name = `project-tool-${OS}-${ARCH}`;
  const dir = path.join(TOOLS, `${name}-${PROJECTTOOL_VERSION}`);
  const tool = path.join(dir, `ProjectTool${EXE}`);
  if (found(tool)) return tool;
  console.log(`- installing ProjectTool ${PROJECTTOOL_VERSION} into ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, 'package.tgz');
  download(`https://gmpm.gamemaker.io/@gm-tools/${name}/-/${name}-${PROJECTTOOL_VERSION}.tgz`, tgz);
  run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1']);
  fs.rmSync(tgz);
  if (!found(tool)) throw new Error(`the ProjectTool package has no ${tool}`);
  fs.chmodSync(tool, 0o755);
  return tool;
}

// A user folder with a licence.plist, which Igor needs. Returns null when there is none and no access key to get one.
export function userFolder() {
  if (process.env.BARKLEY_USER_DIR) return process.env.BARKLEY_USER_DIR;
  const signedIn =
    found(MAC_USERS) &&
    fs
      .readdirSync(MAC_USERS)
      .map((d) => path.join(MAC_USERS, d))
      .find((d) => found(path.join(d, 'licence.plist')) && found(path.join(d, 'local_settings.json')));
  if (signedIn) return signedIn;
  const dir = path.join(TOOLS, 'user');
  const licence = path.join(dir, 'licence.plist');
  if (found(licence)) {
    const expiry = fs.readFileSync(licence, 'utf8').match(/<key>expiry_date<\/key>\s*<string>([^<]*)</)?.[1];
    if (!expiry || new Date(expiry) > new Date()) return dir;
  }
  if (!process.env.GAMEMAKER_ACCESS_KEY) return null;
  console.log(`- fetching a GameMaker licence into ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const igor = bootstrapper();
  // the key goes to Igor only; the command isn't echoed
  execFileSync(igor, ['runtime', 'FetchLicense', `-ak=${process.env.GAMEMAKER_ACCESS_KEY}`, `-of=${licence}`], {
    cwd: path.dirname(igor),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!found(licence)) throw new Error('Igor did not fetch a licence: check GAMEMAKER_ACCESS_KEY');
  fs.writeFileSync(path.join(dir, 'local_settings.json'), '{}\n');
  return dir;
}

function needUserFolder() {
  const uf = userFolder();
  if (!uf)
    throw new Error(
      'no GameMaker licence: sign in to GameMaker LTS 2026, or set GAMEMAKER_ACCESS_KEY ' +
        '(https://gamemaker.io/account/access_keys) or BARKLEY_USER_DIR',
    );
  return uf;
}

// The Igor that installs runtimes and fetches licences (the one that builds is inside the runtime).
function bootstrapper() {
  const dir = path.join(TOOLS, 'igor');
  const igor = [path.join(dir, OS === 'win' ? 'windows' : OS, ARCH, `Igor${EXE}`), path.join(dir, `Igor${EXE}`)].find(
    found,
  );
  if (igor) return igor;
  console.log(`- installing the Igor bootstrapper into ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'igor.zip');
  download(`https://gms.yoyogames.com/igor_${OS}-${ARCH}.zip`, zip);
  run('unzip', ['-q', '-o', zip, '-d', dir]);
  fs.rmSync(zip);
  const got = [path.join(dir, OS === 'win' ? 'windows' : OS, ARCH, `Igor${EXE}`), path.join(dir, `Igor${EXE}`)].find(
    found,
  );
  if (!got) throw new Error(`no Igor in ${dir}`);
  fs.chmodSync(got, 0o755);
  return got;
}

export function runtime() {
  if (process.env.BARKLEY_RUNTIME) return process.env.BARKLEY_RUNTIME;
  if (found(path.join(MAC_RUNTIME, 'html5'))) return MAC_RUNTIME;
  const runtimes = path.join(TOOLS, 'runtimes');
  const rt = path.join(runtimes, `runtime-${RUNTIME_VERSION}`);
  if (found(path.join(rt, 'html5')) && found(igorIn(rt))) {
    if (OS === 'linux') linuxPostInstall(rt); // idempotent; a restored cache may predate it
    return rt;
  }
  console.log(`- installing runtime ${RUNTIME_VERSION} (html5) into ${rt}`);
  const igor = bootstrapper();
  run(
    igor,
    [
      `/rp=${runtimes}`,
      `/ru=${RUNTIME_FEED}`,
      `/uf=${needUserFolder()}`,
      `/m=html5,base-module-${OS === 'osx' ? 'osx' : OS === 'win' ? 'windows' : 'linux'}-${ARCH}`,
      '--',
      'Runtime',
      'Install',
      RUNTIME_VERSION,
    ],
    { cwd: path.dirname(igor) },
  );
  if (OS === 'linux') linuxPostInstall(rt);
  if (!found(path.join(rt, 'html5')) || !found(igorIn(rt)))
    throw new Error(`the runtime install left no ${igorIn(rt)}`);
  return rt;
}

// What the runtime's bin/linux-post-install.sh does, for this architecture only: the script walks every architecture
// with set -e, so it dies on the first one that wasn't installed. It marks the tools executable and links, beside
// Igor, the folders the asset compiler reads.
function linuxPostInstall(rt) {
  for (const dir of ['igor', 'assetcompiler', 'webserver'].map((d) => path.join(rt, 'bin', d, 'linux', ARCH))) {
    if (!found(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isFile() && !e.name.includes('.')) fs.chmodSync(path.join(dir, e.name), 0o755);
  }
  const igorDir = path.dirname(igorIn(rt));
  for (const target of [
    'FiltersAndEffects',
    'assetcompiler/ParticleImages',
    'assetcompiler/Shaders',
    'assetcompiler/BuiltinFonts',
  ]) {
    const link = path.join(igorDir, path.basename(target));
    let exists = true;
    try {
      fs.lstatSync(link);
    } catch {
      exists = false;
    }
    if (!exists) fs.symlinkSync(`../../../${target}`, link);
  }
}

const igorIn = (rt) => path.join(rt, 'bin', 'igor', OS === 'win' ? 'windows' : OS, ARCH, `Igor${EXE}`);

// Igor, the runtime it belongs to, and a user folder with a licence: everything an HTML5 build needs.
export function igor() {
  const rt = runtime();
  return { igor: igorIn(rt), runtime: rt, userFolder: needUserFolder() };
}

let browser;
export function chrome() {
  return (browser ??= findChrome());
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  if (found(MAC_CHROME)) return MAC_CHROME;
  const dir = path.join(TOOLS, 'chrome');
  const bin = () =>
    found(dir) &&
    fs
      .readdirSync(dir, { recursive: true })
      .map((f) => path.join(dir, f))
      .find((f) => /chrome-headless-shell(\.exe)?$/.test(f) && fs.statSync(f).isFile());
  if (bin()) return bin();
  console.log(`- installing chrome-headless-shell ${CHROME_VERSION} into ${dir}`);
  run('npx', ['-y', '@puppeteer/browsers@2', 'install', `chrome-headless-shell@${CHROME_VERSION}`, `--path=${dir}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!bin()) throw new Error(`no chrome-headless-shell in ${dir}`);
  return bin();
}

if (import.meta.main) {
  console.log(`ProjectTool:  ${projectTool()}`);
  const g = igor();
  console.log(`runtime:      ${g.runtime}`);
  console.log(`Igor:         ${g.igor}`);
  console.log(`user folder:  ${g.userFolder}`);
  console.log(`browser:      ${chrome()}`);
}
