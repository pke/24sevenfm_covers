#include "http_client.h"

#include <cctype>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>

#if defined(_WIN32)
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32")
    typedef SOCKET socket_t;
    static const socket_t kInvalidSocket = INVALID_SOCKET;
#else
    #include <sys/types.h>
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <netdb.h>
    #include <unistd.h>
    #include <sys/time.h>
    #include <sys/utsname.h>
    typedef int socket_t;
    static const socket_t kInvalidSocket = -1;
#endif

namespace ssc {
namespace {

// One-time Winsock initialisation. No-op on POSIX platforms.
struct SocketPlatform {
    SocketPlatform() {
#if defined(_WIN32)
        WSADATA wsa;
        WSAStartup(MAKEWORD(2, 2), &wsa);
#endif
    }
    ~SocketPlatform() {
#if defined(_WIN32)
        WSACleanup();
#endif
    }
};

void ensurePlatform() {
    // Constructed on first use, destroyed at process exit.
    static SocketPlatform platform;
    (void)platform;
}

// A short OS/architecture descriptor for the User-Agent, e.g.
// "Windows NT 10.0.26100; Win64; x64" or "Linux 5.15.0; aarch64".
std::string osPlatform() {
#if defined(_WIN32)
    // GetVersionEx reports 6.2 for Win8+ unless the app is manifested; RtlGetVersion
    // (ntdll) returns the true version regardless, which is what we want here.
    std::string ver = "Windows";
    typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW*);
    if (HMODULE nt = GetModuleHandleW(L"ntdll.dll")) {
        if (auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(nt, "RtlGetVersion"))) {
            OSVERSIONINFOW vi;
            std::memset(&vi, 0, sizeof(vi));
            vi.dwOSVersionInfoSize = sizeof(vi);
            if (fn(&vi) == 0) {
                char buf[64];
                std::snprintf(buf, sizeof(buf), "Windows NT %lu.%lu.%lu",
                              vi.dwMajorVersion, vi.dwMinorVersion, vi.dwBuildNumber);
                ver = buf;
            }
        }
    }
#if defined(_WIN64)
    ver += "; Win64; x64";
#else
    // 32-bit build: distinguish native 32-bit Windows from WOW64 (on 64-bit Windows).
    BOOL wow = FALSE;
    typedef BOOL(WINAPI * IsWow64Fn)(HANDLE, PBOOL);
    if (HMODULE k = GetModuleHandleW(L"kernel32.dll")) {
        if (auto fn = reinterpret_cast<IsWow64Fn>(GetProcAddress(k, "IsWow64Process")))
            fn(GetCurrentProcess(), &wow);
    }
    ver += wow ? "; WOW64" : "; Win32";
#endif
    return ver;
#else
    struct utsname u;
    if (uname(&u) == 0)
        return std::string(u.sysname) + " " + u.release + "; " + u.machine;
    return "Unknown";
#endif
}

// Built once; the station serves the same content regardless, but a descriptive
// User-Agent helps the operator see who's polling.
const std::string& userAgent() {
    static const std::string ua = "24seven.fm-covers/1.0 (" + osPlatform() + ")";
    return ua;
}

void closeSocket(socket_t s) {
#if defined(_WIN32)
    closesocket(s);
#else
    close(s);
#endif
}

void setRecvTimeout(socket_t s, int seconds) {
    if (seconds <= 0) return;
#if defined(_WIN32)
    DWORD ms = static_cast<DWORD>(seconds) * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&ms), sizeof(ms));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&ms), sizeof(ms));
#else
    struct timeval tv;
    tv.tv_sec = seconds;
    tv.tv_usec = 0;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
}

bool sendAll(socket_t s, const char* data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        int n = static_cast<int>(::send(s, data + sent, static_cast<int>(len - sent), 0));
        if (n <= 0) return false;
        sent += static_cast<size_t>(n);
    }
    return true;
}

// Reads until the peer closes the connection (we always ask for Connection: close).
// Capped: the station's JSON is a few KB and covers are a few hundred KB, so a hostile
// server / MITM that streams without end can't grow this unbounded into std::bad_alloc.
std::string readAll(socket_t s) {
    static const size_t kMaxResponseBytes = 16u * 1024u * 1024u; // 16 MB ceiling
    std::string out;
    char buf[8192];
    for (;;) {
        int n = static_cast<int>(::recv(s, buf, sizeof(buf), 0));
        if (n <= 0) break;
        out.append(buf, static_cast<size_t>(n));
        if (out.size() > kMaxResponseBytes) break; // DoS guard: stop an unbounded stream
    }
    return out;
}

