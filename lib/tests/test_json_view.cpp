#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "../json_view.h"
#include "../mini_json.h"
#include <cstdint>

TEST_CASE("schema views preserve structure escapes and bounded output") {
    const std::string document = R"({"unknown":{"Album":"decoy"},"Al\u0062um":"Film\u0000\ud83d\ude00","rows":[{"name":"brace } and \"quote\""},null,42],"empty":{}})";
    ssc::JsonView root;
    REQUIRE(ssc::readJsonView(document, root));
    std::string text = "original";
    CHECK_FALSE(root.get("Album").text(text, 4));
    CHECK(text == "original");
    REQUIRE(root.get("Album").text(text));
    CHECK(text == std::string("Film\0\xf0\x9f\x98\x80", 9));
    CHECK_FALSE(root.get("absent").exists());
    ssc::JsonItems rows(root.get("rows")); ssc::JsonView row;
    REQUIRE(rows.next(row)); REQUIRE(row.get("name").text(text));
    CHECK(text == "brace } and \"quote\"");
    REQUIRE(rows.next(row)); CHECK(row.type == ssc::JsonView::Null);
    REQUIRE(rows.next(row)); double n = 0; REQUIRE(row.number(n)); CHECK(n == 42);
    CHECK_FALSE(rows.next(row));
    ssc::JsonItems empty(root.get("empty")); CHECK_FALSE(empty.next(row));
}
TEST_CASE("schema views reject invalid JSON including unused fields atomically") {
    const std::string valid = "{\"Album\":\"original\"}"; ssc::JsonView root;
    REQUIRE(ssc::readJsonView(valid, root));
    const std::string invalid[] = {"", "{", "[1,]", "{\"a\":1,}", "{} true", "[01]", "[1.]", "[1e+]",
        "[1e400]", "[1e-4000]", "[NaN]", "[+1]", "{\"a\":0,\"\\u0061\":1}",
        "{\"unknown\":{\"a\":1,\"a\":2}}", "{\"unknown\":\"\\uD800\"}", "[\"\\q\"]",
        "[\"\\u12\"]", std::string("[\"\xC0\x80\"]"), std::string("[\"\xED\xA0\x80\"]"),
        std::string("[\"\xF4\x90\x80\x80\"]"), std::string("[\"\n\"]"), std::string("[\"a\0b\"]", 7)};
    for (const auto& input : invalid) {
        INFO(input); CHECK_FALSE(ssc::readJsonView(input, root));
        std::string text; REQUIRE(root.get("Album").text(text)); CHECK(text == "original");
    }
}
TEST_CASE("schema views bound bytes nesting keys and collection counts") {
    const std::string oversized(ssc::kJsonResponseBytes + 1, ' '); ssc::JsonView root;
    CHECK_FALSE(ssc::readJsonView(oversized, root));
    std::string deep(25, '['); deep += '0'; deep += std::string(25, ']');
    CHECK_FALSE(ssc::readJsonView(deep, root));
    std::string array = "[";
    for (unsigned i = 0; i < 1024; ++i) array += i ? ",0" : "0";
    array += ']'; CHECK(ssc::readJsonView(array, root));
    array.insert(array.size()-1, ",0"); CHECK_FALSE(ssc::readJsonView(array, root));
    std::string object = "{";
    for (unsigned i = 0; i < 128; ++i) object += (i ? ",\"" : "\"") + std::to_string(i) + "\":0";
    object += '}'; CHECK(ssc::readJsonView(object, root));
    object.insert(object.size()-1, ",\"extra\":0"); CHECK_FALSE(ssc::readJsonView(object, root));
    const std::string longKey = "{\"" + std::string(257, 'x') + "\":0}";
    CHECK_FALSE(ssc::readJsonView(longKey, root));
}
TEST_CASE("schema numeric slices agree with existing strict decoder") {
    std::uint32_t seed = 0x982714u;
    for (unsigned i = 0; i < 5000; ++i) {
        seed = seed * 1664525u + 1013904223u;
        const std::string token = (seed & 1 ? "-" : "") + std::to_string(seed)
            + "." + std::to_string(seed >> 8) + "e" + std::to_string(static_cast<int>(seed % 600) - 300);
        ssc::JsonView view; ssc::JsonValue tree;
        const bool accepted = ssc::readJsonView(token, view);
        REQUIRE(accepted == ssc::parseJson(token, tree));
        if (accepted) { double n; REQUIRE(view.number(n)); CHECK(n == tree.number); }
    }
}
