"""Real geometry, atom-identity and rejection tests; no network or force-field mocks.
Run: .venv-rdkit/bin/python -B fusion/tests/test_inorganic_3d.py
"""
import copy
import itertools
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rdkit import Chem
import inorganic
import server
import stereo


def ket_section(mol):
    return {"type": "molecule", "atoms": [
        {"label": a.GetSymbol(), "charge": a.GetFormalCharge(), "isotope": a.GetIsotope(),
         "location": [float(i), float(i % 2), 0.]}
        for i, a in enumerate(mol.GetAtoms())], "bonds": [
        {"type": int(b.GetBondTypeAsDouble()), "atoms": [b.GetBeginAtomIdx(), b.GetEndAtomIdx()]}
        for b in mol.GetBonds()]}


def identity(mol):
    return ([(a.GetSymbol(), a.GetFormalCharge(), a.GetIsotope(), a.GetAtomMapNum()) for a in mol.GetAtoms()],
            [(b.GetBeginAtomIdx(), b.GetEndAtomIdx(), b.GetBondTypeAsDouble()) for b in mol.GetBonds()])


def central_angles(mol):
    center = max(mol.GetAtoms(), key=lambda a: a.GetDegree())
    conf = mol.GetConformer()
    vectors = [conf.GetAtomPosition(a.GetIdx()) - conf.GetAtomPosition(center.GetIdx()) for a in center.GetNeighbors()]
    return sorted(round(math.degrees(a.AngleTo(b)), 1) for a, b in itertools.combinations(vectors, 2))


