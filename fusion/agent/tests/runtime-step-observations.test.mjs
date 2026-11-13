import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { actualStepObservations } from '../step-observations.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/high-step-observations.json', import.meta.url), 'utf8'));

test('recorded HIGH canvas first step reports the actual O lone-pair to H and sigma bond to its retained O', () => {
  const { steps, unassignedElectronFlows } = actualStepObservations(fixture);
  assert.equal(steps.length, 3); assert.equal(unassignedElectronFlows.length, 0);
  assert.deepEqual(steps.map(step => step.electronFlows.length), [2, 2, 2]);
  const pair = steps[0].electronFlows.find(flow => flow.source.kind === 'lonePair');
  assert.equal(pair.id, 'ar-6a882b66-d32a-49d9-a5fa-2caebc3be474');
  assert.equal(pair.source.atom.id, 'at-60e90111-fc65-4ba6-a23f-5d49cc18f8dd');
  assert.equal(pair.source.atom.label, 'O'); assert.equal(pair.source.atom.charge, 0);
  assert.equal(pair.target.atom.id, 'at-2534afc6-52b3-4a20-8399-b524399a22f7'); assert.equal(pair.target.atom.label, 'H');
  const sigma = steps[0].electronFlows.find(flow => flow.source.kind === 'bond');
  assert.equal(sigma.source.component, 'sigma'); assert.equal(sigma.source.order, 1);
  assert.deepEqual(sigma.source.atoms.map(atom => atom.label).sort(), ['H', 'O']);
  assert.equal(sigma.target.atom.id, 'at-74d9270e-e9be-43b9-9799-c260fbb8fb91'); assert.equal(sigma.target.atom.label, 'O');
  assert.ok(sigma.source.atoms.some(atom => atom.id === sigma.target.atom.id));
  assert.ok(steps.every(step => !step.unresolved && step.electronFlows.every(flow => !flow.unresolved)));
});

test('recorded second step keeps the real pi C=O source and product oxonium charge/connectivity', () => {
  const second = actualStepObservations(fixture).steps[1];
  const pi = second.electronFlows.find(flow => flow.source.kind === 'bond');
  assert.equal(pi.source.component, 'pi'); assert.equal(pi.source.order, 2);
  assert.equal(pi.target.atom.label, 'O'); assert.equal(pi.target.atom.charge, 1);
  assert.ok(pi.source.atoms.some(atom => atom.id === pi.target.atom.id));
  const attack = second.electronFlows.find(flow => flow.source.kind === 'lonePair');
  assert.equal(attack.target.kind, 'formingBond'); assert.deepEqual(attack.target.atoms.map(atom => atom.label).sort(), ['C', 'O']);
  const oxonium = second.productAtoms.find(atom => atom.id === 'at-daedc445-dc3c-4272-a76c-31132bab272c');
  assert.equal(oxonium.label, 'O'); assert.equal(oxonium.charge, 1); assert.equal(oxonium.implicitH, 0);
  assert.deepEqual(oxonium.neighbors.map(atom => atom.label).sort(), ['C', 'C', 'H']);
  assert.ok(oxonium.neighbors.every(atom => atom.order === 1));
  assert.equal(second.productAtoms.find(atom => atom.id === 'at-51de9a33-2eeb-455a-999a-c97471ad10a0').charge, 0);
});

test('final products expose actual neutral oxygen and hydronium H counts without guessed product roles', () => {
  const third = actualStepObservations(fixture).steps[2];
  const ether = third.productAtoms.find(atom => atom.id === 'at-9d1eb305-e1f8-4ed7-96a5-7b23c8df48d2');
  assert.equal(ether.charge, 0); assert.equal(ether.implicitH, 0); assert.deepEqual(ether.neighbors.map(atom => atom.label), ['C', 'C']);
  const hydronium = third.productAtoms.find(atom => atom.id === 'at-cc4d3b60-bb00-423c-880e-773c6d9ffe62');
  assert.equal(hydronium.charge, 1); assert.equal(hydronium.implicitH, 2); assert.equal(hydronium.neighbors[0].label, 'H');
  assert.equal(third.productAtomScope, 'noncarbon_or_charged_atoms');
  assert.doesNotMatch(JSON.stringify(third), /productRole|atomMapping|inferred|oxonium|hydronium/);
});

