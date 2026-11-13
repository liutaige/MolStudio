"""立体化学支持：KET ↔ RDKit 显式映射、CoordGen 二维整理、立体检查。

本模块是"整理结构"和"生成 3D 前立体检查"的化学核心，被 server.py 调用。

约定（重要）
------------
1. KET 里 molecule 段的 atoms 数组顺序，就是本模块的 RDKit 原子索引（1:1）。
   本模块从不重排原子、不做几何最近邻匹配，调用方据此建立编辑器对象映射。
2. 坐标系：KET 的 location = (pp.x, -pp.y)。本模块对外一律使用 KET 坐标系；
   编辑器 pp 坐标的换算由前端完成。
3. 化学信息一律从 KET 原始数据读出（电荷、同位素、自由基、立体标签、
   显式氢），不依赖 MOL 文本往返；MOL 只作 RDKit 的计算交换格式。
"""

from __future__ import annotations

import copy
import json
import math
import re
from bisect import bisect_right

from rdkit import Chem
from rdkit.Chem import rdDepictor, rdMolDescriptors

import inorganic

# KET bond.stereo 取值（与 MDL 楔键编码一致）
STEREO_NONE = 0
STEREO_UP = 1
STEREO_EITHER = 4
STEREO_DOWN = 6
STEREO_CIS_TRANS = 3      # 双键：顺反未定（Ketcher 的交叉双键）

# 立体检查里区分"缺省未指定"和"用户显式表达的未知"
SPEC_SPECIFIED = "specified"
SPEC_UNSPECIFIED = "unspecified"
SPEC_UNKNOWN = "unknown"

# 支持整理的键类型（1=单键 2=双键 3=三键 4=芳香键）
_SUPPORTED_BOND_TYPES = {1, 2, 3, 4}
_QUERY_LABELS = {"A", "Q", "L", "R", "R#", "X", "*", "Any", "Pol", "Mod", "Gen"}

# 转换过程中做过、需要告知用户的处理（画布不动，只影响计算副本）
MOL_NOTES_PROP = "_MolStudioNotes"


class StereoError(ValueError):
    """可读的化学/格式错误：调用方应展示给用户，不得静默继续。"""


# --------------------------------------------------------------------------
# KET 读取
# --------------------------------------------------------------------------

def molecule_keys(doc) -> list:
    """按 root.nodes 顺序返回 molecule 段键名（画布顺序）。"""
    if not isinstance(doc, dict):
        raise StereoError("KET 数据不是 JSON 对象")
    root = doc.get("root") or {}
    keys = []
    for node in root.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        ref = node.get("$ref")
        sec = doc.get(ref) if isinstance(ref, str) else None
        if isinstance(sec, dict) and sec.get("type") == "molecule":
            keys.append(ref)
    if not keys:
        # 兼容没有 root.nodes 的极简 KET：按插入顺序取所有 molecule 段
        keys = [k for k, v in doc.items()
                if isinstance(v, dict) and v.get("type") == "molecule"]
    if not keys:
        raise StereoError("KET 里没有分子")
    return keys


def _atom_symbol(atom) -> tuple:
    """KET 原子 → (元素符号, 同位素或 None)。D/T 是氢的同位素写法。"""
    label = str(atom.get("label") or "C").strip()
    iso = atom.get("isotope")
    if label == "D":
        return "H", 2
    if label == "T":
        return "H", 3
    return label, iso


def _check_supported(section) -> None:
    for i, a in enumerate(section.get("atoms") or []):
        label = str(a.get("label") or "C").strip()
        if label in _QUERY_LABELS:
            raise StereoError(f"第 {i + 1} 个原子是查询原子（{label}），本轮不支持自动整理")
    for b in section.get("bonds") or []:
        t = int(b.get("type") or 1)
        if t not in _SUPPORTED_BOND_TYPES:
            raise StereoError("结构含查询键（键类型 %d），本轮不支持自动整理" % t)
        if b.get("customQuery"):
            raise StereoError("结构含自定义查询键，本轮不支持自动整理")


def molblock_from_section(section) -> str:
    """KET molecule 段 → V2000 molblock，原子顺序与 KET 数组顺序严格一致。"""
    _check_supported(section)
    atoms = section.get("atoms") or []
    bonds = section.get("bonds") or []
    if not atoms:
        raise StereoError("分子没有原子")
    lines = ["MolStudio", "  MolStudio stereo", ""]
    lines.append("%3d%3d  0  0  0  0  0  0  0  0999 V2000" % (len(atoms), len(bonds)))
    chg, iso, rad = [], [], []
    for i, a in enumerate(atoms):
        sym, isotope = _atom_symbol(a)
        loc = a.get("location") or [0.0, 0.0, 0.0]
        x, y = float(loc[0]), float(loc[1])
        z = float(loc[2]) if len(loc) > 2 else 0.0
        lines.append("%10.4f%10.4f%10.4f %-3s 0  0  0  0  0  0  0  0  0  0  0  0"
                     % (x, y, z, sym))
        charge = int(a.get("charge") or 0)
        if charge:
            chg.append((i + 1, charge))
        if isotope:
            iso.append((i + 1, int(isotope)))
        radical = int(a.get("radical") or 0)
        if radical:
            rad.append((i + 1, radical))
    for b in bonds:
        ends = b.get("atoms") or []
        if len(ends) != 2:
            raise StereoError("键缺少端点")
        i1, i2 = int(ends[0]), int(ends[1])
        if not (0 <= i1 < len(atoms) and 0 <= i2 < len(atoms)):
            raise StereoError("键端点索引越界")
        t = int(b.get("type") or 1)
        st = int(b.get("stereo") or 0)
        if t != 1:
            # 楔键只对单键有意义；但双键的 3 = 顺反未定（Ketcher 的交叉双键），
            # 这是用户显式表达的"未知"，必须原样交给化学引擎，不能清零
            st = st if (t == 2 and st == STEREO_CIS_TRANS) else 0
        lines.append("%3d%3d%3d%3d  0  0  0" % (i1 + 1, i2 + 1, t, st))
    # 属性行：count 占第 6–8 列，每条记录 8 列（%4d%4d），每行最多 8 条
    for tag, recs in (("M  CHG", chg), ("M  ISO", iso), ("M  RAD", rad)):
        for k in range(0, len(recs), 8):
            chunk = recs[k:k + 8]
            lines.append(tag + "%3d" % len(chunk)
                         + "".join("%4d%4d" % (i, v) for i, v in chunk))
    lines.append("M  END")
    return "\n".join(lines) + "\n"


