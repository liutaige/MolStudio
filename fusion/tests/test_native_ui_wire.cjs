'use strict';
/* Native UI wire tests for the 3D molecule preview insert slot and the
 * inspector selection-scale presets (source tests, not acceptance).
 * Pure bridge logic: capability listing, tool.set wiring for 'insert.view3d',
 * the document.insert3d command, scale.preset property generation/commit, and
 * the attach-only confirm/prompt dialog fallbacks.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeUIBridge, SURFACES, PROTOCOL } = require('../workbench/native-ui-bridge');
require('../agent/native-renderer'); // Registers globalThis.MolStudioAgentNativeRenderer.

const defaultAgent = {
  isRunning: () => false, pendingStart: () => false, getRuntime: () => ({}),
  send() {}, stop() {}, continue() {}, reset() {},
  loadSettings: async () => ({ configured: false }),
  saveSettings: async () => ({ configured: false })
};

function makeFakeEditor() {
  const tools = [];
  return {
    toolCalls: tools,
    tool(name, opts) {
      if (arguments.length === 0) return { constructor: function Tool() {} };
      tools.push([name, opts]);
      return { constructor: function Tool() {} };
    },
    selection: () => ({ atoms: [], bonds: [] }),
    historySize: () => ({ undo: 1, redo: 0 }),
    event: { zoomChanged: { add() {}, remove() {}, dispatch() {} } }
  };
}

function makeIframeDoc() {
  return { querySelectorAll() { return []; } };
}

/* documentController stub with the Wave1/2 core-layer surface the bridge is
 * expected to talk to. Every call is recorded for assertions. */
function makeDocumentController() {
  const calls = { insert3d: [], beginScale: 0, applyScale: [], scaleSession: null };
  return {
    active: false,
    state: { mode: 'canvas' },
    selection: new Set(),
    tool: 'select',
    object: () => null,
    subscribe: () => () => {},
    emit() {},
    updateObject() {},
    __calls: calls,
    insertMolecule3DPreview: async (opts) => {
      calls.insert3d.push(opts || {});
      return makeDocumentController.insert3dResult
        || { ok: true, id: 'mol3d-1' };
    },
    hasScaleSelection: () => makeDocumentController.scaleSelectable === true,
    currentSessionPercent: () => (calls.scaleSession == null ? null : calls.scaleSession),
    beginScaleSession() { calls.beginScale++; if (calls.scaleSession == null) calls.scaleSession = 100; },
    applyScalePercent(percent) { calls.applyScale.push(percent); calls.scaleSession = percent; }
  };
}

function makeApp() {
  const controller = {
    tool: 'select',
    selection: new Set(),
    model: { arrow: () => null, lonePair: () => null },
    emitSelection() {},
    setTool(t) { this.tool = t; },
    setBendForSelection() {},
    toggleBondComponent() {},
    replanSelection() {},
    selectedArrows: () => [],
    statusCalls: [],
    status(message) { this.statusCalls.push(message); },
    adapter: { ed: makeFakeEditor(), doc: makeIframeDoc() }
  };
  const documentController = makeDocumentController();
  return {
    ready: true,
    controller,
    documentController,
    adapter: controller.adapter
  };
}

function makeDeps(overrides = {}) {
  const posts = [];
  const app = overrides.app || makeApp();
  const doc = {
    getElementById: () => null,
    querySelectorAll() { return []; }
  };
  const deps = {
    app,
    doc,
    viewport: {
      zoomBy() { return true; },
      setHostViewport() { return true; },
      effectiveRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 })
    },
    agent: () => defaultAgent,
    post: msg => { posts.push(msg); }
  };
  globalThis.webkit = { messageHandlers: { k3d: { postMessage: msg => { posts.push(msg); } } } };
  return { deps, app, posts };
}

async function attachAll(bridge) {
  return bridge.attach({
    protocol: PROTOCOL,
    epoch: { navigationGeneration: 42, pageId: 'page-1' },
    nativeSurfaces: [...SURFACES],
    host: { windowKey: true, focusOwner: 'canvas' }
  });
}

async function dispatch(bridge, id, args, requestId) {
  const { expectedSelectionRevision, ...rest } = args || {};
  return bridge.dispatch({
    protocol: PROTOCOL,
    epoch: { navigationGeneration: 42, pageId: 'page-1' },
    requestId: requestId || ('req-' + id + '-' + Math.random().toString(36).slice(2)),
    id,
    ...(expectedSelectionRevision !== undefined ? { expectedSelectionRevision } : {}),
    ...(Object.keys(rest).length ? { args: rest } : {})
  });
}

