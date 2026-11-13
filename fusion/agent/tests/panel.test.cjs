'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../panel.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(options = {}, prefs) {
  const dom = new JSDOM('<!doctype html><body><iframe id="k" style="transform:translate(20px,30px)"></iframe></body>', { url: 'http://127.0.0.1:8462/canvas.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w, 'innerWidth', { value: 1360, writable: true });
  if (prefs !== undefined) w.localStorage.setItem('molstudio.agent.panel.v1', typeof prefs === 'string' ? prefs : JSON.stringify(prefs));
  w.eval(source);
  const panel = new w.MolStudioAgentPanel(options);
  return {
    w, d: w.document, panel,
    key(key, extras) { const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extras }); panel.input.dispatchEvent(event); return event; },
    event(type, data) { return panel.handleEvent({ type, ...data }); },
    close() { panel.destroy(); w.close(); }
  };
}

test('Enter sends once, Shift+Enter stays native, and composition confirmation never submits', async t => {
  const sent = []; const f = fixture({ onSend: value => sent.push(value) }); t.after(() => f.close());
  f.panel.input.value = '分两行';
  assert.equal(f.key('Enter', { shiftKey: true }).defaultPrevented, false);
  f.panel.input.dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true }));
  f.key('Enter'); f.key('Enter', { isComposing: true });
  assert.deepEqual(sent, []);
  f.panel.input.dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true, data: '机理' }));
  f.key('Enter'); assert.deepEqual(sent, []);
  await tick();
  f.panel.input.value = '画 SN2 机理';
  assert.equal(f.key('Enter').defaultPrevented, true);
  f.key('Enter');
  assert.deepEqual(sent, ['画 SN2 机理']);
  assert.equal(f.d.querySelectorAll('.mol-agent-user-message').length, 1);
  assert.equal(f.panel.input.value, ''); assert.equal(f.panel.running, true);
});

test('visible model text is safe and hidden thinking is never rendered', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'r1' });
  f.event('assistant_start', { runId: 'r1' });
  const payload = '<img src=x onerror="window.pwned=true"><script>bad()</script>';
  f.event('text_delta', { runId: 'r1', delta: payload });
  f.event('thinking', { runId: 'r1', delta: 'SECRET_INTERNAL_REASONING', active: true });
  f.event('text_delta', { runId: 'r1', channel: 'analysis', delta: 'HIDDEN_CHANNEL' });
  assert.equal(f.panel.chat.querySelector('img,script'), null);
  assert.ok(f.panel.chat.textContent.includes(payload));
  assert.ok(!f.panel.element.textContent.includes('SECRET_INTERNAL_REASONING'));
  assert.ok(!f.panel.element.textContent.includes('HIDDEN_CHANNEL'));
  assert.equal(f.panel.status.textContent, '正在思考…');
  f.event('thinking', { runId: 'r1', active: false });
  assert.equal(f.panel.running, true);
  assert.equal(f.panel.status.textContent, '正在处理…');
});

test('actual model thinking is folded, text-safe and buffered while closed even under many deltas', async t => {
  const f = fixture(); t.after(() => f.close()); f.event('run_start', { runId: 'model-thinking' });
  f.event('thinking_delta', { runId: 'model-thinking', source: 'internal', delta: 'DO_NOT_RENDER' });
  assert.equal(f.panel.chat.querySelector('details'), null);
  const sample = '<img src=x onerror="bad()">合成思考\n';
  for (let n = 0; n < 5000; n++) f.event('thinking_delta', { runId: 'model-thinking', source: 'model', delta: sample });
  const details = f.panel.chat.querySelector('.mol-agent-thinking'), body = details.querySelector('pre');
  assert.equal(details.open, false); assert.equal(body.textContent, '');
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-thinking').length, 1);
  details.open = true; details.dispatchEvent(new f.w.Event('toggle'));
  assert.equal(body.textContent, sample.repeat(5000)); assert.equal(body.querySelector('img'), null);
  const original = body.firstChild;
  f.event('thinking_delta', { runId: 'model-thinking', source: 'model', delta: '后一段' }); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(body.firstChild, original); assert.ok(body.textContent.endsWith('后一段'));
  f.panel.clear(); assert.equal(f.panel.chat.querySelector('.mol-agent-thinking'), null);
});

test('elapsed, received bytes and waiting states stay separate from completion and never disable Stop', t => {
  const f = fixture(); t.after(() => f.close()); f.event('run_start', { runId: 'progress' });
  f.event('thinking', { runId: 'progress', active: true });
  f.event('transport_progress', { runId: 'progress', elapsedMs: 32000, receivedBytes: 18636, phase: 'receiving' });
  assert.equal(f.panel.elapsed.textContent, '· 累计 32秒'); assert.match(f.panel.elapsed.title, /多次模型请求/); assert.match(f.panel.transportProgress.textContent, /18\.2 KB.*持续接收中/);
  assert.equal(f.panel.status.textContent, '正在思考…'); assert.equal(f.panel.stopButton.hidden, false); assert.equal(f.panel.stopButton.disabled, false);
  f.event('transport_progress', { runId: 'progress', elapsedMs: 36000, receivedBytes: 18636, phase: 'waiting', lastByteAgoMs: 4200 });
  assert.match(f.panel.transportProgress.textContent, /等待新数据.*4秒/);
  f.event('run_end', { runId: 'progress', status: 'completed' });
  const frozen = f.panel.transportProgress.textContent; assert.equal(f.panel.status.textContent, '已完成');
  assert.equal(f.event('transport_progress', { runId: 'progress', elapsedMs: 999000, receivedBytes: 999999, phase: 'receiving' }), false);
  assert.equal(f.panel.transportProgress.textContent, frozen);
  f.panel.clear(); assert.equal(f.panel.transportProgress.hidden, true); assert.equal(f.panel.elapsed.hidden, true);
  f.event('run_start', { runId: 'empty' });
  f.event('transport_progress', { runId: 'empty', elapsedMs: 1000, receivedBytes: 0, phase: 'waiting_first_byte' });
  assert.match(f.panel.transportProgress.textContent, /尚未收到模型数据.*等待本次首批数据/);
  f.event('run_end', { runId: 'empty', status: 'error' }); assert.match(f.panel.transportProgress.textContent, /未收到模型数据.*接收已结束/);
});

