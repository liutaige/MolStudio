'use strict';
// Actual quadratic-curve metrics; no DOM, native engine or model requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
const R = globalThis.MolWorkbench.route;
const scene = () => ({ L: 1, labels: [], bonds: [], lonePairs: [], arrows: [] });
const near = (a, b) => Math.abs(a - b) < 1e-6;

test('the real caffeine U is unreadable despite a clear collision-free curve', () => {
  const geometry = { start: { x: 19.57313965328736, y: 16.292304281325006 },
    control: { x: 17.165145803101588, y: 22.941767999949935 },
    end: { x: 13.883549623992293, y: 16.992673883307482 }, sourceOk: true, targetOk: true };
  const metrics = R.assessReadability({ ...geometry, L: 1, intermolecular: true });
  assert.equal(metrics.readable, false);
  assert.ok(near(metrics.chord, 5.732534542489468));
  assert.ok(near(metrics.length, 8.92318768483502));
  assert.ok(near(metrics.sag, 3.157202485564531));
  assert.deepEqual(metrics.reasons, ['intermolecular_span', 'curve_sag']);
  const plan = R.planArrow({ a: geometry.start, b: geometry.end, scene: scene(),
    intermolecular: true, fixedGeometry: geometry });
  assert.equal(plan.feasible, true, 'collision clearance is a separate assessment');
  assert.equal(plan.readable, false);
  assert.equal(plan.note, 'unreadable');
  assert.equal(plan.ranked.length, 1, 'fixed assessment never substitutes another curve');
  assert.deepEqual(plan.readability, metrics);
});

test('a short release arc with bend two stays readable while excessive local sag does not', () => {
  const start = { x: 0, y: 0 }, end = { x: 0.5, y: 0 };
  const release = R.assessReadability({ start, end, control: R.controlOf(start, end, 2), L: 1 });
  assert.equal(release.readable, true);
  assert.ok(release.length < 1.2);
  assert.equal(release.sag, 0.5);
  const loop = R.assessReadability({ start, end, control: { x: 0.25, y: 4 }, L: 1 });
  assert.equal(loop.readable, false);
  assert.deepEqual(loop.reasons, ['curve_length', 'curve_sag']);
});

test('a long intermolecular span fails even when straight, using scene atom connectivity', () => {
  const a = { x: 0, y: 0 }, b = { x: 4.6, y: 0 };
  const input = { a, b, scene: scene(), source: { type: 'lonePair', ownerAtomId: 'n' },
    target: { type: 'formingBond', atomA: 'n', atomB: 'c' } };
  const plan = R.planArrow(input);
  assert.equal(plan.readable, false);
  assert.equal(plan.note, 'unreadable');
  assert.ok(plan.ranked.every(candidate => candidate.readability.reasons.includes('intermolecular_span')));
  const connected = scene();
  connected.bonds.push({ id: 'nc', atomIds: ['n', 'c'], a: { x: 100, y: 100 }, b: { x: 101, y: 100 } });
  assert.equal(R.planArrow({ ...input, scene: connected }).readable, true,
    'the span limit applies to distinct molecules rather than all long chords');
  assert.equal(R.planArrow({ ...input, intermolecular: false }).readable, true);
});

test('readable curves rank before a giant clear U even when clear-arrow preference is enabled', () => {
  const obstacles = scene();
  obstacles.arrows.push({ points: [{ x: 1.45, y: -1.2 }, { x: 1.45, y: 1.2 }], length: 2.4 });
  const plan = R.planArrow({ a: { x: 0, y: 0 }, b: { x: 3, y: 0 }, scene: obstacles,
    preferClearArrows: true, opts: { heights: [0.5, 2], chordFractions: [] } });
  assert.equal(plan.feasible, true);
  assert.equal(plan.readable, true);
  assert.equal(plan.ranked[0].arrowHits, 1);
  const giant = plan.ranked.find(candidate => !candidate.readable && !candidate.arrowHits);
  assert.ok(giant, 'a collision-free but unreadable escape candidate must exist');
  const reordered = { ...plan, ranked: plan.ranked.map(candidate => candidate === giant
    ? { ...candidate, score: plan.score + 1 } : candidate) };
  assert.equal(R.chooseWithHysteresis(reordered, giant.bend).bend, plan.bend,
    'preview hysteresis cannot restore the unreadable former route');
});

