'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, textWidth } = require('../workbench/reaction-graph-layout.js');

const molecule = (id, width = 4, height = 3, weight = 12) => ({ id, width, height, weight });
const step = (id, reactants, products, layout) => ({ id, reactants, products, ...(layout ? { layout } : {}) });
const close = (a, b) => Math.abs(a - b) < 1e-7;
const overlaps = (a, b) => a.x1 < b.x2 - 1e-7 && a.x2 > b.x1 + 1e-7 && a.y1 < b.y2 - 1e-7 && a.y2 > b.y1 + 1e-7;
const boundsOf = (position, molecule) => ({ x1: position.x - molecule.width / 2, x2: position.x + molecule.width / 2,
  y1: position.y - molecule.height / 2, y2: position.y + molecule.height / 2 });

function inspect(input, output = plan(input)) {
  assert.equal(output.ok, true, JSON.stringify(output.diagnostic));
  const dimensions = new Map(input.molecules.map(m => [m.id, m]));
  assert.equal(output.positions.length, input.molecules.length);
  assert.equal(new Set(output.positions.map(p => p.id)).size, input.molecules.length, 'one physical position per molecule');
  const boxes = output.positions.map(p => ({ id: p.id, ...boundsOf(p, dimensions.get(p.id)) }));
  for (const box of boxes) {
    assert.ok(Object.values(box).filter(v => typeof v === 'number').every(Number.isFinite));
    for (const obstacle of input.obstacles || []) assert.ok(!overlaps(box, obstacle), 'molecule avoids fixed obstacle: ' + box.id);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    assert.ok(!overlaps(boxes[i], boxes[j]), 'molecules have distinct space: ' + boxes[i].id + '/' + boxes[j].id);
  }
  assert.equal(output.steps.length, input.steps.length);
  assert.deepEqual(new Set(output.steps.map(s => s.id)), new Set(input.steps.map(s => s.id)));
  for (const result of output.steps) {
    assert.ok(close(result.arrow.start.y, result.arrow.end.y), 'strictly horizontal arrow');
    assert.ok(result.arrow.end.x - result.arrow.start.x >= 0.55 - 1e-8, 'visible local arrow');
    assert.ok(close(result.arrow.start.y, result.flow.rowY));
    const shaft = { x1: result.arrow.start.x, x2: result.arrow.end.x, y1: result.arrow.start.y - 0.05, y2: result.arrow.end.y + 0.05 };
    for (const box of boxes) assert.ok(!overlaps(shaft, box), 'arrow does not cross a molecule: ' + result.id + '/' + box.id);
    for (const obstacle of input.obstacles || []) assert.ok(!overlaps(shaft, obstacle), 'arrow avoids fixed obstacle');
    for (const port of result.ports) assert.ok(output.cues.some(c => c.token === port.cueToken));
  }
  assert.equal(new Set(output.cues.map(c => c.token)).size, output.cues.length, 'every reference group gets a unique token');
  for (const cue of output.cues) {
    assert.equal(cue.ends.length, 2, 'exactly paired continuation/reference');
    assert.deepEqual(new Set(cue.ends.map(e => e.role)), new Set(['source', 'target']));
    assert.ok(cue.moleculeIds.length && cue.moleculeIds.every(id => dimensions.has(id)));
    for (const end of cue.ends) {
      assert.ok(input.steps.some(s => s.id === end.stepId));
      assert.ok(Number.isFinite(end.x) && Number.isFinite(end.y));
      assert.ok(output.steps.find(s => s.id === end.stepId).links.some(l => l.cueToken === cue.token && l.role === end.role));
      const width = Math.max(1.65, textWidth(cue.token));
      const label = { x1: end.x - width / 2, x2: end.x + width / 2, y1: end.y - 0.325, y2: end.y + 0.325 };
      for (const box of boxes) assert.ok(!overlaps(label, box), 'paired label clears real molecule: ' + cue.token + '/' + box.id);
      for (const obstacle of input.obstacles || []) assert.ok(!overlaps(label, obstacle), 'paired label avoids fixed obstacles');
    }
  }
  return output;
}

