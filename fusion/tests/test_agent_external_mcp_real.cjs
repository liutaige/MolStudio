// Real E2E verification of MolStudio MCP + External Agent Bridge + Real-time Panel.
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const OUT = process.env.MOLSTUDIO_AGENT_TEST_OUT
  ? path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT)
  : path.resolve(__dirname, '../../.jez/artifacts/agent-external-mcp-validation');

fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(OUT, 'electron-profile'));

const REPO_ROOT = path.resolve(__dirname, '../..');
const FUSION_DIR = process.env.MOLSTUDIO_TEST_RESOURCES
  ? path.resolve(process.env.MOLSTUDIO_TEST_RESOURCES) : path.resolve(__dirname, '..');
const PYTHON_PATH = process.env.MOLSTUDIO_TEST_RESOURCES
  ? path.join(FUSION_DIR, 'python/bin/python') : path.join(REPO_ROOT, '.venv-rdkit/bin/python');
const PYTHON_FLAGS = process.env.MOLSTUDIO_TEST_RESOURCES ? ['-I', '-B'] : ['-B'];
const SERVER_PY = path.join(FUSION_DIR, 'server.py');
const MCP_SERVER_PY = path.join(FUSION_DIR, 'mcp_server.py');
const CONFIG_DIR = path.join(OUT, 'agent-config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = {
  application: 'MolStudio canvas',
  page: 'fusion/canvas.html',
  test: 'fusion/tests/test_agent_external_mcp_real.cjs',
  build: process.env.MOLSTUDIO_TEST_BUILD || FUSION_DIR,
  sourceHashes: Object.fromEntries(['mcp_server.py', 'mcp_response.py', 'canvas.html', 'agent/dist/agent-runtime.js']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(FUSION_DIR, file))).digest('hex')])),
  passed: false,
  checks: [],
  artifacts: [],
  consoleErrors: [],
};

function recordCheck(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`[CHECK] ${pass ? 'PASS' : 'FAIL'}: ${name}`);
  if (!pass && detail) {
    console.error('  Detail:', detail);
  }
}

function parsedToolResult(result) {
  assert.strictEqual(result.isError, false, result.content?.[0]?.text || 'MCP tool failed');
  return JSON.parse(result.content[0].text);
}

function byId(records) {
  return records.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function atomState(records) {
  return byId(records).map(atom => {
    const result = { ...atom };
    // neighbors is a derived copy of the bond table. All chemical properties,
    // nonempty stereo/alias fields, stable identity and coordinates must agree.
    delete result.neighbors;
    for (const field of ['stereoLabel', 'stereoParity', 'alias']) if (result[field] == null) delete result[field];
    return result;
  });
}

function electronFlowState(records) {
  return byId(records).map(arrow => {
    const result = { ...arrow, geometry: { ...arrow.geometry } };
    delete result.geometry.routeVersion;
    delete result.geometry.controlFrame;
    if (result.pairId == null) delete result.pairId;
    return result;
  });
}

function assertSameEditableState(actual, expected) {
  assert.deepStrictEqual(atomState(actual.atoms), atomState(expected.atoms), 'stable atoms and all chemical attributes must survive');
  assert.deepStrictEqual(byId(actual.bonds), byId(expected.bonds), 'stable bonds, connectivity and native bond types must survive');
  assert.deepStrictEqual(byId(actual.molecules), byId(expected.molecules), 'molecule handles and full memberships must survive');
  assert.deepStrictEqual(byId(actual.lonePairs), byId(expected.lonePairs), 'lone-pair identities and automatic aim must survive');
  assert.deepStrictEqual(electronFlowState(actual.arrows), electronFlowState(expected.arrows), 'electron-flow identities, endpoints and modes must survive');
  assert.deepStrictEqual(actual.reactionSteps, expected.reactionSteps, 'step versions, participants, checks and continuation observations must survive');
}

function assertResponseMetrics(result, detail) {
  const metadata = result._meta?.molstudio;
  assert.ok(metadata, 'MCP response must expose payload and execution metrics');
  assert.strictEqual(metadata.detail, detail);
  assert.strictEqual(metadata.textBytes, Buffer.byteLength(result.content[0].text, 'utf8'));
  assert.ok(metadata.sourceTextBytes >= metadata.textBytes);
  if (detail === 'full') assert.strictEqual(metadata.sourceTextBytes, metadata.textBytes);
  assert.ok(metadata.timingMs.discovery >= 0 && metadata.timingMs.bridge >= 0);
  return metadata;
}

let serverProc = null;
let mcpProc = null;
let win = null;

function killProc(proc, label) {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch (err) {
    console.error(`Error killing ${label}:`, err.message);
  }
}

function cleanup() {
  if (mcpProc) killProc(mcpProc, 'mcp_server.py');
  if (serverProc) killProc(serverProc, 'server.py');
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch (_) {}
  }
}

