#!/usr/bin/env python3
"""Ketcher × 3D 融合版本地服务
- /、/index.html、/canvas.html → 当前 MolStudio 画布
- /vendor/ngl.js → 当前 3D 预览依赖
- /ketcher/*   → Ketcher standalone 静态站 (ketcher-local/)
- 其余 GET      → 也回落到 ketcher-local/（兼容绝对路径资源）
- POST /api/gen3d → RDKit 2D→3D 构象生成（ETKDG + MMFF/UFF 力场优化）
"""
import json
import math
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)                 # 开发态: /Users/tiger/MolStudio
KETCHER_DIR = os.environ.get(
    "KETCHER_DIR",
    next((p for p in (os.path.join(ROOT, "ketcher-local"),
                      os.path.join(BASE, "ketcher-local"))
          if os.path.isdir(p)),
         os.path.join(ROOT, "ketcher-local")))
FUSION_DIR = BASE

from rdkit import Chem  # noqa: E402
from rdkit.Chem import AllChem  # noqa: E402

sys.path.insert(0, BASE)
import stereo  # noqa: E402  立体化学核心：KET↔RDKit 显式映射、整理、检查
import inorganic  # noqa: E402  小分子无机物的离线参考几何
import agent_gateway  # noqa: E402  本机模型鉴权与无缓冲流传输
import agent_external_bridge  # noqa: E402  外部 MCP / Harness 画布协同桥接


class ApiError(Exception):
    """带状态码与结构化信息的业务错误（前端据此区分"需要选择示例"等情形）。"""

    def __init__(self, message, code=None, status=400, extra=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.extra = extra or {}


def _ff_optimize(mol, max_iters, label):
    """力场优化（B11）：MMFF 能建立则优先；返回 -1 或建立/优化抛出可回退异常
    → 回退 UFF；返回 1 → 未收敛（保留部分优化坐标，附警告，不称已收敛）。
    返回警告列表（空 = 已成功收敛）。两个力场都不可用时抛可读 ValueError，
    不静默跳过优化。"""
    def not_converged(ff):
        return (f"{label}: {ff} 力场优化未在 {max_iters} 次迭代内收敛，"
                "构象可能未达到能量极小")

    mmff_err = None
    try:
        if AllChem.MMFFHasAllMoleculeParams(mol):
            res = AllChem.MMFFOptimizeMolecule(mol, maxIters=max_iters)
            if res == 0:
                return []
            if res == 1:
                return [not_converged("MMFF")]
            mmff_err = f"MMFF 优化返回码 {res}"
        else:
            mmff_err = "MMFF 力场参数缺失"
    except Exception as e:  # noqa: BLE001 可回退的 MMFF 异常 → 转 UFF
        mmff_err = f"MMFF 力场建立失败: {e}"
    try:
        if not AllChem.UFFHasAllMoleculeParams(mol):
            raise ValueError(
                f"{label}: 当前 3D 引擎缺少此结构的力场参数"
                f"（{mmff_err}，UFF 参数也缺失），无法生成经优化的三维构象；"
                "这不表示该化合物不存在或二维结构有误")
        res = AllChem.UFFOptimizeMolecule(mol, maxIters=max_iters)
        if res == 1:
            return [not_converged("UFF")]
        if res != 0:
            raise ValueError(f"{label}: 无法进行力场优化（{mmff_err}，UFF 返回码 {res}）")
        return []
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001 UFF 也建立失败 → 可读错误
        raise ValueError(f"{label}: 无法进行力场优化（{mmff_err}；UFF 异常: {e}）") from e


def gen3d_mol(mol, label: str):
    """已解析的 RDKit Mol → (molblock_3d, smiles, natoms, warnings, verify)。

    verify 是"三维坐标重新感知立体后，与输入已指定部分比对"的结果（见 stereo.py）。
    已指定中心在生成结果里被翻转属于工程错误，直接抛错，不静默返回错构型。
    """
    if mol is None or mol.GetNumAtoms() == 0:
        raise ValueError(f"{label}: 结构为空")
    mol_h = inorganic.build_3d(mol)
    warnings = []
    if mol_h is None:
        mol_h = Chem.AddHs(mol)
        params = AllChem.ETKDGv3()
        params.randomSeed = 0xF00D
        if AllChem.EmbedMolecule(mol_h, params) != 0:
            params.useRandomCoords = True
            if AllChem.EmbedMolecule(mol_h, params) != 0:
                raise ValueError("3D 构象生成失败（结构可能过大或不支持）")
        warnings = _ff_optimize(mol_h, 2000, label)
    smiles = Chem.MolToSmiles(mol)
    block = Chem.MolToMolBlock(mol_h)

    verify = {"checked": 0, "ok": True, "mismatches": []}
    try:
        got = stereo.stereo_from_3d(block)
        cmp = stereo.compare_specified(mol, got)
        verify = {"checked": cmp["checked"], "ok": cmp["ok"],
                  "mismatches": cmp["mismatches"]}
    except Exception as e:  # noqa: BLE001 复核失败本身是明确错误，不当"通过"
        raise ValueError(f"{label}: 三维结果立体复核失败（{e}）") from e
    if not verify["ok"]:
        raise ValueError(
            f"{label}: 生成的三维结构翻转了已指定的手性中心（{len(verify['mismatches'])} 处），已取消")
    return block, smiles, mol_h.GetNumAtoms(), warnings, verify


def gen3d(data: str):
    """输入 SMILES 或 molfile，返回 (molblock_3d, smiles, natoms, warnings)。
    旧调用方（机理文档）沿用四元组返回，立体复核结果丢弃但不放松检查。"""
    mol = parse_mol_any(data)
    block, smiles, natoms, warnings, _verify = gen3d_mol(mol, "分子")
    info = inorganic.geometry_info(mol)
    if info:
        warnings = warnings + [info["note"]]
    return block, smiles, natoms, warnings


def parse_mol_any(data: str):
    """SMILES 或 molfile → RDKit Mol（解析失败抛可读错误）。"""
    return stereo.parse_any(data)


def parse_mol(data: str):
    """Use the shared strict parser, including bounded inorganic exceptions."""
    return stereo.parse_any(data)


def gen3d_multi(data: str):
    """多个分子各自生成 3D，并沿 X 轴排开避免重叠，合并为一个 molblock。
    返回 (molblock_3d, natoms, warnings)，warnings 含参考模型说明/未收敛信息。"""
    parts = [p for p in data.split(".") if p.strip()]
    if not parts:
        raise ValueError("没有可用的分子")
    blocks = []
    warnings = []
    for p in parts:
        block, _smiles, _n, notes = gen3d(p)
        warnings.extend(notes)
        blocks.append(block)
    block, natoms = combine_blocks(blocks)
    return block, natoms, warnings


def _touched_frag_smiles(mol, idx):
    """idx = 命中的原子行集合 → 选区触及的所有片段 SMILES。
    片段归属用 GetMolFrags 返回的原始原子编号映射判断（B08）：MOL 原子编号
    可以交错，不能按片段大小推算编号区间。不去重：每个片段实例各一条
    （选 4 个分子返回 4 条，即使 SMILES 相同），并按片段画布 x 坐标从左到右
    排序（窗口序号与视觉顺序一致）。"""
    mapping = []
    frags = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=True,
                             fragsMolAtomMapping=mapping)
    touched = []
    for f, original_ids in zip(frags, mapping):
        if idx & set(original_ids):
            smi = Chem.MolToSmiles(f)
            if smi:
                if f.GetNumConformers():
                    xs = [f.GetConformer().GetAtomPosition(a.GetIdx()).x for a in f.GetAtoms()]
                else:
                    xs = [0.0]
                touched.append((min(xs), smi))
    if not touched:
        raise ValueError("找不到选区所属的分子")
    touched.sort(key=lambda t: t[0])
    return [smi for _, smi in touched]


