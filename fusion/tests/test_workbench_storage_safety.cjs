'use strict';
// Run: node --test fusion/tests/test_workbench_storage_safety.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../workbench/mechanism-model.js');
require('../workbench/workbench-storage.js');
require('../workbench/ketcher-adapter.js');
const MW = globalThis.MolWorkbench, M = MW.model, storage = MW.storage;

function emptyFile() {
  return { format: M.FORMAT, version: M.VERSION, ket: { root: { nodes: [] } },
    bindings: { atoms: [], bonds: [] }, mechanism: M.emptyState() };
}

function reactionFile() {
  const file = emptyFile();
  file.ket = { root: { nodes: [{ $ref: 'mol0' }, { $ref: 'mol1' },
    { type: 'arrow', data: { mode: 'open-angle', pos: [{ x: 1, y: 0 }, { x: 3, y: 0 }] } },
    { type: 'text', data: { content: 'heat' } }] },
    mol0: { type: 'molecule', atoms: [{ label: 'C', location: [0, 0, 0] }], bonds: [] },
    mol1: { type: 'molecule', atoms: [{ label: 'O', location: [4, 0, 0] }], bonds: [] } };
  file.bindings.atoms = [{ id: 'a', mol: 'mol0', index: 0 }, { id: 'b', mol: 'mol1', index: 0 }];
  file.reactionSteps = [{ stepId: 'step-00112233-4455-6677-8899-aabbccddeeff', version: 3,
    arrow: 2, reactants: ['a'], products: ['b'],
    layout: { reactantPlacement: 'vertical', breakBefore: true, conditions: 'heat' },
    conditions: 'heat', flow: { axis: 'x', reading: true, rowY: 0, continuation: 1 },
    labels: [{ node: 3, role: 'conditions', text: 'heat' }] }];
  return file;
}

function stepOperation(overrides = {}) {
  return { id: 'create-step', type: 'reactionStep.create',
    signature: '{"id":"create-step","type":"reactionStep.create"}',
    stepId: 'step-00112233-4455-6677-8899-aabbccddeeff', version: 1, action: 'create', ...overrides };
}

test('v1 reaction step identities, revisions and layout declarations survive repeated saves', () => {
  const file = reactionFile();
  const serialized = storage.serializeWorkbench(file);
  const parsed = storage.parseWorkbench(serialized);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.doc.version, 1);
  assert.deepEqual(parsed.doc.reactionSteps, file.reactionSteps);
  assert.equal(storage.serializeWorkbench(parsed.doc), serialized);
  for (const reactantPlacement of ['auto', 'horizontal', 'vertical']) {
    const variant = reactionFile();
    variant.reactionSteps[0].layout = { reactantPlacement };
    assert.equal(storage.parseWorkbench(JSON.stringify(variant)).ok, true, reactantPlacement);
  }
  const maxId = reactionFile();
  maxId.reactionSteps[0].stepId = 's'.repeat(160);
  maxId.reactionSteps[0].version = Number.MAX_SAFE_INTEGER;
  maxId.reactionSteps[0].layout = { conditions: 'x'.repeat(64), breakBefore: false };
  assert.equal(storage.parseWorkbench(JSON.stringify(maxId)).ok, true);
});

test('old v1 reaction steps without stable identities still load without speculative migration', () => {
  const file = reactionFile();
  for (const key of ['stepId', 'version', 'layout']) delete file.reactionSteps[0][key];
  const parsed = storage.parseWorkbench(storage.serializeWorkbench(file));
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.doc.reactionSteps, file.reactionSteps);
  const noSteps = emptyFile();
  assert.equal(storage.parseWorkbench(storage.serializeWorkbench(noSteps)).ok, true);
});

