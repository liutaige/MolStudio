# MolStudio AI 助手

在 MolStudio 化学工作台点击右下角的 **AI** 打开侧栏。助手可以回答化学问题、解释选区、按需列计划，也可以新建、移动和删除分子，编辑原子、键、孤对电子与电子流弯箭头。直反应箭头属于可创建、改接和删除的反应步骤，也可在画布上手动调整。明确要求标注时，助手还可以添加文字。聊天支持 Markdown、LaTeX 和 `\ce{}` 化学式。

## 绘图和保存

1. 在侧栏输入要画的机理，或选中已有对象后描述要改的内容。简单任务可以一次模型请求完成，复杂任务可以多轮读取和绘制。模型服务决定上下文和输出上限。
2. 完整的绘图指令到达后会先出现临时预览。普通批次提交后可以编辑和撤销。模型也可以在同一个响应中用 `step.seal` 逐步提交，每个已提交步骤有独立的撤销记录。
3. 每条独立路线另起一行。同一路线从左到右排布，跨行时用成对的「续」编号衔接。同一行的直箭头共用水平基线，局部空间不足时优先缩短箭头。复杂有向无环反应图支持主线、分支与合流；共享中间体保留一份分子本体，跨行或跨分支通过成对引用端口衔接。羰基进攻与对应的 π 键电子流会优先走异侧并避让字形和化学键。要调整已有的这对弯箭头，可以选中两根，再点 **重新自动排布**。
4. 点击 **停止** 会收起临时预览并保留已提交内容。运行期间手动编辑会暂停任务，可点 **继续执行** 从当前画布接着做。切换文档后从新文档发起任务。失败的绘图批次会撤回该批次的改动。
5. 完整机理保存为 `.molwork`，其中保留结构、孤对、弯箭头的语义端点，以及直反应步骤的稳定身份、参与分子、版本和排布声明。`.ket` 可用于交换化学结构和原生直反应箭头。

短路线中的小试剂制备也可显示为独立准备支路，以配对的「接」编号指向主线中同一份真实试剂。试剂保持在后续电子流所需的位置；该分区只调整显示路径，完整化学关系及实体身份保留。

明确要求只整理整图、保持所有化学身份和连接的任务，会使用受限的语义排版工具定义：只允许 `layout.tidy`、`reactionStep.modify` 的几何布局字段、`lonePair.modify aim: "auto"` 与 `arrow.modify mode: "auto"`。任意分子坐标和手工弯度不在该模式的模型接口中，执行前也会拒绝；指定坐标、单个显式 H 朝向或手动曲线等局部请求仍使用原接口。

排版提交可通过 `draw_operations.finish: true` 确认结束，也可在查看回执后调用 `complete_layout {}`。后一工具只在本轮已有真正提交的语义排版后出现，读取真实画布并核对身份、全局布局和成对衔接，不新增绘图或撤销记录；它只完成当前排版任务。成功时显示宿主核对的数量与续接摘要，不输出模型推测的化学解释。未确认完成、存在提问或核对失败时保留待继续状态。单次任务不提供 `complete_phase`；保存后已有操作的任务不再提供重新规划入口。

复杂任务可由模型自行分阶段规划；每个已核对阶段结束后，宿主在新的模型请求中提供当前画布和任务进度，继续下一阶段。阶段结束不等于整个任务完成。任务断点与画布一起保存在 `.molwork`：停止或重开后需明确点击 **继续执行**，不会自动发出模型请求。简单任务仍可在一次请求中完成。中断时保留已提交内容，不重放未完成的工具参数。

同一次明确发起的执行中，如果成功建立的模型流返回明确的 `upstream_stream_error`，并且当前断点已保存、未留有未解决的工具错误，宿主会在旧执行完整结束后，从最新画布自动续跑，最多两次，分别等待 1 秒和 3 秒。界面显示续跑次数，等待时仍可停止；手动编辑、切换文档、重置或模型设置变化会取消自动续跑。其他网络错误、HTTP 失败、响应长度限制及绘图校验错误仍单独处理。达到两次后保留手动继续入口，不保证上游连接已恢复。请求数和 tokens 按整个恢复链累计；耗时和接收字节显示当前这段执行的累计值，自动续跑时重新计时。