def frag_smiles_by_atoms(molblock: str, atoms):
    """旧入口：选区以原子行索引给出（依赖 molfile 行序 = Ketcher 内部 id 序，可能错位）。"""
    mol = parse_mol(molblock)
    idx = set(int(i) for i in atoms if 0 <= int(i) < mol.GetNumAtoms())
    if not idx:
        raise ValueError("选区为空")
    return _touched_frag_smiles(mol, idx)


def frag_smiles_by_points(molblock: str, points, tol: float = 0.02):
    """新入口：选区以原子坐标给出，与 molfile 行序无关（免疫索引错位）。
    molfile 坐标 4 位小数、页面 pp 为双精度 → 舍入差 ≤5e-5，tol 放宽到 0.02。"""
    mol = parse_mol(molblock)
    if mol.GetNumConformers() == 0:
        raise ValueError("molblock 没有坐标，无法按位置匹配选区")
    conf = mol.GetConformer()
    idx = set()
    for p in points:
        px, py = float(p[0]), float(p[1])
        for i in range(mol.GetNumAtoms()):
            pos = conf.GetAtomPosition(i)
            if abs(pos.x - px) <= tol and abs(pos.y - py) <= tol:
                idx.add(i)
                break
    if not idx:
        raise ValueError("选区坐标没有命中任何原子")
    return _touched_frag_smiles(mol, idx)


def props_of(data: str):
    from collections import Counter
    from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors
    mol = parse_mol(data)
    mw = Descriptors.MolWt(mol)
    # 元素分析（B09）：在加氢副本上按每个原子的实际质量汇总，隐式氢与
    # 13C/2H 同位素都计入；分母用同一套总质量。工作分子保持不加氢，
    # atoms/formula/molwt 等其它字段不变，原输入不被修改。
    mol_h = Chem.AddHs(mol)
    el_mass = Counter()
    for a in mol_h.GetAtoms():
        el_mass[a.GetSymbol()] += a.GetMass()
    total = sum(el_mass.values())
    if not el_mass or total <= 0:
        raise ValueError("无法计算元素分析：结构为空或总质量为零")
    return {
        "smiles": Chem.MolToSmiles(mol),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "mw": round(mw, 3),
        "exact_mass": round(Descriptors.ExactMolWt(mol), 4),
        "logp": round(Crippen.MolLogP(mol), 2),
        "tpsa": round(rdMolDescriptors.CalcTPSA(mol), 2),
        "hbd": rdMolDescriptors.CalcNumHBD(mol),
        "hba": rdMolDescriptors.CalcNumHBA(mol),
        "rotb": rdMolDescriptors.CalcNumRotatableBonds(mol),
        "rings": rdMolDescriptors.CalcNumRings(mol),
        "heavy": mol.GetNumHeavyAtoms(),
        "atoms": mol.GetNumAtoms(),
        "ea": {el: round(100 * el_mass[el] / total, 2)
               for el in sorted(el_mass)},
    }


