/* A02/A03/A11：缩放/平移/旋转/导出不改保存的几何（routeVersion 元数据不因视口重写）
   用法：cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
         ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/test_route_scale.js */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'artifacts');
const PORT = process.env.MOLSTUDIO_PORT || '8879';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 300000);
const wait = ms => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; FAILED.push(name + (detail ? '  ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({ show: true, width: 1180, height: 820 });
    win.webContents.on('console-message', (e, level, message, line, source) => {
      if (level >= 2 && !/Insecure Content-Security-Policy/.test(String(message))) {
        console.log('RENDERER-ERR', String(message).slice(0, 300), '@', String(source).split('/').pop() + ':' + line);
      }
    });
    await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
    await wait(4500);
    const js = async (code) => await win.webContents.executeJavaScript(code);
    const ready = await js(`(async () => { for (let i = 0; i < 60; i++) { if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true; await new Promise(r => setTimeout(r, 250)); } return false; })()`);
    check('workbench ready', ready);

    // 乙醛 + 一根 π→O 箭头（自动排布）
    await js(`window.k3dAPI.setMolecule('CC=O')`);
    await wait(1000);
    const injected = await js(`(() => {
      const MW = window.MolWorkbench, app = MW.app;
      const st = app.adapter.struct();
      let db = null;
      for (const [id, b] of st.bonds) if ((b.type | 0) === 2) { db = { id, b }; break; }
      const bondId = app.adapter.uuidOfBond(db.id);
      const atomId = app.adapter.uuidOfAtom(db.b.end);
      const ar = MW.model.makeArrow({ type: 'bond', bondId, component: 'pi' }, { type: 'atom', atomId }, { electronCount: 2, bend: 0 });
      app.model.addArrow(ar);
      app.controller.replanArrowInPlace(ar, true);
      app.controller.render();
      return JSON.stringify({ bend: ar.geometry.bend, mode: ar.geometry.mode, rv: ar.geometry.routeVersion });
    })()`);
    console.log('injected', injected);
    const base = JSON.parse(injected);
    check('初始为 auto', base.mode === 'auto' && base.rv === 4);

    const snap = () => js(`(() => {
      const MW = window.MolWorkbench;
      const app = MW.app;
      const ar = app.model.state.arrows[0];
      return JSON.stringify({ bend: ar.geometry.bend, mode: ar.geometry.mode, rv: ar.geometry.routeVersion,
        dirty: null,
        anchor: (() => { const g = MW.model.arrowGeometry(ar, app.adapter.context(app.model)); return { s: g.start, e: g.end }; })() });
    })()`).then(JSON.parse);

    /* A02：只 zoom —— geometry/mode 不变 */
    const b0 = await snap();
    await js(`document.getElementById('k').contentWindow.ketcher.editor.zoom(2)`);
    await wait(700);
    const b2 = await snap();
    check('A02 zoom2 bend 不变', b2.bend === b0.bend, b0.bend + ' -> ' + b2.bend);
    check('A02 zoom2 mode 不变', b2.mode === 'auto');
    await js(`document.getElementById('k').contentWindow.ketcher.editor.zoom(0.5)`);
    await wait(700);
    const b05 = await snap();
    check('A02 zoom0.5 bend 不变', b05.bend === b0.bend);
    // zoom 不写回模型：bend/mode/routeVersion 均为保存值（dirty 语义由存储层在保存时判定）
    // 锚点跟随缩放：用户坐标同比放大，模型坐标不变（结构坐标不变才是关键）
    check('A02 结构坐标不变', JSON.stringify(b2.anchor.s) === JSON.stringify(b0.anchor.s) || (Math.abs(b2.anchor.s.x - b0.anchor.s.x) < 1e-9 && Math.abs(b2.anchor.s.y - b0.anchor.s.y) < 1e-9));
    await js(`document.getElementById('k').contentWindow.ketcher.editor.zoom(1)`);
    await wait(500);

    /* A02b：pan（移动原子 = 结构移动）后端点跟随、bend 不变（第一版不重排） */
    await js(`(() => {
      const app = window.MolWorkbench.app;
      const st = app.adapter.struct();
      let moved = false;
      for (const [, a] of st.atoms) { if (a.label === 'C' && !moved) { a.pp.x += 1.0; a.pp.y += 0.5; moved = true; } }
      app.adapter.ed.render.update();
      return moved;
    })()`);
    await wait(700);
    const bpan = await snap();
    check('A02b 移动原子后 bend 不被自动改写', bpan.bend === b0.bend, b0.bend + ' -> ' + bpan.bend);

    /* A11：整体旋转 —— bend/侧向保持（以结构为基准等价） */
    // 直接把所有原子绕分子中心旋转 90°（结构坐标 y 向下，绕 z 轴）
    await js(`(() => {
      const app = window.MolWorkbench.app;
      const st = app.adapter.struct();
      let cx = 0, cy = 0, n = 0;
      for (const [, a] of st.atoms) { if (a.pp) { cx += a.pp.x; cy += a.pp.y; n++; } }
      cx /= n; cy /= n;
      const cos = Math.cos(Math.PI / 2), sin = Math.sin(Math.PI / 2);
      for (const [, a] of st.atoms) {
        if (!a.pp) continue;
        const dx = a.pp.x - cx, dy = a.pp.y - cy;
        a.pp.x = cx + dx * cos - dy * sin;
        a.pp.y = cy + dx * sin + dy * cos;
      }
      app.adapter.ed.render.update();
      return true;
    })()`);
    await wait(700);
    const brot = await snap();
    check('A11 旋转90° bend 不被静默改写', brot.bend === b0.bend, b0.bend + ' -> ' + brot.bend);
    check('A11 旋转后端点仍解析', brot.anchor.s && isFinite(brot.anchor.s.x) && brot.anchor.e && isFinite(brot.anchor.e.x));

    /* 手调 → manual 保留；缩放/旋转后仍 manual */
    await js(`(() => {
      const app = window.MolWorkbench.app;
      app.controller.selection.add(app.model.state.arrows[0].id);
      app.controller.setBendForSelection(-0.42);
      app.controller.render();
      return true;
    })()`);
    await wait(300);
    const bm = await snap();
    check('手调后 mode=manual', bm.mode === 'manual' && Math.abs(bm.bend + 0.42) < 1e-9, JSON.stringify(bm));
    await js(`document.getElementById('k').contentWindow.ketcher.editor.zoom(2)`);
    await wait(600);
    const bm2 = await snap();
    check('manual 在 zoom 后保留', bm2.mode === 'manual' && bm2.bend === bm.bend);

    /* A03：不同 zoom 下导出一致 */
    const exp1 = await js(`window.k3dAPI.exportMechanismImage('svg')`);
    await js(`document.getElementById('k').contentWindow.ketcher.editor.zoom(1)`);
    await wait(700);
    const exp2 = await js(`window.k3dAPI.exportMechanismImage('svg')`);
    if (exp1 && exp1.ok && exp2 && exp2.ok) {
      const norm = (s) => String(s.svg || s).replace(/width="[^"]*"|height="[^"]*"/g, '');
      check('A03 不同 zoom 导出 SVG 一致', norm(exp1) === norm(exp2),
        'len ' + norm(exp1).length + ' vs ' + norm(exp2).length);
    } else check('A03 导出成功', false, JSON.stringify(exp1).slice(0, 80));

    fs.writeFileSync(path.join(OUT, 'result-route-scale.json'), JSON.stringify({ PASS, FAIL, FAILED }, null, 1));
    console.log('结果：' + PASS + ' PASS / ' + FAIL + ' FAIL');
    if (FAILED.length) console.log('失败项：\n  - ' + FAILED.join('\n  - '));
  } catch (e) { console.log('ABORT', e.message); FAIL++; }
  app.quit(); process.exit(FAIL ? 1 : 0);
});
