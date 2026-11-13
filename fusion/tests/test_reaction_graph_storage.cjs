'use strict';
// Canvas application (.molwork): node --test fusion/tests/test_reaction_graph_storage.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/workbench-storage.js');
const M = globalThis.MolWorkbench.model, storage = globalThis.MolWorkbench.storage;

function graphFile() {
  return {
    format: M.FORMAT, version: M.VERSION,
    ket: { root: { nodes: [
      { $ref: 'mol0' }, { $ref: 'mol1' },
      { type: 'arrow', data: { mode: 'open-angle', pos: [{ x: 1, y: 0 }, { x: 3, y: 0 }] } },
      { type: 'text', data: { content: 'A' } },
      { type: 'text', data: { content: 'heat' } }
    ] },
    mol0: { type: 'molecule', atoms: [{ label: 'C', location: [0, 0, 0] }], bonds: [] },
    mol1: { type: 'molecule', atoms: [{ label: 'O', location: [4, 0, 0] }], bonds: [] } },
    bindings: { atoms: [{ id: 'a', mol: 'mol0', index: 0 }, { id: 'b', mol: 'mol1', index: 0 }], bonds: [] },
    mechanism: M.emptyState(),
    reactionSteps: [{ stepId: 'step-graph', version: 1, arrow: 2, reactants: ['a'], products: ['b'],
      layout: { reactantPlacement: 'vertical', reagentPlacement: 'above', breakBefore: true, conditions: 'heat' },
      flow: { axis: 'x', reading: true, graph: true, routeId: 'route-1', laneId: 'lane-1',
        arrowStartX: 1, arrowStartY: 0, arrowEndX: 3, arrowEndY: 0 },
      labels: [{ node: 3, role: 'graphPort', text: 'A', token: 'A', kind: 'branch', side: 'source',
        at: 'molecule', anchorRefs: ['a'], layoutX: 0.25, layoutY: 0.5, anchorDx: 0.25, anchorDy: 0.5 }] }]
  };
}
function parse(file) { return storage.parseWorkbench(JSON.stringify(file)); }
function rejected(file, description) {
  let result;
  assert.doesNotThrow(() => { result = parse(file); }, description);
  assert.equal(result.ok, false, description);
  assert.equal(result.code, 'invalid', description);
}

test('canvas graph flow and graph-port labels survive repeated .molwork saves', () => {
  for (const kind of ['wrap', 'branch', 'merge', 'reuse']) {
    for (const side of ['source', 'target']) {
      for (const at of ['molecule', 'port']) {
        const file = graphFile(), label = file.reactionSteps[0].labels[0];
        Object.assign(label, { kind, side, at });
        if (at === 'port') { delete label.anchorDx; delete label.anchorDy; }
        const serialized = storage.serializeWorkbench(file), result = storage.parseWorkbench(serialized);
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.doc.reactionSteps, file.reactionSteps);
        assert.equal(storage.serializeWorkbench(result.doc), serialized);
      }
    }
  }
});

test('graph flow requires both route IDs and all four finite arrow coordinates', () => {
  for (const key of ['routeId', 'laneId', 'arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY']) {
    const file = graphFile(); delete file.reactionSteps[0].flow[key];
    rejected(file, `missing ${key}`);
  }
  for (const key of ['routeId', 'laneId']) {
    for (const value of ['', null, 123, 'x'.repeat(161)]) {
      const file = graphFile(); file.reactionSteps[0].flow[key] = value;
      rejected(file, `${key}: ${JSON.stringify(value)}`);
    }
  }
  for (const key of ['arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY']) {
    for (const value of [null, '1', Infinity, NaN, 10001]) {
      const file = graphFile(); file.reactionSteps[0].flow[key] = value;
      rejected(file, `${key}: ${String(value)}`);
    }
  }
  for (const flow of [null, [], 'graph', { graph: 'true' }, { graph: true, future: true }]) {
    const file = graphFile(); file.reactionSteps[0].flow = flow;
    rejected(file, `flow: ${JSON.stringify(flow)}`);
  }
  const legacy = graphFile(); legacy.reactionSteps[0].flow = { axis: 'x', rowY: 0, continuation: 1 };
  assert.equal(parse(legacy).ok, true);
});

test('graph-port labels reject malformed metadata and invalid atom bindings', () => {
  const mutations = [
    ...['token', 'kind', 'side', 'at', 'anchorRefs', 'layoutX', 'layoutY', 'anchorDx', 'anchorDy']
      .map(key => label => { delete label[key]; }),
    label => { label.token = ''; }, label => { label.token = 'B'; },
    label => { label.token = 'x'.repeat(65); label.text = label.token; },
    label => { label.kind = 'cycle'; }, label => { label.side = 'middle'; },
    label => { label.at = 'arrow'; }, label => { label.anchorRefs = []; },
    label => { label.anchorRefs = ['missing']; }, label => { label.anchorRefs = ['a', 'a']; },
    label => { label.anchorRefs = Array(33).fill('a'); },
    ...['layoutX', 'layoutY', 'anchorDx', 'anchorDy'].flatMap(key => [null, '0', Infinity, NaN]
      .map(value => label => { label[key] = value; })),
    label => { label.node = 2; }, label => { label.extra = true; }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const file = graphFile(); mutate(file.reactionSteps[0].labels[0]);
    rejected(file, `invalid graphPort mutation ${index}`);
  }
});

test('optional graph-port offsets must be finite on ports as well as molecules', () => {
  for (const key of ['anchorDx', 'anchorDy']) {
    for (const value of [null, '0', Infinity, NaN]) {
      const file = graphFile(), label = file.reactionSteps[0].labels[0];
      label.at = 'port'; label[key] = value;
      rejected(file, `port ${key}: ${String(value)}`);
    }
  }
  const valid = graphFile(); valid.reactionSteps[0].labels[0].at = 'port';
  assert.equal(parse(valid).ok, true);
});

