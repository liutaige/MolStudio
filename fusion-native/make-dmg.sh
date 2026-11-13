#!/bin/bash
# 构建、验收并打包 MolStudio 对外分发的 DMG。
#
# Usage:
#   bash make-dmg.sh                     -> dist/MolStudio-<version>[-beta.N]-<arch>.dmg
#   bash make-dmg.sh /path/MolStudio.dmg -> 输出到指定完整路径
#
# 流程：
#   1. build-app.sh 全新构建（内部已验 RDKit/CoordGen/3D 与 ad-hoc 签名）
#   2. verify-portable.py 移动性验收（临时端口起服务，验页面/性质/普通 3D/无机参照模型）
#   3. 组装暂存目录：MolStudio.app + Applications 链接 + 首次打开说明
#   4. hdiutil 压缩为 UDZO DMG；挂载抽查版本与签名，输出大小与 sha256
#   5. 同步已验收的 app 到 dist/MolStudio.app，保持两处一致
#
# 版本号在 version.sh 维护；本机构建只覆盖当前架构（arm64 / x86_64），
# 另一架构需在对应机型的机器上单独构建。DMG 未经 Developer ID 公证，
# 接收方首次打开需要放行（见包内「首次打开说明.txt」）。
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
source ./version.sh

ARCH="$(uname -m)"
RELEASE_TAG="${BETA_TAG:+-$BETA_TAG}"
DMG="${1:-dist/MolStudio-${APP_VERSION}${RELEASE_TAG}-${ARCH}.dmg}"

while [ "${DMG%/}" != "$DMG" ]; do DMG="${DMG%/}"; done
case "$DMG" in
  ""|"/"|"."|"..")
    echo "error: refusing unsafe output path: '$DMG'" >&2
    exit 1
    ;;
esac
case "${DMG##*/}" in
  .dmg) echo "error: invalid .dmg name: '${DMG##*/}'" >&2; exit 1 ;;
  *.dmg) ;;
  *)
    echo "error: output path must point at a .dmg image: '$DMG'" >&2
    exit 1
    ;;
esac

# 发布一致性：package.json 版本必须与 version.sh 同步（版本单一来源的哨兵）
PKG_VERSION="$(node -p "require('$ROOT/fusion/package.json').version")"
if [ "$PKG_VERSION" != "$APP_VERSION" ]; then
  echo "error: fusion/package.json version ($PKG_VERSION) != version.sh APP_VERSION ($APP_VERSION); sync them first" >&2
  exit 1
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/molstudio-dmg.XXXXXX")"
MNT=""
cleanup() {
  if [ -n "$MNT" ]; then
    hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
    rm -rf "$MNT"
  fi
  rm -rf "$STAGING"
}
trap cleanup EXIT

# ---- 1. Fresh build（build-app.sh 内部已做 RDKit/CoordGen/3D/签名自检） ----
APP="$STAGING/MolStudio.app"
OVERWRITE_APP=1 bash ./build-app.sh "$APP"

# ---- 2. Portable acceptance ----
echo "verify: verify-portable（临时端口起服务，验页面/性质/普通 3D/无机参照模型，及搬迁前后签名）"
env -u PYTHONHOME -u PYTHONPATH "$APP/Contents/Resources/python/bin/python" -I -B \
  "$ROOT/fusion-native/verify-portable.py" "$APP"

# ---- 3. Assemble staging ----
ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/首次打开说明.txt" <<README
MolStudio ${APP_VERSION}${RELEASE_TAG}（${ARCH} 架构，macOS 14 及以上）

安装：把 MolStudio.app 拖到右侧的 Applications 文件夹里。

首次打开（只需放行一次）：
本安装包未经 Apple 公证。第一次双击如果提示“无法验证开发者”或“已损坏，建议移到废纸篓”，任选一种方式放行：

1. 在 Finder 里右键（或按住 Control 点按）MolStudio，选“打开”，在弹窗里再点“打开”；
2. 或打开 系统设置 → 隐私与安全性，在页面下方找到关于 MolStudio 的提示，点“仍要打开”；
3. 或在“终端”里执行：
   xattr -dr com.apple.quarantine /Applications/MolStudio.app

放行一次之后即可正常双击使用。

其他说明：
- 应用完全自包含（内置 Python 与化学计算库），不需要安装任何依赖。
- 模型设置保存在 ~/Library/Application Support/MolStudio，API Key 存在 macOS 钥匙串；删除应用不会动这些数据。
- Apple Silicon（M 系列）机型请使用 arm64 包；Intel 机型需要 x86_64 包。
- 这是公开测试版：反馈问题时请注明版本号（「关于」窗口可查）与复现步骤。
README

# ---- 4. Create DMG ----
mkdir -p "$(dirname "$DMG")"
hdiutil create -volname "MolStudio ${APP_VERSION}${RELEASE_TAG}" \
  -srcfolder "$STAGING" -ov -format UDZO "$DMG"

# ---- 5. Mount spot-check ----
echo "verify: mount spot-check"
MNT="$(mktemp -d "${TMPDIR:-/tmp}/molstudio-mnt.XXXXXX")"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null
[ -d "$MNT/MolStudio.app" ] || { echo "error: MolStudio.app missing in DMG" >&2; exit 1; }
MOUNTED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$MNT/MolStudio.app/Contents/Info.plist" 2>/dev/null || true)"
MOUNTED_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
  "$MNT/MolStudio.app/Contents/Info.plist" 2>/dev/null || true)"
[ "$MOUNTED_VERSION" = "$APP_VERSION" ] || { echo "error: DMG app version ($MOUNTED_VERSION) != $APP_VERSION" >&2; exit 1; }
codesign --verify --deep --strict "$MNT/MolStudio.app"
hdiutil detach "$MNT" -quiet >/dev/null
MNT=""

# ---- 6. Sync verified app to dist/ ----
rm -rf dist/MolStudio.app
ditto "$APP" dist/MolStudio.app

echo "built: $DMG"
echo "version: ${APP_VERSION}${RELEASE_TAG} (build ${MOUNTED_BUILD}, ${ARCH})"
du -h "$DMG" | cut -f1 | sed 's/^/size: /'
echo "sha256:"
shasum -a 256 "$DMG"