## 模型设置

打开助手的设置，填写：

- 兼容 Chat Completions 的 API 地址。远程服务使用 HTTPS，本机反代可用 `http://127.0.0.1:端口/v1`。
- 模型的准确名称（例如 `deepseek-v4.1-flash`、`gpt-5.2` 等）。
- API Key。留空保存会保留原密钥。
- 生成设置：选择服务默认参数，或按服务支持情况选择 DeepSeek / OpenAI 参数格式、思考强度与总输出上限。服务默认不发送思考开关或强度；总输出上限留空时也交由服务决定。此上限不是独立思考预算，也不承诺响应时间。不同服务和模型支持的档位可能不同。

本机 Python 网关持有上游密钥，浏览器使用本机网关的会话令牌。macOS 上新输入的密钥由网关尝试写入钥匙串。钥匙串写入失败时，界面会说明密钥仅用于当前会话。

也可在启动本机服务前设置环境变量，不修改其他软件配置：

```sh
export MOLSTUDIO_AGENT_BASE_URL=http://127.0.0.1:8788/v1
export MOLSTUDIO_AGENT_MODEL=deepseek-v4.1-flash
export MOLSTUDIO_AGENT_KEY_FILE=/absolute/path/to/a/private/key-file
```

也可通过 `MOLSTUDIO_AGENT_API_KEY` 向服务端传入密钥。用 `MOLSTUDIO_AGENT_CONFIG_DIR` 隔离研究与测试设置。
例如，隔离验收服务可设置 `MOLSTUDIO_AGENT_GENERATION_JSON='{"profile":"deepseek","effort":"low","maxOutputTokens":16384}'`。网关返回的生成参数元数据只说明转发给所配置地址的字段，不保证下游代理或模型实际采用了该设置。

## 实现与构建

`app.js` 连接侧栏和化学工作台。`runtime.js` 用 Pi Agent Core 运行模型工具循环，`stream-operations.js` 从流式参数中解出完整操作。`../workbench/agent-bridge.js` 解析稳定引用，调用 Ketcher 的原生动作，并把分子和机理层的改动合并到同一条历史记录。`../agent_gateway.py` 负责本地鉴权、上游转发和停止请求。RDKit 结构转换由 `../server.py` 提供。

```sh
npm --prefix fusion/agent ci --ignore-scripts
npm --prefix fusion/agent run build
node fusion/patch-ketcher-agent.cjs
./.venv-rdkit/bin/python -B fusion/server.py 48975
```

浏览器打开 `http://127.0.0.1:48975/canvas.html`。原生版使用 `fusion-native/build-app.sh` 构建，运行所需的 Python、RDKit 和浏览器资源随应用打包。 [macOS 构建与安装](../../fusion-native/PACKAGING.md)

## 反应步骤接口与持久化

新绘图通过 `draw_operations` 中的步骤操作管理直反应箭头。`reactants`、`products` 各用一个稳定原子引用代表一个分子；新建步骤可先于同批引用的 `molecule.add` 声明，便于宿主统一安排预览与排布。

`inspect_structures` 的键表包含端原子引用、化学键级 `order` 和实际描绘类型 `nativeType`。例如羰基为 `order: 2, nativeType: 2`，O–H 为 `1, 1`；芳香键的化学键级为 `1.5`，当前 Kekulé 描绘可对应原生单键或双键。π 箭头端点按实际原生键类型校验，不能只依据芳香化学键级推断。新增分子的键回执也返回插入后的实际原生键级与类型。预检会核对这些元数据与原生片段，不替换模型指定的源键。

