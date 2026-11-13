'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { ROBINSON_CASE, moleculeGraphs, matchesGraph, inspectRobinson } = require('./agent_robinson_audit.cjs');
const refs = ROBINSON_CASE.references;

// Synthetic structural/route witnesses, not a proposed elementary mechanism.
// Generic runtime chemistry and actual editor geometry are tested separately.
function fixture(target = 'wielandMiescher', releasedAmine = 'pyrrolidine', oxygenBase = 'hydroxide') {
  const context = { atoms: [], bonds: [], molecules: [], arrows: [], reactionSteps: [] };
  const add = (name, prefix) => {
    const ref = refs[name], ids = ref.atoms.map((atom, i) => prefix + ':' + i);
    context.atoms.push(...ref.atoms.map((atom, i) => ({ id: ids[i], label: atom.label, charge: atom.charge, radical: 0, implicitH: atom.hydrogens })));
    context.bonds.push(...ref.bonds.map((bond, i) => ({ id: prefix + ':bond' + i, begin: ids[bond.begin], end: ids[bond.end], order: bond.order })));
    context.molecules.push({ id: prefix, atoms: ids }); return ids;
  };
  const d = add('dione', 'd'), v = add('methylVinylKetone', 'v'), tri = add('michaelTrione', 'tri');
  const pyr = add('pyrrolidine', 'pyr'), en = add('enamineFixture', 'en'), ald = add('aldolKetol', 'ald');
  const base = add(oxygenBase, 'base'), regeneratedBase = add(oxygenBase, 'base-out');
  const regeneratedAmine = add(releasedAmine, 'pyr-out'), wm = add(target, 'wm');
  const proton = 'd:explicit-H'; context.atoms.find(atom => atom.id === d[1]).implicitH--;
  context.atoms.push({ id: proton, label: 'H', charge: 0, radical: 0, implicitH: 0 }); context.molecules[0].atoms.push(proton);
  context.bonds.push({ id: 'd:C-H', begin: d[1], end: proton, order: 1 });
  const flow = (id, source, target) => { context.arrows.push({ id, source, target, electronCount: 2 }); return id; };
  const baseOxygen = base.find(id => context.atoms.find(atom => atom.id === id).label === 'O');
  const carbonyl = prefix => context.bonds.find(bond => bond.begin.startsWith(prefix + ':') && bond.order === 2 &&
    context.atoms.find(atom => atom.id === bond.end)?.label === 'O').begin;
  const n = pyr.find(id => context.atoms.find(atom => atom.id === id).label === 'N');
  const loss = context.bonds.find(bond => bond.begin.startsWith('ald:') && bond.order === 1 &&
    context.atoms.find(atom => atom.id === bond.end)?.label === 'O');
  const addStep = (id, reactants, products, checkedArrowIds) => context.reactionSteps.push({ stepId: id, reactants, products,
    checks: { layout: { status: 'passed', issues: [], checkedArrowIds } } });
  addStep('michael', [d[0], v[0], base[0]], [tri[0], regeneratedBase[0]], [
    flow('base-transfer', { type: 'lonePair', ownerAtomId: baseOxygen }, { type: 'atom', atomId: proton }),
    flow('C-H-release', { type: 'bond', bondId: 'd:C-H' }, { type: 'atom', atomId: d[1] }),
    flow('michael-CC', { type: 'atom', atomId: d[1] }, { type: 'atom', atomId: v[0] }),
  ]);
  addStep('amine', [tri[0], pyr[0]], [en[0]], [flow('amine-participation', { type: 'lonePair', ownerAtomId: n }, { type: 'atom', atomId: carbonyl('tri') })]);
  addStep('aldol', [en[0]], [ald[0], regeneratedAmine[0]], [flow('aldol-CC', { type: 'atom', atomId: en[0] }, { type: 'atom', atomId: carbonyl('en') })]);
  addStep('dehydration', [ald[0]], [wm[0]], [flow('oxygen-release', { type: 'bond', bondId: loss.id }, { type: 'atom', atomId: loss.end })]);
  return { context, graph: { edges: [['michael', 'amine'], ['amine', 'aldol'], ['aldol', 'dehydration']] } };
}

