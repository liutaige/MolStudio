'use strict';

const unique = values => [...new Set(values)];
const sorted = values => [...values].sort();
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value ?? null);

function moleculeIndex(context) {
  const owners = new Map();
  for (const molecule of context.molecules || []) for (const atom of molecule.atoms) owners.set(atom, molecule.id);
  return owners;
}

function endpointAtoms(endpoint, context) {
  if (endpoint?.type === 'atom') return [endpoint.atomId];
  if (endpoint?.type === 'formingBond') return [endpoint.atomA, endpoint.atomB];
  if (endpoint?.type === 'radical') return [endpoint.ownerAtomId];
  if (endpoint?.type === 'lonePair') {
    const pair = context.lonePairs.find(item => item.id === endpoint.slotId);
    return pair && pair.ownerAtomId === endpoint.ownerAtomId ? [pair.ownerAtomId] : [];
  }
  if (endpoint?.type === 'bond') {
    const bond = context.bonds.find(item => item.id === endpoint.bondId);
    return bond ? [bond.begin, bond.end] : [];
  }
  return [];
}

function inspectGraph(context, savedSteps = []) {
  const owners = moleculeIndex(context), atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  const stored = new Map(savedSteps.map(step => [step.stepId, step]));
  const steps = (context.reactionSteps || []).map(step => ({ ...step, stored: stored.get(step.stepId),
    from: unique(step.reactants.map(ref => owners.get(ref)).filter(Boolean)),
    to: unique(step.products.map(ref => owners.get(ref)).filter(Boolean)) }));
  const ids = steps.map(step => step.stepId), validReferences = steps.every(step =>
    [...step.reactants, ...step.products].every(ref => owners.has(ref)) && !step.from.some(id => step.to.includes(id)));
  const next = new Map(ids.map(id => [id, new Set()])), previous = new Map(ids.map(id => [id, new Set()]));
  for (const first of steps) for (const second of steps) {
    if (first === second || !first.to.some(id => second.from.includes(id))) continue;
    next.get(first.stepId).add(second.stepId); previous.get(second.stepId).add(first.stepId);
  }
  const roots = ids.filter(id => !previous.get(id).size), degree = new Map(ids.map(id => [id, previous.get(id).size]));
  const pending = sorted(roots), topological = [], distances = new Map(ids.map(id => [id, 1]));
  while (pending.length) {
    const id = pending.shift(); topological.push(id);
    for (const successor of next.get(id)) {
      distances.set(successor, Math.max(distances.get(successor), distances.get(id) + 1));
      degree.set(successor, degree.get(successor) - 1);
      if (!degree.get(successor)) { pending.push(successor); pending.sort(); }
    }
  }
  const weak = new Map(ids.map(id => [id, new Set([...next.get(id), ...previous.get(id)])]));
  const uses = new Map();
  for (const step of steps) for (const id of [...step.from, ...step.to]) {
    if (!uses.has(id)) uses.set(id, []); uses.get(id).push(step.stepId);
  }
  for (const group of uses.values()) for (const a of group) for (const b of group) if (a !== b) weak.get(a).add(b);
  const seen = new Set(), components = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const todo = [id], members = []; seen.add(id);
    while (todo.length) {
      const item = todo.pop(); members.push(item);
      for (const other of weak.get(item)) if (!seen.has(other)) { seen.add(other); todo.push(other); }
    }
    components.push(sorted(members));
  }
  const flows = context.arrows.map(arrow => {
    const source = endpointAtoms(arrow.source, context), target = endpointAtoms(arrow.target, context);
    const atomIds = [...source, ...target], valid = !!source.length && !!target.length && atomIds.every(id => atoms.has(id));
    const moleculeIds = unique(atomIds.map(id => owners.get(id)).filter(Boolean));
    return { id: arrow.id, atomIds, valid,
      stepIds: valid ? steps.filter(step => moleculeIds.every(id => step.from.includes(id))).map(step => step.stepId) : [] };
  });
  const rowOf = step => step.stored?.flow?.rowId || 'y:' + Math.round((context.reactionArrows.find(arrow => arrow.stepId === step.stepId)?.start?.y ?? NaN) * 100) / 100;
  const regions = components.map((stepIds, index) => {
    const group = steps.filter(step => stepIds.includes(step.stepId));
    const moleculeIds = new Set(group.flatMap(step => [...step.from, ...step.to]));
    const points = context.molecules.filter(molecule => moleculeIds.has(molecule.id)).flatMap(molecule => molecule.atoms.map(id => atoms.get(id)));
    return { component: index + 1, stepIds, routeIds: unique(group.map(step => step.stored?.flow?.routeId).filter(Boolean)),
      laneIds: unique(group.map(step => step.stored?.flow?.laneId).filter(Boolean)), rows: unique(group.map(rowOf)),
      bounds: { x1: Math.min(...points.map(point => point.x)), y1: Math.min(...points.map(point => point.y)),
        x2: Math.max(...points.map(point => point.x)), y2: Math.max(...points.map(point => point.y)) } };
  });
  const labels = savedSteps.flatMap(step => (step.labels || []).map(label => ({ ...label, stepId: step.stepId })));
  const ports = labels.filter(label => label.role === 'graphPort');
  const tokens = unique(ports.map(port => port.token));
  const chemicalSideAnchors = end => {
    const step = steps.find(step => step.stepId === end.stepId);
    const side = end.side === 'source' ? step?.reactants : end.side === 'target' ? step?.products : null;
    if (!side || !Array.isArray(end.anchorRefs) || !end.anchorRefs.length) return null;
    const sideMolecules = new Set(side.map(ref => owners.get(ref)).filter(Boolean));
    if (!end.anchorRefs.every(ref => atoms.has(ref) && owners.has(ref))) return null;
    return end.anchorRefs.map(ref => sideMolecules.has(owners.get(ref)));
  };
  const portPairs = tokens.map(token => {
    const ends = ports.filter(port => port.token === token);
    const portAnchors = chemicalSideAnchors(ends.find(end => end.at === 'port') || {});
    const homeAnchors = chemicalSideAnchors(ends.find(end => end.at === 'molecule') || {});
    return { token, kinds: unique(ends.map(end => end.kind)), count: ends.length,
      paired: ends.length === 2 && ends.some(end => end.at === 'molecule') && ends.some(end => end.at === 'port') &&
        // side identifies the chemical reactants/products, not the two
        // reference roles. A wrapped step can reference its own old-row
        // reactants from a new-row arrow: both ends then have side=source.
        // The old-row home can contain a preceding product plus the next
        // co-reactant. Its owning step needs at least one member; the peer
        // port's chemical side must own the entire exact matching group.
        !!portAnchors?.every(Boolean) && !!homeAnchors?.some(Boolean) &&
        new Set(ends.map(end => end.kind)).size === 1 &&
        ends.every(end => Array.isArray(end.anchorRefs) && end.anchorRefs.length && end.anchorRefs.every(ref => atoms.has(ref))) &&
        canonical(sorted(ends[0]?.anchorRefs || [])) === canonical(sorted(ends[1]?.anchorRefs || [])),
      ends: ends.map(({ stepId, kind, side, at, anchorRefs }) => ({ stepId, kind, side, at, anchorRefs })) };
  });
  const oldCues = labels.filter(label => ['previousRow', 'nextRow'].includes(label.role));
  const legacyCuePairs = unique(oldCues.map(label => label.text)).map(token => ({ token,
    paired: oldCues.filter(label => label.text === token).length === 2 &&
      ['previousRow', 'nextRow'].every(role => oldCues.some(label => label.text === token && label.role === role)) }));
  const linkedNative = steps.map(step => {
    const arrows = context.reactionArrows.filter(arrow => arrow.stepId === step.stepId);
    const arrow = arrows[0];
    return { stepId: step.stepId, count: arrows.length,
      horizontalRightward: !!arrow && arrow.end.x > arrow.start.x && Math.abs(arrow.start.y - arrow.end.y) <= 0.025,
      row: rowOf(step), flowCount: flows.filter(flow => flow.stepIds.includes(step.stepId)).length,
      layout: step.checks?.layout || { status: 'pending', issues: [] } };
  });
  return {
    stepCount: steps.length, uniqueStepIds: new Set(ids).size === ids.length, validReferences,
    edgeCount: [...next.values()].reduce((count, group) => count + group.size, 0),
    edges: ids.flatMap(id => [...next.get(id)].map(to => [id, to])), roots, leaves: ids.filter(id => !next.get(id).size),
    acyclic: topological.length === ids.length, topological, longestPath: Math.max(0, ...distances.values()),
    forks: ids.filter(id => next.get(id).size > 1), merges: ids.filter(id => previous.get(id).size > 1),
    weakComponents: components, regions, linkedNative, flowCount: flows.length,
    endpointReferencesValid: flows.every(flow => flow.valid), unassignedFlows: flows.filter(flow => !flow.stepIds.length).map(flow => flow.id),
    flows, portPairs, legacyCuePairs, portsPaired: portPairs.every(pair => pair.paired) && legacyCuePairs.every(pair => pair.paired),
    wrapCueCount: portPairs.filter(pair => pair.kinds.includes('wrap')).length + legacyCuePairs.length,
    nonlocalCueCount: portPairs.filter(pair => pair.kinds.some(kind => kind !== 'wrap')).length,
    layoutFailures: linkedNative.filter(step => step.layout.status === 'failed'),
  };
}

