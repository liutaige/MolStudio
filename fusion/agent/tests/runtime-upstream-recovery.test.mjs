import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';
import { validateTaskCheckpoint } from '../task-ledger.js';

const config = { configured: true, sessionToken: 'local-test', model: 'synthetic-recovery-model',
  baseUrl: 'https://upstream.invalid/v1', provider: 'openai-compatible',
  generation: { profile: 'deepseek', effort: 'low', maxOutputTokens: 16384 } };
const encoder = new TextEncoder();
const frame = (delta, finish_reason = null, usage) => 'data: ' + JSON.stringify({ id: 'recovery-fixture',
  model: config.model, created: 0, choices: [{ index: 0, delta, finish_reason }], ...(usage && { usage }) }) + '\n\n';
const upstreamError = 'data: {"error":{"type":"upstream_error","code":"upstream_stream_error","message":"private upstream diagnostic"}}\n\n';
const molecule = id => ({ id, type: 'molecule.add', smiles: '[CH4:1]' });
const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } }] });
const draw = (...ids) => call('draw_operations', { operations: ids.map(molecule), finish: true });
function response(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}
function success(delta = { content: '已完成。' }) {
  return response(frame({ role: 'assistant', ...delta }) + frame({}, delta.tool_calls ? 'tool_calls' : 'stop',
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + 'data: [DONE]\n\n');
}
function interrupted(init, h, { sealed } = {}) {
  let sent = false;
  const committed = h.events.filter(event => event.type === 'step_commit').length;
  return response(new ReadableStream({ async pull(controller) {
    if (!sent) {
      sent = true;
      const delta = sealed ? { role: 'assistant', tool_calls: [{ index: 0, id: 'partial-call', type: 'function', function: {
        name: 'draw_operations', arguments: '{"operations":[' + JSON.stringify(molecule(sealed)) +
          ',{"id":"seal-' + sealed + '","type":"step.seal"},{"id":"unfinished","type":"molecule.add","smiles":"',
      } }] } : { role: 'assistant', reasoning_content: 'private interrupted thinking' };
      controller.enqueue(encoder.encode(frame(delta)));
    } else {
      if (sealed) await h.until('step_commit', committed + 1);
      controller.enqueue(encoder.encode(upstreamError + 'data: [DONE]\n\n')); controller.close();
    }
  } }));
}
function fixture(responses, { onEvent, endRun, persist, initialState, getConfig } = {}) {
  const state = initialState || { checkpoint: null, atoms: [], sessionId: 'document-1' };
  const h = { state, events: [], requests: [], mutations: [], starts: [], ends: [], target: new EventTarget() };
  const waiters = [];
  h.until = (type, count = 1) => {
    const matches = h.events.filter(event => event.type === type);
    return matches.length >= count ? Promise.resolve(matches[count - 1])
      : new Promise(resolve => waiters.push({ type, count, resolve }));
  };
  const bridge = {
    async beginRun(runId, settings) {
      assert.equal(h.ends.length, h.starts.length, 'old bridge run has ended before the new run begins');
      if (settings.expectedSessionId) assert.equal(settings.expectedSessionId, state.sessionId);
      h.starts.push({ runId, settings });
      return { sessionId: state.sessionId, context: await this.getContext(),
        ...(settings.resumeRunId && { resumeAliases: { atoms: Object.fromEntries(state.atoms.map(atom => [atom.ref, atom.id])) } }) };
    },
    async endRun(runId, result) { await endRun?.(runId, result, h); h.ends.push({ runId, result }); },
    async getContext() { return { sessionId: state.sessionId, atoms: state.atoms, bonds: [], arrows: [], reactionSteps: [],
      revision: h.mutations.length, molecules: state.atoms.map(atom => ({ id: `mol-${atom.id}`, atoms: [atom.id] })) }; },
    async getTaskCheckpoint() { return structuredClone(state.checkpoint); },
    async setTaskCheckpoint(runId, value) {
      await persist?.(value, h);
      state.checkpoint = validateTaskCheckpoint(value); return structuredClone(state.checkpoint);
    },
    async pauseTaskCheckpoint(runId, reason) {
      state.checkpoint = { ...state.checkpoint, status: 'paused', pauseReason: reason };
      return structuredClone(state.checkpoint);
    },
    async applyOperations(operations) {
      h.mutations.push(...operations);
      const created = operations.map(op => ({ id: op.id, type: op.type, atoms: [{ id: `stable-${op.id}`, ref: `${op.id}:1`, label: 'C' }] }));
      state.atoms.push(...created.flatMap(item => item.atoms));
      return { created, updated: [], deleted: [], summary: 'Committed' };
    },
    async previewOperations() {}, async clearPreview() {},
  };
  h.bridge = bridge;
  h.runtime = new Runtime({ bridge, eventTarget: h.target, getConfig: getConfig || (async () => structuredClone(config)),
    onEvent: event => {
      h.events.push(event); onEvent?.(event, h);
      for (const waiter of [...waiters]) if (waiter.type === event.type && h.events.filter(item => item.type === event.type).length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event);
      }
    },
    fetch: async (url, init) => {
      if (url === '/api/agent/cancel') return new Response('{}');
      assert.equal(url, '/api/agent/model');
      const body = JSON.parse(init.body); h.requests.push({ body, requestId: init.headers['X-MolStudio-Agent-Request'] });
      assert.equal(body.molstudio.requestIndex, state.checkpoint.requestIndex, 'checkpoint persists before request dispatch');
      const next = responses[Math.min(h.requests.length - 1, responses.length - 1)];
      return typeof next === 'function' ? next(init, h) : success(next);
    } });
  return h;
}
const canvasOf = request => JSON.parse(request.body.messages[0].content.split('Current canvas context (JSON):\n')[1]);

