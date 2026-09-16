#!/usr/bin/env bash
# Test the distributed archives, including nested code and the bundled Go agent.
set -euo pipefail
version=$(node -p "require('./package.json').version")
arch=${1:?target architecture required}
macho_arch=$arch
if [[ "$arch" == x64 ]]; then macho_arch=x86_64; fi
tmp=$(mktemp -d)
mount="$tmp/mount"
verify_app() {
  local app="$1"
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --verify --strict --verbose=2 "$app/Contents/Resources/agent/chatgpt-agent"
  lipo -verify_arch "$macho_arch" "$app/Contents/MacOS/ChatGPT Web Client"
  lipo -verify_arch "$macho_arch" "$app/Contents/Resources/agent/chatgpt-agent"
  "$app/Contents/Resources/agent/chatgpt-agent" --help
  node tests/updates-desktop.mjs "$app/Contents/MacOS/ChatGPT Web Client"
}
ditto -x -k "release/ChatGPT-Web-Client-$version-mac-$arch.zip" "$tmp/zip"
verify_app "$tmp/zip/ChatGPT Web Client.app"
hdiutil verify "release/ChatGPT-Web-Client-$version-mac-$arch.dmg"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "release/ChatGPT-Web-Client-$version-mac-$arch.dmg"
trap 'hdiutil detach "$mount"' EXIT
ditto "$mount/ChatGPT Web Client.app" "$tmp/installed/ChatGPT Web Client.app"
verify_app "$tmp/installed/ChatGPT Web Client.app"
# Ad-hoc signatures ensure integrity but do not satisfy Gatekeeper notarization.
codesign --display --verbose=2 "$tmp/installed/ChatGPT Web Client.app"
