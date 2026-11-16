# MolStudio 画布

此目录是当前化学画布的网页、Python 服务与回归工具。macOS 应用外壳和打包入口在 [fusion-native](../fusion-native/PACKAGING.md)。画布的安装、构建和测试不依赖其他应用。

## 开发与构建

首次准备开发环境，在仓库根目录运行。已有 `.venv-rdkit` 时保留现有环境，跳过创建步骤：

```sh
uv venv --python 3.12.13 .venv-rdkit
uv pip install --python .venv-rdkit/bin/python --only-binary :all: 'rdkit==2026.9.1' 'numpy==2.5.4' 'pillow==13.0.0'
```

准备 Node 依赖及 AI 浏览器资源：

```sh
npm --prefix fusion ci
npm --prefix fusion/agent ci --ignore-scripts
npm --prefix fusion run build:agent
```

Python/RDKit 的开发环境与原生打包要求见原生打包说明。启动当前画布服务：

```sh
npm --prefix fusion start
```

服务默认使用 `.venv-rdkit/bin/python` 和端口 48975；打开 `http://127.0.0.1:48975/canvas.html`。端口及解释器可以通过环境变量配置：

```sh
MOLSTUDIO_PORT=49075 MOLSTUDIO_PYTHON=/absolute/path/to/python npm --prefix fusion start
```

解释器须已安装 RDKit。此命令启动当前 Python 服务；桌面应用请使用原生构建：

```sh
npm --prefix fusion run build -- /tmp/MolStudio.app
```

`build`、`build:native` 和 `dist` 都使用同一个原生打包脚本，参数是输出 `.app` 路径。省略路径时使用脚本默认的 `fusion-native/dist/MolStudio.app`。已存在的应用包默认不会被覆盖，详见原生打包说明。只构建 AI 浏览器资源可用 `npm --prefix fusion run build:agent`。

旧 Electron 产品外壳和 electron-builder 配置已经移除。这里保留固定版本的 Electron，仅供真实 Ketcher 浏览器回归使用；它不再负责启动或分发 MolStudio 产品。

## 画布文档模式（第一阶段）

当前 `canvas.html` 支持无边画布和纸页两种模式，化学结构、机理、自由文字框、图片及形状共用画布坐标。纸页提供 A4 / Letter、纵横方向、页面设置、增页与删除空白末页、适合页面/宽度以及原生逐页 PDF 导出。原生欢迎页可新建画布或纸页，也显示系统最近文件与应用目录中的文件。

纸页平移时，文档四边的外部留白最多占可用编辑区对应宽度或高度的 20%；整份文档在某方向小于视口的 60% 时，该方向保持居中。可用区域扣除页面侧栏、设置面板和原生浮条；多页之间连续滚动，到首尾边界停止。此限制统一用于滚轮、Shift 横滚和手形拖动，不改变文档坐标或撤销历史。

纯原生画布的 `.molwork` 保持 v1；带文档层的画布或纸页使用 v2，保存页面、对象、资源和区域。v1 仍可打开；不能识别 v2 的旧构建会拒绝该版本。带文档层的完整工作台须保存为 `.molwork`；`.ket` 等交换格式不能保存文字、图片、页面及完整机理。物理比例默认 14.4 pt / 键长，页面坐标不包含视口平移。

纸页中的“3D 分子预览”先显示交互预览：拖动调整视角、选择球棍/棍状/线框/空间填充样式，点击“确认插入”后才创建对象；取消或 Esc 不更改文档。插入的 PNG 背景透明，双击对象可再次调整，“确认保存”将视角和预览图作为一次可撤销的编辑保存。`.molwork` 保留源分子与完整旋转方向，重新打开仍可编辑。后台未保存检测及保存快照会读取文本草稿，保持文字编辑框和焦点；中文输入法组合期间不输出未完成的文字。

