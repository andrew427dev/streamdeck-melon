#!/bin/sh
set -eu
cd "$(dirname "$0")"
plugin=local.melon.deck.sdPlugin
work=$(mktemp -d "${TMPDIR:-/tmp}/melon-plugin-build.XXXXXX")
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
    xcrun swiftc -O -target "$arch-apple-macos13.0" -module-cache-path "$work/cache" \
        native/MelonBridge.swift -o "$work/$arch"
done
xcrun lipo -create "$work/arm64" "$work/x86_64" -output "$plugin/bin/MelonBridge"
/usr/bin/codesign --force -s - -i local.melon.deck.bridge "$plugin/bin/MelonBridge"
node scripts/build-faces.mjs
node --test test/plugin.test.mjs
streamdeck pack "$plugin" --force --output .
