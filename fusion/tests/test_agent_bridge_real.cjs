// Existing Electron dependency, private port/profile. Does not launch or inspect
// the user's MolStudio process. Start fusion/server.py on MOLSTUDIO_PORT first.
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const OUT=process.env.MOLSTUDIO_AGENT_TEST_OUT || path.resolve(__dirname,'../../.jez/artifacts/agent-bridge-validation');
fs.mkdirSync(OUT,{recursive:true});
app.setPath('userData',path.join(OUT,'electron-profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const watchdog=setTimeout(()=>app.exit(2),120000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.log('RENDERER',event.message);});
 try{
  await win.loadURL('http://127.0.0.1:'+(process.env.MOLSTUDIO_PORT||48972)+'/canvas.html');
  const js=code=>win.webContents.executeJavaScript(code);
  for(let i=0;i<200;i++){if(await js('!!window.k3dAPI?.workbenchReady?.()'))break;await wait(100);}
  if(!await js('!!window.k3dAPI.agent'))await js(fs.readFileSync(path.resolve(__dirname,'../workbench/agent-bridge.js'),'utf8'));
  const report=await js(`(async()=>{
   const checks=[],test=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});
   const wait=ms=>new Promise(r=>setTimeout(r,ms));
   const a=MolWorkbench.app.adapter,ed=a.ed,m=MolWorkbench.app.model,c=MolWorkbench.app.controller,api=k3dAPI.agent;
   const events=[],errors=[];let phase='initial';addEventListener('molstudio:agent-canvas-change',event=>events.push(event.detail));
   addEventListener('error',event=>errors.push({phase,message:event.message,stack:event.error?.stack}));
   a.doc.defaultView.addEventListener('error',event=>errors.push({phase,message:event.message,stack:event.error?.stack}));
   await k3dAPI.setMolecule('');await wait(350);ed.clearHistory();
   const initial=await api.getContext(),view=JSON.stringify(initial.viewport),snapshot=await k3dAPI.serializeWorkbench();
   const center=initial.viewport.center;
   const ops=[
    {id:'nuc',type:'molecule.add',smiles:'[OH-:7]',x:center.x-2,y:center.y},
    {id:'sub',type:'molecule.add',smiles:'[CH3:21][Br:22]',x:center.x+2,y:center.y},
    {id:'pair',type:'lonePair.add',atom:'nuc:7',angle:0},
    {id:'attack',type:'arrow.add',source:{type:'lonePair',id:'pair'},target:{type:'atom',atomId:'sub:21'},electronCount:2},
    {id:'leave',type:'arrow.add',source:{type:'bond',atom1:'sub:22',atom2:'sub:21',component:'sigma'},target:{type:'atom',atomId:'sub:22'},electronCount:2}
   ];
   const inspected=await api.inspectStructures([
     {id:'valid',smiles:'[CH3:21][Br:22]'},
     {id:'invalid',smiles:'[CH3:7][CH2:9]([H:10])[CH3:11]'}
   ]);
   test('structure inspection returns bond references and mapped valence errors without a source write',
     inspected[0].ok&&inspected[0].bonds[0].begin==='21'&&inspected[0].bonds[0].end==='22'&&
     !inspected[1].ok&&inspected[1].code==='smiles_valence'&&inspected[1].atomMap===9&&snapshot===await k3dAPI.serializeWorkbench(),inspected);
   await api.beginRun('native-agent-test');
   const preview=await api.previewOperations(ops,{runId:'native-agent-test'});
   test('complete preview objects visible before commit',preview.previewed===5&&
     !!a.doc.querySelector('[data-agent-preview="native-agent-test"] [data-agent-op="leave"] path'));
   test('preview does not write native atoms, mechanism or snapshot',ed.struct().atoms.size===0&&m.state.arrows.length===0&&snapshot===await k3dAPI.serializeWorkbench());
   const firstCurve=a.doc.querySelector('[data-agent-op="attack"] path'),firstAnimation=firstCurve.getAnimations()[0];
   await wait(70);const animationTime=firstAnimation?.currentTime;c.render();await wait(50);
   test('preview curve animates on independent layer through normal redraw',firstCurve.isConnected&&firstAnimation?.currentTime>animationTime&&firstCurve.getAttribute('pathLength')==='1');
   await wait(100);
   await api.previewOperations(ops.concat({id:'preview-note',type:'text.add',text:'临时说明'}),{runId:'native-agent-test'});
   const oldMolecule=a.doc.querySelector('[data-agent-op="nuc"]'),newNote=a.doc.querySelector('[data-agent-op="preview-note"]');
   test('new complete object enters without replaying earlier molecule entrance',!oldMolecule.getAnimations().some(animation=>animation.playState==='running')&&newNote.getAnimations().some(animation=>animation.playState==='running'));
   const [applied]=await Promise.all([api.applyOperations(ops,{runId:'native-agent-test'}),api.applyOperations(ops,{runId:'native-agent-test'})]),context=await api.getContext();
   test('mixed native command commits molecules, lone pair and two arrows',context.atoms.length===3&&context.bonds.length===1&&context.lonePairs.length===1&&context.arrows.length===2,{context,applied});
   test('concurrent duplicate calls enter exactly one mixed undo step',ed.historySize().undo===1,ed.historySize());
   test('viewport preserved across preview and mixed commit',view===JSON.stringify(context.viewport));
   test('mapped atoms and the unordered bond pair resolve to actual UUIDs',context.atoms.some(atom=>atom.id===applied.atomMapping['nuc:7']&&atom.label==='O')&&context.atoms.some(atom=>atom.id===applied.atomMapping['sub:21']&&atom.label==='C')&&context.arrows.some(arrow=>arrow.source.bondId===applied.bondMapping['sub:bond:1']));
   test('commit clears provisional layer',!a.doc.querySelector('[data-agent-preview]'));
   const once=await k3dAPI.serializeWorkbench(),revision=context.revision;
   await api.applyOperations(ops,{runId:'native-agent-test'});
   test('retry of identical operations is idempotent',once===await k3dAPI.serializeWorkbench()&&(await api.getContext()).revision===revision&&ed.historySize().undo===1);
   let conflict=false;try{await api.applyOperations([{...ops[0],smiles:'N'}],{runId:'native-agent-test'});}catch(error){conflict=error.code==='operation_conflict';}
   test('same operation id with different payload rejected',conflict&&once===await k3dAPI.serializeWorkbench());
   const text=await api.applyOperations([{id:'note',type:'text.add',text:'亲核试剂\\n明确请求的文字',x:center.x-3,y:center.y+2}],{runId:'native-agent-test'});
   test('requested Chinese text is a separate short history step',ed.struct().texts.size===1&&ed.historySize().undo===2,text);
   const exportResult=await k3dAPI.exportMechanismImage('svg'),svg=decodeURIComponent(escape(atob(exportResult.dataUrl.split(',')[1])));
   test('entrance overlay excluded from SVG export',exportResult.ok&&!svg.includes('data-agent-entrance')&&!svg.includes('data-agent-preview'));
   await api.endRun('native-agent-test');
   k3dAPI.undo();await wait(150);
   test('step undo removes text and preserves completed mechanism',ed.struct().texts.size===0&&ed.struct().atoms.size===3&&m.state.arrows.length===2);
   k3dAPI.undo();await wait(150);
   test('mixed undo removes its complete chemical step',ed.struct().atoms.size===0&&m.state.arrows.length===0&&m.state.lonePairs.length===0);
   k3dAPI.redo();await wait(180);
   const redo=await api.getContext();
   test('mixed redo restores the same semantic UUIDs and arrow bindings',redo.atoms.some(atom=>atom.id===applied.atomMapping['sub:21']&&atom.label==='C')&&redo.arrows.every(arrow=>{const g=MolWorkbench.model.arrowGeometry(arrow,c.ctx());return g.sourceOk&&g.targetOk;}));
   test('manual undo/redo emits manual events, agent writes emit agent events',events.some(event=>event.source==='manual')&&events.some(event=>event.source==='agent'));
   phase='atomic-failure';await api.beginRun('atomic-failure');const beforeFailure=await k3dAPI.serializeWorkbench(),historyBefore=ed.historySize().undo;
   let rejected=false;try{await api.applyOperations([{id:'temporary',type:'molecule.add',smiles:'N'},{id:'bad',type:'arrow.add',source:{type:'atom',atomId:'missing'},target:{type:'atom',atomId:'other-missing'},electronCount:2}],{runId:'atomic-failure'});}catch(error){rejected=true;}
   test('invalid later operation rolls back native fragment and history',rejected&&beforeFailure===await k3dAPI.serializeWorkbench()&&ed.historySize().undo===historyBefore);
   await api.endRun('atomic-failure');
   await api.beginRun('stopped');const aborter=new AbortController();aborter.abort();let cancelled=false;
   try{await api.applyOperations([{id:'never',type:'molecule.add',smiles:'CO'}],{runId:'stopped',signal:aborter.signal});}catch(error){cancelled=error.code==='aborted';}
   test('aborted run never starts a new write',cancelled&&beforeFailure===await k3dAPI.serializeWorkbench());await api.endRun('stopped');
   await api.beginRun('end-fence');await api.endRun('end-fence');let ended=false;
   try{await api.applyOperations([{id:'late',type:'molecule.add',smiles:'CO'}],{runId:'end-fence'});}catch(error){ended=error.code==='stale_canvas';}
   test('ended run rejects late tool completion',ended&&beforeFailure===await k3dAPI.serializeWorkbench());
   const originalFetch=window.fetch;
   window.fetch=async function(){await wait(120);return originalFetch.apply(this,arguments);};
   phase='manual-race';await api.beginRun('manual-race');
   const raced=api.applyOperations([{id:'late-fragment',type:'molecule.add',smiles:'C#N'}],{runId:'manual-race'});
   setTimeout(()=>{const oxygen=Array.from(ed.struct().atoms).find(([,atom])=>atom.label==='O');oxygen[1].charge=0;ed.update(true);},20);
   let stale=false;try{await raced;}catch(error){stale=error.code==='stale_canvas';}
   window.fetch=originalFetch;
   test('manual edit during structure request invalidates pending agent write',stale&&ed.struct().atoms.size===3&&Array.from(ed.struct().atoms.values()).some(atom=>atom.label==='O'&&(atom.charge||0)===0));
   phase='replace-race';const oldSession=(await api.getContext()).sessionId;await api.beginRun('replace-race');await k3dAPI.setMolecule('N');await wait(350);
   let replaced=false;try{await api.applyOperations([{id:'late',type:'molecule.add',smiles:'CO'}],{runId:'replace-race'});}catch(error){replaced=error.code==='stale_canvas';}
   test('document replacement changes session and rejects old run',replaced&&(await api.getContext()).sessionId!==oldSession&&ed.struct().atoms.size===1);
   const savedLoad=await k3dAPI.loadWorkbench(once);await wait(200);const reloaded=await api.getContext();
   test('confirmed source saves and reloads stable editable mechanism without presentation',savedLoad.ok&&reloaded.atoms.length===3&&reloaded.arrows.length===2&&!a.doc.querySelector('[data-agent-preview]')&&reloaded.arrows.every(arrow=>{const geometry=MolWorkbench.model.arrowGeometry(arrow,c.ctx());return geometry.sourceOk&&geometry.targetOk&&!geometry.degenerate;}));

   phase='concerted-arrows';
   const fixtureAtom=(label,x,y,charge=0)=>({label,location:[x,-y,0],charge});
   const carbonylKet={root:{nodes:[{$ref:'mol0'},{$ref:'mol1'}]},
    mol0:{type:'molecule',atoms:[fixtureAtom('C',0,0),fixtureAtom('O',.0036,-1.00006,1),fixtureAtom('C',-.86785,.49683),fixtureAtom('C',.86425,.50293)],
     bonds:[{type:2,atoms:[0,1]},{type:1,atoms:[0,2]},{type:1,atoms:[0,3]}]},
    mol1:{type:'molecule',atoms:[fixtureAtom('O',0,-2.30146),fixtureAtom('C',.86638,-2.80084),fixtureAtom('C',1.73195,-2.30006)],
     bonds:[{type:1,atoms:[0,1]},{type:1,atoms:[1,2]}]}};
   const {model:arrowModel,route}=MolWorkbench, pairs=[];
   for(const reverse of [false,true]){
    await k3dAPI.setMolecule(JSON.stringify(carbonylKet));await wait(150);ed.clearHistory();
    const scene=await api.getContext(), carbonyl=scene.bonds.find(b=>b.order===2);
    const oxygen=scene.atoms.find(atom=>atom.label==='O'&&atom.charge===1).id, carbon=carbonyl.begin===oxygen?carbonyl.end:carbonyl.begin;
    const alcohol=scene.atoms.find(atom=>atom.label==='O'&&atom.charge===0).id;
    const bond=c.ctx().bonds().find(b=>b.uuid===carbonyl.id), runId='concerted-'+reverse;
    await api.beginRun(runId);
    const pair={id:'pair',type:'lonePair.add',atom:alcohol,angle:90};
    const attack={id:'attack',type:'arrow.add',source:{type:'lonePair',id:'pair'},target:{type:'formingBond',atom1:alcohol,atom2:carbon},electronCount:2};
    const shift={id:'shift',type:'arrow.add',source:{type:'bond',bondId:carbonyl.id,component:'pi'},target:{type:'atom',atomId:oxygen},electronCount:2};
    const ops=[pair,...(reverse?[shift,attack]:[attack,shift])];
    const side=(geo,t)=>route.sideOfBond(arrowModel.quadPoint(geo.start,geo.control,geo.end,t),bond);
    await api.previewOperations(ops,{runId});
    const previewGeometry=id=>{
     const curve=a.doc.querySelector('[data-agent-op="'+id+'"] path');
     const p=curve.getAttribute('d').split(' ').filter(token=>token!=='M'&&token!=='Q').map(Number);
     return {start:{x:p[0],y:p[1]},control:{x:p[2],y:p[3]},end:{x:p[4],y:p[5]}};
    };
    const separation=curves=>{
     const [first,second]=curves.map(geo=>route.sampleCurve(geo.start,geo.control,geo.end,.03,16,80).points);
     return Math.min(...first.map(p=>Math.min(...second.map(q=>arrowModel.dist(p,q)))));
    };
    const previewCurves=['attack','shift'].map(previewGeometry);
    const previewSides=[side(previewCurves[0],.82),side(previewCurves[1],.5)];
    const receipt=await api.applyOperations(ops,{runId});
    const byId=id=>m.arrow(receipt.created.find(entry=>entry.id===id).entityIds[0]);
    const committed=[byId('attack'),byId('shift')];
    const curves=committed.map(arrow=>arrowModel.arrowGeometry(arrow,c.ctx()));
    const sides=curves.map((geo,i)=>side(geo,i===0?.82:.5));
    pairs.push({sides,previewSides,bends:committed.map(arrow=>arrow.geometry.bend), gap:separation(curves),previewGap:separation(previewCurves)});
    await api.endRun(runId);
   }
   test('a carbonyl attack and π shift use opposite sides in preview and committed Ketcher geometry in either operation order',
    pairs.every(pair=>pair.sides[0]*pair.sides[1]===-1&&pair.previewSides.join()===pair.sides.join()&&pair.gap>.1&&pair.previewGap>.1)&&
    JSON.stringify(pairs[0].bends)===JSON.stringify(pairs[1].bends),pairs);

   phase='load-and-start';
   const startingEvent = events.length;
   const beforeLoad = await api.getContext();
   const replacing = k3dAPI.setMolecule('CCO');
   const starting = api.beginRun('start-during-load', { includeContext: true });
   const reading = api.getContext();
   const [, begun, readDuringLoad] = await Promise.all([replacing, starting, reading]);
   await wait(180);
   test('begin and read during setMolecule see the loaded structure without a false edit',
    begun.sessionId !== beforeLoad.sessionId && begun.context.sessionId === begun.sessionId &&
    begun.revision === begun.context.revision && begun.context.atoms.length === 3 &&
    begun.context.bonds.length === 2 && readDuringLoad.sessionId === begun.sessionId &&
    readDuringLoad.atoms.some(atom => atom.label === 'O') &&
    events.slice(startingEvent).length === 1 && events[startingEvent].reason === 'replace',
    { begun, readDuringLoad, events: events.slice(startingEvent) });
   const companionOp = { id:'loaded-companion', type:'molecule.add', smiles:'N' };
   const companion = await api.applyOperations([companionOp], { runId:'start-during-load' });
   await api.endRun('start-during-load');
   const beforeReplay = ed.historySize().undo;
   const resume = await api.beginRun('resume-same-document', {
    includeContext:true, expectedSessionId:begun.sessionId, resumeRunId:'start-during-load'
   });
   await api.applyOperations([companionOp], { runId:'resume-same-document' });
   test('same-document continuation retains the original alias and replays without a duplicate write',
    resume.resumeAliases.atoms['loaded-companion:1'] === companion.atomMapping['loaded-companion:1'] &&
    ed.struct().atoms.size === 4 && ed.historySize().undo === beforeReplay);
   await api.applyOperations([{id:'resume-label',type:'lonePair.add',atom:'loaded-companion:1'}], { runId:'resume-same-document' });
   test('continued operations can use an alias from a previously committed operation',
    (await api.getContext()).lonePairs.some(pair => pair.ownerAtomId === companion.atomMapping['loaded-companion:1']));
   await api.endRun('resume-same-document');
   k3dAPI.undo(); k3dAPI.undo(); await wait(180);
   const afterUndo = ed.historySize().undo;
   const resumedAfterUndo = await api.beginRun('resume-after-undo', {
    includeContext:true, expectedSessionId:begun.sessionId, resumeRunId:'resume-same-document'
   });
   await api.applyOperations([companionOp], { runId:'resume-after-undo' });
   test('continuation hides undone aliases and does not resurrect undone operations on replay',
    !resumedAfterUndo.resumeAliases.atoms['loaded-companion:1'] && !resumedAfterUndo.resumeAliases.entities['resume-label'] &&
    ed.struct().atoms.size === 3 && m.state.lonePairs.length === 0 && ed.historySize().undo === afterUndo);
   await api.endRun('resume-after-undo');
   let wrongDocument = false;
   try { await api.beginRun('obsolete-resume', { expectedSessionId: beforeLoad.sessionId }); }
   catch (error) { wrongDocument = error.code === 'document_changed'; }
   test('begin refuses a continuation targeting the previous document', wrongDocument);

   phase='workbench-load-and-start';
   const workbenchEvents = events.length;
   const reloading = k3dAPI.loadWorkbench(once);
   const [, reloadedRun] = await Promise.all([reloading, api.beginRun('start-during-workbench-load', { includeContext: true })]);
   await wait(180);
   test('begin during .molwork load waits for native atoms and mechanism bindings',
    reloadedRun.context.atoms.length === 3 && reloadedRun.context.arrows.length === 2 &&
    reloadedRun.context.atoms.some(atom => atom.id === applied.atomMapping['sub:21']) &&
    events.slice(workbenchEvents).length === 1 && events[workbenchEvents].reason === 'load',
    { reloadedRun, events: events.slice(workbenchEvents) });
   await api.endRun('start-during-workbench-load');

   phase='unattributed-change';
   await api.beginRun('unknown-origin');
   const unknownEvent = events.length;
   Array.from(ed.struct().atoms.values()).find(atom => atom.label === 'O').charge = -2;
   await api.getContext();
   let unknownRejected = false;
   try { await api.applyOperations([{ id:'wrong-revision', type:'molecule.add', smiles:'N' }], { runId:'unknown-origin' }); }
   catch (error) { unknownRejected = error.code === 'stale_canvas'; }
   test('unattributed signature changes fence stale writes without inventing a manual edit',
    unknownRejected && events.length === unknownEvent + 1 && events[unknownEvent].source === 'unknown',
    { events: events.slice(unknownEvent) });
   await api.endRun('unknown-origin');

   phase='failed-deletes';
   await k3dAPI.setMolecule('');
   const deleteRun = {runId:'failed-deletes'};
   await api.beginRun(deleteRun.runId);
   await api.applyOperations([
    {id:'stereo',type:'molecule.add',smiles:'[CH3:1][C@H:2]([OH:3])[F:4]',x:1,y:1},
    {id:'spectator',type:'molecule.add',smiles:'[CH3:1][Br:2]',x:10,y:1}
   ],deleteRun);
   const beforeDelete=await api.getContext(), beforeDeleteSaved=await k3dAPI.serializeWorkbench();
   const beforeDeleteHistory=ed.historySize().undo, beforeDeleteEvent=events.length;
   const failingArrow={id:'bad-after-delete',type:'arrow.add',source:{type:'atom',atomId:'missing'},
    target:{type:'atom',atomId:'spectator:1'},electronCount:2};
   const deleteStereo={id:'delete-stereo',type:'bond.delete',bondId:'stereo:bond:1'};
   const deleteMol={id:'delete-molecule',type:'molecule.delete',target:{molecule:beforeDelete.molecules[0].id}};
   for(const operation of [deleteStereo,deleteMol]) {
    let fault;
    try {await api.applyOperations([operation,failingArrow],deleteRun);}
    catch(error){fault=error.code;}
    await wait(150);
    const rolledBack=await api.getContext();
    test('rollback of '+operation.type+' preserves the KET, revision, handles and history',
     fault==='missing_reference' && beforeDeleteSaved===await k3dAPI.serializeWorkbench() &&
     rolledBack.revision===beforeDelete.revision && JSON.stringify(rolledBack.molecules)===JSON.stringify(beforeDelete.molecules) &&
     events.length===beforeDeleteEvent && ed.historySize().undo===beforeDeleteHistory,
     {fault,events:events.slice(beforeDeleteEvent),molecules:rolledBack.molecules});
   }
   const nativeWindow=a.doc.defaultView;
   const structOpsDescriptor=Object.getOwnPropertyDescriptor(nativeWindow,'molstudioNativeStructOps');
   const nativeOps=structOpsDescriptor.value;
   let recalcCalls=0, recalcFault;
   Object.defineProperty(nativeWindow,'molstudioNativeStructOps',{...structOpsDescriptor,value:{...nativeOps,recalc(...args){
    if(++recalcCalls===1) throw new Error('fixture recalc failure');
    return nativeOps.recalc(...args);
   }}});
   try {
    await api.applyOperations([{id:'recalc-failure',type:'atom.modify',atomId:'stereo:3',charge:-1}],deleteRun);
   } catch(error) {recalcFault=error.message;}
   finally {Object.defineProperty(nativeWindow,'molstudioNativeStructOps',structOpsDescriptor);}
   await wait(150);
   test('an internal native recalculation failure rolls back the partial edit',
    recalcFault==='fixture recalc failure' && recalcCalls===2 && beforeDeleteSaved===await k3dAPI.serializeWorkbench() &&
    (await api.getContext()).revision===beforeDelete.revision && events.length===beforeDeleteEvent &&
    ed.historySize().undo===beforeDeleteHistory,{recalcFault,recalcCalls,events:events.slice(beforeDeleteEvent)});
   await api.applyOperations([deleteMol],deleteRun);
   await api.endRun(deleteRun.runId);
   test('the same run can apply a corrected delete without a stale pause', (await api.getContext()).molecules.length===1);
   k3dAPI.undo();await wait(150);
   const undoDelete=await api.getContext();
   test('undo restores both molecular components and the original wedge bond',
    undoDelete.molecules.length===2 && beforeDelete.bonds.every(bond=>undoDelete.bonds.some(entry=>
     entry.id===bond.id && entry.begin===bond.begin && entry.end===bond.end && entry.stereo===bond.stereo)) &&
    (await k3dAPI.serializeWorkbench()).length>0);
   k3dAPI.redo();await wait(150);
   test('redo removes only the requested molecule', (await api.getContext()).molecules.length===1 && ed.struct().atoms.size===2);

   phase='app-load-and-send';
   const rt = molstudioAgent.getRuntime(), savedFetch = rt._fetch, savedConfig = rt._getConfig;
   const startEvents = events.length;
   let modelRequests = 0;
   const fixtureModel = 'replacement-fixture';
   rt._getConfig = async () => ({ configured:true, model:fixtureModel, sessionToken:'fixture', baseUrl:'https://fixture.invalid/v1' });
   rt._fetch = async (url, init) => {
    if (url === '/api/agent/cancel') return new Response('{}');
    if (url !== '/api/agent/model') return savedFetch(url, init);
    modelRequests++;
    await wait(230);
    const chunks = [
     { delta:{role:'assistant', content:'画布是乙醇。'}, finish_reason:null },
     { delta:{}, finish_reason:'stop' }
    ];
    const frames = chunks.map(choice => 'data: ' + JSON.stringify({
     id:'load-race', object:'chat.completion.chunk', model:fixtureModel, created:0, choices:[{index:0,...choice}]
    }) + '\\n\\n');
    return new Response(frames.join('') + 'data: [DONE]\\n\\n', {headers:{'Content-Type':'text/event-stream'}});
   };
   try {
    rt.reset();
    const [, agentRun] = await Promise.all([k3dAPI.setMolecule('CCO'), molstudioAgent.send('请简单描述当前画布')]);
    test('sending a real app request immediately after replacement completes without a false pause',
     agentRun.status === 'completed' && modelRequests === 1 && events.slice(startEvents).length === 1 &&
     events[startEvents].reason === 'replace' && ed.struct().atoms.size === 3,
     { agentRun, modelRequests, events:events.slice(startEvents) });
   } finally {
    rt.reset(); rt._fetch = savedFetch; rt._getConfig = savedConfig;
   }

   phase='reaction-layout';await k3dAPI.setMolecule('');await wait(150);ed.clearHistory();
   const runId='reaction-layout';await api.beginRun(runId);
   const step={id:'step',type:'reactionArrow.add',reactants:['sub:21','nuc:7'],products:['product:1','bromide:1']};
   const repeat={...step,id:'repeat',reactants:['nuc:7','sub:22'],products:['bromide:1','product:1']};
   const laidOut=[ops[1],ops[0],ops[2],ops[3],{id:'product',type:'molecule.add',smiles:'[CH3:1][OH:2]'},
    {id:'bromide',type:'molecule.add',smiles:'[Br-:1]'},step,repeat];
   await api.previewOperations(laidOut,{runId});
   test('a repeated exact reaction step previews a single straight connector',a.doc.querySelectorAll('[data-agent-kind="reactionArrow"]').length===1);
   const layoutReceipt=await api.applyOperations(laidOut,{runId});
   const layoutContext=await api.getContext(), layoutAtoms=layoutContext.atoms;
   const pointOf=ref=>layoutAtoms.find(atom=>atom.id===layoutReceipt.atomMapping[ref]);
   const donor=pointOf('nuc:7'), acceptor=pointOf('sub:21'), leaving=pointOf('sub:22');
   test('fresh species face by actual reactive atoms even when the substrate was listed first',
    (donor.x-acceptor.x)*(leaving.x-acceptor.x)<0 && Math.abs(donor.x-acceptor.x)<2,{donor,acceptor,leaving});
   test('semantic duplicates in a batch keep one native horizontal stage connector',layoutContext.reactionArrows.length===1&&
    Math.abs(layoutContext.reactionArrows[0].start.y-layoutContext.reactionArrows[0].end.y)<0.01&&layoutReceipt.warnings.some(w=>w.startsWith('repeat:')));
   const beforeDuplicate=ed.historySize().undo;
   await api.applyOperations([{...repeat,id:'later-repeat',reactants:repeat.reactants.map(ref=>layoutReceipt.atomMapping[ref])}],{runId});
   test('later duplicate with stable UUID references creates no new history step',ed.struct().rxnArrows.size===1&&ed.historySize().undo===beforeDuplicate);
   await api.endRun(runId);

   phase='continued-reaction';await k3dAPI.setMolecule('');await wait(150);ed.clearHistory();
   const continued='continued-reaction';await api.beginRun(continued);
   const origin=(await api.getContext()).viewport.center;
   const seed=await api.applyOperations([{id:'cation',type:'molecule.add',smiles:'[CH3+:1]',x:origin.x-6,y:origin.y}],{runId:continued});
   const beforeContinueContext=await api.getContext();
   const beforeContinue=beforeContinueContext.atoms.find(atom=>atom.id===seed.atomMapping['cation:1']);
   const historyAfterSeed=ed.historySize().undo;
   const atomChemistry=atom=>({label:atom.label,charge:atom.charge,radical:atom.radical,isotope:atom.isotope,
    implicitH:atom.implicitH,aromatic:atom.aromatic,hasQuery:atom.hasQuery,
    neighbors:atom.neighbors.map(({uuid,order,aromatic})=>({uuid,order,aromatic})).sort((a,b)=>a.uuid.localeCompare(b.uuid))});
   const stableStepState=context=>JSON.stringify({
    atoms:context.atoms.map(atom=>({id:atom.id,x:atom.x,y:atom.y,...atomChemistry(atom)})).sort((a,b)=>a.id.localeCompare(b.id)),
    bonds:context.bonds.map(({id,begin,end,order,stereo})=>({id,begin,end,order,stereo})).sort((a,b)=>a.id.localeCompare(b.id)),
    lonePairs:context.lonePairs.slice().sort((a,b)=>a.id.localeCompare(b.id)),
    arrows:context.arrows.slice().sort((a,b)=>a.id.localeCompare(b.id)),
    reactionArrows:context.reactionArrows.map(({id,stepId,version,start,end,reactants,products})=>
     ({id,stepId,version,start,end,reactants,products})).sort((a,b)=>a.id.localeCompare(b.id))
   });
   const next=await api.applyOperations([
    {id:'water',type:'molecule.add',smiles:'[OH2:1]'},
    {id:'lp-water',type:'lonePair.add',atom:'water:1'},
    {id:'attack-water',type:'arrow.add',source:{type:'lonePair',id:'lp-water'},target:{type:'formingBond',atom1:'water:1',atom2:'cation:1'},electronCount:2},
    {id:'protonated',type:'molecule.add',smiles:'[CH3:1][OH2+:2]'},
    {id:'next-step',type:'reactionArrow.add',reactants:['cation:1','water:1'],products:['protonated:1']}
   ],{runId:continued});
   const nextContext=await api.getContext(), water=nextContext.atoms.find(atom=>atom.id===next.atomMapping['water:1']);
   const old=nextContext.atoms.find(atom=>atom.id===beforeContinue.id), lp=nextContext.lonePairs[0];
   const lpPoint=MolWorkbench.model.lonePairPosition(lp,c.ctx());
   const toward=(lpPoint.x-water.x)*(old.x-water.x)+(lpPoint.y-water.y)*(old.y-water.y);
   const waterFlow=nextContext.arrows.find(arrow=>arrow.source.type==='lonePair'&&arrow.source.slotId===lp.id);
   const waterGeometry=waterFlow&&MolWorkbench.model.arrowGeometry(waterFlow,c.ctx());
   // Initial x/y placement is not a persistent pin. Declaring the connected
   // semantic step may reflow its participants; identity and chemistry survive.
   test('a later semantic step preserves the committed target chemistry while docking water, its automatic lone pair and real electron flow',
    old.id===beforeContinue.id&&JSON.stringify(atomChemistry(old))===JSON.stringify(atomChemistry(beforeContinue))&&
    old.label==='C'&&old.charge===1&&old.implicitH===3&&old.neighbors.length===0&&
    water.label==='O'&&water.charge===0&&water.implicitH===2&&water.neighbors.length===0&&
    Math.hypot(old.x-water.x,old.y-water.y)<3&&toward>0&&lp.ownerAtomId===water.id&&lp.refAtomId===old.id&&
    waterFlow?.electronCount===2&&waterFlow.source.ownerAtomId===water.id&&waterFlow.target.type==='formingBond'&&
    [waterFlow.target.atomA,waterFlow.target.atomB].sort().join() === [water.id,old.id].sort().join()&&
    waterGeometry.sourceOk&&waterGeometry.targetOk&&!waterGeometry.degenerate,
    {beforeContinue,old,water,lp,toward,waterFlow,waterGeometry,targetDisplacement:Math.hypot(old.x-beforeContinue.x,old.y-beforeContinue.y)});
   const nextArrow=nextContext.reactionArrows[0];
   test('a new product after an existing reactant group gets a separate horizontal stage',nextContext.reactionArrows.length===1&&
    Math.abs(nextArrow.start.y-nextArrow.end.y)<0.01&&nextArrow.start.x>Math.max(old.x,water.x)&&nextArrow.end.x>nextArrow.start.x);
   const finalStepState=stableStepState(nextContext), historyAfterStep=ed.historySize().undo;
   await api.endRun(continued);
   k3dAPI.undo();await wait(150);
   const undoneStep=await api.getContext(), restoredSeed=undoneStep.atoms.find(atom=>atom.id===beforeContinue.id);
   test('one undo removes the entire later step and restores the same seed chemistry and explicitly requested position',
    historyAfterStep===historyAfterSeed+1&&ed.historySize().undo===historyAfterSeed&&
    undoneStep.atoms.length===1&&restoredSeed?.x===beforeContinue.x&&restoredSeed?.y===beforeContinue.y&&
    JSON.stringify(atomChemistry(restoredSeed))===JSON.stringify(atomChemistry(beforeContinue))&&
    undoneStep.bonds.length===0&&undoneStep.lonePairs.length===0&&undoneStep.arrows.length===0&&
    undoneStep.reactionArrows.length===0&&undoneStep.reactionSteps.length===0,
    {historyAfterSeed,historyAfterStep,history:ed.historySize(),beforeContinue,restoredSeed});
   k3dAPI.redo();await wait(150);
   const redoneStep=await api.getContext();
   test('one redo restores every final atom position, chemical bond, lone pair, electron flow and reaction-step identity',
    ed.historySize().undo===historyAfterStep&&stableStepState(redoneStep)===finalStepState,
    {expected:nextContext,actual:redoneStep,history:ed.historySize()});
   const continuedAfterHistory='continued-reaction-after-history';
   await api.beginRun(continuedAfterHistory,{resumeRunId:continued,expectedSessionId:beforeContinueContext.sessionId});
   const follow=await api.applyOperations([
    {id:'later-water',type:'molecule.add',smiles:'[OH2:1]'},
    {id:'later-pair',type:'lonePair.add',atom:'later-water:1'},
    {id:'later-attack',type:'arrow.add',source:{type:'lonePair',id:'later-pair'},target:{type:'atom',atomId:'protonated:1'},electronCount:2},
    {id:'next-product',type:'molecule.add',smiles:'[CH3:1][OH:2]'},
    {id:'following-step',type:'reactionArrow.add',reactants:['protonated:1','later-water:1'],products:['next-product:1']}
   ],{runId:continuedAfterHistory});
   const following=await api.getContext(), laterWater=following.atoms.find(atom=>atom.id===follow.atomMapping['later-water:1']);
   test('a later co-reactant stays on the product side of the incoming native arrow',
    following.reactionArrows.length===2&&laterWater.x-0.45>=nextArrow.end.x+0.19,{nextArrow,laterWater});
   await api.endRun(continuedAfterHistory);

   phase='wrap-reaction';await k3dAPI.setMolecule('');await wait(150);ed.clearHistory();
   const wrap='wrap-reaction';await api.beginRun(wrap);
   const viewport=(await api.getContext()).viewport;
   await api.applyOperations([{id:'edge-substrate',type:'molecule.add',smiles:'[CH3:1][Br:2]',
    x:viewport.visibleBounds.x2-2,y:viewport.center.y-3}],{runId:wrap});
   const wrapReceipt=await api.applyOperations([
    {id:'edge-product',type:'molecule.add',smiles:'[CH3+:1]'},
    {id:'edge-bromide',type:'molecule.add',smiles:'[Br-:1]'},
    {id:'wrap-step',type:'reactionArrow.add',reactants:['edge-substrate:1'],products:['edge-product:1','edge-bromide:1']}
   ],{runId:wrap});
   const wrapped=await api.getContext(), wrappedArrow=wrapped.reactionArrows[0];
   const wrapPoints=['edge-product:1','edge-bromide:1'].map(ref=>wrapped.atoms.find(atom=>atom.id===wrapReceipt.atomMapping[ref]));
   test('near the right edge the next stage wraps below as one row',wrapped.reactionArrows.length===1 &&
    wrappedArrow.end.y-wrappedArrow.start.y>Math.abs(wrappedArrow.end.x-wrappedArrow.start.x)&&
    wrapPoints.every(p=>p.y>wrappedArrow.end.y)&&Math.abs(wrapPoints[0].y-wrapPoints[1].y)<0.01,{wrappedArrow,wrapPoints});
   await api.endRun(wrap);

   phase='precommit-chemical-validation';await k3dAPI.setMolecule('');await wait(150);ed.clearHistory();
   await api.beginRun('precommit-chemical-validation');
   const beforeChemicalValidation=await k3dAPI.serializeWorkbench(),chemicalHistory=ed.historySize().undo;
   let stagedSnapshot=null,typedFailure=false;
   const typedValidationError=Object.assign(new Error('synthetic chemical validation rejection'),{code:'mechanism_coverage_failed'});
   const precommitOps=[
    {id:'cv-nuc',type:'molecule.add',smiles:'[OH-:1]'},
    {id:'cv-sub',type:'molecule.add',smiles:'[CH3:1][Br:2]'},
    {id:'cv-product',type:'molecule.add',smiles:'[CH3:1][OH:2]'},
    {id:'cv-bromide',type:'molecule.add',smiles:'[Br-:1]'},
    {id:'cv-step',type:'reactionArrow.add',reactants:['cv-nuc:1','cv-sub:1'],products:['cv-product:1','cv-bromide:1'],layout:{conditions:'SN2 fixture'}},
    {id:'cv-pair',type:'lonePair.add',atom:'cv-nuc:1'},
    {id:'cv-attack',type:'arrow.add',source:{type:'lonePair',id:'cv-pair'},target:{type:'formingBond',atom1:'cv-nuc:1',atom2:'cv-sub:1'},electronCount:2},
    {id:'cv-leave',type:'arrow.add',source:{type:'bond',atom1:'cv-sub:1',atom2:'cv-sub:2',component:'sigma'},target:{type:'atom',atomId:'cv-sub:2'},electronCount:2}
   ];
   try{await api.applyOperations(precommitOps,{runId:'precommit-chemical-validation',validateMechanism(snapshot){
    stagedSnapshot=snapshot;
    throw typedValidationError;
   }});}catch(error){typedFailure=error===typedValidationError&&error.code==='mechanism_coverage_failed';}
   const rolledBackChemical=await api.getContext();
   test('precommit validator receives resolved staged arrows, molecules and reaction connector metadata',
    stagedSnapshot?.atoms?.length===6&&stagedSnapshot?.molecules?.length===4&&stagedSnapshot?.arrows?.length===2&&
    stagedSnapshot.arrows.every(arrow=>[arrow.source,arrow.target].every(endpoint=>endpoint.type!=='atom'||stagedSnapshot.atoms.some(atom=>atom.id===endpoint.atomId)))&&
    stagedSnapshot.reactionArrows?.length===1&&stagedSnapshot.reactionArrows[0].conditions==='SN2 fixture'&&stagedSnapshot.reactionArrows[0].reactants?.length===2&&stagedSnapshot.reactionArrows[0].products?.length===2,
    stagedSnapshot);
   test('typed precommit rejection survives and rolls back native state, history and mechanism',typedFailure&&
    beforeChemicalValidation===await k3dAPI.serializeWorkbench()&&ed.historySize().undo===chemicalHistory&&
    rolledBackChemical.atoms.length===0&&rolledBackChemical.bonds.length===0&&rolledBackChemical.arrows.length===0&&
    rolledBackChemical.lonePairs.length===0&&rolledBackChemical.reactionArrows.length===0,
    {typedFailure,history:ed.historySize(),rolledBackChemical});
   await api.endRun('precommit-chemical-validation');
   test('no uncaught engine errors during bridge operations',errors.length===0,errors);
   return {checks,events,errors,final:await api.getContext()};
  })().catch(error=>{console.error('AGENT_TEST_ERROR '+error.stack);throw error;})`);
  Object.assign(report,{application:'MolStudio canvas',page:'fusion/canvas.html',
   build:process.env.MOLSTUDIO_TEST_BUILD||'source checkout',service:'http://127.0.0.1:'+(process.env.MOLSTUDIO_PORT||48972),
   scope:'Native editor bridge regression with synthetic operations; no real model calls.'});
  fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(OUT,'final.png'),(await win.capturePage()).toPNG());
  const failures=report.checks.filter(check=>!check.pass);console.log(JSON.stringify({passed:report.checks.length-failures.length,total:report.checks.length,failures},null,2));
  process.exitCode=failures.length?1:0;
 }catch(error){console.error(error);fs.writeFileSync(path.join(OUT,'error.txt'),String(error.stack||error));process.exitCode=1;}
 finally{clearTimeout(watchdog);win.destroy();app.exit(process.exitCode||0);}
});