test('observations ignore model plans/prose and claimed arrow ownership, are pure, and retain actual native IDs', () => {
  const canvas = structuredClone(fixture), original = JSON.stringify(canvas);
  canvas.reasoning = 'HIDDEN_THOUGHT'; canvas.plan = 'WRONG_MODEL_PLAN_PI_TO_O';
  canvas.reactionSteps[0].objective = 'WRONG_MODEL_PLAN_PI_TO_O';
  canvas.reactionSteps[0].checks = { layout: { checkedArrowIds: [canvas.arrows[3].id] } };
  canvas.arrows[0].stepId = canvas.reactionSteps[2].stepId;
  const before = JSON.stringify(canvas), actual = actualStepObservations(canvas);
  assert.equal(JSON.stringify(canvas), before); assert.notEqual(before, original);
  assert.equal(actual.steps[0].electronFlows[0].id, fixture.arrows[0].id);
  assert.doesNotMatch(JSON.stringify(actual), /HIDDEN_THOUGHT|WRONG_MODEL_PLAN|reasoning|objective|checkedArrowIds/);
});

test('unknown labels, dangling endpoints and missing lone pairs stay explicitly unresolved', () => {
  const canvas = { atoms: [{ id: 'o', label: 'O', charge: -1, implicitH: 0 }, { id: 'h', label: 'H', charge: 0, implicitH: 0 },
    { id: 'unknown', label: 'UnknownElement', implicitH: 0 }], bonds: [{ id: 'oh', begin: 'o', end: 'h', order: 1 }],
    lonePairs: [], reactionSteps: [{ stepId: 'step', version: 1, reactants: ['o','unknown'], products: ['unknown'] }],
    arrows: [{ id: 'dangling', electronCount: 2, source: { type: 'lonePair', slotId: 'missing-pair', ownerAtomId: 'o' }, target: { type: 'atom', atomId: 'missing-h' } },
      { id: 'unknown-label', electronCount: 2, source: { type: 'atom', atomId: 'unknown' }, target: { type: 'atom', atomId: 'h' } },
      { id: 'missing-bond', electronCount: 2, source: { type: 'bond', bondId: 'absent', component: 'sigma' }, target: null }] };
  const result = actualStepObservations(canvas);
  assert.equal(result.steps[0].unresolved, true);
  const dangling = result.steps[0].electronFlows[0];
  assert.equal(dangling.source.unresolved, true); assert.equal(dangling.target.atom.id, 'missing-h');
  assert.equal(dangling.target.atom.label, null); assert.equal(dangling.target.atom.charge, null); assert.equal(dangling.target.atom.unresolved, true);
  const unknown = result.steps[0].electronFlows[1].source.atom;
  assert.equal(unknown.id, 'unknown'); assert.equal(unknown.label, null); assert.equal(unknown.charge, null); assert.equal(unknown.unresolved, true);
  assert.equal(result.unassignedElectronFlows[0].id, 'missing-bond'); assert.deepEqual(result.unassignedElectronFlows[0].candidateStepIds, []);
});

test('shared reactant components yield ambiguous unassigned flows rather than invented step membership', () => {
  const canvas = structuredClone(fixture);
  canvas.reactionSteps.push({ ...structuredClone(canvas.reactionSteps[0]), stepId: 'another-branch' });
  const result = actualStepObservations(canvas);
  assert.equal(result.steps[0].electronFlows.length, 0); assert.equal(result.steps[3].electronFlows.length, 0);
  assert.equal(result.steps[0].unresolved, true); assert.equal(result.steps[3].unresolved, true);
  assert.equal(result.unassignedElectronFlows.length, 2);
  for (const flow of result.unassignedElectronFlows) {
    assert.equal(flow.unresolved, true); assert.deepEqual(flow.candidateStepIds, [canvas.reactionSteps[0].stepId, 'another-branch']);
  }
});
