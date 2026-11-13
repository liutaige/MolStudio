// Current canvas + the configured real model; at most six local gateway requests.
// Seed preparation bypasses Runtime chemistry preflight deliberately: the existing
// step has a wrong product link, while both existing SN2 electron flows are correct.
// MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_correction_live.cjs
// To verify only the bridge/runtime harness with synthetic model transport:
// MOLSTUDIO_STEP_CORRECTION_SYNTHETIC=1 MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_correction_live.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SYNTHETIC = process.env.MOLSTUDIO_STEP_CORRECTION_SYNTHETIC === '1';
if (!SYNTHETIC && process.env.MOLSTUDIO_REAL_AGENT !== '1') {
  process.stderr.write('Real model requests require MOLSTUDIO_REAL_AGENT=1. Use MOLSTUDIO_STEP_CORRECTION_SYNTHETIC=1 for a transport-only fixture.\n');
  process.exit(2);
}
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-reaction-step-correction-live');
const PORT = Number(process.env.MOLSTUDIO_PORT) || 49075;
const REQUEST_LIMIT = Math.min(6, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 6));
const DEADLINE = Math.min(300_000, Math.max(180_000, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 240_000));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-reaction-step-correction-live-'));
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', profile);

const report = {
  application: 'MolStudio canvas', page: 'fusion/canvas.html',
  scope: SYNTHETIC ? 'Actual canvas, native editor, bridge and runtime with synthetic model transport; this is not real-model acceptance.'
    : 'Actual canvas, native editor, bridge and runtime with the configured real model.',
  mode: SYNTHETIC ? 'synthetic-transport' : 'real-model', realModelRequests: 0, syntheticResponses: 0,
  build: 'current served browser resources; SHA-256 fingerprints recorded below',
  service: 'http://127.0.0.1:' + PORT,
  fixture: 'Existing OH- + CH3Br SN2 step incorrectly linked to ethanol + Br-; methanol and both correct electron flows already exist.',
  requestLimit: REQUEST_LIMIT, timeoutMs: DEADLINE,
  privacy: 'Only local tool receipts, visible assistant explanation and canvas artifacts are retained. No provider payloads, hidden reasoning, configuration or credentials are stored.',
  checks: [], browserErrors: [], artifacts: [],
};
let win;
const writeReport = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  if (!pass) throw new Error(name);
};
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const sameMembers = (a, b) => canonical([...a].sort()) === canonical([...b].sort());
const structuralSnapshot = context => ({
  atoms: context.atoms.map(({ id, label, charge, isotope, radical, implicitH }) => ({ id, label, charge, isotope, radical, implicitH }))
    .sort((a, b) => a.id.localeCompare(b.id)),
  bonds: context.bonds.map(({ id, begin, end, order, nativeType, stereo }) => ({ id, begin, end, order, nativeType, stereo }))
    .sort((a, b) => a.id.localeCompare(b.id)),
  molecules: context.molecules.map(molecule => [...molecule.atoms].sort()).sort((a, b) => canonical(a).localeCompare(canonical(b))),
});
const electronSnapshot = context => context.arrows.map(({ id, source, target, electronCount }) => ({ id, source, target, electronCount }))
  .sort((a, b) => a.id.localeCompare(b.id));
const semanticSnapshot = context => ({
  structures: structuralSnapshot(context), electrons: electronSnapshot(context),
  lonePairs: context.lonePairs.map(({ id, ownerAtomId }) => ({ id, ownerAtomId })).sort((a, b) => a.id.localeCompare(b.id)),
  steps: context.reactionSteps.map(({ stepId, version, reactants, products, conditions, layout }) =>
    ({ stepId, version, reactants: [...reactants].sort(), products: [...products].sort(), conditions: conditions || '', layout })),
});
function inspectProductCorridor(context, step) {
  const atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  const box = molecule => {
    const points = molecule.atoms.map(id => atoms.get(id));
    return { x1: Math.min(...points.map(atom => atom.x)) - 0.4, x2: Math.max(...points.map(atom => atom.x)) + 0.4,
      y1: Math.min(...points.map(atom => atom.y)) - 0.4, y2: Math.max(...points.map(atom => atom.y)) + 0.4 };
  };
  const moleculeOf = ref => context.molecules.find(molecule => molecule.atoms.includes(ref));
  const participants = new Set([...step.reactants, ...step.products].map(moleculeOf));
  const products = [...new Set(step.products.map(moleculeOf))];
  const arrow = context.reactionArrows.find(item => item.stepId === step.stepId);
  const firstProductX = Math.min(...products.map(molecule => box(molecule).x1));
  const lane = { x1: arrow.end.x, x2: firstProductX, y1: arrow.end.y - 0.5, y2: arrow.end.y + 0.5 };
  const intruders = context.molecules.filter(molecule => !participants.has(molecule)).map(molecule => ({ molecule: molecule.id, ...box(molecule) }))
    .filter(bounds => bounds.x2 > lane.x1 && bounds.x1 < lane.x2 && bounds.y2 > lane.y1 && bounds.y1 < lane.y2);
  return { status: intruders.length ? 'failed' : 'passed', lane, unrelatedMoleculesBetweenArrowAndProducts: intruders };
}