def check_mol(data: str):
    try:
        parse_mol(data)
        return []
    except ValueError:
        # Diagnose the untouched raw graph; never expose a partially sanitized Mol.
        d = data.rstrip()
        if any(marker in d for marker in ("M  END", "V2000", "V3000")):
            raw = Chem.MolFromMolBlock(d, sanitize=False, removeHs=False)
        else:
            raw = Chem.MolFromSmiles(d.strip(), sanitize=False)
        if raw is None:
            raise ValueError("结构无法解析，可能存在价键错误")
        problems = Chem.DetectChemistryProblems(raw)
        return [problem.Message() for problem in problems] or ["结构存在价键问题"]


def clean2d(data: str):
    from rdkit.Chem import rdDepictor
    mol = Chem.Mol(parse_mol(data))
    rdDepictor.SetPreferCoordGen(True)
    rdDepictor.Compute2DCoords(mol)
    return Chem.MolToMolBlock(mol)



def ket_to_molblock(ket: str) -> str:
    """极简 KET(V2) → V2000 molblock（纯文本，不依赖 RDKit）。"""
    d = json.loads(ket)
    atoms, bonds = [], []
    for key, sec in d.items():
        if key in ("root", "ket_version") or not isinstance(sec, dict) or sec.get("type") != "molecule":
            continue
        off = len(atoms)
        atoms.extend(sec.get("atoms", []))
        for b in sec.get("bonds", []):
            nb = dict(b)
            nb["atoms"] = [b["atoms"][0] + off, b["atoms"][1] + off]
            bonds.append(nb)
    for node in d.get("root", {}).get("nodes", []):
        if node.get("type") == "atom":
            atoms.append(node)
        elif node.get("type") == "bond":
            bonds.append(dict(node))
    if not atoms:
        raise ValueError("KET 里没有原子")
    n, m = len(atoms), len(bonds)
    lines = ["MolStudio", "  MolStudio ket2mol", ""]
    lines.append("%3d%3d  0  0  0  0  0  0  0  0999 V2000" % (n, m))
    chg = []
    iso = []
    for i, a in enumerate(atoms):
        x, y, z = (a.get("location") or [0, 0, 0])[:3]
        label = (a.get("label") or "C")[:3]
        lines.append("%10.4f%10.4f%10.4f %-3s 0 0  0  0  0  0  0  0  0  0  0  0" % (x, y, z, label))
        if a.get("charge"):
            chg.append((i + 1, int(a["charge"])))
        if a.get("isotope"):   # B07：只给有标记的原子写 M  ISO（绝对质量数、1-based 编号）
            iso.append((i + 1, int(a["isotope"])))
    for b in bonds:
        i1, i2 = b["atoms"]
        t = int(b.get("type", 1) or 1)
        stereo = int(b.get("stereo", 0) or 0)
        lines.append("%3d%3d%3d%3d  0  0  0" % (i1 + 1, i2 + 1, t, stereo))
    # 属性行布局：count 占第 6–8 列，每条记录占 8 列（编号 %4d + 值 %4d，无分隔空格），
    # 记录从第 9 列开始。RDKit 按固定列读取，多一格就会把值读丢（曾静默丢电荷/同位素）。
    for k in range(0, len(chg), 8):
        chunk = chg[k:k + 8]
        lines.append("M  CHG%3d" % len(chunk) + "".join("%4d%4d" % (i, c) for i, c in chunk))
    for k in range(0, len(iso), 8):   # V2000 每行最多 8 条记录，超出分行
        chunk = iso[k:k + 8]
        lines.append("M  ISO%3d" % len(chunk) + "".join("%4d%4d" % (i, v) for i, v in chunk))
    lines.append("M  END")
    rough = "\n".join(lines) + "\n"
    # 列宽审计：手拼原子行是 68 列短行，RDKit 会把错位的域读进 map 域并设
    # molAtomMapNumber="0"（SMILES 尾巴 [C@@:0]）。回读→清误读属性→交给
    # RDKit 规范写出（71 列标准行，坐标/楔键/电荷全保留）。
    try:
        mol = Chem.MolFromMolBlock(rough, removeHs=False)
        if mol is not None:
            for a in mol.GetAtoms():
                if a.HasProp("molAtomMapNumber") and a.GetAtomMapNum() == 0:
                    a.ClearProp("molAtomMapNumber")
            out = Chem.MolToMolBlock(mol)
            if out.rstrip().endswith("M  END"):
                return out
    except Exception:  # noqa: BLE001 解析失败退回手拼行
        pass
    return rough


_CHARGE_CODES = {0: 0, 1: 3, 2: 2, 3: 1, 4: 0, 5: -1, 6: -2, 7: -3}
# V2000 原子行电荷编码（ccc 域）→ 形式电荷；0 无电荷、4 为双自由基（无形式电荷）


def _parse_prop_records(lines, tag, n):
    """解析 M  CHG / M  ISO 属性行（B06）：每行先读记录数量，再两两读
    (1-based 原子编号, 值)；允许多条同类行、每行独立读 count。
    校验 count 非负、字段数与 count 一致、1 <= 编号 <= n，非法抛可读 ValueError。
    返回 {原子行索引: 值}；同一原子出现多条记录时后写覆盖（不累加）。"""
    values = {}
    for ln in lines:
        if not ln.startswith(tag):
            continue
        parts = ln[6:].split()
        try:
            count = int(parts[0])
        except (ValueError, IndexError):
            raise ValueError(f"molfile 属性行 {tag} 非法：无法读取记录数量")
        if count < 0:
            raise ValueError(f"molfile 属性行 {tag} 非法：记录数量不能为负数")
        if len(parts) != 1 + 2 * count:
            raise ValueError(f"molfile 属性行 {tag} 非法：声明 {count} 条记录，"
                             f"实际只有 {max(len(parts) - 1, 0)} 个字段")
        for k in range(count):
            try:
                atom_number = int(parts[1 + 2 * k])
                value = int(parts[2 + 2 * k])
            except (ValueError, IndexError):
                raise ValueError(f"molfile 属性行 {tag} 非法：第 {k + 1} 条记录无法解析")
            if not 1 <= atom_number <= n:
                raise ValueError(f"molfile 属性行 {tag} 非法：原子编号 {atom_number} "
                                 f"超出范围（应为 1–{n}）")
            values[atom_number - 1] = value
    return values


