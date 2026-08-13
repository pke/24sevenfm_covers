# serve_site.ps1 - the local twin of deploy-site.yml: render site\ into www\ exactly the
# way the workflow does (assets of the newest GitHub release, versions from filenames),
# then serve www\ on localhost. One command turns an uncommitted site\ edit into a
# browsable page - so changes get eyes on them BEFORE a push spends a deploy + canary run.
#
#   installer\serve_site.ps1              render + serve on http://localhost:8123/
#   installer\serve_site.ps1 -NoRender    serve whatever www\ already holds
#
# Ctrl+C stops it. Everything is served with Cache-Control: no-store - a local preview
# must always show the file on disk, never a cached yesterday.
# (8123, not something rounder: Windows carves exclusion ranges out of the ephemeral
# port space - 8099 for example is OS-reserved here. netsh int ipv4 show
# excludedportrange protocol=tcp lists the no-go zones.)
param(
    [int]$Port = 8123,
    [switch]$NoRender,
    [string]$Repo = 'pke/24sevenfm_covers'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$www  = Join-Path $root 'www'

if (-not $NoRender) {
    # Same asset source as deploy-site.yml: the newest release. Anonymous REST call - the
    # repo is public and the render only needs names + sizes.
    $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" `
                             -Headers @{ 'User-Agent' = 'serve_site' }
    $assets = $rel.assets | ForEach-Object { @{ name = $_.name; size = $_.size } }
    & (Join-Path $here 'render_site.ps1') -Assets (ConvertTo-Json $assets -Compress)
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
$listener.Start()
Write-Host "Serving $www on http://localhost:$Port/  (Ctrl+C to stop)" -ForegroundColor Cyan

try {
    while ($listener.IsListening) {
        $ctx  = $listener.GetContext()
        $path = [uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if ($path -eq '') { $path = 'index.html' }
        # Resolve inside www\ only; anything traversing out of it is a 404 like any miss.
        $file = [IO.Path]::GetFullPath((Join-Path $www $path))
        if ($file.StartsWith($www, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
            $bytes = [IO.File]::ReadAllBytes($file)
            $ext   = [IO.Path]::GetExtension($file).ToLower()
            $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers['Cache-Control'] = 'no-store'
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
        $ctx.Response.Close()
    }
} finally { $listener.Stop() }
