import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isExplicitLayoutOnly, assertLayoutOperations, layoutChemicalIdentity, verifiedLayoutCompletion } from '../layout-completion.js';

const strictPrompt = '请整理当前画布上已有的 N-甲酰化机理。将甲酸质子化步骤作为单独的准备支路，清楚显示其产物与主线使用的是同一个质子化甲酸；如跨行或跨支路，请使用配对的续接标记，不复制分子。主线各步骤按反应顺序排列，同一行的直反应箭头对齐基线，并核对每一步电子流清晰可读。只整理现有内容，保留所有分子、原子、键、电子流和反应步骤的身份及化学连接，不增加、删除或改写任何化学对象，也不要继续后面的合成阶段。完成后简短说明整理结果。';
const clone = value => structuredClone(value);
const atom = (id, label, implicitH = 0, charge = 0) => ({ id, label, implicitH, charge, radical: 0, isotope: 0, aromatic: false,
  hasQuery: false, stereoLabel: null, stereoParity: null, alias: null, x: 0, y: 0 });
function canvas() {
  return { sessionId: 'doc-layout', atoms: [atom('o', 'O', 1, -1), atom('acl', 'Cl'), atom('h', 'H'), atom('cl', 'Cl', 0, -1),
    atom('wo', 'O', 2), atom('c', 'C', 3), atom('br', 'Br'), atom('pc', 'C', 3), atom('pcl', 'Cl'), atom('pbr', 'Br', 0, -1)],
    bonds: [{ id: 'hcl', begin: 'acl', end: 'h', order: 1, stereo: 0 }, { id: 'cbr', begin: 'c', end: 'br', order: 1, stereo: 0 },
      { id: 'pccl', begin: 'pc', end: 'pcl', order: 1, stereo: 0 }],
    molecules: [{ id: 'mol1', atoms: ['o'] }, { id: 'mol2', atoms: ['acl', 'h'] }, { id: 'mol3', atoms: ['cl'] },
      { id: 'mol4', atoms: ['wo'] }, { id: 'mol5', atoms: ['c', 'br'] }, { id: 'mol6', atoms: ['pc', 'pcl'] }, { id: 'mol7', atoms: ['pbr'] }],
    lonePairs: [{ id: 'lp-o', ownerAtomId: 'o', electronCount: 2, angle: 0, refAtomId: 'h', angleRel: 0 },
      { id: 'lp-cl', ownerAtomId: 'cl', electronCount: 2, angle: 0, refAtomId: 'c', angleRel: 0 }],
    arrows: [{ id: 'prep-attack', source: { type: 'lonePair', slotId: 'lp-o', ownerAtomId: 'o' },
      target: { type: 'formingBond', atomA: 'o', atomB: 'h' }, electronCount: 2, geometry: { bend: 0.5, mode: 'auto' } },
    { id: 'prep-leave', source: { type: 'bond', bondId: 'hcl', component: 'sigma' }, target: { type: 'atom', atomId: 'acl' },
      electronCount: 2, geometry: { bend: 1, mode: 'auto' } },
    { id: 'attack', source: { type: 'lonePair', slotId: 'lp-cl', ownerAtomId: 'cl' }, target: { type: 'formingBond', atomA: 'cl', atomB: 'c' },
      electronCount: 2, geometry: { bend: 0.5, mode: 'auto' } },
    { id: 'leave', source: { type: 'bond', bondId: 'cbr', component: 'sigma' }, target: { type: 'atom', atomId: 'br' },
      electronCount: 2, geometry: { bend: 1, mode: 'auto' } }],
    reactionSteps: [{ stepId: 'prep', version: 1, reactants: ['o', 'acl'], products: ['cl', 'wo'], conditions: '', layout: {},
      checks: { layout: { status: 'passed', issues: [], checkedArrowIds: ['prep-attack', 'prep-leave'] } },
      ports: [{ token: '接 B1', kind: 'merge', side: 'target', at: 'port', anchorRefs: ['cl'], position: { x: 5, y: 4 } }] },
    { stepId: 'sn2', version: 1, reactants: ['cl', 'c'], products: ['pc', 'pbr'], conditions: '', layout: {},
      checks: { layout: { status: 'passed', issues: [], checkedArrowIds: ['attack', 'leave'] }, chemistry: { status: 'pending', issues: [] } },
      ports: [{ token: '接 B1', kind: 'merge', side: 'source', at: 'molecule', anchorRefs: ['cl'], position: { x: 0, y: 2 } }] }],
    reactionArrows: [{ id: '0', stepId: 'prep', reactants: ['o', 'acl'], products: ['cl', 'wo'], start: { x: 2, y: 4 }, end: { x: 3.5, y: 4 } },
      { id: '1', stepId: 'sn2', reactants: ['cl', 'c'], products: ['pc', 'pbr'], start: { x: 2, y: 0 }, end: { x: 3.5, y: 0 } }],
    texts: [{ id: 'cue-a', text: '接 B1', x: 0, y: 2 }, { id: 'cue-b', text: '接 B1', x: 5, y: 2 }] };
}

