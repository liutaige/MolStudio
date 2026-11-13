/* 局部交互回归。运行：node fusion/tests/test_mechanism_interaction_regressions.cjs
 * 用固定字形边界验证语义/坐标，不代替真实浏览器鼠标验证。
 */
'use strict';
const assert = require('node:assert/strict');
for (const file of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-controller']) {
  require('../workbench/' + file + '.js');
}
const MW = globalThis.MolWorkbench, M = MW.model;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
function close(a, b) { assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`); }

function fixture(zoom = 1, hOnLeft = false) {
  const atoms = new Map([
    [0, { label: 'C', implicitH: 3, pp: { x: 0, y: 0 } }],
    [1, { label: 'O', implicitH: 1, charge: -1, pp: { x: -2, y: 0 } }],
    [2, { label: 'Br', implicitH: 0, pp: { x: 1, y: 0 } }]
  ]);
  const bonds = new Map([[0, { begin: 0, end: 2, type: 1 }]]);
  const path = (text, bb) => ({ type: 'text', node: { textContent: text }, getBBox: () => bb });
  const c = path('C', { x: -4, y: -7, width: 8, height: 14 });
  const h = path('H', { x: hOnLeft ? -21 : 5, y: -7, width: 9, height: 14 });
  const sub = path('3', { x: hOnLeft ? -12 : 14, y: -4, width: 7, height: 14 });
  const visAtoms = new Map([[0, { showLabel: true, label: { path: c }, visel: {
    boundingBox: { p0: { x: hOnLeft ? -21 : -4, y: -7 }, p1: { x: hOnLeft ? 4 : 21, y: 10 } }, paths: [c, h, sub]
  } }]]);
  const ed = { struct: () => ({ atoms, bonds }), render: { options: { bondLength: 40 }, ctab: { atoms: visAtoms } }, zoom: () => zoom };
  const adapter = new MW.adapter.KetcherAdapter({ editor: ed }, {});
  adapter.syncIdentity();
  const model = new M.MechanismModel();
  const statuses = [];
  const controller = new MW.controller.MechanismController({ adapter, model, layer: { render() {} },
    onStatus: t => statuses.push(t) });
  controller.refreshAutoSlots();
  const cId = adapter.uuidOfAtom(0), oId = adapter.uuidOfAtom(1), brId = adapter.uuidOfAtom(2);
  return { atoms, adapter, model, controller, statuses, cId, oId, brId, visAtoms };
}

test('CH₃ 的标签盒保留实际偏心位置，元素与隐式 H 分开', () => {
  const f = fixture(), b = f.adapter.context(f.model).atomLabelBox(f.cId);
  close(b.rect.x1, -0.1); close(b.rect.x2, 0.525);
  close(b.atomRect.x2, 0.1);
  assert.equal(b.hydrogenRects.length, 2);
  assert.equal(f.controller.hitTest({ x: 0, y: 0 }).kind, 'atom');
  assert.equal(f.controller.hitTest({ x: 0.23, y: 0 }).kind, 'implicitHydrogen');
  assert.equal(f.controller.hitTest({ x: 0.45, y: 0.1 }).kind, 'implicitHydrogen');
});

test('H₃C 的左侧 H 也不能误绑 C', () => {
  const f = fixture(1, true);
  assert.equal(f.controller.hitTest({ x: -0.4, y: 0 }).kind, 'implicitHydrogen');
  assert.equal(f.controller.hitTest({ x: 0, y: 0 }).kind, 'atom');
});

test('隐式 H 起笔/落笔都提示展开，不新建假原子/孤对/箭头', () => {
  const f = fixture();
  assert.equal(f.controller.resolveSource({ x: 0.23, y: 0 }), null);
  assert.match(f.controller.resolveHint, /隐式 H/);
  assert.equal(f.controller.resolveTarget({ x: 0.23, y: 0 }), null);
  assert.match(f.controller.resolveHint, /显式氢/);
  assert.equal(f.model.state.lonePairs.length, 0);
  assert.equal(f.model.state.arrows.length, 0);
});

test('普通甲基碳直接作为原子起笔，不偷偷补出孤对', () => {
  const f = fixture();
  const source = f.controller.resolveSource({ x: 0, y: 0 });
  assert.equal(source.endpoint.type, 'atom');
  assert.equal(source.endpoint.atomId, f.cId);
  assert.equal(source.pending, undefined);
  assert.equal(f.controller.resolveTarget({ x: 1, y: 0 }, false, source.endpoint).endpoint.type, 'atom');
  assert.equal(f.model.state.lonePairs.length, 0);
});

test('隐藏孤对时，中性 O 仍可从核验过的孤对起笔', () => {
  const f = fixture();
  f.atoms.get(1).charge = 0; f.atoms.get(1).implicitH = 2;
  f.controller.refreshAutoSlots();
  const s = f.controller.resolveSource({ x: -2, y: 0 });
  assert.equal(s.endpoint.type, 'lonePair');
  assert.equal(s.pending.origin, 'auto');
  assert.equal(f.model.state.lonePairs.length, 0);
});

test('负离子直接起笔到另一原子，保留待成键语义', () => {
  const f = fixture(), source = f.controller.resolveSource({ x: -2, y: 0 });
  assert.equal(source.endpoint.type, 'atom');
  f.controller.draft = { source: source.endpoint };
  const target = f.controller.resolveTarget({ x: 0, y: 0 });
  assert.equal(target.endpoint.type, 'formingBond');
  assert.equal(target.endpoint.atomA, f.oId);
  assert.equal(target.endpoint.atomB, f.cId);
});

test('同一原子的孤对不能反指自身制造小圈', () => {
  const f = fixture();
  f.controller.draft = { source: { type: 'lonePair', ownerAtomId: f.oId, slotId: 'pending' } };
  assert.equal(f.controller.resolveTarget({ x: -2, y: 0 }), null);
  assert.match(f.controller.resolveHint, /同一原子/);
});

test('邻近孤对不再遮住原子字形，点孤对自身仍可选中', () => {
  const f = fixture(), lp = M.makeLonePair(f.cId, { angle: 180, origin: 'manual' });
  f.model.addLonePair(lp);
  const p = M.lonePairPosition(lp, f.controller.ctx());
  assert.equal(f.controller.hitTest({ x: 0, y: 0 }).kind, 'atom');
  assert.equal(f.controller.hitTest(p).kind, 'lonePair');
});

test('缩小到 50% 时，键中点仍命中键而非相邻原子', () => {
  const f = fixture(0.5);
  f.visAtoms.get(0).showLabel = false;
  assert.equal(f.controller.hitTest({ x: 0.5, y: 0 }).kind, 'bond');
  assert.equal(f.controller.hitTest({ x: 0.08, y: 0 }).kind, 'atom');
});

test('悬停标签复用真实来源解析，原子与键的高亮不会说一套绑另一套', () => {
  const f = fixture();
  const atom = f.controller.resolveSourcePreview({ x: 0, y: 0 });
  assert.equal(atom.kind, 'atom'); assert.match(atom.label, /C原子/);
  const bond = f.controller.resolveSourcePreview({ x: 0.7, y: 0 });
  assert.equal(bond.kind, 'bond'); assert.match(bond.label, /C—Br 键/);
  assert.equal(f.controller.resolveSource({ x: 0.7, y: 0 }).endpoint.type, 'bond');
});

test('自动排布障碍使用真实标签范围而非围绕 C 对称造盒', () => {
  const f = fixture(), scene = MW.route.buildScene(f.controller.ctx(), f.model);
  const box = scene.labels.find(lb => lb.atomId === f.cId);
  close(box.rect.x1, -0.1); close(box.rect.x2, 0.525);
});

test('箭头按来向避让：CH₃ 左侧 C 不再被右边 H₃ 撑远', () => {
  const f = fixture(), ctx = f.controller.ctx();
  const arrow = M.makeArrow({ type: 'free', x: -2, y: 0 }, { type: 'atom', atomId: f.cId }, { bend: 0 });
  close(M.arrowGeometry(arrow, ctx).end.x, -0.21);
  arrow.source = { type: 'free', x: 0, y: -2 };
  close(M.arrowGeometry(arrow, ctx).end.y, -0.285);
});

test('从 H₃ 一侧进攻时，旧箭头和待成键箭头均绕过 H 与下标，箭尖指向 C', () => {
  for (const hOnLeft of [true, false]) {
    const f = fixture(1, hOnLeft), ctx = f.controller.ctx();
    f.atoms.get(1).pp.x = hOnLeft ? -1.65 : 1.65;
    const lp = M.makeLonePair(f.oId, { angle: hOnLeft ? 0 : 180 });
    f.model.addLonePair(lp);
    const source = { type: 'lonePair', ownerAtomId: f.oId, slotId: lp.id };
    const forming = { type: 'formingBond', atomA: f.oId, atomB: f.cId };
    const rects = ctx.atomLabelBox(f.cId).hydrogenRects;
    const missesHydrogen = p => rects.every(r => p.x < r.x1 || p.x > r.x2 || p.y < r.y1 || p.y > r.y2);
    for (const target of [forming, { type: 'atom', atomId: f.cId }]) {
      for (const bend of [-0.395, 0.395]) {
        const arrow = M.makeArrow(source, target, { electronCount: 2, bend, mode: 'manual' });
        const saved = JSON.stringify(arrow);
        const g = M.arrowGeometry(arrow, ctx);
        assert.equal(g.degenerate, false);
        assert.ok(M.dist(g.end, { x: 0, y: 0 }) < 0.4);
        const tan = M.quadTangent(g.start, g.control, g.end, 1);
        close(g.end.x * tan.y - g.end.y * tan.x, 0);
        assert.ok(g.end.x * tan.x + g.end.y * tan.y < 0);
        const length = Math.min(11 / 40, 0.34 * MW.route.arcLength(g.start, g.control, g.end));
        const head = Math.atan2(tan.y, tan.x) + Math.PI;
        for (let i = 0; i <= 100; i++) {
          const t = i / 100;
          assert.ok(missesHydrogen(M.quadPoint(g.start, g.control, g.end, t)));
          for (const angle of [head - 27 * Math.PI / 180, head + 27 * Math.PI / 180]) {
            assert.ok(missesHydrogen({ x: g.end.x + Math.cos(angle) * length * t,
              y: g.end.y + Math.sin(angle) * length * t }));
          }
        }
        assert.equal(JSON.stringify(arrow), saved);
      }
    }
    const fishhook = M.makeArrow(source, forming, { electronCount: 1, bend: 0.4 });
    assert.deepEqual(M.arrowGeometry(fishhook, ctx).end, { x: f.atoms.get(1).pp.x / 2, y: 0 });
  }
});

test('从 C 向 H₃ 一侧画弯箭头时，起点按切线贴在 C 而非 H 上', () => {
  const f = fixture(), ctx = f.controller.ctx();
  const arrow = M.makeArrow({ type: 'atom', atomId: f.cId }, { type: 'free', x: 2, y: 0 }, { bend: 0.5 });
  const geo = M.arrowGeometry(arrow, ctx);
  assert.ok(geo.start.x < 0.2 && geo.start.y > 0.1, JSON.stringify(geo));
  // 起点→控制点与 C→起点同向，故尾端确实离开 C。
  close((geo.start.x * geo.control.y) - (geo.start.y * geo.control.x), 0);
});

test('短弦不后撤原子起点；排布过滤贴字后切线反转的候选', () => {
  const f = fixture(), ctx = f.controller.ctx();
  const source = { type: 'atom', atomId: f.cId }, target = { type: 'free', x: -0.14, y: -0.15 };
  const invalid = M.arrowGeometry(M.makeArrow(source, target, { bend: -0.02 }), ctx);
  assert.equal(invalid.degenerate, true);
  assert.deepEqual(invalid.routingStart, { x: 0, y: 0 });
  const res = f.controller.planFor(source, target, 2);
  if (res) {
    for (const cand of res.plan.ranked) {
      const g = M.arrowGeometry(M.makeArrow(source, target, { bend: cand.bend }), ctx);
      assert.equal(g.degenerate, false);
      assert.ok(g.start.x * (g.control.x - g.start.x) + g.start.y * (g.control.y - g.start.y) > 0);
    }
  }
});

test('孤对按真实标签射线找边缘，缩放不重写标签结构边界', () => {
  const f = fixture(), ctx = f.controller.ctx();
  const left = M.lonePairPosition(M.makeLonePair(f.cId, { angle: 180 }), ctx);
  const right = M.lonePairPosition(M.makeLonePair(f.cId, { angle: 0 }), ctx);
  close(left.x, -0.19); close(right.x, 0.615);
  const f2 = fixture(2);
  assert.deepEqual(f.adapter.atomLabelBox(f.cId).rect, f2.adapter.atomLabelBox(f2.cId).rect);
});

test('草稿临时孤对保留相对邻居角度，预览与落盘锚点相同', () => {
  const f = fixture(), pending = { ownerAtomId: f.oId, angle: 0, refAtomId: f.cId, angleRel: 90 };
  const source = { type: 'lonePair', ownerAtomId: f.oId, slotId: '__pending__' };
  const target = { type: 'atom', atomId: f.brId };
  const preview = f.controller.planFor(source, target, 2, { pendingLp: pending });
  const lp = M.makeLonePair(f.oId, pending); f.model.addLonePair(lp);
  const geo = M.arrowGeometry(M.makeArrow({ ...source, slotId: lp.id }, target), f.controller.ctx());
  close(preview.geo.start.x, geo.start.x); close(preview.geo.start.y, geo.start.y);
});

test('改元素/电荷/键级后清掉障碍缓存', () => {
  const f = fixture(); f.controller._scene = { key: 'stale' };
  f.controller.onAdapterChange('struct');
  assert.equal(f.controller._scene, null);
});

test('没有有效排布的草稿不得静默变成直箭头', () => {
  const f = fixture();
  f.controller.draft = { source: { type: 'atom', atomId: f.oId }, target: { type: 'atom', atomId: f.cId }, bend: null };
  f.controller.finishDraft();
  assert.equal(f.model.state.arrows.length, 0);
  assert.equal(f.model.state.lonePairs.length, 0);
});

test('Ketcher 隐藏剪贴板框获得焦点时 Esc 仍取消机理草稿', () => {
  const f = fixture(); f.controller.draft = { source: { type: 'atom', atomId: f.cId } };
  const target = { tagName: 'TEXTAREA', getAttribute: key => key === 'data-cliparea' ? 'true' : null };
  f.controller.onKeyDown({ key: 'Escape', target, preventDefault() {}, stopPropagation() {} });
  assert.equal(f.controller.draft, null);
});

test('原生画键快捷键接管时退出机理工具，真实文字输入不被接管', () => {
  const f = fixture(); f.controller.tool = 'arrow2';
  f.controller.onKeyDown({ key: '1', target: { tagName: 'TEXTAREA', getAttribute: () => 'true' } });
  assert.equal(f.controller.tool, 'select');
  f.controller.tool = 'arrow2';
  f.controller.onKeyDown({ key: '1', target: { tagName: 'INPUT' } });
  assert.equal(f.controller.tool, 'arrow2');
});

test('鱼钩可用 Option 提交空白自由端点，保留单电子、坐标与统一历史', () => {
  const f = fixture(), point = { x: -3, y: 2 }, history = [];
  f.adapter.pushAction = (undo, redo) => history.push({ undo, redo });
  f.controller.tool = 'arrow1';
  const source = { type: 'atom', atomId: f.cId };
  assert.equal(f.controller.resolveTarget(point, false, source), null);
  const target = f.controller.resolveTarget(point, true, source);
  assert.deepEqual(target.endpoint, { type: 'free', x: -3, y: 2 });
  const planned = f.controller.planFor(source, target.endpoint, 1);
  assert.ok(planned && Number.isFinite(planned.plan.bend));
  f.controller.draft = { source, target: target.endpoint, bend: planned.plan.bend, electronCount: 1 };
  f.controller.finishDraft(true);
  const arrow = f.model.state.arrows[0];
  assert.equal(arrow.electronCount, 1);
  assert.deepEqual(arrow.target, { type: 'free', x: -3, y: 2 });
  const saved = M.serializeMechanism(f.model.state), errors = [];
  M.validateMechanism(saved, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(saved.arrows[0].target, { type: 'free', x: -3, y: 2 });
  assert.equal(history.length, 1);
  history[0].undo(); assert.equal(f.model.state.arrows.length, 0);
  history[0].redo(); assert.deepEqual(f.model.state.arrows[0].target, arrow.target);
});

test('已有自由端点可不按 Option 拖到另一空白处', () => {
  const f = fixture(), history = [];
  f.adapter.pushAction = (undo, redo) => history.push({ undo, redo });
  const arrow = M.makeArrow({ type: 'atom', atomId: f.cId }, { type: 'free', x: -3, y: 2 },
    { electronCount: 1, mode: 'manual', bend: 0.5 });
  f.model.addArrow(arrow);
  f.controller.finishEndpointDrag({ kind: 'arrow-end', handle: { arrow } }, { x: -4, y: 3 }, false);
  assert.deepEqual(f.model.state.arrows[0].target, { type: 'free', x: -4, y: 3 });
  assert.equal(f.model.state.arrows[0].electronCount, 1);
  assert.equal(history.length, 1);
});

test('绑定端点需 Option 才转换为空白自由端点，按住 Option 时仍优先命中真实原子', () => {
  const f = fixture(), history = [];
  f.adapter.pushAction = (undo, redo) => history.push({ undo, redo });
  const source = { type: 'bond', bondId: f.adapter.uuidOfBond(0), component: 'sigma' };
  const arrow = M.makeArrow(source, { type: 'atom', atomId: f.brId }, { electronCount: 1, mode: 'manual', bend: 1 });
  f.model.addArrow(arrow);
  f.controller.finishEndpointDrag({ kind: 'arrow-end', handle: { arrow } }, { x: -4, y: 3 }, false);
  assert.equal(f.model.state.arrows[0].target.type, 'atom');
  assert.equal(history.length, 0);
  assert.equal(f.controller.resolveTarget({ x: 0, y: 0 }, true, source).endpoint.type, 'atom');
  f.controller.finishEndpointDrag({ kind: 'arrow-end', handle: { arrow } }, { x: -4, y: 3 }, true);
  assert.deepEqual(f.model.state.arrows[0].target, { type: 'free', x: -4, y: 3 });
  assert.equal(history.length, 1);
});

console.log(`\nInteraction regressions: ${passed} PASS`);
