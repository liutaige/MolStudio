#!/bin/bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES=$(cd "$HERE/../../Sources/Ketcher3D" && pwd)
COLOR_HOST_OUT=${MOLSTUDIO_NATIVE_TEST_OUT:-/tmp/molstudio-color-picker-host}
mkdir -p "$COLOR_HOST_OUT/module-cache"
swiftc -target arm64-apple-macos14.0 -module-cache-path "$COLOR_HOST_OUT/module-cache" \
  -framework AppKit -framework WebKit -framework Foundation -framework ImageIO \
  "$SOURCES/WelcomeRecents.swift" "$SOURCES/WelcomeThumbnailCache.swift" "$SOURCES/AppRuntimeConfig.swift" \
  "$SOURCES/WorkspaceContract.swift" "$SOURCES/WorkspaceAppearance.swift" "$SOURCES/WorkspaceToolbarController.swift" \
  "$SOURCES/WorkspaceLibraryViewController.swift" "$SOURCES/WorkspacePaletteViews.swift" \
  "$SOURCES/WorkspaceInspectorViewController.swift" "$SOURCES/WorkspaceAgentViewController.swift" \
  "$SOURCES/WorkspaceSplitViewController.swift" "$HERE/HostRegression.swift" \
  -o "$COLOR_HOST_OUT/native-color-host-regression"
MOLSTUDIO_NATIVE_TEST_OUT="$COLOR_HOST_OUT" "$COLOR_HOST_OUT/native-color-host-regression"
