// Current canvas + local chemical service, real Ketcher history, no model calls.
// MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_reaction_late_flow_real.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-reaction-late-flow');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-late-flow-'));
app.setPath('userData', profile);
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49075),
  fixture: 'delayed SN2 methylation flow and saved real-model caffeine canvas; geometry and lifecycle, not a chemistry verdict',
  modelCalls: 0, checks: [] };
const deadline = setTimeout(() => app.exit(2), 120_000);

async function exercise(fixture) {
  const api = k3dAPI.agent, MW = MolWorkbench, M = MW.model, R = MW.route;
  const { model, controller, adapter } = MW.app, ed = adapter.ed;
  const checks = window.lateFlowChecks = [], samples = window.lateFlowSamples = {};
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) throw new Error(name); };
  const ctx = () => api.getContext(), source = () => k3dAPI.serializeWorkbench();
  const canon = v => JSON.stringify(v);
  const snapshot = c => canon({ atoms: c.atoms, bonds: c.bonds, lonePairs: c.lonePairs, arrows: c.arrows,
    reactionSteps: c.reactionSteps, reactionArrows: c.reactionArrows, texts: c.texts });
  const byId = (c, id) => c.reactionSteps.find(s => s.stepId === id);
  const scaffold = '[CH3:2][n:3]1[c:4](=[O:5])[c:6]2[N][cH:7][n:8][c:9]2[n:10]([CH3:11])[c:12]1=[O:13]';
  const caffeine = scaffold.replace('[N]', '[n:1]([CH3:14])');
  await k3dAPI.setMolecule(''); ed.clearHistory();
  await api.beginRun('late-flow', { readingOrder: true });
  const seed = await api.applyOperations([
    { id: 'host', type: 'molecule.add', smiles: scaffold.replace('[N]', '[n-:1]'), x: 10, y: 10 },
    { id: 'sulfate', type: 'molecule.add', smiles: '[CH3:1][O:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]', x: 17, y: 10 },
    { id: 'product', type: 'molecule.add', smiles: caffeine, x: 25, y: 10 },
    { id: 'leaving', type: 'molecule.add', smiles: '[O-:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]', x: 31, y: 10 },
  ], { runId: 'late-flow' });
  const donor = seed.atomMapping['host:1'];
  let c = await ctx();
  const a1 = c.atoms.find(a => a.id === seed.atomMapping['sulfate:1']);
  const a7 = c.atoms.find(a => a.id === seed.atomMapping['sulfate:7']);
  const methylMap = a1.y < a7.y ? 1 : 7, oxygenMap = methylMap === 1 ? 2 : 6;
  const methyl = seed.atomMapping['sulfate:' + methylMap], oxygen = seed.atomMapping['sulfate:' + oxygenMap];
  const created = await api.applyOperations([{ id: 'early-step', type: 'reactionStep.create', reactants: [donor, methyl],
    products: [seed.atomMapping['product:1'], seed.atomMapping['leaving:2']], layout: { reagentPlacement: 'auto' } }], { runId: 'late-flow' });
  const stepId = created.created.find(item => item.id === 'early-step').stepId;
  c = await ctx();
  const before = snapshot(c), oldVersion = byId(c, stepId).version, historyBefore = ed.historySize().undo;
  const positions = c.atoms.map(a => [a.id, a.x, a.y]);
  const late = await api.applyOperations([
    { id: 'late-pair', type: 'lonePair.add', atom: donor },
    { id: 'late-attack', type: 'arrow.add', source: { type: 'lonePair', id: 'late-pair' }, target: { type: 'atom', atomId: methyl }, electronCount: 2 },
    { id: 'late-leaving', type: 'arrow.add', source: { type: 'bond', atom1: methyl, atom2: oxygen, component: 'sigma' },
      target: { type: 'atom', atomId: oxygen }, electronCount: 2 },
  ], { runId: 'late-flow' });
  c = await ctx();
  const pairId = late.created.find(x => x.id === 'late-pair').entityIds[0];
  const attackId = late.created.find(x => x.id === 'late-attack').entityIds[0];
  const leaveId = late.created.find(x => x.id === 'late-leaving').entityIds[0];
  const flow = model.arrow(attackId), native = controller.ctx(), geom = M.arrowGeometry(flow, native), scene = R.buildScene(native, model);
  const quality = { length: R.arcLength(geom.start, geom.control, geom.end), chord: M.dist(geom.start, geom.end), unit: scene.L };
  const observed = late.steps?.find(s => s.action === 'observe' && s.stepId === stepId);
  const autoPair = model.lonePair(pairId);
  check('default attack pair binds to its actual target atom', autoPair?.refAtomId === methyl && Number.isFinite(autoPair.angleRel),
    { pair: autoPair, methyl });
  const molBounds = atomId => {
    const ids = c.molecules.find(m => m.atoms.includes(atomId)).atoms, pts = c.atoms.filter(a => ids.includes(a.id));
    return { x1: Math.min(...pts.map(a => a.x)), x2: Math.max(...pts.map(a => a.x)) };
  };
  check('automatic docking stays on the exposed left side without relaxing curve limit',
    molBounds(methyl).x2 < molBounds(donor).x1 && quality.length <= 5.7 * quality.unit, { quality, host: molBounds(donor), reagent: molBounds(methyl) });
  check('later electron flow re-docks real reactants at the attack site with a readable curve',
    canon(positions) !== canon(c.atoms.map(a => [a.id, a.x, a.y])) && quality.length <= 5.7 * quality.unit &&
    byId(c, stepId)?.checks?.layout?.status === 'passed', { quality, step: byId(c, stepId) });
  check('later flow reports the existing step as observed at the same version', observed?.version === oldVersion &&
    byId(c, stepId)?.version === oldVersion && observed.checks.layout.status === 'passed', { observed });
  check('both late flows are actually inspected', [attackId, leaveId].every(id => byId(c, stepId).checks.layout.checkedArrowIds?.includes(id)),
    { checked: byId(c, stepId).checks.layout.checkedArrowIds, attackId, leaveId });
  const after = snapshot(c); samples.lateAfter = await source();
  check('adding flow and re-docking is one native history entry', ed.historySize().undo === historyBefore + 1,
    { before: historyBefore, after: ed.historySize().undo });
  await api.endRun('late-flow');
  k3dAPI.undo();
  check('one undo removes late flow and restores prior positions and step', snapshot(await ctx()) === before);
  k3dAPI.redo();
  check('one redo restores flow, coordinates and unchanged step version', snapshot(await ctx()) === after);

  const readPair = () => model.lonePair(pairId);
  const pairAngle = () => M.lonePairAngle(readPair(), controller.ctx());
  const angleDifference = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const afterReload = await k3dAPI.loadWorkbench(samples.lateAfter);
  check('saving and reopening preserve automatic target binding and angle', afterReload.ok && readPair()?.refAtomId === methyl &&
    Number.isFinite(readPair().angleRel), { pair: readPair() });
  // Exercise the real selected-handle pointer path, including document pointercancel.
  const modelClient = p => {
    const user = adapter.modelToUser(p), matrix = adapter.canvasSvg().getScreenCTM();
    return { x: matrix.a * user.x + matrix.c * user.y + matrix.e, y: matrix.b * user.x + matrix.d * user.y + matrix.f };
  };
  const eventFor = p => { const client = modelClient(p); return { button: 0, clientX: client.x, clientY: client.y,
    target: adapter.canvasSvg(), altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} }; };
  const dragStart = () => {
    controller.setTool('select'); controller.selection.clear(); controller.selection.add(pairId); controller.render();
    const point = M.lonePairPosition(readPair(), controller.ctx());
    controller.onPointerDown(eventFor(point));
    return controller.drag?.kind === 'lp-move';
  };
  const moveHandle45 = () => { const owner = controller.ctx().atomPos(donor);
    controller.onPointerMove(eventFor({ x: owner.x + 1, y: owner.y + 1 })); };
  const originalGuiPair = { ...readPair() }, originalGuiAngle = pairAngle(), beforeCancelUndo = ed.historySize().undo;
  check('actual pointer down selects the automatic lone-pair handle', dragStart(), { drag: controller.drag?.kind });
  moveHandle45();
  check('drag preview releases the remote target reference', readPair().refAtomId !== methyl, { pair: readPair() });
  controller.doc.dispatchEvent(new controller.win.PointerEvent('pointercancel', { bubbles: true }));
  check('pointercancel restores automatic reference, direction and history', !controller.drag && readPair().refAtomId === methyl &&
    Math.abs(readPair().angleRel - originalGuiPair.angleRel) < 1e-8 && angleDifference(pairAngle(), originalGuiAngle) < 1e-8 &&
    ed.historySize().undo === beforeCancelUndo, { pair: readPair() });
  check('second real pointer gesture reaches lone-pair handle', dragStart());
  moveHandle45();
  const ownerForUp = controller.ctx().atomPos(donor);
  controller.onPointerUp(eventFor({ x: ownerForUp.x + 1, y: ownerForUp.y + 1 }));
  const guiAngle = pairAngle(), guiPair = { ...readPair() };
  const directNeighbors = adapter.chemSnapshot().atoms.find(a => a.uuid === donor)?.neighbors?.map(a => a.uuid) || [];
  check('GUI drag to 45 degrees uses a local neighbor or free angle, never the remote reagent',
    !controller.drag && readPair().refAtomId !== methyl && (!readPair().refAtomId || directNeighbors.includes(readPair().refAtomId)) &&
    angleDifference(guiAngle, Math.PI / 4) < 1e-5 && ed.historySize().undo === beforeCancelUndo + 1,
    { pair: readPair(), directNeighbors, guiAngle });
  k3dAPI.undo();
  check('undo GUI drag restores automatic target reference', readPair().refAtomId === methyl &&
    angleDifference(pairAngle(), originalGuiAngle) < 1e-5, { pair: readPair() });
  k3dAPI.redo();
  check('redo GUI drag restores local reference and 45-degree direction', readPair().refAtomId === guiPair.refAtomId &&
    angleDifference(pairAngle(), guiAngle) < 1e-5, { pair: readPair() });
  await api.beginRun('gui-drag-target-move');
  await api.applyOperations([{ id: 'move-target-after-gui-drag', type: 'molecule.move', target: { atoms: [methyl] }, dx: 0, dy: 2 }],
    { runId: 'gui-drag-target-move' });
  await api.endRun('gui-drag-target-move');
  check('moving reagent after GUI drag leaves the manually chosen direction fixed', readPair().refAtomId !== methyl &&
    angleDifference(pairAngle(), guiAngle) < 1e-5, { pair: readPair(), angle: pairAngle(), guiAngle });
  samples.guiManualMoved = await source();
  const guiReopened = await k3dAPI.loadWorkbench(samples.guiManualMoved);
  check('GUI-dragged direction and local reference survive save and reopen', guiReopened.ok && readPair().refAtomId === guiPair.refAtomId &&
    angleDifference(pairAngle(), guiAngle) < 1e-5, { pair: readPair() });
  const resetAuto = await k3dAPI.loadWorkbench(samples.lateAfter);
  check('reload restores automatic scenario for remaining checks', resetAuto.ok && readPair().refAtomId === methyl);
  const angleBeforeMove = pairAngle(), pairBeforeMove = { ...readPair() };
  await api.beginRun('move-target');
  await api.applyOperations([{ id: 'move-reactive-target', type: 'molecule.move', target: { atoms: [methyl] }, dx: 0, dy: 2 }], { runId: 'move-target' });
  await api.endRun('move-target');
  const angleAfterMove = pairAngle();
  check('automatic pair follows the moved target without changing its relative angle', readPair().refAtomId === methyl &&
    Math.abs(readPair().angleRel - pairBeforeMove.angleRel) < 1e-5 && angleDifference(angleAfterMove, angleBeforeMove) > 0.05,
    { before: angleBeforeMove, after: angleAfterMove, pair: readPair() });
  k3dAPI.undo();
  check('undo target move returns the automatic pair direction', angleDifference(pairAngle(), angleBeforeMove) < 1e-5 && readPair().refAtomId === methyl);
  k3dAPI.redo();
  check('redo target move restores the following direction', angleDifference(pairAngle(), angleAfterMove) < 1e-5 && readPair().refAtomId === methyl);
  samples.autoMoved = await source();
  const reopenedMoved = await k3dAPI.loadWorkbench(samples.autoMoved);
  check('reopened moved target retains the same followed direction', reopenedMoved.ok && readPair().refAtomId === methyl &&
    angleDifference(pairAngle(), angleAfterMove) < 1e-5, { pair: readPair(), angle: pairAngle(), expected: angleAfterMove });
  await api.beginRun('manual-pair');
  await api.applyOperations([{ id: 'manual-angle', type: 'lonePair.modify', lonePairId: pairId, angle: 37 }], { runId: 'manual-pair' });
  await api.endRun('manual-pair');
  check('explicit angle clears automatic reference and establishes manual direction', readPair().origin === 'manual' &&
    readPair().refAtomId === null && readPair().angleRel === null && angleDifference(pairAngle(), 37 * Math.PI / 180) < 1e-7, { pair: readPair() });
  k3dAPI.undo();
  check('undo explicit angle restores automatic target binding', readPair().refAtomId === methyl && angleDifference(pairAngle(), angleAfterMove) < 1e-5, { pair: readPair() });
  k3dAPI.redo();
  check('redo explicit angle restores unbound manual direction', readPair().origin === 'manual' && readPair().refAtomId === null &&
    readPair().angleRel === null && angleDifference(pairAngle(), 37 * Math.PI / 180) < 1e-7, { pair: readPair() });
  await api.beginRun('move-manual-target');
  await api.applyOperations([{ id: 'move-reactive-target-again', type: 'molecule.move', target: { atoms: [methyl] }, dx: 1, dy: -2 }], { runId: 'move-manual-target' });
  await api.endRun('move-manual-target');
  check('moving target again leaves explicit manual pair angle fixed', readPair().refAtomId === null && readPair().angleRel === null &&
    angleDifference(pairAngle(), 37 * Math.PI / 180) < 1e-7, { pair: readPair() });
  samples.manualMoved = await source();
  const reopenedManual = await k3dAPI.loadWorkbench(samples.manualMoved);
  check('manual angle and absent reference survive saving and reopening', reopenedManual.ok && readPair().origin === 'manual' &&
    readPair().refAtomId === null && readPair().angleRel === null && angleDifference(pairAngle(), 37 * Math.PI / 180) < 1e-7, { pair: readPair() });

  const loaded = await k3dAPI.loadWorkbench(fixture);
  check('saved real-model caffeine canvas loads', loaded.ok, { loaded });
  c = await ctx(); samples.caffeineBefore = await source();
  check('fixture has four steps and eight electron flows', c.reactionSteps.length === 4 && c.arrows.length === 8,
    { steps: c.reactionSteps.length, arrows: c.arrows.length });
  const bad = c.reactionSteps.find(s => s.checks?.layout?.issues?.some(issue => issue.code === 'reaction_step_electron_unreadable'));
  const issue = bad?.checks.layout.issues.find(i => i.code === 'reaction_step_electron_unreadable');
  const badFlow = issue && model.arrow(issue.arrowId), badGeom = badFlow && M.arrowGeometry(badFlow, controller.ctx());
  const badScene = R.buildScene(controller.ctx(), model);
  const badLength = badGeom && R.arcLength(badGeom.start, badGeom.control, badGeom.end);
  check('saved long cross-skeleton electron curve fails actual geometry checking', bad?.checks.layout.status === 'failed' &&
    Number.isFinite(badLength) && badLength > 5.7 * badScene.L, { issue, badLength, unit: badScene.L, stepId: bad?.stepId });
  const identities = v => ({ atoms: v.atoms.map(a => a.id).sort(), bonds: v.bonds.map(b => b.id).sort(),
    steps: v.reactionSteps.map(s => s.stepId).sort(), arrows: v.arrows.map(a => ({ id: a.id, source: a.source, target: a.target, electronCount: a.electronCount })).sort((a, b) => a.id.localeCompare(b.id)) });
  const original = identities(c);
  await api.beginRun('repair-caffeine', { readingOrder: true });
  const repaired = await api.applyOperations([{ id: 'repair-long-curve', type: 'reactionStep.modify', stepId: bad.stepId,
    expectedVersion: bad.version, layout: { reagentPlacement: 'auto' } }], { runId: 'repair-caffeine' });
  c = await ctx(); samples.caffeineAfter = await source();
  check('repair retains all molecule, bond, electron-flow and step identities', canon(identities(c)) === canon(original),
    { repaired: repaired.steps });
  check('repair re-docks the original step and passes layout', byId(c, bad.stepId)?.version === bad.version + 1 &&
    byId(c, bad.stepId)?.layout?.reagentPlacement === 'auto' && byId(c, bad.stepId)?.checks?.layout?.status === 'passed',
    { step: byId(c, bad.stepId) });
  const flowMembership = (step, arrow) => {
    const side = new Set(c.molecules.filter(m => m.atoms.some(id => step.reactants.includes(id))).flatMap(m => m.atoms));
    const endpoint = ep => ep.type === 'bond' ? (() => { const b = c.bonds.find(bond => bond.id === ep.bondId); return b ? [b.begin, b.end] : []; })()
      : ep.type === 'lonePair' ? [ep.ownerAtomId] : ep.type === 'atom' ? [ep.atomId] : ep.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
    const ids = [...endpoint(arrow.source), ...endpoint(arrow.target)];
    return ids.length > 0 && ids.every(id => side.has(id));
  };
  const coverage = c.reactionSteps.map(step => ({ stepId: step.stepId,
    expected: c.arrows.filter(arrow => flowMembership(step, arrow)).map(arrow => arrow.id).sort(),
    checked: (step.checks.layout.checkedArrowIds || []).slice().sort(), status: step.checks.layout.status }));
  check('each of four steps inspects its two actual electron flows including bond sources', coverage.length === 4 &&
    coverage.every(item => item.expected.length === 2 && canon(item.checked) === canon(item.expected)), { coverage });
  await api.endRun('repair-caffeine');
  return { checks, quality, badLength, badUnit: badScene.L, coverage };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 250; i++) { if (await js('!!window.k3dAPI?.workbenchReady?.()')) break; await new Promise(r => setTimeout(r, 100)); }
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/late-caffeine-layout.molwork'), 'utf8');
    Object.assign(report, await js('(' + exercise.toString() + ')(' + JSON.stringify(fixture) + ')')); report.ok = true;
  } catch (error) { report.ok = false; report.error = String(error.stack || error); report.checks = await js('window.lateFlowChecks || []').catch(() => []); }
  finally {
    const samples = await js('window.lateFlowSamples || {}').catch(() => ({}));
    for (const [name, saved] of Object.entries(samples)) {
      fs.writeFileSync(path.join(out, name + '.molwork'), saved);
      await js('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')').catch(() => {});
      const image = await js('k3dAPI.exportMechanismImage("png")').catch(() => null);
      if (image?.ok) fs.writeFileSync(path.join(out, 'canvas-source-' + name + '.png'), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length, total: report.checks.length,
      failures: report.checks.filter(c => !c.pass), error: report.error }, null, 2));
    clearTimeout(deadline); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
