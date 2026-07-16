# build_artifacts.ps1 - regenerate all distribution artifacts into ..\www\downloads
# (the website links them directly, so www\ is the complete publishable unit)
#
# Produces (from the already-built plugin DLLs), named <name>-<version>-<builddate>.<ext>:
#   foobar_24sevenfm_covers-<ver>-<date>.fb2k-component  foobar native package (double-click)
#   winamp_24sevenfm_covers-<ver>-<date>.exe             Winamp NSIS installer (needs makensis)
#   foobar_24sevenfm_covers-<ver>-<date>.exe             foobar NSIS installer (needs makensis)
#   winamp_24sevenfm_covers-<ver>-<date>.zip             gen_24sevenfm_covers.dll + README (manual)
#   foobar_24sevenfm_covers-<ver>-<date>.zip             foo_24sevenfm_covers.dll + README (manual)
#   viewer_24sevenfm_covers-<ver>-<date>.exe             desktop viewer NSIS installer (needs makensis)
#   viewer_24sevenfm_covers-<ver>-<date>.zip             24sevenfm_covers.exe + README (manual)
#   <artifact>.sha256                                    SHA-256 sidecar for each of the above
#
# The unit tests (lib/) are run FIRST and packaging is aborted if any fail.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1              (test, then package existing DLLs)
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -Build       (test, rebuild the plugins, package)
#   powershell -ExecutionPolicy Bypass -File build_artifacts.ps1 -SkipTests   (bypass the test gate - not recommended)

param(
    [switch]$Build,
    [switch]$SkipTests,
    [string]$ReleaseTag = '',    # set by the release workflow: links point at this GitHub release
    [string]$SiteUrl    = '',    # absolute site base URL (og:image); empty = relative (local preview)
    [string]$Toolset    = 'v145', # MSBuild platform toolset (CI runners have v143)
    [string]$VCToolsVersion = '' # pin a specific MSVC tools version (ATL is not in every one)
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$dist = Join-Path $root 'www\downloads'
$winDll = Join-Path $root 'winamp\build\Release\gen_24sevenfm_covers.dll'
$fbDll  = Join-Path $root 'foobar2000\foo_24sevenfm_covers\build\Release\foo_24sevenfm_covers.dll'
$viExe  = Join-Path $root 'desktop\build\Release\24sevenfm_covers.exe'

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
$viVer   = Get-ModuleVer (Join-Path $root 'desktop\viewer_version.h')
$winVer4 = "$winVer.0"
$fbVer4  = "$fbVer.0"
$viVer4  = "$viVer.0"

# Eclipse-style artifact naming: <name>-<version>-<builddate>.<ext>. Each artifact uses
# ITS OWN module version; each NSIS installer carries its own module's version.
$stamp   = Get-Date -Format 'yyyyMMdd'
$nFbComp = "foobar_24sevenfm_covers-$fbVer-$stamp.fb2k-component"
$nWinExe = "winamp_24sevenfm_covers-$winVer-$stamp.exe"
$nFbExe  = "foobar_24sevenfm_covers-$fbVer-$stamp.exe"
$nWinZip = "winamp_24sevenfm_covers-$winVer-$stamp.zip"
$nFbZip  = "foobar_24sevenfm_covers-$fbVer-$stamp.zip"
$nViExe  = "viewer_24sevenfm_covers-$viVer-$stamp.exe"
$nViZip  = "viewer_24sevenfm_covers-$viVer-$stamp.zip"
Write-Host "Winamp $winVer  |  foobar $fbVer  |  viewer $viVer   (build $stamp)" -ForegroundColor Cyan

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
    if ($LASTEXITCODE -ne 0) { throw "Winamp CMake configure FAILED" }
    & $cmake --build (Join-Path $root 'winamp\build') --config Release
    if ($LASTEXITCODE -ne 0) { throw "Winamp plugin build FAILED" }
    # ATL ships only with SOME side-by-side MSVC tools versions (e.g. 14.51 has it,
    # 14.52 does not) and the foobar SDK needs it. Unless the caller pinned one,
    # pick the newest toolset that actually contains atlbase.h - self-healing on
    # both the dev machine and CI runners when VS updates shuffle the defaults.
    if (-not $VCToolsVersion) {
        $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vswhere) {
            $vsRoot = & $vswhere -latest -property installationPath
            $withAtl = Get-ChildItem (Join-Path $vsRoot 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
                       Where-Object { Test-Path (Join-Path $_.FullName 'atlmfc\include\atlbase.h') } |
                       Sort-Object Name | Select-Object -Last 1
            if ($withAtl) {
                $VCToolsVersion = $withAtl.Name
                Write-Host "  ATL-capable MSVC toolset: $VCToolsVersion"
            }
        }
    }
    $vcPin = if ($VCToolsVersion) { "/p:VCToolsVersion=$VCToolsVersion" } else { $null }
    $props = Join-Path $root 'foobar2000\wtl.props'
    & $msb (Join-Path $root 'foobar2000\foo_24sevenfm_covers\foo_24sevenfm_covers.vcxproj') `
        /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=$Toolset /p:ForceImportAfterCppProps=$props $vcPin /m /v:minimal
    if ($LASTEXITCODE -ne 0) { throw "foobar2000 component build FAILED" }
    & $msb (Join-Path $root 'desktop\24sevenfm_covers.vcxproj') `
        /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=$Toolset /m /v:minimal
    if ($LASTEXITCODE -ne 0) { throw "desktop viewer build FAILED" }
}

