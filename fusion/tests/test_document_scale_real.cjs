'use strict';
// Real Electron acceptance for paper-page selection scaling (molecules and full
// mechanisms at true paper size). Isolated local canvas service; no model calls.
//   MOLSTUDIO_PORT=49155 npm --prefix fusion start   (server must be running)
//   env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron --no-sandbox --disable-gpu \
//     fusion/tests/test_document_scale_real.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49155;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-scale-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-scale-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);

const report = {
  application: 'MolStudio current canvas',
  page: 'fusion/canvas.html',
  pageURL: `http://127.0.0.1:${port}/canvas.html`,
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  modelCalls: 0,
  checks: [],
  browserErrors: [],
  artifacts: {},
  startedAt: new Date().toISOString(),
};
let win;
const mouseDrag = async (x1, y1, x2, y2, steps = 3) => {
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
  await wait(50);
  for (let i = 1; i <= steps; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x1 + (x2 - x1) * i / steps), y: Math.round(y1 + (y2 - y1) * i / steps) });
    await wait(40);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
  await wait(60);
};
const mouseClick = async (x, y) => {
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(40);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await wait(80);
};
const watchdog = setTimeout(() => {
  report.ok = false; report.error = 'Electron document scale watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 240_000);
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_event, details) => report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`));
  const js = code => win.webContents.executeJavaScript(code);
  const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  const shot = async name => {
    const image = await win.webContents.capturePage();
    const file = path.join(out, name);
    fs.writeFileSync(file, image.toPNG());
    report.artifacts[name.replace(/\.png$/, '')] = file;
    return file;
  };
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('Current canvas did not become ready');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-mechanism/F01.molwork'), 'utf8');
    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('F01 fixture failed to load: ' + JSON.stringify(loaded));

    const result = await js(`(async()=>{
      const checks=window.__scaleChecks=window.__scaleChecks=[]; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name);};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const st=adapter.struct();
      if(controller.state.mode!=='paper')MolStudio.document.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      const coords=()=>{const out={};for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)out[uuid]=[pp.x,pp.y];}return out;};
      const before=coords();
      const xs=Object.values(before).map(p=>p[0]),ys=Object.values(before).map(p=>p[1]);
      const center={x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2};
      // F01 的 C-Br 键（C 端无标签字形）：用于观察键线宽视觉缩放
      const carbonBond=[...st.bonds.entries()][0];
      const bondWidth=()=>{const vis=adapter.ed.render.ctab.bonds.get(carbonBond[0]);
        return (vis?.visel?.paths||[]).map(p=>p.node?.getAttribute?.('stroke-width')).filter(Boolean);};
      const widthBefore=bondWidth();
      check('fixture provides a bond for stroke-width observation', !!carbonBond&&widthBefore.length>0,{bondId:carbonBond?.[0],widthBefore});

      // 全选化学内容并缩放到 75%
      adapter.ed.selection({atoms:[...st.atoms.keys()],bonds:[...st.bonds.keys()]});
      controller.render();
      // 选框与控制点只在 scaleMode 下出现（悬浮工具条缩放交互）
      const scaleEnabled=controller.setScaleMode(true);
      const handles=adapter.ed.render.clientArea?.ownerSVGElement?.querySelectorAll('[data-scale-handle]').length
        ?? adapter.canvasSvg().querySelectorAll('[data-scale-handle]').length;
      const boundsBefore=controller.selectionChemistryBounds();
      check('scaleMode exposes the chemical selection frame with four corner handles',
        scaleEnabled===true&&!!boundsBefore&&boundsBefore.w>0&&handles===4,{boundsBefore,handles});
      const scaled=controller.scaleSelection(0.75);
      await wait(250);
      const after=coords();
      const ratios=Object.keys(before).map(uuid=>{
        const r0=[(before[uuid][0]-center.x),(before[uuid][1]-center.y)];
        const r1=[(after[uuid][0]-center.x),(after[uuid][1]-center.y)];
        return [uuid, Math.abs(r0[0])>1e-9?r1[0]/r0[0]:1, Math.abs(r0[1])>1e-9?r1[1]/r0[1]:1, Math.abs(r0[1])];
      });
      check('atom coordinates bake a 0.75 scale about the selection centre',
        scaled===true&&ratios.every(([,rx,ry,dy0])=>Math.abs(rx-0.75)<1e-6&&(dy0<1e-9||Math.abs(ry-0.75)<1e-6)),
        {sample:ratios.slice(0,4)});
      const factorOf=uuid=>adapter.effectiveAtomScale(uuid);
      const factors=[...adapter.atomUuid.values()].map(factorOf);
      check('adapter visual scale factors are 0.75 for every atom', factors.every(f=>Math.abs(f-0.75)<1e-9),{factors:[...new Set(factors)]});
      const widthAfter=bondWidth();
      check('bond stroke-width follows the atom factor after scaling',
        widthBefore.length>0&&widthAfter.length>0&&widthAfter.some(w=>Math.abs(Number(w)-2*0.75)<1e-6),
        {widthBefore,widthAfter});
      const savedText=await k3dAPI.serializeWorkbench();
      const saved=JSON.parse(savedText);
      const savedScales=saved.document?.atomScales||{};
      check('serialized workbench carries atomScales', Object.keys(savedScales).length>0,
        {count:Object.keys(savedScales).length,sample:Object.entries(savedScales).slice(0,3)});
      const locations=[];
      for(const key of Object.keys(saved.ket)){if(saved.ket[key]?.type!=='molecule')continue;for(const at of saved.ket[key].atoms||[])locations.push(at.location);}
      const savedMatched=Object.values(after).filter(p=>locations.some(loc=>Math.abs(loc[0]-p[0])<1e-6&&Math.abs(loc[1]+p[1])<1e-6)).length;
      check('KET export stores the scaled pp coordinates (y flipped)', savedMatched===Object.keys(after).length&&locations.length===Object.keys(after).length,
        {matched:savedMatched,total:Object.keys(after).length});
      return {checks,before,after,savedText,widthBefore,widthAfter,center,carbonBondId:carbonBond[0]};
    })()`);
    for (const c of result.checks) report.checks.push(c);
    fs.writeFileSync(path.join(out, 'scaled.molwork'), result.savedText);
    report.artifacts.scaledMolwork = path.join(out, 'scaled.molwork');
    await shot('after-scale.png');

    // 一次撤销恢复原始坐标
    const undone = await js(`(async()=>{
      const checks=window.__scaleChecks=window.__scaleChecks=[]; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name);};
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const st=adapter.struct();
      const before=${JSON.stringify(result.before)};
      const historyBefore=adapter.ed.historySize();
      adapter.ed.undo();
      await new Promise(r=>setTimeout(r,300));
      const coords={};for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)coords[uuid]=[pp.x,pp.y];}
      const restored=Object.keys(before).every(uuid=>coords[uuid]&&Math.abs(coords[uuid][0]-before[uuid][0])<1e-6&&Math.abs(coords[uuid][1]-before[uuid][1])<1e-6);
      const factors=[...adapter.atomUuid.values()].map(uuid=>adapter.effectiveAtomScale(uuid));
      check('one undo restores original coordinates and clears visual factors',
        restored&&adapter.ed.historySize().undo===historyBefore.undo-1&&factors.every(f=>Math.abs(f-1)<1e-9),
        {restored,history:[historyBefore,adapter.ed.historySize()],factors:[...new Set(factors)]});
      return {checks};
    })()`);
    for (const c of undone.checks) report.checks.push(c);

    // 重开：坐标保持、atomScales 恢复、视觉重放
    const reopened = await js(`(async()=>{
      const checks=window.__scaleChecks=window.__scaleChecks=[]; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name);};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const savedText=${JSON.stringify(result.savedText)};
      const loaded=await k3dAPI.loadWorkbench(savedText);
      if(!loaded.ok)throw new Error('reload failed');
      await wait(500);
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const st=adapter.struct();
      const after=${JSON.stringify(result.after)};
      const coords={};for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)coords[uuid]=[pp.x,pp.y];}
      const preserved=Object.keys(after).every(uuid=>coords[uuid]&&Math.abs(coords[uuid][0]-after[uuid][0])<1e-6&&Math.abs(coords[uuid][1]-after[uuid][1])<1e-6);
      const factors=[...adapter.atomUuid.values()].map(uuid=>adapter.effectiveAtomScale(uuid));
      check('reopening keeps scaled coordinates and restores atomScales factors',
        preserved&&factors.every(f=>Math.abs(f-0.75)<1e-9),{preserved,factors:[...new Set(factors)]});
      const carbonBond=(${JSON.stringify(result.carbonBondId)});
      const vis=carbonBond!==null?adapter.ed.render.ctab.bonds.get(carbonBond):null;
      const widths=(vis?.visel?.paths||[]).map(p=>p.node?.getAttribute?.('stroke-width')).filter(Boolean);
      check('visual replay restores the scaled bond stroke-width after reload',
        widths.some(w=>Math.abs(Number(w)-1.5)<1e-6),{widths});
      return {checks};
    })()`);
    for (const c of reopened.checks) report.checks.push(c);
    await shot('after-reload.png');

    // 工具条注入缩放按钮 + 内联百分比输入 + 真实拖拽缩放
    const frameGeom = await js(`(()=>{
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      controller.select([]); controller.setScaleMode(false);
      if(controller.state.mode!=='paper')MolStudio.document.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      const st=adapter.struct();
      const frame=document.getElementById('k').getBoundingClientRect();
      const ctm=adapter.canvasSvg().getScreenCTM();
      const pts=[...st.atoms.values()].map(a=>adapter.modelToUser(a.pp)).map(p=>({x:ctm.a*p.x+ctm.c*p.y+ctm.e,y:ctm.b*p.x+ctm.d*p.y+ctm.f}));
      const x1=Math.min(...pts.map(p=>p.x)),x2=Math.max(...pts.map(p=>p.x)),y1=Math.min(...pts.map(p=>p.y)),y2=Math.max(...pts.map(p=>p.y));
      return {x1:Math.round(frame.left+x1-40),y1:Math.round(frame.top+y1-40),x2:Math.round(frame.left+x2+40),y2:Math.round(frame.top+y2+40),mode:controller.state.mode};
    })()`);
    check('fixture stays in paper mode for the floating toolbar case', frameGeom.mode === 'paper', { mode: frameGeom.mode });
    await mouseDrag(frameGeom.x1, frameGeom.y1, frameGeom.x2, frameGeom.y2);
    const injected = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const fdoc=document.getElementById('k').contentDocument;
      const start=Date.now();let bar=null,btn=null,trash=null,wrap=null;
      while(Date.now()-start<8000){bar=fdoc.querySelector('[data-testid="floating-tools"]');btn=fdoc.querySelector('[data-doc-scale-control="button"]');
        trash=fdoc.querySelector('[data-testid="float-delete"]');wrap=fdoc.querySelector('[data-doc-scale-control="wrap"]');
        if(bar&&btn&&trash&&wrap)break;await wait(100);}
      return {barFound:!!bar,barClass:String(bar?.className||''),btnFound:!!btn,trashFound:!!trash,wrapFound:!!wrap,
        orderOk:!!trash&&trash.nextElementSibling===btn&&!!btn&&btn.nextElementSibling===wrap,
        iconInlineSvg:!!btn&&!!btn.querySelector(':scope > svg'),
        ariaOk:btn?.getAttribute('aria-label')==='缩放选区'&&wrap?.querySelector('input')?.getAttribute('aria-label')==='选区缩放百分比',
        inputHiddenBeforeActivate:wrap?wrap.hidden===true:null,
        titleOk:btn?.getAttribute('title')==='点击后拖动控制点缩放；再点或 Esc 退出'};
    })()`);
    check('the Ketcher floating toolbar gains a scale button (inline SVG) and a percent input right after the trash button',
      injected.barFound&&injected.btnFound&&injected.trashFound&&injected.wrapFound&&injected.orderOk&&injected.iconInlineSvg&&injected.ariaOk&&injected.inputHiddenBeforeActivate&&injected.titleOk,
      injected);
    report.artifacts.toolbarProbe = injected;

    const btnPos = await js(`(()=>{
      const fdoc=document.getElementById('k').contentDocument;
      const btn=fdoc.querySelector('[data-doc-scale-control="button"]');
      const r=btn.getBoundingClientRect(), frame=document.getElementById('k').getBoundingClientRect();
      return {x:Math.round(frame.left+r.left+r.width/2),y:Math.round(frame.top+r.top+r.height/2)};
    })()`);
    await mouseClick(btnPos.x, btnPos.y);
    const activated = await js(`(()=>{
      const app=MolWorkbench.app, controller=app.documentController;
      const fdoc=document.getElementById('k').contentDocument;
      const btn=fdoc.querySelector('[data-doc-scale-control="button"]'), wrap=fdoc.querySelector('[data-doc-scale-control="wrap"]');
      const handles=adapter_handleCount();
      function adapter_handleCount(){return app.adapter.canvasSvg().querySelectorAll('[data-scale-handle]').length;}
      return {scaleMode:controller.scaleMode===true,pressed:btn?.getAttribute('aria-pressed')==='true',
        inputShown:wrap?wrap.hidden===false:null,handles};
    })()`);
    check('clicking the injected scale button activates scaleMode, shows the percent input and renders corner handles',
      activated.scaleMode&&activated.pressed&&activated.inputShown&&activated.handles===4, activated);

    // 拖拽 se 控制点放大（一次撤销；结束仍在缩放模式）
    const handleDrag = await js(`(()=>{
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const fdoc=document.getElementById('k').contentDocument;
      const h=fdoc.querySelector('[data-scale-handle="se"]');
      const r=h.getBoundingClientRect(), frame=document.getElementById('k').getBoundingClientRect();
      const before={};const st=adapter.struct();
      for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)before[uuid]=[pp.x,pp.y];}
      return {x:Math.round(frame.left+r.left+r.width/2),y:Math.round(frame.top+r.top+r.height/2),before,
        history:adapter.ed.historySize().undo};
    })()`);
    await mouseDrag(handleDrag.x, handleDrag.y, handleDrag.x + 60, handleDrag.y + 45);
    const afterHandleDrag = await js(`((snap)=>{
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const st=adapter.struct();
      const uuids=Object.keys(snap.before);
      const center=controller.selectionChemistryBounds();
      const cx=center.x+center.w/2, cy=center.y+center.h/2;
      let ok=true;const ratios=[];
      for(const uuid of uuids){
        const rid=[...adapter.atomUuid.entries()].find(([id,u])=>u===uuid)?.[0];
        const pp=rid!==undefined?st.atoms.get(rid)?.pp:null;
        if(!pp){ok=false;continue;}
        const r0x=snap.before[uuid][0]-cx,r0y=snap.before[uuid][1]-cy;
        const rx=Math.abs(r0x)>1e-9?(pp.x-cx)/r0x:null, ry=Math.abs(r0y)>1e-9?(pp.y-cy)/r0y:null;
        ratios.push([uuid,rx,ry]);
        if(rx!==null&&Math.abs(rx-1)<0.02)ok=false;
      }
      const historyGrew=adapter.ed.historySize().undo===snap.history+1;
      return {scaled:ok&&ratios.length>0,ratios:ratios.slice(0,4),historyGrew,scaleModeStillOn:controller.scaleMode===true};
    })(${JSON.stringify(handleDrag)})`);
    check('dragging the corner handle scales the selection about the anchor with one undo entry and stays in scale mode',
      afterHandleDrag.scaled&&afterHandleDrag.historyGrew&&afterHandleDrag.scaleModeStillOn, afterHandleDrag);
    report.artifacts.handleDrag = afterHandleDrag;

    // Esc 退出缩放模式
    await js(`document.getElementById('k').contentDocument.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(120);
    const exited = await js(`(()=>{
      const app=MolWorkbench.app;
      return {scaleMode:app.documentController.scaleMode===false,
        handles:app.adapter.canvasSvg().querySelectorAll('[data-scale-handle]').length===0};
    })()`);
    check('Esc leaves scale mode and removes the corner handles', exited.scaleMode&&exited.handles, exited);

    // 内联百分比输入：150% 应用（会话基准），一次撤销恢复
    await mouseClick(btnPos.x, btnPos.y);
    const percentResult = await js(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const app=MolWorkbench.app, adapter=app.adapter, controller=app.documentController;
      const fdoc=document.getElementById('k').contentDocument;
      const wrap=fdoc.querySelector('[data-doc-scale-control="wrap"]');
      const input=wrap?.querySelector('input');
      if(!wrap||wrap.hidden!==false||!input)return {ok:false,reason:'input not visible'};
      const st=adapter.struct();
      const before={};for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)before[uuid]=[pp.x,pp.y];}
      const history=adapter.ed.historySize().undo;
      input.focus(); input.value='150';
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      await wait(200);
      const center=controller.selectionChemistryBounds();
      const cx=center.x+center.w/2, cy=center.y+center.h/2;
      let ok=true;
      for(const [id,uuid] of adapter.atomUuid){const pp=st.atoms.get(id)?.pp;if(!pp||!before[uuid])continue;
        const r0x=before[uuid][0]-cx,r0y=before[uuid][1]-cy;
        if(Math.abs(r0x)>1e-9&&Math.abs((pp.x-cx)/r0x-1.5)>1e-6)ok=false;
        if(Math.abs(r0y)>1e-9&&Math.abs((pp.y-cy)/r0y-1.5)>1e-6)ok=false;}
      const savedText=await k3dAPI.serializeWorkbench();
      const saved=JSON.parse(savedText);
      const scalesCount=Object.keys(saved.document?.atomScales||{}).length;
      return {ok,historyDelta:adapter.ed.historySize().undo-history,scalesCount:scalesCount>0,percent:controller.currentSessionPercent()};
    })()`);
    check('the inline percent input applies 150% about the anchor with one undo and persists atomScales',
      percentResult.ok===true&&percentResult.historyDelta===1&&percentResult.scalesCount&&percentResult.percent===150, percentResult);
    await shot('after-toolbar-scale.png');

    report.ok = report.checks.every(c => c.pass);
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length,
      failed: report.checks.filter(c => !c.pass).length, error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
  } catch (error) {
    try { for (const c of await js('window.__scaleChecks||[]')) report.checks.push(c); } catch (_) {}
    report.ok = false; report.error = String(error && error.message || error);
    try { await shot('failure.png'); } catch (_) {}
  } finally {
    clearTimeout(watchdog);
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter(c => c.pass).length;
    report.failed = report.checks.filter(c => !c.pass).length;
    writeReport();
    win?.destroy();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    setTimeout(() => app.exit(report.ok ? 0 : 1), 150);
  }
}
app.whenReady().then(main).catch(error => { report.ok = false; report.error = String(error); writeReport(); app.exit(2); });
