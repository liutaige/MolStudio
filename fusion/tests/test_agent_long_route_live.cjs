// Real configured model + actual canvas/runtime/DAG bridge. Run the short
// caffeine-routes smoke first; this case independently exercises a longer route.
// MOLSTUDIO_REAL_AGENT=1 MOLSTUDIO_PORT=49075 MOLSTUDIO_AGENT_TEST_OUT=/absolute/artifacts \
//   fusion/node_modules/.bin/electron fusion/tests/test_agent_long_route_live.cjs
// MOLSTUDIO_AGENT_LONG_PROMPT_FILE may supply a revised natural-language task.
// MOLSTUDIO_AGENT_LONG_PHASES_FILE accepts a JSON array of natural prompts;
// phases share this canvas/runtime and stop at the first non-completed result.
// Pure Node argument regression: node this-file.cjs --test-phases-arguments
// MOLSTUDIO_AGENT_LONG_CASE=ROBINSON selects the checked KOH/pyrrolidine case;
// its chemistry acceptance uses structures and route witnesses, not a fixed count.
// MOLSTUDIO_AGENT_LONG_SEED_FILE may load an existing .molwork before the task.
// MOLSTUDIO_AGENT_LONG_SEED_EXTEND=1 requires SEED_FILE and allows new entities
// while preserving every original seed entity and molecule's chemical identity.
// MOLSTUDIO_AGENT_TRANSPORT_VARIANT labels an external diagnostic transport;
// non-standard variants never produce a standard-transport acceptance verdict.
// MOLSTUDIO_AGENT_LONG_LEFT_REAGENT_STEP optionally names a stable step ID or
// its creation-operation ID for the left-of-reaction-site acceptance check.
// No provider payloads, configuration, credentials or hidden reasoning are saved.
'use strict';
const NODE_PHASE_ARGUMENT_TEST = process.argv.includes('--test-phases-arguments');
const { app, BrowserWindow } = NODE_PHASE_ARGUMENT_TEST ? {} : require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonical, inspectGraph, inspectChemistry, semanticSnapshot } = require('./agent_long_route_audit.cjs');
const { observeModelResponse, enforceModelRequestBudget, assessModelRequestBudget, assessModelTransport, safeRuntimeErrorMessage, zeroOutputStopDecision, modelRequestMetrics, createActiveDeadline } = require('./agent_long_route_probe.cjs');
const { ROBINSON_CASE, inspectRobinson } = require('./agent_robinson_audit.cjs');
const { reviewedChemistryPreserved } = require('./agent_hydrogen_representation_audit.cjs');

if (!NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_REAL_AGENT !== '1') {
  process.stderr.write('Long-route real-model acceptance requires MOLSTUDIO_REAL_AGENT=1.\n'); process.exit(2);
}
const OUT = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || '/tmp/molstudio-long-route-live');
const REVIEW_GATE = process.env.MOLSTUDIO_AGENT_LONG_REVIEW_GATE === '1';
const LIMIT = Math.min(REVIEW_GATE ? 120 : 40, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 40));
const CHECK_NATIVE_HISTORY = process.env.MOLSTUDIO_AGENT_LONG_NATIVE_HISTORY === '1';
let zeroOutputLimitMs = Number(process.env.MOLSTUDIO_AGENT_LONG_ZERO_OUTPUT_MS) || 0;
if (!Number.isInteger(zeroOutputLimitMs) || zeroOutputLimitMs !== 0 && (zeroOutputLimitMs < 30000 || zeroOutputLimitMs > 300000)) {
  throw new Error('The optional zero-output test budget must be 0 or 30000–300000 ms');
}
const TIMEOUT = Math.min(REVIEW_GATE ? 3_600_000 : 1_200_000, Math.max(30_000, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 1_200_000));
const TRANSPORT_VARIANT = process.env.MOLSTUDIO_AGENT_TRANSPORT_VARIANT || 'standard';
if (!/^[A-Za-z0-9._-]{1,100}$/.test(TRANSPORT_VARIANT)) throw new Error('The transport variant must be a short identifier');
const TRANSPORT_DIAGNOSTIC = TRANSPORT_VARIANT !== 'standard';
const PROMPT_FILE = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_PROMPT_FILE ? path.resolve(process.env.MOLSTUDIO_AGENT_LONG_PROMPT_FILE) : null;
const PHASES_FILE = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_PHASES_FILE ? path.resolve(process.env.MOLSTUDIO_AGENT_LONG_PHASES_FILE) : null;
const SEED_FILE = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_SEED_FILE ? path.resolve(process.env.MOLSTUDIO_AGENT_LONG_SEED_FILE) : null;
const RESUME_SEED = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_RESUME_SEED === '1';
if (RESUME_SEED && !SEED_FILE) throw new Error('MOLSTUDIO_AGENT_LONG_RESUME_SEED requires a saved workbench');
const SEED_EXTEND = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_SEED_EXTEND === '1';
if (SEED_EXTEND && !SEED_FILE) throw new Error('MOLSTUDIO_AGENT_LONG_SEED_EXTEND=1 requires MOLSTUDIO_AGENT_LONG_SEED_FILE');
const PROTECTED_STEPS_FILE = !NODE_PHASE_ARGUMENT_TEST && process.env.MOLSTUDIO_AGENT_LONG_PROTECTED_STEPS_FILE ? path.resolve(process.env.MOLSTUDIO_AGENT_LONG_PROTECTED_STEPS_FILE) : null;
const PROTECTED_STEPS = PROTECTED_STEPS_FILE ? JSON.parse(fs.readFileSync(PROTECTED_STEPS_FILE, 'utf8')) : null;
if (PROTECTED_STEPS && (!SEED_EXTEND || !Array.isArray(PROTECTED_STEPS) || !PROTECTED_STEPS.length || PROTECTED_STEPS.some(id => typeof id !== 'string'))) throw new Error('A reviewed prefix needs a nonempty step-ID array and explicit seed extension mode');
const SEED_SOURCE = SEED_FILE ? fs.readFileSync(SEED_FILE, 'utf8') : null;
const LEFT_STEP_REF = process.env.MOLSTUDIO_AGENT_LONG_LEFT_REAGENT_STEP || null;
const CHEMICAL_CASE = (process.env.MOLSTUDIO_AGENT_LONG_CASE || 'TRAUBE').toUpperCase();
if (!['TRAUBE', 'ROBINSON'].includes(CHEMICAL_CASE)) throw new Error('Unknown long-route chemical case: ' + CHEMICAL_CASE);
const IS_ROBINSON = CHEMICAL_CASE === 'ROBINSON';
const DEFAULT_PROMPT = '请从尿素和氰乙酸开始，绘制经 Traube 路线合成咖啡因的详细反应机理。包括亚硝酸钠酸化后用于亚硝化的试剂制备旁支，以及它汇入主线的实际化学关系。画到咖啡因，并展示每个能够可靠确认的基元步骤的电子流。若某一步的反应条件或电子来源，尤其还原阶段，不能可靠确定，请明确说明缺少什么信息，不要用猜测补齐。完成后简短说明。';
const PROMPT = PROMPT_FILE ? fs.readFileSync(PROMPT_FILE, 'utf8').trim() : IS_ROBINSON ? ROBINSON_CASE.prompt : DEFAULT_PROMPT;
if (!PROMPT || PROMPT.length > 20_000) throw new Error('The long-route prompt must contain 1–20000 characters');
const PHASE_PROMPTS = PHASES_FILE ? parsePhasePrompts(JSON.parse(fs.readFileSync(PHASES_FILE, 'utf8'))) : [PROMPT];
const profile = NODE_PHASE_ARGUMENT_TEST ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-long-route-live-'));
if (!NODE_PHASE_ARGUMENT_TEST) { fs.mkdirSync(OUT, { recursive: true }); app.setPath('userData', profile); }
const report = {
  application: 'MolStudio canvas', page: 'fusion/canvas.html', build: process.env.MOLSTUDIO_TEST_BUILD || 'current served resources',
  service: 'http://127.0.0.1:' + (Number(process.env.MOLSTUDIO_PORT) || 49075),
  transportVariant: TRANSPORT_VARIANT,
  standardTransportAcceptance: TRANSPORT_DIAGNOSTIC ? 'not_evaluated' : 'pending',
  scope: (TRANSPORT_DIAGNOSTIC ? 'Transport diagnostic [' + TRANSPORT_VARIANT + ']; standard transport is not evaluated. ' : '') +
    (PROTECTED_STEPS ? 'Real-model continuation and local correction of the unreviewed suffix. The reviewed prefix keeps its chemistry and references. A successful makeExplicit receipt can authorize only a verified representation-equivalent H display change. Necessary suffix replacement is recorded with semantic differences and native receipts. Final acceptance is unchanged.'
    : SEED_EXTEND ? 'Real-model continuation of an existing editable diagram. New structures and steps are allowed; all seeded chemical entities and molecule memberships must remain unchanged.'
    : SEED_FILE ? 'Real-model layout of an existing editable diagram; this does not establish industrial chemistry correctness.'
    : IS_ROBINSON ? 'Autonomous Robinson annulation under the documented KOH then pyrrolidine conditions. Structural/flow witnesses do not prove every microscopic pathway.'
      : 'Autonomous real-model long-route chemistry and DAG-layout acceptance. Step count is observed, not prescribed as 23.'),
  case: PROTECTED_STEPS ? 'reviewed-prefix-continuation-with-local-repair' : SEED_EXTEND ? 'existing-diagram-continuation' : SEED_FILE ? 'existing-diagram-layout' : IS_ROBINSON ? 'robinson-koh-pyrrolidine-wieland-miescher' : PROMPT_FILE ? 'prompt-file-override' : 'traube-from-urea-with-nitrosation-preparation',
  chemicalCase: CHEMICAL_CASE, ...(IS_ROBINSON && { chemicalSources: ROBINSON_CASE.sources }),
  promptFile: PROMPT_FILE, ...(SEED_FILE && { seedFile: SEED_FILE, seedExtend: SEED_EXTEND,
    seedPreservationMode: PROTECTED_STEPS ? 'reviewed-prefix-chemistry-preserved-with-receipted-H-display-and-audited-suffix-replacement' : SEED_EXTEND ? 'unchanged-stable-entity-subset' : 'exact-diagram' }),
  ...(PROTECTED_STEPS && { protectedStepsFile: PROTECTED_STEPS_FILE, protectedStepIds: PROTECTED_STEPS }),
  prompt: PHASES_FILE ? null : PROMPT,
  ...(PHASES_FILE && { phasesFile: PHASES_FILE, phasePrompts: PHASE_PROMPTS, phases: [],
    phasePolicy: REVIEW_GATE ? 'Each natural phase pauses for independent review; next-task.json explicitly sends, continues or finishes. Same canvas/runtime. Historical failures remain recorded; final full acceptance is unchanged.'
      : 'Sequential natural tasks on the same canvas/runtime. No reset between phases; first non-completed phase stops the remaining tasks. Final chemistry/layout acceptance is unchanged.' }),
  requestLimit: LIMIT, timeoutMs: TIMEOUT, realModelRequests: 0,
  ...(RESUME_SEED && { resumeSeed: true, resumeScope: 'Explicit continuation of the checkpoint from the saved workbench; no new task.' }),
  deadlinePolicy: 'The timeout counts active startup/model/native verification work. Independent review-gate waits pause this budget without resetting the remaining time. No model configuration changes.',
  budgetChanges: [{ at: new Date().toISOString(), from: null, to: LIMIT, reason: 'explicit harness request budget' }],
  activeControls: [],
  zeroOutputTestBudget: { limitMs: zeroOutputLimitMs, changes: [{ at: new Date().toISOString(), from: null, to: zeroOutputLimitMs }],
    decisions: [], scope: 'Optional local test stop only; no model configuration changes or automatic retries. Visible content, any tool fragment or an oversized unclassified event disables this stop.' },
  startedAt: new Date().toISOString(), status: 'starting', checks: [], artifacts: [], browserErrors: [],
  privacy: 'Safe progress contains transport counts/status/timing, local tool names and semantic step receipts only. Visible assistant text is separate from hidden reasoning; no raw provider stream or credentials are retained.',
  coverageExpectations: { minimumSteps: Math.max(1, Number(process.env.MOLSTUDIO_AGENT_LONG_MIN_STEPS) || (IS_ROBINSON ? 1 : 8)),
    minimumMainline: Math.max(1, Number(process.env.MOLSTUDIO_AGENT_LONG_MIN_MAINLINE) || (IS_ROBINSON ? 1 : 6)),
    preparationMerge: process.env.MOLSTUDIO_AGENT_LONG_REQUIRE_PREPARATION ? process.env.MOLSTUDIO_AGENT_LONG_REQUIRE_PREPARATION !== '0' : !IS_ROBINSON,
    initialUreaAndCyanoaceticAcid: !IS_ROBINSON && !PROMPT_FILE && !SEED_FILE,
    caffeineTarget: process.env.MOLSTUDIO_AGENT_LONG_REQUIRE_CAFFEINE ? process.env.MOLSTUDIO_AGENT_LONG_REQUIRE_CAFFEINE !== '0' : !IS_ROBINSON,
    ...(IS_ROBINSON && { robinsonTargetAndCatalyticRoute: true, stepCountPrescribed: false }),
    leftReagentStep: LEFT_STEP_REF },
};
let activeDeadline = null;
const write = () => {
  if (activeDeadline) report.activeDeadline = activeDeadline.snapshot();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
};
if (!NODE_PHASE_ARGUMENT_TEST) write();