test('explicit layout-only classifier accepts the actual strict reflow request and preserves mixed chemistry questions', () => {
  assert.equal(isExplicitLayoutOnly(strictPrompt), true);
  assert.equal(isExplicitLayoutOnly('Layout-only: preserve all identities and chemical connections; do not add, delete or modify chemical objects. Briefly report the layout result.'), true);
  for (const prompt of ['移动这个分子。', '整理一下布局。', '只整理当前内容，不需要保留旧对象。',
    strictPrompt + '另外请解释第一步的反应机理。', strictPrompt + '为什么第一步需要水合氢离子？',
    strictPrompt + '另外核对每一步反应是否满足电荷守恒。',
    strictPrompt + '请将所选分子明确移动到 x=10、y=20。',
    '只调整所选分子的布局，保留身份及化学连接，不增加、删除或改写任何化学对象。移动到 x=10、y=20。',
    '只整理选中显式氢的布局，保留身份及化学连接，不增加、删除或改写任何化学对象。将末端 O–H 的 H 朝向目标 N，使用 orientTowardAtomId。',
    '只整理选中箭头的布局，保留身份及化学连接，不增加、删除或改写任何化学对象。设置 bend=0.6，mode=manual。',
    "Layout-only: preserve identities and chemical connections; do not add, delete or change chemical objects. Explain the mechanism."]) {
    assert.equal(isExplicitLayoutOnly(prompt), false, prompt);
  }
});

test('strict whole-canvas layout scope accepts semantic layout controls and rejects direct geometry or chemistry', () => {
  const valid = [{ id: 'tidy', type: 'layout.tidy' },
    { id: 'lp-auto', type: 'lonePair.modify', lonePairId: 'lp-o', aim: 'auto' },
    { id: 'arrow-auto', type: 'arrow.modify', arrowId: 'attack', mode: 'auto' },
    { id: 'layout', type: 'reactionStep.modify', stepId: 'sn2', expectedVersion: 1,
      layout: { reactantPlacement: 'horizontal', reagentPlacement: 'above', breakBefore: true } },
    { id: 'same-layout', type: 'reactionStep.modify', stepId: 'sn2', expectedVersion: 1, layout: {} }];
  assert.doesNotThrow(() => assertLayoutOperations(valid));
  for (const bad of [{ id: 'move', type: 'molecule.move', target: { molecule: 'mol1' }, x: 10, y: 20 },
    { id: 'offset', type: 'molecule.move', target: { atoms: ['c'] }, dx: 1, dy: 2 },
    { id: 'h-turn', type: 'molecule.move', target: { atoms: ['explicit-h'] }, orientTowardAtomId: 'o' },
    { id: 'lp-angle', type: 'lonePair.modify', lonePairId: 'lp-o', angle: 30 },
    { id: 'lp-manual', type: 'lonePair.modify', lonePairId: 'lp-o', aim: 'manual' },
    { id: 'lp-implicit', type: 'lonePair.modify', lonePairId: 'lp-o' },
    { id: 'bend', type: 'arrow.modify', arrowId: 'attack', bend: 0.6, mode: 'manual' },
    { id: 'auto-bend', type: 'arrow.modify', arrowId: 'attack', bend: 0.6, mode: 'auto' },
    { id: 'manual', type: 'arrow.modify', arrowId: 'attack', mode: 'manual' },
    { id: 'mode-implicit', type: 'arrow.modify', arrowId: 'attack' },
    { id: 'layout-implicit', type: 'reactionStep.modify', stepId: 'sn2', expectedVersion: 1 },
    { id: 'seal', type: 'step.seal' },
    { id: 'add', type: 'molecule.add', smiles: 'C' }, { id: 'delete', type: 'arrow.delete', arrowId: 'attack' },
    { id: 'charge', type: 'atom.modify', atomId: 'o', charge: 0 }, { id: 'bond', type: 'bond.modify', bondId: 'cbr', order: 2 },
    { id: 'lp-owner', type: 'lonePair.modify', lonePairId: 'lp-o', ownerAtomId: 'br' },
    { id: 'source', type: 'arrow.modify', arrowId: 'attack', source: { type: 'atom', atomId: 'br' } },
    { id: 'target', type: 'arrow.modify', arrowId: 'attack', target: { type: 'atom', atomId: 'br' } },
    { id: 'count', type: 'arrow.modify', arrowId: 'attack', electronCount: 1 },
    { id: 'participants', type: 'reactionStep.modify', stepId: 'sn2', expectedVersion: 1, reactants: ['pc'] },
    { id: 'conditions', type: 'reactionStep.modify', stepId: 'sn2', expectedVersion: 1, layout: { conditions: 'new chemistry' } }]) {
    assert.throws(() => assertLayoutOperations([bad]), error => error.code === 'layout_scope_violation' && error.operationId === bad.id && error.operationType === bad.type);
  }
});

