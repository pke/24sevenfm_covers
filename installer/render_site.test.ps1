$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Test([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

$root = Split-Path -Parent $PSScriptRoot
$publishedPlayer = Join-Path $root 'www\player.html'
$publishedPlayerExisted = Test-Path -LiteralPath $publishedPlayer -PathType Leaf
$publishedPlayerHash = if ($publishedPlayerExisted) {
    (Get-FileHash -LiteralPath $publishedPlayer -Algorithm SHA256).Hash
} else { '' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testOutput = [IO.Path]::GetFullPath((Join-Path $tempRoot ("24covers-render-test-" + [guid]::NewGuid())))
if (-not $testOutput.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Could not create a safe isolated render directory.'
}

$assets = @(
    @{ name = 'winamp_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'winamp_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.fb2k-component'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'foobar_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
    @{ name = 'viewer_24sevenfm_covers-1.2.3-20260821.exe'; size = 1024 }
    @{ name = 'viewer_24sevenfm_covers-1.2.3-20260821.zip'; size = 1024 }
)

try {
    & (Join-Path $PSScriptRoot 'render_site.ps1') `
        -Assets ($assets | ConvertTo-Json -Compress) -OutputDirectory $testOutput `
        -ApiOrigin 'http://localhost:3000'
    Assert-Test (Test-Path -LiteralPath (Join-Path $testOutput 'player.html') -PathType Leaf) `
        'the isolated output should contain player.html'
    $renderedPlayer = [IO.File]::ReadAllText((Join-Path $testOutput 'player.html'))
    Assert-Test ($renderedPlayer.Contains('http://localhost:3000/api/backdrop')) `
        'the renderer should write the local API origin directly into player.html'
    Assert-Test ($renderedPlayer.Contains('http://localhost:3000/api/credit')) `
        'the renderer should apply the local API origin to album-credit requests'
    $resolverHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $resolverHashBytes = $resolverHasher.ComputeHash([IO.File]::ReadAllBytes(
            (Join-Path $root 'api\_lib\backdrop.js')))
    } finally {
        $resolverHasher.Dispose()
    }
    $resolverVersion = (-join @($resolverHashBytes | ForEach-Object {
        $_.ToString('x2')
    })).Substring(0, 12)
    Assert-Test ($renderedPlayer.Contains("resolver_version=$resolverVersion")) `
        'the renderer should derive the resolver cache key from the resolver source'
    Assert-Test (-not $renderedPlayer.Contains('resolver_version=1')) `
        'the rendered player should not retain a manually maintained resolver version'
    Assert-Test (-not $renderedPlayer.Contains('https://24covers-api.vercel.app')) `
        'the local render should not expose an intermediate production API origin'

    Assert-Test ((Test-Path -LiteralPath $publishedPlayer -PathType Leaf) -eq $publishedPlayerExisted) `
        'an isolated render should not create or remove www\player.html'
    if ($publishedPlayerExisted) {
        Assert-Test ((Get-FileHash -LiteralPath $publishedPlayer -Algorithm SHA256).Hash `
            -eq $publishedPlayerHash) 'an isolated render should not modify www\player.html'
    }
} finally {
    if (Test-Path -LiteralPath $testOutput) {
        Remove-Item -LiteralPath $testOutput -Recurse -Force
    }
}

Write-Host 'PASS: renderer can target an isolated directory without changing www'