分子放大或缩小后，“整理结构”保留各分子的比例；继续接键、绘制碳链、添加元素或环模板时，新增部分沿用附着分子的比例。另起一个独立分子仍使用默认大小。文档中的 3D 图片会自动收紧透明边距、保留少量安全边；编辑视角、换样式及从源结构更新均保留图片尺寸和长宽比。

原生几何形状工具选中后会打开属性面板，可在绘制前设置默认描边、线宽、线型、填充与圆角；选择已有形状后可调整该对象。颜色使用原生拾色器，线宽和圆角以 pt 显示；无填充可单独切换，圆角仅用于矩形。改动可撤销，并随 `.molwork` 保存。形状工具采用文档对象层，原有 Ketcher 绘图对象仍可读取。

“整理结构”在已有坐标上拟合键长和化学键角，优先减小移动量，保留每个分子的中心、比例、原子身份和取代基侧别。等长但夹角错误的碳链、拖动变形的环和局部重叠也会尝试修正；已规范的结构保持原样，不产生空撤销记录。不自动重排整张图或交换机理中 H / Br 的方向。约束冲突、重合成键原子等无法安全修正的情况会保留，并明确提示；原生窗口会显示整理进度和结果。

“插入文件…”和拖放可将 `.molwork` / `.ket` 加入当前画布：菜单插入先预览，点击放置，Esc 取消；拖放按落点提交，整份插入一次撤销。`.molwork` 保留完整步骤、原生标签、孤对、电子流和文档对象，复制步骤及续接标签会分配新的身份；源文件页面设置不覆盖目标文档。`.ket` 插入其原生化学及绘图对象。浏览器与原生画布用同一次剪贴板事件运输原生化学格式和混合对象；文字编辑时保留普通文字复制粘贴。

文字选区支持字体、字号、颜色及常用格式；按页高自动分页、公式和 Markdown 尚未实现。旧的 `research/document-editor-prototype/` 与 `.molnote` 留在本地，不迁移也不在本轮整理。实现现状和带构建标识的验证记录见 [文档模式结果](DOCUMENT_MODE_RESULTS.md)；[DOCUMENT_MODE.md](DOCUMENT_MODE.md) 保留原方案，不能把其中未完成条目当作现有功能。

文本快照和 3D 插入确认的专项交互回归使用独立服务（例如 `MOLSTUDIO_PORT=49078 npm --prefix fusion start`），不调用上游模型：

```sh
MOLSTUDIO_PORT=49078 MOLSTUDIO_AGENT_TEST_OUT=/tmp/molstudio-text-snapshot \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_text_snapshot_real.cjs
MOLSTUDIO_PORT=49078 MOLSTUDIO_AGENT_TEST_OUT=/tmp/molstudio-3d-preview \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_object_3d_preview_real.cjs
```

分子缩放后的整理与继续绘图回归：

```sh
MOLSTUDIO_PORT=49079 MOLSTUDIO_AGENT_TEST_OUT=/tmp/molstudio-scale-edit \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_scale_edit_real.cjs
```

整理按钮有效性和保留机理布局的回归（不调用上游模型）：

```sh
.venv-rdkit/bin/python -B fusion/tests/test_conservative_layout.py
MOLSTUDIO_PORT=49082 MOLSTUDIO_AGENT_TEST_OUT=/tmp/molstudio-conservative-layout \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_conservative_layout_real.cjs
MOLSTUDIO_PORT=49167 fusion/node_modules/.bin/electron fusion/tests/test_cleanup_effect_real.cjs
```

## 目录边界

| 路径 | 用途 |
| --- | --- |
| `canvas.html` | 当前主画布 |
| `workbench/` | 机理模型、渲染、交互、存储及 AI 编辑桥 |
| `agent/` | AI 面板、工具循环和浏览器资源构建 |
| `server.py`、`agent_gateway.py` | 本机化学 API 与模型转发 |
| `stereo.py`、`conservative_layout.py`、`inorganic.py` | 立体化学、保留布局的局部整理与无机参考几何 |
| `threed.html`、`vendor/ngl.js` | 三维预览 |
| `tests/` | 回归与测试夹具 |
| `scripts/` | 当前开发入口 |

