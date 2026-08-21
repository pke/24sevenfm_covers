$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ("24covers-serve-test-" + [guid]::NewGuid())))
if (-not $testRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Could not create a safe isolated server test directory.'
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$productionOrigin = 'https://24covers-api.vercel.app'
$localOrigin = 'http://localhost:3000'
$playerPath = Join-Path $testRoot 'player.html'
$stdoutPath = Join-Path $testRoot 'stdout.log'
$stderrPath = Join-Path $testRoot 'stderr.log'
$server = $null

function Write-ProductionPlayer {
    $html = @"
<!doctype html>
<meta http-equiv="Content-Security-Policy" content="connect-src $productionOrigin">
<meta name="backdrop-api" content="$productionOrigin/api/backdrop?resolver_version=1">
"@
    [IO.File]::WriteAllText($playerPath, $html, [Text.UTF8Encoding]::new($false))
}

try {
    New-Item -ItemType Directory -Path (Join-Path $testRoot 'downloads') -Force | Out-Null
    Write-ProductionPlayer

    $powerShellPath = (Get-Process -Id $PID).Path
    $serveScript = Join-Path $PSScriptRoot 'serve_site.ps1'
    $arguments = "-NoProfile -File `"$serveScript`" -Port $port -NoRender -NoWatch " +
        "-ApiOrigin `"$localOrigin`" -WebRoot `"$testRoot`""
    $startParameters = @{
        FilePath = $powerShellPath
        ArgumentList = $arguments
        PassThru = $true
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
    }
    if ($env:OS -eq 'Windows_NT') { $startParameters['WindowStyle'] = 'Hidden' }
    $server = Start-Process @startParameters

    $url = "http://localhost:$port/player.html"
    $response = $null
    for ($attempt = 0; $attempt -lt 50 -and -not $response; $attempt++) {
        if ($server.HasExited) {
            throw "serve_site exited early: $([IO.File]::ReadAllText($stderrPath))"
        }
        try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    Assert-Test ($null -ne $response) 'the isolated local server should become reachable'
    Assert-Test ($response.Content.Contains("$localOrigin/api/backdrop")) `
        'the initial response should use the configured local API origin'

    # Reproduce the regression: another renderer overwrites the generated file with the
    # production URL after the preview server has already started.
    Write-ProductionPlayer
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing
    Assert-Test ($response.Content.Contains("$localOrigin/api/backdrop")) `
        'the response should still use the local API after an external overwrite'
    Assert-Test (-not $response.Content.Contains($productionOrigin)) `
        'the response must not expose the production API after an external overwrite'
    Assert-Test ([IO.File]::ReadAllText($playerPath).Contains($productionOrigin)) `
        'the regression fixture should remain overwritten on disk, proving the response guard ran'
    Assert-Test ($response.Headers['Cache-Control'] -contains 'no-store') `
        'the guarded response should remain uncached'
} finally {
    if ($server -and -not $server.HasExited) {
        $server.Kill()
        $server.WaitForExit()
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Host 'PASS: local server pins player responses to the configured API after overwrite'
