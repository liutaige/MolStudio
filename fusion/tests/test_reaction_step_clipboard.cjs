'use strict';
// Pure semantic clipboard planner for the current MolStudio canvas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../workbench/reaction-step-clipboard.js');
function label(token, kind, side, at, refs, x, y) {
  return { role:'graphPort', text:token, token, kind, side, at, anchorRefs:refs,
    layoutX:x, layoutY:y, ...(at==='molecule' && {anchorDx:0.5,anchorDy:-0.25}),
    position:{x,y}, nativeContent:'native:'+token+':'+at };
}
function fixture() {
  return {version:1, steps:[
    {stepId:'step-1',reactants:['a','b'],products:['c'],layout:{reactantPlacement:'vertical',conditions:'heat'},conditions:'heat',
      arrow:{mode:'open-angle',start:{x:2,y:3},end:{x:5,y:3}},
      flow:{reading:true,forward:true,axis:'x',direction:1,graph:true,routeId:'route-old',laneId:'lane-old',
        rowLeft:1,rowRight:7,rowY:3,rowBottom:5,rowWidth:30,steps:1,continuation:4,sourceRowY:2,
        arrowStartX:2,arrowStartY:3,arrowEndX:5,arrowEndY:3,anchors:[{atomId:'a',x:1,y:2},{atomId:'c',x:6,y:3}]},
      labels:[{role:'conditions',text:'heat',nativeContent:'native-heat',position:{x:3,y:2}},
        {role:'previousRow',text:'续 4',nativeContent:'native-prev',position:{x:7,y:3}},
        {role:'nextRow',text:'续 4',nativeContent:'native-next',position:{x:1,y:8}},
        label('续 1','wrap','source','molecule',['a','c'],6,3),
        label('接 B1','branch','source','molecule',['b','d'],8,3)]},
    {stepId:'step-2',reactants:['c'],products:['d'],arrow:{mode:'open-angle',start:{x:8,y:8},end:{x:10,y:8}},
      flow:{reading:true,forward:true,axis:'x',graph:true,routeId:'route-old',laneId:'lane-old',
        arrowStartX:8,arrowStartY:8,arrowEndX:10,arrowEndY:8,anchors:[{atomId:'c',x:7,y:8},{atomId:'d',x:11,y:8}]},
      labels:[label('续 1','wrap','target','port',['c','a'],1,8),label('接 B1','branch','target','port',['d','b'],2,8)]}
  ]};
}
const atomMap = () => new Map([['a','new-a'],['b','new-b'],['c','new-c'],['d','new-d']]);
function identityFactory() { let n=0; return prefix => `${prefix}-copy-${++n}`; }
function options(overrides={}) { return {atomMap:atomMap(), transform:p=>({x:p.x*2+10,y:p.y*2+20}),scale:2,rotation:0,
  usedTokens:new Set(['续1','接 B1','续 4']),newId:identityFactory(), ...overrides}; }
