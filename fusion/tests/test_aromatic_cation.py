#!/usr/bin/env python3
"""芳香三元碳正离子（环丙烯正离子）转换回归。

用法：
    .venv-rdkit/bin/python fusion/tests/test_aromatic_cation.py [-v]

夹具 tests/fixtures/aromatic/*.ket 由 tests/gen_aromatic_fixtures.js 在真实
Ketcher 画布里用真实指针点击生成（芳香化/去芳香化/电荷工具），不是手拼 KET。
覆盖两种真实画布状态：
  a01/a02  先画明确单双键再芳香化 → KET 带 implicitHCount:1
  a04      先画芳香键再加电荷     → KET 无 implicitHCount（编辑器认为该碳 0 氢）
"""
from __future__ import annotations

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FUSION = os.path.dirname(HERE)
sys.path.insert(0, FUSION)

from rdkit import Chem  # noqa: E402
from rdkit.Chem import rdMolDescriptors  # noqa: E402

import stereo  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "aromatic")
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
        return json.load(f)


def section(fid):
    doc = load(fid)
    return doc[stereo.molecule_keys(doc)[0]]


def smiles(mol):
    return Chem.MolToSmiles(mol)


def formula(mol):
    return rdMolDescriptors.CalcMolFormula(mol)


# ---------------------------------------------------------------- 真实夹具
def test_real_fixtures():
    print("[1] 真实画布夹具")
    a01 = section("a01-aromatic-cyclopropenyl-cation")
    m1 = stereo.mol_from_section(a01)
    check("a01 芳香形式可解析", smiles(m1) == "c1c[cH+]1", smiles(m1))
    check("a01 分子式 C3H3+", formula(m1) == "C3H3+", formula(m1))
    check("a01 总电荷 +1", Chem.GetFormalCharge(m1) == 1)
    check("a01 不加 H 原子", m1.GetNumAtoms() == 3, str(m1.GetNumAtoms()))
    check("a01 无补氢说明（KET 已给氢数）", stereo.mol_notes(m1) == [],
          str(stereo.mol_notes(m1)))
    check("a01 KET 确实带 implicitHCount",
          a01["atoms"][2].get("implicitHCount") == 1, json.dumps(a01["atoms"][2]))

    a02 = section("a02-kekule-cyclopropenyl-cation")
    m2 = stereo.mol_from_section(a02)
    check("a02 单双键形式同结构", smiles(m2) == smiles(m1), smiles(m2))
    check("a02 分子式 C3H3+", formula(m2) == "C3H3+", formula(m2))
    check("a02 无补氢说明", stereo.mol_notes(m2) == [])

    a04 = section("a04-aromatic-ring-charged-after")
    check("a04 夹具确实没有 implicitHCount",
          all("implicitHCount" not in a for a in a04["atoms"]))
    m4 = stereo.mol_from_section(a04)
    check("a04 芳香键 + 后加电荷可解析", smiles(m4) == "c1c[cH+]1", smiles(m4))
    check("a04 分子式 C3H3+", formula(m4) == "C3H3+", formula(m4))
    notes4 = stereo.mol_notes(m4)
    check("a04 有且只有一条补氢说明", len(notes4) == 1, str(notes4))
    check("a04 说明写清原子序号与分子式",
          bool(notes4) and "第 1 个碳" in notes4[0] and "C3H3+" in notes4[0],
          str(notes4))
    check("a04 不加 H 原子", m4.GetNumAtoms() == 3, str(m4.GetNumAtoms()))

    a05 = section("a05-methyl-aromatic-cation")
    m5 = stereo.mol_from_section(a05)
    check("a05 取代基不被补氢", formula(m5) == "C4H5+", formula(m5))
    check("a05 无补氢说明", stereo.mol_notes(m5) == [])

    a03 = section("a03-benzene")
    m3 = stereo.mol_from_section(a03)
    check("a03 苯仍为芳香", smiles(m3) == "c1ccccc1", smiles(m3))
    check("a03 分子式 C6H6", formula(m3) == "C6H6", formula(m3))


