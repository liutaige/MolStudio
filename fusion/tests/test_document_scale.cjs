'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
const { scaleStepRecord } = require('../workbench/agent-bridge.js');
const { DocumentController } = require('../workbench/document-controller.js');
const MW = global.MolWorkbench;
class Vec { constructor(x, y) { this.x = x; this.y = y; } }
class NativeText {
  constructor(x, y) { this.position = new Vec(x, y); this.pos = [new Vec(x, y), new Vec(x + 2, y + 1)]; }
  clone() { const next = new NativeText(this.position.x, this.position.y); next.pos = this.pos.map(p => new Vec(p.x, p.y)); return next; }
}
function fixture() {
  // 两个分子：0-1-2 三原子链 + 孤立原子 3；一个原生 text；一个文档对象
  const st = { atoms: new Map([[0, { pp: new Vec(1, 2) }], [1, { pp: new Vec(2, 2) }], [2, { pp: new Vec(3, 2) }], [3, { pp: new Vec(10, 10) }]]),
    bonds: new Map([[0, { begin: 0, end: 1, type: 1 }], [1, { begin: 1, end: 2, type: 1 }]]),
    texts: new Map([[0, new NativeText(4, 5)]]),
    rxnArrows: new Map(), rxnPluses: new Map(), simpleObjects: new Map(), images: new Map(), multitailArrows: new Map() };
  let selection = { atoms: [0], bonds: [], texts: [0] }, undo = [], redo = [];
  const visualScales = new Map();
  const ed = { render: { ctab: { markAtom() {}, markBond() {}, markItem() {} } }, struct: () => st,
    selection(value) { if (arguments.length) selection = value || {}; return selection; }, update() {} };
  const adapter = { ed, struct: () => st, atomPos: id => st.atoms.get(id)?.pp, uuidOfAtom: id => 'atom-' + id,
    uuidOfBond: id => 'bond-' + id, atomIdOf: id => /^atom-\d+$/.test(String(id)) ? Number(String(id).slice(5)) : null,
    clearSelection: () => ed.selection(null), modelPerPixel: () => .01, clientToModel: p => p, schedule() {},
    setAtomVisualScale(uuid, factor) { if (Number.isFinite(factor) && Math.abs(factor - 1) > 1e-9) visualScales.set(uuid, factor); else visualScales.delete(uuid); },
    effectiveAtomScale: uuid => visualScales.get(uuid) || 1, applyVisualScales() {}, syncVisualScalesFromDocument() {},
    pushAction(back, forward) { undo.push({ back, forward }); redo = []; } };
  const model = new MW.model.MechanismModel();
  const mechanism = { model, tool: 'select', selection: new Set(), setTool() {}, emitSelection() {}, render() {}, pruneSelection() {},
    flushNativeMarquee() {}, isCanvasTarget: () => true, hitTest: () => null,
    ctx: () => ({ atomPos: uuid => { const id = adapter.atomIdOf(uuid); return id === null ? null : st.atoms.get(id)?.pp; }, lonePair: id => model.lonePair(id) }),
    hasNativeSelection: () => Object.values(selection).some(a => Array.isArray(a) && a.length) };
  const c = new DocumentController({ adapter, mechanism, win: { molstudioNativeStructOps: { vec: Vec } }, doc: {}, iframe: {}, onStatus() {} });
  c.render = () => {};
  c.active = true;
  c.state.mode = 'paper'; // 选区缩放是纸页功能，单测默认在纸页模式下进行
  c.state.objects.push({ id: 'obj-note', kind: 'text', band: 'front', x: 5, y: 6, w: 10, h: 2, rotation: 0, rich: { text: 'note', fontSize: 12 } });
  const calls = { scale: [], restored: [] };
  MW.app = { reactionSteps: {
    captureRuntime: () => ({ connectors: new Map([['k', { id: 7, stepId: 'rs-1', reactants: [], products: [], labels: [
      { role: 'graphPort', layoutX: 3, layoutY: 4, anchorDx: 0.5, anchorDy: -0.25 }], start: { x: 0, y: 0 }, end: { x: 2, y: 0 },
      flow: { rowLeft: 1, rowY: 2, rowWidth: 8, arrowStartY: 3, anchors: [{ atomId: 'a', x: 1, y: 1 }] } }]]), operations: new Map() }),
    scaleRuntime: (state, options) => { calls.scale.push(options);
      const connectors = new Map();
      for (const [key, record] of state.connectors) connectors.set(key, { ...scaleStepRecord(record, { factor: options.factor, anchor: options.anchor, whole: true }), nativeArrow: record.nativeArrow });
      return { connectors, operations: new Map(state.operations || []) }; },
    restoreRuntime: state => { calls.restored.push(state); }
  } };
  return { c, st, model, visualScales, calls, undo: () => { const action = undo.pop(); action.back(); redo.push(action); },
    redo: () => { const action = redo.pop(); action.forward(); undo.push(action); }, history: () => undo.length };
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('选区沿键扩展到完整分子，几何 bake 缩放且一次撤销完整恢复', () => {
  const f = fixture();
  const arrow = MW.model.makeArrow({ type: 'free', x: 0, y: 0, last: { x: 0, y: 0 } }, { type: 'free', x: 4, y: 4, last: { x: 2, y: 1 } });
  f.model.addArrow(arrow); f.c.mechanism.selection.add(arrow.id);
  const lp = MW.model.makeLonePair('atom-1', { angle: 0 });
  f.model.addLonePair(lp);
  f.c.selection.add('obj-note');
  const result = f.c.scaleSelection(0.5, { anchor: { x: 0, y: 0 } });
  assert.equal(result, true);
  assert.equal(f.history(), 1);
  // 连通分量扩展：0-1-2 全部缩放，孤立原子 3 不动
  near(f.st.atoms.get(0).pp.x, 0.5); near(f.st.atoms.get(1).pp.x, 1); near(f.st.atoms.get(2).pp.x, 1.5);
  near(f.st.atoms.get(3).pp.x, 10); near(f.st.atoms.get(3).pp.y, 10);
  // 孤对半径缩放
  near(f.model.lonePair(lp.id).radius, 0.21);
  // 箭头 free 端点与 last 缩放；arrow.scale 记录因子
  near(f.model.arrow(arrow.id).source.x, 0); near(f.model.arrow(arrow.id).target.x, 2);
  near(f.model.arrow(arrow.id).target.y, 2);
  near(f.model.arrow(arrow.id).target.last.x, 1); near(f.model.arrow(arrow.id).target.last.y, 0.5);
  near(f.model.arrow(arrow.id).scale, 0.5);
  // atomScales 持久化 + 视觉通道
  for (const uuid of ['atom-0', 'atom-1', 'atom-2']) near(f.c.state.atomScales[uuid], 0.5);
  assert.equal(f.c.state.atomScales['atom-3'], undefined);
  near(f.visualScales.get('atom-0'), 0.5);
  // 原生 text 缩放
  near(f.st.texts.get(0).position.x, 2); near(f.st.texts.get(0).position.y, 2.5);
  near(f.st.texts.get(0).pos[1].x, 3); near(f.st.texts.get(0).pos[1].y, 3);
  // 文档对象缩放
  const o = f.c.object('obj-note');
  near(o.x, 2.5); near(o.y, 3); near(o.w, 5); near(o.h, 1);
  near(o.rich.fontSize, 6);
  // 反应步骤 runtime 收到正确的 factor/anchor/atomIds
  assert.equal(f.calls.scale.length, 1);
  near(f.calls.scale[0].factor, 0.5);
  assert.deepEqual(f.calls.scale[0].anchor, { x: 0, y: 0 });
  assert.deepEqual([...f.calls.scale[0].atomIds].sort(), [0, 1, 2]);
  // 一次撤销完整恢复
  f.undo();
  near(f.st.atoms.get(0).pp.x, 1); near(f.st.atoms.get(2).pp.x, 3);
  near(f.st.atoms.get(1).pp.x, 2);
  near(f.model.lonePair(lp.id).radius, 0.42);
  near(f.model.arrow(arrow.id).target.x, 4); near(f.model.arrow(arrow.id).scale, 1);
  near(f.model.arrow(arrow.id).target.last.x, 2); near(f.model.arrow(arrow.id).target.last.y, 1);
  assert.equal(f.c.state.atomScales?.['atom-0'], undefined);
  near(f.st.texts.get(0).position.x, 4);
  near(f.c.object('obj-note').x, 5); near(f.c.object('obj-note').w, 10);
  near(f.c.object('obj-note').rich.fontSize, 12);
  f.redo();
  near(f.st.atoms.get(2).pp.x, 1.5);
  near(f.c.object('obj-note').w, 5);
});

test('拖拽 Esc 取消精确恢复，且不进入撤销历史', () => {
  const f = fixture();
  const before = f.c.capture();
  const targets = f.c.selectionTargets();
  f.c.drag = { kind: 'scale', start: { x: 2, y: 2 }, before, targets, anchor: { x: 0, y: 0 }, moved: false };
  f.c.onMove({ clientX: 4, clientY: 4, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.drag.moved, true);
  near(f.st.atoms.get(0).pp.x, 2, 1e-6);
  f.c.cancelDrag();
  near(f.st.atoms.get(0).pp.x, 1);
  assert.equal(f.history(), 0);
  assert.equal(f.c.drag, null);
});

test('百分比会话以开始为基准，不累乘；每次确认一个撤销动作', () => {
  const f = fixture();
  f.c.beginScaleSession();
  assert.equal(f.c.currentSessionPercent(), 100);
  f.c.applyScalePercent(50);
  assert.equal(f.history(), 1);
  // 选区中心 (3.5, 4) 为锚点
  near(f.st.atoms.get(0).pp.x, 2.25);
  assert.equal(f.c.currentSessionPercent(), 50);
  f.c.applyScalePercent(200);
  assert.equal(f.history(), 2);
  // 200% 以会话基准为准：0.5 × 4 = 2 倍基准（同一锚点，距离 2.5 → 5）
  near(f.st.atoms.get(0).pp.x, -1.5);
  near(f.c.state.atomScales['atom-0'], 2);
  near(f.c.state.atomScales['atom-0'] || 0, 2);
  f.undo();
  near(f.st.atoms.get(0).pp.x, 2.25);
  f.c.endScaleSession();
});

test('document.atomScales 通过校验并拒绝非法值', () => {
  const doc = MW.documentModel.createDocument({ mode: 'paper' });
  doc.atomScales = { 'at-1': 0.5, 'at-2': 2.5 };
  assert.equal(MW.documentModel.validateDocument(doc).ok, true);
  for (const bad of [{ 'at-1': 0 }, { 'at-1': -1 }, { 'at-1': 101 }, { 'at-1': NaN }, { 'at-1': 'x' }]) {
    const probe = MW.documentModel.createDocument({ mode: 'paper' });
    probe.atomScales = bad;
    assert.equal(MW.documentModel.validateDocument(probe).ok, false, JSON.stringify(bad));
  }
  const big = MW.documentModel.createDocument({ mode: 'paper' });
  big.atomScales = {};
  for (let i = 0; i < 20001; i++) big.atomScales['at-' + i] = 1.5;
  assert.equal(MW.documentModel.validateDocument(big).ok, false);
});

test('arrow.scale 进入序列化并完整往返', () => {
  const arrow = MW.model.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 3, y: 0 }, { scale: 0.75 });
  const state = { lonePairs: [], arrows: [arrow], steps: [{ id: 'step-1', label: '步骤 1' }] };
  const text = JSON.stringify(MW.model.serializeMechanism(state));
  const round = MW.model.normalizeState(JSON.parse(text));
  near(round.arrows[0].scale, 0.75);
  const errs = MW.model.validateMechanism(round.arrows[0].scale === 0.75 ? round : round, []);
  assert.deepEqual(errs, []);
  const bad = MW.model.normalizeState({ lonePairs: [], arrows: [{ ...arrow, scale: -2 }], steps: [] });
  near(bad.arrows[0].scale, 1, 1e-12);
});

