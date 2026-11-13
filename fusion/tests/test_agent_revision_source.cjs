'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { revisionSource } = require('../workbench/agent-bridge.js');
const fixture = () => ({ root: { nodes: [{ type: 'text', boundingBox: { x: 10, y: -12, width: 1.914453125, height: 0.375 },
  paragraphs: [{ parts: [{ text: 'KOH / MeOH' }], indent: 0 }], indent: 0 },
{ type: 'image', boundingBox: { x: 0, y: 0, width: 10, height: 6 } }] },
  mol0: { atoms: [{ location: [1, 2, 0], selected: true, initiallySelected: false }], bonds: [] } });

test('native text measurement drift does not change the authored revision source', () => {
  const original = fixture(), measured = structuredClone(original), snapshot = JSON.stringify(original);
  measured.root.nodes[0].boundingBox.width = 1.91233139038086;
  measured.root.nodes[0].boundingBox.height = 0.35050282478332484;
  assert.deepEqual(revisionSource(original), revisionSource(measured));
  assert.equal(JSON.stringify(original), snapshot, 'fingerprinting does not rewrite the saved KET');
});

test('text anchor movement, rich content and formatting remain revision-fenced', () => {
  for (const mutate of [value => { value.boundingBox.x += 0.1; }, value => { value.boundingBox.y += 0.1; },
    value => { value.paragraphs[0].parts[0].text = 'NaOMe'; },
    value => { value.paragraphs[0].parts[0].fontSize = 18; }, value => { value.indent = 1; }]) {
    const original = fixture(), edited = structuredClone(original); mutate(edited.root.nodes[0]);
    assert.notDeepEqual(revisionSource(original), revisionSource(edited));
  }
});

test('chemical coordinates and non-text geometry remain revision-fenced', () => {
  const original = fixture(), resized = structuredClone(original), moved = structuredClone(original);
  resized.root.nodes[1].boundingBox.width += 1; moved.mol0.atoms[0].location[0] += 0.1;
  assert.notDeepEqual(revisionSource(original), revisionSource(resized));
  assert.notDeepEqual(revisionSource(original), revisionSource(moved));
  const selected = structuredClone(original); selected.mol0.atoms[0].selected = false;
  assert.deepEqual(revisionSource(original), revisionSource(selected));
});