test('corrupt reaction step identities and revisions reject before replacing a live document', () => {
  const mutations = [
    o => { o.reactionSteps[0].stepId = ''; },
    o => { o.reactionSteps[0].stepId = 's'.repeat(161); },
    o => { o.reactionSteps[0].stepId = 'step with whitespace'; },
    o => { o.reactionSteps[0].stepId = null; },
    o => { o.reactionSteps[0].stepId = 1; },
    ...[0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1].map(version =>
      o => { o.reactionSteps[0].version = version; }),
    o => {
      o.ket.root.nodes.push(structuredClone(o.ket.root.nodes[2]));
      o.reactionSteps.push({ ...structuredClone(o.reactionSteps[0]), arrow: 4 });
    }
  ];
  for (const mutate of mutations) {
    const file = reactionFile(); mutate(file);
    let parsed;
    assert.doesNotThrow(() => { parsed = storage.parseWorkbench(JSON.stringify(file)); });
    assert.equal(parsed.ok, false, JSON.stringify(file.reactionSteps));
    assert.equal(parsed.code, 'invalid');
  }
});

test('invalid reaction layout declarations reject without weakening locator or participant validation', () => {
  const layouts = [null, [], 'vertical', { reactantPlacement: 'diagonal' }, { breakBefore: 1 },
    { conditions: null }, { conditions: 'x'.repeat(65) }, { future: true }];
  for (const layout of layouts) {
    const file = reactionFile(); file.reactionSteps[0].layout = layout;
    let parsed;
    assert.doesNotThrow(() => { parsed = storage.parseWorkbench(JSON.stringify(file)); });
    assert.equal(parsed.ok, false, JSON.stringify(layout));
    assert.equal(parsed.code, 'invalid');
  }
  for (const mutate of [o => { o.reactionSteps[0].arrow = 0; },
    o => { o.reactionSteps[0].reactants = ['missing']; },
    o => { o.reactionSteps[0].labels[0].node = 2; },
    o => { o.reactionSteps[0].flow.future = true; }]) {
    const file = reactionFile(); mutate(file);
    assert.equal(storage.parseWorkbench(JSON.stringify(file)).ok, false);
  }
});

test('v1 step operation ledger preserves multiple mutations and deleted-step tombstones', () => {
  const file = reactionFile();
  file.reactionStepOperations = [stepOperation(),
    stepOperation({ id: 'modify-step', type: 'reactionStep.modify', signature: '{"id":"modify-step"}', version: 2, action: 'modify' }),
    stepOperation({ id: 'delete-step', type: 'reactionStep.delete', signature: '{"id":"delete-step"}', version: 3, action: 'delete' })];
  for (const hasLiveStep of [true, false]) {
    if (!hasLiveStep) delete file.reactionSteps;
    const text = storage.serializeWorkbench(file), parsed = storage.parseWorkbench(text);
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual(parsed.doc.reactionStepOperations, file.reactionStepOperations);
    assert.equal(storage.serializeWorkbench(parsed.doc), text);
  }
  const bounds = emptyFile();
  bounds.reactionStepOperations = Array.from({ length: 2048 }, (_, i) => stepOperation({ id: 'operation-' + i }));
  assert.equal(storage.parseWorkbench(JSON.stringify(bounds)).ok, true);
  bounds.reactionStepOperations = [stepOperation({ id: 'o'.repeat(160), signature: 'x'.repeat(8192),
    stepId: 's'.repeat(160), version: Number.MAX_SAFE_INTEGER })];
  assert.equal(storage.parseWorkbench(JSON.stringify(bounds)).ok, true);
});

test('step ledgers retain resolved identities while accepting older entries without resolved signatures', () => {
  const file = reactionFile();
  const resolvedSignature = '{"products":["at-product-uuid"],"reactants":["at-substrate-uuid"],"type":"reactionStep.create"}';
  file.reactionStepOperations = [stepOperation({ resolvedSignature })];
  const text = storage.serializeWorkbench(file), parsed = storage.parseWorkbench(text);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.doc.reactionStepOperations[0].resolvedSignature, resolvedSignature);
  assert.equal(storage.serializeWorkbench(parsed.doc), text);
  file.reactionStepOperations[0].resolvedSignature = 'x'.repeat(8192);
  assert.equal(storage.parseWorkbench(JSON.stringify(file)).ok, true);
  delete file.reactionStepOperations[0].resolvedSignature;
  const old = storage.parseWorkbench(storage.serializeWorkbench(file));
  assert.equal(old.ok, true, old.error);
  assert.equal(Object.hasOwn(old.doc.reactionStepOperations[0], 'resolvedSignature'), false);
  for (const invalid of ['', null, 1, {}, [], 'x'.repeat(8193)]) {
    file.reactionStepOperations[0].resolvedSignature = invalid;
    const result = storage.parseWorkbench(JSON.stringify(file));
    assert.equal(result.ok, false, JSON.stringify(invalid).slice(0, 100));
    assert.equal(result.code, 'invalid');
  }
});

