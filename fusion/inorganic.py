"""Offline reference geometries for a bounded set of small inorganic molecules.

These are isolated-molecule visual models, not force-field/quantum optimizations
or crystal structures. Match the complete labelled, charged bond graph, never
just the central element or coordination number. Original atom indices, bonds,
charges and isotopes are retained. No coordinates from the 2D drawing are used.

Geometry references:
https://cccbdb.nist.gov/expgeom2x.asp?casno=13709610&charge=0 (XeF4)
https://cccbdb.nist.gov/expangle2x.asp?all=0&descript=aFXeF (XeF2/4)
https://cccbdb.nist.gov/expgeom2x.asp?casno=7790912&charge=0 (ClF3)
https://www.open.edu/openlearn/mod/oucontent/view.php?id=87848&section=_unit7.3.1
https://doi.org/10.1021/ja0423116 (XeF6 is fluxional, not rigid octahedral)
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
import math

from rdkit import Chem
from rdkit.Geometry import Point3D


def ring(n):
    return tuple((math.cos(2 * math.pi * i / n), math.sin(2 * math.pi * i / n), 0.) for i in range(n))


AXIAL = ((0., 0., 1.), (0., 0., -1.))
LINEAR = AXIAL
PLANAR = ring(3)
SQUARE = ring(4)
TBP = PLANAR + AXIAL
OCTAHEDRAL = SQUARE + AXIAL
T_SHAPED = ((1., 0., 0.),) + AXIAL
SEESAW = PLANAR[1:] + AXIAL
SQUARE_PYRAMID = SQUARE + AXIAL[:1]
TETRAHEDRAL = tuple(tuple(v / math.sqrt(3) for v in p) for p in ((1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1)))
PYRAMID = TETRAHEDRAL[:3]
PENTAGONAL_BIPYRAMID = ring(5) + AXIAL
TITLE_PREFIX = "MolStudio 参考几何："
NIST_XEF4 = "https://cccbdb.nist.gov/expgeom2x.asp?casno=13709610&charge=0"


@dataclass(frozen=True)
class Template:
    name: str
    center: str
    charge: int
    # One slot per ligand: element, bond order, unit direction.
    slots: tuple
    shape: str
    detail: str = "键长按共价半径估算，键角使用理想化模型"
    source: str = "VSEPR"
    bond_length: float | None = None

    @property
    def signature(self):
        return tuple(sorted(Counter((symbol, order) for symbol, order, _ in self.slots).items()))


def homoleptic(name, center, ligand, directions, shape, charge=0, **kw):
    return Template(name, center, charge, tuple((ligand, 1, v) for v in directions), shape, **kw)


TEMPLATES = (
    homoleptic("XeF2", "Xe", "F", LINEAR, "直线形"),
    homoleptic("XeF4", "Xe", "F", SQUARE, "平面正方形", bond_length=1.9349,
               detail="采用 NIST 参考键长 1.9349 Å 和 90°/180° 键角", source=NIST_XEF4),
    homoleptic("XeF6", "Xe", "F", OCTAHEDRAL, "八面体参考构型",
               detail="这是高对称参考模型；真实 XeF6 可发生畸变和动态构型变化",
               source="https://doi.org/10.1021/ja0423116"),
    homoleptic("KrF2", "Kr", "F", LINEAR, "直线形"),
    Template("XeO3", "Xe", 0, tuple(("O", 2, v) for v in PYRAMID), "三角锥形"),
    Template("XeO4", "Xe", 0, tuple(("O", 2, v) for v in TETRAHEDRAL), "正四面体"),
    Template("XeOF2", "Xe", 0, (("O", 2, T_SHAPED[0]),) + tuple(("F", 1, v) for v in AXIAL), "T 形"),
    Template("XeOF4", "Xe", 0, tuple(("F", 1, v) for v in SQUARE) + (("O", 2, AXIAL[0]),), "四方锥形"),
    Template("XeO2F2", "Xe", 0, tuple(("O", 2, v) for v in PLANAR[1:]) + tuple(("F", 1, v) for v in AXIAL), "跷跷板形"),
    Template("XeO3F2", "Xe", 0, tuple(("O", 2, v) for v in PLANAR) + tuple(("F", 1, v) for v in AXIAL), "三角双锥"),
    homoleptic("PF5", "P", "F", TBP, "三角双锥"),
    homoleptic("PCl5", "P", "Cl", TBP, "三角双锥"),
    homoleptic("AsF5", "As", "F", TBP, "三角双锥"),
    homoleptic("SbF5", "Sb", "F", TBP, "三角双锥"),
    homoleptic("SF4", "S", "F", SEESAW, "跷跷板形"),
    homoleptic("SF6", "S", "F", OCTAHEDRAL, "正八面体"),
    homoleptic("SeF4", "Se", "F", SEESAW, "跷跷板形"),
    homoleptic("SeF6", "Se", "F", OCTAHEDRAL, "正八面体"),
    homoleptic("TeF6", "Te", "F", OCTAHEDRAL, "正八面体"),
    homoleptic("ClF3", "Cl", "F", T_SHAPED, "T 形"),
    homoleptic("BrF3", "Br", "F", T_SHAPED, "T 形"),
    homoleptic("IF3", "I", "F", T_SHAPED, "T 形"),
    homoleptic("ClF5", "Cl", "F", SQUARE_PYRAMID, "四方锥形"),
    homoleptic("BrF5", "Br", "F", SQUARE_PYRAMID, "四方锥形"),
    homoleptic("IF5", "I", "F", SQUARE_PYRAMID, "四方锥形"),
    homoleptic("IF7", "I", "F", PENTAGONAL_BIPYRAMID, "五角双锥"),
    homoleptic("BF3", "B", "F", PLANAR, "平面三角形"),
    homoleptic("BCl3", "B", "Cl", PLANAR, "平面三角形"),
    homoleptic("BF4−", "B", "F", TETRAHEDRAL, "正四面体", charge=-1),
    homoleptic("PF6−", "P", "F", OCTAHEDRAL, "正八面体", charge=-1),
    homoleptic("SiF6²−", "Si", "F", OCTAHEDRAL, "正八面体", charge=-2),
    homoleptic("I3−", "I", "I", LINEAR, "直线形", charge=-1),
    homoleptic("ICl2−", "I", "Cl", LINEAR, "直线形", charge=-1),
    homoleptic("ICl4−", "I", "Cl", SQUARE, "平面正方形", charge=-1),
    homoleptic("IF4−", "I", "F", SQUARE, "平面正方形", charge=-1),
)
_BY_SIZE = defaultdict(list)
for _template in TEMPLATES:
    _BY_SIZE[len(_template.slots) + 1].append(_template)


def match(mol):
    """Return (template, center index, slot-to-original-index mapping) or None.

    Explicit hydrogens/radicals, query/aromatic/dative bonds, non-star graphs,
    unknown charges and extra fragments cannot enter this bounded exception.
    """
    n = mol.GetNumAtoms()
    candidates = _BY_SIZE.get(n, ())
    if not candidates or mol.GetNumBonds() != n - 1:
        return None
    if any(a.HasQuery() or a.GetIsAromatic() or a.GetNumRadicalElectrons() or a.GetNumExplicitHs()
           for a in mol.GetAtoms()):
        return None
    if any(b.HasQuery() or b.GetIsAromatic() or b.GetBondType() not in (Chem.BondType.SINGLE, Chem.BondType.DOUBLE)
           for b in mol.GetBonds()):
        return None
    centers = [a for a in mol.GetAtoms() if a.GetDegree() == n - 1]
    if len(centers) != 1:
        return None
    center = centers[0]
    groups = defaultdict(list)
    for ligand in center.GetNeighbors():
        if ligand.GetDegree() != 1 or ligand.GetFormalCharge() != 0:
            return None
        bond = mol.GetBondBetweenAtoms(center.GetIdx(), ligand.GetIdx())
        groups[(ligand.GetSymbol(), int(bond.GetBondTypeAsDouble()))].append(ligand.GetIdx())
    signature = tuple(sorted((key, len(ids)) for key, ids in groups.items()))
    for template in candidates:
        if center.GetSymbol() == template.center and center.GetFormalCharge() == template.charge and signature == template.signature:
            # Equivalent ligands are interchangeable; isotope identity stays on
            # the same atom. Distinct O/F slots do not depend on input ordering.
            available = {k: list(v) for k, v in groups.items()}
            indices = [available[(symbol, order)].pop(0) for symbol, order, _ in template.slots]
            return template, center.GetIdx(), indices
    return None


def sanitize_known(mol):
    """Sanitize an exactly recognized molecule with its known bonded valences.

    Skip only RDKit's default strict valence/radical inference for this complete
    closed-shell graph. All other molecules keep full RDKit sanitization.
    """
    if match(mol) is None:
        return False
    for atom in mol.GetAtoms():
        atom.SetNoImplicit(True)
    mol.UpdatePropertyCache(strict=False)
    ops = Chem.SanitizeFlags.SANITIZE_ALL ^ Chem.SanitizeFlags.SANITIZE_PROPERTIES ^ Chem.SanitizeFlags.SANITIZE_FINDRADICALS
    Chem.SanitizeMol(mol, sanitizeOps=ops)
    return True


def _geometry_match(mol):
    # Never override an explicitly specified stereoisomer with a fixed model.
    if any(a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED for a in mol.GetAtoms()):
        return None
    if any(b.GetStereo() != Chem.BondStereo.STEREONONE for b in mol.GetBonds()):
        return None
    return match(mol)


def geometry_info(mol):
    found = _geometry_match(mol)
    if found is None:
        return None
    template = found[0]
    note = (f"{template.name}：参考几何 · {template.shape}；{template.detail}；"
            "未做力场或量子化学优化，仅表示孤立分子/离子的几何模型")
    return {"method": "reference_geometry", "optimized": False, "name": template.name,
            "shape": template.shape, "source": template.source, "note": note}


def build_3d(mol):
    found = _geometry_match(mol)
    if found is None:
        return None
    template, center, indices = found
    result = Chem.Mol(mol)
    result.RemoveAllConformers()
    conf = Chem.Conformer(result.GetNumAtoms())
    conf.Set3D(True)
    conf.SetAtomPosition(center, Point3D(0., 0., 0.))
    pt = Chem.GetPeriodicTable()
    for index, (symbol, order, direction) in zip(indices, template.slots):
        length = template.bond_length or (pt.GetRcovalent(template.center) + pt.GetRcovalent(symbol)) * (0.9 if order == 2 else 1.)
        conf.SetAtomPosition(index, Point3D(*(length * x for x in direction)))
    result.AddConformer(conf, assignId=True)
    result.SetProp("_Name", TITLE_PREFIX + template.name + " · " + template.shape + " · 未做力场优化")
    return result


def drawing_catalog():
    """JSON-safe signatures shared with the editor's bounded valence helper."""
    return [{"center": t.center, "charge": t.charge,
             "ligands": [[symbol, order, count] for (symbol, order), count in t.signature]}
            for t in TEMPLATES]


if __name__ == "__main__":
    # Regenerate after extending the catalog:
    # .venv-rdkit/bin/python -B fusion/inorganic.py > ketcher-local/inorganic-catalog.js
    import json
    print("// Generated from fusion/inorganic.py; do not edit by hand.")
    print("window.molstudioInorganicCatalog = " + json.dumps(drawing_catalog(), ensure_ascii=False) + ";")
