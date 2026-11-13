'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewedChemistryPreserved } = require('./agent_hydrogen_representation_audit.cjs');

const seed = () => ({ atoms: [{ id: 'c', label: 'C', charge: 0, radical: 0, implicitH: 2 },
  { id: 'o', label: 'O', charge: 0, radical: 0, implicitH: 1 }, { id: 'old-h', label: 'H', charge: 0, radical: 0, implicitH: 0 }],
  bonds: [{ id: 'co', begin: 'c', end: 'o', order: 1 }, { id: 'ch', begin: 'c', end: 'old-h', order: 1 }],
  molecules: [{ id: 'm', atoms: ['c', 'o', 'old-h'] }], lonePairs: [{ id: 'lp', ownerAtomId: 'o', electronCount: 2 }],
  arrows: [{ id: 'flow', source: { type: 'lonePair', ownerAtomId: 'o', slotId: 'lp' }, target: { type: 'atom', atomId: 'c' }, electronCount: 2 }],
  reactionSteps: [{ stepId: 'step', reactants: ['o'], products: ['c'], conditions: 'original' }] });
const shown = () => { const c = seed(); c.atoms[1].implicitH = 0;
  c.atoms.push({ id: 'new-h', label: 'H', charge: 0, radical: 0, implicitH: 0 });
  c.bonds.push({ id: 'oh', begin: 'o', end: 'new-h', order: 1, nativeType: 1, stereo: 0 }); c.molecules[0].atoms.push('new-h'); return c; };
const receipt = () => ({ success: true, created: [{ id: 'show', type: 'hydrogen.makeExplicit', parentAtomId: 'o',
  implicitBefore: 1, implicitAfter: 0, hydrogenTotalBefore: 4, hydrogenTotalAfter: 4,
  atoms: [{ ref: '1', id: 'new-h', label: 'H' }], bonds: [{ ref: '1', id: 'oh', begin: 'o', end: 'new-h' }] }] });

test('a confirmed makeExplicit receipt preserves reviewed chemistry while exposing exactly the same H', () => {
  const a = seed(), b = shown(), original = structuredClone(b), result = reviewedChemistryPreserved(a, b, [receipt()]);
  assert.equal(result.pass, true); assert.equal(result.materializations.length, 1);
  assert.deepEqual(b, original); assert.equal(result.context.atoms.find(x => x.id === 'o').implicitH, 1);
});
test('native tool_end success can confirm the real probe receipt without a synthetic success flag', () => {
  const r = receipt(); delete r.success; r.runId = 'run'; r.at = 'time';
  const events = [{ type: 'tool_end', toolName: 'draw_operations', isError: false, runId: 'run', at: 'time' }];
  assert.equal(reviewedChemistryPreserved(seed(), shown(), [r], events).pass, true);
  for (const change of [{ isError: true }, { runId: 'other' }, { at: 'other' }]) {
    assert.equal(reviewedChemistryPreserved(seed(), shown(), [r], [{ ...events[0], ...change }]).pass, false);
  }
});
test('an absent or failed receipt cannot explain an added H', () => {
  assert.equal(reviewedChemistryPreserved(seed(), shown()).pass, false);
  assert.equal(reviewedChemistryPreserved(seed(), shown(), [{ ...receipt(), success: false }]).pass, false);
});
test('extra H, real protonation, wrong parent and nonordinary H are rejected', () => {
  for (const mutate of [c => { c.atoms[1].implicitH = 1; }, c => { c.atoms[1].charge = 1; },
    c => { c.bonds[2].begin = 'c'; }, c => { c.atoms[3].radical = 2; }, c => { c.atoms[3].charge = 1; },
    c => { c.atoms[3].isotope = 2; }, c => { c.bonds[2].order = 2; }, c => { c.bonds[2].stereo = 1; },
    c => { c.atoms.push({ id: 'extra', label: 'H', implicitH: 0 }); c.bonds.push({ id: 'extra-bond', begin: 'o', end: 'extra', order: 1 }); c.molecules[0].atoms.push('extra'); }]) {
    const c = shown(); mutate(c); assert.equal(reviewedChemistryPreserved(seed(), c, [receipt()]).pass, false);
  }
});
test('old heavy bonds, old H owners, charges, flow endpoints and step chemistry remain protected', () => {
  for (const mutate of [c => { c.bonds[0].order = 2; }, c => { c.bonds[1].begin = 'o'; },
    c => { c.atoms[0].charge = -1; }, c => { c.arrows[0].target.atomId = 'new-h'; },
    c => { c.reactionSteps[0].products = ['new-h']; }, c => { c.reactionSteps[0].conditions = 'changed'; },
    c => { c.atoms.splice(2, 1); }]) {
    const c = shown(); mutate(c); assert.equal(reviewedChemistryPreserved(seed(), c, [receipt()]).pass, false);
  }
});
test('receipt count conservation and single-H cardinality are mandatory', () => {
  for (const mutate of [r => { r.created[0].hydrogenTotalAfter = 5; }, r => { r.created[0].implicitAfter = 1; },
    r => { r.created[0].implicitBefore = 2; }, r => { r.created[0].atoms.push({ id: 'another' }); }]) {
    const r = receipt(); mutate(r); assert.equal(reviewedChemistryPreserved(seed(), shown(), [r]).pass, false);
  }
});
test('new chemistry outside the reviewed entities and rigid layout moves remain allowed', () => {
  const c = shown(); c.atoms.forEach((a, i) => { a.x = i + 100; a.y = 20; });
  c.atoms.push({ id: 'later-c', label: 'C', implicitH: 4 }); c.molecules.push({ id: 'later', atoms: ['later-c'] });
  c.reactionSteps.push({ stepId: 'later-step', reactants: ['c'], products: ['later-c'] });
  assert.equal(reviewedChemistryPreserved(seed(), c, [receipt()]).pass, true);
});
