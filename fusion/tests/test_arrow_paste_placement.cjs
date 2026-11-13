'use strict';
const assert = require('node:assert/strict');
for (const file of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-layer', 'mechanism-controller']) require('../workbench/' + file + '.js');
const MW = globalThis.MolWorkbench, M = MW.model;

function fixture() {
  const model = new M.MechanismModel(), history = [], statuses = [], tools = [];
  let dirty = 0;
  const ed = {
    render: { clientArea: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 200 }) } },
    tool(name) { tools.push(name); }, selection: () => null
  };
  const action = (apply, reverse) => ({ perform() { apply(); return action(reverse, apply); } });
  const adapter = {
    ed, context: () => ({}), selection: () => ({ atoms: [], bonds: [], others: 0 }),
    clientToModel: point => ({ x: point.x / 10, y: point.y / 10 }), clearSelection() {}, clearHover() {},
    pushAction(undo, redo) { history.push(action(undo, redo)); }
  };
  const controller = new MW.controller.MechanismController({
    model, adapter, doc: { activeElement: null }, win: {}, layer: { render() {} },
    onDirtyHint() { dirty++; }, onStatus(status) { statuses.push(status); }
  });
  controller.render = () => {};
  controller.isCanvasTarget = () => true;
  return { model, controller, adapter, history, statuses, tools, dirty: () => dirty };
}
const arrow = electrons => M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 4, y: 0 }, {
  electronCount: electrons || 2, bend: 0.5, controlFrame: { along: 0.4, normal: 0.8 }
});
const payload = arrows => JSON.stringify({ kind: 'molstudio-mechanism', version: 2, arrows, lonePairs: [] });
function event(x, y) {
  return { button: 0, clientX: x, clientY: y, target: { tagName: 'DIV' }, blocked: false,
    preventDefault() { this.blocked = true; }, stopPropagation() { this.blocked = true; } };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected); }
function test(name, fn) { fn(); console.log('PASS', name); }

test('arrow UI paste waits for a placement click and uses the viewport when no pointer is known', () => {
  const f = fixture(), source = arrow();
  assert.equal(f.controller.beginPasteText(payload([source])), true);
  assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  assert.deepEqual(f.tools, ['select']);
  const geo = M.arrowGeometry(f.controller.pastePreview.arrows[0], {});
  near((Math.min(geo.start.x, geo.control.x, geo.end.x) + Math.max(geo.start.x, geo.control.x, geo.end.x)) / 2, 21);
  near((Math.min(geo.start.y, geo.control.y, geo.end.y) + Math.max(geo.start.y, geo.control.y, geo.end.y)) / 2, 12);
});

test('preview follows the pointer as a group without changing the curve or fishhook type', () => {
  const f = fixture(), first = arrow(1), second = arrow(2);
  second.source.y = 3; second.target.y = 3;
  f.controller.lastPointer = { model: { x: 7, y: 8 } };
  assert.equal(f.controller.beginPasteText(payload([first, second])), true);
  const before = f.controller.pastePreview.arrows.map(ar => M.arrowGeometry(ar, {}));
  const move = event(120, 180); f.controller.onPointerMove(move); assert.equal(move.blocked, true);
  const copies = f.controller.pastePreview.arrows;
  for (let i = 0; i < copies.length; i++) {
    const after = M.arrowGeometry(copies[i], {});
    for (const point of ['start', 'control', 'end']) { near(after[point].x - before[i][point].x, 5); near(after[point].y - before[i][point].y, 10); }
  }
  assert.deepEqual(copies.map(ar => ar.electronCount), [1, 2]);
  assert.deepEqual(copies[0].geometry.controlFrame, first.geometry.controlFrame);
  assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
});

test('one canvas click commits all preview arrows once and native compatibility clicks are blocked', () => {
  const f = fixture(); f.controller.beginPasteText(payload([arrow(1), arrow(2)]));
  const down = event(150, 100); f.controller.onPointerDown(down);
  assert.equal(down.blocked, true); assert.equal(f.controller.pastePreview, null);
  assert.equal(f.model.state.arrows.length, 2); assert.equal(f.history.length, 1); assert.equal(f.dirty(), 1);
  for (const type of ['mousedown', 'mouseup', 'click']) {
    const native = { ...event(150, 100), type }; f.controller.onNativeMouse(native); assert.equal(native.blocked, true);
  }
  const redo = f.history[0].perform(); assert.equal(f.model.state.arrows.length, 0);
  redo.perform(); assert.equal(f.model.state.arrows.length, 2);
  assert.deepEqual(f.model.state.arrows.map(ar => ar.electronCount), [1, 2]);
  f.controller.unmount();
});

