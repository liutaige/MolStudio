'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../workbench/mechanism-export.js');
// MechanismLayer 依赖顺序：model / adapter（SVG_NS）先于 layer。
require('../workbench/mechanism-model.js');
require('../workbench/ketcher-adapter.js');
require('../workbench/mechanism-layer.js');
const exporter = globalThis.MolWorkbench.exporter;
const layerNS = globalThis.MolWorkbench.adapter.SVG_NS;
const I = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const multiply = (a, b) => ({ a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b,
  c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d,
  e: a.a * b.e + a.c * b.f + a.e, f: a.b * b.e + a.d * b.f + a.f });
const inherited = new Set(['fill', 'stroke', 'stroke-width', 'visibility', 'fill-opacity', 'stroke-opacity']);
const doc = { defaultView: { getComputedStyle: node => ({ getPropertyValue: key => {
  for (let current = node; current; current = inherited.has(key) ? current.parentElement : null) {
    if (current.attrs[key] !== undefined) return current.attrs[key];
  }
  return '';
} }) } };
class Node {
  constructor(tagName, attrs = {}, bbox = null, matrix = null) {
    Object.assign(this, { tagName, attrs, bbox, matrix, children: [], ownerDocument: doc, textContent: attrs.text || '' });
  }
  appendChild(node) { node.parentNode = node.parentElement = this; this.children.push(node); return node; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBBox() { return this.bbox; }
  getCTM() { return this.matrix; }
  querySelectorAll(selector) {
    const tags = selector.split(',');
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(node => selector === '*' || tags.includes(node.tagName));
  }
  cloneNode() {
    const clone = new Node(this.tagName, { ...this.attrs }, this.bbox, this.matrix);
    for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = this.parentElement = null;
  }
}
const box = (x, y, width, height) => ({ x, y, width, height });
const approx = (actual, expected) => {
  assert.ok(actual);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, key + ': ' + actual[key] + ' versus ' + expected[key]);
};

test('content bounds cancel camera transforms and accumulate every local SVG transform', () => {
  for (const camera of [I(), { a: 0.2, b: 0, c: 0, d: 0.2, e: -1000, f: 780 },
    { a: 4, b: 0, c: 0, d: 4, e: 260, f: -1400 }]) {
    const svg = new Node('svg', {}, null, camera), group = svg.appendChild(new Node('g'));
    const local = { a: 40, b: 0, c: 0, d: 40, e: 100, f: 200 };
    group.appendChild(new Node('path', {}, box(5, 6, 2, 3), multiply(camera, local)));
    approx(exporter.contentBBox(svg), box(300, 440, 80, 120));
    // The former untransformed model-unit leaf at (5,6) must not widen the union.
    approx(exporter.fullExportBBox(svg, {}, {}, {}), box(300, 440, 80, 120));
  }
});

test('rotated stroked shapes retain all four transformed corners and their painted stroke', () => {
  const svg = new Node('svg', {}, null, I());
  svg.appendChild(new Node('rect', { fill: 'none', stroke: '#b2bbc3', 'stroke-width': '2' },
    box(1, 2, 10, 2), { a: 0, b: 1, c: -1, d: 0, e: 50, f: 60 }));
  approx(exporter.contentBBox(svg), box(45, 60, 4, 12));
});

test('fallback transform lists are accumulated without consolidating or rewriting the live source', () => {
  const svg = new Node('svg'), parent = svg.appendChild(new Node('g'));
  const leaf = parent.appendChild(new Node('text', { text: 'legend' }, box(0, -5, 10, 5)));
  const lists = [[{ a: 1, b: 0, c: 0, d: 1, e: 100, f: 200 }], [{ a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 }]];
  for (const [i, node] of [parent, leaf].entries()) node.transform = { baseVal: {
    numberOfItems: lists[i].length, getItem: index => ({ matrix: lists[i][index] }),
    consolidate() { throw new Error('must not mutate a source transform'); }
  } };
  approx(exporter.contentBBox(svg), box(100, 185, 20, 15));
});

test('hidden and editor-only ancestors cannot expand the visible content bounds', () => {
  const svg = new Node('svg', {}, null, I());
  svg.appendChild(new Node('text', { text: 'visible' }, box(10, 20, 30, 8), I()));
  for (const [tag, attrs] of [['g', { class: 'mech-overlay' }], ['g', { class: 'mech-ghost' }],
    ['g', { opacity: '0' }], ['g', { display: 'none' }], ['g', { visibility: 'hidden' }],
    ['defs', {}], ['marker', {}]]) {
    svg.appendChild(new Node(tag, attrs)).appendChild(new Node('path', {}, box(-1000, -1000, 5000, 5000), I()));
  }
  svg.appendChild(new Node('rect', { fill: 'none', stroke: 'none' }, box(-100, -100, 500, 500), I()));
  approx(exporter.contentBBox(svg), box(10, 20, 30, 8));
});

