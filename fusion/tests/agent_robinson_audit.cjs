'use strict';
const fs = require('node:fs'), path = require('node:path');
const reference = require('./fixtures/robinson_annulation_reference.json');
const ROBINSON_CASE = { name: 'ROBINSON', ...reference,
  prompt: fs.readFileSync(path.join(__dirname, 'fixtures/robinson_annulation_prompt.txt'), 'utf8').trim() };

function moleculeGraphs(context) {
  const atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  return context.molecules.map(molecule => {
    const members = molecule.atoms.map(id => atoms.get(id)).filter(Boolean), heavy = members.filter(atom => atom.label !== 'H');
    const index = new Map(heavy.map((atom, i) => [atom.id, i]));
    const bonds = context.bonds.filter(bond => index.has(bond.begin) && index.has(bond.end))
      .map(bond => ({ begin: index.get(bond.begin), end: index.get(bond.end), order: bond.order }));
    return { moleculeId: molecule.id, atoms: heavy.map(atom => ({ ...atom,
      hydrogens: Number(atom.implicitH) + context.bonds.filter(bond => bond.begin === atom.id && atoms.get(bond.end)?.label === 'H' ||
        bond.end === atom.id && atoms.get(bond.begin)?.label === 'H').length })), bonds };
  });
}

// Exact heavy-atom graph isomorphism, with explicit H folded into H counts.
// No atom-map labels or stereochemical depiction are required. Resonance/enol
// representations are relaxed only for the observed Michael skeleton stage.
function matchesGraph(graph, pattern, relaxed = false) {
  if (graph.atoms.length !== pattern.atoms.length || graph.bonds.length !== pattern.bonds.length) return false;
  const adjacency = item => {
    const map = item.atoms.map(() => new Map());
    for (const bond of item.bonds) { map[bond.begin].set(bond.end, bond.order); map[bond.end].set(bond.begin, bond.order); }
    return map;
  };
  const actual = adjacency(graph), expected = adjacency(pattern), assigned = new Map(), used = new Set();
  const options = pattern.atoms.map((atom, i) => graph.atoms.flatMap((candidate, j) =>
    atom.label === candidate.label && actual[j].size === expected[i].size && !candidate.radical && !candidate.hasQuery &&
    (relaxed || (Number(candidate.charge) || 0) === atom.charge && candidate.hydrogens === atom.hydrogens) ? [j] : []));
  const order = pattern.atoms.map((_, i) => i).sort((a, b) => options[a].length - options[b].length || expected[b].size - expected[a].size);
  const search = depth => {
    if (depth === order.length) return true;
    const i = order[depth];
    for (const j of options[i]) {
      if (used.has(j) || [...assigned].some(([a, b]) => expected[i].has(a) !== actual[j].has(b) ||
        expected[i].has(a) && !relaxed && Math.abs(expected[i].get(a) - actual[j].get(b)) > 0.01)) continue;
      assigned.set(i, j); used.add(j);
      if (search(depth + 1)) return true;
      assigned.delete(i); used.delete(j);
    }
    return false;
  };
  return search(0);
}