test('an explicit upstream interruption replaces live receiving state and offers continuation', t => {
  const f = fixture({ onContinue() {} }); t.after(() => f.close());
  f.event('run_start', { runId: 'upstream' });
  f.event('transport_progress', { runId: 'upstream', elapsedMs: 42000, receivedBytes: 18000, phase: 'receiving' });
  f.event('error', { runId: 'upstream', code: 'upstream_stream_error', message: '上游连接中断，已完成内容保留，可继续执行', fatal: false });
  f.event('run_end', { runId: 'upstream', reason: 'upstream_stream_error', status: 'needs_continue', canContinue: true });
  assert.match(f.panel.status.textContent, /^上游连接中断/); assert.equal(f.panel.continueButton.hidden, false);
  assert.doesNotMatch(f.panel.transportProgress.textContent, /持续接收中/); assert.match(f.panel.transportProgress.textContent, /接收已结束/);
});

test('bounded recovery stays stoppable after run end, offers manual continuation at the bound and rejects stale events', async t => {
  let stops = 0;
  const f = fixture({ onContinue() {}, onStop() { stops++; } }); t.after(() => f.close());
  f.event('run_start', { runId: 'interrupted' });
  f.event('run_end', { runId: 'interrupted', reason: 'upstream_stream_error', status: 'needs_continue', canContinue: true });
  assert.equal(f.event('recovery_scheduled', { runId: 'interrupted', attempt: 1, delayMs: 1000 }), true);
  assert.match(f.panel.status.textContent, /1秒后.*1\/2/); assert.equal(f.panel.running, true);
  assert.equal(f.panel.stopButton.hidden, false); assert.equal(f.panel.stopButton.disabled, false); assert.equal(f.panel.continueButton.hidden, true);
  await f.panel._stop(); assert.equal(stops, 1);
  f.event('recovery_cancelled', { runId: 'interrupted', reason: 'user', canContinue: true });
  assert.equal(f.panel.running, false); assert.equal(f.panel.continueButton.hidden, false);
  f.event('run_start', { runId: 'recovered', recoveryAttempt: 1 });
  assert.match(f.panel.status.textContent, /断点续跑.*1\/2/);
  assert.equal(f.d.querySelectorAll('.mol-agent-user-message').length, 0);
  assert.equal(f.event('recovery_cancelled', { runId: 'interrupted', reason: 'document_changed', canContinue: false }), false);
  assert.equal(f.panel.running, true);
  f.event('run_end', { runId: 'recovered', reason: 'upstream_stream_error', status: 'needs_continue', canContinue: true });
  f.event('recovery_exhausted', { runId: 'recovered', recoveryAttempts: 2 });
  assert.equal(f.panel.running, false); assert.equal(f.panel.continueButton.hidden, false);
  assert.match(f.panel.status.textContent, /已达 2 次/); assert.match(f.panel.errorBox.textContent, /手动继续/);
  f.panel.clear();
  assert.equal(f.event('recovery_scheduled', { runId: 'recovered', attempt: 1, delayMs: 1000 }), false);
  assert.equal(f.panel.running, false); assert.equal(f.panel.continueButton.hidden, true);
});

test('pending recovery cancellation follows document and model changes', t => {
  const f = fixture({ onContinue() {} }); t.after(() => f.close());
  f.event('run_start', { runId: 'cancel' });
  f.event('run_end', { runId: 'cancel', status: 'needs_continue', canContinue: true });
  f.event('recovery_scheduled', { runId: 'cancel', attempt: 1, delayMs: 1000 });
  f.event('recovery_cancelled', { runId: 'cancel', reason: 'config_changed', canContinue: true });
  assert.match(f.panel.status.textContent, /模型设置已变化/); assert.equal(f.panel.continueButton.hidden, false);
  f.event('recovery_cancelled', { runId: 'cancel', reason: 'document_changed', canContinue: false });
  assert.match(f.panel.status.textContent, /已切换文档/); assert.equal(f.panel.continueButton.hidden, true);
});