test('readability uses physical bond units and rejects malformed geometry', () => {
  const input = { start: { x: 0, y: 0 }, control: { x: 2.5, y: 0.5 }, end: { x: 5, y: 0 }, L: 1, intermolecular: true };
  const first = R.assessReadability(input);
  const scaled = R.assessReadability({ ...input, L: 10,
    ...Object.fromEntries(['start', 'control', 'end'].map(key => [key, { x: input[key].x * 10, y: input[key].y * 10 }])) });
  assert.equal(scaled.readable, first.readable);
  assert.deepEqual(scaled.reasons, first.reasons);
  for (const metric of ['chord', 'length', 'sag']) assert.ok(near(scaled[metric] / 10, first[metric]));
  assert.equal(R.assessReadability({ ...input, control: { x: NaN, y: 0 } }).readable, false);
});

test('planning uses the conservative glyph envelope without changing the live hit box', () => {
  const live = { x1: 1.4, y1: 0.14, x2: 1.6, y2: 0.28 };
  const envelope = { x1: 1.35, y1: -0.2, x2: 1.65, y2: 0.3 };
  const box = { hasLabel: true, rect: live, planningRect: envelope, hwCss: 4, hhCss: 2.8 };
  const ctx = { atoms: () => [{ uuid: 'oxygen', label: 'O', pos: { x: 1.5, y: 0.2 } }],
    atomLabelBox: (id, options) => { assert.equal(id, 'oxygen'); assert.equal(typeof options.planning, 'boolean'); return box; }, unit: () => 0.025 };
  const obstacle = R.buildScene(ctx);
  assert.deepEqual(obstacle.labels[0].rect, envelope);
  assert.ok(near(obstacle.labels[0].hw, 0.15));
  assert.deepEqual(box.rect, live);
  assert.deepEqual(R.buildScene(ctx, null, { planning: false }).labels[0].rect, live, 'fixed-curve diagnostics assess the actual glyph rather than an envelope from another scale');
  const geometry = { start: { x: 0, y: 0 }, control: { x: 1.5, y: 0 }, end: { x: 3, y: 0 }, sourceOk: true, targetOk: true };
  const collision = R.planArrow({ a: geometry.start, b: geometry.end, scene: obstacle, fixedGeometry: geometry });
  assert.equal(collision.feasible, false, 'the envelope still rejects a real collision');
  assert.deepEqual(collision.collisions.labels, ['oxygen']);
  box.planningRect = { ...envelope, x1: NaN };
  assert.deepEqual(R.buildScene(ctx).labels[0].rect, live, 'unavailable envelope preserves live measurement fallback');
});

test('one bend must remain readable and collision-free for every endpoint geometry', () => {
  const a = { x: 0, y: 0 }, b = { x: 3, y: 0 };
  const straight = { start: a, end: b, control: { x: 1.5, y: 0 }, sourceOk: true, targetOk: true };
  const loop = { ...straight, control: { x: 1.5, y: 8 } };
  // This fixture isolates upper readability limits across endpoint variants;
  // the deliberately straight primary geometry is a manual diagnostic.
  const input = { a, b, scene: scene(), geometry: () => straight, requireCurvature: false,
    geometryVariants: [() => loop] };
  const plan = R.planArrow(input);
  assert.equal(plan.feasible, true);
  assert.equal(plan.readable, false);
  assert.equal(plan.note, 'unreadable');
  assert.equal(plan.ranked[0].geometryCount, 2);
  assert.equal(R.planArrow({ ...input, fixedGeometry: straight }).readable, true,
    'read-only checks still assess only the curve actually being drawn');
  const obstacles = scene();
  obstacles.labels.push({ atomId: 'o', rect: { x1: 1.4, y1: 0.9, x2: 1.6, y2: 1.1 } });
  const touching = { ...straight, control: { x: 1.5, y: 2 } };
  assert.equal(R.planArrow({ ...input, scene: obstacles, geometryVariants: [() => touching] }).feasible, false,
    'a candidate clear in the first geometry cannot conceal a collision in another');
  const one = R.planArrow({ ...input, scene: obstacles, geometryVariants: [() => touching], onlyBend: 0.5 });
  assert.equal(one.count, 1, 'checking the persisted bend does not search a fresh grid');
  assert.equal(one.refinementCount, 0);
  assert.equal(one.feasible, false, 'the fast preservation check still rejects another reading geometry');
});