function parsePhasePrompts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) throw new Error('The phases file must be a JSON array of 1–40 natural-language prompts');
  return value.map((prompt, index) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 20_000) {
      throw new Error('Phase ' + (index + 1) + ' must contain 1–20000 natural-language characters');
    }
    return prompt.trim();
  });
}

const robinsonChemistryAccepted = audit => audit?.pass === true && audit.requiresManualReview !== true;

function parseActiveControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.action !== 'stop' ||
      value.reason !== 'task_refinement' || Object.keys(value).some(key => !['action', 'reason'].includes(key))) {
    throw new Error('Active control accepts only {action:"stop",reason:"task_refinement"}');
  }
  return value;
}

function runPhaseArgumentTests() {
  const { test } = require('node:test'), assert = require('node:assert/strict');
  test('phase prompts are trimmed and keep their natural-language order', () => {
    const input = [' 先完成 Michael 加成。 ', '\n沿现有中间体继续成环。\n'];
    assert.deepEqual(parsePhasePrompts(input), ['先完成 Michael 加成。', '沿现有中间体继续成环。']);
    assert.equal(input[0], ' 先完成 Michael 加成。 ');
  });
  test('phase arguments reject non-arrays, empty arrays and non-text entries', () => {
    for (const input of [null, {}, 'task', [], [null], [42], [{}], ['  '], ['valid', false]]) assert.throws(() => parsePhasePrompts(input));
  });
  test('phase arguments enforce the existing per-prompt size and total bounded list', () => {
    assert.equal(parsePhasePrompts(['x'.repeat(20000)])[0].length, 20000);
    assert.throws(() => parsePhasePrompts(['x'.repeat(20001)]));
    assert.equal(parsePhasePrompts(Array(40).fill('natural task')).length, 40);
    assert.throws(() => parsePhasePrompts(Array(41).fill('natural task')));
  });
  test('the supplied Robinson phase fixture is a two-prompt natural task', () => {
    const prompts = parsePhasePrompts(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/robinson_annulation_phases.json'), 'utf8')));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /KOH/); assert.match(prompts[0], /三酮/);
    assert.match(prompts[1], /吡咯烷/); assert.match(prompts[1], /Wieland/);
  });
  const seedFixture = () => ({ atoms: [{ id: 'a', label: 'C', charge: 0, implicitH: 3 }, { id: 'b', label: 'O', charge: 0, implicitH: 1 }],
    bonds: [{ id: 'ab', begin: 'a', end: 'b', order: 1 }], molecules: [{ id: 'old-molecule', atoms: ['a', 'b'] }],
    lonePairs: [{ id: 'lp', ownerAtomId: 'b' }],
    arrows: [{ id: 'flow', source: { type: 'lonePair', ownerAtomId: 'b', slotId: 'lp' }, target: { type: 'atom', atomId: 'a' }, electronCount: 2 }],
    reactionSteps: [{ stepId: 'old-step', version: 1, reactants: ['a'], products: ['b'] }] });
  const extendedFixture = () => {
    const result = seedFixture();
    result.atoms.push({ id: 'c', label: 'C', charge: 0, implicitH: 4 }); result.molecules.push({ id: 'new-molecule', atoms: ['c'] });
    result.lonePairs.push({ id: 'new-lp', ownerAtomId: 'b' });
    result.arrows.push({ id: 'new-flow', source: { type: 'lonePair', ownerAtomId: 'b', slotId: 'new-lp' }, target: { type: 'atom', atomId: 'c' }, electronCount: 2 });
    result.reactionSteps.push({ stepId: 'new-step', version: 1, reactants: ['a'], products: ['c'] });
    result.atoms[0].x = 100; result.reactionSteps[0].version = 2; result.reactionSteps[0].layout = { breakBefore: true };
    return result;
  };
  test('seed continuation accepts additions and layout changes while default layout mode remains exact', () => {
    const before = seedFixture(), after = extendedFixture();
    assert.equal(seedEntitiesPreserved(before, after, true), true);
    assert.equal(seedEntitiesPreserved(before, after), false);
    assert.equal(seedEntitiesPreserved(before, structuredClone(before)), true);
  });
  test('seed continuation rejects changed or missing old chemistry, merged molecules and altered flow owners', () => {
    const mutations = [
      c => { c.atoms[0].charge = 1; }, c => { c.atoms[0].alias = 'changed'; },
      c => { c.bonds[0].order = 2; }, c => { c.molecules[0].atoms.push('c'); c.molecules.pop(); },
      c => { c.reactionSteps[0].products = ['c']; }, c => { c.lonePairs[0].ownerAtomId = 'a'; },
      c => { c.arrows[0].target.atomId = 'c'; }, c => { c.arrows.shift(); },
      c => { c.bonds.push({ id: 'extra-old-bond', begin: 'a', end: 'b', order: 1 }); },
      c => { c.molecules.push({ id: 'duplicate-owner', atoms: ['a', 'c'] }); },
    ];
    for (const mutate of mutations) { const after = extendedFixture(); mutate(after); assert.equal(seedEntitiesPreserved(seedFixture(), after, true), false); }
  });
  const suffixFixture = () => {
    const result = seedFixture();
    result.atoms.push({ id: 'c', label: 'N', charge: 0, implicitH: 3 }, { id: 'd', label: 'H', charge: 0, implicitH: 0 });
    result.bonds.push({ id: 'cd', begin: 'c', end: 'd', order: 1 });
    result.molecules.push({ id: 'suffix', atoms: ['c', 'd'] });
    result.lonePairs.push({ id: 'suffix-lp', ownerAtomId: 'c' });
    result.arrows.push({ id: 'suffix-flow', source: { type: 'lonePair', ownerAtomId: 'c', slotId: 'suffix-lp' }, target: { type: 'atom', atomId: 'd' }, electronCount: 2 });
    result.reactionSteps.push({ stepId: 'suffix-step', version: 1, reactants: ['c'], products: ['d'] });
    return result;
  };
  test('reviewed-prefix continuation permits explicit replacement of unreviewed chemistry', () => {
    const seed = suffixFixture(), after = seedFixture();
    after.atoms.push({ id: 'corrected', label: 'O', charge: -1, implicitH: 1 });
    after.molecules.push({ id: 'corrected-molecule', atoms: ['corrected'] });
    after.reactionSteps.push({ stepId: 'suffix-step', version: 2, reactants: ['b'], products: ['corrected'] });
    assert.equal(reviewedSeedPreserved(seed, after, ['old-step']), true);
    const delta = seedEntityChanges(seed, after);
    assert.deepEqual(delta.atoms.removed.map(item => item.id), ['c', 'd']);
    assert.equal(delta.arrows.removed[0].id, 'suffix-flow');
    assert.equal(delta.steps.changed[0].before.products[0], 'd');
    assert.equal(delta.steps.changed[0].after.products[0], 'corrected');
  });
  test('suffix correction cannot remove, mutate or merge a reviewed prefix entity', () => {
    for (const mutate of [c => { c.atoms[0].charge = 1; }, c => { c.arrows.shift(); },
      c => { c.reactionSteps[0].products = ['c']; }, c => { c.molecules[0].atoms.push('c'); c.molecules.pop(); }]) {
      const seed = suffixFixture(), after = structuredClone(seed); mutate(after);
      assert.equal(reviewedSeedPreserved(seed, after, ['old-step']), false);
    }
    assert.equal(reviewedSeedPreserved(suffixFixture(), suffixFixture(), ['missing-step']), false);
  });
  test('structural witnesses cannot approve unresolved hydrolysis proton accounting', () => {
    assert.equal(robinsonChemistryAccepted({ pass: true, requiresManualReview: true }), false);
    assert.equal(robinsonChemistryAccepted({ pass: false, requiresManualReview: false }), false);
    assert.equal(robinsonChemistryAccepted({ pass: true, requiresManualReview: false,
      mechanisticNotes: [{ kind: 'carbinolamine_dehydration', status: 'review' }] }), true);
  });
  test('active task refinement exposes only an explicit stop command', () => {
    assert.deepEqual(parseActiveControl({ action: 'stop', reason: 'task_refinement' }), { action: 'stop', reason: 'task_refinement' });
    for (const value of [null, [], {}, { action: 'send', reason: 'task_refinement' }, { action: 'stop', reason: 'other' },
      { action: 'stop', reason: 'task_refinement', code: 'arbitrary script' }]) assert.throws(() => parseActiveControl(value));
  });
}

async function installProbe(limit, observeResponse, safeErrorMessage, enforceBudget, requestMetrics) {
  const rt = molstudioAgent.getRuntime(), nativeFetch = rt._fetch;
  const state = window.__longRouteProbe = { requests: [], events: [], toolNames: [], steps: [], receipts: [], contexts: [], checks: {}, visibleText: '', hostLayoutCompletions: [], appliedBatches: [], completionCalls: [],
    requestBudget: { limit, exhausted: false, deniedAttempts: 0 },
    currentRunId: null, pendingBudgetDenial: null, terminalBudgetDenial: null,
    runStatus: 'starting', lastCanvas: null, lastEventAt: null, lastSource: null, snapshotChain: Promise.resolve(), lastEmit: 0 };
  const now = () => new Date().toISOString();
  const operationAllowlist = ['layout.tidy', 'reactionStep.modify', 'lonePair.modify', 'arrow.modify'];
  const nativeApply = window.k3dAPI?.agent?.applyOperations;
  if (typeof nativeApply === 'function') window.k3dAPI.agent.applyOperations = async function(operations, options) {
    const result = await nativeApply.call(this, operations, options);
    const types = Array.isArray(operations) ? operations.map(op => op?.type) : [];
    state.appliedBatches.push({ operationTypes: types.filter(type => operationAllowlist.includes(type)),
      unexpectedOperationCount: types.filter(type => !operationAllowlist.includes(type)).length,
      replayed: result?.replayed === true });
    return result;
  };
  const emit = () => {
    if (Date.now() - state.lastEmit < 1000) return;
    state.lastEmit = Date.now();
    console.info('MOLSTUDIO_LONG_PROGRESS ' + JSON.stringify({ realModelRequests: state.requests.length,
      activeRequests: state.requests.filter(request => !request.finishedAt).length,
      lastEventAt: state.lastEventAt, runStatus: state.runStatus, canvas: state.lastCanvas,
      requestBudget: state.requestBudget,
      stepChecks: Object.keys(state.checks).length }));
  };
  rt._fetch = async function (url, init) {
    if (url !== '/api/agent/model') return nativeFetch(url, init);
    try { enforceBudget(state.requests, state.requestBudget, now, state.currentRunId); }
    catch (error) {
      const denial = state.requestBudget.denials.at(-1); state.pendingBudgetDenial = denial;
      state.events.push({ type: 'request_budget_exhausted', code: 'test_request_limit', at: state.requestBudget.lastDeniedAt,
        runId: denial.runId, denialId: denial.id, sequence: denial.sequence, nextRequestNumber: denial.nextRequestNumber,
        limit: state.requestBudget.limit, sentRequests: state.requests.length, deniedAttempts: state.requestBudget.deniedAttempts });
      emit(); throw error;
    }
    const request = { number: state.requests.length + 1, runId: state.currentRunId, startedAt: now(), bytes: 0, chunks: 0,
      appliedBatchCountAtStart: state.appliedBatches.length };
    state.requests.push(request); emit();
    try {
      const body = JSON.parse(init.body), modes = ['enabled', 'disabled', 'adaptive'], efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      if (requestMetrics) request.input = requestMetrics(init.body, body);
      const allowedTools = ['read_canvas', 'inspect_structures', 'draw_operations', 'plan_task', 'complete_phase', 'complete_layout'];
      request.offeredTools = Array.isArray(body.tools) ? body.tools.map(tool => tool?.function?.name || tool?.name)
        .filter(name => allowedTools.includes(name)) : [];
      const draw = Array.isArray(body.tools) ? body.tools.find(tool => (tool?.function?.name || tool?.name) === 'draw_operations') : null;
      const schema = draw?.function?.parameters || draw?.parameters;
      const options = schema?.properties?.operations?.items?.oneOf;
      const optionTypes = option => Array.isArray(option?.properties?.type?.enum) ? option.properties.type.enum :
        typeof option?.properties?.type?.const === 'string' ? [option.properties.type.const] : [];
      const types = Array.isArray(options) ? options.flatMap(optionTypes) : [];
      const propertyAllowlist = { 'layout.tidy': ['id','type'], 'reactionStep.modify': ['id','type','stepId','expectedVersion','layout'],
        'lonePair.modify': ['id','type','lonePairId','aim'], 'arrow.modify': ['id','type','arrowId','mode'] };
      const shapeValid = Array.isArray(options) && options.every(option => {
        const values = optionTypes(option), type = values[0], props = option?.properties || {}, allowed = propertyAllowlist[type];
        if (values.length !== 1 || !allowed || Object.keys(props).some(key => !allowed.includes(key))) return false;
        if (type === 'reactionStep.modify' && (!props.layout || Object.keys(props.layout.properties || {}).some(key => !['reactantPlacement','reagentPlacement','breakBefore'].includes(key)))) return false;
        const key = type === 'lonePair.modify' ? 'aim' : type === 'arrow.modify' ? 'mode' : null;
        return !key || (props[key]?.const === 'auto' || Array.isArray(props[key]?.enum) && props[key].enum.length === 1 && props[key].enum[0] === 'auto');
      });
      request.offeredOperations = { schemaAvailable: Array.isArray(options),
        types: [...new Set(types.filter(type => operationAllowlist.includes(type)))].sort(),
        unexpectedTypeCount: types.filter(type => !operationAllowlist.includes(type)).length, semanticShapeValid: shapeValid };
      request.settings = { explicitMaxTokens: Object.hasOwn(body, 'max_tokens'), maxTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : null,
        explicitThinking: Object.hasOwn(body, 'thinking'), thinkingType: modes.includes(body.thinking?.type) ? body.thinking.type : null,
        explicitReasoningEffort: Object.hasOwn(body, 'reasoning_effort'), reasoningEffort: efforts.includes(body.reasoning_effort) ? body.reasoning_effort : null };
    } catch { /* Observe only selected numeric/enumerated fields, never payloads. */ }
    try {
      const id = typeof Headers === 'function' ? new Headers(init?.headers).get('X-MolStudio-Agent-Request') : null;
      if (id && globalThis.crypto?.subtle) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
        request.gatewayRequestIdHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
      }
    } catch { /* Correlation metadata must never alter the model request. */ }
    let response;
    try { response = await nativeFetch(url, init); }
    catch (error) {
      request.errorCode = error?.name || 'transport_error'; request.errorPhase = 'fetch'; request.transportError = true;
      request.errorAt = now(); request.finishedAt = request.errorAt; emit(); throw error;
    }
    request.responseStatus = response.status; request.headersAt = now();
    // The local gateway exposes only enumerated generation knobs in this
    // header; do not retain any raw headers or provider content.
    try {
      const value = JSON.parse(response.headers.get('X-MolStudio-Generation') || 'null');
      if (value && typeof value === 'object') {
        const req = value.requested || {}, fields = value.fields || {};
        const profiles = ['provider-default', 'deepseek', 'openai'];
        const efforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        const thinking = ['enabled', 'disabled', 'adaptive'];
        request.gatewayGeneration = {
          requested: { profile: profiles.includes(req.profile) ? req.profile : null,
            effort: efforts.includes(req.effort) ? req.effort : null,
            maxOutputTokens: Number.isSafeInteger(req.maxOutputTokens) ? req.maxOutputTokens : null },
          fields: { thinkingType: thinking.includes(fields.thinking?.type) ? fields.thinking.type : null,
            reasoningEffort: efforts.includes(fields.reasoning_effort) ? fields.reasoning_effort : null,
            maxTokens: Number.isSafeInteger(fields.max_tokens) ? fields.max_tokens : null },
          forwardedToConfiguredEndpoint: value.forwardedToConfiguredEndpoint === true,
          downstreamConfirmed: value.downstreamConfirmed === true,
        };
      }
    } catch { request.gatewayGeneration = { invalid: true }; }
    emit();
    return observeResponse(response, request, emit, now);
  };
  addEventListener('molstudio:agent-event', event => {
    const e = event.detail; state.lastEventAt = now();
    if (e.type === 'tool_start' && e.toolName === 'complete_layout') {
      let undo = null; try { undo = window.MolWorkbench?.app?.adapter?.ed?.historySize?.().undo ?? null; } catch {}
      state.completionCalls.push({ applyCountBefore: state.appliedBatches.length, undoBefore: undo });
    }
    if (e.type === 'tool_end' && e.toolName === 'complete_layout') {
      const call = state.completionCalls.at(-1);
      if (call) {
        let undo = null; try { undo = window.MolWorkbench?.app?.adapter?.ed?.historySize?.().undo ?? null; } catch {}
        Object.assign(call, { applyCountAfter: state.appliedBatches.length, undoAfter: undo,
          isError: e.isError === true, scope: e.result?.scope === 'layout' ? 'layout' : null,
          finishAccepted: e.result?.finishAccepted === true });
        if (e.result?.layoutFacts) {
          const facts=e.result.layoutFacts, safe={};
          for (const key of ['molecules','atoms','bonds','electronFlows','reactionSteps','horizontalArrows'])
            if (Number.isSafeInteger(facts[key]) && facts[key] >= 0) safe[key]=facts[key];
          if (Array.isArray(facts.pairedTokens)) safe.pairedTokens=facts.pairedTokens.filter(token => typeof token === 'string' && /^(?:续\d+|接B?\d+)$/.test(token));
          call.layoutFacts=safe;
        }
      }
    }
    if (e.type === 'run_start') {
      state.runStatus = 'running'; state.currentRunId = e.runId;
      state.pendingBudgetDenial = null; state.terminalBudgetDenial = null;
    }
    if (e.type === 'run_end') state.runStatus = e.status;
    if (e.type === 'context_compacted') state.contexts.push({ at: state.lastEventAt, runId: e.runId,
      ...Object.fromEntries(['inputMessages', 'outputMessages', 'inputBytes', 'outputBytes', 'retainedToolExchanges',
        'userMessages', 'activeAliasOperations', 'omittedSnapshots'].filter(key => Number.isFinite(e[key])).map(key => [key, e[key]])) });
    if (e.type === 'text_delta' && state.visibleText.length < 20000) state.visibleText += (e.text || e.delta || '').slice(0, 20000 - state.visibleText.length);
    if (e.type === 'text_delta' && e.source === 'host' && e.layoutFacts) {
      const facts = e.layoutFacts, record = {};
      for (const key of ['molecules', 'atoms', 'bonds', 'electronFlows', 'reactionSteps', 'horizontalArrows'])
        if (Number.isSafeInteger(facts[key]) && facts[key] >= 0) record[key] = facts[key];
      if (Array.isArray(facts.pairedTokens)) record.pairedTokens = facts.pairedTokens.filter(token => typeof token === 'string' && /^(?:续\d+|接B?\d+)$/.test(token));
      state.hostLayoutCompletions.push(record);
    }
    if (e.type === 'tool_start') state.toolNames.push(e.toolName);
    if (e.type === 'tool_end') {
      const result = e.result?.result, context = e.result?.context;
      if (result && ['created', 'updated', 'deleted', 'cascaded'].some(key => result[key]?.length)) {
        state.receipts.push({ at: state.lastEventAt, runId: e.runId, toolName: e.toolName, success: e.isError === false,
          created: result.created || [], updated: result.updated || [], deleted: result.deleted || [], cascaded: result.cascaded || [] });
      }
      if (result?.canvas) state.lastCanvas = result.canvas;
      if (result?.steps?.length) {
        state.steps.push(...result.steps.map(step => ({ operationId: step.operationId, stepId: step.stepId, version: step.version,
          action: step.action, replayed: step.replayed, before: step.before, after: step.after, layout: step.layout, checks: step.checks })));
        for (const step of result.steps) {
          if (step.after === null) delete state.checks[step.stepId];
          else state.checks[step.stepId] = { stepId: step.stepId, version: step.version, checks: step.checks };
        }
      }
      for (const step of context?.reactionSteps || []) state.checks[step.stepId] = { stepId: step.stepId, version: step.version, checks: step.checks };
    }
    if (e.type === 'tool_end' || e.type === 'step_commit') state.snapshotChain = state.snapshotChain.catch(() => {}).then(async () => {
      try {
        const context = await k3dAPI.agent.getContext();
        state.lastCanvas = { atoms: context.atoms.length, bonds: context.bonds.length, molecules: context.molecules.length,
          arrows: context.arrows.length, reactionSteps: context.reactionSteps.length };
        state.lastSource = await k3dAPI.serializeWorkbench();
      } catch { state.snapshotError = 'snapshot_unavailable'; }
    });
    if (['tool_start', 'tool_end', 'step_commit', 'run_end', 'error'].includes(e.type)) {
      const result = e.result?.result;
      let denial;
      if (e.type === 'error') {
        if (['transport_interrupted', 'model_failed', 'test_request_limit', 'RUN_FAILED'].includes(e.code) &&
          state.pendingBudgetDenial?.runId === e.runId) denial = state.pendingBudgetDenial;
        state.terminalBudgetDenial = denial || null; state.pendingBudgetDenial = null;
      } else if (e.type === 'run_end' && state.terminalBudgetDenial?.runId === e.runId) denial = state.terminalBudgetDenial;
      state.events.push({ type: e.type, runId: e.runId, at: state.lastEventAt, toolName: e.toolName, isError: e.isError,
        status: e.status, code: e.code, diagnosticCode: e.diagnostic?.code, operationId: e.diagnostic?.operationId,
        ...(denial && { localCause: 'test_request_limit', budgetDenialId: denial.id }),
        ...(e.failureSource && { failureSource: e.failureSource }),
        ...(e.type === 'error' && { message: safeErrorMessage(denial ? 'test_request_limit' : e.code, e.message), fatal: e.fatal }),
        ...(e.type === 'run_end' && { reason: e.reason }),
        committedOperations: e.completedOperations, finishAccepted: result?.finishAccepted,
        finishRejected: result?.finishRejected, warnings: result?.warnings?.slice(0, 8) });
      if (state.events.length > 5000) state.events.shift();
    }
    emit();
  });
  window.__readLongRouteAudit = () => ({ realModelRequests: state.requests.length, requests: state.requests,
    requestBudget: state.requestBudget,
    toolNames: state.toolNames, events: state.events, steps: state.steps, receipts: state.receipts, contexts: state.contexts, currentChecks: Object.values(state.checks),
    visibleExplanation: state.visibleText.trim(), hostLayoutCompletions: state.hostLayoutCompletions, appliedBatches: state.appliedBatches, completionCalls: state.completionCalls, runStatus: state.runStatus, lastEventAt: state.lastEventAt,
    lastCanvas: state.lastCanvas, snapshotError: state.snapshotError,
    panelStatus: document.querySelector('.mol-agent-status')?.textContent || '',
    panelHasError: !!document.querySelector('.mol-agent-error:not([hidden])'),
    panelFailedToolCards: document.querySelectorAll('.mol-agent-tool.is-failed').length });
}

