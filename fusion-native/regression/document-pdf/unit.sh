#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
BUILD_DIR="${TMPDIR:-/tmp}/molstudio-document-pdf-units"
mkdir -p "$BUILD_DIR"
for test in TextMappingTests PDFOccurrenceTests PDFTextPatchTests; do
  swiftc -module-cache-path "$BUILD_DIR/cache" -o "$BUILD_DIR/$test" \
    "$ROOT"/fusion-native/Sources/Ketcher3D/DocumentPDF*.swift \
    "$ROOT/fusion-native/regression/document-pdf/$test.swift" -lz
  "$BUILD_DIR/$test"
done
