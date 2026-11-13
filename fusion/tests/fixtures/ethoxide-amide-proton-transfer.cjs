'use strict';
// Main canvas geometry fixture inspired by the reported screenshot: ethoxide
// LP -> explicit amide N-H, paired with N-H sigma -> N. These hand-built glyph
// boxes test the shared route/controller; native-glyph acceptance is separate.
module.exports = function protonTransferFixture({ distance = 4, zoom = 1, scale = 1, translation = { x: 0, y: 0 } } = {}) {
  const MW = globalThis.MolWorkbench, M = MW.model;
  const positions = { o: [0, 0], ethyl: [0.866, -0.5], methyl: [1.732, 0], h: [distance, 0.55],
    n: [distance + 0.866, 1.05], nMethyl: [distance + 1.732, 0.55], carbonyl: [distance + 0.866, 2.05],
    carbonylO: [distance, 2.55], acetyl: [distance + 1.732, 2.55], iodide: [distance * 0.65, 1.3] };
  const p = Object.fromEntries(Object.entries(positions).map(([id, [x, y]]) => [id,
    { x: x * scale + translation.x, y: y * scale + translation.y }]));
  const labels = { o: 'O', methyl: 'C', h: 'H', n: 'N', nMethyl: 'C', carbonylO: 'O', acetyl: 'C', iodide: 'I' };
  const pairs = [['oe', 'o', 'ethyl'], ['em', 'ethyl', 'methyl'], ['nh', 'n', 'h'], ['nm', 'n', 'nMethyl'],
    ['nc', 'n', 'carbonyl'], ['co', 'carbonyl', 'carbonylO', 2], ['ca', 'carbonyl', 'acetyl']];
  const bonds = pairs.map(([uuid, beginAtom, endAtom, type = 1]) => ({ uuid, beginAtom, endAtom, type, begin: p[beginAtom], end: p[endAtom] }));
  const lp = { id: 'ethoxide-lp', ownerAtomId: 'o', origin: 'manual', angle: 90 };
  const attack = M.makeArrow({ type: 'lonePair', ownerAtomId: 'o', slotId: lp.id }, { type: 'atom', atomId: 'h' },
    { bend: 0, mode: 'auto' }); attack.id = 'base-to-h';
  const release = M.makeArrow({ type: 'bond', bondId: 'nh', component: 'sigma' }, { type: 'atom', atomId: 'n' },
    { bend: -1, mode: 'auto' }); release.id = 'nh-to-n';
  const model = new M.MechanismModel({ lonePairs: [lp], arrows: [attack, release] });
  const contextAtZoom = value => {
    const unit = scale / (40 * value);
    const ctx = {
      atomPos: id => p[id], bondInfo: id => bonds.find(bond => bond.uuid === id), lonePair: id => model.lonePair(id), unit: () => unit,
      atoms: () => Object.keys(p).map(uuid => ({ uuid, label: labels[uuid] || 'C', pos: p[uuid] })), bonds: () => bonds,
      atomLabelBox: id => {
        if (!labels[id]) return { hasLabel: false };
        const center = p[id], hw = (['methyl', 'nMethyl', 'acetyl'].includes(id) ? 0.35 : id === 'o' ? 0.19 : 0.14) * scale, hh = 0.18 * scale;
        const rect = { x1: center.x - hw, x2: center.x + hw, y1: center.y - hh, y2: center.y + hh };
        return { hasLabel: true, rect, atomRect: rect, planningRect: rect, hydrogenRects: [], hwCss: hw / unit, hhCss: hh / unit };
      },
    };
    ctx.planningContextAtZoom = contextAtZoom;
    return ctx;
  };
  const ctx = contextAtZoom(zoom);
  const controller = new MW.controller.MechanismController({ adapter: { context: () => ctx }, model });
  return { p, bonds, lp, attack, release, model, controller, ctx, contextAtZoom };
};
