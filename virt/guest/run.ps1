# The GameMaker half of the pipeline: .gm6 -> .gmx -> back to the host.
#
#   virt/winrm.sh 'powershell -File C:\barkley\guest\run.ps1'
#
# The .gm6 itself is made on the host by virt/decompile.sh, in a container --
# it is plain Java and has no business being in here. This fetches the finished
# file and gets on with the part that genuinely needs Windows.
#
# Runs over WinRM in session 0 and hands the steps that need a desktop to the
# logged-on session itself (see Invoke-InSession in lib.ps1). Each step is
# skippable and each is idempotent, so a failed run can be resumed rather than
# started over -- the GameMaker half is slow.

param(
  # What the host's .gm6 should hash to, as a check that the input has not
  # changed under us. Empty skips the check.
  [string]$ExpectedGm6 = '4b76af44edbf8c6bd980a7693e78520646059ec6edbacf4051b336dfb30f9b32',
  [switch]$SkipFetch,
  [switch]$SkipCrack,
  [switch]$SkipExport
)

. "$PSScriptRoot\lib.ps1"

$root = Get-BarkleyRoot
$started = Get-Date

if (-not $SkipFetch) {
  Write-Step 'STEP 1  fetching the .gm6 the host made'
  $gm6 = "$root\work\BarkleyV120.gm6"
  New-Item -ItemType Directory -Force -Path "$root\work" | Out-Null
  Get-HostFile 'build/BarkleyV120.gm6' $gm6

  $hash = (Get-FileHash $gm6 -Algorithm SHA256).Hash.ToLower()
  Write-Host "    BarkleyV120.gm6  $((Get-Item $gm6).Length) bytes  sha256 $hash"
  if ($ExpectedGm6 -and $hash -ne $ExpectedGm6.ToLower()) {
    throw "the .gm6 does not match the expected hash`n  got      $hash`n  expected $ExpectedGm6"
  }
}

if (-not $SkipCrack) {
  Write-Step 'STEP 2  GameMaker Studio 1.4.9999'
  # DirectPlay first: the patcher is a GameMaker 8.1 game and Windows stops it
  # with a modal "needs the following Windows feature" dialog without it.
  Invoke-InSession -ScriptPath "$PSScriptRoot\features.ps1" -Name 'barkley-features' -TimeoutSeconds 1800
  # Then black out the desktop, because the patcher's buttons are found by
  # colour and the default wallpaper is full of the cyan they are looking for.
  Invoke-InSession -ScriptPath "$PSScriptRoot\desktop.ps1" -Name 'barkley-desktop' -TimeoutSeconds 600
  Invoke-InSession -ScriptPath "$PSScriptRoot\crack.ps1" -Name 'barkley-crack' -TimeoutSeconds 1800
}

if (-not $SkipExport) {
  Write-Step 'STEP 3  the .gm6 -> .gmx'
  Invoke-InSession -ScriptPath "$PSScriptRoot\export.ps1" -Name 'barkley-export' -TimeoutSeconds 5400
}

Write-Step 'Handing the export back to the host'
$zip = "$root\out\BarkleyV120.gmx.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$project = "$root\out\BarkleyV120.gmx"
if (-not (Test-Path $project)) { throw "no export at $project" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($project, $zip)
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Write-Host "    $([IO.Path]::GetFileName($zip))  $((Get-Item $zip).Length) bytes  sha256 $hash"

Send-HostFile $zip 'BarkleyV120.gmx.zip' | Out-Null

$minutes = [int]((Get-Date) - $started).TotalMinutes
Write-Step "Done in $minutes minutes: build/virt/BarkleyV120.gmx.zip"
