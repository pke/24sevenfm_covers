# Pack only linked native binaries; signing and archive creation follow this step.
param([Parameter(Mandatory)][string[]]$Path, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$version = '5.2.1'
$cache = Join-Path $root ".codex/tools/upx-$version"
$upx = Join-Path $cache "upx-$version-win64/upx.exe"
$archiveHash = 'EABC6792A347D45E945BE7748423E7868FD01B0D2BCAA2F4B1031FD71FF69BDA'
$executableHash = 'D20EBE0B7B22B6BE968C8C34BE61F94DDEA12CB11462E2CEC27F548EF9574DF8'

# MSBuild/CMake hosts can run concurrently. Serialize the initial download;
# verify the cached executable on every invocation too.
$mutex = New-Object Threading.Mutex($false, 'Local\24sevenfm-UPX-5.2.1')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(60000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Timed out waiting for UPX setup.' }
    if (-not (Test-Path -LiteralPath $upx)) {
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $archive = Join-Path $cache "upx-$version-win64.zip"
        Invoke-WebRequest "https://github.com/upx/upx/releases/download/v$version/upx-$version-win64.zip" -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive).Hash -ne $archiveHash) { throw 'UPX archive checksum mismatch.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force
    }
    if ((Get-FileHash -LiteralPath $upx).Hash -ne $executableHash) { throw 'UPX executable checksum mismatch.' }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

foreach ($inputPath in $Path) {
    $binary = (Get-Item -LiteralPath $inputPath -ErrorAction Stop).FullName
    # This also makes incremental builds and packaging already signed, packed
    # outputs idempotent: never rewrite them or invalidate their signature.
    & $upx --no-env -t $binary *> $null
    if ($LASTEXITCODE -eq 0) { Write-Host "UPX verified: $binary"; continue }
    if ($VerifyOnly) { throw "UPX integrity check failed: $binary" }
    if ((Get-AuthenticodeSignature -LiteralPath $binary).SignerCertificate) {
        throw "Rebuild this signed, unpacked binary before packing (MSBuild /t:Rebuild or CMake --clean-first): $binary"
    }
    $temporary = "$binary.upx-$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        & $upx --no-env --best --strip-relocs=0 --compress-icons=0 -o $temporary $binary
        if ($LASTEXITCODE -ne 0) { throw "UPX compression failed: $binary" }
        & $upx --no-env -t $temporary
        if ($LASTEXITCODE -ne 0) { throw "UPX integrity check failed: $temporary" }
        $unpacked = Join-Path (Split-Path -Parent $binary) 'unpacked'
        New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
        Copy-Item -LiteralPath $binary -Destination $unpacked -Force
        $map = [IO.Path]::ChangeExtension($binary, '.map')
        if (Test-Path -LiteralPath $map) { Copy-Item -LiteralPath $map -Destination $unpacked -Force }
        Move-Item -LiteralPath $temporary -Destination $binary -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
# A successful script must not leak a prior native tool's not-packed exit code.
$global:LASTEXITCODE = 0