# ---------------------------------------------------------------- 语义边界
def test_semantics():
    print("[2] 氢数语义边界")
    a01 = section("a01-aromatic-cyclopropenyl-cation")

    # 编辑器明确写 0 氢时必须尊重，不能"修好"成另一种分子
    zero = copy.deepcopy(a01)
    zero["atoms"][2]["implicitHCount"] = 0
    try:
        m = stereo.mol_from_section(zero)
        check("implicitHCount=0 不被改写", False, smiles(m))
    except stereo.StereoError as e:
        msg = str(e)
        check("implicitHCount=0 明确报错", "芳香环" in msg, msg[:60])
        check("报错可读（不是裸 Kekulize 文本）", "Can't kekulize" not in msg.split("（")[0],
              msg[:60])

    # 两个候选正电碳时不做猜测
    two = {
        "type": "molecule",
        "atoms": [
            {"label": "C", "charge": 1, "location": [0, 1, 0]},
            {"label": "C", "location": [-1, 0, 0]},
            {"label": "C", "charge": 1, "location": [1, 0, 0]},
        ],
        "bonds": [{"type": 4, "atoms": [0, 1]}, {"type": 4, "atoms": [1, 2]},
                  {"type": 4, "atoms": [2, 0]}],
    }
    try:
        stereo.mol_from_section(two)
        check("两个候选不猜测", False)
    except stereo.StereoError as e:
        check("两个候选不猜测", "芳香环" in str(e), str(e)[:60])

    # 非芳香键的普通正离子不受影响
    plain = {
        "type": "molecule",
        "atoms": [{"label": "C", "charge": 1, "location": [0, 0, 0]},
                  {"label": "C", "location": [1.5, 0, 0]},
                  {"label": "C", "location": [2.5, 0, 0]}],
        "bonds": [{"type": 1, "atoms": [0, 1]}, {"type": 1, "atoms": [1, 2]}],
    }
    mp = stereo.mol_from_section(plain)
    check("普通碳正离子不受补氢规则影响", formula(mp) == "C3H7+", formula(mp))

    # 非法氢数
    bad = copy.deepcopy(a01)
    bad["atoms"][0]["implicitHCount"] = "x"
    try:
        stereo.mol_from_section(bad)
        check("非法氢数报错", False)
    except stereo.StereoError as e:
        check("非法氢数报错", "氢数" in str(e), str(e)[:60])


# ---------------------------------------------------------------- 生成链路
def test_pipeline():
    print("[3] 生成前检查 / 3D / 整理")
    import server

    a01 = section("a01-aromatic-cyclopropenyl-cation")
    mol = stereo.mol_from_section(a01)
    report = stereo.analyze_mol(mol, a01)
    check("立体检查不报错", report["needsChoice"] is False, json.dumps(report["reasons"]))

    block, smi, natoms, warnings, verify = server.gen3d_mol(mol, "芳香正离子")
    check("3D 生成成功", natoms == 6, str(natoms))
    check("3D SMILES 正确", smi == "c1c[cH+]1", smi)
    check("3D 无力场警告", warnings == [], str(warnings))
    check("3D 立体复核通过", verify["ok"] is True, str(verify))
    got = Chem.MolFromMolBlock(block, sanitize=True, removeHs=False)
    check("3D 结构电荷保持", got is not None and Chem.GetFormalCharge(got) == 1)

    # 整理：坐标可重排，但芳香键、电荷、implicitHCount 必须原样保留
    before = copy.deepcopy(a01)
    res = stereo.layout_section(a01)
    check("整理成功", bool(res.get("atoms")), "")
    check("整理不改动传入 section", a01 == before)
    check("整理保留原子数", len(res["atoms"]) == 3, str(len(res["atoms"])))
    new_sec = {"type": "molecule", "atoms": [], "bonds": []}
    for i, a in enumerate(before["atoms"]):
        na = dict(a)
        na["location"] = [res["atoms"][i][0], res["atoms"][i][1], 0.0]
        new_sec["atoms"].append(na)
    for b, bo in zip(before["bonds"], res["bonds"]):
        nb = dict(b)
        nb["atoms"] = [bo["i"], bo["j"]]
        new_sec["bonds"].append(nb)
    check("整理后仍可解析", smiles(stereo.mol_from_section(new_sec)) == "c1c[cH+]1",
          smiles(stereo.mol_from_section(new_sec)))
    check("整理保留电荷", new_sec["atoms"][2].get("charge") == 1)
    check("整理保留 implicitHCount", new_sec["atoms"][2].get("implicitHCount") == 1)
    check("整理保留芳香键", all(int(b.get("type")) == 4 for b in new_sec["bonds"]),
          json.dumps(new_sec["bonds"]))


def main():
    test_real_fixtures()
    test_semantics()
    test_pipeline()
    print(f"\n结果：{PASS} PASS / {FAIL} FAIL")
    if FAILED:
        for f in FAILED:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