test('malformed or unbounded step operation ledgers reject instead of silently losing retry protection', () => {
  const mutations = [
    o => { o.reactionStepOperations = null; }, o => { o.reactionStepOperations = {}; },
    o => { o.reactionStepOperations = [null]; }, o => { o.reactionStepOperations = [false]; },
    o => { o.reactionStepOperations.push(structuredClone(o.reactionStepOperations[0])); },
    o => { o.reactionStepOperations = Array.from({ length: 2049 }, (_, i) => stepOperation({ id: 'operation-' + i })); },
    ...['id', 'type', 'signature', 'stepId', 'version', 'action'].map(key =>
      o => { delete o.reactionStepOperations[0][key]; }),
    o => { o.reactionStepOperations[0].id = ''; },
    o => { o.reactionStepOperations[0].id = 'o'.repeat(161); },
    o => { o.reactionStepOperations[0].id = 1; },
    o => { o.reactionStepOperations[0].type = 'arrow.add'; },
    o => { o.reactionStepOperations[0].action = 'clear'; },
    o => { o.reactionStepOperations[0].signature = ''; },
    o => { o.reactionStepOperations[0].signature = 'x'.repeat(8193); },
    o => { o.reactionStepOperations[0].signature = {}; },
    o => { o.reactionStepOperations[0].stepId = 's'.repeat(161); },
    o => { o.reactionStepOperations[0].stepId = null; },
    ...[0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1].map(version =>
      o => { o.reactionStepOperations[0].version = version; }),
    o => { o.reactionStepOperations[0].future = true; }
  ];
  for (const mutate of mutations) {
    const file = emptyFile(); file.reactionStepOperations = [stepOperation()]; mutate(file);
    let parsed;
    assert.doesNotThrow(() => { parsed = storage.parseWorkbench(JSON.stringify(file)); });
    assert.equal(parsed.ok, false, JSON.stringify(file.reactionStepOperations).slice(0, 180));
    assert.equal(parsed.code, 'invalid');
  }
});

test('malformed nested file shapes return a rejection without throwing or changing a live model', () => {
  const model = new M.MechanismModel();
  model.addArrow(M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 1, y: 1 }));
  const before = model.cloneState();
  const mutations = [
    o => { o.bindings.atoms = {}; }, o => { o.bindings.atoms = 'atoms'; },
    o => { o.bindings.atoms = null; }, o => { o.bindings.atoms = [null]; },
    o => { o.bindings.atoms = [3]; }, o => { o.bindings.bonds = {}; },
    o => { o.bindings.bonds = [null]; }, o => { o.bindings.bonds = [3]; },
    o => { o.ket.root = null; }, o => { o.ket.root.nodes = {}; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: {} }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: null }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: [null] }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: [{ location: { 0: 1, 1: 2 } }] }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: [], bonds: {} }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: [], bonds: [null] }; },
    o => { o.ket.mol0 = { type: 'molecule', atoms: [], bonds: [{ atoms: [0, 1] }] }; },
    o => { o.mechanism = null; }, o => { o.mechanism.arrows = {}; },
    o => { o.mechanism.arrows = [null]; }, o => { o.mechanism.lonePairs = {}; },
    o => { o.mechanism.steps = {}; }
  ];
  for (const mutate of mutations) {
    const file = emptyFile(); mutate(file);
    let result;
    assert.doesNotThrow(() => { result = storage.parseWorkbench(JSON.stringify(file)); });
    assert.equal(result.ok, false, JSON.stringify(file));
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(model.cloneState(), before);
  }
  for (const value of [null, [], {}, false, 'workbench']) {
    assert.equal(storage.parseWorkbench(JSON.stringify(value)).ok, false);
  }
  assert.equal(storage.parseWorkbench(JSON.stringify({ ...emptyFile(), version: M.VERSION + 1 })).code, 'newer_version');
});