test('streamed replies render Markdown and local MathML without loading untrusted markup', async t => {
  const { renderMessage } = await import('../message-render.js');
  const f = fixture(); t.after(() => f.close());
  f.w.MolStudioAgentRuntime = { renderMessage };
  f.event('run_start', { runId: 'markdown' });
  f.event('assistant_start', { runId: 'markdown' });
  f.event('assistant_end', { runId: 'markdown' });
  assert.equal(f.panel.chat.querySelector('.mol-agent-assistant-message'), null);
  f.event('assistant_start', { runId: 'markdown' });
  f.event('text_delta', { runId: 'markdown', delta: '**反应**\n\n- 水 ' + String.raw`\(\ce{H2` });
  const body = f.panel.chat.querySelector('.mol-agent-message-text');
  assert.match(body.textContent, /反应/);
  f.event('text_delta', { runId: 'markdown', delta: String.raw`O}\)` + '\n- `$SMILES$`\n\n' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(body.querySelector('strong').textContent, '反应');
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.ok(body.querySelector('math msub'));
  assert.equal(body.querySelector('code').textContent, '$SMILES$');

  f.event('text_delta', { runId: 'markdown', delta: '$$x^2$$\n\n' +
    '[docs](https://example.test) [bad](javascript:evil) [local](/api/agent/config)\n\n' +
    '![alt text](https://example.test/img.png) <img src="https://example.test/raw.png" onerror="bad()">\n\n' +
    String.raw`$\includegraphics{https://example.test/math.png}$` });
  f.event('assistant_end', { runId: 'markdown' });
  assert.ok(body.querySelector('math[display="block"]'));
  const links = body.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].hostname, 'example.test');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(body.querySelector('img, [onerror], [src]'), null);
  assert.match(body.textContent, /alt text/);
});

test('assistant messages and rounds remain separate, including starts without messageId', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'first' });
  f.event('assistant_start', { runId: 'first' }); f.event('text_delta', { runId: 'first', delta: '先读取结构。' });
  f.event('assistant_start', { runId: 'first' }); f.event('text_delta', { runId: 'first', delta: '现在补上箭头。' });
  f.event('run_end', { runId: 'first', status: 'completed', turns: 2 });
  f.event('run_start', { runId: 'second' });
  f.event('assistant_start', { runId: 'second', messageId: 'm1' });
  f.event('text_delta', { runId: 'second', messageId: 'm1', delta: '第二个问题。' });
  const messages = [...f.panel.chat.querySelectorAll('.mol-agent-assistant-message .mol-agent-message-text')].map(n => n.textContent);
  assert.deepEqual(messages, ['先读取结构。', '现在补上箭头。', '第二个问题。']);
  assert.equal(f.event('text_delta', { runId: 'first', delta: '迟到消息' }), false);
  assert.equal(f.event('run_start', { runId: 'first' }), false);
});

test('stop is idempotent until acknowledgement, keeps completed work, and offers continuation when supported', async t => {
  let stopCalls = 0, continued = 0;
  const f = fixture({ onStop: async () => { stopCalls++; }, onContinue: () => { continued++; } }); t.after(() => f.close());
  f.event('run_start', { runId: 'stop-run' });
  f.event('tool_start', { runId: 'stop-run', toolCallId: 'done', toolName: 'draw_operations' });
  f.event('tool_end', { runId: 'stop-run', toolCallId: 'done', isError: false });
  f.event('tool_start', { runId: 'stop-run', toolCallId: 'pending', toolName: 'draw_operations' });
  f.panel.stopButton.click(); await tick(); f.panel.stopButton.click();
  assert.equal(stopCalls, 1); assert.equal(f.panel.running, true); assert.equal(f.panel.stopButton.disabled, true);
  f.event('run_end', { runId: 'stop-run', status: 'stopped', canContinue: true, turns: 3 });
  assert.equal(f.panel.running, false);
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool.is-complete').length, 1);
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool.is-running').length, 0);
  assert.ok(f.panel.chat.textContent.includes('已停止'));
  assert.equal(f.panel.continueButton.hidden, false);
  f.panel.continueButton.click(); await tick();
  assert.equal(continued, 1); assert.equal(f.panel.running, true);
});

test('canvas edits and document replacement have separate stop messages and continuation rules', t => {
  const f = fixture({ onContinue() {} }); t.after(() => f.close());
  f.event('run_start', { runId: 'canvas-change' });
  f.event('run_end', { runId: 'canvas-change', status: 'stopped', reason: 'canvas_changed', canContinue: true });
  assert.match(f.panel.status.textContent, /画布有新编辑/);
  assert.equal(f.panel.continueButton.hidden, false);
  f.event('resume_unavailable', { reason: 'document_changed' });
  assert.match(f.panel.status.textContent, /已切换文档/);
  assert.equal(f.panel.continueButton.hidden, true);
  f.event('run_start', { runId: 'another-canvas' });
  f.event('run_end', { runId: 'another-canvas', status: 'stopped', reason: 'document_changed', canContinue: false });
  assert.match(f.panel.status.textContent, /已切换文档/);
  assert.equal(f.panel.continueButton.hidden, true);
});

