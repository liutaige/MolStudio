'use strict';
// Exercise the real controller capture handler followed by the pinned native DOM
// handler. This checks MIME coexistence and cancellation, not a second serializer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const file of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-controller']) {
  require('../workbench/' + file + '.js');
}
const MW = globalThis.MolWorkbench, M = MW.model;
const MIME = 'application/x-molstudio-mechanism';
const KET = 'chemical/x-indigo-ket';
const MOL = 'chemical/x-mdl-molfile';
const source = fs.readFileSync(require('../patch-ketcher-clipboard.cjs').bundlePath, 'utf8');

function balanced(start) {
  const open = source.indexOf('{', start);
  let depth = 0, quote, escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error('Missing native function end');
}
const clipStart = source.indexOf('this.listeners={mouseup:function');
assert.ok(clipStart >= 0);
const listenersSource = balanced(source.indexOf('{', clipStart));
const nativeWriterStart = source.indexOf('function gS(', clipStart);
const nativeWriterSource = balanced(nativeWriterStart);

function fixture() {
  let selected = { atoms: [0, 1], bonds: [0] };
  const nativeWrites = { [KET]: 'native selected KET', [MOL]: 'native selected MOL', 'text/plain': 'native plain MOL' };
  const calls = { copies: 0, cuts: 0, pastes: [], hostWrites: 0 };
  const ed = { selection: () => selected, historyStack: [], historyPtr: 0, render: { ctab: {} } };
  const adapter = { ed, selection: () => selected, context: () => ({}), clearSelection() { selected = { atoms: [], bonds: [] }; } };
  const model = new M.MechanismModel();
  const controller = new MW.controller.MechanismController({ adapter, model, layer: { render() {} },
    doc: { activeElement: null }, win: { navigator: {} } });
  controller.render = () => {};
  controller.writeClipboard = () => { calls.hostWrites++; throw Error('Mixed copy must not clear the native clipboard'); };
  const arrow = M.makeArrow({ type: 'free', x: 3, y: 2 }, { type: 'free', x: 5, y: 3 }, { bend: 0.3 });
  model.addArrow(arrow); controller.selection.add(arrow.id);
  const props = { focused: () => true, formats: [KET, MOL],
    onLegacyCopy() { calls.copies++; selected = { atoms: [], bonds: [] }; return nativeWrites; },
    onLegacyCut() { calls.cuts++; return nativeWrites; },
    onLegacyPaste(data) { calls.pastes.push(data); } };
  const globals = { U: { props }, window: { molstudioClipboard: { preferEvents: true } },
    LS: () => true, OS: () => false, wS: () => false, HS: undefined,
    Z: { isClipboardAPIAvailable: () => true } };
  vm.createContext(globals);
  vm.runInContext(nativeWriterSource, globals);
  const listeners = vm.runInContext('(' + listenersSource + ')', globals);
  return { controller, model, arrow, calls, listeners, ed };
}

function event(values = {}, failSidecar = false) {
  const data = { ...values };
  return { target: { tagName: 'TEXTAREA', getAttribute: () => 'true' }, defaultPrevented: false, stopped: false,
    clipboardData: { getData: type => data[type] || '',
      setData(type, value) { if (failSidecar && type === MIME) throw Error('custom MIME rejected'); data[type] = value; },
      get types() { return Object.keys(data); } },
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, data };
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }

test('mixed copy retains native chemical/plain formats and the arrow MIME in one event', () => {
  const f = fixture(), e = event();
  f.controller.onCopyEvent(e, false);
  assert.equal(e.stopped, false);
  assert.equal(e.defaultPrevented, false);
  f.listeners.copy(e);
  assert.equal(f.calls.copies, 1);
  assert.equal(f.calls.hostWrites, 0);
  assert.equal(e.data[KET], 'native selected KET');
  assert.equal(e.data[MOL], 'native selected MOL');
  assert.equal(e.data['text/plain'], 'native plain MOL');
  const sidecar = JSON.parse(e.data[MIME]);
  assert.equal(sidecar.native, true);
  assert.equal(sidecar.arrows.length, 1);
  assert.equal(sidecar.molecules, undefined);
  assert.equal(f.model.state.arrows.length, 1);
});

test('mixed cut leaves arrow deletion to the native action while retaining all MIME data', () => {
  const f = fixture(), e = event();
  f.controller.onCopyEvent(e, true);
  assert.equal(e.stopped, false);
  assert.ok(f.model.arrow(f.arrow.id));
  f.listeners.cut(e);
  assert.equal(f.calls.cuts, 1);
  assert.equal(f.calls.hostWrites, 0);
  assert.ok(f.model.arrow(f.arrow.id));
  assert.equal(e.data[KET], 'native selected KET');
  assert.ok(JSON.parse(e.data[MIME]).native);
  assert.ok(f.controller.nativeCutToken());
});

test('failed mixed-cut sidecar prevents the native eraser and preserves source objects', () => {
  const f = fixture(), e = event({}, true);
  f.controller.onCopyEvent(e, true);
  if (!e.stopped) f.listeners.cut(e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(f.calls.cuts, 0);
  assert.equal(f.calls.hostWrites, 0);
  assert.ok(f.model.arrow(f.arrow.id));
  assert.equal(f.controller.nativeCutToken(), null);
  assert.equal(f.ed.selection().atoms.length, 2);
});

test('mixed paste stages arrows while the real native handler receives its chemical data', () => {
  const f = fixture(), copied = event();
  f.controller.onCopyEvent(copied, false); f.listeners.copy(copied);
  const pasted = event(copied.data);
  f.controller.onPasteEvent(pasted);
  assert.equal(pasted.stopped, false);
  assert.equal(pasted.defaultPrevented, false);
  assert.ok(f.controller.nativePasteToken());
  assert.equal(f.controller.nativePasteSession.active, false);
  f.listeners.paste(pasted);
  assert.equal(f.calls.pastes.length, 1);
  assert.equal(f.calls.pastes[0][KET], 'native selected KET');
  assert.equal(f.calls.pastes[0]['text/plain'], 'native plain MOL');
  assert.equal(f.model.state.arrows.length, 1);
  assert.equal(f.calls.hostWrites, 0);
});

test('new external native paste cancels the previous sidecar without swallowing the structure', () => {
  const f = fixture(), copied = event();
  f.controller.onCopyEvent(copied, false); f.listeners.copy(copied);
  f.controller.onPasteEvent(event(copied.data));
  const oldToken = f.controller.nativePasteToken();
  const external = event({ [KET]: 'external KET', 'text/plain': 'external MOL' });
  f.controller.onPasteEvent(external); f.listeners.paste(external);
  assert.equal(f.controller.nativePasteToken(), null);
  assert.equal(f.controller.startNativePaste({ token: oldToken, origin: { x: 0, y: 0 }, target: { x: 8, y: 8 } }), false);
  assert.equal(f.calls.pastes[0][KET], 'external KET');
  assert.equal(f.model.state.arrows.length, 1);
});

console.log(passed + ' mixed clipboard transport checks passed.');
