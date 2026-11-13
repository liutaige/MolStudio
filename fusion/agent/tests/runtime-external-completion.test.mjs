import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';

const clone = value => structuredClone(value);
const molecule = id => ({ id, type: 'molecule.add', smiles: '[CH4:1]' });
const layoutTask = '只整理当前画布，保持所有对象身份和化学连接，不增加、删除或改写任何化学对象。';

function fixture() {
  const h = { events: [], mutations: [], saves: [], checkpoint: null, rejectCompletionSave: false,
    canvas: { sessionId: 'external-completion', revision: 0,
      atoms: [{ id: 'existing', label: 'C', implicitH: 4, charge: 0, radical: 0, x: 0, y: 0 }],
      bonds: [], molecules: [{ id: 'mol:1', atoms: ['existing'] }],
      lonePairs: [], arrows: [], reactionSteps: [], reactionArrows: [], texts: [] } };
  const bridge = {
    async getContext() { return clone(h.canvas); },
    async beginRun() { return { sessionId: h.canvas.sessionId, context: clone(h.canvas) }; },
    async endRun() { h.ended = (h.ended || 0) + 1; },
    async clearPreview() {},
    async inspectStructures(items) { return items.map(item => ({ id: item.id, ok: true, atoms: [], bonds: [] })); },
    async getTaskCheckpoint() { return clone(h.checkpoint); },
    async setTaskCheckpoint(_runId, checkpoint) {
      h.saves.push(clone(checkpoint));
      if (h.rejectCompletionSave && checkpoint.status === 'completed') throw new Error('checkpoint storage unavailable');
      h.checkpoint = clone(checkpoint); return clone(checkpoint);
    },
    async applyOperations(operations) {
      h.mutations.push(clone(operations));
      const created = [], updated = [];
      for (const operation of operations) {
        if (operation.type === 'molecule.add') {
          const atom = { id: 'atom-' + operation.id, ref: '1', label: 'C', implicitH: 4, charge: 0, radical: 0, x: 0, y: 0 };
          h.canvas.atoms.push(atom);
          h.canvas.molecules.push({ id: 'mol:' + (h.canvas.molecules.length + 1), atoms: [atom.id] });
          created.push({ id: operation.id, type: operation.type, atoms: [atom] });
        } else {
          if (operation.type === 'layout.tidy') for (const atom of h.canvas.atoms) atom.x += 1;
          updated.push({ id: operation.id, type: operation.type });
        }
      }
      h.canvas.revision++;
      return { created, updated, deleted: [], cascaded: [], warnings: [], steps: [], summary: 'committed' };
    },
  };
  h.runtime = new Runtime({ bridge, eventTarget: new EventTarget(), onEvent: event => h.events.push(event) });
  const check = h.runtime._checkMechanismCompletion.bind(h.runtime);
  h.runtime._checkMechanismCompletion = run => h.completionIssue ? Promise.resolve(h.completionIssue) : check(run);
  h.call = async (name, args = {}) => h.runtime.executeExternalTool(name, args, { clientName: 'External completion test' });
  h.draw = (id, extra = {}) => h.call('draw_operations', { operations: [molecule(id)], taskScope: { type: 'singleMolecule' }, finish: true, ...extra });
  return h;
}

test('accepted external single completion is persisted before success and survives read-only verification', async () => {
  const h = fixture(), result = await h.draw('first');
  assert.equal(result.isError, false); assert.equal(JSON.parse(result.text).finishAccepted, true);
  assert.equal(h.checkpoint.status, 'completed');
  assert.equal(h.checkpoint.phaseIndex, 1); assert.equal(h.checkpoint.phases[0].status, 'completed');
  assert.deepEqual(h.checkpoint.checks, { status: 'passed', issues: [] });
  assert.deepEqual(h.checkpoint.completedOperationIds, ['first']);
  const completed = h.events.findIndex(event => event.type === 'task_checkpoint' && event.checkpoint?.status === 'completed');
  const successfulTool = h.events.findIndex(event => event.type === 'tool_end' && event.toolName === 'draw_operations' && !event.isError);
  assert.ok(completed >= 0 && completed < successfulTool);
  const taskId = h.checkpoint.taskId, runId = h.runtime._externalRun.id;
  await h.call('read_canvas');
  assert.equal((await h.call('inspect_structures', { structures: [{ id: 'preview', smiles: '[CH4:1]' }] })).isError, false);
  assert.equal(h.checkpoint.taskId, taskId); assert.equal(h.checkpoint.status, 'completed');
  assert.equal(h.runtime._externalRun.id, runId); assert.equal(h.runtime._externalRun.finishRequested, true);
  assert.equal(h.runtime.isRunning, false);
  assert.ok(h.events.some(event => event.type === 'external_idle' && event.toolName === 'read_canvas' && event.taskCompleted));
});

test('an identical completed draw retry retains aliases and does not repeat a committed batch or create a task', async () => {
  const h = fixture(); await h.draw('first');
  const taskId = h.checkpoint.taskId, runId = h.runtime._externalRun.id;
  const retry = await h.draw('first');
  assert.equal(retry.isError, false); assert.equal(JSON.parse(retry.text).finishAccepted, true);
  assert.equal(h.mutations.length, 1); assert.equal(h.checkpoint.taskId, taskId);
  assert.equal(h.runtime._externalRun.id, runId); assert.ok(h.runtime._externalRun.applied.has('first'));
  assert.equal(h.checkpoint.status, 'completed');
});