function chain(count) {
  return { molecules: Array.from({ length: count + 1 }, (_, i) => molecule('m' + String(i).padStart(2, '0'))),
    steps: Array.from({ length: count }, (_, i) => step('s' + String(i).padStart(2, '0'), ['m' + String(i).padStart(2, '0')], ['m' + String(i + 1).padStart(2, '0')])),
    anchor: { x: 3, y: 7 }, rowWidth: 37 };
}

test('a short chain uses actual shared intermediates and a common main baseline', () => {
  const input = chain(3), result = inspect(input);
  assert.equal(result.positions.length, 4);
  assert.equal(result.routes.length, 1);
  assert.equal(result.lanes.length, 1);
  assert.equal(result.cues.length, 0);
  assert.ok(result.positions.every(p => close(p.y, 7)));
  assert.ok(result.steps.every(s => close(s.arrow.start.y, 7)));
});

test('a small preparation head before a long heavy chain has an explicit paired product port', () => {
  const input = { molecules: [molecule('acid', 1.6, 1, 3), molecule('hydronium', 1.2, 1, 2),
    molecule('activated', 1.7, 1.4, 4), molecule('water', 1, 1, 1), ...['host', 'a', 'b', 'c', 'd'].map(id => molecule(id))],
    steps: [step('prep', ['acid', 'hydronium'], ['activated', 'water']), step('main1', ['host', 'activated'], ['a']),
      step('main2', ['a'], ['b']), step('main3', ['b'], ['c']), step('main4', ['c'], ['d'])],
    groups: [{ id: 'attack-scene', mainId: 'host', coLocate: true, moleculeIds: ['host', 'activated'],
      offsets: [{ id: 'host', x: 0, y: 0 }, { id: 'activated', x: 0, y: -3 }] }] };
  const result = inspect(input), pos = new Map(result.positions.map(p => [p.id, p]));
  const main = result.lanes.find(lane => lane.stepIds.includes('main1')), prep = result.lanes.find(lane => lane.stepIds.includes('prep'));
  assert.notEqual(main.laneId, prep.laneId);
  assert.ok(close(pos.get('activated').y - pos.get('host').y, -3));
  assert.equal(result.positions.filter(p => p.id === 'activated').length, 1);
  const cue = result.cues.find(cue => cue.moleculeIds.includes('activated'));
  assert.ok(cue && cue.ends.some(end => end.stepId === 'prep' && end.side === 'products' && end.at === 'port'));
  assert.ok(cue.ends.some(end => end.at === 'molecule' && close(end.x, pos.get('activated').x)));
  for (const lane of result.lanes) for (const id of lane.stepIds) {
    assert.ok(close(result.steps.find(s => s.id === id).arrow.start.y, lane.baseline));
  }
  assert.deepEqual(plan({ ...input, molecules: input.molecules.slice().reverse(), steps: input.steps.slice().reverse() }), result);
});

test('a heavy skeleton-bearing head is not mistaken for small reagent preparation', () => {
  const input = { molecules: ['heavy0', 'heavy1', 'heavy2', 'heavy3'].map(id => molecule(id)).concat(molecule('small', 1, 1, 1)),
    steps: [step('first', ['heavy0'], ['heavy1']), step('second', ['heavy1', 'small'], ['heavy2']), step('third', ['heavy2'], ['heavy3'])] };
  const result = inspect(input);
  assert.equal(result.lanes.length, 1); assert.equal(result.cues.length, 0);
  assert.deepEqual(result.lanes[0].stepIds, ['first', 'second', 'third']);
});

