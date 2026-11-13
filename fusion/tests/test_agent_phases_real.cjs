// A bounded live-model acceptance of the host phase scheduler on the real canvas.
// MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/path \
//   MOLSTUDIO_TEST_BUILD=/absolute/path/MolStudio.app \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_phases_real.cjs
// Run the packaged service separately with an isolated config and the user's
// configured model. This probe records enumerated generation fields, request
// counts, phase IDs and native receipts; never secrets or hidden reasoning.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.env.MOLSTUDIO_REAL_AGENT !== '1' || !process.env.MOLSTUDIO_AGENT_TEST_OUT) {
  console.error('Explicit MOLSTUDIO_REAL_AGENT=1 and MOLSTUDIO_AGENT_TEST_OUT are required.');
  process.exit(2);
}
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT);
const port = Number(process.env.MOLSTUDIO_PORT) || 49075;
const limit = Math.min(20, Math.max(3, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 12));
const timeout = Math.min(1_200_000, Math.max(60_000, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 900_000));
const expectedEffort = process.env.MOLSTUDIO_AGENT_EXPECT_EFFORT || 'low';
if (!['low', 'high'].includes(expectedEffort)) throw new Error('MOLSTUDIO_AGENT_EXPECT_EFFORT must be low or high');
const prompt = '请绘制乙醛与甲醇在酸催化下形成半缩醛的完整逐步机理：以水合氢离子为实际酸，依次展示羰基质子化、甲醇进攻、由水去质子并再生水合氢离子。转移的氢请显式画出，画出各步骤实际电子流和产物。请先自行将任务组织成至少两个依次执行的阶段，前一阶段完成后再继续下一阶段；保留已画内容，不要重复绘制，最终在聊天中简短解释每一步及酸催化剂如何再生。';
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-phases-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'unspecified served build', service: `http://127.0.0.1:${port}`,
  model: 'configured service model', prompt, requestLimit: limit, expectedEffort, startedAt: new Date().toISOString(),
  privacy: 'Only selected generation fields and local tool/phase/receipt metadata are recorded; no raw provider payload, key or hidden reasoning.',
  checks: [], artifacts: [], status: 'starting' };
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let win, done = false;
const watchdog = setTimeout(() => {
  report.status = 'timeout'; report.ok = false; write();
  win?.webContents.executeJavaScript("molstudioAgent?.stop?.('test_timeout')").catch(() => {});
  setTimeout(() => { win?.destroy(); app.exit(2); }, 10_000);
}, timeout);

