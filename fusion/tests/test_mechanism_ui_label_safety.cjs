'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../workbench/mechanism-ui.js');

class FakeElement {
  constructor(id, tagName) {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const listener of this.listeners.get('click') || []) listener();
  }
}

class FakeSelectionBar {
  constructor() {
    this.style = { display: 'none' };
    this._innerHTML = '';
    this.elements = new Map();
  }

  set innerHTML(html) {
    this._innerHTML = String(html);
    this.elements.clear();
    const tags = /<([a-z][\w-]*)\b([^>]*)>/gi;
    for (const match of this._innerHTML.matchAll(tags)) {
      const id = match[2].match(/\bid="([^"]+)"/);
      if (id) this.elements.set(id[1], new FakeElement(id[1], match[1]));
    }
  }

  get innerHTML() { return this._innerHTML; }

  querySelector(selector) {
    return selector.startsWith('#') ? this.elements.get(selector.slice(1)) || null : null;
  }
}

test('lone-pair owner labels render as text and selection controls keep working', () => {
  const label = `O <&>"'`;
  let deleted = 0;
  const box = new FakeSelectionBar();
  const ui = new globalThis.MolWorkbench.ui.MechanismUI({
    doc: {},
    model: {
      arrow: () => null,
      lonePair: id => id === 'lp-1' ? { ownerAtomId: 'atom-1' } : null
    },
    controller: {
      describeAtom: id => id === 'atom-1' ? label : '',
      deleteSelection: () => { deleted++; },
      toggleBondComponent() {},
      replanSelection() {}
    }
  });
  ui.selBar = box;

  ui.refreshSelection(1, ['lp-1']);

  assert.equal(box.style.display, 'flex');
  assert.match(box.innerHTML, /已选 1 个对象（1 孤对，所属：<span id="msb-owner-label"><\/span>）/);
  assert.equal(box.innerHTML.includes(label), false, 'untrusted label is absent from the HTML source');
  assert.equal(box.querySelector('#msb-owner-label').textContent, label, 'label remains visible as literal text');
  assert.match(box.innerHTML, /<button[^>]*id="msb-del"[^>]*>删除<\/button>/);

  box.querySelector('#msb-del').click();
  assert.equal(deleted, 1, 'delete button still invokes the controller');

  ui.refreshSelection(0, []);
  assert.equal(box.style.display, 'none');
  assert.equal(box.innerHTML, '');
});
