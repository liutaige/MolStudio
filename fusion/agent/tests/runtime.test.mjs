import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, summarizeOperations } from '../runtime.js';

const config = { configured: true, sessionToken: 'local-test-token', provider: 'openai-compatible', model: 'glm-5.3-flash', baseUrl: 'https://upstream.invalid/v1', maxTurns: 24 };
const molecule = { id: 'mol1', type: 'molecule.add', smiles: '[CH3:1][Br:2]' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function sse(deltas, { delay = 0, signal, finishReason } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const chunks = deltas.map((delta, index) => ({ id: 'chat-test', object: 'chat.completion.chunk', model: config.model, created: 0,
    choices: [{ index: 0, delta: { ...delta }, finish_reason: index === deltas.length - 1 ? (finishReason || (delta._toolFinish ? 'tool_calls' : 'stop')) : null }] }));
  // _toolFinish is a local test marker; providers never receive it.
  for (const chunk of chunks) delete chunk.choices[0].delta._toolFinish;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (delay) await sleep(delay);
      if (signal?.aborted) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      if (i < chunks.length) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunks[i++]) + '\n\n'));
      else if (i++ === chunks.length) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      else controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function tool(name, input, callId = 'call1') {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const midpoint = Math.floor(raw.length / 2);
  return [
    { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: raw.slice(0, midpoint) } }] },
    { tool_calls: [{ index: 0, function: { arguments: raw.slice(midpoint) } }] },
    { _toolFinish: true },
  ];
}
function harness(responses, options = {}) {
  const events = [], applied = [], previews = [], cancelled = [], requests = [], contexts = [];
  const target = new EventTarget();
  const bridge = {
    async getContext() { return { sessionId: 'doc1', atoms: [{ id: 'existing-atom' }], selection: [] }; },
    async applyOperations(ops, info) { applied.push({ ops, info }); return { created: ops.map(op => ({ id: op.id })), summary: 'applied', atoms: { 'mol1:1': 'stable-1' } }; },
    async previewOperations(ops, info) { previews.push({ ops, info }); },
    async clearPreview() {},
    ...options.bridge,
  };
  const fetch = async (url, init) => {
    if (url === '/api/agent/cancel') { cancelled.push(JSON.parse(init.body)); return new Response('{}'); }
    assert.equal(url, '/api/agent/model');
    assert.equal(init.headers['X-MolStudio-Agent-Token'], config.sessionToken);
    assert.ok(init.headers['X-MolStudio-Agent-Request']);
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body); requests.push(body); contexts.push(body.messages);
    const next = responses[requests.length - 1] || responses.at(-1);
    return typeof next === 'function' ? next(init) : sse(next, { signal: init.signal });
  };
  const runtime = new Runtime({ bridge, fetch, getConfig: async () => ({ ...config, ...options.config }),
    onEvent: event => events.push(event), eventTarget: target, recoverUpstream: options.recoverUpstream });
  return { runtime, bridge, events, applied, previews, cancelled, requests, contexts, target };
}

function splitDrawing(firstOperations, lastOperations, { interrupt = false } = {}) {
  let release;
  const sendTail = new Promise(resolve => { release = resolve; });
  const encode = new TextEncoder();
  const frame = (delta, finish_reason = null) => encode.encode('data: ' + JSON.stringify({
    id: 'staged-test', created: 0, model: config.model, choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n');
  const response = () => new Response(new ReadableStream({
    async start(controller) {
      const prefix = '{"operations":[' + firstOperations.map(op => JSON.stringify(op)).join(',') + ',';
      controller.enqueue(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'steps', type: 'function',
        function: { name: 'draw_operations', arguments: prefix } }] }));
      await sendTail;
      if (interrupt) { controller.error(new Error('transport closed before the next step')); return; }
      const suffix = lastOperations.map(op => JSON.stringify(op)).join(',') + '],"finish":true}';
      controller.enqueue(frame({ tool_calls: [{ index: 0, function: { arguments: suffix } }] }));
      controller.enqueue(frame({}, 'tool_calls'));
      controller.enqueue(encode.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, release };
}

const seal = id => ({ id, type: 'step.seal' });

test('one request commits each explicit seal before stream end and never replays sealed operations', async () => {
  const product = { id: 'product', type: 'molecule.add', smiles: 'CO' };
  const flow = splitDrawing([molecule, seal('s1')], [product, seal('s2')]);
  const h = harness([flow.response]);
  const pending = h.runtime.run('画两个示例分子');
  try {
    for (let i = 0; i < 200 && !h.events.some(e => e.type === 'step_commit'); i++) await sleep(2);
    assert.deepEqual(h.applied.map(x => x.ops), [[molecule]]);
    assert.equal(h.runtime.isRunning, true);
  } finally { flow.release(); }
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.applied.map(x => x.ops), [[molecule], [product]]);
  assert.equal(h.events.filter(e => e.type === 'step_commit').length, 2);
});

test('a broken stream retains sealed objects and continuation does not repeat them', async () => {
  const product = { id: 'product', type: 'molecule.add', smiles: 'CO' };
  const flow = splitDrawing([molecule, seal('s1')], [], { interrupt: true });
  const h = harness([flow.response, tool('draw_operations', { operations: [molecule, product], finish: true })]);
  const pending = h.runtime.run('画两个示例分子');
  try {
    for (let i = 0; i < 200 && !h.events.some(e => e.type === 'step_commit'); i++) await sleep(2);
    assert.equal(h.applied.length, 1);
  } finally { flow.release(); }
  const interrupted = await pending;
  assert.equal(interrupted.status, 'needs_continue');
  assert.equal(interrupted.canContinue, true);
  assert.ok(h.events.some(e => e.type === 'run_end' && e.reason === 'transport_interrupted'));
  const resumed = await h.runtime.continue();
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(h.applied.map(x => x.ops), [[molecule], [product]]);
  assert.equal(JSON.stringify(h.contexts[1]).includes('"id":"steps"'), false, 'the interrupted tool call is not sent back as a completed assistant call');
});

test('a later sealed tool cannot overtake an earlier drawing tool in the same response', async () => {
  const product = { id: 'product', type: 'molecule.add', smiles: 'CO' };
  const h = harness([[{ role: 'assistant', tool_calls: [
    { index: 0, id: 'first', type: 'function', function: {
      name: 'draw_operations', arguments: JSON.stringify({ operations: [molecule] }),
    } },
    { index: 1, id: 'second', type: 'function', function: {
      name: 'draw_operations', arguments: JSON.stringify({ operations: [product, seal('s2')], finish: true }),
    } },
  ] }, { _toolFinish: true }]]);
  const result = await h.runtime.run('画两个示例分子');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.applied.map(x => x.ops), [[molecule], [product]]);
});

test('a repeated draw failure without progress pauses instead of cycling model calls', async () => {
  const h = harness([tool('draw_operations', { operations: [molecule] })], {
    bridge: { async applyOperations() { throw Object.assign(new Error('分子引用无效'), { code: 'missing_reference' }); } },
  });
  const result = await h.runtime.run('画一个分子');
  assert.equal(result.status, 'needs_continue');
  assert.equal(h.requests.length, 2);
  assert.ok(h.events.some(e => e.type === 'run_end' && e.reason === 'no_progress'));
});

test('ordinary chat keeps actual model thinking on its dedicated foldable channel and out of normal reply text', async () => {
  const h = harness([[{ role: 'assistant', reasoning_content: 'private reasoning text' }, { content: '可以，我们先讨论机理。' }, {}]]);
  const result = await h.runtime.run('解释 SN2 机理');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.equal(h.applied.length, 0);
  assert.equal(h.events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), '可以，我们先讨论机理。');
  assert.ok(h.events.some(e => e.type === 'thinking' && e.active));
  assert.equal(h.events.filter(e => e.type === 'thinking_delta' && e.source === 'model').map(e => e.delta).join(''), 'private reasoning text');
  assert.equal(JSON.stringify(h.events.filter(e => e.type !== 'thinking_delta')).includes('private reasoning text'), false);
});