test('optional public plans update in place, tool failures and real progress do not become fake success', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'plan-run' });
  assert.equal(f.panel.chat.querySelector('.mol-agent-plan'), null);
  f.event('plan', { runId: 'plan-run', steps: [{ id: 'a', text: '查看底物', status: 'completed' }, { id: 'b', text: '<img>推电子', status: 'running' }] });
  f.event('plan', { runId: 'plan-run', steps: [{ id: 'a', text: '查看底物', status: 'completed' }, { id: 'b', text: '推电子', status: 'completed' }] });
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-plan').length, 1);
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-plan li.is-complete').length, 2);
  f.event('tool_start', { runId: 'plan-run', toolCallId: 't', toolName: 'draw_operations' });
  f.event('tool_progress', { runId: 'plan-run', toolCallId: 't', progress: { phase: 'committed', count: 4 } });
  assert.ok(f.panel.chat.textContent.includes('已完成 4 项绘图操作'));
  assert.ok(!f.panel.chat.textContent.includes('%'));
  f.event('tool_end', { runId: 'plan-run', toolCallId: 't', isError: true, message: '目标原子已删除' });
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool.is-failed').length, 1);
  assert.ok(f.panel.chat.textContent.includes('目标原子已删除'));
  f.event('tool_progress', { runId: 'plan-run', toolCallId: 't', progress: { phase: 'applying' } });
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool.is-running').length, 0);
  f.event('usage', { runId: 'plan-run', usage: { input: 100, output: 20, totalTokens: 120 }, turns: 2 });
  assert.match(f.panel.usage.textContent, /2 次请求/); assert.match(f.panel.usage.textContent, /120 tokens/);
});

test('streaming does not steal scroll position while reading earlier messages', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'scroll' }); f.event('assistant_start', { runId: 'scroll' });
  Object.defineProperty(f.panel.chat, 'scrollHeight', { value: 1200, configurable: true });
  Object.defineProperty(f.panel.chat, 'clientHeight', { value: 400, configurable: true });
  f.panel.chat.scrollTop = 150;
  f.event('text_delta', { runId: 'scroll', delta: '还在生成。' });
  assert.equal(f.panel.chat.scrollTop, 150); assert.equal(f.panel.newMessagesButton.hidden, false);
  f.panel.newMessagesButton.click();
  assert.equal(f.panel.chat.scrollTop, 1200); assert.equal(f.panel.newMessagesButton.hidden, true);
});

test('text editing shortcuts and clipboard remain native inside the panel instead of reaching canvas handlers', t => {
  const f = fixture(); t.after(() => f.close()); f.panel.setOpen(true);
  let canvasKeys = 0, canvasCopies = 0;
  f.d.addEventListener('keydown', () => canvasKeys++);
  f.d.addEventListener('copy', () => canvasCopies++);
  for (const key of ['Delete', 'Backspace', 'z', 'a', 'c']) {
    const event = f.key(key, { metaKey: key.length === 1 });
    assert.equal(event.defaultPrevented, false);
  }
  const copy = new f.w.Event('copy', { bubbles: true, cancelable: true }); f.panel.input.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, false); assert.equal(canvasKeys, 0); assert.equal(canvasCopies, 0);
  f.panel.input.focus(); assert.equal(f.panel.ownsFocus(), true);
  f.d.getElementById('k').focus(); assert.equal(f.panel.ownsFocus(), false);
});

test('settings use callbacks, never redisplay a key, preserve an empty key, and display persistence notice', async t => {
  const saved = [];
  const config = { provider: 'openai-compatible', model: 'test-model', baseUrl: 'https://model.example/v1', configured: true, maxTurns: 24, apiKey: 'SHOULD_NOT_EVER_BE_RENDERED', sessionToken: 'TOKEN_NOT_FOR_UI' };
  const f = fixture({ onSettingsLoad: async () => config, onSettingsSave: async values => { saved.push(values); return { ...config, notice: '密钥仅保留在当前会话。' }; } }); t.after(() => f.close());
  await f.panel.showSettings();
  assert.equal(f.panel.apiKeyInput.type, 'password'); assert.equal(f.panel.apiKeyInput.value, '');
  assert.ok(!f.panel.element.textContent.includes(config.apiKey)); assert.ok(!JSON.stringify(f.panel._config).includes(config.apiKey));
  await f.panel._saveSettings();
  assert.equal(saved.length, 1); assert.equal(saved[0].apiKey, ''); assert.ok(!('maxTurns' in saved[0]));
  assert.equal(f.panel.settingsStatus.textContent, '密钥仅保留在当前会话。');
  f.panel.apiKeyInput.value = 'new-user-secret'; await f.panel._saveSettings();
  assert.equal(saved[1].apiKey, 'new-user-secret'); assert.equal(f.panel.apiKeyInput.value, '');
});

