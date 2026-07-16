# shoot.ps1 - set up demo/screenshot mode from the local demo\ covers and launch the
# players, so you can take the screenshots by hand.
#
# It copies whatever you keep in the repo's demo\ folder (cover images + demo.txt) into the
# folder the apps read - %TEMP%\24seven.fm-covers-demo\ - then launches the desktop viewer,
# Winamp and foobar2000. With that folder present each app runs in "demo mode": it shows
# those covers instead of a live station, 'N' cycles to the next (crossfade), and each
# frame's Seconds seed the countdown + auto-advance. Delete the folder and restart an app
# to return to the live station.
#
#   powershell -File site\shoot.ps1
#   powershell -File site\shoot.ps1 -Winamp "C:\Path\winamp.exe" -Foobar "C:\Path\foobar2000.exe"
#   powershell -File site\shoot.ps1 -NoLaunch      # only (re)build the demo folder
#   powershell -File site\shoot.ps1 -Clean         # delete the demo folder -> back to live
#
# Curate demo\ with the covers you want - name them so they sort (01.jpg, 02.jpg, ...) and
# add a demo.txt with one "Album | Track | Artist | Seconds" line per cover. The plugins
# must already be installed in Winamp / foobar2000; this only launches the hosts. The demo
# folder is a sticky sentinel: while it exists every app starts in demo mode, so run -Clean
# (then restart the apps) when you're done shooting to return to the live station.
param(
    [string]$Winamp,     # winamp.exe (auto-detected if omitted)
    [string]$Foobar,     # foobar2000.exe (auto-detected if omitted)
    [switch]$NoLaunch,   # build the demo folder but don't launch anything
    [switch]$Clean       # just delete the demo folder (exit demo mode) and stop
)
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # repo root (site\..)
$viewer = Join-Path $root 'desktop\build\Release\24sevenfm_covers.exe'
$ini    = Join-Path $root 'desktop\build\Release\24seven.fm-covers.ini'
$src    = Join-Path $root 'demo'
$demo   = Join-Path $env:TEMP '24seven.fm-covers-demo'

if ($Clean) {
    if (Test-Path $demo) { Remove-Item $demo -Recurse -Force; Write-Host "Removed $demo" -ForegroundColor Green }
    else { Write-Host "Nothing to clean: $demo doesn't exist." }
    Write-Host "Restart the apps to return to the live station."
    return
}

if (-not (Test-Path $src)) {
    throw "No demo covers at $src - create demo\ with your covers (01.jpg, 02.jpg, ...) and a demo.txt."
}

# --- copy the local demo covers into the folder the apps read --------------------------
Write-Host "== Demo folder: $demo ==" -ForegroundColor Cyan
if (Test-Path $demo) { Get-ChildItem $demo -Force | Remove-Item -Recurse -Force }
else { New-Item -ItemType Directory -Force $demo | Out-Null }
Copy-Item (Join-Path $src '*') $demo -Recurse -Force
Get-ChildItem $demo | ForEach-Object { Write-Host ("  {0}" -f $_.Name) }

# Screenshot-friendly viewer options (poster layout + rolling countdown). Station is
# irrelevant in demo mode; these just make the viewer open camera-ready. Overwrites the ini.
@('[options]','station=sst','layout=1','showRemaining=1','remainingSize=1','roll=1','transition=1','fadeMs=1000') |
    Set-Content $ini -Encoding Ascii

if ($NoLaunch) { Write-Host "`nDemo folder ready. (-NoLaunch: not launching players.)"; return }

# --- launch the players ----------------------------------------------------------------
Write-Host "`n== Launching players ==" -ForegroundColor Cyan
function Find-Exe([string]$given, [string[]]$candidates) {
    foreach ($p in @($given) + $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}
$wa = Find-Exe $Winamp @("$env:ProgramFiles\Winamp\winamp.exe", "${env:ProgramFiles(x86)}\Winamp\winamp.exe", "$env:USERPROFILE\OneDrive\tools\Winamp\winamp.exe")
$fb = Find-Exe $Foobar @("$env:ProgramFiles\foobar2000\foobar2000.exe", "${env:ProgramFiles(x86)}\foobar2000\foobar2000.exe", "$env:USERPROFILE\OneDrive\tools\foobar2000\foobar2000.exe")

if (Test-Path $viewer) { Start-Process $viewer; Write-Host "  viewer" } else { Write-Warning "viewer not built: run installer\build_artifacts.ps1 -Build" }
if ($wa) { Start-Process $wa; Write-Host "  Winamp     ($wa)" }    else { Write-Warning "Winamp not found - pass -Winamp <path>" }
if ($fb) { Start-Process $fb; Write-Host "  foobar2000 ($fb)" }    else { Write-Warning "foobar2000 not found - pass -Foobar <path>" }

Write-Host "`nAll set. In each app: 'N' cycles covers, double-click / F = fullscreen." -ForegroundColor Green
Write-Host "The plugins show the cover without tuning to a station while demo mode is on."
Write-Host "Done? Delete $demo and restart the apps to return to the live station."
