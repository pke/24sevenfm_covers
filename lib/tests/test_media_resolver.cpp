#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "../media_resolver.h"

using namespace ssc;

TEST_CASE("native resolver validates optional title logos independently and rechecks CDN URLs") {
    std::string body = R"({"logo":{"url":"https://assets.fanart.tv/fanart/title.png","source":"fanart"}})";
    unsigned downloads = 0;
    MediaResolverConfig config;
    config.transport = [&](const std::string& host, unsigned short, const std::string&,
            const std::string&, const std::string&, const std::string&, int) {
        HttpResponse response; response.status = 200;
        if (host == "assets.fanart.tv") { ++downloads; response.body = "image"; }
        else response.body = body;
        return response;
    };
    MediaResolver resolver(config);
    MediaRequest request; request.album = "Pirates";
    auto result = resolver.resolve(request);
    CHECK(result.status == MediaResult::Hit);
    CHECK(result.titleLogoSource == "fanart");
    std::string bytes;
    CHECK(resolver.downloadTitleLogo(result, bytes));
    CHECK(bytes == "image");
    result.titleLogoUrl = "https://evil.test/title.png";
    CHECK_FALSE(resolver.downloadTitleLogo(result, bytes));
    CHECK(bytes.empty()); CHECK(downloads == 1);
    body = R"({"logo":{"url":"https://evil.test/title.png","source":"fanart"},"metadata":{"album":"Pirates","track":"Cue","artist":"Hans Zimmer"}})";
    result = resolver.resolve(request);
    CHECK(result.titleLogoUrl.empty());
    CHECK(result.hasMetadata);
    CHECK(result.album == "Pirates");
}

TEST_CASE("native resolver percent-encodes raw UTF-8 metadata") {
    CHECK(urlEncode("A+B & Caf\xC3\xA9") == "A%2BB%20%26%20Caf%C3%A9");
}

TEST_CASE("native resolver sends bounded physical viewport hints only for artwork") {
    std::string path;
    MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string& p,
            const std::string&, const std::string&, const std::string&, int) {
        path = p; HttpResponse r; r.status = 200; r.body = "{}"; return r;
    };
    MediaRequest request; request.album = "Interstellar"; request.width = 3840; request.height = 2160;
    MediaResolver(config).resolve(request);
    CHECK(path.find("&width=3840&height=2160") != std::string::npos);
    CHECK(path.find("orientation=") == std::string::npos);
    CHECK(path.find("logos=") == std::string::npos);
    request.includeTitleLogo = true;
    MediaResolver(config).resolve(request);
    CHECK(path.find("&logos=1") != std::string::npos);
    request.includeArt = false;
    MediaResolver(config).resolve(request);
    CHECK(path.find("logos=") == std::string::npos);
    request.includeArt = true;
    request.width = 2160; request.height = 3840;
    MediaResolver(config).resolve(request);
    CHECK(path.find("&width=2160&height=3840") != std::string::npos);
    CHECK(path.find("orientation=") == std::string::npos);
    request.includeArt = false; MediaResolver(config).resolve(request);
    CHECK(path.find("&width=") == std::string::npos);
    request.includeArt = true; request.height = 0;
    CHECK(MediaResolver(config).resolve(request).error == "invalid native media request");
    request.height = 2160; request.width = 8193;
    CHECK(MediaResolver(config).resolve(request).error == "invalid native media request");
}

TEST_CASE("native metadata limits match JavaScript UTF-16 units, not UTF-8 bytes") {
    std::string bmp, astral;
    for (int i = 0; i < 180; ++i) bmp += "\xE9\x9F\xB3";
    for (int i = 0; i < 90; ++i) astral += "\xF0\x9F\x8E\xB5";
    unsigned requests = 0;
    MediaResolverConfig config;
    config.transport = [&](const std::string&, unsigned short, const std::string&,
            const std::string&, const std::string&, const std::string&, int) {
        ++requests;
        HttpResponse r; r.status = 200;
        r.body = "{\"metadata\":{\"album\":\"" + bmp + "\",\"track\":\"\",\"artist\":\"" + astral + "\"}}";
        return r;
    };
    MediaRequest request; request.album = bmp;
    auto result = MediaResolver(config).resolve(request);
    CHECK(result.status == MediaResult::Miss);
    CHECK(result.hasMetadata);
    CHECK(result.album == bmp); CHECK(result.artist == astral);
    request.album = astral;
    CHECK(MediaResolver(config).resolve(request).hasMetadata);
    CHECK(requests == 2);
    for (const auto& invalid : {bmp + "a", astral + "a", std::string("\xC0\xAF"),
            std::string("\xED\xA0\x80"), std::string("\xF4\x90\x80\x80"), std::string("\xE9\x9F")}) {
        request.album = invalid;
        CHECK(MediaResolver(config).resolve(request).status == MediaResult::Failure);
    }
    CHECK(requests == 2);
}

