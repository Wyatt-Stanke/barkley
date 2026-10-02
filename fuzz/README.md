# The fuzzer

Everything here but `corpus.json.gz` is code. Nothing in a build depends on it (`src/build.mjs` only borrows
`harness()` to check that a build can be fuzzed), so CI's build hash leaves this directory out.

```
fuzz/
  fuzz.mjs          the command line: build, run, verify, replay (and the exports one-off probe scripts use)
  video.mjs         a video of one corpus path
  corpus.json.gz    the corpus in the repository (below)
  lib/              the Node side
    fuzzer.mjs      the Fuzzer: workers and the run loop; the rest of its methods are mixed in from
    archive.mjs       nodes and snapshots, the corpus on disk, rebase
    search.mjs        progress, which node to start from, the program to play
    findings.mjs      what an episode found: features, exits, milestones, crashes
    report.mjs        the episode lines, the status box, summary.md, crash reports, the verify verdict
    verify.mjs        replays on separate browsers: from snapshots and from a fresh page
    browser.mjs     one headless Chromium over the DevTools protocol
    harness.mjs     the page script: the runtime's variable names found in the build, and page/ joined into one script
    corpus.mjs      packing and unpacking corpus.json.gz, the build id
    programs.mjs    input macros, random programs, the generators' base weights
    story.mjs       menu rooms, volatile globals, story flags
    replay.mjs      replaying a finding or a player's crash report with screenshots
    serve.mjs       the build's HTTP server and the ports
    util.mjs        the repository root, timing, random picks, colours
  page/             the in-page side, in the order it is joined (see harness.mjs)
    core.js         __fuzz, the runtime's names, safe(), the game accessors
    clock.js        virtual time: the clock, step(), the loading pump
    coverage.js     every gml_* function wrapped to record that it ran
    input.js        held keys as key events
    hooks.js        the game's own functions replaced (resume_take, path_add, crash_step...) and a fresh start
    render.js       WebGL drawing on or off, sound off
    snapshot.js     save and restore
    known.js        what the fuzzer has seen, kept in step with the Node side
    probe.js        what the page reports: room, plot, position, the fight, the party, healing items and healers
    novelty.js      cells, flags, the next plot's conditions, the baseline
    walk.js         the episode's RNG, instances, routes and walking
    generators.js   the closed-loop generators (dialog, exit, talk, seek, travel, heal, battle)
    goals.js        where the story moves on, read from the build
    through.js      --through: known crash classes patched
    episode.js      an episode: a program played, what was new, snapshots
    replay.js       replays and crash report runs
```

**The page side is written as modules but runs as one script.** It has to run before the game's scripts
(`Page.addScriptToEvaluateOnNewDocument`), as a classic script whose `'use strict'` functions stop the runtime's error
trace (see `biome.jsonc`), so `harness.mjs` joins the files in a fixed order inside one function and drops their
`import` and `export` lines: they share one scope, and an import is only the name. The imports are still real: Biome
checks them, and an editor follows them. Two rules follow. A file's top-level code runs in the join order. And a module
never assigns to another module's variable (that works in the joined script, but it isn't valid module code): shared
mutable state is an object (`clock`, `feed`, `known`) or has a setter in the module that owns it (`setGoals`,
`reseed`). A new file goes into `PAGE` in `harness.mjs`, which refuses a file that isn't listed there.


The fuzzer (`fuzz.mjs`) looks for crashes by playing the game fast and in parallel, and remembers the paths it took. It needs an
unobfuscated modernized build, which its `build` command makes from an imported project (a copy of it and of the user
folder, so neither is touched):

```sh
node fuzz/fuzz.mjs build build/outputs/barkley-1.4.1/BarkleyLTS.yyp build/fuzz/build     # about 70 s
node fuzz/fuzz.mjs run build/fuzz/build --save --corpus --through --verbose           # until Ctrl-C (or --minutes=M)
node fuzz/fuzz.mjs verify build/fuzz/build --minutes=5                               # the corpus against this build
node fuzz/fuzz.mjs replay build/fuzz/build build/fuzz/<run>/crashes/1                    # from a fresh page, with screenshots
```