function appendDioneAnion(context, oxygenForm = true) {
  const ref = refs.dione, ids = ref.atoms.map((_, i) => 'deprotonated:' + i);
  context.atoms.push(...ref.atoms.map((atom, i) => ({ id: ids[i], label: atom.label,
    charge: oxygenForm && i === 3 || !oxygenForm && i === 1 ? -1 : atom.charge,
    radical: 0, implicitH: i === 1 ? 0 : atom.hydrogens })));
  context.bonds.push(...ref.bonds.map((bond, i) => ({ id: 'deprotonated:bond' + i, begin: ids[bond.begin], end: ids[bond.end],
    order: oxygenForm && bond.begin === 1 && bond.end === 2 ? 2 : oxygenForm && bond.begin === 2 && bond.end === 3 ? 1 : bond.order })));
  context.molecules.push({ id: 'deprotonated', atoms: ids });
  context.reactionSteps.push({ stepId: 'deprotonation', reactants: ['d:0', 'base:0'], products: [ids[0]],
    checks: { layout: { status: 'passed', checkedArrowIds: ['base-transfer', 'C-H-release'] } } });
}

test('the correct six/six reference and connected catalytic witnesses pass without a fixed count', () => {
  const { context, graph } = fixture(), result = inspectRobinson(context, graph);
  assert.equal(result.pass, true); assert.deepEqual(refs.wielandMiescher.rings, [6, 6]);
  assert.equal(refs.wielandMiescher.formula, 'C11H14O2'); assert.equal(result.michaelCC.length, 1); assert.equal(result.aldolCC.length, 1);
  assert.equal(inspectRobinson(context, { ...graph, stepCount: 100, longestPath: 100 }).pass, true);
});

test('the five/six Hajos–Parrish analogue cannot satisfy the Wieland–Miescher target', () => {
  const { context, graph } = fixture('hajosParrishNegative'), result = inspectRobinson(context, graph);
  assert.equal(result.pass, false); assert.deepEqual(result.candidates.target, []); assert.deepEqual(result.candidates.wrongFiveSixRing, ['wm']);
});

test('a same-formula C11H14O2 five/seven isomer also fails the exact six/six target', () => {
  const { context, graph } = fixture('sameFormulaFiveSevenNegative');
  assert.equal(refs.sameFormulaFiveSevenNegative.formula, refs.wielandMiescher.formula);
  assert.deepEqual(refs.sameFormulaFiveSevenNegative.rings, [5, 7]);
  assert.deepEqual(inspectRobinson(context, graph).candidates.target, []);
});

test('reference matching is independent of native atom and bond enumeration', () => {
  const { context, graph } = fixture(); context.atoms.reverse(); context.bonds.reverse();
  context.molecules.forEach(molecule => molecule.atoms.reverse());
  assert.equal(inspectRobinson(context, graph).pass, true);
});

test('explicit and implicit H representations match while charged or wrong-bond-order final targets do not', () => {
  const { context } = fixture(), structures = moleculeGraphs(context);
  assert.equal(matchesGraph(structures.find(item => item.moleculeId === 'd'), refs.dione), true);
  const target = structures.find(item => item.moleculeId === 'wm');
  assert.equal(matchesGraph(target, refs.wielandMiescher), true);
  target.atoms[0].charge = 1; assert.equal(matchesGraph(target, refs.wielandMiescher), false);
  target.atoms[0].charge = 0; target.bonds.find(bond => bond.order === 2).order = 1;
  assert.equal(matchesGraph(target, refs.wielandMiescher), false);
});

