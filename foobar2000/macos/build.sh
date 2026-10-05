#!/bin/sh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
root="$PWD"
libraries="$root/desktop/build/foobar-sdk"
mkdir -p "$libraries"
build_sdk() {
    project="$1"; target="$2"
    xcodebuild -project "$project" -target "$target" -configuration Release \
        ARCHS=arm64 ONLY_ACTIVE_ARCH=YES MACOSX_DEPLOYMENT_TARGET=13.0 CODE_SIGNING_ALLOWED=NO \
        CONFIGURATION_BUILD_DIR="$libraries" SYMROOT="$root/desktop/build/foobar-sdk-objects" \
        >"$libraries/$target.log" 2>&1 || { tail -60 "$libraries/$target.log"; exit 1; }
}
build_sdk foobar2000/sdk/pfc/pfc.xcodeproj pfc-Mac
build_sdk foobar2000/sdk/foobar2000/shared/shared.xcodeproj shared
build_sdk foobar2000/sdk/foobar2000/SDK/foobar2000_SDK.xcodeproj foobar2000_SDK
build_sdk foobar2000/sdk/foobar2000/foobar2000_component_client/foobar2000_component_client.xcodeproj foobar2000_component_client
cmake -G Ninja -S foobar2000/macos -B desktop/build/foobar-macos -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DFOOBAR_SDK_LIB_DIR="$libraries" -DSSC_PLAYER_E2E=OFF
cmake --build desktop/build/foobar-macos --parallel 8
component="$root/desktop/build/foobar-macos/foo_24sevenfm_covers.component"
codesign --verify --deep --strict "$component"
test "$(lipo -archs "$component/Contents/MacOS/foo_24sevenfm_covers")" = arm64
ditto -c -k --keepParent "$component" "$root/desktop/build/foobar-macos/24sevenfm-covers-macos.fb2k-component"