电子流端点失败分别返回 `arrow_pi_unavailable`、`arrow_endpoint_invalid` 或 `arrow_endpoints_overlap`，诊断中包含有界的端点引用、实际键类型和解析失败原因。失败批次完整回滚；修正参数后可重提未提交的操作 ID。宿主不会替换源键或把 π 电子流自动改为 σ 电子流。

| 操作 | 主要字段 | 行为 |
| --- | --- | --- |
| `reactionStep.create` | `id`、`reactants`、`products`、可选 `layout` | 创建步骤，宿主分配稳定 `stepId`，初始 `version: 1` |
| `reactionStep.modify` | `id`、`stepId`、`expectedVersion`，以及变更的 `reactants`、`products` 或 `layout` | 在原步骤上改接或调整排布，版本递增 |
| `reactionStep.delete` | `id`、`stepId`、`expectedVersion` | 删除步骤及其拥有的直箭头、条件和续号，保留参与分子 |

`read_canvas` 的 `reactionSteps` 返回当前 `stepId` 与 `version`。同一次运行内，创建操作的 `id` 也是该步骤的别名；回执的 `stepMapping` 提供别名到稳定身份的对应。编辑时用当前版本作为 `expectedVersion`；版本不匹配返回 `step_version_conflict`，该批次保持原状。

`layout` 包含 `reactantPlacement: "auto" | "horizontal" | "vertical"`、`reagentPlacement: "auto" | "left" | "right" | "above" | "below"`、`breakBefore` 和最长 64 字符的单行 `conditions`。`reagentPlacement` 控制小试剂相对主分子的位置，`auto` 根据反应位点选择；修改时用 `layout.conditions: ""` 清除条件。步骤编辑会重排受影响的反应图，并把结构移动、直箭头、标签与步骤元数据合并到同一次撤销。回执的 `steps` 包含 `before`、`after` 及独立的排布、化学检查；`after` 是整个批次完成后的真实观测，同批多次修改某一步时会反映其最终状态。

`molecule.move.target.molecule` 移动完整分子；`target.atoms` 只移动列出的稳定原子集合，包含单个显式 H 的情况，相邻原子保持原位。`x/y` 指定目标集合包围盒的中心，`dx/dy` 指定其位移。绑定在这些原子上的孤对和弯箭头随之更新。

对于普通单键连接 O/N、没有相关已定义立体化学的末端显式 H，可用 `target.atoms: [H引用]` 配合 `orientTowardAtomId: 受体原子引用`。宿主保持当前 H–O/N 键长，只旋转该 H 的描绘方向；此模式与 `x/y/dx/dy` 互斥，同批可以使用新分子的原子别名。孤对自动跟随目标仍由独立的 `lonePair.modify aim: "auto"` 指定。

`hydrogen.makeExplicit {id, type, parentAtomId}` 将普通、非查询、非芳香且没有相关已定义立体化学的 C/N/O 上一个现有隐式 H 显式画出。宿主把该原子的隐式 H 计数减一，创建电荷及自由基均为零的 H 与普通单键，并自动安排位置；总 H 数、净电荷和全部旧实体 ID 保持不变。新 H 别名是 `id:1`，新键别名是 `id:bond:1`，回执包含真实 `atoms`、`bonds` 与计数前后值。没有隐式 H 时会返回错误。后续可在适用的 O/N–H 上使用已有朝向模式。

`molecule.move` 与 `layout.tidy` 还会返回受影响步骤的 `action: "observe"` 回执，不修改步骤版本或消费步骤操作 ID。实际试剂侧别与保存声明不符，或图中的结构被移离原路线时，完成核对会要求用原步骤的当前版本修复排布。重开文档时，保存的定位数据随 Ketcher 的导入平移和缩放一起转换。

后补电子流会按真实反应位点重排所属步骤；`checkedArrowIds` 列出实际核对的电子流，包括键源箭头。可读性按真实跨度、弧长与弧高检查，不能仅以无碰撞作为通过。排布使用原生字形尺寸预留结构间距，并以骨架中心对齐。省略 `lonePair.add.angle` 时，自动朝向会随被进攻原子和试剂停靠位置变化；显式角度编辑会清除自动绑定。该绑定与角度保留在 `.molwork` 中。

