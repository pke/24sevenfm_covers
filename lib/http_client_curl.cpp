// Linux native boundary: TLS trust/proxy/decoding via system libcurl.
#include "http_client.h"
#include <curl/curl.h>
#include <algorithm>
#include <cctype>
#include <mutex>

namespace ssc {
namespace {
constexpr size_t maxBytes = 16u * 1024u * 1024u;
struct Transfer {
    HttpResponse response;
    const std::atomic<bool>* cancel;
    bool oversized = false;
};
size_t receive(char* data, size_t size, size_t count, void* opaque) {
    auto& t = *static_cast<Transfer*>(opaque);
    if (t.cancel && t.cancel->load()) return 0;
    if (size && count > (maxBytes - t.response.body.size()) / size) {
        t.oversized = true; return 0;
    }
    t.response.body.append(data, size * count);
    return size * count;
}
int progress(void* opaque, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    const auto* t = static_cast<Transfer*>(opaque);
    return t->cancel && t->cancel->load() ? 1 : 0;
}
size_t header(char* data, size_t size, size_t count, void* opaque) {
    auto& r = static_cast<Transfer*>(opaque)->response;
    std::string line(data, size * count);
    const auto colon = line.find(':');
    if (colon != std::string::npos) {
        auto name = line.substr(0, colon);
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return std::tolower(c); });
        auto value = line.substr(colon + 1);
        const auto first = value.find_first_not_of(" \t\r\n");
        value = first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1);
        if (name == "cache-control") r.cacheControl = value;
        if (name == "age") r.age = value;
        if (name == "cf-cache-status") r.cacheStatus = value;
    }
    return size * count;
}
}
HttpResponse httpRequestImpl(const std::string& host, unsigned short port, const std::string& path,
    const std::string& method, const std::string& body, const std::string& type,
    int timeoutSeconds, const std::atomic<bool>* cancel) {
    Transfer t{{}, cancel};
    if (cancel && cancel->load()) { t.response.error = "cancelled"; return t.response; }
    if (!port || host.empty() || host.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-") != std::string::npos
        || path.empty() || path[0] != '/' || path.find_first_of("\r\n") != std::string::npos) {
        t.response.error = "Invalid HTTP destination"; return t.response;
    }
    static const CURLcode init = curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL* curl = init == CURLE_OK ? curl_easy_init() : nullptr;
    if (!curl) { t.response.error = "libcurl initialization failed"; return t.response; }
    const std::string url = std::string(port == 443 ? "https://" : "http://") + host + ":" + std::to_string(port) + path;
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L); // trust/redirect policy belongs to the caller
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, long(std::min(5, std::max(1, timeoutSeconds))));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, long(std::max(1, timeoutSeconds)));
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "24seven.fm-covers/1.0 (Linux; libcurl)");
    curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, "");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &t);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &t);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, progress);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &t);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
    curl_slist* headers = nullptr;
    if (!body.empty()) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, curl_off_t(body.size()));
    }
    if (!type.empty()) headers = curl_slist_append(headers, ("Content-Type: " + type).c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    const auto result = curl_easy_perform(curl);
    if (result == CURLE_OK) {
        long code = 0; double seconds = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
        curl_easy_getinfo(curl, CURLINFO_STARTTRANSFER_TIME, &seconds);
        t.response.status = int(code); t.response.headersMs = seconds * 1000;
    } else {
        t.response.body.clear();
        t.response.error = cancel && cancel->load() ? "cancelled" : t.oversized ? "response exceeds 16 MiB" : curl_easy_strerror(result);
    }
    curl_slist_free_all(headers); curl_easy_cleanup(curl);
    return t.response;
}
}
