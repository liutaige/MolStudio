'use strict';
// Pure clipboard sidecar tests for current canvas; native paste is integration-tested separately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
const C = require('../workbench/document-clipboard.js');
const M = globalThis.MolWorkbench.model;
function fixture() {
  const st = { atoms: new Map([[1, {label:'O', pp:{x:1,y:2}}], [2, {label:'C', pp:{x:2,y:2}}]]), bonds: new Map([[4, {begin:1,end:2,type:1}]]) };
  const ids = new Map([[1,'a-O'],[2,'a-C']]), bondIds = new Map([[4,'bond-O-C']]);
  const selection = { atoms:[1,2], bonds:[4] };
  const lp = { ...M.makeLonePair('a-O', {origin:'manual',angle:30,refAtomId:'a-C',angleRel:40}), id:'lp-old' };
  const controller = { adapter: { ed:{selection:()=>selection}, struct:()=>st, syncIdentity(){},
    atomPos:rid=>st.atoms.get(rid)?.pp, uuidOfAtom:rid=>ids.get(rid), uuidOfBond:rid=>bondIds.get(rid) },
    model:{state:{lonePairs:[lp]}}, selection:new Set(), ctx:()=>({atomPos:uuid=>st.atoms.get([...ids].find(([,v])=>v===uuid)?.[0])?.pp}) };
  return { controller, st, ids, bondIds, selection, lp };
}
function insert(f, transform) {
  f.st.atoms.set(8,{label:'O',pp:transform({x:1,y:2})}); f.ids.set(8,'new-O');
  f.st.atoms.set(9,{label:'C',pp:transform({x:2,y:2})}); f.ids.set(9,'new-C');
  f.st.bonds.set(10,{begin:8,end:9,type:1}); f.bondIds.set(10,'new-bond');
}
test('copies owned lone pairs and remaps endpoints after a native paste in one sidecar', () => {
  const f=fixture(), snapshot=C.capture(f.controller);
  assert.equal(snapshot.lonePairs.length,1); assert.deepEqual(snapshot.selectedMechanismIds,['lp-old']);
  const session=C.stage(snapshot,f.controller); C.move(session,{scale:1,rotation:Math.PI/2,origin:{x:0,y:0},target:{x:10,y:20}});
  insert(f, p=>({x:10-p.y,y:20+p.x}));
  const result=C.resolve(f.controller,session); assert.equal(result.ok,true,result.error);
  assert.equal(result.lonePairs[0].ownerAtomId,'new-O'); assert.equal(result.lonePairs[0].refAtomId,'new-C');
  assert.equal(result.lonePairs[0].angleRel,40); assert.ok(Math.abs(result.lonePairs[0].angle-130)<1e-8);
  assert.notEqual(result.lonePairs[0].id,'lp-old');
  assert.deepEqual(C.remapEndpoint({type:'atom',atomId:'a-C'},result),{type:'atom',atomId:'new-C'});
  assert.deepEqual(C.remapEndpoint({type:'bond',bondId:'bond-O-C',component:'pi'},result),{type:'bond',bondId:'new-bond',component:'pi'});
  assert.deepEqual(C.remapEndpoint({type:'formingBond',atomA:'a-O',atomB:'a-C'},result),{type:'formingBond',atomA:'new-O',atomB:'new-C'});
  assert.deepEqual(C.remapEndpoint({type:'lonePair',ownerAtomId:'a-O',slotId:'lp-old'},result),{type:'lonePair',ownerAtomId:'new-O',slotId:result.lonePairs[0].id});
  assert.equal(C.remapEndpoint({type:'atom',atomId:'outside'},result),null);
  assert.equal(f.controller.model.state.lonePairs.length,1,'helper never mutates the live model');
});
test('rotates lone-pair fallback angle when its reference atom was not copied', () => {
  const f=fixture(); f.selection.atoms=[1]; f.selection.bonds=[];
  const snapshot=C.capture(f.controller), session=C.stage(snapshot,f.controller);
  C.move(session,{rotation:Math.PI/2,target:{x:5,y:6}});
  f.st.atoms.set(8,{label:'O',pp:{x:3,y:7}}); f.ids.set(8,'new-O');
  const result=C.resolve(f.controller,session); assert.equal(result.ok,true,result.error);
  assert.equal(result.lonePairs[0].refAtomId,null); assert.equal(result.lonePairs[0].angleRel,null);
  assert.ok(Math.abs(result.lonePairs[0].angle-130)<1e-8);
});
test('fusion with existing atoms and coincident new candidates fail instead of rebinding', () => {
  const f=fixture(), snapshot=C.capture(f.controller), session=C.stage(snapshot,f.controller);
  C.move(session,{offset:{x:0,y:0}});
  assert.equal(C.resolve(f.controller,session).ok,false,'original atoms are never candidates');
  insert(f,p=>p); f.st.atoms.set(11,{label:'O',pp:{x:1,y:2}}); f.ids.set(11,'ambiguous');
  assert.equal(C.resolve(f.controller,session).ok,false,'overlapping fresh atoms are ambiguous');
});
test('selected lone pair without owner is rejected and invalid sidecar cannot be staged', () => {
  const f=fixture(); f.selection.atoms=[]; f.selection.bonds=[]; f.controller.selection.add('lp-old');
  assert.throws(()=>C.capture(f.controller),/所属原子/);
  const broken={version:1,atoms:[{id:'a',x:Infinity,y:0,label:'C'}],bonds:[],lonePairs:[],selectedMechanismIds:[]};
  assert.throws(()=>C.stage(broken,f.controller));
});
test('an omitted copied bond is never rebound to an existing bond', () => {
  const f=fixture(), session=C.stage(C.capture(f.controller),f.controller);
  C.move(session,{offset:{x:5,y:5}}); insert(f,p=>({x:p.x+5,y:p.y+5})); f.st.bonds.delete(10);
  const result=C.resolve(f.controller,session); assert.equal(result.ok,true,result.error);
  assert.throws(()=>C.remapEndpoint({type:'bond',bondId:'bond-O-C',component:'sigma'},result),/未能唯一映射/);
});
