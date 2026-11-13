'use strict';

// Deterministic geometry/data fixtures, not the user's industrial caffeine
// mechanism. The long graph deliberately repeats halide-exchange motifs to
// exercise layout without presenting a fabricated 23-step industrial synthesis.
const molecule = (id, smiles) => ({ id, type: 'molecule.add', smiles });
const step = (id, reactants, products) => ({ id, type: 'reactionStep.create', reactants, products, layout: {} });
const pair = (id, atom) => ({ id, type: 'lonePair.add', atom });
const attack = (id, lp, donor, acceptor) => ({ id, type: 'arrow.add', source: { type: 'lonePair', id: lp },
  target: { type: 'formingBond', atom1: donor, atom2: acceptor }, electronCount: 2 });
const release = (id, a, b, target) => ({ id, type: 'arrow.add',
  source: { type: 'bond', atom1: a, atom2: b, component: 'sigma' }, target: { type: 'atom', atomId: target }, electronCount: 2 });
const propyl = halogen => `[CH3:1][CH2:2][CH2:3][${halogen}:4]`;

function describe(id, operations, extra = {}) {
  const declaration = operations.find(operation => operation.type === 'reactionStep.create');
  return { id, operations, stepOperationId: declaration.id,
    flowOperationIds: operations.filter(operation => operation.type === 'arrow.add').map(operation => operation.id), ...extra };
}

function longDag23() {
  const batches = [], mainStepIds = [], preparationStepIds = [];
  function main(index) {
    const number = String(index).padStart(2, '0'), id = 'main-' + number;
    const previous = 'core-' + String(index - 1).padStart(2, '0'), current = 'core-' + number;
    const incoming = index % 2 ? 'Cl' : 'Br', outgoing = index % 2 ? 'Br' : 'Cl';
    const donor = index === 11 ? 'prep-final-chloride' : id + '-nucleophile';
    const ops = [step(id, [previous + ':3', donor + ':1'], [current + ':3', id + '-leaving:1'])];
    if (index === 1) ops.push(molecule(previous, propyl('Br')));
    if (index !== 11) ops.push(molecule(donor, `[${incoming}-:1]`));
    ops.push(molecule(current, propyl(incoming)), molecule(id + '-leaving', `[${outgoing}-:1]`),
      pair(id + '-lp', donor + ':1'), attack(id + '-attack', id + '-lp', donor + ':1', previous + ':3'),
      release(id + '-release', previous + ':3', previous + ':4', previous + ':4'));
    batches.push(describe(id, ops, { role: 'mainline' })); mainStepIds.push(id);
  }
  for (let index = 1; index <= 10; index++) main(index);
  batches.push(describe('prepare-01', [
    step('prepare-01', ['prep-hcl:1', 'prep-hydroxide:1'], ['prep-chloride:1', 'prep-water:1']),
    molecule('prep-hcl', '[Cl:1][H:2]'), molecule('prep-hydroxide', '[OH-:1]'),
    molecule('prep-chloride', '[Cl-:1]'), molecule('prep-water', '[OH2:1]'),
    pair('prep-proton-lp', 'prep-hydroxide:1'),
    attack('prep-proton-attack', 'prep-proton-lp', 'prep-hydroxide:1', 'prep-hcl:2'),
    release('prep-proton-release', 'prep-hcl:1', 'prep-hcl:2', 'prep-hcl:1'),
  ], { role: 'preparation' }));
  batches.push(describe('prepare-02', [
    step('prepare-02', ['prep-chloride:1', 'prep-methyl-bromide:1'], ['prep-methyl-chloride:1', 'prep-bromide:1']),
    molecule('prep-methyl-bromide', '[CH3:1][Br:2]'),
    molecule('prep-methyl-chloride', '[CH3:1][Cl:2]'), molecule('prep-bromide', '[Br-:1]'),
    pair('prep-chloride-lp', 'prep-chloride:1'),
    attack('prep-chloride-attack', 'prep-chloride-lp', 'prep-chloride:1', 'prep-methyl-bromide:1'),
    release('prep-bromide-release', 'prep-methyl-bromide:1', 'prep-methyl-bromide:2', 'prep-methyl-bromide:2'),
  ], { role: 'preparation' }));
  batches.push(describe('prepare-03', [
    step('prepare-03', ['prep-methyl-chloride:1', 'prep-bromide:1'], ['prep-regenerated-methyl-bromide:1', 'prep-final-chloride:1']),
    molecule('prep-regenerated-methyl-bromide', '[CH3:1][Br:2]'), molecule('prep-final-chloride', '[Cl-:1]'),
    pair('prep-bromide-lp', 'prep-bromide:1'),
    attack('prep-bromide-attack', 'prep-bromide-lp', 'prep-bromide:1', 'prep-methyl-chloride:1'),
    release('prep-chloride-release', 'prep-methyl-chloride:1', 'prep-methyl-chloride:2', 'prep-methyl-chloride:2'),
  ], { role: 'preparation' }));
  preparationStepIds.push('prepare-01', 'prepare-02', 'prepare-03');
  for (let index = 11; index <= 20; index++) main(index);
  const edges = mainStepIds.slice(1).map((id, index) => [mainStepIds[index], id]);
  edges.push(['prepare-01', 'prepare-02'], ['prepare-02', 'prepare-03'], ['prepare-03', 'main-11']);
  return {
    name: 'dag-23-mainline-with-preparation', scope: 'Geometry and data regression; not an industrial caffeine mechanism or a reconstruction of the historical SVG.',
    batches, expected: { steps: 23, flows: 46, longestPath: 20, roots: 2, merges: 1, forks: 0,
      edges, mainStepIds, preparationStepIds, sharedReferences: [{ atom: 'prep-final-chloride:1', producer: 'prepare-03', consumers: ['main-11'] }],
      minimumMainlineRows: 3, undoTransactions: 23 },
  };
}

