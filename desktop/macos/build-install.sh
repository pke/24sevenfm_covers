#!/bin/sh
# Runs on the Mac. Source lives in a separate upload directory for each build.
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/../.."
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'An Apple Silicon Mac is required' >&2; exit 1; }
xcrun --find clang++ >/dev/null
cmake -G Ninja -S desktop/macos -B desktop/build/macos -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCOVERFETCH_BUILD_TESTS=ON
cmake --build desktop/build/macos --parallel 8
ctest --test-dir desktop/build/macos --output-on-failure
app="$PWD/desktop/build/macos/24sevenfm_covers.app"
binary="$app/Contents/MacOS/24sevenfm_covers"
test "$(lipo -archs "$binary")" = arm64
codesign --verify --deep --strict "$app"
"$binary" --smoke-test
destination="$HOME/Applications/24seven.fm Covers.app"
mkdir -p "$HOME/Applications"
# Keep a recoverable, dated bundle without touching the NSUserDefaults domain.
if [ -d "$destination" ]; then
    mkdir -p "$HOME/Library/Application Support/24seven.fm Covers/Backups"
    ditto "$destination" "$HOME/Library/Application Support/24seven.fm Covers/Backups/$(date +%Y%m%d-%H%M%S).app"
fi
if pgrep -f '^.*/24sevenfm_covers.app/Contents/MacOS/24sevenfm_covers$|^.*/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers$' >/dev/null; then
    # The app defers its first Quit to finish fading, so AppleScript can return
    # -128 while the scheduled exit is already underway. Verify process exit below.
    osascript -e 'tell application id "app.dudesoft.24sevenfm.covers" to quit' || true
    count=0
    while pgrep -f '^.*/24sevenfm_covers.app/Contents/MacOS/24sevenfm_covers$|^.*/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers$' >/dev/null; do
        count=$((count + 1)); [ "$count" -lt 30 ] || { echo 'Viewer did not quit; installation left untouched' >&2; exit 1; }
        sleep 1
    done
fi
# Export the persisted settings after normal termination has flushed geometry.
# Never import defaults during an update; this is only a recoverable backup.
preferences_backup="$HOME/Library/Application Support/24seven.fm Covers/Backups/$(date +%Y%m%d-%H%M%S)-preferences.plist"
if defaults read app.dudesoft.24sevenfm.covers >/dev/null 2>&1; then
    mkdir -p "$(dirname "$preferences_backup")"
    defaults export app.dudesoft.24sevenfm.covers "$preferences_backup"
fi
ditto "$app" "$destination"
codesign --verify --deep --strict "$destination"
source_hash=$(shasum -a 256 "$binary" | cut -d ' ' -f 1)
installed_hash=$(shasum -a 256 "$destination/Contents/MacOS/24sevenfm_covers" | cut -d ' ' -f 1)
[ "$source_hash" = "$installed_hash" ] || { echo 'Installed hash mismatch' >&2; exit 1; }
open "$destination"
sleep 3
pgrep -fl '/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers'
printf 'Installed arm64 viewer: %s\nSHA256: %s\n' "$destination" "$installed_hash"
