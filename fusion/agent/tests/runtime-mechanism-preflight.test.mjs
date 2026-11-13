import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMechanismPreflight, findDuplicateTwoElectronMove } from '../mechanism-preflight.js';

const base = () => ({
  reactantAtoms: ['n', 'h', 'o'], productAtoms: ['n', 'h', 'o'],
  atoms: [
    { id: 'n', label: 'N', charge: 0 }, { id: 'h', label: 'H', charge: 0 },
    { id: 'o', label: 'O', charge: -1, implicitH: 1 },
  ],
  bonds: [{ id: 'nh', begin: 'n', end: 'h', order: 1 }],
  lonePairs: [{ id: 'lp-o', ownerAtomId: 'o' }],
  arrows: [
    { id: 'take-h', source: { type: 'lonePair', slotId: 'lp-o', ownerAtomId: 'o' }, target: { type: 'atom', atomId: 'h' }, electronCount: 2 },
    { id: 'wrong', source: { type: 'bond', bondId: 'nh' }, target: { type: 'atom', atomId: 'o' }, electronCount: 2 },
  ],
});

test('rejects N-H sigma electrons directed to hydroxide in a proton transfer', () => {
  const input = base();
  input.atoms.find(atom => atom.id === 'o').implicitH = 0;
  input.bonds.push({ id: 'oh-product', begin: 'o', end: 'h', order: 1 });
  assert.deepEqual(checkMechanismPreflight(input), {
    code: 'proton_transfer_sigma_to_base',
    message: '质子转移时，N–H 键电子应指向氮原子，而不是氢氧根的氧。',
    arrowIds: ['wrong'],
  });
});

test('rejects the recognizable N-H to isolated hydroxide arrow without a companion proton arrow', () => {
  const input = base();
  input.arrows = [input.arrows[1]];
  const result = checkMechanismPreflight(input);
  assert.equal(result.code, 'proton_transfer_sigma_to_base');
  assert.deepEqual(result.arrowIds, ['wrong']);
});

test('leaves incomplete drafts and correct proton-transfer arrows unverified', () => {
  const incomplete = base();
  incomplete.arrows = incomplete.arrows.slice(0, 1);
  assert.equal(checkMechanismPreflight(incomplete), null);
  const correct = base();
  correct.arrows[1].target.atomId = 'n';
  assert.equal(checkMechanismPreflight(correct), null);
});

test('rejects identical duplicate arrows but allows uncertain distinct bond-source targets', () => {
  const input = base();
  input.arrows = [
    { id: 'a', source: { type: 'bond', bondId: 'nh' }, target: { type: 'atom', atomId: 'o' }, electronCount: 2 },
    { id: 'b', source: { type: 'bond', bondId: 'oh-source' }, target: { type: 'atom', atomId: 'o' }, electronCount: 2 },
  ];
  input.bonds.push({ id: 'oh-source', begin: 'o', end: 'h', order: 1 });
  assert.equal(checkMechanismPreflight(input), null);
  input.arrows[1] = structuredClone(input.arrows[0]);
  input.arrows[1].id = 'b';
  const result = checkMechanismPreflight(input);
  assert.equal(result.code, 'duplicate_two_electron_target');
  assert.deepEqual(result.arrowIds, ['a', 'b']);
  input.arrows[0].electronCount = 1;
  input.arrows[1].electronCount = 1;
  assert.equal(checkMechanismPreflight(input), null);
});

test('compares a new movement to existing arrows independently of curve and batch', () => {
  const source = { type: 'bond', bondId: 'nitroso', component: 'pi' };
  const target = { type: 'atom', atomId: 'oxygen' };
  const existing = { id: 'existing', source, target, electronCount: 2, geometry: { bend: 0.6 } };
  const legacyDuplicate = { ...existing, id: 'legacy', geometry: { bend: -0.6 } };
  const newMove = { ...existing, id: 'new' };
  const distinct = { ...newMove, source: { ...source, component: 'sigma' } };
  const edited = new Set(['new']);
  assert.equal(findDuplicateTwoElectronMove([existing, legacyDuplicate, distinct], edited), null);
  assert.equal(findDuplicateTwoElectronMove([existing, { ...newMove, electronCount: 1 }], edited), null);
  assert.deepEqual(findDuplicateTwoElectronMove([existing, legacyDuplicate, newMove], edited).arrowIds, ['existing', 'new']);
});

test('atom and forming-bond spellings of the same lone-pair attack match', () => {
  const source = { type: 'lonePair', slotId: 'pair', ownerAtomId: 'donor' };
  const first = { id: 'first', source, target: { type: 'atom', atomId: 'carbon' }, electronCount: 2 };
  const second = { ...first, id: 'second', target: { type: 'formingBond', atomA: 'carbon', atomB: 'donor' } };
  assert.deepEqual(findDuplicateTwoElectronMove([first, second]).arrowIds, ['first', 'second']);
});

