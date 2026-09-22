# Looking at the screen, from inside the session.
#
# The patcher is a fullscreen GameMaker game: no controls to find by name, no
# accessible tree, and a layout that stretches with the screen. What it does
# have is a small palette of very loud colours -- cyan-bordered product tiles, a
# green Go button, green checkboxes -- so its buttons are found by colour and
# clicked at the centre of the blob, which survives any resolution.
#
# The scanning is C#: at 1440x900 a PowerShell GetPixel loop takes minutes.

. "$PSScriptRoot\lib.ps1"

function Add-ScreenTypes {
  if ('Barkley.Screen' -as [type]) { return }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Barkley {
  public class Blob {
    public int X, Y, Width, Height, Count;
    public int CenterX { get { return X + Width / 2; } }
    public int CenterY { get { return Y + Height / 2; } }
  }

  public class Screen {
    public static Bitmap Capture() {
      Rectangle bounds = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
      Bitmap shot = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(shot)) {
        g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
      }
      return shot;
    }

    // Connected runs of pixels within `tolerance` of (r,g,b), as bounding
    // boxes, largest first. Four-way flood fill over a mask.
    public static List<Blob> FindBlobs(Bitmap bmp, int r, int g, int b, int tolerance, int minWidth, int minHeight) {
      int w = bmp.Width, h = bmp.Height;
      BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      bool[] mask = new bool[w * h];
      try {
        unsafe_copy(data, mask, w, h, r, g, b, tolerance);
      } finally {
        bmp.UnlockBits(data);
      }

      List<Blob> blobs = new List<Blob>();
      int[] stack = new int[w * h];
      for (int start = 0; start < mask.Length; start++) {
        if (!mask[start]) continue;
        int top = 0;
        stack[top++] = start;
        mask[start] = false;
        int minX = w, maxX = -1, minY = h, maxY = -1, count = 0;
        while (top > 0) {
          int p = stack[--top];
          int px = p % w, py = p / w;
          count++;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          if (px > 0 && mask[p - 1]) { mask[p - 1] = false; stack[top++] = p - 1; }
          if (px < w - 1 && mask[p + 1]) { mask[p + 1] = false; stack[top++] = p + 1; }
          if (py > 0 && mask[p - w]) { mask[p - w] = false; stack[top++] = p - w; }
          if (py < h - 1 && mask[p + w]) { mask[p + w] = false; stack[top++] = p + w; }
        }
        int bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw < minWidth || bh < minHeight) continue;
        Blob blob = new Blob();
        blob.X = minX; blob.Y = minY; blob.Width = bw; blob.Height = bh; blob.Count = count;
        blobs.Add(blob);
      }
      blobs.Sort(delegate (Blob a, Blob c) { return c.Count.CompareTo(a.Count); });
      return blobs;
    }

    private static void unsafe_copy(BitmapData data, bool[] mask, int w, int h, int r, int g, int b, int tol) {
      int stride = data.Stride;
      byte[] row = new byte[stride];
      IntPtr scan = data.Scan0;
      for (int y = 0; y < h; y++) {
        Marshal.Copy(new IntPtr(scan.ToInt64() + (long)y * stride), row, 0, stride);
        for (int x = 0; x < w; x++) {
          int i = x * 4;
          int bb = row[i], gg = row[i + 1], rr = row[i + 2];
          if (Math.Abs(rr - r) <= tol && Math.Abs(gg - g) <= tol && Math.Abs(bb - b) <= tol) {
            mask[y * w + x] = true;
          }
        }
      }
    }

    public static string ColorAt(Bitmap bmp, int x, int y) {
      Color c = bmp.GetPixel(x, y);
      return string.Format("{0},{1},{2}", c.R, c.G, c.B);
    }
  }
}
'@
}

# A screenshot of the session's desktop, saved as PNG and handed to the host so
# it lands in build/virt/ where it can actually be looked at.
function Save-Screenshot {
  param([string]$Name = 'screen', [switch]$Upload)
  Add-ScreenTypes
  $path = "$(Get-BarkleyRoot)\logs\$Name.png"
  $bmp = [Barkley.Screen]::Capture()
  try {
    $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bmp.Dispose()
  }
  if ($Upload) { Send-HostFile $path "shots/$Name.png" | Out-Null }
  $path
}

# Blobs of a colour on the current screen, largest first.
function Find-ColorBlobs {
  param(
    [Parameter(Mandatory = $true)][int]$R,
    [Parameter(Mandatory = $true)][int]$G,
    [Parameter(Mandatory = $true)][int]$B,
    [int]$Tolerance = 30,
    [int]$MinWidth = 8,
    [int]$MinHeight = 8
  )
  Add-ScreenTypes
  $bmp = [Barkley.Screen]::Capture()
  try {
    [Barkley.Screen]::FindBlobs($bmp, $R, $G, $B, $Tolerance, $MinWidth, $MinHeight)
  } finally {
    $bmp.Dispose()
  }
}

# Waits until a blob of the given colour and minimum size is on screen.
function Wait-ForColorBlob {
  param(
    [Parameter(Mandatory = $true)][int]$R,
    [Parameter(Mandatory = $true)][int]$G,
    [Parameter(Mandatory = $true)][int]$B,
    [int]$Tolerance = 30,
    [int]$MinWidth = 8,
    [int]$MinHeight = 8,
    [int]$TimeoutSeconds = 60,
    [string]$What = 'a coloured control'
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $blobs = Find-ColorBlobs -R $R -G $G -B $B -Tolerance $Tolerance -MinWidth $MinWidth -MinHeight $MinHeight
    if ($blobs.Count -gt 0) { return $blobs }
    Start-Sleep -Milliseconds 700
  }
  throw "$What never appeared (looking for RGB $R,$G,$B within $Tolerance)"
}
