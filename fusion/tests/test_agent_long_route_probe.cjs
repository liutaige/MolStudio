'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observeModelResponse, enforceModelRequestBudget, assessModelRequestBudget, assessModelTransport, safeRuntimeErrorMessage, zeroOutputStopDecision, modelRequestMetrics, createActiveDeadline } = require('./agent_long_route_probe.cjs');

function fakeDeadlineClock() {
  let at = 0, id = 0;
  const timers = new Map();
  return { now: () => at,
    setTimer(fn, delay) { timers.set(++id, { fn, at: at + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    jump(ms) { at += ms; },
    advance(ms) { at += ms; for (const [id, value] of [...timers]) if (value.at <= at) { timers.delete(id); value.fn(); } },
  };
}

test('independent review does not consume the active deadline or destroy the completed native window', () => {
  const clock = fakeDeadlineClock(); let expired = 0;
  const deadline = createActiveDeadline(1000, () => expired++, clock);
  clock.advance(250); deadline.pause();
  clock.advance(3600000);
  assert.equal(expired, 0);
  assert.deepEqual(deadline.snapshot(), { limitMs: 1000, remainingMs: 750, activeElapsedMs: 250,
    reviewWaitMs: 3600000, state: 'awaiting_independent_review' });
  assert.equal(deadline.resume(), true);
  clock.advance(749); assert.equal(expired, 0);
  clock.advance(1); assert.equal(expired, 1);
  assert.equal(deadline.snapshot().state, 'expired');
});

test('repeated review waits keep the original total active budget; cancellation prevents late expiry', () => {
  const clock = fakeDeadlineClock(); let expired = 0;
  const deadline = createActiveDeadline(1000, () => expired++, clock);
  clock.advance(400); deadline.pause(); deadline.pause(); clock.advance(20000); deadline.resume(); deadline.resume();
  clock.advance(300); deadline.pause(); clock.advance(10000); deadline.resume();
  assert.equal(deadline.snapshot().remainingMs, 300);
  assert.equal(deadline.snapshot().reviewWaitMs, 30000);
  clock.advance(299); assert.equal(expired, 0);
  deadline.cancel(); clock.advance(100000);
  assert.equal(expired, 0);
  assert.equal(deadline.snapshot().state, 'cancelled');
});

test('active work still expires normally and an exhausted deadline cannot restart', () => {
  const clock = fakeDeadlineClock(); let expired = 0;
  const deadline = createActiveDeadline(1000, () => expired++, clock);
  clock.advance(1000); assert.equal(expired, 1);
  assert.equal(deadline.resume(), false); deadline.pause(); clock.advance(5000);
  assert.equal(expired, 1);
});

test('a late timer after synchronous native work cannot hide an already exhausted active budget in review', () => {
  const clock = fakeDeadlineClock(); let expired = 0;
  const deadline = createActiveDeadline(1000, () => expired++, clock);
  clock.jump(1001); deadline.pause();
  assert.equal(expired, 1);
  assert.equal(deadline.snapshot().state, 'expired');
  assert.equal(deadline.resume(), false);
});

test('request metadata contains only byte counts and fixed role categories', () => {
  const body = { messages: [{ role: 'user', content: 'private-user' }, { role: 'assistant', reasoning_content: 'private-reasoning' },
    { role: 'tool', content: 'private-tool' }, { role: 'arbitrary-private-role', content: 'secret' }], api_key: 'private-key' };
  const raw = JSON.stringify(body), result = modelRequestMetrics(raw, body);
  assert.equal(result.requestBytes, Buffer.byteLength(raw));
  assert.equal(result.messages, 4);
  assert.deepEqual(Object.keys(result.roles), ['user', 'assistant', 'tool', 'other']);
  assert.ok(!/private|secret/.test(JSON.stringify(result)));
  assert.equal(Object.values(result.roles).reduce((n, role) => n + role.count, 0), 4);
});

test('actual outgoing canvas metadata records one fresh revision and alias counts without stable IDs', () => {
  const snapshot = { revision: 7, atoms: [{ id: 'private-atom' }], bonds: [], reactionSteps: [{ stepId: 'private-step' }],
    activeOperationAliases: [{ id: 'private-operation' }] };
  const body = { messages: [{ role: 'system', content: 'Rules\n\nCurrent canvas context (JSON):\n' + JSON.stringify(snapshot) },
    { role: 'tool', content: JSON.stringify({ revision: 6, snapshotOmitted: true }) }] };
  const result = modelRequestMetrics(JSON.stringify(body), body);
  assert.equal(result.fullCanvasSnapshots, 1);
  assert.deepEqual(result.canvas, { revision: 7, atoms: 1, bonds: 0, steps: 1, activeAliasOperations: 1, hasResumeAliases: false });
  assert.ok(!JSON.stringify(result).includes('private'));
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const request = () => ({ number: 1, bytes: 0, chunks: 0, responseStatus: 200 });

test('the optional local zero-output budget stops only ongoing reasoning without content or tool fragments', () => {
  const start = Date.parse('2026-11-12T00:00:00Z'), r = { ...request(), runId: 'run', startedAt: '2026-11-12T00:00:00Z',
    bytes: 123456, sseCounts: { reasoningBytes: 1000, contentBytes: 0, toolArgumentBytes: 0, toolCalls: 0 } };
  const audit = { runStatus: 'running', requests: [r] };
  assert.equal(zeroOutputStopDecision(audit, 120000, start + 119999), null);
  assert.deepEqual(zeroOutputStopDecision(audit, 120000, start + 120000), { request: 1, runId: 'run',
    trigger: 'zero_output_test_budget', limitMs: 120000, elapsedMs: 120000, receivedBytes: 123456, reasoningBytes: 1000 });
  for (const counts of [{ contentBytes: 1 }, { toolArgumentBytes: 1 }, { toolCalls: 1 }, { oversizedEvents: 1 }]) {
    assert.equal(zeroOutputStopDecision({ ...audit, requests: [{ ...r, sseCounts: { ...r.sseCounts, ...counts } }] }, 120000, start + 300000), null);
  }
  assert.equal(zeroOutputStopDecision(audit, 0, start + 300000), null);
});

test('local zero-output control never replaces an actual terminal event or observed transport failure', () => {
  const now = Date.parse('2026-11-12T00:05:00Z'), r = { ...request(), startedAt: '2026-11-12T00:00:00Z' };
  for (const change of [{ responseStatus: 502 }, { transportError: true }, { errorCode: 'TypeError' }, { finishedAt: 'ended' },
    { cancelled: true }, { sse: { errorEvent: true } }, { sse: { done: true } }, { sse: { finishReasons: ['tool_calls'] } }]) {
    assert.equal(zeroOutputStopDecision({ runStatus: 'running', requests: [{ ...r, ...change }] }, 120000, now), null);
  }
  assert.equal(zeroOutputStopDecision({ runStatus: 'completed', requests: [r] }, 120000, now), null);
});

for (const result of ['done', 'value', 'reject']) test('parser cancellation ignores a pending read returning ' + result, async () => {
  const pending = deferred(), reading = deferred(), observed = request();
  const response = { status: 200, statusText: 'OK', headers: {}, body: { getReader: () => ({
    read() { reading.resolve(); return pending.promise; }, cancel: async () => {},
  }) } };
  const reader = observeModelResponse(response, observed, () => {}, () => 'now').body.getReader();
  const consuming = reader.read(); await reading.promise;
  await reader.cancel('terminal model event consumed');
  assert.deepEqual(await consuming, { done: true, value: undefined });
  if (result === 'reject') pending.reject(new TypeError('reader rejected after cancellation'));
  else pending.resolve(result === 'done' ? { done: true } : { done: false, value: new Uint8Array([1]) });
  await settle();
  assert.equal(observed.cancelled, true);
  assert.equal(observed.errorCode, undefined);
  assert.equal(observed.transportError, undefined);
  assert.equal(observed.chunks, 0);
  assert.deepEqual(assessModelTransport({ requests: [observed] }), { failed: false, reasons: [] });
});

test('a real stream cancelled after DONE keeps its counts without inventing a transport error', async () => {
  const terminal = new TextEncoder().encode('data: [DONE]\n\n'), observed = request();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(terminal); } }));
  const reader = observeModelResponse(response, observed, () => {}, () => 'now').body.getReader();
  assert.deepEqual((await reader.read()).value, terminal);
  await reader.cancel('terminal model event consumed'); await settle();
  assert.equal(observed.bytes, terminal.byteLength);
  assert.equal(observed.chunks, 1);
  assert.deepEqual(observed.sse, { done: true, finishReasons: [], errorEvent: false });
  assert.equal(observed.errorCode, undefined);
  assert.equal(assessModelTransport({ requests: [observed] }).failed, false);
});

async function observeChunks(chunks) {
  const observed = request(), emitted = [];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }));
  const reader = observeModelResponse(response, observed, () => emitted.push(JSON.stringify(observed)), () => 'now').body.getReader();
  const forwarded = [];
  for (;;) { const item = await reader.read(); if (item.done) break; forwarded.push(item.value); }
  return { observed, emitted, forwarded };
}

