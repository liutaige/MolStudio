'use strict';

// A comparison view only: the real canvas is never changed. An accepted
// makeExplicit receipt can explain a new H node while preserving old chemistry.
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const atomState = atom => ({ id: atom.id, label: atom.label, charge: atom.charge || 0, radical: atom.radical || 0,
  implicitH: atom.implicitH || 0, isotope: atom.isotope || 0, aromatic: !!atom.aromatic, hasQuery: !!atom.hasQuery,
  stereoLabel: atom.stereoLabel || null, stereoParity: atom.stereoParity || null, alias: atom.alias || null });
const bondState = bond => ({ id: bond.id, ends: [bond.begin, bond.end].sort(), order: bond.order,
  aromatic: !!bond.aromatic, nativeType: bond.nativeType ?? bond.order, stereo: bond.stereo || 0 });
const arrowState = arrow => ({ id: arrow.id, source: arrow.source, target: arrow.target, electronCount: arrow.electronCount });
const stepState = step => ({ stepId: step.stepId, reactants: [...step.reactants].sort(), products: [...step.products].sort(),
  conditions: step.conditions || step.layout?.conditions || '' });

function normalizeReceiptedHydrogens(seed, current, receipts = [], events = []) {
  const normalized = clone(current), issues = [], materializations = [];
  const fail = (code, details = {}) => issues.push({ code, ...details });
  const before = new Map(seed.atoms.map(atom => [atom.id, atom])), now = new Map(current.atoms.map(atom => [atom.id, atom]));
  const oldBonds = new Set(seed.bonds.map(bond => bond.id)), records = new Map();
  for (const receipt of receipts) {
    const success = receipt.success !== false && (receipt.success === true || events.some(event => event.type === 'tool_end' &&
      event.toolName === 'draw_operations' && event.isError === false && event.runId === receipt.runId && event.at === receipt.at));
    if (!success) continue;
    for (const entry of receipt.created || []) {
      if (entry.type !== 'hydrogen.makeExplicit' || !before.has(entry.parentAtomId)) continue;
      const hydrogenId = entry.atoms?.[0]?.id;
      if (before.has(hydrogenId)) continue; // Materialized before this review baseline.
      if (entry.atoms?.length !== 1 || entry.bonds?.length !== 1 || typeof hydrogenId !== 'string') {
        fail('invalid_materialization_receipt', { operationId: entry.id }); continue;
      }
      const prior = records.get(hydrogenId);
      if (prior && canonical(prior) !== canonical(entry)) fail('conflicting_materialization_receipts', { hydrogenId });
      else records.set(hydrogenId, entry);
    }
  }
  const byParent = new Map();
  for (const [hydrogenId, entry] of records) {
    const parent = before.get(entry.parentAtomId), hydrogen = now.get(hydrogenId), bondId = entry.bonds[0].id;
    const incident = current.bonds.filter(bond => [bond.begin, bond.end].includes(hydrogenId));
    const plain = hydrogen && hydrogen.label === 'H' && !hydrogen.charge && !hydrogen.radical && !hydrogen.implicitH &&
      !hydrogen.isotope && !hydrogen.aromatic && !hydrogen.hasQuery && !hydrogen.stereoLabel && !hydrogen.stereoParity && !hydrogen.alias;
    const allowedParent = ['C', 'N', 'O'].includes(parent.label) && !parent.aromatic && !parent.hasQuery &&
      !parent.stereoLabel && !parent.stereoParity && !seed.bonds.some(bond => [bond.begin, bond.end].includes(parent.id) && bond.stereo);
    const correctBond = incident.length === 1 && incident[0].id === bondId && !oldBonds.has(bondId) && incident[0].order === 1 &&
      !incident[0].aromatic && !incident[0].stereo && (incident[0].nativeType ?? 1) === 1 &&
      [incident[0].begin, incident[0].end].includes(parent.id) &&
      canonical([entry.bonds[0].begin, entry.bonds[0].end].sort()) === canonical([parent.id, hydrogenId].sort());
    const owner = current.molecules.filter(molecule => molecule.atoms.includes(hydrogenId));
    const counts = Number.isInteger(entry.implicitBefore) && entry.implicitBefore > 0 && entry.implicitBefore <= 4 &&
      entry.implicitAfter === entry.implicitBefore - 1 && Number.isInteger(entry.hydrogenTotalBefore) &&
      entry.hydrogenTotalBefore === entry.hydrogenTotalAfter;
    if (!plain || !allowedParent || !correctBond || !counts || owner.length !== 1 || !owner[0].atoms.includes(parent.id) ||
        current.lonePairs.some(pair => pair.ownerAtomId === hydrogenId)) {
      fail('unverified_materialized_hydrogen', { operationId: entry.id, parentAtomId: parent.id, hydrogenId }); continue;
    }
    if (!byParent.has(parent.id)) byParent.set(parent.id, []);
    byParent.get(parent.id).push({ entry, hydrogenId, bondId });
  }
  for (const [parentId, items] of byParent) {
    items.sort((a, b) => b.entry.implicitBefore - a.entry.implicitBefore);
    let count = before.get(parentId).implicitH || 0;
    for (const item of items) {
      if (item.entry.implicitBefore !== count || item.entry.implicitAfter !== count - 1) fail('implicit_hydrogen_sequence_mismatch', { parentAtomId: parentId });
      count--;
    }
    if (now.get(parentId)?.implicitH !== count) fail('parent_hydrogen_count_mismatch', { parentAtomId: parentId });
    const atom = normalized.atoms.find(atom => atom.id === parentId);
    if (atom) atom.implicitH = before.get(parentId).implicitH;
    materializations.push(...items.map(({ entry, hydrogenId, bondId }) => ({ operationId: entry.id, parentAtomId: parentId,
      hydrogenId, bondId, implicitBefore: entry.implicitBefore, implicitAfter: entry.implicitAfter })));
  }
  const removedH = new Set(materializations.map(item => item.hydrogenId)), removedBonds = new Set(materializations.map(item => item.bondId));
  normalized.atoms = normalized.atoms.filter(atom => !removedH.has(atom.id));
  normalized.bonds = normalized.bonds.filter(bond => !removedBonds.has(bond.id));
  normalized.molecules = normalized.molecules.map(molecule => ({ ...molecule, atoms: molecule.atoms.filter(id => !removedH.has(id)) }));
  return { context: normalized, materializations, issues };
}

