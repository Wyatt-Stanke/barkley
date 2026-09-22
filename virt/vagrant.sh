#!/bin/sh
# Vagrant, with the environment this VM needs.
#
#   virt/vagrant.sh up          virt/vagrant.sh ssh-config
#   virt/vagrant.sh halt        virt/vagrant.sh destroy -f
#
# Two things have to be set up before vagrant runs:
#
#   * qemu-img has to be on PATH. vagrant-qemu calls the binary named in
#     `qemu_bin` for the VM itself, but shells out to a bare `qemu-img` to make
#     the machine's overlay image, and Vagrant's own PATH does not include
#     MacPorts.
#   * BARKLEY_ROOT has to point at the checkout holding `tools/` and
#     `game/original/`, which are untracked -- so in a git worktree they are
#     only in the main checkout.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

for prefix in /opt/local /usr/local /opt/homebrew; do
  if [ -x "$prefix/bin/qemu-system-x86_64" ]; then
    QEMU_PREFIX=$prefix
    break
  fi
done

if [ -z "${QEMU_PREFIX:-}" ]; then
  echo "qemu-system-x86_64 not found. sudo port install qemu" >&2
  exit 1
fi

PATH="$QEMU_PREFIX/bin:$PATH"
export PATH QEMU_PREFIX

# Where tools/ and game/original/ live. The default is the directory holding
# virt/, which is right for a normal checkout.
BARKLEY_ROOT=${BARKLEY_ROOT:-$(cd -- "$VIRT_DIR/.." && pwd)}
export BARKLEY_ROOT

cd -- "$VIRT_DIR"
exec vagrant "$@"
