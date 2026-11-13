'use strict';
// Current canvas and real editor, using a saved real-model scene as input.
// Export-only verification: no model calls and no semantic step mutations.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '.jez/artifacts/complex-route-repair-20261112/export');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-export-regression-'));
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', profile);
const report = { application: 'MolStudio current canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  service: 'http://127.0.0.1:' + (Number(process.env.MOLSTUDIO_PORT) || 49075), modelCalls: 0, checks: [], cases: [] };
const watchdog = setTimeout(() => app.exit(2), 90_000);

async function exercise() {
  const { adapter, model, controller } = MolWorkbench.app, ex = MolWorkbench.exporter;
  const svg = adapter.canvasSvg(), ed = adapter.ed, NS = 'http://www.w3.org/2000/svg';
  const checks = window.exportRegressionChecks = [], artifacts = window.exportRegressionArtifacts = {};
  const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
    if (!pass) throw new Error(name);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const element = (tag, attrs, parent) => {
    const node = svg.ownerDocument.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    parent.appendChild(node); return node;
  };
  const before = await k3dAPI.serializeWorkbench(), history = [ed.historyPtr, ed.historySize().undo, ed.historySize().redo];
  const originalBox = ex.contentBBox(svg);
  const mechanismPath = svg.querySelector('.mech-body path'), local = mechanismPath.getBBox();
  const matrix = svg.getCTM().inverse().multiply(mechanismPath.getCTM());
  const single = ex.contentBBox({ querySelectorAll: () => [mechanismPath], getCTM: () => svg.getCTM() });
  const expectedX = matrix.a * local.x + matrix.c * local.y + matrix.e;
  const expectedY = matrix.b * local.x + matrix.d * local.y + matrix.f;
  check('rendered mechanism leaf bounds use root coordinates rather than local model units', originalBox &&
    Math.abs(single.x - expectedX) < 2 && Math.abs(single.y - expectedY) < 2 &&
    Math.abs(single.x - local.x) > 40 && Math.abs(single.y - local.y) > 40, { originalBox, local, single, expectedX, expectedY });
  const legend = element('g', { id: 'manual-export-legend', transform: `translate(${originalBox.x + 20},${originalBox.y - 65}) rotate(-3)` }, svg);
  const inner = element('g', { transform: 'scale(1.2)' }, legend);
  element('rect', { id: 'user-grey-shape', x: 0, y: 0, width: 90, height: 18, fill: '#b2bbc3', stroke: '#b2bbc3' }, inner);
  element('text', { x: 5, y: 13, 'font-size': 12, fill: '#111' }, inner).textContent = 'Manual legend';
  const hidden = element('g', { opacity: 0, id: 'invisible-export-fixture' }, svg);
  element('rect', { x: -90000, y: -90000, width: 190000, height: 190000, fill: '#000' }, hidden);
  const rootSource = await k3dAPI.serializeWorkbench();
  check('manual export legend and invisible DOM fixtures leave editable source unchanged', rootSource === before);
  const visibleCount = svg.querySelectorAll('[data-testid="rxn-arrow"]').length;
  const nativeShapeCount = ed.struct().simpleObjects.size, nativeTextCount = ed.struct().texts.size;
  const cases = [];
  for (const [name, zoom, panX, panY] of [['baseline', 1, 0, 0], ['panned', 1, 220, 260],
    ['zoom-out', 0.4, -380, 440], ['zoom-in', 2.5, 470, -320]]) {
    ed.zoom(zoom); await wait(80);
    ed.render.setViewBox(b => ({ ...b, minX: b.minX + panX, minY: b.minY + panY }));
    controller.render(); await wait(80);
    const liveBars = svg.querySelectorAll('[data-molstudio-ui="scrollbar"]').length;
    const exported = await k3dAPI.exportMechanismImage('svg');
    check(name + ': SVG export succeeds', exported.ok, exported.error);
    const text = decodeURIComponent(escape(atob(exported.dataUrl.split(',')[1])));
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    check(name + ': exported SVG has no editor scrollbars or handles', !parsed.querySelector('[data-molstudio-ui="scrollbar"],[data-testid="horizontal-bar"],[data-testid="vertical-bar"],[data-mech-ui="1"]'));
    check(name + ': same-grey user rectangle and transformed manual legend remain',
      parsed.querySelector('#user-grey-shape')?.getAttribute('fill') === '#b2bbc3' &&
      parsed.querySelector('#manual-export-legend text')?.textContent === 'Manual legend');
    check(name + ': native straight arrows and user annotations remain',
      parsed.querySelectorAll('[data-testid="rxn-arrow"]').length === visibleCount && visibleCount >= 5 &&
      nativeShapeCount >= 1 && nativeTextCount >= 1 && parsed.documentElement.textContent.replace(/\s+/g, '').includes('Nativeexportnote'),
      { visibleCount, exportedArrows: parsed.querySelectorAll('[data-testid="rxn-arrow"]').length, nativeShapeCount, nativeTextCount });
    check(name + ': mechanism arrow and lone-pair layer remain', parsed.querySelectorAll('.mech-arrow').length === model.state.arrows.length &&
      parsed.querySelectorAll('.mech-lone-pair').length === model.state.lonePairs.length);
    const png = await k3dAPI.exportMechanismImage('png');
    check(name + ': PNG export succeeds', png.ok, png.error);
    const image = new Image(); image.src = png.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    const margins = [minX, minY, image.width - 1 - maxX, image.height - 1 - maxY];
    check(name + ': raster content has bounded padding and no cropped edge', margins.every(value => value >= 8 && value < 65), { margins, width: image.width, height: image.height });
    artifacts[name] = { svg: exported.dataUrl, png: png.dataUrl };
    cases.push({ name, zoom: adapter.zoom(), viewBox: svg.getAttribute('viewBox'), liveBars,
      contentBBox: ex.contentBBox(svg), width: exported.width, height: exported.height, pngWidth: image.width, pngHeight: image.height, margins });
  }
  check('pan and zoom do not change publication dimensions', cases.every(item => item.width === cases[0].width && item.height === cases[0].height), cases);
  check('panned or zoomed view exercises native marked scrollbars', cases.some(item => item.liveBars === 2), cases.map(({ name, liveBars }) => ({ name, liveBars })));
  check('export and camera changes preserve editable source and native history', await k3dAPI.serializeWorkbench() === before &&
    JSON.stringify([ed.historyPtr, ed.historySize().undo, ed.historySize().redo]) === JSON.stringify(history));
  artifacts.source = before;
  return { checks, cases };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 880, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    report.service = 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49075);
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 250 && !await js('!!window.k3dAPI?.workbenchReady?.()'); i++) await new Promise(r => setTimeout(r, 100));
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/export-caffeine-routes.molwork'), 'utf8'));
    const originalLoad = await js('k3dAPI.loadWorkbench(' + JSON.stringify(JSON.stringify(fixture)) + ')');
    if (!originalLoad.ok) throw new Error(JSON.stringify(originalLoad));
    const reproduction = await js(`(async () => {
      const source = await k3dAPI.serializeWorkbench(), svg = await k3dAPI.exportMechanismImage('svg'), png = await k3dAPI.exportMechanismImage('png');
      return { source, svg, png, sourceUnchanged: source === await k3dAPI.serializeWorkbench() };
    })()`);
    if (!reproduction.svg.ok || !reproduction.png.ok || !reproduction.sourceUnchanged) throw new Error('Original saved export fixture failed');
    fs.writeFileSync(path.join(out, 'caffeine-original.molwork'), reproduction.source);
    for (const kind of ['svg', 'png']) fs.writeFileSync(path.join(out, 'caffeine-original.' + kind), Buffer.from(reproduction[kind].dataUrl.split(',')[1], 'base64'));
    report.originalReproduction = { load: originalLoad, sourceUnchanged: reproduction.sourceUnchanged,
      svgWidth: reproduction.svg.width, svgHeight: reproduction.svg.height, pngWidth: reproduction.png.width, pngHeight: reproduction.png.height };
    fixture.ket.root.nodes.push({ type: 'arrow', data: { mode: 'open-angle', pos: [{ x: 30, y: -7, z: 0 }, { x: 34, y: -7, z: 0 }] } },
      { type: 'simpleObject', data: { mode: 'ellipse', pos: [{ x: 31, y: -9, z: 0 }, { x: 34, y: -12, z: 0 }] } },
      { type: 'text', boundingBox: { x: 30, y: -5, width: 5, height: 0.5 }, paragraphs: [{ parts: [{ text: 'Native export note' }], indent: 0 }], indent: 0 });
    report.load = await js('k3dAPI.loadWorkbench(' + JSON.stringify(JSON.stringify(fixture)) + ')');
    if (!report.load.ok) throw new Error(JSON.stringify(report.load));
    const result = await js('(' + exercise.toString() + ')()'); Object.assign(report, result);
    report.ok = report.checks.every(check => check.pass);
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error);
    report.checks = await js('window.exportRegressionChecks || []').catch(() => []);
  } finally {
    const artifacts = await js('window.exportRegressionArtifacts || {}').catch(() => ({}));
    for (const [name, value] of Object.entries(artifacts)) {
      if (name === 'source') fs.writeFileSync(path.join(out, 'source.molwork'), value);
      else for (const kind of ['svg', 'png']) fs.writeFileSync(path.join(out, name + '.' + kind), Buffer.from(value[kind].split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(out, 'canvas-window.png'), (await win.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.pass).length, total: report.checks.length,
      failures: report.checks.filter(check => !check.pass), error: report.error, cases: report.cases, out }, null, 2));
    clearTimeout(watchdog); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
