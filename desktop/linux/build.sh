#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build=${SSC_LINUX_BUILD_DIR:-"$root/desktop/build/linux"}
cmake -S "$root/desktop/linux" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCOVERFETCH_BUILD_TESTS=ON
cmake --build "$build" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
ctest --test-dir "$build" --output-on-failure
if [ "${SSC_LIVE_TEST:-0}" = 1 ]; then
    QT_QPA_PLATFORM=offscreen "$build/24sevenfm_covers" --smoke-test
fi
(cd "$build" && cpack)
printf '\nRun: %s/24sevenfm_covers\n' "$build"