不含文档层的 `.molwork` 仍使用版本 1，扩展保存 `reactionSteps` 和 `reactionStepOperations`；含 `document` 的画布或纸页使用版本 2，旧构建会明确拒绝较新版本。旧 `reactionArrow.add` 继续兼容，也会获得稳定步骤身份；载入旧文件中尚无 `stepId`、`version` 的步骤记录时，宿主自动生成身份并从版本 1 开始。

新步骤操作的 `op.id` 在文档内作为幂等键使用。文档级 `reactionStepOperations` 保存最近最多 2048 次步骤操作，包括已删除步骤的记录；在保留范围内，相同 ID 和参数的重试返回幂等回执，不会再次修改画布，重开文档后仍有效。相同 ID 对应不同参数返回 `operation_conflict`。Undo 保留已消耗的操作 ID，使迟到的重试不会复活用户刚撤销的内容；后续新修改使用新的 ID。其他绘图操作沿用原有的运行级幂等机制。

## 验证

```sh
npm --prefix fusion run test:unit
npm --prefix fusion/agent test
node --test fusion/agent/tests/panel.test.cjs
node --test fusion/tests/test_agent_app.cjs fusion/tests/test_agent_selection_dirty.cjs
node --test fusion/tests/test_reaction_step_operations.cjs fusion/tests/test_workbench_storage_safety.cjs
./.venv-rdkit/bin/python -B -m unittest discover -s fusion/tests -p 'test_agent_gateway*.py'
node fusion/tests/test_pi_arrow_layout.cjs
```

绘图桥和集成测试使用独立的 Electron 测试窗口，连接单独启动的本机服务。以下命令默认使用合成模型流。

```sh
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_integration.cjs
MOLSTUDIO_PORT=48975 fusion/node_modules/.bin/electron fusion/tests/test_agent_stage_layout_real.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_lifecycle_real.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_dag_23.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  fusion/node_modules/.bin/electron fusion/tests/test_reaction_reagent_placement_real.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  fusion/node_modules/.bin/electron fusion/tests/test_mechanism_export_real.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  MOLSTUDIO_TEST_BUILD=/absolute/path/to/MolStudio.app \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_task_checkpoint_real.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  MOLSTUDIO_TEST_BUILD=/absolute/path/to/MolStudio.app \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_proton_transfer_real.cjs
```

`test_reaction_step_dag_23.cjs` 在真实画布中确定性回放 23 步图及分支合流夹具，验证拓扑、引用和可编辑实体，不调用模型；它是几何与数据夹具，不代表工业咖啡因路线的化学验收。试剂位置与图片导出也有独立的真实画布夹具。导出检查涵盖按根 SVG 实际坐标裁剪，以及根据标记排除编辑器滚动条。各命令使用独立产物目录。

`test_agent_task_checkpoint_real.cjs` 不调用模型；它在真实主画布中检查任务账本的事务合并、运行与文档隔离、保存重开、重复操作阻断和新任务独立身份。
`test_agent_proton_transfer_real.cjs` 以一次真实模型误画后保存的可编辑图为夹具，通过合成工具流检查错误的供体键电子流被拒绝并回滚，以及随后改向供体原子的修复。

纸页模式的 `read_canvas` 上下文包含页面内容区、文档对象与区域；自动排布以当前页面为目标，内容无法安全放入时回滚当前批次并提示需要空间。页高自动分页仍未实现。

真实模型验收使用服务端已配置的模型与凭据。启动待交付构建的本地服务后，按改动选一个能复现问题的用例。多路线排版用下面的咖啡因用例，同一路线换行用 `ketal`，从已有弯箭头继续绘制用 `duplicate-arrow`。探针记录真实请求数，并导出 PNG 与 `.molwork`。检查导出的最终画布和报告中的完成状态。

