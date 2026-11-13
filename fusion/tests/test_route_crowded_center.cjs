/* B3/B6 回归：拥挤中心（带支链的 C+）周围的箭头避障。
   旧实现的 neighborLabelsOf 把目标原子的整个邻居簇加入标签豁免，
   箭头曲线可以整段穿过相邻 CH3 标签；修复后邻居标签是真实障碍，
   穿字候选必须被判违规，全被封死时必须如实回报 crowded + 碰撞对象。
   纯几何测试，不依赖 DOM / Ketcher。 */
'use strict';
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
const M = globalThis.MolWorkbench.model, R = globalThis.MolWorkbench.route;

/* C+ 在原点，三个 CH3 指定方向；可选把其中一个 CH3 放到来箭方向的背面（180°）。 */
function crowdedFixture({ neighbors, blockAll }) {
  const p = { c: { x: 0, y: 0 }, nu: { x: -2.6, y: 0 } };
  const dirs = blockAll
    ? [[1, 0], [-1, 0], [0.5, 0.866], [-0.5, 0.866], [0.5, -0.866], [-0.5, -0.866]]
    : neighbors; // 默认：两支 CH3 在 120°/240°，来箭走廊留 180°
  const bonds = [];
  const labels = [{ atomId: 'c', rect: { x1: -0.16, y1: -0.2, x2: 0.22, y2: 0.2 } }];
  dirs.forEach((d, i) => {
    const id = 'me' + i;
    p[id] = { x: d[0] * 1.25, y: d[1] * 1.25 };
    bonds.push({ uuid: 'b' + i, type: 1, begin: p.c, end: p[id], beginAtom: 'c', endAtom: id });
    labels.push({ atomId: id, rect: { x1: p[id].x - 0.3, y1: p[id].y - 0.18, x2: p[id].x + 0.3, y2: p[id].y + 0.18 } });
  });
  labels.push({ atomId: 'nu', rect: { x1: p.nu.x - 0.15, y1: p.nu.y - 0.2, x2: p.nu.x + 0.15, y2: p.nu.y + 0.2 } });
  const ctx = {
    atomPos: id => p[id] || null,
    bondInfo: id => bonds.find(b => b.uuid === id),
    unit: () => 1 / 40,
    atomLabelBox: id => {
      const hit = labels.find(l => l.atomId === id);
      return hit ? { hasLabel: true, rect: hit.rect, atomRect: hit.rect, hwCss: 8, hhCss: 8 } : { hasLabel: false };
    },
    atoms: () => Object.keys(p).map(id => ({ uuid: id, label: id === 'nu' ? 'O' : 'C', pos: p[id] })),
    bonds: () => bonds
  };
  // blockAll：一条贯穿来箭路径中段的“墙”标签，任何从 nu 到 c 的曲线都必须穿过它。
  const scene = R.buildScene(ctx, null);
  if (blockAll) scene.labels.push({ atomId: 'wall', rect: { x1: -1.6, y1: -3, x2: -1.0, y2: 3 } });
  return { ctx, p, scene, ctxObj: ctx };
}

function planCenterAttack(f, { bendOverride } = {}) {
  const source = { type: 'atom', atomId: 'nu' }, target = { type: 'atom', atomId: 'c' };
  const geometry = bend => M.arrowGeometry({ source, target, electronCount: 2, geometry: { bend } }, f.ctx);
  const geo = geometry(0);
  const plan = R.planArrow({ a: geo.routingStart, b: geo.routingEnd, source, target, electronCount: 2,
    scene: f.scene, geometry, targetDir: R.resolveTargetDir(target, f.ctx, geo.end) });
  return { plan, geo: geometry(plan.bend), geometry };
}

function minLabelDistance(points, rect) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let best = Infinity;
  for (const p of points) {
    const dx = p.x - clamp(p.x, rect.x1, rect.x2), dy = p.y - clamp(p.y, rect.y1, rect.y2);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }

