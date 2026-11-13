import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';
import { createTaskCheckpoint } from '../task-ledger.js';
import fs from 'node:fs';

const prompt = '请整理当前画布上已有的 N-甲酰化机理。只整理现有内容，保留所有分子、原子、键、电子流和反应步骤的身份及化学连接，不增加、删除或改写任何化学对象，也不要继续后面的合成阶段。完成后简短说明整理结果。';
const badExplanation = '步骤1：甲酸 + 水 → 质子化甲酸 + 氢氧根。';
const clone = value => structuredClone(value);
const tool = (name, args) => ({ tool_calls: [{ index: 0, id: `${name}-call`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });
const tidy = (id = 'tidy', finish = true) => tool('draw_operations', { operations: [{ id, type: 'layout.tidy' }], finish });
function scene() {
  const atom = (id, label, implicitH = 0, charge = 0) => ({ id, label, implicitH, charge, radical: 0, x: 0, y: 0 });
  const atoms = [atom('acid-c', 'C', 1), atom('acid-o', 'O'), atom('acid-oh', 'O', 1),
    atom('donor-o', 'O', 2, 1), atom('h', 'H'), atom('product-c', 'C', 1), atom('product-o', 'O', 0, 1),
    atom('product-h', 'H'), atom('product-oh', 'O', 1), atom('water', 'O', 2)];
  const bond = (id, begin, end, order = 1) => ({ id, begin, end, order, stereo: 0 });
  return { sessionId: 'doc', revision: 1, atoms,
    bonds: [bond('co', 'acid-c', 'acid-o', 2), bond('coh', 'acid-c', 'acid-oh'), bond('oh', 'donor-o', 'h'),
      bond('product-co', 'product-c', 'product-o', 2), bond('product-oh', 'product-o', 'product-h'), bond('product-coh', 'product-c', 'product-oh')],
    molecules: [['acid-c', 'acid-o', 'acid-oh'], ['donor-o', 'h'], ['product-c', 'product-o', 'product-h', 'product-oh'], ['water']]
      .map((atoms, index) => ({ id: `mol:${index + 1}`, atoms })),
    lonePairs: [{ id: 'lp', ownerAtomId: 'acid-o', electronCount: 2, angle: 0 }],
    arrows: [{ id: 'attack', source: { type: 'lonePair', slotId: 'lp', ownerAtomId: 'acid-o' },
      target: { type: 'formingBond', atomA: 'acid-o', atomB: 'h' }, electronCount: 2 },
    { id: 'donate', source: { type: 'bond', bondId: 'oh', component: 'sigma' },
      target: { type: 'atom', atomId: 'donor-o' }, electronCount: 2 }],
    reactionSteps: [{ stepId: 's1', version: 1, reactants: ['acid-c', 'donor-o'], products: ['product-c', 'water'],
      checks: { layout: { status: 'passed', issues: [] } } }],
    reactionArrows: [{ id: '0', stepId: 's1', reactants: ['acid-c', 'donor-o'], products: ['product-c', 'water'],
      start: { x: 2, y: 1 }, end: { x: 4, y: 1 } }], texts: [], selection: { atoms: [], bonds: [] } };
}
function fixture(responses, { apply, receipt } = {}) {
  const h = { live: scene(), events: [], requests: [], applied: [], responses, target: new EventTarget() };
  const waiters = [];
  h.until = type => h.events.some(event => event.type === type) ? Promise.resolve()
    : new Promise(resolve => waiters.push({ type, resolve }));
  const bridge = {
    async beginRun() { return { sessionId: h.live.sessionId, context: clone(h.live) }; },
    async getContext() { return clone(h.live); }, async endRun() {}, async clearPreview() {}, async previewOperations() {},
    async getTaskCheckpoint() { return h.checkpoint ? clone(h.checkpoint) : null; },
    async setTaskCheckpoint(_id, checkpoint) { h.checkpoint = clone(checkpoint); return clone(checkpoint); },
    async pauseTaskCheckpoint(_id, reason) {
      if (h.checkpoint.status !== 'completed') Object.assign(h.checkpoint, { status: 'paused', pauseReason: reason });
      return clone(h.checkpoint);
    },
    async applyOperations(operations) {
      h.applied.push(clone(operations));
      for (const atom of h.live.atoms) atom.x += 1;
      await apply?.(operations, h);
      const result = { created: [], deleted: [], cascaded: [], warnings: [], steps: [],
        updated: operations.map(op => ({ id: op.id, type: op.type })) };
      return receipt ? receipt(result, operations, h) : result;
    },
  };
  h.runtime = new Runtime({ bridge, eventTarget: h.target,
    getConfig: async () => ({ configured: true, sessionToken: 'test', model: 'test' }),
    onEvent: event => {
      h.events.push(event);
      for (const waiter of waiters) if (waiter.type === event.type) waiter.resolve();
    },
    fetch: async (url, init) => {
      if (url === '/api/agent/cancel') return new Response('{}');
      h.requests.push(JSON.parse(init.body));
      const delta = responses[h.requests.length - 1];
      assert.ok(delta, 'no unbounded extra model requests');
      if (typeof delta === 'function') return delta();
      const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: `response-${h.requests.length}`, model: 'test',
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      return new Response(frame({ role: 'assistant', ...delta }, null) + frame({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  return h;
}
const names = request => request.tools.map(tool => tool.function.name);
const visible = h => h.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
const drawSchema = request => request.tools.find(tool => tool.function.name === 'draw_operations').function.parameters.properties.operations.items;

test('single tasks do not expose complete_phase and a hallucinated call cannot finish with an unresolved error', async () => {
  const h = fixture([tool('complete_phase', { phaseId: 'task', operationIds: [], summary: 'done' }), { content: '已完成。' }]);
  const result = await h.runtime.run('简单讨论当前画布');
  assert.equal(names(h.requests[0]).includes('complete_phase'), false);
  assert.ok(h.events.some(event => event.type === 'tool_end' && event.toolName === 'complete_phase' && event.isError));
  assert.equal(result.status, 'needs_continue');
});

test('planning creates a new phase registry with complete_phase and without plan_task', async () => {
  const h = fixture([tool('plan_task', { phases: [{ id: 'review', objective: '核对已有画布', kind: 'review' }] }),
    tool('read_canvas', {}), tool('complete_phase', { phaseId: 'review', operationIds: [], summary: 'read complete' })]);
  assert.equal((await h.runtime.run('核对当前已有画布')).status, 'completed');
  assert.ok(names(h.requests[0]).includes('plan_task')); assert.equal(names(h.requests[0]).includes('complete_phase'), false);
  assert.ok(names(h.requests[1]).includes('complete_phase')); assert.equal(names(h.requests[1]).includes('plan_task'), false);
  assert.ok(h.requests.every(request => !names(request).includes('complete_layout')));
});

test('tidy then read then complete_layout publishes one verified host completion without another canvas or undo operation', async () => {
  let committedCanvas;
  const h = fixture([tidy('semantic-layout', false), tool('read_canvas', {}),
    { content: badExplanation, ...tool('complete_layout', {}) }], { apply: (_ops, h) => { committedCanvas = clone(h.live); } });
  const result = await h.runtime.run(prompt);
  assert.equal(result.status, 'completed'); assert.equal(h.requests.length, 3); assert.equal(h.applied.length, 1);
  assert.deepEqual(h.live, committedCanvas); assert.equal(result.completedOperations, 1);
  assert.deepEqual(h.checkpoint.completedOperationIds, ['semantic-layout']);
  assert.equal(names(h.requests[0]).includes('complete_layout'), false);
  for (const request of h.requests.slice(1)) {
    assert.ok(names(request).includes('complete_layout'));
    const parameters = request.tools.find(tool => tool.function.name === 'complete_layout').function.parameters;
    assert.deepEqual(parameters.properties, {}); assert.equal(parameters.additionalProperties, false);
  }
  assert.equal(h.events.filter(event => event.layoutFacts).length, 1); assert.doesNotMatch(visible(h), /甲酸|氢氧根/);
  const completion = h.events.find(event => event.type === 'tool_end' && event.toolName === 'complete_layout');
  assert.equal(completion.isError, false); assert.equal(completion.result.scope, 'layout'); assert.equal(completion.result.finishAccepted, true);
  assert.ok(h.runtime._messages.some(message => message.role === 'user' &&
    (typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === prompt));
});

test('complete_layout rejects changed identity or current native geometry without another mutation', async () => {
  for (const change of [h => { h.live.atoms[0].charge++; }, h => { h.live.reactionArrows[0].end.y++; }]) {
    const h = fixture([tidy('layout', false), tool('complete_layout', {}), { content: '请检查尚未通过的排版。' }],
      { apply: (_ops, h) => change(h) });
    const result = await h.runtime.run(prompt);
    assert.equal(result.status, 'needs_continue'); assert.equal(h.applied.length, 1);
    assert.equal(h.events.some(event => event.layoutFacts), false);
    assert.ok(h.events.some(event => event.type === 'tool_end' && event.toolName === 'complete_layout' && event.isError));
  }
});

test('complete_layout cannot qualify before a new commit or through a stale executable tool handle', async () => {
  const h = fixture([tool('complete_layout', {}), { content: '请先提交新的语义排版。' }]);
  assert.equal((await h.runtime.run(prompt)).status, 'needs_continue');
  assert.equal(h.applied.length, 0); assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.equal(names(h.requests[0]).includes('complete_layout'), false);
  const run = { id: 'stale-handle', generation: 1, controller: new AbortController(), layoutOnly: true,
    freshLayoutCommit: true, checkpoint: { mode: 'single', status: 'active', completedOperationIds: [],
      phases: [{ status: 'active', operationIds: [] }] } };
  h.runtime._active = run; h.runtime._generation = 1;
  const completion = h.runtime._tools(run).find(tool => tool.name === 'complete_layout');
  assert.ok(completion); run.freshLayoutCommit = false;
  await assert.rejects(completion.execute(), /请先提交语义排版操作/);
});

test('a reopened layout task exposes complete_layout only after a fresh non-replayed commit', async () => {
  const h = fixture([tool('read_canvas', {}), tidy('new-layout', false), tool('complete_layout', {})]);
  h.checkpoint = savedLayoutProgress(); await h.runtime.restoreTaskCheckpoint();
  assert.equal(h.requests.length, 0);
  assert.equal((await h.runtime.continue()).status, 'completed');
  assert.equal(names(h.requests[0]).includes('complete_layout'), false);
  assert.equal(names(h.requests[1]).includes('complete_layout'), false);
  assert.ok(names(h.requests[2]).includes('complete_layout')); assert.equal(h.applied.length, 1);

  const replay = fixture([tool('draw_operations', { operations: [{ id: 'saved-layout-0', type: 'reactionStep.modify',
    stepId: 's1', expectedVersion: 1, layout: {} }], finish: false }), tool('read_canvas', {}), { content: '尚需新的排版确认。' }],
  { receipt: (result, operations, h) => ({ ...result, replayed: true, steps: [{ operationId: operations[0].id, replayed: true,
    stepId: 's1', version: 1, action: 'modify', after: clone(h.live.reactionSteps[0]) }] }) });
  replay.checkpoint = savedLayoutProgress(); await replay.runtime.restoreTaskCheckpoint();
  assert.equal((await replay.runtime.continue()).status, 'needs_continue');
  assert.ok(replay.requests.every(request => !names(request).includes('complete_layout')));
  assert.equal(replay.events.some(event => event.layoutFacts), false);
});

test('complete_layout must be the last tool call and cannot turn a partial response into completion', async () => {
  const calls = [...tool('complete_layout', {}).tool_calls,
    ...tool('read_canvas', {}).tool_calls.map(call => ({ ...call, index: 1 }))];
  const h = fixture([tidy('layout', false), { tool_calls: calls }, { content: '请先确认是否还需调整。' }]);
  assert.equal((await h.runtime.run(prompt)).status, 'needs_continue'); assert.equal(h.applied.length, 1);
  assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.ok(h.events.some(event => event.type === 'tool_end' && event.toolName === 'complete_layout' && event.isError));
});

test('plan_task disappears from the next real request after drawing starts', async () => {
  const h = fixture([tidy('first', false), { content: '整理完成。' }]);
  assert.equal((await h.runtime.run('整理当前画布')).status, 'completed');
  assert.ok(names(h.requests[0]).includes('plan_task')); assert.equal(names(h.requests[1]).includes('plan_task'), false);
  assert.ok(h.requests.every(request => !names(request).includes('complete_layout')));
});

function savedLayoutProgress() {
  const checkpoint = createTaskCheckpoint('saved-layout', prompt, [{ id: 'task', objective: '整理当前已有布局', kind: 'review' }], 'single');
  checkpoint.status = 'paused'; checkpoint.pauseReason = 'layout_pending'; checkpoint.requestIndex = 16;
  checkpoint.completedOperationIds = Array.from({ length: 16 }, (_, index) => `saved-layout-${index}`);
  checkpoint.phases[0].operationIds = checkpoint.completedOperationIds.slice();
  return checkpoint;
}

test('a restored single layout task with sixteen committed operations cannot replan and completes only after fresh layout and finish', async () => {
  const h = fixture([tool('read_canvas', {}), tidy('fresh-layout')]);
  h.checkpoint = savedLayoutProgress();
  await h.runtime.restoreTaskCheckpoint();
  assert.equal(h.requests.length, 0); assert.equal(h.runtime.isRunning, false); assert.equal(h.runtime.canContinue, true);
  assert.equal(h.runtime._resumeState.layoutState, undefined, 'in-memory layout qualification is never restored from the document');
  const result = await h.runtime.continue();
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.applied, [[{ id: 'fresh-layout', type: 'layout.tidy' }]]);
  assert.equal(h.requests.length, 2);
  for (const request of h.requests) {
    assert.equal(names(request).includes('plan_task'), false);
    assert.equal(names(request).includes('complete_phase'), false);
  }
  assert.ok(h.events.some(event => event.layoutFacts));
  assert.equal(h.checkpoint.taskId, 'saved-layout');
  assert.equal(h.checkpoint.completedOperationIds.length, 17);
});

test('restored committed IDs do not grant a new layout completion without a fresh geometry operation', async () => {
  const h = fixture([tool('read_canvas', {}), { content: '请确认是否需要继续调整准备支路？' }]);
  h.checkpoint = savedLayoutProgress();
  await h.runtime.restoreTaskCheckpoint();
  assert.equal((await h.runtime.continue()).status, 'needs_continue');
  assert.equal(h.applied.length, 0); assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.match(visible(h), /^排版核对尚未完成：\n请确认/);
});

test('planning eligibility also rejects phase-only persisted IDs and rechecks a previously obtained tool before execution', async () => {
  const h = fixture([]), checkpoint = savedLayoutProgress();
  checkpoint.completedOperationIds = []; checkpoint.phases[0].operationIds = [];
  const run = { id: 'planning-test', generation: 1, controller: new AbortController(), checkpoint,
    stopped: false, drawAttempted: false, applied: new Map() };
  checkpoint.status = 'active'; h.runtime._active = run; h.runtime._generation = 1;
  const plan = h.runtime._tools(run).find(tool => tool.name === 'plan_task');
  assert.ok(plan);
  checkpoint.phases[0].operationIds = ['committed-before-aggregate-merge'];
  assert.equal(h.runtime._tools(run).some(tool => tool.name === 'plan_task'), false);
  await assert.rejects(plan.execute('stale-tool', { phases: [{ id: 'new-plan', objective: 'replace progress' }] }), /已提交的任务进度不能被重新规划/);
});

test('the actual wrong chemical completion is suppressed only for a verified strict layout task', async () => {
  const h = fixture([{ content: badExplanation, ...tidy() }]);
  const result = await h.runtime.run(prompt);
  assert.equal(result.status, 'completed'); assert.equal(h.requests.length, 1, 'host facts satisfy the requested brief layout report');
  assert.doesNotMatch(visible(h), /甲酸|氢氧根|质子化/);
  assert.match(visible(h), /4 个分子、1 个反应步骤和 2 根电子流/);
  assert.match(visible(h), /化学属性、电子流端点及步骤连接已核对保持一致/);
  assert.equal(h.events.filter(event => event.layoutFacts).length, 1);
  assert.doesNotMatch(JSON.stringify(h.runtime._messages), /氢氧根/);
  assert.ok(h.runtime._messages.some(message => message.role === 'toolResult'));
  assert.ok(h.runtime._messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')));
});

test('strict whole-canvas requests offer only semantic executor layout operations in the actual SDK schema', async () => {
  const h = fixture([tidy()]);
  assert.equal((await h.runtime.run(prompt)).status, 'completed');
  const schemas = new Map(drawSchema(h.requests[0]).oneOf.map(schema => [schema.properties.type.const, schema]));
  assert.deepEqual([...schemas.keys()].sort(), ['arrow.modify', 'layout.tidy', 'lonePair.modify', 'reactionStep.modify']);
  const step = schemas.get('reactionStep.modify');
  assert.ok(step.required.includes('layout'));
  assert.deepEqual(Object.keys(step.properties.layout.properties).sort(), ['breakBefore', 'reactantPlacement', 'reagentPlacement']);
  assert.equal(step.properties.reactants, undefined); assert.equal(step.properties.products, undefined);
  const pair = schemas.get('lonePair.modify'), arrow = schemas.get('arrow.modify');
  assert.deepEqual(pair.properties.aim.enum, ['auto']); assert.ok(pair.required.includes('aim'));
  assert.equal(pair.properties.angle, undefined);
  assert.deepEqual(arrow.properties.mode.enum, ['auto']); assert.ok(arrow.required.includes('mode'));
  assert.equal(arrow.properties.bend, undefined); assert.equal(arrow.properties.source, undefined);
});

test('the receipt-derived replay of eleven destructive moves and a manual bend rejects atomically before bridge writes', async () => {
  const replay = JSON.parse(fs.readFileSync(new URL('./fixtures/observed-bad-layout-resume-operations.json', import.meta.url), 'utf8'));
  assert.equal(replay.operations.filter(operation => operation.type === 'molecule.move').length, 11);
  const h = fixture([tool('draw_operations', { operations: replay.operations, finish: true }), { content: '请使用语义步骤排版。' }]);
  const original = clone(h.live);
  assert.equal((await h.runtime.run(prompt)).status, 'needs_continue');
  assert.deepEqual(h.live, original); assert.equal(h.applied.length, 0);
  assert.deepEqual(h.checkpoint.completedOperationIds, []); assert.deepEqual(h.checkpoint.phases[0].operationIds, []);
  assert.equal(h.events.some(event => event.layoutFacts), false);
});

test('strict layout direct execution cannot bypass the restricted SDK schema with a raw move', async () => {
  let h;
  h = fixture([async () => {
    const run = h.runtime._active, original = clone(h.live);
    const draw = h.runtime._tools(run).find(tool => tool.name === 'draw_operations');
    await assert.rejects(draw.execute('untrusted-direct', { operations: [{ id: 'raw-move', type: 'molecule.move',
      target: { atoms: ['acid-c'] }, x: 51.3, y: 22 }], finish: true }, run.controller.signal, () => {}), /layout_scope_violation/);
    assert.deepEqual(h.live, original); assert.equal(h.applied.length, 0);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"需要继续使用步骤排版。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  }]);
  assert.equal((await h.runtime.run(prompt)).status, 'needs_continue'); assert.equal(h.applied.length, 0);
});

test('a strict layout stream cannot seal an early edit before an untrusted manual-move tail is rejected', async () => {
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'sealed-untrusted', model: 'test',
    choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
  const h = fixture([() => new Response(new ReadableStream({ async start(controller) {
    const prefix = '{"operations":[{"id":"early-tidy","type":"layout.tidy"},{"id":"early-seal","type":"step.seal"},';
    controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'sealed-untrusted',
      type: 'function', function: { name: 'draw_operations', arguments: prefix } }] })));
    await tail;
    controller.enqueue(new TextEncoder().encode(frame({ tool_calls: [{ index: 0, function: {
      arguments: '{"id":"bad-tail","type":"molecule.move","target":{"atoms":["acid-c"]},"x":51.3,"y":22}],"finish":true}',
    } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), { content: '请使用整体语义排版。' }]);
  const original = clone(h.live), pending = h.runtime.run(prompt);
  try {
    for (let index = 0; index < 100 && !h.runtime._active?.decoderErrors.has('sealed-untrusted'); index++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(h.runtime._active.decoderErrors.has('sealed-untrusted'));
    assert.equal(h.applied.length, 0); assert.deepEqual(h.live, original);
  } finally { release(); }
  assert.equal((await pending).status, 'needs_continue');
  assert.equal(h.applied.length, 0); assert.deepEqual(h.live, original);
  assert.deepEqual(h.checkpoint.completedOperationIds, []);
});

test('semantic step layout and automatic depiction edits can complete a strict layout task', async () => {
  const operations = [{ id: 'step-layout', type: 'reactionStep.modify', stepId: 's1', expectedVersion: 1,
    layout: { reactantPlacement: 'horizontal', reagentPlacement: 'left', breakBefore: true } },
  { id: 'auto-pair', type: 'lonePair.modify', lonePairId: 'lp', aim: 'auto' },
  { id: 'auto-flow', type: 'arrow.modify', arrowId: 'attack', mode: 'auto' }];
  const h = fixture([tool('draw_operations', { operations, finish: true })], {
    apply: (_operations, h) => { h.live.reactionSteps[0].version++; h.live.reactionSteps[0].layout = clone(operations[0].layout); },
  });
  assert.equal((await h.runtime.run(prompt)).status, 'completed');
  assert.deepEqual(h.applied, [operations]); assert.ok(h.events.some(event => event.layoutFacts));
});

test('explicit targeted H orientation and manual curve requests retain the full ordinary schema after a strict run', async () => {
  const strict = fixture([tidy()]); await strict.runtime.run(prompt);
  const operations = [{ id: 'orient', type: 'molecule.move', target: { atoms: ['h'] }, orientTowardAtomId: 'acid-o' },
    { id: 'manual-flow', type: 'arrow.modify', arrowId: 'attack', mode: 'manual', bend: 0.6 },
    { id: 'manual-pair', type: 'lonePair.modify', lonePairId: 'lp', angle: 30 }];
  const h = fixture([tool('draw_operations', { operations, finish: true })]);
  const targeted = '只调整这个显式氢的布局，用 orientTowardAtomId 指向受体氧，并将选中箭头设为 manual bend0.6。保留所有化学身份及化学连接，不增加、删除或改写任何化学对象。';
  assert.equal((await h.runtime.run(targeted)).status, 'completed');
  assert.deepEqual(h.applied, [operations]); assert.equal(h.events.some(event => event.layoutFacts), false);
  const schemas = new Map(drawSchema(h.requests[0]).oneOf.map(schema => [schema.properties.type.const, schema]));
  assert.ok(schemas.get('molecule.move').properties.x);
  assert.ok(schemas.get('molecule.move').properties.orientTowardAtomId);
  assert.ok(schemas.get('arrow.modify').properties.bend);
  assert.deepEqual(schemas.get('arrow.modify').properties.mode.enum, ['auto', 'manual']);
  assert.ok(schemas.get('lonePair.modify').properties.angle);
});

test('a real identity change fails the final layout check and cannot publish host success', async () => {
  const h = fixture([{ content: badExplanation, ...tidy() }], { apply: (_ops, h) => { h.live.atoms[0].charge++; } });
  const result = await h.runtime.run(prompt);
  assert.equal(result.status, 'needs_continue');
  assert.ok(h.events.some(event => event.type === 'error' && event.code === 'LAYOUT_VERIFICATION_FAILED'));
  assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.match(visible(h), /^排版核对尚未完成/);
});

test('a partial layout commit followed by a clarification remains pending until an explicit accepted finish', async () => {
  const h = fixture([tidy('partial', false), { content: '已调整一部分，请问准备支路应放在上方还是下方？' }]);
  const result = await h.runtime.run(prompt);
  assert.equal(h.applied.length, 1); assert.equal(result.status, 'needs_continue');
  assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.match(visible(h), /^排版核对尚未完成：\n已调整一部分，请问/);
  assert.deepEqual(h.events.find(event => event.type === 'tool_end' && event.toolName === 'draw_operations').result.result.nextAction,
    { pendingFinish: true, acceptedCompletion: 'complete_layout', reason: 'user_goal_not_confirmed' });
  assert.ok(h.requests[1].messages.some(message => typeof message.content === 'string' &&
    message.content.includes('"acceptedCompletion":"complete_layout"')), 'typed next action reaches the real SDK request');
});

test('a phased layout verifies identity before completing its durable final phase', async () => {
  const h = fixture([tool('plan_task', { phases: [{ id: 'layout', objective: '整理当前内容' }] }), tidy('bad-layout'),
    { content: '排版核对未通过，请检查。' }, { content: '需要用户先检查。' }],
  { apply: (_ops, h) => { h.live.atoms[0].charge++; } });
  const result = await h.runtime.run(prompt);
  assert.equal(result.status, 'needs_continue');
  assert.equal(h.runtime.taskCheckpoint.status, 'paused');
  assert.equal(h.runtime.taskCheckpoint.phases[0].status, 'active');
  assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.ok(h.requests.every(request => !names(request).includes('complete_layout')));
});

test('chemical operations in a strict layout task are rejected before any bridge mutation', async () => {
  const h = fixture([tool('draw_operations', { operations: [{ id: 'charge', type: 'atom.modify', atomId: 'acid-c', charge: 1 }], finish: true }),
    { content: '请确认是否允许改变电荷？' }]);
  const result = await h.runtime.run(prompt);
  assert.equal(result.status, 'needs_continue'); assert.equal(h.applied.length, 0);
  assert.ok(h.events.some(event => event.type === 'tool_end' && event.diagnostic?.code === 'layout_scope_violation'));
  assert.match(visible(h), /排版核对尚未完成：\n请确认/);
});

test('a zero-operation clarification remains visible as pending and a later manual chemical edit becomes the continued baseline', async () => {
  const h = fixture([{ content: '请问准备支路应放在主线上方还是下方？' }, tidy('after-user-edit')]);
  assert.equal((await h.runtime.run(prompt)).status, 'needs_continue');
  assert.match(visible(h), /排版核对尚未完成：\n请问准备支路/);
  h.live.atoms[0].isotope = 13;
  h.target.dispatchEvent(new CustomEvent('molstudio:agent-canvas-change', { detail: { source: 'manual', reason: 'edit' } }));
  assert.equal((await h.runtime.continue()).status, 'completed');
  assert.equal(h.live.atoms[0].isotope, 13);
});

test('automatic recovery keeps the original layout fingerprint instead of blessing an earlier identity mutation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const upstream = () => new Response('data: {"error":{"code":"upstream_stream_error"}}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  const h = fixture([tidy('before-failure', false), upstream, tidy('after-failure')], {
    apply: (_ops, h) => { if (h.applied.length === 1) h.live.atoms[0].charge++; },
  });
  const pending = h.runtime.run(prompt); await h.until('recovery_scheduled'); t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.recoveryAttempts, 1); assert.equal(result.status, 'needs_continue');
  assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.ok(h.events.some(event => event.code === 'LAYOUT_VERIFICATION_FAILED'));
});

test('ordinary chemistry reports retain model explanation rather than receiving a host layout replacement', async () => {
  const answer = '羰基氧的孤对接受 H3O+ 的质子，供体 O-H 键电子回到供体氧。';
  const h = fixture([{ content: answer }]);
  assert.equal((await h.runtime.run('请解释甲酸质子化的化学机理')).status, 'completed');
  assert.equal(visible(h), answer); assert.equal(h.events.some(event => event.layoutFacts), false);
  assert.equal(names(h.requests[0]).includes('complete_layout'), false);
});
