/* π 断裂的弧高偏好和原子间隙回归；纯几何测试，不替代真实画布验收。 */
'use strict';
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
require('../workbench/mechanism-controller.js');
const M = globalThis.MolWorkbench.model, R = globalThis.MolWorkbench.route;
const { MechanismController } = globalThis.MolWorkbench.controller;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }

function fixture(angle = -Math.PI / 6, zoom = 1) {
  const p = { c: { x: 0, y: 0 }, o: { x: Math.cos(angle), y: Math.sin(angle) },
    left: { x: -Math.sqrt(3) / 2, y: -0.5 }, down: { x: 0, y: 1 }, nu: { x: -1.8, y: 0.75 } };
  const bonds = [
    { uuid: 'co', type: 2, begin: p.c, end: p.o, beginAtom: 'c', endAtom: 'o' },
    { uuid: 'left', type: 1, begin: p.c, end: p.left, beginAtom: 'c', endAtom: 'left' },
    { uuid: 'down', type: 1, begin: p.c, end: p.down, beginAtom: 'c', endAtom: 'down' }
  ];
  const ctx = {
    atomPos: id => p[id], bondInfo: id => bonds.find(b => b.uuid === id), unit: () => 1 / (40 * zoom),
    atomLabelBox: id => {
      if (id !== 'o' && id !== 'nu') return { hasLabel: false };
      const rect = { x1: p[id].x - 0.125, y1: p[id].y - 0.175, x2: p[id].x + 0.125, y2: p[id].y + 0.175 };
      return { hasLabel: true, rect, atomRect: rect, hwCss: 5 * zoom, hhCss: 7 * zoom };
    },
    atoms: () => Object.keys(p).map(id => ({ uuid: id, label: id === 'o' || id === 'nu' ? 'O' : 'C', pos: p[id] })),
    bonds: () => bonds
  };
  return { ctx, p, scene: R.buildScene(ctx, null) };
}

function plan(f, source, target, electrons = 2) {
  const geometry = bend => M.arrowGeometry({ source, target, electronCount: electrons, geometry: { bend } }, f.ctx);
  const geo = geometry(0);
  const result = R.planArrow({ a: geo.routingStart, b: geo.routingEnd, source, target, electronCount: electrons,
    scene: f.scene, geometry, targetDir: R.resolveTargetDir(target, f.ctx, geo.end) });
  assert.ok(result.ranked.length, 'fixture must have valid candidates');
  return { ...result, geo: geometry(result.bend) };
}

const piSource = { type: 'bond', bondId: 'co', component: 'pi' }, oTarget = { type: 'atom', atomId: 'o' };

test('AI 排线在已有弯箭头旁优先选择无交叉的可行弧', () => {
  const a = { x: 0, y: 0 }, b = { x: 1, y: 0 };
  const scene = { L: 1, labels: [], bonds: [], lonePairs: [],
    arrows: [{ points: [{ x: 0.471, y: -0.95 }, { x: 0.473, y: 0.95 }], length: 1.9 }] };
  assert.equal(R.planArrow({ a, b, scene }).ranked[0].arrowHits, 1);
  const preferred = R.planArrow({ a, b, scene, preferClearArrows: true });
  assert.equal(preferred.feasible, true);
  assert.equal(preferred.ranked[0].arrowHits, 0);
});

function maxDistanceFromBond(geo, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  let max = 0;
  for (let i = 0; i <= 100; i++) {
    const p = M.quadPoint(geo.start, geo.control, geo.end, i / 100);
    max = Math.max(max, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / d);
  }
  return max;
}

test('常规羰基 π→O 的弯箭头和鱼钩都保留明显拱起', () => {
  const f = fixture(), pi = plan(f, piSource, oTarget), fishhook = plan(f, piSource, oTarget, 1);
  assert.ok(pi.ranked[0].h >= 0.40 - 1e-8);
  assert.ok(fishhook.ranked[0].h >= 0.40 - 1e-8);
  assert.ok(maxDistanceFromBond(fishhook.geo, f.p.c, f.p.o) >= 0.40);
  assert.equal(pi.feasible, true);
});

