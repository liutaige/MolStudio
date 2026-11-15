# MolStudio SwiftUI 欢迎页组件交接文档

交付日期：2026-11-13  
范围：独立 SwiftUI 欢迎页组件、纯读最近文件扫描/合并逻辑与隔离验证套件（未修改 `main.swift`、`Package.swift`、`build-app.sh`、`fusion/` 或 `research/`）。

集成更新（2026-11-14）：该组件现已接入原生应用，并增加 `WelcomeThumbnailCache.swift` 自动缩略图与模式缓存。下面保留初次独立交付时的契约和接线说明；实际集成范围、后续修正及分构建证据以[文档模式验收记录](../fusion/DOCUMENT_MODE_RESULTS.md)为准。

---

## 1. 交付文件清单（严格遵守文件所有权）

| 文件路径 | 职责 |
| --- | --- |
| `fusion-native/Sources/Ketcher3D/WelcomeRecents.swift` | 模式/纸张设置值类型、纯读目录扫描、跨目录合并、规范化路径去重、`.molwork` 首部 4 KB 模式探测与缩略图解析 |
| `fusion-native/Sources/Ketcher3D/WelcomeView.swift` | `WelcomeViewModel`（搜索、视图偏好、纸张默认设置持久化）与 `WelcomeView`（浅色青色工具台风格、三入口卡片、列表/网格切换、右键菜单、缺失项与空状态、文件拖放、VoiceOver 无障碍） |
| `fusion-native/regression/welcome-component/test_welcome_component.swift` | 临时目录 + 独立 `UserDefaults(suiteName:)` 的单元测试 |
| `fusion-native/regression/welcome-component/preview_host.swift` | 独立组件预览与截图宿主（窗口标题明确标注“欢迎页独立组件宿主”，完全隔离正式 App 端口与用户数据） |
| `fusion-native/regression/welcome-component/run.sh` | 一键验证脚本（独立模块编译 + 全量源码快照编译 + 单元测试 + 截图生成） |
| `fusion-native/regression/welcome-component/README.md` | 独立验证与预览说明 |
| `fusion-native/regression/welcome-component/screenshots/*.png` | 独立组件宿主渲染截图（列表、网格、窄窗、空状态） |
| `fusion-native/WELCOME_COMPONENT_HANDOFF.md` | 本交接文档 |

---

## 2. 公开组件契约（模块内可见，无 AppDelegate / JS 依赖）

### 2.1 数据模型与纸张配置（`WelcomeRecents.swift`）

- **`WelcomeDocumentMode`**：`.canvas`（无边画布）、`.paper`（纸页文档），`String` rawValue 与 `fusion/workbench/document-model.js` 对齐（`"canvas"` / `"paper"`）。
- **`WelcomePaperSize`**：`.a4`（`595.28 × 841.89 pt`，`210 × 297 mm`）、`.letter`（`612.0 × 792.0 pt`，`216 × 279 mm`）。
- **`WelcomePaperOrientation`**：`.portrait`（纵向）、`.landscape`（横向）。
- **`WelcomePaperMargins`**：`top / right / bottom / left`（`Double`，默认 `.standard = 56.7 pt`，约 20 mm）。
- **`WelcomePaperSetup: Codable, Equatable, Sendable`**：
  - 默认：`size = .a4`、`orientation = .portrait`、`margins = .standard`、`ptPerBond = 14.4`。
  - 参数映射方法：
    - `toDocumentInitPayload(pageCount: Int = 1) -> [String: Any]`：返回 `{"mode":"paper","size":...,"orientation":...,"ptPerBond":14.4,"pageCount":1,"margins":{top,right,bottom,left}}`，直接对齐 `MolWorkbench.documentModel.createDocument(options)`。
    - `toJSONString(pageCount: Int = 1) -> String?`：供 `main.swift` 传入 JS 桥接调用。
- **`WelcomeRecentViewMode`**：`.list`（列表）、`.grid`（网格）。
- **`WelcomeExampleItem: Identifiable, Equatable, Sendable`**：`id: String`、`title: String`、`subtitle: String?`（完全由宿主注入，组件内不硬编码假文件）。
- **`WelcomeRecentItem: Identifiable, Equatable, Sendable`**：`id`（规范化路径）、`url`、`displayName`、`modifiedAt`、`exists`、`thumbnailURL`、`mode: WelcomeDocumentMode?`，以及 `pathHint`（`~` 缩写目录提示）、`typeLabel`。

### 2.2 最近文件扫描与合并（`WelcomeRecents`）

