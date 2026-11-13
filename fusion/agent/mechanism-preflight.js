import { hasProvenElectronFlowOverdraw, findInvalidProtonTransfer } from './mechanism-coverage.js';

function donorAtom(arrow, lonePairsById) {
  const { source } = arrow;
  if (source?.type === 'atom') return source.atomId;
  if (source?.type === 'lonePair') return lonePairsById.get(source.slotId)?.ownerAtomId ?? source.ownerAtomId;
  return null;
}

function normalizedSource(source) {
  if (source?.type === 'atom') return JSON.stringify(['atom', source.atomId]);
  if (source?.type === 'lonePair') return JSON.stringify(['lonePair', source.slotId, source.ownerAtomId]);
  if (source?.type === 'bond') return JSON.stringify(['bond', source.bondId ?? null, ...[source.atom1, source.atom2].filter(Boolean).sort(), source.component ?? null]);
  return JSON.stringify(source);
}

function normalizedTarget({ source, target }) {
  if (target?.type === 'formingBond') return JSON.stringify(['bond', ...[target.atomA, target.atomB].sort()]);
  if (target?.type === 'atom') {
    const donor = source?.type === 'lonePair' ? source.ownerAtomId : source?.type === 'atom' ? source.atomId : null;
    if (donor) return JSON.stringify(['bond', ...[donor, target.atomId].sort()]);
    return JSON.stringify(['atom', target.atomId]);
  }
  if (target?.type === 'bond' && target.begin && target.end) return JSON.stringify(['bond', ...[target.begin, target.end].sort()]);
  return JSON.stringify(target);
}

export function findDuplicateTwoElectronMove(arrows, changedIds) {
  const moves = new Map();
  for (const arrow of arrows) {
    if (arrow.electronCount !== 2) continue;
    const key = `${normalizedSource(arrow.source)}->${normalizedTarget(arrow)}`;
    const first = moves.get(key);
    if (!first) moves.set(key, arrow);
    else if (!changedIds || changedIds.has(first.id) || changedIds.has(arrow.id)) {
      return { code: 'duplicate_two_electron_target', message: '同一双电子移动被重复绘制。', arrowIds: [first.id, arrow.id] };
    }
  }
  return null;
}

function conditionsSayDithionite(conditions) {
  const value = (typeof conditions === 'string' ? conditions : JSON.stringify(conditions ?? ''))
    .replace(/[₀-₉]/g, digit => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(digit)));
  const dithionite = /(?:Na\s*2\s*S\s*2\s*O\s*4|sodium\s+dithionite|dithionite|连二亚硫酸钠|保险粉)/i.test(value);
  const otherHydrideDonor = /(?:Li\s*Al\s*H\s*4|Na\s*B\s*H\s*4|DIBAL|borohydride|aluminium\s+hydride|aluminum\s+hydride|hydride\s+donor|氢化铝锂|硼氢化钠)/i.test(value);
  return dithionite && !otherHydrideDonor;
}

/** Conservative semantic checks for clearly malformed electron-flow shorthand. */
export function checkMechanismPreflight({ reactantAtoms = [], productAtoms = [], atoms = [], bonds = [], lonePairs = [], arrows = [], conditions = '' } = {}) {
  const atomById = new Map(atoms.map(atom => [atom.id, atom]));
  const bondById = new Map(bonds.map(bond => [bond.id, bond]));
  const lonePairsById = new Map(lonePairs.map(pair => [pair.id, pair]));
  const reactantSet = new Set(reactantAtoms);

  const duplicate = findDuplicateTwoElectronMove(arrows);
  if (duplicate) return duplicate;
  const lonePairUse = new Map();
  for (const arrow of arrows) {
    if (arrow.electronCount !== 2 || arrow.source?.type !== 'lonePair') continue;
    const prior = lonePairUse.get(arrow.source.slotId);
    if (prior) return { code: 'duplicate_lone_pair_donation', message: '同一孤对电子不能被多个双电子箭头重复使用。', arrowIds: [prior.id, arrow.id] };
    lonePairUse.set(arrow.source.slotId, arrow);
  }
  const overdraw = hasProvenElectronFlowOverdraw({ reactantAtoms, productAtoms, atoms, bonds, lonePairs, arrows });
  if (overdraw) {
    const message = overdraw.loss ? '双电子箭头造成的键级下降超过产物结构所支持的数量。'
      : '双电子箭头造成的键级增加超过产物结构所支持的数量。';
    return { code: 'duplicate_two_electron_target', message, arrowIds: overdraw.arrowIds };
  }

  // Keep the proton check to the recognizable N-H -> isolated hydroxide case.
  for (const arrow of arrows) {
    if (arrow.electronCount !== 2 || arrow.source?.type !== 'bond' || arrow.target?.type !== 'atom') continue;
    const bond = bondById.get(arrow.source.bondId) || arrow.source;
    const ends = [bond.begin, bond.end];
    const proton = ends.find(id => atomById.get(id)?.label === 'H');
    const acid = ends.find(id => id !== proton);
    if (!proton || !acid || arrow.target.atomId === acid) continue;
    const base = arrow.target.atomId;
    if (!reactantSet.has(proton)) continue;
    const baseAtom = atomById.get(base);
    const baseNeighbors = bonds.flatMap(item => {
      const neighbor = item.begin === base ? item.end : item.end === base ? item.begin : null;
      return neighbor && reactantSet.has(neighbor) ? [atomById.get(neighbor)] : [];
    }).filter(Boolean);
    const baseHeavyNeighbors = baseNeighbors.filter(neighbor => neighbor.label !== 'H');
    const explicitHydrogens = baseNeighbors.filter(neighbor => neighbor.label === 'H').length;
    const hydroxideHydrogenCount = explicitHydrogens + (Number(baseAtom?.implicitH) || 0);
    const explicitHydroxide = baseAtom?.label === 'O' && baseAtom.charge === -1 &&
      baseHeavyNeighbors.length === 0 && hydroxideHydrogenCount === 1;
    // This recognizable acid/base case is invalid even when other bond
    // changes occur in the same linked step (for example N-alkylation).
    if (acidAtomIsNitrogen(atomById.get(acid)) && explicitHydroxide) {
      return { code: 'proton_transfer_sigma_to_base', message: '质子转移时，N–H 键电子应指向氮原子，而不是氢氧根的氧。', arrowIds: [arrow.id] };
    }
  }

  const protonTransfer = findInvalidProtonTransfer({ reactantAtoms, productAtoms, atoms, bonds, lonePairs, arrows });
  if (protonTransfer) return protonTransfer;

  if (conditionsSayDithionite(conditions)) {
    for (const arrow of arrows) {
      if (arrow.electronCount !== 2) continue;
      const id = donorAtom(arrow, lonePairsById), atom = atomById.get(id);
      if (!atom || atom.label !== 'H' || atom.charge !== -1 || !reactantSet.has(id)) continue;
      if (bonds.some(bond => bond.begin === id || bond.end === id)) continue;
      return { code: 'isolated_hydride_dithionite_source', message: '水溶液中的连二亚硫酸钠不应将孤立 H⁻ 画作电子来源。', arrowIds: [arrow.id] };
    }
  }
  return null;
}

function acidAtomIsNitrogen(atom) { return atom?.label === 'N'; }

