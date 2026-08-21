# watch_site.ps1 - rebuild the local www preview whenever tokenised site sources change.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AssetsPath,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$ApiOrigin = '',
    [ValidateRange(50, 5000)][int]$DebounceMilliseconds = 250
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$sourceDirectory = Join-Path $root 'site'
$output = [IO.Path]::GetFullPath($OutputDirectory)
$assetsFile = [IO.Path]::GetFullPath($AssetsPath)

if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
    throw "watch_site: source directory does not exist: $sourceDirectory"
}
if (-not (Test-Path -LiteralPath $assetsFile -PathType Leaf)) {
    throw "watch_site: asset metadata does not exist: $assetsFile"
}
$assetsJson = [IO.File]::ReadAllText($assetsFile)

$normalizedApiOrigin = ''
if ($ApiOrigin) {
    $apiUri = $null
    if (-not [uri]::TryCreate($ApiOrigin, [UriKind]::Absolute, [ref]$apiUri) -or
            $apiUri.Scheme -notin @('http', 'https') -or $apiUri.UserInfo) {
        throw 'watch_site: ApiOrigin must be an absolute HTTP(S) origin without credentials or a path.'
    }
    $normalizedApiOrigin = $apiUri.GetLeftPart([UriPartial]::Authority)
    if ($normalizedApiOrigin -ne $ApiOrigin.TrimEnd('/')) {
        throw 'watch_site: ApiOrigin must be an absolute HTTP(S) origin without credentials or a path.'
    }
}

function Render-Preview {
    & (Join-Path $here 'render_site.ps1') -Assets $assetsJson -OutputDirectory $output `
        -ApiOrigin $normalizedApiOrigin
}

$watcher = [IO.FileSystemWatcher]::new($sourceDirectory)
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::DirectoryName `
    -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size
$eventPrefix = "24covers-site-watch-$([guid]::NewGuid())"
$eventNames = @('Changed', 'Created', 'Deleted', 'Renamed')
$subscriptions = @($eventNames | ForEach-Object {
    Register-ObjectEvent -InputObject $watcher -EventName $_ `
        -SourceIdentifier "$eventPrefix.$_"
})
$watcher.EnableRaisingEvents = $true

Write-Host "Watching $sourceDirectory for local-preview changes" -ForegroundColor DarkCyan
try {
    while ($true) {
        $event = Wait-Event
        if (-not $event.SourceIdentifier.StartsWith($eventPrefix,
                [StringComparison]::Ordinal)) { continue }
        Remove-Event -EventIdentifier $event.EventIdentifier

        # Editors commonly save through several write/rename events. Wait for a quiet
        # window and drain the queue so the renderer sees one complete source tree.
        do {
            Start-Sleep -Milliseconds $DebounceMilliseconds
            $queued = @(Get-Event | Where-Object {
                $_.SourceIdentifier.StartsWith($eventPrefix, [StringComparison]::Ordinal)
            })
            foreach ($queuedEvent in $queued) {
                Remove-Event -EventIdentifier $queuedEvent.EventIdentifier
            }
        } while ($queued.Count)

        try {
            Render-Preview
            Write-Host "  Source changed; www preview rendered at $(Get-Date -Format T)" `
                -ForegroundColor DarkCyan
        } catch {
            # A malformed half-save must not kill watching. The next editor event retries.
            Write-Warning "Local preview render failed: $($_.Exception.Message)"
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    foreach ($subscription in $subscriptions) {
        Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    }
    Get-Event | Where-Object {
        $_.SourceIdentifier.StartsWith($eventPrefix, [StringComparison]::Ordinal)
    } | Remove-Event -ErrorAction SilentlyContinue
    $watcher.Dispose()
}
