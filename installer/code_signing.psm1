Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CodeSigningSettings {
    param([string]$Thumbprint = '', [string]$TimestampUrl = '')
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'signing.json') -Raw | ConvertFrom-Json
    if (-not $Thumbprint) { $Thumbprint = $config.thumbprint }
    if (-not $TimestampUrl) { $TimestampUrl = $config.timestampUrl }
    $Thumbprint = ($Thumbprint -replace '[\s\u200e\u200f]', '').ToUpperInvariant()
    if ($Thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Signing thumbprint must contain 40 hexadecimal characters.' }
    $uri = $null
    if (-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or $TimestampUrl -match '["''&|<>\r\n%]') {
        throw 'Timestamp URL must be an absolute HTTP(S) URL without shell metacharacters.'
    }
    [pscustomobject]@{ Thumbprint = $Thumbprint; TimestampUrl = $TimestampUrl }
}

function Find-CodeSigningTool {
    param([string]$Path = '')
    if ($Path) { return (Get-Item -LiteralPath $Path -ErrorAction Stop).FullName }
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tools = @(Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if (-not $tools.Count) { throw 'SignTool was not found. Install the Windows SDK signing tools.' }
    $tools[0]
}

function Find-CodeSigningPowerShell {
    # NSIS runs the signer in a separate process. Use PowerShell 7 consistently:
    # the legacy host failed to expose SimplySign's key association in this context.
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $path = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    throw 'PowerShell 7 is required for NSIS uninstaller signing. Install PowerShell 7 and retry.'
}

function Assert-CodeSigningCertificate {
    param([Parameter(Mandatory)][string]$Thumbprint)
    $cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
    if (-not $cert -or -not $cert.HasPrivateKey) {
        throw "Signing certificate $Thumbprint has no private key association in CurrentUser\My. Connect SimplySign Desktop using your phone token."
    }
    $now = Get-Date
    if ($now -lt $cert.NotBefore -or $now -gt $cert.NotAfter) { throw 'The signing certificate is outside its validity period.' }
    if ('1.3.6.1.5.5.7.3.3' -notin @($cert.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId })) {
        throw 'The selected certificate does not permit code signing.'
    }
    # HasPrivateKey confirms an association, not that Windows can load the provider.
    # Open the project's RSA key before rebuilding or replacing any outputs.
    if ($cert.PublicKey.Oid.Value -eq '1.2.840.113549.1.1.1') {
        try {
            $key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
            if (-not $key) { throw 'No RSA private key was returned.' }
            $key.Dispose()
        } catch {
            throw "Windows cannot open the signing key provider: $($_.Exception.Message). Repair the Certum installation if SimplySign KSP is unavailable, then reconnect SimplySign Desktop."
        }
    }
    Write-Host "Signing identity: $($cert.Subject) ($Thumbprint)" -ForegroundColor Cyan
}

function Assert-CodeSignature {
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [Parameter(Mandatory)][string]$Thumbprint,
        [Parameter(Mandatory)][string]$SignToolPath
    )
    foreach ($file in $Path) {
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
            $signature.SignerCertificate.Thumbprint -ne $Thumbprint -or -not $signature.TimeStamperCertificate) {
            throw "Signature must be trusted, timestamped, and signed by $Thumbprint : $file ($($signature.Status))."
        }
        & $SignToolPath verify /pa /all /tw /v $file
        if ($LASTEXITCODE -ne 0) { throw "Signature verification failed ($LASTEXITCODE): $file" }
    }
}

function Invoke-CodeSigning {
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [Parameter(Mandatory)][string]$Thumbprint,
        [Parameter(Mandatory)][string]$TimestampUrl,
        [Parameter(Mandatory)][string]$SignToolPath
    )
    Assert-CodeSigningCertificate -Thumbprint $Thumbprint
    foreach ($file in $Path) { Get-Item -LiteralPath $file -ErrorAction Stop | Out-Null }
    # One invocation per batch lets SimplySign reuse its PIN/session for all files.
    & $SignToolPath sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 /v @Path
    if ($LASTEXITCODE -ne 0) {
        throw "Signing failed ($LASTEXITCODE). Connect/reconnect SimplySign Desktop with your phone token and retry. No unsigned fallback is allowed."
    }
    Assert-CodeSignature -Path $Path -Thumbprint $Thumbprint -SignToolPath $SignToolPath
}

Export-ModuleMember -Function Get-CodeSigningSettings, Find-CodeSigningTool, Find-CodeSigningPowerShell, Assert-CodeSigningCertificate, Assert-CodeSignature, Invoke-CodeSigning
