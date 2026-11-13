#!/usr/bin/env node
'use strict';

// Pinned Ketcher 3.18: expose only the native action primitives used by the
// workbench agent. No webpack/module-loader API is published. The existing
// clipboard verifier still checks the original upstream SHA after reversing
// every explicitly recognised patch, including this one.
//
// v2 adds `molstudioNativeStructOps`: the pinned bundle's own undoable
// Operation classes (AtomAdd/AtomDelete/AtomAttr/AtomMove, BondAdd/BondDelete/
// BondAttr, TextDelete, CalcImplicitH) plus the Operation base whose static
// invalidate* helpers keep ReStruct dirty maps correct. All identifiers live in
// the same webpack module scope as the v1 bridge anchor, and every operation
// restores the exact runtime ids on undo (data.bond/data.atom/bid/aid), so the
// adapter's stable UUID maps stay valid across undo/redo.
const fs = require('node:fs');
const path = require('node:path');
const bundlePath = path.resolve(__dirname, '../ketcher-local/static/js/main.e47c48ad.js');
const anchorHead = 'function SY(U,F){return WY(U.title,F.title)}';
const anchorTail = '},89345(U,F,Q)';
const before = anchorHead + anchorTail;
// v1 bridge (still shipped; add-only calls depend on it).
const bridgeV1 = 'if(typeof window!=="undefined")Object.defineProperty(window,"molstudioNativeActions",{configurable:!0,value:Object.freeze({version:1,prepareKet:function(U){var F=(new RD).deserialize(U);return F.rescale(),F},paste:function(U,F,Q){return iX(U,F,new XU(Q.x,Q.y),0,!1,!1)},createText:function(U,F,Q){var B={root:{nodes:[{type:"text",boundingBox:{x:0,y:0,width:Math.max(1,Math.min(80,F.length*.28)),height:.5},paragraphs:F.split("\\n").map(function(U){return{parts:[{text:U}],indent:0}}),indent:0}]}},R=Array.from((new RD).deserialize(JSON.stringify(B)).texts.values())[0];return lY(U,R.content,new XU(Q.x,Q.y))},serialize:function(U){return(new RD).serialize(U)}})});';
// v2 struct-edit operations. `recalc` recomputes implicit hydrogen (optionally
// scoped to affected atoms) and stereo labels exactly like Struct.clone does.
const previousStructOps = 'if(typeof window!=="undefined")Object.defineProperty(window,"molstudioNativeStructOps",{configurable:!0,value:Object.freeze({version:1,atomAdd:gc,atomDelete:qc,atomAttr:Ur,atomMove:Br,bondAdd:lr,bondDelete:Nr,bondAttr:Sr,textDelete:Vi,calcImplicitH:Rm,base:zS,vec:XU,recalc:function(U,F){if(typeof U.setImplicitHydrogen==="function")U.setImplicitHydrogen(F&&F.length?F:void 0);if(typeof U.setStereoLabelsToAtoms==="function")U.setStereoLabelsToAtoms()}})});';
// Reuse Ketcher's undoable fragment split/removal and merge. Its KET serializer
// relies on native fragment membership as well as the live atom/bond graph.
const splitStructOps = previousStructOps.replace('textDelete:Vi,', 'textDelete:Vi,repartitionFragment:DX,');
const mergedStructOps = splitStructOps.replace('repartitionFragment:DX,',
  'repartitionFragment:DX,mergeFragments:function(U,F,Q){var B=new si;return Fb(B,U,F,Q),B},');
// Straight-arrow removal uses the same native inverse operation as Ketcher's
// delete tool, including ReStruct cleanup and preservation of native arrow IDs.
const structOps = mergedStructOps.replace('textDelete:Vi,', 'textDelete:Vi,rxnArrowDelete:oM,');
const after = anchorHead + bridgeV1 + structOps + anchorTail;
const scrollbarBefore = 'n=this.render.paper.rect(F,Q,B,R,V).attr({stroke:this.COLOR,fill:this.COLOR});return n.drag(';
const legacyScrollbarAfter = 'n=this.render.paper.rect(F,Q,B,R,V).attr({stroke:this.COLOR,fill:this.COLOR,"data-molstudio-ui":"scrollbar"});return n.drag(';
const patches = [{ name: 'explicit workbench native action bridge v1 + struct operations v2', before, after }, {
  name: 'mark native Raphael scrollbars as editor UI for image export',
  before: scrollbarBefore,
  // Raphael filters unknown attributes in attr(); mark its actual SVG node.
  after: 'n=this.render.paper.rect(F,Q,B,R,V).attr({stroke:this.COLOR,fill:this.COLOR});return n.node.setAttribute("data-molstudio-ui","scrollbar"),n.drag('
}];
// Ketcher's atom-label induction also accepts the V2000 crossed-double-bond
// code (3), although its own tetrahedral parity decoder returns null for it.
// Keep that legitimate unspecified E/Z bond flag; only a recognised UP, DOWN
// or EITHER tetrahedral parity may introduce an atom-level absolute label.
patches.push({ name: 'do not invent absolute atom stereo from crossed double bonds',
  before: 'if(vd.isCorrectStereoCenter(F,Q,V,U)){var n,l,d=',
  after: 'if(vd.isCorrectStereoCenter(F,Q,V,U)&&null!==Xd(F.stereo)){var n,l,d=' });
