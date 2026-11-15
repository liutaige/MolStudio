# 欢迎页独立组件验证（WelcomeRecents + WelcomeView）

本目录用于**独立验证** `fusion-native/Sources/Ketcher3D/WelcomeRecents.swift` 与 `fusion-native/Sources/Ketcher3D/WelcomeView.swift`，完全隔离于正式 MolStudio App 生命周期、本地服务端口（8462）、真实 `UserDefaults.standard` 和用户文档目录。

## 运行全部验证与截图

```sh
bash fusion-native/regression/welcome-component/run.sh
```

脚本依次完成：
1. 全量编译 `fusion-native/Sources/Ketcher3D/*.swift`（验证与 `main.swift`、`DocumentPDFExporter.swift` 无符号冲突与编译警告）。
2. 编译并执行 `test_welcome_component.swift`（临时目录 + 独立 `UserDefaults(suiteName:)`，验证跨目录合并、规范化去重、修改时间降序、缺失项保留、`.molwork` 模式探测、缩略图过期判断、搜索过滤与纸张默认设置恢复）。
3. 编译并启动独立宿主 `preview_host.swift --capture-screenshots`，在 `screenshots/` 下生成 4 张独立组件宿主截图：
   - `welcome-list.png`（列表视图）
   - `welcome-grid.png`（网格视图）
   - `welcome-narrow.png`（窄窗口响应式布局）
   - `welcome-empty.png`（无最近文件空状态）

## 交互式预览（可选）

```sh
swiftc -O -parse-as-library \
  fusion-native/Sources/Ketcher3D/WelcomeRecents.swift \
  fusion-native/Sources/Ketcher3D/WelcomeThumbnailCache.swift \
  fusion-native/Sources/Ketcher3D/WelcomeView.swift \
  fusion-native/regression/welcome-component/preview_host.swift \
  -o /tmp/molstudio-welcome-preview && /tmp/molstudio-welcome-preview
```

> 说明：以上截图和交互宿主均标明为“欢迎页独立组件宿主”，不代表主 MolStudio 应用已完成接线。
