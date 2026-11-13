"""Current canvas shared chemistry: strict parsing and lossless agent KET."""
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

if __name__ == '__main__': unittest.main()
