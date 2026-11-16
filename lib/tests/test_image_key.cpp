#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../../shared/image_key.h"

using ssc::ImageKey;

TEST_CASE("image keys identify content, not storage") {
    const std::string a(1000, 'a'), b(1000, 'b');
    CHECK(ssc::imageKey(a) == ssc::imageKey(std::string(1000, 'a')));
    CHECK(ssc::imageKey(a) != ssc::imageKey(b));
    CHECK(ssc::imageKey(a) != ssc::imageKey(std::string(999, 'a')));   // size participates
    std::string tail = a; tail.back() = 'x';
    CHECK(ssc::imageKey(a) != ssc::imageKey(tail));                    // non-multiple-of-8 tail
    CHECK(ssc::imageKey(std::string()).empty());
}

TEST_CASE("the key cache hashes each shared image once") {
    ssc::ImageKeyCache cache;
    auto first = std::make_shared<const std::string>(std::string(4096, 'q'));
    auto twin = std::make_shared<const std::string>(*first);
    const ImageKey key = cache.get(first);
    for (int i = 0; i < 100; ++i) CHECK(cache.get(first) == key);
    CHECK(cache.hashes() == 1);
    CHECK(cache.get(twin) == key); // equal content, distinct reference: same identity
    CHECK(cache.hashes() == 2);
    CHECK(cache.get(nullptr).empty());
}

TEST_CASE("an expired image never aliases a new one at a recycled address") {
    ssc::ImageKeyCache cache;
    for (int i = 0; i < 1000; ++i) {
        auto image = std::make_shared<const std::string>(std::string(64, char('a' + i % 26)) + std::to_string(i));
        CHECK(cache.get(image) == ssc::imageKey(*image));
    }
    CHECK(cache.hashes() == 1000);
    CHECK(cache.size() <= 257); // expired entries are pruned
}
