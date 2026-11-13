/* 机理层证据截图（真实窗口 + 真实指针事件）
   用法：
     .venv-rdkit/bin/python fusion/server.py 8879
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/shots_workbench.js
   输出：tests/artifacts/mech-shot-*.png */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'artifacts');
const PORT = process.env.MOLSTUDIO_PORT || '8879';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 300000);
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1180, height: 820 });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(5000);
  win.focus();
  const js = c => win.webContents.executeJavaScript(c);
  await js(`(async () => { for (let i = 0; i < 60; i++) { if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true; await new Promise(r => setTimeout(r, 250)); } return false; })()`);

  const shot = async (name) => {
    win.focus();
    await wait(650);
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('shot', name);
  };
  const clientOf = (m) => js(`(() => {
    const a = window.MolWorkbench.app.adapter;
    const u = a.modelToUser({ x: ${m.x}, y: ${m.y} });
    const mm = a.canvasSvg().getScreenCTM();
    return { x: mm.a * u.x + mm.c * u.y + mm.e, y: mm.b * u.x + mm.d * u.y + mm.f };
  })()`);
  const fire = (type, pt, extra) => js(`(() => {
    const d = document.getElementById('k').contentDocument;
    const w = document.getElementById('k').contentWindow;
    const el = d.elementFromPoint(${pt.x}, ${pt.y}) || d.querySelector('#root') || d.body;
    el.dispatchEvent(new w.PointerEvent('${type}', Object.assign({
      clientX: ${pt.x}, clientY: ${pt.y}, bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ${type === 'pointerup' ? 0 : 1}
    }, ${JSON.stringify(extra || {})})));
    return true;
  })()`);
  const atoms = () => js(`(() => {
    const a = window.MolWorkbench.app.adapter; a.syncIdentity();
    const st = a.struct();
    return JSON.stringify(Array.from(st.atoms.entries()).map(([id, at]) => ({ id, label: at.label, x: at.pp.x, y: at.pp.y, uuid: a.uuidOfAtom(id) })));
  })()`).then(JSON.parse);
  const ghostOf = (uuid) => js(`(() => {
    const app = window.MolWorkbench.app, M = window.MolWorkbench.model;
    const g = app.controller.ghostSlots.find(x => x.ownerAtomId === ${JSON.stringify(uuid)});
    return g ? JSON.stringify(M.lonePairPosition(g, app.controller.ctx())) : null;
  })()`).then(v => v && JSON.parse(v));

  /* 1) 显示自动孤对 + 悬停高亮 */
  await js(`window.k3dAPI.setMolecule('[OH-].CBr')`);
  await wait(1200);
  await js(`(() => { const c = window.MolWorkbench.app.controller; c.setShowAutoLonePairs(true); c.setTool('arrow2'); return true; })()`);
  await wait(400);
  let at = await atoms();
  let o = at.find(a => a.label === 'O');
  const cAtom = at.find(a => a.label === 'C');
  const br = at.find(a => a.label === 'Br');
  const g = await ghostOf(o.uuid);
  let pt = await clientOf(g);
  await fire('pointermove', pt);
  await wait(300);
  await shot('mech-shot-source-hover');

  /* 2) 草稿：来源已确定、拖到 C 上的待成键预览 */
  await fire('pointerdown', pt);
  const pc = await clientOf({ x: cAtom.x, y: cAtom.y });
  await fire('pointermove', pc);
  await wait(400);
  await shot('mech-shot-formingbond-preview');
  await fire('pointerup', pc);
  await wait(400);

  /* 3) 第二根箭头（C—Br σ → Br），完成后选中显示手柄 */
  const mid = { x: (cAtom.x + br.x) / 2, y: (cAtom.y + br.y) / 2 };
  const pm = await clientOf(mid);
  const pb = await clientOf({ x: br.x, y: br.y });
  await fire('pointerdown', pm);
  await fire('pointermove', pb);
  await fire('pointerup', pb);
  await wait(500);
  await js(`(() => {
    const app = window.MolWorkbench.app;
    const ar = app.model.state.arrows[0];
    app.controller.setTool('select');
    app.controller.selection.clear(); app.controller.selection.add(ar.id);
    app.controller.emitSelection(); app.controller.render();
    return true;
  })()`);
  await wait(400);
  await shot('mech-shot-handles');

  /* 4) 失效引用：删掉 O */
  await js(`(() => {
    const app = window.MolWorkbench.app, a = app.adapter;
    app.controller.selection.clear(); app.controller.emitSelection();
    const oid = a.atomIdOf(${JSON.stringify(o.uuid)});
    a.ed.selection({ atoms: [oid], bonds: [] });
    window.k3dAPI.deleteSel();
    return true;
  })()`);
  await wait(800);
  await shot('mech-shot-stale');
  await js(`window.k3dAPI.undo()`);
  await wait(700);

  /* 5) 整理前后 */
  await shot('mech-shot-before-layout');
  await js(`(() => { const app = window.MolWorkbench.app; app.controller.selection.clear(); app.controller.emitSelection(); app.adapter.clearSelection(); return true; })()`);
  await js(`window.k3dAPI.cleanLayout()`);
  await wait(1200);
  await shot('mech-shot-after-layout');

  /* 6) 导出成品（SVG/PNG） */
  const svgRes = await js(`window.k3dAPI.exportMechanismImage('svg')`);
  if (svgRes && svgRes.ok) {
    fs.writeFileSync(path.join(OUT, 'mech-shot-export.svg'), Buffer.from(svgRes.dataUrl.split(',')[1], 'base64').toString('utf8'));
    console.log('export svg ok');
  }
  const pngRes = await js(`window.k3dAPI.exportMechanismImage('png')`);
  if (pngRes && pngRes.ok) {
    fs.writeFileSync(path.join(OUT, 'mech-shot-export.png'), Buffer.from(pngRes.dataUrl.split(',')[1], 'base64'));
    console.log('export png ok');
  }

  app.quit();
  process.exit(0);
});
