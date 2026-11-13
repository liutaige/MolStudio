// Actual Ketcher against an isolated local service. No model calls.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-agent-view-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const port = process.env.MOLSTUDIO_PORT || '48975';

async function checkCanvas(drawer) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 150 && !window.molstudioAgent?.getRuntime?.(); i++) await wait(100);
  window.molstudioAgent.open();
  await wait(150);
  const api = window.k3dAPI.agent;
  const adapter = window.MolWorkbench.app.adapter;
  const editor = adapter.ed;
  const pan = (x, y) => editor.render.setViewBox(view => ({ ...view, minX: view.minX + x, minY: view.minY + y }));
  const report = {};
  const verify = (name, pass) => { report[name] = !!pass; };
  const rightEdge = () => Math.min(editor.render.clientArea.getBoundingClientRect().right,
    window.molstudioAgent.getPanel().element.getBoundingClientRect().left);
  const inView = rect => {
    const area = editor.render.clientArea.getBoundingClientRect();
    return rect.left >= area.left && rect.right <= rightEdge() && rect.top >= area.top && rect.bottom <= area.bottom;
  };
  const atomInView = atom => {
    const p = adapter.modelToUser(atom);
    const screen = new adapter.doc.defaultView.DOMPoint(p.x, p.y).matrixTransform(adapter.canvasSvg().getScreenCTM());
    return inView({ left: screen.x, right: screen.x, top: screen.y, bottom: screen.y });
  };
  const previewInView = id => {
    const node = adapter.doc.querySelector(`[data-agent-op="${id}"]`);
    return !!node && inView(node.getBoundingClientRect());
  };
  await window.k3dAPI.setMolecule('');
  pan(2200, 1300);
  const initial = await api.getContext();
  const run = 'offscreen-placement';
  await api.beginRun(run);
  const area = editor.render.clientArea.getBoundingClientRect();
  const hidden = adapter.clientToModel({ x: rightEdge() + 60, y: (area.top + area.bottom) / 2 });
  const ops = drawer
    ? [{ id: 'hidden', type: 'molecule.add', smiles: 'CO', ...hidden }]
    : [
      { id: 'substrate', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
      { id: 'hidden', type: 'molecule.add', smiles: '[OH2:1]', x: 700, y: 850 },
    ];
  await api.previewOperations(ops, { runId: run });
  verify('unpositioned preview prefers the visible canvas', drawer || previewInView('substrate'));
  verify('explicit offscreen preview stays outside the visible canvas', !previewInView('hidden'));
  verify('preview is not committed', (await api.getContext()).atoms.length === 0);
  const receipt = await api.applyOperations(ops, { runId: run });
  const committed = await api.getContext();
  const remote = receipt.created.find(item => item.id === 'hidden');
  verify('explicit offscreen coordinates survive commit', Math.abs(remote.x - ops.at(-1).x) < 1e-6 && Math.abs(remote.y - ops.at(-1).y) < 1e-6);
  verify('explicit offscreen placement preserves camera', committed.viewport.viewBox === initial.viewport.viewBox);
  await api.endRun(run);
  if (drawer) return report;

  const tidyRun = 'tidy-in-panned-viewport';
  await api.beginRun(tidyRun);
  await api.applyOperations([{ id: 'tidy', type: 'layout.tidy' }], { runId: tidyRun });
  const local = (await api.getContext()).atoms.find(atom => atom.id === receipt.atomMapping['substrate:1']);
  verify('tidy keeps the local molecule visible', local && atomInView(local));
  await api.endRun(tidyRun);

  await window.k3dAPI.setMolecule('');
  const later = 'pan-between-preview-and-commit';
  await api.beginRun(later);
  const molecule = [{ id: 'later', type: 'molecule.add', smiles: 'CCO' }];
  await api.previewOperations(molecule, { runId: later });
  pan(1200, -900);
  await api.applyOperations(molecule, { runId: later });
  verify('commit checks the new viewport after a pan', (await api.getContext()).atoms.every(atomInView));
  await api.endRun(later);

  await window.k3dAPI.setMolecule('');
  editor.zoom(4);
  const oversized = 'oversized-in-zoomed-viewport';
  await api.beginRun(oversized);
  const before = await window.k3dAPI.serializeWorkbench();
  const undo = editor.historySize().undo;
  await api.applyOperations([
    { id: 'small', type: 'molecule.add', smiles: 'O' },
    { id: 'long', type: 'molecule.add', smiles: 'C'.repeat(90) },
  ], { runId: oversized });
  const expanded = await api.getContext();
  verify('an oversized molecule extends beyond the view without losing the batch', expanded.atoms.length === 91 &&
    expanded.atoms.some(atomInView) && expanded.atoms.some(atom => !atomInView(atom)) && editor.historySize().undo === undo + 1);
  await api.endRun(oversized);
  window.k3dAPI.undo();
  verify('one undo removes the complete offscreen batch', before === await window.k3dAPI.serializeWorkbench());
  return report;
}

app.whenReady().then(async () => {
  app.dock?.hide();
  let status = 0;
  for (const [width, drawer] of [[1180, false], [820, true]]) {
    const win = new BrowserWindow({ show: false, width, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: [`http://127.0.0.1:${port}/api/agent/model*`] }, (_details, cb) => cb({ cancel: true }));
    try {
      await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
      const report = await win.webContents.executeJavaScript(`(${checkCanvas})(${drawer})`);
      console.log(JSON.stringify({ width, report }));
      if (Object.values(report).includes(false)) status = 1;
    } catch (error) {
      console.error(error);
      status = 1;
    } finally { win.destroy(); }
  }
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(status);
});
