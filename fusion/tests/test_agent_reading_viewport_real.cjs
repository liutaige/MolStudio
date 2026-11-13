'use strict';
// Isolated actual canvas: no model requests. Long fixture is a frozen in-progress
// route; this verifies viewport policy, not chemical completion of that route.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const out=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT||'/tmp/molstudio-reading-viewport');fs.mkdirSync(out,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-reading-view-')));
const input=fs.readFileSync(path.join(__dirname,'fixtures/reading-viewport-regression.molwork'),'utf8'),port=Number(process.env.MOLSTUDIO_PORT)||49093;
const report={application:'MolStudio canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD||'local served build',service:`http://127.0.0.1:${port}`,modelRequests:0,checks:[]};
const timeout=setTimeout(()=>app.exit(2),180000);let win;
async function exercise(){
 const api=k3dAPI.agent,{adapter,model}=MolWorkbench.app,ed=adapter.ed,checks=[],metrics={};window.readingViewportResult={checks,metrics};
 const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});if(!pass)throw Error(name)};
 const visible=p=>{const area=ed.render.clientArea.getBoundingClientRect(),u=adapter.modelToUser(p),s=new adapter.doc.defaultView.DOMPoint(u.x,u.y).matrixTransform(adapter.canvasSvg().getScreenCTM());return s.x>=area.left&&s.x<=area.right&&s.y>=area.top&&s.y<=area.bottom;};
 let c=await api.getContext(),first=c.reactionSteps[0],last=c.reactionSteps.at(-1),byId=new Map(c.atoms.map(x=>[x.id,x]));
 const firstPoints=first.reactants.map(id=>byId.get(id)).filter(Boolean),lastPoints=last.products.map(id=>byId.get(id)).filter(Boolean);
 metrics.loadedZoom=adapter.zoom();
 check('long-page load opens at readable zoom and shows first step',adapter.zoom()>=1-1e-6&&firstPoints.some(visible),{zoom:adapter.zoom(),firstVisible:firstPoints.some(visible)});
 const before=await k3dAPI.serializeWorkbench(),history=ed.historyPtr;
 ed.zoom(.23);ed.render.update();check('manual overview remains available',Math.abs(adapter.zoom()-.23)<1e-6);
 const svg=await k3dAPI.exportMechanismImage('svg'),png=await k3dAPI.exportMechanismImage('png');
 const parsed=new DOMParser().parseFromString(decodeURIComponent(escape(atob(svg.dataUrl.split(',')[1]))),'image/svg+xml');
 check('overview exports all mechanism arrows and a complete raster',svg.ok&&png.ok&&parsed.querySelectorAll('.mech-arrow').length===model.state.arrows.length&&png.width>0&&png.height>0,{svgArrows:parsed.querySelectorAll('.mech-arrow').length,modelArrows:model.state.arrows.length,pngWidth:png.width,pngHeight:png.height});
 check('camera and export preserve editable document and history',before===await k3dAPI.serializeWorkbench()&&history===ed.historyPtr);
 // Append a real step in a reading-order run and complete it through the
 // public bridge; the new product is the completion focus.
 ed.zoom(1);ed.render.update();
 await api.beginRun('reading-end',{readingOrder:true});
 await api.applyOperations([{id:'reading-product',type:'molecule.add',smiles:'CCO'},
  {id:'reading-last-step',type:'reactionStep.create',reactants:[last.products[0]],products:['reading-product:1']}],{runId:'reading-end'});
 await api.endRun('reading-end',{status:'completed'});
 c=await api.getContext();byId=new Map(c.atoms.map(x=>[x.id,x]));last=c.reactionSteps.at(-1);const endpoint=last.products.map(id=>byId.get(id)).filter(Boolean);
 metrics.completedZoom=adapter.zoom();check('completed long-page run shows its latest product at readable zoom',adapter.zoom()>=1-1e-6&&endpoint.some(visible),{zoom:adapter.zoom(),lastVisible:endpoint.some(visible)});
 return window.readingViewportResult;
}
app.whenReady().then(async()=>{try{win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});win.webContents.session.webRequest.onBeforeRequest({urls:[`http://127.0.0.1:${port}/api/agent/model*`]},(_d,cb)=>cb({cancel:true}));const js=s=>win.webContents.executeJavaScript(s);await win.loadURL(report.service+'/canvas.html');for(let i=0;i<400&&!await js('!!k3dAPI?.workbenchReady?.()');i++)await new Promise(r=>setTimeout(r,80));await js('k3dAPI.agent.getContext()');const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(input)+')');if(!loaded.ok)throw Error('fixture load failed');await new Promise(r=>setTimeout(r,350));fs.writeFileSync(path.join(out,'long-load.png'),(await win.webContents.capturePage()).toPNG());Object.assign(report,await js('('+exercise.toString()+')()'));await new Promise(r=>setTimeout(r,350));fs.writeFileSync(path.join(out,'long-completed.png'),(await win.webContents.capturePage()).toPNG());const smallZoom=await js("(async()=>{await k3dAPI.setMolecule('');await k3dAPI.setMolecule('CCO');const small=await k3dAPI.serializeWorkbench();MolWorkbench.app.adapter.ed.zoom(.23);await k3dAPI.loadWorkbench(small);return MolWorkbench.app.adapter.zoom()})()");report.checks.push({name:'short molecule keeps existing native zoom',pass:Math.abs(smallZoom-.23)<1e-6,detail:{zoom:smallZoom}});report.ok=report.checks.every(x=>x.pass);}catch(e){report.ok=false;report.error=String(e.stack||e);if(win)try{Object.assign(report,await win.webContents.executeJavaScript('window.readingViewportResult||{}'));}catch{}}finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(x=>x.pass).length,total:report.checks.length,error:report.error,metrics:report.metrics}));clearTimeout(timeout);win?.destroy();app.exit(report.ok?0:1)}});
