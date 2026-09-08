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
    [switch]$NoBackchannel,
    [switch]$Detached,
    [string]$StatusFile = '',
    [string]$CodexPath = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($SitePort -eq $ApiPort) { throw 'SitePort and ApiPort must differ.' }

$root = $PSScriptRoot
$siteOrigin = "http://localhost:$SitePort"
$apiOrigin = "http://localhost:$ApiPort"

# A normal invocation intentionally owns both child servers so Ctrl+C tears the
# complete preview down. Codex tool terminals run inside a Windows job object,
# so even Start-Process children are reclaimed with the tool session. Detached
# previews therefore belong to Task Scheduler instead.
if ($Detached) {
    $pwsh = (Get-Process -Id $PID).Path
    if (-not $NoBackchannel -and -not [string]::IsNullOrWhiteSpace($BackchannelThreadId)) {
        $parsedThreadId = [guid]::Empty
        if (-not [guid]::TryParse($BackchannelThreadId, [ref]$parsedThreadId)) {
            throw 'BackchannelThreadId must be a Codex task UUID.'
        }
        $BackchannelThreadId = $parsedThreadId.ToString()
        if (-not $CodexPath) {
            $codex = Get-Command codex -ErrorAction SilentlyContinue
            if (-not $codex) { throw 'Codex CLI was not found in the launching session.' }
            $CodexPath = $codex.Source
        }
        $CodexPath = [IO.Path]::GetFullPath($CodexPath)
        if (-not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) {
            throw "Codex CLI does not exist: $CodexPath"
        }
    }
    $taskName = "24sevenfm Local Preview $SitePort"
    $statusRoot = [IO.Path]::GetFullPath((Join-Path $root '.vercel'))
    New-Item -ItemType Directory -Path $statusRoot -Force | Out-Null
    $detachedStatusFile = [IO.Path]::GetFullPath((Join-Path $statusRoot `
        "preview-$SitePort.status.json"))
    $arguments = "-NoLogo -NoProfile -File `"$PSCommandPath`"" +
        " -SitePort $SitePort -ApiPort $ApiPort -StatusFile `"$detachedStatusFile`""
    if ($NoRender) { $arguments += ' -NoRender' }
    if ($NoApiDebug) { $arguments += ' -NoApiDebug' }
    if ($NoBackchannel) {
        $arguments += ' -NoBackchannel'
    } elseif (-not [string]::IsNullOrWhiteSpace($BackchannelThreadId)) {
        $arguments += " -BackchannelThreadId $BackchannelThreadId" +
            " -CodexPath `"$CodexPath`""
    }
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        if ($existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    # Task Scheduler can terminate the owning PowerShell before its finally block
    # runs, leaving the Node watcher or site watcher orphaned. Remove only processes
    # whose executable and command line both identify this repository's preview.
    $previewProcesses = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -like "*$root*" -and
        $_.ExecutablePath -in @('C:\Program Files\nodejs\node.exe', $pwsh) -and
        ($_.CommandLine -like '*installer\local_api_server.js*' -or
         $_.CommandLine -like '*installer\watch_site.ps1*' -or
         $_.CommandLine -like '*start_test_server.ps1*')
    }
    foreach ($previewProcess in $previewProcesses) {
        Stop-Process -Id $previewProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 1; $attempt -le 50; $attempt++) {
        $busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in $SitePort, $ApiPort }
        if (-not $busy) { break }
        Start-Sleep -Milliseconds 200
    }
    Remove-Item -LiteralPath $detachedStatusFile -Force -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments `
        -WorkingDirectory $root
    # Task Scheduler requires a trigger even though this launcher starts the task
    # explicitly. Keep that placeholder far away so it cannot fire a second instance
    # during startup; RestartCount still handles genuine task failures.
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Persistent local 24seven.fm preview on port $SitePort" | Out-Null
    Start-ScheduledTask -TaskName $taskName
    function Test-LoopbackPortOpen([int]$Port) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            return $client.ConnectAsync([Net.IPAddress]::Loopback, $Port).Wait(1000) -and
                $client.Connected
        } catch {
            return $false
        } finally {
            $client.Dispose()
        }
    }
    # Task Scheduler and the first Node/CORS warm-up can take over 30 seconds on a
    # cold Windows session. Give the detached owner enough time without weakening
    # the readiness checks.
    for ($attempt = 1; $attempt -le 300; $attempt++) {
        if (-not (Test-Path -LiteralPath $detachedStatusFile)) {
            Start-Sleep -Milliseconds 250
            continue
        }
        try {
            $status = Get-Content $detachedStatusFile -Raw -ErrorAction Stop |
                ConvertFrom-Json -ErrorAction Stop
            $backchannelReady = $NoBackchannel -or [string]::IsNullOrWhiteSpace($BackchannelThreadId) `
                -or $status.backchannelEnabled -eq $true
            if ($status.siteOrigin -eq $siteOrigin -and $status.apiOrigin -eq $apiOrigin -and
                    $backchannelReady -and (Test-LoopbackPortOpen $SitePort) -and
                    (Test-LoopbackPortOpen $ApiPort)) {
                Write-Host "Persistent local preview ready at $siteOrigin" -ForegroundColor Cyan
                Write-Host "Scheduled task: $taskName" -ForegroundColor Green
                if ($status.backchannelEnabled) {
                    Write-Host "Codex backchannel pairing code: $($status.pairingCode)" `
                        -ForegroundColor Magenta
                }
                exit 0
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    throw "Persistent local preview did not become ready (task state: $($task.State))."
}

$taskTranscriptStarted = $false
if ($StatusFile) {
    $taskTranscript = [IO.Path]::GetFullPath($StatusFile + '.task.log')
    try {
        Start-Transcript -Path $taskTranscript -Force | Out-Null
        $taskTranscriptStarted = $true
    } catch { }
}

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
    $codex = if ($CodexPath) {
        $resolvedCodexPath = [IO.Path]::GetFullPath($CodexPath)
        if (Test-Path -LiteralPath $resolvedCodexPath -PathType Leaf) {
            [pscustomobject]@{ Source = $resolvedCodexPath }
        }
    } else {
        Get-Command codex -ErrorAction SilentlyContinue
    }
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
            -Headers @{ Origin = $siteOrigin } "$apiOrigin/api/media"
    } catch {
        $details = ((Get-Content $stdoutLog, $stderrLog -ErrorAction SilentlyContinue) -join "`n").Trim()
        throw "Local Node API failed its CORS preflight: $($_.Exception.Message)`n$details"
    }
    if ($response.StatusCode -ne 204 -or
            $response.Headers['Access-Control-Allow-Origin'] -ne $siteOrigin) {
        throw "Local Node API did not allow origin $siteOrigin."
    }

    if ($StatusFile) {
        $statusRoot = [IO.Path]::GetFullPath((Join-Path $root '.vercel'))
        $statusPath = [IO.Path]::GetFullPath($StatusFile)
        if (-not $statusPath.StartsWith(($statusRoot + [IO.Path]::DirectorySeparatorChar),
                [StringComparison]::OrdinalIgnoreCase)) {
            throw 'StatusFile must be inside the repository .vercel directory.'
        }
        $status = [ordered]@{
            processId = $PID
            apiProcessId = $apiProcess.Id
            siteOrigin = $siteOrigin
            apiOrigin = $apiOrigin
            backchannelEnabled = $backchannelEnabled
            pairingCode = $(if ($backchannelEnabled) { $pairingCode } else { '' })
            startedAt = [DateTimeOffset]::Now.ToString('o')
        } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($statusPath, $status, [Text.UTF8Encoding]::new($false))
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
    if ($taskTranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}