def stereo_labels(section) -> dict:
    """KET 原子 stereoLabel（abs / &n / orN）→ {"abs": [...], "and": [...], "or": [...]}。

    RDKit 的 Python 接口不能把立体组写回 Mol（没有 SetStereoGroups），所以组语义
    一律以 KET 原始数据为准：这里只做归类，供检查结果使用。
    """
    out = {"abs": [], "and": [], "or": []}
    for i, a in enumerate(section.get("atoms") or []):
        label = a.get("stereoLabel")
        if not label:
            continue
        kind = _group_kind(str(label))
        if kind in out:
            out[kind].append(i)
    return out


def ket_h_counts(section) -> dict:
    """KET 显式写出的隐含氢数 → {原子索引: 氢数}（0 也算明确给出）。

    Ketcher 只在"按默认价态推不出来"时写 implicitHCount，芳香环上带正电的碳
    就是典型：三条芳香键按 1.5 阶算已满足 C+ 的价态，编辑器不会自动补氢，
    但真实结构（如环丙烯正离子）需要那 1 个氢。这个字段是编辑器的权威声明，
    丢掉它会让芳香正离子在 Kekulize 阶段失败。
    """
    out = {}
    for i, a in enumerate(section.get("atoms") or []):
        if "implicitHCount" not in a:
            continue
        raw = a.get("implicitHCount")
        try:
            n = int(raw)
        except (TypeError, ValueError):
            raise StereoError(f"第 {i + 1} 个原子的氢数（implicitHCount）不是整数：{raw!r}")
        if n < 0 or n > 16:
            raise StereoError(f"第 {i + 1} 个原子的氢数（implicitHCount）超出合理范围：{n}")
        out[i] = n
    return out


def _apply_ket_h_counts(mol, section, counts=None) -> dict:
    """把 KET 的隐含氢数写到 RDKit 原子上（原子索引不变，不加 H 原子）。

    必须用"显式氢数 + 关闭隐式推导"，而不是 MOL 原子行的 H 计数字段：
    RDKit 读 H 计数字段只置 noImplicit，并不加氢，反而会把该原子的氢清零。
    """
    if counts is None:
        counts = ket_h_counts(section)
    for idx, n in counts.items():
        if idx >= mol.GetNumAtoms():
            raise StereoError(f"第 {idx + 1} 个原子的氢数记录越界")
        atom = mol.GetAtomWithIdx(idx)
        if atom.GetAtomicNum() == 1:
            continue                      # 显式氢原子自身不承载隐含氢
        atom.SetNumExplicitHs(n)
        atom.SetNoImplicit(True)
    return counts


def _aromatic_cation_holes(mol, ket_counts) -> list:
    """芳香环上"2 配位、+1 电荷、没有任何氢、KET 也没给氢数"的碳。

    这类原子是芳香价态不完整的正电碳：编辑器按 1.5 阶算价态得出 0 氢，
    RDKit 按整数价态则无法 Kekulize。返回原子索引列表（可能为空）。
    """
    out = []
    for atom in mol.GetAtoms():
        if atom.GetSymbol() != "C" or atom.GetFormalCharge() != 1:
            continue
        if atom.GetDegree() != 2:
            continue
        # 这里不能用 GetTotalNumHs()：SanitizeMol 在 Kekulize 阶段就失败了，
        # 属性缓存还没算出来，取隐含氢会抛"preceding call to calcImplicitValence"。
        if atom.GetNumExplicitHs() != 0:
            continue
        if any(n.GetAtomicNum() == 1 for n in atom.GetNeighbors()):
            continue
        if atom.GetIdx() in ket_counts:
            continue
        bonds = list(atom.GetBonds())
        if len(bonds) != 2 or not all(b.GetBondType() == Chem.BondType.AROMATIC for b in bonds):
            continue
        out.append(atom.GetIdx())
    return out


_EXPLICIT_VALENCE_RE = re.compile(
    r"Explicit valence for atom #\s*(\d+)\s*([A-Za-z]+)\s*greater than permitted"
)


def _format_chem_error(error, block=None) -> str:
    """把 RDKit 底层化学校验报错转换为面向用户的可读提示。"""
    err = str(error)
    m = _EXPLICIT_VALENCE_RE.search(err)
    if m:
        idx = int(m.group(1))
        elem = m.group(2)
        return (f"结构化学校验失败：第 {idx + 1} 个原子（{elem}）显式价态超出允许上限"
                f"（请检查多重键、电荷或残留自由基标记；{error}）")
    return f"结构化学校验失败：{error}"


def _kekulize_error(error) -> StereoError:
    """芳香体系无法分配单双键时的可读错误（区分于立体构型问题）。"""
    return StereoError(
        f"结构化学校验失败：芳香环无法分配单双键（{error}）。"
        "常见原因是芳香环上带电荷的原子缺少氢数信息；"
        "可改用明确的单/双键表示，或给该原子补一个显式氢后重试。")


