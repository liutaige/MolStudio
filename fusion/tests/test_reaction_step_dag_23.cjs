// Actual canvas/native engine fixture replay; no model requests.
// These are geometry/data motifs, not the historical industrial caffeine route.
// MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_dag_23.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { longDag23, forkJoin } = require('./fixtures/reaction_step_dag_23.cjs');
const { canonical, endpointAtoms, moleculeIndex, inspectGraph, semanticSnapshot } = require('./agent_long_route_audit.cjs');

const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-dag-23');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-dag-23-'));
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', profile);
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', build: process.env.MOLSTUDIO_TEST_BUILD || 'current served resources',
  service: 'http://127.0.0.1:' + (Number(process.env.MOLSTUDIO_PORT) || 49075),
  scope: 'Deterministic geometry/data DAG replay using real structures and endpoint bindings. This is not industrial caffeine chemistry acceptance.',
  realModelRequests: 0, cases: [], browserErrors: [] };
const write = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
let win;
const watchdog = setTimeout(() => { report.ok = false; report.timedOut = true; write(); win?.destroy(); app.exit(2); },
  Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 240_000);
const geometry = context => {
  const anchor = [...context.atoms].sort((a, b) => a.id.localeCompare(b.id))[0] || { x: 0, y: 0 };
  const point = p => ({ x: Math.round((p.x - anchor.x) * 100000) / 100000, y: Math.round((p.y - anchor.y) * 100000) / 100000 });
  return canonical({ atoms: context.atoms.map(atom => ({ id: atom.id, ...point(atom) })).sort((a, b) => a.id.localeCompare(b.id)),
    arrows: context.reactionArrows.map(arrow => ({ stepId: arrow.stepId, start: point(arrow.start), end: point(arrow.end) })).sort((a, b) => a.stepId.localeCompare(b.stepId)),
    ports: context.reactionSteps.flatMap(step => (step.ports || []).map(port => ({ stepId: step.stepId,
      token: port.token, side: port.side, at: port.at, position: port.position ? point(port.position) : null })))
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
  });
};

async function replay(fixture) {
  const api = k3dAPI.agent, ed = MolWorkbench.app.adapter.ed;
  window.molstudioAgent?.getRuntime?.()?.reset();
  await k3dAPI.setMolecule(''); ed.clearHistory();
  const runId = 'fixture-' + fixture.name + '-' + crypto.randomUUID();
  await api.beginRun(runId, { readingOrder: true, separatePaths: true });
  await api.setTaskCheckpoint(runId, { version: 1, taskId: runId + '-checkpoint', mode: 'phased',
    goal: 'Synthetic native graph fixture: ' + fixture.name, status: 'active', phaseIndex: 0, requestIndex: 0,
    phases: [{ id: 'native-fixture', objective: 'Replay the declared native graph', kind: 'draw', status: 'active', operationIds: [] }],
    completedOperationIds: [], checks: { status: 'pending', issues: [] }, updatedAt: 1 });
  const state = window.__dagFixture = { completedBatches: 0, receipts: [], stepMapping: {}, atomMapping: {}, entityMapping: {}, beforeLast: null };
  try {
    for (let index = 0; index < fixture.batches.length; index++) {
      if (index === fixture.batches.length - 1) state.beforeLast = { context: await api.getContext(), source: await k3dAPI.serializeWorkbench() };
      state.activeBatch = fixture.batches[index].id;
      if (fixture.batches[index].id === 'prepare-02') {
        const before = await k3dAPI.serializeWorkbench(), undo = ed.historySize().undo;
        state.beforeFallback = { context: await api.getContext(), source: before };
        const planner = MolWorkbench.reactionGraphLayout, originalPlan = planner.plan;
        let plans = 0, failure;
        planner.plan = function(input) { plans++; return originalPlan.call(this, input); };
        try {
          await api.applyOperations(fixture.batches[index].operations, { runId, validateMechanism() {
            throw Object.assign(new Error('Intentional rejection after native graph planning'), { code: 'fixture_after_graph_plan' });
          } });
        } catch (error) { failure = error.code; }
        finally { planner.plan = originalPlan; }
        state.fallbackRollback = { failure, plans, sourceUnchanged: before === await k3dAPI.serializeWorkbench(),
          undoUnchanged: ed.historySize().undo === undo };
        if (failure !== 'fixture_after_graph_plan' || plans < 2 || !state.fallbackRollback.sourceUnchanged || !state.fallbackRollback.undoUnchanged) {
          throw new Error('Short-chain DAG fallback did not roll back atomically after validation rejected it');
        }
      }
      const receipt = await api.applyOperations(fixture.batches[index].operations, { runId });
      state.receipts.push({ created: receipt.created, updated: receipt.updated, steps: receipt.steps, warnings: receipt.warnings });
      Object.assign(state.stepMapping, receipt.stepMapping); Object.assign(state.atomMapping, receipt.atomMapping);
      for (const entry of receipt.created) if (entry.entityIds?.length === 1) state.entityMapping[entry.id] = entry.entityIds[0];
      state.completedBatches++;
      console.info('MOLSTUDIO_DAG_PROGRESS ' + JSON.stringify({ fixture: fixture.name, activeBatch: state.activeBatch, completedBatches: state.completedBatches }));
    }
  } finally { await api.endRun(runId); }
  return { ...state, context: await api.getContext(), source: await k3dAPI.serializeWorkbench(), undo: ed.historySize().undo };
}