test('generation settings show truthful provider choices, preserve total cap and lock during a run', async t => {
  const saved = [];
  const config = { configured: true, model: 'deepseek-v4.1-flash', baseUrl: 'http://127.0.0.1:8788/v1',
    generation: { profile: 'deepseek', effort: 'low', maxOutputTokens: 16384 },
    generationCapabilities: { openaiModels: { 'gpt-5.1': ['none', 'low', 'medium', 'high'], 'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'] } } };
  const f = fixture({ onSettingsLoad: async () => config, onSettingsSave: async value => { saved.push(value); return { ...config, generation: value.generation }; } }); t.after(() => f.close());
  await f.panel.showSettings();
  assert.deepEqual(Array.from(f.panel.generationEffortInput.options, option => option.value), ['default', 'none', 'low', 'high', 'max']);
  assert.equal(f.panel.generationEffortInput.value, 'low'); assert.equal(f.panel.maxOutputTokensInput.value, '16384');
  assert.match(f.panel.settingsView.textContent, /不是独立思考预算.*不保证响应秒数/);
  f.panel.generationEffortInput.value = 'none'; await f.panel._saveSettings();
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0].generation)), { profile: 'deepseek', effort: 'none', maxOutputTokens: 16384 });
  assert.equal(saved[0].apiKey, '');
  f.panel.setRunning(true);
  for (const control of [f.panel.modelInput, f.panel.baseUrlInput, f.panel.apiKeyInput, f.panel.generationProfileInput, f.panel.generationEffortInput, f.panel.maxOutputTokensInput, f.panel.settingsSaveButton]) assert.equal(control.disabled, true);
  await f.panel._saveSettings(); assert.equal(saved.length, 1);
  f.panel.setRunning(false);
  f.panel.generationProfileInput.value = 'provider-default'; f.panel.generationProfileInput.dispatchEvent(new f.w.Event('change'));
  assert.equal(f.panel.generationEffortInput.value, 'default'); assert.equal(f.panel.generationEffortInput.disabled, true);
  assert.match(f.panel.generationHelp.textContent, /不发送思考.*本机反代/);
  f.panel.maxOutputTokensInput.value = ''; await f.panel._saveSettings();
  assert.deepEqual(JSON.parse(JSON.stringify(saved[1].generation)), { profile: 'provider-default', effort: 'default', maxOutputTokens: null });
});

test('OpenAI settings follow server model capabilities and unknown models offer only service default', async t => {
  const f = fixture(); t.after(() => f.close());
  f.panel.setConfig({ model: 'gpt-5.2', generation: { profile: 'openai', effort: 'xhigh' }, generationCapabilities: {
    openaiModels: { 'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'], 'gpt-5.1': ['none', 'low', 'medium', 'high'] }, apiKey: 'DO_NOT_COPY',
  } });
  assert.equal(f.panel.generationEffortInput.value, 'xhigh');
  f.panel.modelInput.value = 'gpt-5.1-2025-11-13'; f.panel.modelInput.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.panel.generationEffortInput.value, 'default');
  assert.equal(Array.from(f.panel.generationEffortInput.options).some(option => option.value === 'xhigh'), false);
  f.panel.modelInput.value = 'future-unknown'; f.panel.modelInput.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.panel.generationEffortInput.options.length, 1); assert.equal(f.panel.generationEffortInput.disabled, true);
  assert.match(f.panel.generationHelp.textContent, /尚无已核实/);
  assert.doesNotMatch(JSON.stringify(f.panel._config), /DO_NOT_COPY/);
});

test('saved task and phase events expose explicit continuation without starting a request', t => {
  let resumed = 0;
  const f = fixture({ onContinue() { resumed++; return false; } }); t.after(() => f.close());
  f.event('task_checkpoint', { checkpoint: { taskId: 'saved', goal: '完成咖啡因两条路线', status: 'paused', phaseIndex: 1,
    phases: [{ id: 'one', objective: '第一条路线', status: 'completed' }, { id: 'two', objective: '第二条路线', status: 'pending' }] } });
  f.event('resume_available', { reason: 'saved_task', taskId: 'saved' });
  assert.equal(resumed, 0); assert.equal(f.panel.running, false); assert.equal(f.panel.continueButton.hidden, false);
  assert.match(f.panel.taskProgress.textContent, /完成咖啡因两条路线.*1\/2.*第二条路线/);
  f.event('run_start', { runId: 'phases' });
  f.event('phase_start', { runId: 'phases', phaseIndex: 1, phaseCount: 2, objective: '绘制第二条路线' });
  assert.match(f.panel.taskProgress.textContent, /阶段 2\/2.*绘制第二条路线/);
  f.event('phase_end', { runId: 'phases', phaseIndex: 1, summary: '结构与电子流已核对' });
  assert.match(f.panel.taskProgress.textContent, /已核对.*结构与电子流/);
  f.event('run_end', { runId: 'phases', status: 'completed' });
  f.event('resume_unavailable', { reason: 'document_changed' });
  assert.equal(f.panel.continueButton.hidden, true); assert.equal(f.panel.taskProgress.hidden, true);
});

test('late settings responses and late run events cannot resurrect cleared state', async t => {
  let resolveSettings;
  const f = fixture({ onSettingsLoad: () => new Promise(resolve => { resolveSettings = resolve; }) }); t.after(() => f.close());
  const loading = f.panel.showSettings(); await f.panel.showSettings(false);
  resolveSettings({ model: 'late-model', configured: true }); await loading;
  assert.equal(f.panel.settingsView.hidden, true); assert.notEqual(f.panel.modelLabel.textContent, 'late-model');
  f.event('run_start', { runId: 'old-run' }); f.event('text_delta', { runId: 'old-run', delta: '旧消息' });
  f.panel.clear();
  assert.equal(f.event('text_delta', { runId: 'old-run', delta: '迟到消息' }), false);
  assert.equal(f.event('run_start', { runId: 'old-run' }), false);
  assert.equal(f.panel.chat.textContent.includes('旧消息'), false);
  assert.equal(f.panel.running, false);
  f.event('run_start', { runId: 'new-run' }); f.event('text_delta', { runId: 'new-run', delta: '新对话' });
  assert.equal(f.panel.chat.textContent.includes('新对话'), true);
});