test('SSE terminal metadata survives byte-split UTF-8 and CRLF while forwarding original bytes', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"机密 secret-provider-body"},"finish_reason":"tool_calls"}]}\r\n\r\n' +
    'data: {"choices":[{"finish_reason":"length"},{"finish_reason":"arbitrary-private-content"}]}\n\n' +
    'event: error\r\ndata: {"error":{"type":"rate_limit_error","code":"quota_exceeded","message":"private error text"}}\r\n\r\n' +
    'data: [DONE]\r\n\r\n');
  const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
  const { observed, emitted, forwarded } = await observeChunks(chunks);
  assert.deepEqual(Buffer.concat(forwarded.map(c => Buffer.from(c))), Buffer.from(bytes));
  assert.deepEqual(observed.sse, { done: true, finishReasons: ['tool_calls', 'length'], errorEvent: true,
    errorType: 'rate_limit_error', errorCode: 'quota_exceeded' });
  assert.equal(observed.bytes, bytes.length);
  assert.doesNotMatch(JSON.stringify([observed, emitted]), /secret-provider-body|机密|private error text|arbitrary-private-content/);
});

test('error events retain only bounded identifiers and ignore arbitrary payloads', async () => {
  const input = 'data: {"error":{"type":"' + 'x'.repeat(65) + '","code":"private secret","message":"do not save"}}\n\n' +
    'event: error\ndata: malformed private payload\n\n';
  const { observed, emitted } = await observeChunks([new TextEncoder().encode(input)]);
  assert.deepEqual(observed.sse, { done: false, finishReasons: [], errorEvent: true });
  assert.doesNotMatch(JSON.stringify([observed, emitted]), /private|do not save|xxxxx/);
});

