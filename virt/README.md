# `virt/` — the GMX export from the original executable

`game/BarkleyV120.gmx` is a GameMaker: Studio 1.4 GMX export of the game. This
directory reproduces it from `game/original/BarkleyV120.exe` with no person at
the keyboard. Both steps are Java, run in a container:

```
BarkleyV120.exe
   |  the GM6 decompiler (game/original/GMDecompilerDecompiled), headless,
   |  in a container -- about 75 seconds
   v
BarkleyV120.gm6
   |  LateralGM, patched and headless, in a container -- about a minute
   v
BarkleyV120.gmx
```

```sh
virt/run.sh [out dir]            # both steps -> build/virt/BarkleyV120.gmx
virt/decompile.sh [out.gm6]      # step 1 -> build/virt/BarkleyV120.gm6
virt/convert.sh [in.gm6] [out]   # step 2 -> build/virt/BarkleyV120.gmx (+ .gmx.tar)
```

Each script's header says how it works and why. All take `BARKLEY_ROOT` (the
checkout that has `game/`) and `BARKLEY_CONTAINER` to pick podman or docker.

## What you need

- **podman** or **docker** (podman preferred).
- **git**, for the LateralGM clone (kept in `build/virt/lateralgm-src`).
- The untracked inputs `game/original/BarkleyV120.exe` and
  `game/original/GMDecompilerDecompiled/` (`node src/fetch.mjs` provides both).
- An internet connection the first time: the JDK image and the clone.
- Around three minutes.

## The pieces

| | |
|---|---|
| `run.sh` | both steps, one command |
| `decompile.sh` | step 1: the exe to a `.gm6` |
| `java/Decompile.java` | the decompiler's "GM6 EXE" path with the window left out |
| `convert.sh` | step 2: the `.gm6` to a `.gmx` with LateralGM |
| `lateralgm/Gm6ToGmx.java` | LateralGM's open-and-save-as with no window |
| `lateralgm/patches/` | four fixes to LateralGM's GMX writer, applied at build time |

## Step 1: the exe to a `.gm6`

Compiles the decompiler from the sources in `game/original/GMDecompilerDecompiled`
together with `java/Decompile.java`, and checks the result's SHA-256: the output
is byte-for-byte the `.gm6` the decompiler's GUI produces (`4b76af44…`,
10,720,322 bytes).

Three things make it work headless: the decompiler reads its input path out of
a Swing text field (`GmDecompiler.sourceField`), which the launcher fills in
instead of building a window; the JVM runs with `-Djava.awt.headless=true`,
without which it waits forever for a display; and it is Java 8 exactly, because
`ProgressDialogListener` calls `Thread.stop()`, removed in 20.

The work happens on the container's own filesystem, not on the bind mount: the
decompiler writes its output a few bytes at a time, which through virtiofs on
macOS runs at about a fifth of the speed.

## Step 2: LateralGM

[LateralGM](https://github.com/IsmAvatar/LateralGM) reads GM6 and writes GMX
directly. It is cloned at a pinned commit and the patches in `lateralgm/patches`
are applied at build time, so nothing is vendored. They fix four things in its
GMX writer:

1. **The transparency key.** The sprite path ran the pixels through java.awt's
   `RGBImageFilter`, which clears the colour under the pixels it makes
   transparent; the background path never applied the key at all, so ten
   backgrounds came out fully opaque.
2. **Smooth edges.** GM6 stores every image as a 24-bit BMP, so there is no
   alpha in the file; the flag is a bool in the sprite record and GM6 softened
   the silhouette itself. GMX has no field for the flag, so GameMaker bakes the
   result into the PNG, and an export that does not bake it loses the setting.
   The rule is `alpha = 255 - 32 * transparent neighbours`; this game has
   exactly one sprite with the flag, `sShadow`, and all 86 of its pixels match.
3. **Separate collision masks.** GM6 has no field for them, so the property
   kept its default of false and every frame of an animation would share one
   merged mask. GameMaker's own GM6 import gives all 458 sprites
   `<sepmasks>-1</sepmasks>`.
4. **The size of a sprite with no frames.** LateralGM writes `0`; GameMaker
   writes `32`. Importing a 0x0 sprite leaves `frames`, `layers` and `sequence`
   all null in the `.yy`, and the LTS asset compiler dereferences them
   (`NullReferenceException` in `GMSprite.SetFromResource`). This game has four
   such sprites: `sBG0`, `sBG1`, `sBG2` and `sNull`.

Compared with `game/BarkleyV120.gmx`:

- all **1452 PNGs are pixel-identical**, including the RGB under fully
  transparent pixels;
- `migrate.mjs` audits clean ("No items to review"), and its code tree differs
  from the pristine one **only in the 165 `inst_XXXXXXXX` filenames**, which are
  arbitrary hashes on both sides — not one line of GML.

What differs is how the XML is written, not what it says: attribute order, `1.0`
for `1`, `&#13;` for a carriage return, `<caption/>` for an empty caption,
Studio-only fields (`TextureGroups`, `audioGroup`, `clearDisplayBuffer`, the
Android and iOS option lists) that LTS regenerates or ignores, and `Configs/`
platform templates. `src/lib/gmx.mjs` and `src/migrate.mjs` read GMX by
attribute name, so none of it matters.

LateralGM keeps `scripts/sA.gml` beside `scripts/sa.gml`, and `bgm_Init.gml`
beside `bgm_init.gml`. A case-insensitive filesystem collapses each pair, which
is why the pristine export lacks them and `game/recovered-scripts/` exists. The
`.gmx.tar` that `convert.sh` leaves beside the directory keeps all four.

LateralGM writes no font glyph PNGs and no `<glyph>` entries; `importFonts` in
`src/assets.mjs` writes both from the original executable for every export.