function chemicalCandidates(context) {
  const atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  const neighbors = new Map(context.atoms.map(atom => [atom.id, []]));
  for (const bond of context.bonds) { neighbors.get(bond.begin)?.push(bond.end); neighbors.get(bond.end)?.push(bond.begin); }
  const molecules = context.molecules.map(molecule => {
    const members = molecule.atoms.map(id => atoms.get(id)), heavy = members.filter(atom => atom.label !== 'H');
    const counts = heavy.reduce((result, atom) => ({ ...result, [atom.label]: (result[atom.label] || 0) + 1 }), {});
    const charge = members.reduce((sum, atom) => sum + (Number(atom.charge) || 0), 0);
    const methylOnNitrogen = members.filter(atom => atom.label === 'C' && Number(atom.implicitH) === 3 &&
      neighbors.get(atom.id).filter(id => atoms.get(id)?.label !== 'H').length === 1 &&
      neighbors.get(atom.id).some(id => atoms.get(id)?.label === 'N')).length;
    return { moleculeId: molecule.id, atomIds: molecule.atoms, counts, charge, methylOnNitrogen };
  });
  const exact = (molecule, expected) => Object.keys(molecule.counts).length === Object.keys(expected).length &&
    Object.entries(expected).every(([element, count]) => molecule.counts[element] === count);
  return { // These are structural candidate tests, not independent identity certificates.
    caffeineCandidates: molecules.filter(molecule => exact(molecule, { C: 8, N: 4, O: 2 }) && molecule.charge === 0 && molecule.methylOnNitrogen === 3),
    ureaCandidates: molecules.filter(molecule => exact(molecule, { C: 1, N: 2, O: 1 }) && molecule.charge === 0),
    cyanoaceticAcidCandidates: molecules.filter(molecule => exact(molecule, { C: 3, N: 1, O: 2 }) && molecule.charge === 0),
    nitriteCandidates: molecules.filter(molecule => exact(molecule, { N: 1, O: 2 }) && molecule.charge === -1),
  };
}

