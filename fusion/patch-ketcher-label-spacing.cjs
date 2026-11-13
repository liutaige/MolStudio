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

function patchSource(source) {
  require('./patch-ketcher-clipboard.cjs').patchSource(source);
  const pending = patches.filter(patch => source.includes(patch.before));
  if (pending.length && pending.length !== patches.length) {
    throw new Error('Ketcher label spacing patch is only partially applied');
  }
  return pending.reduce((result, patch) => result.replace(patch.before, patch.after), source);
}

module.exports = { patches, patchSource };

if (require.main === module) {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const patched = patchSource(source);
  if (patched !== source) fs.writeFileSync(bundlePath, patched);
}