```sh
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" \
  MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_AGENT_REAL_CASES=caffeine-routes MOLSTUDIO_AGENT_REAL_LIMIT=6 \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_integration.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" MOLSTUDIO_REAL_AGENT=1 \
  fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_correction_live.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" MOLSTUDIO_REAL_AGENT=1 \
  MOLSTUDIO_AGENT_REAL_LIMIT=40 \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_long_route_live.cjs
MOLSTUDIO_PORT=48975 MOLSTUDIO_AGENT_TEST_OUT="$(mktemp -d)" MOLSTUDIO_REAL_AGENT=1 \
  MOLSTUDIO_TEST_BUILD=/absolute/path/to/MolStudio.app MOLSTUDIO_AGENT_REAL_LIMIT=12 \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_phases_real.cjs
```


纸页咖啡因路线使用同一个真实模型探针，需先启动实际待测构建的服务；下例按构建单独指定端口和产物目录：

```sh
MOLSTUDIO_PORT=49177 MOLSTUDIO_TEST_BUILD=/absolute/path/to/MolStudio.app \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/paper-run MOLSTUDIO_REAL_AGENT=1 \
  MOLSTUDIO_AGENT_PAPER_MODE=1 MOLSTUDIO_AGENT_REAL_CASES=caffeine-routes \
  MOLSTUDIO_AGENT_REAL_LIMIT=6 MOLSTUDIO_AGENT_TASK_LIMIT=6 \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_agent_integration.cjs
```

达到请求上限而返回 `needs_continue` 时保留报告和 `.molwork`，不可算完成；要在新一轮继续，使用保存的断点并明确单独记录新构建及请求数：

```sh
MOLSTUDIO_PORT=49177 MOLSTUDIO_TEST_BUILD=/absolute/path/to/MolStudio.app \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/paper-resumed MOLSTUDIO_REAL_AGENT=1 \
  MOLSTUDIO_AGENT_PAPER_MODE=1 MOLSTUDIO_AGENT_REAL_CASES=caffeine-routes \
  MOLSTUDIO_AGENT_REAL_SEED_FILE=/absolute/path/to/paper-run/real-caffeine-routes.molwork \
  MOLSTUDIO_AGENT_REAL_LIMIT=6 MOLSTUDIO_AGENT_TASK_LIMIT=6 \
  env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_agent_integration.cjs
```

本轮分构建结果与局限见 [文档模式结果](../DOCUMENT_MODE_RESULTS.md)。完成状态、路线分区、换行衔接、每步电子流、最终截图与可编辑文件均须查看实际报告，不能仅凭命令退出码推断。

排查真实批次失败时，可加 `MOLSTUDIO_AGENT_CAPTURE_TRANSACTIONS=1`。探针会在该轮产物的 `transactions/` 保存失败前后的完整 `.molwork`、操作列表和布局诊断；成功调用仅留轻量记录。观察器不调用会提交文字编辑的保存入口，并检查作者内容、选区、视口、历史与 dirty 均未被观察改变。快照来自声明的待测包，可离线重放失败批次，避免仅凭最终回滚后的画布猜测原因。

`test_agent_phases_real.cjs` 使用单次半缩醛任务检查模型创建的多个阶段、跨阶段真实请求、停止后保存重开与明确继续，以及操作身份不重复。测试要求服务显式配置 DeepSeek 生成设置和 16384 的上限；默认核对 low，设 `MOLSTUDIO_AGENT_EXPECT_EFFORT=high` 则核对 high，服务侧也须使用对应档位。探针只记录转发字段与选定元数据，不保存隐藏思考或凭据。测试请求上限及超时分别用 `MOLSTUDIO_AGENT_REAL_LIMIT`（默认 12，最多 20）和 `MOLSTUDIO_AGENT_WATCHDOG_MS`（默认 900000，最多 1200000）控制；上限是验收保护，不是产品任务上限。最终还需人工核对各阶段化学、电子流、布局、说明与完成状态，测试命令或阶段数本身不能证明化学正确。

