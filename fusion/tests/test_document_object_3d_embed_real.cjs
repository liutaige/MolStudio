'use strict';
// 真实探针：threed.html?embed=1 内嵌交互 + 快照。
// 先起隔离服务，再运行本文件：
//   MOLSTUDIO_PORT=49166 npm --prefix fusion start
//   MOLSTUDIO_PORT=49166 MOLSTUDIO_AGENT_TEST_OUT=/abs/path \
//     env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron \
//     --no-sandbox fusion/tests/test_document_object_3d_embed_real.cjs
// 注意：不能加 --disable-gpu，会拿不到 WebGL 上下文；--no-sandbox 是本环境必需。
// 无模型调用：分子经页面内真实 /api/gen3d 生成。

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49166;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) {
  throw new Error('MOLSTUDIO_PORT must be a valid isolated service port');
}
const base = `http://127.0.0.1:${port}`;
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT ||
  path.join(__dirname, '../../.jez/artifacts/document-3d-embed'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-3d-embed-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);

const report = {
  application: 'MolStudio current canvas — 3D embed renderer',
  page: 'fusion/threed.html?embed=1',
  pageURL: `${base}/threed.html?embed=1`,
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  fixture: 'fusion/tests/fixtures/M01.ket mol0（真实 /api/gen3d 生成，无模型调用）',
  modelCalls: 0,
  checks: [],
  browserErrors: [],
  artifacts: {},
  startedAt: new Date().toISOString(),
  ok: false
};
let win;
const watchdog = setTimeout(() => {
  report.ok = false;
  report.error = 'watchdog expired';
  writeReport();
  app.exit(2);
}, 180_000);

function writeReport() {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!ok) console.error(`[FAIL] ${name}: ${detail}`);
  return !!ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function alphaMetrics(dataURL) {
  const image = nativeImage.createFromDataURL(dataURL), { width, height } = image.getSize(), pixels = image.toBitmap();
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] <= 2) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const bounds = maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { width, height, bounds, aspect: bounds ? bounds.width / bounds.height : 0,
    occupancy: bounds ? Math.max(bounds.width / width, bounds.height / height) : 0,
    fillX: bounds ? bounds.width / width : 0, fillY: bounds ? bounds.height / height : 0,
    margins: bounds ? { left: bounds.x, top: bounds.y,
      right: width - bounds.x - bounds.width, bottom: height - bounds.y - bounds.height } : null,
    minMarginPct: bounds ? Math.min(bounds.x / width, (width - bounds.x - bounds.width) / width,
      bounds.y / height, (height - bounds.y - bounds.height) / height) : 0 };
}

