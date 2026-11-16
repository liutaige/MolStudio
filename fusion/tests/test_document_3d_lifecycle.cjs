'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
require('../workbench/document-object-3d.js');
require('../workbench/document-clipboard.js');
require('../workbench/mechanism-controller.js');
const MW = globalThis.MolWorkbench;
const { DocumentController } = require('../workbench/document-controller.js');

const MOLFILE = 'lifecycle\n  MolStudio\n\n  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0\nM  END';
const PNG = 'data:image/png;base64,b2xk';
const CAMERA = { px: 0, py: 0, pz: 0, distance: 40 };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function generated() { return { ok: true, molblock: MOLFILE + '\n$$$$', previewDataUrl: 'data:image/png;base64,bmV3', camera: { ...CAMERA, px: 2 }, atomUuids: ['atom-0'], style: 'ballstick' }; }
function fixture() {
  const st = { atoms: new Map([[0, { pp: { x: 1, y: 2 } }]]), bonds: new Map(), texts: new Map() };
  let selection = { atoms: [0], bonds: [] }; const history = [];
  const ed = { render: { ctab: { markAtom() {}, markBond() {}, markItem() {} } }, struct: () => st,
    selection(value) { if (arguments.length) selection = value || {}; return selection; }, update() {} };
  const adapter = { ed, struct: () => st, atomPos: id => st.atoms.get(id)?.pp, uuidOfAtom: id => 'atom-' + id,
    atomIdOf: id => id === 'atom-0' ? 0 : null, clearSelection: () => ed.selection(null),
    schedule() {}, modelPerPixel: () => .01, bondLength: () => 1, zoom: () => 1,
    exportKetWithBindings: async () => ({ ok: true, ket: { mol0: { type: 'molecule' } }, bindings: { atoms: [{ id: 'atom-0', mol: 'mol0' }] } }),
    pushAction(back, forward) { history.push({ back, forward }); } };
  const mechanism = { model: new MW.model.MechanismModel(), tool: 'select', selection: new Set(), setTool() {}, emitSelection() {}, render() {}, pruneSelection() {}, hasNativeSelection: () => false };
  const document = { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  const win = { top: { document }, getSelection: () => null, molstudioNativeStructOps: { recalc() {} } };
  const c = new DocumentController({ adapter, mechanism, win, doc: document, iframe: {}, onStatus() {} });
  c.render = () => {}; c.clampPaperViewport = () => {}; c.active = true;
  c.state = MW.documentModel.createDocument({ mode: 'paper' });
  c.state.objects.push({ id: 'note', kind: 'text', band: 'front', x: 5, y: 6, w: 10, h: 2, rich: { text: 'note', fontSize: 12 } });
  return { c, history, undo() { history.pop().back(); } };
}
function addPreview(c) { return c.addMolecule3D({ molfile: MOLFILE, previewDataUrl: PNG, atomUuids: ['atom-0'], camera: CAMERA }); }

test('a document switch during the last snapshot await cancels the generated preview', async t => {
  const { c } = fixture(), entered = deferred(), snapshot = deferred(); let disposed = false;
  t.mock.method(MW.documentObject3D, 'generate3D', async () => ({ ok: true, molblock: MOLFILE }));
  const Session = MW.documentObject3D.InteractionSession;
  t.after(() => { MW.documentObject3D.InteractionSession = Session; });
  MW.documentObject3D.InteractionSession = class {
    async mount() {} async snapshot(options) {
      assert.deepEqual(options, { width: 640, height: 480, trim: true });
      entered.resolve(); return snapshot.promise;
    }
    async cameraJson() { return CAMERA; } dispose() { disposed = true; }
  };
  const pending = c.generateMolecule3D(['atom-0'], c.generation);
  await entered.promise; c.restore(MW.documentModel.createDocument({ mode: 'paper' }), 'new');
  snapshot.resolve(PNG);
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.cancelled, true); assert.equal(disposed, true);
  assert.equal(c.state.objects.length, 0); assert.equal(Object.keys(c.state.assets).length, 0);
});

