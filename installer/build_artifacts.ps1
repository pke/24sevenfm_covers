# build_artifacts.ps1 - regenerate all distribution artifacts into ..\dist
#
# Produces (from the already-built plugin DLLs), named <name>-<version>-<builddate>.<ext>:
#   foobar_24sevenfm_covers-<ver>-<date>.fb2k-component  foobar native package (double-click)
#   winamp_24sevenfm_covers-<ver>-<date>.exe             NSIS installer (needs makensis)
#   winamp_24sevenfm_covers-<ver>-<date>.zip             gen_24sevenfm_covers.dll + README (manual)
#   foobar_24sevenfm_covers-<ver>-<date>.zip             foo_24sevenfm_covers.dll + README (manual)
#   <artifact>.sha256                                    SHA-256 sidecar for each of the above
#
# The unit tests (lib/) are run FIRST and packaging is aborted if any fail.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1              (test, then package existing DLLs)
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -Build       (test, rebuild the plugins, package)
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -SkipTests   (bypass the test gate - not recommended)

param([switch]$Build, [switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'dist'
$winDll = Join-Path $root 'winamp\build\Release\gen_24sevenfm_covers.dll'
$fbDll  = Join-Path $root 'foobar2000\foo_24sevenfm_covers\build\Release\foo_24sevenfm_covers.dll'

# Per-module versions - each binary versions INDEPENDENTLY in its own header.
function Get-VerField([string]$file, [string]$name) {
    $c = Get-Content $file -Raw
    if ($c -match "#define\s+$name\s+(\d+)") { [int]$Matches[1] } else { 0 }
}
function Get-ModuleVer([string]$file) {
    '{0}.{1}.{2}' -f (Get-VerField $file 'SSC_VER_MAJOR'), (Get-VerField $file 'SSC_VER_MINOR'), (Get-VerField $file 'SSC_VER_PATCH')
}
$winVer  = Get-ModuleVer (Join-Path $root 'winamp\gen_version.h')
$fbVer   = Get-ModuleVer (Join-Path $root 'foobar2000\foo_24sevenfm_covers\foo_version.h')
$winVer4 = "$winVer.0"

# Eclipse-style artifact naming: <name>-<version>-<builddate>.<ext>. Each artifact uses
# ITS OWN module version; the NSIS installer carries the Winamp plugin's version.
$stamp   = Get-Date -Format 'yyyyMMdd'
$nFbComp = "foobar_24sevenfm_covers-$fbVer-$stamp.fb2k-component"
$nWinExe = "winamp_24sevenfm_covers-$winVer-$stamp.exe"
$nWinZip = "winamp_24sevenfm_covers-$winVer-$stamp.zip"
$nFbZip  = "foobar_24sevenfm_covers-$fbVer-$stamp.zip"
Write-Host "Winamp $winVer  |  foobar $fbVer   (build $stamp)" -ForegroundColor Cyan

function Find-Tool([string]$name, [string[]]$candidates) {
    $c = (Get-Command $name -ErrorAction SilentlyContinue).Source
    if ($c) { return $c }
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    return $null
}

# --- Test gate: the unit tests MUST pass before we build or package anything. -----
# Bypass only with -SkipTests (packages an unverified build).
if (-not $SkipTests) {
    Write-Host "== Running unit tests ==" -ForegroundColor Cyan
    $cmake = Find-Tool 'cmake.exe' @('C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe')
    if (-not $cmake) { throw "cmake not found - cannot run the unit tests. Install VS 2026's CMake, or re-run with -SkipTests to bypass (not recommended)." }
    $ctest   = Join-Path (Split-Path $cmake) 'ctest.exe'
    $testBld = Join-Path $root 'lib\build-tests'
    & $cmake -S (Join-Path $root 'lib') -B $testBld -A x64 -DCOVERFETCH_BUILD_TESTS=ON -DCOVERFETCH_BUILD_EXAMPLE=OFF | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Test configure failed - aborting, nothing packaged." }
    & $cmake --build $testBld --config Release | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Test build failed - aborting, nothing packaged." }
    & $ctest --test-dir $testBld -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "Unit tests FAILED - aborting, nothing packaged." }
    Write-Host "  unit tests passed" -ForegroundColor Green
} else {
    Write-Warning "Skipping unit tests (-SkipTests) - packaging an unverified build."
}

if ($Build) {
    Write-Host "== Rebuilding plugins ==" -ForegroundColor Cyan
    $cmake = Find-Tool 'cmake.exe' @('C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe')
    $msb   = Find-Tool 'MSBuild.exe' @('C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe')
    if (-not $cmake -or -not $msb) { throw "cmake/MSBuild not found - build the plugins manually, then run without -Build." }
    & $cmake -S (Join-Path $root 'winamp') -B (Join-Path $root 'winamp\build') -A Win32 | Out-Null
    & $cmake --build (Join-Path $root 'winamp\build') --config Release
    $props = Join-Path $root 'foobar2000\wtl.props'
    & $msb (Join-Path $root 'foobar2000\foo_24sevenfm_covers\foo_24sevenfm_covers.vcxproj') `
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
Copy-Item $fbDll (Join-Path $wFb 'foo_24sevenfm_covers.dll')
$tmpZip = Join-Path $dist 'foo_24sevenfm_covers.zip'
Compress-Archive -Path (Join-Path $wFb 'foo_24sevenfm_covers.dll') -DestinationPath $tmpZip -Force
Move-Item $tmpZip (Join-Path $dist $nFbComp) -Force
Write-Host "  $nFbComp"

# 2. NSIS Winamp installer
$makensis = Find-Tool 'makensis.exe' @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")
if ($makensis) {
    & $makensis /V2 "/DAPPVER=$winVer" "/DAPPVER4=$winVer4" (Join-Path $here 'winamp_24sevenfm_covers.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis failed." }
    # The .nsi writes the base name; add the version/date suffix here.
    Move-Item (Join-Path $dist 'winamp_24sevenfm_covers.exe') (Join-Path $dist $nWinExe) -Force
    Write-Host "  $nWinExe"
} else {
    Write-Warning "makensis not found - skipping the Winamp installer. Install NSIS (https://nsis.sourceforge.io), then re-run."
}

# 3. Manual-install zips (DLL + README.txt at the zip root)
Copy-Item $winDll (Join-Path $wWin 'gen_24sevenfm_covers.dll')
Copy-Item (Join-Path $here 'readme-winamp.txt') (Join-Path $wWin 'README.txt')
Copy-Item (Join-Path $here 'readme-foobar.txt') (Join-Path $wFb 'README.txt')
Compress-Archive -Path (Join-Path $wWin '*') -DestinationPath (Join-Path $dist $nWinZip) -Force
Compress-Archive -Path (Join-Path $wFb  '*') -DestinationPath (Join-Path $dist $nFbZip) -Force
Write-Host "  $nWinZip"
Write-Host "  $nFbZip"

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
