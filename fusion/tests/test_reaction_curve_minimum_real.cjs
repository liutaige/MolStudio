'use strict';
// Actual current canvas, RDKit structures and native glyph geometry. No model.
// A deliberately flat saved AUTO arrow reproduces the screenshot's geometry;
// this fixture verifies its explicit repair, not a complete mechanism proof.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-curve-minimum-real');
const PORT = Number(process.env.MOLSTUDIO_PORT) || 49087;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-curve-minimum-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', profile);
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current served source build', service: `http://127.0.0.1:${PORT}`,
  case: 'Ethoxide LP to explicit amide N-H, paired with N-H sigma to N', modelRequests: 0, checks: [] };
let win;
const write = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.ok = false; report.error = 'watchdog'; write(); win?.destroy(); app.exit(2); }, 150_000);

async function exercise() {
  const MW = MolWorkbench, M = MW.model, R = MW.route, { adapter, model, controller } = MW.app, api = k3dAPI.agent;
  const checks = window.minimumCurveChecks = [], samples = window.minimumCurveSamples = {}, metrics = window.minimumCurveMetrics = {};
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); if (!pass) throw new Error(name); };
  const canonical = value => {
    const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
    return JSON.stringify(sorted(value));
  };
  const semantics = async () => {
    const c = await api.getContext();
    return canonical({ atoms: c.atoms.map(({ id, label, charge, implicitH, isotope, radical }) => ({ id, label, charge, implicitH, isotope, radical })).sort((a,b)=>a.id.localeCompare(b.id)),
      bonds: c.bonds.map(({ id, begin, end, order }) => ({ id, begin, end, order })).sort((a,b)=>a.id.localeCompare(b.id)),
      arrows: model.state.arrows.map(({ id, source, target, electronCount }) => ({ id, source, target, electronCount })).sort((a,b)=>a.id.localeCompare(b.id)),
      pairs: model.state.lonePairs.map(({ id, ownerAtomId, angle }) => ({ id, ownerAtomId, angle })) });
  };
  const savedCurves = text => canonical(JSON.parse(text).mechanism.arrows.map(({ id, source, target, electronCount, geometry }) =>
    ({ id, source, target, electronCount, geometry })).sort((a,b)=>a.id.localeCompare(b.id)));
  const assess = () => {
    const ctx = controller.ctx(), scene = R.buildScene(ctx, model, { planning: false });
    return model.state.arrows.map(flow => {
      const geometry = M.arrowGeometry(flow, ctx);
      const obstacles = { ...scene, arrows: [] }; R.addArrowObstacles(obstacles, model, ctx, flow.id);
      const plan = R.planArrow({ a: geometry.routingStart || geometry.start, b: geometry.routingEnd || geometry.end,
        scene: obstacles, source: flow.source, target: flow.target, fixedGeometry: geometry, requireCurvature: M.arrowMode(flow) === 'auto' });
      return { id: flow.id, source: flow.source, target: flow.target, bend: flow.geometry.bend, mode: M.arrowMode(flow),
        sourceOk: geometry.sourceOk, targetOk: geometry.targetOk, degenerate: !!geometry.degenerate,
        feasible: plan.feasible, readable: plan.readable, collisions: plan.collisions, arrowHits: plan.ranked[0]?.arrowHits,
        readability: plan.readability, geometry: { start: geometry.start, control: geometry.control, end: geometry.end } };
    });
  };
  const snapshot = async name => {
    samples[name] = await k3dAPI.serializeWorkbench();
    const image = await k3dAPI.exportMechanismImage('png');
    check(name + ' exports an actual canvas PNG', image.ok && image.width > 0 && image.height > 0, { ok: image.ok, width: image.width, height: image.height });
    samples[name + 'Png'] = image.dataUrl;
  };

  await k3dAPI.setMolecule(''); await api.beginRun('minimum-curve-seed');
  const seed = await api.applyOperations([
    { id: 'ethoxide', type: 'molecule.add', smiles: '[O-:1][CH2:2][CH3:3]', x: 5, y: 4 },
    { id: 'amide', type: 'molecule.add', smiles: '[H:1][N:2]([CH3:3])[C:4](=[O:5])[CH3:6]', x: 9, y: 5 },
    { id: 'iodide', type: 'molecule.add', smiles: '[I-:1]', x: 7.6, y: 5.3 },
  ], { runId: 'minimum-curve-seed' });
  const refs = seed.atomMapping;
  const coordinates = { 'ethoxide:1': [5,4], 'ethoxide:2': [5.866,3.5], 'ethoxide:3': [6.732,4],
    'amide:1': [9,4.55], 'amide:2': [9.866,5.05], 'amide:3': [10.732,4.55],
    'amide:4': [9.866,6.05], 'amide:5': [9,6.55], 'amide:6': [10.732,6.55], 'iodide:1': [7.6,5.3] };
  await api.applyOperations(Object.entries(coordinates).map(([ref,[x,y]], index) => ({ id: 'position-' + index,
    type: 'molecule.move', target: { atoms: [refs[ref]] }, x, y })), { runId: 'minimum-curve-seed' });
  const drawn = await api.applyOperations([
    { id: 'ethoxide-pair', type: 'lonePair.add', atom: refs['ethoxide:1'], angle: 90 },
    { id: 'nh-return', type: 'arrow.add', source: { type: 'bond', atom1: refs['amide:2'], atom2: refs['amide:1'], component: 'sigma' },
      target: { type: 'atom', atomId: refs['amide:2'] }, electronCount: 2 },
    { id: 'base-attack', type: 'arrow.add', source: { type: 'lonePair', id: 'ethoxide-pair' }, target: { type: 'atom', atomId: refs['amide:1'] },
      electronCount: 2 },
  ], { runId: 'minimum-curve-seed' });
  const attackId = drawn.created.find(item => item.id === 'base-attack').entityIds[0];
  const releaseId = drawn.created.find(item => item.id === 'nh-return').entityIds[0];
  metrics.newAutomatic = assess();
  check('new automatic native electron flows are visibly curved at creation', metrics.newAutomatic.every(flow => flow.feasible && flow.readable &&
    flow.mode === 'auto' && flow.readability.normalSag >= flow.readability.limits.minSag - 1e-8), metrics.newAutomatic);
  await api.applyOperations([{ id: 'manual-zero', type: 'arrow.modify', arrowId: attackId, bend: 0, mode: 'manual' }], { runId: 'minimum-curve-seed' });
  await api.endRun('minimum-curve-seed');
  const seedContext = await api.getContext();
  check('native seed retains an explicit amide N-H and paired electron flows', seedContext.atoms.length === 10 && model.state.arrows.length === 2 &&
    seedContext.atoms.find(atom => atom.id === refs['amide:1'])?.label === 'H' && seedContext.bonds.some(bond =>
      [bond.begin,bond.end].includes(refs['amide:1']) && [bond.begin,bond.end].includes(refs['amide:2'])), { atoms: seedContext.atoms.length });
  await snapshot('manual-straight');
  const historical = JSON.parse(samples['manual-straight']);
  historical.mechanism.arrows.find(flow => flow.id === attackId).geometry.mode = 'auto';
  const historicalText = JSON.stringify(historical);
  check('historical flat automatic sample loads', (await k3dAPI.loadWorkbench(historicalText)).ok);
  const old = model.arrow(attackId), oldMetrics = assess().find(flow => flow.id === attackId);
  metrics.flat = oldMetrics;
  check('loading an old automatic straight curve preserves its stored geometry and reports curve_flat', old.geometry.bend === 0 &&
    oldMetrics.sourceOk && oldMetrics.targetOk && !oldMetrics.readable && oldMetrics.readability.reasons.includes('curve_flat'), oldMetrics);
  await snapshot('old-flat-auto');
  const beforeSemantics = await semantics();
  await api.beginRun('minimum-curve-repair');
  await api.applyOperations([
    { id: 'reflow-return', type: 'arrow.modify', arrowId: releaseId, mode: 'auto' },
    { id: 'reflow-attack', type: 'arrow.modify', arrowId: attackId, mode: 'auto' },
  ], { runId: 'minimum-curve-repair' });
  await api.endRun('minimum-curve-repair');
  metrics.repaired = assess();
  check('explicit automatic repair preserves all atoms, bonds, lone pairs and semantic electron endpoints', beforeSemantics === await semantics());
  check('both actual native curves have visible normal sag and clear native glyphs and bonds', metrics.repaired.every(flow =>
    flow.sourceOk && flow.targetOk && !flow.degenerate && flow.feasible && flow.readable && !flow.collisions.labels.length && !flow.collisions.bonds.length &&
    flow.readability.normalSag + 1e-8 >= flow.readability.limits.minSag && flow.readability.sag <= flow.readability.limits.sag), metrics.repaired);
  const repaired = metrics.repaired.find(flow => flow.id === attackId);
  check('the long LP-H flow has a clearly visible arc without an extreme U', repaired.readability.normalSag > 0.25 &&
    repaired.readability.normalSag / repaired.readability.chord > 0.079 && repaired.readability.length / repaired.readability.chord < 1.5, repaired);
  await snapshot('repaired-auto');
  const geometryBefore = savedCurves(samples['repaired-auto']);
  for (const zoom of [0.41,0.54,1,1.5,2]) {
    adapter.ed.zoom(zoom); adapter.ed.render.update();
    const assessed = assess(); metrics['zoom-' + zoom] = assessed;
    check('native curves remain curved and unobstructed at reading zoom ' + zoom, assessed.every(flow => flow.feasible && flow.readable &&
      flow.sourceOk && flow.targetOk && !flow.collisions.labels.length && !flow.collisions.bonds.length), assessed);
    check('zoom ' + zoom + ' does not mutate persisted curve geometry', geometryBefore === savedCurves(await k3dAPI.serializeWorkbench()));
  }
  check('repaired editable file reopens', (await k3dAPI.loadWorkbench(samples['repaired-auto'])).ok);
  check('save and reopen retain exact semantic endpoints and persisted bend/mode', geometryBefore === savedCurves(await k3dAPI.serializeWorkbench()) &&
    beforeSemantics === await semantics());
  metrics.reopened = assess();
  check('reopened curves remain readable with valid native endpoints', metrics.reopened.every(flow => flow.feasible && flow.readable && flow.sourceOk && flow.targetOk), metrics.reopened);
  check('manual straight sample reopens', (await k3dAPI.loadWorkbench(samples['manual-straight'])).ok);
  const manual = model.arrow(attackId), manualSaved = savedCurves(await k3dAPI.serializeWorkbench());
  check('ordinary automatic maintenance preserves explicit manual bend zero', controller.replanArrowInPlace(manual, false) === null &&
    manual.geometry.bend === 0 && M.arrowMode(manual) === 'manual' && manualSaved === savedCurves(await k3dAPI.serializeWorkbench()));
  await k3dAPI.loadWorkbench(samples['repaired-auto']); adapter.ed.zoom(1); adapter.ed.render.update();
  return { checks, metrics };
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: [report.service + '/api/agent/model*'] }, (_detail, callback) => {
      report.modelRequests++; callback({ cancel: true });
    });
    const js = code => win.webContents.executeJavaScript(code);
    await win.loadURL(report.service + '/canvas.html');
    for (let attempt = 0; attempt < 400 && !await js('!!window.k3dAPI?.workbenchReady?.()'); attempt++) await new Promise(resolve => setTimeout(resolve, 80));
    await js('k3dAPI.agent.getContext()');
    Object.assign(report, await js('(' + exercise.toString() + ')()'));
    report.ok = report.checks.every(check => check.pass) && report.modelRequests === 0;
    fs.writeFileSync(path.join(OUT, 'canvas-window.png'), (await win.webContents.capturePage()).toPNG());
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error);
    if (win) Object.assign(report, await win.webContents.executeJavaScript('({checks:window.minimumCurveChecks||[],metrics:window.minimumCurveMetrics||{}})').catch(() => ({})));
  } finally {
    if (win) {
      const samples = await win.webContents.executeJavaScript('window.minimumCurveSamples||{}').catch(() => ({}));
      for (const [name, value] of Object.entries(samples)) {
        if (name.endsWith('Png')) fs.writeFileSync(path.join(OUT, name.slice(0,-3) + '.png'), Buffer.from(value.split(',')[1], 'base64'));
        else fs.writeFileSync(path.join(OUT, name + '.molwork'), value);
      }
    }
    write(); console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.pass).length,
      total: report.checks.length, modelRequests: report.modelRequests, error: report.error, failures: report.checks.filter(check => !check.pass) }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
