# 当前画布文档模式：实现与验收记录

记录日期：2026-11-14。本页记录当前 `fusion/canvas.html` 的第一阶段与各次运行证据；[原方案](DOCUMENT_MODE.md)中的后续阶段不等于已经交付。产物目录 `.jez/artifacts/` 是本机忽略目录，不随源码分发。报告可能在重跑时更新，以各报告最终内容为准。

## 当前范围

当前画布有无边画布和纸页模式；化学结构、孤对电子、电子流、自由文字框、图片、形状使用同一画布坐标。纸页提供 A4 / Letter、横纵向、增页、删除空白末页、适合页面/宽度以及原生逐页 PDF。SwiftUI 欢迎页提供两种新建入口、打开、示例和最近文件；成功打开或保存后异步生成文件缩略图，并记录已确认的模式。缓存按文件身份和快照校验，过期或生成失败时回退占位图。

完整文档使用 `.molwork`：无 `document` 段保持 v1，有文档段使用 v2；v2 保存文档对象、页面与资源。`.ket` 不能代替完整工作台。模型在纸页可读取页面范围并进行有界自动排布；当前不是按页高自动分页。

尚未实现按页高自动分页、选区富文本格式/公式/Markdown。`research/document-editor-prototype/` 与 `.molnote` 是本地保留的独立半成品，未迁移、本轮不整理。

## 2026-11-14 本机构建

待交付应用：[MolStudio-Document-20261114.app](../fusion-native/dist/MolStudio-Document-20261114.app)。以下网页回归实际使用这个包的 Python、RDKit 和 `Contents/Resources/canvas.html`，隔离端口 49188；原生自测使用同包资源、独立 bundle ID 和端口 49189。没有覆盖已安装的应用，也没有提交或推送 Git。

| 检查 | 结果与边界 | 本机证据 |
| --- | --- | --- |
| 包内资源与源码、便携运行 | 33 个关键资源 SHA-256 全部一致；应用原路径和临时搬移路径的服务及签名检查均通过。 | [构建清单](../.jez/artifacts/document-final-20261114/build-manifest.json)，`.jez/document-final-portable.log` |
| 不调用真实模型的单元回归 | 520/520（239 runtime + 239 画布 + 42 文档/复制/插入）。 | `.jez/document-final-unit.log` |
| 正式包网页整合回归 | 105/105：混合编辑 26、原生对象 7、页面界面 22、文件插入与语义复制 28、原生预览 4、AI 桥 18。原生预览中的 contracted-group 合并分支是实际处理函数提取测试，其余相关放置由真实编辑器交互验证。 | [汇总](../.jez/artifacts/document-final-20261114/suite.json)，各子目录的 `report.json`、截图与 `.molwork` |
| 原生欢迎页、新纸页、保存重开和缩略图 | 独立取证包 10/10；真实 AppKit/WK 文件写入、干净基线、中文、化学、图片和形状重开后仍可编辑，且生成有效缩略图。未自动化 macOS 系统文件选择对话框。 | [原生报告](../.jez/artifacts/document-final-20261114/native/report.json)、[欢迎页](../.jez/artifacts/document-final-20261114/native/welcome.png)、[画布](../.jez/artifacts/document-final-20261114/native/canvas.png)、[可编辑文件](../.jez/artifacts/document-final-20261114/native/new-paper.molwork) |
| 正式包实际页面的原生 PDF | 混合页、纯文字页、原生中文页和最终咖啡因纸页各重复导出两次，共 32 项通过；物理纸张尺寸、非空内容、可选文字正确。混合、中文及咖啡因 PDF 已用 Poppler 渲染检查。该项使用真实页面 JSON 和匹配源码的独立 WK 导出探针，不代表系统保存面板的鼠标操作验收。 | [混合 PDF](../.jez/artifacts/document-final-20261114/pdf-mixed/probe.pdf)、[纯文字 PDF](../.jez/artifacts/document-final-20261114/pdf-pure/probe.pdf)、[中文 PDF](../.jez/artifacts/document-final-20261114/pdf-native-chinese/probe.pdf)、[咖啡因 PDF](../.jez/artifacts/document-final-20261114/pdf-live-caffeine/probe.pdf)，同目录 `report.json` |
| 同一正式包的真实模型 `caffeine-routes` | 最后续跑 2 次请求后 `completed`，两条独立路线、4 步、8 条电子流，路线分区、衔接、实际曲线可读性、纸页范围、完成提示及可编辑导出均通过。该轮 20/20 也包括前置 synthetic 和观察器检查。 | [最终真实模型报告](../.jez/artifacts/document-final-20261114/live-caffeine-final/report.json)、[完成窗口](../.jez/artifacts/document-final-20261114/live-caffeine-final/real-caffeine-routes.png)、[完整机理图](../.jez/artifacts/document-final-20261114/live-caffeine-final/real-caffeine-routes-mechanism.png)、[可编辑结果](../.jez/artifacts/document-final-20261114/live-caffeine-final/real-caffeine-routes.molwork) |
| 最终真实结果在同包保存重开 | 5/5：四步八条电子流重开后仍可编辑；混合移动共用一个撤销动作，一次撤销精确恢复作者内容；整页 SVG 无溢出警告，截图时真实页面缩略图已加载。这里没有再次请求模型。 | [重开报告](../.jez/artifacts/document-final-20261114/reopened-final-caffeine/report.json)、[适合整页的画布截图](../.jez/artifacts/document-final-20261114/reopened-final-caffeine/canvas.png)、[重开后可编辑文件](../.jez/artifacts/document-final-20261114/reopened-final-caffeine/editable.molwork) |

