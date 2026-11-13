import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';

const clone = value => structuredClone(value);
const passed = { status: 'passed', issues: [] };
const changed = { status: 'failed', issues: [{ code: 'reaction_step_reagent_placement_changed',
  placement: 'left', message: '试剂的位置不再符合左侧停靠要求' }] };
const move = { id: 'move-reagent', type: 'molecule.move', target: { molecule: 'reagent' }, dx: 3, dy: 0 };
const repair = { id: 'repair', type: 'reactionStep.modify', stepId: 'existing', expectedVersion: 3,
  layout: { reagentPlacement: 'left' } };
const tool = (operation, id) => ({ tool_calls: [{ index: 0, id, type: 'function',
  function: { name: 'draw_operations', arguments: JSON.stringify({ operations: [operation], finish: true }) } }] });

test('observed layout failure blocks ordinary edit completion until versioned repair passes', async () => {
  const step = { stepId: 'existing', version: 3, reactants: ['a'], products: ['b'], reactionArrowId: 0,
    layout: { reagentPlacement: 'left' }, checks: { layout: clone(passed), chemistry: clone(passed) } };
  const live = { sessionId: 'doc', revision: 1,
    atoms: [{ id: 'a', label: 'C' }, { id: 'b', label: 'C' }], bonds: [],
    molecules: [{ id: 'reagent', atoms: ['a'] }, { id: 'product', atoms: ['b'] }], lonePairs: [], arrows: [],
    reactionSteps: [step], reactionArrows: [{ id: 0, stepId: 'existing', reactants: ['a'], products: ['b'] }],
    selection: { atoms: [], bonds: [] } };
  const events = [], requests = [], applied = [], responses = [tool(move, 'move-call'), tool(repair, 'repair-call')];
  const bridge = {
    async getContext() { return clone(live); },
    async beginRun() {}, async endRun() {}, async previewOperations() {}, async clearPreview() {},
    async applyOperations(operations) {
      applied.push(clone(operations));
      const op = operations[0], before = clone(live.reactionSteps[0]);
      assert.equal(operations.length, 1);
      let action;
      if (op.type === 'molecule.move') {
        action = 'observe';
        live.reactionSteps[0].checks.layout = clone(changed);
      } else {
        assert.deepEqual(op, repair);
        action = 'modify';
        Object.assign(live.reactionSteps[0], { version: 4, layout: { ...before.layout, ...op.layout },
          checks: { layout: clone(passed), chemistry: clone(passed) } });
      }
      const after = clone(live.reactionSteps[0]);
      return { created: [], updated: [{ id: op.id, type: op.type }], deleted: [], cascaded: [], warnings: [], stepMapping: {},
        steps: [{ operationId: op.id, stepId: after.stepId, version: after.version, action,
          before: action === 'observe' ? null : before, after, layout: clone(after.checks.layout), checks: clone(after.checks) }] };
    },
  };
  const runtime = new Runtime({ bridge,
    getConfig: async () => ({ configured: true, sessionToken: 'unit-test', model: 'unit-test', baseUrl: 'https://unit.invalid/v1' }),
    eventTarget: new EventTarget(), onEvent: event => events.push(event),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const delta = responses[requests.length - 1];
      assert.ok(delta, 'runtime must not request more model responses');
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const [part, finish] of [[{ role: 'assistant', ...delta }, null], [{}, 'tool_calls']]) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'unit', model: 'unit-test',
            choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const result = await runtime.run('把这个分子往右移一点');
  const receipts = events.filter(event => event.type === 'tool_end' && event.toolName === 'draw_operations' && !event.isError)
    .map(event => event.result.result);
  assert.equal(result.status, 'completed');
  assert.equal(requests.length, 2);
  assert.deepEqual(applied, [[move], [repair]]);
  assert.equal(receipts[0].steps[0].action, 'observe');
  assert.equal(receipts[0].steps[0].version, 3);
  assert.equal(receipts[0].finishAccepted, false);
  assert.equal(receipts[0].invalidReactionSteps[0].checks.layout.issues[0].code, 'reaction_step_reagent_placement_changed');
  assert.match(receipts[0].finishRejected, /existing v3/);
  assert.equal(receipts[1].steps[0].action, 'modify');
  assert.equal(receipts[1].steps[0].before.version, 3);
  assert.equal(receipts[1].steps[0].after.version, 4);
  assert.equal(receipts[1].steps[0].after.layout.reagentPlacement, 'left');
  assert.equal(receipts[1].steps[0].checks.layout.status, 'passed');
  assert.equal(receipts[1].steps[0].checks.chemistry.status, 'failed');
  assert.equal(receipts[1].finishAccepted, true);
  assert.equal(live.reactionSteps[0].layout.reagentPlacement, 'left');
});

function mechanismScene() {
  const atoms = [
    { id: 'nuc', label: 'O', implicitH: 1, charge: -1 }, { id: 'carbon', label: 'C', implicitH: 3, charge: 0 },
    { id: 'bromine', label: 'Br', implicitH: 0, charge: 0 }, { id: 'mid-c', label: 'C', implicitH: 3, charge: 0 },
    { id: 'mid-o', label: 'O', implicitH: 1, charge: 0 }, { id: 'bromide', label: 'Br', implicitH: 0, charge: -1 },
    { id: 'cation', label: 'C', implicitH: 3, charge: 1 }, { id: 'hydroxide', label: 'O', implicitH: 1, charge: -1 },
  ];
  const first = { stepId: 'first', version: 1, reactants: ['nuc', 'carbon'], products: ['mid-c', 'bromide'],
    reactionArrowId: 0, layout: {}, checks: { layout: clone(passed), chemistry: clone(passed) } };
  const second = { stepId: 'second', version: 1, reactants: ['mid-c'], products: ['cation', 'hydroxide'],
    reactionArrowId: 1, layout: {}, checks: { layout: clone(passed), chemistry: clone(passed) } };
  return { sessionId: 'doc', revision: 1, atoms,
    bonds: [{ id: 'cbr', begin: 'carbon', end: 'bromine', order: 1 }, { id: 'co', begin: 'mid-c', end: 'mid-o', order: 1 }],
    molecules: [{ id: 'nuc-m', atoms: ['nuc'] }, { id: 'substrate', atoms: ['carbon', 'bromine'] },
      { id: 'intermediate', atoms: ['mid-c', 'mid-o'] }, { id: 'br-m', atoms: ['bromide'] },
      { id: 'cat-m', atoms: ['cation'] }, { id: 'oh-m', atoms: ['hydroxide'] }],
    lonePairs: [{ id: 'lp', ownerAtomId: 'nuc' }],
    arrows: [{ id: 'attack', source: { type: 'lonePair', slotId: 'lp', ownerAtomId: 'nuc' },
      target: { type: 'formingBond', atomA: 'nuc', atomB: 'carbon' }, electronCount: 2 },
    { id: 'leave', source: { type: 'bond', bondId: 'cbr', component: 'sigma' }, target: { type: 'atom', atomId: 'bromine' }, electronCount: 2 },
    { id: 'second-flow', source: { type: 'bond', bondId: 'co', component: 'sigma' }, target: { type: 'atom', atomId: 'mid-o' }, electronCount: 2 }],
    reactionSteps: [first, second], reactionArrows: [first, second].map(step => ({ id: step.reactionArrowId,
      stepId: step.stepId, reactants: step.reactants, products: step.products })), selection: { atoms: [], bonds: [] } };
}

function mechanismHarness(live, operations, { completeScope = false } = {}) {
  const events = [], requests = [], applied = [];
  const bridge = {
    async getContext() { return clone(live); }, async beginRun() {}, async endRun() {},
    async previewOperations() {}, async clearPreview() {},
    async applyOperations(ops) {
      applied.push(clone(ops));
      const updated = [], steps = [];
      for (const op of ops) {
        if (op.type === 'reactionStep.modify') {
          const target = live.reactionSteps.find(s => s.stepId === op.stepId), before = clone(target);
          assert.equal(op.expectedVersion, target.version);
          target.version++; target.layout = { ...target.layout, ...op.layout };
          const after = clone(target);
          steps.push({ operationId: op.id, action: 'modify', stepId: target.stepId, version: target.version,
            before, after, layout: clone(passed), checks: clone(target.checks) });
          updated.push({ id: op.id, type: op.type, stepId: target.stepId, version: target.version });
        } else if (op.type === 'arrow.modify') {
          const arrow = live.arrows.find(a => a.id === op.arrowId);
          if (op.target) arrow.target = clone(op.target);
          updated.push({ id: op.id, type: op.type, entityIds: [arrow.id] });
        } else if (op.type === 'molecule.move') {
          const after = clone(live.reactionSteps[0]);
          steps.push({ operationId: op.id, action: 'observe', stepId: after.stepId, version: after.version,
            before: null, after, layout: clone(passed), checks: clone(after.checks) });
          updated.push({ id: op.id, type: op.type, atomIds: ['nuc'] });
        } else assert.fail('Unexpected mock operation: ' + op.type);
      }
      return { created: [], updated, deleted: [], cascaded: [], warnings: [], steps, stepMapping: {} };
    },
  };
  const args = { operations, finish: true, ...(completeScope && { taskScope: { type: 'completeMechanism' } }) };
  const delta = { tool_calls: [{ index: 0, id: 'edit', type: 'function',
    function: { name: 'draw_operations', arguments: JSON.stringify(args) } }] };
  const runtime = new Runtime({ bridge,
    getConfig: async () => ({ configured: true, sessionToken: 'test', model: 'test', baseUrl: 'https://unit.invalid/v1' }),
    eventTarget: new EventTarget(), onEvent: event => events.push(event),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const next = requests.length === 1 ? delta : { content: '需要修复。' };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const [part, finish] of [[{ role: 'assistant', ...next }, null], [{}, next.tool_calls ? 'tool_calls' : 'stop']]) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'unit', model: 'test',
            choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return { runtime, events, requests, applied };
}

const drawReceipts = h => h.events.filter(event => event.type === 'tool_end' && event.toolName === 'draw_operations' && !event.isError)
  .map(event => event.result.result);

test('organising an existing canvas does not demand missing chemistry from its old draft', async () => {
  const live = mechanismScene(); live.arrows = []; // Existing draft has no electron flow at all.
  const h = mechanismHarness(live, [{ id: 'move', type: 'molecule.move', target: { molecule: 'nuc-m' }, dx: 1, dy: 0 }]);
  const result = await h.runtime.run('整理当前画布已有的反应机理图，不推演新机理');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  const receipt = drawReceipts(h)[0];
  assert.equal(receipt.steps[0].action, 'observe');
  assert.equal(receipt.steps[0].checks.chemistry.status, 'failed', 'the old chemistry draft really is incomplete');
  assert.equal(receipt.finishAccepted, true);
});

test('editing a tracked step and another step’s flow checks both real steps', async () => {
  const edit = { id: 'edit-first', type: 'reactionStep.modify', stepId: 'first', expectedVersion: 1, layout: { conditions: 'heat' } };
  for (const [target, expected] of [['mid-o', 'completed'], ['nuc', 'needs_continue']]) {
    const live = mechanismScene();
    const modifyFlow = { id: 'edit-flow', type: 'arrow.modify', arrowId: 'second-flow', target: { type: 'atom', atomId: target } };
    const h = mechanismHarness(live, [edit, modifyFlow], { completeScope: true });
    const result = await h.runtime.run('核对并调整这两个步骤');
    assert.equal(result.status, expected, target);
    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.applied[0], [edit, modifyFlow]);
    const receipt = drawReceipts(h)[0];
    assert.equal(receipt.steps[0].stepId, 'first');
    assert.equal(receipt.steps[0].checks.chemistry.status, 'passed');
    if (expected === 'completed') {
      assert.equal(receipt.finishAccepted, true);
      assert.equal(h.requests.length, 1);
    } else {
      assert.equal(receipt.finishAccepted, false);
      assert.match(receipt.finishRejected, /second-flow.*跨越了反应步骤/);
    }
  }
});
