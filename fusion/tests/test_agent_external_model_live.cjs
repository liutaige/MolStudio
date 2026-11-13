// Real configured model -> stdio MCP -> isolated canvas. No source/shell tools.
// MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_external_model_live.cjs
// Optional: MOLSTUDIO_AGENT_EXTERNAL_CASE=hemiacetal,
// MOLSTUDIO_AGENT_EXTERNAL_DETAIL=full.
// MOLSTUDIO_AGENT_EXTERNAL_GATEWAY_URL may reuse an already configured local
// model gateway when its credentials exist only in the running app's memory.
// Credentials and hidden reasoning are never written to artifacts or console.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const CASES = {
  'corey-winter': '在当前空白画布中画出 cis-环己烷-1,2-二醇的 Corey–Winter 烯化机理，最终产物为环己烯。包含环硫代碳酸酯形成和亚磷酸三甲酯介导的消除，画出真实反应物、必要中间体、产物及各基元步骤所需的完整电子流。不要添加画布文字，也不要制作额外展示页面。若关键中间体超出当前表示或校验能力，请明确说明；不能更换底物或编造替代中间体来通过检查。',
  hemiacetal: '在当前空白画布中画出酸催化乙醛与甲醇生成半缩醛的完整机理。用真实酸供体和必要的水，逐步画出羰基活化、亲核加成、去质子化及酸催化剂再生；每步都包含实际结构及完整电子流。不要添加画布文字或制作额外展示页面。',
};

function parseSSE(text) {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}

async function consumeModelStream(body, onEvent, onChunk = () => {}) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    onChunk(chunk);
    pending += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      // The SSE sentinel completes the model response even if a proxy keeps
      // the HTTP connection alive. Returning also closes the stream iterator.
      if (data === '[DONE]') return true;
      for (const event of parseSSE(block + '\n\n')) onEvent(event);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) for (const event of parseSSE(pending + '\n\n')) onEvent(event);
  return false;
}

function completionAccepted(name, value) {
  if (!value || typeof value !== 'object') return false;
  if (name === 'molstudio_complete_phase') return value.taskCompleted === true && value.status === 'completed';
  return name === 'molstudio_draw_operations' && value.finishAccepted === true && value.phase?.taskCompleted !== false;
}

function reactionRouteSummary(context) {
  const steps = context.reactionSteps || [], owners = new Map();
  for (const molecule of context.molecules || []) for (const atom of molecule.atoms || []) owners.set(atom, molecule.id);
  const sides = steps.map(step => ({ id: step.stepId,
    reactants: new Set((step.reactants || []).map(atom => owners.get(atom)).filter(Boolean)),
    products: new Set((step.products || []).map(atom => owners.get(atom)).filter(Boolean)) }));
  const edges = [], successors = new Map(sides.map(step => [step.id, []])), incoming = new Map(sides.map(step => [step.id, 0]));
  for (const from of sides) for (const to of sides) {
    if (from === to || ![...from.products].some(molecule => to.reactants.has(molecule))) continue;
    edges.push({ from: from.id, to: to.id }); successors.get(from.id).push(to.id); incoming.set(to.id, incoming.get(to.id) + 1);
  }
  const sources = sides.filter(step => incoming.get(step.id) === 0).map(step => step.id), reached = new Set(), pending = [...sources];
  while (pending.length) { const step = pending.pop(); if (reached.has(step)) continue; reached.add(step); pending.push(...successors.get(step)); }
  return { stepCount: steps.length, sources, edges,
    connected: steps.length > 0 && sources.length === 1 && reached.size === steps.length,
    continuations: steps.flatMap(step => step.layoutStatus?.continuation ? [{ stepId: step.stepId, continuation: step.layoutStatus.continuation }] : []) };
}