function diagramIdentity(context) {
  const byId = values => values.sort((a, b) => a.id.localeCompare(b.id));
  return canonical({
    atoms: byId(context.atoms.map(({ id, label, charge, isotope, radical, implicitH }) => ({ id, label, charge, isotope, radical, implicitH }))),
    bonds: byId(context.bonds.map(({ id, begin, end, order, stereo }) => ({ id, begin, end, order, stereo }))),
    molecules: context.molecules.map(molecule => [...molecule.atoms].sort()).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    arrows: byId(context.arrows.map(({ id, source, target, electronCount }) => ({ id, source, target, electronCount }))),
    lonePairs: byId(context.lonePairs.map(({ id, ownerAtomId }) => ({ id, ownerAtomId }))),
    steps: context.reactionSteps.map(({ stepId, reactants, products }) => ({ stepId,
      reactants: [...reactants].sort(), products: [...products].sort() })).sort((a, b) => a.stepId.localeCompare(b.stepId)),
  });
}

function seedEntitiesPreserved(seed, current, allowExtend = false) {
  if (!allowExtend) return diagramIdentity(seed) === diagramIdentity(current);
  const before = JSON.parse(diagramIdentity(seed)), after = JSON.parse(diagramIdentity(current));
  for (const key of ['atoms', 'bonds', 'arrows', 'lonePairs', 'steps']) {
    const idKey = key === 'steps' ? 'stepId' : 'id', index = new Map(after[key].map(item => [item[idKey], item]));
    if (index.size !== after[key].length || before[key].some(item => canonical(index.get(item[idKey])) !== canonical(item))) return false;
  }
  const seedAtoms = new Set(seed.atoms.map(atom => atom.id));
  const seedMolecules = new Set(before.molecules.map(item => canonical(item)));
  const currentMolecules = after.molecules.map(item => canonical(item));
  if (new Set(currentMolecules).size !== currentMolecules.length || [...seedMolecules].some(item => !currentMolecules.includes(item))) return false;
  if (current.molecules.some(molecule => molecule.atoms.some(id => seedAtoms.has(id)) &&
    !seedMolecules.has(canonical([...molecule.atoms].sort())))) return false;
  const seedBonds = new Set(seed.bonds.map(bond => bond.id));
  if (current.bonds.some(bond => !seedBonds.has(bond.id) && (seedAtoms.has(bond.begin) || seedAtoms.has(bond.end)))) return false;
  // These chemical/query descriptors are excluded from the old layout-mode
  // fingerprint, but continuation must not silently change them either.
  for (const key of ['atoms', 'bonds']) {
    const index = new Map(current[key].map(item => [item.id, item]));
    const fields = key === 'atoms' ? ['aromatic', 'hasQuery', 'stereoLabel', 'stereoParity', 'alias'] : ['aromatic', 'nativeType'];
    if (seed[key].some(item => fields.some(field => canonical(item[field]) !== canonical(index.get(item.id)?.[field])))) return false;
  }
  return true;
}