const watchdog = setTimeout(() => {
  console.error('Watchdog timeout reached!');
  report.timedOut = true;
  try {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  } catch (_) {}
  cleanup();
  app.exit(2);
}, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 120_000);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(err => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

class MCPClient {
  constructor(proc) {
    this.proc = proc;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;

    proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      this._drain();
    });
  }

  _drain() {
    while (true) {
      const clMatch = this.buffer.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
      if (clMatch) {
        const headerLen = clMatch[0].length;
        const bodyLen = parseInt(clMatch[1], 10);
        if (this.buffer.length < headerLen + bodyLen) break;
        const body = this.buffer.slice(headerLen, headerLen + bodyLen);
        this.buffer = this.buffer.slice(headerLen + bodyLen);
        try {
          this._handleMessage(JSON.parse(body));
        } catch (e) {
          console.error('[MCP parse error]', e, body);
        }
        continue;
      }
      const nlIndex = this.buffer.indexOf('\n');
      if (nlIndex === -1) break;
      const line = this.buffer.slice(0, nlIndex).trim();
      this.buffer = this.buffer.slice(nlIndex + 1);
      if (!line) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch (e) {
        console.error('[MCP parse error]', e, line);
      }
    }
  }

  _handleMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  async request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) };
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout after ${timeoutMs}ms for ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: val => { clearTimeout(timer); resolve(val); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
    });
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return p;
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }
}