def molblock_to_ket(mb: str) -> str:
    """极简 V2000 molblock → KET(V2) JSON。"""
    lines = mb.rstrip().split("\n")
    if len(lines) < 5 or "V2000" not in lines[3]:
        raise ValueError("仅支持 V2000 molblock")
    n, m = int(lines[3][0:3]), int(lines[3][3:6])
    atoms = []
    for i in range(n):
        ln = lines[4 + i].ljust(39)
        atom = {"location": [float(ln[0:10]), float(ln[10:20]), float(ln[20:30])],
                "label": ln[31:34].strip()}
        # 原子行电荷编码（标准映射，B06）；若属性行也有电荷，按格式语义覆盖
        try:
            code = int(ln[36:39].strip() or 0)
        except ValueError:
            raise ValueError(f"molfile 原子行电荷编码非法：原子 {i + 1} "
                             f"的电荷域 '{ln[36:39]}'")
        if code not in _CHARGE_CODES:
            raise ValueError(f"molfile 原子行电荷编码非法：原子 {i + 1} "
                             f"的电荷码 {code} 不在 0–7 范围")
        if _CHARGE_CODES[code]:
            atom["charge"] = _CHARGE_CODES[code]
        atoms.append(atom)
    bonds = []
    for j in range(m):
        ln = lines[4 + n + j].ljust(12)
        bd = {"atoms": [int(ln[0:3]) - 1, int(ln[3:6]) - 1], "type": int(ln[6:9])}
        if int(ln[9:12] or 0):
            bd["stereo"] = int(ln[9:12])
        bonds.append(bd)
    # 属性行先校验解析（B06：每条 M  CHG 行独立读 count；非法记录可读失败）
    chg_props = _parse_prop_records(lines, "M  CHG", n)
    iso_props = _parse_prop_records(lines, "M  ISO", n)
    # 同位素（B07）：原子行质量差编码交给 RDKit 解码取绝对质量数，
    # 再被 M  ISO 属性行覆盖（属性行语义优先）。
    isotopes = {}
    decoded = Chem.MolFromMolBlock(mb, sanitize=False, removeHs=False)
    if decoded is not None and decoded.GetNumAtoms() == n:
        for a in decoded.GetAtoms():
            if a.GetIsotope():
                isotopes[a.GetIdx()] = a.GetIsotope()
    isotopes.update(iso_props)
    # 属性行电荷覆盖原子行电荷（按格式语义，不相加）
    for ai, c in chg_props.items():
        atoms[ai]["charge"] = c
    out_atoms = []
    for i, a in enumerate(atoms):
        o = {"location": a["location"]}
        if a["label"] and a["label"] != "C":
            o["label"] = a["label"]
        if a.get("charge"):
            o["charge"] = a["charge"]
        if isotopes.get(i):   # 只给有标记的原子写 isotope
            o["isotope"] = isotopes[i]
        out_atoms.append(o)
    doc = {"ket_version": "2.0.0",
           "root": {"nodes": [{"$ref": "mol0"}], "connections": [], "templates": []},
           "mol0": {"type": "molecule", "atoms": out_atoms,
                    "bonds": [{"type": b["type"], "atoms": b["atoms"],
                               **({"stereo": b["stereo"]} if "stereo" in b else {})} for b in bonds]}}
    return json.dumps(doc, ensure_ascii=False)


# --------------------------------------------------------------------------
# 立体检查 / 目标清单
# --------------------------------------------------------------------------

def resolve_targets(payload) -> tuple:
    """请求 → (目标列表, KET 文档或 None)。

    目标列表每项：{key, index, label, mol, section}。
    优先用画布 KET（能保留立体组语义）；没有 KET 时退回 data（SMILES/molfile）。
    """
    ket = payload.get("ket")
    if ket:
        try:
            doc = json.loads(ket)
        except Exception as e:  # noqa: BLE001
            raise ApiError(f"KET 解析失败：{e}", code="bad_ket") from e
        all_keys = stereo.molecule_keys(doc)
        keys = payload.get("keys") or all_keys
        if not isinstance(keys, list):
            raise ApiError("keys 必须是数组", code="bad_request")
        out = []
        for i, key in enumerate(keys):
            sec = doc.get(key)
            if not isinstance(sec, dict) or sec.get("type") != "molecule":
                raise ApiError(f"KET 里找不到分子 {key}", code="bad_ket")
            try:
                mol = stereo.mol_from_section(sec)
            except stereo.StereoError as e:
                raise ApiError(str(e), code="chem_error") from e
            out.append({"key": key, "index": i,
                        "label": (payload.get("labelOf") or {}).get(key) or f"分子 {i + 1}",
                        "mol": mol, "section": sec,
                        # 转换时做过的处理（例如芳香正电碳按价态补 1 个隐含氢）
                        "notes": stereo.mol_notes(mol)})
        if not out:
            raise ApiError("没有可检查的分子", code="empty")
        return out, doc

    data = payload.get("data")
    if not data or not str(data).strip():
        raise ApiError("缺少结构数据", code="empty")
    try:
        mol = stereo.parse_any(str(data))
    except stereo.StereoError as e:
        raise ApiError(str(e), code="chem_error") from e
    return [{"key": None, "index": 0, "label": "分子", "mol": mol, "section": None,
             "notes": stereo.mol_notes(mol)}], None


