// Isolated Electron profile, real application/chemistry engine, synthetic SSE
// first and at most ten explicitly enabled real model requests. Never reads keys.
'use strict';
// Pure Node regression for the caffeine acceptance audit, without Electron/model:
// node fusion/tests/test_agent_integration.cjs --test-caffeine-audit
const NODE_CAFFEINE_AUDIT = process.argv.includes('--test-caffeine-audit');
const { app, BrowserWindow } = NODE_CAFFEINE_AUDIT ? {} : require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.MOLSTUDIO_AGENT_TEST_OUT ? path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT) : path.resolve(__dirname, '../../.jez/artifacts/agent-integration-validation');
const PAPER_MODE = process.env.MOLSTUDIO_AGENT_PAPER_MODE === '1';
const CAPTURE_TRANSACTIONS = process.env.MOLSTUDIO_AGENT_CAPTURE_TRANSACTIONS === '1';
let flushTransactionArtifacts = async () => {};
if (!NODE_CAFFEINE_AUDIT) {
  fs.mkdirSync(OUT, { recursive: true });
  app.setPath('userData', path.join(OUT, 'electron-profile'));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function inspectPaperLabel(source) {
  const workbench = typeof source === 'string' ? JSON.parse(source) : source;
  const texts = (workbench.ket?.root?.nodes || []).filter(node => node.type === 'text').map(node =>
    (node.paragraphs || []).map(paragraph => (paragraph.parts || []).map(part => part.text || '').join('')).join('\n'));
  return { nativeTextCount: texts.length, exactText: texts.some(text => text === 'A'.repeat(100)),
    textLengths: texts.map(text => text.length) };
}
const report = { application: 'MolStudio canvas', page: 'fusion/canvas.html',
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron test window',
  paperMode: PAPER_MODE,
  scope: 'Real canvas/app/RDKit with synthetic SSE; optional live model requests use server-side credentials only.', checks: [], real: [], errors: [] };
const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
const watchdog = NODE_CAFFEINE_AUDIT ? null : setTimeout(async () => { await flushTransactionArtifacts(); fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...report, timedOut: true }, null, 2)); app.exit(2); }, Number(process.env.MOLSTUDIO_AGENT_WATCHDOG_MS) || 240_000);

// Optional test-only observer. Native serialization and model getters avoid the
// normal save command, which may finish a user's open text editor. No provider
// configuration, request headers, tokens, or raw streaming response is read.
function installTransactionObserver() {
  const state = window.__agentIntegration, api = k3dAPI.agent, app = MolWorkbench.app;
  const original = api.applyOperations, records = state.transactions = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const observerState = () => JSON.stringify({ fence: app.agentTask?.captureFence?.(),
    history: app.adapter.ed.historySize(), dirty: window.__mechDirtyTick || 0,
    selection: app.adapter.ed.selection(), documentSelection: [...app.documentController.selection],
    mechanismSelection: [...app.controller.selection], zoom: app.adapter.ed.zoom(),
    viewBox: app.adapter.canvasSvg()?.getAttribute('viewBox') });
  const snapshot = record => {
    try {
      const before = observerState(), adapter = app.adapter;
      const native = adapter.doc.defaultView.molstudioNativeActions;
      const ket = JSON.parse(native.serialize(adapter.struct())), bindings = adapter.mapRuntimeToKet(ket);
      if (bindings.error) throw new Error(bindings.error);
      const source = MolWorkbench.storage.serializeWorkbench({ ket,
        bindings: { atoms: bindings.atoms, bonds: bindings.bonds }, mechanism: app.controller.model.state,
        ...(app.documentController.active && { document: app.documentController.getState() }),
        reactionSteps: app.reactionSteps?.export(ket), reactionStepOperations: app.reactionSteps?.exportOperations?.(),
        agentTask: app.agentTask?.export() });
      const unchanged = before === observerState();
      record.observerUnchanged = record.observerUnchanged !== false && unchanged;
      return { source, history: clone(adapter.ed.historySize()), atoms: adapter.struct().atoms.size,
        arrows: app.controller.model.state.arrows.length, steps: app.reactionSteps?.export(ket).length || 0 };
    } catch (error) {
      (record.captureErrors ||= []).push(String(error.message || error));
      return { error: String(error.message || error) };
    }
  };
  api.applyOperations = async function (operations, settings) {
    const record = { sequence: records.length + 1, mode: state.mode, startedAt: new Date().toISOString(),
      runId: settings?.runId, operationIds: operations?.map?.(op => op?.id),
      operationTypes: operations?.map?.(op => op?.type), status: 'pending' };
    records.push(record);
    try { record.operations = clone(operations); } catch (_) { record.captureErrors = ['Operations cannot be serialized']; }
    record.before = snapshot(record);
    try {
      const result = await original.apply(this, arguments);
      record.status = 'succeeded';
      // Successful calls retain small counts. Full before/after sources are
      // retained only on failure (or an interrupted pending call).
      delete record.before.source;
      delete record.operations;
      record.result = { created: result?.created?.length || 0, updated: result?.updated?.length || 0,
        deleted: result?.deleted?.length || 0 };
      return result;
    } catch (error) {
      record.status = 'failed';
      record.error = { name: error?.name, message: String(error?.message || error) };
      for (const key of ['code', 'phase', 'operationId', 'operationType', 'relatedOperationIds',
        'layoutFailures', 'diagnostic', 'issues', 'stepId']) {
        if (error?.[key] !== undefined) { try { record.error[key] = clone(error[key]); } catch (_) {} }
      }
      record.after = snapshot(record);
      throw error;
    } finally { record.finishedAt = new Date().toISOString(); }
  };
  state.transactionObserverBridge = state.rt._bridge() === api;
}