test('a late insertion cannot write into a newly opened paper document', async t => {
  const { c, history } = fixture(), gate = deferred();
  t.mock.method(c, 'generateMolecule3D', () => gate.promise);
  const pending = c.insertMolecule3DPreview();
  c.restore(MW.documentModel.createDocument({ mode: 'paper' }), 'open'); gate.resolve(generated());
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(c.state.objects.length, 0); assert.equal(history.length, 0); assert.equal(c.pendingMolecule3DInsert, null);
});

test('switching documents while choosing a molecule never starts generation', async t => {
  const { c } = fixture(), chosen = deferred(); let calls = 0;
  const candidates = [{ atomUuids: ['atom-0'] }, { atomUuids: ['atom-1'] }];
  t.mock.method(c, 'molecule3DCandidates', () => candidates);
  c.onChooseMolecule3DTarget = () => chosen.promise;
  t.mock.method(c, 'generateMolecule3D', async () => { calls++; return generated(); });
  const pending = c.insertMolecule3DPreview();
  c.restore(MW.documentModel.createDocument({ mode: 'paper' }), 'open'); chosen.resolve(candidates[0]);
  assert.equal((await pending).cancelled, true); assert.equal(calls, 0);
});

test('repeated insert clicks share one pending operation and create one undo entry', async t => {
  const { c, history, undo } = fixture(), gate = deferred(); let calls = 0;
  t.mock.method(c, 'generateMolecule3D', () => { calls++; return gate.promise; });
  const first = c.insertMolecule3DPreview();
  assert.deepEqual(await c.insertMolecule3DPreview(), { ok: false, cancelled: true });
  assert.equal(calls, 1); gate.resolve(generated());
  const result = await first; assert.equal(result.ok, true); assert.equal(history.length, 1);
  assert.equal(c.state.objects.filter(o => o.kind === 'molecule3d').length, 1);
  assert.equal(Object.keys(c.state.assets).length, 1); assert.equal(c.pendingMolecule3DInsert, null);
  undo(); assert.equal(c.state.objects.filter(o => o.kind === 'molecule3d').length, 0); assert.equal(Object.keys(c.state.assets).length, 0);
});

test('failed generation releases the insertion guard for a later retry', async t => {
  const { c } = fixture(); let attempts = 0;
  t.mock.method(c, 'generateMolecule3D', async () => { if (++attempts === 1) throw new Error('offline'); return generated(); });
  await assert.rejects(c.insertMolecule3DPreview(), /offline/);
  assert.equal(c.pendingMolecule3DInsert, null); assert.equal((await c.insertMolecule3DPreview()).ok, true);
});

test('source regeneration updates the current object after an unrelated undo clones document state', async t => {
  const { c, undo } = fixture(), id = addPreview(c), previous = c.object(id), gate = deferred();
  t.mock.method(c, 'generateMolecule3D', () => gate.promise);
  const pending = c.updateMolecule3DFromSource(id);
  c.updateObject('note', { x: 99 }); undo(); assert.notEqual(c.object(id), previous);
  gate.resolve(generated()); assert.equal(await pending, true);
  assert.equal(c.object(id).molfile, generated().molblock); assert.deepEqual(c.object(id).camera, generated().camera);
  assert.equal(c.state.assets[c.object(id).previewAsset].data, 'bmV3'); assert.equal(Object.keys(c.state.assets).length, 1);
});

test('deleting a preview during regeneration prevents late resource and object writes', async t => {
  const { c } = fixture(), id = addPreview(c), gate = deferred();
  t.mock.method(c, 'generateMolecule3D', () => gate.promise);
  const pending = c.updateMolecule3DFromSource(id); c.adapter.clearSelection(); c.selection = new Set([id]); c.deleteSelection();
  const before = c.getState(); gate.resolve(generated());
  await assert.rejects(pending, /已变化/); assert.deepEqual(c.getState(), before); assert.equal(Object.keys(c.state.assets).length, 0);
});

