/* Canvas navigation. Points passed by the native shell use the host page's
 * client coordinates; Ketcher's zoom anchor uses iframe client coordinates. */
(function (root) {
  'use strict';
  function create(iframe, getEditor) {
    let pointer = null;
    const limits = { min: 0.2, max: 4 };
    const panGain = 0.55; // Shared screen-space sensitivity for canvas and paper.
    let hostViewport = null; // Contract §7 HostViewport: top-level WebView CSS client px.
    const paperMode = () => root.MolWorkbench?.app?.documentController?.active && root.MolWorkbench.app.documentController.state.mode === 'paper';
    function setHostViewport(viewport) {
      // Only strictly newer layout revisions are accepted; older or replayed
      // host layouts never shrink the effective region retroactively.
      if (!viewport || !Number.isFinite(viewport.layoutRevision)) return false;
      if (hostViewport && viewport.layoutRevision <= hostViewport.layoutRevision) return false;
      hostViewport = viewport;
      return true;
    }
    function hostViewportState() { return hostViewport; }
    /* Conservative edge insets (host WebView CSS px, top-left origin) covering
     * the safe area plus every native overlay that really covers the content.
     * Split-view resized sidebars are NOT overlays: the host already reports
     * them via cssSize, so they must not be double counted. */
    function effectiveInsets() {
      const insets = { left: 0, top: 0, right: 0, bottom: 0 };
      if (!hostViewport) return insets;
      const safe = hostViewport.safeAreaInsets || {};
      insets.left = Math.max(0, Number(safe.left) || 0);
      insets.top = Math.max(0, Number(safe.top) || 0);
      insets.right = Math.max(0, Number(safe.right) || 0);
      insets.bottom = Math.max(0, Number(safe.bottom) || 0);
      const size = hostViewport.cssSize || { width: root.innerWidth || 0, height: root.innerHeight || 0 };
      for (const overlay of hostViewport.overlays || []) {
        const x = Number(overlay.x), y = Number(overlay.y), w = Number(overlay.width), h = Number(overlay.height);
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
        if (x + w <= 0 || x >= size.width || y + h <= 0 || y >= size.height) continue;
        // Expand only the edge the palette is anchored to (contract §7:
        // conservative edge rect), never the middle of the canvas. The contract
        // fixes the two overlay ids, so anchoring follows the declared id; an
        // unknown id falls back to its narrowest touching edge strip.
        const candidates = [];
        const EDGE_TOLERANCE = 24;
        if (x <= EDGE_TOLERANCE) candidates.push(['left', x + w]);
        if (x + w >= size.width - EDGE_TOLERANCE) candidates.push(['right', size.width - x]);
        if (y <= EDGE_TOLERANCE) candidates.push(['top', y + h]);
        if (y + h >= size.height - EDGE_TOLERANCE) candidates.push(['bottom', size.height - y]);
        let edges = candidates;
        if (overlay.id === 'toolPalette') edges = candidates.filter(([side]) => side === 'left').length ? candidates.filter(([side]) => side === 'left') : candidates;
        if (overlay.id === 'zoomPalette') edges = candidates.filter(([side]) => side === 'bottom').length ? candidates.filter(([side]) => side === 'bottom') : candidates;
        if (overlay.id === 'chemicalPalette') edges = candidates.filter(([side]) => side === 'right').length ? candidates.filter(([side]) => side === 'right') : candidates;
        if (!edges.length) continue; // Overlay touches no window edge: expands nothing.
        for (const [side, inset] of edges) insets[side] = Math.max(insets[side], inset);
      }
      return insets;
    }
    function effectiveRect() {
      const insets = effectiveInsets();
      const size = hostViewport && hostViewport.cssSize && hostViewport.cssSize.width
        ? hostViewport.cssSize : { width: root.innerWidth || 0, height: root.innerHeight || 0 };
      return {
        left: insets.left, top: insets.top,
        right: Math.max(insets.left, size.width - insets.right),
        bottom: Math.max(insets.top, size.height - insets.bottom)
      };
    }
    /* Convert host CSS px point to iframe client px and test native overlays.
     * Native overlays are not DOM: elementFromPoint cannot see them, so the
     * geometry check must run before any canvas hit test. */
    function toFrameClient(hostPoint) {
      const r = iframe.getBoundingClientRect();
      return { clientX: hostPoint.x - r.left, clientY: hostPoint.y - r.top };
    }
    function hostFromFrame(point) {
      const r = iframe.getBoundingClientRect();
      return { x: point.clientX + r.left, y: point.clientY + r.top };
    }
    function inNativeOverlay(hostPoint) {
      if (!hostPoint || !hostViewport) return false;
      const rect = effectiveRect();
      return hostPoint.x < rect.left || hostPoint.x >= rect.right ||
        hostPoint.y < rect.top || hostPoint.y >= rect.bottom;
    }
    function canvas() {
      const ed = getEditor();
      return ed && ed.render && ed.render.clientArea;
    }
    function onCanvas(point) {
      const area = canvas();
      if (!area || !point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return false;
      if (inNativeOverlay(hostFromFrame(point))) return false;
      const r = area.getBoundingClientRect();
      const hit = iframe.contentDocument.elementFromPoint(point.clientX, point.clientY);
      return point.clientX >= r.left && point.clientX < r.right &&
        point.clientY >= r.top && point.clientY < r.bottom && hit && area.contains(hit);
    }
    /* Native overlay/safe-area insets expressed in this iframe's client px so
     * agent-bridge's visibleModelBounds can share the exact same region. */
    function nativeInsetsFrame() {
      // The WebView and its iframe share one CSS scale, so inset magnitudes
      // transfer into the iframe's client box after subtracting iframe origin offsets.
      const insets = effectiveInsets();
      const r = iframe.getBoundingClientRect();
      const viewW = root.innerWidth || (hostViewport && hostViewport.cssSize.width) || r.right || r.width || 0;
      const viewH = root.innerHeight || (hostViewport && hostViewport.cssSize.height) || r.bottom || r.height || 0;
      return {
        left: Math.max(0, insets.left - (r.left || 0)),
        top: Math.max(0, insets.top - (r.top || 0)),
        right: Math.max(0, insets.right - Math.max(0, viewW - (r.right || viewW))),
        bottom: Math.max(0, insets.bottom - Math.max(0, viewH - (r.bottom || viewH)))
      };
    }
    function zoomBy(factor, hostPoint) {
      const ed = getEditor();
      if (!ed || !Number.isFinite(factor) || factor <= 0) return false;
      let anchor = pointer;
      if (hostPoint !== undefined) {
        if (inNativeOverlay(hostPoint)) return false; // Gesture over a native palette never zooms the canvas.
        const r = iframe.getBoundingClientRect();
        anchor = hostPoint && {
          clientX: hostPoint.x - r.left,
          clientY: hostPoint.y - r.top
        };
        if (!onCanvas(anchor)) return false;
      } else if (!onCanvas(anchor)) anchor = undefined;
      const current = ed.zoom();
      const next = Math.max(paperMode() ? 0.08 : limits.min, Math.min(limits.max, current * factor));
      if (next === current) return false;
      ed.zoom(next, anchor);
      // editor.zoom() alone does not refresh Ketcher's percentage control.
      if (ed.event && ed.event.zoomChanged) ed.event.zoomChanged.dispatch();
      const tool = ed.tool && ed.tool();
      if (tool && tool.mousemove && ed.lastEvent) tool.mousemove(ed.lastEvent);
      return true;
    }
    function install(doc) {
      pointer = null;
      doc.addEventListener('pointermove', e => {
        pointer = onCanvas(e) ? { clientX: e.clientX, clientY: e.clientY } : null;
      }, true);
      doc.addEventListener('pointerleave', () => { pointer = null; });
      doc.defaultView.addEventListener('blur', () => { pointer = null; });
      doc.addEventListener('wheel', e => {
        if (!onCanvas(e)) return;
        pointer = { clientX: e.clientX, clientY: e.clientY };
        const area = canvas();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? area.clientHeight : 1;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          zoomBy(Math.pow(2, -Math.max(-120, Math.min(120, e.deltaY * unit)) * 0.002));
        } else {
          // Use the same screen-space gain in both canvas and paper mode.
          // macOS/WebKit already supplies the momentum wheel sequence: apply
          // every delta directly, without adding easing or a second inertia.
          // Owning this path also avoids Ketcher's legacy 0.4 multiplier and
          // its Shift-wheel dependency on the deprecated wheelDelta field.
          e.preventDefault();
          e.stopImmediatePropagation();
          const ed = getEditor();
          const x = Number.isFinite(e.deltaX) ? e.deltaX : 0;
          const y = Number.isFinite(e.deltaY) ? e.deltaY : 0;
          const dx = (e.shiftKey ? (x || y) : x) * unit * panGain / ed.zoom();
          const dy = e.shiftKey ? 0 : y * unit * panGain / ed.zoom();
          if (!dx && !dy) return;
          ed.render.setViewBox(v => ({ ...v, minX: v.minX + dx, minY: v.minY + dy }));
          const tool = ed.tool && ed.tool();
          if (tool && tool.mousemove && ed.lastEvent) tool.mousemove(ed.lastEvent);
        }
      }, { capture: true, passive: false });
      doc.addEventListener('keydown', e => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
        const target = e.target;
        // Ketcher keeps its invisible clipboard textarea focused on the canvas.
        // It is a keyboard receiver, whereas visible fields must retain editing.
        if (target && target.closest && !target.closest('.cliparea') &&
          target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return;
        const factor = e.key === '+' || e.key === '=' ? 1.25 : e.key === '-' ? 0.8 : null;
        if (factor === null) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        zoomBy(factor);
      }, true);
    }
    return { zoomBy, install, setHostViewport, hostViewportState, effectiveRect, effectiveInsets, nativeInsetsFrame, inNativeOverlay };
  }
  root.MolCanvasViewport = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof window === 'object' ? window : globalThis);