function installProbe(requestLimit) {
  const rt = molstudioAgent.getRuntime(), api = k3dAPI.agent, fetch = rt._fetch, apply = api.applyOperations;
  const state = window.__phaseAcceptance = { requests: [], events: [], batches: [], currentPhase: null, visibleExplanation: '', visibleSegments: [],
    stoppedAtBoundary: false, denyNextStage: true, rejectedBudget: false };
  const safeSettings = value => {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of ['profile', 'effort', 'maxOutputTokens', 'thinking', 'reasoning_effort', 'max_tokens']) {
      const item = value[key];
      if (typeof item === 'string' && /^[a-z-]{1,32}$/.test(item) || Number.isFinite(item) || item === null) result[key] = item;
      else if (key === 'thinking' && ['enabled', 'disabled', 'adaptive'].includes(item?.type)) result.thinking = { type: item.type };
    }
    for (const key of ['requested', 'effective', 'fields']) if (value[key] && typeof value[key] === 'object') result[key] = safeSettings(value[key]);
    for (const key of ['forwardedToConfiguredEndpoint', 'downstreamConfirmed']) if (typeof value[key] === 'boolean') result[key] = value[key];
    return result;
  };
  rt._fetch = async function(url, init) {
    if (url !== '/api/agent/model') return fetch(url, init);
    if (state.denyNextStage && state.events.some(event => event.type === 'phase_end') && state.currentPhase &&
        state.currentPhase.phaseIndex > 0) {
      state.stoppedAtBoundary = true; state.denyNextStage = false;
      molstudioAgent.stop('user');
      throw new DOMException('Acceptance intentionally stopped at a phase boundary', 'AbortError');
    }
    if (state.requests.length >= requestLimit) { state.rejectedBudget = true; throw new Error('test_request_limit'); }
    const row = { number: state.requests.length + 1, phaseId: state.currentPhase?.phaseId || null,
      phaseIndex: state.currentPhase?.phaseIndex ?? null, startedAt: new Date().toISOString() };
    state.requests.push(row);
    try {
      const response = await fetch(url, init); row.status = response.status;
      const header = response.headers.get('X-MolStudio-Generation');
      if (header) try { row.generation = safeSettings(JSON.parse(header)); } catch { row.generation = { invalidHeader: true }; }
      row.headersAt = new Date().toISOString(); return response;
    } catch (error) { row.error = error?.name || 'transport_error'; throw error; }
  };
  api.applyOperations = async function(ops, settings) {
    const result = await apply.call(this, ops, settings);
    state.batches.push({ phaseId: state.currentPhase?.phaseId || null, replayed: result?.replayed === true,
      operationIds: ops.map(op => op.id), createdIds: (result?.created || []).map(item => item.id),
      created: (result?.created || []).map(item => ({ id: item.id, type: item.type, entityIds: item.entityIds })),
      stepReceipts: (result?.steps || []).map(step => ({ operationId: step.operationId, stepId: step.stepId, replayed: step.replayed, action: step.action })) });
    return result;
  };
  addEventListener('molstudio:agent-event', event => {
    const e = event.detail;
    if (e.type === 'text_delta' && state.visibleExplanation.length < 12000) {
      const value=String(e.text || e.delta || '').slice(0, 12000 - state.visibleExplanation.length);
      state.visibleExplanation += value;
      state.visibleSegments.push({ phaseId: state.currentPhase?.phaseId || null, finalReport: e.finalReport === true, text: value });
    }
    if (e.type === 'phase_start') state.currentPhase = { taskId: e.taskId, phaseId: e.phaseId, phaseIndex: e.phaseIndex, phaseCount: e.phaseCount };
    if (['phase_start', 'phase_end', 'run_start', 'run_end', 'tool_start', 'tool_end', 'step_commit', 'resume_available', 'error'].includes(e.type)) {
      state.events.push({ type: e.type, taskId: e.taskId, phaseId: e.phaseId, phaseIndex: e.phaseIndex,
        phaseCount: e.phaseCount, objective: e.objective, summary: e.summary, toolName: e.toolName, status: e.status, code: e.code, isError: e.isError,
        at: new Date().toISOString() });
    }
  });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); };
  const artifacts = async name => {
    const result = await js('(async()=>({source:await k3dAPI.serializeWorkbench(),context:await k3dAPI.agent.getContext()}))()');
    fs.writeFileSync(path.join(out, name + '.molwork'), result.source);
    fs.writeFileSync(path.join(out, name + '-context.json'), JSON.stringify(result.context, null, 2));
    report.artifacts.push(name + '.molwork', name + '-context.json');
    for (const kind of ['png', 'svg']) {
      const img = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(kind) + ')');
      if (img?.ok) { fs.writeFileSync(path.join(out, name + '.' + kind), Buffer.from(img.dataUrl.split(',')[1], 'base64')); report.artifacts.push(name + '.' + kind); }
    }
    fs.writeFileSync(path.join(out, name + '-window.png'), (await win.capturePage()).toPNG());
    report.artifacts.push(name + '-window.png'); write(); return result;
  };
  const snapshot = async () => { report.probe = await js('window.__phaseAcceptance || null'); write(); };
  let timer;
  try {
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
    const started = Date.now();
    while (!await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')) {
      if (Date.now() - started > 40_000) throw new Error('Canvas/runtime did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    report.resourceHashes = await js(`(async()=>{const result={};for(const url of ['/agent/dist/agent-runtime.js','/workbench/agent-bridge.js','/workbench/workbench-storage.js']){const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('resource unavailable');const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());result[url]=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}return result})()`);
    await js('(async()=>{molstudioAgent.getRuntime().reset();molstudioAgent.getPanel().clear();await k3dAPI.setMolecule("");MolWorkbench.app.adapter.ed.clearHistory();molstudioAgent.open()})()');
    await js('(' + installProbe.toString() + ')(' + limit + ')');
    timer = setInterval(() => snapshot().catch(() => {}), 5000);
    report.status = 'first-run'; write();
    report.firstRun = await js('molstudioAgent.send(' + JSON.stringify(prompt) + ')');
    await snapshot();
    const stopped = await artifacts('stopped');
    check('model authored a plan and completed at least one phase before the deliberate stop', report.probe.stoppedAtBoundary && report.probe.events.some(e => e.type === 'phase_end') && report.probe.events.some(e => e.type === 'tool_start' && e.toolName === 'plan_task'));
    check('a later phase was held at its request boundary', report.probe.events.filter(e => e.type === 'phase_start').length >= 2 && report.firstRun.status !== 'completed');
    if (!report.probe.stoppedAtBoundary) throw new Error('No second-phase boundary was reached; cannot claim restore/resume acceptance');
    const before = report.probe.requests.length;
    const resumesBeforeLoad = report.probe.events.filter(e => e.type === 'resume_available').length;
    const savedCheckpoint = JSON.parse(stopped.source).agentTask;
    report.load = await js('k3dAPI.loadWorkbench(' + JSON.stringify(stopped.source) + ')');
    report.restore = await js('molstudioAgent.getRuntime().restoreTaskCheckpoint()');
    await new Promise(resolve => setTimeout(resolve, 250)); await snapshot();
    check('saved workbench loads and exposes explicit continuation without starting a request', report.load?.ok === true && report.probe.requests.length === before && report.probe.events.filter(e => e.type === 'resume_available').length > resumesBeforeLoad);
    const reopenedCheckpoint = await js('k3dAPI.agent.getTaskCheckpoint()');
    check('the paused document preserves task and phase identity and committed-operation ledger',
      !!savedCheckpoint && savedCheckpoint.status === 'paused' && savedCheckpoint.mode === 'phased' &&
      savedCheckpoint.taskId === reopenedCheckpoint?.taskId && savedCheckpoint.phaseIndex === reopenedCheckpoint.phaseIndex &&
      JSON.stringify(savedCheckpoint.phases) === JSON.stringify(reopenedCheckpoint.phases) &&
      JSON.stringify(savedCheckpoint.completedOperationIds) === JSON.stringify(reopenedCheckpoint.completedOperationIds));
    report.status = 'resuming'; write();
    report.resumed = await js('molstudioAgent.getRuntime().continue()');
    await snapshot();
    const final = await artifacts('completed');
    const created = report.probe.batches.filter(batch => !batch.replayed).flatMap(batch => batch.createdIds);
    const duplicateCreated = created.filter((id, i) => created.indexOf(id) !== i);
    const applied = report.probe.batches.flatMap(batch => batch.operationIds);
    const repeatedOperations = applied.filter((id, i) => applied.indexOf(id) !== i);
    const phaseRequests = [...new Set(report.probe.requests.map(row => row.phaseId).filter(Boolean))];
    const completedPhaseIds = [...new Set(report.probe.events.filter(e => e.type === 'phase_end').map(e => e.phaseId).filter(Boolean))];
    check('explicit continuation starts a fresh request and at least two completed authored phases each have their own request',
      report.probe.requests.length > before && completedPhaseIds.length >= 2 && completedPhaseIds.every(id => phaseRequests.includes(id)),
      { phaseRequests, completedPhaseIds, requests: report.probe.requests.length });
    check('gateway reports the explicitly selected DeepSeek thinking and output settings for each actual request',
      report.probe.requests.length > 0 && report.probe.requests.every(row => row.generation?.requested?.profile === 'deepseek' &&
        row.generation.requested.effort === expectedEffort && row.generation.fields?.thinking?.type === 'enabled' &&
        row.generation.fields?.reasoning_effort === expectedEffort && row.generation.fields?.max_tokens === 16384 &&
        row.generation.forwardedToConfiguredEndpoint === true && row.generation.downstreamConfirmed === false));
    check('no committed operation ID creates entities twice across stop and reopen', duplicateCreated.length === 0, { duplicateCreated });
    check('no operation ID is submitted again across the phase boundary and reopen', repeatedOperations.length === 0, { repeatedOperations });
    check('previously committed atom and electron-flow identities survive reopening and continuation', stopped.context.atoms.every(a => final.context.atoms.some(b => a.id === b.id)) && stopped.context.arrows.every(a => final.context.arrows.some(b => a.id === b.id)));
    check('task reaches completed state and panel reports completion', report.resumed?.status === 'completed' && await js("document.querySelector('.mol-agent-status')?.textContent === '已完成'"), report.resumed);
    const lastPhase = completedPhaseIds.at(-1), finalSegments = report.probe.visibleSegments.filter(segment => segment.phaseId === lastPhase),
      finalExplanation = finalSegments.filter(segment => segment.finalReport).map(segment => segment.text).join('');
    check('only one checked final-report message is emitted to the user', lastPhase === 'molstudio-final-report' &&
      finalSegments.length === 1 && finalSegments[0].finalReport === true && !!finalExplanation.trim(), { messageCount: finalSegments.length });
    const ledger = JSON.parse(final.source).agentTask;
    const ownReviewIds = (ledger?.phases || []).filter(phase => phase.kind === 'review' && phase.id !== 'molstudio-final-report').map(phase => phase.id);
    const earlyReviewText = report.probe.visibleSegments.filter(segment => ownReviewIds.includes(segment.phaseId)).map(segment => segment.text).join('');
    check('model-authored review phases do not publish a duplicate report before the checked final report',
      !earlyReviewText.trim(), { ownReviewIds, earlyVisibleCharacters: earlyReviewText.length });
    check('visible final explanation covers all three chemical events and catalyst regeneration',
      lastPhase === 'molstudio-final-report' && /质子化|(?:接受|获得|转移|被).{0,8}质子/.test(finalExplanation) &&
      /进攻|亲核/.test(finalExplanation) && /去质子|脱质子|失去质子|移去质子/.test(finalExplanation) &&
      /水合氢离子|催化剂/.test(finalExplanation) && /再生|恢复|重新生成/.test(finalExplanation), { finalExplanation });
    check('bounded task produces reaction steps and electron flows', final.context.reactionSteps.length >= 2 && final.context.arrows.length >= 3,
      { steps: final.context.reactionSteps.length, flows: final.context.arrows.length });
    check('every recorded reaction step passes host layout and covers electron flow', final.context.reactionSteps.every(step => step.checks?.layout?.status === 'passed' && step.checks.layout.checkedArrowIds?.length > 0));
    report.autoCurves = await js(`(async()=>{const MW=MolWorkbench,ctx=MW.app.controller.ctx(),model=MW.app.controller.model,
      unit=MW.route.buildScene(ctx,model).L, snapshot=await k3dAPI.agent.getContext(),atoms=new Map(snapshot.atoms.map(a=>[a.id,a]));
      return model.state.arrows.filter(a=>MW.model.arrowMode(a)==='auto').map(a=>{
        const g=MW.model.arrowGeometry(a,ctx),start=g.start||{x:0,y:0},end=g.end||start,control=g.control||start,dx=end.x-start.x,dy=end.y-start.y,span=Math.hypot(dx,dy);
        const sagittaPerBond=span&&unit?Math.abs(dx*(control.y-start.y)-dy*(control.x-start.x))/(2*span*unit):0;
        const minimumPerBond=span&&unit?Math.min(.4,Math.max(.1,.08*span/unit),.25*span/unit):0;
        const protonTransfer=a.source?.type==='lonePair'&&(a.target?.type==='atom'&&atoms.get(a.target.atomId)?.label==='H'||
          a.target?.type==='formingBond'&&[a.target.atomA,a.target.atomB].includes(a.source.ownerAtomId)&&[a.target.atomA,a.target.atomB].some(id=>atoms.get(id)?.label==='H'));
        return{id:a.id,source:a.source,target:a.target,protonTransfer,
          valid:!!g.start&&!!g.end&&!!g.control&&!!g.sourceOk&&!!g.targetOk&&!g.degenerate,span,sagittaPerBond,minimumPerBond};
      });})()`);
    check('the actual model drawing includes an automatic lone-pair-to-H proton-transfer arrow', report.autoCurves.some(curve => curve.protonTransfer));
    check('every automatic electron-flow arrow has visible curvature and valid actual endpoints', report.autoCurves.length > 0 &&
      report.autoCurves.every(curve => curve.valid && curve.sagittaPerBond + 1e-6 >= curve.minimumPerBond), report.autoCurves.filter(curve => !curve.valid || curve.sagittaPerBond + 1e-6 < curve.minimumPerBond));
    check('the harness request budget was not exceeded', !report.probe.rejectedBudget);
    const build = process.env.MOLSTUDIO_TEST_BUILD || '';
    const python = process.env.MOLSTUDIO_AUDIT_PYTHON || (build.endsWith('.app') ? path.join(build, 'Contents/Resources/python/bin/python3') : path.resolve(__dirname, '../../.venv-rdkit/bin/python'));
    const auditPath = path.join(out, 'chemistry-audit.json');
    const chemistry = spawnSync(python, ['-I', '-B', path.join(__dirname, 'agent_hemiacetal_audit.py'), path.join(out, 'completed-context.json'), auditPath], { encoding: 'utf8', timeout: 30000 });
    if (fs.existsSync(auditPath)) { report.artifacts.push('chemistry-audit.json'); report.chemistryAudit = JSON.parse(fs.readFileSync(auditPath, 'utf8')); }
    check('independent chemistry reconstruction and paired proton-transfer endpoints pass', chemistry.status === 0 && report.chemistryAudit?.automaticChecksPass === true,
      { exitCode: chemistry.status, checks: report.chemistryAudit?.checks, error: chemistry.error?.message });
    report.ok = report.checks.every(row => row.pass);
    report.status = report.ok ? 'pending_manual_review' : 'failed';
    report.acceptanceStatus = report.ok ? 'pending_manual_review' : 'failed';
    report.manualReviewRequired = 'Review final visible explanation for chemically correct charge/formula, each flow direction and actual PNG/layout before accepting.';
  } catch (error) {
    report.ok = false; report.status = 'failed'; report.failure = String(error?.stack || error);
    if (win && !win.isDestroyed()) { await snapshot().catch(() => {}); if (!report.artifacts.length) await artifacts('failure').catch(() => {}); }
  } finally {
    done = true; clearInterval(timer); clearTimeout(watchdog); write();
    console.log(JSON.stringify({ ok: report.ok, status: report.status, passed: report.checks.filter(c => c.pass).length,
      checks: report.checks.length, failure: report.failure, out }, null, 2));
    win.destroy(); app.exit(report.ok ? 0 : 1);
  }
});