test('valid empty, arrow-only and dangling-reference drafts still parse and have an empty atom mapping', () => {
  const empty = emptyFile();
  const arrowOnly = emptyFile();
  arrowOnly.mechanism.arrows.push(M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 1 }));
  const dangling = emptyFile();
  dangling.mechanism.arrows.push(M.makeArrow({ type: 'atom', atomId: 'missing', last: { x: 1, y: 2 } },
    { type: 'free', x: 2, y: 1 }));
  for (const file of [empty, arrowOnly, dangling]) {
    const parsed = storage.parseWorkbench(JSON.stringify(file));
    assert.equal(parsed.ok, true, parsed.error);
    const adapter = new MW.adapter.KetcherAdapter({ editor: { struct: () => ({ atoms: new Map(), bonds: new Map() }) } }, {});
    adapter._loadedKet = parsed.doc.ket;
    const result = adapter.applyBindings(parsed.doc.bindings);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.atoms, 0); assert.equal(result.bonds, 0);
  }
});

function apiFixture() {
  let ket = { root: { nodes: [{ $ref: 'mol0' }] }, mol0: {
    type: 'molecule', atoms: [{ label: 'O', location: [0, 0, 0] }, { label: 'C', location: [1, 0, 0] }],
    bonds: [{ type: 1, atoms: [0, 1] }]
  } };
  let nextRuntimeId = 0, failingSets = 0;
  const st = { atoms: new Map(), bonds: new Map() };
  function replace(doc) {
    ket = structuredClone(doc); st.atoms.clear(); st.bonds.clear();
    for (const section of Object.values(ket)) {
      if (section?.type !== 'molecule') continue;
      const ids = section.atoms.map(atom => {
        const id = nextRuntimeId++;
        st.atoms.set(id, { label: atom.label, pp: { x: atom.location[0], y: -atom.location[1] } });
        return id;
      });
      for (const bond of section.bonds || []) st.bonds.set(nextRuntimeId++, { begin: ids[bond.atoms[0]], end: ids[bond.atoms[1]], type: bond.type });
    }
  }
  replace(ket);
  const win = { addEventListener() {}, removeEventListener() {} };
  const doc = { defaultView: win };
  const ketcher = {
    editor: { struct: () => st },
    getKet: async () => JSON.stringify(ket),
    setMolecule: async text => { replace(JSON.parse(text)); if (failingSets > 0) { failingSets--; throw new Error('simulated import failure'); } }
  };
  const adapter = new MW.adapter.KetcherAdapter(ketcher, doc);
  adapter.mount(); adapter.syncIdentity();
  const model = new M.MechanismModel();
  const uuids = Array.from(adapter.uuidAtom.keys()), bondUuid = Array.from(adapter.uuidBond.keys())[0];
  model.addLonePair(M.makeLonePair(uuids[0], { angle: 30 }));
  const arrow = M.makeArrow({ type: 'bond', bondId: bondUuid, component: 'sigma' }, { type: 'atom', atomId: uuids[0] });
  model.addArrow(arrow);
  const controller = { selection: new Set([arrow.id]), refreshAutoSlots() {}, render() {}, emitSelection() {} };
  const context = vm.createContext({ MolWorkbench: MW, document: { readyState: 'loading', addEventListener() {} }, setTimeout, console });
  // Run the real API installer against the isolated Ketcher adapter; defer browser boot.
  const source = fs.readFileSync(require.resolve('../workbench/main.js'), 'utf8')
    .replace('MW.app = S;', 'MW.__installForStorageTest = installAPI; MW.app = S;');
  vm.runInContext(source, context);
  Object.assign(MW.app, { ready: true, adapter, model, controller, kd: { contentWindow: { ketcher } } });
  MW.__installForStorageTest(); delete MW.__installForStorageTest;
  return { api: context.k3dAPI, adapter, model, controller, uuids, bondUuid,
    failNextSet: (count = 1) => { failingSets = count; }, cleanup: () => adapter.unmount() };
}

