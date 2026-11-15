'use strict';
// Actual bridge transactions with a minimal native text action boundary. No UI,
// model requests, duplicated placement algorithm or production test hooks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
require('../workbench/workbench-storage.js');
const { createBridge } = require('../workbench/agent-bridge.js');
const MW = globalThis.MolWorkbench;
globalThis.k3dAPI = globalThis.k3dAPI || {};

function fixture(mode = 'paper') {
  const pools = ['atoms', 'bonds', 'frags', 'texts', 'rxnArrows', 'rxnPluses', 'simpleObjects', 'images'];
  const st = Object.fromEntries(pools.map(key => [key, new Map()]));
  const ctab = { molecule: st, texts: new Map(), atomsChanged: new Map(), bondsChanged: new Map() };
  let selection = { atoms: [], bonds: [] }, nextText = 0, zoom = 1, activePageIndex = 0;
  const ed = { historyStack: [], historyPtr: 0, struct: () => st,
    selection(value) { if (arguments.length) selection = value || {}; return selection; },
    render: { ctab, update() {}, setViewBox() {}, clientArea: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) } },
    update(action) { if (action !== true) { this.historyStack.push(action); this.historyPtr = this.historyStack.length; } } };
  const adapter = { ed, k: { setMolecule() {} }, struct: () => st,
    doc: { defaultView: { innerWidth: 100, innerHeight: 100, molstudioClipboard: {} }, querySelector: () => null },
    onChange: () => () => {}, syncIdentity() {}, atomPos: () => null, atomIdOf: () => null,
    bondIdOf: () => null, uuidOfAtom: () => null, uuidOfBond: () => null,
    chemSnapshot: () => ({ atoms: [], bonds: [] }), selection: () => ({ atoms: selection.atoms || [], bonds: selection.bonds || [], others: 0 }),
    offset: () => ({ x: 0, y: 0 }), zoom: () => zoom, canvasSvg: () => null,
    clientToModel: p => ({ x: p.x, y: p.y }), activeAtoms: new Set(), activeBonds: new Set() };
  for (const key of ['atomUuid', 'uuidAtom', 'atomSig', 'atomLast', 'bondUuid', 'uuidBond', 'bondSig', 'bondEndpoints']) adapter[key] = new Map();
  const model = new MW.model.MechanismModel();
  const controller = { selection: new Set(), ctx: () => ({}), refreshAutoSlots() {}, emitSelection() {}, render() {}, onDirtyHint() {},
    wrapNativeHistory: action => action };
  const state = MW.documentModel.createDocument({ mode, pageCount: 2 });
  const documentController = { active: true, state, selection: new Set(), getActivePage: () => MW.documentModel.pageRects(state)[activePageIndex] };
  const app = { adapter, model, controller, documentController };
  const textAction = (id, value) => ({ operations: [], isDummy: () => false, perform() {
    const prior = st.texts.get(id); if (value) st.texts.set(id, structuredClone(value)); else st.texts.delete(id);
    return textAction(id, prior);
  } });
  const native = { version: 1,
    serialize: () => JSON.stringify({ root: { nodes: [...st.texts].map(([id, text]) => ({ type: 'text', id,
      boundingBox: { x: text.position.x, y: text.position.y, width: 1, height: 1 }, content: text.content })) } }),
    createText(_ctab, text, point) { const id = nextText++; st.texts.set(id, { content: text, position: { x: point.x, y: point.y } }); return textAction(id, null); } };
  const bridge = createBridge(app, { native });
  return { bridge, ed, st, controller, adapter, documentController, native, model,
    paper: MW.documentModel.pageRects(state)[0].content,
    moveViewport: () => { zoom = .3; activePageIndex = 1; }, select: () => { selection = { atoms: [], bonds: [], texts: [0] }; documentController.selection.add('transient-selection'); } };
}
const bounds = text => ({ width: Math.max(.6, [...text].reduce((n, c) => n + (/^[\x20-\x7e]$/.test(c) ? .23 : .45), 0)), height: Math.max(.8, text.split('\n').length * .55) });

test('native paste preview blocks AI access without consuming revisions or invalidating the current run', async () => {
  const f = fixture();
  try {
    await f.bridge.beginRun('before-preview');
    const before = await f.bridge.getContext();
    f.controller.nativePasteSession = { token: 'pending' };
    f.st.texts.set(99, { content: 'Temporary native preview', position: { x: 10, y: 10 } });
    f.ed.update(true); await Promise.resolve();
    assert.throws(() => f.bridge.getContext(), error => error.code === 'edit_in_progress');
    assert.throws(() => f.bridge.beginRun('must-not-replace-active'), error => error.code === 'edit_in_progress');
    await assert.rejects(f.bridge.applyOperations([{ id: 'blocked', type: 'text.add', text: 'Blocked' }], { runId: 'before-preview' }), error => error.code === 'edit_in_progress');
    f.st.texts.delete(99); f.controller.nativePasteSession = null;
    f.ed.update(true); await Promise.resolve();
    const after = await f.bridge.getContext();
    assert.equal(after.revision, before.revision); assert.equal(after.sessionId, before.sessionId);
    await f.bridge.applyOperations([{ id: 'after-cancel', type: 'text.add', text: 'Continued' }], { runId: 'before-preview' });
    assert.equal(f.st.texts.size, 1); assert.equal(f.ed.historyPtr, 1);
  } finally { f.bridge.dispose(); }
});

