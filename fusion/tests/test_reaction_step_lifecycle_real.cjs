// Current canvas, native Ketcher history and local chemistry service; no model calls.
// These small molecules are geometry fixtures, not assertions about chemistry.
// MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_reaction_step_lifecycle_real.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-reaction-step-lifecycle');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-reaction-step-lifecycle-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);
const report = {
  application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron test window',
  fixture: 'small-molecule geometry and reaction-step lifecycle; no chemistry verdict',
  modelCalls: 0, checks: [], browserErrors: [],
};
const watchdog = setTimeout(() => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...report, timedOut: true }, null, 2));
  app.exit(2);
}, 90_000);

async function exercise() {
  const api = window.k3dAPI.agent, ed = window.MolWorkbench.app.adapter.ed;
  const checks = window.reactionStepLifecycleChecks = [];
  const samples = window.reactionStepLifecycleSamples = {};
  const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
    if (!pass) throw new Error(name);
  };
  const close = (a, b, tolerance = 1e-5) => Math.abs(a - b) < tolerance;
  const ordered = value => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
    return value;
  };
  const canonical = value => JSON.stringify(ordered(value));
  const source = () => k3dAPI.serializeWorkbench();
  const context = () => api.getContext();
  const snapshot = c => canonical({
    atoms: c.atoms.map(({ id, x, y, label, charge }) => ({ id, x, y, label, charge })).sort((a, b) => a.id.localeCompare(b.id)),
    arrows: c.reactionArrows, steps: c.reactionSteps, texts: c.texts,
  });
  const history = () => ({ undo: ed.historySize().undo, redo: ed.historySize().redo, ptr: ed.historyPtr });
  const steps = c => c.reactionSteps || [];
  const step = (c, id) => steps(c).find(s => s.stepId === id);
  const arrow = (c, s) => c.reactionArrows.find(a => String(a.id) === String(s?.reactionArrowId));
  const bounds = (c, atomId) => {
    const mol = c.molecules.find(m => m.atoms.includes(atomId));
    if (!mol) return null;
    const points = c.atoms.filter(a => mol.atoms.includes(a.id));
    return { x1: Math.min(...points.map(p => p.x)), x2: Math.max(...points.map(p => p.x)),
      y1: Math.min(...points.map(p => p.y)), y2: Math.max(...points.map(p => p.y)) };
  };
  const isRightward = a => a && a.end.x > a.start.x && close(a.start.y, a.end.y);
  const conditionTexts = c => c.texts.map(t => t.text);
  const continuations = c => conditionTexts(c).filter(t => /^续\s*\d+$/.test(t));
  const hasReplayFlag = r => !!r?.replayed || [...(r?.created || []), ...(r?.updated || []), ...(r?.deleted || [])].some(e => e.replayed);
  let runId;
  const begin = async id => {
    if (runId) await api.endRun(runId);
    runId = id;
    await api.beginRun(runId, { readingOrder: true, separatePaths: true });
  };
  const apply = ops => api.applyOperations(ops, { runId });
  const finish = async () => { if (runId) await api.endRun(runId); runId = null; };
  const expectRejected = async (name, ops, expectedCode) => {
    const before = await source(), beforeHistory = history();
    let failure;
    try { await apply(ops); } catch (error) { failure = { code: error.code, message: error.message }; }
    check(name, failure?.code === expectedCode && await source() === before && canonical(history()) === canonical(beforeHistory),
      { failure, expectedCode, historyBefore: beforeHistory, historyAfter: history() });
  };

  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-main');
  const seed = await apply([
    { id: 'fixture-a', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 0, y: 0 },
    { id: 'fixture-b', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 6, y: 0 },
    { id: 'fixture-c', type: 'molecule.add', smiles: '[CH3:1][Cl:2]', x: 6, y: 5 },
    { id: 'fixture-d', type: 'molecule.add', smiles: '[CH3:1][F:2]', x: 12, y: 5 },
    { id: 'fixture-e', type: 'molecule.add', smiles: '[CH3:1][NH2:2]', x: 18, y: 5 },
  ]);
  const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(k => [k, seed.atomMapping[`fixture-${k}:1`]]));
  const seedAtomIds = (await context()).atoms.map(a => a.id).sort();
  const createAB = { id: 'lifecycle-create-ab', type: 'reactionStep.create',
    reactants: ['fixture-a:1'], products: ['fixture-b:1'], layout: { conditions: 'heat' } };
  const created = await apply([createAB]);
  const abReceipt = created.created?.find(e => e.id === createAB.id);
  const abId = abReceipt?.stepId;
  let c = await context(), ab = step(c, abId);
  check('create returns a stable step identity and version one', typeof abId === 'string' && !!abId &&
    ab?.version === 1 && ab.reactants.includes(ids.a) && ab.products.includes(ids.b) &&
    c.reactionArrows.length === 1 && !!arrow(c, ab) && conditionTexts(c).includes('heat'), { receipt: abReceipt, step: ab });

  const afterCreate = await source(), historyAfterCreate = history();
  const retry = await apply([createAB]);
  check('repeating the same create operation is idempotent', await source() === afterCreate &&
    canonical(history()) === canonical(historyAfterCreate) && step(await context(), abId)?.version === 1 && hasReplayFlag(retry),
    { replayed: retry.replayed, created: retry.created, historyBefore: historyAfterCreate, historyAfter: history() });
  await expectRejected('reusing an operation id with changed payload is rejected atomically',
    [{ ...createAB, products: ['fixture-c:1'] }], 'operation_conflict');

  const be = await apply([{ id: 'lifecycle-create-be', type: 'reactionStep.create', reactants: [ids.b], products: [ids.e] }]);
  const beId = be.created?.find(e => e.id === 'lifecycle-create-be')?.stepId;
  const beforeRetarget = snapshot(await context());
  const modifyAC = { id: 'lifecycle-retarget-ac', type: 'reactionStep.modify', stepId: createAB.id,
    expectedVersion: 1, products: ['fixture-c:1'], layout: { conditions: 'cat.' } };
  const changed = await apply([modifyAC]);
  c = await context(); ab = step(c, abId);
  check('retarget changes A to C in place without leaving A to B', steps(c).length === 2 && c.reactionArrows.length === 2 &&
    ab?.version === 2 && ab.reactants.includes(ids.a) && ab.products.includes(ids.c) && !ab.products.includes(ids.b) &&
    arrow(c, ab)?.products?.includes(ids.c) && !conditionTexts(c).includes('heat') && conditionTexts(c).includes('cat.') &&
    step(c, beId)?.reactants.includes(ids.b) && step(c, beId)?.products.includes(ids.e) &&
    canonical(c.atoms.map(a => a.id).sort()) === canonical(seedAtomIds), { step: ab, updated: changed.updated });
  const afterRetarget = snapshot(c);
  samples.retargeted = await source();
  await finish();
  k3dAPI.undo();
  check('one undo restores prior step metadata geometry and condition text', snapshot(await context()) === beforeRetarget);
  k3dAPI.redo();
  check('one redo restores retargeted step metadata geometry and condition text', snapshot(await context()) === afterRetarget);

  await begin('lifecycle-stale');
  await expectRejected('stale step version leaves geometry metadata history and labels unchanged',
    [{ id: 'lifecycle-stale-modify', type: 'reactionStep.modify', stepId: abId, expectedVersion: 1,
      products: [ids.b], layout: { conditions: 'must not appear' } }], 'step_version_conflict');
  await expectRejected('stale delete preserves the current version and its native objects',
    [{ id: 'lifecycle-stale-delete', type: 'reactionStep.delete', stepId: abId, expectedVersion: 1 }], 'step_version_conflict');
  const beforeModifyRetry = await source(), beforeModifyRetryHistory = history();
  const modifyRetry = await apply([modifyAC]);
  check('modify operation retry replays instead of applying an old expected version', await source() === beforeModifyRetry &&
    canonical(history()) === canonical(beforeModifyRetryHistory) && hasReplayFlag(modifyRetry));

  // B remains a real shared document object after A no longer points at it.
  c = await context();
  check('the former product remains available to an independent step', steps(c).length === 2 &&
    c.molecules.length === 5 && step(c, beId)?.reactants.includes(ids.b) && isRightward(arrow(c, step(c, beId))), { steps: steps(c) });
  const beforeDeleteBE = snapshot(c);
  await apply([{ id: 'lifecycle-delete-be', type: 'reactionStep.delete', stepId: beId, expectedVersion: 1 }]);
  c = await context();
  check('deleting a step preserves every shared participant molecule', !step(c, beId) && steps(c).length === 1 &&
    c.reactionArrows.length === 1 && c.molecules.length === 5 && canonical(c.atoms.map(a => a.id).sort()) === canonical(seedAtomIds));
  const afterDeleteBE = snapshot(c);
  await finish();
  k3dAPI.undo();
  check('delete undo restores stable step identity participants and native arrow', snapshot(await context()) === beforeDeleteBE);
  k3dAPI.redo();
  check('delete redo removes only the step and its native objects', snapshot(await context()) === afterDeleteBE);

  await begin('lifecycle-chain');
  const cdResult = await apply([{ id: 'lifecycle-create-cd', type: 'reactionStep.create', reactants: [ids.c], products: [ids.d],
    layout: { conditions: 'light' } }]);
  const cdId = cdResult.created?.find(e => e.id === 'lifecycle-create-cd')?.stepId;
  c = await context();
  check('a successor joins the corrected short chain', steps(c).length === 2 && step(c, cdId)?.version === 1 &&
    isRightward(arrow(c, step(c, cdId))) && step(c, abId)?.products.includes(ids.c) && step(c, cdId)?.reactants.includes(ids.c));
  const beforeWrap = snapshot(c);
  await apply([{ id: 'lifecycle-wrap-cd', type: 'reactionStep.modify', stepId: cdId, expectedVersion: 1,
    layout: { breakBefore: true, conditions: 'UV' } }]);
  c = await context();
  const cd = step(c, cdId), cdArrow = arrow(c, cd), sourceBounds = bounds(c, ids.c), targetBounds = bounds(c, ids.d);
  const cues = continuations(c);
  check('forced continuation creates a matched cue pair and a rightward next-row entry', cd?.version === 2 &&
    cues.length === 2 && cues[0] === cues[1] && isRightward(cdArrow) && targetBounds.y1 > sourceBounds.y2 &&
    conditionTexts(c).includes('UV') && !conditionTexts(c).includes('light'), { step: cd, cues, sourceBounds, targetBounds, arrow: cdArrow });
  const afterWrap = snapshot(c);
  await finish();
  k3dAPI.undo();
  check('wrap undo removes both cues and restores the former layout', snapshot(await context()) === beforeWrap);
  k3dAPI.redo();
  check('wrap redo restores both cues condition and complete layout', snapshot(await context()) === afterWrap);

  await begin('lifecycle-followup');
  const deResult = await apply([{ id: 'lifecycle-create-de', type: 'reactionStep.create', reactants: [ids.d], products: [ids.e] }]);
  const deId = deResult.created?.find(e => e.id === 'lifecycle-create-de')?.stepId;
  c = await context();
  const tailArrow = arrow(c, step(c, deId));
  check('a later step continues on the wrapped row with valid participant links', steps(c).length === 3 &&
    c.reactionArrows.length === 3 && isRightward(tailArrow) && close(tailArrow.start.y, arrow(c, step(c, cdId)).start.y) &&
    continuations(c).length === 2 && step(c, deId)?.reactants.includes(ids.d) && step(c, deId)?.products.includes(ids.e),
    { cd: arrow(c, step(c, cdId)), de: tailArrow });
  samples.wrapped = await source();
  const identitiesBeforeLoad = steps(c).map(s => ({ stepId: s.stepId, version: s.version, reactants: s.reactants, products: s.products }));
  await finish();
  const loaded = await k3dAPI.loadWorkbench(samples.wrapped);
  c = await context();
  check('save and reopen retain stable identities versions and participant associations', loaded.ok &&
    canonical(steps(c).map(s => ({ stepId: s.stepId, version: s.version, reactants: s.reactants, products: s.products }))) === canonical(identitiesBeforeLoad) &&
    steps(c).every(s => !!arrow(c, s)) && continuations(c).length === 2 && conditionTexts(c).includes('UV'), { loaded, steps: steps(c) });
  samples.reopened = await source();

  await begin('lifecycle-reopened');
  const beforeDurableRetry = await source(), beforeDurableRetryHistory = history();
  const durableRetry = await apply([createAB]);
  check('a document operation retry survives reopening and expired molecule aliases', hasReplayFlag(durableRetry) &&
    await source() === beforeDurableRetry && canonical(history()) === canonical(beforeDurableRetryHistory) && step(await context(), abId)?.version === 2);
  await expectRejected('changed payload for a persisted operation id is a conflict after reopening',
    [{ ...createAB, layout: { conditions: 'different payload' } }], 'operation_conflict');
  await apply([{ id: 'lifecycle-unwrap-reopened-cd', type: 'reactionStep.modify', stepId: cdId, expectedVersion: 2,
    layout: { breakBefore: false, conditions: '' } }]);
  c = await context();
  check('a reopened stable step can clear its conditions and continuation atomically', step(c, cdId)?.version === 3 &&
    c.reactionArrows.length === 3 && continuations(c).length === 0 && !conditionTexts(c).includes('UV') &&
    isRightward(arrow(c, step(c, cdId))) && isRightward(arrow(c, step(c, deId))) &&
    close(arrow(c, step(c, cdId)).start.y, arrow(c, step(c, deId)).start.y), { steps: steps(c), texts: c.texts });
  samples.final = await source();

  const rolledBackEdit = { id: 'lifecycle-rolled-back-retarget', type: 'reactionStep.modify', stepId: abId, expectedVersion: 2,
    products: [ids.b], layout: { conditions: 'rollback sentinel' } };
  await expectRejected('a later failure rolls back an earlier valid step edit in the same batch', [
    rolledBackEdit,
    { id: 'lifecycle-late-version-failure', type: 'reactionStep.modify', stepId: deId, expectedVersion: 99, layout: { conditions: 'also absent' } },
  ], 'step_version_conflict');
  const beforeBranch = snapshot(await context());
  const branchResult = await apply([
    { id: 'lifecycle-supported-branch', type: 'reactionStep.create', reactants: [ids.a], products: [ids.d] },
  ]);
  const branchId = branchResult.steps.find(entry => entry.operationId === 'lifecycle-supported-branch').stepId;
  c = await context();
  check('a branch and merge reuse the actual existing structures with horizontal local ports',
    steps(c).length === 4 && c.reactionArrows.length === 4 &&
    canonical(c.atoms.map(atom => atom.id).sort()) === canonical(seedAtomIds) &&
    step(c, branchId)?.version === 1 && step(c, branchId)?.reactants.includes(ids.a) && step(c, branchId)?.products.includes(ids.d) &&
    steps(c).every(entry => isRightward(arrow(c, entry))) && steps(c).some(entry => entry.ports?.length > 0),
    { branch: step(c, branchId), atoms: c.atoms.length, arrows: c.reactionArrows.length });
  samples.dagBranch = await source();
  await finish();
  k3dAPI.undo();
  check('undoing a supported branch restores the former graph without duplicated molecules', snapshot(await context()) === beforeBranch);
  await begin('lifecycle-post-branch-undo');
  await expectRejected('unknown stable step identity does not alter the canvas', [
    { id: 'lifecycle-missing-step', type: 'reactionStep.delete', stepId: 'reaction-step-not-present', expectedVersion: 1 },
  ], 'missing_reference');

  const beforeRetryAfterFailure = snapshot(await context());
  const failureRetry = await apply([rolledBackEdit]);
  c = await context();
  check('failed batches do not consume a valid operation id in the durable ledger', !hasReplayFlag(failureRetry) &&
    step(c, abId)?.version === 3 && step(c, abId)?.products.includes(ids.b) && conditionTexts(c).includes('rollback sentinel'));
  await finish();
  k3dAPI.undo();
  check('retry after a rolled back batch remains one normal undo operation', snapshot(await context()) === beforeRetryAfterFailure);

  // A single transaction may refer to the stable identity through its create op alias.
  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-single-transaction');
  const batchSeed = await apply([
    { id: 'batch-a', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 0, y: 0 },
    { id: 'batch-b', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 6, y: 0 },
    { id: 'batch-c', type: 'molecule.add', smiles: '[CH3:1][Cl:2]', x: 6, y: 5 },
  ]);
  const batchAtomIds = (await context()).atoms.map(a => a.id).sort();
  const oneBatchCreate = { id: 'lifecycle-one-batch-create', type: 'reactionStep.create',
    reactants: ['batch-a:1'], products: ['batch-b:1'], layout: { conditions: 'temporary create' } };
  const oneBatchModify = { id: 'lifecycle-one-batch-modify', type: 'reactionStep.modify',
    stepId: oneBatchCreate.id, expectedVersion: 1, products: ['batch-c:1'], layout: { conditions: 'temporary modify' } };
  const oneBatchDelete = { id: 'lifecycle-one-batch-delete', type: 'reactionStep.delete',
    stepId: oneBatchCreate.id, expectedVersion: 2 };
  const beforeOneBatch = snapshot(await context()), historyBeforeOneBatch = history();
  const oneBatchResult = await apply([oneBatchCreate, oneBatchModify, oneBatchDelete]);
  const deletedStableId = oneBatchResult.created?.find(e => e.id === oneBatchCreate.id)?.stepId;
  c = await context();
  check('one batch can create modify and delete through the create alias', typeof deletedStableId === 'string' &&
    steps(c).length === 0 && c.reactionArrows.length === 0 && c.texts.length === 0 && c.molecules.length === 3 &&
    canonical(c.atoms.map(a => a.id).sort()) === canonical(batchAtomIds) && history().undo === historyBeforeOneBatch.undo + 1,
    { created: oneBatchResult.created, updated: oneBatchResult.updated, deleted: oneBatchResult.deleted });
  const afterOneBatch = snapshot(c);
  samples.deletedInOneBatch = await source();
  await finish();
  k3dAPI.undo();
  check('one undo restores the complete state before create modify delete transaction', snapshot(await context()) === beforeOneBatch);
  k3dAPI.redo();
  check('one redo restores the transaction result without orphan labels or connectors', snapshot(await context()) === afterOneBatch);

  const loadedDeleted = await k3dAPI.loadWorkbench(samples.deletedInOneBatch);
  check('a document containing only deleted step operations reopens cleanly', loadedDeleted.ok &&
    steps(await context()).length === 0 && (await context()).reactionArrows.length === 0, loadedDeleted);
  await begin('lifecycle-deleted-replay');
  for (const [label, operation] of [['delete', oneBatchDelete], ['modify', oneBatchModify], ['create', oneBatchCreate]]) {
    const beforeReplay = await source(), beforeReplayHistory = history();
    const receipt = await apply([operation]);
    c = await context();
    check('reopened ' + label + ' retry of a deleted step replays without resurrecting it', hasReplayFlag(receipt) &&
      await source() === beforeReplay && canonical(history()) === canonical(beforeReplayHistory) &&
      steps(c).length === 0 && c.reactionArrows.length === 0 && c.texts.length === 0);
  }
  await expectRejected('a changed deleted-operation payload remains a durable operation conflict',
    [{ ...oneBatchDelete, expectedVersion: 3 }], 'operation_conflict');
  await expectRejected('a new delete operation cannot address an already deleted stable step',
    [{ id: 'lifecycle-delete-again', type: 'reactionStep.delete', stepId: deletedStableId, expectedVersion: 2 }], 'missing_reference');
  check('deleted step replay preserves every original fixture participant', canonical((await context()).atoms.map(a => a.id).sort()) === canonical(batchAtomIds) &&
    !!batchSeed.atomMapping['batch-a:1']);
  await finish();

  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-observed-layout');
  const twoReactants = await apply([
    { id: 'vertical-oxygen', type: 'molecule.add', smiles: '[OH-:1]', x: 0, y: 0 },
    { id: 'vertical-substrate', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 3, y: 0 },
    { id: 'vertical-product', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 9, y: 0 },
    { id: 'vertical-step', type: 'reactionStep.create', reactants: ['vertical-oxygen:1', 'vertical-substrate:1'],
      products: ['vertical-product:1'], layout: { reactantPlacement: 'horizontal' } },
  ]);
  const verticalId = twoReactants.created.find(e => e.id === 'vertical-step').stepId;
  const verticalO = twoReactants.atomMapping['vertical-oxygen:1'], verticalSubstrate = twoReactants.atomMapping['vertical-substrate:1'];
  c = await context();
  const originalO = bounds(c, verticalO), originalSubstrate = bounds(c, verticalSubstrate);
  await apply([{ id: 'vertical-modify', type: 'reactionStep.modify', stepId: verticalId, expectedVersion: 1,
    layout: { reactantPlacement: 'vertical' } }]);
  c = await context();
  const stackedO = bounds(c, verticalO), stackedSubstrate = bounds(c, verticalSubstrate);
  const centerOf = b => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
  check('modifying reactant placement moves the actual two molecules from horizontal to vertical',
    close(centerOf(originalO).y, centerOf(originalSubstrate).y) && Math.abs(centerOf(originalO).x - centerOf(originalSubstrate).x) > 0.9 &&
    close(centerOf(stackedO).x, centerOf(stackedSubstrate).x) && stackedO.y2 < stackedSubstrate.y1 &&
    step(c, verticalId)?.checks?.layout?.status === 'passed' && isRightward(arrow(c, step(c, verticalId))),
    { originalO, originalSubstrate, stackedO, stackedSubstrate, step: step(c, verticalId) });
  await finish();

  // Move the real native object's endpoints as a native drag would; keep its shaft horizontal.
  const verticalNativeId = step(c, verticalId).reactionArrowId;
  const nativeArrow = ed.struct().rxnArrows.get(Number(verticalNativeId));
  for (const point of nativeArrow.pos) { point.x += 12; point.y += 6; }
  ed.render.ctab.markItem('rxnArrows', Number(verticalNativeId), 1);
  ed.render.update();
  window.MolWorkbench.app.controller.render();
  c = await context();
  check('a detached horizontal native arrow is reported from its current geometry', isRightward(arrow(c, step(c, verticalId))) &&
    step(c, verticalId)?.checks?.layout?.status === 'failed' &&
    step(c, verticalId)?.checks?.layout?.issues.some(i => i.code === 'reaction_step_connector_detached'), { step: step(c, verticalId) });
  samples.detachedNativeArrow = await source();
  await begin('lifecycle-repair-native-arrow');
  await apply([{ id: 'vertical-repair-detached', type: 'reactionStep.modify', stepId: verticalId, expectedVersion: 2,
    layout: { reactantPlacement: 'vertical', conditions: 'repaired' } }]);
  c = await context();
  check('modifying the same step repairs its detached native arrow and clears observed failure', steps(c).length === 1 &&
    c.reactionArrows.length === 1 && step(c, verticalId)?.version === 3 &&
    step(c, verticalId)?.checks?.layout?.status === 'passed' && isRightward(arrow(c, step(c, verticalId))), { step: step(c, verticalId) });
  samples.verticalRepaired = await source();
  await finish();

  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-real-electron-geometry');
  const flowSeed = await apply([
    { id: 'observed-o', type: 'molecule.add', smiles: '[OH-:1]', x: 0, y: 0 },
    { id: 'observed-n', type: 'molecule.add', smiles: '[NH3:1]', x: 2, y: 0 },
    { id: 'observed-f', type: 'molecule.add', smiles: '[F:1]', x: 4, y: 0 },
    { id: 'observed-product', type: 'molecule.add', smiles: '[CH4:1]', x: 10, y: 0 },
    { id: 'observed-spectator', type: 'molecule.add', smiles: '[Cl-:1]', x: 0, y: 20 },
    { id: 'observed-step', type: 'reactionStep.create', reactants: ['observed-o:1', 'observed-n:1', 'observed-f:1'],
      products: ['observed-product:1'], layout: { reactantPlacement: 'horizontal' } },
  ]);
  const observedId = flowSeed.created.find(e => e.id === 'observed-step').stepId;
  const oxygen = flowSeed.atomMapping['observed-o:1'], nitrogen = flowSeed.atomMapping['observed-n:1'], fluorine = flowSeed.atomMapping['observed-f:1'];
  const flowResult = await apply([{ id: 'observed-electron', type: 'arrow.add', source: { type: 'atom', atomId: oxygen },
    target: { type: 'atom', atomId: fluorine }, electronCount: 2 }]);
  const electronId = flowResult.created.find(e => e.id === 'observed-electron').entityIds[0];
  await apply([{ id: 'observed-straight-electron', type: 'arrow.modify', arrowId: electronId, mode: 'manual', bend: 0 }]);
  // Late electron-flow routing now legitimately docks the reactive pair and
  // moves the unrelated N out of its way. Establish the intended real-glyph
  // obstruction *after* that routing, rather than relying on old atom order.
  const obstructionContext = window.MolWorkbench.app.controller.ctx();
  const curveBeforeObstruction = window.MolWorkbench.model.arrowGeometry(window.MolWorkbench.app.model.arrow(electronId), obstructionContext);
  const obstructionPoint = window.MolWorkbench.model.quadPoint(curveBeforeObstruction.start, curveBeforeObstruction.control, curveBeforeObstruction.end, 0.5);
  const nitrogenBefore = obstructionContext.atomPos(nitrogen), nitrogenGlyphBefore = obstructionContext.atomLabelBox(nitrogen);
  const nitrogenGlyphCenter = centerOf(nitrogenGlyphBefore.rect);
  await apply([{ id: 'observed-put-nitrogen-on-curve', type: 'molecule.move', target: { atoms: [nitrogen] },
    x: obstructionPoint.x - (nitrogenGlyphCenter.x - nitrogenBefore.x),
    y: obstructionPoint.y - (nitrogenGlyphCenter.y - nitrogenBefore.y) }]);
  const live = window.MolWorkbench.app, liveCtx = live.controller.ctx();
  const actualCurve = window.MolWorkbench.model.arrowGeometry(live.model.arrow(electronId), liveCtx);
  const nitrogenGlyph = liveCtx.atomLabelBox(nitrogen);
  const sampledActualCurve = window.MolWorkbench.route.sampleCurve(actualCurve.start, actualCurve.control, actualCurve.end, 0.1, 12, 48);
  const actualGlyphIntersection = !!nitrogenGlyph.rect && sampledActualCurve.points.some((p, i, points) => i > 0 &&
    window.MolWorkbench.route.segRectDistance(points[i - 1], p, nitrogenGlyph.rect) === 0);
  c = await context();
  check('real rendered electron curve crossing a native nitrogen glyph is reported as crowding', actualGlyphIntersection &&
    step(c, observedId)?.checks?.layout?.status === 'failed' &&
    step(c, observedId)?.checks?.layout?.issues.some(i => i.code === 'reaction_step_electron_crowding' && i.arrowId === electronId),
    { actualCurve: { start: actualCurve.start, control: actualCurve.control, end: actualCurve.end }, nitrogenGlyph,
      actualGlyphIntersection, step: step(c, observedId) });
  samples.crowdedActualCurve = await source();
  await apply([{ id: 'observed-repair-electron', type: 'arrow.modify', arrowId: electronId, mode: 'auto' }]);
  c = await context();
  check('replanning the real electron curve clears observed crowding', step(c, observedId)?.checks?.layout?.status === 'passed', { step: step(c, observedId) });
  samples.repairedActualCurve = await source();

  const nPosition = c.atoms.find(a => a.id === nitrogen);
  await apply([{ id: 'observed-overlap-spectator', type: 'molecule.move', target: { atoms: [flowSeed.atomMapping['observed-spectator:1']] },
    x: nPosition.x + 0.05, y: nPosition.y }]);
  c = await context();
  check('overlapping an existing spectator with a step participant is observed from actual atom positions',
    step(c, observedId)?.checks?.layout?.status === 'failed' &&
    step(c, observedId)?.checks?.layout?.issues.some(i => i.code === 'reaction_step_molecule_overlap'), { step: step(c, observedId) });
  samples.overlappedMolecule = await source();
  await finish();
  k3dAPI.undo();
  check('undoing the physical overlap restores the observed layout result', step(await context(), observedId)?.checks?.layout?.status === 'passed');

  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-main-molecule-baseline');
  const hostSmiles = '[CH3:1][CH2:2][CH2:3][CH2:4][CH2:5][OH:6]';
  const baselineSeed = await apply([
    { id: 'baseline-a', type: 'molecule.add', smiles: hostSmiles, x: 0, y: 0 },
    { id: 'baseline-b', type: 'molecule.add', smiles: hostSmiles, x: 9, y: 0 },
    { id: 'baseline-c', type: 'molecule.add', smiles: hostSmiles, x: 18, y: 0 },
    { id: 'baseline-reagent', type: 'molecule.add', smiles: '[OH-:1]', x: 9, y: 5 },
    { id: 'baseline-first', type: 'reactionStep.create', reactants: ['baseline-a:1'], products: ['baseline-b:1'] },
    { id: 'baseline-second', type: 'reactionStep.create', reactants: ['baseline-b:1', 'baseline-reagent:1'],
      products: ['baseline-c:1'], layout: { reactantPlacement: 'vertical' } },
  ]);
  c = await context();
  const mainBounds = ['a', 'b', 'c'].map(k => bounds(c, baselineSeed.atomMapping[`baseline-${k}:1`]));
  const mainCenters = mainBounds.map(centerOf), reagentBounds = bounds(c, baselineSeed.atomMapping['baseline-reagent:1']);
  const baselineArrows = c.reactionArrows;
  check('a vertically docked next-step reagent does not pull its main molecule off the short-chain baseline',
    mainCenters.every(p => close(p.y, mainCenters[0].y)) && reagentBounds.y1 > mainBounds[1].y2 &&
    close(centerOf(reagentBounds).x, mainCenters[1].x) && baselineArrows.length === 2 &&
    baselineArrows.every(a => isRightward(a) && close(a.start.y, mainCenters[0].y)) &&
    steps(c).every(s => s.checks?.layout?.status === 'passed'),
    { mainBounds, mainCenters, reagentBounds, arrows: baselineArrows, steps: steps(c) });
  samples.mainMoleculeBaseline = await source();
  await finish();

  await k3dAPI.setMolecule('');
  ed.clearHistory();
  await begin('lifecycle-alias-original');
  const originalAliasSeed = await apply([
    { id: 'reused-source', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 0, y: 0 },
    { id: 'reused-target', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 6, y: 0 },
  ]);
  const reusedAliasCreate = { id: 'lifecycle-stable-alias-create', type: 'reactionStep.create',
    reactants: ['reused-source:1'], products: ['reused-target:1'], layout: { conditions: 'alias fixture' } };
  const originalAliasStep = await apply([reusedAliasCreate]);
  const originalAliasStepId = originalAliasStep.created.find(e => e.id === reusedAliasCreate.id).stepId;
  samples.aliasLedgerCreated = await source();
  await finish();
  await begin('lifecycle-alias-new-objects');
  const reusedAliasSeed = await apply([
    { id: 'reused-source', type: 'molecule.add', smiles: '[NH3:1]', x: 0, y: 8 },
    { id: 'reused-target', type: 'molecule.add', smiles: '[OH2:1]', x: 6, y: 8 },
  ]);
  await expectRejected('an old step operation cannot silently replay when its raw aliases now name new molecules',
    [reusedAliasCreate], 'operation_conflict');
  c = await context();
  check('alias conflict preserves the original step identities and both sets of molecules',
    originalAliasSeed.atomMapping['reused-source:1'] !== reusedAliasSeed.atomMapping['reused-source:1'] &&
    originalAliasSeed.atomMapping['reused-target:1'] !== reusedAliasSeed.atomMapping['reused-target:1'] &&
    step(c, originalAliasStepId)?.reactants.includes(originalAliasSeed.atomMapping['reused-source:1']) &&
    step(c, originalAliasStepId)?.products.includes(originalAliasSeed.atomMapping['reused-target:1']) &&
    steps(c).length === 1 && c.reactionArrows.length === 1 && c.molecules.length === 4);
  await finish();

  await begin('lifecycle-alias-conflict-one-batch');
  const liveAtomPool = ed.struct().atoms, observedPoolMethods = new Map();
  let liveAtomInsertionCalls = 0;
  for (const method of ['add', 'set']) {
    if (typeof liveAtomPool[method] !== 'function') continue;
    const own = Object.getOwnPropertyDescriptor(liveAtomPool, method), original = liveAtomPool[method];
    observedPoolMethods.set(method, { own, original });
    liveAtomPool[method] = function (...args) { liveAtomInsertionCalls++; return original.apply(this, args); };
  }
  try {
    await expectRejected('new molecule aliases and an old step replay in one batch reject atomically before insertion', [
      { id: 'reused-source', type: 'molecule.add', smiles: '[CH4:1]', x: 0, y: 12 },
      { id: 'reused-target', type: 'molecule.add', smiles: '[Cl-:1]', x: 6, y: 12 },
      reusedAliasCreate,
    ], 'operation_conflict');
    check('same-batch alias conflict never invokes the live atom pool insertion methods',
      observedPoolMethods.size > 0 && liveAtomInsertionCalls === 0, { observedMethods: [...observedPoolMethods.keys()], liveAtomInsertionCalls });
  } finally {
    for (const [method, observed] of observedPoolMethods) {
      if (observed.own) Object.defineProperty(liveAtomPool, method, observed.own);
      else delete liveAtomPool[method];
    }
  }
  await finish();
  const aliasReload = await k3dAPI.loadWorkbench(samples.aliasLedgerCreated);
  await begin('lifecycle-alias-reopened-unresolved');
  const beforeAliasReplay = await source(), historyBeforeAliasReplay = history();
  const unresolvedAliasReplay = await apply([reusedAliasCreate]);
  check('persisted resolved signatures still allow an unchanged retry with expired raw aliases', aliasReload.ok &&
    hasReplayFlag(unresolvedAliasReplay) && await source() === beforeAliasReplay &&
    canonical(history()) === canonical(historyBeforeAliasReplay) && steps(await context()).length === 1);
  await finish();
  return checks;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 880,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  win.webContents.on('render-process-gone', (_, details) => report.browserErrors.push(details));
  try {
    report.service = 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 49075);
    await win.loadURL(report.service + '/canvas.html');
    for (let i = 0; i < 250; i++) {
      if (await js('!!window.k3dAPI?.workbenchReady?.()')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!await js('!!window.k3dAPI?.workbenchReady?.()')) throw new Error('Current canvas did not become ready');
    report.checks = await js('(' + exercise.toString() + ')()');
    report.ok = report.checks.every(check => check.pass) && !report.browserErrors.length;
  } catch (error) {
    report.ok = false;
    report.error = String(error.stack || error);
    report.checks = await js('window.reactionStepLifecycleChecks || []').catch(() => []);
  } finally {
    const samples = await js('window.reactionStepLifecycleSamples || {}').catch(() => ({}));
    for (const [name, saved] of Object.entries(samples)) fs.writeFileSync(path.join(out, name + '.molwork'), saved);
    report.images = [];
    for (const name of ['retargeted', 'wrapped', 'detachedNativeArrow', 'verticalRepaired', 'crowdedActualCurve', 'repairedActualCurve', 'overlappedMolecule', 'mainMoleculeBaseline', 'final']) {
      if (!samples[name]) continue;
      await js('k3dAPI.loadWorkbench(' + JSON.stringify(samples[name]) + ')').catch(() => {});
      const exported = await js('k3dAPI.exportMechanismImage("png")').catch(() => null);
      if (exported?.ok) {
        const bytes = Buffer.from(exported.dataUrl.split(',')[1], 'base64');
        const imageName = 'canvas-source-' + name + '.png';
        fs.writeFileSync(path.join(out, imageName), bytes);
        report.images.push({ file: imageName, application: report.application, page: report.page, build: report.build });
        if (name === 'final') fs.writeFileSync(path.join(out, 'canvas-source-mechanism.png'), bytes);
      }
    }
    fs.writeFileSync(path.join(out, 'canvas-source-window.png'), (await win.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ application: report.application, page: report.page, build: report.build, modelCalls: 0,
      passed: report.checks.filter(check => check.pass).length, total: report.checks.length,
      failures: report.checks.filter(check => !check.pass), error: report.error, ok: report.ok, out }, null, 2));
    clearTimeout(watchdog); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