test('runtime publishes byte counts once per second while waiting and freezes progress when stopped', async () => {
  const h = harness([init => sse([{ reasoning_content: 'synthetic thinking' }, { content: 'reply' }], { signal: init.signal, delay: 600 })]);
  const pending = h.runtime.run('解释这个结构'); await sleep(1100);
  const updates = h.events.filter(event => event.type === 'transport_progress');
  assert.ok(updates.some(event => event.elapsedMs >= 1000 && event.receivedBytes > 0));
  assert.ok(updates.every(event => !JSON.stringify(event).includes('synthetic thinking')));
  await h.runtime.stop(); await pending;
  const final = h.events.filter(event => event.type === 'transport_progress').at(-1);
  assert.equal(final.final, true);
  const count = h.events.filter(event => event.type === 'transport_progress').length; await sleep(30);
  assert.equal(h.events.filter(event => event.type === 'transport_progress').length, count);
});

test('cancelling a pending proxy read never marks normal parser cleanup as an interrupted transport', async () => {
  const h = harness([() => new Response(new ReadableStream({}))]);
  const run = { id: 'proxy-cancel', generation: 1, stopped: false, finished: false, controller: new AbortController(), config,
    turns: 1, httpRequests: 0, transportRetries: 0, requests: new Set(), startedAt: Date.now(), receivedBytes: 0, requestReceivedBytes: 0, lastByteAt: null };
  h.runtime._active = run; h.runtime._generation = 1;
  const response = await h.runtime._proxyFetch(run, '', { body: '{}' });
  const reader = response.body.getReader(), pending = reader.read(); await Promise.resolve(); await reader.cancel(); await pending; await sleep(0);
  assert.equal(run.transportInterrupted, undefined); assert.equal(run.requests.size, 0); assert.equal(run.receivedBytes, 0);
});

test('disabled upstream recovery preserves the safe error source and permits explicit continuation before the first edit', async () => {
  const encoder = new TextEncoder();
  const failure = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning_content":"synthetic interrupted thinking"},"finish_reason":null}]}\n\n'));
    controller.enqueue(encoder.encode('data: {"error":{"message":"upstream stream aborted: private key secret","type":"upstream_error","code":"upstream_stream_error"}}\n\ndata: [DONE]\n\n'));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const h = harness([failure, [{ role: 'assistant', content: '继续后的正常回答。' }]], { recoverUpstream: false });
  const result = await h.runtime.run('解释这个反应');
  assert.equal(result.status, 'needs_continue'); assert.equal(result.canContinue, true); assert.equal(h.requests.length, 1);
  assert.deepEqual(result.failureSource, { layer: 'upstream', code: 'upstream_stream_error' });
  const error = h.events.find(event => event.type === 'error');
  assert.equal(error.code, 'upstream_stream_error'); assert.match(error.message, /上游连接中断/);
  assert.doesNotMatch(JSON.stringify(h.events), /private key secret|upstream stream aborted/);
  assert.equal((await h.runtime.continue()).status, 'completed'); assert.equal(h.requests.length, 2);
  assert.doesNotMatch(JSON.stringify(h.contexts[1]), /synthetic interrupted thinking|private key secret/);
});

test('simple finish:true batch commits once and stops before an extra model summary', async () => {
  const h = harness([tool('draw_operations', { operations: [molecule], finish: true })]);
  const result = await h.runtime.run('画 CH3Br');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.equal(h.applied.length, 1);
  assert.equal(result.completedOperations, 1);
  assert.ok(h.previews.length > 0);
  assert.ok(h.events.some(e => e.type === 'tool_end' && !e.isError));
});

test('an early reaction declaration and a label-only stage pass streaming and tool validation', async () => {
  const product = { id: 'product', type: 'molecule.add', smiles: '[CH3:1][OH:2]' };
  const step = { id: 'step', type: 'reactionArrow.add', reactants: ['mol1:1'], products: ['product:1'],
    layout: { reactantPlacement: 'vertical', breakBefore: false, conditions: 'H2O' } };
  const operations = [step, molecule, product];
  const h = harness([tool('draw_operations', {
    operations, taskScope: { type: 'partialStep', stages: [{ label: 'Substitution' }] }, finish: true,
  })]);
  const result = await h.runtime.run('画取代反应，在箭头标注 H2O');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.applied[0].ops, operations);
});

test('a single redundant root closer does not require a second model request', async () => {
  const raw = JSON.stringify({ operations: [molecule], finish: true }) + '}';
  const h = harness([tool('draw_operations', raw)]);
  const result = await h.runtime.run('画溴甲烷');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.applied[0].ops, [molecule]);
});

test('a full viewport pauses drawing until the user can make room', async () => {
  const reply = tool('draw_operations', { operations: [molecule], finish: true });
  let blocked = true;
  const h = harness([reply], { bridge: {
    async applyOperations() {
      if (blocked) throw Object.assign(new Error('可见画布空间不足'), { code: 'viewport_full' });
      return { created: [{ id: molecule.id }] };
    },
  } });
  const first = await h.runtime.run('画 CH3Br');
  assert.equal(first.status, 'needs_continue');
  assert.equal(first.completedOperations, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.runtime.canContinue, true);
  assert.ok(h.events.some(event => event.type === 'run_end' && event.reason === 'viewport_full' && event.canContinue));
  blocked = false;
  const resumed = await h.runtime.continue();
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.completedOperations, 1);
  assert.equal(h.requests.length, 2);
});

test('an explicitly requested post-drawing explanation is not cut off by an early finish flag', async () => {
  const h = harness([tool('draw_operations', { operations: [molecule], finish: true }), [{ content: '绘图后说明：结构已经创建。' }, {}]]);
  const result = await h.runtime.run('画CH3Br，最后在聊天里解释一下');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
  assert.ok(h.contexts[1].some(m => m.role === 'tool' && m.content.includes('finalChatReplyRequired')));
  assert.ok(h.events.some(e => e.type === 'text_delta' && e.text.includes('绘图后说明')));
});

test('ordinary explanation plus drawing can still finish in one response containing text and a tool', async () => {
  const response = tool('draw_operations', { operations: [molecule], finish: true });
  response[0].content = '这是用于说明的结构。';
  const h = harness([response]);
  await h.runtime.run('解释这个结构并画出来');
  assert.equal(h.requests.length, 1);
  assert.equal(h.applied.length, 1);
  assert.ok(h.events.some(e => e.type === 'text_delta'));
});

test('normal agent reads tools and continues, with actual tool results in the next request', async () => {
  const h = harness([tool('read_canvas', {}), [{ role: 'assistant', content: '我看到了当前结构。' }, {}]]);
  const result = await h.runtime.run('当前画布里有什么？');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 2);
  const observation = h.contexts[1].find(m => m.role === 'tool');
  assert.equal(JSON.parse(observation.content).counts.atoms, 1);
  assert.equal(JSON.parse(observation.content).snapshotOmitted, true);
  assert.ok(h.contexts[1].some(m => m.role === 'system' && m.content.includes('existing-atom')));
});

test('repeating an identical operation id in a later batch does not commit it twice', async () => {
  const h = harness([tool('draw_operations', { operations: [molecule] }), tool('draw_operations', { operations: [molecule], finish: true }, 'call2')]);
  const result = await h.runtime.run('画分子');
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 2);
  assert.equal(h.applied.length, 1);
});

test('unrequested text and duplicate raw JSON keys never commit', async () => {
  const label = { id: 'caption', type: 'text.add', text: 'Mechanism', x: 0, y: 0 };
  const h = harness([tool('draw_operations', { operations: [label], finish: true }), [{ content: '没有添加未要求的文字。' }, {}]]);
  const result = await h.runtime.run('画机理，不要标注');
  assert.equal(result.status, 'needs_continue');
  assert.equal(result.canContinue, true);
  assert.equal(h.applied.length, 0);
  assert.ok(h.events.some(e => e.type === 'tool_end' && e.isError));
  const raw = '{"operations":[' + JSON.stringify(molecule) + '],"operations":[' + JSON.stringify({ ...molecule, id: 'second' }) + '],"finish":true}';
  const dup = harness([tool('draw_operations', raw), [{ content: '参数有误。' }, {}]]);
  await dup.runtime.run('画分子');
  assert.equal(dup.applied.length, 0);
  const failure = dup.events.find(e => e.type === 'tool_end' && e.isError);
  assert.equal(failure.diagnostic.phase, 'decode');
  assert.equal(failure.message, undefined);
});

test('drawing failures expose their stage and operation without sending raw error text to the panel', async () => {
  const h = harness([tool('draw_operations', { operations: [molecule] }), [{ content: '结构未能准备。' }, {}]], {
    bridge: { async applyOperations() {
      throw Object.assign(new DOMException('The string did not match the expected pattern.', 'SyntaxError'),
        { phase: 'prepare', operationIndex: 0, field: 'smiles' });
    } },
  });
  await h.runtime.run('画分子');
  const failure = h.events.find(e => e.type === 'tool_end' && e.isError);
  assert.deepEqual(failure.diagnostic, {
    phase: 'prepare', operationType: 'molecule.add', operationId: 'mol1', operationIndex: 0, field: 'smiles', errorName: 'SyntaxError',
  });
  assert.equal(failure.message, undefined);
  assert.doesNotMatch(JSON.stringify(failure), /expected pattern|\[CH3:1\]/);
});

