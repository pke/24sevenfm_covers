[CmdletBinding()]
param([string] $NodeExecutable = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Test([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runner = Join-Path $PSScriptRoot 'run_local.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Missing isolated test runner: $runner"
}

$publishedPlayer = Join-Path $root 'www\player.html'
$publishedPlayerExisted = Test-Path -LiteralPath $publishedPlayer -PathType Leaf
$publishedPlayerHash = if ($publishedPlayerExisted) {
    (Get-FileHash -LiteralPath $publishedPlayer -Algorithm SHA256).Hash
} else { '' }

$result = & $runner -SmokeOnly -NodeExecutable $NodeExecutable
Assert-Test ($result.PlayerPort -notin @(3000, 8099)) `
    'the player test server must not use either development-server port'
Assert-Test ($result.AttackerPort -notin @(3000, 8099)) `
    'the attacker test server must not use either development-server port'
Assert-Test ($result.PlayerPort -ne $result.AttackerPort) `
    'the player and attacker fixtures must have different origins'
Assert-Test (-not (Test-Path -LiteralPath $result.BuildDirectory)) `
    'the temporary test build should be removed after the run'
Assert-Test ((Test-Path -LiteralPath $publishedPlayer -PathType Leaf) -eq $publishedPlayerExisted) `
    'the test runner should not create or remove www\player.html'
if ($publishedPlayerExisted) {
    Assert-Test ((Get-FileHash -LiteralPath $publishedPlayer -Algorithm SHA256).Hash `
        -eq $publishedPlayerHash) 'the test runner should not modify www\player.html'
}

Write-Host 'PASS: local browser tests use isolated origins and an isolated build'
