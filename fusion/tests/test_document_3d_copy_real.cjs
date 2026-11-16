'use strict';
// Current canvas, isolated Electron profile and service; no model requests.
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const port = process.env.MOLSTUDIO_PORT || 49078;
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-3d-copy-validation');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-3d-copy-')));
const report = { application: 'MolStudio current canvas', page: 'fusion/canvas.html', build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout', checks: [], modelCalls: 0 };
let win, savedClipboard;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function backupClipboard() {
  const result = [];
  for (const item of await clipboard.read()) {
    const entries = [];
    for (const format of item.types) { try { const value = await item.getType(format); entries.push(format === 'electron application/bookmark' ? { format, bookmark: value } : { format, buffer: Buffer.from(await value.arrayBuffer()) }); } catch (_) {} }
    if (entries.length) result.push(entries);
  }
  return result;
}
async function restoreClipboard() {
  if (!savedClipboard) return; clipboard.clear();
  if (savedClipboard.length) await clipboard.write(savedClipboard.map(entries => new ClipboardItem(Object.fromEntries(entries.map(entry => [entry.format, entry.bookmark || new Blob([entry.buffer], { type: entry.format })])))));
  savedClipboard = undefined;
}
const watchdog = setTimeout(() => { report.ok = false; report.error = 'watchdog'; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); win?.destroy(); app.exit(2); }, 90000);
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1400, height: 1100, webPreferences: { backgroundThrottling: false } });
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  const check = (name, pass, details) => { report.checks.push({ name, pass: !!pass, ...(details && { details }) }); if (!pass) throw new Error(name); };
  try {
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
    for (let i = 0; i < 400 && !await js('!!window.k3dAPI?.workbenchReady?.()'); i++) await wait(50);
    await js(`(async () => {
      await k3dAPI.setMolecule('CCO');
      const app = MolWorkbench.app, c = app.documentController; c.init({ mode: 'paper' });
      const ex = await app.adapter.exportKetWithBindings();
      const generation = await MolWorkbench.documentObject3D.generate3D({ ket: JSON.stringify(ex.ket), keys: Object.keys(ex.ket).filter(k => ex.ket[k]?.type === 'molecule'), allowExample: true });
      if (!generation.ok) throw Error(generation.message);
      c.addMolecule3D({ molfile: generation.molblock, atomUuids: ex.bindings.atoms.map(a => a.id), x: 5, y: 10, w: 8, h: 6 });
      app.adapter.ed.clearHistory(); window.__original3DSource = await k3dAPI.serializeWorkbench();
    })()`);
    const original = await js('window.__original3DSource');
    const imported = await js(`(async () => {
      const app = MolWorkbench.app, c = app.documentController;
      const previousAtoms = new Set([...app.adapter.struct().atoms.keys()].map(id => app.adapter.uuidOfAtom(id)));
      const previousObjects = new Set(c.state.objects.map(o => o.id));
      const result = await c.importFile({ name: 'source-with-3d.molwork', text: window.__original3DSource }, { at: { x: 22, y: 24 } });
      const added = c.state.objects.find(o => !previousObjects.has(o.id));
      const newAtoms = [...app.adapter.struct().atoms.keys()].map(id => app.adapter.uuidOfAtom(id)).filter(id => !previousAtoms.has(id));
      return { result, source: added?.source?.atomUuids, newAtoms, undo: app.adapter.ed.historySize().undo };
    })()`);
    check('cross-file insertion remaps every preview source atom to the inserted chemistry', imported.result.ok && imported.source.length === imported.newAtoms.length && imported.source.every(id => imported.newAtoms.includes(id)), imported);
    check('source remapping joins the complete file insertion undo', imported.undo === 1);
    await js('k3dAPI.undo()');
    check('one undo removes imported preview and chemistry', await js('MolWorkbench.app.documentController.state.objects.length === 1 && MolWorkbench.app.adapter.struct().atoms.size === 3'));
    await js('k3dAPI.redo()');
    check('redo retains the remapped source identity', await js(`(()=>{const c=MolWorkbench.app.documentController,o=c.state.objects.find(o=>JSON.stringify(o.source?.atomUuids)===${JSON.stringify(JSON.stringify(imported.source))});return !!o;})()`));

    await js(`k3dAPI.loadWorkbench(${JSON.stringify(original)})`);
    win.show(); win.focus(); win.webContents.focus();
    await js('MolWorkbench.app.adapter.ed.clearHistory(); MolStudio.document.selectAll(); document.getElementById("k").focus(); MolWorkbench.app.adapter.ed.focusCliparea();');
    savedClipboard = await backupClipboard();
    const copy = await js(`(()=>{const f=document.getElementById('k'),w=f.contentWindow,d=f.contentDocument;window.__3dCopy=null;w.addEventListener('copy',e=>{window.__3dCopy={trusted:e.isTrusted,records:[...(e.clipboardData?.types||[])].map(format=>({format,value:e.clipboardData.getData(format)}))};},{once:true});d.execCommand('copy');return window.__3dCopy;})()`, true);
    await restoreClipboard();
    const records = copy?.records || [], side = records.find(record => record.format === 'application/x-molstudio-mechanism'), payload = side && JSON.parse(side.value);
    check('trusted mixed copy includes atom identity with no arrows lone pairs or steps', copy?.trusted && payload?.identity?.atoms?.length === 3 && payload.arrows.length === 0 && payload.lonePairs.length === 0 && !payload.reactionSteps, { trusted: copy?.trusted, atoms: payload?.identity?.atoms?.length });
    const previousAtoms = await js('[...MolWorkbench.app.adapter.struct().atoms.keys()].map(id=>MolWorkbench.app.adapter.uuidOfAtom(id))');
    await js(`(()=>{const w=document.getElementById('k').contentWindow,d=w.document,t=new w.DataTransfer();for(const record of ${JSON.stringify(records)})t.setData(record.format,record.value);d.querySelector('[data-cliparea="true"]').dispatchEvent(new w.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:t}));})()`);
    for (let i = 0; i < 100 && !await js('!!MolWorkbench.app.controller.nativePasteSession?.active'); i++) await wait(40);
    const target = await js('MolStudio.document.modelToClient({x:20,y:24})');
    const point = { x: Math.round(target.x), y: Math.round(target.y) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await wait(80);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await wait(120);
    const pasted = await js(`(()=>{const app=MolWorkbench.app,c=app.documentController,old=new Set(${JSON.stringify(previousAtoms)});return{objects:c.getState().objects,newAtoms:[...app.adapter.struct().atoms.keys()].map(id=>app.adapter.uuidOfAtom(id)).filter(id=>!old.has(id)),undo:app.adapter.ed.historySize().undo,result:app.controller.lastNativePasteResult};})()`);
    const copiedPreview = pasted.objects.find(object => object.source?.atomUuids?.some(id => !previousAtoms.includes(id)));
    check('real native paste links the copied preview to the new molecule', pasted.result?.ok && copiedPreview && copiedPreview.source.atomUuids.length === pasted.newAtoms.length && copiedPreview.source.atomUuids.every(id => pasted.newAtoms.includes(id)), { source: copiedPreview?.source, newAtoms: pasted.newAtoms, result: pasted.result });
    check('mixed copy source mapping creates exactly one undo action', pasted.undo === 1);
    await js('k3dAPI.undo()');
    check('one undo removes the mixed copy and retains the original preview source', await js(`(()=>{const c=MolWorkbench.app.documentController;return c.state.objects.length===1&&c.state.objects[0].source.atomUuids.every(id=>${JSON.stringify(previousAtoms)}.includes(id))&&MolWorkbench.app.adapter.struct().atoms.size===3;})()`));
    report.ok = true;
  } catch (error) { report.ok = false; report.error = String(error.stack || error); }
  finally { await restoreClipboard(); clearTimeout(watchdog); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(c => c.pass).length, total: report.checks.length, error: report.error, out })); win.destroy(); app.exit(report.ok ? 0 : 1); }
});
