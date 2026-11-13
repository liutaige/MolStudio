'use strict';
// Real canvas/native engine/runtime, synthetic SSE only. No external model call.
// MOLSTUDIO_PORT=49081 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_resume_upstream_real.cjs
// Add MOLSTUDIO_TEST_AUTO_RECOVERY=1 to exercise bounded automatic continuation.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonical } = require('./agent_long_route_audit.cjs');
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-resume-upstream-real');
const AUTO_RECOVERY = process.env.MOLSTUDIO_TEST_AUTO_RECOVERY === '1';
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-resume-upstream-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current served resources',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49081),
  scope: 'A sealed complete SN2 survives upstream_stream_error during the next partial tool object. ' +
    (AUTO_RECOVERY ? 'Bounded automatic continuation' : 'Explicit continuation') + ' repeats operation IDs without duplicating native entities.',
  automaticRecovery: AUTO_RECOVERY,
  realModelRequests: 0, checks: [], browserErrors: [] };
let win;
const write = () => fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'fixture watchdog'; write(); win?.destroy(); app.exit(2); }, 120_000);
const identity = context => canonical({ atoms: context.atoms.map(atom => atom.id).sort(), bonds: context.bonds.map(bond => bond.id).sort(),
  pairs: context.lonePairs.map(pair => ({ id: pair.id, ownerAtomId: pair.ownerAtomId, refAtomId: pair.refAtomId, angleRel: pair.angleRel })),
  arrows: context.arrows.map(arrow => ({ id: arrow.id, source: arrow.source, target: arrow.target, bend: Math.round(arrow.geometry.bend * 1e6) / 1e6 })),
  steps: context.reactionSteps.map(step => ({ id: step.stepId, version: step.version, reactants: step.reactants, products: step.products,
    checked: step.checks.layout.checkedArrowIds.slice().sort(), status: step.checks.layout.status })) });
