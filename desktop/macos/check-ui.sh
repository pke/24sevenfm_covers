#!/bin/sh
set -eu
app="$HOME/Applications/24seven.fm Covers.app"
binary="$app/Contents/MacOS/24sevenfm_covers"
output="$HOME/dev/24sevenfm-ui-check"
mkdir -p "$output"
osascript -e 'tell application id "app.dudesoft.24sevenfm.covers" to quit' || true
count=0
while pgrep -f '^.*/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers$' >/dev/null; do
    count=$((count + 1)); [ "$count" -lt 15 ] || { echo 'Graceful exit failed' >&2; exit 1; }
    sleep 1
done
SSC_UI_CHECK_DIR="$output" "$binary" >"$output/run.log" 2>&1 &
test_pid=$!
count=0
while kill -0 "$test_pid" 2>/dev/null; do
    count=$((count + 1))
    if [ "$count" -ge 90 ]; then
        sample "$test_pid" 1 -file "$output/timeout-sample.txt" >/dev/null 2>&1 || true
        kill -TERM "$test_pid"
        echo 'UI check timed out' >&2
        open "$app"
        exit 1
    fi
    sleep 1
done
if wait "$test_pid"; then :; else
    status=$?
    cat "$output/run.log"
    open "$app"
    exit "$status"
fi
cat "$output/run.log"
test -f "$output/poster.png" && test -f "$output/settings.png"
open "$app"