阶段探针生成 `completed-context.json` 后，会用 `agent_hemiacetal_audit.py` 从画布的原子、键、氢和电荷独立重建组分，检查反应物、半缩醛产物、酸库存、各步守恒和质子转移中的供体键电子去向。也可单独运行 `./.venv-rdkit/bin/python -B fusion/tests/agent_hemiacetal_audit.py /absolute/artifacts/completed-context.json /absolute/artifacts/chemistry-audit.json`。其他电子流方向、说明和几何仍须结合报告端点与导出图人工审核。

`test_reaction_step_lifecycle_real.cjs` 使用真实编辑器和本机化学服务，不调用模型，覆盖步骤创建、改接、删除、撤销重做、跨行衔接、保存重开与幂等重试。`test_reaction_step_correction_live.cjs` 和 `test_agent_long_route_live.cjs` 是真实模型探针，须显式设置 `MOLSTUDIO_REAL_AGENT=1` 并使用独立产物目录；长路线先运行 `caffeine-routes` 冒烟用例。检查报告、最终 PNG、可编辑 `.molwork` 和完成状态，并核对各步骤电子流在真实几何中的可读性，包括箭头与分子、键和其他箭头的遮挡。产物须按测试应用、页面与服务构建核对；命令本身不表示验收已经通过。

长路线探针可通过 `MOLSTUDIO_AGENT_LONG_SEED_FILE` 载入已有 `.molwork`，通过 `MOLSTUDIO_AGENT_LONG_PROMPT_FILE` 提供整理任务。此模式核对所有结构、步骤引用和电子流身份的保留，并与从零推导机理的验收分别记录。`MOLSTUDIO_TEST_BUILD` 应填写实际服务构建路径。多路线探针的总请求上限为 `MOLSTUDIO_AGENT_REAL_LIMIT`，单任务上限为 `MOLSTUDIO_AGENT_TASK_LIMIT`；达到测试上限不代表产品自身限制任务轮数。

高难度化学验收可设 `MOLSTUDIO_AGENT_LONG_CASE=ROBINSON`，从已核对的二酮/MVK 与 KOH→吡咯烷条件开始，要求 Michael 加成、分子内成环、催化剂释放以及正确的 6,6 Wieland–Miescher 烯二酮。它不固定基元步骤数量，化学与排布分别判定。[依据与验收边界](../tests/ROBINSON_ACCEPTANCE.md)

试剂停靠失败的回执含 `layoutFailures`：具体电子流、原操作编号、碰撞原子/键以及过长或弯曲过大的原因。`endpointMovesWithReagent`、`obstacleMovesWithReagent` 标明当前试剂的平移是否影响这些端点或障碍；主体内部的失败不能只归咎于试剂侧别。失败批次完整回滚，重提修正后的原操作。

已有孤对可用 `lonePair.modify { lonePairId, aim: "auto" }` 显式改为跟随已有电子流的唯一攻击目标，再在同批次修改原步骤。它不删除重建孤对或弯箭头；回执和存储沿用 `refAtomId` / `angleRel`。`aim: "manual"` 保留当前实际朝向，或用 `angle` 指定手动角度；`auto` 与 `angle` 不能同时给，无目标或存在不同目标时返回具体错误。旧文件里的手动角度不会自动被覆盖。

仓库附带七步缩酮的预览与可编辑样例，可用于检查两行步骤衔接、直箭头基线和羰基电子流的可读性。样例第一行四步、第二行三步；它是已保存的机理示例，不代表当前模型重新生成的验收结果。 [缩酮预览](../examples/ketal/ketal.png) · [可编辑样例](../examples/ketal/ketal.molwork)

## 外部 Harness 协同（MCP + Skill）

