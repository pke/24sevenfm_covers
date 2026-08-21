# serve_site.ps1 - the local twin of deploy-site.yml: render site\ into www\ exactly the
# way the workflow does (assets of the newest GitHub release, versions from filenames),
# then serve www\ on localhost. One command turns an uncommitted site\ edit into a
# browsable page - so changes get eyes on them BEFORE a push spends a deploy + canary run.
#
#   installer\serve_site.ps1              render + serve on http://localhost:8099/
#   installer\serve_site.ps1 -NoRender    initially serve www\ as-is; still watch site\
#   installer\serve_site.ps1 -ApiOrigin http://localhost:3000
#                                          use a separately running local API
#   installer\serve_site.ps1 -NoWatch     serve without watching site\ (automation/tests)
#
# Ctrl+C stops it. Everything is served with Cache-Control: no-store - a local preview
# must always show the file on disk, never a cached yesterday.
# If binding fails with "port reserved": an HttpListener holds its port via the
# http.sys kernel driver, so a still-running previous instance shows up as System/
# PID 4 in netstat AND as an excluded range in netsh - find it via
# netsh http show servicestate view=requestq verbose=yes (lists the owning PID).
param(
    [int]$Port = 8099,
    [switch]$NoRender,
    [switch]$NoWatch,
    [string]$ApiOrigin = '',
    [string]$Repo = 'pke/24sevenfm_covers',
    [string]$WebRoot = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$www  = if ($WebRoot) { [IO.Path]::GetFullPath($WebRoot) } else { Join-Path $root 'www' }
. (Join-Path $here 'http_response.ps1')

$productionApiOrigin = 'https://24covers-api.vercel.app'
$normalizedApiOrigin = ''
if ($ApiOrigin) {
    $apiUri = $null
    if (-not [uri]::TryCreate($ApiOrigin, [UriKind]::Absolute, [ref]$apiUri) -or
            $apiUri.Scheme -notin @('http', 'https') -or $apiUri.UserInfo) {
        throw 'serve_site: -ApiOrigin must be an absolute HTTP(S) origin without credentials or a path.'
    }
    $normalizedApiOrigin = $apiUri.GetLeftPart([UriPartial]::Authority)
    if ($normalizedApiOrigin -ne $ApiOrigin.TrimEnd('/')) {
        throw 'serve_site: -ApiOrigin must be an absolute HTTP(S) origin without credentials or a path.'
    }
}

function Use-LocalApiOrigin([string]$PlayerHtml) {
    if (-not $normalizedApiOrigin) { return $PlayerHtml }
    if ($PlayerHtml.Contains($productionApiOrigin)) {
        return $PlayerHtml.Replace($productionApiOrigin, $normalizedApiOrigin)
    }
    if ($PlayerHtml.Contains($normalizedApiOrigin)) { return $PlayerHtml }
    throw 'serve_site: player.html contains neither the production nor the configured local API origin.'
}

$assets = if (-not $NoRender) {
    # Same asset source as deploy-site.yml: the newest release. Anonymous REST call - the
    # repo is public and the render only needs names + sizes.
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" `
                             -Headers @{ 'User-Agent' = 'serve_site' }
    @($rel.assets | ForEach-Object { @{ name = $_.name; size = $_.size } })
} else {
    # Watching still needs stable artifact metadata for later renders. Reuse the files
    # already present in www instead of turning -NoRender into an unexpected network call.
    @(Get-ChildItem -LiteralPath (Join-Path $www 'downloads') -File -ErrorAction Stop |
        Where-Object { $_.Name -notlike '*.sha256' } |
        ForEach-Object { @{ name = $_.Name; size = $_.Length } })
}
$assetsJson = ConvertTo-Json $assets -Compress
if (-not $NoRender) {
    & (Join-Path $here 'render_site.ps1') -Assets $assetsJson -ApiOrigin $normalizedApiOrigin
}

# A local API lives on a different port from this static server. Rewrite only the
# generated preview: committed site\player.html must keep pointing at production.
if ($NoRender -and $normalizedApiOrigin) {
    $playerPath = Join-Path $www 'player.html'
    $player = [IO.File]::ReadAllText($playerPath)
    $player = Use-LocalApiOrigin $player
    [IO.File]::WriteAllText($playerPath, $player, (New-Object Text.UTF8Encoding($false)))
}
if ($normalizedApiOrigin) {
    Write-Host "  Local API: $normalizedApiOrigin" -ForegroundColor Cyan
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'; '.json' = 'application/json'
    '.png'  = 'image/png'; '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'
    '.svg'  = 'image/svg+xml'; '.txt' = 'text/plain; charset=utf-8'; '.xml' = 'application/xml'
    '.webmanifest' = 'application/manifest+json'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")   # localhost prefix needs no admin/URL-ACL
$watchProcess = $null
$watchStateDirectory = ''

try {
    $listener.Start()

    if (-not $NoWatch) {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        $watchStateDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot `
            ("24covers-site-watch-" + [guid]::NewGuid())))
        if (-not $watchStateDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'serve_site: could not create a safe watcher state directory.'
        }
        New-Item -ItemType Directory -Path $watchStateDirectory | Out-Null
        $assetsPath = Join-Path $watchStateDirectory 'assets.json'
        [IO.File]::WriteAllText($assetsPath, $assetsJson, [Text.UTF8Encoding]::new($false))
        $watchStdout = Join-Path $watchStateDirectory 'stdout.log'
        $watchStderr = Join-Path $watchStateDirectory 'stderr.log'
        $powerShellPath = (Get-Process -Id $PID).Path
        $watchScript = Join-Path $here 'watch_site.ps1'
        $watchArguments = "-NoProfile -File `"$watchScript`" -AssetsPath `"$assetsPath`" " +
            "-OutputDirectory `"$www`""
        if ($normalizedApiOrigin) { $watchArguments += " -ApiOrigin `"$normalizedApiOrigin`"" }
        $watchProcess = Start-Process -FilePath $powerShellPath -ArgumentList $watchArguments `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $watchStdout `
            -RedirectStandardError $watchStderr
    }

    Write-Host "Serving $www on http://localhost:$Port/  (watching site\; Ctrl+C to stop)" `
        -ForegroundColor Cyan
    while ($listener.IsListening) {
        $ctx  = $listener.GetContext()
        $path = [uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if ($path -eq '') { $path = 'index.html' }
        # Resolve inside www\ only; anything traversing out of it is a 404 like any miss.
        $file = [IO.Path]::GetFullPath((Join-Path $www $path))
        $bytes = [byte[]]::new(0)
        if ($file.StartsWith($www, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
            $bytes = [IO.File]::ReadAllBytes($file)
            $ext   = [IO.Path]::GetExtension($file).ToLower()
            $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers['Cache-Control'] = 'no-store'
            # The generated tree can be replaced by another render while this server is
            # running. Never let such an overwrite reconnect a full-stack localhost run
            # to production: enforce the configured API origin on every player response.
            if ($normalizedApiOrigin -and
                    [string]::Equals($path, 'player.html', [StringComparison]::OrdinalIgnoreCase)) {
                try {
                    $player = [Text.Encoding]::UTF8.GetString($bytes)
                    $player = Use-LocalApiOrigin $player
                    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($player)
                } catch {
                    $ctx.Response.StatusCode = 500
                    $ctx.Response.ContentType = 'text/plain; charset=utf-8'
                    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(
                        'Local preview refused to serve player.html with an unconfigured API origin.')
                }
            }
        } else {
            $ctx.Response.StatusCode = 404
        }
        Send-HttpListenerResponse -Response $ctx.Response -Bytes $bytes | Out-Null
    }
} finally {
    $listener.Stop()
    if ($watchProcess -and -not $watchProcess.HasExited) {
        try { $watchProcess.Kill($true) } catch { $watchProcess.Kill() }
        $watchProcess.WaitForExit()
    }
    if ($watchStateDirectory -and
            $watchStateDirectory.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),
                [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $watchStateDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
