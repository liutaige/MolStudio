import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkElectronFlowCoverage, findInvalidProtonTransfer } from '../mechanism-coverage.js';
import { checkMechanismPreflight } from '../mechanism-preflight.js';
import { Runtime } from '../runtime.js';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/protonation-wrong-sigma-target.json', import.meta.url)));
const input = () => structuredClone(recorded.input);
const donorO = 'at-236d9af5-9bde-496f-b34c-dd28c6347887';
const protonH = 'at-9c5b4dcd-57c5-4ccb-8db9-977cea4e4cf3';
const badArrow = 'ar-900484e4-e336-4471-a457-60660357a0f4';
const donorBond = 'bd-a0193a11-18e5-41d6-bf9f-c54a5e498e80';
const correct = () => {
  const value = input(); value.arrows.find(arrow => arrow.id === badArrow).target.atomId = donorO; return value;
};
const atom = (id, label, implicitH, charge = 0) => ({ id, label, implicitH, charge, radical: 0, isotope: 0 });
const bond = (id, begin, end, order = 1) => ({ id, begin, end, order });
const pairArrow = (id, owner, proton, forming = false) => ({ id, electronCount: 2,
  source: { type: 'lonePair', slotId: `lp-${owner}`, ownerAtomId: owner },
  target: forming ? { type: 'formingBond', atomA: owner, atomB: proton } : { type: 'atom', atomId: proton } });
const release = (id, bondId, target) => ({ id, electronCount: 2, source: { type: 'bond', bondId, component: 'sigma' },
  target: { type: 'atom', atomId: target } });

test('actual model hydronium sigma-to-carbonyl-O defect is rejected with exact repair references despite explicit/implicit H mismatch', () => {
  const value = input();
  const issue = checkMechanismPreflight(value);
  assert.equal(issue.code, 'proton_transfer_sigma_wrong_target');
  assert.equal(issue.arrowId, badArrow);
  assert.equal(issue.sourceBondId, donorBond);
  assert.equal(issue.protonAtomId, protonH);
  assert.equal(issue.correctTargetAtomId, donorO);
  assert.equal(issue.actualTargetAtomId, 'at-e346605e-d6c4-48c1-9ecf-1ef219debd1c');
  assert.match(checkElectronFlowCoverage(value), /σ 电子应回到供质子的 O 原子/);
  assert.equal(value.reactantAtoms.length, 5);
  assert.equal(value.productAtoms.length, 4);
  value.arrows[1].target.atomId = protonH;
  assert.equal(findInvalidProtonTransfer(value).correctTargetAtomId, donorO, 'a sigma pair sent to the same proton is not a relay');
});

test('the actual acid protonation passes after correcting only its retained donor-O endpoint', () => {
  const value = correct();
  assert.equal(checkMechanismPreflight(value), null);
  assert.equal(checkElectronFlowCoverage(value), null);
  const protonatedO = value.atoms.find(item => item.id === 'at-f04f815d-7a7c-43f4-b37e-e86cec89ec0e');
  protonatedO.implicitH--;
  value.atoms.push(atom('product-explicit-H', 'H', 0)); value.productAtoms.push('product-explicit-H');
  value.bonds.push(bond('product-OH', protonatedO.id, 'product-explicit-H'));
  assert.equal(checkMechanismPreflight(value), null);
  assert.equal(checkElectronFlowCoverage(value), null);
});

function deprotonation() {
  return { reactantAtoms: ['acid-O', 'acid-C', 'h', 'base-O'], productAtoms: ['product-O', 'product-C', 'product-base'],
    atoms: [atom('acid-O', 'O', 1, 1), atom('acid-C', 'C', 3), atom('h', 'H', 0), atom('base-O', 'O', 2),
      atom('product-O', 'O', 1), atom('product-C', 'C', 3), atom('product-base', 'O', 3, 1)],
    bonds: [bond('acid-OH', 'acid-O', 'h'), bond('acid-OC', 'acid-O', 'acid-C'), bond('product-OC', 'product-O', 'product-C')],
    lonePairs: [{ id: 'lp-base-O', ownerAtomId: 'base-O' }],
    arrows: [pairArrow('take-H', 'base-O', 'h', true), release('release-H', 'acid-OH', 'acid-O')] };
}

