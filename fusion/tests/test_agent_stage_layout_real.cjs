// Run with the local Electron and an isolated fusion/server.py on MOLSTUDIO_PORT.
// Exercises actual native structures and history without calling a model.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = process.env.MOLSTUDIO_AGENT_TEST_OUT && path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT);
if (out) fs.mkdirSync(out, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-stage-layout-'));
app.setPath('userData', profile);
const deadline = setTimeout(() => app.exit(2), 45_000);

async function exercise() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 150 && !window.k3dAPI?.workbenchReady?.(); i++) await wait(100);
  if (!window.k3dAPI?.workbenchReady?.()) throw new Error('Workbench did not load');
  const api = window.k3dAPI.agent;
  const { adapter } = window.MolWorkbench.app;
  const editor = adapter.ed;
  const checks = [];
  const stageSamples = window.agentStageLayoutSamples = {};
  const stageDiagnostics = window.agentStageLayoutDiagnostics = {};
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, ...(pass ? {} : { detail }) });
  const close = (a, b, tolerance = 0.02) => Math.abs(a - b) < tolerance;
  const delta = ({ start, end }) => ({ x: end.x - start.x, y: end.y - start.y });
  const core = [
    '[CH3:1][Br:2]', '[CH3:1][OH:2]', '[CH3:1][O-:2]', '[CH3:1][O:2][CH3:3]',
    '[CH3:1][NH2:2]', '[CH3:1][NH:2][CH3:3]', '[CH3:1][Cl:2]', '[CH3:1][F:2]'
  ].map((smiles, i) => ({ id: 'stage-' + i, type: 'molecule.add', smiles }));
  const reagent = { id: 'reagent', type: 'molecule.add', smiles: '[OH-:1]' };
  const byproduct = { id: 'byproduct', type: 'molecule.add', smiles: '[Br-:1]' };
  const steps = core.slice(1).map((_, i) => ({
    id: 'connector-' + i, type: 'reactionArrow.add',
    reactants: [core[i].id + ':1', ...(i === 1 ? ['reagent:1'] : [])],
    products: [core[i + 1].id + ':1', ...(i === 0 ? ['byproduct:1'] : [])],
  }));
  const snapshotGeometry = context => ({
    molecules: context.molecules.map(molecule => ({ atoms: molecule.atoms, center: molecule.center })),
    arrows: context.reactionArrows.map(({ start, end }) => ({ start, end })),
  });
  const dimensions = (context, uuid) => {
    const ids = context.molecules.find(molecule => molecule.atoms.includes(uuid)).atoms;
    const points = context.atoms.filter(atom => ids.includes(atom.id));
    return { minX: Math.min(...points.map(atom => atom.x)), maxX: Math.max(...points.map(atom => atom.x)),
      minY: Math.min(...points.map(atom => atom.y)), maxY: Math.max(...points.map(atom => atom.y)) };
  };

  async function run(mode) {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    await api.beginRun(mode);
    const initial = await api.getContext();
    const historyBefore = editor.historySize().undo;
    let receipt, followCount = 0, failingStage;
    try {
      if (mode === 'all') {
        const operations = [...core, reagent, byproduct, ...steps];
        const preview = await api.previewOperations(operations, { runId: mode });
        check('long single-batch preview shows all operations without committing', preview.previewed === operations.length &&
          (await api.getContext()).atoms.length === 0 && editor.historySize().undo === historyBefore, preview);
        receipt = await api.applyOperations(operations, { runId: mode });
      } else {
        let i = 0;
        const batches = mode === 'chunked' ? [3, 4] : Array(steps.length).fill(1);
        for (const count of batches) {
          failingStage = i + 1;
          const operations = [];
          for (let end = i + count; i < end; i++) {
            if (i === 0) operations.push(core[0], byproduct);
            if (i === 1) operations.push(reagent);
            operations.push(core[i + 1], steps[i]);
          }
          receipt = await api.applyOperations(operations, { runId: mode });
          const stage = await api.getContext();
          if (stage.viewport.viewBox !== initial.viewport.viewBox) followCount++;
        }
      }
    } catch (error) {
      const partial = await api.getContext();
      check(mode + ' chain commits', false, { message: error.message, code: error.code, failingStage,
        molecules: partial.molecules.length, connectors: partial.reactionArrows.length });
      await api.endRun(mode);
      return;
    }
    const drawn = await api.getContext();
    const arrows = drawn.reactionArrows;
    const vectors = arrows.map(delta);
    const uuids = core.map(stage => receipt.atomMapping[stage.id + ':1']);
    check(mode + ' reuses one actual structure for each unchanged intermediate', drawn.molecules.length === 10 &&
      new Set(uuids).size === core.length && arrows.length === steps.length &&
      uuids.slice(1, -1).every((uuid, i) => arrows[i].products?.includes(uuid) && arrows[i + 1].reactants?.includes(uuid)),
      { uuids, arrows: arrows.map(({ reactants, products }) => ({ reactants, products })), molecules: drawn.molecules.length });
    check(mode + ' runs five steps on the first row, wraps down, then continues left',
      vectors.length === 7 && vectors.slice(0, 5).every(v => v.x > 0 && close(v.y, 0, 0.2)) &&
      vectors[5].y > 0 && Math.abs(vectors[5].x) < vectors[5].y * 0.6 && vectors[6].x < 0 && close(vectors[6].y, 0, 0.2),
      { vectors, viewport: drawn.viewport });
    check(mode + ' native arrow shafts are compact and remain within the inter-stage gap',
      arrows.length === steps.length && arrows.every((arrow, i) => {
        const v = vectors[i];
        const from = dimensions(drawn, uuids[i]), to = dimensions(drawn, uuids[i + 1]);
        return Math.hypot(v.x, v.y) >= 0.55 && Math.hypot(v.x, v.y) <= 1.46 &&
          (i === 5 ? arrow.start.y > from.maxY && arrow.end.y < to.minY :
            i === 6 ? arrow.start.x < from.minX && arrow.end.x > to.maxX :
              arrow.start.x > from.maxX && arrow.end.x < to.minX);
      }), { arrows, vectors });
    const latest = drawn.atoms.find(atom => atom.id === uuids.at(-1));
    const view = drawn.viewport.visibleBounds;
    check(mode + ' reveals the newest stage when it extends beyond the original view',
      latest && latest.x > view.x1 && latest.x < view.x2 && latest.y > view.y1 && latest.y < view.y2 &&
      (mode === 'all' || followCount > 0),
      { latest, view, followCount, previous: initial.viewport.visibleBounds });
    const expected = mode === 'all' ? 1 : mode === 'chunked' ? 2 : steps.length;
    check(mode + ' only records real drawing batches in undo history',
      editor.historySize().undo - historyBefore === expected, editor.historySize());
    await api.endRun(mode);
    window.k3dAPI.undo();
    const undone = await api.getContext();
    const remaining = mode === 'all' ? 0 : mode === 'chunked' ? 3 : 6;
    const retained = new Set(undone.atoms.map(atom => atom.id));
    check(mode + ' undo removes the last batch without leaving stale connectors',
      undone.molecules.length === (remaining ? remaining + 3 : 0) &&
      undone.reactionArrows.length === remaining &&
      (!remaining || uuids.slice(0, remaining + 1).every(id => retained.has(id))),
      { molecules: undone.molecules.length, arrows: undone.reactionArrows.length });
    window.k3dAPI.redo();
    const redone = await api.getContext();
    check(mode + ' redo restores the same stage geometry and atom identities',
      JSON.stringify(snapshotGeometry(redone)) === JSON.stringify(snapshotGeometry(drawn)),
      { originalMolecules: drawn.molecules.length, restoredMolecules: redone.molecules.length, restoredArrows: redone.reactionArrows.length });
    check(mode + ' redone connectors still expose the atoms they link',
      redone.reactionArrows.length === steps.length && redone.reactionArrows.every((arrow, i) =>
        arrow.reactants?.includes(uuids[i]) && arrow.products?.includes(uuids[i + 1])),
      { detachedConnectors: redone.reactionArrows.filter(arrow => !arrow.reactants?.length || !arrow.products?.length).map(arrow => arrow.id) });
  }

  async function staggeredReactants() {
    await window.k3dAPI.setMolecule('');
    const runId = 'stacked-sites';
    await api.beginRun(runId);
    const result = await api.applyOperations([
      { id: 'amine', type: 'molecule.add', smiles: '[CH3:1][CH2:2][CH2:3][NH:4][CH2:5][CH2:6][CH3:7]' },
      { id: 'substrate', type: 'molecule.add', smiles: '[CH3:1][CH2:2][CH2:3][CH:4]([Br:5])[CH2:6][CH2:7][CH3:8]' },
      { id: 'product', type: 'molecule.add', smiles: 'CCCN(CCC)C(CCC)CCC' },
      { id: 'attack', type: 'arrow.add', source: { type: 'atom', atomId: 'amine:4' }, target: { type: 'atom', atomId: 'substrate:4' }, electronCount: 2 },
      { id: 'step', type: 'reactionArrow.add', reactants: ['amine:4', 'substrate:4'], products: ['product:1'] },
    ], { runId });
    const context = await api.getContext();
    const amine = dimensions(context, result.atomMapping['amine:4']);
    const substrate = dimensions(context, result.atomMapping['substrate:4']);
    const donor = context.atoms.find(atom => atom.id === result.atomMapping['amine:4']);
    const acceptor = context.atoms.find(atom => atom.id === result.atomMapping['substrate:4']);
    check('reactants can stack vertically when that brings their central reaction sites closer',
      amine.minX < substrate.maxX && substrate.minX < amine.maxX &&
      (amine.minY > substrate.maxY || substrate.minY > amine.maxY) &&
      Math.hypot(donor.x - acceptor.x, donor.y - acceptor.y) < 3,
      { amine, substrate, donor, acceptor });
    await api.endRun(runId);
  }

  async function declaredStages() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'declared-stages';
    const conditions = 'H2O, 25 C';
    const first = { id: 'step-first', type: 'reactionArrow.add', reactants: ['substrate:1', 'water:1'],
      products: ['middle:1'], layout: { reactantPlacement: 'vertical', conditions } };
    const substrate = { id: 'substrate', type: 'molecule.add', smiles: 'CBr' };
    const water = { id: 'water', type: 'molecule.add', smiles: 'O' };
    const middle = { id: 'middle', type: 'molecule.add', smiles: 'CO' };
    const wrap = { id: 'step-wrap', type: 'reactionArrow.add', reactants: ['middle:1'],
      products: ['next:1'], layout: { breakBefore: true } };
    const next = { id: 'next', type: 'molecule.add', smiles: 'CCO' };
    const last = { id: 'step-last', type: 'reactionArrow.add', reactants: ['next:1'],
      products: ['end:1'], layout: { reactantPlacement: 'auto' } };
    const end = { id: 'end', type: 'molecule.add', smiles: 'CC=O' };
    const visibleAtoms = op => Array.from(adapter.doc.querySelectorAll(`[data-agent-kind="molecule"][data-agent-op="${op.id}"] text`), node =>
      ['x', 'y'].map(axis => Number(node.getAttribute(axis))));
    const samePoints = (a, b) => a.length > 0 && a.length === b.length &&
      a.every((point, index) => point.every((coord, axis) => close(coord, b[index][axis])));
    const points = (context, uuid) => {
      const group = context.molecules.find(molecule => molecule.atoms.includes(uuid));
      return context.atoms.filter(atom => group?.atoms.includes(atom.id)).map(atom => [atom.x, atom.y]);
    };

    await api.beginRun(runId);
    try {
      const undoBefore = editor.historySize().undo;
      const reactants = [first, substrate, water];
      await api.previewOperations(reactants, { runId });
      const substratePreview = visibleAtoms(substrate), waterPreview = visibleAtoms(water);
      const substrateX = (Math.min(...substratePreview.map(p => p[0])) + Math.max(...substratePreview.map(p => p[0]))) / 2;
      check('declared reactant side appears vertically before the product is streamed',
        substratePreview.length === 2 && waterPreview.length === 1 && close(substrateX, waterPreview[0][0], 0.35) &&
        substratePreview.every(p => Math.abs(p[1] - waterPreview[0][1]) > 0.4) &&
        !adapter.doc.querySelector('[data-agent-kind="reactionArrow"]'), { substratePreview, waterPreview });

      const originalView = (await api.getContext()).viewport.viewBox;
      editor.render.setViewBox(box => ({ ...box, minX: box.minX + 85 }));
      const firstBatch = [...reactants, middle];
      await api.previewOperations(firstBatch, { runId });
      const middlePreview = visibleAtoms(middle), previewGroup = adapter.doc.querySelector('[data-agent-preview]');
      const empty = await api.getContext();
      check('product and condition appear without relocating reactants after a camera pan',
        originalView !== empty.viewport.viewBox &&
        samePoints(substratePreview, visibleAtoms(substrate)) && samePoints(waterPreview, visibleAtoms(water)) &&
        middlePreview.length === 2 && previewGroup?.textContent.includes(conditions) &&
        !!previewGroup.querySelector('[data-agent-kind="reactionArrow"]') &&
        empty.atoms.length === 0 && empty.reactionArrows.length === 0 && empty.texts.length === 0 &&
        editor.historySize().undo === undoBefore, { substratePreview, after: visibleAtoms(substrate), middlePreview,
          originalView, view: empty.viewport.viewBox, previewText: previewGroup?.textContent, atoms: empty.atoms.length, history: editor.historySize() });

      const firstReceipt = await api.applyOperations(firstBatch, { runId });
      const drawn = await api.getContext();
      const middleUuid = firstReceipt.atomMapping['middle:1'];
      const firstArrow = drawn.reactionArrows[0], firstVector = delta(firstArrow);
      const label = drawn.texts.find(text => text.text.includes(conditions));
      check('first declared stage commits at its preview coordinates with an editable conditions label',
        samePoints(substratePreview, points(drawn, firstReceipt.atomMapping['substrate:1'])) &&
        samePoints(waterPreview, points(drawn, firstReceipt.atomMapping['water:1'])) &&
        samePoints(middlePreview, points(drawn, middleUuid)) && firstVector.x > 0 && close(firstVector.y, 0, 0.2) &&
        !!label && editor.historySize().undo === undoBefore + 1,
        { firstArrow, label, middlePreview, middle: points(drawn, middleUuid), history: editor.historySize() });

      await api.applyOperations([wrap, next, last, end], { runId });
      const completed = await api.getContext();
      const arrows = completed.reactionArrows, vectors = arrows.map(delta);
      check('explicit row break points down and the next stage resumes to the right',
        completed.molecules.length === 5 && arrows.length === 3 && arrows[1].reactants.includes(middleUuid) &&
        arrows[1].products.some(uuid => arrows[2].reactants.includes(uuid)) &&
        vectors[1].y > 0 && Math.abs(vectors[1].x) < vectors[1].y * 0.6 &&
        vectors[2].x > 0 && close(vectors[2].y, 0, 0.2) &&
        samePoints(points(drawn, middleUuid), points(completed, middleUuid)),
        { vectors, molecules: completed.molecules.length });

      await api.endRun(runId);
      window.k3dAPI.undo();
      const undoneBreak = await api.getContext();
      window.k3dAPI.undo();
      const undoneAll = await api.getContext();
      window.k3dAPI.redo();
      const redone = await api.getContext();
      check('declared steps and their conditions stay together in undo and redo',
        JSON.stringify(snapshotGeometry(drawn)) === JSON.stringify(snapshotGeometry(undoneBreak)) &&
        undoneBreak.texts.some(text => text.text.includes(conditions)) && undoneAll.atoms.length === 0 &&
        undoneAll.reactionArrows.length === 0 && undoneAll.texts.length === 0 &&
        JSON.stringify(snapshotGeometry(drawn)) === JSON.stringify(snapshotGeometry(redone)) &&
        redone.texts.some(text => text.text.includes(conditions)),
        { undoRemaining: undoneBreak.molecules.length, afterAll: undoneAll.molecules.length, redo: redone.molecules.length });

      const moveRun = 'move-declared-stage';
      const middleAtoms = redone.molecules.find(molecule => molecule.atoms.includes(middleUuid)).atoms;
      const arrowPoints = context => [context.reactionArrows[0]?.start, context.reactionArrows[0]?.end].filter(Boolean).map(p => [p.x, p.y]);
      const labelPoints = context => context.texts.filter(text => text.text.includes(conditions)).map(text => [text.x, text.y]);
      await api.beginRun(moveRun);
      await api.applyOperations([{ id: 'move-middle', type: 'molecule.move', target: { atoms: middleAtoms }, dx: 2.2, dy: 0.8 }], { runId: moveRun });
      const moved = await api.getContext();
      await api.endRun(moveRun);
      check('moving a connected product refits the native arrow and its existing label',
        moved.reactionArrows.length === 1 && moved.reactionArrows[0].products?.includes(middleUuid) &&
        moved.texts.length === 1 && moved.texts[0].id === label.id &&
        !samePoints(arrowPoints(redone), arrowPoints(moved)) && !samePoints(labelPoints(redone), labelPoints(moved)),
        { beforeArrow: arrowPoints(redone), movedArrow: arrowPoints(moved), beforeLabel: labelPoints(redone), movedLabel: labelPoints(moved) });
      window.k3dAPI.undo();
      const undoneMove = await api.getContext();
      window.k3dAPI.redo();
      const redoneMove = await api.getContext();
      check('one undo and redo restore both straight arrow and condition position',
        samePoints(arrowPoints(redone), arrowPoints(undoneMove)) && samePoints(labelPoints(redone), labelPoints(undoneMove)) &&
        samePoints(arrowPoints(moved), arrowPoints(redoneMove)) && samePoints(labelPoints(moved), labelPoints(redoneMove)),
        { undone: arrowPoints(undoneMove), redone: arrowPoints(redoneMove) });
      window.k3dAPI.undo();

      const ket = JSON.parse(await window.k3dAPI.getKet());
      const saved = await window.k3dAPI.serializeWorkbench();
      const load = await window.k3dAPI.loadWorkbench(saved);
      const reopened = await api.getContext();
      const reopenedLabel = reopened.texts.find(text => text.text.includes(conditions));
      const relativeGeometry = (context, text) => {
        const arrow = context.reactionArrows[0];
        const anchor = context.atoms.find(atom => atom.id === middleUuid);
        return anchor && arrow && text ? [arrow.start, arrow.end, text].map(p => [p.x - anchor.x, p.y - anchor.y]) : [];
      };
      check('declared reaction arrows and editable conditions persist in KET and .molwork',
        ket.root.nodes.some(node => node.type === 'arrow') && ket.root.nodes.some(node => node.type === 'text' && JSON.stringify(node).includes(conditions)) &&
        load.ok && reopened.reactionArrows.length === 1 &&
        samePoints(relativeGeometry(drawn, label), relativeGeometry(reopened, reopenedLabel)),
        { load, original: relativeGeometry(drawn, label), reopened: relativeGeometry(reopened, reopenedLabel) });
    } catch (error) {
      check('declared stages can preview and commit', false, { message: error.message, code: error.code });
      await api.endRun(runId);
    }
  }

  async function wrappedMethylation() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'wrapped-methylation';
    const xanthine = '[CH3:2][n:3]1[c:4](=[O:5])[c:6]2[N][cH:7][n:8][c:9]2[n:10]([CH3:11])[c:12]1=[O:13]';
    await api.beginRun(runId);
    try {
      await api.applyOperations([
        { id: 'deprotonation', type: 'reactionArrow.add', reactants: ['neutral:1', 'base:1'], products: ['anion:1', 'water:1'], layout: {} },
        { id: 'neutral', type: 'molecule.add', smiles: xanthine.replace('[N]', '[nH:1]') },
        { id: 'base', type: 'molecule.add', smiles: '[OH-:1]' },
        { id: 'anion', type: 'molecule.add', smiles: xanthine.replace('[N]', '[n-:1]') },
        { id: 'water', type: 'molecule.add', smiles: '[OH2:1]' },
      ], { runId });
      const receipt = await api.applyOperations([
        { id: 'methylation', type: 'reactionArrow.add', reactants: ['anion:1', 'sulfate:1'],
          products: ['caffeine:1', 'leaving:2'], layout: { breakBefore: true, conditions: 'SN2, H2O/NaOH' } },
        { id: 'sulfate', type: 'molecule.add', smiles: '[CH3:1][O:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]' },
        { id: 'donor', type: 'lonePair.add', atom: 'anion:1' },
        { id: 'attack', type: 'arrow.add', source: { type: 'lonePair', id: 'donor' }, target: { type: 'atom', atomId: 'sulfate:1' }, electronCount: 2 },
        { id: 'bond-break', type: 'arrow.add', source: { type: 'bond', bondId: 'sulfate:bond:1', component: 'sigma' },
          target: { type: 'atom', atomId: 'sulfate:2' }, electronCount: 2 },
        { id: 'caffeine', type: 'molecule.add', smiles: xanthine.replace('[N]', '[n:1]([CH3:14])') },
        { id: 'leaving', type: 'molecule.add', smiles: '[O-:2][S:3](=[O:4])(=[O:5])[O:6][CH3:7]' },
      ], { runId });
      const context = await api.getContext();
      const { model, route, app: { controller } } = window.MolWorkbench;
      const atom = ref => context.atoms.find(entry => entry.id === receipt.atomMapping[ref]);
      const donor = atom('anion:1'), methyl = atom('sulfate:1');
      const attack = receipt.created.find(op => op.id === 'attack');
      const arrow = context.arrows.find(entry => entry.id === attack.entityIds[0]);
      const geometry = model.arrowGeometry(arrow, controller.ctx());
      const length = route.arcLength(geometry.start, geometry.control, geometry.end);
      const distance = Math.hypot(donor.x - methyl.x, donor.y - methyl.y);
      check('a wrapped methylation keeps the attacking lone pair and methyl close',
        geometry.sourceOk && geometry.targetOk && distance < 4.5 && length < 5.5,
        { distance, length, donor: [donor.x, donor.y], methyl: [methyl.x, methyl.y] });

      const products = ['caffeine:1', 'leaving:2'].map(ref => dimensions(context, receipt.atomMapping[ref]));
      const actualContext = controller.ctx();
      const productGlyphs = ['caffeine:1', 'leaving:2'].map(ref => {
        const molecule = context.molecules.find(molecule => molecule.atoms.includes(receipt.atomMapping[ref]));
        return molecule.atoms.map(id => ({ id, box: actualContext.atomLabelBox(id) })).filter(item => item.box?.hasLabel && item.box.rect)
          .map(item => ({ atomId: item.id, rect: item.box.rect }));
      });
      const crossProductGlyphOverlaps = productGlyphs[0].flatMap(a => productGlyphs[1].filter(b =>
        a.rect.x1 < b.rect.x2 - 1e-6 && a.rect.x2 > b.rect.x1 + 1e-6 &&
        a.rect.y1 < b.rect.y2 - 1e-6 && a.rect.y2 > b.rect.y1 + 1e-6).map(b => ({ first: a, second: b })));
      const closestProductGlyphs = productGlyphs[0].flatMap(a => productGlyphs[1].map(b => ({ first: a, second: b,
        gap: Math.hypot(Math.max(a.rect.x1 - b.rect.x2, b.rect.x1 - a.rect.x2, 0), Math.max(a.rect.y1 - b.rect.y2, b.rect.y1 - a.rect.y2, 0)) })))
        .sort((a, b) => a.gap - b.gap)[0];
      stageDiagnostics.wrappedProductGlyphs = { productGlyphs, crossProductGlyphOverlaps, closestProductGlyphs };
      check('wrapped product groups keep their real native glyph rectangles separate',
        productGlyphs.every(group => group.length > 0) && crossProductGlyphOverlaps.length === 0,
        { productGlyphs, crossProductGlyphOverlaps });
      const { points: samples } = route.sampleCurve(geometry.start, geometry.control, geometry.end, 0.06, 20, 400);
      const crossesProduct = products.some(({ minX, minY, maxX, maxY }) => samples.some((point, index) =>
        index > 0 && route.segRectDistance(samples[index - 1], point, { x1: minX, y1: minY, x2: maxX, y2: maxY }) < 0.05));
      const straight = context.reactionArrows[1], transition = straight && delta(straight);
      const observed = context.reactionSteps.find(step => step.stepId === straight?.stepId);
      const checkedArrows = new Set(observed?.checks?.layout?.checkedArrowIds || []);
      const leavingArrow = receipt.created.find(op => op.id === 'bond-break')?.entityIds?.[0];
      const continuationLabels = context.texts.filter(text => /^续\s*1$/.test(text.text));
      check('a wrapped methylation electron-flow arrow clears the products, labels, and bonds',
        !crossesProduct && attack.layout.feasible && context.reactionArrows.length === 2 && transition.x > 0 && close(transition.y, 0, 0.02) &&
        continuationLabels.length === 2 && products.every(product => product.minY > donor.y) &&
        observed?.checks?.layout?.status === 'passed' && checkedArrows.has(arrow.id) && checkedArrows.has(leavingArrow),
        { products, start: geometry.start, control: geometry.control, end: geometry.end, crossesProduct, straight,
          collisions: attack.layout.collisions, warnings: receipt.warnings, continuationLabels, observed });
      stageSamples.wrappedMethylation = await window.k3dAPI.serializeWorkbench();
    } catch (error) {
      check('a wrapped methylation commits both reaction steps', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);
  }

  async function competingElectronFlow() {
    await window.k3dAPI.setMolecule('');
    const runId = 'competing-electron-flow';
    await api.beginRun(runId);
    try {
      const scaffold = '[CH3:2][n:3]1[c:4](=[O:5])[c:6]2[N][cH:7][n:8][c:9]2[n:10]([CH3:11])[c:12]1=[O:13]';
      const operations = [
        { id: 'host', type: 'molecule.add', smiles: scaffold.replace('[N]', '[n:1]([H:14])') },
        { id: 'base', type: 'molecule.add', smiles: '[OH-:1]' },
        { id: 'anion', type: 'molecule.add', smiles: scaffold.replace('[N]', '[n-:1]') },
        { id: 'water', type: 'molecule.add', smiles: '[OH:1][H:2]' },
        { id: 'mei', type: 'molecule.add', smiles: '[CH3:1][I:2]' },
        { id: 'product', type: 'molecule.add', smiles: scaffold.replace('[N]', '[n:1]([CH3:14])') },
        { id: 'iodide', type: 'molecule.add', smiles: '[I-:1]' },
        { id: 'base-lp', type: 'lonePair.add', atom: 'base:1' },
        { id: 'n-lp', type: 'lonePair.add', atom: 'anion:1' },
        { id: 'proton', type: 'arrow.add', source: { type: 'lonePair', id: 'base-lp' }, target: { type: 'atom', atomId: 'host:14' }, electronCount: 2 },
        { id: 'nh', type: 'arrow.add', source: { type: 'bond', atom1: 'host:1', atom2: 'host:14', component: 'sigma' }, target: { type: 'atom', atomId: 'host:1' }, electronCount: 2 },
        { id: 'attack', type: 'arrow.add', source: { type: 'lonePair', id: 'n-lp' }, target: { type: 'atom', atomId: 'mei:1' }, electronCount: 2 },
        { id: 'break', type: 'arrow.add', source: { type: 'bond', atom1: 'mei:1', atom2: 'mei:2', component: 'sigma' }, target: { type: 'atom', atomId: 'mei:2' }, electronCount: 2 },
        { id: 'deprotonate', type: 'reactionArrow.add', reactants: ['host:1', 'base:1'], products: ['anion:1', 'water:1'], layout: {} },
        { id: 'methylate', type: 'reactionArrow.add', reactants: ['anion:1', 'mei:1'], products: ['product:1', 'iodide:1'], layout: {} }
      ];
      await api.previewOperations(operations, { runId });
      const receipt = await api.applyOperations(operations, { runId });
      const context = await api.getContext();
      const { model, route, app: { controller } } = window.MolWorkbench;
      const paths = ['proton', 'nh', 'attack', 'break'].map(id => {
        const item = receipt.created.find(entry => entry.id === id);
        const arrow = context.arrows.find(entry => entry.id === item.entityIds[0]);
        const geo = model.arrowGeometry(arrow, controller.ctx());
        return route.sampleCurve(geo.start, geo.control, geo.end, 0.04, 20, 160).points;
      });
      const cross = (a, b, c, d) => {
        const side = (p, q, r) => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
        return side(a,b,c)*side(a,b,d) < -1e-8 && side(c,d,a)*side(c,d,b) < -1e-8;
      };
      const crossings = [];
      for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
        if (paths[i].slice(1).some((p, k) => paths[j].slice(1).some((q, l) => cross(paths[i][k], p, paths[j][l], q)))) crossings.push([i,j]);
      }
      const base = context.atoms.find(atom => atom.id === receipt.atomMapping['base:1']);
      const proton = context.atoms.find(atom => atom.id === receipt.atomMapping['host:14']);
      check('hydroxide docks left of the active proton and both stages avoid arrow crossings',
        crossings.length === 0 && base.x < proton.x, { crossings, base: base.x, proton: proton.x });
    } catch (error) {
      check('competing electron flow commits', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);
  }

  async function declaredChainSingleBatch() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'declared-chain-single-batch';
    const operations = steps.flatMap((arrow, index) => [
      { ...arrow, reactants: [arrow.reactants[0]], products: [arrow.products[0]], layout: {} },
      ...(index === 0 ? [core[0]] : []), core[index + 1],
    ]);
    await api.beginRun(runId);
    try {
      await api.previewOperations(operations, { runId });
      check('one declared chain previews all stages and continuation without entering history',
        adapter.doc.querySelectorAll('[data-agent-kind="reactionArrow"]').length === steps.length &&
        adapter.doc.querySelector('[data-agent-preview]')?.textContent.includes('续') &&
        (await api.getContext()).atoms.length === 0 && editor.historySize().undo === 0);
      await api.applyOperations(operations, { runId });
      const drawn = await api.getContext();
      const vectors = drawn.reactionArrows.map(delta);
      check('a long declared chain wraps down then continues right within one batch',
        drawn.molecules.length === core.length && vectors.length === steps.length &&
        vectors.slice(0, 5).every(v => v.x > 0 && close(v.y, 0, 0.2)) &&
        vectors[5].y > 0 && Math.abs(vectors[5].x) < vectors[5].y * 0.6 &&
        vectors[6].x > 0 && close(vectors[6].y, 0, 0.2) && editor.historySize().undo === 1,
        { vectors, molecules: drawn.molecules.length, history: editor.historySize() });
    } catch (error) {
      check('long declared chain can preview and commit in one batch', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);
  }

  async function reversedStageDeclarations() {
    await window.k3dAPI.setMolecule('');
    const runId = 'reversed-stage-declarations';
    const first = { id: 'first', type: 'reactionArrow.add', reactants: ['initial:1'],
      products: ['intermediate:10'], layout: { conditions: 'NaOH, H₂O, 25 °C' } };
    const second = { id: 'second', type: 'reactionArrow.add', reactants: ['intermediate:20'],
      products: ['final:1'], layout: { conditions: 'NH₃, 60 °C' } };
    const operations = [
      second, first,
      { id: 'intermediate', type: 'molecule.add', smiles: '[CH3:10][OH:20]' },
      { id: 'final', type: 'molecule.add', smiles: '[CH3:1][NH2:2]' },
      { id: 'initial', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
    ];
    await api.beginRun(runId);
    try {
      await api.previewOperations(operations, { runId });
      const previewBoxes = selector => Array.from(adapter.doc.querySelectorAll(selector), node => {
        const { x, y, width, height } = node.getBBox();
        return { x, y, width, height };
      });
      const structures = previewBoxes('[data-agent-kind="molecule"]');
      const labels = previewBoxes('[data-agent-kind="reactionArrow"] text');
      const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
      check('conditions of a declared chain preview clear of the structures',
        labels.length === 2 && structures.length === 3 && labels.every(label => label.width > 0 &&
          structures.every(structure => !overlaps(label, structure))), { labels, structures });
      const result = await api.applyOperations(operations, { runId });
      const context = await api.getContext();
      const refs = ['initial:1', 'intermediate:10', 'final:1'];
      const [initial, intermediate, final] = refs.map(ref => dimensions(context, result.atomMapping[ref]));
      const vectors = context.reactionArrows.map(delta);
      check('declared stages sort left to right by their shared molecule even with different atom references',
        initial.maxX < intermediate.minX && intermediate.maxX < final.minX &&
        vectors.length === 2 && vectors.every(vector => vector.x > 0 && close(vector.y, 0, 0.2)) &&
        context.texts.length === 2,
        { initial, intermediate, final, vectors, conditions: context.texts.map(text => [text.x, text.y]) });
    } catch (error) {
      check('reversed stage declarations can preview and commit', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);
  }

  async function readingOrderAcrossBatches() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'reading-order-batches';
    const options = { runId };
    const initial = { id: 'read-initial', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 13, y: 6 };
    const intermediate = { id: 'read-middle', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 5, y: 10 };
    const product = { id: 'read-final', type: 'molecule.add', smiles: '[CH3:1][Cl:2]', x: 2, y: 3 };
    const first = { id: 'read-step-one', type: 'reactionArrow.add',
      reactants: ['read-initial:1'], products: ['read-middle:1'], layout: {} };
    const next = { id: 'read-step-two', type: 'reactionArrow.add',
      reactants: ['read-middle:2', 'reagent:1'], products: ['read-final:1'], layout: { reactantPlacement: 'vertical' } };
    await api.beginRun(runId, { readingOrder: true });
    try {
      await api.previewOperations([first, initial, intermediate], options);
      check('reading-order preview includes the directed connector without changing the document',
        !!adapter.doc.querySelector('[data-agent-op="read-step-one"][data-agent-kind="reactionArrow"] path') &&
        (await api.getContext()).atoms.length === 0 && editor.historySize().undo === 0);
      const firstReceipt = await api.applyOperations([first, initial, intermediate], options);
      const firstContext = await api.getContext();
      const secondReceipt = await api.applyOperations([product, next, reagent], options);
      const context = await api.getContext();
      const [left, middle, right] = [firstReceipt.atomMapping['read-initial:1'],
        firstReceipt.atomMapping['read-middle:1'], secondReceipt.atomMapping['read-final:1']].map(uuid => dimensions(context, uuid));
      const vectors = context.reactionArrows.map(delta);
      const levels = context.reactionArrows.map(arrow => arrow.start.y);
      const dock = dimensions(context, secondReceipt.atomMapping['reagent:1']);
      const original = new Map(firstContext.atoms.map(atom => [atom.id, atom]));
      const retained = context.atoms.filter(atom => original.has(atom.id));
      check('reading order overrides conflicting model coordinates and implicit later steps continue right',
        vectors.length === 2 && vectors.every(vector => vector.x > 0 && close(vector.y, 0, 0.2)) &&
        left.maxX < middle.minX && middle.maxX < right.minX && context.molecules.length === 4,
        { left, middle, right, vectors });
      check('a vertically docked reagent cannot shift the next arrow off the current row baseline',
        Math.abs(dock.minY - middle.minY) > 0.8 && close(levels[0], levels[1], 1e-4), { levels, dock, middle });
      check('reading order keeps already committed atoms fixed and maintains batch undo history',
        retained.length === original.size && retained.every(atom => {
          const before = original.get(atom.id);
          return close(atom.x, before.x) && close(atom.y, before.y);
        }) && editor.historySize().undo === 2);

      const wrapOperations = [
        { id: 'read-step-wrap', type: 'reactionArrow.add', reactants: ['read-final:1'], products: ['read-wrap:1'],
          layout: { breakBefore: true } },
        { id: 'read-wrap', type: 'molecule.add', smiles: '[CH3:1][F:2]' },
      ];
      await api.previewOperations(wrapOperations, options);
      const wrapPreview = adapter.doc.querySelector('[data-agent-preview]');
      const markers = text => (text.match(/续\s*1/g) || []).length;
      check('reading-order wrap previews matching continuation markers without adding a native object',
        !!wrapPreview && markers(wrapPreview.textContent) === 2 && (await api.getContext()).texts.length === context.texts.length);
      const wrapReceipt = await api.applyOperations(wrapOperations, options);
      const wrapped = await api.getContext();
      const rowStart = dimensions(wrapped, wrapReceipt.atomMapping['read-wrap:1']);
      const connector = wrapped.reactionArrows[2];
      const wrapVector = connector && delta(connector);
      const continuations = wrapped.texts.filter(text => markers(text.text));
      check('a new row resets left below the first row and its reaction arrow still points right',
        !!wrapVector && wrapVector.x > 0 && close(wrapVector.y, 0, 0.2) &&
        rowStart.minY > Math.max(left.maxY, middle.maxY, right.maxY, dock.maxY) &&
        rowStart.minX >= left.minX - 0.5 && rowStart.maxX < right.maxX &&
        connector.end.x < rowStart.minX && continuations.length === 2 && wrapped.molecules.length === 5 &&
        connector.reactants?.includes(secondReceipt.atomMapping['read-final:1']) &&
        connector.products?.includes(wrapReceipt.atomMapping['read-wrap:1']) &&
        continuations.some(text => text.y < rowStart.minY) && continuations.some(text => close(text.y, rowStart.minY, 1)),
        { left, middle, right, rowStart, wrapVector, continuations: continuations.map(({ x, y }) => ({ x, y })) });
      const lastReceipt = await api.applyOperations([
        { id: 'read-after-wrap', type: 'molecule.add', smiles: '[CH3:1][NH2:2]' },
        { id: 'read-last-step', type: 'reactionArrow.add', reactants: ['read-wrap:1'], products: ['read-after-wrap:1'] },
      ], options);
      const completed = await api.getContext();
      const rowNext = dimensions(completed, lastReceipt.atomMapping['read-after-wrap:1']);
      const finalVector = completed.reactionArrows[3] && delta(completed.reactionArrows[3]);
      check('an implicit batch continues to the right from the new row instead of folding back',
        !!finalVector && finalVector.x > 0 && close(finalVector.y, 0, 0.2) && rowStart.maxX < rowNext.minX &&
        close(rowStart.minY, rowNext.minY, 0.4) && close(connector.start.y, completed.reactionArrows[3].start.y, 1e-4) &&
        connector.start.y > levels[0] && editor.historySize().undo === 4,
        { rowStart, rowNext, finalVector, undo: editor.historySize().undo });
      await api.endRun(runId);
      window.k3dAPI.undo();
      window.k3dAPI.undo();
      const undone = await api.getContext();
      window.k3dAPI.redo();
      const redone = await api.getContext();
      check('wrap markers and their native arrow undo and redo together',
        undone.reactionArrows.length === 2 && undone.texts.every(text => !markers(text.text)) &&
        redone.reactionArrows.length === 3 && redone.molecules.length === 5 &&
        redone.texts.filter(text => markers(text.text)).length === 2,
        { undone: { arrows: undone.reactionArrows.length, labels: undone.texts.length },
          redone: { arrows: redone.reactionArrows.length, labels: redone.texts.length } });
    } catch (error) {
      check('reading order can preview and commit both batches', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);

    await window.k3dAPI.setMolecule('');
    const explicitRun = 'reading-order-explicit-coordinates';
    const explicit = { runId: explicitRun };
    await api.beginRun(explicitRun, { readingOrder: false });
    try {
      const result = await api.applyOperations([first, initial, { ...intermediate, y: initial.y }], explicit);
      const context = await api.getContext();
      const center = ref => context.molecules.find(molecule => molecule.atoms.includes(result.atomMapping[ref])).center;
      const source = center('read-initial:1'), target = center('read-middle:1');
      check('coordinate-controlled mode respects user positions instead of changing arrow direction',
        close(source.x, initial.x) && close(source.y, initial.y) && close(target.x, intermediate.x) &&
        close(target.y, initial.y) && context.reactionArrows.length === 1 && delta(context.reactionArrows[0]).x < 0,
        { source, target, arrows: context.reactionArrows });
    } catch (error) {
      check('coordinate-controlled mode can commit a leftward connector', false, { message: error.message, code: error.code });
    }
    await api.endRun(explicitRun);
  }

  async function immediateReplacement() {
    await window.k3dAPI.setMolecule('');
    const runId = 'replacement-identities';
    await api.beginRun(runId);
    const first = await api.applyOperations([
      { id: 'start', type: 'molecule.add', smiles: 'CO' },
      { id: 'middle', type: 'molecule.add', smiles: 'CCl' },
      { id: 'incoming', type: 'reactionArrow.add', reactants: ['start:1'], products: ['middle:1'] },
    ], { runId });
    await wait(260);
    const second = await api.applyOperations([
      { id: 'end', type: 'molecule.add', smiles: 'CBr' },
      { id: 'outgoing', type: 'reactionArrow.add', reactants: ['middle:1'], products: ['end:1'] },
    ], { runId });
    const context = await api.getContext();
    const middle = first.atomMapping['middle:1'];
    check('drawing immediately after replacement retains aliases for later tool batches',
      middle === second.atomMapping['middle:1'] && context.atoms.some(atom => atom.id === middle) &&
      context.reactionArrows[0]?.products?.includes(middle) && context.reactionArrows[1]?.reactants?.includes(middle),
      { middle, arrows: context.reactionArrows });
    await api.endRun(runId);
  }

  async function separateReadingPaths() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'separate-reading-paths', options = { runId };
    await api.beginRun(runId, { readingOrder: true, separatePaths: true });
    try {
      const receipts = [];
      for (let i = 0; i < 3; i++) {
        const prefix = 'path-' + i;
        const first = [
          { id: prefix + '-a', type: 'molecule.add', smiles: '[CH3:1][Br:2]' },
          { id: prefix + '-b', type: 'molecule.add', smiles: '[CH3:1][OH:2]' },
          { id: prefix + '-one', type: 'reactionArrow.add', reactants: [prefix + '-a:1'], products: [prefix + '-b:1'] },
        ];
        const before = await api.getContext();
        await api.previewOperations(first, options);
        check('separate path preview leaves committed geometry fixed',
          JSON.stringify(snapshotGeometry(await api.getContext())) === JSON.stringify(snapshotGeometry(before)));
        receipts.push(await api.applyOperations(first, options));
        await api.applyOperations([
          { id: prefix + '-c', type: 'molecule.add', smiles: '[CH3:1][Cl:2]' },
          { id: prefix + '-two', type: 'reactionArrow.add', reactants: [prefix + '-b:1'], products: [prefix + '-c:1'] },
        ], options);
      }
      const context = await api.getContext();
      const starts = receipts.map((receipt, i) => dimensions(context, receipt.atomMapping['path-' + i + '-a:1']));
      const ends = receipts.map((receipt, i) => dimensions(context, receipt.atomMapping['path-' + i + '-b:1']));
      check('independent paths start aligned on separate rows while connected steps continue right',
        starts.every((start, i) => (!i || start.minY > Math.max(starts[i - 1].maxY, ends[i - 1].maxY)) &&
          close(start.minX, starts[0].minX, 0.1) && start.maxX < ends[i].minX) &&
        context.reactionArrows.length === 6 && context.reactionArrows.every((arrow, i, arrows) =>
          delta(arrow).x > 0 && close(delta(arrow).y, 0) && (!i || i % 2 === 0 || close(arrow.start.y, arrows[i - 1].start.y))) &&
        context.texts.every(text => !/续\s*\d/.test(text.text)), { starts, ends });
    } finally { await api.endRun(runId); }
  }

  async function lateReadingOrderConnector() {
    await window.k3dAPI.setMolecule('');
    editor.clearHistory();
    const runId = 'reading-order-late-connector';
    const options = { runId };
    await api.beginRun(runId, { readingOrder: true });
    try {
      const receipt = await api.applyOperations([
        { id: 'late-source', type: 'molecule.add', smiles: '[CH3:1][Br:2]', x: 13, y: 7 },
        { id: 'late-product', type: 'molecule.add', smiles: '[CH3:1][OH:2]', x: 5, y: 7 },
      ], options);
      const sourceId = receipt.atomMapping['late-source:1'], productId = receipt.atomMapping['late-product:1'];
      const before = await api.getContext();
      const sourceBefore = dimensions(before, sourceId), productBefore = dimensions(before, productId);
      const connector = [{ id: 'late-connector', type: 'reactionArrow.add',
        reactants: ['late-source:1'], products: ['late-product:1'] }];
      await api.previewOperations(connector, options);
      check('late connector preview leaves both already displayed structures fixed',
        !!adapter.doc.querySelector('[data-agent-op="late-connector"][data-agent-kind="reactionArrow"] path') &&
        JSON.stringify(snapshotGeometry(await api.getContext())) === JSON.stringify(snapshotGeometry(before)) &&
        editor.historySize().undo === 1);
      await api.applyOperations(connector, options);
      const after = await api.getContext();
      const source = dimensions(after, sourceId), product = dimensions(after, productId);
      const vector = after.reactionArrows[0] && delta(after.reactionArrows[0]);
      check('a late semantic connector can align its unattached product without moving its source',
        productBefore.maxX < sourceBefore.minX && source.maxX < product.minX &&
        JSON.stringify(source) === JSON.stringify(sourceBefore) &&
        !!vector && vector.x > 0 && close(vector.y, 0, 0.2) &&
        after.molecules.length === 2 && after.reactionArrows.length === 1 && editor.historySize().undo === 2,
        { sourceBefore, productBefore, source, product, vector });
      await api.endRun(runId);
      window.k3dAPI.undo();
      const undone = await api.getContext();
      window.k3dAPI.redo();
      const redone = await api.getContext();
      check('late connector alignment and native arrow undo and redo together',
        JSON.stringify(snapshotGeometry(undone)) === JSON.stringify(snapshotGeometry(before)) &&
        JSON.stringify(snapshotGeometry(redone)) === JSON.stringify(snapshotGeometry(after)));
      const wrappedRun = { runId: 'reading-order-late-wrapped-connector' };
      await api.beginRun(wrappedRun.runId, { readingOrder: true });
      try {
        const next = await api.applyOperations([
          { id: 'late-next', type: 'molecule.add', smiles: '[CH3:1][Cl:2]', x: product.maxX + 5, y: product.minY },
        ], wrappedRun);
        await api.applyOperations([{ id: 'late-wrap', type: 'reactionArrow.add',
          reactants: [productId], products: ['late-next:1'], layout: { breakBefore: true } }], wrappedRun);
        const wrapped = await api.getContext();
        const row = dimensions(wrapped, next.atomMapping['late-next:1']);
        const arrow = wrapped.reactionArrows[1] && delta(wrapped.reactionArrows[1]);
        check('a late connector starts a requested continuation at the original left margin',
          row.minY > product.maxY && Math.abs(row.minX - source.minX) < 4.5 &&
          !!arrow && arrow.x > 0 && close(arrow.y, 0, 0.2) &&
          wrapped.texts.filter(text => /续\s*1/.test(text.text)).length === 2 &&
          JSON.stringify(dimensions(wrapped, productId)) === JSON.stringify(product), { row, source, product, arrow });
      } finally {
        await api.endRun(wrappedRun.runId);
      }
    } catch (error) {
      check('a late connector can preview and commit', false, { message: error.message, code: error.code });
    }
    await api.endRun(runId);
  }

  async function readingOrderReagentDivider() {
    await window.k3dAPI.setMolecule('');
    const runId = 'reading-order-reagent-divider';
    await api.beginRun(runId, { readingOrder: true });
    try {
      await api.applyOperations([core[0], core[1], { ...steps[0], products: ['stage-1:1'] }], { runId });
      const before = await api.getContext();
      const first = before.reactionArrows[0];
      const receipt = await api.applyOperations([
        { ...steps[1], reactants: ['stage-1:1', 'reagent:1'], layout: { reactantPlacement: 'horizontal' } },
        reagent, core[2],
        { id: 'stage-flow-reagent', type: 'arrow.add', source: { type: 'atom', atomId: 'reagent:1' },
          target: { type: 'atom', atomId: 'stage-1:1' }, electronCount: 2 },
      ], { runId });
      const after = await api.getContext();
      const reagentBounds = dimensions(after, receipt.atomMapping['reagent:1']);
      check('a later reagent stays beyond the preceding reaction arrow',
        reagentBounds.minX > first.end.x && after.reactionArrows.length === 2 &&
        JSON.stringify(after.reactionArrows[0]) === JSON.stringify(first), { first, afterFirst: after.reactionArrows[0], reagentBounds });
    } catch (error) {
      check('a later reagent can dock without obstructing the preceding reaction arrow', false, { message: error.message, code: error.code });
    } finally { await api.endRun(runId); }
  }

  async function readingOrderSpectatorLane() {
    await window.k3dAPI.setMolecule('');
    const runId = 'reading-order-spectator-lane';
    await api.beginRun(runId, { readingOrder: true });
    try {
      await api.applyOperations([
        { id: 'protonation', type: 'reactionArrow.add', reactants: ['acetone:2', 'acid:1'], products: ['activated:2', 'water:1'] },
        { id: 'acetone', type: 'molecule.add', smiles: '[CH3:1][C:2](=[O:3])[CH3:4]' },
        { id: 'acid', type: 'molecule.add', smiles: '[OH2+:1][H:2]' },
        { id: 'activated', type: 'molecule.add', smiles: '[CH3:1][C:2](=[OH+:3])[CH3:4]' },
        { id: 'water', type: 'molecule.add', smiles: '[OH2:1]' },
      ], { runId });
      const receipt = await api.applyOperations([
        { id: 'ethanol', type: 'molecule.add', smiles: '[OH:1][CH2:2][CH3:3]' },
        { id: 'oxonium', type: 'molecule.add', smiles: '[CH3:1][C:2]([OH:3])([O+:4]([H:5])[CH2:6][CH3:7])[CH3:8]' },
        { id: 'attack', type: 'arrow.add', source: { type: 'atom', atomId: 'ethanol:1' },
          target: { type: 'formingBond', atom1: 'ethanol:1', atom2: 'activated:2' }, electronCount: 2 },
      ], { runId });
      const prepared = await api.getContext(), baseline = prepared.reactionArrows[0].start.y;
      const activated = dimensions(prepared, receipt.atomMapping['activated:2']);
      const ethanol = dimensions(prepared, receipt.atomMapping['ethanol:1']);
      // First finish real flow creation, then establish the lane obstruction,
      // and finally add the connector that must fit around it. Moving an old
      // spectator after that connector exists tests a different edit contract.
      await api.applyOperations([
        { id: 'place-ethanol-below', type: 'molecule.move', target: { molecule: prepared.molecules.find(m => m.atoms.includes(receipt.atomMapping['ethanol:1'])).id },
          x: (activated.minX + activated.maxX) / 2, y: activated.maxY + 1.3 + (ethanol.maxY - ethanol.minY) / 2 },
        { id: 'park-loose-oxonium', type: 'molecule.move', target: { molecule: prepared.molecules.find(m => m.atoms.includes(receipt.atomMapping['oxonium:2'])).id },
          x: activated.maxX + 10, y: baseline + 4 },
        { id: 'place-water-at-shaft-edge', type: 'molecule.move', target: { atoms: [receipt.atomMapping['water:1']] },
          x: activated.maxX + 0.45 + 0.35, y: baseline - 0.50 },
      ], { runId });
      const obstructed = await api.getContext(), waterBefore = obstructed.atoms.find(atom => atom.id === receipt.atomMapping['water:1']);
      await api.applyOperations([{ id: 'addition', type: 'reactionArrow.add', reactants: ['activated:2', 'ethanol:1'], products: ['oxonium:2'],
        layout: { reactantPlacement: 'vertical' } }], { runId });
      const context = await api.getContext(), [first, second] = context.reactionArrows;
      const water = context.atoms.find(atom => atom.id === receipt.atomMapping['water:1']);
      const realContext = window.MolWorkbench.app.controller.ctx(), waterGlyph = realContext.atomLabelBox(water.id)?.rect;
      const sourceIds = ['activated:2', 'ethanol:1'].flatMap(ref => context.molecules.find(m => m.atoms.includes(receipt.atomMapping[ref])).atoms);
      const sourceGlyphs = sourceIds.map(id => realContext.atomLabelBox(id)?.rect).filter(Boolean);
      const spectatorInkClear = waterGlyph && sourceGlyphs.every(box =>
        waterGlyph.x1 >= box.x2 || waterGlyph.x2 <= box.x1 || waterGlyph.y1 >= box.y2 || waterGlyph.y2 <= box.y1);
      check('a spectator at the edge of the next arrow shortens it without changing its height',
        close(water.x, waterBefore.x, 1e-4) && close(water.y, waterBefore.y, 1e-4) && close(water.y - baseline, -0.50, 1e-4) && spectatorInkClear &&
        close(first.start.y, second.start.y, 1e-4) && second.start.x > water.x + 0.45 &&
        delta(second).x < delta(first).x - 0.05, { first, second, water, waterBefore, activated, baseline, waterGlyph, spectatorInkClear });
      stageSamples.spectatorLane = await window.k3dAPI.serializeWorkbench();
    } catch (error) {
      check('a spectator at the edge of the next arrow leaves a usable horizontal lane', false, { message: error.message, code: error.code });
    } finally { await api.endRun(runId); }
  }

  async function independentChains() {
    await window.k3dAPI.setMolecule('');
    const runId = 'independent-chains';
    const operations = [...core.slice(0, 5), steps[1], steps[0],
      { ...steps[3], reactants: ['stage-3:1'], products: ['stage-4:1'] }]
      .map(op => op.type === 'reactionArrow.add' ? { ...op, reactants: [op.reactants[0]], products: [op.products[0]] } : op);
    await api.beginRun(runId);
    try {
      await api.previewOperations(operations, { runId });
      check('independent chains preview all three connectors without writing',
        adapter.doc.querySelectorAll('[data-agent-kind="reactionArrow"]').length === 3 && (await api.getContext()).atoms.length === 0);
      const result = await api.applyOperations(operations, { runId });
      const context = await api.getContext();
      check('independent chains reserve their own gaps, even with out-of-order edges', context.molecules.length === 5 &&
        context.reactionArrows.length === 3 && context.reactionArrows.every(arrow => {
          const from = dimensions(context, arrow.reactants[0]), to = dimensions(context, arrow.products[0]);
          return arrow.start.x > from.maxX && arrow.end.x < to.minX && arrow.end.x > arrow.start.x && close(arrow.start.y, arrow.end.y);
        }), { connectors: result.created.filter(item => item.type === 'reactionArrow.add') });
    } catch (error) {
      check('independent chains reserve their own gaps', false, error.message);
    }
    await api.endRun(runId);
  }

  async function independentStagesAcrossBatches() {
    await window.k3dAPI.setMolecule('');
    const runId = 'independent-stages-across-batches';
    await api.beginRun(runId, { readingOrder: true });
    try {
      const receipts = [];
      for (let batch = 0; batch < 2; batch++) {
        const operations = [];
        for (let i = batch * 3; i < batch * 3 + 3; i++) {
          operations.push({ id: `ind-source-${i}`, type: 'molecule.add', smiles: '[CH3:1][CH2:2][CH2:3][CH2:4][CH2:5][CH2:6][CH3:7]' },
            { id: `ind-product-${i}`, type: 'molecule.add', smiles: '[CH3:1][CH2:2][CH2:3][CH2:4][CH2:5][CH2:6][CH3:7]' },
            { id: `ind-step-${i}`, type: 'reactionArrow.add', reactants: [`ind-source-${i}:1`], products: [`ind-product-${i}:1`] });
        }
        await api.previewOperations(operations, { runId });
        receipts.push(await api.applyOperations(operations, { runId }));
      }
      const context = await api.getContext();
      const bounds = Array.from({ length: 6 }, (_, i) => ({
        source: dimensions(context, receipts[Math.floor(i / 3)].atomMapping[`ind-source-${i}:1`]),
        product: dimensions(context, receipts[Math.floor(i / 3)].atomMapping[`ind-product-${i}:1`])
      }));
      const firstRow = bounds.filter(item => close(item.source.minY, bounds[0].source.minY, 0.2));
      check('independent stages pack across batches and wrap as whole blocks',
        firstRow.length >= 4 && firstRow.length <= 5 && bounds[5].source.minY > bounds[0].source.maxY &&
        bounds[0].product.maxX - bounds[0].source.minX >= 12 && bounds[0].product.maxX - bounds[0].source.minX <= 15 &&
        firstRow[firstRow.length - 1].product.maxX - firstRow[0].source.minX <= 76 &&
        bounds.every(({ source, product }) => source.maxX < product.minX && close(source.minY, product.minY, 0.2)) &&
        firstRow.every((item, i) => !i || item.source.minX > firstRow[i - 1].product.maxX) &&
        context.reactionArrows.length === 6 && !context.texts.some(text => /续\s*\d/.test(text.text)), { bounds });
    } catch (error) {
      check('independent stages pack across batches and wrap as whole blocks', false, { message: error.message, code: error.code });
    } finally { await api.endRun(runId); }
  }

  async function offscreenStages() {
    await window.k3dAPI.setMolecule('');
    const runId = 'offscreen-stages';
    const add = (id, smiles, x, y) => ({ id, type: 'molecule.add', smiles, x, y });
    const connector = (id, reactants, products) => ({ id, type: 'reactionArrow.add', reactants, products });
    await api.beginRun(runId);
    try {
      await api.applyOperations([
        add('remote-substrate', 'CCO', 65, 70), add('remote-product', 'CCBr', 71, 70), add('spectator', '[I-]', 78, 70)
      ], { runId });
      const receipt = await api.applyOperations([connector('remote-step', ['remote-substrate:1', 'spectator:1'], ['remote-product:1'])], { runId });
      const arrow = receipt.created[0];
      check('a remote spectator does not block the gap between the main molecules', arrow.start.x > 65 && arrow.end.x < 71 &&
        arrow.start.x < arrow.end.x && close(arrow.start.y, arrow.end.y), arrow);
      await api.applyOperations([{ id: 'next-remote-product', type: 'molecule.add', smiles: 'CCCl' },
        connector('remote-next', ['remote-product:1'], ['next-remote-product:1'])], { runId });
      const context = await api.getContext(), next = context.reactionArrows[1], bounds = context.viewport.visibleBounds;
      const added = context.molecules.find(molecule => molecule.atoms.includes(next.products[0]));
      check('automatic continuation stays with the offscreen stage and follows it into view', added.center.x > 71 && added.center.x < 85 &&
        added.center.x >= bounds.x1 && added.center.x <= bounds.x2 && added.center.y >= bounds.y1 && added.center.y <= bounds.y2,
      { center: added.center, bounds, next });
    } catch (error) {
      check('offscreen stages can commit connectors', false, error.message);
    }
    await api.endRun(runId);
  }

  async function overlappingStageBounds() {
    await window.k3dAPI.setMolecule('');
    const runId = 'overlapping-stage-bounds';
    const { x, y } = (await api.getContext()).viewport.center;
    await api.beginRun(runId);
    await api.applyOperations([
      { id: 'substrate', type: 'molecule.add', smiles: 'CBr', x: x - 5, y },
      { id: 'product', type: 'molecule.add', smiles: 'CO', x, y },
      { id: 'spectator', type: 'molecule.add', smiles: '[Na+]', x: x + 5, y }
    ], { runId });
    try {
      const receipt = await api.applyOperations([{ id: 'join', type: 'reactionArrow.add',
        reactants: ['substrate:1', 'spectator:1'], products: ['product:1'] }], { runId });
      const { start, end } = receipt.created[0];
      check('overlapping stage rectangles leave a real clear connector path', start.x > x - 5 && end.x < x && end.x > start.x, { start, end });
    } catch (error) {
      check('overlapping stage rectangles leave a real clear connector path', false, { code: error.code, message: error.message });
    }
    await api.endRun(runId);
  }

  await run('all');
  await run('split');
  await run('chunked');
  await staggeredReactants();
  await declaredStages();
  await wrappedMethylation();
  await competingElectronFlow();
  await declaredChainSingleBatch();
  await reversedStageDeclarations();
  await readingOrderAcrossBatches();
  await separateReadingPaths();
  await lateReadingOrderConnector();
  await readingOrderReagentDivider();
  await readingOrderSpectatorLane();
  await immediateReplacement();
  await independentChains();
  await independentStagesAcrossBatches();
  await offscreenStages();
  await overlappingStageBounds();
  return checks;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false } });
  let status = 1;
  try {
    await win.loadURL('http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 48972) + '/canvas.html');
    const checks = await win.webContents.executeJavaScript('(' + exercise.toString() + ')()');
    const failures = checks.filter(check => !check.pass);
    console.log(JSON.stringify({ passed: checks.length - failures.length, total: checks.length, failures }, null, 2));
    if (out) {
      const samples = await win.webContents.executeJavaScript('window.agentStageLayoutSamples || {}');
      for (const [name, saved] of Object.entries(samples)) {
        fs.writeFileSync(path.join(out, name + '.molwork'), saved);
        await win.webContents.executeJavaScript('k3dAPI.loadWorkbench(' + JSON.stringify(saved) + ')');
        const exported = await win.webContents.executeJavaScript('k3dAPI.exportMechanismImage("png")');
        if (exported.ok) fs.writeFileSync(path.join(out, 'canvas-source-' + name + '.png'), Buffer.from(exported.dataUrl.split(',')[1], 'base64'));
      }
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ application: 'MolStudio canvas', page: 'fusion/canvas.html',
        build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron',
        service: 'http://127.0.0.1:' + (process.env.MOLSTUDIO_PORT || 48972), modelCalls: 0,
        passed: checks.length - failures.length, total: checks.length, failures, checks,
        diagnostics: await win.webContents.executeJavaScript('window.agentStageLayoutDiagnostics || {}') }, null, 2));
    }
    status = failures.length ? 1 : 0;
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(deadline);
    win.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(status);
  }
});