最终模型结果来自同一包的三轮连续任务：首轮 10 次请求、首次续跑 8 次请求均停在 `needs_continue`，最后续跑 2 次请求完成，共 20 次真实请求。前两轮的[原始报告](../.jez/artifacts/document-final-20261114/live-caffeine/report.json)和[首次续跑报告](../.jez/artifacts/document-final-20261114/live-caffeine-resumed/report.json)均保留为失败；除请求上限中断外，过程中还出现过上游流错误、一次已完整回滚的试剂排布拒绝，以及模型纠正误画底物后的路线重建，不把这些中间状态算作完成。最终一轮没有新的工具诊断错误。完成窗口使用 AI 的阅读焦点视口；整页展示图是在同包重开该结果并选择适合页面后拍摄，二者分别保存。

验收探针可选事务观察器另经 19/19 synthetic 验证：真实捕获 11 次桥调用（含 3 次预期拒绝），观察前后内容、选区、视口、历史和 dirty 均不变。失败的完整前后快照与操作可用于离线复现，见[观察器报告](../.jez/artifacts/document-transaction-observer-check/report.json)。

本轮页面增删仍限于新增页面、删除空白末页；文件插入保留源几何，不自动按纸宽重排。中间页重排、按页高自动分页和文字选区级富文本仍属后续范围。

## 混合剪贴板与跨文件插入

浏览器和原生 WK 画布默认使用同一次真实 DOM 剪贴板事件，同时携带 Ketcher 的化学格式与机理/文档附加数据。文字输入框内仍按普通文字处理。混合复制保留被复制原子的孤对及箭头绑定；完整反应步骤复制会重建步骤身份、参与分子、条件标签和续接端口命名。原生化学、标签、孤对、电子流和文档对象在放置后共用一个撤销动作，写剪贴板失败时不删除剪切源。

“插入文件…”和拖放接受 `.molwork` / `.ket`。菜单插入先预览，点击放置，Esc 取消；拖放在落点一次提交。完整工作台文件保留语义步骤与独立机理步骤清单，源页面设置不会覆盖当前文档。只有文档对象的文件使用纯文档预览，不创建占位原子。异步读取通过文档代次和请求序号隔离；粘贴预览期间保存、导出与 AI 读写拒绝读取临时原生几何。

源代码 `fusion/canvas.html` / 端口 49076 的独立 Electron 回归包含混合文件预览与取消、化学/孤对/电子流/文档一步撤销重做、零孤对完整路线重复插入、续接标签新身份、非单位键长和条件文字、混合语义移动，以及提交故障后的完整内容/选区/历史回滚。真实复制由可信 copy 事件产生原生化学 MIME，并以实际鼠标放置验证。该报告属于源代码构建，不代表后续原生包已经逐项复验：[报告](../.jez/artifacts/document-import-source/report.json)、[混合可编辑样例](../.jez/artifacts/document-import-source/mixed-import-editable.molwork)、[路线可编辑样例](../.jez/artifacts/document-import-source/zero-lp-route-editable.molwork)、[画布截图](../.jez/artifacts/document-import-source/canvas.png)。

## 分构建证据