test('Escape, blur cancellation, tool changes and unmount leave no saved arrow or history', () => {
  for (const cancel of [
    c => c.onKeyDown({ ...event(0, 0), key: 'Escape' }),
    c => c.cancelDraft('失焦'), c => c.setTool('arrow1'), c => c.setTool('select'), c => c.unmount()
  ]) {
    const f = fixture(); f.controller.beginPasteText(payload([arrow(1)])); cancel(f.controller);
    assert.equal(f.controller.pastePreview, null); assert.equal(f.model.state.arrows.length, 0);
    assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  }
});

test('placement history failure restores the model and does not mark the file dirty', () => {
  const f = fixture(); f.controller.beginPasteText(payload([arrow()]));
  f.adapter.pushAction = () => { throw Error('history unavailable'); };
  const original = console.error; console.error = () => {};
  try { assert.equal(f.controller.finishPastePreview({ x: 10, y: 10 }), false); }
  finally { console.error = original; }
  assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  assert.equal(f.controller.pastePreview, null); assert.match(f.statuses.at(-1), /粘贴失败/);
});

test('legacy molecule payload and invalid arrows never enter preview or call molecular APIs', () => {
  const f = fixture(); f.adapter.k = { getKet() { throw Error('molecule serialization forbidden'); }, addFragment() { throw Error('molecule insertion forbidden'); } };
  const old = JSON.parse(payload([arrow()])); old.molecules = { ket: 'obsolete' };
  assert.equal(f.controller.beginPasteText(JSON.stringify(old)), false);
  const invalid = JSON.parse(payload([arrow()])); invalid.arrows[0].source.x = 'bad';
  assert.equal(f.controller.beginPasteText(JSON.stringify(invalid)), false);
  assert.equal(f.controller.pastePreview, null); assert.equal(f.model.state.arrows.length, 0); assert.equal(f.dirty(), 0);
});

test('a real arrow payload paste event starts preview rather than inserting immediately', () => {
  const f = fixture(), paste = { ...event(0, 0), clipboardData: { getData: () => payload([arrow(1)]) } };
  f.controller.onPasteEvent(paste);
  assert.equal(paste.blocked, true); assert.ok(f.controller.pastePreview);
  assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0);
});

test('native tool shortcuts and a later native paste cancel the arrow preview and pass through', () => {
  const f = fixture();
  f.controller.beginPasteText(payload([arrow()]));
  const key = { ...event(0, 0), key: '1' }; f.controller.onKeyDown(key);
  assert.equal(f.controller.pastePreview, null); assert.equal(key.blocked, false);
  f.controller.beginPasteText(payload([arrow()]));
  const paste = { ...event(0, 0), clipboardData: { getData: () => 'native molecule data' } };
  f.controller.onPasteEvent(paste);
  assert.equal(f.controller.pastePreview, null); assert.equal(paste.blocked, false);
  assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
});

test('preview renders only in the existing non-exported overlay', () => {
  const layer = new MW.layer.MechanismLayer({}, {}), calls = [];
  layer.body = {}; layer.overlay = {}; layer.ensure = () => true; layer.unit = () => 1; layer.canonical = () => 1;
  for (const name of ['renderLonePairs', 'renderGhosts', 'renderDraft', 'renderHover']) layer[name] = () => {};
  layer.renderArrows = (...args) => calls.push(args);
  const model = new M.MechanismModel(), preview = { arrows: [arrow()] };
  layer.render({ model, ctx: {}, selection: new Set(), pastePreview: preview });
  assert.equal(calls[0][0], model); assert.equal(calls[0][5], null);
  assert.equal(calls[1][0].state.arrows, preview.arrows); assert.equal(calls[1][5], layer.overlay);
  assert.equal(model.state.arrows.length, 0);
});
