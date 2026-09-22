#!/bin/sh
# Photograph the guest's screen through the QEMU monitor.
#
#   virt/screenshot.sh [out.png]
#
# This goes around Windows entirely -- no WinRM, no session, no logon needed --
# so it works while the machine is still booting, sitting at a logon screen, or
# wedged behind a modal dialog, which is exactly when you want to look.
#
# WARNING: on QEMU 11.1 with the HVF accelerator this sometimes kills the VM.
# screendump makes QEMU refresh the emulated VGA, and that path
# (vga_update_display -> memory_region_snapshot_and_clear_dirty ->
# do_hv_vm_protect) trips a glib assertion and aborts the process -- roughly one
# call in five here. Nothing is lost but time: `virt/vagrant.sh up` boots the
# machine again from the same disk. So keep this for the moments when there is
# no other way to see the screen, and use the guest's own camera the rest of the
# time:
#
#   virt/winrm.sh --session probe.ps1     # -> build/virt/shots/probe.png
#
# QEMU writes a PPM; ffmpeg converts it if it is there, otherwise the PPM is
# left in place.

set -eu

MONITOR_PORT=${BARKLEY_MONITOR_PORT:-45555}
OUT=${1:-guest.png}
PPM=${TMPDIR:-/tmp}/barkley-screendump-$$.ppm

# `screendump` is a monitor command; the chardev is in readline mode, so the
# reply is human text. Give QEMU a moment to finish writing before reading.
printf 'screendump %s\n' "$PPM" | nc 127.0.0.1 "$MONITOR_PORT" > /dev/null 2>&1 || {
  echo "no answer from the QEMU monitor on port $MONITOR_PORT (is the VM up?)" >&2
  exit 1
}

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$PPM" ] && break
  sleep 0.3
done

if [ ! -s "$PPM" ]; then
  echo "QEMU wrote no screen dump" >&2
  exit 1
fi

case $OUT in
  *.ppm)
    mv "$PPM" "$OUT"
    ;;
  *)
    if command -v ffmpeg > /dev/null 2>&1; then
      ffmpeg -v error -y -i "$PPM" "$OUT"
      rm -f "$PPM"
    else
      OUT=${OUT%.*}.ppm
      mv "$PPM" "$OUT"
    fi
    ;;
esac

echo "$OUT"
