'use strict';
// MolStudio canvas (fusion/canvas.html), pure data and .molwork v2 regression.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
require('../workbench/workbench-storage.js');
const { model: M, documentModel: D, storage: S } = globalThis.MolWorkbench;
const empty = () => ({ ket: { root: { nodes: [] } }, bindings: { atoms: [], bonds: [] }, mechanism: M.emptyState() });
const txt = (overrides = {}) => ({ id: 'text-1', kind: 'text', band: 'front', x: 3.9, y: 4, w: 20, h: 3, rotation: 0, rich: { text: '中文 H₂O', fontSize: 12 }, ...overrides });
test('paper geometry uses physical dimensions, margins, stable identity and downward y', () => {
  let doc = D.createDocument({ mode: 'paper', size: 'Letter', orientation: 'landscape', pageCount: 2 });
  const pages = D.pageRects(doc);
  assert.equal(pages[0].w, 792 / 14.4); assert.equal(pages[0].h, 612 / 14.4);
  assert.equal(pages[1].y, pages[0].h + 2);
  assert.equal(pages[0].content.x, 56.7 / 14.4);
  assert.equal(D.pageAt(doc, { x: 1, y: pages[1].y + 1 }).id, pages[1].id);
  assert.equal(D.pageAt(doc, { x: 1, y: pages[0].h + 1 }), null);
  const first = pages[0].id, second = pages[1].id;
  doc.objects.push(txt({ pageId: second }));
  const extended = D.addPage(doc);
  assert.equal(extended.pages[0].id, first); assert.equal(extended.pages[1].id, second);
  const removed = D.removePage(extended, second);
  assert.equal(removed.objects[0].pageId, null); assert.equal(removed.objects[0].y, 4);
  assert.equal(doc.pageCount, 2); assert.equal(D.validateDocument(removed).ok, true);
});
test('v1 stays v1; paper and canvas with mixed content round trip as v2 without changing fields', () => {
  const bare = S.serializeWorkbench(empty());
  assert.equal(JSON.parse(bare).version, 1);
  assert.equal(S.serializeWorkbench(S.parseWorkbench(bare).doc), bare);
  for (const mode of ['paper', 'canvas']) {
    const doc = D.createDocument({ mode });
    doc.objects.push(txt(), { id: 'img-1', kind: 'image', band: 'back', x: 2, y: 8, w: 4, h: 5, asset: 'sha256-test', crop: { x: 0, y: 0, w: 1, h: 1 } },
      { id: 'shape-1', kind: 'shape', band: 'back', x: 1, y: 1, w: 2, h: 3, shape: 'rect', stroke: { color: '#111', width: .04 }, fill: '#fff' });
    doc.assets['sha256-test'] = { mime: 'image/png', data: 'aGVsbG8=' };
    doc.regions.push({ id: 'region-1', label: '路线 A', x: 0, y: 0, w: 30, h: 12 });
    const saved = S.serializeWorkbench({ ...empty(), document: doc });
    const loaded = S.parseWorkbench(saved);
    assert.equal(loaded.ok, true, loaded.error); assert.equal(loaded.doc.version, 2);
    assert.deepEqual(loaded.doc.document, doc);
    assert.equal(S.serializeWorkbench(loaded.doc), saved);
  }
  assert.equal(S.parseWorkbench(JSON.stringify({ ...JSON.parse(bare), version: 3 })).code, 'newer_version');
  assert.equal(S.parseWorkbench(JSON.stringify({ ...JSON.parse(bare), document: D.createDocument() })).ok, false);
});
test('reject invalid coordinates, IDs, resource references and markup', () => {
  const mutations = [
    d => { d.objects.push(txt({ x: Infinity })); },
    d => { d.objects.push(txt(), txt()); },
    d => { d.pages[0].id = ''; },
    d => { d.pageCount = 2; },
    d => { d.page.margins.left = d.page.width; },
    d => { d.ptPerBond = 1e-300; },
    d => { d.objects.push({ id: 'i', kind: 'image', x: 0, y: 0, w: 1, h: 1, asset: 'missing' }); },
    d => { d.objects.push(txt({ html: '<img src=x onerror=alert(1)>' })); },
    d => { d.objects.push(txt({ rich: { text: 'x', html: '<script>x</script>' } })); },
    d => { d.assets.a = { mime: 'image/svg+xml', data: 'PHN2Zz4=' }; },
    d => { d.assets.a = { mime: 'image/png', data: '!!!!' }; },
    d => { d.regions.push({ id: 'r', x: 0, y: 0, w: -1, h: 1 }); }
  ];
  for (const mutate of mutations) {
    const doc = D.createDocument({ mode: 'paper' }); mutate(doc);
    assert.equal(D.validateDocument(doc).ok, false);
    assert.throws(() => S.serializeWorkbench({ ...empty(), document: doc }));
  }
});
test('reject derived page coordinates that overflow the supported canvas', () => {
  const doc = D.createDocument({ mode: 'paper', pageCount: 100 });
  doc.ptPerBond = 0.5; // Each page is finite, but the last page would exceed 100000 units.
  assert.equal(D.validateDocument(doc).ok, false);
  const payload = { ...JSON.parse(S.serializeWorkbench(empty())), version: 2, document: doc };
  assert.equal(S.parseWorkbench(JSON.stringify(payload)).ok, false);
  assert.throws(() => D.createDocument({ mode: 'paper', ptPerBond: 1e-300 }));
});
test('image quota is separate from the 8 MB non-asset quota', () => {
  const doc = D.createDocument({ mode: 'paper' });
  doc.assets.large = { mime: 'image/png', data: 'A'.repeat(9 * 1024 * 1024) };
  const saved = S.serializeWorkbench({ ...empty(), document: doc });
  assert.equal(S.isWorkbenchText(saved), true);
  const parsed = S.parseWorkbench(saved);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.doc.document.assets.large.data.length, 9 * 1024 * 1024);
  const oversized = { ...JSON.parse(S.serializeWorkbench(empty())), version: 2, document: D.createDocument() };
  oversized.extra = '中'.repeat(3 * 1024 * 1024);
  assert.equal(S.parseWorkbench(JSON.stringify(oversized)).code, 'too_large');
});
