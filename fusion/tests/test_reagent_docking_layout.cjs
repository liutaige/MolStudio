'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../workbench/mechanism-model.js');
require('../workbench/mechanism-route.js');
require('../workbench/mechanism-controller.js');
require('../workbench/workbench-storage.js');
const { createBridge } = require('../workbench/agent-bridge.js');

function createMockHarness(initialStruct = null, fetchHandler = null) {
  let atomIdCounter = 100, bondIdCounter = 100, rxnArrowCounter = 1, textCounter = 1;
  const st = initialStruct || {
    atoms: new Map(),
    bonds: new Map(),
    frags: new Map([[1, {}]]),
    texts: new Map(),
    rxnArrows: new Map(),
  };

  const structOps = {
    version: 1,
    atomAttr: class {
      constructor(id, attr, val) { this.id = id; this.attr = attr; this.val = val; }
      perform(c) {
        const p = c.molecule.atoms.get(this.id)[this.attr];
        c.molecule.atoms.get(this.id)[this.attr] = this.val;
        return new structOps.atomAttr(this.id, this.attr, p);
      }
    },
    bondAttr: class {
      constructor(id, attr, val) { this.id = id; this.attr = attr; this.val = val; }
      perform(c) {
        const p = c.molecule.bonds.get(this.id)[this.attr];
        c.molecule.bonds.get(this.id)[this.attr] = this.val;
        return new structOps.bondAttr(this.id, this.attr, p);
      }
    },
    bondAdd: class {
      constructor(b, e, p) { this.b = b; this.e = e; this.p = p; }
      perform(c) {
        const bid = bondIdCounter++;
        c.molecule.bonds.set(bid, { begin: this.b, end: this.e, type: this.p.type });
        return { perform: () => c.molecule.bonds.delete(bid) };
      }
    },
    recalc: (molecule, rids) => {
      for (const rid of rids) {
        const at = molecule.atoms.get(rid);
        if (!at) continue;
        let bondOrderSum = 0;
        for (const [, b] of molecule.bonds) {
          if (b.begin === rid || b.end === rid) bondOrderSum += b.type;
        }
        if (at.label === 'N' && bondOrderSum >= 3 && at.charge === 0 && (at.radical || 0) > 0) {
          at.badConn = true;
        } else {
          at.badConn = false;
        }
      }
    }
  };

  const native = {
    version: 1,
    serialize: () => JSON.stringify({}),
    prepareKet: (text) => {
      const json = JSON.parse(text);
      const mol = Object.values(json).find(x => x?.type === 'molecule') || json;
      const atoms = new Map(), bonds = new Map();
      for (const [i, a] of (mol.atoms || []).entries()) {
        atoms.set(i, { label: a.label, pp: { x: a.location[0], y: a.location[1] }, charge: a.charge || 0 });
      }
      for (const [i, b] of (mol.bonds || []).entries()) {
        bonds.set(i, { begin: b.atoms[0], end: b.atoms[1], type: b.type || 1 });
      }
      return { atoms, bonds, isArrow: !!json.root?.nodes?.some(n => n.type === 'arrow') };
    },
    paste: (ctab, fragment, placed) => {
      if (fragment.isArrow) {
        const rxnId = rxnArrowCounter++;
        ctab.molecule.rxnArrows.set(rxnId, { mode: 'open-angle', pos: [{ x: placed.x - 1, y: placed.y }, { x: placed.x + 1, y: placed.y }] });
        return [{ perform: () => {} }, {}, { rxnArrows: [rxnId] }];
      }
      const xs = Array.from(fragment.atoms.values(), a => a.pp.x);
      const ys = Array.from(fragment.atoms.values(), a => a.pp.y);
      const dx = placed.x - (Math.min(...xs) + Math.max(...xs)) / 2;
      const dy = placed.y - (Math.min(...ys) + Math.max(...ys)) / 2;
      const atomRids = [], bondRids = [];
      const indexToRid = new Map();
      for (const [idx, atom] of fragment.atoms) {
        const rid = atomIdCounter++;
        atomRids.push(rid);
        indexToRid.set(idx, rid);
        ctab.molecule.atoms.set(rid, {
          label: atom.label,
          pp: { x: atom.pp.x + dx, y: atom.pp.y + dy },
          charge: atom.charge || 0,
          radical: 0,
          fragment: 1
        });
      }
      for (const [idx, bond] of fragment.bonds) {
        const bid = bondIdCounter++;
        bondRids.push(bid);
        ctab.molecule.bonds.set(bid, {
          begin: indexToRid.get(bond.begin),
          end: indexToRid.get(bond.end),
          type: bond.type || 1
        });
      }
      const action = {
        isDummy: () => false,
        perform: (c) => {
          for (const rid of atomRids) c.molecule.atoms.delete(rid);
          for (const bid of bondRids) c.molecule.bonds.delete(bid);
          return { isDummy: () => false, perform: () => {} };
        }
      };
      return [action, { atoms: atomRids, bonds: bondRids }, { rxnArrows: [] }];
    },
    createText: (ctab, text, pos) => {
      const tid = textCounter++;
      ctab.molecule.texts.set(tid, { content: text, position: pos });
      return { perform: () => {} };
    },
    structOps: () => structOps
  };

  const doc = {
    defaultView: {
      innerWidth: 1200,
      innerHeight: 800,
      molstudioNativeActions: native,
      molstudioNativeStructOps: structOps
    },
    createElementNS: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const ed = {
    struct: () => st,
    render: {
      clientArea: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }) },
      ctab: { molecule: st, markBond: () => {}, markItem: () => {}, markAtom: () => {} },
      setViewBox: () => {},
      update: () => {}
    },
    update: () => {},
    historyPtr: 0,
    historyStack: []
  };

  const model = new globalThis.MolWorkbench.model.MechanismModel();
  let lastAction = null;
  const app = {
    adapter: {
      ed, doc,
      bondLength: () => 1,
      atomPos: (rid) => st.atoms.get(rid)?.pp || null,
      atomIdOf: (uuid) => typeof uuid === 'number' ? uuid : parseInt(String(uuid).replace(/\D/g, '')) || null,
      uuidOfAtom: (rid) => 'atom-' + rid,
      bondIdOf: (uuid) => typeof uuid === 'number' ? uuid : parseInt(String(uuid).replace(/\D/g, '')) || null,
      uuidOfBond: (rid) => 'bond-' + rid,
      syncIdentity: () => {},
      chemSnapshot: () => ({ atoms: Array.from(st.atoms.entries(), ([rid, a]) => ({ uuid: 'atom-' + rid, label: a.label, pos: a.pp })) }),
      onDirtyHint: () => {},
      clientToModel: (pt) => ({ x: (pt.x - 600) / 40, y: (pt.y - 400) / 40 }),
      zoom: () => 1,
      offset: () => ({ x: 0, y: 0 }),
      canvasSvg: () => null,
      selection: () => ({ atoms: [], bonds: [] }),
      k: { setMolecule: () => {} },
      onChange: () => () => {}
    },
    model,
    controller: {
      selection: new Set(),
      wrapNativeHistory: (act) => { lastAction = act; return act; },
      ctx: () => ({
        atomPos: (id) => {
          const rid = app.adapter.atomIdOf(id);
          return rid ? st.atoms.get(rid)?.pp : null;
        },
        bondInfo: (id) => {
          const bid = app.adapter.bondIdOf(id);
          const b = bid ? st.bonds.get(bid) : null;
          return b ? {
            uuid: id,
            begin: st.atoms.get(b.begin)?.pp,
            end: st.atoms.get(b.end)?.pp,
            beginAtom: 'atom-' + b.begin,
            endAtom: 'atom-' + b.end,
            type: b.type
          } : null;
        },
        atomLabelBox: () => null,
        atoms: () => Array.from(st.atoms.entries(), ([rid, a]) => ({ uuid: 'atom-' + rid, label: a.label, pos: a.pp })),
        bonds: () => Array.from(st.bonds.entries(), ([bid, b]) => ({
          uuid: 'bond-' + bid,
          begin: st.atoms.get(b.begin)?.pp,
          end: st.atoms.get(b.end)?.pp,
          beginAtom: 'atom-' + b.begin,
          endAtom: 'atom-' + b.end,
          type: b.type
        })),
        lonePair: (id) => model.lonePair(id),
        unit: () => 1
      }),
      replanArrowInPlace: () => ({ feasible: true, plan: { bend: 0.25 } }),
      replanConcertedArrows: () => new Map(),
      planFor: () => ({ plan: { bend: 0.25 } }),
      refreshAutoSlots: () => {},
      emitSelection: () => {},
      render: () => {},
      onDirtyHint: () => {}
    },
    layer: { ensure: () => doc.createElementNS() }
  };

  globalThis.k3dAPI = {};
  const bridge = createBridge(app, {
    native,
    fetch: fetchHandler
  });

  return { bridge, st, ed, model, app, getLastAction: () => lastAction };
}

