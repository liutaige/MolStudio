/* 编辑器集成测试：真实 Ketcher + 真实 canvas.html，验证统一整理、撤销、选区、陈旧检查。
   用法：
     cd fusion && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
       --no-sandbox --disable-gpu tests/test_canvas_layout.js
   截图输出：tests/artifacts/*.png（L01/L03 外观证据） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'artifacts');
const PORT = process.env.MOLSTUDIO_PORT || '8470';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 240000);

let PASS = 0, FAIL = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; FAILED.push(name + (detail ? '  ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1180, height: 820 });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(4500);
  win.showInactive();          // 隐藏窗口的 capturePage 拿到的是旧帧，截图前必须真实显示
  await wait(600);

  const js = code => win.webContents.executeJavaScript(code);
  const ready = await js(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (window.k3dAPI && window.k3dAPI.isReady()) return true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  })()`);
  if (!ready) { console.log('FATAL: ketcher 未就绪'); app.quit(); return; }
  console.log('ketcher ready');

  const setMol = async (smi) => {
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(smi)})`);
    await wait(700);
  };
  const shot = async (name) => {
    await wait(500);
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  };
  // 画布重绘校验：模型改了但画面没动，是"看起来没整理"的典型故障
  const svgDigest = () => js(`(() => {
    const ed = document.getElementById('k').contentWindow.ketcher.editor;
    const ca = ed.render && ed.render.clientArea;
    if (!ca) return 'none';
    const t = ca.innerHTML;
    let h = 0;
    for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; }
    return h + ':' + t.length;
  })()`);
  const dump = () => js(`(() => {
    const k = window.k3dAPI;
    const st = document.getElementById('k').contentWindow.ketcher.editor.struct();
    return JSON.stringify(Array.from(st.atoms.entries()).map(([id,a]) => [id, a.label, +a.pp.x.toFixed(3), +a.pp.y.toFixed(3)]));
  })()`);
  const gaps = () => js(`(() => {
    const st = document.getElementById('k').contentWindow.ketcher.editor.struct();
    const adj = new Map();
    for (const b of st.bonds.values()) {
      if (!adj.has(b.begin)) adj.set(b.begin, []);
      if (!adj.has(b.end)) adj.set(b.end, []);
      adj.get(b.begin).push(b.end); adj.get(b.end).push(b.begin);
    }
    const center = Array.from(adj.entries()).find(([id, ns]) => ns.length === 4);
    if (!center) return 'null';
    const ca = st.atoms.get(center[0]);
    const angs = center[1].map(n => { const p = st.atoms.get(n).pp; return (Math.atan2(p.y-ca.pp.y, p.x-ca.pp.x)*180/Math.PI+360)%360; }).sort((a,b)=>a-b);
    return JSON.stringify([0,1,2,3].map(i => +(((angs[(i+1)%4]-angs[i])+360)%360).toFixed(1)));
  })()`);
  const smiles = () => js(`window.k3dAPI.getSmiles()`);
  const hist = () => js(`JSON.stringify(document.getElementById('k').contentWindow.ketcher.editor.historySize())`);
  const clean = () => js(`window.k3dAPI.cleanLayout()`);

  // ---------------- L01 / L03：外观与构型保持 ----------------
  console.log('[L01] M03/M04 顶部整理：不再是十字，R/S 保持');
  for (const [smi, tag] of [['F[C@](Cl)(Br)I', 'M03'], ['F[C@@](Cl)(Br)I', 'M04'], ['FC(Cl)(Br)I', 'M02'], ['CC(C)(C)C', 'M01']]) {
    await setMol(smi);
    await shot(`before-${tag}`);
    const g0 = JSON.parse(await gaps());
    const s0 = await smiles();
    const d0 = await svgDigest();
    const r = await clean();
    await wait(500);
    await shot(`after-${tag}`);
    const g1 = JSON.parse(await gaps());
    const s1 = await smiles();
    const d1 = await svgDigest();
    check(`${tag} 画布确实重绘`, d0 !== d1, `${d0} -> ${d1}`);
    check(`${tag} 整理成功`, r && r.ok === true, JSON.stringify(r));
    check(`${tag} 整理前是机械十字`, g0.every(x => x >= 80 && x <= 100), JSON.stringify(g0));
    check(`${tag} 整理后不是十字`, !g1.every(x => x >= 80 && x <= 100), JSON.stringify(g1));
    check(`${tag} 构型保持`, s0 === s1, `${s0} -> ${s1}`);
  }

  // ---------------- L12：一次撤销 / 旧历史仍在 ----------------
  console.log('[L12] 撤销、重做、旧历史');
  await setMol('F[C@](Cl)(Br)I');
  await js(`(async () => { await window.k3dAPI.setMolecule('F[C@](Cl)(Br)I'); })()`);
  await wait(500);
  await js(`document.getElementById('k').contentWindow.ketcher.addFragment('CCO')`);
  await wait(600);
  const beforeLayout = await dump();
  const histBefore = JSON.parse(await hist());
  const r12 = await clean();
  await wait(400);
  const afterLayout = await dump();
  const histAfter = JSON.parse(await hist());
  check('整理成功（L12 样本）', r12.ok === true, JSON.stringify(r12));
  check('整理前后坐标不同', beforeLayout !== afterLayout);
  check('历史只增加一步', histAfter.undo === histBefore.undo + 1, `${histBefore.undo} -> ${histAfter.undo}`);
  await js(`window.k3dAPI.undo()`);
  await wait(400);
  const afterUndo = await dump();
  check('撤销恢复整理前坐标', afterUndo === beforeLayout, 'undo 后与整理前不一致');
  await js(`window.k3dAPI.redo()`);
  await wait(400);
  const afterRedo = await dump();
  check('重做恢复整理后坐标', afterRedo === afterLayout, 'redo 后与整理后不一致');
  await js(`window.k3dAPI.undo()`);
  await wait(300);
  await js(`window.k3dAPI.undo()`);
  await wait(400);
  const afterTwoUndo = await smiles();
  check('继续撤销回到只加片段前的状态', afterTwoUndo === 'F[C@@](I)(Br)Cl', afterTwoUndo);

  // ---------------- L03：未指定中心不被自动指定 ----------------
  console.log('[L03] M02 未指定中心');
  await setMol('FC(Cl)(Br)I');
  const rL03 = await clean();
  const sL03 = await smiles();
  check('M02 整理后仍未指定', sL03 === 'FC(I)(Br)Cl', sL03);

  // ---------------- L10：只整理选中的分子 ----------------
  console.log('[L10] 选区整理不影响其他对象');
  await js(`(async () => {
    await window.k3dAPI.setMolecule('FC(Cl)(Br)I.F[C@](Cl)(Br)I');
  })()`);
  await wait(800);
  // 选中第二个分子的全部原子（按坐标判定：x 较大的一组）
  await js(`(() => {
    const ed = document.getElementById('k').contentWindow.ketcher.editor;
    const st = ed.struct();
    const atoms = Array.from(st.atoms.entries());
    const cx = atoms.reduce((s,[,a]) => s + a.pp.x, 0) / atoms.length;
    const right = atoms.filter(([,a]) => a.pp.x > cx).map(([id]) => id);
    ed.selection({ atoms: right, bonds: [] });
    return right.length;
  })()`);
  await wait(300);
  const partsBefore = JSON.parse(await js(`window.k3dAPI.selectionParts()`));
  const all0 = await dump();
  const rL10 = await clean();
  await wait(400);
  const all1 = await dump();
  const partsAfter = JSON.parse(await js(`window.k3dAPI.selectionParts()`));
  check('L10 整理成功', rL10.ok === true, JSON.stringify(rL10));
  check('L10 只整理一个分子', (rL10.molecules || []).length === 1, JSON.stringify(rL10.molecules));
  check('L10 选区保持', partsAfter.atoms.length === partsBefore.atoms.length,
        `${partsBefore.atoms.length} -> ${partsAfter.atoms.length}`);
  const a0 = JSON.parse(all0), a1 = JSON.parse(all1);
  const moved = a0.filter((a, i) => a[2] !== a1[i][2] || a[3] !== a1[i][3]).length;
  check('L10 另一个分子没有移动', moved > 0 && moved < a0.length, `移动原子数 ${moved}/${a0.length}`);

  console.log('[反应阶段] 手画的直箭头参加整图整理');
  const stagesKet = { root: { nodes: [] } };
  [[-8, 0], [-3, -0.2], [4, -0.6], [7, -0.7], [14, -2], [20, -2.2]].forEach(([x, y], i) => {
    const key = 'mol' + i;
    stagesKet[key] = { type: 'molecule', atoms: [{ label: 'O', location: [x, y, 0] }], bonds: [] };
    stagesKet.root.nodes.push({ $ref: key });
  });
  for (const points of [[[0, 0], [2, -0.25]], [[9, -1], [11, -2]]]) {
    stagesKet.root.nodes.push({ type: 'arrow', data: { mode: 'open-angle', pos: points.map(([x, y]) => ({ x, y, z: 0 })) } });
  }
  await js(`window.k3dAPI.setMolecule(${JSON.stringify(JSON.stringify(stagesKet))})`);
  await wait(600);
  await js(`(() => {
    const { model, controller, adapter } = MolWorkbench.app;
    adapter.ed.selection(null);
    const [source, target] = [...adapter.ed.struct().atoms.entries()].sort(([, a], [, b]) => a.pp.x - b.pp.x)
      .slice(0, 2).map(([id]) => ({ type: 'atom', atomId: adapter.uuidOfAtom(id) }));
    model.addArrow(MolWorkbench.model.makeArrow(source, target, { bend: 0.7, mode: 'auto' }));
    const replan = controller.replanArrowInPlace;
    controller.replanArrowInPlace = function (arrow, force) {
      const ctx = controller.ctx();
      const p = ctx.atomPos(arrow.target.atomId), box = ctx.atomLabelBox(arrow.target.atomId)?.atomRect;
      window.__freshLayoutGlyph = !!box && p.x >= box.x1 - 0.05 && p.x <= box.x2 + 0.05;
      return replan.call(this, arrow, force);
    };
    window.__restoreLayoutReplan = () => { controller.replanArrowInPlace = replan; };
  })()`);
  const reactionSnapshot = () => js(`(() => {
    const { adapter, model } = MolWorkbench.app, st = adapter.ed.struct();
    return { atoms: [...st.atoms.values()].map(a => a.pp.x).sort((a, b) => a - b),
      arrows: [...st.rxnArrows].map(([id, arrow]) => ({ id, mode: arrow.mode, pos: arrow.pos.map(p => [p.x, p.y]) }))
        .sort((a, b) => a.pos[0][0] - b.pos[0][0]), bend: model.state.arrows[0].geometry.bend };
  })()`);
  const stagesBefore = await reactionSnapshot();
  const stagesLayout = await clean();
  const stagesAfter = await reactionSnapshot();
  await js('window.__restoreLayoutReplan()');
  check('整理按两支斜直箭头划成三段并在段内紧凑摆放', stagesLayout.ok && [0, 2, 4].every(i =>
    Math.abs(stagesAfter.atoms[i + 1] - stagesAfter.atoms[i] - 1.10) < 1e-4), JSON.stringify(stagesAfter));
  check('直箭头保留原位置和可编辑身份', stagesBefore.arrows.length === 2 &&
    JSON.stringify(stagesBefore.arrows) === JSON.stringify(stagesAfter.arrows));
  check('重排弯箭头时已使用整理后的字形坐标', await js('window.__freshLayoutGlyph') === true);
  await js('window.k3dAPI.undo()');
  check('一次撤销恢复阶段间距和弯箭头', JSON.stringify(await reactionSnapshot()) === JSON.stringify(stagesBefore));
  await js('window.k3dAPI.redo()');
  check('一次重做还原整理结果', JSON.stringify(await reactionSnapshot()) === JSON.stringify(stagesAfter));

  // ---------------- 文字选区：提示选择分子 ----------------
  console.log('[选区类型] 只选文字 → 提示选择分子');
  const rText = await js(`(async () => {
    const ed = document.getElementById('k').contentWindow.ketcher.editor;
    ed.selection({ texts: [0] });
    return window.k3dAPI.cleanLayout();
  })()`);
  check('只选文字时给出提示', rText.ok === false && rText.code === 'no_molecule', JSON.stringify(rText));

  // ---------------- 陈旧结果不覆盖新内容 ----------------
  console.log('[L13] 异步期间编辑 → 旧结果作废');
  await js(`(() => {
    const ed = document.getElementById('k').contentWindow.ketcher.editor;
    ed.selection(null);
    const orig = window.fetch.bind(window);
    window.__origFetch = orig;
    window.fetch = async (url, opt) => {
      if (String(url).indexOf('/api/layout') >= 0) {
        await new Promise(r => setTimeout(r, 600));
      }
      return orig(url, opt);
    };
  })()`);
  let staleRes = null;
  try {
    const stalePromise = js(`window.k3dAPI.cleanLayout()`);
    await wait(150);
    await js(`document.getElementById('k').contentWindow.ketcher.addFragment('CCC')`);
    await wait(200);
    staleRes = await stalePromise;
  } catch (e) { staleRes = { ok: false, code: 'test_error', message: String(e) }; }
  await js(`(() => { window.fetch = window.__origFetch; return 'restored'; })()`);
  check('陈旧结果被拒绝', !!staleRes && staleRes.ok === false && staleRes.code === 'stale', JSON.stringify(staleRes));

  // ---------------- 工具栏入口：按钮与快捷键都只执行一次 ----------------
  console.log('[L02] 顶部按钮与快捷键');
  await js(`(async () => { await window.k3dAPI.setMolecule('F[C@](Cl)(Br)I'); })()`);
  await wait(700);
  let h0 = JSON.parse(await hist());
  await js(`(() => {
    const btn = document.getElementById('k').contentDocument.querySelector('[data-testid="Layout button"]');
    if (!btn) return 'no button';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked';
  })()`);
  await wait(1200);
  let h1 = JSON.parse(await hist());
  check('顶部 Layout 按钮只执行一次整理', h1.undo === h0.undo + 1, `${h0.undo} -> ${h1.undo}`);

  h0 = JSON.parse(await hist());
  await js(`(() => {
    const d = document.getElementById('k').contentDocument;
    d.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', keyCode: 76, which: 76, metaKey: true, bubbles: true, cancelable: true }));
    return 'sent';
  })()`);
  await wait(1200);
  h1 = JSON.parse(await hist());
  check('⌘L 只执行一次整理', h1.undo === h0.undo + 1, `${h0.undo} -> ${h1.undo}`);

  h0 = JSON.parse(await hist());
  await js(`(() => {
    const btn = document.getElementById('k').contentDocument.querySelector('[data-testid="Clean Up button"]');
    if (!btn) return 'no button';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'clicked';
  })()`);
  await wait(1200);
  h1 = JSON.parse(await hist());
  check('Clean Up 按钮也走统一整理', h1.undo === h0.undo + 1, `${h0.undo} -> ${h1.undo}`);
  const gAfter = JSON.parse(await gaps());
  check('Clean Up 后不是机械十字', !gAfter.every(x => x >= 80 && x <= 100), JSON.stringify(gAfter));

  // ---------------- L14：一实一虚画法保留 ----------------
  console.log('[L14] W04/W05 一实一虚');
  const ketOf = (fid) => fs.readFileSync(path.join(__dirname, 'fixtures', fid + '.ket'), 'utf8');
  const bondStereo = () => js(`(() => {
    const k = document.getElementById('k').contentWindow.ketcher;
    return k.getKet().then(t => {
      const d = JSON.parse(t);
      const m = Object.keys(d).find(x => d[x] && d[x].type === 'molecule');
      const st = (d[m].bonds || []).map(b => b.stereo || 0);
      return JSON.stringify({ up: st.filter(x => x === 1).length, down: st.filter(x => x === 6).length, all: st });
    });
  })()`);
  for (const fid of ['W04', 'W05']) {
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(ketOf(fid))})`);
    await wait(800);
    await shot(`before-${fid}`);
    const s0 = await smiles();
    const b0 = JSON.parse(await bondStereo());
    const r = await clean();
    await wait(500);
    await shot(`after-${fid}`);
    const s1 = await smiles();
    const b1 = JSON.parse(await bondStereo());
    check(`${fid} 整理成功`, r.ok === true, JSON.stringify(r));
    check(`${fid} 输入是一实一虚`, b0.up === 1 && b0.down === 1, JSON.stringify(b0));
    check(`${fid} 整理后仍是一实一虚`, b1.up === 1 && b1.down === 1, JSON.stringify(b1));
    check(`${fid} 构型保持`, s0 === s1, `${s0} -> ${s1}`);
    // 撤销回原画法、重做回到整理后（L14 的撤销/重做覆盖）
    await js(`window.k3dAPI.undo()`);
    await wait(400);
    const bUndo = JSON.parse(await bondStereo());
    check(`${fid} 撤销恢复原楔键`, bUndo.up === b0.up && bUndo.down === b0.down,
          `${JSON.stringify(b0)} -> ${JSON.stringify(bUndo)}`);
    await js(`window.k3dAPI.redo()`);
    await wait(400);
    const bRedo = JSON.parse(await bondStereo());
    check(`${fid} 重做回到一实一虚`, bRedo.up === 1 && bRedo.down === 1, JSON.stringify(bRedo));
  }

  // ---------------- R03：重复整理不摆动 ----------------
  console.log('[R03] 连续整理稳定');
  await js(`window.k3dAPI.setMolecule(${JSON.stringify(ketOf('M03'))})`);
  await wait(800);
  const coordsOf = () => js(`(() => {
    const st = document.getElementById('k').contentWindow.ketcher.editor.struct();
    return JSON.stringify(Array.from(st.atoms.entries()).map(([id, a]) => [+a.pp.x.toFixed(4), +a.pp.y.toFixed(4)]));
  })()`);
  await clean();
  await wait(400);
  const c1 = JSON.parse(await coordsOf());
  await clean();
  await wait(400);
  const c2 = JSON.parse(await coordsOf());
  const drift = Math.max(...c1.map((p, i) => Math.hypot(p[0] - c2[i][0], p[1] - c2[i][1])));
  check('连续两次整理位移 <= 1e-3', drift <= 1e-3, `drift=${drift.toFixed(4)}`);

  // ---------------- 3D 目标清单 ----------------
  console.log('[3D] stereoTargets');
  const t1 = await js(`window.k3dAPI.stereoTargets()`);
  check('无选区 → 全部目标', t1.ok === true && t1.keys.length >= 1, JSON.stringify(t1.keys));
  check('返回整份 KET', typeof t1.ket === 'string' && t1.ket.length > 50);
  check('返回文档身份', typeof t1.identity === 'string' && t1.identity.length > 3);

  console.log('');
  console.log(`结果：${PASS} PASS / ${FAIL} FAIL`);
  if (FAILED.length) { console.log('失败项：'); FAILED.forEach(f => console.log('  -', f)); }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ PASS, FAIL, FAILED }, null, 1));
  app.quit();
  process.exit(FAIL ? 1 : 0);
});
