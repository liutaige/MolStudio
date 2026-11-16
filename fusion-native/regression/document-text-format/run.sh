#!/bin/bash
set -euo pipefail
REGRESSION_DIR=$(cd "$(dirname "$0")" && pwd)
TEXT_FORMAT_OUT=${MOLSTUDIO_NATIVE_TEST_OUT:-/tmp/molstudio-text-format-native}
mkdir -p "$TEXT_FORMAT_OUT/module-cache"
swiftc -module-cache-path "$TEXT_FORMAT_OUT/module-cache" "$REGRESSION_DIR/main.swift" -o "$TEXT_FORMAT_OUT/native-text-format-probe"
MOLSTUDIO_NATIVE_TEST_OUT="$TEXT_FORMAT_OUT" "$TEXT_FORMAT_OUT/native-text-format-probe"