test('oversized SSE lines are dropped and later bounded events still parse', async () => {
  const input = 'data: ' + 'x'.repeat(150000) + '\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(input);
  const chunks = [bytes.slice(0, 70000), bytes.slice(70000, 120000), bytes.slice(120000)];
  const { observed, forwarded } = await observeChunks(chunks);
  assert.deepEqual(observed.sse, { done: true, finishReasons: ['stop'], errorEvent: false });
  assert.deepEqual(Buffer.concat(forwarded.map(c => Buffer.from(c))), Buffer.from(bytes));
  assert.doesNotMatch(JSON.stringify(observed), /xxxxx/);
});

test('cancelling an incomplete SSE error event does not invent an error event or transport failure', async () => {
  const observed = request(), chunk = new TextEncoder().encode('event: error\ndata: {"error":{"message":"private');
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); } }));
  const reader = observeModelResponse(response, observed, () => {}, () => 'now').body.getReader();
  assert.deepEqual((await reader.read()).value, chunk);
  await reader.cancel();
  assert.deepEqual(observed.sse, { done: false, finishReasons: [], errorEvent: false });
  assert.equal(assessModelTransport({ requests: [observed] }).failed, false);
  assert.doesNotMatch(JSON.stringify(observed), /private/);
});

test('a genuine read error before cancellation remains transport evidence', async () => {
  const pending = deferred(), reading = deferred(), observed = request();
  const response = { status: 200, statusText: 'OK', headers: {}, body: { getReader: () => ({
    read() { reading.resolve(); return pending.promise; }, cancel: async () => {},
  }) } };
  const reader = observeModelResponse(response, observed, () => {}, () => 'now').body.getReader();
  const consuming = reader.read(); await reading.promise;
  pending.reject(new TypeError('socket closed'));
  await assert.rejects(consuming, /socket closed/);
  assert.equal(observed.errorPhase, 'read');
  assert.equal(observed.transportError, true);
  observed.cancelled = true; // Cleanup must not erase an already observed failure.
  assert.equal(assessModelTransport({ requests: [observed] }).failed, true);
});

