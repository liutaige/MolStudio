'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../workbench/canvas-viewport');

function fixture() {
  const handlers = {}, windowHandlers = {};
  const rect = { left: 40, top: 50, right: 940, bottom: 650 };
  const area = { getBoundingClientRect: () => rect, contains: t => t === area, clientHeight: 600 };
  const doc = { addEventListener: (n, fn) => { handlers[n] = fn; },
    elementFromPoint: (x, y) => x >= 40 && y >= 50 ? area : {},
    defaultView: { addEventListener: (n, fn) => { windowHandlers[n] = fn; } } };
  const iframe = { contentDocument: doc, getBoundingClientRect: () => ({ left: 17, top: 83 }) };
  let z = 1, notifications = 0;
  const render = { clientArea: area, viewBox: { minX: -127, minY: 213, width: 900, height: 600 },
    setViewBox(fn) { this.viewBox = fn(this.viewBox); } };
  const ed = { render, event: { zoomChanged: { dispatch() { notifications++; } } },
    zoom(next, anchor) {
      if (next === undefined) return z;
      const v = render.viewBox;
      const x = anchor ? anchor.clientX - rect.left : 450;
      const y = anchor ? anchor.clientY - rect.top : 300;
      render.viewBox = { minX: v.minX + x / z - x / next, minY: v.minY + y / z - y / next,
        width: 900 / next, height: 600 / next };
      z = next;
    } };
  const viewport = create(iframe, () => ed);
  viewport.install(doc);
  const point = (x, y) => ({ x: render.viewBox.minX + (x - rect.left) / z, y: render.viewBox.minY + (y - rect.top) / z });
  const emit = (type, extras) => {
    const e = { clientX: 203, clientY: 187, deltaY: -40, deltaX: 0, deltaMode: 0,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extras };
    handlers[type](e);
    return e;
  };
  return { viewport, ed, render, point, emit, windowHandlers, notifications: () => notifications };
}
function close(a, b) { assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, JSON.stringify({ a, b })); }

test('native pinch keeps off-centre model point fixed, including host iframe offset and existing pan', () => {
  for (const [x, y] of [[41, 51], [203, 187], [939, 649]]) {
    const f = fixture(), original = f.point(x, y);
    for (const factor of [1.25, 1.25, 0.8, 1.1, 0.5]) {
      assert.equal(f.viewport.zoomBy(factor, { x: x + 17, y: y + 83 }), true);
      close(f.point(x, y), original);
    }
    assert.equal(f.notifications(), 5);
  }
});
test('smooth wheel uses event position and one zoom per event', () => {
  const f = fixture(), original = f.point(203, 187);
  const event = f.emit('wheel', { ctrlKey: true });
  assert.ok(event.prevented && event.stopped);
  assert.ok(f.ed.zoom() > 1 && f.ed.zoom() < 1.1);
  close(f.point(203, 187), original);
  assert.equal(f.notifications(), 1);
});
test('menu zoom follows last canvas pointer; blur clears stale pointer', () => {
  const f = fixture();
  f.emit('pointermove');
  const original = f.point(203, 187);
  f.viewport.zoomBy(1.25);
  close(f.point(203, 187), original);
  f.windowHandlers.blur();
  const center = f.point(490, 350);
  f.viewport.zoomBy(0.8);
  close(f.point(490, 350), center);
});
test('toolbar points, invalid factors and zoom limits cannot corrupt the viewport', () => {
  const f = fixture();
  for (const factor of [NaN, Infinity, 0, -1]) assert.equal(f.viewport.zoomBy(factor), false);
  assert.equal(f.viewport.zoomBy(1.5, { x: 18, y: 84 }), false);
  assert.equal(f.ed.zoom(), 1);
  f.viewport.zoomBy(1e10); assert.equal(f.ed.zoom(), 4);
  assert.equal(f.viewport.zoomBy(2), false);
  f.viewport.zoomBy(1e-10); assert.equal(f.ed.zoom(), 0.2);
  assert.equal(f.viewport.zoomBy(0.5), false);
  assert.ok(Object.values(f.render.viewBox).every(Number.isFinite));
});
test('Shift-wheel pans horizontally without wheelDelta and ordinary scroll stays native', () => {
  const f = fixture(), before = { ...f.render.viewBox };
  const e = f.emit('wheel', { shiftKey: true, deltaY: 100 });
  assert.ok(e.prevented && e.stopped);
  assert.equal(f.render.viewBox.minX, before.minX + 40);
  assert.equal(f.render.viewBox.minY, before.minY);
  assert.ok(Object.values(f.render.viewBox).every(Number.isFinite));
  assert.equal(f.emit('wheel', { deltaY: 100 }).prevented, undefined);
});
test('wheel line/page units are normalised, toolbar scroll is not captured', () => {
  const f = fixture(), g = fixture();
  f.emit('wheel', { ctrlKey: true, deltaY: -1, deltaMode: 1 });
  g.emit('wheel', { ctrlKey: true, deltaY: -16 });
  assert.equal(f.ed.zoom(), g.ed.zoom());
  f.emit('wheel', { shiftKey: true, deltaY: 1, deltaMode: 2 });
  assert.ok(Number.isFinite(f.render.viewBox.minX));
  assert.equal(f.emit('wheel', { clientX: 10, clientY: 10, ctrlKey: true }).prevented, undefined);
});
test('zoom shortcuts preserve text entry, composition and other modifier combinations', () => {
  const f = fixture();
  for (const extra of [{ target: { closest: s => s === '.cliparea' ? null : {} } }, { isComposing: true }, { altKey: true }]) {
    assert.equal(f.emit('keydown', { key: '=', metaKey: true, ...extra }).prevented, undefined);
  }
  assert.equal(f.ed.zoom(), 1);
  assert.ok(f.emit('keydown', { key: '=', metaKey: true }).prevented);
  assert.equal(f.ed.zoom(), 1.25);
  assert.ok(f.emit('keydown', { key: '-', metaKey: true, target: { closest: s => s === '.cliparea' ? {} : null } }).prevented);
  assert.equal(f.ed.zoom(), 1);
});