function forkJoin() {
  const batches = [
    describe('fork-start', [
      step('fork-start', ['fork-precursor:3', 'fork-start-chloride:1'], ['fork-root:3', 'fork-start-bromide:1']),
      molecule('fork-precursor', '[Br:1][CH2:2][CH2:3][Br:4]'), molecule('fork-start-chloride', '[Cl-:1]'),
      molecule('fork-root', '[Br:1][CH2:2][CH2:3][Cl:4]'), molecule('fork-start-bromide', '[Br-:1]'),
      pair('fork-start-lp', 'fork-start-chloride:1'),
      attack('fork-start-attack', 'fork-start-lp', 'fork-start-chloride:1', 'fork-precursor:3'),
      release('fork-start-release', 'fork-precursor:3', 'fork-precursor:4', 'fork-precursor:4'),
    ]),
    describe('fork-left', [
      step('fork-left', ['fork-root:2', 'fork-oh:1'], ['fork-left-middle:2', 'fork-left-bromide:1']),
      molecule('fork-oh', '[OH-:1]'),
      molecule('fork-left-middle', '[CH2:2]([OH:5])[CH2:3][Cl:4]'), molecule('fork-left-bromide', '[Br-:1]'),
      pair('fork-left-lp', 'fork-oh:1'), attack('fork-left-attack', 'fork-left-lp', 'fork-oh:1', 'fork-root:2'),
      release('fork-left-release', 'fork-root:2', 'fork-root:1', 'fork-root:1'),
    ]),
    describe('fork-right', [
      step('fork-right', ['fork-root:3', 'fork-ammonia:1'], ['fork-right-middle:3', 'fork-right-chloride:1']),
      molecule('fork-ammonia', '[NH3:1]'), molecule('fork-right-middle', '[Br:1][CH2:2][CH2:3][NH2+:5][H:6]'),
      molecule('fork-right-chloride', '[Cl-:1]'), pair('fork-right-lp', 'fork-ammonia:1'),
      attack('fork-right-attack', 'fork-right-lp', 'fork-ammonia:1', 'fork-root:3'),
      release('fork-right-release', 'fork-root:3', 'fork-root:4', 'fork-root:4'),
    ]),
    describe('left-continue', [
      step('left-continue', ['fork-left-middle:3', 'fork-left-nucleophile:1'], ['fork-left-final:3', 'fork-left-chloride:1']),
      molecule('fork-left-nucleophile', '[Br-:1]'), molecule('fork-left-final', '[CH2:2]([OH:5])[CH2:3][Br:4]'),
      molecule('fork-left-chloride', '[Cl-:1]'), pair('left-continue-lp', 'fork-left-nucleophile:1'),
      attack('left-continue-attack', 'left-continue-lp', 'fork-left-nucleophile:1', 'fork-left-middle:3'),
      release('left-continue-release', 'fork-left-middle:3', 'fork-left-middle:4', 'fork-left-middle:4'),
    ]),
    describe('right-continue', [
      step('right-continue', ['fork-right-middle:5', 'fork-right-hydroxide:1'], ['fork-right-final:5', 'fork-right-water:1']),
      molecule('fork-right-hydroxide', '[OH-:1]'), molecule('fork-right-final', '[Br:1][CH2:2][CH2:3][NH2:5]'),
      molecule('fork-right-water', '[OH2:1]'), pair('right-continue-lp', 'fork-right-hydroxide:1'),
      attack('right-continue-attack', 'right-continue-lp', 'fork-right-hydroxide:1', 'fork-right-middle:6'),
      release('right-continue-release', 'fork-right-middle:5', 'fork-right-middle:6', 'fork-right-middle:5'),
    ]),
    describe('join', [
      step('join', ['fork-left-final:3', 'fork-right-final:5'], ['fork-joined:5', 'fork-join-bromide:1']),
      molecule('fork-joined', '[Br:1][CH2:2][CH2:3][NH2+:5][CH2:6][CH2:7][OH:8]'),
      molecule('fork-join-bromide', '[Br-:1]'), pair('join-lp', 'fork-right-final:5'),
      attack('join-attack', 'join-lp', 'fork-right-final:5', 'fork-left-final:3'),
      release('join-release', 'fork-left-final:3', 'fork-left-final:4', 'fork-left-final:4'),
    ]),
  ];
  return { name: 'fork-two-branches-join', scope: 'Geometry/data fork-join fixture with one shared root structure; the two alternatives are not claimed to be one preparative synthesis.', batches,
    expected: { steps: 6, flows: 12, longestPath: 4, roots: 1, merges: 1, forks: 1,
      edges: [['fork-start', 'fork-left'], ['fork-start', 'fork-right'], ['fork-left', 'left-continue'], ['fork-right', 'right-continue'], ['left-continue', 'join'], ['right-continue', 'join']],
      sharedReferences: [{ atom: 'fork-root:2', producer: 'fork-start', consumers: ['fork-left', 'fork-right'] }],
      minimumMainlineRows: 1, undoTransactions: 6 },
  };
}

module.exports = { longDag23, forkJoin };
