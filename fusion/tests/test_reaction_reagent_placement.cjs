'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../workbench/reaction-reagent-placement.js');
const fixture = () => ({ host: { id: 'theophylline', x: 0, y: 0, width: 4.5, height: 4 },
  reagent: { id: 'dimethyl-sulfate', x: 6, y: 0, width: 3, height: 3 },
  contacts: [{ host: { x: -1.8, y: 1 }, reagent: { x: 6.8, y: -1.2 } }] });

test('a left-bottom nucleophile brings an upper reagent acceptor to the left without moving the host', () => {
  const input = fixture(), before = JSON.stringify(input), result = plan({ ...input, placement: 'left' });
  assert.equal(result.ok, true);
  assert.ok(result.position.x + input.reagent.width / 2 < input.host.x - input.host.width / 2);
  assert.deepEqual(result.hostPosition, { x: 0, y: 0 });
  assert.ok(Math.abs(input.contacts[0].reagent.y + result.translation.dy - input.contacts[0].host.y) < 1e-8);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.group.offsets[0], { id: 'theophylline', x: 0, y: 0 });
});

test('automatic contact search prefers local left/bottom space over a distant right-hand reagent', () => {
  const input = fixture(), result = plan(input);
  assert.equal(result.ok, true);
  assert.ok(result.metrics.contactDistance < 2);
  assert.ok(result.position.x < input.host.x);
});

test('real geometry metrics outrank contact distance when the closest candidate crosses ink', () => {
  const input = fixture();
  const result = plan({ ...input, placement: 'left', evaluate: c => ({
    feasible: Math.abs(c.contacts[0].host.y - c.contacts[0].reagent.y) >= 0.5,
    labelHits: Math.abs(c.contacts[0].host.y - c.contacts[0].reagent.y) < 0.5 ? 1 : 0,
    bondHits: 0, arrowHits: 0, length: c.distance, arcRatio: 1.1,
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.feasible, true);
  assert.equal(result.metrics.labelHits, 0);
});

test('giant curvature loses to moving the molecule even if both curves avoid labels', () => {
  const result = plan({ ...fixture(), evaluate: c => ({ feasible: true, length: c.original ? 20 : c.distance,
    arcRatio: c.original ? 5 : 1.1, maxBend: c.original ? 4 : 0.3 }) });
  assert.equal(result.ok, true);
  assert.ok(result.metrics.length < 3 && result.metrics.arcRatio < 1.2);
});

test('fixed neighboring content forces a clear candidate while a required side stays hard', () => {
  const input = fixture(), result = plan({ ...input, placement: 'left', obstacles: [{ x1: -5, x2: -2.5, y1: 0.5, y2: 4 }] });
  assert.equal(result.ok, true);
  assert.ok(result.position.x < -2.25);
  assert.ok(result.position.y + 1.5 <= 0.35 || result.position.x + 1.5 <= -5.15);
});

test('blocked required side returns an explicit diagnostic instead of moving the host or changing the curve', () => {
  const result = plan({ ...fixture(), placement: 'left', minX: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'reaction_reagent_blocked');
  assert.equal(result.position, undefined);
});

test('evaluated but crowded candidates remain reported as failed rather than falsely cleared', () => {
  const result = plan({ ...fixture(), evaluate: () => ({ feasible: false, bondHits: 1 }) });
  assert.equal(result.ok, true);
  assert.equal(result.feasible, false);
  assert.equal(result.metrics.bondHits, 1);
});

test('candidate evaluation is bounded deterministic and receives the exact rigid translation', () => {
  const input = fixture(), calls = [];
  const result = plan({ ...input, options: { maxCandidates: 12 }, evaluate: c => {
    calls.push(c);
    assert.equal(c.contacts[0].reagent.x, input.contacts[0].reagent.x + c.translation.dx);
    assert.equal(c.contacts[0].host.x, input.contacts[0].host.x);
    return { feasible: true };
  } });
  assert.equal(result.ok, true);
  assert.ok(calls.length <= 12);
  assert.deepEqual(plan(input), plan(input));
});

test('wider reserved glyph bounds retain the physical site direction and still prevent overlap', () => {
  const base = fixture();
  base.host.siteWidth = base.host.width; base.host.siteHeight = base.host.height;
  const widened = structuredClone(base); widened.host.width = 10;
  const originals = [base, widened].map(input => JSON.stringify(input));
  const results = [base, widened].map(input => plan(input));
  for (const [i, result] of results.entries()) {
    const input = [base, widened][i];
    assert.equal(result.ok, true);
    assert.equal(result.preferredSide, 'left');
    assert.equal(result.candidates[0].side, 'left');
    assert.deepEqual(result.hostPosition, { x: input.host.x, y: input.host.y });
    assert.ok(result.position.x + input.reagent.width / 2 <= input.host.x - input.host.width / 2,
      'the full reserved host bounds remain clear, including after widening');
    assert.equal(JSON.stringify(input), originals[i]);
  }
  assert.ok(results[1].position.x < results[0].position.x, 'larger glyph reservation actually moves reagent outwards');
});

test('invalid optional reaction-site dimensions reject explicitly', () => {
  for (const key of ['siteWidth', 'siteHeight']) for (const value of [0, -1, null, '4', NaN, Infinity, -Infinity]) {
    const input = fixture(); input.host[key] = value;
    const result = plan(input);
    assert.equal(result.ok, false, `${key}: ${String(value)}`);
    assert.equal(result.diagnostic.code, 'reaction_reagent_invalid_input');
  }
});
