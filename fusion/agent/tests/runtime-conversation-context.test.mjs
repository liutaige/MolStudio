import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConversation } from '../conversation-context.js';

const system = { role: 'system', content: 'Rules\n\nCurrent canvas context (JSON):\n{"revision":0}', toolsAdded: [{ name: 'read_canvas' }] };
const user = (text, timestamp = 1) => ({ role: 'user', content: text, timestamp });
const exchange = (id, text, timestamp = 2, name = 'read_canvas') => [
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic large thought' },
    { type: 'toolCall', id, name, arguments: {} }], stopReason: 'toolUse', timestamp },
  { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], timestamp },
];

test('all original user constraints and corrections survive bounded tool history without a model fact summary', () => {
  const messages = [system, user('original constraint'), ...exchange('old', 'old-canvas'.repeat(10000)),
    user('correction supersedes earlier interpretation'), ...exchange('middle', 'middle'), ...exchange('latest', 'last'), user('current task')];
  const saved = structuredClone(messages);
  const result = boundedConversation(messages, { canvas: { revision: 10, atoms: [{ id: 'live' }] } });
  assert.deepEqual(result.messages.filter(m => m.role === 'user'), messages.filter(m => m.role === 'user'));
  assert.equal(result.messages.filter(m => m.role === 'toolResult').length, 2);
  assert.ok(!JSON.stringify(result.messages).includes('old-canvas'));
  assert.ok(result.metrics.outputBytes < result.metrics.inputBytes / 10);
  assert.ok(result.messages[0].content.includes('"revision":10'));
  assert.deepEqual(result.messages[0].toolsAdded, system.toolsAdded);
  assert.deepEqual(messages, saved, 'request compaction does not rewrite UI history');
});

test('active multiple-tool exchanges keep complete calls/results and reject orphan or truncated calls', () => {
  const one = exchange('one', 'result');
  one[0].content.push({ type: 'toolCall', id: 'two', name: 'inspect_structures', arguments: { structures: [] } });
  const second = { ...one[1], toolCallId: 'two', toolName: 'inspect_structures' };
  const partial = exchange('cut', 'not-confirmed'); partial[0].stopReason = 'aborted';
  const orphan = { ...second, toolCallId: 'no-call' };
  const output = boundedConversation([system, user('task'), ...one, second, ...partial, orphan], { canvas: {} }).messages;
  assert.deepEqual(output.filter(m => m.role === 'toolResult').map(m => m.toolCallId), ['one', 'two']);
  assert.equal(output.find(m => m.role === 'assistant').content.length, 3, 'active reasoning and both exact tool calls remain paired');
});

test('only confirmed live current-run aliases survive, with native resume aliases intact', () => {
  const receipt = id => JSON.stringify({ created: [{ id, type: 'molecule.add', atoms: [{ id: 'live', ref: '1' }, { id: 'gone', ref: '2' }] }] });
  const failed = exchange('failed', receipt('bad'), 20, 'draw_operations'); failed[1].isError = true;
  const messages = [system, user('task'), ...exchange('past', receipt('past'), 1, 'draw_operations'),
    ...failed, ...exchange('current', receipt('current'), 20, 'draw_operations')];
  const result = boundedConversation(messages, { canvas: { atoms: [{ id: 'live' }] }, activeSince: 10, resumeAliases: { atom: { old: 'live' } } });
  const current = JSON.parse(result.messages[0].content.split('Current canvas context (JSON):\n')[1]);
  assert.deepEqual(current.activeOperationAliases, [{ id: 'current', type: 'molecule.add', atoms: [{ id: 'live', ref: '1' }] }]);
  assert.deepEqual(current.resumeAliases, { atom: { old: 'live' } });
});

test('known canvas snapshots are replaced by versioned references while unknown observations and receipts survive', () => {
  const snapshot = { sessionId: 'doc', revision: 1, atoms: [{ id: 'old', alias: 'snapshot'.repeat(10000) }], selection: { atoms: ['old'] } };
  const read = exchange('read', JSON.stringify(snapshot));
  const receipt = { created: [{ id: 'lp', entityIds: ['live-lp'] }], updated: [{ id: 'edit', bondLengthBefore: 1, bondLengthAfter: 1 }],
    status: 'applied', canvas: snapshot };
  const draw = exchange('draw', JSON.stringify(receipt), 20, 'draw_operations');
  const result = boundedConversation([system, user('keep constraint'), ...read, ...draw], {
    canvas: { sessionId: 'doc', revision: 2, atoms: [{ id: 'live' }], lonePairs: [{ id: 'live-lp' }] }, activeSince: 10,
  });
  const results = result.messages.filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text));
  assert.equal(results[0].revision, 1);
  assert.equal(results[0].currentCanvas.revision, 2);
  assert.deepEqual(results[0].counts, { atoms: 1 });
  assert.deepEqual(results[0].selection, { atoms: ['old'] });
  assert.deepEqual(results[1].created, receipt.created);
  assert.deepEqual(results[1].updated, receipt.updated);
  assert.equal(results[1].status, 'applied');
  assert.equal(results[1].canvas.snapshotOmitted, true);
  assert.equal(result.metrics.omittedSnapshots, 2);
  assert.ok(result.metrics.outputBytes < 5000);
  const unknown = exchange('unknown', JSON.stringify(snapshot), 20, 'inspect_structures');
  assert.equal(boundedConversation([system, ...unknown], { canvas: {} }).messages.at(-1).content[0].text, unknown[1].content[0].text);
});