def _empty_counts():
    return {"specified": 0, "unspecified": 0, "unknown": 0}


def stereo_report(targets) -> dict:
    """逐项检查后汇总（一次请求只弹一次提示，后端仍逐个覆盖）。"""
    items = []
    tetra, double, other = _empty_counts(), _empty_counts(), _empty_counts()
    groups = {"abs": 0, "and": 0, "or": 0}
    reasons = []
    for t in targets:
        try:
            a = stereo.analyze_mol(t["mol"], t["section"])
        except stereo.StereoError as e:
            raise ApiError(f"{t['label']}: {e}", code="check_failed") from e
        for bucket, acc in (("tetrahedral", tetra), ("double", double), ("other", other)):
            for k in acc:
                acc[k] += a[bucket][k]
        for k in groups:
            groups[k] += a["groups"][k]
        for r in a["reasons"]:
            if r not in reasons:
                reasons.append(r)
        items.append({
            "key": t["key"], "index": t["index"], "label": t["label"],
            "notes": list(t.get("notes") or []),
            "smiles": Chem.MolToSmiles(t["mol"]),
            "tetrahedral": a["tetrahedral"], "double": a["double"],
            "other": a["other"], "groups": a["groups"],
            "reasons": a["reasons"], "needsChoice": a["needsChoice"],
        })
    summary = {
        "tetrahedral": tetra, "double": double, "other": other,
        "groups": groups, "reasons": reasons,
        "needsChoice": bool(reasons),
        "moleculesNeedingChoice": [i["key"] for i in items if i["needsChoice"]],
    }
    return {"molecules": items, "summary": summary}


def stereo_guard(targets, allow_example: bool) -> dict:
    """生成前的硬校验：需要示例选择却没得到许可 → 业务错误，绝不静默生成。"""
    rep = stereo_report(targets)
    if rep["summary"]["needsChoice"] and not allow_example:
        raise ApiError(
            "部分立体构型尚未确定，需要先选择如何处理",
            code="stereo_choice_required", status=409,
            extra={"stereo": rep})
    return rep


def stereo_source(rep: dict, targets) -> dict:
    """结果里的"立体来源"信息：由实际检查结果得出，不复制请求里的布尔值。"""
    s = rep["summary"]
    return {
        "example": bool(s["needsChoice"]),
        "reasons": list(s["reasons"]),
        "molecules": [t["label"] for t, item in zip(targets, rep["molecules"])
                      if item["needsChoice"]],
        "groups": dict(s["groups"]),
        "counts": {"tetrahedral": dict(s["tetrahedral"]),
                   "double": dict(s["double"])},
    }


def combine_blocks(blocks):
    """多个 molblock 沿 X 轴排开合并（保持原有"同窗排开"的显示规则）。"""
    from rdkit.Geometry import Point3D
    mols = []
    for b in blocks:
        m = Chem.MolFromMolBlock(b, sanitize=False, removeHs=False)
        if m is None:
            raise ValueError("生成结果无法解析")
        mols.append(m)
    if not mols:
        raise ValueError("没有可显示的结构")
    cursor, gap = 0.0, 2.5
    for m in mols:
        conf = m.GetConformer()
        xs = [conf.GetAtomPosition(i).x for i in range(m.GetNumAtoms())]
        minx, maxx = min(xs), max(xs)
        dx = cursor - minx
        for i in range(m.GetNumAtoms()):
            pos = conf.GetAtomPosition(i)
            conf.SetAtomPosition(i, Point3D(pos.x + dx, pos.y, pos.z))
        cursor += (maxx - minx) + gap
    combined = mols[0]
    for m in mols[1:]:
        combined = Chem.CombineMols(combined, m)
    reference_names = [m.GetProp("_Name").removeprefix(inorganic.TITLE_PREFIX).split(" · ", 1)[0]
                       for m in mols if m.HasProp("_Name") and m.GetProp("_Name").startswith(inorganic.TITLE_PREFIX)]
    if reference_names:
        names = "、".join(reference_names[:4]) + ("等" if len(reference_names) > 4 else "")
        combined.SetProp("_Name", inorganic.TITLE_PREFIX + "混合显示，含 " + names + "；参考模型未做力场优化")
    return Chem.MolToMolBlock(combined), combined.GetNumAtoms()


def gen3d_targets(targets):
    """多个目标分子 → (合并 molblock, natoms, warnings, verifies)。"""
    blocks, warnings, verifies = [], [], []
    for t in targets:
        block, _smiles, _n, w, verify = gen3d_mol(t["mol"], t["label"])
        blocks.append(block)
        warnings.extend(w)
        verifies.append({"key": t["key"], "ok": verify["ok"],
                         "checked": verify["checked"]})
    block, natoms = combine_blocks(blocks)
    return block, natoms, warnings, verifies