test('the model receives the failing operation and atom, without the whole draw batch', async () => {
  const invalid = { id: 'bad', type: 'molecule.add', smiles: '[CH3:7][CH2:9]([H:10])[CH3:11]' };
  const h = harness([tool('draw_operations', { operations: [molecule, invalid] }), [{ content: '价态需要修正。' }, {}]], {
    bridge: { async applyOperations() {
      throw Object.assign(new Error('碳原子价态为 5'), {
        code: 'smiles_valence', phase: 'prepare', operationType: 'molecule.add', operationId: invalid.id,
        field: 'smiles', atomIndex: 1, atomMap: 9,
      });
    } },
  });
  await h.runtime.run('画分子');
  const message = h.contexts[1].find(item => item.role === 'tool');
  assert.deepEqual(JSON.parse(message.content), {
    phase: 'prepare', operationType: 'molecule.add', operationId: 'bad', field: 'smiles',
    atomIndex: 1, atomMap: 9, code: 'smiles_valence', errorName: 'Error', operationIndex: 1, reason: '碳原子价态为 5',
  });
  assert.ok(!message.content.includes(invalid.smiles));
});

test('unavailable pi diagnostics reach the model and corrected failed operation ids remain reusable', async () => {
  const bad = { id: 'carbonyl-pi', type: 'arrow.add', source: { type: 'bond', bondId: 'acid:bond:2', component: 'pi' },
    target: { type: 'atom', atomId: 'acid:2' }, electronCount: 2 };
  const corrected = { ...bad, source: { ...bad.source, bondId: 'acid:bond:1' } };
  let attempts = 0;
  const h = harness([tool('draw_operations', { operations: [bad] }),
    tool('draw_operations', { operations: [corrected], finish: true }, 'retry')], {
    bridge: { async applyOperations(operations) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('箭头来源键没有可用的 π 电子'), {
        code: 'arrow_pi_unavailable', operationId: bad.id, operationType: bad.type, field: 'source.component',
        sourceEndpoint: { type: 'bond', reason: 'piUnavailable', bondId: 'bd-oh', bondRef: 'acid:bond:2',
          component: 'pi', bondOrder: 1, atomIds: ['at-c', 'at-oh'], rawArguments: 'HIDDEN' },
        targetEndpoint: { type: 'atom', atomIds: ['at-o'], atomRefs: ['acid:2'] },
      });
      h.applied.push({ ops: operations });
      return { created: operations.map(op => ({ id: op.id })), summary: 'applied' };
    } },
  });
  assert.equal((await h.runtime.run('画分子')).status, 'completed');
  const diagnostic = JSON.parse(h.contexts[1].find(item => item.role === 'tool').content);
  assert.equal(diagnostic.code, 'arrow_pi_unavailable');
  assert.equal(diagnostic.sourceEndpoint.reason, 'piUnavailable');
  assert.equal(diagnostic.sourceEndpoint.bondOrder, 1);
  assert.deepEqual(diagnostic.sourceEndpoint.atomIds, ['at-c', 'at-oh']);
  assert.deepEqual(diagnostic.targetEndpoint.atomRefs, ['acid:2']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /HIDDEN|rawArguments/);
  assert.equal(attempts, 2); assert.deepEqual(h.applied[0].ops, [corrected]);
});

test('failed docking exposes bounded real arrow blockers and the original operation to the model', async () => {
  const failure = { arrowId: 'ar-blocked', operationId: 'attack', code: 'electron_flow_crowding', intermolecular: false,
    atomIds: ['at-label', 'unsafe reference', ...Array.from({ length: 7 }, (_, i) => 'at-' + i)],
    bondIds: ['bd-blocked'], reasons: ['curve_length', '<unsafe>'], privatePayload: 'must-not-appear',
    sourceLonePair: { id: 'lp-blocked', ownerAtomId: 'at-donor', angle: 11.4, refAtomId: null, privatePayload: 'must-not-appear' } };
  const h = harness([tool('draw_operations', { operations: [molecule] }), [{ content: '需要修正局部电子流。' }, {}]], {
    bridge: { async applyOperations() {
      throw Object.assign(new Error('本批次已完整撤销。'), { code: 'reaction_reagent_layout_failed',
        layoutFailures: [null, failure, ...Array.from({ length: 8 }, () => ({ arrowId: 'ar-next' }))], relatedOperationIds: ['attack'] });
    } },
  });
  await h.runtime.run('画分子');
  const diagnostic = h.events.find(e => e.type === 'tool_end' && e.isError).diagnostic;
  assert.equal(diagnostic.layoutFailures.length, 4);
  assert.deepEqual(diagnostic.layoutFailures[0], { arrowId: 'ar-blocked', operationId: 'attack',
    code: 'electron_flow_crowding', intermolecular: false, atomIds: ['at-label', 'at-0', 'at-1', 'at-2'],
    bondIds: ['bd-blocked'], reasons: ['curve_length'],
    sourceLonePair: { id: 'lp-blocked', ownerAtomId: 'at-donor', angle: 11.4, refAtomId: null } });
  const message = JSON.parse(h.contexts[1].find(item => item.role === 'tool').content);
  assert.deepEqual(message.layoutFailures, diagnostic.layoutFailures);
  assert.deepEqual(message.relatedOperationIds, ['attack']);
  assert.equal(message.reason, '本批次已完整撤销。');
  assert.doesNotMatch(JSON.stringify(message), /must-not-appear|unsafe/);
});

