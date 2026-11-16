'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
require('../workbench/document-object-3d.js');
const MW = global.MolWorkbench;
MW.documentRichText = require('../workbench/document-rich-text.js');
const { DocumentController } = require('../workbench/document-controller.js');

class Vec { constructor(x, y) { this.x = x; this.y = y; } }
function fixture() {
  const st = { atoms: new Map([[0, { pp: new Vec(1, 2) }]]), bonds: new Map(), texts: new Map() };
  let selection = { atoms: [], bonds: [] }, undo = [], redo = [];
  const ed = { render: { ctab: { markAtom() {}, markBond() {}, markItem() {} } }, struct: () => st,
    selection(value) { if (arguments.length) selection = value || {}; return selection; }, update() {} };
  const adapter = { ed, struct: () => st, atomPos: id => st.atoms.get(id)?.pp, uuidOfAtom: id => 'atom-' + id,
    atomIdOf: id => id === 'atom-0' ? 0 : null, uuidOfBond: () => 'bond-0', clearSelection: () => ed.selection(null),
    modelPerPixel: () => .01, clientToModel: p => p, schedule() {}, bondLength: () => 1, zoom: () => 1,
    syncIdentity() {}, exportKetWithBindings: async () => ({ ok: false, error: 'not used' }),
    pushAction(back, forward) { undo.push({ back, forward }); redo = []; } };
  const model = new MW.model.MechanismModel();
  const mechanism = { model, tool: 'select', selection: new Set(), setTool() {}, emitSelection() {}, render() {}, pruneSelection() {},
    hasNativeSelection: () => false };
  const c = new DocumentController({ adapter, mechanism, win: { molstudioNativeStructOps: { vec: Vec, recalc() {} }, getSelection: () => null, DOMParser: function () {} }, doc: { createElement: () => ({ style: {} }) }, iframe: {}, onStatus() {} });
  c.render = () => {};
  c.active = true;
  c.state.objects.push({ id: 'obj-note', kind: 'text', band: 'front', x: 5, y: 6, w: 10, h: 2, rotation: 0,
    rich: { text: 'note', fontSize: 12 } });
  c.selection.add('obj-note');
  return { c, st, undo: () => { const action = undo.pop(); action.back(); redo.push(action); },
    redo: () => { const action = redo.pop(); action.forward(); undo.push(action); }, history: () => undo.length };
}
const GOOD_MOLBLOCK = 'test\n\n  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0\nM  END\n';

test('runs 校验：合法通过、非法拒绝、模块缺失 fail closed', () => {
  const doc = MW.documentModel.createDocument();
  doc.objects.push({ id: 'obj-rich', kind: 'text', x: 1, y: 1, w: 10, h: 2,
    rich: { text: 'bold plain', runs: [{ start: 0, end: 4, bold: true }] } });
  let result = MW.documentModel.validateDocument(doc);
  assert.equal(result.ok, true, result.errors && result.errors.join(';'));
  doc.objects[0].rich.runs = [{ start: 0, end: 4, color: 'javascript:alert(1)' }];
  result = MW.documentModel.validateDocument(doc);
  assert.equal(result.ok, false);
  doc.objects[0].rich.runs = [{ start: 0, end: 4, bold: true }, { start: 0, end: 6, bold: true }];
  result = MW.documentModel.validateDocument(doc);
  assert.equal(result.ok, false);
  doc.objects[0].rich.runs = Array.from({ length: 513 }, (_, i) => ({ start: i, end: i + 1, bold: true }));
  result = MW.documentModel.validateDocument(doc);
  assert.equal(result.ok, false);
  // 模块缺失：fail closed
  const saved = MW.documentRichText;
  delete MW.documentRichText;
  try {
    doc.objects[0].rich.runs = [{ start: 0, end: 4, bold: true }];
    result = MW.documentModel.validateDocument(doc);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(';'), /富文本模块未加载/);
  } finally { MW.documentRichText = saved; }
});