const watchdog = setTimeout(() => {
  report.ok = false; report.timedOut = true;
  report.failure = 'Correction acceptance exceeded its total deadline; no further model responses will be requested.';
  writeReport();
  win?.destroy();
  app.exit(2);
}, DEADLINE);

async function seedScene() {
  const rt = molstudioAgent.getRuntime(), api = k3dAPI.agent, ed = MolWorkbench.app.adapter.ed;
  rt.reset(); molstudioAgent.getPanel().clear();
  await k3dAPI.setMolecule('');
  const runId = 'correction-seed-' + crypto.randomUUID();
  await api.beginRun(runId, { readingOrder: false, separatePaths: true });
  let receipt;
  try {
    const structures = await api.applyOperations([
      { id: 'seed-oh', type: 'molecule.add', smiles: '[OH-:1]', x: 3, y: 4 },
      { id: 'seed-ch3br', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 7, y: 4 },
      { id: 'seed-ethanol', type: 'molecule.add', smiles: '[CH3:1][CH2:2][OH:3]', x: 15, y: 4 },
      { id: 'seed-methanol', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 12, y: 10 },
      { id: 'seed-br', type: 'molecule.add', smiles: '[Br-:1]', x: 18, y: 4 },
      { id: 'seed-pair', type: 'lonePair.add', atom: 'seed-oh:1', angle: 0 },
      { id: 'seed-attack', type: 'arrow.add', source: { type: 'lonePair', id: 'seed-pair' },
        target: { type: 'formingBond', atom1: 'seed-oh:1', atom2: 'seed-ch3br:1' }, electronCount: 2 },
      { id: 'seed-leave', type: 'arrow.add', source: { type: 'bond', atom1: 'seed-ch3br:1', atom2: 'seed-ch3br:2', component: 'sigma' },
        target: { type: 'atom', atomId: 'seed-ch3br:2' }, electronCount: 2 },
    ], { runId });
    // This is a raw bridge call. It intentionally does not pass validateMechanism.
    const step = await api.applyOperations([{ id: 'seed-wrong-step-' + crypto.randomUUID(), type: 'reactionStep.create',
      reactants: ['seed-oh:1', 'seed-ch3br:1'], products: ['seed-ethanol:1', 'seed-br:1'], layout: {} }], { runId });
    receipt = { structures, step };
  } finally { await api.endRun(runId); }
  ed.clearHistory();
  document.activeElement?.blur?.(); molstudioAgent.open();
  const context = await api.getContext();
  const refs = receipt.structures.atomMapping;
  window.__reactionStepCorrection = {
    rt, api, requests: 0, realModelRequests: 0, syntheticResponses: 0,
    toolNames: [], stepReceipts: [], visibleExplanation: '', events: [], browserErrors: [],
    seed: { stepId: receipt.step.steps[0].stepId, version: receipt.step.steps[0].version,
      reactants: [refs['seed-oh:1'], refs['seed-ch3br:1']],
      wrongProducts: [refs['seed-ethanol:1'], refs['seed-br:1']],
      correctProducts: [refs['seed-methanol:1'], refs['seed-br:1']] },
  };
  return { context, seed: window.__reactionStepCorrection.seed, source: await k3dAPI.serializeWorkbench() };
}

