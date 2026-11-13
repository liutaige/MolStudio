// Observed final-report facts only: no planned objectives, model prose, or
// atom correspondence inferred between distinct reactant/product structures.
export function actualStepObservations(canvas = {}) {
  canvas ||= {};
  const atoms = new Map((canvas.atoms || []).map(atom => [atom.id, atom]));
  const bonds = new Map((canvas.bonds || []).map(bond => [bond.id, bond]));
  const pairs = new Map((canvas.lonePairs || []).map(pair => [pair.id, pair]));
  const parents = new Map([...atoms.keys()].map(id => [id, id]));
  const component = id => { if (!parents.has(id)) return null; while (parents.get(id) !== id) id = parents.get(id); return id; };
  for (const bond of bonds.values()) if (atoms.has(bond.begin) && atoms.has(bond.end)) parents.set(component(bond.end), component(bond.begin));
  const fact = id => {
    const atom = atoms.get(id), label = typeof atom?.label === 'string' && /^[A-Z][a-z]?$/.test(atom.label) ? atom.label : null;
    const charge = Number.isInteger(atom?.charge) ? atom.charge : null;
    const implicitH = Number.isInteger(atom?.implicitH) && atom.implicitH >= 0 ? atom.implicitH : null;
    return { id: id ?? null, label, charge, implicitH, unresolved: !atom || label === null || charge === null || implicitH === null,
      neighbors: [...bonds.values()].flatMap(bond => {
        const atomId = bond.begin === id ? bond.end : bond.end === id ? bond.begin : null;
        if (atomId === null) return [];
        const other = atoms.get(atomId);
        return [{ atomId, bondId: bond.id, order: Number.isFinite(bond.order) ? bond.order : null,
          label: typeof other?.label === 'string' && /^[A-Z][a-z]?$/.test(other.label) ? other.label : null,
          charge: Number.isInteger(other?.charge) ? other.charge : null, unresolved: !other || !/^[A-Z][a-z]?$/.test(other.label || '') || !Number.isInteger(other.charge) || !Number.isFinite(bond.order) }];
      }) };
  };
  const endpoint = (value = {}, source = false) => {
    value ||= {};
    let result, ids = [], unresolved = false;
    if (value.type === 'lonePair' && source) {
      const pair = pairs.get(value.slotId), owner = pair?.ownerAtomId ?? value.ownerAtomId;
      ids = [owner]; result = { kind: 'lonePair', slotId: value.slotId ?? null, atom: fact(owner) };
      unresolved = !pair || !!value.ownerAtomId && value.ownerAtomId !== pair.ownerAtomId;
    } else if (value.type === 'bond' && source) {
      const bond = bonds.get(value.bondId); ids = bond ? [bond.begin, bond.end] : [];
      result = { kind: 'bond', bondId: value.bondId ?? null, component: ['sigma', 'pi'].includes(value.component) ? value.component : null,
        order: Number.isFinite(bond?.order) ? bond.order : null, atoms: ids.map(fact) };
      unresolved = !bond || result.component === null || result.order === null;
    } else if (value.type === 'atom') {
      ids = [value.atomId]; result = { kind: 'atom', atom: fact(value.atomId) };
    } else if (value.type === 'formingBond' && !source) {
      ids = [value.atomA, value.atomB]; result = { kind: 'formingBond', atoms: ids.map(fact) };
      unresolved = value.atomA === value.atomB;
    } else { result = { kind: typeof value.type === 'string' ? value.type : null }; unresolved = true; }
    result.unresolved = unresolved || ids.some(id => fact(id).unresolved);
    return { result, ids };
  };
  const participantAtoms = refs => {
    const components = new Set(refs.map(component).filter(id => id !== null));
    return new Set([...atoms.keys()].filter(id => components.has(component(id))));
  };
  const steps = (canvas.reactionSteps || []).map(step => {
    const reactants = Array.isArray(step.reactants) ? step.reactants.slice() : [], products = Array.isArray(step.products) ? step.products.slice() : [];
    return { stepId: step.stepId ?? null, version: Number.isInteger(step.version) ? step.version : null, reactants, products,
      electronFlows: [], productAtomScope: 'noncarbon_or_charged_atoms', productAtoms: [...participantAtoms(products)].filter(id => atoms.get(id).label !== 'C' || atoms.get(id).charge !== 0).map(fact),
      unresolved: !step.stepId || !reactants.length || !products.length || [...reactants, ...products].some(id => !atoms.has(id)) };
  });
  const memberships = steps.map(step => participantAtoms(step.reactants)), unassignedElectronFlows = [];
  for (const arrow of canvas.arrows || []) {
    const source = endpoint(arrow.source, true), target = endpoint(arrow.target), known = [...new Set([...source.ids, ...target.ids])].filter(id => atoms.has(id));
    const flow = { id: arrow.id ?? null, electronCount: arrow.electronCount ?? null, source: source.result, target: target.result,
      unresolved: source.result.unresolved || target.result.unresolved || ![1, 2].includes(arrow.electronCount) };
    const candidates = steps.filter((_step, index) => known.length && known.every(id => memberships[index].has(id)));
    if (candidates.length === 1) { candidates[0].electronFlows.push(flow); if (flow.unresolved) candidates[0].unresolved = true; }
    else {
      for (const step of candidates) step.unresolved = true;
      unassignedElectronFlows.push({ ...flow, unresolved: true, candidateStepIds: candidates.map(step => step.stepId) });
    }
  }
  return { steps, unassignedElectronFlows };
}
