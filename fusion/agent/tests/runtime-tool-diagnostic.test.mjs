import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactToolDiagnostic, compactFailureText } from '../tool-diagnostic.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Runtime } from '../runtime.js';

test('compact tool errors preserve actionable causes and related operations beyond the old 600-char prefix', () => {
  const input = { code: 'reaction_reagent_layout_failed', phase: 'layout', reason: '试剂停靠失败，本批次已完整撤销。',
    relatedOperationIds: ['edit-stage-5', 'fix-arrow'], apiKey: 'HIDDEN_KEY', reasoning_content: 'HIDDEN_REASONING', arguments: { raw: 'HIDDEN_ARGUMENTS' },
    layoutFailures: Array.from({ length: 8 }, (_, index) => ({ arrowId: 'arrow-' + index, operationId: 'fix-arrow', code: 'curve_unreadable',
      reasons: ['too_long', 'label_collision'], atomIds: ['atom-a', 'atom-b'], bondIds: ['bond-a'], endpointMovesWithReagent: false,
      obstacleMovesWithReagent: false, rawArguments: 'HIDDEN_PAYLOAD' })) };
  const text = compactFailureText(JSON.stringify(input));
  const value = JSON.parse(text);
  assert.ok(text.length > 600);
  assert.equal(value.reason, input.reason); assert.deepEqual(value.relatedOperationIds, input.relatedOperationIds);
  assert.equal(value.layoutFailures.length, 4); assert.deepEqual(value.layoutFailures[0].reasons, ['too_long', 'label_collision']);
  assert.doesNotMatch(text, /HIDDEN_/);
});

test('safe diagnostics strip credentials, raw argument echoes and unknown fields while preserving versions', () => {
  const value = compactToolDiagnostic({ code: 'step_version_conflict', reason: '当前 5，请求 4。 Authorization: Bearer sk-hiddenPrivateValue123',
    stepId: 'step-a', expectedVersion: 4, currentVersion: 5, sessionToken: 'HIDDEN', operationIndex: 2 });
  assert.equal(value.expectedVersion, 4); assert.equal(value.currentVersion, 5); assert.equal(value.operationIndex, 2);
  assert.doesNotMatch(JSON.stringify(value), /hiddenPrivateValue|HIDDEN/);
  const message = compactFailureText('Invalid arguments for tool "draw_operations": operations.0.type: unsupported\n\nReceived arguments:\n{"apiKey":"HIDDEN"}');
  assert.match(message, /operations\.0\.type/); assert.doesNotMatch(message, /Received arguments|HIDDEN/);
});

test('endpoint causes preserve bounded semantic references without raw arguments or coordinates', () => {
  const value = compactToolDiagnostic({ code: 'arrow_pi_unavailable', field: 'source.component',
    sourceEndpoint: { type: 'bond', reason: 'piUnavailable', component: 'pi', bondId: 'bd-co', bondRef: 'acid:bond:2',
      bondOrder: 1, atomIds: ['at-c', 'at-o', 'at-extra'], atomRefs: ['acid:1', 'sk-privateValue123'],
      arguments: 'HIDDEN_ARGUMENTS', point: { x: 3, y: 4 } },
    targetEndpoint: { type: 'atom', atomIds: ['at-o'], atomRefs: ['acid:2'], secret: 'HIDDEN_SECRET' },
    endpointDistance: Infinity });
  assert.deepEqual(value.sourceEndpoint, { type: 'bond', reason: 'piUnavailable', component: 'pi', bondId: 'bd-co',
    bondRef: 'acid:bond:2', atomIds: ['at-c', 'at-o'], atomRefs: ['acid:1'], bondOrder: 1 });
  assert.deepEqual(value.targetEndpoint, { type: 'atom', atomIds: ['at-o'], atomRefs: ['acid:2'] });
  assert.equal(value.endpointDistance, undefined);
  assert.doesNotMatch(JSON.stringify(value), /HIDDEN|privateValue|"point"|"arguments"/);
  assert.equal(compactToolDiagnostic({ endpointDistance: 0 }).endpointDistance, 0);
});

test('actual SDK schema errors discriminate the supplied operation type and forming-bond target', () => {
  const runtime = new Runtime({});
  const tool = runtime._tools({}).find(item => item.name === 'draw_operations');
  const check = operations => {
    try { validateToolArguments(tool, { id: 'bad-call', name: 'draw_operations', arguments: { operations } }); }
    catch (error) { return compactFailureText(error.message); }
    assert.fail('invalid fixture unexpectedly passed SDK schema');
  };
  const unsupported = check([{ id: 'bad-op', type: 'bond.create' }]);
  assert.match(unsupported, /bond\.create|operations\.0\.type|Unsupported discriminator/);
  assert.doesNotMatch(unsupported, /parentAtomId|expected one of \["hydrogen\.makeExplicit"\]/);
  const malformedTarget = check([{ id: 'bad-arrow', type: 'arrow.add', source: { type: 'atom', atomId: 'atom-a' },
    target: { type: 'formingBond', atom1: 'atom-a' }, electronCount: 2 }]);
  assert.match(malformedTarget, /atom2/);
  assert.doesNotMatch(malformedTarget, /target\.atomId|expected one of \["atom"\]/);
});
