'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { validateOperations, orientTerminalHydrogen } = require('../workbench/agent-bridge.js');
const input = () => ({ hydrogenId: 'H', towardAtomId: 'T', atoms: [
  { id: 'H', label: 'H', x: 0, y: 1 }, { id: 'P', label: 'O', x: 0, y: 0 },
  { id: 'T', label: 'O', charge: -1, x: -3, y: 4 }, { id: 'S', label: 'C', x: 2, y: 0 },
], bonds: [{ begin: 'H', end: 'P', order: 1 }, { begin: 'P', end: 'S', order: 1 }] });
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('the existing move accepts only a single-atom orientation mode and keeps numeric modes intact', () => {
  const move = { id: 'orient', type: 'molecule.move', target: { atoms: ['H'] }, orientTowardAtomId: 'T' };
  assert.deepEqual(validateOperations([move])[0], move);
  for (const extra of [{ x: 1, y: 2 }, { dx: 1, dy: 2 }, { dx: 1 }])
    throwsCode(() => validateOperations([{ ...move, ...extra }]), 'invalid_operation');
  for (const target of [{ molecule: 'mol:1' }, { atoms: ['H', 'S'] }])
    throwsCode(() => validateOperations([{ ...move, target }]), 'invalid_operation');
  throwsCode(() => validateOperations([{ ...move, orientTowardAtomId: '' }]), 'invalid_operation');
  assert.equal(validateOperations([{ id: 'old', type: 'molecule.move', target: { molecule: 'mol:1' }, dx: 1, dy: 0 }]).length, 1);
});

test('projection preserves the actual existing bond length, reports its displacement, and is pure and idempotent', () => {
  const data = input(), saved = structuredClone(data), result = orientTerminalHydrogen(data);
  assert.deepEqual(data, saved);
  assert.deepEqual(result.from, { x: 0, y: 1 }); assert.deepEqual(result.to, { x: -0.6, y: 0.8 });
  assert.equal(result.parentAtomId, 'P'); assert.equal(result.towardAtomId, 'T');
  assert.equal(result.bondLengthBefore, 1); assert.equal(result.bondLengthAfter, 1);
  assert.deepEqual(result.displacement, { dx: -0.6, dy: -0.19999999999999996 });
  Object.assign(data.atoms[0], result.to);
  assert.deepEqual(orientTerminalHydrogen(data).to, result.to);
  data.atoms[1].label = 'N'; assert.equal(orientTerminalHydrogen(data).parentAtomId, 'P');
});

test('only ordinary terminal hydrogens with one single O/N bond can be oriented', () => {
  for (const property of [{ label: 'C' }, { isotope: 2 }, { charge: 1 }, { radical: 1 }, { hasQuery: true }, { alias: 'D' }]) {
    const data = input(); Object.assign(data.atoms[0], property);
    throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_unsupported');
  }
  for (const change of [d => { d.bonds = []; }, d => d.bonds.push({ begin: 'H', end: 'S', order: 1 }),
    d => { d.bonds[0].order = 2; }, d => { d.bonds[0].aromatic = true; }, d => { d.atoms[1].label = 'C'; }]) {
    const data = input(); change(data); throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_unsupported');
  }
});

test('related parity, enhanced stereo and any parent wedge are fenced even when the H bond is plain', () => {
  for (const change of [d => { d.atoms[0].stereoParity = 1; }, d => { d.atoms[1].stereoLabel = 'R'; },
    d => { d.atoms[1].stereoGroup = 1; }, d => { d.stereoAtomIds = ['P']; }, d => { d.stereoAtomIds = ['H']; },
    d => { d.bonds[1].stereo = 1; }, d => { d.atoms[1].label = 'C'; d.bonds[1].stereo = 6; }]) {
    const data = input(); change(data); throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_stereo');
  }
  const data = input(); data.atoms[3].stereoLabel = 'R'; data.stereoAtomIds = ['S'];
  assert.equal(orientTerminalHydrogen(data).bondLengthAfter, 1, 'unmoved remote stereo is preserved and does not block an O-H orientation');
});

test('self, parent and coincident target vectors are rejected explicitly', () => {
  for (const target of ['H', 'P']) { const data = input(); data.towardAtomId = target;
    throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_target_invalid'); }
  const data = input(); Object.assign(data.atoms[2], { x: 0, y: 0 });
  throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_target_invalid');
});

test('missing references and invalid original geometry cannot manufacture a replacement bond length', () => {
  const data = input(); data.atoms[0].y = 0;
  throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_geometry_invalid');
  data.atoms[0].y = NaN; throwsCode(() => orientTerminalHydrogen(data), 'hydrogen_orientation_geometry_invalid');
  data.atoms[0].y = 1; data.towardAtomId = 'missing'; throwsCode(() => orientTerminalHydrogen(data), 'missing_reference');
});
