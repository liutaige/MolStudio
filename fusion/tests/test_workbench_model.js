/* 机理层模型与 .molwork 格式的纯数据测试（无需 GUI）
   用法：node fusion/tests/test_workbench_model.js
   覆盖：孤对建议（F04 样本）、端点锚点、曲线几何、序列化稳定性、坏文件拒绝。
   注意：这里只证明数据层；鼠标命中/真实 Ketcher 集成由 tests/test_workbench_mechanism.js 覆盖。*/
'use strict';
const path = require('path');
const fs = require('fs');

require(path.join(__dirname, '..', 'workbench', 'mechanism-model.js'));
require(path.join(__dirname, '..', 'workbench', 'workbench-storage.js'));

const MW = globalThis.MolWorkbench;
const M = MW.model;
const St = MW.storage;

let PASS = 0, FAIL = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; FAILED.push(name + (detail ? '  ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}

/* ---------------- 化学快照构造 ---------------- */
function atom(uuid, label, opts) {
  const o = opts || {};
  const a = {
    uuid: uuid, label: label, charge: o.charge || 0, radical: o.radical || 0,
    aromatic: !!o.aromatic, hasQuery: !!o.hasQuery, isotope: o.isotope || 0,
    implicitH: o.implicitH || 0, neighbors: []
  };
  return a;
}
function bond(chem, a, b, order, opts) {
  const o = opts || {};
  const A = chem.atoms.find(x => x.uuid === a);
  const B = chem.atoms.find(x => x.uuid === b);
  A.neighbors.push({ uuid: b, order: order, aromatic: !!o.aromatic, angle: o.angle === undefined ? 0 : o.angle });
  B.neighbors.push({ uuid: a, order: order, aromatic: !!o.aromatic, angle: o.angle === undefined ? 180 : (o.angle + 180) % 360 });
  return chem;
}
function chem(atoms) { return { atoms: atoms }; }
function pairsOf(sug, uuid) {
  const s = sug.slots.find(x => x.ownerAtomId === uuid);
  return s ? s.count : 0;
}

/* ---------------- F04：孤对建议 ---------------- */
console.log('[LP01/F04] 常见主族环境自动建议');
{
  // 水（隐式氢）
  const water = chem([atom('o', 'O', { implicitH: 2 })]);
  check('水中性 O → 2 对（隐式氢）', pairsOf(M.suggestLonePairs(water), 'o') === 2,
        JSON.stringify(M.suggestLonePairs(water).slots));

  // 水（显式氢）：O 与 2 个 H 成键，implicitH=0
  const waterX = chem([atom('o', 'O'), atom('h1', 'H'), atom('h2', 'H')]);
  bond(waterX, 'o', 'h1', 1, { angle: 60 });
  bond(waterX, 'o', 'h2', 1, { angle: 120 });
  check('水中性 O → 2 对（显式氢，与隐式一致）', pairsOf(M.suggestLonePairs(waterX), 'o') === 2);

  // OH⁻
  const oh = chem([atom('o', 'O', { charge: -1, implicitH: 1 })]);
  check('OH⁻ → 3 对', pairsOf(M.suggestLonePairs(oh), 'o') === 3);

  // H3O+
  const h3o = chem([atom('o', 'O', { charge: 1, implicitH: 3 })]);
  check('H₃O⁺ → 1 对', pairsOf(M.suggestLonePairs(h3o), 'o') === 1);

  // 氨
  const nh3 = chem([atom('n', 'N', { implicitH: 3 })]);
  check('NH₃ → 1 对', pairsOf(M.suggestLonePairs(nh3), 'n') === 1);

  // 铵
  const nh4 = chem([atom('n', 'N', { charge: 1, implicitH: 4 })]);
  check('NH₄⁺ → 0 对', pairsOf(M.suggestLonePairs(nh4), 'n') === 0);

  // 卤代烷
  const rcl = chem([atom('c', 'C', { implicitH: 3 }), atom('cl', 'Cl')]);
  bond(rcl, 'c', 'cl', 1);
  check('中性 C—Cl → Cl 3 对', pairsOf(M.suggestLonePairs(rcl), 'cl') === 3);

  // 卤离子
  const clm = chem([atom('cl', 'Cl', { charge: -1 })]);
  check('Cl⁻ → 4 对', pairsOf(M.suggestLonePairs(clm), 'cl') === 4);

  // 羰基
  const cxo = chem([atom('c', 'C', { implicitH: 2 }), atom('o', 'O')]);
  bond(cxo, 'c', 'o', 2);
  check('羰基 O → 2 对', pairsOf(M.suggestLonePairs(cxo), 'o') === 2);

  // 碳：0 对（不出现在建议里）
  const ch4 = chem([atom('c', 'C', { implicitH: 4 })]);
  check('CH₄ → 0 对（不产生槽位）', M.suggestLonePairs(ch4).slots.length === 0);

  // 芳香：不支持
  const pyr = chem([atom('n', 'N', { aromatic: true }), atom('c1', 'C', { aromatic: true })]);
  bond(pyr, 'n', 'c1', 1, { aromatic: true });
  const sugPyr = M.suggestLonePairs(pyr);
  check('芳香 N 不自动猜', pairsOf(sugPyr, 'n') === 0 && sugPyr.unsupported.some(u => u.ownerAtomId === 'n'),
        JSON.stringify(sugPyr.unsupported));

  // 查询原子
  const q = chem([atom('x', 'N', { hasQuery: true, implicitH: 2 })]);
  check('查询原子不自动猜', M.suggestLonePairs(q).slots.length === 0);

  // 超价
  const sf = chem([atom('s', 'S', { implicitH: 0 }), atom('f1', 'F'), atom('f2', 'F'), atom('f3', 'F'), atom('f4', 'F'), atom('f5', 'F'), atom('f6', 'F')]);
  for (let i = 1; i <= 6; i++) bond(sf, 's', 'f' + i, 1);
  const sugSf = M.suggestLonePairs(sf);
  check('超价 S 不套公式', pairsOf(sugSf, 's') === 0 && sugSf.unsupported.some(u => u.ownerAtomId === 's'),
        JSON.stringify(sugSf.unsupported));

  // 自由基碳
  const rad = chem([atom('c', 'C', { radical: 1, implicitH: 3 })]);
  check('•CH₃ → 0 对', M.suggestLonePairs(rad).slots.length === 0);
}

/* ---------------- 建议槽位的角度分布 ---------------- */
console.log('[LP01] 槽位角度避开键方向');
{
  const waterX = chem([atom('o', 'O'), atom('h1', 'H'), atom('h2', 'H')]);
  bond(waterX, 'o', 'h1', 1, { angle: 30 });
  bond(waterX, 'o', 'h2', 1, { angle: 150 });
  const sug = M.suggestLonePairs(waterX);
  const slot = sug.slots.find(s => s.ownerAtomId === 'o');
  check('水给出 2 个槽位', slot && slot.count === 2);
  const angles = slot.angles.map(a => ((a % 360) + 360) % 360);
  // H 在 30°/150°，最大空隙在它们背面（270° 附近）：孤对应落在这里
  check('孤对落在键的空隙里（270°±45°）', angles.every(a => Math.abs(M.normalizeDelta(a - 270)) < 45), JSON.stringify(angles));
  check('孤对不与 H 方向重合', angles.every(a => Math.min(Math.abs(M.normalizeDelta(a - 30)), Math.abs(M.normalizeDelta(a - 150))) > 20), JSON.stringify(angles));
}

/* ---------------- 端点锚点 ---------------- */
console.log('[模型] 端点锚点与失效状态');
{
  const model = new M.MechanismModel();
  const positions = { a: { x: 0, y: 0 }, b: { x: 2, y: 0 } };
  const lp = M.makeLonePair('a', { angle: 90, radius: 0.4 });
  model.addLonePair(lp);
  const ctx = {
    atomPos: (uuid) => positions[uuid] || null,
    bondInfo: (uuid) => uuid === 'bond1' ? { begin: positions.a, end: positions.b, type: 2 } : null,
    lonePair: (id) => model.lonePair(id)
  };
  const lpAnchor = M.endpointAnchor({ type: 'lonePair', ownerAtomId: 'a', slotId: lp.id }, ctx);
  check('孤对端点有位置', lpAnchor.ok && Math.abs(lpAnchor.y - 0.4) < 1e-9, JSON.stringify(lpAnchor));

  const bd = M.endpointAnchor({ type: 'bond', bondId: 'bond1', component: 'pi' }, ctx);
  check('键端点在中点附近', bd.ok && Math.abs(bd.x - 1) < 1e-9, JSON.stringify(bd));

  const fb = M.endpointAnchor({ type: 'formingBond', atomA: 'a', atomB: 'b' }, ctx);
  check('待成键端点在两原子中点', fb.ok && Math.abs(fb.x - 1) < 1e-9, JSON.stringify(fb));

  const missing = M.endpointAnchor({ type: 'atom', atomId: 'zzz', last: { x: 3, y: 4 } }, ctx);
  check('缺失引用 → 未绑定但有最后位置', missing.ok === false && missing.x === 3 && missing.y === 4, JSON.stringify(missing));

  const noLast = M.endpointAnchor({ type: 'atom', atomId: 'zzz' }, ctx);
  check('缺失引用且无最后位置 → hasLast=false', noLast.ok === false && noLast.hasLast === false);

  // 删除孤对后箭头端点应失效（不静默改绑）
  const ar = M.makeArrow({ type: 'lonePair', ownerAtomId: 'a', slotId: lp.id }, { type: 'atom', atomId: 'b' });
  model.addArrow(ar);
  model.removeLonePair(lp.id);
  const after = M.endpointAnchor(ar.source, ctx);
  check('孤对被删 → 箭头起点失效', after.ok === false, JSON.stringify(after));
}

/* ---------------- 曲线几何 ---------------- */
console.log('[模型] 曲线几何');
{
  const a = { x: 0, y: 0 }, b = { x: 2, y: 0 };
  const c1 = M.controlPoint(a, b, 0);
  check('bend=0 时控制点在中点', Math.abs(c1.x - 1) < 1e-9 && Math.abs(c1.y) < 1e-9, JSON.stringify(c1));
  const c2 = M.controlPoint(a, b, 0.5);
  // 结构坐标 y 向下：从 a 到 b 向右时，bend>0 弯向屏幕下方（+y）
  check('bend=0.5 时控制点偏离 1 个单位（+y）', Math.abs(c2.y - 1) < 1e-9, JSON.stringify(c2));
  const c3 = M.controlPoint(a, b, -0.5);
  check('bend 符号决定弯向（-y）', Math.abs(c3.y + 1) < 1e-9, JSON.stringify(c3));

  const ctx2 = { atomPos: () => null, bondInfo: () => null, lonePair: () => null };
  const geo = M.arrowGeometry(M.makeArrow({ type: 'free', x: 1, y: 1 }, { type: 'free', x: 1, y: 1 }), ctx2);
  check('重合端点被识别为退化', geo.degenerate === true, JSON.stringify(geo.start) + ' / ' + JSON.stringify(geo.end));
}

/* ---------------- 序列化稳定性 ---------------- */
console.log('[IO12] 稳定序列化');
{
  const model = new M.MechanismModel();
  const lp = M.makeLonePair('at-1', { angle: 33.3333333, radius: 0.42 });
  model.addLonePair(lp);
  model.addArrow(M.makeArrow({ type: 'lonePair', ownerAtomId: 'at-1', slotId: lp.id }, { type: 'formingBond', atomA: 'at-1', atomB: 'at-2' }, { bend: -0.25 }));
  const ketPath = path.join(__dirname, 'fixtures', 'M01.ket');
  const ketText = fs.readFileSync(ketPath, 'utf8');
  const s1 = St.serializeWorkbench({ ket: ketText, bindings: { atoms: [], bonds: [] }, mechanism: model.state });
  const s2 = St.serializeWorkbench({ ket: ketText, bindings: { atoms: [], bonds: [] }, mechanism: model.state });
  check('同一状态两次序列化完全一致', s1 === s2, s1.length + ' vs ' + s2.length);
  check('不含时间戳字段', !/timestamp|createdAt|savedAt/i.test(s1));
  const parsed = St.parseWorkbench(s1);
  check('序列化后可解析', parsed.ok === true, JSON.stringify(parsed).slice(0, 200));
  check('往返后孤对数量一致', parsed.ok && parsed.doc.mechanism.lonePairs.length === 1);
  check('往返后箭头电子数一致', parsed.ok && parsed.doc.mechanism.arrows[0].electronCount === 2);
  check('往返后曲率一致', parsed.ok && Math.abs(parsed.doc.mechanism.arrows[0].geometry.bend + 0.25) < 1e-9);
  const s3 = St.serializeWorkbench({ ket: parsed.doc.ket, bindings: parsed.doc.bindings, mechanism: parsed.doc.mechanism });
  check('解析后再序列化与原文一致', s3 === s1);
}

/* ---------------- 坏文件拒绝 ---------------- */
console.log('[IO10] 坏文件与版本');
{
  const ketText = fs.readFileSync(path.join(__dirname, 'fixtures', 'M01.ket'), 'utf8');
  const good = JSON.parse(St.serializeWorkbench({ ket: ketText, bindings: { atoms: [], bonds: [] }, mechanism: M.emptyState() }));

  check('format 不对 → 拒绝', St.parseWorkbench(JSON.stringify(Object.assign({}, good, { format: 'x' }))).code === 'bad_format');

  const newer = Object.assign({}, good, { version: 99 });
  const rNew = St.parseWorkbench(JSON.stringify(newer));
  check('更高主版本 → 拒绝且说明', rNew.ok === false && rNew.code === 'newer_version', JSON.stringify(rNew));

  const dupLp = JSON.parse(JSON.stringify(good));
  dupLp.mechanism.lonePairs = [
    { id: 'dup', ownerAtomId: 'a', origin: 'manual', electronCount: 2, angle: 0, radius: 0.4 },
    { id: 'dup', ownerAtomId: 'b', origin: 'manual', electronCount: 2, angle: 0, radius: 0.4 }
  ];
  const rDup = St.parseWorkbench(JSON.stringify(dupLp));
  check('重复 ID → 拒绝', rDup.ok === false && /重复/.test(rDup.error), JSON.stringify(rDup));

  const nan = JSON.parse(JSON.stringify(good));
  nan.mechanism.lonePairs = [{ id: 'x', ownerAtomId: 'a', origin: 'manual', electronCount: 2, angle: 0, radius: 0.4 }];
  const nanText = JSON.stringify(nan).replace('"radius":0.4', '"radius":1e999');
  const rNan = St.parseWorkbench(nanText);
  check('非有限数值 → 拒绝', rNan.ok === false, JSON.stringify(rNan));

  const badBond = JSON.parse(JSON.stringify(good));
  badBond.bindings = { atoms: [{ id: 'u1', mol: 'mol0', index: 0 }], bonds: [{ id: 'b1', mol: 'mol0', index: 0, begin: 'u1', end: 'nope' }] };
  const rBadBond = St.parseWorkbench(JSON.stringify(badBond));
  check('键端点没有原子绑定 → 拒绝', rBadBond.ok === false, JSON.stringify(rBadBond));

  // 合法悬空引用：允许载入（转成待重绑）
  const dangling = JSON.parse(JSON.stringify(good));
  dangling.mechanism.arrows = [{
    id: 'ar-x', electronCount: 2,
    source: { type: 'atom', atomId: 'gone-1', last: { x: 1, y: 2 } },
    target: { type: 'formingBond', atomA: 'gone-1', atomB: 'gone-2' },
    geometry: { bend: -0.2 }, stepId: 'step-1'
  }];
  const rDangle = St.parseWorkbench(JSON.stringify(dangling));
  check('合法悬空引用 → 允许载入', rDangle.ok === true, JSON.stringify(rDangle).slice(0, 200));

  check('空文本 → empty', St.parseWorkbench('').code === 'empty');
  check('坏 JSON → bad_json', St.parseWorkbench('{oops').code === 'bad_json');
  check('KET 是 {} → 拒绝', (() => {
    const o = JSON.parse(JSON.stringify(good));
    o.ket = {};
    return St.parseWorkbench(JSON.stringify(o)).ok === false;
  })());
}

/* ---------------- 格式识别 ---------------- */
console.log('[格式识别] isWorkbenchText');
{
  const ketText = fs.readFileSync(path.join(__dirname, 'fixtures', 'M01.ket'), 'utf8');
  check('普通 KET 不被当工作台文件', St.isWorkbenchText(ketText) === false);
  const wb = St.serializeWorkbench({ ket: ketText, bindings: { atoms: [], bonds: [] }, mechanism: M.emptyState() });
  check('工作台文件被识别', St.isWorkbenchText(wb) === true);
  check('损坏文本不被识别', St.isWorkbenchText('{"format":"molstudio-workbench",') === false);
}

/* ---------------- 模型基本操作 ---------------- */
console.log('[模型] 增删与计数');
{
  const model = new M.MechanismModel();
  check('新模型为空', model.isEmpty() === true);
  const lp = M.makeLonePair('at-1', { origin: 'manual', angle: 10 });
  model.addLonePair(lp);
  check('加孤对后不为空', model.isEmpty() === false && model.counts().lonePairs === 1);
  check('孤对默认 2 电子', lp.electronCount === 2);
  const ar = M.makeArrow({ type: 'lonePair', ownerAtomId: 'at-1', slotId: lp.id }, { type: 'atom', atomId: 'at-2' }, { electronCount: 1 });
  model.addArrow(ar);
  check('单电子箭头', ar.electronCount === 1);
  check('箭头引用孤对可查', model.arrowsUsingLonePair(lp.id).length === 1);
  const cloned = model.cloneState();
  check('克隆与原状态一致', JSON.stringify(cloned) === JSON.stringify(model.state));
  cloned.arrows.length = 0;
  check('克隆是深拷贝', model.state.arrows.length === 1);
}

console.log('');
console.log(`结果：${PASS} PASS / ${FAIL} FAIL`);
if (FAILED.length) { console.log('失败项：'); FAILED.forEach(f => console.log('  -', f)); }
process.exit(FAIL ? 1 : 0);
