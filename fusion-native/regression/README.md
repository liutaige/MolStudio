# 原生画布回归（不启动 GUI）

从 `fusion-native/Sources/Ketcher3D/main.swift` **逐字提取真实方法体**，用 AppKit/WebKit 替身驱动控制流，验证画布的退出、关闭、导航、保存、未收敛警告和服务诊断。

```sh
bash fusion-native/regression/run.sh
OUT_DIR=/tmp/my-run bash fusion-native/regression/run.sh
```

当前用例：**250 项控制流断言 + 11 项真实方法生成的 JavaScript 快照/导出断言**。生成物写在 `OUT_DIR`（默认 `/tmp/molstudio-regression`），不进入源码历史。

- 修改 `applicationShouldTerminate`、`confirmDiscard`、`startNavigation`、`abortNavigation`、`applyPending`、`saveSession` 或 `fetchSnapshot`、整理请求与结果提示后重跑。
- 关闭与退出覆盖：保存/不保存/取消、真实写盘失败、迟到轮询、关闭后新建/打开、欢迎页退出及读取失败的明确放弃入口。
- 导航覆盖：导航期间禁止提交空页快照，固定恢复文本，迟到注入失效，注入失败回退原画布，页面超时/崩溃后保留内存内容。
- 整理覆盖：连续点击只发送一次，完成或失败后恢复；导航作废旧请求，迟到回调不清除新请求的忙状态，也不在新页面显示旧结果。
- 保存覆盖：会话替换、导航、关闭、重命名或后发保存使旧回调失效；保存期间的新编辑保持未保存；最终快照新增机理时禁止有损格式。
- 一致性覆盖：MOL/SMILES 导出前后读取完整快照，期间发生编辑时拒绝混版保存；`test-snapshot-exports.cjs` 直接执行真实 Swift 方法生成的 JavaScript。
- 离开前复查：关闭、新建、打开与退出前，确认保存期间没有新增修改；复查失败时保留画布。
- 旧 `.mechdoc` 格式明确拒绝，不导航、不修改当前画布。

2026-11-11 整理移除了旧 ChemDoodle 页面及双模式会话。原 189 项中退休了39条仅针对旧文档/跨模式行为的断言，新增8条单画布恢复、打开失败回退和拒绝旧格式的断言。当前画布保存竞态与快照一致性覆盖继续保留。

这些是方法级控制流测试，不能替代最终应用的真实 AppKit 面板、快捷键、WebKit 加载及画布截图验收。此套测试包含当前画布的纸页初始化、失败回退与完整文档保存控制流；本地研究目录中的独立 `.molnote` 文档应用不属于此套测试。

## 文件打开保护

异步 SMILES 打开覆盖快速 A/B 打开、同画布等待期间继续编辑、取消打开/新建/关闭/退出撤销旧请求、迟到失败静默，以及确认后/模态确认期间新增编辑。新打开或取消发生在确认快照、确认保存或保存后复查等待期间时，过期的成功/失败回调不会再弹确认或错误。工作台打开覆盖 compact/pretty/BOM JSON、顶层格式识别、缺失或不受支持的版本、损坏文件不降级为 KET，失败保留当前内容。

先运行上述回归生成真实 Swift 方法的加载脚本，再启动当前画布服务，可以在真实 Ketcher 中执行该脚本，确认 F01 的 3 原子、1 孤对和 2 机理箭头全部保留：

```sh
MOLSTUDIO_PORT=48975 env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron \
  fusion-native/regression/test-workbench-open.cjs /tmp/molstudio-regression/fixtures
```

默认将截图、可编辑 `.molwork` 和报告放在 fixtures 下的 `workbench-open/`；使用 `MOLSTUDIO_NATIVE_TEST_OUT` 指定其他输出目录。

## 当前画布：PDF 与原生自测

PDF 纯数据和字形映射测试不调用模型；WebKit 探针逐页捕获并合并为矢量 PDF，检查纸张尺寸、重复导出、图片及中文选择。运行环境需允许本机 WebKit 使用 macOS 服务：

```sh
fusion-native/regression/document-pdf/unit.sh
fusion-native/regression/document-pdf/run.sh
```

用真实画布的 `await k3dAPI.document.exportPages()` 返回值（完整 `{ok,pages,warnings}` JSON）检查 WK PDF，两次输出写入独立目录：

```sh
MOLSTUDIO_PDF_PAGES_JSON=/absolute/path/to/pages.json \
  MOLSTUDIO_PDF_OUT_DIR=/absolute/path/to/pdf-artifacts \
  MOLSTUDIO_TEST_BUILD=/absolute/path/to/tested.app \
  MOLSTUDIO_PDF_EXPECT_TEXT='预期文字' \
  fusion-native/regression/document-pdf/run.sh
```

