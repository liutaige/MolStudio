'use strict';
// Native text repaint measurements must not invalidate a rolled-back batch.
// Real canvas, no model. MOLSTUDIO_TEXT_REVISION_SOURCE=1 injects only the
// current source bridge for pre-build diagnosis; default tests served resources.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { revisionSource } = require('../workbench/agent-bridge.js');
const { canonical } = require('./agent_long_route_audit.cjs');
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-text-revision-real');
const INJECT = process.env.MOLSTUDIO_TEXT_REVISION_SOURCE === '1';
fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-text-revision-')));
const source = fs.readFileSync(path.join(__dirname, 'fixtures/reagent-right-regression.molwork'), 'utf8');
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html', service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49083),
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current served resources', sourceBridgeInjected: INJECT,
  modelRequests: 0, scope: 'Revision fencing only: a known docking rejection is retained as a rejection. Derived native text measurements may repaint, while authored text position/content edits must invalidate the run.', checks: [] };
let win;
const write = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const timer = setTimeout(() => { report.ok = false; report.failure = 'watchdog'; write(); win?.destroy(); app.exit(2); }, 90_000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = script => win.webContents.executeJavaScript(script);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); if (!pass) throw new Error(name); };
  const snapshot = async () => js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench(),history:MolWorkbench.app.adapter.ed.historySize()}))()');
  try {
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 400 && !await js('!!k3dAPI?.workbenchReady?.()'); i++) await new Promise(resolve => setTimeout(resolve, 80));
    await js('k3dAPI.agent.getContext()');
    if (INJECT) { await js(fs.readFileSync(path.join(__dirname, '../workbench/agent-bridge.js'), 'utf8')); await js('k3dAPI.agent.getContext()'); }
    check('historical regression fixture loads', (await js('k3dAPI.loadWorkbench(' + JSON.stringify(source) + ')')).ok);
    await js('MolWorkbench.app.adapter.ed.clearHistory();void 0;');
    report.nativeTextFields = await js('[...MolWorkbench.app.adapter.ed.struct().texts.values()].map(text=>Object.keys(text))');
    check('native text stores content and position rather than measured KET bounding boxes', report.nativeTextFields.every(keys => keys.includes('content') && keys.includes('position') && !keys.includes('boundingBox')), report.nativeTextFields);
    const before = await snapshot();
    await js("k3dAPI.agent.beginRun('rollback-fence')");
    const failed = await js(`(async()=>{try{await k3dAPI.agent.applyOperations([{id:'known-bad-left-dock',type:'reactionStep.modify',stepId:${JSON.stringify(before.context.reactionSteps[0].stepId)},expectedVersion:1,layout:{reagentPlacement:'left'}}],{runId:'rollback-fence'});return null;}catch(error){return {code:error.code,message:error.message,layoutFailures:error.layoutFailures};}})()`);
    check('the known manual-LP docking problem is rejected without weakening routing checks', failed?.code === 'reaction_reagent_layout_failed', failed);
    const rolled = await snapshot();
    check('rollback restores every authored source field and keeps native history unchanged',
      canonical(revisionSource(JSON.parse(before.source))) === canonical(revisionSource(JSON.parse(rolled.source))) && rolled.history.undo === before.history.undo);
    await js('MolWorkbench.app.adapter.ed.zoom(MolWorkbench.app.adapter.zoom()*0.91);MolWorkbench.app.adapter.ed.render.update();void 0;');
    await js('new Promise(resolve=>setTimeout(resolve,80))');
    const repainted = await snapshot();
    check('repainting at another zoom does not advance the authored revision', repainted.context.revision === before.context.revision,
      { before: before.context.revision, after: repainted.context.revision });
    const next = await js("(async()=>{try{return await k3dAPI.agent.applyOperations([{id:'legal-after-rollback',type:'text.add',text:'rollback remained editable'}],{runId:'rollback-fence'});}catch(error){return {error:error.code,message:error.message};}})()");
    check('the same active run accepts a legal operation after rejection and repaint', !next.error && next.created.some(item => item.id === 'legal-after-rollback'), next.error && next);
    await js("k3dAPI.agent.endRun('rollback-fence')");
    for (const kind of ['move', 'content', 'style']) {
      await js('k3dAPI.loadWorkbench(' + JSON.stringify(source) + ')');
      await js('k3dAPI.agent.getContext()');
      await js('k3dAPI.agent.beginRun(' + JSON.stringify('manual-' + kind) + ')');
      const edited = await js(`(()=>{const ed=MolWorkbench.app.adapter.ed,[id,text]=[...ed.struct().texts][0];const before={content:text.content,x:text.position.x,y:text.position.y};
        ${kind === 'move' ? 'text.position.x+=0.25;' : kind === 'content' ? "text.content=text.content.replace('Δ','NaOMe');"
          : "const rich=JSON.parse(text.content);const leaf=rich.root.children.flatMap(p=>p.children||[]).find(c=>c.type==='text');if(!leaf)throw new Error('native rich text leaf missing');leaf.format=(leaf.format||0)^1;text.content=JSON.stringify(rich);"}
        ed.render.ctab.markItem('texts',id,1);ed.update(true);return {changed:before.content!==text.content||before.x!==text.position.x||before.y!==text.position.y};})()`);
      await js('Promise.resolve()');
      const outcome = await js(`(async()=>{try{await k3dAPI.agent.applyOperations([{id:'must-not-apply-${kind}',type:'text.add',text:'must be fenced'}],{runId:'manual-${kind}'});return null;}catch(error){return {code:error.code,message:error.message};}})()`);
      check('a real native text ' + kind + ' edit still invalidates the active run', edited.changed && outcome?.code === 'stale_canvas', outcome);
      await js('k3dAPI.agent.endRun(' + JSON.stringify('manual-' + kind) + ')');
    }
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error.stack || error); }
  finally { write(); clearTimeout(timer); console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(item => item.pass).length,
    total: report.checks.length, failure: report.failure, out: OUT }, null, 2)); win.destroy(); app.exit(report.ok ? 0 : 1); }
});