test('测试 A（Aldol 图1 复现）：OH⁻ 被排布在螺环底物活性 H 所在左侧，绝不横穿双环到右侧且无重叠', async () => {
  const fetchHandler = async (url, opts) => {
    const { smiles } = JSON.parse(opts.body);
    if (smiles === 'spiro_substrate') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [
                { label: 'H', location: [-2.5, 0, 0] },
                { label: 'N', location: [-1.5, 0, 0] },
                { label: 'C', location: [-0.5, 1, 0] },
                { label: 'C', location: [-0.5, -1, 0] },
                { label: 'C', location: [0.5, 0, 0] },
                { label: 'C', location: [1.5, 1, 0] },
                { label: 'C', location: [1.5, -1, 0] },
                { label: 'C', location: [2.5, 0, 0] }
              ],
              bonds: [
                { atoms: [0, 1], type: 1 },
                { atoms: [1, 2], type: 1 }, { atoms: [1, 3], type: 1 },
                { atoms: [2, 4], type: 1 }, { atoms: [3, 4], type: 1 },
                { atoms: [4, 5], type: 1 }, { atoms: [4, 6], type: 1 },
                { atoms: [5, 7], type: 1 }, { atoms: [6, 7], type: 1 }
              ]
            }
          },
          atoms: [
            { ref: '1', index: 0, label: 'H' },
            { ref: '2', index: 1, label: 'N' },
            { ref: '3', index: 2, label: 'C' },
            { ref: '4', index: 3, label: 'C' },
            { ref: '5', index: 4, label: 'C' },
            { ref: '6', index: 5, label: 'C' },
            { ref: '7', index: 6, label: 'C' },
            { ref: '8', index: 7, label: 'C' }
          ],
          bonds: [
            { ref: '1', index: 0, begin: '1', end: '2' },
            { ref: '2', index: 1, begin: '2', end: '3' },
            { ref: '3', index: 2, begin: '2', end: '4' },
            { ref: '4', index: 3, begin: '3', end: '5' },
            { ref: '5', index: 4, begin: '4', end: '5' },
            { ref: '6', index: 5, begin: '5', end: '6' },
            { ref: '7', index: 6, begin: '5', end: '7' },
            { ref: '8', index: 7, begin: '6', end: '8' },
            { ref: '9', index: 8, begin: '7', end: '8' }
          ]
        })
      };
    }
    if (smiles === '[OH-:1]') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'O', location: [0, 0, 0], charge: -1 }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'O' }],
          bonds: []
        })
      };
    }
    if (smiles === 'product') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'C', location: [0, 0, 0] }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'C' }],
          bonds: []
        })
      };
    }
    return { ok: false };
  };

  const { bridge, st } = createMockHarness(null, fetchHandler);
  await bridge.beginRun('run-aldol', { readingOrder: true });

  const ops = [
    { id: 'sub', type: 'molecule.add', smiles: 'spiro_substrate' },
    { id: 'oh', type: 'molecule.add', smiles: '[OH-:1]' },
    { id: 'prod', type: 'molecule.add', smiles: 'product' },
    { id: 'lp1', type: 'lonePair.add', atom: 'oh:1' },
    { id: 'ar1', type: 'arrow.add', source: { type: 'lonePair', id: 'lp1' }, target: { type: 'atom', atomId: 'sub:1' }, electronCount: 2 },
    { id: 'ar2', type: 'arrow.add', source: { type: 'bond', atom1: 'sub:1', atom2: 'sub:2', component: 'sigma' }, target: { type: 'atom', atomId: 'sub:2' }, electronCount: 2 },
    { id: 'rxn', type: 'reactionArrow.add', reactants: ['sub:1', 'oh:1'], products: ['prod:1'] }
  ];

  const receipt = await bridge.applyOperations(ops, { runId: 'run-aldol' });
  assert.equal(receipt.created.length, 7);

  const subCreated = receipt.created.find(c => c.id === 'sub');
  const ohCreated = receipt.created.find(c => c.id === 'oh');
  const hAtomId = subCreated.atoms.find(a => a.ref === '1').id;
  const ohAtomId = ohCreated.atoms.find(a => a.ref === '1').id;

  const hPos = bridge.getContext().atoms.find(a => a.id === hAtomId);
  const ohPos = bridge.getContext().atoms.find(a => a.id === ohAtomId);

  // 1. OH- 必须排布在底物左侧（ohAtom.x < hAtom.x）
  assert.ok(ohPos.x < hPos.x, `OH- 坐标 (${ohPos.x}) 应该在 H 坐标 (${hPos.x}) 左侧`);

  // 2. 检查包围盒不与底物原子重叠
  const subAtoms = subCreated.atoms.map(a => bridge.getContext().atoms.find(at => at.id === a.id));
  const subMinX = Math.min(...subAtoms.map(a => a.x));
  assert.ok(ohPos.x < subMinX, `OH- 坐标 (${ohPos.x}) 应该在整个底物左边界 (${subMinX}) 左侧`);
  for (const a of subAtoms) {
    const dist = Math.hypot(ohPos.x - a.x, ohPos.y - a.y);
    assert.ok(dist >= 0.90, `OH- 与底物原子 ${a.id} 之间距离 (${dist}) 应大于等于 0.90，绝不重叠`);
  }
});