外部 AI 编程助手或 CLI Harness（如 Claude Code、Codex、Antigravity、Cursor 等）可通过标准 `stdio` MCP 服务连接正在运行的 MolStudio 画布，直接调用真实绘图与核对管线并在助手侧栏中实时展示「外部协同」操作记录与明细。

- **协议与桥接**：`../mcp_server.py` 是纯 Python 标准库实现的 `stdio` MCP 服务端（同时支持换行分隔 JSON-RPC 2.0 与 `Content-Length` 帧格式）；`../agent_external_bridge.py` 在本地 `server.py` 上挂载 `/api/agent/external/status`、`/events`（SSE）、`/call` 与 `/result`（均校验本机 `Host`/`Origin`）。
- **服务发现与自动拉起**：优先读取 `MOLSTUDIO_URL` / `MOLSTUDIO_PORT`，其次读取 `~/Library/Application Support/MolStudio/active-bridge.json`（可用 `MOLSTUDIO_AGENT_CONFIG_DIR` 覆盖），最后探测 `8462` 与 `48975`。若画布尚未打开且未设置 `MOLSTUDIO_NO_AUTO_LAUNCH=1`，调用画布工具时会自动拉起 `MolStudio.app` 或开发服务并等待画布连接。
- **暴露工具**：`molstudio_status`（支持 `openCanvas: true`）、`molstudio_read_canvas`、`molstudio_inspect_structures`（未开画布时也可直接走本地 RDKit 预检）、`molstudio_draw_operations`（与内置助手共用完整 schema、`step.seal` 与回执校验）、`molstudio_plan_task`、`molstudio_complete_phase`、`molstudio_complete_layout`、`molstudio_write_plan`。内置助手正在执行时，外部调用会返回互斥提示而不打断当前任务。
- **结果详略**：`molstudio_read_canvas`、`molstudio_inspect_structures`、`molstudio_draw_operations` 支持 `detail: "compact" | "full"`，默认 `compact`，减少外部模型收到的冗余结果；需要完整原始结果或细查几何时再用 `full`。此选项只影响 MCP 返回内容，内置助手、画布执行与校验保持原有行为。
- **局部读取**：检查或修正已知步骤时，`molstudio_read_canvas` 可传 `stepIds`（回执中的 1–16 个不重复稳定步骤 ID），读取这些步骤的完整参与分子和相关电子流；字段详略仍由 `detail` 选择，不必默认读取整张画布。
- **Skill 与接入示例**：外部 Harness 可加载 [MolStudio 绘图 Skill](../../skills/molstudio-draw/SKILL.md)，并按以下方式注册 MCP 服务：

```json
{
  "mcpServers": {
    "molstudio": {
      "command": "/path/to/MolStudio/.venv-rdkit/bin/python",
      "args": ["-B", "/path/to/MolStudio/fusion/mcp_server.py"]
    }
  }
}
```

普通绘图直接使用 MCP 工具，无需先读仓库源码、编写 shell/RDKit 排障脚本或另建 Harness 展示页面。按需一次 `molstudio_status { openCanvas: true }` 建立连接；编辑已有对象前读取当前引用，不确定的 SMILES 合并预检（每次最多 12 个）。绘图每批最多 40 个操作，包含完整步骤，可用 `step.seal` 分步提交。沿用成功回执中的稳定引用和步骤版本，画布未变化时不在每批后全量重读。

简单机理不强制规划阶段。最终批次用 `finish: true` 并核对回执；分阶段任务中，接受此完成声明就已完成当前阶段，不再重复 `molstudio_complete_phase`。校验失败按诊断局部修正；已提交的步骤保留，不能为通过排版或校验而替换用户要求的底物、中间体或机理。表示或校验能力不足时明确报告限制。

打包版 `MolStudio.app` 随包携带 `mcp_server.py` 与 `agent_external_bridge.py`，可直接用包内 Python 启动：

```sh
/Applications/MolStudio.app/Contents/Resources/python/bin/python -I -B \
  /Applications/MolStudio.app/Contents/Resources/mcp_server.py
```

