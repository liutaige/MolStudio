/* 生成机理层验收夹具（真实 Ketcher 导出，不手写 KET）
   用法：
     .venv-rdkit/bin/python fusion/server.py 8879          # 终端一
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/gen_workbench_fixtures.js
   输出：tests/fixtures/workbench-mechanism/*.molwork + manifest.json
   每个夹具记录「输入（SMILES/已有 KET）+ 操作步骤」，不只看截图。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MOLSTUDIO_PORT || '8879';
const OUT = path.join(__dirname, 'fixtures', 'workbench-mechanism');
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 300000);
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1180, height: 820 });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(5000);
  const js = code => win.webContents.executeJavaScript(code);
  await js(`(async () => { for (let i = 0; i < 60; i++) { if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true; await new Promise(r => setTimeout(r, 250)); } return false; })()`);

  const manifest = [];
  const save = async (id, note, ops) => {
    const text = await js(`window.k3dAPI.serializeWorkbench()`);
    fs.writeFileSync(path.join(OUT, id + '.molwork'), text);
    const doc = JSON.parse(text);
    manifest.push({
      id: id, file: id + '.molwork', note: note, ops: ops,
      molecules: Object.keys(doc.ket).filter(k => doc.ket[k] && doc.ket[k].type === 'molecule'),
      atoms: doc.bindings.atoms.length,
      bonds: doc.bindings.bonds.length,
      lonePairs: doc.mechanism.lonePairs.length,
      arrows: doc.mechanism.arrows.length,
      arrowDetail: doc.mechanism.arrows.map(a => ({
        e: a.electronCount, s: a.source.type + (a.source.component ? '/' + a.source.component : ''), t: a.target.type
      }))
    });
    console.log('saved', id, text.length, 'bytes');
  };

  // 统一：按标签/坐标找原子，返回 uuid
  const atomsOf = () => js(`(() => {
    const a = window.MolWorkbench.app.adapter; a.syncIdentity();
    const st = a.struct();
    return JSON.stringify(Array.from(st.atoms.entries()).map(([id, at]) => ({ id, label: at.label, charge: at.charge || 0, x: at.pp.x, y: at.pp.y, uuid: a.uuidOfAtom(id) })));
  })()`).then(JSON.parse);

  const bondBetween = (u1, u2) => js(`(() => {
    const a = window.MolWorkbench.app.adapter;
    const r1 = a.atomIdOf(${JSON.stringify(u1)}), r2 = a.atomIdOf(${JSON.stringify(u2)});
    const st = a.struct();
    for (const [id, b] of st.bonds) {
      if ((b.begin === r1 && b.end === r2) || (b.begin === r2 && b.end === r1)) return a.uuidOfBond(id);
    }
    return null;
  })()`);

  // 一次提交（走同一条历史路径，夹具内容与用户手画等价）
  const applyMech = (ops) => js(`(() => {
    const app = window.MolWorkbench.app, M = window.MolWorkbench.model;
    const before = app.model.cloneState();
    const ops = ${JSON.stringify(ops)};
    const lpId = {};
    for (const op of ops) {
      if (op.kind === 'lp') {
        const lp = M.makeLonePair(op.owner, { origin: op.origin || 'manual', angle: op.angle || 0 });
        app.model.addLonePair(lp);
        lpId[op.key] = lp.id;
      } else if (op.kind === 'arrow') {
        const src = op.source.type === 'lonePair'
          ? { type: 'lonePair', ownerAtomId: op.source.owner, slotId: lpId[op.source.key] }
          : (op.source.type === 'bond'
            ? { type: 'bond', bondId: op.source.bondId, component: op.source.component || 'sigma' }
            : { type: 'radical', ownerAtomId: op.source.owner });
        const tgt = op.target.type === 'formingBond'
          ? { type: 'formingBond', atomA: op.target.a, atomB: op.target.b }
          : (op.target.type === 'atom' ? { type: 'atom', atomId: op.target.atom }
            : { type: 'bond', bondId: op.target.bondId, component: op.target.component || 'sigma' });
        app.model.addArrow(M.makeArrow(src, tgt, { electronCount: op.e || 2, bend: op.bend === undefined ? -0.22 : op.bend }));
      }
    }
    const after = app.model.cloneState();
    app.model.setState(before, 'silent');
    app.controller.commitStatePair(before, after, 'fixture');
    return JSON.stringify(app.model.counts());
  })()`);

  const setMol = async (smi) => { await js(`window.k3dAPI.setMolecule(${JSON.stringify(smi)})`); await wait(900); };

  /* ---------------- F01：OH⁻ + CH₃Br ---------------- */
  await setMol('[OH-].CBr');
  {
    const at = await atomsOf();
    const o = at.find(a => a.label === 'O');
    const c = at.find(a => a.label === 'C');
    const br = at.find(a => a.label === 'Br');
    const bond = await bondBetween(c.uuid, br.uuid);
    await applyMech([
      { kind: 'lp', key: 'o1', owner: o.uuid, angle: 0 },
      { kind: 'arrow', source: { type: 'lonePair', owner: o.uuid, key: 'o1' }, target: { type: 'formingBond', a: o.uuid, b: c.uuid }, e: 2 },
      { kind: 'arrow', source: { type: 'bond', bondId: bond, component: 'sigma' }, target: { type: 'atom', atom: br.uuid }, e: 2 }
    ]);
    await save('F01', 'OH⁻ + CH₃Br：孤对→待成键、C—Br σ→Br', [
      "setMolecule('[OH-].CBr')",
      "在 O 上加一对孤对（angle 0）",
      "两电子箭头：O 的孤对 → formingBond(O,C)",
      "两电子箭头：C—Br 的 σ → Br 原子"
    ]);
  }

  /* ---------------- F02：羰基 + 亲核来源 ---------------- */
  await setMol('C=O');
  {
    const at = await atomsOf();
    const o = at.find(a => a.label === 'O');
    const c = at.find(a => a.label === 'C');
    const co = await bondBetween(c.uuid, o.uuid);
    await applyMech([
      { kind: 'arrow', source: { type: 'bond', bondId: co, component: 'pi' }, target: { type: 'atom', atom: o.uuid }, e: 2, bend: 0.3 },
      { kind: 'arrow', source: { type: 'bond', bondId: co, component: 'pi' }, target: { type: 'atom', atom: c.uuid }, e: 2, bend: -0.3 }
    ]);
    await save('F02', '羰基 π 来源的两根箭头（不同弯向）', [
      "setMolecule('C=O')",
      "两电子箭头：C=O 的 π → O（bend 0.3）",
      "两电子箭头：C=O 的 π → C（bend -0.3）"
    ]);
  }

  /* ---------------- F03：两个自由基 + 普通键（鱼钩） ---------------- */
  await setMol('[CH3].[CH3]');
  {
    const at = await atomsOf();
    const cs = at.filter(a => a.label === 'C');
    await applyMech([
      { kind: 'arrow', source: { type: 'radical', owner: cs[0].uuid }, target: { type: 'formingBond', a: cs[0].uuid, b: cs[1].uuid }, e: 1 },
      { kind: 'arrow', source: { type: 'radical', owner: cs[1].uuid }, target: { type: 'formingBond', a: cs[0].uuid, b: cs[1].uuid }, e: 1, bend: 0.28 }
    ]);
    await save('F03', '两个自由基的鱼钩箭头指向同一个待成键', [
      "setMolecule('[CH3].[CH3]')",
      "单电子箭头：C1 自由基 → formingBond(C1,C2)",
      "单电子箭头：C2 自由基 → formingBond(C1,C2)（同一对原子）"
    ]);
  }

  /* ---------------- F04：孤对建议样本（逐个分子，附期望值） ---------------- */
  const f04 = [];
  const cases = [
    ['water-implicit', 'O', '水中性 O', 2],
    ['water-explicit', '[H]O[H]', '水（显式氢）', 2],
    ['hydroxide', '[OH-]', 'OH⁻', 3],
    ['hydronium', '[OH3+]', 'H₃O⁺', 1],
    ['ammonia', 'N', '氨', 1],
    ['ammonium', '[NH4+]', '铵', 0],
    ['chloromethane', 'CCl', '氯甲烷的 Cl', 3],
    ['chloride', '[Cl-]', '氯离子', 4],
    ['carbonyl', 'CC=O', '羰基氧', 2]
  ];
  for (const [id, smi, note, want] of cases) {
    await setMol(smi);
    const sug = await js(`(() => {
      const M = window.MolWorkbench.model;
      return JSON.stringify(M.suggestLonePairs(window.MolWorkbench.app.adapter.chemSnapshot()));
    })()`).then(JSON.parse);
    const at = await atomsOf();
    const target = at.find(a => ['O', 'N', 'Cl'].includes(a.label) && a.label !== 'C');
    const slot = target ? sug.slots.find(x => x.ownerAtomId === target.uuid) : null;
    f04.push({ id: 'F04-' + id, smiles: smi, note: note, expectedPairs: want, got: slot ? slot.count : 0 });
    await save('F04-' + id, note + '（' + smi + '）孤对建议 ' + (slot ? slot.count : 0) + ' 对', ['setMolecule(' + JSON.stringify(smi) + ')', '不添加任何机理对象（只验证建议）']);
  }
  fs.writeFileSync(path.join(OUT, 'F04.json'), JSON.stringify(f04, null, 1));

  /* ---------------- F05：两个相同分子，只在其中一个上画箭头 ---------------- */
  await setMol('CCO.CCO');
  {
    const at = await atomsOf();
    const sorted = at.slice().sort((a, b) => a.x - b.x);
    const left = sorted.slice(0, 3);
    const lO = left.find(a => a.label === 'O');
    const lC = left.find(a => a.label === 'C');
    await applyMech([
      { kind: 'lp', key: 'l1', owner: lO.uuid, angle: 0 },
      { kind: 'arrow', source: { type: 'lonePair', owner: lO.uuid, key: 'l1' }, target: { type: 'formingBond', a: lO.uuid, b: lC.uuid }, e: 2 }
    ]);
    await save('F05', '两个相同乙醇相邻，箭头只绑左侧那个（防串绑）', [
      "setMolecule('CCO.CCO')",
      "在左侧乙醇的 O 上加孤对并画箭头到同一分子的 C",
      "用于验证移动/交换位置后不按最近原子重接"
    ]);
  }

  /* ---------------- F06：已有立体夹具 + 机理层 ---------------- */
  {
    const ketText = fs.readFileSync(path.join(__dirname, 'fixtures', 'M11.ket'), 'utf8');   // OR 组 + 两个手性中心
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(ketText)})`);
    await wait(1000);
    const at = await atomsOf();
    const o = at.find(a => a.label === 'O');
    const c = at.filter(a => a.label === 'C')[0];
    const bond = await bondBetween(o.uuid, c.uuid);
    await applyMech([
      { kind: 'lp', key: 'k1', owner: o.uuid, angle: 0 },
      { kind: 'arrow', source: { type: 'lonePair', owner: o.uuid, key: 'k1' }, target: { type: 'atom', atom: c.uuid }, e: 2 },
      { kind: 'arrow', source: { type: 'bond', bondId: bond, component: 'sigma' }, target: { type: 'atom', atom: o.uuid }, e: 2, bend: 0.3 }
    ]);
    await save('F06', '既有立体夹具 M11（OR 组）+ 机理层：信息保持', [
      "setMolecule(fixtures/M11.ket 原文)",
      "在 O 上加孤对并画两根箭头",
      "用于验证立体/未知/组信息不被机理层改动"
    ]);
  }

  /* ---------------- F08：规模夹具 ---------------- */
  {
    await setMol(Array.from({ length: 200 }, () => 'C').join(''));
    const at = await atomsOf();
    const ops = [];
    for (let i = 0; i < 30; i++) {
      const a = at[i * 6];
      if (!a) break;
      ops.push({ kind: 'lp', key: 's' + i, owner: a.uuid, angle: i * 37 });
    }
    for (let i = 0; i < 20; i++) {
      const a = at[i * 9];
      const b = at[i * 9 + 2];
      if (!a || !b) break;
      ops.push({ kind: 'arrow', source: { type: 'lonePair', owner: a.uuid, key: 's' + i }, target: { type: 'formingBond', a: a.uuid, b: b.uuid }, e: 2, bend: (i % 2 ? 0.25 : -0.25) });
    }
    await applyMech(ops);
    await save('F08', '200 原子 + 30 孤对 + 20 箭头（规模/性能）', [
      "setMolecule(200 个 C 的直链)",
      "程序化加 30 对孤对 + 20 根箭头（走同一条提交路径）"
    ]);
  }

  /* ---------------- F09：坏文件 ---------------- */
  {
    const good = JSON.parse(fs.readFileSync(path.join(OUT, 'F01.molwork'), 'utf8'));
    const write = (name, obj) => fs.writeFileSync(path.join(OUT, name + '.molwork'), typeof obj === 'string' ? obj : JSON.stringify(obj));
    const dup = JSON.parse(JSON.stringify(good));
    dup.mechanism.lonePairs.push(JSON.parse(JSON.stringify(dup.mechanism.lonePairs[0])));
    write('F09-duplicate-id', dup);

    const newer = JSON.parse(JSON.stringify(good));
    newer.version = 99;
    write('F09-newer-version', newer);

    const missing = JSON.parse(JSON.stringify(good));
    delete missing.bindings;
    write('F09-missing-bindings', missing);

    const nanText = JSON.stringify(good).replace(/"bend":-?[0-9.]+/, '"bend":1e999');
    write('F09-nonfinite', nanText);

    const dangling = JSON.parse(JSON.stringify(good));
    dangling.mechanism.arrows = [{
      id: 'ar-dangling-1', electronCount: 2,
      source: { type: 'atom', atomId: 'at-gone-1', last: { x: 1, y: 2 } },
      target: { type: 'formingBond', atomA: 'at-gone-1', atomB: 'at-gone-2' },
      geometry: { bend: -0.2 }, stepId: 'step-1', pairId: null
    }];
    write('F09-dangling-ok', dangling);

    manifest.push({
      id: 'F09', note: '坏文件：重复 ID / 更高版本 / 缺 bindings / 非有限数值 / 合法悬空引用',
      files: ['F09-duplicate-id.molwork', 'F09-newer-version.molwork', 'F09-missing-bindings.molwork', 'F09-nonfinite.molwork', 'F09-dangling-ok.molwork'],
      expect: { 'F09-duplicate-id': 'reject', 'F09-newer-version': 'reject', 'F09-missing-bindings': 'reject', 'F09-nonfinite': 'reject', 'F09-dangling-ok': 'load with stale refs' }
    });
    console.log('saved F09 bad fixtures');
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('done:', manifest.length, 'entries');
  app.quit();
  process.exit(0);
});