function inspectRobinson(context, graph) {
  const atoms = new Map(context.atoms.map(atom => [atom.id, atom])), bonds = new Map(context.bonds.map(bond => [bond.id, bond]));
  const owners = new Map();
  for (const molecule of context.molecules) for (const id of molecule.atoms) owners.set(id, molecule.id);
  const structures = moleculeGraphs(context), find = (name, relaxed = false) => structures.filter(item => matchesGraph(item, reference.references[name], relaxed)).map(item => item.moleculeId);
  const candidates = { dione: find('dione'), methylVinylKetone: find('methylVinylKetone'), michaelSkeleton: find('michaelTrione', true),
    aldolKetol: find('aldolKetol', true), target: find('wielandMiescher'), wrongFiveSixRing: find('hajosParrishNegative'),
    pyrrolidine: find('pyrrolidine'), pyrrolidinium: find('pyrrolidinium'), hydroxide: find('hydroxide'), methoxide: find('methoxide') };
  const dioneSkeletons = new Set(find('dione', true)), mvkSkeletons = new Set(find('methylVinylKetone', true));
  const steps = context.reactionSteps.map(step => ({ stepId: step.stepId,
    reactants: new Set(step.reactants.map(id => owners.get(id))), products: new Set(step.products.map(id => owners.get(id))) }));
  const adjacency = new Map(steps.map(step => [step.stepId, []]));
  for (const [from, to] of graph.edges) adjacency.get(from)?.push(to);
  const reaches = (from, to) => {
    const todo = [from], seen = new Set();
    while (todo.length) { const id = todo.pop(); if (id === to) return true; if (seen.has(id)) continue;
      seen.add(id); todo.push(...(adjacency.get(id) || [])); }
    return false;
  };
  const uses = (ids, side) => steps.filter(step => ids.some(id => step[side].has(id))).map(step => step.stepId);
  const dioneSteps = uses(candidates.dione, 'reactants'), mvkSteps = uses(candidates.methylVinylKetone, 'reactants');
  const michaelSteps = uses(candidates.michaelSkeleton, 'products'), targetSteps = uses(candidates.target, 'products');
  const onRoute = id => targetSteps.some(target => reaches(id, target)) && dioneSteps.some(start => reaches(start, id));
  const routeSteps = new Set(steps.filter(step => onRoute(step.stepId)).map(step => step.stepId));
  const endpoint = ep => ep?.type === 'bond' ? (() => { const bond = bonds.get(ep.bondId); return bond ? [bond.begin, bond.end] : []; })()
    : ep?.type === 'lonePair' ? [ep.ownerAtomId] : ep?.type === 'atom' ? [ep.atomId] : ep?.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
  const bonded = (a, b) => context.bonds.some(bond => bond.begin === a && bond.end === b || bond.begin === b && bond.end === a);
  const carbonyl = id => context.bonds.some(bond => (bond.begin === id && atoms.get(bond.end)?.label === 'O' ||
    bond.end === id && atoms.get(bond.begin)?.label === 'O') && (bond.order === 2 || atoms.get(id)?.charge === 1));
  const heavyNeighbors = id => context.bonds.flatMap(bond => {
    const atom = bond.begin === id ? bond.end : bond.end === id ? bond.begin : null;
    return atom && atoms.get(atom)?.label !== 'H' ? [{ atom, order: bond.order }] : [];
  });
  // The named-route witnesses must identify the reacting sites, rather than
  // accepting any unrelated C-C arrow beside an otherwise correct product.
  const michaelDonor = id => {
    const neighbors = heavyNeighbors(id);
    return dioneSkeletons.has(owners.get(id)) && neighbors.length === 3 &&
      neighbors.every(neighbor => atoms.get(neighbor.atom)?.label === 'C') &&
      neighbors.filter(neighbor => heavyNeighbors(neighbor.atom).some(other => atoms.get(other.atom)?.label === 'O')).length === 2 &&
      neighbors.some(neighbor => heavyNeighbors(neighbor.atom).length === 1);
  };
  const michaelBeta = id => {
    const neighbors = heavyNeighbors(id);
    return mvkSkeletons.has(owners.get(id)) && neighbors.length === 1 && neighbors[0].order === 2 &&
      atoms.get(neighbors[0].atom)?.label === 'C';
  };
  const heavyDistance = (from, to) => {
    const todo = [[from, 0]], seen = new Set([from]);
    for (let at = 0; at < todo.length; at++) {
      const [id, distance] = todo[at]; if (id === to) return distance;
      for (const { atom } of heavyNeighbors(id)) if (!seen.has(atom)) { seen.add(atom); todo.push([atom, distance + 1]); }
    }
    return null;
  };
  const oxygenEnolates = (moleculeId, requireNegative = true) => (context.molecules.find(molecule => molecule.id === moleculeId)?.atoms || [])
    .filter(michaelDonor).flatMap(center => heavyNeighbors(center).filter(neighbor => neighbor.order === 2)
      .flatMap(neighbor => heavyNeighbors(neighbor.atom).filter(oxygen => oxygen.order === 1 &&
        atoms.get(oxygen.atom)?.label === 'O' && (atoms.get(oxygen.atom)?.charge === -1 ||
          !requireNegative && !atoms.get(oxygen.atom)?.charge))
        .map(oxygen => ({ center, carbonylCarbon: neighbor.atom, oxygen: oxygen.atom }))));
  const enolateSites = moleculeId => (context.molecules.find(molecule => molecule.id === moleculeId)?.atoms || [])
    .filter(id => atoms.get(id)?.label === 'O' && atoms.get(id)?.charge === -1)
    .flatMap(oxygen => heavyNeighbors(oxygen).filter(neighbor => neighbor.order === 1 && atoms.get(neighbor.atom)?.label === 'C')
      .flatMap(neighbor => heavyNeighbors(neighbor.atom).filter(alpha => alpha.order === 2 && atoms.get(alpha.atom)?.label === 'C')
        .map(alpha => ({ oxygen, carbonylCarbon: neighbor.atom, alphaCarbon: alpha.atom }))));
  const flows = context.arrows.map(arrow => {
    const source = endpoint(arrow.source), target = endpoint(arrow.target), all = [...source, ...target];
    const valid = source.length > 0 && target.length > 0 && all.every(id => atoms.has(id) && owners.has(id));
    const memberSteps = valid ? steps.filter(step => all.every(id => step.reactants.has(owners.get(id)))).map(step => step.stepId) : [];
    const donors = arrow.target?.type === 'formingBond' ? source.filter(id => target.includes(id)) : source;
    const pairs = arrow.electronCount === 2 ? donors.filter(id => atoms.get(id)?.label === 'C').flatMap(from => target.filter(id => atoms.get(id)?.label === 'C' &&
      from !== id && !bonded(from, id)).map(to => {
      const intramolecular = owners.get(from) === owners.get(to), distance = intramolecular ? heavyDistance(from, to) : null;
      return { from, to, intramolecular, carbonylTarget: carbonyl(to),
        michaelSite: !intramolecular && michaelDonor(from) && michaelBeta(to),
        ringSize: distance === null ? null : distance + 1,
        aldolSite: intramolecular && carbonyl(to) && heavyNeighbors(from).length === 1 && distance === 5 };
    })) : [];
    return { arrowId: arrow.id, source, target, memberSteps, valid, onRoute: memberSteps.some(id => routeSteps.has(id)), pairs };
  });
  const michaelCC = flows.filter(flow => flow.onRoute && flow.pairs.some(pair => pair.michaelSite) &&
    flow.memberSteps.some(step => michaelSteps.some(michael => reaches(step, michael))));
  const aldolCC = flows.filter(flow => flow.onRoute && flow.pairs.some(pair => pair.aldolSite) &&
    flow.memberSteps.some(step => michaelSteps.some(michael => reaches(michael, step))));
  const pyrrolidineNitrogens = new Set(context.atoms.filter(atom => atom.label === 'N' && (() => {
    const walk = (id, visited) => {
      if (visited.length === 5) return bonded(id, atom.id);
      return context.bonds.some(bond => {
        if (bond.order !== 1 || bond.begin !== id && bond.end !== id) return false;
        const next = bond.begin === id ? bond.end : bond.begin;
        return !visited.includes(next) && atoms.get(next)?.label === 'C' && walk(next, [...visited, next]);
      });
    };
    return walk(atom.id, [atom.id]);
  })()).map(atom => atom.id));
  const catalyst = (ids, element, releasedIds = ids) => {
    const usedSteps = uses(ids, 'reactants').filter(id => routeSteps.has(id)), regeneratedSteps = uses(releasedIds, 'products').filter(id => routeSteps.has(id));
    const flowIds = flows.filter(flow => flow.onRoute && [...flow.source, ...flow.target].some(id => atoms.get(id)?.label === element &&
      (element === 'N' ? pyrrolidineNitrogens.has(id) : ids.includes(owners.get(id))))).map(flow => flow.arrowId);
    return { moleculeIds: ids, releasedMoleculeIds: releasedIds, usedSteps, regeneratedSteps, flowIds,
      pass: usedSteps.some(used => regeneratedSteps.some(regenerated => reaches(used, regenerated))) && flowIds.length > 0 };
  };
  const base = catalyst([...candidates.hydroxide, ...candidates.methoxide], 'O');
  const amine = catalyst(candidates.pyrrolidine, 'N', [...candidates.pyrrolidine, ...candidates.pyrrolidinium]);
  const stagesConnected = targetSteps.some(target => dioneSteps.some(start => reaches(start, target)) && mvkSteps.some(start => reaches(start, target)) &&
    michaelSteps.some(michael => reaches(michael, target) && dioneSteps.some(start => reaches(start, michael)) && mvkSteps.some(start => reaches(start, michael))));
  const flowCoverage = context.reactionSteps.map(step => {
    const actual = flows.filter(flow => flow.memberSteps.includes(step.stepId)).map(flow => flow.arrowId);
    const checked = step.checks?.layout?.checkedArrowIds || [];
    return { stepId: step.stepId, actualArrowIds: actual, checkedArrowIds: checked, pass: actual.length > 0 && actual.every(id => checked.includes(id)) };
  });
  const electronChanges = [], mechanisticNotes = [];
  const flowsForStep = step => context.arrows.filter(arrow => arrow.electronCount === 2 &&
    [...endpoint(arrow.source), ...endpoint(arrow.target)].every(id => step.reactants.has(owners.get(id))));
  for (const step of steps) {
    const reactantDiones = [...step.reactants].filter(id => dioneSkeletons.has(id));
    if (!reactantDiones.length || reactantDiones.some(id => oxygenEnolates(id, false).length) ||
        ![...step.products].some(id => oxygenEnolates(id).length)) continue;
    const stepFlows = flowsForStep(step);
    const centers = reactantDiones.flatMap(id => context.molecules.find(molecule => molecule.id === id)?.atoms || []).filter(michaelDonor);
    const validShift = centers.some(center => heavyNeighbors(center).some(({ atom: carbonylCarbon }) => {
      const carbonylBond = context.bonds.find(bond => bond.order === 2 &&
        (bond.begin === carbonylCarbon && atoms.get(bond.end)?.label === 'O' ||
          bond.end === carbonylCarbon && atoms.get(bond.begin)?.label === 'O'));
      if (!carbonylBond) return false;
      const oxygen = carbonylBond.begin === carbonylCarbon ? carbonylBond.end : carbonylBond.begin;
      const release = stepFlows.some(arrow => arrow.source.type === 'bond' && arrow.source.bondId === carbonylBond.id &&
        arrow.source.component === 'pi' && arrow.target.type === 'atom' && arrow.target.atomId === oxygen);
      const gain = stepFlows.some(arrow => {
        const donors = endpoint(arrow.source);
        if (!donors.includes(center)) return false;
        if (arrow.source.type === 'bond' && !donors.some(atom => atoms.get(atom)?.label === 'H')) return false;
        return arrow.target.type === 'formingBond' &&
          new Set([arrow.target.atomA, arrow.target.atomB]).size === 2 &&
          [arrow.target.atomA, arrow.target.atomB].includes(center) && [arrow.target.atomA, arrow.target.atomB].includes(carbonylCarbon) ||
          arrow.target.type === 'atom' && arrow.target.atomId === carbonylCarbon;
      });
      return release && gain;
    }));
    electronChanges.push({ stepId: step.stepId, kind: 'dione_oxygen_enolate_formation', status: validShift ? 'passed' : 'failed',
      issues: validShift ? [] : [{ code: 'enolate_pi_redistribution_missing',
        message: 'The drawn O-enolate requires alpha-C to carbonyl-C bond-order gain and carbonyl pi-electron release to O; C-H cleavage to the alpha carbon alone depicts the C-carbanion resonance form.' }] });
  }
  const ketoFamilies = [{ skeletons: dioneSkeletons, neutral: new Set(candidates.dione) },
    { skeletons: new Set(candidates.michaelSkeleton), neutral: new Set(find('michaelTrione')) }];
  for (const step of steps) {
    const sites = ketoFamilies.flatMap(family => [...step.products].some(id => family.neutral.has(id))
      ? [...step.reactants].filter(id => family.skeletons.has(id)).flatMap(enolateSites) : []);
    if (!sites.length) continue;
    const stepFlows = flowsForStep(step);
    const restored = sites.some(site => {
      const carbonylGain = stepFlows.some(arrow => endpoint(arrow.source).includes(site.oxygen) &&
        (arrow.source.type === 'atom' || arrow.source.type === 'lonePair') &&
        (arrow.target.type === 'atom' && arrow.target.atomId === site.carbonylCarbon ||
          arrow.target.type === 'formingBond' && [arrow.target.atomA, arrow.target.atomB].includes(site.oxygen) &&
            [arrow.target.atomA, arrow.target.atomB].includes(site.carbonylCarbon)));
      const carbonProtonation = stepFlows.some(arrow => {
        if (arrow.source.type !== 'bond' || arrow.source.component !== 'pi') return false;
        const bond = bonds.get(arrow.source.bondId);
        if (!bond || ![bond.begin, bond.end].includes(site.alphaCarbon) || ![bond.begin, bond.end].includes(site.carbonylCarbon)) return false;
        return arrow.target.type === 'atom' && atoms.get(arrow.target.atomId)?.label === 'H' ||
          arrow.target.type === 'formingBond' && [arrow.target.atomA, arrow.target.atomB].includes(site.alphaCarbon) &&
            [arrow.target.atomA, arrow.target.atomB].some(id => atoms.get(id)?.label === 'H');
      });
      return carbonylGain && carbonProtonation;
    });
    electronChanges.push({ stepId: step.stepId, kind: 'oxygen_enolate_to_ketone', status: restored ? 'passed' : 'failed',
      issues: restored ? [] : [{ code: 'enolate_ketone_electron_changes_missing',
        message: 'The drawn ketone requires carbonyl bond restoration and carbon protonation; O-enolate protonation at oxygen alone gives the enol instead.' }] });
  }
  // Flag an ion-pair interpretation for manual review, never reject it solely
  // because OH- is drawn. Primary calculations support short-lived iminium/
  // hydroxide pairs followed by deprotonation without an external acid (Ma et
  // al., 2016, DOI 10.1002/chem.201603839). That different substrate/solvent does
  // not establish the microscopic Robinson mechanism or free dissociated ions.
  for (const step of steps) {
    if (![...step.products].some(id => candidates.hydroxide.includes(id))) continue;
    if (![...step.products].some(id => (context.molecules.find(molecule => molecule.id === id)?.atoms || []).some(atom =>
      atoms.get(atom)?.label === 'N' && atoms.get(atom)?.charge === 1 && heavyNeighbors(atom).some(item =>
        item.order === 2 && atoms.get(item.atom)?.label === 'C')))) continue;
    const stepFlows = flowsForStep(step);
    const departures = stepFlows.flatMap(arrow => {
      if (arrow.source.type !== 'bond' || arrow.source.component !== 'sigma' || arrow.target.type !== 'atom') return [];
      const bond = bonds.get(arrow.source.bondId), oxygen = arrow.target.atomId;
      if (!bond || ![bond.begin, bond.end].includes(oxygen) || atoms.get(oxygen)?.label !== 'O' || atoms.get(oxygen)?.charge) return [];
      const carbon = bond.begin === oxygen ? bond.end : bond.begin;
      const hCount = Number(atoms.get(oxygen)?.implicitH || 0) + context.bonds.filter(item =>
        item.begin === oxygen && atoms.get(item.end)?.label === 'H' || item.end === oxygen && atoms.get(item.begin)?.label === 'H').length;
      if (atoms.get(carbon)?.label !== 'C' || hCount !== 1 || heavyNeighbors(oxygen).length !== 1) return [];
      const nitrogen = heavyNeighbors(carbon).find(item => item.order === 1 && atoms.get(item.atom)?.label === 'N' && !atoms.get(item.atom)?.charge)?.atom;
      if (!nitrogen || !stepFlows.some(flow => endpoint(flow.source).includes(nitrogen) &&
          ['atom', 'lonePair'].includes(flow.source.type) &&
          (flow.target.type === 'atom' && flow.target.atomId === carbon || flow.target.type === 'formingBond' &&
            [flow.target.atomA, flow.target.atomB].includes(carbon) && [flow.target.atomA, flow.target.atomB].includes(nitrogen)))) return [];
      const protonRelay = stepFlows.some(flow => endpoint(flow.source).includes(oxygen) &&
        (flow.target.type === 'atom' && atoms.get(flow.target.atomId)?.label === 'H' ||
          flow.target.type === 'formingBond' && [flow.target.atomA, flow.target.atomB].includes(oxygen) &&
            [flow.target.atomA, flow.target.atomB].some(id => atoms.get(id)?.label === 'H')));
      return protonRelay ? [] : [{ arrowId: arrow.id, oxygen, carbon, nitrogen }];
    });
    if (departures.length) mechanisticNotes.push({ stepId: step.stepId, kind: 'carbinolamine_dehydration', status: 'review', departures,
      issues: [{ code: 'carbinolamine_iminium_hydroxide_interpretation',
        message: 'This formal iminium/hydroxide stage may represent a short-lived tight ion pair followed by proton abstraction. The drawing alone does not establish independently solvated ions or the exact microscopic dehydration pathway; an external acid is not required by this audit.' }],
      sources: ['https://doi.org/10.1002/chem.201603839', 'https://doi.org/10.1021/acscatal.4c00937'] });
  }
  for (const step of steps) {
    if (![...step.products].some(id => candidates.pyrrolidine.includes(id))) continue;
    const stepFlows = flowsForStep(step), gaps = [];
    for (const release of stepFlows) {
      if (release.source.type !== 'bond' || release.source.component !== 'sigma' || release.target.type !== 'atom') continue;
      const cn = bonds.get(release.source.bondId), nitrogen = release.target.atomId, n = atoms.get(nitrogen);
      if (!cn || ![cn.begin, cn.end].includes(nitrogen) || n?.label !== 'N' || n.charge ||
          !pyrrolidineNitrogens.has(nitrogen) || Number(n.implicitH) || heavyNeighbors(nitrogen).length !== 3 ||
          context.bonds.some(bond => bond.begin === nitrogen && atoms.get(bond.end)?.label === 'H' ||
            bond.end === nitrogen && atoms.get(bond.begin)?.label === 'H')) continue;
      const carbon = cn.begin === nitrogen ? cn.end : cn.begin;
      const gains = stepFlows.filter(flow => ['atom', 'lonePair'].includes(flow.source.type) && endpoint(flow.source).some(id => {
        if (atoms.get(id)?.label !== 'O' || atoms.get(id)?.charge || !bonded(id, carbon)) return false;
        const hCount = Number(atoms.get(id)?.implicitH || 0) + context.bonds.filter(bond =>
          bond.begin === id && atoms.get(bond.end)?.label === 'H' || bond.end === id && atoms.get(bond.begin)?.label === 'H').length;
        return hCount === 1;
      }) && (flow.target.type === 'atom' && flow.target.atomId === carbon || flow.target.type === 'formingBond' &&
        [flow.target.atomA, flow.target.atomB].includes(carbon) && endpoint(flow.source).some(id => [flow.target.atomA, flow.target.atomB].includes(id))));
      for (const gain of gains) {
        const oxygen = endpoint(gain.source)[0];
        const ohRelease = stepFlows.some(flow => {
          const bond = flow.source.type === 'bond' && bonds.get(flow.source.bondId);
          return bond && flow.source.component === 'sigma' && [bond.begin, bond.end].includes(oxygen) &&
            [bond.begin, bond.end].some(id => atoms.get(id)?.label === 'H') && flow.target.type === 'atom' && flow.target.atomId === oxygen;
        });
        const nhGain = stepFlows.some(flow => endpoint(flow.source).includes(nitrogen) && ['atom', 'lonePair'].includes(flow.source.type) &&
          (flow.target.type === 'atom' && atoms.get(flow.target.atomId)?.label === 'H' || flow.target.type === 'formingBond' &&
            [flow.target.atomA, flow.target.atomB].includes(nitrogen) && [flow.target.atomA, flow.target.atomB].some(id => atoms.get(id)?.label === 'H')));
        if (!ohRelease || !nhGain) gaps.push({ oxygen, nitrogen, carbon, carbonylGainArrowId: gain.id, cnReleaseArrowId: release.id,
          observedOHRelease: ohRelease, observedNHGain: nhGain });
      }
    }
    if (gaps.length) mechanisticNotes.push({ stepId: step.stepId, kind: 'carbinolamine_hydrolysis_proton_account', status: 'needs_evidence', gaps,
      issues: [{ code: 'hydrolysis_proton_transfer_evidence_missing',
        message: 'The reactant has neutral C–OH and tertiary N without H, while a neutral ketone and NH pyrrolidine are drawn. Carbonyl formation and C–N cleavage alone do not account for that proton transfer. Review supporting O–H cleavage/N–H formation, a water/amine relay, or an explicitly justified coupled depiction; total H conservation is insufficient.' }] });
  }
  const checks = [
    { name: 'both exact starting structures participate', pass: dioneSteps.length > 0 && mvkSteps.length > 0 },
    { name: 'correct neutral C11H14O2 six/six Wieland–Miescher enedione is a product', pass: candidates.target.length > 0 && targetSteps.length > 0 },
    { name: 'both inputs reach the target through the Michael carbon skeleton', pass: stagesConnected },
    { name: 'the target mainline contains dione active-carbon attack on the MVK beta carbon', pass: michaelCC.length > 0 },
    { name: 'the target mainline contains terminal-carbon attack on a carbonyl closing a six-membered ring', pass: aldolCC.length > 0 },
    { name: 'the KOH/MeOH oxygen base participates and is regenerated on the mainline', pass: base.pass },
    { name: 'pyrrolidine participates and is regenerated on the mainline', pass: amine.pass },
    { name: 'each step layout check actually covers its real flows including bond sources', pass: flowCoverage.length > 0 && flowCoverage.every(item => item.pass) },
    { name: 'drawn enolate and ketone stages include their carbon and oxygen bond-order electron changes', pass: electronChanges.every(item => item.status === 'passed') },
  ];
  return { pass: checks.every(check => check.pass), checks, candidates, stagesConnected, routeSteps: [...routeSteps],
    michaelCC, aldolCC, catalysts: { oxygenBase: base, pyrrolidine: amine }, flowCoverage, electronChanges, mechanisticNotes,
    requiresManualReview: mechanisticNotes.some(note => note.status === 'needs_evidence'),
    boundary: 'These structural/site/ring-closure witnesses are inferred acceptance criteria, not a complete atom mapping or proof of every elementary arrow. Stepwise product bond changes and the remaining electron flows still require independent review. Step count, proton-transfer grouping and product enantiomer are not fixed.',
    sources: reference.sources };
}

module.exports = { ROBINSON_CASE, moleculeGraphs, matchesGraph, inspectRobinson };
