#!/usr/bin/env node
'use strict';

// SVG viewBox already scales these glyphs and their offsets together. Applying
// zoom again to the offsets squeezes implicit H and its subscript into the
// element symbol below 100%. Keep the renderer's existing 100% spacing.
const fs = require('node:fs');
const path = require('node:path');
const bundlePath = path.resolve(__dirname, '../ketcher-local/static/js/main.e47c48ad.js');
const patches = [
  {
    before: 'var b=k.rbb.width/2*(B.zoom>1?1:B.zoom),v=-k.rbb.width/2*(B.zoom>1?1:B.zoom);if(null!==U.a.atomList)',
    after: 'var b=k.rbb.width/2,v=-k.rbb.width/2;if(null!==U.a.atomList)'
  },
  {
    before: 'B.rightMargin+.15*R.rbb.width*(l.zoom>1?1:l.zoom)+d,.2*U.label.rbb.height',
    after: 'B.rightMargin+.15*R.rbb.width+d,.2*U.label.rbb.height'
  },
  {
    before: 'B.leftMargin-.4*J.rbb.width*(Q>1&&l.zoom<1?l.zoom:1)-d,0',
    after: 'B.leftMargin-.4*J.rbb.width-d,0'
  }
];

// Keep geometry in the native action itself, so previews and the native
// undo/redo stack carry the same paper scale as the edited component.
const scalePoint = (kind, seed, point) => '(window.molstudioComponentScale?window.molstudioComponentScale.' + kind + '(U,' + seed + ',' + point + '):' + point + ')';
patches.push(
  { before: 'new gc(Mb(Mb({},F),{},{fragment:B}),R).perform(U)).data.aid,n=N.atoms.get(Q)',
    after: 'new gc(Mb(Mb({},F),{},{fragment:B}),' + scalePoint('bondPosition', 'Q', 'R') + ').perform(U)).data.aid,n=N.atoms.get(Q)' },
  { before: 'new gc(Mb(Mb({},R),{},{fragment:n}),null!==V&&void 0!==V?V:wi(U,Q,F).pos).perform(U)',
    after: 'new gc(Mb(Mb({},R),{},{fragment:n}),' + scalePoint('bondPosition', 'B', '(null!==V&&void 0!==V?V:wi(U,Q,F).pos)') + ').perform(U)' },
  { before: 'void 0,new XU(V*(W+1),1&W?0:n).rotate(Q).add(F));l=S[0].mergeWith(l)',
    after: 'void 0,new XU(V*(W+1),1&W?0:n).rotate(Q).scaled(window.molstudioComponentScale?window.molstudioComponentScale.factor(U,R):1).add(F));l=S[0].mergeWith(l)' },
  { before: 'J=Math.ceil(Z.Vec2.diff(d,l).length()),N=U.ctrlKey?Z.vectorUtils.calcAngle(l,d)',
    after: 'J=Math.ceil(Z.Vec2.diff(d,l).length()/(window.molstudioComponentScale?window.molstudioComponentScale.factor(Q,B.item?B.item.id:null):1)),N=U.ctrlKey?Z.vectorUtils.calcAngle(l,d)' },
  { before: 'new gc({label:"C",fragment:V},new XU(1,0).rotate(Q).add(d.pp).get_xy0()).perform(U)',
    after: 'new gc({label:"C",fragment:V},new XU(1,0).rotate(Q).scaled(window.molstudioComponentScale?window.molstudioComponentScale.factor(U,F):1).add(d.pp).get_xy0()).perform(U)' },
  { before: 'var n=XU.diff(Q.pp,t).rotate(V).add(W.pp),d=new gc(R,n.get_xy0()).perform(U)',
    after: 'var n=XU.diff(Q.pp,t).rotate(V).scaled(!J.molstudioClipboardToken&&window.molstudioComponentScale?window.molstudioComponentScale.factor(U,S):1).add(W.pp),d=new gc(R,n.get_xy0()).perform(U)' }
);

function patchSource(source) {
  require('./patch-ketcher-clipboard.cjs').patchSource(source);
  for (const patch of patches) {
    const before = source.split(patch.before).length - 1, after = source.split(patch.after).length - 1;
    if (!((before === 1 && after === 0) || (before === 0 && after === 1))) throw new Error('Ketcher spacing/scale anchor changed');
  }
  return patches.reduce((result, patch) => result.replace(patch.before, patch.after), source);
}

module.exports = { patches, patchSource };

if (require.main === module) {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const patched = patchSource(source);
  if (patched !== source) fs.writeFileSync(bundlePath, patched);
}