std::string toLower(std::string v) {
    for (char& c : v) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return v;
}

// Decodes an HTTP/1.1 chunked body.
std::string dechunk(const std::string& body) {
    std::string out;
    size_t pos = 0;
    while (pos < body.size()) {
        size_t eol = body.find("\r\n", pos);
        if (eol == std::string::npos) break;
        std::string sizeLine = body.substr(pos, eol - pos);
        // Strip any chunk extensions after ';'.
        size_t semi = sizeLine.find(';');
        if (semi != std::string::npos) sizeLine = sizeLine.substr(0, semi);
        size_t chunkSize = static_cast<size_t>(std::strtoul(sizeLine.c_str(), nullptr, 16));
        pos = eol + 2;
        if (chunkSize == 0) break;
        // Compare with subtraction (pos <= body.size() here) rather than `pos + chunkSize`,
        // which overflows for an attacker-chosen huge chunk size on 32-bit builds and would
        // skip this clamp -> pos underflows below -> infinite re-scan / unbounded growth.
        if (chunkSize > body.size() - pos) chunkSize = body.size() - pos;
        out.append(body, pos, chunkSize);
        pos += chunkSize + 2; // skip chunk data + trailing CRLF
    }
    return out;
}

} // namespace

HttpResponse httpRequest(const std::string& host,
                         unsigned short port,
                         const std::string& path,
                         const std::string& method,
                         const std::string& body,
                         const std::string& contentType,
                         int timeoutSeconds) {
    HttpResponse resp;
    ensurePlatform();

    // Resolve host. Force IPv4: the station is IPv4-only, and AF_UNSPEC can return an
    // IPv6 address first whose blocking connect() hangs for the OS default (~12s,
    // unaffected by our recv timeout) before falling back - seen as a huge first-poll
    // stall in hosts that aren't already connected to the stream (e.g. foobar at start).
    struct addrinfo hints;
    std::memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    char portStr[16];
    std::snprintf(portStr, sizeof(portStr), "%u", static_cast<unsigned>(port));

    struct addrinfo* result = nullptr;
    if (getaddrinfo(host.c_str(), portStr, &hints, &result) != 0 || !result) {
        resp.error = "DNS resolution failed for " + host;
        return resp;
    }

    socket_t sock = kInvalidSocket;
    for (struct addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
        sock = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (sock == kInvalidSocket) continue;
        setRecvTimeout(sock, timeoutSeconds);
        if (::connect(sock, ai->ai_addr, static_cast<int>(ai->ai_addrlen)) == 0) break;
        closeSocket(sock);
        sock = kInvalidSocket;
    }
    freeaddrinfo(result);

    if (sock == kInvalidSocket) {
        resp.error = "Could not connect to " + host;
        return resp;
    }

    // Build request (plain string concat - no <sstream>, keeps the static CRT small).
    std::string request;
    request.reserve(256 + body.size());
    request += method; request += ' '; request += path; request += " HTTP/1.1\r\n";
    request += "Host: "; request += host; request += "\r\n";
    request += "User-Agent: "; request += userAgent(); request += "\r\n";
    request += "Accept: */*\r\n";
    request += "Connection: close\r\n";
    if (!body.empty()) {
        if (!contentType.empty()) {
            request += "Content-Type: "; request += contentType; request += "\r\n";
        }
        request += "Content-Length: "; request += std::to_string(body.size()); request += "\r\n";
    }
    request += "\r\n";
    request += body;
    if (!sendAll(sock, request.data(), request.size())) {
        closeSocket(sock);
        resp.error = "Failed to send request";
        return resp;
    }

    std::string raw = readAll(sock);
    closeSocket(sock);

    if (raw.empty()) {
        resp.error = "Empty response";
        return resp;
    }

    // Split status line + headers from body.
    size_t headerEnd = raw.find("\r\n\r\n");
    if (headerEnd == std::string::npos) {
        resp.error = "Malformed HTTP response";
        return resp;
    }
    std::string headerBlock = raw.substr(0, headerEnd);
    std::string bodyPart = raw.substr(headerEnd + 4);

    // Parse status code from the first line: "HTTP/1.1 200 OK".
    {
        size_t sp = headerBlock.find(' ');
        if (sp != std::string::npos)
            resp.status = std::atoi(headerBlock.c_str() + sp + 1);
    }

    // Detect chunked transfer encoding.
    if (toLower(headerBlock).find("transfer-encoding: chunked") != std::string::npos)
        bodyPart = dechunk(bodyPart);

    resp.body = std::move(bodyPart);
    return resp;
}

} // namespace ssc