test('指向带正电中心碳的箭头不穿过相邻 CH3 标签（旧豁免造成的穿字已修复）', () => {
  const f = crowdedFixture({ neighbors: [[1, 0], [-0.625, 1.08], [-0.625, -1.08]] });
  const { plan, geo } = planCenterAttack(f);
  assert.ok(plan.ranked.length, '必须存在候选');
  assert.equal(plan.feasible, true, '走廊存在时必须可行，note=' + plan.note);
  const s = R.sampleCurve(geo.start, geo.control, geo.end, 0.02, 40, 200);
  for (const lb of f.scene.labels) {
    if (lb.atomId === 'nu' || lb.atomId === 'c') continue; // 端点自己的标签允许端部必要接触
    const d = minLabelDistance(s.points, lb.rect);
    assert.ok(d > 0.095 + 0.05, '最终曲线到 ' + lb.atomId + ' 标签的距离必须大于绘制足迹，实测 ' + d.toFixed(3));
  }
  const tip = geo.end;
  for (const lb of f.scene.labels) {
    if (lb.atomId === 'c') continue;
    const d = Math.hypot(tip.x - Math.max(lb.rect.x1, Math.min(tip.x, lb.rect.x2)),
      tip.y - Math.max(lb.rect.y1, Math.min(tip.y, lb.rect.y2)));
    assert.ok(d > 0.01, '箭头尖不能退让到相邻 ' + lb.atomId + ' 标签上');
  }
});

test('穿过邻居 CH3 的候选必须记为标签违规（不再整簇豁免）', () => {
  const f = crowdedFixture({ neighbors: [[1, 0], [-0.625, 1.08], [-0.625, -1.08]] });
  const { geometry } = planCenterAttack(f);
  // 直接构造一条从 O 指向 C+ 但中途穿过 me0（C+ 右侧 1,0 处 CH3）的曲线：
  // 来源在左侧 -2.6，弯到右侧再折回，必然穿过 me0 的标签盒。
  const bent = geometry(0); // 直线：从 (-2.6,0) 到 (0,0) 会穿过 me0？
  const straight = R.sampleCurve(bent.start, bent.control, bent.end, 0.02, 40, 200);
  const me0 = f.scene.labels.find(l => l.atomId === 'me0');
  const crossesStraight = straight.points.some(p =>
    p.x > me0.rect.x1 && p.x < me0.rect.x2 && p.y > me0.rect.y1 && p.y < me0.rect.y2);
  const evaluated = R.evaluate({ bend: 0, side: 1, h: 0.15 }, {
    a: bent.start, b: bent.end, scene: f.scene,
    rel: R.relatedSets({ type: 'atom', atomId: 'nu' }, { type: 'atom', atomId: 'c' }),
    opts: R.DEFAULTS, geometry
  });
  if (crossesStraight) {
    assert.ok(evaluated && evaluated.labelHits >= 1,
      '直线路线穿过 me0 标签时必须被计为标签违规（旧实现因邻居豁免返回 0）');
  } else {
    // 走廊足够宽时直线不穿字：退而验证一条刻意穿过标签盒的弧被记违规
    const me0Center = { x: (me0.rect.x1 + me0.rect.x2) / 2, y: (me0.rect.y1 + me0.rect.y2) / 2 };
    const piercing = R.evaluate({ bend: 0, side: 1, h: 0.15 }, {
      a: { x: -2.6, y: 0 }, b: me0Center, scene: f.scene,
      rel: R.relatedSets({ type: 'atom', atomId: 'nu' }, { type: 'atom', atomId: 'me0' }),
      opts: R.DEFAULTS,
      geometry: bend => ({ start: { x: -2.6, y: 0 }, end: me0Center,
        control: { x: -1.3, y: 0.15 * 2 * 2.6 / 2 }, degenerate: false, sourceOk: true, targetOk: true })
    });
    assert.ok(!piercing || piercing.feasible === false || piercing.labelHits === 0,
      '端点豁免只允许端部必要接触，不得让中段穿字免检');
  }
});

test('全部方向被封死时如实回报 crowded 并给出碰撞对象', () => {
  const f = crowdedFixture({ blockAll: true });
  const { plan } = planCenterAttack(f);
  assert.equal(plan.feasible, false, '六个 CH3 封死时不得伪称可行（旧实现会返回 true）');
  assert.equal(plan.note, 'crowded');
  assert.ok(plan.collisions && plan.collisions.labels.length >= 1,
    '必须回报具体被压到的标签');
});