test('changing the current preview while regeneration runs preserves the newer preview', async t => {
  for (const patch of [{ style: 'sphere' }, { camera: { ...CAMERA, px: 7 } }, { source: { atomUuids: ['atom-other'] } }]) {
    await t.test(Object.keys(patch)[0], async sub => {
      const { c } = fixture(), id = addPreview(c), gate = deferred();
      sub.mock.method(c, 'generateMolecule3D', () => gate.promise);
      const pending = c.updateMolecule3DFromSource(id); c.updateObject(id, patch); const before = c.getState();
      gate.resolve(generated()); await assert.rejects(pending, /已变化/); assert.deepEqual(c.getState(), before);
    });
  }
});

test('restoring an identical preview in another document still rejects late regeneration', async t => {
  const { c } = fixture(), id = addPreview(c), gate = deferred();
  t.mock.method(c, 'generateMolecule3D', () => gate.promise);
  const pending = c.updateMolecule3DFromSource(id); c.restore(c.getState(), 'open'); const before = c.getState();
  gate.resolve(generated()); await assert.rejects(pending, /已变化/); assert.deepEqual(c.getState(), before);
});

test('declining stereo example returns cancellation without repeating the rejected service request', async t => {
  const { c } = fixture(); let calls = 0;
  t.mock.method(MW.documentObject3D, 'generate3D', async () => { calls++; return { ok: false, code: 'stereo_choice_required', stereo: {} }; });
  c.onStereoChoiceRequired = async () => false;
  assert.deepEqual(await c.generateMolecule3D(['atom-0'], c.generation), { ok: false, cancelled: true }); assert.equal(calls, 1);
});

test('generated example stereochemistry is retained from the actual service response shape', () => {
  const { c } = fixture();
  const notes = c.assembleMolecule3DNotes({ stereo: { example: true, reasons: ['tetrahedral_unspecified'] }, smiles: 'CC(O)F' });
  assert.equal(notes.stereoExample, true);
  assert.equal(c.assembleMolecule3DNotes({ stereo: { example: false } }).stereoExample, undefined);
});


test('mixed chemistry and linked preview copies retain atom identity even without arrows or lone pairs', () => {
  const { c } = fixture(), id = addPreview(c);
  c.selection = new Set([id]);
  c.adapter.syncIdentity = () => {};
  const controller = { adapter: c.adapter, selection: new Set(), documentController: c, model: c.mechanism.model,
    hasNativeSelection: () => true, focusedIsEditable: () => false, selectedArrows: () => [], ctx: () => ({}) };
  const payload = MW.controller.MechanismController.prototype.buildCopyPayload.call(controller, { allowNative: true });
  assert.equal(payload.native, true); assert.deepEqual(payload.identity.atoms.map(atom => atom.id), ['atom-0']);
  assert.deepEqual(payload.document.objects[0].source.atomUuids, ['atom-0']);
});

test('complete copied source identities are remapped in both preview and committed fragments', () => {
  const { c } = fixture(), id = addPreview(c);
  c.object(id).source.atomUuids = ['atom-0', 'atom-1']; c.selection = new Set([id]);
  const fragment = c.prepareFragment(c.clipboardFragment());
  c.remapFragmentSources(fragment, new Map([['atom-0', 'new-0'], ['atom-1', 'new-1']]));
  for (const objects of [fragment.sourceObjects, fragment.objects]) assert.deepEqual(objects[0].source.atomUuids, ['new-0', 'new-1']);
  assert.deepEqual(c.object(id).source.atomUuids, ['atom-0', 'atom-1'], 'the original preview remains linked to the original molecule');
});

test('preview-only and partial-source copies keep the complete original source link', () => {
  const { c } = fixture(), id = addPreview(c);
  c.object(id).source.atomUuids = ['atom-0', 'atom-1']; c.selection = new Set([id]);
  for (const mapping of [new Map(), new Map([['atom-0', 'new-0']])]) {
    const fragment = c.prepareFragment(c.clipboardFragment()); c.remapFragmentSources(fragment, mapping);
    assert.deepEqual(fragment.objects[0].source.atomUuids, ['atom-0', 'atom-1']);
  }
});
