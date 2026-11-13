import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';

const clone = value => structuredClone(value);
const sides = prefix => ({ reactants: [prefix + 'nuc', prefix + 'carbon'], products: [prefix + 'product-carbon', prefix + 'bromide'] });
const create = (id = 'create', prefix = '') => ({ id, type: 'reactionStep.create', ...sides(prefix), layout: {} });
const modify = (id = 'modify', stepId = 'create', expectedVersion = 1, layout = { conditions: '' }) =>
  ({ id, type: 'reactionStep.modify', stepId, expectedVersion, layout });
const fullMechanism = '画出完整 SN2 机理';
const passed = { status: 'passed', issues: [] };

function scene(prefix = '') {
  const atom = (id, label, implicitH, charge = 0) => ({ id: prefix + id, label, implicitH, charge });
  return {
    atoms: [atom('nuc', 'O', 1, -1), atom('carbon', 'C', 3), atom('bromine', 'Br', 0),
      atom('product-carbon', 'C', 3), atom('product-oxygen', 'O', 1), atom('bromide', 'Br', 0, -1)],
    bonds: [{ id: prefix + 'substrate-bond', begin: prefix + 'carbon', end: prefix + 'bromine', order: 1 },
      { id: prefix + 'product-bond', begin: prefix + 'product-carbon', end: prefix + 'product-oxygen', order: 1 }],
    molecules: [['nuc'], ['carbon', 'bromine'], ['product-carbon', 'product-oxygen'], ['bromide']]
      .map((ids, i) => ({ id: prefix + 'mol' + i, atoms: ids.map(id => prefix + id) })),
    lonePairs: [{ id: prefix + 'lp', ownerAtomId: prefix + 'nuc' }],
    arrows: [{ id: prefix + 'attack', source: { type: 'lonePair', slotId: prefix + 'lp', ownerAtomId: prefix + 'nuc' },
      target: { type: 'formingBond', atomA: prefix + 'nuc', atomB: prefix + 'carbon' }, electronCount: 2 },
    { id: prefix + 'leave', source: { type: 'bond', bondId: prefix + 'substrate-bond', component: 'sigma' },
      target: { type: 'atom', atomId: prefix + 'bromine' }, electronCount: 2 }],
  };
}

const tool = (operations, finish = true, id = 'call') => ({ tool_calls: [{ index: 0, id, type: 'function',
  function: { name: 'draw_operations', arguments: JSON.stringify({ operations, finish }) } }] });