## 验证

```sh
npm --prefix fusion test
```

这是不调用真实模型的快速单元回归，覆盖 agent runtime、面板、桥、选区、存储、视口和文档模型/控制器。它不代表全部图形交互、原生 AppKit 或真实模型验收。真实 Ketcher、绘图桥、布局和模型测试的命令见 [AI 助手说明](agent/README.md)；原生保存/导航测试见 [原生回归](../fusion-native/regression/README.md)。

图形集成测试仍直接使用 `fusion/node_modules/.bin/electron`。启动独立服务后，示例命令为：

```sh
MOLSTUDIO_PORT=48975 fusion/node_modules/.bin/electron fusion/tests/test_agent_stage_layout_real.cjs
```

上面的布局测试使用真实编辑器，不调用上游模型。测试产物应留在忽略的产物目录，源码与测试夹具纳入 Git；不要将浏览器配置目录、依赖或 `.app` 包提交为源码。

纸页与混合文档的真实编辑器回归需先启动隔离服务；它不调用真实模型：

```sh
MOLSTUDIO_PORT=49075 npm --prefix fusion start
# 在另一个终端，使用同一端口和独立产物目录：
MOLSTUDIO_PORT=49075 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/artifacts \
  env -u ELECTRON_RUN_AS_NODE npm --prefix fusion run test:document:real
```

每次实际结果以该运行的 `report.json`、截图和 `.molwork` 为准；不要将源代码服务、原生自测包与待交付 `.app` 的结果混为一谈。

纸页平移边界的专项回归使用同一隔离服务，覆盖真实手形拖动、滚轮、缩放、多页导航和窗口尺寸变化，保存截图及可编辑样例：

```sh
MOLSTUDIO_PORT=49075 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/viewport-artifacts \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_viewport_real.cjs
```

完整步骤、混合剪贴板和跨文件插入使用独立真实编辑器回归，同样不调用模型。它通过真实 copy 事件读取 Ketcher 生成的原生格式及附加数据，再执行原生预览和实际鼠标放置；测试期间短暂备份和恢复系统剪贴板，不输出剪贴板内容。

```sh
node --test fusion/tests/test_document_import.cjs fusion/tests/test_document_clipboard_transport.cjs
MOLSTUDIO_PORT=49076 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/import-artifacts \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_import_real.cjs
```

上面的端口须与正在运行的隔离服务一致；验证待交付构建时，服务必须读取该构建的画布资源，并在 `MOLSTUDIO_TEST_BUILD` 标明应用包绝对路径。

原生 macOS 壳通过 `fusion/workbench/native-ui-bridge.js` 接管顶栏命令、工具面板、检查器、助手抽屉与弹窗，同时保留画布编辑区和剪贴板语义：

原生工具栏的“高级化学工具”可展开 Ketcher 完整工具栏；展开期间两侧栏与原生浮盘暂时收起，再次点击会恢复之前的面板状态。原生接管失败或尚未就绪时保留网页工具。打开包含反应步骤等分层数据的 `.molwork` 时，原生窗口会等待该次导航所需的工作台分层就绪，失败时保留原文档。

常用元素与环模板位于画布右侧浮条，右侧边栏用于 AI 助手；工具栏中的检查器按钮打开选区与文档属性。左侧浮条的正、负电荷独立操作，自由基按钮对当前选中原子切换双重态自由基，可撤销；选择工具角标或右键打开其他选择方式。

```sh
node --test fusion/tests/test_native_ui_bridge.cjs fusion/tests/test_native_ui_viewport.cjs
MOLSTUDIO_PORT=49077 MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/native-ui-artifacts \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_native_ui_real.cjs
```