test('new edits and new plans use a fresh ledger while the external session preserves prior idempotency records', async () => {
  const h = fixture(); await h.draw('first');
  const firstTaskId = h.checkpoint.taskId, runId = h.runtime._externalRun.id;
  await h.draw('second');
  assert.notEqual(h.checkpoint.taskId, firstTaskId);
  assert.deepEqual(h.checkpoint.completedOperationIds, ['second']);
  const secondTaskId = h.checkpoint.taskId;
  const planned = await h.call('plan_task', { task: '下一项绘图任务', phases: [{ id: 'third', objective: '画第三个分子', kind: 'draw' }] });
  assert.equal(planned.isError, false); assert.notEqual(h.checkpoint.taskId, secondTaskId);
  assert.equal(h.checkpoint.mode, 'phased'); assert.equal(h.checkpoint.status, 'active');
  const third = await h.draw('third');
  assert.equal(JSON.parse(third.text).phase.taskCompleted, true);
  assert.deepEqual(h.checkpoint.completedOperationIds, ['third']);
  assert.equal(h.runtime._externalRun.id, runId);
  assert.deepEqual([...h.runtime._externalRun.applied.keys()], ['first', 'second', 'third']);
  assert.equal(h.ended || 0, 0, 'task completion must not discard the live MCP alias session');
});

test('rejected finish stays active and correction retries only uncommitted work', async () => {
  const h = fixture(); h.completionIssue = { message: '步骤仍缺少电子流' };
  const rejected = await h.draw('first');
  assert.equal(rejected.isError, false); assert.equal(JSON.parse(rejected.text).finishAccepted, false);
  assert.equal(h.checkpoint.status, 'active'); assert.equal(h.checkpoint.phaseIndex, 0);
  assert.equal(h.events.some(event => event.type === 'external_idle' && event.taskCompleted), false);
  h.completionIssue = null;
  const corrected = await h.draw('first');
  assert.equal(JSON.parse(corrected.text).finishAccepted, true);
  assert.equal(h.mutations.length, 1); assert.equal(h.checkpoint.status, 'completed');
});

test('an external phase finish completes only the current phase until the final phase passes', async () => {
  const h = fixture();
  await h.call('plan_task', { phases: [{ id: 'one', objective: '第一步' }, { id: 'two', objective: '第二步' }] });
  const first = JSON.parse((await h.draw('first')).text);
  assert.equal(first.finishAccepted, true); assert.equal(first.phase.taskCompleted, false);
  assert.equal(h.checkpoint.status, 'active'); assert.equal(h.checkpoint.phaseIndex, 1);
  assert.equal(h.events.filter(event => event.type === 'external_idle').at(-1).taskCompleted, false);
  await h.call('read_canvas');
  const last = JSON.parse((await h.draw('second')).text);
  assert.equal(last.phase.taskCompleted, true); assert.equal(h.checkpoint.status, 'completed');
  const taskId = h.checkpoint.taskId;
  await h.call('read_canvas');
  assert.equal(h.checkpoint.taskId, taskId); assert.equal(h.checkpoint.status, 'completed');
});

test('completion persistence failure is an error and a same-ID retry saves completion without redrawing', async () => {
  const h = fixture(); h.rejectCompletionSave = true;
  const failed = await h.draw('first');
  assert.equal(failed.isError, true); assert.equal(failed.diagnostic.code, 'task_completion_persist_failed');
  assert.match(failed.text, /已提交.*未能保存/);
  assert.equal(h.checkpoint.status, 'active'); assert.equal(h.runtime._externalRun.checkpoint.status, 'active');
  assert.equal(h.runtime._externalRun.finishRequested, false); assert.equal(h.mutations.length, 1);
  assert.equal(h.events.some(event => event.type === 'external_idle' && event.taskCompleted), false);
  h.rejectCompletionSave = false;
  const retried = await h.draw('first');
  assert.equal(retried.isError, false); assert.equal(JSON.parse(retried.text).finishAccepted, true);
  assert.equal(h.checkpoint.status, 'completed'); assert.equal(h.mutations.length, 1);
});

test('external complete_layout persists its single-task completion and read-only inspection preserves it', async () => {
  const h = fixture();
  await h.call('draw_operations', { task: layoutTask, operations: [{ id: 'tidy', type: 'layout.tidy' }] });
  const completed = await h.call('complete_layout');
  assert.equal(completed.isError, false); assert.equal(JSON.parse(completed.text).finishAccepted, true);
  assert.equal(h.checkpoint.status, 'completed'); assert.equal(h.mutations.length, 1);
  await h.call('read_canvas');
  assert.equal(h.checkpoint.status, 'completed'); assert.equal(h.runtime._externalRun.finishRequested, true);
});

test('layout completion persistence failure remains retryable without another layout mutation', async () => {
  const h = fixture();
  await h.call('draw_operations', { task: layoutTask, operations: [{ id: 'tidy', type: 'layout.tidy' }] });
  h.rejectCompletionSave = true;
  const failed = await h.call('complete_layout');
  assert.equal(failed.isError, true); assert.equal(h.checkpoint.status, 'active');
  assert.equal(h.runtime._externalRun.finishRequested, false);
  h.rejectCompletionSave = false;
  assert.equal((await h.call('complete_layout')).isError, false);
  assert.equal(h.checkpoint.status, 'completed'); assert.equal(h.mutations.length, 1);
});