function inspectAcetal(context, toKetal = false) {
  const atoms = new Map(context.atoms.map(atom => [atom.id, atom]));
  const heavy = atom => atom.neighbors.map(n => ({ atom: atoms.get(n.uuid), order: n.order }))
    .filter(n => n.atom.label !== 'H');
  const structures = new Map();
  for (const molecule of context.molecules) {
    const members = molecule.atoms.map(id => atoms.get(id));
    const carbons = members.filter(a => a.label === 'C'), oxygens = members.filter(a => a.label === 'O');
    const central = carbons.find(a => heavy(a).filter(n => n.order === 1 && n.atom.label === 'C' && heavy(n.atom).length === 1).length === 2);
    const oxygenBonds = central ? heavy(central).filter(n => n.atom.label === 'O') : [];
    const ethoxy = oxygen => {
      const links = heavy(oxygen);
      const tail = links.find(n => n.atom !== central);
      if (links.length !== 2 || tail?.atom.label !== 'C' || tail.order !== 1) return false;
      const ethyl = heavy(tail.atom);
      return ethyl.length === 2 && ethyl.some(n => n.order === 1 && n.atom.label === 'C' && heavy(n.atom).length === 1);
    };
    let kind;
    if (carbons.length === 3 && oxygens.length === 1 && oxygenBonds[0]?.order === 2) {
      if (oxygens[0].charge === 1) kind = 'protonatedAcetone';
      else if (oxygens[0].charge === 0) kind = 'acetone';
    } else if (toKetal && carbons.length === 3 && oxygens.length === 1 && oxygenBonds[0]?.order === 1 &&
        central.charge === 1 && oxygens[0].charge === 0) {
      kind = 'protonatedAcetone'; // The alternate resonance depiction has a C+ acceptor.
    } else if (carbons.length === 5 && oxygens.length === 2 && oxygenBonds.length === 2 && oxygenBonds.every(n => n.order === 1)) {
      const alkoxy = oxygens.find(ethoxy), hydroxy = oxygens.find(a => heavy(a).length === 1);
      if (alkoxy && hydroxy) {
        if (hydroxy.charge === 0 && [0, 1].includes(alkoxy.charge)) kind = alkoxy.charge === 1 ? 'oxonium' : 'hemiketal';
        else if (hydroxy.charge === 1 && alkoxy.charge === 0) kind = 'protonatedHemiketal';
      }
    } else if (carbons.length === 5 && oxygens.length === 1 && oxygenBonds.length === 1 && ethoxy(oxygens[0])) {
      if ((central.charge === 1 && oxygenBonds[0].order === 1 && oxygens[0].charge === 0) ||
          (central.charge === 0 && oxygenBonds[0].order === 2 && oxygens[0].charge === 1)) kind = 'oxocarbenium';
    } else if (carbons.length === 7 && oxygens.length === 2 && oxygenBonds.length === 2 && oxygenBonds.every(n => n.order === 1) &&
        members.every(a => ['C', 'H', 'O'].includes(a.label)) && oxygens.every(ethoxy)) {
      if (members.every(a => !a.charge) && oxygens.every(a => !a.implicitH && a.neighbors.every(n => atoms.get(n.uuid).label !== 'H'))) kind = 'ketal';
      else if (members.filter(a => a.charge).length === 1 && oxygens.some(a => a.charge === 1)) kind = 'protonatedKetal';
    }
    if (!kind && oxygens.length === 1) {
      if (carbons.length === 2 && oxygens[0].charge === 0) kind = 'ethanol';
      else if ([0, 2].includes(carbons.length) && oxygens[0].charge === 1) kind = 'acid';
    }
    if (kind) for (const atom of members) structures.set(atom.id, kind);
  }
  const arrows = context.reactionArrows.map(arrow => {
    const kinds = ids => [...new Set((ids || []).map(id => structures.get(id)).filter(Boolean))];
    return { from: kinds(arrow.reactants), to: kinds(arrow.products), start: arrow.start, end: arrow.end,
      horizontal: Math.abs(arrow.start.y - arrow.end.y) < 0.02, rightward: arrow.end.x > arrow.start.x };
  });
  const longestBond = Math.max(0, ...context.bonds.map(({ begin, end }) => Math.hypot(atoms.get(begin).x - atoms.get(end).x, atoms.get(begin).y - atoms.get(end).y)));
  const route = ['acetone', 'protonatedAcetone', 'oxonium', 'hemiketal'];
  if (toKetal) route.push('protonatedHemiketal', 'oxocarbenium', 'protonatedKetal', 'ketal');
  const steps = route.slice(1).map((to, i) => arrows.find(arrow => arrow.from.includes(route[i]) && arrow.to.includes(to)));
  const catalystCycle = !!(steps[0]?.from.includes('acid') && steps[1]?.from.includes('ethanol') && steps[2]?.to.includes('acid'));
  const bonds = new Map(context.bonds.map(bond => [bond.id, bond]));
  const origin = endpoint => atoms.get(endpoint.ownerAtomId || endpoint.atomId);
  const targets = endpoint => (endpoint.type === 'formingBond' ? [endpoint.atomA, endpoint.atomB] : [endpoint.atomId]).map(id => atoms.get(id)).filter(Boolean);
  const ofKind = (atom, kind, label) => !!atom && structures.get(atom.id) === kind && atom.label === label;
  const attack = (sourceKind, targetKind, targetLabel) => context.arrows.find(arrow =>
    ofKind(origin(arrow.source), sourceKind, 'O') && targets(arrow.target).some(atom => ofKind(atom, targetKind, targetLabel)));
  const cleave = (kind, neighbor) => context.arrows.find(arrow => {
    const bond = bonds.get(arrow.source.bondId);
    const target = atoms.get(arrow.target.atomId);
    if (!bond || !ofKind(target, kind, 'O')) return false;
    const other = bond.begin === target.id ? bond.end : bond.end === target.id ? bond.begin : null;
    return atoms.get(other)?.label === neighbor;
  });
  const deprotonation = kind => context.arrows.some(arrow => {
    const base = origin(arrow.source);
    return base?.label === 'O' && base.charge === 0 && structures.get(base.id) !== kind &&
      targets(arrow.target).some(atom => ofKind(atom, kind, 'H'));
  }) && cleave(kind, 'H');
  const carbonylAttack = attack('ethanol', 'protonatedAcetone', 'C');
  const carbonylShift = cleave('protonatedAcetone', 'C');
  const carbocationAttack = toKetal && carbonylAttack && targets(carbonylAttack.target).some(atom =>
    ofKind(atom, 'protonatedAcetone', 'C') && atom.charge === 1);
  const electronSteps = [attack('acetone', 'acid', 'H') && cleave('acid', 'H'),
    carbonylAttack && (carbonylShift || carbocationAttack), deprotonation('oxonium')];
  if (toKetal) electronSteps.push(attack('hemiketal', 'acid', 'H') && cleave('acid', 'H'),
    cleave('protonatedHemiketal', 'C'), attack('ethanol', 'oxocarbenium', 'C'), deprotonation('protonatedKetal'));
  const result = { routeComplete: steps.every(Boolean), catalystCycle, electronSteps: electronSteps.map(Boolean), arrows, longestBond,
    hasExplicitHydrogen: context.atoms.some(a => a.label === 'H' && a.neighbors.length > 0),
    closedShell: context.atoms.every(atom => !atom.radical) };
  if (!toKetal) return result;

  const rows = [];
  for (const arrow of steps.filter(Boolean)) {
    if (!rows.length || Math.abs(rows.at(-1)[0].start.y - arrow.start.y) >= 0.02) rows.push([]);
    rows.at(-1).push(arrow);
  }
  const cues = context.texts.flatMap(item => {
    const match = item.text.match(/续\s*(\d+)/);
    return match ? [{ number: match[1], x: item.x, y: item.y }] : [];
  });
  const aligned = rows.length === 2 && rows.every(row => [3, 4].includes(row.length) && row.every((arrow, index) =>
    arrow.horizontal && arrow.rightward && (!index || arrow.start.x > row[index - 1].end.x)));
  const resetLeft = aligned && rows[1][0].start.y > rows[0][0].start.y && rows[1][0].end.x < rows[0].at(-1).start.x;
  const pairedCues = cues.length === 2 && cues[0].number === cues[1].number && resetLeft &&
    cues.some(cue => cue.x > rows[0].at(-1).end.x && Math.abs(cue.y - rows[0][0].start.y) < 1) &&
    cues.some(cue => cue.x < rows[1][0].start.x && Math.abs(cue.y - rows[1][0].start.y) < 1);
  return { ...result, catalystCycle: catalystCycle && !!(steps[3]?.from.includes('acid') && steps[5]?.from.includes('ethanol') &&
    steps[6]?.to.includes('acid')), product: steps[6]?.to.includes('ketal') || false,
    rows: rows.map(row => ({ y: row[0].start.y, steps: row.length })), aligned, resetLeft, pairedCues, cues,
    carbonylPair: carbonylAttack && carbonylShift ? { attackId: carbonylAttack.id, shiftId: carbonylShift.id,
      bondId: carbonylShift.source.bondId } : null };
}

function carbonylSides(pair) {
  const { controller, model } = MolWorkbench.app;
  const ctx = controller.ctx(), bond = ctx.bondInfo(pair.bondId);
  const { arrowGeometry, quadPoint } = MolWorkbench.model;
  const side = (id, samplePoints) => {
    const geometry = arrowGeometry(model.state.arrows.find(arrow => arrow.id === id), ctx);
    return samplePoints.map(t => MolWorkbench.route.sideOfBond(quadPoint(geometry.start, geometry.control, geometry.end, t), bond))
      .find(Boolean) || 0;
  };
  return { attack: side(pair.attackId, [0.82, 0.65]), shift: side(pair.shiftId, [0.5]) };
}

