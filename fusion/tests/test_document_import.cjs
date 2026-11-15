'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
for(const file of ['mechanism-model','document-model','workbench-storage','document-clipboard','document-controller'])require('../workbench/'+file+'.js');
const MW=global.MolWorkbench,{DocumentController}=MW.documentController;
const pure=()=>{const document=MW.documentModel.createDocument({mode:'paper'});document.objects=[{id:'source-note',kind:'text',band:'front',x:3,y:4,w:6,h:2,rotation:0,rich:{text:'Imported'}}];return MW.storage.serializeWorkbench({ket:{root:{nodes:[]}},mechanism:MW.model.emptyState(),document});};
function fixture(){
  const calls=[],mechanism={cancelDraft(){calls.push('cancelDraft');},cancelNativePaste(){calls.push('cancelNativePaste');},beginPasteText(text){calls.push(['preview',JSON.parse(text)]);return true;},finishPastePreview(point){calls.push(['place',point]);return true;},stageNativePaste(text){calls.push(['stage',JSON.parse(text)]);return 'native-paste-1';},nativePasteToken(){return null;}};
  const ed={tool(...args){calls.push(['tool',...args]);},focusCliparea(){}};
  const native={prepareKet(text){const ket=JSON.parse(text);return {atoms:new Map(),getAvgBondLength:()=>0,isBlank:()=>!ket.root.nodes.length};}};
  const c=new DocumentController({mechanism,adapter:{ed},win:{molstudioNativeActions:native},iframe:{focus(){calls.push('focusFrame');}},doc:{},onStatus(){}});c.finishTextEdit=()=>true;
  return {c,calls};
}
test('raw KET insertion stages a native carrier without inventing document or mechanism steps',async()=>{
  const {c,calls}=fixture();
  const result=await c.importFile({name:'arrow.ket',text:JSON.stringify({root:{nodes:[{type:'arrow',data:{mode:'open-angle',pos:[{x:2,y:-3,z:0},{x:5,y:-3,z:0}]}}]}})});
  assert.equal(result.ok,true);assert.equal(result.staged,true);
  const carrier=calls.find(call=>call[0]==='stage')[1];assert.equal(carrier.nativeOnly,true);assert.equal(carrier.mechanismSteps,undefined);assert.equal(carrier.document,undefined);
  assert.ok(calls.some(call=>call[0]==='tool'&&call[1]==='paste'));
});
test('a late file read from an older document cannot start any import mutation',async()=>{
  const {c,calls}=fixture();let resolve;
  const pending=c.importFile({name:'late.molwork',text:()=>new Promise(done=>{resolve=done;})});
  c.generation++;resolve(pure());const result=await pending;
  assert.equal(result.ok,false);assert.match(result.error,/文档已切换/);assert.deepEqual(calls,[]);
});
test('the latest import request owns the preview when asynchronous reads finish out of order',async()=>{
  const {c,calls}=fixture();let resolve;
  const older=c.importFile({name:'older.molwork',text:()=>new Promise(done=>{resolve=done;})});
  const latest=await c.importFile({name:'latest.molwork',text:pure()});
  assert.equal(latest.ok,true);assert.ok(calls.indexOf('focusFrame')<calls.findIndex(call=>call[0]==='preview'),'host focus transition completes before a standalone draft exists');const before=calls.length;resolve(pure());
  const stale=await older;assert.equal(stale.cancelled,true);assert.equal(calls.length,before);
  assert.equal(calls.filter(call=>call[0]==='preview').length,1);
});
test('an invalid later file does not cancel the existing valid preview',async()=>{
  const {c,calls}=fixture();assert.equal((await c.importFile({name:'valid.molwork',text:pure()})).ok,true);
  const before=calls.length,result=await c.importFile({name:'invalid.ket',text:'{invalid'});
  assert.equal(result.ok,false);assert.equal(calls.length,before);
});
