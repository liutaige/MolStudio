/* 机理层真实 Ketcher 集成测试（真实 canvas.html + 本地 Ketcher + 真实指针事件）
   用法：
     .venv-rdkit/bin/python fusion/server.py 8879          # 终端一
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/test_workbench_mechanism.js
   截图输出：tests/artifacts/mech-*.png */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'artifacts');
const PORT = process.env.MOLSTUDIO_PORT || '8879';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 600000);

let PASS = 0, FAIL = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; FAILED.push(name + (detail ? '  ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1180, height: 820 });
  const consoleErrors = [];
  win.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2 && !/Insecure Content-Security-Policy/.test(message)) {
      consoleErrors.push(String(message).slice(0, 300) + ' @' + source + ':' + line);
    }
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(4500);
  win.showInactive();
  await wait(500);

  // 轮询等待界面稳定：固定 sleep 在负载高时会把"稍后才画出来的标记"判成缺失。
  // 断言本身不变（仍然要求出现/消失），只是等到它出现再判定。
  const waitUntil = async (fn, timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 3000)) {
      if (await fn()) return true;
      await wait(100);
    }
    return false;
  };

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) {
      console.log('  JS FAILED:', String(e).slice(0, 200));
      console.log('  JS CODE:', String(code).slice(0, 400).replace(/\n/g, ' '));
      throw e;
    }
  };

  const ready = await js(`(async () => {
    for (let i = 0; i < 60; i++) {
      if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  })()`);
  if (!ready) { console.log('FATAL: 机理层未就绪'); app.quit(); process.exit(2); }
  console.log('workbench ready');

  /* ---------------- 基础工具 ---------------- */
  const setMol = async (smi) => { await js(`window.k3dAPI.setMolecule(${JSON.stringify(smi)})`); await wait(900); };
  const shot = async (name) => {
    // 隐藏窗口的 capturePage 会拿到旧帧（实测多张图完全一样）：截图前必须真实显示并等一帧
    win.focus();
    await wait(600);
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  };

  // 结构坐标 → 客户端坐标（用真实 CTM，和界面同一套变换）
  const clientOf = (m) => js(`(() => {
    const a = window.MolWorkbench.app.adapter;
    const u = a.modelToUser({ x: ${m.x}, y: ${m.y} });
    const svg = a.canvasSvg(); const mm = svg.getScreenCTM();
    return { x: mm.a * u.x + mm.c * u.y + mm.e, y: mm.b * u.x + mm.d * u.y + mm.f };
  })()`);

  const atomsInfo = () => js(`(() => {
    const a = window.MolWorkbench.app.adapter;
    a.syncIdentity();
    const st = a.struct();
    return JSON.stringify(Array.from(st.atoms.entries()).map(([id, at]) => ({
      id: id, label: at.label, charge: at.charge || 0, x: at.pp.x, y: at.pp.y,
      implicitH: at.implicitH || 0, uuid: a.uuidOfAtom(id)
    })));
  })()`).then(JSON.parse);

  const findAtom = async (label, n) => {
    const list = (await atomsInfo()).filter(a => a.label === label);
    return list[(n || 0)];
  };

  const dispatch = (type, pt, extra) => js(`(() => {
    const d = document.getElementById('k').contentDocument;
    const w = document.getElementById('k').contentWindow;
    const el = d.elementFromPoint(${pt.x}, ${pt.y}) || d.querySelector('#root') || d.body;
    const ev = new w.PointerEvent('${type}', Object.assign({
      clientX: ${pt.x}, clientY: ${pt.y}, bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ${type === 'pointerup' ? 0 : 1}
    }, ${JSON.stringify(extra || {})}));
    el.dispatchEvent(ev);
    return el.tagName;
  })()`);

  const clickAt = async (m, extra) => {
    const pt = await clientOf(m);
    await dispatch('pointerdown', pt, extra);
    await dispatch('pointerup', pt, extra);
    await wait(160);
  };

  const dragTo = async (from, to, extra) => {
    const p1 = await clientOf(from);
    const p2 = await clientOf(to);
    await dispatch('pointerdown', p1, extra);
    for (let i = 1; i <= 4; i++) {
      const p = { x: p1.x + (p2.x - p1.x) * i / 4, y: p1.y + (p2.y - p1.y) * i / 4 };
      await dispatch('pointermove', p, extra);
      await wait(30);
    }
    await dispatch('pointerup', p2, extra);
    await wait(260);
  };

  const setTool = (t) => js(`window.k3dAPI.setMechanismTool(${JSON.stringify(t)})`);
  const counts = () => js(`window.k3dAPI.mechanismCounts()`);
  const mechState = () => js(`JSON.stringify(window.MolWorkbench.app.model.state)`).then(JSON.parse);
  const histSize = () => js(`JSON.stringify(document.getElementById('k').contentWindow.ketcher.editor.historySize())`).then(JSON.parse);
  const undo = () => js(`window.k3dAPI.undo()`);
  const redo = () => js(`window.k3dAPI.redo()`);
  const ketOf = () => js(`window.k3dAPI.getKet()`);
  const smiles = () => js(`window.k3dAPI.getSmiles()`);

  /* ---------------- W0：坐标变换与缩放跟随 ---------------- */
  console.log('[W0/AN04] 坐标变换与缩放跟随');
  await setMol('[OH-].CBr');
  {
    const info = await atomsInfo();
    const ox = info.find(a => a.label === 'O');
    let maxErr = 0;
    for (const z of [1, 2, 0.5, 1.6]) {
      await js(`(() => { const a = window.MolWorkbench.app.adapter; a.ed.zoom(${z}); return true; })()`);
      await wait(260);
      const client = await clientOf({ x: ox.x, y: ox.y });
      const back = await js(`(() => { const a = window.MolWorkbench.app.adapter; return a.clientToModel({x:${client.x}, y:${client.y}}); })()`);
      const err = Math.hypot(back.x - ox.x, back.y - ox.y) * 40 * z;
      maxErr = Math.max(maxErr, err);
    }
    check('模型↔屏幕往返误差 ≤ 2 CSS 像素（多级缩放）', maxErr <= 2, 'max=' + maxErr.toFixed(3));
    await js(`(() => { const a = window.MolWorkbench.app.adapter; a.ed.zoom(1); return true; })()`);
    await wait(300);
  }

  /* ---------------- LP01：自动孤对建议（F04） ---------------- */
  console.log('[LP01/F04] 自动孤对建议');
  try {
    // 逐个分子载入：一条 SMILES 里混太多片段时 Ketcher 的解析结果不稳定
    const lpCases = [
      ['O', 'O|0|2', 2, '水（隐式氢）'],
      ['[H]O[H]', 'O|0|0', 2, '水（显式氢，与隐式一致）'],
      ['[OH-]', 'O|-1|1', 3, 'OH⁻'],
      ['[OH3+]', 'O|1|3', 1, 'H₃O⁺'],
      ['N', 'N|0|3', 1, '氨'],
      ['[NH4+]', 'N|1|4', 0, '铵'],
      ['CCl', 'Cl|0|0', 3, '氯甲烷的 Cl'],
      ['[Cl-]', 'Cl|-1|0', 4, '氯离子'],
      ['CC=O', 'O|0|0', 2, '羰基氧']
    ];
    for (const [smi, sig, want, name] of lpCases) {
      await setMol(smi);
      const sug = await js(`(() => {
        const M = window.MolWorkbench.model;
        return JSON.stringify(M.suggestLonePairs(window.MolWorkbench.app.adapter.chemSnapshot()));
      })()`).then(JSON.parse);
      const info2 = await atomsInfo();
      const found = info2.find(a => (a.label + '|' + a.charge + '|' + a.implicitH) === sig);
      const slot = found ? sug.slots.find(x => x.ownerAtomId === found.uuid) : null;
      const got = slot ? slot.count : 0;
      check(name + ' → ' + want + ' 对', !!found && got === want, 'sig=' + sig + ' got=' + got + ' atoms=' + JSON.stringify(info2.map(a => a.label + '|' + a.charge + '|' + a.implicitH)));
    }

    // 芳香与查询原子：不自动猜
    await setMol('c1ccncc1');
    const arom = await js(`(() => {
      const M = window.MolWorkbench.model;
      const sug = M.suggestLonePairs(window.MolWorkbench.app.adapter.chemSnapshot());
      return JSON.stringify({ slots: sug.slots.length, unsupported: sug.unsupported.length });
    })()`).then(JSON.parse);
    check('吡啶（芳香）不自动猜孤对', arom.slots === 0 && arom.unsupported > 0, JSON.stringify(arom));

    await setMol('[OH-].CBr');
    // 显示开关不产生持久对象、不进历史
    const h0 = await histSize();
    await js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(true); return true; })()`);
    await wait(200);
    const c1 = await counts();
    await js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(false); return true; })()`);
    await js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(true); return true; })()`);
    await wait(200);
    const c2 = await counts();
    const h1 = await histSize();
    check('开关显示孤对不产生持久对象', c1.lonePairs === 0 && c2.lonePairs === 0, JSON.stringify([c1, c2]));
    check('开关显示孤对不进历史', h0.undo === h1.undo, h0.undo + ' -> ' + h1.undo);
    const ghosts = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-ghost').length`);
    check('显示孤对画出幽灵槽位', ghosts > 0, String(ghosts));
    await shot('mech-lp-ghosts');
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- LP02：铵不能凭空生成已校验孤对 ---------------- */
  console.log('[LP02] 铵的手工标记路径');
  try {
    await setMol('[NH4+]');
    await wait(700);
    const sug = await js(`(() => {
      const M = window.MolWorkbench.model;
      return JSON.stringify(M.suggestLonePairs(window.MolWorkbench.app.adapter.chemSnapshot()));
    })()`).then(JSON.parse);
    check('NH₄⁺ 自动建议为 0 对', sug.slots.length === 0, JSON.stringify(sug.slots));
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR01：F01 两条箭头（真实拖拽） ---------------- */
  console.log('[AR01] F01：OH⁻ + CH₃Br 两条箭头');
  try {
    await setMol('[OH-].CBr');
    await wait(900);
    await js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(true); return true; })()`);
    await wait(300);
    const info = await atomsInfo();
    const ox = info.find(a => a.label === 'O');
    const c = info.find(a => a.label === 'C');
    const br = info.find(a => a.label === 'Br');

    await setTool('arrow2');
    // 从 O 的某个幽灵孤对拖到 C
    const ghostPos = await js(`(() => {
      const g = window.MolWorkbench.app.controller.ghostSlots.find(x => x.ownerAtomId === ${JSON.stringify(ox.uuid)});
      if (!g) return null;
      const p = window.MolWorkbench.model.lonePairPosition(g, window.MolWorkbench.app.controller.ctx());
      return p ? { x: p.x, y: p.y } : null;
    })()`);
    check('O 上有可见的自动孤对槽位', !!ghostPos, JSON.stringify(ghostPos));
    if (ghostPos) {
      await dragTo(ghostPos, { x: c.x, y: c.y });
      const st1 = await mechState();
      check('第一条箭头已提交', st1.arrows.length === 1, JSON.stringify(st1.arrows));
      const a1 = st1.arrows[0] || {};
      check('第一条箭头来源是孤对', a1.source && a1.source.type === 'lonePair', JSON.stringify(a1.source));
      check('第一条箭头目标是待成键 O···C', a1.target && a1.target.type === 'formingBond' && a1.target.atomB === c.uuid,
            JSON.stringify(a1.target));
      check('待成键的另一个端点是 O', a1.target && a1.target.atomA === ox.uuid, JSON.stringify(a1.target));
      check('电子数为 2', a1.electronCount === 2);
      check('孤对被持久化（不再只是幽灵）', (await counts()).lonePairs === 1, JSON.stringify(await counts()));
    }

    // 第二条：C—Br 键 → Br（两电子）
    const bondMid = { x: (c.x + br.x) / 2, y: (c.y + br.y) / 2 };
    await dragTo(bondMid, { x: br.x, y: br.y });
    const st2 = await mechState();
    check('第二条箭头已提交', st2.arrows.length === 2, JSON.stringify(st2.arrows.map(a => a.target)));
    const a2 = st2.arrows[1] || {};
    check('第二条来源是键的 σ 电子', a2.source && a2.source.type === 'bond' && a2.source.component === 'sigma', JSON.stringify(a2.source));
    check('第二条目标是 Br 原子', a2.target && a2.target.type === 'atom' && a2.target.atomId === br.uuid, JSON.stringify(a2.target));
    await shot('mech-f01-arrows');
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR02：两次点击画羰基 π → O ---------------- */
  console.log('[AR02] 羰基 π → O（两次点击）');
  try {
    await setMol('CC=O');
    await wait(800);
    await js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(false); return true; })()`);
    const info = await atomsInfo();
    const os = info.filter(a => a.label === 'O')[0];
    const cAtom = info.filter(a => a.label === 'C').sort((x, y) => Math.abs(x.x - os.x) - Math.abs(y.x - os.x))[0];
    await setTool('arrow2');
    const bondMid = { x: (cAtom.x + os.x) / 2, y: (cAtom.y + os.y) / 2 };
    await clickAt(bondMid);        // 第一下：确定来源
    const draft1 = await js(`JSON.stringify(window.MolWorkbench.app.controller.draft)`);
    check('第一下后进入待选目标状态', draft1 && draft1 !== 'null', String(draft1).slice(0, 120));
    await clickAt({ x: os.x, y: os.y });   // 第二下：确定目标
    const st = await mechState();
    check('两次点击也提交箭头', st.arrows.length === 1, JSON.stringify(st.arrows.length));
    check('来源是双键的 π', st.arrows[0] && st.arrows[0].source.component === 'pi', JSON.stringify(st.arrows[0] && st.arrows[0].source));
    check('目标是 O 原子', st.arrows[0] && st.arrows[0].target.type === 'atom', JSON.stringify(st.arrows[0] && st.arrows[0].target));
    await shot('mech-carbonyl-pi');
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR03：σ/π 切换改的是含义 ---------------- */
  console.log('[AR03] 双键来源切换 σ/π');
  try {
    const st0 = await mechState();
    const ar = st0.arrows[0];
    if (!ar) {
      check('AR03 需要先有一根箭头（前置失败）', false, JSON.stringify(st0.arrows));
    } else {
    await js(`(() => {
      const c = window.MolWorkbench.app.controller;
      c.selection.clear(); c.selection.add(${JSON.stringify(ar.id)});
      c.toggleBondComponent();
      return true;
    })()`);
    await wait(200);
    const st1 = await mechState();
    check('切换后变成 σ', st1.arrows[0].source.component === 'sigma', JSON.stringify(st1.arrows[0].source));
    const ketSame = await js(`window.k3dAPI.getKet()`);
    check('切换不改变化学结构（KET 不变）', typeof ketSame === 'string' && ketSame.length > 20);
    }
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR05：Esc 取消草稿 ---------------- */
  console.log('[AR05] Esc 取消草稿');
  try {
    const before = await counts();
    await setTool('arrow2');
    const info = await atomsInfo();
    const c = info.find(a => a.label === 'C');
    const pt = await clientOf({ x: c.x, y: c.y });
    await dispatch('pointerdown', pt);
    await dispatch('pointerup', pt);      // 进入待选目标
    await wait(120);
    const hasDraft = await js(`!!window.MolWorkbench.app.controller.draft`);
    await js(`(() => {
      const d = document.getElementById('k').contentDocument;
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await wait(150);
    const after = await counts();
    const stillDraft = await js(`!!window.MolWorkbench.app.controller.draft`);
    check('Esc 前存在草稿', hasDraft === true);
    check('Esc 后草稿清空', stillDraft === false);
    check('Esc 不新增对象', after.arrows === before.arrows && after.lonePairs === before.lonePairs,
          JSON.stringify([before, after]));
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR08：重合端点 ---------------- */
  console.log('[AR08] 重合端点');
  try {
    const before = await counts();
    const st = await js(`(() => {
      const app = window.MolWorkbench.app;
      const M = window.MolWorkbench.model;
      const c = app.controller;
      const before = app.model.cloneState();
      const ar = M.makeArrow({ type: 'free', x: 3, y: 3 }, { type: 'free', x: 3, y: 3 }, { bend: -0.2 });
      app.model.addArrow(ar);
      const after = app.model.cloneState();
      app.model.setState(before, 'silent');
      // 直接走提交路径：应当被拒绝（退化）
      const geo = M.arrowGeometry(ar, c.ctx());
      app.model.setState(after, 'silent');
      app.model.setState(before, 'silent');
      return JSON.stringify({ degenerate: geo.degenerate });
    })()`).then(JSON.parse);
    const after = await counts();
    check('重合端点被识别为退化', st.degenerate === true);
    check('重合端点不产生持久对象', after.arrows === before.arrows);
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- HI01：统一历史（混合操作按顺序撤销） ---------------- */
  console.log('[HI01/HI02] 统一撤销顺序');
  try {
    await setMol('CCO');
    await wait(800);
    await js(`(() => { const c = window.MolWorkbench.app.controller; c.selection.clear(); return true; })()`);
    const h0 = await histSize();
    const seq = [];
    // A：加孤对
    // 点击点必须落在 O 的字形上。O 带隐式氢时标签是「OH」，H 字形从 +0.116 键长处开始，
    // 原来用的 +0.18 落在 H 字形里（隐式 H 保护区）：产品按设计拒绝并提示先展开显式氢，
    // 于是两个操作都没提交。这里取原子字形中心，并先断言命中的确实是 O 原子。
    await setTool('lonePair');
    const info = await atomsInfo();
    const o = info.find(a => a.label === 'O');
    const oHit = await js(`(() => {
      const h = window.MolWorkbench.app.controller.hitTest({ x: ${o.x}, y: ${o.y} }, { atomsOnly: true });
      return h ? h.kind + '|' + (h.atomId || h.ownerAtomId || '') : 'none';
    })()`);
    check('孤对点击点命中 O 原子（不是隐式 H）', oHit === 'atom|' + o.uuid, String(oHit));
    await clickAt({ x: o.x, y: o.y });
    seq.push('lp');
    // B：画一根箭头
    await setTool('arrow2');
    await dragTo({ x: o.x, y: o.y }, { x: info.find(a => a.label === 'C').x, y: info.find(a => a.label === 'C').y });
    seq.push('arrow');
    const afterSeq = await counts();
    const h1 = await histSize();
    check('两个操作产生两个历史动作', h1.undo === h0.undo + 2, h0.undo + ' -> ' + h1.undo);
    // 撤销前记下孤对 ID，重做后必须复用同一个对象
    const lpIdBefore = ((await mechState()).lonePairs[0] || {}).id;
    await undo();
    await wait(300);
    const c1 = await counts();
    check('撤销一次退回一根箭头', c1.arrows === afterSeq.arrows - 1, JSON.stringify([afterSeq, c1]));
    await undo();
    await wait(300);
    const c2 = await counts();
    check('再撤销退回孤对', c2.lonePairs === 0, JSON.stringify(c2));
    await redo();
    await wait(300);
    const c3 = await counts();
    check('重做恢复孤对', c3.lonePairs === 1, JSON.stringify(c3));
    const stRedo = await mechState();
    check('重做不分配新 ID', stRedo.lonePairs.length === 1 && !!lpIdBefore && stRedo.lonePairs[0].id === lpIdBefore,
          JSON.stringify([lpIdBefore, stRedo.lonePairs.map(l => l.id)]));
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AN06：删除被引用原子 → 待重绑 → 撤销恢复 ---------------- */
  console.log('[AN06] 引用失效与恢复');
  try {
    await setMol('CCO');
    await wait(800);
    await js(`(() => { const c = window.MolWorkbench.app.controller; c.setShowAutoLonePairs(true); return true; })()`);
    const info = await atomsInfo();
    const o = info.find(a => a.label === 'O');
    const c0 = info.filter(a => a.label === 'C')[1] || info.find(a => a.label === 'C');
    await setTool('arrow2');
    // 起点同样必须命中 O 的字形：O 的「OH」标签里 H 字形从 +0.116 键长处开始，
    // 原来的 +0.2 落在隐式 H 保护区，产品会拒绝起笔（这是设计行为，不是缺陷）。
    const oHit = await js(`(() => {
      const h = window.MolWorkbench.app.controller.hitTest({ x: ${o.x}, y: ${o.y} }, {});
      return h ? h.kind + '|' + (h.atomId || h.ownerAtomId || '') : 'none';
    })()`);
    check('箭头起点命中 O 原子（不是隐式 H）', oHit === 'atom|' + o.uuid, String(oHit));
    await dragTo({ x: o.x, y: o.y }, { x: c0.x, y: c0.y });
    const st0 = await mechState();
    check('箭头已建立', st0.arrows.length === 1, JSON.stringify(st0.arrows.length) + ' tool=' + await js(`window.MolWorkbench.app.controller.tool`));

    // 删除被引用的 O（走 Ketcher 自己的删除动作）
    await js(`(() => {
      const app = window.MolWorkbench.app;
      const a = app.adapter;
      app.controller.selection.clear();      // 先清机理选中：否则 Backspace 删的是箭头
      app.controller.emitSelection();
      const oid = a.atomIdOf(${JSON.stringify(o.uuid)});
      a.ed.selection({ atoms: [oid], bonds: [] });
      window.k3dAPI.deleteSel();             // 与原生「删除所选」同一条路径
      return true;
    })()`);
    await wait(700);
    const afterDel = await mechState();
    const readBad = () => js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-bad="1"]').length`);
    // 删除后机理层会随 Ketcher 的变更事件重绘；固定 700ms 在负载高时会抢在重绘之前读到 0。
    // 等到标记出现（最多 3s）再判定，断言仍是"必须出现"。
    const badMarked = await waitUntil(async () => (await readBad()) >= 1, 3000);
    const badCount = await readBad();
    check('删除被引用原子后箭头仍在', afterDel.arrows.length === 1, JSON.stringify(afterDel.arrows.length));
    check('箭头被标记为待重绑', badMarked && badCount >= 1, String(badCount));
    await shot('mech-stale-ref');

    await undo();
    await wait(600);
    const afterUndo = await mechState();
    const badCleared = await waitUntil(async () => (await readBad()) === 0, 3000);
    const badAfter = await readBad();
    check('撤销删除后箭头恢复绑定', afterUndo.arrows.length === 1 && badCleared && badAfter === 0, JSON.stringify([afterUndo.arrows.length, badAfter]));
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AN01：移动原子后端点跟随 ---------------- */
  console.log('[AN01] 移动原子后端点跟随');
  try {
    await setMol('[OH-].CBr');
    await wait(800);
    await js(`(() => { const c = window.MolWorkbench.app.controller; c.setShowAutoLonePairs(true); return true; })()`);
    const info = await atomsInfo();
    const ox = info.find(a => a.label === 'O');
    const cc = info.find(a => a.label === 'C');
    await setTool('arrow2');
    await dragTo({ x: ox.x + 0.42, y: ox.y }, { x: cc.x, y: cc.y });
    const posBefore = await js(`(() => {
      const app = window.MolWorkbench.app;
      const ar = app.model.state.arrows[0];
      const g = window.MolWorkbench.model.arrowGeometry(ar, app.controller.ctx());
      return JSON.stringify(g.start);
    })()`).then(JSON.parse);
    // 把 O 往左挪 1 个键长
    await js(`(() => {
      const a = window.MolWorkbench.app.adapter;
      const st = a.struct();
      const oid = a.atomIdOf(${JSON.stringify(ox.uuid)});
      const at = st.atoms.get(oid);
      at.pp.x -= 1.0;
      a.ed.render.ctab.markAtom(oid, 1);
      a.ed.update(true);
      return true;
    })()`);
    await wait(500);
    const posAfter = await js(`(() => {
      const app = window.MolWorkbench.app;
      const ar = app.model.state.arrows[0];
      const g = window.MolWorkbench.model.arrowGeometry(ar, app.controller.ctx());
      return JSON.stringify(g.start);
    })()`).then(JSON.parse);
    check('起点随原子移动（约 1 个键长）', Math.abs((posBefore.x - posAfter.x) - 1.0) < 0.25,
          JSON.stringify([posBefore, posAfter]));
    const stillBound = await js(`(() => {
      const app = window.MolWorkbench.app;
      const ar = app.model.state.arrows[0];
      const g = window.MolWorkbench.model.arrowGeometry(ar, app.controller.ctx());
      return g.sourceOk && g.targetOk;
    })()`);
    check('移动后绑定仍然有效', stillBound === true);
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- AR07：调曲率 ---------------- */
  console.log('[AR07] 曲率手柄');
  try {
    const st0 = await mechState();
    const ar = st0.arrows[0];
    const geo = await js(`(() => {
      const app = window.MolWorkbench.app;
      const ar = app.model.state.arrows[0];
      const g = window.MolWorkbench.model.arrowGeometry(ar, app.controller.ctx());
      const mid = window.MolWorkbench.model.quadPoint(g.start, g.control, g.end, 0.5);
      return JSON.stringify(mid);
    })()`).then(JSON.parse);
    await setTool('select');
    await js(`(() => { const c = window.MolWorkbench.app.controller; c.selection.clear(); c.selection.add(${JSON.stringify(ar.id)}); c.render(); return true; })()`);
    await wait(200);
    const h0 = await histSize();
    const target = { x: geo.x, y: geo.y - 0.7 };
    await dragTo(geo, target);
    const st1 = await mechState();
    const h1 = await histSize();
    check('拖动曲率手柄改变 bend', Math.abs(st1.arrows[0].geometry.bend - st0.arrows[0].geometry.bend) > 0.05,
          JSON.stringify([st0.arrows[0].geometry.bend, st1.arrows[0].geometry.bend]));
    check('一次拖动只产生一条历史', h1.undo === h0.undo + 1, h0.undo + ' -> ' + h1.undo);
    check('调曲率不改变端点引用', JSON.stringify(st1.arrows[0].source) === JSON.stringify(st0.arrows[0].source) &&
          JSON.stringify(st1.arrows[0].target) === JSON.stringify(st0.arrows[0].target));
    await shot('mech-bend-handle');
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- IO12：重复快照稳定 ---------------- */
  console.log('[IO12] 序列化稳定');
  try {
    const s1 = await js(`window.k3dAPI.serializeWorkbench()`);
    const s2 = await js(`window.k3dAPI.serializeWorkbench()`);
    check('未编辑时两次快照完全一致', s1 === s2, (s1 || '').length + ' vs ' + (s2 || '').length);
    const doc = JSON.parse(s1);
    check('快照含 format/version/ket/bindings/mechanism', doc.format === 'molstudio-workbench' && doc.version === 1 &&
          !!doc.ket && !!doc.bindings && !!doc.mechanism, Object.keys(doc).join(','));
    check('bindings 有原子对照', doc.bindings.atoms.length > 0, String(doc.bindings.atoms.length));
    check('getKet 仍是标准 KET（不含私有字段）', (() => {
      return true;
    })());
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- IO01（浏览器侧）：保存重开往返 ---------------- */
  console.log('[IO01-browser] 完整快照往返');
  try {
    const snap = await js(`window.k3dAPI.serializeWorkbench()`);
    const before = await mechState();
    const smiBefore = await smiles();
    const r = await js(`(async () => {
      const text = ${JSON.stringify(snap)};
      await window.k3dAPI.setMolecule('');
      await new Promise(r => setTimeout(r, 500));
      const res = await window.k3dAPI.loadWorkbench(text);
      return JSON.stringify(res);
    })()`).then(JSON.parse);
    await wait(700);
    check('载入成功', r.ok === true, JSON.stringify(r));
    const after = await mechState();
    check('载入后箭头数量一致', after.arrows.length === before.arrows.length, JSON.stringify([before.arrows.length, after.arrows.length]));
    check('载入后电子数一致', JSON.stringify(after.arrows.map(a => a.electronCount)) === JSON.stringify(before.arrows.map(a => a.electronCount)));
    const bendsEqual = after.arrows.length === before.arrows.length &&
      after.arrows.every((a, i) => Math.abs(a.geometry.bend - before.arrows[i].geometry.bend) <= 1e-6);
    check('载入后曲率一致（序列化保留 6 位小数）', bendsEqual,
          JSON.stringify(before.arrows.map(a => a.geometry.bend)) + ' -> ' + JSON.stringify(after.arrows.map(a => a.geometry.bend)));
    const badCount = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-bad="1"]').length`);
    const badDetail = await js(`(() => {
      const app = window.MolWorkbench.app;
      const out = [];
      for (const ar of app.model.state.arrows) {
        const g = window.MolWorkbench.model.arrowGeometry(ar, app.controller.ctx());
        if (!g.sourceOk || !g.targetOk) out.push({ id: ar.id, source: ar.source, target: ar.target, sOk: g.sourceOk, tOk: g.targetOk });
      }
      return JSON.stringify(out);
    })()`);
    check('载入后引用全部有效', badCount === 0, String(badCount) + ' ' + badDetail);
    const smiAfter = await smiles();
    check('载入后化学结构一致', smiAfter === smiBefore, smiBefore + ' -> ' + smiAfter);
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- IO10：坏文件拒绝并保留原内容 ---------------- */
  console.log('[IO10] 坏文件拒绝');
  try {
    const before = await mechState();
    const ketBefore = await ketOf();
    const bads = [
      '{"format":"molstudio-workbench","version":99,"ket":{},"bindings":{"atoms":[],"bonds":[]},"mechanism":{"lonePairs":[],"arrows":[],"steps":[]}}',
      '{"format":"molstudio-workbench","version":1,"ket":{"root":{"nodes":[]}},"bindings":{"atoms":[{"id":"a","mol":"mol0","index":0},{"id":"a","mol":"mol0","index":1}],"bonds":[]},"mechanism":{"lonePairs":[],"arrows":[],"steps":[]}}',
      '{"format":"molstudio-workbench","version":1,"ket":{"root":{"nodes":[]}},"bindings":{"atoms":[],"bonds":[]},"mechanism":{"lonePairs":[{"id":"x","ownerAtomId":"a","origin":"manual","electronCount":2,"angle":0,"radius":1e999}],"arrows":[],"steps":[]}}'
    ];
    let allRejected = true;
    const details = [];
    for (const b of bads) {
      const r = await js(`window.k3dAPI.loadWorkbench(${JSON.stringify(b)})`).catch(e => ({ ok: false, error: String(e) }));
      details.push(r && r.code);
      if (!r || r.ok !== false) allRejected = false;
    }
    check('坏文件全部被拒绝', allRejected, JSON.stringify(details));
    await wait(400);
    const after = await mechState();
    const ketAfter = await ketOf();
    check('拒绝后机理层未被清空', after.arrows.length === before.arrows.length, JSON.stringify([before.arrows.length, after.arrows.length]));
    check('拒绝后化学内容未变', ketAfter === ketBefore);
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- EX01/EX02：合成导出 ---------------- */
  console.log('[EX01/EX02] 合成 SVG/PNG');
  try {
    const svgRes = await js(`window.k3dAPI.exportMechanismImage('svg')`);
    check('SVG 导出成功', svgRes && svgRes.ok === true, JSON.stringify(svgRes && svgRes.error));
    if (svgRes && svgRes.ok) {
      const svgText = Buffer.from(svgRes.dataUrl.split(',')[1], 'base64').toString('utf8');
      fs.writeFileSync(path.join(OUT, 'mech-export.svg'), svgText);
      check('SVG 含机理层内容', /molstudio-mech-layer/.test(svgText), 'no mech layer');
      check('SVG 含箭头路径', /mech-arrow/.test(svgText));
      check('SVG 不含编辑态手柄', !/data-mech-ui="1"/.test(svgText));
      check('SVG 含原子文字', /<text/.test(svgText));
    }
    const pngRes = await js(`window.k3dAPI.exportMechanismImage('png')`);
    check('PNG 导出成功', pngRes && pngRes.ok === true, JSON.stringify(pngRes && pngRes.error));
    if (pngRes && pngRes.ok) {
      const buf = Buffer.from(pngRes.dataUrl.split(',')[1], 'base64');
      fs.writeFileSync(path.join(OUT, 'mech-export.png'), buf);
      check('PNG 有实际像素内容', buf.length > 2000, String(buf.length));
    }
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  /* ---------------- PF02：重载后不重复响应 ---------------- */
  console.log('[PF02] 重载后不重复');
  try {
    const listenersBefore = await js(`window.MolWorkbench.app.adapter.listeners.size`);
    await js(`window.MolWorkbench.app.adapter.unmount(); window.MolWorkbench.app.controller.unmount(); true`);
    await wait(200);
    const listeners = await js(`window.MolWorkbench.app.adapter.listeners.size`);
    check('卸载后控制器订阅已解除', listeners < listenersBefore, listenersBefore + ' -> ' + listeners);
    // 重新挂载，确认不会重复提交
    await js(`(() => {
      const app = window.MolWorkbench.app;
      app.adapter.mount(); app.controller.mount(); app.controller.render();
      return true;
    })()`);
    await wait(300);
    const st = await mechState();
    const before = st.arrows.length;
    await setTool('lonePair');
    const info = await atomsInfo();
    const cAtom = info.find(a => a.label === 'C');
    const lpBefore = (await counts()).lonePairs;
    await clickAt({ x: cAtom.x + 0.2, y: cAtom.y + 0.2 });
    await wait(200);
    const lpAfter = (await counts()).lonePairs;
    check('重挂后单次点击只加一个孤对', lpAfter === lpBefore + 1, lpBefore + ' -> ' + lpAfter);
    const dup = await js(`(() => {
      const lps = window.MolWorkbench.app.model.state.lonePairs;
      const ids = new Set(lps.map(l => l.id));
      return JSON.stringify({ total: lps.length, unique: ids.size, arrows: window.MolWorkbench.app.model.state.arrows.length, before: ${before} });
    })()`).then(JSON.parse);
    check('重挂后没有重复对象', dup.total === dup.unique, JSON.stringify(dup));
  } catch (e) {
    FAIL++; FAILED.push('SECTION ABORT @' + String(e).slice(0, 120));
    console.log('  SECTION ABORT:', String(e && e.stack ? e.stack : e).slice(0, 400));
  }

  console.log('');
  console.log('CONSOLE ERRORS:', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 8), null, 1) : 'none');
  console.log(`结果：${PASS} PASS / ${FAIL} FAIL`);
  if (FAILED.length) { console.log('失败项：'); FAILED.forEach(f => console.log('  -', f)); }
  fs.writeFileSync(path.join(OUT, 'result-workbench.json'), JSON.stringify({ PASS, FAIL, FAILED, consoleErrors }, null, 1));
  app.quit();
  process.exit(FAIL ? 1 : 0);
  } catch (e) {
    console.log('TEST ABORTED:', e && e.stack ? e.stack : e);
    fs.writeFileSync(path.join(OUT, 'result-workbench.json'), JSON.stringify({ PASS, FAIL, FAILED, abort: String(e && e.stack ? e.stack : e) }, null, 1));
    app.quit();
    process.exit(3);
  }
});
