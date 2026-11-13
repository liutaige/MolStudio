/* Pure geometry regressions for detached arrow copies; no browser automation. */
'use strict';
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/workbench-storage.js');
const M = globalThis.MolWorkbench.model;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`); }
function fixture(zoom = 1) {
  const atoms = { c: { x: 0, y: 0 }, o: { x: 1.6, y: 0.8 } };
  return { atomPos: id => atoms[id], unit: () => 1 / (40 * zoom),
    atomLabelBox: id => {
      const p = atoms[id], w = id === 'c' ? 0.09 : 0.25;
      const rect = { x1: p.x - w, x2: p.x + w, y1: p.y - 0.16, y2: p.y + 0.16 };
      return { hasLabel: true, rect, atomRect: rect, hwCss: w * 40 * zoom, hhCss: 6.4 * zoom };
    }
  };
}
function detached(arrow, ctx, offset = { x: 3, y: 2 }) {
  const g = M.arrowGeometry(arrow, ctx);
  const d = { x: g.end.x - g.start.x, y: g.end.y - g.start.y };
  const v = { x: g.control.x - g.start.x, y: g.control.y - g.start.y };
  const len2 = d.x * d.x + d.y * d.y;
  const controlFrame = { along: (d.x * v.x + d.y * v.y) / len2,
    normal: (d.x * v.y - d.y * v.x) / len2 };
  return M.makeArrow({ type: 'free', x: g.start.x + offset.x, y: g.start.y + offset.y },
    { type: 'free', x: g.end.x + offset.x, y: g.end.y + offset.y },
    { ...arrow.geometry, electronCount: arrow.electronCount, controlFrame });
}

test('弯箭头和鱼钩脱离非对称原子标签后，整条曲线与箭尖切线保持平移一致', () => {
  for (const electronCount of [1, 2]) {
    const ar = M.makeArrow({ type: 'atom', atomId: 'c' }, { type: 'atom', atomId: 'o' },
      { electronCount, bend: -0.7, mode: 'manual' });
    const original = M.arrowGeometry(ar, fixture());
    const copy = detached(ar, fixture());
    const geo = M.arrowGeometry(copy, fixture());
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const a = M.quadPoint(original.start, original.control, original.end, t);
      const b = M.quadPoint(geo.start, geo.control, geo.end, t);
      near(b.x - a.x, 3); near(b.y - a.y, 2);
    }
    const a = M.quadTangent(original.start, original.control, original.end, 1);
    const b = M.quadTangent(geo.start, geo.control, geo.end, 1);
    near(a.x, b.x); near(a.y, b.y);
    assert.equal(copy.electronCount, electronCount);
    assert.equal(copy.geometry.bend, ar.geometry.bend);
  }
});

test('自由副本缩放不改曲线或存档，移动端点后仍保留相对曲线形状', () => {
  const ar = M.makeArrow({ type: 'atom', atomId: 'c' }, { type: 'atom', atomId: 'o' }, { bend: 0.5 });
  const copy = detached(ar, fixture()), before = JSON.stringify(copy);
  const g = M.arrowGeometry(copy, fixture());
  assert.deepEqual(M.arrowGeometry(copy, fixture(4)), g);
  assert.equal(JSON.stringify(copy), before);
  for (const ep of [copy.source, copy.target]) { ep.x *= 2; ep.y *= 2; }
  const doubled = M.arrowGeometry(copy, fixture());
  near(doubled.control.x, 2 * g.control.x); near(doubled.control.y, 2 * g.control.y);
});

test('保存和重新加载保留自由副本完整曲线，旧箭头不新增可选字段', () => {
  const original = M.makeArrow({ type: 'atom', atomId: 'c' }, { type: 'atom', atomId: 'o' }, { bend: -0.7 });
  const copy = detached(original, fixture());
  const state = M.emptyState(); state.arrows.push(copy, original);
  const saved = M.serializeMechanism(state), restored = new M.MechanismModel(saved);
  assert.ok(restored.state.arrows[0].geometry.controlFrame);
  assert.ok(!Object.hasOwn(saved.arrows[1].geometry, 'controlFrame'));
  const errs = []; M.validateMechanism(saved, errs); assert.deepEqual(errs, []);
  const a = M.arrowGeometry(copy, fixture()), b = M.arrowGeometry(restored.state.arrows[0], fixture());
  assert.ok(M.dist(a.control, b.control) < 0.00001);
});

test('非法自由曲线参数被载入校验拒绝，重新绑定时不覆盖正常原子避让', () => {
  const ar = M.makeArrow({ type: 'atom', atomId: 'c' }, { type: 'atom', atomId: 'o' }, { bend: 0.4 });
  const plain = M.arrowGeometry(ar, fixture());
  ar.geometry.controlFrame = { along: 4, normal: 9 };
  assert.deepEqual(M.arrowGeometry(ar, fixture()), plain);
  ar.geometry.controlFrame.normal = NaN;
  const state = M.emptyState(); state.arrows.push(ar);
  const errs = []; M.validateMechanism(state, errs);
  assert.ok(errs.some(e => e.includes('controlFrame')));
});

console.log(`\nArrow copy geometry: ${passed} PASS`);