test('Michael carbon-skeleton detection permits resonance changes only for that intermediate', () => {
  const { context, graph } = fixture();
  const bond = context.bonds.find(bond => bond.id.startsWith('tri:') && bond.order === 2); bond.order = 1;
  context.atoms.find(atom => atom.id === bond.end).charge = -1;
  assert.deepEqual(inspectRobinson(context, graph).candidates.michaelSkeleton, ['tri']);
});

test('correct structures sitting off a disconnected target mainline cannot pass', () => {
  const { context, graph } = fixture(); graph.edges = graph.edges.filter(([from]) => from !== 'amine');
  const result = inspectRobinson(context, graph); assert.equal(result.pass, false); assert.equal(result.stagesConnected, false);
});

test('intermolecular Michael and intramolecular carbonyl C–C flow are distinct required witnesses', () => {
  for (const id of ['michael-CC', 'aldol-CC']) {
    const { context, graph } = fixture(), arrow = context.arrows.find(arrow => arrow.id === id);
    arrow.target = { ...arrow.source };
    assert.equal(inspectRobinson(context, graph).pass, false);
  }
});

test('correct isolated products cannot disguise Michael attack at the wrong substrate or MVK site', () => {
  for (const change of [
    arrow => { arrow.target.atomId = 'v:1'; }, // MVK alpha carbon, rather than terminal beta carbon.
    arrow => { arrow.source.atomId = 'd:0'; }, // The ring methyl, rather than the active dione centre.
    arrow => { arrow.source.atomId = 'v:0'; arrow.target.atomId = 'd:1'; },
    arrow => { arrow.electronCount = 1; },
  ]) {
    const { context, graph } = fixture(); change(context.arrows.find(arrow => arrow.id === 'michael-CC'));
    const result = inspectRobinson(context, graph);
    assert.equal(result.pass, false);
    assert.equal(result.michaelCC.length, 0);
    assert.deepEqual(result.candidates.target, ['wm'], 'the exact product alone is insufficient');
  }
});

test('the aldol witness must close the six-membered ring from the terminal donor carbon', () => {
  const { context, graph } = fixture();
  context.arrows.find(arrow => arrow.id === 'aldol-CC').source.atomId = 'en:1';
  const result = inspectRobinson(context, graph);
  assert.equal(result.pass, false);
  assert.equal(result.aldolCC.length, 0, 'the other enamine carbon would close a five-membered ring');
  const correct = fixture(), arrow = correct.context.arrows.find(arrow => arrow.id === 'aldol-CC');
  arrow.source = { type: 'bond', bondId: 'en:bond0', component: 'pi' };
  arrow.target = { type: 'formingBond', atomA: 'en:0', atomB: arrow.target.atomId };
  const accepted = inspectRobinson(correct.context, correct.graph);
  assert.equal(accepted.pass, true);
  assert.ok(accepted.aldolCC[0].pairs.some(pair => pair.aldolSite && pair.ringSize === 6));
  arrow.target.atomA = 'en:7';
  assert.equal(inspectRobinson(correct.context, correct.graph).pass, false,
    'a forming-bond endpoint must actually include a donor from the source bond');
});

test('a drawn O-enolate cannot be justified by C-H cleavage to carbon alone', () => {
  const { context, graph } = fixture(); appendDioneAnion(context);
  const missing = inspectRobinson(context, graph).electronChanges;
  assert.equal(missing.length, 1);
  assert.equal(missing[0].stepId, 'deprotonation');
  assert.equal(missing[0].status, 'failed');
  assert.equal(missing[0].issues[0].code, 'enolate_pi_redistribution_missing');
  const carbonyl = context.bonds.find(bond => bond.begin === 'd:2' && bond.end === 'd:3');
  context.arrows.find(arrow => arrow.id === 'C-H-release').target = { type: 'formingBond', atomA: 'd:1', atomB: 'd:2' };
  context.arrows.push({ id: 'enolate-oxygen-release', electronCount: 2,
    source: { type: 'bond', bondId: carbonyl.id, component: 'pi' }, target: { type: 'atom', atomId: 'd:3' } });
  assert.equal(inspectRobinson(context, graph).electronChanges[0].status, 'passed');
});

