'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOperations } = require('../workbench/agent-bridge.js');
const { longDag23, forkJoin } = require('./fixtures/reaction_step_dag_23.cjs');
const { canonical, inspectGraph } = require('./agent_long_route_audit.cjs');

// This is a manifest/reference check, not a rendering or chemistry test.
function contextFromManifest(fixture) {
  const operations = fixture.batches.flatMap(batch => batch.operations);
  const molecules = operations.filter(op => op.type === 'molecule.add').map(op => ({ id: op.id,
    atoms: [...op.smiles.matchAll(/\[[^\]]+:(\d+)\]/g)].map(match => op.id + ':' + match[1]) }));
  const atoms = molecules.flatMap((molecule, index) => molecule.atoms.map((id, offset) => ({ id, label: 'C', x: index * 3 + offset, y: 0 })));
  const lonePairs = operations.filter(op => op.type === 'lonePair.add').map(op => ({ id: op.id, ownerAtomId: op.atom }));
  const bonds = [], arrows = operations.filter(op => op.type === 'arrow.add').map(op => {
    let source = op.source;
    if (source.type === 'lonePair') source = { type: 'lonePair', slotId: source.id, ownerAtomId: lonePairs.find(pair => pair.id === source.id).ownerAtomId };
    if (source.type === 'bond') {
      const id = op.id + '-source-bond'; bonds.push({ id, begin: source.atom1, end: source.atom2, order: 1 });
      source = { type: 'bond', bondId: id, component: source.component };
    }
    const target = op.target.type === 'formingBond' ? { type: 'formingBond', atomA: op.target.atom1, atomB: op.target.atom2 } : op.target;
    return { id: op.id, source, target, electronCount: op.electronCount };
  });
  const reactionSteps = operations.filter(op => op.type === 'reactionStep.create').map(op => ({ stepId: op.id, version: 1,
    reactants: op.reactants, products: op.products, layout: op.layout }));
  return { atoms, bonds, molecules, lonePairs, arrows, reactionSteps,
    reactionArrows: reactionSteps.map((step, index) => ({ id: index, stepId: step.stepId, start: { x: 0, y: index }, end: { x: 1, y: index } })) };
}

for (const build of [longDag23, forkJoin]) test(build().name + ' has an explicit bounded DAG manifest and valid references', () => {
  const fixture = build(), operations = fixture.batches.flatMap(batch => batch.operations);
  for (const batch of fixture.batches) assert.doesNotThrow(() => validateOperations(batch.operations));
  assert.equal(new Set(operations.map(op => op.id)).size, operations.length);
  assert.equal(fixture.batches.length, fixture.expected.steps);
  const graph = inspectGraph(contextFromManifest(fixture));
  assert.equal(graph.stepCount, fixture.expected.steps);
  assert.equal(graph.flowCount, fixture.expected.flows);
  assert.equal(graph.acyclic, true);
  assert.equal(graph.validReferences, true);
  assert.equal(graph.endpointReferencesValid, true);
  assert.equal(graph.unassignedFlows.length, 0);
  assert.equal(graph.longestPath, fixture.expected.longestPath);
  assert.equal(graph.roots.length, fixture.expected.roots);
  assert.equal(graph.forks.length, fixture.expected.forks);
  assert.equal(graph.merges.length, fixture.expected.merges);
  assert.equal(graph.weakComponents.length, 1);
  assert.equal(canonical(graph.edges.map(edge => edge.join('→')).sort()), canonical(fixture.expected.edges.map(edge => edge.join('→')).sort()));
  for (const shared of fixture.expected.sharedReferences) {
    const moleculeId = shared.atom.slice(0, shared.atom.lastIndexOf(':'));
    assert.equal(operations.filter(op => op.type === 'molecule.add' && op.id === moleculeId).length, 1);
    for (const id of shared.consumers) assert.ok(operations.find(op => op.id === id).reactants.some(ref => ref.startsWith(moleculeId + ':')));
  }
});

test('port auditing requires molecule/port roles on matching chemically owned stable atoms', () => {
  const context = contextFromManifest(forkJoin());
  const source = { role: 'graphPort', token: '接 B1', text: '接 B1', kind: 'branch', side: 'target', at: 'molecule', anchorRefs: ['fork-root:2'] };
  const target = { ...source, side: 'source', at: 'port' };
  const saved = [{ stepId: 'fork-start', labels: [source] }, { stepId: 'fork-right', labels: [target] }];
  assert.equal(inspectGraph(context, saved).portsPaired, true);
  const mismatched = structuredClone(saved); mismatched[1].labels[0].anchorRefs = ['fork-oh:1'];
  assert.equal(inspectGraph(context, mismatched).portsPaired, false);
  const duplicate = structuredClone(saved); duplicate[1].labels.push(target);
  assert.equal(inspectGraph(context, duplicate).portsPaired, false);
  const wrongSide = structuredClone(saved); wrongSide[1].labels[0].side = 'target';
  assert.equal(inspectGraph(context, wrongSide).portsPaired, false);
});