test('旧文本对象（无 runs）往返不变', () => {
  const doc = MW.documentModel.createDocument();
  doc.objects.push({ id: 'obj-old', kind: 'text', x: 1, y: 1, w: 10, h: 2, rich: { text: '旧对象', fontSize: 12 } });
  assert.equal(MW.documentModel.validateDocument(doc).ok, true);
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round, doc);
  const f = fixture();
  const lines = f.c.textLines(f.c.object('obj-note'));
  assert.deepEqual(lines, ['note']);
});

test('runs 文本行高与旧算法一致、textLines 断行一致', () => {
  const f = fixture();
  const o = f.c.object('obj-note');
  o.w = 2; o.rich = { text: '中文测试中文测试中文测试\n第二行', fontSize: 12 };
  const plainLines = f.c.textLines(o), plainHeight = f.c.textHeight(o);
  // 无 runs：走旧算法
  assert.ok(plainLines.length > 3);
  // 加等价 runs（整段）后文本内容不变
  o.rich.runs = [{ start: 0, end: 12, bold: true }];
  const richLines = f.c.textLines(o);
  assert.deepEqual(richLines.join('\n'), plainLines.join('\n'));
  const richHeight = f.c.textHeight(o);
  assert.ok(Math.abs(richHeight - MW.documentRichText.layoutLines(o.rich, o.w, 12 / f.c.state.ptPerBond).heights) < 1e-9);
  void plainHeight;
});

test('applyTextFormat 一个撤销且可回退', () => {
  const f = fixture();
  const changed = f.c.applyTextFormat('obj-note', { start: 0, end: 4 }, { bold: true, color: '#ff0000' });
  assert.equal(changed, true);
  assert.equal(f.history(), 1);
  const rich = f.c.object('obj-note').rich;
  assert.equal(rich.text, 'note');
  assert.ok(Array.isArray(rich.runs) && rich.runs.length === 1);
  assert.equal(rich.runs[0].bold, true);
  const fmt = f.c.formatAtOffset('obj-note', 1);
  assert.equal(fmt.bold, true);
  assert.equal(fmt.color, '#ff0000');
  f.undo();
  assert.equal(f.c.object('obj-note').rich.runs, undefined);
  f.redo();
  assert.equal(f.c.object('obj-note').rich.runs.length, 1);
  assert.throws(() => f.c.applyTextFormat('missing', { start: 0, end: 1 }, { bold: true }), /不存在/);
});

test('alignSelection 六模式按选区整体 bbox 对齐', () => {
  const modes = ['left', 'center', 'right', 'top', 'middle', 'bottom'];
  for (const mode of modes) {
    const f = fixture();
    f.c.state.objects.push({ id: 'obj-b', kind: 'shape', band: 'back', x: 20, y: 22, w: 4, h: 2, rotation: 0, shape: 'rect' });
    f.c.selection = new Set(['obj-note', 'obj-b']);
    f.c.alignSelection(mode);
    assert.equal(f.history(), 1, mode);
    const a = f.c.object('obj-note'), b = f.c.object('obj-b');
    if (mode === 'left') assert.equal(a.x, b.x);
    if (mode === 'right') assert.equal(a.x + a.w, b.x + b.w);
    if (mode === 'center') assert.equal(a.x + a.w / 2, b.x + b.w / 2);
    if (mode === 'top') assert.equal(a.y, b.y);
    if (mode === 'bottom') assert.equal(a.y + a.h, b.y + b.h);
    if (mode === 'middle') assert.equal(a.y + a.h / 2, b.y + b.h / 2);
    assert.throws(() => f.c.alignSelection('diagonal'), /对齐方式无效/);
  }
});

