# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Always keep this file up to date.** Before you finish any session that changed or taught you something, update CLAUDE.md to match. That covers new commands, paths, gotchas, fixes, outputs, environment facts, and changes to current state and next steps. Remove anything that's no longer true. Treat a stale CLAUDE.md as a bug. Keep it lean: per-patch and per-transform detail belongs in `src/README.md`, and history (old versions, old deploys, finished investigations) doesn't belong anywhere once it stops being useful.

## What this is

This is a port of _Barkley, Shut Up and Jam: Gaiden_ v1.20 to **GameMaker LTS 2026**. The starting point is a **GameMaker: Studio 1.4 GMX export** decompiled from a Game Maker 6 executable, kept pristine at `game/BarkleyV120.gmx`. The work lives in `src/`: Node.js tooling that migrates that export reproducibly. It has no npm dependencies. `src/README.md` has the full pipeline description (every patch and transform, and the fuzzer's design).

That export was originally made by hand. `virt/` reproduces it from the original executable without a person at the keyboard; see "Rebuilding the pristine export" below. It is a separate concern from `src/` and nothing in the port depends on it.

**The final export target is HTML5 (a web port).** The HTML5 target is installed; build and test against it.

**The port is versioned with semver, in `src/version.json` — not with build numbers.** One file, read by
`import.mjs` (the HTML5 options), `offline.mjs` (each build's `version.json`, which is how a player's browser
notices a new build) and `deploy.mjs` (which prints it and warns when the live site already has that version with
different files); the Start screen shows it. Bump it by hand before a deploy: patch for a fix, minor for something
a player can see, major for a break in what carries over (saves, resume states, crash reports). Migrations and
imports are named after it: `build/outputs/barkley-<version>.gmx` and `build/outputs/barkley-<version>/`.
Tag a deployed version in git (`git tag v<version>`).

Don't hand-edit the GMX resources in `game/BarkleyV120.gmx` (`objects/`, `scripts/`, `rooms/`, …) — it is the pristine input. Every change to the game should come from `src/`, run against that export, so the migration stays reproducible. Keep the tooling minimal: don't write more code than needed.

## Commands

```sh
# 1. Migrate the pristine GMX into a new GMX (refuses to overwrite; about 25 s).
#    --mode=modernized is the default, and the user wants it unless they say otherwise: it applies
#    patches/*.patch, then patches/modernized/*.patch (web adaptations). --mode=faithful applies only patches/*.patch.
#    Name the output after the version in src/version.json: build/outputs/barkley-<version>.gmx.
node src/migrate.mjs game/BarkleyV120.gmx game/original build/outputs/<out>.gmx

# 2. Headless import into an LTS project via the IDE's ProjectTool (about 40 s–2.5 min).
#    Exits 1 if the importer reports GML it could not convert. Writes an mvc/ folder into <out>.gmx.
#    Also writes the HTML5 options the importer skips (page title, src/web/index.html as the custom index), the
#    extensions (Fullscreen always; Resume, Saves, Touch, Gamepad, Controls and Crash only for a modernized migration, each gated on a
#    script the modernized patches add), and Included Files for the page (src/web/manifest.webmanifest,
#    icon-180/192/512.png resized with ffmpeg from src/web/icon.png, and the font src/web/inter.woff2 with inter-OFL.txt;
#    to change the app icon, replace icon.png and re-import).
node src/import.mjs <out>.gmx <newdir>/<Name>.yyp

# 3. Build HTML5.
#    Deployable build (the supported way; unobfuscated + terser --keep-fnames, so player crash reports have readable
#    gml_* stacks). Works on copies of the project and user folder; don't run Igor and terser by hand for a deploy:
node src/fuzz.mjs build <.yyp> <dir> --minify
#    fuzz.mjs build always takes the page from the current src/web/index.html, so a page-only change needs no re-import.
#    It also writes the offline layer into the build root: src/web/sw.js and version.json, the file list the service
#    worker caches the build from (src/README.md, "Offline play"). Neither needs a re-import either.
#    Plain Igor build (about 1 min, obfuscated). --tf is required; without it Igor deploys, then crashes and exits 1:
RT=/Users/Shared/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-2026.0.0.23
"$RT/bin/igor/osx/x64/Igor" -j=8 --project=<.yyp> --rp="$RT" \
  --uf="$HOME/Library/Application Support/GameMakerStudio2-LTS2026/wyattstanke_5117727" \
  --cache=<dir>/cache --temp=<dir>/temp --of=<dir>/out/index.html --tf=<dir>/pkg -r=VM -- html5 folder

# 4. Play-test the build in headless Chromium: screenshots + console; exits 1 on an uncaught exception.
#    It clicks the page's Start button as soon as it's enabled, which is once the game has loaded (builds without one start on load).
#    Keys: Z action, X cancel, arrows; a modernized build also takes W/A/S/D, J (action) and K (cancel).
#    A modernized build also takes a game controller; a play-test fakes one by overriding navigator.getGamepads
#    in a js: step (the shim polls it every frame, so changing the fake pad's buttons or axes drives the game).
#    The intro takes about 12 s to reach the title screen.
#    The page is opened with ?nosw, so the service worker stays out of a play-test (it would cache the whole build
#    from the python server every run); SW=1 leaves it in, to test offline play.
#    The browser is muted (--mute-audio); AUDIO=1 unmutes it. js:<file> evaluates a JS file in the page and logs the
#    result; in an unobfuscated build it can call gml_Script_<name>(inst, other, …) and read global.gml<name>.
#    console.txt is rewritten after every step, so a hung run still leaves its log.
#    SIZE=1280x720 sets the window (default 1024x768). DEVICE=390x844@3 emulates a phone instead (touch events,
#    mobile viewport, device pixel ratio), which the touch overlay needs; then tap:<x>x<y>, hold:<x>x<y>@<ms> and
#    drag:<x1>x<y1>><x2>x<y2>[@<ms>] work. Steps are comma separated, so touch coords use x and @, not commas.
#    The canvas fills the window: faithful draws the game at the largest whole-number scale (1024x768 → 3×,
#    960×720 at (32,24)); modernized defaults to Sharp fit (1024x768 → 3.2×, 1024×768).
node src/playtest.mjs <dir>/out <testdir> 'wait:14000,shot:title,key:Z,wait:3000,shot:after'

# 5. Serve a build for the user to play by hand (playtest.mjs uses 8766, so any other port is free).
#    Run it in the background; it keeps serving until killed. Saves live in localStorage per origin,
#    so a given port keeps its own saves and resume state.
cd <dir>/out && python3 -m http.server 8000 --bind 127.0.0.1   # then http://127.0.0.1:8000/

# 6. Fuzz (see src/README.md "Fuzzing"). Needs an unobfuscated build (`build`, ~70 s, as in step 3).
#    `run` searches until Ctrl-C or --minutes; --save keeps findings in build/fuzz/<date-time>/ (summary.md, crashes/<n>/,
#    paths/<n>-<room>-p<plot>/), --verbose prints a line per episode, --workers defaults to physical cores - 2.
#    --corpus keeps the archive in build/fuzz/corpus between runs; --through patches known crash classes and reports each
#    patched spot instead. `replay` plays a finding from a fresh page with screenshots, or a player's crash report
#    (BARKLEY-CRASH-1: text) against the build it came from. Uses ports 8870 (server) and 9400-9499 (browsers);
#    `--port=N` moves them to N and N+530 to N+629, so two fuzz processes can run at once.
#    Run long jobs under `caffeinate -i` (a run during laptop sleep gave 108 browser restarts and useless data).
node src/fuzz.mjs build build/outputs/barkley-1.3.1/BarkleyLTS.yyp build/fuzz/build
node src/fuzz.mjs run build/fuzz/build --save --corpus --through --verbose
node src/fuzz.mjs replay build/fuzz/build build/fuzz/<run>/crashes/1

# Regenerate the GML parser after editing src/lib/gml.peggy (never edit gml.parser.mjs by hand)
npx -y peggy@5.1.0 --format es --allowed-start-rules Program,Tokens -o src/lib/gml.parser.mjs src/lib/gml.peggy

# Format (no config file; these flags match the existing style; skip the generated parser)
npx prettier@3.9.6 --write --single-quote --print-width 120 "src/**/*.mjs" "!src/lib/gml.parser.mjs"
```

For **readable runtime stacks** from a plain Igor build, use a copy of the user folder (in a temp dir, never edit the real one) whose `local_settings.json` sets `"machine.Platform Settings.HTML5.obfuscate": false` and `"machine.Platform Settings.HTML5.pretty_print": true`. `fuzz.mjs build` does exactly this. The default build obfuscates, and stacks show names like `_pN2`.

Put builds, test output and throwaway migrations in a temp or scratchpad dir, not the user's projects.

There's no test suite. Verify in these ways:

- The final audit in `migrate.mjs` should print "No items to review".
- Two runs into different output dirs should be identical under `diff -r`. Use `-x mvc` if either has been imported. Don't expect two imports of identical GMX to match: ProjectTool gives sprite frames and layers random GUIDs and names the `notes/compatibility_report_*` folder by time, and `options_html5.yy` holds the absolute path of the index. Compare the migrations, and the imports' `extensions/`.
- After a grammar or transform change that shouldn't change output, migrate into a new dir and `diff -r` against the previous output. If they're identical, import, build and play-test can't have changed.
- Every `.gml` in a code tree should parse with `parse()` from `src/lib/gml.mjs`. This is a weak syntax check: when a keyword statement fails to parse, the PEG falls back to a plain statement, so `if (a) = 3` with no body parses as assigning to a call `if(a)`, and `if = 3`, `with = 2` or a bare `return` at end of file also pass. The LTS importer is the real syntax check.
- Every called function should exist in LTS. Walk the code tree with `parse`/`walk`/`isCall`, then subtract the built-ins from `$RT/GmlSpec.xml` (`<Function Name="…">`, about 2,357), the project's `scripts/`, the imported project's `scripts/` (the importer's compatibility scripts: `instance_create`, `joystick_exists`, `joystick_direction`, `joystick_check_button`, `draw_set_blend_mode`, `room_set_view`), and the extension functions (listed per extension in `import.mjs`: `fullscreen_*`, `resume_*`, `saves_open`, `touch_*`, `crash_*`). Nothing should be left.
- `import.mjs` should report "importer converted all GML". The strongest check: scan the imported `.gml` for single-quoted strings outside `"…"` strings and comments. Any hit means the importer skipped that file.
- Igor should exit 0 and `playtest.mjs` should show no exception. On HTML5, a GML runtime error shows up as `Unhandled Exception - Uncaught { message : … stacktrace : [ … gml_Script_…/gml_Object_… ] }`.

## Layout

Everything lives in `~/Documents/barkley/`, which is both the working directory and a **git repo**
(initialised 2026-09-20; no remote — the deploy repo below is separate). `.gitignore` keeps the
generated and bulk-binary folders out, so only `src/`, `virt/`, `docs/`, `game/recovered-scripts/`,
`.gitignore` and this file are tracked.

```
barkley/
  CLAUDE.md      this file
  src/           all the tooling (Node.js 22+, no npm packages)
    *.mjs        the pipeline: migrate, import, playtest, fuzz, deploy, assets, transforms, offline
    version.json the port's semver version, the one place it is written
    lib/         the GML grammar/parser and the GMX code (un)packer
    patches/     hand-written GML rewrites; modernized/ holds the web adaptations
    web/         what ships into the page: index.html, the 7 extension shims, sw.js, the PWA assets
    README.md    the full pipeline description
  virt/          makes game/BarkleyV120.gmx from the original exe (see its README)
  game/          inputs: large, immutable, untracked (except recovered-scripts/)
  docs/          an earlier audit page
  tools/         the GameMaker Studio 1.4.9999 installer and a how-to video, for virt/'s unused VM (untracked)
  build/         everything generated; all of it reproducible from src/ (untracked)
```

Anything not in that tree (a throwaway migration, a test build, scratch output) goes in a temp or
scratchpad dir, never in the project.

- `game/BarkleyV120.gmx`: the pristine export, and `migrate.mjs`'s first argument. **Read-only; never write to it.**
  It is 28 MB (the migrated output is ~185 MB, because the migration brings in the real music). A copy is in
  `~/Documents/barkley copy/BarkleyV120.gmx.orig`, a backup of the pre-reorganisation layout from 2026-09-19.
- `game/original/`: the original distribution (exe, `.gm6`, `Music/`, `Voice/`, `BG/`, `bgm.dll`), and `migrate.mjs`'s second argument.
  - `GMDecompilerDecompiled/`: Java source of the GM6 decompiler that produced the export. It's the reference for the exe format `importFonts` reads.
- `game/recovered-scripts/`: the 8 scripts lost to case collisions (the patch source for `sBeatAdd`). Small, so it's the one tracked part of `game/`.
- `game/releases/`: zips of other releases (V106–V110, and OS X and RPG Maker 2003 versions).
- `docs/Barkley Gaiden Port Audit.html`: an earlier audit page.
- `build/outputs/`: migrations and their imports. **The user wants only the latest kept**: when you make a new one, delete the superseded migration and import (the user OK'd that).
  - Latest: `barkley-1.3.1.gmx` (plus `.code`) and its import `barkley-1.3.1/BarkleyLTS.yyp` (2026-09-22): audit clean, importer converted all GML, all seven extensions plus the PWA files. This is what is deployed; `barkley-1.3.0` was deleted for it (it is reproducible from the `v1.3.0` tag), and the `.gmx` is byte-identical to it. The offline layer needs no re-import: `fuzz.mjs build` writes `sw.js` and `version.json` into the build. **An edit to a shim in `src/web/` does need one** (or a copy of that file over the project's `extensions/<Name>/`): only `index.html` is taken from `src/web/` at build time.
  - After an Igor build, copy `src/web/index.html` back into the project's `options/html5/` (see the HTML5 options gotcha).
- `build/deploy/bsuajg-test`: `deploy.mjs`'s kept clone of the deploy repo (shallow; reset to `origin/main` on every deploy, so never keep work in it).
- `build/fuzz/`: the fuzzer's files.
  - `corpus/`: the persistent archive (`--corpus`: `state.json`, `nodes.json`, `nodes/<id>.json.gz`), tied to a build by the md5 of `BarkleyLTS.js` and rebased automatically when that changes.
  - `build/`: an unobfuscated build of `barkley-1.3.1` (2026-09-22). The corpus belongs to it, but it holds only what one hour found: a run with the broken harness (below) rebased 0 of 60 paths and still saved the corpus as this build's, so every older snapshot was dropped. **A rebase that makes no snapshots should not be saved; `rebase()` doesn't check that yet.**
  - `<date-time>/`: `run --save` findings. Kept: `2026-09-18-122255` (the 2-hour run on the v25 build) and `2026-09-23-run` (1 hour on v1.3.1), both cited under Current state.
- GameMaker LTS 2026 (this Mac is **x86_64**; the arm64 binaries don't run):
  - ProjectTool: `/Applications/GameMaker LTS 2026.app/Contents/MacOS/x86_64/packages/project-tool-osx-x64/ProjectTool`. It must run with that directory as cwd. Import = `SCRIPT PATH=<file>` containing `PROJECT OPEN SOURCE="<.project.gmx>"` then `PROJECT SAVE DESTINATION="<.yyp>"`.
  - Runtime: `/Users/Shared/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-2026.0.0.23`. Igor is at `bin/igor/osx/x64/Igor`. HTML5 runner: `html5/`.
  - User folder: `~/Library/Application Support/GameMakerStudio2-LTS2026/wyattstanke_5117727`. It holds the `licence.plist` Igor needs. `unknownUser_unknownUserID` is the old signed-out folder and has no licence.
- Headless browser for `playtest.mjs`: Playwright's cached `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell` (override with `CHROME=`). There's no `playwright` npm package; the script talks to the DevTools protocol directly.

### The web deploy: `github.com/Wyatt-Stanke/bsuajg-test`

It holds the contents of an HTML5 build's `out/` dir plus `README.md` and `.github/workflows/static.yml`, which deploys to GitHub Pages on every push to `main` (the origin is `wyatt-stanke.github.io`). The workflow pins `actions/checkout@v4`, `configure-pages@v5` and `upload-artifact@v4`, which target the deprecated Node 20; the runner forces them onto Node 24 and warns. They'll need bumping at some point.

**Live: `3b7522f`** (2026-09-22), v1.3.1, the modernized build of `barkley-1.3.1`, deployed with `deploy.mjs`: the same game as v1.3.0, rebuilt from an export `virt/` now makes on its own. Build id `cf172539be62bdd4`, 262 files cached. `BarkleyLTS.js` md5 `0747ac35d5b8a8e4b80fe5227ac793b9`; `index.html` md5 `7769c6b48933acfb6fed259c47805939`; `sw.js` md5 `8352242ca58c04a4c488f81a8d89eef7`; `version.json` md5 `2dd8f06063a5394d51e5765325b9f6c2`; shims `tph_crash.js`, `uph_controls.js`, `vph_gamepad.js`, `wph_touch.js`, `xph_saves.js`, `yph_resume.js`, `zph_fullscreen.js`, plus `inter.woff2` and `inter-OFL.txt` (a new extension shifts every shim's prefix, so they must ship with their bundle).

**The deploy repo's history was flattened on 2026-09-22** (the user asked for it, with that deploy): its 26 commits, each a whole ~150 MB copy of the build tree, became the single orphan root commit `3b7522f`, force-pushed to `main`. The tree hash is unchanged (`2a3cee26`, 482 files) and the live site never moved, but **every earlier deploy hash is gone** — `61c0307` (v1.3.0), `7191192` (v1.2.2), `b7599e9` (v1.2.1), `0b65adb` (v1.2.0), `068a661` (v1.1.1), `58167a6` (v1.1.0) and the rest no longer resolve. This file's older entries name them only as labels. `deploy.mjs` needs no change: it resets to `origin/main` and commits on top, so the next deploy is the second commit in the new history. **Don't flatten again without being asked**; the history that is left is the record.

**To deploy, run one command** (about 6 min with a build, ~2 more for the first clone):

```sh
node src/deploy.mjs build/outputs/<import>/BarkleyLTS.yyp --message-file=<file>   # or a build dir instead of a .yyp
```

It builds with `fuzz.mjs build --minify`, writes the offline layer over whatever built the tree (`sw.js` and a fresh `version.json`, and warns if the live site already has this version with different files), play-tests the build (boots, Start clicked, no exception), clones or reuses `build/deploy/bsuajg-test`, resets it to `origin/main` (deploys are pushed from several sessions, and committing on a stale tree drops the ones in between), rsyncs the whole build over it (shims have a per-build prefix, `tph_`, `uph_`, …, so they must ship with their bundle), commits as the previous deploy's author, pushes, watches the Pages workflow, and checks the live `index.html`, `version.json`, `sw.js` and game script md5s (cache-busted, retried while the CDN catches up) and that every shim answers 200. It exits non-zero at the first failed step and stops with a note if the site already has the build. `--dry-run` stops after the local commit. Write the commit message in the style of the earlier deploys ("Update HTML5 build: …", a paragraph for players, then the attribution trailers).

## Rebuilding the pristine export (`virt/`)

`game/BarkleyV120.gmx` came from running a Java GUI decompiler over
`game/original/BarkleyV120.exe` and importing the resulting `.gm6` into GameMaker: Studio 1.4.9999
by hand. `virt/` automates that. **It is not part of a normal day's work** — the export is pristine
and immutable, so this only matters if it ever has to be regenerated or audited.
`virt/README.md` has the detail; what follows is what you need before opening it.

```sh
virt/run.sh                  # both steps: the exe -> build/virt/BarkleyV120.gmx (~3 min)
virt/decompile.sh [out.gm6]  # step 1 alone: the exe -> build/virt/BarkleyV120.gm6 (~75 s)
virt/convert.sh [in] [out]   # step 2 alone: the .gm6 -> the .gmx (~1 min)
```

**Neither step needs Windows: both are Java in a container** (podman, or docker; override with
`BARKLEY_CONTAINER`). Temurin 8 exactly for both — the decompiler's `ProgressDialogListener` calls
`Thread.stop()`, removed in Java 20, and LateralGM's own Makefile targets 1.7 under 8.

- **Step 1, the exe to a `.gm6`.** Output is byte-identical to the GUI's: **10,720,322 bytes,
  sha256 `4b76af44edbf8c6bd980a7693e78520646059ec6edbacf4051b336dfb30f9b32`**, checked by the script.
  `virt/java/Decompile.java` is what makes it headless: the decompiler reads its input path out of a
  Swing text field (`GmDecompiler.sourceField`), so that field is filled in rather than a window built.
- **Step 2, the `.gm6` to a `.gmx`, uses [LateralGM](https://github.com/IsmAvatar/LateralGM)**, which
  reads GM6 and writes GMX directly — no IDE, no licence, no GUI automation. It is cloned at a pinned
  commit, `virt/lateralgm/patches/*.patch` are applied at build time (nothing is vendored), and
  `virt/lateralgm/Gm6ToGmx.java` drives it headless. The four patches fix what its GMX writer loses:
  the transparency key (java.awt's `RGBImageFilter` clears the colour under the pixels it makes
  transparent, and backgrounds never got the key at all), smooth edges (`alpha = 255 - 32 *
  transparent neighbours`, which GMX has no field for so GameMaker bakes it into the PNG),
  separate collision masks (no GM6 field, so the property defaulted false and every frame of an
  animation would have shared one mask; GameMaker's import gives all 458 sprites
  `<sepmasks>-1</sepmasks>`), and the size of a frameless sprite (`0` rather than GameMaker's `32`;
  importing a 0x0 sprite leaves `frames`, `layers` and `sequence` null in the `.yy` and the asset
  compiler dereferences them, so the build dies in `GMSprite.SetFromResource`).
- **The output is `build/virt/BarkleyV120.gmx` and `BarkleyV120.gmx.tar` beside it.** The tar keeps
  `sA.gml` beside `sa.gml` and `bgm_Init.gml` beside `bgm_init.gml`; a case-insensitive filesystem
  collapses each pair, which is exactly what happened to the pristine export and why
  `game/recovered-scripts/` exists.

**Reading a GMX that GameMaker did not write.** `src/lib/gmx.mjs` and `src/migrate.mjs` used to
assume GameMaker's own serialisation — attributes in a fixed order, CRLF, `&#xA;` and nothing else,
`<caption>` and `<glyphs>` never self-closed. None of that is what the XML says, and a GMX from
another writer parsed as an empty project. They now match attributes by name, decode numeric
character references generally, follow the file's own line ending, and accept self-closing empty
elements. Keep it that way; it costs nothing and the pristine path is unchanged by it.

**The Windows VM is still in `virt/` and nothing uses it.** It was the plan for step 2 and never
finished: the crack runs, the export step does not. Two things about it are worth knowing if it is
ever picked back up — it bugchecks under `-cpu host` on HVF (fixed by `Penryn`, the default now;
masking TSX and dropping to `-smp 1` were both dead ends), and WinRM lands in session 0, which has
no desktop, so anything with a window goes through `Invoke-InSession` in `virt/guest/lib.ps1`.
`virt/README.md` has the rest.

## Architecture of `src/`

The pipeline lives in `migrate.mjs`. It copies the project, unpacks the code, applies patches, generates `scripts/sRoomCaption.gml`, runs the transforms, packs everything back, imports assets, changes settings, and audits. `src/README.md` ("Pipeline order") describes every patch and transform; below is what you need to work on them.

- **`sRoomCaption(room)`** is an if-chain built from every room's GMX `<caption>`. LTS rooms have no caption, so `room_caption` is gone (the audit flags it). Patch 12 uses it for `oController`'s room-name banner and, in Room Start, for `window_set_caption` (the page title on HTML5; rooms with an empty caption get "Barkley, Shut Up and Jam: Gaiden").
- **`lib/gml.peggy`**: a Peggy (PEG) grammar for **GM6/1.4 GML**. Existing GML parsers target modern GML and reject this code.
  - `lib/gml.parser.mjs` is generated from it (command above) and checked in, so running the tooling still needs no npm packages.
  - `lib/gml.mjs` wraps it: `parse` (start rule `Program`), `tokenize` (start rule `Tokens`, used by the audit), `walk`, `applyEdits`, `isCall`.
  - AST **key order** matters: `walk` visits `Object.values` and `cinema` numbers `cin_NNNN` in visit order. `Binary` is `{type, op, left, right, start, end}`; every other node is `{type, start, end, …}`.
  - Whitespace and comments are skipped only _before_ tokens, so a node's `end` is its last token.
  - The 1.4 rules it follows: `'…'` and `"…"` strings have no escape sequences; semicolons are optional; `=` is comparison inside expressions; only identifiers can be called (that's how `if (a) (b).c=d` parses as an `if` whose body is `(b).c=d`).
  - Nodes carry `start`/`end` source offsets. Transforms collect `{start,end,text}` edits and `applyEdits` splices them, so original formatting survives. Edits must not overlap: a rewrite that wraps a node emits separate edits around its children rather than replacing the whole node.
- **`lib/gmx.mjs`**: `unpack` turns GMX XML code into a plain LF tree: `scripts/<name>.gml`, `objects/<obj>/<eventtype>_<enumb|ename>[_<action>].gml` (only code actions, id 603), `rooms/<room>/creation.gml` and `rooms/<room>/<instance>.gml`. `pack` writes it back; unchanged code keeps its original bytes (CRLF, `&#xA;`). Both read XML by attribute name and follow the file's own line ending, so a GMX from a writer other than GameMaker's (LateralGM, in `virt/`) works too. Adding or removing a `.gml` registers or unregisters the script in `project.gmx`; a new `objects/<name>/` folder becomes a new object; `pack` also writes code for a room instance that had none. **`pack()` can't add an event to an existing object**, so a change that needs a new event goes in a new object.
- **`patches/NN-*.patch`**: unified diffs (`patch -p1`) for hand-written logic rewrites, applied after the `bgm_*`/`rt_*` deletion and the `sa.gml`→`sA.gml` rename, and **before the transforms** (so they see pre-transform text: `sound_play`, not `audio_play_sound`). There's no script for generating patches. To add one:
  1. Copy the pristine export to a temp dir and `unpack()` it.
  2. Replay that deletion and rename, then apply the existing patches.
  3. Copy the files you're changing into `a/` and `b/`, and edit `b/`.
  4. Run `diff -ruN a b`, rewrite the headers to `a/…`/`b/…`, and confirm with `patch --dry-run`.
- **`patches/modernized/NN-*.patch`** apply after them, in modernized mode only. **Faithful-mode output must stay byte-identical** to what it was before a modernized patch was added; a transform can check `ctx.mode`, but in faithful mode it must leave the source unchanged. Notes beyond README's descriptions:
  - `01-scaling-options`: Integer / Sharp fit (`global.sat[0]`, default 1 = Sharp fit) replaces `SCALING x1 x2 x3`.
  - `02-wasd-jk-keys`: aliases via `keyboard_set_map` in `key_doset` (through `key_alias`), so they follow rebinding. On HTML5 a key map copies the physical key's held and pressed state onto the target key every frame.
  - `03-key-latch` + the `keyLatch` transform: `key_check`/`key_clear`/`key_release`, so a cleared key reads as up until released, as GM6's `keyboard_clear` evidently did. `key_clear` latches only a key that is down, and sets the latch to 2, "set this step"; `key_release` ages a 2 to 1 without testing it and only releases a 1 whose `keyboard_check` is 0. See the `keyboard_clear` ordering gotcha for why.
  - `05-fullscreen-toggle`: SCREEN applies at once; Begin Step copies `fullscreen_get()` into `global.sat[1]` when it changes (`fsnow`/`fsseen`), before the rebinding `exit`, so Esc leaving fullscreen shows Windowed.
  - `06-resume` (+ the `resume` transform, `resume.js`): keeps the game state across a tab reload or close, in `localStorage` key `barkley.resume`. `resume_tick` (in `oController` Begin Step) hands `resume_save()` JSON to `resume.js` every 30 steps; Game Start's `resume_start` goes to the saved room; Create events, creation code and Room Start exit meanwhile; the first Room Start runs `resume_restore`. `oResumeMark` (event-less) uses up the instance id counter; `resume_play` wraps `audio_play_sound` to keep sound handles. `resume_start` refuses a state whose `build` ≠ `GM_build_date`. An uncaught error forgets the state so a bad one can't loop. `resume_state` is a plain page global, readable with a `js:` probe even in an obfuscated build.
  - `07-crash-report` (+ `crash.js`): every 30 steps `resume_tick` hands the checkpoint to `crash_put` and reseeds the RNG from `global.crash_seed`; each step reports its frame time (`crash_step`); `crash.js` records key events and keeps a ring of checkpoints. On an uncaught error, or when the player types `BUG` (capitals), the page shows a `BARKLEY-CRASH-1:` report (gzip + Base64: the checkpoint about 10 s back, frame times and key events since, the error or the current state) to copy. `fuzz.mjs replay <build dir> <report file>` replays it; the build must be the one the report came from (obfuscated or minified rebuilds are not byte-identical, and `resume_start` rejects another `GM_build_date`). Not yet tried on a real player's report.
  - `08-volume`: VOLUME row (11 steps in `global.sat[6]`, sixth line of `config.txt`), applied through `audio_master_gain` from `oStartConfig`'s Begin Step and `oController`'s Game Start. **The steps are equal in decibels**, via `sVolume(step)` = `power(10,(step-10)*0.2)` (4 dB a step, 50% = -20 dB, step 0 = silence); the label shows the slider position, not the gain.
  - `09-save-transfer`: Saves replaces Test on the SETTINGS row and calls `sSaveData`, which opens `saves.js`'s panel (the slots as one `BARKLEY-SAVES-1:` Base64 gzip block to copy out or paste in).
  - `10-touch-controls` (+ `touch.js`): the mobile touch overlay and the high-DPI canvas.
  - `11-gamepad` (+ `gamepad.js`): game controllers. `key_doset` passes the bound keys to `pad_keys` and `oController`'s Begin Step passes `sTouchContext()` to `pad_context`. The shim polls the Gamepad API once a frame in its own rAF loop and sends those keys through `window.onkeydown`/`onkeyup`, exactly as `touch.js` does, so a pad press is a key press everywhere (rebinding, the key latch, menus). D-pad and left stick steer (on past 0.45 of the stick's travel, off inside 0.3, repeating while held); faces 0/2 confirm, 1/3 and both shoulders cancel; 8/9 are Start. A press is held out to 100 ms so a tap between two 30 fps steps is never lost, and context 4 (SET KEYS) releases everything and sends nothing. The game's own `key_joyemu` is untouched: its one call site was already commented out in the original.
  - **The Configuration menu is full.** Column 1 (x=151) holds rows 0-4 at y=1/49/97/145/193; column 2 (x=1) holds SET KEYS, LANGUAGE (y=145) and VOLUME (y=193); SETTINGS is full at three options (a fourth doesn't fit: the blips sit at a fixed pitch `xs + spc*k` while labels have their own widths, so a fourth blip overlaps a label or leaves the 168-wide panel). See the fonts gotcha for how to lay out a row.
- **`transforms.mjs`**: ordered AST transforms. Order matters:
  1. `cinema` and `objectAdd` run first. They pull GML out of strings into files: 486 deduplicated `cin_NNNN` scripts, and `<Owner>FxN` objects. So the later rewrites also reach that code.
  2. Then `renameSa`, `imageSingle`, `parenStatements`, `reservedWords`, `sound`, `legacyCalls`, `drawTextStrings`, `gm6Real`, `noInstanceAssign`, `creationCodeFirst`, `keyLatch` (modernized), `argumentDefaults`, `resume` (modernized).

  Any removed function you rewrite should also go into the `REMOVED` audit regex in `migrate.mjs`.

- **`assets.mjs`**:
  - Maps placeholder sounds to real files by parsing the game's own `sound_replace` calls. MP3s are copied as-is and marked streamed. The placeholders are the 44 music sounds (identical 845-byte near-silent WAVs); none are left in a migrated output. Every other sound in the export is byte-identical to the one in the exe.
  - `markStereoSounds` sets `<type>1</type>` on every sound whose file has 2 channels (found with `ffprobe`; 37 sounds: the stereo music, `mTOGS`, `mBoom`, `mBBinary`). The importer otherwise makes every sound mono. No GM6 sound has a non-zero `<pan>`. GM6 DirectX `<effects>` (chorus, echo, …) aren't migrated.
  - Converts the 1×1 placeholder backgrounds and battle backdrops `BG0-13` (frames of `sBBattle`) from GIF with `ffmpeg`.
  - `importFonts` replaces every font's PNG and `<glyphs>` with the original GM6 glyph bitmaps from `BarkleyV120.exe` (it inflates the game data and undoes GM6's byte substitution, as `GmExtractor.extractStandalone` does, then finds each font by its name, face name and the 32–127 range). Applies in both modes.
- **`playtest.mjs`**: HTML5 smoke test. It serves the build with `python3 -m http.server` on port 8766 and drives Chromium over DevTools on port 9333. Those ports are fixed, so run one playtest at a time.
- **`fuzz.mjs` and `fuzz-page.js`**: the fuzzer; `src/README.md` ("Fuzzing") describes the design (virtual time, snapshots, Go-Explore search, generators, crash verification). Facts not in README:
  - `fuzz.mjs` prepends `window.__fuzzNames`: runtime variable names it finds by regex in the unobfuscated bundle (RNG `state` and its index/seed vars, the instance id counter, the surface stack, the mouse dispatcher; for restores, the room method that removes destroyed instances and the room global, `_Jm3` on `_d4`, and the frame pacing's due time, `_BE3`). The regexes for the first group handle the minified build too; the restore ones are only checked on the unobfuscated build (a crash report's replay doesn't need them).
  - Runtime facts it relies on: the frame function is scheduled through a `requestAnimationFrame` alias captured at script load (so the harness overrides rAF before load); `current_time` is `performance.now()`; `game_restart()` re-runs Game Start in place without resetting globals or the id counter; object events, room code and `script_execute` targets are direct function references in `JSON_game` (`GMObjects`, `Scripts`); `GetWithArray(-3)` is `with (all)`; globals are `global.gml<name>`. The RNG is fixed-seeded at load (16 LCG words); `Math.random` is used only by particles, sorts and shuffles, which the game never calls.
  - Game facts the generators rely on: the player is `oBarkley` (collision box 16×12 at +4,+19), moves with `move_contact_solid`, sprints while X is held; action makes every `oItem` run User Event 0, which fires User Event 1 on the one under the `oTalker` in front of the player (people are `oPlayer`→`oItem` children, doors `oExitN` N<200 are `oItem` children, walk-on exits are the ones with a `gml_Object_<obj>_Collision_oBarkley` event); input is ignored while `global.cinema`, `global.freeze` or `global.movefreeze` is set or an `oDialog`/`oStartmenu` exists. `dialog` also takes the game's own cutscene skip in 30% of runs: while `global.skipper` is non-zero, two presses of Start (`c`, with a release between) run `oController`'s User Event 0, the story-warp table.
  - Plot 3 needs `global.scheme[0]>=2` (talk to `oLarry` in `RomChurch`) and `global.scheme[3]=1` (talk to `oChin` in `RomStore0`), then a return to the apartment.
  - **A battle or a death mid-walk is never an exit's destination** (`INTERRUPTS` in `fuzz-page.js`: `RomInter`, `RomGameover`); otherwise a random encounter during a door walk made that door look ambiguous and `loadCorpus` dropped it.
  - **A node keeps its snapshot only when it owns a feature no other node owns**, and `choose()` draws only from nodes with a snapshot. So if an owner loses the state it claimed features from, the search is walled out of that room for good. `rebase()` (after a build change) replays each kept path from a fresh page and now refuses to let a replay that drifted to another room/plot inherit the features; `loadCorpus()` drops any feature whose room disagrees with its owner's room (and its `log` entries). Signature of this failure: the run status's `furthest` (computed over nodes that have a snapshot) is behind the corpus's `maxPlot`.
  - When reading a corpus by hand, globals in a snapshot's `resume` JSON are stored under their plain names (`plot`, `skipper`), not the page's `gml`-prefixed names.
  - `HARNESS` in `fuzz.mjs` is folded into the corpus build id; bump it when a harness change makes recorded paths play differently. `setPort(n)` and the exported `Browser`/`Fuzzer`/`harness`/`serve` make one-off probe scripts easy (the CLI runs only under `import.meta.main`).
- **`import.mjs` and `index.html`**: after importing, `import.mjs` writes `options/html5/options_html5.yy` (the importer never creates it) and copies `index.html` beside it. `index.html` is the runtime's template (`$RT/html5/index.html`, LF) with these changes:
  - `canPlayType` reports no Ogg support, so the runtime loads the MP3 of every sound (Safari's Vorbis decoder drops the first ~26 ms of a sound, which cut the menu cursor thump; the user confirmed the fix by ear).
  - **Font: Inter** (SIL OFL 1.1; the Latin subset with the weight and optical-size axes, from `@fontsource-variable/inter` 5.3.0), self-hosted as `html5game/inter.woff2` with `inter-OFL.txt` beside it, preloaded, `font-display: swap`, falling back to Helvetica/Arial. The code boxes use the system monospace.
  - **The Start word is the loading bar:** it fills grey to white, left to right, through a background-clipped gradient on a registered `@property --p` (animated 0.6 s linear). Progress is weighted 90% texture bytes, 10% the runtime's count of everything else: the runtime counts files, and ~180 small sounds (3.4 MB) finish long before the 9 texture pages (37 MB of the ~41 MB it loads), so counting alone sat at 89% for most of the load. To see texture bytes, the page overrides `HTMLImageElement.prototype.src` for `_texture_N.png` before Start: it downloads through `fetch` (priority low, as an image) with a stream reader, then loads the image from a blob URL; any failure falls back to the plain URL. Pages whose size isn't known yet count as the average known one.
  - **The page's whole UI is styled here** (Swiss, monochrome, Inter, flush left; the user wants it forgettable, the game the centrepiece). `saves.js`, `crash.js` and `touch.js` build plain DOM with its classes (`.ui-panel`/`.ui-head`/`.ui-cols`/`.ui-code`/`.ui-btn`/`.ui-link`, `#gmtouch`/`.gmt-*`) and carry no CSS, so a build that fell back to the default template also loses their styling. Panels sit above the touch overlay's hit layer (`z-index` 2147483600 vs 2147483000). A panel stops the key events pressed inside it from reaching the game, but passes through the release of a key pressed before it opened.
  - A `<button id="start">` covering the whole page (the game's name, "Start" in large type, a hint). **The game loads behind it:** `window.onload` calls `GameMaker_Init()`; `import.mjs` sets `option_html5_loadingbar` to `barkley_loading`, which the runtime calls every loading frame instead of drawing its bar, but only once the extension scripts have loaded (so a 100 ms timer also runs `barkley_show`), and CSS hides the runtime's `#loading_screen` canvas. The runtime's frame state machine starts the game in the same frame that sees the last asset loaded, so the page holds it at the one gap: a `console.log` hook throws a sentinel at "Entering main loop..." (logged after all loading, just before Game Start), a `requestAnimationFrame` wrapper catches it and keeps later frames in `barkley.held`, and Start is enabled. A click, a tap, or a character key, Enter or an arrow (`barkley.start()`) removes the page, resumes the recorded AudioContexts (the runtime unlocks audio on pointer presses only) and releases the frames, so the game starts at once. Keys before Start never reach the runtime. **Not resuming:** when `localStorage` holds `barkley.resume`, `#fresh` (a footer line flush with the words: "Continues where you left off." and the link `#fresh-go`, "Start from the title screen") shows; it's enabled with Start, and it or Enter/Space on it calls `barkley.start(true)`, which removes the key before Game Start's `resume_take` reads it. `resume.js` is unchanged. The wrappers are plain functions, since the runtime's error trace walks `arguments.callee.caller`. **Under the fuzz harness (`window.__fuzz`) none of this applies:** Start is enabled on load and runs `GameMaker_Init()`, because the harness wraps the game functions before init and filters rAF callbacks by name. `playtest.mjs` and `fuzz.mjs` find it by id. `playtest.mjs` clicks it at once, so to screenshot the Start screen or the install prompt, use a scratch copy with the Start-click loop skipped.
  - **The Controls link** (`#ctlbar`/`#controls-go`, bottom left, above `#fresh` when that shows): enabled by `barkley.ready()` when `controls_show` exists, and `barkley.controls()` opens `controls.js`'s panel. It lists the seven controls with the keys bound to them, read from the game's `controls.txt` in browser storage (the game has not run, so nothing can tell the page), the W A S D / J K spares, where to rebind, what a pad does, and a live test of all of it. **Nothing pressed in it may start the game:** the panel keeps its own key events, the Start screen's `keydown` handler returns while `#controls-panel` exists (Enter or Space on the link opens it instead), and `pad_quiet` mutes `gamepad.js`. **It polls on a `setInterval`, not `requestAnimationFrame`:** before Start the page's rAF wrapper holds every callback in `barkley.held`, which froze the test where it is most used. `B.start` removes `ctlbar` and the panel with the rest of the screen.
  - A hard-coded black page background (Igor substitutes `${GM_HTML5_BackgroundColour}` as the invalid `#0`).
  - **Streamed-sound guard (`barkley_audio_fix`) and the intro music's early decode (`barkley_early_music`):** see "Streamed sounds on HTML5" under Gotchas.
  - PWA links: manifest (`display: fullscreen`, `display_override` `[fullscreen, standalone]`, no orientation lock, `start_url`/`scope` `../` relative to `html5game/` so it works under a subpath), `apple-touch-icon`, `theme-color`, `mobile-web-app-capable`. **No `apple-mobile-web-app-status-bar-style`:** `black-translucent` put the page under the status bar, and since iOS 26 the home-screen app blurs that band and a bit below it (the top of the picture in portrait; no CSS turns it off). With the default opaque status bar `env(safe-area-inset-top)` is 0 in the installed app. iOS caches this with the home-screen icon, so an installed app needs removing and re-adding. Headless Chromium reported no installability errors.
  - **Offline play:** `barkley_offline()` runs from `barkley.ready()` (so registration never shares the first visit's bandwidth) and registers `sw.js` from the site root, unless `window.__fuzz` is set or the URL has `?nosw`. It asks the worker to check for a new build then, when the tab comes back and when the machine comes back online, at most once a minute, and shows what it says in `#offline`, a `.hint` line inside the Start button under the Start word: `v1.0.0 · Saving for offline play 42%`, then `v1.0.0 · Ready to play offline`. The version on its own comes from `barkley_version()`, which reads the build's `version.json` and runs whether or not the worker does (everything but the fuzz harness), so a `?nosw` page and a browser without service workers still show `v1.0.0`; anything the worker has said wins. The Start screen is removed on Start and the download carries on without it. `src/README.md` ("Offline play") has the worker's design; the short of it: one cache per build, a new build downloaded in full (reusing by hash every file it didn't change) before the old one is deleted, a page pinned to the build it loaded with.
  - The first-visit install prompt (`#install`): only on a touch device in a browser tab, once (`localStorage` `barkley.install`). iOS gets Share → Add to Home Screen steps and a note that **a home-screen app on iOS has its own storage**, so saves must be moved with Configuration → SETTINGS → Saves; others get the browser-menu steps plus an Install button if `beforeinstallprompt` fires while it's open. Clicking Start removes it, so playtests run as before.

  It also adds extensions with `addExtension(name, file, functions)`: it writes `extensions/<name>/<name>.yy`, copies the JS file beside it, and adds it to the `.yyp`. `Fullscreen` always; `Resume` when the GMX has `scripts/resume_save.gml`, `Saves` when it has `scripts/sSaveData.gml`, `Touch` when `key_doset.gml` calls `touch_keys`, `Gamepad` and `Controls` when it calls `pad_keys` (nothing in the GML calls `controls.js`; the page does), `Crash` when `resume_tick.gml` calls `crash_put`, so faithful imports get only Fullscreen. The `.yy` field set is copied from a current-format JS extension; Igor rejects missing fields. JS functions are `kind` 5; argument and return types are 1 (string) or 2 (real). Obfuscation keeps extension function names. Igor fills in the template's `${GM_HTML5_*}` placeholders.

## Gotchas

- The shell is **zsh** on macOS:
  - An unmatched glob such as `rm s[0-9]*` aborts the whole command. Use explicit names or `find`.
  - There's no `timeout` command (use `perl -e 'alarm N; exec @ARGV' …`).
  - `cat` and `strings` are BSD versions: use `cat -vet`, not `cat -A`; `strings` has no `-el`.
  - `pgrep -f`/`pkill -f` match their own shell: anchor the pattern (`pgrep -f "^node src/fuzz.mjs run"`). To stop a fuzz run, send one SIGINT to the node process only; `pkill -INT -f` also hits the shell wrapper, which counts as a second Ctrl-C and exits without the final save.
- The filesystem is case-insensitive. The export lost `sa`/`sA` and `bgm_Init`/`bgm_init` to case collisions, so rename through a temporary name.
- **Editing this file:** a JS `String.replace` replacement string containing `$` can splice the file (`` $` `` inserts everything before the match, `$'` everything after). Use a replacer function, `split/join`, or Python's `str.replace`. Write the whole new file to `<name>.new`, `mv` it into place, and check it (`wc -l`, one `## ` per section).
- **The LTS importer silently skips any file it can't parse.** It logs "Too many errors - GML not processed" in `<project>/notes/compatibility_report_*/*.txt`, and the file keeps its 1.4 syntax, which then fails to compile with "invalid token '". Fixed causes so far: a modern keyword used as a name (`throw`), and a parenthesised statement as an `if`/`repeat` body. When a compile error names a file, check the report first.
- The importer does convert quotes and backslash escapes, `view_*` → `__view_get`/`__view_set`, and generates compatibility scripts (`instance_create`, `joystick_*`, `__background_*`). It does **not** touch code inside strings, which is why the cinema strings are extracted before import. A script that uses `argumentN` becomes `function name(argument0, …)`; one that also uses `argument[i]` becomes `function name()`.
- **The importer and compiler don't flag functions that LTS removed.** `variable_local_exists('cou')` compiles as a method call on an instance variable and crashes at runtime with "unable to call function undefined". Use the GmlSpec check under verification.
- **The importer makes every sound mono** (`channelFormat 0`) unless the GMX `<type>` is 1. See `markStereoSounds`.
- Importer warning not followed up: "Imported layer depths for room(s) 'RomApartHall' were not adequately spaced."
- **Keyboard state on HTML5 differs from GM6:** `keyboard_lastkey` is set when a key is _released_ (or when another key goes down while one is held); `io_clear()` leaves `keyboard_key` as `""`, a string, which the next key event copies into `keyboard_lastkey`. Key rebinding relied on both (patch 13). `keyboard_clear` clears only the current frame (modernized/03 latches; faithful mode's menu cursors still skip 2–3 items per press, and a headless faithful playtest can land on Quit Vidcon).
- **`keyboard_clear` makes `keyboard_check` lie for the rest of the step.** The runtime rebuilds the key state from the real keyboard once per step, at the very top of the frame, before any event runs; `keyboard_clear` zeroes that rebuilt state, and the raw key stays down. So anything later in the same step that reads `keyboard_check` to decide whether a key was let go is wrong. Two things run before `oController`'s Begin Step and can call `key_clear`: the runtime's deferred instance creation (an `oDialog` Create is one) and any earlier Begin Step. That is why `modernized/03`'s latch carries the "set this step" state — without it, the press that opened a cutscene's next dialog box was read again a frame later and fast-forwarded its typing.
- **LTS clears a viewport before it draws it**, so in a room with two visible views the second wipes the first; GM6 drew each view onto the window in turn. The clear colour is the room's background colour when it draws one, otherwise the runtime's blank `#FFFFF7`. Only `RomInter` (the battle) has two views, and patch 19 gives view 0 a surface that view 1 draws first.
- **A view position with a fraction leaves the last column or row of the picture unpainted.** The view projection uses the exact fractional position, but a quad drawn at it (`draw_surface_stretched` in patch 19's `oBView`) lands on a whole pixel, so a fraction over half a pixel shifts the picture a pixel short of the far edge and the blank `#FFFFF7` shows through - a white bar down the right of the battle, ~4 device pixels wide on a phone. `sViewFollow`'s shake (`random(global.shake)`) and the battle's opening zoom (steps of 3.2 and 2.4) both leave the camera on a fraction; GM6 kept view positions whole. Patch 19's End Step floors both views' positions in the battle. Anything else that draws at view coordinates needs the same care.
- **Same-depth draw order differs from GM6:** instances created at runtime at depth 0 drew _under_ the room's depth-0 instance layer (the SET KEYS rows; patch 13 gives them `depth=-1`). Other runtime-created same-depth overlays may hide the same way.
- **`background_visible[j]` reads and writes different things.** The importer turns a room's 8 background slots into `Compatibility_Background_N` layers holding one element each. The getter returns only `layer_get_visible(layer)`; the setter sets the layer **and** the element. Empty slots still get a visible layer holding a spriteless invisible element, so reading `true` and writing it back turns that element on, and a spriteless element paints white, usually tiled over the view (this whitened rooms after a resume, fixed in v18). **Never round-trip `background_visible[j]` blindly**; guard on `background_index[j]!=-1`. Setting a property on a slot with no layer is a safe no-op. The game's cinemas toggle these arrays too (`cin_0010`/`0013`/`0112` slots 0/1, `cin_0252`/`0256`/`0258` slot 2), so if white ever shows up mid-cutscene, check this first.
- **HTML5 options:**
  - The importer ignores the GMX HTML5 options and never writes `options/html5/`.
  - Igor rejects an `options_html5.yy` that is missing fields ("Field … expected") or in BaseProject's old `modelName` format. Use the format `import.mjs` writes, and keep `option_html5_interpolate_pixels` false.
  - `option_html5_index` works only as an absolute path; relative, `${project_dir}` and `${options_dir}` forms are silently ignored. Igor logs `Copy: <index> to …/out/index.html` only when it used the custom file.
  - An Included File is copied into `html5game/`, so don't ship the index as a datafile. That's how the PWA files ship (`import.mjs` fills the `.yyp`'s `IncludedFiles`).
  - **After an Igor build, the project's `options/html5/index.html` is gone**; a second build would silently fall back to the default template (no Start button). Copy `src/web/index.html` back before rebuilding.
- **Fullscreen on HTML5:** the runtime's `window_set_fullscreen` is empty and there's no `window_get_fullscreen`; built-in names are obfuscated, so `index.html` can't override them. Hence the extension. `requestFullscreen` needs transient user activation: a GML call in the step after a key press has it (so does Settings → Exit → `game_restart()`, which restarts in place); a cold start doesn't. Headless Chromium sets `document.fullscreenElement` but keeps the viewport size, so a playtest proves only that the request succeeded. iPhone Safari has no element fullscreen.
- **`file_text_read_real` past the end of a file returns NaN, not 0.** Check `file_text_eof(handle)` before reading an appended field (as `modernized/08` does).
- **The menu fonts are proportional.** `Courier8` (GZFruit) advances 2 px for `i`, 6 for `A`, 9 for `W`, 3 for a space. `sFont(font, colour, 1)` centres; Configuration rows centre on `x+84` (column 1) or `x+75` (column 2), with the blip's left edge at `xs + spc*value`. To place a row, sum the `shift="N"` of each `<glyph>` in the font's `.font.gmx`, take `start = centre - width/2`, and pick `xs`/`spc` so each blip centre (`xs + spc*k + 5.5`; `sDialogBlip` is 11x11, origin 0,0) sits 6-15 px left of its option's first character.
- **Browser storage and the game's files:** each file is a `localStorage` string keyed **`BarkleyShutUpandJamGaiden.0.<filename>`**, written on `file_text_close`. `file_exists` and `file_text_open_read` read storage on every call, so a file written from JS is visible at once; for a name not in storage they fall back to a synchronous HTTP request, which logs a 404. `sFileData` writes slot N through the temp file `SaveN0.sav`, so `^Save\d+\.sav$` also matches `Save10.sav` (use `^Save[1-3]\.sav$`). Saves are per origin: clearing site data or switching browser loses them (hence the Saves panel).
- **GM6 argument semantics:** GM6 reads an argument that wasn't passed as `0`, including `argument[i]` past the end; LTS gives `undefined` or an error (`argumentDefaults`, patch 08). On HTML5, `argument_count` is **never lower than the function's named parameter count**, so test missing arguments with `is_undefined`.
- **GM6 read unset variables as 0** (not recorded in the export); LTS errors, and HTML5 reads a never-set _instance_ variable as `undefined` silently. Expect that class of runtime error. Saves don't store every global the game uses (patch 15 covers `timpx`/`timpy`), so a load can hit it.
- **Igor:**
  - "Permission Error : Unable to obtain permission to execute" (Reason Code 0000002A) means no licence: point `--uf` at the signed-in user folder.
  - `mac PackageZip` compiles, then fails to sign (no certificate). HTML5 needs no signing.
  - HTML5 obfuscation and pretty-printing are machine settings in the user folder's `local_settings.json`, not project options. There's no source-map option.
  - **A rebuild is not byte-reproducible** (two obfuscated builds of the same project gave different md5s). An md5 only proves a deployed copy matches one specific build artifact; a differing md5 after a rebuild is not a regression.
  - Igor strips runtime functions the game never calls, so an unobfuscated bundle shows only implementations in use (e.g. `audio_get_master_gain` is absent). The runtime's `html5/scripts.html5.zip` is password-protected.
  - `Error reading frame TCON, skipped` is harmless (MP3 tags). So is a 404 for `BarkleyLTS.js` in the console right at "Entering main loop..." (cause unconfirmed; the game loads through it).
  - Sizes: the minified deploy bundle is ~6.9 MB (~1.0 MB gzipped); the whole `out/` dir is ~156 MB, almost all sound.
- **An extension's bundled JS shim is not obfuscated** (`<prefix>_<name>.js` beside `BarkleyLTS.js`, readable even in an obfuscated build). Reading it is the quickest way to tell a stale build from a real bug.
- **Fonts:** the GMX export re-rendered every font from system TTFs with anti-aliasing, and GZFruit (dialog and menu font) isn't installed, so it fell back to an Arial-like face. `importFonts` restores GM6's own bitmaps, and the importer copies them unchanged. Don't let the IDE regenerate fonts.
- **The battle-start transition is a rewrite, not the original.** `rt_trans` picked one of 36 `rt_` effects, each of which built an object with `object_add`/`object_event_add` and ran a blocking `sleep`/`screen_refresh` loop over two `screen_redraw` grabs. None of those functions exist in LTS, and a blocking loop never reaches the screen on HTML5. Patch 07 plays the same 36, in `rt_init`'s order, a frame at a time instead (`sBattleTrans`, `sBattleTransInit`, `sBattleTransDraw`, `sBattleTransTiles`, `sBattleTransPanel`, `oBattleTrans`); half of them are the `rt_` particle transitions, which break the screen into 20x20 tiles and fly them off. The one behaviour it does not reproduce: GM6 froze the whole game for the transition, so the battle's camera intro played afterwards; here the battle runs under the effect from the first frame.
- **Instance creation code ran before Create in GM6; LTS runs it after** (`creationCodeFirst` restores the order for the 9 affected objects).
- **Alarm order differs from GM6:** LTS runs all of one instance's due alarms before the next instance's; GM6 evidently ran each alarm number across all instances in turn. Patch 17 fixes the battle case; other same-step alarm pairs across objects may still differ.
- **Room start differs from GM6:** LTS creates all room instances first, then runs their Create events in order, including on an instance an earlier Create already destroyed. Patch 09 guards the five known cases. If a room change adds one, scan every room for a Create that runs `with (X) instance_destroy()` on an instance created later in that room.
- **Assigning through an object with no instances** (`obj.var = v`) did nothing in GM6; LTS ends the game (`noInstanceAssign` guards every such statement). Persistent objects (`oController`) run in menu rooms too, which have no `oBarkley`.
- **Cinema commands run recursively:** `oCinema`'s User Event 1 calls User Event 0 when a command ends, which calls User Event 1 again at once, overwriting `sub`/`start` for the outer call (patch 16).
- **`script_execute` of a number** below 100000 indexes the runtime's own function table (`script_execute(1)` called `window.onkeyup`); script refs stored in arrays read as 100000 + index.
- **The runtime's error walk can hide the error:** `yyError` builds its trace through `arguments.callee.caller`, so an error raised under strict code or an arrow function surfaces as "'caller', 'callee', and 'arguments' properties may not be accessed…". The JS stack still shows the real cause. A GML error object has `gmlmessage`/`gmllongMessage`/`gmlstacktrace`, not `message`/`stack`; the runtime's own `error` listener calls `game_end(-1)`.
- **Handles, instance ids and structs on HTML5:**
  - `typeof` of a handle is `"struct"`; test with `is_handle`. `string()`/`json_stringify` write `ref object(oBarkley)` / `ref instance(1000306)`.
  - `json_parse` turns strings starting `@ref ` into broken handles, and `handle_parse` returns `ref unknown NaN`. Read asset refs back with `asset_get_index(name)`.
  - `variable_struct_set(s, 'id', v)` (or any built-in variable name) with a literal key compiles to the built-in JS property, and `json_stringify` drops it.
  - Placed instances keep their room-data id (100000 and up, the same each time the room starts); created instances count from 1000000. `id` reads as a plain number while `instance_create` returns a handle, and the game stores both.
  - The runtime sets `window.onbeforeunload` to run the Game End event, so Game End code also runs when the tab reloads or closes.
  - `audio_sound_get_track_position`/`audio_sound_get_loop` need a sound instance handle; with an asset they log `invalid sound handle` and return 0/false.
  - `variable_instance_get_names` costs about 40 µs per instance.
- **Streamed sounds on HTML5** (all the music is streamed, `compression` 3): the runtime downloads and decodes a track on every play, then starts the sound object that asked even if the game stopped it during the decode, and by then it may have reused that object for the next sound; the late sound is untracked (`audio_is_playing` never sees it) and can't be stopped. A stop during the download does cancel (it aborts the XHR). `index.html`'s `barkley_audio_fix` wraps the runtime's sound class (found by its `play`/`stop`/`start`/`pause` methods) with a generation count, tags the download a play starts, and its `decodeAudioData` wrapper never returns a buffer whose sound moved on. The intro's `mSpace` took 3-7 s from play to sound, hence `barkley_early_music`. To trace audio, inject a logger into a test build's `<head>` that wraps `AudioBufferSourceNode.prototype.start/stop`, `decodeAudioData` and `XMLHttpRequest.prototype.open`, and wrap `gml_Script_sA` and `audio_*` in a `js:` step.
- **Rendering on HTML5:** the runtime ignores `devicePixelRatio`, and `window_set_size` writes only the canvas backing store, never `canvas.style` (the runtime does rewrite `canvas.style.cssText` in its fullscreen path). `touch.js` pins the CSS size back to the window in a rAF loop while `oScreenFill` sizes the backing store to `browser_* x touch_dpr()`, which gives real device pixels. Neither mode remaps `mouse_x`/`mouse_y`, but only unreachable dev leftovers read the mouse.
- **`playtest.mjs` keys don't activate a focused page button:** it sends CDP `keyDown` without `text`, so no char event follows and Enter never clicks the button. Page key handling that should work from a playtest has to act on `keydown` itself (as the Start screen's handler does).
- **Homebrew autoupdate can unlink node mid-session** (`/usr/local/bin/node` disappears while `brew_autoupdate` runs). Use `/usr/local/opt/node/bin/node`, or put `/usr/local/opt/node/bin` first on PATH, since `deploy.mjs` and `fuzz.mjs` spawn `node` by name. Don't touch brew itself.
- **A heavy game frame can stall the page for ~800 ms**, so a `js:` probe asserting on a `setTimeout` needs well over a second of slack. It also delays CDP touch events (a `tap:` of 30 ms arrived with 844 ms between down and up), so to test a tap shorter than the overlay's 100 ms minimum hold, dispatch `PointerEvent`s on `#gmtouch-hit` from a `js:` step.
- **Fuzz harness lessons** (all handled in `fuzz-page.js`):
  - Everything that calls into the game is a `'use strict'` function, so the `yyError` caller walk stops (V8 returns `null` for a strict caller).
  - An exception inside a Draw event leaves a surface target set ("Unbalanced surface stack" next frame); reset with `surface_reset_target()` until the stack is empty.
  - Functions the game's scripts declare (`resume_take`, `game_end`, `gml_Script_*`) overwrite anything set before the bundle loads; replace them after the game runs.
  - Each page's AudioWorklet runs on a real-time thread and a dozen browsers starve each other; launch without `--autoplay-policy=no-user-gesture-required` and suspend the context.
  - Stub only WebGL `draw*`/`clear`; stubbing stateful calls breaks the runtime's GL state cache.
  - This laptop (i9-9980HK, 8 cores) scales to about 8 browsers; 12 was slower.
  - Every `requestAnimationFrame` must be the runtime's frame: `touch.js` (`touch_pin`) and `gamepad.js` (`pad_poll`) run their own rAF loops, which the harness drops by function name (`OWN_LOOPS` in `fuzz-page.js`); once one became `frameCb`, a restart scheduled only it and the game froze in `RomStarter` (every restore "did not finish (phase 0)", then `choose()` crashed on an empty pool). **A new shim with a rAF loop must be added there.**
  - The runtime paces frames itself: after each frame it sets a `setTimeout` for the rest of `1000/room_speed` from `_BE3`, and that timer requests the next rAF. Those are the only timers the game sets.
  - `instance_destroy` only marks an instance; the runtime removes marked ones near the end of the next frame (`_d4._Jm3()`), and removing one clears the id map entry for its id even if a new instance has that id by then. So never wind the id counter back below a destroyed instance that hasn't been swept.
  - `Browser.boot()` can return before the pump sees Game Start, and then `hook()` stops the pump: capture first-Game-Start state in `hook()`.

## Known bugs (open)

Bugs found but not fixed yet. **When one is fixed, delete its entry entirely** (the fix belongs in `src/` and its patch or transform docs, not here). "Fuzz" means found by `fuzz.mjs`, with the run's `crashes/<n>/` holding the inputs to reproduce it.

- **A reload after Settings → Exit in the same session leaves path-following instances off their path** until their own code restarts one (`oColliderGuy` re-paths at once). The `game_restart` makes ten new `global.path` ids, the saved `path_index` is one of them, and a fresh page doesn't have it, so `resume_restore` (which checks `path_exists`) leaves it off. Fix idea: save `path_index` as its index in `global.path` when it is one of them.
- **A malformed resume state crashes Game Start** ("undefined value in expression" in `resume_start`, e.g. `barkley.resume` = `{}` with no `build`). Only corrupted storage gets there, and the error listener then forgets the state, so the next load starts normally. Fix idea: check the fields exist before comparing `build`.
- **A crash report replays with small timing drift.** A headless `BUG` report (after the apartment cutscene, v28) replayed to the same room, plot, position and instance ids, but `oDialog`'s `grace`, `mcount` and `image_index` and `oCinema0.cou` differed a little (as if a couple of frames' worth). Same before and after the restore fixes, so it's in the report path (the checkpoint's own step, or the recorded frame times), not the fuzzer's restore.

## Current state and next steps

- **v1.3.1 is deployed (`3b7522f`, 2026-09-22): the same game as v1.3.0, rebuilt from an export `virt/` now
  makes from the original executable on its own.** Not a line of GML or a pixel of art changed; what changed is
  that the hand-made step in front of the pipeline is gone (see "`virt/` … is done and needs no VM" below).
  `barkley-1.3.1` is the migration and import behind it, and its `.gmx` is byte-identical to `barkley-1.3.0.gmx`.
  `deploy.mjs`'s own play-test and live md5 checks passed, and the deploy repo's history was flattened in the
  same pass (see "The web deploy").
- **v1.3.0 (`61c0307`, 2026-09-21) was the deploy before it: the battle-start transition got the `rt_` library's whole pool back, shatter effects and all.** The player's complaint was that it "should be more of a shatter effect but right now it seems to be more of just a slide to the left", and that was right: half of `rt_init`'s 36 effects (18 of them) break the screen into 20x20 tiles and fly them off as particles, and patch 07's rebuild had replaced every one of them with a black-rectangle wipe or a slide, so a shatter could never come up. Patch 07 now plays all 36 in `rt_init`'s order: the particle family is the `rt_` particle template rebuilt frame by frame on `oBattleTrans` (`sBattleTransInit` + `sBattleTransTiles`), and the cube and plane effects are the originals' textured quads (`sBattleTransPanel`), not slides. See `src/README.md` for the per-effect list. Checked headlessly on an unobfuscated build of `barkley-1.3.0`: the audit is clean, the importer converted all GML, and in the title room every one of the 36 fired in turn with no uncaught exception. Numerically, explode gives 192 tiles over 21 frames flying out from the middle with alpha 0.95 to 0, crumble drops them at their own rates, dissolve-left sweeps right to left over 27 frames, cube draws two panels a frame for 21 frames and plane one for 25. Visually, the shatter, crumble, cube and plane screenshots all read correctly (no mirrored or garbled panel). In a forced `oBDreadref` battle the tiles fly off over the live battle, both views draw, there is no white bar, and the battle is playable afterwards. `deploy.mjs`'s own play-test and live md5 checks passed. **To fire one from a `js:` probe on an unobfuscated build:** `gml_Script_sBoss(d,d,'oBDreadref'); gml_Script_sBattleStart(d,d,0)` with `d={}` a plain object, then `yyInst(null,null,instance_find(16,0)).gmlkind=<n>`; or, to see an effect over the room you are in, `yyInst(null,null,gml_Script_instance_create(null,null,0,0,16)).gmlkind=<n>` (16 is `oBattleTrans`; it restarts the room).
- **v1.2.2 (`7191192`, 2026-09-21) was the deploy before it: it fixes the white bar down the right of a battle.** A player saw it on a phone, in an installed Safari PWA and in Chrome. It is the application surface's last column left at the runtime's blank `#FFFFF7`: `sViewFollow`'s shake puts the battle camera on a fraction, the view projection uses that fraction, and the surface `oBView` draws across view 1 lands on a whole pixel, so the picture falls a pixel short of the right edge (see the gotcha). Patch 19's `oBView` now floors both views' positions in a new End Step. Checked headlessly on `barkley-1.2.2` at the reporter's geometry (402x874 at dpr 3, so the picture is 1206 device pixels wide, the same as their screenshot): with `global.shake` held at 4, the old build left app-surface column 319 blank in about half of 40 sampled frames and the screenshot's last three columns read `#FFFFF7` with a blend at the fourth, pixel for pixel what they sent; the new build has whole camera positions in all 40 and no blank column, and the picture runs to the last column. `deploy.mjs`'s own play-test and live md5 checks passed.
- **v1.2.1 (`b7599e9`, 2026-09-20) was the deploy before it.** The Controls panel now opens from a link on the **Start screen**, before the game runs, which is where the user wanted it; `modernized/12`, which had put a fifth row on the in-game title menu, is deleted and the menu is back to its four rows. `barkley-1.2.1` is the migration and import behind it. Checked headlessly on that build with a scratch `playtest.mjs` whose Start click is removed: the link shows and is enabled once the game has loaded, opens the panel without starting the game, the panel lists the bindings, a real `Z` names itself as Action and `Q` as bound to nothing, a fake pad's button 0 lights Action and a stick at 0.85 lights Down with the pad named and its raw buttons and sticks shown, `pad_mute` is true throughout, Esc closes it, and a key after that starts the game normally (`started` true, intro plays, no exception). `deploy.mjs`'s own play-test and live md5 checks passed.
- **v1.2.0 (`0b65adb`) put the same panel on the in-game title menu.** That was a misreading of "title screen": the request was for the page before the game. The menu-art hack it needed (drawing `sTitle0` without its bottom frame, extending it, and spelling `Controls` from letters cut out of the other labels) is gone with it; `git show v1.2.0 -- src/patches/modernized/12-controls-panel.patch` has it if a fifth row is ever wanted again. It adds the Controls panel (`modernized/12` and `controls.js`), reached from the new fifth row of the title menu; `barkley-1.2.0` is the migration and import behind it. Checked headlessly on that build: the fifth row draws flush with the other four (its letters are cut from them, so the lettering matches exactly, and the panel frame extends cleanly), the row opens the panel, the panel lists the live bindings (↑ Up or W … Z or J … C), a real key press names itself and its control (`Z → Action`, `Q → not bound to anything`), a fake pad's button and stick light the Action and Down lamps and show up in the raw line, the pad is muted while the panel is open (`pad_mute` true, and the menu behind does not move), and Esc closes it. `deploy.mjs`'s own play-test and live md5 checks passed. **Two play-test traps found here:** the title menu ignores every key until its fade-in ends (`image_alpha!=1`), which is well past the 62 s the recipe assumes on a loaded machine, so send more `ArrowDown`s than you need (the row index clamps at 4); and a shim edit after an import needs a re-import or a copy into `extensions/<Name>/`.
- **v1.1.1 (`068a661`) was the deploy before it.** It adds game controllers (`modernized/11` and `gamepad.js`); `barkley-1.1.1` is the migration and import behind it. Checked headlessly on that build with a fake standard-mapping pad injected by overriding `navigator.getGamepads` in a `js:` step: the shim loads and takes the bound keys (38/40/37/39/90/88/67), a face-0 press starts a new game and advances dialog, one d-pad press moves the title menu to New season and two to Load season, and two flicks of the left stick move the save-slot highlight from slot 0 to slot 2 (one step a flick, no runaway repeat). The audit is clean, the importer converted all GML, and `deploy.mjs`'s own play-test and its live md5 checks passed. Faithful output is unchanged by construction: nothing outside `patches/modernized/`, `web/gamepad.js` and the `import.mjs` gate was touched.
- **v1.1.0 (`58167a6`) was the deploy before it:** the offline layer, the new app icon, the rebuilt battle-start transition and the dialog key fix.
- **The dialog key was read twice in cutscenes.** `keyboard_clear` zeroes `keyboard_check` for the rest of the step, and the runtime rebuilds the key state from the real keyboard only once per step, at the top of the frame. An `oDialog` Create calls `key_clear`, and deferred instance creation runs after that rebuild but before Begin Step, so `key_release` read the clear as a release and dropped the latch mid-press; the next frame the still-held key read as a fresh press and fast-forwarded the new box's typing. `modernized/03` now latches only a held key and carries a "set this step" state. Verified on an unobfuscated build by wrapping the runtime's IO rebuild, `keyboard_clear`, `key_check`, `key_release` and `dialog_step`.
- **Offline play works headlessly** (2026-09-20, on a plain `fuzz.mjs build` of the same offline code that shipped in v1.1.0, driven over CDP): a first visit cached all 260 files (101 MB of the 157 MB build; the 57 MB of `.ogg` is never asked for and the 50 MB of streamed music comes after what the game needs to start); with the server killed, the site root still loaded and the game reached the title screen with no exception; an update whose manifest listed a file that 404s left the build in use serving and untouched (261 entries) with the half-downloaded one beside it (233); the fixed update downloaded in full, took over, and only then was the old cache dropped. The Start screen showed `v1.0.0 · Saving for offline play N%` and then `v1.0.0 · Ready to play offline`.
- **Patch 19** (older, still current): battles drew as a blank `#FFFFF7` screen with the menu boxes floating on it, because LTS clears a viewport before drawing it and the battle's HUD view (view 1) wiped the field (view 0). Checked headlessly on this build: a forced `oBDreadref` battle draws the backdrop, battlers, shadows and HUD; the opening zoom-in (`trn=1`) plays with the HUD at 1:1; running from the battle returns to a room that draws normally (so `view_surface_id[0]` is released); a normal boot to a new game is unchanged; no exception in any run. Earlier, on v34's page: the fast skip that doubled the music now plays `mSadness` alone; a new game, resume and "Start from the title screen" after a reload work; landscape with 59/59/21 px insets forced: a tap at x 12 doesn't steer, a drag over the picture does, the zone is 568 of 852 px, the D-pad keeps its 164 px bar, Side = Left mirrors onto the right inset, and with the controls Off the settings button alone shows and turns them back on; portrait with 59/34 px insets keeps the picture and note below the top inset. The status bar change can only be seen on an iPhone.
- **Fuzzer:** the 1-hour run `build/fuzz/2026-09-23-run` (2026-09-22, v1.3.1; 17,724 episodes, 77 h of play, 0 browser restarts) found **no new crash class**: all nine are the ones below, carried over. It started from an empty corpus (see `build/fuzz/`) and reached plot 4 (`RomCatacomb1`), 21 story rooms. It needed the `pad_poll` harness fix: from v1.1.1 until then, every run froze in `RomStarter`. The 2-hour run `build/fuzz/2026-09-18-122255` (on the v25 build) reached plot 5 and a new room, `RomCatacomb5`, with no new crash class. Crash #9 (`hang`) is from a run during laptop sleep and doesn't reproduce. **Next wall:** plot 6 (`RomSewer0`, `oIntro8`) needs the plot-5 boss (`sBoss('oBBallmonster')` in `oIntro7`'s cutscene) beaten and the cutscene after it played to `global.roz=RomSewer0`; that cutscene arms no `skipper`. Check progress by candidates per room (nodes with a `nodes/<id>.json.gz`), not by `furthest`.
- **Fuzzer restores replay exactly** (2026-09-18; `src/README.md`, "Snapshots and rewinds", has what is restored and what still differs). To check again after a harness change: play a corpus chain from a fresh page (`fromBoot`) and as recorded (`replayChain`), and compare `resume_save` at every step, treating handles and numbers alike (`"~ref object oBarkley"` is 13) and `true` as 1. No script for it is kept.
- **Not verified yet:**
  - The Controls panel on a real device: it has only been seen at 1024x768 in headless Chromium, where the test lamps sit just at the bottom of the window (the panel scrolls). Worth a look on a phone in portrait, where the two columns stack.
  - A real game controller, on any platform: everything above was driven by a faked `navigator.getGamepads`. Worth checking on hardware: that a pad shows up at all (browsers hide pads until a button is pressed on a focused page), that the face-button layout feels right, that walking with the stick is comfortable at the 0.45 deadzone, and that a pad connecting really does hide the phone's touch controls. A controller also cannot press the page's Start button: that still needs a click, tap or key.
  - On a real phone: PWA install, full-screen launch, the install prompt, the iOS separate-storage note, touch controls, the safe-area layout and the landscape joystick zone beside the Dynamic Island, and that the portrait blur is gone after re-adding the app. **The app icon in `src/web/icon.png` is the user's new one (`e76943b`), but the current import isn't:** `import.mjs` resizes the icons into `datafiles/` at import time, so `build/outputs/barkley-1.0.0` still carries the old placeholder (cover art) and a build from it would ship that. Re-import before the next deploy. Keep icon content inside the centre 80% for the maskable crop.
  - Offline play in a real browser: Safari and an installed iOS app (storage quota — 101 MB is a lot to ask of Safari's, and a home-screen app has its own), a real flight-mode launch, and an update arriving at a browser that already holds an older build of the live site (the headless checks above used a local server). The service worker is never exercised by a play-test or a fuzz run, which both keep it out.
  - A real player's crash report through `fuzz.mjs replay` (a headless one works; see Known bugs).
  - Resume: after a real reload (the fuzzer's in-place restores checked battles and path-following instances), looping ambient sounds, cinema background toggles, a real browser reload or tab close, two tabs at once (they share the key). Known limits: up to 30 steps are lost, Start still needs a click, fullscreen, held keys and playing sound effects aren't restored.
  - Saves panel's Copy/Download/file-picker buttons in a real browser; that the volume change is audible (playtests are muted).
  - Fullscreen appearance and a real Esc in Chrome and Safari; the room-name banner and save-slot location names (`sRoomCaption`) on screen; saving outside a pump room. A pump save records the player position as -1, as in GM6.
  - Anything against the original executable. Safari can't be automated (`safaridriver` sessions time out); don't run `Safari --version`, it hangs.
- **`virt/` (the GMX export, automated) is done and needs no VM.** `virt/run.sh` goes from
  `game/original/BarkleyV120.exe` to a GMX in about three minutes, in two containers: the GM6
  decompiler, then LateralGM with the four patches in `virt/lateralgm/patches`. See "Rebuilding
  the pristine export" above.
  What was checked, on 2026-09-22, against `game/BarkleyV120.gmx`:
  - all **1452 PNGs pixel-identical**, including the RGB under fully transparent pixels;
  - `migrate.mjs` audits clean, and its code tree differs from the pristine one **only in the 165
    `inst_XXXXXXXX` filenames**, which are arbitrary hashes on both sides — not one line of GML;
  - a fresh migration of the pristine export is still **byte-identical to the deployed
    `build/outputs/barkley-1.3.1.gmx`**, so the reading changes in `src/` cost nothing;
  - **the whole pipeline runs off it**: the LTS importer converted all GML, Igor built HTML5
    (`v1.3.0`, 262 files to cache) and a play-test booted to the title screen and through the
    first dialog box with no uncaught exception — the art, the menus and the bitmap fonts all
    drawing correctly.
  What is left over is serialisation, not content: attribute order, `1.0` for `1`, LF for CRLF,
  `&#13;`, self-closing empties, Studio-only fields (`TextureGroups`, `audioGroup`,
  `clearDisplayBuffer`, the Android and iOS option lists) that LTS regenerates or ignores, and the
  `Configs/` platform templates. LateralGM also writes no font glyph PNGs or `<glyph>` entries,
  which is moot: `importFonts` writes both from the exe for every export.
- **The Windows VM in `virt/` is unused and unfinished**, kept only in case step 2 ever has to go
  back to the real IDE. `guest/crack.ps1` runs; `guest/export.ps1` has never completed. Its one
  hard-won fact: **it bugchecked under `-cpu host` on HVF** — `0xA` reads of wild addresses at
  DISPATCH_LEVEL, a `0x1E` carrying `0xc000001d` (STATUS_ILLEGAL_INSTRUCTION), i.e. the hypervisor
  mangling guest state — and `-cpu Penryn` (UTM's own x86_64 default, and the default here now)
  fixed it. Masking TSX and dropping to `-smp 1` were both dead ends, ten and four more bugchecks
  respectively. Every knob is an environment variable (`BARKLEY_VM_CPU`, `BARKLEY_VM_ACCEL`,
  `BARKLEY_VM_NET`, `BARKLEY_VM_CPUS`, `BARKLEY_VM_MEMORY`), effective on `virt/vagrant.sh reload`.
  **Read the history, don't guess:** `Get-WinEvent -FilterHashtable @{LogName='System';Id=1001}` in
  the guest. A bugcheck here looks exactly like a hang from the host — the VM sits at ~100% CPU
  writing a dump — so `vagrant` just reports a WinRM timeout.
- **Not automated yet:** see `src/README.md` ("Not automated yet": the LTS post-import stage).
- **Play-test recipes:**
  - Skip to a new game: `'wait:44000,key:Z,wait:3000,key:Z,wait:3000,shot:game'` (the first Z at the title menu doesn't register, on v29 as well). Menu with no input: `'wait:62000,shot:menu'`. The apartment cutscene: then `key:Z,wait:5000` and about 14 × `key:Z,wait:2500`.
  - Configuration → SCREEN (modernized): `'wait:44000,key:Z,wait:2500,key:ArrowDown,wait:400,key:ArrowDown,wait:400,key:Z,wait:3000,key:ArrowDown,wait:400,key:Z,wait:400,key:ArrowRight'`. VOLUME is Down ×4 then Left from SCALING.
  - Reload test: a `js:` step running `dispatchEvent(new PageTransitionEvent('pagehide')); setTimeout(() => location.reload(), 50)`, then a `js:` step that polls for an enabled `#start` and clicks it (`playtest.mjs` clicks Start only on the first load).
  - Offline play: `SW=1 node src/playtest.mjs …` leaves the service worker in, and a `js:` step reading
    `caches.keys()` and the `.state` entry of `barkley-meta` shows what it has cached. The rest — the server gone,
    an update that breaks off part way, the old cache surviving it — needs a one-off CDP script that owns the
    python server as well as the browser, which is how the checks under Current state were run.
  - Probes: hook `AudioBufferSourceNode.prototype.start` to log each buffer's `numberOfChannels` and duration; hook `audio_master_gain` (a plain global in an unobfuscated build) to see the gain the game passes; `JSON.stringify({fullscreen: !!document.fullscreenElement})`.
  - To measure where the picture sits in a screenshot, find the bounding box of non-black pixels.
