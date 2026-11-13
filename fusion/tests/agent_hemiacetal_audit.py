"""Audit actual main-canvas context independently of model/tool completion.

Usage: .venv-rdkit/bin/python -B fusion/tests/agent_hemiacetal_audit.py
       /absolute/path/completed-context.json /absolute/path/chemistry-audit.json
RDKit reconstruction uses the editor's actual atoms, formal charges, H counts,
and bonds; step inventory and flow endpoints remain available for manual review.
"""
import json
import sys
from collections import Counter
from pathlib import Path

from rdkit import Chem
from rdkit.Chem import rdMolDescriptors

context = json.loads(Path(sys.argv[1]).read_text())
atoms = {atom['id']: atom for atom in context['atoms']}
bonds = {bond['id']: bond for bond in context['bonds']}
arrows = {arrow['id']: arrow for arrow in context['arrows']}
components, owner, impossible_stereo = {}, {}, []
for molecule in context['molecules']:
    editable, indices = Chem.RWMol(), {}
    for atom_id in molecule['atoms']:
        atom = atoms[atom_id]
        item = Chem.Atom(atom['label'])
        item.SetFormalCharge(atom.get('charge') or 0)
        item.SetNumExplicitHs(atom.get('implicitH') or 0)
        item.SetNoImplicit(True)
        item.SetIsotope(atom.get('isotope') or 0)
        item.SetNumRadicalElectrons(atom.get('radical') or 0)
        indices[atom_id] = editable.AddAtom(item)
        owner[atom_id] = molecule['id']
    for bond_id in molecule['bonds']:
        bond = bonds[bond_id]
        editable.AddBond(indices[bond['begin']], indices[bond['end']],
                         {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}[bond['order']])
    mol = editable.GetMol()
    Chem.SanitizeMol(mol)
    for atom_id, index in indices.items():
        source = atoms[atom_id]
        item = mol.GetAtomWithIdx(index)
        if source.get('stereoLabel') and item.GetHybridization() in (Chem.HybridizationType.SP, Chem.HybridizationType.SP2):
            impossible_stereo.append({'atomId': atom_id, 'label': source['stereoLabel'],
                                      'element': source['label'], 'hybridization': str(item.GetHybridization())})
    mol = Chem.RemoveHs(mol)
    counts = Counter()
    for atom in mol.GetAtoms():
        counts[atom.GetSymbol()] += 1
        counts['H'] += atom.GetTotalNumHs()
    components[molecule['id']] = {
        'smiles': Chem.MolToSmiles(mol, canonical=True, isomericSmiles=False),
        'formula': rdMolDescriptors.CalcMolFormula(mol), 'elements': dict(counts),
        'charge': Chem.GetFormalCharge(mol), 'atomIds': molecule['atoms'],
    }

steps, proton_transfers = [], []
for step in context['reactionSteps']:
    reactants = list(dict.fromkeys(owner[ref] for ref in step['reactants']))
    products = list(dict.fromkeys(owner[ref] for ref in step['products']))
    balance, charge = Counter(), 0
    for sign, ids in [(-1, reactants), (1, products)]:
        for mid in ids:
            component = components[mid]
            charge += sign * component['charge']
            for element, number in component['elements'].items():
                balance[element] += sign * number
    checked = step.get('checks', {}).get('layout', {}).get('checkedArrowIds', [])
    flows = [arrows[aid] for aid in checked if aid in arrows]
    for attack in flows:
        source, target = attack.get('source', {}), attack.get('target', {})
        hydrogen = target.get('atomId') if target.get('type') == 'atom' else None
        if target.get('type') == 'formingBond' and source.get('ownerAtomId') in (target.get('atomA'), target.get('atomB')):
            hydrogen = next((ref for ref in (target.get('atomA'), target.get('atomB')) if atoms.get(ref, {}).get('label') == 'H'), None)
        if source.get('type') != 'lonePair' or atoms.get(hydrogen, {}).get('label') != 'H':
            continue
        donor_bonds = [bond for bond in bonds.values() if hydrogen in (bond['begin'], bond['end'])]
        for donor_bond in donor_bonds:
            donor = donor_bond['end'] if donor_bond['begin'] == hydrogen else donor_bond['begin']
            if atoms[donor]['label'] == 'H':
                continue
            paired = [flow['id'] for flow in flows if flow.get('source', {}).get('type') == 'bond' and
                      flow['source'].get('bondId') == donor_bond['id'] and flow['source'].get('component') == 'sigma' and
                      flow.get('target', {}).get('type') == 'atom' and flow['target'].get('atomId') == donor]
            proton_transfers.append({'stepId': step['stepId'], 'attackArrowId': attack['id'], 'hydrogenAtomId': hydrogen,
                                     'donorAtomId': donor, 'donorBondId': donor_bond['id'],
                                     'pairedBondReturnArrowIds': paired, 'valid': bool(paired)})
    steps.append({'stepId': step['stepId'], 'reactants': [components[mid] for mid in reactants],
                  'products': [components[mid] for mid in products], 'elementDelta': {k: v for k, v in balance.items() if v},
                  'chargeDelta': charge, 'balanced': not any(balance.values()) and charge == 0,
                  'checkedArrowIds': checked,
                  'checkedFlows': [{k: arrows[aid].get(k) for k in ('id', 'source', 'target', 'electronCount')}
                                   for aid in checked if aid in arrows]})

canonical = lambda smiles: Chem.MolToSmiles(Chem.MolFromSmiles(smiles), canonical=True, isomericSmiles=False)
target, aldehyde, methanol, hydronium = map(canonical, ['COC(C)O', 'CC=O', 'CO', '[OH3+]'])
reactant_smiles = [c['smiles'] for step in steps for c in step['reactants']]
product_smiles = [c['smiles'] for step in steps for c in step['products']]
checks = {
    'acetaldehyde_and_methanol_enter_as_reactants': aldehyde in reactant_smiles and methanol in reactant_smiles,
    'neutral_hemiacetal_is_a_product': target in product_smiles and any(c['smiles'] == target and c['charge'] == 0 and c['formula'] == 'C3H8O2' for c in components.values()),
    'hydronium_appears_as_reactant_and_product': hydronium in reactant_smiles and hydronium in product_smiles,
    'all_steps_conserve_elements_and_charge': bool(steps) and all(step['balanced'] for step in steps),
    'at_least_three_steps_each_have_two_checked_flows': len(steps) >= 3 and all(len(step['checkedFlows']) >= 2 for step in steps),
    'proton_transfer_sigma_electrons_return_to_the_donor_atom': len(proton_transfers) >= 2 and all(t['valid'] for t in proton_transfers),
    'no_absolute_stereo_label_on_linear_or_trigonal_atoms': not impossible_stereo,
}
result = {'application': 'MolStudio canvas', 'page': 'fusion/canvas.html', 'sourceContext': str(Path(sys.argv[1]).resolve()),
          'basis': 'RDKit reconstruction from actual editor atoms, bonds, H counts and charges; flow semantics still require manual review.',
          'checks': checks, 'steps': steps, 'components': components, 'protonTransfers': proton_transfers, 'impossibleStereo': impossible_stereo,
          'requiresManualFlowAndLayoutReview': True,
          'automaticChecksPass': all(checks.values())}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'automaticChecksPass': result['automaticChecksPass'], 'checks': checks, 'steps': len(steps)}, ensure_ascii=False))
sys.exit(0 if result['automaticChecksPass'] else 1)