const read = { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_canvas', arguments: '{}' } }] };

function harness(responses, options = {}) {
  const live = { sessionId: 'doc', revision: 1, ...scene(), reactionSteps: [], reactionArrows: [],
    selection: { atoms: [], bonds: [] }, ...clone(options.canvas || {}) };
  const events = [], requests = [], applied = [], aliases = new Map();
  const ledger = new Map();
  let serial = 0;
  const bridge = {
    async getContext() { await options.beforeContext?.(live); return clone(live); },
    async beginRun() {}, async endRun() {}, async previewOperations() {}, async clearPreview() {},
    async applyOperations(operations) {
      applied.push(clone(operations));
      const result = { created: [], updated: [], deleted: [], cascaded: [], warnings: [], steps: [], stepMapping: {} };
      for (const op of operations) {
        if (ledger.has(op.id)) {
          const prior = ledger.get(op.id);
          assert.deepEqual(op, prior.operation);
          const after = clone(live.reactionSteps.find(step => step.stepId === prior.step.stepId) || null);
          result.steps.push({ ...clone(prior.step), version: after?.version ?? prior.step.version, after, replayed: true });
          if (op.type === 'reactionStep.create') result.stepMapping[op.id] = prior.step.stepId;
          result.replayed = true;
          continue;
        }
        const action = op.type.split('.')[1];
        const stepId = action === 'create' ? 'stable-step-' + (++serial) : aliases.get(op.stepId) || op.stepId;
        const before = clone(live.reactionSteps.find(step => step.stepId === stepId) || null);
        if (action !== 'create' && (!before || op.expectedVersion !== before.version)) {
          throw Object.assign(new Error('反应步骤版本已变化'), { code: 'step_version_conflict', operationId: op.id });
        }
        let after = null;
        const version = before ? before.version + 1 : 1;
        const checks = { layout: clone(passed), chemistry: { status: 'pending', issues: [] } };
        if (options.layoutFailure?.(op)) checks.layout = { status: 'failed', issues: [{ code: 'step_overlap', message: '反应物与相邻步骤重叠' }] };
        if (action !== 'delete') {
          after = { ...before, stepId, version,
            reactants: op.reactants ?? before?.reactants, products: op.products ?? before?.products,
            layout: { ...before?.layout, ...op.layout }, reactionArrowId: before?.reactionArrowId ?? serial,
            checks,
          };
          after.conditions = after.layout.conditions;
          live.reactionSteps = live.reactionSteps.filter(step => step.stepId !== stepId).concat(after);
          live.reactionArrows = live.reactionArrows.filter(step => step.stepId !== stepId)
            .concat({ id: after.reactionArrowId, stepId, reactants: after.reactants, products: after.products });
        } else {
          live.reactionSteps = live.reactionSteps.filter(step => step.stepId !== stepId);
          live.reactionArrows = live.reactionArrows.filter(step => step.stepId !== stepId);
        }
        const key = action === 'create' ? 'created' : action === 'modify' ? 'updated' : 'deleted';
        result[key].push({ id: op.id, type: op.type, stepId, version, reactionArrowId: after?.reactionArrowId ?? before?.reactionArrowId });
        result.steps.push({ operationId: op.id, stepId, version, action, before, after: clone(after),
          layout: { status: checks.layout.status }, checks });
        ledger.set(op.id, { operation: clone(op), step: clone(result.steps.at(-1)) });
        if (action === 'create') { aliases.set(op.id, stepId); result.stepMapping[op.id] = stepId; }
      }
      if (options.freshReceiptsFirst) result.steps.sort((a, b) => Number(!!a.replayed) - Number(!!b.replayed));
      return result;
    },
  };
  const runtime = new Runtime({ bridge, getConfig: async () => ({ configured: true, sessionToken: 'unit-test', model: 'unit-test', baseUrl: 'https://unit.invalid/v1' }),
    eventTarget: new EventTarget(), onEvent: event => events.push(event),
    fetch: async (url, init) => {
      assert.equal(url, '/api/agent/model');
      requests.push(JSON.parse(init.body));
      options.beforeResponse?.(live, requests.length);
      const delta = responses[requests.length - 1] || { content: '请检查所报告的问题。' };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const [part, finish] of [[{ role: 'assistant', ...delta }, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'unit', model: 'unit-test',
            choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return { runtime, live, requests, events, applied };
}

const receipts = h => h.events.filter(event => event.type === 'tool_end' && event.toolName === 'draw_operations' && !event.isError).map(event => event.result.result);

test('semantic step creation uses stable identity and computes chemistry from the actual snapshot', async () => {
  const h = harness([tool([create()])]);
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  const [receipt] = receipts(h);
  assert.deepEqual(receipt.stepMapping, { create: 'stable-step-1' });
  assert.equal(receipt.steps[0].checks.chemistry.status, 'passed');
  assert.equal(receipt.finishAccepted, true);
  assert.match(h.requests[0].messages[0].content, /reactionStep.modify.*expectedVersion/);
});

test('modifying a committed step preserves completion tracking and exposes before/after versions', async () => {
  const h = harness([tool([create()], false, 'create-call'), tool([modify()], true, 'modify-call')]);
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'completed');
  assert.equal(h.live.reactionSteps.length, 1);
  const receipt = receipts(h).at(-1);
  assert.equal(receipt.steps[0].action, 'modify');
  assert.equal(receipt.steps[0].before.version, 1);
  assert.equal(receipt.steps[0].after.version, 2);
  assert.equal(receipt.steps[0].checks.chemistry.status, 'passed');
  assert.equal(receipt.finishAccepted, true);
});

test('relative reagent placement survives create and versioned modify receipts in both directions', async () => {
  const initial = { ...create(), layout: { reagentPlacement: 'left', reactantPlacement: 'auto' } };
  const h = harness([tool([initial], false, 'create-call'),
    tool([modify('move-right', 'create', 1, { reagentPlacement: 'right' })], false, 'right-call'),
    tool([modify('move-left', 'create', 2, { reagentPlacement: 'left' })], true, 'left-call')]);
  const result = await h.runtime.run('画出完整SN2机理，小试剂放主骨架左侧');
  assert.equal(result.status, 'completed');
  const changes = receipts(h).map(receipt => receipt.steps[0]);
  assert.equal(changes[0].after.layout.reagentPlacement, 'left');
  assert.equal(changes[1].before.layout.reagentPlacement, 'left');
  assert.equal(changes[1].after.layout.reagentPlacement, 'right');
  assert.equal(changes[2].before.layout.reagentPlacement, 'right');
  assert.equal(changes[2].after.layout.reagentPlacement, 'left');
  assert.equal(changes[2].after.layout.reactantPlacement, 'auto');
  assert.equal(h.live.reactionSteps[0].version, 3);
});

test('intentional deletion removes the previous completion target instead of reporting a lost connector', async () => {
  const deletion = { id: 'delete', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  const h = harness([tool([create()], false, 'create-call'), tool([deletion], true, 'delete-call')]);
  const result = await h.runtime.run('删除这个已有步骤');
  assert.equal(result.status, 'completed');
  assert.equal(h.live.reactionSteps.length, 0);
  const receipt = receipts(h).at(-1);
  assert.equal(receipt.steps[0].version, 2);
  assert.equal(receipt.steps[0].after, null);
  assert.equal(receipt.finishAccepted, true);
});

test('a requested drawing cannot become complete by deleting every reaction step', async () => {
  const deletion = { id: 'delete', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  for (const prompt of [fullMechanism, '只画这一步机理', '只画反应路线']) {
    const h = harness([tool([create()], false, 'create-call'), tool([deletion], true, 'delete-call'),
      { content: '步骤已删除。' }]);
    const result = await h.runtime.run(prompt);
    assert.equal(result.status, 'needs_continue', prompt);
    assert.equal(h.live.reactionSteps.length, 0, prompt);
    const receipt = receipts(h).at(-1);
    assert.equal(receipt.steps[0].action, 'delete', prompt);
    assert.equal(receipt.finishAccepted, false, prompt);
    assert.match(receipt.finishRejected, /直反应箭头.*反应物.*产物/, prompt);
  }
});

test('a reported complete mechanism still needs a live step after all declared steps are deleted', async () => {
  const deletion = { id: 'delete', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  const declaration = tool([create()], false, 'create-call');
  const args = JSON.parse(declaration.tool_calls[0].function.arguments);
  args.taskScope = { type: 'completeMechanism' };
  declaration.tool_calls[0].function.arguments = JSON.stringify(args);
  const h = harness([declaration, tool([deletion], true, 'delete-call'), { content: '步骤已删除。' }]);
  const result = await h.runtime.run('处理这张画布');
  assert.equal(result.status, 'needs_continue');
  assert.equal(receipts(h).at(-1).finishAccepted, false);
});

test('failed step layout blocks finish and identifies the stable step/version for a bounded repair', async () => {
  const h = harness([tool([create()], true, 'create-call'), tool([modify('repair', 'stable-step-1', 1, { reactantPlacement: 'vertical' })], true, 'repair-call')],
    { layoutFailure: op => op.type === 'reactionStep.create' });
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 2);
  const [failed, repaired] = receipts(h);
  assert.equal(failed.finishAccepted, false);
  assert.match(failed.finishRejected, /stable-step-1 v1.*重叠/);
  assert.equal(failed.invalidReactionSteps[0].checks.layout.issues[0].code, 'step_overlap');
  assert.match(failed.nextAction, /reactionStep.modify/);
  assert.equal(repaired.finishAccepted, true);
  assert.equal(h.live.reactionSteps.length, 1);
  assert.equal(h.live.reactionSteps[0].version, 2);
});

test('an edit can succeed while its chemistry check reports missing flow outside a mechanism request', async () => {
  const existing = { stepId: 'existing', version: 3, ...sides(''), reactionArrowId: 0,
    layout: {}, checks: { layout: passed, chemistry: passed } };
  const h = harness([tool([modify('edit', 'existing', 3, { breakBefore: true })])], {
    canvas: { arrows: [], reactionSteps: [existing], reactionArrows: [{ id: 0, stepId: 'existing', ...sides('') }] },
  });
  const result = await h.runtime.run('把第二步换到下一行');
  assert.equal(result.status, 'completed');
  const [receipt] = receipts(h);
  assert.equal(receipt.steps[0].checks.chemistry.status, 'failed');
  assert.equal(receipt.steps[0].checks.chemistry.issues[0].code, 'missing_electron_flow');
  assert.equal(receipt.finishAccepted, true);
});

test('a mechanism completion recomputes chemical coverage instead of trusting a passed host description', async () => {
  const existing = { stepId: 'existing', version: 1, ...sides(''), reactionArrowId: 0,
    layout: {}, checks: { layout: passed, chemistry: passed } };
  const h = harness([tool([modify('edit', 'existing', 1, { conditions: 'SN2' })]), { content: '需要补电子流。' }], {
    canvas: { arrows: [], reactionSteps: [existing], reactionArrows: [{ id: 0, stepId: 'existing', ...sides('') }] },
  });
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'needs_continue');
  const [receipt] = receipts(h);
  assert.equal(receipt.finishAccepted, false);
  assert.equal(receipt.steps[0].checks.chemistry.status, 'failed');
  assert.equal(receipt.missingElectronFlowSteps[0].stepId, 'existing');
  assert.equal(receipt.missingElectronFlowSteps[0].version, 2);
});

test('read_canvas returns per-step chemistry recomputed from current entities', async () => {
  const existing = { stepId: 'existing', version: 1, ...sides(''), reactionArrowId: 0,
    layout: {}, checks: { layout: passed, chemistry: { status: 'pending', issues: [] } } };
  const h = harness([read, { content: '已核对。' }], { canvas: { reactionSteps: [existing] } });
  const result = await h.runtime.run('检查这一步');
  assert.equal(result.status, 'completed');
  const context = h.events.find(event => event.type === 'tool_end' && event.toolName === 'read_canvas').result.context;
  assert.equal(context.reactionSteps[0].checks.chemistry.status, 'passed');
});

test('sealed semantic steps keep all stable mappings and their checked receipts', async () => {
  const second = scene('second-');
  const first = scene();
  const canvas = Object.fromEntries(Object.keys(first).map(key => [key, [...first[key], ...second[key]]]));
  const h = harness([tool([create('first'), { id: 'seal-first', type: 'step.seal' }, create('second', 'second-'), { id: 'seal-second', type: 'step.seal' }])], { canvas });
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'completed');
  const [receipt] = receipts(h);
  assert.equal(receipt.steps.length, 2);
  assert.deepEqual(receipt.stepMapping, { first: 'stable-step-1', second: 'stable-step-2' });
  assert.equal(receipt.steps.every(step => step.checks.chemistry.status === 'passed'), true);
  assert.equal(h.events.filter(event => event.type === 'step_commit').length, 2);
});

test('an identical semantic operation is replayed by the document ledger with its stable receipt', async () => {
  const h = harness([tool([create()], false, 'first'), tool([create()], true, 'replay')]);
  const result = await h.runtime.run(fullMechanism);
  assert.equal(result.status, 'completed');
  assert.equal(h.applied.length, 2);
  assert.equal(h.live.reactionSteps.length, 1);
  assert.equal(h.live.reactionSteps[0].version, 1);
  const receipt = receipts(h).at(-1);
  assert.equal(receipt.steps[0].replayed, true);
  assert.deepEqual(receipt.stepMapping, { create: 'stable-step-1' });
});

test('replaying an undone create cannot claim that a missing semantic step was drawn', async () => {
  const h = harness([tool([create()], false, 'first'), tool([create()], true, 'replay'), { content: '原步骤已被撤销。' }], {
    beforeResponse(live, count) {
      if (count === 2) { live.reactionSteps = []; live.reactionArrows = []; }
    },
  });
  const result = await h.runtime.run('添加一个步骤');
  assert.equal(result.status, 'needs_continue');
  const replay = receipts(h).at(-1);
  assert.equal(replay.steps[0].after, null);
  assert.equal(replay.finishAccepted, false);
  assert.equal(replay.invalidReactionSteps[0].stepId, 'stable-step-1');
  assert.deepEqual(replay.invalidReactionSteps[0].missing, ['connector']);
});

test('replaying an undone delete cannot claim that a still-present semantic step was removed', async () => {
  const deletion = { id: 'delete', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  let saved;
  const h = harness([tool([create()], false, 'first'), tool([deletion], false, 'delete-call'),
    tool([deletion], true, 'replay'), { content: '该删除已被撤销。' }], {
    beforeResponse(live, count) {
      if (count === 2) saved = { steps: clone(live.reactionSteps), arrows: clone(live.reactionArrows) };
      if (count === 3) { live.reactionSteps = saved.steps; live.reactionArrows = saved.arrows; }
    },
  });
  const result = await h.runtime.run('删除已画的步骤');
  assert.equal(result.status, 'needs_continue');
  const replay = receipts(h).at(-1);
  assert.equal(replay.steps[0].after.stepId, 'stable-step-1');
  assert.equal(replay.finishAccepted, false);
  assert.match(replay.finishRejected, /删除操作已被撤销.*stable-step-1 v1/);
  assert.match(replay.nextAction, /new operation id/);
});

test('a fresh deletion wins over historical create replay in either input or receipt order', async () => {
  const deletion = { id: 'delete-now', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  for (const [label, operations, freshReceiptsFirst] of [
    ['retry then delete', [create(), deletion], false],
    ['delete then retry', [deletion, create()], false],
    ['old bridge fresh-first receipt order', [create(), deletion], true],
  ]) {
    const h = harness([tool([create()], false, 'first'), tool(operations, true, 'mixed')], { freshReceiptsFirst });
    const result = await h.runtime.run('删除这个步骤');
    assert.equal(result.status, 'completed', label);
    assert.equal(h.live.reactionSteps.length, 0, label);
    assert.equal(receipts(h).at(-1).finishAccepted, true, label);
    assert.equal(h.requests.length, 2, label);
  }
});

test('a fresh modification wins over a historical undone-delete replay in either input order', async () => {
  const deletion = { id: 'old-delete', type: 'reactionStep.delete', stepId: 'create', expectedVersion: 1 };
  for (const replayFirst of [false, true]) {
    let saved;
    const change = modify('modify-current', 'create', 1, { conditions: 'kept' });
    const h = harness([tool([create()], false, 'first'), tool([deletion], false, 'delete'),
      tool(replayFirst ? [deletion, change] : [change, deletion], true, 'mixed')], {
      beforeResponse(live, count) {
        if (count === 2) saved = { steps: clone(live.reactionSteps), arrows: clone(live.reactionArrows) };
        if (count === 3) { live.reactionSteps = saved.steps; live.reactionArrows = saved.arrows; }
      },
    });
    const result = await h.runtime.run('保留这个步骤并修改条件');
    assert.equal(result.status, 'completed');
    assert.equal(h.live.reactionSteps[0].version, 2);
    assert.equal(h.live.reactionSteps[0].conditions, 'kept');
    assert.equal(receipts(h).at(-1).finishAccepted, true);
    assert.equal(h.requests.length, 3);
  }
});

test('stopping during the post-commit snapshot preserves the committed semantic operation', async () => {
  let release, reached;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const h = harness([tool([create()])], { async beforeContext(live) {
    if (live.reactionSteps.length) { reached(); await blocked; }
  } });
  const running = h.runtime.run(fullMechanism);
  await entered;
  h.runtime.stop();
  release();
  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(result.completedOperations, 1);
  assert.equal(h.live.reactionSteps.length, 1);
});
