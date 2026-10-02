# NSIS calls this for each embedded uninstaller; a failure aborts compilation.
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Thumbprint,
    [Parameter(Mandatory)][string]$TimestampUrl,
    [Parameter(Mandatory)][string]$SignToolPath
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'code_signing.psm1') -Force
$settings = Get-CodeSigningSettings -Thumbprint $Thumbprint -TimestampUrl $TimestampUrl
Invoke-CodeSigning -Path $Path -Thumbprint $settings.Thumbprint `
    -TimestampUrl $settings.TimestampUrl -SignToolPath $SignToolPath
