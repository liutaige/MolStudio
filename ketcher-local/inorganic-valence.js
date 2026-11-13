/* Complete-graph valence exceptions; catalog generated from fusion/inorganic.py.
 * Called only after native Ketcher inference reports an invalid valence. */
(function () {
  'use strict';
  const catalog = window.molstudioInorganicCatalog || [];
  window.molstudioInorganicValence = function (struct, atomId) {
    const center = struct.atoms.get(atomId);
    if (!center) return false;
    const possible = catalog.filter(t => t.center === center.label && t.charge === (center.charge || 0));
    if (!possible.length) return false;
    const adjacency = new Map();
    struct.bonds.forEach(b => {
      if (!adjacency.has(b.begin)) adjacency.set(b.begin, []);
      if (!adjacency.has(b.end)) adjacency.set(b.end, []);
      adjacency.get(b.begin).push({ id: b.end, type: b.type });
      adjacency.get(b.end).push({ id: b.begin, type: b.type });
    });
    const leaves = adjacency.get(atomId) || [];
    if (!leaves.length || center.radical || center.atomList || center.rglabel || center.attachmentPoints ||
        center.explicitValence >= 0 || center.implicitHCount > 0) return false;
    const signature = new Map();
    for (const bond of leaves) {
      const atom = struct.atoms.get(bond.id);
      if (!atom || (adjacency.get(bond.id) || []).length !== 1 || atom.charge || atom.radical ||
          atom.atomList || atom.rglabel || atom.attachmentPoints || atom.explicitValence >= 0 ||
          atom.implicitHCount > 0 || ![1, 2].includes(bond.type)) return false;
      const key = atom.label + ':' + bond.type;
      signature.set(key, (signature.get(key) || 0) + 1);
    }
    return possible.some(t => t.ligands.length === signature.size &&
      t.ligands.every(([symbol, order, count]) => signature.get(symbol + ':' + order) === count));
  };
})();