function reviewedSeedAudit(seed, current, stepIds, receipts = [], events = []) {
  const steps = seed.reactionSteps.filter(step => stepIds.includes(step.stepId));
  if (steps.length !== new Set(stepIds).size) return { pass: false, issues: [{ code: 'reviewed_step_missing' }], materializations: [] };
  const molecules = seed.molecules.filter(molecule => steps.some(step => [...step.reactants, ...step.products].some(id => molecule.atoms.includes(id))));
  const atoms = new Set(molecules.flatMap(molecule => molecule.atoms));
  const bonds = seed.bonds.filter(bond => atoms.has(bond.begin) && atoms.has(bond.end));
  const endpoint = ep => ep.type === 'bond' ? (() => { const bond = bonds.find(bond => bond.id === ep.bondId); return bond ? [bond.begin, bond.end] : []; })()
    : ep.type === 'lonePair' ? [ep.ownerAtomId] : ep.type === 'atom' ? [ep.atomId] : ep.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
  const arrows = seed.arrows.filter(arrow => steps.some(step => {
    const reactantAtoms = new Set(molecules.filter(molecule => molecule.atoms.some(id => step.reactants.includes(id))).flatMap(molecule => molecule.atoms));
    const source = endpoint(arrow.source), target = endpoint(arrow.target);
    return source.length && target.length && [...source, ...target].every(id => reactantAtoms.has(id));
  }));
  const prefix = { ...seed, atoms: seed.atoms.filter(atom => atoms.has(atom.id)), bonds, molecules, arrows,
    lonePairs: seed.lonePairs.filter(pair => atoms.has(pair.ownerAtomId)), reactionSteps: steps };
  return reviewedChemistryPreserved(prefix, current, receipts, events);
}

const reviewedSeedPreserved = (seed, current, stepIds, receipts, events) => reviewedSeedAudit(seed, current, stepIds, receipts, events).pass;

function seedEntityChanges(seed, current) {
  const before = JSON.parse(diagramIdentity(seed)), after = JSON.parse(diagramIdentity(current));
  return Object.fromEntries(Object.keys(before).map(key => {
    const identity = item => key === 'molecules' ? canonical(item) : item[key === 'steps' ? 'stepId' : 'id'];
    const old = new Map(before[key].map(item => [identity(item), item])), now = new Map(after[key].map(item => [identity(item), item]));
    return [key, { removed: before[key].filter(item => !now.has(identity(item))), added: after[key].filter(item => !old.has(identity(item))),
      changed: before[key].filter(item => now.has(identity(item)) && canonical(item) !== canonical(now.get(identity(item))))
        .map(item => ({ before: item, after: now.get(identity(item)) })) }];
  }));
}

function inspectLeftReagent(context, stepId) {
  const step = context.reactionSteps.find(item => item.stepId === stepId), atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  if (!step) return { status: 'failed', stepId, reason: 'requested_step_missing' };
  const reactants = [...new Set(step.reactants.map(ref => context.molecules.find(molecule => molecule.atoms.includes(ref))))].filter(Boolean);
  const chloride = reactants.find(molecule => molecule.atoms.length === 1 && atoms.get(molecule.atoms[0])?.label === 'Cl' && atoms.get(molecule.atoms[0])?.charge === -1);
  if (!chloride) return { status: 'failed', stepId, reason: 'chloride_reactant_missing' };
  const donor = atoms.get(chloride.atoms[0]);
  const attack = context.arrows.find(arrow => (arrow.source.ownerAtomId || arrow.source.atomId) === donor.id &&
    (arrow.target.type === 'atom' || arrow.target.type === 'formingBond'));
  const targetId = attack?.target.type === 'atom' ? attack.target.atomId :
    [attack?.target.atomA, attack?.target.atomB].find(id => id && id !== donor.id);
  const target = atoms.get(targetId);
  if (!target) return { status: 'failed', stepId, reason: 'actual_attack_site_missing' };
  const distance = Math.hypot(donor.x - target.x, donor.y - target.y);
  return { status: donor.x < target.x - 0.1 && distance <= 6 ? 'passed' : 'failed', stepId,
    donor: { atomId: donor.id, x: donor.x, y: donor.y }, attackedAtom: { atomId: target.id, x: target.x, y: target.y }, distance,
    reference: 'Actual attacked atom, not the molecule bounding-box centre.' };
}

