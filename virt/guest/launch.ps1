# Start a program on the desktop, wait, and report what appeared.
#
#   virt/winrm.sh --session launch.ps1 'C:\Users\vagrant\AppData\Roaming\GameMaker-Studio\GameMaker-Studio.exe' 40 ide
#
# For working out what a GUI step is actually facing: the windows it opened and
# a screenshot, which lands on the host as build/virt/shots/<name>.png.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$WaitSeconds = 30,
  [string]$Name = 'launch',
  [string]$ArgumentString = ''
)

. "$PSScriptRoot\lib.ps1"
. "$PSScriptRoot\screen.ps1"

Write-Step "Starting $Path"
$start = @{ FilePath = $Path; WorkingDirectory = (Split-Path -Parent $Path) }
if ($ArgumentString) { $start.ArgumentList = $ArgumentString }
$process = Start-Process @start -PassThru
Write-Host "    pid $($process.Id)"

Start-Sleep -Seconds $WaitSeconds

Write-Host 'windows:'
Get-DesktopWindows | ForEach-Object {
  $rect = Get-WindowRect $_
  Write-Host ("    [{0}] {1}  ({2},{3} {4}x{5}) class={6}" -f `
      $_.Process, $_.Title, $rect.X, $rect.Y, $rect.Width, $rect.Height, $_.Class)
}

Save-Screenshot -Name $Name -Upload | Out-Null
Write-Host "screenshot -> build/virt/shots/$Name.png"