if (process.argv.includes('--self-test')) {
  (async () => {
    const assert = require('node:assert/strict');
    assert.deepEqual(parseSSE('event: update\r\ndata: {"choices":[]}\r\n\r\ndata: [DONE]\n\n'), [{ choices: [] }]);
    assert.equal(completionAccepted('molstudio_draw_operations', { finishAccepted: true, phase: { taskCompleted: false } }), false);
    assert.equal(completionAccepted('molstudio_draw_operations', { finishAccepted: true }), true);
    assert.equal(completionAccepted('molstudio_complete_phase', { status: 'completed', taskCompleted: true }), true);
    let returned = false;
    const events = [];
    const body = { async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from('data: {"choices":[]}\n\ndata: [DO');
        yield Buffer.from('NE]\n\n');
        throw new Error('Consumer read past DONE on a connection which stays open');
      } finally { returned = true; }
    } };
    assert.equal(await consumeModelStream(body, event => events.push(event)), true);
    assert.equal(returned, true);
    assert.deepEqual(events, [{ choices: [] }]);
    const route = { molecules: [{ id: 'm1', atoms: ['a'] }, { id: 'm2', atoms: ['b'] }, { id: 'm3', atoms: ['c'] }],
      reactionSteps: [{ stepId: 's1', reactants: ['a'], products: ['b'] }, { stepId: 's2', reactants: ['b'], products: ['c'] }] };
    assert.equal(reactionRouteSummary(route).connected, true);
    route.molecules.push({ id: 'duplicate', atoms: ['b-copy'] });
    route.reactionSteps[1].reactants = ['b-copy'];
    assert.equal(reactionRouteSummary(route).connected, false);
    console.log('External-model acceptance parser, DONE stream closure, route continuity and phase-completion checks passed.');
  })().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  return;
}

if (process.env.MOLSTUDIO_REAL_AGENT !== '1') {
  console.error('This live probe requires MOLSTUDIO_REAL_AGENT=1.');
  process.exit(2);
}
const { app, BrowserWindow } = require('electron');
const ROOT = path.resolve(__dirname, '../..');
const FUSION = path.resolve(__dirname, '..');
const PYTHON = process.env.MOLSTUDIO_PYTHON || path.join(ROOT, '.venv-rdkit/bin/python');
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-external-model-live');
const CONFIG_DIR = path.join(OUT, 'agent-config');
const CASE = process.env.MOLSTUDIO_AGENT_EXTERNAL_CASE || 'corey-winter';
const DETAIL = process.env.MOLSTUDIO_AGENT_EXTERNAL_DETAIL || 'compact';
if (!CASES[CASE] || !['compact', 'full'].includes(DETAIL)) throw new Error('Unknown external acceptance case or detail mode');
const PROMPT = process.env.MOLSTUDIO_AGENT_EXTERNAL_PROMPT_FILE
  ? fs.readFileSync(path.resolve(process.env.MOLSTUDIO_AGENT_EXTERNAL_PROMPT_FILE), 'utf8') : CASES[CASE];
const REQUEST_LIMIT = Math.min(16, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 8));
const TOOL_LIMIT = Math.min(80, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_EXTERNAL_TOOL_LIMIT) || 40));
const TIMEOUT = Math.min(1_200_000, Math.max(60_000, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 300_000));
fs.mkdirSync(CONFIG_DIR, { recursive: true });
app.setPath('userData', path.join(OUT, 'electron-profile'));

