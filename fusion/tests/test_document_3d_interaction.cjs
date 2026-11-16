'use strict';
// Async commit boundary tests complement the real canvas Undo/source-change regression.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/document-ui.js');
const { DocumentUI } = globalThis.MolWorkbench.documentUI;
function fixture() {
  let current = { id: 'm3', kind: 'molecule3d', molfile: 'original', source: { atomUuids: ['a'] },
    style: 'stick', camera: { px: 0, py: 0, pz: 0, distance: 20 }, previewAsset: 'asset-1', x: 0, y: 0, w: 16, h: 12 };
  const notices = [];
  let commits = 0, begin, release; const previewCalls = [];
  const began = new Promise(resolve => { begin = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const controller = { generation: 1, object: () => current, status: text => notices.push(text),
    finishMolecule3DInteraction: (_id, result) => {
      commits++; current = { ...current, camera: result.camera, previewAsset: 'asset-2' };
      ui.reposition3DOverlay(); // A normal commit emits a synchronous render.
    } };
  const ui = new DocumentUI({ controller });
  ui.cleanup3DOverlay = (st, result) => { st.done = true; st.result = result; ui.active3D = null; };
  ui.position3DOverlay = () => {};
  const st = { id: current.id, object: current, generation: 1, ready: true, draft: false, done: false,
    signature: ui.molecule3DContentSignature(current), controls: { children: [] }, host: { style: {} }, operation: Promise.resolve(),
    session: { style: 'stick', spin: async () => {}, cameraJson: async () => ({ px: 0, py: 0, pz: 0, distance: 22 }),
      snapshot: async options => { previewCalls.push(options); begin(); await pending; return 'data:image/png;base64,AA=='; } } };
  ui.active3D = st;
  return { ui, st, began, release, notices, previewCalls: () => previewCalls,
    setCurrent: value => { current = value; }, current: () => current, commits: () => commits };
}
test('content changed without a render while snapshot awaits cannot receive the old camera/PNG', async () => {
  const f = fixture(), result = f.ui.finish3DInteraction();
  await f.began;
  const updated = { ...f.current(), molfile: 'replacement', previewAsset: 'new-source-preview' };
  f.setCurrent(updated); f.release();
  assert.equal(await result, false);
  assert.equal(f.commits(), 0);
  assert.equal(f.current(), updated);
  assert.equal(f.st.result.cancelled, true);
  assert.match(f.notices[0], /对象已更改/);
});
test('position-only state replacement remains editable and own commit render does not cancel it', async () => {
  const f = fixture(), result = f.ui.finish3DInteraction();
  await f.began;
  f.setCurrent({ ...f.current(), x: 7, y: 9 });
  f.ui.reposition3DOverlay();
  assert.equal(f.ui.active3D, f.st);
  f.release();
  assert.equal(await result, true);
  assert.equal(f.commits(), 1);
  assert.equal(f.current().x, 7);
  assert.equal(f.st.result.ok, true);
  assert.deepEqual(f.previewCalls(), [{ width: 640, height: 480, trim: true }]);
  assert.deepEqual(f.notices, []);
});
