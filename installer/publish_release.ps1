# Local release: build/sign/verify first. Upload only when explicitly passed -Publish.
param(
    [switch]$Publish,
    [string]$Tag = ('v' + (Get-Date -Format 'yyyy.MM.dd-HHmmssfff')),
    [string]$Repo = 'pke/24sevenfm_covers',
    [string]$SiteUrl = 'https://24sevenfm-covers.dudesoft.app/',
    [string]$Toolset = 'v145',
    [string]$VCToolsVersion = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
if ($Tag -notmatch '^v\d{4}\.\d{2}\.\d{2}-\d+$') { throw 'Tag must match vYYYY.MM.DD-<number>.' }
if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repo must be owner/name.' }
Push-Location $root
try {
    if ($Publish) {
        $changes = @(git status --porcelain)
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git state.' }
        if ($changes.Count) { throw 'Commit the intended release changes before publishing. The working tree must be clean.' }
        & gh auth status
        if ($LASTEXITCODE -ne 0) { throw 'Authenticate GitHub CLI before publishing.' }
    }
    $revision = git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the release commit.' }
    & (Join-Path $PSScriptRoot 'build_artifacts.ps1') -Build -ReleaseTag $Tag -SiteUrl $SiteUrl -Repo $Repo `
        -Toolset $Toolset -VCToolsVersion $VCToolsVersion
    & (Join-Path $PSScriptRoot 'verify_artifacts.ps1')

    # GitHub generates the changelog against the previous release. The body clearly
    # describes the signing policy and publisher without claiming SmartScreen immunity.
    $notes = @(
        'DV, Winamp and foobar2000 binaries, installers, and embedded uninstallers are Authenticode-signed.',
        'Publisher: **Open Source Developer Philipp Kursawe**.',
        'Signatures use SHA-256 with RFC 3161 timestamps.',
        'Every download includes a `.sha256` sidecar (`sha256sum -c <file>.sha256`).'
    ) -join "`n`n"
    $notesPath = Join-Path $root 'www\release-notes.md'
    [IO.File]::WriteAllText($notesPath, $notes, (New-Object System.Text.UTF8Encoding($false)))
    if (-not $Publish) {
        Write-Host "Release prepared and verified. Notes: $notesPath" -ForegroundColor Green
        Write-Host 'To rebuild and publish a committed release, run: ./installer/publish_release.ps1 -Publish'
        return
    }
    # Recheck after the build: a concurrent edit must not publish under an older commit.
    $changes = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -or (git rev-parse HEAD) -ne $revision) {
        throw 'Git state changed during the build; refusing to publish.'
    }
    # Create the tag only from a commit already available on GitHub.
    $remoteRevision = gh api "repos/$Repo/commits/$revision" --jq .sha
    if ($LASTEXITCODE -ne 0 -or $remoteRevision -ne $revision) { throw 'Push the release commit to GitHub before publishing.' }
    $files = @(Get-ChildItem -LiteralPath (Join-Path $root 'www\downloads') -File | ForEach-Object { $_.FullName })
    & gh release create $Tag @files --repo $Repo --target $revision --title $Tag `
        --notes-file $notesPath --generate-notes --draft
    if ($LASTEXITCODE -ne 0) { throw 'Draft release upload failed. Inspect the draft before retrying.' }
    & gh release edit $Tag --repo $Repo --draft=false --latest
    if ($LASTEXITCODE -ne 0) { throw "Publishing failed. The uploaded draft $Tag is retained." }
    Write-Host "Published https://github.com/$Repo/releases/tag/$Tag" -ForegroundColor Green
    Write-Host 'Deploy site runs on the published release; if using GITHUB_TOKEN, dispatch Deploy site explicitly.'
} finally { Pop-Location }
