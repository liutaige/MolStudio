'use strict';
const assert = require('node:assert/strict');
for (const file of ['mechanism-model', 'ketcher-adapter', 'mechanism-route', 'mechanism-layer', 'mechanism-controller']) require('../workbench/' + file + '.js');
const MW = globalThis.MolWorkbench, M = MW.model, MIME = 'application/x-molstudio-mechanism';
function event(x = 0, y = 0) {
  return { button: 0, clientX: x, clientY: y, target: { tagName: 'DIV' }, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
}
function arrow(electrons = 2) {
  return M.makeArrow({ type: 'free', x: 2, y: 3 }, { type: 'free', x: 6, y: 4 },
    { electronCount: electrons, bend: 0.6, controlFrame: { along: 0.3, normal: 0.8 } });
}
function payload(arrows) { return JSON.stringify({ kind: 'molstudio-mechanism', version: 2, native: true, arrows, lonePairs: [] }); }
class NativeAction {
  constructor(undo, redo) { this.undo = undo; this.redo = redo; this.operations = ['native operation']; Object.defineProperty(this, 'nativeMarker', { value: 17 }); }
  perform() { this.undo(); return new NativeAction(this.redo, this.undo); }
  isDummy() { return false; }
}
function fixture() {
  const model = new M.MechanismModel(), history = [], statuses = [];
  let nativeSelection = { atoms: [0, 1, 2], bonds: [0, 1] }, running = false, dirty = 0, toolChanges = 0;
  const nativeTool = { isSelectionRunning: () => running };
  const ed = { historyStack: history, historyPtr: 0, render: { ctab: {} },
    selection(value) { if (arguments.length) nativeSelection = value; return nativeSelection; },
    tool(value) { if (arguments.length) toolChanges++; return nativeTool; }
  };
  const adapter = { ed, context: () => ({}), clientToModel: point => ({ x: point.x, y: point.y }),
    selection: () => ({ atoms: nativeSelection?.atoms || [], bonds: nativeSelection?.bonds || [], others: 0 }),
    clearSelection() { nativeSelection = null; }, clearHover() {},
    pushAction(undo, redo) { history.push(new NativeAction(undo, redo)); ed.historyPtr = history.length; },
    k: { getKet() { throw Error('must use native serializer'); }, addFragment() { throw Error('must use native paste'); } }
  };
  const controller = new MW.controller.MechanismController({ model, adapter, doc: { activeElement: null }, win: {}, layer: { render() {} },
    onDirtyHint() { dirty++; }, onStatus(status) { statuses.push(status); } });
  controller.render = () => {}; controller.isCanvasTarget = () => true;
  controller.hitHandle = () => null; controller.hitTest = () => null;
  return { controller, model, adapter, ed, history, statuses, nativeTool, dirty: () => dirty,
    setRunning(value) { running = value; }, setNative(value) { nativeSelection = value; }, native: () => nativeSelection, toolChanges: () => toolChanges };
}
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-8, a + ' != ' + b); }
async function test(name, fn) { await fn(); console.log('PASS', name); }