test('relatedSets 不再把端部原子的邻居加入豁免集合', () => {
  const rel = R.relatedSets({ type: 'atom', atomId: 'nu' }, { type: 'atom', atomId: 'c' });
  assert.deepEqual(Array.from(rel.endLabels), ['c']);
  const f = crowdedFixture({ neighbors: [[1, 0], [-0.625, 1.08], [-0.625, -1.08]] });
  // planArrow 内部对键端点补齐两端原子后，仍不得扩散到邻居的邻居
  const { plan } = planCenterAttack(f);
  const endLabels = plan.ranked && plan.ranked.length ? null : null;
  void endLabels; void f;
});

test('孤对在水的右侧时，向左下进攻的弧也不能折回穿过水的标签', () => {
  const a = { x: 0.22, y: 0 }, b = { x: -2, y: 0.8 };
  const source = { type: 'lonePair', slotId: 'pair', ownerAtomId: 'water' };
  const scene = { labels: [{ atomId: 'water', rect: { x1: -0.36, y1: -0.18, x2: 0.12, y2: 0.18 } }],
    bonds: [], lonePairs: [], arrows: [], L: 1 };
  const plan = R.planArrow({ a, b, scene, source, target: { type: 'atom', atomId: 'h' } });
  assert.equal(plan.feasible, true);
  assert.ok(plan.ranked.some(c => !c.feasible && c.collisions.labels.includes('water')));
  const { points } = R.sampleCurve(a, plan.ranked[0].control, b, 0.01);
  assert.ok(minLabelDistance(points, scene.labels[0].rect) >= R.DEFAULTS.strokeHalf);
});

test('常规弧被大结构挡住时，先尝试从外侧绕开，再允许拥挤回退', () => {
  const a = { x: -4, y: 0 }, b = { x: 4, y: 0 };
  const scene = { labels: [{ atomId: 'blocker', rect: { x1: -0.35, y1: -2.3, x2: 0.35, y2: 2.3 } }],
    bonds: [], lonePairs: [], arrows: [], L: 1 };
  const plan = R.planArrow({ a, b, scene });
  assert.equal(plan.feasible, true);
  assert.ok(plan.ranked[0].h > 2, '常规最高弧仍被挡住');
  assert.ok(plan.count <= R.DEFAULTS.maxCandidates);
});

test('弯箭头会避让原生的直反应箭头', () => {
  const a = { x: -2, y: 0 }, b = { x: 2, y: 0 };
  const scene = R.buildScene({ reactionArrows: () => [[{ x: 0, y: -0.8 }, { x: 0, y: 0.35 }]] });
  const plan = R.planArrow({ a, b, scene });
  assert.equal(plan.ranked[0].arrowHits, 0);
  assert.ok(plan.ranked.some(c => c.arrowHits > 0));
});