test('23-step main line, reagent preparation, fork, merge and shared reagent get readable lanes', () => {
  const input = chain(23);
  input.molecules.push(molecule('acid', 1, 1, 1), molecule('n0', 1.5, 1.5, 2), molecule('n1', 1.5, 1.5, 2), molecule('no-plus', 1.2, 1, 2),
    molecule('branch-a', 3, 2, 8), molecule('branch-b', 3, 2, 8), molecule('base', 1, 1, 1));
  input.steps.push(step('prep-1', ['n0', 'acid'], ['n1']), step('prep-2', ['n1'], ['no-plus']),
    step('fork-1', ['m12'], ['branch-a']), step('fork-2', ['branch-a'], ['branch-b']));
  input.steps[6].reactants.push('no-plus');
  input.steps[18].reactants.push('branch-b');
  input.steps[2].reactants.push('base');
  input.steps[16].reactants.push('base');
  const result = inspect(input);
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0].stepIds.slice(0, 23), input.steps.slice(0, 23).map(s => s.id));
  assert.ok(result.lanes.length >= 6);
  assert.ok(result.lanes.every(l => l.stepIds.length <= 5));
  assert.ok(result.cues.some(c => c.kind === 'wrap'));
  assert.ok(result.cues.some(c => c.kind === 'branch' && c.moleculeIds.includes('m12')));
  assert.ok(result.cues.some(c => c.kind === 'merge' && c.moleculeIds.includes('no-plus')));
  assert.ok(result.cues.some(c => c.moleculeIds.includes('branch-b')));
  assert.ok(result.cues.some(c => c.moleculeIds.includes('base')));
  const positions = new Map(result.positions.map(p => [p.id, p]));
  assert.ok(close(positions.get('no-plus').y, positions.get('m06').y), 'prepared NO+ physically docks at the main consumer');
  assert.ok(Math.abs(positions.get('no-plus').x - positions.get('m06').x) < 5, 'prepared NO+ stays near the attacking main skeleton');
  assert.ok(result.steps.find(s => s.id === 'prep-2').ports.some(p => p.side === 'products' && p.moleculeIds.includes('no-plus')),
    'preparation output uses a paired port to the real reagent');
});

test('branch and convergence use ports while each chemical structure appears once', () => {
  const input = { molecules: ['a', 'b', 'c', 'd'].map(id => molecule(id)), steps: [
    step('ab', ['a'], ['b']), step('ac', ['a'], ['c']), step('bcd', ['b', 'c'], ['d']),
  ] };
  const result = inspect(input);
  assert.equal(result.positions.length, 4);
  assert.equal(result.steps.length, 3);
  assert.ok(result.cues.some(c => c.moleculeIds.includes('a')));
  assert.ok(result.cues.some(c => c.moleculeIds.includes('c')));
  assert.ok(result.steps.find(s => s.id === 'ac').ports.some(p => p.side === 'products' && p.moleculeIds.includes('c')));
});

test('alternative producers can reference one actual final product', () => {
  const input = { molecules: ['a', 'b', 'c'].map(id => molecule(id)), steps: [step('first', ['a'], ['c']), step('second', ['b'], ['c'])] };
  const result = inspect(input);
  assert.equal(result.positions.filter(p => p.id === 'c').length, 1);
  assert.ok(result.cues.some(c => c.moleculeIds.includes('c')));
});

test('a wrapped multi-reactant merge gets separate unique paired source references', () => {
  const input = { molecules: ['a', 'b', 'c', 'd'].map(id => molecule(id)), rowWidth: 15, steps: [
    step('ab', ['a'], ['b']), step('bc', ['b'], ['c']), step('merge', ['b', 'c'], ['d'], { breakBefore: true }),
  ] };
  const result = inspect(input), merge = result.steps.find(s => s.id === 'merge');
  assert.equal(merge.flow.wrapped, true);
  const wrap = result.cues.filter(c => c.kind === 'wrap' && c.ends.some(e => e.stepId === 'merge' && e.at === 'port'));
  assert.equal(wrap.length, 2);
  assert.notEqual(wrap[0].token, wrap[1].token);
});

test('independent routes and isolated input molecules receive separate collision-free regions', () => {
  const input = { molecules: ['a', 'b', 'c', 'd', 'unused'].map(id => molecule(id)), steps: [step('one', ['a'], ['b']), step('two', ['c'], ['d'])] };
  const result = inspect(input);
  assert.equal(result.routes.length, 3);
  assert.equal(result.cues.length, 0);
  assert.ok(result.positions.find(p => p.id === 'unused'));
});

