# Step 3: BarkleyV120.gm6 -> BarkleyV120.gmx
#
# GameMaker Studio 1.4 has no command line for this. The only way in is
# File > Import Project..., which opens the legacy-format file dialog
# (*.gm6;*.gmk;*.gm81), asks where the converted project should go, and writes a
# .gmx project directory there.
#
# So this drives the IDE's own windows, on the desktop, and photographs each
# step into build/virt/shots/ so a run that goes wrong can be seen afterwards.

param(
  [string]$Source = 'C:\barkley\work\BarkleyV120.gm6',
  [string]$Target = 'C:\barkley\out\BarkleyV120',
  [switch]$Force
)

. "$PSScriptRoot\lib.ps1"
. "$PSScriptRoot\screen.ps1"

$config = Get-BarkleyConfig
$gms = $config.gmsDir
# The IDE itself, not the .NET launcher in front of it -- see crack.ps1.
$ide = "$gms\5piceIDE.exe"

$projectDir = "$Target.gmx"
$projectFile = Join-Path $projectDir ((Split-Path -Leaf $Target) + '.project.gmx')

if (-not (Test-Path $Source)) { throw "no .gm6 to import: $Source" }

if ((Test-Path $projectFile) -and -not $Force) {
  Write-Step "Already exported ($projectFile); pass -Force to do it again"
  return
}
Remove-Item $projectDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null

function Stop-IDE {
  Get-Process -Name 'GameMaker-Studio', '5piceIDE' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 5
  Get-Process -Name 'GameMaker-Studio', '5piceIDE' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
}

# --------------------------------------------------------------------------
Write-Step 'Starting the IDE'
Stop-IDE
Start-Process -FilePath $ide -WorkingDirectory $gms | Out-Null

$main = Wait-ForWindow -TitlePattern 'GameMaker' -TimeoutSeconds 300 -ProcessName '5piceIDE'
Write-Host "    $($main.Title)"
# The welcome screen is an embedded browser that takes a while to settle, and
# the menu does not answer until it has.
Start-Sleep -Seconds 30
Save-Screenshot -Name 'export-01-ide' -Upload | Out-Null

# --------------------------------------------------------------------------
Write-Step 'File > Import Project'
Set-WindowFocus $main
Send-Keys '%f' 1500
Save-Screenshot -Name 'export-02-file-menu' -Upload | Out-Null
Send-Keys 'i' 3000
Save-Screenshot -Name 'export-03-import-dialog' -Upload | Out-Null

Write-Step "Choosing $Source"
$open = Wait-ForWindow -TitlePattern 'Import|Open' -TimeoutSeconds 60
Set-WindowFocus $open
Send-Text $Source 800
Send-Keys '{ENTER}' 5000
Save-Screenshot -Name 'export-04-after-open' -Upload | Out-Null

Write-Step "Saving to $projectDir"
$save = Wait-ForWindow -TitlePattern 'Save|Import' -TimeoutSeconds 120
Set-WindowFocus $save
Send-Text $Target 800
Send-Keys '{ENTER}' 5000
Save-Screenshot -Name 'export-05-after-save' -Upload | Out-Null

# --------------------------------------------------------------------------
Write-Step 'Waiting for the import'
# It reads a 10 MB GM6 and writes a few thousand files; on this machine that is
# minutes, not seconds. Watch the project file rather than guessing.
$deadline = (Get-Date).AddMinutes(45)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $projectFile) { break }
  Start-Sleep -Seconds 10
}
Save-Screenshot -Name 'export-06-imported' -Upload | Out-Null
Get-DesktopWindows | ForEach-Object { Write-Host "    window: [$($_.Process)] $($_.Title)" }

if (-not (Test-Path $projectFile)) {
  throw "the import produced no project at $projectFile (see build/virt/shots/export-*.png)"
}

# The IDE writes the project as it goes; give it a moment to finish and settle
# before anything closes it.
Start-Sleep -Seconds 30

Write-Step 'Closing the IDE'
Stop-IDE

$files = (Get-ChildItem $projectDir -Recurse -File).Count
$bytes = (Get-ChildItem $projectDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Step "Exported $projectDir  ($files files, $([int]($bytes / 1MB)) MB)"
