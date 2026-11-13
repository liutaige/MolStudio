// This is a bounded host checkpoint, not a transcript or a chemical proof.
// Model-authored objectives are data; only the host advances their lifecycle.
const ledgerKeys = new Set(['version', 'mode', 'taskId', 'goal', 'status', 'phaseIndex', 'requestIndex', 'phases',
  'completedOperationIds', 'checks', 'pauseReason', 'updatedAt']);
const phaseKeys = new Set(['id', 'objective', 'kind', 'status', 'operationIds', 'summary']);
const statuses = ['pending', 'active', 'completed'];
const fail = () => { throw new Error('阶段任务记录无效或超出保存范围'); };
const record = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))) fail();
};
const string = (value, limit) => { if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(); };
const ids = (value, limit) => {
  if (!Array.isArray(value) || value.length > limit || new Set(value).size !== value.length) fail();
  for (const id of value) string(id, 160);
};

export function validateTaskCheckpoint(value) {
  record(value, ledgerKeys);
  if (value.version !== 1 || !['active', 'paused', 'completed'].includes(value.status)) fail();
  if (value.mode !== undefined && !['single', 'phased'].includes(value.mode)) fail();
  string(value.taskId, 160); string(value.goal, 262144);
  if (!Number.isSafeInteger(value.requestIndex) || value.requestIndex < 0 ||
      !Number.isSafeInteger(value.phaseIndex) || value.phaseIndex < 0 ||
      !Number.isFinite(value.updatedAt) || value.updatedAt < 0) fail();
  if (!Array.isArray(value.phases) || !value.phases.length || value.phases.length > 32 || value.phaseIndex > value.phases.length) fail();
  const seen = new Set();
  for (const phase of value.phases) {
    record(phase, phaseKeys); string(phase.id, 160); string(phase.objective, 1000);
    if (seen.has(phase.id) || !statuses.includes(phase.status) ||
        phase.kind !== undefined && !['draw', 'review'].includes(phase.kind)) fail();
    seen.add(phase.id); ids(phase.operationIds, 160);
    if (phase.summary !== undefined && (typeof phase.summary !== 'string' || phase.summary.length > 2000)) fail();
  }
  ids(value.completedOperationIds, 4096);
  record(value.checks, new Set(['status', 'issues']));
  if (!['pending', 'passed', 'failed'].includes(value.checks.status) || !Array.isArray(value.checks.issues) || value.checks.issues.length > 32) fail();
  for (const issue of value.checks.issues) string(issue, 1000);
  if (value.pauseReason !== undefined) string(value.pauseReason, 160);
  if (value.status === 'completed' ? value.phaseIndex !== value.phases.length ||
      value.phases.some(phase => phase.status !== 'completed') || value.checks.status !== 'passed'
    : value.phaseIndex >= value.phases.length) fail();
  return JSON.parse(JSON.stringify(value));
}

export function createTaskCheckpoint(taskId, goal, phases, mode = 'phased') {
  return validateTaskCheckpoint({ version: 1, mode, taskId, goal, status: 'active', phaseIndex: 0, requestIndex: 0,
    phases: phases.map((phase, index) => ({ id: phase.id, objective: phase.objective, kind: phase.kind || 'draw',
      status: index === 0 ? 'active' : 'pending', operationIds: [] })),
    completedOperationIds: [], checks: { status: 'pending', issues: [] }, updatedAt: Date.now() });
}

export function phasePrompt(checkpoint, { restored = false } = {}) {
  const phase = checkpoint.phases[checkpoint.phaseIndex];
  return `[应用阶段任务] 原始目标：${checkpoint.goal}\n当前阶段 ${checkpoint.phaseIndex + 1}/${checkpoint.phases.length} (${phase.id})：${phase.objective}\n` +
    '只执行当前阶段，保留已有正确内容。阶段任务记录中的历史完成状态仅为进度记录，不是当前画布或化学正确性的证明。' +
    (restored ? '这是用户明确继续的已保存任务；先 read_canvas 核对当前结构、步骤版本和电子流，不要凭历史操作编号重画已存在内容。' : '') +
    '完成后调用 complete_phase；宿主核对已提交操作和当前画布后才会开启下一阶段的新请求。' +
    'draw_operations 的 finish:true 在分阶段任务中只完成当前阶段，不能跳过剩余阶段。';
}