app.whenReady().then(async () => {
  let passed = false;
  try {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Starting isolated python server on ${baseUrl}...`);

    // 1. Spawn python server.py <ephemeralPort>
    serverProc = spawn(PYTHON_PATH, [...PYTHON_FLAGS, SERVER_PY, String(port)], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MOLSTUDIO_AGENT_CONFIG_DIR: CONFIG_DIR,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (/error|exception/i.test(text)) console.error('[server stderr]', text.trim());
    });

    // Wait for server to start listening
    let serverReady = false;
    const serverStartDeadline = Date.now() + 15000;
    while (Date.now() < serverStartDeadline) {
      try {
        const res = await httpGetJson(`${baseUrl}/api/agent/external/status`);
        if (res.status === 200 && res.data?.ok) {
          serverReady = true;
          break;
        }
      } catch (_) {}
      await wait(100);
    }
    recordCheck('python server started and registered port', serverReady, { port, baseUrl });
    if (!serverReady) throw new Error('Failed to start python server');

    // 2. Open Electron BrowserWindow and navigate to canvas.html
    win = new BrowserWindow({
      show: false,
      width: 1360,
      height: 880,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
      },
    });

    win.webContents.on('console-message', event => {
      if (event.level === 'error' && !/favicon|deprecated/i.test(event.message)) {
        report.consoleErrors.push(event.message.slice(0, 1000));
      }
    });

    const js = source => win.webContents.executeJavaScript(source);
    const until = async (source, limit = 35000) => {
      const start = Date.now();
      while (!await js(source)) {
        if (Date.now() - start > limit) throw new Error('Timed out waiting for: ' + source);
        await wait(50);
      }
    };

    console.log(`Loading ${baseUrl}/canvas.html in Electron...`);
    await win.loadURL(`${baseUrl}/canvas.html`);

    // Wait until window.k3dAPI?.agent?.getContext is ready
    await until('!!window.k3dAPI?.agent?.getContext && !!window.molstudioAgent?.getRuntime?.()', 35000);
    recordCheck('canvas.html loaded and k3dAPI.agent.getContext is ready', true);

    // Wait until GET /api/agent/external/status reports connected: true
    let connected = false;
    const connectDeadline = Date.now() + 20000;
    while (Date.now() < connectDeadline) {
      try {
        const res = await httpGetJson(`${baseUrl}/api/agent/external/status`);
        if (res.status === 200 && res.data?.connected === true) {
          connected = true;
          break;
        }
      } catch (_) {}
      await wait(100);
    }
    recordCheck('GET /api/agent/external/status reports connected: true', connected);
    if (!connected) throw new Error('External bridge failed to report connected: true');

    // 3. Spawn mcp_server.py
    console.log('Spawning mcp_server.py with stdio framing...');
    mcpProc = spawn(PYTHON_PATH, [...PYTHON_FLAGS, MCP_SERVER_PY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MOLSTUDIO_URL: baseUrl,
        MOLSTUDIO_NO_AUTO_LAUNCH: '1',
        MOLSTUDIO_AGENT_CONFIG_DIR: CONFIG_DIR,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    mcpProc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (/error|exception/i.test(text)) console.error('[mcp stderr]', text.trim());
    });

    const mcp = new MCPClient(mcpProc);

    // MCP initialize
    console.log('MCP: initialize');
    const initRes = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-agent-external-mcp', version: '1.0.0' },
    });
    recordCheck('MCP initialize returned serverInfo and instructions',
      initRes?.serverInfo?.name === 'molstudio' && typeof initRes?.instructions === 'string' && initRes.instructions.length > 50,
      { serverInfo: initRes?.serverInfo });

    // MCP notifications/initialized
    mcp.notify('notifications/initialized');

    // MCP tools/list
    console.log('MCP: tools/list');
    const toolsRes = await mcp.request('tools/list');
    const toolNames = (toolsRes?.tools || []).map(t => t.name).sort();
    const expectedTools = [
      'molstudio_complete_layout',
      'molstudio_complete_phase',
      'molstudio_draw_operations',
      'molstudio_inspect_structures',
      'molstudio_plan_task',
      'molstudio_read_canvas',
      'molstudio_status',
      'molstudio_write_plan',
    ].sort();
    const allToolsMatch = JSON.stringify(toolNames) === JSON.stringify(expectedTools);
    recordCheck('MCP tools/list contains all 8 molstudio_* tools', allToolsMatch, { toolNames });
    assert.ok(allToolsMatch, 'All 8 tools must exist');

    // MCP tools/call molstudio_read_canvas (empty initial canvas)
    console.log('MCP: tools/call molstudio_read_canvas');
    const readRes = await mcp.request('tools/call', {
      name: 'molstudio_read_canvas',
      arguments: {},
    });
    const readData = JSON.parse(readRes.content[0].text);
    const readEmpty = readRes.isError === false &&
      Array.isArray(readData.molecules) && readData.molecules.length === 0 &&
      Array.isArray(readData.arrows) && readData.arrows.length === 0 &&
      Array.isArray(readData.reactionSteps) && readData.reactionSteps.length === 0;
    recordCheck('molstudio_read_canvas returns empty initial canvas context', readEmpty, {
      molecules: readData.molecules?.length,
      arrows: readData.arrows?.length,
      reactionSteps: readData.reactionSteps?.length,
    });
    assert.ok(readEmpty, 'Initial canvas should be empty');

    // MCP tools/call molstudio_inspect_structures ([OH-:1] and [CH3:1][Br:2])
    console.log('MCP: tools/call molstudio_inspect_structures');
    const inspectRes = await mcp.request('tools/call', {
      name: 'molstudio_inspect_structures',
      arguments: {
        structures: [
          { id: 'oh', smiles: '[OH-:1]' },
          { id: 'ch3br', smiles: '[CH3:1][Br:2]' },
        ],
      },
    });
    const inspectData = JSON.parse(inspectRes.content[0].text);
    const inspectList = Array.isArray(inspectData) ? inspectData : (inspectData?.structures || []);
    const inspectOk = inspectRes.isError === false &&
      inspectList.length === 2 &&
      inspectList[0].id === 'oh' && inspectList[0].ok === true &&
      inspectList[1].id === 'ch3br' && inspectList[1].ok === true;
    recordCheck('molstudio_inspect_structures checks [OH-:1] and [CH3:1][Br:2]', inspectOk, {
      count: inspectList.length,
      structures: inspectList.map(s => ({ id: s.id, ok: s.ok, atoms: s.atoms?.length })),
    });
    assert.ok(inspectOk, 'inspect_structures should succeed for both structures');

    // MCP tools/call molstudio_write_plan (2 steps)
    console.log('MCP: tools/call molstudio_write_plan');
    const planRes = await mcp.request('tools/call', {
      name: 'molstudio_write_plan',
      arguments: {
        steps: [
          { id: 'step-1', text: '检查反应物结构并布置在画布', status: 'done' },
          { id: 'step-2', text: '绘制亲核进攻与离去基团电子流', status: 'running' },
        ],
      },
    });
    recordCheck('molstudio_write_plan writes 2 steps', planRes.isError === false, { content: planRes?.content });
    assert.strictEqual(planRes.isError, false, 'write_plan should succeed');

    // MCP tools/call molstudio_draw_operations (complete SN2 mechanism)
    console.log('MCP: tools/call molstudio_draw_operations');
    const drawOperations = [
      { id: 'step', type: 'reactionStep.create', reactants: ['nuc:1', 'sub:1'], products: ['prod:1', 'br:1'], layout: {} },
      { id: 'nuc', type: 'molecule.add', smiles: '[OH-:1]' },
      { id: 'sub', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
      { id: 'lp_oh', type: 'lonePair.add', atom: 'nuc:1' },
      { id: 'attack', type: 'arrow.add', source: { type: 'lonePair', id: 'lp_oh' }, target: { type: 'formingBond', atom1: 'nuc:1', atom2: 'sub:1' }, electronCount: 2 },
      { id: 'leaving', type: 'arrow.add', source: { type: 'bond', atom1: 'sub:1', atom2: 'sub:2', component: 'sigma' }, target: { type: 'atom', atomId: 'sub:2' }, electronCount: 2 },
      { id: 'prod', type: 'molecule.add', smiles: '[CH3:1][OH:2]' },
      { id: 'br', type: 'molecule.add', smiles: '[Br-:1]' },
    ];

    const drawRes = await mcp.request('tools/call', {
      name: 'molstudio_draw_operations',
      arguments: {
        summary: '绘制 OH- + CH3Br SN2 机理',
        taskScope: { type: 'completeMechanism' },
        finish: true,
        operations: drawOperations,
      },
    });

    const drawData = JSON.parse(drawRes.content[0].text);
    const finishAccepted = drawRes.isError === false && drawData.finishAccepted === true;
    recordCheck('molstudio_draw_operations response parses cleanly and has finishAccepted: true', finishAccepted, {
      isError: drawRes.isError,
      finishAccepted: drawData.finishAccepted,
      finishRejected: drawData.finishRejected,
      summary: drawData.summary,
    });
    assert.ok(finishAccepted, `draw_operations should complete with finishAccepted: true (was ${drawData.finishAccepted}, rejected: ${drawData.finishRejected})`);

    // Verify real canvas context
    console.log('Verifying canvas context...');
    const canvasCtx = await js('window.k3dAPI.agent.getContext()');
    const canvasCorrect =
      canvasCtx.molecules.length === 4 &&
      canvasCtx.reactionSteps.length === 1 &&
      canvasCtx.lonePairs.length === 1 &&
      canvasCtx.arrows.length === 2;

    recordCheck('real canvas context has 4 molecules, 1 reaction step, 1 lone pair, and 2 curved arrows', canvasCorrect, {
      molecules: canvasCtx.molecules.length,
      reactionSteps: canvasCtx.reactionSteps.length,
      lonePairs: canvasCtx.lonePairs.length,
      arrows: canvasCtx.arrows.length,
    });
    assert.ok(canvasCorrect, 'Canvas context must have 4 molecules, 1 reaction step, 1 lone pair, 2 curved arrows');
    const completedDrawingTask = await js('window.k3dAPI.agent.getTaskCheckpoint()');
    assert.strictEqual(completedDrawingTask.status, 'completed');
    assert.strictEqual(completedDrawingTask.phaseIndex, 1);
    assert.strictEqual(completedDrawingTask.phases[0].status, 'completed');
    assert.strictEqual(completedDrawingTask.checks.status, 'passed');
    recordCheck('accepted single drawing completion was persisted before returning success', true, {
      taskId: completedDrawingTask.taskId, status: completedDrawingTask.status, phaseIndex: completedDrawingTask.phaseIndex,
    });

    // Verify right panel DOM
    console.log('Verifying panel DOM...');
    await until(`
      document.body.classList.contains('mol-agent-open') &&
      !!document.querySelector('.mol-agent-external-badge') &&
      document.querySelectorAll('.mol-agent-tool-changes li').length >= 3
    `, 10000);

    const panelState = await js(`(() => {
      const isOpen = document.body.classList.contains('mol-agent-open');
      const badge = document.querySelector('.mol-agent-external-badge')?.textContent?.trim() || null;
      const changes = Array.from(document.querySelectorAll('.mol-agent-tool-changes li')).map(li => li.textContent.trim());
      return { isOpen, badge, changes };
    })()`);

    const hasBadge = !!panelState.badge && panelState.badge.includes('外部协同');
    const hasAddMolecule = panelState.changes.some(c => c.includes('+ 分子'));
    const hasAddReactionStep = panelState.changes.some(c => c.includes('+ 反应步骤'));
    const hasAddCurvedArrow = panelState.changes.some(c => c.includes('+ 弯箭头'));
    const panelOk = panelState.isOpen && hasBadge && hasAddMolecule && hasAddReactionStep && hasAddCurvedArrow;

    recordCheck('right panel automatically opened, renders .mol-agent-external-badge, and .mol-agent-tool-changes includes concrete items',
      panelOk,
      {
        isOpen: panelState.isOpen,
        badge: panelState.badge,
        hasAddMolecule,
        hasAddReactionStep,
        hasAddCurvedArrow,
        sampleChanges: panelState.changes.slice(0, 5),
      }
    );
    assert.ok(panelOk, 'Panel DOM checks failed');

    // Default model-facing data must stay editable while avoiding duplicate
    // observations. The complete representation remains explicitly available.
    const compactRead = await mcp.request('tools/call', { name: 'molstudio_read_canvas', arguments: {} });
    const compactCanvas = parsedToolResult(compactRead);
    const fullRead = await mcp.request('tools/call', { name: 'molstudio_read_canvas', arguments: { detail: 'full' } });
    const fullCanvas = parsedToolResult(fullRead);
    assertSameEditableState(compactCanvas, fullCanvas);
    const compactMetrics = assertResponseMetrics(compactRead, 'compact');
    const fullMetrics = assertResponseMetrics(fullRead, 'full');
    const drawMetrics = assertResponseMetrics(drawRes, 'compact');
    assert.strictEqual(compactMetrics.sourceTextBytes, fullMetrics.textBytes, 'full response must reproduce the same source observations');
    assert.ok(compactMetrics.textBytes < fullMetrics.textBytes, 'default read should be smaller than the complete canvas representation');
    recordCheck('compact/full MCP reads preserve editable chemistry, versions and electron flow with smaller default payload', true, {
      fullBytes: fullMetrics.textBytes, compactBytes: compactMetrics.textBytes,
      reduction: 1 - compactMetrics.textBytes / fullMetrics.textBytes,
    });
    recordCheck('MCP response byte counts and discovery/bridge timing metadata are accurate', true);
    report.payloads = { draw: drawMetrics, readCompact: compactMetrics, readFull: fullMetrics };
    fs.writeFileSync(path.join(OUT, 'read-compact.json'), compactRead.content[0].text);
    fs.writeFileSync(path.join(OUT, 'read-full.json'), fullRead.content[0].text);
    report.artifacts.push('read-compact.json', 'read-full.json');
    const verifiedDrawingTask = await js('window.k3dAPI.agent.getTaskCheckpoint()');
    assert.strictEqual(verifiedDrawingTask.taskId, completedDrawingTask.taskId);
    assert.strictEqual(verifiedDrawingTask.status, 'completed');
    recordCheck('read-only full/compact verification preserves the completed drawing ledger', true);

    // An unrelated component provides a real isolation check for stepIds.
    // Restore the original view and delete the sentinel before exporting SN2.
    await js(`(() => { editor().render.setViewBox(box => {
      window.__externalMcpOriginalViewBox = { ...box }; return box;
    }); return true; })()`);
    const sentinelResult = await mcp.request('tools/call', {
      name: 'molstudio_draw_operations', arguments: {
        taskScope: { type: 'edit' },
        operations: [{ id: 'scope_sentinel', type: 'molecule.add', smiles: '[CH3:1][CH3:2]',
          x: fullCanvas.viewport.center.x + 30, y: fullCanvas.viewport.center.y + 20 }],
      },
    });
    const sentinel = parsedToolResult(sentinelResult).created.find(item => item.id === 'scope_sentinel');
    const sentinelAtoms = sentinel?.atoms?.map(atom => atom.id);
    assert.ok(sentinelAtoms?.length === 2, 'sentinel must return current stable atom references');
    const sentinelTask = await js('window.k3dAPI.agent.getTaskCheckpoint()');
    assert.notStrictEqual(sentinelTask.taskId, completedDrawingTask.taskId);
    assert.strictEqual(sentinelTask.status, 'active');
    const stepId = fullCanvas.reactionSteps[0].stepId;
    const scopedResult = await mcp.request('tools/call', {
      name: 'molstudio_read_canvas', arguments: { stepIds: [stepId] },
    });
    const scopedCanvas = parsedToolResult(scopedResult);
    assert.deepStrictEqual(scopedCanvas.scope.stepIds, [stepId]);
    assert.strictEqual(scopedCanvas.scope.total.molecules, 5);
    assert.strictEqual(scopedCanvas.scope.returned.molecules, 4);
    assert.ok(!scopedCanvas.atoms.some(atom => sentinelAtoms.includes(atom.id)));
    assertSameEditableState(scopedCanvas, compactCanvas);
    recordCheck('stepIds returns full step participants and electron flow while excluding an unrelated real molecule', true, scopedCanvas.scope);
    report.payloads.readScoped = scopedResult._meta?.molstudio;
    fs.writeFileSync(path.join(OUT, 'read-scoped.json'), scopedResult.content[0].text);
    report.artifacts.push('read-scoped.json');

    const deleteSentinel = await mcp.request('tools/call', {
      name: 'molstudio_draw_operations', arguments: {
        taskScope: { type: 'edit' }, finish: true,
        operations: [{ id: 'remove_scope_sentinel', type: 'molecule.delete', target: { atoms: sentinelAtoms } }],
      },
    });
    assert.strictEqual(parsedToolResult(deleteSentinel).finishAccepted, true);
    await js(`(() => { editor().render.setViewBox(() => window.__externalMcpOriginalViewBox);
      delete window.__externalMcpOriginalViewBox; return true; })()`);
    const finalRead = parsedToolResult(await mcp.request('tools/call', {
      name: 'molstudio_read_canvas', arguments: { detail: 'full' },
    }));
    assertSameEditableState(finalRead, fullCanvas);
    assert.strictEqual(finalRead.molecules.length, 4);
    assert.strictEqual(finalRead.reactionSteps.length, 1);
    assert.strictEqual(finalRead.arrows.length, 2);
    assert.deepStrictEqual(finalRead.viewport, fullCanvas.viewport);
    const runtimeState = await js(`(() => { const runtime = molstudioAgent.getRuntime();
      return { isRunning: runtime.isRunning, panelStatus: document.querySelector('.mol-agent-status')?.textContent || null,
        taskProgress: document.querySelector('.mol-agent-task-progress')?.textContent || null };
    })()`);
    recordCheck('scope sentinel was deleted, original SN2/view restored and external runtime is idle', !runtimeState.isRunning, runtimeState);
    assert.ok(!runtimeState.isRunning);
    assert.strictEqual(runtimeState.panelStatus, '外部任务已完成');
    assert.match(runtimeState.taskProgress, /阶段 1\/1 已完成.*任务已完成/);
    const completedSentinelTask = await js('window.k3dAPI.agent.getTaskCheckpoint()');
    assert.strictEqual(completedSentinelTask.taskId, sentinelTask.taskId);
    assert.strictEqual(completedSentinelTask.status, 'completed');
    assert.deepStrictEqual(completedSentinelTask.completedOperationIds.sort(), ['remove_scope_sentinel', 'scope_sentinel']);
    recordCheck('subsequent edit has an independent completed ledger and the panel confirms task completion', true, runtimeState);

    // 4. Save artifacts
    console.log('Saving artifacts...');
    await wait(300); // Allow render to settle

    // Screenshot
    const image = await win.webContents.capturePage();
    const pngBuffer = image.toPNG();
    const screenshotPath = path.join(OUT, 'panel-and-canvas.png');
    fs.writeFileSync(screenshotPath, pngBuffer);
    recordCheck('saved screenshot panel-and-canvas.png', pngBuffer.length > 1000, { bytes: pngBuffer.length, path: screenshotPath });
    report.artifacts.push('panel-and-canvas.png');

    // .molwork export
    const molworkStr = await js('window.k3dAPI.serializeWorkbench()');
    assert.strictEqual(JSON.parse(molworkStr).agentTask.status, 'completed', 'editable export must not reopen an accepted completed task');
    const molworkPath = path.join(OUT, 'sn2-external-mcp.molwork');
    fs.writeFileSync(molworkPath, molworkStr);
    recordCheck('saved .molwork export sn2-external-mcp.molwork', typeof molworkStr === 'string' && molworkStr.length > 100, { bytes: molworkStr.length, path: molworkPath });
    report.artifacts.push('sn2-external-mcp.molwork');

    // report.json
    passed = report.checks.every(c => c.pass);
    report.passed = passed;
    report.timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    report.artifacts.push('report.json');

    console.log(`\n========================================`);
    console.log(`All checks finished! Result: ${passed ? 'PASSED' : 'FAILED'}`);
    console.log(`Artifacts saved in: ${OUT}`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Test execution error:', err);
    report.passed = false;
    report.error = String(err.stack || err);
    try {
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    } catch (_) {}
  } finally {
    clearTimeout(watchdog);
    cleanup();
    app.exit(passed ? 0 : 1);
  }
});