test('structure preflight passes atom and bond tables to the model without a canvas edit', async () => {
  const structures = [{ id: 'candidate', smiles: '[CH3:1][Br:2]' }];
  const result = [{ id: 'candidate', ok: true, atoms: [{ ref: '1' }, { ref: '2' }], bonds: [{ ref: '1', begin: '1', end: '2' }] }];
  const h = harness([tool('inspect_structures', { structures }), [{ content: '结构可以解析。' }, {}]], {
    bridge: { async inspectStructures(input) { assert.deepEqual(input, structures); return result; } },
  });
  assert.equal((await h.runtime.run('检查这个结构')).status, 'completed');
  assert.equal(h.applied.length, 0);
  assert.deepEqual(JSON.parse(h.contexts[1].find(item => item.role === 'tool').content), result);
});

test('explicit canvas annotations are allowed', async () => {
  const label = { id: 'caption', type: 'text.add', text: '亲核中心', x: 0, y: 0 };
  const h = harness([tool('draw_operations', { operations: [label], finish: true })]);
  await h.runtime.run('在图上标注亲核中心');
  assert.equal(h.applied.length, 1);
});

test('long tasks ignore legacy output budgets while bounding redundant tool history and read-only loops', async () => {
  const h = harness([...Array.from({ length: 6 }, (_, i) => tool('read_canvas', {}, 'read-' + i)),
    [{ content: '研究完毕' }, {}]], { config: { maxTurns: 3, maxTokens: 1024 } });
  const result = await h.runtime.run('持续研究当前结构');
  assert.equal(h.requests.length, 6, 'the shared no-progress fence ends the loop; the legacy maxTurns budget stays ignored');
  assert.equal(result.status, 'needs_continue');
  assert.equal(result.canContinue, true);
  assert.equal(h.requests.at(-1).messages.filter(message => message.role === 'tool').length, 2);
  const followUp = await h.runtime.run('还有一个问题');
  assert.equal(followUp.status, 'completed');
  assert.equal(followUp.canContinue, false);
  assert.equal(h.requests.at(-1).messages.filter(message => message.role === 'tool').length, 2);
  const users = h.requests.at(-1).messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content : message.content.map(part => part.text || '').join(''));
  assert.ok(users.includes('持续研究当前结构') && users.includes('还有一个问题'));
  assert.ok(h.requests.every(req => req.max_tokens === undefined && req.max_completion_tokens === undefined));
});

test('multiple tasks retain every user constraint without accumulating large old canvas observations', async () => {
  const canvas = { sessionId: 'doc1', revision: 1, atoms: [{ id: 'tail', alias: 'snapshot'.repeat(2000) }], bonds: [],
    molecules: [], arrows: [], lonePairs: [], reactionSteps: [] };
  const count = 14;
  const h = harness(Array.from({ length: count }, (_, i) => [tool('read_canvas', {}, 'read-' + i),
    [{ content: '已读' }, {}]]).flat(), { bridge: { getContext: async () => structuredClone(canvas) } });
  const users = Array.from({ length: count }, (_, i) => '约束-' + i + '：保持原步骤身份；本轮修正覆盖前一轮误判。');
  for (const user of users) assert.equal((await h.runtime.run(user)).status, 'completed');
  const sent = h.requests.at(-1).messages;
  for (const user of users) assert.ok(JSON.stringify(sent.filter(m => m.role === 'user')).includes(user));
  assert.equal(sent.filter(m => m.role === 'tool').length, 2);
  const size = request => Buffer.byteLength(JSON.stringify(request));
  assert.ok(size(h.requests.at(-1)) < size(h.requests[7]) + 5000, 'old full-canvas observations stop accumulating across tasks');
  assert.ok(h.runtime._messages.length > sent.length, 'local conversation history remains available to the UI');
});

test('the next real runtime request refreshes the system canvas and preserves current operation aliases', async () => {
  const canvas = { sessionId: 'doc1', revision: 1, atoms: [], bonds: [], molecules: [], arrows: [], lonePairs: [], reactionSteps: [] };
  const h = harness([tool('draw_operations', { operations: [molecule] }), [{ content: '已修改' }, {}]], { bridge: {
    getContext: async () => structuredClone(canvas),
    async applyOperations() {
      canvas.revision = 2; canvas.atoms.push({ id: 'born', label: 'C' });
      return { created: [{ id: 'mol1', type: 'molecule.add', atoms: [{ id: 'born', ref: '1', label: 'C' }] }] };
    },
  } });
  assert.equal((await h.runtime.run('只添加该单分子')).status, 'completed');
  const text = h.requests[1].messages.find(m => m.role === 'system').content;
  const current = JSON.parse(text.slice(text.indexOf('Current canvas context (JSON):\n') + 'Current canvas context (JSON):\n'.length));
  assert.equal(current.revision, 2);
  assert.equal(current.atoms[0].id, 'born');
  assert.equal(current.activeOperationAliases[0].atoms[0].id, 'born');
  assert.equal(current.activeOperationAliases[0].id, 'mol1');
});

test('ordinary chat can still run before a canvas bridge is available', async () => {
  let request;
  const runtime = new Runtime({ bridge: null, getConfig: async () => config, eventTarget: new EventTarget(),
    fetch: async (_url, init) => { request = JSON.parse(init.body); return sse([{ content: '可以先讨论。' }, {}]); } });
  assert.equal((await runtime.run('先讨论想法')).status, 'completed');
  assert.ok(request.messages.find(message => message.role === 'system').content.includes('"available":false'));
});

test('long input and the tail of a large canvas context reach the provider', async () => {
  const context = { atoms: [{ label: 'C', alias: '中'.repeat(91_000) }, { id: 'last-live-atom' }] };
  const prompt = '研究'.repeat(17_000) + ' user-tail';
  const h = harness([[{ content: '已读' }, {}]], { bridge: { getContext: async () => context } });
  assert.equal((await h.runtime.run(prompt)).status, 'completed');
  assert.ok(h.contexts[0].some(message => message.role === 'system' && message.content.includes('last-live-atom')));
  const sent = h.contexts[0].find(message => message.role === 'user').content;
  assert.equal(typeof sent === 'string' ? sent : sent.map(part => part.text || '').join(''), prompt);
});

