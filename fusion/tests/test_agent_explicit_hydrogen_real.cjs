'use strict';
// Real editor + local chemical service. Deterministic fixtures; zero model calls.
const { app, BrowserWindow } = require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const OUT=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT||'/tmp/molstudio-explicit-hydrogen-real');
const PORT=Number(process.env.MOLSTUDIO_PORT)||49087,BUILD=process.env.MOLSTUDIO_TEST_BUILD||'current served resources';
const SOURCE=fs.readFileSync(path.join(__dirname,'fixtures/explicit-hydrogen-regression.molwork'),'utf8');
fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-explicit-h-')));
const report={application:'MolStudio canvas',page:'fusion/canvas.html',build:BUILD,service:`http://127.0.0.1:${PORT}`,
  modelCalls:0,scope:'One pre-existing implicit hydrogen becomes an explicit bonded atom without changing chemistry; actual KET/MOL and RDKit are checked.',checks:[]};
let win;const write=()=>fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
const watchdog=setTimeout(()=>{report.ok=false;report.error='watchdog';write();win?.destroy();app.exit(2)},120000);

async function exercise(){
  const api=k3dAPI.agent,ed=MolWorkbench.app.adapter.ed;
  const P='at-127fdcfc-59c6-48db-ba68-22c3b32e2d0c';
  const checks=window.explicitHChecks=[],samples=window.explicitHSamples={};
  const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(pass||detail===undefined?{}:{detail})});if(!pass)throw new Error(name)};
  const context=()=>api.getContext(),history=()=>({pointer:ed.historyPtr,...ed.historySize()}),atom=(c,id)=>c.atoms.find(a=>a.id===id);
  const canonical=value=>{const order=x=>Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;return JSON.stringify(order(value))};
  const totalH=c=>c.atoms.reduce((sum,a)=>sum+(a.label==='H'?1:0)+Math.max(0,Number(a.implicitH)||0),0);
  const totalCharge=c=>c.atoms.reduce((sum,a)=>sum+(Number(a.charge)||0),0);
  const ids=c=>({atoms:new Set(c.atoms.map(a=>a.id)),bonds:new Set(c.bonds.map(a=>a.id)),flows:new Set(c.arrows.map(a=>a.id)),steps:new Set(c.reactionSteps.map(a=>a.stepId))});
  const subset=(a,b)=>[...a].every(x=>b.has(x));
  const stable=(before,after)=>{const a=ids(before),b=ids(after);return Object.keys(a).every(k=>subset(a[k],b[k]))};
  const stepLinks=c=>canonical(c.reactionSteps.map(({stepId,reactants,products})=>({stepId,reactants,products})).sort((a,b)=>a.stepId.localeCompare(b.stepId)));
  const flowLinks=c=>canonical(c.arrows.map(({id,source,target})=>({id,source,target})).sort((a,b)=>a.id.localeCompare(b.id)));
  const source=()=>k3dAPI.serializeWorkbench();
  const before=await context(),beforeHistory=history(),beforeH=totalH(before),beforeCharge=totalCharge(before);
  check('historical oxygen has exactly one implicit hydrogen',atom(before,P)?.label==='O'&&atom(before,P)?.implicitH===1,{parent:atom(before,P)});
  const op={id:'materialize-existing-oh',type:'hydrogen.makeExplicit',parentAtomId:P};
  await api.beginRun('explicit-h-existing');
  const preview=await api.previewOperations([op],{runId:'explicit-h-existing'}),previewContext=await context();
  check('preview keeps source atoms, bonds, hydrogen count, positions and history',preview.previewed===1&&canonical(previewContext.atoms)===canonical(before.atoms)&&canonical(previewContext.bonds)===canonical(before.bonds)&&canonical(history())===canonical(beforeHistory),{preview,history:history()});
  const receipt=await api.applyOperations([op],{runId:'explicit-h-existing'}),after=await context();
  const hId=receipt.atomMapping?.['materialize-existing-oh:1'],bondId=receipt.bondMapping?.['materialize-existing-oh:bond:1'];
  const h=atom(after,hId),parent=atom(after,P),newBond=after.bonds.find(b=>b.id===bondId);
  const created=receipt.created?.find(item=>item.id===op.id);
  check('receipt reports the parent implicit-hydrogen decrement and conserved total',created?.parentAtomId===P&&
    created.implicitBefore===1&&created.implicitAfter===0&&created.hydrogenTotalBefore===beforeH&&created.hydrogenTotalAfter===beforeH,created);
  check('result publishes stable atom and bond aliases with a neutral closed-shell hydrogen',!!hId&&!!bondId&&h?.label==='H'&&h.charge===0&&h.radical===0&&
    newBond?.order===1&&[newBond.begin,newBond.end].includes(P)&&[newBond.begin,newBond.end].includes(hId),{hId,bondId,h,newBond,receipt});
  check('parent now has exactly one hydrogen as an explicit neighbor and none implicit',parent?.implicitH===0&&parent.neighbors.filter(n=>n.uuid===hId).length===1&&parent.neighbors.length===2,parent);
  check('all pre-existing atoms, bonds, electron flows and steps retain IDs',stable(before,after));
  check('all step participant references and electron-flow endpoints survive representation change',stepLinks(after)===stepLinks(before)&&flowLinks(after)===flowLinks(before));
  check('total hydrogen and net charge do not change',totalH(after)===beforeH&&totalCharge(after)===beforeCharge,{beforeH,afterH:totalH(after),beforeCharge,afterCharge:totalCharge(after)});
  check('materialization is one native history entry',history().undo===beforeHistory.undo+1,{beforeHistory,after:history()});
  const saved=await source(),doc=JSON.parse(saved),binding=doc.bindings.atoms.find(a=>a.id===P),ketAtom=doc.ket[binding.mol].atoms[binding.index];
  check('saved KET no longer fixes an extra implicit hydrogen on oxygen',!ketAtom.implicitHCount,ketAtom);
  samples.after=saved;samples.component=JSON.stringify({ket_version:doc.ket.ket_version,root:{nodes:[{$ref:'mol0'}]},mol0:doc.ket[binding.mol]});samples.parentIndex=binding.index;
  const afterH=totalH(after),afterCharge=totalCharge(after);await api.endRun('explicit-h-existing');
  k3dAPI.undo();const undone=await context();
  check('one undo restores implicit hydrogen and all original identities',atom(undone,P)?.implicitH===1&&totalH(undone)===beforeH&&totalCharge(undone)===beforeCharge&&stable(before,undone)&&!atom(undone,hId));
  k3dAPI.redo();const redone=await context();
  check('one redo restores the same explicit hydrogen and bond IDs',!!atom(redone,hId)&&redone.bonds.some(b=>b.id===bondId)&&totalH(redone)===afterH&&totalCharge(redone)===afterCharge);
  const loaded=await k3dAPI.loadWorkbench(saved),reopened=await context();
  check('save and reopen retain closed-shell hydrogen, original IDs and total H',loaded.ok&&stable(before,reopened)&&atom(reopened,hId)?.radical===0&&atom(reopened,P)?.implicitH===0&&
    reopened.bonds.some(b=>b.id===bondId)&&totalH(reopened)===afterH&&totalCharge(reopened)===afterCharge);
  const png=await k3dAPI.exportMechanismImage('png');if(png.ok)samples.png=png.dataUrl;
  const shared=reopened.molecules.find(m=>m.atoms.includes(P)),memberIds=new Set(shared?.atoms||[]);
  const sharedStepIds=reopened.reactionSteps.filter(step=>[...step.reactants,...step.products].some(id=>memberIds.has(id))).map(step=>step.stepId);
  check('the materialized molecule remains connected as a product and reactant in separate steps',sharedStepIds.length>=2&&
    reopened.reactionSteps.some(step=>step.products.some(id=>memberIds.has(id)))&&reopened.reactionSteps.some(step=>step.reactants.some(id=>memberIds.has(id))),sharedStepIds);
  await api.beginRun('observe-shared-after-explicit');
  const observe=await api.applyOperations([{id:'observe-shared-move',type:'molecule.move',target:{molecule:shared.id},dx:0.01,dy:0}],{runId:'observe-shared-after-explicit'});
  const observed=await context();
  check('moving the shared molecule can observe its original reaction steps after materialization',sharedStepIds.every(id=>observe.steps?.some(s=>s.action==='observe'&&s.stepId===id))&&
    stepLinks(observed)===stepLinks(before)&&flowLinks(observed)===flowLinks(before),{sharedStepIds,receipts:observe.steps?.map(s=>({action:s.action,stepId:s.stepId}))});
  await api.endRun('observe-shared-after-explicit');
  async function example(label,smiles,map){
    await k3dAPI.setMolecule('');ed.clearHistory();await api.beginRun('seed-'+label);
    const seed=await api.applyOperations([{id:'seed-'+label,type:'molecule.add',smiles}],{runId:'seed-'+label});await api.endRun('seed-'+label);
    const id=seed.atomMapping['seed-'+label+':'+map],a=await context(),h=totalH(a),q=totalCharge(a);await api.beginRun('make-'+label);
    const result=await api.applyOperations([{id:'make-'+label,type:'hydrogen.makeExplicit',parentAtomId:id}],{runId:'make-'+label}),b=await context();await api.endRun('make-'+label);
    const created=atom(b,result.atomMapping?.['make-'+label+':1']);
    check(label+' implicit-to-explicit conversion conserves hydrogen and charge',!!created&&created.label==='H'&&created.radical===0&&created.charge===0&&totalH(b)===h&&totalCharge(b)===q&&stable(a,b),{created,beforeH:h,afterH:totalH(b),beforeQ:q,afterQ:totalCharge(b)});
  }
  await example('oxonium','[OH2+:1][CH3:2]',1);
  await example('amine','[NH2:1][CH3:2]',1);
  await example('carbon','[CH3:1][OH:2]',1);
  async function rejected(label,smiles,map,expectedCode){
    await k3dAPI.setMolecule('');ed.clearHistory();await api.beginRun('seed-'+label);
    const seed=await api.applyOperations([{id:'seed-'+label,type:'molecule.add',smiles}],{runId:'seed-'+label});await api.endRun('seed-'+label);
    const id=seed.atomMapping['seed-'+label+':'+map],a=await context(),hist=history();await api.beginRun('reject-'+label);let error;
    try{await api.applyOperations([{id:'reject-'+label,type:'hydrogen.makeExplicit',parentAtomId:id}],{runId:'reject-'+label});}catch(e){error={code:e.code,message:e.message}}
    const b=await context();check(label+' is rejected without mutating the canvas or history',error?.code===expectedCode&&canonical(a.atoms)===canonical(b.atoms)&&canonical(a.bonds)===canonical(b.bonds)&&canonical(hist)===canonical(history()),error);await api.endRun('reject-'+label);
  }
  await rejected('no-hydrogen','[O:1]=[C:2]=[O:3]',1,'hydrogen_explicit_none');
  await rejected('stereocenter','[C@H:1]([F:2])([Cl:3])[Br:4]',1,'hydrogen_explicit_stereo');
  await k3dAPI.setMolecule('');ed.clearHistory();await api.beginRun('protonation-seed');
  const seed=await api.applyOperations([{id:'alkoxide',type:'molecule.add',smiles:'[O-:1][CH3:2]',x:0,y:0},{id:'proton',type:'molecule.add',smiles:'[H+:1]',x:5,y:0}],{runId:'protonation-seed'});
  await api.endRun('protonation-seed');await api.beginRun('protonation');
  const o=seed.atomMapping['alkoxide:1'],hplus=seed.atomMapping['proton:1'];
  await api.applyOperations([{id:'proton-bond',type:'bond.add',begin:o,end:hplus,order:1},{id:'neutral-o',type:'atom.modify',atomId:o,charge:0},{id:'neutral-h',type:'atom.modify',atomId:hplus,charge:0}],{runId:'protonation'});
  const protonated=await context();check('ordinary explicit protonation via bond.add and explicit charge edits still works',atom(protonated,o)?.charge===0&&atom(protonated,hplus)?.charge===0&&
    atom(protonated,o)?.neighbors.some(n=>n.uuid===hplus)&&atom(protonated,hplus)?.neighbors.some(n=>n.uuid===o));
  await api.endRun('protonation');return{checks,samples};
}

