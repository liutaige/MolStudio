'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
for (const file of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-controller']) {
  require('../workbench/' + file + '.js');
}
const MW = globalThis.MolWorkbench, M = MW.model;

function fixture(t) {
  const frames = [], observers = [], kinds = [];
  const stats = { identity: 0, chemistry: 0, render: 0, layer: 0 };
  const attrs = new Map([['viewBox', '0 0 800 600'], ['width', '800'], ['height', '600']]);
  const svg = { getAttribute: name => attrs.get(name) ?? null };
  const area = { querySelector: () => svg, addEventListener() {}, removeEventListener() {} };
  const win = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() {}
    } };
  const doc = { defaultView: win, body: {}, addEventListener() {}, removeEventListener() {} };
  const atoms = new Map([[0, { label: 'O', implicitH: 1, pp: { x: 0, y: 0 } }],
    [1, { label: 'C', implicitH: 3, pp: { x: 1, y: 0 } }]]);
  const bonds = new Map([[0, { begin: 0, end: 1, type: 1 }]]);
  let zoom = 1, tool = null;
  const history = { undo: 0, redo: 0 };
  const ed = { struct: () => ({ atoms, bonds }), zoom: () => zoom, tool: () => tool,
    historySize: () => ({ ...history }), update() {}, undo() { history.undo--; history.redo++; },
    redo() { history.undo++; history.redo--; }, render: { clientArea: area, options: { bondLength: 40, offset: { x: 0, y: 0 } } } };
  const adapter = new MW.adapter.KetcherAdapter({ editor: ed }, doc);
  for (const [method, key] of [['syncIdentity', 'identity'], ['chemSnapshot', 'chemistry']]) {
    const original = adapter[method].bind(adapter);
    adapter[method] = (...args) => { stats[key]++; return original(...args); };
  }
  const layer = { isConnected: true, contains: () => false };
  adapter.ensureLayer = () => { stats.layer++; adapter.layerEl = layer; return layer; };
  const model = new M.MechanismModel();
  const controller = new MW.controller.MechanismController({ adapter, model, doc, win,
    layer: { render() { stats.render++; } } });
  adapter.onChange(kind => { kinds.push(kind); controller.onAdapterChange(kind); });
  const flush = () => { const fn = frames.shift(); assert.ok(fn, 'a frame was scheduled'); fn(); };
  adapter.mount(); flush();
  const svgObserver = observers.find(observer => observer.target === svg);
  const attribute = name => svgObserver.callback([{ type: 'attributes', attributeName: name }]);
  const camera = (x, y, width = 800, height = 600) => { attrs.set('viewBox', `${x} ${y} ${width} ${height}`); attribute('viewBox'); };
  const reset = () => { for (const key of Object.keys(stats)) stats[key] = 0; kinds.length = 0; };
  t.after(() => adapter.unmount());
  reset();
  return { adapter, controller, model, ed, attrs, svg, atoms, history, stats, kinds, camera, attribute, flush, reset,
    setZoom: value => { zoom = value; }, setTool: value => { tool = value; } };
}

test('successive viewBox translations preserve mechanism nodes, chemistry and stable identities', t => {
  const f = fixture(t), atomIds = [...f.adapter.atomUuid], bondIds = [...f.adapter.bondUuid];
  const scene = {}; f.controller._scene = scene;
  for (const [x, y] of [[0.25, 1.5], [30, -8], [4, 5]]) { f.camera(x, y); f.flush(); }
  assert.deepEqual(f.kinds, ['pan', 'pan', 'pan']);
  assert.deepEqual(f.stats, { identity: 0, chemistry: 0, render: 0, layer: 0 });
  assert.deepEqual([...f.adapter.atomUuid], atomIds);
  assert.deepEqual([...f.adapter.bondUuid], bondIds);
  assert.equal(f.controller._scene, scene);
});

