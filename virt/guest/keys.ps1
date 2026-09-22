# Focus a window, send it keystrokes, and photograph the result.
#
#   virt/winrm.sh --session keys.ps1 'GameMaker' '%f' menu
#
# The keystrokes are SendKeys syntax: % is Alt, ^ is Ctrl, + is Shift, and
# {ENTER} {ESC} {DOWN} {TAB} are themselves. Mostly for working out a menu path
# a step later has to walk on its own.

param(
  [Parameter(Mandatory = $true)][string]$TitlePattern,
  [Parameter(Mandatory = $true)][string]$Keys,
  [string]$Name = 'keys',
  [int]$SettleMs = 1500
)

. "$PSScriptRoot\lib.ps1"
. "$PSScriptRoot\screen.ps1"

$window = Wait-ForWindow -TitlePattern $TitlePattern -TimeoutSeconds 30
Write-Host "focusing: [$($window.Process)] $($window.Title)"
Set-WindowFocus $window

Write-Host "sending: $Keys"
Send-Keys $Keys $SettleMs

Save-Screenshot -Name $Name -Upload | Out-Null
Write-Host "screenshot -> build/virt/shots/$Name.png"