- `WelcomeRecents.loadMergedRecents(recentURLs:appDirectoryURL:thumbnailsDirectoryURL:excludedCanonicalPaths:)`
  - 默认读取 `NSDocumentController.shared.recentDocumentURLs` 并与 `appDirectoryURL`（使用 POSIX `opendir`/`readdir` 扫描）合并；
  - 使用 `canonicalPath(for:)` 对软链接及缺失文件祖先路径归一化去重；
  - 保留缺失项（`exists == false`）排在已有文件之后，不主动删除用户文件；
  - 已有文件按 `contentModificationDate` 降序排列；
  - 仅读取 `.molwork` 前 4096 字节判断 `.paper` / `.canvas`，不读取整份文件或任何配置密钥；
  - 缩略图按 `<thumbnailsDirectoryURL>/<sha1(canonicalPath)>.png` 解析，当文件 `modifiedAt` 晚于缩略图超过 1 秒时视为过期并回退占位图。

### 2.3 ViewModel 与 SwiftUI 视图（`WelcomeView.swift`）

- **`WelcomeViewModel: ObservableObject`**：
  - 接受注入 `defaults: UserDefaults`、`appDirectoryURL`、`thumbnailsDirectoryURL`、`examples`、`recentURLsProvider`。
  - 持久化键：`MolStudioWelcomePaperSetup`、`MolStudioWelcomeViewMode`、`MolStudioWelcomeRemovedRecents`、`lastFile`。
  - 提供 `reloadRecents(...)`、`reloadRecentsAsync(...)`（后台线程扫描避免阻塞 UI）、`removeRecent(_:)`、`noteOpened(_:)`、`clearSearch()`。
- **`WelcomeView: View`**：
  - 接收 `model: WelcomeViewModel` 与 8 个闭包回调：
    - `onNewCanvas: () -> Void`
    - `onNewPaper: (WelcomePaperSetup) -> Void`
    - `onOpenPanel: () -> Void`
    - `onOpenURL: (URL) -> Void`
    - `onOpenExample: (WelcomeExampleItem) -> Void`
    - `onRemoveRecent: (WelcomeRecentItem) -> Void`
    - `onRequestRename: (WelcomeRecentItem) -> Void`
    - `onRevealInFinder: (WelcomeRecentItem) -> Void`

---

## 3. 编译命令与验证结果

### 3.1 可复跑命令

```sh
bash fusion-native/regression/welcome-component/run.sh
```

脚本执行以下四步（全部退出码为 `0`）：
1. 独立模块编译（`-parse-as-library -wmo -emit-object -emit-module`）编译 `WelcomeRecents.swift` + `WelcomeView.swift`，零错误、零警告。
2. 全量源码快照编译（复制 `fusion-native/Sources/Ketcher3D/*.swift` 至临时目录并加 `-lz` 编译链接），确认与 `main.swift` 及并行开发的 `DocumentPDF*.swift` 无符号冲突。（说明：由于并行代理正在原地更新 `DocumentPDFOccurrence.swift`，直接原地跑 `swiftc Sources/Ketcher3D/*.swift` 可能遇到“文件在编译期间被修改”，复制快照编译可稳定验证；另外 `build-app.sh` 后续由 Codex 接线时需视 `DocumentPDFTextMapping.swift` 是否继续使用 zlib 决定是否补充 `-lz`。）
3. 隔离单元测试 `test_welcome_component.swift`（临时目录 + 独立 `UserDefaults(suiteName:)`）：全部断言通过。
4. 独立预览宿主 `preview_host.swift --capture-screenshots`：生成 4 张 PNG 截图。

### 3.2 已生成截图（均来自“欢迎页独立组件宿主”，非主 MolStudio 集成）

- `fusion-native/regression/welcome-component/screenshots/welcome-list.png`（`820×580`，列表视图，含纸页缩略图、多目录路径提示、缺失项标记与一键移除）
- `fusion-native/regression/welcome-component/screenshots/welcome-grid.png`（`820×580`，网格视图，含 480 px 缩略图预览与模式占位卡）
- `fusion-native/regression/welcome-component/screenshots/welcome-narrow.png`（`540×580`，窄窗口自适应折叠为 2+1 卡片与紧凑列表）
- `fusion-native/regression/welcome-component/screenshots/welcome-empty.png`（`820×580`，无最近文件空状态）

### 3.3 已验证 vs 未验证范围

- **已验证（独立组件宿主与单元测试）**：
  - SwiftUI 视图与状态管理在 macOS 14 部署目标下的独立编译和完整 Target 符号兼容；
  - 跨目录（App 目录 + 外部目录 `recentURLs`）合并、软链接及缺失文件规范化去重、修改时间降序、缺失项排序与不删盘策略；
  - `.molwork` 首部 4 KB 模式区分（v2 `paper` vs v1 `canvas`）与缩略图过期判定；
  - `WelcomePaperSetup`（默认 A4 纵向）与视图模式/移除记录在隔离 `UserDefaults` 中的持久化恢复；
  - 搜索过滤（按名称/路径/类型）、空状态文案、窄窗口排版及自定义青色分段控件渲染。
