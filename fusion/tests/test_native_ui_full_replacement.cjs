'use strict';
/* Native UI full replacement — source-level regression for the new real
 * commands, first-frame canvas mode and "no web-toolbar fallback" rules.
 * No model calls, no GUI, no Ketcher distribution required (fast unit layer).
 * The real-editor structural checks live in test_native_ui_real.cjs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeUIBridge, PROTOCOL } = require('../workbench/native-ui-bridge');
require('../agent/native-renderer');

function fakeEditor() {
  const tools = [];
  return {
    tools,
    tool(name, opts) {
      if (arguments.length === 0) return { constructor: function T() {} };
      tools.push([name, opts]);
      return { constructor: function T() {} };
    },
    selection: () => ({ atoms: [], bonds: [] }),
    historySize: () => ({ undo: 1, redo: 0 }),
    event: { zoomChanged: { add() {}, remove() {} }, selectionChange: { add() {}, remove() {} } },
    render: { ctab: { molecule: { atoms: new Map() } } }
  };
}

function setup(opts = {}) {
  const ed = fakeEditor();
  const docObject = opts.object || { id: 'obj-1', kind: 'shape', x: 1, y: 2, w: 8, h: 5, rotation: 0,
    band: 'back', shape: 'rect', fill: 'none', stroke: { color: '#3b5665', width: 0.05, dash: 'solid' } };
  const calls = { tool: [], updateObject: [], addText: [], addShape: [], addImage: [],
    setPageSetup: [], addPage: [], removePage: [], importFile: [], exportPages: [],
    duplicate: 0, delete: 0, editText: [], setTool: [], fitPage: 0, init: [] };
  const controller = {
    tool: 'select', selection: new Set(),
    model: { arrow: () => null, lonePair: () => null },
    setTool(t) { this.tool = t; }, emitSelection() {}, selectedArrows: () => [],
    setBendForSelection() {}, toggleBondComponent() {}, replanSelection() {},
    refreshAutoSlots() {}, render() {}, onDirtyHint() {},
    adapter: { ed, doc: { defaultView: { molstudioNativeStructOps: { version: 1, atomAttr: function () {},
      recalc() {} } }, querySelectorAll: () => [] }, struct: () => ({ atoms: new Map(), bonds: new Map() }) }
  };
  const documentController = {
    active: !!opts.active, state: { mode: opts.mode || 'canvas',
      page: { size: 'A4', orientation: 'portrait', margins: { top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 } },
      pages: [{ id: 'p1' }, { id: 'p2' }], objects: [docObject], assets: {} },
    selection: new Set([docObject.id]), tool: 'select',
    object(id) { return id === docObject.id ? docObject : null; },
    getState() { return JSON.parse(JSON.stringify(this.state)); },
    subscribe: () => () => {}, emit() {},
    setTool(t) { this.tool = t; calls.setTool.push(t); },
    updateObject(id, patch) { calls.updateObject.push([id, patch]); Object.assign(docObject, patch); return true; },
    addText(o) { calls.addText.push(o); return 'text-1'; },
    addShape(o) { calls.addShape.push(o); return 'shape-1'; },
    async addImage(o) { calls.addImage.push(o); return 'image-1'; },
    setPageSetup(o) { calls.setPageSetup.push(o); },
    addPage() { calls.addPage.push(true); return 'p3'; },
    removePage(id) { calls.removePage.push(id); },
    async importFile(text, options) { calls.importFile.push([text, options]); return { ok: true, staged: true }; },
    async exportPages(ids) { calls.exportPages.push(ids); return { ok: true, pages: [], warnings: [] }; },
    duplicateSelection() { calls.duplicate++; return ['obj-2']; },
    deleteSelection() { calls.delete++; },
    editText(id) { calls.editText.push(id); },
    fitPage() { calls.fitPage++; },
    init(o) { calls.init.push(o); this.active = true; },
    getPaperZoom: () => 100, setPaperZoom() {}, fitWidth() {},
    bounds: o => ({ x: o.x, y: o.y, w: o.w, h: o.h })
  };
  const app = { ready: true, controller, documentController, adapter: controller.adapter };
  const byId = new Map();
  const topDoc = {
    documentElement: { getAttribute: () => null, setAttribute() {} },
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; }
  };
  const bridge = new NativeUIBridge({ app, doc: topDoc, viewport: { zoomBy: () => true, effectiveRect: () => null } });
  return { bridge, app, calls, ed, docObject, topDoc };
}

async function attach(bridge, epoch = { navigationGeneration: 7, pageId: 'p' }) {
  return bridge.attach({ protocol: PROTOCOL, epoch,
    nativeSurfaces: ['fileCommands', 'toolPalette', 'zoomPalette', 'inspector', 'agent'],
    host: { windowKey: true, focusOwner: 'canvas' } });
}

function command(bridge, id, args = {}, extra = {}) {
  return bridge.dispatch({ protocol: PROTOCOL, epoch: bridge.epoch, requestId: 'r-' + Math.random().toString(36).slice(2), id, args, ...extra });
}

test('first-frame canvas mode: legacy web surfaces are never restored', async () => {
  const { bridge, topDoc } = setup();
  const el = { style: { display: '' }, dataset: {} };
  byIdSet(topDoc, 'molstudio-document-toolbar', el);
  globalThis.MolStudioNativeCanvas = { active: true, navigationGeneration: 7 };
  try {
    await attach(bridge);
    assert.equal(bridge.setAdvancedWebTools(true), false, 'advanced web tools switch must be retired');
    bridge.hideWebSurfaces(bridge.ownedSurfaces);
    assert.equal(el.dataset.nativeOwned, '1');
    bridge.restoreWebSurfaces();
    assert.equal(el.dataset.nativeOwned, '1', 'detach must not un-own legacy surfaces');
    // A late detach callback cannot reveal the old UI either.
    assert.equal(bridge.setAdvancedWebTools(false), false);
    bridge.detach(bridge.epoch);
    assert.equal(el.dataset.nativeOwned, '1');
  } finally { delete globalThis.MolStudioNativeCanvas; }
});

test('browser mode keeps legacy attach/detach behaviour', async () => {
  const { bridge, topDoc } = setup();
  const el = { style: { display: '' }, dataset: {} };
  byIdSet(topDoc, 'molstudio-document-toolbar', el);
  await attach(bridge);
  bridge.hideWebSurfaces(bridge.ownedSurfaces);
  bridge.restoreWebSurfaces();
  assert.equal(el.dataset.nativeOwned, undefined);
  assert.equal(bridge.setAdvancedWebTools(false), true);
});

function byIdSet(topDoc, id, value) {
  if (!topDoc.__map) { topDoc.__map = new Map(); topDoc.getElementById = k => topDoc.__map.get(k) || null; }
  topDoc.__map.set(id, value);
}

test('supported() advertises the full real command/tool surface', async () => {
  const { bridge } = setup();
  await attach(bridge);
  const s = bridge.getState().supported;
  for (const c of ['document.tool', 'document.addImage', 'document.addText', 'document.addShape',
    'document.object.update', 'document.object.duplicate', 'document.object.delete',
    'document.object.editText', 'document.page.setup', 'document.page.add',
    'document.page.removeLastBlank', 'document.importFile', 'document.exportPages', 'document.state']) {
    assert.ok(s.commands.includes(c), 'missing command ' + c);
  }
  for (const t of ['equilibriumArrow', 'resonanceArrow', 'retrosyntheticArrow',
    'document.bracket', 'document.arrow', 'document.polygon', 'document.roundRect', 'ketcher.image']) {
    assert.ok(s.toolIds.includes(t), 'missing tool ' + t);
  }
  for (const e of ['He', 'Au', 'U', 'Si', 'A', '*']) assert.ok(s.elementSymbols.includes(e));
});

test('reaction arrow variants call the real editor with verified RxnArrowMode', async () => {
  const { bridge, ed } = setup();
  await attach(bridge);
  for (const [id, mode] of [['equilibriumArrow', 'equilibrium-open-angle'],
    ['resonanceArrow', 'elliptical-arc-arrow-open-angle'],
    ['retrosyntheticArrow', 'retrosynthetic']]) {
    const r = await command(bridge, 'tool.set', { id });
    assert.equal(r.ok, true, id + ' failed: ' + JSON.stringify(r.error));
    assert.deepEqual(ed.tools.at(-1), ['reactionarrow', mode]);
  }
  const img = await command(bridge, 'tool.set', { id: 'ketcher.image' });
  assert.equal(img.ok, true);
  assert.deepEqual(ed.tools.at(-1), ['images', undefined]);
});

test('document tools set a real controller tool (bracket / arrow / polygon / roundRect)', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  for (const [id, tool] of [['document.bracket', 'bracket'], ['document.arrow', 'arrow'],
    ['document.polygon', 'polygon'], ['document.roundRect', 'roundRect']]) {
    const r = await command(bridge, 'tool.set', { id });
    assert.equal(r.ok, true, id + ' failed: ' + JSON.stringify(r.error));
    assert.equal(calls.setTool.at(-1), tool);
  }
});

test('document.image no longer opens a web toolbar; addImage uses real bytes', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  const fallback = await command(bridge, 'tool.set', { id: 'document.image' });
  assert.equal(fallback.ok, false, 'must not pretend to be a native tool');
  const r = await command(bridge, 'document.addImage', {
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=', point: { x: 2, y: 3 }, w: 6, h: 4
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(calls.addImage[0].x, 2);
  assert.equal(calls.addImage[0].w, 6);
});

test('document text/shape/page/import/export are real controller calls', async () => {
  const { bridge, calls } = setup({ active: true, mode: 'paper' });
  await attach(bridge);
  assert.equal((await command(bridge, 'document.addText', { text: '标题', point: { x: 1, y: 2 } })).ok, true);
  assert.equal(calls.addText[0].text, '标题');
  assert.equal((await command(bridge, 'document.addShape', { shape: 'document.bracket', point: { x: 3, y: 4 } })).ok, true);
  assert.equal(calls.addShape[0].shape, 'bracket');
  assert.equal((await command(bridge, 'document.page.setup', { size: 'Letter', orientation: 'landscape', marginMm: 20 })).ok, true);
  assert.equal(calls.setPageSetup[0].size, 'Letter');
  assert.equal(calls.setPageSetup[0].orientation, 'landscape');
  assert.equal((await command(bridge, 'document.page.add')).ok, true);
  assert.equal(calls.addPage.length, 1);
  assert.equal((await command(bridge, 'document.page.removeLastBlank')).ok, true);
  assert.equal(calls.removePage[0], 'p2');
  assert.equal((await command(bridge, 'document.importFile', { text: '{"ket":{}}', name: 'a.ket' })).ok, true);
  assert.equal(calls.importFile.length, 1);
  assert.equal((await command(bridge, 'document.exportPages', { pageIds: ['p1'] })).ok, true);
  assert.deepEqual(calls.exportPages[0], ['p1']);
});

test('document object update/duplicate/delete/editText use real controller paths', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  assert.equal((await command(bridge, 'document.object.update', {
    objectId: 'obj-1', patch: { w: 10, rotation: 12, stroke: { color: '#ff0000' } }
  })).ok, true);
  assert.deepEqual(calls.updateObject[0][1], { w: 10, rotation: 12, stroke: { color: '#ff0000' } });
  assert.equal((await command(bridge, 'document.object.duplicate')).ok, true);
  assert.equal(calls.duplicate, 1);
  assert.equal((await command(bridge, 'document.object.delete')).ok, true);
  assert.equal(calls.delete, 1);
  assert.equal((await command(bridge, 'document.object.editText', { objectId: 'obj-1' })).ok, false,
    'shape object is not a text box');
});

test('document.state reflects selection and page setup without serialization', async () => {
  const { bridge } = setup({ active: true, mode: 'paper' });
  await attach(bridge);
  const r = await command(bridge, 'document.state');
  assert.equal(r.ok, true);
  assert.equal(r.result.active, true);
  assert.equal(r.result.mode, 'paper');
  assert.equal(r.result.pageCount, 2);
  assert.equal(r.result.selectedId, 'obj-1');
});

test('extended document properties commit once with selection revision', async () => {
  const { bridge, calls, docObject } = setup({ active: true });
  await attach(bridge);
  const state = bridge.getState();
  const props = state.selection.properties;
  for (const id of ['stroke.color', 'stroke.width', 'stroke.dash', 'fill.mode', 'fillColor', 'cornerRadius',
    'action.duplicate', 'action.delete']) assert.ok(props.some(p => p.id === id), 'missing ' + id);
  const r = await command(bridge, 'selection.setProperty',
    { propertyId: 'stroke.color', value: '#ff0000' },
    { expectedSelectionRevision: state.selection.revision });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(calls.updateObject.at(-1)[1], { stroke: { color: '#ff0000', width: 0.05, dash: 'solid' } });
  const stale = await command(bridge, 'selection.setProperty',
    { propertyId: 'stroke.width', value: 0.2 }, { expectedSelectionRevision: state.selection.revision - 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_selection');
  assert.equal(docObject.stroke.width, 0.05, 'stale commit must not mutate');
});

test('legacy fill command updates the visible fill colour as well as fill mode', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  const state = bridge.getState();
  const reply = await command(bridge, 'selection.setProperty',
    { propertyId: 'fill', value: '#ff0000' },
    { expectedSelectionRevision: state.selection.revision });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(calls.updateObject.at(-1)[1].fill, '#ff0000');
  assert.equal(calls.updateObject.at(-1)[1].fillColor, '#ff0000');
});

test('text object surfaces rich-text fields and commits real values', async () => {
  const obj = { id: 't-1', kind: 'text', x: 1, y: 1, w: 12, h: 3, rotation: 0, band: 'front',
    rich: { text: '你好', fontSize: 12, color: '#1c1c1e', align: 'left' } };
  const { bridge, calls } = setup({ active: true, object: obj });
  await attach(bridge);
  const state = bridge.getState();
  const ids = state.selection.properties.map(p => p.id);
  for (const id of ['rich.text', 'rich.fontSize', 'rich.color', 'rich.bold', 'rich.align', 'action.editText']) {
    assert.ok(ids.includes(id), 'missing ' + id);
  }
  const r1 = await command(bridge, 'selection.setProperty', { propertyId: 'rich.text', value: '反应机理' },
    { expectedSelectionRevision: state.selection.revision });
  assert.equal(r1.ok, true, JSON.stringify(r1.error));
  assert.equal(calls.updateObject.at(-1)[1].rich.text, '反应机理');
  const r2 = await command(bridge, 'document.object.editText', { objectId: 't-1' });
  assert.equal(r2.ok, true);
  assert.equal(calls.editText[0], 't-1');
});

test('image object surfaces crop fields and rejects out-of-range crop', async () => {
  const obj = { id: 'img-1', kind: 'image', x: 1, y: 1, w: 8, h: 8, rotation: 0, band: 'back',
    asset: 'a1', crop: { x: 0, y: 0, w: 1, h: 1 } };
  const { bridge } = setup({ active: true, object: obj });
  await attach(bridge);
  const state = bridge.getState();
  assert.ok(state.selection.properties.some(p => p.id === 'crop.w'));
  const bad = await command(bridge, 'selection.setProperty', { propertyId: 'crop.w', value: 2 },
    { expectedSelectionRevision: state.selection.revision });
  assert.equal(bad.ok, false);
  const good = await command(bridge, 'selection.setProperty', { propertyId: 'crop.w', value: 0.5 },
    { expectedSelectionRevision: state.selection.revision });
  assert.equal(good.ok, true, JSON.stringify(good.error));
});

test('duplicate requestId is idempotent across the new document commands', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  const c = { protocol: PROTOCOL, epoch: bridge.epoch, requestId: 'fixed-id', id: 'document.addText', args: { text: 'x' } };
  const [a, b] = await Promise.all([bridge.dispatch(c), bridge.dispatch(c)]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(calls.addText.length, 1, 'must apply a mutation only once');
});

test('stale epoch rejects new document commands', async () => {
  const { bridge, calls } = setup({ active: true });
  await attach(bridge);
  const r = await bridge.dispatch({ protocol: PROTOCOL,
    epoch: { navigationGeneration: 999, pageId: 'old' }, requestId: 'x', id: 'document.addText', args: { text: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'stale_epoch');
  assert.equal(calls.addText.length, 0);
});
