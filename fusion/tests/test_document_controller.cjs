'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
const { DocumentController } = require('../workbench/document-controller.js');
const MW = global.MolWorkbench;
class Vec { constructor(x, y) { this.x = x; this.y = y; } }
class NativeText {
  constructor(x, y) { this.position = new Vec(x, y); this.pos = [new Vec(x, y), new Vec(x + 2, y + 1)]; }
  clone() { const next = new NativeText(this.position.x, this.position.y); next.pos = this.pos.map(p => new Vec(p.x, p.y)); return next; }
}
function fixture() {
  const st = { atoms: new Map([[0, { pp: new Vec(1, 2) }]]), bonds: new Map(), texts: new Map([[0, new NativeText(3, 4)]]) };
  let selection = { atoms: [0], bonds: [], texts: [0] }, undo = [], redo = [];
  const ed = { render: { ctab: { markAtom() {}, markBond() {}, markItem() {} } }, struct: () => st,
    selection(value) { if (arguments.length) selection = value || {}; return selection; }, update() {} };
  const adapter = { ed, struct: () => st, atomPos: id => st.atoms.get(id)?.pp, uuidOfAtom: id => 'atom-' + id,
    atomIdOf: id => id === 'atom-0' ? 0 : null, clearSelection: () => ed.selection(null),
    modelPerPixel: () => .01, clientToModel: p => p, schedule() {},
    pushAction(back, forward) { undo.push({ back, forward }); redo = []; } };
  const model = new MW.model.MechanismModel();
  const mechanism = { model, tool: 'select', selection: new Set(), setTool() {}, emitSelection() {}, render() {}, pruneSelection() {},
    hasNativeSelection: () => Object.values(selection).some(a => Array.isArray(a) && a.length) };
  const c = new DocumentController({ adapter, mechanism, win: { molstudioNativeStructOps: { vec: Vec } }, doc: {}, iframe: {}, onStatus() {} });
  c.render = () => {};
  c.active = true;
  c.state.objects.push({ id: 'obj-note', kind: 'text', band: 'front', x: 5, y: 6, w: 10, h: 2, rotation: 0, rich: { text: 'note' } });
  c.selection.add('obj-note');
  return { c, st, model, selection, undo: () => { const action = undo.pop(); action.back(); redo.push(action); },
    redo: () => { const action = redo.pop(); action.forward(); undo.push(action); }, history: () => undo.length };
}
test('a mixed document, native text, atom and electron-flow move shares one reversible action', () => {
  const f = fixture(), arrow = MW.model.makeArrow({ type: 'free', x: 1, y: 1 }, { type: 'free', x: 3, y: 2 });
  f.model.addArrow(arrow); f.c.mechanism.selection.add(arrow.id);
  const nativeTextIdentity = f.st.texts.get(0);
  f.c.moveSelection(2, 3);
  assert.equal(f.history(), 1);
  assert.equal(f.st.texts.get(0), nativeTextIdentity, 'native identity stays valid for semantic step bindings');
  assert.deepEqual(f.st.atoms.get(0).pp, new Vec(3, 5));
  assert.deepEqual(f.st.texts.get(0).position, new Vec(5, 7));
  assert.deepEqual(f.st.texts.get(0).pos[1], new Vec(7, 8));
  assert.equal(f.c.object('obj-note').x, 7);
  assert.equal(f.model.arrow(arrow.id).source.x, 3);
  f.undo();
  assert.deepEqual(f.st.atoms.get(0).pp, new Vec(1, 2));
  assert.deepEqual(f.st.texts.get(0).position, new Vec(3, 4));
  assert.equal(f.c.object('obj-note').x, 5);
  assert.equal(f.model.arrow(arrow.id).source.x, 1);
  f.redo(); assert.equal(f.c.object('obj-note').x, 7); assert.deepEqual(f.st.texts.get(0).position, new Vec(5, 7));
});
test('sub-threshold pointer jitter changes neither mixed geometry nor history', () => {
  const f = fixture(), before = f.c.capture();
  f.c.drag = { kind: 'move', start: { x: 0, y: 0 }, before, moved: false };
  f.c.onMove({ clientX: .01, clientY: 0, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.drag.moved, false);
  assert.equal(f.history(), 0);
  assert.equal(f.c.object('obj-note').x, 5);
  assert.deepEqual(f.st.atoms.get(0).pp, new Vec(1, 2));
});
test('composition cannot produce a stale successful save or PDF snapshot', async () => {
  const f = fixture(); f.c.editor = { composing: true };
  assert.throws(() => f.c.export(), /输入法/);
  assert.throws(() => f.c.mutate(() => { throw new Error('must not run'); }), /输入法/);
  const result = await f.c.exportPages(); assert.equal(result.ok, false); assert.match(result.error, /输入法/);
});
test('long Chinese text and explicit newlines increase editable box height consistently', () => {
  const f = fixture(), o = f.c.object('obj-note'); o.w = 2; o.rich = { text: '中文测试中文测试中文测试\n第二行', fontSize: 12 };
  const lines = f.c.textLines(o), height = f.c.textHeight(o);
  assert.ok(lines.length > 3); assert.ok(height > o.h);
  f.c.updateObject(o.id, { rich: o.rich });
  assert.equal(f.c.object(o.id).h, height);
});

test('native bond tools keep their pointer gesture over document backgrounds', () => {
  const f = fixture();
  f.c.state.objects.push({ id: 'obj-background', kind: 'shape', band: 'back', x: 0, y: 0, w: 20, h: 20, rotation: 0, shape: 'rect' });
  f.c.selection = new Set(['obj-background']);
  f.c.mechanism.isCanvasTarget = () => true; f.c.mechanism.flushNativeMarquee = () => {};
  f.c.adapter.ed.tool = () => ({ mousedown() {} });
  const e = { button: 0, clientX: 2, clientY: 2, target: {}, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  f.c.onDown(e);
  assert.equal(e.prevented, undefined); assert.equal(e.stopped, undefined);
  assert.equal(f.c.drag, null); assert.equal(f.c.selection.size, 0);
  assert.equal(f.c.object('obj-background').x, 0); assert.equal(f.history(), 0);
});
test('selection clicks reach chemistry above a background while explicit mixed drags remain available', () => {
  const f = fixture();
  f.c.state.objects.push({ id: 'obj-background', kind: 'shape', band: 'back', x: 0, y: 0, w: 20, h: 20, rotation: 0, shape: 'rect' });
  f.c.selection = new Set(['obj-background']); f.c.adapter.ed.selection({ atoms: [], bonds: [] });
  f.c.mechanism.isCanvasTarget = () => true; f.c.mechanism.flushNativeMarquee = () => {};
  f.c.mechanism.hitTest = () => ({ kind: 'atom', runtimeId: 0 });
  f.c.adapter.ed.tool = () => ({ isSelectionRunning() { return false; } });
  const event = (x, y) => ({ button: 0, clientX: x, clientY: y, target: {}, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const e = event(1, 2); f.c.onDown(e);
  assert.equal(e.prevented, undefined); assert.equal(f.c.drag, null); assert.equal(f.c.selection.size, 0);
  f.c.selection = new Set(['obj-background']); f.c.adapter.ed.selection({ atoms: [0], bonds: [] });
  const mixed = event(1, 2); f.c.onDown(mixed);
  assert.equal(mixed.prevented, true); assert.equal(f.c.drag.kind, 'move');
  assert.equal(f.c.drag.before.coords.length, 1);
});

test('paper zoom uses physical 100 percent, reports the actual clamped zoom, and stays outside history', () => {
  const f = fixture(); let zoom = 1, anchor;
  f.c.adapter.bondLength = () => 40; f.c.adapter.zoom = () => zoom;
  f.c.adapter.ed.zoom = (value, point) => { zoom = value; anchor = point; };
  f.c.iframe.getBoundingClientRect = () => ({ left: 10, top: 20 });
  const before = JSON.stringify(f.c.getState());
  assert.equal(f.c.setPaperZoom(100, { x: 110, y: 220 }), 100);
  assert.equal(zoom, .48); assert.deepEqual(anchor, { clientX: 100, clientY: 200 });
  const actual = f.c.setPaperZoom(1); assert.ok(Math.abs(actual - 100 / 6) < 1e-9); assert.equal(zoom, .08);
  assert.equal(JSON.stringify(f.c.getState()), before); assert.equal(f.history(), 0);
});
test('active page remains nearest through gaps and outside paper, with stable ties', () => {
  const f = fixture(); f.c.state = MW.documentModel.createDocument({ mode: 'paper', pageCount: 3 });
  f.c.adapter.ed.render.clientArea = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const pages = MW.documentModel.pageRects(f.c.state); let center = { x: 10, y: pages[1].y + 5 };
  f.c.adapter.clientToModel = () => center;
  assert.equal(f.c.getActivePage().id, pages[1].id);
  center = { x: -100, y: pages[1].y - 1 };
  assert.equal(f.c.getActivePage().id, pages[1].id, 'gap tie keeps the previously active page');
  center = { x: -100, y: pages[2].y + 10 }; assert.equal(f.c.getActivePage().id, pages[2].id);
  center = { x: 10, y: pages[2].y + pages[2].h + 500 }; assert.equal(f.c.getActivePage().id, pages[2].id);
  assert.equal(f.history(), 0);
});
test('paper viewport insets reserve sidebar space without editing the document or history', () => {
  const f = fixture(); let dirty = 0;
  f.c.onDirtyHint = () => { dirty++; };
  f.c.adapter.ed.render.clientArea = { getBoundingClientRect: () => ({ left: 52, top: 40, width: 1000, height: 800 }) };
  const before = JSON.stringify(f.c.getState());
  f.c.setPaperViewportInsets({ left: 158 });
  assert.deepEqual(f.c.usablePaperArea(), { left: 210, top: 40, width: 842, height: 800 });
  f.c.setPaperViewportInsets({ right: 300, top: 20 });
  assert.deepEqual(f.c.usablePaperArea(), { left: 210, top: 60, width: 542, height: 780 });
  assert.equal(JSON.stringify(f.c.getState()), before); assert.equal(dirty, 0); assert.equal(f.history(), 0);
});

test('committed page membership follows complete rotated bounds and crossing content stays unassigned', () => {
  const f = fixture(); f.c.state = MW.documentModel.createDocument({ mode: 'paper', pageCount: 2 });
  const pages = MW.documentModel.pageRects(f.c.state), item = { id: 'obj-note', kind: 'text', band: 'front', x: 5, y: 6, w: 10, h: 2, rotation: 0, rich: { text: 'note' } };
  f.c.state.objects.push(item); f.c.selection = new Set(['obj-note']); f.c.adapter.ed.selection({ atoms: [], bonds: [] });
  f.c.syncPageMembership(); assert.equal(item.pageId, pages[0].id);
  f.c.moveSelection(0, pages[1].y); assert.equal(f.c.object(item.id).pageId, pages[1].id);
  f.undo(); assert.equal(f.c.object(item.id).pageId, pages[0].id);
  f.c.updateObject(item.id, { x: -2, rotation: 45 }); assert.equal(f.c.object(item.id).pageId, null);
  f.c.setPageSetup({ mode: 'canvas' }); assert.equal(f.c.object(item.id).pageId, null);
});

function paperViewportFixture(options = {}) {
  const f = fixture(), c = f.c, bondLength = 40;
  const zoom = options.zoom ?? 1, offset = options.offset || { x: 0, y: 0 };
  const area = { left: 52, top: 40, width: options.width || 800, height: options.height || 600 };
  const viewBox = { minX: offset.x, minY: offset.y, width: area.width / zoom, height: area.height / zoom };
  let writes = 0, dirty = 0;
  c.state = MW.documentModel.createDocument({ mode: 'paper', pageCount: options.pageCount || 1 });
  c.paperViewportInsets = options.insets;
  c.adapter.bondLength = () => bondLength;
  c.adapter.offset = () => offset;
  c.adapter.zoom = () => zoom;
  c.adapter.canvasSvg = () => ({ getAttribute: name => name === 'viewBox'
    ? [viewBox.minX, viewBox.minY, viewBox.width, viewBox.height].join(' ') : null });
  c.adapter.ed.render.clientArea = { getBoundingClientRect: () => area };
  c.adapter.ed.render.setViewBox = update => {
    writes++;
    Object.assign(viewBox, update({ ...viewBox }));
    // Exercise the synchronous setViewBox interception used by mount().
    c.clampPaperViewport();
  };
  c.adapter.clientToModel = point => ({
    x: (viewBox.minX + (point.x - area.left) / zoom - offset.x) / bondLength,
    y: (viewBox.minY + (point.y - area.top) / zoom - offset.y) / bondLength
  });
  c.onDirtyHint = () => { dirty++; };
  const visible = () => {
    const r = c.usablePaperArea(), start = c.adapter.clientToModel({ x: r.left, y: r.top });
    return { ...start, w: r.width / (zoom * bondLength), h: r.height / (zoom * bondLength) };
  };
  const moveTo = (x, y) => {
    const before = visible();
    viewBox.minX += (x - before.x) * bondLength;
    viewBox.minY += (y - before.y) * bondLength;
    c.clampPaperViewport();
    return visible();
  };
  return { ...f, visible, moveTo, writes: () => writes, dirty: () => dirty };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }

test('paper navigation stops when any outer blank edge reaches 20 percent of the usable viewport', () => {
  const f = paperViewportFixture(), page = MW.documentModel.pageRects(f.c.state)[0];
  const before = JSON.stringify(f.c.getState());
  for (const [x, y, axis, expected] of [
    [-1e4, 0, 'x', -4], [1e4, 0, 'x', page.w - 16],
    [0, -1e4, 'y', -3], [0, 1e4, 'y', page.h - 12]
  ]) {
    const atEdge = f.moveTo(x, y); near(atEdge[axis], expected);
    const repeated = f.moveTo(axis === 'x' ? x : atEdge.x, axis === 'y' ? y : atEdge.y);
    near(repeated.x, atEdge.x); near(repeated.y, atEdge.y);
    const writes = f.writes(); f.c.clampPaperViewport();
    assert.equal(f.writes(), writes, 'an already clamped viewport does not trigger another setViewBox');
  }
  assert.equal(JSON.stringify(f.c.getState()), before);
  assert.equal(f.history(), 0); assert.equal(f.dirty(), 0);
});

test('zoomed-out paper stays centred on each axis that cannot fit within the 20 percent allowance', () => {
  for (const [width, height] of [[4000, 5000], [4000, 600], [800, 5000]]) {
    const f = paperViewportFixture({ width, height });
    const page = MW.documentModel.pageRects(f.c.state)[0];
    const view = f.moveTo(-1e4, 1e4);
    near(view.x, width === 4000 ? (page.w - view.w) / 2 : -view.w * .2);
    near(view.y, height === 5000 ? (page.h - view.h) / 2 : page.h - view.h * .8);
    const other = f.moveTo(1e4, -1e4);
    if (width === 4000) near(other.x, view.x);
    if (height === 5000) near(other.y, view.y);
  }
});

test('paper navigation remains continuous through all pages and stops after the last page', () => {
  const f = paperViewportFixture({ pageCount: 3 });
  const pages = MW.documentModel.pageRects(f.c.state), last = pages.at(-1);
  const before = JSON.stringify(f.c.getState());
  for (const page of pages) {
    const inside = f.moveTo(2, page.y + 4); near(inside.x, 2); near(inside.y, page.y + 4);
  }
  near(f.moveTo(2, 1e4).y, last.y + last.h - f.visible().h * .8);
  near(f.moveTo(2, -1e4).y, -f.visible().h * .2);
  assert.equal(JSON.stringify(f.c.getState()), before); assert.equal(f.history(), 0);
});

test('paper bounds use the visible area after sidebar insets, zoom and nonzero Ketcher offset', () => {
  const f = paperViewportFixture({ width: 1200, height: 900, zoom: .5,
    offset: { x: 173, y: -219 }, insets: { left: 240, right: 160, top: 60, bottom: 40 } });
  const page = MW.documentModel.pageRects(f.c.state)[0];
  const start = f.moveTo(-1e4, -1e4);
  near(start.w, 40); near(start.h, 40);
  near(start.x, -8); near(start.y, -8);
  const end = f.moveTo(1e4, 1e4);
  near(end.x, page.w - 32); near(end.y, page.h - 32);
});

test('changing paper viewport insets clamps the new visible region without marking the document dirty', () => {
  const f = paperViewportFixture({ width: 1200, height: 900 });
  f.moveTo(1e4, 1e4);
  const page = MW.documentModel.pageRects(f.c.state)[0], before = JSON.stringify(f.c.getState());
  f.c.setPaperViewportInsets({ left: 400, top: 300 });
  const view = f.visible();
  near(view.x, page.w - view.w * .8); near(view.y, page.h - view.h * .8);
  assert.equal(JSON.stringify(f.c.getState()), before);
  assert.equal(f.history(), 0); assert.equal(f.dirty(), 0);
});

test('inactive document layers and canvas mode preserve unrestricted viewport movement', () => {
  for (const inactive of [true, false]) {
    const f = paperViewportFixture();
    if (inactive) f.c.active = false; else f.c.state.mode = 'canvas';
    const view = f.moveTo(-1e4, 1e4);
    near(view.x, -1e4); near(view.y, 1e4); assert.equal(f.writes(), 0);
  }
});

test('paper visible area intersects native safe and palette insets with web panels without adding them', () => {
  const previous = global.molCanvasViewport;
  try {
    global.molCanvasViewport = { nativeInsetsFrame: () => ({ left: 80, top: 30, right: 100, bottom: 60 }) };
    const f = fixture(), before = JSON.stringify(f.c.getState());
    f.c.win.innerWidth = 1000; f.c.win.innerHeight = 800;
    f.c.adapter.ed.render.clientArea = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
    f.c.paperViewportInsets = { left: 160, top: 12, right: 40, bottom: 80 };
    assert.deepEqual(f.c.usablePaperArea(), { left: 160, top: 30, width: 740, height: 690 });
    assert.equal(JSON.stringify(f.c.getState()), before); assert.equal(f.history(), 0);
  } finally {
    if (previous === undefined) delete global.molCanvasViewport; else global.molCanvasViewport = previous;
  }
});

test('native paper insets account for the client area gap at every iframe edge', () => {
  const previous = global.molCanvasViewport;
  try {
    const native = { left: 96, top: 68, right: 220, bottom: 210 };
    global.molCanvasViewport = { nativeInsetsFrame: () => native };
    const f = fixture();
    f.c.win.innerWidth = 1000; f.c.win.innerHeight = 800;
    f.c.iframe.getBoundingClientRect = () => ({ left: 500, top: 300, width: 1000, height: 800 });
    f.c.adapter.ed.render.clientArea = { getBoundingClientRect: () => ({ left: 52, top: 40, width: 800, height: 600 }) };
    f.c.paperViewportInsets = { left: 20, top: 8, right: 30, bottom: 12 };
    assert.deepEqual(f.c.usablePaperArea(), { left: 96, top: 68, width: 684, height: 522 });
    native.right = 100; native.bottom = 120;
    assert.deepEqual(f.c.usablePaperArea(), { left: 96, top: 68, width: 726, height: 560 },
      'native safe strips outside the client area do not shrink or expand the web-reserved area');
  } finally {
    if (previous === undefined) delete global.molCanvasViewport; else global.molCanvasViewport = previous;
  }
});

test('canvas panning preserves document nodes and keeps edit notifications and history idle', () => {
  const f = fixture(); let renders = 0, emits = 0, positions = 0;
  f.c.render = () => { renders++; };
  f.c.subscribe(() => { emits++; });
  f.c.editor = {}; f.c.positionEditor = () => { positions++; };
  const before = JSON.stringify(f.c.state);
  f.c.onAdapterChange('pan');
  assert.equal(renders, 0); assert.equal(emits, 0); assert.equal(positions, 1);
  assert.equal(JSON.stringify(f.c.state), before); assert.equal(f.history(), 0);
  f.c.onAdapterChange('transform');
  assert.equal(renders, 1); assert.equal(emits, 1, 'zoom and resize still refresh document presentation');
});

test('paper panning moves only the surround and notifies on page crossings even after wheel UI reads', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><g id="mech"/></svg>');
  const f = fixture(), c = f.c, svg = dom.window.document.querySelector('svg');
  c.doc = dom.window.document;
  c.state = MW.documentModel.createDocument({ mode: 'paper', pageCount: 2 });
  c.state.objects.push({ id: 'obj-stable', kind: 'shape', band: 'front', x: 4, y: 4, w: 3, h: 2, rotation: 0, shape: 'rect' });
  c.selection.clear();
  c.adapter.canvasSvg = () => svg;
  c.adapter.ensureLayer = () => svg.querySelector('#mech');
  c.adapter.offset = () => ({ x: 0, y: 0 }); c.adapter.bondLength = () => 40; c.adapter.zoom = () => 1;
  c.adapter.ed.render.clientArea = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  c.adapter.clientToModel = p => ({ x: (svg.viewBox.baseVal.x + p.x) / 40, y: (svg.viewBox.baseVal.y + p.y) / 40 });
  c.adapter.ed.render.setViewBox = update => {
    const vb = svg.viewBox.baseVal, next = update({ minX: vb.x, minY: vb.y, width: vb.width, height: vb.height });
    svg.setAttribute('viewBox', `${next.minX} ${next.minY} ${next.width} ${next.height}`);
  };
  DocumentController.prototype.render.call(c);
  const surround = c.paperBackground, object = svg.querySelector('[data-doc-id="obj-stable"]');
  const page = svg.querySelector('[data-page-id]'), before = JSON.stringify(c.state), notifications = [];
  c.subscribe((_state, _controller, kind) => notifications.push(kind));
  c.onAdapterChange('pan');
  assert.deepEqual(notifications, [], 'the first pan within the initial page is not a page change');
  svg.setAttribute('viewBox', '80 120 800 600');
  c.onAdapterChange('pan');
  assert.equal(c.paperBackground, surround); assert.equal(surround.getAttribute('x'), '-18');
  assert.equal(surround.getAttribute('y'), '-17');
  assert.equal(svg.querySelector('[data-doc-id="obj-stable"]'), object);
  assert.equal(svg.querySelector('[data-page-id]'), page); assert.deepEqual(notifications, []);
  const pages = MW.documentModel.pageRects(c.state);
  svg.setAttribute('viewBox', `80 ${pages[1].y * 40} 800 600`);
  assert.equal(c.getActivePage().id, pages[1].id, 'wheel listeners may read active page before the adapter flush');
  c.onAdapterChange('pan'); c.onAdapterChange('pan');
  assert.deepEqual(notifications, ['pan']);
  assert.equal(svg.querySelector('[data-doc-id="obj-stable"]'), object);
  assert.equal(JSON.stringify(c.state), before); assert.equal(f.history(), 0);
  dom.window.close();
});
