'use strict';
/* Native AI renderer adapter tests: presentation filtering, resetGeneration,
 * stale-run rejection after clear, settings secret filtering, focus + layout. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../agent/native-renderer'); // agent/ is an ESM package: exports via globalThis.
const NativeAgentRenderer = globalThis.MolStudioAgentNativeRenderer;

function make() {
  const published = [];
  const renderer = new NativeAgentRenderer({ publish: p => published.push(p) });
  return { renderer, published };
}

test('visible text deltas accumulate into public messages; hidden channels never enter', () => {
  const { renderer, published } = make();
  assert.equal(renderer.handleEvent({ type: 'run_start', runId: 'r1' }), true);
  assert.equal(renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', delta: '亲核' }), true);
  assert.equal(renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', delta: '取代' }), true);
  assert.equal(renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', channel: 'reasoning', delta: 'SECRET-REASONING' }), true);
  assert.equal(renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', hidden: true, delta: 'HIDDEN' }), true);
  const snap = renderer.snapshot();
  const m = snap.messages.find(x => x.messageId === 'm1');
  assert.equal(m.text, '亲核取代');
  assert.equal(JSON.stringify(snap).includes('SECRET-REASONING'), false);
  assert.equal(JSON.stringify(snap).includes('HIDDEN'), false);
  const event = published.at(-1);
  assert.equal(event.mode, 'event');
  assert.equal(event.resetGeneration, 0);
  assert.ok(event.rendererRevision >= 1);
});

test('run_end sets canContinue; run lifecycle reflected in runs snapshot', () => {
  const { renderer } = make();
  renderer.handleEvent({ type: 'run_start', runId: 'r1' });
  renderer.handleEvent({ type: 'run_end', runId: 'r1', status: 'needs_continue', reason: 'mechanism_incomplete', canContinue: true });
  assert.equal(renderer.running, false);
  assert.equal(renderer.canContinue, true);
  assert.equal(renderer.snapshot().runs[0].status, 'needs_continue');
  renderer.handleEvent({ type: 'run_end', runId: 'r1', status: 'completed' });
  assert.equal(renderer.canContinue, false);
});

test('clear bumps resetGeneration and late events of cleared runs are dropped', () => {
  const { renderer, published } = make();
  renderer.handleEvent({ type: 'run_start', runId: 'r1' });
  renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', delta: '旧内容' });
  const before = renderer.resetGeneration;
  renderer.clear();
  assert.equal(renderer.resetGeneration, before + 1);
  assert.equal(renderer.snapshot().messages.length, 0);
  // Late event from the cleared run must not resurrect content.
  renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', delta: '迟到' });
  renderer.handleEvent({ type: 'tool_start', runId: 'r1', toolCallId: 't1', toolName: 'draw_operations' });
  assert.equal(renderer.snapshot().messages.length, 0);
  const last = published.at(-1);
  assert.equal(last.resetGeneration, before + 1);
  // A new run after reset works normally.
  renderer.handleEvent({ type: 'run_start', runId: 'r2' });
  assert.equal(renderer.snapshot().runs.length, 1);
  assert.equal(renderer.snapshot().runs[0].runId, 'r2');
});

test('tool_end failures expose compact public diagnostics only', () => {
  const { renderer, published } = make();
  renderer.handleEvent({ type: 'run_start', runId: 'r1' });
  renderer.handleEvent({
    type: 'tool_end', runId: 'r1', toolCallId: 't1', toolName: 'draw_operations', success: false,
    diagnostic: { code: 'arrow_pi_unavailable', phase: 'validate', sessionToken: 'leak', providerPayload: { secret: 'x' } }
  });
  const last = published.at(-1);
  assert.equal(last.event.diagnostic.code, 'arrow_pi_unavailable');
  assert.equal(last.event.diagnostic.phase, 'validate');
  assert.equal(JSON.stringify(last).includes('leak'), false);
  assert.equal(JSON.stringify(last).includes('providerPayload'), false);
});

test('settings/config stores public fields only: sessionToken and apiKey never kept', () => {
  const { renderer } = make();
  renderer.setConfig({
    configured: true, provider: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:9',
    sessionToken: 'secret-session', apiKey: 'sk-test', generation: { profile: 'deepseek', effort: 'low', maxOutputTokens: 4096 }
  });
  const json = JSON.stringify(renderer.snapshot());
  assert.equal(json.includes('secret-session'), false);
  assert.equal(json.includes('sk-test'), false);
  assert.equal(renderer.config.model, 'm');
  assert.equal(renderer.config.generation.effort, 'low');
});

test('native focus uses host.windowKey + focusOwner, not document focus', () => {
  let host = { windowKey: false, focusOwner: 'none' };
  const renderer = new NativeAgentRenderer({ hostContext: () => host });
  assert.equal(renderer.ownsFocus(), false);
  host = { windowKey: true, focusOwner: 'agent' };
  assert.equal(renderer.ownsFocus(), true);
  host = { windowKey: true, focusOwner: 'canvas' };
  assert.equal(renderer.ownsFocus(), false, 'canvas focus is not agent focus');
  host = { windowKey: false, focusOwner: 'agent' };
  assert.equal(renderer.ownsFocus(), false, 'background window never owns focus');
});

test('getLayout reports zero dock width so the iframe is never shrunk again', () => {
  const { renderer } = make();
  renderer.setOpen(true);
  assert.deepEqual(renderer.getLayout(), { open: true, width: 0, drawer: false });
  renderer.setOpen(false);
  assert.deepEqual(renderer.getLayout(), { open: false, width: 0, drawer: false });
  // Toggling does not reset the conversation.
  renderer.handleEvent({ type: 'run_start', runId: 'r1' });
  renderer.setOpen(false); renderer.setOpen(true);
  assert.equal(renderer.snapshot().runs.length, 1);
});

test('showSettings / showError publish presentation events; agent state flags stay public', () => {
  const { renderer, published } = make();
  renderer.showSettings(true);
  renderer.showError('无法读取模型设置');
  renderer.handleEvent({ type: 'transport_progress', requests: 2, phase: 'streaming' });
  renderer.handleEvent({ type: 'recovery_started', runId: 'r9', attempt: 1 });
  renderer.handleEvent({ type: 'resume_available' });
  assert.equal(renderer.settingsVisible, true);
  assert.equal(renderer.error.message, '无法读取模型设置');
  assert.equal(renderer.snapshot().transport.requests, 2);
  assert.equal(renderer.running, true);
  assert.equal(renderer.canContinue, true);
  const types = published.map(p => p.event.type);
  assert.deepEqual(types, ['settings_visible', 'error_shown', 'transport_progress', 'recovery_started', 'resume_available']);
});

test('publishSnapshot emits full snapshot mode with stable keys runId+messageId', () => {
  const { renderer, published } = make();
  renderer.handleEvent({ type: 'run_start', runId: 'r1' });
  renderer.handleEvent({ type: 'text_delta', runId: 'r1', messageId: 'm1', delta: 'hi' });
  published.length = 0;
  renderer.publishSnapshot(true);
  const snap = published[0];
  assert.equal(snap.mode, 'snapshot');
  assert.equal(snap.reset, true);
  assert.equal(snap.snapshot.messages[0].runId, 'r1');
  assert.equal(snap.snapshot.messages[0].messageId, 'm1');
  assert.equal(snap.snapshot.messages[0].id, 'm1');
  assert.equal(snap.snapshot.runs[0].id, 'r1');
  assert.equal(typeof snap.snapshot.runs[0].external, 'boolean');
  assert.equal(typeof snap.snapshot.runs[0].finished, 'boolean');
  assert.equal(typeof snap.snapshot.runs[0].thinkingText, 'string');
  assert.ok(Array.isArray(snap.snapshot.runs[0].plan));
  assert.ok(Array.isArray(snap.snapshot.runs[0].tools));
});

test('runtime events without messageId, user_message, model thinking_delta, phases, and onStateChange all align', () => {
  let stateChanges = 0;
  const published = [];
  const renderer = new NativeAgentRenderer({
    publish: p => published.push(p),
    onStateChange: () => { stateChanges++; }
  });
  renderer.handleEvent({ type: 'user_message', text: '画咖啡因反应路径' });
  renderer.handleEvent({ type: 'run_start', runId: 'rt-1', prompt: '画咖啡因反应路径' });
  renderer.handleEvent({ type: 'assistant_start', runId: 'rt-1' });
  renderer.handleEvent({ type: 'thinking_delta', runId: 'rt-1', source: 'model', delta: '规划步骤 ' });
  renderer.handleEvent({ type: 'text_delta', runId: 'rt-1', delta: '已完成' });
  renderer.handleEvent({ type: 'text_delta', runId: 'rt-1', delta: '绘制。' });
  renderer.handleEvent({ type: 'plan', runId: 'rt-1', steps: [{ text: '构建底物', status: 'done' }] });
  renderer.handleEvent({ type: 'phase_start', runId: 'rt-1', phaseIndex: 1, objective: '过渡态' });
  renderer.handleEvent({ type: 'tool_end', runId: 'rt-1', toolCallId: 'tc-1', toolName: 'draw_operations', success: true, summary: '4 ops', completedOperations: 4 });
  renderer.handleEvent({ type: 'step_commit', runId: 'rt-1', count: 2, completedOperations: 4 });
  renderer.handleEvent({ type: 'run_end', runId: 'rt-1', status: 'needs_continue', canContinue: true });

  const snap = renderer.snapshot();
  assert.equal(snap.messages.length, 2);
  assert.equal(snap.messages[0].role, 'user');
  assert.equal(snap.messages[0].text, '画咖啡因反应路径');
  assert.equal(snap.messages[1].role, 'assistant');
  assert.equal(snap.messages[1].text, '已完成绘制。');
  assert.ok(snap.messages[1].id && snap.messages[1].messageId);
  assert.equal(snap.runs[0].thinkingText, '规划步骤 ');
  assert.equal(snap.runs[0].plan[0].text, '构建底物');
  assert.equal(snap.runs[0].tools[0].summary, '4 ops');
  assert.ok(stateChanges >= 2, 'running/canContinue transitions notify host UIState');

  const phaseEvent = published.find(p => p.event && p.event.type === 'phase_start');
  assert.equal(phaseEvent.event.phaseIndex, 1);
  assert.equal(phaseEvent.event.objective, '过渡态');
  const toolEvent = published.find(p => p.event && p.event.type === 'tool_end');
  assert.equal(toolEvent.event.completedOperations, 4);
  assert.equal(toolEvent.event.summary, '4 ops');
  const commitEvent = published.find(p => p.event && p.event.type === 'step_commit');
  assert.equal(commitEvent.event.count, 2);
  assert.equal(commitEvent.event.completedOperations, 4);
});

test('ownsFocus matches Swift nativeText host.context and nested public events strip secrets', () => {
  let host = { windowKey: true, focusOwner: 'nativeText' };
  const published = [];
  const renderer = new NativeAgentRenderer({
    publish: p => published.push(p),
    hostContext: () => host
  });
  assert.equal(renderer.ownsFocus(), true, 'nativeText focus with key window owns AI/native text focus');
  host = { windowKey: true, focusOwner: 'canvas' };
  assert.equal(renderer.ownsFocus(), false);
  host = { windowKey: false, focusOwner: 'nativeText' };
  assert.equal(renderer.ownsFocus(), false);

  renderer.handleEvent({ type: 'run_start', runId: 'r-sec' });
  renderer.handleEvent({
    type: 'task_checkpoint',
    checkpoint: {
      goal: '路线绘制',
      status: 'running',
      phaseIndex: 0,
      phases: [{ objective: '第一阶段', status: 'running', sessionToken: 'tok-nested', apiKey: 'sk-nested' }],
      secret: 'raw-secret'
    }
  });
  renderer.handleEvent({
    type: 'tool_progress',
    runId: 'r-sec',
    toolCallId: 'tc-sec',
    toolName: 'draw_operations',
    progress: { phase: 'committed', count: 3, sessionToken: 'tok-nested', apiKey: 'sk-nested', raw: { nested: 'x' } }
  });
  renderer.handleEvent({
    type: 'generation_applied',
    generation: {
      requested: { profile: 'deepseek', effort: 'max', maxOutputTokens: 32768 },
      fields: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32768, apiKey: 'sk-nested', sessionToken: 'tok-nested' }
    }
  });
  renderer.handleEvent({
    type: 'tool_end',
    runId: 'r-sec',
    toolCallId: 'tc-sec',
    toolName: 'draw_operations',
    success: true,
    finishRejected: { reason: '未完', apiKey: 'sk-nested' },
    diagnostic: null
  });

  const wire = JSON.stringify({ published, snapshot: renderer.snapshot() });
  assert.equal(wire.includes('tok-nested'), false);
  assert.equal(wire.includes('sk-nested'), false);
  assert.equal(wire.includes('raw-secret'), false);
  assert.equal(renderer.snapshot().checkpoint.goal, '路线绘制');
  assert.equal(renderer.snapshot().checkpoint.phases[0].objective, '第一阶段');
  const progEv = published.find(p => p.event && p.event.type === 'tool_progress');
  assert.deepEqual(progEv.event.progress, { phase: 'committed', count: 3 });
  const genEv = published.find(p => p.event && p.event.type === 'generation_applied');
  assert.deepEqual(genEv.event.generation.fields, { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32768 });
});
