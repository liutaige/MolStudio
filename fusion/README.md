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

## 目录边界

| 路径 | 用途 |
| --- | --- |
| `canvas.html` | 当前主画布 |
| `workbench/` | 机理模型、渲染、交互、存储及 AI 编辑桥 |
| `agent/` | AI 面板、工具循环和浏览器资源构建 |
| `server.py`、`agent_gateway.py` | 本机化学 API 与模型转发 |
| `stereo.py`、`inorganic.py` | 立体化学与无机参考几何 |
| `threed.html`、`vendor/ngl.js` | 三维预览 |
| `tests/` | 回归与测试夹具 |
| `scripts/` | 当前开发入口 |

## 验证

```sh
npm --prefix fusion test
```

这是不调用真实模型的快速单元回归，覆盖 agent runtime、面板、桥、选区、存储和视口。它不代表全部图形交互、原生 AppKit 或真实模型验收。真实 Ketcher、绘图桥、布局和模型测试的命令见 [AI 助手说明](agent/README.md)；原生保存/导航测试见 [原生回归](../fusion-native/regression/README.md)。

图形集成测试仍直接使用 `fusion/node_modules/.bin/electron`。启动独立服务后，示例命令为：

```sh
MOLSTUDIO_PORT=48975 fusion/node_modules/.bin/electron fusion/tests/test_agent_stage_layout_real.cjs
```

上面的布局测试使用真实编辑器，不调用上游模型。测试产物应留在忽略的产物目录，源码与测试夹具纳入 Git；不要将浏览器配置目录、依赖或 `.app` 包提交为源码。
