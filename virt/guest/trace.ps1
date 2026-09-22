# What the IDE itself says it is doing.
#
#   virt/winrm.sh 'powershell -NoProfile -File C:\barkley\guest\trace.ps1'
#
# 5piceIDE.exe writes TraceIDE.log beside its own profile on every run, and it
# is the only place that explains a silent exit. The line that cost the most
# time to find was
#
#   Close button clicked on Welcome Screen - shutting down
#
# which is what the IDE does when the CEF welcome screen gives up: it takes the
# process with it, leaving no window and no error.

param(
  [int]$Lines = 60
)

. "$PSScriptRoot\lib.ps1"

$config = Get-BarkleyConfig
$candidates = @(
  "$($config.gmsDir)\TraceIDE.log",
  "$env:LOCALAPPDATA\GameMaker-Studio\TraceIDE.log",
  "$env:APPDATA\GameMaker-Studio\TraceIDE.log"
)

$found = $false
foreach ($path in $candidates) {
  if (-not (Test-Path $path)) { continue }
  $found = $true
  $item = Get-Item $path
  Write-Step "$path  ($($item.Length) bytes, written $($item.LastWriteTime))"
  Get-Content $path -Tail $Lines | ForEach-Object { Write-Host "    $_" }
}

if (-not $found) { Write-Step 'no TraceIDE.log anywhere -- the IDE has not run yet' }
