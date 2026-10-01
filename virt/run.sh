#!/bin/sh
# The whole thing, one command:
#
#   virt/run.sh [out dir]
#
#   BarkleyV120.exe  --(the GM6 decompiler, in a container)--> BarkleyV120.gm6
#                    --(LateralGM, in a container)-----------> BarkleyV120.gmx
#
# Both halves are Java. decompile.sh and convert.sh each explain their own half,
# and virt/README.md says what the export was checked against.
#
# BARKLEY_SKIP_DECOMPILE=1 keeps an existing build/virt/BarkleyV120.gm6.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
BARKLEY_ROOT=${BARKLEY_ROOT:-$(cd -- "$VIRT_DIR/.." && pwd)}
export BARKLEY_ROOT

OUT=${1:-$BARKLEY_ROOT/build/virt/BarkleyV120.gmx}
GM6=$BARKLEY_ROOT/build/virt/BarkleyV120.gm6

for input in "$BARKLEY_ROOT/game/original/BarkleyV120.exe" \
             "$BARKLEY_ROOT/game/original/GMDecompilerDecompiled/src/main/java"; do
  if [ ! -e "$input" ]; then
    echo "missing input: $input" >&2
    echo "(set BARKLEY_ROOT to the checkout that has game/original/)" >&2
    exit 1
  fi
done

if [ -n "${BARKLEY_SKIP_DECOMPILE:-}" ] && [ -s "$GM6" ]; then
  echo "==> Keeping the existing $GM6"
else
  "$VIRT_DIR/decompile.sh" "$GM6"
fi

"$VIRT_DIR/convert.sh" "$GM6" "$OUT"

echo
echo "Export: $OUT"
