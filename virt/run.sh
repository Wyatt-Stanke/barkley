#!/bin/sh
# The whole thing, one command:
#
#   virt/run.sh
#
# The pipeline is in two halves, and only the second needs Windows:
#
#   BarkleyV120.exe  --(the GM6 decompiler, in a container)-->  BarkleyV120.gm6
#                    --(GameMaker Studio 1.4.9999, in the VM)-> BarkleyV120.gmx
#
# So this decompiles on the host first, then caches the pinned downloads, starts
# the file service the guest pulls from (including the .gm6 it just made),
# brings the Windows VM up and provisions it, and runs the rest inside it.
#
# The export lands on the host as build/virt/BarkleyV120.gmx.zip.
#
# Flags are passed to the guest's run.ps1, so a resumed run can skip what is
# already done:
#
#   virt/run.sh -SkipFetch -SkipCrack
#
# BARKLEY_SKIP_DECOMPILE=1 keeps an existing build/virt/BarkleyV120.gm6.
#
# The VM is left running: bring it down with `virt/vagrant.sh halt`, or throw it
# away with `virt/vagrant.sh destroy -f`.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
BARKLEY_ROOT=${BARKLEY_ROOT:-$(cd -- "$VIRT_DIR/.." && pwd)}
FILES_PORT=${BARKLEY_FILES_PORT:-8899}
export BARKLEY_ROOT BARKLEY_FILES_PORT

for input in "$BARKLEY_ROOT/tools/GameMaker-Studio-(SimonElJoyas).zip" \
             "$BARKLEY_ROOT/game/original/BarkleyV120.exe" \
             "$BARKLEY_ROOT/game/original/GMDecompilerDecompiled/src/main/java"; do
  if [ ! -e "$input" ]; then
    echo "missing input: $input" >&2
    echo "(set BARKLEY_ROOT to the checkout that has tools/ and game/)" >&2
    exit 1
  fi
done

# Step 1, on the host: no VM, no GameMaker, just Java in a container.
if [ -n "${BARKLEY_SKIP_DECOMPILE:-}" ] && [ -s "$BARKLEY_ROOT/build/virt/BarkleyV120.gm6" ]; then
  echo "==> Keeping the existing build/virt/BarkleyV120.gm6"
else
  "$VIRT_DIR/decompile.sh"
fi

echo "==> Caching the pinned downloads"
node "$VIRT_DIR/host/prepare.mjs"

# The guest reaches this at 10.0.2.2. If something is already serving there,
# leave it alone -- it is almost certainly this same service from an earlier
# run, and starting a second one would just fail to bind.
if curl -sf "http://127.0.0.1:$FILES_PORT/ping" > /dev/null 2>&1; then
  echo "==> File service already up on port $FILES_PORT"
  STARTED_SERVER=
else
  echo "==> Starting the file service on port $FILES_PORT"
  mkdir -p "$BARKLEY_ROOT/build/virt"
  node "$VIRT_DIR/host/serve.mjs" --port="$FILES_PORT" --root="$BARKLEY_ROOT" \
    --out="$BARKLEY_ROOT/build/virt" > "$BARKLEY_ROOT/build/virt/serve.log" 2>&1 &
  STARTED_SERVER=$!
  trap 'kill $STARTED_SERVER 2>/dev/null || true' EXIT INT TERM
  sleep 2
fi

echo "==> Bringing the VM up"
"$VIRT_DIR/vagrant.sh" up --provider=qemu

echo "==> Running the GameMaker half in the guest"
"$VIRT_DIR/winrm.sh" "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\barkley\\guest\\run.ps1 $*"

echo
echo "Export: $BARKLEY_ROOT/build/virt/BarkleyV120.gmx.zip"
