'use strict';
// Real Ketcher PasteTool preview without a MolStudio sidecar, in an isolated
// Electron window. No OS clipboard is touched. Run with an isolated server:
// MOLSTUDIO_PORT=49083 npm --prefix fusion start
// MOLSTUDIO_PORT=49083 fusion/node_modules/.bin/electron fusion/tests/test_document_native_preview_real.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), assert = require('node:assert/strict');
const port = Number(process.env.MOLSTUDIO_PORT || 49083);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw Error('An isolated service port is required');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '.jez/artifacts/document-native-preview-real');
fs.mkdirSync(out, { recursive:true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-native-preview-')));
const report = { application:'MolStudio current canvas', page:'fusion/canvas.html', build:process.env.MOLSTUDIO_TEST_BUILD || 'source checkout; isolated Electron', service:`http://127.0.0.1:${port}`, osClipboardTouched:false, checks:[] };
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(r => setTimeout(r, ms));
let win;
const watchdog = setTimeout(() => { report.ok=false; report.error='watchdog'; write(); win?.destroy(); app.exit(2); }, 90000);
function contractedBranch() {
  // Execute the actual compiled PasteTool mouseup method, with its environment
  // stubbed only to reach the contracted-group + mergeItems branch. This is not
  // an Electron GUI proof of a contracted-group merge.
  const bundlePath = process.env.MOLSTUDIO_TEST_KETCHER_BUNDLE || path.join(__dirname, '../../ketcher-local/static/js/main.e47c48ad.js');
  report.compiledBranchBundle = path.resolve(bundlePath);
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const anchor = bundle.indexOf('this.molstudioClipboardCommitted=!0', bundle.indexOf('nativePasteStart'));
  const start = bundle.lastIndexOf('key:"mouseup",value:function', anchor);
  assert.ok(start >= 0 && anchor > start);
  const open = bundle.indexOf('{', bundle.indexOf('function', start));
  let depth=0, quote=null, escaped=false, end=-1;
  for (let i=open;i<bundle.length;i++) { const c=bundle[i]; if (quote) { if (escaped) escaped=false; else if (c==='\\') escaped=true; else if(c===quote) quote=null; continue; } if(c==='"'||c==="'") {quote=c;continue;} if(c==='{')depth++; else if(c==='}' && --depth===0){end=i+1;break;} }
  assert.ok(end>open);
  const method = bundle.slice(bundle.indexOf('function', start), end), calls=[];
  const ctx = { window:{molstudioClipboard:{nativePasteCommit:(action,token)=>calls.push([action,token])}},
    $Y:Object.assign, Vs:()=>[], js:()=>{throw Error('unexpected normal action');} };
  vm.createContext(ctx);
  const fn=vm.runInContext('('+method+')',ctx);
  const tool={isSingleContractedGroup:true,mergeItems:{atoms:new Map(),bonds:new Map()},struct:{},action:{},editor:{struct:()=>({}),tool:name=>calls.push(name)}};
  fn.call(tool);
  assert.equal(calls.length,2); assert.equal(calls[0][0],null); assert.equal(calls[0][1],undefined); assert.equal(calls[1],'select');
  assert.equal(tool.molstudioClipboardCommitted,true);
}
app.whenReady().then(async()=>{
  win = new BrowserWindow({show:true,width:1400,height:1000,webPreferences:{backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  const check=(name,pass,detail)=>{report.checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});write();if(!pass)throw Error(name);};
  try {
    contractedBranch(); check('actual compiled contracted-group merge branch emits end hook without action',true);
    await win.loadURL(report.service+'/canvas.html');
    for(let n=0;n<400 && !await js('!!window.k3dAPI?.agent?.getContext && !!window.MolWorkbench?.app?.adapter');n++)await wait(80);
    const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/workbench-mechanism/F01.molwork'),'utf8'));
    await js(`(async()=>{await k3dAPI.setMolecule('');MolWorkbench.app.adapter.ed.clearHistory();window.__nativePreviewKet=${JSON.stringify(fixture.ket)};})()`);
    const inspect=()=>js(`(async()=>{let save,ai;try{await k3dAPI.serializeWorkbench();save='ok';}catch(e){save=e.message;}try{await k3dAPI.agent.getContext();ai='ok';}catch(e){ai=e.code;}return{save,ai,flag:!!document.getElementById('k').contentWindow.molstudioClipboard.nativePreviewActive,session:!!MolWorkbench.app.controller.nativePasteSession,atoms:MolWorkbench.app.adapter.struct().atoms.size,history:MolWorkbench.app.adapter.ed.historySize()};})()`);
    const baseline=await inspect();
    const stage=()=>js(`(()=>{const a=MolWorkbench.app.adapter,fragment=document.getElementById('k').contentWindow.molstudioNativeActions.prepareKet(JSON.stringify(window.__nativePreviewKet));a.ed.tool('paste',fragment);})()`);
    await stage();await wait(150);const preview=await inspect();
    check('real pure-native PasteTool preview blocks save and AI without sidecar',preview.flag&&!preview.session&&preview.atoms>baseline.atoms&&/放置|取消/.test(preview.save)&&preview.ai==='edit_in_progress',{baseline,preview});
    await js("(()=>{MolWorkbench.app.adapter.ed.tool('select');return true;})()");await wait(150);const cancelled=await inspect();
    check('cancel clears preview flag and restores committed baseline',!cancelled.flag&&cancelled.save==='ok'&&cancelled.ai==='ok'&&cancelled.atoms===baseline.atoms&&cancelled.history.undo===baseline.history.undo,cancelled);
    await stage();await wait(100);
    const point=await js('MolStudio.document.modelToClient({x:5,y:5})');
    const p={x:Math.round(point.x),y:Math.round(point.y)};
    win.webContents.sendInputEvent({type:'mouseMove',...p});await wait(80);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(180);
    const placed=await inspect();
    check('placing pure-native preview clears flag and commits one undoable action',!placed.flag&&placed.save==='ok'&&placed.ai==='ok'&&placed.atoms>baseline.atoms&&placed.history.undo===baseline.history.undo+1,placed);
    report.ok=true;
  } catch(error) { report.ok=false;report.error=String(error.stack||error); }
  finally { write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,checks:report.checks,error:report.error,out},null,2));win.destroy();app.exit(report.ok?0:1); }
});
