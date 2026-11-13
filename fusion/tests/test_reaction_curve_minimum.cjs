'use strict';
// Main canvas shared route/controller, synthetic native-like glyph fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
require('../workbench/mechanism-controller.js');
const M = globalThis.MolWorkbench.model, R = globalThis.MolWorkbench.route;
const fixture = require('./fixtures/ethoxide-amide-proton-transfer.cjs');

function assess(arrow, ctx, automatic = M.arrowMode(arrow) === 'auto') {
  const geometry = M.arrowGeometry(arrow, ctx), scene = R.buildScene(ctx);
  return R.planArrow({ a: geometry.routingStart, b: geometry.routingEnd, scene,
    source: arrow.source, target: arrow.target, fixedGeometry: geometry, requireCurvature: automatic });
}

test('automatic readability measures perpendicular curvature, not a shifted control point along a straight chord', () => {
  const straight = { start: { x: 0, y: 0 }, control: { x: 0.8, y: 0 }, end: { x: 4, y: 0 }, L: 1 };
  const automatic = R.assessReadability({ ...straight, requireCurvature: true });
  assert.ok(automatic.sag > 0.5, 'longitudinal control shift must not masquerade as curvature');
  assert.equal(automatic.normalSag, 0); assert.ok(automatic.reasons.includes('curve_flat'));
  assert.equal(R.assessReadability(straight).readable, true, 'explicit manual straight geometry remains allowed');
});

test('ethoxide LP to amide H is repaired from a flat automatic curve alongside the N-H sigma return', () => {
  const f = fixture();
  assert.equal(assess(f.attack, f.ctx).feasible, true);
  assert.deepEqual(assess(f.attack, f.ctx).readability.reasons, ['curve_flat']);
  const release = f.controller.replanArrowInPlace(f.release, false);
  const attack = f.controller.replanArrowInPlace(f.attack, false);
  for (const plan of [release, attack]) { assert.equal(plan.feasible, true); assert.equal(plan.readable, true); }
  for (const arrow of [f.attack, f.release]) {
    const actual = assess(arrow, f.ctx);
    assert.equal(actual.feasible, true); assert.equal(actual.readable, true);
    assert.deepEqual(actual.collisions, { labels: [], bonds: [] });
    assert.ok(actual.readability.normalSag >= actual.readability.limits.minSag - 1e-9);
    assert.ok(actual.readability.sag <= actual.readability.limits.sag);
  }
  assert.ok(assess(f.attack, f.ctx).readability.normalSag > 0.25, 'the long transfer needs a visible arc, not just a nonzero bend');
});

test('automatic curvature remains readable without glyph/bond collisions across short/long ranges, reading zoom and saved geometry', () => {
  for (const distance of [2, 3, 4, 4.5]) {
    const f = fixture({ distance });
    f.controller.replanArrowInPlace(f.release, false);
    const result = f.controller.replanArrowInPlace(f.attack, false);
    assert.equal(result.feasible, true, 'fixture distance ' + distance); assert.equal(result.readable, true);
    const saved = JSON.parse(JSON.stringify(M.serializeMechanism(f.model.state)));
    const reopened = new M.MechanismModel(saved);
    for (const zoom of [0.41, 0.54, 1, 1.5, 2]) for (const arrow of reopened.state.arrows) {
      const actual = assess(arrow, f.contextAtZoom(zoom));
      assert.equal(actual.feasible, true, `distance ${distance}, zoom ${zoom}, arrow ${arrow.id}`);
      assert.equal(actual.readable, true, `distance ${distance}, zoom ${zoom}, arrow ${arrow.id}`);
      assert.deepEqual(actual.collisions, { labels: [], bonds: [] });
    }
    assert.deepEqual(M.serializeMechanism(reopened.state), saved, 'zoom/read-only checks do not mutate saved curves');
  }
});

test('a prior valid automatic arc is kept, manual bend zero is preserved, and route metrics scale with coordinates', () => {
  const f = fixture(); f.controller.replanArrowInPlace(f.attack, false);
  const before = JSON.stringify(f.attack.geometry);
  assert.equal(f.controller.replanArrowInPlace(f.attack, false).readable, true);
  assert.equal(JSON.stringify(f.attack.geometry), before);
  f.attack.geometry.mode = 'manual'; f.attack.geometry.bend = 0;
  assert.equal(f.controller.replanArrowInPlace(f.attack, false), null);
  assert.equal(f.attack.geometry.bend, 0); assert.equal(assess(f.attack, f.ctx).readable, true);
  const geometry = { start: { x: 0, y: 0 }, control: { x: 2, y: 0.9 }, end: { x: 4, y: 0 }, L: 1, requireCurvature: true };
  const original = R.assessReadability(geometry);
  const scaled = R.assessReadability({ ...geometry, L: 8,
    ...Object.fromEntries(['start', 'control', 'end'].map(key => [key, { x: geometry[key].x * 8 + 100, y: geometry[key].y * 8 - 30 }])) });
  assert.equal(scaled.readable, original.readable);
  assert.ok(Math.abs(scaled.normalSag / 8 - original.normalSag) < 1e-9);
  assert.ok(Math.abs(scaled.limits.minSag / 8 - original.limits.minSag) < 1e-9);
});
