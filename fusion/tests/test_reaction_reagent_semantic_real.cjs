// Semantic create/modify integration for the user's theophylline + dimethyl
// sulfate layout. Real native structures, glyphs, arrows and history; no model.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-reagent-semantic-real');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-reagent-semantic-'));
app.setPath('userData', profile);
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49075),
  liveRequestLimit: Math.max(1, Math.min(12, Number(process.env.REAL_LIMIT || process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 6)),
  scope: 'semantic reaction-step and actual electron-flow geometry integration; later repeated caffeine structures are geometry fixtures', modelCalls: 0, checks: [] };
const deadline = setTimeout(() => app.exit(2), Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || (process.env.MOLSTUDIO_REAL_AGENT === '1' ? 360_000 : 120_000));

async function exercise() {
  const api = k3dAPI.agent, MW = MolWorkbench, M = MW.model, R = MW.route, { model, controller } = MW.app;
  const checks = window.reagentSemanticChecks = [], samples = window.reagentSemanticSamples = {};
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); if (!pass) throw new Error(name); };
  const scaffold = '[CH3:2][n:3]1[c:4](=[O:5])[c:6]2[N][cH:7][n:8][c:9]2[n:10]([CH3:11])[c:12]1=[O:13]';
  const caffeine = scaffold.replace('[N]', '[n:1]([CH3:14])');
  let run;
  const begin = async id => { if (run) await api.endRun(run); run = id; await api.beginRun(run, { readingOrder: true }); };
  const finish = async () => { if (run) await api.endRun(run); run = null; };
  const apply = ops => api.applyOperations(ops, { runId: run });
  const source = () => k3dAPI.serializeWorkbench();
  const ctx = () => api.getContext();
  await k3dAPI.setMolecule('');
  await begin('semantic-reagent-seed');
  const seed = await apply([
    { id: 'host', type: 'molecule.add', smiles: scaffold.replace('[N]', '[n-:1]'), x: 10, y: 10 },
    { id: 'sulfate', type: 'molecule.add', smiles: '[CH3:1][O:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]', x: 17, y: 10 },
    { id: 'product', type: 'molecule.add', smiles: caffeine, x: 25, y: 10 },
    { id: 'leaving', type: 'molecule.add', smiles: '[O-:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]', x: 31, y: 10 },
  ]);
  let context = await ctx();
  let donor = seed.atomMapping['host:1'];
  const a1 = context.atoms.find(a => a.id === seed.atomMapping['sulfate:1']), a7 = context.atoms.find(a => a.id === seed.atomMapping['sulfate:7']);
  const methylMap = a1.y < a7.y ? 1 : 7, oxygenMap = methylMap === 1 ? 2 : 6;
  let methyl = seed.atomMapping['sulfate:' + methylMap];
  const flows = await apply([
    { id: 'donor-pair', type: 'lonePair.add', atom: donor },
    { id: 'methyl-attack', type: 'arrow.add', source: { type: 'lonePair', id: 'donor-pair' }, target: { type: 'atom', atomId: methyl }, electronCount: 2 },
    { id: 'methyl-leaving', type: 'arrow.add', source: { type: 'bond', atom1: methyl, atom2: seed.atomMapping['sulfate:' + oxygenMap], component: 'sigma' },
      target: { type: 'atom', atomId: seed.atomMapping['sulfate:' + oxygenMap] }, electronCount: 2 },
  ]);
  let attackId = flows.created.find(e => e.id === 'methyl-attack').entityIds[0];
  samples.inputRight = await source();
  const quality = c => {
    const atomIds = id => c.molecules.find(m => m.atoms.includes(id)).atoms;
    const hostIds = atomIds(donor), reagentIds = atomIds(methyl);
    const bounds = ids => { const p = c.atoms.filter(a => ids.includes(a.id)); return { x1: Math.min(...p.map(a => a.x)) - 0.45,
      x2: Math.max(...p.map(a => a.x)) + 0.45, y1: Math.min(...p.map(a => a.y)) - 0.45, y2: Math.max(...p.map(a => a.y)) + 0.45 }; };
    const host = bounds(hostIds), reagent = bounds(reagentIds), flow = model.arrow(attackId);
    if (!flow) return { left: false, feasible: false, missingOriginalArrow: attackId, actualArrowIds: model.state.arrows.map(arrow => arrow.id), host, reagent };
    const geometry = M.arrowGeometry(flow, controller.ctx());
    const length = R.arcLength(geometry.start, geometry.control, geometry.end), chord = M.dist(geometry.start, geometry.end);
    const scene = R.buildScene(controller.ctx(), model); R.addArrowObstacles(scene, model, controller.ctx(), flow.id);
    const fixed = R.planArrow({ a: geometry.routingStart || geometry.start, b: geometry.routingEnd || geometry.end,
      scene, source: flow.source, target: flow.target, electronCount: 2, fixedGeometry: geometry });
    return { left: reagent.x2 < host.x1, host, reagent, length, chord, arcRatio: length / chord, bend: flow.geometry.bend,
      start: geometry.start, control: geometry.control, end: geometry.end, feasible: fixed.feasible,
      labelHits: fixed.ranked[0]?.labelHits, bondHits: fixed.ranked[0]?.bondHits, arrowHits: fixed.ranked[0]?.arrowHits };
  };
  let mainStepId;
  const assertQuality = async name => {
    const c = await ctx(), q = quality(c), current = c.reactionSteps.find(s => s.stepId === mainStepId);
    check(name, q.left && q.length < 5.5 && q.chord < 3.5 && q.arcRatio < 2.5 && q.feasible && !q.arrowHits &&
      current?.checks?.layout?.status === 'passed', { quality: q, step: current });
    return { c, q };
  };
  if (window.reagentSemanticLive) {
    // Import the actual previously accepted right-side regression. New native
    // glyph/readability checks correctly reject creating this bad arrangement;
    // import must still allow the model to repair an existing editable file.
    await finish();
    const loaded = await k3dAPI.loadWorkbench(window.reagentSemanticRegressionSource);
    if (!loaded.ok) throw new Error('Cannot load the saved right-side regression');
    const imported = await ctx();
    donor = imported.atoms.find(atom => atom.label === 'N' && atom.charge === -1)?.id;
    const attack = imported.arrows.find(arrow => (arrow.source.ownerAtomId || arrow.source.atomId) === donor);
    if (!donor || !attack) throw new Error('Saved right-side regression is missing its real attacking nitrogen');
    attackId = attack.id;
    methyl = attack.target.type === 'atom' ? attack.target.atomId : [attack.target.atomA, attack.target.atomB].find(id => id !== donor);
    mainStepId = imported.reactionSteps[0]?.stepId;
    if (imported.reactionSteps.length !== 1 || imported.arrows.length !== 2 || imported.molecules.length !== 4) throw new Error('Saved right-side regression has unexpected entities');
    const before = await ctx(), atomIds = before.atoms.map(a => a.id).sort(), arrowIds = before.arrows.map(a => a.id).sort();
    samples.liveBefore = await source();
    const rt = molstudioAgent.getRuntime(), nativeFetch = rt._fetch, nativeApply = api.applyOperations;
    const operations = [], events = [];
    let requests = 0, budgetExhausted = false;
    const requestLimit = window.reagentSemanticRealLimit || 6;
    const listen = event => {
      const e = event.detail;
      if (!['run_start', 'tool_start', 'tool_end', 'error', 'run_end', 'step_commit', 'usage'].includes(e.type)) return;
      const payload = e.result?.result; events.push({ type: e.type, toolName: e.toolName, isError: e.isError,
      code: e.code, status: e.status, turns: e.turns, usage: e.type === 'run_end' || e.type === 'usage' ? e.usage : undefined,
      finishAccepted: payload?.finishAccepted, finishRejected: payload?.finishRejected,
      stepChecks: payload?.steps?.map(s => ({ action: s.action, stepId: s.stepId, status: s.checks?.layout?.status,
        issues: s.checks?.layout?.issues?.map(i => i.code) })),
      diagnostic: e.diagnostic, message: e.type === 'error' || e.isError ? e.message : undefined }); };
    addEventListener('molstudio:agent-event', listen);
    rt._fetch = async function (url, init) {
      if (url === '/api/agent/model') {
        if (requests >= requestLimit) { budgetExhausted = true; throw new Error('Live reagent integration request budget reached before another upstream request'); }
        requests++;
      }
      return nativeFetch.call(this, url, init);
    };
    api.applyOperations = function (ops, settings) {
      operations.push(...ops.map(op => ({ type: op.type, id: op.id, stepId: op.stepId, expectedVersion: op.expectedVersion,
        lonePairId: op.lonePairId, aim: op.aim, angle: op.angle, arrowId: op.arrowId,
        reactants: op.reactants, products: op.products, source: op.source, target: op.target,
        layout: op.layout ? { ...op.layout } : undefined })));
      return nativeApply.call(this, ops, settings);
    };
    let result;
    try { result = await molstudioAgent.send('把硫酸二甲酯调整到茶碱左边，电子流清楚易读。'); }
    finally {
      rt._fetch = nativeFetch; api.applyOperations = nativeApply; removeEventListener('molstudio:agent-event', listen);
      window.reagentSemanticLiveReport = { requests, requestLimit, budgetExhausted, operations, events, result };
    }
    const after = await ctx(), current = after.reactionSteps.find(s => s.stepId === mainStepId);
    samples.liveAfter = await source();
    window.reagentSemanticLiveReport.qualityAfter = quality(after);
    check('live model updates the original semantic step placement through modify', result?.status === 'completed' && requests > 0 && requests <= requestLimit &&
      operations.some(op => op.type === 'reactionStep.modify' && op.stepId === mainStepId && op.layout?.reagentPlacement === 'left') &&
      current?.layout?.reagentPlacement === 'left' && current.version > 1, { requests, result, operations, step: current });
    check('live placement edit preserves molecules electron-flow identities and one native connector',
      JSON.stringify(after.atoms.map(a => a.id).sort()) === JSON.stringify(atomIds) &&
      JSON.stringify(after.arrows.map(a => a.id).sort()) === JSON.stringify(arrowIds) && after.reactionArrows.length === 1 && after.reactionSteps.length === 1);
    await assertQuality('live final canvas has a readable local left-side attack');
    return { checks, mainStepId, methylMap, modelCalls: requests, live: { requests, requestLimit, operations, events, result } };
  }
  const dockingDiagnostics = window.reagentSemanticDockingDiagnostics = [];
  const originalDock = MW.reactionReagentPlacement.plan;
  MW.reactionReagentPlacement.plan = function (input) {
    const evaluations = [];
    const measured = { ...input, evaluate: candidate => {
      const plans = [], originalPlanFor = controller.planFor;
      controller.planFor = function (...args) {
        const result = originalPlanFor.apply(this, args);
        plans.push({ source: args[0], target: args[1], feasible: result?.plan?.feasible,
          readable: result?.plan?.readable, readability: result?.plan?.readability });
        return result;
      };
      try { const metrics = input.evaluate(candidate); evaluations.push({ side: candidate.side, position: candidate.position, metrics, plans }); return metrics; }
      finally { controller.planFor = originalPlanFor; }
    } };
    const result = originalDock.call(this, measured);
    dockingDiagnostics.push({ host: input.host, reagent: input.reagent, contacts: input.contacts, placement: input.placement,
      evaluations,
      result: { ok: result.ok, preferredSide: result.preferredSide, position: result.position, feasible: result.feasible,
        metrics: result.metrics, candidates: result.candidates, diagnostic: result.diagnostic } });
    return result;
  };
  let created;
  try {
    created = await apply([{ id: 'semantic-methylation', type: 'reactionStep.create', reactants: [donor, methyl],
      products: [seed.atomMapping['product:1'], seed.atomMapping['leaving:2']], layout: { reagentPlacement: 'auto', conditions: 'Δ' } }]);
  } finally { MW.reactionReagentPlacement.plan = originalDock; }
  mainStepId = created.created.find(e => e.id === 'semantic-methylation').stepId;
  await assertQuality('semantic auto create docks sulfate at the left-side N site with a clear local attack');
  samples.auto = await source();
  const snapshot = c => JSON.stringify({ atoms: c.atoms, bonds: c.bonds, arrows: c.arrows, reactionArrows: c.reactionArrows, reactionSteps: c.reactionSteps, texts: c.texts });
  // Inject a docking failure after real native evaluation to exercise diagnostic
  // ownership and atomic rollback independently of whether this clear fixture
  // happens to have an obstructed candidate in a particular native build.
  const beforeFailure = snapshot(await ctx()), failureLedger = JSON.stringify(JSON.parse(await source()).reactionStepOperations || []);
  const nativeHistory = MW.app.adapter.ed.historyPtr;
  let dockingFailure;
  MW.reactionReagentPlacement.plan = function (input) {
    const dock = originalDock.call(this, input), arrow = model.state.arrows.at(-1);
    return { ...dock, feasible: false, metrics: { ...dock.metrics, failures: [{ arrowId: arrow.id,
      code: 'electron_flow_crowding', intermolecular: true, endpointMovesWithReagent: true, obstacleMovesWithReagent: false,
      atomIds: [donor], bondIds: [], reasons: [] }] } };
  };
  try {
    // The existing left-side depiction can now be retained without searching.
    // Request the opposite side to exercise failure in the full docking search.
    await apply([{ id: 'diagnostic-attack', type: 'arrow.add', source: { type: 'lonePair', id: 'donor-pair' },
      target: { type: 'atom', atomId: methyl }, electronCount: 2 },
      { id: 'diagnostic-force-right', type: 'reactionStep.modify', stepId: mainStepId, expectedVersion: 1,
        layout: { reagentPlacement: 'right', conditions: 'diagnostic' } }]);
  } catch (error) { dockingFailure = error; }
  finally { MW.reactionReagentPlacement.plan = originalDock; }
  check('rejected docking identifies the actual failed arrow and its original operation',
    dockingFailure?.code === 'reaction_reagent_layout_failed' &&
    dockingFailure.layoutFailures?.[0]?.operationId === 'diagnostic-attack' &&
    dockingFailure.layoutFailures[0].atomIds[0] === donor && dockingFailure.relatedOperationIds?.includes('diagnostic-attack'),
    { code: dockingFailure?.code, failures: dockingFailure?.layoutFailures });
  check('a rejected docking batch preserves native structures flows step versions ledger and history',
    snapshot(await ctx()) === beforeFailure && MW.app.adapter.ed.historyPtr === nativeHistory &&
    JSON.stringify(JSON.parse(await source()).reactionStepOperations || []) === failureLedger);
  const beforeLeft = snapshot(await ctx());
  await apply([{ id: 'semantic-force-left', type: 'reactionStep.modify', stepId: mainStepId, expectedVersion: 1,
    layout: { reagentPlacement: 'left', conditions: 'left' } }]);
  await assertQuality('semantic modify left keeps the whole reagent to the left without a long U fallback');
  samples.left = await source();
  const afterLeft = snapshot(await ctx());
  await finish();
  k3dAPI.undo();
  check('one undo restores the complete auto docking state', snapshot(await ctx()) === beforeLeft);
  k3dAPI.redo();
  check('one redo restores the complete explicit-left docking state', snapshot(await ctx()) === afterLeft);
  await assertQuality('explicit-left docking remains readable after undo and redo');

  await begin('semantic-reagent-side-mismatch');
  const beforeMismatch = await ctx(), beforeMismatchSnapshot = snapshot(beforeMismatch), beforeMismatchQuality = quality(beforeMismatch);
  const ledgerBeforeMismatch = JSON.stringify(JSON.parse(await source()).reactionStepOperations || []);
  const reagentIds = beforeMismatch.molecules.find(m => m.atoms.includes(methyl)).atoms;
  const movedWrongSide = await apply([{ id: 'semantic-move-reagent-above', type: 'molecule.move', target: { atoms: reagentIds },
    x: (beforeMismatchQuality.host.x1 + beforeMismatchQuality.host.x2) / 2,
    y: beforeMismatchQuality.host.y1 - 0.8 - (beforeMismatchQuality.reagent.y2 - beforeMismatchQuality.reagent.y1) / 2 }]);
  const mismatch = (await ctx()).reactionSteps.find(s => s.stepId === mainStepId);
  check('a direct reagent move off the explicit left side is observed as a semantic placement mismatch', mismatch.version === 2 &&
    mismatch.checks.layout.status === 'failed' && mismatch.checks.layout.issues.some(i => i.code === 'reaction_step_reagent_placement_changed'), { step: mismatch });
  const observed = movedWrongSide.steps?.find(s => s.stepId === mainStepId && s.action === 'observe');
  check('ordinary movement receipts include failed associated-step observations without consuming semantic versions or ledger entries',
    observed?.version === 2 && observed.checks?.layout?.status === 'failed' &&
    observed.checks.layout.issues.some(i => i.code === 'reaction_step_reagent_placement_changed') &&
    JSON.stringify(JSON.parse(await source()).reactionStepOperations || []) === ledgerBeforeMismatch, { observed });
  await finish();
  k3dAPI.undo();
  check('undoing a mismatched direct move restores the persisted left-side layout exactly', snapshot(await ctx()) === beforeMismatchSnapshot);

  await begin('semantic-reagent-global');
  const expanded = [];
  for (let i = 1; i <= 7; i++) expanded.push(
    { id: 'follow-product-' + i, type: 'molecule.add', smiles: caffeine },
    { id: 'follow-step-' + i, type: 'reactionStep.create', reactants: [i === 1 ? seed.atomMapping['product:1'] : 'follow-product-' + (i - 1) + ':1'],
      products: ['follow-product-' + i + ':1'] });
  await apply(expanded);
  const global = await assertQuality('eight-step graph reflow preserves the locally docked attacking pair');
  check('the follow-up really exercised graph routing and kept one original reagent', global.c.reactionSteps.length === 8 &&
    global.c.reactionSteps.every(s => s.layoutStatus.status === 'passed') && global.c.molecules.filter(m => m.atoms.includes(methyl)).length === 1 &&
    JSON.parse(await source()).reactionSteps.some(s => s.flow?.graph), { steps: global.c.reactionSteps });
  samples.graph = await source();
  const beforeReloadIds = global.c.reactionSteps.map(s => [s.stepId, s.version]);
  await finish();
  const loaded = await k3dAPI.loadWorkbench(samples.graph);
  await assertQuality('save and reopen preserve semantic left docking and the compact actual electron curve');
  check('reopened graph retains stable semantic identities and explicit placement', loaded.ok &&
    JSON.stringify((await ctx()).reactionSteps.map(s => [s.stepId, s.version])) === JSON.stringify(beforeReloadIds) &&
    (await ctx()).reactionSteps.find(s => s.stepId === mainStepId)?.layout?.reagentPlacement === 'left');
  await begin('semantic-reagent-reopened-reflow');
  await apply([{ id: 'semantic-left-reflow-again', type: 'reactionStep.modify', stepId: mainStepId, expectedVersion: 2,
    layout: { conditions: 'reflowed' } }]);
  await assertQuality('reflowing the reopened semantic graph does not send the reagent back to the right');
  await apply([{ id: 'semantic-global-tidy', type: 'layout.tidy' }]);
  await assertQuality('global tidy preserves semantic left placement and the readable actual electron curve');
  samples.final = await source();
  await finish();
  return { checks, mainStepId, methylMap };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 250; i++) { if (await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')) break; await new Promise(r => setTimeout(r, 100)); }
    await js('window.reagentSemanticLive=' + (process.env.MOLSTUDIO_REAL_AGENT === '1'));
    if (process.env.MOLSTUDIO_REAL_AGENT === '1') {
      await js('window.reagentSemanticRegressionSource=' + JSON.stringify(fs.readFileSync(path.join(__dirname, 'fixtures/reagent-right-regression.molwork'), 'utf8')));
      report.seed = 'Saved actual right-side regression from model-reagent-final-v2-extended/liveBefore.molwork; imported without rerouting';
    }
    await js('window.reagentSemanticRealLimit=' + report.liveRequestLimit);
    Object.assign(report, await js('(' + exercise.toString() + ')()')); report.ok = true;
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error); report.checks = await js('window.reagentSemanticChecks || []').catch(() => []);
    const live = await js('window.reagentSemanticLiveReport || null').catch(() => null);
    if (live) { report.live = live; report.modelCalls = live.requests; }
  }
  finally {
    report.dockingDiagnostics = await js('window.reagentSemanticDockingDiagnostics || []').catch(() => []);
    const samples = await js('window.reagentSemanticSamples || {}').catch(() => ({}));
    for (const [name, saved] of Object.entries(samples)) {
      fs.writeFileSync(path.join(out, name + '.molwork'), saved);
      await js('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')');
      const exported = await js('k3dAPI.exportMechanismImage("png")');
      if (exported.ok) fs.writeFileSync(path.join(out, 'canvas-source-' + name + '.png'), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length, total: report.checks.length,
      failures: report.checks.filter(c => !c.pass), error: report.error, out }, null, 2));
    clearTimeout(deadline); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