| 应用、页面和构建 | 范围与结果 | 本机证据 |
| --- | --- | --- |
| 方法级原生控制流，提取 `fusion-native/Sources/Ketcher3D/main.swift` | 新纸页成功、取消、初始化失败及迟到回调，完整文档保存防丢，缩略图异步代次和快照隔离；241 项控制流和 11 项 JS 断言通过。不是 GUI 验收。 | `fusion-native/regression/run.sh`，默认 `/tmp/molstudio-regression/` |
| 欢迎缩略图缓存纯数据回归 | PNG 校验、外部文件、模式元数据、文件变化失效、另存与重命名迁移等 12 项通过。 | `fusion-native/regression/welcome-thumbnail/run.sh` |
| `/private/tmp/MolStudio-Thumbnail-Selftest-20261114.app`，当前 native 代码与先前自测包内画布资源，端口 49186 | 隔离原生 WK 自测：纸页与无边画布成功保存后分别生成 480 像素宽 PNG；外部文件最近列表合并与对应模式通过。两次自测有独立报告，不代表最终打包的其他源码版本。 | [纸页报告](../.jez/artifacts/welcome-thumbnail-native/report.json)、[纸页缩略图](../.jez/artifacts/welcome-thumbnail-native/thumbnail.png)、[画布报告](../.jez/artifacts/welcome-thumbnail-native/canvas-report.json)、[画布缩略图](../.jez/artifacts/welcome-thumbnail-native/canvas-thumbnail.png) |
| 隔离原生自测包 `/tmp/MolStudio-Document-P0-20261113-Selftest.app`，`fusion/canvas.html`，端口 49185 | 从欢迎页新建 A4，核对干净基线；F01 化学机理与中文、形状、图片经原生保存、重开后可编辑；截图和页面 JSON 均已保存。自测使用独立 bundle ID 与服务端口。 | [自测报告](../.jez/artifacts/document-native-final/report.json)、[欢迎页截图](../.jez/artifacts/document-native-final/welcome.png)、[画布截图](../.jez/artifacts/document-native-final/canvas.png)、[可编辑样例](../.jez/artifacts/document-native-final/new-paper.molwork) |
| 同一隔离自测包的真实画布 `exportPages()`，原生 WK PDF 探针 | 原生中文混合页重复生成 PDF；报告中两次页数、物理尺寸、非空和文字选择均通过。探针为独立 WK 导出链，非用户菜单交互验收。 | [PDF 报告](../.jez/artifacts/document-pdf-native-chinese/report.json)、[PDF](../.jez/artifacts/document-pdf-native-chinese/probe.pdf)、[重复导出](../.jez/artifacts/document-pdf-native-chinese/probe-repeat.pdf)、[原始页面 JSON](../.jez/artifacts/document-native-final/pages.json) |
| 源代码服务 `fusion/canvas.html`，隔离 Electron / 端口 49075 | 混合/纯文字画布、原生对象与混合剪贴板为独立真实编辑器回归，报告会随当前重跑更新。混合孤对复制及 back 对象/非单位键长的最终结果须按各自最终报告复核，不以其他构建结果代替。 | [文档真实回归报告](../.jez/artifacts/document-mode-real/report.json)、[原生对象报告](../.jez/artifacts/document-native-objects-source/report.json)、[混合样例](../.jez/artifacts/document-mode-real/mixed-paper.molwork)、[纯文字样例](../.jez/artifacts/document-mode-real/pure-text-paper.molwork) |
| 源代码画布的真实页面 JSON + 独立 WK PDF 探针 | 混合和纯文字各自两次导出的尺寸、非空与文字选择通过；该结果针对源代码服务，不代表其他包。 | [混合 PDF 报告](../.jez/artifacts/document-pdf-canvas/report.json)、[纯文字 PDF 报告](../.jez/artifacts/document-pdf-pure/report.json) |
| `/tmp/MolStudio-Document-P0-20261113-Final.app`，`fusion/canvas.html`，真实模型 | `caffeine-routes` 第一轮达到 6 次测试请求上限，状态 `needs_continue`，因此报告失败并保留断点；不能将其当作已完成。 | [首轮报告](../.jez/artifacts/document-mode-real-model/report.json)、[可编辑断点](../.jez/artifacts/document-mode-real-model/real-caffeine-routes.molwork)、[画布截图](../.jez/artifacts/document-mode-real-model/real-caffeine-routes.png) |
| `/tmp/MolStudio-Document-P0-20261113-Final2.app`，`fusion/canvas.html`，真实模型 | 从首轮 `.molwork` 断点续跑 2 次请求后 `completed`；报告记录两条路线、4 步、8 条电子流，纸页范围和布局核对通过。该结果是续跑而非 Final2 从零完成。 | [续跑报告](../.jez/artifacts/document-mode-real-model-resumed/report.json)、[可编辑结果](../.jez/artifacts/document-mode-real-model-resumed/real-caffeine-routes.molwork)、[画布截图](../.jez/artifacts/document-mode-real-model-resumed/real-caffeine-routes.png)、[机理导出](../.jez/artifacts/document-mode-real-model-resumed/real-caffeine-routes-mechanism.png) |
| `/tmp/MolStudio-Document-P0-20261113-Final3.app`，`fusion/canvas.html`，端口 49177 | 修正纸页自动文字锚点后，`npm test` 共 499/499（239 + 239 + 21），portable 检查通过；原生对象真实画布回归 7/7。`paper-label` 真实模型 1 次请求为 `completed`，保存的 KET 实际含准确 100 个 A。原探针错误地按 Draft blocks 读取，原报告仍为失败；修正为检查 KET paragraphs/parts 后，对原产物复核通过，没有再次请求模型。 | [原生对象报告](../.jez/artifacts/document-native-objects-final3/report.json)、[原始 paper-label 报告](../.jez/artifacts/document-mode-paper-label-live/report.json)、[文字复核](../.jez/artifacts/document-mode-paper-label-live/text-audit-rechecked.json)、[可编辑样例](../.jez/artifacts/document-mode-paper-label-live/real-paper-label.molwork) |

