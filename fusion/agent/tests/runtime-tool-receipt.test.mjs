import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrawReceipt, withoutEchoedDrawArguments } from '../tool-receipt.js';

test('draw receipts keep current typed aliases and omit cumulative maps from the model context', () => {
  const atoms = [{ ref: '1', id: 'carbon-id', label: 'C' }, { ref: '2', id: 'bromine-id', label: 'Br' }];
  const bonds = [{ ref: '1', id: 'bond-id', begin: '1', end: '2' }];
  const receipt = {
    sessionId: 'doc1', revision: 5,
    created: [
      { id: 'sub', type: 'molecule.add', atoms, bonds, entityIds: ['carbon-id', 'bromine-id', 'bond-id'] },
      { id: 'attack', type: 'arrow.add', entityIds: ['arrow-id'], layout: { feasible: false } },
      { id: 'caption', type: 'text.add', nativeTextId: 0, entityIds: [], text: 'echoed-canvas-text' },
      { id: 'step', type: 'reactionArrow.add', reactionArrowId: '0', label: 'echoed-condition' },
    ],
    updated: [{ id: 'edit', type: 'atom.modify', atomId: 'carbon-id', after: { charge: 1 } }],
    deleted: [{ id: 'delete', type: 'atom.delete', atomIds: ['old-id'] }],
    cascaded: [{ id: 'delete', arrows: ['stale-arrow'] }],
    warnings: ['attack: no clear path', 'route '.repeat(100)],
    steps: [{ operationId: 'step', stepId: 'stable-step', version: 2, action: 'modify',
      before: { version: 1 }, after: { version: 2 },
      checks: { layout: { status: 'failed', issues: [{ code: 'overlap', message: 'overlap' }] }, chemistry: { status: 'pending', issues: [] } } }],
    stepMapping: { step: 'stable-step' },
    mapping: { 'old:1': 'previous-batch-id', 'sub:1': 'carbon-id', attack: 'arrow-id' },
    atomMapping: { 'old:1': 'previous-batch-id', 'sub:1': 'carbon-id' },
    bondMapping: { 'sub:bond:1': 'bond-id' },
    taskScope: { type: 'completeMechanism', notes: 'echoed-plan' },
    finishAccepted: false,
    finishRejected: 'missing product',
    finalChatReplyRequired: true,
    nextAction: 'Explain the result',
  };

  const compact = modelDrawReceipt(receipt);
  assert.deepEqual(compact.created[0], { id: 'sub', type: 'molecule.add', atoms, bonds });
  assert.deepEqual(compact.created[1], receipt.created[1]);
  assert.equal(compact.created[2].nativeTextId, 0);
  assert.equal(compact.created[3].reactionArrowId, '0');
  assert.deepEqual(compact.updated, receipt.updated);
  assert.deepEqual(compact.deleted, receipt.deleted);
  assert.deepEqual(compact.cascaded, receipt.cascaded);
  assert.equal(compact.finishRejected, 'missing product');
  assert.equal(compact.nextAction, 'Explain the result');
  assert.deepEqual(compact.steps, receipt.steps);
  assert.deepEqual(compact.stepMapping, receipt.stepMapping);
  assert.equal(compact.warnings[0], 'attack: no clear path');
  assert.equal(compact.warnings[1].length, 240);
  assert.match(compact.warnings[1], /…$/);
  assert.doesNotMatch(JSON.stringify(compact), /previous-batch-id|echoed-/);
  assert.equal(receipt.created[2].text, 'echoed-canvas-text');
});

test('only a draw validation error loses its duplicated argument payload in the transcript', () => {
  const error = 'Validation failed for tool "draw_operations":\n- operations.0.component: required';
  const echoed = error + '\n\nReceived arguments:\n{"operations":[{"id":"attack"}]}';
  const result = { role: 'toolResult', toolName: 'draw_operations', isError: true, content: [{ type: 'text', text: echoed }] };
  assert.equal(withoutEchoedDrawArguments(result).content[0].text, error);
  assert.equal(result.content[0].text, echoed);
  const readResult = { ...result, toolName: 'read_canvas' };
  assert.equal(withoutEchoedDrawArguments(readResult), readResult);
  const success = { ...result, isError: false };
  assert.equal(withoutEchoedDrawArguments(success), success);
});
