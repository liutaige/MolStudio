'use strict';
// Native current-canvas regression: converter -> prepare -> clone -> real agent
// insertion/paste -> editable save/reopen. No model requests or reasoning data.
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const OUT=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT||'/tmp/molstudio-stereo-native-real');
const PORT=Number(process.env.MOLSTUDIO_PORT)||49136;
fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-stereo-native-')));
const report={application:'MolStudio canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD||'served source resources',
  service:`http://127.0.0.1:${PORT}`,modelRequests:0,checks:[]};let win;
const timeout=setTimeout(()=>{report.ok=false;report.error='watchdog';fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));app.exit(2)},120000);
async function exercise(){
 const MW=MolWorkbench,{adapter}=MW.app,native=document.getElementById('k').contentWindow.molstudioNativeActions,api=k3dAPI.agent;
 const checks=window.stereoNativeChecks=[],evidence=window.stereoNativeEvidence=[],samples=window.stereoNativeSamples={};
 const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw Error(name)};
 const definitions=[
  {id:'explicit-protonated',smiles:'[CH3:1][CH:2]=[O+:3][H:4]',unknownDouble:true},
  {id:'implicit-protonated',smiles:'[CH3:1][CH:2]=[OH+:3]'},
  {id:'r-center',smiles:'[CH3:1][C@H:2]([F:3])[Cl:4]',tetra:true},
  {id:'s-center',smiles:'[CH3:1][C@@H:2]([F:3])[Cl:4]',tetra:true},
  {id:'unknown-alkene',smiles:'[CH3:1][CH:2]=[CH:3][CH3:4]',unknownDouble:true},
  {id:'e-alkene',smiles:'[CH3:1]/[CH:2]=[CH:3]/[CH3:4]',ez:true},
  {id:'z-alkene',smiles:'[CH3:1]/[CH:2]=[CH:3]\\[CH3:4]',ez:true},
 ];
 const describe=fragment=>({atoms:[...fragment.atoms].map(([id,a])=>({id,label:a.label,stereoLabel:a.stereoLabel||null,stereoParity:a.stereoParity})),
  bonds:[...fragment.bonds].map(([id,b])=>({id,type:b.type,stereo:b.stereo||0,begin:b.begin,end:b.end}))});
 const sides=(points)=>{const [a,b,c,d]=points,cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);return Math.sign(cross(b,c,a)*cross(b,c,d))};
 for(const item of definitions){
  const response=await fetch('/api/agent/structure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({smiles:item.smiles})});
  const converted=await response.json();check(item.id+' converts successfully',response.ok&&converted.ok,converted.error);
  const fragment=native.prepareKet(JSON.stringify(converted.ket)),cloned=fragment.clone(),prepared=describe(fragment),copy=describe(cloned);
  evidence.push({id:item.id,smiles:item.smiles,converted:converted.ket,prepared,cloned:copy});item.converted=converted;item.fragment=fragment;
  check(item.id+' native clone preserves all atom and bond stereo metadata',JSON.stringify(prepared)===JSON.stringify(copy),{prepared,copy});
  if(item.tetra)check(item.id+' retains a real tetrahedral ABS label and assigned parity',prepared.atoms[1].stereoLabel==='abs'&&[1,2].includes(prepared.atoms[1].stereoParity),prepared);
  else check(item.id+' has no invented absolute atom label',prepared.atoms.every(a=>!a.stereoLabel)&&copy.atoms.every(a=>!a.stereoLabel),prepared);
  if(item.unknownDouble)check(item.id+' preserves legitimate crossed-double stereo 3',prepared.bonds.some(b=>b.type===2&&b.stereo===3)&&copy.bonds.some(b=>b.type===2&&b.stereo===3),prepared.bonds);
 }
 check('R and S retain opposite tetrahedral parities',describe(definitions[2].fragment).atoms[1].stereoParity!==describe(definitions[3].fragment).atoms[1].stereoParity);
 const e=definitions.find(x=>x.id==='e-alkene'),z=definitions.find(x=>x.id==='z-alkene');
 const sideOf=fragment=>sides([0,1,2,3].map(i=>fragment.atoms.get(i).pp));
 check('specified E and Z geometries remain distinct after native parsing and clone',sideOf(e.fragment)!==0&&sideOf(e.fragment)===sideOf(e.fragment.clone())&&
  sideOf(z.fragment)!==0&&sideOf(z.fragment)===sideOf(z.fragment.clone())&&sideOf(e.fragment)!==sideOf(z.fragment),{e:sideOf(e.fragment),z:sideOf(z.fragment)});
 // Exercise every supported tetrahedral bond parity, including unknown/wavy,
 // and explicit enhanced stereo groups without globally clearing labels.
 for(const [name,stereo,label] of [['up',1,'abs'],['down',6,'abs'],['wavy',4,'abs'],['and',1,'&1'],['or',6,'or1']]){
  const ket=JSON.parse(JSON.stringify(definitions[2].converted.ket)),section=ket.mol0,bond=section.bonds.find(b=>b.stereo);
  bond.stereo=stereo;section.atoms[bond.atoms[0]].stereoLabel=label;
  const prepared=native.prepareKet(JSON.stringify(ket)),cloned=prepared.clone(),roundTrip=native.prepareKet(native.serialize(cloned));
  const center=bond.atoms[0];
  check(name+' tetrahedral bond and enhanced group survive native prepare/clone/serialize',
   [prepared,cloned,roundTrip].every(f=>f.atoms.get(center).stereoLabel===label&&[1,2,3].includes(f.atoms.get(center).stereoParity)&&
    [...f.bonds.values()].some(b=>b.type===1&&b.stereo===stereo)),{prepared:describe(prepared),cloned:describe(cloned),roundTrip:describe(roundTrip)});
 }
 await k3dAPI.setMolecule('');await api.beginRun('stereo-native-add');
 const receipt=await api.applyOperations(definitions.map((item,i)=>({id:item.id,type:'molecule.add',smiles:item.smiles,x:4+(i%4)*5,y:4+Math.floor(i/4)*5})),{runId:'stereo-native-add'});
 await api.endRun('stereo-native-add');let context=await api.getContext();
 const mapping=receipt.atomMapping;
 const atom=(c,id)=>c.atoms.find(a=>a.id===id),nativeState=c=>JSON.stringify({atoms:c.atoms.map(({id,stereoLabel,stereoParity})=>({id,stereoLabel,stereoParity})).sort((a,b)=>a.id.localeCompare(b.id)),
  bonds:c.bonds.map(({id,order,stereo})=>({id,order,stereo})).sort((a,b)=>a.id.localeCompare(b.id))});
 const checkInserted=(c,suffix)=>{
  for(const item of definitions){const ids=item.converted.atoms.map(a=>mapping[item.id+':'+a.ref]),atoms=ids.map(id=>atom(c,id));
   check(item.id+' real agent insertion '+suffix+' retains intended atom stereo',item.tetra?atoms[1].stereoLabel==='abs'&&[1,2].includes(atoms[1].stereoParity):atoms.every(a=>!a.stereoLabel),atoms.map(({id,stereoLabel,stereoParity})=>({id,stereoLabel,stereoParity})));
   if(item.unknownDouble)check(item.id+' real insertion '+suffix+' retains double stereo3',c.bonds.some(b=>b.order===2&&b.stereo===3&&ids.includes(b.begin)&&ids.includes(b.end)));
  }
  const side=item=>sides(['1','2','3','4'].map(ref=>atom(c,mapping[item.id+':'+ref])));
  check('real insertion '+suffix+' retains different E/Z configurations',side(e)!==0&&side(z)!==0&&side(e)!==side(z),{e:side(e),z:side(z)});
 };
 checkInserted(context,'before save');const before=nativeState(context);
 samples.saved=await k3dAPI.serializeWorkbench();const image=await k3dAPI.exportMechanismImage('png');if(image.ok)samples.png=image.dataUrl;
 check('native stereo regression file reopens',(await k3dAPI.loadWorkbench(samples.saved)).ok);context=await api.getContext();
 check('save/reopen preserves exact stable atom and bond stereo metadata',nativeState(context)===before);
 checkInserted(context,'after reopen');samples.reopened=await k3dAPI.serializeWorkbench();
 return {checks,evidence};
}
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:[report.service+'/api/agent/model*']},(_d,cb)=>{report.modelRequests++;cb({cancel:true})});
 const js=code=>win.webContents.executeJavaScript(code);await win.loadURL(report.service+'/canvas.html');
 for(let i=0;i<400&&!await js('!!window.k3dAPI?.workbenchReady?.()');i++)await new Promise(r=>setTimeout(r,80));
 Object.assign(report,await js('('+exercise.toString()+')()'));report.ok=report.checks.every(c=>c.pass)&&report.modelRequests===0;
}catch(error){report.ok=false;report.error=String(error.stack||error);if(win)Object.assign(report,await win.webContents.executeJavaScript('({checks:window.stereoNativeChecks||[],evidence:window.stereoNativeEvidence||[]})').catch(()=>({})))}finally{
 if(win){const samples=await win.webContents.executeJavaScript('window.stereoNativeSamples||{}').catch(()=>({}));for(const[name,value]of Object.entries(samples))
  if(name==='png')fs.writeFileSync(path.join(OUT,'native-stereo.png'),Buffer.from(value.split(',')[1],'base64'));else fs.writeFileSync(path.join(OUT,name+'.molwork'),value);}
 fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,total:report.checks.length,error:report.error,failures:report.checks.filter(c=>!c.pass)},null,2));
 clearTimeout(timeout);win?.destroy();app.exit(report.ok?0:1);
}});