function inspectMethylRoutes(context) {
  const moleculeByAtom = new Map();
  const atomsById = new Map(context.atoms.map(atom => [atom.id, atom]));
  const bondsById = new Map(context.bonds.map(bond => [bond.id, bond]));
  const boundsByMolecule = new Map();
  for (const molecule of context.molecules) {
    const members = molecule.atoms.map(id => atomsById.get(id)).filter(Boolean);
    const xs = members.map(atom => atom.x), ys = members.map(atom => atom.y);
    boundsByMolecule.set(molecule.id, { minX: Math.min(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
    for (const atomId of molecule.atoms) moleculeByAtom.set(atomId, molecule);
  }
  const steps = context.reactionArrows.map(arrow => ({
    ...arrow,
    reactantMolecules: [...new Set((arrow.reactants || []).map(id => moleculeByAtom.get(id)?.id).filter(Boolean))],
    productMolecules: [...new Set((arrow.products || []).map(id => moleculeByAtom.get(id)?.id).filter(Boolean))],
  }));
  const endpointAtoms = endpoint => {
    if (!endpoint) return [];
    if (endpoint.type === 'atom') return [endpoint.atomId];
    if (endpoint.type === 'formingBond') return [endpoint.atomA, endpoint.atomB];
    if (endpoint.type === 'lonePair') return [endpoint.ownerAtomId];
    if (endpoint.type === 'bond') {
      const bond = bondsById.get(endpoint.bondId);
      return bond ? [bond.begin, bond.end] : [];
    }
    return [];
  };
  const flowRecords = context.arrows.map(arrow => {
    const source = endpointAtoms(arrow.source), target = endpointAtoms(arrow.target);
    const owners = [...source, ...target].map(id => moleculeByAtom.get(id)?.id);
    return source.length && target.length && owners.every(Boolean) ? new Set(owners) : null;
  }).filter(Boolean);
  const pairs = [];
  for (const first of steps) {
    const next = steps.filter(step => step !== first && first.productMolecules.some(id => step.reactantMolecules.includes(id)));
    if (next.length === 1 && !pairs.some(([a, b]) => a === next[0] || b === next[0])) pairs.push([first, next[0]]);
  }
  const routes = pairs.map(([first, second]) => {
    const allSteps = [first, second];
    const ids = [...new Set(allSteps.flatMap(step => [...step.reactantMolecules, ...step.productMolecules]))];
    const bounds = ids.map(id => boundsByMolecule.get(id)).filter(Boolean);
    const minY = Math.min(...bounds.map(box => box.minY)), maxY = Math.max(...bounds.map(box => box.maxY));
    const flowCounts = allSteps.map(step => {
      const reactants = new Set(step.reactantMolecules);
      return flowRecords.filter(owners => [...owners].every(id => reactants.has(id))).length;
    });
    const rootMinX = Math.min(...first.reactantMolecules.map(id => boundsByMolecule.get(id)?.minX ?? Infinity));
    const rowY = arrow => arrow.start.y;
    return { steps: allSteps, minY, maxY, rootMinX,
      rightward: allSteps.every(arrow => arrow.end.x > arrow.start.x),
      commonRow: Math.abs(rowY(first) - rowY(second)) < 0.02 &&
        allSteps.every(arrow => Math.abs(arrow.start.y - arrow.end.y) < 0.02),
      connected: first.productMolecules.some(id => second.reactantMolecules.includes(id)),
      flowCounts, flowPerStep: flowCounts.every(count => count >= 2) };
  });
  routes.sort((a, b) => a.minY - b.minY);
  const routeRows = routes.length === 2 && routes[0].maxY < routes[1].minY && routes.every(route => route.steps.length === 2);
  const resetLeft = routes.length === 2 && Math.abs(routes[1].rootMinX - routes[0].rootMinX) <= 0.5;
  const routeMolecules = routes.map(route => new Set(route.steps.flatMap(step => [...step.reactantMolecules, ...step.productMolecules])));
  return { routeCount: routes.length, stepCount: steps.length, routes, routeRows, resetLeft,
    independent: routes.length === 2 && new Set(routes.flatMap(route => route.steps)).size === 4 &&
      ![...routeMolecules[0]].some(id => routeMolecules[1].has(id)),
    endpointReferencesValid: steps.every(step => [...step.reactants, ...step.products].every(id => moleculeByAtom.has(id))) };
}

// This stricter audit is specific to the requested two-route methylation case.
// It deliberately does not add geometry assertions to the shared snapshot.
function inspectCaffeineLayout(context, observation) {
  const molecules = new Map(), bonds = new Map(context.bonds.map(bond => [bond.id, bond]));
  for (const molecule of context.molecules) for (const id of molecule.atoms) molecules.set(id, molecule.id);
  const endpoint = ep => {
    if (ep?.type === 'bond') { const bond = bonds.get(ep.bondId); return bond ? [bond.begin, bond.end] : []; }
    return ep?.type === 'lonePair' ? [ep.ownerAtomId] : ep?.type === 'atom' ? [ep.atomId]
      : ep?.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
  };
  const flows = context.arrows.map(arrow => {
    const source = endpoint(arrow.source), target = endpoint(arrow.target), refs = [...source, ...target];
    return { arrowId: arrow.id, sourceType: arrow.source?.type, valid: source.length > 0 && target.length > 0 && refs.every(id => molecules.has(id)),
      owners: [...new Set(refs.map(id => molecules.get(id)).filter(Boolean))] };
  });
  const steps = (context.reactionSteps || []).map(step => {
    const reactants = new Set(step.reactants.map(id => molecules.get(id)).filter(Boolean));
    const actual = flows.filter(flow => flow.valid && flow.owners.every(id => reactants.has(id)));
    const actualArrowIds = actual.map(flow => flow.arrowId).sort(), checkedArrowIds = [...(step.checks?.layout?.checkedArrowIds || [])].sort();
    const native = context.reactionArrows.filter(arrow => arrow.stepId === step.stepId);
    const issues = [...(step.checks?.layout?.issues || [])];
    if (step.checks?.layout?.status !== 'passed') issues.push({ code: 'caffeine_step_layout_not_passed' });
    if (actualArrowIds.length !== 2) issues.push({ code: 'caffeine_step_flow_count', expected: 2, actual: actualArrowIds.length });
    if (JSON.stringify(actualArrowIds) !== JSON.stringify(checkedArrowIds)) issues.push({ code: 'caffeine_step_unchecked_flows',
      missing: actualArrowIds.filter(id => !checkedArrowIds.includes(id)), unexpected: checkedArrowIds.filter(id => !actualArrowIds.includes(id)) });
    if (native.length !== 1 || String(native[0]?.id) !== String(step.reactionArrowId)) issues.push({ code: 'caffeine_step_native_mismatch' });
    return { stepId: step.stepId, version: step.version, status: step.checks?.layout?.status || 'missing',
      actualArrowIds, checkedArrowIds, bondSourceArrowIds: actual.filter(flow => flow.sourceType === 'bond').map(flow => flow.arrowId),
      pass: issues.length === 0, issues };
  });
  const assignmentFailures = flows.filter(flow => !flow.valid || steps.filter(step => step.actualArrowIds.includes(flow.arrowId)).length !== 1);
  const observed = observation?.arrows || [];
  const curves = context.arrows.map(arrow => {
    const matches = observed.filter(item => item.arrowId === arrow.id), item = matches[0], metrics = item?.metrics;
    const finiteGeometry = item && ['start', 'control', 'end'].every(key => item[key] && ['x', 'y'].every(axis => Number.isFinite(item[key][axis])));
    const metricsValid = metrics && ['chord', 'length', 'sag', 'L'].every(key => Number.isFinite(metrics[key]) && metrics[key] >= 0) && metrics.L > 0;
    const pass = matches.length === 1 && item.sourceOk === true && item.targetOk === true && !item.degenerate &&
      finiteGeometry && metricsValid && metrics.readable === true && Array.isArray(metrics.reasons) && metrics.reasons.length === 0;
    return { arrowId: arrow.id, ...item, pass: !!pass, ...(!pass && { code: 'caffeine_actual_curve_unreadable' }) };
  });
  const issues = [];
  if (steps.length !== 4 || new Set(steps.map(step => step.stepId)).size !== 4) issues.push({ code: 'caffeine_semantic_step_count', expected: 4, actual: steps.length });
  if (flows.length !== 8 || new Set(flows.map(flow => flow.arrowId)).size !== 8) issues.push({ code: 'caffeine_flow_count', expected: 8, actual: flows.length });
  if (context.reactionArrows.length !== 4) issues.push({ code: 'caffeine_native_step_count', actual: context.reactionArrows.length });
  if (assignmentFailures.length) issues.push({ code: 'caffeine_flow_assignment', arrowIds: assignmentFailures.map(flow => flow.arrowId) });
  if (observed.length !== flows.length || observed.some(item => !flows.some(flow => flow.arrowId === item.arrowId))) issues.push({ code: 'caffeine_curve_observation_coverage' });
  return { pass: issues.length === 0 && steps.every(step => step.pass) && curves.every(curve => curve.pass),
    issues, steps, curves, stepFailures: steps.filter(step => !step.pass), curveFailures: curves.filter(curve => !curve.pass) };
}

function observeCaffeineCurves(context) {
  const MW = MolWorkbench, M = MW.model, R = MW.route, { controller, model } = MW.app;
  const ctx = controller.ctx(), scene = R.buildScene(ctx, model), molecules = new Map(), bonds = new Map(context.bonds.map(bond => [bond.id, bond]));
  for (const molecule of context.molecules) for (const id of molecule.atoms) molecules.set(id, molecule.id);
  const endpoint = ep => ep.type === 'bond' ? (() => { const bond = bonds.get(ep.bondId); return bond ? [bond.begin, bond.end] : []; })()
    : ep.type === 'lonePair' ? [ep.ownerAtomId] : ep.type === 'atom' ? [ep.atomId] : ep.type === 'formingBond' ? [ep.atomA, ep.atomB] : [];
  return { arrows: model.state.arrows.map(arrow => {
    try {
      const geometry = M.arrowGeometry(arrow, ctx), refs = [...endpoint(arrow.source), ...endpoint(arrow.target)];
      const intermolecular = new Set(refs.map(id => molecules.get(id)).filter(Boolean)).size > 1;
      return { arrowId: arrow.id, sourceOk: geometry.sourceOk, targetOk: geometry.targetOk, degenerate: !!geometry.degenerate,
        start: geometry.start, control: geometry.control, end: geometry.end, intermolecular,
        metrics: R.assessReadability({ ...geometry, L: scene.L || 1, intermolecular }) };
    } catch { return { arrowId: arrow.id, error: 'actual_curve_observation_failed' }; }
  }) };
}

function inspectCaffeineExport(dataUrl, arrowIds) {
  const MW = MolWorkbench, doc = MW.app.adapter.doc;
  const xml = new TextDecoder().decode(Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0)));
  const parsed = new DOMParser().parseFromString(xml, 'image/svg+xml');
  const svg = doc.importNode(parsed.documentElement, true);
  svg.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  doc.body.appendChild(svg);
  try {
    const viewBox = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number), bounds = MW.exporter.contentBBox(svg);
    const actualArrowIds = [...svg.querySelectorAll('.mech-arrow[data-arrow]')].map(el => el.getAttribute('data-arrow')).sort();
    const complete = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0 && bounds &&
      bounds.x >= viewBox[0] - 0.5 && bounds.y >= viewBox[1] - 0.5 &&
      bounds.x + bounds.width <= viewBox[0] + viewBox[2] + 0.5 && bounds.y + bounds.height <= viewBox[1] + viewBox[3] + 0.5 &&
      JSON.stringify(actualArrowIds) === JSON.stringify([...arrowIds].sort());
    return { complete: !!complete, viewBox, bounds, actualArrowIds };
  } finally { svg.remove(); }
}