app.whenReady().then(async()=>{win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s);
try{
  await win.loadURL(report.service+'/canvas.html');for(let i=0;i<400;i++){if(await js('!!window.k3dAPI?.workbenchReady?.()'))break;await new Promise(r=>setTimeout(r,80))}
  await js('k3dAPI.agent.getContext()');const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(SOURCE)+')');if(!loaded.ok)throw new Error('fixture load failed');
  await js('MolWorkbench.app.adapter.ed.clearHistory();void 0');const result=await js('('+exercise.toString()+')()');report.checks=result.checks;
  fs.writeFileSync(path.join(OUT,'explicit-h.molwork'),result.samples.after);if(result.samples.png)fs.writeFileSync(path.join(OUT,'explicit-h.png'),Buffer.from(result.samples.png.split(',')[1],'base64'));
  const mol=await js(`(async()=>{const k=MolWorkbench.app.adapter.k;await k.setMolecule(${JSON.stringify(result.samples.component)});return await k.getMolfile('v3000')})()`);
  const molPath=path.join(OUT,'parent-component.mol');fs.writeFileSync(molPath,mol);
  const python=path.resolve(__dirname,'../../.venv-rdkit/bin/python');
  const script=`import json,sys\nfrom rdkit import Chem\nm=Chem.MolFromMolFile(sys.argv[1],sanitize=False,removeHs=False)\nassert m is not None\nproblems=[str(p.Message()) for p in Chem.DetectChemistryProblems(m)]\nm.UpdatePropertyCache(strict=False)\na=m.GetAtomWithIdx(int(sys.argv[2]))\nprint(json.dumps({'element':a.GetSymbol(),'charge':a.GetFormalCharge(),'hydrogens':a.GetTotalNumHs(includeNeighbors=True),'valence':a.GetExplicitValence(),'problems':problems}))`;
  const rdkit=JSON.parse(execFileSync(python,['-B','-c',script,molPath,String(result.samples.parentIndex)],{encoding:'utf8'}));
  report.checks.push({name:'actual exported V3000 target oxygen has one hydrogen, valence two and sanitizes in RDKit',pass:rdkit.element==='O'&&rdkit.charge===0&&rdkit.hydrogens===1&&rdkit.valence===2&&rdkit.problems.length===0,detail:rdkit});
  report.ok=report.checks.every(c=>c.pass);
}catch(error){report.ok=false;report.error=String(error.stack||error);try{report.checks=await js('window.explicitHChecks||[]');fs.writeFileSync(path.join(OUT,'failed.png'),(await win.capturePage()).toPNG())}catch(_){}}
finally{write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,total:report.checks.length,error:report.error,out:OUT},null,2));win.destroy();app.exit(report.ok?0:1)}});
