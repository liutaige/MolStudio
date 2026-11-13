'use strict';
// Main canvas .molwork extension: bounded task metadata, never auto-execution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-model.js');
require('../workbench/workbench-storage.js');
const { storage, model } = globalThis.MolWorkbench;

function task() {
  return { version: 1, taskId: 'task:1', goal: 'Complete the requested mechanism', status: 'paused',
    phaseIndex: 1, requestIndex: 3, phases: [
      { id: 'first', objective: 'Create the first elementary step', kind: 'draw', status: 'completed', operationIds: ['op:1'], summary: 'Committed' },
      { id: 'review', objective: 'Review actual structures and electron flow', kind: 'review', status: 'active', operationIds: [] }
    ], completedOperationIds: ['op:1'], checks: { status: 'pending', issues: [] }, pauseReason: 'user', updatedAt: 1 };
}
function file(agentTask) {
  if (!arguments.length) agentTask = task();
  return { ket: { root: { nodes: [] } }, bindings: { atoms: [], bonds: [] }, mechanism: model.emptyState(), agentTask };
}
test('task checkpoint round-trips exactly in .molwork and returned values are isolated', () => {
  const input = file(), text = storage.serializeWorkbench(input), result = storage.parseWorkbench(text);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.doc.agentTask, input.agentTask);
  assert.equal(storage.serializeWorkbench(result.doc), text);
  result.doc.agentTask.phases[0].objective = 'changed';
  assert.equal(input.agentTask.phases[0].objective, 'Create the first elementary step');
});
test('legacy and null checkpoints preserve the original no-task representation', () => {
  for (const agentTask of [null, undefined]) {
    const text = storage.serializeWorkbench(file(agentTask));
    const parsed = storage.parseWorkbench(text);
    assert.equal(parsed.ok, true);
    assert.equal(Object.hasOwn(parsed.doc, 'agentTask'), false);
    assert.equal(JSON.parse(text).agentTask, undefined);
  }
});
test('completed checkpoint requires real terminal status shape', () => {
  const valid = task(); valid.status = 'completed'; valid.phaseIndex = valid.phases.length;
  valid.phases.forEach(phase => { phase.status = 'completed'; }); valid.checks.status = 'passed';
  assert.deepEqual(storage.validateAgentTask(valid), valid);
  for (const mutate of [t => { t.checks.status = 'pending'; }, t => { t.phases[1].status = 'active'; }]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => storage.validateAgentTask(invalid));
  }
});
test('malformed or credential-bearing checkpoints reject save and load atomically', () => {
  const mutations = [
    t => { t.apiKey = 'should-not-be-stored'; }, t => { t.version = 2; }, t => { t.taskId = ''; },
    t => { t.goal = 'x'.repeat(262145); }, t => { t.requestIndex = -1; }, t => { t.phaseIndex = 2; },
    t => { t.status = 'running'; }, t => { t.updatedAt = Infinity; }, t => { t.phases = []; },
    t => { t.phases.push(structuredClone(t.phases[0])); },
    t => { t.phases[0].kind = 'shell'; }, t => { t.phases[0].reasoning = 'not task data'; },
    t => { t.phases[0].operationIds = ['duplicate', 'duplicate']; },
    t => { t.completedOperationIds = Array(4097).fill('a'); },
    t => { t.checks.issues = ['']; }, t => { t.checks.extra = true; }, t => { t.pauseReason = ''; }
  ];
  const original = storage.serializeWorkbench(file());
  for (const mutate of mutations) {
    const invalid = task(); mutate(invalid);
    assert.throws(() => storage.serializeWorkbench(file(invalid)));
    const document = JSON.parse(original); document.agentTask = invalid;
    const parsed = storage.parseWorkbench(JSON.stringify(document));
    assert.equal(parsed.ok, false); assert.equal(parsed.code, 'invalid');
    assert.equal(storage.serializeWorkbench(file()), original);
  }
});
test('checkpoint bounds permit 32 distinct phases and reject extra phases', () => {
  const value = task(); value.phaseIndex = 0;
  value.phases = Array.from({ length: 32 }, (_, i) => ({ id: 'phase:' + i, objective: 'Draw stage ' + i,
    status: i ? 'pending' : 'active', operationIds: [] }));
  assert.equal(storage.validateAgentTask(value).phases.length, 32);
  value.phases.push({ id: 'phase:32', objective: 'Extra', status: 'pending', operationIds: [] });
  assert.throws(() => storage.validateAgentTask(value));
});