function observeElectronGeometry() {
  const MW = MolWorkbench, ctx = MW.app.controller.ctx(), scene = MW.route.buildScene(ctx, MW.app.controller.model);
  const unit = Math.max(0.2, scene.L || 1);
  const component = new Map();
  const walk = (atom, seen) => {
    if (seen.has(atom)) return;
    seen.add(atom);
    for (const bond of ctx.bonds()) {
      if (bond.beginAtom === atom) walk(bond.endAtom, seen);
      else if (bond.endAtom === atom) walk(bond.beginAtom, seen);
    }
  };
  for (const atom of ctx.atoms()) if (!component.has(atom.uuid)) {
    const ids = new Set(); walk(atom.uuid, ids); for (const id of ids) component.set(id, atom.uuid);
  }
  const endpoint = ep => ep.type === 'bond' ? (() => { const bond = ctx.bondInfo(ep.bondId); return bond ? [bond.beginAtom, bond.endAtom] : []; })()
    : MW.model.endpointAtomIds(ep);
  return MW.app.controller.model.state.arrows.map(arrow => {
    const geometry = MW.model.arrowGeometry(arrow, ctx);
    const intermolecular = new Set([...endpoint(arrow.source), ...endpoint(arrow.target)].map(id => component.get(id))).size > 1;
    const readability = MW.route.assessReadability({ ...geometry, L: unit, intermolecular });
    const endpointValid = geometry.sourceOk === true && geometry.targetOk === true && !geometry.degenerate;
    return { id: arrow.id, intermolecular, ...readability, readable: readability.readable && endpointValid,
      reasons: [...readability.reasons, ...(!endpointValid ? ['invalid_endpoint_geometry'] : [])],
      sourceOk: geometry.sourceOk, targetOk: geometry.targetOk, degenerate: !!geometry.degenerate,
      start: geometry.start, control: geometry.control, end: geometry.end };
  });
}

let win, done = false, progressTimer, progressBusy = false, hardStop;
const zeroOutputAttempts = new Set();
activeDeadline = NODE_PHASE_ARGUMENT_TEST ? null : createActiveDeadline(TIMEOUT, () => {
  report.timedOut = true; report.timeoutCause = 'active_work_deadline'; report.status = 'stopping'; write();
  win?.webContents.executeJavaScript('molstudioAgent?.stop?.("long_case_timeout")').catch(() => {});
  hardStop = setTimeout(() => { report.ok = false; report.status = 'timeout'; write(); win?.destroy(); app.exit(2); }, 15000);
});

