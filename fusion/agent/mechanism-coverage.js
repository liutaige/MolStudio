const MAX_ATOMS = 24;
const MAX_SEARCH_NODES = 20000;
const COVALENT_ELEMENTS = new Set(['H', 'B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'As', 'Se', 'Br', 'Te', 'I']);

const pairKey = (a, b, size) => Math.min(a, b) * size + Math.max(a, b);
const atomIdentity = atom => JSON.stringify([atom.label, atom.isotope || 0, atom.implicitH ?? null]);

function sideGraph(ids, atomsById, bonds, { maxAtoms = MAX_ATOMS, identity = atomIdentity } = {}) {
  const index = new Map([...new Set(ids)].map((id, i) => [id, i]));
  if (!index.size || index.size > maxAtoms) return null;
  const atoms = [...index.keys()].map(id => atomsById.get(id));
  if (atoms.some(atom => !atom || !COVALENT_ELEMENTS.has(atom.label) || atom.hasQuery || atom.alias || atom.radical > 0)) return null;
  const size = atoms.length;
  const orders = Array.from({ length: size }, () => Array(size).fill(0));
  const bondsById = new Map();
  const bondsByPair = new Map();
  for (const { id, begin, end, order } of bonds) {
    const a = index.get(begin), b = index.get(end);
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined || a === b || ![1, 1.5, 2, 3].includes(order) || orders[a][b]) return null;
    orders[a][b] = orders[b][a] = order;
    bondsById.set(id, { a, b, order });
    bondsByPair.set(pairKey(a, b, size), id);
  }
  const identities = atoms.map(identity);
  const profiles = orders.map(row => {
    const counts = new Map();
    row.forEach((order, i) => {
      if (!order) return;
      const key = order + identities[i];
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  });
  return { atoms, index, orders, bondsById, bondsByPair, identities, profiles };
}

function profileDistance(a, b) {
  let distance = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) distance += Math.abs((a.get(key) || 0) - (b.get(key) || 0));
  return distance;
}

function expectedChanges(from, to, useCharges) {
  const size = from.atoms.length;
  const withHydrogens = !!from.hydrogens && !!to.hydrogens;
  // Heavy-bond edits take precedence over hydrogen inventory edits. Hydrogen
  // depiction must not make a broken C-O map look cheaper than a proton transfer.
  const bondWeight = withHydrogens ? [...from.hydrogens, ...to.hydrogens].reduce((sum, n) => sum + n, 1) : 1;
  // Atom maps in molecule.add are local reference numbers. Match the conserved
  // atom inventory and minimize bond-order edits without looking at drawn arrows.
  const candidates = from.identities.map((identity, i) => to.identities
    .flatMap((other, j) => identity === other ? [j] : [])
    .map(j => ({ j, distance: profileDistance(from.profiles[i], to.profiles[j]) }))
    .sort((a, b) => a.distance - b.distance).map(candidate => candidate.j));
  if (candidates.some(matches => !matches.length)) return null;
  const sequence = candidates.map((_, i) => i).sort((a, b) =>
    candidates[a].length - candidates[b].length ||
    from.profiles[b].size - from.profiles[a].size);
  const mapping = Array(size).fill(-1), taken = new Set();
  let bestCost = Infinity, best = null, ambiguous = false, visited = 0;

  function visit(depth, cost) {
    if (++visited > MAX_SEARCH_NODES || cost > bestCost) return;
    if (depth === size) {
      const bonds = new Map(), charges = [], hydrogens = [];
      let aromaticChange = false;
      for (let a = 0; a < size; a++) {
        if (useCharges) charges.push(to.atoms[mapping[a]].charge - from.atoms[a].charge);
        if (withHydrogens) hydrogens.push(to.hydrogens[mapping[a]] - from.hydrogens[a]);
        for (let b = a + 1; b < size; b++) {
          const before = from.orders[a][b], after = to.orders[mapping[a]][mapping[b]];
          if (before === after) continue;
          if (before === 1.5 || after === 1.5) aromaticChange = true;
          bonds.set(pairKey(a, b, size), after - before);
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = { bonds, charges, hydrogens, aromaticChange };
        ambiguous = false;
      } else if (bonds.size !== best.bonds.size || [...bonds].some(([key, delta]) => best.bonds.get(key) !== delta) ||
        charges.some((delta, i) => delta !== best.charges[i]) ||
        hydrogens.some((delta, i) => delta !== best.hydrogens[i]) || aromaticChange !== best.aromaticChange) ambiguous = true;
      return;
    }
    const i = sequence[depth];
    for (const j of candidates[i]) {
      if (visited > MAX_SEARCH_NODES) break;
      if (taken.has(j)) continue;
      let nextCost = cost + (withHydrogens ? Math.abs(from.hydrogens[i] - to.hydrogens[j]) : 0);
      for (let earlier = 0; earlier < depth; earlier++) {
        const a = sequence[earlier];
        nextCost += Math.abs(from.orders[i][a] - to.orders[j][mapping[a]]) * bondWeight;
      }
      if (nextCost > bestCost) continue;
      mapping[i] = j;
      taken.add(j);
      visit(depth + 1, nextCost);
      taken.delete(j);
    }
  }

  visit(0, 0);
  // Equivalent permutations of spectator atoms are fine. Skip when equally
  // plausible correspondences imply different changes at the reaction site.
  return visited <= MAX_SEARCH_NODES && !ambiguous && !best?.aromaticChange ? best : null;
}

function observedChanges(graph, lonePairs, arrows, expected) {
  const { index, bondsById, atoms } = graph;
  const pairs = new Map(lonePairs.map(pair => [pair.id, pair.ownerAtomId]));
  const bonds = new Map(), charges = Array(atoms.length).fill(0);
  const transferBond = (a, b, delta) => {
    if (a === undefined || b === undefined || a === b || graph.orders[a][b] === 1.5) return false;
    const key = pairKey(a, b, atoms.length);
    bonds.set(key, (bonds.get(key) || 0) + delta);
    charges[a] -= delta;
    charges[b] -= delta;
    return true;
  };
  for (const { source, target, electronCount } of arrows) {
    if (electronCount !== 2) return null;
    const sourceBond = source?.type === 'bond' ? bondsById.get(source.bondId) : null;
    const donor = source?.type === 'atom' ? index.get(source.atomId) :
      source?.type === 'lonePair' && pairs.get(source.slotId) === source.ownerAtomId ? index.get(source.ownerAtomId) : undefined;
    if (sourceBond) {
      if (!transferBond(sourceBond.a, sourceBond.b, -1)) return null;
    } else if (donor !== undefined) charges[donor] += 2;
    else return null;

    if (target?.type === 'formingBond') {
      const a = index.get(target.atomA), b = index.get(target.atomB);
      if ((donor !== undefined && donor !== a && donor !== b) ||
        (sourceBond && ![a, b].some(atom => atom === sourceBond.a || atom === sourceBond.b)) ||
        !transferBond(a, b, 1)) return null;
    } else if (target?.type === 'bond') {
      const bond = bondsById.get(target.bondId);
      if (!bond || !transferBond(bond.a, bond.b, 1)) return null;
    } else if (target?.type === 'atom') {
      const acceptor = index.get(target.atomId);
      if (acceptor === undefined) return null;
      if (donor !== undefined) {
        if (!transferBond(donor, acceptor, 1)) return null;
      } else if (acceptor === sourceBond.a || acceptor === sourceBond.b) charges[acceptor] -= 2;
      else {
        // The atom endpoint omits which end of the donor bond connects to it.
        // Interpret it only if the product graph identifies one such bond gain.
        const ends = [sourceBond.a, sourceBond.b]
          .filter(a => expected.bonds.get(pairKey(a, acceptor, atoms.length)) > 0);
        if (ends.length !== 1 || !transferBond(ends[0], acceptor, 1)) return null;
      }
    } else return null;
  }
  return { bonds, charges };
}

function hydrogenInventoryGraph(ids, atomsById, bonds) {
  // Only ordinary terminal hydrogen is a representation choice here. Isotopic,
  // charged, radical, bridging and stereochemical hydrogen keep the old path.
  const full = sideGraph(ids, atomsById, bonds, { maxAtoms: MAX_ATOMS * 5 });
  if (!full) return null;
  const explicit = full.atoms.filter(atom => atom.label === 'H');
  const heavy = full.atoms.filter(atom => atom.label !== 'H');
  if (!heavy.length || heavy.some(atom => !Number.isInteger(atom.implicitH) || atom.implicitH < 0)) return null;
  const attached = new Map();
  for (const atom of explicit) {
    const links = bonds.filter(bond => bond.begin === atom.id || bond.end === atom.id);
    const bond = links[0];
    const parent = bond && atomsById.get(bond.begin === atom.id ? bond.end : bond.begin);
    if (atom.charge !== 0 || atom.isotope || atom.radical || atom.implicitH !== 0 || atom.aromatic ||
      atom.stereoLabel || atom.stereoParity || links.length !== 1 || bond.order !== 1 || bond.stereo ||
      bond.aromatic || !parent || parent.label === 'H' || parent.stereoLabel || parent.stereoParity) return null;
    attached.set(parent.id, (attached.get(parent.id) || 0) + 1);
  }
  const graph = sideGraph(heavy.map(atom => atom.id), atomsById,
    bonds.filter(bond => !explicit.some(atom => atom.id === bond.begin || atom.id === bond.end)),
    { identity: atom => JSON.stringify([atom.label, atom.isotope || 0]) });
  if (!graph) return null;
  graph.hydrogens = graph.atoms.map(atom => atom.implicitH + (attached.get(atom.id) || 0));
  graph.full = full;
  graph.explicit = explicit.length;
  return graph;
}

function checkHydrogenInventoryCoverage(from, to, lonePairs, arrows) {
  if (from.atoms.length !== to.atoms.length) return null;
  if ([...from.identities].sort().some((identity, i) => identity !== [...to.identities].sort()[i])) return null;
  const sum = values => values.reduce((total, n) => total + n, 0);
  if (sum(from.hydrogens) !== sum(to.hydrogens)) return '反应物与产物的总氢数不守恒，无法核对电子流。';
  const useCharges = [...from.atoms, ...to.atoms].every(atom => Number.isInteger(atom.charge));
  if (useCharges && sum(from.atoms.map(atom => atom.charge)) !== sum(to.atoms.map(atom => atom.charge))) return null;
  const expected = expectedChanges(from, to, useCharges);
  if (!expected || (!expected.bonds.size && !expected.charges.some(Boolean) && !expected.hydrogens.some(Boolean))) return null;

  // Parse the real explicit-H endpoints first; normalize only the resulting
  // changes. Do not invent an identity between two differently displayed Hs.
  const full = from.full;
  const fullExpected = { bonds: new Map() };
  for (const [key, delta] of expected.bonds) {
    const a = full.index.get(from.atoms[Math.floor(key / from.atoms.length)].id);
    const b = full.index.get(from.atoms[key % from.atoms.length].id);
    fullExpected.bonds.set(pairKey(a, b, full.atoms.length), delta);
  }
  const observed = observedChanges(full, lonePairs, arrows, fullExpected);
  if (!observed) return null;
  const normalized = { bonds: new Map(), hydrogens: Array(from.atoms.length).fill(0),
    charges: from.atoms.map(atom => observed.charges[full.index.get(atom.id)]) };
  for (const [key, delta] of observed.bonds) {
    if (!delta) continue;
    const a = full.atoms[Math.floor(key / full.atoms.length)], b = full.atoms[key % full.atoms.length];
    if (a.label === 'H' || b.label === 'H') {
      const parent = a.label === 'H' ? b : a;
      const i = from.index.get(parent.id);
      if (i === undefined) return null;
      normalized.hydrogens[i] += delta;
    } else normalized.bonds.set(pairKey(from.index.get(a.id), from.index.get(b.id), from.atoms.length), delta);
  }
  const describe = i => from.atoms[i].label + '（' + from.atoms[i].id + '）';
  for (const [key, delta] of expected.bonds) {
    const actual = normalized.bonds.get(key) || 0;
    const pair = describe(Math.floor(key / from.atoms.length)) + '–' + describe(key % from.atoms.length);
    if (delta > 0 && actual < delta) return '缺少提高键级的电子流：' + pair + '。';
    if (delta < 0 && actual > delta) return '缺少降低键级的电子流：' + pair + '。';
  }
  for (const [key, actual] of normalized.bonds) {
    if (actual !== (expected.bonds.get(key) || 0)) return '电子流给出的键级变化与产物不符：' +
      describe(Math.floor(key / from.atoms.length)) + '–' + describe(key % from.atoms.length) + '。';
  }
  const hMismatch = expected.hydrogens.findIndex((delta, i) => delta !== normalized.hydrogens[i]);
  if (hMismatch !== -1) return '电子流给出的氢转移与产物不符：' + describe(hMismatch) + '。';
  // Each explicitly drawn ordinary H must remain neutral. Missing either half
  // of a proton transfer is therefore still rejected after representation folding.
  const badH = full.atoms.find((atom, i) => atom.label === 'H' && observed.charges[i] !== 0);
  if (badH) return '电子流给出的氢形式电荷变化与产物不符：H（' + badH.id + '）。';
  const mismatch = expected.charges.findIndex((delta, i) => delta !== normalized.charges[i]);
  return mismatch === -1 ? null : '电子流给出的形式电荷变化与产物不符：' + describe(mismatch) + '。';
}

/** A local invariant does not require guessing atom identities across products.
 * In an ordinary two-electron O/N-H proton transfer, the paired base donation
 * identifies H as a proton. Its sigma pair cannot be sent to another heavy
 * atom as though that atom were the retained donor heteroatom. */
export function findInvalidProtonTransfer({ reactantAtoms = [], productAtoms = [], atoms = [], bonds = [], lonePairs = [], arrows = [] } = {}) {
  const atomsById = new Map(atoms.map(atom => [atom.id, atom]));
  const bondsById = new Map(bonds.map(bond => [bond.id, bond]));
  const pairsById = new Map(lonePairs.map(pair => [pair.id, pair]));
  const reactants = new Set(reactantAtoms);
  const ordinary = atom => atom && !atom.hasQuery && !atom.alias && !(atom.radical > 0);
  const sourceBond = source => bondsById.get(source.bondId) || bonds.find(bond => {
    const a = source.atom1 ?? source.begin, b = source.atom2 ?? source.end;
    return a && b && (bond.begin === a && bond.end === b || bond.begin === b && bond.end === a);
  });
  let expected, graph, mapped = false;
  const supportedHeavyBondGain = (a, b) => {
    if (!mapped) {
      mapped = true;
      graph = hydrogenInventoryGraph(reactantAtoms, atomsById, bonds);
      const product = hydrogenInventoryGraph(productAtoms, atomsById, bonds);
      if (graph && product && graph.atoms.length === product.atoms.length) expected = expectedChanges(graph, product, false);
    }
    const i = graph?.index.get(a), j = graph?.index.get(b);
    return i !== undefined && j !== undefined && expected?.bonds.get(pairKey(i, j, graph.atoms.length)) > 0;
  };
  for (const arrow of arrows) {
    if (arrow.electronCount !== 2 || arrow.source?.type !== 'bond' || arrow.source.component === 'pi' || arrow.target?.type !== 'atom') continue;
    const bond = sourceBond(arrow.source);
    if (!bond || bond.order !== 1 || bond.aromatic || !reactants.has(bond.begin) || !reactants.has(bond.end)) continue;
    const protonId = [bond.begin, bond.end].find(id => atomsById.get(id)?.label === 'H');
    const retainedId = protonId === bond.begin ? bond.end : bond.begin;
    const proton = atomsById.get(protonId), retained = atomsById.get(retainedId);
    if (!ordinary(proton) || (proton.charge ?? 0) !== 0 || proton.isotope ||
        !ordinary(retained) || !['O', 'N'].includes(retained.label)) continue;
    const links = bonds.filter(item => reactants.has(item.begin) && reactants.has(item.end) &&
      (item.begin === protonId || item.end === protonId));
    if (links.length !== 1 || arrow.target.atomId === retainedId) continue;
    const actualTarget = atomsById.get(arrow.target.atomId);
    // Concerted proton relays may use X-H sigma -> a second proton; metal,
    // hydride, radical and bond-forming pathways need their own accounting.
    if (!ordinary(actualTarget) || actualTarget.label === 'H' && actualTarget.id !== protonId || !COVALENT_ELEMENTS.has(actualTarget.label) ||
        !reactants.has(actualTarget.id)) continue;
    const companion = arrows.find(other => {
      if (other.id === arrow.id || other.electronCount !== 2 || !['lonePair', 'atom'].includes(other.source?.type)) return false;
      const pair = other.source.type === 'lonePair' ? pairsById.get(other.source.slotId) : null;
      const donorId = other.source.type === 'atom' ? other.source.atomId : pair?.ownerAtomId;
      if (other.source.type === 'lonePair' && (!pair || other.source.ownerAtomId && other.source.ownerAtomId !== donorId)) return false;
      const donor = atomsById.get(donorId);
      if (!ordinary(donor) || donor.label === 'H' || !COVALENT_ELEMENTS.has(donor.label) ||
          !reactants.has(donorId) || donorId === retainedId || donorId === protonId) return false;
      return other.target?.type === 'atom' ? other.target.atomId === protonId :
        other.target?.type === 'formingBond' && [other.target.atomA, other.target.atomB].includes(protonId) &&
          [other.target.atomA, other.target.atomB].includes(donorId);
    });
    if (!companion || supportedHeavyBondGain(retainedId, actualTarget.id)) continue;
    return { code: 'proton_transfer_sigma_wrong_target',
      message: `已配对的质子转移中，${retained.label}–H 键 ${bond.id} 的 σ 电子应回到供质子的 ${retained.label} 原子 ${retainedId}，以保持氢的电子计数；不能指向原子 ${actualTarget.id}。`,
      arrowIds: [arrow.id], arrowId: arrow.id, sourceBondId: bond.id, protonAtomId: protonId,
      correctTargetAtomId: retainedId, actualTargetAtomId: actualTarget.id, companionArrowId: companion.id };
  }
  return null;
}

// Compare repeated bond changes with a uniquely mapped product graph.
export function hasProvenElectronFlowOverdraw({ reactantAtoms, productAtoms, atoms = [], bonds = [], lonePairs = [], arrows = [] }) {
  if (!reactantAtoms?.length || !productAtoms?.length || reactantAtoms.some(id => productAtoms.includes(id))) return null;
  if (arrows.some(arrow => arrow.electronCount !== 2)) return null;
  const atomsById = new Map(atoms.map(atom => [atom.id, atom]));
  const from = sideGraph(reactantAtoms || [], atomsById, bonds);
  const to = sideGraph(productAtoms || [], atomsById, bonds);
  if (!from || !to || from.atoms.length !== to.atoms.length) return null;
  const expected = expectedChanges(from, to, false);
  if (!expected || expected.aromaticChange) return null;
  const incoming = new Map(), outgoing = new Map(), releases = new Map();
  for (const arrow of arrows) {
    const sourceBond = arrow.source?.type === 'bond' ? from.bondsById.get(arrow.source.bondId) : null;
    if (sourceBond) {
      const key = pairKey(sourceBond.a, sourceBond.b, from.atoms.length);
      outgoing.set(key, (outgoing.get(key) || 0) + 1);
      const acceptor = arrow.target?.type === 'atom' ? from.index.get(arrow.target.atomId) : undefined;
      if (acceptor === sourceBond.a || acceptor === sourceBond.b) {
        const releaseKey = key + ':' + acceptor;
        const release = releases.get(releaseKey) || { bond: key, ids: [] };
        release.ids.push(arrow.id);
        releases.set(releaseKey, release);
      }
    }
    let endpoints = null;
    if (arrow.target?.type === 'formingBond') endpoints = [arrow.target.atomA, arrow.target.atomB];
    else if (arrow.target?.type === 'bond') {
      const bond = from.bondsById.get(arrow.target.bondId);
      if (bond) endpoints = [from.atoms[bond.a].id, from.atoms[bond.b].id];
    } else if (arrow.target?.type === 'atom' && arrow.source?.type === 'bond') {
      if (!sourceBond) continue;
      const acceptor = from.index.get(arrow.target.atomId);
      const likely = [sourceBond.a, sourceBond.b].filter(a => a !== acceptor &&
        expected.bonds.get(pairKey(a, acceptor, from.atoms.length)) > 0);
      if (likely.length === 1) endpoints = [from.atoms[likely[0]].id, arrow.target.atomId];
    } else if (arrow.target?.type === 'atom') {
      const pair = arrow.source?.type === 'lonePair' ? lonePairs.find(item => item.id === arrow.source.slotId) : null;
      const owner = arrow.source?.type === 'atom' ? arrow.source.atomId : pair?.ownerAtomId;
      if (owner) endpoints = [owner, arrow.target.atomId];
    }
    if (!endpoints?.every(id => from.index.has(id))) continue;
    const key = pairKey(from.index.get(endpoints[0]), from.index.get(endpoints[1]), from.atoms.length);
    const entries = incoming.get(key) || [];
    entries.push(arrow.id);
    incoming.set(key, entries);
  }
  for (const [key, ids] of incoming) {
    const allowedIncoming = Math.max(0, (expected.bonds.get(key) || 0) + (outgoing.get(key) || 0));
    if (ids.length > 1 && ids.length > allowedIncoming) {
      return { arrowIds: ids.slice(allowedIncoming), bond: key };
    }
  }
  for (const { bond, ids } of releases.values()) {
    const allowedOutgoing = Math.max(0, (incoming.get(bond)?.length || 0) - (expected.bonds.get(bond) || 0));
    if (ids.length > 1 && ids.length > allowedOutgoing) {
      return { arrowIds: ids.slice(allowedOutgoing), bond, loss: true };
    }
  }
  return null;
}

export function checkElectronFlowCoverage({ reactantAtoms, productAtoms, atoms = [], bonds = [], lonePairs = [], arrows = [] }) {
  const protonTransfer = findInvalidProtonTransfer({ reactantAtoms, productAtoms, atoms, bonds, lonePairs, arrows });
  if (protonTransfer) return protonTransfer.message;
  const atomsById = new Map(atoms.map(atom => [atom.id, atom]));
  const inventoryFrom = hydrogenInventoryGraph(reactantAtoms, atomsById, bonds);
  const inventoryTo = hydrogenInventoryGraph(productAtoms, atomsById, bonds);
  if (inventoryFrom && inventoryTo && (inventoryFrom.explicit || inventoryTo.explicit)) {
    return checkHydrogenInventoryCoverage(inventoryFrom, inventoryTo, lonePairs, arrows);
  }
  const from = sideGraph(reactantAtoms, atomsById, bonds), to = sideGraph(productAtoms, atomsById, bonds);
  if (!from || !to || from.atoms.length !== to.atoms.length) return null;
  const useCharges = [...from.atoms, ...to.atoms].every(atom => Number.isInteger(atom.charge));
  const totalCharge = graph => graph.atoms.reduce((sum, atom) => sum + atom.charge, 0);
  if (useCharges && totalCharge(from) !== totalCharge(to)) return null;

  const expected = expectedChanges(from, to, useCharges);
  if (!expected || (!expected.bonds.size && !expected.charges.some(Boolean))) return null;
  const observed = observedChanges(from, lonePairs, arrows, expected);
  if (!observed) return null;

  const size = from.atoms.length;
  const describeAtom = i => from.atoms[i].label + '（' + from.atoms[i].id + '）';
  const describeBond = key => {
    const id = from.bondsByPair.get(key);
    return describeAtom(Math.floor(key / size)) + '–' + describeAtom(key % size) + (id ? '，键 ' + id : '');
  };
  for (const [key, delta] of expected.bonds) {
    const actual = observed.bonds.get(key) || 0;
    if (delta > 0 && actual < delta) return '缺少提高键级的电子流：' + describeBond(key) + '。';
    if (delta < 0 && actual > delta) return '缺少降低键级的电子流：' + describeBond(key) + '。';
  }
  for (const [key, actual] of observed.bonds) {
    const delta = expected.bonds.get(key) || 0;
    if (actual !== delta) return '电子流给出的键级变化与产物不符：' + describeBond(key) + '。';
  }
  const mismatch = expected.charges.findIndex((delta, i) => delta !== observed.charges[i]);
  return mismatch === -1 ? null : '电子流给出的形式电荷变化与产物不符：' + describeAtom(mismatch) + '。';
}
