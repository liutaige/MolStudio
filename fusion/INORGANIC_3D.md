# 无机小分子的 3D 参考几何

`inorganic.py` 为下列 35 种完整分子/离子提供离线参考模型，在普通 ETKDG/力场路径之前识别。
这解决了已知无机物被默认价态规则拒绝、MMFF/UFF 没有参数，以及普通构象生成器没有保留高配位几何的问题。

| 类别 | 支持的结构 |
| --- | --- |
| 稀有气体氟化物 | XeF₂、XeF₄、XeF₆、KrF₂ |
| 氙氧化物/氧氟化物 | XeO₃、XeO₄、XeOF₂、XeOF₄、XeO₂F₂、XeO₃F₂ |
| 第 15 族卤化物 | PF₅、PCl₅、AsF₅、SbF₅ |
| 第 16 族氟化物 | SF₄、SF₆、SeF₄、SeF₆、TeF₆ |
| 卤素氟化物 | ClF₃、BrF₃、IF₃、ClF₅、BrF₅、IF₅、IF₇ |
| 硼卤化物 | BF₃、BCl₃ |
| 离子 | BF₄⁻、PF₆⁻、SiF₆²⁻、I₃⁻、ICl₂⁻、ICl₄⁻、IF₄⁻ |

## 科学含义

- 这些是孤立分子/离子的可旋转几何模型，不表示固态晶格、溶液聚合态或能量极小。
- XeF₄ 使用 [NIST CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=13709610&charge=0) 的 1.9349 Å 参考键长与 90°/180° 键角。
- 其他模型按已知 VSEPR 几何布置；键长采用共价半径估算，双键使用 0.9 的示意缩短系数，不宣称实验精度。轴向/赤道键长差异与孤对导致的角度畸变未拟合。
- XeF₆ 单独标注为**八面体高对称参考构型**，并持续显示“真实构型可畸变”的说明，不把它描述为刚性正八面体。参见 [Dixon 等，JACS 2005](https://doi.org/10.1021/ja0423116)。
- `/api/gen3d` 与 `/api/gen3d_all` 返回 `geometry` 元数据和可读 `notes`，明确 `optimized: false`。原生窗口显示 notes，3D 页面从 MOL 标题持续显示模型标识；参考模型不冒充“力场未收敛”。

几何类别可参照 [Open University 的分子形状说明](https://www.open.edu/openlearn/mod/oucontent/view.php?id=87848&section=_unit7.3.1)、[NIST XeF₂/XeF₄ 角度](https://cccbdb.nist.gov/expangle2x.asp?all=0&descript=aFXeF) 和 [NIST ClF₃ 结构](https://cccbdb.nist.gov/expgeom2x.asp?casno=7790912&charge=0)。

## 校验边界

按整个星形连接图、中心元素/形式电荷、配体元素/电荷、键级及数量匹配；额外原子、配体间的键、自由基、显式氢和查询键均不进入例外。
对匹配的完整闭壳层结构，使用已知价态，跳过 RDKit 的默认严格价态检查和自由基推断，保留其他 sanitize 步骤。
其余分子继续经过完整校验、ETKDG 和 MMFF/UFF，不返回未经验证的随机坐标。

生成器复制分子并保留原子索引、电荷、同位素与键。对显式指定的立体构型不使用固定模板覆盖；输出沿用原有 3D 立体复核。
混合画布逐个生成并合并显示，各目标的参考模型说明保留。

## 扩展和验证

只在 `inorganic.py` 中加入有依据的模板，再生成编辑器共享清单：

```sh
.venv-rdkit/bin/python -B fusion/inorganic.py > ketcher-local/inorganic-catalog.js
node fusion/patch-ketcher-valence.cjs
.venv-rdkit/bin/python -B fusion/tests/test_inorganic_3d.py
```

浏览器集成测试需要本地服务：

```sh
.venv-rdkit/bin/python -B fusion/server.py 8879
cd fusion
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/test_inorganic_valence.cjs
```

后端测试独立断言典型分子的键角分布、平面性、键长与配体位置，并检查原子重排/同位素保留、错误价态拒绝和有机手性回归。
浏览器测试覆盖 35 种结构的真实 Ketcher 导出与 API 生成，并加载/旋转 6 种 NGL 模型验证持续标识。
`fusion-native/verify-portable.py` 在搬迁前后检查包内新模块与资源、普通有机分子和 4 种无机参考模型。