TEST_CASE("invalid canonical metadata preserves all raw fallback fields atomically") {
    MediaResolverConfig config;
    config.transport = [](const std::string&, unsigned short, const std::string&,
            const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 200;
        r.body = R"({"metadata":{"album":"Normalized","track":"Valid","artist":42}})";
        return r;
    };
    MediaRequest request; request.album = "Raw"; request.track = "Raw track"; request.artist = "Raw artist";
    auto result = MediaResolver(config).resolve(request);
    CHECK(result.status == MediaResult::Failure); CHECK_FALSE(result.hasMetadata);
    CHECK(result.album == request.album); CHECK(result.track == request.track); CHECK(result.artist == request.artist);
}

TEST_CASE("native resolver accepts exactly the web player's artwork hosts") {
    CHECK(trustedBackdropUrl("https://image.tmdb.org/t/p/w1280/a.jpg", "tmdb"));
    CHECK(trustedBackdropUrl("https://assets.fanart.tv/fanart/a.jpg", "fanart"));
    CHECK(trustedBackdropUrl("https://static.tvmaze.com/uploads/a.jpg", "tvmaze"));
    CHECK(trustedBackdropUrl("https://cdn2.steamgriddb.com/hero/a.png", "steamgriddb"));
    CHECK_FALSE(trustedBackdropUrl("http://image.tmdb.org/a.jpg", "tmdb"));
    CHECK_FALSE(trustedBackdropUrl("https://image.tmdb.org.evil.test/a.jpg", "tmdb"));
    CHECK_FALSE(trustedBackdropUrl("https://image.tmdb.org@evil.test/a.jpg", "tmdb"));
    CHECK_FALSE(trustedBackdropUrl("https://static.tvmaze.com/a.jpg", "tmdb"));
    CHECK_FALSE(trustedBackdropUrl("https://127.0.0.1/a.jpg", "fanart"));
}

TEST_CASE("native resolver sends raw metadata and parses art plus sanitized ratings") {
    std::string requestedHost, requestedPath;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string& host, unsigned short, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        requestedHost = host; requestedPath = path;
        HttpResponse r; r.status = 200;
        r.body = R"JSON({
          "media":{"id":1,"title":"Am\u00e9lie","type":"movie"},
          "metadata":{"album":"The Am\u00e9lie Score","track":"A & B","artist":"Composer"},
          "backdrop":"https://image.tmdb.org/t/p/w1280/a.jpg","source":"tmdb",
          "tint":[12,34,56],
          "certifications":[
            {"country":"DE","system":"FSK","rating":"12","label":"FSK 12"},
            {"country":"US","system":"MPA","rating":"PG-13","label":"PG-13"},
            {"country":"XX","system":"Bad","rating":"X","label":"X"}
          ]})JSON";
        return r;
    };
    MediaResolver resolver(cfg);
    MediaRequest request;
    request.album = "Am\xC3\xA9lie + Score";
    request.track = "A & B";
    request.artist = "Composer";
    request.providers = "tmdb,tvmaze";
    MediaResult result = resolver.resolve(request);
    CHECK(result.status == MediaResult::Hit);
    CHECK(result.backdropUrl == "https://image.tmdb.org/t/p/w1280/a.jpg");
    CHECK(result.source == "tmdb");
    CHECK(result.mediaTitle == "Am\xC3\xA9lie");
    CHECK(result.mediaType == "movie");
    CHECK(result.album == "The Am\xC3\xA9lie Score");
    CHECK(result.track == "A & B");
    CHECK(result.artist == "Composer");
    CHECK(result.hasTint);
    CHECK(result.tint[0] == 12); CHECK(result.tint[1] == 34); CHECK(result.tint[2] == 56);
    REQUIRE(result.certifications.size() == 2);
    CHECK(result.certifications[0].rating == "12");
    CHECK(result.certifications[1].rating == "PG-13");
    CHECK(requestedHost == "24covers-api.vercel.app");
    CHECK(requestedPath.find("/api/media?") == 0);
    CHECK(requestedPath.find("resolver_version=" + cfg.resolverVersion) != std::string::npos);
    CHECK(requestedPath.find("album=Am%C3%A9lie%20%2B%20Score") != std::string::npos);
    CHECK(requestedPath.find("track=A%20%26%20B") != std::string::npos);
    CHECK(requestedPath.find("providers=tmdb%2Ctvmaze") != std::string::npos);
    CHECK(requestedPath.find("ratings=DE%2CUS") != std::string::npos);
}