test('stop and a manual canvas change cancel in-flight requests and fence later writes', async () => {
  const h = harness([init => sse(tool('draw_operations', { operations: [molecule], finish: true }), { delay: 20, signal: init.signal })]);
  const pending = h.runtime.run('画分子');
  while (!h.requests.length) await sleep(1);
  const change = new Event('molstudio:agent-canvas-change'); change.detail = { source: 'manual' };
  h.target.dispatchEvent(change);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.canContinue, true);
  assert.equal(h.events.find(event => event.type === 'run_end').reason, 'canvas_changed');
  assert.equal(h.applied.length, 0);
  assert.equal(h.cancelled.length, 1);
  assert.equal(h.runtime.isRunning, false);
});

test('document replacement stops a run and prevents continuing its drawing in the new document', async () => {
  const h = harness([init => sse(tool('draw_operations', { operations: [molecule], finish: true }), { delay: 20, signal: init.signal })]);
  const pending = h.runtime.run('画分子');
  while (!h.requests.length) await sleep(1);
  const change = new Event('molstudio:agent-canvas-change'); change.detail = { source: 'manual', reason: 'load' };
  h.target.dispatchEvent(change);
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.canContinue, false);
  assert.equal(h.events.find(event => event.type === 'run_end').reason, 'document_changed');
  assert.throws(() => h.runtime.continue(), /没有可在当前文档继续/);
  assert.equal(h.applied.length, 0);
});

test('reset while initial context is pending prevents an old run from reaching the provider', async () => {
  let release;
  const h = harness([[{ content: 'new' }, {}]], { bridge: { getContext: () => new Promise(resolve => { release = resolve; }) } });
  const pending = h.runtime.run('old');
  while (!release) await sleep(1);
  h.runtime.reset(); release({ sessionId: 'old-document' });
  assert.equal((await pending).status, 'stopped');
  assert.equal(h.requests.length, 0);
});

test('missing configuration surfaces setup state and never calls a model', async () => {
  const h = harness([], { config: { configured: false } });
  const result = await h.runtime.run('你好');
  assert.equal(result.status, 'setup_required');
  assert.equal(h.requests.length, 0);
  assert.ok(h.events.some(e => e.type === 'error' && e.code === 'SETUP_REQUIRED'));
});

test('stop followed immediately by continue retains the original task without dangling tool calls', async () => {
  const h = harness([
    init => sse(tool('draw_operations', { operations: [molecule], finish: true }), { delay: 20, signal: init.signal }),
    [{ content: '从当前图继续。' }, {}],
  ]);
  const old = h.runtime.run('画甲醇进攻溴甲烷的机理');
  while (!h.requests.length) await sleep(1);
  h.runtime.stop();
  const resumed = h.runtime.continue();
  const result = await resumed;
  assert.equal(result.status, 'completed');
  assert.equal(result.canContinue, false);
  assert.equal(h.events.some(e => e.code === 'MECHANISM_INCOMPLETE'), false);
  assert.equal((await old).status, 'stopped');
  const resumedMessages = JSON.stringify(h.contexts[1]);
  assert.ok(resumedMessages.includes('画甲醇进攻溴甲烷的机理'));
  assert.equal(h.contexts[1].some(m => m.role === 'assistant' && m.tool_calls?.length), false);
  assert.equal(h.events.filter(e => e.type === 'run_end').length, 2);
  assert.equal(h.events.find(e => e.type === 'run_end' && e.status === 'stopped').reason, 'user');
});

test('a normally finishing run remains busy until scoped bridge cleanup has completed', async () => {
  let release, cleaning = false;
  const h = harness([[{ content: 'done' }, {}]], { bridge: {
    clearPreview: () => { cleaning = true; return new Promise(resolve => { release = resolve; }); },
  } });
  const pending = h.runtime.run('hello');
  while (!cleaning) await sleep(1);
  assert.equal(h.runtime.isRunning, true);
  await assert.rejects(h.runtime.run('too early'), /正在运行/);
  release();
  assert.equal((await pending).status, 'completed');
  assert.equal(h.runtime.isRunning, false);
});

test('a length-truncated tool call is discarded, then the same run can finish safely', async () => {
  const h = harness([
    init => sse(tool('draw_operations', { operations: [molecule], finish: true }, 'truncated'), { signal: init.signal, finishReason: 'length' }),
    tool('draw_operations', { operations: [molecule], finish: true }, 'retry'),
  ]);
  const result = await h.runtime.run('画分子');
  assert.equal(result.status, 'completed');
  assert.equal(h.applied.length, 1);
  assert.equal(h.requests.length, 2);
  assert.ok(h.events.some(e => e.type === 'tool_end' && e.isError && e.toolCallId === 'truncated'));
  assert.ok(h.contexts[1].every(message => !JSON.stringify(message).includes('truncated')));
});

test('the first complete operation is previewed before the rest of its tool parameters arrive', async () => {
  let releaseTail, sentTail = false;
  const gate = new Promise(resolve => { releaseTail = resolve; });
  const prefix = '{"operations":[' + JSON.stringify(molecule) + ',';
  const suffix = JSON.stringify({ id: 'lp1', type: 'lonePair.add', atom: 'mol1:2' }) + '],"finish":true}';
  const h = harness([() => {
    const encoder = new TextEncoder();
    const frame = (delta, finish_reason = null) => encoder.encode('data: ' + JSON.stringify({ id: 'chat', created: 0, model: config.model,
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'live', type: 'function', function: { name: 'draw_operations', arguments: prefix } }] }));
      await gate; sentTail = true;
      controller.enqueue(frame({ tool_calls: [{ index: 0, function: { arguments: suffix } }] }));
      controller.enqueue(frame({}, 'tool_calls'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }]);
  const pending = h.runtime.run('画分子和孤对电子');
  while (!h.previews.length) await sleep(1);
  assert.equal(sentTail, false);
  assert.equal(h.previews[0].ops.length, 1);
  assert.equal(h.applied.length, 0);
  releaseTail();
  assert.equal((await pending).status, 'completed');
  assert.equal(h.applied[0].ops.length, 2);
});

