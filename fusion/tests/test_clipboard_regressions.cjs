'use strict';
const assert = require('node:assert/strict');
for (const f of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-controller']) require('../workbench/' + f + '.js');
const MW = globalThis.MolWorkbench, M = MW.model;
function fixture() {
  const atoms = new Map([[0,{label:'C',pp:{x:0,y:0}}],[1,{label:'O',pp:{x:1,y:0}}]]);
  const bonds = new Map([[0,{begin:0,end:1}]]);
  const atomNames = new Map([[0,'a0'],[1,'a1'],[2,'a2'],[3,'a3']]);
  const bondNames = new Map([[0,'b0'],[1,'b1']]);
  const ed = {historyStack:[], historyPtr:0, render:{ctab:{}}, selection(){ return {atoms:[],bonds:[]}; }, update(){}};
  function push(undo,redo) {
    const action=(fn,inverse)=>({perform(){fn();return action(inverse,fn)}});
    ed.historyStack.splice(ed.historyPtr,33,action(undo,redo));ed.historyPtr=ed.historyStack.length;
  }
  const adapter = {ed,k:{getKet(){throw Error('molecule clipboard serialization is native')},addFragment(){throw Error('molecule insertion is native')}},
    context:()=>({}),struct:()=>({atoms,bonds}),atomIds:()=>[...atoms.keys()],uuidOfAtom:id=>atomNames.get(id),
    atomIdOf:uuid=>[...atomNames].find(([id,x])=>x===uuid && atoms.has(id))?.[0] ?? null,
    uuidOfBond:id=>bondNames.get(id),syncIdentity(){},selection:()=>({atoms:[],bonds:[]}),pushAction:push};
  const model = new M.MechanismModel();
  const statuses=[];
  const win={navigator:{clipboard:{readText:async()=>'',writeText:async()=>{}}},localStorage:{setItem(){},getItem(){return null}}};
  const c=new MW.controller.MechanismController({adapter, model, layer:{render(){}},doc:{activeElement:null},win,onStatus:s=>statuses.push(s)});
  c.render=()=>{}; return {c,adapter,model,atoms,bonds,ed,statuses,win};
}
function frag() {return {ket:{root:{nodes:[{$ref:'mol0'}]},mol0:{atoms:[{location:[0,0]},{location:[1,0]}]}},atoms:[{uuid:'a0',x:0,y:0,label:'C'},{uuid:'a1',x:1,y:0,label:'O'}],bonds:[{uuid:'b0',atomA:'a0',atomB:'a1'}]};}
function payload(arrows=[],molecules=null,lonePairs=[]) {return JSON.stringify({kind:'molstudio-mechanism',version:2,arrows,lonePairs,molecules});}
async function test(name, fn) {await fn(); console.log('PASS',name);}
(async()=>{
 await test('external paste key is not swallowed',async()=>{const {c}=fixture();c.clipboardText=payload();let stopped=false;c.onKeyDown({key:'v',metaKey:true,target:{tagName:'DIV'},preventDefault(){stopped=true},stopPropagation(){stopped=true}});assert.equal(stopped,false)});
 await test('modified clipboard shortcuts remain available to the host',async()=>{
  const {c}=fixture();c.selection.add('selected');let copied=0;c.copySelection=()=>{copied++};c.cutSelection=()=>{copied++};
  for(const key of ['c','x','v']) for(const modifiers of [{metaKey:true,shiftKey:true},{ctrlKey:true,altKey:true},{metaKey:true,ctrlKey:true}]){
   let stopped=false;c.onKeyDown({key,...modifiers,target:{tagName:'DIV'},preventDefault(){stopped=true},stopPropagation(){stopped=true}});assert.equal(stopped,false);
  }
  assert.equal(copied,0);
 });
 await test('rejected clipboard write does not cut',async()=>{const f=fixture(); const a=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.3});f.model.addArrow(a);f.c.selection.add(a.id);f.win.navigator.clipboard.writeText=async()=>{throw Error('denied')};assert.equal(await f.c.cutSelection(),false);assert.ok(f.model.arrow(a.id));assert.match(f.statuses.at(-1),/失败/)});
 await test('cut waits for write and removes the copied IDs rather than the new selection',async()=>{
  const f=fixture();const a=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.3});
  const b=M.makeArrow({type:'free',x:0,y:2},{type:'free',x:1,y:2},{bend:.3});
  f.model.addArrow(a);f.model.addArrow(b);f.c.selection.add(a.id);
  let acknowledge, started;const writing=new Promise(r=>{started=r});
  f.win.navigator.clipboard.writeText=()=>{started();return new Promise(r=>{acknowledge=r})};
  const cutting=f.c.cutSelection();await writing;
  assert.ok(f.model.arrow(a.id));f.c.selection=new Set([b.id]);acknowledge();
  assert.equal(await cutting,true);assert.equal(f.model.arrow(a.id),null);assert.ok(f.model.arrow(b.id));
  f.ed.historyStack[0].perform({});assert.ok(f.model.arrow(a.id));assert.ok(f.model.arrow(b.id));
 });


 await test('history rejection is not reported as success',async()=>{const f=fixture();f.adapter.pushAction=()=>{throw Error('history fail')};const ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.2});assert.equal(await f.c.pasteText(payload([ar])),false);assert.equal(f.model.state.arrows.length,0);assert.match(f.statuses.at(-1),/失败/)});
 await test('failed deletion restores both the object and its selection',async()=>{
  const f=fixture();const ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.2});
  f.model.addArrow(ar);f.c.selection.add(ar.id);f.adapter.pushAction=()=>{throw Error('history fail')};
  assert.equal(f.c.deleteSelection(),false);assert.ok(f.model.arrow(ar.id));assert.ok(f.c.selection.has(ar.id));assert.match(f.statuses.at(-1),/无法提交/);
 });


 await test('bound arrow copy preserves full curve after detaching',async()=>{
  const f=fixture();f.adapter.context=()=>({atomPos:id=>f.atoms.get(f.adapter.atomIdOf(id))?.pp});
  const ar=M.makeArrow({type:'atom',atomId:'a0'},{type:'atom',atomId:'a1'},{bend:.4});f.model.addArrow(ar);f.c.selection.add(ar.id);
  const before=M.arrowGeometry(ar,f.c.ctx()); const clip=f.c.buildCopyPayload();assert.equal(await f.c.pasteText(JSON.stringify(clip)),true,JSON.stringify(f.statuses));
  const after=M.arrowGeometry(f.c.selectedArrows()[0],f.c.ctx());
  for(const key of ['start','end','control']){assert.ok(Math.abs(after[key].x-before[key].x-2)<1e-8);assert.ok(Math.abs(after[key].y-before[key].y-2)<1e-8)}
 });



 await test('native clipboard write requires matching positive acknowledgement',async()=>{
  const f=fixture();let message;globalThis.webkit={messageHandlers:{k3d:{postMessage(m){message=m}}}};
  try {const pending=f.c.writeClipboard('abc');assert.equal(f.c.clipboardWriteResult('wrong',true),false);assert.equal(f.c.clipboardWriteResult(message.requestId,false),true);assert.equal(await pending,false);assert.match(f.statuses.at(-1),/失败/)}
  finally {delete globalThis.webkit}
 });
 await test('native molecule, bond and native drawing selections are never intercepted',async()=>{
  for(const selection of [{atoms:[0],bonds:[]},{atoms:[],bonds:[0]},{atoms:[],bonds:[],others:1}]){
   const f=fixture();f.adapter.selection=()=>selection;
   f.adapter.k.getKet=()=>{throw Error('must not serialize molecules')};
   f.adapter.k.addFragment=()=>{throw Error('must not insert molecules')};
   const ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.2});f.model.addArrow(ar);f.c.selection.add(ar.id);
   assert.equal(f.c.buildCopyPayload(),null);assert.equal(await f.c.buildCopyPayloadFresh(),null);
   for(const key of ['c','x','v']){
    let blocked=false;f.c.onKeyDown({key,metaKey:true,target:{tagName:'DIV'},preventDefault(){blocked=true},stopPropagation(){blocked=true}});
    assert.equal(blocked,false);
   }
   assert.equal(await f.c.copySelection(),false);assert.equal(await f.c.cutSelection(),false);
   assert.ok(f.model.arrow(ar.id));assert.equal(f.ed.historyStack.length,0);
  }
 });
 await test('ordinary native copy/cut events pass through without a custom clipboard write',async()=>{
  const f=fixture();f.adapter.selection=()=>({atoms:[0],bonds:[]});
  let blocked=false,writes=0;f.win.navigator.clipboard.writeText=async()=>{writes++};
  const e={target:{tagName:'DIV'},preventDefault(){blocked=true},stopPropagation(){blocked=true}};
  assert.equal(f.c.onCopyEvent(e,false),false);assert.equal(f.c.onCopyEvent(e,true),false);
  assert.equal(blocked,false);assert.equal(writes,0);
 });
 await test('text input copy and paste remain native even with an arrow selected',async()=>{
  const f=fixture(),input={tagName:'INPUT'};f.c.doc.activeElement=input;
  const ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.2});f.model.addArrow(ar);f.c.selection.add(ar.id);
  let blocked=false;const e={key:'c',metaKey:true,target:input,preventDefault(){blocked=true},stopPropagation(){blocked=true}};
  f.c.onKeyDown(e);assert.equal(f.c.onCopyEvent(e,false),false);assert.equal(f.c.buildCopyPayload(),null);
  f.c.onPasteEvent({...e,clipboardData:{getData:()=> 'ordinary text'}});assert.equal(blocked,false);
 });
 await test('native molecule/text paste stays untouched, including empty text and non-text data',async()=>{
  const f=fixture();let requested=0;f.c.requestNativePaste=()=>{requested++;return true};
  for(const text of ['mol=MOLECULE','ordinary text','']){
   let blocked=false;f.c.onPasteEvent({target:{tagName:'DIV'},clipboardData:{getData:()=>text},preventDefault(){blocked=true},stopPropagation(){blocked=true}});
   assert.equal(blocked,false);
  }
  assert.equal(requested,1);assert.equal(f.atoms.size,2);assert.equal(f.ed.historyStack.length,0);
 });
 await test('old custom molecule clipboard gives a migration hint without inserting anything',async()=>{
  const f=fixture();f.adapter.k.addFragment=()=>{throw Error('removed molecule path called')};
  assert.equal(await f.c.pasteText(payload([],frag())),false);assert.match(f.statuses.at(-1),/重新.*复制/);
  assert.equal(f.atoms.size,2);assert.equal(f.ed.historyStack.length,0);
 });
 await test('pure arrow payload never contains molecular fragments or native identities to duplicate',async()=>{
  const f=fixture(), ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{bend:.2});f.model.addArrow(ar);f.c.selection.add(ar.id);
  const clip=await f.c.buildCopyPayloadFresh();assert.ok(!clip.molecules);assert.ok(!clip.includeMolecules);assert.equal(clip.arrows.length,1);
  assert.equal(typeof f.c.duplicateMolecules,'undefined');assert.equal(typeof f.c.buildMoleculeFragment,'undefined');
 });
 await test('repeated fishhook paste preserves electron count, curve, selection and one-step undo/redo',async()=>{
  const f=fixture(), ar=M.makeArrow({type:'free',x:0,y:0},{type:'free',x:1,y:0},{electronCount:1,bend:.5});f.model.addArrow(ar);f.c.selection.add(ar.id);
  const clip=JSON.stringify(f.c.buildCopyPayload());assert.equal(await f.c.pasteText(clip),true);assert.equal(await f.c.pasteText(clip),true);
  assert.equal(f.model.state.arrows.length,3);const [first,second]=f.model.state.arrows.slice(1);
  assert.equal(first.electronCount,1);assert.equal(second.electronCount,1);assert.equal(first.geometry.bend,.5);
  assert.notEqual(first.source.x,second.source.x);assert.deepEqual([...f.c.selection],[second.id]);
  const redo=f.ed.historyStack[1].perform({});assert.equal(f.model.state.arrows.length,2);
  redo.perform({});assert.equal(f.model.state.arrows.length,3);
 });
 await test('invalid arrow payload is rejected without touching native structures',async()=>{
  const f=fixture(),data=JSON.parse(payload());data.arrows={};assert.equal(await f.c.pasteText(JSON.stringify(data)),false);
  assert.equal(f.atoms.size,2);assert.equal(f.ed.historyStack.length,0);
 });
})().catch(e=>{console.error(e);process.exitCode=1});
