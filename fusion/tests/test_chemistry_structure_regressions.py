"""Current canvas shared chemistry: strict parsing and lossless agent KET."""
import json
import types
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rdkit import Chem
import inorganic
import server
import stereo


def structure(smiles):
    return server.Handler._api_agent_structure(None, smiles)


def canonical_without_maps(smiles):
    params = Chem.SmilesParserParams()
    params.removeHs = False
    mol = Chem.MolFromSmiles(smiles, params)
    for atom in mol.GetAtoms():
        atom.SetAtomMapNum(0)
    return Chem.MolToSmiles(mol, isomericSmiles=True)


class ChemistryStructureRegressions(unittest.TestCase):
    def test_unsupported_radicals_are_rejected_with_attribution(self):
        for smiles, count in (('[C:9]', 4), ('[CH:9]', 3), ('[N:9]', 3), ('[NH+:9]', 3)):
            with self.subTest(smiles=smiles), self.assertRaises(server.ApiError) as failure:
                structure(smiles)
            self.assertEqual(failure.exception.code, 'unsupported_radical_state')
            self.assertEqual(failure.exception.extra['atomIndex'], 0)
            self.assertEqual(failure.exception.extra['atomMap'], 9)
            self.assertEqual(failure.exception.extra['radicalElectrons'], count)

    def test_supported_radicals_hydrogens_isotopes_and_stereo_roundtrip(self):
        for smiles in ('[CH3:1]', '[CH2:1]', '[13CH3:1][CH2:2]', '[OH-:1]',
                       '[CH3:3][O+:7]([H:12])[CH3:4]', '[F:1][C@@H:2]([Cl:3])[Br:4]',
                       '[CH3:1][CH2:2][OH:3]'):
            with self.subTest(smiles=smiles):
                result = structure(smiles)
                section = result['ket']['mol0']
                restored = stereo.mol_from_section(section)
                self.assertEqual(Chem.MolToSmiles(restored, isomericSmiles=True), canonical_without_maps(smiles))
                params = Chem.SmilesParserParams(); params.removeHs = False
                source = Chem.MolFromSmiles(smiles, params)
                self.assertEqual([str(a.GetAtomMapNum()) for a in source.GetAtoms()],
                                 [a['ref'] for a in result['atoms']])

    def test_full_inorganic_catalog_through_all_endpoints(self):
        self.assertEqual(len(inorganic.TEMPLATES), 35)
        for t in inorganic.TEMPLATES:
            with self.subTest(template=t.name):
                raw = Chem.RWMol(); center = Chem.Atom(t.center); center.SetFormalCharge(t.charge); center.SetNoImplicit(True); raw.AddAtom(center)
                for symbol, order, _ in t.slots:
                    atom = Chem.Atom(symbol); atom.SetNoImplicit(True); idx = raw.AddAtom(atom)
                    raw.AddBond(0, idx, Chem.BondType.SINGLE if order == 1 else Chem.BondType.DOUBLE)
                smiles = Chem.MolToSmiles(raw.GetMol())
                block = Chem.MolToMolBlock(stereo.parse_any(smiles))
                for source in (smiles, block):
                    self.assertEqual(server.check_mol(source), [])
                    self.assertTrue(server.props_of(source)['formula'])
                    self.assertEqual(server.check_mol(server.clean2d(source)), [])
                result = structure(smiles)
                self.assertIsNotNone(inorganic.match(stereo.mol_from_section(result['ket']['mol0'])))

    def test_unknown_invalid_valences_remain_rejected(self):
        for smiles in ('[CH5:42]', 'FCl(F)(F)Cl'):
            with self.subTest(smiles=smiles):
                self.assertTrue(server.check_mol(smiles))
                with self.assertRaises(ValueError): server.props_of(smiles)
                with self.assertRaises(ValueError): server.clean2d(smiles)
                with self.assertRaises(server.ApiError): structure(smiles)

    def test_dative_coordination_bonds_get_readable_structured_rejection(self):
        for smiles in ('[NH3:1][Pt+2:2]([NH3:3])([Cl:4])[Cl:5]', '[NH3:1]->[Zn:2]<-[NH3:3]'):
            with self.subTest(smiles=smiles), self.assertRaises(server.ApiError) as failure:
                structure(smiles)
            self.assertEqual(failure.exception.code, 'unsupported_dative_bond')
            self.assertEqual(failure.exception.extra['field'], 'smiles')
            self.assertIn('配位', failure.exception.message)

    def test_inspect_structures_local_reports_bare_value_errors_as_records(self):
        handler = types.SimpleNamespace(
            _api_agent_structure=lambda data: server.Handler._api_agent_structure(None, data))
        result = server.Handler._inspect_structures_local(handler, {"structures": [
            {"id": "ok", "smiles": "[CH4:1]"},
            {"id": "dative", "smiles": "[NH3:1][Pt+2:2]([Cl:4])[Cl:5]"},
        ]})
        self.assertTrue(result["ok"])
        records = {record["id"]: record for record in result["data"]}
        self.assertTrue(records["ok"]["ok"])
        self.assertFalse(records["dative"]["ok"])
        self.assertEqual(records["dative"]["field"], "smiles")
        self.assertIn("配位", records["dative"]["error"])

        def boom(data):
            raise ValueError("仅支持 V2000 molblock")

        result = server.Handler._inspect_structures_local(
            types.SimpleNamespace(_api_agent_structure=boom),
            {"structures": [{"id": "x", "smiles": "C"}]})
        record = result["data"][0]
        self.assertFalse(record["ok"])
        self.assertEqual(record["code"], "structure_failed")
        self.assertEqual(record["error"], "仅支持 V2000 molblock")

    def test_ket_to_molblock_keeps_radical_and_implicit_h_declarations(self):
        section = {
            "type": "molecule",
            "atoms": [
                {"label": "C", "location": [0.0, 0.0, 0.0], "radical": 2, "implicitHCount": 2},
                {"label": "C", "location": [1.5, 0.0, 0.0], "implicitHCount": 3},
            ],
            "bonds": [{"type": 1, "atoms": [0, 1]}],
        }
        block = server.ket_to_molblock(json.dumps({"mol0": section}))
        self.assertIn("M  RAD", block)
        restored = stereo.parse_any(block)
        direct = stereo.mol_from_section(section)
        self.assertEqual(Chem.MolToSmiles(restored), Chem.MolToSmiles(direct))
        self.assertEqual(Chem.MolToSmiles(restored), '[CH2]C')
        self.assertEqual([atom.GetNumRadicalElectrons() for atom in restored.GetAtoms()], [1, 0])
        self.assertEqual([atom.GetTotalNumHs() for atom in restored.GetAtoms()], [2, 3])

    def test_ket_to_molblock_rejects_invalid_implicit_h_count(self):
        bad = {"mol0": {"type": "molecule",
                        "atoms": [{"label": "C", "location": [0.0, 0.0, 0.0], "implicitHCount": "x"}],
                        "bonds": []}}
        with self.assertRaises(ValueError) as failure:
            server.ket_to_molblock(json.dumps(bad))
        self.assertIn("氢数", str(failure.exception))
        over = {"mol0": {"type": "molecule",
                         "atoms": [{"label": "C", "location": [0.0, 0.0, 0.0], "implicitHCount": 17}],
                         "bonds": []}}
        with self.assertRaises(ValueError) as failure:
            server.ket_to_molblock(json.dumps(over))
        self.assertIn("超出合理范围", str(failure.exception))

if __name__ == '__main__': unittest.main()
