'use strict';
// Isolated real canvas and chemistry service. Synthetic operations only; the
// user's current app is never inspected or changed and model requests are blocked.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-endpoint-diagnostics');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-endpoint-profile-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49182),
  scope: 'Synthetic wrong bond alias, valid carbonyl pi-to-O, prior bond mutation and complete rollback; no real model calls.',
  checks: [], realModelRequests: 0 };
let win;
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'fixture watchdog'; write(); win?.destroy(); app.exit(2); }, 120000);
async function exercise() {
  const api = k3dAPI.agent, { adapter, model, controller } = MolWorkbench.app, ed = adapter.ed;
  const checks = [], check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
    if (!pass) throw new Error(name);
  };
  window.endpointChecks = checks;
  const describeError = error => ({ code: error.code, reason: error.message, field: error.field,
    operationId: error.operationId, sourceEndpoint: error.sourceEndpoint, targetEndpoint: error.targetEndpoint,
    endpointDistance: error.endpointDistance });
  await k3dAPI.setMolecule(''); ed.clearHistory();
  const acid = { id: 'acid', type: 'molecule.add', smiles: '[CH:13](=[O+:14][H:17])[OH:15]' };
  const inspection = (await api.inspectStructures([{ id: acid.id, smiles: acid.smiles }]))[0];
  const carbonyl = inspection.bonds.find(b => [b.begin, b.end].sort().join(':') === '13:14');
  const single = inspection.bonds.find(b => [b.begin, b.end].sort().join(':') === '14:17');
  check('structure preflight identifies distinct carbonyl and single bond references', inspection.ok && carbonyl && single, inspection);
  check('structure inspection exposes actual carbonyl and O-H bond orders before drawing',
    carbonyl.order === 2 && carbonyl.nativeType === 2 && single.order === 1 && single.nativeType === 1);
  const extra = await api.inspectStructures([{ id: 'aromatic', smiles: 'c1ccccc1' }, { id: 'triple', smiles: 'N#N' }]);
  check('aromatic chemical order and triple order remain distinct from native depiction types',
    extra[0].ok && extra[0].bonds.every(bond => bond.order === 1.5 && [1, 2].includes(bond.nativeType)) &&
    extra[1].ok && extra[1].bonds[0].order === 3 && extra[1].bonds[0].nativeType === 3, extra);
  const arrow = { id: 'arrA1b_pi', type: 'arrow.add', source: { type: 'bond', bondId: 'acid:bond:' + single.ref, component: 'pi' },
    target: { type: 'atom', atomId: 'acid:14' }, electronCount: 2 };
  const correct = { ...arrow, source: { ...arrow.source, bondId: 'acid:bond:' + carbonyl.ref } };
  await api.beginRun('endpoint-alias-rollback');
  const before = await k3dAPI.serializeWorkbench(), undo = ed.historySize().undo;
  let failure;
  try { await api.applyOperations([acid, arrow], { runId: 'endpoint-alias-rollback' }); }
  catch (error) { failure = describeError(error); }
  check('wrong single-bond pi source reports actual order and typed aliases',
    failure?.code === 'arrow_pi_unavailable' && failure.operationId === arrow.id && failure.sourceEndpoint.reason === 'piUnavailable' &&
    failure.sourceEndpoint.bondOrder === 1 && failure.sourceEndpoint.bondRef === arrow.source.bondId &&
    failure.sourceEndpoint.atomIds.length === 2 && failure.targetEndpoint.atomRefs[0] === 'acid:14', failure);
  check('failed molecule-plus-arrow batch restores source and native undo history', before === await k3dAPI.serializeWorkbench() && ed.historySize().undo === undo);
  const receipt = await api.applyOperations([acid, correct], { runId: 'endpoint-alias-rollback' });
  const added = model.arrow(receipt.created.find(item => item.id === arrow.id).entityIds[0]);
  const geometry = MolWorkbench.model.arrowGeometry(added, controller.ctx());
  check('corrected same failed ids and carbonyl alias commit once after rollback',
    receipt.created.length === 2 && geometry.sourceOk && geometry.targetOk && !geometry.degenerate &&
    added.source.bondId === receipt.bondMapping[correct.source.bondId] && ed.historySize().undo === undo + 1);
  const insertedBonds = receipt.created.find(item => item.id === acid.id).bonds;
  check('created molecule receipts observe the inserted native bond orders',
    insertedBonds.every(bond => controller.ctx().bondInfo(bond.id).type === bond.nativeType && bond.order === bond.nativeType));
  await api.endRun('endpoint-alias-rollback');
  await api.beginRun('endpoint-prior-mutation');
  const stableBond = added.source.bondId, stableO = added.target.atomId;
  const second = { id: 'after-lowering', type: 'arrow.add', source: { type: 'bond', bondId: stableBond, component: 'pi' },
    target: { type: 'atom', atomId: stableO }, electronCount: 2 };
  const beforeMutation = await k3dAPI.serializeWorkbench(), undoMutation = ed.historySize().undo;
  failure = null;
  try { await api.applyOperations([{ id: 'lower-carbonyl', type: 'bond.modify', bondId: stableBond, order: 1 }, second], { runId: 'endpoint-prior-mutation' }); }
  catch (error) { failure = describeError(error); }
  check('pi validation observes an earlier native bond edit in the same batch',
    failure?.code === 'arrow_pi_unavailable' && failure.operationId === second.id && failure.sourceEndpoint.bondId === stableBond && failure.sourceEndpoint.bondOrder === 1, failure);
  check('failed prior-mutation batch restores original carbonyl order, aliases and undo history',
    beforeMutation === await k3dAPI.serializeWorkbench() && controller.ctx().bondInfo(stableBond).type === 2 && ed.historySize().undo === undoMutation);
  await api.endRun('endpoint-prior-mutation');
  return { checks, inspection, final: await k3dAPI.serializeWorkbench() };
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: [report.service + '/api/agent/model*'] }, (_details, callback) => {
      report.realModelRequests++; callback({ cancel: true });
    });
    const js = code => win.webContents.executeJavaScript(code);
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 400 && !await js('!!k3dAPI?.workbenchReady?.()'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const result = await js('(' + exercise.toString() + ')()');
    report.checks = result.checks; report.inspection = result.inspection;
    fs.writeFileSync(path.join(out, 'valid-carbonyl.molwork'), result.final);
    const png = await js("k3dAPI.exportMechanismImage('png')");
    if (png?.ok) fs.writeFileSync(path.join(out, 'valid-carbonyl.png'), Buffer.from(png.dataUrl.split(',')[1], 'base64'));
    if (process.env.MOLSTUDIO_ENDPOINT_SAVED_FILE) {
      const saved = fs.readFileSync(process.env.MOLSTUDIO_ENDPOINT_SAVED_FILE, 'utf8');
      if (!(await js('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')'))?.ok) throw new Error('saved current canvas did not load');
      report.savedFlowCatalog = await js(`(async()=>{
        const context=await k3dAPI.agent.getContext(),ctx=MolWorkbench.app.controller.ctx(),M=MolWorkbench.model;
        return {scope:'Current saved graph only; failed tool arguments are absent from this file.',
          atoms:context.atoms.length,bonds:context.bonds.length,reactionSteps:context.reactionSteps.length,
          flows:context.arrows.map(arrow=>{const source=M.endpointAnchor(arrow.source,ctx),target=M.endpointAnchor(arrow.target,ctx),
            geometry=M.arrowGeometry(arrow,ctx),bond=arrow.source.type==='bond'?ctx.bondInfo(arrow.source.bondId):null;
            return {id:arrow.id,source:arrow.source,target:arrow.target,sourceOk:source.ok,targetOk:target.ok,
              sourceReason:source.reason||null,targetReason:target.reason||null,anchorDistance:M.dist(source,target),
              degenerate:geometry.degenerate,...(bond&&{sourceBondOrder:bond.type,sourceBondAtoms:[bond.beginAtom,bond.endAtom]})};})};
      })()`);
      report.checks.push({ name: 'all current saved electron flows retain valid semantic anchors and nondegenerate geometry',
        pass: report.savedFlowCatalog.flows.length > 0 && report.savedFlowCatalog.flows.every(flow => flow.sourceOk && flow.targetOk && !flow.degenerate) });
      const currentPng = await js("k3dAPI.exportMechanismImage('png')");
      if (currentPng?.ok) fs.writeFileSync(path.join(out, 'saved-current-canvas.png'), Buffer.from(currentPng.dataUrl.split(',')[1], 'base64'));
    }
    report.ok = report.checks.every(check => check.pass) && report.realModelRequests === 0;
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error);
    if (win) try { report.checks = await win.webContents.executeJavaScript('window.endpointChecks || []'); } catch {}
  } finally {
    clearTimeout(watchdog); write();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length, total: report.checks.length,
      realModelRequests: report.realModelRequests, failure: report.failure, out }));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  }
});