TEST_CASE("ratings-only requests skip artwork and retain TV descriptors") {
    std::string requestedPath;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string&, unsigned short, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        requestedPath = path;
        HttpResponse r; r.status = 200;
        r.body = R"JSON({"media":{"id":2,"title":"Series","type":"tv"},
          "backdrop":null,"source":null,"tint":[255,255,255],
          "certifications":[{"country":"US","system":"TV Parental Guidelines",
          "rating":"TV-14","label":"TV-14","descriptors":["V","bad","L"]}]})JSON";
        return r;
    };
    MediaRequest request; request.album = "Series"; request.includeArt = false;
    request.ratingCountries = "US";
    MediaResult result = MediaResolver(cfg).resolve(request);
    CHECK(result.status == MediaResult::Hit);
    CHECK(result.backdropUrl.empty());
    REQUIRE(result.certifications.size() == 1);
    REQUIRE(result.certifications[0].descriptors.size() == 2);
    CHECK(result.certifications[0].descriptors[0] == "L");
    CHECK(result.certifications[0].descriptors[1] == "V");
    CHECK(requestedPath.find("art=0") != std::string::npos);
    CHECK(requestedPath.find("providers=tmdb") != std::string::npos);
    CHECK(requestedPath.find("orientation=") == std::string::npos);
}

TEST_CASE("fanart personal key is sent only for enabled fanart artwork") {
    std::string requestedPath;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string&, unsigned short, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        requestedPath = path;
        HttpResponse r; r.status = 200;
        r.body = R"JSON({"media":null,"backdrop":null,"source":null,"certifications":[]})JSON";
        return r;
    };
    MediaRequest request; request.album = "Movie";
    request.fanartClientKey = "personal + key";
    MediaResolver(cfg).resolve(request);
    CHECK(requestedPath.find("client_key=personal%20%2B%20key") != std::string::npos);

    request.providers = "tmdb,tvmaze";
    MediaResolver(cfg).resolve(request);
    CHECK(requestedPath.find("client_key=") == std::string::npos);
    request.includeArt = false;
    MediaResolver(cfg).resolve(request);
    CHECK(requestedPath.find("client_key=") == std::string::npos);
}

TEST_CASE("fanart personal-key check mirrors the web player's direct probe") {
    std::string requestedHost, requestedPath;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string& host, unsigned short port, const std::string& path,
                        const std::string&, const std::string&, const std::string&, int) {
        requestedHost = host; requestedPath = path;
        CHECK(port == 443);
        HttpResponse r; r.status = 200; r.body = R"JSON({"tmdb_id":"27205"})JSON";
        return r;
    };
    CHECK(MediaResolver(cfg).checkFanartClientKey("key + one").status
          == FanartKeyCheckStatus::Accepted);
    CHECK(requestedHost == "webservice.fanart.tv");
    CHECK(requestedPath == "/v3/movies/27205?client_key=key%20%2B%20one");

    cfg.transport = [](const std::string&, unsigned short, const std::string&,
                       const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 401; return r;
    };
    CHECK(MediaResolver(cfg).checkFanartClientKey("rejected").status
          == FanartKeyCheckStatus::Rejected);
    CHECK(MediaResolver(cfg).checkFanartClientKey("bad\r\nkey").status
          == FanartKeyCheckStatus::Invalid);
}

TEST_CASE("native TV descriptors use the web player's rating-specific allowlist") {
    MediaResolverConfig cfg;
    cfg.transport = [](const std::string&, unsigned short, const std::string&,
                       const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 200;
        r.body = R"JSON({"media":{"title":"Series","type":"tv"},"backdrop":null,
          "source":null,"certifications":[
            {"country":"US","system":"TV Parental Guidelines","rating":"TV-G",
             "label":"TV-G","descriptors":["D","L","S","V","FV"]}]})JSON";
        return r;
    };
    MediaRequest request; request.album = "Series"; request.includeArt = false;
    MediaResult result = MediaResolver(cfg).resolve(request);
    REQUIRE(result.certifications.size() == 1);
    CHECK(result.certifications[0].descriptors.empty());
}

