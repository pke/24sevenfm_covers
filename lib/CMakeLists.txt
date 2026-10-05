cmake_minimum_required(VERSION 3.15)
project(coverfetch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
if(MSVC OR APPLE OR CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Match the native desktop hosts and their C++14+ aggregate-based tests.
    set(CMAKE_CXX_STANDARD 17)
endif()
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(SSC_ENABLE_DEBUG_OVERLAY "Include native diagnostic capture and overlay" ON)
add_compile_definitions(SSC_ENABLE_DEBUG_OVERLAY=$<BOOL:${SSC_ENABLE_DEBUG_OVERLAY}>)

add_library(coverfetch STATIC
    coverfetch.cpp
    http_client.cpp
    coverfetch_c.cpp
    mini_json.cpp
    json_view.cpp
    diagnostics.cpp
    media_resolver.cpp
    media_policy.cpp
    image_probe.cpp
    ../shared/presentation_pipeline.cpp
    ../shared/media_preparation.cpp
    ../shared/media_worker.cpp
    ../shared/rating_assets.cpp
)

target_include_directories(coverfetch
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}"
)

if(APPLE)
    enable_language(OBJCXX)
    target_sources(coverfetch PRIVATE http_client_apple.mm)
    set_source_files_properties(http_client_apple.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    target_link_libraries(coverfetch PUBLIC "-framework Foundation" "-framework ImageIO" "-framework CoreGraphics")
endif()

# Linux uses system TLS trust and a bounded native decoder. Keep these dependencies
# out of the Windows, Apple and mobile build graphs.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(CURL REQUIRED)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GDK_PIXBUF REQUIRED IMPORTED_TARGET gdk-pixbuf-2.0)
    target_sources(coverfetch PRIVATE http_client_curl.cpp image_probe_linux.cpp)
    target_link_libraries(coverfetch PUBLIC CURL::libcurl PkgConfig::GDK_PIXBUF)
    target_compile_definitions(coverfetch PUBLIC SSC_LINUX_NATIVE=1)
endif()

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

# Standalone metadata export: no engine instance, GUI, networking, or user preferences.
option(COVERFETCH_BUILD_SETTINGS_SCHEMA "Build the static settings schema exporter" ON)
if(COVERFETCH_BUILD_SETTINGS_SCHEMA AND NOT ANDROID AND NOT IOS)
    add_executable(settings_schema_export example/settings_schema.cpp)
    set_target_properties(settings_schema_export PROPERTIES CXX_STANDARD 17)
endif()

# Unit tests (desktop only; OFF by default). Enable with -DCOVERFETCH_BUILD_TESTS=ON,
# then run via CTest. The test compiles the sources directly (to reach the anonymous-
# namespace helpers), so it does NOT link the coverfetch library.
option(COVERFETCH_BUILD_TESTS "Build the unit tests" OFF)
if(COVERFETCH_BUILD_TESTS AND NOT ANDROID AND NOT IOS)
    enable_testing()
    add_executable(coverfetch_tests tests/test_coverfetch.cpp mini_json.cpp json_view.cpp diagnostics.cpp)
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        target_sources(coverfetch_tests PRIVATE http_client_curl.cpp)
        target_compile_definitions(coverfetch_tests PRIVATE SSC_LINUX_NATIVE=1)
        target_link_libraries(coverfetch_tests PRIVATE CURL::libcurl)
    endif()
    if(APPLE)
        target_sources(coverfetch_tests PRIVATE http_client_apple.mm)
        target_link_libraries(coverfetch_tests PRIVATE "-framework Foundation")
    endif()
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
    if(APPLE)
        add_executable(apple_platform_tests tests/test_apple_platform.cpp)
        target_link_libraries(apple_platform_tests PRIVATE coverfetch)
        doctest_discover_tests(apple_platform_tests TEST_PREFIX "Apple: ")
    endif()
    add_executable(platform_concurrency_tests tests/test_platform_concurrency.cpp)
    target_include_directories(platform_concurrency_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    if(NOT WIN32)
        target_link_libraries(platform_concurrency_tests PRIVATE Threads::Threads)
    endif()
    doctest_discover_tests(platform_concurrency_tests TEST_PREFIX "platform: ")
    add_executable(settings_schema_tests tests/test_settings_schema.cpp mini_json.cpp)
    set_target_properties(settings_schema_tests PROPERTIES CXX_STANDARD 17)
    doctest_discover_tests(settings_schema_tests TEST_PREFIX "settings: ")
    add_executable(platform_text_tests tests/test_platform_text.cpp)
    doctest_discover_tests(platform_text_tests TEST_PREFIX "platform: ")
    add_executable(platform_time_tests tests/test_platform_time.cpp)
    doctest_discover_tests(platform_time_tests TEST_PREFIX "platform: ")

    # Exercise the portable backend on Windows too. The facade remains C++11;
    # /std:c++14 is the oldest language mode supported by current MSVC.
    if(WIN32)
        add_executable(portable_concurrency_tests tests/test_platform_concurrency.cpp)
        target_compile_definitions(portable_concurrency_tests PRIVATE SSC_USE_STD_CONCURRENCY)
        set_target_properties(portable_concurrency_tests PROPERTIES CXX_STANDARD 14)
        doctest_discover_tests(portable_concurrency_tests TEST_PREFIX "portable: ")
        add_executable(portable_text_tests tests/test_platform_text.cpp)
        set_target_properties(portable_text_tests PROPERTIES CXX_STANDARD 14)
        doctest_discover_tests(portable_text_tests TEST_PREFIX "C++14: ")
        add_executable(portable_time_tests tests/test_platform_time.cpp)
        target_compile_definitions(portable_time_tests PRIVATE SSC_USE_CRT_TIME)
        set_target_properties(portable_time_tests PROPERTIES CXX_STANDARD 14)
        doctest_discover_tests(portable_time_tests TEST_PREFIX "portable: ")
    endif()
    doctest_discover_tests(coverfetch_tests)

    add_executable(json_view_tests tests/test_json_view.cpp json_view.cpp mini_json.cpp)
    target_include_directories(json_view_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(json_view_tests)
    if(WIN32)
        add_executable(portable_json_view_tests tests/test_json_view.cpp json_view.cpp mini_json.cpp)
        set_target_properties(portable_json_view_tests PROPERTIES CXX_STANDARD 14)
        target_include_directories(portable_json_view_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
        doctest_discover_tests(portable_json_view_tests TEST_PREFIX "portable: ")
    endif()

    add_executable(json_number_tests tests/test_json_numbers.cpp mini_json.cpp)
    target_include_directories(json_number_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(json_number_tests)
    if(WIN32)
        add_executable(portable_json_tests tests/test_json_numbers.cpp mini_json.cpp)
        set_target_properties(portable_json_tests PROPERTIES CXX_STANDARD 14)
        target_include_directories(portable_json_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
        doctest_discover_tests(portable_json_tests TEST_PREFIX "portable: ")
    endif()

    add_executable(media_resolver_tests tests/test_media_resolver.cpp)
    target_link_libraries(media_resolver_tests PRIVATE coverfetch)
    target_include_directories(media_resolver_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(media_resolver_tests)

    add_executable(media_policy_tests tests/test_media_policy.cpp)
    target_link_libraries(media_policy_tests PRIVATE coverfetch)
    target_include_directories(media_policy_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    doctest_discover_tests(media_policy_tests)

    add_executable(presentation_pipeline_tests tests/test_presentation_pipeline.cpp)
    target_link_libraries(presentation_pipeline_tests PRIVATE coverfetch)
    doctest_discover_tests(presentation_pipeline_tests)

    add_executable(media_preparation_tests tests/test_media_preparation.cpp)
    target_link_libraries(media_preparation_tests PRIVATE coverfetch)
    set_target_properties(media_preparation_tests PROPERTIES CXX_STANDARD 17)
    doctest_discover_tests(media_preparation_tests)

    add_executable(presentation_controller_tests tests/test_presentation_controller.cpp)
    target_link_libraries(presentation_controller_tests PRIVATE coverfetch)
    doctest_discover_tests(presentation_controller_tests)

    add_executable(rating_assets_tests tests/test_rating_assets.cpp)
    target_link_libraries(rating_assets_tests PRIVATE coverfetch)
    target_include_directories(rating_assets_tests PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/../shared")
    doctest_discover_tests(rating_assets_tests)

    if(WIN32)
        add_executable(native_engine_tests tests/test_native_engine.cpp
            ../shared/d2d_renderer.cpp ../shared/d2d_transitions.cpp
            ../shared/d2d_rolldigits.cpp ../shared/demo.cpp)
        target_include_directories(native_engine_tests PRIVATE . ../shared)
        target_link_libraries(native_engine_tests PRIVATE coverfetch d2d1 dwrite)
        doctest_discover_tests(native_engine_tests)

        if(SSC_ENABLE_DEBUG_OVERLAY)
            add_executable(debug_tests tests/test_debug.cpp)
            target_link_libraries(debug_tests PRIVATE coverfetch comctl32)
            target_include_directories(debug_tests PRIVATE . ../shared)
            doctest_discover_tests(debug_tests)
        endif()

        add_executable(native_renderer_tests tests/test_native_renderer.cpp
            ../shared/d2d_renderer.cpp ../shared/d2d_transitions.cpp
            ../shared/d2d_rolldigits.cpp)
        target_compile_definitions(native_renderer_tests PRIVATE SSC_RENDERER_DIAGNOSTICS)
        target_include_directories(native_renderer_tests PRIVATE . ../shared)
        target_link_libraries(native_renderer_tests PRIVATE coverfetch d2d1 dwrite)
        doctest_discover_tests(native_renderer_tests)

        add_executable(desktop_taskbar_tests tests/test_desktop_taskbar.cpp
            ../desktop/taskbar_preview.cpp)
        target_include_directories(desktop_taskbar_tests PRIVATE . ../desktop)
        target_link_libraries(desktop_taskbar_tests PRIVATE comctl32 ole32 uuid)
        doctest_discover_tests(desktop_taskbar_tests)

        add_executable(caption_drag_tests tests/test_caption_drag.cpp)
        target_include_directories(caption_drag_tests PRIVATE .)
        doctest_discover_tests(caption_drag_tests)

        enable_language(RC)
        add_executable(native_options_tests tests/test_native_options.cpp tests/native_options.rc)
        target_include_directories(native_options_tests PRIVATE . ../shared ../foobar2000/wtl)
        target_link_libraries(native_options_tests PRIVATE coverfetch comctl32 msimg32)
        doctest_discover_tests(native_options_tests)
    endif()
endif()