test('scaleStepRecord 精确换算整步字段（含 graphPort anchorDx/Dy）', () => {
  const record = { id: 7, start: { x: 0, y: 0 }, end: { x: 2, y: 0 }, reactants: [], products: [],
    labels: [{ role: 'graphPort', layoutX: 3, layoutY: 4, anchorDx: 0.5, anchorDy: -0.25 }],
    flow: { rowLeft: 1, rowY: 2, rowWidth: 8, arrowStartY: 3, anchors: [{ atomId: 'a', x: 1, y: 1 }] } };
  const scaled = scaleStepRecord(record, { factor: 0.5, anchor: { x: 0, y: 0 }, whole: true });
  near(scaled.start.x, 0); near(scaled.end.x, 1);
  near(scaled.flow.rowLeft, 0.5); near(scaled.flow.rowY, 1); near(scaled.flow.rowWidth, 4);
  near(scaled.flow.arrowStartY, 1.5);
  near(scaled.flow.anchors[0].x, 0.5); near(scaled.flow.anchors[0].y, 0.5);
  near(scaled.labels[0].layoutX, 1.5); near(scaled.labels[0].layoutY, 2);
  near(scaled.labels[0].anchorDx, 0.25); near(scaled.labels[0].anchorDy, -0.125);
  // 非 whole 步骤原样克隆
  const untouched = scaleStepRecord(record, { factor: 0.5, anchor: { x: 0, y: 0 }, whole: false });
  near(untouched.end.x, 2); near(untouched.flow.rowWidth, 8);
  near(untouched.labels[0].anchorDx, 0.5);
  assert.notEqual(untouched, record);
});