A corpus path can be watched as a video: `fuzz/video.mjs` plays one from a fresh page as `verify` replays a path (the
fuzzer's snapshot after every step, and its restores before the steps it began with one) and pipes the canvas after
each step to ffmpeg: an H.264 MP4 at 60 frames a second, the game's speed (`oController` sets `room_speed` 60), scaled
2x, no sound. A `.txt` beside it says when each room and plot comes up, and whether the path ended where it was
recorded (exit 1 if not). It plays with `--through`, as the corpus was recorded. The default path is the longest in
`fuzz/corpus.json.gz`; `--node=<id>` picks another by its last node,
`--speed=N` draws every Nth step (a huge N only checks that the path replays, ~3 min). About 20 ms a step: the longest
path in the 2026-09-26 corpus (node 13959, 99,191 steps, 27.5 minutes of play, ending in the catacombs at plot 4) takes
about 35 minutes.

```sh
node fuzz/video.mjs build/fuzz/build build/fuzz/video/longest.mp4 [--node=<id>] [--speed=N] [--corpus=<file|dir>]
```

`--corpus=build/fuzz/corpus` takes the working copy, which can have more paths than the packed file (packing keeps
only the paths to nodes that own something). A working copy from before 2026-10-01 can also hold paths that were
recorded on an older build and never played again (see Rebase).

It also runs on the deployable build (`fuzz.mjs build --minify`, the pipeline's `site/`): terser keeps the `gml_*`
names, and the harness finds the runtime's variables in both forms. Replays on the two match.

`--save` keeps the findings in `build/fuzz/<date-time>/` (or `--save=<dir>`): `summary.md` indexes every
crash (`crashes/<n>/`) and milestone path (`paths/<n>-<room>-p<plot>/`, the first time the search reached a room or a
plot), each with a `report.md`, the inputs from the new game, a snapshot of the game state and screenshots. `--verbose`
prints a line per episode: where it started, how long it played, and what was new (◆ cells, ƒ GML functions, ⚑ values
of globals). `--corpus` starts from the archive in git, `fuzz/corpus.json.gz`, and keeps it
there (below). `--through` patches known crash classes in the page (numbers drawn as text, `real()` of a
non-number, `script_execute` of a number that is no script) so the search gets past them; each patched spot is still reported, as a `patched` crash, and replayed
without the patches. `--workers` (default: physical cores − 2) sets the number of browsers, `--port` the ports.

**The corpus in git** (`fuzz/corpus.json.gz`, ~250 KB): one gzipped JSON of the search's state (features, learned
globals, exits, things talked to, known crash signatures, the program dictionary) and its nodes, pruned to the ones on
the way to a node that owned features, and without snapshots. Snapshots only restore into the build that made them, and
Igor builds are never byte-identical, so they would be dead weight: a run makes them again from the paths. The file's
bytes depend only on its content (no timestamps, a fixed gzip header), so a run that found nothing leaves no diff.
`run --corpus` unpacks it into `build/fuzz/corpus/`, which keeps the snapshots between runs on the same build (the
directory is reused while `packed.md5` matches the file; otherwise it is replaced), and packs it again at every save.
Commit the file after a run that found something. `--corpus=<file.json.gz>` uses another packed corpus;
`--corpus=<dir>` a plain directory, never packed.

**Rebase** (a corpus from another build, which is every run on a fresh build): the corpus's paths are played again on
the new build as a tree. Each node is played from the snapshot of the node its episode started from, which is made again
first, so every recorded frame is played once and the restores are the ones the search made (about 6 paths a second
on 6 browsers). A replay that ends in another room or plot than recorded is dropped with everything recorded after it:
those inputs were for a state that no longer happens, and kept as candidates that own nothing they crowded the search
(the first try kept them, and 1,100 of 2,400 snapshots stood in one room). Their features can be found again. If not one path replays,
the run stops and leaves the corpus as it was, since that means the harness or the build is broken.
Only the targets are nodes that owned features; the nodes on their way are played but not checked, and take the probes
their replay ended at. Every node the rebase didn't play (a path that owned nothing, after its last owner) is dropped
from the working copy: it still had the probes of the build it was recorded on, and a replay of it went somewhere
else (before this, a 122,450-step path recorded ending at plot 5 sat in the working copy and stuck at plot 2 on the
build after).

**`verify`** checks the game rather than looking for new things (the pull request workflow runs it). It reads the
packed corpus (never writes it), plays the spine again (the furthest node of each room and plot and the nodes on its
way, ~320 paths in about 2 minutes; `--all` for every one), explores for `--minutes` (none by default) with
`--through`, and replays every crash the corpus doesn't know, and every one it knows that comes back, from its snapshot
and from a fresh page. It exits 1 on such a crash that replays either way or couldn't be replayed, so a fixed bug
coming back fails as a new one does; the corpus's crash list is the record of what has been found, not a list of
crashes to ignore. Crashes that only a restore causes (`restore`, `stall`,
`hang`), paths that now end in another room or plot, and rooms no replayed path reached are warnings; `--strict` makes
the last two failures. It also plays the longest spine path once more from a fresh page with no restores at all (a
few minutes, on its own browser, while the rest runs): the spine was played with the fuzzer's restores, so if
continuous play ends in another room or plot the restores are not what the game does, and that fails; another spot in
the same room is a warning (`--strict`: a failure). A change to the game that moves where recorded inputs lead shows up as those warnings, not as a
failure. The verdict is `<findings>/verify.md` and goes to `$GITHUB_STEP_SUMMARY`.

How it works:

- **Virtual time** (`page/clock.js`; the page side is injected before the game loads): `performance.now`/`Date.now` read a
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
  found something before). After every macro step the page looks for something new: a cell (room, plot, and the
  player's position in 32 px, plus the party's vitality in thirds where roaming monsters are about, everywhere at plots from the furthest one less one (so a party healed at an inn is new on each room of its way back to a boss), and in the room the next plot is reached in (the bosses' rooms: before this a half-dead party's arrival in the church owned it, and the Jordan fight it starts was never fought healthy); in a battle instead the first enemy, the eighths of the enemies' vitality left, the
  party members standing and the party's vitality in quarters, so a state that brought a boss lower or kept the party
  healthier is new and the search can work its way to a win), a (room, GML function) pair (every `gml_*` function is wrapped to record that it ran; a cutscene
  shows up as its `cin_NNNN` steps), or a value of a game global never seen before (story flags such as `plot=3` or
  `treasure[3]=1`; globals whose values churn are learned as volatile and ignored), including the pseudo-flag
  `goal=<plot>:<bits>`, which of the next plot's conditions hold (so a state that meets two of them at once, such as
  Larry and Chin both talked to, becomes a node even though each value on its own was already known), and
  `xp=<n>`, the party's experience in steps of 40 (so grinding is progress: the plot-5 boss, 1317 vitality, was only
  beaten once the party had levels). Where it finds one it snapshots the
  game, and that node joins the archive. Picks favour nodes chosen less often, found recently and further in the story
  (`progress`: plot, then the next plot's conditions met, the party's levels and experience (25 a level, up to 600: capped at 300, a party at total level 12 had nothing to gain from grinding for the Jordan fight at plot 7, which a healthy level-12 party loses), how far a boss fight got
  (bosses are the `sBoss` entries, read from the build), the party's vitality outside a fight, rooms on the path,
  story globals changed since the new game; recomputed when the corpus loads); menus and the debug room hardly count.
  Most picks go by plot: the furthest plot reached gets 55% of them, the one before 30%, the rest 15%, and half of the
  picks within a plot keep to its nodes within 60 of its best progress, so a new plot is worked on at once rather than
  drowned out by thousands of nodes behind it (before this, nine picks in ten went to plots already done).