test('fixed old objects reserve the full arrow corridor rather than just molecule destinations', () => {
  const input = chain(6);
  input.obstacles = [{ x1: 7, y1: 3, x2: 9, y2: 12 }, { x1: 15, y1: 18, x2: 17, y2: 21 }];
  const result = inspect(input);
  assert.ok(result.positions.every(p => p.y > 12));
  assert.deepEqual(input.obstacles, [{ x1: 7, y1: 3, x2: 9, y2: 12 }, { x1: 15, y1: 18, x2: 17, y2: 21 }]);
});

test('a vertical local reagent does not pull the host or neighboring stages off baseline', () => {
  const input = { molecules: [molecule('a'), molecule('b'), molecule('c'), molecule('reagent', 1, 1, 1)], steps: [
    step('ab', ['a'], ['b']), step('bc', ['b', 'reagent'], ['c'], { reactantPlacement: 'vertical' }),
  ] };
  const result = inspect(input), pos = new Map(result.positions.map(p => [p.id, p]));
  assert.ok(close(pos.get('a').y, pos.get('b').y) && close(pos.get('b').y, pos.get('c').y));
  assert.ok(close(pos.get('b').x, pos.get('reagent').x));
  assert.ok(pos.get('reagent').y > pos.get('b').y);
});

test('rigid local offsets survive a replan and the main molecule defines row y', () => {
  const input = { molecules: [molecule('host'), molecule('r', 1, 1, 1), molecule('product')], steps: [step('s', ['host', 'r'], ['product'])],
    anchor: { x: 5, y: 9 }, groups: [{ id: 'local', mainId: 'host', moleculeIds: ['host', 'r'], offsets: [{ id: 'host', x: 0, y: 0 }, { id: 'r', x: 1.5, y: 3 }] }] };
  const result = inspect(input), pos = new Map(result.positions.map(p => [p.id, p]));
  assert.ok(close(pos.get('r').x - pos.get('host').x, 1.5));
  assert.ok(close(pos.get('r').y - pos.get('host').y, 3));
  assert.ok(close(pos.get('host').y, 9) && close(pos.get('product').y, 9));
});

test('incompatible rigid grouping returns exact group and step diagnostics', () => {
  const input = chain(2);
  input.groups = [{ id: 'wrong-group', mainId: 'm00', moleculeIds: ['m00', 'm02'], offsets: [{ id: 'm00', x: 0, y: 0 }, { id: 'm02', x: 0, y: 4 }] }];
  const result = plan(input);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'reaction_graph_group_conflict');
  assert.equal(result.diagnostic.groupId, 'wrong-group');
  assert.ok(result.diagnostic.stepIds.includes('s00') && result.diagnostic.stepIds.includes('s01'));
  assert.equal(result.positions, undefined);
});

test('long conditions reserve a horizontal shaft wide enough for their label', () => {
  const input = chain(2);
  input.steps[1].layout = { conditions: 'Na₂S₂O₄ / H₂O, heat, then cool' };
  const result = inspect(input), s = result.steps.find(s => s.id === 's01');
  assert.ok(s.arrow.end.x - s.arrow.start.x >= textWidth(input.steps[1].layout.conditions));
});

test('large groups expand only to the configured reasonable width limit', () => {
  const input = { molecules: [molecule('a', 5), molecule('b', 43)], steps: [step('s', ['a'], ['b'])], rowWidth: 37, maxRowWidth: 52 };
  const result = inspect(input);
  assert.ok(result.steps[0].flow.rowWidth > 37 && result.steps[0].flow.rowWidth <= 52);
  const failed = plan({ ...input, maxRowWidth: 40 });
  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostic.code, 'reaction_graph_too_wide');
  assert.equal(failed.positions, undefined);
});

