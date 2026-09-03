# Start the rendered website and its persistent local Node API. The two ports are
# intentionally explicit: the API process allows the static site's complete origin,
# while only the generated www\player.html points at the local API.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$SitePort = 8099,
    [ValidateRange(1, 65535)]
    [int]$ApiPort = 3000,
    [switch]$NoRender,
    [Alias('NoVercelDebug')]
    [switch]$NoApiDebug,
    [string]$BackchannelThreadId = $env:CODEX_THREAD_ID,
    [switch]$NoBackchannel
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($SitePort -eq $ApiPort) { throw 'SitePort and ApiPort must differ.' }

$root = $PSScriptRoot
$siteOrigin = "http://localhost:$SitePort"
$apiOrigin = "http://localhost:$ApiPort"

function Test-LoopbackPortAvailable([int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        return $true
    } catch [Net.Sockets.SocketException] {
        return $false
    } finally {
        $listener.Stop()
    }
}

if (-not (Test-LoopbackPortAvailable $ApiPort)) {
    throw "Local API port $ApiPort is already in use. Stop the previous preview or pass -ApiPort with a free port."
}
if (-not (Test-LoopbackPortAvailable $SitePort)) {
    throw "Site port $SitePort is already in use. Stop the previous preview or pass -SitePort with a free port."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required for the local API preview.' }
$apiExecutable = $node.Source
$apiServerPath = Join-Path $root 'installer\local_api_server.js'
$apiArguments = @('--watch-preserve-output',
    ("--watch-path=" + (Join-Path $root 'api')),
    ("--watch-path=" + $apiServerPath),
    ("--watch-path=" + (Join-Path $root 'installer\backchannel.js')),
    $apiServerPath)

$backchannelEnabled = -not $NoBackchannel -and -not [string]::IsNullOrWhiteSpace($BackchannelThreadId)
$pairingCode = ''
$codexExecutable = ''
if ($backchannelEnabled) {
    $parsedThreadId = [guid]::Empty
    if (-not [guid]::TryParse($BackchannelThreadId, [ref]$parsedThreadId)) {
        throw 'BackchannelThreadId must be a Codex task UUID.'
    }
    $BackchannelThreadId = $parsedThreadId.ToString()
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        Write-Warning 'Codex CLI was not found; the local title backchannel is disabled.'
        $backchannelEnabled = $false
    } else {
        $codexExecutable = $codex.Source
        $rawCode = [guid]::NewGuid().ToString('N').Substring(0, 12).ToUpperInvariant()
        $pairingCode = $rawCode.Substring(0, 4) + '-' + $rawCode.Substring(4, 4) + '-' +
            $rawCode.Substring(8, 4)
    }
}

$vercelDirectory = [IO.Path]::GetFullPath((Join-Path $root '.vercel'))
$logRoot = [IO.Path]::GetFullPath((Join-Path $vercelDirectory 'logs'))
if (-not $logRoot.StartsWith(($vercelDirectory + [IO.Path]::DirectorySeparatorChar),
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Could not create a safe local API log directory.'
}
$logDirectory = Join-Path $logRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + "-$ApiPort-" +
    [guid]::NewGuid().ToString('N').Substring(0, 8))