test('the C-carbanion resonance form does not require an oxygen pi shift until that form is drawn', () => {
  const { context, graph } = fixture(); appendDioneAnion(context, false);
  assert.deepEqual(inspectRobinson(context, graph).electronChanges, []);
});

test('protonating the Michael O-enolate at oxygen cannot directly justify a drawn ketone', () => {
  const { context, graph } = fixture(), ref = refs.michaelTrione, ids = ref.atoms.map((_, i) => 'trione-enolate:' + i);
  context.atoms.push(...ref.atoms.map((atom, i) => ({ id: ids[i], label: atom.label,
    charge: i === 6 ? -1 : atom.charge, radical: 0, implicitH: i === 5 ? 2 : atom.hydrogens })));
  context.bonds.push(...ref.bonds.map((bond, i) => ({ id: 'trione-enolate:bond' + i, begin: ids[bond.begin], end: ids[bond.end],
    order: bond.begin === 4 && bond.end === 5 ? 2 : bond.begin === 4 && bond.end === 6 ? 1 : bond.order })));
  context.molecules.push({ id: 'trione-enolate', atoms: ids });
  context.atoms.push({ id: 'water:O', label: 'O', charge: 0, implicitH: 1 }, { id: 'water:H', label: 'H', charge: 0, implicitH: 0 });
  context.bonds.push({ id: 'water:OH', begin: 'water:O', end: 'water:H', order: 1 });
  context.molecules.push({ id: 'water', atoms: ['water:O', 'water:H'] });
  context.reactionSteps.push({ stepId: 'enolate-quench', reactants: [ids[0], 'water:O'], products: ['tri:0', 'base-out:0'] });
  const protonation = { id: 'enolate-protonation', electronCount: 2,
    source: { type: 'lonePair', ownerAtomId: ids[6] }, target: { type: 'atom', atomId: 'water:H' } };
  context.arrows.push(protonation, { id: 'water-release', electronCount: 2,
    source: { type: 'bond', bondId: 'water:OH', component: 'sigma' }, target: { type: 'atom', atomId: 'water:O' } });
  const changes = inspectRobinson(context, graph).electronChanges;
  assert.equal(changes[0].kind, 'oxygen_enolate_to_ketone');
  assert.equal(changes[0].status, 'failed');
  protonation.source = { type: 'bond', bondId: 'trione-enolate:bond4', component: 'pi' };
  protonation.target = { type: 'formingBond', atomA: ids[5], atomB: 'water:H' };
  context.arrows.push({ id: 'carbonyl-restore', electronCount: 2,
    source: { type: 'lonePair', ownerAtomId: ids[6] }, target: { type: 'atom', atomId: ids[4] } });
  assert.equal(inspectRobinson(context, graph).electronChanges[0].status, 'passed');
});

test('an unused free catalyst or missing regeneration cannot masquerade as a catalytic cycle', () => {
  const { context, graph } = fixture(); context.reactionSteps.find(step => step.stepId === 'aldol').products = ['ald:0'];
  const result = inspectRobinson(context, graph); assert.equal(result.pass, false); assert.equal(result.catalysts.pyrrolidine.pass, false);
});

test('methoxide in methanol and free pyrrolidinium after acid workup remain valid catalyst states', () => {
  const { context, graph } = fixture('wielandMiescher', 'pyrrolidinium', 'methoxide');
  const result = inspectRobinson(context, graph); assert.equal(result.pass, true);
  assert.deepEqual(result.candidates.methoxide, ['base', 'base-out']);
  assert.deepEqual(result.candidates.pyrrolidinium, ['pyr-out']);
});

