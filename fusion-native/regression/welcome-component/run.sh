#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$HERE/../.." && pwd)"
SOURCES_DIR="$NATIVE_DIR/Sources/Ketcher3D"
BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/molstudio-welcome-verify.XXXXXX")"
CACHE_DIR="$BUILD_TMP/module-cache"
SCREENSHOT_DIR="$HERE/screenshots"

cleanup() {
  rm -rf "$BUILD_TMP"
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR" "$SCREENSHOT_DIR" "$BUILD_TMP/src-snapshot"

echo "==> 1. Compile independent welcome component (WelcomeRecents.swift + WelcomeThumbnailCache.swift + WelcomeView.swift)"
swiftc -O -wmo -module-cache-path "$CACHE_DIR" \
  -parse-as-library -emit-object -emit-module \
  -module-name WelcomeComponent \
  -emit-module-path "$BUILD_TMP/WelcomeComponent.swiftmodule" \
  "$SOURCES_DIR/WelcomeRecents.swift" \
  "$SOURCES_DIR/WelcomeThumbnailCache.swift" \
  "$SOURCES_DIR/WelcomeView.swift" \
  -o "$BUILD_TMP/WelcomeComponent.o"

echo "==> 2. Compile full Ketcher3D target snapshot (checking symbol compatibility with main.swift)"
cp "$SOURCES_DIR"/*.swift "$BUILD_TMP/src-snapshot/"
swiftc -O -lz -module-cache-path "$CACHE_DIR" \
  "$BUILD_TMP/src-snapshot"/*.swift \
  -o "$BUILD_TMP/Ketcher3D"

echo "==> 3. Compile and run isolated unit tests (temp dirs + isolated UserDefaults)"
swiftc -O -module-cache-path "$CACHE_DIR" \
  -parse-as-library \
  "$SOURCES_DIR/WelcomeRecents.swift" \
  "$SOURCES_DIR/WelcomeThumbnailCache.swift" \
  "$SOURCES_DIR/WelcomeView.swift" \
  "$HERE/test_welcome_component.swift" \
  -o "$BUILD_TMP/welcome-tests"
"$BUILD_TMP/welcome-tests"

echo "==> 4. Compile and run standalone preview host to capture screenshots"
swiftc -O -module-cache-path "$CACHE_DIR" \
  -parse-as-library \
  "$SOURCES_DIR/WelcomeRecents.swift" \
  "$SOURCES_DIR/WelcomeThumbnailCache.swift" \
  "$SOURCES_DIR/WelcomeView.swift" \
  "$HERE/preview_host.swift" \
  -o "$BUILD_TMP/welcome-preview"
"$BUILD_TMP/welcome-preview" --capture-screenshots "$SCREENSHOT_DIR"

echo "==> Screenshots generated in $SCREENSHOT_DIR:"
ls -lh "$SCREENSHOT_DIR"/*.png
