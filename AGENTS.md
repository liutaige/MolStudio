# MolStudio 工作范围

先读 [项目入口说明](README.md)。当前画布主页面是 `fusion/canvas.html`，配套 `fusion/workbench/`、`fusion/agent/`、Python 服务和 `fusion-native/`。服务 `/`、`/index.html` 与 `/canvas.html` 均打开这一套画布。

GitHub 的 `main` 只保留当前画布及其源码、测试和开发说明。本地完整开发分支为 `codex/local-workspace`；其中的纸页文档应用 `research/document-editor-prototype/`（默认 board、`.molnote`）仍为半成品，只在本地 Git 保存，不上传 GitHub。它复用画布/工作台/Python 化学服务，不能因目录名带 prototype 就当作废弃代码。

旧 ChemDoodle 机理页、旧 Electron 产品壳、历史研究项目和一次性探针不属于当前画布源码。不得将旧 UI 恢复为画布入口。文档应用本轮暂不整理。测试、截图和报告必须标明应用/页面/构建，不能混用。

本地完整分支提交后，使用 `python3 scripts/update-canvas-branch.py` 更新画布 `main`，再推送 `main:main`。保留 `.githooks/pre-push` 和 `remote.origin.push` 的画布范围限制；不得将本地完整分支、`research/` 或文档应用推送 GitHub。

目录整理前先保存最新源码。旧页面、探针与依赖有引用时须同步修改引用，不能直接批量删除；不得用清除未跟踪文件的方式清理当前工作区。

# MolStudio 验收

修改 AI 绘图提示词、机理校验或排版后，交付前先跑相关自动回归，再用本机已配置的真实模型跑一个能复现本次问题的用例。多路线排版优先跑 `caffeine-routes`，验收命令见 [AI 助手说明](fusion/agent/README.md)。

用待交付的构建检查最终画布和运行状态。核对路线分区、同一路线的换行衔接、各步骤电子流及完成提示。保留截图和可编辑样例，明确报告真实验收失败或无法执行的原因。
