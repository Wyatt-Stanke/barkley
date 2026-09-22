# Step 2: make GameMaker Studio 1.4.9999 usable.
#
# Follows the video in tools/how-to-install-gms-1.4.9999.mkv: run the IDE once
# so it writes its profile and asks which update channel to use, then run the
# Universal GameMaker Patcher, pick Studio 1.x and press Go. The patcher puts a
# cracked libeay32.dll in place -- that is what stops the licence signature
# check -- and writes licence.plist next to the IDE.
#
# Has to run on the desktop: every window here is a real window.
#
# The patcher is itself a fullscreen GameMaker game, so there is nothing to find
# by control name and nothing sits at a fixed coordinate. Its buttons are found
# by colour instead: the product tiles have cyan borders and the Go button is a
# big slab of green. See screen.ps1.

param(
  [switch]$Force,
  # The tiles' cyan border and the Go button's green, as measured on screen.
  [int[]]$TileColor = @(0, 180, 200),
  [int[]]$GoColor = @(34, 177, 76),
  [int]$Tolerance = 45
)

. "$PSScriptRoot\lib.ps1"
. "$PSScriptRoot\screen.ps1"

$root = Get-BarkleyRoot
$config = Get-BarkleyConfig
$gms = $config.gmsDir
# 5piceIDE.exe, not GameMaker-Studio.exe: the latter is only the Sparkle
# auto-updater (its .exe.config names `ExeName` 5piceIDE.exe and a supported
# runtime of v2.0.50727), and being a .NET 2.0 binary it will not start until
# .NET Framework 3.5 is installed -- which on Windows 10 means a DISM run
# against Windows Update that took over an hour here and never finished. The
# IDE itself is native Delphi and needs none of it.
$ide = "$gms\5piceIDE.exe"

# The patcher writes the licence beside the IDE. GameMaker spells it the
# British way; check both, since which one lands is the patcher's business.
$licences = @("$gms\licence.plist", "$gms\license.plist")

function Get-Licence {
  $licences | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not (Test-Path $ide)) { throw "the IDE is not unpacked: $ide" }

$have = Get-Licence
if ($have -and -not $Force) {
  Write-Step "Already licensed ($have); pass -Force to patch again"
  return
}

function Stop-IDE {
  Get-Process -Name 'GameMaker-Studio', '5piceIDE' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 5
  Get-Process -Name 'GameMaker-Studio', '5piceIDE' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

# --------------------------------------------------------------------------
Write-Step 'First run of the IDE'
Stop-IDE
Start-Process -FilePath $ide -WorkingDirectory $gms | Out-Null

# The video's "Choose Update Channel" prompt belongs to the launcher, so it
# does not appear here. Anything else that does -- a licence complaint, most
# likely, since this run is before the patch -- is caught in the screenshot
# below and simply closed with the IDE.

Start-Sleep -Seconds 45
Save-Screenshot -Name 'crack-01-ide-first-run' -Upload | Out-Null
Get-DesktopWindows | ForEach-Object { Write-Host "    window: [$($_.Process)] $($_.Title)" }

Write-Step 'Closing the IDE'
Stop-IDE

# --------------------------------------------------------------------------
Write-Step 'Running the Universal GameMaker Patcher'
$patcher = "$root\patcher\UGP.exe"
if (-not (Test-Path $patcher)) { throw "the patcher is not unpacked: $patcher" }

Get-Process -Name 'UGP' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $patcher -WorkingDirectory "$root\patcher" | Out-Null
Start-Sleep -Seconds 12
Save-Screenshot -Name 'crack-02-patcher-open' -Upload | Out-Null

# Three tiles, cyan-bordered; the rightmost is Studio 1.x.
$tiles = Wait-ForColorBlob -R $TileColor[0] -G $TileColor[1] -B $TileColor[2] `
  -Tolerance $Tolerance -MinWidth 60 -MinHeight 60 -TimeoutSeconds 90 -What 'the product tiles'
Write-Host "    $($tiles.Count) tiles: $(($tiles | ForEach-Object { "$($_.CenterX),$($_.CenterY)" }) -join '  ')"
$studio = $tiles | Sort-Object CenterX | Select-Object -Last 1
Write-Host "    Studio 1.x at $($studio.CenterX),$($studio.CenterY)"
Invoke-Click $studio.CenterX $studio.CenterY
Start-Sleep -Seconds 4
Save-Screenshot -Name 'crack-03-studio-page' -Upload | Out-Null

Write-Step 'Pressing Go'
$greens = Wait-ForColorBlob -R $GoColor[0] -G $GoColor[1] -B $GoColor[2] `
  -Tolerance $Tolerance -MinWidth 120 -MinHeight 30 -TimeoutSeconds 60 -What 'the Go button'
$go = $greens | Select-Object -First 1
Write-Host "    Go at $($go.CenterX),$($go.CenterY)"
Invoke-Click $go.CenterX $go.CenterY

Write-Step 'Waiting for the licence'
for ($i = 0; $i -lt 150; $i++) {
  if (Get-Licence) { break }
  Start-Sleep -Seconds 2
}
Save-Screenshot -Name 'crack-04-after-go' -Upload | Out-Null

Get-Process -Name 'UGP' -ErrorAction SilentlyContinue | Stop-Process -Force

$have = Get-Licence
if (-not $have) { throw "the patcher wrote no licence in $gms" }
Write-Step "Licensed: $have ($((Get-Item $have).Length) bytes)"
