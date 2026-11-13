'use strict';
// Replay the exact visible answer captured from a real model into the packaged
// canvas panel; this is a deterministic renderer check, not another model call.
const { app, BrowserWindow } = require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const out=path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-report-render');
const input=path.resolve(process.env.MOLSTUDIO_CAPTURED_REPORT || '');
if(!process.env.MOLSTUDIO_CAPTURED_REPORT)throw new Error('MOLSTUDIO_CAPTURED_REPORT is required');
const previous=JSON.parse(fs.readFileSync(input,'utf8'));
const explanation=previous.checks?.find(c=>c.name==='visible final explanation covers all three chemical events and catalyst regeneration')?.detail?.finalExplanation || previous.probe?.text;
if(!explanation)throw new Error('Captured visible final explanation is missing');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'molstudio-report-render-')));
const report={application:'MolStudio canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD||'unspecified served build',
  service:'http://127.0.0.1:'+(process.env.MOLSTUDIO_PORT||49138),sourceReport:input,scope:'Exact prior real-model visible report rendered by the packaged panel; no model request.',checks:[],artifacts:[]};
let win;const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const watchdog=setTimeout(()=>{report.ok=false;report.failure='fixture watchdog';write();win?.destroy();app.exit(2)},90000);
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  try{
    await win.loadURL(report.service+'/canvas.html');const start=Date.now();while(!await js('!!k3dAPI?.workbenchReady?.() && !!molstudioAgent?.getRuntime?.() && !!molstudioAgent?.getPanel?.() && !!window.MolStudioAgentRuntime?.renderMessage')){if(Date.now()-start>40000)throw new Error('Panel/canvas unavailable');await new Promise(r=>setTimeout(r,100))}
    if(process.env.MOLSTUDIO_EXPLANATION_SEED){const source=fs.readFileSync(path.resolve(process.env.MOLSTUDIO_EXPLANATION_SEED),'utf8');const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(source)+')');if(!loaded?.ok)throw new Error('Saved canvas cannot load for replay')}
    const data=await js(`(()=>{const panel=molstudioAgent.getPanel(),message=${JSON.stringify(explanation)};
      panel.clear();molstudioAgent.open();const runId='captured-report-render';panel.handleEvent({type:'run_start',runId});
      panel.handleEvent({type:'assistant_start',runId,messageId:'captured'});panel.handleEvent({type:'text_delta',runId,messageId:'captured',delta:message,finalReport:true});
      panel.handleEvent({type:'assistant_end',runId,messageId:'captured'});panel.handleEvent({type:'run_end',runId,status:'completed'});
      const root=panel.element, html=MolStudioAgentRuntime.renderMessage(message),probe=document.createElement('div');probe.innerHTML=html;
      const visible=probe.cloneNode(true);visible.querySelectorAll('annotation,annotation-xml').forEach(node=>node.remove());
      return{mathElements:probe.querySelectorAll('math').length,katexErrors:probe.querySelectorAll('.katex-error').length,rawCeCount:(visible.textContent.match(/\\\\ce\\{/g)||[]).length,
        sourceCeCount:(message.match(/\\\\ce\\{/g)||[]).length,renderedText:probe.textContent,rect:(()=>{const b=root.getBoundingClientRect();return{x:Math.floor(b.x),y:Math.floor(b.y),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()};})()`);
    report.observation={mathElements:data.mathElements,katexErrors:data.katexErrors,rawCeCount:data.rawCeCount,sourceCeCount:data.sourceCeCount};
    report.checks.push({name:'captured chemical expressions render without literal ce commands or errors',
      pass:(process.env.MOLSTUDIO_ALLOW_NO_BARE_CE==='1'||data.sourceCeCount>0)&&data.mathElements>=data.sourceCeCount&&data.rawCeCount===0&&data.katexErrors===0});
    report.checks.push({name:'main answer text remains visible',pass:[1,2,3].every(n=>new RegExp('第\\s*'+n+'\\s*步|步骤\\s*'+n).test(data.renderedText))});
    await new Promise(resolve=>setTimeout(resolve,300));
    const panelRect=await js(`(()=>{const b=molstudioAgent.getPanel().element.getBoundingClientRect();return{x:Math.floor(b.x),y:Math.floor(b.y),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
    fs.writeFileSync(path.join(out,'panel.png'),(await win.capturePage(panelRect)).toPNG());report.artifacts.push('panel.png');
    fs.writeFileSync(path.join(out,'window.png'),(await win.capturePage()).toPNG());report.artifacts.push('window.png');
    report.ok=report.checks.every(c=>c.pass);
  }catch(e){report.ok=false;report.failure=String(e?.stack||e)}finally{clearTimeout(watchdog);write();console.log(JSON.stringify({ok:report.ok,checks:report.checks,failure:report.failure,out},null,2));win.destroy();app.exit(report.ok?0:1)}
});