test('ordinary native paste without a sidecar has the same AI and revision fence', async () => {
  const f = fixture(), clipboard = f.adapter.doc.defaultView.molstudioClipboard;
  try {
    await f.bridge.beginRun('ordinary-paste'); const before = await f.bridge.getContext();
    clipboard.nativePreviewActive = true;
    f.st.texts.set(99, { content: 'External native preview', position: { x: 10, y: 10 } });
    f.ed.update(true); await Promise.resolve();
    assert.equal(f.controller.nativePasteSession, undefined);
    assert.throws(() => f.bridge.getContext(), error => error.code === 'edit_in_progress');
    await assert.rejects(f.bridge.applyOperations([{ id: 'blocked', type: 'text.add', text: 'Blocked' }], { runId: 'ordinary-paste' }), error => error.code === 'edit_in_progress');
    f.st.texts.delete(99); clipboard.nativePreviewActive = false; f.ed.update(true); await Promise.resolve();
    assert.equal((await f.bridge.getContext()).revision, before.revision);
    await f.bridge.applyOperations([{ id: 'after-cancel', type: 'text.add', text: 'Continued' }], { runId: 'ordinary-paste' });
    assert.equal(f.ed.historyPtr, 1);
  } finally { f.bridge.dispose(); }
});

test('automatic wide text that fits A4 is anchored inside the printable rectangle', async () => {
  const f = fixture(), text = 'A'.repeat(100), size = bounds(text);
  try {
    assert.ok(size.width < f.paper.w, 'the complete line fits the content width');
    await f.bridge.beginRun('wide-note');
    await f.bridge.applyOperations([{ id: 'wide', type: 'text.add', text }], { runId: 'wide-note' });
    const point = [...f.st.texts.values()][0].position;
    assert.ok(point.x >= f.paper.x && point.x + size.width <= f.paper.x + f.paper.w + 1e-8);
    assert.ok(point.y >= f.paper.y && point.y + size.height <= f.paper.y + f.paper.h + 1e-8);
    assert.equal(f.ed.historyPtr, 1);
  } finally { f.bridge.dispose(); }
});
test('a genuine paper overflow rolls back every text action and the exact history', async () => {
  const f = fixture();
  try {
    await f.bridge.beginRun('too-wide'); const before = f.native.serialize();
    await assert.rejects(f.bridge.applyOperations([{ id: 'first', type: 'text.add', text: 'Keep this transactional' },
      { id: 'overflow', type: 'text.add', text: 'A'.repeat(200) }], { runId: 'too-wide' }), error => error.code === 'paper_region_full');
    assert.equal(f.native.serialize(), before); assert.equal(f.st.texts.size, 0);
    assert.equal(f.ed.historyPtr, 0); assert.deepEqual(f.ed.historyStack, []);
    assert.equal((await f.bridge.getContext()).revision, 0);
  } finally { f.bridge.dispose(); }
});
test('explicit paper text and ordinary canvas text retain their existing anchor semantics', async () => {
  for (const mode of ['paper', 'canvas']) {
    const f = fixture(mode);
    try {
      await f.bridge.beginRun('explicit-' + mode);
      await f.bridge.applyOperations([{ id: 'text', type: 'text.add', text: 'A'.repeat(60), x: 5, y: 12 }], { runId: 'explicit-' + mode });
      assert.deepEqual([...f.st.texts.values()][0].position, { x: 5, y: 12 });
    } finally { f.bridge.dispose(); }
  }
});
test('viewport and selection changes do not advance the authored signature or interrupt an active run', async () => {
  const f = fixture();
  try {
    await f.bridge.beginRun('navigation'); const before = await f.bridge.getContext();
    f.moveViewport(); f.select(); const navigated = await f.bridge.getContext();
    assert.equal(navigated.revision, before.revision); assert.equal(navigated.sessionId, before.sessionId);
    assert.notEqual(navigated.document.activePageId, before.document.activePageId);
    await f.bridge.applyOperations([{ id: 'after-navigation', type: 'text.add', text: 'Still editable' }], { runId: 'navigation' });
    assert.equal(f.ed.historyPtr, 1);
  } finally { f.bridge.dispose(); }
});
test('paper curve checks use the painted quadratic extrema and reject a real excursion transactionally', async () => {
  const f = fixture();
  try {
    const arrow = MW.model.makeArrow({ type: 'free', x: 10, y: 10 }, { type: 'free', x: 20, y: 10 }, { bend: 0, mode: 'manual' });
    f.model.addArrow(arrow);
    await f.bridge.beginRun('curve-bounds');
    // The control point is at y=0, outside the content rectangle, while the
    // actual quadratic remains at y>=5. It must not be rejected as overflow.
    await f.bridge.applyOperations([{ id: 'inside-curve', type: 'arrow.modify', arrowId: arrow.id, bend: -1, mode: 'manual' }], { runId: 'curve-bounds' });
    assert.equal(f.model.arrow(arrow.id).geometry.bend, -1); assert.equal(f.ed.historyPtr, 1);
    const before = JSON.stringify(f.model.state), revision = (await f.bridge.getContext()).revision;
    // Its endpoints stay at y=10, but the new curve reaches y=3 and genuinely
    // leaves the printable rectangle. Endpoints alone would miss this case.
    await assert.rejects(f.bridge.applyOperations([{ id: 'outside-curve', type: 'arrow.modify', arrowId: arrow.id, bend: -1.4, mode: 'manual' }], { runId: 'curve-bounds' }), error => error.code === 'paper_region_full');
    assert.equal(JSON.stringify(f.model.state), before); assert.equal(f.ed.historyPtr, 1);
    assert.equal((await f.bridge.getContext()).revision, revision);
  } finally { f.bridge.dispose(); }
});
