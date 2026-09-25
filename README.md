# Barkley, Shut Up and Jam: Gaiden — web port

A reproducible port of _Barkley, Shut Up and Jam: Gaiden_ v1.20 (Tales of Game's Studios) from its original
Game Maker 6 executable to **GameMaker LTS 2026**, built for **HTML5** and played in the browser.

Nothing of the game is in this repository. The pipeline downloads the original release from the
[Internet Archive](https://archive.org/details/BarkleyShutUpAndJamGaiden), decompiles it, rewrites what modern
GameMaker no longer supports, and builds the web version, every time, from scratch.

## Build it

```sh
node src/pipeline.mjs
```

That runs every step, in about five minutes on a GitHub runner (a little longer the first time on a new machine,
while it downloads the game and the tools):

| step | what | tool |
|---|---|---|
| fetch | the original game (archive.org, MD5-checked) and the GM6 decompiler's source | `src/fetch.mjs` |
| export | `BarkleyV120.exe` → `.gm6` → a GameMaker: Studio 1.4 GMX, in Java containers | `virt/run.sh` |
| migrate | the GMX → one that GameMaker LTS can import (patches, AST transforms, the real music and fonts) | `src/migrate.mjs` |
| import | → a GameMaker LTS project, with the page template and its extensions | `src/import.mjs` |
| build | Igor's HTML5 build, minified, plus the page around the game (SolidJS, built from `src/web`) and the service worker for offline play | `src/fuzz.mjs build`, `src/page.mjs` |
| play-test | boots the site in headless Chromium and starts the game; fails on an uncaught exception | `src/playtest.mjs` |

The site lands in `build/pipeline/site/`; serve it with `python3 -m http.server` from there. A step whose output
already exists is skipped, so a failed run picks up where it stopped.

**What you need:** Node.js 24+ with npm (for the page's packages), `curl`, `unzip`, `git`, `patch`, `ffmpeg`/`ffprobe`, `python3`, and podman or docker.
And a GameMaker licence, one of:

- GameMaker LTS 2026 installed and signed in (on a Mac, the pipeline uses the IDE's importer and the installed
  runtime as they are), or
- `GAMEMAKER_ACCESS_KEY` set to an access key from <https://gamemaker.io/account/access_keys>: then
  `src/toolchain.mjs` downloads everything else — ProjectTool, Igor, the runtime's HTML5 module and a headless
  Chromium — into `build/tools/`. Run `node src/toolchain.mjs` to install them and see where each one is.

## Continuous deployment

`.github/workflows/pages.yml` runs `node src/pipeline.mjs` on an Ubuntu runner on every push to `main`, and deploys
the site to this repository's GitHub Pages. It needs one repository secret, `GAMEMAKER_ACCESS_KEY`, and Pages set to
deploy from GitHub Actions. The play-test's screenshot is kept as the run's `playtest` artifact.

## More

- [`src/README.md`](src/README.md): every patch and transform, the web page (`src/web`), offline play, and the fuzzer.
- [`virt/README.md`](virt/README.md): how the executable becomes a GMX without Windows.
- [`CLAUDE.md`](CLAUDE.md): the working notes — commands, gotchas, current state.

The original game is by Tales of Game's Studios. This repository holds only the tooling that ports it.
