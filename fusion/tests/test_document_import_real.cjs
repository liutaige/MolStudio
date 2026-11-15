'use strict';
const {app,BrowserWindow,clipboard,ClipboardItem}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {revisionSource}=require('../workbench/agent-bridge.js');
const out=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT||'.jez/artifacts/document-import-real'),port=process.env.MOLSTUDIO_PORT||49076;
fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-import-')));
const report={application:'MolStudio current canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD||'current source checkout',service:`http://127.0.0.1:${port}`,modelCalls:0,checks:[],errors:[]};
const fixture=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8'));
const stable=value=>JSON.stringify((function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;})(value));
const authored=text=>{const doc=JSON.parse(text);doc.ket=revisionSource(doc.ket);delete doc.agentTask;return stable(doc);};
const wait=ms=>new Promise(r=>setTimeout(r,ms));let win,originalClipboard=null;
const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const watchdog=setTimeout(()=>{report.ok=false;report.error='watchdog';write();win?.destroy();app.exit(2);},120000);
async function saveClipboard(){const items=[];for(const item of await clipboard.read()){const entries=[];for(const format of item.types){try{const value=await item.getType(format);entries.push(format==='electron application/bookmark'?{format,bookmark:value}:{format,buffer:Buffer.from(await value.arrayBuffer())});}catch{}}if(entries.length)items.push(entries);}return items;}
async function restoreClipboard(){if(originalClipboard===null)return;clipboard.clear();if(originalClipboard.length)await clipboard.write(originalClipboard.map(entries=>new ClipboardItem(Object.fromEntries(entries.map(entry=>[entry.format,entry.bookmark||new Blob([entry.buffer],{type:entry.format})])))));report.clipboardRestored=true;originalClipboard=null;}
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1500,height:1160,webPreferences:{backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message);});
  const js=(code,gesture=false)=>win.webContents.executeJavaScript(code,gesture);
  const check=(name,pass,detail)=>{report.checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});write();if(!pass)throw Error(name);};
  const snapshot=()=>js('(async()=>({source:await k3dAPI.serializeWorkbench(),context:await k3dAPI.agent.getContext(),history:MolWorkbench.app.adapter.ed.historySize(),selection:MolStudio.document.getSelection()}))()');
  const escape=async()=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(150);};
  const place=async(point)=>{const p={x:Math.round(point.x),y:Math.round(point.y)};win.webContents.sendInputEvent({type:'mouseMove',...p});await wait(80);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(180);};
  try{
    await win.loadURL(report.service+'/canvas.html');for(let n=0;n<400&&!await js('!!k3dAPI?.document?.importFile&&!!MolWorkbench.app.reactionSteps?.prepareClipboardImport');n++)await wait(80);
    await js(`(async()=>{await k3dAPI.setMolecule('');const p=MolStudio.document;p.init({mode:'paper',orientation:'landscape',pageCount:2});p.addText({x:4,y:4,w:18,h:2,text:'Destination content'});p.fitPage();MolWorkbench.app.adapter.ed.clearHistory();})()`);
    const mixed=fixture('workbench-mechanism/F01.molwork');mixed.version=2;
    mixed.mechanism.steps[0].label='自定义源步骤';
    mixed.document=await js(`(()=>{const d=MolWorkbench.documentModel.createDocument({mode:'paper',pageCount:5});d.objects=[{id:'source-note',kind:'text',band:'front',x:10,y:13,w:12,h:2,rotation:0,rich:{text:'Imported source note'}},{id:'source-shape',kind:'shape',shape:'rect',band:'back',x:10,y:17,w:5,h:3,rotation:0,fill:'#fef3c7'},{id:'source-image',kind:'image',band:'back',x:17,y:17,w:3,h:3,rotation:0,asset:'source-png'}];d.assets={'source-png':{mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4o6EBRAwQCgAjrgSxn17XlQAAAABJRU5ErkJggg=='}};return d;})()`);
    const baseline=await snapshot();
    const first=await js('(()=>{MolWorkbench.app.documentUI.showPageSetup();return MolStudio.document.importFile(new File(['+JSON.stringify(JSON.stringify(mixed))+'],"mixed-source.molwork",{type:"application/json"}));})()');
    const preview=await js(`(async()=>{let save,read;try{await k3dAPI.serializeWorkbench();save='unexpected success';}catch(e){save=e.message;}try{await k3dAPI.agent.getContext();read='unexpected success';}catch(e){read=e.code;}return{save,read,active:!!MolWorkbench.app.controller.nativePasteSession?.active,objects:MolStudio.document.getState().objects.length,history:MolWorkbench.app.adapter.ed.historySize()};})()`);
    check('file import stages a real native preview without committing objects or history',first.ok&&first.staged&&preview.active&&preview.objects===1&&preview.history.undo===0,{first,preview});
    check('save and AI reads reject half-committed native preview geometry',/放置|取消/.test(preview.save)&&preview.read==='edit_in_progress',preview);
    await escape();const cancelled=await snapshot();
    check('Escape cancels native file preview and preserves exact authored source and history',authored(cancelled.source)===authored(baseline.source)&&stable(cancelled.history)===stable(baseline.history));
    const staged=await js('MolStudio.document.importFile('+JSON.stringify({name:'mixed-source.molwork',text:JSON.stringify(mixed)})+')');
    const target=await js('MolStudio.document.modelToClient({x:28,y:20})');await place(target);
    const inserted=await snapshot(),insertDoc=JSON.parse(inserted.source);
    check('click commits chemistry LP arrows document objects and mechanism-step labels in one native action',staged.ok&&inserted.context.atoms.length===3&&inserted.context.lonePairs.length===1&&inserted.context.arrows.length===2&&insertDoc.document.objects.length===4&&insertDoc.mechanism.steps.some(s=>s.label==='自定义源步骤')&&inserted.history.undo===1,{counts:{atoms:inserted.context.atoms.length,lp:inserted.context.lonePairs.length,arrows:inserted.context.arrows.length,objects:insertDoc.document.objects.length},history:inserted.history,status:await js('MolWorkbench.app.controller.lastNativePasteResult')});
    check('source page setup is ignored during insertion',insertDoc.document.page.orientation==='landscape'&&insertDoc.document.pageCount===2&&stable(insertDoc.document.pages)===stable(JSON.parse(baseline.source).document.pages));
    await js('k3dAPI.undo()');await wait(100);check('one undo removes the entire mixed file insertion',authored((await snapshot()).source)===authored(baseline.source));
    await js('k3dAPI.redo()');await wait(100);const insertedRedo=await snapshot();
    if(authored(insertedRedo.source)!==authored(inserted.source)){fs.writeFileSync(path.join(out,'redo-expected.molwork'),inserted.source);fs.writeFileSync(path.join(out,'redo-actual.molwork'),insertedRedo.source);}
    check('one redo restores the entire mixed file insertion',authored(insertedRedo.source)===authored(inserted.source));
    // Native route with no LP or electron-flow objects still requires identity
    // mapping, new semantic IDs and graph-port namespaces.
    const graph=fixture('proton-transfer-wrong-target.molwork');graph.mechanism.lonePairs=[];graph.mechanism.arrows=[];
    const beforeGraph=await snapshot();
    const firstGraph=await js('MolStudio.document.importFile('+JSON.stringify({name:'route-no-lp.molwork',text:JSON.stringify(graph)})+',{at:{x:28,y:63}})');
    const graphOne=await snapshot();
    check('zero-LP zero-electron-flow native route imports its complete semantic steps',firstGraph.ok&&graphOne.context.reactionSteps.length===3&&graphOne.context.lonePairs.length===1&&graphOne.context.arrows.length===2,{firstGraph,steps:graphOne.context.reactionSteps.map(s=>s.stepId)});
    const secondGraph=await js('MolStudio.document.importFile('+JSON.stringify({name:'route-no-lp.molwork',text:JSON.stringify(graph)})+',{at:{x:90,y:63}})');
    const graphTwo=await snapshot(),g1=JSON.parse(graphOne.source),g2=JSON.parse(graphTwo.source);
    const tokens=d=>new Set((d.reactionSteps||[]).flatMap(s=>(s.labels||[]).filter(l=>l.role==='graphPort').map(l=>l.token||l.text)));
    const oneTokens=tokens(g1),twoTokens=tokens(g2),newTokens=[...twoTokens].filter(t=>!oneTokens.has(t));
    const ids=g2.reactionSteps.map(s=>s.stepId);
    check('repeated route insertion uses distinct step IDs and continuation tokens',secondGraph.ok&&ids.length===6&&new Set(ids).size===6&&newTokens.length>=oneTokens.size,{secondGraph,ids,tokens:[...twoTokens]});
    await js('k3dAPI.undo()');await wait(100);check('route post-native label renaming and step metadata undo as one action',authored((await snapshot()).source)===authored(graphOne.source));
    await js('k3dAPI.redo()');await wait(100);const graphRedo=await snapshot();if(authored(graphRedo.source)!==authored(graphTwo.source)){fs.writeFileSync(path.join(out,'route-redo-expected.molwork'),graphTwo.source);fs.writeFileSync(path.join(out,'route-redo-actual.molwork'),graphRedo.source);}check('route metadata and renamed native labels redo together',authored(graphRedo.source)===authored(graphTwo.source));
    const beforeMove=await snapshot();await js('MolStudio.document.selectAll();MolStudio.document.moveSelection(.5,.25)');await wait(100);const moved=await snapshot();
    check('mixed movement retains semantic native object identities and transformed graph anchors',moved.context.reactionSteps.length===beforeMove.context.reactionSteps.length&&JSON.parse(moved.source).reactionSteps.every(s=>!s.flow?.anchors||s.flow.anchors.every(anchor=>{const a=moved.context.atoms.find(a=>a.id===anchor.atomId);return a&&Math.abs(a.x-anchor.x)<1e-4&&Math.abs(a.y-anchor.y)<1e-4;})),{steps:moved.context.reactionSteps.length});
    await js('k3dAPI.undo()');await wait(100);check('mixed movement undo restores semantic layout and native geometry',authored((await snapshot()).source)===authored(beforeMove.source));
    // Fail only after native+semantic append has succeeded, to exercise rollback
    // of post-native label actions, LP/arrow state and partial document append.
    const failing=JSON.parse(JSON.stringify(graph));failing.version=2;failing.document=mixed.document;
    const beforeFailure=await snapshot();
    const failed=await js(`(async()=>{const c=MolWorkbench.app.documentController,original=c.appendFragment;c.appendFragment=function(f){original.call(this,f);throw Error('injected_document_append_failure');};try{return await MolStudio.document.importFile(${JSON.stringify({name:'failing.molwork',text:JSON.stringify(failing)})},{at:{x:90,y:120}});}finally{c.appendFragment=original;}})()`);
    await wait(100);const afterFailure=await snapshot();
    if(authored(afterFailure.source)!==authored(beforeFailure.source)||stable(afterFailure.selection)!==stable(beforeFailure.selection)){fs.writeFileSync(path.join(out,'failure-before.molwork'),beforeFailure.source);fs.writeFileSync(path.join(out,'failure-after.molwork'),afterFailure.source);fs.writeFileSync(path.join(out,'failure-selections.json'),JSON.stringify({before:beforeFailure.selection,after:afterFailure.selection},null,2));}
    check('failure after semantic and document append restores the complete source and exact history',!failed.ok&&/injected/.test(failed.error)&&authored(afterFailure.source)===authored(beforeFailure.source)&&stable(afterFailure.history)===stable(beforeFailure.history)&&stable(afterFailure.selection)===stable(beforeFailure.selection),{failed,beforeHistory:beforeFailure.history,afterHistory:afterFailure.history});
    fs.writeFileSync(path.join(out,'mixed-import-editable.molwork'),afterFailure.source);
    // Source-only document import never creates placeholder chemistry.
    const pure={format:'molstudio-workbench',version:2,ket:{root:{nodes:[]}},bindings:{atoms:[],bonds:[]},mechanism:{lonePairs:[],arrows:[],steps:[{id:'source-label',label:'Pure source'}]},document:mixed.document};
    const pureBase=await snapshot();
    const purePreview=await js('(()=>{MolWorkbench.app.documentUI.showPageSetup();return MolStudio.document.importFile(new File(['+JSON.stringify(JSON.stringify(pure))+'],"pure-document.molwork",{type:"application/json"}));})()');
    const pureState=await js('({atoms:MolWorkbench.app.adapter.struct().atoms.size,native:!!MolWorkbench.app.controller.nativePasteSession,preview:!!MolWorkbench.app.controller.pastePreview,objects:MolStudio.document.getState().objects.length})');
    check('pure document file preview uses no temporary or placeholder atoms',purePreview.ok&&pureState.preview&&!pureState.native&&pureState.atoms===pureBase.context.atoms.length,{purePreview,pureState});
    await escape();check('pure document preview Escape is lossless',authored((await snapshot()).source)===authored(pureBase.source));
    const purePlaced=await js('MolStudio.document.importFile('+JSON.stringify({name:'pure-document.molwork',text:JSON.stringify(pure)})+',{at:{x:20,y:20}})');
    const pureAfter=await snapshot();check('pure document file drop commits all objects with one undo and leaves chemistry unchanged',purePlaced.ok&&!purePlaced.staged&&pureAfter.context.atoms.length===pureBase.context.atoms.length&&JSON.parse(pureAfter.source).document.objects.length===JSON.parse(pureBase.source).document.objects.length+3&&pureAfter.history.undo===pureBase.history.undo+1,{purePlaced,history:pureAfter.history});
    await js('k3dAPI.undo()');await wait(100);check('one undo removes the complete pure-document drop',authored((await snapshot()).source)===authored(pureBase.source));
    // Preserve non-unit native geometry and owned conditions on repeated file
    // insertion. Scale only geometric fields, keeping dimensionless flow flags.
    const nonunit=fixture('reagent-right-regression.molwork'),scale=1.7;
    nonunit.mechanism.lonePairs=[];nonunit.mechanism.arrows=[];
    for(const node of Object.values(nonunit.ket))if(node?.type==='molecule')for(const atom of node.atoms)atom.location=atom.location.map((n,i)=>i<2?n*scale:n);
    for(const node of nonunit.ket.root.nodes){for(const p of node.data?.pos||[]){p.x*=scale;p.y*=scale;}if(node.boundingBox)for(const key of ['x','y','width','height'])node.boundingBox[key]*=scale;}
    for(const step of nonunit.reactionSteps)if(step.flow)for(const key of ['rowLeft','rowWidth','rowY','rowBottom','rowRight'])if(Number.isFinite(step.flow[key]))step.flow[key]*=scale;
    const conditionBase=await snapshot();
    const conditionFirst=await js('MolStudio.document.importFile('+JSON.stringify({name:'nonunit-conditions.molwork',text:JSON.stringify(nonunit)})+',{at:{x:28,y:110}})');
    const conditionOne=await snapshot(),conditionSecond=await js('MolStudio.document.importFile('+JSON.stringify({name:'nonunit-conditions.molwork',text:JSON.stringify(nonunit)})+',{at:{x:90,y:110}})');
    const conditionTwo=await snapshot(),conditionDoc=JSON.parse(conditionTwo.source),oldIds=new Set(JSON.parse(conditionBase.source).reactionSteps.map(s=>s.stepId));
    const newConditions=conditionDoc.reactionSteps.filter(s=>!oldIds.has(s.stepId));
    const sourceStep=nonunit.reactionSteps[0],sourceArrow=nonunit.ket.root.nodes[sourceStep.arrow].data.pos,sourceLabel=nonunit.ket.root.nodes[sourceStep.labels[0].node].boundingBox;
    const close=(a,b)=>Math.abs(a-b)<1e-5;
    const geometryValid=newConditions.every(step=>{const arrow=conditionDoc.ket.root.nodes[step.arrow].data.pos,label=conditionDoc.ket.root.nodes[step.labels[0].node].boundingBox;return close(arrow[1].x-arrow[0].x,sourceArrow[1].x-sourceArrow[0].x)&&close(arrow[1].y-arrow[0].y,sourceArrow[1].y-sourceArrow[0].y)&&close(label.x-arrow[0].x,sourceLabel.x-sourceArrow[0].x)&&close(label.y-arrow[0].y,sourceLabel.y-sourceArrow[0].y);});
    check('non-unit file insertion preserves straight-arrow geometry and native condition placement',conditionFirst.ok&&conditionSecond.ok&&newConditions.length===2&&geometryValid&&newConditions.every(s=>s.conditions==='Δ'&&s.labels.some(l=>l.role==='conditions'&&l.text==='Δ')),{conditionFirst,conditionSecond,steps:newConditions.map(s=>s.stepId),geometryValid});
    check('repeated condition labels have distinct semantic and native identities',new Set(newConditions.map(s=>s.stepId)).size===2&&new Set(newConditions.flatMap(s=>s.labels.map(l=>l.node))).size===2);
    await js('k3dAPI.undo()');await wait(100);check('non-unit route conditions undo atomically',authored((await snapshot()).source)===authored(conditionOne.source));
    await js('k3dAPI.redo()');await wait(100);check('non-unit route conditions redo with exact source geometry',authored((await snapshot()).source)===authored(conditionTwo.source));
    const ketBase=await snapshot(),ketResult=await js('MolStudio.document.importFile('+JSON.stringify({name:'native-only.ket',text:JSON.stringify(nonunit.ket)})+',{at:{x:160,y:110}})');
    const ketAfter=await snapshot(),ketDoc=JSON.parse(ketAfter.source),baseDoc=JSON.parse(ketBase.source);
    const countType=(doc,type)=>doc.ket.root.nodes.filter(node=>node.type===type).length;
    check('raw KET inserts native chemistry arrows and text without replacing the destination or inventing semantic steps',ketResult.ok&&ketAfter.context.atoms.length>ketBase.context.atoms.length&&ketDoc.reactionSteps.length===baseDoc.reactionSteps.length&&countType(ketDoc,'arrow')===countType(baseDoc,'arrow')+1&&countType(ketDoc,'text')===countType(baseDoc,'text')+1&&stable(ketDoc.document)===stable(baseDoc.document),{ketResult});
    await js('k3dAPI.undo()');await wait(100);check('one undo removes a complete native-only KET import',authored((await snapshot()).source)===authored(ketBase.source));
    // Real browser copy output (native serializer plus sidecar), without fake
    // native MIME construction or an internal clipboard cache.
    const zeroLoad=await js('k3dAPI.loadWorkbench('+JSON.stringify(JSON.stringify(graph))+')');
    check('zero-LP route fixture loads for real clipboard transport',zeroLoad.ok);
    await js("MolStudio.document.init({mode:'paper',orientation:'landscape',pageCount:2});MolStudio.document.addText({x:4,y:4,w:20,h:2,text:'Zero LP route clipboard'});MolWorkbench.app.adapter.ed.clearHistory();MolStudio.document.selectAll();");
    originalClipboard=await saveClipboard();win.show();win.focus();win.webContents.focus();
    const copy=await js(`(()=>{const f=document.getElementById('k'),w=f.contentWindow,d=f.contentDocument;window.__routeCopy=null;w.addEventListener('copy',e=>{window.__routeCopy={trusted:e.isTrusted,records:[...(e.clipboardData?.types||[])].map(format=>({format,value:e.clipboardData.getData(format)}))};},{once:true});f.focus();MolWorkbench.app.adapter.ed.focusCliparea();const result=d.execCommand('copy');return{result,capture:window.__routeCopy,defaultEvents:w.molstudioClipboard.preferEvents};})()`,true);
    await restoreClipboard();
    const copyData=copy.capture?.records||[],side=copyData.find(x=>x.format==='application/x-molstudio-mechanism'),payload=side&&JSON.parse(side.value);
    check('default browser trusted copy retains zero-LP route semantics plus native chemical MIME',copy.defaultEvents===true&&copy.capture?.trusted&&payload?.identity?.atoms.length===24&&payload.identity.lonePairs.length===0&&payload.arrows.length===0&&payload.reactionSteps.steps.length===3&&copyData.some(r=>/^chemical\//.test(r.format)),{trusted:copy.capture?.trusted,formats:copyData.map(r=>r.format),steps:payload?.reactionSteps?.steps.length});
    const copyBase=await snapshot();
    await js(`(()=>{const w=document.getElementById('k').contentWindow,d=w.document,t=new w.DataTransfer();for(const r of ${JSON.stringify(copyData)})t.setData(r.format,r.value);d.querySelector('[data-cliparea="true"]').dispatchEvent(new w.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:t}));})()`);
    for(let n=0;n<100&&!await js('!!MolWorkbench.app.controller.nativePasteSession?.active');n++)await wait(40);
    const copyTarget=await js('(()=>{const p=MolStudio.document;p.fitPage(p.getState().pages[1].id);return p.modelToClient({x:28,y:63});})()');await place(copyTarget);
    const copied=await snapshot();
    check('real native clipboard placement preserves and re-identifies the entire zero-LP route',copied.context.reactionSteps.length===6&&copied.context.atoms.length===48&&copied.context.lonePairs.length===0&&copied.context.arrows.length===0&&copied.history.undo===copyBase.history.undo+1,{steps:copied.context.reactionSteps.length,atoms:copied.context.atoms.length,result:await js('MolWorkbench.app.controller.lastNativePasteResult')});
    await js('k3dAPI.undo()');await wait(120);check('one clipboard undo restores all original route metadata and native labels',authored((await snapshot()).source)===authored(copyBase.source));
    fs.writeFileSync(path.join(out,'zero-lp-route-editable.molwork'),(await snapshot()).source);
    await js('MolStudio.document.select([]);MolStudio.document.fitPage()');await wait(120);fs.writeFileSync(path.join(out,'canvas.png'),(await win.capturePage()).toPNG());
    report.ok=true;
  }catch(error){report.ok=false;report.error=String(error.stack||error);try{fs.writeFileSync(path.join(out,'failure.png'),(await win.capturePage()).toPNG());}catch{}}
  finally{try{await restoreClipboard();}catch(e){report.clipboardRestoreError=String(e);}write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,total:report.checks.length,error:report.error,out},null,2));win.destroy();app.exit(report.ok?0:1);}
});
