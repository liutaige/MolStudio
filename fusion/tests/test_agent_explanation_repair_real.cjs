'use strict';
// Real configured model; read an actual saved main-canvas mechanism and ask
// for a corrected explanation without editing any canvas object.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (process.env.MOLSTUDIO_REAL_AGENT !== '1' || !process.env.MOLSTUDIO_AGENT_TEST_OUT || !process.env.MOLSTUDIO_EXPLANATION_SEED) {
  console.error('Explicit MOLSTUDIO_REAL_AGENT=1, MOLSTUDIO_AGENT_TEST_OUT and MOLSTUDIO_EXPLANATION_SEED required.'); process.exit(2);
}
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT), seedPath = path.resolve(process.env.MOLSTUDIO_EXPLANATION_SEED);
const source = fs.readFileSync(seedPath, 'utf8'), port = Number(process.env.MOLSTUDIO_PORT) || 49137;
const limit = Math.min(8, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 6));
const prompt = '请先读取当前画布，重新简短解释乙醛与甲醇形成半缩醛的每一步电子流和酸催化剂如何再生。请特别核对：羰基 π 键在第一步和第二步各自是否发生变化、每根箭头的真实起点与终点。只在聊天回答，不要修改画布。';
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-explain-repair-')));
const report = { application:'MolStudio canvas',page:'fusion/canvas.html',build:process.env.MOLSTUDIO_TEST_BUILD || 'unspecified served build',
  service:'http://127.0.0.1:'+port,seedFile:seedPath,prompt,requestLimit:limit,checks:[],artifacts:[],startedAt:new Date().toISOString(),
  privacy:'Only visible assistant text, tool names, safe generation fields and counts are recorded; no raw model stream, hidden reasoning or credentials.' };
const write = () => fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
let win;
const watchdog = setTimeout(()=>{report.ok=false;report.status='timeout';write();win?.webContents.executeJavaScript("molstudioAgent?.stop?.('test_timeout')").catch(()=>{});setTimeout(()=>{win?.destroy();app.exit(2)},10000)},600000);
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1540,height:1040,webPreferences:{offscreen:true,backgroundThrottling:false}});
  const js=code=>win.webContents.executeJavaScript(code);
  const check=(name,pass,detail)=>{report.checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});write()};
  let timer;
  try{
    await win.loadURL(report.service+'/canvas.html');const start=Date.now();
    while(!await js('!!k3dAPI?.workbenchReady?.() && !!molstudioAgent?.getRuntime?.()')){if(Date.now()-start>40000)throw new Error('Canvas/runtime unavailable');await new Promise(resolve=>setTimeout(resolve,100))}
    const loaded=await js('k3dAPI.loadWorkbench('+JSON.stringify(source)+')');check('existing completed model diagram loads',loaded?.ok===true);
    await js('molstudioAgent.open()');
    const before=await js('k3dAPI.agent.getContext()');
    await js(`(()=>{const rt=molstudioAgent.getRuntime(),fetch=rt._fetch,s=window.__explainRepair={requests:[],events:[],text:''};
      rt._fetch=async function(url,init){if(url!=='/api/agent/model')return fetch.call(this,url,init);if(s.requests.length>=${limit})throw new Error('test_request_limit');
        const item={number:s.requests.length+1};s.requests.push(item);const r=await fetch.call(this,url,init);item.status=r.status;
        const h=r.headers.get('X-MolStudio-Generation');if(h)try{const v=JSON.parse(h);item.generation={profile:v.requested?.profile,effort:v.requested?.effort,maxOutputTokens:v.requested?.maxOutputTokens,thinking:v.fields?.thinking?.type,reasoning_effort:v.fields?.reasoning_effort,max_tokens:v.fields?.max_tokens,forwardedToConfiguredEndpoint:v.forwardedToConfiguredEndpoint,downstreamConfirmed:v.downstreamConfirmed}}catch{}return r};
      addEventListener('molstudio:agent-event',e=>{const x=e.detail;if(x.type==='text_delta'&&s.text.length<16000)s.text+=String(x.text||x.delta||'').slice(0,16000-s.text.length);
        if(['tool_start','tool_end','error','run_end'].includes(x.type))s.events.push({type:x.type,toolName:x.toolName,isError:x.isError,code:x.code,status:x.status})});})()`);
    timer=setInterval(async()=>{try{report.progress=await js('__explainRepair');write()}catch{}},5000);
    report.status='running';write();report.result=await js('molstudioAgent.send('+JSON.stringify(prompt)+')');
    clearInterval(timer);report.probe=await js('__explainRepair');
    const after=await js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench()}))()');
    const stable=c=>JSON.stringify(Object.fromEntries(['atoms','bonds','molecules','lonePairs','arrows','reactionSteps'].map(k=>[k,c[k]])));
    check('model explicitly reads the saved canvas',report.probe.events.some(e=>e.type==='tool_start'&&e.toolName==='read_canvas'));
    check('explanation finishes without drawing operations or canvas changes',report.result?.status==='completed'&&
      !report.probe.events.some(e=>e.type==='tool_start'&&e.toolName==='draw_operations')&&stable(before)===stable(after.context),report.result);
    check('each actual model request forwarded the isolated DeepSeek high profile',report.probe.requests.length>0&&report.probe.requests.every(r=>
      r.generation?.profile==='deepseek'&&r.generation.effort==='high'&&r.generation.thinking==='enabled'&&r.generation.reasoning_effort==='high'&&
      r.generation.max_tokens===16384&&r.generation.forwardedToConfiguredEndpoint===true&&r.generation.downstreamConfirmed===false));
    check('visible response discusses all three steps and acid regeneration',/质子化/.test(report.probe.text)&&/进攻|亲核/.test(report.probe.text)&&
      /去质子|脱质子/.test(report.probe.text)&&/水合氢离子|催化剂/.test(report.probe.text)&&/再生|恢复|重新生成/.test(report.probe.text));
    fs.writeFileSync(path.join(out,'reopened.molwork'),after.source);report.artifacts.push('reopened.molwork');
    fs.writeFileSync(path.join(out,'context.json'),JSON.stringify(after.context,null,2));report.artifacts.push('context.json');
    const png=await js("k3dAPI.exportMechanismImage('png')");if(png?.ok){fs.writeFileSync(path.join(out,'canvas.png'),Buffer.from(png.dataUrl.split(',')[1],'base64'));report.artifacts.push('canvas.png')}
    fs.writeFileSync(path.join(out,'window.png'),(await win.capturePage()).toPNG());report.artifacts.push('window.png');
    report.ok=report.checks.every(c=>c.pass);report.status=report.ok?'pending_manual_review':'failed';
    report.manualReviewRequired='Verify exact electron-flow language and all charges against the saved mechanism; automated topic checks are insufficient.';
  }catch(e){report.ok=false;report.status='failed';report.failure=String(e?.stack||e)}finally{clearInterval(timer);clearTimeout(watchdog);write();
    console.log(JSON.stringify({ok:report.ok,status:report.status,checks:report.checks.length,failed:report.checks.filter(c=>!c.pass),out},null,2));win.destroy();app.exit(report.ok?0:1)}
});
