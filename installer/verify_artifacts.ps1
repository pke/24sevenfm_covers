# Validate the exact release set, its checksums, installers, and archived payloads.
# This gate needs public certificates only; no SimplySign session is required.
param(
    [string]$Directory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'www\downloads'),
    [string]$SigningThumbprint = '',
    [string]$SignToolPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'code_signing.psm1') -Force
$signing = Get-CodeSigningSettings -Thumbprint $SigningThumbprint
$SignToolPath = Find-CodeSigningTool -Path $SignToolPath
$files = @(Get-ChildItem -LiteralPath $Directory -File)
$artifacts = @($files | Where-Object { $_.Extension -ne '.sha256' })
$expected = @('winamp.exe', 'winamp.zip', 'foobar.exe', 'foobar.zip', 'foobar.fb2k-component', 'viewer.exe', 'viewer.zip')
$found = @{}
$buildDates = @()
$versions = @{}
foreach ($artifact in $artifacts) {
    if ($artifact.Name -notmatch '^(winamp|foobar|viewer)_24sevenfm_covers-(\d+\.\d+\.\d+)-(\d{8})\.(exe|zip|fb2k-component)$') {
        throw "Unexpected release file: $($artifact.Name)"
    }
    $module = $Matches[1]; $version = $Matches[2]; $date = $Matches[3]; $extension = $Matches[4]
    $key = "$module.$extension"
    if ($key -notin $expected -or $found.ContainsKey($key)) { throw "Unexpected or duplicate artifact: $key" }
    if ($versions.ContainsKey($module) -and $versions[$module] -ne $version) { throw "Mixed versions for $module" }
    $versions[$module] = $version
    $found[$key] = $artifact
    $buildDates += $date
    $sidecar = "$($artifact.FullName).sha256"
    $checksum = [IO.File]::ReadAllText($sidecar).TrimEnd("`r", "`n")
    $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($checksum -cne "$hash  $($artifact.Name)") { throw "Checksum mismatch: $($artifact.Name)" }
}
if ($artifacts.Count -ne 7 -or $files.Count -ne 14 -or @($expected | Where-Object { -not $found.ContainsKey($_) }).Count) {
    throw 'A release must contain exactly seven artifacts and their seven SHA-256 sidecars.'
}
if (@($buildDates | Select-Object -Unique).Count -ne 1) { throw 'Release artifacts have mixed build dates.' }

Assert-CodeSignature -Path @($artifacts | Where-Object { $_.Extension -eq '.exe' } | ForEach-Object { $_.FullName }) `
    -Thumbprint $signing.Thumbprint -SignToolPath $SignToolPath

Add-Type -AssemblyName System.IO.Compression.FileSystem
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = [IO.Path]::GetFullPath((Join-Path $tempRoot ('24covers-signatures-' + [guid]::NewGuid())))
if (-not $scratch.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid verification scratch path.' }
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    foreach ($key in @('winamp.zip', 'foobar.zip', 'foobar.fb2k-component', 'viewer.zip')) {
        $module = $key.Split('.')[0]
        $payload = switch ($module) {
            winamp { 'gen_24sevenfm_covers.dll' }
            foobar { 'foo_24sevenfm_covers.dll' }
            viewer { '24sevenfm_covers.exe' }
        }
        $archive = [IO.Compression.ZipFile]::OpenRead($found[$key].FullName)
        try {
            $entries = @($archive.Entries | Where-Object { $_.FullName -ceq $payload })
            if ($entries.Count -ne 1 -or @($archive.Entries | Where-Object {
                $_.FullName -cne $payload -and $_.FullName -cne 'README.txt'
            }).Count) { throw "Unexpected archive contents: $key" }
            $destination = Join-Path $scratch "$key-$payload"
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $destination)
        } finally { $archive.Dispose() }
        Assert-CodeSignature -Path $destination -Thumbprint $signing.Thumbprint -SignToolPath $SignToolPath
        & (Join-Path $PSScriptRoot 'pack_native.ps1') -Path $destination -VerifyOnly
    }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host 'Verified all seven release artifacts: UPX integrity, checksums, publisher, trust, and timestamps.' -ForegroundColor Green
