'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { validateOperations, dependencyOrder, makeExplicitHydrogenPlan } = require('../workbench/agent-bridge.js');
const sample = () => ({ parentAtomId: 'O', atoms: [{ id: 'O', label: 'O', implicitH: 1, implicitHCount: 1, charge: 0 },
  { id: 'C', label: 'C', implicitH: 3, charge: 0 }], bonds: [{ begin: 'O', end: 'C', order: 1 }] });
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
test('makeExplicit is a bounded one-H semantic operation with no numeric-count or placement controls', () => {
  const op = { id: 'expose', type: 'hydrogen.makeExplicit', parentAtomId: 'O' };
  assert.deepEqual(validateOperations([op]), [op]);
  for (const extra of [{ count: 2 }, { x: 1 }, { implicitHCount: 0 }, { parentAtomId: '' }])
    rejects(() => validateOperations([{ ...op, ...extra }]), 'invalid_operation');
  const ops = [{ id: 'orient', type: 'molecule.move', target: { atoms: ['expose:1'] }, orientTowardAtomId: 'host:2' },
    { ...op, parentAtomId: 'host:1' }, { id: 'host', type: 'molecule.add', smiles: 'CO' },
    { id: 'release', type: 'arrow.add', source: { type: 'bond', bondId: 'expose:bond:1', component: 'sigma' }, target: { type: 'atom', atomId: 'host:1' }, electronCount: 2 }];
  assert.deepEqual(dependencyOrder(validateOperations(ops)).map(o => o.id), ['host', 'expose', 'orient', 'release']);
});
test('one existing implicit H becomes one closed-shell explicit H without changing total H or charge', () => {
  for (const [label, count, charge] of [['O', 1, 0], ['O', 2, 1], ['N', 2, 0], ['C', 3, 0]]) {
    const data = sample(); Object.assign(data.atoms[0], { label, implicitH: count, implicitHCount: count, charge });
    const saved = structuredClone(data), plan = makeExplicitHydrogenPlan(data);
    assert.deepEqual(data, saved); assert.equal(plan.implicitBefore, count); assert.equal(plan.implicitAfter, count - 1);
    assert.equal(plan.hydrogenTotalBefore, count + 3); assert.equal(plan.hydrogenTotalAfter, plan.hydrogenTotalBefore);
    assert.equal(data.atoms[0].charge, charge);
    data.atoms[0].implicitHCount = null; assert.equal(makeExplicitHydrogenPlan(data).implicitHCountBefore, null);
  }
});
test('no-H, unsupported/query/aromatic/radical hosts and missing references reject before native edits', () => {
  const noH = sample(); noH.atoms[0].implicitH = 0;
  rejects(() => makeExplicitHydrogenPlan(noH), 'hydrogen_explicit_none');
  for (const changed of [{ label: 'H' }, { label: 'S' }, { hasQuery: true }, { alias: 'R' }, { aromatic: true }, { radical: 2 }]) {
    const data = sample(); Object.assign(data.atoms[0], changed);
    rejects(() => makeExplicitHydrogenPlan(data), 'hydrogen_explicit_unsupported');
  }
  const missing = sample(); missing.parentAtomId = 'deleted'; rejects(() => makeExplicitHydrogenPlan(missing), 'missing_reference');
});
test('defined parent stereo, enhanced groups and any incident wedge fence explicitization', () => {
  for (const change of [d => { d.atoms[0].stereoParity = 1; }, d => { d.atoms[0].stereoLabel = 'abs'; },
    d => { d.stereoAtomIds = ['O']; }, d => { d.bonds[0].stereo = 6; }]) {
    const data = sample(); change(data); rejects(() => makeExplicitHydrogenPlan(data), 'hydrogen_explicit_stereo');
  }
});