test('选区缩放是纸页模式专属：无边画布拒绝并提示', () => {
  const f = fixture();
  const st = f.c.adapter.struct();
  f.c.select(['atom-0']);
  f.c.state.mode = 'canvas';
  assert.throws(() => f.c.scaleSelection(1.25), /纸页/, 'canvas mode rejects scaleSelection');
  assert.throws(() => f.c.beginScaleSession(), /纸页/, 'canvas mode rejects beginScaleSession');
  assert.equal(f.c.hasScaleSelection(), false, 'canvas mode reports no scalable selection');
  // 3D 插入的纸页门禁在 wire-core 测试覆盖（需要 document-object-3d 模块）。
  f.c.state.mode = 'paper';
  assert.equal(f.c.hasScaleSelection(), true, 'paper mode restores scalable selection');
});

test('scaleMode 门禁：纸页+可缩放选区才能开启；模式/文档切换复位；Esc 退出', () => {
  const f = fixture();
  f.c.select(['atom-0']);
  assert.equal(f.c.setScaleMode(true), true);
  assert.equal(f.c.scaleMode, true);
  // 百分比会话幂等：重复 beginScaleSession 保留同一会话
  f.c.beginScaleSession();
  const session = f.c.scaleSession;
  assert.equal(f.c.beginScaleSession(), true);
  assert.equal(f.c.scaleSession, session);
  // 模式切换复位（emit 时检测非纸页）
  f.c.state.mode = 'canvas'; f.c.emit();
  assert.equal(f.c.scaleMode, false);
  assert.equal(f.c.scaleSession, null);
  f.c.state.mode = 'paper';
  // 文档切换复位
  assert.equal(f.c.setScaleMode(true), true);
  f.c.restore(f.c.getState());
  assert.equal(f.c.scaleMode, false);
  assert.equal(f.c.scaleSession, null);
  // Esc 退出
  assert.equal(f.c.setScaleMode(true), true);
  f.c.onKey({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.scaleMode, false);
  assert.equal(f.c.scaleSession, null);
  // 无可缩放选区 / 非纸页拒绝开启
  f.c.select([]);
  assert.equal(f.c.setScaleMode(true), false);
  f.c.state.mode = 'canvas';
  f.c.select(['atom-0']);
  assert.equal(f.c.setScaleMode(true), false);
});

test('scaleMode 激活时框内空白按下进入拖拽缩放；拖拽结束仍在缩放模式', () => {
  const f = fixture();
  f.c.select(['atom-0']);
  assert.equal(f.c.setScaleMode(true), true);
  const chem = f.c.selectionChemistryBounds();
  const sx = chem.x + chem.w / 2 + 0.4, sy = chem.y; // 框内空白且偏离锚点（夹具中选框是水平线）
  const xBefore = f.st.atoms.get(0).pp.x;
  f.c.onDown({ button: 0, clientX: sx, clientY: sy, target: {}, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.drag?.kind, 'scale', 'inner-frame press enters scale drag');
  f.c.onMove({ clientX: sx + 1, clientY: sy + 1, preventDefault() {}, stopImmediatePropagation() {} });
  assert.notEqual(f.st.atoms.get(0).pp.x, xBefore, 'applyScaleSnapshot path runs');
  f.c.onUp({ clientX: sx + 1, clientY: sy + 1, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.drag, null);
  assert.equal(f.history(), 1, 'one undo per scale drag');
  assert.equal(f.c.scaleMode, true, 'stays in scale mode after drag');
  f.c.setScaleMode(false);
  assert.equal(f.c.scaleMode, false);
});

test('scaleMode 关闭时不响应缩放手柄/框内拖拽', () => {
  const f = fixture();
  f.c.select(['atom-0']);
  f.c.onDown({ button: 0, clientX: 1, clientY: 2, target: {}, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(f.c.drag?.kind, undefined, 'no scale drag without scaleMode');
  f.c.drag = null;
});