test('chemical identity is reorder-safe and ignores geometry versions and lone-pair aim only', () => {
  const before = canvas(), after = clone(before);
  after.atoms.reverse(); after.bonds.reverse(); after.molecules.reverse(); after.arrows.reverse();
  for (const atom of after.atoms) { atom.x += 10; atom.y -= 3; }
  for (const molecule of after.molecules) molecule.atoms.reverse();
  for (const bond of after.bonds) [bond.begin, bond.end] = [bond.end, bond.begin];
  after.reactionSteps[0].version++; after.reactionSteps[0].reactants.reverse(); after.reactionSteps[0].products.reverse();
  after.reactionSteps[0].layout = { reagentPlacement: 'below', breakBefore: true };
  after.reactionArrows[0].start.x += 2; after.reactionArrows[0].end.x += 2;
  after.reactionArrows[0].reactants.reverse(); after.reactionArrows[0].products.reverse();
  after.lonePairs[0].angle = 100; after.lonePairs[0].angleRel = 24; after.lonePairs[0].refAtomId = 'br';
  after.arrows[0].geometry.bend = -0.8;
  assert.equal(layoutChemicalIdentity(after), layoutChemicalIdentity(before));
  assert.equal(layoutChemicalIdentity(null), null); assert.equal(layoutChemicalIdentity({ available: false }), null);
});

test('chemical identity protects atom states bond graph owners electron endpoints and step participants', () => {
  const original = canvas(), baseline = layoutChemicalIdentity(original);
  const mutations = [c => c.sessionId = 'other-document', c => c.atoms[0].id = 'different-atom', c => c.atoms[0].implicitH++,
    c => c.atoms[0].charge++, c => c.atoms[0].isotope = 18, c => c.atoms[0].radical = 2, c => c.atoms[0].label = 'N',
    c => c.atoms[0].aromatic = true, c => c.atoms[0].hasQuery = true, c => c.atoms[0].stereoLabel = 'R',
    c => c.atoms[0].stereoParity = 1, c => c.atoms[0].alias = 'changed', c => c.bonds[0].order = 2,
    c => c.bonds[0].end = 'po', c => c.bonds[0].stereo = 1, c => c.molecules[0].atoms.push('po'),
    c => c.lonePairs[0].ownerAtomId = 'br', c => c.lonePairs[0].electronCount = 1,
    c => c.arrows[0].source.ownerAtomId = 'br', c => c.arrows[0].target.atomB = 'br',
    c => c.arrows[1].source.component = 'pi', c => c.arrows[0].electronCount = 1,
    c => c.reactionSteps[0].reactants = ['pc'], c => c.reactionSteps[0].products = ['o'],
    c => c.reactionSteps[0].conditions = 'changed', c => c.reactionArrows[0].stepId = 'other-step'];
  for (const mutate of mutations) {
    const changed = clone(original); mutate(changed);
    assert.notEqual(layoutChemicalIdentity(changed), baseline, mutate.toString());
    assert.equal(verifiedLayoutCompletion(baseline, changed).ok, false);
  }
  const stereo = canvas(); stereo.bonds[0].stereo = 1;
  const reverse = clone(stereo); [reverse.bonds[0].begin, reverse.bonds[0].end] = [reverse.bonds[0].end, reverse.bonds[0].begin];
  assert.notEqual(layoutChemicalIdentity(stereo), layoutChemicalIdentity(reverse), 'directed wedge reversal is chemical metadata');
});

test('verified completion reports observed counts and actual paired tokens without chemical narratives', () => {
  const current = canvas(), result = verifiedLayoutCompletion(layoutChemicalIdentity(current), current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, { molecules: 7, atoms: 10, bonds: 3, electronFlows: 4, reactionSteps: 2, horizontalArrows: 2, pairedTokens: ['接B1'] });
  assert.match(result.text, /7 个分子.*2 个反应步骤.*4 根电子流/);
  assert.doesNotMatch(result.text, /质子化|甲酰化|甲酸|吡嗪|化学检查.*通过|chemistry passed/i);
  current.texts.push({ id: 'user-1', text: '续 99' }, { id: 'user-2', text: '续 99' });
  assert.deepEqual(verifiedLayoutCompletion(layoutChemicalIdentity(current), current).facts.pairedTokens, ['接B1'], 'unrelated user text is not an actual reference port');
});

