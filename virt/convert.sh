#!/bin/sh
# Step 2, on the host:  BarkleyV120.gm6  ->  BarkleyV120.gmx
#
#   virt/convert.sh [in.gm6] [out dir]
#
# This is the step the Windows VM existed for: GameMaker: Studio 1.4 imports a
# .gm6 and exports a GMX. LateralGM reads GM6 and writes GMX directly, so it
# does the same job as plain Java, in a container, in about a minute -- no
# Windows, no licence, no GUI automation. virt/README.md has the comparison
# against the hand-made export that decided this.
#
# LateralGM is cloned at the pinned commit below and the patches in
# virt/lateralgm/patches are applied to it; virt/lateralgm/Gm6ToGmx.java is the
# headless entry point. Nothing is vendored, so upstream's history still tells
# you what you are running.
#
# Java 8 exactly, and -source/-target 1.7: LateralGM's own Makefile builds that
# way, and under 8 without it GMXFileWriter.java:1333 is an ambiguous println.
#
# NOTE ON CASE: the GMX holds scripts/sA.gml and scripts/sa.gml, and
# bgm_Init.gml and bgm_init.gml. On a case-insensitive filesystem -- which is
# the default on macOS, and was true of the Windows machine GameMaker made the
# pristine export on -- each pair collapses to one file. The tar this writes
# keeps all four; extracting it does not. That is why the pristine export is
# missing them, and why game/recovered-scripts/ exists.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
BARKLEY_ROOT=${BARKLEY_ROOT:-$(cd -- "$VIRT_DIR/.." && pwd)}

REPO=${BARKLEY_LGM_REPO:-https://github.com/IsmAvatar/LateralGM.git}
# Master as of 2026-09-22. Anything newer needs the patches re-checked.
COMMIT=${BARKLEY_LGM_COMMIT:-d315565a76f0186a123e6b3424a09b6ea5760d0c}
IMAGE=${BARKLEY_JDK_IMAGE:-docker.io/library/eclipse-temurin:8u462-b08-jdk-noble}

GM6=${1:-$BARKLEY_ROOT/build/virt/BarkleyV120.gm6}
OUT=${2:-$BARKLEY_ROOT/build/virt/BarkleyV120.gmx}
NAME=${BARKLEY_PROJECT_NAME:-BarkleyV120}

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

[ -s "$GM6" ] || { echo "missing input: $GM6 (run virt/decompile.sh first)" >&2; exit 1; }

# The clone is kept between runs -- it is 60 MB and the pin never moves on its
# own. JoshEdit is a submodule and LateralGM does not compile without it.
SRC=$BARKLEY_ROOT/build/virt/lateralgm-src
if [ ! -d "$SRC/.git" ]; then
  echo "==> Cloning LateralGM"
  rm -rf "$SRC"
  git clone --quiet "$REPO" "$SRC"
fi
echo "==> LateralGM at $COMMIT"
(
  cd "$SRC"
  git fetch --quiet origin
  git checkout --quiet --force "$COMMIT"
  git submodule --quiet update --init --recursive
)

WORK=$BARKLEY_ROOT/build/virt/convert
rm -rf "$WORK"
mkdir -p "$WORK/out"

# A copy, so the patches never touch the clone and the next run starts clean.
cp -R "$SRC" "$WORK/lgm"
rm -rf "$WORK/lgm/.git"
cp "$VIRT_DIR/lateralgm/Gm6ToGmx.java" "$WORK/lgm/"
cp "$GM6" "$WORK/BarkleyV120.gm6"

for p in "$VIRT_DIR"/lateralgm/patches/*.patch; do
  echo "    patch $(basename "$p")"
  ( cd "$WORK/lgm" && patch -p1 --silent < "$p" )
done

echo "==> Building and converting in $ENGINE ($(basename "$IMAGE"))"
# As in decompile.sh: the work happens on the container's own filesystem and
# only the finished tar crosses the bind mount, because writing thousands of
# small files through virtiofs on macOS is an order of magnitude slower.
"$ENGINE" run --rm \
  --network=none \
  --user "$(id -u):$(id -g)" \
  -v "$WORK:/work" \
  -e HOME=/tmp \
  -e NAME="$NAME" \
  "$IMAGE" \
  sh -euc '
    cp -R /work/lgm /tmp/lgm
    cd /tmp/lgm
    mkdir -p /tmp/classes /tmp/prefs /tmp/out
    CP=modules/joshedit/src/main/java:modules/joshedit/src/main/resources
    find org modules/joshedit/src/main/java -name "*.java" > /tmp/srcs.txt
    echo Gm6ToGmx.java >> /tmp/srcs.txt
    javac -nowarn -encoding UTF-8 -source 1.7 -target 1.7 \
          -bootclasspath "$JAVA_HOME/jre/lib/rt.jar" \
          -cp "$CP" -d /tmp/classes @/tmp/srcs.txt 2>&1 | grep -v "^Note:" || true
    # The .lgl action libraries and the rest of the resources are not source,
    # so javac does not copy them; the reader dies without the libraries.
    for f in $(find org -type f ! -name "*.java"); do
      mkdir -p "/tmp/classes/$(dirname "$f")"; cp "$f" "/tmp/classes/$f"
    done
    java -Djava.awt.headless=true \
         -Djava.util.prefs.userRoot=/tmp/prefs -Djava.util.prefs.systemRoot=/tmp/prefs \
         -Xmx2g -cp /tmp/classes Gm6ToGmx \
         /work/BarkleyV120.gm6 "/tmp/out/$NAME.gmx" "$NAME" \
         /tmp/classes/org/lateralgm/resources/library/default
    tar -C /tmp/out -cf "/work/out/$NAME.gmx.tar" "$NAME.gmx"
  '

TAR=$WORK/out/$NAME.gmx.tar
[ -s "$TAR" ] || { echo "no GMX was produced" >&2; exit 1; }
echo "    $NAME.gmx.tar  $(tar -tf "$TAR" | grep -vc '/$') files"

OUT_PARENT=$(dirname -- "$OUT")
mkdir -p "$OUT_PARENT"
rm -rf "$OUT"
tar -C "$OUT_PARENT" -xf "$TAR"
[ "$OUT_PARENT/$NAME.gmx" = "$OUT" ] || mv "$OUT_PARENT/$NAME.gmx" "$OUT"
cp "$TAR" "$OUT_PARENT/$NAME.gmx.tar"

echo "==> Step 2 done: $OUT"
echo "    ($NAME.gmx.tar beside it keeps the files a case-insensitive"
echo "     filesystem cannot: see the note at the top of this script)"