const geometryMatches = (before, after) => {
  const points = new Map(after.atoms.map(atom => [atom.id, atom]));
  const first = before.atoms.slice().sort((a, b) => a.id.localeCompare(b.id))[0], origin = points.get(first.id);
  return before.atoms.every(atom => { const other = points.get(atom.id); return other &&
    Math.abs((atom.x - first.x) - (other.x - origin.x)) < 0.002 && Math.abs((atom.y - first.y) - (other.y - origin.y)) < 0.002; });
};
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: [report.service + '/api/agent/model*'] }, (_details, callback) => {
    report.realModelRequests++; callback({ cancel: true });
  });
  win.webContents.on('console-message', event => { if (event.level === 'error') report.browserErrors.push(event.message.slice(0, 500)); });
  const js = source => win.webContents.executeJavaScript(source);
  const until = async (condition, limit = 30_000) => { const started = Date.now(); while (!await js(condition)) {
    if (Date.now() - started > limit) throw new Error('Timed out: ' + condition); await new Promise(resolve => setTimeout(resolve, 40)); } };
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); if (!pass) throw new Error(name); };
  const capture = async name => {
    const result = await js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench(),undo:MolWorkbench.app.adapter.ed.historySize().undo}))()');
    fs.writeFileSync(path.join(OUT, name + '.molwork'), result.source);
    fs.writeFileSync(path.join(OUT, name + '-context.json'), JSON.stringify(result.context, null, 2)); return result;
  };
  try {
    await win.loadURL(report.service + '/canvas.html');
    await until('!!k3dAPI?.workbenchReady?.() && !!molstudioAgent?.getRuntime?.()', 40_000);
    await js(String.raw`(async()=>{
      const rt=molstudioAgent.getRuntime(),api=k3dAPI.agent;rt.reset();rt._recoverUpstream=${AUTO_RECOVERY};await k3dAPI.setMolecule('');MolWorkbench.app.adapter.ed.clearHistory();
      const s=window.__resumeUpstream={requests:0,events:[],applied:[],halfSent:false,releaseError:null,scheduledSnapshotPromise:null};
      addEventListener('molstudio:agent-event',event=>{const e=event.detail;s.events.push({type:e.type,toolName:e.toolName,status:e.status,reason:e.reason,canContinue:e.canContinue,code:e.code,isError:e.isError,
        attempt:e.attempt,recoveryAttempts:e.recoveryAttempts,httpRequests:e.httpRequests});
        if(e.type==='recovery_scheduled')s.scheduledSnapshotPromise=(async()=>({context:await api.getContext(),source:await k3dAPI.serializeWorkbench(),
          undo:MolWorkbench.app.adapter.ed.historySize().undo,requests:s.requests}))();});
      const originalApply=api.applyOperations;api.applyOperations=async function(ops,settings){const result=await originalApply.call(this,ops,settings);s.applied.push({ids:ops.map(op=>op.id),types:ops.map(op=>op.type),created:result.created.map(item=>({id:item.id,type:item.type,entityIds:item.entityIds})),steps:result.steps.map(item=>({stepId:item.stepId,replayed:item.replayed,action:item.action}))});return result;};
      const ops=prefix=>[
        {id:prefix+'step',type:'reactionStep.create',reactants:[prefix+'nuc:1',prefix+'sub:1'],products:[prefix+'prod:1',prefix+'br:1'],layout:{}},
        {id:prefix+'nuc',type:'molecule.add',smiles:'[OH-:1]'},
        {id:prefix+'sub',type:'molecule.add',smiles:'[CH3:1][Br:2]'},
        {id:prefix+'prod',type:'molecule.add',smiles:'[CH3:1][OH:2]'},
        {id:prefix+'br',type:'molecule.add',smiles:'[Br-:1]'},
        {id:prefix+'pair',type:'lonePair.add',atom:prefix+'nuc:1'},
        {id:prefix+'attack',type:'arrow.add',source:{type:'lonePair',id:prefix+'pair'},target:{type:'formingBond',atom1:prefix+'nuc:1',atom2:prefix+'sub:1'},electronCount:2},
        {id:prefix+'leave',type:'arrow.add',source:{type:'bond',atom1:prefix+'sub:1',atom2:prefix+'sub:2',component:'sigma'},target:{type:'atom',atomId:prefix+'sub:2'},electronCount:2}];
      const first=ops('first-'),second=ops('second-'),seal=id=>({id,type:'step.seal'}),encoder=new TextEncoder();
      const frame=(delta,finish_reason=null)=>encoder.encode('data: '+JSON.stringify({id:'synthetic-upstream',created:0,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
      const nativeFetch=rt._fetch;
      rt._fetch=async function(url,init){if(url!=='/api/agent/model')return nativeFetch(url,init);s.requests++;
        if(s.requests===1)return new Response(new ReadableStream({async start(controller){
          const prefix='{"operations":['+[...first,seal('seal-first')].map(JSON.stringify).join(',')+',';
          controller.enqueue(frame({role:'assistant',tool_calls:[{index:0,id:'interrupted-drawing',type:'function',function:{name:'draw_operations',arguments:prefix}}]}));
          for(let i=0;i<600&&!s.events.some(e=>e.type==='step_commit');i++)await new Promise(resolve=>setTimeout(resolve,20));
          if(!s.events.some(e=>e.type==='step_commit')){controller.error(new Error('first seal did not commit'));return;}
          controller.enqueue(frame({tool_calls:[{index:0,function:{arguments:'{"id":"second-nuc","type":"molecule.add","smiles":"[OH-'}}]}));
          s.halfSent=true;await new Promise(resolve=>{s.releaseError=resolve;});
          controller.enqueue(encoder.encode('data: '+JSON.stringify({error:{type:'upstream_error',code:'upstream_stream_error'}})+'\n\n'));controller.close();
        }}),{headers:{'Content-Type':'text/event-stream'}});
        if(s.requests===2){if(${AUTO_RECOVERY})await s.scheduledSnapshotPromise;return new Response(new ReadableStream({start(controller){const input={operations:[...first,seal('seal-first'),...second,seal('seal-second')],taskScope:{type:'completeMechanism'},finish:true};
          controller.enqueue(frame({role:'assistant',tool_calls:[{index:0,id:'explicit-resume-drawing',type:'function',function:{name:'draw_operations',arguments:JSON.stringify(input)}}]}));
          controller.enqueue(frame({},'tool_calls'));controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
        throw new Error('No automatic replay or additional synthetic model request is permitted');};
      s.firstIds=first.map(op=>op.id);s.secondIds=second.map(op=>op.id);
    })()`);
    await js("window.__resumeUpstream.pending=molstudioAgent.send('画两条独立的氢氧根与溴甲烷SN2完整机理，包含各自产物和电子流。');void 0;");
    await until('__resumeUpstream.halfSent && !!__resumeUpstream.releaseError');
    const sealed = await capture('sealed-before-error');
    check('a complete sealed reaction is already native while the next tool object is partial', sealed.context.atoms.length === 6 && sealed.context.molecules.length === 4 &&
      sealed.context.arrows.length === 2 && sealed.context.reactionSteps.length === 1 && sealed.undo === 1);
    await js('__resumeUpstream.releaseError();void 0;');
    let interrupted;
    if (AUTO_RECOVERY) {
      await until('!!__resumeUpstream.scheduledSnapshotPromise');
      interrupted = await js('__resumeUpstream.scheduledSnapshotPromise');
      fs.writeFileSync(path.join(OUT, 'recovery-scheduled.molwork'), interrupted.source);
      fs.writeFileSync(path.join(OUT, 'recovery-scheduled-context.json'), JSON.stringify(interrupted.context, null, 2));
      report.interrupted = await js('__resumeUpstream.events.find(event=>event.type==="run_end")');
      const task = JSON.parse(interrupted.source).agentTask, firstIds = await js('__resumeUpstream.firstIds');
      check('automatic recovery schedules only after preserving the sealed IDs and paused checkpoint',
        report.interrupted?.status === 'needs_continue' && report.interrupted.canContinue === true && interrupted.requests === 1 &&
        identity(interrupted.context) === identity(sealed.context) && interrupted.undo === 1 && task.status === 'paused' &&
        firstIds.every(id => task.completedOperationIds.includes(id)) && !task.completedOperationIds.includes('second-nuc'), report.interrupted);
    } else {
      report.interrupted = await js('__resumeUpstream.pending');
      interrupted = await capture('interrupted');
      check('upstream_stream_error retains the seal and exposes explicit continuation', report.interrupted.status === 'needs_continue' && report.interrupted.canContinue === true &&
        identity(interrupted.context) === identity(sealed.context) && interrupted.undo === 1, report.interrupted);
    }
    check('the unfinished second object never enters native source or history', interrupted.context.atoms.length === 6 && interrupted.context.lonePairs.length === 1 && interrupted.context.reactionSteps.length === 1);
    if (AUTO_RECOVERY) report.resumed = await js('__resumeUpstream.pending');
    else {
      await js('new Promise(resolve=>setTimeout(resolve,150))');
      check('the transport does not automatically replay an interrupted model request', await js('__resumeUpstream.requests') === 1);
      report.resumed = await js('molstudioAgent.getRuntime().continue()');
    }
    const completed = await capture('completed');
    check((AUTO_RECOVERY ? 'automatic recovery' : 'explicit continue') + ' completes with exactly one new request',
      report.resumed.status === 'completed' && await js('__resumeUpstream.requests') === 2 && (!AUTO_RECOVERY || report.resumed.recoveryAttempts === 1), report.resumed);
    check('repeated first-step operation IDs create no duplicate molecules steps pairs or flows', completed.context.atoms.length === 12 && completed.context.bonds.length === 4 &&
      completed.context.molecules.length === 8 && completed.context.lonePairs.length === 2 && completed.context.arrows.length === 4 && completed.context.reactionSteps.length === 2,
      { atoms: completed.context.atoms.length, molecules: completed.context.molecules.length, flows: completed.context.arrows.length, steps: completed.context.reactionSteps.length });
    check('the first committed stable identities survive ' + (AUTO_RECOVERY ? 'automatic' : 'explicit') + ' continuation', sealed.context.atoms.every(atom=>completed.context.atoms.some(other=>other.id===atom.id)) &&
      sealed.context.arrows.every(arrow=>completed.context.arrows.some(other=>other.id===arrow.id)) && sealed.context.reactionSteps.every(step=>completed.context.reactionSteps.some(other=>other.stepId===step.stepId)));
    const state = await js('({requests:__resumeUpstream.requests,events:__resumeUpstream.events,applied:__resumeUpstream.applied,firstIds:__resumeUpstream.firstIds})');
    report.synthetic = state;
    if (AUTO_RECOVERY) check('native recovery uses one scheduled restart and accumulates both HTTP requests',
      state.events.filter(event => event.type === 'recovery_scheduled').length === 1 && state.events.filter(event => event.type === 'recovery_started').length === 1 &&
      report.resumed.httpRequests === 2 && state.events.filter(event => event.type === 'run_end').at(-1).httpRequests === 2);
    check('committed entities are created once while semantic retries only replay observations',
      state.firstIds.every(id=>state.applied.flatMap(batch=>batch.created).filter(item=>item.id===id).length===1) &&
      state.applied.filter(batch=>batch.ids.includes('first-step')&&!batch.ids.includes('first-nuc'))
        .every(batch=>batch.created.length===0&&batch.steps.every(step=>step.replayed===true)), state.applied.map(batch=>batch.ids));
    check('both complete reactions have real native layout checks covering both flows', completed.context.reactionSteps.every(step=>step.checks.layout.status==='passed'&&step.checks.layout.checkedArrowIds.length===2));
    check('the continuation adds exactly one undo transaction', completed.undo === 2);
    await js('document.activeElement?.blur?.();k3dAPI.undo();void 0;');const undone=await capture('undo');
    check('one undo removes only the continued reaction', identity(undone.context)===identity(interrupted.context)&&geometryMatches(interrupted.context,undone.context));
    await js('document.activeElement?.blur?.();k3dAPI.redo();void 0;');const redone=await capture('redo');
    check('redo restores the complete source with stable identities and geometry',identity(redone.context)===identity(completed.context)&&geometryMatches(completed.context,redone.context));
    const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(completed.source)+')');const reopened=await capture('reopened');
    check('save and reopen preserve all IDs endpoint references geometry and real step coverage',loaded.ok&&identity(reopened.context)===identity(completed.context)&&geometryMatches(completed.context,reopened.context));
    for(const kind of ['png','svg']){const exportResult=await js('k3dAPI.exportMechanismImage('+JSON.stringify(kind)+')');if(!exportResult?.ok)throw new Error('Export failed: '+kind);fs.writeFileSync(path.join(OUT,'final.'+kind),Buffer.from(exportResult.dataUrl.split(',')[1],'base64'));}
    report.ok=report.browserErrors.length===0 && report.realModelRequests===0;
  } catch(error){report.ok=false;report.failure=String(error.stack||error);report.synthetic=await js('window.__resumeUpstream?{requests:__resumeUpstream.requests,events:__resumeUpstream.events,applied:__resumeUpstream.applied}:null').catch(()=>null);}
  finally{write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(check=>check.pass).length,total:report.checks.length,failure:report.failure,out:OUT},null,2));win.destroy();app.exit(report.ok?0:1);}
});