test('a cleared send cannot change a newer run when its old request fails', async t => {
  let reject;
  const f = fixture({ onSend: () => new Promise((_resolve, rejectOld) => { reject = rejectOld; }) }); t.after(() => f.close());
  f.panel.input.value = '旧问题'; f.key('Enter');
  f.panel.clear(); f.event('run_start', { runId: 'new' });
  reject(new Error('旧请求失败')); await tick();
  assert.equal(f.panel.running, true); assert.equal(f.panel.errorBox.hidden, true);
});

test('a cleared continuation cannot change a newer run when its old request fails', async t => {
  let reject;
  const f = fixture({ onContinue: () => new Promise((_resolve, rejectOld) => { reject = rejectOld; }) }); t.after(() => f.close());
  f.event('run_start', { runId: 'old' }); f.event('run_end', { runId: 'old', status: 'limit', canContinue: true });
  f.panel.continueButton.click();
  f.panel.clear(); f.event('run_start', { runId: 'new' });
  reject(new Error('旧继续请求失败')); await tick();
  assert.equal(f.panel.running, true); assert.equal(f.panel.errorBox.hidden, true);
});

test('a new continuation clears the prior drawing warning and can end with text', async t => {
  const f = fixture({ onContinue() {
    f.event('run_start', { runId: 'clarification' });
    f.event('text_delta', { runId: 'clarification', delta: '请先确认反应路线。' });
    f.event('run_end', { runId: 'clarification', status: 'completed', canContinue: false });
  } }); t.after(() => f.close());
  f.event('run_start', { runId: 'drawing' });
  f.event('error', { runId: 'drawing', fatal: false, message: '机理尚未画完整。' });
  f.event('run_end', { runId: 'drawing', status: 'needs_continue', reason: 'mechanism_incomplete', canContinue: true });
  assert.equal(f.panel.errorBox.hidden, false);
  f.panel.continueButton.click(); await tick();
  assert.equal(f.panel.errorBox.hidden, true);
  assert.equal(f.panel.continueButton.hidden, true);
  assert.match(f.panel.chat.textContent, /请先确认反应路线/);
});

test('legacy view preferences are bounded, drawer layout preserves canvas transform and current chat', t => {
  const changes = [];
  const f = fixture({ onToggle: (open, layout) => changes.push({ open, ...layout }) }, { isOpen: true, panelWidth: 99999 }); t.after(() => f.close());
  assert.equal(f.panel.open, true); assert.equal(f.panel.width, 560);
  f.event('run_start', { runId: 'resize' }); f.event('text_delta', { runId: 'resize', delta: '保持内容' });
  f.w.innerWidth = 800; f.w.dispatchEvent(new f.w.Event('resize'));
  assert.equal(f.panel.getLayout().drawer, true); assert.ok(f.panel.width <= 800);
  f.panel.setOpen(false); assert.equal(f.d.body.classList.contains('mol-agent-open'), false);
  f.panel.setOpen(true); assert.ok(f.panel.chat.textContent.includes('保持内容'));
  assert.equal(f.d.getElementById('k').style.transform, 'translate(20px,30px)');
  assert.ok(changes.some(change => change.drawer === true));
});

test('setup-required and a turn limit retain natural conversation instead of claiming success', t => {
  const f = fixture({ onContinue() {} }); t.after(() => f.close());
  f.event('run_start', { runId: 'setup' }); f.event('run_end', { runId: 'setup', status: 'setup_required' });
  assert.equal(f.panel.status.textContent, '请先配置模型');
  assert.equal(f.panel.configNotice.hidden, false);
  f.event('run_start', { runId: 'long-task' }); f.event('run_end', { runId: 'long-task', status: 'limit', turns: 24, canContinue: true });
  assert.equal(f.panel.continueButton.hidden, false); assert.match(f.panel.usage.textContent, /24 次请求/);
  assert.ok(!f.panel.element.textContent.includes('一次请求'));
  f.event('run_start', { runId: 'full-canvas' });
  f.event('run_end', { runId: 'full-canvas', status: 'needs_continue', reason: 'viewport_full', canContinue: true });
  assert.equal(f.panel.status.textContent, '可见画布空间不足，调整视图后继续');
  assert.equal(f.panel.continueButton.hidden, false);
});

test('manual edits, stale revisions and model failures show distinct recovery states', t => {
  const f = fixture({ onContinue() {} }); t.after(() => f.close());
  const scenarios = [
    ['manual_edit', 'stopped', '画布已手动编辑'],
    ['canvas_stale', 'stopped', '画布版本已更新'],
    ['transport_interrupted', 'needs_continue', '模型连接中断'],
    ['no_progress', 'needs_continue', '连续尝试未推进'],
    ['mechanism_incomplete', 'needs_continue', '机理尚未画完整'],
    ['drawing_failed', 'needs_continue', '有绘图操作未完成'],
  ];
  for (const [reason, status, prefix] of scenarios) {
    f.event('run_start', { runId: reason });
    if (reason === 'transport_interrupted') {
      f.event('transport_retry', { runId: reason });
      assert.equal(f.panel.status.textContent, '模型连接失败，正在重连…');
    }
    f.event('run_end', { runId: reason, reason, status, canContinue: true });
    assert.ok(f.panel.status.textContent.startsWith(prefix), reason);
    assert.equal(f.panel.continueButton.hidden, false, reason);
  }
});

