#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
BUILD_DIR="${TMPDIR:-/tmp}/molstudio-welcome-thumbnail-tests"
mkdir -p "$BUILD_DIR"
swiftc -module-cache-path "$BUILD_DIR/cache" -parse-as-library \
  "$ROOT/fusion-native/Sources/Ketcher3D/WelcomeRecents.swift" \
  "$ROOT/fusion-native/Sources/Ketcher3D/WelcomeThumbnailCache.swift" \
  "$ROOT/fusion-native/regression/welcome-thumbnail/tests.swift" -o "$BUILD_DIR/tests"
"$BUILD_DIR/tests"
