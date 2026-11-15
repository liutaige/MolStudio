'use strict';
// Real Electron acceptance for the current canvas paper-page UI.
// Uses the isolated local canvas service; no model calls and no OS clipboard.
//   MOLSTUDIO_PORT=49075 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
//     MOLSTUDIO_AGENT_TEST_OUT=/absolute/ignored/artifact/path \
//     fusion/node_modules/.bin/electron fusion/tests/test_document_pages_ui_real.cjs

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49076;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-pages-ui-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-pages-ui-'));
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
  report.ok = false; report.error = 'Electron pages UI regression watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 90_000);
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    if (!loaded?.ok) throw new Error('F01 current-canvas fixture failed to load: ' + JSON.stringify(loaded));

    const result = await js(`(async()=>{
      const checks=window.__documentPagesUIChecks=[];
      const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name);};
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const paper=MolStudio.document,app=MolWorkbench.app,controller=app.documentController;
      const ed=app.adapter.ed,adapter=app.adapter,pagesUI=app.documentUI.pagesUI;
      const hostDoc=document,frame=hostDoc.getElementById('k');
      const nativeToolbarTestNodes=[...frame.contentDocument.querySelectorAll(
        'button[data-testid="zoom-selector"],button[data-testid="settings-button"],button[data-testid="fullscreen-mode-button"]')].map(node=>({
        testId:node.getAttribute('data-testid'),tag:node.tagName,text:(node.innerText||node.textContent||'').trim().slice(0,48),
        title:node.getAttribute('title'),ariaLabel:node.getAttribute('aria-label')}));
      const nativeZoomCandidates=nativeToolbarTestNodes.filter(node=>/zoom|%|magnif/i.test([node.testId,node.text,node.title,node.ariaLabel].filter(Boolean).join(' ')));
      check('the current canvas loads the page sidebar module and public paper zoom APIs',
        !!pagesUI && !!hostDoc.getElementById('molstudio-document-pages') &&
        typeof paper.getPaperZoom==='function' && typeof paper.setPaperZoom==='function' &&
        typeof paper.scrollToPage==='function' && typeof paper.previewPages==='function',
        {pageUI:!!pagesUI,previewPages:typeof paper.previewPages,setPaperZoom:typeof paper.setPaperZoom});

      paper.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      const first=paper.getState().pages[0].id;
      const nativeZoomButton=frame.contentDocument.querySelector('button[data-testid="zoom-selector"]');
      const protectedToolbarIds=new Set(['settings-button','fullscreen-mode-button']);
      const otherNativeToolbarButtons=[...frame.contentDocument.querySelectorAll('button[data-testid]')]
        .filter(button=>protectedToolbarIds.has(button.dataset.testid));
      const otherToolbarVisibilityBefore=otherNativeToolbarButtons.map(button=>({testId:button.dataset.testid,display:getComputedStyle(button).display}));
      check('paper mode hides only Ketcher’s measured zoom selector, keeping its data-testid stable',
        !!nativeZoomButton && getComputedStyle(nativeZoomButton).display==='none' &&
        frame.contentDocument.documentElement.classList.contains('molstudio-paper-mode'),
        {found:!!nativeZoomButton,display:nativeZoomButton&&getComputedStyle(nativeZoomButton).display,
          classed:frame.contentDocument.documentElement.classList.contains('molstudio-paper-mode'),
          otherToolbarVisibilityBefore,nativeToolbarTestNodes});
      for(const atom of adapter.struct().atoms.values()){atom.pp.x+=6;atom.pp.y+=32;}
      ed.update(true); app.controller.render();
      const textId=paper.addText({x:8,y:8,w:24,h:3,text:'Paper page preview'});
      const shapeId=paper.addShape({x:23,y:12,w:5,h:4,shape:'rect',fill:'#e0f2fe',stroke:{color:'#147da5',width:.08}});
      paper.fitPage(first);
      const previewCalls=[];
      const previewOriginal=controller.previewPages.bind(controller);
      controller.previewPages=ids=>{previewCalls.push({requested:[...ids],visible:[...pagesUI.visibleIds]});return previewOriginal(ids);};
      await wait(850);
      const firstCard=hostDoc.querySelector('#molstudio-document-pages [data-page-id="'+first+'"]');
      const firstImg=firstCard?.querySelector('img');
      check('the visible A4 page thumbnail renders a current-canvas SVG preview',
        !!firstCard && firstCard.getAttribute('aria-current')==='page' &&
        firstCard.querySelector('.doc-page-preview').dataset.ready==='true' && firstImg?.naturalWidth>0 &&
        pagesUI.cache.size<=8,
        {card:!!firstCard,current:firstCard?.getAttribute('aria-current'),ready:firstCard?.querySelector('.doc-page-preview')?.dataset.ready,
          imageSize:firstImg?{width:firstImg.naturalWidth,height:firstImg.naturalHeight}:null,cacheSize:pagesUI.cache.size});

      const originalTextObject=paper.getState().objects.find(object=>object.id===textId);
      const originalRich=structuredClone(originalTextObject.rich);
      const imeStateSnapshot=()=>JSON.stringify({document:paper.getState(),mechanism:app.controller.model.cloneState(),
        atoms:[...adapter.struct().atoms].map(([id,atom])=>[adapter.uuidOfAtom(id),atom.pp.x,atom.pp.y])});
      const stateBeforeIme=imeStateSnapshot(),historyBeforeIme=ed.historySize(),dirtyBeforeIme=window.__mechDirtyTick||0;
      const oldCache=pagesUI.cache.get(first);
      paper.editText(textId);
      const contentEditor=frame.contentDocument.getElementById('molstudio-document-editor');
      contentEditor.dispatchEvent(new frame.contentWindow.CompositionEvent('compositionstart',{bubbles:true,data:'草'}));
      contentEditor.textContent='IME 未提交草稿';
      contentEditor.dispatchEvent(new frame.contentWindow.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'草'}));
      pagesUI.visualRevision++; pagesUI.refresh();
      await wait(850);
      const previewWhileComposing=await controller.previewPages([first]);
      const draftStillOpen=controller.editor?.composing===true&&contentEditor.isConnected&&contentEditor.textContent==='IME 未提交草稿';
      const committedDuringIme=paper.getState().objects.find(object=>object.id===textId)?.rich?.text;
      const imeCache=pagesUI.cache.get(first);
      const stateAfterIme=imeStateSnapshot(),historyAfterIme=ed.historySize(),dirtyAfterIme=window.__mechDirtyTick||0;
      check('visible thumbnails refresh during IME composition without committing the text draft',
        draftStillOpen&&committedDuringIme===originalRich.text&&previewWhileComposing.ok&&
        previewWhileComposing.pages[0]?.svg.includes(originalRich.text)&&!previewWhileComposing.pages[0]?.svg.includes('IME 未提交草稿')&&
        imeCache?.signature===pagesUI.signature&&(!oldCache||imeCache?.signature!==oldCache.signature)&&
        stateAfterIme===stateBeforeIme&&JSON.stringify(historyAfterIme)===JSON.stringify(historyBeforeIme)&&dirtyAfterIme===dirtyBeforeIme,
        {draftStillOpen,committedDuringIme,previewOldText:previewWhileComposing.pages[0]?.svg.includes(originalRich.text),
          previewIncludesDraft:previewWhileComposing.pages[0]?.svg.includes('IME 未提交草稿'),cacheUpdated:imeCache?.signature===pagesUI.signature,
          historyBeforeIme,historyAfterIme,dirtyBeforeIme,dirtyAfterIme,stateUnchanged:stateAfterIme===stateBeforeIme});
      paper.finishTextEdit(true);

      const cachedBeforeEdit=pagesUI.cache.get(first);
      paper.updateObject(textId,{rich:{...originalRich,text:'Updated thumbnail text'}});
      await wait(850);
      const refreshedPreview=await controller.previewPages([first]);
      const cachedAfterEdit=pagesUI.cache.get(first);
      check('editing a document text object invalidates and refreshes its visible page thumbnail',
        refreshedPreview.ok&&refreshedPreview.pages[0]?.svg.includes('Updated thumbnail text')&&
        cachedAfterEdit?.signature===pagesUI.signature&&(!cachedBeforeEdit||cachedAfterEdit?.signature!==cachedBeforeEdit.signature),
        {previewUpdated:refreshedPreview.pages[0]?.svg.includes('Updated thumbnail text'),
          cacheUpdated:cachedAfterEdit?.signature===pagesUI.signature,cacheSize:pagesUI.cache.size});
      paper.updateObject(textId,{rich:originalRich});
      await wait(650);

      const originalShape=paper.getState().objects.find(object=>object.id===shapeId);
      const shapeBefore=structuredClone(originalShape),shapeCacheBefore=pagesUI.cache.get(first);
      paper.updateObject(shapeId,{fill:'#fda4af'});
      await wait(850);
      const shapePreview=await controller.previewPages([first]);
      const shapeAfter=paper.getState().objects.find(object=>object.id===shapeId),shapeCacheAfter=pagesUI.cache.get(first);
      const styleOnlyShapeChange=JSON.stringify({...shapeBefore,fill:undefined})===JSON.stringify({...shapeAfter,fill:undefined});
      check('a shape fill edit changes the visible thumbnail cache signature and SVG preview',
        shapePreview.ok&&shapePreview.pages[0]?.svg.includes('#fda4af')&&styleOnlyShapeChange&&
        shapeCacheAfter?.signature===pagesUI.signature&&(!shapeCacheBefore||shapeCacheAfter?.signature!==shapeCacheBefore.signature),
        {previewHasNewFill:shapePreview.pages[0]?.svg.includes('#fda4af'),styleOnlyShapeChange,
          cacheSignatureChanged:!shapeCacheBefore||shapeCacheAfter?.signature!==shapeCacheBefore.signature});
      paper.updateObject(shapeId,{fill:shapeBefore.fill});
      await wait(650);

      const sourceBeforeView=await k3dAPI.serializeWorkbench();
      const historyBeforeView=ed.historySize(),dirtyBeforeView=window.__mechDirtyTick||0;
      const toggle=hostDoc.querySelector('#molstudio-document-pages [data-doc-action="toggle-pages"]');
      toggle.click(); await wait(80);
      const collapsed=pagesUI.collapsed===true && pagesUI.root.dataset.collapsed==='true';
      toggle.click(); await wait(220);
      hostDoc.querySelector('#molstudio-document-status [data-doc-action="paper-zoom-100"]').click();
      await wait(100);
      const zoom100=paper.getPaperZoom();
      const zoomInput=hostDoc.querySelector('#molstudio-document-status [data-doc-action="paper-zoom"]');
      zoomInput.value='125'; zoomInput.dispatchEvent(new Event('change',{bubbles:true})); await wait(100);
      const zoom125=paper.getPaperZoom();
      zoomInput.value='100'; zoomInput.dispatchEvent(new Event('change',{bubbles:true})); await wait(100);
      hostDoc.querySelector('#molstudio-document-status [data-doc-action="fit-width"]').click(); await wait(150);
      const panelButton=hostDoc.querySelector('#molstudio-document-toolbar [data-doc-action="page-setup"]');
      panelButton.click(); await wait(120);
      hostDoc.querySelector('#molstudio-document-status [data-doc-action="fit-width"]').click(); await wait(180);
      const pageContent=frame.contentDocument.querySelector('[data-page-content="'+first+'"]')?.getBoundingClientRect();
      const frameRect=frame.getBoundingClientRect(),sidebarRect=pagesUI.root.getBoundingClientRect();
      const panel=hostDoc.getElementById('molstudio-document-panel'),panelRect=panel.getBoundingClientRect();
      const contentHost=pageContent&&{left:frameRect.left+pageContent.left,right:frameRect.left+pageContent.right,
        top:frameRect.top+pageContent.top,bottom:frameRect.top+pageContent.bottom};
      const noSidebarCover=!!contentHost && !(contentHost.left<sidebarRect.right&&contentHost.right>sidebarRect.left&&
        contentHost.top<sidebarRect.bottom&&contentHost.bottom>sidebarRect.top);
      const noPanelCover=!!contentHost && !(contentHost.left<panelRect.right&&contentHost.right>panelRect.left&&
        contentHost.top<panelRect.bottom&&contentHost.bottom>panelRect.top);
      const viewSourceAfter=await k3dAPI.serializeWorkbench(),historyAfterView=ed.historySize(),dirtyAfterView=window.__mechDirtyTick||0;
      const insets={...controller.paperViewportInsets};
      check('collapsing the sidebar, paper zoom controls and fit commands are view-only',
        collapsed && Math.abs(zoom100-100)<1 && Math.abs(zoom125-125)<1 &&
        viewSourceAfter===sourceBeforeView && JSON.stringify(historyAfterView)===JSON.stringify(historyBeforeView) && dirtyAfterView===dirtyBeforeView,
        {collapsed,zoom100,zoom125,historyBeforeView,historyAfterView,dirtyBeforeView,dirtyAfterView,
          sourceUnchanged:viewSourceAfter===sourceBeforeView,insets});
      check('fit width keeps page content outside the expanded thumbnail and settings panels',
        insets.left>=140 && insets.right>=100 && noSidebarCover && noPanelCover,
        {insets,contentHost,sidebarRect:{left:sidebarRect.left,right:sidebarRect.right,top:sidebarRect.top,bottom:sidebarRect.bottom},
          panelRect:{left:panelRect.left,right:panelRect.right,top:panelRect.top,bottom:panelRect.bottom},noSidebarCover,noPanelCover});

      const lastPageDelete=panel.querySelector('button');
      const deleteButton=[...panel.querySelectorAll('button')].find(button=>button.textContent==='删除空白末页');
      check('the UI keeps deleting the only remaining page disabled',deleteButton?.disabled===true,
        {deleteButton:!!deleteButton,disabled:deleteButton?.disabled});
      const pageContentSnapshot=()=>JSON.stringify({
        objects:paper.getState().objects.map(({id,x,y,w,h,pageId})=>({id,x,y,w,h,pageId})),
        atoms:[...adapter.struct().atoms].map(([id,atom])=>[adapter.uuidOfAtom(id),atom.pp.x,atom.pp.y]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
        arrows:app.controller.model.state.arrows.map(arrow=>({id:arrow.id,source:arrow.source,target:arrow.target,control:arrow.control}))
      });
      const beforeMarginContent=pageContentSnapshot();
      const topMargin=panel.querySelector('[data-doc-margin="top"]');
      const initialMargin=paper.getState().page.margins.top;
      topMargin.value='18.5'; topMargin.dispatchEvent(new Event('change',{bubbles:true}));
      const changedMargin=paper.getState().page.margins.top;
      topMargin.value='20.0'; topMargin.dispatchEvent(new Event('change',{bubbles:true}));
      const restoredMargin=paper.getState().page.margins.top;
      const afterMarginContent=pageContentSnapshot();
      check('page setup accepts millimetres and converts them to model points',
        Math.abs(changedMargin-18.5*72/25.4)<1e-6 && Math.abs(restoredMargin-20*72/25.4)<1e-6 &&
        Math.abs(initialMargin-56.7)<.01 && beforeMarginContent===afterMarginContent,
        {initialMargin,changedMargin,restoredMargin,expected18_5:18.5*72/25.4,expected20:20*72/25.4,
          paperContentCoordinatesStable:beforeMarginContent===afterMarginContent});
      panel.querySelector('[aria-label="关闭属性面板"]').click();

      const beforePages=paper.getState().pages.map(page=>page.id);
      const extraPages=[];
      for(let i=0;i<9;i++) extraPages.push(paper.addPage());
      await wait(750);
      pagesUI.list.scrollTop=pagesUI.list.scrollHeight;
      pagesUI.list.dispatchEvent(new Event('scroll'));
      await wait(750);
      const pages=paper.getState().pages.map(page=>page.id);
      const pageCards=[...pagesUI.list.querySelectorAll('[data-page-id]')];
      const requestedVisible=previewCalls.length>0&&previewCalls.every(call=>call.requested.every(id=>call.visible.includes(id)));
      check('page thumbnails preserve stable model order and render only requested visible pages',
        pages.length===10 && pages[0]===first && extraPages.every((id,i)=>pages[i+1]===id) &&
        pageCards.length===10 && pageCards.every((card,i)=>card.dataset.pageId===pages[i]&&Number(card.dataset.pageIndex)===i) && requestedVisible,
        {pageCount:pages.length,requestedVisible,previewCalls,visible:[...pagesUI.visibleIds],cacheSize:pagesUI.cache.size});
      check('thumbnail preview cache stays bounded while navigating a ten-page document',pagesUI.cache.size<=8,
        {cacheSize:pagesUI.cache.size,limit:8,visible:[...pagesUI.visibleIds]});

      const lastId=pages.at(-1),lastCard=hostDoc.querySelector('#molstudio-document-pages [data-page-id="'+lastId+'"]');
      const listRect=pagesUI.list.getBoundingClientRect(),lastRect=lastCard.getBoundingClientRect();
      const lastVisible=lastRect.bottom>listRect.top&&lastRect.top<listRect.bottom;
      lastCard.click(); await wait(120);
      check('clicking a visible thumbnail navigates the canvas to its stable page id',
        lastVisible && paper.getActivePage().id===lastId && lastCard.getAttribute('aria-current')==='page',
        {lastId,lastVisible,activePage:paper.getActivePage().id,ariaCurrent:lastCard.getAttribute('aria-current'),
          cardRect:{top:lastRect.top,bottom:lastRect.bottom},listRect:{top:listRect.top,bottom:listRect.bottom}});

      for(const id of [...extraPages].reverse()) paper.removePage(id);
      paper.select([]); paper.fitPage(first); pagesUI.list.scrollTop=0; pagesUI.list.dispatchEvent(new Event('scroll'));
      await wait(750);
      const pagesAfter=paper.getState().pages.map(page=>page.id);
      const finalCard=hostDoc.querySelector('#molstudio-document-pages [data-page-id="'+first+'"]');
      const finalPreviewReady=finalCard?.querySelector('.doc-page-preview').dataset.ready==='true'&&finalCard.querySelector('img')?.naturalWidth>0;
      const exported=await paper.exportPages([first]);
      const exportOk=exported.ok&&exported.pages.length===1&&exported.pages[0].widthPt===595.28&&
        exported.pages[0].heightPt===841.89&&exported.pages[0].svg.includes('Paper page preview');
      check('after removing only blank final pages, export remains one unchanged A4 paper page',
        pagesAfter.length===1&&pagesAfter[0]===first&&exportOk,
        {pagesAfter,export:{ok:exported.ok,count:exported.pages?.length,width:exported.pages?.[0]?.widthPt,
          height:exported.pages?.[0]?.heightPt,hasText:exported.pages?.[0]?.svg.includes('Paper page preview')}});
      check('the visible thumbnail refreshes after returning from the end of the document',finalPreviewReady,
        {ready:finalPreviewReady,cacheSize:pagesUI.cache.size,visible:[...pagesUI.visibleIds]});

      paper.setPageSetup({mode:'canvas'}); await wait(80);
      const canvasModeZoomDisplay=getComputedStyle(nativeZoomButton).display;
      const otherToolbarVisibilityCanvas=otherNativeToolbarButtons.map(button=>({testId:button.dataset.testid,display:getComputedStyle(button).display}));
      paper.setPageSetup({mode:'paper'}); await wait(80);
      const paperModeZoomDisplay=getComputedStyle(nativeZoomButton).display;
      const otherToolbarVisibilityPaper=otherNativeToolbarButtons.map(button=>({testId:button.dataset.testid,display:getComputedStyle(button).display}));
      check('switching between paper and canvas toggles only Ketcher zoom; settings and fullscreen remain visible',
        canvasModeZoomDisplay!=='none'&&paperModeZoomDisplay==='none'&&
        JSON.stringify(otherToolbarVisibilityCanvas)===JSON.stringify(otherToolbarVisibilityPaper)&&
        JSON.stringify(otherToolbarVisibilityBefore)===JSON.stringify(otherToolbarVisibilityPaper),
        {canvasModeZoomDisplay,paperModeZoomDisplay,otherToolbarVisibilityBefore,otherToolbarVisibilityCanvas,otherToolbarVisibilityPaper});

      paper.fitPage(first); pagesUI.setCollapsed(false); panel.hidden=true; pagesUI.updateViewportInsets();
      await wait(2700);
      return {checks,previewCalls,source:await k3dAPI.serializeWorkbench(),pageId:first,textId,shapeId,
        zoom:paper.getPaperZoom(),cacheSize:pagesUI.cache.size,nativeZoomCandidates,nativeToolbarTestNodes};
    })()`);
    report.checks = result.checks;
    report.artifacts.previewCalls = result.previewCalls;
    report.artifacts.finalPageId = result.pageId;
    report.artifacts.finalPaperZoom = result.zoom;
    report.artifacts.finalThumbnailCacheSize = result.cacheSize;
    report.artifacts.nativeZoomCandidates = result.nativeZoomCandidates;
    report.artifacts.nativeToolbarTestNodes = result.nativeToolbarTestNodes;
    const stageImport = includeMolecule => js(`(async()=>{
      const app=MolWorkbench.app,ui=app.documentUI,controller=app.documentController;
      const includeMolecule=${JSON.stringify(includeMolecule!==false)};
      ui.showPageSetup();
      const importButton=document.querySelector('#molstudio-document-panel [data-doc-action="import-file"]');
      if(!importButton) return {ok:false,error:'插入文件入口不存在'};
      const importedFixture=JSON.parse(${JSON.stringify(fixture)});
      const doc=MolWorkbench.documentModel.createDocument({mode:'paper'});
      doc.objects.push({id:'ui-import-note',kind:'text',band:'front',x:8,y:18,w:18,h:3,rotation:0,
        rich:{text:'UI imported note',fontFamily:'Arial, PingFang SC, sans-serif',fontSize:12,color:'#1c1c1e',lineHeight:1.4,align:'left'}});
      const workbench=MolWorkbench.storage.serializeWorkbench({ket:includeMolecule?importedFixture.ket:
        {ket_version:'2.0.0',root:{nodes:[],connections:[],templates:[]}},
        bindings:includeMolecule?importedFixture.bindings:{atoms:[],bonds:[]},
        mechanism:includeMolecule?importedFixture.mechanism:MolWorkbench.model.emptyState(),document:doc});
      window.__documentPagesImportBaseline=await k3dAPI.serializeWorkbench();
      window.__documentPagesImportHistory=app.adapter.ed.historySize();
      window.__documentPagesImportStageAtoms=app.adapter.struct().atoms.size;
      window.__documentPagesImportStageArrows=app.controller.model.state.arrows.length;
      window.__documentPagesImportStageLonePairs=app.controller.model.state.lonePairs.length;
      const proto=HTMLInputElement.prototype,originalClick=proto.click;
      proto.click=function(){if(this.dataset.docFileInput==='import'){window.__documentPagesImportInput=this;return;}return originalClick.apply(this,arguments);};
      importButton.click(); proto.click=originalClick;
      const input=window.__documentPagesImportInput;
      if(!input) return {ok:false,error:'未创建文件选择控件'};
      const transfer=new DataTransfer(),file=new File([workbench],'ui-import.molwork',{type:'application/json'});
      transfer.items.add(file); input.files=transfer.files;
      const accept=input.accept; input.dispatchEvent(new Event('change',{bubbles:true}));
      const result=await ui.lastImportPromise;
      const frame=document.getElementById('k'),point=MolStudio.document.modelToClient({x:20,y:40});
      const area=app.adapter.ed.render.clientArea.getBoundingClientRect(),frameRect=frame.getBoundingClientRect();
      const visible=point.x>=frameRect.left+area.left&&point.x<=frameRect.left+area.right&&
        point.y>=frameRect.top+area.top&&point.y<=frameRect.top+area.bottom;
      return {ok:!!result?.ok,accept,fileName:file.name,result,visible,point,
        stagedPreview:!!controller.mechanism.pastePreview||!!controller.mechanism.nativePasteSession,
        pastePreview:!!controller.mechanism.pastePreview,nativePasteSession:!!controller.mechanism.nativePasteSession,
        baselineObjects:JSON.parse(window.__documentPagesImportBaseline).document.objects.length,
        baselineHistory:window.__documentPagesImportHistory,
        baselineAtoms:app.adapter.struct().atoms.size,baselineArrows:app.controller.model.state.arrows.length,
        baselineLonePairs:app.controller.model.state.lonePairs.length};
    })()`);
    const importStage = await stageImport(true);
    if (importStage.ok && importStage.visible && importStage.stagedPreview) {
      const point={x:Math.round(importStage.point.x),y:Math.round(importStage.point.y)};
      win.webContents.sendInputEvent({type:'mouseMove',...point}); await wait(100);
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await wait(220);
    }
    const placedImport=await js(`(async()=>{
      const app=MolWorkbench.app,controller=app.documentController,paper=MolStudio.document;
      const source=await k3dAPI.serializeWorkbench(),json=JSON.parse(source),baseline=JSON.parse(window.__documentPagesImportBaseline);
      const object=json.document.objects.find(item=>item.rich?.text==='UI imported note');
      const details={object:object&&{id:object.id,pageId:object.pageId,x:object.x,y:object.y},
        objectCount:json.document.objects.length,atomCount:app.adapter.struct().atoms.size,
        history:app.adapter.ed.historySize(),pastePreview:!!app.controller.pastePreview,nativePasteSession:!!app.controller.nativePasteSession,
        arrows:app.controller.model.state.arrows.length,lonePairs:app.controller.model.state.lonePairs.length,
        sourceChanged:source!==window.__documentPagesImportBaseline,
        baselineObjects:baseline.document.objects.length,baselineAtoms:window.__documentPagesImportStageAtoms,
        baselineHistory:window.__documentPagesImportHistory,
        baselineArrows:window.__documentPagesImportStageArrows,baselineLonePairs:window.__documentPagesImportStageLonePairs};
      details.pass=!!object&&details.objectCount===details.baselineObjects+1&&details.atomCount===details.baselineAtoms+3&&
        details.arrows===details.baselineArrows+2&&details.lonePairs===details.baselineLonePairs+1&&
        !details.pastePreview&&!details.nativePasteSession&&details.history.undo===details.baselineHistory.undo+1&&
        object.pageId===paper.getState().pages[0].id&&details.sourceChanged;
      return details;
    })()`);
    const importPlacedPass=importStage.ok&&importStage.visible&&importStage.stagedPreview&&placedImport.pass;
    report.checks.push({name:'the page settings “插入文件…” control stages a .molwork file and places its objects without replacing the current scene',pass:importPlacedPass,
      detail:{accept:importStage.accept,fileName:importStage.fileName,staged:importStage.result?.staged,counts:importStage.result?.counts,
        visible:importStage.visible,placed:placedImport.object,objectCount:placedImport.objectCount,atomCount:placedImport.atomCount,
        history:placedImport.history,pastePreview:placedImport.pastePreview}});
    if(!importPlacedPass) throw new Error('document file insertion did not stage and place through the current canvas: '+JSON.stringify({importStage,placedImport}));
    await js('k3dAPI.undo()'); await wait(150);
    const importUndo=await js(`(async()=>{const source=await k3dAPI.serializeWorkbench();return {same:source===window.__documentPagesImportBaseline,
      source,history:MolWorkbench.app.adapter.ed.historySize(),pastePreview:!!MolWorkbench.app.controller.pastePreview};})()`);
    const importUndoPass=importUndo.same&&!importUndo.pastePreview;
    report.checks.push({name:'one undo removes the inserted file fragment and restores the existing canvas document',pass:importUndoPass,
      detail:{same:importUndo.same,history:importUndo.history,pastePreview:importUndo.pastePreview}});
    if(!importUndoPass) throw new Error('undo did not restore the pre-insert document');
    const cancelStage=await stageImport(false);
    if(cancelStage.ok&&cancelStage.visible&&cancelStage.stagedPreview){
      const point={x:Math.round(cancelStage.point.x+24),y:Math.round(cancelStage.point.y+15)};
      win.webContents.sendInputEvent({type:'mouseMove',...point}); await wait(80);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'}); await wait(150);
    }
    const importCancel=await js(`(async()=>{const source=await k3dAPI.serializeWorkbench();return {same:source===window.__documentPagesImportBaseline,
      pastePreview:!!MolWorkbench.app.controller.pastePreview,nativePasteSession:!!MolWorkbench.app.controller.nativePasteSession,
      stagedFile:MolWorkbench.app.documentUI.lastImportPromise!=null};})()`);
    const importCancelPass=cancelStage.ok&&cancelStage.stagedPreview&&cancelStage.pastePreview&&importCancel.same&&
      !importCancel.pastePreview&&!importCancel.nativePasteSession;
    report.checks.push({name:'moving the staged file preview and pressing Esc cancels it without changing or replacing the current document',pass:importCancelPass,
      detail:{stage:cancelStage.result?.staged,sourceSame:importCancel.same,pastePreview:importCancel.pastePreview,
        pureDocumentPreview:cancelStage.pastePreview,nativePasteSession:importCancel.nativePasteSession}});
    if(!importCancelPass) throw new Error('Esc did not cancel the staged file insertion');
    await js(`document.querySelector('#molstudio-document-panel [aria-label="关闭属性面板"]')?.click()`);
    const dragPlan=await js(`(()=>{
      const paper=MolStudio.document,controller=MolWorkbench.app.documentController;
      paper.fitPage(${JSON.stringify(result.pageId)});
      const object=paper.getState().objects.find(item=>item.id===${JSON.stringify(result.textId)});
      if(!object) return {ok:false};
      paper.select([object.id]);
      return {ok:true,id:object.id,x:object.x,y:object.y,pageId:object.pageId,
        history:MolWorkbench.app.adapter.ed.historySize(),
        start:controller.modelToClient({x:object.x+.35,y:object.y+.35}),
        end:controller.modelToClient({x:object.x+1.55,y:object.y+.95})};
    })()`);
    if(dragPlan.ok&&[dragPlan.start?.x,dragPlan.start?.y,dragPlan.end?.x,dragPlan.end?.y].every(Number.isFinite)){
      const start={x:Math.round(dragPlan.start.x),y:Math.round(dragPlan.start.y)};
      const end={x:Math.round(dragPlan.end.x),y:Math.round(dragPlan.end.y)};
      win.webContents.sendInputEvent({type:'mouseMove',...start});
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...start});
      for(let step=1;step<=4;step++){
        win.webContents.sendInputEvent({type:'mouseMove',button:'left',
          x:Math.round(start.x+(end.x-start.x)*step/4),y:Math.round(start.y+(end.y-start.y)*step/4)});
        await wait(25);
      }
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...end}); await wait(160);
    }
    const dragAfter=await js(`(()=>{
      const object=MolStudio.document.getState().objects.find(item=>item.id===${JSON.stringify(result.textId)});
      const history=MolWorkbench.app.adapter.ed.historySize();
      return {object:object&&{x:object.x,y:object.y,pageId:object.pageId},history};
    })()`);
    const pageDragPass=dragPlan.ok&&!!dragAfter.object&&Math.abs(dragAfter.object.x-(dragPlan.x+1.2))<.18&&
      Math.abs(dragAfter.object.y-(dragPlan.y+.6))<.18&&dragAfter.object.pageId===dragPlan.pageId&&
      dragAfter.history.undo===dragPlan.history.undo+1;
    report.checks.push({name:'a real canvas drag updates the object while retaining its stable pageId in one history step',pass:pageDragPass,
      detail:{before:{x:dragPlan.x,y:dragPlan.y,pageId:dragPlan.pageId},after:dragAfter.object,history:dragAfter.history,
        expectedHistory:dragPlan.history.undo+1}});
    if(!pageDragPass) throw new Error('drag did not preserve the document object pageId: '+JSON.stringify({dragPlan,dragAfter}));
    await js('k3dAPI.undo()'); await wait(120);
    const dragUndo=await js(`(()=>{const object=MolStudio.document.getState().objects.find(item=>item.id===${JSON.stringify(result.textId)});
      return {x:object?.x,y:object?.y,pageId:object?.pageId,history:MolWorkbench.app.adapter.ed.historySize()};})()`);
    const dragUndoPass=Math.abs(dragUndo.x-dragPlan.x)<1e-8&&Math.abs(dragUndo.y-dragPlan.y)<1e-8&&dragUndo.pageId===dragPlan.pageId;
    report.checks.push({name:'one undo restores the dragged object coordinates and original stable pageId',pass:dragUndoPass,detail:dragUndo});
    if(!dragUndoPass) throw new Error('undo did not restore document object coordinates after drag');
    report.artifacts.editableSample = path.join(out, 'paper-ui-sample.molwork');
    fs.writeFileSync(report.artifacts.editableSample, result.source);
    await wait(120);
    report.artifacts.canvasScreenshot = path.join(out, 'paper-ui-canvas.png');
    fs.writeFileSync(report.artifacts.canvasScreenshot, (await win.capturePage()).toPNG());
    win.setSize(780, 900); await wait(220);
    const narrow = await js(`(async()=>{
      const frame=document.getElementById('k'),frameRect=frame.getBoundingClientRect();
      const pageUI=MolWorkbench.app.documentUI.pagesUI,paper=MolStudio.document,ed=MolWorkbench.app.adapter.ed;
      const beforeDirty=window.__mechDirtyTick||0,beforeHistory=ed.historySize();
      pageUI.setCollapsed(true); paper.fitPage(paper.getState().pages[0].id);
      await new Promise(resolve=>setTimeout(resolve,220));
      const sidebar=pageUI.root.getBoundingClientRect();
      const candidates=[...frame.contentDocument.querySelectorAll('[class*="LeftToolbar-module"]')];
      const tool=candidates.sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height)[0];
      const toolRect=tool?.getBoundingClientRect();
      const overlap=!!toolRect&&sidebar.left<frameRect.left+toolRect.right&&sidebar.right>frameRect.left+toolRect.left&&
        sidebar.top<frameRect.top+toolRect.bottom&&sidebar.bottom>frameRect.top+toolRect.top;
      const docUI=MolWorkbench.app.documentUI;
      docUI.showPageSetup();
      await new Promise(resolve=>setTimeout(resolve,120));
      const settingsPanel=docUI.panel.getBoundingClientRect();
      const panelInsideViewport=settingsPanel.left>=0&&settingsPanel.right<=innerWidth&&settingsPanel.top>=0&&settingsPanel.bottom<=innerHeight;
      docUI.panel.querySelector('[aria-label="关闭属性面板"]').click();
      const settingsPanelClosed=docUI.panel.hidden===true;
      return {width:innerWidth,collapsed:pageUI.collapsed,sidebar:{left:sidebar.left,right:sidebar.right,width:sidebar.width},
        datasetCollapsed:pageUI.root.dataset.collapsed,computedWidth:getComputedStyle(pageUI.root).width,
        inlineWidth:pageUI.root.style.width,hasResponsiveMethod:typeof pageUI.applyResponsiveWidth==='function',
        narrowMedia:matchMedia('(max-width: 800px)').matches,
        chemistryToolbar:toolRect?{left:frameRect.left+toolRect.left,right:frameRect.left+toolRect.right,
          top:frameRect.top+toolRect.top,bottom:frameRect.top+toolRect.bottom}:null,overlap,
        settingsPanel:{left:settingsPanel.left,right:settingsPanel.right,top:settingsPanel.top,bottom:settingsPanel.bottom},
        panelInsideViewport,settingsPanelClosed,
        dirtyBefore:beforeDirty,dirtyAfter:window.__mechDirtyTick||0,historyBefore:beforeHistory,historyAfter:ed.historySize()};
    })()`);
    const narrowPass=narrow.width<=800&&narrow.collapsed&&narrow.sidebar.width<=34&&!narrow.overlap&&
      narrow.panelInsideViewport&&narrow.settingsPanelClosed&&narrow.dirtyBefore===narrow.dirtyAfter&&
      JSON.stringify(narrow.historyBefore)===JSON.stringify(narrow.historyAfter);
    report.checks.push({name:'on a narrow canvas the page sidebar and closable settings panel stay usable without changing document state',pass:narrowPass,detail:narrow});
    if(!narrowPass)throw new Error('narrow sidebar overlaps native chemistry tools or changes document state: '+JSON.stringify(narrow));
    await wait(180);
    report.artifacts.narrowCanvasScreenshot=path.join(out,'paper-ui-canvas-narrow.png');
    fs.writeFileSync(report.artifacts.narrowCanvasScreenshot,(await win.capturePage()).toPNG());
    report.ok = report.checks.every(check => check.pass);
  } catch (error) {
    report.ok = false; report.error = String(error?.stack || error);
    if (win && !win.isDestroyed()) {
      const checks = await win.webContents.executeJavaScript('window.__documentPagesUIChecks || []').catch(() => []);
      if (checks.length > report.checks.length) report.checks = checks;
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try {
        if (!report.artifacts.canvasScreenshot) {
          report.artifacts.failureScreenshot = path.join(out, 'paper-ui-failure.png');
          fs.writeFileSync(report.artifacts.failureScreenshot, (await win.capturePage()).toPNG());
        }
      } catch (error) { report.captureError = String(error?.message || error); }
    }
    report.finishedAt = new Date().toISOString(); report.artifactDirectory = out; writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check=>check.pass).length,
      total: report.checks.length, failures: report.checks.filter(check=>!check.pass), error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch(error => {
  report.ok=false; report.error=String(error?.stack||error); report.finishedAt=new Date().toISOString();
  report.artifactDirectory=out; writeReport(); console.error(report.error); app.exit(1);
});
