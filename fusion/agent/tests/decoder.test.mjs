import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationStreamDecoder, parseStrictJson, validateOperations } from '../stream-operations.js';

const molecule = { id: 'mol1', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 100 };

test('implicit hydrogen materialization has one exact parent reference and streams with its later aliases', () => {
  const operations = [
    { id: 'showH', type: 'hydrogen.makeExplicit', parentAtomId: 'saved-oxygen' },
    { id: 'orientH', type: 'molecule.move', target: { atoms: ['showH:1'] }, orientTowardAtomId: 'acceptor' },
    { id: 'release', type: 'arrow.add', source: { type: 'bond', bondId: 'showH:bond:1', component: 'sigma' },
      target: { type: 'atom', atomId: 'saved-oxygen' }, electronCount: 2 },
  ];
  assert.deepEqual(validateOperations(operations), operations);
  const decoder = new OperationStreamDecoder();
  for (const character of JSON.stringify({ operations })) decoder.push(character);
  assert.deepEqual(decoder.finish().operations, operations);
  for (const parentAtomId of [undefined, null, 1, '', 'bad reference', '__proto__', 'constructor', 'prototype']) {
    assert.throws(() => validateOperations([{ id: 'bad', type: 'hydrogen.makeExplicit', parentAtomId }]));
  }
  for (const extra of [{ x: 1 }, { charge: 1 }, { radical: 0 }, { count: 2 }, { implicitH: 0 }, { target: { atoms: ['o'] } }]) {
    assert.throws(() => validateOperations([{ ...operations[0], ...extra }]));
  }
});

test('terminal-H orientation streams as a semantic move and keeps the numeric modes separate', () => {
  const op = { id: 'orient-h', type: 'molecule.move', target: { atoms: ['water:2'] }, orientTowardAtomId: 'acceptor:1' };
  assert.deepEqual(validateOperations([op]), [op]);
  const decoder = new OperationStreamDecoder();
  for (const character of JSON.stringify({ operations: [op], finish: true })) decoder.push(character);
  assert.deepEqual(decoder.finish().operations, [op]);
  for (const change of [{ x: 0 }, { y: 0 }, { dx: 0 }, { dy: 0 }, { x: 0, y: 0 }, { dx: 0, dy: 0 },
    { target: { molecule: 'mol:1' } }, { target: { atoms: ['h1', 'h2'] } },
    { orientTowardAtomId: null }, { orientTowardAtomId: 1 }, { orientTowardAtomId: 'bad reference' },
    { orientTowardAtomId: 'water:2' }]) assert.throws(() => validateOperations([{ ...op, ...change }]));
  for (const position of [{ x: 1, y: 2 }, { dx: 1, dy: 2 }]) {
    const numeric = { id: 'old-move', type: 'molecule.move', target: { atoms: ['h1'] }, ...position };
    assert.deepEqual(validateOperations([numeric]), [numeric]);
  }
});

test('existing lone pairs can explicitly switch between automatic target following and manual direction', () => {
  for (const change of [{ aim: 'auto' }, { aim: 'manual' }, { angle: 180 }, { aim: 'manual', angle: 135 }]) {
    const operation = { id: 'aim', type: 'lonePair.modify', lonePairId: 'saved-lp', ...change };
    assert.deepEqual(validateOperations([operation]), [operation]);
    const decoder = new OperationStreamDecoder();
    for (const character of JSON.stringify({ operations: [operation] })) decoder.push(character);
    assert.deepEqual(decoder.finish().operations, [operation]);
  }
  for (const change of [{}, { aim: 'other' }, { aim: 'auto', angle: 0 }, { aim: 'manual', angle: Infinity }]) {
    assert.throws(() => validateOperations([{ id: 'bad-aim', type: 'lonePair.modify', lonePairId: 'lp', ...change }]));
  }
});