test('malformed tool arguments show a concise failure without the received payload', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'invalid-arguments' });
  f.event('tool_end', { runId: 'invalid-arguments', toolCallId: 'draw', toolName: 'draw_operations', isError: true,
    message: 'Invalid arguments for tool "draw_operations": JSON Parse error\n\nReceived arguments:\n{"operations":[{"id":"hidden-payload"}]}' });
  assert.match(f.panel.chat.textContent, /这次绘图未能应用/);
  assert.doesNotMatch(f.panel.chat.textContent, /Received arguments|hidden-payload|JSON Parse/);
});

test('drawing failure shows the offending operation and field with a short explanation', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'bad-arrow' });
  f.event('tool_end', { runId: 'bad-arrow', toolCallId: 'draw', toolName: 'draw_operations', isError: true,
    message: 'The string did not match the expected pattern.',
    diagnostic: { phase: 'apply', code: 'wrong_arrow_type', errorName: 'SyntaxError', operationIndex: 1, operationType: 'arrow.modify', field: 'arrowId' } });
  const failed = f.panel.chat.querySelector('.mol-agent-tool.is-failed');
  assert.match(failed.textContent, /只支持电子流弯箭头.*第 2 项 arrow\.modify arrowId/);
  assert.doesNotMatch(failed.textContent, /expected pattern/);
  assert.equal(failed.querySelector('[title]').title, '写入画布 · SyntaxError · wrong_arrow_type');
});

test('actionable tool errors keep visible codes, causal messages and safe expandable diagnostics after no-progress pause', async t => {
  const diagnostics = await import('../tool-diagnostic.js');
  const f = fixture({ onContinue() {} }); t.after(() => f.close()); f.w.MolStudioAgentRuntime = diagnostics;
  f.event('run_start', { runId: 'diagnostics' });
  const cases = [
    { code: 'reaction_reagent_layout_failed', phase: 'layout', operationId: 'fix-arrow', reason: '试剂右侧停靠时电子流过长；本批次已完整撤销。',
      relatedOperationIds: ['fix-arrow', 'modify-step'], layoutFailures: [{ arrowId: 'arrow-12', operationId: 'fix-arrow', code: 'curve_unreadable',
        reasons: ['too_long', 'label_collision'], atomIds: ['atom-4'], bondIds: ['bond-3'], endpointMovesWithReagent: false }] },
    { code: 'operation_conflict', phase: 'validate', operationId: 'already-used', reason: '操作编号 already-used 已用于不同内容，请使用新编号。' },
    { code: 'step_version_conflict', phase: 'apply', stepId: 'step-4', expectedVersion: 2, currentVersion: 3, reason: '当前步骤版本是 3，请读取最新画布再修改。' },
  ];
  for (const [index, diagnostic] of cases.entries()) {
    f.event('tool_end', { runId: 'diagnostics', toolName: 'draw_operations', toolCallId: 'error-' + index, isError: true,
      diagnostic: { ...diagnostic, apiKey: 'HIDDEN_KEY', reasoning_content: 'HIDDEN_REASONING', arguments: { payload: 'HIDDEN_ARGUMENTS' } } });
    const card = f.panel.chat.querySelectorAll('.mol-agent-tool.is-failed')[index];
    assert.match(card.textContent, new RegExp(diagnostic.code)); assert.ok(card.textContent.includes(diagnostic.reason));
    const details = card.querySelector('.mol-agent-tool-diagnostic'); assert.equal(details.open, false);
    const detail = JSON.parse(details.querySelector('pre').textContent);
    assert.equal(detail.code, diagnostic.code); assert.equal(detail.reason, diagnostic.reason);
    assert.doesNotMatch(card.textContent, /HIDDEN_/);
    if (index === 0) { assert.deepEqual(detail.layoutFailures[0].reasons, ['too_long', 'label_collision']); assert.deepEqual(detail.relatedOperationIds, ['fix-arrow', 'modify-step']); }
    if (index === 2) { assert.equal(detail.expectedVersion, 2); assert.equal(detail.currentVersion, 3); }
  }
  f.event('run_end', { runId: 'diagnostics', status: 'needs_continue', reason: 'no_progress', canContinue: true });
  assert.match(f.panel.status.textContent, /连续尝试未推进.*最近错误：step_version_conflict/);
  assert.equal(f.panel.continueButton.hidden, false); assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool-diagnostic').length, 3);
});

test('completion check failure distinguishes committed drawing from transaction failure and shows repair details', async t => {
  const f = fixture(); t.after(() => f.close()); f.w.MolStudioAgentRuntime = await import('../tool-diagnostic.js');
  f.event('run_start', { runId: 'completion' });
  f.event('tool_end', { runId: 'completion', toolName: 'draw_operations', toolCallId: 'draw', isError: false,
    result: { result: { finishAccepted: false, finishRejected: '步骤 step-8 缺少羰基 π 键电子流。',
      missingElectronFlowSteps: [{ stepId: 'step-8', operationIds: ['new-arrow'], missing: ['carbonyl_pi_flow'] }] } } });
  const card = f.panel.chat.querySelector('.mol-agent-tool');
  assert.equal(card.classList.contains('is-failed'), false); assert.equal(card.classList.contains('is-complete'), false); assert.equal(card.classList.contains('is-incomplete'), true);
  assert.match(card.textContent, /绘图已提交.*完成核对尚未通过.*completion_check_failed.*step-8/);
  assert.doesNotMatch(card.textContent, /本批次已撤回/);
  const diagnostic = JSON.parse(card.querySelector('pre').textContent);
  assert.equal(diagnostic.code, 'completion_check_failed'); assert.equal(diagnostic.missingElectronFlowSteps[0].stepId, 'step-8');
  assert.equal(f.panel.status.textContent, '绘图已提交，完成核对尚未通过');
});

