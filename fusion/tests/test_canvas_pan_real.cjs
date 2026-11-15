'use strict';
/* Real Ketcher pan regression. Run against a separately started, isolated service:
 * MOLSTUDIO_PORT=... MOLSTUDIO_TEST_BUILD=/absolute/candidate.app \
 * MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts electron tests/test_canvas_pan_real.cjs
 * Synthetic DOM pixel WheelEvents in Electron/Chromium; this is neither a
 * native WKWebView acceptance nor a hardware trackpad/inertia measurement.
 * Paper clamping is disabled ONLY while checking the input-to-camera gain.
 * The runner starts no service and blocks model calls and remote requests.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.MOLSTUDIO_PORT || 48975);
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, 'artifacts/canvas-pan-real'));
const SERVICE = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures/reading-viewport-regression.molwork');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-pan-real-')));
app.on('window-all-closed', () => {});

async function exercisePan() {
  const S = window.MolWorkbench.app, A = S.adapter, E = A.ed;
  const D = S.documentController, W = A.doc.defaultView, C = S.controller;
  const checks = [], measurements = {}, restores = [], counters = {}, kinds = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settled = () => pause(220);
  const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail });
  const wrap = (object, key, label = key) => {
    if (!object || typeof object[key] !== 'function') throw new Error('Missing instrumentation target: ' + label);
    const original = object[key]; counters[label] = 0;
    object[key] = function (...args) { counters[label]++; return original.apply(this, args); };
    restores.push(() => { object[key] = original; });
  };
  const reset = () => { for (const key of Object.keys(counters)) counters[key] = 0; kinds.length = 0; };
  const snapshot = () => ({ ...counters });
  const counts = () => ({ atoms: E.struct().atoms.size, bonds: E.struct().bonds.size,
    arrows: S.model.state.arrows.length, lonePairs: S.model.state.lonePairs.length });
  const semanticState = () => JSON.stringify({ model: S.model.state,
    atoms: [...E.struct().atoms].map(([id, atom]) => [id, atom.label, atom.charge || 0, atom.pp.x, atom.pp.y]),
    bonds: [...E.struct().bonds].map(([id, bond]) => [id, bond.begin, bond.end, bond.type, bond.stereo || 0]) });
  const svgPoint = () => new W.DOMPoint(0, 0).matrixTransform(A.canvasSvg().getScreenCTM());
  const target = E.render.clientArea.querySelector('[data-testid="canvas"]') || E.render.clientArea;
  const rect = target.getBoundingClientRect();
  const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const wheel = (dx, dy) => target.dispatchEvent(new W.WheelEvent('wheel', {
    bubbles: true, cancelable: true, deltaMode: 0, deltaX: dx, deltaY: dy, ...point, view: W
  }));
  const near = (actual, expected, tolerance = 0.003) => Math.abs(actual - expected) < tolerance;
  const editorTool = E.tool();
  let bridge = null, oldWebkit = null, webkitReplaced = false;
  const originalDocument = { active: D.active, mode: D.state.mode, clamp: D.clampPaperViewport };
  let unsubscribe = null;
  try {
    measurements.fixture = counts();
    check('large editable fixture has 427 atoms, 47 arrows and 22 lone pairs',
      measurements.fixture.atoms === 427 && measurements.fixture.arrows === 47 && measurements.fixture.lonePairs === 22,
      measurements.fixture);
    E.tool('hand');
    check('real editor HandTool is recognised by adapter', A.isHandTool() === true);
    target.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, cancelable: true, ...point, view: W }));
    await settled();
    const beforeSemantics = semanticState(), beforeHistory = { ...E.historySize() };
    measurements.gain = [];
    // Only route/gain is tested here; boundary behaviour is covered separately
    // by the real document regressions, without changing its production code.
    D.clampPaperViewport = () => false;
    for (const mode of ['canvas', 'paper']) {
      D.active = mode === 'paper'; D.state.mode = mode;
      for (const zoom of [0.5, 1, 2]) {
        E.zoom(zoom); await settled();
        const before = svgPoint(); wheel(31.25, -17.5); const after = svgPoint();
        const displacement = { x: after.x - before.x, y: after.y - before.y };
        const record = { mode, zoom, input: { x: 31.25, y: -17.5 }, screenDisplacement: displacement,
          paperBoundaryClampDisabled: mode === 'paper' };
        measurements.gain.push(record);
        check(`${mode} zoom ${zoom}: 0.55 screen pixels per input delta pixel`,
          near(displacement.x, -31.25 * 0.55) && near(displacement.y, 17.5 * 0.55), record);
      }
    }
    D.active = originalDocument.active; D.state.mode = originalDocument.mode;
    D.clampPaperViewport = originalDocument.clamp;
    E.zoom(1); await settled();

    const tail = [6, 2, 0.5, 0.1, 0.025, 0.005, 0.001];
    measurements.smallDeltas = [];
    for (const delta of tail) {
      const before = svgPoint(); wheel(delta, -delta / 2); const after = svgPoint();
      const displacement = { x: after.x - before.x, y: after.y - before.y };
      measurements.smallDeltas.push({ input: delta, screenDisplacement: displacement });
      check(`decaying delta ${delta} is applied at gain 0.55 without a dead zone`,
        near(displacement.x, -delta * 0.55, 0.0001) && near(displacement.y, delta / 2 * 0.55, 0.0001), displacement);
      await pause(20);
    }
    await settled();
    check('gain and small-delta replay preserve chemistry and editor history',
      semanticState() === beforeSemantics && JSON.stringify(E.historySize()) === JSON.stringify(beforeHistory));

    oldWebkit = Object.getOwnPropertyDescriptor(window, 'webkit');
    const messages = [];
    Object.defineProperty(window, 'webkit', { configurable: true, value: {
      messageHandlers: { k3d: { postMessage: message => messages.push(message) } }
    } });
    webkitReplaced = true;
    bridge = window.MolWorkbench.nativeUI.current();
    if (!bridge) throw new Error('Real NativeUIBridge instance missing');
    const attached = await bridge.attach({ protocol: 1,
      epoch: { navigationGeneration: 915, pageId: 'canvas-pan-real' }, nativeSurfaces: [],
      host: { windowKey: true, focusOwner: 'canvas' } });
    check('actual NativeUIBridge attaches to real editor with stub native transport', attached.ok === true);
    await settled();
    for (const key of ['syncIdentity', 'chemSnapshot']) wrap(A, key);
    wrap(S.layer, 'render', 'layer.render');
    wrap(C, 'render', 'mechanism.render'); wrap(C, 'hitTest', 'mechanism.hitTest');
    wrap(D, 'render', 'document.render');
    wrap(bridge, 'noteSelectionChange', 'native.noteSelectionChange');
    unsubscribe = A.onChange(kind => kinds.push(kind));
    const retained = { svg: A.canvasSvg(), root: S.layer.root, body: S.layer.body,
      arrow: A.doc.querySelector('[data-arrow]'), lp: A.doc.querySelector('[data-lp]') };
    check('mechanism SVG contains retained arrow and lone-pair nodes', !!retained.arrow && !!retained.lp);
    reset(); messages.length = 0;
    const intervals = []; let last = performance.now();
    for (let i = 0; i < 24; i++) {
      await pause(18);
      const now = performance.now(); intervals.push(now - last); last = now;
      wheel(i < 16 ? 4 : 4 * Math.pow(0.65, i - 15), 1.25);
    }
    await settled();
    measurements.pan = { events: 24, counters: snapshot(), kinds: [...kinds],
      nativeMessageKinds: messages.map(message => message.kind), eventIntervalsMs: intervals };
    check('pure camera translation publishes pan notifications', kinds.length > 0 && kinds.every(kind => kind === 'pan'), [...kinds]);
    check('pure pan performs no identity sync, chemistry snapshot or mechanism layer redraw',
      counters.syncIdentity === 0 && counters.chemSnapshot === 0 && counters['layer.render'] === 0, snapshot());
    check('pure pan retains original SVG, mechanism, arrow and lone-pair nodes',
      retained.svg === A.canvasSvg() && retained.root === S.layer.root && retained.body === S.layer.body &&
      retained.arrow === A.doc.querySelector('[data-arrow]') && retained.lp === A.doc.querySelector('[data-lp]'));
    check('pure pan performs no selection recomputation or full native state broadcast',
      counters['native.noteSelectionChange'] === 0 && messages.every(message => message.kind !== 'state'), measurements.pan);
    check('pure pan preserves chemistry and editor history',
      semanticState() === beforeSemantics && JSON.stringify(E.historySize()) === JSON.stringify(beforeHistory));

    reset(); messages.length = 0;
    for (let i = 0; i < 12; i++) target.dispatchEvent(new W.PointerEvent('pointermove', {
      bubbles: true, pointerId: 1, pointerType: 'mouse', ...point, clientX: point.clientX + i,
      view: W
    }));
    await settled();
    measurements.handPointerMove = snapshot();
    check('real HandTool pointermove skips mechanism hit testing and rendering',
      counters['mechanism.hitTest'] === 0 && counters['mechanism.render'] === 0 && counters.chemSnapshot === 0, snapshot());

    reset(); E.zoom(1.25); E.event.zoomChanged.dispatch(); await settled();
    measurements.zoom = { counters: snapshot(), kinds: [...kinds] };
    // Ketcher's zoom may rebuild its native SVG via render.update(), which is
    // intentionally kept as a structural fallback. It must redraw, never be
    // swallowed as a pan; only pure translations promise zero chemistry work.
    check('zoom refreshes SVG geometry and is never misclassified as a pure pan',
      counters['layer.render'] > 0 && kinds.length > 0 && kinds.every(kind => kind !== 'pan') &&
      near(A.zoom(), 1.25) && semanticState() === beforeSemantics &&
      JSON.stringify(E.historySize()) === JSON.stringify(beforeHistory), measurements.zoom);

    // Use Ketcher's real undoable AtomAttr operation, not an adapter notification
    // mock: change one atom, commit its inverse through editor.update, then undo.
    const so = W.molstudioNativeStructOps;
    if (!so?.atomAttr) throw new Error('Native Ketcher atom operations unavailable');
    const atomId = [...E.struct().atoms.keys()].find(id => E.struct().atoms.get(id).label === 'C');
    const originalCharge = E.struct().atoms.get(atomId).charge || 0;
    const makeAction = operations => ({ operations, isDummy: () => false, perform(ctab) {
      const inverses = []; for (let i = operations.length - 1; i >= 0; i--) inverses.push(operations[i].perform(ctab));
      so.recalc(ctab.molecule, [atomId]); return makeAction(inverses);
    } });
    const editCharge = value => {
      const inverse = new so.atomAttr(atomId, 'charge', value).perform(E.render.ctab);
      so.recalc(E.struct(), [atomId]); E.update(makeAction([inverse]));
    };
    reset(); const undoBefore = E.historySize().undo;
    editCharge(originalCharge + 1); await settled();
    measurements.edit = { counters: snapshot(), kinds: [...kinds], history: E.historySize() };
    check('actual undoable atom edit still synchronises identity and recomputes chemistry',
      E.struct().atoms.get(atomId).charge === originalCharge + 1 && E.historySize().undo === undoBefore + 1 &&
      counters.syncIdentity > 0 && counters.chemSnapshot > 0 && counters['layer.render'] > 0 && kinds.includes('struct'), measurements.edit);
    E.undo(); await settled();
    check('one real editor undo restores the edited atom', (E.struct().atoms.get(atomId).charge || 0) === originalCharge);

    reset(); editCharge(originalCharge + 1); wheel(9, -5); await settled();
    measurements.editAndPan = { counters: snapshot(), kinds: [...kinds], history: E.historySize() };
    check('same-frame atom edit and pan retain structural work and redraw',
      E.struct().atoms.get(atomId).charge === originalCharge + 1 && counters.syncIdentity > 0 &&
      counters.chemSnapshot > 0 && counters['layer.render'] > 0 && kinds.includes('struct'), measurements.editAndPan);
    E.undo(); await settled();
    check('same-frame edit remains undoable and final chemical fixture is preserved', semanticState() === beforeSemantics, counts());
    measurements.finalCounts = counts();
  } finally {
    if (unsubscribe) unsubscribe();
    restores.reverse().forEach(restore => restore());
    if (bridge?.attached) bridge.detach();
    if (webkitReplaced) { if (oldWebkit) Object.defineProperty(window, 'webkit', oldWebkit); else delete window.webkit; }
    D.active = originalDocument.active; D.state.mode = originalDocument.mode;
    D.clampPaperViewport = originalDocument.clamp;
    // Return to the normal selection tool for the editable artifact.
    if (editorTool) E.tool('select');
  }
  return { checks, measurements };
}

const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout', service: SERVICE,
  engine: 'isolated Electron / Chromium, not native WKWebView',
  input: 'synthetic DOM pixel-mode WheelEvent replay; no hardware momentum or Freeform damping measurement',
  paperScope: 'camera gain only: paper boundary clamp temporarily disabled and restored; no paper boundary acceptance claimed',
  fixture: FIXTURE, checks: [], blockedModelRequests: 0, blockedRemoteRequests: 0, modelRequests: 0,
  electron: process.versions.electron, chromium: process.versions.chrome };
let win;
const timeout = setTimeout(() => {
  report.ok = false; report.error = 'canvas pan regression timed out';
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.error(report.error); app.exit(2);
}, 120000);
app.whenReady().then(async () => {
  try {
    app.dock?.hide();
    win = new BrowserWindow({ show: false, width: 1400, height: 920,
      webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const model = url.pathname === '/api/agent/model';
      const remote = /^https?:$/.test(url.protocol) && url.origin !== SERVICE;
      if (model) report.blockedModelRequests++;
      if (remote) report.blockedRemoteRequests++;
      callback({ cancel: model || remote });
    });
    report.browserErrors = [];
    win.webContents.on('console-message', (_event, level, message) => {
      if (typeof level === 'number' && level >= 2) report.browserErrors.push(String(message));
    });
    const js = source => win.webContents.executeJavaScript(source);
    await win.loadURL(SERVICE + '/canvas.html');
    let ready = false;
    for (let i = 0; i < 350; i++) {
      ready = await js('!!(window.k3dAPI?.workbenchReady?.() && window.MolWorkbench?.nativeUI?.current?.())');
      if (ready) break; await wait(100);
    }
    if (!ready) throw new Error('Real Ketcher workbench and native bridge did not become ready');
    const fixture = fs.readFileSync(FIXTURE, 'utf8');
    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('Fixture failed to load: ' + JSON.stringify(loaded));
    await wait(700);
    Object.assign(report, await js(`(${exercisePan.toString()})()`));
    fs.writeFileSync(path.join(OUT, 'canvas-pan-real.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(OUT, 'canvas-pan-real.molwork'), await js('k3dAPI.serializeWorkbench()'));
    report.checks.push({ name: 'no model requests attempted', ok: report.blockedModelRequests === 0,
      detail: { blocked: report.blockedModelRequests, sent: 0 } });
    report.ok = report.checks.length > 0 && report.checks.every(check => check.ok);
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error);
  } finally {
    clearTimeout(timeout);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.ok).length,
      total: report.checks.length, out: OUT, error: report.error || null }));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  }
});