test('longest path selection prefers the large skeleton for a one-step length difference', () => {
  const input = { molecules: [molecule('root', 2, 2, 1), molecule('small-1', 1, 1, 1), molecule('small-2', 1, 1, 1), molecule('small-3', 1, 1, 1),
    molecule('large-1', 4, 3, 25), molecule('large-2', 4, 3, 25)], steps: [
    step('small-a', ['root'], ['small-1']), step('small-b', ['small-1'], ['small-2']), step('small-c', ['small-2'], ['small-3']),
    step('large-a', ['root'], ['large-1']), step('large-b', ['large-1'], ['large-2']),
  ] };
  const result = inspect(input);
  assert.deepEqual(result.routes[0].stepIds.slice(0, 2), ['large-a', 'large-b']);
});

test('replanning is deterministic under input ordering and never mutates inputs', () => {
  const input = chain(12), snapshot = JSON.stringify(input), result = inspect(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(plan(input), result);
  assert.deepEqual(plan({ ...input, molecules: input.molecules.slice().reverse(), steps: input.steps.slice().reverse() }), result);
});

test('cycles and missing references have explicit diagnostics with no partial geometry', () => {
  const cyclic = { molecules: ['a', 'b'].map(id => molecule(id)), steps: [step('ab', ['a'], ['b']), step('ba', ['b'], ['a'])] };
  const cycle = plan(cyclic);
  assert.equal(cycle.ok, false);
  assert.equal(cycle.diagnostic.code, 'reaction_graph_cycle');
  assert.deepEqual(cycle.diagnostic.stepIds, ['ab', 'ba']);
  assert.equal(cycle.positions, undefined);
  assert.equal(plan({ molecules: [molecule('a')], steps: [step('bad', ['a'], ['missing'])] }).diagnostic.code, 'reaction_graph_invalid_input');
  for (const extra of [{ groups: {} }, { obstacles: {} }, { options: [] }]) {
    assert.equal(plan({ ...chain(1), ...extra }).diagnostic.code, 'reaction_graph_invalid_input');
  }
});

test('empty graphs are valid and default coordinates remain finite', () => {
  assert.deepEqual(plan({ molecules: [], steps: [] }).positions, []);
  inspect({ molecules: [molecule('only')], steps: [] });
});

test('a heavily reused source has enough reserved space for every paired reference label', () => {
  const input = { molecules: [molecule('shared')], steps: [] };
  for (let i = 0; i < 24; i++) { input.molecules.push(molecule('p' + i)); input.steps.push(step('s' + i, ['shared'], ['p' + i])); }
  const result = inspect(input);
  assert.equal(result.positions.filter(p => p.id === 'shared').length, 1);
  assert.equal(result.cues.length, 23);
  assert.ok(result.cues.every(c => c.kind === 'branch'));
});

test('deterministic varied DAGs preserve uniqueness and clear horizontal lanes', () => {
  let seed = 7813;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let trial = 0; trial < 60; trial++) {
    const input = { molecules: [molecule('m0', 1 + random() * 4, 1 + random() * 3, 2 + random() * 15)], steps: [], rowWidth: 20 + random() * 17 };
    for (let i = 1; i < 15; i++) {
      const reactants = [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => 'm' + Math.floor(random() * i)))];
      input.molecules.push(molecule('m' + i, 1 + random() * 5, 1 + random() * 3, 2 + random() * 15));
      input.steps.push(step('s' + i, reactants, ['m' + i], random() < 0.2 ? { breakBefore: true } : undefined));
    }
    inspect(input);
  }
});

