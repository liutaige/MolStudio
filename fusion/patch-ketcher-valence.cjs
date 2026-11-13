#!/usr/bin/env node
'use strict';

// Ketcher 3.18 treats every noble gas as having no bonded valence. Allow the
// established neutral, closed-shell valences of Xe and Kr without inventing H
// atoms or suppressing warnings on other elements/charge/radical states.
// Reapply after replacing the pinned upstream bundle:
//   node fusion/patch-ketcher-valence.cjs
// The additional graph-based exception shares the exact molecular catalog with
// fusion/inorganic.py. Unknown structures retain the native valence result.
const fs = require('node:fs');
const path = require('node:path');
const bundlePath = path.resolve(__dirname, '../ketcher-local/static/js/main.e47c48ad.js');
const before = '{key:"calculateGroup8Valence",value:function(U){var F=U.label,Q=U.connectionCount,B=U.radicalCount,R=U.absCharge;return"Pt"===F?';
const after = '{key:"calculateGroup8Valence",value:function(U){var F=U.label,Q=U.connectionCount,B=U.radicalCount,R=U.absCharge;if(0===B&&0===R&&("Xe"===F&&[0,2,4,6,8].includes(Q)||"Kr"===F&&[0,2].includes(Q)))return{valence:Q,hydrogenCount:0};return"Pt"===F?';
const patches = [{ name: 'neutral xenon and krypton bonded valences', before, after }, {
  name: 'known complete inorganic graphs after native valence inference',
  before: 'else B.calcValence(N)}}},{key:"setImplicitHydrogen"',
  after: 'else B.calcValence(N);B.badConn&&B.explicitValence<0&&typeof window.molstudioInorganicValence==="function"&&window.molstudioInorganicValence(this,U)&&(B.badConn=!1,B.implicitH=0,B.valence=N)}}},{key:"setImplicitHydrogen"'
}];

function patchSource(source) {
  // The clipboard patcher checks the pinned upstream SHA after removing both
  // known patches. Either application order is supported; unknown edits fail.
  require('./patch-ketcher-clipboard.cjs').patchSource(source);
  let result = source;
  for (const patch of patches) {
    const oldCount = result.split(patch.before).length - 1;
    const newCount = result.split(patch.after).length - 1;
    if (oldCount === 0 && newCount === 1) continue;
    if (oldCount !== 1 || newCount !== 0) throw Error('Ketcher valence anchor changed: '+patch.name);
    result = result.replace(patch.before, patch.after);
  }
  return { source: result, changed: result !== source };
}

module.exports = { bundlePath, patches, patchSource };

if (require.main === module) {
  try {
    const result = patchSource(fs.readFileSync(bundlePath, 'utf8'));
    if (result.changed) fs.writeFileSync(bundlePath, result.source);
    process.stdout.write(result.changed ? 'Patched Ketcher noble-gas valences.\n' : 'Ketcher noble-gas valences already applied.\n');
  } catch (error) {
    process.stderr.write(error.message+'\n');
    process.exitCode = 1;
  }
}
