# render_site.ps1 - render site\ (tokenised source) into www\ (the GitHub Pages root).
#
# The page advertises the three downloads, so rendering it needs each artifact's NAME,
# SIZE and VERSION. Those arrive as an asset list rather than being read off disk, which
# is what lets one renderer serve both callers:
#
#   build_artifacts.ps1  passes the artifacts it just packaged into www\downloads
#   deploy-site.yml      passes the assets of the EXISTING GitHub release, so a copy
#                        change goes live without rebuilding or cutting a release
#
# Versions are parsed from the asset FILENAMES, never from the version headers: the site
# must advertise what is actually downloadable. After a version bump the headers run ahead
# of the newest release, so a site-only deploy that trusted them would offer a version
# that 404s.
#
# Usage:
#   render_site.ps1 -Assets $json -ReleaseTag v2026.07.13-16 -SiteUrl https://example/    (release)
#   render_site.ps1 -Assets $json                                                          (local preview)
param(
    # JSON array of the release/dist artifacts: [{"name":"winamp_...-1.10.0-20260713.exe","size":206462}, ...]
    # `.sha256` sidecars are ignored. Exactly the shape `gh release view --json assets` returns.
    [Parameter(Mandatory)][string]$Assets,
    [string]$ReleaseTag = '',   # '' = local preview: links point at the downloads\ folder
    [string]$SiteUrl    = '',   # absolute site base URL (og:image); empty for local preview
    [string]$Repo       = 'pke/24sevenfm_covers'
)

$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$root    = Split-Path -Parent $here
$siteSrc = Join-Path $root 'site'
$www     = Join-Path $root 'www'

# --- classify the assets ----------------------------------------------------------------
# Artifact naming is <module>_24sevenfm_covers-<version>-<builddate>.<ext> (see
# build_artifacts.ps1). Parsing it back out is what makes the site renderable from a
# release alone - the build date in the name is why the filenames cannot just be
# recomputed from the clock at deploy time.
$parsed = ConvertFrom-Json $Assets
if ($parsed -isnot [System.Array]) { $parsed = @($parsed) }   # 5.1 collapses a 1-element array

$found = @{}   # KEY (e.g. WINAMP_EXE) -> @{ name; size; version }
foreach ($a in $parsed) {
    if ($a.name -match '^(winamp|foobar|viewer)_24sevenfm_covers-(\d+\.\d+\.\d+)-\d{8}\.(fb2k-component|exe|zip)$') {
        $module = $Matches[1].ToUpper()
        $ver    = $Matches[2]
        $ext    = $Matches[3]
        $kind   = if ($ext -eq 'fb2k-component') { 'COMPONENT' } else { $ext.ToUpper() }
        $found["${module}_${kind}"] = @{ name = $a.name; size = [long]$a.size; version = $ver }
    }
}

# Fail loudly and specifically. The unsubstituted-token check below would catch a gap
# anyway, but "missing artifact FOOBAR_COMPONENT" beats "leftover {{URL_FOOBAR_COMPONENT}}".
$required = @('WINAMP_EXE','WINAMP_ZIP','FOOBAR_COMPONENT','FOOBAR_EXE','FOOBAR_ZIP','VIEWER_EXE','VIEWER_ZIP')
$missing  = $required | Where-Object { -not $found.ContainsKey($_) }
if ($missing) {
    throw ("render_site: no asset matched {0}. Got: {1}" -f ($missing -join ', '),
           (($parsed | ForEach-Object { $_.name }) -join ', '))
}

# sitemap.xml and the canonical links need ABSOLUTE urls. Rendering a deploy without
# -SiteUrl would publish <loc></loc> and empty canonicals - invalid, and silently so, which
# is exactly the kind of thing nobody notices until rankings are already wrong. A local
# preview (no -ReleaseTag) is never published, so it may leave them relative.
if ($ReleaseTag -and -not $SiteUrl) {
    throw "render_site: -SiteUrl is required with -ReleaseTag; sitemap/canonical URLs must be absolute."
}

# Only releases created by release.yml are valid deployment inputs. Git ref names permit
# HTML-significant characters such as '<' and '>', so accepting an arbitrary tag here would
# turn release metadata into markup when {{RELEASE_TAG}} is written into each page footer.
if ($ReleaseTag -and $ReleaseTag -notmatch '^v\d{4}\.\d{2}\.\d{2}-\d+$') {
    throw "render_site: invalid -ReleaseTag '$ReleaseTag'; expected vYYYY.MM.DD-<run>."
}

$releaseTagUrl = if ($ReleaseTag) { [uri]::EscapeDataString($ReleaseTag) } else { '' }
$base = if ($ReleaseTag) { "https://github.com/$Repo/releases/download/$releaseTagUrl/" } else { 'downloads/' }
function Url([string]$key)  { $base + $found[$key].name }
function Size([string]$key) { '{0} KB' -f [math]::Round($found[$key].size / 1KB) }

