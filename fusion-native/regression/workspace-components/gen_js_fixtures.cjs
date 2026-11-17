'use strict';
// Generates real JS-originated nativeUI fixtures under ./fixtures/ by executing
// the actual workbench and agent JS modules (no hand-crafted JSON messages).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require(path.resolve(__dirname, '../../../fusion/node_modules/jsdom'));

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

function loadScript(ctx, relPath) {
  const full = path.join(ROOT, relPath);
  const code = fs.readFileSync(full, 'utf8');
  vm.runInContext(code, ctx, { filename: full });
}

function buildRealHarness() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <iframe id="k"></iframe>
    <div id="mech-sel-bar"></div>
    <div id="molstudio-document-toolbar"></div>
    <div id="molstudio-document-panel"></div>
    <div id="molstudio-document-status"></div>
    <div data-native-surface="zoomPalette"></div>
    <div id="molstudio-agent-panel"></div>
  </body></html>`, { url: 'http://127.0.0.1:49075/canvas.html' });

  const posted = [];
  let activeTool = 'select';
  let activeToolOpts;
  let selection = { atoms: [1], bonds: [] };
  let history = { undo: 0, redo: 0 };
  let mode = 'canvas';
  let pages = [{ id: 'p1' }];
  let pageSize = 'A4';
  let pageOrientation = 'portrait';
  let pageMarginPt = 34.0157;
  let activePageIndex = 0;
  let docListeners = [];
  let zoomPercent = 100;
  let editorZoom = 1;
  let runtimeCanContinue = false;

  const rect = { left: 0, top: 0, right: 1440, bottom: 960, width: 1440, height: 960 };
  const clientArea = { getBoundingClientRect: () => rect, contains: () => true, clientHeight: 960 };
  const iframeDoc = { addEventListener() {}, elementFromPoint: () => clientArea, defaultView: dom.window };
  const render = { clientArea, viewBox: { minX: 0, minY: 0, width: 1440, height: 960 }, setViewBox(fn) { this.viewBox = fn(this.viewBox); } };
  const struct = { atoms: new Map([[1, { label: 'C' }], [2, { label: 'N' }]]), bonds: new Map(), rxnArrows: new Map() };
  const listeners = { selectionChange: [] };
  const ed = {
    render,
    tool: (name, opts) => {
      if (name === undefined) return { constructor: { name: activeTool } };
      activeTool = String(name).toLowerCase();
      activeToolOpts = opts;
      return true;
    },
    zoom: (v, anchor) => {
      if (v === undefined) return editorZoom;
      editorZoom = Number(v);
      return editorZoom;
    },
    selection: v => (v === undefined ? selection : (selection = v)),
    historySize: () => ({ ...history }),
    undo: () => { if (history.undo > 0) { history.undo -= 1; history.redo += 1; } },
    redo: () => { if (history.redo > 0) { history.redo -= 1; history.undo += 1; } },
    struct: () => struct,
    event: {
      zoomChanged: { dispatch() {} },
      selectionChange: {
        add: fn => listeners.selectionChange.push(fn),
        remove: fn => { listeners.selectionChange = listeners.selectionChange.filter(f => f !== fn); }
      }
    }
  };

  let activeRenderer = null;
  let currentConfig = {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.invalid/v1',
    model: 'deepseek-v4.1-flash',
    configured: true,
    apiKey: 'sk-should-never-escape-js',
    sessionToken: 'tok-should-never-escape-js',
    generation: { profile: 'deepseek', effort: 'low', maxOutputTokens: 16384 },
    generationCapabilities: {
      openaiModels: {
        'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh', 'bogus'],
        'gpt-5.1': ['none', 'low', 'medium', 'high']
      },
      secretExtra: 'drop-me'
    }
  };

  const ctx = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    console,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Set,
    Map,
    Promise
  });
  ctx.self = ctx.window;
  ctx.globalThis = ctx.window;

  dom.window.webkit = {
    messageHandlers: {
      k3d: {
        postMessage(msg) {
          posted.push(JSON.parse(JSON.stringify(msg)));
        }
      }
    }
  };

  dom.window.molstudioNativeTemplates = {
    list: () => [
      { name: 'Benzene', struct: { name: 'Benzene', clone: () => ({ name: 'Benzene' }) } },
      { name: 'Cyclohexane', struct: { name: 'Cyclohexane', clone: () => ({ name: 'Cyclohexane' }) } },
      { name: 'Cyclopentane', struct: { name: 'Cyclopentane', clone: () => ({ name: 'Cyclopentane' }) } },
      { name: 'Cyclopropane', struct: { name: 'Cyclopropane', clone: () => ({ name: 'Cyclopropane' }) } }
    ]
  };

  const iframe = dom.window.document.getElementById('k');
  Object.defineProperty(iframe, 'contentDocument', { value: iframeDoc, configurable: true });
  Object.defineProperty(iframe, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: 1440, bottom: 960, width: 1440, height: 960 })
  });

  dom.window.k3dAPI = {
    isReady: () => true,
    workbenchReady: () => true,
    agent: {
      getConfig: () => JSON.parse(JSON.stringify(currentConfig))
    }
  };

  dom.window.molstudioAgent = {
    useNativeRenderer(renderer) {
      activeRenderer = renderer;
      renderer.setConfig(currentConfig);
    },
    restoreBrowserRenderer() {
      activeRenderer = null;
    },
    getRuntime: () => ({ get canContinue() { return runtimeCanContinue; } }),
    isRunning: () => false,
    pendingStart: () => false,
    loadSettings: async () => JSON.parse(JSON.stringify(currentConfig)),
    startRunWithText(text) {
      if (activeRenderer) {
        activeRenderer.handleEvent({ type: 'user_message', text });
      }
      return 'run-real-js-1';
    },
    send(text) {
      return this.startRunWithText(text);
    },
    stop() {},
    continueRun() {},
    reset() {},
    saveConfig(cfg) {
      currentConfig = { ...currentConfig, ...cfg };
      if (activeRenderer) activeRenderer.setConfig(currentConfig);
      return currentConfig;
    }
  };

  dom.window.MolWorkbench = {
    app: {
      ready: true,
      adapter: { ed, doc: dom.window.document },
      mechanism: {
        setTool: () => true,
        exportSnapshot: () => ({ selectionRevision: 0 })
      },
      controller: {
        adapter: { ed },
        selection: new Set(),
        selectedObject: () => null,
        setTool: () => true,
        setBendForSelection: () => true
      },
      documentController: {
        get active() { return mode === 'paper'; },
        get state() {
          return {
            mode,
            pageCount: pages.length,
            pages: pages.slice(),
            activePageIndex,
            page: {
              size: pageSize,
              orientation: pageOrientation,
              margins: { top: pageMarginPt, right: pageMarginPt, bottom: pageMarginPt, left: pageMarginPt }
            },
            objects: [],
            paperZoomPercent: zoomPercent
          };
        },
        getState() { return this.state; },
        updateObject: () => true,
        getPaperZoom() { return zoomPercent; },
        setPaperZoom(pct) { zoomPercent = Number(pct); docListeners.forEach(fn => fn()); return true; },
        fitPage() { zoomPercent = 82; docListeners.forEach(fn => fn()); return true; },
        fitWidth() { zoomPercent = 95; docListeners.forEach(fn => fn()); return true; },
        getViewportState() {
          return {
            activePageIndex,
            zoomPercent,
            minZoomPercent: 25,
            maxZoomPercent: 400
          };
        },
        setPageSetup(opts) {
          if (opts.size) pageSize = opts.size;
          if (opts.orientation) pageOrientation = opts.orientation;
          if (typeof opts.marginPt === 'number') pageMarginPt = opts.marginPt;
          docListeners.forEach(fn => fn());
          return true;
        },
        addPage() {
          pages.push({ id: `p${pages.length + 1}` });
          activePageIndex = pages.length - 1;
          docListeners.forEach(fn => fn());
          return true;
        },
        canRemoveLastPage() { return pages.length > 1; },
        removeLastPage() {
          if (pages.length <= 1) return false;
          pages.pop();
          activePageIndex = Math.min(activePageIndex, pages.length - 1);
          docListeners.forEach(fn => fn());
          return true;
        },
        fitToPage() { return this.fitPage(); },
        fitToWidth() { return this.fitWidth(); },
        setZoomPercent(pct) { return this.setPaperZoom(pct); },
        subscribe(fn) {
          docListeners.push(fn);
          return () => { docListeners = docListeners.filter(x => x !== fn); };
        }
      }
    }
  };

  loadScript(ctx, 'fusion/workbench/canvas-viewport.js');
  const vp = dom.window.MolCanvasViewport.create(iframe, () => ed);
  vp.install(iframeDoc);
  dom.window.molCanvasViewport = vp;

  loadScript(ctx, 'fusion/agent/native-renderer.js');
  loadScript(ctx, 'fusion/workbench/native-ui-bridge.js');
  dom.window.MolWorkbench.nativeUI.install();

  return {
    window: dom.window,
    posted,
    setMode(next) { mode = next; docListeners.forEach(fn => fn()); },
    setSelection(sel) {
      selection = sel;
      listeners.selectionChange.forEach(fn => fn());
    },
    getRenderer: () => activeRenderer,
    triggerConfig: cfg => {
      currentConfig = { ...currentConfig, ...cfg };
      if (activeRenderer) activeRenderer.setConfig(currentConfig);
    },
    setRuntimeCanContinue: v => { runtimeCanContinue = !!v; },
    resetPosted: () => posted.splice(0)
  };
}

async function main() {
  const h = buildRealHarness();
  const bridge = h.window.k3dAPI.nativeUI;

  // 1. Swift-style attach (WorkspaceAttachOptions passes top-level navigationGeneration, no pageId)
  const attachReply = await bridge.attach({
    protocol: 1,
    navigationGeneration: 3,
    nativeSurfaces: ['fileCommands', 'toolPalette', 'zoomPalette', 'inspector', 'agent'],
    host: { windowKey: true, focusOwner: 'canvas', inspectorVisible: true }
  });

  // Wait for setTimeout(0) initial agent snapshot flush
  await new Promise(r => setTimeout(r, 30));
  const postAttachMessages = h.posted.splice(0);

  const epoch = attachReply.epoch;

  // 2. Host context + tool change + selection A -> B in canvas mode
  await bridge.dispatch({
    protocol: 1,
    epoch,
    requestId: 'req-hc',
    id: 'host.context',
    args: {
      windowKey: true,
      focusOwner: 'canvas',
      inspectorVisible: true,
      viewport: {
        layoutRevision: 1,
        cssSize: { width: 1440, height: 960 },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        overlays: [{ id: 'toolPalette', x: 0, y: 0, width: 56, height: 600 }]
      }
    }
  });
  await bridge.dispatch({
    protocol: 1,
    epoch,
    requestId: 'req-tpl',
    id: 'template.set',
    args: { id: 'ring.benzene' }
  });
  h.setSelection({ atoms: [2], bonds: [] });
  await new Promise(r => setTimeout(r, 160));
  const canvasMessages = h.posted.splice(0);

  // 3. Paper mode state + addPage via documentController + zoom.toPercent
  h.setMode('paper');
  h.window.MolWorkbench.app.documentController.addPage();
  await bridge.dispatch({ protocol: 1, epoch, requestId: 'req-pct', id: 'zoom.toPercent', args: { percent: 150 } });
  await new Promise(r => setTimeout(r, 160));
  const paperMessages = h.posted.splice(0);

  // 4. Real MolStudioAgentNativeRenderer run without messageId on text_delta + model thinking + phases + tool diagnostic + run_end(incomplete)
  const renderer = h.getRenderer();
  renderer.handleEvent({ type: 'user_message', text: '画出咖啡因两条独立机理路线' });
  renderer.handleEvent({ type: 'run_start', runId: 'run-real-1', prompt: '画出咖啡因两条独立机理路线' });
  renderer.handleEvent({
    type: 'task_checkpoint',
    checkpoint: {
      goal: '咖啡因双路线机理',
      status: 'running',
      phaseIndex: 0,
      phases: [{ objective: '路线 A', status: 'running', sessionToken: 'tok-should-never-escape-js' }],
      apiKey: 'sk-should-never-escape-js'
    }
  });
  renderer.handleEvent({
    type: 'generation_applied',
    generation: {
      requested: { profile: 'deepseek', effort: 'max', maxOutputTokens: 32768 },
      fields: { thinking: { type: 'enabled' }, sessionToken: 'tok-should-never-escape-js', apiKey: 'sk-should-never-escape-js' }
    }
  });
  renderer.handleEvent({ type: 'thinking_delta', runId: 'run-real-1', source: 'model', delta: '规划路线 A 与路线 B。' });
  renderer.handleEvent({ type: 'phase_start', runId: 'run-real-1', phaseIndex: 1, objective: '绘制茶碱去质子化路线' });
  renderer.handleEvent({
    type: 'tool_start',
    runId: 'run-real-1',
    toolCallId: 'tc-real-1',
    name: 'draw_operations',
    label: '绘制步骤',
    completedOperations: 2
  });
  renderer.handleEvent({
    type: 'tool_progress',
    runId: 'run-real-1',
    toolCallId: 'tc-real-1',
    name: 'draw_operations',
    progress: { phase: 'committed', count: 2, sessionToken: 'tok-should-never-escape-js', apiKey: 'sk-should-never-escape-js' }
  });
  renderer.handleEvent({
    type: 'tool_end',
    runId: 'run-real-1',
    toolCallId: 'tc-real-1',
    name: 'draw_operations',
    label: '绘制步骤',
    success: true,
    finishRejected: true,
    completedOperations: 2,
    summary: '需要补全电子流',
    changes: ['已放置茶碱'],
    diagnostic: {
      code: 'incomplete_mechanism',
      reason: 'Authorization: Bearer sk-dummy-redaction-probe'
    }
  });
  renderer.handleEvent({
    type: 'tool_start',
    runId: 'run-real-1',
    toolCallId: 'tc-real-fail',
    name: 'inspect_structures',
    label: '检查结构'
  });
  renderer.handleEvent({
    type: 'tool_end',
    runId: 'run-real-1',
    toolCallId: 'tc-real-fail',
    name: 'inspect_structures',
    label: '检查结构',
    success: false,
    summary: '结构解析失败',
    diagnostic: {
      code: 'invalid_smiles',
      reason: 'Authorization: Bearer sk-dummy-redaction-probe'
    }
  });
  renderer.handleEvent({ type: 'step_commit', runId: 'run-real-1', label: '步骤 1', operationCount: 3 });
  renderer.handleEvent({ type: 'phase_end', runId: 'run-real-1', phaseIndex: 1, summary: '完成路线 A 首步' });
  // Simulate runtime.js omitting messageId on assistant_start / text_delta / assistant_end
  renderer.handleEvent({ type: 'assistant_start', runId: 'run-real-1' });
  renderer.handleEvent({ type: 'text_delta', runId: 'run-real-1', delta: '已完成第一步反应箭头。' });
  renderer.handleEvent({ type: 'text_delta', runId: 'run-real-1', channel: 'analysis', hidden: true, delta: 'HIDDEN_CHANNEL_DROP' });
  renderer.handleEvent({ type: 'assistant_end', runId: 'run-real-1' });
  renderer.handleEvent({ type: 'run_end', runId: 'run-real-1', status: 'incomplete', reason: 'recovery_exhausted', canContinue: true });
  h.setRuntimeCanContinue(true);
  h.triggerConfig({ model: 'deepseek-reasoner' });

  await new Promise(r => setTimeout(r, 160));
  const agentRunMessages = h.posted.splice(0);

  // Switch back to canvas to inspect latest UIState reflecting canContinue + template caps, and verify agent.settings.load
  h.setMode('canvas');
  const settingsLoadReply = await bridge.dispatch({
    protocol: 1,
    epoch,
    requestId: 'req-settings-load',
    id: 'agent.settings.load',
    args: {}
  });
  const finalState = bridge.getState();

  const bundle = {
    generatedBy: 'regression/workspace-components/gen_js_fixtures.cjs',
    sourceModules: [
      'fusion/workbench/canvas-viewport.js',
      'fusion/workbench/native-ui-bridge.js',
      'fusion/agent/native-renderer.js'
    ],
    attachReply,
    settingsLoadReply,
    postAttachMessages,
    canvasMessages,
    paperMessages,
    agentRunMessages,
    finalState
  };

  const json = JSON.stringify(bundle, null, 2);
  if (json.includes('sk-should-never-escape-js') || json.includes('tok-should-never-escape-js') || json.includes('sessionToken') || json.includes('apiKey')) {
    throw new Error('Secret key or field leaked into generated fixture!');
  }

  const outPath = path.join(FIXTURE_DIR, 'contract-fixtures.json');
  fs.writeFileSync(outPath, json + '\n');
  console.log(JSON.stringify({
    ok: true,
    outPath,
    postAttachCount: postAttachMessages.length,
    canvasCount: canvasMessages.length,
    paperCount: paperMessages.length,
    agentRunCount: agentRunMessages.length
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
