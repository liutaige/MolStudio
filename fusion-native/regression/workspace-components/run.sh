#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$(cd "$HERE/../.." && pwd)"
SOURCES_DIR="$NATIVE_DIR/Sources/Ketcher3D"
BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/molstudio-workspace-components.XXXXXX")"
CACHE_DIR="$BUILD_TMP/module-cache"
SDK_PATH="$(xcrun --show-sdk-path)"

cleanup() {
  rm -rf "$BUILD_TMP"
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR"

echo "==> 1. Compile standalone Workspace*.swift components (target: arm64-apple-macos14.0, no main.swift)"
swiftc -O -wmo \
  -target arm64-apple-macos14.0 \
  -sdk "$SDK_PATH" \
  -module-cache-path "$CACHE_DIR" \
  -framework AppKit -framework WebKit -framework Foundation -framework ImageIO \
  "$SOURCES_DIR/WelcomeRecents.swift" \
  "$SOURCES_DIR/WelcomeThumbnailCache.swift" \
  "$SOURCES_DIR/AppRuntimeConfig.swift" \
  "$SOURCES_DIR/WorkspaceContract.swift" \
  "$SOURCES_DIR/WorkspaceAppearance.swift" \
  "$SOURCES_DIR/WorkspaceToolbarController.swift" \
  "$SOURCES_DIR/WorkspaceLibraryViewController.swift" \
  "$SOURCES_DIR/WorkspacePaletteViews.swift" \
  "$SOURCES_DIR/WorkspaceInspectorViewController.swift" \
  "$SOURCES_DIR/WorkspaceAgentViewController.swift" \
  "$SOURCES_DIR/WorkspaceSplitViewController.swift" \
  "$HERE/WorkspaceComponentTests.swift" \
  -o "$BUILD_TMP/workspace-component-tests"

echo "==> 2. Verify Mach-O deployment minimum OS (expect minos 14.0) & active SDK"
VTOOL_OUT="$(xcrun vtool -show-build "$BUILD_TMP/workspace-component-tests")"
printf '%s\n' "$VTOOL_OUT"
printf '%s\n' "$VTOOL_OUT" | grep -Eq 'minos[[:space:]]+14\.0([[:space:]]|$)'

echo "==> 2b. Regenerate fresh JS->Swift contract fixtures"
COMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$COMP_DIR/gen_js_fixtures.cjs"
shasum -a 256 "$COMP_DIR/fixtures/contract-fixtures.json"

echo "==> 3. Run standalone component behavior tests"
# Pure component tests must not depend on a live GUI session: headless mode
# skips window ordering. Layout revisions that require a real NSSplitView
# resize are asserted as non-regressing instead (see test source).
MOLSTUDIO_HEADLESS=1 "$BUILD_TMP/workspace-component-tests"
