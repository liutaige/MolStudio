'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/ketcher-adapter.js');
const MW = globalThis.MolWorkbench, Adapter = MW.adapter.KetcherAdapter;
class Vec { constructor(x,y){this.x=x;this.y=y;} }
function fixture(t){
 const atoms = new Map([[0,{label:'N',pp:new Vec(1,1)}],[1,{label:'C',pp:new Vec(3,1)}],[2,{label:'O',pp:new Vec(10,1)}],[3,{label:'C',pp:new Vec(10.5,1)}]]);
 const bonds = new Map([[0,{begin:0,end:1,type:1}],[1,{begin:2,end:3,type:1}]]), st = {atoms,bonds};
 const ctab = {molecule:st,atoms:new Map(),bonds:new Map()}, ed = {struct:()=>st,render:{ctab,options:{bondLength:40,offset:{x:0,y:0}}}};
 const adapter = new Adapter({editor:ed},{defaultView:{molstudioNativeStructOps:{vec:Vec}}});adapter.syncIdentity();
 const controller = {active:true,state:{atomScales:{}}};MW.app={documentController:controller};t.after(()=>{delete MW.app;});
 const scale=(id,f)=>{const uuid=adapter.atomUuid.get(id);adapter.setAtomVisualScale(uuid,f);controller.state.atomScales[uuid]=f;};scale(0,2);scale(1,2);scale(2,.5);scale(3,.5);
 return {adapter,st,ctab,controller,scale};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('service unit-layout preserves each component scale and leaves default components exact',t=>{
 const {adapter,st}=fixture(t);st.atoms.set(4,{label:'C',pp:new Vec(20,1)});adapter.syncIdentity();
 const coords=[[0,1,2],[1,2,2],[2,9,2],[3,10,2],[4,20,2]];
 const scaled=adapter.scaleLayoutCoordinates(coords);
 assert.deepEqual(scaled,[[0,.5,2],[1,2.5,2],[2,9.25,2],[3,9.75,2],[4,20,2]]);
 assert.deepEqual(coords,[[0,1,2],[1,2,2],[2,9,2],[3,10,2],[4,20,2]],'service payload stays immutable');
});
test('new native atoms inherit only their connected existing component, including multi-atom additions',t=>{
 const {adapter,st,controller}=fixture(t);
 st.atoms.set(4,{label:'C',pp:new Vec(5,1)});st.atoms.set(5,{label:'O',pp:new Vec(7,1)});st.bonds.set(2,{begin:1,end:4});st.bonds.set(3,{begin:4,end:5});
 st.atoms.set(6,{label:'N',pp:new Vec(25,1)});adapter.syncIdentity();
 for(const id of [4,5]){const uuid=adapter.atomUuid.get(id);near(adapter.effectiveAtomScale(uuid),2);near(controller.state.atomScales[uuid],2);}
 near(adapter.effectiveAtomScale(adapter.atomUuid.get(6)),1);near(adapter.effectiveAtomScale(adapter.atomUuid.get(2)),.5);
});
test('native undo removes inherited metadata and redo restores same identity and scale',t=>{
 const {adapter,st,controller}=fixture(t),before=JSON.stringify(controller.state.atomScales);
 const atom={label:'C',pp:new Vec(5,1)},bond={begin:1,end:4};st.atoms.set(4,atom);st.bonds.set(2,bond);adapter.syncIdentity();const uuid=adapter.atomUuid.get(4);
 st.atoms.delete(4);st.bonds.delete(2);adapter.pendingHistory='undo';adapter.syncIdentity();adapter.pendingHistory=null;assert.equal(JSON.stringify(controller.state.atomScales),before);
 st.atoms.set(4,atom);st.bonds.set(2,bond);adapter.pendingHistory='redo';adapter.syncIdentity();adapter.pendingHistory=null;assert.equal(adapter.atomUuid.get(4),uuid);near(controller.state.atomScales[uuid],2);
});
test('native preview cancellation removes temporary scale metadata without changing existing scale',t=>{
 const {adapter,st,controller}=fixture(t),before=JSON.stringify(controller.state.atomScales);
 st.atoms.set(4,{label:'C',pp:new Vec(5,1)});st.bonds.set(2,{begin:1,end:4});adapter.syncIdentity();
 st.atoms.delete(4);st.bonds.delete(2);adapter.syncIdentity();assert.equal(JSON.stringify(controller.state.atomScales),before);
});
test('native endpoint scale follows existing seed, supports in-progress chain anchors, and rejects foreign structures',t=>{
 const {adapter,st,ctab}=fixture(t);let p=adapter.scaledNativePosition(ctab,1,new Vec(4,1),true);near(p.x,5);near(p.y,1);
 st.atoms.set(4,{label:'C',pp:new Vec(5,1)});st.bonds.set(2,{begin:1,end:4});p=adapter.scaledNativePosition(ctab,4,new Vec(6,1),true);near(p.x,7);
 p=adapter.scaledNativePosition(ctab,4,new Vec(7,1),true);near(p.x,7,'already scaled chain segment stays at the same position');
 const original=new Vec(4,1);assert.equal(adapter.scaledNativePosition({molecule:{...st}},1,original,true),original);
});
test('retired preview identities never give a new disconnected component a custom scale',t=>{
 const {adapter,st,ctab}=fixture(t);
 const atom=st.atoms.get(0);st.atoms.delete(0);st.bonds.delete(0);adapter.syncIdentity();
 // Native preview IDs can be reused before the next render/identity sync.
 st.atoms.set(0,{label:'C',pp:new Vec(20,20)});
 const p=new Vec(21,20);assert.equal(adapter.scaledNativePosition(ctab,0,p,true),p);
});
test('joining two existing differently scaled components never overwrites either old scale',t=>{
 const {adapter,st}=fixture(t);st.bonds.set(2,{begin:1,end:2});adapter.syncIdentity();near(adapter.effectiveAtomScale(adapter.atomUuid.get(1)),2);near(adapter.effectiveAtomScale(adapter.atomUuid.get(2)),.5);
});
function node(attrs,tag='text'){const a={...attrs};return {tagName:tag,isConnected:true,getAttribute:k=>a[k]??null,setAttribute:(k,v)=>{a[k]=String(v);},removeAttribute:k=>{delete a[k];},attrs:a};}
test('visual scaling preserves native subscript fonts, derives transforms from originals, and resets to 100%',t=>{
 const {adapter,ctab,scale}=fixture(t),glyph=node({'transform':'matrix(1,0,0,1,3,4)','font-size':'9px'}),line=node({'stroke-width':'1.5'},'path');
 ctab.atoms.set(0,{visel:{paths:[{node:glyph}]}});ctab.bonds.set(0,{visel:{paths:[{node:line}]}});adapter.applyVisualScales();
 assert.equal(glyph.attrs['font-size'],'9px');assert.equal(glyph.attrs.transform,'matrix(2,0,0,2,-34,-32)');near(Number(line.attrs['stroke-width']),3);
 scale(0,.5);scale(1,.5);adapter.applyVisualScales();assert.equal(glyph.attrs.transform,'matrix(0.5,0,0,0.5,21.5,22)');near(Number(line.attrs['stroke-width']),.75);
 scale(0,1);scale(1,1);adapter.applyVisualScales();assert.equal(glyph.attrs.transform,'matrix(1,0,0,1,3,4)');assert.equal(line.attrs['stroke-width'],'1.5');
});
test('pinned geometry patches are idempotent and preserve upstream SHA validation',()=>{
 const fs=require('node:fs'),path=require('node:path'),patch=require('../patch-ketcher-label-spacing.cjs'),clipboard=require('../patch-ketcher-clipboard.cjs');
 const source=fs.readFileSync(path.resolve(__dirname,'../../ketcher-local/static/js/main.e47c48ad.js'),'utf8');assert.equal(patch.patchSource(source),source);assert.equal(clipboard.patchSource(source).changed,false);
 const raw=patch.patches.reduce((text,p)=>text.replace(p.after,p.before),source);assert.equal(patch.patchSource(raw),source);
 assert.throws(()=>patch.patchSource(source.replace('function ib(U,F,Q,B,R,V)','function changed(U,F,Q,B,R,V)')),/SHA/);
});