test('confirmed upstream interruption starts one new request from a persisted zero-edit goal, without replaying thinking', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture([interrupted, { content: '恢复后回答。' }]);
  const pending = h.runtime.run('解释当前反应');
  const scheduled = await h.until('recovery_scheduled');
  assert.equal(scheduled.delayMs, 1000); assert.equal(h.runtime.isRunning, true);
  assert.equal(h.state.checkpoint.goal, '解释当前反应'); assert.equal(h.state.checkpoint.status, 'paused');
  t.mock.timers.tick(999); await Promise.resolve(); assert.equal(h.requests.length, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.status, 'completed'); assert.equal(result.recoveryAttempts, 1); assert.equal(h.requests.length, 2);
  assert.equal(result.turns, 2); assert.equal(result.httpRequests, 2);
  assert.equal(h.events.filter(event => event.type === 'run_end').at(-1).httpRequests, 2);
  assert.notEqual(h.requests[0].requestId, h.requests[1].requestId);
  assert.equal(h.requests[0].body.molstudio.taskId, h.requests[1].body.molstudio.taskId);
  assert.equal(h.requests[1].body.molstudio.requestIndex, 2);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /private|reasoning_content/);
  assert.equal(h.events.filter(event => event.type === 'error' && event.code === 'upstream_stream_error').length, 1);
  assert.equal(h.runtime.isRunning, false);
});

test('recovery awaits checkpoint merge and bridge cleanup, preserving sealed objects, live aliases and consumed IDs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = fixture([(init, h) => interrupted(init, h, { sealed: 'first' }), draw('first', 'second')], {
    endRun: async (runId, result, h) => { if (!h.ends.length) { entered(); await gate; } },
  });
  const pending = h.runtime.run('画两个示例分子'); await blocked;
  t.mock.timers.tick(10000); await Promise.resolve(); assert.equal(h.requests.length, 1);
  assert.equal(h.events.some(event => event.type === 'recovery_scheduled'), false);
  release(); await h.until('recovery_scheduled'); t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.status, 'completed'); assert.equal(result.recoveryAttempts, 1);
  assert.deepEqual(h.mutations.map(op => op.id), ['first', 'second']);
  const canvas = canvasOf(h.requests[1]);
  assert.ok(canvas.atoms.some(atom => atom.id === 'stable-first'));
  assert.equal(canvas.resumeAliases.atoms['first:1'], 'stable-first');
  assert.deepEqual(canvas.consumedOperationIds, ['first']);
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /unfinished|partial-call/);
});

