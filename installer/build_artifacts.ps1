# build_artifacts.ps1 - regenerate all distribution artifacts into ..\dist
#
# Produces (from the already-built plugin DLLs):
#   foo_24sevencover.fb2k-component   foobar native package (double-click to install)
#   24sevenCover-Winamp-Setup.exe     NSIS installer (needs makensis on PATH / in NSIS folder)
#   24sevenCover-Winamp.zip           gen_24sevencover.dll + README.txt (manual install)
#   24sevenCover-foobar2000.zip       foo_24sevencover.dll + README.txt (manual install)
#   SHA256SUMS.txt                    SHA-256 of every artifact above
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1          (package existing DLLs)
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -Build   (rebuild the plugins first)

param([switch]$Build)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist'
$winDll = Join-Path $root 'winamp\build\Release\gen_24sevencover.dll'
$fbDll  = Join-Path $root 'foobar2000\foo_24sevencover\build\Release\foo_24sevencover.dll'

# Version from the single source shared\version.h (SSC_VER_MAJOR/MINOR/PATCH).
$vh = Get-Content (Join-Path $root 'shared\version.h') -Raw
function Get-Ver([string]$name) { if ($vh -match "#define\s+$name\s+(\d+)") { [int]$Matches[1] } else { 0 } }
$verStr = '{0}.{1}.{2}' -f (Get-Ver 'SSC_VER_MAJOR'), (Get-Ver 'SSC_VER_MINOR'), (Get-Ver 'SSC_VER_PATCH')
$ver4   = "$verStr.0"
Write-Host "Version $verStr" -ForegroundColor Cyan

function Find-Tool([string]$name, [string[]]$candidates) {
    $c = (Get-Command $name -ErrorAction SilentlyContinue).Source
    if ($c) { return $c }
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

if ($Build) {
    Write-Host "== Rebuilding plugins ==" -ForegroundColor Cyan
    $cmake = Find-Tool 'cmake.exe' @('C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe')
    $msb   = Find-Tool 'MSBuild.exe' @('C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe')
    if (-not $cmake -or -not $msb) { throw "cmake/MSBuild not found - build the plugins manually, then run without -Build." }
    & $cmake -S (Join-Path $root 'winamp') -B (Join-Path $root 'winamp\build') -A Win32 | Out-Null
    & $cmake --build (Join-Path $root 'winamp\build') --config Release
    $props = Join-Path $root 'foobar2000\wtl.props'
    & $msb (Join-Path $root 'foobar2000\foo_24sevencover\foo_24sevencover.vcxproj') `
        /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v145 /p:ForceImportAfterCppProps=$props /m /v:minimal
}

foreach ($d in @($winDll, $fbDll)) {
    if (-not (Test-Path $d)) { throw "Missing $d`nBuild the plugins first (or pass -Build)." }
}

# Fresh dist + scratch (clean contents, not the dir itself - avoids "dir in use" if a
# shell is cwd'd there or an AV is scanning a just-written file).
if (Test-Path $dist) { Get-ChildItem $dist -Force -Recurse | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue }
else { New-Item -ItemType Directory -Path $dist | Out-Null }
$wWin = Join-Path $dist '_win'; $wFb = Join-Path $dist '_fb'
New-Item -ItemType Directory -Path $wWin, $wFb | Out-Null

Write-Host "`n== Packaging ==" -ForegroundColor Cyan

# 1. foobar native .fb2k-component (a zip containing the DLL at the root)
Copy-Item $fbDll (Join-Path $wFb 'foo_24sevencover.dll')
$tmpZip = Join-Path $dist 'foo_24sevencover.zip'
Compress-Archive -Path (Join-Path $wFb 'foo_24sevencover.dll') -DestinationPath $tmpZip -Force
Move-Item $tmpZip (Join-Path $dist 'foo_24sevencover.fb2k-component') -Force
Write-Host "  foo_24sevencover.fb2k-component"

# 2. NSIS Winamp installer
$makensis = Find-Tool 'makensis.exe' @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")
if ($makensis) {
    & $makensis /V2 "/DAPPVER=$verStr" "/DAPPVER4=$ver4" (Join-Path $here 'winamp_24sevencover.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis failed." }
    Write-Host "  24sevenCover-Winamp-Setup.exe"
} else {
    Write-Warning "makensis not found - skipping the Winamp installer. Install NSIS (https://nsis.sourceforge.io), then re-run."
}

# 3. Manual-install zips (DLL + README.txt at the zip root)
Copy-Item $winDll (Join-Path $wWin 'gen_24sevencover.dll')
Copy-Item (Join-Path $here 'readme-winamp.txt') (Join-Path $wWin 'README.txt')
Copy-Item (Join-Path $here 'readme-foobar.txt') (Join-Path $wFb 'README.txt')
Compress-Archive -Path (Join-Path $wWin '*') -DestinationPath (Join-Path $dist '24sevenCover-Winamp.zip') -Force
Compress-Archive -Path (Join-Path $wFb  '*') -DestinationPath (Join-Path $dist '24sevenCover-foobar2000.zip') -Force
Write-Host "  24sevenCover-Winamp.zip"
Write-Host "  24sevenCover-foobar2000.zip"

Remove-Item $wWin, $wFb -Recurse -Force

# 4. A SHA-256 sidecar file next to each artifact (<name>.sha256, sha256sum format
#    so `sha256sum -c <name>.sha256` works).
$files = Get-ChildItem $dist -File | Where-Object { $_.Extension -ne '.sha256' } | Sort-Object Name
foreach ($f in $files) {
    $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($f.Name)" | Set-Content "$($f.FullName).sha256" -Encoding Ascii
    Write-Host "  $($f.Name).sha256"
}

Write-Host "`nArtifacts in $dist :" -ForegroundColor Green
Get-ChildItem $dist -File | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize
