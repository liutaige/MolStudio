'use strict';
/* Shared host viewport region (contract §7): HostViewport in top-level WebView
 * CSS client px, conservative edge insets, no DPR/double counting, overlay hit
 * rejection, and nativeInsetsFrame parity for agent-bridge. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../workbench/canvas-viewport');

function fixture() {
  const handlers = {};
  const rect = { left: 0, top: 0, right: 900, bottom: 640, width: 900, height: 640 };
  const area = { getBoundingClientRect: () => rect, contains: t => t === area, clientHeight: 640 };
  const doc = {
    addEventListener: (n, fn) => { handlers[n] = fn; },
    elementFromPoint: () => area,
    defaultView: { addEventListener() {}, innerWidth: 900, innerHeight: 640 }
  };
  const iframe = { contentDocument: doc, getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 640, width: 900, height: 640 }) };
  let z = 1;
  const render = { clientArea: area, viewBox: { minX: 0, minY: 0, width: 900, height: 640 }, setViewBox(fn) { this.viewBox = fn(this.viewBox); } };
  const ed = {
    render,
    event: { zoomChanged: { dispatch() {} } },
    zoom(next, anchor) {
      if (next === undefined) return z;
      const v = render.viewBox;
      const x = anchor ? anchor.clientX - rect.left : 450;
      const y = anchor ? anchor.clientY - rect.top : 320;
      render.viewBox = { minX: v.minX + x / z - x / next, minY: v.minY + y / z - y / next, width: 900 / next, height: 640 / next };
      z = next;
    }
  };
  const viewport = create(iframe, () => ed);
  viewport.install(doc);
  return { viewport, ed, render, doc };
}

const hostViewport = (overlays) => ({
  layoutRevision: 1,
  cssSize: { width: 900, height: 640 },
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  overlays: overlays || []
});

test('setHostViewport only accepts strictly newer layoutRevision', () => {
  const { viewport } = fixture();
  assert.equal(viewport.setHostViewport(hostViewport()), true);
  assert.equal(viewport.hostViewportState().layoutRevision, 1);
  assert.equal(viewport.setHostViewport({ ...hostViewport(), layoutRevision: 1 }), false, 'replay rejected');
  assert.equal(viewport.setHostViewport({ ...hostViewport(), layoutRevision: 0 }), false);
  assert.equal(viewport.setHostViewport({ ...hostViewport(), layoutRevision: 2 }), true);
});

test('overlays anchored to edges expand into conservative insets; middle overlays do not', () => {
  const { viewport } = fixture();
  viewport.setHostViewport(hostViewport([
    { id: 'toolPalette', x: 0, y: 40, width: 56, height: 380 },
    { id: 'zoomPalette', x: 12, y: 584, width: 180, height: 44 }
  ]));
  const insets = viewport.effectiveInsets();
  assert.equal(insets.left, 56);
  assert.equal(insets.bottom, 640 - 584);
  assert.equal(insets.top, 0);
  assert.equal(insets.right, 0);
  // A floating overlay in the middle of the canvas expands nothing (edge rule).
  viewport.setHostViewport({ ...hostViewport(), layoutRevision: 2, overlays: [{ id: 'toolPalette', x: 300, y: 300, width: 56, height: 120 }] });
  const middle = viewport.effectiveInsets();
  assert.deepEqual(middle, { left: 0, top: 0, right: 0, bottom: 0 });
});

test('effectiveRect merges safeArea with overlay insets without double counting', () => {
  const { viewport } = fixture();
  viewport.setHostViewport({
    layoutRevision: 3,
    cssSize: { width: 900, height: 640 },
    safeAreaInsets: { top: 28, right: 0, bottom: 24, left: 0 },
    overlays: [{ id: 'toolPalette', x: 0, y: 40, width: 56, height: 380 }]
  });
  const rect = viewport.effectiveRect();
  assert.deepEqual(rect, { left: 56, top: 28, right: 900, bottom: 616 });
  // Sidebar resized by NSSplitViewController must NOT be reported as an overlay:
  // the host already shrinks cssSize, adding an inset would double count.
  viewport.setHostViewport({
    layoutRevision: 4,
    cssSize: { width: 700, height: 640 }, // WebView narrowed by the split view
    safeAreaInsets: { top: 28, right: 0, bottom: 24, left: 0 },
    overlays: []
  });
  assert.deepEqual(viewport.effectiveInsets(), { left: 0, top: 28, right: 0, bottom: 24 });
  assert.equal(viewport.effectiveRect().right, 700);
});

test('zoomBy rejects anchors over native overlays even when DOM hit test passes', () => {
  const { viewport, ed } = fixture();
  viewport.setHostViewport(hostViewport([{ id: 'zoomPalette', x: 0, y: 560, width: 180, height: 44 }]));
  const before = { ...ed.render.viewBox };
  assert.equal(viewport.zoomBy(1.25, { x: 90, y: 580 }), false, 'overlay point never zooms');
  assert.deepEqual(ed.render.viewBox, before);
  assert.equal(viewport.zoomBy(1.25, { x: 500, y: 300 }), true, 'unobstructed point keeps point zoom');
  assert.notDeepEqual(ed.render.viewBox, before);
});

test('onCanvas ignores points inside the native overlay region', () => {
  const { viewport } = fixture();
  viewport.setHostViewport(hostViewport([{ id: 'toolPalette', x: 0, y: 0, width: 56, height: 640 }]));
  const inside = viewport.inNativeOverlay({ x: 20, y: 320 });
  assert.equal(inside, true);
  assert.equal(viewport.inNativeOverlay({ x: 450, y: 320 }), false);
});

test('right chemical palette excludes its edge from canvas and zoom anchors', () => {
  const { viewport } = fixture();
  viewport.setHostViewport(hostViewport([{ id: 'chemicalPalette', x: 810, y: 120, width: 76, height: 360 }]));
  assert.equal(viewport.effectiveInsets().right, 90);
  assert.equal(viewport.inNativeOverlay({ x: 850, y: 250 }), true);
  assert.equal(viewport.zoomBy(1.2, { x: 850, y: 250 }), false);
  assert.equal(viewport.zoomBy(1.2, { x: 450, y: 250 }), true);
});

test('nativeInsetsFrame shares the same region for agent-bridge visibleModelBounds', () => {
  const { viewport } = fixture();
  viewport.setHostViewport(hostViewport([{ id: 'zoomPalette', x: 12, y: 584, width: 180, height: 44 }]));
  assert.deepEqual(viewport.nativeInsetsFrame(), { left: 0, top: 0, right: 0, bottom: 56 });
  viewport.setHostViewport({
    layoutRevision: 2,
    cssSize: { width: 900, height: 640 },
    safeAreaInsets: { top: 28, right: 0, bottom: 0, left: 0 },
    overlays: [{ id: 'toolPalette', x: 0, y: 40, width: 56, height: 380 }]
  });
  assert.deepEqual(viewport.nativeInsetsFrame(), { left: 56, top: 28, right: 0, bottom: 0 });
});

test('no host viewport means zero insets: browser behaviour unchanged', () => {
  const { viewport } = fixture();
  assert.deepEqual(viewport.effectiveInsets(), { left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(viewport.inNativeOverlay({ x: 5, y: 5 }), false);
  assert.deepEqual(viewport.nativeInsetsFrame(), { left: 0, top: 0, right: 0, bottom: 0 });
});
