'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
for (const file of ['mechanism-model','mechanism-route','document-model','document-clipboard','mechanism-controller']) require('../workbench/'+file+'.js');
const MW=globalThis.MolWorkbench;
const MIME='application/x-molstudio-mechanism';
function fixture(){
  let removed=0,asyncWrites=0;
  const model=new MW.model.MechanismModel(),selection={atoms:[],bonds:[]},struct={atoms:new Map(),bonds:new Map()};
  const ed={selection:()=>selection,render:{ctab:{}},historyStack:[],historyPtr:0};
  const adapter={ed,selection:()=>({...selection,others:0}),struct:()=>struct,syncIdentity(){},context:()=>({})};
  const c=new MW.controller.MechanismController({adapter,model,layer:{render(){}},doc:{activeElement:null},win:{navigator:{clipboard:{writeText:async()=>{asyncWrites++;}}}}});
  c.render=()=>{};
  c.documentController={selection:new Set(['obj-copy']),clipboardFragment:()=>({objects:[{id:'obj-copy',kind:'text',band:'front',x:1,y:2,w:4,h:2,rotation:0,rich:{text:'ordinary document note'}}],assets:{}}),
    cutFragment(payload){assert.equal(payload.document.objects[0].id,'obj-copy');removed++;return true;},
    prepareFragment(){throw new Error('invalid imported document reference');}};
  return{c,model,removed:()=>removed,asyncWrites:()=>asyncWrites};
}
function event(failType,target){
  const data={};return{target:target||{tagName:'TEXTAREA',getAttribute:()=> 'true'},data,defaultPrevented:false,stopped:false,
    clipboardData:{setData(type,value){if(type===failType)throw Error('write denied');data[type]=value;},getData:type=>data[type]||''},
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
}
test('document-only trusted event transport keeps custom and plain data in one synchronous transaction',()=>{
  const f=fixture(),e=event();assert.equal(f.c.onCopyEvent(e,false),true);
  assert.equal(e.defaultPrevented,true);assert.equal(e.stopped,true);
  assert.equal(e.data[MIME],e.data['text/plain']);assert.equal(JSON.parse(e.data[MIME]).document.objects.length,1);
  assert.equal(f.asyncWrites(),0);assert.equal(f.removed(),0);
});
test('document-only cut removes content only after both event formats are writable',()=>{
  for(const failType of [MIME,'text/plain']){
    const f=fixture(),e=event(failType);f.c.onCopyEvent(e,true);
    assert.equal(e.defaultPrevented,true);assert.equal(f.removed(),0);assert.equal(f.asyncWrites(),0);
    assert.match(f.c.lastStatusText,/未剪切/);
  }
  const f=fixture(),e=event();f.c.onCopyEvent(e,true);assert.equal(f.removed(),1);assert.equal(f.asyncWrites(),0);
});
test('ordinary text fields retain their normal copy and cut semantics',()=>{
  for(const target of [{tagName:'INPUT'},{tagName:'DIV',isContentEditable:true}]){
    const f=fixture(),e=event(null,target);assert.equal(f.c.onCopyEvent(e,true),false);
    assert.equal(e.defaultPrevented,false);assert.deepEqual(e.data,{});assert.equal(f.removed(),0);
  }
});
test('an invalid mixed sidecar cancels the whole paste instead of silently pasting chemistry alone',()=>{
  const f=fixture(),e=event();e.data[MIME]=JSON.stringify({kind:'molstudio-mechanism',version:2,native:true,arrows:[],lonePairs:[],document:{objects:[{id:'bad'}],assets:{}}});
  const before=JSON.stringify(f.model.state);f.c.onPasteEvent(e);
  assert.equal(e.defaultPrevented,true);assert.equal(e.stopped,true);assert.equal(f.c.nativePasteToken(),null);assert.equal(JSON.stringify(f.model.state),before);
});
