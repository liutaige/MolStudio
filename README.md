# MolStudio 画布

当前画布把分子结构、孤对电子、机理箭头和 AI 编辑放在同一界面中，并提供独立的 3D 预览窗口。纸页模式在同一画布上直接编辑机理，与文字、图片和形状混排；支持 A4 / Letter 与按页 PDF。

## 从这里开始

- [开发、构建与测试](fusion/README.md)
- [AI 助手与真实模型验收](fusion/agent/README.md)
- [macOS 原生应用打包](fusion-native/PACKAGING.md)
- [无机小分子 3D 支持范围](fusion/INORGANIC_3D.md)
- [纸页模式与欢迎页设计](fusion/DOCUMENT_MODE.md) · [实现范围与分构建验收](fusion/DOCUMENT_MODE_RESULTS.md)

首次使用先按[开发说明](fusion/README.md)准备 Python 与 Node 依赖，并生成 AI 浏览器资源。已有开发环境可直接启动：

```sh
npm --prefix fusion start
```

打开 `http://127.0.0.1:48975/`。`/`、`/index.html` 和 `/canvas.html` 都打开当前画布。

## 当前代码

| 目录 | 职责 |
| --- | --- |
| `fusion/canvas.html` | 唯一画布页面 |
| `fusion/workbench/` | 机理数据、编辑、渲染、保存与 Ketcher 接口 |
| `fusion/agent/` | AI 侧栏、工具循环、流式指令与验证 |
| `fusion/server.py`、`stereo.py`、`inorganic.py`、`agent_gateway.py` | 本机 HTTP 服务、化学计算与模型网关 |
| `fusion/mcp_server.py`、`agent_external_bridge.py`、`mcp_response.py` | 外部 MCP 接口、画布连接与回包 |
| `fusion/threed.html`、`fusion/vendor/ngl.js` | 当前 3D 预览 |
| `fusion/tests/`、`fusion-native/regression/` | 当前产品回归与必要夹具 |
| `fusion-native/` | 原生窗口、文件生命周期与 macOS 打包 |
| `ketcher-local/` | 当前 Ketcher 发行资源及项目补丁 |
| `integrations/`、`skills/` | 画布的 Harness 接入与绘图技能说明 |

完整机理使用 `.molwork`；结构交换使用 `.ket`、`.mol`、`.sdf`、`.smi` 等格式。旧 `.mechdoc` 页面已经退出当前应用。

## Git 与 GitHub 范围

GitHub 的 `main` 只保存当前画布、共享化学核心、原生壳、AI/MCP、必要测试与开发说明。旧页面、旧产品壳、历史研究项目和本机验收产物不纳入这个分支。

当前开发机的 `codex/local-workspace` 是仅保留在本地的完整开发分支，其中的纸页文档应用仍为半成品。该分支不推送 GitHub；画布从这个分支更新到 `main` 时使用：

```sh
# 先将本地最新改动提交，再提取画布代码
python3 scripts/update-canvas-branch.py
git push origin main:main
```

新克隆启用推送检查：

```sh
git config core.hooksPath .githooks
git config remote.origin.push refs/heads/main:refs/heads/main
```

推送检查只允许 `main`，并核对提交中的文件范围，防止把本地未发布应用或研究目录带到 GitHub。

`node_modules/`、`fusion/agent/dist/`、`fusion-native/.build/` 和 `fusion-native/dist/` 是可重建的依赖或产物，不用来保存源码版本。Electron 仅作为自动化测试运行器；实际应用由原生 macOS 外壳构建。
