'use strict';
// Execute the injection emitted by the real Swift applyPending method in Ketcher.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = path.resolve(process.argv[2] || '/tmp/molstudio-regression/fixtures');
const out = path.resolve(process.env.MOLSTUDIO_NATIVE_TEST_OUT || path.join(fixtures, 'workbench-open'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'electron-profile'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Native open verification timed out'); app.exit(1); }, 60_000);

app.whenReady().then(async () => {
  const url = `http://127.0.0.1:${process.env.MOLSTUDIO_PORT || 48975}/canvas.html`;
  const win = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadURL(url);
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 150 && !(await js('!!window.k3dAPI?.workbenchReady?.()')); i++) await wait(100);
    assert.equal(await js('!!window.k3dAPI?.workbenchReady?.()'), true, 'Workbench did not start');
    const body = fs.readFileSync(path.join(fixtures, 'load-pretty-workbench.js'), 'utf8');
    assert.match(body, /window\.k3dAPI\.loadWorkbench\(/);
    assert.doesNotMatch(body, /setMolecule/);
    const result = JSON.parse(await js(`(async () => { ${body} })()`));
    assert.equal(result.ok, true, JSON.stringify(result));
    const snapshot = await js('window.k3dAPI.serializeWorkbench()');
    const document = JSON.parse(snapshot);
    const atoms = Object.values(document.ket).filter(value => value?.type === 'molecule')
      .reduce((count, molecule) => count + molecule.atoms.length, 0);
    const counts = { atoms, lonePairs: document.mechanism.lonePairs.length, arrows: document.mechanism.arrows.length };
    assert.deepEqual(counts, { atoms: 3, lonePairs: 1, arrows: 2 });
    fs.writeFileSync(path.join(out, 'pretty-open.molwork'), snapshot);
    const exported = await js('window.k3dAPI.exportMechanismImage("png")');
    assert.equal(exported.ok, true, JSON.stringify(exported));
    fs.writeFileSync(path.join(out, 'pretty-open.png'), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
    const report = { application: 'MolStudio canvas', page: url,
      build: process.env.MOLSTUDIO_TEST_BUILD || 'current source served by fusion/server.py',
      scope: 'Real Ketcher execution of native applyPending injection; not an AppKit file-panel test',
      fixture: 'F01.molwork formatted as pretty JSON with UTF-8 BOM', result, counts };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(watchdog);
    app.exit(1);
  }
});
