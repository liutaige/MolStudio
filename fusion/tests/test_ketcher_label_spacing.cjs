// Run with Electron against a private MolStudio server on MOLSTUDIO_PORT.
'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-labels-'));
app.setPath('userData', profile);
const deadline = setTimeout(() => app.exit(2), 40_000);

async function probe() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 160 && !window.k3dAPI?.workbenchReady?.(); i++) await wait(100);
  const { ed } = MolWorkbench.app.adapter;
  const api = k3dAPI.agent;
  const operations = [
    { id: 'urea', type: 'molecule.add', smiles: 'CNC(=O)NC' },
    { id: 'acid', type: 'molecule.add', smiles: '[OH]N=O' },
    { id: 'water', type: 'molecule.add', smiles: 'O' }
  ];

  function readSpacing() {
    const spacing = {};
    for (const atom of ed.render.ctab.atoms.values()) {
      if (!atom.showLabel || !atom.a.implicitH) continue;
      const letters = atom.visel.paths.filter(glyph => glyph.type === 'text').map(glyph => {
        const rect = glyph.node.getBoundingClientRect();
        return { text: glyph.node.textContent, x: rect.x, width: rect.width };
      }).sort((a, b) => a.x - b.x);
      if (!letters.some(letter => letter.text === 'H')) continue;
      const label = letters.map(letter => letter.text).join('');
      const gap = Math.min(...letters.slice(1).map((right, index) => {
        const left = letters[index];
        return (right.x - left.x - left.width) / Math.min(right.width, left.width);
      }));
      spacing[label] = Math.min(gap, spacing[label] ?? Infinity);
    }
    return spacing;
  }

  const result = {};
  for (const zoom of [1, 0.5]) {
    await k3dAPI.clear();
    ed.zoom(zoom);
    const runId = 'label-spacing-' + zoom;
    await api.beginRun(runId);
    await api.applyOperations(operations, { runId });
    await api.endRun(runId);
    result[zoom] = readSpacing();
  }
  return result;
}

app.whenReady().then(async () => {
  app.dock?.hide();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  let status = 0;
  try {
    assert.ok(process.env.MOLSTUDIO_PORT, 'Set MOLSTUDIO_PORT to an isolated test server');
    await win.loadURL('http://127.0.0.1:' + process.env.MOLSTUDIO_PORT + '/canvas.html');
    const spacing = await win.webContents.executeJavaScript('(' + probe.toString() + ')()');
    for (const label of ['H3C', 'CH3', 'NH', 'HO', 'H2O']) {
      assert.ok(Number.isFinite(spacing[1][label]) && Number.isFinite(spacing[0.5][label]), label);
      assert.ok(Math.abs(spacing[1][label] - spacing[0.5][label]) < 0.06,
        label + ' spacing changes at 50% zoom: ' + JSON.stringify(spacing));
    }
    console.log('PASS native atom glyph spacing stays proportional at 50% zoom');
  } catch (error) {
    console.error(error);
    status = 1;
  } finally {
    clearTimeout(deadline);
    win.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(status);
  }
});
