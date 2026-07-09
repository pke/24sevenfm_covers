// http_client.h - minimal dependency-free HTTP/1.1 client (plain HTTP, port 80)
//
// Works on Windows (Winsock2), iOS and Android (POSIX sockets). It only speaks
// unencrypted HTTP, which is all the 24seven.fm SOAP endpoint and cover images
// require. It reads the whole response (Connection: close), de-chunks the body
// if the server uses Transfer-Encoding: chunked, and returns status + body.
#pragma once

#include <string>

namespace ssc {

struct HttpResponse {
    int status = 0;          // HTTP status code, or 0 on transport failure
    std::string body;        // decoded response body
    std::string error;       // human readable error when status == 0
    bool ok() const { return status >= 200 && status < 300; }
};

// Performs a blocking HTTP request. `method` is e.g. "POST" or "GET".
// `body` and `contentType` are ignored for bodiless requests (pass "").
HttpResponse httpRequest(const std::string& host,
                         unsigned short port,
                         const std::string& path,
                         const std::string& method,
                         const std::string& body = std::string(),
                         const std::string& contentType = std::string(),
                         int timeoutSeconds = 20);

} // namespace ssc
