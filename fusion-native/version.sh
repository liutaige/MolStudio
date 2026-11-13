# version.sh — MolStudio 版本号单一来源（build-app.sh 与 make-dmg.sh 共同 source）
# 约定：
#   APP_VERSION  纯三段数字，写入 CFBundleShortVersionString 与 fusion/package.json，
#                「关于」窗口与文件名都按它展示。
#   BUILD_NUMBER 每次对外分发构建递增 1，写入 CFBundleVersion；排查用户反馈时靠它定位构建。
#   BETA_TAG     公测标记，只出现在 DMG 文件名；正式发布置空（""）。
APP_VERSION="0.4.0"
BUILD_NUMBER="3"
BETA_TAG="beta.1"
