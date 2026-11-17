#!/usr/bin/env python3
"""立体化学整理 / 立体检查的后端回归（不依赖 pytest）。

用法：
    .venv-rdkit/bin/python fusion/tests/test_stereo.py [-v]

夹具来自真实 Ketcher 画布导出（tests/gen_fixtures.js），不是手工拼的 MOL。
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FUSION = os.path.dirname(HERE)
sys.path.insert(0, FUSION)

from rdkit import Chem  # noqa: E402

import stereo  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
VERBOSE = "-v" in sys.argv

PASS = 0
FAIL = 0
FAILED = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        if VERBOSE:
            print(f"  PASS {name}")
    else:
        FAIL += 1
        FAILED.append(name + ("  " + detail if detail else ""))
        print(f"  FAIL {name}  {detail}")


def load(fid):
    with open(os.path.join(FIX, fid + ".ket"), encoding="utf-8") as f:
        return f.read()


def section_of(ket_text):
    doc = json.loads(ket_text)
    keys = stereo.molecule_keys(doc)
    return keys, doc


def smiles_of(section):
    return Chem.MolToSmiles(stereo.mol_from_section(section))


# ---------------------------------------------------------------- 夹具解析
def test_parse():
    print("[1] 夹具解析")
    cases = {
        "M01": "CC(C)(C)C", "M02": "FC(Cl)(Br)I", "M05": "CC[C@H](C)O",
        "M07": "C/C=C/C", "M08": "C/C=C\\C", "M09": "C/C=C/C",
        "M10": "[2H][C@](F)(Cl)Br", "R01": "C[C@H]1CC[C@@H](C)CC1",
    }
    for fid, expect in cases.items():
        doc = json.loads(load(fid))
        keys = stereo.molecule_keys(doc)
        check(f"{fid} 有一个分子段", len(keys) == 1, str(keys))
        smi = smiles_of(doc[keys[0]])
        check(f"{fid} 解析 SMILES 正确", smi == expect, f"得到 {smi} 期望 {expect}")


def test_isomer_roundtrip():
    print("[2] 同位素 / 电荷 / 自由基")
    doc = json.loads(load("M10"))
    sec = doc[stereo.molecule_keys(doc)[0]]
    mol = stereo.mol_from_section(sec)
    iso = [a.GetIsotope() for a in mol.GetAtoms()]
    check("M10 保留氘同位素", 2 in iso, str(iso))
    check("M10 立体中心已指定",
          any(a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED for a in mol.GetAtoms()))


def test_stereo_labels():
    print("[3] AND / OR 立体组")
    for fid, kind in (("M11", "or"), ("M12", "and")):
        doc = json.loads(load(fid))
        sec = doc[stereo.molecule_keys(doc)[0]]
        labels = stereo.stereo_labels(sec)
        check(f"{fid} 组类型为 {kind}", len(labels[kind]) == 2, str(labels))
        mol = stereo.mol_from_section(sec)
        check(f"{fid} 成员都是已指定中心",
              all(mol.GetAtomWithIdx(i).GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED
                  for i in labels[kind]))


# ---------------------------------------------------------------- 立体检查
def test_analyze():
    print("[4] 立体检查分类")
    def analyze(fid):
        doc = json.loads(load(fid))
        sec = doc[stereo.molecule_keys(doc)[0]]
        return stereo.analyze_mol(stereo.mol_from_section(sec), sec)

    a = analyze("M01")
    check("M01 新戊烷无立体问题", a["needsChoice"] is False, str(a["reasons"]))
    a = analyze("M02")
    check("M02 检出未指定四面体", a["tetrahedral"]["unspecified"] == 1, str(a["tetrahedral"]))
    check("M02 需要选择", a["needsChoice"] is True)
    a = analyze("M03")
    check("M03 已指定不提示", a["needsChoice"] is False, str(a["reasons"]))
    check("M03 四面体已指定 1 个", a["tetrahedral"]["specified"] == 1, str(a["tetrahedral"]))
    a = analyze("M07")
    check("M07 E 双键不提示", a["needsChoice"] is False, str(a["reasons"]))
    # 画布上双键的 E/Z 由几何决定：M09（CC=CC）被 Ketcher 排成反式，Ketcher 自己
    # 导出 SMILES 也是 C/C=C/C，因此这里必须判为已指定——否则会把 M07 也误报。
    a = analyze("M09")
    check("M09 画成反式 → 判为已指定 E", a["double"]["specified"] == 1, str(a["double"]))
    a = analyze("W03")
    check("W03 共线双键 → 构型未确定",
          a["double"]["unknown"] + a["double"]["unspecified"] == 1, str(a["double"]))
    check("W03 原因含 double_unknown", "double_unknown" in a["reasons"], str(a["reasons"]))
    a = analyze("M11")
    check("M11 检出 OR 组", a["groups"]["or"] == 1, str(a["groups"]))
    check("M11 因组语义需要选择", "or_group" in a["reasons"], str(a["reasons"]))
    a = analyze("M12")
    check("M12 检出 AND 组", a["groups"]["and"] == 1, str(a["groups"]))
    a = analyze("W01")
    check("W01 检出显式未知", a["tetrahedral"]["unknown"] == 1, str(a["tetrahedral"]))
    a = analyze("D11")
    check("D11 同时有已指定和未指定",
          a["tetrahedral"]["specified"] >= 1 and a["tetrahedral"]["unspecified"] >= 1,
          str(a["tetrahedral"]))


def test_analyze_unknown_vs_unspecified():
    print("[5] 显式未知 vs 缺省未指定")
    for fid in ("M02", "W01"):
        doc = json.loads(load(fid))
        sec = doc[stereo.molecule_keys(doc)[0]]
        a = stereo.analyze_mol(stereo.mol_from_section(sec), sec)
        want = "tetrahedral_unknown" if fid == "W01" else "tetrahedral_unspecified"
        check(f"{fid} 原因码 {want}", want in a["reasons"], str(a["reasons"]))


# ---------------------------------------------------------------- 整理
def layout(fid):
    doc = json.loads(load(fid))
    keys = stereo.molecule_keys(doc)
    res = stereo.layout_section(doc[keys[0]])
    return doc, keys[0], res


def test_layout_preserves_chemistry():
    print("[6] 整理保留化学与构型")
    for fid in ("M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09",
                "M10", "M11", "M12", "R01", "R02", "W01", "W02", "D11", "C01", "C02"):
        doc = json.loads(load(fid))
        for key in stereo.molecule_keys(doc):
            sec = doc[key]
            before = stereo.mol_from_section(sec)
            try:
                res = stereo.layout_section(sec)
            except stereo.StereoError as e:
                check(f"{fid}/{key} 整理成功", False, str(e))
                continue
            check(f"{fid}/{key} 整理成功", True)
            new_sec = dict(sec)
            new_sec["atoms"] = []
            for i, a in enumerate(sec["atoms"]):
                na = dict(a)
                na["location"] = [res["atoms"][i][0], res["atoms"][i][1], 0.0]
                new_sec["atoms"].append(na)
            new_sec["bonds"] = []
            for b, bo in zip(sec["bonds"], res["bonds"]):
                nb = dict(b)
                nb["atoms"] = [bo["i"], bo["j"]]
                if bo["stereo"]:
                    nb["stereo"] = bo["stereo"]
                else:
                    nb.pop("stereo", None)
                new_sec["bonds"].append(nb)
            after = stereo.mol_from_section(new_sec)
            check(f"{fid}/{key} 构型不变",
                  Chem.MolToSmiles(before) == Chem.MolToSmiles(after),
                  f"{Chem.MolToSmiles(before)} -> {Chem.MolToSmiles(after)}")
            check(f"{fid}/{key} 原子数不变",
                  before.GetNumAtoms() == after.GetNumAtoms())


def test_layout_appearance():
    print("[7] 外观：简单非环四连接中心不再机械十字")
    for fid in ("M02", "M03", "M04", "M01"):
        doc, key, res = layout(fid)
        centers = [c for c in res["report"]["centers"] if len(c["gaps"]) == 4]
        check(f"{fid} 有可测四连接中心", len(centers) >= 1, str(res["report"]["centers"]))
        for c in centers:
            cross = all(80 <= g <= 100 for g in c["gaps"])
            check(f"{fid} 中心 {c['atom']} 不是十字", not cross, str(c["gaps"]))
    doc, key, res = layout("M03")
    gaps = res["report"]["centers"][0]["gaps"]
    check("M03 角度接近 60/90/120/90",
          sorted(gaps) == sorted([60.0, 90.0, 120.0, 90.0]) or
          (min(gaps) > 50 and max(gaps) < 130), str(gaps))


def test_layout_preserves_user_drawing():
    print("[8] 用户绘图与显式未知")
    doc, key, res = layout("W01")
    wavy = [b for b in res["bonds"] if b["stereo"] == 4]
    check("W01 波浪键保留为显式未知", len(wavy) == 1, str(res["bonds"]))
    doc, key, res = layout("W02")
    wedged = [b for b in res["bonds"] if b["stereo"] in (1, 6)]
    check("W02 人为楔键保留", len(wedged) >= 1, str(res["bonds"]))
    sec = doc[key]
    mol = stereo.mol_from_section(sec)
    defined = [c for c in Chem.FindMolChiralCenters(mol, includeUnassigned=True,
                                                    useLegacyImplementation=False)
               if c[1] != "?"]
    check("W02 不因楔键产生 R/S", not defined, str(defined))


def test_layout_bond_lengths():
    print("[9] 整理后键长与重叠")
    for fid in ("M03", "M06", "R01", "R02"):
        doc, key, res = layout(fid)
        bonds = [(b["i"], b["j"]) for b in res["bonds"]]
        lens = []
        for i, j in bonds:
            (x1, y1), (x2, y2) = res["atoms"][i], res["atoms"][j]
            lens.append(((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5)
        if lens:
            check(f"{fid} 键长接近 1.0",
                  all(0.9 <= L <= 1.1 for L in lens),
                  f"{min(lens):.3f}–{max(lens):.3f}")
        check(f"{fid} 无严重重叠", (res["report"]["minNonBonded"] or 9) > 0.35,
              str(res["report"]["minNonBonded"]))


def test_layout_keeps_position():
    print("[10] 整理保留画布位置")
    doc, key, res = layout("M03")
    old = doc[key]["atoms"]
    ox = sum(a["location"][0] for a in old) / len(old)
    oy = sum(a["location"][1] for a in old) / len(old)
    nx = sum(p[0] for p in res["atoms"]) / len(res["atoms"])
    ny = sum(p[1] for p in res["atoms"]) / len(res["atoms"])
    check("重心基本不变", abs(ox - nx) < 0.01 and abs(oy - ny) < 0.01,
          f"({ox:.2f},{oy:.2f}) -> ({nx:.2f},{ny:.2f})")


def test_layout_ket_targets():
    print("[11] 目标范围：选区 / 全部分子")
    ket = load("C02")
    doc = json.loads(ket)
    keys = stereo.molecule_keys(doc)
    check("C02 有 3 个分子段", len(keys) == 3, str(keys))
    # 只选第一个分子的一个原子
    p = doc[keys[0]]["atoms"][0]["location"][:2]
    res = stereo.layout_ket(ket, points=[p])
    check("按选区只整理 1 个分子", len(res["molecules"]) == 1, str(res["targets"]))
    check("命中的是选区所在分子", res["molecules"][0]["key"] == keys[0])
    res = stereo.layout_ket(ket)
    check("无选区整理全部分子", len(res["molecules"]) == 3, str(res["targets"]))
    try:
        stereo.layout_ket(ket, points=[[999.0, 999.0]])
        check("选区未命中时报错", False)
    except stereo.StereoError as e:
        check("选区未命中时报错", "命中" in str(e), str(e))


def test_layout_non_target_untouched():
    print("[12] 非目标分子与画布对象不变")
    ket = load("C01")
    doc = json.loads(ket)
    keys = stereo.molecule_keys(doc)
    check("C01 有 2 个分子段", len(keys) == 2, str(keys))
    p = doc[keys[1]]["atoms"][0]["location"][:2]
    res = stereo.layout_ket(ket, points=[p])
    check("只整理第二个分子", [m["key"] for m in res["molecules"]] == [keys[1]],
          str(res["targets"]))
    # 非目标分子坐标不变：layout_ket 只返回目标，其余由前端原样保留
    types = [n.get("type") for n in doc["root"]["nodes"] if isinstance(n, dict)]
    check("C01 保留文字/箭头/图形节点",
          "text" in types and "arrow" in types and "simpleObject" in types, str(types))


def test_layout_compacts_native_reaction_stages():
    print("[12b] 原生直箭头划分的多步反应")
    doc = {"root": {"nodes": []}}
    points = [(-8, 0), (-3, -0.2), (4, -0.6), (7, -0.7), (14, -2), (20, -2.2), (13, 5)]
    for i, (x, y) in enumerate(points):
        key = f"mol{i}"
        doc[key] = {"type": "molecule", "atoms": [{"label": "O", "location": [x, y, 0]}]}
        doc["root"]["nodes"].append({"$ref": key})
    for start, end in [((0, 0), (2, -0.25)), ((9, -1), (11, -2))]:
        doc["root"]["nodes"].append({"type": "arrow", "data": {
            "mode": "open-angle", "pos": [{"x": x, "y": y} for x, y in (start, end)],
        }})

    def coords(res):
        return [mol["atoms"][0] for mol in res["molecules"]]

    result = coords(stereo.layout_ket(json.dumps(doc), compact=True))
    xs, ys = zip(*result)
    check("同阶段的分子紧凑，保留各自基线", all(abs(xs[i + 1] - xs[i] - 1.10) < 1e-6
          for i in [0, 2, 4]) and list(ys) == [y for _, y in points], str(result))
    check("每支斜向直箭头两端都有反应空间",
          xs[1] <= -0.75 and xs[2] >= 2.75 and xs[3] <= 8.25 and xs[4] >= 11.75)
    check("同页的另一行保持位置", result[-1] == [13, 5])
    selected = stereo.layout_ket(json.dumps(doc), points=[[-8, 0]], compact=True)
    check("选区只整理分子本身", selected["targets"] == ["mol0"] and coords(selected) == [[-8, 0]])

    doc["root"]["nodes"].append(doc["root"]["nodes"][-1])
    check("重叠直箭头使分段不明确时保留原排布",
          coords(stereo.layout_ket(json.dumps(doc), compact=True)) == [list(p) for p in points])
    doc["root"]["nodes"] = doc["root"]["nodes"][:-3]
    check("没有直箭头时也保留明显分开的多行",
          coords(stereo.layout_ket(json.dumps(doc), compact=True)) == [list(p) for p in points])


def test_stereo_from_3d():
    print("[13] 三维坐标重新感知立体")
    doc = json.loads(load("M03"))
    mol = stereo.mol_from_section(doc[stereo.molecule_keys(doc)[0]])
    block = _embed(mol)
    got = stereo.stereo_from_3d(block)
    cmp = stereo.compare_specified(mol, got)
    check("已指定中心在三维结果中保持", cmp["ok"], str(cmp["mismatches"]))
    check("至少比较了一个中心", cmp["checked"] >= 1, str(cmp["checked"]))


def _embed(mol):
    from rdkit.Chem import AllChem
    m = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xF00D
    AllChem.EmbedMolecule(m, params)
    AllChem.MMFFOptimizeMolecule(m, maxIters=500)
    return Chem.MolToMolBlock(m)


def test_error_paths():
    print("[14] 错误路径必须显式报错")
    bad = {"type": "molecule", "atoms": [{"label": "R#", "location": [0, 0, 0]}], "bonds": []}
    try:
        stereo.mol_from_section(bad)
        check("查询原子报错", False)
    except stereo.StereoError as e:
        check("查询原子报错", "查询原子" in str(e), str(e))
    try:
        stereo.layout_ket("not json")
        check("非法 KET 报错", False)
    except stereo.StereoError as e:
        check("非法 KET 报错", "KET" in str(e), str(e))
    try:
        stereo.parse_any("C1CC(")
        check("非法 SMILES 报错", False)
    except stereo.StereoError:
        check("非法 SMILES 报错", True)



def test_crossed_double_bond():
    print("[15] 交叉双键（E/Z 显式未知）")
    doc = json.loads(load("W06"))
    sec = doc[stereo.molecule_keys(doc)[0]]
    a = stereo.analyze_mol(stereo.mol_from_section(sec), sec)
    check("W06 双键判为未确定",
          a["double"]["unknown"] + a["double"]["unspecified"] == 1, str(a["double"]))
    check("W06 需要用户选择", a["needsChoice"] is True, str(a["reasons"]))
    before = Chem.MolToSmiles(stereo.mol_from_section(sec))
    res = stereo.layout_section(sec)
    codes = [b["stereo"] for b in res["bonds"]]
    check("W06 整理后仍是显式未知", 3 in codes, str(codes))
    after_sec = dict(sec)
    after_sec["atoms"] = []
    for i, at in enumerate(sec["atoms"]):
        na = dict(at)
        na["location"] = [res["atoms"][i][0], res["atoms"][i][1], 0.0]
        after_sec["atoms"].append(na)
    after_sec["bonds"] = []
    for b, bo in zip(sec["bonds"], res["bonds"]):
        nb = dict(b)
        nb["atoms"] = [bo["i"], bo["j"]]
        if bo["stereo"]:
            nb["stereo"] = bo["stereo"]
        else:
            nb.pop("stereo", None)
        after_sec["bonds"].append(nb)
    after = Chem.MolToSmiles(stereo.mol_from_section(after_sec))
    check("W06 整理前后 SMILES 一致（都表示未知）", before == after, f"{before} -> {after}")


def test_repeated_layout_is_stable():
    print("[16] 重复整理不改变朝向")
    import math
    for fid in ("M03", "M06", "R01", "W04", "W05", "W06"):
        doc = json.loads(load(fid))
        sec = doc[stereo.molecule_keys(doc)[0]]
        first = stereo.layout_section(sec)
        after = dict(sec)
        after["atoms"] = []
        for i, at in enumerate(sec["atoms"]):
            na = dict(at)
            na["location"] = [first["atoms"][i][0], first["atoms"][i][1], 0.0]
            after["atoms"].append(na)
        after["bonds"] = []
        for b, bo in zip(sec["bonds"], first["bonds"]):
            nb = dict(b)
            nb["atoms"] = [bo["i"], bo["j"]]
            if bo["stereo"]:
                nb["stereo"] = bo["stereo"]
            else:
                nb.pop("stereo", None)
            after["bonds"].append(nb)
        second = stereo.layout_section(after)
        moved = max(math.hypot(a[0] - b[0], a[1] - b[1])
                    for a, b in zip(first["atoms"], second["atoms"]))
        check(f"{fid} 二次整理位移 <= 1e-3", moved <= 1e-3,
              f"{moved:.4f}（旋转 {first['report']['rotation']} / {second['report']['rotation']}）")


def test_two_wedge_presentation():
    print("[17] 已有的一实一虚画法保留（W04/W05）")
    for fid, want in (("W04", "S"), ("W05", "R")):
        doc = json.loads(load(fid))
        sec = doc[stereo.molecule_keys(doc)[0]]
        before = Chem.FindMolChiralCenters(stereo.mol_from_section(sec),
                                           useLegacyImplementation=False)
        check(f"{fid} 输入构型为 {want}", before == [(0, want)], str(before))
        res = stereo.layout_section(sec)
        codes = [b["stereo"] for b in res["bonds"]]
        check(f"{fid} 整理后仍是一实一虚", (codes.count(1), codes.count(6)) == (1, 1), str(codes))
        check(f"{fid} 报告标注保留中心", res["report"].get("twoWedgeCenters") == [0],
              str(res["report"].get("twoWedgeCenters")))
        after_sec = dict(sec)
        after_sec["atoms"] = []
        for i, at in enumerate(sec["atoms"]):
            na = dict(at)
            na["location"] = [res["atoms"][i][0], res["atoms"][i][1], 0.0]
            after_sec["atoms"].append(na)
        after_sec["bonds"] = []
        for b, bo in zip(sec["bonds"], res["bonds"]):
            nb = dict(b)
            nb["atoms"] = [bo["i"], bo["j"]]
            if bo["stereo"]:
                nb["stereo"] = bo["stereo"]
            else:
                nb.pop("stereo", None)
            after_sec["bonds"].append(nb)
        after = Chem.FindMolChiralCenters(stereo.mol_from_section(after_sec),
                                          useLegacyImplementation=False)
        check(f"{fid} 构型保持 {want}", after == [(0, want)], str(after))
    # 单楔键样本不被强行补成两条
    doc = json.loads(load("M03"))
    sec = doc[stereo.molecule_keys(doc)[0]]
    res = stereo.layout_section(sec)
    codes = [b["stereo"] for b in res["bonds"]]
    check("M03 单楔键仍是一条", (codes.count(1) + codes.count(6)) == 1, str(codes))


def test_layout_fault_tolerance_and_readable_valence_error():
    print("[18] 多分子整理容错与显式价态可读报错")
    single_bad = {
        "root": {"nodes": [{"$ref": "mol0"}]},
        "mol0": {
            "type": "molecule",
            "atoms": [
                {"label": "N", "location": [0.0, 0.0, 0.0], "charge": 1, "radical": 3},
                {"label": "O", "location": [1.5, 0.0, 0.0]}
            ],
            "bonds": [{"type": 3, "atoms": [0, 1]}]
        }
    }
    try:
        stereo.layout_ket(json.dumps(single_bad))
        check("单分子超价抛出异常", False)
    except stereo.StereoError as e:
        check("单分子超价抛出异常", True)
        check("错误信息包含原子序号和显式价态可读提示",
              "第 1 个原子（N）显式价态超出允许上限" in str(e), str(e))

    two_mol = {
        "root": {"nodes": [{"$ref": "mol0"}, {"$ref": "mol1"}]},
        "mol0": {
            "type": "molecule",
            "atoms": [
                {"label": "C", "location": [0.0, 0.0, 0.0]},
                {"label": "C", "location": [1.2, 0.7, 0.0]},
                {"label": "C", "location": [1.2, 2.1, 0.0]},
                {"label": "C", "location": [0.0, 2.8, 0.0]},
                {"label": "C", "location": [-1.2, 2.1, 0.0]},
                {"label": "C", "location": [-1.2, 0.7, 0.0]}
            ],
            "bonds": [
                {"type": 1, "atoms": [0, 1]},
                {"type": 2, "atoms": [1, 2]},
                {"type": 1, "atoms": [2, 3]},
                {"type": 2, "atoms": [3, 4]},
                {"type": 1, "atoms": [4, 5]},
                {"type": 2, "atoms": [5, 0]}
            ]
        },
        "mol1": single_bad["mol0"]
    }
    res = stereo.layout_ket(json.dumps(two_mol))
    check("双分子部分合法时返回 ok=True", res.get("ok") is True)
    check("molecules 包含合法分子 mol0", [m["key"] for m in res.get("molecules", [])] == ["mol0"])
    skipped = res.get("skipped") or []
    check("skipped 包含超价分子 mol1", [s["key"] for s in skipped] == ["mol1"], str(skipped))
    if skipped:
        check("skipped 错误包含原子和价态提示",
              "第 1 个原子（N）显式价态超出允许上限" in skipped[0].get("error", ""))


def test_analyze_and_group_buckets_match_smiles_path():
    print("[19] KET 多组相对立体按标签分桶，与 SMILES 路径同值")
    labels = ["C", "F", "Cl", "Br", "C", "F", "Cl", "Br"]
    coords = [(0.0, 0.0), (1.2, 0.7), (1.2, -0.7), (-1.2, 0.7),
              (3.6, 0.0), (4.8, 0.7), (4.8, -0.7), (2.4, 0.7)]
    atoms = []
    for i, (x, y) in enumerate(coords):
        atom = {"label": labels[i], "location": [x, y, 0.0]}
        if i == 0:
            atom["stereoLabel"] = "&1"
        elif i == 4:
            atom["stereoLabel"] = "&2"
        atoms.append(atom)
    bonds = [
        {"type": 1, "atoms": [0, 1], "stereo": 1}, {"type": 1, "atoms": [0, 2]},
        {"type": 1, "atoms": [0, 3]}, {"type": 1, "atoms": [4, 5], "stereo": 1},
        {"type": 1, "atoms": [4, 6]}, {"type": 1, "atoms": [4, 7]},
    ]
    sec = {"type": "molecule", "atoms": atoms, "bonds": bonds}
    a_ket = stereo.analyze_mol(stereo.mol_from_section(sec), sec)
    a_smiles = stereo.analyze_mol(stereo.parse_any("F[C@H](Cl)Br.F[C@H](Cl)Br |&1:1,&2:5|"))
    check("KET 路径识别出 2 个 AND 组", a_ket["groups"]["and"] == 2, str(a_ket["groups"]))
    check("SMILES 路径识别出 2 个 AND 组", a_smiles["groups"]["and"] == 2, str(a_smiles["groups"]))
    check("两路径 groups 同值", a_ket["groups"] == a_smiles["groups"],
          f"{a_ket['groups']} vs {a_smiles['groups']}")
    check("KET groupAtoms 按组分桶", a_ket["groupAtoms"]["and"] == [[0], [4]], str(a_ket["groupAtoms"]))
    check("SMILES groupAtoms 按组分桶", a_smiles["groupAtoms"]["and"] == [[1], [5]],
          str(a_smiles["groupAtoms"]))
    check("and_group 原因仍在", "and_group" in a_ket["reasons"], str(a_ket["reasons"]))
    mol = stereo.mol_from_section(sec)
    centers = Chem.FindMolChiralCenters(mol, useLegacyImplementation=False)
    check("两个 & 组中心都是已指定构型", len(centers) == 2, str(centers))


def main():
    test_parse()
    test_isomer_roundtrip()
    test_stereo_labels()
    test_analyze()
    test_analyze_unknown_vs_unspecified()
    test_layout_preserves_chemistry()
    test_layout_appearance()
    test_layout_preserves_user_drawing()
    test_layout_bond_lengths()
    test_layout_keeps_position()
    test_layout_ket_targets()
    test_layout_non_target_untouched()
    test_layout_compacts_native_reaction_stages()
    test_stereo_from_3d()
    test_error_paths()
    test_crossed_double_bond()
    test_repeated_layout_is_stable()
    test_two_wedge_presentation()
    test_layout_fault_tolerance_and_readable_valence_error()
    test_analyze_and_group_buckets_match_smiles_path()
    print()
    print(f"结果：{PASS} PASS / {FAIL} FAIL")
    if FAILED:
        for f in FAILED:
            print("  -", f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
