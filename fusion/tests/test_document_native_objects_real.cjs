'use strict';
// Current canvas only. Actual native bond/selection gestures and native-object
// coordinate round trips. No model calls, browser DOM or editor mocks.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const port = Number(process.env.MOLSTUDIO_PORT || 49075);
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '.jez/artifacts/document-native-objects-real');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-native-objects-')));
const report = { application: 'MolStudio current canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout', service: `http://127.0.0.1:${port}`, modelCalls: 0, checks: [], errors: [] };
let win;
const write = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => { report.ok = false; report.failure = 'watchdog'; write(); win?.destroy(); app.exit(2); }, 90000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1460, height: 1160, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = script => win.webContents.executeJavaScript(script);
  const check = (name, pass, detail) => { report.checks.push({ name, pass: !!pass, detail }); write(); if (!pass) throw new Error(name); };
  const point = p => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const drag = async (from, to) => {
    const a = point(from), b = point(to);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...a });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...a });
    for (let i = 1; i <= 4; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: Math.round(a.x + (b.x - a.x) * i / 4), y: Math.round(a.y + (b.y - a.y) * i / 4) }); await wait(25); }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...b }); await wait(180);
  };
  win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
  try {
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 300 && !await js('!!k3dAPI?.workbenchReady?.() && !!MolStudio?.document'); i++) await wait(100);
    const setup = await js(`(async()=>{
      await k3dAPI.setMolecule('');
      const p=MolStudio.document,a=MolWorkbench.app.adapter;
      p.init({mode:'paper',size:'A4'});
      const background=p.addShape({x:4,y:8,w:20,h:23,shape:'rect',band:'back',fill:'#f1f5f9'});
      p.fitPage();
      const bondButton=a.doc.querySelector('button[data-testid="bonds"]');
      if(!bondButton)throw new Error('Single bond toolbar button missing: '+[...a.doc.querySelectorAll('button')].map(b=>b.getAttribute('data-testid')).filter(Boolean).join(','));
      bondButton.click();
      window.__nativeObjectFixture={background};
      return {background,start:p.modelToClient({x:7,y:11}),end:p.modelToClient({x:9,y:11}),
        before:{atoms:a.struct().atoms.size,bonds:a.struct().bonds.size,object:p.getState().objects[0]}};
    })()`);
    await drag(setup.start, setup.end);
    const bond = await js(`(()=>{const a=MolWorkbench.app.adapter,p=MolStudio.document;return {atoms:a.struct().atoms.size,bonds:a.struct().bonds.size,object:p.getState().objects.find(o=>o.id===${JSON.stringify(setup.background)}),tool:a.ed.tool()?.constructor?.name};})()`);
    check('native bond gesture passes through a back rectangle and adds editable atoms and a bond', bond.atoms === 2 && bond.bonds === 1 && JSON.stringify(bond.object) === JSON.stringify(setup.before.object), { before: setup.before, after: bond });
    const atomPoint = await js(`(()=>{const a=MolWorkbench.app.adapter,p=MolStudio.document;p.setTool('select');p.select([${JSON.stringify(setup.background)}]);a.clearSelection();return p.modelToClient([...a.struct().atoms.values()][0].pp);})()`);
    const click = point(atomPoint);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...click });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...click });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...click }); await wait(150);
    const selected = await js('MolStudio.document.getSelection()');
    check('selection hits the visible atom above the rectangle instead of selecting the background', selected.atoms.length >= 1 && selected.objects.length === 0, selected);
    const native = await js(`(()=>{
      const a=MolWorkbench.app.adapter,ed=a.ed,st=a.struct(),n=a.doc.defaultView.molstudioNativeActions;
      const atoms=[...st.atoms];const first=atoms[0][1].pp;
      const x=first.x,y=first.y;
      for(const[id,atom]of atoms){atom.pp.x=10+(atom.pp.x-x)*1.7;atom.pp.y=20+(atom.pp.y-y)*1.7;ed.render.ctab.markAtom(id,1);}
      for(const[id]of st.bonds)ed.render.ctab.markBond(id,1);
      ed.update(true);
      ed.update(n.createText(ed.render.ctab,'Native text remains editable',{x:13,y:25}));
      const fragment=n.prepareKet(JSON.stringify({root:{nodes:[{type:'arrow',data:{mode:'open-angle',pos:[{x:10,y:-28,z:0},{x:18,y:-28,z:0}]}}]}}));
      const[action,,added]=n.paste(ed.render.ctab,fragment,{x:14,y:28});ed.update(action);
      window.__nativeGeometry=()=>{const st=MolWorkbench.app.adapter.struct();return {
        atoms:[...st.atoms.values()].map(a=>({label:a.label,x:a.pp.x,y:a.pp.y})),
        texts:[...st.texts.values()].map(t=>({content:t.content,position:{x:t.position.x,y:t.position.y},pos:t.pos.map(p=>({x:p.x,y:p.y}))})),
        arrows:[...st.rxnArrows.values()].map(r=>r.pos.map(p=>({x:p.x,y:p.y}))),
        document:MolStudio.document.getState()};};
      return {geometry:__nativeGeometry(),arrow:added.rxnArrows[0],bondLengths:[...st.bonds.values()].map(b=>Math.hypot(st.atoms.get(b.begin).pp.x-st.atoms.get(b.end).pp.x,st.atoms.get(b.begin).pp.y-st.atoms.get(b.end).pp.y))};
    })()`);
    check('fixture contains a non-unit native bond, native text, and a straight reaction arrow', native.bondLengths.some(length => Math.abs(length - 1) > .5) && native.geometry.texts.length === 1 && native.geometry.arrows.length === 1, native);
    const source = await js('k3dAPI.serializeWorkbench()'); fs.writeFileSync(path.join(out, 'native-coordinate-fixture.molwork'), source);
    const loaded = await js('k3dAPI.loadWorkbench(' + JSON.stringify(source) + ')'); await wait(200);
    const reopened = await js('__nativeGeometry()');
    const equal = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const near = (x, y) => Math.abs(x - y) < 1e-5;
    const sameGeometry = (x, y) => equal(x.document,y.document) && x.atoms.length === y.atoms.length && x.atoms.every((a,i) => a.label===y.atoms[i].label && near(a.x,y.atoms[i].x) && near(a.y,y.atoms[i].y)) && x.texts.length===y.texts.length && x.texts.every((t,i)=>t.content===y.texts[i].content && near(t.position.x,y.texts[i].position.x) && near(t.position.y,y.texts[i].position.y) && t.pos.every((p,j)=>near(p.x,y.texts[i].pos[j].x)&&near(p.y,y.texts[i].pos[j].y))) && x.arrows.length===y.arrows.length && x.arrows.every((a,i)=>a.every((p,j)=>near(p.x,y.arrows[i][j].x)&&near(p.y,y.arrows[i][j].y)));
    check('molwork reopen preserves every authored native atom, text and reaction-arrow coordinate', loaded.ok && sameGeometry(native.geometry, reopened), { loaded, before: native.geometry, after: reopened });
    const mixed = await js(`(()=>{
      const p=MolStudio.document,a=MolWorkbench.app.adapter,ed=a.ed;p.selectAll();p.fitPage();ed.clearHistory();
      const start=p.modelToClient({x:6,y:10}),end=p.modelToClient({x:7.25,y:10.75}),f=document.getElementById('k').getBoundingClientRect();
      const lo=a.clientToModel({x:Math.round(start.x)-f.left,y:Math.round(start.y)-f.top}),hi=a.clientToModel({x:Math.round(end.x)-f.left,y:Math.round(end.y)-f.top});
      return {start,end,dx:hi.x-lo.x,dy:hi.y-lo.y,selection:p.getSelection(),nativeSelection:ed.selection(),geometry:__nativeGeometry()};
    })()`);
    await drag(mixed.start,mixed.end);
    const moved = await js('({geometry:__nativeGeometry(),history:MolWorkbench.app.adapter.ed.historySize()})');
    const movedPoint = (x,y) => near(x.x + mixed.dx,y.x) && near(x.y + mixed.dy,y.y);
    const allMoved = mixed.geometry.atoms.every((a,i)=>movedPoint(a,moved.geometry.atoms[i])) &&
      mixed.geometry.texts.every((t,i)=>movedPoint(t.position,moved.geometry.texts[i].position) && t.pos.every((p,j)=>movedPoint(p,moved.geometry.texts[i].pos[j]))) &&
      mixed.geometry.arrows.every((a,i)=>a.every((p,j)=>movedPoint(p,moved.geometry.arrows[i][j]))) &&
      mixed.geometry.document.objects.every((o,i)=>movedPoint(o,moved.geometry.document.objects[i]));
    check('real mixed drag moves native text, reaction arrow, atoms and document shape in one action', allMoved && moved.history.undo === 1, { before: mixed, after: moved });
    await js('k3dAPI.undo()'); await wait(160);
    const undone = await js('({geometry:__nativeGeometry(),history:MolWorkbench.app.adapter.ed.historySize()})');
    check('one undo restores every mixed native coordinate and document object', sameGeometry(mixed.geometry,undone.geometry) && undone.history.undo === 0 && undone.history.redo === 1, undone);
    await js('k3dAPI.redo()'); await wait(160);
    const redone = await js('__nativeGeometry()');
    check('one redo restores the complete mixed move',sameGeometry(moved.geometry,redone),redone);
    fs.writeFileSync(path.join(out,'mixed-native-editable.molwork'),await js('k3dAPI.serializeWorkbench()'));
    await js('MolStudio.document.select([]);MolStudio.document.fitPage()'); await wait(120);
    fs.writeFileSync(path.join(out,'canvas.png'),(await win.capturePage()).toPNG());
    report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error.stack || error); try { fs.writeFileSync(path.join(out,'failure.png'),(await win.capturePage()).toPNG()); } catch {} }
  finally { write();clearTimeout(watchdog);console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,passed:report.checks.filter(c=>c.pass).length,failure:report.failure,out},null,2));win.destroy();app.exit(report.ok?0:1); }
});