test('co-located branch reagents share the host home without duplicating structures or references', () => {
  const input = { molecules: [molecule('host'), molecule('r1', 1, 1, 1), molecule('r2', 1, 1, 1), molecule('p1'), molecule('p2')],
    steps: [step('branch1', ['host', 'r1'], ['p1']), step('branch2', ['host', 'r2'], ['p2'])],
    groups: [{ id: 'dock', mainId: 'host', coLocate: true, moleculeIds: ['host', 'r1', 'r2'],
      offsets: [{ id: 'host', x: 0, y: 0 }, { id: 'r1', x: -2.6, y: 0 }, { id: 'r2', x: 2.6, y: 0 }] }] };
  const result = inspect(input), positions = new Map(result.positions.map(p => [p.id, p]));
  const homes = new Map(result.homes.map(h => [h.moleculeId, h.stageId]));
  for (const [id, offset] of [['r1', -2.6], ['r2', 2.6]]) {
    assert.equal(homes.get(id), homes.get('host'));
    assert.ok(close(positions.get(id).x - positions.get('host').x, offset));
    assert.ok(close(positions.get(id).y, positions.get('host').y));
    assert.equal(result.positions.filter(p => p.id === id).length, 1);
  }
  const branch = result.cues.find(cue => cue.kind === 'branch' && cue.moleculeIds.includes('host') && cue.moleculeIds.includes('r2'));
  assert.ok(branch, 'the remote branch references the co-located host and reagent together');
  assert.deepEqual(new Set(branch.ends.map(end => end.stepId)), new Set(['branch1', 'branch2']));
  assert.deepEqual(new Set(branch.ends.map(end => end.at)), new Set(['molecule', 'port']));
  assert.equal(result.steps.find(s => s.id === 'branch2').ports.filter(p => p.cueToken === branch.token).length, 1);
});

test('co-locating members from opposite sides of one step has an explicit group conflict', () => {
  const input = { molecules: ['host', 'reagent', 'product'].map(id => molecule(id)),
    steps: [step('reaction', ['host', 'reagent'], ['product'])],
    groups: [{ id: 'bad-dock', mainId: 'host', coLocate: true, moleculeIds: ['host', 'product'],
      offsets: [{ id: 'host', x: 0, y: 0 }, { id: 'product', x: 0, y: 4 }] }] };
  const result = plan(input);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, 'reaction_graph_group_conflict');
  assert.equal(result.diagnostic.groupId, 'bad-dock');
  assert.match(result.diagnostic.message, /stages|reaction/i);
  assert.equal(result.positions, undefined);
});

test('a co-located prepared reagent retains paired ports when its host stage does not use it', () => {
  const input = {
    molecules: ['a', 'b', 'd', 'e', 'c'].map(id => molecule(id)).concat(
      ['r0', 'r', 'r2', 'r3', 'r4'].map(id => molecule(id, 1, 1, 1))),
    steps: [step('main', ['a'], ['b']), step('main2', ['b'], ['d']), step('main3', ['d'], ['e']),
      step('fork', ['a', 'r'], ['c']), step('prep', ['r0'], ['r']),
      step('reagent-1', ['r'], ['r2']), step('reagent-2', ['r2'], ['r3']), step('reagent-3', ['r3'], ['r4'])],
    groups: [{ id: 'dock', mainId: 'a', coLocate: true, moleculeIds: ['a', 'r'],
      offsets: [{ id: 'a', x: 0, y: 0 }, { id: 'r', x: 0, y: 3 }] }],
  };
  const result = inspect(input), positions = new Map(result.positions.map(p => [p.id, p]));
  const homes = new Map(result.homes.map(home => [home.moleculeId, home.stageId]));
  assert.equal(homes.get('r'), homes.get('a'));
  assert.ok(close(positions.get('r').x, positions.get('a').x));
  assert.ok(close(positions.get('r').y - positions.get('a').y, 3));
  const reagentCue = result.cues.find(cue => cue.moleculeIds.length === 1 && cue.moleculeIds[0] === 'r');
  assert.ok(reagentCue, 'the preparation lane references the one real docked reagent');
  const moleculeEnd = reagentCue.ends.find(end => end.at === 'molecule');
  assert.equal(moleculeEnd.stepId, 'prep', 'an actual producer owns the relocated reagent end');
  assert.equal(moleculeEnd.side, 'products');
  assert.ok(close(moleculeEnd.x, positions.get('r').x));
  const hostRow = result.lanes.find(lane => lane.stepIds.includes('main'));
  assert.ok(moleculeEnd.y > positions.get('r').y && moleculeEnd.y <= hostRow.bounds.y2,
    'the molecule end stays in the real host row rather than the preparation row');
  assert.deepEqual(plan({ ...input, molecules: input.molecules.slice().reverse(), steps: input.steps.slice().reverse() }), result);
});