test('versioned reaction steps support creation, partial modification and condition removal', () => {
  const operations = [
    { id: 'create', type: 'reactionStep.create', reactants: ['a:1'], products: ['b:1'] },
    { id: 'modify', type: 'reactionStep.modify', stepId: 'create', expectedVersion: 1, layout: { conditions: '', breakBefore: true } },
    { id: 'delete', type: 'reactionStep.delete', stepId: 'stable-step', expectedVersion: 2 },
  ];
  assert.deepEqual(validateOperations(operations), operations);
  const decoder = new OperationStreamDecoder();
  for (const character of JSON.stringify({ operations, finish: true })) decoder.push(character);
  assert.deepEqual(decoder.finish().operations, operations);
  for (const type of ['reactionStep.modify', 'reactionStep.delete']) {
    for (const version of [undefined, 0, -1, 1.5, '1']) {
      assert.throws(() => validateOperations([{ id: 'bad', type, stepId: 'step', expectedVersion: version, ...(type.endsWith('modify') && { layout: {} }) }]), /expectedVersion/);
    }
  }
  assert.throws(() => validateOperations([{ id: 'bad', type: 'reactionStep.modify', stepId: 'step', expectedVersion: 1 }]), /至少一项/);
  assert.throws(() => validateOperations([{ id: 'bad', type: 'reactionStep.create', reactants: ['a'], products: ['b'], layout: { conditions: '' } }]), /非空/);
  assert.throws(() => validateOperations([{ id: 'bad', type: 'reactionStep.modify', stepId: 'step', expectedVersion: 1, reactants: ['a'], products: ['a'] }]), /不同分子/);
  assert.throws(() => validateOperations([{ id: 'bad', type: 'reactionStep.modify', stepId: 'step', expectedVersion: 1, layout: { conditions: '\n' } }]), /非空|单行/);
});

test('reagent placement accepts each relative direction and rejects coordinates or unknown enum values', () => {
  for (const reagentPlacement of ['auto', 'left', 'right', 'above', 'below']) {
    for (const type of ['reactionStep.create', 'reactionStep.modify', 'reactionArrow.add']) {
      const op = { id: 'placement', type, ...(type === 'reactionStep.modify' ? { stepId: 'step', expectedVersion: 1 }
        : { reactants: ['a'], products: ['b'] }), layout: { reagentPlacement, reactantPlacement: 'vertical' } };
      assert.deepEqual(validateOperations([op]), [op]);
    }
  }
  for (const reagentPlacement of ['up', 'LEFT', '', null, 0, { x: -1 }]) {
    assert.throws(() => validateOperations([{ id: 'bad', type: 'reactionStep.modify', stepId: 'step', expectedVersion: 1,
      layout: { reagentPlacement } }]), /试剂相对位置/);
  }
});

test('preview only emits a closed operation while later operations are still streaming', () => {
  const seen = [];
  const decoder = new OperationStreamDecoder({ onOperation: op => seen.push(op) });
  decoder.push('{"operations":[{"id":"mol1","type":"molecule.add","smiles":"C');
  assert.equal(seen.length, 0);
  decoder.push('O","x":1');
  assert.equal(seen.length, 0);
  decoder.push('00},');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].x, 100);
  decoder.push('{"id":"lp1","type":"lonePair.add","atom":"mol1:1"}],"finish":true}');
  assert.equal(seen.length, 2);
  assert.equal(decoder.finish().finish, true);
});

test('chunk boundaries, escaped quotes and braces inside strings do not close an object', () => {
  const seen = [];
  const decoder = new OperationStreamDecoder({ onOperation: op => seen.push(op) });
  // Use JSON.stringify so every JSON escape is deliberate.
  const raw = JSON.stringify({ operations: [{ id: 'note', type: 'text.add', text: 'a " } [ \\ b', x: 0, y: 1 }] });
  for (const character of raw) decoder.push(character);
  assert.equal(seen.length, 1);
  assert.equal(decoder.finish().operations[0].text, 'a " } [ \\ b');
});

