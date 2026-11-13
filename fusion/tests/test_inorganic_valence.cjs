/* Run with the development service on MOLSTUDIO_PORT (default 8879):
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/test_inorganic_valence.cjs */
'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const valence = require('../patch-ketcher-valence.cjs');
const clipboard = require('../patch-ketcher-clipboard.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function molecule(label, count, order = 1, charge = 0, radical = 0) {
  return JSON.stringify({ root: { nodes: [{ $ref: 'mol0' }] }, mol0: {
    type: 'molecule', atoms: [{ label, location: [0, 0, 0], charge, radical },
      ...Array.from({ length: count }, (_, i) => ({ label: order === 2 ? 'O' : 'F',
        location: [2 * Math.cos(2 * Math.PI * i / count), 2 * Math.sin(2 * Math.PI * i / count), 0] }))],
    bonds: Array.from({ length: count }, (_, i) => ({ type: order, atoms: [0, i + 1] }))
  } });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820 });
  try {
    const source = fs.readFileSync(valence.bundlePath, 'utf8');
    let originalValence = source;
    for (const patch of valence.patches) originalValence = originalValence.replace(patch.after, patch.before);
    assert.equal(valence.patchSource(source).changed, false);
    assert.equal(valence.patchSource(originalValence).source, source);
    let upstream = originalValence;
    for (const patch of clipboard.patches) upstream = upstream.replace(patch.after, patch.before);
    assert.equal(clipboard.patchSource(valence.patchSource(upstream).source).source, source);
    assert.equal(valence.patchSource(clipboard.patchSource(upstream).source).source, source);
    assert.throws(() => valence.patchSource(source + '\n'), /SHA-256/);

    await win.loadURL(`http://127.0.0.1:${process.env.MOLSTUDIO_PORT || 8879}/canvas.html`);
    const js = code => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('!!(window.k3dAPI && window.k3dAPI.isReady())')); i++) await wait(200);
    assert(await js('window.k3dAPI.isReady()'), 'Ketcher did not start');

    const cases = [
      ['Xe', 0, 1, false], ['Xe', 2, 1, false], ['Xe', 4, 1, false], ['Xe', 6, 1, false],
      ['Xe', 3, 2, false], ['Xe', 4, 2, false], ['Kr', 2, 1, false],
      ['S', 6, 1, false], ['P', 5, 1, false], ['I', 5, 1, false],
      ['Xe', 1, 1, true], ['Xe', 3, 1, true], ['Xe', 5, 1, true], ['Xe', 7, 1, true],
      ['Xe', 9, 1, true], ['Kr', 4, 1, true], ['Ne', 2, 1, true], ['C', 5, 1, true],
      ['F', 2, 1, true], ['Xe', 4, 1, true, 1], ['Xe', 4, 1, true, 0, 2],
      ['Cl', 3, 1, false], ['Br', 5, 1, false], ['I', 7, 1, false],
      ['P', 6, 1, false, -1], ['Si', 6, 1, false, -2], ['P', 6, 1, true]
    ];
    for (const [label, count, order, bad, charge = 0, radical = 0] of cases) {
      await js(`window.k3dAPI.setMolecule(${JSON.stringify(molecule(label, count, order, charge, radical))})`);
      const state = await js(`(() => {
        const frame = document.getElementById('k');
        const editor = frame.contentWindow.ketcher.editor;
        const atoms = Array.from(editor.struct().atoms.values());
        const atom = atoms.find(a => a.label === ${JSON.stringify(label)});
        return { bad: atom.badConn, h: atom.implicitH, n: atoms.length,
          warnings: editor.render.options.showValenceWarnings,
          red: Array.from(frame.contentDocument.querySelectorAll('path')).some(p => ['#f00', '#ff0000', 'red'].includes((p.getAttribute('stroke') || '').toLowerCase())) };
      })()`);
      assert.equal(state.bad, bad, `${label} bond sum ${count * order}, charge ${charge}, radical ${radical}`);
      assert.equal(state.h, 0, `${label}: no invented hydrogens`);
      assert.equal(state.n, count + 1, 'no added atoms');
      assert.equal(state.warnings, true, 'valence warnings remain enabled');
      assert.equal(state.red, bad, `${label}: rendered underline matches valence warning`);
    }
    console.log(`${cases.length} real Ketcher valence/rendering cases passed`);

    await js(`window.k3dAPI.setMolecule(${JSON.stringify(molecule('Xe', 4))})`);
    const ket = await js("document.getElementById('k').contentWindow.ketcher.getKet()");
    await js(`window.k3dAPI.setMolecule(${JSON.stringify(ket)})`);
    assert.equal(await js("Array.from(document.getElementById('k').contentWindow.ketcher.editor.struct().atoms.values()).some(a => a.badConn)"), false);
    const request = (route, payload) => js(`fetch(${JSON.stringify(route)}, { method: 'POST', headers: {'Content-Type':'application/json'}, body: ${JSON.stringify(JSON.stringify(payload))} }).then(async r => ({status:r.status, body:await r.json()}))`);
    const check = await request('/api/stereocheck', { ket });
    assert.equal(check.status, 200, JSON.stringify(check));
    assert.equal(check.body.ok, true);
    assert.equal(check.body.molecules[0].smiles, 'F[Xe](F)(F)F');
    const layout = await request('/api/layout', { ket });
    assert.equal(layout.status, 200, JSON.stringify(layout));
    assert.equal(layout.body.ok, true);
    const gen3d = await request('/api/gen3d', { ket });
    assert.equal(gen3d.status, 200, JSON.stringify(gen3d));
    assert.equal(gen3d.body.natoms, 5);
    assert.equal(gen3d.body.geometry.optimized, false);
    assert.match(gen3d.body.notes.join(';'), /参考几何/);
    assert(!gen3d.body.warnings, 'reference models must not be labelled as non-converged force fields');

    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../ketcher-local/inorganic-catalog.js'), 'utf8'), context);
    const catalog = context.window.molstudioInorganicCatalog;
    const examples = [];
    for (const entry of catalog) {
      const atoms = [{label: entry.center, charge: entry.charge, location: [0, 0, 0]}];
      const bonds = [];
      for (const [label, order, count] of entry.ligands) for (let i = 0; i < count; i++) {
        const index = atoms.length;
        atoms.push({label, location: [Math.cos(index) * 2, Math.sin(index) * 2, 0]});
        bonds.push({type: order, atoms: [0, index]});
      }
      const input = JSON.stringify({root: {nodes: [{$ref:'mol0'}]}, mol0: {type:'molecule', atoms, bonds}});
      await js(`window.k3dAPI.setMolecule(${JSON.stringify(input)})`);
      const state = await js(`(async () => {
        const editor = document.getElementById('k').contentWindow.ketcher.editor;
        return { bad: Array.from(editor.struct().atoms.values()).some(a => a.badConn),
                 ket: await window.k3dAPI.getKet() };
      })()`);
      assert.equal(state.bad, false, `${entry.center}: catalog drawing should not be underlined`);
      const result = await request('/api/gen3d', {ket: state.ket});
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.natoms, atoms.length, 'no invented H atoms');
      assert.equal(result.body.geometry.optimized, false);
      assert(result.body.stereoVerified.ok);
      examples.push(result.body);
    }
    console.log(`${catalog.length} catalog molecules: real Ketcher export → API 3D succeeded`);

    const viewer = new BrowserWindow({show: false, width: 720, height: 600});
    await viewer.loadURL(`http://127.0.0.1:${process.env.MOLSTUDIO_PORT || 8879}/threed.html?noimp`);
    const viewJS = code => viewer.webContents.executeJavaScript(code);
    for (let i = 0; i < 80 && !(await viewJS('!!window.k3d')); i++) await wait(100);
    assert(await viewJS('!!window.k3d'), '3D viewer did not start');
    const artifactDir = process.env.MOLSTUDIO_ARTIFACT_DIR;
    for (const name of ['XeF4', 'SF6', 'PF5', 'ClF3', 'IF7', 'XeF6']) {
      const example = examples.find(e => e.geometry.name === name);
      await viewJS(`window.k3d.show(${JSON.stringify(example.molblock)}, 'ballstick')`);
      for (let i = 0; i < 100 && !(await viewJS('!!comp')); i++) await wait(100);
      assert.equal(await viewJS('comp && comp.structure.atomCount'), example.natoms, name);
      assert.equal(await viewJS('comp && comp.structure.bondCount'), example.natoms - 1, name);
      assert.match(await viewJS("document.getElementById('geometry-note').textContent"), /未做力场优化/);
      if (name === 'XeF6') assert.match(await viewJS("document.getElementById('geometry-note').textContent"), /实际构型可畸变/);
      await viewJS('window.k3d.rotateXY(60, 35)');
      await wait(250);
      if (artifactDir) {
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, name + '-3d.png'), (await viewer.webContents.capturePage()).toPNG());
      }
    }
    await viewJS(`window.k3d.show(${JSON.stringify((await request('/api/gen3d', {data:'CCO'})).body.molblock)}, 'ballstick')`);
    assert.equal(await viewJS("document.getElementById('geometry-note').hidden"), true, 'ordinary molecule clears reference badge');
    console.log('6 representative NGL 3D models loaded and rotated; persistent model labels verified');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
