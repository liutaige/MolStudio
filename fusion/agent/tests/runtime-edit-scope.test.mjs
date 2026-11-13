/* 完成门用可控 SSE 验证：依据本次提交影响的画布实体核对完整机理。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime.js';
import { OperationStreamDecoder } from '../stream-operations.js';

const config = { configured: true, sessionToken: 'local-test-token', provider: 'openai-compatible', model: 'glm-5.3-flash', baseUrl: 'https://upstream.invalid/v1', maxTurns: 24 };

function sse(deltas, { finishReason } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const chunks = deltas.map((delta, index) => ({ id: 'chat-test', object: 'chat.completion.chunk', model: config.model, created: 0,
    choices: [{ index: 0, delta: { ...delta }, finish_reason: index === deltas.length - 1 ? (finishReason || (delta._toolFinish ? 'tool_calls' : 'stop')) : null }] }));
  for (const chunk of chunks) delete chunk.choices[0].delta._toolFinish;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunks[i++]) + '\n\n'));
      else if (i++ === chunks.length) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      else controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function tool(name, input, callId = 'call1') {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const midpoint = Math.floor(raw.length / 2);
  return [
    { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: raw.slice(0, midpoint) } }] },
    { tool_calls: [{ index: 0, function: { arguments: raw.slice(midpoint) } }] },
    { _toolFinish: true },
  ];
}

function harness(responses, options = {}) {
  const events = [], applied = [], requests = [];
  const live = { sessionId: 'doc1', revision: 1, atoms: [], bonds: [], molecules: [],
    lonePairs: [], arrows: [], reactionArrows: [], selection: { atoms: [], bonds: [] }, ...structuredClone(options.canvas) };
  const bridge = {
    async getContext() { return structuredClone(live); },
    async applyOperations(ops, info) {
      applied.push({ ops, info });
      const created = ops.map(op => {
        const entry = { id: op.id, type: op.type };
        if (op.type === 'molecule.add') {
          // The mechanism fixtures here use isolated atoms and two-atom single bonds.
          const mapped = [...op.smiles.matchAll(/\[([A-Z][a-z]?)(H\d*)?([+-]\d*)?:(\d+)\]/g)];
          const records = (mapped.length ? mapped : [[null, op.smiles.match(/[A-Z][a-z]?/)?.[0], null, null, '1']])
            .map(([, label, h, charge, ref]) => ({ id: op.id + ':' + ref, ref, label,
              implicitH: h ? Number(h.slice(1) || 1) : 0,
              charge: charge ? Number(charge + (charge.length === 1 ? '1' : '')) : 0 }));
          const atoms = records.map(record => record.id);
          live.molecules.push({ id: op.id, atoms });
          for (const { ref, ...atom } of records) {
            const index = live.atoms.findIndex(item => item.id === atom.id);
            if (index < 0) live.atoms.push(atom);
            else live.atoms[index] = { ...atom, ...live.atoms[index] };
          }
          if (atoms.length > 1) live.bonds.push({ id: op.id + ':bond:1', begin: atoms[0], end: atoms[1], order: 1 });
          entry.atoms = records.map(({ id, ref, label }) => ({ id, ref, label }));
        } else if (op.type === 'lonePair.add') {
          live.lonePairs.push({ id: op.id, ownerAtomId: op.atom });
        } else if (op.type === 'arrow.add') {
          const source = op.source.type === 'lonePair'
            ? { type: 'lonePair', slotId: op.source.id, ownerAtomId: live.lonePairs.find(pair => pair.id === op.source.id)?.ownerAtomId }
            : op.source;
          const target = op.target.type === 'formingBond'
            ? { type: 'formingBond', atomA: op.target.atom1, atomB: op.target.atom2 } : op.target;
          live.arrows.push({ id: op.id, source, target, electronCount: op.electronCount });
          entry.entityIds = [op.id];
        } else if (op.type === 'reactionArrow.add') {
          const reactionArrowId = String(live.reactionArrows.length);
          live.reactionArrows.push({ id: reactionArrowId, reactants: op.reactants, products: op.products });
          entry.reactionArrowId = reactionArrowId;
        }
        return entry;
      });
      return { created, updated: [], deleted: [], cascaded: [], warnings: [], summary: 'applied' };
    },
    async previewOperations() {},
    async clearPreview() {},
    async beginRun() {},
    async endRun() {},
    ...options.bridge,
  };
  const fetch = async (url, init) => {
    if (url === '/api/agent/cancel') return new Response('{}');
    assert.equal(url, '/api/agent/model');
    const body = JSON.parse(init.body); requests.push(body);
    const next = responses[requests.length - 1] || textEnd;
    return typeof next === 'function' ? next(init) : sse(next);
  };
  const runtime = new Runtime({ bridge, fetch, getConfig: async () => ({ ...config, ...options.config }),
    onEvent: event => events.push(event), eventTarget: new EventTarget() });
  return { runtime, bridge, events, applied, requests, live };
}

const reactantsOnly = {
  operations: [
    { id: 'nuc', type: 'molecule.add', smiles: '[OH-:1]' },
    { id: 'sub', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
    { id: 'lp', type: 'lonePair.add', atom: 'nuc:1' },
    { id: 'attack', type: 'arrow.add', source: { type: 'lonePair', id: 'lp' }, target: { type: 'atom', atomId: 'sub:1' }, electronCount: 2 },
    { id: 'leave', type: 'arrow.add', source: { type: 'bond', bondId: 'sub:bond:1', component: 'sigma' }, target: { type: 'atom', atomId: 'sub:2' }, electronCount: 2 },
  ],
  taskScope: { type: 'completeMechanism' },
  finish: true,
};
const productsAndConnector = [
  { id: 'prod', type: 'molecule.add', smiles: '[CH3:1][OH:2]' },
  { id: 'bromide', type: 'molecule.add', smiles: '[Br-:1]' },
  { id: 'step', type: 'reactionArrow.add', reactants: ['nuc:1', 'sub:1'], products: ['prod:1', 'bromide:1'] },
];
const sn2Structures = [...reactantsOnly.operations.slice(0, 3), ...productsAndConnector];
const [attack, leave] = reactantsOnly.operations.slice(3);
const fullSn2 = '画出氢氧根与溴甲烷反应的完整 SN2 机理，包含产物。';
const textEnd = [{ role: 'assistant', content: '已经完成。' }];

function readToolReceipt(request) {
  const message = request.messages.findLast(item => item.role === 'tool');
  assert.ok(message, '模型收到绘图工具回执');
  return JSON.parse(message.content);
}

test('绘图请求可以用纯文字回复，读取画布或写计划也不算绘图', async () => {
  const reply = '可以先确定起始原料，再核对需要展示的步骤。';
  const answer = [{ role: 'assistant', content: reply }];
  for (const [prompt, before] of [
    ['画咖啡因合成机理', []],
    ['画完整机理', []],
    ['只画路线图。', [tool('read_canvas', {})]],
    ['只画第一步。', [tool('write_plan', { steps: [{ id: 'first', text: '核对反应物', status: 'pending' }] })]],
  ]) {
    const h = harness([...before, answer]);
    const result = await h.runtime.run(prompt);
    assert.equal(result.status, 'completed', prompt);
    assert.equal(result.canContinue, false, prompt);
    assert.equal(h.requests.length, before.length + 1, prompt);
    assert.equal(h.applied.length, 0, prompt);
    assert.equal(h.events.filter(event => event.type === 'tool_end' && !event.isError).length, before.length, prompt);
    assert.equal(h.events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), reply);
    assert.equal(h.events.some(event => event.code === 'MECHANISM_INCOMPLETE'), false, prompt);
  }
});

test('上一轮已画的未完整机理，不会让本轮的纯文字续跑报错', async () => {
  const h = harness([
    tool('draw_operations', { operations: [...sn2Structures, attack], finish: true }),
    textEnd,
    [{ role: 'assistant', content: '我需要先确认这一步的条件。' }],
  ]);
  assert.equal((await h.runtime.run('画机理')).status, 'needs_continue');
  assert.ok(h.events.some(event => event.code === 'MECHANISM_INCOMPLETE'));
  const previousEventCount = h.events.length;
  const result = await h.runtime.continue();
  assert.equal(result.status, 'completed');
  assert.equal(result.canContinue, false);
  assert.equal(h.requests.length, 3);
  assert.equal(h.applied.length, 1);
  assert.equal(h.events.slice(previousEventCount).some(event => event.code === 'MECHANISM_INCOMPLETE'), false);
});

test('声明的产物操作尚未提交时，completeMechanism 的 finish:true 被拒绝且任务继续', async () => {
  const taskScope = { type: 'completeMechanism', stages: [{ label: '产物', operationIds: ['prod'] }] };
  const h = harness([
    tool('draw_operations', { ...reactantsOnly, taskScope }),
    tool('draw_operations', { operations: productsAndConnector, taskScope, finish: true }, 'call2'),
  ]);
  const result = await h.runtime.run(fullSn2);
  assert.equal(result.status, 'completed');
  assert.equal(h.applied.length, 2, '第二批必须真的执行（产物补画）');
  assert.ok(h.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('仍有计划内的画布操作未提交：prod')));
});

test('画布仅一个分子且声明完整机理 → finish 被拒绝并给出继续方向', async () => {
  const h = harness([
    tool('draw_operations', {
      operations: [{ id: 'ethanol', type: 'molecule.add', smiles: 'CCO' }],
      taskScope: { type: 'completeMechanism' }, finish: true,
    }, 'call1'),
    [{ role: 'assistant', content: '我还需要画出缺失的反应组分。' }],
  ]);
  const result = await h.runtime.run('画出完整机理');
  assert.equal(result.status, 'needs_continue');
  assert.equal(h.events.some(event => event.type === 'run_end' && event.reason === 'mechanism_incomplete'), true);
});

test('分子和编辑任务仍可完成，模型报告 partialStep 也不会把结构任务变成机理', async () => {
  for (const [scope, prompt] of [['partialStep', '画出乙醇的结构式'], ['singleMolecule', '画一个乙醇分子'], ['edit', '把一个乙醇分子加到画布上']]) {
    const h = harness([tool('draw_operations', {
      operations: [{ id: 'x', type: 'molecule.add', smiles: 'CO' }],
      taskScope: { type: scope }, finish: true,
    })]);
    await h.runtime.run(prompt);
    assert.equal(h.events.some(event => event.type === 'run_end' && event.status === 'completed'), true, scope);
  }
});

test('自然收尾或漏报、误报任务范围都不能把只画反应物的完整请求判为完成', async () => {
  for (const [finish, taskScope] of [
    [false, { type: 'completeMechanism' }], [false, undefined], [true, undefined],
    [true, { type: 'partialStep' }], [true, { type: 'completeMechanism' }],
  ]) {
    const h = harness([
      tool('draw_operations', { operations: reactantsOnly.operations.slice(0, 2), taskScope, finish }),
      textEnd,
    ]);
    const result = await h.runtime.run(fullSn2);
    assert.equal(result.status, 'needs_continue');
    assert.equal(result.canContinue, true);
    assert.equal(h.applied.length, 1, '已提交的反应物仍然保留');
    assert.ok(h.events.some(event => event.type === 'run_end' && event.reason === 'mechanism_incomplete'));
  }
});

test('完整 SN2 的真实产物连接和电子流通过一轮完成核对', async () => {
  const h = harness([tool('draw_operations', {
    operations: [...reactantsOnly.operations, ...productsAndConnector], finish: true,
  })]);
  const result = await h.runtime.run(fullSn2);
  assert.equal(result.status, 'completed');
  assert.equal(h.requests.length, 1);
});

test('“画机理”和“画完整机理”都拒绝只有结构路线，后续只补弯箭头即可完成', async () => {
  for (const prompt of ['画机理', '画完整机理']) {
    const h = harness([
      tool('draw_operations', { operations: sn2Structures, finish: true }),
      tool('draw_operations', { operations: [attack, leave], finish: true }, 'repair'),
    ]);
    assert.equal((await h.runtime.run(prompt)).status, 'completed', prompt);
    assert.equal(h.requests.length, 2, prompt);
    const receipt = readToolReceipt(h.requests[1]);
    assert.equal(receipt.finishAccepted, false);
    assert.match(receipt.finishRejected, /缺少.*(?:电子流|弯箭头)/);
    assert.deepEqual(h.applied[1].ops.map(op => op.id), ['attack', 'leave']);
    assert.equal(h.live.molecules.length, 4);
    assert.equal(h.live.reactionArrows.length, 1);
    assert.equal(h.live.arrows.length, 2);
  }
});

test('同一回执列出多个缺电子流的步骤、条件及真实结构引用', async () => {
  const operations = [...sn2Structures.filter(op => op.id !== 'step'),
    { ...productsAndConnector.at(-1), layout: { conditions: 'NaOEt' } },
    { id: 'next-reactant', type: 'molecule.add', smiles: '[NH3:1]' },
    { id: 'next-product', type: 'molecule.add', smiles: '[NH4+:1]' },
    { id: 'next-step', type: 'reactionArrow.add', reactants: ['next-reactant:1'], products: ['next-product:1'] },
  ];
  const h = harness([tool('draw_operations', { operations, finish: true }), textEnd]);
  assert.equal((await h.runtime.run('画机理')).status, 'needs_continue');
  const receipt = readToolReceipt(h.requests[1]);
  assert.match(receipt.finishRejected, /0（NaOEt）、1 缺少电子流弯箭头/);
  assert.deepEqual(receipt.missingElectronFlowSteps, [
    { connectorId: '0', operationId: 'step', conditions: 'NaOEt', reactants: ['nuc:1', 'sub:1'], products: ['prod:1', 'bromide:1'] },
    { connectorId: '1', operationId: 'next-step', reactants: ['next-reactant:1'], products: ['next-product:1'] },
  ]);
});

test('验收指出具体失去产物引用的步骤并保留其他步骤', async () => {
  const operations = [...sn2Structures.filter(op => op.id !== 'step'), attack, leave,
    { ...productsAndConnector.at(-1), layout: { conditions: 'SN2' } },
  ];
  const h = harness([tool('draw_operations', { operations, finish: true }), textEnd]);
  const apply = h.bridge.applyOperations;
  h.bridge.applyOperations = async (ops, info) => {
    const result = await apply(ops, info);
    h.live.reactionArrows[0].products = [];
    return result;
  };
  assert.equal((await h.runtime.run(fullSn2)).status, 'needs_continue');
  const receipt = readToolReceipt(h.requests[1]);
  assert.match(receipt.finishRejected, /反应步骤 0（SN2） 产物引用缺失/);
  assert.deepEqual(receipt.invalidReactionSteps, [{
    connectorId: '0', operationId: 'step', conditions: 'SN2',
    reactants: ['nuc:1', 'sub:1'], products: ['prod:1', 'bromide:1'], missing: ['products'],
  }]);
  assert.equal(h.live.arrows.length, 2);
});

test('SN2 缺哪根弯箭头就补哪根，只有一根弯箭头不能完成', async () => {
  for (const [prompt, existing, missing, diagnosis] of [
    ['画机理', attack, leave, /缺少降低键级的电子流/],
    ['画完整机理', leave, attack, /缺少提高键级的电子流/],
    ['只画第一步。', attack, leave, /缺少降低键级的电子流/],
  ]) {
    const h = harness([
      tool('draw_operations', { operations: [...sn2Structures, existing], taskScope: { type: 'partialStep' }, finish: true }),
      tool('draw_operations', { operations: [missing], finish: true }, 'repair'),
    ]);
    assert.equal((await h.runtime.run(prompt)).status, 'completed', prompt);
    assert.equal(h.requests.length, 2, prompt);
    const receipt = readToolReceipt(h.requests[1]);
    assert.equal(receipt.finishAccepted, false);
    assert.match(receipt.finishRejected, diagnosis);
    assert.deepEqual(h.applied[1].ops.map(op => op.id), [missing.id]);
    assert.equal(h.live.arrows.length, 2);
  }
});

test('没有 finish 的自然收尾在弯箭头仍缺失时保持未完成', async () => {
  const h = harness([
    tool('draw_operations', { operations: [...sn2Structures, attack] }),
    textEnd,
  ]);
  const result = await h.runtime.run('画机理');
  assert.equal(result.status, 'needs_continue');
  assert.equal(result.canContinue, true);
  assert.equal(h.live.arrows.length, 1);
  assert.equal(h.requests.length, 3, '只给一次额外修复机会');
  assert.ok(h.requests[2].messages.some(message => message.role === 'user' && message.content.includes('缺少降低键级的电子流')));
  assert.ok(h.events.some(event => event.code === 'MECHANISM_INCOMPLETE' && /缺少降低键级的电子流/.test(event.message)));
});

test('自然收尾触发修复后，只补缺失的弯箭头即可完成', async () => {
  const h = harness([
    tool('draw_operations', { operations: [...sn2Structures, attack] }),
    textEnd,
    tool('draw_operations', { operations: [leave], finish: true }, 'repair'),
  ]);
  assert.equal((await h.runtime.run('画机理')).status, 'completed');
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.applied[1].ops, [leave]);
  assert.equal(h.live.arrows.length, 2);
});

test('两根弯箭头的键级变化正确而形式电荷错误，仍不可完成', async () => {
  const wrongLeave = { ...leave, target: { type: 'atom', atomId: 'sub:1' } };
  const h = harness([
    tool('draw_operations', { operations: [...sn2Structures, attack, wrongLeave], finish: true }),
    textEnd,
  ]);
  assert.equal((await h.runtime.run('画机理')).status, 'needs_continue');
  assert.equal(h.live.arrows.length, 2);
  assert.match(readToolReceipt(h.requests[1]).finishRejected, /形式电荷变化与产物不符/);
});

test('明确只画反应路线时，结构和直箭头足以完成', async () => {
  for (const prompt of ['只画路线图。', '只画反应路线和产物，不画电子流弯箭头。']) {
    const h = harness([tool('draw_operations', { operations: sn2Structures.filter(op => op.type !== 'lonePair.add'),
      taskScope: { type: 'completeMechanism' }, finish: true })]);
    assert.equal((await h.runtime.run(prompt)).status, 'completed', prompt);
    assert.equal(h.requests.length, 1, prompt);
    assert.equal(h.live.reactionArrows.length, 1);
    assert.equal(h.live.arrows.length, 0);
  }
});

test('明确只画路线时，弯箭头操作在写入前拒绝并可修正', async () => {
  const structures = sn2Structures.filter(op => op.type !== 'lonePair.add');
  const h = harness([
    tool('draw_operations', { operations: [...sn2Structures, attack], finish: true }),
    tool('draw_operations', { operations: structures, finish: true }, 'repair'),
  ]);
  assert.equal((await h.runtime.run('只画反应路线和产物，不画电子流弯箭头。')).status, 'completed');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.applied.map(({ ops }) => ops), [structures]);
  assert.equal(h.live.reactionArrows.length, 1);
  assert.equal(h.live.arrows.length, 0);
});

test('有正确弯箭头时，多出来的跨步骤电子流仍会阻止完成', async () => {
  const h = harness([tool('draw_operations', {
    operations: [...reactantsOnly.operations, ...productsAndConnector, {
      id: 'across', type: 'arrow.add', electronCount: 2,
      source: { type: 'lonePair', id: 'lp' }, target: { type: 'atom', atomId: 'prod:1' },
    }], finish: true,
  }), textEnd]);
  assert.equal((await h.runtime.run(fullSn2)).status, 'needs_continue');
  assert.ok(h.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('across 跨越了反应步骤')));
});

test('闭壳层反应物经双电子步骤产生意外自由基时阻止完成', async () => {
  const h = harness([tool('draw_operations', {
    operations: [...reactantsOnly.operations, ...productsAndConnector], finish: true,
  }), textEnd], { canvas: { atoms: [{ id: 'prod:1', radical: 2 }] } });
  assert.equal((await h.runtime.run(fullSn2)).status, 'needs_continue');
  assert.ok(h.requests[1].messages.some(message => message.role === 'tool' && message.content.includes('prod:1 出现了未解释的自由基')));
});

test('已有的无关反应箭头或新步骤缺少电子流，均不能通过完整性检查', async () => {
  const old = { molecules: [{ id: 'old-r', atoms: ['old-r:1', 'old-r:2'] }, { id: 'old-p', atoms: ['old-p:1'] }],
    reactionArrows: [{ id: 'old', reactants: ['old-r:1'], products: ['old-p:1'] }],
    arrows: [{ id: 'old-flow', source: { type: 'atom', atomId: 'old-r:1' }, target: { type: 'atom', atomId: 'old-r:2' } }] };
  for (const operations of [reactantsOnly.operations, [...reactantsOnly.operations.slice(0, 2), ...productsAndConnector]]) {
    const h = harness([tool('draw_operations', { operations, finish: true }), textEnd], { canvas: old });
    assert.equal((await h.runtime.run(fullSn2)).status, 'needs_continue');
  }
});

test('明确只画已有结构的电子流，可以完成而无需添产物', async () => {
  const h = harness([tool('draw_operations', {
    operations: [{ id: 'attack', type: 'arrow.add', source: { type: 'atom', atomId: 'r:1' },
      target: { type: 'atom', atomId: 'r:2' }, electronCount: 2 }],
    taskScope: { type: 'completeMechanism' }, finish: true,
  })], { canvas: { molecules: [{ id: 'r', atoms: ['r:1', 'r:2'] }] } });
  assert.equal((await h.runtime.run('只画这一步的电子流弯箭头，不用画产物。')).status, 'completed');
  assert.equal(h.requests.length, 1);
  assert.equal(h.live.molecules.length, 1);
  assert.equal(h.live.reactionArrows.length, 0);
});

test('明确只画电子流时，只加孤对电子仍缺弯箭头', async () => {
  const h = harness([
    tool('draw_operations', { operations: [{ id: 'pair', type: 'lonePair.add', atom: 'r:1' }], finish: true }),
    tool('draw_operations', { operations: [{ id: 'flow', type: 'arrow.add', electronCount: 2,
      source: { type: 'lonePair', id: 'pair' }, target: { type: 'atom', atomId: 'r:2' } }], finish: true }, 'repair'),
  ], { canvas: { molecules: [{ id: 'r', atoms: ['r:1', 'r:2'] }] } });
  assert.equal((await h.runtime.run('只画这一步的电子流弯箭头，不用画产物。')).status, 'completed');
  assert.equal(h.requests.length, 2);
  assert.match(readToolReceipt(h.requests[1]).finishRejected, /电子流|弯箭头/);
  assert.equal(h.live.arrows.length, 1);
  assert.equal(h.live.molecules.length, 1);
  assert.equal(h.live.reactionArrows.length, 0);
});

test('续跑只能用有效的原步骤替代件补齐撤销留下的缺口', async () => {
  const taskScope = { type: 'completeMechanism', stages: [{ label: '末步', operationIds: ['unrelated-step'] }] };
  const unrelated = [
    { id: 'other-r', type: 'molecule.add', smiles: '[CH3:1][Cl:2]' },
    { id: 'other-p', type: 'molecule.add', smiles: '[CH3+:1]' },
    { id: 'other-cl', type: 'molecule.add', smiles: '[Cl-:1]' },
    { id: 'other-flow', type: 'arrow.add', source: { type: 'bond', bondId: 'other-r:bond:1', component: 'sigma' },
      target: { type: 'atom', atomId: 'other-r:2' }, electronCount: 2 },
    { id: 'unrelated-step', type: 'reactionArrow.add', reactants: ['other-r:1'], products: ['other-p:1', 'other-cl:1'] },
  ];
  const replacement = { ...productsAndConnector.at(-1), id: 'replacement-step' };
  const h = harness([
    tool('draw_operations', { operations: [...reactantsOnly.operations, ...productsAndConnector], taskScope }),
    textEnd,
    tool('draw_operations', { operations: unrelated, finish: true }, 'call2'),
    textEnd,
    tool('draw_operations', { operations: [replacement], finish: true }, 'call3'),
  ]);
  assert.equal((await h.runtime.run(fullSn2)).status, 'needs_continue');
  h.live.reactionArrows.length = 0;
  assert.equal((await h.runtime.continue()).status, 'needs_continue');
  assert.equal((await h.runtime.continue()).status, 'completed');
  assert.equal(h.live.reactionArrows.length, 2);
});

test('流式解码器接受 taskScope 并保持渐进预览', async () => {
  const decoder = new OperationStreamDecoder({ allowText: false });
  const raw = JSON.stringify({ operations: [{ id: 'a', type: 'molecule.add', smiles: 'C' }], taskScope: { type: 'completeMechanism', stages: [{ label: '反应物', operationIds: ['a'] }] }, finish: true });
  const cut = Math.floor(raw.length / 2);
  decoder.push(raw.slice(0, cut));
  assert.equal(decoder.operations.length, 1, '操作在参数闭合时已可见');
  decoder.push(raw.slice(cut));
  const final = decoder.finish();
  assert.equal(final.taskScope.type, 'completeMechanism');
  assert.equal(final.taskScope.stages[0].label, '反应物');
  assert.equal(final.finish, true);
});

test('taskScope 非法值被流校验拒绝', () => {
  const decoder = new OperationStreamDecoder({ allowText: false });
  assert.throws(() => decoder.push('{"operations":[{"id":"a","type":"molecule.add","smiles":"C"}],"taskScope":{"type":"everyThingGoes"}}'));
});