test('HTTP failure and fetch failure remain distinct transport evidence', () => {
  const http = assessModelTransport({ requests: [{ number: 1, responseStatus: 502, cancelled: true }] });
  assert.deepEqual(http.reasons, [{ source: 'http', request: 1, status: 502 }]);
  const fetch = assessModelTransport({ requests: [{ number: 2, errorCode: 'TypeError', errorPhase: 'fetch', transportError: true }] });
  assert.deepEqual(fetch.reasons, [{ source: 'request', request: 2, phase: 'fetch', code: 'TypeError' }]);
});

test('an explicitly correlated task-refinement abort is distinct from network failure', () => {
  const cancellation = { id: 'task-refinement-1', reason: 'task_refinement', runId: 'run-1', at: '2026-11-12T00:00:01.000Z' };
  const request = { number: 1, runId: 'run-1', errorCode: 'AbortError', errorPhase: 'fetch', transportError: true,
    errorAt: '2026-11-12T00:00:01.001Z', intentionalCancellation: cancellation };
  assert.equal(assessModelTransport({ requests: [request] }).failed, false);
  for (const change of [{ errorCode: 'TypeError' }, { errorAt: '2026-11-12T00:00:00.999Z' },
    { errorAt: undefined }, { runId: 'another-run' }, { intentionalCancellation: undefined }]) {
    assert.equal(assessModelTransport({ requests: [{ ...request, ...change }] }).failed, true);
  }
  for (const evidence of [{ responseStatus: 502 }, { sse: { errorEvent: true, errorCode: 'upstream_stream_error' } }]) {
    assert.equal(assessModelTransport({ requests: [{ ...request, ...evidence }] }).failed, true);
  }
});

test('runtime transport failures take precedence while completion validation stays separate', () => {
  for (const code of ['transport_interrupted', 'model_failed']) {
    const result = assessModelTransport({ events: [{ type: 'error', code }] });
    assert.equal(result.failed, true);
    assert.deepEqual(result.reasons[0], { source: 'runtime', code });
  }
  assert.equal(assessModelTransport({ events: [{ type: 'run_end', reason: 'transport_interrupted' }] }).failed, true);
  assert.equal(assessModelTransport({ events: [{ type: 'error', code: 'MECHANISM_INCOMPLETE' },
    { type: 'run_end', reason: 'mechanism_incomplete' }] }).failed, false);
});

test('legacy cancellation-only probe TypeError does not outweigh the real completion issue', () => {
  const result = assessModelTransport({ requests: [{ number: 1, responseStatus: 200, cancelled: true, errorCode: 'TypeError' }],
    events: [{ type: 'error', code: 'MECHANISM_INCOMPLETE' }] });
  assert.deepEqual(result, { failed: false, reasons: [] });
  assert.equal(assessModelTransport({ requests: [{ number: 1, responseStatus: 200, errorCode: 'TypeError' }] }).failed, true);
});

