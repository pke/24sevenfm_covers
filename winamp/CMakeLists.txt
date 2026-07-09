cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)   # MSVC_RUNTIME_LIBRARY controls /MT vs /MD
project(gen_24sevencover CXX)

# Winamp 5.x is 32-bit: configure with  -A Win32
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Self-contained + small: statically link the C runtime (no vcruntime140/msvcp140/
# ucrtbase dependency) and optimize for size.
if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>") # /MT (/MTd for Debug)
    add_compile_options(
        $<$<CONFIG:Release>:/Os>   # favour size over speed
        $<$<CONFIG:Release>:/GL>   # whole-program optimization
        $<$<CONFIG:Release>:/Gy>   # function-level linking (lets the linker drop unused funcs)
        $<$<CONFIG:Release>:/Gw>   # same for global data
        $<$<CONFIG:Release>:/GR->  # no RTTI (nothing here uses dynamic_cast/typeid)
    )
    add_link_options(
        $<$<CONFIG:Release>:/LTCG>          # link-time code gen (pairs with /GL)
        $<$<CONFIG:Release>:/OPT:REF>       # strip unreferenced functions/data
        $<$<CONFIG:Release>:/OPT:ICF>       # fold identical COMDATs
        $<$<CONFIG:Release>:/INCREMENTAL:NO>
    )
endif()

set(LIBDIR "${CMAKE_CURRENT_SOURCE_DIR}/../lib")

# General-purpose plugin (gen_*.dll): a dockable, GPU-rendered cover window.
set(SHAREDDIR "${CMAKE_CURRENT_SOURCE_DIR}/../shared")

add_library(gen_24sevencover SHARED
    gen_24sevencover.cpp
    d2d_renderer.cpp
    d2d_transitions.cpp
    d2d_rolldigits.cpp
    gen_24sevencover.rc
    "${SHAREDDIR}/cover_engine.cpp"
    "${SHAREDDIR}/options_panel.cpp"
    "${LIBDIR}/coverfetch.cpp"
    "${LIBDIR}/http_client.cpp"
)
target_include_directories(gen_24sevencover PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${SHAREDDIR}"
    "${LIBDIR}"
)
target_link_libraries(gen_24sevencover PRIVATE ole32 ws2_32 d2d1 windowscodecs dwrite)
set_target_properties(gen_24sevencover PROPERTIES
    PREFIX ""
    OUTPUT_NAME "gen_24sevencover"
)

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
    message(WARNING "Building ${CMAKE_SIZEOF_VOID_P}-byte pointers - Winamp 5.x needs a 32-bit DLL. Reconfigure with: cmake -A Win32")
endif()