test('reports a repeated release only when a mapped product supports fewer bond losses', () => {
  const source = { type: 'bond', bondId: 'no-reactant', component: 'pi' };
  const target = { type: 'atom', atomId: 'o-r' };
  const input = {
    reactantAtoms: ['n-r', 'o-r'], productAtoms: ['n-p', 'o-p'],
    atoms: [
      { id: 'n-r', label: 'N' }, { id: 'o-r', label: 'O' },
      { id: 'n-p', label: 'N' }, { id: 'o-p', label: 'O' },
    ],
    bonds: [
      { id: 'no-reactant', begin: 'n-r', end: 'o-r', order: 2 },
      { id: 'no-product', begin: 'n-p', end: 'o-p', order: 1 },
    ],
    arrows: [
      { id: 'pi', source, target, electronCount: 2 },
      { id: 'extra-sigma', source: { ...source, component: 'sigma' }, target, electronCount: 2 },
    ],
  };
  const result = checkMechanismPreflight(input);
  assert.match(result.message, /键级下降/);
  assert.deepEqual(result.arrowIds, ['extra-sigma']);
  input.bonds.pop();
  assert.equal(checkMechanismPreflight(input), null);
  input.productAtoms = [];
  assert.equal(checkMechanismPreflight(input), null);
});

test('rejects two incoming pairs when the product supports only an SN2 single bond', () => {
  const input = {
    reactantAtoms: ['n-r', 'c-r', 'br-r'], productAtoms: ['n-p', 'c-p', 'br-p'],
    atoms: [
      { id: 'n-r', label: 'N', charge: 0 }, { id: 'c-r', label: 'C', charge: 0 },
      { id: 'br-r', label: 'Br', charge: 0 }, { id: 'n-p', label: 'N', charge: 0 },
      { id: 'c-p', label: 'C', charge: 0 }, { id: 'br-p', label: 'Br', charge: 0 },
    ],
    bonds: [{ id: 'c-br', begin: 'c-r', end: 'br-r', order: 1 }, { id: 'n-c-product', begin: 'n-p', end: 'c-p', order: 1 }],
    lonePairs: [{ id: 'lp-n', ownerAtomId: 'n-r' }],
    arrows: [
      { id: 'attack', source: { type: 'lonePair', slotId: 'lp-n', ownerAtomId: 'n-r' }, target: { type: 'formingBond', atomA: 'n-r', atomB: 'c-r' }, electronCount: 2 },
      { id: 'extra', source: { type: 'bond', bondId: 'c-br' }, target: { type: 'atom', atomId: 'n-r' }, electronCount: 2 },
      { id: 'leave', source: { type: 'bond', bondId: 'c-br' }, target: { type: 'atom', atomId: 'br-r' }, electronCount: 2 },
    ],
  };
  // Product has N-C plus a separated bromide; the reactant C-Br bond is removed.
  const result = checkMechanismPreflight(input);
  assert.equal(result.code, 'duplicate_two_electron_target');
  assert.deepEqual(result.arrowIds, ['extra']);
});

test('allows a two-order gain at a second-row bond and reports only proven excess arrows', () => {
  const input = {
    reactantAtoms: ['n-r', 'c-r'], productAtoms: ['n-p', 'c-p'],
    atoms: [
      { id: 'n-r', label: 'N', charge: 0 }, { id: 'c-r', label: 'C', charge: 0 },
      { id: 'n-p', label: 'N', charge: 0 }, { id: 'c-p', label: 'C', charge: 0 },
    ],
    bonds: [{ id: 'n-c-product', begin: 'n-p', end: 'c-p', order: 2 }], lonePairs: [],
    arrows: [
      { id: 'pair1', source: { type: 'atom', atomId: 'n-r' }, target: { type: 'formingBond', atomA: 'n-r', atomB: 'c-r' }, electronCount: 2 },
      { id: 'pair2', source: { type: 'atom', atomId: 'c-r' }, target: { type: 'formingBond', atomA: 'c-r', atomB: 'n-r' }, electronCount: 2 },
    ],
  };
  assert.equal(checkMechanismPreflight(input), null);
  input.bonds = [{ id: 'n-c-product', begin: 'n-p', end: 'c-p', order: 1 }];
  input.atoms[2].charge = 1;
  input.atoms[3].charge = -1;
  const result = checkMechanismPreflight(input);
  assert.equal(result.code, 'duplicate_two_electron_target');
  assert.deepEqual(result.arrowIds, ['pair2']);
  input.arrows = [input.arrows[0]];
  assert.equal(checkMechanismPreflight(input), null);
});

test('flags isolated hydride only in explicitly labeled dithionite conditions', () => {
  const input = {
    reactantAtoms: ['h', 's'], productAtoms: ['h', 's'],
    atoms: [{ id: 'h', label: 'H', charge: -1 }, { id: 's', label: 'S', charge: 0 }],
    bonds: [], lonePairs: [],
    arrows: [{ id: 'hydride', source: { type: 'atom', atomId: 'h' }, target: { type: 'atom', atomId: 's' }, electronCount: 2 }],
    conditions: 'Na₂S₂O₄ in water',
  };
  assert.equal(checkMechanismPreflight(input).code, 'isolated_hydride_dithionite_source');
  input.arrows[0].source = { type: 'lonePair', slotId: 'lp-h', ownerAtomId: 'h' };
  input.lonePairs = [{ id: 'lp-h', ownerAtomId: 'h' }];
  input.conditions = 'Na₂S₂O₄ in water';
  assert.equal(checkMechanismPreflight(input).code, 'isolated_hydride_dithionite_source');
  input.conditions = 'Na₂S₂O₄ and sodium borohydride';
  assert.equal(checkMechanismPreflight(input), null);
  input.conditions = 'aqueous base';
  assert.equal(checkMechanismPreflight(input), null);
  input.conditions = 'sodium dithionite';
  input.bonds.push({ id: 'hs', begin: 'h', end: 's', order: 1 });
  assert.equal(checkMechanismPreflight(input), null);
});
