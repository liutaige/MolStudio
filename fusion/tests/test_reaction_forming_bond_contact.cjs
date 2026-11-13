'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
const R = globalThis.MolWorkbench.route;
const geometry = { start: { x: -0.5, y: 0.5 }, control: { x: 0.8, y: 1 }, end: { x: 0.75, y: 0 } };
const bonds = [
  { id: 'source', atomIds: ['s', 'a'], a: { x: -1, y: 0.5 }, b: { x: 0, y: 0.5 } },
  { id: 'target', atomIds: ['a', 'b'], a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  { id: 'neighbour', atomIds: ['b', 'c'], a: { x: 1, y: 0 }, b: { x: 2, y: 0 } },
];
const point = (p, dx, dy) => ({ x: p.x + dx, y: p.y + dy });
function assess(g = geometry, target = { type: 'formingBond', atomA: 'a', atomB: 'b' }, dx = 0, dy = 0) {
  const shifted = Object.fromEntries(Object.entries(g).map(([key, p]) => [key, point(p, dx, dy)]));
  shifted.sourceOk = true; shifted.targetOk = true;
  const scene = { L: 1, labels: [], lonePairs: [], arrows: [], bonds: bonds.map(b =>
    ({ ...b, a: point(b.a, dx, dy), b: point(b.b, dx, dy) })) };
  return R.planArrow({ a: shifted.start, b: shifted.end, scene, source: { type: 'bond', bondId: 'source' }, target,
    electronCount: 2, fixedGeometry: shifted });
}

test('formingBond on an existing sigma bond has the same local end contact as a bond target', () => {
  assert.equal(assess().feasible, true);
  assert.equal(assess(geometry, { type: 'bond', bondId: 'target' }).feasible, true);
  for (const [dx, dy] of [[-11.032412470655448, -48.174873781861244], [1000.123, -2000.456]]) {
    assert.equal(assess(geometry, undefined, dx, dy).feasible, true,
      'importing the same shape at a different origin cannot flip its own target contact');
  }
});

test('crossing the target bond in the curve middle is still a real collision', () => {
  const plan = assess({ ...geometry, control: { x: 1, y: -0.5 } });
  assert.equal(plan.feasible, false);
  assert.ok(plan.collisions.bonds.includes('target'));
});

test('the target end does not exempt an incident neighbour bond', () => {
  const plan = assess({ ...geometry, end: { x: 1.5, y: 0 } });
  assert.equal(plan.feasible, false);
  assert.ok(plan.collisions.bonds.includes('neighbour'));
});

test('coincident but differently identified atoms cannot claim target-bond contact', () => {
  const plan = assess(geometry, { type: 'formingBond', atomA: 'other-a', atomB: 'other-b' });
  assert.equal(plan.feasible, false);
  assert.ok(plan.collisions.bonds.includes('target'));
});

test('the actual Robinson pi-shift target contact survives native save/reopen translation', () => {
  const fixture = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'fixtures/forming-bond-reopen-contact.json'), 'utf8'));
  for (const sample of fixture.cases) {
    const scene = { L: sample.L, labels: [], lonePairs: [], arrows: [], bonds: sample.bonds };
    const plan = R.planArrow({ a: sample.geometry.start, b: sample.geometry.end, scene,
      source: sample.source, target: sample.target, electronCount: 2, fixedGeometry: sample.geometry });
    assert.equal(plan.feasible, true, sample.kind);
    assert.deepEqual(plan.collisions.bonds, []);
  }
});
