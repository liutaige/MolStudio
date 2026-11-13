/* A 组回归：编辑已有对象的操作契约（规范 5/6/7）。
   纯校验层：白名单字段、有界校验、批内依赖排序、幂等引用语义。 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOperations, dependencyOrder, LAYOUT } = require('../workbench/agent-bridge.js');

const okMove = { id: 'mv1', type: 'molecule.move', target: { molecule: 'mol:1' }, dx: 1.5, dy: 0 };
const okDel = { id: 'del1', type: 'molecule.delete', target: { atoms: ['at-abc'] } };
const okAtomModify = { id: 'am1', type: 'atom.modify', atomId: 'at-abc', charge: 1 };
const okAtomDelete = { id: 'ad1', type: 'atom.delete', atomId: 'at-abc' };
const okBondAdd = { id: 'ba1', type: 'bond.add', begin: 'at-a', end: 'at-b', order: 2 };
const okBondModify = { id: 'bm1', type: 'bond.modify', bondId: 'bd-1', order: 2 };
const okBondDelete = { id: 'bdel1', type: 'bond.delete', bondId: 'bd-1' };
const okArrowModify = { id: 'arm1', type: 'arrow.modify', arrowId: 'ar-1', mode: 'auto' };
const okArrowBend = { id: 'arb1', type: 'arrow.modify', arrowId: 'ar-1', bend: 0.4, mode: 'manual' };
const okArrowDelete = { id: 'ard1', type: 'arrow.delete', arrowId: 'ar-1' };
const okLpModify = { id: 'lpm1', type: 'lonePair.modify', lonePairId: 'lp-1', angle: 90 };
const okLpDelete = { id: 'lpd1', type: 'lonePair.delete', lonePairId: 'lp-1' };
const okTextDelete = { id: 'td1', type: 'text.delete', textId: 't-1' };
const okTidy = { id: 'tidy', type: 'layout.tidy' };

test('全部编辑操作类型通过白名单校验', () => {
  const valid = [okMove, okDel, okAtomModify, okAtomDelete, okBondAdd, okBondModify, okBondDelete,
    okArrowModify, okArrowBend, okArrowDelete, okLpModify, okLpDelete, okTextDelete, okTidy];
  assert.deepEqual(validateOperations(valid), valid);
  for (const r of [0, 1, 2, 3]) {
    assert.doesNotThrow(() => validateOperations([{ id: 'am-rad-' + r, type: 'atom.modify', atomId: 'at-abc', radical: r }]));
  }
});

test('编辑操作拒绝未知字段与非法引用（修改源之前）', () => {
  const invalid = [
    { ...okMove, javascript: 'alert(1)' },
    { ...okMove, target: { guess: 'first carbon' } },
    { ...okDel, target: { atoms: [] } },
    { ...okDel, target: { atoms: Array.from({ length: 201 }, (_, i) => 'a' + i) } },
    { ...okAtomModify, charge: 9 },
    { ...okAtomModify, label: 'Zzz' },
    { ...okAtomModify, atomId: 'not allowed spaces' },
    { ...okAtomModify, radical: -1 },
    { ...okAtomModify, radical: 4 },
    { ...okAtomModify, radical: 1.5 },
    { ...okAtomModify, radical: '2' },
    { id: 'am-none', type: 'atom.modify', atomId: 'at-abc' },
    { ...okBondAdd, end: 'at-a' },
    { ...okBondAdd, order: 4 },
    { id: 'bm2', type: 'bond.modify', bondId: 'bd-1' },
    { ...okArrowModify, mode: 'sideways' },
    { ...okArrowBend, bend: 5 },
    { id: 'arm9', type: 'arrow.modify', arrowId: 'ar-1' },
    { ...okLpModify, angle: Infinity },
    { ...okLpDelete, lonePairId: '' },
    { ...okTidy, scope: 'everything' },
    { id: 'x1', type: 'molecule.replace', smiles: 'C' },
  ];
  for (const bad of invalid) assert.throws(() => validateOperations([bad]), undefined, JSON.stringify(bad));
});

test('molecule.move 必须给出绝对或相对位移之一', () => {
  assert.throws(() => validateOperations([{ id: 'mv', type: 'molecule.move', target: { molecule: 'mol:1' } }]));
  assert.throws(() => validateOperations([{ id: 'mv', type: 'molecule.move', target: { molecule: 'mol:1' }, x: 1, dx: 2 }]));
  assert.doesNotThrow(() => validateOperations([{ id: 'mv', type: 'molecule.move', target: { molecule: 'mol:1' }, x: 1, y: 2 }]));
  assert.doesNotThrow(() => validateOperations([{ id: 'mv', type: 'molecule.move', target: { molecule: 'mol:1' }, dx: 1, dy: 2 }]));
});

test('批内依赖排序：引用者排在其依赖之后，环被拒绝', () => {
  const ordered = dependencyOrder([okArrowModify, { ...okAtomModify, atomId: 'new:1' }, { id: 'new', type: 'molecule.add', smiles: '[CH3:1][Br:2]' }]);
  const ids = ordered.map(op => op.id);
  assert.ok(ids.indexOf('new') < ids.indexOf('am1'), '引用 new:1 的修改必须排在 new 之后');
  assert.throws(() => dependencyOrder([
    { id: 'a', type: 'atom.delete', atomId: 'b:1' },
    { id: 'b', type: 'atom.modify', atomId: 'a:1', charge: 1 },
  ]), undefined, 'self/循环引用必须拒绝');
  assert.throws(() => validateOperations([{ id: 'b', type: 'molecule.add', smiles: 'C', __ref: 'a' }]),
    undefined, '未知字段必须在操作校验阶段拒绝');
  assert.throws(() => dependencyOrder([{ ...okAtomModify, atomId: 'am1:1' }]), undefined);
});

test('布局间隙配置在规范设计范围内且按键长归一化', () => {
  assert.ok(LAYOUT.reactionGap >= LAYOUT.minReactionGap && LAYOUT.reactionGap <= LAYOUT.maxReactionGap);
  assert.equal(LAYOUT.minReactionGap, 1.1);
  assert.equal(LAYOUT.maxReactionGap, 2.6);
  assert.ok(LAYOUT.stepGap > LAYOUT.arrowLength && LAYOUT.stepGap < 2.5);
  assert.ok(LAYOUT.labelPad > 0.3 && LAYOUT.labelPad < 0.8);
});
