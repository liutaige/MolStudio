'use strict';
// Electron + current canvas.html served on an isolated port.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const port = Number(process.env.MOLSTUDIO_TEST_PORT), dir = process.env.MOLSTUDIO_TEST_DIR;
if (!port || port === 8462 || !dir || !path.isAbsolute(dir)) throw Error('isolated port and absolute test directory required');
fs.mkdirSync(dir, { recursive: true }); app.setPath('userData', path.join(dir, 'electron-user-data'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,width:1180,height:820,webPreferences:{backgroundThrottling:false}});
 const js = s => win.webContents.executeJavaScript(s);
 try {
  await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
  assert.ok(await js(`(async()=>{for(let i=0;i<100;i++){if(window.k3dAPI?.workbenchReady?.())return true;await new Promise(r=>setTimeout(r,100))}return false})()`));
  async function setup(frame = true) {
   await js(`window.k3dAPI.setMolecule('CCO')`); await sleep(400);
   await js(`(()=>{const a=MolWorkbench.app,M=MolWorkbench.model,r=a.adapter.ed.render.clientArea.getBoundingClientRect(),p=a.adapter.clientToModel({x:r.left+r.width/2,y:r.top+r.height/2});const ar=M.makeArrow({type:'free',x:p.x-2,y:p.y-2},{type:'free',x:p.x+2,y:p.y-2},{bend:.6,mode:'manual',...( ${frame} ? {controlFrame:{along:.4,normal:.6}} : {})});a.model.addArrow(ar);a.controller.selection=new Set([ar.id]);a.controller.render()})()`);
  }
  await setup();
  const h=await js(`(()=>{const f=document.getElementById('k'),r=f.getBoundingClientRect(),h=f.contentDocument.querySelector('[data-handle="arrow-bend"]').getBoundingClientRect();return {x:Math.round(r.left+h.left+h.width/2),y:Math.round(r.top+h.top+h.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...h}); win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...h});
  win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:h.x,y:h.y+1}); await sleep(100);
  const moved=await js(`MolWorkbench.app.model.state.arrows[0].geometry`); assert.ok(moved.controlFrame && Math.abs(moved.controlFrame.normal-.6)<.1 && moved.controlFrame.normal>.6,JSON.stringify(moved));
  win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:h.x,y:h.y-1}); await sleep(100);
  const reverse=await js(`MolWorkbench.app.model.state.arrows[0].geometry.controlFrame.normal`); assert.ok(reverse<.6);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:h.x,y:h.y-1}); await sleep(100);
  assert.equal(await js(`MolWorkbench.app.model.state.arrows[0].geometry.controlFrame.normal`),.6);
  // Real mouseup commits one history item; both normal and framed curves
  // retain their geometry on undo/redo after a one-pixel move.
  for (const frame of [false, true]) {
    await setup(frame);
    const before = await js(`MolWorkbench.app.model.cloneState()`);
    const p=await js(`(()=>{const f=document.getElementById('k'),r=f.getBoundingClientRect(),h=f.contentDocument.querySelector('[data-handle="arrow-bend"]').getBoundingClientRect();return {x:Math.round(r.left+h.left+h.width/2),y:Math.round(r.top+h.top+h.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...p});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',x:p.x,y:p.y+1});
    await sleep(100);
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:p.x,y:p.y+1}); await sleep(100);
    const after=await js(`MolWorkbench.app.model.cloneState()`);
    const actual=frame?after.arrows[0].geometry.controlFrame.normal:after.arrows[0].geometry.bend;
    assert.ok(actual>.6 && actual<.7,JSON.stringify({frame,actual}));
    await js(`window.k3dAPI.undo()`);await sleep(100);
    assert.deepEqual(await js(`MolWorkbench.app.model.cloneState()`),before,'1px undo frame='+frame);
    await js(`window.k3dAPI.redo()`);await sleep(100);
    assert.deepEqual(await js(`MolWorkbench.app.model.cloneState()`),after,'1px redo frame='+frame);
  }
  async function state(){ return js(`({atoms:MolWorkbench.app.adapter.struct().atoms.size,arrows:MolWorkbench.app.model.state.arrows.length})`); }
  for(const method of ['key','api','workbench']) {
   await setup(); await js(`MolWorkbench.app.controller.selectAll()`);
   if(method==='key') { await js(`document.getElementById('k').contentWindow.focus();document.getElementById('k').contentDocument.activeElement.focus()`); win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'}); }
   else if(method==='api') await js(`window.k3dAPI.deleteSel()`);
   else await js(`MolWorkbench.app.controller.deleteSelection()`);
   await sleep(300); assert.deepEqual(await state(),{atoms:0,arrows:0},method+' delete');
   await js(`window.k3dAPI.undo()`);await sleep(200);assert.deepEqual(await state(),{atoms:3,arrows:1},method+' undo');
   await js(`window.k3dAPI.redo()`);await sleep(200);assert.deepEqual(await state(),{atoms:0,arrows:0},method+' redo');
  }
  // Bound lone pairs and electron-flow endpoints must survive the native
  // structure change and a single undo with the same runtime UUIDs.
  await js(`window.k3dAPI.setMolecule('[OH-].CBr')`); await sleep(400);
  const boundBefore=await js(`(()=>{const a=MolWorkbench.app,M=MolWorkbench.model,st=a.adapter.struct();a.adapter.syncIdentity();
    const atoms=Array.from(st.atoms.entries()), o=atoms.find(x=>x[1].label==='O')[0], c=atoms.find(x=>x[1].label==='C')[0], br=atoms.find(x=>x[1].label==='Br')[0];
    const ou=a.adapter.uuidOfAtom(o),cu=a.adapter.uuidOfAtom(c),bu=a.adapter.uuidOfAtom(br),bid=a.adapter.uuidOfBond(Array.from(st.bonds.keys())[0]);
    const lp=M.makeLonePair(ou,{origin:'manual',angle:0});a.model.addLonePair(lp);
    a.model.addArrow(M.makeArrow({type:'lonePair',ownerAtomId:ou,slotId:lp.id},{type:'formingBond',atomA:ou,atomB:cu},{bend:.3}));
    a.model.addArrow(M.makeArrow({type:'bond',bondId:bid,component:'sigma'},{type:'atom',atomId:bu},{bend:.3}));
    a.controller.selectAll();return {state:a.model.cloneState(),atoms:[ou,cu,bu],bond:bid}})()`);
  await js(`window.k3dAPI.deleteSel()`);await sleep(200);
  assert.deepEqual(await js(`({atoms:MolWorkbench.app.adapter.struct().atoms.size,counts:MolWorkbench.app.model.counts()})`),{atoms:0,counts:{lonePairs:0,arrows:0}});
  await js(`window.k3dAPI.undo()`);await sleep(200);
  const restored=await js(`(()=>{const a=MolWorkbench.app,st=a.adapter.struct();return {state:a.model.cloneState(),atoms:Array.from(st.atoms.keys()).map(id=>a.adapter.uuidOfAtom(id)),bonds:Array.from(st.bonds.keys()).map(id=>a.adapter.uuidOfBond(id))}})()`);
  assert.deepEqual(restored.state,boundBefore.state,'bound mechanism including endpoint IDs restored');
  assert.deepEqual(restored.atoms.slice().sort(),boundBefore.atoms.slice().sort(),'atom UUIDs restored');
  assert.ok(restored.bonds.includes(boundBefore.bond),'bond UUID restored');
  await js(`window.k3dAPI.redo()`);await sleep(200);
  assert.deepEqual(await js(`MolWorkbench.app.model.counts()`),{lonePairs:0,arrows:0});
  // Native text and native straight arrows are selections even with no atoms.
  for (const nativeNode of [
    {type:'arrow',data:{mode:'open-angle',pos:[{x:0,y:0,z:0},{x:2,y:0,z:0}]}},
    {type:'text',boundingBox:{x:0,y:0,width:3,height:.5},paragraphs:[{parts:[{text:'note'}],indent:0}],indent:0}
  ]) {
    const ket={ket_version:'2.0.0',root:{nodes:[nativeNode],connections:[],templates:[]}};
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(JSON.stringify(ket))})`); await sleep(300);
    const initial=await js(`(()=>{const a=MolWorkbench.app,M=MolWorkbench.model;const ar=M.makeArrow({type:'free',x:0,y:2},{type:'free',x:2,y:2},{bend:.3});a.model.addArrow(ar);a.controller.selectAll();return {native:a.adapter.hasNativeSelection?.(),selection:a.adapter.ed.selection(),model:a.model.cloneState()}})()`);
    assert.ok(Object.values(initial.selection).some(v=>Array.isArray(v)&&v.length),'native object selected '+nativeNode.type);
    await js(`window.k3dAPI.deleteSel()`);await sleep(200);
    const deleted=await js(`(()=>{const a=MolWorkbench.app,s=a.adapter.struct();return {arrows:a.model.state.arrows.length,native:s.${nativeNode.type==='text'?'texts':'rxnArrows'}.size}})()`);
    assert.deepEqual(deleted,{arrows:0,native:0},nativeNode.type+' mixed delete');
    await js(`window.k3dAPI.undo()`);await sleep(200);
    const restoredNative=await js(`(()=>{const a=MolWorkbench.app,s=a.adapter.struct();return {model:a.model.cloneState(),native:s.${nativeNode.type==='text'?'texts':'rxnArrows'}.size}})()`);
    assert.equal(restoredNative.native,1,nativeNode.type+' undo');assert.deepEqual(restoredNative.model,initial.model);
    await js(`window.k3dAPI.redo()`);await sleep(150);
    assert.equal(await js(`MolWorkbench.app.adapter.struct().${nativeNode.type==='text'?'texts':'rxnArrows'}.size`),0);
  }
  // Mechanism-only and native-only keyboard paths remain independent.
  await setup(); await js(`MolWorkbench.app.adapter.ed.selection(null)`);
  await js(`window.k3dAPI.deleteSel()`); await sleep(200);
  assert.deepEqual(await state(),{atoms:3,arrows:0},'mechanism-only delete');
  await js(`window.k3dAPI.undo()`); await sleep(150); assert.deepEqual(await state(),{atoms:3,arrows:1});
  await setup(); await js(`MolWorkbench.app.controller.clearSelection();MolWorkbench.app.adapter.ed.selection('all')`);
  await js(`window.k3dAPI.deleteSel()`); await sleep(200);
  assert.deepEqual(await state(),{atoms:0,arrows:1},'native-only delete');
  await js(`window.k3dAPI.undo()`); await sleep(150); assert.deepEqual(await state(),{atoms:3,arrows:1});
  await js(`(()=>{const d=document.getElementById('k').contentDocument,e=d.createElement('input');e.id='test-editable';e.value='abc';d.body.appendChild(e);e.focus();e.setSelectionRange(3,3)})()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'}); await sleep(100);
  assert.equal(await js(`document.getElementById('k').contentDocument.getElementById('test-editable').value`),'ab');
  assert.deepEqual(await state(),{atoms:3,arrows:1},'text focus');
  fs.writeFileSync(path.join(dir,'canvas-interaction.png'),(await win.capturePage()).toPNG());
  console.log('PASS canvas.html Electron bend, cancel, mixed delete, undo and redo'); win.destroy();app.quit();
 } catch(e){console.error(e);win.destroy();app.exit(1)}
});