查看 `report.json`、两份 PDF 和逐页渲染；无法安全确认中文映射或页资源时导出应失败，不应视为成功。

`MOLSTUDIO_SELFTEST=document` 与 `MOLSTUDIO_SELFTEST=clipboard` 只存在于用 `-D MOLSTUDIO_SELFTEST` 编译的原生自测包中。使用隔离 bundle ID、独立服务端口和新的输出路径，避免影响日常应用和最近文件。将下例可执行文件替换成实际的隔离自测 `.app`：

```sh
MOLSTUDIO_SELFTEST_PORT=49185 MOLSTUDIO_SELFTEST=document \
  MOLSTUDIO_SELFTEST_OUT=/absolute/path/to/report.json \
  MOLSTUDIO_SELFTEST_SAVE=/absolute/path/to/new-paper.molwork \
  MOLSTUDIO_SELFTEST_WELCOME_PNG=/absolute/path/to/welcome.png \
  MOLSTUDIO_SELFTEST_CANVAS_PNG=/absolute/path/to/canvas.png \
  MOLSTUDIO_SELFTEST_PAGES_JSON=/absolute/path/to/pages.json \
  /absolute/path/to/MolStudio-Selftest.app/Contents/MacOS/MolStudio
```

保存目标必须不存在。自测从真实欢迎页触发新纸页，验证初始干净状态、F01 机理与中文/图片/形状、原生保存重开与可编辑状态；截图与页 JSON 使用指定路径。它是自测构建，不代表正式 `.app` 的窗口或所有鼠标操作已验收。欢迎组件的独立宿主另见 [welcome-component](welcome-component/README.md)，实际证据与构建标签见 [文档模式结果](../../fusion/DOCUMENT_MODE_RESULTS.md)。

## 原生工作区组件与跨语言契约夹具

验证原生 Split/Inspector/Agent/Toolbar 组件与真实 JS 桥接器（`canvas-viewport.js`、`native-ui-bridge.js`、`native-renderer.js`）之间的序列化、状态机收敛与脱敏契约：

```sh
bash fusion-native/regression/workspace-components/run.sh
```

脚本先用 `fusion-native/regression/workspace-components/gen_js_fixtures.cjs` 在真实 JSDOM 中执行 JS 桥接与渲染器并生成最新 `fixtures/contract-fixtures.json`（含嵌套敏感字段脱敏夹具），再用 macOS 14.0 + Xcode SDK（`--build-system native`，`vtool` 验证 `minos 14.0` 与当前 `sdk`）编译运行 `WorkspaceComponentTests.swift`（当前 13 项分组用例，含 `RealJSFixtureCrossLanguageDecodeAndStateSync` 与 `IntegrationReviewFocusAndAppearanceFixes`）。

## 纸页文字浮条：真实 AppKit / WKWebView 控件

独立服务和独立原生窗口验证文字草稿、跨 iframe 焦点、原生字体选择、连续字号输入、原生颜色弹层色块、对齐和行距。字段使用 AppKit 鼠标和键盘事件；不通过 JavaScript 设置字段值或伪造 change。完成时检查 DOM、模型、快照、保存重开、单次撤销/重做、取消及空历史。运行期间需保留测试窗口前台，避免其他 GUI 回归抢焦点。

```sh
MOLSTUDIO_PORT=49166 npm --prefix fusion start
# 另一个终端：
MOLSTUDIO_PORT=49166 MOLSTUDIO_NATIVE_TEST_OUT=/tmp/molstudio-text-format-native \
  MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
  fusion-native/regression/document-text-format/run.sh
```

输出 `report.json`（含真实输入事件记录）、`canvas.png` 和可编辑 `formatted-text.molwork`。检查待交付构建时，让独立服务读取该构建的画布资源并明确标注构建路径；此探针自身不是完整产品壳验收。

## 原生形状拾色：完整 Workspace 宿主焦点

此 GUI 回归使用真实 `WorkspaceSplitViewController`、属性浮窗、`WorkspaceCommitColorWellView`、WKWebView 和 AppKit 鼠标事件，覆盖拾色面板取得 key 后保持编辑会话及父浮窗、转到普通窗口后仍正常取消。只有 JavaScript bridge 状态是内存夹具；颜色提交与文档持久化仍需组件及完整应用验收。运行时保留测试窗口前台，不与其他 GUI 回归并行。

```sh
MOLSTUDIO_NATIVE_TEST_OUT=/tmp/molstudio-color-picker-host \
  fusion-native/regression/document-color-picker-host/run.sh
```

输出 `report.json`，含三条宿主级断言与窗口/面板/所有权快照。此用例专门防止“组件测试通过，但宿主 window resign 立即取消原生拾色”再次出现。
