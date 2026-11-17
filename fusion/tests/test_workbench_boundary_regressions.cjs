'use strict';
// Run: node --test fusion/tests/test_workbench_boundary_regressions.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const file of ['mechanism-model', 'workbench-storage', 'ketcher-adapter', 'mechanism-route', 'mechanism-controller']) {
  require('../workbench/' + file + '.js');
}
const MW = globalThis.MolWorkbench, M = MW.model;
function events() {
  const handlers = new Map();
  return {
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, event = {}) { for (const fn of [...(handlers.get(name) || [])]) fn(event); },
    count() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); }
  };
}
function fixture() {
  const doc = events(), win = events(), atoms = new Map([
    [0, { label: 'O', pp: { x: 0, y: 0 } }],
    [1, { label: 'C', pp: { x: 1, y: 0 } }]
  ]);
  const ed = { struct: () => ({ atoms, bonds: new Map() }), render: { options: { bondLength: 40 } }, zoom: () => 1 };
  const adapter = new MW.adapter.KetcherAdapter({ editor: ed }, {});
  adapter.syncIdentity();
  let subscriptions = 0, unsubscriptions = 0, history = 0;
  adapter.onChange = () => { subscriptions++; return () => { unsubscriptions++; }; };
  adapter.pushAction = () => { history++; };
  const model = new M.MechanismModel();
  const controller = new MW.controller.MechanismController({ adapter, model, doc, win, layer: { render() {} } });
  return { doc, win, adapter, model, controller, stats: () => ({ subscriptions, unsubscriptions, history }) };
}
function startBend(f) {
  const arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 },
    { bend: 0.42, mode: 'manual', controlFrame: { along: 0.3, normal: 0.7 } });
  f.model.addArrow(arrow);
  const before = f.model.cloneState();
  f.controller.drag = { kind: 'arrow-bend', before, handle: { arrow, geometry: { start: { x: 0, y: 0 }, control: { x: 1, y: 1 }, end: { x: 2, y: 0 } } } };
  f.controller.onDragMove({}, { x: 1, y: -1 });
  assert.notDeepEqual(f.model.cloneState(), before);
  return before;
}

test('pointercancel, window blur and Escape each roll back preview and leave no undo action', () => {
  for (const cancel of ['pointercancel', 'blur', 'escape']) {
    const f = fixture(); f.controller.mount();
    const before = startBend(f);
    f.controller.nativeMarquee = { box: {} };
    if (cancel === 'pointercancel') f.doc.emit('pointercancel');
    else if (cancel === 'blur') f.win.emit('blur');
    else f.controller.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(f.model.cloneState(), before, cancel);
    assert.equal(f.controller.drag, null, cancel);
    assert.equal(f.stats().history, 0, cancel);
    if (cancel !== 'escape') assert.equal(f.controller.nativeMarquee, null);
    f.controller.unmount();
  }
});

test('bend drag tracks the pointer continuously and preserves asymmetric control frames', () => {
  for (const frame of [undefined, { along: 0.3, normal: 0.7 }]) {
    const f = fixture(), arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 },
      { bend: 0.6, mode: 'manual', controlFrame: frame });
    f.model.addArrow(arrow);
    const geo = M.arrowGeometry(arrow, f.controller.ctx()), mid = M.quadPoint(geo.start, geo.control, geo.end, .5);
    const start = { x: mid.x + .1, y: mid.y + .1 };
    f.controller.drag = { kind: 'arrow-bend', before: f.model.cloneState(), startModel: start, handle: { arrow, geometry: geo } };
    f.controller.onDragMove({}, { x: start.x, y: start.y + .01 });
    let actual = M.arrowGeometry(arrow, f.controller.ctx());
    let moved = M.quadPoint(actual.start, actual.control, actual.end, .5);
    assert.ok(Math.abs(moved.y - mid.y - .01) < 1e-9);
    if (frame) assert.equal(arrow.geometry.controlFrame.along, frame.along);
    f.controller.onDragMove({}, { x: start.x, y: start.y - .01 });
    actual = M.arrowGeometry(arrow, f.controller.ctx()); moved = M.quadPoint(actual.start, actual.control, actual.end, .5);
    assert.ok(Math.abs(moved.y - mid.y + .01) < 1e-9);
    f.controller.cancelDrag();
    assert.equal(f.model.arrow(arrow.id).geometry.bend, .6);
    assert.deepEqual(f.model.arrow(arrow.id).geometry.controlFrame, frame);
  }
});

