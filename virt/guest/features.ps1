# Turns on the Windows features the GameMaker tools need.
#
# Only DirectPlay, and only for the patcher: UGP.exe is itself a GameMaker
# 8.1-era game, and starting one on Windows 10 raises "An app on your PC needs
# the following Windows feature: DirectPlay" -- a modal dialog sitting in front
# of everything, waiting for an answer.
#
# Unlike .NET Framework 3.5, DirectPlay reports "Disabled" rather than
# "DisabledWithPayloadRemoved": the bits are already on disk, so enabling it is
# a local operation that takes a minute and needs no network. (.NET 3.5 is not
# installed at all here -- the IDE proper, 5piceIDE.exe, is native code and does
# not need it. See crack.ps1.)
#
# Runs through Invoke-InSession because DISM's online servicing refuses to run
# under PowerShell remoting, answering a bare "Access is denied" whatever the
# account.

. "$PSScriptRoot\lib.ps1"

foreach ($feature in 'DirectPlay') {
  $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature).State
  if ($state -eq 'Enabled') {
    Write-Step "$feature is already enabled"
    continue
  }
  if ($state -eq 'DisabledWithPayloadRemoved') {
    throw "$feature has no payload on this image; it would have to come from Windows Update"
  }

  Write-Step "Enabling $feature (currently $state)"
  & dism.exe /online /enable-feature /featurename:$feature /all /quiet /norestart
  $code = $LASTEXITCODE
  Write-Host "    dism exit $code"
  # 3010 is "succeeded, reboot required", which is fine here: DirectPlay works
  # without one, and provisioning reboots anyway.
  if ($code -ne 0 -and $code -ne 3010) { throw "dism failed with $code" }

  $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature).State
  Write-Step "$feature is now $state"
  if ($state -ne 'Enabled') { throw "$feature did not enable" }
}