test('相邻的 σ 键→端原子同样保留足够弧高', () => {
  const f = fixture(), sigma = plan(f, { ...piSource, component: 'sigma' }, oTarget);
  assert.ok(sigma.ranked[0].h >= 0.40 - 1e-8);
  assert.ok(plan(f, { ...piSource, component: 'sigma' }, oTarget, 1).ranked[0].h >= 0.40 - 1e-8);
});

test('远距 O 进攻 C 维持较缓弧高，尖端更靠近骨架 C', () => {
  const f = fixture(), attack = plan(f, { type: 'atom', atomId: 'nu' }, { type: 'formingBond', atomA: 'nu', atomB: 'c' });
  assert.ok(attack.ranked[0].h >= 0.20 && attack.ranked[0].h <= 0.32);
  assert.ok(attack.bend > 0);
  assert.ok(Math.abs(M.dist(attack.geo.end, f.p.c) - 0.18) < 1e-8);
  assert.equal(attack.feasible, true);
});

test('仅空间靠近不一律抬高，直接相连的原子短转移才套用邻近规则', () => {
  const f = fixture(), source = { type: 'atom', atomId: 'c' };
  const adjacent = plan(f, source, oTarget);
  f.scene.bonds = f.scene.bonds.filter(b => b.id !== 'co');
  const unconnected = plan(f, source, oTarget);
  assert.ok(adjacent.ranked[0].h >= 0.40 - 1e-8);
  assert.ok(unconnected.ranked[0].h < 0.40);
});

test('两电子进攻落点按受体留白，不再随供体拉远而退离 C；鱼钩仍落中点', () => {
  const f = fixture(), target = { type: 'formingBond', atomA: 'nu', atomB: 'c' }, source = { type: 'atom', atomId: 'nu' };
  for (const d of [2, 4, 6]) {
    f.p.nu = { x: -d, y: 0 };
    assert.ok(Math.abs(M.dist(M.formingBondLanding(target, source, 2, f.ctx), f.p.c) - 0.18) < 1e-8);
    assert.ok(Math.abs(M.dist(M.formingBondLanding(target, source, 1, f.ctx), f.p.c) - d / 2) < 1e-8);
  }
});

test('抬高是偏好；两侧受阻时优先选择不压字的低弧', () => {
  const f = fixture(0);
  f.scene.labels.push(
    { atomId: 'upper-obstacle', rect: { x1: 0.45, y1: -2, x2: 1.3, y2: -0.45 } },
    { atomId: 'lower-obstacle', rect: { x1: 0.45, y1: 0.45, x2: 1.3, y2: 2 } }
  );
  const result = plan(f, piSource, oTarget);
  assert.equal(result.feasible, true);
  assert.ok(result.ranked[0].h < 0.25);
});

test('原子箭尾与字形的间隙为 0.11 键长，不随 zoom 改写', () => {
  const f = fixture(), source = { type: 'atom', atomId: 'nu' }, target = { type: 'free', x: -0.8, y: 0.75 };
  const arrow = M.makeArrow(source, target, { bend: 0 });
  const g = M.arrowGeometry(arrow, f.ctx), g4 = M.arrowGeometry(arrow, fixture(-Math.PI / 6, 4).ctx);
  assert.ok(Math.abs(g.start.x - (f.p.nu.x + 0.125 + 0.11)) < 1e-8);
  assert.deepEqual(g.start, g4.start);
});

test('新弧高偏好不会修改已保存的手动曲率', () => {
  const f = fixture(), arrow = M.makeArrow(piSource, oTarget, { mode: 'manual', bend: 0.6 });
  const saved = JSON.stringify(arrow);
  M.arrowGeometry(arrow, f.ctx);
  plan(f, piSource, oTarget);
  assert.equal(JSON.stringify(arrow), saved);
});