class Inorganic3D(unittest.TestCase):
    def test_known_shapes_independent_of_template_directions(self):
        # Counts and angles are chemical expectations, not taken from the generator.
        expected = {
            'F[Xe]F': [180.],
            'F[Xe](F)(F)F': [90.] * 4 + [180.] * 2,
            'F[Kr]F': [180.],
            'FS(F)(F)(F)(F)F': [90.] * 12 + [180.] * 3,
            'FP(F)(F)(F)F': [90.] * 6 + [120.] * 3 + [180.],
            'FS(F)(F)F': [90.] * 4 + [120., 180.],
            'FCl(F)F': [90., 90., 180.],
            'FBr(F)(F)(F)F': [90.] * 8 + [180.] * 2,
            'FI(F)(F)(F)(F)(F)F': [72.] * 5 + [90.] * 10 + [144.] * 5 + [180.],
            'O=[Xe](=O)(=O)=O': [109.5] * 6,
            'O=[Xe](=O)=O': [109.5] * 3,
            'F[P-](F)(F)(F)(F)F': [90.] * 12 + [180.] * 3,
            'I[I-]I': [180.],
            'Cl[I-](Cl)(Cl)Cl': [90.] * 4 + [180.] * 2,
        }
        for smiles, angles in expected.items():
            with self.subTest(smiles=smiles):
                mol = stereo.parse_any(smiles)
                before = identity(mol)
                block, _, n, warnings, verify = server.gen3d_mol(mol, smiles)
                got = stereo.parse_any(block)
                self.assertTrue(got.GetConformer().Is3D())
                self.assertEqual(central_angles(got), sorted(angles))
                self.assertEqual(identity(got), before)
                self.assertEqual(n, mol.GetNumAtoms())
                self.assertFalse(warnings)
                self.assertTrue(verify['ok'])

    def test_entire_catalog_smiles_ket_and_mol_round_trip(self):
        for template in inorganic.TEMPLATES:
            with self.subTest(template=template.name):
                raw = Chem.RWMol()
                center = Chem.Atom(template.center)
                center.SetFormalCharge(template.charge)
                center.SetNoImplicit(True)
                raw.AddAtom(center)
                for symbol, order, _ in template.slots:
                    atom = Chem.Atom(symbol)
                    atom.SetNoImplicit(True)
                    idx = raw.AddAtom(atom)
                    raw.AddBond(0, idx, Chem.BondType.SINGLE if order == 1 else Chem.BondType.DOUBLE)
                smiles = Chem.MolToSmiles(raw.GetMol())
                from_smiles = stereo.parse_any(smiles)
                section = ket_section(from_smiles)
                original = copy.deepcopy(section)
                from_ket = stereo.mol_from_section(section)
                for mol in (from_smiles, from_ket):
                    block, _, _, _, verify = server.gen3d_mol(mol, template.name)
                    self.assertEqual(identity(stereo.parse_any(block)), identity(mol))
                    self.assertTrue(verify['ok'])
                    self.assertEqual(sum(a.GetTotalNumHs() for a in mol.GetAtoms()), 0)
                self.assertEqual(section, original, 'input drawing is immutable')

    def test_xef4_reference_lengths_and_planarity(self):
        mol = stereo.parse_any(server.gen3d('F[Xe](F)(F)F')[0])
        center = next(a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == 'Xe')
        conf = mol.GetConformer()
        for atom in mol.GetAtoms():
            p = conf.GetAtomPosition(atom.GetIdx())
            self.assertAlmostEqual(p.z, 0., places=6)
            if atom.GetIdx() != center:
                self.assertAlmostEqual((p - conf.GetAtomPosition(center)).Length(), 1.9349, places=4)

    def test_oxo_ligands_keep_correct_axial_equatorial_roles_when_reordered(self):
        for smiles in ('O=[Xe](=O)(F)F', 'O=[Xe](F)(F)(F)F', 'O=[Xe](=O)(=O)(F)F'):
            original = stereo.parse_any(smiles)
            original.GetAtomWithIdx(0).SetIsotope(18)
            for atom in original.GetAtoms():
                atom.SetAtomMapNum(atom.GetIdx() + 10)
            mol = Chem.RenumberAtoms(original, list(reversed(range(original.GetNumAtoms()))))
            output = stereo.parse_any(server.gen3d_mol(mol, 'permuted')[0])
            self.assertEqual(identity(output), identity(mol))
            conf = output.GetConformer()
            oxos = [conf.GetAtomPosition(a.GetIdx()) for a in output.GetAtoms() if a.GetSymbol() == 'O']
            fluorines = [conf.GetAtomPosition(a.GetIdx()) for a in output.GetAtoms() if a.GetSymbol() == 'F']
            if len(oxos) == 1:
                self.assertTrue(abs(oxos[0].z) > 1.)
                self.assertTrue(all(abs(p.z) < 1e-6 for p in fluorines))
            else:
                self.assertTrue(all(abs(p.z) < 1e-6 for p in oxos))
                self.assertTrue(all(abs(p.z) > 1. for p in fluorines))

    def test_no_blanket_valence_bypass_or_explicit_h_radical_repair(self):
        for smiles in ('FC(F)(F)(F)F', 'FN(F)(F)(F)F', 'F[Kr](F)(F)F', 'O=[Xe](=O)(=O)(=O)=O'):
            with self.subTest(smiles=smiles):
                raw = Chem.MolFromSmiles(smiles, sanitize=False)
                self.assertIsNone(inorganic.match(raw))
                with self.assertRaises(ValueError):
                    stereo.parse_any(smiles)
        for smiles in ('F[Xe](F)F', 'F[Xe+](F)(F)F', 'F[XeH](F)(F)F', 'F[Xe](F)(F)F.C', 'F[Xe](F)(F)Cl'):
            raw = Chem.MolFromSmiles(smiles, sanitize=False)
            self.assertIsNone(inorganic.match(raw), smiles)
        radical = stereo.parse_any('F[Xe](F)(F)F')
        radical.GetAtomWithIdx(0).SetNumRadicalElectrons(1)
        self.assertFalse(inorganic.sanitize_known(radical))

    def test_preserve_explicit_stereochemistry_and_ordinary_organic_path(self):
        mol = stereo.parse_any('O=[Xe](F)(F)(F)F')
        center = next(a for a in mol.GetAtoms() if a.GetSymbol() == 'Xe')
        center.SetChiralTag(Chem.ChiralType.CHI_TRIGONALBIPYRAMIDAL)
        self.assertIsNone(inorganic.build_3d(mol))
        self.assertIsNone(inorganic.geometry_info(mol))
        organic = stereo.parse_any('C[C@H](O)F')
        self.assertIsNone(inorganic.geometry_info(organic))
        block, _, n, warnings, verified = server.gen3d_mol(organic, 'organic')
        self.assertTrue(verified['ok'])
        self.assertEqual(verified['checked'], 1)
        self.assertGreater(n, organic.GetNumAtoms())
        self.assertFalse(block.startswith(inorganic.TITLE_PREFIX))

    def test_mixed_target_generation_and_model_disclosure(self):
        doc = {'root': {'nodes': [{'$ref': 'mol0'}, {'$ref': 'mol1'}]},
               'mol0': ket_section(stereo.parse_any('F[Xe](F)(F)F')),
               'mol1': ket_section(stereo.parse_any('CCO'))}
        targets, _ = server.resolve_targets({'ket': json.dumps(doc)})
        block, count, warnings, verifies = server.gen3d_targets(targets)
        self.assertEqual(count, 14)
        self.assertTrue(all(v['ok'] for v in verifies))
        response = server.attach_geometry_info({}, targets)
        self.assertEqual(len(response['geometry']['molecules']), 1)
        self.assertFalse(response['geometry']['molecules'][0]['optimized'])
        self.assertIn('未做力场或量子化学优化', response['notes'][0])
        old_block, old_n, old_notes = server.gen3d_multi('F[Xe](F)(F)F.CCO')
        self.assertEqual(old_n, count)
        self.assertIn('参考几何', old_notes[0])
        self.assertIn('高对称参考模型', inorganic.geometry_info(stereo.parse_any('F[Xe](F)(F)(F)(F)F'))['note'])

    def test_frontend_catalog_cannot_drift_from_backend(self):
        file = Path(__file__).resolve().parents[2] / 'ketcher-local/inorganic-catalog.js'
        catalog = json.loads(file.read_text().split(' = ', 1)[1].strip().rstrip(';'))
        self.assertEqual(catalog, inorganic.drawing_catalog())


if __name__ == '__main__':
    unittest.main(verbosity=2)
