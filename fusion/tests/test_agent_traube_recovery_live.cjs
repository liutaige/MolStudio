'use strict';
// Candidate packaged canvas; actual saved Traube graph; one intentionally
// injected transport failure after a real model commit. No synthetic model
// tool responses. The original input is read only. See report.json for scope.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
if (process.env.MOLSTUDIO_REAL_AGENT !== '1' || !process.env.MOLSTUDIO_AGENT_TEST_OUT || !process.env.MOLSTUDIO_TEST_BUILD || !process.env.MOLSTUDIO_PORT || !process.env.MOLSTUDIO_TRAUBE_SEED) {
  console.error('Required: MOLSTUDIO_REAL_AGENT=1, MOLSTUDIO_AGENT_TEST_OUT, MOLSTUDIO_TEST_BUILD, MOLSTUDIO_PORT, MOLSTUDIO_TRAUBE_SEED'); process.exit(2);
}
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT), seed = path.resolve(process.env.MOLSTUDIO_TRAUBE_SEED);
const build = path.resolve(process.env.MOLSTUDIO_TEST_BUILD), port = Number(process.env.MOLSTUDIO_PORT);
const limit = Math.min(12, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 12));
const expectedEffort = process.env.MOLSTUDIO_AGENT_EXPECT_EFFORT || 'high';
if (!['low', 'high'].includes(expectedEffort)) throw new Error('MOLSTUDIO_AGENT_EXPECT_EFFORT must be low or high');
const timeout = Math.min(1200000, Math.max(60000, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 900000));
const original = fs.readFileSync(seed, 'utf8'), sha = x => crypto.createHash('sha256').update(x).digest('hex');
const expectedHash = sha(original), parsed = JSON.parse(original);
if (parsed.agentTask?.requestIndex !== 30 || parsed.agentTask?.phaseIndex !== 0 || parsed.reactionSteps?.length !== 3) throw new Error('Unexpected source checkpoint; refusing to run');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-traube-')));
const report = { application:'MolStudio canvas', page:'fusion/canvas.html', build, service:`http://127.0.0.1:${port}`,
  scope:'Saved Traube phase 1 only; one injected stream error at a request boundary after an actual model commit; no synthetic model tools.',
  privacy:'No provider response, raw errors, request bodies, hidden reasoning or credentials recorded.',
  sourceSha256:expectedHash, requestLimit:limit, expectedEffort, checks:[], status:'starting', startedAt:new Date().toISOString() };
