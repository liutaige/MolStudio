'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/document-model.js');
const { DocumentController } = require('../workbench/document-controller.js');
const MW = global.MolWorkbench;
function fixture() {
  const st = Object.fromEntries(['atoms','bonds','texts','rxnArrows','rxnPluses','simpleObjects','images'].map(k => [k,new Map()]));
  let selected = {}, undo = [], redo = [];
  const ed = { render: { ctab: { markAtom() {},markBond() {},markItem() {} } }, struct: () => st,
    selection(value) { if (arguments.length) selected = value || {}; return selected; }, update() {}, tool() {} };
  const adapter = { ed,struct: () => st,clearSelection: () => ed.selection(null),syncIdentity() {},
    modelPerPixel: () => .01,clientToModel: p => p,schedule() {},syncVisualScalesFromDocument() {},
    pushAction(back,forward) { undo.push({back,forward});redo=[]; } };
  const mechanism = { model: new MW.model.MechanismModel(),selection: new Set(),tool: 'select',setTool() {},
    emitSelection() {},render() {},pruneSelection() {},hasNativeSelection: () => false };
  const c = new DocumentController({adapter,mechanism,doc:{},win:{},iframe:{},onStatus() {}});
  c.active = true;c.render = () => {};
  return {c, history: () => undo.length,undo() { const a=undo.pop();assert.ok(a);a.back();redo.push(a); },
    redo() { const a=redo.pop();assert.ok(a);a.forward();undo.push(a); }};
}
function rectangle(c, object) {
  const nodes=[];c.el=(tag,attrs,parent) => { const n={tag,attrs:{...attrs},children:[],setAttribute(k,v) {this.attrs[k]=v;}};nodes.push(n);parent?.children?.push(n);return n; };
  c.renderObject(object,{children:[]});return nodes.find(n=>n.tag==='rect').attrs;
}
test('drawing defaults do not dirty the document or create history; new shapes inherit them', () => {
  const f=fixture(),before=f.c.getState();
  f.c.setShapeStyle({fill:'#ff0000',fillColor:'#ff0000',stroke:{color:'#002244',width:.1,dash:'dashed'},cornerRadius:.6});
  assert.deepEqual(f.c.getState(),before);assert.equal(f.history(),0);
  const id=f.c.addShape({shape:'rect',w:6,h:4});
  const o=f.c.object(id);assert.equal(o.fill,'#ff0000');assert.equal(o.fillColor,'#ff0000');assert.equal(o.stroke.color,'#002244');assert.equal(o.stroke.width,.1);assert.equal(o.stroke.dash,'dashed');assert.equal(o.cornerRadius,.6);assert.equal(f.history(),1);
});
test('explicit fill in the existing addShape API wins over default fillColor on the visible SVG', () => {
  const f=fixture();f.c.setShapeStyle({fillColor:'#ffffff'});
  const o=f.c.object(f.c.addShape({shape:'rect',fill:'#ff0000'}));
  assert.equal(o.fillColor,'#ff0000');assert.equal(rectangle(f.c,o).fill,'#ff0000');
});
test('no fill retains a remembered picker colour without painting it', () => {
  const f=fixture();const o=f.c.object(f.c.addShape({shape:'rect',fill:'none',fillColor:'#123456'}));
  assert.equal(o.fillColor,'#123456');assert.equal(rectangle(f.c,o).fill,'none');
});
test('rectangle radius clamps to half the smaller dimension and accepts a square-corner zero', () => {
  const f=fixture(),id=f.c.addShape({shape:'rect',w:4,h:2,cornerRadius:99});
  assert.equal(rectangle(f.c,f.c.object(id)).rx,1);
  f.c.updateObject(id,{cornerRadius:0});assert.equal(rectangle(f.c,f.c.object(id)).rx,0);
  const legacy={...f.c.object(id),shape:'roundRect'};delete legacy.cornerRadius;
  assert.equal(rectangle(f.c,legacy).rx,.5);
});
test('radius defaults do not leak into non-rectangle objects', () => {
  const f=fixture();f.c.setShapeStyle({cornerRadius:2});
  for (const shape of ['line','ellipse','arrow','polygon','bracket']) {
    const o=f.c.object(f.c.addShape({shape}));assert.equal(Object.hasOwn(o,'cornerRadius'),false,shape);
  }
});
test('changing selected shape appearance is one undo and survives JSON document reopen', () => {
  const f=fixture(),id=f.c.addShape({shape:'rect',fill:'none',w:7,h:3});const old=f.c.object(id);
  f.c.updateObject(id,{fill:'#00aa66',fillColor:'#00aa66',cornerRadius:.7,stroke:{color:'#663399',width:.2,dash:'dashed'}});
  assert.equal(f.history(),2);assert.equal(f.c.object(id).x,old.x);assert.equal(f.c.object(id).w,7);
  const saved=JSON.parse(JSON.stringify(f.c.export()));
  f.undo();assert.equal(f.c.object(id).fill,'none');f.redo();assert.equal(f.c.object(id).cornerRadius,.7);
  const reopened=fixture();reopened.c.restore(saved);
  assert.deepEqual(reopened.c.object(id),f.c.object(id));assert.equal(rectangle(reopened.c,reopened.c.object(id)).fill,'#00aa66');
});
test('invalid default values fail without changing state, history or the last valid defaults', () => {
  const f=fixture(),before=JSON.parse(JSON.stringify(f.c.shapeStyle));
  for (const patch of [{cornerRadius:-1},{cornerRadius:Infinity},{fillColor:'javascript:alert(1)'},{stroke:{width:-2}},{stroke:{dash:'invalid'}}]) {
    assert.throws(()=>f.c.setShapeStyle(patch));assert.deepEqual(f.c.shapeStyle,before);assert.equal(f.history(),0);
  }
});
test('document validation rejects invalid persisted radius and picker colour', () => {
  const f=fixture();const id=f.c.addShape({shape:'rect'});const d=f.c.getState();
  d.objects.find(o=>o.id===id).cornerRadius=-1;assert.equal(MW.documentModel.validateDocument(d).ok,false);
  d.objects[0].cornerRadius=0;d.objects[0].fillColor='not-a-colour';assert.equal(MW.documentModel.validateDocument(d).ok,false);
});