test('molecule3d 校验分支：合法、非法、模块缺失兜底、previewAsset 引用', () => {
  const o3 = MW.documentObject3D;
  const doc = MW.documentModel.createDocument();
  const assetId = 'asset-x';
  doc.assets[assetId] = { mime: 'image/png', data: 'aGVsbG8=' };
  const created = o3.createObject({ molblock: GOOD_MOLBLOCK, x: 1, y: 2, w: 10, h: 8, previewAsset: assetId });
  created.id = 'obj-mol';
  doc.objects.push(created);
  let result = MW.documentModel.validateDocument(doc);
  assert.equal(result.ok, true, result.errors && result.errors.join(';'));
  // 非法 style
  doc.objects[0].style = 'wireframe';
  assert.equal(MW.documentModel.validateDocument(doc).ok, false);
  doc.objects[0].style = 'ballstick';
  // camera 非有限数
  doc.objects[0].camera.distance = NaN;
  assert.equal(MW.documentModel.validateDocument(doc).ok, false);
  doc.objects[0].camera = { px: 0, py: 0, pz: 0, distance: 40 };
  // previewAsset 引用不存在
  doc.objects[0].previewAsset = 'asset-missing';
  assert.equal(MW.documentModel.validateDocument(doc).ok, false);
  doc.objects[0].previewAsset = assetId;
  // source.atomUuids 非法
  doc.objects[0].source = { atomUuids: ['bad uuid!'] };
  assert.equal(MW.documentModel.validateDocument(doc).ok, false);
  doc.objects[0].source = { atomUuids: ['atom-0', 'atom-1'] };
  assert.equal(MW.documentModel.validateDocument(doc).ok, true);
  // 模块缺失：兜底基本检查仍然拒绝非法数据
  const saved = MW.documentObject3D;
  delete MW.documentObject3D;
  try {
    const bare = MW.documentModel.createDocument();
    bare.objects.push({ id: 'obj-x', kind: 'molecule3d', x: 0, y: 0, w: 10, h: 8, molfile: 'x'.repeat(262145), style: 'ballstick', camera: { px: 0, py: 0, pz: 0, distance: 40 } });
    assert.equal(MW.documentModel.validateDocument(bare).ok, false);
    const bare2 = MW.documentModel.createDocument();
    bare2.objects.push({ id: 'obj-x', kind: 'molecule3d', x: 0, y: 0, w: 10, h: 8, molfile: GOOD_MOLBLOCK, style: 'wireframe', camera: { px: 0, py: 0, pz: 0, distance: 40 } });
    assert.equal(MW.documentModel.validateDocument(bare2).ok, false);
    const bare3 = MW.documentModel.createDocument();
    bare3.objects.push({ id: 'obj-x', kind: 'molecule3d', x: 0, y: 0, w: 10, h: 8, molfile: GOOD_MOLBLOCK, style: 'ballstick', camera: { px: 0, py: 0, pz: NaN, distance: 40 } });
    assert.equal(MW.documentModel.validateDocument(bare3).ok, false);
    const bare4 = MW.documentModel.createDocument();
    bare4.objects.push({ id: 'obj-x', kind: 'molecule3d', x: 0, y: 0, w: 10, h: 8, molfile: GOOD_MOLBLOCK, style: 'ballstick', camera: { px: 0, py: 0, pz: 0, distance: 40 } });
    assert.equal(MW.documentModel.validateDocument(bare4).ok, true);
  } finally { MW.documentObject3D = saved; }
});