- **Generators** (in the page, closed-loop: they read the game between 4-frame chunks, and the keys they press are
  recorded, so replays need no generator): `dialog` presses action until the player can move,
  moves the cursor to a random option when a dialog offers a choice (pressing straight through takes the first), and
  answers quick-time events (`oQuicker`, a cinema command: the key it shows within about 20 frames, or a life lost; the
  right key 9 times in 10) - the way from NeoYork1 to the catacombs at plot 3 is a run of them, which random presses
  almost never passed; the walking generators wait out the moment a room freezes the player on entry
  (`global.freeze`, about 20 frames), since a new room's first snapshot is taken right there and they used to give up
  on it at once; `exit` walks to an exit
  not taken from this room yet (a breadth-first route on an 8 px grid around solid instances, with the player's box taken 4 px smaller on each
  side and a waypoint counted reached within 4 px: the game's corner shifter slides the player round small overlaps,
  and RomSewer1's ladders are gaps exactly as wide as the player's 16 px box, which a full-size box never routed through) and takes it, by
  walking into it (`oExitPar` children and exits with their own collision event with `oBarkley`) or pressing action
  beside it; the exit recorded is the one nearest the player's last position, since the way to one exit can cross
  another (a corpus exit that seems to lead to several rooms is dropped on load); `talk` walks up to something usable (`oItem`
  descendants: people, signs, pumps) not talked to at this plot and goal mask and presses action; `seek` walks to a reachable spot
  not visited yet; `travel` heads for a story goal room through the known room graph (several hops; after a failed hop it tries
  other exits) (goal rooms place objects whose
  code sets `global.plot` to the next value, read from the build); `heal` (only outside a fight, when someone is below
  80% vitality) talks to a healer in the room if there is one (an object whose events call `sFullheal`, or a script that does, such as the Shark at the sewer inn, 25 Neo-Shekels) and takes the first answer, or opens the start menu's Items, picks a healing item (a `refItem` entry whose effect reads `VP +`, read
  from the build) and gives it to the weakest member; `battle` presses action, cancel and arrows in a
  battle's rhythm, or four times in five fights: it reads the battle menu's state, mostly attacks the first target
  (sometimes it uses an item, a skill or defends instead, more often items when a member is below 40%, on an ally
  half the time), runs now and then (more when someone is low; bosses can't be run from), and in `postattack` attacks:
  Vince's and Balthios's attacks wait for a press (action fires the laser; Balthios picks with action, cancel or
  start), and before that was pressed a Vince turn waited about a minute for a random action; Cyberdwarf's is a combo (`oBComboMeter`): it presses as soon as he waits for the next move, alternates jab, kick and punch (a move unlike the last does a quarter more), and now and then ends on a finisher. One press and a wait had made his whole turn one jab, and the Jordan/Vince fight at plot 7 was lost every time; with the combo a healthy party wins it. Barkley's attacks are timing moves scored on the release, so taps barely ever
  hit: most of the time it passes (holds cancel and lets go so that `oBTimer`'s side meter is at its end, `zy` 4, one
  step later, when the throw reads it: the most damage, about twice his power) or takes a jump shot (up held about 25 frames, to the top of the jump), and
  otherwise holds any move for a random time. A fight that begins during an episode (an enemy walked
  into, the end of a cutscene) is fought by `battle` whatever generator was planned next; otherwise a walking generator
  in `RomInter` has no player to walk and gives up the rest of the episode, which in the catacombs, where every walk
  ends in a fight, was nearly every episode. Programs are either random macros or a few generators with macro bits between them; each
  generator's pick weight grows with what it found per frame lately.
- **Crashes** are grouped by message and GML function. The first of each is replayed on a separate browser from its
  nearest snapshot (the same restores: a determinism check) and from a fresh page with no restores at all (fresh pages start alike: the loading pump stops at Game Start
  and the harness restarts the game from a fixed clock, seeds, ids and empty storage), which tells
  a real crash from an artifact of the snapshots. A GML error is the runtime's error object (`gmlmessage`,
  `gmlstacktrace`); a JS error in the runtime (a GML value of the wrong type) has a JS stack.