test('automatic recovery is bounded to two attempts even when every interrupted run commits another object', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const responses = ['one', 'two', 'three'].map(sealed => (init, h) => interrupted(init, h, { sealed }));
  const h = fixture(responses);
  const pending = h.runtime.run('画三个示例分子');
  await h.until('recovery_scheduled', 1); t.mock.timers.tick(1000);
  const second = await h.until('recovery_scheduled', 2);
  assert.equal(second.delayMs, 3000); t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(result.status, 'needs_continue'); assert.equal(result.recoveryAttempts, 2); assert.equal(result.canContinue, true);
  assert.equal(h.requests.length, 3); assert.deepEqual(h.mutations.map(op => op.id), ['one', 'two', 'three']);
  assert.equal(h.events.filter(event => event.type === 'recovery_exhausted').length, 1);
  t.mock.timers.tick(100000); await Promise.resolve(); assert.equal(h.requests.length, 3);
  responses.push({ content: '明确继续后完成。' });
  assert.equal((await h.runtime.continue()).status, 'completed'); assert.equal(h.requests.length, 4);
});

test('a recovery after a real phase boundary retains the completed phase and starts only the current phase', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture([call('plan_task', { phases: [{ id: 'first', objective: '画第一个示例分子' },
    { id: 'second', objective: '画第二个示例分子' }] }), draw('first-op'), interrupted, draw('second-op')]);
  const pending = h.runtime.run('画两个示例分子'); await h.until('recovery_scheduled'); t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.status, 'completed'); assert.equal(result.recoveryAttempts, 1); assert.equal(h.requests.length, 4);
  assert.equal(result.turns, 4); assert.equal(result.usage.totalTokens, 45);
  assert.equal(h.events.filter(event => event.type === 'usage').at(-1).usage.totalTokens, 45);
  const canvas = canvasOf(h.requests[3]);
  assert.equal(canvas.taskProgress.phaseIndex, 1); assert.equal(canvas.taskProgress.phases[0].status, 'completed');
  assert.deepEqual(canvas.consumedOperationIds, ['first-op']);
  assert.deepEqual(h.state.checkpoint.phases.map(phase => phase.operationIds), [['first-op'], ['second-op']]);
  assert.deepEqual(h.mutations.map(op => op.id), ['first-op', 'second-op']);
});

for (const action of ['stop', 'manual', 'load', 'reset', 'new-task']) {
  test(`${action} during backoff cancels the pending request and its timer`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture([interrupted, { content: '新任务完成。' }]);
    const pending = h.runtime.run('旧任务'); await h.until('recovery_scheduled');
    let replacement;
    if (action === 'stop') await h.runtime.stop();
    else if (action === 'reset') h.runtime.reset();
    else if (action === 'new-task') replacement = h.runtime.run('新任务');
    else {
      if (action === 'load') h.state.sessionId = 'document-2';
      h.target.dispatchEvent(new CustomEvent('molstudio:agent-canvas-change', {
        detail: { source: 'manual', reason: action === 'load' ? 'load' : 'edit' },
      }));
    }
    const result = await pending;
    assert.equal(result.status, 'stopped'); assert.equal(result.recoveryAttempts, 0);
    if (replacement) assert.equal((await replacement).status, 'completed');
    t.mock.timers.tick(100000); await Promise.resolve();
    assert.equal(h.requests.length, replacement ? 2 : 1);
    assert.equal(h.runtime.isRunning, false);
    assert.equal(h.events.some(event => event.type === 'recovery_started'), false);
    assert.ok(h.events.some(event => event.type === 'recovery_cancelled'));
  });
}

