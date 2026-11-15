#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
OUT_DIR="${MOLSTUDIO_PDF_OUT_DIR:-$ROOT/.jez/artifacts/document-pdf}"
BUILD_DIR="${TMPDIR:-/tmp}/molstudio-document-pdf-probe"
mkdir -p "$OUT_DIR" "$BUILD_DIR"
swiftc -module-cache-path "$BUILD_DIR/cache" -o "$BUILD_DIR/probe" \
  "$ROOT"/fusion-native/Sources/Ketcher3D/DocumentPDF*.swift \
  "$ROOT/fusion-native/regression/document-pdf/main.swift" -lz
"$BUILD_DIR/probe" "$OUT_DIR"
