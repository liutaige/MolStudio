'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'canvas.html'), 'utf8');
const match = html.match(/kd\.contentDocument\.addEventListener\('keydown', e => \{([\s\S]*?)\n  \}, true\);/);
if (!match) throw new Error('native shortcut handler missing');
const handle = new Function('e', 'notifyNative', 'cleanLayoutFromUI', match[1]);
function run(key, modifiers = {}) {
  const result = { action: null, prevented: false };
  const e = { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    preventDefault() { result.prevented = true; }, stopPropagation() {}, ...modifiers };
  handle(e, message => { result.action = message.act; }, () => {});
  return result;
}
test('native save and save as honour keyboard modifiers', () => {
  assert.deepEqual(run('s'), { action: 'save', prevented: true });
  assert.deepEqual(run('S', { shiftKey: true }), { action: 'saveAs', prevented: true });
  assert.deepEqual(run('s', { altKey: true }), { action: null, prevented: false });
  assert.deepEqual(run('o', { shiftKey: true }), { action: null, prevented: false });
});