test('测试 B（咖啡因图3 多试剂复现）：H2O 与 NO+ 均停靠在底物上方活性半球，绝不挤到底物正下方背侧', async () => {
  const fetchHandler = async (url, opts) => {
    const { smiles } = JSON.parse(opts.body);
    if (smiles === 'caffeine_core') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [
                { label: 'C', location: [-0.866, -1.0, 0] }, // C5
                { label: 'H', location: [-1.4, -1.5, 0] },   // H on C5
                { label: 'C', location: [0.866, -1.0, 0] },  // C6
                { label: 'N', location: [1.4, 0.0, 0] },     // N1
                { label: 'C', location: [0.866, 1.0, 0] },   // C2
                { label: 'N', location: [-0.866, 1.0, 0] },  // N3
                { label: 'C', location: [-1.4, 0.0, 0] }     // C4
              ],
              bonds: [
                { atoms: [0, 1], type: 1 }, // C5-H
                { atoms: [0, 2], type: 2 }, // C5=C6
                { atoms: [2, 3], type: 1 },
                { atoms: [3, 4], type: 1 },
                { atoms: [4, 5], type: 1 },
                { atoms: [5, 6], type: 1 },
                { atoms: [6, 0], type: 1 }
              ]
            }
          },
          atoms: [
            { ref: '1', index: 0, label: 'C' },
            { ref: '2', index: 1, label: 'H' },
            { ref: '3', index: 2, label: 'C' },
            { ref: '4', index: 3, label: 'N' },
            { ref: '5', index: 4, label: 'C' },
            { ref: '6', index: 5, label: 'N' },
            { ref: '7', index: 6, label: 'C' }
          ],
          bonds: [
            { ref: '1', index: 0, begin: '1', end: '2' },
            { ref: '2', index: 1, begin: '1', end: '3' },
            { ref: '3', index: 2, begin: '3', end: '4' },
            { ref: '4', index: 3, begin: '4', end: '5' },
            { ref: '5', index: 4, begin: '5', end: '6' },
            { ref: '6', index: 5, begin: '6', end: '7' },
            { ref: '7', index: 6, begin: '7', end: '1' }
          ]
        })
      };
    }
    if (smiles === 'H2O') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'O', location: [0, 0, 0] }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'O' }],
          bonds: []
        })
      };
    }
    if (smiles === 'NO+') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'N', location: [0, 0, 0], charge: 1 }, { label: 'O', location: [1, 0, 0] }],
              bonds: [{ atoms: [0, 1], type: 2 }]
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'N' }, { ref: '2', index: 1, label: 'O' }],
          bonds: [{ ref: '1', index: 0, begin: '1', end: '2' }]
        })
      };
    }
    if (smiles === 'product') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'C', location: [0, 0, 0] }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'C' }],
          bonds: []
        })
      };
    }
    return { ok: false };
  };

  const { bridge } = createMockHarness(null, fetchHandler);
  await bridge.beginRun('run-caffeine', { readingOrder: true });

  const ops = [
    { id: 'sub', type: 'molecule.add', smiles: 'caffeine_core' },
    { id: 'water', type: 'molecule.add', smiles: 'H2O' },
    { id: 'no', type: 'molecule.add', smiles: 'NO+' },
    { id: 'prod', type: 'molecule.add', smiles: 'product' },
    { id: 'lp_w', type: 'lonePair.add', atom: 'water:1' },
    { id: 'ar1', type: 'arrow.add', source: { type: 'lonePair', id: 'lp_w' }, target: { type: 'atom', atomId: 'sub:2' }, electronCount: 2 },
    { id: 'ar2', type: 'arrow.add', source: { type: 'bond', bondId: 'sub:bond:2', component: 'pi' }, target: { type: 'atom', atomId: 'no:1' }, electronCount: 2 },
    { id: 'rxn', type: 'reactionArrow.add', reactants: ['sub:1', 'water:1', 'no:1'], products: ['prod:1'], layout: { reactantPlacement: 'vertical' } }
  ];

  const receipt = await bridge.applyOperations(ops, { runId: 'run-caffeine' });
  assert.equal(receipt.created.length, 8);

  const subCreated = receipt.created.find(c => c.id === 'sub');
  const waterCreated = receipt.created.find(c => c.id === 'water');
  const noCreated = receipt.created.find(c => c.id === 'no');

  const context = bridge.getContext();
  const subAtoms = subCreated.atoms.map(a => context.atoms.find(at => at.id === a.id));
  const ringCenterY = subAtoms.reduce((s, a) => s + a.y, 0) / subAtoms.length;

  const waterAtom = context.atoms.find(at => at.id === waterCreated.atoms[0].id);
  const noAtom = context.atoms.find(at => at.id === noCreated.atoms[0].id);

  // 验证 H2O 与 NO+ 都在上半球（y < ringCenterY）
  assert.ok(waterAtom.y < ringCenterY, `H2O (y=${waterAtom.y}) 必须在环中心 (y=${ringCenterY}) 上半球`);
  assert.ok(noAtom.y < ringCenterY, `NO+ (y=${noAtom.y}) 必须在环中心 (y=${ringCenterY}) 上半球`);
});

