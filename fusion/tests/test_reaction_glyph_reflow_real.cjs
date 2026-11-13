'use strict';
// Actual Robinson relay checkpoint, canvas/49088 glyph build, 2026-11-12.
// Old automatic ar051 could pass at .54 and then collide at1/.41 after a later
// semantic reflow. This test makes subsequent native step edits, not just a
// final one-off arrow repair. No model requests; not full chemistry acceptance.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-glyph-reflow');
fs.mkdirSync(out, { recursive:true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-glyph-reflow-')));
const input = path.join(__dirname,'fixtures/reflow-glyph-regression.molwork');
const report = { application:'MolStudio canvas',page:'fusion/canvas.html',source:input,
  build:process.env.MOLSTUDIO_TEST_BUILD || 'local canvas service',service:'http://127.0.0.1:'+(process.env.MOLSTUDIO_PORT||49088),
  sourceInjected:process.env.MOLSTUDIO_TEST_INJECT_SOURCE==='1',modelRequests:0,completeRobinson:false,checks:[],views:[] };
const timer = setTimeout(()=>app.exit(2),120000);
async function exercise(){
 const api=k3dAPI.agent,MW=MolWorkbench,{model,controller,adapter}=MW.app,R=MW.route,M=MW.model;
 const checks=[],views=[],timings=[];window.glyphReflowResult={checks,views,timings};
 const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});if(!pass)throw new Error(name);};
 const focus='ar-051e1963-351c-446c-9471-b242782503c2';
 const initial=await api.getContext(),last=initial.reactionSteps.at(-1).stepId,defaultZoom=adapter.zoom();window.glyphReflowResult.defaultZoom=defaultZoom;
 const chem=c=>JSON.stringify({atoms:c.atoms.map(({neighbors,x,y,...a})=>a),bonds:c.bonds,
  arrows:c.arrows.map(a=>({id:a.id,source:a.source,target:a.target,electronCount:a.electronCount})),steps:c.reactionSteps.map(s=>({id:s.stepId,reactants:s.reactants,products:s.products}))});
 const before=chem(initial),pairsBefore=JSON.stringify(initial.lonePairs);
 const zoom=async z=>{adapter.ed.zoom(z);adapter.ed.render.update();await new Promise(r=>setTimeout(r,100));};
 const observe=()=>{const ctx=controller.ctx();return model.state.arrows.map(flow=>{const g=M.arrowGeometry(flow,ctx),scene=R.buildScene(ctx,model,{planning:false});R.addArrowObstacles(scene,model,ctx,flow.id);const p=R.planArrow({a:g.routingStart||g.start,b:g.routingEnd||g.end,scene,source:flow.source,target:flow.target,electronCount:flow.electronCount,fixedGeometry:g});return{id:flow.id,bend:flow.geometry.bend,feasible:p.feasible,readable:p.readable,arrowHits:p.ranked[0]?.arrowHits,collisions:p.collisions};});};
 const survey=async stage=>{for(const z of [...new Set([1,.54,.41,.5,1.5,.75,1.25,defaultZoom])]){await zoom(z);const curves=observe();views.push({stage,zoom:z,curves});check(stage+' all actual curves clear at zoom '+z,curves.every(f=>f.feasible&&f.readable&&!f.arrowHits),curves.filter(f=>!f.feasible||!f.readable||f.arrowHits));}};
 const apply=async(id,ops)=>{const start=performance.now();await api.beginRun(id);try{return await api.applyOperations(ops,{runId:id});}finally{await api.endRun(id);timings.push({id,milliseconds:performance.now()-start});}};
 await zoom(1);await apply('repair-at-readable-view',[...model.state.arrows.filter(f=>M.arrowMode(f)==='auto').map((f,i)=>({id:'explicit-initial-reroute-'+i,type:'arrow.modify',arrowId:f.id,mode:'auto'}))]);
 if(window.glyphEnvelopeDiagnostic){const flow=model.arrow(focus),ctx=controller.ctx(),scene=R.buildScene(ctx,model);R.addArrowObstacles(scene,model,ctx,focus);const top=controller.planFor(flow.source,flow.target,2,{exceptId:focus,preferClearArrows:true});const trials=[];for(let k=-300;k<=300;k++){const bend=k/200,g=M.arrowGeometry({...flow,geometry:{...flow.geometry,bend}},ctx),p=R.planArrow({a:g.routingStart||g.start,b:g.routingEnd||g.end,scene,source:flow.source,target:flow.target,electronCount:2,fixedGeometry:g});if(p.feasible&&p.readable&&!p.ranked[0]?.arrowHits)trials.push(bend);}window.glyphReflowResult.envelopeDiagnostic={denseFeasible:trials,planner:{feasible:top?.plan.feasible,bend:top?.plan.bend,collisions:top?.plan.collisions},labels:scene.labels.filter(x=>['at-f55eccde-1c16-4546-8609-295684cafda3','at-aa1d16d8-e470-4594-b887-c41d398b10e0'].includes(x.atomId))};}
 await survey('initial explicit repair');
 for(const [i,z]of [.54,.41,.54].entries()){
  await zoom(z);const receipt=await apply('semantic-reflow-'+i,[{id:'modify-existing-stage-'+i,type:'reactionStep.modify',stepId:last,expectedVersion:(await api.getContext()).reactionSteps.find(s=>s.stepId===last).version,layout:{breakBefore:i%2===0}}]);
  window.glyphReflowResult['receipt'+i]=receipt;
  await survey('subsequent native semantic reflow '+i);
 }
 check('reflows preserve original atom/bond chemistry, flow endpoints and step identities',before===chem(await api.getContext()));
 const saved=await k3dAPI.serializeWorkbench();window.glyphReflowSaved=saved;
 await k3dAPI.loadWorkbench(saved);await survey('save and reopen');
 check('reopened original chemistry and all semantic references remain intact',before===chem(await api.getContext()));
 check('source LP author angles, target bindings and identities remain unchanged',pairsBefore===JSON.stringify((await api.getContext()).lonePairs));
 const ctx=controller.ctx(),flow=model.arrow(focus),g=M.arrowGeometry(flow,ctx),scene=R.buildScene(ctx,model,{planning:false});
 R.addArrowObstacles(scene,model,ctx,flow.id);
 const oxygen=ctx.atomPos('at-aa1d16d8-e470-4594-b887-c41d398b10e0');
 const bad={...g,control:{x:2*oxygen.x-(g.start.x+g.end.x)/2,y:2*oxygen.y-(g.start.y+g.end.y)/2}};
 const collision=R.planArrow({a:bad.start,b:bad.end,scene,source:flow.source,target:flow.target,electronCount:2,fixedGeometry:bad});
 check('a real forced curve through the oxygen label is still rejected',!collision.feasible,collision.collisions);
 const beforeFailure=JSON.stringify(model.cloneState()),beforeFailureContext=chem(await api.getContext()),history=adapter.ed.historyPtr;
 const originalPlanFor=controller.planFor;let rejected;
 controller.planFor=function(source,target,count,options){
  if(source.type===flow.source.type&&source.bondId===flow.source.bondId){
   return{plan:{bend:-.369,feasible:false,readable:true,note:'crowded',ranked:[{labelHits:1,bondHits:0,arrowHits:0}],collisions:{labels:['at-aa1d16d8-e470-4594-b887-c41d398b10e0'],bonds:[]}}};
  }
  return originalPlanFor.call(this,source,target,count,options);
 };
 try{await apply('reject-no-safe-replacement',[{id:'force-no-safe-replacement',type:'arrow.modify',arrowId:focus,mode:'auto'}]);}
 catch(error){rejected={code:error.code,operationId:error.operationId,layoutFailures:error.layoutFailures};}
 finally{controller.planFor=originalPlanFor;}
 check('an infeasible replacement returns a concrete route failure for its original operation',rejected?.code==='electron_route_infeasible'&&rejected.operationId==='force-no-safe-replacement'&&rejected.layoutFailures?.[0]?.arrowId===focus,rejected);
 check('failed automatic replacement atomically preserves all curves chemistry metadata and native history',JSON.stringify(model.cloneState())===beforeFailure&&chem(await api.getContext())===beforeFailureContext&&adapter.ed.historyPtr===history);
 return window.glyphReflowResult;
}
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s);
 await win.loadURL(report.service+'/canvas.html');for(let i=0;i<400&&!await js('!!k3dAPI?.workbenchReady?.()');i++)await new Promise(r=>setTimeout(r,80));
 await js('k3dAPI.agent.getContext()');
 if(report.sourceInjected){
  await js(fs.readFileSync(path.join(root,'fusion/workbench/ketcher-adapter.js'),'utf8')+';Object.setPrototypeOf(MolWorkbench.app.adapter,MolWorkbench.adapter.KetcherAdapter.prototype);void 0;');
  await js('window.__previousRoute=MolWorkbench.route;'+fs.readFileSync(path.join(root,'fusion/workbench/mechanism-route.js'),'utf8')+';Object.assign(window.__previousRoute,MolWorkbench.route);MolWorkbench.route=window.__previousRoute;void 0;');
  await js(fs.readFileSync(path.join(root,'fusion/workbench/mechanism-controller.js'),'utf8')+';Object.setPrototypeOf(MolWorkbench.app.controller,MolWorkbench.controller.MechanismController.prototype);void 0;');
 }
 await js('window.glyphEnvelopeDiagnostic='+JSON.stringify(process.env.MOLSTUDIO_GLYPH_DIAG==='1')+';void 0;');
 await js('k3dAPI.loadWorkbench('+JSON.stringify(fs.readFileSync(input,'utf8'))+')');
 Object.assign(report,await js('('+exercise.toString()+')()'));report.ok=report.checks.every(c=>c.pass);
}catch(e){report.ok=false;report.failure=String(e.stack||e);if(win)try{Object.assign(report,await win.webContents.executeJavaScript('window.glyphReflowResult||{}'));}catch{}}
finally{if(win){try{const saved=await win.webContents.executeJavaScript('k3dAPI.serializeWorkbench()');fs.writeFileSync(path.join(out,'final.molwork'),saved);}catch{}}
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,checks:report.checks.map(c=>({name:c.name,pass:c.pass})),failure:report.failure,out}));clearTimeout(timer);win?.destroy();app.exit(report.ok?0:1);}});