test('long useful errors and SDK field errors are shortened without losing their cause or exposing argument echoes', async t => {
  const f = fixture(); t.after(() => f.close()); f.w.MolStudioAgentRuntime = await import('../tool-diagnostic.js');
  const cause = '步骤版本已变化，请先读取当前版本。';
  f.panel.showError(cause + '请保留已完成内容。'.repeat(50)); assert.ok(f.panel.errorText.textContent.startsWith(cause)); assert.ok(f.panel.errorText.textContent.length <= 320);
  f.event('run_start', { runId: 'schema' });
  f.event('tool_end', { runId: 'schema', toolCallId: 'invalid', toolName: 'draw_operations', isError: true,
    message: 'Validation failed for tool "draw_operations":\n- operations.0.target.atom2: missing\n\nReceived arguments:\n{"secret":"HIDDEN_ARGUMENTS"}' });
  assert.match(f.panel.chat.textContent, /operations\.0\.target\.atom2: missing/);
  assert.doesNotMatch(f.panel.chat.textContent, /Received arguments|HIDDEN_ARGUMENTS/);
});

test('external runs render badge, operation change list, and settle cleanly on external_idle', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'ext-1', external: true, clientName: 'Claude Code' });
  const badge = f.panel.chat.querySelector('.mol-agent-external-badge');
  assert.ok(badge);
  assert.equal(badge.textContent, '外部协同 · Claude Code');
  assert.equal(f.panel.status.textContent, '外部助手正在操作画布…');
  assert.equal(f.panel.transportProgress.hidden, true);
  assert.equal(f.panel.running, true);

  f.event('tool_start', {
    runId: 'ext-1', toolCallId: 'tc-1', toolName: 'draw_operations',
    summary: '新增 1 个分子', changes: ['+ 分子 nuc ([OH-:1])'],
  });
  let list = f.panel.chat.querySelector('.mol-agent-tool-changes');
  assert.ok(list);
  assert.deepEqual([...list.querySelectorAll('li')].map(li => li.textContent), ['+ 分子 nuc ([OH-:1])']);

  f.event('tool_end', {
    runId: 'ext-1', toolCallId: 'tc-1', toolName: 'draw_operations', isError: false,
    summary: '新增 1 个分子 · 创建 1 个反应步骤',
    changes: ['+ 分子 mol:1 ([OH-:1])', '+ 反应步骤 rs-1 (v1, nuc:1 → prod:1)'],
  });
  list = f.panel.chat.querySelector('.mol-agent-tool-changes');
  assert.deepEqual([...list.querySelectorAll('li')].map(li => li.textContent), ['+ 分子 mol:1 ([OH-:1])', '+ 反应步骤 rs-1 (v1, nuc:1 → prod:1)']);

  f.event('external_idle', { runId: 'ext-1', toolName: 'draw_operations', isError: false });
  assert.equal(f.panel.running, false);
  assert.equal(f.panel.status.textContent, '外部操作已应用');

  // Subsequent tool in the same external run appends to the same turn.
  f.event('tool_start', { runId: 'ext-1', toolCallId: 'tc-2', toolName: 'read_canvas', summary: '读取当前画布' });
  assert.equal(f.panel.running, true);
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-turn').length, 1);
  assert.equal(f.panel.chat.querySelectorAll('.mol-agent-tool').length, 2);
  f.event('tool_end', { runId: 'ext-1', toolCallId: 'tc-2', toolName: 'read_canvas', isError: true, error: '画布未就绪' });
  f.event('external_idle', { runId: 'ext-1', toolName: 'read_canvas', isError: true, error: '画布未就绪' });
  assert.equal(f.panel.running, false);
  assert.match(f.panel.status.textContent, /外部操作未完成/);
});

test('external completed checkpoint and status remain complete after read-only verification', t => {
  const f = fixture(); t.after(() => f.close());
  f.event('run_start', { runId: 'ext-complete', external: true, clientName: 'Codex' });
  f.event('task_checkpoint', { checkpoint: { goal: '完成外部绘图', status: 'completed', phaseIndex: 1,
    phases: [{ id: 'task', status: 'completed' }] } });
  f.event('external_idle', { runId: 'ext-complete', toolName: 'draw_operations', isError: false, taskCompleted: true });
  assert.equal(f.panel.status.textContent, '外部任务已完成');
  assert.match(f.panel.taskProgress.textContent, /阶段 1\/1 已完成.*任务已完成/);
  f.event('tool_start', { runId: 'ext-complete', toolCallId: 'verify', toolName: 'read_canvas' });
  f.event('tool_end', { runId: 'ext-complete', toolCallId: 'verify', toolName: 'read_canvas', isError: false });
  f.event('external_idle', { runId: 'ext-complete', toolName: 'read_canvas', isError: false, taskCompleted: true });
  assert.equal(f.panel.status.textContent, '外部任务已完成');
  assert.match(f.panel.taskProgress.textContent, /阶段 1\/1 已完成.*任务已完成/);
  assert.equal(f.panel.running, false);
});
