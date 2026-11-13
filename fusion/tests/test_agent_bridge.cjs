'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {validateOperations,validateArrowAnchors,bondObservation,inverseGroup}=require('../workbench/agent-bridge.js');
require('../workbench/mechanism-model.js');
const patch=require('../patch-ketcher-agent.cjs');

test('agent operations reject incomplete/ambiguous arguments before touching source',()=>{
 const valid=[{id:'m',type:'molecule.add',smiles:'[OH-:7]'},{id:'lp',type:'lonePair.add',atom:'m:7'},
  {id:'a',type:'arrow.add',source:{type:'lonePair',id:'lp'},target:{type:'atom',atomId:'at-id'},electronCount:2}];
 assert.deepEqual(validateOperations(valid),valid);
 for(const invalid of [
  [{id:'m',type:'molecule.add'}], [{id:'m',type:'molecule.add',smiles:'C',x:Infinity}],
  [{id:'a',type:'arrow.add',source:{type:'atom',atomId:'a'},target:{type:'atom',atomId:'b'}}],
  [{id:'a',type:'arrow.add',source:{type:'bond',bondId:'b'},target:{type:'atom',atomId:'a'},electronCount:2}],
  [{id:'a',type:'arrow.add',source:{type:'free',x:1,y:2},target:{type:'atom',atomId:'b'},electronCount:2}],
  [{id:'m',type:'molecule.add',smiles:'C',javascript:'alert(1)'}],
  [{id:'m',type:'molecule.add',smiles:'C'},{id:'m',type:'molecule.add',smiles:'N'}],
  [{id:'__proto__',type:'text.add',text:'unsafe key'}], Array.from({length:41},(_,i)=>({id:'a'+i,type:'molecule.add',smiles:'C'}))
 ])assert.throws(()=>validateOperations(invalid));
 assert.equal(validateOperations([{id:'text',type:'text.add',text:'<script>literal source</script>\n说明'}])[0].text,'<script>literal source</script>\n说明');
});

test('native inverse groups execute in reverse order and produce an ordered redo',()=>{
 const state={value:'AB'},log=[];
 const inverse=letter=>({operations:[],perform(){assert.equal(state.value.at(-1),letter);state.value=state.value.slice(0,-1);log.push('-'+letter);return{operations:[],perform(){state.value+=letter;log.push('+'+letter);return inverse(letter);}};}});
 const redo=inverseGroup([inverse('A'),inverse('B')]).perform({});
 assert.equal(state.value,'');assert.deepEqual(log,['-B','-A']);
 redo.perform({});assert.equal(state.value,'AB');assert.deepEqual(log,['-B','-A','+A','+B']);
});

test('endpoint diagnostics distinguish unavailable pi electrons from valid carbonyl geometry and overlap',()=>{
 const M=globalThis.MolWorkbench.model, positions={c:{x:0,y:0},o:{x:1,y:0}};
 const bond={type:2,begin:positions.c,end:positions.o,beginAtom:'at-c',endAtom:'at-o'};
 const ctx={bondInfo:id=>id==='bd-co'?bond:null,atomPos:id=>positions[id.replace('at-','')]};
 const source={type:'bond',bondId:'bd-co',component:'pi'},target={type:'atom',atomId:'at-o'};
 const input={source:{type:'bond',bondId:'acid:bond:1',component:'pi'},target:{type:'atom',atomId:'acid:2'}};
 assert.doesNotThrow(()=>validateArrowAnchors(M,source,target,ctx,input));
 // A prior native bond edit can invalidate pi electrons without moving either
 // atom. The diagnostic must observe that current order, not blame geometry.
 bond.type=1;
 assert.throws(()=>validateArrowAnchors(M,source,target,ctx,input),error=>{
  assert.equal(error.code,'arrow_pi_unavailable'); assert.equal(error.field,'source.component');
  assert.deepEqual(error.sourceEndpoint,{type:'bond',reason:'piUnavailable',bondId:'bd-co',component:'pi',bondOrder:1,
   atomIds:['at-c','at-o'],bondRef:'acid:bond:1'});
  assert.deepEqual(error.targetEndpoint,{type:'atom',atomIds:['at-o'],atomRefs:['acid:2']});
  assert.equal(error.endpointDistance,undefined); assert.match(error.message,/π/); return true;
 });
 assert.throws(()=>validateArrowAnchors(M,{type:'atom',atomId:'at-c'},target,{...ctx,atomPos:()=>positions.c}),error=>
  error.code==='arrow_endpoints_overlap'&&error.endpointDistance===0);
 assert.throws(()=>validateArrowAnchors(M,source,target,{...ctx,bondInfo:()=>null}),error=>
  error.code==='arrow_endpoint_invalid'&&error.sourceEndpoint.reason==='bond');
});

test('bond observations verify native types while keeping aromatic chemical order distinct',()=>{
 for(const type of [1,2,3])assert.deepEqual(bondObservation({type}),{order:type,nativeType:type});
 assert.deepEqual(bondObservation({type:4}),{order:1.5,nativeType:4});
 assert.deepEqual(bondObservation({type:2},{order:1.5,nativeType:2}),{order:1.5,nativeType:2});
 assert.throws(()=>bondObservation({type:1},{order:2,nativeType:1}),/键级/);
 assert.throws(()=>bondObservation({type:2},{order:2,nativeType:1}),/键类型/);
});

test('native action patch is idempotent and preserves the pinned upstream hash guard',()=>{
 const source=fs.readFileSync(patch.bundlePath,'utf8');
 assert.equal(patch.patchSource(source).changed,false);
 const unpatched=source.replace(patch.patches[0].after,patch.patches[0].before);
 assert.equal(patch.patchSource(unpatched).source,source);
 assert.throws(()=>patch.patchSource(source+'\n'),/SHA-256/);
 assert.throws(()=>patch.patchSource(source.replace('molstudioNativeActions','molstudioNativeActionsChanged')),/anchor|SHA-256/);
 assert.equal(require('../patch-ketcher-clipboard.cjs').patchSource(source).changed,false);
 assert.equal(require('../patch-ketcher-valence.cjs').patchSource(source).changed,false);
});