- **未验证（需 Codex 接入 `main.swift` 与 JS 画布后验收）**：
  - 主 `MolStudio.app` 内的 `NSHostingView` 宿主窗口关闭/重开生命周期（`windowShouldClose`）；
  - `actNewDocument(mode:paperSetup:)` 与 `MolStudio.document.init(...)` 的真实 WKWebView 建页链路；
  - 打开/保存成功后的 `NSDocumentController.shared.noteNewRecentDocumentURL(url)` 系统菜单联动及真实缩略图生成/重命名迁移；
  - 主应用右键重命名弹窗与主窗口画布切换交互。

---

## 4. 需要 Codex 在 `main.swift` 中接线的具体位置与示例

1. **扩展 `PendingPayload`（`main.swift:167-172`）**：
   ```swift
   enum PendingPayload {
       case none
       case newDocument(mode: WelcomeDocumentMode = .canvas, paperSetup: WelcomePaperSetup? = nil)
       case openCanvasFile(text: String, url: URL)
       case restoreSession(text: String)
   }
   ```

2. **替换 `showWelcome()`（`main.swift:1262`）与新增 `WelcomeViewModel` 属性**：
   - 在 `AppDelegate` 持有 `private var welcomeModel: WelcomeViewModel?`（传入 `appDirectoryURL: docsDir`、`thumbnailsDirectoryURL: docsDir.appendingPathComponent("thumbnails", isDirectory: true)`、`examples: exampleDocumentURL() != nil ? [WelcomeExampleItem(id: "oh-ch3br", title: "OH⁻ + CH₃Br Sₙ2 机理", subtitle: "1 对孤对电子 + 2 根弯箭头")] : []`）。
   - 在 `showWelcome()` 中若 `welcomeWin == nil`，创建 `NSHostingView(rootView: WelcomeView(...))` 赋给 `w.contentView`；每次回到欢迎页时调用 `welcomeModel?.reloadRecentsAsync()`。
   - 闭包接线：
     - `onNewCanvas`: `self?.startNewDocument(mode: .canvas, paperSetup: nil)`
     - `onNewPaper`: `{ setup in self?.startNewDocument(mode: .paper, paperSetup: setup) }`
     - `onOpenPanel`: `self?.actOpen()`
     - `onOpenURL`: `{ url in self?.openDocument(at: url) }`
     - `onOpenExample`: `{ _ in self?.actOpenExample() }`
     - `onRemoveRecent`: `{ item in ... }`（可同步更新本地移除列表或通知 `NSDocumentController`）
     - `onRequestRename`: `{ item in self?.renameRecentFile(at: item.url) }`
     - `onRevealInFinder`: `{ item in NSWorkspace.shared.activateFileViewerSelecting([item.url]) }`

3. **更新 `refreshFileList()`（`main.swift:1235`）与记录系统最近文件**：
   - `refreshFileList()` 改为调用 `welcomeModel?.reloadRecentsAsync()`；
   - 在 `applyPending` 的 `.openCanvasFile` 成功提交 `s.fileURL = url` 后（`main.swift:1580` 附近）以及 `saveSession` 的 `commit` 成功写盘后（`main.swift:1813` 附近），调用：
     ```swift
     let canonicalURL = URL(fileURLWithPath: WelcomeRecents.canonicalPath(for: target))
     NSDocumentController.shared.noteNewRecentDocumentURL(canonicalURL)
     welcomeModel?.noteOpened(canonicalURL)
     ```
   - 在重命名（`main.swift:2839` 附近）与另存为成功后，如需迁移缩略图，可使用 `WelcomeRecents.sha1Hex(WelcomeRecents.canonicalPath(for: oldURL))` 和 `newURL` 对应的 `<sha1>.png` 进行移动/复制。

4. **菜单与新建入口（`main.swift:660`、`1371`、`1534`）**：
   - 文件菜单保留 `新建画布`（`⌘N`）与新增 `新建纸页…`（`⇧⌘N`，可使用 `welcomeModel?.paperSetup ?? WelcomePaperSetup()`）；
   - `applyPending` 处理 `.newDocument(let mode, let paperSetup)` 时，在 `mode == .paper` 且页面就绪后，将 `paperSetup?.toJSONString()` 传入 JS 初始化：
     ```swift
     if mode == .paper, let json = (paperSetup ?? WelcomePaperSetup()).toJSONString() {
         // 在 freshBaselineAfterPageReady 前等待 JS 初始化纸页模式：
         // window.k3dAPI.initDocument(JSON.parse(json)) 或 MolStudio.document.init(...)
     }
     ```