TEST_CASE("resolver rejects control bytes before any native HTTP request") {
    int calls = 0;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string&, unsigned short, const std::string&,
                        const std::string&, const std::string&, const std::string&, int) {
        ++calls; return HttpResponse();
    };
    MediaRequest request; request.album = "Good\r\nInjected";
    CHECK(MediaResolver(cfg).resolve(request).status == MediaResult::Failure);
    CHECK(calls == 0);
}

TEST_CASE("cacheable resolver miss is distinct from retryable endpoint failure") {
    int calls = 0;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string&, unsigned short, const std::string&,
                        const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r;
        if (++calls == 1) {
            r.status = 200;
            r.body = R"JSON({"media":null,"backdrop":null,"source":null,"tint":[255,255,255],"certifications":[]})JSON";
        } else { r.status = 503; }
        return r;
    };
    MediaRequest request; request.album = "Unknown";
    CHECK(MediaResolver(cfg).resolve(request).status == MediaResult::Miss);
    MediaResult failure = MediaResolver(cfg).resolve(request);
    CHECK(failure.status == MediaResult::Failure);
    CHECK(failure.error.find("503") != std::string::npos);
}

TEST_CASE("validated stream metadata survives missing normalized metadata and endpoint failure") {
    int calls = 0;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string&, unsigned short, const std::string&,
                        const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r;
        if (++calls == 1) {
            r.status = 200;
            r.body = R"JSON({"media":null,"backdrop":null,"source":null,"certifications":[]})JSON";
        } else {
            r.status = 404;
        }
        return r;
    };
    MediaRequest request;
    request.album = "Abyss, The";
    request.track = "Finale";
    request.artist = "Alan Silvestri";

    const MediaResult oldDeployment = MediaResolver(cfg).resolve(request);
    CHECK(oldDeployment.status == MediaResult::Miss);
    CHECK(oldDeployment.album == request.album);
    CHECK(oldDeployment.track == request.track);
    CHECK(oldDeployment.artist == request.artist);

    const MediaResult unavailable = MediaResolver(cfg).resolve(request);
    CHECK(unavailable.status == MediaResult::Failure);
    CHECK(unavailable.album == request.album);
    CHECK(unavailable.track == request.track);
    CHECK(unavailable.artist == request.artist);
}

TEST_CASE("untrusted resolver artwork fails closed") {
    MediaResolverConfig cfg;
    cfg.transport = [](const std::string&, unsigned short, const std::string&,
                       const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 200;
        r.body = R"JSON({"media":{"id":1,"title":"X","type":"movie"},
          "backdrop":"https://evil.test/a.jpg","source":"tmdb","tint":[1,2,3]})JSON";
        return r;
    };
    MediaRequest request; request.album = "X";
    MediaResult result = MediaResolver(cfg).resolve(request);
    CHECK(result.status == MediaResult::Failure);
    CHECK(result.error.find("untrusted") != std::string::npos);
}

TEST_CASE("queue credit accepts only the selected station album URL") {
    CHECK(trustedAlbumPageUrl(
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=B000000001",
        "streamingsoundtracks.com"));
    CHECK_FALSE(trustedAlbumPageUrl(
        "https://evil.test/modules.php?name=Album&asin=B000000001",
        "streamingsoundtracks.com"));

    MediaResolverConfig cfg;
    cfg.transport = [](const std::string&, unsigned short, const std::string& path,
                       const std::string&, const std::string&, const std::string&, int) {
        HttpResponse r; r.status = 200;
        if (path.find("/api/credit?") == 0) r.body = R"({"artist":"Queue Composer"})";
        return r;
    };
    bool success = false;
    const std::string artist = MediaResolver(cfg).resolveCredit("Album",
        "https://streamingsoundtracks.com/modules.php?name=Album&asin=B000000001",
        "streamingsoundtracks.com", &success);
    CHECK(success);
    CHECK(artist == "Queue Composer");
}

TEST_CASE("backdrop download revalidates the URL before direct CDN access") {
    std::string host, path;
    MediaResolverConfig cfg;
    cfg.transport = [&](const std::string& h, unsigned short, const std::string& p,
                        const std::string&, const std::string&, const std::string&, int) {
        host = h; path = p;
        HttpResponse r; r.status = 200; r.body = "png-bytes"; return r;
    };
    MediaResult media; media.status = MediaResult::Hit; media.source = "tvmaze";
    media.backdropUrl = "https://static.tvmaze.com/uploads/a.png";
    std::string bytes;
    REQUIRE(MediaResolver(cfg).downloadBackdrop(media, bytes));
    CHECK(bytes == "png-bytes");
    CHECK(host == "static.tvmaze.com");
    CHECK(path == "/uploads/a.png");
}
