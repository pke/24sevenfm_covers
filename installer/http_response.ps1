# Writing through HttpListener can fail after a browser navigates away or closes its
# socket. That ends one response, not the local preview server. Keep the recovery at
# the connection boundary so filesystem and programming errors still stop the server.
function Test-RecoverableResponseException([Exception] $Exception) {
    $cause = $Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    return $cause -is [System.IO.IOException] -or
        $cause -is [System.Net.HttpListenerException] -or
        $cause -is [System.Net.ProtocolViolationException]
}

function Send-HttpListenerResponse {
    param(
        [Parameter(Mandatory)] $Response,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [byte[]] $Bytes
    )

    $sent = $true
    try {
        # HttpListener otherwise decides the framing when Close() runs. Under rapid
        # browser reloads that can leave Content-Length at zero before this write and
        # abort the complete preview with "bytes exceed Content-Length". Frame every
        # response explicitly from the byte array we are about to send.
        $Response.ContentLength64 = $Bytes.LongLength
        if ($Bytes.Length -gt 0) {
            $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
        }
    } catch {
        if (Test-RecoverableResponseException $_.Exception) {
            $sent = $false
        } else {
            throw
        }
    } finally {
        try {
            $Response.Close()
        } catch {
            if (Test-RecoverableResponseException $_.Exception) {
                $sent = $false
            } else {
                throw
            }
        }
    }
    return $sent
}