const write = () => fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report,null,2));
let win;
const watchdog = setTimeout(()=>{ report.status='timeout';report.ok=false;write();win?.webContents.executeJavaScript("molstudioAgent?.stop?.('test_timeout')").catch(()=>{});setTimeout(()=>{win?.destroy();app.exit(2)},5000); },timeout);
function installProbe(limit) {
  const rt=molstudioAgent.getRuntime(), api=k3dAPI.agent, fetch0=rt._fetch, apply0=api.applyOperations, inspect0=api.inspectStructures;
  const s=window.__traube={requests:[],injected:0,batches:[],inspections:[],events:[],phaseEnded:false,budgetDenied:false,beforeInjection:null,atResume:null};
  const signature=ctx=>({atoms:ctx.atoms.map(x=>x.id).sort(),bonds:ctx.bonds.map(x=>x.id).sort(),arrows:ctx.arrows.map(x=>x.id).sort(),steps:ctx.reactionSteps.map(x=>x.stepId).sort()});
  api.inspectStructures=async function(args,opts){const v=await inspect0.call(this,args,opts);s.inspections.push(v.map(x=>({id:x.id,ok:x.ok,bonds:(x.bonds||[]).map(b=>({ref:b.ref,begin:b.begin,end:b.end,order:b.order,nativeType:b.nativeType}))})));return v;};
  api.applyOperations=async function(ops,opts){const v=await apply0.call(this,ops,opts);s.batches.push({ids:ops.map(x=>x.id),types:ops.map(x=>x.type),created:(v.created||[]).map(x=>({id:x.id,type:x.type,entityIds:x.entityIds})),replayed:v.replayed===true});return v;};
  addEventListener('molstudio:agent-event',event=>{const e=event.detail;if(['run_start','run_end','phase_start','phase_end','tool_start','tool_end','step_commit','recovery_scheduled','recovery_started','recovery_exhausted','error'].includes(e.type))s.events.push({type:e.type,toolName:e.toolName,phaseId:e.phaseId,phaseIndex:e.phaseIndex,status:e.status,code:e.code,isError:e.isError,at:new Date().toISOString()});
    if(e.type==='phase_end' && e.phaseIndex===0){s.phaseEnded=true;molstudioAgent.stop('test_phase_boundary');}
  });
  rt._fetch=async function(url,init){if(url!=='/api/agent/model')return fetch0(url,init);
    if(s.phaseEnded){molstudioAgent.stop('test_phase_boundary');throw new DOMException('Stage boundary','AbortError');}
    if(!s.injected && s.batches.some(b=>!b.replayed && b.ids.length)){
      s.beforeInjection=signature(await api.getContext());s.injected++;
      const body='data: '+JSON.stringify({error:{type:'upstream_error',code:'upstream_stream_error'}})+'\n\n';
      return new Response(body,{status:200,headers:{'Content-Type':'text/event-stream'}});
    }
    if(s.injected && !s.atResume)s.atResume=signature(await api.getContext());
    if(s.requests.length>=limit){s.budgetDenied=true;throw new Error('test_request_limit');}
    const row={number:s.requests.length+1,at:new Date().toISOString()};s.requests.push(row);
    const response=await fetch0(url,init);row.status=response.status;row.receivedBytes=0;row.lastBytesAt=null;
    if(response.body){const observer=response.clone().body.getReader();(async()=>{try{for(;;){const part=await observer.read();if(part.done)break;row.receivedBytes+=part.value?.byteLength||0;row.lastBytesAt=new Date().toISOString();}row.streamEndedAt=new Date().toISOString();}catch{row.streamObservationError=true;}finally{observer.releaseLock();}})();}
    const h=response.headers.get('X-MolStudio-Generation');if(h){try{const g=JSON.parse(h);row.generation={requested:g.requested,fields:g.fields,forwardedToConfiguredEndpoint:g.forwardedToConfiguredEndpoint,downstreamConfirmed:g.downstreamConfirmed};}catch{row.generation={invalid:true};}}
    return response;
  };
}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  const check=(name,pass,detail)=>{report.checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});write();};
  const capture=async name=>{const result=await js('(async()=>({source:await k3dAPI.serializeWorkbench(),context:await k3dAPI.agent.getContext()}))()');
    fs.writeFileSync(path.join(out,name+'.molwork'),result.source);fs.writeFileSync(path.join(out,name+'-context.json'),JSON.stringify(result.context,null,2));
    for(const kind of ['png','svg']){const img=await js('k3dAPI.exportMechanismImage('+JSON.stringify(kind)+')');if(img?.ok)fs.writeFileSync(path.join(out,name+'.'+kind),Buffer.from(img.dataUrl.split(',')[1],'base64'));}
    fs.writeFileSync(path.join(out,name+'-window.png'),(await win.capturePage()).toPNG());return result;};
  let timer;
  try{
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
    const start=Date.now();while(!await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')){if(Date.now()-start>40000)throw new Error('canvas_not_ready');await new Promise(r=>setTimeout(r,100));}
    const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(original)+')');
    check('saved canvas loads',loaded?.ok===true);
    await js('molstudioAgent.getRuntime().restoreTaskCheckpoint()');
    const base=await capture('before');
    check('actual saved checkpoint and three original steps loaded',JSON.parse(base.source).agentTask?.requestIndex===30&&base.context.reactionSteps.length===3);
    if(process.env.MOLSTUDIO_TRAUBE_DRY_RUN==='1'){report.ok=report.checks.every(x=>x.pass);report.status='dry_run_no_model';return;}
    await js('('+installProbe.toString()+')('+limit+')');
    timer=setInterval(async()=>{try{report.probe=await js('window.__traube');write();}catch{}},5000);
    report.status='running';write();
    const result=await js('molstudioAgent.getRuntime().continue()');
    report.result={status:result?.status,reason:result?.reason,canContinue:result?.canContinue,recoveryAttempts:result?.recoveryAttempts};
    report.probe=await js('window.__traube');
    const final=await capture('after');
    const checkpoint=JSON.parse(final.source).agentTask, probe=report.probe;
    check('one classified failure was deliberately injected after a real committed batch',probe.injected===1&&probe.batches.some(b=>!b.replayed&&b.ids.length));
    check('automatic recovery issued a fresh real request',probe.events.some(x=>x.type==='recovery_started')&&!!probe.atResume);
    check('all atoms, bonds, arrows and reaction step IDs survived until the fresh recovery request',!!probe.beforeInjection&&!!probe.atResume&&JSON.stringify(probe.beforeInjection)===JSON.stringify(probe.atResume));
    check('isolated DeepSeek effort and 16384 were forwarded to the configured endpoint on each real request',probe.requests.length>0&&probe.requests.every(r=>r.generation?.requested?.profile==='deepseek'&&r.generation.requested.effort===expectedEffort&&r.generation.fields?.max_tokens===16384&&r.generation.fields?.reasoning_effort===expectedEffort&&r.generation.forwardedToConfiguredEndpoint===true&&r.generation.downstreamConfirmed===false),{expectedEffort});
    check('first phase ended and subsequent phases were not drawn',probe.phaseEnded&&checkpoint?.phases?.[0]?.status==='completed'&&checkpoint?.phaseIndex===1&&!probe.events.some(e=>e.type==='phase_end'&&e.phaseIndex>0));
    check('at least four reaction steps are present for the first Traube phase',final.context.reactionSteps.length>=4,{stepCount:final.context.reactionSteps.length,arrowCount:final.context.arrows.length});
    check('all visible steps have passed layout and at least one checked electron flow',final.context.reactionSteps.every(x=>x.checks?.layout?.status==='passed'&&x.checks.layout.checkedArrowIds?.length>0));
    const inspected=probe.inspections.length>0;
    check('model inspection exposed bond metadata when used',!inspected||probe.inspections.some(batch=>batch.some(x=>x.ok&&x.bonds.length&&x.bonds.every(b=>typeof b.order==='number'&&typeof b.nativeType==='number'))),{inspectionObserved:inspected,scope:inspected?'actual model inspection':'not observed; separate endpoint fixture covers this API'});
    check('request budget was not exceeded',!probe.budgetDenied&&probe.requests.length<=limit);
    check('original input remains unchanged',sha(fs.readFileSync(seed,'utf8'))===expectedHash);
    const duplicate=probe.batches.flatMap(b=>b.created).map(x=>x.id).filter((id,i,a)=>a.indexOf(id)!==i);
    check('committed operations did not create the same operation identity twice',duplicate.length===0,{duplicate});
    const {checkMechanismPreflight}=await import('../agent/mechanism-preflight.js');
    const {checkElectronFlowCoverage}=await import('../agent/mechanism-coverage.js');
    const members=refs=>[...new Set(refs.flatMap(ref=>final.context.molecules.find(m=>m.atoms.includes(ref))?.atoms||[]))];
    report.chemistry=final.context.reactionSteps.map(step=>{const input={reactantAtoms:members(step.reactants),productAtoms:members(step.products),atoms:final.context.atoms,bonds:final.context.bonds,lonePairs:final.context.lonePairs,arrows:final.context.arrows,conditions:step.conditions};return{stepId:step.stepId,preflight:checkMechanismPreflight(input),coverage:checkElectronFlowCoverage(input)};});
    check('independent preflight and electron flow coverage pass all visible steps',report.chemistry.every(x=>!x.preflight&&!x.coverage));
    report.ok=report.checks.every(x=>x.pass);report.status=report.ok?'pending_manual_chemistry_and_visual_review':'failed';
    report.manualReview='Inspect A3 structure, charges, products, electron-flow directions, all four steps, continuation labels and screenshot. Passing automatic checks alone does not establish correct Traube chemistry or completion of the other phases.';
  }catch(e){report.ok=false;report.status='failed';report.failureCategory=e?.name||'error';report.probe=await js('window.__traube || null').catch(()=>null);await capture('failure').catch(()=>{});}
  finally{clearInterval(timer);clearTimeout(watchdog);write();console.log(JSON.stringify({ok:report.ok,status:report.status,checks:report.checks.length,passed:report.checks.filter(x=>x.pass).length,realRequests:report.probe?.requests?.length||0,injected:report.probe?.injected||0,out}));win.destroy();app.exit(report.ok?0:1);}
});