test('测试 C（超价残留自由基自动清零）：N(radical=3, charge=1) 改 charge=0 并变参三键时自动清除残留自由基，undo 恢复', async () => {
  const initialStruct = {
    atoms: new Map([
      [1, { label: 'N', pp: { x: 0, y: 0 }, charge: 1, radical: 3, badConn: false, fragment: 1 }],
      [2, { label: 'O', pp: { x: 1.2, y: 0 }, charge: 0, radical: 0, badConn: false, fragment: 1 }]
    ]),
    bonds: new Map([
      [1, { begin: 1, end: 2, type: 2 }]
    ]),
    frags: new Map([[1, {}]]),
    texts: new Map(),
    rxnArrows: new Map(),
  };

  const { bridge, st, ed, getLastAction } = createMockHarness(initialStruct);
  await bridge.beginRun('run-radical');

  const ops = [
    { id: 'am1', type: 'atom.modify', atomId: 'atom-1', charge: 0 },
    { id: 'bm1', type: 'bond.modify', bondId: 'bond-1', order: 3 }
  ];

  const receipt = await bridge.applyOperations(ops, { runId: 'run-radical' });
  const nAtom = st.atoms.get(1);

  // 验证应用后：charge=0, radical 被自动清零, badConn=false, bond.type=3
  assert.equal(nAtom.charge, 0);
  assert.equal(nAtom.radical, 0);
  assert.equal(nAtom.badConn, false);
  assert.equal(st.bonds.get(1).type, 3);
  assert.ok(receipt.warnings.some(w => w.includes('已自动清除超价原子上的残留自由基标记')));

  // 验证 undo 可撤销恢复：charge=1, radical=3, bond.type=2
  const lastAction = getLastAction();
  assert.ok(lastAction);
  lastAction.perform(ed.render.ctab);

  assert.equal(nAtom.charge, 1);
  assert.equal(nAtom.radical, 3);
  assert.equal(st.bonds.get(1).type, 2);
});

