'use strict';
// Native canvas + real runtime with synthetic SSE. The fixture is the actual
// model-authored main-canvas diagram from the 2026-11-13 acceptance: its first
// hydronium O-H sigma flow incorrectly ends at the carbonyl O. No model call.
// MOLSTUDIO_PORT=49136 MOLSTUDIO_AGENT_TEST_OUT=/absolute/path \
// MOLSTUDIO_TEST_BUILD=/absolute/path/MolStudio.app \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_proton_transfer_real.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-proton-flow-real');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/proton-transfer-wrong-target.molwork'), 'utf8');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-proton-flow-')));
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'unspecified served build',
  service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49136),
  scope: 'Actual saved model-authored wrong proton-transfer flow, native runtime synthetic tool calls, atomic rollback and correction; no real model calls.',
  checks: [], artifacts: [] };
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let win;
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'fixture watchdog'; write(); win?.destroy(); app.exit(2); }, 120_000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) }); write(); if (!pass) throw new Error(name); };
  try {
    await win.loadURL(report.service + '/canvas.html');
    const started = Date.now();
    while (!await js('!!k3dAPI?.workbenchReady?.() && !!molstudioAgent?.getRuntime?.()')) {
      if (Date.now() - started > 40_000) throw new Error('Canvas/runtime did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('saved historical model diagram loads', (await js('k3dAPI.loadWorkbench(' + JSON.stringify(source) + ')'))?.ok);
    await js(String.raw`(async()=>{
      const rt=molstudioAgent.getRuntime(), api=k3dAPI.agent, encoder=new TextEncoder(), original=rt._fetch;
      rt.reset();MolWorkbench.app.adapter.ed.clearHistory();
      const st=window.__protonFlow={requests:0,events:[],afterBad:null,realModelRequests:0};
      addEventListener('molstudio:agent-event', event=>{const e=event.detail;if(['tool_end','error','run_end'].includes(e.type))
        st.events.push({type:e.type,toolName:e.toolName,isError:e.isError,status:e.status,code:e.code,diagnostic:e.diagnostic,message:e.message});});
      const frame=(delta,finish_reason=null)=>encoder.encode('data: '+JSON.stringify({id:'synthetic-proton',created:0,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
      const response=input=>new Response(new ReadableStream({start(controller){controller.enqueue(frame({role:'assistant',tool_calls:[{index:0,id:'call-'+st.requests,type:'function',function:{name:'draw_operations',arguments:JSON.stringify(input)}}]}));controller.enqueue(frame({},'tool_calls'));controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close()}}),{headers:{'Content-Type':'text/event-stream'}});
      rt._fetch=async function(url,init){if(url!=='/api/agent/model')return original.call(this,url,init);st.requests++;
        if(st.requests===1)return response({operations:[{id:'wrong-retry',type:'arrow.modify',arrowId:'ar-900484e4-e336-4471-a457-60660357a0f4',target:{type:'atom',atomId:'at-e346605e-d6c4-48c1-9ecf-1ef219debd1c'}}],taskScope:{type:'partialStep'},finish:false});
        if(st.requests===2){st.afterBad={context:await api.getContext(),source:await k3dAPI.serializeWorkbench(),undo:MolWorkbench.app.adapter.ed.historySize().undo};
          return response({operations:[{id:'correct-return',type:'arrow.modify',arrowId:'ar-900484e4-e336-4471-a457-60660357a0f4',target:{type:'atom',atomId:'at-236d9af5-9bde-496f-b34c-dd28c6347887'}}],taskScope:{type:'partialStep'},finish:true});}
        throw new Error('Unexpected synthetic request');};
    })()`);
    const before = await js('(async()=>({context:await k3dAPI.agent.getContext(),undo:MolWorkbench.app.adapter.ed.historySize().undo}))()');
    report.result = await js("molstudioAgent.send('修正现有首步质子转移中供体 O-H 键电子流的终点，仅修改这根弯箭头。')");
    const state = await js('__protonFlow');
    const final = await js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench(),undo:MolWorkbench.app.adapter.ed.historySize().undo}))()');
    report.synthetic = { requests: state.requests, events: state.events, realModelRequests: state.realModelRequests };
    const target = (context, id) => context.arrows.find(flow => flow.id === id)?.target?.atomId;
    const arrow = 'ar-900484e4-e336-4471-a457-60660357a0f4';
    const failed = state.events.find(event => event.type === 'tool_end' && event.isError && event.toolName === 'draw_operations');
    check('incorrect donor-bond target returns a specific structured diagnostic', failed?.diagnostic?.code === 'proton_transfer_sigma_wrong_target', failed);
    check('the rejected batch leaves chemistry, flow endpoint and native history unchanged',
      !!state.afterBad && target(state.afterBad.context, arrow) === target(before.context, arrow) && state.afterBad.undo === before.undo &&
      state.afterBad.context.atoms.length === before.context.atoms.length && state.afterBad.context.arrows.length === before.context.arrows.length);
    check('the following synthetic request corrects the same arrow to the original donor oxygen',
      state.requests === 2 && report.result.status === 'completed' && target(final.context, arrow) === 'at-236d9af5-9bde-496f-b34c-dd28c6347887' &&
      final.undo === before.undo + 1, { requests: state.requests, result: report.result, undo: final.undo });
    fs.writeFileSync(path.join(out, 'repaired.molwork'), final.source); report.artifacts.push('repaired.molwork');
    const png = await js("k3dAPI.exportMechanismImage('png')");
    if (png?.ok) { fs.writeFileSync(path.join(out, 'repaired.png'), Buffer.from(png.dataUrl.split(',')[1], 'base64')); report.artifacts.push('repaired.png'); }
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error?.stack || error); }
  finally { clearTimeout(watchdog); write(); console.log(JSON.stringify({ok:report.ok,passed:report.checks.filter(c=>c.pass).length,
    total:report.checks.length,failure:report.failure,out},null,2));win.destroy();app.exit(report.ok?0:1); }
});
