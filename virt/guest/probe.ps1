# What is on the desktop right now: every top-level window, and a screenshot
# handed back to the host as build/virt/shots/probe.png.
#
#   virt/winrm.sh --session probe.ps1
#
# Run it whenever a GUI step does not do what it should -- it is the only way to
# see what the session sees.

param(
  [string]$Name = 'probe'
)

. "$PSScriptRoot\lib.ps1"
. "$PSScriptRoot\screen.ps1"

Write-Host "session: $env:USERNAME on $env:COMPUTERNAME"
Write-Host "windows:"
Get-DesktopWindows | ForEach-Object {
  $rect = Get-WindowRect $_
  Write-Host ("    [{0}] {1}  ({2},{3} {4}x{5}) class={6}" -f `
      $_.Process, $_.Title, $rect.X, $rect.Y, $rect.Width, $rect.Height, $_.Class)
}

$shot = Save-Screenshot -Name $Name -Upload
Write-Host "screenshot: $shot -> build/virt/shots/$Name.png"
