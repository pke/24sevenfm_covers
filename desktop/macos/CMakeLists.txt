cmake_minimum_required(VERSION 3.20)
project(24sevenfm_covers_macos VERSION 1.0.0 LANGUAGES CXX OBJCXX)
if(NOT APPLE)
    message(FATAL_ERROR "Build this target on macOS with the Apple SDK")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OBJCXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(COVERFETCH_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
option(COVERFETCH_BUILD_TESTS "Run portable core tests" ON)
option(SSC_ENABLE_DEBUG_OVERLAY "Core diagnostics" OFF)
enable_testing()
add_subdirectory(../../lib core)
set(SSC_APP_ICON_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../24sevenfm_covers.ico" CACHE FILEPATH "Shared application icon source")
set(app_icon "${CMAKE_CURRENT_BINARY_DIR}/AppIcon.icns")
add_custom_command(OUTPUT "${app_icon}"
    COMMAND /usr/bin/swift "${CMAKE_CURRENT_SOURCE_DIR}/make-icon.swift" "${SSC_APP_ICON_SOURCE}" "${CMAKE_CURRENT_BINARY_DIR}/AppIcon.iconset"
    COMMAND /usr/bin/iconutil --convert icns --output "${app_icon}" "${CMAKE_CURRENT_BINARY_DIR}/AppIcon.iconset"
    DEPENDS "${SSC_APP_ICON_SOURCE}" make-icon.swift VERBATIM)
set_source_files_properties("${app_icon}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
set(station_logos ../../shared/resources/stations/sst.png ../../shared/resources/stations/1980s.png
    ../../shared/resources/stations/adagio.png ../../shared/resources/stations/death.png ../../shared/resources/stations/entranced.png)
set_source_files_properties(${station_logos} PROPERTIES MACOSX_PACKAGE_LOCATION Resources/Stations)
add_executable(24sevenfm_covers MACOSX_BUNDLE main.mm hover_titlebar.mm player_bridge.mm ../../shared/player_follow.cpp "${app_icon}" ${station_logos})
if(COVERFETCH_BUILD_TESTS)
    add_executable(hover_titlebar_tests hover_titlebar_tests.mm hover_titlebar.mm)
    target_compile_options(hover_titlebar_tests PRIVATE -fobjc-arc)
    target_link_libraries(hover_titlebar_tests PRIVATE "-framework AppKit")
    add_test(NAME "Mac hover titlebar" COMMAND hover_titlebar_tests)
    add_executable(player_bridge_tests player_bridge_tests.mm player_bridge.mm ../../shared/player_follow.cpp)
    target_compile_options(player_bridge_tests PRIVATE -fobjc-arc)
    target_link_libraries(player_bridge_tests PRIVATE "-framework AppKit")
    add_test(NAME "Mac player bridge protocol" COMMAND player_bridge_tests)
endif()
target_compile_options(24sevenfm_covers PRIVATE -fobjc-arc -Wall -Wextra -Wno-unused-parameter)
target_link_libraries(24sevenfm_covers PRIVATE coverfetch "-framework AppKit" "-framework QuartzCore")
set_target_properties(24sevenfm_covers PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "24seven.fm Covers"
    MACOSX_BUNDLE_GUI_IDENTIFIER "app.dudesoft.24sevenfm.covers"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in")
add_custom_command(TARGET 24sevenfm_covers POST_BUILD
    COMMAND /usr/bin/codesign --force --sign - "$<TARGET_BUNDLE_DIR:24sevenfm_covers>"
    VERBATIM COMMENT "Ad-hoc signing the local Apple Silicon application")