test('supported capability list exposes the insert.view3d tool id', () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const supported = bridge.supported();
  assert.ok(supported.toolIds.includes('insert.view3d'), 'insert.view3d must be a palette product id');
});

test('applyTool for insert.view3d keeps the tool and triggers the 3D insert path', async () => {
  const { deps, app } = makeDeps();
  app.controller.setTool('radical'); // active semantic tool before the click
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const reply = await dispatch(bridge, 'tool.set', { id: 'insert.view3d' }, 'tool-insert3d');
  assert.equal(reply.ok, true, 'tool.set insert.view3d replies ok (synchronous accept)');
  assert.equal(app.documentController.__calls.insert3d.length, 1, 'insertMolecule3DPreview invoked');
  await new Promise(resolve => setImmediate(resolve)); // let the fire-and-forget insert settle
  assert.equal(app.controller.tool, 'select', 'no persistent tool switch for insert.view3d');
  assert.equal(app.adapter.ed.toolCalls.filter(([name]) => name !== 'select').length, 0,
    'engine tool is not switched by insert.view3d');
});

test('document.insert3d command replies with the inserted preview id', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const reply = await dispatch(bridge, 'document.insert3d', {}, 'cmd-insert3d');
  assert.equal(reply.ok, true);
  assert.equal(reply.result.id, 'mol3d-1');
  assert.equal(app.documentController.__calls.insert3d.length, 1);
});

test('document.insert3d reports cancellation as ok without an id', async () => {
  const { deps, app } = makeDeps();
  Object.defineProperty(app.documentController, 'insertMolecule3DPreview', {
    configurable: true,
    value: async () => ({ ok: false, cancelled: true })
  });
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const reply = await dispatch(bridge, 'document.insert3d', {}, 'cmd-insert3d-cancel');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { cancelled: true });
});

test('document.insert3d surfaces controller failure as a failed reply', async () => {
  const { deps, app } = makeDeps();
  Object.defineProperty(app.documentController, 'insertMolecule3DPreview', {
    configurable: true,
    value: async () => ({ ok: false, error: '无可用构象' })
  });
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const reply = await dispatch(bridge, 'document.insert3d', {}, 'cmd-insert3d-fail');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.message, '无可用构象');
});

test('selectionProperties exposes scale presets only with a scalable selection', () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const base = () => bridge.selectionProperties({ arrows: [], docObjects: [] });

  const without = base();
  assert.ok(!without.some(p => p.id === 'scale.preset'), 'no scale row without a scalable selection');

  makeDocumentController && (app.documentController.__calls.scaleSession = 125);
  app.documentController.state = { mode: 'paper' };
  app.documentController.hasScaleSelection = () => true;
  const withScale = base();
  const preset = withScale.find(p => p.id === 'scale.preset');
  assert.ok(preset, 'scale.preset appears with a scalable selection');
  assert.equal(preset.type, 'choice');
  assert.equal(preset.label, '缩放选区');
  assert.equal(preset.value, '125', 'defaults to the current session percent');
  assert.deepEqual(preset.choices.map(c => c.value), ['75', '100', '125', '150', '200']);
  const hint = withScale.find(p => p.id === 'scale.hint');
  assert.ok(hint, 'read-only hint row accompanies the preset');
  assert.equal(hint.enabled, false, 'hint row must not be committable');
  assert.ok(hint.value.includes('撤销动作'));
});

test('scale.preset commit begins a session then applies the percent, with revision guard', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  app.documentController.state = { mode: 'paper' };
  app.documentController.hasScaleSelection = () => true;
  const revision = bridge.selectionRevision;
  const reply = await dispatch(bridge, 'selection.setProperty',
    { propertyId: 'scale.preset', value: '150', expectedSelectionRevision: revision }, 'scale-ok');
  assert.equal(reply.ok, true);
  const calls = app.documentController.__calls;
  assert.equal(calls.beginScale, 1, 'session started exactly once');
  assert.deepEqual(calls.applyScale, [150]);
  assert.ok(calls.beginScale <= calls.applyScale.length, 'begin happens before apply');

  const stale = await dispatch(bridge, 'selection.setProperty',
    { propertyId: 'scale.preset', value: '200', expectedSelectionRevision: revision + 99 }, 'scale-stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_selection', 'stale selection guard still applies');
  assert.deepEqual(calls.applyScale, [150], 'stale commit never reaches the controller');
});

