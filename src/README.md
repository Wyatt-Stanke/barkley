# Barkley GMX migration

Reproducible, scripted version of the migration plan. It takes the pristine
GameMaker: Studio 1.4 export plus the original game folder and produces a GMX project with
the removed legacy systems replaced, ready for GameMaker LTS's *Import GMS 1.4 project*.
The final export target is **HTML5** (a web port).

## Versions

The port's version is semver and lives in one place, `src/version.json`. Everything that needs it
reads it from there: the importer writes it into the HTML5 options, `writeBuild` stamps it into each
build's `version.json`, the Start screen shows it, and `deploy.mjs` prints it and warns when the live
site already has that version with different files.

Bump it by hand before a deploy: **patch** for a fix, **minor** for something a player can see,
**major** for a break in what carries over (saves, resume states, crash reports). Migrations and their
imports are named after it too — `build/outputs/barkley-<version>.gmx` and `build/outputs/barkley-<version>/`.

## Requirements

- Node.js 22+ (no npm packages; `playtest.mjs` uses the built-in `WebSocket`). Peggy is only needed to regenerate the parser after editing the grammar: `npx -y peggy@5.1.0 --format es --allowed-start-rules Program,Tokens -o src/lib/gml.parser.mjs src/lib/gml.peggy`
- `ffmpeg`, `ffprobe` and `patch` on PATH (on Windows, Git Bash provides `patch`)
- The pristine GMX export (never modified) and the original distribution folder with
  `Music/`, `Voice/` and `BG/`
- For building: GameMaker LTS with the HTML5 target installed, signed in (Igor reads the licence from the user folder)
- For play-testing: `python3` and a Chromium headless shell

## Run

```sh
node src/migrate.mjs [--mode=modernized|faithful] <pristine GMX dir> <original game dir> <output GMX dir>
# e.g.
node src/migrate.mjs game/BarkleyV120.gmx game/original build/outputs/BarkleyV120.migrated.gmx
```

The output is a new project; the unpacked code is left beside it as `<output>.code` so the
result can be grepped and reviewed as plain `.gml`. The run ends with an audit listing any
remaining use of an API that LTS removed (it should print "No items to review").

Then import it into an LTS project without the IDE, using the ProjectTool bundled with GameMaker LTS
(the same importer the IDE runs):

```sh
node src/import.mjs <output GMX dir> <new project dir>/<name>.yyp [ProjectTool path]
```

It exits non-zero and lists the files if the importer reports GML it could not convert. The importer
skips converting such a file entirely, leaving 1.4 syntax (single-quoted strings) that fails to compile.
The importer also writes an `mvc/` folder into the GMX it imports.