test('legacy labels reject graph-only metadata instead of silently retaining it', () => {
  for (const role of ['conditions', 'previousRow', 'nextRow']) {
    for (const [key, value] of Object.entries({ token: 'A', kind: 'wrap', side: 'source', at: 'port',
      anchorRefs: ['a'], layoutX: 0, layoutY: 0, anchorDx: 0, anchorDy: 0 })) {
      const file = graphFile();
      file.reactionSteps[0].labels = [{ node: 4, role, text: 'heat', [key]: value }];
      rejected(file, `${role} with ${key}`);
    }
  }
});

test('graph-port labels are bounded and legacy label roles still round-trip', () => {
  const bounded = graphFile(), step = bounded.reactionSteps[0];
  step.labels = Array.from({ length: 129 }, () => structuredClone(step.labels[0]));
  let result = parse(bounded);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.doc.reactionSteps[0].labels.length, 129);
  step.labels.push(structuredClone(step.labels[0]));
  rejected(bounded, '130 labels');
  const legacy = graphFile();
  legacy.reactionSteps[0].labels = ['conditions', 'previousRow', 'nextRow']
    .map(role => ({ node: 4, role, text: 'heat' }));
  result = storage.parseWorkbench(storage.serializeWorkbench(legacy));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.doc.reactionSteps[0].labels, legacy.reactionSteps[0].labels);
});

test('all reagent docking placements survive saves; invalid declarations reject', () => {
  for (const reagentPlacement of ['auto', 'left', 'right', 'above', 'below']) {
    const file = graphFile(); file.reactionSteps[0].layout.reagentPlacement = reagentPlacement;
    const result = storage.parseWorkbench(storage.serializeWorkbench(file));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.doc.reactionSteps[0].layout.reagentPlacement, reagentPlacement);
  }
  for (const value of [null, '', 'top', 'diagonal', 1, {}, []]) {
    const file = graphFile(); file.reactionSteps[0].layout.reagentPlacement = value;
    rejected(file, `reagentPlacement: ${JSON.stringify(value)}`);
  }
});

test('optional graph anchors persist through repeated saves and old graph files still load', () => {
  const file = graphFile();
  file.reactionSteps[0].flow.anchors = [
    { atomId: 'a', x: -10000, y: 10000 }, { atomId: 'b', x: 2.25, y: -3.5 }
  ];
  let text = storage.serializeWorkbench(file);
  for (let i = 0; i < 3; i++) {
    const result = storage.parseWorkbench(text);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.doc.reactionSteps[0].flow.anchors, file.reactionSteps[0].flow.anchors);
    assert.equal(storage.serializeWorkbench(result.doc), text);
    text = storage.serializeWorkbench(result.doc);
  }
  const old = graphFile();
  const result = storage.parseWorkbench(storage.serializeWorkbench(old));
  assert.equal(result.ok, true, result.error);
  assert.equal(Object.hasOwn(result.doc.reactionSteps[0].flow, 'anchors'), false);
});

test('graph anchors accept all 32 distinct participants permitted by step limits', () => {
  const file = graphFile(), step = file.reactionSteps[0];
  for (let i = 0; i < 30; i++) {
    const index = file.ket.mol0.atoms.length, id = `extra-${i}`;
    file.ket.mol0.atoms.push({ label: 'C', location: [index, 0, 0] });
    file.bindings.atoms.push({ id, mol: 'mol0', index });
    (i < 15 ? step.reactants : step.products).push(id);
  }
  step.flow.anchors = [...step.reactants, ...step.products].map((atomId, i) => ({ atomId, x: i, y: -i - 1 }));
  const result = storage.parseWorkbench(storage.serializeWorkbench(file));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.doc.reactionSteps[0].flow.anchors, step.flow.anchors);
});

test('graph anchors reject invalid shapes, identities, coordinates and duplicates', () => {
  const anchor = { atomId: 'a', x: 0, y: 0 };
  const variants = [
    null, {}, 'anchors', [], [null], [true], [[]], [{}],
    [{ x: 0, y: 0 }], [{ atomId: 'a', y: 0 }], [{ atomId: 'a', x: 0 }],
    [{ ...anchor, future: true }], [{ ...anchor, atomId: '' }],
    [{ ...anchor, atomId: null }], [{ ...anchor, atomId: 'missing' }],
    [anchor, { ...anchor, x: 1 }],
    Array.from({ length: 65 }, (_, i) => ({ atomId: `missing-${i}`, x: 0, y: 0 })),
    ...['x', 'y'].flatMap(key => [null, '0', Infinity, NaN, 10000.1, -10000.1]
      .map(value => [{ ...anchor, [key]: value }]))
  ];
  for (const [index, anchors] of variants.entries()) {
    const file = graphFile(); file.reactionSteps[0].flow.anchors = anchors;
    rejected(file, `invalid anchors variant ${index}`);
  }
  const unrelated = graphFile();
  unrelated.ket.mol0.atoms.push({ label: 'N', location: [1, 1, 0] });
  unrelated.bindings.atoms.push({ id: 'other', mol: 'mol0', index: 1 });
  unrelated.reactionSteps[0].flow.anchors = [{ ...anchor, atomId: 'other' }];
  rejected(unrelated, 'bound atom outside both sides of the step');
  for (const graph of [false, undefined]) {
    const file = graphFile(); file.reactionSteps[0].flow.graph = graph;
    file.reactionSteps[0].flow.anchors = [anchor];
    rejected(file, `anchors with graph=${String(graph)}`);
  }
});
