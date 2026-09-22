# Stage 1: everything that needs no desktop.
#
# Runs elevated over WinRM, which means it runs as SYSTEM in session 0 -- so it
# never uses $env:APPDATA (that would be SYSTEM's own profile) and never tries
# to drive a window. It lays out C:\barkley, pulls the archives from the host's
# file service, unpacks GameMaker Studio 1.4.9999 where the cracked build
# expects to live, and leaves the machine logged in at a desktop for stage 2.

param(
  [string]$FilesUrl = 'http://10.0.2.2:8899'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The interactive account. Everything the GameMaker IDE touches has to be under
# this profile, because that is the session the GUI stage runs in.
$User = 'vagrant'
$Password = 'vagrant'
$UserHome = "C:\Users\$User"

$Root = 'C:\barkley'
$GmsDir = "$UserHome\AppData\Roaming\GameMaker-Studio"

function Write-Step($message) {
  Write-Host "==> $message"
}

function Wait-ForHost {
  Write-Step "Waiting for the host's file service at $FilesUrl"
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $reply = (New-Object Net.WebClient).DownloadString("$FilesUrl/ping")
      if ($reply.Trim() -eq 'ok') { Write-Host "    reachable"; return }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "The host's file service never answered at $FilesUrl. Start it with: node virt/host/serve.mjs"
}

# WebClient rather than Invoke-WebRequest: these are hundreds of megabytes and
# Invoke-WebRequest buffers the whole body in memory first.
function Get-HostFile($Path, $Destination) {
  if (Test-Path $Destination) {
    Write-Host "    have $(Split-Path -Leaf $Destination)"
    return
  }
  Write-Host "    fetch $Path"
  $tmp = "$Destination.part"
  (New-Object Net.WebClient).DownloadFile("$FilesUrl/files/$Path", $tmp)
  Move-Item -Force $tmp $Destination
}

# Extracts the entries under $Prefix, with that prefix stripped. .NET's
# ExtractToDirectory cannot take a subtree, and this archive's payload sits one
# level down.
function Expand-ZipSubtree($Zip, $Prefix, $Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $count = 0
    foreach ($entry in $archive.Entries) {
      if ($Prefix -and -not $entry.FullName.StartsWith($Prefix, 'OrdinalIgnoreCase')) { continue }
      $relative = $entry.FullName.Substring($Prefix.Length).TrimStart('/')
      if (-not $relative) { continue }
      $target = Join-Path $Destination ($relative -replace '/', '\')
      if ($entry.Name -eq '') {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        continue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $count++
    }
    Write-Host "    $count files -> $Destination"
  } finally {
    $archive.Dispose()
  }
}

# --------------------------------------------------------------------------
Write-Step 'Laying out C:\barkley'
foreach ($dir in 'dl', 'bin', 'work', 'logs', 'out') {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null
}
@{ filesUrl = $FilesUrl; gmsDir = $GmsDir; user = $User } |
  ConvertTo-Json | Set-Content -Encoding UTF8 "$Root\config.json"

Wait-ForHost

# --------------------------------------------------------------------------
Write-Step 'Mirroring the guest scripts'
# virt/guest/ is the working copy: it is mirrored here rather than baked in, so
# a change to a script is one `sync.ps1` away instead of a re-provision.
$manifest = (New-Object Net.WebClient).DownloadString("$FilesUrl/manifest/guest") | ConvertFrom-Json
foreach ($entry in $manifest) {
  $target = Join-Path "$Root\guest" ($entry.path -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  (New-Object Net.WebClient).DownloadFile("$FilesUrl/files/guest/$($entry.path)", $target)
}
Write-Host "    $($manifest.Count) files -> $Root\guest"

# .NET Framework 3.5, which GameMaker Studio 1.4 needs, is not installed here:
# DISM's online servicing refuses to run under PowerShell remoting and answers
# "Access is denied" whatever the account. It is installed by guest/netfx35.ps1
# instead, which the pipeline runs on the desktop like the rest of the GUI work.

# --------------------------------------------------------------------------
Write-Step 'Settling the machine down'
# Nothing may sleep, blank the screen or lock: the GUI stage needs a live,
# unlocked desktop for as long as the export takes.
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off 2>$null

# Never stop at the recovery screen. An interrupted provisioning run, or two
# hard resets in a row, are enough for Windows to decide the last boot failed
# and hand the machine to WinRE -- where there is no WinRM and no way back
# without a person at the keyboard.
& bcdedit /set '{default}' bootstatuspolicy ignoreallfailures | Out-Null
& bcdedit /set '{default}' recoveryenabled No | Out-Null

$desktopKey = 'Registry::HKEY_USERS\.DEFAULT\Control Panel\Desktop'
Set-ItemProperty -Path $desktopKey -Name ScreenSaveActive -Value '0' -ErrorAction SilentlyContinue

# Windows Update and Defender both like to wake up mid-run and eat the CPU the
# IDE needs; this VM is a throwaway with no network but the host's.
foreach ($service in 'wuauserv', 'WaaSMedicSvc', 'UsoSvc') {
  Set-Service -Name $service -StartupType Disabled -ErrorAction SilentlyContinue
  # -NoWait: a Windows Update scan that is already running can take many
  # minutes to acknowledge a stop, and there is nothing to wait for -- the
  # service is disabled either way, and the next boot comes up without it.
  Stop-Service -Name $service -Force -NoWait -ErrorAction SilentlyContinue
}
try {
  Add-MpPreference -ExclusionPath $Root, $GmsDir -ErrorAction SilentlyContinue
  Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
} catch {
  Write-Host '    Defender settings unavailable (fine)'
}

# --------------------------------------------------------------------------
Write-Step 'Enabling autologon'
# Stage 2 drives a real window station, so session 1 has to exist and be
# unlocked before it runs.
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '1'
Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value $User
Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value $Password
Set-ItemProperty -Path $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
Set-ItemProperty -Path $winlogon -Name AutoLogonCount -Value 0xFFFFFFFF -Type DWord -ErrorAction SilentlyContinue
# No lock screen, no first-run prompts in the way of the IDE's windows.
$policies = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
New-Item -Path $policies -Force | Out-Null
Set-ItemProperty -Path $policies -Name NoLockScreen -Value 1 -Type DWord

# UAC off. The video runs the IDE as administrator, and a consent dialog on the
# secure desktop is the one thing no amount of SendKeys can answer: it is a
# separate window station. With EnableLUA at 0 an administrator's processes just
# start elevated. This machine is a throwaway with no network but the host's.
$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-ItemProperty -Path $system -Name EnableLUA -Value 0 -Type DWord
Set-ItemProperty -Path $system -Name ConsentPromptBehaviorAdmin -Value 0 -Type DWord

# --------------------------------------------------------------------------
Write-Step 'Fetching the archives'
# No JDK and no BarkleyV120.exe: the decompile is plain Java and runs on the
# host in a container (virt/decompile.sh), so all this machine ever sees is the
# finished .gm6, which guest/run.ps1 fetches when it needs it.
Get-HostFile 'tools/GameMaker-Studio-(SimonElJoyas).zip' "$Root\dl\gamemaker-studio.zip"
Get-HostFile 'cache/VC_redist.x86.exe' "$Root\dl\VC_redist.x86.exe"

# --------------------------------------------------------------------------
Write-Step 'Installing the Visual C++ runtime'
# 5piceIDE.exe links against VCRUNTIME140; without it the IDE does not start,
# Windows just says the DLL was not found.
if (Test-Path "$env:WINDIR\SysWOW64\vcruntime140.dll") {
  Write-Host '    already installed'
} else {
  $vc = Start-Process -FilePath "$Root\dl\VC_redist.x86.exe" `
    -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  Write-Host "    installer exit $($vc.ExitCode)"
  # 3010 is "succeeded, reboot required"; provisioning reboots anyway.
  if ($vc.ExitCode -ne 0 -and $vc.ExitCode -ne 3010) {
    throw "the Visual C++ runtime installer failed with $($vc.ExitCode)"
  }
}

# --------------------------------------------------------------------------
Write-Step 'Unpacking GameMaker Studio 1.4.9999'
# The cracked build is a drop-in folder, and the patcher looks for it under the
# user's roaming profile -- not in Program Files, where a real installer would
# have put it.
if (Test-Path "$GmsDir\GameMaker-Studio.exe") {
  Write-Host '    already unpacked'
} else {
  New-Item -ItemType Directory -Force -Path $GmsDir | Out-Null
  Expand-ZipSubtree "$Root\dl\gamemaker-studio.zip" 'GameMaker-Studio/' $GmsDir
}

Write-Step 'Unpacking the patcher'
if (-not (Test-Path "$Root\patcher\UGP.exe")) {
  Expand-ZipSubtree "$Root\dl\gamemaker-studio.zip" 'Parche/' "$Root\dl\parche"
  New-Item -ItemType Directory -Force -Path "$Root\patcher" | Out-Null
  Expand-ZipSubtree "$Root\dl\parche\Universal GameMaker Patcher.zip" '' "$Root\patcher"
}

# The whole tree was written by SYSTEM; hand it to the account that will run it.
Write-Step 'Granting the interactive user access'
foreach ($path in $Root, $GmsDir) {
  & icacls $path /grant "${User}:(OI)(CI)F" /T /C /Q | Out-Null
}

Write-Step 'Stage 1 done'
Write-Host "    GameMaker: $GmsDir"
Write-Host "    Patcher:   $Root\patcher"
