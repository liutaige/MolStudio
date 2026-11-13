#!/bin/bash
# Build MolStudio.app: native Swift shell + bundled Python service resources.
#
# Usage:
#   bash build-app.sh                     -> dist/MolStudio.app (next to this script)
#   bash build-app.sh /path/MolStudio.app -> output app at the given full path
#   DIST_DIR=/path/MolStudio.app bash build-app.sh
#   OVERWRITE_APP=1 bash build-app.sh ...  -> explicitly replace an existing bundle
#
# Resources bundled into Contents/Resources:
#   server.py and chemistry modules, canvas.html, threed.html, help.html,
#   workbench/, agent/, vendor/ngl.js and ketcher-local/.
# server.py derives BASE from its own location and serves pages from BASE;
# with everything flat in Resources, BASE/ketcher-local resolves without
# setting KETCHER_DIR. A relocatable CPython and RDKit are installed in python/.
# Requires uv and network access on the build machine; no venv is copied.
# Builds for the current Mac architecture; build separately for Intel and Apple Silicon.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

# ---- 0. 版本号单一来源（与 make-dmg.sh 共用 version.sh） ----
source ./version.sh

# ---- 1. Output location: $1, else $DIST_DIR, else dist/MolStudio.app ----
APP="${1:-${DIST_DIR:-dist/MolStudio.app}}"

# Strip trailing slashes so the path can never collapse to "" or "/".
while [ "${APP%/}" != "$APP" ]; do APP="${APP%/}"; done

# Guard BEFORE any rm -rf: refuse empty/root/relative-dot paths outright.
case "$APP" in
  ""|"/"|"."|".."|".app")
    echo "error: refusing unsafe output path: '$APP'" >&2
    exit 1
    ;;
esac
# Must name a .app bundle (use parameter expansion, bash-3.2 safe).
case "${APP##*/}" in
  .app|*.app) [ "${APP##*/}" != ".app" ] || { echo "error: invalid .app name: '$APP'" >&2; exit 1; } ;;
  *)
    echo "error: output path must point at a .app bundle: '$APP'" >&2
    exit 1
    ;;
esac

if [ -e "$APP" ] || [ -L "$APP" ]; then
  if [ "${OVERWRITE_APP:-0}" != "1" ]; then
    echo "error: output already exists: '$APP'; set OVERWRITE_APP=1 to replace it" >&2
    exit 1
  fi
fi

# Build browser-only agent assets; Node is needed on the build machine, not in the app.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'error: Node.js and npm are required to build the browser agent assets' >&2
  exit 1
fi
node "$ROOT/fusion/patch-ketcher-agent.cjs"
node "$ROOT/fusion/patch-ketcher-label-spacing.cjs"
npm --prefix "$ROOT/fusion/agent" ci --ignore-scripts --no-audit --no-fund
npm --prefix "$ROOT/fusion/agent" run build

