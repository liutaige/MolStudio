import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkElectronFlowCoverage as coverage } from '../mechanism-coverage.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/coverage-hydrogen-display.json', import.meta.url)));

test('real proton transfer remains consistent when a different product OH hydrogen becomes explicit', () => {
  assert.equal(coverage(fixture.before), null);
  assert.equal(coverage(fixture.after), null);
  // Equal explicit-H counts do not imply the displayed protons have one identity.
  assert.equal(fixture.after.reactantAtoms.filter(id => fixture.after.atoms.find(a => a.id === id).label === 'H').length, 1);
  assert.equal(fixture.after.productAtoms.filter(id => fixture.after.atoms.find(a => a.id === id).label === 'H').length, 1);
});

for (const side of ['before', 'after']) {
  for (let missing = 0; missing < 2; missing++) {
    test(`real ${side} display still rejects missing proton-transfer arrow ${missing + 1}`, () => {
      const input = structuredClone(fixture[side]);
      input.arrows.splice(missing, 1);
      assert.match(coverage(input), /氢|电荷/);
    });
  }
}

test('wrong sigma release and a real extra hydrogen remain defects', () => {
  const wrongRelease = structuredClone(fixture.after);
  wrongRelease.arrows[1].target.atomId = wrongRelease.arrows[0].target.atomId;
  assert.match(coverage(wrongRelease), /氢|电荷/);
  const extraH = structuredClone(fixture.after);
  extraH.atoms.find(a => a.id === extraH.productAtoms[0]).implicitH++;
  assert.match(coverage(extraH), /总氢数不守恒/);
});

function enolate() {
  const atom = (id, label, implicitH, charge = 0) => ({ id, label, implicitH, charge, isotope: 0, radical: 0 });
  const bond = (id, begin, end, order = 1) => ({ id, begin, end, order });
  return {
    reactantAtoms: ['alpha', 'h', 'co', 'o', 'base'],
    productAtoms: ['alpha2', 'co2', 'o2', 'base2'],
    atoms: [atom('alpha', 'C', 2), atom('h', 'H', 0), atom('co', 'C', 1), atom('o', 'O', 0), atom('base', 'N', 2, -1),
      atom('alpha2', 'C', 2), atom('co2', 'C', 1), atom('o2', 'O', 0, -1), atom('base2', 'N', 3)],
    bonds: [bond('ch', 'alpha', 'h'), bond('cc', 'alpha', 'co'), bond('pi', 'co', 'o', 2),
      bond('cc2', 'alpha2', 'co2', 2), bond('co2', 'co2', 'o2')],
    lonePairs: [{ id: 'lp', ownerAtomId: 'base' }],
    arrows: [
      { id: 'abstract', electronCount: 2, source: { type: 'lonePair', slotId: 'lp', ownerAtomId: 'base' }, target: { type: 'atom', atomId: 'h' } },
      { id: 'donate', electronCount: 2, source: { type: 'bond', bondId: 'ch' }, target: { type: 'formingBond', atomA: 'alpha', atomB: 'co' } },
      { id: 'release', electronCount: 2, source: { type: 'bond', bondId: 'pi' }, target: { type: 'atom', atomId: 'o' } },
    ],
  };
}

test('normalizing displayed hydrogen still requires the real carbonyl pi migration', () => {
  const input = enolate();
  assert.equal(coverage(input), null);
  input.arrows.pop();
  assert.match(coverage(input), /缺少降低键级.*co.*o/);
});

for (const [name, change] of [
  ['isotopic', input => { input.atoms.find(a => a.id === 'h').isotope = 2; }],
  ['charged', input => { input.atoms.find(a => a.id === 'h').charge = 1; }],
  ['radical', input => { input.atoms.find(a => a.id === 'h').radical = 2; }],
  ['bridging', input => { input.bonds.push({ id: 'bridge', begin: 'h', end: 'base', order: 1 }); }],
  ['stereochemical', input => { input.bonds.find(b => b.id === 'ch').stereo = 1; }],
]) {
  test(`${name} hydrogen is not silently folded into an ordinary inventory`, () => {
    const input = enolate();
    change(input);
    input.arrows.pop();
    // Different full atom counts make the legacy mapping inconclusive. This is
    // deliberately unknown, rather than pretending to map the special H away.
    assert.equal(coverage(input), null);
  });
}
