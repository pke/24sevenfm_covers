# shoot.ps1 - capture real screenshots of the desktop viewer for the website.
#
# RUN THIS FROM YOUR OWN (interactive) SESSION - it launches the viewer, waits for
# a cover to arrive from the station, captures the window, and writes
# www\img\poster.png and www\img\fill.png. Then point index.html at the .png files
# instead of the .svg mockups.
#
#   powershell -File www\shoot.ps1
#
# The viewer window will appear twice for ~30 s each (poster, then fill mode).
# NOTE: it overwrites desktop\build\Release\24seven.fm-covers.ini with
# screenshot-friendly options (SST, countdown on, rolling digits).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # repo root (www\..)
$exe = Join-Path $root 'desktop\build\Release\24sevenfm_covers.exe'
$ini = Join-Path $root 'desktop\build\Release\24seven.fm-covers.ini'
$out = Join-Path $root 'www\img'
if (-not (Test-Path $exe)) { throw "Build the viewer first: $exe" }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern IntPtr FindWindowA(string cls, string title);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

function Capture([string]$name, [int]$w, [int]$h) {
    $hwnd = [IntPtr]::Zero
    foreach ($i in 1..30) {
        $hwnd = [Win]::FindWindowA($null, '24seven.fm Covers')
        if ($hwnd -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($hwnd -eq [IntPtr]::Zero) { Write-Warning "viewer window not found for $name"; return }
    [Win]::SetWindowPos($hwnd, [IntPtr]::Zero, 60, 60, $w, $h, 0x0040) | Out-Null
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    Write-Host "waiting 30 s for the cover to load ($name)..."
    Start-Sleep -Seconds 30
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap(($r.R - $r.L), ($r.B - $r.T))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $dc = $g.GetHdc()
    [Win]::PrintWindow($hwnd, $dc, 2) | Out-Null   # PW_RENDERFULLCONTENT for D2D
    $g.ReleaseHdc($dc); $g.Dispose()
    $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  -> img\$name.png"
}

function SetLayout([int]$layout) {
    @(
        '[options]',
        'station=sst',
        "layout=$layout",
        'showRemaining=1',
        'remainingSize=0',
        'roll=1',
        'transition=1',
        'fadeMs=1000'
    ) | Set-Content $ini -Encoding Ascii
}

Get-Process 24sevenfm_covers -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

SetLayout 1                          # poster, landscape window
Start-Process $exe
Capture 'poster' 1100 680
Get-Process 24sevenfm_covers -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

SetLayout 0                          # fill, square window
Start-Process $exe
Capture 'fill' 640 640
Get-Process 24sevenfm_covers -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host "done. Update www\index.html: img/poster.svg -> img/poster.png, img/fill.svg -> img/fill.png"