const report = {
  application: 'MolStudio canvas', page: 'fusion/canvas.html',
  test: 'fusion/tests/test_agent_external_model_live.cjs', case: CASE, detail: DETAIL,
  prompt: PROMPT, startedAt: new Date().toISOString(), passed: false,
  requestLimit: REQUEST_LIMIT, toolLimit: TOOL_LIMIT,
  modelRequests: [], toolCalls: [], artifacts: [], checks: [], consoleErrors: [],
  limitations: ['Host checks cover supported graph, electron-flow and layout constraints; exported chemistry and geometry still require visual review.',
    'This isolated MCP-only model loop does not reproduce the complete general-purpose Antigravity harness or guarantee its wall-clock latency.'],
};
const toolEvidence = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
let server, mcpProc, win, activeModelController, activeRequestId, baseUrl, gatewayUrl, token = '', exitStarted = false;
const started = Date.now();
const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
const safeError = error => String(error?.message || error).replaceAll(token || '\u0000', '[redacted]').slice(0, 2000);
const write = () => {
  report.elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'tool-calls.json'), JSON.stringify(toolEvidence, null, 2));
};
function cleanup() {
  activeModelController?.abort();
  for (const child of [mcpProc, server]) if (child && child.exitCode === null) { try { child.kill('SIGTERM'); } catch {} }
  if (win && !win.isDestroyed()) win.destroy();
}
async function cancelOwnModelRequest() {
  if (!activeRequestId || !gatewayUrl || !token) return;
  const requestId = activeRequestId;
  activeModelController?.abort();
  await requestJSON(gatewayUrl + '/api/agent/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MolStudio-Agent-Token': token },
    body: JSON.stringify({ requestId }),
  }).catch(() => {});
  activeRequestId = null;
}
const watchdog = setTimeout(async () => {
  if (exitStarted) return;
  exitStarted = true;
  report.error = 'Live acceptance watchdog exhausted'; report.timedOut = true;
  await cancelOwnModelRequest();
  await saveArtifacts().catch(() => {}); write(); cleanup(); app.exit(2);
}, TIMEOUT);

async function requestJSON(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(5000) });
  const value = await response.json();
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (value.error || 'request failed'));
  return value;
}
async function freePort() {
  const service = net.createServer();
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const port = service.address().port;
  await new Promise((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
  return port;
}

class MCPClient {
  constructor(proc) {
    this.proc = proc; this.buffer = ''; this.pending = new Map(); this.nextId = 1;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', data => {
      this.buffer += data;
      for (;;) {
        const end = this.buffer.indexOf('\n'); if (end < 0) break;
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.rejectAll(new Error('Invalid JSON from stdio MCP')); continue; }
        const waiting = this.pending.get(message.id); if (!waiting) continue;
        this.pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message || 'MCP request failed')); else waiting.resolve(message.result);
      }
    });
    proc.on('exit', () => this.rejectAll(new Error('MCP process exited')));
    proc.on('error', error => this.rejectAll(error));
  }
  rejectAll(error) { for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } this.pending.clear(); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP request timed out')); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

async function modelResponse(messages, tools, number) {
  activeRequestId = 'external-live-' + number + '-' + crypto.randomBytes(4).toString('hex');
  activeModelController = new AbortController();
  const metric = { number, startedAt: new Date().toISOString(), requestBytes: 0, responseBytes: 0, firstByteMs: null };
  const start = Date.now();
  const payload = { messages, tools, stream: true, stream_options: { include_usage: true } };
  metric.requestBytes = bytes(payload);
  report.modelRequests.push(metric); write();
  const response = await fetch(gatewayUrl + '/api/agent/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
      'X-MolStudio-Agent-Token': token, 'X-MolStudio-Agent-Request': activeRequestId },
    body: JSON.stringify(payload), signal: activeModelController.signal,
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error('Configured model gateway returned HTTP ' + response.status + ': ' + (failure.error || 'unavailable'));
  }
  const generationHeader = response.headers.get('X-MolStudio-Generation');
  if (generationHeader) {
    try { metric.generationForwarding = JSON.parse(generationHeader); } catch { /* Preserve metadata only when valid JSON. */ }
  }
  const assistant = { role: 'assistant', content: '' }, calls = new Map();
  let lastProgressWrite = start;
  function handle(event) {
    if (event.error) throw new Error(event.error.message || 'Model stream error');
    if (event.usage) metric.usage = event.usage;
    for (const choice of event.choices || []) {
      if (choice.finish_reason) metric.finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) assistant.content += delta.content;
      // Some thinking models require this in later requests. Keep in memory only.
      if (delta.reasoning_content) assistant.reasoning_content = (assistant.reasoning_content || '') + delta.reasoning_content;
      for (const partial of delta.tool_calls || []) {
        const previous = calls.get(partial.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (partial.id) previous.id = partial.id;
        if (partial.function?.name) previous.function.name += partial.function.name;
        if (partial.function?.arguments) previous.function.arguments += partial.function.arguments;
        calls.set(partial.index, previous);
      }
    }
  }
  await consumeModelStream(response.body, handle, chunk => {
    metric.firstByteMs ??= Date.now() - start;
    metric.responseBytes += chunk.byteLength;
    if (Date.now() - lastProgressWrite >= 1000) {
      metric.durationMs = Date.now() - start;
      metric.toolNames = [...calls.values()].map(call => call.function.name);
      lastProgressWrite = Date.now(); write();
    }
  });
  metric.durationMs = Date.now() - start;
  metric.visibleTextBytes = bytes(assistant.content);
  if (calls.size) assistant.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  metric.toolNames = assistant.tool_calls?.map(call => call.function.name) || [];
  activeModelController = null; activeRequestId = null; write();
  return assistant;
}