test('same-step source/source wrapping is valid but orphan and unrelated physical anchors are not', () => {
  const context = contextFromManifest(forkJoin());
  const molecule = { role: 'graphPort', token: '续 1', text: '续 1', kind: 'wrap', side: 'source', at: 'molecule', anchorRefs: ['fork-root:2'] };
  const saved = [{ stepId: 'fork-right', labels: [molecule, { ...molecule, at: 'port' }] }];
  assert.equal(inspectGraph(context, saved).portsPaired, true);
  const orphan = structuredClone(saved); orphan[0].labels.pop();
  assert.equal(inspectGraph(context, orphan).portsPaired, false);
  const ownerMissing = structuredClone(saved); ownerMissing[0].stepId = 'missing-step';
  assert.equal(inspectGraph(context, ownerMissing).portsPaired, false);
  const unrelated = structuredClone(saved); for (const label of unrelated[0].labels) label.anchorRefs = ['fork-oh:1'];
  assert.equal(inspectGraph(context, unrelated).portsPaired, false, 'two matching but unrelated physical refs must not pass');
  const unequal = structuredClone(saved); unequal[0].labels[1].anchorRefs = ['fork-ammonia:1'];
  assert.equal(inspectGraph(context, unequal).portsPaired, false);
  const bothPorts = structuredClone(saved); bothPorts[0].labels[0].at = 'port';
  assert.equal(inspectGraph(context, bothPorts).portsPaired, false);
  const invalidSide = structuredClone(saved); invalidSide[0].labels[0].side = 'reactants';
  assert.equal(inspectGraph(context, invalidSide).portsPaired, false);
});

test('actual final model same-source wraps retain matching native labels anchors and new-row arrow geometry', () => {
  const { context, savedSteps } = require('../agent/tests/fixtures/actual-same-side-wrap-context.json');
  const graph = inspectGraph(context, savedSteps);
  assert.equal(graph.portsPaired, true);
  for (const token of ['续 1', '续 3']) {
    const ends = savedSteps.flatMap(step => (step.labels || []).filter(label => label.token === token).map(label => ({ ...label, stepId: step.stepId })));
    assert.equal(ends.length, 2); assert.equal(new Set(ends.map(end => end.stepId)).size, 1);
    assert.ok(ends.every(end => end.side === 'source'));
    const molecule = ends.find(end => end.at === 'molecule'), port = ends.find(end => end.at === 'port');
    assert.ok(molecule && port); assert.deepEqual(molecule.anchorRefs, port.anchorRefs);
    for (const end of ends) assert.equal(context.texts.filter(text => text.text === token &&
      Math.abs(text.x - end.layoutX) < 1e-6 && Math.abs(text.y - end.layoutY) < 1e-6).length, 1, 'stored port has its exact native visible label');
    const arrow = context.reactionArrows.find(arrow => arrow.stepId === port.stepId);
    assert.ok(Math.abs(port.layoutY + 0.25 - arrow.start.y) < 1e-6 && port.layoutX < arrow.start.x);
    assert.ok(molecule.layoutY < port.layoutY, 'the physical molecule end remains on the earlier row');
  }
});

test('captured 23-step fork and Traube grouped homes preserve role-aware physical ownership', () => {
  const { cases } = require('../agent/tests/fixtures/actual-grouped-home-port-contexts.json');
  for (const fixture of cases) {
    const graph = inspectGraph(fixture.context, fixture.savedSteps);
    assert.equal(graph.portsPaired, true, fixture.name);
  }
  const fixture = cases[0], context = fixture.context, saved = structuredClone(fixture.savedSteps);
  const pair = inspectGraph(context, saved).portPairs.find(pair => pair.kinds.includes('wrap'));
  const home = saved.flatMap(step => (step.labels || []).map(label => ({ step, label }))).find(({ label }) => label.token === pair.token && label.at === 'molecule');
  const port = saved.flatMap(step => (step.labels || []).map(label => ({ step, label }))).find(({ label }) => label.token === pair.token && label.at === 'port');
  const owners = new Map(context.molecules.flatMap(molecule => molecule.atoms.map(id => [id, molecule.id])));
  const homeSide = new Set(home.step.products.map(id => owners.get(id))), portSide = new Set(port.step.reactants.map(id => owners.get(id)));
  assert.ok(home.label.anchorRefs.some(id => homeSide.has(owners.get(id))) && home.label.anchorRefs.some(id => !homeSide.has(owners.get(id))), 'actual home group combines a prior product with a later reagent');
  assert.ok(port.label.anchorRefs.every(id => portSide.has(owners.get(id))));
  const unrelated = context.molecules.find(molecule => !homeSide.has(molecule.id) && !portSide.has(molecule.id)).atoms[0];
  for (const { labels = [] } of saved) for (const label of labels) if (label.token === pair.token) label.anchorRefs = [unrelated];
  assert.equal(inspectGraph(context, saved).portsPaired, false, 'globally real matching refs with zero owner overlap are rejected');
});

test('graph auditing detects an actual dependency cycle rather than relying on step order', () => {
  const context = contextFromManifest(longDag23());
  context.reactionSteps.find(step => step.stepId === 'main-20').products.push('core-00:3');
  const graph = inspectGraph(context);
  assert.equal(graph.validReferences, true);
  assert.equal(graph.acyclic, false);
});
