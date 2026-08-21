$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helper = Join-Path $PSScriptRoot 'http_response.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Missing response helper: $helper"
}
. $helper

class TestResponseStream {
    [string] $Failure
    [byte[]] $Written = @()

    TestResponseStream([string] $failure) { $this.Failure = $failure }

    [void] Write([byte[]] $buffer, [int] $offset, [int] $count) {
        if ($this.Failure -eq 'disconnect') {
            throw [System.IO.IOException]::new('The client closed the connection.')
        }
        if ($this.Failure -eq 'programming') {
            throw [System.InvalidOperationException]::new('Unexpected response failure.')
        }
        if ($count -gt 0) {
            $this.Written = $buffer[$offset..($offset + $count - 1)]
        }
    }
}

class TestResponse {
    [TestResponseStream] $OutputStream
    [bool] $Closed = $false

    TestResponse([string] $failure) {
        $this.OutputStream = [TestResponseStream]::new($failure)
    }

    [void] Close() { $this.Closed = $true }
}

function Assert-Test([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

$payload = [Text.Encoding]::UTF8.GetBytes('still serving')

# A browser that navigates away while a response is being written must end only that
# response. The next request in the listener loop still has to succeed.
$disconnected = [TestResponse]::new('disconnect')
$sent = Send-HttpListenerResponse -Response $disconnected -Bytes $payload
Assert-Test (-not $sent) 'a disconnected client should be reported as not sent'
Assert-Test $disconnected.Closed 'a disconnected response should still be closed'

$next = [TestResponse]::new('')
$sent = Send-HttpListenerResponse -Response $next -Bytes $payload
Assert-Test $sent 'the response after a disconnect should still be sent'
Assert-Test $next.Closed 'the successful response should be closed'
Assert-Test ([Text.Encoding]::UTF8.GetString($next.OutputStream.Written) -eq 'still serving') `
    'the successful response should contain the complete payload'

# Only expected client-disconnect I/O errors are recoverable. A programming error must
# remain visible instead of turning the local server into a silent failure loop.
$unexpected = [TestResponse]::new('programming')
$unexpectedReachedCaller = $false
try {
    Send-HttpListenerResponse -Response $unexpected -Bytes $payload | Out-Null
} catch [System.InvalidOperationException] {
    $unexpectedReachedCaller = $true
}
Assert-Test $unexpectedReachedCaller 'unexpected response errors should reach the caller'
Assert-Test $unexpected.Closed 'an unexpectedly failed response should still be closed'

Write-Host 'PASS: client disconnects do not stop the following response'