test('frame curvature is bounded without jumping existing out-of-range curves', () => {
  for (const initial of [-3, -0.6, 0.6, 3]) {
    const f = fixture(), arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 },
      { bend: 0.6, mode: 'manual', controlFrame: { along: 0.3, normal: initial } });
    f.model.addArrow(arrow);
    const geo = M.arrowGeometry(arrow, f.controller.ctx()), mid = M.quadPoint(geo.start, geo.control, geo.end, .5);
    f.controller.drag = { kind: 'arrow-bend', before: f.model.cloneState(), startModel: mid, handle: { arrow, geometry: geo } };
    f.controller.onDragMove({}, mid);
    assert.equal(arrow.geometry.controlFrame.normal, initial);
    f.controller.onDragMove({}, { x: mid.x, y: mid.y + 100 });
    assert.equal(arrow.geometry.controlFrame.normal, Math.max(2.5, initial));
    f.controller.onDragMove({}, { x: mid.x, y: mid.y - 100 });
    assert.equal(arrow.geometry.controlFrame.normal, Math.min(-2.5, initial));
  }
});

test('lone-pair drag is restored on tool switch and unmount, including reference-angle fields', () => {
  for (const cancel of ['tool', 'unmount']) {
    const f = fixture(), lp = M.makeLonePair(f.adapter.uuidOfAtom(0), { angle: 20, origin: 'manual' });
    f.model.addLonePair(lp);
    const before = f.model.cloneState();
    f.controller.drag = { kind: 'lp-move', before, handle: { lonePair: lp } };
    f.controller.onDragMove({}, { x: 0, y: 1 });
    assert.notDeepEqual(f.model.cloneState(), before);
    if (cancel === 'tool') f.controller.setTool('select'); else f.controller.unmount();
    assert.deepEqual(f.model.cloneState(), before);
    assert.equal(f.controller.drag, null);
    assert.equal(f.stats().history, 0);
  }
});

test('repeated lifecycle, empty-canvas select-all, minimum zoom and rapid history replay', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.controller.mount();
    const count = f.doc.count() + f.win.count();
    assert.ok(count > 0);
    f.controller.mount();
    assert.equal(f.doc.count() + f.win.count(), count);
    f.controller.unmount(); f.controller.unmount();
    assert.equal(f.doc.count() + f.win.count(), 0);
  }
  assert.deepEqual(f.stats(), { subscriptions: 20, unsubscriptions: 20, history: 0 });
  const empty = fixture();
  empty.adapter.struct().atoms.clear();
  const calls = [];
  empty.adapter.ed.selection = value => { if (value !== undefined) calls.push(value); return { atoms: [], bonds: [] }; };
  assert.equal(empty.controller.selectAll(), true);
  assert.deepEqual(calls, ['all']);
  assert.equal(empty.controller.selection.size, 0);
  assert.equal(empty.controller.hitTest({ x: 0, y: 0 }, { includeArrows: true }), null);

  const zoomed = fixture();
  zoomed.adapter.ed.zoom = () => 0.2;
  assert.equal(zoomed.controller.hitTest({ x: 0, y: 0 }).kind, 'atom');
  assert.equal(zoomed.controller.hitTest({ x: 1, y: 0 }).kind, 'atom');
  assert.equal(zoomed.controller.hitTest({ x: 100, y: 100 }, { includeArrows: true }), null);

  const history = fixture(), actions = [];
  history.adapter.pushAction = (undo, redo) => actions.push({ undo, redo });
  const before = history.model.cloneState();
  const arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 }, { electronCount: 1 });
  assert.equal(history.controller.commit(() => history.model.addArrow(arrow), 'add'), true);
  const after = history.model.cloneState();
  assert.equal(actions.length, 1);
  for (let i = 0; i < 100; i++) {
    actions[0].undo(); assert.deepEqual(history.model.cloneState(), before);
    actions[0].redo(); assert.deepEqual(history.model.cloneState(), after);
  }
});