test('only marked native scrollbars are stripped while identical grey user shapes and legends remain', () => {
  const svg = new Node('svg', {}, null, I());
  const attrs = { fill: '#b2bbc3', stroke: '#b2bbc3' };
  svg.appendChild(new Node('rect', { ...attrs, 'data-molstudio-ui': 'scrollbar' }, box(1000, 0, 4, 800), I()));
  svg.appendChild(new Node('rect', { ...attrs, 'data-testid': 'horizontal-bar' }, box(0, 900, 1200, 4), I()));
  svg.appendChild(new Node('rect', { ...attrs, id: 'user-grey-shape' }, box(10, 20, 4, 30), I()));
  svg.appendChild(new Node('text', { text: 'manual legend' }, box(20, 20, 50, 10), I()));
  svg.appendChild(new Node('path', { 'data-testid': 'rxn-arrow', stroke: 'black', 'stroke-width': '2' }, box(30, 40, 40, 0), I()));
  approx(exporter.contentBBox(svg), box(10, 20, 61, 30));
  const clone = exporter.cloneContent(svg);
  assert.equal(clone.querySelectorAll('rect').length, 1);
  assert.equal(clone.querySelectorAll('rect')[0].getAttribute('id'), 'user-grey-shape');
  assert.equal(clone.querySelectorAll('text,path').length, 2);
  assert.equal(svg.querySelectorAll('rect').length, 3, 'source must remain untouched');
});

test('native scrollbar marking is reproducible, idempotent and covered by the pinned upstream verifier', () => {
  const agent = require('../patch-ketcher-agent.cjs'), clipboard = require('../patch-ketcher-clipboard.cjs');
  const source = fs.readFileSync(agent.bundlePath, 'utf8');
  assert.equal(agent.patchSource(source).changed, false);
  assert.equal(clipboard.patchSource(source).changed, false);
  for (const patch of agent.patches) {
    const older = source.replace(patch.after, patch.before);
    assert.deepEqual(agent.patchSource(older), { source, changed: true });
  }
  for (const legacy of agent.legacyAfters) {
    const older = source.replace(agent.patches[0].after, legacy).replace(agent.patches[1].after, agent.patches[1].before);
    assert.equal(agent.patchSource(older).source, source);
  }
  assert.throws(() => agent.patchSource(source.replace('data-molstudio-ui', 'changed-scrollbar-marker')), /anchor|SHA-256/);
  assert.throws(() => clipboard.patchSource(source + '\n'), /SHA-256/);
});

test('scrollbar marking reaches the SVG node even when Raphael ignores unknown custom attributes', () => {
  const patch = require('../patch-ketcher-agent.cjs').patches[1];
  const attributes = new Map(), bar = { node: { setAttribute: (key, value) => attributes.set(key, value) },
    attr: () => bar, drag: () => bar };
  const draw = new Function('F', 'Q', 'B', 'R', 'V', 'var n;' + patch.after + ');');
  assert.equal(draw.call({ render: { paper: { rect: () => bar } }, COLOR: '#b2bbc3' }, 0, 0, 4, 100, 2), bar);
  assert.equal(attributes.get('data-molstudio-ui'), 'scrollbar');
});

test('export re-render of a broken arrow keeps the pending-rebind label out of the live overlay', () => {
  // 与 test_mechanism_export.cjs 其余 Node 桩同风格的轻量 SVG 节点。
  const makeEl = (tagName, parent) => {
    const node = { tagName, attrs: {}, children: [], parentNode: parent || null, textContent: '' };
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
    node.appendChild = child => { child.parentNode = node; node.children.push(child); return child; };
    return node;
  };
  const layer = new globalThis.MolWorkbench.layer.MechanismLayer(
    { zoom: () => 1, bondLength: () => 40 }, { createElementNS: (ns, tag) => makeEl(tag) });
  layer.body = makeEl('g');
  layer.overlay = makeEl('g');
  const M = globalThis.MolWorkbench.model;
  // 起点（类型 atom）绑定到已删除原子且无 last 坐标 → sourceOk=false → bad 提示
  const model = { state: { lonePairs: [], arrows: [M.makeArrow(
    { type: 'atom', atomId: 'at-gone' }, { type: 'free', x: 1, y: 0 }, { bend: 0, mode: 'manual' })] } };
  const ctx = { atomPos: () => null };
  const countText = (node, into) => {
    if (node.tagName === 'text' && /待重绑/.test(node.textContent)) into++;
    for (const child of node.children) into = countText(child, into);
    return into;
  };
  const u = 1 / 40;
  // 活画布渲染：警示文字属于 overlay 交互层
  layer.renderArrows(model, ctx, u, new Set(), {}, null, u);
  assert.equal(countText(layer.overlay, 0), 1, 'live canvas still shows the rebind hint');
  // 导出重渲染（mechanism-export.buildSvg 传入 targetGroup）：
  // 文字属于交互层（"不属于成品，导出剔除"），不得写进导出副本。
  const exportGroup = makeEl('g');
  layer.renderArrows(model, ctx, u, new Set(), {}, exportGroup, u);
  assert.equal(countText(exportGroup, 0), 0, 'export copy must not contain the rebind label');
  assert.equal(layer.overlay.children.length, 1,
    'export render must not add a second (lingering) label to the live overlay');
  // 复现用户报告的残留路径：导出前活 overlay 里还没有该提示（如刚打开文档），
  // 旧代码会凭空写进活 overlay 且 exportImage 之后无人 render()，标签一直挂着。
  layer.overlay.children.length = 0;
  layer.renderArrows(model, ctx, u, new Set(), {}, exportGroup, u);
  assert.equal(countText(layer.overlay, 0), 0, 'export must never write the label into the live overlay');
});
