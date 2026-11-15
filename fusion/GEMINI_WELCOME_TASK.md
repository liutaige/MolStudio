# Gemini 并行任务：MolStudio SwiftUI 欢迎页组件

任务日期：2026-11-13。工作目录：`/Users/tiger/MolStudio`。

## 目标

实现能编译、能交互的原生 SwiftUI 欢迎页组件，供正在开发的新纸页模式接入。不是仅写设计稿。本轮由 Codex 处理化学画布、文档模型、选择与撤销、保存格式和最终接线；你只处理独立的欢迎页组件。

先读根 `AGENTS.md`、`README.md`、`fusion/DOCUMENT_MODE.md`，再读 `fusion-native/Sources/Ketcher3D/main.swift` 的 `showWelcome()`、最近文件与新建/打开方法，以及 `fusion-native/Package.swift`、`build-app.sh`。现有文档原型 `research/document-editor-prototype/` 保持不动，不能因为本任务而降级、迁移或删除。不要修改 Git/GitHub 范围。

## 文件所有权（严格遵守，其他代理正在同一工作区工作）

只允许新增或修改：

- `fusion-native/Sources/Ketcher3D/WelcomeView.swift`
- `fusion-native/Sources/Ketcher3D/WelcomeRecents.swift`（如需要，可不用）
- `fusion-native/regression/welcome-component/` 内的独立验证脚本、轻量宿主和说明
- `fusion-native/WELCOME_COMPONENT_HANDOFF.md`

不要修改 `main.swift`、`Package.swift`、`build-app.sh`、`fusion/canvas.html`、`fusion/workbench/`、`fusion/agent/`、`fusion/DOCUMENT_MODE.md`、根 README/AGENTS 或 `research/`。不要安装依赖、更新锁文件、提交、切分支、推送。不要清理未跟踪文件。集成由 Codex 完成；如果认为必须更改受限文件，把精确建议写入交接文档。

## 界面与交互

部署目标 macOS 14，使用系统 SwiftUI、AppKit、Foundation，不增加第三方库。

- 上方产品名 MolStudio 与自然的能力说明，搜索框用于过滤最近文件。
- 第一行三个清晰入口：无边画布、纸页、打开文件。纸页卡中可选择 A4/Letter、横向/纵向；默认 A4 纵向，记住上次设置。打开卡可附示例菜单，示例列表由宿主传入，不硬编码假文件。
- 下方真实最近文件，支持列表/网格切换；名称、路径提示、修改时间、可选缩略图。
- 最近文件右键：打开、在 Finder 中显示、重命名、从列表移除；删除文件不在本轮范围，避免组件擅自执行不可恢复动作。
- 缺失文件显示不可打开状态，并允许从最近列表移除。搜索无结果和没有最近文件要有自然空状态。
- UI 采用紧凑浅色工具风格、青色强调，参考 `research/document-editor-prototype/DESIGN.md` 的颜色/间距，但不要搬入 Web UI；适配小窗口，键盘焦点和 VoiceOver 标签完整。
- 不显示 schema/hash/内部目录名等开发术语。系统默认中文界面即可。

## 组件契约

组件不能依赖 AppDelegate、现有私有类型或当前 JS 画布 API。请定义公开到模块内的简单值类型，例如：

- `WelcomePaperSetup`：纸型、方向（必要时页边距默认值）；能转为 Codable 参数。
- `WelcomeRecentItem`：稳定身份、文件 URL、显示名称、修改时间、是否存在、可选缩略图 URL、可选模式 canvas/paper。
- `WelcomeExampleItem`：宿主给定 id 和标题。
- `WelcomeViewModel: ObservableObject`：最近列表、搜索、视图偏好和纸张默认设置。偏好可用注入的 UserDefaults，测试应使用独立 suite；不改用户真实配置。
- `WelcomeView`：接受 model 与 action closures：新建画布、新建纸页(setup)、打开选择框、打开 URL、打开示例、从最近移除、请求重命名。Finder 显示可以作为 closure，方便宿主统一处理。

明确最近列表数据来源：提供纯读扫描/合并 helper，将 `NSDocumentController.shared.recentDocumentURLs` 与 App 目录传入的文件合并、按规范化 URL 去重并按修改时间降序；不要把“最近文件”限制为 App 文件夹。接受缺失项，不主动删除用户文件。枚举文件不应阻塞 UI，避免读取整个 molwork 或任何模型密钥。缩略图由宿主后续保存流程提供，本轮缺失时用模式占位图。

不需要在本轮接线 `actNewDocument` 或 JS。请在交接中给出拟议的宿主调用例子和模式/纸张设置参数映射，确保对现有源类型没有编译依赖。

## 验证与交付

1. 编译或 typecheck 实际组件，给出完整可复跑命令。若新增独立预览宿主，必须与正式 App 文件生命周期隔离。
2. 使用临时目录/临时 UserDefaults 验证：最近文件跨目录合并、去重、排序、缺失项、搜索、纸张默认设置恢复；不操作真实最近记录或已有用户文件。
3. 实际显示组件，保留列表/网格/空状态以及较窄窗口截图，标明是“欢迎页独立组件宿主”，不能声称主 MolStudio 集成已完成。
4. 在 `WELCOME_COMPONENT_HANDOFF.md` 列出文件、API、编译结果、截图路径、已验证行为、未验证内容，以及需要 Codex 在 main.swift 中接线的具体位置。

不得把预览截图当作主应用已验收。完成后停止，不扩展到画布或其他代理负责的文件。