def attach_geometry_info(response, targets):
    """Disclose reference models through the existing native note display."""
    models = []
    notes = list(response.get("notes") or [])
    for target in targets:
        info = inorganic.geometry_info(target["mol"])
        if info:
            models.append({"key": target["key"], **info})
            if info["note"] not in notes:
                notes.append(info["note"])
    if models:
        response["geometry"] = models[0] if len(targets) == 1 else {"molecules": models}
        response["notes"] = notes
    return response


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_file(self, path: str):
        real = os.path.realpath(path)
        if not (real.startswith(os.path.realpath(KETCHER_DIR) + os.sep)
                or real.startswith(os.path.realpath(FUSION_DIR) + os.sep)):
            self._send(403, b"forbidden", "text/plain; charset=utf-8")
            return
        if os.path.isdir(real):
            real = os.path.join(real, "index.html")
        if not os.path.isfile(real):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ctype = self.guess_type(real)
        if real.endswith((".js", ".mjs")):
            ctype = "application/javascript"
        elif real.endswith(".wasm"):
            ctype = "application/wasm"
        with open(real, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        if agent_gateway.handle_get(self) or agent_external_bridge.handle_get(self):
            return
        path = self.path.split("?")[0]
        if path in ("/", "/index.html", "/canvas.html", "/threed.html", "/help.html"):
            name = "canvas.html" if path in ("/", "/index.html") else path.lstrip("/")
            return self._send_file(os.path.join(FUSION_DIR, name))
        if path.startswith("/vendor/"):
            return self._send_file(os.path.join(FUSION_DIR, path.lstrip("/")))
        # 机理层模块（workbench/*.js）：与 canvas.html 同源，按固定顺序加载
        if path.startswith("/workbench/"):
            return self._send_file(os.path.join(FUSION_DIR, path.lstrip("/")))
        if path.startswith("/agent/"):
            # Serve only browser assets; source dependencies and package files stay private.
            if path not in ("/agent/panel.js", "/agent/panel.css", "/agent/app.js", "/agent/dist/agent-runtime.js"):
                return self._send(404, b"not found", "text/plain; charset=utf-8")
            return self._send_file(os.path.join(FUSION_DIR, path.lstrip("/")))
        if path.startswith("/ketcher/"):
            return self._send_file(os.path.join(KETCHER_DIR, path[len("/ketcher/"):].lstrip("/")))
        # 兼容 Ketcher 内部绝对路径资源（/static/...、/manifest.json 等）
        return self._send_file(os.path.join(KETCHER_DIR, path.lstrip("/")))

    def do_POST(self):
        if agent_gateway.handle_post(self) or agent_external_bridge.handle_post(self, local_inspect=self._inspect_structures_local):
            return
        path = self.path.split("?")[0]
        routes = {
            "/api/gen3d": self._api_gen3d,
            "/api/gen3d_all": self._api_gen3d_all,
            "/api/frag_smiles": self._api_frag_smiles,
            "/api/props": self._api_props,
            "/api/check": self._api_check,
            "/api/clean": self._api_clean,
            "/api/ket2mol": self._api_ket2mol,
            "/api/mol2ket": self._api_mol2ket,
            "/api/layout": self._api_layout,
            "/api/stereocheck": self._api_stereocheck,
            "/api/agent/structure": self._api_agent_structure,
        }
        fn = routes.get(path)
        if fn is None:
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ApiError("请求体必须是 JSON 对象", code="bad_request")
            data = str(payload.get("smiles", "")) if path == "/api/agent/structure" else str(payload.get("data", ""))
            self._payload = payload
            if path == "/api/agent/structure":
                agent_gateway.AgentGateway.check_origin(self)
            # ket 请求可以不传 data；两者都没有才是空请求
            if not data.strip() and not payload.get("ket"):
                raise ApiError("画布是空的", code="empty")
            self._send(200, json.dumps(fn(data), ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")
        except agent_gateway.GatewayError as e:
            self._send(e.status, json.dumps({"ok": False, "error": str(e), "code": e.code}).encode("utf-8"), "application/json; charset=utf-8")
        except ApiError as e:
            body = {"ok": False, "error": e.message}
            if e.code:
                body["code"] = e.code
            body.update(e.extra)
            self._send(e.status, json.dumps(body, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")
        except stereo.StereoError as e:
            self._send(400, json.dumps({"ok": False, "error": str(e), "code": "chem_error"},
                                       ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")
        except Exception as e:  # noqa: BLE001
            self._send(400, json.dumps({"ok": False, "error": str(e)},
                                       ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

    def _inspect_structures_local(self, args):
        items = args.get("structures") if isinstance(args, dict) else None
        if not isinstance(items, list) or not (1 <= len(items) <= 12):
            raise agent_external_bridge.BridgeError("结构检查需要 1–12 个项目", 400, "bad_request")
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                raise agent_external_bridge.BridgeError("结构检查项目必须是对象", 400, "bad_request")
            item_id = item.get("id")
            smiles = item.get("smiles")
            if not isinstance(item_id, str) or not item_id.strip() or len(item_id) > 160 or item_id in seen:
                raise agent_external_bridge.BridgeError("结构检查 ID 无效或重复", 400, "bad_request")
            if not isinstance(smiles, str) or not smiles.strip() or len(smiles) > 12000:
                raise agent_external_bridge.BridgeError("结构检查 SMILES 无效", 400, "bad_request")
            seen.add(item_id)
        results = []
        for item in items:
            item_id = item["id"]
            try:
                res = self._api_agent_structure(item["smiles"])
                results.append({"id": item_id, "ok": True, "atoms": res["atoms"], "bonds": res["bonds"]})
            except ApiError as e:
                record = {
                    "id": item_id,
                    "ok": False,
                    "error": e.message[:300],
                    "code": e.code or "structure_failed",
                }
                if e.extra.get("field") == "smiles":
                    record["field"] = "smiles"
                for key in ("atomIndex", "atomMap", "mappedAtomIndices", "unmappedAtomIndices", "duplicateAtomMaps"):
                    if key in e.extra:
                        record[key] = e.extra[key]
                results.append(record)
        return {
            "ok": True,
            "isError": False,
            "text": json.dumps(results, ensure_ascii=False),
            "data": results,
        }

    def _api_agent_structure(self, data):
        """A mapped small molecule, retaining an explicit atom/bond reference map."""
        if len(data) > 12000:
            raise ApiError("结构表达超过当前上限", code="structure_too_large")
        parser = Chem.SmilesParserParams()
        # A mapped, bonded H can be the source or target of an electron arrow.
        parser.removeHs = False
        try:
            mol = stereo.parse_smiles(data, remove_hs=False)
        except stereo.StereoError:
            mol = None
        if mol is None:
            # Preserve the standard sanitized parser on success. An unsanitized
            # parse is useful only for locating failures and is never drawn.
            parser.sanitize = False
            raw = Chem.MolFromSmiles(data, parser)
            if raw is None:
                raise ApiError("SMILES 语法无法解析，请检查括号、键和环编号", code="smiles_syntax", extra={"field": "smiles"})
            problems = Chem.DetectChemistryProblems(raw)
            valence_problem = next((p for p in problems if p.GetType() == "AtomValenceException"), None)
            problem = valence_problem or (problems[0] if problems else None)
            code = "smiles_valence" if valence_problem is not None else "smiles_sanitization"
            reason = "原子价态不合法" if valence_problem is not None else "结构化学检查未通过"
            extra = {"field": "smiles"}
            if problem is not None and hasattr(problem, "GetAtomIdx"):
                atom_index = problem.GetAtomIdx()
                extra["atomIndex"] = atom_index
                map_num = raw.GetAtomWithIdx(atom_index).GetAtomMapNum()
                if map_num:
                    extra["atomMap"] = map_num
            if problem is not None:
                reason += "。" + problem.Message()[:160]
            raise ApiError(reason, code=code, extra=extra)
        if not 0 < mol.GetNumAtoms() <= 512 or mol.GetNumBonds() > 1024:
            raise ApiError("单个结构最多支持 512 个原子", code="structure_too_large")
        numbers = [atom.GetAtomMapNum() for atom in mol.GetAtoms()]
        if any(numbers) and not all(numbers):
            mapped = [i for i, number in enumerate(numbers) if number]
            missing = [i for i, number in enumerate(numbers) if not number]
            raise ApiError(f"原子映射不完整；未映射原子索引 {missing[:8]}", code="partial_atom_mapping",
                           extra={"field": "smiles", "mappedAtomIndices": mapped[:8], "unmappedAtomIndices": missing[:8]})
        if any(numbers) and len(set(numbers)) != len(numbers):
            duplicates = sorted({number for number in numbers if numbers.count(number) > 1})
            duplicate_indices = {str(number): [i for i, value in enumerate(numbers) if value == number][:8]
                                 for number in duplicates[:8]}
            raise ApiError(f"原子映射编号重复：{duplicates[:8]}", code="duplicate_atom_mapping",
                           extra={"field": "smiles", "duplicateAtomMaps": duplicate_indices})
        for atom in mol.GetAtoms():
            electrons = atom.GetNumRadicalElectrons()
            if electrons > 2:
                extra = {"field": "smiles", "atomIndex": atom.GetIdx(), "radicalElectrons": electrons}
                if atom.GetAtomMapNum():
                    extra["atomMap"] = atom.GetAtomMapNum()
                raise ApiError("该自由基电子数无法用画布表示", code="unsupported_radical_state", extra=extra)
        refs = numbers if all(numbers) else list(range(1, mol.GetNumAtoms() + 1))
        from rdkit.Chem import rdDepictor
        if rdDepictor.IsCoordGenSupportAvailable():
            from rdkit.Chem import rdCoordGen
            # Use the same generator as Clean independently of its process-wide preference.
            rdCoordGen.AddCoords(mol)
        # CoordGen can produce non-finite coordinates for hydrogen-only structures.
        if not mol.GetNumConformers() or not all(map(math.isfinite, mol.GetConformer().GetPositions().flat)):
            rdDepictor.Compute2DCoords(mol, forceRDKit=True)
            if not all(map(math.isfinite, mol.GetConformer().GetPositions().flat)):
                raise ApiError("无法为该结构生成有效坐标", code="invalid_structure_coordinates")
        atom_info = [{"ref": str(refs[atom.GetIdx()]), "index": atom.GetIdx(), "label": atom.GetSymbol(),
                      "charge": atom.GetFormalCharge(), "radicalElectrons": atom.GetNumRadicalElectrons()}
                     for atom in mol.GetAtoms()]
        bond_info = [{"ref": str(bond.GetIdx() + 1), "index": bond.GetIdx(),
                      "begin": str(refs[bond.GetBeginAtomIdx()]), "end": str(refs[bond.GetEndAtomIdx()]),
                      "order": bond.GetBondTypeAsDouble()}
                     for bond in mol.GetBonds()]
        for atom in mol.GetAtoms():
            atom.SetAtomMapNum(0)
        ket = json.loads(molblock_to_ket(Chem.MolToMolBlock(mol)))
        # Keep chemical order distinct from the actual depiction encoding:
        # aromatic RDKit bonds have order 1.5, while this KET can be Kekulized.
        for bond in bond_info:
            bond["nativeType"] = ket["mol0"]["bonds"][bond["index"]]["type"]
        # molblock_to_ket already retains charge/isotope/stereo; retain radical marks too.
        for atom in mol.GetAtoms():
            ket_atom = ket["mol0"]["atoms"][atom.GetIdx()]
            ket_atom["label"] = atom.GetSymbol()
            # Bracket-specified H atoms are counts on this atom, not bonded H
            # vertices; include them without double-counting explicit neighbours.
            ket_atom["implicitHCount"] = atom.GetNumImplicitHs() + atom.GetNumExplicitHs()
            radicals = atom.GetNumRadicalElectrons()
            if radicals:
                ket["mol0"]["atoms"][atom.GetIdx()]["radical"] = 2 if radicals == 1 else 3
        return {"ok": True, "ket": ket, "atoms": atom_info, "bonds": bond_info,
                "smiles": Chem.MolToSmiles(mol)}

    def _api_gen3d(self, data):
        payload = self._payload or {}
        allow = bool(payload.get("allowExample"))
        targets, _doc = resolve_targets(payload)
        if len(targets) > 1:
            raise ApiError("gen3d 一次只处理一个分子，多分子请用 gen3d_all", code="bad_request")
        rep = stereo_guard(targets, allow)
        t = targets[0]
        block, smiles, natoms, warnings, verify = gen3d_mol(t["mol"], t["label"])
        resp = {"ok": True, "molblock": block, "smiles": smiles, "natoms": natoms,
                "stereo": stereo_source(rep, targets),
                "stereoVerified": verify,
                "identity": payload.get("identity")}
        if warnings:
            resp["warnings"] = warnings   # 兼容性扩展：力场未收敛等状态说明
        notes = list(t.get("notes") or [])
        if notes:
            resp["notes"] = notes          # 转换时做过的处理（补氢等），界面须展示
        return attach_geometry_info(resp, targets)

    def _api_gen3d_all(self, data):
        payload = self._payload or {}
        allow = bool(payload.get("allowExample"))
        targets, _doc = resolve_targets(payload)
        rep = stereo_guard(targets, allow)
        if len(targets) == 1:
            block, smiles, natoms, warnings, verify = gen3d_mol(targets[0]["mol"],
                                                               targets[0]["label"])
            resp = {"ok": True, "molblock": block, "smiles": smiles, "natoms": natoms,
                    "stereo": stereo_source(rep, targets),
                    "stereoVerified": verify,
                    "identity": payload.get("identity")}
        else:
            block, natoms, warnings, verifies = gen3d_targets(targets)
            resp = {"ok": True, "molblock": block, "natoms": natoms,
                    "stereo": stereo_source(rep, targets),
                    "stereoVerified": {"checked": 0, "ok": all(v["ok"] for v in verifies),
                                       "molecules": verifies},
                    "identity": payload.get("identity")}
        if warnings:
            resp["warnings"] = warnings   # 兼容性扩展：指出未收敛的片段
        notes = []
        for t in targets:
            for n in t.get("notes") or []:
                if n not in notes:
                    notes.append(n)
        if notes:
            resp["notes"] = notes          # 转换时做过的处理（补氢等），界面须展示
        return attach_geometry_info(resp, targets)

    def _api_stereocheck(self, data):
        payload = self._payload or {}
        targets, _doc = resolve_targets(payload)
        rep = stereo_report(targets)
        rep["ok"] = True
        rep["identity"] = payload.get("identity")
        return rep

    def _api_layout(self, data):
        payload = self._payload or {}
        ket = payload.get("ket") or data
        if not ket:
            raise ApiError("缺少画布数据", code="empty")
        points = payload.get("points") or None
        targets = payload.get("targets") or None
        compact = payload.get("compact")
        if compact is None:
            # 全画布整理（无选区）默认做反应级紧凑排布；选中整理不全局重排。
            compact = points is None
        try:
            res = stereo.layout_ket(str(ket), targets=targets, points=points, compact=bool(compact))
        except stereo.StereoError as e:
            raise ApiError(str(e), code="layout_failed") from e
        res["identity"] = payload.get("identity")
        return res

    def _api_frag_smiles(self, data):
        payload = self._payload or {}
        pts = payload.get("points")
        if pts:
            lst = frag_smiles_by_points(data, pts)
        else:
            lst = frag_smiles_by_atoms(data, payload.get("atoms") or [])
        return {"ok": True, "smiles": lst[0], "list": lst}

    def _api_props(self, data):
        p = props_of(data)
        p["ok"] = True
        return p

    def _api_check(self, data):
        problems = check_mol(data)
        return {"ok": True, "problems": problems,
                "clean": len(problems) == 0}

    def _api_clean(self, data):
        return {"ok": True, "molblock": clean2d(data)}

    def _api_ket2mol(self, data):
        return {"ok": True, "molblock": ket_to_molblock(data)}

    def _api_mol2ket(self, data):
        return {"ok": True, "ket": molblock_to_ket(data)}


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8361
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    agent_external_bridge.bridge().register_port(srv.server_port)
    print(f"Ketcher×3D 融合版: http://127.0.0.1:{srv.server_port}/  (Ctrl+C 退出)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
