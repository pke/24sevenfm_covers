# These gates run without a SimplySign session, using isolated copies only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'code_signing.psm1') -Force

function Assert-Rejected([scriptblock]$Action, [string]$ExpectedMessage) {
    $rejected = $false
    try { & $Action | Out-Null } catch {
        $rejected = $true
        if ($_.Exception.Message -notlike "*$ExpectedMessage*") { throw }
    }
    if (-not $rejected) { throw "Expected rejection: $ExpectedMessage" }
}

$settings = Get-CodeSigningSettings
$tool = Find-CodeSigningTool
Assert-Rejected { Get-CodeSigningSettings -Thumbprint '1234' } '40 hexadecimal'
Assert-Rejected { Get-CodeSigningSettings -TimestampUrl 'file:///C:/test' } 'absolute HTTP'
Assert-Rejected { Get-CodeSigningSettings -TimestampUrl 'http://example.com/&whoami' } 'shell metacharacters'
Assert-Rejected { Assert-CodeSigningCertificate -Thumbprint ('0' * 40) } 'private key association'

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = [IO.Path]::GetFullPath((Join-Path $tempRoot ('24covers-signing-test-' + [guid]::NewGuid())))
if (-not $scratch.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test scratch path.' }
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $copy = Join-Path $scratch 'different-publisher.exe'
    # SDK SignTool has an embedded signature; cmd.exe may be catalog-signed only.
    Copy-Item -LiteralPath $tool -Destination $copy
    Assert-Rejected {
        Assert-CodeSignature -Path $copy -Thumbprint $settings.Thumbprint -SignToolPath $tool
    } 'Signature must be trusted'
    & $tool remove /s $copy | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the signature from the isolated test copy.' }
    Assert-Rejected {
        Assert-CodeSignature -Path $copy -Thumbprint $settings.Thumbprint -SignToolPath $tool
    } 'Signature must be trusted'

    $dist = Join-Path $scratch 'downloads'
    New-Item -ItemType Directory -Path $dist | Out-Null
    Assert-Rejected { & (Join-Path $PSScriptRoot 'verify_artifacts.ps1') -Directory $dist } 'exactly seven'
    $names = @(
        'winamp_24sevenfm_covers-1.0.0-20261001.exe', 'winamp_24sevenfm_covers-1.0.0-20261001.zip',
        'foobar_24sevenfm_covers-1.0.0-20261001.exe', 'foobar_24sevenfm_covers-1.0.0-20261001.zip',
        'foobar_24sevenfm_covers-1.0.0-20261001.fb2k-component',
        'viewer_24sevenfm_covers-1.0.0-20261001.exe', 'viewer_24sevenfm_covers-1.0.0-20261001.zip'
    )
    foreach ($name in $names) {
        $file = Join-Path $dist $name
        Copy-Item -LiteralPath $copy -Destination $file
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$file.sha256", "$hash  $name`n")
    }
    $badSidecar = Join-Path $dist "$($names[0]).sha256"
    $original = [IO.File]::ReadAllText($badSidecar)
    [IO.File]::WriteAllText($badSidecar, ('0' * 64) + "  $($names[0])`n")
    Assert-Rejected { & (Join-Path $PSScriptRoot 'verify_artifacts.ps1') -Directory $dist } 'Checksum mismatch'
    [IO.File]::WriteAllText($badSidecar, $original)
    # Correct checksums are insufficient: unsigned installers must still be rejected.
    Assert-Rejected { & (Join-Path $PSScriptRoot 'verify_artifacts.ps1') -Directory $dist } 'Signature must be trusted'

    $nsis = @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe") |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($nsis) {
        $nsi = Join-Path $scratch 'uninstaller signing gate.nsi'
        $output = Join-Path $scratch 'must-not-publish.exe'
        $include = Join-Path $PSScriptRoot 'signing.nsh'
        $source = @"
Unicode true
!include '$include'
OutFile '$output'
RequestExecutionLevel user
Section
  WriteUninstaller '`$INSTDIR\uninstall.exe'
SectionEnd
Section 'Uninstall'
SectionEnd
"@
        [IO.File]::WriteAllText($nsi, $source)
        & $nsis /V2 "/DSIGN_THUMBPRINT=$('0' * 40)" /DSIGN_TIMESTAMP=http://time.certum.pl `
            "/DSIGNTOOL=$tool" "/DSIGN_POWERSHELL=$(Find-CodeSigningPowerShell)" $nsi
        if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $output)) {
            throw 'NSIS produced an installer despite an uninstaller signing failure.'
        }
    }
} finally { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host 'Signing gates passed: malformed config, missing key, wrong publisher, unsigned files, incomplete release, and tampered checksum.' -ForegroundColor Green
# The final negative test deliberately leaves NSIS's native exit code at 1.
# Successful test completion must not report that expected failure to callers.
$global:LASTEXITCODE = 0