def _complete_aromatic_cation(block, ket_counts, error):
    """唯一可判定的补氢：芳香环上只有一个正电碳缺氢时，按芳香价态补 1 个氢。

    只在 Kekulize 失败、且恰好只有一个候选原子时执行；补氢后仍不能通过完整
    SanitizeMol 校验就原样报错。补的是计算副本的隐含氢，画布结构不变，并在
    返回值上留说明供界面展示。

    注意必须从 molblock 重新解析：失败的 SanitizeMol 会把芳香键降成单键，
    在它留下的对象上继续操作会得到另一个分子（环丙烷正离子而不是芳香环）。
    """
    if "kekul" not in str(error).lower():
        raise StereoError(_format_chem_error(error, block)) from error
    trial = _parse_block(block)
    # 重新解析会丢掉 KET 声明的氢数，必须重新写回，否则其他原子的氢数被 RDKit 重新推导
    _apply_ket_h_counts(trial, None, ket_counts)
    holes = _aromatic_cation_holes(trial, ket_counts)
    if len(holes) != 1:
        raise _kekulize_error(error) from error
    atom = trial.GetAtomWithIdx(holes[0])
    atom.SetNumExplicitHs(1)
    atom.SetNoImplicit(True)
    try:
        _sanitize(trial)
    except Exception:  # noqa: BLE001 补氢也救不回来 → 保持原错误
        raise _kekulize_error(error) from error
    note = (f"芳香环上第 {holes[0] + 1} 个碳带正电且未标氢，已按芳香价态补 1 个"
            f"隐含氢（{rdMolDescriptors.CalcMolFormula(trial)}）；画布结构未改动")
    trial.SetProp(MOL_NOTES_PROP, json.dumps([note], ensure_ascii=False))
    return trial


def mol_notes(mol) -> list:
    """转换时产生的说明（补氢等）；没有则空列表。"""
    try:
        if mol is not None and mol.HasProp(MOL_NOTES_PROP):
            return json.loads(mol.GetProp(MOL_NOTES_PROP))
    except Exception:  # noqa: BLE001 说明只是附注，读不出来不影响结构
        pass
    return []


def _parse_block(block: str) -> Chem.Mol:
    """V2000 文本 → 未 sanitize 的 RDKit Mol（原子顺序与 KET 一致）。"""
    mol = Chem.MolFromMolBlock(block, sanitize=False, removeHs=False, strictParsing=False)
    if mol is None:
        raise StereoError("结构无法被化学引擎解析（可能存在价键错误）")
    return mol


def _sanitize(mol) -> None:
    """化学校验 + 立体感知；普通分子等价于 MolFromMolBlock(sanitize=True)。

    只做 SanitizeMol 会漏掉"从二维坐标与键方向读立体"这一步：双键的 E/Z
    会全部退回 STEREONONE，楔键也不会转成手性标签。三步必须一起做。
    已知无机小分子按完整图匹配采用已知价态，其余仍做严格价态校验。
    """
    if not inorganic.sanitize_known(mol):
        Chem.SanitizeMol(mol)
    if mol.GetNumConformers():
        conf = mol.GetConformer()
        Chem.AssignChiralTypesFromBondDirs(mol, conf.GetId(), True)
        Chem.DetectBondStereoChemistry(mol, conf)
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)


def mol_from_section(section) -> Chem.Mol:
    """KET molecule 段 → RDKit Mol（含立体组、显式氢、同位素、自由基）。

    先按 KET 原样构造（芳香键、电荷、implicitHCount），再做完整化学校验；
    已知无机小分子按完整图匹配使用其已知价态。其他校验失败时只有
    "芳香正电碳缺氢"会补 1 个隐含氢重试，其余一律可读报错。
    """
    block = molblock_from_section(section)
    counts = ket_h_counts(section)
    if not counts:
        known = _parse_block(block)
        if inorganic.match(known) is not None:
            _sanitize(known)
            return known
        # 常规分子：保持与旧实现完全一致的解析方式（含立体感知）
        mol = Chem.MolFromMolBlock(block, sanitize=True, removeHs=False, strictParsing=False)
        if mol is not None:
            return mol
    mol = _parse_block(block)
    _apply_ket_h_counts(mol, section, counts)
    try:
        _sanitize(mol)
    except Exception as e:  # noqa: BLE001 显式报错，不当作"没有立体问题"
        return _complete_aromatic_cation(block, counts, e)
    return mol



def mol_from_ket(ket_text: str, key: str) -> Chem.Mol:
    """从完整 KET 文本里取某个 molecule 段并转成 RDKit Mol。"""
    import json
    try:
        doc = json.loads(ket_text)
    except Exception as e:  # noqa: BLE001
        raise StereoError(f"KET 解析失败：{e}") from e
    section = doc.get(key)
    if not isinstance(section, dict) or section.get("type") != "molecule":
        raise StereoError(f"KET 里找不到分子 {key}")
    return mol_from_section(section)


# --------------------------------------------------------------------------
# 立体检查
# --------------------------------------------------------------------------

def _group_kind(label: str) -> str:
    if label == "abs":
        return "abs"
    if label.startswith("&"):
        return "and"
    if label.startswith("or"):
        return "or"
    return "other"


