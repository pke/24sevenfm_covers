# Writing through HttpListener can fail after a browser navigates away or closes its
# socket. That ends one response, not the local preview server. Keep the recovery at
# the connection boundary so filesystem and programming errors still stop the server.
function Send-HttpListenerResponse {
    param(
        [Parameter(Mandatory)] $Response,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [byte[]] $Bytes
    )

    $sent = $true
    try {
        if ($Bytes.Length -gt 0) {
            $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
        }
    } catch [System.IO.IOException], [System.Net.HttpListenerException] {
        $sent = $false
    } finally {
        try {
            $Response.Close()
        } catch [System.IO.IOException], [System.Net.HttpListenerException] {
            $sent = $false
        }
    }
    return $sent
}
