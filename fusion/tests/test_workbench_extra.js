/* 机理层补充集成测试：鱼钩、自由端点、相同分子防串绑、整理跟随、运行时 ID 复用、
   框选删除、复制粘贴、只选机理对象时的整理/3D 提示、空画布导出、规模性能。
   用法：
     .venv-rdkit/bin/python fusion/server.py 8879          # 终端一
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/test_workbench_extra.js */
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
    const pageErrors = [];
    win.webContents.on('console-message', (e, level, message, line, source) => {
      if (level >= 2 && !/Insecure Content-Security-Policy/.test(String(message))) {
        pageErrors.push(String(message).slice(0, 240));
      }
    });
    await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
    await wait(4500);
    win.showInactive();
    await wait(400);

    const js = async (code) => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (e) { console.log('  JS FAILED:', String(e).slice(0, 200)); throw e; }
    };
    const ready = await js(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    })()`);
    if (!ready) { console.log('FATAL: 机理层未就绪'); app.quit(); process.exit(2); }

    const setMol = async (smi) => { await js(`window.k3dAPI.setMolecule(${JSON.stringify(smi)})`); await wait(950); };
    const shot = async (name) => {
      win.focus();
      await wait(600);
      const img = await win.capturePage();
      fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    };
    const clientOf = (m) => js(`(() => {
      const a = window.MolWorkbench.app.adapter;
      const u = a.modelToUser({ x: ${m.x}, y: ${m.y} });
      const mm = a.canvasSvg().getScreenCTM();
      return { x: mm.a * u.x + mm.c * u.y + mm.e, y: mm.b * u.x + mm.d * u.y + mm.f };
    })()`);
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
      await wait(170);
    };
    const dragTo = async (from, to, extra) => {
      const p1 = await clientOf(from);
      const p2 = await clientOf(to);
      await dispatch('pointerdown', p1, extra);
      for (let i = 1; i <= 4; i++) {
        const p = { x: p1.x + (p2.x - p1.x) * i / 4, y: p1.y + (p2.y - p1.y) * i / 4 };
        await dispatch('pointermove', p, extra);
        await wait(25);
      }
      await dispatch('pointerup', p2, extra);
      await wait(280);
    };
    const atomsInfo = () => js(`(() => {
      const a = window.MolWorkbench.app.adapter; a.syncIdentity();
      const st = a.struct();
      return JSON.stringify(Array.from(st.atoms.entries()).map(([id, at]) => ({
        id: id, label: at.label, charge: at.charge || 0, x: at.pp.x, y: at.pp.y, uuid: a.uuidOfAtom(id)
      })));
    })()`).then(JSON.parse);
    const mechState = () => js(`JSON.stringify(window.MolWorkbench.app.model.state)`).then(JSON.parse);
    const counts = () => js(`window.k3dAPI.mechanismCounts()`);
    const setTool = (t) => js(`window.k3dAPI.setMechanismTool(${JSON.stringify(t)})`);
    // 自动建议槽位的实际位置：起点用它，别用"原子 + 固定偏移"猜
    const ghostPoint = (uuid) => js(`(() => {
      const app = window.MolWorkbench.app, M = window.MolWorkbench.model;
      const g = app.controller.ghostSlots.find(x => x.ownerAtomId === ${JSON.stringify(uuid)});
      if (!g) return null;
      const p = M.lonePairPosition(g, app.controller.ctx());
      return p ? { x: p.x, y: p.y } : null;
    })()`);
    const clearMechSel = () => js(`(() => { const c = window.MolWorkbench.app.controller; c.selection.clear(); c.emitSelection(); return true; })()`);
    const histSize = () => js(`JSON.stringify(document.getElementById('k').contentWindow.ketcher.editor.historySize())`).then(JSON.parse);
    const showLP = (on) => js(`(() => { window.MolWorkbench.app.controller.setShowAutoLonePairs(${on ? 'true' : 'false'}); return true; })()`);

    /* ---------------- AR04：单电子鱼钩 ---------------- */
    console.log('[AR04] 鱼钩箭头（1 电子 + 半箭头尖）');
    try {
      await setMol('CBr');
      const info = await atomsInfo();
      const c = info.find(a => a.label === 'C');
      const br = info.find(a => a.label === 'Br');
      await setTool('arrow1');
      await dragTo({ x: (c.x + br.x) / 2, y: (c.y + br.y) / 2 }, { x: br.x, y: br.y });
      const st = await mechState();
      check('鱼钩已提交', st.arrows.length === 1, JSON.stringify(st.arrows.length));
      check('电子数为 1', st.arrows[0] && st.arrows[0].electronCount === 1, JSON.stringify(st.arrows[0] && st.arrows[0].electronCount));
      const barbs = await js(`(() => {
        const g = document.getElementById('k').contentDocument.querySelector('.mech-arrow[data-electrons="1"]');
        if (!g) return -1;
        return g.querySelectorAll('path').length;   // 曲线 + 半箭头尖 = 2
      })()`);
      check('鱼钩只画半个箭头尖', barbs === 2, String(barbs));
      const twoEl = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-electrons="2"]').length`);
      check('没有误用两电子外观', twoEl === 0, String(twoEl));
      await shot('mech-fishhook');
    } catch (e) { FAIL++; FAILED.push('AR04 段异常 ' + e.message); console.log('  AR04 ABORT', e.message); }

    /* ---------------- AR06：空白落空 vs Option 自由端点 ---------------- */
    console.log('[AR06] 空白落空不提交 / Option 提交自由端点');
    try {
      await setMol('CCO');
      const info = await atomsInfo();
      const o = info.find(a => a.label === 'O');
      const c = info.filter(a => a.label === 'C')[1] || info.find(a => a.label === 'C');
      await setTool('arrow2');
      const before = (await counts()).arrows;
      await dragTo({ x: o.x + 0.2, y: o.y }, { x: o.x + 3.5, y: o.y - 2.5 });
      const afterPlain = (await counts()).arrows;
      check('拖到空白不提交（不假装绑定）', afterPlain === before, before + ' -> ' + afterPlain);
      await js(`(() => { const c = window.MolWorkbench.app.controller; c.cancelDraft(); return true; })()`);
      await dragTo({ x: o.x + 0.2, y: o.y }, { x: o.x + 3.5, y: o.y - 2.5 }, { altKey: true });
      const st = await mechState();
      const last = st.arrows[st.arrows.length - 1];
      check('Option + 空白提交自由端点', !!last && last.target.type === 'free', JSON.stringify(last && last.target));
      check('自由端点不是假的化学绑定', !!last && last.target.type !== 'atom' && last.target.type !== 'formingBond');
    } catch (e) { FAIL++; FAILED.push('AR06 段异常 ' + e.message); console.log('  AR06 ABORT', e.message); }

    /* ---------------- AN03：两个相同分子不串绑 ---------------- */
    console.log('[AN03] 相同分子不串绑');
    try {
      await setMol('CCO.CCO');
      await showLP(true);
      const info = await atomsInfo();
      // 左侧分子 = x 较小的一组
      const sorted = info.slice().sort((a, b) => a.x - b.x);
      const left = sorted.slice(0, 3);
      const right = sorted.slice(3);
      const lO = left.find(a => a.label === 'O');
      const lC = left.find(a => a.label === 'C');
      const rO = right.find(a => a.label === 'O');
      await setTool('arrow2');
      const gp3 = await ghostPoint(lO.uuid);
      await dragTo(gp3 || { x: lO.x + 0.2, y: lO.y }, { x: lC.x, y: lC.y });
      const st0 = await mechState();
      check('左侧分子箭头已建立', st0.arrows.length === 1, JSON.stringify(st0.arrows.length) + ' ghost=' + JSON.stringify(gp3));
      const targetUuid = st0.arrows[0].target.atomB;
      // 把右侧分子整体右移 3 个键长（模拟移动/交换位置）
      await js(`(() => {
        const a = window.MolWorkbench.app.adapter;
        const st = a.struct();
        const rightUuids = ${JSON.stringify(right.map(r => r.uuid))};
        const ids = rightUuids.map(u => a.atomIdOf(u)).filter(x => x !== null);
        for (const id of ids) { const at = st.atoms.get(id); if (at && at.pp) at.pp.x += 3; }
        for (const id of ids) a.ed.render.ctab.markAtom(id, 1);
        a.ed.update(true);
        return true;
      })()`);
      await wait(500);
      const st1 = await mechState();
      check('移动另一分子后箭头仍指向原原子', st1.arrows[0].target.atomB === targetUuid,
            targetUuid + ' -> ' + st1.arrows[0].target.atomB);
      const bad = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-bad="1"]').length`);
      check('没有产生失效引用', bad === 0, String(bad));
      await shot('mech-identical-molecules');
    } catch (e) { FAIL++; FAILED.push('AN03 段异常 ' + e.message); console.log('  AN03 ABORT', e.message); }

    /* ---------------- AN05：整理后引用不变 ---------------- */
    console.log('[AN05] 整理后按身份重新投影');
    try {
      await setMol('[OH-].CBr');
      await showLP(true);
      const info = await atomsInfo();
      const o = info.find(a => a.label === 'O');
      const c = info.find(a => a.label === 'C');
      await setTool('arrow2');
      await dragTo({ x: o.x + 0.42, y: o.y }, { x: c.x, y: c.y });
      const before = await mechState();
      await clearMechSel();          // 只选中箭头时整理会（按设计）提示"请选择分子"
      const r = await js(`window.k3dAPI.cleanLayout()`);
      await wait(700);
      const after = await mechState();
      check('整理成功', r && r.ok === true, JSON.stringify(r));
      check('整理后箭头数量不变', after.arrows.length === before.arrows.length);
      check('整理后端点引用完全一致',
            JSON.stringify(after.arrows[0].source) === JSON.stringify(before.arrows[0].source) &&
            JSON.stringify(after.arrows[0].target) === JSON.stringify(before.arrows[0].target));
      const bad = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-bad="1"]').length`);
      check('整理后没有失效引用', bad === 0, String(bad));
    } catch (e) { FAIL++; FAILED.push('AN05 段异常 ' + e.message); console.log('  AN05 ABORT', e.message); }

    /* ---------------- AN07：运行时 ID 复用不串绑 ---------------- */
    console.log('[AN07] 删除后新建原子不复用旧绑定');
    try {
      await setMol('[OH-].CBr');
      await showLP(true);
      const info = await atomsInfo();
      const o = info.find(a => a.label === 'O');
      const c = info.find(a => a.label === 'C');
      await setTool('arrow2');
      const gp7 = await ghostPoint(o.uuid);
      await dragTo(gp7 || { x: o.x + 0.2, y: o.y }, { x: c.x, y: c.y });
      const st0 = await mechState();
      if (!st0.arrows.length) throw new Error('前置失败：箭头未建立（ghost=' + JSON.stringify(gp7) + '）');
      const targetUuid = st0.arrows[0].target.atomB;
      // 删掉 C，再在同一个位置画一个同样的 C
      await js(`(() => {
        const a = window.MolWorkbench.app.adapter;
        const st = a.struct();
        const cid = a.atomIdOf(${JSON.stringify(c.uuid)});
        a.ed.selection({ atoms: [cid], bonds: [] });
        window.k3dAPI.deleteSel();
        return true;
      })()`);
      await wait(600);
      await js(`(() => {
        const a = window.MolWorkbench.app.adapter;
        const st = a.struct();
        const at = st.atoms.add({ label: 'C', pp: { x: ${c.x}, y: ${c.y}, z: 0 } });
        a.ed.render.ctab.markAtom(at, 1);
        a.ed.update(true);
        return at;
      })()`);
      await wait(500);
      const st1 = await mechState();
      check('箭头没有绑定到新建的原子', st1.arrows[0].target.atomB === targetUuid,
            'still ' + st1.arrows[0].target.atomB + ' vs ' + targetUuid);
      const bad = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow[data-bad="1"]').length`);
      check('旧箭头被标为待重绑', bad >= 1, String(bad));
    } catch (e) { FAIL++; FAILED.push('AN07 段异常 ' + e.message); console.log('  AN07 ABORT', e.message); }

    /* ---------------- HI03：框选删除 ---------------- */
    console.log('[HI03] 框选多选与一次撤销');
    try {
      await setMol('CCO');
      await showLP(true);
      const info = await atomsInfo();
      const o = info.find(a => a.label === 'O');
      const cs = info.filter(a => a.label === 'C');
      await setTool('arrow2');
      const gp8 = await ghostPoint(o.uuid);
      await dragTo(gp8 || { x: o.x + 0.2, y: o.y }, { x: cs[1].x, y: cs[1].y });
      await dragTo({ x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 }, { x: o.x, y: o.y });
      const st0 = await mechState();
      check('两根箭头已建立', st0.arrows.length === 2, JSON.stringify(st0.arrows.length));
      // Shift 框选覆盖全部
      await setTool('select');
      const box = { x: Math.min(...info.map(a => a.x)) - 1.2, y: Math.min(...info.map(a => a.y)) - 1.2 };
      const box2 = { x: Math.max(...info.map(a => a.x)) + 1.2, y: Math.max(...info.map(a => a.y)) + 1.2 };
      await dragTo(box, box2, { shiftKey: true });
      const selCount = await js(`window.k3dAPI.mechanismSelectionCount()`);
      check('框选选中了机理对象', selCount >= 2, String(selCount));
      const h0 = await histSize();
      await js(`(() => {
        const d = document.getElementById('k').contentDocument;
        d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', keyCode: 46, bubbles: true, cancelable: true }));
        return true;
      })()`);
      await wait(300);
      const c1 = await counts();
      check('删除一次清掉所选', c1.arrows === 0, JSON.stringify(c1));
      const h1 = await histSize();
      check('删除只产生一条历史', h1.undo === h0.undo + 1, h0.undo + ' -> ' + h1.undo);
      await js(`window.k3dAPI.undo()`);
      await wait(400);
      const c2 = await counts();
      check('一次撤销全部恢复', c2.arrows === 2, JSON.stringify(c2));
    } catch (e) { FAIL++; FAILED.push('HI03 段异常 ' + e.message); console.log('  HI03 ABORT', e.message); }

    /* ---------------- CP01/CP02：复制粘贴 ---------------- */
    console.log('[CP01/CP02] 复制粘贴与端点重绑');
    try {
      await setMol('CCO');
      await showLP(true);
      const info = await atomsInfo();
      const o = info.find(a => a.label === 'O');
      const cs = info.filter(a => a.label === 'C');
      await setTool('arrow2');
      const gp9 = await ghostPoint(o.uuid);
      await dragTo(gp9 || { x: o.x + 0.2, y: o.y }, { x: cs[1].x, y: cs[1].y });
      const st0 = await mechState();
      const ar0 = st0.arrows[0];
      // 只选机理对象（Ketcher 无选区）→ 复制 → 粘贴：应得到待重绑副本
      await js(`(() => {
        const c = window.MolWorkbench.app.controller;
        c.selection.clear(); c.selection.add(${JSON.stringify(ar0.id)});
        c.emitSelection(); c.copySelection();
        return true;
      })()`);
      await js(`(async () => { await window.MolWorkbench.app.controller.pasteClipboard(); return true; })()`);
      await wait(500);
      const st1 = await mechState();
      check('粘贴得到第二根箭头', st1.arrows.length === 2, JSON.stringify(st1.arrows.length));
      const pasted = st1.arrows[1];
      check('单根箭头粘贴后端点未绑定（不偷连源图）',
            pasted.target.type === 'free' || pasted.target.type === 'atom' ? pasted.target.type === 'free' : true,
            JSON.stringify(pasted.target));
      check('粘贴保留了电子数与曲率',
            pasted.electronCount === ar0.electronCount && pasted.geometry.bend === ar0.geometry.bend);
      // 原生分子选区优先：机理扩展不打包分子，不拦 Ketcher 自己的复制。
      const nativeDelegated = await js(`(() => {
        const app = window.MolWorkbench.app, c = app.controller, a = app.adapter;
        a.ed.selection({ atoms: Array.from(a.struct().atoms.keys()), bonds: [] });
        const payload = c.buildCopyPayload();
        let blocked = false;
        c.onKeyDown({ key: 'c', metaKey: true, target: a.doc.body,
          preventDefault() { blocked = true; }, stopPropagation() { blocked = true; } });
        return payload === null && !blocked;
      })()`);
      check('分子复制交回原生事件，不经过机理副本映射', nativeDelegated === true);
      await shot('mech-copy-paste');
    } catch (e) { FAIL++; FAILED.push('CP01 段异常 ' + e.message); console.log('  CP01 ABORT', e.message); }

    /* ---------------- RG02：只选机理对象时整理/3D 的提示 ---------------- */
    console.log('[RG02] 只选机理对象时的整理与 3D');
    try {
      await js(`(() => {
        const app = window.MolWorkbench.app;
        const ar = app.model.state.arrows[0];
        if (!ar) return false;
        app.controller.selection.clear(); app.controller.selection.add(ar.id); app.controller.emitSelection();
        app.adapter.clearSelection();
        return true;
      })()`);
      const r = await js(`window.k3dAPI.cleanLayout()`);
      check('只选机理对象时整理给出明确提示', r && r.ok === false && r.code === 'no_molecule', JSON.stringify(r));
      const t = await js(`window.k3dAPI.stereoTargets()`);
      check('只选机理对象时 3D 目标给出明确提示', t && t.ok === false && t.code === 'no_molecule', JSON.stringify(t));
    } catch (e) { FAIL++; FAILED.push('RG02 段异常 ' + e.message); }

    /* ---------------- EX03：空画布导出 ---------------- */
    console.log('[EX03] 空画布导出');
    try {
      await setMol('');
      const r = await js(`window.k3dAPI.exportMechanismImage('svg')`);
      check('空画布导出被明确拒绝', r && r.ok === false && !!r.error, JSON.stringify(r));
    } catch (e) { FAIL++; FAILED.push('EX03 段异常 ' + e.message); }

    /* ---------------- PF01：规模与性能 ---------------- */
    console.log('[PF01] 200 原子 / 30 孤对 / 20 箭头');
    try {
      const big = Array.from({ length: 200 }, (_, i) => 'C').join('');
      const t0 = Date.now();
      await setMol(big);
      const loadMs = Date.now() - t0;
      // 程序化铺 30 个孤对 + 20 根箭头（走同一条提交路径）
      const built = await js(`(() => {
        const app = window.MolWorkbench.app;
        const M = window.MolWorkbench.model;
        const a = app.adapter;
        const ids = a.atomIds();
        const before = app.model.cloneState();
        let n = 0;
        for (let i = 0; i < 30 && i * 6 < ids.length; i++) {
          const uuid = a.uuidOfAtom(ids[i * 6]);
          if (!uuid) continue;
          app.model.addLonePair(M.makeLonePair(uuid, { origin: 'manual', angle: i * 37 }));
          n++;
        }
        for (let i = 0; i < 20 && (i * 9 + 2) < ids.length; i++) {
          const u1 = a.uuidOfAtom(ids[i * 9]);
          const u2 = a.uuidOfAtom(ids[i * 9 + 2]);
          if (!u1 || !u2) continue;
          app.model.addArrow(M.makeArrow({ type: 'free', x: i, y: 0 }, { type: 'formingBond', atomA: u1, atomB: u2 }, { bend: 0.2 }));
        }
        const after = app.model.cloneState();
        app.model.setState(before, 'silent');
        app.controller.commitStatePair(before, after, '规模夹具');
        return JSON.stringify(app.model.counts());
      })()`).then(JSON.parse);
      check('规模夹具已建立', built.lonePairs >= 25 && built.arrows >= 18, JSON.stringify(built));
      const perf = await js(`(() => {
        const app = window.MolWorkbench.app;
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) app.controller.render();
        const renderMs = (performance.now() - t0) / 10;
        const t1 = performance.now();
        const a = app.adapter;
        for (const z of [1.5, 2, 1, 0.8, 1]) { a.ed.zoom(z); }
        const zoomMs = performance.now() - t1;
        return JSON.stringify({ renderMs, zoomMs });
      })()`).then(JSON.parse);
      console.log('    单次渲染 ' + perf.renderMs.toFixed(1) + 'ms，5 次缩放 ' + perf.zoomMs.toFixed(1) + 'ms，载入 ' + loadMs + 'ms');
      check('单次机理层渲染 < 120ms', perf.renderMs < 120, perf.renderMs.toFixed(1) + 'ms');
      check('5 次缩放 < 1500ms', perf.zoomMs < 1500, perf.zoomMs.toFixed(1) + 'ms');
      const drawn = await js(`document.getElementById('k').contentDocument.querySelectorAll('.mech-arrow').length`);
      check('规模夹具的箭头都画出来了', drawn >= 18, String(drawn));
      await shot('mech-scale-200');
    } catch (e) { FAIL++; FAILED.push('PF01 段异常 ' + e.message); console.log('  PF01 ABORT', e.message); }

    /* ---------------- AR09：文本框输入不被劫持 ---------------- */
    console.log('[AR09] 输入框不被全局快捷键劫持');
    try {
      await setMol('CCO');
      const r = await js(`(() => {
        const d = document.getElementById('k').contentDocument;
        const inp = d.createElement('input');
        inp.type = 'text';
        inp.id = 'mech-test-input';
        inp.style.cssText = 'position:fixed;left:10px;top:10px;z-index:9999;width:120px';
        d.body.appendChild(inp);
        inp.focus();
        const c = window.MolWorkbench.app.controller;
        const before = c.selection.size;
        const ev = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', keyCode: 46, bubbles: true, cancelable: true });
        inp.dispatchEvent(ev);
        const prevented = ev.defaultPrevented;
        inp.remove();
        return JSON.stringify({ prevented, before, after: c.selection.size });
      })()`).then(JSON.parse);
      check('输入框里的 Delete 不被机理层拦截', r.prevented === false, JSON.stringify(r));
    } catch (e) { FAIL++; FAILED.push('AR09 段异常 ' + e.message); }

    console.log('');
    console.log('PAGE ERRORS:', pageErrors.length ? JSON.stringify(pageErrors.slice(0, 6), null, 1) : 'none');
    console.log(`结果：${PASS} PASS / ${FAIL} FAIL`);
    if (FAILED.length) { console.log('失败项：'); FAILED.forEach(f => console.log('  -', f)); }
    fs.writeFileSync(path.join(OUT, 'result-workbench-extra.json'), JSON.stringify({ PASS, FAIL, FAILED, pageErrors }, null, 1));
    app.quit();
    process.exit(FAIL ? 1 : 0);
  } catch (e) {
    console.log('TEST ABORTED:', e && e.stack ? e.stack : e);
    app.quit();
    process.exit(3);
  }
});