def analyze_mol(mol, section=None) -> dict:
    """按 FindPotentialStereo + 立体组分类统计立体信息。

    返回的每一项都带原因码，供 UI 生成准确文案；失败一律抛 StereoError，
    不会被当作"没有立体问题"。
    """
    try:
        infos = Chem.FindPotentialStereo(mol, cleanIt=True, flagPossible=True)
    except Exception as e:  # noqa: BLE001
        raise StereoError(f"立体检查失败：{e}") from e

    tetra = {"specified": 0, "unspecified": 0, "unknown": 0}
    double = {"specified": 0, "unspecified": 0, "unknown": 0}
    other = {"specified": 0, "unspecified": 0, "unknown": 0}
    details = []

    def bucket(state):
        if state == Chem.StereoSpecified.Specified:
            return "specified"
        if state == Chem.StereoSpecified.Unknown:
            return "unknown"
        return "unspecified"

    for info in infos:
        state = info.specified
        key = bucket(state)
        if info.type == Chem.StereoType.Atom_Tetrahedral:
            tetra[key] += 1
            kind = "tetrahedral"
        elif info.type == Chem.StereoType.Bond_Double:
            double[key] += 1
            kind = "double"
        else:
            other[key] += 1
            kind = "other"
        details.append({
            "kind": kind,
            "state": key,
            "atoms": [info.centeredOn] if kind != "double" else [],
            "centeredOn": info.centeredOn,
            "descriptor": str(info.descriptor),
        })

    # 立体组（AND / OR / ABS）：成员原子自身可能是 Specified，必须单独统计。
    # 画布来源优先用 KET 的 stereoLabel（RDKit 无法把组写回 Mol）。
    groups = {"abs": 0, "and": 0, "or": 0}
    group_atoms = {"abs": [], "and": [], "or": []}
    if section is not None:
        labels = stereo_labels(section)
        for kind, idxs in labels.items():
            if idxs:
                groups[kind] = 1        # KET 里同一标签即同一组
                group_atoms[kind] = list(idxs)
    else:
        for g in mol.GetStereoGroups():
            t = g.GetGroupType()
            if t == Chem.StereoGroupType.STEREO_ABSOLUTE:
                kind = "abs"
            elif t == Chem.StereoGroupType.STEREO_AND:
                kind = "and"
            else:
                kind = "or"
            groups[kind] += 1
            group_atoms[kind].extend(a.GetIdx() for a in g.GetAtoms())

    reasons = []
    if tetra["unspecified"]:
        reasons.append("tetrahedral_unspecified")
    if tetra["unknown"]:
        reasons.append("tetrahedral_unknown")
    if double["unspecified"]:
        reasons.append("double_unspecified")
    if double["unknown"]:
        reasons.append("double_unknown")
    if groups["or"]:
        reasons.append("or_group")
    if groups["and"]:
        reasons.append("and_group")

    needs_choice = bool(reasons)
    return {
        "tetrahedral": tetra,
        "double": double,
        "other": other,
        "groups": groups,
        "groupAtoms": group_atoms,
        "reasons": reasons,
        "needsChoice": needs_choice,
        "details": details,
    }


def analyze_data(data: str) -> dict:
    """从 MOL/SMILES 文本做立体检查（用于非画布来源的调用方）。"""
    mol = parse_any(data)
    return analyze_mol(mol)


def parse_any(data: str) -> Chem.Mol:
    data = data.rstrip()
    if ("M  END" in data) or ("V2000" in data) or ("V3000" in data):
        known = Chem.MolFromMolBlock(data, sanitize=False, removeHs=False)
        if known is not None and inorganic.match(known) is not None:
            _sanitize(known)
            return known
        mol = Chem.MolFromMolBlock(data, sanitize=True, removeHs=False)
        if mol is None:
            raise StereoError("无法解析 molfile")
        return mol
    return parse_smiles(data)


def parse_smiles(data: str, remove_hs: bool = True) -> Chem.Mol:
    """Strict SMILES parsing, with the same bounded complete-graph exceptions as molfile."""
    params = Chem.SmilesParserParams()
    params.removeHs = remove_hs
    params.sanitize = False
    known = Chem.MolFromSmiles(data.strip(), params)
    if known is not None and inorganic.match(known) is not None:
        _sanitize(known)
        return known
    params.sanitize = True
    mol = Chem.MolFromSmiles(data.strip(), params)
    if mol is None:
        raise StereoError("无法解析 SMILES，请检查结构")
    return mol


# --------------------------------------------------------------------------
# 二维整理
# --------------------------------------------------------------------------

def _rotate(points, theta):
    c, s = math.cos(theta), math.sin(theta)
    return [(x * c - y * s, x * s + y * c) for x, y in points]


def _align_to(old_xy, new_xy):
    """把 new_xy 刚性对齐到 old_xy：先按最优旋转，再平移到同一重心。

    只用真旋转（不用镜像）：镜像会改变楔键表达的构型。
    """
    n = len(old_xy)
    if n == 0:
        return new_xy, 0.0
    ocx = sum(p[0] for p in old_xy) / n
    ocy = sum(p[1] for p in old_xy) / n
    ncx = sum(p[0] for p in new_xy) / n
    ncy = sum(p[1] for p in new_xy) / n
    old_c = [(x - ocx, y - ocy) for x, y in old_xy]
    new_c = [(x - ncx, y - ncy) for x, y in new_xy]
    # 求把 new 旋到 old 的角度：最大化 Σ(R(θ)·new)·old
    #   → θ = atan2(Σ(new × old), Σ(new · old))
    # 叉积顺序写反会得到相反方向：那样每次整理都会把分子翻到另一侧，来回摆动
    cross = sum(p[0] * o[1] - p[1] * o[0] for o, p in zip(old_c, new_c))
    dot = sum(o[0] * p[0] + o[1] * p[1] for o, p in zip(old_c, new_c))
    theta = math.atan2(cross, dot) if (abs(cross) > 1e-12 or abs(dot) > 1e-12) else 0.0
    rot = _rotate(new_c, theta)
    return [(x + ocx, y + ocy) for x, y in rot], theta