test('six-place coordinate keys normalize negative zero in both cleanup and binding maps', () => {
  const code = fs.readFileSync(require.resolve('../canvas.html'), 'utf8');
  const match = code.match(/function coordKey\(x, y\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const canvasKey = vm.runInNewContext('(' + match[0] + ')');
  for (const key of [MW.adapter.coordKey, canvasKey]) {
    for (const n of [-0, -0.0000001, -0.00000049, 0, 0.00000049]) {
      assert.equal(key(n, -n), '0.000000,0.000000');
    }
    assert.equal(key(-0.00000051, 0.00000051), '-0.000001,0.000001');
  }
  const f = fixture();
  f.adapter.struct().atoms.get(0).pp = { x: -0.0000001, y: 0.0000001 };
  const result = f.adapter.mapRuntimeToKet({ root: { nodes: [{ $ref: 'mol0' }] }, mol0: {
    type: 'molecule', atoms: [{ location: [0, 0, 0] }, { location: [1, 0, 0] }], bonds: []
  } });
  assert.equal(result.error, undefined);
  assert.equal(result.atoms.length, 2);
  const build = code.match(/function buildAtomMap\(doc, st\) \{[\s\S]*?\n\}/);
  const ordered = code.match(/function orderedMoleculeKeys\(doc\) \{[\s\S]*?\n\}/);
  assert.ok(build && ordered);
  const buildAtomMap = vm.runInNewContext(match[0] + '\n' + ordered[0] + '\n' + build[0] + '\nbuildAtomMap');
  const ket = { root: { nodes: [{ $ref: 'mol0' }] }, mol0: {
    type: 'molecule', atoms: [{ location: [0, 0, 0] }, { location: [1, 0, 0] }], bonds: []
  } };
  assert.deepEqual(Array.from(buildAtomMap(ket, f.adapter.struct()).map.mol0), [0, 1]);
  f.adapter.struct().atoms.get(1).pp = { x: 0.0000001, y: -0.0000001 };
  assert.match(buildAtomMap(ket, f.adapter.struct()).error, /重合/);
  assert.match(f.adapter.mapRuntimeToKet(ket).error, /重合/);
});

test('molwork round trips preserve lone-pair angles, fishhook geometry and six-place precision', () => {
  const f = fixture();
  const lp = M.makeLonePair(f.adapter.uuidOfAtom(0), { angle: 33.12345649, angleRel: -22.98765442,
    refAtomId: f.adapter.uuidOfAtom(1), origin: 'manual' });
  f.model.addLonePair(lp);
  f.model.addArrow(M.makeArrow({ type: 'free', x: -0.12345642, y: 100.12345649 },
    { type: 'free', x: 4.12345649, y: -3.12345642 },
    { electronCount: 1, bend: 0.12345649, mode: 'manual', controlFrame: { along: 0.12345649, normal: -0.87654342 } }));
  const original = f.model.cloneState(), first = M.serializeMechanism(original);
  for (const [a, b] of [[original.arrows[0].source.x, first.arrows[0].source.x],
    [original.arrows[0].target.y, first.arrows[0].target.y],
    [original.arrows[0].geometry.bend, first.arrows[0].geometry.bend],
    [original.arrows[0].geometry.controlFrame.normal, first.arrows[0].geometry.controlFrame.normal],
    [original.lonePairs[0].angle, first.lonePairs[0].angle],
    [original.lonePairs[0].angleRel, first.lonePairs[0].angleRel]]) {
    assert.ok(Math.abs(a - b) <= 0.0000005);
  }
  let serialized = first;
  for (let i = 0; i < 100; i++) serialized = M.serializeMechanism(JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(serialized, first);
  const errors = []; M.validateMechanism(serialized, errors); assert.deepEqual(errors, []);
  const ket = fs.readFileSync(require.resolve('./fixtures/M01.ket'), 'utf8');
  const opts = { ket, bindings: { atoms: [], bonds: [] }, mechanism: original };
  const text = MW.storage.serializeWorkbench(opts);
  let parsed = MW.storage.parseWorkbench(text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.doc.mechanism.arrows[0].electronCount, 1);
  assert.deepEqual(parsed.doc.mechanism, first);
  for (let i = 0; i < 100; i++) {
    const next = MW.storage.serializeWorkbench(parsed.doc);
    assert.equal(next, text);
    parsed = MW.storage.parseWorkbench(next);
    assert.equal(parsed.ok, true);
  }
});

test('lone-pair tool materializes ghost suggestion slots while atom clicks stay manual', () => {
  const f = fixture();
  const owner = f.adapter.uuidOfAtom(0), neighbour = f.adapter.uuidOfAtom(1);
  const ghost = { id: 'ghost-test', ownerAtomId: owner, angle: 180,
    refAtomId: neighbour, angleRel: 180, ghost: true };
  f.controller.ghostSlots = [ghost];
  f.controller.suppressedAuto = new Set(owner + '@180');   // 曾被用户删过的同槽位
  const target = M.lonePairPosition(ghost, f.controller.ctx());
  assert.ok(target, 'ghost slot must resolve to a position');
  // 建议点位于原子 12px 宽容差之内 —— 这正是旧 atomsOnly 路径下幽灵永不可达的原因
  assert.ok(M.dist(target, { x: 0, y: 0 }) < 12 * f.adapter.modelPerPixel());
  assert.equal(f.controller.hitTest(target, { atomsOnly: true }).kind, 'atom');
  const hit = f.controller.hitTest(target, { atomsOnly: true, allowGhost: true });
  assert.ok(hit && hit.ghost === ghost, 'allowGhost must resolve the suggestion slot');
  const ev = { preventDefault() {}, stopPropagation() {}, shiftKey: false };
  f.controller.onLonePairDown(ev, target);
  assert.equal(f.model.state.lonePairs.length, 1);
  const lp = f.model.state.lonePairs[0];
  assert.equal(lp.origin, 'auto');
  assert.equal(lp.angle, 180);
  assert.equal(lp.refAtomId, neighbour);
  assert.equal(lp.angleRel, 180);
  assert.equal(f.controller.suppressedAuto.has(owner + '@180'), false,
    'materializing the suggestion clears its suppression key');
  assert.deepEqual(f.controller.ghostSlots, [],
    'the persisted suggestion must not keep a ghost twin (no double dot)');
  assert.ok(f.controller.selection.has(lp.id));
  // 点原子仍走原子分支：manual 起源、点击角度
  const manual = f.controller.onLonePairDown(ev, { x: 0, y: -0.15 });
  assert.equal(manual, undefined);
  assert.equal(f.model.state.lonePairs.length, 2);
  const manualLp = f.model.state.lonePairs[1];
  assert.equal(manualLp.origin, 'manual');
  assert.equal(Math.round(manualLp.angle), -90);
  assert.equal(f.controller.hitTest(target, { atomsOnly: true, allowGhost: true }).ghost, undefined,
    'after materialization the slot is a real lone pair, not a ghost');
});

test('select-all skips lone pairs whose owner atom is gone, same criterion as marquee', () => {
  const f = fixture();
  const calls = [];
  f.adapter.ed.selection = value => { if (value !== undefined) calls.push(value); return { atoms: [], bonds: [] }; };
  const arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 }, {});
  const live = M.makeLonePair(f.adapter.uuidOfAtom(0), { angle: 90 });
  const orphan = M.makeLonePair('at-deleted', { angle: 90 });
  f.model.addArrow(arrow);
  f.model.addLonePair(live);
  f.model.addLonePair(orphan);
  const ctx = f.controller.ctx();
  assert.equal(M.lonePairPosition(orphan, ctx), null, 'marquee criterion: position unresolvable');
  assert.ok(M.lonePairPosition(live, ctx));
  assert.equal(f.controller.selectAll(), true);
  assert.deepEqual(calls, ['all']);
  assert.equal(f.controller.selection.size, 2);
  assert.ok(f.controller.selection.has(arrow.id));
  assert.ok(f.controller.selection.has(live.id));
  assert.equal(f.controller.selection.has(orphan.id), false);
});

test('arrow copy/paste round-trip preserves the visual scale field', () => {
  const f = fixture();
  f.adapter.ed.selection = () => ({ atoms: [], bonds: [] });
  const arrow = M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 0 },
    { bend: 0.4, mode: 'manual', scale: 2.5 });
  f.model.addArrow(arrow);
  f.controller.selection = new Set([arrow.id]);
  const payload = f.controller.buildCopyPayload();
  assert.ok(payload && payload.arrows.length === 1, JSON.stringify(payload || {}));
  assert.equal(payload.arrows[0].scale, 2.5, 'copy payload carries scale');
  const pasted = f.controller.detachedArrows(payload, 1, 1);
  assert.equal(pasted.length, 1);
  assert.equal(pasted[0].scale, 2.5, 'paste must not reset a scaled arrow to 1x');
  assert.equal(pasted[0].geometry.bend, 0.4);
  assert.equal(pasted[0].geometry.mode, 'manual');
});
