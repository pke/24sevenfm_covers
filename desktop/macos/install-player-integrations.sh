#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
stamp=$(date +%Y%m%d-%H%M%S)
backup="$HOME/Library/Application Support/24seven.fm Covers/Backups/$stamp-players"
mkdir -p "$backup"
if pgrep -x IINA >/dev/null || pgrep -x foobar2000 >/dev/null; then
    echo 'Quit the players before replacing their extensions; no files replaced.' >&2;exit 1
fi
iina_root="$HOME/Library/Application Support/com.colliderli.iina/plugins"
iina_target="$iina_root/24sevenfm-covers.iinaplugin"
mkdir -p "$iina_root"
if [ -e "$iina_target" ];then ditto "$iina_target" "$backup/24sevenfm-covers.iinaplugin";fi
defaults export com.colliderli.iina "$backup/iina-preferences.plist" 2>/dev/null || true
mkdir -p "$iina_target"
cp iina/24sevenfm-covers.iinaplugin/Info.json iina/24sevenfm-covers.iinaplugin/main.js "$iina_target/"
defaults write com.colliderli.iina PluginEnabled.app.dudesoft.24sevenfm.covers.iina -bool true
cmp iina/24sevenfm-covers.iinaplugin/main.js "$iina_target/main.js"
cmp iina/24sevenfm-covers.iinaplugin/Info.json "$iina_target/Info.json"
foobar_root="$HOME/Library/foobar2000-v2/user-components/foo_24sevenfm_covers"
foobar_target="$foobar_root/foo_24sevenfm_covers.component"
component="$PWD/desktop/build/foobar-macos/foo_24sevenfm_covers.component"
codesign --verify --deep --strict "$component"
mkdir -p "$foobar_root"
if [ -d "$foobar_target" ];then ditto "$foobar_target" "$backup/foo_24sevenfm_covers.component";fi
ditto "$component" "$foobar_target"
codesign --verify --deep --strict "$foobar_target"
source_hash=$(shasum -a 256 "$component/Contents/MacOS/foo_24sevenfm_covers" | cut -d ' ' -f 1)
installed_hash=$(shasum -a 256 "$foobar_target/Contents/MacOS/foo_24sevenfm_covers" | cut -d ' ' -f 1)
test "$source_hash" = "$installed_hash"
printf 'Installed IINA plugin and arm64 foobar2000 component\nSHA256: %s\nBackups: %s\n' "$installed_hash" "$backup"