test('the full workbench API loads and resaves empty and arrow-only documents', async () => {
  const f = apiFixture();
  try {
    const arrowOnly = emptyFile();
    arrowOnly.mechanism.arrows.push(M.makeArrow({ type: 'free', x: 0, y: 0 }, { type: 'free', x: 2, y: 1 }));
    for (const file of [emptyFile(), arrowOnly]) {
      const result = await f.api.loadWorkbench(JSON.stringify(file));
      assert.equal(result.ok, true, result.error);
      assert.equal(f.adapter.struct().atoms.size, 0);
      const saved = storage.parseWorkbench(await f.api.serializeWorkbench());
      assert.equal(saved.ok, true, saved.error);
      assert.deepEqual(saved.doc.mechanism.arrows, file.mechanism.arrows);
      assert.equal(f.controller.selection.size, 0);
    }
  } finally { f.cleanup(); }
});

test('the full workbench API saves, loads and rolls back the step operation ledger with its document', async () => {
  const f = apiFixture();
  let operations = [stepOperation({ id: 'old-delete', type: 'reactionStep.delete', version: 4, action: 'delete' })];
  let failRestore = false;
  MW.app.reactionSteps = {
    export: () => [], exportOperations: () => structuredClone(operations),
    restore: (_steps, _ket, nextOperations) => {
      operations = structuredClone(nextOperations);
      if (failRestore) { failRestore = false; throw new Error('simulated step restore failure'); }
    }
  };
  try {
    const before = storage.parseWorkbench(await f.api.serializeWorkbench());
    assert.deepEqual(before.doc.reactionStepOperations, operations);
    const file = emptyFile();
    file.reactionStepOperations = [stepOperation({ id: 'new-delete', type: 'reactionStep.delete', version: 7, action: 'delete' })];
    const loaded = await f.api.loadWorkbench(JSON.stringify(file));
    assert.equal(loaded.ok, true, loaded.error);
    const after = storage.parseWorkbench(await f.api.serializeWorkbench());
    assert.deepEqual(after.doc.reactionStepOperations, file.reactionStepOperations);

    failRestore = true;
    const failed = await f.api.loadWorkbench(JSON.stringify(emptyFile()));
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'load_failed');
    assert.deepEqual(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.reactionStepOperations, file.reactionStepOperations);

    const cleared = await f.api.loadWorkbench(JSON.stringify(emptyFile()));
    assert.equal(cleared.ok, true, cleared.error);
    assert.deepEqual(operations, []);
    assert.equal(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.reactionStepOperations, undefined);
  } finally { f.cleanup(); }
});

test('a ledger-only document requires its reaction step bridge before replacing the canvas', async () => {
  const f = apiFixture();
  try {
    const before = await f.api.serializeWorkbench();
    const file = emptyFile(); file.reactionStepOperations = [stepOperation()];
    const result = await f.api.loadWorkbench(JSON.stringify(file));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bridge_unavailable');
    assert.equal(await f.api.serializeWorkbench(), before);
  } finally { f.cleanup(); }
});