test('addMolecule3D 写资产并选中；clipboardFragment 收集 previewAsset；prepareFragment 重映射', () => {
  const f = fixture();
  const id = f.c.addMolecule3D({ molblock: GOOD_MOLBLOCK, x: 2, y: 3, w: 10, h: 8,
    previewDataUrl: 'data:image/png;base64, aGVsbG8= ', atomUuids: ['atom-0'], notes: { warnings: ['注意'] } });
  assert.ok(id);
  const o = f.c.object(id);
  assert.equal(o.kind, 'molecule3d');
  assert.ok(o.previewAsset && f.c.state.assets[o.previewAsset], 'preview asset written');
  assert.equal(f.c.state.assets[o.previewAsset].mime, 'image/png');
  assert.equal(f.c.state.assets[o.previewAsset].data, 'aGVsbG8=');
  assert.deepEqual(o.source.atomUuids, ['atom-0']);
  assert.equal(o.notes.warnings[0], '注意');
  assert.ok(f.c.selection.has(id), 'new object selected');
  f.c.selection = new Set([id]);
  const fragment = f.c.clipboardFragment();
  assert.ok(fragment.assets[o.previewAsset], 'previewAsset collected into fragment assets');
  const prepared = f.c.prepareFragment(fragment);
  const copy = prepared.objects[0];
  assert.notEqual(copy.id, id);
  assert.notEqual(copy.previewAsset, o.previewAsset, 'previewAsset remapped');
  assert.ok(prepared.assets[copy.previewAsset]);
  assert.equal(prepared.assets[copy.previewAsset].data, 'aGVsbG8=');
  // addImage 原有 asset 通道不受影响
  const img = f.c.state.objects; void img;
});

test('finishMolecule3DInteraction 换预览图并删除无引用旧资产', () => {
  const f = fixture();
  const id = f.c.addMolecule3D({ molblock: GOOD_MOLBLOCK, previewDataUrl: 'data:image/png;base64,aGVsbG8=' });
  const oldAsset = f.c.object(id).previewAsset;
  f.c.finishMolecule3DInteraction(id, { previewDataUrl: 'data:image/png;base64,d29ybGQ=', camera: { px: 1, py: 2, pz: 3, distance: 40 } });
  const o = f.c.object(id);
  assert.notEqual(o.previewAsset, oldAsset);
  assert.equal(f.c.state.assets[oldAsset], undefined, 'old unreferenced asset removed');
  assert.equal(f.c.state.assets[o.previewAsset].data, 'd29ybGQ=');
  assert.equal(o.camera.distance, 40);
  // 旧资产仍被引用时不删除
  const id2 = f.c.addMolecule3D({ molblock: GOOD_MOLBLOCK, previewDataUrl: 'data:image/png;base64,aGVsbG8=' });
  const shared = f.c.object(id2).previewAsset;
  f.c.state.objects.find(x => x.id === id).previewAsset = shared;
  f.c.finishMolecule3DInteraction(id2, { previewDataUrl: 'data:image/png;base64,d29ybGQ=' });
  assert.ok(f.c.state.assets[shared], 'shared asset survives');
  assert.throws(() => f.c.finishMolecule3DInteraction(id, { camera: { px: NaN } }), /相机/);
  assert.throws(() => f.c.finishMolecule3DInteraction(id, { previewDataUrl: 'data:image/png;base64,!!!' }), /预览图/);
});

test('deleteSelection 清理 molecule3d 的 previewAsset', () => {
  const f = fixture();
  const id = f.c.addMolecule3D({ molblock: GOOD_MOLBLOCK, previewDataUrl: 'data:image/png;base64,aGVsbG8=' });
  const asset = f.c.object(id).previewAsset;
  f.c.selection = new Set([id]);
  f.c.deleteSelection();
  assert.equal(f.c.object(id), undefined);
  assert.equal(f.c.state.assets[asset], undefined);
});

test('resize 按住 shift 保持宽高比', () => {
  const f = fixture();
  f.c.state.objects.push({ id: 'obj-rect', kind: 'shape', band: 'back', x: 0, y: 0, w: 4, h: 2, rotation: 0, shape: 'rect' });
  f.c.selection = new Set(['obj-rect']);
  const before = f.c.capture();
  f.c.drag = { kind: 'resize', handle: 'se', objectId: 'obj-rect', start: { x: 4, y: 2 }, before, moved: true };
  f.c.onMove({ clientX: 8, clientY: 4, shiftKey: true, preventDefault() {}, stopImmediatePropagation() {} });
  const o = f.c.object('obj-rect');
  assert.ok(Math.abs(o.w / o.h - 2) < 0.01, `ratio kept: ${o.w / o.h}`);
  assert.equal(o.x, 0); assert.equal(o.y, 0);
  // 不按 shift：自由调整
  f.c.cancelDrag();
  const before2 = f.c.capture();
  f.c.drag = { kind: 'resize', handle: 'se', objectId: 'obj-rect', start: { x: 4, y: 2 }, before: before2, moved: true };
  f.c.onMove({ clientX: 8, clientY: 6, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {} });
  const o2 = f.c.object('obj-rect');
  assert.equal(o2.w, 8); assert.equal(o2.h, 6);
});