if (NODE_PHASE_ARGUMENT_TEST) runPhaseArgumentTests();
else app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1540, height: 1040, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const refresh = async () => {
    if (done || progressBusy) return;
    progressBusy = true;
    try {
      const controlFile = path.join(OUT, 'active-control.json');
      const decision = zeroOutputStopDecision(report.progress, zeroOutputLimitMs, Date.now());
      if (!fs.existsSync(controlFile) && decision && !zeroOutputAttempts.has(decision.request)) {
        zeroOutputAttempts.add(decision.request); report.zeroOutputTestBudget.decisions.push({ at: new Date().toISOString(), ...decision });
        fs.writeFileSync(controlFile, JSON.stringify({ action: 'stop', reason: 'task_refinement' }));
      }
      if (fs.existsSync(controlFile)) {
        const command = parseActiveControl(JSON.parse(fs.readFileSync(controlFile, 'utf8')));
        const control = { ...command, id: 'task-refinement-' + (report.activeControls.length + 1), at: new Date().toISOString(), phase: report.activePhase };
        if (decision && zeroOutputAttempts.has(decision.request)) Object.assign(control, decision);
        fs.renameSync(controlFile, path.join(OUT, control.id + '.json'));
        const result = await js(`(()=>{const rt=molstudioAgent.getRuntime(),p=window.__longRouteProbe;
          const active=p.requests.filter(request=>!request.finishedAt);
          if(!rt.isRunning||!active.length)return{applied:false,reason:'no_inflight_request'};
          if(active.some(request=>request.sse?.errorEvent||request.responseStatus>=400||request.transportError||request.errorCode))return{applied:false,reason:'failure_already_observed'};
          if(active.some(request=>request.sseCounts?.oversizedEvents))return{applied:false,reason:'unclassified_oversized_event'};
          if(active.some(request=>request.sseCounts?.toolArgumentBytes||request.sseCounts?.toolCalls))return{applied:false,reason:'tool_fragment_in_flight'};
          const record=${JSON.stringify(control)};record.runId=p.currentRunId;
          for(const request of active)request.intentionalCancellation=record;
          molstudioAgent.stop('user');return{applied:true,runId:p.currentRunId,requests:active.map(request=>request.number)};
        })()`);
        Object.assign(control, result); report.activeControls.push(control); write();
      }
      const audit = await js('window.__readLongRouteAudit?.() || null');
      if (audit && !done) {
        report.progress = audit; report.realModelRequests = audit.realModelRequests; report.status = report.awaitingReview ? 'awaiting_independent_review' : audit.runStatus; report.requestBudget = audit.requestBudget;
        const phase = report.phases?.find(item => item.number === report.activePhase);
        if (phase && !phase.finishedAt) { phase.status = audit.runStatus; phase.requests = audit.realModelRequests - phase.requestStart; phase.canvas = audit.lastCanvas; }
        const source = await js('window.__longRouteProbe?.lastSource || null');
        if (source && !done) fs.writeFileSync(path.join(OUT, 'progress.molwork'), source);
        if (!report.generatingProgressImage && audit.requests.some(request => request.bytes > 0 && !request.finishedAt)) {
          const ui = await js(`(()=>{const panel=molstudioAgent.getPanel(),box=panel.footer.getBoundingClientRect();return{status:panel.status.textContent,elapsed:panel.elapsed?.textContent,received:panel.transportProgress?.textContent,stopAvailable:!panel.stopButton.hidden&&!panel.stopButton.disabled,thinkingFolded:[...document.querySelectorAll('.mol-agent-thinking')].every(node=>!node.open),rect:{x:Math.floor(box.x),y:Math.floor(box.y),width:Math.ceil(box.width),height:Math.ceil(box.height)}}})()`);
          if (ui.received && ui.stopAvailable && ui.thinkingFolded) {
            fs.writeFileSync(path.join(OUT, 'model-generating-progress.png'), (await win.capturePage(ui.rect)).toPNG());
            report.generatingProgressImage = { file: 'model-generating-progress.png', ...ui, scope: 'Actual live model footer only; no assistant or thinking text.' };
          }
        }
        write();
      }
    } catch { /* The final read reports an unavailable renderer explicitly. */ }
    finally { progressBusy = false; }
  };
  const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  const exportArtifacts = async (prefix = 'long-route') => {
    const record = file => { if (!report.artifacts.includes(file)) report.artifacts.push(file); };
    const source = await js('k3dAPI.serializeWorkbench()');
    fs.writeFileSync(path.join(OUT, prefix + '.molwork'), source); record(prefix + '.molwork');
    for (const kind of ['svg', 'png']) {
      const result = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(kind) + ')');
      if (result?.ok) { fs.writeFileSync(path.join(OUT, prefix + '.' + kind), Buffer.from(result.dataUrl.split(',')[1], 'base64')); record(prefix + '.' + kind); }
      else report.artifactErrors = [...(report.artifactErrors || []), prefix + '.' + kind + '_export_failed'];
    }
    fs.writeFileSync(path.join(OUT, prefix + '-window.png'), (await win.capturePage()).toPNG()); record(prefix + '-window.png');
    return source;
  };
  win.webContents.on('console-message', event => {
    if (!event.message.startsWith('MOLSTUDIO_LONG_PROGRESS ')) return;
    try { report.live = JSON.parse(event.message.slice('MOLSTUDIO_LONG_PROGRESS '.length)); report.realModelRequests = report.live.realModelRequests; if (!done) write(); } catch {}
  });
  win.webContents.on('render-process-gone', (_, details) => report.browserErrors.push({ reason: details.reason, exitCode: details.exitCode }));
  try {
    await win.loadURL(report.service + '/canvas.html');
    const started = Date.now();
    while (!await js('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()')) {
      if (Date.now() - started > 35000) throw new Error('Canvas/runtime did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    report.resourceHashes = await js(`(async()=>{
      const result={};for(const url of ['/agent/dist/agent-runtime.js','/workbench/agent-bridge.js','/workbench/reaction-graph-layout.js','/workbench/reaction-reagent-placement.js','/workbench/mechanism-controller.js','/workbench/mechanism-model.js','/workbench/mechanism-route.js','/workbench/mechanism-export.js','/workbench/workbench-storage.js']){
        const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('Cannot fingerprint '+url);
        const hash=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
        result[url]=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      }return result;
    })()`);
    await js('(async()=>{molstudioAgent.getRuntime().reset();molstudioAgent.getPanel().clear();await k3dAPI.setMolecule("");MolWorkbench.app.adapter.ed.clearHistory();molstudioAgent.open();})()');
    let seedContext, seedDocument;
    if (SEED_FILE) {
      const seeded = await js('(async()=>{const loaded=await k3dAPI.loadWorkbench(' + JSON.stringify(SEED_SOURCE) +
        ');return{loaded,context:await k3dAPI.agent.getContext()};})()');
      if (!seeded.loaded.ok) throw new Error('The requested molwork seed could not be loaded');
      seedContext = seeded.context; seedDocument = JSON.parse(SEED_SOURCE); report.seedLoaded = true;
      if (RESUME_SEED && seedDocument.agentTask) {
        const task = seedDocument.agentTask;
        report.seedCheckpoint = { taskId: task.taskId, mode: task.mode, status: task.status, pauseReason: task.pauseReason,
          phaseIndex: task.phaseIndex, requestIndex: task.requestIndex, completedOperationIds: task.completedOperationIds || [] };
      }
      fs.writeFileSync(path.join(OUT, 'seed-context.json'), JSON.stringify(seedContext, null, 2)); report.artifacts.push('seed-context.json');
      report.seedCounts = { atoms: seedContext.atoms.length, molecules: seedContext.molecules.length,
        steps: seedContext.reactionSteps.length, electronFlows: seedContext.arrows.length };
    }
    await js('(' + installProbe.toString() + ')(' + LIMIT + ',' + observeModelResponse.toString() + ',' + safeRuntimeErrorMessage.toString() + ',' + enforceModelRequestBudget.toString() + ',' + modelRequestMetrics.toString() + ')');
    progressTimer = setInterval(refresh, 5000);
    report.status = 'running'; write();
    let nextPhaseAction = 'send', reviewFinished = false;
    if (!PHASES_FILE && RESUME_SEED) {
      await js('molstudioAgent.getRuntime().restoreTaskCheckpoint()');
      report.runResult = await js('molstudioAgent.getRuntime().continue()');
    } else if (!PHASES_FILE) report.runResult = await js('molstudioAgent.send(' + JSON.stringify(PROMPT) + ')');
    else for (let index = 0; index < PHASE_PROMPTS.length; index++) {
      const before = await js('window.__readLongRouteAudit()');
      const phase = { number: index + 1, prompt: PHASE_PROMPTS[index], status: 'running', startedAt: new Date().toISOString(),
        requestStart: before.realModelRequests, requests: 0, operationCount: null, artifacts: [] };
      report.phases.push(phase); report.activePhase = phase.number; write();
      phase.action = nextPhaseAction;
      phase.resumedOperations = nextPhaseAction === 'continue' ? await js('molstudioAgent.getRuntime()._resumeState?.applied?.size || 0') : 0;
      try { report.runResult = await js(nextPhaseAction === 'continue' ? 'molstudioAgent.getRuntime().continue()' : 'molstudioAgent.send(' + JSON.stringify(PHASE_PROMPTS[index]) + ')'); }
      catch { report.runResult = { status: 'error', completedOperations: 0 }; phase.errorCode = 'phase_execution_failed'; }
      const audit = await js('window.__readLongRouteAudit()');
      phase.status = report.runResult.status; phase.runResult = report.runResult; phase.requestEnd = audit.realModelRequests;
      phase.requests = phase.requestEnd - phase.requestStart; phase.operationCount = Math.max(0, (report.runResult.completedOperations || 0) - phase.resumedOperations);
      phase.finishedAt = new Date().toISOString(); report.realModelRequests = audit.realModelRequests;
      const context = await js('k3dAPI.agent.getContext()');
      phase.canvas = { atoms: context.atoms.length, molecules: context.molecules.length, steps: context.reactionSteps.length, flows: context.arrows.length };
      const prefix = 'phase-' + String(phase.number).padStart(2, '0'), artifactStart = report.artifacts.length;
      fs.writeFileSync(path.join(OUT, prefix + '-context.json'), JSON.stringify(context, null, 2)); report.artifacts.push(prefix + '-context.json');
      await exportArtifacts(prefix); phase.artifacts = report.artifacts.slice(artifactStart);
      phase.artifactsComplete = ['.molwork', '.png', '.svg'].every(ext => phase.artifacts.includes(prefix + ext));
      report.totalCompletedOperations = report.phases.reduce((count, item) => count + (item.operationCount || 0), 0);
      write();
      if (REVIEW_GATE) {
        activeDeadline.pause();
        report.awaitingReview = phase.number; report.status = 'awaiting_independent_review'; write();
        const commandFile = path.join(OUT, 'next-task.json');
        while (!fs.existsSync(commandFile)) await new Promise(resolve => setTimeout(resolve, 250));
        const command = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
        fs.renameSync(commandFile, path.join(OUT, 'review-after-phase-' + phase.number + '.json'));
        delete report.awaitingReview;
        if (!activeDeadline.resume()) throw new Error('The active acceptance deadline has expired');
        if (command.requestLimit !== undefined) {
          if (!Number.isInteger(command.requestLimit) || command.requestLimit < report.requestLimit || command.requestLimit > 120) throw new Error('A reviewed harness budget can only increase, to at most 120 requests');
          await js('window.__longRouteProbe.requestBudget.limit=' + command.requestLimit);
          report.budgetChanges.push({ at: new Date().toISOString(), afterPhase: phase.number, from: report.requestLimit, to: command.requestLimit,
            reason: 'explicit review checkpoint budget increase; user model settings unchanged' });
          report.requestLimit = command.requestLimit;
        }
        if (command.zeroOutputLimitMs !== undefined) {
          if (!Number.isInteger(command.zeroOutputLimitMs) || command.zeroOutputLimitMs !== 0 &&
              (command.zeroOutputLimitMs < 30000 || command.zeroOutputLimitMs > 300000)) throw new Error('Invalid local zero-output test budget');
          report.zeroOutputTestBudget.changes.push({ at: new Date().toISOString(), afterPhase: phase.number, from: zeroOutputLimitMs, to: command.zeroOutputLimitMs });
          report.zeroOutputTestBudget.limitMs = zeroOutputLimitMs = command.zeroOutputLimitMs;
        }
        if (command.action === 'finish') { reviewFinished = true; break; }
        if (!['send', 'continue'].includes(command.action)) throw new Error('Review command must send, continue or finish');
        nextPhaseAction = command.action;
        PHASE_PROMPTS.push(command.action === 'continue' ? 'Explicit user continuation of the previous phase.' : parsePhasePrompts([command.prompt])[0]);
        write(); continue;
      }
      if (phase.status !== 'completed') { report.stoppedAfterPhase = phase.number; break; }
    }
    clearInterval(progressTimer); await refresh();
    report.audit = await js('window.__readLongRouteAudit()'); report.realModelRequests = report.audit.realModelRequests;
    if (CHECK_NATIVE_HISTORY) {
      const snapshot = async () => await js('(async()=>({context:await k3dAPI.agent.getContext(),source:await k3dAPI.serializeWorkbench(),history:MolWorkbench.app.adapter.ed.historySize()}))()');
      const fingerprint = value => {
        const saved = JSON.parse(value.source);
        const rounded = item => typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : Array.isArray(item) ? item.map(rounded)
          : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, rounded(value)])) : item;
        return canonical(rounded({ semantics: JSON.parse(semanticSnapshot(value.context, saved.reactionSteps)),
          atoms: value.context.atoms.map(({id,x,y})=>({id,x,y})).sort((a,b)=>a.id.localeCompare(b.id)),
          native: value.context.reactionArrows, mechanism: saved.mechanism, steps: saved.reactionSteps }));
      };
      const before = await snapshot();
      report.nativeHistory = { before: before.history, undoChanged: false, redoRestored: false, undoTransactions: 0 };
      if (before.history.undo > 0) {
        let undone;
        // A final atom O->N->O transaction can have no net diagram change.
        // Walk past such entries to an actual generated edit, then redo every
        // entry so the final source and the native history cursor are restored.
        try {
          while (report.nativeHistory.undoTransactions < Math.min(32, before.history.undo)) {
            await js('document.activeElement?.blur?.();k3dAPI.undo()');
            report.nativeHistory.undoTransactions++;
            undone = await snapshot();
            if (fingerprint(undone) !== fingerprint(before)) break;
          }
        } finally {
          for (let count = 0; count < report.nativeHistory.undoTransactions; count++) await js('document.activeElement?.blur?.();k3dAPI.redo()');
        }
        const redone = await snapshot();
        report.nativeHistory.undoChanged = fingerprint(undone) !== fingerprint(before);
        report.nativeHistory.redoRestored = fingerprint(redone) === fingerprint(before) && canonical(redone.history) === canonical(before.history);
        for (const [label, value] of [['before', before], ['undo', undone], ['redo', redone]]) {
          const file = 'native-history-' + label + '.molwork'; fs.writeFileSync(path.join(OUT, file), value.source); report.artifacts.push(file);
        }
      }
      check('the actual generated native transaction undoes and redoes with stable chemistry, IDs and geometry',
        report.nativeHistory.undoChanged && report.nativeHistory.redoRestored, report.nativeHistory);
    }
    const context = await js('k3dAPI.agent.getContext()'), source = await exportArtifacts(), saved = JSON.parse(source);
    if (RESUME_SEED && saved.agentTask) {
      const task = saved.agentTask;
      report.finalCheckpoint = { taskId: task.taskId, mode: task.mode, status: task.status, pauseReason: task.pauseReason,
        phaseIndex: task.phaseIndex, requestIndex: task.requestIndex, completedOperationIds: task.completedOperationIds || [] };
    }
    fs.writeFileSync(path.join(OUT, 'long-route-context.json'), JSON.stringify(context, null, 2)); report.artifacts.push('long-route-context.json');
    report.graph = inspectGraph(context, saved.reactionSteps || []);
    report.chemistry = await inspectChemistry(context); report.candidates = chemicalCandidates(context);
    if (IS_ROBINSON) report.robinson = inspectRobinson(context, report.graph);
    report.electronGeometry = await js('(' + observeElectronGeometry.toString() + ')()');
    if (seedContext && PROTECTED_STEPS) {
      const preserved = reviewedSeedAudit(seedContext, context, PROTECTED_STEPS, report.audit.receipts, report.audit.events);
      report.seedPreserved = preserved.pass;
      report.seedRepresentationAudit = { pass: preserved.pass, issues: preserved.issues, materializations: preserved.materializations };
    } else if (seedContext) report.seedPreserved = seedEntitiesPreserved(seedContext, context, SEED_EXTEND);
    if (seedContext && PROTECTED_STEPS) report.seedEntityChanges = seedEntityChanges(seedContext, context);
    if (LEFT_STEP_REF) {
      const stepId = seedDocument?.reactionStepOperations?.find(operation => operation.id === LEFT_STEP_REF)?.stepId || LEFT_STEP_REF;
      report.leftReagent = inspectLeftReagent(context, stepId);
    }
    const graph = report.graph, expected = report.coverageExpectations;
    const layoutPassed = graph.stepCount > 0 && graph.acyclic && graph.validReferences && graph.uniqueStepIds && graph.endpointReferencesValid &&
      graph.portsPaired && graph.linkedNative.every(step => step.count === 1 && step.horizontalRightward && step.layout.status === 'passed') &&
      report.electronGeometry.every(arrow => arrow.readable) && (!LEFT_STEP_REF || report.leftReagent.status === 'passed');
    const chemistryPassed = report.chemistry.length > 0 && report.chemistry.every(step => step.status === 'passed') && !graph.unassignedFlows.length &&
      (!IS_ROBINSON || robinsonChemistryAccepted(report.robinson));
    const coveragePassed = graph.stepCount >= expected.minimumSteps && graph.longestPath >= expected.minimumMainline &&
      (!expected.preparationMerge || graph.merges.length > 0 && graph.roots.length > 1 && graph.nonlocalCueCount > 0) &&
      (!expected.initialUreaAndCyanoaceticAcid || report.candidates.ureaCandidates.length > 0 && report.candidates.cyanoaceticAcidCandidates.length > 0 && report.candidates.nitriteCandidates.length > 0) &&
      (!expected.caffeineTarget || report.candidates.caffeineCandidates.length > 0) && (!seedContext || report.seedPreserved) &&
      (!IS_ROBINSON || report.robinson.pass);
    const phasesCompleted = !PHASES_FILE || (REVIEW_GATE ? reviewFinished && report.phases.at(-1)?.status === 'completed'
      : report.phases.length === PHASE_PROMPTS.length && report.phases.every(phase => phase.status === 'completed'));
    const completed = phasesCompleted && report.runResult.status === 'completed' && report.audit.panelStatus === '已完成' && !report.audit.panelHasError;
    report.transportAssessment = assessModelTransport(report.audit);
    report.budgetAssessment = assessModelRequestBudget(report.audit); report.requestBudget = report.audit.requestBudget;
    const transportFailed = report.transportAssessment.failed;
    const budgetExhausted = report.budgetAssessment.exhausted;
    const refinedTask = report.activeControls.some(control => control.applied && control.runId === report.runResult.runId);
    report.classification = { transportFailure: transportFailed, requestBudgetExhausted: budgetExhausted,
      intentionalTaskRefinement: refinedTask, chemistryFailure: !chemistryPassed,
      layoutFailure: !layoutPassed, requestedCoverageMissing: !coveragePassed, incompleteRuntimeStatus: !completed,
      declaredChemicalUncertainty: /(?:无法|不能|不确定|需要.{0,20}(?:条件|确认|电子|信息)|uncertain|cannot|unable)/i.test(report.audit.visibleExplanation) };
    check('real gateway requests stay within the explicit budget', report.realModelRequests > 0 && report.realModelRequests <= report.requestLimit);
    check('the requested task completes without exhausting the local request budget', !budgetExhausted, report.budgetAssessment);
    check('runtime and panel agree that the requested drawing is complete', completed);
    if (PHASES_FILE) {
      check(REVIEW_GATE ? 'the final reviewed task completes with every prior phase outcome preserved on this canvas'
        : 'all requested phases completed sequentially without resetting the canvas', phasesCompleted,
        report.phases.map(phase => ({ number: phase.number, status: phase.status, requests: phase.requests, operationCount: phase.operationCount })));
      check('every attempted phase retains PNG SVG and editable molwork evidence', report.phases.every(phase => phase.artifactsComplete), report.phases.map(phase => ({ number: phase.number, artifacts: phase.artifacts })));
    }
    check('actual step graph has valid stable references and is acyclic', graph.acyclic && graph.validReferences && graph.uniqueStepIds);
    check('each actual elementary step has supported electron-flow coverage', chemistryPassed,
      { stepFailures: report.chemistry.filter(step => step.status !== 'passed'), ...(IS_ROBINSON && { caseFailures: report.robinson.checks.filter(item => !item.pass) }) });
    check('all observed native arrows, actual ports and per-step layout checks pass', layoutPassed, graph.layoutFailures);
    check(IS_ROBINSON ? 'the result covers the documented Robinson inputs, catalytic route and correct six/six target'
      : 'the result covers a long mainline, preparation merge and the requested chemical target', coveragePassed,
      { expected, steps: graph.stepCount, longestPath: graph.longestPath, roots: graph.roots.length,
        merges: graph.merges.length, nonlocalCues: graph.nonlocalCueCount, caffeineCandidates: report.candidates.caffeineCandidates.length });
    check('every step keeps its own real electron-flow endpoints', graph.endpointReferencesValid && !graph.unassignedFlows.length);
    check('wrap/branch/merge cues are paired and anchored to the actual physical structures', graph.portsPaired);
    check('every actual electron-flow curve has valid endpoints and readable shape', report.electronGeometry.every(arrow => arrow.readable),
      report.electronGeometry.filter(arrow => !arrow.readable));
    if (IS_ROBINSON) check('Robinson structure, C–C flow and catalyst witnesses pass without fixing microscopic step count', report.robinson.pass, report.robinson);
    if (IS_ROBINSON) check('no identified proton-accounting gap remains without supporting electron flow',
      !report.robinson.requiresManualReview, report.robinson.mechanisticNotes?.filter(note => note.status === 'needs_evidence'));
    if (seedContext) check(PROTECTED_STEPS ? 'all reviewed prefix chemistry survives while unreviewed suffix changes remain explicitly recorded'
      : SEED_EXTEND ? 'all original seed entities and molecule memberships survive unchanged while additions are allowed'
      : 'all seeded structures, stable steps and electron-flow identities are preserved', report.seedPreserved, report.seedCounts);
    if (LEFT_STEP_REF) check('the preparation-merge chloride is left of its actual attacked atom', report.leftReagent.status === 'passed', report.leftReagent);
    check('PNG SVG and editable molwork artifacts are all available', ['long-route.png', 'long-route.svg', 'long-route.molwork'].every(file => report.artifacts.includes(file)));
    report.ok = report.checks.every(item => item.pass) && !report.timedOut;
    report.outcome = report.ok ? TRANSPORT_DIAGNOSTIC ? 'diagnostic_passed' : 'passed' : transportFailed ? 'transport_failure' : budgetExhausted ? 'request_budget_exhausted' : refinedTask ? 'task_refinement_stopped' : !chemistryPassed ? 'chemistry_incomplete'
      : !layoutPassed ? 'layout_failure' : !coveragePassed ? 'coverage_incomplete' : 'runtime_incomplete';
    report.status = report.ok ? TRANSPORT_DIAGNOSTIC ? 'diagnostic_completed' : 'completed' : 'acceptance_failed';
  } catch (error) {
    report.ok = false; report.status = report.timedOut ? 'timeout' : 'harness_failed'; report.failure = String(error.message || error).slice(0, 1000);
    await js('molstudioAgent?.stop?.("long_acceptance_failed")').catch(() => {});
    report.audit = await js('window.__readLongRouteAudit?.() || null').catch(() => report.audit);
    if (report.audit) report.realModelRequests = report.audit.realModelRequests;
    await exportArtifacts().catch(() => {});
  } finally {
    done = true; clearInterval(progressTimer); activeDeadline?.cancel(); clearTimeout(hardStop);
    if (report.audit) {
      report.transportAssessment = assessModelTransport(report.audit); report.budgetAssessment = assessModelRequestBudget(report.audit);
      report.requestBudget = report.audit.requestBudget;
      report.classification = { ...report.classification, transportFailure: report.transportAssessment.failed,
        requestBudgetExhausted: report.budgetAssessment.exhausted };
      if (report.budgetAssessment.exhausted && !report.transportAssessment.failed) { report.ok = false; report.outcome = 'request_budget_exhausted'; }
    }
    report.standardTransportAcceptance = TRANSPORT_DIAGNOSTIC ? 'not_evaluated' : report.ok ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString(); write();
    console.log(JSON.stringify({ application: report.application, page: report.page, build: report.build,
      transportVariant: report.transportVariant, standardTransportAcceptance: report.standardTransportAcceptance,
      ok: report.ok, outcome: report.outcome, realModelRequests: report.realModelRequests,
      steps: report.graph?.stepCount, flows: report.graph?.flowCount, classification: report.classification,
      passed: report.checks.filter(item => item.pass).length, total: report.checks.length, failure: report.failure, out: OUT }, null, 2));
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
});
