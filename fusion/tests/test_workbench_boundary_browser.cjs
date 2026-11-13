/* Chromium/Electron integration: isolated server required, never uses port 8462.
 * MOLSTUDIO_TEST_PORT=<isolated port> MOLSTUDIO_TEST_DIR=<private dir> electron ... <this file>
 * Interactions are Electron input events; pointercancel is explicitly dispatched.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const port = Number(process.env.MOLSTUDIO_TEST_PORT);
const dir = process.env.MOLSTUDIO_TEST_DIR;
if (!Number.isInteger(port) || port < 1024 || port === 8462 || !dir || !path.isAbsolute(dir)) {
  throw new Error('An isolated non-8462 port and absolute private test directory are required');
}
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'electron-user-data'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
    const ready = await js(`(async()=>{for(let i=0;i<100;i++){if(window.k3dAPI?.workbenchReady?.())return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    assert.ok(ready, 'workbench ready');
    await js(`window.k3dAPI.setMolecule('C')`);
    await sleep(400);
    const mapping = await js(`(async () => {
      const a=MolWorkbench.app.adapter, st=a.struct(), first=Array.from(st.atoms.values())[0];
      if (!first) return {error:'missing atom'};
      first.pp.x=-0.0000001; first.pp.y=0.0000001;
      const ket=JSON.parse(await document.getElementById('k').contentWindow.ketcher.getKet());
      const key=orderedMoleculeKeys(ket)[0]; if (!key) return {error:'missing molecule'};
      ket[key].atoms[0].location=[0,0,0]; a.syncIdentity();
      const binding=a.mapRuntimeToKet(ket), cleanup=buildAtomMap(ket,st);
      return {bindingError:binding.error || null, cleanupError:cleanup.error || null,
        bindings:binding.atoms?.length, mapped:cleanup.map?.[key]?.length};
    })()`);
    assert.deepEqual(mapping,{bindingError:null,cleanupError:null,bindings:1,mapped:1},'actual editor negative-zero mapping');
    await js(`(() => {
      const a=MolWorkbench.app, M=MolWorkbench.model, r=a.adapter.ed.render.clientArea.getBoundingClientRect();
      const p=a.adapter.clientToModel({x:r.left+r.width/2,y:r.top+r.height/2});
      const ar=M.makeArrow({type:'free',x:p.x-2,y:p.y},{type:'free',x:p.x+2,y:p.y},
        {electronCount:1,bend:0.42,mode:'manual',controlFrame:{along:0.5,normal:0.42}});
      a.model.addArrow(ar);a.controller.selection.add(ar.id);a.controller.emitSelection();a.controller.render();
    })()`);
    await sleep(300);
    const before = await js(`JSON.stringify(MolWorkbench.app.model.cloneState())`);
    async function drag() {
      const p = await js(`(() => { const frame=document.getElementById('k'), r=frame.getBoundingClientRect();
        const h=frame.contentDocument.querySelector('[data-handle="arrow-bend"]');
        if(!h)return null;const q=h.getBoundingClientRect();return {x:r.left+q.left+q.width/2,y:r.top+q.top+q.height/2}; })()`);
      assert.ok(p, 'visible bend handle exists');
      const x=Math.round(p.x),y=Math.round(p.y);
      win.webContents.sendInputEvent({ type:'mouseMove', x,y });
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x,y });
      win.webContents.sendInputEvent({ type:'mouseMove', button:'left', x:x+10,y:y+50 });
      await sleep(150);
      const state=await js(`JSON.stringify({drag:MolWorkbench.app.controller.drag?.kind,model:MolWorkbench.app.model.cloneState()})`);
      const observed=JSON.parse(state);
      assert.equal(observed.drag,'arrow-bend','pointer input begins a real controller drag');
      assert.notEqual(JSON.stringify(observed.model),before,'drag produces preview');
      return {x:x+10,y:y+50};
    }
    let p=await drag();
    await js(`document.getElementById('k').contentDocument.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))`);
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});
    await sleep(100);
    assert.equal(await js(`JSON.stringify(MolWorkbench.app.model.cloneState())`),before,'pointercancel restores preview');
    assert.equal(await js(`MolWorkbench.app.controller.drag`),null);
    p=await drag();
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});
    await sleep(100);
    assert.equal(await js(`JSON.stringify(MolWorkbench.app.model.cloneState())`),before,'Escape restores preview');
    assert.equal(await js(`MolWorkbench.app.controller.drag`),null);
    const image = await win.capturePage();
    fs.writeFileSync(path.join(dir, 'boundary-browser.png'), image.toPNG());
    fs.writeFileSync(path.join(dir, 'boundary-browser.json'),JSON.stringify({engine:'Electron Chromium',ready:true,negativeZeroMapping:mapping,realInputDrag:true,pointercancel:'synthetic DOM event',escape:'Electron keyboard input',restored:true},null,2));
    console.log('PASS browser mouse drag + pointercancel and Escape restore state');
    win.destroy(); app.quit();
  } catch (err) { console.error(err); win.destroy(); app.exit(1); }
});