function reviewedChemistryPreserved(seed, current, receipts = [], events = []) {
  const result = normalizeReceiptedHydrogens(seed, current, receipts, events), after = result.context;
  const compare = (key, identity, project) => {
    const index = new Map(after[key].map(item => [item[identity], item]));
    if (index.size !== after[key].length || seed[key].some(item => canonical(project(item)) !== canonical(index.get(item[identity]) && project(index.get(item[identity]))))) {
      result.issues.push({ code: 'reviewed_' + key + '_changed' });
    }
  };
  compare('atoms', 'id', atomState); compare('bonds', 'id', bondState); compare('arrows', 'id', arrowState);
  compare('lonePairs', 'id', pair => ({ id: pair.id, ownerAtomId: pair.ownerAtomId, electronCount: pair.electronCount ?? 2 }));
  compare('reactionSteps', 'stepId', stepState);
  const oldAtoms = new Set(seed.atoms.map(atom => atom.id)), oldBonds = new Set(seed.bonds.map(bond => bond.id));
  const members = new Set(seed.molecules.map(molecule => canonical([...molecule.atoms].sort())));
  const currentMembers = after.molecules.map(molecule => canonical([...molecule.atoms].sort()));
  if (new Set(currentMembers).size !== currentMembers.length || [...members].some(item => !currentMembers.includes(item)) ||
      after.molecules.some(molecule => molecule.atoms.some(id => oldAtoms.has(id)) && !members.has(canonical([...molecule.atoms].sort())))) {
    result.issues.push({ code: 'reviewed_molecule_members_changed' });
  }
  if (after.bonds.some(bond => !oldBonds.has(bond.id) && (oldAtoms.has(bond.begin) || oldAtoms.has(bond.end)))) {
    result.issues.push({ code: 'new_covalent_bond_on_reviewed_atom' });
  }
  return { ...result, pass: result.issues.length === 0 };
}

module.exports = { normalizeReceiptedHydrogens, reviewedChemistryPreserved };