test('bond-source flows require actual checkedArrowIds coverage and stereoselection is not prescribed', () => {
  const { context, graph } = fixture();
  context.atoms.filter(atom => atom.id.startsWith('wm:')).forEach(atom => { atom.stereoLabel = 'R'; });
  assert.equal(inspectRobinson(context, graph).pass, true);
  context.reactionSteps.find(step => step.stepId === 'dehydration').checks.layout.checkedArrowIds = [];
  const result = inspectRobinson(context, graph); assert.equal(result.pass, false);
  assert.deepEqual(result.flowCoverage.find(item => !item.pass).actualArrowIds, ['oxygen-release']);
});

test('an already drawn neutral enol can be deprotonated to its O-enolate without a new pi shift', () => {
  const { context, graph } = fixture(); appendDioneAnion(context);
  context.atoms.find(atom => atom.id === 'd:1').implicitH = 0;
  context.atoms.find(atom => atom.id === 'd:3').implicitH = 1;
  context.bonds.find(bond => bond.begin === 'd:1' && bond.end === 'd:2').order = 2;
  context.bonds.find(bond => bond.begin === 'd:2' && bond.end === 'd:3').order = 1;
  context.bonds = context.bonds.filter(bond => bond.id !== 'd:C-H');
  assert.deepEqual(inspectRobinson(context, graph).electronChanges, []);
});

test('neutral carbinolamine iminium/hydroxide depiction is reviewed without being categorically rejected', () => {
  // Local topology from the real Robinson phase-04 review, with fresh generic
  // IDs and no provider text or saved full-document snapshot.
  const context = { atoms: [
    { id: 'c', label: 'C', charge: 0, implicitH: 0 }, { id: 'n', label: 'N', charge: 0, implicitH: 0 },
    { id: 'o', label: 'O', charge: 0, implicitH: 1 }, { id: 'iC', label: 'C', charge: 0, implicitH: 0 },
    { id: 'iN', label: 'N', charge: 1, implicitH: 0 }, { id: 'outO', label: 'O', charge: -1, implicitH: 1 },
  ], bonds: [ { id: 'cn', begin: 'c', end: 'n', order: 1 }, { id: 'co', begin: 'c', end: 'o', order: 1 },
    { id: 'iminium', begin: 'iC', end: 'iN', order: 2 } ],
    molecules: [{ id: 'carbinolamine', atoms: ['c', 'n', 'o'] }, { id: 'iminium', atoms: ['iC', 'iN'] }, { id: 'hydroxide', atoms: ['outO'] }],
    arrows: [{ id: 'gain', electronCount: 2, source: { type: 'lonePair', ownerAtomId: 'n' }, target: { type: 'atom', atomId: 'c' } },
      { id: 'loss', electronCount: 2, source: { type: 'bond', bondId: 'co', component: 'sigma' }, target: { type: 'atom', atomId: 'o' } }],
    reactionSteps: [{ stepId: 'dehydrate', reactants: ['c'], products: ['iC', 'outO'] }] };
  const changes = () => inspectRobinson(context, { edges: [] }).mechanisticNotes;
  assert.equal(changes()[0].issues[0].code, 'carbinolamine_iminium_hydroxide_interpretation');
  assert.deepEqual(changes()[0].departures.map(item => item.arrowId), ['loss']);
  assert.deepEqual(inspectRobinson(context, { edges: [] }).electronChanges, [], 'primary ion-pair precedents preclude an absolute rejection');
  context.arrows[0].target = { type: 'formingBond', atomA: 'n', atomB: 'c' };
  assert.equal(changes()[0].status, 'review', 'N–C bond-order gain may use either supported endpoint representation');
  context.atoms.find(atom => atom.id === 'o').charge = 1;
  context.atoms.find(atom => atom.id === 'o').implicitH = 2;
  context.atoms.find(atom => atom.id === 'outO').charge = 0;
  context.atoms.find(atom => atom.id === 'outO').implicitH = 2;
  assert.deepEqual(changes(), [], 'a water leaving group is not the hydroxide interpretation note');
  context.atoms.find(atom => atom.id === 'o').charge = 0;
  context.atoms.find(atom => atom.id === 'o').implicitH = 1;
  context.atoms.find(atom => atom.id === 'outO').charge = -1;
  context.atoms.find(atom => atom.id === 'outO').implicitH = 1;
  context.atoms.push({ id: 'proton', label: 'H', charge: 0, implicitH: 0 });
  context.molecules[0].atoms.push('proton');
  context.arrows.push({ id: 'relay', electronCount: 2, source: { type: 'lonePair', ownerAtomId: 'o' }, target: { type: 'atom', atomId: 'proton' } });
  assert.deepEqual(changes(), [], 'a grouped proton relay is not rejected by this narrow negative witness');
});