app.whenReady().then(async () => {
  let step = 'init';
  const wrap = (label, promise) => { step = label; return promise; };
  try {
    win = new BrowserWindow({
      width: 900, height: 700, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) report.browserErrors.push(String(message).slice(0, 300));
    });
    await win.loadURL(`${base}/threed.html?embed=1`);

    // 1) 页面内真实 /api/gen3d：M01.ket 的 mol0
    const ketText = fs.readFileSync(path.join(__dirname, 'fixtures', 'M01.ket'), 'utf8');
    const genScript = `(async () => {
      const resp = await fetch('/api/gen3d', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ket: window.__KET__, keys: ['mol0'], allowExample: true, identity: 'probe-3d-embed' })
      });
      return { status: resp.status, bodyText: (await resp.text()).slice(0, 4000) };
    })()`;
    const gen = await wrap('gen3d', win.webContents.executeJavaScript(
      genScript.replace('window.__KET__', JSON.stringify(ketText))));
    gen.body = (() => { try { return JSON.parse(gen.bodyText); } catch (e) { return null; } })();
    if (!check('gen3d ok', gen.status === 200 && gen.body && gen.body.ok === true,
      `HTTP ${gen.status} ${String(gen.bodyText).slice(0, 300)}`)) {
      throw new Error('gen3d failed');
    }
    const molblock = gen.body.molblock;
    check('gen3d molblock', typeof molblock === 'string' && molblock.includes('V2000'), molblock.slice(0, 60));

    // 2) 注入纯逻辑模块并创建 InteractionSession（内嵌 iframe + postMessage 总线）
    const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'workbench', 'document-object-3d.js'), 'utf8');
    await win.webContents.executeJavaScript(`(function(){ ${moduleSource}; return true; })()`);
    const sessionInfo = await wrap('mount', win.webContents.executeJavaScript(`(async () => {
      const MW = window.MolWorkbench;
      const host = document.createElement('div');
      host.id = 'embed-host';
      host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;';
      document.body.appendChild(host);
      window.__session = new MW.documentObject3D.InteractionSession({
        host, serverBase: '', molblock: ${JSON.stringify(molblock)},
        style: 'ballstick'
      });
      await window.__session.mount();
      return { mounted: true };
    })()`));
    check('session mount', sessionInfo.mounted === true);

    // 3) 快照 320x240
    const dataURL = await wrap('snapshot', win.webContents.executeJavaScript(
      `window.__session.snapshot({ width: 320, height: 240 })`));
    check('snapshot dataURL', typeof dataURL === 'string' && dataURL.startsWith('data:image/png;base64,'));
    const rawMetrics = alphaMetrics(dataURL);
    check('independent snapshot keeps its requested fixed size', rawMetrics.width === 320 && rawMetrics.height === 240, JSON.stringify(rawMetrics));
    const pngPath = path.join(out, 'embed-snapshot-320x240.png');
    fs.writeFileSync(pngPath, Buffer.from(dataURL.split(',')[1], 'base64'));
    report.artifacts.snapshot = pngPath;
    const rgba = nativeImage.createFromDataURL(dataURL).toBitmap();
    let transparent = 0, visible = 0;
    for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] === 0) transparent++; else visible++; }
    check('PNG has alpha background and visible molecule immediately after mount',
      rgba[3] === 0 && transparent > 320 * 240 / 2 && visible > 100,
      JSON.stringify({ transparent, visible, cornerAlpha: rgba[3] }));

    const cameraBeforeTrim = await wrap('camera-before-trim', win.webContents.executeJavaScript('window.__session.cameraJson()'));
    const trimmedURL = await wrap('trimmed-snapshot', win.webContents.executeJavaScript(
      `window.__session.snapshot({ width: 320, height: 240, trim: true })`));
    const cameraAfterTrim = await wrap('camera-after-trim', win.webContents.executeJavaScript('window.__session.cameraJson()'));
    const trimmedMetrics = alphaMetrics(trimmedURL);
    const trimmedPath = path.join(out, 'embed-snapshot-alpha-trimmed-320x240.png');
    fs.writeFileSync(trimmedPath, Buffer.from(trimmedURL.split(',')[1], 'base64'));
    report.artifacts.trimmedSnapshot = trimmedPath;
    check('explicit trim preserves frame size, alpha border, and molecule aspect without changing camera',
      trimmedMetrics.width === 320 && trimmedMetrics.height === 240 && trimmedMetrics.occupancy >= .82 && trimmedMetrics.occupancy <= .92 &&
      Object.values(trimmedMetrics.margins || {}).every(x => x >= 5) &&
      Math.abs(trimmedMetrics.aspect - rawMetrics.aspect) < .03 &&
      JSON.stringify(cameraBeforeTrim) === JSON.stringify(cameraAfterTrim),
      JSON.stringify({ ...trimmedMetrics, cameraBeforeTrim, cameraAfterTrim }));

    // 4) camera-get → 修改相机 → camera-get 数值变化；rotateXY 后仍可快照
    const cam1 = await wrap('camera-get', win.webContents.executeJavaScript('window.__session.cameraJson()'));
    check('camera-get', cam1 && [cam1.px, cam1.py, cam1.pz, cam1.distance].every(Number.isFinite), JSON.stringify(cam1));
    await wrap('camera-set', win.webContents.executeJavaScript(
      `window.__session.applyCameraJson({ px: ${cam1.px}, py: ${cam1.py}, pz: ${cam1.pz}, distance: ${cam1.distance} * 1.5 })`));
    const cam2 = await wrap('camera-get2', win.webContents.executeJavaScript('window.__session.cameraJson()'));
    check('camera distance changed', cam2 && cam2.distance !== cam1.distance, `${cam1.distance} -> ${cam2 && cam2.distance}`);
    // rotateXY：协议只管相机/快照，姿态旋转经 iframe 内 k3d 真实 API 调用验证
    const rot = await wrap('rotateXY', win.webContents.executeJavaScript(`(async () => {
      const f = document.querySelector('#embed-host iframe');
      if (!f || !f.contentWindow.k3d) return { ok: false, error: 'no iframe k3d' };
      f.contentWindow.k3d.rotateXY(40, 20);
      await new Promise(r => setTimeout(r, 500));
      return { ok: true, hasK3d: true };
    })()`));
    check('rotateXY via k3d', rot && rot.ok === true, JSON.stringify(rot));
    const snap2 = await wrap('snapshot-rotated', win.webContents.executeJavaScript(
      `window.__session.snapshot({ width: 320, height: 240 })`));
    const png2 = path.join(out, 'embed-snapshot-rotated.png');
    fs.writeFileSync(png2, Buffer.from(snap2.split(',')[1], 'base64'));
    report.artifacts.snapshotRotated = png2;
    check('snapshot after rotate', typeof snap2 === 'string' && snap2.startsWith('data:image/png'));

    const trimmedRotated = await wrap('trimmed-snapshot-rotated', win.webContents.executeJavaScript(
      `window.__session.snapshot({ width: 320, height: 240, trim: true })`));
    const rotatedMetrics = alphaMetrics(trimmedRotated);
    const rawRotatedMetrics = alphaMetrics(snap2);
    check('trimmed output remains correctly fitted after rotating to a different projection',
      rotatedMetrics.width === 320 && rotatedMetrics.height === 240 && rotatedMetrics.occupancy >= .82 && rotatedMetrics.occupancy <= .92 &&
      Object.values(rotatedMetrics.margins || {}).every(x => x >= 5) &&
      Math.abs(rotatedMetrics.aspect - rawRotatedMetrics.aspect) < .03,
      JSON.stringify({ rotated: rotatedMetrics, raw: rawRotatedMetrics }));

    const restored = await wrap('orientation-roundtrip', win.webContents.executeJavaScript(`(async () => {
      const session = window.__session;
      const camera = await session.cameraJson();
      await session.resetView();
      await session.applyCameraJson(camera);
      const restored = await session.cameraJson();
      const png = await session.snapshot({ width: 320, height: 240 });
      return { camera, restored, png };
    })()`));
    check('rotation quaternion survives camera roundtrip',
      ['qx', 'qy', 'qz', 'qw'].every(key => Number.isFinite(restored.camera[key]) && Math.abs(restored.camera[key] - restored.restored[key]) < 1e-7) &&
      Math.abs(restored.camera.qx) + Math.abs(restored.camera.qy) > .01, JSON.stringify(restored.camera));
    const beforePixels = nativeImage.createFromDataURL(snap2).toBitmap();
    const afterPixels = nativeImage.createFromDataURL(restored.png).toBitmap();
    let changedPixels = 0;
    for (let i = 0; i < beforePixels.length; i += 4) {
      if ([0, 1, 2, 3].some(k => Math.abs(beforePixels[i+k] - afterPixels[i+k]) > 3)) changedPixels++;
    }
    check('restored orientation renders the same preview', changedPixels < 320 * 240 * .005,
      JSON.stringify({ changedPixels, pixels: 320 * 240 }));

    // 5) style 切换
    await wrap('setStyle', win.webContents.executeJavaScript(`window.__session.setStyle('sphere')`));
    await sleep(600);
    const styleState = await wrap('style', win.webContents.executeJavaScript(`(() => {
      const f = document.querySelector('#embed-host iframe');
      return { lastStyle: f.contentWindow.__lastStyle, reps: f.contentWindow.__reps };
    })()`));
    check('style switch to sphere', styleState.reps && styleState.reps.startsWith('sphere'),
      JSON.stringify(styleState));

    // 6) dispose 后 snapshot 拒绝；active 引用清空
    await wrap('dispose', win.webContents.executeJavaScript(`window.__session.dispose()`));
    let disposedReject = false;
    try {
      await win.webContents.executeJavaScript(`window.__session.snapshot({ width: 64, height: 64 })`);
    } catch (e) { disposedReject = true; }
    check('snapshot after dispose rejected', disposedReject);
    const activeCleared = await win.webContents.executeJavaScript(
      `window.MolWorkbench.documentObject3D.getActiveSession() === null`);
    check('active session cleared after dispose', activeCleared === true);
    const iframeGone = await win.webContents.executeJavaScript(
      `!document.querySelector('#embed-host iframe')`);
    check('iframe removed after dispose', iframeGone === true);

    report.ok = report.checks.every(c => c.ok);
    if (!report.ok) throw new Error('checks failed');
    console.log('ALL CHECKS PASSED');
    writeReport();
    clearTimeout(watchdog);
    app.exit(0);
  } catch (err) {
    report.ok = false;
    report.error = `step=${step} ` + String((err && err.stack) || err).slice(0, 2000);
    writeReport();
    clearTimeout(watchdog);
    app.exit(1);
  }
});
