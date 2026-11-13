'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
require('../workbench/mechanism-model.js');require('../workbench/ketcher-adapter.js');
const Adapter=globalThis.MolWorkbench.adapter.KetcherAdapter;
const mul=(a,b)=>({a:a.a*b.a+a.c*b.b,b:a.b*b.a+a.d*b.b,c:a.a*b.c+a.c*b.d,d:a.b*b.c+a.d*b.d,e:a.a*b.e+a.c*b.f+a.e,f:a.b*b.e+a.d*b.f+a.f});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

function fixture(){
 let zoom=.5,width=8;
 const root=()=>({a:zoom,b:0,c:0,d:zoom,e:100,f:200});
 const svg={getScreenCTM:root,contains:node=>node.attached};
 const path=(text,x,y,w,h)=>{const node={textContent:text,isConnected:true,attached:true,getBBox:()=>({x:0,y:0,width:typeof w==='function'?w():w,height:h}),
   getScreenCTM:()=>mul(root(),{a:1,b:0,c:0,d:1,e:x,f:y})};return{type:'text',node,getBBox:()=>({x:-999,y:-999,width:1,height:1})}};
 const carbon=path('C',0,0,()=>width,10),hydrogen=path('H',10,0,9,10),subscript=path('3',19,3,5,7);
 const atom={label:'C',implicitH:3,pp:{x:0,y:0}},atoms=new Map([[1,atom]]),vis={showLabel:true,label:{path:carbon},
   visel:{boundingBox:{p0:{x:-500,y:-500},p1:{x:500,y:500}},paths:[carbon,hydrogen,subscript]}};
 const ed={struct:()=>({atoms,bonds:new Map()}),zoom:()=>zoom,render:{options:{bondLength:40,offset:{x:0,y:0}},
   clientArea:{querySelector:()=>svg},ctab:{atoms:new Map([[1,vis]])}}};
 const adapter=new Adapter({editor:ed},{});adapter.syncIdentity();return{adapter,id:adapter.uuidOfAtom(1),vis,carbon,hydrogen,subscript,
   setZoom:z=>{zoom=z},setWidth:w=>{width=w}};
}

test('live transformed native glyph boxes replace stale cached bounds and preserve H subboxes',()=>{
 const f=fixture(),box=f.adapter.atomLabelBox(f.id);
 near(box.rect.x1,0);near(box.rect.y1,0);near(box.rect.x2,24/40);near(box.rect.y2,10/40);
 near(box.atomRect.x1,0);near(box.atomRect.x2,8/40);assert.equal(box.hydrogenRects.length,2);
 near(box.hydrogenRects[0].x1,10/40);near(box.hydrogenRects[0].x2,19/40);
 near(box.hydrogenRects[1].x1,19/40);near(box.hydrogenRects[1].x2,24/40);
});

test('new DOM measurement is used after zoom and glyph changes without caching old dimensions',()=>{
 const f=fixture(),first=f.adapter.atomLabelBox(f.id);f.setZoom(.41);f.setWidth(9);
 const second=f.adapter.atomLabelBox(f.id);near(first.atomRect.x2,8/40);near(second.atomRect.x2,9/40);
 near(second.rect.x2,24/40);near(second.hwCss,(24/40)*40*.41/2);
});

test('native node transforms use all four corners in root SVG coordinates',()=>{
 const f=fixture(),root=f.adapter.canvasSvg().getScreenCTM();
 f.carbon.node.getScreenCTM=()=>mul(root,{a:0,b:1,c:-1,d:0,e:20,f:0});
 const box=f.adapter.atomLabelBox(f.id);near(box.atomRect.x1,10/40);near(box.atomRect.x2,20/40);
 near(box.atomRect.y1,0);near(box.atomRect.y2,8/40);
});

test('unattached nodes retain the existing visel and per-glyph fallback',()=>{
 const f=fixture();for(const p of [f.carbon,f.hydrogen,f.subscript])p.node.isConnected=false;
 f.vis.visel.boundingBox={p0:{x:-4,y:-7},p1:{x:24,y:10}};
 const box=f.adapter.atomLabelBox(f.id);near(box.rect.x1,-4/40);near(box.rect.x2,24/40);assert.equal(box.hydrogenRects.length,2);
});