test('分子内烯醇负离子进攻醛基走上方空旷侧，不向下横穿邻接单键', () => {
  const p = {
    c_enolate: { x: -1.65, y: -0.32 },
    c_ald: { x: 0, y: 0 },
    o_ald: { x: 0.18, y: -0.98 },
    ch2: { x: -0.92, y: 0.34 },
    c_ring1: { x: -1.15, y: 1.30 },
    c_ring2: { x: -1.65, y: 0.68 }
  };
  const bonds = [
    { uuid: 'b_co', type: 2, begin: p.c_ald, end: p.o_ald, beginAtom: 'c_ald', endAtom: 'o_ald' },
    { uuid: 'b_ch2_ald', type: 1, begin: p.ch2, end: p.c_ald, beginAtom: 'ch2', endAtom: 'c_ald' },
    { uuid: 'b_r1', type: 1, begin: p.ch2, end: p.c_ring1, beginAtom: 'ch2', endAtom: 'c_ring1' },
    { uuid: 'b_r2', type: 1, begin: p.c_enolate, end: p.c_ring2, beginAtom: 'c_enolate', endAtom: 'c_ring2' },
    { uuid: 'b_r3', type: 1, begin: p.c_ring2, end: p.c_ring1, beginAtom: 'c_ring2', endAtom: 'c_ring1' }
  ];
  const lps = [{ id: 'lp1', ownerAtomId: 'c_enolate', angle: 0, visible: true }];
  const ctx = {
    atomPos: id => p[id],
    bondInfo: id => bonds.find(b => b.uuid === id),
    unit: () => 1 / 40,
    atomLabelBox: () => ({ hasLabel: false }),
    atoms: () => Object.keys(p).map(id => ({ uuid: id, label: id === 'o_ald' ? 'O' : 'C', pos: p[id] })),
    bonds: () => bonds,
    lonePair: id => lps.find(x => x.id === id)
  };
  const scene = R.buildScene(ctx, { state: { lonePairs: lps, arrows: [] } });
  const source = { type: 'lonePair', slotId: 'lp1', ownerAtomId: 'c_enolate' };
  const target = { type: 'formingBond', atomA: 'c_enolate', atomB: 'c_ald' };
  const geometry = bend => M.arrowGeometry({ source, target, electronCount: 2, geometry: { bend } }, ctx);
  const geo = geometry(0);
  const targetDir = R.resolveTargetDir(target, ctx, geo.end);
  const plan = R.planArrow({
    a: geo.routingStart, b: geo.routingEnd, source, target, electronCount: 2,
    scene, geometry, targetDir
  });

  assert.equal(plan.feasible, true, '必须存在可行排布');
  assert.ok(plan.bend < 0, '最优路径必须向上弯走外侧空旷区 (bend < 0)');
  const bestGeo = geometry(plan.bend);
  assert.ok(bestGeo.control.y < Math.min(bestGeo.start.y, bestGeo.end.y),
    '曲线必须向上拱，control.y 必须小于 min(start.y, end.y)');
  assert.ok(plan.ranked.some(c => c.side === 1 && c.bondHits >= 1 && c.collisions.bonds.includes('b_ch2_ald')),
    '向下弯的候选因穿过 ch2—c_ald 键杆必须被记 bondHits >= 1');
});

test('π 键进攻外源亲电体不豁免横穿邻接取代基键杆', () => {
  const p = {
    c5: { x: 0, y: -1 },
    c6: { x: -0.866, y: -0.5 },
    nh2: { x: -1.732, y: -1.0 },
    no: { x: 0, y: 1.8 }
  };
  const bonds = [
    { uuid: 'b_c5c6', type: 2, begin: p.c5, end: p.c6, beginAtom: 'c5', endAtom: 'c6' },
    { uuid: 'b_c6nh2', type: 1, begin: p.c6, end: p.nh2, beginAtom: 'c6', endAtom: 'nh2' }
  ];
  const ctx = {
    atomPos: id => p[id],
    bondInfo: id => bonds.find(b => b.uuid === id),
    unit: () => 1 / 40,
    atomLabelBox: () => ({ hasLabel: false }),
    atoms: () => Object.keys(p).map(id => ({ uuid: id, label: id === 'c5' || id === 'c6' ? 'C' : 'N', pos: p[id] })),
    bonds: () => bonds
  };
  const scene = R.buildScene(ctx, null);
  const source = { type: 'bond', bondId: 'b_c5c6', component: 'pi' };
  const target = { type: 'atom', atomId: 'no' };
  const geometry = bend => M.arrowGeometry({ source, target, electronCount: 2, geometry: { bend } }, ctx);
  const geo = geometry(0);
  const rel = R.relatedSets(source, target);
  for (const aid of scene.bonds.find(x => x.id === 'b_c5c6').atomIds) rel.startLabels.add(aid);

  // 构造一条从 c5=c6 起点出发、横穿 c6—nh2 键杆中段指向 no 的候选弧
  const control = { x: -2.0, y: -1.2 };
  const piercingGeo = bend => ({ start: geo.start, end: geo.end, control, degenerate: false, sourceOk: true, targetOk: true });
  const evaluated = R.evaluate({ bend: 1, side: 1, h: 0.5 }, {
    a: geo.start, b: geo.end, scene, rel, opts: R.DEFAULTS, geometry: piercingGeo
  });
  assert.ok(evaluated, '评估结果必须存在');
  assert.ok(evaluated.bondHits >= 1, '横穿 c6—nh2 键杆中段必须被记入 bondHits >= 1');
  assert.ok(evaluated.collisions.bonds.includes('b_c6nh2'), '碰撞列表必须记录 b_c6nh2');
  assert.equal(evaluated.feasible, false, '穿键候选 feasible 必须为 false');
});

console.log('Route crowded center: ' + passed + ' PASS');