test('23-step wrapped chain keeps row spacing proportional to content and continuation labels', () => {
  const input = chain(23), result = inspect(input);
  assert.ok(result.lanes.length >= 4, 'fixture must exercise several line wraps');
  assert.equal(result.cues.filter(cue => cue.kind === 'wrap').length, result.lanes.length - 1);
  const lanes = result.lanes.slice().sort((a, b) => a.baseline - b.baseline);
  // Each molecule is 3 units tall; allow another 5.5 units for whitespace and
  // continuation labels per row, rather than a reserve proportional to all 23 steps.
  const maxBaselineGap = 3 + 5.5;
  for (let i = 1; i < lanes.length; i++) {
    const gap = lanes[i].baseline - lanes[i - 1].baseline;
    assert.ok(gap <= maxBaselineGap, `row gap ${gap} exceeds space for content and labels`);
  }
  assert.ok(result.bounds.y2 - result.bounds.y1 <= 3 + (lanes.length - 1) * maxBaselineGap,
    'overall height remains bounded by per-row content and continuation space');
});

test('independent upward and downward docks only enlarge their own wrapped rows', () => {
  const input = chain(9);
  input.options = { rowSteps: 1 };
  input.molecules.forEach(m => { m.height = 1; });
  input.molecules.push(molecule('up', 1, 1, 1), molecule('down', 1, 1, 1));
  input.steps[2].reactants.push('up');
  input.steps[6].reactants.push('down');
  input.groups = [
    { id: 'upper-dock', mainId: 'm02', moleculeIds: ['m02', 'up'], offsets: [{ id: 'm02', x: 0, y: 0 }, { id: 'up', x: 0, y: -8 }] },
    { id: 'lower-dock', mainId: 'm06', moleculeIds: ['m06', 'down'], offsets: [{ id: 'm06', x: 0, y: 0 }, { id: 'down', x: 0, y: 9 }] },
  ];
  const result = inspect(input), lanes = result.lanes;
  assert.equal(lanes.length, 9);
  assert.equal(lanes.filter(l => l.bounds.y2 - l.bounds.y1 > 8).length, 2,
    'the independent upper/lower extents must not combine into a giant height for every row');
  assert.ok(lanes.filter(l => l.bounds.y2 - l.bounds.y1 < 3).length >= 7, 'ordinary rows retain local content height');
  for (let i = 1; i < lanes.length; i++) {
    assert.ok(close(lanes[i].bounds.y1 - lanes[i - 1].bounds.y2, 2.3), 'preserve the intentional reading gap');
  }
  const positions = new Map(result.positions.map(p => [p.id, p]));
  assert.ok(close(positions.get('up').y - positions.get('m02').y, -8));
  assert.ok(close(positions.get('down').y - positions.get('m06').y, 9));
  for (const cue of result.cues) for (const end of cue.ends) {
    assert.ok(lanes.some(l => end.y - 0.325 >= l.bounds.y1 - 1e-7 && end.y + 0.325 <= l.bounds.y2 + 1e-7),
      'both continuation endpoints stay inside an allocated row');
  }
  const labels = result.cues.flatMap(c => c.ends.map(e => ({ token: c.token,
    x1: e.x - Math.max(1.65, textWidth(c.token)) / 2, x2: e.x + Math.max(1.65, textWidth(c.token)) / 2,
    y1: e.y - 0.325, y2: e.y + 0.325 })));
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    assert.ok(!overlaps(labels[i], labels[j]), 'row-local continuation labels remain distinct');
  }
  assert.deepEqual(plan({ ...input, molecules: input.molecules.slice().reverse(), steps: input.steps.slice().reverse() }), result);
});