(async () => {
  await test('canvas select-all keeps native molecular selection and includes every curly arrow, fishhook and lone pair', () => {
    const f = fixture(), curly = arrow(), fishhook = arrow(1), lp = M.makeLonePair('atom-owner', { angle: 90 });
    f.model.addArrow(curly); f.model.addArrow(fishhook); f.model.addLonePair(lp);
    f.setNative(null); f.controller.tool = 'arrow2';
    const calls = [], original = f.ed.selection;
    f.ed.selection = function (value) {
      if (arguments.length) { calls.push(value); f.setNative({ atoms: [0, 1, 2], bonds: [0, 1] }); return; }
      return original.call(this);
    };
    assert.equal(f.controller.selectAll(), true);
    assert.deepEqual(calls, ['all']); assert.deepEqual(f.native().atoms, [0, 1, 2]);
    assert.deepEqual(new Set(f.controller.selection), new Set([curly.id, fishhook.id, lp.id]));
    const copied = f.controller.buildCopyPayload({ allowNative: true });
    assert.equal(copied.native, true); assert.equal(copied.arrows.length, 2);
    assert.equal(f.controller.tool, 'select'); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  });
  await test('Cmd+A and Ctrl+A from the native clipboard receiver select all arrows without requiring an existing selection', () => {
    for (const modifier of ['metaKey', 'ctrlKey']) {
      const f = fixture(), ar = arrow(); f.model.addArrow(ar);
      const input = { ...event(), key: 'a', [modifier]: true,
        target: { tagName: 'TEXTAREA', getAttribute: name => name === 'data-cliparea' ? 'true' : null } };
      f.controller.onKeyDown(input);
      assert.ok(f.controller.selection.has(ar.id)); assert.equal(input.defaultPrevented, true); assert.equal(input.stopped, true);
    }
  });
  await test('select-all leaves real text inputs and contenteditable fields to their native text selection', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
      const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.doc.activeElement = target;
      assert.equal(f.controller.selectAll(), false); assert.equal(f.toolChanges(), 0);
      const input = { ...event(), key: 'a', metaKey: true, target }; f.controller.onKeyDown(input);
      assert.equal(input.defaultPrevented, false); assert.equal(f.controller.selection.size, 0);
      assert.deepEqual(f.native().atoms, [0, 1, 2]);
    }
  });
  await test('select-all retires a pending rectangle instead of letting its delayed subset overwrite the full selection', async () => {
    const f = fixture(), inside = arrow(), outside = arrow(1); outside.source.x += 50; outside.target.x += 50;
    f.model.addArrow(inside); f.model.addArrow(outside);
    f.controller.onPointerDown(event(0, 0)); f.setRunning(true); f.controller.onPointerUp(event(10, 10)); f.setRunning(false);
    f.controller.selectAll(); await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(new Set(f.controller.selection), new Set([inside.id, outside.id]));
  });
  await test('ordinary native rectangle drag selects arrows after native mouseup without changing native atoms', async () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar);
    const down = event(0, 0); f.controller.onPointerDown(down); assert.equal(down.defaultPrevented, false);
    f.setRunning(true); const move = event(10, 10); f.controller.onPointerMove(move); assert.equal(move.defaultPrevented, false);
    f.controller.onPointerUp(event(10, 10)); assert.equal(f.controller.selection.size, 0);
    f.setRunning(false); await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual([...f.controller.selection], [ar.id]); assert.deepEqual(f.native().atoms, [0, 1, 2]);
    assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  });
  await test('native molecule movement never becomes a mixed rectangle selection', async () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar);
    f.controller.onPointerDown(event(0, 0)); f.controller.onPointerMove(event(10, 10)); f.controller.onPointerUp(event(10, 10));
    await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(f.controller.selection.size, 0); assert.deepEqual(f.native().atoms, [0, 1, 2]);
  });
  await test('a one-move native rectangle uses pointerup bounds even when native selection starts after capture pointermove', async () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar);
    f.controller.onPointerDown(event(0, 0));
    // Pointer capture precedes the native compatibility mousemove that starts selection.
    f.controller.onPointerMove(event(10, 10)); assert.equal(f.controller.nativeMarquee.box, null);
    f.setRunning(true); f.controller.onPointerUp(event(10, 10)); f.setRunning(false);
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual([...f.controller.selection], [ar.id]); assert.deepEqual(f.native().atoms, [0, 1, 2]);
  });
  await test('copy immediately after native mouseup includes arrows before the deferred selection callback runs', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar);
    f.controller.onPointerDown(event(0, 0)); f.setRunning(true);
    f.controller.onPointerUp(event(10, 10)); f.setRunning(false);
    const values = new Map();
    f.controller.onCopyEvent({ ...event(), clipboardData: { setData(type, value) { values.set(type, value); } } }, false);
    assert.equal(JSON.parse(values.get(MIME)).arrows[0].id, ar.id);
    assert.deepEqual(f.native().atoms, [0, 1, 2]);
    f.controller.unmount();
  });
  await test('a newer pointer selection cannot be overwritten by an older deferred rectangle', async () => {
    const f = fixture(), old = arrow(), next = arrow(1); f.model.addArrow(old); f.model.addArrow(next);
    f.controller.onPointerDown(event(0, 0)); f.setRunning(true);
    f.controller.onPointerUp(event(10, 10)); f.setRunning(false);
    f.controller.hitTest = () => ({ kind: 'arrow', arrow: next });
    f.controller.onPointerDown(event(20, 20));
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual([...f.controller.selection], [next.id]);
  });
  await test('Shift-click arrow preserves the real native selection', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.hitTest = () => ({ kind: 'arrow', arrow: ar });
    f.controller.onSelectDown({ ...event(), shiftKey: true }, { x: 2, y: 3 });
    assert.ok(f.controller.selection.has(ar.id)); assert.deepEqual(f.native().atoms, [0, 1, 2]);
  });
  await test('mixed copy appends arrow MIME without blocking or calling molecular APIs', async () => {
    const f = fixture(), ar = arrow(1); f.model.addArrow(ar); f.controller.selection.add(ar.id);
    const values = new Map([['chemical/x-mdl-molfile', 'native molecule']]);
    const copy = { ...event(), clipboardData: { setData(type, value) { values.set(type, value); } } };
    assert.equal(f.controller.onCopyEvent(copy, false), true); assert.equal(copy.defaultPrevented, false); assert.equal(copy.stopped, false);
    const sidecar = JSON.parse(values.get(MIME)); assert.equal(sidecar.native, true); assert.equal(sidecar.arrows[0].electronCount, 1);
    assert.equal(sidecar.molecules, undefined); assert.equal(values.get('chemical/x-mdl-molfile'), 'native molecule');
    // WebKit can run a microtask checkpoint between capture and the native bubbling listener.
    await Promise.resolve(); assert.equal(f.controller.selection.size, 1);
    // Ketcher's successful legacy handler then clears its own selection and prevents default.
    f.setNative(null); copy.preventDefault();
    await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(f.controller.selection.size, 0);
  });
  await test('failed mixed clipboard write aborts copy/cut before native molecule deletion', () => {
    for (const cut of [false, true]) {
      const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.selection.add(ar.id);
      const copy = { ...event(), clipboardData: { setData() { throw Error('unavailable'); } } };
      f.controller.onCopyEvent(copy, cut); assert.equal(copy.defaultPrevented, true); assert.equal(copy.stopped, true);
      assert.ok(f.model.arrow(ar.id)); assert.deepEqual(f.native().atoms, [0, 1, 2]); assert.equal(f.controller.nativeCutToken(), null);
    }
  });
  await test('mixed paste stages a sidecar and leaves native event and pointer placement untouched', () => {
    const f = fixture(), ar = arrow(1), paste = { ...event(), clipboardData: { getData: type => type === MIME ? payload([ar]) : 'native molfile' } };
    f.controller.tool = 'arrow2'; f.controller.onPasteEvent(paste);
    assert.equal(paste.defaultPrevented, false); assert.equal(f.controller.tool, 'select'); assert.equal(f.toolChanges(), 0);
    const token = f.controller.nativePasteToken(); assert.ok(token); assert.equal(f.model.state.arrows.length, 0);
    f.controller.startNativePaste({ token, offset: { x: 10, y: 20 }, scale: 1, rotation: 0 });
    f.controller.hitHandle = () => { throw Error('native placement must own this pointer'); };
    for (const method of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onNativeMouse']) {
      const input = event(5, 5); f.controller[method](input); assert.equal(input.defaultPrevented, false);
    }
    const escape = { ...event(), key: 'Escape' }; f.controller.onKeyDown(escape); assert.equal(escape.defaultPrevented, false);
    assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  });
  await test('exact native normalization, rotation and translation transform endpoints and full fishhook curve', () => {
    const f = fixture(), ar = arrow(1), token = f.controller.stageNativePaste(payload([ar]));
    const meta = { token, scale: 0.5, rotation: Math.PI / 2, origin: { x: 1, y: 1.5 }, target: { x: 20, y: 30 } };
    assert.equal(f.controller.startNativePaste(meta), true);
    const before = M.arrowGeometry(ar, {}), after = M.arrowGeometry(f.controller.nativePasteSession.arrows[0], {});
    for (const name of ['start', 'control', 'end']) {
      near(after[name].x, 20 - (before[name].y * 0.5 - 1.5)); near(after[name].y, 30 + (before[name].x * 0.5 - 1));
    }
    assert.equal(f.controller.nativePasteSession.arrows[0].electronCount, 1); assert.equal(f.model.state.arrows.length, 0);
  });
  await test('stale parser tokens are ignored; temporary leave resumes and permanent cancellation clears all preview', () => {
    const f = fixture(), first = f.controller.stageNativePaste(payload([arrow()]));
    const second = f.controller.stageNativePaste(payload([arrow(1)]));
    const meta = token => ({ token, offset: { x: 2, y: 3 } });
    assert.equal(f.controller.startNativePaste(meta(first)), false); assert.equal(f.controller.startNativePaste(meta(second)), true);
    f.controller.cancelNativePaste(first, false); assert.equal(f.controller.nativePasteToken(), second);
    f.controller.cancelNativePaste(second, true); assert.equal(f.controller.nativePasteSession.active, false);
    assert.equal(f.controller.moveNativePaste(meta(second)), true);
    f.controller.cancelNativePaste(second, false); assert.equal(f.controller.nativePasteSession, null);
    assert.equal(f.model.state.arrows.length, 0); assert.equal(f.history.length, 0); assert.equal(f.dirty(), 0);
  });
  await test('an untagged older native PasteTool cannot cancel a newer mixed paste; internal reset still can', () => {
    const f = fixture(), token = f.controller.stageNativePaste(payload([arrow()]));
    for (const oldToken of [undefined, null, '']) {
      assert.equal(f.controller.cancelNativePaste(oldToken, false), false);
      assert.equal(f.controller.cancelNativePaste(oldToken, true), false);
      assert.equal(f.controller.nativePasteToken(), token);
    }
    assert.equal(f.controller.startNativePaste({ token, offset: { x: 10, y: 20 } }), true);
    const action = new NativeAction(() => {}, () => {}); f.history.push(action); f.ed.historyPtr = 1;
    f.controller.commitNativePaste(action, token); assert.equal(f.model.state.arrows.length, 1);
    const redo = action.perform(); assert.equal(f.model.state.arrows.length, 0);
    redo.perform(); assert.equal(f.model.state.arrows.length, 1);
    f.controller.stageNativePaste(payload([arrow()]));
    assert.equal(f.controller.cancelNativePaste(), true); assert.equal(f.controller.nativePasteToken(), null);
  });
  await test('mixed native commit augments the exact native history object and one undo/redo restores both', () => {
    const f = fixture(), original = arrow(1); f.model.addArrow(original);
    const token = f.controller.stageNativePaste(payload([original])); f.controller.startNativePaste({ token, offset: { x: 10, y: 20 } });
    let moleculeCount = 2; const action = new NativeAction(() => { moleculeCount--; }, () => { moleculeCount++; });
    f.history.push(action); f.ed.historyPtr = 1;
    assert.equal(f.controller.commitNativePaste(action, token), action); assert.equal(f.history.length, 1); assert.equal(f.history[0], action);
    assert.ok(action instanceof NativeAction); assert.equal(action.nativeMarker, 17); assert.equal(action.isDummy(), false);
    assert.equal(f.model.state.arrows.length, 2); assert.equal(f.dirty(), 1);
    const redo = action.perform(); assert.equal(moleculeCount, 1); assert.equal(f.model.state.arrows.length, 1);
    redo.perform(); assert.equal(moleculeCount, 2); assert.equal(f.model.state.arrows.length, 2); assert.equal(f.history.length, 1);
  });
  await test('native no-op paste creates only the required arrow history entry', () => {
    const f = fixture(), token = f.controller.stageNativePaste(payload([arrow()])); f.controller.startNativePaste({ token, offset: { x: 10, y: 20 } });
    const notPushed = new NativeAction(() => { throw Error('native no-op must not be replayed'); }, () => {});
    f.controller.commitNativePaste(notPushed, token); assert.equal(f.history.length, 1); assert.notEqual(f.history[0], notPushed);
    assert.equal(f.model.state.arrows.length, 1); f.history[0].perform(); assert.equal(f.model.state.arrows.length, 0);
  });
  await test('an unrelated native history advance is never used as a no-op arrow fallback', () => {
    const f = fixture(), token = f.controller.stageNativePaste(payload([arrow()])); f.controller.startNativePaste({ token, offset: { x: 10, y: 20 } });
    const unrelated = new NativeAction(() => {}, () => {}); f.history.push(unrelated); f.ed.historyPtr = 1;
    f.controller.commitNativePaste(new NativeAction(() => {}, () => {}), token);
    assert.equal(f.history.length, 1); assert.equal(f.history[0], unrelated); assert.equal(f.model.state.arrows.length, 0);
    assert.equal(f.dirty(), 0); assert.match(f.statuses.at(-1), /原生历史已变化/);
  });
  await test('mixed Cut affects arrows only inside its own native eraser token and shares native undo', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.selection.add(ar.id);
    const cut = { ...event(), clipboardData: { setData() {} } }; f.controller.onCopyEvent(cut, true);
    const token = f.controller.nativeCutToken(), action = new NativeAction(() => {}, () => {});
    f.controller.nativeClipboardHistory(action, 'unrelated'); assert.ok(f.model.arrow(ar.id));
    f.controller.nativeClipboardHistory(action, token); assert.equal(f.model.arrow(ar.id), null); assert.equal(f.controller.nativeCutToken(), null);
    const redo = action.perform(); assert.ok(f.model.arrow(ar.id)); redo.perform(); assert.equal(f.model.arrow(ar.id), null);
    assert.equal(f.history.length, 0); // Native editor owns insertion of the single wrapped action.
  });
  await test('captured Cut survives later copy, native paste and staged mixed paste until its own eraser runs', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.selection.add(ar.id);
    const clipboard = () => ({ ...event(), clipboardData: { setData() {} } });
    f.controller.onCopyEvent(clipboard(), true); const token = f.controller.nativeCutToken();
    f.controller.onCopyEvent(clipboard(), false); assert.equal(f.controller.nativeCutToken(), null);
    f.controller.onPasteEvent({ ...event(), clipboardData: { getData: type => type === MIME ? '' : 'native molfile' } });
    f.controller.stageNativePaste(payload([ar]));
    assert.equal(f.controller.pendingNativeCuts.has(token), true);
    f.controller.nativeClipboardHistory(new NativeAction(() => {}, () => {}), token);
    assert.equal(f.model.arrow(ar.id), null); assert.equal(f.controller.pendingNativeCuts.get(token).consumed, true);
    f.controller.nativeCutEnd(token); assert.equal(f.controller.pendingNativeCuts.size, 0);
  });
  await test('older eraser tokens cannot consume a newer Cut and completion retires only older coalesced snapshots', () => {
    const f = fixture(), first = arrow(), second = arrow(1); f.model.addArrow(first); f.model.addArrow(second);
    const clipboard = () => ({ ...event(), clipboardData: { setData() {} } });
    f.controller.selection = new Set([first.id]); f.controller.onCopyEvent(clipboard(), true); const a = f.controller.nativeCutToken();
    f.controller.selection = new Set([second.id]); f.controller.onCopyEvent(clipboard(), true); const b = f.controller.nativeCutToken();
    f.controller.nativeClipboardHistory(new NativeAction(() => {}, () => {}), a);
    assert.equal(f.model.arrow(first.id), null); assert.ok(f.model.arrow(second.id)); assert.equal(f.controller.nativeCutToken(), b);
    f.controller.nativeCutEnd(a); assert.equal(f.controller.pendingNativeCuts.has(b), true);
    f.controller.nativeClipboardHistory(new NativeAction(() => {}, () => {}), b); assert.equal(f.model.arrow(second.id), null);
    f.controller.nativeCutEnd(b); assert.equal(f.controller.pendingNativeCuts.size, 0);
  });
  await test('matching cancel and completed latest debounce clean up only safe Cut snapshots; unmount clears all', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.selection.add(ar.id);
    const cut = () => f.controller.onCopyEvent({ ...event(), clipboardData: { setData() {} } }, true);
    cut(); const a = f.controller.nativeCutToken(); cut(); const b = f.controller.nativeCutToken();
    f.controller.cancelNativeCut(a); assert.equal(f.controller.pendingNativeCuts.has(a), false); assert.equal(f.controller.pendingNativeCuts.has(b), true);
    cut(); const c = f.controller.nativeCutToken(); f.controller.nativeCutEnd(c);
    assert.equal(f.controller.pendingNativeCuts.size, 0); assert.ok(f.model.arrow(ar.id));
    cut(); f.controller.nativeCutEnd(null); assert.equal(f.controller.pendingNativeCuts.size, 0);
    cut(); f.controller.unmount(); assert.equal(f.controller.pendingNativeCuts.size, 0); assert.equal(f.controller.nativeCutToken(), null);
  });
  await test('no-op Cut cleanup and malformed sidecar never contaminate later native actions or paste', () => {
    const f = fixture(), ar = arrow(); f.model.addArrow(ar); f.controller.selection.add(ar.id);
    f.controller.onCopyEvent({ ...event(), clipboardData: { setData() {} } }, true);
    const token = f.controller.nativeCutToken(); f.controller.nativeCutEnd(token);
    f.controller.nativeClipboardHistory(new NativeAction(() => {}, () => {}), token); assert.ok(f.model.arrow(ar.id));
    const paste = { ...event(), clipboardData: { getData: type => type === MIME ? '{bad sidecar' : 'native molfile' } };
    f.controller.onPasteEvent(paste); assert.equal(paste.defaultPrevented, false); assert.equal(f.controller.nativePasteSession, null);
    assert.equal(f.controller.beginPasteText(payload([ar])), false); assert.equal(f.controller.pastePreview, null);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
