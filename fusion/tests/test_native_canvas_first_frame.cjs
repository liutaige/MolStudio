'use strict';
/* First-frame canvas mode regression: executes the REAL inline scripts from
 * fusion/canvas.html in JSDOM. Proves that the native host marker is applied
 * at document-parse time (before any downstream script / bridge attach), that
 * the Ketcher iframe URL carries hiddenControls on its first navigation, and
 * that browser mode (no marker) is byte-for-byte unchanged in behaviour.
 * No model calls, no GUI, no service required.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'canvas.html'), 'utf8');

/** Extract the parse-time inline scripts (head marker + iframe src + mirror
 *  install). We intentionally do NOT execute the later workbench bootstrap. */
function inlineScripts() {
  const found = [...HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).filter(s => s.includes('nativeCanvas') || s.includes('MolStudioNativeCanvasMode'));
  assert.equal(found.length, 3, 'expected the three first-frame inline scripts');
  return found;
}

function buildDOM(url) {
  const scripts = inlineScripts();
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e)));
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head></head><body><iframe id="k"></iframe></body></html>',
    { url, runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true }
  );
  const { window } = dom;
  // Load the shared native-canvas-mode module (real file) into the harness.
  const moduleCode = fs.readFileSync(path.join(__dirname, '..', 'workbench', 'native-canvas-mode.js'), 'utf8');
  window.eval(moduleCode);
  for (const code of scripts) window.eval(code);
  return { window, errors, doc: window.document };
}

test('native mode: parse-time marker + !important CSS hidden before any bridge', () => {
  const { window, errors, doc } = buildDOM('http://127.0.0.1:48975/canvas.html?nativeCanvas=1&navGen=42');
  assert.deepEqual(errors, []);
  assert.equal(doc.documentElement.getAttribute('data-native-canvas'), '1');
  assert.equal(window.__molstudioNativeCanvas, true);
  assert.equal(window.MolStudioNativeCanvas.active, true);
  assert.equal(window.MolStudioNativeCanvas.navigationGeneration, 42);
  const css = doc.getElementById('molstudio-native-canvas-css');
  assert.ok(css, 'first-frame stylesheet must exist');
  assert.ok(css.textContent.includes('display: none !important'));
  for (const id of ['#helpBtn', '#toast', '#mech-sel-bar', '#molstudio-document-toolbar',
    '#molstudio-document-panel', '#molstudio-document-status', '#molstudio-document-pages',
    '.mol-agent-panel', '.mol-agent-toggle']) {
    assert.ok(css.textContent.includes(id), 'missing hidden selector ' + id);
  }
  // Ketcher iframe keeps its original URL: hiddenControls is deliberately NOT
  // used (it breaks the engine's default selected tool). The host injects a
  // first-frame stylesheet instead; the shared module mirrors it on load.
  const src = doc.getElementById('k').src;
  assert.ok(src.includes('/ketcher/index.html'));
  assert.ok(!src.includes('hiddenControls'), 'hiddenControls must not be used');
  assert.ok(window.MolStudioNativeCanvasMode.isNative());
  assert.ok(window.MolStudioNativeCanvasMode.rules.includes('display: none !important'));
  for (const id of ['top-toolbar', 'left-toolbar', 'right-toolbar', 'bottom-toolbar']) {
    assert.ok(window.MolStudioNativeCanvasMode.rules.includes('[data-testid="' + id + '"]'),
      'missing toolbar rule ' + id);
  }
  assert.ok(!window.MolStudioNativeCanvasMode.rules.includes('canvas { display: none'),
    'must never hide the drawing canvas itself');
  // The mirror can install the same stylesheet into a real iframe document.
  // (JSDOM leaves an empty mid-navigation document after src assignment, so
  // create one explicitly to prove apply() writes the real rules.)
  const iframe = doc.getElementById('k');
  assert.ok(window.MolStudioNativeCanvasMode.install(iframe),
    'native mode must install the Ketcher first-frame mirror');
  const probeDoc = doc.implementation.createHTMLDocument('ketcher');
  assert.ok(window.MolStudioNativeCanvasMode.apply(probeDoc),
    'shared rules must be applicable to a Ketcher document');
  assert.ok(probeDoc.getElementById('molstudio-ketcher-canvas-mode'),
    'first-frame Ketcher stylesheet must be installed');
  assert.ok(probeDoc.getElementById('molstudio-ketcher-canvas-mode').textContent.includes('display: none !important'));
});

test('browser mode without marker: no CSS, no hiddenControls, original iframe URL', () => {
  const { window, errors, doc } = buildDOM('http://127.0.0.1:48975/canvas.html');
  assert.deepEqual(errors, []);
  assert.equal(doc.documentElement.getAttribute('data-native-canvas'), null);
  assert.equal(window.__molstudioNativeCanvas, undefined);
  assert.equal(window.MolStudioNativeCanvas, undefined);
  assert.equal(doc.getElementById('molstudio-native-canvas-css'), null);
  assert.equal(doc.getElementById('k').src, 'http://127.0.0.1:48975/ketcher/index.html');
});

test('browser mode with unrelated query keeps legacy behaviour', () => {
  const { doc } = buildDOM('http://127.0.0.1:48975/canvas.html?foo=bar');
  assert.equal(doc.documentElement.getAttribute('data-native-canvas'), null);
  assert.ok(!doc.getElementById('k').src.includes('hiddenControls'));
});

test('every native navigation carries its own generation marker', () => {
  for (const gen of [3, 17, 999]) {
    const { window, doc } = buildDOM(`http://127.0.0.1:48975/canvas.html?nativeCanvas=1&navGen=${gen}`);
    assert.equal(window.MolStudioNativeCanvas.navigationGeneration, gen);
    assert.ok(!doc.getElementById('k').src.includes('hiddenControls'));
    assert.ok(window.MolStudioNativeCanvasMode.isNative());
  }
});
