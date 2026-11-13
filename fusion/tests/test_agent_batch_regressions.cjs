'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveMoleculeHandle}=require('../workbench/agent-bridge.js');

test('molecule handles retain input members after a preceding delete renumbers components',()=>{
 const input=new Map([['mol:1',['C']],['mol:2',['N']],['mol:3',['O']]]);
 const current=[{handle:'mol:1',uuids:['N'],rids:[1]},{handle:'mol:2',uuids:['O'],rids:[2]}];
 assert.deepEqual(resolveMoleculeHandle('mol:2',input,current),{handle:'mol:2',uuids:['N'],rids:[1]});
 assert.throws(()=>resolveMoleculeHandle('mol:1',input,current),/成员已变化/);
});

test('molecule handles reject split, merged and replaced member sets instead of editing a different molecule',()=>{
 const input=new Map([['mol:1',['a','b']]]);
 for(const current of [[{handle:'mol:1',uuids:['a']}],[{handle:'mol:1',uuids:['a','b','c']}],[{handle:'mol:1',uuids:['x','y']}]]){
  assert.throws(()=>resolveMoleculeHandle('mol:1',input,current),error=>error.code==='missing_reference');
 }
 assert.equal(resolveMoleculeHandle('mol:1',input,[{handle:'mol:7',uuids:['b','a']}]).handle,'mol:1');
});

const {dependencyOrder,validateOperations}=require('../workbench/agent-bridge.js');
test('dependency ordering ignores literals including operation types, SMILES and text',()=>{
 const ops=validateOperations([{id:'molecule.add',type:'molecule.add',smiles:'C'},{id:'C',type:'molecule.add',smiles:'C'},{id:'note',type:'text.add',text:'note'}]);
 assert.deepEqual(dependencyOrder(ops),ops);
});
test('dependency ordering resolves the longest alias with colon and checks only real references',()=>{
 const ops=validateOperations([{id:'pair',type:'lonePair.add',atom:'stage:reactant:1'},{id:'stage',type:'text.add',text:'stage:reactant'},{id:'stage:reactant',type:'molecule.add',smiles:'O'}]);
 assert.deepEqual(dependencyOrder(ops).map(op=>op.id),['stage:reactant','pair','stage']);
 assert.throws(()=>dependencyOrder(validateOperations([{id:'self:alias',type:'lonePair.add',atom:'self:alias:1'}])),/自身/);
});

require('../workbench/mechanism-model.js');require('../workbench/workbench-storage.js');
const {model:M,storage}=globalThis.MolWorkbench;
test('v1 workbench extension retains reaction semantics and rejects corrupt locators and unknown data',()=>{
 const doc={format:M.FORMAT,version:1,ket:{root:{nodes:[{$ref:'mol0'},{$ref:'mol1'},{type:'arrow',data:{mode:'open-angle',pos:[{x:1,y:0},{x:3,y:0}]}},{type:'text',data:{content:'heat'}}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0]}],bonds:[]},mol1:{type:'molecule',atoms:[{label:'O',location:[4,0,0]}],bonds:[]}},bindings:{atoms:[{id:'a',mol:'mol0',index:0},{id:'b',mol:'mol1',index:0}],bonds:[]},mechanism:M.emptyState(),reactionSteps:[{arrow:2,reactants:['a'],products:['b'],conditions:'heat',flow:{axis:'x',reading:true,rowY:0},labels:[{node:3,role:'conditions',text:'heat'}]}]};
 const parsed=storage.parseWorkbench(storage.serializeWorkbench(doc));assert.equal(parsed.ok,true,parsed.error);assert.deepEqual(parsed.doc.reactionSteps,doc.reactionSteps);assert.equal(parsed.doc.version,1);
 const old=structuredClone(doc);delete old.reactionSteps;assert.equal(storage.parseWorkbench(JSON.stringify(old)).ok,true);
 for(const mutate of [o=>o.reactionSteps=null,o=>o.reactionSteps[0].arrow=0,o=>o.reactionSteps.push(structuredClone(o.reactionSteps[0])),o=>o.reactionSteps[0].reactants=['absent'],o=>o.reactionSteps[0].labels[0].node=2,o=>o.reactionSteps[0].flow.future='unknown',o=>o.reactionSteps[0].future='unknown']){
  const invalid=structuredClone(doc);mutate(invalid);assert.equal(storage.parseWorkbench(JSON.stringify(invalid)).ok,false);
 }
});
