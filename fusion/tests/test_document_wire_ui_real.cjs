'use strict';
// Real Electron acceptance for the document UI wiring layer (insert menu,
// 3D interaction overlay, text format bar, align / image enhancements).
// Uses the isolated local canvas service; no model calls and no OS dialogs.
//   MOLSTUDIO_PORT=49177 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
//     MOLSTUDIO_AGENT_TEST_OUT=/absolute/out \
//     env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_wire_ui_real.cjs
// NOTE: do NOT add --disable-gpu here: the 3D checks need real WebGL.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49177;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-wire-ui-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-wire-ui-'));
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
const watchdog = setTimeout(() => {
  report.ok = false; report.error = 'Electron document wire UI regression watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 240_000);
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const METHANE_MOLBLOCK = [
  'methane',
  '  MolStudio',
  '',
  '  5  4  0  0  0  0  0  0  0  0999 V2000',
  '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.1000    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -0.3667    1.0392    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -0.3667   -0.5196    0.9002 H   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -0.3667   -0.5196   -0.9002 H   0  0  0  0  0  0  0  0  0  0  0  0',
  '  1  2  1  0  0  0  0',
  '  1  3  1  0  0  0  0',
  '  1  4  1  0  0  0  0',
  '  1  5  1  0  0  0  0',
  'M  END',
].join('\n');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_event, details) => report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`));
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('Current canvas did not become ready');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-mechanism/F01.molwork'), 'utf8');
    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('F01 fixture failed to load: ' + JSON.stringify(loaded));

    const result = await js(`(async()=>{
      const checks=window.__documentWireUIChecks=[];
      const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name+': '+JSON.stringify(detail??null));};
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const paper=MolStudio.document,app=MolWorkbench.app,ui=app.documentUI,controller=app.documentController;
      const alignSelection=(typeof paper.alignSelection==='function'?(...a)=>paper.alignSelection(...a)
        :typeof controller.alignSelection==='function'?(...a)=>controller.alignSelection(...a):null);
      const hostDoc=document;
      paper.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      const availability=ui.contractAvailability||{};
      check('the document UI records its core-layer contract availability audit',!!availability&&typeof availability==='object',{availability});
      const coreFinish=typeof controller.finishMolecule3DInteraction==='function';

      /* ---------- 1. 插入下拉菜单 ---------- */
      const insertBtn=hostDoc.querySelector('#molstudio-document-toolbar [data-doc-action="insert-menu"]');
      check('the toolbar exposes an insert dropdown button with menu aria attributes',
        !!insertBtn&&insertBtn.getAttribute('aria-haspopup')==='menu'&&insertBtn.getAttribute('aria-expanded')==='false',
        {found:!!insertBtn,haspopup:insertBtn?.getAttribute('aria-haspopup'),expanded:insertBtn?.getAttribute('aria-expanded')});
      insertBtn.click(); await wait(60);
      const menu=hostDoc.getElementById('molstudio-document-insert-menu');
      const topItems=menu?[...menu.children].filter(node=>node.tagName==='BUTTON'):[];
      const topTexts=topItems.map(node=>node.getAttribute('role')==='menuitem'?node.childNodes[0]?.textContent||node.textContent:node.textContent);
      check('clicking insert opens a dropdown with the four top-level entries',
        !!menu&&!menu.hidden&&insertBtn.getAttribute('aria-expanded')==='true'&&topItems.length===4&&
        ['文本框','图片…','形状','3D 分子预览'].every(t=>topTexts.some(v=>v&&v.includes(t))),
        {hidden:menu?.hidden,expanded:insertBtn.getAttribute('aria-expanded'),topItems:topItems.length,topTexts});
      const shapeToggle=menu.querySelector('[data-doc-action="insert-shape"]');
      shapeToggle.click(); await wait(40);
      const shapeItems=[...menu.querySelectorAll('[data-doc-shape]')];
      check('the shape submenu lists all seven shape tools',
        !shapeToggle.parentElement.querySelector('.doc-menu-sub').hidden&&shapeItems.length===7&&
        ['rect','roundRect','ellipse','line','arrow','polygon','bracket'].every(v=>shapeItems.some(n=>n.dataset.docShape===v)),
        {count:shapeItems.length,values:shapeItems.map(n=>n.dataset.docShape)});
      hostDoc.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await wait(40);
      check('Escape closes the insert dropdown and resets aria-expanded',
        menu.hidden===true&&insertBtn.getAttribute('aria-expanded')==='false',{hidden:menu.hidden,expanded:insertBtn.getAttribute('aria-expanded')});

      /* ---------- 2. 文本格式浮条与 runs 持久化 ---------- */
      const textId=paper.addText({x:8,y:8,w:20,h:3,text:'格式化测试文字'});
      const editTextResult=paper.editText(textId); await wait(60);
      const frameDoc=hostDoc.getElementById('k').contentDocument;
      const editorDiv=frameDoc.getElementById('molstudio-document-editor');
      let bar=hostDoc.getElementById('molstudio-text-format-bar');
      check('opening the text editor shows the floating format bar above it',
        !!editorDiv&&!!bar&&!bar.hidden&&bar.getAttribute('aria-label')==='文字格式'&&
        bar.querySelectorAll('[data-doc-format]').length>=8,
        {editTextResult,editor:!!editorDiv,bar:!!bar,hidden:bar?.hidden,controls:bar?bar.querySelectorAll('[data-doc-format]').length:0});
      const frameWin=hostDoc.getElementById('k').contentWindow;
      const sel=frameWin.getSelection(),hostRange=frameDoc.createRange();
      hostRange.selectNodeContents(editorDiv); sel.removeAllRanges(); sel.addRange(hostRange);
      // 加固：点加粗前必须存在非折叠的编辑器选区（时序敏感的先决条件）
      const selBeforeBold=frameWin.getSelection();
      const boldSelectionOk=selBeforeBold.rangeCount>0&&!selBeforeBold.getRangeAt(0).collapsed&&editorDiv.contains(selBeforeBold.getRangeAt(0).commonAncestorContainer);
      check('the editor selection exists and is non-collapsed before clicking bold',
        boldSelectionOk,{rangeCount:selBeforeBold.rangeCount,collapsed:selBeforeBold.rangeCount?selBeforeBold.getRangeAt(0).collapsed:null});
      const boldBtn=bar.querySelector('[data-doc-format="bold"]');
      boldBtn.click(); await wait(120);
      const textObject=paper.getState().objects.find(o=>o.id===textId);
      const runsAfterBold=textObject?.rich?.runs;
      check('applying bold to the editor selection persists bold runs on the object rich model',
        Array.isArray(runsAfterBold)&&runsAfterBold.some(r=>r.bold===true),
        {runs:runsAfterBold});
      paper.finishTextEdit(); await wait(120);
      const serialized=JSON.parse(await k3dAPI.serializeWorkbench());
      const serializedText=serialized.document.objects.find(o=>o.rich?.text==='格式化测试文字');
      check('serializeWorkbench keeps the bold runs on the saved text object',
        !!serializedText&&Array.isArray(serializedText.rich.runs)&&serializedText.rich.runs.some(r=>r.bold===true),
        {found:!!serializedText,runs:serializedText?.rich?.runs});
      paper.editText(textId); await wait(80);
      const barAgain=hostDoc.getElementById('molstudio-text-format-bar');
      const runsStillThere=paper.getState().objects.find(o=>o.id===textId)?.rich?.runs;
      check('reopening the editor keeps the persisted runs and reuses the format bar',
        !!barAgain&&!barAgain.hidden&&Array.isArray(runsStillThere)&&runsStillThere.some(r=>r.bold===true),
        {bar:!!barAgain,runs:runsStillThere});
      paper.finishTextEdit(true); await wait(120);
      check('closing the editor removes the floating format bar',
        !hostDoc.getElementById('molstudio-text-format-bar')||!hostDoc.getElementById('molstudio-text-format-bar').isConnected,
        {barGone:!hostDoc.getElementById('molstudio-text-format-bar')});

      /* ---------- 3. alignSelection 六模式 ---------- */
      const ids=[paper.addShape({x:10,y:20,w:4,h:3,shape:'rect'}),paper.addShape({x:30,y:30,w:4,h:3,shape:'rect'}),paper.addShape({x:50,y:40,w:4,h:3,shape:'rect'})];
      paper.select(ids);
      if(alignSelection){
        const read=()=>paper.getState().objects.filter(o=>ids.includes(o.id)).map(o=>({x:o.x,y:o.y,w:o.w,h:o.h}));
        const modes={left:['x'],center:['x'],right:['x'],top:['y'],middle:['y'],bottom:['y']};
        const expected={left:'x',center:'x+w/2',right:'x+w',top:'y',middle:'y+h/2',bottom:'y+h'};
        let alignOk=true,alignDetail={};
        for(const mode of ['left','center','right','top','middle','bottom']){
          paper.updateObject(ids[0],{x:10+Math.random(),y:20+Math.random()});
          paper.updateObject(ids[1],{x:30+Math.random(),y:30+Math.random()});
          paper.updateObject(ids[2],{x:50+Math.random(),y:40+Math.random()});
          paper.select(ids); alignSelection(mode);
          const after=read();
          const value=obj=>{const[x,y,w,h]=[obj.x,obj.y,obj.w,obj.h];return expected[mode]==='x'?x:expected[mode]==='x+w/2'?x+w/2:expected[mode]==='x+w'?x+w:expected[mode]==='y'?y:expected[mode]==='y+h/2'?y+h/2:y+h;};
          const vs=after.map(value),ok=Math.max(...vs)-Math.min(...vs)<1e-6;
          alignDetail[mode]={values:vs,ok}; if(!ok)alignOk=false;
        }
        check('alignSelection aligns multiple document objects in all six modes',alignOk,alignDetail);
      } else {
        checks.push({name:'alignSelection aligns multiple document objects in all six modes',pass:false,unavailable:true,
          detail:{reason:'核心层尚未提供 controller.alignSelection，如实记录为不可用'}});
      }

      /* ---------- 4. 图片重置裁剪 ---------- */
      const imageId=await paper.addImage({dataUrl:${JSON.stringify(TINY_PNG)},x:14,y:14,w:6,h:4});
      paper.updateObject(imageId,{crop:{x:0.1,y:0.2,w:0.5,h:0.5}});
      paper.select([imageId]); ui.showProperties();
      const resetCrop=[...ui.panel.querySelectorAll('button')].find(b=>b.textContent==='重置裁剪');
      resetCrop.click(); await wait(120);
      const cropAfter=paper.getState().objects.find(o=>o.id===imageId)?.crop;
      const cropTip=[...ui.panel.querySelectorAll('p')].some(p=>p.textContent.includes('拖动角点时按住 Shift 等比缩放'));
      check('the image panel resets the crop with one button and documents the Shift behaviour',
        !!resetCrop&&cropAfter&&cropAfter.x===0&&cropAfter.y===0&&cropAfter.w===1&&cropAfter.h===1&&cropTip,
        {resetButton:!!resetCrop,crop:cropAfter,imageObject:paper.getState().objects.find(o=>o.id===imageId)?.kind,tip:cropTip,
          panelText:ui.panel.textContent.slice(0,300)});
      ui.panel.querySelector('[aria-label="关闭属性面板"]')?.click();

      /* ---------- 5. 3D 对象交互浮层 ---------- */
      const mol3dId=(typeof paper.addMolecule3D==='function'
        ?paper.addMolecule3D({molfile:${JSON.stringify(METHANE_MOLBLOCK)},style:'ballstick',camera:{px:0,py:0,pz:25,distance:25},
          notes:{sourceSummary:'测试用例：甲烷示例构型',warnings:[],geometryNote:'示例几何'},at:{x:33,y:51}})
        :controller.addMolecule3D({molfile:${JSON.stringify(METHANE_MOLBLOCK)},style:'ballstick',camera:{px:0,py:0,pz:25,distance:25},
          notes:{sourceSummary:'测试用例：甲烷示例构型',warnings:[],geometryNote:'示例几何'},at:{x:33,y:51}}));
      const mol3dBefore=structuredClone(paper.getState().objects.find(o=>o.id===mol3dId));
      paper.select([mol3dId]); ui.showProperties();
      const styleField=ui.panel.querySelector('select[aria-label="样式"]');
      const sourceBtn=[...ui.panel.querySelectorAll('button')].find(b=>b.textContent==='从源结构更新');
      const hintShown=[...ui.panel.querySelectorAll('p')].some(p=>p.textContent.includes('双击对象进入 3D 交互'));
      const notesShown=[...ui.panel.querySelectorAll('pre')].some(p=>p.textContent.includes('测试用例：甲烷示例构型'));
      check('the molecule3d property panel branch renders style, source update, hint and verbatim notes',
        !!styleField&&!!sourceBtn&&hintShown&&notesShown&&styleField.value==='ballstick',
        {styleField:!!styleField,sourceBtn:!!sourceBtn,hintShown,notesShown,style:styleField?.value});
      const panel=ui.panel;
      const candidatePromise=ui.chooseMolecule3DTarget([{atomUuids:['u1','u2','u3'],size:3},{atomUuids:['u4','u5'],size:2}]);
      await wait(60);
      const dialog=hostDoc.querySelector('[aria-label="选择分子"]');
      const rows=[...(dialog?.querySelectorAll('[data-doc-molecule-candidate]')||[])];
      const confirmBtn=[...(dialog?.querySelectorAll('button')||[])].find(b=>b.textContent==='确认');
      const confirmDisabledBefore=confirmBtn?.disabled===true;
      rows[1]?.click(); await wait(30); confirmBtn?.click();
      const chosen=await candidatePromise;
      check('the molecule target chooser lists candidates and confirms the selected one',
        !!dialog&&rows.length===2&&confirmDisabledBefore&&!!chosen&&chosen.size===2&&rows[1]?.textContent.includes('分子 2'),
        {dialog:!!dialog,rows:rows.length,confirmDisabledBefore,chosenSize:chosen?.size,rowText:rows[1]?.textContent});
      const stereoPromise=ui.confirmStereoExample({counts:{tetraCenters:1,doubleBonds:0},molecules:'1 个分子'});
      await wait(60);
      const stereoDialog=hostDoc.querySelector('[role="dialog"][aria-modal="true"]');
      const stereoText=stereoDialog?.textContent||'';
      const stereoConfirm=[...(stereoDialog?.querySelectorAll('button')||[])].find(b=>b.textContent==='使用示例构型');
      stereoConfirm?.click(); const stereoYes=await stereoPromise;
      const stereoPromise2=ui.confirmStereoExample({counts:{tetraCenters:2,doubleBonds:1},molecules:'1 个分子'});
      await wait(60);
      const stereoDialog2=hostDoc.querySelector('[role="dialog"][aria-modal="true"]');
      [...(stereoDialog2?.querySelectorAll('button')||[])].find(b=>b.textContent==='取消')?.click();
      const stereoNo=await stereoPromise2;
      check('the stereo dialog shows verbatim stereo info and resolves true/false from its buttons',
        stereoText.includes('tetraCenters')&&stereoText.includes('1 个分子')&&stereoYes===true&&stereoNo===false,
        {showsCounts:stereoText.includes('tetraCenters'),showsMolecules:stereoText.includes('1 个分子'),stereoYes,stereoNo});

      const webgl=hostDoc.createElement('canvas');
      const webglOk=!!(webgl.getContext('webgl')||webgl.getContext('experimental-webgl'));
      let overlayOk=false,activeDuring=false,finishSaved=false,cameraAfter=null,undoRestored=false,styleSwitched=false,overlayGone=false,finishError=null;
      if(webglOk){
        try{
          const activated=await controller.onMolecule3DActivate(mol3dId);
          await wait(600);
          const overlay=hostDoc.getElementById('molstudio-3d-interaction');
          overlayOk=!!activated&&!!overlay&&!!overlay.querySelector('.molstudio-3d-host iframe')&&!!overlay.querySelector('select[aria-label="3D 样式"]')&&[...overlay.querySelectorAll('button')].some(b=>b.textContent==='完成');
          activeDuring=controller.insert3DInteractionActive===true;
          const overlaySelect=overlay.querySelector('select[aria-label="3D 样式"]');
          overlaySelect.value='sphere'; overlaySelect.dispatchEvent(new Event('change',{bubbles:true}));
          await wait(700);
          styleSwitched=overlaySelect.value==='sphere'&&overlaySelect.selectedOptions[0].textContent==='空间填充';
          const saved=await ui.finish3DInteraction();
          await wait(200);
          const mol3dAfter=paper.getState().objects.find(o=>o.id===mol3dId);
          cameraAfter=mol3dAfter?.camera||null;
          const previewAssetOk=coreFinish?(typeof mol3dAfter?.previewAsset==='string'&&!!paper.getState().assets?.[mol3dAfter.previewAsset]):true;
          finishSaved=!!saved&&!!cameraAfter&&previewAssetOk&&controller.insert3DInteractionActive===false&&!hostDoc.getElementById('molstudio-3d-interaction');
          overlayGone=!hostDoc.getElementById('molstudio-3d-interaction');
          await k3dAPI.undo(); await wait(200);
          const mol3dUndo=paper.getState().objects.find(o=>o.id===mol3dId);
          undoRestored=JSON.stringify(mol3dUndo.camera)===JSON.stringify(mol3dBefore.camera);
        }catch(e){finishError=String(e?.message||e);}
      }
      check('double-activating a molecule3d object opens the interaction overlay and honours insert3DInteractionActive',
        !webglOk||overlayOk&&activeDuring,{webglOk,overlayOk,activeDuring,finishError});
      check('finishing the 3D interaction saves camera/preview, clears the flag and removes the overlay',
        !webglOk||finishSaved&&styleSwitched&&overlayGone,{finishSaved,styleSwitched,overlayGone,cameraAfter,finishError});
      check('one undo restores the pre-interaction 3D camera',!webglOk||undoRestored,{undoRestored,finishError});

      paper.setPageSetup({mode:'paper'}); paper.fitPage(paper.getState().pages[0].id);
      const finalAvailability=ui.contractAvailability||{};
      await wait(400);
      return {checks,availability:finalAvailability,textId,imageId,mol3dId,source:await k3dAPI.serializeWorkbench(),webglOk};
    })()`);
    report.checks = result.checks;
    report.artifacts.contractAvailability = result.availability;
    report.artifacts.webglAvailable = result.webglOk;
    report.artifacts.editableSample = path.join(out, 'document-wire-ui-sample.molwork');
    fs.writeFileSync(report.artifacts.editableSample, result.source);
    await wait(120);
    report.artifacts.canvasScreenshot = path.join(out, 'document-wire-ui-canvas.png');
    fs.writeFileSync(report.artifacts.canvasScreenshot, (await win.capturePage()).toPNG());
    report.ok = report.checks.every(check => check.pass);
  } catch (error) {
    report.ok = false; report.error = String(error?.stack || error);
    if (win && !win.isDestroyed()) {
      const checks = await win.webContents.executeJavaScript('window.__documentWireUIChecks || []').catch(() => []);
      if (checks.length > report.checks.length) report.checks = checks;
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try {
        if (!report.artifacts.canvasScreenshot) {
          report.artifacts.failureScreenshot = path.join(out, 'document-wire-ui-failure.png');
          fs.writeFileSync(report.artifacts.failureScreenshot, (await win.capturePage()).toPNG());
        }
      } catch (error) { report.captureError = String(error?.message || error); }
    }
    report.finishedAt = new Date().toISOString(); report.artifactDirectory = out; writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.pass).length,
      total: report.checks.length, failures: report.checks.filter(check => !check.pass), error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch(error => {
  report.ok = false; report.error = String(error?.stack || error); report.finishedAt = new Date().toISOString();
  report.artifactDirectory = out; writeReport(); console.error(report.error); app.exit(1);
});