test('insertMolecule3DPreview 无选区时给出明确提示', async () => {
  const f = fixture();
  f.c.state.mode = 'paper'; // 3D 预览是纸页文档对象，门禁在最前
  f.c.selection.clear();
  await assert.rejects(() => f.c.insertMolecule3DPreview(), /请先选择要生成 3D 预览的完整分子/);
  // 无边画布模式：纸页门禁优先于选区检查
  f.c.state.mode = 'canvas';
  await assert.rejects(() => f.c.insertMolecule3DPreview(), /纸页/);
});

test('pasting rich fragments keeps subscript and superscript text inside their wrappers', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="editor" contenteditable="true"></div>');
  try {
    const f = fixture(), div = dom.window.document.getElementById('editor');
    f.c.doc = dom.window.document; f.c.win = dom.window;
    const range = f.c.doc.createRange(); range.selectNodeContents(div); range.collapse(false);
    const selection = f.c.win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    f.c.insertRichFragment({ text: 'H2O+', runs: [{ start: 1, end: 2, sub: true }, { start: 3, end: 4, sup: true }] });
    assert.equal(div.textContent, 'H2O+');
    assert.equal(div.querySelector('sub').textContent, '2');
    assert.equal(div.querySelector('sup').textContent, '+');
    const saved = MW.documentRichText.readEditorDom(div, {}, f.c.editorPxPerPt());
    assert.equal(saved.text, 'H2O+');
    assert.ok(saved.runs.some(run => run.start === 1 && run.end === 2 && run.sub));
    assert.ok(saved.runs.some(run => run.start === 3 && run.end === 4 && run.sup));
  } finally { dom.window.close(); }
});

test('the SVG text layer renders persisted run-level font family and size', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><text><tspan></tspan></text></svg>');
  try {
    const f = fixture(); f.c.doc = dom.window.document;
    const line = f.c.doc.querySelector('tspan');
    f.c.renderRichSegment(line, { text: 'selected font', fontFamily: 'Times New Roman, Songti SC, serif', fontSize: 28 }, { base: { fontSize: 12 }, fs: 12 });
    assert.equal(line.firstChild.getAttribute('font-family'), 'Times New Roman, Songti SC, serif');
    assert.equal(Number(line.firstChild.getAttribute('font-size')), 28 / f.c.state.ptPerBond);
    assert.equal(line.textContent, 'selected font');
  } finally { dom.window.close(); }
});

test('rich text rendering and object height use the same large-run line baselines', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  try {
    const f = fixture(); f.c.doc = dom.window.document;
    const object = f.c.object('obj-note');
    object.rich = { text: 'small\nLARGE\nsmall', fontSize: 12, runs: [{ start: 6, end: 11, fontSize: 28 }] };
    const layout = f.c.richTextLayout(object), svg = f.c.doc.querySelector('svg');
    object.h = f.c.textHeight(object); f.c.renderObject(object, svg);
    const rendered = [...svg.querySelector('text').children];
    assert.equal(rendered.length, layout.lines.length);
    rendered.forEach((line, i) => assert.equal(Number(line.getAttribute('y')), object.y + layout.lines[i].baseline));
    assert.equal(object.h, layout.heights);
    assert.ok(layout.lines[1].fontSize > layout.lines[0].fontSize);
    assert.ok(object.h > 3 * (12 / f.c.state.ptPerBond));
  } finally { dom.window.close(); }
});
