'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { automaticViewportPlan } = require('../workbench/agent-bridge.js');
const view = { x1: 0, y1: 0, x2: 80, y2: 40 };
const long = { x1: 0, y1: 0, x2: 37, y2: 100 };
const last = { x1: 10, y1: 95, x2: 20, y2: 100 };

test('automatic long-page views retain a reading scale and the requested content focus', () => {
  const result = automaticViewportPlan({ zoom: 0.54, view, bounds: long, minimumZoom: 0.54, focusBounds: last });
  assert.equal(result.zoom, 0.54);
  assert.equal(result.reading, true);
  assert.equal(result.bounds, last);
});

test('a small current task in a long document still reveals its new endpoint at reading scale', () => {
  const result = automaticViewportPlan({ zoom: 0.23, view, bounds: last, readingBounds: long,
    minimumZoom: 0.54, focusBounds: last });
  assert.equal(result.zoom, 0.54);
  assert.equal(result.bounds, last);
});

test('small figures retain the existing zoom and embeddings without the option keep full-fit behavior', () => {
  const small = { x1: 1, y1: 1, x2: 8, y2: 5 };
  const unchanged = automaticViewportPlan({ zoom: 0.54, view, bounds: small, minimumZoom: 0.54 });
  assert.equal(unchanged.zoom, 0.54);
  assert.equal(unchanged.reading, false);
  const embedded = automaticViewportPlan({ zoom: 0.54, view, bounds: long, focusBounds: last });
  assert.equal(embedded.reading, false);
  assert.equal(embedded.bounds, long);
  assert.equal(embedded.zoom, Math.max(0.2, 0.54 * 40 / 101.6));
});

test('unavailable geometry cannot invent a viewport', () => {
  assert.equal(automaticViewportPlan({ zoom: 0.54, view: null, bounds: long, minimumZoom: 0.54 }), null);
  assert.equal(automaticViewportPlan({ zoom: 0, view, bounds: long, minimumZoom: 0.54 }), null);
});
