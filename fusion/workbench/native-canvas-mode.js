/* MolStudio first-frame canvas mode — single source of truth for the Ketcher
 * iframe stylesheet. The native host injects this as a WKUserScript at
 * atDocumentStart (forMainFrameOnly:false); canvas.html also loads this file so
 * the same rules can be applied to the iframe document in a browser/Electron
 * harness when the host explicitly marks native mode.
 *
 * Engine button definitions are deliberately NOT hidden via Ketcher's
 * hiddenControls option: hiding every button breaks its default selected tool
 * ("Cannot read properties of undefined (reading 'title')") and takes the
 * editor instance down. Only the visual toolbars are hidden, with !important,
 * so a late detach / attach callback cannot reveal them.
 */
(function (root) {
  'use strict';
  var RULES = [
    '[data-testid="top-toolbar"],',
    '[data-testid="left-toolbar"],',
    '[data-testid="right-toolbar"],',
    '[data-testid="bottom-toolbar"],',
    '[data-testid="left-toolbar-buttons"],',
    '[data-mech-tool],',
    '[data-mech-actions],',
    '[data-mech-action],',
    '.MuiAppBar-root',
    '{ display: none !important; visibility: hidden !important; pointer-events: none !important; }',
    'html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }'
  ].join('\n');

  function apply(doc) {
    if (!doc || !doc.documentElement) return false;
    if (doc.getElementById('molstudio-ketcher-canvas-mode')) return true;
    var style = doc.createElement('style');
    style.id = 'molstudio-ketcher-canvas-mode';
    style.textContent = RULES;
    (doc.head || doc.documentElement).appendChild(style);
    return true;
  }

  root.MolStudioNativeCanvasMode = Object.freeze({
    rules: RULES,
    apply: apply,
    /** True when the top-level page was opened by the native host. */
    isNative: function () {
      return !!(root.MolStudioNativeCanvas && root.MolStudioNativeCanvas.active);
    },
    /** Browser/Electron harness: mirror the WKUserScript at iframe load. */
    install: function (iframe) {
      if (!iframe || !this.isNative()) return false;
      var self = this;
      var applyNow = function () {
        try {
          var doc = iframe.contentDocument;
          if (!doc) return;
          if (!doc.documentElement) {
            // Navigation has replaced the document but its root is not parsed
            // yet. Re-apply as soon as the new document is interactive.
            doc.addEventListener('DOMContentLoaded', applyNow, { once: true });
            return;
          }
          self.apply(doc);
        } catch (e) { /* cross-realm guard */ }
      };
      iframe.addEventListener('load', applyNow);
      applyNow();
      return true;
    }
  });
})(typeof window === 'object' ? window : globalThis);
