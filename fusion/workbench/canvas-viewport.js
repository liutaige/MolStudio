/* Canvas navigation. Points passed by the native shell use the host page's
 * client coordinates; Ketcher's zoom anchor uses iframe client coordinates. */
(function (root) {
  'use strict';
  function create(iframe, getEditor) {
    let pointer = null;
    const limits = { min: 0.2, max: 4 }; // Ketcher's zoom menu limits
    function canvas() {
      const ed = getEditor();
      return ed && ed.render && ed.render.clientArea;
    }
    function onCanvas(point) {
      const area = canvas();
      if (!area || !point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return false;
      const r = area.getBoundingClientRect();
      const hit = iframe.contentDocument.elementFromPoint(point.clientX, point.clientY);
      return point.clientX >= r.left && point.clientX < r.right &&
        point.clientY >= r.top && point.clientY < r.bottom && hit && area.contains(hit);
    }
    function zoomBy(factor, hostPoint) {
      const ed = getEditor();
      if (!ed || !Number.isFinite(factor) || factor <= 0) return false;
      let anchor = pointer;
      if (hostPoint !== undefined) {
        const r = iframe.getBoundingClientRect();
        anchor = hostPoint && {
          clientX: hostPoint.x - r.left,
          clientY: hostPoint.y - r.top
        };
        if (!onCanvas(anchor)) return false;
      } else if (!onCanvas(anchor)) anchor = undefined;
      const current = ed.zoom();
      const next = Math.max(limits.min, Math.min(limits.max, current * factor));
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
        } else if (e.shiftKey) {
          // Ketcher's Shift-wheel path reads deprecated wheelDelta, which is
          // absent on some devices/events and can put NaN into the viewBox.
          e.preventDefault();
          e.stopImmediatePropagation();
          const ed = getEditor();
          const dx = (e.deltaX || e.deltaY) * unit * 0.4 / ed.zoom();
          ed.render.setViewBox(v => ({ ...v, minX: v.minX + dx }));
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
    return { zoomBy, install };
  }
  root.MolCanvasViewport = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create };
})(typeof window === 'object' ? window : globalThis);