test('ordinary oxonium deprotonation and ammonium proton donation retain donor electrons with either H depiction', () => {
  const value = deprotonation();
  assert.equal(checkMechanismPreflight(value), null); assert.equal(checkElectronFlowCoverage(value), null);
  value.atoms.find(item => item.id === 'product-base').implicitH--;
  value.atoms.push(atom('different-product-H', 'H', 0)); value.productAtoms.push('different-product-H');
  value.bonds.push(bond('product-base-H', 'product-base', 'different-product-H'));
  assert.equal(checkMechanismPreflight(value), null); assert.equal(checkElectronFlowCoverage(value), null);
  const ammonium = { reactantAtoms: ['n', 'h', 'o'], productAtoms: ['n2', 'o2'],
    atoms: [atom('n', 'N', 3, 1), atom('h', 'H', 0), atom('o', 'O', 2), atom('n2', 'N', 3), atom('o2', 'O', 3, 1)],
    bonds: [bond('nh', 'n', 'h')], lonePairs: [{ id: 'lp-o', ownerAtomId: 'o' }],
    arrows: [pairArrow('protonate', 'o', 'h'), release('nh-pair', 'nh', 'n')] };
  assert.equal(checkMechanismPreflight(ammonium), null); assert.equal(checkElectronFlowCoverage(ammonium), null);
  ammonium.arrows[1].target.atomId = 'o';
  assert.equal(findInvalidProtonTransfer(ammonium).code, 'proton_transfer_sigma_wrong_target');
});

test('two-electron proton relays, coupled supported bond gains and C-H enolate donation are not classified as wrong O/N-H retention', () => {
  const relay = { reactantAtoms: ['o1', 'h1', 'o2', 'h2', 'o3'], productAtoms: [],
    atoms: [atom('o1', 'O', 2, 1), atom('h1', 'H', 0), atom('o2', 'O', 1), atom('h2', 'H', 0), atom('o3', 'O', 2)],
    bonds: [bond('o1h1', 'o1', 'h1'), bond('o2h2', 'o2', 'h2')], lonePairs: [{ id: 'lp-o3', ownerAtomId: 'o3' }],
    arrows: [pairArrow('take-H1', 'o3', 'h1'), release('relay-pair', 'o1h1', 'h2'), release('release-H2', 'o2h2', 'o2')] };
  assert.equal(findInvalidProtonTransfer(relay), null);
  // Singlet methylene insertion into methanol O-H: the sigma pair forms the
  // product O-C bond while the carbene pair forms C-H. It is not a simple PT.
  const concerted = { reactantAtoms: ['methyl', 'o', 'h', 'carbene'], productAtoms: ['methyl2', 'o2', 'carbene2'],
    atoms: [atom('methyl', 'C', 3), atom('o', 'O', 0), atom('h', 'H', 0), atom('carbene', 'C', 2),
      atom('methyl2', 'C', 3), atom('o2', 'O', 0), atom('carbene2', 'C', 3)],
    bonds: [bond('methanol', 'methyl', 'o'), bond('oh', 'o', 'h'), bond('product-methyl', 'methyl2', 'o2'), bond('product-new', 'o2', 'carbene2')],
    lonePairs: [{ id: 'lp-carbene', ownerAtomId: 'carbene' }],
    arrows: [pairArrow('take-H', 'carbene', 'h'), release('new-OC', 'oh', 'carbene')] };
  assert.equal(findInvalidProtonTransfer(concerted), null);
  assert.equal(checkMechanismPreflight(concerted), null); assert.equal(checkElectronFlowCoverage(concerted), null);
  const carbon = deprotonation(); carbon.atoms.find(item => item.id === 'acid-O').label = 'C';
  carbon.arrows[1].target = { type: 'formingBond', atomA: 'acid-O', atomB: 'acid-C' };
  assert.equal(findInvalidProtonTransfer(carbon), null);
});

