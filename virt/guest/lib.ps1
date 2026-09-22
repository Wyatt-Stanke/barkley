# Shared guest-side helpers. Dot-source it:  . C:\barkley\guest\lib.ps1
#
# The central problem this file solves: WinRM runs everything as SYSTEM in
# session 0, where there is no desktop, so a window opened there is invisible to
# the GameMaker IDE's own dialogs and to any input we send. Anything that has to
# see a window goes through Invoke-InSession, which hands the work to the
# autologon desktop as a scheduled task and waits for it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Root = 'C:\barkley'
$script:Config = Get-Content "$script:Root\config.json" -Raw | ConvertFrom-Json

function Get-BarkleyRoot { $script:Root }
function Get-BarkleyConfig { $script:Config }

function Write-Step($message) {
  Write-Host ("==> {0}" -f $message)
}

function Get-HostFile($Path, $Destination) {
  $tmp = "$Destination.part"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  (New-Object Net.WebClient).DownloadFile("$($script:Config.filesUrl)/files/$Path", $tmp)
  Move-Item -Force $tmp $Destination
}

# Hands a file back to the host, which writes it under build/virt/.
function Send-HostFile($Path, $Name) {
  $client = New-Object Net.WebClient
  $reply = $client.UploadFile("$($script:Config.filesUrl)/upload/$Name", 'PUT', $Path)
  [Text.Encoding]::UTF8.GetString($reply).Trim()
}

# --------------------------------------------------------------------------
# Running work on the interactive desktop.

# Runs a script in the logged-on session and waits for it. The scheduled task's
# principal is the interactive user, which is what puts it on their window
# station; SYSTEM's own session has no desktop for the IDE to draw on.
function Invoke-InSession {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$Arguments = @(),
    [string]$Name = 'barkley-gui',
    [int]$TimeoutSeconds = 3600
  )

  $logDir = "$script:Root\logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = "$logDir\$Name.log"
  $done = "$logDir\$Name.exit"
  $wrapper = "$logDir\$Name.wrapper.ps1"
  Remove-Item $log, $done -Force -ErrorAction SilentlyContinue

  $argLiteral = '@(' + (($Arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ',') + ')'

  # The wrapper owns the transcript and the exit-code file, so a crash inside
  # the payload still ends the wait instead of running out the clock. Note the
  # arguments go into a variable first: splatting takes a variable name, and
  # `@@(...)` is a parse error -- which PowerShell reports by exiting 1 before
  # the transcript starts, leaving nothing at all to look at.
  @"
`$ErrorActionPreference = 'Stop'
Start-Transcript -Path '$log' -Force | Out-Null
`$scriptArgs = $argLiteral
`$code = 0
try {
  & '$ScriptPath' @scriptArgs
} catch {
  Write-Host "FAILED: `$(`$_.Exception.Message)"
  Write-Host (`$_.ScriptStackTrace)
  `$code = 1
}
Stop-Transcript | Out-Null
Set-Content -Path '$done' -Value `$code -Encoding ASCII
"@ | Set-Content -Path $wrapper -Encoding UTF8

  $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
  # schtasks writes notes to stderr even when it succeeds -- a one-off task
  # whose start time has already passed always gets one -- and over WinRM, with
  # $ErrorActionPreference at Stop, anything a native command puts on stderr is
  # a terminating error. So drop the preference across these two calls and judge
  # them by their exit codes, which is what they actually mean.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & schtasks /create /f /tn $Name /tr $command /sc once /st 00:00 /sd 01/01/2020 `
      /ru $script:Config.user /rp 'vagrant' /it /rl highest 2>&1 | Out-String | Write-Verbose
    $createCode = $LASTEXITCODE
    & schtasks /run /tn $Name 2>&1 | Out-String | Write-Verbose
    $runCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($createCode -ne 0) { throw "schtasks /create failed with $createCode" }
  if ($runCode -ne 0) { throw "schtasks /run failed with $runCode" }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $done)) {
    if ((Get-Date) -gt $deadline) {
      & schtasks /end /tn $Name 2>&1 | Out-String | Write-Verbose
      if (Test-Path $log) { Get-Content $log | Write-Host }
      throw "$Name did not finish within $TimeoutSeconds seconds"
    }
    Start-Sleep -Seconds 2
  }

  $code = [int](Get-Content $done -Raw).Trim()
  if (Test-Path $log) { Get-Content $log | Write-Host }
  & schtasks /delete /f /tn $Name 2>&1 | Out-String | Write-Verbose
  if ($code -ne 0) { throw "$Name failed (exit $code)" }
}