外部桥接与 MCP 协议回归验证：

```sh
./.venv-rdkit/bin/python -B -m unittest discover -s fusion/tests -p 'test_agent_*.py'
./.venv-rdkit/bin/python -B -m unittest discover -s fusion/tests -p 'test_mcp_response.py'
```

`fusion/tests/test_agent_external_mcp_real.cjs` 使用独立服务和真实画布，核对 compact/full 的化学引用、步骤版本与电子流保真，以及按步骤读取的隔离和可编辑导出。`fusion/tests/test_agent_external_model_live.cjs` 另用本机已配置的真实模型运行标准 MCP 工具循环，保存请求/工具耗时、回包字节、最终核对、截图与 `.molwork`：

```sh
MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_AGENT_EXTERNAL_CASE=hemiacetal \
  MOLSTUDIO_AGENT_GENERATION_JSON='{"profile":"deepseek","effort":"low","maxOutputTokens":16384}' \
  MOLSTUDIO_AGENT_TEST_OUT=/absolute/path/to/artifacts \
  fusion/node_modules/.bin/electron fusion/tests/test_agent_external_model_live.cjs
```

上例的生成参数仅传给隔离验收服务，须由已配置模型支持，不写回用户设置。也可用 `MOLSTUDIO_AGENT_EXTERNAL_GATEWAY_URL=http://127.0.0.1:8462` 只复用现有模型网关（画布仍隔离）；此时生成参数由该网关的原设置决定。可选 `MOLSTUDIO_AGENT_EXTERNAL_CASE=corey-winter`、`MOLSTUDIO_AGENT_EXTERNAL_DETAIL=full`。探针仅提供 8 个 MolStudio 工具，不能替代完整通用 Harness 的前后对比；超时和化学/几何失败必须按报告区分，不能把等待模型生成计作 MCP 工具执行耗时。

更新 MCP 后需重连已有 MCP 进程，让 Harness 重新读取工具 schema 和服务说明；无需更改其连接配置。原生包的 MCP 资源也需随应用重新打包。

原生桌面界面中，画布助手侧栏/抽屉通过 `fusion/agent/native-renderer.js` 与 `fusion/workbench/native-ui-bridge.js` 向宿主同步规范化的会话快照与时间线；跨语言契约回归见 `node --test fusion/tests/test_native_agent_renderer.cjs` 与 [native regression](../../fusion-native/regression/README.md)。

本机 DeepSeek Harness（DSH）通过配置型 bundle [integrations/dsh-molstudio-mcp](../../integrations/dsh-molstudio-mcp/README.md) 接入：只插入一条 `@deepseek-ai/dsh-mcp-client` 行，以 `stdio` 运行 `mcp_server.py`，工具名为 `mcp__molstudio__*`。在 DSH 的 **Plugins** 中安装该目录，或在 `plugin_manager` 用该路径 `install_bundle`；停用 bundle 即断开，不改动其他 profile 状态。自动拉起只认随包携带 `Contents/Resources/agent_external_bridge.py` 的 `MolStudio.app`；旧构建会跳过并回退到开发服务（`fusion/server.py` + `canvas.html`），因此桥接更新后需重新打包应用才能用打包版协同。

## 当前边界

助手的工具范围是当前画布。普通文字是独立画布对象。Ketcher 原生历史容量为 32 条。完整机理的验收检查步骤、引用、产物和部分电子流约束，化学合理性仍需按反应条件核对。

自动排布支持有向无环图的主线、分支、合流、跨行和共享中间体引用。环路、无法形成水平通道或展示组过宽会返回具体诊断，失败批次撤回。同一真实试剂的电子流若要求它同时靠近不同化学阶段，宿主会返回接触关系冲突，模型需明确各阶段的试剂实例。两条两步 N-甲基化路线、七步缩酮和确定性图夹具的验收范围各自独立，不能据此认定 23 步工业咖啡因合成及其旁支已经通过。