test('duplicate JSON keys, trailing commas, repeated ids and unclosed input are rejected', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /重复/);
  assert.throws(() => parseStrictJson('{"a":{"b":1,"b":2}}'), /重复/);
  const duplicateRoot = new OperationStreamDecoder();
  assert.throws(() => duplicateRoot.push('{"operations":[],"operations":[]}'), /重复/);
  const trailing = new OperationStreamDecoder();
  assert.throws(() => trailing.push(JSON.stringify({ operations: [molecule] }).replace('}]}', '},]}')), /operation/);
  const repeated = new OperationStreamDecoder();
  assert.throws(() => repeated.push(JSON.stringify({ operations: [molecule, molecule] })), /重复/);
  const incomplete = new OperationStreamDecoder();
  incomplete.push('{"operations":[');
  assert.throws(() => incomplete.finish(), /未完整/);
});

test('strict semantic validation rejects unsafe coordinates, malformed endpoints and unrequested text', () => {
  assert.throws(() => validateOperations([{ ...molecule, x: Infinity }]), /有限/);
  assert.throws(() => validateOperations([{ ...molecule, unexpected: true }]), /未知/);
  assert.throws(() => validateOperations([{ id: 'a', type: 'arrow.add', source: { type: 'atom', atomId: 'm:1' }, target: { type: 'formingBond', atom1: 'm:1', atom2: 'm:1' }, electronCount: 2 }]), /不同/);
  assert.throws(() => validateOperations([{ id: 't', type: 'text.add', text: 'Label', x: 0, y: 0 }], { allowText: false }), /明确要求/);
  assert.throws(() => new OperationStreamDecoder({ maxBytes: 8 }).push('{"operations":['), /大小/);
  assert.equal(validateOperations([molecule]).length, 1);
});

test('a closed prefix never makes malformed final arguments valid', () => {
  const decoder = new OperationStreamDecoder();
  decoder.push('{"operations":[' + JSON.stringify(molecule) + ']');
  assert.equal(decoder.operations.length, 1);
  assert.throws(() => decoder.finish(), /未完整/);
});

test('only one unmatched root closer can follow a complete object', () => {
  const root = JSON.stringify({ operations: [molecule] });
  const decoder = new OperationStreamDecoder();
  decoder.push(root);
  decoder.push(' }');
  assert.deepEqual(decoder.finish().operations, [molecule]);
  for (const suffix of ['}}', '{}', '}{}', ' x']) {
    assert.throws(() => new OperationStreamDecoder().push(root + suffix), /多余/);
  }
});

test('atom.modify accepts valid radical states and rejects out-of-range values', () => {
  assert.equal(validateOperations([{ id: 'm1', type: 'atom.modify', atomId: 'm:1', radical: 0 }]).length, 1);
  assert.equal(validateOperations([{ id: 'm2', type: 'atom.modify', atomId: 'm:1', radical: 2 }]).length, 1);
  assert.throws(() => validateOperations([{ id: 'm3', type: 'atom.modify', atomId: 'm:1', radical: 4 }]), /0–3/);
});

test('bond arrow sources accept either a bond ID or an exact atom pair', () => {
  const arrow = (source, id = 'a') => ({ id, type: 'arrow.add', source,
    target: { type: 'atom', atomId: 'mol:2' }, electronCount: 2 });
  assert.equal(validateOperations([arrow({ type: 'bond', bondId: 'mol:bond:1', component: 'sigma' })]).length, 1);
  assert.equal(validateOperations([arrow({ type: 'bond', atom1: 'mol:1', atom2: 'mol:2', component: 'pi' })]).length, 1);
  assert.throws(() => validateOperations([arrow({ type: 'bond', atom1: 'mol:1', component: 'sigma' })]), /有效引用/);
  assert.throws(() => validateOperations([arrow({ type: 'bond', atom1: 'mol:1', atom2: 'mol:1', component: 'sigma' })]), /不同/);
  assert.throws(() => validateOperations([arrow({ type: 'bond', atom1: 'mol:1', atom2: 'mol:2', bondId: 'mol:bond:1', component: 'sigma' })]), /bond endpoint/);
});
