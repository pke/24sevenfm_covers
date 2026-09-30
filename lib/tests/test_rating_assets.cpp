#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "rating_assets.h"
#include "image_probe.h"
#include "rating_fixture.h"
#ifdef _WIN32
#include <windows.h>
#endif

namespace {
ssc::Certification certification() {
    ssc::Certification value; value.country = "DE"; value.system = "FSK"; value.rating = "12";
    return value;
}
}
TEST_CASE("rating downloads use the API host and fixed versioned paths") {
    const auto cert = certification();
    const auto png = ratingFixturePng(); REQUIRE_FALSE(png.empty());
    unsigned requests = 0;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string& host, unsigned short port, const std::string& path,
            const std::string& method, const std::string&, const std::string&, int) {
        ++requests;
        CHECK(host == config.apiHost); CHECK(port == 443); CHECK(method == "GET");
        CHECK(path == ssc::ratingAssetPath(cert.country, cert.system, cert.rating));
        CHECK(path.find("/ratings/v1/") == 0);
        ssc::HttpResponse response; response.status = 200; response.body = png; return response;
    };
    const ssc::MediaResolver resolver(config);
    ssc::RatingAssetCache cache(L"");
    CHECK(cache.find(cert).empty());
    REQUIRE(cache.load(cert, resolver));
    CHECK(cache.find(cert) == png);
    REQUIRE(cache.load(cert, resolver));
    CHECK(requests == 1);
    auto unknown = cert; unknown.rating = "../../secret";
    CHECK_FALSE(cache.load(unknown, resolver));
    CHECK(cache.find(unknown).empty()); CHECK(requests == 1);
}
TEST_CASE("rating cache rejects failures, corrupt PNGs, oversize images and cancellation") {
    auto cert = certification();
    std::string body = "not an image";
    int status = 200; unsigned requests = 0;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string&,
            const std::string&, const std::string&, const std::string&, int) {
        ++requests; ssc::HttpResponse response; response.status = status; response.body = body; return response;
    };
    ssc::RatingAssetCache cache(L""); const ssc::MediaResolver resolver(config);
    CHECK_FALSE(cache.load(cert, resolver)); CHECK(cache.find(cert).empty());
    body = std::string(65537, 'x'); CHECK_FALSE(cache.load(cert, resolver));
    body = ratingFixturePng(); status = 404; CHECK_FALSE(cache.load(cert, resolver));
    status = 200;
    auto oversized = body; oversized[16] = 1; body = oversized;
    CHECK_FALSE(cache.load(cert, resolver));
    std::atomic<bool> cancel{true}; const auto before = requests;
    body = ratingFixturePng(); CHECK_FALSE(cache.load(cert, resolver, &cancel));
    CHECK(requests == before); CHECK(cache.find(cert).empty());
    CHECK(cache.load(cert, resolver)); // a failed fetch never poisons the memory cache
}
#ifdef _WIN32
TEST_CASE("rating PNGs persist across cache instances and corrupt disk entries recover") {
    wchar_t temp[MAX_PATH]; REQUIRE(GetTempPathW(MAX_PATH, temp) != 0);
    const auto dir = std::wstring(temp) + L"24covers-rating-test-" + std::to_wstring(GetCurrentProcessId());
    const auto cert = certification(); const auto png = ratingFixturePng();
    const auto url = ssc::ratingAssetPath(cert.country, cert.system, cert.rating);
    const auto name = url.substr(url.rfind('/') + 1);
    const auto file = dir + L"\\" + std::wstring(name.begin(), name.end());
    DeleteFileW(file.c_str());
    struct Cleanup { std::wstring file, dir; ~Cleanup() { DeleteFileW(file.c_str()); RemoveDirectoryW(dir.c_str()); } } cleanup{file, dir};
    unsigned requests = 0; bool online = true;
    ssc::MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string&,
            const std::string&, const std::string&, const std::string&, int) {
        ++requests; ssc::HttpResponse response; response.status = online ? 200 : 503; response.body = png; return response;
    };
    const ssc::MediaResolver resolver(config);
    { ssc::RatingAssetCache first(dir); REQUIRE(first.load(cert, resolver)); }
    online = false;
    { ssc::RatingAssetCache second(dir); REQUIRE(second.load(cert, resolver)); CHECK(second.find(cert) == png); }
    CHECK(requests == 1);
    HANDLE corrupt = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    REQUIRE(corrupt != INVALID_HANDLE_VALUE);
    DWORD written; WriteFile(corrupt, "bad", 3, &written, nullptr); CloseHandle(corrupt);
    { ssc::RatingAssetCache third(dir); CHECK_FALSE(third.load(cert, resolver)); CHECK(third.find(cert).empty()); }
    online = true;
    { ssc::RatingAssetCache fourth(dir); REQUIRE(fourth.load(cert, resolver)); CHECK(fourth.find(cert) == png); }
    CHECK(requests == 3);
}
#endif
TEST_CASE("image probe rejects a corrupt provider response") {
    CHECK_FALSE(ssc::decodableImage("not an image"));
}