test('neutral ketone and NH pyrrolidine release cannot silently hide the OH-to-N proton account', () => {
  const { context, graph } = fixture();
  const atoms = [{ id: 'hyd:c', label: 'C', charge: 0, implicitH: 0 }, { id: 'hyd:o', label: 'O', charge: 0, implicitH: 1 },
    ...refs.pyrrolidine.atoms.map((atom, i) => ({ id: 'hyd:p' + i, label: atom.label, charge: 0,
      implicitH: atom.label === 'N' ? 0 : atom.hydrogens }))];
  const nitrogen = atoms.find(atom => atom.label === 'N').id;
  context.atoms.push(...atoms);
  context.molecules.push({ id: 'hyd', atoms: atoms.map(atom => atom.id) });
  context.bonds.push(...refs.pyrrolidine.bonds.map((bond, i) => ({ id: 'hyd:ring' + i,
    begin: 'hyd:p' + bond.begin, end: 'hyd:p' + bond.end, order: bond.order })),
    { id: 'hyd:CO', begin: 'hyd:c', end: 'hyd:o', order: 1 }, { id: 'hyd:CN', begin: 'hyd:c', end: nitrogen, order: 1 });
  context.reactionSteps.push({ stepId: 'hydrolysis-release', reactants: ['hyd:c'], products: ['ald:0', 'pyr-out:0'] });
  context.arrows.push({ id: 'hyd:carbonyl', electronCount: 2, source: { type: 'lonePair', ownerAtomId: 'hyd:o' }, target: { type: 'atom', atomId: 'hyd:c' } },
    { id: 'hyd:release', electronCount: 2, source: { type: 'bond', bondId: 'hyd:CN', component: 'sigma' }, target: { type: 'atom', atomId: nitrogen } });
  const notes = () => inspectRobinson(context, graph).mechanisticNotes.filter(note => note.kind === 'carbinolamine_hydrolysis_proton_account');
  assert.equal(notes()[0].issues[0].code, 'hydrolysis_proton_transfer_evidence_missing');
  assert.equal(notes()[0].status, 'needs_evidence');
  assert.equal(inspectRobinson(context, graph).requiresManualReview, true);
  assert.equal(notes()[0].gaps[0].cnReleaseArrowId, 'hyd:release');
  context.atoms.find(atom => atom.id === 'hyd:o').implicitH = 0;
  context.atoms.push({ id: 'hyd:H', label: 'H', charge: 0, implicitH: 0 }); context.molecules.at(-1).atoms.push('hyd:H');
  context.bonds.push({ id: 'hyd:OH', begin: 'hyd:o', end: 'hyd:H', order: 1 });
  context.arrows.push({ id: 'hyd:N-H-gain', electronCount: 2, source: { type: 'lonePair', ownerAtomId: nitrogen }, target: { type: 'atom', atomId: 'hyd:H' } });
  assert.equal(notes()[0].gaps[0].observedNHGain, true);
  assert.equal(notes()[0].gaps[0].observedOHRelease, false);
  context.arrows.push({ id: 'hyd:O-H-release', electronCount: 2, source: { type: 'bond', bondId: 'hyd:OH', component: 'sigma' }, target: { type: 'atom', atomId: 'hyd:o' } });
  assert.deepEqual(notes(), [], 'the complete coupled proton account is permitted without an extra acid or fixed step count');
  assert.equal(inspectRobinson(context, graph).requiresManualReview, false);
});