def _median_bond_length(mol, conf):
    lengths = []
    for b in mol.GetBonds():
        p1 = conf.GetAtomPosition(b.GetBeginAtomIdx())
        p2 = conf.GetAtomPosition(b.GetEndAtomIdx())
        lengths.append(math.hypot(p1.x - p2.x, p1.y - p2.y))
    if not lengths:
        return 0.0
    lengths.sort()
    return lengths[len(lengths) // 2]


def _wedge_from_mol(mol) -> dict:
    """RDKit 键方向 → {(beginIdx, endIdx): (stereo, narrowIdx)}。"""
    out = {}
    for b in mol.GetBonds():
        d = b.GetBondDir()
        i, j = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        if d == Chem.BondDir.BEGINWEDGE:
            out[(i, j)] = (STEREO_UP, i)
        elif d == Chem.BondDir.BEGINDASH:
            out[(i, j)] = (STEREO_DOWN, i)
        elif d == Chem.BondDir.EITHERDOUBLE:
            out[(i, j)] = (STEREO_EITHER, i)
        elif d == Chem.BondDir.UNKNOWN:
            out[(i, j)] = (STEREO_EITHER, i)
    return out


def _check_overlaps(coords, bonds):
    """粗查重叠：非键原子过近会画出难以辨认的结构。"""
    n = len(coords)
    bonded = set()
    for i, j in bonds:
        bonded.add((min(i, j), max(i, j)))
    worst = None
    for i in range(n):
        xi, yi = coords[i]
        for j in range(i + 1, n):
            if (i, j) in bonded:
                continue
            d = math.hypot(xi - coords[j][0], yi - coords[j][1])
            if worst is None or d < worst[0]:
                worst = (d, i, j)
    return worst


def _center_bonds(section, center):
    """与 center 相连的单键 → [(bond, 另一端索引)]。"""
    out = []
    for b in section.get("bonds") or []:
        if int(b.get("type") or 1) != 1:
            continue
        i, j = int(b["atoms"][0]), int(b["atoms"][1])
        if i == center:
            out.append((b, j))
        elif j == center:
            out.append((b, i))
    return out


def _needs_two_wedge(section, mol, center) -> bool:
    """是否属于"简单非环、四条单键都显式画出、原本一实一虚"的已指定中心。

    只对这类中心保留"一实一虚"画法：环、隐含氢、非单键、未指定中心都不套用。
    """
    if center < 0 or center >= mol.GetNumAtoms():
        return False
    a = mol.GetAtomWithIdx(center)
    if a.GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED:
        return False
    if a.GetDegree() != 4 or a.GetTotalNumHs() != 0:
        return False
    bonds = list(a.GetBonds())
    if any(b.IsInRing() for b in bonds):
        return False
    if any(b.GetBondType() != Chem.BondType.SINGLE for b in bonds):
        return False
    # 已作为邻居画出的 H 也是四条显式键之一；这里只排除隐含氢，
    # 不能因取代基是 H 而丢掉用户原有的一实一虚表达。
    ups = downs = 0
    for b, _other in _center_bonds(section, center):
        st = int(b.get("stereo") or 0)
        if st == STEREO_UP:
            ups += 1
        elif st == STEREO_DOWN:
            downs += 1
    return ups >= 1 and downs >= 1


def _apply_two_wedge(new_section, center, coords, ref_cip):
    """把该中心改成"一条实心 + 一条虚线"，且不改变任何已指定构型。

    枚举 C(4,2)×2 种写法，用真实解析结果验证（不是靠角度推断），
    在通过的方案里挑两条立体键夹角最小的（最接近常规四面体画法）。
    返回改好的 section；没有可行方案返回 None。
    """
    bonds = _center_bonds(new_section, center)
    if len(bonds) < 4:
        return None
    best = None
    best_score = None
    for ai in range(len(bonds)):
        for bi in range(len(bonds)):
            if ai == bi:
                continue
            for up_first in (True, False):
                cand = copy.deepcopy(new_section)
                cbonds = _center_bonds(cand, center)
                for k, (b, other) in enumerate(cbonds):
                    if k == ai:
                        b["atoms"] = [center, other]
                        b["stereo"] = STEREO_UP if up_first else STEREO_DOWN
                    elif k == bi:
                        b["atoms"] = [center, other]
                        b["stereo"] = STEREO_DOWN if up_first else STEREO_UP
                    else:
                        b.pop("stereo", None)
                try:
                    probe = mol_from_section(cand)
                except StereoError:
                    continue
                got = dict(Chem.FindMolChiralCenters(probe, includeUnassigned=True,
                                                     useLegacyImplementation=False))
                if got != ref_cip:
                    continue
                # 评分：两条立体键夹角越小越像常规画法
                (x0, y0) = coords[center]
                (x1, y1) = coords[_bond_other(cbonds, ai)]
                (x2, y2) = coords[_bond_other(cbonds, bi)]
                a1 = math.atan2(y1 - y0, x1 - x0)
                a2 = math.atan2(y2 - y0, x2 - x0)
                gap = abs(math.degrees(a1 - a2)) % 360
                gap = min(gap, 360 - gap)
                score = gap
                if best_score is None or score < best_score:
                    best_score = score
                    best = cand
    return best


def _bond_other(cbonds, k):
    return cbonds[k][1]


def layout_section(section, align=True) -> dict:
    """整理单个 KET molecule 段，返回新坐标与楔键。

    返回 {"atoms": [[x, y], ...], "bonds": [{"i","j","stereo"}...],
          "report": {...}}；坐标是 KET 坐标系（y 向上）。
    校验不通过抛 StereoError（调用方保留原图，不得写入半成品）。
    """
    mol = mol_from_section(section)
    if mol.GetNumConformers() == 0:
        raise StereoError("分子缺少坐标")
    old_conf = mol.GetConformer()
    old_xy = [(old_conf.GetAtomPosition(i).x, old_conf.GetAtomPosition(i).y)
              for i in range(mol.GetNumAtoms())]

    work = Chem.Mol(mol)
    rdDepictor.SetPreferCoordGen(True)
    try:
        rdDepictor.Compute2DCoords(work, canonOrient=False)
    except Exception as e:  # noqa: BLE001
        raise StereoError(f"二维坐标计算失败：{e}") from e
    conf = work.GetConformer()

    # 键长归一到画布标准（Ketcher 画布键长为 1.0）
    med = _median_bond_length(work, conf)
    scale = 1.0 / med if med > 1e-6 else 1.0

    new_xy = [(conf.GetAtomPosition(i).x * scale, conf.GetAtomPosition(i).y * scale)
              for i in range(work.GetNumAtoms())]

    # 楔键：先让 RDKit 按新画法重排
    Chem.WedgeMolBonds(work, conf)
    new_wedges = _wedge_from_mol(work)

    # 保留用户显式表达：非手性中心上的楔键、以及显式"未知"（波浪键）
    chiral_atoms = {a.GetIdx() for a in work.GetAtoms()
                    if a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED}
    preserved = []
    for b in section.get("bonds") or []:
        st = int(b.get("stereo") or 0)
        if st not in (STEREO_UP, STEREO_DOWN, STEREO_EITHER):
            continue
        i, j = int(b["atoms"][0]), int(b["atoms"][1])
        if st == STEREO_EITHER:
            # 用户显式波浪键：含义是"未知"，整理不得把它变成确定构型
            new_wedges.pop((i, j), None)
            new_wedges.pop((j, i), None)
            new_wedges[(i, j)] = (STEREO_EITHER, i)
            preserved.append((i, j, st))
        elif i not in chiral_atoms and j not in chiral_atoms:
            # 四根相同取代基上人为画的楔键：属于用户的透视表达，保留
            new_wedges.pop((i, j), None)
            new_wedges.pop((j, i), None)
            new_wedges[(i, j)] = (st, i)
            preserved.append((i, j, st))

    if align:
        new_xy, theta = _align_to(old_xy, new_xy)
    else:
        theta = 0.0

    bonds_out = []
    for b in section.get("bonds") or []:
        i, j = int(b["atoms"][0]), int(b["atoms"][1])
        wedge = new_wedges.get((i, j)) or new_wedges.get((j, i))
        if wedge is None:
            stereo = STEREO_NONE
        else:
            stereo, narrow = wedge
            if narrow == j:
                i, j = j, i     # KET 约定：atoms[0] 是楔键窄端
        btype = int(b.get("type") or 1)
        if btype != 1:
            # 双键的"顺反未定"属于用户表达，整理不得把它变成确定构型
            stereo = STEREO_CIS_TRANS if (btype == 2 and
                                          int(b.get("stereo") or 0) == STEREO_CIS_TRANS) else STEREO_NONE
        bonds_out.append({"i": i, "j": j, "stereo": stereo,
                          "order": [int(b["atoms"][0]), int(b["atoms"][1])]})

    # ---- 校验：连接、键级、电荷、同位素、自由基、构型必须与整理前一致 ----
    new_section = {
        "type": "molecule",
        "atoms": [],
        "bonds": [],
    }
    for i, a in enumerate(section.get("atoms") or []):
        na = dict(a)
        na["location"] = [round(new_xy[i][0], 4), round(new_xy[i][1], 4), 0.0]
        new_section["atoms"].append(na)
    for b, bo in zip(section.get("bonds") or [], bonds_out):
        nb = dict(b)
        nb["atoms"] = [bo["i"], bo["j"]]
        if bo["stereo"]:
            nb["stereo"] = bo["stereo"]
        else:
            nb.pop("stereo", None)
        new_section["bonds"].append(nb)

    # U01：用户原本"一实一虚"的中心，整理后保留这种表达类型
    ref_cip = dict(Chem.FindMolChiralCenters(mol, includeUnassigned=True,
                                             useLegacyImplementation=False))
    two_wedge = []
    for center in range(mol.GetNumAtoms()):
        if not _needs_two_wedge(section, mol, center):
            continue
        cand = _apply_two_wedge(new_section, center, new_xy, ref_cip)
        if cand is None:
            raise StereoError(
                f"原子 {center + 1} 的一实一虚画法无法在不改变构型的前提下保留，已取消整理")
        new_section = cand
        two_wedge.append(center)
    if two_wedge:
        # 回填 bonds_out：前端按它写回编辑器
        rebuilt = []
        for b, nb in zip(section.get("bonds") or [], new_section["bonds"]):
            rebuilt.append({"i": int(nb["atoms"][0]), "j": int(nb["atoms"][1]),
                            "stereo": int(nb.get("stereo") or 0),
                            "order": [int(b["atoms"][0]), int(b["atoms"][1])]})
        bonds_out = rebuilt

    ref_smiles = Chem.MolToSmiles(mol)
    try:
        check_mol = mol_from_section(new_section)
    except StereoError as e:
        raise StereoError(f"整理结果无法解析：{e}") from e
    new_smiles = Chem.MolToSmiles(check_mol)
    if ref_smiles != new_smiles:
        raise StereoError("整理会改变立体构型，已取消（原图未修改）")

    ref_cip = dict(Chem.FindMolChiralCenters(mol, includeUnassigned=True,
                                             useLegacyImplementation=False))
    new_cip = dict(Chem.FindMolChiralCenters(check_mol, includeUnassigned=True,
                                             useLegacyImplementation=False))
    if ref_cip != new_cip:
        raise StereoError("整理前后手性中心不一致，已取消（原图未修改）")

    worst = _check_overlaps(new_xy, [(b["i"], b["j"]) for b in bonds_out])
    if worst is not None and worst[0] < 0.35:
        raise StereoError("整理后原子重叠（间距 %.2f），已取消（原图未修改）" % worst[0])

    # 外观指标：四连接非环中心的相邻键角
    gaps = center_gaps(new_xy, [(b["i"], b["j"]) for b in bonds_out])
    crosses = [g for g in gaps if all(80 <= a <= 100 for a in g["gaps"])]

    return {
        "atoms": [[round(x, 4), round(y, 4)] for x, y in new_xy],
        "bonds": bonds_out,
        "report": {
            "atoms": len(new_xy),
            "rotation": round(math.degrees(theta), 2),
            "preservedWedges": preserved,
            "twoWedgeCenters": two_wedge,
            "centers": gaps,
            "crossCenters": len(crosses),
            "minNonBonded": None if worst is None else round(worst[0], 3),
            "smiles": ref_smiles,
        },
    }


def center_gaps(coords, bonds) -> list:
    """四连接非环中心的相邻键角（验收指标：四项都在 80–100 度即机械十字）。"""
    adj = {}
    for i, j in bonds:
        adj.setdefault(i, []).append(j)
        adj.setdefault(j, []).append(i)
    out = []
    for idx, nbrs in adj.items():
        if len(nbrs) != 4:
            continue
        cx, cy = coords[idx]
        angs = sorted(math.degrees(math.atan2(coords[n][1] - cy, coords[n][0] - cx)) % 360
                      for n in nbrs)
        gaps = [round((angs[(k + 1) % 4] - angs[k]) % 360, 1) for k in range(4)]
        out.append({"atom": idx, "gaps": gaps})
    return out


def layout_ket(ket_text: str, targets=None, points=None, align=True, compact=False) -> dict:
    """整理整份 KET 中指定的分子，返回每个目标分子的新坐标与楔键。

    targets: 目标 molecule 键名列表；None 时按 points 判定，points 也为空则全部。
    points:  选区原子坐标（KET 坐标系）；用于确定"选区触及的完整分子"。
    compact: 全画布按反应箭头分段排布，或在原宽度内沿 x 紧凑排布。
    """
    import json
    try:
        doc = json.loads(ket_text)
    except Exception as e:  # noqa: BLE001
        raise StereoError(f"KET 解析失败：{e}") from e
    keys = molecule_keys(doc)

    if targets is None:
        if points:
            targets = _targets_by_points(doc, keys, points)
        else:
            targets = list(keys)
    targets = [t for t in targets if t in keys]
    if not targets:
        raise StereoError("没有可整理的分子")

    results = []
    skipped = []
    for key in targets:
        section = doc[key]
        try:
            res = layout_section(section, align=align)
        except StereoError as e:
            skipped.append({"key": key, "error": str(e)})
            continue
        res["key"] = key
        results.append(res)
    if not results:
        raise StereoError(f"{skipped[0]['key']}: {skipped[0]['error']}")
    nodes = (doc.get("root") or {}).get("nodes") or []
    arrows = [node for node in nodes if isinstance(node, dict) and node.get("type") == "arrow"]
    if not skipped and compact and len(results) > 1 and not points and set(targets) == set(keys):
        if arrows:
            _compact_reaction_stages(doc, results, nodes, arrows)
        else:
            compact_row(results)
    out = {"ok": True, "molecules": results,
           "targets": targets, "allKeys": keys}
    if skipped:
        out["skipped"] = skipped
    return out


_STAGE_ARROW_MODES = {"open-angle", "filled-triangle", "filled-bow", "dashed-open-angle"}
_STAGE_MOLECULE_GAP = 1.10  # atom bounds, including space for labels
_STAGE_ARROW_CLEARANCE = 0.75
_MIN_STAGE_ARROW_CLEARANCE = 0.65
_STAGE_ROW_TOLERANCE = 1.0


def _compact_reaction_stages(doc, results, nodes, arrows):
    """Pack one unambiguous reaction lane around fixed native arrow endpoints."""
    # Plus signs and drawn shapes may associate nearby molecules by position.
    # Keep those layouts until the corresponding decorations can travel with them.
    if any(isinstance(node, dict) and node.get("type") in ("plus", "simpleObject")
           for node in nodes):
        return

    segments = []
    for arrow in arrows:
        data = arrow.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("mode"), str) or data["mode"] not in _STAGE_ARROW_MODES:
            return
        points = data.get("pos")
        if not isinstance(points, list) or len(points) != 2:
            return
        if not all(isinstance(p, dict) and all(isinstance(p.get(axis), (int, float))
                   and math.isfinite(p[axis]) for axis in ("x", "y")) for p in points):
            return
        segments.append(tuple((p["x"], p["y"]) for p in points))

    # Compare along the dominant canvas axis so modestly slanted connectors
    # still separate stages without moving structures onto a common baseline.
    start, end = segments[0]
    axis = int(abs(end[1] - start[1]) > abs(end[0] - start[0]))
    direction = 1 if end[axis] > start[axis] else -1

    def project(point):
        return point[axis] * direction, point[1 - axis]

    segments = sorted((project(start), project(end)) for start, end in segments)
    for start, end in segments:
        span = end[0] - start[0]
        if span < 0.4 or abs(end[1] - start[1]) > span:
            return  # mixed directions or axes
    for (_, head), (tail, _) in zip(segments, segments[1:]):
        if head[0] >= tail[0] or abs(head[1] - tail[1]) > 2 * _STAGE_ROW_TOLERANCE:
            return  # ambiguous branch, overlap, or separate rows

    cuts = [(start[0] + end[0]) / 2 for start, end in segments]
    stage_rows = [[segments[0][0][1]],
                  *[[head[1], tail[1]] for (_, head), (tail, _) in zip(segments, segments[1:])],
                  [segments[-1][1][1]]]
    stages = [[] for _ in stage_rows]
    stationary = []

    def bounds(points):
        us, vs = zip(*(project(p) for p in points))
        return min(us), max(us), min(vs), max(vs)

    for res in results:
        old = [tuple(map(float, atom["location"][:2])) for atom in doc[res["key"]]["atoms"] if atom.get("location")]
        if len(old) != len(res["atoms"]):
            return
        u1, u2, v1, v2 = bounds(old)
        stage_index = bisect_right(cuts, (u1 + u2) / 2)
        row = stage_rows[stage_index]
        box = bounds(res["atoms"])
        if v2 < min(row) - _STAGE_ROW_TOLERANCE or v1 > max(row) + _STAGE_ROW_TOLERANCE:
            stationary.append(box)
        else:
            stages[stage_index].append(((u1 + u2) / 2, res, box))
    if not all(stages):
        return

    for node in nodes:
        if isinstance(node, dict) and node.get("type") == "text":
            box = node.get("boundingBox") or {}
            if isinstance(box, dict) and all(isinstance(box.get(key), (int, float)) and math.isfinite(box[key])
                   for key in ("x", "y", "width", "height")):
                x, y = box["x"], box["y"]
                stationary.append(bounds([(x, y), (x + box["width"], y - box["height"])]))

    placements = []
    for i, stage in enumerate(stages):
        stage.sort(key=lambda entry: (entry[0], entry[1]["key"]))
        width = sum(box[1] - box[0] for _, _, box in stage) + _STAGE_MOLECULE_GAP * (len(stage) - 1)
        lo = segments[i - 1][1][0] if i else None
        hi = segments[i][0][0] if i < len(segments) else None
        if lo is not None and hi is not None:
            if hi - lo < width + 2 * _MIN_STAGE_ARROW_CLEARANCE - 1e-6:
                return  # the intermediate stage does not fit without moving arrows
            cursor = (lo + hi - width) / 2
        else:
            cursor = lo + _STAGE_ARROW_CLEARANCE if hi is None else hi - width - _STAGE_ARROW_CLEARANCE
        for _, res, (u1, u2, v1, v2) in stage:
            right = cursor + u2 - u1
            if any(cursor < sx2 + 0.7 and right > sx1 - 0.7 and v1 < sy2 + 0.7 and v2 > sy1 - 0.7
                   for sx1, sx2, sy1, sy2 in stationary):
                return
            placements.append((res["atoms"], (cursor - u1) * direction))
            cursor = right + _STAGE_MOLECULE_GAP

    # Apply only after checking every stage, leaving ambiguous lanes in place.
    for atoms, delta in placements:
        for atom in atoms:
            atom[axis] = round(atom[axis] + delta, 6)


