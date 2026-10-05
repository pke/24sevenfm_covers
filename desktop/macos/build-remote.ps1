param(
    [Parameter(Mandatory)][string]$MacHost,
    [Parameter(Mandatory)][string]$MacUser,
    [Parameter(Mandatory)][string]$IdentityFile
)
$ErrorActionPreference = 'Stop'
if ($MacHost -notmatch '^[a-zA-Z0-9.-]+$' -or $MacUser -notmatch '^[a-zA-Z0-9_.-]+$') {
    throw 'Use a host/IP and the short macOS account name.'
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$identity = (Resolve-Path -LiteralPath $IdentityFile).Path
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$staging = Join-Path $root "desktop/build/mac-upload/$stamp"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$archive = Join-Path $staging 'source.tar.gz'
$list = Join-Path $staging 'files.txt'
Push-Location $root
try {
    # Include current edits/new source, never local build trees, keys or environment files.
    $files = @(git ls-files --cached --others --exclude-standard -- lib shared desktop/macos desktop/24sevenfm_covers.ico)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate source files' }
    $files = $files | Sort-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    [IO.File]::WriteAllLines($list, $files, [Text.UTF8Encoding]::new($false))
    & tar -czf $archive -T $list
    if ($LASTEXITCODE -ne 0) { throw 'Source archive failed' }
    $target = "$MacUser@$MacHost"
    $sshOptions = @('-i', $identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes')
    $remote = "dev/24sevenfm-covers-builds/$stamp"
    & ssh @sshOptions $target "mkdir -p '$remote'"
    if ($LASTEXITCODE -ne 0) { throw 'SSH preparation failed' }
    & scp @sshOptions $archive "${target}:$remote/source.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
    & ssh @sshOptions $target "cd '$remote' && tar -xzf source.tar.gz && sh desktop/macos/build-install.sh"
    if ($LASTEXITCODE -ne 0) { throw "Remote build/install failed; sources retained at ~/$remote" }
} finally { Pop-Location }