async function inspectChemistry(context) {
  const { checkElectronFlowCoverage } = await import('../agent/mechanism-coverage.js');
  const { checkMechanismPreflight } = await import('../agent/mechanism-preflight.js');
  const owners = moleculeIndex(context), atomsOf = refs => unique(refs.flatMap(ref => context.molecules.find(molecule => molecule.id === owners.get(ref))?.atoms || []));
  return (context.reactionSteps || []).map(step => {
    const reactants = new Set(step.reactants.map(ref => owners.get(ref)));
    const arrows = context.arrows.filter(arrow => {
      const refs = [...endpointAtoms(arrow.source, context), ...endpointAtoms(arrow.target, context)];
      return refs.length && refs.every(ref => reactants.has(owners.get(ref)));
    });
    const input = { reactantAtoms: atomsOf(step.reactants), productAtoms: atomsOf(step.products), atoms: context.atoms,
      bonds: context.bonds, lonePairs: context.lonePairs, arrows, conditions: step.conditions };
    const preflight = checkMechanismPreflight(input);
    const coverage = arrows.length ? checkElectronFlowCoverage(input) : '缺少电子流弯箭头';
    return { stepId: step.stepId, version: step.version, status: !preflight && !coverage ? 'passed' : 'failed',
      flowCount: arrows.length, issues: [preflight && { code: preflight.code, message: preflight.message },
        coverage && { code: 'electron_flow_coverage', message: coverage }].filter(Boolean) };
  });
}

