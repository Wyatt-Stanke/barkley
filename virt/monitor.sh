#!/bin/sh
# Send a command to the QEMU monitor and print the reply.
#
#   virt/monitor.sh info status
#   virt/monitor.sh system_reset
#   virt/monitor.sh sendkey ret
#   virt/monitor.sh 'sendkey ctrl-alt-delete'
#
# This reaches the machine below Windows: it works at the firmware screen, at a
# logon prompt, and when the recovery environment has taken over and there is no
# WinRM to talk to.

set -eu

MONITOR_PORT=${BARKLEY_MONITOR_PORT:-45555}

[ $# -ge 1 ] || { echo "usage: $0 <monitor command>" >&2; exit 2; }

printf '%s\n' "$*" | nc -w 2 127.0.0.1 "$MONITOR_PORT" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g'
