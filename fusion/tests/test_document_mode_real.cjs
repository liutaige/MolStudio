'use strict';
// Current canvas paper-mode end-to-end regression. Real Ketcher editor and
// document controller in an isolated Electron window; no model calls.
// Start an isolated service first, then run this file with the same port:
//   MOLSTUDIO_PORT=49075 npm --prefix fusion start
//   MOLSTUDIO_PORT=49075 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
//     MOLSTUDIO_AGENT_TEST_OUT=/absolute/ignored/artifact/path \
//     fusion/node_modules/.bin/electron fusion/tests/test_document_mode_real.cjs

const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49075;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) {
  throw new Error('MOLSTUDIO_PORT must be a valid isolated canvas service port');
}
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT ||
  path.join(__dirname, '../../.jez/artifacts/document-mode-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-mode-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);

const report = {
  application: 'MolStudio current canvas',
  page: 'fusion/canvas.html',
  pageURL: `http://127.0.0.1:${port}/canvas.html`,
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  fixture: 'F01 valid SN2 workbench geometry, single-page A4 mixed objects, then pure-text paper document',
  modelCalls: 0,
  checks: [],
  browserErrors: [],
  artifacts: {},
  startedAt: new Date().toISOString(),
};
let win;
const watchdog = setTimeout(() => {
  report.ok = false;
  report.error = 'Electron regression watchdog expired';
  writeReport();
  win?.destroy();
  app.exit(2);
}, 120_000);

function writeReport() {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  // The trusted native copy probe briefly replaces the OS clipboard. Keep the
  // user's original formats and raw buffers in memory and restore them even if
  // a later assertion fails; clipboard contents are never written to artifacts.
  const originalClipboard=[];
  for(const item of await clipboard.read()){
    const entries=[];
    for(const format of item.types){
      try{
        const value=await item.getType(format);
        entries.push(format==='electron application/bookmark'
          ? {format,bookmark:value}
          : {format,buffer:Buffer.from(await value.arrayBuffer())});
      }catch(_){ }
    }
    if(entries.length)originalClipboard.push(entries);
  }
  let clipboardRestored=false;
  const restoreClipboard=async()=>{
    try{
      clipboard.clear();
      const restoredItems=originalClipboard.map(entries=>new ClipboardItem(Object.fromEntries(entries.map(entry=>[
        entry.format,entry.bookmark||new Blob([entry.buffer],{type:entry.format}),
      ]))));
      if(restoredItems.length)await clipboard.write(restoredItems);
      const restored=await clipboard.read();
      const restoredFormats=restored.flatMap(item=>item.types);
      clipboardRestored=originalClipboard.flatMap(entries=>entries.map(entry=>entry.format))
        .every(format=>restoredFormats.includes(format));
    }catch(_){clipboardRestored=false;}
    return clipboardRestored;
  };
  win = new BrowserWindow({
    show: true,
    width: 1460,
    height: 1160,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) report.browserErrors.push(String(message));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`);
  });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{
      const start=Date.now();
      while(Date.now()-start<45000){
        if(window.k3dAPI?.workbenchReady?.() && window.MolStudio?.document) return true;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return false;
    })()`);
    if (!ready) throw new Error('Current canvas/document controller did not become ready');

    const sn2Fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-mechanism/F01.molwork'), 'utf8');
    const fixtureLoad = await js(`k3dAPI.loadWorkbench(${JSON.stringify(sn2Fixture)})`);
    if (!fixtureLoad?.ok) throw new Error('Valid SN2 fixture failed to load: ' + JSON.stringify(fixtureLoad));

    const resultPromise = js(`(async()=>{
      const checks = window.__documentModeChecks = [];
      const artifacts = window.__documentModeArtifacts = {};
      const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
      const check = (name, pass, detail) => {
        checks.push({name, pass:!!pass, ...(detail===undefined?{}:{detail})});
        if (!pass) throw new Error(name);
      };
      const canonical = value => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') return Object.fromEntries(
          Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
        return value;
      };
      const stable = value => JSON.stringify(canonical(value));
      const editor = MolWorkbench.app.adapter.ed;
      const adapter = MolWorkbench.app.adapter;
      const model = MolWorkbench.app.model;
      const paper = MolStudio.document;
      const countAtoms = workbench => Object.values(workbench.ket || {})
        .filter(value=>value?.type==='molecule')
        .reduce((total,molecule)=>total+(molecule.atoms||[]).length,0);

      // The source is the editable hydroxide + methyl bromide SN2 scene,
      // with its two bound electron-flow arrows, not a synthetic invalid molecule.
      paper.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      await wait(100);
      const initialDocument = paper.getState();
      const initialRects = MolWorkbench.documentModel.pageRects(initialDocument);
      const page = initialRects[0];
      const close = (a,b,t=0.02) => Math.abs(a-b)<t;
      check('paper mode initializes one portrait A4 page at 14.4 pt per bond',
        initialDocument.mode==='paper' && initialDocument.page.size==='A4' &&
        initialDocument.page.orientation==='portrait' && initialDocument.pageCount===1 &&
        close(initialDocument.page.width,595.28) && close(initialDocument.page.height,841.89) &&
        close(initialDocument.ptPerBond,14.4) && page && close(page.w,595.28/14.4) &&
        close(page.h,841.89/14.4), {document:initialDocument,page});

      const svg = adapter.canvasSvg();
      const pageLayer = svg?.querySelector('#molstudio-page-layer');
      const pageNode = pageLayer?.querySelector('[data-page-id="'+page.id+'"]');
      check('the A4 boundary is rendered in the current canvas SVG behind the chemistry',
        !!pageLayer && svg.firstElementChild===pageLayer && !!pageNode &&
        Number(pageNode.getAttribute('width'))>0 && Number(pageNode.getAttribute('height'))>0,
        {pageId:page.id,firstChild:svg.firstElementChild?.id,pageNode:pageNode?.outerHTML?.slice(0,600)});

      await wait(180);
      const layerStability = await new Promise(resolve=>{
        const before=[...svg.children].map(node=>node.id);
        let mutations=0;
        const observer=new MutationObserver(records=>{mutations+=records.length;});
        observer.observe(svg,{childList:true});
        setTimeout(()=>{observer.disconnect();resolve({mutations,before,after:[...svg.children].map(node=>node.id)});},200);
      });
      check('document layer rendering settles without repeated top-level SVG reordering',
        layerStability.mutations===0 && stable(layerStability.before)===stable(layerStability.after),layerStability);

      // Edit actual Ketcher atom and bond properties in the live structure.
      adapter.syncIdentity();
      const structure = adapter.struct();
      const atomEntries = Array.from(structure.atoms.entries());
      const oxygenEntry = atomEntries.find(([,atom])=>atom.label==='O');
      const carbonEntry = atomEntries.find(([,atom])=>atom.label==='C');
      const bromineEntry = atomEntries.find(([,atom])=>atom.label==='Br');
      const carbonBromineBond = Array.from(structure.bonds.entries()).find(([,bond])=>
        (structure.atoms.get(bond.begin)?.label==='C' && structure.atoms.get(bond.end)?.label==='Br') ||
        (structure.atoms.get(bond.end)?.label==='C' && structure.atoms.get(bond.begin)?.label==='Br'));
      if (!oxygenEntry || !carbonEntry || !bromineEntry || !carbonBromineBond) throw new Error('F01 SN2 fixture did not contain hydroxide and C-Br');
      const [oxygenId, oxygen] = oxygenEntry;
      const [carbonId] = carbonEntry;
      const [bromineId, bromine] = bromineEntry;
      const oxygenUUID = adapter.uuidOfAtom(oxygenId);
      const carbonUUID = adapter.uuidOfAtom(carbonId);
      const bromineUUID = adapter.uuidOfAtom(bromineId);
      const [bondId, cbBond] = carbonBromineBond;
      const bondUUID = adapter.uuidOfBond(bondId);
      // Put the known-valid SN2 sketch on this paper before the geometry edit;
      // the fixture's original workbench coordinates sit above y=0.
      for (const atom of structure.atoms.values()) { atom.pp.x += 4; atom.pp.y += 15; }
      const carbonPos = adapter.atomPos(carbonId), brominePos = adapter.atomPos(bromineId);
      const bondLength = Math.hypot(brominePos.x-carbonPos.x,brominePos.y-carbonPos.y);
      const angle = Math.atan2(brominePos.y-carbonPos.y,brominePos.x-carbonPos.x)+0.14;
      bromine.pp.x = carbonPos.x + bondLength*Math.cos(angle);
      bromine.pp.y = carbonPos.y + bondLength*Math.sin(angle);
      const bondArrow = model.state.arrows.find(item=>item.source.type==='bond' && item.source.bondId===bondUUID);
      if (!bondArrow) throw new Error('F01 SN2 C-Br electron-flow arrow was not restored');
      const previousBend = bondArrow.geometry?.bend || 0;
      bondArrow.geometry.bend = previousBend + 0.08;
      editor.update(true);
      MolWorkbench.app.controller.render();
      await wait(100);
      const bromineAfter = adapter.atomPos(bromineId);
      const editedBond = structure.bonds.get(bondId);
      const chemistrySnapshot = JSON.parse(await k3dAPI.serializeWorkbench());
      const chemistryMolecules = Object.values(chemistrySnapshot.ket || {}).filter(value=>value?.type==='molecule');
      const editedOxygen = chemistryMolecules.flatMap(molecule=>molecule.atoms||[]).find(atom=>atom.label==='O');
      const editedBromine = chemistryMolecules.flatMap(molecule=>molecule.atoms||[]).find(atom=>atom.label==='Br');
      const editedCBond = chemistryMolecules.flatMap(molecule=>molecule.bonds||[]).find(bond=>bond.type===1);
      const attackArrow = chemistrySnapshot.mechanism?.arrows?.find(item=>item.source.type==='lonePair');
      const expulsionArrow = chemistrySnapshot.mechanism?.arrows?.find(item=>item.source.type==='bond');
      check('direct atom/bond geometry and valid SN2 electron-flow edits persist in the mixed workbench',
        chemistrySnapshot.version===2 && editedOxygen?.charge===-1 && editedBromine && editedCBond &&
        editedBromine.location?.[0]!==brominePos.x && editedBromine.location?.[1]!==brominePos.y &&
        close(Math.hypot(bromineAfter.x-carbonPos.x,bromineAfter.y-carbonPos.y),bondLength,1e-6) &&
        expulsionArrow?.source?.bondId===bondUUID && expulsionArrow?.target?.atomId===bromineUUID &&
        expulsionArrow?.geometry?.bend===previousBend+0.08 && attackArrow?.target?.type==='formingBond' &&
        chemistrySnapshot.mechanism?.lonePairs?.length===1 && chemistrySnapshot.mechanism?.arrows?.length===2 &&
        countAtoms(chemistrySnapshot)===3,
        {version:chemistrySnapshot.version,oxygen:editedOxygen,bromine:editedBromine,bond:editedCBond,
          bondLengthBefore:bondLength,bondLengthAfter:Math.hypot(bromineAfter.x-carbonPos.x,bromineAfter.y-carbonPos.y),
          attackArrow,expulsionArrow,lonePairs:chemistrySnapshot.mechanism?.lonePairs?.length,
          arrows:chemistrySnapshot.mechanism?.arrows?.length});

      // Insert every supported document object kind into the same coordinate
      // space. The image is generated by canvas, so the fixture stays self-contained.
      const textId = paper.addText({x:12,y:12,w:16,h:2.5,text:'Paper canvas note'});
      const shapeId = paper.addShape({x:12,y:17,w:5,h:3,shape:'rect',stroke:{color:'#1d4ed8',width:0.12},fill:'#dbeafe'});
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width=2; imageCanvas.height=2;
      const imageContext=imageCanvas.getContext('2d');
      imageContext.fillStyle='#c2410c'; imageContext.fillRect(0,0,1,2);
      imageContext.fillStyle='#0f766e'; imageContext.fillRect(1,0,1,2);
      const imageId = await paper.addImage({dataUrl:imageCanvas.toDataURL('image/png'),x:19,y:17,w:3,h:3});
      await wait(100);
      const withObjects = paper.getState();
      const objectsById = new Map(withObjects.objects.map(item=>[item.id,item]));
      const textNode = svg.querySelector('[data-doc-id="'+textId+'"] text');
      const shapeNode = svg.querySelector('[data-doc-id="'+shapeId+'"] rect');
      const imageNode = svg.querySelector('[data-doc-id="'+imageId+'"] image');
      const imageHref = imageNode?.getAttribute('href') || imageNode?.getAttributeNS('http://www.w3.org/1999/xlink','href') || '';
      check('text, image, and shape insert as editable objects in the page coordinate system',
        typeof textId==='string' && typeof shapeId==='string' && typeof imageId==='string' &&
        objectsById.get(textId)?.kind==='text' && objectsById.get(textId)?.rich?.text==='Paper canvas note' &&
        objectsById.get(shapeId)?.kind==='shape' && objectsById.get(shapeId)?.shape==='rect' &&
        objectsById.get(imageId)?.kind==='image' && !!withObjects.assets?.[objectsById.get(imageId)?.asset] &&
        textNode?.textContent?.includes('Paper canvas note') && !!shapeNode && imageHref.startsWith('data:image/png;base64,'),
        {textId,shapeId,imageId,objects:withObjects.objects,assetCount:Object.keys(withObjects.assets||{}).length,
          rendered:{text:!!textNode,shape:!!shapeNode,image:!!imageNode,imageHrefPrefix:imageHref.slice(0,32)}});

      // Exercise the real iframe clipboard handlers with a browser DataTransfer.
      // Ketcher must provide the chemical MIME data while the workbench appends
      // its identity sidecar for the selected lone pair and paper objects.
      paper.fitPage();
      paper.selectAll();
      const frame=document.getElementById('k'), frameWindow=frame.contentWindow, frameDoc=frame.contentDocument;
      const cliparea=frameDoc.querySelector('[data-cliparea="true"]');
      editor.focusCliparea();
      window.__documentModeClipboardReady=true;
      const clipboardRecords=await new Promise(resolve=>{window.__documentModeClipboardResolve=resolve;});
      const transfer=new frameWindow.DataTransfer();
      for(const record of clipboardRecords.records||[]){try{transfer.setData(record.format,record.value);}catch(error){}}
      const clipboardTypes=clipboardRecords.formats||[];
      const sidecarText=transfer.getData('application/x-molstudio-mechanism');
      let sidecar=null; try { sidecar=JSON.parse(sidecarText); } catch (_) { }
      const nativeClipboardTypes=clipboardTypes.filter(type=>type!=='application/x-molstudio-mechanism');
      check('real iframe DOM copy keeps native chemistry and appends LP plus document sidecar',
        sidecar?.native===true && sidecar.identity?.lonePairs?.length===1 &&
        sidecar.document?.objects?.length===3 && sidecar.document?.objects.some(item=>item.kind==='image') &&
        clipboardTypes.includes('application/x-molstudio-mechanism') && nativeClipboardTypes.length>0 &&
        clipboardRecords.preferEvents===true,
        {clipboardTypes,nativeClipboardTypes,clipboardCaptureValid:clipboardRecords.valid,
          trusted:clipboardRecords.trusted,copyDefaultPrevented:clipboardRecords.defaultPrevented,
          preferEvents:clipboardRecords.preferEvents,
          identityLonePairs:sidecar?.identity?.lonePairs?.length,documentObjects:sidecar?.document?.objects?.map(item=>item.kind),
          atoms:sidecar?.identity?.atoms?.length,bonds:sidecar?.identity?.bonds?.length});

      // Send that same transfer through the actual iframe paste event and put
      // the native preview down with host mouse events. This checks the exact
      // native atom remap + shared undo path, without fabricating a commit.
      const clipboardBaseline=await k3dAPI.serializeWorkbench();
      const clipboardHistoryBefore=editor.historySize();
      const copiedTransferTypes=[...transfer.types];
      window.__documentModeSelectionTool=frameWindow.ketcher.editor.tool();
      const pasteEvent=new frameWindow.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});
      cliparea.dispatchEvent(pasteEvent);
      const pasteToolWaitStart=Date.now();
      while(Date.now()-pasteToolWaitStart<8000 &&
          frameWindow.ketcher.editor.tool()===window.__documentModeSelectionTool) await wait(50);
      const activePasteTool=frameWindow.ketcher.editor.tool();
      const pasteSession=MolWorkbench.app.controller.nativePasteSession;
      const pasteState={token:frameWindow.molstudioClipboard?.nativePasteToken?.()||null,
        sessionToken:pasteSession?.token||null,sessionActive:!!pasteSession?.active,
        pasteDefaultPrevented:pasteEvent.defaultPrevented,toolChanged:activePasteTool!==window.__documentModeSelectionTool,
        copiedTransferTypes};
      check('native paste dispatch stages the copied mixed fragment for Ketcher placement',
        !!pasteState.token && pasteState.token===pasteState.sessionToken && !!pasteSession && pasteState.toolChanged,pasteState);
      const pasteTarget=paper.modelToClient({x:30,y:44});
      const clientArea=editor.render.clientArea.getBoundingClientRect();
      const frameRect=frame.getBoundingClientRect();
      const pasteCanvas={left:frameRect.left+clientArea.left,top:frameRect.top+clientArea.top,
        right:frameRect.left+clientArea.right,bottom:frameRect.top+clientArea.bottom};
      const pasteVisible=pasteTarget.x>=pasteCanvas.left&&pasteTarget.x<=pasteCanvas.right&&
        pasteTarget.y>=pasteCanvas.top&&pasteTarget.y<=pasteCanvas.bottom;
      check('native paste target is inside the visible current canvas viewport',pasteVisible,
        {pasteTarget,pasteCanvas,modelPoint:{x:30,y:44}});
      window.__documentModePastePreviewCheck=()=>{
        const session=MolWorkbench.app.controller.nativePasteSession;
        const detail={active:!!session?.active,token:session?.token||null,expectedToken:pasteState.token,
          atomCount:adapter.struct().atoms.size,toolChanged:frameWindow.ketcher.editor.tool()!==window.__documentModeSelectionTool};
        check('real mouse movement activates the native mixed-paste preview before placement',
          detail.active&&detail.token===detail.expectedToken&&detail.toolChanged,detail);
        return detail;
      };
      window.__documentModePasteReady={pasteTarget,pasteVisible,pasteState};
      await new Promise(resolve=>{window.__documentModePasteResolve=resolve;});
      await wait(300);
      const clipboardAfter=await k3dAPI.serializeWorkbench();
      const clipboardAfterJson=JSON.parse(clipboardAfter), clipboardHistoryAfter=editor.historySize();
      check('real native paste adds the copied document, atoms, electron flow and remapped lone pair together',
        clipboardAfter!==clipboardBaseline && clipboardAfterJson.document?.objects?.length===6 &&
        countAtoms(clipboardAfterJson)===6 && clipboardAfterJson.mechanism?.arrows?.length===4 &&
        clipboardAfterJson.mechanism?.lonePairs?.length===2 && clipboardHistoryAfter.undo===clipboardHistoryBefore.undo+1 &&
        !window.MolWorkbench.app.controller.nativePasteSession,
        {historyBefore:clipboardHistoryBefore,historyAfter:clipboardHistoryAfter,
          objects:clipboardAfterJson.document?.objects?.map(item=>item.kind),atoms:countAtoms(clipboardAfterJson),
          arrows:clipboardAfterJson.mechanism?.arrows?.length,lonePairs:clipboardAfterJson.mechanism?.lonePairs?.length,
          nativePasteSession:!!window.MolWorkbench.app.controller.nativePasteSession});
      await k3dAPI.undo(); await wait(120);
      const clipboardUndone=await k3dAPI.serializeWorkbench();
      check('one native paste undo restores its complete mixed clipboard source state',
        stable(JSON.parse(clipboardUndone))===stable(JSON.parse(clipboardBaseline)),
        {history:editor.historySize(),objects:JSON.parse(clipboardUndone).document?.objects?.length,
          arrows:JSON.parse(clipboardUndone).mechanism?.arrows?.length,lonePairs:JSON.parse(clipboardUndone).mechanism?.lonePairs?.length});
      await k3dAPI.redo(); await wait(120);
      const clipboardRedone=JSON.parse(await k3dAPI.serializeWorkbench()),clipboardRedoHistory=editor.historySize();
      const clipboardRedoSummary={objects:clipboardRedone.document?.objects?.map(item=>item.kind),
        textObjects:clipboardRedone.document?.objects?.filter(item=>item.kind==='text').length,
        images:clipboardRedone.document?.objects?.filter(item=>item.kind==='image').length,
        assets:Object.keys(clipboardRedone.document?.assets||{}).length,atoms:countAtoms(clipboardRedone),
        arrows:clipboardRedone.mechanism?.arrows?.length,lonePairs:clipboardRedone.mechanism?.lonePairs?.length,
        history:clipboardRedoHistory,nativePasteSession:!!MolWorkbench.app.controller.nativePasteSession};
      check('one redo restores the complete pasted mixed clipboard fragment',
        clipboardRedoSummary.objects?.length===6 && clipboardRedoSummary.textObjects===2 &&
        clipboardRedoSummary.images===2 && clipboardRedoSummary.assets===2 && clipboardRedoSummary.atoms===6 &&
        clipboardRedoSummary.arrows===4 && clipboardRedoSummary.lonePairs===2 &&
        clipboardRedoHistory.undo===clipboardHistoryBefore.undo+1 && !clipboardRedoSummary.nativePasteSession,
        clipboardRedoSummary);
      await k3dAPI.undo(); await wait(120);

      const agent = k3dAPI.agent;
      const contextWithDocument = await agent.getContext();
      check('AI canvas context includes the current paper page and editable object bounds',
        contextWithDocument.document?.mode==='paper' && contextWithDocument.document.pages?.length===1 &&
        contextWithDocument.document.activePageId===page.id &&
        contextWithDocument.document.pages[0].id===page.id &&
        contextWithDocument.document.objects.some(item=>item.id===textId && item.text==='Paper canvas note') &&
        close(contextWithDocument.document.pages[0].content.w,page.content.w),
        {mode:contextWithDocument.document?.mode,activePageId:contextWithDocument.document?.activePageId,
          pages:contextWithDocument.document?.pages,objects:contextWithDocument.document?.objects});

      // A manual rich-text edit is part of the AI bridge revision signature.
      // An active run must be fenced before it can commit another operation.
      const runId='document-mode-text-edit-fence';
      await agent.beginRun(runId);
      const beforeTextEditContext=await agent.getContext();
      const originalRich=structuredClone(paper.getState().objects.find(item=>item.id===textId).rich);
      paper.updateObject(textId,{rich:{...originalRich,text:'Paper canvas note changed'}});
      const afterTextEditContext=await agent.getContext();
      const afterTextEdit=await k3dAPI.serializeWorkbench();
      const historyAfterTextEdit=editor.historySize();
      let interrupted;
      try {
        await agent.applyOperations([{id:'must-not-land-after-text-edit',type:'molecule.add',smiles:'C'}],{runId});
      } catch (error) { interrupted={code:error.code,message:error.message}; }
      const afterInterruptedAttempt=await k3dAPI.serializeWorkbench();
      check('editing document text advances the canvas revision and invalidates an active AI run',
        afterTextEditContext.revision===beforeTextEditContext.revision+1 &&
        afterTextEditContext.document.objects.some(item=>item.id===textId && item.text==='Paper canvas note changed') &&
        interrupted?.code==='stale_canvas' && afterInterruptedAttempt===afterTextEdit &&
        stable(editor.historySize())===stable(historyAfterTextEdit),
        {beforeRevision:beforeTextEditContext.revision,afterRevision:afterTextEditContext.revision,
          interrupted,historyAfterEdit:historyAfterTextEdit,historyAfterAttempt:editor.historySize()});
      await agent.endRun(runId);
      paper.updateObject(textId,{rich:originalRich});

      // A single auto-placed molecule wider than the printable page must fail
      // as one transaction without leaving partial chemistry or history.
      paper.fitPage();
      const overflowRun='document-mode-paper-overflow';
      await agent.beginRun(overflowRun);
      const overflowBefore=await k3dAPI.serializeWorkbench();
      const overflowHistoryBefore=editor.historySize();
      let overflowFailure;
      try {
        await agent.applyOperations([{id:'paper-too-wide-chain',type:'molecule.add',smiles:'C'.repeat(64)}],{runId:overflowRun});
      } catch (error) { overflowFailure={code:error.code,message:error.message}; }
      const overflowAfter=await k3dAPI.serializeWorkbench();
      const overflowHistoryAfter=editor.historySize();
      check('automatic chemistry that exceeds the active page rolls back content and history',
        overflowFailure?.code==='paper_region_full' && overflowAfter===overflowBefore &&
        stable(overflowHistoryAfter)===stable(overflowHistoryBefore),
        {failure:overflowFailure,historyBefore:overflowHistoryBefore,historyAfter:overflowHistoryAfter,
          snapshotUnchanged:overflowAfter===overflowBefore});
      await agent.endRun(overflowRun);

      // Establish a mixed atom/mechanism/document selection, then use a real
      // Electron pointer drag on the selected text object.
      const allAtomIds = Array.from(adapter.struct().atoms.keys()).map(id=>adapter.uuidOfAtom(id));
      const allMechanismIds = [...model.state.lonePairs.map(item=>item.id),...model.state.arrows.map(item=>item.id)];
      const selectionIds = [...allAtomIds, ...allMechanismIds, textId, shapeId, imageId];
      editor.clearHistory();
      const beforeMove = await k3dAPI.serializeWorkbench();
      const historyBefore = editor.historySize();
      paper.select(selectionIds);
      const selectedMixed = paper.getSelection();
      const beforeText=paper.getState().objects.find(item=>item.id===textId);
      const start=paper.modelToClient({x:beforeText.x+beforeText.w/2,y:beforeText.y+beforeText.h/2});
      const end=paper.modelToClient({x:beforeText.x+beforeText.w/2+1.25,y:beforeText.y+beforeText.h/2+0.75});
      const dragFrameRect=document.getElementById('k').getBoundingClientRect();
      const startModel=adapter.clientToModel({x:Math.round(start.x)-dragFrameRect.left,y:Math.round(start.y)-dragFrameRect.top});
      const endModel=adapter.clientToModel({x:Math.round(end.x)-dragFrameRect.left,y:Math.round(end.y)-dragFrameRect.top});
      const expectedDelta={x:endModel.x-startModel.x,y:endModel.y-startModel.y};
      check('public mixed selection contains chemistry, mechanism, and document objects before pointer drag',
        selectedMixed.objects.includes(textId) && selectedMixed.objects.includes(shapeId) &&
        selectedMixed.mechanism.includes(allMechanismIds[0]) && selectedMixed.atoms.length===allAtomIds.length,
        {selectedMixed,allAtomIds,allMechanismIds});
      artifacts.drag={start,end,expectedDelta};
      return {checks,artifacts,textId,imageId,shapeId,selectionIds,beforeMove,historyBefore,
        expectedDelta,start,end,pageId:page.id};
    })()`);

    const resultEarly=resultPromise.then(()=>({done:true}),error=>({error}));
    let clipboardReady=false;
    const clipboardWaitStarted=Date.now();
    while(Date.now()-clipboardWaitStarted<45000){
      clipboardReady=await js('window.__documentModeClipboardReady===true').catch(()=>false);
      if(clipboardReady)break;
      const early=await Promise.race([resultEarly,wait(50).then(()=>null)]);
      if(early?.error)throw early.error;
      if(early?.done)throw new Error('document regression ended before the real clipboard copy handshake');
    }
    if(!clipboardReady)throw new Error('real clipboard copy handshake timed out');

    // Use Chromium's focused native copy command with a user gesture. The test
    // captures the resulting trusted DOM event after Ketcher's serializer and
    // our sidecar handler have both written their formats.
    win.show(); win.focus(); win.webContents.focus();
    if(process.platform==='darwin')app.focus({steal:true});
    const nativeCopyCapture=await win.webContents.executeJavaScript(`(async()=>{
      const frame=document.getElementById('k'),frameWindow=frame.contentWindow,d=frame.contentDocument;
      const cliparea=d.querySelector('[data-cliparea="true"]');
      frame.focus();cliparea?.focus();
      return await new Promise(resolve=>{
        let settled=false;
        const finish=value=>{if(settled)return;settled=true;resolve(value);};
        d.addEventListener('copy',event=>{
          const clipboardData=event.clipboardData,formats=clipboardData?[...clipboardData.types]:[];
          const records=[];
          for(const format of formats){
            if(!/^(text\\/|application\\/|chemical\\/)/i.test(format))continue;
            try{records.push({format,value:clipboardData.getData(format)});}catch(_){ }
          }
          finish({trusted:event.isTrusted,defaultPrevented:event.defaultPrevented,formats,records,
            preferEvents:frameWindow.molstudioClipboard.preferEvents===true,
            focus:{top:document.activeElement===frame,inner:d.activeElement===cliparea}});
        },{once:true});
        const execCommandResult=d.execCommand('copy');
        setTimeout(()=>finish({trusted:false,timeout:true,execCommandResult,formats:[],records:[],
          preferEvents:frameWindow.molstudioClipboard?.preferEvents===true,
          focus:{top:document.activeElement===frame,inner:d.activeElement===cliparea}}),1500);
      });
    })()`,true);
    const copiedFormats=nativeCopyCapture?.formats||[];
    const clipboardRecords=nativeCopyCapture?.records||[];
    const copiedSidecar=clipboardRecords.find(record=>record.format==='application/x-molstudio-mechanism')?.value||'';
    let copiedPayload=null;try{copiedPayload=JSON.parse(copiedSidecar);}catch(_){ }
    const clipboardCaptureValid=nativeCopyCapture?.trusted===true && copiedPayload?.native===true &&
      copiedPayload.identity?.lonePairs?.length===1 && copiedPayload.document?.objects?.length===3 &&
      copiedPayload.document.objects.some(item=>item.rich?.text==='Paper canvas note') &&
      copiedPayload.document.objects.some(item=>item.kind==='image');
    const clipboardCapture={valid:clipboardCaptureValid,formats:clipboardCaptureValid?copiedFormats:[],
      records:clipboardCaptureValid?clipboardRecords:[],focus:nativeCopyCapture?.focus,
      trusted:nativeCopyCapture?.trusted===true,defaultPrevented:!!nativeCopyCapture?.defaultPrevented,
      preferEvents:nativeCopyCapture?.preferEvents===true};
    await restoreClipboard();
    await js(`window.__documentModeClipboardResolve(${JSON.stringify(clipboardCapture)})`);
    let pasteReady=null;
    const pasteWaitStarted=Date.now();
    while(Date.now()-pasteWaitStarted<15000){
      pasteReady=await js('window.__documentModePasteReady||null').catch(()=>null);
      if(pasteReady)break;
      const early=await Promise.race([resultEarly,wait(50).then(()=>null)]);
      if(early?.error)throw early.error;
      if(early?.done)throw new Error('document regression ended before the native paste placement handshake');
    }
    if(!pasteReady)throw new Error('native paste placement handshake timed out');
    if(!pasteReady.pasteVisible)throw new Error('native paste point is outside the visible canvas');
    const pastePoint={x:Math.round(pasteReady.pasteTarget.x),y:Math.round(pasteReady.pasteTarget.y)};
    win.webContents.sendInputEvent({type:'mouseMove',...pastePoint}); await wait(120);
    report.artifacts.nativePastePreview=await js('window.__documentModePastePreviewCheck()');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...pastePoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...pastePoint});
    await wait(300);
    await js('window.__documentModePasteResolve(true)');
    const result=await resultPromise;
    report.artifacts.osClipboardRestored=clipboardRestored;
    report.artifacts.testClipboardFormats=clipboardCapture.formats;
    report.checks = result.checks || await js('window.__documentModeChecks || []');
    report.artifacts.mixedDrag = result.artifacts?.drag;
    if (![result.start?.x,result.start?.y,result.end?.x,result.end?.y].every(Number.isFinite)) {
      throw new Error('modelToClient did not return host-window drag points');
    }
    const start = { x: Math.round(result.start.x), y: Math.round(result.start.y) };
    const end = { x: Math.round(result.end.x), y: Math.round(result.end.y) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...start });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
    for (let step = 1; step <= 4; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left',
        x: Math.round(start.x + (end.x - start.x) * step / 4),
        y: Math.round(start.y + (end.y - start.y) * step / 4) });
      await wait(30);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end });
    await wait(180);
    const dragResult = await js(`(async()=>{
      const checks=window.__documentModeChecks;
      const stable=value=>JSON.stringify((function sort(x){if(Array.isArray(x))return x.map(sort);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])]));return x})(value));
      const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});if(!pass)throw new Error(name);};
      const paper=MolStudio.document,ed=MolWorkbench.app.adapter.ed,adapter=MolWorkbench.app.adapter;
      const before=${JSON.stringify(result.beforeMove)}, beforeDoc=JSON.parse(before).document;
      const expected=${JSON.stringify(result.expectedDelta)}, historyBefore=${JSON.stringify(result.historyBefore)};
      const after=await k3dAPI.serializeWorkbench(),afterJson=JSON.parse(after),doc=paper.getState(),historyAfter=ed.historySize();
      const moved=new Map(doc.objects.map(item=>[item.id,item]));
      const old=new Map(beforeDoc.objects.map(item=>[item.id,item]));
      const movedText=moved.get('${result.textId}'),oldText=old.get('${result.textId}');
      const movedObjects=['${result.textId}','${result.shapeId}','${result.imageId}'].every(id=>
        Math.abs((moved.get(id)?.x||0)-(old.get(id)?.x||0)-expected.x)<.09 &&
        Math.abs((moved.get(id)?.y||0)-(old.get(id)?.y||0)-expected.y)<.09);
      const selection=paper.getSelection();
      check('a real pointer drag moves selected chemistry and document objects together in one history action',
        stable(JSON.parse(before))!==stable(afterJson) && movedObjects &&
        Math.abs(movedText.x-oldText.x-expected.x)<.09 && Math.abs(movedText.y-oldText.y-expected.y)<.09 &&
        Math.abs(expected.x-1.25)<.12 && Math.abs(expected.y-.75)<.12 &&
        historyAfter.undo===historyBefore.undo+1 && selection.objects.includes('${result.textId}') &&
        selection.atoms.length===${result.selectionIds.filter(id=>typeof id==='string' && id.startsWith('at-')).length},
        {expected,historyBefore,historyAfter,oldText,newText:movedText,movedObjects,selection});
      await k3dAPI.undo(); await new Promise(resolve=>setTimeout(resolve,120));
      const undone=await k3dAPI.serializeWorkbench();
      check('one undo restores the complete chemistry and document state from the real mixed drag',
        stable(JSON.parse(undone))===stable(JSON.parse(before)),
        {history:ed.historySize(),expectedDocument:beforeDoc,actualDocument:JSON.parse(undone).document});
      await k3dAPI.redo(); await new Promise(resolve=>setTimeout(resolve,120));
      check('one redo reapplies the complete real mixed drag',
        stable(JSON.parse(await k3dAPI.serializeWorkbench()))===stable(afterJson));
      paper.setTool('select'); paper.fitPage(); ed.zoom(.7); await new Promise(resolve=>setTimeout(resolve,100));
      paper.select(['${result.shapeId}']);
      const shape=paper.getState().objects.find(item=>item.id==='${result.shapeId}');
      const tinyStart=paper.modelToClient({x:shape.x+shape.w/2,y:shape.y+shape.h/2});
      return {checks,after,historyAfter:ed.historySize(),tinyStart,
        tinyEnd:{x:tinyStart.x+1,y:tinyStart.y+1},textId:'${result.textId}',shapeId:'${result.shapeId}',
        movedText:paper.getState().objects.find(item=>item.id==='${result.textId}'),zoom:adapter.zoom()};
    })()`);
    report.checks = dragResult.checks;
    report.artifacts.realMixedDrag = { start, end, expectedDelta:result.expectedDelta, historyAfter:dragResult.historyAfter };

    const tinyStart={x:Math.round(dragResult.tinyStart.x),y:Math.round(dragResult.tinyStart.y)};
    const tinyEnd={x:tinyStart.x+1,y:tinyStart.y+1};
    win.webContents.sendInputEvent({type:'mouseMove',...tinyStart});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...tinyStart});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',...tinyEnd});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...tinyEnd});
    await wait(120);
    const tinyResult=await js(`(async()=>{
      const checks=window.__documentModeChecks,ed=MolWorkbench.app.adapter.ed;
      const stable=value=>JSON.stringify((function sort(x){if(Array.isArray(x))return x.map(sort);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])]));return x})(value));
      const source=await k3dAPI.serializeWorkbench(),history=ed.historySize();
      const pass=stable(JSON.parse(source))===stable(JSON.parse(${JSON.stringify(dragResult.after)})) &&
        stable(history)===stable(${JSON.stringify(dragResult.historyAfter)});
      checks.push({name:'a sub-threshold 1 px click after zoom creates no movement or history drift',pass,
        detail:{history,expectedHistory:${JSON.stringify(dragResult.historyAfter)},zoom:${dragResult.zoom}}});
      if(!pass)throw new Error('sub-threshold click changed canvas or history');
      MolStudio.document.select([]);
      const text=MolStudio.document.getState().objects.find(item=>item.id==='${result.textId}');
      const adapter=MolWorkbench.app.adapter;
      MolStudio.document.fitPage(); ed.zoom(.7);
      const modelPoint={x:text.x+.35,y:text.y+.35};
      const area=ed.render.clientArea.getBoundingClientRect();
      const center=adapter.clientToModel({x:area.left+area.width/2,y:area.top+area.height/2});
      const bondLength=adapter.bondLength();
      ed.render.setViewBox(view=>({...view,minX:view.minX+(modelPoint.x-center.x)*bondLength,
        minY:view.minY+(modelPoint.y-center.y)*bondLength}));
      const point=MolStudio.document.modelToClient(modelPoint);
      const frame=document.getElementById('k').getBoundingClientRect();
      const canvas={left:frame.left+area.left,top:frame.top+area.top,right:frame.left+area.right,bottom:frame.top+area.bottom};
      const clickPoint={...point,visible:point.x>=canvas.left&&point.x<=canvas.right&&point.y>=canvas.top&&point.y<=canvas.bottom,
        canvas,frame:{left:frame.left,top:frame.top,right:frame.right,bottom:frame.bottom},modelPoint};
      checks.push({name:'zoomed text hit target lies inside the visible Ketcher canvas',pass:clickPoint.visible,
        detail:{clickPoint,zoom:adapter.zoom()}});
      if(!clickPoint.visible)throw new Error('zoomed text hit target is outside the visible canvas: '+JSON.stringify(clickPoint));
      return {checks,clickPoint,zoom:adapter.zoom()};
    })()`);
    report.checks = tinyResult.checks;
    const clickPoint=tinyResult.clickPoint;
    report.artifacts.zoomedClick={...clickPoint,zoom:tinyResult.zoom};
    if (!clickPoint || !clickPoint.visible || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) {
      throw new Error('modelToClient did not return a zoomed host-window click point');
    }
    const click={x:Math.round(clickPoint.x),y:Math.round(clickPoint.y)};
    win.webContents.sendInputEvent({type:'mouseMove',...click});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...click});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...click});
    await wait(120);
    const clickState=await js(`(()=>{
      const node=document.getElementById('k').contentDocument.querySelector('[data-doc-id="${result.textId}"]');
      return {exists:!!node,selected:node?.getAttribute('data-selected'),
        selection:MolStudio.document.getSelection?.()||null};
    })()`);
    report.checks.push({name:'a zoomed real mouse click selects the intended document object',
      pass:clickState.exists && clickState.selected==='1' && clickState.selection?.objects?.includes?.(result.textId),
      detail:{...clickState,point:click,zoom:tinyResult.zoom}});
    if(!report.checks.at(-1).pass)throw new Error('zoomed click did not select text: '+JSON.stringify(clickState));

    const mixedSource = await js('k3dAPI.serializeWorkbench()');
    const mixedLoad = await js(`k3dAPI.loadWorkbench(${JSON.stringify(mixedSource)})`);
    await wait(250);
    const reopened = await js(`(async()=>({source:await k3dAPI.serializeWorkbench(),document:MolStudio.document.getState(),
      context:await k3dAPI.agent.getContext(),ready:k3dAPI.workbenchReady()}))()`);
    const reopenedWorkbench = JSON.parse(reopened.source);
    const reopenedSummary = {
      ok: mixedLoad?.ok === true,
      mode: reopened.document.mode,
      pageCount: reopened.document.pageCount,
      objects: reopened.document.objects.map(({id,kind})=>({id,kind})),
      assets: Object.keys(reopened.document.assets || {}).length,
      atoms: reopened.context.atoms?.length,
      arrows: reopened.context.arrows?.length ?? reopened.context.mechanismArrows?.length,
      sourceVersion: reopenedWorkbench.version,
      ready: reopened.ready,
    };
    report.checks.push({ name: 'save and reopen preserve paper settings, chemistry, electron flow, text, image and shape',
      pass: reopenedSummary.ok && reopenedSummary.mode==='paper' && reopenedSummary.pageCount===1 &&
        reopenedSummary.sourceVersion===2 && reopenedSummary.atoms===3 &&
        reopened.document.objects.some(item=>item.id===result.textId && item.kind==='text') &&
        reopened.document.objects.some(item=>item.id===result.shapeId && item.kind==='shape') &&
        reopened.document.objects.some(item=>item.id===result.imageId && item.kind==='image') &&
        Object.keys(reopened.document.assets||{}).length===1 &&
        reopenedWorkbench.mechanism?.arrows?.length===2 && reopenedWorkbench.mechanism?.lonePairs?.length===1,
      detail: reopenedSummary });
    if (!report.checks.at(-1).pass) throw new Error('mixed save/reopen lost expected document content: ' + JSON.stringify(reopenedSummary));
    fs.writeFileSync(path.join(out, 'mixed-paper.molwork'), reopened.source);
    report.artifacts.mixedEditableSample = path.join(out, 'mixed-paper.molwork');
    await js('MolStudio.document.fitPage()');
    await wait(120);
    const mixedPages = await js('MolStudio.document.exportPages()');
    const mixedPage = mixedPages?.pages?.[0];
    const mixedSvg = mixedPage?.svg || '';
    const mixedHasUI = await js(`!!new DOMParser().parseFromString(${JSON.stringify(mixedSvg)},'image/svg+xml').querySelector('[data-mech-ui="1"],[data-doc-handle],[data-molstudio-ui]')`);
    fs.writeFileSync(path.join(out,'mixed-paper-pages.json'),JSON.stringify(mixedPages,null,2)+'\n');
    report.artifacts.mixedPageExportJSON=path.join(out,'mixed-paper-pages.json');
    fs.writeFileSync(path.join(out, 'mixed-paper-canvas.png'), (await win.capturePage()).toPNG());
    report.artifacts.mixedCanvasScreenshot = path.join(out, 'mixed-paper-canvas.png');
    report.checks.push({name:'mixed canvas exports one complete A4 SVG page with editable text, image, shape and SN2 arrows',
      pass:mixedPages?.ok===true && mixedPages.pages.length===1 && mixedPage.widthPt===595.28 && mixedPage.heightPt===841.89 &&
        mixedSvg.includes('Paper canvas note') && mixedSvg.includes('data:image/png;base64,') && mixedSvg.includes('#dbeafe') &&
        (mixedSvg.includes('mech-arrow') || mixedSvg.includes('mech-body')) && !mixedHasUI &&
        (mixedPages.warnings||[]).length===0,
      detail:{ok:mixedPages?.ok,pageCount:mixedPages?.pages?.length,widthPt:mixedPage?.widthPt,heightPt:mixedPage?.heightPt,
        hasText:mixedSvg.includes('Paper canvas note'),hasImage:mixedSvg.includes('data:image/png;base64,'),
        hasShape:mixedSvg.includes('#dbeafe'),hasArrow:mixedSvg.includes('mech-arrow')||mixedSvg.includes('mech-body'),
        hasInteractiveUI:mixedHasUI,warnings:mixedPages?.warnings}});
    if(!report.checks.at(-1).pass)throw new Error('mixed paper SVG page export failed: '+JSON.stringify(report.checks.at(-1).detail));

    // Keep a second editable sample proving that a paper document can contain
    // ordinary text with no chemical structure at all.
    await js(`(async()=>{
      await k3dAPI.setMolecule('');
      MolStudio.document.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      MolStudio.document.addText({x:8,y:10,w:24,h:4,text:'A paper document can be pure text.'});
      MolStudio.document.fitPage();
    })()`);
    await wait(150);
    const pureTextSource = await js('k3dAPI.serializeWorkbench()');
    const pureTextLoad = await js(`k3dAPI.loadWorkbench(${JSON.stringify(pureTextSource)})`);
    await wait(180);
    const pureText = await js(`(async()=>({source:await k3dAPI.serializeWorkbench(),document:MolStudio.document.getState(),
      context:await k3dAPI.agent.getContext()}))()`);
    const pureTextDocument = JSON.parse(pureText.source);
    const pureTextCheck = {
      pass: pureTextLoad?.ok === true && pureTextDocument.version===2 &&
        pureText.document.mode==='paper' && pureText.document.pageCount===1 &&
        pureText.document.objects.length===1 && pureText.document.objects[0].kind==='text' &&
        pureText.document.objects[0].rich.text==='A paper document can be pure text.' &&
        (pureText.context.atoms?.length||0)===0 &&
        (pureTextDocument.mechanism?.arrows?.length||0)===0 &&
        (pureTextDocument.mechanism?.lonePairs?.length||0)===0,
      summary:{load:pureTextLoad,version:pureTextDocument.version,mode:pureText.document.mode,
        pageCount:pureText.document.pageCount,objects:pureText.document.objects,atoms:pureText.context.atoms?.length||0,
        arrows:pureTextDocument.mechanism?.arrows?.length||0,lonePairs:pureTextDocument.mechanism?.lonePairs?.length||0},
    };
    report.checks.push({name:'empty chemistry paper document saves and reopens as editable plain text',...pureTextCheck});
    if (!pureTextCheck.pass) throw new Error('empty-chemistry text round trip failed: ' + JSON.stringify(pureTextCheck.summary));
    fs.writeFileSync(path.join(out, 'pure-text-paper.molwork'), pureText.source);
    report.artifacts.pureTextEditableSample = path.join(out, 'pure-text-paper.molwork');
    await js('MolStudio.document.fitPage()');
    await wait(120);
    const pureTextPages=await js('MolStudio.document.exportPages()');
    const pureSvg=pureTextPages?.pages?.[0]?.svg||'';
    const pureHasUI=await js(`!!new DOMParser().parseFromString(${JSON.stringify(pureSvg)},'image/svg+xml').querySelector('[data-mech-ui="1"],[data-doc-handle],[data-molstudio-ui]')`);
    fs.writeFileSync(path.join(out,'pure-text-pages.json'),JSON.stringify(pureTextPages,null,2)+'\n');
    report.artifacts.pureTextPageExportJSON=path.join(out,'pure-text-pages.json');
    fs.writeFileSync(path.join(out, 'pure-text-canvas.png'), (await win.capturePage()).toPNG());
    report.artifacts.pureTextCanvasScreenshot = path.join(out, 'pure-text-canvas.png');
    report.checks.push({name:'pure-text canvas exports one A4 SVG page containing selectable plain text',
      pass:pureTextPages?.ok===true && pureTextPages.pages.length===1 &&
        pureTextPages.pages[0].widthPt===595.28 && pureTextPages.pages[0].heightPt===841.89 &&
        pureSvg.includes('A paper document can be pure text.') && !pureHasUI &&
        (pureTextPages.warnings||[]).length===0,
      detail:{ok:pureTextPages?.ok,pageCount:pureTextPages?.pages?.length,widthPt:pureTextPages?.pages?.[0]?.widthPt,
        heightPt:pureTextPages?.pages?.[0]?.heightPt,hasText:pureSvg.includes('A paper document can be pure text.'),
        hasInteractiveUI:pureHasUI,warnings:pureTextPages?.warnings}});
    if(!report.checks.at(-1).pass)throw new Error('pure-text page SVG export failed: '+JSON.stringify(report.checks.at(-1).detail));

    report.ok = report.checks.every(check => check.pass);
  } catch (error) {
    report.ok = false;
    report.error = String(error?.stack || error);
    if (win && !win.isDestroyed()) {
      const pageChecks = await win.webContents.executeJavaScript('window.__documentModeChecks || []').catch(() => []);
      if (pageChecks.length > report.checks.length) report.checks = pageChecks;
    }
  } finally {
    if(!clipboardRestored)await restoreClipboard();
    report.artifacts.osClipboardRestored=clipboardRestored;
    if (win && !win.isDestroyed()) {
      try {
        if (!report.artifacts.mixedCanvasScreenshot) {
          fs.writeFileSync(path.join(out, 'failure-canvas.png'), (await win.capturePage()).toPNG());
          report.artifacts.failureCanvasScreenshot = path.join(out, 'failure-canvas.png');
        }
      } catch (error) { report.captureError = String(error?.message || error); }
    }
    report.finishedAt = new Date().toISOString();
    report.artifactDirectory = out;
    writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check=>check.pass).length,
      total: report.checks.length, failures: report.checks.filter(check=>!check.pass), error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    clearTimeout(watchdog);
    win?.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch(error => {
  report.ok = false;
  report.error = String(error?.stack || error);
  report.finishedAt = new Date().toISOString();
  report.artifactDirectory = out;
  writeReport();
  console.error(report.error);
  app.exit(1);
});