test('测试 D（自动孤对避让显式氢字形框）：orientAutomaticPair 避开 ctx.atomLabelBox.hydrogenRects 方向', () => {
  const M = globalThis.MolWorkbench.model;
  const lp = M.makeLonePair('atom-1', { origin: 'automatic', angle: 0 });
  const automaticPairs = new Set([lp.id]);
  const source = { type: 'lonePair', slotId: lp.id, ownerAtomId: 'atom-1' };
  const target = { type: 'atom', atomId: 'atom-target' };

  // 宿主原子在 (0, 0)，目标在 (1, 0)（outgoing 角度 0度）
  // 显式 H 字形框在 (0.5, 0)（角度 0度，正压在直连方向上）
  const ctx = {
    lonePair: () => lp,
    atomPos: (id) => id === 'atom-1' ? { x: 0, y: 0 } : { x: 2, y: 0 },
    bonds: () => [],
    atomLabelBox: (id) => id === 'atom-1' ? {
      hydrogenRects: [{ x1: 0.3, y1: -0.2, x2: 0.7, y2: 0.2 }]
    } : null
  };

  // 通过内部 orientAutomaticPair 测试
  // 由于 agent-bridge 内部封装，我们可以通过 arrow.add 触发或者直接调用
  // 这里在 mock 环境中模拟 arrow.add
  const initialStruct = {
    atoms: new Map([
      [1, { label: 'O', pp: { x: 0, y: 0 }, charge: -1, fragment: 1 }],
      [2, { label: 'C', pp: { x: 2, y: 0 }, charge: 0, fragment: 1 }]
    ]),
    bonds: new Map(),
    frags: new Map([[1, {}]]),
    texts: new Map(),
    rxnArrows: new Map(),
  };

  const { bridge, app, model } = createMockHarness(initialStruct);
  app.controller.ctx = () => ({
    atomPos: (id) => {
      const rid = app.adapter.atomIdOf(id);
      return rid ? initialStruct.atoms.get(rid)?.pp : null;
    },
    bondInfo: () => null,
    atomLabelBox: (id) => {
      if (id === 'atom-1') {
        // H 在东侧 (0度)
        return { hydrogenRects: [{ x1: 0.3, y1: -0.15, x2: 0.7, y2: 0.15 }] };
      }
      return null;
    },
    atoms: () => [{ uuid: 'atom-1', pos: { x: 0, y: 0 } }, { uuid: 'atom-2', pos: { x: 2, y: 0 } }],
    bonds: () => [],
    lonePair: (id) => model.lonePair(id),
    unit: () => 1
  });

  return (async () => {
    await bridge.beginRun('run-lp-test');
    const ops = [
      { id: 'lp_auto', type: 'lonePair.add', atom: 'atom-1' },
      { id: 'ar_auto', type: 'arrow.add', source: { type: 'lonePair', id: 'lp_auto' }, target: { type: 'atom', atomId: 'atom-2' }, electronCount: 2 }
    ];
    await bridge.applyOperations(ops, { runId: 'run-lp-test' });
    const createdLp = model.lonePair(model.state.lonePairs[0].id);
    assert.ok(createdLp);
    // 角度不应该等于 0度（因为 0度被 H 字形占据），应该偏转至少 24度避让
    const deltaFromH = Math.abs(((createdLp.angle % 360) + 360) % 360);
    assert.ok(deltaFromH >= 20 && deltaFromH <= 340, `孤对角度 (${createdLp.angle}°) 必须避开 0° 的 H 字形框`);
  })();
});

