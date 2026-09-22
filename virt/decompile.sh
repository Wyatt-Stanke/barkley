#!/bin/sh
# Step 1, on the host:  BarkleyV120.exe  ->  BarkleyV120.gm6
#
#   virt/decompile.sh [out.gm6]
#
# This step is plain Java -- it never touches GameMaker -- so it does not need
# the Windows VM. It runs in a container instead, which is both faster and far
# more reliable than the guest: the decompile is the heaviest CPU load in the
# whole pipeline, and under QEMU's HVF accelerator that load is exactly what
# made the guest bugcheck (see virt/README.md, "The guest bugchecks").
#
# The decompiler is compiled from the sources kept at
# game/original/GMDecompilerDecompiled, together with the headless entry point
# in virt/java/Decompile.java -- GmDecompilerCli cannot do this on its own
# (that file explains why). Java 8 exactly: ProgressDialogListener calls
# Thread.stop(), which has been gone since Java 20.
#
# The result is byte-identical to what the Java GUI produces, and is checked
# against the SHA-256 below unless BARKLEY_GM6_SHA256 says otherwise.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
BARKLEY_ROOT=${BARKLEY_ROOT:-$(cd -- "$VIRT_DIR/.." && pwd)}

# The .gm6 the hand-run GUI produced, and what game/BarkleyV120.gmx came from.
EXPECTED=${BARKLEY_GM6_SHA256:-4b76af44edbf8c6bd980a7693e78520646059ec6edbacf4051b336dfb30f9b32}

# Temurin 8: the only JDK 8 with current multi-arch images.
IMAGE=${BARKLEY_JDK_IMAGE:-docker.io/library/eclipse-temurin:8u462-b08-jdk-noble}

OUT=${1:-$BARKLEY_ROOT/build/virt/BarkleyV120.gm6}

if [ -n "${BARKLEY_CONTAINER:-}" ]; then
  ENGINE=$BARKLEY_CONTAINER
elif command -v podman > /dev/null 2>&1; then
  ENGINE=podman
elif command -v docker > /dev/null 2>&1; then
  ENGINE=docker
else
  echo "no container engine: install podman (brew install podman) or docker" >&2
  exit 1
fi

EXE=$BARKLEY_ROOT/game/original/BarkleyV120.exe
SRC=$BARKLEY_ROOT/game/original/GMDecompilerDecompiled/src/main/java

for input in "$EXE" "$SRC" "$VIRT_DIR/java/Decompile.java"; do
  if [ ! -e "$input" ]; then
    echo "missing input: $input" >&2
    echo "(set BARKLEY_ROOT to the checkout that has game/original/)" >&2
    exit 1
  fi
done

# Everything the container sees lives under one directory, so there is exactly
# one mount and nothing of the checkout is writable from inside it.
WORK=$BARKLEY_ROOT/build/virt/decompile
rm -rf "$WORK"
mkdir -p "$WORK/src" "$WORK/classes" "$WORK/run"

cp "$SRC"/*.java "$WORK/src/"
# The headless entry point belongs to this pipeline, not to the decompiler.
cp "$VIRT_DIR/java/Decompile.java" "$WORK/src/"
# In its own directory: the extractor writes the game's included files (bgm.dll,
# Music/, Voice/, BG/) beside the exe, and reuses a stale .gmr if it finds one.
cp "$EXE" "$WORK/run/BarkleyV120.exe"

echo "==> Compiling and decompiling in $ENGINE ($(basename "$IMAGE"))"
# The decompiler writes its output a few bytes at a time, and on macOS the
# bind mount into the container is a virtiofs share, so doing that work on the
# mount runs at about a fifth of the speed for a twentieth of the CPU. Copy the
# exe onto the container's own filesystem, decompile there, and hand back only
# the finished file.
#
# --network=none: this reads one file and writes another; it has no business
# reaching anything. Running as the invoking user keeps the output owned by
# them rather than by root (podman maps this through its own userns).
"$ENGINE" run --rm \
  --network=none \
  --user "$(id -u):$(id -g)" \
  -v "$WORK:/work" \
  -e HOME=/tmp \
  "$IMAGE" \
  sh -euc '
    mkdir -p /tmp/classes /tmp/run /tmp/prefs
    javac -nowarn -d /tmp/classes /work/src/*.java
    cp /work/run/BarkleyV120.exe /tmp/run/
    cd /tmp/run
    # -Djava.awt.headless=true: the launcher builds a JTextField, because the
    # decompiler reads its source path out of the GUI field, and there is no
    # display here for AWT to attach to.
    # -Djava.util.prefs.*Root: RememberingFileChooser stores the last-used
    # directory in java.util.prefs, which has nowhere to write here and warns
    # four times about it.
    java -Djava.awt.headless=true \
         -Djava.util.prefs.userRoot=/tmp/prefs -Djava.util.prefs.systemRoot=/tmp/prefs \
         -cp /tmp/classes Decompile BarkleyV120.exe
    cp /tmp/run/BarkleyV120.gm6 /work/run/BarkleyV120.gm6
  '

GM6=$WORK/run/BarkleyV120.gm6
[ -s "$GM6" ] || { echo "no .gm6 was produced" >&2; exit 1; }

HASH=$(shasum -a 256 "$GM6" | cut -d' ' -f1)
SIZE=$(wc -c < "$GM6" | tr -d ' ')
echo "    BarkleyV120.gm6  $SIZE bytes  sha256 $HASH"

if [ -n "$EXPECTED" ] && [ "$HASH" != "$EXPECTED" ]; then
  echo "the .gm6 does not match the expected hash" >&2
  echo "  got      $HASH" >&2
  echo "  expected $EXPECTED" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$OUT")"
cp "$GM6" "$OUT"
echo "==> Step 1 done: $OUT"
