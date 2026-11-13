'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
require('../workbench/mechanism-controller.js');
const MW = globalThis.MolWorkbench;
const replan = MW.controller.MechanismController.prototype.replanArrowInPlace;

for (const [name, plan] of [
  ['collision', { bend: -0.369, feasible: false, readable: true }],
  ['unreadable escape', { bend: 2.5, feasible: true, readable: false }],
]) test(`an automatic ${name} fallback cannot overwrite an existing curve`, () => {
  const arrow = { source: {}, target: {}, electronCount: 2,
    geometry: { bend: -0.5785, mode: 'auto', routeVersion: 4, controlFrame: { preserved: true } } };
  const before = structuredClone(arrow);
  const result = replan.call({ planFor: () => ({ plan }) }, arrow, true);
  assert.deepEqual(arrow, before);
  assert.equal(result.applied, false);
  assert.equal(result.preservedBend, before.geometry.bend);
  assert.equal(result.feasible, plan.feasible);
  assert.equal(result.readable, plan.readable);
});

test('a valid explicit automatic request still applies the planned curve', () => {
  const arrow = { source: {}, target: {}, electronCount: 2,
    geometry: { bend: -0.5785, mode: 'manual', controlFrame: {} } };
  const plan = { bend: -0.6, feasible: true, readable: true };
  assert.equal(replan.call({ planFor: () => ({ plan }) }, arrow, true), plan);
  assert.equal(arrow.geometry.bend, -0.6);
  assert.equal(arrow.geometry.mode, 'auto');
  assert.equal(arrow.geometry.routeVersion, MW.model.ROUTE_VERSION);
  assert.equal('controlFrame' in arrow.geometry, false);
});

test('a non-forced semantic reflow preserves a verified existing bend without a grid search', () => {
  const arrow = { source: {}, target: {}, electronCount: 2, geometry: { bend: -0.5785, mode: 'auto' } };
  const calls = [];
  const plan = { bend: -0.5785, feasible: true, readable: true, ranked: [{ arrowHits: 0, wrongSide: 0 }] };
  replan.call({ planFor: (s, t, n, options) => { calls.push(options); return { plan }; } }, arrow, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].onlyBend, -0.5785);
  assert.equal(arrow.geometry.bend, -0.5785);
});