test('zoom, resize and model transforms refresh visual geometry without recalculating chemistry', t => {
  const f = fixture(t);
  const cases = [
    () => { f.setZoom(2); f.camera(10, 20, 400, 300); },
    () => { f.attrs.set('width', '900'); f.camera(20, 30, 450, 300); },
    () => { f.ed.render.options.offset.x = 10; f.camera(30, 40, 450, 300); },
    () => { f.ed.render.options.bondLength = 50; f.camera(40, 50, 450, 300); },
    () => { f.camera(50, 60, 450, 300); f.attribute('style'); },
    () => { f.camera(60, 70, 450, 300); f.adapter.schedule('transform'); }
  ];
  for (const change of cases) {
    f.reset(); f.controller._scene = {}; change(); f.flush();
    assert.deepEqual(f.kinds, ['transform']);
    assert.equal(f.stats.identity, 0); assert.equal(f.stats.chemistry, 0);
    assert.equal(f.stats.render, 1); assert.equal(f.stats.layer, 1);
    assert.equal(f.controller._scene, null);
  }
});

test('first or invalid camera snapshots cannot suppress required geometry refresh', t => {
  const f = fixture(t);
  f.adapter._lastCamera = null;
  f.camera(10, 20); f.flush();
  assert.deepEqual(f.kinds, ['transform']);
  f.reset(); f.attrs.set('viewBox', 'broken'); f.attribute('viewBox'); f.flush();
  assert.deepEqual(f.kinds, ['transform']);
  f.reset(); f.camera(20, 30); f.flush();
  assert.deepEqual(f.kinds, ['transform']);
});

test('a structure edit coalesced with a pan still updates chemistry and identities', t => {
  const f = fixture(t);
  f.camera(20, 30);
  f.atoms.set(2, { label: 'Cl', charge: -1, implicitH: 0, pp: { x: 2, y: 0 } });
  f.ed.update(); f.flush();
  assert.deepEqual(f.kinds, ['struct']);
  assert.ok(f.adapter.uuidOfAtom(2));
  assert.equal(f.stats.chemistry, 1); assert.equal(f.stats.render, 1);
  assert.ok(f.controller.autoSlots.some(slot => slot.ownerAtomId === f.adapter.uuidOfAtom(2)));
});

test('history coalesced with viewport changes keeps undo/redo identity reconciliation', t => {
  const f = fixture(t), first = f.adapter.uuidOfAtom(0);
  f.history.undo = 2; f.adapter.schedule('struct'); f.flush();
  f.reset();
  f.camera(5, 6); f.ed.undo(); f.flush();
  assert.deepEqual(f.kinds, ['history']);
  assert.equal(f.stats.chemistry, 1); assert.equal(f.stats.render, 1);
  assert.equal(f.adapter.uuidOfAtom(0), first);
  f.reset(); f.camera(6, 7); f.ed.redo(); f.flush();
  assert.deepEqual(f.kinds, ['history']);
  assert.equal(f.stats.chemistry, 1); assert.equal(f.adapter.uuidOfAtom(0), first);
});

test('history changes detected during an otherwise pure pan cannot bypass structure refresh', t => {
  const f = fixture(t);
  f.history.undo = 1; f.camera(5, 6); f.flush();
  assert.deepEqual(f.kinds, ['history']);
  assert.equal(f.stats.chemistry, 1); assert.equal(f.stats.render, 1);
});

test('hand navigation skips mechanism hover work while active mechanism edits keep ownership', t => {
  const f = fixture(t);
  f.setTool({ begPos: null, endPos: null, mouseLeaveClientArea() {} });
  let hitTests = 0, pointReads = 0, dragMoves = 0;
  f.controller.isCanvasTarget = () => true;
  f.controller.eventModelPoint = () => { pointReads++; return { x: 0, y: 0 }; };
  f.controller.hitTest = () => { hitTests++; return null; };
  f.controller.onDragMove = () => { dragMoves++; };
  const event = { target: { tagName: 'svg' }, clientX: 1, clientY: 2 };
  f.controller.onPointerMove(event);
  assert.equal(hitTests, 0); assert.equal(pointReads, 0); assert.equal(f.stats.render, 0);
  f.controller.hover = { kind: 'arrow' };
  f.controller.onPointerMove(event); f.controller.onPointerMove(event);
  assert.equal(f.stats.render, 1, 'stale hover is cleared once');
  f.controller.drag = { kind: 'arrow-bend' };
  f.controller.onPointerMove(event);
  assert.equal(dragMoves, 1); assert.equal(pointReads, 1);
  f.controller.drag = null;
  f.setTool({ isSelectionRunning() { return false; } });
  f.controller.onPointerMove(event);
  assert.equal(hitTests, 1, 'ordinary selection still receives hover hit tests');
});