test('task checkpoint loads, clears and rolls back with the actual workbench document', async () => {
  const f = apiFixture();
  const checkpoint = { version: 1, taskId: 'task:save', goal: 'Continue mechanism', status: 'paused',
    phaseIndex: 0, requestIndex: 1, phases: [{ id: 'draw', objective: 'Finish current step', status: 'active', operationIds: [] }],
    completedOperationIds: [], checks: { status: 'pending', issues: [] }, updatedAt: 1 };
  let current = structuredClone(checkpoint), failRestore = false;
  MW.app.agentTask = { export: () => structuredClone(current), restore: value => {
    current = storage.validateAgentTask(value);
    if (failRestore) { failRestore = false; throw new Error('simulated task restore failure'); }
  } };
  try {
    assert.deepEqual(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.agentTask, checkpoint);
    const next = emptyFile(); next.agentTask = { ...structuredClone(checkpoint), taskId: 'task:next' };
    assert.equal((await f.api.loadWorkbench(JSON.stringify(next))).ok, true);
    assert.deepEqual(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.agentTask, next.agentTask);
    failRestore = true;
    const rejected = await f.api.loadWorkbench(JSON.stringify(emptyFile()));
    assert.equal(rejected.code, 'load_failed');
    assert.deepEqual(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.agentTask, next.agentTask);
    assert.equal((await f.api.loadWorkbench(JSON.stringify(emptyFile()))).ok, true);
    assert.equal(storage.parseWorkbench(await f.api.serializeWorkbench()).doc.agentTask, undefined);
  } finally { f.cleanup(); }
});

test('task-bearing document cannot load without checkpoint support or execute during import', async () => {
  const f = apiFixture();
  try {
    const before = await f.api.serializeWorkbench(), next = emptyFile();
    next.agentTask = { version: 1, taskId: 'task:import', goal: 'Do not automatically execute', status: 'paused',
      phaseIndex: 0, requestIndex: 0, phases: [{ id: 'draw', objective: 'Pending step', status: 'pending', operationIds: [] }],
      completedOperationIds: [], checks: { status: 'pending', issues: [] }, updatedAt: 1 };
    const result = await f.api.loadWorkbench(JSON.stringify(next));
    assert.equal(result.code, 'bridge_unavailable');
    assert.equal(await f.api.serializeWorkbench(), before);
  } finally { f.cleanup(); }
});

test('save retries a changed task checkpoint and rejects an unstable mixed document', async () => {
  const f = apiFixture();
  let fence = 0, calls = 0;
  const original = f.adapter.exportKetWithBindings.bind(f.adapter);
  MW.app.agentTask = { export: () => null, captureFence: () => fence };
  f.adapter.exportKetWithBindings = async () => { calls++; const result = await original(); if (calls === 1) fence++; return result; };
  try {
    const text = await f.api.serializeWorkbench();
    assert.equal(storage.parseWorkbench(text).ok, true);
    assert.equal(calls, 2, 'a snapshot spanning a checkpoint update is retried');
    calls = 0;
    f.adapter.exportKetWithBindings = async () => { calls++; const result = await original(); fence++; return result; };
    await assert.rejects(() => f.api.serializeWorkbench(), /正在变化/);
    assert.equal(calls, 3, 'continuous changes cannot spin indefinitely or save a mixed snapshot');
  } finally { f.cleanup(); }
});

test('failed workbench import restores the old stable atom/bond IDs and attached mechanism', async () => {
  const f = apiFixture();
  try {
    const before = f.model.cloneState(), selection = [...f.controller.selection];
    f.failNextSet();
    const result = await f.api.loadWorkbench(JSON.stringify(emptyFile()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'load_failed');
    assert.deepEqual(f.model.cloneState(), before);
    assert.deepEqual([...f.controller.selection], selection);
    for (const uuid of f.uuids) assert.notEqual(f.adapter.atomIdOf(uuid), null, 'old atom identity must resolve after rollback');
    assert.notEqual(f.adapter.bondIdOf(f.bondUuid), null, 'old bond identity must resolve after rollback');
    const saved = storage.parseWorkbench(await f.api.serializeWorkbench());
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(saved.doc.bindings.atoms.map(x => x.id), f.uuids);
    assert.equal(saved.doc.bindings.bonds[0].id, f.bondUuid);
    assert.equal(f.adapter.suppressReset, false);
  } finally { f.cleanup(); }
});

test('an unsuccessful rollback is reported as a recovery failure, without claiming the old content was restored', async () => {
  const f = apiFixture();
  try {
    f.failNextSet(2);
    const result = await f.api.loadWorkbench(JSON.stringify(emptyFile()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'rollback_failed');
    assert.doesNotMatch(result.error, /已恢复原内容/);
    assert.equal(f.adapter.suppressReset, false);
  } finally { f.cleanup(); }
});