$apiProcess = $null
try {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stdoutLog = Join-Path $logDirectory 'stdout.log'
    $stderrLog = Join-Path $logDirectory 'stderr.log'
    $nodeModules = Join-Path $root 'node_modules'
    if (-not (Test-Path $nodeModules -PathType Container)) {
        throw 'node_modules is missing; run npm install before starting the local API.'
    }

    $apiEnvironmentKeys = @(
        'TMDB_API_KEY', 'TMDB_READ_TOKEN', 'TMDB_API_TOKEN', 'FANART_API_KEY',
        'STEAMGRIDDB_API_KEY', 'BACKDROP_MEDIA_OVERRIDES', 'TINT_ALLOWED_HOSTS',
        'BACKDROP_ALLOWED_ORIGINS', 'BACKDROP_DEBUG_LOG', 'LOCAL_API_PORT',
        'CODEX_BACKCHANNEL_TOKEN', 'CODEX_BACKCHANNEL_THREAD_ID',
        'CODEX_BACKCHANNEL_ROOT', 'CODEX_BACKCHANNEL_CODEX'
    )
    $previousEnvironment = @{}
    foreach ($key in $apiEnvironmentKeys) {
        $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    $envFile = Join-Path $root '.env.local'
    if (Test-Path $envFile -PathType Leaf) {
        foreach ($line in Get-Content $envFile) {
            $match = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
            if (-not $match.Success -or $match.Groups[1].Value -notin $apiEnvironmentKeys) { continue }
            $value = $match.Groups[2].Value.Trim()
            if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or
                    ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($match.Groups[1].Value, $value, 'Process')
        }
    }
    [Environment]::SetEnvironmentVariable('BACKDROP_ALLOWED_ORIGINS', $siteOrigin, 'Process')
    [Environment]::SetEnvironmentVariable('BACKDROP_DEBUG_LOG',
        $(if ($NoApiDebug) { '0' } else { '1' }), 'Process')
    [Environment]::SetEnvironmentVariable('LOCAL_API_PORT', "$ApiPort", 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_BACKCHANNEL_TOKEN',
        $(if ($backchannelEnabled) { $pairingCode } else { $null }), 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_BACKCHANNEL_THREAD_ID',
        $(if ($backchannelEnabled) { $BackchannelThreadId } else { $null }), 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_BACKCHANNEL_ROOT',
        $(if ($backchannelEnabled) { $root } else { $null }), 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_BACKCHANNEL_CODEX',
        $(if ($backchannelEnabled) { $codexExecutable } else { $null }), 'Process')
    try {
        $apiProcess = Start-Process -FilePath $apiExecutable -ArgumentList $apiArguments `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    } finally {
        foreach ($key in $apiEnvironmentKeys) {
            [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process')
        }
    }

    $apiReady = $false
    $readyMarker = "[local-api] ready at http://localhost:$ApiPort"
    for ($attempt = 1; $attempt -le 80; $attempt++) {
        if ($apiProcess.HasExited) {
            $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
            throw "Local Node API exited before startup.`n$details"
        }
        $stdout = Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue
        if ($stdout -and $stdout.Contains($readyMarker)) {
            $apiReady = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $apiReady) {
        $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
        throw "Local Node API did not become ready at $apiOrigin.`n$details"
    }

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Options -TimeoutSec 60 `
            -Headers @{ Origin = $siteOrigin } "$apiOrigin/api/backdrop"
    } catch {
        $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
        throw "Local Node API failed its CORS preflight: $($_.Exception.Message)`n$details"
    }
    if ($response.StatusCode -ne 204 -or
            $response.Headers['Access-Control-Allow-Origin'] -ne $siteOrigin) {
        throw "Local Node API did not allow origin $siteOrigin."
    }

    Write-Host "Local Node API ready at $apiOrigin (watching api\)" -ForegroundColor Cyan
    Write-Host "Local API logs: $logDirectory" -ForegroundColor DarkCyan
    if ($backchannelEnabled) {
        Write-Host "Codex backchannel pairing code: $pairingCode" -ForegroundColor Magenta
        Write-Host 'Click the current player title and enter this code once for this tab.' `
            -ForegroundColor DarkMagenta
    } elseif (-not $NoBackchannel) {
        Write-Warning 'Codex backchannel is disabled. Start this preview from a Codex task or pass -BackchannelThreadId.'
    }
    & (Join-Path $root 'installer\serve_site.ps1') -Port $SitePort `
        -NoRender:$NoRender -ApiOrigin $apiOrigin
} finally {
    if ($apiProcess -and -not $apiProcess.HasExited) {
        try { $apiProcess.Kill($true) } catch { $apiProcess.Kill() }
        $apiProcess.WaitForExit()
    }
}
