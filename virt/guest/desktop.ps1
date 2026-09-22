# Make the desktop a flat black rectangle.
#
# The patcher has no controls anything can address by name -- it is a fullscreen
# GameMaker game -- so its buttons are found by colour (see screen.ps1). The
# Windows 10 default wallpaper is a photograph of a blue-cyan light bloom, and
# it matched the product tiles' cyan well enough to hand back three "tiles" at
# 606,704 / 596,308 / 423,102, none of which were in the patcher at all.
#
# So: no wallpaper, black behind it, and no accent colouring on top. Anything
# left on screen after this belongs to a program.
#
# Has to run in the logged-on session -- these are that user's own settings, and
# SystemParametersInfo only speaks to the desktop it is called from.

. "$PSScriptRoot\lib.ps1"

Add-Type -Namespace Barkley -Name Desk -MemberDefinition @'
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool SystemParametersInfo(uint action, uint param, string value, uint notify);
'@

$desktop = 'HKCU:\Control Panel\Desktop'
Set-ItemProperty -Path $desktop -Name Wallpaper -Value ''
Set-ItemProperty -Path $desktop -Name WallpaperStyle -Value '0'
Set-ItemProperty -Path $desktop -Name TileWallpaper -Value '0'
Set-ItemProperty -Path 'HKCU:\Control Panel\Colors' -Name Background -Value '0 0 0'

# SPI_SETDESKWALLPAPER = 0x0014, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 3.
# An empty path is what clears it.
[Barkley.Desk]::SystemParametersInfo(0x0014, 0, '', 3) | Out-Null

# The colour only reaches the screen when the desktop repaints, and nothing
# makes it do that on its own.
Start-Sleep -Seconds 2
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8

Write-Step 'Desktop is black'
