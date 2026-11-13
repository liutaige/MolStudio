// 复现“run 中途被 stopped”问题：合成 SSE 慢流 + 真实画布，不需要模型请求。
// 观察点：run_end reason、molstudio:agent-canvas-change 序列、__molstudioDebugScanTraces。
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../../.jez/artifacts/agent-stop-debug');
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', path.join(OUT, 'electron-profile'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(2), 240000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') console.log('RENDERER', e.message); });
  try {
    await win.loadURL('http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 48991) + '/canvas.html');
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 200; i++) { if (await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')) break; await wait(100); }
    const report = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const rt=molstudioAgent.getRuntime(), api=k3dAPI.agent, a=MolWorkbench.app.adapter, ed=a.ed;
      const state=window.__stopDebug={events:[],canvasChanges:[],traces:[],result:null};
      addEventListener('molstudio:agent-canvas-change',ev=>{const d=ev.detail||{};state.canvasChanges.push({source:d.source,reason:d.reason,revision:d.revision,activeTraces:(window.__molstudioDebugScanTraces||[]).slice(-2)});state.traces=(window.__molstudioDebugScanTraces||[]).slice();});
      addEventListener('molstudio:agent-event',ev=>{const e=ev.detail;state.events.push({type:e.type,tool:e.toolName,isError:e.isError,status:e.status,reason:e.reason,turns:e.turns,ops:e.completedOperations,message:e.type==='error'?e.message:undefined});});
      const enc=new TextEncoder();
      const frame=(delta,finish=null)=>enc.encode('data: '+JSON.stringify({id:'slow',created:0,model:'slow',choices:[{index:0,delta,finish_reason:finish}]})+'\\n\\n');
      const ops=[
        {id:'a1',type:'molecule.add',smiles:'[C+:1]([CH3:2])([CH3:3])[CH3:4]'},
        {id:'n1',type:'molecule.add',smiles:'[OH-:1]'},
        {id:'p1',type:'lonePair.add',atom:'n1:1',angle:180},
        {id:'ar1',type:'arrow.add',source:{type:'lonePair',id:'p1'},target:{type:'atom',atomId:'a1:1'},electronCount:2},
        {id:'prod',type:'molecule.add',smiles:'[CH3:5][OH:6]'},
        {id:'br',type:'molecule.add',smiles:'[Br-:1]'}
      ];
      const prefix='{"operations":['+JSON.stringify(ops[0])+',';
      const suffix=ops.slice(1).map(JSON.stringify).join(',')+'],"taskScope":{"type":"completeMechanism"},"finish":true}';
      const nativeFetch=rt._fetch;
      rt._getConfig=async()=>({configured:true,sessionToken:'x',model:'slow',baseUrl:'https://slow.invalid/v1',maxTurns:24});
      rt._fetch=async function(url,init){
        if(url!=='/api/agent/model')return nativeFetch(url,init);
        state.modelRequests=(state.modelRequests||0)+1;
        // 每块之间 150ms：制造真实长流的时间窗，让 RAF/定时器有机会插入
        return new Response(new ReadableStream({async start(c){
          c.enqueue(frame({role:'assistant',tool_calls:[{index:0,id:'slow1',type:'function',function:{name:'draw_operations',arguments:prefix}}]}));
          await wait(150);
          for(const piece of suffix.match(/[\\s\\S]{1,120}/g)){c.enqueue(frame({tool_calls:[{index:0,function:{arguments:piece}}]}));await wait(150);}
          c.enqueue(frame({},'tool_calls'));
          await wait(120);
          c.enqueue(enc.encode('data: [DONE]\\n\\n'));c.close();
        }}),{headers:{'Content-Type':'text/event-stream'}});
      };
      await k3dAPI.setMolecule('');await wait(350);ed.clearHistory();
      molstudioAgent.open();
      state.pending=molstudioAgent.send('画出叔丁基溴在水中发生取代的完整 SN1 机理，画到中性产物。').then(r=>{state.result=r;return r;},e=>{state.result={status:'error',error:e.message};return state.result;});
      await state.pending;await wait(400);
      const ctx=await api.getContext();
      return {result:state.result,modelRequests:state.modelRequests||0,
        events:state.events,canvasChanges:state.canvasChanges,traces:state.traces,
        atoms:ctx.atoms.length,molecules:(ctx.molecules||[]).length,arrows:ctx.arrows.length,lp:ctx.lonePairs.length,
        previewLeft:!!a.doc.querySelector('[data-agent-preview]')};
    })().catch(e=>{console.error('STOP_DEBUG_ERROR '+(e.stack||e));throw e;})`);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    const stopped = report.events.some(e => e.type === 'run_end' && e.status === 'stopped');
    console.log(JSON.stringify({ status: report.result && report.result.status, requests: report.modelRequests,
      stoppedEvents: report.events.filter(e => e.type === 'run_end' && e.status === 'stopped'),
      canvasChanges: report.canvasChanges, traces: (report.traces || []).slice(0, 4) }, null, 2).slice(0, 4000));
    process.exitCode = stopped ? 1 : 0;
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(OUT, 'error.txt'), String(error.stack || error));
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog); win.destroy(); app.exit(process.exitCode || 0);
  }
});
