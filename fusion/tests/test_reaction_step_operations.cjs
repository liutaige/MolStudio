'use strict';
// Pure operation-contract checks; current canvas bridge, no model or editor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOperations, dependencyOrder } = require('../workbench/agent-bridge.js');

const create = (extra = {}) => ({ id: 'create-step', type: 'reactionStep.create',
  reactants: ['substrate:1'], products: ['product:1'], ...extra });
const modify = (extra = {}) => ({ id: 'modify-step', type: 'reactionStep.modify',
  stepId: 'rs-00112233-4455-6677-8899-aabbccddeeff', expectedVersion: 1,
  layout: { conditions: 'heat' }, ...extra });
const remove = (extra = {}) => ({ id: 'delete-step', type: 'reactionStep.delete',
  stepId: 'rs-00112233-4455-6677-8899-aabbccddeeff', expectedVersion: 2, ...extra });
const reject = op => assert.throws(() => validateOperations([op]), error => error.code === 'invalid_operation');
const order = ops => dependencyOrder(validateOperations(ops)).map(op => op.id);

test('terminal-H orientation waits for both target and acceptor atom aliases in the batch', () => {
  const orient = { id: 'orient', type: 'molecule.move', target: { atoms: ['water:2'] }, orientTowardAtomId: 'probe:acceptor:1' };
  const water = { id: 'water', type: 'molecule.add', smiles: '[OH:1][H:2]' };
  const acceptor = { id: 'probe:acceptor', type: 'molecule.add', smiles: '[OH-:1]' };
  assert.deepEqual(order([orient, water, acceptor]), ['water', 'probe:acceptor', 'orient']);
  assert.deepEqual(order([{ ...orient, target: { atoms: ['existing-H'] } }, acceptor]), ['probe:acceptor', 'orient']);
  assert.throws(() => dependencyOrder([{ ...orient, orientTowardAtomId: 'orient:1' }]), /自身/);
});

test('semantic step operations require explicit optimistic versions only when editing or deleting', () => {
  assert.deepEqual(validateOperations([create(), modify(), remove()]), [create(), modify(), remove()]);
  for (const factory of [modify, remove]) {
    for (const expectedVersion of [undefined, null, false, '1', 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      reject(factory({ expectedVersion }));
    }
    for (const stepId of [undefined, null, '', 1, 'step with space', 'x'.repeat(161), '__proto__', 'constructor', 'prototype']) {
      reject(factory({ stepId }));
    }
    assert.equal(validateOperations([factory({ expectedVersion: Number.MAX_SAFE_INTEGER })]).length, 1);
  }
  reject(create({ expectedVersion: 1 }));
  reject(create({ stepId: 'host-owned-id' }));
});

test('step modifications carry a change and deletes cannot smuggle participant or layout edits', () => {
  reject({ id: 'empty-edit', type: 'reactionStep.modify', stepId: 'rs-existing', expectedVersion: 1 });
  assert.equal(validateOperations([modify({ layout: {} })]).length, 1);
  for (const extra of [{ products: ['new:1'] }, { reactants: ['new:1'] }, { layout: {} }, { x: 1 }]) reject(remove(extra));
  reject(modify({ unexpected: true }));
});

test('step conditions are bounded single lines and only modifications may explicitly clear them', () => {
  for (const factory of [create, modify]) {
    for (const conditions of [null, 1, {}, 'x'.repeat(65), 'hot\ncold', 'hot\rcold', 'hot\tcold', 'hot\u0000cold']) {
      reject(factory({ layout: { conditions } }));
    }
    assert.equal(validateOperations([factory({ layout: { conditions: 'x'.repeat(64) } })]).length, 1);
  }
  reject(create({ layout: { conditions: '' } }));
  reject(create({ layout: { conditions: '   ' } }));
  assert.equal(validateOperations([modify({ layout: { conditions: '' } })]).length, 1);
});

test('step layout declarations reject unknown, wrongly typed and unsupported positioning values', () => {
  for (const factory of [create, modify]) {
    for (const layout of [null, [], 'vertical', { reactantPlacement: 'diagonal' }, { breakBefore: 1 },
      { breakBefore: 'true' }, { unknown: true }, { x: 0 }, { rowY: 1 }]) reject(factory({ layout }));
    for (const reactantPlacement of ['auto', 'horizontal', 'vertical']) {
      assert.equal(validateOperations([factory({ layout: { reactantPlacement, breakBefore: false } })]).length, 1);
    }
  }
});

test('step participants use nonempty bounded distinct references and disjoint sides', () => {
  for (const factory of [create, modify]) {
    for (const products of [undefined, null, [], ['same', 'same'], ['bad reference'], ['__proto__'],
      Array.from({ length: 17 }, (_, i) => 'product-' + i), ['p'.repeat(161)]]) {
      reject(factory({ products }));
    }
    assert.equal(validateOperations([factory({ products: Array.from({ length: 16 }, (_, i) => 'product-' + i) })]).length, 1);
    reject(factory({ reactants: ['same:1'], products: ['same:1'] }));
  }
});

test('semantic operation envelopes retain maximum batch and duplicate-id limits', () => {
  const batch = Array.from({ length: 40 }, (_, i) => modify({ id: 'edit-' + i }));
  assert.equal(validateOperations(batch).length, 40);
  assert.throws(() => validateOperations([...batch, modify({ id: 'edit-40' })]));
  assert.throws(() => validateOperations([modify(), modify()]));
  reject(modify({ id: '__proto__' }));
});

test('new step declarations sort after forward-referenced molecules and before their alias edits', () => {
  const ops = [modify({ stepId: 'create-step', products: ['replacement:1'] }), create(),
    { id: 'product', type: 'molecule.add', smiles: 'CO' },
    { id: 'substrate', type: 'molecule.add', smiles: 'CBr' },
    { id: 'replacement', type: 'molecule.add', smiles: 'CCl' }];
  const ids = order(ops);
  for (const id of ['substrate', 'product']) assert.ok(ids.indexOf(id) < ids.indexOf('create-step'));
  assert.ok(ids.indexOf('create-step') < ids.indexOf('modify-step'));
  assert.ok(ids.indexOf('replacement') < ids.indexOf('modify-step'));
});

test('multiple updates of the same stable step preserve input order around forward molecule dependencies', () => {
  const ops = [modify({ id: 'edit-first', products: ['replacement:1'] }),
    modify({ id: 'edit-second', expectedVersion: 2, layout: { conditions: 'cold' } }),
    remove({ id: 'delete-last', expectedVersion: 3 }),
    { id: 'replacement', type: 'molecule.add', smiles: 'CCl' }];
  assert.deepEqual(order(ops), ['replacement', 'edit-first', 'edit-second', 'delete-last']);
});

test('a stable step ID remains literal when it also names an edit or an unrelated batch operation', () => {
  const stableId = 'rs-existing';
  assert.deepEqual(order([modify({ id: stableId, stepId: stableId })]), [stableId]);
  assert.deepEqual(order([modify({ id: 'edit-first', stepId: stableId }),
    { id: stableId, type: 'text.add', text: 'unrelated' }]), ['edit-first', stableId]);
});