async function saveArtifacts() {
  if (!win || win.isDestroyed()) return;
  const js = source => win.webContents.executeJavaScript(source);
  const context = await js('k3dAPI.agent.getContext()');
  fs.writeFileSync(path.join(OUT, 'final-context.json'), JSON.stringify(context, null, 2));
  const source = await js('k3dAPI.serializeWorkbench()');
  fs.writeFileSync(path.join(OUT, 'external-model.molwork'), source);
  report.artifacts = ['report.json', 'tool-calls.json', 'final-context.json', 'external-model.molwork'];
  for (const kind of ['png', 'svg']) {
    const exported = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(kind) + ')');
    if (exported?.ok && exported.dataUrl) {
      const name = 'external-model.' + kind;
      fs.writeFileSync(path.join(OUT, name), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
      report.artifacts.push(name);
    } else report.artifactErrors = [...(report.artifactErrors || []), kind + '_export_failed'];
  }
  fs.writeFileSync(path.join(OUT, 'external-model-window.png'), (await win.webContents.capturePage()).toPNG());
  report.artifacts.push('external-model-window.png');
  report.canvas = { atoms: context.atoms.length, molecules: context.molecules.length, reactionSteps: context.reactionSteps.length,
    arrows: context.arrows.length, lonePairs: context.lonePairs.length,
    steps: context.reactionSteps.map(step => ({ stepId: step.stepId, version: step.version, checks: step.checks, layout: step.layoutStatus })) };
  report.runtime = await js(`(() => { const rt = molstudioAgent.getRuntime(); return { isRunning: rt.isRunning,
    finishRequested: rt._externalRun?.finishRequested, phaseBoundary: rt._externalRun?.phaseBoundary,
    checkpointStatus: rt._externalRun?.checkpoint?.status,
    panelStatus: document.querySelector('.mol-agent-status')?.textContent || null }; })()`);
}

