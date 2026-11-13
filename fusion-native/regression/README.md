# 原生画布回归（不启动 GUI）

从 `fusion-native/Sources/Ketcher3D/main.swift` **逐字提取真实方法体**，用 AppKit/WebKit 替身驱动控制流，验证画布的退出、关闭、导航、保存、未收敛警告和服务诊断。

```sh
bash fusion-native/regression/run.sh
OUT_DIR=/tmp/my-run bash fusion-native/regression/run.sh
```

当前用例：**210 项控制流断言 + 11 项真实方法生成的 JavaScript 快照/导出断言**。生成物写在 `OUT_DIR`（默认 `/tmp/molstudio-regression`），不进入源码历史。

- 修改 `applicationShouldTerminate`、`confirmDiscard`、`startNavigation`、`abortNavigation`、`applyPending`、`saveSession` 或 `fetchSnapshot` 后重跑。
- 关闭与退出覆盖：保存/不保存/取消、真实写盘失败、迟到轮询、关闭后新建/打开、欢迎页退出及读取失败的明确放弃入口。
- 导航覆盖：导航期间禁止提交空页快照，固定恢复文本，迟到注入失效，注入失败回退原画布，页面超时/崩溃后保留内存内容。
- 保存覆盖：会话替换、导航、关闭、重命名或后发保存使旧回调失效；保存期间的新编辑保持未保存；最终快照新增机理时禁止有损格式。
- 一致性覆盖：MOL/SMILES 导出前后读取完整快照，期间发生编辑时拒绝混版保存；`test-snapshot-exports.cjs` 直接执行真实 Swift 方法生成的 JavaScript。
- 离开前复查：关闭、新建、打开与退出前，确认保存期间没有新增修改；复查失败时保留画布。
- 旧 `.mechdoc` 格式明确拒绝，不导航、不修改当前画布。

2026-11-11 整理移除了旧 ChemDoodle 页面及双模式会话。原 189 项中退休了39条仅针对旧文档/跨模式行为的断言，新增8条单画布恢复、打开失败回退和拒绝旧格式的断言。当前画布保存竞态与快照一致性覆盖继续保留。

这些是方法级控制流测试，不能替代最终应用的真实 AppKit 面板、快捷键、WebKit 加载及画布截图验收。独立纸页文档应用不属于此套测试。

## 文件打开保护

异步 SMILES 打开覆盖快速 A/B 打开、同画布等待期间继续编辑、取消打开/新建/关闭/退出撤销旧请求、迟到失败静默，以及确认后/模态确认期间新增编辑。新打开或取消发生在确认快照、确认保存或保存后复查等待期间时，过期的成功/失败回调不会再弹确认或错误。工作台打开覆盖 compact/pretty/BOM JSON、顶层格式识别、缺失或不受支持的版本、损坏文件不降级为 KET，失败保留当前内容。

先运行上述回归生成真实 Swift 方法的加载脚本，再启动当前画布服务，可以在真实 Ketcher 中执行该脚本，确认 F01 的 3 原子、1 孤对和 2 机理箭头全部保留：

```sh
MOLSTUDIO_PORT=48975 env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron \
  fusion-native/regression/test-workbench-open.cjs /tmp/molstudio-regression/fixtures
```

默认将截图、可编辑 `.molwork` 和报告放在 fixtures 下的 `workbench-open/`；使用 `MOLSTUDIO_NATIVE_TEST_OUT` 指定其他输出目录。