test('测试 E（等大小分子 stagePack 无 NaN 且活性端对齐）：两分子各4原子通过弯箭头连接，断言坐标全部有限且无 NaN', async () => {
  const fetchHandler = async (url, opts) => {
    const { smiles } = JSON.parse(opts.body);
    if (smiles === 'chain4_a' || smiles === 'chain4_b') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [
                { label: 'C', location: [0, 0, 0] },
                { label: 'C', location: [1.2, 0.5, 0] },
                { label: 'C', location: [2.4, 0, 0] },
                { label: 'O', location: [3.6, 0.5, 0] }
              ],
              bonds: [
                { atoms: [0, 1], type: 1 },
                { atoms: [1, 2], type: 1 },
                { atoms: [2, 3], type: 1 }
              ]
            }
          },
          atoms: [
            { ref: '1', index: 0, label: 'C' },
            { ref: '2', index: 1, label: 'C' },
            { ref: '3', index: 2, label: 'C' },
            { ref: '4', index: 3, label: 'O' }
          ],
          bonds: [
            { ref: '1', index: 0, begin: '1', end: '2' },
            { ref: '2', index: 1, begin: '2', end: '3' },
            { ref: '3', index: 2, begin: '3', end: '4' }
          ]
        })
      };
    }
    if (smiles === 'prod_dummy') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'C', location: [0, 0, 0] }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'C' }],
          bonds: []
        })
      };
    }
    return { ok: false };
  };

  const { bridge, st } = createMockHarness(null, fetchHandler);
  await bridge.beginRun('run-stagepack-nan');

  const ops = [
    { id: 'm1', type: 'molecule.add', smiles: 'chain4_a' },
    { id: 'm2', type: 'molecule.add', smiles: 'chain4_b' },
    { id: 'lp1', type: 'lonePair.add', atom: 'm1:4' },
    { id: 'ar1', type: 'arrow.add', source: { type: 'lonePair', id: 'lp1' }, target: { type: 'atom', atomId: 'm2:1' }, electronCount: 2 },
    { id: 'rxn', type: 'reactionArrow.add', reactants: ['m1:4', 'm2:1'], products: ['prod:1'] },
    { id: 'prod', type: 'molecule.add', smiles: 'prod_dummy' }
  ];

  await bridge.applyOperations(ops, { runId: 'run-stagepack-nan' });

  assert.equal(st.atoms.size, 9);
  for (const [id, atom] of st.atoms) {
    assert.ok(Number.isFinite(atom.pp.x), `atom ${id} x (${atom.pp.x}) 必须是有限数`);
    assert.ok(Number.isFinite(atom.pp.y), `atom ${id} y (${atom.pp.y}) 必须是有限数`);
    assert.ok(!Number.isNaN(atom.pp.x), `atom ${id} x 不能是 NaN`);
    assert.ok(!Number.isNaN(atom.pp.y), `atom ${id} y 不能是 NaN`);
  }

  // 验证活性位点对齐：m1 的 O (m1:4) 与 m2 的活性端 C (m2:1)
  // m1 的 4 个原子其 rid 为 100-103（O 是 103），m2 的 4 个原子其 rid 为 104-107（首个 C 是 104）
  const oAtom = st.atoms.get(103);
  const cAtom = st.atoms.get(104);
  assert.ok(oAtom && cAtom);
  assert.equal(oAtom.label, 'O');
  assert.equal(cAtom.label, 'C');

  // m1:4 在 m1 最右侧，m2:1 在 m2 最左侧；stagePack 应该让 m1 在左，m2 在右，且 y 坐标对齐
  assert.ok(oAtom.pp.x < cAtom.pp.x, `m1:4 (x=${oAtom.pp.x}) 应该位于 m2:1 (x=${cAtom.pp.x}) 左侧，活性端相邻`);
  assert.ok(Math.abs(oAtom.pp.y - cAtom.pp.y) < 0.6, `两分子的活性端 y 坐标应当相互对齐 (y1=${oAtom.pp.y}, y2=${cAtom.pp.y})`);
});