app.whenReady().then(async () => {
  try {
    const sourceConfig = path.join(process.env.MOLSTUDIO_AGENT_CONFIG_DIR || path.join(os.homedir(), 'Library/Application Support/MolStudio'), 'agent.json');
    const saved = JSON.parse(fs.readFileSync(sourceConfig, 'utf8'));
    const isolated = Object.fromEntries(['provider', 'model', 'baseUrl', 'generation'].filter(key => saved[key] !== undefined).map(key => [key, saved[key]]));
    fs.writeFileSync(path.join(CONFIG_DIR, 'agent.json'), JSON.stringify(isolated), { mode: 0o600 });
    const port = await freePort(); baseUrl = 'http://127.0.0.1:' + port;
    report.servicePort = port; report.build = process.env.MOLSTUDIO_TEST_BUILD || FUSION;
    report.sourceHashes = Object.fromEntries(['mcp_server.py', 'mcp_response.py', 'canvas.html', 'agent/dist/agent-runtime.js', 'workbench/agent-bridge.js']
      .filter(file => fs.existsSync(path.join(FUSION, file)))
      .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(FUSION, file))).digest('hex')]));
    const env = { ...process.env, MOLSTUDIO_AGENT_CONFIG_DIR: CONFIG_DIR };
    server = spawn(PYTHON, ['-B', path.join(FUSION, 'server.py'), String(port)], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
    let serviceReady = false;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      try { await requestJSON(baseUrl + '/api/agent/external/status'); serviceReady = true; break; } catch { await wait(100); }
    }
    if (!serviceReady) throw new Error('Isolated Python service did not start');
    gatewayUrl = process.env.MOLSTUDIO_AGENT_EXTERNAL_GATEWAY_URL || baseUrl;
    const parsedGateway = new URL(gatewayUrl);
    if (parsedGateway.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedGateway.hostname) || parsedGateway.username || parsedGateway.password || parsedGateway.search || parsedGateway.hash) {
      throw new Error('The external live probe only accepts a local HTTP model gateway URL');
    }
    gatewayUrl = gatewayUrl.replace(/\/$/, '');
    const publicConfig = await requestJSON(gatewayUrl + '/api/agent/config');
    if (!publicConfig?.configured) throw new Error('Selected local gateway has no usable configured model/credential; user settings were not changed');
    token = publicConfig.sessionToken;
    report.model = publicConfig.model; report.generation = publicConfig.generation;
    report.modelGateway = gatewayUrl === baseUrl ? 'isolated service with existing credentials' : 'existing local service; configuration unchanged';
    check('selected local gateway has the configured model and credentials', true);
    win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => {
      if (event.level === 'error' && !/favicon|deprecated/i.test(event.message)) report.consoleErrors.push(event.message.slice(0, 500));
    });
    await win.loadURL(baseUrl + '/canvas.html');
    const js = source => win.webContents.executeJavaScript(source);
    let connected = false;
    for (const deadline = Date.now() + 40_000; Date.now() < deadline;) {
      const status = await requestJSON(baseUrl + '/api/agent/external/status');
      if (status.connected && await js('!!k3dAPI?.agent?.getContext && !!molstudioAgent?.getRuntime?.()')) { connected = true; break; }
      await wait(100);
    }
    if (!connected) throw new Error('Isolated canvas did not register with its external bridge');
    check('isolated canvas registered over SSE', true);
    mcpProc = spawn(PYTHON, ['-B', path.join(FUSION, 'mcp_server.py')], { cwd: ROOT,
      env: { ...env, MOLSTUDIO_URL: baseUrl, MOLSTUDIO_NO_AUTO_LAUNCH: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const mcp = new MCPClient(mcpProc);
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'external-model-live', version: '1.0' } });
    mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const available = (await mcp.request('tools/list', {})).tools;
    check('model is offered only the eight MolStudio MCP tools', available.length === 8 && available.every(tool => tool.name.startsWith('molstudio_')));
    const tools = available.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    const messages = [{ role: 'system', content: init.instructions }, { role: 'user', content: PROMPT }];
    const names = new Set(available.map(tool => tool.name));
    let accepted = false;
    for (let turn = 1; turn <= REQUEST_LIMIT && !accepted; turn++) {
      console.log('Configured model request ' + turn + ' (' + CASE + ', ' + DETAIL + ')');
      const assistant = await modelResponse(messages, tools, turn);
      messages.push(assistant);
      if (!assistant.tool_calls?.length) { report.finalMessage = assistant.content; report.stopReason = 'model_stopped_without_accepted_completion'; break; }
      for (const call of assistant.tool_calls) {
        if (report.toolCalls.length >= TOOL_LIMIT) throw new Error('Live acceptance tool-call budget exhausted');
        if (!names.has(call.function.name)) throw new Error('Model attempted a non-MolStudio tool');
        const args = JSON.parse(call.function.arguments || '{}');
        if (['molstudio_read_canvas', 'molstudio_inspect_structures', 'molstudio_draw_operations'].includes(call.function.name)) args.detail = DETAIL;
        if (call.function.name !== 'molstudio_status') args.clientName = 'External model acceptance';
        const before = Date.now();
        const result = await mcp.request('tools/call', { name: call.function.name, arguments: args });
        const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
        let value; try { value = JSON.parse(text); } catch { value = null; }
        const entry = { number: report.toolCalls.length + 1, modelRequest: turn, name: call.function.name,
          elapsedMs: Date.now() - before, resultBytes: bytes(text), isError: result.isError === true,
          operationCount: args.operations?.length, operationTypes: args.operations?.map(operation => operation.type),
          finishAccepted: value?.finishAccepted, finishRejected: value?.finishRejected,
          completionDiagnostic: value?.completionDiagnostic, phase: value?.phase,
          ...(result._meta && { metadata: result._meta }) };
        report.toolCalls.push(entry); toolEvidence.push({ ...entry, arguments: args, result: value ?? text });
        console.log('  ' + entry.name + ': ' + entry.elapsedMs + 'ms, ' + entry.resultBytes + ' bytes' + (entry.isError ? ' ERROR' : ''));
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        accepted ||= !result.isError && completionAccepted(call.function.name, value);
        if (accepted) {
          report.completionRuntime = await js(`(async () => {
            const rt = molstudioAgent.getRuntime(), checkpoint = await k3dAPI.agent.getTaskCheckpoint();
            return { isRunning: rt.isRunning, checkpointStatus: checkpoint?.status || null,
              finishRequested: rt._externalRun?.finishRequested,
              panelStatus: document.querySelector('.mol-agent-status')?.textContent || null };
          })()`);
        }
        write();
      }
    }
    report.completionAccepted = accepted;
    report.stopReason ||= accepted ? 'host_accepted_completion' : 'model_request_budget_exhausted';
    const finalRead = await mcp.request('tools/call', { name: 'molstudio_read_canvas', arguments: { detail: 'full', clientName: 'External model verification' } });
    const checkedContext = JSON.parse(finalRead.content[0].text);
    fs.writeFileSync(path.join(OUT, 'checked-final-context.json'), JSON.stringify(checkedContext, null, 2));
    check('host accepted the complete task', accepted);
    check('completion closed the persisted task checkpoint', accepted && report.completionRuntime?.checkpointStatus === 'completed' && report.completionRuntime?.isRunning === false,
      report.completionRuntime);
    check('final mechanism has multiple actual reaction steps', checkedContext.reactionSteps?.length >= 2);
    check('every final step passed supported chemistry and layout checks', checkedContext.reactionSteps?.length > 0 && checkedContext.reactionSteps.every(step =>
      step.checks?.chemistry?.status === 'passed' && step.checks?.layout?.status === 'passed'),
      checkedContext.reactionSteps?.map(step => ({ stepId: step.stepId, checks: step.checks })));
    report.route = reactionRouteSummary(checkedContext);
    check('the requested mechanism is one connected route using actual intermediate references', report.route.connected, report.route);
    await saveArtifacts(); report.artifacts.push('checked-final-context.json');
    check('PNG, SVG and editable molwork were exported', ['external-model.png', 'external-model.svg', 'external-model.molwork'].every(file => report.artifacts.includes(file)));
    check('external runtime is idle', report.runtime?.isRunning === false);
    report.totalToolResultBytes = report.toolCalls.reduce((sum, call) => sum + call.resultBytes, 0);
    report.totalToolMs = report.toolCalls.reduce((sum, call) => sum + call.elapsedMs, 0);
    report.passed = report.checks.every(item => item.pass);
  } catch (error) {
    report.error = safeError(error);
    await cancelOwnModelRequest();
    await saveArtifacts().catch(failure => { report.artifactError = safeError(failure); });
  } finally {
    if (exitStarted) return;
    exitStarted = true; clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); write(); cleanup();
    console.log('External-model acceptance: ' + (report.passed ? 'PASSED' : 'FAILED') + '; report: ' + path.join(OUT, 'report.json'));
    app.exit(report.passed ? 0 : 1);
  }
});