test('verified completion rejects failed layout bad shafts unpaired references and unequal port anchors', () => {
  const before = canvas(), baseline = layoutChemicalIdentity(before);
  for (const mutate of [c => c.reactionSteps[0].checks.layout.status = 'pending', c => c.reactionSteps[0].checks.layout.status = 'failed',
    c => c.reactionArrows[0].end.y = 1, c => c.reactionArrows[0].end.x = -1, c => c.reactionArrows[0].start.x = NaN,
    c => c.texts.pop(), c => c.reactionSteps[0].ports.pop(), c => c.reactionSteps[1].ports[0].anchorRefs = ['br'],
    c => c.reactionSteps[1].ports[0].anchorRefs = ['missing'], c => c.reactionSteps[1].ports[0].kind = 'wrap',
    c => c.reactionSteps[1].ports[0].side = 'reactants', c => c.reactionSteps[1].ports[0].at = 'port']) {
    const changed = clone(before); mutate(changed);
    assert.equal(verifiedLayoutCompletion(baseline, changed).ok, false, mutate.toString());
  }
});

test('actual same-step source/source wraps are physical reference roles rather than opposite chemical sides', () => {
  const { context } = JSON.parse(fs.readFileSync(new URL('./fixtures/actual-same-side-wrap-context.json', import.meta.url), 'utf8'));
  const baseline = layoutChemicalIdentity(context), result = verifiedLayoutCompletion(baseline, context);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.facts.pairedTokens, ['接B1', '续1', '续2', '续3']);
  for (const mutate of [c => c.reactionSteps.find(step => step.ports.some(port => port.token === '续 1')).ports.find(port => port.token === '续 1').side = 'invalid',
    c => c.reactionSteps.find(step => step.ports.some(port => port.token === '续 1')).ports.find(port => port.token === '续 1' && port.at === 'molecule').at = 'port',
    c => c.reactionSteps.find(step => step.ports.some(port => port.token === '续 1')).ports.find(port => port.token === '续 1' && port.at === 'port').anchorRefs = ['missing-physical-atom'],
    c => {
      const owner = c.reactionSteps.find(step => step.ports.some(port => port.token === '续 1'));
      // This is a real product component elsewhere in the same canvas, but
      // neither source/source reference end may silently point to it.
      for (const port of owner.ports.filter(port => port.token === '续 1')) port.anchorRefs = [owner.products[0]];
    }]) {
    const changed = clone(context); mutate(changed);
    assert.equal(verifiedLayoutCompletion(baseline, changed).ok, false);
  }
});

test('captured grouped-home port ownership covers native23 fork and corrected Traube without accepting unrelated peers', () => {
  const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/actual-grouped-home-port-contexts.json', import.meta.url), 'utf8'));
  for (const fixture of cases) {
    const baseline = layoutChemicalIdentity(fixture.context);
    const result = verifiedLayoutCompletion(baseline, fixture.context);
    assert.equal(result.ok, true, fixture.name + ': ' + result.message);
  }
  const current = clone(cases[0].context), baseline = layoutChemicalIdentity(current);
  const ports = current.reactionSteps.flatMap(step => (step.ports || []).map(port => ({ step, port })));
  const token = ports.find(({ port }) => port.kind === 'wrap').port.token;
  const pair = ports.filter(({ port }) => port.token === token), peer = pair.find(({ port }) => port.at === 'port');
  const owners = new Map(current.molecules.flatMap(molecule => molecule.atoms.map(id => [id, molecule.id])));
  const peerSide = new Set(peer.step.reactants.map(id => owners.get(id)));
  const unrelated = current.molecules.find(molecule => !peerSide.has(molecule.id)).atoms[0];
  for (const { port } of pair) port.anchorRefs = [unrelated];
  assert.equal(verifiedLayoutCompletion(baseline, current).ok, false, 'matching global refs cannot replace a real peer-owned group');
});

test('legacy wrap text is certified only when actual step metadata names its continuation', () => {
  const current = canvas();
  for (const step of current.reactionSteps) step.ports = [];
  current.reactionSteps[1].layoutStatus = { status: 'passed', continuation: 1 };
  current.texts = [{ id: 'legacy-a', text: '续 1' }, { id: 'legacy-b', text: '续 1' },
    { id: 'user-a', text: '接 B99' }, { id: 'user-b', text: '接 B99' }];
  const baseline = layoutChemicalIdentity(current), result = verifiedLayoutCompletion(baseline, current);
  assert.equal(result.ok, true); assert.deepEqual(result.facts.pairedTokens, ['续1']);
  current.texts.shift(); assert.equal(verifiedLayoutCompletion(baseline, current).ok, false);
});
