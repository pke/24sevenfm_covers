# Render and run the deterministic browser tests without touching the interactive
# development preview. Both HTTP origins and the generated site live only for this run.
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)] [int] $PlayerPort = 0,
    [ValidateRange(0, 65535)] [int] $AttackerPort = 0,
    [switch] $SmokeOnly,
    [string] $NodeExecutable = '',
    [string[]] $PlaywrightArguments = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$protectedDevelopmentPorts = @(3000, 8099)

function Get-FreeTestPort([int[]] $Excluded) {
    do {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        try {
            $listener.Start()
            $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        } finally {
            $listener.Stop()
        }
    } while ($port -in $Excluded)
    return $port
}

if ($PlayerPort -in $protectedDevelopmentPorts -or $AttackerPort -in $protectedDevelopmentPorts) {
    throw 'Browser tests may not use the development ports 8099 (site) or 3000 (API).'
}
if (-not $PlayerPort) {
    $PlayerPort = Get-FreeTestPort $protectedDevelopmentPorts
}
if (-not $AttackerPort) {
    $AttackerPort = Get-FreeTestPort @($protectedDevelopmentPorts + $PlayerPort)
}
if ($PlayerPort -eq $AttackerPort) { throw 'PlayerPort and AttackerPort must differ.' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ("24covers-player-test-" + [guid]::NewGuid())))
if (-not $testRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Could not create a safe isolated browser-test directory.'
}
$buildDirectory = Join-Path $testRoot 'site'
$playerOrigin = "http://127.0.0.1:$PlayerPort"
$attackerOrigin = "http://127.0.0.1:$AttackerPort"
$playerProcess = $null
$attackerProcess = $null
$result = $null

$assets = @(
    @{ name = 'winamp_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'winamp_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.fb2k-component'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
    @{ name = 'viewer_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'viewer_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
)

function Start-TestServer([string] $Name, [int] $Port) {
    $stdoutLog = Join-Path $testRoot "$Name.stdout.log"
    $stderrLog = Join-Path $testRoot "$Name.stderr.log"
    $arguments = @(
        (Join-Path $PSScriptRoot 'static-server.js'), '--root', $buildDirectory,
        '--port', [string]$Port
    )
    $start = @{
        FilePath = $nodePath
        ArgumentList = $arguments
        PassThru = $true
        RedirectStandardOutput = $stdoutLog
        RedirectStandardError = $stderrLog
    }
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
            [Runtime.InteropServices.OSPlatform]::Windows)) {
        $start.WindowStyle = 'Hidden'
    }
    return Start-Process @start
}

function Wait-TestServer($Process, [string] $Uri, [string] $Name) {
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        if ($Process.HasExited) {
            $details = ((Get-Content (Join-Path $testRoot "$Name.stdout.log"),
                        (Join-Path $testRoot "$Name.stderr.log") -ErrorAction SilentlyContinue) -join "`n").Trim()
            throw "$Name test server exited during startup.`n$details"
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $Uri
            if ($response.StatusCode -eq 200) { return }
        } catch { # Server is still starting.
        }
        Start-Sleep -Milliseconds 100
    }
    throw "$Name test server did not become ready at $Uri."
}

$previousPlayerUrl = [Environment]::GetEnvironmentVariable('PLAYER_URL', 'Process')
$previousAttackerUrl = [Environment]::GetEnvironmentVariable('PLAYER_ATTACKER_URL', 'Process')
$previousLocal = [Environment]::GetEnvironmentVariable('PLAYER_LOCAL', 'Process')
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    & (Join-Path $root 'installer\render_site.ps1') `
        -Assets ($assets | ConvertTo-Json -Compress) -OutputDirectory $buildDirectory

    if (-not $NodeExecutable -and
            $env:npm_node_execpath -and
            (Test-Path -LiteralPath $env:npm_node_execpath -PathType Leaf)) {
        $NodeExecutable = $env:npm_node_execpath
    }
    if ($NodeExecutable) {
        $nodePath = (Resolve-Path -LiteralPath $NodeExecutable).Path
    } else {
        $nodePath = (Get-Command node -ErrorAction Stop).Source
    }
    $playerProcess = Start-TestServer 'player' $PlayerPort
    $attackerProcess = Start-TestServer 'attacker' $AttackerPort
    Wait-TestServer $playerProcess "$playerOrigin/player.html" 'player'
    Wait-TestServer $attackerProcess "$attackerOrigin/" 'attacker'

    if ($SmokeOnly) {
        $result = [pscustomobject]@{
            PlayerPort = $PlayerPort
            AttackerPort = $AttackerPort
            BuildDirectory = $buildDirectory
        }
    } else {
        $cli = Join-Path $PSScriptRoot 'node_modules\@playwright\test\cli.js'
        if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
            throw 'Playwright is not installed; run npm install in site\tests first.'
        }
        [Environment]::SetEnvironmentVariable('PLAYER_URL', $playerOrigin, 'Process')
        [Environment]::SetEnvironmentVariable('PLAYER_ATTACKER_URL', $attackerOrigin, 'Process')
        [Environment]::SetEnvironmentVariable('PLAYER_LOCAL', '1', 'Process')
        $testArguments = @($cli, 'test', 'player.spec.js', '--retries=0') + $PlaywrightArguments
        Push-Location $PSScriptRoot
        try { & $nodePath @testArguments } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "Playwright failed with exit code $LASTEXITCODE." }
    }
} finally {
    [Environment]::SetEnvironmentVariable('PLAYER_URL', $previousPlayerUrl, 'Process')
    [Environment]::SetEnvironmentVariable('PLAYER_ATTACKER_URL', $previousAttackerUrl, 'Process')
    [Environment]::SetEnvironmentVariable('PLAYER_LOCAL', $previousLocal, 'Process')
    foreach ($process in @($playerProcess, $attackerProcess)) {
        if ($process -and -not $process.HasExited) {
            try { $process.Kill($true) } catch { $process.Kill() }
            $process.WaitForExit()
        }
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

if ($SmokeOnly) { return $result }