test('reopening a paused checkpoint never schedules recovery until the user explicitly continues', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = fixture([interrupted]);
  const first = old.runtime.run('保留原始目标'); await old.until('recovery_scheduled'); await old.runtime.stop(); await first;
  const h = fixture([interrupted, { content: '明确继续后的回答。' }], { initialState: structuredClone(old.state) });
  await h.runtime.restoreTaskCheckpoint(); t.mock.timers.tick(100000); await Promise.resolve();
  assert.equal(h.requests.length, 0); assert.equal(h.runtime.canContinue, true);
  const pending = h.runtime.continue(); await h.until('recovery_scheduled'); t.mock.timers.tick(1000);
  assert.equal((await pending).recoveryAttempts, 1); assert.equal(h.requests.length, 2);
});

test('a model or generation profile change during backoff stops before another model request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let current = structuredClone(config);
  const h = fixture([interrupted], { getConfig: async () => current });
  const pending = h.runtime.run('同一个模型执行'); await h.until('recovery_scheduled');
  current = { ...current, generation: { ...current.generation, effort: 'high' } };
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.status, 'needs_continue'); assert.equal(result.recoveryAttempts, 1); assert.equal(h.requests.length, 1);
  assert.ok(h.events.some(event => event.type === 'error' && event.code === 'recovery_configuration_changed'));
});

test('ambiguous transport errors, HTTP failures, malformed tools and chemical failures never trigger upstream recovery', async () => {
  for (const next of [
    () => response(new ReadableStream({ start(controller) { controller.error(new Error('ambiguous socket closed')); } })),
    () => new Response('{"error":{"message":"bad request"}}', { status: 400 }),
    () => new Response(upstreamError, { status: 502, headers: { 'Content-Type': 'text/event-stream' } }),
    call('draw_operations', { operations: [{ id: 'invalid', type: 'unknown' }] }),
    draw('rejected'),
  ]) {
    const h = fixture([next]);
    h.bridge.applyOperations = async () => { throw Object.assign(new Error('Invalid chemistry'), { code: 'chemical_validation_failed' }); };
    const result = await h.runtime.run('画一个示例分子');
    assert.equal(result.recoveryAttempts, 0);
    assert.equal(h.events.some(event => event.type.startsWith('recovery_')), false);
  }
});

test('a final checkpoint merge or bridge cleanup failure prevents automatic dispatch', async () => {
  for (const options of [
    { persist: async value => { if (value.status === 'paused') throw new Error('Checkpoint merge rejected'); } },
    { endRun: async () => { throw new Error('Bridge cleanup rejected'); } },
  ]) {
    const h = fixture([interrupted], options);
    const result = await h.runtime.run('保留当前断点');
    assert.equal(result.recoveryAttempts, 0); assert.equal(h.requests.length, 1);
    assert.equal(h.events.some(event => event.type.startsWith('recovery_')), false);
  }
});

test('a rejected planning schema followed by upstream interruption does not enter automatic recovery', async () => {
  const h = fixture([call('plan_task', { phases: [] }), interrupted]);
  const result = await h.runtime.run('分阶段画一个示例分子');
  assert.equal(result.recoveryAttempts, 0); assert.equal(h.requests.length, 2);
  assert.equal(h.events.some(event => event.type.startsWith('recovery_')), false);
});

test('an upstream failure following a rejected committed-step batch still fails closed', async () => {
  const h = fixture([(init, h) => {
    let sent = false;
    return response(new ReadableStream({ async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(frame({ tool_calls: [{ index: 0, id: 'bad-seal', type: 'function', function: {
          name: 'draw_operations', arguments: '{"operations":[' + JSON.stringify(molecule('rejected')) + ',{"id":"seal","type":"step.seal"},',
        } }] })));
      } else {
        await Promise.resolve(); await Promise.resolve();
        controller.enqueue(encoder.encode(upstreamError)); controller.close();
      }
    } }));
  }]);
  h.bridge.applyOperations = async () => { throw Object.assign(new Error('Invalid chemistry'), { code: 'chemical_validation_failed' }); };
  const result = await h.runtime.run('画一个示例分子');
  assert.equal(result.recoveryAttempts, 0); assert.equal(h.requests.length, 1);
  assert.equal(h.events.some(event => event.type.startsWith('recovery_')), false);
});
