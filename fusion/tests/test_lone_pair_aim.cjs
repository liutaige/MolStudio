'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOperations, resolveLonePairAimTarget } = require('../workbench/agent-bridge.js');
const edit = extra => ({ id: 'aim-lp', type: 'lonePair.modify', lonePairId: 'lp-existing', ...extra });
const lp = { id: 'lp-existing', ownerAtomId: 'donor' };
const ctx = { atomPos: id => ['donor', 'carbon', 'other'].includes(id) ? { x: 1, y: 0 } : null };
const arrow = target => ({ source: { type: 'lonePair', slotId: lp.id, ownerAtomId: lp.ownerAtomId }, target });

test('lone pair aiming extends the existing angle contract without ambiguous inputs', () => {
  for (const extra of [{ angle: 90 }, { aim: 'auto' }, { aim: 'manual' }, { aim: 'manual', angle: 180 }]) {
    assert.deepEqual(validateOperations([edit(extra)]), [edit(extra)]);
  }
  for (const extra of [{}, { aim: 'auto', angle: 90 }, { aim: 'sideways' }, { aim: null },
    { aim: 'manual', angle: Infinity }, { aim: 'auto', refAtomId: 'carbon' }]) {
    assert.throws(() => validateOperations([edit(extra)]), error => error.code === 'invalid_operation');
  }
});

test('automatic aim resolves atom and donor-to-acceptor forming-bond targets', () => {
  const direct = arrow({ type: 'atom', atomId: 'carbon' });
  const forming = arrow({ type: 'formingBond', atomA: 'donor', atomB: 'carbon' });
  assert.equal(resolveLonePairAimTarget(lp, [direct], ctx), direct);
  assert.equal(resolveLonePairAimTarget(lp, [forming], ctx), forming);
  assert.equal(resolveLonePairAimTarget(lp, [direct, forming], ctx), direct,
    'several existing arrows may agree on the same attacked atom');
});

test('automatic aim rejects absent, deleted and conflicting targets explicitly', () => {
  const missing = [[], [arrow({ type: 'atom', atomId: 'deleted' })], [arrow({ type: 'atom', atomId: 'donor' })]];
  for (const arrows of missing) assert.throws(() => resolveLonePairAimTarget(lp, arrows, ctx),
    error => error.code === 'lone_pair_aim_target_missing');
  for (const arrows of [[arrow({ type: 'atom', atomId: 'carbon' }), arrow({ type: 'atom', atomId: 'other' })],
    [arrow({ type: 'formingBond', atomA: 'carbon', atomB: 'other' })]]) {
    assert.throws(() => resolveLonePairAimTarget(lp, arrows, ctx), error => error.code === 'lone_pair_aim_target_conflict');
  }
});