test('using the final allowed request normally does not mean budget exhaustion', () => {
  const requests = [request()], requestBudget = { limit: 2, exhausted: false, deniedAttempts: 0 };
  enforceModelRequestBudget(requests, requestBudget, () => 'now', 'run-1');
  requests.push({ ...request(), number: 2 });
  assert.equal(assessModelRequestBudget({ requests, requestBudget }).exhausted, false);
  assert.equal(assessModelTransport({ requests, requestBudget, events: [{ type: 'run_end', status: 'completed' }] }).failed, false);
});

function exhaustedAudit() {
  const requests = [request()], requestBudget = { limit: 1, exhausted: false, deniedAttempts: 0 };
  for (let i = 0; i < 2; i++) assert.throws(() => enforceModelRequestBudget(requests, requestBudget, () => 'now', 'run-1'),
    error => error.code === 'test_request_limit');
  const id = requestBudget.denials.at(-1).id;
  return { requests, requestBudget, events: [
    { type: 'error', code: 'transport_interrupted', runId: 'run-1', localCause: 'test_request_limit', budgetDenialId: id },
    { type: 'run_end', reason: 'transport_interrupted', runId: 'run-1', localCause: 'test_request_limit', budgetDenialId: id },
  ] };
}

test('local budget denials and their runtime wrappers are distinct from actual upstream failures', () => {
  const audit = exhaustedAudit();
  assert.equal(audit.requests.length, 1, 'the blocked attempt and runtime retry never become upstream request records');
  assert.equal(audit.requestBudget.deniedAttempts, 2);
  assert.deepEqual(audit.requestBudget.denials.map(denial => [denial.sequence, denial.nextRequestNumber]), [[1, 2], [2, 2]]);
  assert.equal(assessModelRequestBudget(audit).exhausted, true);
  assert.deepEqual(assessModelTransport(audit), { failed: false, reasons: [] });
  assert.match(safeRuntimeErrorMessage('test_request_limit', 'private provider content'), /预算已耗尽/);
});

test('HTTP and real fetch/read failures remain visible alongside an exhausted request budget', () => {
  for (const evidence of [{ responseStatus: 502 }, { errorCode: 'TypeError', errorPhase: 'fetch', transportError: true },
    { errorCode: 'TypeError', errorPhase: 'read', transportError: true, cancelled: true }]) {
    const audit = exhaustedAudit(); Object.assign(audit.requests[0], evidence);
    assert.equal(assessModelRequestBudget(audit).exhausted, true);
    assert.equal(assessModelTransport(audit).failed, true);
  }
});

test('budget correlation cannot hide earlier, unlinked, different-run or unsupported runtime errors', () => {
  for (const event of [
    { type: 'error', code: 'transport_interrupted', runId: 'run-before' },
    { type: 'error', code: 'model_failed', runId: 'run-1' },
    { type: 'error', code: 'transport_interrupted', runId: 'run-next', localCause: 'test_request_limit', budgetDenialId: 'request-budget-2' },
    { type: 'error', code: 'transport_interrupted', runId: 'run-1', localCause: 'test_request_limit', budgetDenialId: 'missing-denial' },
  ]) {
    const audit = exhaustedAudit(); audit.events.unshift(event);
    assert.equal(assessModelTransport(audit).failed, true);
  }
  assert.equal(assessModelTransport({ events: [{ type: 'error', code: 'transport_interrupted', runId: 'run-1',
    localCause: 'test_request_limit', budgetDenialId: 'request-budget-2' }] }).failed, true);
});