function semanticSnapshot(context, savedSteps = []) {
  return canonical({
    atoms: context.atoms.map(({ id, label, charge, isotope, radical, implicitH }) => ({ id, label, charge, isotope, radical, implicitH })).sort((a, b) => a.id.localeCompare(b.id)),
    bonds: context.bonds.map(({ id, begin, end, order, stereo }) => ({ id, begin, end, order, stereo })).sort((a, b) => a.id.localeCompare(b.id)),
    molecules: context.molecules.map(molecule => sorted(molecule.atoms)).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    arrows: context.arrows.map(({ id, source, target, electronCount }) => ({ id, source, target, electronCount })).sort((a, b) => a.id.localeCompare(b.id)),
    lonePairs: context.lonePairs.map(({ id, ownerAtomId }) => ({ id, ownerAtomId })).sort((a, b) => a.id.localeCompare(b.id)),
    steps: context.reactionSteps.map(({ stepId, version, reactants, products, conditions, layout }) => ({ stepId, version,
      reactants: sorted(reactants), products: sorted(products), conditions: conditions || '', layout })).sort((a, b) => a.stepId.localeCompare(b.stepId)),
    ports: savedSteps.flatMap(step => (step.labels || []).filter(label => label.role === 'graphPort').map(label => ({
      stepId: step.stepId, role: label.role, token: label.token, text: label.text, kind: label.kind,
      side: label.side, at: label.at, anchorRefs: sorted(label.anchorRefs || []),
    })))
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
  });
}

module.exports = { canonical, endpointAtoms, moleculeIndex, inspectGraph, inspectChemistry, semanticSnapshot };
