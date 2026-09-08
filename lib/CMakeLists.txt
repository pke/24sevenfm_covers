cmake_minimum_required(VERSION 3.15)
project(coverfetch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(coverfetch STATIC
    coverfetch.cpp
    http_client.cpp
    coverfetch_c.cpp
    mini_json.cpp
    media_resolver.cpp
    media_policy.cpp
    image_probe.cpp
)

target_include_directories(coverfetch
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}"
)

# Platform sockets / threads.
if(WIN32)
    target_link_libraries(coverfetch PUBLIC ws2_32 windowscodecs ole32)
else()
    find_package(Threads REQUIRED)
    target_link_libraries(coverfetch PUBLIC Threads::Threads)
endif()

# Optional demo (desktop only; skip when cross-compiling for a phone).
option(COVERFETCH_BUILD_EXAMPLE "Build the console example" ON)
if(COVERFETCH_BUILD_EXAMPLE AND NOT ANDROID AND NOT IOS)
    add_executable(coverfetch_example example/main.cpp)
    target_link_libraries(coverfetch_example PRIVATE coverfetch)
endif()

# Unit tests (desktop only; OFF by default). Enable with -DCOVERFETCH_BUILD_TESTS=ON,
# then run via CTest. The test compiles the sources directly (to reach the anonymous-
# namespace helpers), so it does NOT link the coverfetch library.
option(COVERFETCH_BUILD_TESTS "Build the unit tests" OFF)
if(COVERFETCH_BUILD_TESTS AND NOT ANDROID AND NOT IOS)
    enable_testing()
    add_executable(coverfetch_tests tests/test_coverfetch.cpp)
    target_include_directories(coverfetch_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    if(WIN32)
        target_link_libraries(coverfetch_tests PRIVATE ws2_32)
    else()
        find_package(Threads REQUIRED)
        target_link_libraries(coverfetch_tests PRIVATE Threads::Threads)
    endif()
    # doctest.cmake (vendored, ships with doctest) registers every doctest TEST_CASE
    # as its own CTest entry, so ctest reports 26/26 cases instead of one opaque exe.
    include(tests/doctest.cmake)
    doctest_discover_tests(coverfetch_tests)

    add_executable(media_resolver_tests tests/test_media_resolver.cpp)
    target_link_libraries(media_resolver_tests PRIVATE coverfetch)
    target_include_directories(media_resolver_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(media_resolver_tests)

    add_executable(media_policy_tests tests/test_media_policy.cpp)
    target_link_libraries(media_policy_tests PRIVATE coverfetch)
    target_include_directories(media_policy_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(media_policy_tests)

    add_executable(rating_assets_tests
        tests/test_rating_assets.cpp
        "${CMAKE_CURRENT_SOURCE_DIR}/../shared/rating_assets.cpp")
    target_link_libraries(rating_assets_tests PRIVATE coverfetch)
    target_include_directories(rating_assets_tests PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/../shared")
    doctest_discover_tests(rating_assets_tests)
endif()
