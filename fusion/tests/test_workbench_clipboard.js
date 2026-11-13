/* 机理层剪贴板集成测试（真实 canvas.html + 真实 Ketcher + 真实按键事件）
   覆盖：弯箭头、鱼钩、自由端点、文本输入框、复制箭头后再复制别的内容。

   用法：
     .venv-rdkit/bin/python fusion/server.py 8879        # 终端一
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8879 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/test_workbench_clipboard.js

   说明：
     - ⌘C / ⌘X 用 webContents.sendInputEvent 真发按键，走 DOM keydown（浏览器里的真实路径）。
     - ⌘V 在 Chromium 里由浏览器进程的编辑命令派发 paste 事件，Electron 的 sendInputEvent
       不经过那条通道（实测不产生 paste），所以这里用同构的 ClipboardEvent + 真实系统剪贴板
       内容来驱动粘贴入口；原生 App 里的 ⌘V 由 WKWebView 自检覆盖。
*/
const { app, BrowserWindow, clipboard, session } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'artifacts');
const PORT = process.env.MOLSTUDIO_PORT || '8879';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 600000);

let PASS = 0, FAIL = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('  PASS', name); }
  else { FAIL++; FAILED.push(name + (detail ? '  ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  const win = new BrowserWindow({ show: true, width: 1180, height: 820 });
  const consoleErrors = [];
  win.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2 && !/Insecure Content-Security-Policy/.test(message)) {
      consoleErrors.push(String(message).slice(0, 300) + ' @' + source + ':' + line);
    }
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(4500);
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
  win.webContents.focus();
  await wait(600);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (e) {
      console.log('  JS FAILED:', String(e).slice(0, 300));
      console.log('  JS CODE:', String(code).slice(0, 400).replace(/\n/g, ' '));
      throw e;
    }
  };

  // 原生宿主桩：机理层把载荷 postMessage 给宿主，宿主写系统剪贴板（与 Swift 侧一致）
  await js(`(() => {
    window.__hostMsgs = [];
    window.webkit = { messageHandlers: { k3d: { postMessage: (m) => { window.__hostMsgs.push(m); } } } };
    return true;
  })()`);

  const ready = await js(`(async () => {
    for (let i = 0; i < 60; i++) {
      if (window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady()) return true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  })()`);
  check('工作台就绪', ready === true);

  const setMol = async (smi) => {
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(smi)})`);
    await wait(1200);
  };
  const mechState = () => js(`JSON.stringify(window.MolWorkbench.app.model.cloneState())`);
  // 这个 Electron 版本的 clipboard 读写返回 Promise（实测），统一 await
  const readClip = async () => { try { return String(await clipboard.readText()); } catch (e) { return ''; } };
  const writeClip = async (t) => { try { await clipboard.writeText(t); } catch (e) { /* 忽略 */ } };
  const histSize = () => js(`(() => {
    const ed = window.MolWorkbench.app.adapter.ed;
    const h = ed && ed.history;
    if (!h || !h.historyStack) return 'no-history';
    return JSON.stringify({ n: h.historyStack.length, ptr: h.historyPointer });
  })()`);

  /* 剪贴板 API 要求文档处于聚焦状态（浏览器语义）。
     iframe 的 document.hasFocus() 在顶层聚焦时就是 true，不能用来判断「焦点在这一帧」，
     所以这里直接把焦点放到 Ketcher 的 cliparea 上并核对 activeElement。 */
  const ensureCanvasFocus = async () => {
    for (let i = 0; i < 20; i++) {
      const st = await js(`(() => {
        const frame = document.getElementById('k');
        const d = frame.contentDocument;
        const ca = d.querySelector('[data-cliparea="true"]');
        if (!ca) return JSON.stringify({ ok: false, why: 'no-cliparea' });
        if (document.activeElement !== frame) frame.focus();
        ca.focus();
        return JSON.stringify({ ok: d.activeElement === ca, top: document.activeElement.tagName });
      })()`);
      if (JSON.parse(st).ok) return true;
      win.focus(); win.webContents.focus();
      await wait(150);
    }
    return false;
  };
  check('画布拿到焦点（剪贴板 API 前提）', await ensureCanvasFocus());

  /* 宿主收件箱：把机理层 postMessage 出来的 clipboardWrite 落到真实系统剪贴板 */
  const hostPump = async () => {
    const msgs = await js(`(() => { const m = window.__hostMsgs || []; window.__hostMsgs = []; return JSON.stringify(m); })()`);
    const list = JSON.parse(msgs || '[]');
    for (const m of list) if (m && m.act === 'clipboardWrite' && typeof m.text === 'string') {
      await writeClip(m.text);
      if (m.requestId) await js(`window.k3dAPI.mechClipboardWriteResult(${JSON.stringify(m.requestId)}, true)`);
    }
    return list;
  };

  /* 真实按键：⌘C / ⌘X（macOS）。同时发 keyDown + keyUp。 */
  const pressKey = async (ch, skipFocus) => {
    if (!skipFocus) await ensureCanvasFocus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: ['meta'] });
    await wait(400);
    return hostPump();
  };

  /* 模拟浏览器派发的 paste 事件（带真实系统剪贴板内容） */
  const firePaste = async (target) => {
    const text = await readClip();
    await js(`(() => {
      const d = document.getElementById('k').contentDocument;
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(text)});
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      const t = ${JSON.stringify(target)} === 'top' ? document.body : d.querySelector('[data-cliparea="true"]');
      t.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    await wait(700);
  };

  const clearSel = () => js(`(() => {
    const app = window.MolWorkbench.app;
    app.controller.selection.clear(); app.controller.emitSelection();
    app.adapter.clearSelection();
    return true;
  })()`);

  const selectArrow = (id) => js(`(() => {
    const app = window.MolWorkbench.app;
    app.controller.selection.clear(); app.controller.selection.add(${JSON.stringify(id)});
    app.controller.emitSelection();
    return true;
  })()`);

  /* ---------------- 准备场景：孤对弯箭头 + 鱼钩 + 自由端点箭头 ---------------- */
  await setMol('CC(=O)C');
  await js(`(() => { const c = window.MolWorkbench.app.controller; c.setShowAutoLonePairs(true); c.refreshAutoSlots(); return true; })()`);
  await wait(400);

  const setup = await js(`(() => {
    const MW = window.MolWorkbench, app = MW.app, a = app.adapter, M = MW.model;
    a.syncIdentity();
    const st = a.struct();
    let O = null, C = null, Br = null;
    const deg = new Map();
    for (const [, b] of st.bonds) { deg.set(b.begin, (deg.get(b.begin)||0)+1); deg.set(b.end, (deg.get(b.end)||0)+1); }
    for (const [id, at] of st.atoms) {
      if (at.label === 'O') O = { id, pp: at.pp };
      if (at.label === 'C' && (deg.get(id)||0) >= 2) C = { id, pp: at.pp };
    }
    if (!O || !C) return JSON.stringify({ ok: false, reason: 'atoms' });

    const Ouuid = a.uuidOfAtom(O.id), Cuuid = a.uuidOfAtom(C.id);
    // 1) 孤对 → 碳：弯箭头（bend ≠ 0）
    const lp = M.makeLonePair(Ouuid, { origin: 'manual', angle: 0 });
    app.model.addLonePair(lp);
    const bent = M.makeArrow({ type: 'lonePair', ownerAtomId: Ouuid, slotId: lp.id },
                             { type: 'atom', atomId: Cuuid },
                             { electronCount: 2, bend: -0.26, mode: 'manual', routeVersion: 0 });
    app.model.addArrow(bent);

    // 2) 键 → 原子：鱼钩（单电子）
    let bondId = null;
    for (const [id, b] of st.bonds) {
      const la = st.atoms.get(b.begin), lb = st.atoms.get(b.end);
      if (la && lb && (la.label === 'C' || lb.label === 'C')) { bondId = id; break; }
    }
    const bondUuid = bondId === null ? null : a.uuidOfBond(bondId);
    const fish = M.makeArrow({ type: 'bond', bondId: bondUuid, component: 'sigma' },
                             { type: 'atom', atomId: Cuuid },
                             { electronCount: 1, bend: 0.2, mode: 'manual', routeVersion: 0 });
    app.model.addArrow(fish);

    // 3) 两端自由：普通弯箭头
    const free = M.makeArrow({ type: 'free', x: 1.5, y: 2.5 }, { type: 'free', x: 3.5, y: 3.0 },
                             { electronCount: 2, bend: 0.15, mode: 'manual', routeVersion: 0 });
    app.model.addArrow(free);

    app.controller.render();
    const ctx = app.controller.ctx();
    const geo = (ar) => { const g = M.arrowGeometry(ar, ctx); return { start: g.start, end: g.end, bend: g.bend }; };
    return JSON.stringify({
      ok: true,
      ids: { bent: bent.id, fish: fish.id, free: free.id },
      geo: { bent: geo(bent), fish: geo(fish), free: geo(free) },
      counts: app.model.counts()
    });
  })()`);
  const S = JSON.parse(setup);
  check('场景建立：3 根箭头', S.ok === true && S.counts.arrows === 3, setup);

  /* ---------------- CP01：⌘C 真实按键把机理载荷写进系统剪贴板 ---------------- */
  await selectArrow(S.ids.bent);
  const beforeCopy = await mechState();
  const histBeforeCopy = await histSize();
  await writeClip('PRE-COPY-TEXT');
  const cp01msgs = await pressKey('c');
  const clipAfterCopy = await readClip();
  let payload = null;
  try { payload = JSON.parse(clipAfterCopy); } catch (e) { payload = null; }
  check('CP01 ⌘C 把载荷交给宿主', cp01msgs.some(m => m && m.act === 'clipboardWrite'), JSON.stringify(cp01msgs).slice(0, 120));
  check('CP01 宿主写入后系统剪贴板是机理载荷', !!payload && payload.kind === 'molstudio-mechanism', String(clipAfterCopy).slice(0, 80));
  check('CP01 载荷里带上了端点的实际位置',
    !!(payload && payload.arrows && payload.arrows[0].source.last && payload.arrows[0].target.last),
    payload ? JSON.stringify(payload.arrows && payload.arrows[0]) : '');
  const afterCopy = await mechState();
  check('CP01 复制本身不修改文档', beforeCopy === afterCopy);
  const histAfterCopy = await histSize();
  check('CP01 复制不产生历史', histBeforeCopy === histAfterCopy, histBeforeCopy + ' -> ' + histAfterCopy);

  /* ---------------- CP02：⌘V（paste 事件）粘贴弯箭头 ---------------- */
  await firePaste('iframe');
  const st2 = JSON.parse(await mechState());
  check('CP02 粘贴后多一根箭头', st2.arrows.length === 4, String(st2.arrows.length));
  const pasted = st2.arrows[st2.arrows.length - 1];
  const orig = JSON.parse(beforeCopy).arrows.find(a => a.id === S.ids.bent);
  const geoOrig = S.geo.bent;
  check('CP02 副本两端都是自由端点（不偷绑原分子）',
    pasted.source.type === 'free' && pasted.target.type === 'free', JSON.stringify([pasted.source, pasted.target]));
  const dx1 = pasted.source.x - geoOrig.start.x, dy1 = pasted.source.y - geoOrig.start.y;
  const dx2 = pasted.target.x - geoOrig.end.x, dy2 = pasted.target.y - geoOrig.end.y;
  check('CP02 两端偏移量一致（形状与方向不变）',
    Math.abs(dx1 - dx2) < 1e-6 && Math.abs(dy1 - dy2) < 1e-6 && Math.hypot(dx1, dy1) > 0.5,
    JSON.stringify({ dx1, dy1, dx2, dy2 }));
  check('CP02 保留电子数与曲率',
    pasted.electronCount === orig.electronCount && pasted.geometry.bend === orig.geometry.bend,
    JSON.stringify([pasted.electronCount, pasted.geometry.bend, orig.electronCount, orig.geometry.bend]));
  check('CP02 两端不重合（不会“消失”）',
    Math.hypot(pasted.target.x - pasted.source.x, pasted.target.y - pasted.source.y) > 0.5,
    JSON.stringify([pasted.source, pasted.target]));
  const chordP = { x: pasted.target.x - pasted.source.x, y: pasted.target.y - pasted.source.y };
  const chordO = { x: geoOrig.end.x - geoOrig.start.x, y: geoOrig.end.y - geoOrig.start.y };
  check('CP02 方向没反（弦向量与原图同向）',
    Math.abs(chordP.x - chordO.x) < 1e-6 && Math.abs(chordP.y - chordO.y) < 1e-6,
    JSON.stringify({ chordP, chordO }));
  const selCount = await js(`window.MolWorkbench.app.controller.selection.size`);
  const selHasNew = await js(`window.MolWorkbench.app.controller.selection.has(${JSON.stringify(pasted.id)})`);
  check('CP02 只选中新副本', selCount === 1 && selHasNew === true, JSON.stringify({ selCount, selHasNew }));

  /* ---------------- CP03：一次粘贴一条历史 ---------------- */
  const h1 = await histSize();
  await js(`window.k3dAPI.undo()`);
  await wait(500);
  const st3 = JSON.parse(await mechState());
  check('CP03 一次撤销就回到粘贴前', st3.arrows.length === 3, String(st3.arrows.length));
  await js(`window.k3dAPI.redo()`);
  await wait(500);
  const st3b = JSON.parse(await mechState());
  check('CP03 重做恢复副本', st3b.arrows.length === 4, String(st3b.arrows.length));

  /* ---------------- CP04：鱼钩（单电子）复制粘贴 ---------------- */
  await clearSel();
  await selectArrow(S.ids.fish);
  await pressKey('c');
  const fishClip = await readClip();
  check('CP04 ⌘C 复制的确实是鱼钩', fishClip.indexOf('"electronCount":1') >= 0, fishClip.slice(0, 120));
  await firePaste('iframe');
  const st4 = JSON.parse(await mechState());
  const fishPasted = st4.arrows[st4.arrows.length - 1];
  const fishOrig = JSON.parse(await mechState()).arrows.find(a => a.id === S.ids.fish);
  check('CP04 鱼钩粘贴后多一根', st4.arrows.length === 5, String(st4.arrows.length));
  check('CP04 鱼钩保留单电子', fishPasted.electronCount === 1, String(fishPasted.electronCount));
  check('CP04 鱼钩保留曲率', fishPasted.geometry.bend === fishOrig.geometry.bend, JSON.stringify([fishPasted.geometry.bend, fishOrig.geometry.bend]));
  const fishChord = Math.hypot(fishPasted.target.x - fishPasted.source.x, fishPasted.target.y - fishPasted.source.y);
  const fishChord0 = Math.hypot(S.geo.fish.end.x - S.geo.fish.start.x, S.geo.fish.end.y - S.geo.fish.start.y);
  check('CP04 鱼钩两端自由且弦长不变',
    fishPasted.source.type === 'free' && fishPasted.target.type === 'free' &&
    Math.abs(fishChord - fishChord0) < 1e-6 && fishChord > 0.05,
    JSON.stringify({ fishChord, fishChord0 }));

  /* ---------------- CP05：两端自由的箭头（y 也必须偏移） ---------------- */
  await clearSel();
  await selectArrow(S.ids.free);
  await pressKey('c');
  await firePaste('iframe');
  const st5 = JSON.parse(await mechState());
  const freePasted = st5.arrows[st5.arrows.length - 1];
  const freeOrig = S.geo.free;
  check('CP05 自由端点箭头粘贴后多一根', st5.arrows.length === 6, String(st5.arrows.length));
  check('CP05 自由端点 x/y 同时偏移',
    freePasted.source.x - freeOrig.start.x > 1 &&
    Math.abs((freePasted.source.x - freeOrig.start.x) - (freePasted.source.y - freeOrig.start.y)) < 1e-6,
    JSON.stringify([freePasted.source, freeOrig.start]));

  /* ---------------- CP06：重复粘贴逐次错开 ---------------- */
  const beforeRepeat = JSON.parse(await mechState()).arrows.length;
  await firePaste('iframe');
  const st6 = JSON.parse(await mechState());
  const p1 = st6.arrows[beforeRepeat - 1], p2 = st6.arrows[st6.arrows.length - 1];
  check('CP06 再次粘贴得到第二份副本', st6.arrows.length === beforeRepeat + 1, String(st6.arrows.length));
  check('CP06 两份副本不重叠',
    Math.hypot(p2.source.x - p1.source.x, p2.source.y - p1.source.y) > 0.5,
    JSON.stringify([p1.source, p2.source]));

  /* ---------------- CP07：复制箭头后再复制别的内容，不能拿旧缓存顶上 ---------------- */
  const arrowsBefore = JSON.parse(await mechState()).arrows.length;
  await selectArrow(S.ids.bent);
  await pressKey('c');                                   // 先复制箭头
  await writeClip('mol=CC(=O)C');                    // 再“复制分子”（Ketcher 的纯文本载荷）
  await js(`(() => { document.getElementById('k').contentDocument.dispatchEvent(new Event('copy')); return true; })()`);
  await firePaste('iframe');
  const st7 = JSON.parse(await mechState());
  check('CP07 剪贴板换了内容就不粘贴旧箭头', st7.arrows.length === arrowsBefore, arrowsBefore + ' -> ' + st7.arrows.length);

  /* ---------------- CP08：文本输入框里 ⌘C 不抢 ----------------
     真实焦点在无窗口焦点时会失效（Electron 后台窗口），所以：
     能拿到焦点就真按 ⌘C；拿不到就把 keydown 直接派发到输入框上——
     这正是浏览器里按键的目标元素，控制器看到的输入完全一致。 */
  await selectArrow(S.ids.bent);
  await js(`(() => {
    const d = document.getElementById('k').contentDocument;
    const old = d.getElementById('cp-input'); if (old) old.remove();
    const inp = d.createElement('input'); inp.id = 'cp-input'; inp.value = 'TEXT-IN-FIELD';
    inp.style.cssText = 'position:fixed;left:20px;top:20px;width:200px;height:26px;z-index:99999';
    d.body.appendChild(inp);
    return true;
  })()`);
  await wait(150);
  let focusOk = false;
  for (let i = 0; i < 6; i++) {
    const st = await js(`(() => {
      const frame = document.getElementById('k');
      const d = frame.contentDocument;
      const inp = d.getElementById('cp-input');
      if (document.activeElement !== frame) frame.focus();
      inp.focus(); inp.select();
      return d.activeElement === inp;
    })()`);
    if (st === true) { focusOk = true; break; }
    win.focus(); win.webContents.focus();
    await wait(150);
  }
  await writeClip('TEXT-BEFORE');
  let cp08msgs;
  if (focusOk) {
    cp08msgs = await pressKey('c', true);      // 真按键，焦点在输入框上
  } else {
    cp08msgs = [];
    const prevented = await js(`(() => {
      const d = document.getElementById('k').contentDocument;
      const inp = d.getElementById('cp-input');
      const ev = new d.defaultView.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true });
      inp.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    check('CP08 输入框内的 ⌘C 未被机理层吞掉（未 preventDefault）', prevented === false, String(prevented));
    await hostPump();
  }
  let cp08payload = null;
  const cp08text = await readClip();
  try { cp08payload = JSON.parse(cp08text); } catch (e) { cp08payload = null; }
  console.log('  CP08 焦点模式:', focusOk ? 'real-key' : 'synthetic-keydown');
  check('CP08 输入框内 ⌘C 不写机理载荷', !cp08payload || cp08payload.kind !== 'molstudio-mechanism',
    (focusOk ? 'real-key ' : 'synthetic ') + cp08text.slice(0, 60));
  check('CP08 输入框内 ⌘C 不产生宿主写入', cp08msgs.length === 0, JSON.stringify(cp08msgs).slice(0, 80));
  const st8 = JSON.parse(await mechState());
  check('CP08 输入框内 ⌘C 不改动机理文档', st8.arrows.length === arrowsBefore, String(st8.arrows.length));
  await js(`(() => { const d = document.getElementById('k').contentDocument; const i = d.getElementById('cp-input'); if (i) i.remove(); return true; })()`);

  /* ---------------- CP09：剪切 ---------------- */
  await clearSel();
  await js(`(() => {
    const app = window.MolWorkbench.app;
    const ar = app.model.state.arrows[app.model.state.arrows.length - 1];
    app.controller.selection.clear(); app.controller.selection.add(ar.id); app.controller.emitSelection();
    return true;
  })()`);
  const cutBefore = JSON.parse(await mechState()).arrows.length;
  await pressKey('x');
  const cutAfter = JSON.parse(await mechState()).arrows.length;
  check('CP09 ⌘X 删除选中箭头', cutAfter === cutBefore - 1, cutBefore + ' -> ' + cutAfter);
  let cutPayload = null;
  const cutText = await readClip();
  try { cutPayload = JSON.parse(cutText); } catch (e) { cutPayload = null; }
  check('CP09 ⌘X 同时写入剪贴板', !!cutPayload && cutPayload.kind === 'molstudio-mechanism', cutText.slice(0, 60));
  await js(`window.k3dAPI.undo()`);
  await wait(400);
  check('CP09 剪切可撤销', JSON.parse(await mechState()).arrows.length === cutBefore, '');

  /* ---------------- CP10：没有选中机理对象时 ⌘C 不写机理载荷 ---------------- */
  await clearSel();
  await writeClip('PLAIN-TEXT');
  await pressKey('c');
  const cp10text = await readClip();
  check('CP10 未选机理对象时不抢 ⌘C', cp10text === 'PLAIN-TEXT', cp10text.slice(0, 60));

  const realErrors = consoleErrors.filter(m => !/Clipboard|NotAllowedError|Document is not focused/.test(m));
  /* ---------------- CP11/CP12：分子复制粘贴（Ketcher 自己的 ⌘C 在这个外壳里不派发 copy 事件） ---------------- */
  await setMol('CCCC=CCCC');        // 长链：固定 +2 键长的偏移会压在原件上，用宽度算才分得开
  await wait(600);
  const molBefore = await js(`window.MolWorkbench.app.adapter.struct().atoms.size`);
  await ensureCanvasFocus();          // 先聚焦，再选分子（聚焦可能让 Ketcher 重画）
  await js(`(() => {
    const a = window.MolWorkbench.app.adapter;
    const st = a.struct();
    a.ed.selection({ atoms: Array.from(st.atoms.keys()), bonds: [] });
    window.MolWorkbench.app.controller.selection.clear();
    window.MolWorkbench.app.controller.emitSelection();
    return true;
  })()`);
  await wait(200);
  const selNow = await js(`window.MolWorkbench.app.adapter.selection().atoms.length`);
  check('CP11 分子选区就位', selNow === molBefore, selNow + '/' + molBefore);
  const molMsgs = await pressKey('c', true);
  const molPayload = molMsgs.length ? JSON.parse(molMsgs[0].text) : null;
  check('CP11 选中分子后 ⌘C 产出分子载荷',
    !!molPayload && molPayload.molecules && molPayload.molecules.atoms.length === molBefore,
    JSON.stringify({ msgs: molMsgs.length, molAtoms: molPayload && molPayload.molecules ? molPayload.molecules.atoms.length : null }));
  await firePaste('iframe');
  await wait(900);
  const molAfter = await js(`(() => {
    const app = window.MolWorkbench.app, st = app.adapter.struct(), sel = app.adapter.selection();
    return JSON.stringify({ atoms: st.atoms.size, selAtoms: sel.atoms.length });
  })()`);
  const MA = JSON.parse(molAfter);
  check('CP11 分子粘贴后原子数翻倍', MA.atoms === molBefore * 2, molBefore + ' -> ' + MA.atoms);
  check('CP11 粘贴后选中新分子', MA.selAtoms === molBefore, JSON.stringify(MA));
  const molOverlap = await js(`(() => {
    const st = window.MolWorkbench.app.adapter.struct();
    const pts = Array.from(st.atoms.values()).map(x => ({ x: x.pp.x, y: x.pp.y }));
    let n = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 0.05) n++;
    }
    return n;
  })()`);
  check('CP11 粘贴的分子不压在原分子上（无重合原子）', molOverlap === 0, String(molOverlap));
  const ranges = await js(`(() => {
    const st = window.MolWorkbench.app.adapter.struct();
    const xs = Array.from(st.atoms.values()).map(x => x.pp.x).sort((a, b) => a - b);
    const half = xs.length / 2;
    const left = xs.slice(0, half), right = xs.slice(half);
    return JSON.stringify({ leftMax: left[left.length - 1], rightMin: right[0] });
  })()`);
  const RG = JSON.parse(ranges);
  check('CP11 副本整体落在原件右侧（x 区间不交叉）', RG.rightMin > RG.leftMax,
    JSON.stringify(RG));

  /* ---------------- CP13：分子粘贴后跟随光标，点击落位 ---------------- */
  const followState = await js(`(() => {
    const c = window.MolWorkbench.app.controller;
    return JSON.stringify({ follow: !!c.followPaste, ids: c.followPaste ? c.followPaste.atomIds.length : 0 });
  })()`);
  const FS = JSON.parse(followState);
  check('CP13 粘贴后进入跟随状态', FS.follow === true && FS.ids > 0, followState);
  const moved = await js(`(() => {
    const app = window.MolWorkbench.app, a = app.adapter;
    const d = document.getElementById('k').contentDocument, w = document.getElementById('k').contentWindow;
    const st = a.struct();
    const first = st.atoms.get(app.controller.followPaste.atomIds[0]);
    const before = { x: first.pp.x, y: first.pp.y };
    const target = { x: before.x + 3, y: before.y + 1 };
    const u = a.modelToUser(target);
    const mm = a.canvasSvg().getScreenCTM();
    const pt = { x: mm.a * u.x + mm.c * u.y + mm.e, y: mm.b * u.x + mm.d * u.y + mm.f };
    const el = d.elementFromPoint(pt.x, pt.y) || d.body;
    el.dispatchEvent(new w.PointerEvent('pointermove', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
    const after = a.struct().atoms.get(app.controller.followPaste ? app.controller.followPaste.atomIds[0] : -1);
    return JSON.stringify({ before: before, after: after ? { x: after.pp.x, y: after.pp.y } : null });
  })()`);
  const MV = JSON.parse(moved);
  check('CP13 移动鼠标时副本跟着走',
    !!MV.after && Math.hypot(MV.after.x - MV.before.x, MV.after.y - MV.before.y) > 0.5,
    JSON.stringify(MV));
  await js(`(() => {
    const d = document.getElementById('k').contentDocument, w = document.getElementById('k').contentWindow;
    d.body.dispatchEvent(new w.PointerEvent('pointerdown', { clientX: 420, clientY: 320, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
    return true;
  })()`);
  await wait(200);
  const afterClick = await js(`JSON.stringify({ follow: !!window.MolWorkbench.app.controller.followPaste })`);
  check('CP13 点击后落位、退出跟随', JSON.parse(afterClick).follow === false, afterClick);

  /* ---------------- CP12：两根箭头一起复制 ---------------- */
  await setMol('CC(=O)C');
  await wait(800);
  const twoIds = await js(`(() => {
    const MW = window.MolWorkbench, app = MW.app, a = app.adapter, M = MW.model;
    a.syncIdentity();
    const st = a.struct();
    const list = Array.from(st.atoms.entries()).map(([id, at]) => ({ id, label: at.label, uuid: a.uuidOfAtom(id) }));
    const O = list.find(x => x.label === 'O'), C = list.find(x => x.label === 'C');
    const lp = M.makeLonePair(O.uuid, { origin: 'manual', angle: 0 });
    app.model.addLonePair(lp);
    const a1 = M.makeArrow({ type: 'lonePair', ownerAtomId: O.uuid, slotId: lp.id }, { type: 'atom', atomId: C.uuid }, { electronCount: 2, bend: -0.5, mode: 'manual', routeVersion: 0 });
    const a2 = M.makeArrow({ type: 'free', x: 2, y: 12 }, { type: 'free', x: 4, y: 12 }, { electronCount: 2, bend: 0.4, mode: 'manual', routeVersion: 0 });
    app.model.addArrow(a1); app.model.addArrow(a2);
    app.controller.selection.clear();
    app.controller.selection.add(a1.id); app.controller.selection.add(a2.id);
    app.controller.emitSelection();
    app.adapter.clearSelection();
    app.controller.render();
    return JSON.stringify({ sel: app.controller.selection.size });
  })()`);
  check('CP12 两根箭头同时选中', JSON.parse(twoIds).sel === 2, twoIds);
  const twoMsgs = await pressKey('c');
  const twoPayload = twoMsgs.length ? JSON.parse(twoMsgs[0].text) : null;
  check('CP12 两根箭头都进了载荷', !!twoPayload && twoPayload.arrows.length === 2,
    JSON.stringify({ msgs: twoMsgs.length, arrows: twoPayload && twoPayload.arrows.length }));
  await firePaste('iframe');
  await wait(900);
  const afterTwo = JSON.parse(await mechState());
  check('CP12 粘贴出两根副本', afterTwo.arrows.length === 4, String(afterTwo.arrows.length));
  const selTwo = await js(`window.MolWorkbench.app.controller.selection.size`);
  check('CP12 只选中两根新副本', selTwo === 2, String(selTwo));

  check('无 console 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log('\n==== ' + PASS + ' passed, ' + FAIL + ' failed ====');
  if (FAILED.length) console.log('FAILED:\n  ' + FAILED.join('\n  '));
  await wait(300);
  app.quit();
  process.exit(FAIL ? 1 : 0);
});