test('the actual renderer probe records a denied attempt without calling upstream and clears its cause for the next run', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'test_agent_long_route_live.cjs'), 'utf8');
  const start = source.indexOf('async function installProbe('), end = source.indexOf('\nfunction chemicalCandidates(', start);
  let listener, upstreamCalls = 0;
  const runtime = { _fetch: async () => { upstreamCalls++; return new Response(null, { status: 204 }); } };
  const sandbox = { window: { k3dAPI: { agent: { applyOperations: async () => ({}) } }, MolWorkbench: { app: { adapter: { ed: { historySize: () => ({ undo: 2 }) } } } } }, molstudioAgent: { getRuntime: () => runtime },
    addEventListener: (_, callback) => { listener = callback; }, document: { querySelector: () => null, querySelectorAll: () => [] }, console: { info() {} } };
  await vm.runInNewContext('(' + source.slice(start, end) + ')', sandbox)(1, observeModelResponse, safeRuntimeErrorMessage, enforceModelRequestBudget);
  const emit = detail => listener({ detail });
  emit({ type: 'run_start', runId: 'run-1' });
  await runtime._fetch('/api/agent/model');
  await assert.rejects(runtime._fetch('/api/agent/model'), error => error.code === 'test_request_limit');
  emit({ type: 'error', runId: 'run-1', code: 'transport_interrupted' });
  emit({ type: 'run_end', runId: 'run-1', reason: 'transport_interrupted', status: 'needs_continue' });
  const first = sandbox.window.__readLongRouteAudit();
  assert.equal(upstreamCalls, 1); assert.equal(first.realModelRequests, 1);
  assert.equal(assessModelRequestBudget(first).exhausted, true); assert.equal(assessModelTransport(first).failed, false);
  assert.equal(first.events.find(event => event.type === 'error').localCause, 'test_request_limit');
  emit({ type: 'run_start', runId: 'run-2' });
  emit({ type: 'error', runId: 'run-2', code: 'transport_interrupted' });
  assert.equal(assessModelTransport(sandbox.window.__readLongRouteAudit()).failed, true);
});

