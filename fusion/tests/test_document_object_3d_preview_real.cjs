'use strict';
// Current canvas, real WebGL and /api/gen3d; isolated window, no upstream model calls.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const port = Number(process.env.MOLSTUDIO_PORT || 49078);
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-3d-preview-validation');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-3d-preview-')));
const report = { application: 'MolStudio current canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout, isolated Electron window', service: `http://127.0.0.1:${port}`, modelCalls: 0, checks: [], errors: [], artifacts: {} };
let win;
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(r => setTimeout(r, ms));
function alphaMetrics(dataURL) {
  const image = nativeImage.createFromDataURL(dataURL), { width, height } = image.getSize(), pixels = image.toBitmap();
  let minX = width, minY = height, maxX = -1, maxY = -1, transparent = 0, opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = pixels[(y * width + x) * 4 + 3];
    if (!alpha) { transparent++; continue; }
    opaque++;
    if (alpha <= 2) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const bounds = maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { width, height, bounds, transparent, opaque,
    occupancy: bounds ? Math.max(bounds.width / width, bounds.height / height) : 0,
    fillX: bounds ? bounds.width / width : 0, fillY: bounds ? bounds.height / height : 0,
    aspect: bounds ? bounds.width / bounds.height : 0,
    margins: bounds ? { left: bounds.x, top: bounds.y,
      right: width - bounds.x - bounds.width, bottom: height - bounds.y - bounds.height } : null,
    minMarginPct: bounds ? Math.min(bounds.x / width, (width - bounds.x - bounds.width) / width,
      bounds.y / height, (height - bounds.y - bounds.height) / height) : 0 };
}
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'watchdog'; write(); win?.destroy(); app.exit(2); }, 180000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1460, height: 1100, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = script => win.webContents.executeJavaScript(script);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail }); write(); if (!pass) throw new Error(name); };
  const ready = async () => {
    for (let i = 0; i < 400; i++) { if (await js('!!MolWorkbench.app.documentUI.active3D?.ready')) return; await wait(100); }
    throw new Error('3D preview did not become ready');
  };
  const click = async label => js(`(()=>{const button=[...document.querySelectorAll('#molstudio-3d-interaction button')].find(b=>b.textContent===${JSON.stringify(label)});if(!button)throw new Error('Missing button');button.click();return true;})()`);
  const state = () => js(`({state:JSON.stringify(C.state),history:A.ed.historySize(),dirty:window.__mechDirtyTick||0})`);
  const begin = () => js(`(()=>{C.selection.clear();A.ed.selection({atoms:[...A.struct().atoms.keys()],bonds:[...A.struct().bonds.keys()]});window.__insert=C.insertMolecule3DPreview({at:{x:20,y:23}});return true;})()`);
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  try {
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 300 && !await js('!!window.k3dAPI?.workbenchReady?.() && !!window.MolStudio?.document'); i++) await wait(100);
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/M01.ket'), 'utf8');
    await js(`(async()=>{await k3dAPI.setMolecule(${JSON.stringify(fixture)});window.C=MolWorkbench.app.documentController;window.U=MolWorkbench.app.documentUI;window.A=MolWorkbench.app.adapter;C.setPageSetup({mode:'paper'});C.fitPage();C.onStereoChoiceRequired=async()=>true;C.onChooseMolecule3DTarget=async xs=>xs.sort((a,b)=>b.size-a.size)[0];})()`);
    const before = await state();
    await begin(); await ready();
    const pending = await state();
    check('insertion preview leaves document, assets, dirty state and undo history untouched', JSON.stringify(pending) === JSON.stringify(before), { history: pending.history, dirty: pending.dirty });
    await click('取消');
    const cancelled = await js('window.__insert');
    const afterCancel = await state();
    check('cancel leaves no object, asset or history entry', cancelled.cancelled && JSON.stringify(afterCancel) === JSON.stringify(before), cancelled);
    await begin(); await ready();
    const rect = await js(`(()=>{const r=U.active3D.host.getBoundingClientRect();return{x:r.x+r.width*.5,y:r.y+r.height*.5};})()`);
    const start = { x: Math.round(rect.x), y: Math.round(rect.y) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...start });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
    for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: start.x + i * 12, y: start.y + i * 5 }); await wait(30); }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + 72, y: start.y + 30 });
    const rotated = await js('U.active3D.session.cameraJson()');
    check('real drag rotates insertion preview', Math.abs(rotated.qx) + Math.abs(rotated.qy) + Math.abs(rotated.qz) > .01, rotated);
    await js(`(()=>{let s=document.querySelector('#molstudio-3d-interaction select');s.value='stick';s.dispatchEvent(new Event('change'));})()`);
    const previewShot = path.join(out, 'before-confirmation.png');
    fs.writeFileSync(previewShot, (await win.webContents.capturePage()).toPNG()); report.artifacts.preview = previewShot;
    await click('确认插入');
    const inserted = await js('window.__insert');
    const insertedState = await js(`(()=>{window.__id=${JSON.stringify('')}||C.state.objects.find(o=>o.kind==='molecule3d').id;return{object:C.object(__id),history:A.ed.historySize(),asset:C.state.assets[C.object(__id).previewAsset]};})()`);
    check('confirmation inserts editable source and chosen style in one undo entry', inserted.ok && insertedState.object.source.atomUuids.length > 0 && insertedState.object.style === 'stick' && insertedState.history.undo === before.history.undo + 1, { id: inserted.id, object: { camera: insertedState.object.camera, source: insertedState.object.source }, history: insertedState.history });
    const insertedImage = 'data:image/png;base64,' + insertedState.asset.data;
    const imageMetrics = alphaMetrics(insertedImage);
    const imagePath = path.join(out, 'inserted-trimmed-3d.png');
    fs.writeFileSync(imagePath, Buffer.from(insertedState.asset.data, 'base64')); report.artifacts.insertedImage = imagePath;
    check('document preview keeps transparent alpha and fits the molecule inside a padded 640x480 frame',
      imageMetrics.width === 640 && imageMetrics.height === 480 && imageMetrics.transparent > 0 && imageMetrics.opaque > 100 &&
      imageMetrics.occupancy >= .82 && imageMetrics.occupancy <= .92 && Object.values(imageMetrics.margins).every(x => x >= 10),
      imageMetrics);
    await js('A.ed.undo();');
    check('one undo removes insertion', await js('!C.object(__id)'), {});
    await js('A.ed.redo();C.setTool("select");C.render();');
    const center = await js('(()=>{const o=C.object(__id);return C.modelToClient({x:o.x+o.w/2,y:o.y+o.h/2});})()');
    const at = { x: Math.round(center.x), y: Math.round(center.y) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 2, ...at });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 2, ...at });
    await ready();
    const reopened = await js('U.active3D.session.cameraJson()');
    check('real double click reopens the saved orientation', ['qx','qy','qz','qw'].every(k => Math.abs(reopened[k] - insertedState.object.camera[k]) < 1e-7), reopened);
    const editBefore = await state();
    await js('U.active3D.session.iframe.contentWindow.k3d.rotateXY(70,20)');
    await click('取消');
    check('cancelled edit preserves orientation, asset and history', JSON.stringify(await state()) === JSON.stringify(editBefore), {});
    await js('U.open3DInteraction(__id)'); await ready();
    await js('U.active3D.session.iframe.contentWindow.k3d.rotateXY(35,15)');
    await click('确认保存');
    for (let i = 0; i < 200 && await js('!!U.active3D'); i++) await wait(50);
    const edited = await js('({object:C.object(__id),history:A.ed.historySize()})');
    check('confirmed edit changes orientation in one undo entry', edited.history.undo === editBefore.history.undo + 1 && edited.object.camera.qx !== insertedState.object.camera.qx, { camera: edited.object.camera, history: edited.history });
    const saved = await js('k3dAPI.serializeWorkbench()');
    const savedPath = path.join(out, 'transparent-3d-editable.molwork'); fs.writeFileSync(savedPath, saved); report.artifacts.document = savedPath;
    await js(`k3dAPI.loadWorkbench(${JSON.stringify(saved)})`);
    await js('window.C=MolWorkbench.app.documentController;window.U=MolWorkbench.app.documentUI;window.A=MolWorkbench.app.adapter;true;');
    const loaded = await js(`C.state.objects.find(o=>o.id===${JSON.stringify(inserted.id)})`);
    check('save and reopen preserves source, style and full camera', JSON.stringify(loaded.camera) === JSON.stringify(edited.object.camera) && loaded.style === 'stick' && loaded.source.atomUuids.length > 0, { camera: loaded.camera, style: loaded.style });
    await js(`U.open3DInteraction(${JSON.stringify(inserted.id)})`); await ready();
    const imageAfterLoad = await js('U.active3D.session.snapshot({width:640,height:480,trim:true})');
    const storedImage = await js(`'data:image/png;base64,'+C.state.assets[C.object(${JSON.stringify(inserted.id)}).previewAsset].data`);
    const reloadedMetrics = alphaMetrics(storedImage);
    check('reopened preview keeps the same padded frame and molecule aspect',
      reloadedMetrics.width === 640 && reloadedMetrics.height === 480 && reloadedMetrics.occupancy >= .82 && reloadedMetrics.occupancy <= .92,
      reloadedMetrics);
    const pixelsA = nativeImage.createFromDataURL(imageAfterLoad).toBitmap(), pixelsB = nativeImage.createFromDataURL(storedImage).toBitmap();
    let changed = 0; for (let i = 0; i < pixelsA.length; i += 4) if ([0,1,2,3].some(k => Math.abs(pixelsA[i+k] - pixelsB[i+k]) > 3)) changed++;
    check('reopened interactive camera reproduces stored PNG', changed < 640 * 480 * .005, { changed });
    await click('取消');
    const finalShot = path.join(out, 'transparent-3d-on-paper.png'); fs.writeFileSync(finalShot, (await win.webContents.capturePage()).toPNG()); report.artifacts.canvas = finalShot;
    await js(`U.open3DInteraction(${JSON.stringify(inserted.id)})`); await ready();
    const unchangedContent = await js(`(()=>{
      const id=${JSON.stringify(inserted.id)}, st=U.active3D;
      C.updateObject(id,{x:C.object(id).x+1}); A.ed.undo();
      return {active:U.active3D===st,cloned:C.object(id)!==st.object};
    })()`);
    check('moving and undoing position keeps the content-identical 3D session editable', unchangedContent.active && unchangedContent.cloned, unchangedContent);
    await click('取消');
    await js(`C.updateObject(${JSON.stringify(inserted.id)},{style:'sphere'});true;`);
    await js(`U.open3DInteraction(${JSON.stringify(inserted.id)})`); await ready();
    const undoStale = await js(`(async()=>{
      const id=${JSON.stringify(inserted.id)};
      U.active3D.session.iframe.contentWindow.k3d.rotateXY(50,20);
      A.ed.undo();
      const restored=JSON.stringify(C.state),history=JSON.stringify(A.ed.historySize());
      const confirmed=await U.finish3DInteraction();
      return {closed:!U.active3D,confirmed,unchanged:restored===JSON.stringify(C.state),sameHistory:history===JSON.stringify(A.ed.historySize()),style:C.object(id).style};
    })()`);
    check('undoing changed 3D content cancels the old session without overwriting restored state', undoStale.closed && undoStale.confirmed===false && undoStale.unchanged && undoStale.sameHistory && undoStale.style==='stick', undoStale);
    await js(`U.open3DInteraction(${JSON.stringify(inserted.id)})`); await ready();
    await js(`(()=>{
      const session=U.active3D.session, original=session.snapshot.bind(session);
      window.__snapshotWaiting=false;
      session.snapshot=async options=>{const image=await original(options);window.__snapshotWaiting=true;await new Promise(resolve=>{window.__releaseSnapshot=resolve;});return image;};
      window.__confirmPending=U.finish3DInteraction();return true;
    })()`);
    for(let i=0;i<300&&!await js('window.__snapshotWaiting');i++) await wait(50);
    const sourceStale = await js(`(async()=>{
      if(!window.__snapshotWaiting)throw new Error('Snapshot gate was not reached');
      const id=${JSON.stringify(inserted.id)},old=C.object(id).molfile;
      C.updateObject(id,{molfile:old.replace(/^[^\\n]*/,'MolStudio updated source')});
      const updated=JSON.stringify(C.state),history=JSON.stringify(A.ed.historySize());
      window.__releaseSnapshot();const confirmed=await window.__confirmPending;
      return {closed:!U.active3D,confirmed,unchanged:updated===JSON.stringify(C.state),sameHistory:history===JSON.stringify(A.ed.historySize())};
    })()`);
    check('source change during snapshot cancels confirmation without a late PNG or camera write', sourceStale.closed && sourceStale.confirmed===false && sourceStale.unchanged && sourceStale.sameHistory, sourceStale);

    await js(`C.updateObject(${JSON.stringify(inserted.id)},{w:24,h:12});true;`);
    const beforeStyleUpdate = await js(`(()=>{const o=C.object(${JSON.stringify(inserted.id)});return{x:o.x,y:o.y,w:o.w,h:o.h,camera:o.camera};})()`);
    const styleUpdate = await js(`U.update3DStyle(${JSON.stringify(inserted.id)},'sphere')`);
    let styledImage = await js(`'data:image/png;base64,'+C.state.assets[C.object(${JSON.stringify(inserted.id)}).previewAsset].data`);
    let styledMetrics = alphaMetrics(styledImage);
    const afterStyleUpdate = await js(`(()=>{const o=C.object(${JSON.stringify(inserted.id)});return{x:o.x,y:o.y,w:o.w,h:o.h,style:o.style,camera:o.camera};})()`);
    const styleImagePath = path.join(out, 'style-updated-trimmed-3d.png');
    fs.writeFileSync(styleImagePath, Buffer.from(styledImage.split(',')[1], 'base64')); report.artifacts.styleUpdatedImage = styleImagePath;
    check('property-panel style update stores the same tight transparent frame and preserves user size and camera',
      styleUpdate === true && afterStyleUpdate.style === 'sphere' &&
      ['x','y','w','h'].every(key => afterStyleUpdate[key] === beforeStyleUpdate[key]) &&
      JSON.stringify(afterStyleUpdate.camera) === JSON.stringify(beforeStyleUpdate.camera) &&
      styledMetrics.width === 640 && styledMetrics.height === 320 && styledMetrics.occupancy >= .82 && styledMetrics.occupancy <= .92 &&
      Object.values(styledMetrics.margins).every(x => x >= 10),
      { camera: afterStyleUpdate.camera, size: { w: styledMetrics.width, h: styledMetrics.height }, frame: styledMetrics });

    const sourceUpdate = await js(`C.updateMolecule3DFromSource(${JSON.stringify(inserted.id)})`);
    styledImage = await js(`'data:image/png;base64,'+C.state.assets[C.object(${JSON.stringify(inserted.id)}).previewAsset].data`);
    styledMetrics = alphaMetrics(styledImage);
    const afterSourceUpdate = await js(`(()=>{const o=C.object(${JSON.stringify(inserted.id)});return{x:o.x,y:o.y,w:o.w,h:o.h,style:o.style,camera:o.camera};})()`);
    const sourceImagePath = path.join(out, 'source-updated-trimmed-3d.png');
    fs.writeFileSync(sourceImagePath, Buffer.from(styledImage.split(',')[1], 'base64')); report.artifacts.sourceUpdatedImage = sourceImagePath;
    check('linked source update also stores a tight transparent frame without resizing or changing camera/style',
      sourceUpdate === true && afterSourceUpdate.style === 'sphere' &&
      ['x','y','w','h'].every(key => afterSourceUpdate[key] === beforeStyleUpdate[key]) &&
      JSON.stringify(afterSourceUpdate.camera) === JSON.stringify(beforeStyleUpdate.camera) &&
      styledMetrics.width === 640 && styledMetrics.height === 320 && styledMetrics.occupancy >= .82 && styledMetrics.occupancy <= .92 &&
      Object.values(styledMetrics.margins).every(x => x >= 10),
      { camera: afterSourceUpdate.camera, size: { w: styledMetrics.width, h: styledMetrics.height }, frame: styledMetrics });
    report.ok = true; write(); clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (error) {
    report.ok = false; report.failure = String(error.stack || error);
    try { fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
    write(); clearTimeout(watchdog); win.destroy(); app.exit(1);
  }
});