test('the proton invariant skips hydride, radical, fishhook and bridging-H cases instead of applying acid/base assumptions', () => {
  for (const change of [
    value => { value.atoms.find(item => item.id === donorO).label = 'B'; },
    value => { value.atoms.find(item => item.id === donorO).label = 'Fe'; },
    value => { value.arrows.forEach(arrow => { arrow.electronCount = 1; }); },
    value => { value.atoms.find(item => item.id === protonH).radical = 1; },
    value => { value.atoms.find(item => item.id === protonH).charge = -1; },
    value => { value.bonds.push(bond('bridge', protonH, value.arrows[0].source.ownerAtomId)); },
  ]) {
    const value = input(); change(value); assert.equal(findInvalidProtonTransfer(value), null);
  }
});

test('runtime rejects the actual new arrow batch before commit and returns stable original aliases for rollback repair', async () => {
  const value = input();
  const canvas = { ...value, molecules: [value.reactantAtoms.slice(0, 3), value.reactantAtoms.slice(3), value.productAtoms.slice(0, 3), value.productAtoms.slice(3)]
    .filter(atoms => atoms.length).map((atoms, index) => ({ id: `mol${index}`, atoms })),
    reactionSteps: [{ stepId: recorded.stepId, version: 1, reactants: [value.reactantAtoms[0], donorO], products: [value.productAtoms[0], value.productAtoms.at(-1)] }] };
  // Group molecules by actual connectivity, independent of fixture atom order.
  canvas.molecules = [{ id: 'substrate', atoms: value.reactantAtoms.filter(id => ![donorO, protonH].includes(id)) },
    { id: 'acid', atoms: [donorO, protonH] }, { id: 'protonated', atoms: value.productAtoms.filter(id => id !== value.productAtoms.at(-1)) },
    { id: 'water', atoms: [value.productAtoms.at(-1)] }];
  const operation = { id: 'bad-release-op', type: 'arrow.add', electronCount: 2,
    source: { type: 'bond', bondId: 'acid:bond:1', component: 'sigma' }, target: { type: 'atom', atomId: 'substrate:3' } };
  let commits = 0;
  const bridge = { async getContext() { return canvas; }, async clearPreview() {}, async previewOperations() {},
    async applyOperations(operations, settings) {
      settings.validateMechanism(canvas, { operations, updated: [], created: [
        { id: 'acid', type: 'molecule.add', atoms: [{ id: donorO, ref: '1' }, { id: protonH, ref: '2' }], bonds: [{ id: donorBond, ref: '1' }] },
        { id: operation.id, type: 'arrow.add', entityIds: [badArrow] },
      ] });
      commits++; return { created: [] };
    } };
  const runtime = new Runtime({ bridge, eventTarget: new EventTarget() });
  const run = { id: 'test', generation: 1, task: '画一个质子转移步骤', controller: new AbortController(), bridge,
    decoderErrors: new Map(), toolFailures: new Map(), applied: new Map(), previews: new Map(), stepCalls: new Map(),
    previewChain: Promise.resolve(), stepChain: Promise.resolve(), allowText: false };
  runtime._active = run; runtime._generation = 1;
  const draw = runtime._tools(run).find(tool => tool.name === 'draw_operations');
  await assert.rejects(draw.execute('bad-call', { operations: [operation] }, run.controller.signal, () => {}), error => {
    const issue = JSON.parse(error.message);
    assert.equal(issue.code, 'proton_transfer_sigma_wrong_target');
    assert.equal(issue.operationId, operation.id); assert.equal(issue.arrowId, badArrow);
    assert.equal(issue.correctTargetAtomId, donorO); assert.equal(issue.correctTargetRef, 'acid:1');
    assert.equal(issue.protonRef, 'acid:2'); assert.equal(issue.sourceBondRef, 'acid:bond:1');
    assert.equal(issue.sourceArrowOperationId, operation.id); assert.equal(issue.graphSnapshotDiscarded, true);
    return true;
  });
  assert.equal(commits, 0); assert.equal(run.applied.size, 0);
});