以上咖啡因用例只覆盖两条各两步 N-甲基化路线，不代表更长工业路线或任意机理已经验收。检查实际最终画布的路线分区、同行/换行衔接、每步电子流和完成提示；截图、报告及可编辑文件须来自所声明的同一轮运行。

## 复跑入口

- 不调用真实模型的单元测试和真实画布测试见 [画布开发说明](README.md)。
- `MOLSTUDIO_AGENT_PAPER_MODE=1` 的 `caffeine-routes` 以及 `MOLSTUDIO_AGENT_REAL_SEED_FILE` 断点续跑见 [AI 验收命令](agent/README.md)。
- 原生方法回归、逐页 PDF、真实画布页面 JSON 输入和隔离 native 自测环境见 [原生回归说明](../fusion-native/regression/README.md)。

## 页面 UI 与文件入口验收

当前源代码 `fusion/canvas.html`，隔离 Electron 服务 49076。22/22 项真实 UI 检查通过，无真实模型调用。覆盖按稳定 `pageId` 导航、可见页 `previewPages()` 与最多 8 项缩略图缓存、缩放/适合页面不改文档或历史；100% / 125% 输入和适合宽度在展开面板时保留可用视口。A4 边距以毫米输入并换算为点，改动前后原子、电子流及文档对象坐标一致。纸页模式隐藏实测的 Ketcher `zoom-selector`，切回无边画布后恢复；设置和全屏按钮保持可见。

IME 合成期间触发缩略图刷新，草稿没有写入模型、历史或保存状态；文字内容和形状填充修改会更新预览缓存。真实鼠标拖动保留对象 `pageId`，一次撤销恢复原坐标。窄至 780px 时页面栏折叠且不遮挡化学工具，页面设置面板可关闭。真实文件选择入口接受 `.molwork` / `.ket`；用 `.molwork` 混合机理文件实际预览、放置后，一次撤销恢复原画布；纯文档文件跟随鼠标预览后按 Esc 取消，不改动原文档。 自动化测试点击入口并向实际文件输入控件交付 `File` 对象；macOS 系统文件对话框本身未自动化。

| 当前画布构建 | 本机证据 |
| --- | --- |
| 源代码 `fusion/canvas.html`，隔离 Electron / 端口 49076；`MOLSTUDIO_TEST_BUILD=current MolStudio canvas source at fusion/canvas.html, isolated service 49076` | [22 项报告](../.jez/artifacts/document-pages-ui-real/report.json)、[可编辑样例](../.jez/artifacts/document-pages-ui-real/paper-ui-sample.molwork)、[整页截图](../.jez/artifacts/document-pages-ui-real/paper-ui-canvas.png)、[窄屏截图](../.jez/artifacts/document-pages-ui-real/paper-ui-canvas-narrow.png) |