async function installAudit(limit, synthetic) {
  const state = window.__reactionStepCorrection, rt = state.rt, nativeFetch = rt._fetch;
  const syntheticReply = delta => {
    const encoder = new TextEncoder();
    const finish = delta.tool_calls ? 'tool_calls' : 'stop';
    return new Response(new ReadableStream({ start(controller) {
      for (const [part, finishReason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'synthetic-correction', model: 'synthetic-correction',
          choices: [{ index: 0, delta: part, finish_reason: finishReason }] }) + '\n\n'));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const toolReply = (name, args, id) => syntheticReply({ tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] });
  rt._fetch = async function (url, init) {
    if (url !== '/api/agent/model') return nativeFetch(url, init);
    if (state.requests >= (synthetic ? 3 : limit)) throw Object.assign(new Error('Correction acceptance reached its request limit; no upstream call sent'), { code: 'test_request_limit' });
    state.requests++;
    if (synthetic) {
      state.syntheticResponses++;
      console.info('REACTION_STEP_LIVE_PROGRESS ' + JSON.stringify({ realModelRequests: 0, syntheticResponses: state.syntheticResponses }));
      if (state.syntheticResponses === 1) return toolReply('read_canvas', {}, 'synthetic-read');
      if (state.syntheticResponses === 2) {
        const context = await state.api.getContext();
        const current = context.reactionSteps.find(step => step.stepId === state.seed.stepId);
        if (!current) throw new Error('Synthetic correction cannot find the seeded real step');
        return toolReply('draw_operations', { operations: [{ id: 'synthetic-correction-' + crypto.randomUUID(),
          type: 'reactionStep.modify', stepId: current.stepId, expectedVersion: current.version,
          products: state.seed.correctProducts }], finish: true }, 'synthetic-modify');
      }
      return syntheticReply({ content: '已将原步骤的产物关联改为甲醇和溴离子；原步骤身份、全部结构和两根已有电子流保持。' });
    }
    state.realModelRequests++;
    console.info('REACTION_STEP_LIVE_PROGRESS ' + JSON.stringify({ realModelRequests: state.realModelRequests, syntheticResponses: 0 }));
    return nativeFetch(url, init);
  };
  addEventListener('molstudio:agent-event', event => {
    const e = event.detail;
    if (e.type === 'tool_start') state.toolNames.push(e.toolName);
    if (e.type === 'text_delta') state.visibleExplanation += e.text || e.delta || '';
    if (e.type === 'tool_end') {
      const result = e.result?.result;
      if (result?.steps?.length) state.stepReceipts.push({ toolName: e.toolName, isError: !!e.isError,
        steps: result.steps, stepMapping: result.stepMapping, replayed: result.replayed,
        finishAccepted: result.finishAccepted, finishRejected: result.finishRejected,
        invalidReactionSteps: result.invalidReactionSteps, missingElectronFlowSteps: result.missingElectronFlowSteps });
    }
    if (['tool_start', 'tool_end', 'run_end', 'error'].includes(e.type)) {
      state.events.push({ type: e.type, toolName: e.toolName, isError: e.isError, status: e.status,
        code: e.code, diagnosticCode: e.diagnostic?.code, operationId: e.diagnostic?.operationId });
    }
  });
  const rememberError = message => state.browserErrors.push(String(message).slice(0, 300));
  addEventListener('error', event => rememberError(event.message));
  addEventListener('unhandledrejection', event => rememberError(event.reason?.message || 'unhandled promise rejection'));
  MolWorkbench.app.adapter.doc.defaultView.addEventListener('error', event => rememberError(event.message));
}

function auditSnapshot() {
  const state = window.__reactionStepCorrection;
  if (!state) return null;
  return { realModelRequests: state.realModelRequests, syntheticResponses: state.syntheticResponses,
    transportRequests: state.requests, toolNames: state.toolNames, stepReceipts: state.stepReceipts,
    visibleExplanation: state.visibleExplanation.trim(), events: state.events, browserErrors: state.browserErrors,
    panelStatus: document.querySelector('.mol-agent-status')?.textContent || '',
    panelHasError: !!document.querySelector('.mol-agent-error:not([hidden])') };
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 920,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const artifact = file => report.artifacts.push({ file, application: report.application, page: report.page, build: report.build });
  const capture = async name => {
    fs.writeFileSync(path.join(OUT, name + '-window.png'), (await win.capturePage()).toPNG());
    artifact(name + '-window.png');
    const exported = await js('k3dAPI.exportMechanismImage("png")');
    if (!exported?.ok) throw new Error('Current canvas PNG export failed');
    fs.writeFileSync(path.join(OUT, name + '-mechanism.png'), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
    artifact(name + '-mechanism.png');
  };
  win.webContents.on('console-message', event => {
    if (event.message.startsWith('REACTION_STEP_LIVE_PROGRESS ')) {
      try {
        const progress = JSON.parse(event.message.slice('REACTION_STEP_LIVE_PROGRESS '.length));
        report.realModelRequests = progress.realModelRequests; report.syntheticResponses = progress.syntheticResponses; writeReport();
      } catch {}
    }
  });
  win.webContents.on('render-process-gone', (_, details) => report.browserErrors.push({ reason: details.reason, exitCode: details.exitCode }));
  try {
    await win.loadURL(report.service + '/canvas.html');
    const readyStart = Date.now();
    while (!await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')) {
      if (Date.now() - readyStart > 35_000) throw new Error('Current canvas/runtime did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    report.resourceHashes = await js(`(async()=>{
      const result={};
      for(const resource of ['/agent/dist/agent-runtime.js','/workbench/agent-bridge.js','/workbench/workbench-storage.js']){
        const response=await fetch(resource,{cache:'no-store'});if(!response.ok)throw new Error('Cannot fingerprint '+resource);
        const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
        result[resource]=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      }return result;
    })()`);
    const before = await js('(' + seedScene.toString() + ')()');
    report.seed = before.seed;
    check('seed contains one wrong-linked semantic step and both correct electron flows',
      before.context.reactionSteps.length === 1 && before.context.arrows.length === 2 && before.context.molecules.length === 5 &&
      sameMembers(before.context.reactionSteps[0].products, before.seed.wrongProducts));
    fs.writeFileSync(path.join(OUT, 'before.molwork'), before.source); artifact('before.molwork');
    await capture('before');
    await js('(' + installAudit.toString() + ')(' + REQUEST_LIMIT + ',' + SYNTHETIC + ')');
    const task = '请核对画布上已有的这一步 SN2 反应：氢氧根与溴甲烷反应，但这一步误连到了乙醇产物。请把它的产物关联改成画布上已经存在的甲醇和溴离子，保留原步骤身份、所有已有结构和两根已有电子流箭头。完成后在聊天里简短说明。';
    report.prompt = task;
    writeReport();
    const result = await js('molstudioAgent.send(' + JSON.stringify(task) + ')');
    report.runResult = result;
    report.audit = await js('(' + auditSnapshot.toString() + ')()');
    report.realModelRequests = report.audit.realModelRequests;
    report.syntheticResponses = report.audit.syntheticResponses;
    const after = await js('k3dAPI.agent.getContext()');
    const source = await js('k3dAPI.serializeWorkbench()');
    fs.writeFileSync(path.join(OUT, 'corrected.molwork'), source); artifact('corrected.molwork');
    await capture('corrected');
    const step = after.reactionSteps[0];
    report.finalStep = step;
    if (SYNTHETIC) check('synthetic transport used exactly three responses and no real model requests',
      report.realModelRequests === 0 && report.syntheticResponses === 3 &&
      canonical(report.audit.toolNames) === canonical(['read_canvas', 'draw_operations']));
    else check('real configured model stayed within the six-request limit', report.realModelRequests > 0 && report.realModelRequests <= REQUEST_LIMIT);
    check('runtime and visible panel both report completion with a short visible explanation',
      result.status === 'completed' && report.audit.panelStatus === '已完成' && !report.audit.panelHasError &&
      report.audit.visibleExplanation.length > 0 && report.audit.visibleExplanation.length <= 1200 &&
      report.audit.events.some(event => event.type === 'run_end' && event.status === 'completed'),
      { runtimeStatus: result.status, panelStatus: report.audit.panelStatus, explanationLength: report.audit.visibleExplanation.length });
    check('one existing step keeps its stable identity and advances exactly one version',
      after.reactionSteps.length === 1 && after.reactionArrows.length === 1 && step.stepId === before.seed.stepId && step.version === before.seed.version + 1,
      { before: { stepId: before.seed.stepId, version: before.seed.version }, after: { stepId: step?.stepId, version: step?.version } });
    check('old product link is replaced by the existing methanol and bromide while reactants remain intact',
      sameMembers(step.reactants, before.seed.reactants) && sameMembers(step.products, before.seed.correctProducts) &&
      !step.products.includes(before.seed.wrongProducts[0]) &&
      sameMembers(after.reactionArrows[0].products, before.seed.correctProducts));
    check('all original structures, atoms and bonds remain editable with no new molecules',
      canonical(structuralSnapshot(after)) === canonical(structuralSnapshot(before.context)));
    check('both original electron-flow identities, endpoints and electron counts are unchanged',
      after.arrows.length === 2 && canonical(electronSnapshot(after)) === canonical(electronSnapshot(before.context)));
    const modifications = report.audit.stepReceipts.flatMap(receipt => receipt.steps)
      .filter(entry => entry.stepId === step.stepId && entry.action === 'modify' && !entry.replayed);
    check('a semantic modify receipt reports actual passed chemistry and layout checks',
      modifications.length === 1 && modifications[0].version === step.version &&
      modifications[0].checks?.chemistry?.status === 'passed' && modifications[0].checks?.layout?.status === 'passed',
      { modifications: modifications.map(entry => ({ stepId: entry.stepId, version: entry.version, checks: entry.checks })) });
    const { checkElectronFlowCoverage } = await import('../agent/mechanism-coverage.js');
    const { checkMechanismPreflight } = await import('../agent/mechanism-preflight.js');
    const members = refs => [...new Set(refs.flatMap(ref => after.molecules.find(molecule => molecule.atoms.includes(ref))?.atoms || []))];
    const chemistryInput = { reactantAtoms: members(step.reactants), productAtoms: members(step.products),
      atoms: after.atoms, bonds: after.bonds, lonePairs: after.lonePairs, arrows: after.arrows, conditions: step.conditions };
    const preflight = checkMechanismPreflight(chemistryInput), coverage = checkElectronFlowCoverage(chemistryInput);
    report.independentChemistryAudit = { status: !preflight && !coverage ? 'passed' : 'failed', preflight, coverage };
    check('independent coverage check agrees using the final actual atoms, bonds and unchanged flows', !preflight && !coverage);
    const undone = await js(`(async()=>{document.activeElement?.blur?.();k3dAPI.undo();return k3dAPI.agent.getContext();})()`);
    check('one native undo restores the original wrong link, version and all original entities',
      canonical(semanticSnapshot(undone)) === canonical(semanticSnapshot(before.context)));
    const redone = await js(`(async()=>{document.activeElement?.blur?.();k3dAPI.redo();return k3dAPI.agent.getContext();})()`);
    check('native redo restores the corrected stable step and original structures/electron flows',
      canonical(semanticSnapshot(redone)) === canonical(semanticSnapshot(after)));
    const reopened = await js('(async()=>{const saved=await k3dAPI.serializeWorkbench();const loaded=await k3dAPI.loadWorkbench(saved);return{loaded,context:await k3dAPI.agent.getContext()};})()');
    check('save and reopen preserve the corrected semantic identity, version and all chemical entities',
      reopened.loaded.ok && canonical(semanticSnapshot(reopened.context)) === canonical(semanticSnapshot(after)), reopened.loaded);
    fs.writeFileSync(path.join(OUT, 'reopened.molwork'), await js('k3dAPI.serializeWorkbench()')); artifact('reopened.molwork');
    await capture('reopened');
    report.visualAudit = inspectProductCorridor(after, step);
    check('the straight arrow visibly leads to its corrected products without an unrelated molecule in between',
      report.visualAudit.status === 'passed', report.visualAudit);
    check('no uncaught browser/native errors occurred', !report.audit.browserErrors.length && !report.browserErrors.length);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.failure = String(error.message || error).slice(0, 1000);
    await js('molstudioAgent?.stop?.("live_acceptance_failed")').catch(() => {});
    report.audit = await js('(' + auditSnapshot.toString() + ')()').catch(() => report.audit);
    if (report.audit) { report.realModelRequests = report.audit.realModelRequests; report.syntheticResponses = report.audit.syntheticResponses; }
    const saved = await js('k3dAPI?.serializeWorkbench?.()').catch(() => null);
    if (saved) { fs.writeFileSync(path.join(OUT, 'failure.molwork'), saved); artifact('failure.molwork'); }
    await capture('failure').catch(() => {});
  } finally {
    writeReport();
    console.log(JSON.stringify({ application: report.application, page: report.page, mode: report.mode,
      realModelRequests: report.realModelRequests || 0, syntheticResponses: report.syntheticResponses || 0,
      passed: report.checks.filter(item => item.pass).length, total: report.checks.length, failure: report.failure, ok: report.ok, out: OUT }, null, 2));
    clearTimeout(watchdog); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
