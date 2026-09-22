#!/bin/sh
# Run a command in the guest over WinRM, or a guest script on its desktop.
#
#   virt/winrm.sh 'Get-Date'                       PowerShell, session 0 (no desktop)
#   virt/winrm.sh --session crack.ps1 [args...]    a guest script on the logged-on desktop
#   virt/winrm.sh --sync                           re-mirror virt/guest/ into the VM
#
# --session is the one that matters: WinRM logs in as SYSTEM with no window
# station, so anything that opens a window has to be handed to the autologon
# session instead. See Invoke-InSession in virt/guest/lib.ps1.

set -eu

VIRT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

case ${1:-} in
  --session)
    shift
    [ $# -ge 1 ] || { echo "usage: $0 --session <script.ps1> [args...]" >&2; exit 2; }
    script=$1
    shift
    args=''
    for a in "$@"; do
      args="$args,'$a'"
    done
    args=${args#,}
    [ -n "$args" ] || args='@()'
    [ "$args" = '@()' ] || args="@($args)"
    name=$(basename "$script" .ps1)
    command=". C:\\barkley\\guest\\lib.ps1; Invoke-InSession -ScriptPath 'C:\\barkley\\guest\\$script' -Arguments $args -Name 'barkley-$name'"
    ;;
  --sync)
    command=". C:\\barkley\\guest\\lib.ps1; & C:\\barkley\\guest\\sync.ps1"
    ;;
  '')
    echo "usage: $0 <powershell> | --session <script.ps1> [args...] | --sync" >&2
    exit 2
    ;;
  *)
    command=$1
    ;;
esac

exec "$VIRT_DIR/vagrant.sh" winrm -c "$command"