test('copies complete route with unique identities, paired tokens, geometry and references', () => {
  const source=fixture(), before=JSON.stringify(source), used=new Set(['续1','接 B1','续 4']), gen=identityFactory();
  assert.deepEqual(P.validate(source),{ok:true,errors:[]});
  const result=P.plan(source,options({usedTokens:used,newId:gen})); assert.equal(result.ok,true,result.error);
  assert.equal(JSON.stringify(source),before); assert.deepEqual([...used],['续1','接 B1','续 4']);
  const [first,second]=result.steps;
  assert.equal(first.version,1); assert.notEqual(first.stepId,'step-1'); assert.notEqual(first.stepId,second.stepId);
  assert.deepEqual(first.reactants,['new-a','new-b']); assert.deepEqual(first.products,['new-c']);
  assert.deepEqual(first.sourceArrow,source.steps[0].arrow);
  assert.deepEqual(first.arrow.start,{x:14,y:26}); assert.deepEqual(first.arrow.end,{x:20,y:26});
  assert.equal(first.flow.rowLeft,12); assert.equal(first.flow.rowY,26); assert.equal(first.flow.rowWidth,60);
  assert.equal(first.flow.continuation,2); assert.deepEqual(first.flow.anchors[0],{atomId:'new-a',x:12,y:24});
  assert.notEqual(first.flow.routeId,'route-old'); assert.equal(first.flow.routeId,second.flow.routeId);
  assert.notEqual(first.flow.laneId,'lane-old'); assert.equal(first.flow.laneId,second.flow.laneId);
  assert.equal(first.labels[3].text,'续 3'); assert.equal(second.labels[0].text,'续 3');
  assert.equal(first.labels[4].token,'接 B2'); assert.equal(second.labels[1].token,'接 B2');
  assert.equal(first.labels[1].text,'续 2'); assert.equal(first.labels[2].text,'续 2');
  assert.deepEqual(first.labels[3].sourcePosition,{x:6,y:3}); assert.deepEqual(first.labels[3].position,{x:22,y:26});
  assert.equal(first.labels[3].nativeContent,'native:续 1:molecule'); assert.equal(first.labels[3].sourceContent,first.labels[3].nativeContent);
  assert.equal(first.labels[3].anchorDx,1); assert.equal(first.labels[3].anchorDy,-.5);
  assert.deepEqual(first.labels[3].anchorRefs,['new-a','new-c']);
  result.allocatedTokens.forEach(token=>used.add(token));
  const again=P.plan(source,options({usedTokens:used,newId:gen})); assert.equal(again.ok,true,again.error);
  assert.notEqual(again.steps[0].stepId,first.stepId); assert.notEqual(again.steps[0].flow.routeId,first.flow.routeId);
  assert.ok(again.allocatedTokens.every(t=>!result.allocatedTokens.includes(t)));
});
test('90 degree copy transforms geometry and omits directional flow', () => {
  const source=fixture(), result=P.plan(source,options({scale:1,rotation:Math.PI/2,usedTokens:new Set(),
    transform:p=>({x:10-p.y,y:20+p.x})}));
  assert.equal(result.ok,true,result.error);
  assert.equal(result.steps[0].flow,undefined); assert.equal(result.steps[1].flow,undefined);
  assert.deepEqual(result.steps[0].arrow.start,{x:7,y:22});
  assert.equal(result.steps[0].labels[3].anchorDx,.25); assert.equal(result.steps[0].labels[3].anchorDy,.5);
});
test('incomplete or inconsistent graph ports reject without inventing pair', () => {
  const changes=[
    d=>d.steps[1].labels.shift(),
    d=>{d.steps[1].labels[0].kind='reuse';},
    d=>{d.steps[1].labels[0].anchorRefs=['a'];},
    d=>{d.steps[1].labels[0].at='molecule';d.steps[1].labels[0].anchorDx=0;d.steps[1].labels[0].anchorDy=0;},
    d=>{d.steps[1].labels.push(structuredClone(d.steps[1].labels[0]));}
  ];
  for(const change of changes){const data=fixture();change(data);const result=P.validate(data);
    assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes('复制需包含完整续接/引用端口')));}
});
test('legacy continuation needs exactly one previousRow and one nextRow', () => {
  const changes = [
    d=>{d.steps[0].labels.splice(1,1);},
    d=>{d.steps[0].labels[2].role='previousRow';},
    d=>{d.steps[0].labels[2].text='续 5';},
    d=>{d.steps[0].labels.push(structuredClone(d.steps[0].labels[1]));},
    d=>{d.steps[0].labels=d.steps[0].labels.filter(label=>!['previousRow','nextRow'].includes(label.role)); delete d.steps[0].flow.graph; delete d.steps[0].flow.anchors;}
  ];
  for (const change of changes) {
    const data=fixture();change(data);const result=P.validate(data);
    assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes('复制需包含完整续接/引用端口')));
    assert.equal(P.plan(data,options()).ok,false);
  }
  const valid=fixture(); valid.steps[0].labels[1].text='续   4';
  assert.equal(P.validate(valid).ok,true,'spacing does not break a paired token');
});
test('invalid geometry, IDs, participants and anchors reject; absent mappings fail atomically', () => {
  const changes=[d=>{d.version=2;},d=>{d.steps[0].arrow.start.x=Infinity;},d=>{d.steps[0].arrow.end=d.steps[0].arrow.start;},
    d=>{d.steps[0].reactants=[];},d=>{d.steps[0].flow.rowWidth=NaN;},d=>{d.steps[0].flow.anchors[0].atomId='outside';},
    d=>{d.steps[1].stepId='step-1';},d=>{d.steps[0].labels[3].layoutX=Infinity;},d=>{d.steps[0].flow.unexpected=true;}];
  for(const change of changes){const data=fixture();change(data);assert.equal(P.validate(data).ok,false);}
  const map=atomMap(); map.delete('d'); const data=fixture(),before=JSON.stringify(data),used=new Set(['续 1']);
  const missing=P.plan(data,options({atomMap:map,usedTokens:used}));assert.equal(missing.ok,false);assert.match(missing.error,/缺少新原子映射/);
  assert.equal(JSON.stringify(data),before);assert.deepEqual([...used],['续 1']);
  const merged=atomMap();merged.set('d','new-a');assert.equal(P.plan(data,options({atomMap:merged})).ok,false);
  assert.equal(P.plan(data,options({transform:p=>({x:p.x+10,y:p.y+20})})).ok,false,'incorrect scale declaration rejected');
});
test('empty step list is valid; oversized or unknown fields are not', () => {
  assert.equal(P.validate({version:1,steps:[]}).ok,true);
  assert.equal(P.plan({version:1,steps:[]},options()).steps.length,0);
  const data=fixture();data.agentTask={};assert.equal(P.validate(data).ok,false);
  const many=fixture();many.steps=Array(201).fill(many.steps[0]);assert.equal(P.validate(many).ok,false);
});
test('native points may carry extra fields; optional port offsets remain bounded', () => {
  const data=fixture(); data.steps[1].labels[0].anchorDx=.5;
  assert.equal(P.validate(data).ok,true);
  const result=P.plan(data,options({transform:p=>({type:'free',x:p.x*2+10,y:p.y*2+20})}));
  assert.equal(result.ok,true,result.error); assert.equal(result.steps[1].labels[0].anchorDx,1);
  assert.equal(result.steps[1].labels[0].anchorDy,undefined);
  const rotated=P.plan(data,options({scale:1,rotation:Math.PI/2,transform:p=>({x:10-p.y,y:20+p.x})}));
  assert.equal(rotated.ok,false); assert.match(rotated.error,/相对坐标不完整/);
});
