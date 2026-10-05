param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory=Join-Path $repo 'desktop/build/iina-prototypes' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$assets=Get-ChildItem -LiteralPath (Join-Path $repo 'www/downloads') -File | ForEach-Object { @{name=$_.Name;size=$_.Length} }
$rendered=Join-Path $OutputDirectory 'rendered-player'
& (Join-Path $repo 'installer/render_site.ps1') -Assets ($assets|ConvertTo-Json -Compress) -OutputDirectory $rendered
$bundle=Join-Path $OutputDirectory '24sevenfm-covers-prototypes.iinaplugin'
New-Item -ItemType Directory -Force -Path $bundle | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '24sevenfm-covers-prototypes.iinaplugin/Info.json'),(Join-Path $PSScriptRoot '24sevenfm-covers-prototypes.iinaplugin/main.js') -Destination $bundle
$web=Join-Path $bundle 'webplayer'
New-Item -ItemType Directory -Force -Path $web | Out-Null
foreach($name in @('css','js','img')) { Copy-Item -LiteralPath (Join-Path $rendered $name) -Destination $web -Recurse -Force }
$html=Get-Content -LiteralPath (Join-Path $rendered 'player.html') -Raw
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '24sevenfm-covers-prototypes.iinaplugin/webview-diagnostics.js') -Destination $web
foreach($surface in @('sidebar','overlay')) {
  $page=$html.Replace('<head>',('<head><meta name="iina-surface" content="'+$surface+'"><script src="webview-diagnostics.js"></script>'))
  [IO.File]::WriteAllText((Join-Path $web "$surface.html"),$page,[Text.UTF8Encoding]::new($false))
}
Write-Output $bundle