def compact_row(results, gap=1.5, min_gap=1.1, max_gap=2.6):
    """在原包围盒内紧凑排布。单行会加宽时保留原来的多行分布。"""
    gap = max(min_gap, min(max_gap, float(gap)))
    entries = []
    for res in results:
        atoms = res.get("atoms") or []
        if not atoms:
            continue
        xs = [float(a[0]) for a in atoms]
        ys = [float(a[1]) for a in atoms]
        entries.append({
            "key": res["key"], "atoms": atoms,
            "x1": min(xs), "x2": max(xs), "cx": (min(xs) + max(xs)) / 2.0,
            "y1": min(ys), "y2": max(ys), "cy": (min(ys) + max(ys)) / 2.0,
        })
    if len(entries) < 2:
        return []
    if max(entry["y1"] for entry in entries) - min(entry["y2"] for entry in entries) > 1.5:
        return []  # a wide multi-row layout is still multi-row
    entries.sort(key=lambda e: (round(e["cx"], 4), round(e["cy"], 4), e["key"]))
    left = min(entry["x1"] for entry in entries)
    right = max(entry["x2"] for entry in entries)
    row_width = sum(entry["x2"] - entry["x1"] for entry in entries) + gap * (len(entries) - 1)
    if row_width > right - left:
        return []
    cursor = (left + right - row_width) / 2.0
    baseline = (min(entry["y1"] for entry in entries) + max(entry["y2"] for entry in entries)) / 2.0
    moved = []
    for entry in entries:
        dx = cursor - entry["x1"]
        dy = baseline - entry["cy"]
        for atom in entry["atoms"]:
            atom[0] = round(float(atom[0]) + dx, 6)
            atom[1] = round(float(atom[1]) + dy, 6)
        cursor = entry["x2"] + dx + gap
        moved.append(entry["key"])
    return moved