test('renderer probe safely records generation headers, host layout facts, and failed tool cards', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'test_agent_long_route_live.cjs'), 'utf8');
  const start = source.indexOf('async function installProbe('), end = source.indexOf('\nfunction chemicalCandidates(', start);
  let listener, failedCards = 0, requestCount = 0;
  const generation = { requested: { profile: 'deepseek', effort: 'none', maxOutputTokens: 16384, secret: 'private' },
    fields: { thinking: { type: 'disabled' }, reasoning_effort: 'none', max_tokens: 16384, extra: 'private' },
    forwardedToConfiguredEndpoint: true, downstreamConfirmed: false, extra: 'private' };
  const runtime = { _fetch: async () => new Response(null, { status: 200, headers: {
    'X-MolStudio-Generation': requestCount++ === 0 ? JSON.stringify(generation) : '{invalid' } }) };
  const sandbox = { window: { k3dAPI: { agent: { applyOperations: async () => ({}) } }, MolWorkbench: { app: { adapter: { ed: { historySize: () => ({ undo: 2 }) } } } } }, molstudioAgent: { getRuntime: () => runtime },
    addEventListener: (_, callback) => { listener = callback; },
    document: { querySelector: () => null, querySelectorAll: selector => selector === '.mol-agent-tool.is-failed' ? Array(failedCards).fill({}) : [] },
    console: { info() {} } };
  await vm.runInNewContext('(' + source.slice(start, end) + ')', sandbox)(2, response => response, safeRuntimeErrorMessage, enforceModelRequestBudget);
  await runtime._fetch('/api/agent/model', { body: JSON.stringify({ tools: [
    { function: { name: 'read_canvas', description: 'private' } }, { function: { name: 'draw_operations', parameters: { properties: { operations: { items: { oneOf:
      ['layout.tidy', 'reactionStep.modify', 'lonePair.modify', 'arrow.modify', 'private'].map(type => ({ properties: { type: { enum: [type] } } })) } } } } } },
    { function: { name: 'private' } }, { function: { name: 'plan_task' } }, { name: 'complete_phase' },
  ], messages: [{ content: 'private' }] }) });
  await sandbox.window.k3dAPI.agent.applyOperations([{ type: 'layout.tidy', private: 'private' }, { type: 'private' }]);
  await runtime._fetch('/api/agent/model', { body: JSON.stringify({ tools: [{ function: { name: 'complete_layout' } }] }) });
  listener({ detail: { type: 'tool_start', toolName: 'complete_layout' } });
  listener({ detail: { type: 'tool_end', toolName: 'complete_layout', isError: false, result: { scope: 'layout', finishAccepted: true,
    layoutFacts: { molecules: 11, atoms: 84, bonds: 78, electronFlows: 10, reactionSteps: 5, horizontalArrows: 5, pairedTokens: ['续1','接B1'], secret: 'private' } } } });
  listener({ detail: { type: 'text_delta', source: 'host', text: 'host summary', layoutFacts: {
    molecules: 11, atoms: 84, bonds: 78, electronFlows: 10, reactionSteps: 5, horizontalArrows: 5,
    pairedTokens: ['续1', '接B1', 'private'], secret: 'private' } } });
  failedCards = 1;
  const audit = sandbox.window.__readLongRouteAudit();
  assert.equal(audit.panelFailedToolCards, 1);
  assert.equal(audit.hostLayoutCompletions.length, 1);
  assert.equal(audit.hostLayoutCompletions[0].molecules, 11);
  assert.deepEqual(Array.from(audit.hostLayoutCompletions[0].pairedTokens), ['续1', '接B1']);
  assert.equal(audit.requests[0].gatewayGeneration.fields.thinkingType, 'disabled');
  assert.equal(audit.requests[0].gatewayGeneration.requested.maxOutputTokens, 16384);
  assert.deepEqual(Array.from(audit.requests[0].offeredTools), ['read_canvas', 'draw_operations', 'plan_task', 'complete_phase']);
  assert.equal(audit.requests[0].offeredOperations.schemaAvailable, true);
  assert.equal(audit.requests[0].offeredOperations.unexpectedTypeCount, 1);
  assert.equal(audit.requests[0].offeredOperations.semanticShapeValid, false);
  assert.deepEqual(Array.from(audit.requests[0].offeredOperations.types), ['arrow.modify', 'layout.tidy', 'lonePair.modify', 'reactionStep.modify']);
  assert.equal(audit.appliedBatches[0].unexpectedOperationCount, 1);
  assert.deepEqual(Array.from(audit.appliedBatches[0].operationTypes), ['layout.tidy']);
  assert.equal(audit.requests[0].appliedBatchCountAtStart, 0);
  assert.equal(audit.requests[1].appliedBatchCountAtStart, 1);
  assert.deepEqual(Array.from(audit.requests[1].offeredTools), ['complete_layout']);
  assert.equal(audit.completionCalls[0].applyCountBefore, 1);
  assert.equal(audit.completionCalls[0].applyCountAfter, 1);
  assert.equal(audit.completionCalls[0].scope, 'layout');
  assert.equal(audit.completionCalls[0].undoBefore, audit.completionCalls[0].undoAfter);
  assert.equal(audit.requests[1].gatewayGeneration.invalid, true);
  assert.ok(!JSON.stringify(audit).includes('private'));
  failedCards = 0; assert.equal(sandbox.window.__readLongRouteAudit().panelFailedToolCards, 0);
});

test('saved local error text explains completion defects and omits provider content and secrets', () => {
  assert.equal(safeRuntimeErrorMessage('MECHANISM_INCOMPLETE', '步骤 rs-1 的电子流仍需补齐。'), '步骤 rs-1 的电子流仍需补齐。');
  const safe = safeRuntimeErrorMessage('MECHANISM_INCOMPLETE', 'token=secret-value Bearer other-secret sk-another-secret\u0000');
  assert.ok(!safe.includes('secret'));
  assert.ok(!safe.includes('\u0000'));
  assert.equal(safeRuntimeErrorMessage('MECHANISM_INCOMPLETE', 'x'.repeat(1100)).length, 1000);
  for (const code of ['model_failed', 'transport_interrupted', 'RUN_FAILED']) {
    assert.ok(!safeRuntimeErrorMessage(code, '{"reasoning":"private","api_key":"secret"}').includes('private'));
    assert.ok(!safeRuntimeErrorMessage(code, '{"reasoning":"private","api_key":"secret"}').includes('secret'));
  }
});
