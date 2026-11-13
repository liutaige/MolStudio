// Real current-canvas geometry, native glyph boxes and RDKit structures; no AI.
// The chemical pair reproduces the user's local layout complaint. It does not
// claim that a geometric pass proves the complete reaction chemistry.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-reagent-placement-real');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-reagent-placement-'));
app.setPath('userData', profile);
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', build: 'current source checkout, isolated Electron window',
  case: 'theophylline N anion attacks upper methyl of dimethyl sulfate; reagent translated left', modelCalls: 0, checks: [] };
const deadline = setTimeout(() => app.exit(2), 90_000);

async function exercise() {
  const api = k3dAPI.agent, MW = MolWorkbench, { adapter, model, controller } = MW.app, M = MW.model, R = MW.route;
  const checks = window.reagentPlacementChecks = [], samples = window.reagentPlacementSamples = {};
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) throw new Error(name); };
  const scaffold = '[CH3:2][n:3]1[c:4](=[O:5])[c:6]2[n-:1][cH:7][n:8][c:9]2[n:10]([CH3:11])[c:12]1=[O:13]';
  await k3dAPI.setMolecule('');
  await api.beginRun('reagent-fixture');
  const seed = await api.applyOperations([
    { id: 'host', type: 'molecule.add', smiles: scaffold, x: 10, y: 10 },
    { id: 'sulfate', type: 'molecule.add', smiles: '[CH3:1][O:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]', x: 17, y: 10 },
  ], { runId: 'reagent-fixture' });
  let context = await api.getContext();
  const atom = id => context.atoms.find(a => a.id === id);
  const donor = seed.atomMapping['host:1'];
  const methylMap = atom(seed.atomMapping['sulfate:1']).y < atom(seed.atomMapping['sulfate:7']).y ? 1 : 7;
  const methyl = seed.atomMapping['sulfate:' + methylMap], oxygenMap = methylMap === 1 ? 2 : 6;
  const drawn = await api.applyOperations([
    { id: 'n-lone-pair', type: 'lonePair.add', atom: donor },
    { id: 'attack', type: 'arrow.add', source: { type: 'lonePair', id: 'n-lone-pair' }, target: { type: 'atom', atomId: methyl }, electronCount: 2 },
    { id: 'leaving', type: 'arrow.add', source: { type: 'bond', atom1: methyl, atom2: seed.atomMapping['sulfate:' + oxygenMap], component: 'sigma' },
      target: { type: 'atom', atomId: seed.atomMapping['sulfate:' + oxygenMap] }, electronCount: 2 },
  ], { runId: 'reagent-fixture' });
  context = await api.getContext();
  const attackId = drawn.created.find(e => e.id === 'attack').entityIds[0];
  const leavingId = drawn.created.find(e => e.id === 'leaving').entityIds[0];
  const hostAtoms = context.molecules.find(m => m.atoms.includes(donor)).atoms;
  const reagentAtoms = context.molecules.find(m => m.atoms.includes(methyl)).atoms, moving = new Set(reagentAtoms);
  const dimensions = ids => {
    const pts = context.atoms.filter(a => ids.includes(a.id));
    const x1 = Math.min(...pts.map(a => a.x)) - 0.45, x2 = Math.max(...pts.map(a => a.x)) + 0.45;
    const y1 = Math.min(...pts.map(a => a.y)) - 0.45, y2 = Math.max(...pts.map(a => a.y)) + 0.45;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, width: x2 - x1, height: y2 - y1 };
  };
  const beforeHost = context.atoms.filter(a => hostAtoms.includes(a.id)).map(a => ({ id: a.id, x: a.x, y: a.y }));
  const reagentVectors = () => context.bonds.filter(b => moving.has(b.begin) && moving.has(b.end)).map(b => ({
    id: b.id, type: b.type, dx: atom(b.end).x - atom(b.begin).x, dy: atom(b.end).y - atom(b.begin).y,
  }));
  const oldVectors = reagentVectors();
  const actualMetrics = () => {
    const flow = model.arrow(attackId), geo = M.arrowGeometry(flow, controller.ctx());
    const chord = M.dist(geo.start, geo.end), length = R.arcLength(geo.start, geo.control, geo.end);
    return { chord, length, arcRatio: length / chord, bend: flow.geometry.bend, start: geo.start, control: geo.control, end: geo.end };
  };
  const before = actualMetrics();
  samples.before = await k3dAPI.serializeWorkbench();
  const realCtx = controller.ctx(), flows = [model.arrow(leavingId), model.arrow(attackId)];
  const shiftPoint = (p, id, d) => moving.has(id) ? { x: p.x + d.dx, y: p.y + d.dy } : { ...p };
  const evaluator = candidate => {
    const d = candidate.translation;
    const translateRect = (r, id) => !r || !moving.has(id) ? r : { x1: r.x1 + d.dx, x2: r.x2 + d.dx, y1: r.y1 + d.dy, y2: r.y2 + d.dy };
    const bond = b => !b ? b : { ...b, begin: shiftPoint(b.begin, b.beginAtom, d), end: shiftPoint(b.end, b.endAtom, d) };
    const ctx = { ...realCtx, atomPos: id => { const p = realCtx.atomPos(id); return p && shiftPoint(p, id, d); },
      atoms: () => realCtx.atoms().map(a => ({ ...a, pos: shiftPoint(a.pos, a.uuid, d) })),
      bonds: () => realCtx.bonds().map(bond), bondInfo: id => bond(realCtx.bondInfo(id)),
      atomLabelBox: id => { const b = realCtx.atomLabelBox(id); return b && { ...b, rect: translateRect(b.rect, id), atomRect: translateRect(b.atomRect, id),
        hydrogenRects: b.hydrogenRects?.map(r => translateRect(r, id)) }; } };
    const scene = R.buildScene(ctx, model);
    let length = 0, chord = 0, maxBend = 0, arcRatio = 1, labelHits = 0, bondHits = 0, arrowHits = 0, feasible = true;
    for (const flow of flows) {
      const result = controller.planFor(flow.source, flow.target, flow.electronCount, { ctx, scene, preferClearArrows: true });
      if (!result?.plan?.ranked?.length) return { feasible: false, labelHits: 100, bondHits: 100 };
      const plan = result.plan, geometry = M.arrowGeometry({ ...flow, geometry: { bend: plan.bend } }, ctx);
      const l = R.arcLength(geometry.start, geometry.control, geometry.end), c = M.dist(geometry.start, geometry.end);
      length += l; chord += c; maxBend = Math.max(maxBend, Math.abs(plan.bend)); arcRatio = Math.max(arcRatio, l / c);
      labelHits += plan.ranked[0].labelHits; bondHits += plan.ranked[0].bondHits; arrowHits += plan.ranked[0].arrowHits;
      feasible = feasible && plan.feasible;
      scene.arrows.push({ id: flow.id, points: R.sampleCurve(geometry.start, geometry.control, geometry.end, 0.1, 16, 80).points, length: l });
    }
    return { feasible, length, chord, maxBend, arcRatio, labelHits, bondHits, arrowHits };
  };
  const input = { host: { id: 'host', ...dimensions(hostAtoms) }, reagent: { id: 'sulfate', ...dimensions(reagentAtoms) },
    contacts: [{ host: { x: atom(donor).x, y: atom(donor).y }, reagent: { x: atom(methyl).x, y: atom(methyl).y } }],
    placement: 'left', evaluate: evaluator };
  const dock = MW.reactionReagentPlacement.plan(input);
  check('translation candidate is scored against native glyphs bonds and both electron flows', dock.ok && dock.feasible &&
    dock.metrics.labelHits === 0 && dock.metrics.bondHits === 0 && dock.metrics.arrowHits === 0, { dock });
  await api.applyOperations([
    { id: 'move-sulfate-left', type: 'molecule.move', target: { atoms: reagentAtoms }, dx: dock.translation.dx, dy: dock.translation.dy },
    { id: 'replan-local-break', type: 'arrow.modify', arrowId: leavingId, mode: 'auto' },
    { id: 'replan-local-attack', type: 'arrow.modify', arrowId: attackId, mode: 'auto' },
  ], { runId: 'reagent-fixture' });
  context = await api.getContext();
  const after = actualMetrics(), hostBounds = dimensions(hostAtoms), reagentBounds = dimensions(reagentAtoms);
  check('the real dimethyl sulfate is entirely left of the fixed theophylline skeleton',
    reagentBounds.x + reagentBounds.width / 2 < hostBounds.x - hostBounds.width / 2 &&
    JSON.stringify(context.atoms.filter(a => hostAtoms.includes(a.id)).map(a => ({ id: a.id, x: a.x, y: a.y }))) === JSON.stringify(beforeHost), { hostBounds, reagentBounds });
  check('translation preserves every reagent bond vector and its native bond type',
    reagentVectors().every((v, i) => v.id === oldVectors[i].id && v.type === oldVectors[i].type && Math.abs(v.dx - oldVectors[i].dx) < 1e-7 && Math.abs(v.dy - oldVectors[i].dy) < 1e-7));
  check('the real final attack is local rather than a giant U around both molecules',
    after.length < before.length * 0.7 && after.length < 5.5 && after.chord < 3.5 && after.arcRatio < 2.5, { before, after, chosen: dock.metrics });
  samples.after = await k3dAPI.serializeWorkbench();
  await api.endRun('reagent-fixture');
  return { checks, before, after, dock, methylMap };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL('http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49075) + '/canvas.html');
    for (let i = 0; i < 250; i++) { if (await js('!!window.k3dAPI?.workbenchReady?.()')) break; await new Promise(r => setTimeout(r, 100)); }
    await js(fs.readFileSync(path.join(__dirname, '../workbench/reaction-reagent-placement.js'), 'utf8'));
    Object.assign(report, await js('(' + exercise.toString() + ')()')); report.ok = true;
  } catch (error) { report.ok = false; report.error = String(error.stack || error); report.checks = await js('window.reagentPlacementChecks || []').catch(() => []); }
  finally {
    const samples = await js('window.reagentPlacementSamples || {}').catch(() => ({}));
    for (const [name, saved] of Object.entries(samples)) {
      fs.writeFileSync(path.join(out, name + '.molwork'), saved);
      await js('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')');
      const image = await js('k3dAPI.exportMechanismImage("png")');
      if (image.ok) fs.writeFileSync(path.join(out, 'canvas-source-' + name + '.png'), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length, total: report.checks.length,
      failures: report.checks.filter(c => !c.pass), before: report.before, after: report.after, error: report.error }, null, 2));
    clearTimeout(deadline); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
