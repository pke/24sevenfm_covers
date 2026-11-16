// Demo-mode sentinel: probed once per process. The Winamp gate timer asks twice
// a second, and every probe enumerated a directory on disk.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"
#include "demo.h"
#include <windows.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>

TEST_CASE("demo sentinel is probed once per process, not on every gate tick") {
    char base[MAX_PATH] = {};
    REQUIRE(GetTempPathA(MAX_PATH, base) > 0);
    const std::string temp = std::string(base) + "ssc-demo-test-" + std::to_string(GetCurrentProcessId()) + "\\";
    REQUIRE(CreateDirectoryA(temp.c_str(), nullptr));
    REQUIRE(SetEnvironmentVariableA("TMP", temp.c_str()));
    REQUIRE(SetEnvironmentVariableA("TEMP", temp.c_str()));

    CHECK_FALSE(ssc::Demo::active());
    // A demo folder appearing later is only honoured on the next host start,
    // as demo.h documents ("checked once at start()").
    const std::string demo = temp + "24seven.fm-covers-demo\\";
    REQUIRE(CreateDirectoryA(demo.c_str(), nullptr));
    const std::string image = demo + "01.jpg";
    HANDLE file = CreateFileA(image.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    REQUIRE(file != INVALID_HANDLE_VALUE);
    CloseHandle(file);
    CHECK_FALSE(ssc::Demo::active());
    const auto begin = std::chrono::steady_clock::now();
    for (int i = 0; i < 1000; ++i) CHECK_FALSE(ssc::Demo::active());
    if (std::getenv("SSC_BENCH"))
        std::printf("DEMO active(): %.3f us per call\n", std::chrono::duration<double, std::micro>(
            std::chrono::steady_clock::now() - begin).count() / 1000);

    DeleteFileA(image.c_str()); RemoveDirectoryA(demo.c_str()); RemoveDirectoryA(temp.c_str());
}