def _targets_by_points(doc, keys, points, tol=1e-3) -> list:
    """选区坐标 → 触及的完整分子（同一原子只归属一个分子）。"""
    hit = []
    for key in keys:
        section = doc[key]
        for a in section.get("atoms") or []:
            loc = a.get("location") or [0, 0, 0]
            for p in points:
                if abs(float(loc[0]) - float(p[0])) <= tol and abs(float(loc[1]) - float(p[1])) <= tol:
                    hit.append(key)
                    break
            else:
                continue
            break
    if not hit:
        raise StereoError("选区没有命中任何分子")
    return hit


# --------------------------------------------------------------------------
# 3D 生成后的构型复核
# --------------------------------------------------------------------------

def stereo_from_3d(block: str):
    """从生成的三维 molblock 重新感知立体（独立副本，避免原标签遮蔽真实结果）。"""
    mol = Chem.MolFromMolBlock(block, sanitize=False, removeHs=False)
    if mol is None:
        raise StereoError("生成的三维结构无法解析")
    _sanitize(mol)
    # 清掉复制过来的手性标签与方向标记，只让坐标说话
    for a in mol.GetAtoms():
        a.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    for b in mol.GetBonds():
        b.SetBondDir(Chem.BondDir.NONE)
        b.SetStereo(Chem.BondStereo.STEREONONE)
    Chem.AssignStereochemistryFrom3D(mol)
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def specified_double_bonds(mol) -> dict:
    """已指定的双键构型 → {键索引: "Bond_Cis"/"Bond_Trans"}。

    只收 Specified：未指定/未知的部分正是用户选择示例的对象，不参与比对。
    """
    out = {}
    try:
        infos = Chem.FindPotentialStereo(mol, flagPossible=True)
    except Exception as e:  # noqa: BLE001
        raise StereoError(f"双键构型识别失败：{e}") from e
    for info in infos:
        if info.type != Chem.StereoType.Bond_Double:
            continue
        if info.specified != Chem.StereoSpecified.Specified:
            continue
        out[info.centeredOn] = str(info.descriptor)
    return out


