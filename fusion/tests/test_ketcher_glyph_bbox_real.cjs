'use strict';
// Isolated actual editor: compare native DOM screen rectangles to adapter model
// boxes across zoom, redraw and reopen. No model requests.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const OUT=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT||'/tmp/molstudio-glyph-box-real');
const PORT=Number(process.env.MOLSTUDIO_PORT)||49087,INJECT=process.env.MOLSTUDIO_GLYPH_SOURCE==='1';
const INPUT=path.resolve(process.env.MOLSTUDIO_GLYPH_INPUT||path.join(__dirname,'../../.jez/artifacts/robinson-completion-20261112/explicit-hydrogen-live/phase-04.molwork'));
const SOURCE=fs.readFileSync(INPUT,'utf8');fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-glyph-box-')));
const report={application:'MolStudio canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD||'current served resources',
 service:`http://127.0.0.1:${PORT}`,source:INPUT,sourceAdapterInjected:INJECT,modelCalls:0,checks:[]};
let win;const timer=setTimeout(()=>{report.ok=false;report.error='watchdog';fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(2)},90000);
async function inspect(){
 const a=MolWorkbench.app.adapter,st=a.ed.struct(),ct=a.ed.render.ctab,svg=a.canvasSvg(),issues=[],items=[],counts={labels:0,atomBoxes:0,hydrogenBoxes:0},started=performance.now();
 const expected=node=>{const r=node.getBoundingClientRect(),corners=[[r.left,r.top],[r.right,r.top],[r.left,r.bottom],[r.right,r.bottom]].map(([x,y])=>a.clientToModel({x,y}));
  return{x1:Math.min(...corners.map(p=>p.x)),y1:Math.min(...corners.map(p=>p.y)),x2:Math.max(...corners.map(p=>p.x)),y2:Math.max(...corners.map(p=>p.y))}};
 const contains=(outer,inner)=>outer&&inner&&outer.x1<=inner.x1+0.001&&outer.y1<=inner.y1+0.001&&outer.x2>=inner.x2-0.001&&outer.y2>=inner.y2-0.001;
 for(const[id,atom]of st.atoms){const v=ct.atoms.get(id),uuid=a.uuidOfAtom(id);if(!v?.showLabel||!v?.visel?.paths?.length)continue;
  const box=a.atomLabelBox(uuid,{planning:true}),variant=a.context(null).planningContextAtZoom(a.zoom()).atomLabelBox(uuid);counts.labels++;
  const paths=v.visel.paths.filter(p=>p.node?.isConnected&&p.node.getBoundingClientRect().width>0&&p.node.getBoundingClientRect().height>0);
  for(const p of paths)if(!contains(box?.rect,expected(p.node)))issues.push({uuid,kind:'full',text:p.node.textContent});
  const actuals=paths.map(p=>expected(p.node));
  for(const bounds of actuals)if(!contains(variant?.rect,bounds))issues.push({uuid,kind:'zoom-variant'});
  for(const bounds of actuals)if(!contains(box?.planningRect,bounds))issues.push({uuid,kind:'planning'});
  items.push({uuid,actuals,planningRect:box?.planningRect});
  const label=v.label?.path?.node;if(label?.isConnected){counts.atomBoxes++;if(!contains(box?.atomRect,expected(label)))issues.push({uuid,kind:'atom'});}
  if(atom.implicitH>0&&atom.label!=='H'){
   const hs=paths.filter(p=>p.type==='text'&&(p.node.textContent==='H'||p.node.textContent===String(atom.implicitH)));
   counts.hydrogenBoxes+=hs.length;for(const p of hs)if(!box?.hydrogenRects?.some(r=>contains(r,expected(p.node))))issues.push({uuid,kind:'hydrogen',text:p.node.textContent});
  }
 }
 const model=MolWorkbench.app.model,ctx=a.context(model),variantCtx=ctx.planningContextAtZoom(a.zoom());let maxLpError=0,lpCount=0;
 for(const lp of model.state.lonePairs){const actual=MolWorkbench.model.lonePairPosition(lp,ctx),virtual=MolWorkbench.model.lonePairPosition(lp,variantCtx);
  if(actual&&virtual){lpCount++;maxLpError=Math.max(maxLpError,Math.hypot(actual.x-virtual.x,actual.y-virtual.y));}}
 if(lpCount&&maxLpError>.002)issues.push({kind:'zoom-variant-lone-pair',maxLpError,lpCount});
 return{zoom:a.zoom(),counts,issues,items,maxLpError,lpCount,elapsedMs:performance.now()-started,cacheSize:a._glyphEnvelopeCache?.size||0};
}
async function cacheBehavior(){
 const a=MolWorkbench.app.adapter,ct=a.ed.render.ctab;
 const chosen=[...a.ed.struct().atoms].map(([id,atom])=>({id,atom,vis:ct.atoms.get(id)})).find(x=>x.atom.label==='O'&&x.atom.implicitH===0&&x.vis?.showLabel&&x.vis.visel?.paths?.length===1);
 if(!chosen)return{error:'single oxygen glyph missing'};
 const uuid=a.uuidOfAtom(chosen.id),node=chosen.vis.label.path.node,span=node.querySelector('tspan'),font=node.style.fontSize,x=node.getAttribute('x'),dy=span?.getAttribute('dy'),text=span?.textContent;
 if(!span||x===null||dy===null)return{error:'expected text attributes missing'};
 const box=()=>a.atomLabelBox(uuid,{planning:true}).planningRect,close=(x,y)=>Math.abs(x-y)<.001;
 a._glyphEnvelopeCache.clear();
 try{
  const initial=box(),count=a._glyphEnvelopeCache.size;
  node.setAttribute('x',String(Number(x)+40));const moved=box(),afterMove=a._glyphEnvelopeCache.size;
  node.setAttribute('x',x);span.setAttribute('dy',String(Number(dy)+1));const shifted=box(),afterDy=a._glyphEnvelopeCache.size;span.setAttribute('dy',dy);
  node.style.fontSize='19px';const styled=box(),afterFont=a._glyphEnvelopeCache.size;node.style.fontSize=font;
  span.textContent='Cl';const changed=box(),afterText=a._glyphEnvelopeCache.size;span.textContent=text;
  a.doc.fonts.dispatchEvent(new a.doc.defaultView.Event('loadingdone'));const invalidated=a._glyphEnvelopeCache.size;const rebuilt=box();
  return{translation:close(moved.x1-initial.x1,1)&&close(moved.x2-initial.x2,1)&&afterMove===count,
   dyTranslation:close(shifted.y1-initial.y1,.025)&&close(shifted.y2-initial.y2,.025)&&afterDy===count,
   fontStyle:afterFont>count&&(styled.x2-styled.x1)>(initial.x2-initial.x1),
   glyphText:afterText>afterFont&&(changed.x2-changed.x1)!==(initial.x2-initial.x1),
   fontInvalidation:invalidated===0&&close(rebuilt.x1,initial.x1)&&close(rebuilt.y1,initial.y1),
   counts:{count,afterMove,afterDy,afterFont,afterText,invalidated}};
 }finally{node.setAttribute('x',x);span.setAttribute('dy',dy);node.style.fontSize=font;span.textContent=text;}
}
app.whenReady().then(async()=>{win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s);
 try{await win.loadURL(report.service+'/canvas.html');for(let i=0;i<400;i++){if(await js('!!k3dAPI?.workbenchReady?.()'))break;await new Promise(r=>setTimeout(r,80))}
 await js('k3dAPI.agent.getContext()');if(INJECT){await js(fs.readFileSync(path.join(__dirname,'../workbench/ketcher-adapter.js'),'utf8'));await js('Object.setPrototypeOf(MolWorkbench.app.adapter,MolWorkbench.adapter.KetcherAdapter.prototype);void 0')}
 for(const round of ['initial','reopened']){const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(SOURCE)+')');if(!loaded.ok)throw Error('load failed');const measured=[];
  for(const z of [1,.54,.41,1.5]){await js(`MolWorkbench.app.adapter.ed.zoom(${z});MolWorkbench.app.adapter.ed.render.update();void 0`);await new Promise(r=>setTimeout(r,150));
   const result=await js('('+inspect.toString()+')()');measured.push(result);const {items,...summary}=result;report.checks.push({name:`${round} ${z}× live glyphs, atom and implicit-H boxes contain screen geometry`,pass:result.counts.labels>0&&result.counts.atomBoxes>0&&result.counts.hydrogenBoxes>0&&result.issues.length===0,...summary});}
  const contains=(outer,inner)=>outer&&outer.x1<=inner.x1+0.001&&outer.y1<=inner.y1+0.001&&outer.x2>=inner.x2-0.001&&outer.y2>=inner.y2-0.001;
  const baseline=new Map(measured[1].items.map(item=>[item.uuid,item.planningRect])),outside=[];
  for(const result of measured)for(const item of result.items)for(const actual of item.actuals)if(!contains(baseline.get(item.uuid),actual))outside.push({zoom:result.zoom,uuid:item.uuid});
  report.checks.push({name:`${round} planning bounds measured at .54× contain actual glyphs at 1/.54/.41/1.5×`,pass:outside.length===0,outside});
  await js(`(()=>{const e=MolWorkbench.app.adapter.ed;for(const[id]of e.struct().atoms)e.render.ctab.markItem('atoms',id,1);e.update(true)})()`);await new Promise(r=>setTimeout(r,150));
  const redrawn=await js('('+inspect.toString()+')()');const {items,...redrawSummary}=redrawn;report.checks.push({name:`${round} redraw retains correct live glyph containment`,pass:redrawn.issues.length===0&&redrawn.counts.labels>0,...redrawSummary});
 }
 const behavior=await js('('+cacheBehavior.toString()+')()');
 for(const key of ['translation','dyTranslation','fontStyle','glyphText','fontInvalidation'])report.checks.push({name:`planning cache: ${key}`,pass:behavior[key]===true,detail:behavior});
 report.ok=report.checks.every(c=>c.pass);
 }catch(error){report.ok=false;report.error=String(error.stack||error)}finally{fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));clearTimeout(timer);console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,total:report.checks.length,failures:report.checks.filter(c=>!c.pass).map(c=>({name:c.name,issues:c.issues?.slice(0,8),detail:c.detail})),error:report.error}));win.destroy();app.exit(report.ok?0:1)}});