test('测试 F（无 arrow.add 但 op.reactants 指向偏心活性位点）：螺环底物+OH⁻通过 reactants 指向左侧 H 触发 fallbackLinks 停在左侧', async () => {
  const fetchHandler = async (url, opts) => {
    const { smiles } = JSON.parse(opts.body);
    if (smiles === 'spiro_substrate') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [
                { label: 'H', location: [-2.5, 0, 0] },
                { label: 'C', location: [-1.5, 0, 0] },
                { label: 'C', location: [-0.5, 1, 0] },
                { label: 'C', location: [-0.5, -1, 0] },
                { label: 'C', location: [0.5, 0, 0] },
                { label: 'C', location: [1.5, 1, 0] },
                { label: 'C', location: [1.5, -1, 0] },
                { label: 'C', location: [2.5, 0, 0] }
              ],
              bonds: [
                { atoms: [0, 1], type: 1 },
                { atoms: [1, 2], type: 1 }, { atoms: [1, 3], type: 1 },
                { atoms: [2, 4], type: 1 }, { atoms: [3, 4], type: 1 },
                { atoms: [4, 5], type: 1 }, { atoms: [4, 6], type: 1 },
                { atoms: [5, 7], type: 1 }, { atoms: [6, 7], type: 1 }
              ]
            }
          },
          atoms: [
            { ref: '1', index: 0, label: 'H' },
            { ref: '2', index: 1, label: 'C' },
            { ref: '3', index: 2, label: 'C' },
            { ref: '4', index: 3, label: 'C' },
            { ref: '5', index: 4, label: 'C' },
            { ref: '6', index: 5, label: 'C' },
            { ref: '7', index: 6, label: 'C' },
            { ref: '8', index: 7, label: 'C' }
          ],
          bonds: [
            { ref: '1', index: 0, begin: '1', end: '2' },
            { ref: '2', index: 1, begin: '2', end: '3' },
            { ref: '3', index: 2, begin: '2', end: '4' },
            { ref: '4', index: 3, begin: '3', end: '5' },
            { ref: '5', index: 4, begin: '4', end: '5' },
            { ref: '6', index: 5, begin: '5', end: '6' },
            { ref: '7', index: 6, begin: '5', end: '7' },
            { ref: '8', index: 7, begin: '6', end: '8' },
            { ref: '9', index: 8, begin: '7', end: '8' }
          ]
        })
      };
    }
    if (smiles === '[OH-:1]') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'O', location: [0, 0, 0], charge: -1 }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'O' }],
          bonds: []
        })
      };
    }
    if (smiles === 'prod_aldol') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          ket: {
            mol: {
              type: 'molecule',
              atoms: [{ label: 'C', location: [0, 0, 0] }],
              bonds: []
            }
          },
          atoms: [{ ref: '1', index: 0, label: 'C' }],
          bonds: []
        })
      };
    }
    return { ok: false };
  };

  const { bridge, st } = createMockHarness(null, fetchHandler);
  await bridge.beginRun('run-fallback-links', { readingOrder: true });

  // 注意：这里故意不传 arrow.add，只在 reactionArrow.add 中指认 sub:1 (偏心左侧 H) 和 oh:1
  const ops = [
    { id: 'sub', type: 'molecule.add', smiles: 'spiro_substrate' },
    { id: 'oh', type: 'molecule.add', smiles: '[OH-:1]' },
    { id: 'rxn', type: 'reactionArrow.add', reactants: ['sub:1', 'oh:1'], products: ['prod:1'] },
    { id: 'prod', type: 'molecule.add', smiles: 'prod_aldol' }
  ];

  await bridge.applyOperations(ops, { runId: 'run-fallback-links' });

  // 验证 OH⁻ (rid 108) 位于活性位点 H (rid 100) 的左侧 (x < hPos.x)
  const hAtom = st.atoms.get(100);
  const ohAtom = st.atoms.get(108);
  assert.ok(hAtom && ohAtom);
  assert.equal(hAtom.label, 'H');
  assert.equal(ohAtom.label, 'O');

  assert.ok(ohAtom.pp.x < hAtom.pp.x, `OH⁻ (x=${ohAtom.pp.x}) 应该位于偏心活性位点 H (x=${hAtom.pp.x}) 的左侧`);
});