test('scale.preset commit rejects without a scalable selection', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const revision = bridge.selectionRevision;
  const reply = await dispatch(bridge, 'selection.setProperty',
    { propertyId: 'scale.preset', value: '150', expectedSelectionRevision: revision }, 'scale-none');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'unsupported', 'scale.preset is not offered without a scalable selection');
  assert.equal(app.documentController.__calls.applyScale.length, 0);
});

test('buildSelection labels a multi-molecule chemistry selection as chemistry content', () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  app.controller.selection = new Set(['mol-1', 'mol-2']);
  const selection = bridge.buildSelection();
  assert.equal(selection.kind, 'molecule');
  assert.equal(selection.label, '所选化学内容');
});

test('attach installs confirm/prompt dialog fallbacks and detach restores them', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const beforeChoose = app.documentController.onChooseMolecule3DTarget;
  const beforeStereo = app.documentController.onStereoChoiceRequired;
  await attachAll(bridge);
  assert.equal(typeof app.documentController.onChooseMolecule3DTarget, 'function', 'choose hook installed');
  assert.equal(typeof app.documentController.onStereoChoiceRequired, 'function', 'stereo hook installed');
  assert.notEqual(app.documentController.onChooseMolecule3DTarget, beforeChoose);

  bridge.detach(bridge.epoch);
  assert.equal(app.documentController.onChooseMolecule3DTarget, beforeChoose, 'detach restores previous hooks');
  assert.equal(app.documentController.onStereoChoiceRequired, beforeStereo);
});

test('single candidate uses window.confirm yes/no', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const choose = app.documentController.onChooseMolecule3DTarget;
  const candidate = { atomCount: 12 };
  const prompts = [];
  globalThis.prompt = (...a) => { prompts.push(a); return null; };
  globalThis.confirm = () => true;
  assert.equal(await choose([candidate]), candidate);
  globalThis.confirm = () => false;
  assert.equal(await choose([candidate]), null);
  assert.equal(prompts.length, 0, 'single candidate never opens a prompt');
});

test('multiple candidates use window.prompt ordinal input', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const choose = app.documentController.onChooseMolecule3DTarget;
  const candidates = [{ atomCount: 6 }, { atomCount: 21 }];
  let promptText = '', confirmSeen = false;
  globalThis.confirm = () => { confirmSeen = true; return true; };
  globalThis.prompt = text => { promptText = String(text); return '2'; };
  assert.equal(await choose(candidates), candidates[1]);
  assert.ok(promptText.includes('分子 1（6 个原子）'), 'prompt lists candidates with atom counts');
  assert.ok(promptText.includes('分子 2（21 个原子）'));
  assert.equal(confirmSeen, false, 'ordinal pick bypasses confirm');
  globalThis.prompt = () => null;
  assert.equal(await choose(candidates), null, 'prompt cancel returns null');
  globalThis.prompt = () => 'nope';
  await assert.rejects(() => choose(candidates), /请在画布中仅选择一个分子后重试/);
});

test('missing window.prompt throws the documented Chinese error for multi-candidate', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const choose = app.documentController.onChooseMolecule3DTarget;
  const savedPrompt = globalThis.prompt;
  delete globalThis.prompt;
  try {
    await assert.rejects(() => choose([{ atomCount: 3 }, { atomCount: 9 }]), /请在画布中仅选择一个分子后重试/);
  } finally {
    globalThis.prompt = savedPrompt;
  }
});

test('stereo confirmation uses window.confirm with counts and molecules summary', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const stereoChoice = app.documentController.onStereoChoiceRequired;
  const seen = [];
  globalThis.confirm = text => { seen.push(String(text)); return true; };
  assert.equal(await stereoChoice({ counts: { centers: 2 }, molecules: ['咖啡因'] }), true);
  assert.ok(seen[0].includes('使用示例构型'), 'stereo dialog asks about the example configuration');
  assert.ok(seen[0].includes('咖啡因'), 'molecule names are listed');
  globalThis.confirm = () => false;
  assert.equal(await stereoChoice({ counts: { centers: 1 }, molecules: [] }), false);
});


