'use strict';
/* Native UI contract v1 — bridge behaviour tests (source tests, not acceptance).
 * Covers: attach handshake/capability gating/idempotency, epoch staleness,
 * request idempotency, stale selection rejection, host viewport validation,
 * single-commit bend, public settings filtering, detach restoring web surfaces.
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
  const listeners = new Set();
  return {
    toolCalls: tools,
    tool(name, opts) {
      if (arguments.length === 0) return { constructor: function Tool() {} };
      tools.push([name, opts]);
      return { constructor: function Tool() {} };
    },
    selection: () => ({ atoms: [], bonds: [] }),
    historySize: () => ({ undo: 2, redo: 1 }),
    event: { zoomChanged: { add(fn) { listeners.add(fn); }, remove(fn) { listeners.delete(fn); }, dispatch() { listeners.forEach(f => f()); } } }
  };
}

function makeApp() {
  makeApp.bendCalls = 0;
  makeApp.toggleCalls = 0;
  makeApp.replanCalls = 0;
  makeApp.docUpdateCalls = 0;
  const controller = {
    tool: 'select',
    selection: new Set(),
    model: { arrow: () => null, lonePair: () => null },
    emitSelection() {},
    setTool(t) { this.tool = t; },
    setBendForSelection: () => { makeApp.bendCalls++; },
    toggleBondComponent: () => { makeApp.toggleCalls++; },
    replanSelection: () => { makeApp.replanCalls++; },
    selectedArrows: () => [],
    adapter: { ed: makeFakeEditor(), doc: makeIframeDoc() }
  };
  const documentController = {
    active: false,
    state: { mode: 'canvas' },
    selection: new Set(),
    tool: 'select',
    object: () => null,
    subscribe: () => () => {},
    emit() {},
    updateObject: () => { makeApp.docUpdateCalls++; }
  };
  const app = {
    ready: true,
    controller,
    documentController,
    adapter: controller.adapter
  };
  return app;
}

function makeIframeDoc() {
  const elements = [];
  return {
    __elements: elements,
    querySelectorAll() { return []; }
  };
}

test('pan notifications do no native inspector or state work, while zoom and edits still publish', () => {
  const { deps, app, posts } = makeDeps(), adapterListeners = new Set(), documentListeners = new Set();
  app.adapter.onChange = fn => { adapterListeners.add(fn); return () => adapterListeners.delete(fn); };
  app.documentController.subscribe = fn => { documentListeners.add(fn); return () => documentListeners.delete(fn); };
  const bridge = new NativeUIBridge(deps); let marks = 0, builds = 0, keys = 0;
  bridge.markState = () => { marks++; };
  bridge.noteSelectionChange();
  const revision = bridge.selectionRevision, sequence = bridge.sequence;
  const build = bridge.buildSelection.bind(bridge), key = bridge.computeSelectionKey.bind(bridge);
  bridge.buildSelection = () => { builds++; return build(); };
  bridge.computeSelectionKey = () => { keys++; return key(); };
  bridge.installObservers(); marks = 0;
  for (let i = 0; i < 10; i++) {
    adapterListeners.forEach(fn => fn('pan'));
    documentListeners.forEach(fn => fn(app.documentController.state, app.documentController, 'pan'));
  }
  assert.equal(marks, 0); assert.equal(builds, 0); assert.equal(keys, 0);
  assert.equal(bridge.selectionRevision, revision); assert.equal(bridge.sequence, sequence); assert.equal(posts.length, 0);
  adapterListeners.forEach(fn => fn('transform'));
  documentListeners.forEach(fn => fn(app.documentController.state, app.documentController, 'transform'));
  assert.equal(marks, 2, 'zoom/resize still request a coalesced state update');
  assert.equal(builds, 0); assert.equal(keys, 0); assert.equal(bridge.selectionRevision, revision);
  app.adapter.ed.historySize = () => ({ undo: 3, redo: 0 });
  adapterListeners.forEach(fn => fn('struct'));
  assert.ok(bridge.selectionRevision > revision); assert.equal(builds, 1); assert.equal(keys, 1);
  documentListeners.forEach(fn => fn(app.documentController.state, app.documentController));
  assert.equal(builds, 2); assert.equal(keys, 2, 'ordinary document edits still refresh selection properties');
});

function makeDoc() {
  const byId = new Map();
  const created = [];
  const el = id => ({
    id, dataset: {}, style: { display: '' },
    querySelectorAll() { return []; }
  });
  for (const id of ['mech-sel-bar', 'molstudio-document-toolbar', 'molstudio-document-panel', 'molstudio-document-status']) {
    byId.set(id, el(id));
  }
  return {
    __byId: byId,
    getElementById: id => byId.get(id) || null,
    querySelectorAll: () => [],
    createElement: tag => ({ tag, style: {}, dataset: {} }),
    head: { appendChild() {} },
    body: { appendChild() {} }
  };
}

function makeDeps(overrides = {}) {
  const posts = [];
  const app = overrides.app || makeApp();
  const deps = {
    app,
    doc: overrides.doc || makeDoc(),
    viewport: {
      zoomByCalls: [],
      zoomBy(factor, anchor) { this.zoomByCalls.push([factor, anchor]); return this.zoomOk !== false; },
      setHostViewport(v) { this.hostViewport = v; return true; },
      effectiveRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
      ...(overrides.viewport || {})
    },
    agent: overrides.agent ? () => overrides.agent : () => defaultAgent,
    post: msg => { posts.push(msg); }
  };
  // The bridge posts through webkit.messageHandlers.k3d; install a fake one on
  // the module's root (globalThis under Node).
  const fakeRoot = {
    webkit: { messageHandlers: { k3d: { postMessage: msg => { posts.push(msg); deps.post(msg); } } } },
    innerWidth: 800,
    innerHeight: 600
  };
  globalThis.webkit = fakeRoot.webkit;
  return { deps, app, posts, doc: deps.doc };
}

async function attachAll(bridge, epoch) {
  return bridge.attach({
    protocol: PROTOCOL,
    epoch: epoch || { navigationGeneration: 42, pageId: 'page-1' },
    nativeSurfaces: [...SURFACES],
    host: { windowKey: true, focusOwner: 'canvas' }
  });
}

test('advanced tools restore editor toolbars and detach restores browser fallback', async () => {
  const { deps, app } = makeDeps();
  const bars = Object.fromEntries(['top-toolbar', 'left-toolbar', 'right-toolbar', 'bottom-toolbar']
    .map(id => [id, { dataset: {}, style: { display: '' } }]));
  app.adapter.doc.querySelectorAll = selector => {
    const match = selector.match(/^\[data-testid="([^"]+)"\]$/);
    return match && bars[match[1]] ? [bars[match[1]]] : [];
  };
  const bridge = new NativeUIBridge(deps);
  const reply = await attachAll(bridge);
  assert.equal(reply.ok, true);
  assert.ok(Object.values(bars).every(el => el.style.display === 'none'));
  assert.equal(bridge.setAdvancedWebTools(true), true);
  assert.ok(Object.values(bars).every(el => el.style.display === ''));
  assert.equal(bridge.setAdvancedWebTools(false), true);
  assert.ok(Object.values(bars).every(el => el.style.display === 'none'));
  bridge.detach(reply.epoch);
  assert.ok(Object.values(bars).every(el => el.style.display === ''));
});

test('partial native ownership leaves the editor toolbar available', () => {
  const { deps, app } = makeDeps();
  const toolbar = { dataset: {}, style: { display: '' } };
  app.adapter.doc.querySelectorAll = selector =>
    selector === '[data-testid="top-toolbar"]' ? [toolbar] : [];
  const bridge = new NativeUIBridge(deps);
  bridge.hideWebSurfaces(['fileCommands']);
  assert.equal(toolbar.style.display, '');
});

test('a partially failed attach can restore its current epoch without touching a stale epoch', async () => {
  const { deps, app } = makeDeps();
  const toolbar = { dataset: {}, style: { display: '' } };
  app.adapter.doc.querySelectorAll = selector =>
    selector === '[data-testid="top-toolbar"]' ? [toolbar] : [];
  const bridge = new NativeUIBridge(deps);
  bridge.activateNativeAgent = () => { throw new Error('injected renderer failure'); };
  await assert.rejects(() => attachAll(bridge), /injected renderer failure/);
  assert.equal(toolbar.style.display, 'none');
  assert.equal(bridge.detach({ navigationGeneration: 41, pageId: 'old' }).ok, false);
  assert.equal(toolbar.style.display, 'none');
  assert.equal(bridge.detach({ ...bridge.epoch }).ok, true);
  assert.equal(toolbar.style.display, '');
});

test('attach succeeds with complete capabilities and hides owned web surfaces only', async () => {
  const { deps, posts } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const reply = await attachAll(bridge);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.ownedSurfaces.sort(), [...SURFACES].sort());
  assert.equal(reply.epoch, undefined || reply.epoch); // epoch echoed
  assert.equal(reply.epoch.pageId, 'page-1');
  assert.equal(reply.sequence, 0);
  const state = reply.state;
  assert.equal(state.protocol, 1);
  assert.deepEqual(state.epoch, { navigationGeneration: 42, pageId: 'page-1' });
  assert.equal(state.ready.canvas, true);
  assert.ok(Array.isArray(state.selection.properties));
  // Mapped inspector/status web controls hidden; unmapped document toolbar & rich panel stay intact.
  for (const id of ['mech-sel-bar', 'molstudio-document-status']) {
    assert.equal(deps.doc.__byId.get(id).dataset.nativeOwned, '1');
  }
  for (const id of ['molstudio-document-toolbar', 'molstudio-document-panel']) {
    assert.equal(deps.doc.__byId.get(id).dataset.nativeOwned, undefined);
  }
  // Nothing published before subscribe? attach must not push a sequence>0
  // payload before the reply (snapshot goes out after reply in the caller).
  assert.equal(posts.length, 0);
});

test('attach rejects wrong protocol, missing epoch, and not-ready workbench with web controls intact', async () => {
  const { deps, doc } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const bad = await bridge.attach({ protocol: 2, epoch: { navigationGeneration: 1, pageId: 'p' }, nativeSurfaces: [...SURFACES] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_arguments');
  const noEpoch = await bridge.attach({ protocol: 1, nativeSurfaces: [...SURFACES] });
  assert.equal(noEpoch.error.code, 'invalid_arguments');
  const app = makeApp();
  app.ready = false;
  const notReady = await new NativeUIBridge(makeDeps({ app }).deps).attach({ protocol: 1, epoch: { navigationGeneration: 1, pageId: 'p' }, nativeSurfaces: [...SURFACES] });
  assert.equal(notReady.error.code, 'not_ready');
  assert.equal(doc.__byId.get('mech-sel-bar').dataset.nativeOwned, undefined);
});

test('partial capability surfaces stay web-owned; all-incapable attach fails structured without hiding anything', async () => {
  const { deps, doc } = makeDeps();
  // Remove documentController -> fileCommands/inspector incapable.
  deps.app.documentController = null;
  const bridge = new NativeUIBridge(deps);
  const reply = await attachAll(bridge);
  assert.equal(reply.ok, true);
  assert.ok(!reply.ownedSurfaces.includes('fileCommands'));
  assert.ok(!reply.ownedSurfaces.includes('inspector'));
  assert.ok(reply.ownedSurfaces.includes('toolPalette'));
  const none = new NativeUIBridge(makeDeps().deps);
  none.surfaceCapable = () => false;
  const failed = await attachAll(none);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'unsupported');
});

test('repeat attach with the same epoch returns the live snapshot without re-subscribing', async () => {
  const { deps } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const first = await attachAll(bridge);
  const controller = deps.app.controller;
  let emitWraps = 0;
  controller.emitSelection = function () { emitWraps++; };
  const second = await attachAll(bridge);
  assert.equal(second.ok, true);
  assert.deepEqual(second.epoch, first.epoch);
  assert.equal(second.sequence, first.sequence);
  assert.deepEqual(second.ownedSurfaces, first.ownedSurfaces);
  assert.equal(second.state.revision, first.state.revision);
});

test('dispatch rejects stale epoch and unknown commands without touching the engine', async () => {
  const { deps } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const stale = await bridge.dispatch({ protocol: 1, epoch: { navigationGeneration: 7, pageId: 'other' }, requestId: 'r1', id: 'zoom.by', args: { factor: 1.25 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_epoch');
  const unknown = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'r2', id: 'file.save', args: {} });
  assert.equal(unknown.error.code, 'unsupported');
  assert.equal(deps.app.controller.adapter.ed.toolCalls.length, 0);
});

test('repeated requestId never re-applies a mutation (idempotency)', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const controller = app.controller;
  const arrow = { geometry: { bend: 0.5, mode: 'auto' }, source: null, target: null };
  controller.selectedArrows = () => [arrow];
  controller.model.arrow = () => arrow;
  controller.selection = new Set(['a']);
  bridge.noteSelectionChange();
  const revision = bridge.selectionRevision;
  const cmd = { protocol: 1, epoch: { ...bridge.epoch }, requestId: 'same-1', id: 'selection.setProperty', expectedSelectionRevision: revision, args: { propertyId: 'bend', value: 1.2 } };
  const first = await bridge.dispatch(cmd);
  assert.equal(first.ok, true);
  assert.equal(makeApp.bendCalls, 1);
  const repeat = await bridge.dispatch(cmd);
  assert.equal(repeat.ok, true);
  assert.deepEqual(repeat, first);
  assert.equal(makeApp.bendCalls, 1, 'mutation must not run twice');
  // In-flight dedupe: issue the same requestId twice concurrently against the
  // post-commit selection revision.
  makeApp.bendCalls = 0;
  const current = first.result.selectionRevision;
  const pending = bridge.dispatch({ ...cmd, requestId: 'same-2', expectedSelectionRevision: current, args: { propertyId: 'bend', value: -1 } });
  const pending2 = bridge.dispatch({ ...cmd, requestId: 'same-2', expectedSelectionRevision: current, args: { propertyId: 'bend', value: -1 } });
  const [a, b] = await Promise.all([pending, pending2]);
  assert.equal(a, b);
  assert.equal(makeApp.bendCalls, 1);
});

test('selection property command without/with wrong expectedSelectionRevision is rejected', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const arrow = { geometry: { bend: 0 }, source: null, target: null };
  app.controller.selectedArrows = () => [arrow];
  app.controller.model.arrow = () => arrow;
  app.controller.selection = new Set(['ar1']);
  bridge.noteSelectionChange();
  const missing = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 's1', id: 'selection.setProperty', args: { propertyId: 'bend', value: 1 } });
  assert.equal(missing.error.code, 'invalid_arguments');
  const stale = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 's2', id: 'selection.setProperty', expectedSelectionRevision: 99999, args: { propertyId: 'bend', value: 1 } });
  assert.equal(stale.error.code, 'stale_selection');
  assert.equal(makeApp.bendCalls, 0);
});

test('late property command after selection change returns stale_selection and fresh state on re-read', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const before = bridge.getState().selection.revision;
  app.controller.selection = new Set(['x']); // membership change
  bridge.noteSelectionChange();
  const after = bridge.getState().selection.revision;
  assert.ok(after > before);
  const late = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'late-1', id: 'selection.setProperty', expectedSelectionRevision: before, args: { propertyId: 'bend', value: 1 } });
  assert.equal(late.error.code, 'stale_selection');
});

test('radical is a persistent tool.set: no selection required, controller.setTool called, selection revision irrelevant', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  // 选区随后变化：radical 作为持久工具不受选区 revision 约束。
  app.controller.selection = new Set(['changed']);
  bridge.noteSelectionChange();
  const ok = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'radical-tool', id: 'tool.set', args: { id: 'radical' } });
  assert.equal(ok.ok, true);
  assert.equal(app.controller.tool, 'radical');
  // 旧版本要求的 expectedSelectionRevision 现在被忽略：不带也能成功。
  assert.equal(bridge.getState().tool.id, 'radical');
});

test('slider release maps to exactly one setBendForSelection commit and one selectionRevision bump', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const arrow = { geometry: { bend: 0.2 }, source: null, target: null };
  app.controller.selectedArrows = () => [arrow];
  app.controller.model.arrow = () => arrow;
  app.controller.selection = new Set(['ar1']);
  bridge.noteSelectionChange();
  const revision = bridge.selectionRevision;
  const reply = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'bend-1', id: 'selection.setProperty', expectedSelectionRevision: revision, args: { propertyId: 'bend', value: 1.44 } });
  assert.equal(reply.ok, true);
  assert.equal(makeApp.bendCalls, 1);
  assert.ok(reply.result.selectionRevision > revision);
});

test('host.context validates viewport shape and only accepts strictly newer layoutRevision', async () => {
  const { deps } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const bad = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'h1', id: 'host.context', args: { windowKey: true, focusOwner: 'canvas', viewport: { layoutRevision: 1 } } });
  assert.equal(bad.error.code, 'invalid_arguments');
  const v1 = { layoutRevision: 3, cssSize: { width: 800, height: 600 }, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 }, overlays: [{ id: 'toolPalette', x: 0, y: 0, width: 56, height: 400 }] };
  const ok1 = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'h2', id: 'host.context', args: { windowKey: true, focusOwner: 'canvas', inspectorVisible: true, viewport: v1 } });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.result.appliedHostLayoutRevision, 3);
  const older = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'h3', id: 'host.context', args: { viewport: { ...v1, layoutRevision: 2 } } });
  assert.equal(older.ok, true);
  assert.equal(older.result.appliedHostLayoutRevision, 3, 'older layout must not regress');
  const state = bridge.getState();
  assert.equal(state.viewport.appliedHostLayoutRevision, 3);
  assert.equal(state.host.windowKey, true);
  assert.deepEqual(deps.viewport.hostViewport.safeAreaInsets, v1.safeAreaInsets);
});

test('host layout changes recompute paper bounds even when the editor does not resize', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const paper = app.documentController, calls = [];
  paper.active = true; paper.state.mode = 'paper';
  paper.clampPaperViewport = () => calls.push('clamp');
  paper.render = () => calls.push('render');
  paper.emit = () => calls.push('emit');
  paper.fit = mode => calls.push('fit:' + mode);
  const viewport = { layoutRevision: 1, cssSize: { width: 800, height: 600 },
    safeAreaInsets: { top: 20, right: 0, bottom: 0, left: 0 }, overlays: [] };
  const layout = (requestId, revision) => bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId,
    id: 'host.context', args: { viewport: { ...viewport, layoutRevision: revision } } });
  assert.equal((await layout('paper-layout-1', 1)).ok, true);
  assert.deepEqual(calls, ['clamp', 'render', 'emit']);
  calls.length = 0;
  await layout('paper-layout-replay', 1);
  assert.deepEqual(calls, [], 'replayed native layouts do not move the viewport');
  paper.paperFitMode = 'width';
  assert.equal((await layout('paper-layout-2', 2)).ok, true);
  assert.deepEqual(calls, ['fit:width']);
  calls.length = 0; paper.state.mode = 'canvas';
  await layout('paper-layout-3', 3);
  assert.deepEqual(calls, [], 'native layouts do not constrain the infinite canvas');
});

test('zoom.by forwards to the shared viewport with host CSS px anchor', async () => {
  const { deps } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const ok = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'z1', id: 'zoom.by', args: { factor: 1.25, anchor: { x: 120, y: 300 } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(deps.viewport.zoomByCalls[0], [1.25, { x: 120, y: 300 }]);
  const bad = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'z2', id: 'zoom.by', args: { factor: -2 } });
  assert.equal(bad.error.code, 'invalid_arguments');
  deps.viewport.zoomOk = false;
  const blocked = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'z3', id: 'zoom.by', args: { factor: 1.25 } });
  assert.equal(blocked.error.code, 'failed');
});

test('zoom.toPercent stays paper-only; canvas returns unsupported', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const canvas = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'p1', id: 'zoom.toPercent', args: { percent: 100 } });
  assert.equal(canvas.error.code, 'unsupported');
  let paperZoom;
  app.documentController.active = true;
  app.documentController.state.mode = 'paper';
  app.documentController.getPaperZoom = () => 120;
  app.documentController.setPaperZoom = v => { paperZoom = v; };
  const paper = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'p2', id: 'zoom.toPercent', args: { percent: 150 } });
  assert.equal(paper.ok, true);
  assert.equal(paperZoom, 150);
});

test('edit commands are canvas-focus only and unsupported tools stay unsupported', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const apiCalls = [];
  const savedAPI = globalThis.k3dAPI;
  globalThis.k3dAPI = { undo: () => apiCalls.push('undo'), redo: () => apiCalls.push('redo'), selectAll: () => true, deleteSel: () => apiCalls.push('delete') };
  try {
    bridge.hostContext.focusOwner = 'nativeText';
    const text = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'e2', id: 'edit.delete', args: {} });
    assert.equal(text.ok, false);
    bridge.hostContext.focusOwner = 'canvas';
    const undo = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'e3', id: 'edit.undo', args: {} });
    assert.equal(undo.ok, true);
    assert.deepEqual(apiCalls, ['undo']);
    const tmpl = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 't1', id: 'tool.set', args: { id: 'template.benzene' } });
    assert.equal(tmpl.error.code, 'unsupported');
    const unknownTool = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 't2', id: 'tool.set', args: { id: 'magic.wand' } });
    assert.equal(unknownTool.error.code, 'unsupported');
  } finally { globalThis.k3dAPI = savedAPI; }
});

test('verified tool.set calls hit the real editor entry points with verified engine values', async () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const calls = app.controller.adapter.ed.toolCalls;
  await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'm1', id: 'tool.set', args: { id: 'bond.wedge' } });
  await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'm2', id: 'tool.set', args: { id: 'lasso' } });
  await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'm3', id: 'element.set', args: { symbol: 'Br' } });
  await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'm4', id: 'element.set', args: { symbol: 'Xx' } });
  assert.deepEqual(calls[0], ['bond', { type: 1, stereo: 1 }]);
  assert.deepEqual(calls[1], ['select', 'lasso']);
  assert.deepEqual(calls[2], ['atom', { label: 'Br' }]);
  assert.equal(calls.length, 3, 'unverified element must not reach the engine');
  const badElement = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'm5', id: 'element.set', args: { symbol: 'Xx' } });
  assert.equal(badElement.error.code, 'unsupported');
});

test('native geometry tools expose no-selection defaults and selected fill/radius commits through the document shape layer', async () => {
  const { deps, app } = makeDeps();
  const dc = app.documentController;
  dc.state = { mode: 'canvas', ptPerBond: 14.4 };
  dc.shapeStyle = { fill: 'none', fillColor: '#ffffff', stroke: { color: '#3b5665', width: 0.05, dash: 'solid' } };
  dc.active = false; // A fresh canvas activates its document layer on the first object.
  dc.setTool = function (tool) { this.tool = tool; this.active = true; this.emit(); };
  dc.select = function (ids) {
    this.selection = new Set(ids || []);
    app.controller.selection.clear();
    this.emit();
    return [...this.selection];
  };
  dc.setShapeStyle = function (patch) {
    this.shapeStyle = { ...this.shapeStyle, ...patch, stroke: { ...this.shapeStyle.stroke, ...(patch.stroke || {}) } };
    this.emit('shape-style');
  };
  let shape = { id: 'shape-one', kind: 'shape', band: 'back', x: 2, y: 3, w: 8, h: 5, shape: 'rect', fill: 'none', fillColor: '#ffffff', stroke: { color: '#3b5665', width: .05, dash: 'solid' } };
  dc.object = id => id === shape.id ? shape : null;
  dc.updateObject = (id, patch) => { shape = { ...shape, ...patch, stroke: { ...shape.stroke, ...(patch.stroke || {}) } }; };
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);

  const toolReply = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-tool-rect', id: 'tool.set', args: { id: 'shape.rect' } });
  assert.equal(toolReply.ok, true);
  assert.equal(dc.tool, 'rect');
  assert.equal(app.controller.adapter.ed.toolCalls.some(([name]) => name === 'simpleobject'), false, 'native rectangle routes to the editable document shape layer');
  assert.equal(bridge.toolState().id, 'shape.rect');
  let selection = bridge.buildSelection();
  assert.equal(selection.count, 0);
  assert.equal(selection.label, '形状样式');
  assert.ok(selection.properties.some(prop => prop.id === 'shapeStyle.stroke.color' && prop.type === 'text'));
  assert.ok(selection.properties.some(prop => prop.id === 'shapeStyle.fill.mode' && prop.type === 'choice'));
  assert.ok(selection.properties.some(prop => prop.id === 'shapeStyle.cornerRadius' && prop.label.includes('(pt)')));

  const defaultColor = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-default-color', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'shapeStyle.stroke.color', value: '#b13d74' } });
  assert.equal(defaultColor.ok, true);
  assert.equal(dc.shapeStyle.stroke.color, '#b13d74');
  const defaultRadius = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-default-radius', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'shapeStyle.cornerRadius', value: 14.4 } });
  assert.equal(defaultRadius.ok, true);
  assert.equal(dc.shapeStyle.cornerRadius, 1, 'inspector pt converts to document bond units');

  dc.selection = new Set([shape.id]);
  selection = bridge.buildSelection();
  assert.ok(selection.properties.some(prop => prop.id === 'fill.mode'));
  assert.ok(selection.properties.some(prop => prop.id === 'fillColor'));
  assert.ok(selection.properties.some(prop => prop.id === 'cornerRadius'));
  const noFill = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-no-fill', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'fill.mode', value: 'none' } });
  assert.equal(noFill.ok, true);
  assert.equal(shape.fill, 'none');
  const fillColor = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-fill-color', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'fillColor', value: '#2a78c5' } });
  assert.equal(fillColor.ok, true);
  assert.equal(shape.fill, 'none', 'changing retained fill colour does not turn fill back on');
  assert.equal(shape.fillColor, '#2a78c5');
  const filled = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-fill-on', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'fill.mode', value: 'filled' } });
  assert.equal(filled.ok, true);
  assert.equal(shape.fill, '#2a78c5');
  const legacyFill = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-legacy-fill', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'fill', value: '#c2185b' } });
  assert.equal(legacyFill.ok, true, JSON.stringify(legacyFill));
  assert.equal(shape.fill, '#c2185b');
  assert.equal(shape.fillColor, '#c2185b', 'legacy fill setter stays consistent with the renderer fillColor field');
  const legacyNoFill = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-legacy-no-fill', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'fill', value: 'none' } });
  assert.equal(legacyNoFill.ok, true);
  assert.equal(shape.fill, 'none');
  assert.equal(shape.fillColor, '#c2185b', 'legacy no-fill keeps the last picker color for later use');
  const radius = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-selected-radius', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'cornerRadius', value: 7.2 } });
  assert.equal(radius.ok, true);
  assert.equal(shape.cornerRadius, .5);
  shape = { ...shape, shape: 'line' };
  assert.equal(bridge.buildSelection().properties.some(prop => prop.id === 'cornerRadius'), false, 'line shapes do not expose corner radius');

  // Switching back to a drawing tool clears the previous document and
  // mechanism selection without touching the selected object's saved style.
  dc.selection = new Set([shape.id]);
  app.controller.selection.add('previous-mechanism-selection');
  const selectedStroke = shape.stroke.color;
  const reselectTool = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-tool-again', id: 'tool.set', args: { id: 'shape.rect' } });
  assert.equal(reselectTool.ok, true);
  selection = bridge.buildSelection();
  assert.equal(selection.count, 0, 'choosing a shape tool clears stale document and chemistry selections');
  assert.equal(selection.label, '形状样式');
  assert.ok(selection.properties.some(prop => prop.id === 'shapeStyle.stroke.color'));
  const defaultStrokeOnDrawingTool = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-default-after-clear', id: 'selection.setProperty', expectedSelectionRevision: bridge.selectionRevision, args: { propertyId: 'shapeStyle.stroke.color', value: '#6f2479' } });
  assert.equal(defaultStrokeOnDrawingTool.ok, true, 'defaults remain editable after selecting a drawing tool');
  assert.equal(shape.stroke.color, selectedStroke, 'changing the next-shape default leaves the previous shape style intact');

  for (const [id, tool, hasFill, hasRadius] of [
    ['document.roundRect', 'roundRect', true, true], ['shape.ellipse', 'ellipse', true, false],
    ['shape.line', 'line', false, false], ['document.arrow', 'arrow', false, false],
    ['document.polygon', 'polygon', true, false], ['document.bracket', 'bracket', false, false]
  ]) {
    const selected = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'shape-tool-' + tool, id: 'tool.set', args: { id } });
    assert.equal(selected.ok, true, 'native shape drawing tool is selectable: ' + tool);
    assert.equal(dc.tool, tool);
    const props = bridge.buildSelection().properties;
    assert.equal(props.some(prop => prop.id === 'shapeStyle.fill.mode'), hasFill, tool + ' exposes fill only when applicable');
    assert.equal(props.some(prop => prop.id === 'shapeStyle.cornerRadius'), hasRadius, tool + ' exposes radius only for rectangular shapes');
  }
});

test('mechanism tools route through the verified semantic entry point', async () => {
  const { deps, app } = makeDeps();
  const savedAPI = globalThis.k3dAPI;
  globalThis.k3dAPI = { setMechanismTool: t => { app.controller.setTool(t); } };
  try {
    const bridge = new NativeUIBridge(deps);
    await attachAll(bridge);
    const reply = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'me1', id: 'tool.set', args: { id: 'fishhookArrow' } });
    assert.equal(reply.ok, true);
    assert.equal(app.controller.tool, 'arrow1');
  } finally { globalThis.k3dAPI = savedAPI; }
});

test('agent.settings.load publishes only public fields; apiKey stays transient', async () => {
  const agentAPI = {
    isRunning: () => false,
    pendingStart: () => false,
    getRuntime: () => ({}),
    send() {}, stop() {}, continue() {}, reset() {},
    loadSettings: async () => ({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'test-model', configured: true, sessionToken: 'secret-token', apiKey: 'sk-internal' }),
    saveSettings: async values => ({ config: { configured: true, model: values.model, sessionToken: 'new-secret' }, notice: 'ok' })
  };
  const { deps } = makeDeps({ agent: agentAPI });
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const loaded = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'a1', id: 'agent.settings.load', args: {} });
  assert.equal(loaded.ok, true);
  const json = JSON.stringify(loaded);
  assert.equal(json.includes('secret-token'), false, 'sessionToken must be filtered');
  assert.equal(json.includes('sk-internal'), false, 'apiKey must be filtered');
  const saved = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'a2', id: 'agent.settings.save', args: { provider: 'openai-compatible', model: 'm2', baseUrl: 'http://x', apiKey: 'sk-user-secret', generation: { profile: 'deepseek', effort: 'low', maxOutputTokens: 4096 } } });
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes('sk-user-secret'), false, 'apiKey never echoed back');
  assert.equal(JSON.stringify(saved).includes('new-secret'), false);
  assert.equal(bridge.getState().agent.settingsBusy, false);
});

test('agent.send returns accepted fast and stop/continue honour state', async () => {
  let sent;
  const agentAPI = {
    isRunning: () => false, pendingStart: () => false, getRuntime: () => ({}),
    send: t => { sent = t; }, stop: reason => { agentAPI.lastStop = reason; }, continue() {}, reset() {},
    loadSettings: async () => ({}), saveSettings: async () => ({})
  };
  const { deps } = makeDeps({ agent: agentAPI });
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const sentReply = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'ag1', id: 'agent.send', args: { text: '画一个苯环' } });
  assert.equal(sentReply.ok, true);
  assert.deepEqual(sentReply.result, { accepted: true });
  assert.equal(sent, '画一个苯环');
  const stopReply = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'ag2', id: 'agent.stop', args: {} });
  assert.equal(stopReply.ok, true);
  assert.equal(agentAPI.lastStop, 'user');
  const cont = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'ag3', id: 'agent.continue', args: {} });
  assert.equal(cont.error.code, 'busy', 'cannot continue without canContinue');
  const reset = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'ag4', id: 'agent.reset', args: {} });
  assert.equal(reset.ok, true);
});

test('detach restores hidden web controls and rejects mismatched epochs', async () => {
  const { deps, doc } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const bar = doc.__byId.get('mech-sel-bar');
  assert.equal(bar.dataset.nativeOwned, '1');
  const wrong = bridge.detach({ navigationGeneration: 999, pageId: 'zzz' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'stale_epoch');
  assert.equal(bar.dataset.nativeOwned, '1', 'mismatched detach must not unhide');
  const ok = bridge.detach({ ...bridge.epoch });
  assert.equal(ok.ok, true);
  assert.equal(bar.style.display, '', 'web controls restored on real detach');
  assert.equal(bridge.getState(), null);
  const after = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'd1', id: 'zoom.by', args: { factor: 1.1 } });
  assert.equal(after.error.code, 'stale_epoch');
});

test('new navigation epoch rebinds: sequence restarts, old epoch dispatch dies, surfaces re-owned', async () => {
  const { deps, posts } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge, { navigationGeneration: 1, pageId: 'A' });
  bridge.markState();
  await new Promise(resolve => setTimeout(resolve, 160)); // one-frame coalescing + timer fallback
  const firstSeq = posts[posts.length - 1].sequence;
  assert.ok(firstSeq >= 1);
  await attachAll(bridge, { navigationGeneration: 2, pageId: 'B' });
  assert.deepEqual(bridge.epoch, { navigationGeneration: 2, pageId: 'B' });
  const old = await bridge.dispatch({ protocol: 1, epoch: { navigationGeneration: 1, pageId: 'A' }, requestId: 'x1', id: 'zoom.by', args: { factor: 1.2 } });
  assert.equal(old.error.code, 'stale_epoch');
  const next = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'x2', id: 'host.context', args: { windowKey: true, focusOwner: 'canvas' } });
  assert.equal(next.ok, true);
});

test('state snapshot avoids molwork serialization and reports editor-derived history', async () => {
  const { deps, app } = makeDeps();
  let serialized = 0;
  app.serializeWorkbench = async () => { serialized++; };
  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge);
  const state = bridge.getState();
  assert.deepEqual(state.history, { canUndo: true, canRedo: true });
  const paper = bridge.getState();
  assert.ok(paper.selection.revision >= 0);
  app.controller.adapter.ed.historySize = () => { throw new Error('no interface'); };
  const degraded = bridge.getState();
  assert.deepEqual(degraded.history, { canUndo: false, canRedo: false }, 'missing interface disables buttons, never guesses');
  assert.equal(serialized, 0);
});

test('selection kind/label/properties reflect mechanism objects with verified constraints', () => {
  const { deps, app } = makeDeps();
  const bridge = new NativeUIBridge(deps);
  const arrow = { geometry: { bend: -1.25, mode: 'manual' }, source: { type: 'bond', component: 'sigma' }, target: { type: 'atom' } };
  const lonePair = { ownerAtomId: 3 };
  app.controller.selection = new Set(['ar1']);
  app.controller.model.arrow = id => id === 'ar1' ? arrow : null;
  app.controller.model.lonePair = () => null;
  const sel = bridge.buildSelection();
  assert.equal(sel.kind, 'electronFlow');
  assert.equal(sel.count, 1);
  const bend = sel.properties.find(p => p.id === 'bend');
  assert.equal(bend.value, -1.25);
  assert.equal(bend.min, -2.4);
  assert.equal(bend.max, 2.4);
  assert.equal(bend.step, 0.02);
  const comp = sel.properties.find(p => p.id === 'bondComponent');
  assert.equal(comp.value, 'sigma');
  assert.deepEqual(comp.choices.map(c => c.value), ['sigma', 'pi']);
  // Mixed selection
  app.controller.selection = new Set(['ar1', 'lp1']);
  app.controller.model.lonePair = id => id === 'lp1' ? lonePair : null;
  assert.equal(bridge.buildSelection().kind, 'mixed');
});

test('Swift-style attach generates pageId, emits post-attach agent snapshot, posts direct UIState, and syncs Paper DocumentInfo/templates/runtime canContinue', async () => {
  let selection = { atoms: [], bonds: [] };
  const selListeners = new Set();
  const fakeRuntime = { canContinue: true };
  const agentAPI = {
    isRunning: () => false,
    pendingStart: () => false,
    getRuntime: () => fakeRuntime,
    send() {}, stop() {}, continue() { agentAPI.continued = true; }, reset() {},
    loadSettings: async () => ({ configured: true }),
    saveSettings: async () => ({ configured: true }),
    useNativeRenderer(renderer) { this.renderer = renderer; return true; },
    restoreBrowserRenderer() { return true; }
  };
  const changeListeners = new Set();
  const { deps, app, posts } = makeDeps({ agent: agentAPI });
  app.adapter.onChange = fn => { changeListeners.add(fn); return () => changeListeners.delete(fn); };
  app.controller.adapter.ed.selection = () => selection;
  app.controller.adapter.ed.event.selectionChange = {
    add(fn) { selListeners.add(fn); },
    remove(fn) { selListeners.delete(fn); },
    dispatch() { selListeners.forEach(fn => fn()); }
  };
  app.documentController.active = true;
  app.documentController.state = {
    mode: 'paper',
    pageCount: 2,
    pages: [{ id: 'p1' }, { id: 'p2' }],
    page: { size: 'A4', orientation: 'landscape', margins: { top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 } },
    objects: []
  };
  app.documentController.getPaperZoom = () => 125;
  const benzeneStruct = { name: 'Benzene', atoms: { size: 6 } };
  globalThis.molstudioNativeTemplates = {
    version: 1,
    list: () => [{ id: 'template-0', name: 'Benzene', struct: benzeneStruct }]
  };
  try {
    const bridge = new NativeUIBridge(deps);
    const reply = await bridge.attach({ protocol: 1, navigationGeneration: 9, nativeSurfaces: [...SURFACES], host: { windowKey: true, focusOwner: 'canvas', inspectorVisible: true } });
    assert.equal(reply.ok, true);
    assert.equal(reply.sequence, 0);
    assert.equal(reply.epoch.navigationGeneration, 9);
    assert.ok(reply.epoch.pageId && reply.epoch.pageId.length > 0);
    assert.equal(reply.state.document.mode, 'paper');
    assert.equal(reply.state.document.pageCount, 2);
    assert.equal(reply.state.document.size, 'A4');
    assert.equal(reply.state.document.orientation, 'landscape');
    assert.equal(reply.state.document.marginMm, 20);
    assert.equal(reply.state.document.canRemoveLastPage, true);
    assert.ok(reply.state.supported.commands.includes('template.set'));
    assert.ok(reply.state.supported.commands.includes('zoom.toPercent'));
    assert.ok(reply.state.supported.commands.includes('zoom.fit'));
    assert.deepEqual(reply.state.supported.templateIds, ['ring.benzene']);
    assert.equal(reply.state.agent.canContinue, true);

    await new Promise(resolve => setTimeout(resolve, 160));
    const snapMsg = posts.find(p => p.kind === 'agent' && p.payload.mode === 'snapshot');
    assert.ok(snapMsg && snapMsg.sequence >= 1, 'initial agent snapshot sent asynchronously after sequence 0');
    const stateMsg = posts.find(p => p.kind === 'state');
    assert.equal(stateMsg.payload.protocol, 1, 'state payload posts direct UIState object');

    const tmplOk = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'tpl-ok', id: 'template.set', args: { id: 'ring.benzene' } });
    assert.equal(tmplOk.ok, true);
    assert.deepEqual(app.controller.adapter.ed.toolCalls.at(-1), ['template', { struct: benzeneStruct }]);
    assert.equal(bridge.getState().tool.id, 'ring.benzene');

    const tmplBad = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'tpl-bad', id: 'template.set', args: { id: 'template.unknown' } });
    assert.equal(tmplBad.ok, false);
    assert.equal(tmplBad.error.code, 'unsupported');

    selection = { atoms: [101], bonds: [] };
    app.controller.adapter.ed.event.selectionChange.dispatch();
    const revA = bridge.getState().selection.revision;
    selection = { atoms: [202], bonds: [] };
    app.controller.adapter.ed.event.selectionChange.dispatch();
    const revB = bridge.getState().selection.revision;
    assert.ok(revB > revA, 'same-count selection change A -> B must bump selectionRevision');

    const contOk = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'cont-1', id: 'agent.continue', args: {} });
    assert.equal(contOk.ok, true);
    assert.equal(agentAPI.continued, true);

    // 1. Swift-style attach without pageId is idempotent within same navigationGeneration.
    const dupAttach = await bridge.attach({ protocol: 1, navigationGeneration: 9, nativeSurfaces: [...SURFACES], host: { windowKey: true, focusOwner: 'canvas', inspectorVisible: true } });
    assert.equal(dupAttach.ok, true);
    assert.deepEqual(dupAttach.epoch, reply.epoch, 'repeated Swift-style attach reuses bound epoch/pageId');
    assert.equal(dupAttach.sequence, bridge.sequence, 'idempotent re-attach returns live sequence without resetting channel');

    // 2. Same-count/same-ID document property edit & mechanism history edit bump selection.revision; zoom does not.
    selection = { atoms: [], bonds: [] };
    app.documentController.setPaperZoom = () => {};
    app.documentController.objects = [{ id: 'txt-1', type: 'text', w: 100, h: 40, rotation: 0, band: 'front' }];
    app.documentController.object = id => app.documentController.objects.find(o => o.id === id) || null;
    app.documentController.selection = new Set(['txt-1']);
    app.documentController.updateObject = (id, patch) => {
      const obj = app.documentController.object(id);
      if (obj) Object.assign(obj, patch);
    };
    bridge.noteSelectionChange();
    const revBeforeEdit = bridge.getState().selection.revision;
    const zoomOk = await bridge.dispatch({ protocol: 1, epoch: { ...bridge.epoch }, requestId: 'zoom-noop', id: 'zoom.toPercent', args: { percent: 130 } });
    assert.equal(zoomOk.ok, true);
    assert.equal(bridge.getState().selection.revision, revBeforeEdit, 'zoom must not bump selection.revision');
    const propOk = await bridge.dispatch({
      protocol: 1,
      epoch: { ...bridge.epoch },
      requestId: 'doc-edit-1',
      expectedSelectionRevision: revBeforeEdit,
      id: 'selection.setProperty',
      args: { propertyId: 'width', value: 145 }
    });
    assert.equal(propOk.ok, true);
    assert.ok(bridge.getState().selection.revision > revBeforeEdit, 'same-ID document update must bump selection.revision');

    // Mechanism adapter undo/history change also invalidates same-ID selection.revision.
    let undoCount = 0;
    app.adapter.ed.historySize = () => ({ undo: undoCount, redo: 0 });
    selection = { atoms: [202], bonds: [] };
    app.controller.adapter.ed.event.selectionChange.dispatch();
    const revBeforeHistory = bridge.getState().selection.revision;
    undoCount = 1;
    changeListeners.forEach(fn => fn());
    assert.ok(bridge.getState().selection.revision > revBeforeHistory, 'adapter.onChange + historySize change must bump selection.revision');
  } finally {
    delete globalThis.molstudioNativeTemplates;
  }
});

test('async agent.settings commands isolate epochs, stamp boundEpoch on stale_epoch, and scope requestId dedup per epoch', async () => {
  let resolveSlowLoad;
  const loadCalls = [];
  const slowAgent = {
    isRunning: () => false,
    pendingStart: () => false,
    send() {}, stop() {}, continue() {}, reset() {},
    loadSettings: () => new Promise(resolve => {
      loadCalls.push(loadCalls.length + 1);
      if (loadCalls.length === 1) { resolveSlowLoad = resolve; }
      else { resolve({ configured: true, model: 'epoch-2-model', baseUrl: 'https://b.invalid' }); }
    }),
    saveSettings: async values => ({ config: { configured: true, ...values } }),
    useNativeRenderer() { return true; },
    restoreBrowserRenderer() { return true; }
  };
  const { deps } = makeDeps({ agent: slowAgent });
  const bridge = new NativeUIBridge(deps);

  const attachA = await bridge.attach({ protocol: 1, navigationGeneration: 1, nativeSurfaces: [...SURFACES], host: { windowKey: true, focusOwner: 'canvas' } });
  const epochA = { ...attachA.epoch };

  // Start slow settings load in epoch A with requestId='req-settings-dup'
  const inflightA = bridge.dispatch({ protocol: 1, epoch: epochA, requestId: 'req-settings-dup', id: 'agent.settings.load', args: {} });

  // Detach epoch A and re-attach epoch B before slow settings load settles
  assert.equal(bridge.detach(epochA).ok, true);
  const attachB = await bridge.attach({ protocol: 1, navigationGeneration: 2, nativeSurfaces: [...SURFACES], host: { windowKey: true, focusOwner: 'canvas' } });
  const epochB = { ...attachB.epoch };
  assert.notEqual(epochA.pageId, epochB.pageId);

  // Dispatch same requestId='req-settings-dup' under epoch B: must NOT collide with epoch A in-flight or cache
  const replyB = await bridge.dispatch({ protocol: 1, epoch: epochB, requestId: 'req-settings-dup', id: 'agent.settings.load', args: {} });
  assert.equal(replyB.ok, true);
  assert.deepEqual(replyB.epoch, epochB);
  assert.equal(replyB.result.config.model, 'epoch-2-model');

  // Now resolve epoch A's slow load: reply must carry epochA and fail cleanly as stale_epoch
  resolveSlowLoad({ configured: true, model: 'epoch-1-stale', apiKey: 'sk-leak', sessionToken: 'tok-leak' });
  const replyA = await inflightA;
  assert.equal(replyA.ok, false);
  assert.equal(replyA.error.code, 'stale_epoch');
  assert.deepEqual(replyA.epoch, epochA, 'stale reply must preserve expired boundEpoch rather than leaking epoch B');
  assert.equal(JSON.stringify(replyA).includes('sk-leak'), false);
  assert.equal(JSON.stringify(replyA).includes('tok-leak'), false);
});

test('element.set returning null on selected atom keeps previous active tool, bumps selectionRevision, and never retries', async () => {
  const selectTool = { constructor: function SelectTool() {} };
  const bondTool = { constructor: function BondTool() {} };
  const atomTool = { constructor: function AtomTool() {} };
  let liveTool = selectTool;
  let selection = { atoms: [101], bonds: [] };
  const toolCalls = [];
  let atomCuts = 0;

  const { deps, app } = makeDeps();
  const ed = app.controller.adapter.ed;
  ed.selection = () => selection;
  ed.tool = function (name, opts) {
    if (arguments.length === 0) return liveTool;
    toolCalls.push([name, opts]);
    if (name === 'select') { liveTool = selectTool; return selectTool; }
    if (name === 'bond') { liveTool = bondTool; return bondTool; }
    if (name === 'atom') {
      // Ketcher AtomTool immediate mutation returns null and leaves active _tool unchanged when atoms are selected.
      if (selection.atoms.length > 0) {
        atomCuts += 1;
        selection = { atoms: [], bonds: [] };
        return null;
      }
      liveTool = atomTool;
      return atomTool;
    }
    return null;
  };

  const bridge = new NativeUIBridge(deps);
  await attachAll(bridge, { navigationGeneration: 15, pageId: 'elem-null' });

  // Switch first to bond.single (live BondTool active)
  const bondReply = await bridge.dispatch({
    protocol: 1,
    epoch: { ...bridge.epoch },
    requestId: 'elem-1',
    id: 'tool.set',
    args: { id: 'bond.single' }
  });
  assert.equal(bondReply.ok, true);
  assert.equal(bridge.getState().tool.id, 'bond.single');

  const revBefore = bridge.getState().selection.revision;

  // Immediate atom label replacement on selected atom: ed.tool('atom', { label: 'Br' }) returns null
  const brReply = await bridge.dispatch({
    protocol: 1,
    epoch: { ...bridge.epoch },
    requestId: 'elem-2',
    id: 'element.set',
    args: { symbol: 'Br' }
  });
  assert.equal(brReply.ok, true);
  assert.equal(atomCuts, 1, 'element.set must invoke ed.tool once without retrying on null');
  assert.deepEqual(
    toolCalls.filter(([name]) => name === 'atom'),
    [['atom', { label: 'Br' }]]
  );
  assert.equal(bridge.getState().tool.id, 'bond.single', 'null return from ed.tool(atom) must preserve active tool instead of falsely claiming element.Br');
  assert.ok(bridge.getState().selection.revision > revBefore, 'immediate element replacement must bump selectionRevision via noteCommittedEdit');

  // When nothing is selected, ed.tool('atom', { label: 'Cl' }) enters active AtomTool placement mode
  const clReply = await bridge.dispatch({
    protocol: 1,
    epoch: { ...bridge.epoch },
    requestId: 'elem-3',
    id: 'element.set',
    args: { symbol: 'Cl' }
  });
  assert.equal(clReply.ok, true);
  assert.equal(bridge.getState().tool.id, 'element.Cl');

  // If mechanism tool was active, element.set resets semantic tool to select before calling ed.tool
  app.controller.tool = 'arrow2';
  const fReply = await bridge.dispatch({
    protocol: 1,
    epoch: { ...bridge.epoch },
    requestId: 'elem-4',
    id: 'element.set',
    args: { symbol: 'F' }
  });
  assert.equal(fReply.ok, true);
  assert.equal(app.controller.tool, 'select');
  assert.equal(bridge.getState().tool.id, 'element.F');
});