The importer skips the HTML5 options, so `import.mjs` writes `options/html5/options_html5.yy` itself. It sets the page title to the game's name, names `barkley_loading` (in `index.html`) as the loading bar, and uses `index.html` from this folder, copied beside the options, as the custom index. `index.html` is the runtime's template with these changes:
- the page's design system: every piece of UI around the game (Start, the install prompt, the Saves and crash panels, the touch overlay and its sheet) is styled by this file's stylesheet, and the extensions only build plain DOM with its classes (`.ui-panel`, `.ui-head`, `.ui-cols`, `.ui-code`, `.ui-btn`, `.ui-link`, `#gmtouch`, `.gmt-*`). Swiss and deliberately forgettable: black, white and a muted white, Inter (shipped with the build; Helvetica/Arial as fallbacks), flush left on a 16 px gutter (32 px from 720 px wide), hairline rules, square 44 px buttons, and an active control inverts to white. Panels sit above the touch overlay's hit layer (they didn't before, so a panel could not be tapped on a phone);
- a Start screen that is itself the Start button (the whole page): the game's name, "Start" in large type and a hint, set on the left edge of where the 4:3 picture will be. The game loads behind it (`GameMaker_Init` runs on page load, and the runtime's own loading bar is replaced by the word itself, which fills from grey to white as the game loads, by bytes: the texture pages download through `fetch` so their progress can be read) and is held just before Game Start; a click, a tap, or any character key, Enter or an arrow then starts it at once, which also lets audio start after a user gesture. When a resume state is waiting (`localStorage` `barkley.resume`, so modernized builds only), a line at the foot of the page says the game continues where it left off and offers "Start from the title screen": clicking it (or Enter or Space on it) deletes the state before Game Start's `resume_take` reads it, so the game starts from the intro. Under the fuzz harness it starts the old way (Start runs `GameMaker_Init`);
- a Controls link in the bottom corner of the Start screen, enabled with Start, which opens the Controls panel (`controls.js`): the seven controls with the keys bound to them (read from the game's own `controls.txt` in browser storage, so they are the player's, not the defaults) and the W A S D / J K spares, where to change them once the game is running, what a controller does, and a test that lights each control as it is pressed from the keyboard or a pad and names a connected pad with its raw buttons and sticks. It is deliberately before the game: a player who cannot work out how to drive it is standing here. Nothing pressed in it starts the game — the panel keeps its key events, the Start screen's key handler stands down while it is up, and `pad_quiet` mutes the pad — and it polls on a timer, because the Start screen holds frame callbacks back until the game starts;
- a black page background: Igor writes the game's background colour as `#0`, which is not CSS, so the page showed white before Start;
- a script that makes the runtime load MP3s instead of Ogg Vorbis, which Safari decodes with the first ~26 ms of every sound missing;
- a guard for streamed sounds (all the music): the runtime plays one by downloading and decoding it and then starting the sound object that asked, even if the game stopped it meanwhile, and by then it may have reused that object for the next sound. So a track switched away from in its first seconds (the intro's music when the intro is skipped and a new game started at once) played on under or in place of the next, and nothing could stop it. `barkley_audio_fix` finds the runtime's sound class by its methods (`play`, `stop`, `start`, `pause`; its names change between builds) and counts a generation on each play and stop; the download a play starts carries it, and the `decodeAudioData` wrapper never hands back a buffer whose sound has moved on;
- the intro's music (`mSpace`, 6 MB) decoded while the Start screen waits (`barkley_early_music`), since a streamed track is otherwise downloaded and decoded only when it first plays and the intro was silent for seconds; the runtime's decode of the same file gets that buffer, and it is dropped if the first decode after Start is another file, or after 60 s;
- everything the page draws kept inside the safe-area insets (`--touch-*`, from `env(safe-area-inset-*)`), and no `apple-mobile-web-app-status-bar-style`: `black-translucent` put the page under the status bar, and since iOS 26 a home-screen app blurs that band and a little below it (the top of the picture in portrait);
- links that make the page installable as an app (PWA) that opens full screen: `manifest.webmanifest` (`display: fullscreen`, falling back to `standalone`; black theme and background; no orientation lock, since the touch overlay lays out both ways), an `apple-touch-icon`, `theme-color` and `mobile-web-app-capable`. `import.mjs` adds the manifest and `icon-180/192/512.png` (resized with ffmpeg from `web/icon.png`) to the project as Included Files, which the build copies into `html5game/`; the manifest's `start_url` and `scope` are `../`, the page itself. The service worker that makes it play offline ships from the build root instead, and needs no import ("Offline play" below). To change the icon, replace `web/icon.png` (square) and import again.
- on the first visit from a phone or tablet in a browser tab (not the installed app), a full-screen sheet suggesting the install, with numbered steps for iOS Safari (Share, Add to Home Screen, and a note that the iOS app keeps its own saves) or for other browsers (menu, Install app), and Chrome's own install dialog behind an Install button when Chrome offers it. It shows once (`localStorage` `barkley.install`), and Start removes it.

Igor finds the index only by absolute path, so the project records where it was imported.

On HTML5 the runtime's `window_set_fullscreen` does nothing, so `import.mjs` also adds `fullscreen.js` from this folder to the project as an extension (`extensions/Fullscreen/`, registered in the `.yyp`). It provides `fullscreen_set(on)` and `fullscreen_get()`, which fullscreen the whole page, and patches 14 and `modernized/05` call them. Browsers allow entering fullscreen only shortly after a key press or click; without one, `fullscreen_set(1)` waits for the next key press, click or tap.

For a modernized migration (one with `scripts/resume_save.gml`) it adds `resume.js` the same way (`extensions/Resume/`): `resume_put(state)` keeps the game state patch `modernized/06` hands it and writes it to `localStorage` (key `barkley.resume`) when the page is hidden or closed, and at most every 5 s; `resume_take()` returns it once per page load and deletes it; `resume_clear()` forgets it.

For a modernized migration (one with `scripts/sSaveData.gml`) it also adds `saves.js` (`extensions/Saves/`): `saves_open(probe)` shows the save-transfer panel (Export and Import columns; Esc or Close shuts it). `probe` is the name of a file the game has just written, which is how the page finds the prefix the runtime puts on its storage keys.

For a modernized migration (one whose `key_doset` calls `pad_keys`) it also adds `gamepad.js` (`extensions/Gamepad/`): `pad_keys(up, down, left, right, action, cancel, start)` records the bound keys and `pad_context(n)` the same context the touch overlay gets. It polls the Gamepad API once a frame and sends those keys through the runtime's `window.onkeydown` / `window.onkeyup`, as `touch.js` does, so a pad press is a key press everywhere in the game. `pad_quiet(on)` lets the Controls panel read the pad without the game hearing it.

A modernized migration also gets `controls.js` (`extensions/Controls/`), which no GML calls: `controls_show()` shows the Controls panel, and the Start screen's Controls link opens it. It reads the player's own key bindings out of the game's `controls.txt` in browser storage (`key_save` writes it) rather than being told them, because the game has not run yet.

## Build and play-test (HTML5)

Build with Igor from the runtime, against the signed-in user folder:

```sh
RT=/Users/Shared/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-2026.0.0.23
"$RT/bin/igor/osx/x64/Igor" -j=8 --project=<.yyp> --rp="$RT" --uf=<user folder> \
  --cache=<dir>/cache --temp=<dir>/temp --of=<dir>/out/index.html --tf=<dir>/pkg -r=VM -- html5 folder
```

`<dir>/out` then holds `index.html` and `html5game/`. Without `--tf`, Igor deploys the build and then crashes
("The value cannot be an empty string. (Parameter 'path')") and exits 1.

Then run it in headless Chromium, pressing keys and taking screenshots; it exits 1 on an uncaught exception. It clicks the Start button first, as soon as the game code has loaded. `SIZE=1280x720` sets the browser window (default 1024x768), for example to check the modernized fill-screen borders:

```sh
node src/playtest.mjs <dir>/out <test dir> 'wait:14000,shot:title,key:Z,wait:3000,shot:after'
```

Runtime errors from the default build are obfuscated. For readable stacks, build with a copy of the user folder whose
`local_settings.json` sets `"machine.Platform Settings.HTML5.obfuscate": false` and
`"machine.Platform Settings.HTML5.pretty_print": true`.

A play-test opens the page with `?nosw`, which keeps the service worker out of it; the whole build
would otherwise be cached from the little python server on every run. `SW=1 node src/playtest.mjs …`
leaves it in.

## Offline play (`src/offline.mjs`, `src/web/sw.js`)

The installed app plays with no network, and a new build reaches a player whole or not at all.

`writeBuild(dir)`, which `fuzz.mjs build` and `deploy.mjs` both run over the finished build, puts
`sw.js` at its root — a service worker only controls pages under its own path, so it can't ship from
`html5game/` the way the other page files do — and writes `version.json` beside it: the semver version,
an **id** that is the hash of the whole file list, and every file with its hash, its size and whether
the game needs it before the first frame. Of a 157 MB build it lists 101 MB in 260 files: the `.ogg`
copies are left out (the page reports no Ogg support, so the runtime only ever asks for the MP3s), and
the 51 MB of streamed music is marked as not needed to start.

The worker has no version of its own; it does what the manifest it fetches tells it to.

- **Caches.** One per build, `barkley-build-<id>`, plus `barkley-meta` holding which build is served.
  Each build's cache carries its own manifest, so the worker can tell what any cache on disk holds.
- **A check** (on load, on coming back to the tab, on coming back online — at most once a minute)
  fetches `version.json` past the browser's cache. A different id means a new build: it downloads into
  that build's own cache, four files at a time, **copying from the caches already on disk every file
  whose hash hasn't changed** — across the usual rebuild that is all the sound and all the textures, so
  an update moves a few megabytes, not a hundred.
- **The switch.** The files the game needs to start come first, and once they are all in, that build is
  the one served. The build it replaces is deleted **only once every last file of the new one is in**,
  so a download cut off halfway leaves the player exactly what they had, and the next check picks up
  from the files already stored. Until then a file the new build hasn't got yet is served from an older
  cache that has it with the same hash.
- **Serving** is cache first, network after. A page keeps the build it loaded with (pinned by client
  id), so a build that finishes arriving mid-session never mixes into a running game; it is in use at
  the next load. Range requests are answered from the whole cached file, which is what Safari needs to
  play audio from an `<audio>` element.
It caches unconditionally — no Save-Data or metered-connection check — because a player who opens the
game at all downloads 41 MB to reach the title screen. If that ever has to change, the check belongs
in `barkley_offline()` in `index.html`, not in the worker.

- **The page** (`index.html`) registers the worker only once the game has loaded, so it never competes
  with the first visit's own download, and never under the fuzz harness or with `?nosw` in the URL. The
  Start screen carries the one line it has to say, under the Start word in the hint's grey:
  `v1.0.0 · Saving for offline play 42%`, then `v1.0.0 · Ready to play offline`.
  The version alone (`v1.0.0`) is shown by `barkley_version()`, which reads the build's own `version.json`
  and so works with no worker at all — a browser without service workers, or a page opened with `?nosw`.
  Whatever the worker has said stands: it knows more, and it knows the version offline too.

## Fuzzing (HTML5)

`fuzz.mjs` looks for crashes by playing the game fast and in parallel, and remembers the paths it took. It needs an
unobfuscated modernized build, which its `build` command makes from an imported project (a copy of it and of the user
folder, so neither is touched):

```sh
node src/fuzz.mjs build build/outputs/BarkleyLTS35/BarkleyLTS.yyp build/fuzz/build      # about 70 s
node src/fuzz.mjs run build/fuzz/build --save --corpus --through --verbose           # until Ctrl-C (or --minutes=M)
node src/fuzz.mjs replay build/fuzz/build build/fuzz/<run>/crashes/1                    # from a fresh page, with screenshots
```

`--save` keeps the findings in `~/Documents/barkley/fuzz/<date-time>/` (or `--save=<dir>`): `summary.md` indexes every
crash (`crashes/<n>/`) and milestone path (`paths/<n>-<room>-p<plot>/`, the first time the search reached a room or a
plot), each with a `report.md`, the inputs from the new game, a snapshot of the game state and screenshots. `--verbose`
prints a line per episode: where it started, how long it played, and what was new (◆ cells, ƒ GML functions, ⚑ values
of globals). `--corpus` keeps the archive in `~/Documents/barkley/fuzz/corpus/` (or `--corpus=<dir>`) and starts
the next run from it (saved every 5 minutes and at the end; from another build, the most advanced paths are replayed to
make their snapshots again). `--through` patches known crash classes in the page (numbers drawn as text, `real()` of a
non-number, `script_execute` of a number that is no script) so the search gets past them; each patched spot is still reported, as a `patched` crash, and replayed
without the patches. `--workers` (default: physical cores − 2) sets the number of browsers, `--port` the ports.

How it works:

- **Virtual time** (`fuzz-page.js`, injected into the page before the game loads): `performance.now`/`Date.now` read a
  virtual clock, `requestAnimationFrame` callbacks run at the next virtual vsync (every 17 ms, a whole number so every frame's `current_time` step is the same) and timers set in a frame wait
  for virtual time. The harness steps frames itself in a loop, so the game runs as fast as the CPU allows (about 400
  frames a second per browser, 7× real time; 8 browsers about 2,000–3,000), and deterministically: the game's own RNG
  is fixed-seeded and never reseeded, `Math.random` is seeded, and the game is delta-timed from `current_time`, so the
  clock keeps its speed right. Drawing (WebGL's `draw*`/`clear`) and sound (the AudioContext stays suspended) are off.
- **Snapshots and rewinds**: a snapshot is the game's own resume state (`resume_save`, patch `modernized/06`) plus the
  runtime's RNG state, the save files in `localStorage`, the keys `key_clear` has latched, the exact direction and
  speed of every moving instance, and the runtime's frame pacing. A restore is an in-place `game_restart`: Game Start
  calls `resume_start`, which gets the snapshot from the harness's `resume_take`, and the saved room's first Room Start
  rebuilds it. The rest of that frame then runs a whole step on the rebuilt game with a near-zero frame time, so the
  harness restores again outside a frame, deletes the variables that step created, sweeps the instances it destroyed
  out of the runtime's id map (removing one later would clear the entry of a new instance with its id), and puts back
  the id counter, the latch, the exact motion (the runtime derives direction from `hspeed`/`vspeed` truncated to 6
  decimals) and the pacing (the next frame's due time carries fractions of a millisecond, so at 30 frames a second on
  the 17 ms vsync which frame takes one vsync depends on it). Every restart, the fresh start's too, gets Game Start's
  first ten `path_add` ids back, so every page numbers `global.path` alike. A restore takes about 40 ms. Checked by
  playing corpus paths both ways on the v29 build: one of 222 steps with 64 restores, and one of 596 steps with 180
  restores through battles and path-following enemies, match play from a fresh page at every step, to the bit, but for
  `global.b_pt`, the same value as an int64 or as a double. Also different after some restores: `global.grid` is
  another number for an identical `mp_grid` after a restore in a battle (the runtime never frees grids and the game
  uses it only as a handle), an instance that continuous play moved to a runtime depth layer comes back on the room's
  layer at that depth (draw order only), file handles and an empty background slot's tiling flags. `HARNESS` in
  `fuzz.mjs` is part of the corpus's build id; bump it when a harness change makes recorded paths play differently.
- **Search** (Go-Explore): a new game is started and snapshotted once. Each worker repeatedly picks a snapshot, restores
  it and plays a random program of input macros (walks, taps, dialog mashing, waits, the start menu, and programs that
  found something before). After every macro step the page looks for something new: a cell (room, plot, battle, player
  position in 32 px), a (room, GML function) pair (every `gml_*` function is wrapped to record that it ran; a cutscene
  shows up as its `cin_NNNN` steps), or a value of a game global never seen before (story flags such as `plot=3` or
  `treasure[3]=1`; globals whose values churn are learned as volatile and ignored), including the pseudo-flag
  `goal=<plot>:<bits>`, which of the next plot's conditions hold (so a state that meets two of them at once, such as
  Larry and Chin both talked to, becomes a node even though each value on its own was already known). Where it finds one it snapshots the
  game, and that node joins the archive. Picks favour nodes chosen less often, found recently and further in the story
  (plot, the next plot's conditions met, rooms on the path, story globals changed since the new game; recomputed when
  the corpus loads); menus and the debug room hardly count.
- **Generators** (in the page, closed-loop: they read the game between 4-frame chunks, and the keys they press are
  recorded, so replays need no generator): `dialog` presses action until the player can move; `exit` walks to an exit
  not taken from this room yet (a breadth-first route on an 8 px grid around solid instances) and takes it, by
  walking into it (`oExitPar` children and exits with their own collision event with `oBarkley`) or pressing action
  beside it; the exit recorded is the one nearest the player's last position, since the way to one exit can cross
  another (a corpus exit that seems to lead to several rooms is dropped on load); `talk` walks up to something usable (`oItem`
  descendants: people, signs, pumps) not talked to at this plot and goal mask and presses action; `seek` walks to a reachable spot
  not visited yet; `travel` heads for a story goal room through the known room graph (several hops; after a failed hop it tries
  other exits) (goal rooms place objects whose
  code sets `global.plot` to the next value, read from the build); `battle` presses action, cancel and arrows in a
  battle's rhythm. Programs are either random macros or a few generators with macro bits between them; each
  generator's pick weight grows with what it found per frame lately.
- **Crashes** are grouped by message and GML function. The first of each is replayed on a separate browser from its
  nearest snapshot (the same restores: a determinism check) and from a fresh page with no restores at all (fresh pages start alike: the loading pump stops at Game Start
  and the harness restarts the game from a fixed clock, seeds, ids and empty storage), which tells
  a real crash from an artifact of the snapshots. A GML error is the runtime's error object (`gmlmessage`,
  `gmlstacktrace`); a JS error in the runtime (a GML value of the wrong type) has a JS stack.

## How it works

Paths are relative to `src/`. The `web/` folder holds everything that ships into the built page
(`index.html`, the extension shims and the PWA assets); `import.mjs` copies it into the project.

| File | Role |
|---|---|
| `lib/gml.peggy`, `lib/gml.parser.mjs`, `lib/gml.mjs` | Peggy grammar, the parser generated from it (checked in; don't edit), and a wrapper exporting `parse`, `tokenize`, `walk`, `applyEdits` and `isCall`. The grammar covers GM6/1.4-era GML: `'` and `"` strings without escapes, optional semicolons, `=` as comparison. Nodes keep source offsets, so transforms splice text and leave formatting alone. Existing GML parsers target modern GML and reject this code. |
| `lib/gmx.mjs` | Unpacks code from the GMX XML into `scripts/`, `objects/<obj>/<type>_<num>.gml` and `rooms/<room>/*.gml`, and packs it back. Unchanged code keeps its original bytes. Packing registers new or deleted scripts and new objects in the project file. |
| `patches/*.patch` | Unified diffs over the code tree for the hand-written rewrites (the parts that are logic changes, not mechanical ones). |
| `transforms.mjs` | AST transforms for the mechanical changes. |
| `assets.mjs` | Imports the externally loaded Music, Voice and BG files as real resources, and the original font bitmaps from the exe. |
| `migrate.mjs` | Runs everything in order and audits the result. |
| `import.mjs` | Headless LTS import via ProjectTool; checks the importer's compatibility report and writes the HTML5 options. |
| `web/index.html` | The HTML5 page template the build uses: Start button (and the option not to resume), MP3 sounds, app manifest links. |
| `web/manifest.webmanifest`, `web/icon.png` | The web app manifest and the source of its icons, added to the build by `import.mjs` so the page installs as a full-screen app. |
| `web/inter.woff2`, `web/inter-OFL.txt` | The page's font, Inter (Latin subset, variable weight and optical size, from `@fontsource-variable/inter` 5.3.0), and its SIL Open Font License, added to the build by `import.mjs`. |
| `web/fullscreen.js` | The HTML5 extension `import.mjs` adds: `fullscreen_set` and `fullscreen_get`. |
| `web/resume.js` | The HTML5 extension `import.mjs` adds to a modernized migration: keeps the game state across a reload. |
| `web/crash.js` | The HTML5 extension `import.mjs` adds to a modernized migration: records checkpoints and input, and shows a crash report. |
| `web/touch.js` | The HTML5 extension `import.mjs` adds to a modernized migration: the mobile touch overlay. |
| `web/gamepad.js` | The HTML5 extension `import.mjs` adds to a modernized migration: a game controller sends the bound keys. |
| `web/controls.js` | The HTML5 extension `import.mjs` adds to a modernized migration: the Controls panel the Start screen opens, with the live input test. |
| `web/saves.js` | The HTML5 extension `import.mjs` adds to a modernized migration: exports and imports the save slots as text. |
| `playtest.mjs` | Headless-Chromium smoke test of an HTML5 build: console, exceptions, screenshots, key presses. |
| `deploy.mjs` | Deploys a build to GitHub Pages in one command: builds a project with `fuzz.mjs build --minify` (always with the current `index.html`), play-tests it, commits it into a kept clone of the deploy repo reset to its `main`, pushes, watches the Pages workflow and checks the live files against the build. |
| `fuzz.mjs`, `fuzz-page.js` | The fuzzer (see Fuzzing): the unobfuscated build, the search, crash and path replays; and the in-page harness (virtual clock, coverage, snapshots, restores). |

Pipeline order:

1. Copy the project, unpack its code.
2. Read every `sound_replace(sound, 'file')` call to learn which file each placeholder sound should be.
3. Delete the `bgm_*` DLL wrappers and the `rt_*` transition library; rename `sa.gml` back to `sA.gml` (case collision).
4. Apply the patches:
   - `01-repair-export`: restore the lost beat-timing script as `sBeatAdd`.
   - `02-music-without-dll`: `sA` plays imported sounds; drop DLL init/close and the runtime sound loader.
   - `03-imported-backgrounds`: `oBG0/1/2` stop loading GIFs (the room now draws its real backgrounds); battle backdrop no longer uses `sprite_replace`.
   - `04-replace-execute-string`: enemy spawning, gun sounds and `oStartNN` lookup via `asset_get_index`; item lists copied directly (a shop's from `oStartmenu`'s `keeper`); item effects become numbered `switch` scripts.
   - `05-file-text-api`: `key_load`/`key_save` and `nametext` use `file_text_*`.
   - `06-display-setup`: fullscreen via `window_set_fullscreen` only.
   - `07-battle-transition`: the battle-start transition, rebuilt. GM6 called `rt_trans`, which picked one of 36
     effects from the `rt_` library; each built its transition object with `object_add`/`object_event_add`, grabbed
     the screen with `screen_redraw` and cross-faded two grabs in a loop of `sleep`/`screen_refresh`. LTS has none
     of those functions, and a loop that holds the frame draws nothing on HTML5, so the effect is played a frame at
     a time instead. `sBattleStart` calls the new `sBattleTrans(room)`, which creates the new persistent object
     `oBattleTrans` and picks one of 36 effects, the same pool `rt_init` filled and in its order. In Post Draw
     `oBattleTrans` grabs the room being left into a surface, asks for the room change, calls `sBattleTransInit`
     to set the effect up and how many frames it lasts, and then draws one frame of it over that grab through
     `sBattleTransDraw` until it is done, before freeing the surface and destroying itself. It draws into the
     application surface, ahead of `oScreenFill` (depth 16000), so the effect is in game pixels and the player's
     scaling still applies, and it covers both of the battle room's views.
     - Effects 0 to 9 work on the whole screen at once: spin, wavy, pixelate and blur take the grab away over the
       new room, 4 to 7 are those four again going through black, and quake and zoom finish the list.
     - Effects 10 to 27 are the `rt_` particle transitions, half of its pool and the ones the game is remembered
       for: `sBattleTransInit` breaks the grab into 20×20 tiles and gives each a life, a speed and direction, a
       gravity and its own scale and alpha on `oBattleTrans`, and `sBattleTransTiles` steps and draws them every
       frame. That loop is the `rt_` particle template, and each effect is it with the one or two lines the
       original changed: crumble, explode and implode (thrown or pulled), two tornadoes, drain, two sets of
       blinds, shrink, grow, two pixel dissolves, and four dissolves sweeping from an edge.
     - Effects 28 to 35 are the cube and plane transitions, which need the new room as a texture of its own, so
       `oBattleTrans` copies the application surface into a second surface first. `sBattleTransPanel` draws one
       wall as a textured quad, so these are the originals' geometry rather than an approximation of it.

     The new room runs underneath from the start rather than being frozen as GM6 froze it, so the battle's own
     camera intro begins under the effect.
   - `08-argument-count`: `sS`, `sR` and `sCredits` loop over `argument[i]` until a `0`, which GM6 returned past the last argument; the loops now also stop at `argument_count`.
   - `09-destroyed-at-room-start`: `oIntror5`, `oBalthios`, `oHoopz`, `oCyberdwarf` and `oSuitToll` start their Create with `if (!instance_exists(id)) exit;`. At room start LTS runs Create on instances an earlier instance's Create already destroyed; in GM6 they never ran. Without this, skipping the title reveal (a key press) leaves the menu invisible.
   - `10-save-room-start`: `oController`'s Room Start positions the player with `with (oBarkley)` rather than `oBarkley.x=`. Opening the save menu at a pump enters `RomLoad`, which has no `oBarkley`; GM6 skipped assigning to absent instances, LTS throws and ends the game.
   - `11-integer-scaling`: a new persistent `oScreenFill` object resizes the canvas to the browser window every Begin Step. In Post Draw it clears to black and draws the 320×240 application surface centred at the largest whole-number scale that fits, without smoothing. `oController` creates it instead of positioning a 320×240 window. The original `SCALING` option only sets view port sizes, which don't change the 320×240 application surface, so in faithful mode it has no visible effect, as before.
   - `12-room-caption`: `oController` uses `sRoomCaption(room)` (generated in the next step) in place of `room_caption`, which LTS rooms don't have: for its room-name banner, and in Room Start to set the window caption, the page title on HTML5, as GM6 showed the room's caption in the title bar. Rooms without a caption get the game's name.
   - `13-key-rebinding`: fixes the Configuration menu's SET KEYS.
     - The key rows get `depth=-1`. LTS drew them under the box, created at the same depth, so it looked empty.
     - `key_get` takes `keyboard_key` once every key has been up, instead of `keyboard_lastkey`. On HTML5 `keyboard_lastkey` is set on release, and `io_clear()` leaves `keyboard_key` as `""`, so the old code bound the key that opened the prompt, then `""` (N/A), and stalled.
   - `14-fullscreen`: `oController`'s Game Start calls `fullscreen_set` (from `fullscreen.js`) in place of `window_set_fullscreen`, so the Configuration menu's `SCREEN Windowed / Full Screen` works again. As in the original, it applies when Settings → Exit restarts the game, and at startup (from the first key press or click).
   - `15-unset-globals`: `oController`'s Game Start sets `global.timpx`/`timpy` to 0. GM6 read unset variables as 0; only the opening cutscene sets these and saves don't keep them, so a loaded plot-1 save crashed `oIntro0`.
   - `16-cinema-stale-code`: `oCinema`'s User Event 1 runs a `code` command's script only when the queue head is a `code` row. A finished command starts the next one recursively, and with `halt` set the inner call exits early, leaving the outer call with a stale `sub='code'` and a `wait` row at the head; GM6 ran `execute_string` on the wait time (nothing happened), LTS ran `script_execute(1)`, a runtime function, and crashed in the plot-3 escape cutscene.
   - `17-battle-alarm-order`: `oBCamera`'s Alarm 11 first runs the Alarm 10 of any battler whose Alarm 10 is due this step. Both are set to 2 in the same step; LTS ran the camera's first, and `sVerifyStats` read the battlers' `_h*` stat floors before Alarm 10 set them, so every battle crashed.
   - `18-battle-target-range`: the battle menu's target cursor steps back while it is past the end of the target list (and Down checks the length first). Right and Down in one step moved it two past the last target; GM6 read `target[]` past its end as 0, LTS stopped the game ("index out of range").
   - `19-battle-hud-view`: a new object `oBView`, created by `oBCamera`, renders the battle field (view 0) into a surface the size of the application surface and draws that surface across view 1 before the HUD. The battle is the only room with two visible views: GM6 drew each view onto the window in turn, but LTS clears a viewport before it draws, so view 1 (the HUD, which never draws the field) wiped view 0 and the whole battle showed as the runtime's blank `#FFFFF7`. `oBView` sits at depth 16000 so it draws first in both views; in view 0 it clears the surface to black, and its Room End frees the surface and puts `view_surface_id[0]` back to -1. The field keeps its own zooming camera, so the opening zoom-in still plays while the HUD stays at 1:1. Its End Step floors both views' positions: `sViewFollow`'s shake and the opening zoom leave the camera on a fraction, and while the view projection uses that fraction the surface drawn across view 1 lands on a whole pixel, so a fraction over half a pixel left the picture's last column unpainted - a white bar down the right of the battle (GM6 kept view positions whole).
   - Then, in modernized mode only (the default), `patches/modernized/*.patch`:
     - `01-scaling-options`: replaces the Configuration menu's `SCALING x1 x2 x3` with `Integer / Sharp fit` (still `global.sat[0]`, saved in `config.txt`; the default 1 is Sharp fit, and an old saved 2 is clamped to 1). Sharp fit draws the game nearest-neighbour onto a surface at the next whole scale, then bilinear down to the exact fit, so it fills the window with evenly sized pixels.
     - `02-wasd-jk-keys`: W/A/S/D and J/K also work as Up/Left/Down/Right, Action and Cancel. `key_doset` maps them with `keyboard_set_map` onto whatever those controls are bound to, so they follow rebinding, and it skips a letter that is itself bound to a control. The rebinding screen clears the maps while it waits for a key.
     - `03-key-latch`: new scripts `key_check`, `key_clear` and `key_release`. GM6's `keyboard_clear` hid a key until it was released; in LTS it clears only the current frame, so a held key fires again and one press moved a menu cursor 2–3 items. `key_clear` latches the key, `key_check` reads a latched key as up, and `key_release`, called first in `oController`'s Begin Step, unlatches released keys. The `keyLatch` transform points the game's calls at these scripts. Only a key that is down when `key_clear` runs is latched, and the latch starts at 2 rather than 1: `key_clear` also calls `keyboard_clear`, which zeroes `keyboard_check` for the rest of that step, so a `key_release` running later in the same step would read the clear as the key having been let go. A latch of 2 only ages to 1 there; from the next step the runtime has rebuilt the key state and an up key really is up. Without that, a `key_clear` before `oController`'s Begin Step — an `oDialog` Create is one — dropped the latch mid-press, and the same press then both advanced a cutscene line and skipped the next line's typing.
     - `04-intro-skip-key`: the any-key handlers that skip the intro (`oOntop`, `oIntror0`, `oIntror1`, and `oIntror5` during the title reveal) call `key_clear(vk_anykey)` before changing room. The key that skipped then reads as up until it is released, so it no longer also picks "New season" on the title menu.
     - `05-fullscreen-toggle`: changing `SCREEN` in the Configuration menu enters or leaves fullscreen at once, and the row follows the page's real state while the menu is open, so leaving fullscreen with Esc (which the game doesn't see) switches it to Windowed at once.
     - `06-resume`: after the tab reloads, or is closed and reopened, the game continues where it was, as if it had stayed open; the save files are untouched. `oController`'s Begin Step calls `resume_tick`, which every 30 steps (half a second) passes `resume_save()` to `resume_put` (`resume.js`): every global, every instance's built-in variables (position, motion, sprite, depth or layer, alarms, path) and own variables, the `mp_grid` paths, views, backgrounds and the positions of playing sounds, as JSON. Handles become `"~ref <type> <id or name>"` strings; `json_parse` would misread the runtime's own `"@ref …"` form, and `handle_parse` returns an unknown handle on HTML5, so the restore reads them back with `asset_get_index` or as instance ids. Entering the intro, title, load or config rooms forgets the state. At Game Start `resume_start` takes it and goes to its room instead of the intro. There the `resume` transform's gates make the placed instances' Create events and creation code, and every Room Start, exit; the first Room Start calls `resume_restore`, which keeps the placed instances the saved game still had and destroys the rest without Destroy events, then creates the saved ones in id order (their Create events skipped too). The game keeps instance ids in plain numbers as well as handles, so ids are kept: placed instances have theirs from the room (100000 and up), and created ones (1000000 and up, from a counter) get theirs because the restore first uses up the counter, creating and destroying the event-less `oResumeMark`. The save records the next free id the same way and the restore uses up the counter to it, so ids of destroyed instances stay unused. Where the counter has already passed a saved id, numbers and handles holding it are remapped. Then it restores globals, variables and room state, restarts each instance's path where it was (`path_add`'s paths are plain numbers on HTML5, asset paths handles; an id that no longer exists, as after a `game_restart` renumbered `global.path`, is left off), recreates the battle `mp_grid`, shifts the play-time clock, and restarts the music and looping sounds at their positions. `resume_play` wraps `audio_play_sound` to keep each sound's handle.
     - `07-crash-report`: crash reports. Every 30 steps `resume_tick` hands the resume checkpoint to `crash_put` (`crash.js`) and reseeds the RNG from a new `global.crash_seed`; every step passes its frame time to `crash_step`. `crash.js` records key events and keeps checkpoints back about 10 s. After an uncaught error, or when the player types `BUG`, the page shows a `BARKLEY-CRASH-1:` report (gzip + Base64) to copy; `fuzz.mjs replay <build> <report file>` replays it against the build it came from.
     - `08-volume`: a VOLUME row in the Configuration menu, in the free slot under LANGUAGE (the menu is now full). It is a slider: 11 steps from 0 to 100%, the value in `global.sat[6]`, drawn as a track with the menu's basketball blip as its handle and the percentage beside it. `oStartConfig's Begin Step passes a changed value to `audio_master_gain` (which sets the Web Audio gain node), so it applies while the menu is open; `oController's Game Start applies the saved one before anything plays. Both go through the new script `sVolume(step)`, which returns `power(10,(step-10)*0.2)` and 0 at step 0: the steps are equal in decibels (4 dB each, 50% = -20 dB) rather than in amplitude, because a linear gain makes the top of the slider do almost nothing and the bottom drop away at once. `sConfig` writes it as a sixth line of `config.txt`, last, and reads it only when the file has one (`file_text_eof`), so a `config.txt` from an older build still loads and defaults to 100%.
     - `09-save-transfer`: on the Configuration menu's SETTINGS row, Saves replaces Test. (Test opened `RomTest`, a view-scaling check that means nothing now that `oScreenFill` presents the game and the SCALING row picks Integer or Sharp fit. A fourth option does not fit: the blip's pitch is fixed, so with four labels a blip either overlaps the previous label or falls outside the panel.) It calls `sSaveData`, which opens the browser save transfer (`saves.js`): a panel holding the three save slots as one block of Base64 gzip text, with Copy and Download, and a box to paste one back. Saves live in browser storage, which is per origin, so they are lost by clearing site data or switching browser; this carries them. Only `Save1..3.sav` travel, never the settings or the `SaveN0.sav` temp file. `sSaveData` writes a probe file and passes its name, because the runtime's storage keys carry a prefix built from the game's name and id (`BarkleyShutUpandJamGaiden.0.`) that the game cannot read; the key ending with the probe gives it. `file_exists` and `file_text_open_read` read storage live, so an imported slot shows up in Load Datafile without a reload.
     - `10-touch-controls`: the mobile touch overlay (`touch.js`) and a canvas backed by device pixels. `key_doset` passes the bound keys to `touch_keys`, `oController`'s Begin Step passes `sTouchContext()` to `touch_context`, and `oScreenFill` sizes the canvas with `touch_dpr()` and draws into `touch_view_*()`.
     - `11-gamepad`: game controllers (`gamepad.js`). `key_doset` passes the bound keys to `pad_keys` and `oController`'s Begin Step passes `sTouchContext()` to `pad_context`, so a pad follows SET KEYS and sends nothing while the player is rebinding. The shim polls the Gamepad API each frame and sends those keys: the d-pad and left stick steer (a direction turns on past 0.45 of the stick's travel and off again inside 0.3, and repeats while held, as an arrow key does), the bottom and left faces and both shoulders confirm or run, the right and top faces cancel, Start and Back open the menu. A press is held out to 100 ms so a tap between two of the game's 30 fps steps is never lost. The game's own GM6 joystick code (`key_joyemu`) is untouched: its one call site was already commented out in the original.
   - Generate `scripts/sRoomCaption.gml`: returns the GMX `<caption>` of the room it's given, or `''`.
5. Transforms, in order:
   - `cinema`: every `sCinemaN(obj,'code'|'cond',"<gml>")` string becomes a script `cin_NNNN` (deduplicated); `oCinema` runs it with `script_execute`.
   - `objectAdd`: `tob=object_add(); object_event_add(tob,ev,n,"<gml>")` becomes a real object `<owner>FxN` with those events.
   - `renameSa`: calls to the lost `sa` become `sBeatAdd`.
   - `imageSingle`: `image_single=N` becomes `image_index=N; image_speed=0;`; reads become `image_index`.
   - `parenStatements`: `if (c) (instance_create(...)).target=t;` becomes `if (c) { var __p; __p=instance_create(...); __p.target=t; }`, which the LTS importer can parse.
   - `reservedWords`: names that are keywords in modern GML (a variable called `throw`) get a trailing `_`.
   - `sound`: `sound_*` calls become `audio_*`; `sound_restore`/`sound_delete` are removed.
   - `legacyCalls`: functions LTS removed that the importer leaves alone (it compiles them as calls to an undefined instance variable, which crash at runtime): `variable_local_exists(n)` becomes `variable_instance_exists(id, n)`, `make_color` becomes `make_color_rgb`, and `object_delete(...)` is removed (the `object_add` objects are real objects now).
   - `drawTextStrings`: the text argument of `draw_text*`, `string_width*` and `string_height*` goes through `string()` unless it's plainly a string. GM 1.4 drew numbers; the importer wraps drawn text in `string_hash_to_newline()`, which throws for a number on HTML5 (every battle damage number, the equip comparison).
   - `gm6Real`: `real(string_digits(e))` becomes `real("0"+string_digits(e))`. GM6's `real` gave 0 for a string without a number; LTS throws (item use crashed on names like " Revive").
   - `noInstanceAssign`: every statement `obj.var = v` (with `obj` an object name) becomes `{if (instance_exists(obj)) obj.var = v;}`. GM6 set `var` on every instance, so with none it did nothing; LTS ends the game. `oIntro5` sets `oSoldier4.t=1` in `RomNeoYork1`, which has no `oSoldier4`, so the plot-3 soldier scene crashed every time. A static scan found about 85 such assignments in rooms that lack the object; the transform wraps all of them (about 800 lines change). Each whole statement is one edit, with its `;` inside the braces.
   - `creationCodeFirst`: GM6 ran a room instance's creation code before its Create event; LTS runs it after. For each object with a Create event and a placed instance with creation code (9 objects: `oMusic`, `oColliderGuy`, the treasures, `oMaze0`/`1`, `oExit239`/`240`), every placed instance's creation code (added where there was none) ends with `__gm6cc=1; event_perform(ev_create, 0);`, and the Create event starts with `if (object_index=X && id<1000000 && !variable_instance_exists(id, '__gm6cc')) exit;`. Created instances (ids from 1000000) run Create as before. Without it, roaming enemies had the default sprite, level-0 enemies and an `undefined` battle backdrop (every battle with one crashed), and `oMusic` read `val` as 0 (via `argumentDefaults`), so rooms with one stopped the music and looped sound asset 0 (`mBallbrain0`) instead of their track (read from the code; v22 was checked to play `mCatacomb` in `RomCatacombMain`).
   - `keyLatch` (modernized mode only): calls to `keyboard_check` and `keyboard_check_direct` become `key_check`, and `keyboard_clear` becomes `key_clear` (see patch `modernized/03-key-latch`). The three latch scripts are skipped because they read the runtime state.
   - `argumentDefaults`: a script that reads `argument0..N` starts with `if (is_undefined(argumentI)) argumentI=0;` for each, because GM6 read arguments a call didn't pass as `0` (76 scripts, about 7,000 short call sites). It tests `is_undefined`, not `argument_count`, because on HTML5 `argument_count` is never lower than the function's named parameters.
   - `resume` (modernized mode only): prepends `if (resume_skip(0)) exit;` to every Create event and instance creation code and `if (resume_skip(1)) exit;` to every Room Start event, and sends `audio_play_sound` calls to `resume_play` (see patch `modernized/06-resume`).
6. Pack; copy MP3/WAV into the placeholder sounds (MP3s streamed), mark every 2-channel sound stereo (the importer otherwise makes all sounds mono, losing the stereo music and intro sting), convert the 1×1 placeholder backgrounds and the 14 battle backdrops from GIF, replace the export's anti-aliased font renders with the glyph bitmaps from `BarkleyV120.exe`.
7. Game settings: new audio engine on, interpolation off.
8. Audit.

Because the extraction transforms run first, code that used to live inside strings also gets the later rewrites.

## Changing the migration

- A new mechanical rewrite: add a function to `transforms.mjs`.
- A new hand rewrite: unpack a pristine copy with `unpack()` from `lib/gmx.mjs`, replay step 3 and the existing patches, copy the tree, edit the copy, and save `diff -ruN a b` as the next numbered patch, with paths rewritten to `a/…` and `b/…`.

## Not automated yet

- **Post-import (LTS-only) work from phase 5 of the plan**:
  - Inline the `cin_NNNN` scripts as `function(){…}` arguments and run them with `method(id, fn)()`.
  - Change the 34 `#` newlines in strings to `\n`.
  - Rewrite room backgrounds against layers.
  - Clean up the minor `self.` and `room_speed` uses.
- **Verification (phase 6)**: play-testing beyond the title screen, against the original executable.