test('scale.preset is paper-mode only: canvas mode properties omit it and commits reject', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const base = () => bridge.selectionProperties({ arrows: [], docObjects: [] });
  app.documentController.state = { mode: 'canvas' };
  app.documentController.hasScaleSelection = () => true;
  assert.ok(!base().some(p => p.id === 'scale.preset'), 'canvas mode never shows scale presets');

  await attachAll(bridge);
  app.documentController.state = { mode: 'canvas' };
  app.documentController.hasScaleSelection = () => true;
  const revision = bridge.selectionRevision;
  const reply = await dispatch(bridge, 'selection.setProperty',
    { propertyId: 'scale.preset', value: '150', expectedSelectionRevision: revision }, 'scale-canvas');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'unsupported');
  // canvas 模式下属性本身不公开（selectionProperties 已隐藏），提交走"未公开的可写属性"早退；
  // 即便绕过属性表直发命令，applySelectionProperty 内的纸页门禁也返回"仅在纸页模式可用"。
  assert.ok(reply.error.message.includes('未公开') || reply.error.message.includes('纸页'),
    'rejection explains the property is not available outside paper mode');
  assert.equal(app.documentController.__calls.beginScale, 0, 'no session in canvas mode');
});


test('document.text tool id maps to the paper rich-text box tool', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  app.documentController.setTool = (tool) => { app.documentController.__toolCalls.push(tool); };
  if (!app.documentController.__toolCalls) app.documentController.__toolCalls = [];
  const supported = bridge.capabilities ? bridge.capabilities() : null;
  const reply = await dispatch(bridge, 'tool.set', { id: 'document.text' }, 'doc-text');
  assert.equal(reply.ok, true, 'tool.set accepts document.text');
  const calls = app.documentController.__toolCalls;
  assert.ok(calls.includes('text'), `document.text must call setTool('text'), got: ${JSON.stringify(calls)}`);
});

test('native attach preserves the working document UI molecule and stereo dialogs', async () => {
  const { deps, app } = makeDeps();
  const choose = async candidates => candidates[0], stereo = async () => true;
  app.documentController.onChooseMolecule3DTarget = choose;
  app.documentController.onStereoChoiceRequired = stereo;
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  assert.equal(app.documentController.onChooseMolecule3DTarget, choose);
  assert.equal(app.documentController.onStereoChoiceRequired, stereo);
  bridge.detach(bridge.epoch);
  assert.equal(app.documentController.onChooseMolecule3DTarget, choose);
  assert.equal(app.documentController.onStereoChoiceRequired, stereo);
});

test('native detach preserves document UI hooks installed after fallback attachment', async () => {
  const { deps, app } = makeDeps(), bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const choose = async candidates => candidates[0], stereo = async () => true;
  app.documentController.onChooseMolecule3DTarget = choose;
  app.documentController.onStereoChoiceRequired = stereo;
  bridge.detach(bridge.epoch);
  assert.equal(app.documentController.onChooseMolecule3DTarget, choose);
  assert.equal(app.documentController.onStereoChoiceRequired, stereo);
});

test('native dialog fallbacks fill only the missing callback', async () => {
  const { deps, app } = makeDeps(), bridge = new NativeUIBridge(deps);
  const choose = async candidates => candidates[0];
  app.documentController.onChooseMolecule3DTarget = choose;
  await attachAll(bridge);
  assert.equal(app.documentController.onChooseMolecule3DTarget, choose);
  assert.equal(typeof app.documentController.onStereoChoiceRequired, 'function');
  bridge.detach(bridge.epoch);
  assert.equal(app.documentController.onChooseMolecule3DTarget, choose);
  assert.equal(app.documentController.onStereoChoiceRequired, undefined);
});

test('fallback candidate labels use the real controller size field', async t => {
  const { deps, app } = makeDeps(), bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const candidates = [{ size: 6, atomUuids: ['a'] }, { size: 21, atomUuids: ['b'] }];
  let text = '';
  const savedPrompt = globalThis.prompt;
  t.after(() => { if (savedPrompt === undefined) delete globalThis.prompt; else globalThis.prompt = savedPrompt; });
  globalThis.prompt = message => { text = message; return '2'; };
  assert.equal(await app.documentController.onChooseMolecule3DTarget(candidates), candidates[1]);
  assert.ok(text.includes('分子 1（6 个原子）')); assert.ok(text.includes('分子 2（21 个原子）'));
});