function runCaffeineAuditRegression() {
  const { test } = require('node:test'), assert = require('node:assert/strict');
  require('../workbench/mechanism-model.js'); require('../workbench/mechanism-route.js');
  const R = globalThis.MolWorkbench.route;
  const fixture = () => {
    const context = { molecules: [], bonds: [], arrows: [], reactionArrows: [], reactionSteps: [] };
    for (let n = 0; n < 4; n++) {
      const host = 'host' + n, reagent = 'reagent' + n, leaving = 'leaving' + n, bond = 'bond' + n, stepId = 'step' + n;
      context.molecules.push({ id: host, atoms: [host] }, { id: reagent, atoms: [reagent, leaving] });
      context.bonds.push({ id: bond, begin: reagent, end: leaving });
      context.arrows.push({ id: 'attack' + n, source: { type: 'lonePair', ownerAtomId: host }, target: { type: 'atom', atomId: reagent } },
        { id: 'release' + n, source: { type: 'bond', bondId: bond }, target: { type: 'atom', atomId: leaving } });
      context.reactionSteps.push({ stepId, version: 1, reactionArrowId: n, reactants: [host, reagent], products: [],
        checks: { layout: { status: 'passed', issues: [], checkedArrowIds: ['attack' + n, 'release' + n] } } });
      context.reactionArrows.push({ id: n, stepId });
    }
    const geometry = { start: { x: 0, y: 0 }, control: { x: 1, y: 0.4 }, end: { x: 2, y: 0 } };
    const observation = { arrows: context.arrows.map(arrow => ({ arrowId: arrow.id, sourceOk: true, targetOk: true, degenerate: false,
      ...geometry, metrics: R.assessReadability({ ...geometry, L: 1, intermolecular: arrow.source.type !== 'bond' }) })) };
    return { context, observation };
  };
  test('caffeine audit requires every real two-flow step including its bond-source flow', () => {
    const { context, observation } = fixture(); assert.equal(inspectCaffeineLayout(context, observation).pass, true);
    context.reactionSteps[0].checks.layout.checkedArrowIds.pop();
    const audit = inspectCaffeineLayout(context, observation); assert.equal(audit.pass, false);
    assert.deepEqual(audit.stepFailures[0].issues.find(issue => issue.code === 'caffeine_step_unchecked_flows').missing, ['release0']);
  });
  test('caffeine audit rejects missing or failed layout even with correct entity counts', () => {
    for (const status of ['failed', undefined]) { const { context, observation } = fixture();
      context.reactionSteps[0].checks.layout.status = status; assert.equal(inspectCaffeineLayout(context, observation).pass, false); }
  });
  test('caffeine audit rejects invalid bond/LP/forming-bond endpoints and cross-step borrowed flow', () => {
    for (const bad of [{ type: 'bond', bondId: 'missing' }, { type: 'lonePair', ownerAtomId: 'missing' },
      { type: 'formingBond', atomA: 'host0', atomB: 'missing' }, { type: 'atom', atomId: 'host1' }]) {
      const { context, observation } = fixture(); context.arrows[0].source = bad;
      assert.equal(inspectCaffeineLayout(context, observation).pass, false);
    }
  });
  test('caffeine audit rejects the original giant U despite passed status and all eight checked flow IDs', () => {
    const { context, observation } = fixture(), actual = observation.arrows[0];
    Object.assign(actual, { start: { x: 19.57313965328736, y: 16.292304281325006 },
      control: { x: 17.165145803101588, y: 22.941767999949935 }, end: { x: 13.883549623992293, y: 16.992673883307482 } });
    actual.metrics = R.assessReadability({ ...actual, L: 1, intermolecular: true });
    const audit = inspectCaffeineLayout(context, observation); assert.equal(audit.pass, false);
    assert.deepEqual(audit.curveFailures[0].metrics.reasons, ['intermolecular_span', 'curve_sag']);
    assert.ok(audit.curveFailures[0].metrics.length > 8.9);
  });
  test('caffeine audit rejects missing curve observations and missing semantic steps', () => {
    const { context, observation } = fixture(); observation.arrows.pop(); assert.equal(inspectCaffeineLayout(context, observation).pass, false);
    context.reactionSteps = []; assert.equal(inspectCaffeineLayout(context, observation).pass, false);
  });
}

