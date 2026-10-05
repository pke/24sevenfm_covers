cmake_minimum_required(VERSION 3.20)
project(foo_24sevenfm_covers_macos LANGUAGES CXX OBJCXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_OBJCXX_STANDARD 20)
set(FOOBAR_SDK_LIB_DIR "" CACHE PATH "SDK static libraries from build.sh")
set(COVERFETCH_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
set(COVERFETCH_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SSC_ENABLE_DEBUG_OVERLAY OFF CACHE BOOL "" FORCE)
add_subdirectory(../../lib core)
add_library(foo_24sevenfm_covers MODULE component.mm visualisation.mm settings.mm ../../shared/player_follow.cpp)
option(SSC_PLAYER_E2E "Include the SDK playback driver in the test component only" OFF)
if(SSC_PLAYER_E2E)
    target_sources(foo_24sevenfm_covers PRIVATE e2e_driver.mm)
    target_compile_definitions(foo_24sevenfm_covers PRIVATE SSC_PLAYER_E2E=1)
endif()
target_include_directories(foo_24sevenfm_covers PRIVATE ../sdk ../sdk/foobar2000)
target_compile_options(foo_24sevenfm_covers PRIVATE -fobjc-arc)
target_link_libraries(foo_24sevenfm_covers PRIVATE
    "-Wl,-force_load,${FOOBAR_SDK_LIB_DIR}/libfoobar2000_component_client.a"
    "${FOOBAR_SDK_LIB_DIR}/libfoobar2000_SDK.a" "${FOOBAR_SDK_LIB_DIR}/libpfc-Mac.a" "${FOOBAR_SDK_LIB_DIR}/libshared.a"
    coverfetch "-framework AppKit" "-framework QuartzCore" "-framework CoreFoundation")
set_target_properties(foo_24sevenfm_covers PROPERTIES BUNDLE TRUE BUNDLE_EXTENSION component PREFIX ""
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in")
add_custom_command(TARGET foo_24sevenfm_covers POST_BUILD
    COMMAND /usr/bin/codesign --force --sign - "$<TARGET_BUNDLE_DIR:foo_24sevenfm_covers>" VERBATIM)
