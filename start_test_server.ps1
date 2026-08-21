# Start the rendered website and the Vercel Functions used by it. The two ports are
# intentionally explicit: the API process allows the static site's complete origin,
# while only the generated www\player.html points at the local API.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$SitePort = 8099,
    [ValidateRange(1, 65535)]
    [int]$ApiPort = 3000,
    [switch]$NoRender
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($SitePort -eq $ApiPort) { throw 'SitePort and ApiPort must differ.' }

$root = $PSScriptRoot
$siteOrigin = "http://localhost:$SitePort"
$apiOrigin = "http://localhost:$ApiPort"
$vercelVersion = '59.3.0'

$vercel = Get-Command vercel -ErrorAction SilentlyContinue
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$npx = Get-Command npx -ErrorAction SilentlyContinue
if ($vercel) {
    $apiExecutable = $vercel.Source
    $apiArguments = @('dev', '--local', '--listen', "$ApiPort", '--yes')
} elseif ($pnpm) {
    $apiExecutable = $pnpm.Source
    $apiArguments = @('dlx', '--allow-build=esbuild', "vercel@$vercelVersion",
        'dev', '--local', '--listen', "$ApiPort", '--yes')
} elseif ($npx) {
    $apiExecutable = $npx.Source
    $apiArguments = @('--yes', "vercel@$vercelVersion", 'dev', '--local',
        '--listen', "$ApiPort", '--yes')
} else {
    throw 'Vercel CLI unavailable: install vercel, pnpm, or npm/npx first.'
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$logDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot ("24covers-vercel-" + [guid]::NewGuid())))
if (-not $logDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Could not create a safe temporary log directory.'
}
$apiProcess = $null
try {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
    $stdoutLog = Join-Path $logDirectory 'stdout.log'
    $stderrLog = Join-Path $logDirectory 'stderr.log'
    $apiWorkspace = Join-Path $logDirectory 'project'
    New-Item -ItemType Directory -Path $apiWorkspace | Out-Null
    Copy-Item (Join-Path $root 'api') $apiWorkspace -Recurse
    foreach ($file in @('package.json', 'package-lock.json', 'vercel.json')) {
        Copy-Item (Join-Path $root $file) $apiWorkspace
    }
    $nodeModules = Join-Path $root 'node_modules'
    if (-not (Test-Path $nodeModules -PathType Container)) {
        throw 'node_modules is missing; run npm install before starting the local API.'
    }
    Copy-Item $nodeModules $apiWorkspace -Recurse

    $apiEnvironmentKeys = @(
        'TMDB_API_KEY', 'TMDB_READ_TOKEN', 'TMDB_API_TOKEN', 'FANART_API_KEY',
        'STEAMGRIDDB_API_KEY', 'BACKDROP_MEDIA_OVERRIDES', 'TINT_ALLOWED_HOSTS',
        'BACKDROP_ALLOWED_ORIGINS'
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
    try {
        $apiProcess = Start-Process -FilePath $apiExecutable -ArgumentList $apiArguments `
            -WorkingDirectory $apiWorkspace -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    } finally {
        foreach ($key in $apiEnvironmentKeys) {
            [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process')
        }
    }

    $portReady = $false
    for ($attempt = 1; $attempt -le 120; $attempt++) {
        if ($apiProcess.HasExited) {
            $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
            throw "Local Vercel API exited before startup.`n$details"
        }
        $socket = New-Object Net.Sockets.TcpClient
        try {
            $connection = $socket.ConnectAsync('localhost', $ApiPort)
            if ($connection.Wait(250) -and $socket.Connected) {
                $portReady = $true
                break
            }
        } catch { # API is still starting.
        } finally { $socket.Dispose() }
        Start-Sleep -Milliseconds 250
    }
    if (-not $portReady) {
        $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
        throw "Local Vercel API did not become ready at $apiOrigin.`n$details"
    }

    try {
        # The first request compiles the Function. Let it complete once instead of
        # repeatedly cancelling a cold build with short health-check timeouts.
        $response = Invoke-WebRequest -UseBasicParsing -Method Options -TimeoutSec 60 `
            -Headers @{ Origin = $siteOrigin } "$apiOrigin/api/backdrop"
    } catch {
        $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
        throw "Local Vercel API failed its CORS preflight: $($_.Exception.Message)`n$details"
    }
    if ($response.StatusCode -ne 204 -or
            $response.Headers['Access-Control-Allow-Origin'] -ne $siteOrigin) {
        throw "Local Vercel API did not allow origin $siteOrigin."
    }

    Write-Host "Local Vercel API ready at $apiOrigin" -ForegroundColor Cyan
    & (Join-Path $root 'installer\serve_site.ps1') -Port $SitePort `
        -NoRender:$NoRender -ApiOrigin $apiOrigin
} finally {
    if ($apiProcess -and -not $apiProcess.HasExited) {
        try { $apiProcess.Kill($true) } catch { $apiProcess.Kill() }
        $apiProcess.WaitForExit()
    }
    Remove-Item -LiteralPath $logDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