# --------------------------------------------------------------------------
# Window and input handling, for use *inside* a session.

function Add-WindowTypes {
  if ('Barkley.Win' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

namespace Barkley {
  public class WindowInfo {
    public IntPtr Handle;
    public string Title;
    public string Class;
    public int ProcessId;
  }

  public class Win {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

    // Every visible top-level window with a title. Get-Process only reports a
    // process's *main* window, which is no use here: a file dialog or a message
    // box is a separate top-level window, and those are exactly the windows
    // that have to be answered.
    public static List<WindowInfo> TopLevel() {
      List<WindowInfo> found = new List<WindowInfo>();
      EnumWindows(delegate (IntPtr hWnd, IntPtr param) {
        if (!IsWindowVisible(hWnd)) return true;
        StringBuilder title = new StringBuilder(512);
        GetWindowTextW(hWnd, title, title.Capacity);
        if (title.Length == 0) return true;
        StringBuilder cls = new StringBuilder(256);
        GetClassNameW(hWnd, cls, cls.Capacity);
        int pid;
        GetWindowThreadProcessId(hWnd, out pid);
        WindowInfo info = new WindowInfo();
        info.Handle = hWnd;
        info.Title = title.ToString();
        info.Class = cls.ToString();
        info.ProcessId = pid;
        found.Add(info);
        return true;
      }, IntPtr.Zero);
      return found;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    public static void Click(int x, int y) {
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(80);
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(60);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
  }
}
'@
}

# Every visible top-level window with a title: handle, title, class, process.
function Get-DesktopWindows {
  Add-WindowTypes
  [Barkley.Win]::TopLevel() | ForEach-Object {
    $process = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue)
    [pscustomobject]@{
      Handle  = $_.Handle
      Title   = $_.Title
      Class   = $_.Class
      Process = if ($process) { $process.ProcessName } else { "pid$($_.ProcessId)" }
      Id      = $_.ProcessId
    }
  }
}

# Waits for a window whose title matches, and returns it.
function Wait-ForWindow {
  param(
    [Parameter(Mandatory = $true)][string]$TitlePattern,
    [int]$TimeoutSeconds = 120,
    [string]$ProcessName
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $match = Get-DesktopWindows |
      Where-Object { $_.Title -match $TitlePattern -and (-not $ProcessName -or $_.Process -eq $ProcessName) } |
      Select-Object -First 1
    if ($match) { return $match }
    Start-Sleep -Milliseconds 500
  }
  throw "No window titled like '$TitlePattern' appeared within $TimeoutSeconds seconds"
}

function Set-WindowFocus($Window) {
  Add-WindowTypes
  [Barkley.Win]::ShowWindow($Window.Handle, 9) | Out-Null   # SW_RESTORE
  [Barkley.Win]::SetForegroundWindow($Window.Handle) | Out-Null
  Start-Sleep -Milliseconds 400
}

function Send-Keys([string]$Keys, [int]$DelayMs = 250) {
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $DelayMs
}

# Types a literal string (SendKeys treats +^%~(){}[] as syntax).
function Send-Text([string]$Text, [int]$DelayMs = 250) {
  $escaped = $Text -replace '([+^%~(){}\[\]])', '{$1}'
  Send-Keys $escaped $DelayMs
}

function Get-WindowRect($Window) {
  Add-WindowTypes
  $rect = New-Object Barkley.Win+RECT
  [Barkley.Win]::GetWindowRect($Window.Handle, [ref]$rect) | Out-Null
  [pscustomobject]@{
    X = $rect.Left; Y = $rect.Top
    Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top
  }
}

function Invoke-Click([int]$X, [int]$Y) {
  Add-WindowTypes
  [Barkley.Win]::Click($X, $Y)
  Start-Sleep -Milliseconds 300
}
