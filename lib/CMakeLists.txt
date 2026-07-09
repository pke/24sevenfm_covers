cmake_minimum_required(VERSION 3.15)
project(coverfetch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(coverfetch STATIC
    coverfetch.cpp
    http_client.cpp
    coverfetch_c.cpp
)

target_include_directories(coverfetch
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}"
)

# Platform sockets / threads.
if(WIN32)
    target_link_libraries(coverfetch PUBLIC ws2_32)
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
