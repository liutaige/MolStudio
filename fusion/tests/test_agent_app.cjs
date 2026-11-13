'use strict';
// Real app/panel composition with a deferred Runtime fixture. No model or network calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const { JSDOM } = require('jsdom');
const panelSource = fs.readFileSync(path.join(repo, 'fusion/agent/panel.js'), 'utf8');
const appSource = fs.readFileSync(path.join(repo, 'fusion/agent/app.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(ready, deferred, checkpoint, extras = {}) {
  const dom = new JSDOM('<body><iframe id="k"></iframe></body>', { url: 'http://127.0.0.1:8462/canvas.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  let calls = 0, restores = 0, externalCalls = [], reject;
  const fetchCalls = [];
  window.k3dAPI = { agent: ready ? { getContext() { return { sessionId: 'doc-app-1' }; } } : {} };
  window.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ configured: true, model: 'fixture', baseUrl: 'https://fixture.invalid/v1', sessionToken: 'fixture-token' }) };
  };
  if (typeof extras.setupWindow === 'function') extras.setupWindow(window);
  window.MolStudioAgentRuntime = { Runtime: class {
    constructor(options) { this.options = options; this.isRunning = false; this._externalRun = null; window.runtimeFixture = this; }
    run() {
      calls++;
      if (deferred) return new Promise((_resolve, rejectOld) => { reject = rejectOld; });
      this.options.onEvent({ type: 'run_start', runId: 'fixture-run' });
      this.options.onEvent({ type: 'run_end', runId: 'fixture-run', status: 'completed' });
      return Promise.resolve({ status: 'completed' });
    }
    async executeExternalTool(tool, args, meta) {
      externalCalls.push({ tool, args, meta });
      this._externalRun = { id: 'ext-run-1', sessionId: 'doc-app-1' };
      return { ok: true, isError: false, text: JSON.stringify({ tool }), data: { tool }, changes: [] };
    }
    stop() {}
    reset() {}
    async restoreTaskCheckpoint() {
      restores++;
      if (checkpoint) {
        this.options.onEvent({ type: 'task_checkpoint', checkpoint });
        this.options.onEvent({ type: 'resume_available', reason: 'saved_task', taskId: checkpoint.taskId });
      }
    }
  } };
  window.eval(panelSource); window.eval(appSource);
  return {
    window, fetchCalls, externalCalls,
    get calls() { return calls; }, get restores() { return restores; }, get reject() { return reject; },
    close() { window.dispatchEvent(new window.Event('beforeunload')); window.molstudioAgent?.getPanel().destroy(); window.close(); },
  };
}

test('stopping while setup waits for the canvas prevents a later Runtime.run', async t => {
  const f = fixture(false, false); t.after(() => f.close());
  await wait(0);
  const panel = f.window.molstudioAgent.getPanel();
  panel.input.value = 'Draw only after initialization'; panel._send();
  await wait(0);
  panel.stopButton.click(); await wait(0);
  f.window.k3dAPI.agent.getContext = () => {};
  await wait(160);
  assert.equal(f.calls, 0, 'the cancelled pending prompt reached the model runtime');
  assert.equal(panel.running, false);
  assert.match(panel.status.textContent, /已停止/);
  assert.equal(f.window.molstudioAgent.isRunning(), false);
});

test('an old app.send rejection after clear does not overwrite a new run UI', async t => {
  const f = fixture(true, true); t.after(() => f.close());
  await wait(0);
  const panel = f.window.molstudioAgent.getPanel();
  panel.input.value = 'Old prompt'; panel._send();
  await wait(0);
  panel.clear();
  f.window.runtimeFixture.options.onEvent({ type: 'run_start', runId: 'new-run' });
  f.reject(new Error('Old runtime failure')); await wait(0);
  assert.equal(panel.running, true);
  assert.equal(panel.errorBox.hidden, true);
  assert.equal(panel.element.textContent.includes('Old runtime failure'), false);
});

test('app startup restores a saved task without invoking the model', async t => {
  const f = fixture(true, false, { version: 1, taskId: 'saved-task', goal: '继续已保存路线', status: 'paused', phaseIndex: 0,
    phases: [{ id: 'p1', objective: '补齐电子流', status: 'pending' }] }); t.after(() => f.close());
  await wait(0);
  const panel = f.window.molstudioAgent.getPanel();
  assert.equal(f.restores, 1); assert.equal(f.calls, 0);
  assert.equal(panel.running, false); assert.equal(panel.continueButton.hidden, false);
  assert.match(panel.taskProgress.textContent, /继续已保存路线.*补齐电子流/);
});

test('handleExternalCommand auto-opens panel on modifying tools and SSE bridge posts status and tool results', async t => {
  let latestES;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      latestES = this;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners.get(type) || []) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    close() { this.closed = true; }
  }

  const postedMessages = [];
  const f = fixture(true, false, null, {
    setupWindow(win) {
      win.EventSource = FakeEventSource;
      win.webkit = { messageHandlers: { k3d: { postMessage: msg => postedMessages.push(msg) } } };
    },
  });
  t.after(() => f.close());
  await wait(0);

  const panel = f.window.molstudioAgent.getPanel();
  assert.ok(latestES);
  assert.match(latestES.url, /^\/api\/agent\/external\/events\?clientId=/);

  panel.setOpen(false);
  await f.window.molstudioAgent.handleExternalCommand({ tool: 'read_canvas', args: {} });
  assert.equal(panel.open, true);
  assert.equal(postedMessages[0]?.act, 'revealCanvas');

  panel.setOpen(false);
  latestES.emit('connected', { clientId: 'c1', sessionId: 'doc-app-1' });
  latestES.emit('message', {
    type: 'tool_call',
    requestId: 'req-42',
    tool: 'draw_operations',
    args: { operations: [{ id: 'm1', type: 'molecule.add', smiles: 'CCO' }] },
    clientName: 'Claude Code',
  });
  await wait(10);

  assert.equal(panel.open, true);
  assert.equal(postedMessages.length, 2);
  assert.equal(f.externalCalls.length, 2);
  assert.equal(f.externalCalls[1].tool, 'draw_operations');
  const statusCalls = f.fetchCalls.filter(call => call.url === '/api/agent/external/status');
  const resultCalls = f.fetchCalls.filter(call => call.url === '/api/agent/external/result');
  assert.ok(statusCalls.length >= 1);
  assert.equal(resultCalls.length, 1);
  assert.equal(resultCalls[0].body.requestId, 'req-42');
  assert.equal(resultCalls[0].body.ok, true);
  assert.equal(resultCalls[0].body.isError, false);

  // Cancel before execution prevents tool call.
  latestES.emit('message', { type: 'cancel', requestId: 'req-99' });
  const cancelledRes = await f.window.molstudioAgent.handleExternalCommand({
    type: 'tool_call', requestId: 'req-99', tool: 'draw_operations', args: { operations: [] },
  });
  assert.equal(cancelledRes.isError, true);
  assert.equal(f.externalCalls.length, 2);
});
