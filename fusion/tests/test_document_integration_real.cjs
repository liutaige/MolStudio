'use strict';
// 最终整合验证：同一纸页混排文本/形状/图片/3D 预览/化学机理，覆盖保存重开、
// 纸页显示比例下的命中测试与导出一致性。隔离本地服务，无模型调用。
//   MOLSTUDIO_PORT=49180 npm --prefix fusion start   （先起隔离服务，完事 kill）
//   MOLSTUDIO_TEST_BUILD='...' MOLSTUDIO_AGENT_TEST_OUT=/absolute/out \
//     env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron --no-sandbox \
//     fusion/tests/test_document_integration_real.cjs
// NOTE: 不要加 --disable-gpu：3D 检查需要真实 WebGL。

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49180;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-integration-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-integration-'));
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
  report.ok = false; report.error = 'Electron document integration watchdog expired (240s)';
  writeReport(); win?.destroy(); app.exit(2);
}, 240_000);
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_event, details) => report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`));
  const js = code => win.webContents.executeJavaScript(code);
  const shot = async name => {
    const image = await win.webContents.capturePage();
    const file = path.join(out, name);
    fs.writeFileSync(file, image.toPNG());
    report.artifacts[name.replace(/\.png$/, '')] = file;
    return file;
  };
  // 分阶段执行：阶段内失败也保留已完成检查，并先落一张失败截图。
  const stage = async (label, code) => {
    const base = report.checks.length;
    try {
      const r = await js(code);
      if (Array.isArray(r?.checks)) report.checks.push(...r.checks.slice(base));
      return r;
    } catch (error) {
      report.error = report.error || `${label}: ${String(error?.message || error)}`;
      const partial = await js('window.__ic || []').catch(() => []);
      if (Array.isArray(partial) && partial.length > report.checks.length) report.checks = partial;
      try { report.progress = await js('window.__prog || []'); } catch (_) {}
      try { await shot('failure-canvas.png'); } catch (e) { report.captureError = String(e?.message || e); }
      throw error;
    }
  };
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('Current canvas did not become ready');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-mechanism/F01.molwork'), 'utf8');
    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('F01 fixture failed to load: ' + JSON.stringify(loaded));
    await js(`window.__ic=window.__ic||[];`);

    /* ---------- 阶段 1：纸页初始化 + 化学居中 + 富文本 + 形状 + 图片 ---------- */
    const s1 = await stage('paper-setup', `(async()=>{
      const checks=window.__ic; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail:detail??null});return !!pass;};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench,c=MW.app.documentController,ad=MW.app.adapter,rt=MW.documentRichText,dm=MW.documentModel;
      const st=ad.struct();
      const selectAllChem=()=>{ad.ed.selection({atoms:[...st.atoms.keys()],bonds:[...st.bonds.keys()]});c.render();};
      const coords=()=>{const o={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)o[uuid]=[pp.x,pp.y];}return o;};

      c.setPageSetup({mode:'paper'}); c.fitPage();
      const page=dm.pageRects(c.state)[0], content=page.content;
      check('载入 F01 并切换纸页模式完成 fitPage', c.state.mode==='paper'&&c.active===true&&!!page&&content.w>0,
        {mode:c.state.mode,active:c.active,pages:c.state.pages.length,content});
      // F01 化学在页面坐标之外（y 为负），先整体移入首页内容区中心（setup 性质的合法文档操作）
      selectAllChem();
      const b0=c.selectionChemistryBounds();
      c.moveSelection((content.x+content.w/2)-(b0.x+b0.w/2),(content.y+content.h/2)-(b0.y+b0.h/2));
      await wait(150);
      const chem=coords();
      const chemInside=[...st.atoms.values()].every(a=>a.pp.x>=content.x&&a.pp.x<=content.x+content.w&&a.pp.y>=content.y&&a.pp.y<=content.y+content.h);
      check('F01 化学与机理整体移入首页内容区', chemInside&&Object.keys(chem).length>0,{atomCount:Object.keys(chem).length,chemInside});

      // 富文本：H2O（2 下标）+ 第二行 SO42-（2- 上标），部分加粗+颜色
      const tx=c.addText({x:content.x+2,y:content.y+2,w:30,h:10,text:'H2O\\nSO42-'});
      c.applyTextFormat(tx,{start:1,end:2},{sub:true});
      c.applyTextFormat(tx,{start:7,end:8},{sup:true});
      c.applyTextFormat(tx,{start:4,end:6},{bold:true,color:'#a03422'});
      const tobj=c.object(tx), segs=rt.segments(tobj.rich);
      const at=i=>segs.find(s=>i>=s.start&&i<s.end);
      const richOk=tobj.rich.text==='H2O\\nSO42-'&&Array.isArray(tobj.rich.runs)&&tobj.rich.runs.length>0&&
        at(1)?.sub===true&&at(2)?.sub===undefined&&at(7)?.sup===true&&at(8)?.sup===undefined&&
        at(4)?.bold===true&&at(4)?.color==='#a03422'&&at(0)?.bold===undefined;
      check('富文本 H2O 下标与 SO42- 上标及加粗颜色 runs 覆盖正确', richOk,
        {text:tobj.rich.text,runs:tobj.rich.runs,seg1:at(1),seg4:at(4),seg7:at(7)});
      const frameDoc2=document.getElementById('k').contentDocument;
      const editorIn=()=>frameDoc2.getElementById('molstudio-document-editor')||document.getElementById('molstudio-document-editor');
      c.editText(tx); const divOpen=!!editorIn(); c.finishTextEdit(); await wait(120);
      check('文本框 editText 打开编辑器并 finishTextEdit 关闭', divOpen&&!editorIn(),
        {divOpen,divClosed:!editorIn(),frameEditor:true});

      // 形状：箭头（描边+虚线）+ 方括号（描边+填充）
      const arrowId=c.addShape({shape:'arrow',x:content.x+2,y:content.y+16,w:12,h:4,stroke:{color:'#d02020',width:0.3,dash:'dashed'}});
      const bracketId=c.addShape({shape:'bracket',x:content.x+16,y:content.y+16,w:6,h:8,fill:'#eef4f8',stroke:{color:'#2a6e8f',width:0.25}});
      c.render(); await wait(120);
      const frameDoc=document.getElementById('k').contentDocument;
      const n1=frameDoc.querySelector('[data-doc-id="'+arrowId+'"] path')||document.querySelector('[data-doc-id="'+arrowId+'"] path');
      const n2=frameDoc.querySelector('[data-doc-id="'+bracketId+'"] path')||document.querySelector('[data-doc-id="'+bracketId+'"] path');
      const dashOk=(n1?.getAttribute('stroke-dasharray')||'').length>0;
      check('形状插入后画布 SVG 含对应 data-doc-id 节点且描边填充虚线生效',
        !!n1&&!!n2&&dashOk&&(c.object(bracketId).fill==='#eef4f8'),
        {arrowNode:!!n1,bracketNode:!!n2,dash:n1?.getAttribute('stroke-dasharray'),fill:c.object(bracketId).fill});

      // 图片：页内 canvas 生成 16x16 PNG dataURL → File → insertImageFile
      const cv=document.createElement('canvas'); cv.width=16; cv.height=16;
      const g2=cv.getContext('2d'); g2.fillStyle='#3b82c4'; g2.fillRect(0,0,16,16); g2.fillStyle='#ffffff'; g2.fillRect(4,4,8,8);
      const pngUrl=cv.toDataURL('image/png');
      const bytes=await (await fetch(pngUrl)).arrayBuffer();
      const imgId=await c.insertImageFile(new File([bytes],'t.png',{type:'image/png'}),{x:content.x+18,y:content.y+4});
      const iobj=c.object(imgId);
      check('insertImageFile 插入图片对象并写入 assets', iobj?.kind==='image'&&!!c.state.assets[iobj.asset]?.data,
        {kind:iobj?.kind,assetMime:c.state.assets[iobj?.asset]?.mime,size:iobj&&{w:iobj.w,h:iobj.h}});

      return {checks,tx,arrowId,bracketId,imgId,content:{x:content.x,y:content.y,w:content.w,h:content.h},
        chemBefore:chem,lonePairs:c.mechanism.model.state.lonePairs.length,arrows:c.mechanism.model.state.arrows.length,
        atomUuid0:[...ad.atomUuid.values()][0]};
    })()`);

    /* ---------- 阶段 2：3D 真实生成 + 失败路径 + 删除/撤销/复制 ---------- */
    const s2 = await stage('molecule3d', `(async()=>{
      const checks=window.__ic; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail:detail??null});return !!pass;};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench,c=MW.app.documentController,ad=MW.app.adapter;
      const st=ad.struct();
      const selectAllChem=()=>{ad.ed.selection({atoms:[...st.atoms.keys()],bonds:[...st.bonds.keys()]});c.render();};
      const content=${JSON.stringify(s1.content)}; const tx=${JSON.stringify(s1.tx)};
      const arrowId=${JSON.stringify(s1.arrowId)}, bracketId=${JSON.stringify(s1.bracketId)}, imgId=${JSON.stringify(s1.imgId)};
      const prog=window.__prog=window.__prog||[]; const mark=m=>{prog.push(m);};
      c.onStereoChoiceRequired=async()=>true; // 立体确认兜底：使用示例构型
      // F01 含两个分子，headless 下替换 UI 弹窗选择器：取原子数最多的连通分量
      c.onChooseMolecule3DTarget=async candidates=>[...candidates].sort((a,b)=>b.size-a.size)[0];
      const withTimeout=(p,ms,label)=>Promise.race([p,new Promise(res=>setTimeout(()=>res({ok:false,error:label+' 超时 '+ms+'ms'}),ms))]);
      // 生成链路逐步打点，定位挂起环节
      const o3mod=MW.documentObject3D;
      const wrap=(obj,key,tag)=>{const orig=obj[key];if(typeof orig!=='function')return;
        obj[key]=function(...a){mark(tag+'-start');const p=orig.apply(this,a);
          return Promise.resolve(p).then(v=>{mark(tag+'-ok');return v;},e=>{mark(tag+'-err:'+String(e&&e.message||e));throw e;});};};
      wrap(c.adapter,'exportKetWithBindings','exportKet');
      wrap(o3mod,'generate3D','generate3D');
      wrap(o3mod.InteractionSession.prototype,'mount','mount');
      {
        const proto=o3mod.InteractionSession.prototype;
        const origSnap=proto.snapshot;
        proto.snapshot=function(...a){
          mark('snapshot-start');
          const p=origSnap.apply(this,a);
          return Promise.resolve(p).then(v=>{mark('snapshot-ok');return v;},e=>{
            let st=null; try{const w=this.iframe&&this.iframe.contentWindow;
              st={hasWin:!!w,k3d:!!(w&&w.k3d),k3dKeys:w&&w.k3d?Object.keys(w.k3d):null,
                  lastStyle:w&&w.__lastStyle||null,showSeq:w&&w.__embedShowSeq||0,doneSeq:w&&w.__embedDoneSeq||0,
                  loadErr:(w&&w.__loadError)||null,glErr:(w&&w.__glError)||null,
                  hasStage:!!(w&&w.stage),vSize:(w&&w.document.getElementById('v')?w.document.getElementById('v').style.cssText:null),
                  parentSameAsK:w&&w.parent===document.getElementById('k').contentWindow};}catch(x){st='probe:'+String(x);}
            mark('snapshot-err:'+String(e&&e.message||e)+' state:'+JSON.stringify(st));throw e;});
        };
      }
      wrap(o3mod.InteractionSession.prototype,'cameraJson','camera');
      // 诊断：记录 3D iframe 握手消息与加载状态

      // 成功路径：真实 /api/gen3d + 顶层文档离屏快照（controller.generateMolecule3D
      // 传 ketText 字符串给 /api/gen3d，离屏 host 建在顶层文档）。
      const objectsBefore=c.state.objects.length, assetsBefore=Object.keys(c.state.assets).length;
      selectAllChem(); mark('select-chem');
      mark('gen3d-start');
      const insertion=c.insertMolecule3DPreview({at:{x:content.x+12,y:content.y+36}});
      const previewUI=MW.app.documentUI;
      for(let i=0;i<600&&!previewUI.active3D?.ready;i++) await wait(100);
      if(previewUI.active3D?.ready) await previewUI.finish3DInteraction();
      const r=await withTimeout(insertion,110000,'3D 生成+确认快照');
      mark('gen3d-end:'+JSON.stringify(r&&{ok:r.ok,error:r.error,id:r.id}));
      const m3=r&&r.id; const o3=c.object(m3);
      const cam=o3?.camera||{}; const camKeys=['px','py','pz','distance'];
      const camOk=camKeys.every(k=>Number.isFinite(cam[k]));
      check('insertMolecule3DPreview 走真实生成链路插入 molecule3d 对象',
        r?.ok===true&&o3?.kind==='molecule3d'&&camOk&&typeof o3.previewAsset==='string'&&!!c.state.assets[o3.previewAsset],
        {result:{ok:r?.ok,error:r?.error,id:r?.id},kind:o3?.kind,camera:cam,previewAsset:o3?.previewAsset,assetBytes:(c.state.assets[o3?.previewAsset]?.data||'').length});
      if(o3) check('3D 对象记录 source.atomUuids 且资源计数新增正确',
        Array.isArray(o3?.source?.atomUuids)&&o3.source.atomUuids.length>0&&
        c.state.objects.length===objectsBefore+1&&Object.keys(c.state.assets).length===assetsBefore+1,
        {atomUuids:o3?.source?.atomUuids,objects:[objectsBefore,c.state.objects.length],assets:[assetsBefore,Object.keys(c.state.assets).length]});
      else check('3D 对象记录 source.atomUuids 且资源计数新增正确',false,{result:r});

      // 失败路径：fetch 500 → {ok:false} 且无残留对象/资产
      if(o3){
      selectAllChem(); mark('fail-path-start');
      const realFetch=window.fetch;
      window.fetch=(input,init)=>{const u=typeof input==='string'?input:(input&&input.url)||'';
        if(u.indexOf('/api/gen3d')>=0)return Promise.resolve(new Response(JSON.stringify({error:'forced failure for regression'}),{status:500}));
        return realFetch(input,init);};
      let failRes=null,failError=null;
      try{ failRes=await c.insertMolecule3DPreview({at:{x:content.x+12,y:content.y+36}}); }catch(e){ failError=String(e?.message||e); }
      window.fetch=realFetch; mark('fail-path-end:'+JSON.stringify(failRes));
      const noResidue=c.state.objects.length===objectsBefore+1&&Object.keys(c.state.assets).length===assetsBefore+1;
      check('gen3d 返回 500 时 insertMolecule3DPreview 返回 ok:false 且无残留对象与资产',
        failRes?.ok===false&&typeof failRes?.error==='string'&&noResidue,
        {failRes,failError,objects:c.state.objects.length,assets:Object.keys(c.state.assets).length,expected:objectsBefore+1});
      }

      // 删除 → 一次 undo 恢复 → duplicateSelection 复制副本（previewAsset 指向有效资产）→ 清理副本
      if(o3){
      c.select([m3]); c.deleteSelection(); await wait(120); mark('deleted');
      const gone=!c.object(m3);
      await k3dAPI.undo(); await wait(250); mark('undo-done');
      const back=c.object(m3);
      check('3D 对象删除后一次 undo 恢复', gone&&!!back&&back.kind==='molecule3d',{gone,restored:!!back});
      c.select([m3]);
      const dupIds=c.duplicateSelection(); await wait(120);
      const dup=dupIds.length?c.object(dupIds[0]):null;
      const dupAssetOk=!!dup&&typeof dup.previewAsset==='string'&&!!c.state.assets[dup.previewAsset];
      check('duplicateSelection 复制出新 id 且副本 previewAsset 指向有效资产',
        !!dup&&dup.id!==m3&&dup.kind==='molecule3d'&&dupAssetOk,
        {dupId:dup?.id,previewAsset:dup?.previewAsset,assetPresent:dupAssetOk,
         note:'controller.duplicateSelection 为就地复制，副本与原对象共享同一资产 id（复制粘贴路径才做资产重映射）'});
      c.select([dup.id]); c.deleteSelection(); await wait(120);
      check('多余 3D 副本已清理且原对象仍在', !c.object(dup?.id)&&!!c.object(m3),{copyGone:!c.object(dup?.id),original:!!c.object(m3)});
      }

      return {checks,m3:o3?m3:null,prog};
    })()`, );

    /* ---------- 阶段 3：混合移动 + 选区缩放 + 纸页显示比例 ---------- */
    const s3 = await stage('move-scale-zoom', `(async()=>{
      const checks=window.__ic; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail:detail??null});return !!pass;};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench,c=MW.app.documentController,ad=MW.app.adapter;
      const st=ad.struct();
      const selectAllChem=()=>{ad.ed.selection({atoms:[...st.atoms.keys()],bonds:[...st.bonds.keys()]});c.render();};
      const atomPos=uuid=>{const rid=ad.atomIdOf(uuid);const p=st.atoms.get(rid)?.pp;return p?[p.x,p.y]:null;};
      const coords=()=>{const o={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)o[uuid]=[pp.x,pp.y];}return o;};
      const tx=${JSON.stringify(s1.tx)}, arrowId=${JSON.stringify(s1.arrowId)}, atomUuid=${JSON.stringify(s1.atomUuid0)};

      // 混合移动：文本框 + 形状 + 一个化学原子，同步位移，一次 undo 全还原
      const t0=c.object(tx),a0=c.object(arrowId),p0=atomPos(atomUuid);
      c.select([tx,arrowId,atomUuid]); await wait(80);
      c.moveSelection(2,0); await wait(150);
      const t1=c.object(tx),a1=c.object(arrowId),p1=atomPos(atomUuid);
      const movedOk=Math.abs(t1.x-(t0.x+2))<1e-6&&Math.abs(t1.y-t0.y)<1e-6&&
        Math.abs(a1.x-(a0.x+2))<1e-6&&Math.abs(p1[0]-(p0[0]+2))<1e-6&&Math.abs(p1[1]-p0[1])<1e-6;
      await k3dAPI.undo(); await wait(250);
      const t2=c.object(tx),a2=c.object(arrowId),p2=atomPos(atomUuid);
      const undoOk=Math.abs(t2.x-t0.x)<1e-6&&Math.abs(a2.x-a0.x)<1e-6&&Math.abs(p2[0]-p0[0])<1e-6&&Math.abs(p2[1]-p0[1])<1e-6;
      check('混合选择（文本+形状+化学原子）moveSelection 同步位移且一次 undo 全还原', movedOk&&undoOk,
        {moved:{text:t1.x-t0.x,arrow:a1.x-a0.x,atom:p1[0]-p0[0]},undo:{text:t2.x-t0.x,arrow:a2.x-a0.x,atom:p2[0]-p0[0]}});

      // 选区缩放（纸页限定）：beginScaleSession + applyScalePercent(150)
      selectAllChem();
      const cb0=c.selectionChemistryBounds(); const center0={x:cb0.x+cb0.w/2,y:cb0.y+cb0.h/2};
      const before=coords();
      c.beginScaleSession(); c.applyScalePercent(150); c.endScaleSession(); await wait(250);
      const after=coords();
      const ratios=Object.keys(before).map(uuid=>{
        const r0=[before[uuid][0]-center0.x,before[uuid][1]-center0.y],r1=[after[uuid][0]-center0.x,after[uuid][1]-center0.y];
        return [uuid,Math.abs(r0[0])>1e-9?r1[0]/r0[0]:1,Math.abs(r0[1])>1e-9?r1[1]/r0[1]:1,Math.abs(r0[1])];
      });
      const ratioOk=ratios.every(([,rx,ry,dy0])=>Math.abs(rx-1.5)<1e-6&&(dy0<1e-9||Math.abs(ry-1.5)<1e-6));
      const factors150=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      await k3dAPI.undo(); await wait(250);
      const restored=coords();
      const undoRestored=Object.keys(before).every(uuid=>Math.abs(restored[uuid][0]-before[uuid][0])<1e-6&&Math.abs(restored[uuid][1]-before[uuid][1])<1e-6);
      const factorsUndo=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      check('beginScaleSession+applyScalePercent(150) 原子坐标比 1.5、visualScales 1.5 且一次 undo 恢复',
        ratioOk&&factors150.every(f=>Math.abs(f-1.5)<1e-9)&&undoRestored&&factorsUndo.every(f=>Math.abs(f-1)<1e-9),
        {sample:ratios.slice(0,3),factors150:[...new Set(factors150)],undoRestored,factorsUndo:[...new Set(factorsUndo)]});

      // 直接 scaleSelection(0.75) 后保存基准
      selectAllChem();
      const scaled=c.scaleSelection(0.75); await wait(250);
      const coords075=coords();
      const factors075=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      const ratio075=Object.keys(before).every(uuid=>{
        const r0=[before[uuid][0]-center0.x,before[uuid][1]-center0.y],r1=[coords075[uuid][0]-center0.x,coords075[uuid][1]-center0.y];
        return (Math.abs(r0[0])<1e-9||Math.abs(r1[0]/r0[0]-0.75)<1e-6)&&(Math.abs(r0[1])<1e-9||Math.abs(r1[1]/r0[1]-0.75)<1e-6);
      });
      check('scaleSelection(0.75) 二次缩放生效并保持 atomScales 0.75', scaled===true&&ratio075&&factors075.every(f=>Math.abs(f-0.75)<1e-9),
        {scaled:scaled===true,ratio075,factors075:[...new Set(factors075)]});

      // 纸页显示比例：50/150 命中测试 + 往返
      const zoomBefore=ad.zoom();
      const z50=c.setPaperZoom(50), g50=c.getPaperZoom();
      const tp=c.object(tx); const hp={x:tp.x+tp.w/2,y:tp.y+tp.h/2};
      const hit50=c.hit(hp);
      const z150=c.setPaperZoom(150), g150=c.getPaperZoom();
      const hit150=c.hit(hp);
      const z100=c.setPaperZoom(100), g100=c.getPaperZoom();
      check('纸页显示比例 50/150 设置往返误差小于 1 且命中测试可用并复原 100',
        Math.abs(g50-50)<1&&Math.abs(g150-150)<1&&Math.abs(g100-100)<1&&!!hit50&&!!hit150&&z50!==z150,
        {g50,g150,g100,hit50:hit50?.id===tp.id,hit150:hit150?.id===tp.id,zoom:[zoomBefore,z50,z150,z100]});
      return {checks,coords075};
    })()`);

    /* ---------- 阶段 4：保存重开 + 导出一致性 ---------- */
    const s4 = await stage('save-reload-export', `(async()=>{
      const checks=window.__ic; const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail:detail??null});return !!pass;};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const MW=MolWorkbench,c=MW.app.documentController,ad=MW.app.adapter,rt=MW.documentRichText;
      const st=ad.struct();
      const coords=()=>{const o={};for(const [id,uuid] of ad.atomUuid){const pp=st.atoms.get(id)?.pp;if(pp)o[uuid]=[pp.x,pp.y];}return o;};
      const tx=${JSON.stringify(s1.tx)}, arrowId=${JSON.stringify(s1.arrowId)}, bracketId=${JSON.stringify(s1.bracketId)},
        imgId=${JSON.stringify(s1.imgId)}, m3=${JSON.stringify(s2.m3)}, coords075=${JSON.stringify(s3.coords075)};
      const mechBefore={lonePairs:c.mechanism.model.state.lonePairs.length,arrows:c.mechanism.model.state.arrows.length};

      const saved=await k3dAPI.serializeWorkbench();
      window.__savedSnap=JSON.parse(saved);
      const loaded=await k3dAPI.loadWorkbench(saved);
      if(!loaded.ok) throw new Error('reload failed: '+JSON.stringify(loaded));
      await wait(600);
      // 重开后若文档层未激活则重新进入纸页（如实记录）
      let reactivated=false;
      if(!c.active){ c.setPageSetup({mode:'paper'}); reactivated=true; }
      c.fitPage(); await wait(200);

      const tobj=c.state.objects.find(o=>o.rich?.text==='H2O\\nSO42-');
      const segs=tobj?rt.segments(tobj.rich):[];
      const at=i=>segs.find(s=>i>=s.start&&i<s.end);
      const runsOk=!!tobj&&at(1)?.sub===true&&at(7)?.sup===true&&at(4)?.bold===true&&at(4)?.color==='#a03422';
      let editOk=false;
      if(tobj){ const fdoc=document.getElementById('k').contentDocument;
        const editorIn=()=>fdoc.getElementById('molstudio-document-editor')||document.getElementById('molstudio-document-editor');
        c.editText(tobj.id); editOk=!!editorIn(); c.finishTextEdit(); await wait(120); }
      check('保存重开后文本 runs 保持且双击编辑通道可用（editText 后编辑器 div 存在）',
        runsOk&&editOk,{runsOk,editOk,runs:tobj?.rich?.runs});

      const arrowObj=c.object(arrowId),bracketObj=c.object(bracketId),imgObj=c.object(imgId),m3Obj=c.object(m3);
      const objectsOk=arrowObj?.kind==='shape'&&arrowObj.shape==='arrow'&&bracketObj?.shape==='bracket'&&
        imgObj?.kind==='image'&&!!c.state.assets[imgObj.asset]?.data&&
        m3Obj?.kind==='molecule3d'&&typeof m3Obj.previewAsset==='string'&&!!c.state.assets[m3Obj.previewAsset];
      check('保存重开后形状/图片/3D 对象齐全且 previewAsset 资源在', objectsOk,
        {arrow:!!arrowObj,bracket:!!bracketObj,image:imgObj?.kind&&!!c.state.assets[imgObj.asset],m3:m3Obj?.kind,
         previewAssetBytes:(c.state.assets[m3Obj?.previewAsset]?.data||'').length});

      const now=coords();
      const chemOk=Object.keys(coords075).every(uuid=>now[uuid]&&Math.abs(now[uuid][0]-coords075[uuid][0])<1e-6&&Math.abs(now[uuid][1]-coords075[uuid][1])<1e-6);
      const factors=[...ad.atomUuid.values()].map(u=>ad.effectiveAtomScale(u));
      const mechAfter={lonePairs:c.mechanism.model.state.lonePairs.length,arrows:c.mechanism.model.state.arrows.length};
      check('保存重开后化学坐标与 atomScales 0.75 一致且机理孤对/箭头数量不变',
        chemOk&&factors.every(f=>Math.abs(f-0.75)<1e-9)&&mechAfter.lonePairs===mechBefore.lonePairs&&mechAfter.arrows===mechBefore.arrows,
        {chemOk,factors:[...new Set(factors)],mechBefore,mechAfter,reactivated});

      const saved2=await k3dAPI.serializeWorkbench();
      const a=window.__savedSnap,b=JSON.parse(saved2);
      const deepEqual=(x,y)=>{if(x===y)return true;if(typeof x!==typeof y||x===null||y===null)return false;
        if(Array.isArray(x)){return Array.isArray(y)&&x.length===y.length&&x.every((v,i)=>deepEqual(v,y[i]));}
        if(typeof x==='object'){const kx=Object.keys(x).sort(),ky=Object.keys(y).sort();
          return JSON.stringify(kx)===JSON.stringify(ky)&&kx.every(k=>deepEqual(x[k],y[k]));}
        return false;};
      check('重开前后两次 serializeWorkbench 解析为对象后深度一致', deepEqual(a,b),
        {keysA:Object.keys(a).sort(),keysB:Object.keys(b).sort(),reactivated});

      // 导出一致性
      const ex=await c.exportPages();
      const exOk=ex?.ok===true&&Array.isArray(ex.pages)&&ex.pages.length>=1;
      let svgDetail={exOk};
      let svgPass=false;
      if(exOk){
        const doc=new DOMParser().parseFromString(ex.pages[0].svg,'image/svg+xml');
        const m3Image=!!doc.querySelector('[data-doc-id="'+m3+'"] image');
        const tspans=[...doc.querySelectorAll('tspan')];
        const subOk=tspans.some(t=>t.getAttribute('baseline-shift')==='sub');
        const supOk=tspans.some(t=>t.getAttribute('baseline-shift')==='super');
        const shapePaths=doc.querySelectorAll('[data-doc-id="'+arrowId+'"] path,[data-doc-id="'+bracketId+'"] path').length>=2;
        const docGroupPaths=[...doc.querySelectorAll('[data-doc-id] path')].length;
        const chemPaths=[...doc.querySelectorAll('path')].length-docGroupPaths;
        const missing=c.state.objects.filter(o=>!doc.querySelector('[data-doc-id="'+o.id+'"]')).map(o=>o.id);
        svgPass=m3Image&&subOk&&supOk&&shapePaths&&chemPaths>0&&missing.length===0;
        svgDetail={m3Image,subOk,supOk,shapePaths,chemPaths,missing,warnings:ex.warnings};
        window.__exportPages={pages:ex.pages.map(p=>({id:p.id,widthPt:p.widthPt,heightPt:p.heightPt,svg:p.svg})),warnings:ex.warnings};
      }
      check('exportPages SVG 含 molecule3d image、文本 tspan（baseline-shift）、形状 path、原子 path 且无 data-doc-id 节点缺失',
        svgPass,svgDetail);
      return {checks,saved2};
    })()`);

    // 产物落盘
    report.progress = s2.prog || [];
    fs.writeFileSync(path.join(out, 'integration-sample.molwork'), s4.saved2);
    report.artifacts.editableSample = path.join(out, 'integration-sample.molwork');
    if (s4.saved2) {
      const pagesPayload = await js(`(function(){
        const snap=JSON.parse(JSON.stringify(window.__savedSnap||{}));
        const pages=window.__exportPages||null;
        return JSON.stringify({document:snap.document||snap,exportPages:pages});
      })()`);
      fs.writeFileSync(path.join(out, 'integration-pages.json'), pagesPayload);
      report.artifacts.pagesExport = path.join(out, 'integration-pages.json');
    }
    await wait(150);
    await shot('canvas.png');
    // CSP/弃用类警告不计为失败
    const noisy = /Content-Security-Policy|Content Security Policy|deprecat|Autofocus processing|net::ERR_ABORTED|unsafe-blob|Fontconfig|Passthrough is not supported/i;
    report.browserErrors = report.browserErrors.map(String);
    const seriousErrors = report.browserErrors.filter(m => !noisy.test(m));
    report.ok = report.checks.every(c => c.pass) && seriousErrors.length === 0;
    if (seriousErrors.length) report.seriousBrowserErrors = seriousErrors;
  } catch (error) {
    report.ok = false;
    report.error = report.error || String(error?.stack || error);
    try { const partial = await js('window.__ic || []'); if (Array.isArray(partial) && partial.length > report.checks.length) report.checks = partial; } catch (_) {}
    try { report.progress = await js('window.__prog || []'); } catch (_) {}
    if (!report.artifacts.failureCanvas) { try { await shot('failure-canvas.png'); } catch (_) {} }
  } finally {
    clearTimeout(watchdog);
    report.finishedAt = new Date().toISOString();
    report.passed = report.checks.filter(c => c.pass).length;
    report.failed = report.checks.filter(c => !c.pass).length;
    report.artifactDirectory = out;
    writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.passed, total: report.checks.length,
      failures: report.checks.filter(c => !c.pass), error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    win?.destroy();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    setTimeout(() => app.exit(report.ok ? 0 : 1), 150);
  }
}
app.whenReady().then(main).catch(error => {
  report.ok = false; report.error = String(error?.stack || error); report.finishedAt = new Date().toISOString();
  report.artifactDirectory = out; writeReport(); console.error(report.error); app.exit(2);
});
