'use strict';
// Execute the JavaScript emitted by the real Swift methods, rather than a copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fixtures = process.argv[2];
if (!fixtures) throw new Error('Expected generated regression fixture directory');

function reader(name) {
  return new AsyncFunction('window', fs.readFileSync(path.join(fixtures, name), 'utf8'));
}

function source({ mutateOn = null, failOn = null, legacy = false } = {}) {
  let revision = 'A';
  const api = {
    async getKet() { return revision; },
    async serializeWorkbench() { return revision; },
    async getMolfile() {
      await Promise.resolve();
      if (mutateOn === 'mol') revision = 'B';
      if (failOn === 'mol') throw new Error('MOL export failed');
      return 'MOL_' + revision;
    },
    async getSmiles() {
      await Promise.resolve();
      if (mutateOn === 'smiles') revision = 'B';
      if (failOn === 'smiles') throw new Error('SMILES export failed');
      return 'SMILES_' + revision;
    }
  };
  if (legacy) delete api.serializeWorkbench;
  return { k3dAPI: api };
}

const capture = reader('capture-exports.js');
const saveMol = reader('save-mol.js');
const saveSmiles = reader('save-smiles.js');

test('navigation capture returns matching source and both exports', async () => {
  assert.deepEqual(await capture(source()), { snap: 'A', mol: 'MOL_A', smi: 'SMILES_A' });
});

for (const mutateOn of ['mol', 'smiles']) {
  test(`navigation capture rejects edits during ${mutateOn} export`, async () => {
    assert.equal(await capture(source({ mutateOn })), null);
  });
}

test('navigation can preserve source when a chemical format cannot be exported', async () => {
  assert.deepEqual(await capture(source({ failOn: 'mol' })), { snap: 'A', mol: null, smi: 'SMILES_A' });
});

for (const [name, read, mutateOn, expected] of [
  ['MOL', saveMol, 'mol', 'MOL_A'],
  ['SMILES', saveSmiles, 'smiles', 'SMILES_A']
]) {
  test(`${name} save returns matching text and saved baseline`, async () => {
    assert.deepEqual(await read(source()), { snap: 'A', txt: expected });
  });
  test(`${name} save rejects edits while exporting`, async () => {
    assert.equal(await read(source({ mutateOn })), null);
  });
  test(`${name} export errors reject the read`, async () => {
    await assert.rejects(read(source({ failOn: mutateOn })), /export failed/);
  });
}

test('legacy source reader still checks before and after export', async () => {
  assert.deepEqual(await saveMol(source({ legacy: true })), { snap: 'A', txt: 'MOL_A' });
  assert.equal(await saveMol(source({ legacy: true, mutateOn: 'mol' })), null);
});