def compare_specified(ref_mol, got_mol) -> dict:
    """比较输入已指定的立体单元与三维结果重新感知的结果。

    覆盖四面体中心与双键构型（两者都必须比：纯烯烃只有双键，漏掉就等于没验）。
    返回 {"checked": n, "mismatches": [...], "ok": bool}；只比较输入里已指定的
    部分（未指定部分由用户选择示例，不参与比较）。
    """
    ref_cip = dict(Chem.FindMolChiralCenters(ref_mol, includeUnassigned=True,
                                             useLegacyImplementation=False))
    got_cip = dict(Chem.FindMolChiralCenters(got_mol, includeUnassigned=True,
                                             useLegacyImplementation=False))
    mismatches = []
    checked = 0
    for idx, label in ref_cip.items():
        if label == "?":
            continue
        checked += 1
        if got_cip.get(idx) != label:
            mismatches.append({"atom": idx, "expected": label,
                               "actual": got_cip.get(idx)})
    ref_db = specified_double_bonds(ref_mol)
    got_db = specified_double_bonds(got_mol)
    for idx, desc in ref_db.items():
        checked += 1
        if got_db.get(idx) != desc:
            mismatches.append({"bond": idx, "expected": desc,
                               "actual": got_db.get(idx)})
    return {"checked": checked, "mismatches": mismatches,
            "ok": not mismatches}