# Use an isolated uv-managed Python installation, never the developer's venv.
if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required to download the portable Python runtime and install RDKit (https://docs.astral.sh/uv/getting-started/installation/)" >&2
  exit 1
fi
RUNTIME_TMP="$(mktemp -d "${TMPDIR:-/tmp}/molstudio-runtime.XXXXXX")"
trap 'rm -rf "$RUNTIME_TMP"' EXIT
echo "build: installing portable CPython 3.12.13 for $(uname -m)"
uv python install --no-config --no-bin --install-dir "$RUNTIME_TMP" 3.12.13
set -- "$RUNTIME_TMP"/cpython-3.12.13-macos-*-none
if [ "$#" -ne 1 ] || [ ! -x "$1/bin/python3" ]; then
  echo "error: uv did not install the expected standalone Python runtime" >&2
  exit 1
fi
RUNTIME_SOURCE="$1"

# ---- 2. Build the Swift executable (release, default .build location) ----
# 沙箱/受限环境下 SwiftPM 可能无法写缓存（sandbox_apply 失败）；BUILD_WITH_SWIFTC=1
# 直接用 swiftc 编同一份源码，产物等价（单一可执行 target，无依赖）。
if [ "${BUILD_WITH_SWIFTC:-0}" = "1" ]; then
  echo "build: swiftc (BUILD_WITH_SWIFTC=1)"
  mkdir -p .build/release
  swiftc -O -module-cache-path "${TMPDIR:-/tmp}/molstudio-swiftc-cache" \
    Sources/Ketcher3D/main.swift -o .build/release/Ketcher3D
else
  swift build -c release
fi

# ---- 3. Fresh bundle: replace only the .app itself, never the whole dist/ ----
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Ketcher3D "$APP/Contents/MacOS/MolStudio"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# ---- 4. Bundle runtime resources (fail loudly listing everything missing) ----
MISSING=""
for f in \
  "$ROOT/fusion/server.py" \
  "$ROOT/fusion/stereo.py" \
  "$ROOT/fusion/inorganic.py" \
  "$ROOT/fusion/agent_gateway.py" \
  "$ROOT/fusion/agent_external_bridge.py" \
  "$ROOT/fusion/mcp_server.py" \
  "$ROOT/fusion/mcp_response.py" \
  "$ROOT/fusion/agent/app.js" \
  "$ROOT/fusion/agent/panel.js" \
  "$ROOT/fusion/agent/panel.css" \
  "$ROOT/fusion/agent/dist/agent-runtime.js" \
  "$ROOT/fusion/canvas.html" \
  "$ROOT/fusion/help.html" \
  "$ROOT/fusion/threed.html" \
  "$ROOT/fusion/vendor/ngl.js" \
  "$ROOT/fusion/tests/fixtures/workbench-mechanism/F01.molwork"; do
  [ -f "$f" ] || MISSING="$MISSING $f"
done
[ -d "$ROOT/fusion/workbench" ] || MISSING="$MISSING $ROOT/fusion/workbench/"
[ -d "$ROOT/ketcher-local" ] || MISSING="$MISSING $ROOT/ketcher-local/"
if [ -n "$MISSING" ]; then
  echo "error: missing required resources:$MISSING" >&2
  exit 1
fi

RES="$APP/Contents/Resources"
ditto "$RUNTIME_SOURCE" "$RES/python"
# The service directly imports RDKit; its wheel requires NumPy and Pillow.
# Require wheels so building never silently depends on local compiler/libraries.
uv pip install --no-config --python "$RES/python/bin/python3" --system --break-system-packages --only-binary :all: \
  'rdkit==2026.9.1' 'numpy==2.5.4' 'pillow==13.0.0'
# 瘦身：pip 与 rdkit-stubs 不随包分发——内置运行时以 -I 隔离模式运行，永远不安装包
# （2026-11-04 产品问题清单曾点名这两项不该出现在发布包里）。
rm -rf "$RES/python/lib/python3.12/site-packages/pip" \
  "$RES/python/lib/python3.12/site-packages/"pip-*.dist-info \
  "$RES/python/lib/python3.12/site-packages/rdkit-stubs"
rm -f "$RES/python/bin/pip" "$RES/python/bin/pip3" "$RES/python/bin/pip3.12"
env -u PYTHONHOME -u PYTHONPATH "$RES/python/bin/python" -I -B -c \
  'from rdkit import Chem; from rdkit.Chem import AllChem, rdCoordGen; m = Chem.MolFromSmiles("CCO"); rdCoordGen.AddCoords(m); assert m.GetNumConformers() == 1; assert AllChem.EmbedMolecule(Chem.AddHs(m), randomSeed=42) == 0'
for f in server.py stereo.py inorganic.py agent_gateway.py agent_external_bridge.py mcp_server.py mcp_response.py canvas.html help.html threed.html; do
  cp "$ROOT/fusion/$f" "$RES/$f"
done
# 欢迎页「打开示例」：随包分发已验收的机理夹具（源文件唯一，构建时改名）
mkdir -p "$RES/examples"
cp "$ROOT/fusion/tests/fixtures/workbench-mechanism/F01.molwork" "$RES/examples/OH-CH3Br.molwork"
mkdir -p "$RES/vendor"
cp "$ROOT/fusion/vendor/ngl.js" "$RES/vendor/ngl.js"
# 机理层模块（孤对 / 弯箭头）：canvas.html 以相对路径 workbench/*.js 加载
ditto "$ROOT/fusion/workbench" "$RES/workbench"
mkdir -p "$RES/agent"
for f in app.js panel.js panel.css THIRD_PARTY_NOTICES.md; do
  cp "$ROOT/fusion/agent/$f" "$RES/agent/$f"
done
ditto "$ROOT/fusion/agent/dist" "$RES/agent/dist"
ditto "$ROOT/ketcher-local" "$RES/ketcher-local"
# ---- 5. Info.plist ----
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MolStudio</string>
  <key>CFBundleDisplayName</key><string>MolStudio</string>
  <key>CFBundleExecutable</key><string>MolStudio</string>
  <key>CFBundleIdentifier</key><string>local.ketcher3d.native</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <!-- 界面只有中文：声明本地化，让 AppKit 标准菜单项（窗口菜单/帮助搜索）跟随中文，
       不再出现 Window 菜单里夹着 Fill / Center 这类英文系统项。 -->
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleLocalizations</key><array><string>zh-Hans</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

# ---- 6. Ad-hoc codesign ----
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"
echo "built: $APP"