// Normalize native SVG text using fixed-scale glyph metrics; retain the
// original upstream anchor so the pinned verifier can reverse this patch.
patches.push({ name: "stabilize native text baseline across zoom redraws", before: "var k=B._getBBox(),a=n.y-(k.y+k.height/2);a&&U.is(a,\"finite\")&&t(W[0],{dy:a})", after: "var k=B._getBBox(),a=n.y-(k.y+k.height/2);try{var D=U._g.doc,T=l.cloneNode(!0),P=D.defaultView.getComputedStyle(l),G=[\"fontFamily\",\"fontSize\",\"fontWeight\",\"fontStyle\",\"fontStretch\",\"fontVariant\",\"fontKerning\",\"fontFeatureSettings\",\"fontVariationSettings\",\"letterSpacing\",\"wordSpacing\",\"textAnchor\",\"direction\",\"dominantBaseline\",\"alignmentBaseline\"];for(var Zz=0;Zz<G.length;Zz++)T.style[G[Zz]]=P[G[Zz]];T.setAttribute(\"x\",\"0\"),T.setAttribute(\"y\",\"0\"),T.removeAttribute(\"transform\");for(var Yy=T.querySelectorAll(\"tspan[x]\"),Xx=0;Xx<Yy.length;Xx++)if(Number(Yy[Xx].getAttribute(\"x\"))===Number(n.x))Yy[Xx].setAttribute(\"x\",\"0\");T.removeAttribute(\"id\");var Cc=h._fixedTextCache||(h._fixedTextCache=new Map),Kk=T.outerHTML,Vv=Cc.get(Kk);if(!Vv){var Hh=h._fixedTextSvg;if(!Hh||!Hh.isConnected){Hh=D.createElementNS(\"http://www.w3.org/2000/svg\",\"svg\"),Hh.setAttribute(\"width\",\"800\"),Hh.setAttribute(\"height\",\"600\"),Hh.setAttribute(\"viewBox\",\"0 0 800 600\"),Object.assign(Hh.style,{position:\"fixed\",left:\"-10000px\",top:\"-10000px\",opacity:\"0\",pointerEvents:\"none\",overflow:\"visible\"}),D.body.appendChild(Hh),h._fixedTextSvg=Hh;var Ff=D.fonts;Ff&&Ff.addEventListener&&Ff.addEventListener(\"loadingdone\",function(){Cc.clear()})}Hh.appendChild(T);try{var Bb=T.getBBox();Vv={y:Bb.y,height:Bb.height}}finally{T.remove()}if(Number.isFinite(Vv.y)&&Number.isFinite(Vv.height)&&Vv.height>0)Cc.size>=512&&Cc.clear(),Cc.set(Kk,Vv);else Vv=null}Vv&&(a=-(Vv.y+Vv.height/2))}catch(Ee){};a&&U.is(a,\"finite\")&&t(W[0],{dy:a})" });
// Superseded patched forms that must normalize back to the bare anchor first.
const legacyAfters = ['', previousStructOps, splitStructOps, mergedStructOps].map(ops => anchorHead + bridgeV1 + ops + anchorTail);

function patchSource(source) {
  let normalized = source;
  normalized = normalized.split(legacyScrollbarAfter).join(scrollbarBefore);
  for (const legacy of legacyAfters) normalized = normalized.split(legacy).join(before);
  for (const patch of patches) {
    const oldCount = normalized.split(patch.before).length - 1;
    const newCount = normalized.split(patch.after).length - 1;
    if (!((oldCount === 1 && newCount === 0) || (oldCount === 0 && newCount === 1))) {
      throw Error('Ketcher agent bridge anchor changed: ' + patch.name);
    }
  }
  // This verifier reverses the exact bridge before checking the upstream hash.
  require('./patch-ketcher-clipboard.cjs').patchSource(normalized);
  let patched = normalized;
  for (const patch of patches) patched = patched.replace(patch.before, patch.after);
  return { source: patched, changed: patched !== source };
}

module.exports = { bundlePath, patches, legacyAfters, patchSource };
if (require.main === module) {
  try {
    const result = patchSource(fs.readFileSync(bundlePath, 'utf8'));
    if (result.changed) fs.writeFileSync(bundlePath, result.source);
    process.stdout.write(result.changed ? 'Patched Ketcher agent action bridge (v2 struct operations).\n' : 'Ketcher agent action bridge already applied.\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