$tokens = @{
    '{{VER_WINAMP}}'            = $found['WINAMP_EXE'].version
    '{{VER_FOOBAR}}'            = $found['FOOBAR_COMPONENT'].version
    '{{VER_VIEWER}}'            = $found['VIEWER_EXE'].version
    '{{URL_WINAMP_EXE}}'        = Url 'WINAMP_EXE'
    '{{URL_WINAMP_ZIP}}'        = Url 'WINAMP_ZIP'
    '{{URL_FOOBAR_COMPONENT}}'  = Url 'FOOBAR_COMPONENT'
    '{{URL_FOOBAR_EXE}}'        = Url 'FOOBAR_EXE'
    '{{URL_FOOBAR_ZIP}}'        = Url 'FOOBAR_ZIP'
    '{{URL_VIEWER_EXE}}'        = Url 'VIEWER_EXE'
    '{{URL_VIEWER_ZIP}}'        = Url 'VIEWER_ZIP'
    '{{SIZE_WINAMP_EXE}}'       = Size 'WINAMP_EXE'
    '{{SIZE_WINAMP_ZIP}}'       = Size 'WINAMP_ZIP'
    '{{SIZE_FOOBAR_COMPONENT}}' = Size 'FOOBAR_COMPONENT'
    '{{SIZE_FOOBAR_EXE}}'       = Size 'FOOBAR_EXE'
    '{{SIZE_FOOBAR_ZIP}}'       = Size 'FOOBAR_ZIP'
    '{{SIZE_VIEWER_EXE}}'       = Size 'VIEWER_EXE'
    '{{SIZE_VIEWER_ZIP}}'       = Size 'VIEWER_ZIP'
    '{{SITE_URL}}'              = $SiteUrl
    '{{UPDATED}}'               = (Get-Date -Format 'yyyy-MM-dd')
    '{{RELEASE_TAG}}'           = $(if ($ReleaseTag) {
        [System.Net.WebUtility]::HtmlEncode($ReleaseTag)
    } else { 'local preview' })
    # Cache-buster for css/js links (?v=...). GitHub Pages serves everything with a fixed
    # max-age=600 and no way to set headers, so unversioned asset URLs can pair a fresh
    # HTML with a stale script (or vice versa) for up to 10 minutes after a deploy - a JS
    # that addresses an element the cached HTML doesn't have yet crashes the player.
    # Stamping per render pins each HTML to exactly the assets it shipped with. A
    # timestamp, not the release tag: site-only deploys reuse the newest release's tag,
    # which would defeat the busting precisely when it's needed.
    '{{ASSET_V}}'               = (Get-Date -Format 'yyyyMMddHHmmss')
}

# --- render ------------------------------------------------------------------------------
New-Item -ItemType Directory -Force $www | Out-Null
# css + img + js (js: the web player; the theme toggle stays inline in each page)
foreach ($dir in @('css', 'img', 'js')) {
    $src = Join-Path $siteSrc $dir
    if (Test-Path $src) { Copy-Item $src $www -Recurse -Force }
}

$utf8  = New-Object System.Text.UTF8Encoding($false)   # 5.1's default would mangle the emoji
$stamp = if ($ReleaseTag) { $ReleaseTag } else { 'local preview' }
# Every .html in site\ is a page (index, privacy, ...) - adding one needs no change here.
# robots.txt/sitemap.xml are named explicitly rather than copying whatever else lives in
# site\, which would publish README.md and shoot.ps1 too. They carry {{SITE_URL}}, so they
# must go through the token pass, not a plain copy.
$publish = Get-ChildItem $siteSrc -File |
           Where-Object { $_.Extension -eq '.html' -or $_.Name -in @('robots.txt', 'sitemap.xml', 'humans.txt') }
foreach ($page in $publish) {
    $text = [System.IO.File]::ReadAllText($page.FullName, $utf8)
    foreach ($t in $tokens.Keys) { $text = $text.Replace($t, [string]$tokens[$t]) }
    if ($text -match '\{\{[A-Z_]+\}\}') { throw "Unsubstituted token in site\$($page.Name): $($Matches[0])" }
    [System.IO.File]::WriteAllText((Join-Path $www $page.Name), $text, $utf8)
    Write-Host "  www\$($page.Name) rendered ($stamp)"
}
Write-Host ("  Winamp {0} | foobar {1} | viewer {2}" -f `
    $tokens['{{VER_WINAMP}}'], $tokens['{{VER_FOOBAR}}'], $tokens['{{VER_VIEWER}}']) -ForegroundColor Cyan
