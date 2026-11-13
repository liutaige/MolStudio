'use strict';
// Main canvas/native engine and real .molwork lifecycle, no model traffic.
// MOLSTUDIO_PORT=49135 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
// MOLSTUDIO_TEST_BUILD=/absolute/path/MolStudio.app \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_task_checkpoint_real.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-task-checkpoint-real');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-task-checkpoint-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'unspecified served build',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49135),
  scope: 'Native canvas task-checkpoint fences, document lifecycle and no automatic model execution; synthetic metadata only.',
  checks: [], artifacts: [], startedAt: new Date().toISOString() };
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let win;
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'fixture watchdog'; write(); win?.destroy(); app.exit(2); }, 120_000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); if (!pass) throw new Error(name); };
  try {
    await win.loadURL(report.service + '/canvas.html');
    const started = Date.now();
    while (!await js('!!k3dAPI?.workbenchReady?.() && !!molstudioAgent?.getRuntime?.()')) {
      if (Date.now() - started > 40_000) throw new Error('Canvas/runtime did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await js(`(async()=>{
      await k3dAPI.setMolecule(''); MolWorkbench.app.adapter.ed.clearHistory();
      const rt=molstudioAgent.getRuntime(), original=rt._fetch;
      window.__checkpointModelRequests=0;
      rt._fetch=async function(url,init){if(url==='/api/agent/model')window.__checkpointModelRequests++;return original.call(this,url,init)};
      window.__checkpointFixture={version:1,taskId:'task-checkpoint-test',mode:'phased',goal:'Draw a two-stage synthetic task',
        status:'paused',phaseIndex:1,requestIndex:3,phases:[
          {id:'stage-a',objective:'Draw first stage',kind:'draw',status:'completed',operationIds:['first-op'],summary:'Committed'},
          {id:'stage-b',objective:'Draw second stage',kind:'draw',status:'active',operationIds:[]}],
        completedOperationIds:['first-op'],checks:{status:'pending',issues:[]},pauseReason:'user',updatedAt:1};
    })()`);
    const before = await js(`(async()=>{const c=await k3dAPI.agent.getContext(),h=MolWorkbench.app.adapter.ed.historySize();
      return{sessionId:c.sessionId,revision:c.revision,undo:h.undo,redo:h.redo,dirty:window.__mechDirtyTick||0}})()`);
    await js("k3dAPI.agent.beginRun('checkpoint-run-a')");
    const stored = await js("k3dAPI.agent.setTaskCheckpoint('checkpoint-run-a',__checkpointFixture)");
    const after = await js(`(async()=>{const c=await k3dAPI.agent.getContext(),h=MolWorkbench.app.adapter.ed.historySize();
      return{sessionId:c.sessionId,revision:c.revision,undo:h.undo,redo:h.redo,dirty:window.__mechDirtyTick||0}})()`);
    check('checkpoint write marks the document dirty without changing canvas revision or native history',
      before.sessionId === after.sessionId && before.revision === after.revision && before.undo === after.undo && before.redo === after.redo && after.dirty > before.dirty,
      { before, after });
    check('bridge returns the saved checkpoint', stored?.taskId === 'task-checkpoint-test' && stored?.phaseIndex === 1);
    await js("(async()=>{const c=await k3dAPI.agent.getTaskCheckpoint();c.goal='mutated';c.phases[0].operationIds.push('mutated');__checkpointFixture.goal='also mutated'})()");
    let untouched = await js('k3dAPI.agent.getTaskCheckpoint()');
    check('input and returned checkpoint copies cannot mutate bridge state', untouched.goal === 'Draw a two-stage synthetic task' && untouched.phases[0].operationIds.length === 1);
    const invalidSetter = await js(`(async()=>{const bad=await k3dAPI.agent.getTaskCheckpoint();bad.checks.status='invalid';try{await k3dAPI.agent.setTaskCheckpoint('checkpoint-run-a',bad);return false}catch{return true}})()`);
    check('invalid checkpoint writes are rejected without changing stored task', invalidSetter && JSON.stringify(await js('k3dAPI.agent.getTaskCheckpoint()')) === JSON.stringify(untouched));
    await js("k3dAPI.agent.beginRun('checkpoint-run-b')");
    const stale = await js(`(async()=>{const c=await k3dAPI.agent.getTaskCheckpoint();c.goal='stale write';try{await k3dAPI.agent.setTaskCheckpoint('checkpoint-run-a',c);return false}catch{return true}})()`);
    check('starting run B fences checkpoint writes from run A', stale && JSON.stringify(await js('k3dAPI.agent.getTaskCheckpoint()')) === JSON.stringify(untouched));
    await js("k3dAPI.agent.setTaskCheckpoint('checkpoint-run-b'," + JSON.stringify(untouched) + ')');
    const draw = await js("k3dAPI.agent.applyOperations([{id:'fresh-op',type:'molecule.add',smiles:'C'}],{runId:'checkpoint-run-b'})");
    const afterDraw = await js('k3dAPI.agent.getTaskCheckpoint()');
    check('a successful native transaction records its operation atomically in the active phase ledger',
      draw?.created?.some(item => item.id === 'fresh-op') && afterDraw?.completedOperationIds?.includes('fresh-op') &&
      afterDraw?.phases?.[1]?.operationIds?.includes('fresh-op'));
    await js("k3dAPI.agent.setTaskCheckpoint('checkpoint-run-b'," + JSON.stringify(untouched) + ')');
    untouched = await js('k3dAPI.agent.getTaskCheckpoint()');
    check('a stale metadata copy cannot erase newly committed operation IDs', untouched.completedOperationIds.includes('fresh-op') && untouched.phases[1].operationIds.includes('fresh-op'));
    const saved = await js('k3dAPI.serializeWorkbench()');
    fs.writeFileSync(path.join(out, 'checkpoint.molwork'), saved); report.artifacts.push('checkpoint.molwork');
    check('serialized main-canvas document includes the exact checkpoint', JSON.stringify(JSON.parse(saved).agentTask) === JSON.stringify(untouched));
    const load = await js('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')');
    await new Promise(resolve => setTimeout(resolve, 250));
    check('save and reopen preserve the task without starting a model request', load?.ok === true &&
      JSON.stringify(await js('k3dAPI.agent.getTaskCheckpoint()')) === JSON.stringify(untouched) && await js('__checkpointModelRequests') === 0);
    await js("k3dAPI.agent.beginRun('checkpoint-run-c')");
    // Runtime claims its restored task before it can issue any drawing operation.
    await js("k3dAPI.agent.setTaskCheckpoint('checkpoint-run-c'," + JSON.stringify(untouched) + ')');
    const retry = await js(`(async()=>{try{await k3dAPI.agent.applyOperations([{id:'fresh-op',type:'molecule.add',smiles:'C'}],{runId:'checkpoint-run-c'});return{rejected:false}}catch(e){return{rejected:true,code:e.code}}})()`);
    const afterRetry = await js('k3dAPI.agent.getContext()');
    check('after reopen a prior primitive operation ID cannot create a duplicate', retry.rejected && retry.code === 'operation_conflict' && afterRetry.molecules.length === 1,
      { retry, molecules: afterRetry.molecules.length });
    await js("k3dAPI.agent.pauseTaskCheckpoint('checkpoint-run-b','late pause')");
    check('late pause from the old document cannot mutate the reopened checkpoint', JSON.stringify(await js('k3dAPI.agent.getTaskCheckpoint()')) === JSON.stringify(untouched));
    const malformed = JSON.parse(saved); malformed.agentTask.apiKey = 'not-a-real-key';
    const badLoad = await js('k3dAPI.loadWorkbench(' + JSON.stringify(JSON.stringify(malformed)) + ')');
    check('invalid checkpoint import fails atomically and retains the current task', badLoad?.ok === false &&
      JSON.stringify(await js('k3dAPI.agent.getTaskCheckpoint()')) === JSON.stringify(untouched));
    const independent = structuredClone(untouched);
    independent.taskId = 'independent-task'; independent.phaseIndex = 0; independent.completedOperationIds = [];
    independent.phases.forEach((phase, index) => { phase.status = index ? 'pending' : 'active'; phase.operationIds = []; delete phase.summary; });
    await js("k3dAPI.agent.beginRun('checkpoint-run-d')");
    await js("k3dAPI.agent.setTaskCheckpoint('checkpoint-run-d'," + JSON.stringify(independent) + ')');
    const newTaskDraw = await js("k3dAPI.agent.applyOperations([{id:'fresh-op',type:'molecule.add',smiles:'C'}],{runId:'checkpoint-run-d'})");
    check('a distinct new task may use its own identical operation ID', newTaskDraw?.created?.some(item => item.id === 'fresh-op') &&
      (await js('k3dAPI.agent.getContext()')).molecules.length === 2);
    await js("k3dAPI.setMolecule('')");
    check('replacing the document with a new molecule clears the old task and sends no model request',
      await js('k3dAPI.agent.getTaskCheckpoint()') === null && await js('__checkpointModelRequests') === 0);
    fs.writeFileSync(path.join(out, 'canvas-window.png'), (await win.capturePage()).toPNG()); report.artifacts.push('canvas-window.png');
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error?.stack || error); }
  finally { clearTimeout(watchdog); write(); console.log(JSON.stringify({ ok: report.ok,
    passed: report.checks.filter(c => c.pass).length, total: report.checks.length, failure: report.failure, out }, null, 2));
    win.destroy(); app.exit(report.ok ? 0 : 1); }
});