foreach ($d in @($winDll, $fbDll, $viExe)) {
    if (-not (Test-Path $d)) { throw "Missing $d`nBuild first (or pass -Build)." }
}

# Fresh dist + scratch (clean contents, not the dir itself - avoids "dir in use" if a
# shell is cwd'd there or an AV is scanning a just-written file).
if (Test-Path $dist) { Get-ChildItem $dist -Force -Recurse | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue }
else { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
$wWin = Join-Path $dist '_win'; $wFb = Join-Path $dist '_fb'; $wVi = Join-Path $dist '_vi'
New-Item -ItemType Directory -Path $wWin, $wFb, $wVi | Out-Null

Write-Host "`n== Packaging ==" -ForegroundColor Cyan

# 1. foobar native .fb2k-component (a zip containing the DLL at the root)
Copy-Item $fbDll (Join-Path $wFb 'foo_24sevenfm_covers.dll')
$tmpZip = Join-Path $dist 'foo_24sevenfm_covers.zip'
Compress-Archive -Path (Join-Path $wFb 'foo_24sevenfm_covers.dll') -DestinationPath $tmpZip -Force
Move-Item $tmpZip (Join-Path $dist $nFbComp) -Force
Write-Host "  $nFbComp"

# 2. NSIS installers (Winamp + foobar2000). Each .nsi writes its base name; the
#    version/date suffix is added here. Each carries its own module version.
$makensis = Find-Tool 'makensis.exe' @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")
if ($makensis) {
    & $makensis /V2 "/DAPPVER=$winVer" "/DAPPVER4=$winVer4" (Join-Path $here 'winamp_24sevenfm_covers.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis (Winamp) failed." }
    Move-Item (Join-Path $dist 'winamp_24sevenfm_covers.exe') (Join-Path $dist $nWinExe) -Force
    Write-Host "  $nWinExe"

    & $makensis /V2 "/DAPPVER=$fbVer" "/DAPPVER4=$fbVer4" (Join-Path $here 'foobar_24sevenfm_covers.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis (foobar) failed." }
    Move-Item (Join-Path $dist 'foobar_24sevenfm_covers.exe') (Join-Path $dist $nFbExe) -Force
    Write-Host "  $nFbExe"

    & $makensis /V2 "/DAPPVER=$viVer" "/DAPPVER4=$viVer4" (Join-Path $here 'viewer_24sevenfm_covers.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis (viewer) failed." }
    Move-Item (Join-Path $dist 'viewer_24sevenfm_covers.exe') (Join-Path $dist $nViExe) -Force
    Write-Host "  $nViExe"
} else {
    Write-Warning "makensis not found - skipping both NSIS installers. Install NSIS (https://nsis.sourceforge.io), then re-run."
}

# 3. Manual-install zips (DLL + README.txt at the zip root)
Copy-Item $winDll (Join-Path $wWin 'gen_24sevenfm_covers.dll')
Copy-Item (Join-Path $here 'readme-winamp.txt') (Join-Path $wWin 'README.txt')
Copy-Item (Join-Path $here 'readme-foobar.txt') (Join-Path $wFb 'README.txt')
Copy-Item $viExe (Join-Path $wVi '24sevenfm_covers.exe')
Copy-Item (Join-Path $here 'readme-viewer.txt') (Join-Path $wVi 'README.txt')
Compress-Archive -Path (Join-Path $wWin '*') -DestinationPath (Join-Path $dist $nWinZip) -Force
Compress-Archive -Path (Join-Path $wFb  '*') -DestinationPath (Join-Path $dist $nFbZip) -Force
Compress-Archive -Path (Join-Path $wVi  '*') -DestinationPath (Join-Path $dist $nViZip) -Force
Write-Host "  $nWinZip"
Write-Host "  $nFbZip"
Write-Host "  $nViZip"

Remove-Item $wWin, $wFb, $wVi -Recurse -Force

# 4. A SHA-256 sidecar file next to each artifact (<name>.sha256, sha256sum format
#    so `sha256sum -c <name>.sha256` works).
$files = Get-ChildItem $dist -File | Where-Object { $_.Extension -ne '.sha256' } | Sort-Object Name
foreach ($f in $files) {
    $h = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    # LF-terminated, no BOM: Set-Content would write CRLF, and the trailing CR then
    # becomes part of the filename for `sha256sum -c` on older coreutils (Ubuntu
    # 22.04, Git-for-Windows) - "no file was verified".
    [System.IO.File]::WriteAllText("$($f.FullName).sha256", "$h  $($f.Name)`n",
                                   (New-Object System.Text.ASCIIEncoding))
    Write-Host "  $($f.Name).sha256"
}

# 5. Render the website: site\ (source with {{TOKEN}} placeholders) -> www\ (the
#    gh-pages root). Local preview links to the downloads\ folder; a release build
#    (-ReleaseTag) links to that GitHub release's assets instead.
$siteSrc = Join-Path $root 'site'
if (Test-Path (Join-Path $siteSrc 'index.html')) {
    Copy-Item (Join-Path $siteSrc 'css') (Join-Path $root 'www') -Recurse -Force
    Copy-Item (Join-Path $siteSrc 'img') (Join-Path $root 'www') -Recurse -Force
    $base = if ($ReleaseTag) { "https://github.com/pke/24sevenfm_covers/releases/download/$ReleaseTag/" } else { 'downloads/' }
    function SizeOf([string]$name) {
        $f = Join-Path $dist $name
        if (Test-Path $f) { '{0} KB' -f [math]::Round((Get-Item $f).Length / 1KB) } else { 'n/a' }
    }
    $tokens = @{
        '{{VER_WINAMP}}'            = $winVer
        '{{VER_FOOBAR}}'            = $fbVer
        '{{VER_VIEWER}}'            = $viVer
        '{{URL_WINAMP_EXE}}'        = $base + $nWinExe
        '{{URL_WINAMP_ZIP}}'        = $base + $nWinZip
        '{{URL_FOOBAR_COMPONENT}}'  = $base + $nFbComp
        '{{URL_FOOBAR_EXE}}'        = $base + $nFbExe
        '{{URL_FOOBAR_ZIP}}'        = $base + $nFbZip
        '{{URL_VIEWER_EXE}}'        = $base + $nViExe
        '{{URL_VIEWER_ZIP}}'        = $base + $nViZip
        '{{SIZE_WINAMP_EXE}}'       = SizeOf $nWinExe
        '{{SIZE_WINAMP_ZIP}}'       = SizeOf $nWinZip
        '{{SIZE_FOOBAR_COMPONENT}}' = SizeOf $nFbComp
        '{{SIZE_FOOBAR_EXE}}'       = SizeOf $nFbExe
        '{{SIZE_FOOBAR_ZIP}}'       = SizeOf $nFbZip
        '{{SIZE_VIEWER_EXE}}'       = SizeOf $nViExe
        '{{SIZE_VIEWER_ZIP}}'       = SizeOf $nViZip
        '{{SITE_URL}}'              = $SiteUrl
        '{{UPDATED}}'               = (Get-Date -Format 'yyyy-MM-dd')
        '{{RELEASE_TAG}}'           = $(if ($ReleaseTag) { $ReleaseTag } else { 'local preview' })
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)   # 5.1 default would mangle the emoji
    $stamp = if ($ReleaseTag) { $ReleaseTag } else { 'local preview' }
    # Every .html in site\ is a page (index, privacy, ...) - adding one needs no change here.
    foreach ($page in Get-ChildItem $siteSrc -Filter '*.html' -File) {
        $html = [System.IO.File]::ReadAllText($page.FullName, $utf8)
        foreach ($t in $tokens.Keys) { $html = $html.Replace($t, [string]$tokens[$t]) }
        if ($html -match '\{\{[A-Z_]+\}\}') { throw "Unsubstituted token in site\$($page.Name): $($Matches[0])" }
        [System.IO.File]::WriteAllText((Join-Path $root "www\$($page.Name)"), $html, $utf8)
        Write-Host "  www\$($page.Name) rendered ($stamp)"
    }
}

Write-Host "`nArtifacts in $dist :" -ForegroundColor Green
Get-ChildItem $dist -File | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Format-Table -AutoSize