test('a provider that truncates twice without progress leaves a continuable task', async () => {
  const h = harness([init => sse([{ reasoning_content: 'private' }, {}], { signal: init.signal, finishReason: 'length' })]);
  const result = await h.runtime.run('解释这个反应');
  assert.equal(result.status, 'needs_continue');
  assert.equal(result.canContinue, true);
  assert.equal(h.requests.length, 2);
  assert.ok(h.events.some(e => e.type === 'error' && e.code === 'OUTPUT_TRUNCATED'));
  assert.equal(JSON.stringify(h.events.filter(e => e.type !== 'thinking_delta')).includes('private'), false);
  // 截断后的断点恢复提示已写入消息历史，"继续"会从画布现状出发
  const continuation = h.runtime.continue();
  await continuation;
  assert.equal(h.requests.length, 4);
});

test('summarizeOperations formats pre-execution summary and post-execution changes across operation types', () => {
  const ops = [
    { id: 'step1', type: 'reactionStep.create', reactants: ['nuc:1', 'sub:1'], products: ['prod:1'], layout: { conditions: 'THF' } },
    { id: 'nuc', type: 'molecule.add', smiles: '[OH-:1]' },
    { id: 'sub', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
    { id: 'h1', type: 'hydrogen.makeExplicit', parentAtomId: 'sub:1' },
    { id: 'lp1', type: 'lonePair.add', atom: 'nuc:1' },
    { id: 'lp2', type: 'lonePair.modify', lonePairId: 'lp-existing', aim: 'auto' },
    { id: 'arr1', type: 'arrow.add', source: { type: 'lonePair', id: 'lp1' }, target: { type: 'formingBond', atom1: 'nuc:1', atom2: 'sub:1' }, electronCount: 2 },
    { id: 'arr2', type: 'arrow.modify', arrowId: 'arr-old', mode: 'manual', bend: 0.4 },
    { id: 'mv1', type: 'molecule.move', target: { molecule: 'mol:1' }, dx: 1.5, dy: -0.5 },
    { id: 'am1', type: 'atom.modify', atomId: 'a1', charge: -1, radical: 0 },
    { id: 'b1', type: 'bond.add', begin: 'a1', end: 'a2', order: 1 },
    { id: 'b2', type: 'bond.modify', bondId: 'bond-9', order: 2 },
    { id: 'step2', type: 'reactionStep.modify', stepId: 'rs-2', expectedVersion: 1, layout: { conditions: '' } },
    { id: 'step3', type: 'reactionStep.delete', stepId: 'rs-3', expectedVersion: 2 },
    { id: 'del1', type: 'arrow.delete', arrowId: 'arr-99' },
    { id: 'tidy1', type: 'layout.tidy' },
    { id: 'txt1', type: 'text.add', text: 'SN2', x: 0, y: 0 },
    { id: 'seal1', type: 'step.seal' },
  ];
  const pre = summarizeOperations(ops);
  assert.match(pre.summary, /新增 2 个分子/);
  assert.match(pre.summary, /创建 1 个反应步骤/);
  assert.match(pre.summary, /新增 1 根弯箭头/);
  assert.equal(pre.previewItems.length, ops.length - 1);
  assert.equal(pre.changes.length, 0);

  const post = summarizeOperations(ops, {
    stepMapping: { step1: 'rs-101' },
    steps: [
      { operationId: 'step1', stepId: 'rs-101', version: 1, action: 'create' },
      { operationId: 'step2', stepId: 'rs-2', version: 2, action: 'modify' },
      { operationId: 'step3', stepId: 'rs-3', version: 3, action: 'delete' },
    ],
    created: [
      { id: 'nuc', type: 'molecule.add', molId: 'mol:1' },
      { id: 'b1', type: 'bond.add', bonds: [{ id: 'bond-new-1' }] },
    ],
    updated: [
      { id: 'mv1', type: 'molecule.move', molecule: 'mol:1', from: { x: 0, y: 0 }, to: { x: 1.5, y: -0.5 } },
      { id: 'b2', type: 'bond.modify', bondId: 'bond-9', before: 1, after: 2 },
    ],
    deleted: [
      { id: 'del1', type: 'arrow.delete', arrowIds: ['arr-99'] },
    ],
  });
  assert.ok(post.changes.includes('+ 反应步骤 rs-101 (v1, nuc:1 + sub:1 → prod:1, THF)'));
  assert.ok(post.changes.includes('+ 分子 mol:1 ([OH-:1])'));
  assert.ok(post.changes.includes('+ 分子 sub ([CH3:1][Br:2])'));
  assert.ok(post.changes.includes('+ 显式氢 h1:1 (父原子 sub:1)'));
  assert.ok(post.changes.includes('+ 孤对 lp1 (原子 nuc:1, 自动朝向)'));
  assert.ok(post.changes.includes('✎ 孤对 lp-existing (auto)'));
  assert.ok(post.changes.includes('+ 弯箭头 arr1 (lp1 → nuc:1⋯sub:1, 2e⁻)'));
  assert.ok(post.changes.includes('✎ 弯箭头 arr-old (manual, bend=0.4)'));
  assert.ok(post.changes.includes('⇄ 移动 mol:1 (0,0 → 1.5,-0.5)'));
  assert.ok(post.changes.includes('✎ 原子 a1 (电荷 -1, 自由基 0)'));
  assert.ok(post.changes.includes('+ 化学键 bond-new-1 (a1—a2, 键级 1)'));
  assert.ok(post.changes.includes('✎ 化学键 bond-9 (键级 1 → 2)'));
  assert.ok(post.changes.includes('✎ 修改步骤 rs-2 (v2, 条件: 清除)'));
  assert.ok(post.changes.includes('- 删除步骤 rs-3'));
  assert.ok(post.changes.includes('- 删除弯箭头 arr-99'));
  assert.ok(post.changes.includes('⇄ 整理画布布局'));
  assert.ok(post.changes.includes('+ 文本 txt1 (SN2)'));
});

test('executeExternalTool enforces mutual exclusion, manages session run, and supports draw_operations, post_message, and reset_session', async () => {
  let sessionId = 'doc-a', beginRuns = 0, endRuns = 0;
  const h = harness([], {
    bridge: {
      async getContext() { return { sessionId, atoms: [], molecules: [], bonds: [], lonePairs: [], arrows: [], reactionSteps: [] }; },
      async beginRun() { beginRuns++; return { sessionId }; },
      async endRun() { endRuns++; },
      async applyOperations(ops, info) {
        h.applied.push({ ops, info });
        return {
          created: ops.map(op => ({ id: op.id, type: op.type })),
          summary: 'applied',
        };
      },
    },
  });

  // First external tool call creates a new run bound to doc-a.
  const readRes = await h.runtime.executeExternalTool('read_canvas', {}, { clientName: 'Claude Code' });
  assert.equal(readRes.ok, true);
  assert.equal(readRes.isError, false);
  assert.equal(beginRuns, 1);
  assert.equal(h.runtime.isRunning, false);
  const firstRunId = h.runtime._externalRun.id;
  assert.ok(h.events.some(e => e.type === 'run_start' && e.runId === firstRunId && e.external === true && e.clientName === 'Claude Code'));
  assert.ok(h.events.some(e => e.type === 'external_idle' && e.runId === firstRunId && e.isError === false));

  // Second call on same sessionId reuses the run.
  const drawRes = await h.runtime.executeExternalTool('draw_operations', {
    operations: [molecule, { id: 'seal1', type: 'step.seal' }],
    allowText: false,
  });
  assert.equal(drawRes.ok, true);
  assert.equal(drawRes.isError, false);
  assert.equal(beginRuns, 1);
  assert.equal(h.previews.length, 1);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(drawRes.changes, ['+ 分子 mol1 ([CH3:1][Br:2])']);
  const toolStart = h.events.find(e => e.type === 'tool_start' && e.toolName === 'draw_operations');
  const toolEnd = h.events.find(e => e.type === 'tool_end' && e.toolName === 'draw_operations');
  assert.deepEqual(toolStart.changes, ['+ 分子 mol1 ([CH3:1][Br:2])']);
  assert.deepEqual(toolEnd.changes, ['+ 分子 mol1 ([CH3:1][Br:2])']);

  // post_message emits markdown assistant message events.
  const msgRes = await h.runtime.executeExternalTool('post_message', { text: '已完成绘制。' });
  assert.equal(msgRes.ok, true);
  assert.ok(h.events.some(e => e.type === 'text_delta' && e.delta === '已完成绘制。'));

  // Changing sessionId starts a new run.
  sessionId = 'doc-b';
  await h.runtime.executeExternalTool('read_canvas', {});
  assert.equal(beginRuns, 2);
  assert.equal(endRuns, 1);
  assert.notEqual(h.runtime._externalRun.id, firstRunId);

  // reset_session forces a new run even on the same sessionId.
  const beforeResetId = h.runtime._externalRun.id;
  const resetRes = await h.runtime.executeExternalTool('reset_session', {});
  assert.equal(resetRes.ok, true);
  assert.equal(beginRuns, 3);
  assert.notEqual(h.runtime._externalRun.id, beforeResetId);

  // Built-in AI running blocks external calls with mutual exclusion error.
  let releaseBuiltIn;
  const builtInBridge = new Promise(resolve => { releaseBuiltIn = resolve; });
  const h2 = harness([[{ role: 'assistant', content: 'ok' }, {}]], {
    bridge: {
      async getContext() { return { sessionId: 'doc-1' }; },
      async beginRun() { await builtInBridge; return { sessionId: 'doc-1' }; },
    },
  });
  const pendingBuiltIn = h2.runtime.run('测试');
  await sleep(0);
  await assert.rejects(() => h2.runtime.executeExternalTool('read_canvas', {}), /内置 AI 助手正在运行，请先停止或等待完成/);
  releaseBuiltIn();
  await pendingBuiltIn;
});

test('runtime.stop aborts active external batch and clears preview', async () => {
  let cleared = 0, releaseApply;
  const gate = new Promise(resolve => { releaseApply = resolve; });
  const h = harness([], {
    bridge: {
      async getContext() { return { sessionId: 'doc-stop' }; },
      async beginRun() { return { sessionId: 'doc-stop' }; },
      async previewOperations() {},
      async clearPreview() { cleared++; },
      async applyOperations(_ops, settings) {
        assert.ok(settings.signal);
        await gate;
        if (settings.signal.aborted) throw Object.assign(new Error('操作已停止'), { name: 'AbortError' });
        return { created: [] };
      },
    },
  });

  const pending = h.runtime.executeExternalTool('draw_operations', { operations: [molecule] });
  await sleep(10);
  assert.equal(h.runtime.isRunning, true);
  await h.runtime.stop('user');
  releaseApply();
  const res = await pending;
  assert.equal(res.isError, true);
  assert.equal(res.diagnostic.code, 'aborted');
  assert.ok(cleared >= 1);
  assert.equal(h.runtime.isRunning, false);
  assert.ok(h.events.some(e => e.type === 'run_end' && e.external === true && e.status === 'stopped'));
});
