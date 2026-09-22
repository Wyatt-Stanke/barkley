# Re-mirrors virt/guest/ from the host into C:\barkley\guest.
#
# The same thing stage 1 does, kept here so a script can be changed on the host
# and pushed with `virt/winrm.sh --sync` instead of a full re-provision.
#
# It is a mirror, not a copy: anything in C:\barkley\guest that the host no
# longer has is deleted. Otherwise a script that moved or was retired stays
# behind in the VM, and the next run picks up the old one.

. "$PSScriptRoot\lib.ps1"

$root = Get-BarkleyRoot
$config = Get-BarkleyConfig
$dest = "$root\guest"

$manifest = (New-Object Net.WebClient).DownloadString("$($config.filesUrl)/manifest/guest") | ConvertFrom-Json

$wanted = @{}
foreach ($entry in $manifest) {
  $relative = $entry.path -replace '/', '\'
  $wanted[$relative] = $true
  $target = Join-Path $dest $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  (New-Object Net.WebClient).DownloadFile("$($config.filesUrl)/files/guest/$($entry.path)", $target)
}

# This script is running from the directory it is pruning, so leave it be even
# if the manifest somehow lost it -- deleting it mid-run would be its own bug.
$self = Split-Path -Leaf $PSCommandPath
$stale = Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
  $relative = $_.FullName.Substring($dest.Length + 1)
  -not $wanted.ContainsKey($relative) -and $_.Name -ne $self
}
foreach ($file in $stale) {
  Write-Host "    stale: $($file.FullName.Substring($dest.Length + 1))"
  Remove-Item $file.FullName -Force -ErrorAction SilentlyContinue
}
# Directories the pruning emptied (guest\java, once the decompile moved out).
Get-ChildItem $dest -Recurse -Directory -ErrorAction SilentlyContinue |
  Sort-Object { $_.FullName.Length } -Descending |
  Where-Object { -not (Get-ChildItem $_.FullName -Force -ErrorAction SilentlyContinue) } |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

Write-Host "$($manifest.Count) files -> $dest ($($stale.Count) stale removed)"
