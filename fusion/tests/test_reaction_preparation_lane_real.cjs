'use strict';
// Real saved Traube canvas from live-candidate/after.molwork (2026-11-13),
// stripped of agentTask text. Native layout/history/export only; no model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonical } = require('./agent_long_route_audit.cjs');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-preparation-lane');
const seed = fs.readFileSync(process.env.MOLSTUDIO_TEST_SEED_FILE || path.join(__dirname, 'fixtures/traube-preparation-baseline.molwork'), 'utf8');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-preparation-profile-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49182),
  scope: 'Actual five-step saved Traube graph: preparation lane, shared acid product ports, native geometry/history and reopen. No chemistry changes or model calls.',
  checks: [], realModelRequests: 0, browserErrors: [] };
let win;
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'fixture watchdog'; write(); win?.destroy(); app.exit(2); }, 120000);
const chemistry = context => canonical({
  atoms: context.atoms.map(({ id, label, charge, radical, isotope, implicitH, aromatic, stereoLabel, stereoParity }) =>
    ({ id, label, charge, radical, isotope, implicitH, aromatic, stereoLabel, stereoParity })).sort((a, b) => a.id.localeCompare(b.id)),
  bonds: context.bonds.map(({ id, begin, end, order, stereo }) => ({ id, begin, end, order, stereo })).sort((a, b) => a.id.localeCompare(b.id)),
  pairs: context.lonePairs.map(({ id, ownerAtomId }) => ({ id, ownerAtomId })).sort((a, b) => a.id.localeCompare(b.id)),
  arrows: context.arrows.map(({ id, source, target, electronCount }) => ({ id, source, target, electronCount })).sort((a, b) => a.id.localeCompare(b.id)),
  steps: context.reactionSteps.map(({ stepId, reactants, products }) => ({ stepId, reactants, products })).sort((a, b) => a.stepId.localeCompare(b.stepId)) });
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: [report.service + '/api/agent/model*'] }, (_details, cb) => { report.realModelRequests++; cb({ cancel: true }); });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.browserErrors.push(event.message.slice(0, 400)); });
    const js = code => win.webContents.executeJavaScript(code);
    const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); if (!pass) throw Error(name); };
    const capture = async name => {
      const value = await js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench(),undo:MolWorkbench.app.adapter.ed.historySize().undo}))()');
      fs.writeFileSync(path.join(out, name + '.molwork'), value.source);
      fs.writeFileSync(path.join(out, name + '-context.json'), JSON.stringify(value.context, null, 2));
      return value;
    };
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 400 && !await js('!!k3dAPI?.workbenchReady?.()'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    check('actual saved five-step Traube fixture loads', (await js('k3dAPI.loadWorkbench(' + JSON.stringify(seed) + ')')).ok);
    await js('MolWorkbench.app.adapter.ed.clearHistory();void 0;');
    const before = await capture('before'), old = JSON.parse(before.source).reactionSteps;
    check('fixture has the observed same-row baseline mismatch', before.context.reactionSteps.length === 5 && before.context.arrows.length === 10 &&
      Math.abs(before.context.reactionArrows[0].start.y - before.context.reactionArrows[1].start.y) > 1);
    const first = old[0];
    report.receipt = await js(`(async()=>{const api=k3dAPI.agent;await api.beginRun('preparation-lane-fix');
      const receipt=await api.applyOperations([{id:'preparation-lane-replan',type:'layout.tidy'}],{runId:'preparation-lane-fix'});
      await api.endRun('preparation-lane-fix');return receipt;})()`);
    const after = await capture('after'), steps = JSON.parse(after.source).reactionSteps;
    check('layout preserves every atom bond lone pair flow and chemical participant with no copies', chemistry(before.context) === chemistry(after.context) &&
      after.context.reactionSteps.length === 5 && after.context.arrows.length === 10);
    const lines = new Map(after.context.reactionArrows.map(arrow => [arrow.stepId, arrow]));
    const metrics = steps.map(step => ({ stepId: step.stepId, laneId: step.flow?.laneId, rowY: step.flow?.rowY,
      arrowY: lines.get(step.stepId)?.start.y, arrowEndY: lines.get(step.stepId)?.end.y }));
    check('every native straight arrow lies on its declared lane baseline', metrics.every(value => value.laneId &&
      Math.abs(value.rowY - value.arrowY) < 1e-6 && Math.abs(value.rowY - value.arrowEndY) < 1e-6), metrics);
    const prep = steps.find(step => step.stepId === first.stepId), main = steps.find(step => step.stepId === old[1].stepId);
    check('small acid preparation has its own lane instead of an offset arrow on the main row',
      prep.flow.laneId !== main.flow.laneId && steps.filter(step => step !== prep).every(step => step.flow.laneId === main.flow.laneId));
    check('direct native tidy preserves the original continuable task checkpoint and step versions',
      canonical(JSON.parse(before.source).agentTask) === canonical(JSON.parse(after.source).agentTask) &&
      old.every(step => steps.find(other => other.stepId === step.stepId).version === step.version));
    const ports = steps.flatMap(step => (step.labels || []).filter(label => label.role === 'graphPort').map(label => ({ ...label, stepId: step.stepId })));
    const tokens = [...new Set(ports.map(port => port.token))];
    check('all displayed reference ports have exactly one anchored molecule end and one matching port end', tokens.length > 0 && tokens.every(token => {
      const pair = ports.filter(port => port.token === token);
      return pair.length === 2 && new Set(pair.map(port => port.at)).size === 2 &&
        canonical(pair[0].anchorRefs.slice().sort()) === canonical(pair[1].anchorRefs.slice().sort());
    }), ports);
    const acidCopies = after.context.molecules.filter(molecule => molecule.atoms.includes(first.products[0]));
    const acidPort = ports.find(port => port.stepId === first.stepId && port.side === 'target' && port.at === 'port' &&
      port.anchorRefs.some(id => acidCopies[0]?.atoms.includes(id)));
    check('the preparation output port names the one actual shared protonated acid', acidCopies.length === 1 && acidPort &&
      ports.some(port => port.token === acidPort.token && port.at === 'molecule' && port.anchorRefs.every(id => acidCopies[0].atoms.includes(id))),
      { acidAtomIds: acidCopies[0]?.atoms, port: acidPort });
    check('native layout validation accepts every step and its paired-port anchors', after.context.reactionSteps.every(step => step.checks.layout.status === 'passed'));
    check('replanning is one undo transaction', after.undo === 1);
    await js('document.activeElement?.blur?.();k3dAPI.undo();void 0;');
    const undo = await capture('undo');
    check('undo restores original chemistry arrows and baseline mismatch together', chemistry(undo.context) === chemistry(before.context) &&
      canonical(undo.context.reactionArrows) === canonical(before.context.reactionArrows));
    await js('document.activeElement?.blur?.();k3dAPI.redo();void 0;');
    const redo = await capture('redo');
    check('redo restores the same physical graph and lane coordinates', chemistry(redo.context) === chemistry(after.context) &&
      canonical(redo.context.reactionArrows) === canonical(after.context.reactionArrows));
    check('saved lane references reopen', (await js('k3dAPI.loadWorkbench(' + JSON.stringify(after.source) + ')')).ok);
    const reopened = await capture('reopened'), restored = JSON.parse(reopened.source).reactionSteps;
    check('reopening retains graph identities lane assignments and paired anchors', chemistry(reopened.context) === chemistry(after.context) &&
      canonical(restored.map(step => ({ stepId: step.stepId, laneId: step.flow.laneId, labels: step.labels?.map(label => ({ token: label.token, at: label.at, anchorRefs: label.anchorRefs })) }))) ===
      canonical(steps.map(step => ({ stepId: step.stepId, laneId: step.flow.laneId, labels: step.labels?.map(label => ({ token: label.token, at: label.at, anchorRefs: label.anchorRefs })) }))) &&
      reopened.context.reactionSteps.every(step => step.checks.layout.status === 'passed'));
    for (const format of ['png', 'svg']) {
      const result = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(format) + ')');
      if (!result.ok) throw Error('image export failed');
      fs.writeFileSync(path.join(out, 'final.' + format), Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    }
    report.ok = report.realModelRequests === 0 && report.browserErrors.length === 0;
  } catch (error) { report.ok = false; report.failure = String(error.stack || error); }
  finally { clearTimeout(watchdog); write(); console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.pass).length,
    total: report.checks.length, failure: report.failure, out })); win?.destroy(); app.exit(report.ok ? 0 : 1); }
});