function concertedFixture() {
  const f = fixture(-Math.PI / 2);
  Object.assign(f.p.left, { x: -0.866, y: 0.5 });
  Object.assign(f.p.down, { x: 0.866, y: 0.5 });
  Object.assign(f.p.nu, { x: 0.6, y: -2.4 });
  f.p.et = { x: 1.46, y: -2.9 };
  f.p.me = { x: 2.33, y: -2.4 };
  f.ctx.bonds().push(
    { uuid: 'et', type: 1, begin: f.p.nu, end: f.p.et, beginAtom: 'nu', endAtom: 'et' },
    { uuid: 'me', type: 1, begin: f.p.et, end: f.p.me, beginAtom: 'et', endAtom: 'me' }
  );
  f.ctx.atomLabelBox = id => {
    if (!['o', 'nu', 'left', 'down', 'me'].includes(id)) return { hasLabel: false };
    const p = f.p[id], box = (l, r) => ({ x1: p.x - l, y1: p.y - 0.16, x2: p.x + r, y2: p.y + 0.16 });
    return { hasLabel: true, rect: box(id === 'nu' ? 0.42 : 0.15, id === 'o' ? 0.45 : 0.18),
      atomRect: box(0.15, 0.18), hwCss: 8, hhCss: 6.4 };
  };
  const lp = { id: 'lp', ownerAtomId: 'nu', angle: 70, origin: 'manual' };
  f.ctx.lonePair = id => id === lp.id ? lp : null;
  const model = { state: { arrows: [], lonePairs: [lp] }, arrow(id) { return this.state.arrows.find(ar => ar.id === id); } };
  const controller = new MechanismController({ adapter: { context: () => f.ctx }, model });
  const attack = M.makeArrow({ type: 'lonePair', slotId: lp.id, ownerAtomId: lp.ownerAtomId }, { type: 'atom', atomId: 'c' });
  const shift = M.makeArrow(piSource, oTarget);
  const side = (arrow, t) => {
    const g = M.arrowGeometry(arrow, f.ctx);
    return R.sideOfBond(M.quadPoint(g.start, g.control, g.end, t), f.ctx.bondInfo('co'));
  };
  const append = arrow => { model.state.arrows.push(arrow); controller.replanArrowInPlace(arrow, true); };
  return { attack, shift, controller, side, append };
}

test('羰基进攻和 π→O 移电子按实际键分到异侧，换提交顺序也得到相同曲线', () => {
  const bends = [];
  for (const reverse of [false, true]) {
    const { attack, shift, controller, side, append } = concertedFixture();
    const arrows = reverse ? [shift, attack] : [attack, shift];
    arrows.forEach(append);
    controller.replanConcertedArrows(arrows.map(ar => ar.id));
    assert.equal(side(attack, 0.82) * side(shift, 0.5), -1);
    bends.push([attack.geometry.bend, shift.geometry.bend]);
  }
  assert.deepEqual(bends[0], bends[1]);
});

test('稍后补画进攻也会分侧，手调曲率和独立箭头仍保留', () => {
  const { attack, shift, controller, side, append } = concertedFixture();
  append(shift);
  const singleBend = shift.geometry.bend;
  assert.equal(controller.replanConcertedArrows([shift.id]).size, 0);
  assert.equal(shift.geometry.bend, singleBend);
  append(attack);
  shift.geometry.mode = 'manual';
  controller.replanConcertedArrows([attack.id]);
  assert.equal(shift.geometry.bend, singleBend);
  shift.geometry.mode = 'auto';
  controller.replanConcertedArrows([attack.id]);
  assert.equal(side(attack, 0.82) * side(shift, 0.5), -1);
});

test('手动选择两根旧箭头重新排布时也会分侧', () => {
  const { attack, shift, controller, side, append } = concertedFixture();
  [attack, shift].forEach(append);
  controller.selection = new Set([attack.id, shift.id]);
  controller.commit = mutate => mutate();
  assert.equal(controller.replanSelection(), true);
  assert.equal(side(attack, 0.82) * side(shift, 0.5), -1);
});

console.log(`\nPi arrow layout: ${passed} PASS`);