if (NODE_CAFFEINE_AUDIT) runCaffeineAuditRegression();
else app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1360, height: 880, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error' && !/favicon|deprecated/i.test(event.message)) report.errors.push(event.message.slice(0, 1000)); });
  const js = source => win.webContents.executeJavaScript(source);
  const until = async (source, limit = 20_000) => {
    const start = Date.now();
    while (!await js(source)) { if (Date.now() - start > limit) throw new Error('Timed out waiting for ' + source); await wait(50); }
  };
  const capture = async name => fs.writeFileSync(path.join(OUT, name + '.png'), (await win.capturePage()).toPNG());
  try {
    await win.loadURL('http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 48975) + '/canvas.html');
    await until('!!window.k3dAPI?.workbenchReady?.() && !!window.molstudioAgent?.getRuntime?.()', 35_000);
    await js(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const rt = molstudioAgent.getRuntime(), api = k3dAPI.agent;
      const nativeFetch = rt._fetch;
      const state = window.__agentIntegration = { events: [], errors: [], requests: 0, realTotal: 0, realLimit: 10,
        mode: 'simple', sentTail: false, releaseTail: null, nativeFetch, rt, api, wait };
      addEventListener('molstudio:agent-canvas-change', event => {
        const d = event.detail || {};
        state.canvasChanges = state.canvasChanges || [];
        state.canvasChanges.push({ source: d.source, reason: d.reason, revision: d.revision, traces: (window.__molstudioDebugScanTraces || []).slice(-3) });
      });
      addEventListener('molstudio:agent-event', event => {
        const e = event.detail;
        // No raw provider data, reasoning, config or auth tokens are stored.
        state.events.push({ type: e.type, runId: e.runId, toolName: e.toolName, isError: e.isError, reason: e.reason,
          text: e.type === 'text_delta' ? e.text : undefined, message: e.type === 'error' || e.isError ? e.message : undefined,
          code: e.code, status: e.status, turns: e.turns, finish: e.finish, phase: e.progress?.phase, canContinue: e.canContinue,
          usage: e.type === 'run_end' ? e.usage : undefined, diagnostic: e.diagnostic,
          operationCount: e.completedOperations, planSteps: e.type === 'plan' ? e.steps?.length : undefined,
          result: e.type === 'tool_end' && e.result && e.result.result ? { created: (e.result.result.created || []).length, updated: (e.result.result.updated || []).length, deleted: (e.result.result.deleted || []).length,
            finishAccepted: e.result.result.finishAccepted, finishRejected: e.result.result.finishRejected ? String(e.result.result.finishRejected).slice(0, 80) : undefined,
            warnings: (e.result.result.warnings || []).slice(0, 3), summary: String(e.result.result.summary || '').slice(0, 100) } : undefined });
        if(state.mode==='real' && e.type==='tool_end' && e.isError) {
          // 允许模型按工具回执自我纠错；连续 3 次工具错误才熔断，控制花费
          state.toolErrors=(state.toolErrors||0)+1;
          if(state.toolErrors>=6){state.firstToolError=e.message;rt.stop('test_first_tool_error');}
        }
      });
      addEventListener('error', event => state.errors.push(event.message));
      addEventListener('unhandledrejection', event => state.errors.push(String(event.reason?.message || event.reason)));
      MolWorkbench.app.adapter.doc.defaultView.addEventListener('error', event => state.errors.push(event.message));
      state.ops = () => [
        {id:'nuc',type:'molecule.add',smiles:'[OH-:7]',x:3,y:8},
        {id:'sub',type:'molecule.add',smiles:'[CH3:21][Br:22]',x:10,y:8},
        {id:'pair',type:'lonePair.add',atom:'nuc:7',angle:0},
        {id:'attack',type:'arrow.add',source:{type:'lonePair',id:'pair'},target:{type:'formingBond',atom1:'nuc:7',atom2:'sub:21'},electronCount:2},
        {id:'leave',type:'arrow.add',source:{type:'bond',bondId:'sub:bond:1',component:'sigma'},target:{type:'atom',atomId:'sub:22'},electronCount:2},
        {id:'prod',type:'molecule.add',smiles:'[CH3:11][OH:12]',x:2,y:-3},
        {id:'br',type:'molecule.add',smiles:'[Br-:1]',x:27,y:8},
        {id:'step',type:'reactionArrow.add',reactants:['nuc:7','sub:21'],products:['prod:11','br:1']}
      ];
      state.seedCarbonyl = async () => {
        const runId = crypto.randomUUID();
        await api.beginRun(runId);
        const receipt = await api.applyOperations([
          {id:'aldehyde',type:'molecule.add',smiles:'[CH3:1][CH:2]=[O:3]',x:11,y:8},
          {id:'hydroxide',type:'molecule.add',smiles:'[OH-:1]',x:8,y:10},
          {id:'shift',type:'arrow.add',source:{type:'bond',atom1:'aldehyde:2',atom2:'aldehyde:3',component:'pi'},
            target:{type:'atom',atomId:'aldehyde:3'},electronCount:2}
        ],{runId});
        await api.endRun(runId);
        state.carbonyl = { carbon:receipt.atomMapping['aldehyde:2'], oxygen:receipt.atomMapping['aldehyde:3'],
          donor:receipt.atomMapping['hydroxide:1'], arrowId:receipt.created.find(entry=>entry.id==='shift').entityIds[0],
          before:await state.snapshot() };
      };
      state.carbonylIsComplete = async () => {
        const { carbon, oxygen, donor, arrowId, before } = state.carbonyl;
        const canvas = await api.getContext();
        const shift = canvas.arrows.find(arrow=>arrow.id===arrowId);
        const attack = canvas.arrows.find(arrow=>arrow.id!==arrowId);
        const bond = canvas.bonds.find(item=>item.id===shift?.source.bondId);
        const target = attack?.target;
        const attacksCarbon = target?.type==='atom' ? target.atomId===carbon :
          target?.type==='formingBond' && [target.atomA,target.atomB].includes(carbon) && [target.atomA,target.atomB].includes(donor);
        return canvas.atoms.length===before.atoms && canvas.arrows.length===2 && canvas.reactionArrows.length===0 &&
          shift?.electronCount===2 && shift.source.component==='pi' && shift.target.atomId===oxygen &&
          [bond?.begin,bond?.end].includes(carbon) && [bond?.begin,bond?.end].includes(oxygen) &&
          attack?.electronCount===2 && (attack.source.ownerAtomId||attack.source.atomId)===donor && attacksCarbon;
      };
      const encoder = new TextEncoder();
      const separator = String.fromCharCode(10, 10);
      const frame = (delta, finish_reason = null) => encoder.encode('data: ' + JSON.stringify({ id:'local-fixture',created:0,model:'fixture',choices:[{index:0,delta,finish_reason}]}) + separator);
      function response(chunks, gate = false) {
        return new Response(new ReadableStream({ async start(controller) {
          for (let i=0;i<chunks.length;i++) {
            if (gate && i === 1) { await new Promise(resolve => {state.releaseTail=resolve;});state.sentTail=true; }
            controller.enqueue(frame(chunks[i].delta,chunks[i].finish || null));
          }
          controller.enqueue(encoder.encode('data: [DONE]' + separator));controller.close();
        }}),{headers:{'Content-Type':'text/event-stream'}});
      }
      function tool(name,input,callId='fixture-call') {
        return response([{delta:{role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name,arguments:JSON.stringify(input)}}]}},{delta:{},finish:'tool_calls'}]);
      }
      rt._fetch = async function(url,init) {
        if(url !== '/api/agent/model') return nativeFetch(url,init);
        if(state.mode === 'real') {
          if(state.realTotal>=state.realLimit || state.requests>=state.perTaskLimit) throw new Error('Integration request budget reached; no additional upstream call sent');
          state.requests++;state.realTotal++;
          return nativeFetch(url,init);
        }
        state.requests++;
        if(state.mode==='simple' || state.mode==='stop') {
          const ops=state.ops(),prefix='{"operations":['+JSON.stringify(ops[0])+',';
          const suffix=ops.slice(1).map(JSON.stringify).join(',')+'],"taskScope":{"type":"completeMechanism"},"finish":true}';
          return response([{delta:{role:'assistant',tool_calls:[{index:0,id:'streaming-draw',type:'function',function:{name:'draw_operations',arguments:prefix}}]}},
            {delta:{tool_calls:[{index:0,function:{arguments:suffix}}]}},{delta:{},finish:'tool_calls'}],true);
        }
        if (state.mode === 'sealed') {
          const ops = state.ops();
          const first = [...ops, { id:'seal-first', type:'step.seal' }];
          const shifted = JSON.parse(JSON.stringify(ops).replace(/"(nuc|sub|pair|attack|leave|prod|br|step)(?=[:"])/g, '"two-$1'));
          for (const op of shifted) if (typeof op.x === 'number') op.x += 32;
          const second = [...shifted,
            { id:'seal-second', type:'step.seal' }];
          const prefix = '{"operations":[' + first.map(JSON.stringify).join(',') + ',';
          const suffix = second.map(JSON.stringify).join(',') + '],"taskScope":{"type":"completeMechanism"},"finish":true}';
          return response([{delta:{role:'assistant',tool_calls:[{index:0,id:'sealed-draw',type:'function',function:{name:'draw_operations',arguments:prefix}}]}},
            {delta:{tool_calls:[{index:0,function:{arguments:suffix}}]}},{delta:{},finish:'tool_calls'}],true);
        }
        if(state.mode==='plan') {
          if(state.requests===1)return tool('write_plan',{steps:[{id:'draw',text:'绘制反应物、中间体与产物',status:'running'},{id:'check',text:'检查结果',status:'pending'}]},'plan');
          if(state.requests===2)return tool('draw_operations',{operations:state.ops(),taskScope:{type:'completeMechanism'}},'draw');
          return response([{delta:{role:'assistant',content:'完整机理已画完：包含反应物、两根电子流弯箭头、产物甲醇与溴离子。'}},{delta:{},finish:'stop'}]);
        }
        if(state.mode==='preflight') {
          const operations=state.ops();
          if(state.requests===1) {
            const duplicate={...operations.find(op=>op.id==='attack'),id:'duplicate-attack'};
            return tool('draw_operations',{operations:[...operations,duplicate],finish:true},'invalid-flow');
          }
          if(state.requests===2)return tool('draw_operations',{operations,finish:true},'corrected-flow');
          throw new Error('Preflight fixture exceeded its repair budget');
        }
        if(state.mode==='cross-batch-duplicate') {
          const { carbon, oxygen, donor, before } = state.carbonyl;
          if(state.requests===1) return tool('draw_operations',{operations:[
            {id:'repeat-shift',type:'arrow.add',source:{type:'bond',atom1:oxygen,atom2:carbon,component:'pi'},
              target:{type:'atom',atomId:oxygen},electronCount:2},
          ],finish:true},'repeat-shift');
          const after = await state.snapshot();
          const beforeSource=JSON.parse(before.source),afterSource=JSON.parse(after.source);
          state.rejectionDiff={beforeUndo:before.undo,afterUndo:after.undo,
            changedFields:[...new Set([...Object.keys(beforeSource),...Object.keys(afterSource)])]
              .filter(key=>JSON.stringify(beforeSource[key])!==JSON.stringify(afterSource[key]))};
          // Starting this task creates its resumable checkpoint. A rejected
          // drawing must preserve chemistry, document objects and history;
          // the task's own bookkeeping is allowed to advance independently.
          delete beforeSource.agentTask; delete afterSource.agentTask;
          state.rejectionPreserved = JSON.stringify(afterSource)===JSON.stringify(beforeSource) && after.undo===before.undo;
          return tool('draw_operations',{operations:[
            {id:'donor-pair',type:'lonePair.add',atom:donor},
            {id:'carbonyl-attack',type:'arrow.add',source:{type:'lonePair',id:'donor-pair'},target:{type:'atom',atomId:carbon},electronCount:2},
          ],finish:true},'corrected-attack');
        }
        if(state.mode==='unsupported-hydride') {
          if(state.requests===1) return tool('draw_operations',{operations:[
            {id:'nitroso',type:'molecule.add',smiles:'[CH3:1][N:2]=[O:3]'},
            {id:'amine',type:'molecule.add',smiles:'[CH3:1][NH2:2]'},
            {id:'invented-hydride',type:'molecule.add',smiles:'[H-:1]'},
            {id:'reduce',type:'reactionArrow.add',reactants:['nitroso:2'],products:['amine:2'],layout:{conditions:'Na₂S₂O₄ / H₂O'}},
            {id:'hydride-attack',type:'arrow.add',source:{type:'atom',atomId:'invented-hydride:1'},target:{type:'atom',atomId:'nitroso:2'},electronCount:2}
          ],finish:true},'invalid-hydride');
          return response([{delta:{role:'assistant',content:'我需要确认该还原步骤的电子来源。'}},{delta:{},finish:'stop'}]);
        }
        throw new Error('Unknown fixture mode');
      };
      state.reset = async mode => {
        rt.reset();molstudioAgent.getPanel().clear();
        await k3dAPI.setMolecule('');await wait(300);MolWorkbench.app.adapter.ed.clearHistory();
        state.mode=mode;state.events=[];state.canvasChanges=[];state.requests=0;state.sentTail=false;state.releaseTail=null;state.firstToolError=null;state.toolErrors=0;
        document.activeElement?.blur?.();molstudioAgent.open();
      };
      state.snapshot = async () => {
        const ctx=await api.getContext(),ed=MolWorkbench.app.adapter.ed;
        return {atoms:ctx.atoms.length,bonds:ctx.bonds.length,molecules:(ctx.molecules||[]).length,lonePairs:ctx.lonePairs.length,arrows:ctx.arrows.length,
          reactionArrows:ctx.reactionArrows, atomXs:ctx.atoms.map(a=>a.x).sort((a,b)=>a-b),
          texts:ed.struct().texts.size,undo:ed.historySize().undo,source:await k3dAPI.serializeWorkbench(),
          endpointsValid:ctx.arrows.every(arrow=>{const g=MolWorkbench.model.arrowGeometry(arrow,MolWorkbench.app.controller.ctx());return g.sourceOk&&g.targetOk;}),
          previewCount:MolWorkbench.app.adapter.doc.querySelectorAll('[data-agent-preview]').length};
      };
      await state.reset('simple');
    })()`);
    if (CAPTURE_TRANSACTIONS) {
      await js('(' + installTransactionObserver.toString() + ')()');
      flushTransactionArtifacts = async () => {
        try {
          const records = await js('__agentIntegration?.transactions || []');
          const dir = path.join(OUT, 'transactions'); fs.mkdirSync(dir, { recursive: true });
          for (const record of records) {
            const stem = 'tx-' + String(record.sequence).padStart(4, '0');
            if (record.status !== 'succeeded') {
              for (const side of ['before', 'after']) if (record[side]?.source) {
                const name = stem + '.' + side + '.molwork';
                fs.writeFileSync(path.join(dir, name), record[side].source);
                record[side].file = name; delete record[side].source;
              }
              fs.writeFileSync(path.join(dir, stem + '.ops.json'), JSON.stringify({ operations: record.operations, runId: record.runId }, null, 2));
              if (record.error) fs.writeFileSync(path.join(dir, stem + '.error.json'), JSON.stringify(record.error, null, 2));
            }
          }
          fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ build: report.build,
            application: report.application, page: report.page, capture: 'actual k3dAPI.agent.applyOperations', records }, null, 2));
          report.transactions = { index: path.join(dir, 'index.json'), calls: records.length,
            failed: records.filter(record => record.status === 'failed').length,
            pending: records.filter(record => record.status === 'pending').length,
            observerUnchanged: records.every(record => record.observerUnchanged === true && !record.captureErrors?.length) };
        } catch (error) { report.transactionCaptureError = String(error.message || error); }
      };
    }

    const firstRun = js(`window.__agentIntegration.pending = molstudioAgent.send('画出氢氧根与溴甲烷反应的完整 SN2 机理，包含产物。'); window.__agentIntegration.pending`);
    await until(`!!window.__agentIntegration.releaseTail && !!MolWorkbench.app.adapter.doc.querySelector('[data-agent-preview]')`);
    const early = await js(`(async()=>({sentTail:__agentIntegration.sentTail,...await __agentIntegration.snapshot()}))()`);
    check('complete molecule preview is visibly present while the same tool arguments are still open', !early.sentTail && early.previewCount > 0 && early.atoms === 0 && early.arrows === 0, { sentTail: early.sentTail, previewCount: early.previewCount, atoms: early.atoms });
    await capture('streaming-prefix-visible');
    await js('__agentIntegration.releaseTail()');
    const firstResult = await firstRun;
    const drawn = await js('__agentIntegration.snapshot()');
    // 修正后的验收口径：完整机理 = 反应物(3原子) + 产物甲醇(2原子) + 溴离子(1原子)，
    // 两根电子流箭头；不再接受「3 个原子＋2 根箭头＝完整」的旧口径。
    check('one request draws the complete SN2 mechanism including product species', firstResult.status === 'completed' && await js('__agentIntegration.requests===1') && drawn.atoms === 6 && drawn.molecules >= 3 && drawn.lonePairs === 1 && drawn.arrows === 2 && drawn.texts === 0 && drawn.endpointsValid && drawn.previewCount === 0, drawn);
    check('one real mixed source transaction enters undo history', drawn.undo === 1);
    const [connector] = drawn.reactionArrows;
    check('a native straight arrow connects the compact reactant and product groups', drawn.reactionArrows.length === 1 && connector.mode === 'open-angle' &&
      Math.abs(connector.start.y - connector.end.y) < 0.01 && drawn.atomXs[2] < connector.start.x && connector.start.x < connector.end.x &&
      connector.end.x < drawn.atomXs[3] && drawn.atomXs[2] - drawn.atomXs[0] < 3.2, { connector, atoms: drawn.atomXs });
    await capture('synthetic-sn2-completed');
    await js('document.activeElement?.blur?.();k3dAPI.undo()');await wait(180);
    const undone = await js('__agentIntegration.snapshot()');
    check('integrated tool undo removes molecules and mechanism together', undone.atoms === 0 && undone.arrows === 0 && undone.lonePairs === 0 && undone.reactionArrows.length === 0);
    await js('k3dAPI.redo()');await wait(180);
    const redone = await js('__agentIntegration.snapshot()');
    check('integrated tool redo restores editable endpoints and bindings', redone.atoms === 6 && redone.arrows === 2 && redone.reactionArrows.length === 1 && redone.endpointsValid);
    const reopened = await js(`(async()=>{
      const saved = await k3dAPI.serializeWorkbench();
      const loaded = await k3dAPI.loadWorkbench(saved);
      const ctx = await __agentIntegration.api.getContext();
      return { ok:loaded.ok, native:ctx.reactionArrows.length, curved:ctx.arrows.length };
    })()`);
    check('the straight arrow survives saving and reopening with curved arrows', reopened.ok && reopened.native === 1 && reopened.curved === 2, reopened);
    const existing = await js(`(async()=>{
      const api=__agentIntegration.api, ctx=await api.getContext();
      const groups=ctx.molecules.slice().sort((a,b)=>a.center.x-b.center.x);
      const runId='existing-reaction-stages';
      await api.beginRun(runId);
      const source=await k3dAPI.serializeWorkbench();
      await api.previewOperations([{ id:'draft-connector', type:'reactionArrow.add',
        reactants:groups.slice(0,2).map(m=>m.atoms[0]), products:groups.slice(2).map(m=>m.atoms[0]) }],{runId});
      const preview=!!MolWorkbench.app.adapter.doc.querySelector('[data-agent-kind="reactionArrow"] path');
      const previewCount=(await api.getContext()).reactionArrows.length;
      const sourceUnchanged=source===await k3dAPI.serializeWorkbench();
      await api.clearPreview(runId);
      await api.applyOperations([{id:'tidy-stages',type:'layout.tidy'}],{runId});
      const tidy=await api.getContext();
      await api.endRun(runId);
      const xs=tidy.atoms.map(atom=>atom.x).sort((a,b)=>a-b), arrow=tidy.reactionArrows[0];
      return { preview, previewCount, sourceUnchanged, space:xs[2]<arrow.start.x && arrow.end.x<xs[3] };
    })()`);
    check('saved reaction groups suppress a duplicate straight-arrow preview without a source write', !existing.preview && existing.previewCount === 1 && existing.sourceUnchanged, existing);
    check('tidying a reaction preserves the gap for its straight arrow', existing.space, existing);

    await js('__agentIntegration.reset("plan")');
    const planResult = await js(`molstudioAgent.send('先列个计划，然后绘制SN2，最后在聊天里简短说明；不要画布文字')`);
    const plan = await js(`(async()=>({requests:__agentIntegration.requests,events:__agentIntegration.events,...await __agentIntegration.snapshot()}))()`);
    check('optional planning and normal multi-turn tool loop remain enabled', planResult.status === 'completed' && plan.requests === 3 && plan.events.some(e => e.type === 'plan') && plan.events.some(e => e.type === 'text_delta') && plan.arrows === 2 && plan.texts === 0, { requests: plan.requests, events: plan.events, atoms: plan.atoms, arrows: plan.arrows });

    await js('__agentIntegration.reset("stop")');
    const stoppedPromise = js(`window.__agentIntegration.pending=molstudioAgent.send('画SN2，不要标注');window.__agentIntegration.pending`);
    await until(`!!__agentIntegration.releaseTail && !!MolWorkbench.app.adapter.doc.querySelector('[data-agent-preview]')`);
    await js('molstudioAgent.stop();__agentIntegration.releaseTail()');
    const stopped = await stoppedPromise;await wait(300);
    const stoppedScene = await js('__agentIntegration.snapshot()');
    check('stop fences late provider arguments and removes the provisional preview', stopped.status === 'stopped' && stoppedScene.atoms === 0 && stoppedScene.arrows === 0 && stoppedScene.previewCount === 0, { status: stopped.status, atoms: stoppedScene.atoms, preview: stoppedScene.previewCount });

    await js('__agentIntegration.reset("sealed")');
    const sealedRun = js(`molstudioAgent.send('画两个完整的 SN2 机理示例，包含产物。')`);
    try {
      await until(`!!__agentIntegration.releaseTail && __agentIntegration.events.some(e => e.type === 'step_commit')`);
      const sealedPrefix = await js(`(async()=>({sentTail:__agentIntegration.sentTail,...await __agentIntegration.snapshot()}))()`);
      check('a sealed reaction is editable and undoable before the next part of the same request arrives',
        !sealedPrefix.sentTail && sealedPrefix.atoms === 6 && sealedPrefix.arrows === 2 && sealedPrefix.undo === 1);
    } finally { await js('__agentIntegration.releaseTail?.()'); }
    const sealedResult = await sealedRun;
    const sealed = await js('__agentIntegration.snapshot()');
    check('two sealed reactions commit as two native transactions in one request',
      sealedResult.status === 'completed' && await js('__agentIntegration.requests===1') &&
      sealed.atoms === 12 && sealed.reactionArrows.length === 2 && sealed.undo === 2,
      { status: sealedResult.status, atoms: sealed.atoms, arrows: sealed.reactionArrows.length, undo: sealed.undo });
    await js('document.activeElement?.blur?.();k3dAPI.undo()'); await wait(180);
    const sealedUndo = await js('__agentIntegration.snapshot()');
    check('one undo removes only the later sealed reaction',
      sealedUndo.atoms === 6 && sealedUndo.arrows === 2 && sealedUndo.reactionArrows.length === 1 && sealedUndo.undo === 1);

    await js('__agentIntegration.reset("preflight")');
    const repaired = await js("molstudioAgent.send('画氢氧根和溴甲烷取代的机理。')");
    const repairedScene = await js('__agentIntegration.snapshot()');
    const rejected = await js("__agentIntegration.events.find(e=>e.type==='tool_end'&&e.isError)");
    check('a duplicated attack is rejected before history and only the corrected batch is committed',
      repaired.status === 'completed' && repairedScene.atoms === 6 && repairedScene.arrows === 2 &&
      repairedScene.undo === 1 && await js('__agentIntegration.requests===2') &&
      /^duplicate_/.test(rejected?.diagnostic?.code || '') && rejected?.diagnostic?.operationId === 'duplicate-attack',
      { status: repaired.status, atoms: repairedScene.atoms, arrows: repairedScene.arrows, undo: repairedScene.undo, rejected });

    await js('__agentIntegration.reset("cross-batch-duplicate").then(()=>__agentIntegration.seedCarbonyl())');
    const continuedCarbonyl = await js("molstudioAgent.send('补全乙醛羰基的电子流，只补氢氧根进攻羰基碳的那一根弯箭头，不画产物。')");
    const duplicateError = await js("__agentIntegration.events.find(e=>e.type==='tool_end'&&e.isError)?.diagnostic");
    const duplicateState = await js('(async()=>({requests:__agentIntegration.requests,preserved:__agentIntegration.rejectionPreserved,complete:await __agentIntegration.carbonylIsComplete(),diff:__agentIntegration.rejectionDiff}))()');
    check('an existing unlinked arrow rejects a new ID with reversed bond references and preserves the original history',
      continuedCarbonyl.status === 'completed' && duplicateError?.code === 'duplicate_two_electron_target' &&
      duplicateError?.operationId === 'repeat-shift' &&
      await js('__agentIntegration.requests===2&&__agentIntegration.rejectionPreserved&&__agentIntegration.carbonylIsComplete()'),
      { status: continuedCarbonyl.status, duplicateError, duplicateState });

    await js('__agentIntegration.reset("unsupported-hydride")');
    const hydrideResult = await js("molstudioAgent.send('画出连二亚硫酸钠还原这类亚硝基的机理。')");
    const hydrideScene = await js('__agentIntegration.snapshot()');
    const hydrideError = await js("__agentIntegration.events.find(e=>e.type==='tool_end'&&e.isError)");
    check('dithionite rejects an unlisted hydride donor and can end with an explanatory text reply',
      hydrideResult.status === 'completed' && hydrideScene.atoms === 0 && hydrideScene.undo === 0 &&
      hydrideError?.diagnostic?.code === 'isolated_hydride_dithionite_source' &&
      hydrideError?.diagnostic?.operationId === 'hydride-attack',
      { status: hydrideResult.status, atoms: hydrideScene.atoms, undo: hydrideScene.undo, hydrideError });

    if (process.env.MOLSTUDIO_REAL_AGENT === '1') {
      const tasks = [
        { name: 'duplicate-arrow', limit: 3,
          text: '补全画布上氢氧根进攻乙醛羰基的电子流。保留现有的羰基 π 键到氧的箭头，只补氢氧根进攻羰基碳的那一根弯箭头，不画产物。',
          prep: 'await __agentIntegration.seedCarbonyl();' },
        { name: 'caffeine-routes', limit: 6, text: '画出咖啡因相关的两个独立两步 N-甲基化机理：先分别用氢氧根去质子化茶碱和可可碱，再分别与碘甲烷反应，包含每一步的电子流和最终产物。两条路线分开绘制，不要添加其他路线。' },
        { name: 'chat', limit: 2, text: '用两句话解释SN2为什么发生构型反转。只聊天，不要修改画布。' },
        // 修正后的真实 SN2 口径：完整机理包含产物；提示只给化学任务，不教 JSON/工具/固定数量。
        { name: 'hemiketal', limit: 6, text: '画出丙酮与乙醇在酸催化下生成半缩酮的完整机理。' },
        { name: 'ketal', limit: 6, text: '画出丙酮与两分子乙醇在酸催化下先生成半缩酮、再生成缩酮的七步完整机理，包含各步电子流和最终产物。分两行画，第一行放前三或四步，剩下的从第二行左侧继续。' },
        { name: 'sn2', limit: 3, text: '画出氢氧根与溴甲烷反应的完整 SN2 机理，包含产物。' },
        { name: 'sn2-ethane', limit: 3, text: '画出氢氧根与溴乙烷反应的完整 SN2 机理，包含产物。' },
        { name: 'sn1', limit: 8, text: '画出叔丁基溴在水中发生取代的完整 SN1 机理，画到中性产物。' },
        { name: 'plan', limit: 5, text: '先列个简短计划，再画氢氧根与溴甲烷的完整机理（含产物），最后说明完成情况。' },
        { name: 'first-step', limit: 3, text: '只画这个反应的第一步，先不要画后续产物：氢氧根与溴甲烷的取代。' },
        { name: 'single', limit: 2, text: '画一个乙醇分子。' },
        { name: 'paper-label', limit: 3, text: '请在当前纸页添加一个普通文字说明，内容严格为这100个英文字母，保持一行，不改变已有标题：' + 'A'.repeat(100) },
        { name: 'explain', limit: 2, text: '解释当前选区，不要修改画布。' },
        { name: 'edit-arrow', limit: 4, text: '把已画的这根箭头改为指向带部分正电的那个碳原子。不要新建箭头，也不要增删分子。',
          prep: `(async()=>{const api=k3dAPI.agent;await api.beginRun('edit-arrow-scene');
            await api.applyOperations([{id:'s_nuc',type:'molecule.add',smiles:'[OH-:1]',x:-2,y:0},
              {id:'s_sub',type:'molecule.add',smiles:'[CH3:1][Br:2]',x:2,y:0},
              {id:'s_lp',type:'lonePair.add',atom:'s_nuc:1',angle:180},
              {id:'s_ar',type:'arrow.add',source:{type:'lonePair',id:'s_lp'},target:{type:'atom',atomId:'s_sub:2'},electronCount:2}],{runId:'edit-arrow-scene'});
            await api.endRun('edit-arrow-scene');})()` },
        { name: 'edit-delete', limit: 4, text: '删除乙醇分子，保留另一个分子。不要用全选删除，也不要新建任何东西。',
          prep: `(async()=>{const api=k3dAPI.agent;await api.beginRun('edit-delete-scene');
            await api.applyOperations([{id:'e_a',type:'molecule.add',smiles:'CCO',x:-2,y:0},
              {id:'e_b',type:'molecule.add',smiles:'CCBr',x:2.4,y:0}],{runId:'edit-delete-scene'});
            await api.endRun('edit-delete-scene');})()` },
      ];
      const requested = process.env.MOLSTUDIO_AGENT_REAL_CASES?.split(',');
      if (requested?.length) {
        const known = new Set(tasks.map(task => task.name));
        const unknown = requested.filter(name => !known.has(name));
        if (unknown.length) throw new Error('Unknown live case name: ' + unknown.join(','));
      }
      const resumedSource = process.env.MOLSTUDIO_AGENT_REAL_SEED_FILE
        ? fs.readFileSync(process.env.MOLSTUDIO_AGENT_REAL_SEED_FILE, 'utf8') : null;
      if (resumedSource && (!requested || requested.length !== 1)) throw new Error('A saved task requires exactly one live case');
      if (resumedSource) report.resumedFrom = path.resolve(process.env.MOLSTUDIO_AGENT_REAL_SEED_FILE);
      await js(`__agentIntegration.realLimit=${Math.max(1, Math.min(30, Number(process.env.MOLSTUDIO_AGENT_REAL_LIMIT) || 30))};`);
      for (const task of tasks.filter(task => !requested || requested.includes(task.name))) {
        await js(`__agentIntegration.reset('real')`);
        if (PAPER_MODE && !resumedSource) await js(`(async()=>{
          MolStudio.document.init({mode:'paper',size:'A4',orientation:'portrait'});
          MolStudio.document.addText({x:4,y:4,w:27,h:2,text:'咖啡因相关机理 · 可编辑 A4 纸页',fontSize:14});
          MolStudio.document.select([]); MolStudio.document.fitPage();
          await new Promise(resolve=>setTimeout(resolve,200));
          __agentIntegration.canvasChanges=[];
        })()`);
        const taskLimit = Math.min(30, Math.max(1, Number(process.env.MOLSTUDIO_AGENT_TASK_LIMIT) || task.limit));
        await js(`__agentIntegration.perTaskLimit=${taskLimit}`);
        if (task.prep) await js('(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));' + task.prep + '})()');
        if (resumedSource) {
          const loaded = await js('k3dAPI.loadWorkbench(' + JSON.stringify(resumedSource) + ')');
          if (!loaded?.ok) throw new Error('Cannot restore saved live task: ' + loaded?.error);
          await js('(async()=>{await molstudioAgent.getRuntime().restoreTaskCheckpoint();__agentIntegration.canvasChanges=[];})()');
        }
        const before = await js('__agentIntegration.snapshot()');
        const result = await js(resumedSource ? 'molstudioAgent.getRuntime().continue()' : 'molstudioAgent.send(' + JSON.stringify(task.text) + ')');
        const after = await js(`(async()=>{const status=document.querySelector('.mol-agent-status')?.textContent||'';
          return {requests:__agentIntegration.requests,realTotal:__agentIntegration.realTotal,events:__agentIntegration.events,
          canvasChanges:__agentIntegration.canvasChanges,panelComplete:status==='已完成'&&!document.querySelector('.mol-agent-error:not([hidden])'),
          ...await __agentIntegration.snapshot()}})()`);
        const isCaffeineRoutes = task.name === 'caffeine-routes';
        const caffeineContext = isCaffeineRoutes ? await js('k3dAPI.agent.getContext()') : undefined;
        let caffeineImageExported = false, caffeineLayoutAudit, caffeineExportAudit;
        if (isCaffeineRoutes) {
          const observation = await js('(' + observeCaffeineCurves.toString() + ')(' + JSON.stringify(caffeineContext) + ')');
          caffeineLayoutAudit = inspectCaffeineLayout(caffeineContext, observation);
          await capture('real-' + task.name);
          caffeineExportAudit = {};
          for (const kind of ['png', 'svg']) {
            const exported = await js('k3dAPI.exportMechanismImage(' + JSON.stringify(kind) + ')');
            const content = exported.ok && exported.dataUrl ? Buffer.from(exported.dataUrl.split(',')[1], 'base64') : null;
            caffeineExportAudit[kind] = { ok: !!exported.ok && content?.length > 0 && exported.width > 0 && exported.height > 0,
              width: exported.width, height: exported.height, bytes: content?.length || 0 };
            if (content) fs.writeFileSync(path.join(OUT, 'real-caffeine-routes-mechanism.' + kind), content);
            if (kind === 'svg' && content) caffeineExportAudit.svgCoverage = await js('(' + inspectCaffeineExport.toString() + ')(' +
              JSON.stringify(exported.dataUrl) + ',' + JSON.stringify(caffeineContext.arrows.map(arrow => arrow.id)) + ')');
          }
          fs.writeFileSync(path.join(OUT, 'real-caffeine-routes.molwork'), after.source);
          const savedCaffeine = JSON.parse(after.source);
          caffeineExportAudit.editable = savedCaffeine.reactionSteps?.length === 4 && savedCaffeine.mechanism?.arrows?.length === 8;
          caffeineImageExported = caffeineExportAudit.png.ok && caffeineExportAudit.svg.ok &&
            caffeineExportAudit.svgCoverage?.complete && caffeineExportAudit.editable;
          const evidence = {
            coordinateSystem: caffeineContext.coordinateSystem,
            atoms: caffeineContext.atoms, bonds: caffeineContext.bonds, molecules: caffeineContext.molecules,
            lonePairs: caffeineContext.lonePairs, arrows: caffeineContext.arrows,
            reactionArrows: caffeineContext.reactionArrows, reactionSteps: caffeineContext.reactionSteps,
            layoutAudit: caffeineLayoutAudit, exportAudit: caffeineExportAudit,
          };
          fs.writeFileSync(path.join(OUT, 'real-caffeine-routes-context.json'), JSON.stringify(evidence, null, 2));
        }
        // 修正后的通过条件：不再用「3 原子＋2 箭头」判完整；按任务范围核对真实实体。
        const completeMechanismOk = after.molecules >= 2 && after.atoms >= 4 && after.arrows >= 2 && after.lonePairs >= 1
          && after.endpointsValid && after.texts === 0;
        let pass = task.name === 'chat'
          ? result.status === 'completed' && before.source === after.source && after.events.some(e => e.type === 'text_delta' && e.text?.trim())
          : task.name === 'explain'
            ? result.status === 'completed' && before.source === after.source && after.events.some(e => e.type === 'text_delta' && e.text?.trim())
            : task.name === 'single'
              ? result.status === 'completed' && after.atoms === 3 && after.molecules === 1 && after.texts === 0
              : task.name === 'paper-label'
                ? result.status === 'completed' && after.atoms === 0 && after.texts === 1
              : task.name === 'first-step'
                ? result.status === 'completed' && after.atoms >= 3 && after.arrows >= 1 && after.texts === 0 && after.endpointsValid
                : task.name === 'edit-arrow' || task.name === 'edit-delete'
                ? false // 由下方结构断言精确判定
                : result.status === 'completed' && completeMechanismOk
                  && (task.name !== 'plan' || (after.events.some(e => e.type === 'plan') && after.events.some(e => e.type === 'text_delta' && e.text?.trim())));
        let structural = null;
        if (task.name === 'duplicate-arrow') {
          structural = result.status === 'completed' && after.panelComplete && after.endpointsValid &&
            await js('__agentIntegration.carbonylIsComplete()');
          const exported = await js('k3dAPI.exportMechanismImage("png")');
          if (exported.ok) fs.writeFileSync(path.join(OUT, 'real-duplicate-arrow-mechanism.png'), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
          fs.writeFileSync(path.join(OUT, 'real-duplicate-arrow.molwork'), after.source);
        } else if (task.name === 'edit-arrow') {
          // 箭头仍是一根、终点在该碳上、分子未增删、无新文字
          const ctx = await js(`(async()=>{const ctx=await k3dAPI.agent.getContext();
            const arrow=ctx.arrows[0];
            return {arrows:ctx.arrows.length,atoms:ctx.atoms.length,target:arrow?arrow.target:null,
              carbon:ctx.atoms.find(atom=>atom.label==='C')||null,source:await k3dAPI.serializeWorkbench()};})()`);
          structural = result.status === 'completed' && ctx.arrows === 1
            && ctx.target && ctx.target.atomId === ctx.carbon.id
            && ctx.atoms === 3 && after.texts === 0;
          await js('window.__editArrowCtx=' + JSON.stringify({ targetAtomId: ctx.target && ctx.target.atomId, carbonId: ctx.carbon && ctx.carbon.id }));
        } else if (task.name === 'edit-delete') {
          structural = result.status === 'completed' && after.molecules === 1 && after.atoms === 3 && after.texts === 0 && after.endpointsValid;
        }
        if (structural !== null) pass = structural;
        const isKetal = task.name === 'ketal';
        const acetal = isKetal || task.name === 'hemiketal' ? inspectAcetal(await js('k3dAPI.agent.getContext()'), isKetal) : undefined;
        const methylRoutes = isCaffeineRoutes ? inspectMethylRoutes(caffeineContext) : undefined;
        if (acetal?.carbonylPair) acetal.carbonylSides = await js(`(${carbonylSides})(${JSON.stringify(acetal.carbonylPair)})`);
        if (acetal) pass = result.status === 'completed' && after.endpointsValid && acetal.routeComplete &&
          acetal.catalystCycle && acetal.electronSteps.every(Boolean) && acetal.arrows.length === (isKetal ? 7 : 3) &&
          acetal.arrows.every(arrow => arrow.horizontal && arrow.rightward) && acetal.longestBond < 1.65 &&
          acetal.hasExplicitHydrogen && acetal.closedShell && after.canvasChanges.every(change => change.source === 'agent') &&
          (isKetal ? acetal.product && acetal.aligned && acetal.resetLeft && acetal.pairedCues &&
            (!acetal.carbonylPair || acetal.carbonylSides.attack * acetal.carbonylSides.shift === -1) : after.arrows === 6);
        const recoveredToolWarnings = isCaffeineRoutes ? after.events.filter(event => event.type === 'tool_end' && event.isError)
          .map(event => ({ diagnosticCode: event.diagnostic?.code || null, operationId: event.diagnostic?.operationId || null })) : [];
        if (methylRoutes) pass = result.status === 'completed' && after.endpointsValid &&
          methylRoutes.routeCount === 2 && methylRoutes.stepCount === 4 && methylRoutes.independent &&
          methylRoutes.endpointReferencesValid && methylRoutes.routes.every(route => route.connected && route.flowPerStep && route.rightward && route.commonRow) &&
          methylRoutes.routeRows && methylRoutes.resetLeft && caffeineLayoutAudit.pass && caffeineImageExported && after.panelComplete &&
          after.events.some(event => event.type === 'run_end' && event.status === 'completed');
        let paperAudit;
        if (PAPER_MODE) {
          paperAudit = await js(`(async()=>{
            const context=await k3dAPI.agent.getContext(), state=MolStudio.document.getState();
            const page=MolWorkbench.documentModel.pageRects(state)[0], r=page.content;
            const inside=p=>p.x>=r.x-.001&&p.x<=r.x+r.w+.001&&p.y>=r.y-.001&&p.y<=r.y+r.h+.001;
            const workbench=JSON.parse(await k3dAPI.serializeWorkbench());
            return {mode:state.mode,pageId:page.id,content:r,version:workbench.version,
              atomsOnPage:context.atoms.every(inside),
              arrowsOnPage:context.reactionArrows.every(a=>inside(a.start)&&inside(a.end)),
              headingRetained:state.objects.some(o=>o.kind==='text'&&o.rich.text.includes('可编辑 A4')),
              contextHasPage:context.document?.pages?.some(p=>p.id===page.id)};
          })()`);
          pass = pass && paperAudit.mode === 'paper' && paperAudit.version === 2 && paperAudit.atomsOnPage &&
            paperAudit.arrowsOnPage && paperAudit.headingRetained && paperAudit.contextHasPage;
        }
        if (task.name === 'paper-label') {
          const textAudit = inspectPaperLabel(after.source);
          pass = pass && textAudit.exactText && textAudit.nativeTextCount === 1;
          fs.writeFileSync(path.join(OUT, 'real-paper-label.molwork'), after.source);
          fs.writeFileSync(path.join(OUT, 'real-paper-label-text-audit.json'), JSON.stringify(textAudit, null, 2));
        }
        report.real.push({ name: task.name, pass, status: result.status, requests: after.requests, realTotal: after.realTotal,
          atoms: after.atoms, molecules: after.molecules, lonePairs: after.lonePairs, arrows: after.arrows, texts: after.texts, endpointsValid: after.endpointsValid,
          ...(acetal && { [task.name]: acetal }), ...(methylRoutes && { routeAudit: methylRoutes }), ...(paperAudit && {paperAudit}),
          ...(caffeineLayoutAudit && { layoutAudit: caffeineLayoutAudit, exportAudit: caffeineExportAudit,
            completedWindow: { panelComplete: after.panelComplete, runtimeCompleted: result.status === 'completed',
              actualCurvesReadable: caffeineLayoutAudit.curves.every(curve => curve.pass), accepted: !!pass } }),
          canvasChanges: after.canvasChanges, ...(methylRoutes ? { recoveredToolWarnings } : { events: after.events }) });
        check('live model ' + task.name, pass, { status: result.status, requests: after.requests, atoms: after.atoms, molecules: after.molecules, arrows: after.arrows, texts: after.texts,
          ...(caffeineLayoutAudit && { layoutIssues: caffeineLayoutAudit.issues, stepFailures: caffeineLayoutAudit.stepFailures,
            curveFailures: caffeineLayoutAudit.curveFailures, exportAudit: caffeineExportAudit }) });
        if (!isCaffeineRoutes) await capture('real-' + task.name);
        if (acetal) {
          const exported = await js('k3dAPI.exportMechanismImage("png")');
          if (exported.ok) fs.writeFileSync(path.join(OUT, `real-${task.name}-mechanism.png`), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
          if (isKetal) fs.writeFileSync(path.join(OUT, 'real-ketal.molwork'), after.source);
        }
        console.log(JSON.stringify({ phase: task.name, pass, status: result.status, requests: after.requests, realTotal: after.realTotal }));
        if (!pass) throw new Error('Live model ' + task.name + ' failed; stopping further paid requests');
        if (task.name === 'sn2' && after.requests !== 1 && process.env.MOLSTUDIO_AGENT_REQUIRE_SINGLE_SN2 === '1') {
          throw new Error('SN2 finished but did not satisfy the single-request audit; stopping further paid requests');
        }
      }
    }
    const browserErrors = await js('__agentIntegration.errors');
    if (CAPTURE_TRANSACTIONS) {
      const observed = await js('({bridge:__agentIntegration.transactionObserverBridge,records:__agentIntegration.transactions.map(record=>({mode:record.mode,status:record.status,observerUnchanged:record.observerUnchanged,captureErrors:record.captureErrors,operationIds:record.operationIds}))})');
      check('transaction observer captures actual runtime bridge calls without changing authored source, selection, view or history',
        observed.bridge && observed.records.some(record => record.mode === 'simple' && record.status === 'succeeded' && record.operationIds.includes('nuc')) &&
        observed.records.every(record => record.observerUnchanged === true && !record.captureErrors?.length),
        { bridge: observed.bridge, calls: observed.records.length, failed: observed.records.filter(record => record.status === 'failed').length });
    }
    check('no uncaught browser or native engine errors', browserErrors.length === 0 && report.errors.length === 0, { browserErrors, consoleErrors: report.errors });
    report.browserErrors = browserErrors;
    const failures = report.checks.filter(item => !item.pass);
    report.ok = failures.length === 0;
    console.log(JSON.stringify({ passed: report.checks.length - failures.length, total: report.checks.length, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    report.ok = false;report.failure = String(error.message || error);
    console.error(report.failure);
    await capture('failure').catch(() => {});
    try { report.lastEvents = await js('__agentIntegration?.events || []'); } catch {}
    process.exitCode = 1;
  } finally {
    await flushTransactionArtifacts();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    clearTimeout(watchdog);win.destroy();app.exit(process.exitCode || 0);
  }
});