function observeFixtureCurves(context) {
  const MW = MolWorkbench, { controller, model } = MW.app, ctx = controller.ctx(), scene = MW.route.buildScene(ctx, model);
  const owners = new Map(), bonds = new Map(context.bonds.map(bond => [bond.id, bond]));
  for (const molecule of context.molecules) for (const id of molecule.atoms) owners.set(id, molecule.id);
  const endpoint = ep => ep.type === 'bond' ? (() => { const bond = bonds.get(ep.bondId); return bond ? [bond.begin, bond.end] : []; })()
    : ep.type === 'lonePair' ? [ep.ownerAtomId] : ep.type === 'atom' ? [ep.atomId] : ep.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
  return model.state.arrows.map(arrow => {
    try {
      const geometry = MW.model.arrowGeometry(arrow, ctx);
      const intermolecular = new Set([...endpoint(arrow.source), ...endpoint(arrow.target)].map(id => owners.get(id)).filter(Boolean)).size > 1;
      const readability = MW.route.assessReadability({ ...geometry, L: scene.L || 1, intermolecular });
      return { id: arrow.id, ...readability, intermolecular,
        sourceOk: geometry.sourceOk, targetOk: geometry.targetOk, degenerate: !!geometry.degenerate,
        start: geometry.start, control: geometry.control, end: geometry.end,
        pass: readability.readable === true && geometry.sourceOk === true && geometry.targetOk === true && !geometry.degenerate };
    } catch { return { id: arrow.id, pass: false, reasons: ['actual_curve_observation_failed'] }; }
  });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  win.webContents.on('console-message', event => {
    if (!event.message.startsWith('MOLSTUDIO_DAG_PROGRESS ')) return;
    try { report.live = JSON.parse(event.message.slice('MOLSTUDIO_DAG_PROGRESS '.length)); write(); } catch {}
  });
  const saveArtifacts = async (name, source) => {
    if (source) fs.writeFileSync(path.join(OUT, name + '.molwork'), source);
    for (const kind of ['svg', 'png']) {
      const result = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(kind) + ')');
      if (!result?.ok) throw new Error('Fixture ' + kind + ' export failed');
      fs.writeFileSync(path.join(OUT, name + '.' + kind), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    }
    fs.writeFileSync(path.join(OUT, name + '-window.png'), (await win.capturePage()).toPNG());
  };
  try {
    await win.loadURL(report.service + '/canvas.html');
    const started = Date.now();
    while (!await js('!!window.k3dAPI?.workbenchReady?.()')) {
      if (Date.now() - started > 35_000) throw new Error('Canvas did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    report.resourceHashes = await js(`(async()=>{
      const hashes={};for(const url of ['/agent/dist/agent-runtime.js','/workbench/agent-bridge.js','/workbench/reaction-graph-layout.js','/workbench/workbench-storage.js','/workbench/mechanism-route.js','/workbench/ketcher-adapter.js']){
        const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('Cannot fingerprint '+url);
        const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
        hashes[url]=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
      }return hashes;
    })()`);
    const selected = process.env.MOLSTUDIO_DAG_FIXTURES?.split(',');
    for (const fixture of [longDag23(), forkJoin()].filter(item => !selected || selected.includes(item.name) || selected.includes(item.expected.steps === 23 ? '23' : 'fork'))) {
      const entry = { name: fixture.name, scope: fixture.scope, expected: fixture.expected, checks: [] };
      report.cases.push(entry);
      const check = (name, pass, detail) => {
        entry.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write();
        if (!pass) throw new Error(fixture.name + ': ' + name);
      };
      const result = await js('(' + replay.toString() + ')(' + JSON.stringify(fixture) + ')');
      const saved = JSON.parse(result.source), graph = inspectGraph(result.context, saved.reactionSteps || []);
      entry.graph = graph; entry.completedBatches = result.completedBatches;
      fs.writeFileSync(path.join(OUT, fixture.name + '-context.json'), JSON.stringify({ context: result.context,
        stepMapping: result.stepMapping, atomMapping: result.atomMapping, entityMapping: result.entityMapping }, null, 2));
      await saveArtifacts(fixture.name, result.source);
      const aliases = new Map(Object.entries(result.stepMapping).map(([operationId, stepId]) => [stepId, operationId]));
      const edges = graph.edges.map(edge => edge.map(id => aliases.get(id)).join('→')).sort();
      check('all declared steps and electron flows survive as real editable entities',
        graph.stepCount === fixture.expected.steps && graph.flowCount === fixture.expected.flows && graph.uniqueStepIds && graph.validReferences && graph.endpointReferencesValid);
      if (result.fallbackRollback) check('short-chain DAG fallback rolls back all source task metadata and undo state on later rejection',
        result.fallbackRollback.failure === 'fixture_after_graph_plan' && result.fallbackRollback.plans >= 2 &&
        result.fallbackRollback.sourceUnchanged && result.fallbackRollback.undoUnchanged, result.fallbackRollback);
      check('connected DAG topology exactly matches the manifest', graph.acyclic && graph.weakComponents.length === 1 &&
        graph.longestPath === fixture.expected.longestPath && graph.roots.length === fixture.expected.roots &&
        graph.forks.length === fixture.expected.forks && graph.merges.length === fixture.expected.merges &&
        canonical(edges) === canonical(fixture.expected.edges.map(edge => edge.join('→')).sort()), { edges });
      const addedMolecules = fixture.batches.flatMap(batch => batch.operations).filter(op => op.type === 'molecule.add');
      const atomCount = addedMolecules.reduce((count, op) => count + [...op.smiles.matchAll(/\[[^\]]+:(\d+)\]/g)].length, 0);
      check('the host has not cloned structures while assigning branch and wrap ports',
        result.context.molecules.length === addedMolecules.length && result.context.atoms.length === atomCount);
      const owners = moleculeIndex(result.context);
      const endpointChecks = fixture.batches.map(batch => {
        const step = result.context.reactionSteps.find(item => item.stepId === result.stepMapping[batch.stepOperationId]);
        const reactants = new Set(step.reactants.map(ref => owners.get(ref)));
        const intendedArrowIds = batch.flowOperationIds.map(operationId => result.entityMapping[operationId]);
        const checkedArrowIds = step.checks?.layout?.checkedArrowIds || [];
        return { batch: batch.id, stepId: step.stepId, intendedArrowIds, checkedArrowIds,
          checked: intendedArrowIds.every(id => checkedArrowIds.includes(id)), valid: batch.flowOperationIds.every(operationId => {
          const arrow = result.context.arrows.find(item => item.id === result.entityMapping[operationId]);
          if (!arrow) return false;
          const source = endpointAtoms(arrow.source, result.context), target = endpointAtoms(arrow.target, result.context);
          return source.length && target.length && [...source, ...target].every(ref => reactants.has(owners.get(ref)));
        }) };
      });
      check('each intended elementary step retains its own two stable electron-flow endpoints', endpointChecks.every(item => item.valid), endpointChecks);
      check('each step actually inspects all intended flows including bond sources and shared fork flow', endpointChecks.every(item => item.checked), endpointChecks);
      entry.actualCurves = await js('(' + observeFixtureCurves.toString() + ')(' + JSON.stringify(result.context) + ')');
      check('all actual curves pass current R.assessReadability with valid endpoints', entry.actualCurves.length === graph.flowCount &&
        entry.actualCurves.every(curve => curve.pass), entry.actualCurves.filter(curve => !curve.pass));
      check('a shared physical intermediate is one actual component for every producer and consumer', fixture.expected.sharedReferences.every(shared => {
        const owner = owners.get(result.atomMapping[shared.atom]);
        const hasOwner = (operationId, side) => result.context.reactionSteps.find(step => step.stepId === result.stepMapping[operationId])[side]
          .some(ref => owners.get(ref) === owner);
        return owner && (!shared.producer || hasOwner(shared.producer, 'products')) && shared.consumers.every(id => hasOwner(id, 'reactants'));
      }));
      check('all straight arrows use local rightward horizontal lanes and real layout checks pass',
        graph.linkedNative.every(item => item.count === 1 && item.horizontalRightward && item.layout.status === 'passed'), graph.layoutFailures);
      check('every graph/wrap port has exactly one matching source and target on the same real structure',
        graph.portsPaired && graph.nonlocalCueCount >= (fixture.expected.steps === 23 ? 1 : 2), graph.portPairs);
      const mainRows = new Set(graph.linkedNative.filter(item => !fixture.expected.mainStepIds || fixture.expected.mainStepIds.some(id => result.stepMapping[id] === item.stepId)).map(item => item.row));
      check('the mainline wraps while its own structures remain single instances', mainRows.size >= fixture.expected.minimumMainlineRows &&
        (fixture.expected.steps !== 23 || graph.wrapCueCount > 0), { mainRows: [...mainRows], wrapCues: graph.wrapCueCount });
      check('each fixed batch contributes one native undo transaction', result.undo === fixture.expected.undoTransactions);
      const beforeLastDoc = JSON.parse(result.beforeLast.source);
      const undone = await js('(async()=>{document.activeElement?.blur?.();k3dAPI.undo();return{context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()');
      const undoneDoc = JSON.parse(undone.source);
      check('one undo restores the entire preceding graph and its geometry', semanticSnapshot(undone.context, undoneDoc.reactionSteps) ===
        semanticSnapshot(result.beforeLast.context, beforeLastDoc.reactionSteps) && geometry(undone.context) === geometry(result.beforeLast.context));
      const redone = await js('(async()=>{document.activeElement?.blur?.();k3dAPI.redo();return{context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()');
      check('redo restores stable step/arrow identities, all ports and final geometry', semanticSnapshot(redone.context, JSON.parse(redone.source).reactionSteps) ===
        semanticSnapshot(result.context, saved.reactionSteps) && geometry(redone.context) === geometry(result.context));
      if (result.beforeFallback) {
        const count = fixture.batches.length - fixture.batches.findIndex(batch => batch.id === 'prepare-02');
        const beforeFallbackDoc = JSON.parse(result.beforeFallback.source);
        const undoneFallback = await js(`(async()=>{for(let i=0;i<${count};i++)k3dAPI.undo();
          return{context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()`);
        check('undoing through the fallback restores the exact preceding graph and geometry',
          semanticSnapshot(undoneFallback.context, JSON.parse(undoneFallback.source).reactionSteps) ===
            semanticSnapshot(result.beforeFallback.context, beforeFallbackDoc.reactionSteps) &&
          geometry(undoneFallback.context) === geometry(result.beforeFallback.context));
        const redoneFallback = await js(`(async()=>{for(let i=0;i<${count};i++)k3dAPI.redo();
          return{context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()`);
        check('redoing the fallback and later batches restores every identity port and coordinate',
          semanticSnapshot(redoneFallback.context, JSON.parse(redoneFallback.source).reactionSteps) === semanticSnapshot(result.context, saved.reactionSteps) &&
          geometry(redoneFallback.context) === geometry(result.context));
      }
      const reopened = await js('(async()=>{const loaded=await k3dAPI.loadWorkbench(' + JSON.stringify(result.source) + ');return{loaded,context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()');
      check('save/reopen preserves the graph, endpoint IDs, port pairs and relative geometry', reopened.loaded.ok &&
        semanticSnapshot(reopened.context, JSON.parse(reopened.source).reactionSteps) === semanticSnapshot(result.context, saved.reactionSteps) &&
        geometry(reopened.context) === geometry(result.context) && reopened.context.reactionSteps.every(step => step.checks.layout.status === 'passed'), reopened.loaded);
      await saveArtifacts(fixture.name + '-reopened', reopened.source);
      if (fixture.expected.steps === 23) {
        const live = reopened.context, liveOwners = moleculeIndex(live);
        const local = live.molecules.map(molecule => ({ molecule, steps: live.reactionSteps.filter(step =>
          [...step.reactants, ...step.products].some(ref => liveOwners.get(ref) === molecule.id)) }))
          .find(item => item.molecule.atoms.length > 1 && item.steps.length >= 2 && item.steps.every(step => !(step.ports || []).length));
        check('the displacement probe selects a genuine no-port shared intermediate', !!local);
        const repairStep = local.steps.find(step => step.products.some(ref => liveOwners.get(ref) === local.molecule.id)) || local.steps[0];
        const runId = 'displaced-' + Date.now();
        await js('k3dAPI.agent.beginRun(' + JSON.stringify(runId) + ',{readingOrder:true,separatePaths:true})');
        try {
          const moved = await js('(async()=>{await k3dAPI.agent.applyOperations([{id:"fixture-displace-no-port",type:"molecule.move",target:{atoms:' +
            JSON.stringify(local.molecule.atoms) + '},dx:0.6,dy:1.1}],{runId:' + JSON.stringify(runId) +
            '});return{context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()');
          const affected = moved.context.reactionSteps.filter(step => local.steps.some(original => original.stepId === step.stepId));
          check('moving a no-port intermediate invalidates its actual graph anchors', affected.every(step => step.checks.layout.status === 'failed' &&
            step.checks.layout.issues.some(issue => issue.code === 'reaction_step_structure_displaced')), affected.map(step => ({ stepId: step.stepId, checks: step.checks })));
          await saveArtifacts(fixture.name + '-displaced', moved.source);
          const repaired = await js('(async()=>{const receipt=await k3dAPI.agent.applyOperations([{id:"fixture-repair-no-port",type:"reactionStep.modify",stepId:' +
            JSON.stringify(repairStep.stepId) + ',expectedVersion:' + repairStep.version + ',layout:{}}],{runId:' + JSON.stringify(runId) +
            '});return{receipt,context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()};})()');
          check('modifying that stable step reflows the graph and clears the observed displacement',
            repaired.context.reactionSteps.length === live.reactionSteps.length && repaired.context.atoms.length === live.atoms.length &&
            repaired.context.reactionSteps.every(step => step.checks.layout.status === 'passed') &&
            repaired.context.reactionSteps.find(step => step.stepId === repairStep.stepId).version === repairStep.version + 1,
            repaired.context.reactionSteps.filter(step => step.checks.layout.status !== 'passed'));
          await saveArtifacts(fixture.name + '-repaired', repaired.source);
        } finally { await js('k3dAPI.agent.endRun(' + JSON.stringify(runId) + ')'); }
      }
      entry.ok = true; write();
    }
    report.ok = report.cases.length > 0 && report.cases.every(item => item.ok);
  } catch (error) {
    report.ok = false; report.failure = String(error.message || error);
    report.partial = await js('window.__dagFixture ? {completedBatches:__dagFixture.completedBatches,activeBatch:__dagFixture.activeBatch} : null').catch(() => null);
    const source = await js('k3dAPI?.serializeWorkbench?.()').catch(() => null);
    await saveArtifacts('failure', source).catch(() => {});
  } finally {
    write(); console.log(JSON.stringify({ ok: report.ok, realModelRequests: 0, cases: report.cases.map(item => ({ name: item.name, ok: item.ok,
      passed: item.checks.filter(check => check.pass).length, total: item.checks.length })), failure: report.failure, out: OUT }, null, 2));
    clearTimeout(watchdog); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
