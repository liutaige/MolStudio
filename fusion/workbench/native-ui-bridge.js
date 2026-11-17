/* MolStudio native UI contract v1 — JS adapter.
 *
 * Implements `window.k3dAPI.nativeUI` (attach/dispatch/getState/detach) plus the
 * single `{act:"nativeUI"}` outbound message on the existing `k3d` handler.
 *
 * Hard rules (contract v1):
 * - Only a successful attach with a complete capability list hides web controls.
 *   Browser mode and failed attach keep every existing web entry point.
 * - No file lifecycle here: no paths, no writes, no setMolecule-as-open.
 * - getState() is a read-only cached snapshot: no .molwork serialization, no
 *   finishing text edits.
 * - Commands validate the epoch before execution and again after every await.
 * - Repeated requestId never re-applies a mutation (cached or in-flight reply).
 * - Manual property commits reuse the existing runtime.stop('manual_edit') gate.
 * - Only verified engine mappings are exposed; unverified ones stay unsupported.
 */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {};

  const PROTOCOL = 1;
  const SURFACES = ['fileCommands', 'toolPalette', 'zoomPalette', 'inspector', 'agent'];

  /* Verified engine mappings (evidence: shipped Ketcher distribution
   * ketcher-local/static/js/main.e47c48ad.js, byte offsets recorded in
   * tests/artifacts/macos-shell-20261114/work/native-ui-ketcher-mapping-evidence.md;
   * each bond/arrow entry is additionally exercised against the real editor in
   * tests/test_native_ui_real.cjs).
   * editor.tool(name, opts) map keys: hand, select(+opts), eraser, atom(+{label}),
   * bond(+{type,stereo}), chain, template(unusable without a library item ->
   * unsupported), reactionarrow(+mode), simpleobject(+mode), text. */
  const BOND_OPTS = {
    // Bond.PATTERN.TYPE/Stereo as read from the shipped bundle's `bk` map.
    'bond.single': { type: 1, stereo: 0 },
    'bond.double': { type: 2, stereo: 0 },
    'bond.triple': { type: 3, stereo: 0 },
    'bond.wedge': { type: 1, stereo: 1 },   // up
    'bond.hashed': { type: 1, stereo: 6 },  // down (slashed)
    'bond.wavy': { type: 1, stereo: 4 }     // either
  };
  /* RxnArrowMode enum, shipped bundle offset 1487963 (!function(U){U.OpenAngle=…}
   * (dd||(dd={})), binding `dd` at offset 1488948). Full value list re-extracted
   * from ketcher-local/static/js/main.e47c48ad.js on 2026-11-16 (18 values):
   * open-angle, filled-triangle, filled-bow, dashed-open-angle, failed,
   * retrosynthetic, both-ends-filled-triangle, equilibrium-filled-triangle,
   * equilibrium-filled-half-bow, equilibrium-open-angle,
   * unbalanced-equilibrium-filled-half-bow, unbalanced-equilibrium-open-half-angle,
   * unbalanced-equilibrium-large-filled-half-bow,
   * unbalanced-equilibrium-filled-half-triangle, elliptical-arc-arrow-filled-bow,
   * elliptical-arc-arrow-filled-triangle, elliptical-arc-arrow-open-angle,
   * elliptical-arc-arrow-open-half-angle.
   * Every value is a real editor.tool('reactionarrow', mode) argument; no
   * web-toolbar fallback. This build has no resonance mode at all (the string
   * "resonance" never appears in the bundle), so resonanceArrow maps to
   * both-ends-filled-triangle: the only straight double-headed style in the
   * bundle (↔ shape — thin straight shaft, solid outward triangle heads at
   * both ends; toolbar icon path tips at x=9.3 and x=38.7, verified in
   * ketcher-local/static/js/main.e47c48ad.js on 2026-11-17). The open-ended
   * straight double head both-ends-open-angle does NOT exist in this bundle;
   * if a future build ships it, remap resonanceArrow to it. The
   * elliptical-arc family is the curved style users complained about
   * (共振箭头画成弯曲箭头, 2026-11-16); never fall back to it for
   * resonanceArrow. Because each tool now has a distinct mode, the tool-watch
   * state maps back to resonanceArrow via ARROW_MODES. */
  const ARROW_MODES = {
    'reactionArrow': 'open-angle',
    'equilibriumArrow': 'equilibrium-open-angle',
    'resonanceArrow': 'both-ends-filled-triangle',
    'retrosyntheticArrow': 'retrosynthetic'
  };
  const SHAPE_MODES = {
    'shape.rect': 'rectangle',
    'shape.ellipse': 'ellipse',
    'shape.line': 'line'
  };
  /* Document-layer drawing tools. These are documentController.setTool values
   * backed by real SVG objects in document-controller.js (not Ketcher toolbar
   * clicks), so they are genuine native interactions with one undo each. */
  const DOCUMENT_TOOLS = new Set([
    'select', 'text', 'image', 'rect', 'roundRect', 'ellipse', 'line',
    'arrow', 'polygon', 'bracket'
  ]);
  const IMAGE_TOOL = 'images';   // Ketcher IMAGE_KEY (bundle offset 1338322).
  const ELEMENTS = new Set([
    'H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar','K','Ca',
    'Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr','Rb','Sr',
    'Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe','Cs','Ba',
    'La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu','Hf','Ta','W',
    'Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn','Fr','Ra','Ac','Th','Pa','U',
    'A','Q','R','M','X','D','*'
  ]);
  const MECH_TOOLS = new Set(['select', 'lonePair', 'arrow2', 'arrow1']);
  const TEMPLATE_NAME_TO_ID = {
    Benzene: { id: 'ring.benzene', label: '苯环' },
    Cyclopentadiene: { id: 'ring.cyclopentadiene', label: '环戊二烯' },
    Cyclohexane: { id: 'ring.cyclohexane', label: '环己烷' },
    Cyclopentane: { id: 'ring.cyclopentane', label: '环戊烷' },
    Cyclopropane: { id: 'ring.cyclopropane', label: '环丙烷' },
    Cyclobutane: { id: 'ring.cyclobutane', label: '环丁烷' },
    Cycloheptane: { id: 'ring.cycloheptane', label: '环庚烷' },
    Cyclooctane: { id: 'ring.cyclooctane', label: '环辛烷' }
  };

  function epochKey(epoch) { return epoch ? epoch.navigationGeneration + '/' + epoch.pageId : ''; }
  function sameEpoch(a, b) { return !!a && !!b && a.navigationGeneration === b.navigationGeneration && a.pageId === b.pageId; }
  /* First-frame canvas mode: the native host loads the page with ?nativeCanvas=1.
   * In that mode the old web UI is never a normal surface, an advanced mode, or
   * an error fallback — it is hidden by a parse-time stylesheet with !important
   * and must never be restored, even by detach or a failed attach. Browser mode
   * (no marker) keeps every legacy entry point intact. */
  function nativeCanvasMode() {
    return !!(root.MolStudioNativeCanvas && root.MolStudioNativeCanvas.active)
      || !!(root.document && root.document.documentElement
        && root.document.documentElement.getAttribute('data-native-canvas') === '1');
  }

  function NativeUIBridge(deps) {
    this.deps = deps || {};
    this.doc = this.deps.doc || root.document;
    this.attached = false;
    this.disposed = false;
    this.epoch = null;
    this.sequence = 0;
    this.revision = 0;
    this._pageSeq = 0;
    this._pageIds = new Map();
    this.ownedSurfaces = [];
    this.hostContext = { windowKey: false, focusOwner: 'none', inspectorVisible: false };
    this.hostViewport = null;          // validated HostViewport from host.context
    this.agentRenderer = null;
    this.pendingCommands = new Map();  // requestId -> Promise<reply>
    this.commandReplies = new Map();   // requestId -> reply (idempotency cache)
    this.selectionRevision = 0;
    this.selectionSnapshot = null;
    this.stateDirty = false;
    this.stateFlushScheduled = false;
    this._flushToken = 0;
    this._flushTimer = null;
    this.canContinue = false;
    this.agentRunning = false;
    this.lastSelectionKey = null;
    this._observers = [];
    this._hidden = [];                 // [{doc, el}] web controls hidden by attach
    this._toolWatch = null;
  }

  NativeUIBridge.prototype.app = function () { return this.deps.app || MW.app || null; };
  NativeUIBridge.prototype.agentAPI = function () { return this.deps.agent ? this.deps.agent() : root.molstudioAgent || null; };
  NativeUIBridge.prototype.viewport = function () {
    // The live viewport instance created by canvas.html (falls back to the
    // module namespace for tests).
    return this.deps.viewport || root.molCanvasViewport || root.MolCanvasViewport || null;
  };

  /* ---------------- outbound single-channel messaging ---------------- */
  NativeUIBridge.prototype.post = function (kind, payload) {
    if (!this.attached || this.disposed) return;
    const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.k3d;
    if (!handler || typeof handler.postMessage !== 'function') return; // Browser: nothing to publish.
    this.sequence += 1;
    handler.postMessage({ act: 'nativeUI', protocol: PROTOCOL, epoch: { ...this.epoch }, sequence: this.sequence, kind, payload });
  };

  NativeUIBridge.prototype.publishAgent = function (payload) {
    this.post('agent', payload);
  };

  /* ---------------- state cache ---------------- */
  NativeUIBridge.prototype.markState = function () {
    this.revision += 1;
    if (this.stateFlushScheduled) return;
    this.stateFlushScheduled = true;
    const token = ++this._flushToken;
    const flush = () => {
      if (this._flushToken !== token) return;
      this.stateFlushScheduled = false;
      if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
      if (!this.attached || this.disposed) return;
      this.selectionSnapshot = this.buildSelection();
      this.post('state', this.getState());
    };
    // One frame coalescing with a timer fallback for background windows.
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(flush);
    this._flushTimer = setTimeout(flush, 120);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  };

  NativeUIBridge.prototype.buildSelection = function () {
    const app = this.app();
    const controller = app && app.controller;
    const documentController = app && app.documentController;
    if (!controller) return { revision: this.selectionRevision, kind: 'none', count: 0, label: '', properties: [] };
    const mechIds = Array.from(controller.selection || []);
    const docIds = documentController ? Array.from(documentController.selection || []) : [];
    let ketcherCount = 0;
    try {
      const sel = controller.adapter && controller.adapter.ed ? controller.adapter.ed.selection() : null;
      if (sel) ketcherCount = (sel.atoms ? sel.atoms.length : 0) + (sel.bonds ? sel.bonds.length : 0) + (sel.rxnArrows ? sel.rxnArrows.length : 0);
    } catch (e) { /* selection API guarded elsewhere. */ }
    const count = mechIds.length + docIds.length + ketcherCount;
    const arrows = mechIds.map(id => controller.model.arrow(id)).filter(Boolean);
    const lonePairs = mechIds.map(id => controller.model.lonePair(id)).filter(Boolean);
    const molecules = ketcherCount;
    const docObjects = docIds.map(id => documentController.object(id)).filter(Boolean);
    let kind = 'none';
    if (count) {
      const kinds = new Set();
      if (arrows.length) kinds.add('electronFlow');
      if (lonePairs.length) kinds.add('lonePair');
      if (molecules) kinds.add('molecule');
      // Mechanism-layer ids that resolve to neither arrows nor lone pairs are
      // chemistry content (molecules), so the inspector labels them as such
      // instead of a generic "N objects" that collides with document objects.
      if (!arrows.length && !lonePairs.length && !docObjects.length && mechIds.length) kinds.add('molecule');
      if (docObjects.length) kinds.add('document');
      kind = kinds.size > 1 ? 'mixed' : (kinds.values().next().value || 'mixed');
    }
    const properties = this.selectionProperties({ arrows, lonePairs, docObjects, selectionCount: count });
    const activeShapeTool = documentController && ['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'bracket'].includes(documentController.tool);
    const label = !count ? (activeShapeTool ? '形状样式' : '') : kind === 'electronFlow' && arrows.length === 1 ? '电子流弯箭头'
      : kind === 'lonePair' && lonePairs.length === 1 ? '孤对电子'
        : kind === 'document' && docObjects.length === 1 ? '文档对象'
          : kind === 'molecule' && count === 1 ? '分子结构'
        : kind === 'molecule' ? '所选化学内容' : '已选 ' + count + ' 个对象';
    return { revision: this.selectionRevision, kind, count, label, properties };
  };

  /* Only actually editable properties; no invented colour/line-width controls. */
  NativeUIBridge.prototype.selectionProperties = function (parts) {
    const out = [];
    const { arrows, docObjects } = parts;
    const choice = (id, label, value, choices) => out.push({ id, label, type: 'choice', value, enabled: true, choices });
    const numeric = (id, label, value, min, max, step) => {
      if (Number.isFinite(Number(value))) out.push({ id, label, type: 'number', value: Number(value), enabled: true, min, max, step });
    };
    const text = (id, label, value) => out.push({ id, label, type: 'text', value: String(value == null ? '' : value), enabled: true });
    if (arrows.length === 1) {
      const ar = arrows[0];
      out.push({ id: 'bend', label: '曲率', type: 'number', value: Number(ar.geometry.bend.toFixed(2)), enabled: true, min: -2.4, max: 2.4, step: 0.02 });
      const bondSide = ['source', 'target'].find(s => ar[s] && ar[s].type === 'bond');
      if (bondSide) {
        const current = ar[bondSide].component === 'pi' ? 'pi' : 'sigma';
        out.push({
          id: 'bondComponent', label: '键电子成分', type: 'choice', value: current, enabled: true,
          choices: [{ value: 'sigma', label: 'σ' }, { value: 'pi', label: 'π' }]
        });
      }
    } else if (arrows.length > 1) {
      out.push({ id: 'bend', label: '曲率', type: 'number', value: Number(arrows[0].geometry.bend.toFixed(2)), enabled: true, min: -2.4, max: 2.4, step: 0.02 });
    }
    if (docObjects.length === 1) {
      const o = docObjects[0];
      for (const [id, label, value] of [['width', '宽度', o.w], ['height', '高度', o.h], ['rotation', '旋转角度', o.rotation || 0]]) {
        if (Number.isFinite(value)) out.push({ id, label, type: 'number', value, enabled: true, min: id === 'rotation' ? -360 : 0.1, max: id === 'rotation' ? 360 : 4096, step: 0.1 });
      }
      out.push({
        id: 'band', label: '图层', type: 'choice', value: o.band === 'front' ? 'front' : 'back', enabled: true,
        choices: [{ value: 'back', label: '结构下方' }, { value: 'front', label: '结构上方' }]
      });
      // Real editable document-object fields, surfaced to the native inspector
      // through the same selection.setProperty contract (one undo per commit).
      if (o.kind === 'text') {
        const r = o.rich || {};
        text('rich.text', '文字内容', r.text || '');
        choice('rich.fontFamily', '字体', r.fontFamily || 'Arial, PingFang SC, sans-serif', [
          { value: 'Arial, PingFang SC, sans-serif', label: 'Arial / 苹方' },
          { value: 'Times New Roman, Songti SC, serif', label: 'Times / 宋体' },
          { value: 'Helvetica, sans-serif', label: 'Helvetica' },
          { value: 'monospace', label: '等宽' }
        ]);
        numeric('rich.fontSize', '字号 (pt)', r.fontSize || 12, 2, 300, 0.5);
        text('rich.color', '文字颜色 (#RRGGBB)', r.color || '#1c1c1e');
        choice('rich.bold', '粗体', r.bold ? 'true' : 'false', [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]);
        choice('rich.italic', '斜体', r.italic ? 'true' : 'false', [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]);
        choice('rich.align', '对齐', r.align || 'left', [{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }]);
      } else if (o.kind === 'shape') {
        const dc = this.app() && this.app().documentController;
        const unit = Number(dc && dc.state && dc.state.ptPerBond) > 0 ? Number(dc.state.ptPerBond) : 14.4;
        text('stroke.color', '描边颜色', (o.stroke && o.stroke.color) || '#3b5665');
        numeric('stroke.width', '边框宽度 (pt)', ((o.stroke && o.stroke.width) || 0.05) * unit, 0.1, 72, 0.1);
        choice('stroke.dash', '线型', (o.stroke && o.stroke.dash) || 'solid', [{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }]);
        if (!['line', 'arrow', 'bracket'].includes(o.shape)) {
          const fill = o.fill && o.fill !== 'none' ? o.fill : 'none';
          choice('fill.mode', '填充', fill === 'none' ? 'none' : 'filled', [{ value: 'filled', label: '有填充' }, { value: 'none', label: '无填充' }]);
          text('fillColor', '填充颜色', o.fillColor || (fill === 'none' ? '#ffffff' : fill));
        }
        if (o.shape === 'rect' || o.shape === 'roundRect') {
          const radius = Number.isFinite(o.cornerRadius) ? o.cornerRadius : o.shape === 'roundRect' ? Math.min(0.5, o.h / 4) : 0;
          numeric('cornerRadius', '圆角半径 (pt)', radius * unit, 0, Math.min(o.w, o.h) / 2 * unit, 0.1);
        }
      } else if (o.kind === 'image') {
        const crop = o.crop || { x: 0, y: 0, w: 1, h: 1 };
        for (const [key, label] of [['x', '裁剪 X'], ['y', '裁剪 Y'], ['w', '裁剪宽'], ['h', '裁剪高']]) {
          numeric('crop.' + key, label, crop[key], 0, 1, 0.01);
        }
      }
      // Object actions are exposed as extra choice rows; Swift sends them via
      // document.object.* rather than selection.setProperty. The native panel
      // renders them as buttons using their ids.
      out.push({ id: 'action.duplicate', label: '复制对象', type: 'choice', value: 'run', enabled: true,
        choices: [{ value: 'run', label: '复制' }] });
      out.push({ id: 'action.delete', label: '删除对象', type: 'choice', value: 'run', enabled: true,
        choices: [{ value: 'run', label: '删除' }] });
      if (o.kind === 'text') out.push({ id: 'action.editText', label: '编辑文字', type: 'choice', value: 'run', enabled: true,
        choices: [{ value: 'run', label: '编辑' }] });
    }
    const shapeController = this.app() && this.app().documentController;
    const shapeTool = shapeController && ['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'bracket'].includes(shapeController.tool) ? shapeController.tool : null;
    if (shapeTool) {
        const dc = shapeController;
        const style = dc.shapeStyle || {}, stroke = style.stroke || {};
        const unit = Number(dc.state && dc.state.ptPerBond) > 0 ? Number(dc.state.ptPerBond) : 14.4;
        const prefix = 'shapeStyle.';
        text(prefix + 'stroke.color', '默认描边颜色', stroke.color || '#3b5665');
        numeric(prefix + 'stroke.width', '默认边框宽度 (pt)', (Number(stroke.width) || 0.05) * unit, 0.1, 72, 0.1);
        choice(prefix + 'stroke.dash', '默认线型', stroke.dash || 'solid', [{ value: 'solid', label: '实线' }, { value: 'dashed', label: '虚线' }]);
        if (!['line', 'arrow', 'bracket'].includes(shapeTool)) {
          const fill = style.fill && style.fill !== 'none' ? style.fill : 'none';
          choice(prefix + 'fill.mode', '默认填充', fill === 'none' ? 'none' : 'filled', [{ value: 'filled', label: '有填充' }, { value: 'none', label: '无填充' }]);
          text(prefix + 'fillColor', '默认填充颜色', style.fillColor || (fill === 'none' ? '#ffffff' : fill));
        }
        if (shapeTool === 'rect' || shapeTool === 'roundRect') {
          const radius = Number.isFinite(style.cornerRadius) ? style.cornerRadius : shapeTool === 'roundRect' ? 0.5 : 0;
          numeric(prefix + 'cornerRadius', '默认圆角半径 (pt)', radius * unit, 0, 1000, 0.1);
        }
    }
    // Selection scaling (Wave2 core): paper mode only — boundless canvas has
    // no pages, so "actual size on paper" does not apply there. When the
    // document layer reports a scalable chemistry selection, expose the same
    // presets the web toolbar offers. scale.preset commits through
    // selection.setProperty with the standard expectedSelectionRevision
    // guard; scale.hint is a disabled read-only text row (Swift renders it as
    // a disabled field, no commits).
    const dc = this.app() && this.app().documentController;
    if (dc && dc.state && dc.state.mode === 'paper' &&
        typeof dc.hasScaleSelection === 'function' && dc.hasScaleSelection() === true) {
      const current = typeof dc.currentSessionPercent === 'function' ? dc.currentSessionPercent() : null;
      const presets = [['75', '75%'], ['100', '100%'], ['125', '125%'], ['150', '150%'], ['200', '200%']];
      const raw = Number(current);
      const value = String(Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 100);
      out.push({ id: 'scale.preset', label: '缩放选区', type: 'choice', value, enabled: true,
        choices: presets.map(([v, l]) => ({ value: v, label: l })) });
      out.push({ id: 'scale.hint', label: '缩放说明', type: 'text', enabled: false,
        value: '百分比以本次操作开始时的选区为基准；应用一次产生一个撤销动作' });
    }
    return out;
  };

  NativeUIBridge.prototype.toolState = function () {
    const app = this.app();
    const controller = app && app.controller;
    const documentController = app && app.documentController;
    if (documentController && documentController.tool && documentController.tool !== 'select') {
      const ids = { rect: 'shape.rect', ellipse: 'shape.ellipse', line: 'shape.line', roundRect: 'document.roundRect',
        arrow: 'document.arrow', polygon: 'document.polygon', bracket: 'document.bracket', text: 'document.text' };
      const labels = { rect: '矩形', ellipse: '椭圆', line: '直线', roundRect: '圆角矩形', arrow: '普通箭头', polygon: '三角形', bracket: '方括号', text: '文本框' };
      return { id: ids[documentController.tool] || 'document.' + documentController.tool, label: labels[documentController.tool] || '文档工具' };
    }
    if (controller && controller.tool && controller.tool !== 'select') {
      // Report palette product ids so the native tool palette can highlight
      // the active slot: mechanism tools use electronPairArrow/fishhookArrow
      // ids (controller-internal names are arrow2/arrow1); radical matches.
      const labels = {
        lonePair: '孤对电子', arrow2: '电子对弯箭头', arrow1: '单电子弯箭头', radical: '自由基'
      };
      const ids = { arrow2: 'electronPairArrow', arrow1: 'fishhookArrow' };
      const id = ids[controller.tool] || controller.tool;
      return { id: id, label: labels[controller.tool] || controller.tool };
    }
    const observed = this.observedKetcherTool();
    if (observed) return observed;
    return { id: 'select', label: '选择' };
  };

  /* Active-tool observation: every internal Ketcher entry point (toolbar,
   * hotkeys, Escape, PasteTool, cleanup) funnels through editor.tool(), so one
   * reversible wrapper plus the live tool() getter covers keyboard paths too.
   * This records evidence, it does not choose behaviour. */
  NativeUIBridge.prototype.observedKetcherTool = function () {
    return this._toolWatch && this._toolWatch.current();
  };

  NativeUIBridge.prototype.installToolWatch = function () {
    const app = this.app();
    const ed = app && app.adapter && app.adapter.ed;
    if (!ed || typeof ed.tool !== 'function' || this._toolWatch) return;
    let lastTool = null; // {ctor, name, opts}
    const original = ed.tool;
    const label = name => ({
      select: '选择', hand: '平移', eraser: '橡皮擦', chain: '碳链', text: '文字',
      atom: '元素', bond: '化学键', charge: '电荷', reactionplus: '反应加号', reactionarrow: '反应箭头', simpleobject: '形状',
      template: '模板', paste: '粘贴'
    })[name] || name;
    const describe = (name, opts) => {
      if (name === 'atom') return { id: 'element.' + (opts && opts.label || '?'), label: '元素 ' + (opts && opts.label || '') };
      if (name === 'charge') return { id: opts === 1 ? 'chargePlus' : 'chargeMinus', label: opts === 1 ? '正电荷' : '负电荷' };
      if (name === 'reactionplus') return { id: 'reactionPlus', label: '反应加号' };
      if (name === 'fragmentSelection') return { id: 'select.fragment', label: '片段选择' };
      if (name === 'bond') {
        for (const [id, o] of Object.entries(BOND_OPTS)) {
          if (o.type === (opts && opts.type) && o.stereo === (opts && opts.stereo)) return { id, label: label(name) };
        }
        return { id: 'bond', label: label(name) };
      }
      if (name === 'reactionarrow') {
        for (const [id, mode] of Object.entries(ARROW_MODES)) if (mode === opts) return { id, label: label(name) };
        return { id: 'reactionArrow.' + opts, label: label(name) };
      }
      if (name === 'simpleobject') {
        for (const [id, m] of Object.entries(SHAPE_MODES)) if (m === opts) return { id, label: label(name) };
        return { id: 'shape', label: label(name) };
      }
      if (name === 'select') {
        if (opts === 'lasso') return { id: 'lasso', label: '套索选择' };
        if (opts === 'rectangle') return { id: 'select', label: '框选' };
        if (opts === 'fragment') return { id: 'select.structure', label: '结构选择' };
        return { id: 'select', label: '选择' };
      }
      if (name === 'template') {
        const struct = opts && opts.struct;
        const match = struct
          ? this.templateRegistry().find(entry => entry.struct === struct || (entry.name && String(struct.name || '').toLowerCase() === entry.name.toLowerCase()))
          : null;
        return match ? { id: match.productId, label: '模板 ' + match.label } : { id: 'template', label: label(name) };
      }
      return { id: name, label: label(name) };
    };
    const self = this;
    try {
      ed.tool = function (name, opts) {
        const result = original.apply(this, arguments);
        try {
          if (arguments.length > 0 && typeof name === 'string' && result) {
            let live = null;
            try { live = original.call(ed); } catch (e) { live = null; }
            const ctor = (live && typeof result === 'object' && live === result && result.constructor)
              ? result.constructor
              : null;
            lastTool = { ctor, name, opts };
          }
        } catch (e) { /* Observation never breaks tool selection. */ }
        return result;
      };
    } catch (e) { return; }
    this._toolWatch = {
      current() {
        let live = null;
        try {
          const instance = original.call(ed);
          if (instance) live = { ctor: instance.constructor };
        } catch (e) { /* Guarded read. */ }
        if (!lastTool) return null;
        if (live && lastTool.ctor && live.ctor !== lastTool.ctor) {
          // Constructor changed without passing through the wrapper (hotkey
          // re-entry): keep reporting the last recorded mapping until the
          // wrapper observes the next switch. Never guess a name.
          return null;
        }
        return describe(lastTool.name, lastTool.opts);
      },
      restore() { try { ed.tool = original; } catch (e) { /* Read-only realm. */ } }
    };
  };

  NativeUIBridge.prototype.templateRegistry = function () {
    const app = this.app();
    const adapterWin = app && app.adapter && (app.adapter.win || (app.adapter.doc && app.adapter.doc.defaultView));
    const api = (adapterWin && adapterWin.molstudioNativeTemplates) || root.molstudioNativeTemplates || null;
    if (!api || typeof api.list !== 'function') return [];
    let items = [];
    try { items = api.list() || []; } catch (e) { return []; }
    if (!Array.isArray(items)) return [];
    const entries = [];
    for (const item of items) {
      if (!item || !item.struct) continue;
      const mapped = TEMPLATE_NAME_TO_ID[item.name] || null;
      const productId = mapped ? mapped.id : (typeof item.id === 'string' && item.id ? item.id : null);
      if (!productId) continue;
      entries.push({
        productId,
        rawId: item.id || productId,
        name: String(item.name || ''),
        label: mapped ? mapped.label : String(item.name || item.id || ''),
        struct: item.struct
      });
    }
    return entries;
  };

  NativeUIBridge.prototype.isAgentContinuable = function (agentAPI) {
    if (agentAPI && typeof agentAPI.getRuntime === 'function') {
      const rt = agentAPI.getRuntime();
      if (rt && typeof rt.canContinue === 'boolean') return rt.canContinue;
    }
    if (this.agentRenderer && typeof this.agentRenderer.canContinue === 'boolean') {
      return this.agentRenderer.canContinue;
    }
    return !!this.canContinue;
  };

  NativeUIBridge.prototype.buildDocumentInfo = function () {
    const app = this.app();
    const documentController = app && app.documentController;
    if (!documentController || !documentController.state) return null;
    const state = documentController.state;
    const paper = !!(documentController.active && state.mode === 'paper');
    const pages = Array.isArray(state.pages) ? state.pages : [];
    const pageCount = Number.isFinite(state.pageCount) ? state.pageCount : (pages.length || 1);
    const page = state.page || null;
    const margins = page && page.margins ? page.margins : null;
    const marginPt = margins
      ? [margins.top, margins.right, margins.bottom, margins.left].find(v => typeof v === 'number' && Number.isFinite(v))
      : null;
    const marginMm = typeof marginPt === 'number' ? Number((marginPt * 25.4 / 72).toFixed(1)) : null;
    let canRemoveLastPage = paper && pageCount > 1;
    if (canRemoveLastPage && MW.documentModel && typeof MW.documentModel.pageRects === 'function' && Array.isArray(state.objects)) {
      try {
        const rects = MW.documentModel.pageRects(state);
        const last = rects && rects.length ? rects[rects.length - 1] : null;
        if (last && typeof documentController.bounds === 'function') {
          const hitObj = state.objects.some(o => {
            const b = documentController.bounds(o);
            return b && !(b.x + b.w < last.x || b.x > last.x + last.w || b.y + b.h < last.y || b.y > last.y + last.h);
          });
          if (hitObj) canRemoveLastPage = false;
        }
      } catch (e) { /* Guarded against partial mocks. */ }
    }
    return {
      mode: paper ? 'paper' : 'canvas',
      pageCount,
      size: page && typeof page.size === 'string' ? page.size : null,
      orientation: page && typeof page.orientation === 'string' ? page.orientation : null,
      marginMm,
      canRemoveLastPage
    };
  };

  NativeUIBridge.prototype.getState = function () {
    if (!this.attached) return null;
    const app = this.app();
    const controller = app && app.controller;
    const documentController = app && app.documentController;
    if (!this.selectionSnapshot) this.selectionSnapshot = this.buildSelection();
    // Keep the published revision in lockstep with the revision used by
    // dispatch validation. markState() flushes on the next frame, so a native
    // host that reads state right after a mutation must not receive a stale
    // revision and get a spurious stale_selection rejection.
    if (this.selectionSnapshot.revision !== this.selectionRevision) {
      this.selectionSnapshot = { ...this.selectionSnapshot, revision: this.selectionRevision };
    }
    let canUndo = false, canRedo = false;
    try {
      const h = controller && controller.adapter && controller.adapter.ed && controller.adapter.ed.historySize
        ? controller.adapter.ed.historySize() : null;
      if (h) { canUndo = h.undo > 0; canRedo = h.redo > 0; }
    } catch (e) { /* Missing interface: keep buttons disabled, never guess. */ }
    const paper = !!(documentController && documentController.active && documentController.state.mode === 'paper');
    let percent = null;
    if (paper) { try { percent = documentController.getPaperZoom(); } catch (e) { percent = null; } }
    else {
      // Canvas mode: publish the real Ketcher canvas zoom (round(ed.zoom()*100), the
      // same value Ketcher's own percentage control shows). Read-only display for
      // zoom.by feedback; zoom.toPercent stays unsupported on canvas until its
      // absolute-percent semantics are verified per contract §4.
      try {
        const adapter = app && app.adapter;
        const z = adapter && typeof adapter.zoom === 'function' ? adapter.zoom() : null;
        if (Number.isFinite(z) && z > 0) percent = z * 100;
      } catch (e) { percent = null; }
    }
    const agentAPI = this.agentAPI();
    const agentRunning = !!(agentAPI && agentAPI.isRunning && agentAPI.isRunning());
    const canContinue = this.isAgentContinuable(agentAPI) && !agentRunning;
    const vp = this.viewport();
    const cssSize = { width: root.innerWidth || 0, height: root.innerHeight || 0 };
    return {
      protocol: PROTOCOL,
      epoch: { ...this.epoch },
      revision: this.revision,
      ready: { canvas: !!(app && app.ready), agent: !!(agentAPI && agentAPI.getRuntime && agentAPI.getRuntime()) },
      supported: this.supported(),
      tool: this.toolState(),
      selection: this.selectionSnapshot,
      history: { canUndo, canRedo },
      viewport: {
        mode: paper ? 'paper' : 'canvas',
        percent,
        cssSize,
        appliedHostLayoutRevision: this.hostViewport ? this.hostViewport.layoutRevision : 0
      },
      agent: {
        running: agentRunning,
        pendingStart: !!(agentAPI && agentAPI.pendingStart && agentAPI.pendingStart()),
        canContinue,
        settingsBusy: !!(this.agentRenderer && this.agentRenderer.settingsBusy)
      },
      document: this.buildDocumentInfo(),
      host: {
        windowKey: !!this.hostContext.windowKey,
        focusOwner: this.hostContext.focusOwner,
        inspectorVisible: !!this.hostContext.inspectorVisible,
        visibleFrame: vp && vp.effectiveRect ? vp.effectiveRect() : null
      }
    };
  };

  NativeUIBridge.prototype.supported = function () {
    const app = this.app();
    const documentController = app && app.documentController;
    const paper = !!(documentController && documentController.active && documentController.state.mode === 'paper');
    const templates = this.templateRegistry();
    const commands = [
      'host.context', 'tool.set', 'element.set', 'zoom.by',
      'edit.undo', 'edit.redo', 'edit.selectAll', 'edit.delete',
      'selection.setProperty', 'selection.replan', 'selection.toggleBondComponent',
      'agent.send', 'agent.stop', 'agent.continue', 'agent.reset',
      'agent.settings.load', 'agent.settings.save',
      // Document layer: real native commands, no web-toolbar fallback.
      'document.tool', 'document.addImage', 'document.addText', 'document.addShape',
      'document.object.update', 'document.object.duplicate', 'document.object.delete',
      'document.object.editText', 'document.page.setup', 'document.page.add',
      'document.page.removeLastBlank', 'document.importFile', 'document.exportPages',
      'document.state'
    ];
    if (templates.length) commands.push('template.set');
    if (paper) commands.push('zoom.toPercent', 'zoom.fit');
    const structOps = app && app.adapter && app.adapter.doc && app.adapter.doc.defaultView && app.adapter.doc.defaultView.molstudioNativeStructOps;
    return {
      commands,
      toolIds: [
        'select', 'lasso', 'select.structure', 'select.fragment', 'hand', 'erase', 'chain', 'text',
        'chargePlus', 'chargeMinus', 'reactionPlus', ...(structOps && structOps.version === 1 ? ['radical'] : []),
        'bond.single', 'bond.double', 'bond.triple', 'bond.wedge', 'bond.hashed', 'bond.wavy',
        'reactionArrow', 'equilibriumArrow', 'resonanceArrow', 'retrosyntheticArrow',
        'electronPairArrow', 'fishhookArrow', 'lonePair',
        'shape.rect', 'shape.ellipse', 'shape.line',
        'document.bracket', 'document.arrow', 'document.polygon', 'document.roundRect',
        'document.text',
        'document.image', 'insert.view3d', 'ketcher.image'
      ],
      elementSymbols: Array.from(ELEMENTS),
      templateIds: templates.map(t => t.productId)
    };
  };

  /* ---------------- attach / detach ---------------- */
  NativeUIBridge.prototype.attach = async function (options) {
    const o = options || {};
    if (o.protocol !== PROTOCOL) {
      return { ok: false, error: { code: 'invalid_arguments', message: 'protocol 必须为 1' } };
    }
    const rawEpoch = o.epoch;
    if (rawEpoch !== undefined && (!rawEpoch || typeof rawEpoch !== 'object' || typeof rawEpoch.pageId !== 'string' || !rawEpoch.pageId)) {
      return { ok: false, error: { code: 'invalid_arguments', message: 'epoch 缺少 pageId' } };
    }
    const rawNavGen = rawEpoch ? rawEpoch.navigationGeneration : o.navigationGeneration;
    if (typeof rawNavGen !== 'number' || !Number.isFinite(rawNavGen)) {
      return { ok: false, error: { code: 'invalid_arguments', message: 'epoch 缺少 navigationGeneration' } };
    }
    const rawPageId = rawEpoch ? rawEpoch.pageId : o.pageId;
    const explicitPageId = (typeof rawPageId === 'string' && rawPageId.trim()) ? rawPageId.trim() : '';
    const surfaces = Array.isArray(o.nativeSurfaces) ? o.nativeSurfaces.filter(s => SURFACES.includes(s)) : [];
    const app = this.app();
    if (!app || !app.ready) {
      return { ok: false, error: { code: 'not_ready', message: '化学工作台尚未就绪' } };
    }
    if (!explicitPageId && this.attached && this.epoch && this.epoch.navigationGeneration === rawNavGen) {
      return { ok: true, epoch: { ...this.epoch }, sequence: this.sequence, ownedSurfaces: [...this.ownedSurfaces], state: this.getState() };
    }
    const cachedPageId = explicitPageId ? '' : this._pageIds.get(rawNavGen);
    const pageId = explicitPageId || cachedPageId || (() => {
      const generated = 'page-' + rawNavGen + '-' + (++this._pageSeq);
      this._pageIds.set(rawNavGen, generated);
      return generated;
    })();
    const epoch = { navigationGeneration: rawNavGen, pageId };
    // Idempotent re-attach of the same epoch: return the live snapshot, never
    // resubscribe, never create another runtime/renderer.
    if (this.attached && sameEpoch(this.epoch, epoch)) {
      return { ok: true, epoch: { ...epoch }, sequence: this.sequence, ownedSurfaces: [...this.ownedSurfaces], state: this.getState() };
    }
    const owned = [];
    for (const surface of surfaces) {
      if (this.surfaceCapable(surface)) owned.push(surface);
    }
    if (!owned.length && surfaces.length) {
      return { ok: false, error: { code: 'unsupported', message: '宿主 surface 均无完整 JS 能力，保留网页控件' } };
    }
    // Rebind: invalidate the old epoch (late messages die with it), reset
    // sequencing, then apply ownership.
    if (this.attached) this.restoreWebSurfaces();
    this.epoch = { navigationGeneration: epoch.navigationGeneration, pageId: epoch.pageId };
    this.attached = true;
    this.disposed = false;
    this.sequence = 0;
    this.lastSelectionKey = this.computeSelectionKey();
    this.ownedSurfaces = owned;
    this.hostContext = {
      windowKey: !!(o.host && o.host.windowKey),
      focusOwner: (o.host && o.host.focusOwner) || 'canvas',
      inspectorVisible: !!(o.host && o.host.inspectorVisible)
    };
    this.installObservers();
    // Native-only dialog fallbacks for the 3D preview core layer. Attached
    // only after a successful attach; detach restores the previous hooks so
    // pure-browser mode is never affected.
    this.installMolecule3DDialogs();
    if (owned.includes('toolPalette') || owned.includes('zoomPalette') || owned.includes('inspector') || owned.includes('fileCommands')) {
      this.hideWebSurfaces(owned);
    }
    if (owned.includes('agent')) {
      this._suppressAgentPublish = true;
      try {
        this.activateNativeAgent();
      } finally {
        this._suppressAgentPublish = false;
      }
    }
    this.markState();
    // First ordered payload for this epoch: full presentation snapshot after
    // attach reply returns sequence 0.
    if (owned.includes('agent') && this.agentRenderer) {
      const boundEpoch = { ...this.epoch };
      const timer = setTimeout(() => {
        if (this.attached && !this.disposed && sameEpoch(this.epoch, boundEpoch) && this.agentRenderer) {
          this.agentRenderer.publishSnapshot(true);
        }
      }, 0);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return { ok: true, epoch: { ...this.epoch }, sequence: this.sequence, ownedSurfaces: [...owned], state: this.getState() };
  };

  NativeUIBridge.prototype.surfaceCapable = function (surface) {
    const app = this.app();
    if (!app || !app.ready || !app.controller || !app.adapter) return false;
    const agentAPI = this.agentAPI();
    switch (surface) {
      case 'fileCommands':
        return !!(app.documentController); // export/clean stay in Swift; JS just hides duplicate buttons.
      case 'toolPalette':
        // Complete only with the verified engine mapping set and a live editor.
        return !!(app.adapter.ed && typeof app.adapter.ed.tool === 'function' && app.controller.setTool);
      case 'zoomPalette':
        return !!(this.viewport() && typeof this.viewport().zoomBy === 'function');
      case 'inspector':
        return !!(app.controller.setBendForSelection && app.documentController && typeof app.documentController.updateObject === 'function');
      case 'agent':
        return !!(root.MolStudioAgentNativeRenderer && agentAPI && typeof agentAPI.send === 'function');
      default:
        return false;
    }
  };

  NativeUIBridge.prototype.installObservers = function () {
    if (this._observers.length) return;
    this.installToolWatch();
    const app = this.app();
    const off = [];
    const onChange = kind => {
      // Native UIState contains zoom and document settings, but no pan offset.
      // Moving the view must not rebuild inspector state or publish it again.
      if (kind === 'pan') return;
      if (kind === 'transform') this.markState();
      else this.noteSelectionChange();
    };
    if (app.adapter && typeof app.adapter.onChange === 'function') {
      off.push(app.adapter.onChange(onChange));
    }
    if (app.documentController && typeof app.documentController.subscribe === 'function') {
      off.push(app.documentController.subscribe((_state, _controller, kind) => onChange(kind)));
    }
    try {
      const ed = app.adapter.ed;
      if (ed && ed.event && ed.event.zoomChanged && typeof ed.event.zoomChanged.add === 'function') {
        const fn = () => this.markState();
        ed.event.zoomChanged.add(fn);
        off.push(() => { try { ed.event.zoomChanged.remove(fn); } catch (e) { /* detached */ } });
      }
      if (ed && ed.event && ed.event.selectionChange && typeof ed.event.selectionChange.add === 'function') {
        const fn = () => this.noteSelectionChange();
        ed.event.selectionChange.add(fn);
        off.push(() => { try { ed.event.selectionChange.remove(fn); } catch (e) { /* detached */ } });
      }
    } catch (e) { /* zoom/selection events optional. */ }
    if (app.controller && typeof app.controller.emitSelection === 'function') {
      const controller = app.controller;
      const original = controller.emitSelection.bind(controller);
      const self = this;
      controller.emitSelection = function () {
        self.noteSelectionChange();
        return original.apply(this, arguments);
      };
      off.push(() => { try { controller.emitSelection = original; } catch (e) { /* realm guard */ } });
    }
    this._observers = off;
  };

  NativeUIBridge.prototype.computeSelectionKey = function () {
    const app = this.app();
    const controller = app && app.controller;
    const documentController = app && app.documentController;
    const mechIds = Array.from((controller && controller.selection) || []).map(String).sort();
    const docIds = Array.from((documentController && documentController.selection) || []).map(String).sort();
    const mechKey = mechIds.join(',');
    const docKey = docIds.join(',');
    let ketcherKey = '';
    let historyKey = '';
    try {
      const ed = controller && controller.adapter && controller.adapter.ed;
      const sel = ed ? ed.selection() : null;
      if (sel && typeof sel === 'object') {
        const parts = [];
        for (const col of ['atoms', 'bonds', 'rxnArrows', 'rxnPluses', 'texts', 'simpleObjects', 'images', 'sgroupData']) {
          const arr = Array.isArray(sel[col]) ? sel[col].map(String).sort() : [];
          if (arr.length) parts.push(col + ':' + arr.join(','));
        }
        ketcherKey = parts.join(';');
      }
      if (ed && typeof ed.historySize === 'function') {
        const h = ed.historySize();
        if (h && (Number.isFinite(h.undo) || Number.isFinite(h.redo))) {
          historyKey = 'h:' + (h.undo || 0) + ':' + (h.redo || 0);
        }
      }
    } catch (e) { /* guarded */ }
    let detailKey = '';
    try {
      const details = [];
      if (mechIds.length && controller && controller.model) {
        const arrows = typeof controller.selectedArrows === 'function' ? controller.selectedArrows() : [];
        if (arrows.length) {
          details.push('arrows:' + JSON.stringify(arrows.map(a => ({
            id: a.id, e: a.electronCount, bend: a.geometry && a.geometry.bend,
            rv: a.geometry && a.geometry.routeVersion, mode: a.geometry && a.geometry.mode,
            s: a.source, t: a.target
          }))));
        }
        if (typeof controller.model.lonePair === 'function') {
          const lps = mechIds.map(id => controller.model.lonePair(id)).filter(Boolean);
          if (lps.length) details.push('lps:' + JSON.stringify(lps));
        }
      }
      if (docIds.length && documentController && typeof documentController.object === 'function') {
        const objs = docIds.map(id => documentController.object(id)).filter(Boolean);
        if (objs.length) details.push('doc:' + JSON.stringify(objs));
      }
      if (ketcherKey && controller && controller.adapter && typeof controller.adapter.struct === 'function') {
        const ed = controller.adapter.ed;
        const st = controller.adapter.struct();
        const sel = ed ? ed.selection() : null;
        if (st && sel) {
          const kDetail = {};
          if (Array.isArray(sel.atoms) && sel.atoms.length && st.atoms) {
            kDetail.atoms = sel.atoms.map(id => {
              const at = st.atoms.get ? st.atoms.get(id) : null;
              return at ? [id, at.label, at.charge, at.radical, at.explicitValence, at.pp && at.pp.x, at.pp && at.pp.y] : [id];
            });
          }
          if (Array.isArray(sel.bonds) && sel.bonds.length && st.bonds) {
            kDetail.bonds = sel.bonds.map(id => {
              const bd = st.bonds.get ? st.bonds.get(id) : null;
              return bd ? [id, bd.type, bd.stereo, bd.begin, bd.end] : [id];
            });
          }
          if (Object.keys(kDetail).length) details.push('k:' + JSON.stringify(kDetail));
        }
      }
      detailKey = details.join('&');
    } catch (e) { /* guarded */ }
    return `${mechKey}|${docKey}|${ketcherKey}|${historyKey}|${detailKey}`;
  };

  NativeUIBridge.prototype.noteSelectionChange = function () {
    const key = this.computeSelectionKey();
    if (key !== this.lastSelectionKey) {
      this.lastSelectionKey = key;
      this.selectionRevision += 1; // Membership or selected state/history change bumps selection.revision (hover/zoom never do).
    }
    this.selectionSnapshot = this.buildSelection(); // getState stays synchronous-fresh.
    this.markState();
  };

  NativeUIBridge.prototype.noteCommittedEdit = function () {
    // Committed property edit / undo / structure replacement invalidates the
    // captured selection revision without double-incrementing when observers already bumped it.
    const before = this.selectionRevision;
    this.noteSelectionChange();
    if (this.selectionRevision === before) {
      this.selectionRevision += 1;
      this.markState();
    }
  };

  NativeUIBridge.prototype.detach = function (epoch) {
    if (!this.attached || (epoch && !sameEpoch(this.epoch, epoch))) return { ok: false, error: { code: 'stale_epoch', message: 'epoch 与当前绑定不一致' } };
    this.attached = false;
    this.epoch = null;
    this.ownedSurfaces = [];
    this.commandReplies.clear();
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this.restoreWebSurfaces();
    this.removeMolecule3DDialogs();
    for (const fn of this._observers.splice(0)) { try { fn(); } catch (e) { /* already gone */ } }
    if (this._toolWatch) { this._toolWatch.restore(); this._toolWatch = null; }
    if (this.agentRenderer) { this.deactivateNativeAgent(); }
    return { ok: true };
  };

  /* ---------------- web surface ownership ---------------- */
  NativeUIBridge.prototype.hideWebSurfaces = function (owned) {
    const hide = (el, doc) => {
      if (!el || el.dataset.nativeOwned === '1') return;
      el.dataset.nativeOwned = '1';
      this._hidden.push({ doc, el, prev: el.style.display });
      el.style.display = 'none';
    };
    // In first-frame canvas mode the parse-time stylesheet is authoritative;
    // still mark every legacy root as native-owned so no later code (including
    // a stale detach from an older epoch) can treat it as an available surface.
    if (nativeCanvasMode()) {
      const top = this.doc;
      if (top) {
        for (const id of ['helpBtn', 'toast', 'mech-sel-bar', 'molstudio-document-toolbar',
          'molstudio-document-panel', 'molstudio-document-status', 'molstudio-document-pages']) {
          const el = top.getElementById && top.getElementById(id);
          if (el) hide(el, top);
        }
        top.querySelectorAll('[data-document-ui], .mol-agent-panel, .mol-agent-toggle').forEach(el => hide(el, top));
      }
      const app = this.app();
      const iframeDoc = app && app.adapter && app.adapter.doc;
      if (iframeDoc) {
        iframeDoc.querySelectorAll('[data-testid="top-toolbar"],[data-testid="left-toolbar"],[data-testid="right-toolbar"],[data-testid="bottom-toolbar"],[data-mech-tool],[data-mech-actions]')
          .forEach(el => hide(el.parentElement && el.hasAttribute('data-mech-tool') ? el.parentElement : el, iframeDoc));
      }
      return;
    }
    const topDoc = this.doc;
    const app = this.app();
    const iframeDoc = app.adapter && app.adapter.doc;
    // Ketcher's complete toolbars remain available through the native
    // "高级化学工具" switch; only hide them after the corresponding native
    // surfaces have actually attached successfully.
    if (iframeDoc && owned.includes('fileCommands') && owned.includes('toolPalette') && owned.includes('inspector')) {
      iframeDoc.querySelectorAll('[data-testid="top-toolbar"]').forEach(el => hide(el, iframeDoc));
    }
    if (iframeDoc && owned.includes('toolPalette') && owned.includes('inspector')) {
      ['left-toolbar', 'right-toolbar', 'bottom-toolbar'].forEach(id =>
        iframeDoc.querySelectorAll(`[data-testid="${id}"]`).forEach(el => hide(el, iframeDoc)));
    }
    if (owned.includes('toolPalette')) {
      if (iframeDoc) {
        iframeDoc.querySelectorAll('[data-mech-tool]').forEach(el => hide(el.parentElement || el, iframeDoc));
        // The automatic lone-pair visibility toggle still belongs to the
        // editor; retain its action group until the native UI exposes it.
      }
      // Keep #molstudio-document-toolbar visible: its document-layer tools
      // (text box, image insert, rect/roundRect/ellipse/line/arrow/polygon/bracket)
      // call documentController.setTool / pickImage and have no complete native replacement yet.
    }
    if (owned.includes('fileCommands')) {
      if (iframeDoc) {
        iframeDoc.querySelectorAll('[data-mech-action="export-svg"],[data-mech-action="export-png"]').forEach(el => hide(el, iframeDoc));
      }
    }
    if (owned.includes('inspector')) {
      hide(topDoc.getElementById('mech-sel-bar'), topDoc);
      // Keep #molstudio-document-panel (hidden by default unless opened from 页面/属性)
      // so rich text, shape stroke/fill, image crop/replace, and import-file remain usable.
      hide(topDoc.getElementById('molstudio-document-status'), topDoc);
    }
    // zoomPalette: the web zoom overlay belongs to canvas.html's zoom wheel UI;
    // element ids are not stable across pages, so ownership only claims elements
    // explicitly tagged `data-native-surface="zoomPalette"`.
    if (owned.includes('zoomPalette')) {
      topDoc.querySelectorAll('[data-native-surface="zoomPalette"]').forEach(el => hide(el, topDoc));
    }
  };

  /* Legacy web toolbars are retired in the native host. This entry point is
   * kept only so an older host build cannot unhide them; it always reports
   * failure and never changes ownership. Browser mode is unaffected. */
  NativeUIBridge.prototype.setAdvancedWebTools = function (visible) {
    if (nativeCanvasMode()) return false;
    if (!this.attached) return false;
    this.restoreWebSurfaces();
    if (!visible) this.hideWebSurfaces(this.ownedSurfaces);
    return true;
  };

  NativeUIBridge.prototype.restoreWebSurfaces = function () {
    if (nativeCanvasMode()) {
      // Detach must not reveal legacy surfaces in a native host. Discard the
      // recorded inline-style changes: the parse-time !important rule remains
      // the single authority, so a late callback cannot resurrect them.
      this._hidden.splice(0);
      return;
    }
    for (const rec of this._hidden.splice(0)) {
      rec.el.style.display = rec.prev;
      delete rec.el.dataset.nativeOwned;
    }
    const docToolbar = this.doc && this.doc.getElementById && this.doc.getElementById('molstudio-document-toolbar');
    if (docToolbar && docToolbar.style) {
      docToolbar.style.top = '';
      docToolbar.style.left = '';
    }
  };

  /* ---------------- native AI renderer lifecycle ---------------- */
  NativeUIBridge.prototype.activateNativeAgent = function () {
    const agentAPI = this.agentAPI();
    if (!agentAPI || typeof agentAPI.useNativeRenderer !== 'function') return;
    if (!this.agentRenderer) {
      this.agentRenderer = new root.MolStudioAgentNativeRenderer({
        publish: payload => {
          if (this._suppressAgentPublish) return;
          this.publishAgent(payload);
        },
        hostContext: () => ({ windowKey: this.hostContext.windowKey, focusOwner: this.hostContext.focusOwner }),
        onStateChange: () => this.markState()
      });
    }
    this.agentRenderer.disposed = false;
    agentAPI.useNativeRenderer(this.agentRenderer);
  };

  NativeUIBridge.prototype.deactivateNativeAgent = function () {
    const agentAPI = this.agentAPI();
    if (this.agentRenderer) { this.agentRenderer.disposed = true; }
    if (agentAPI && typeof agentAPI.restoreBrowserRenderer === 'function') agentAPI.restoreBrowserRenderer();
  };

  /* ---------------- dispatch ---------------- */
  NativeUIBridge.prototype.dispatch = async function (command) {
    const fail = (code, message) => ({
      protocol: PROTOCOL, epoch: command && command.epoch ? { ...command.epoch } : null,
      requestId: command && command.requestId, ok: false, error: { code, message }, stateRevision: this.revision
    });
    if (!command || typeof command !== 'object') return fail('invalid_arguments', 'command 缺失');
    if (command.protocol !== PROTOCOL) return fail('invalid_arguments', 'protocol 必须为 1');
    if (!this.attached) return fail('stale_epoch', 'nativeUI 未绑定');
    if (!sameEpoch(command.epoch, this.epoch)) return fail('stale_epoch', 'epoch 已失效');
    if (typeof command.requestId !== 'string' || !command.requestId) return fail('invalid_arguments', 'requestId 缺失');
    if (typeof command.id !== 'string' || !command.id) return fail('invalid_arguments', 'id 缺失');
    // Idempotency: same requestId within the bound epoch returns the cached or
    // in-flight reply and never re-applies a mutation or collides across epochs.
    const boundEpoch = { navigationGeneration: this.epoch.navigationGeneration, pageId: this.epoch.pageId };
    const isCurrentEpoch = () => this.attached && sameEpoch(this.epoch, boundEpoch);
    const dedupKey = epochKey(boundEpoch) + '\0' + command.requestId;
    if (this.pendingCommands.has(dedupKey)) return this.pendingCommands.get(dedupKey);
    if (this.commandReplies.has(dedupKey)) return this.commandReplies.get(dedupKey);
    const execution = this.executeCommand(command, boundEpoch);
    this.pendingCommands.set(dedupKey, execution);
    let reply;
    try { reply = await execution; } finally { this.pendingCommands.delete(dedupKey); }
    if (isCurrentEpoch() && (reply.ok || reply.error.code !== 'stale_epoch')) {
      this.commandReplies.set(dedupKey, reply);
      if (this.commandReplies.size > 256) this.commandReplies.delete(this.commandReplies.keys().next().value);
    }
    return reply;
  };

  NativeUIBridge.prototype.checkSelectionStale = function (command) {
    if (command.expectedSelectionRevision === undefined || command.expectedSelectionRevision === null) return 'missing';
    if (command.expectedSelectionRevision !== this.selectionRevision) return 'stale';
    return 'ok';
  };

  NativeUIBridge.prototype.stopForManualEdit = function () {
    const agentAPI = this.agentAPI();
    if (agentAPI && typeof agentAPI.stop === 'function') {
      try { agentAPI.stop('manual_edit'); } catch (e) { /* Runtime not started yet. */ }
    }
  };

  NativeUIBridge.prototype.executeCommand = async function (command, boundEpoch) {
    const epochSnapshot = boundEpoch
      ? { navigationGeneration: boundEpoch.navigationGeneration, pageId: boundEpoch.pageId }
      : (this.epoch ? { navigationGeneration: this.epoch.navigationGeneration, pageId: this.epoch.pageId } : null);
    const isCurrentEpoch = () => this.attached && sameEpoch(this.epoch, epochSnapshot);
    const reply = (ok, extra) => ({
      protocol: PROTOCOL, epoch: epochSnapshot ? { ...epochSnapshot } : null, requestId: command.requestId, ok,
      ...(ok ? {} : { error: (extra && extra.error) || { code: 'failed', message: (extra && extra.message) || '命令失败' } }),
      ...(ok && extra && extra.result ? { result: extra.result } : {}),
      stateRevision: this.revision
    });
    if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
    const id = command.id;
    const args = command.args || {};
    const app = this.app();
    const controller = app && app.controller;
    const documentController = app && app.documentController;
    const needsSelection = ['selection.setProperty', 'selection.replan', 'selection.toggleBondComponent'].includes(id);
    if (needsSelection) {
      const check = this.checkSelectionStale(command);
      if (check === 'missing') return reply(false, { error: { code: 'invalid_arguments', message: '该命令必须携带 expectedSelectionRevision' } });
      if (check === 'stale') return reply(false, { error: { code: 'stale_selection', message: '选区已变化，请重新读取 state' } });
    }

    try {
      switch (id) {
        case 'host.context': {
          const viewport = args.viewport;
          if (viewport !== undefined) {
            if (!viewport || typeof viewport !== 'object' || !Number.isFinite(viewport.layoutRevision)
              || !viewport.cssSize || !viewport.safeAreaInsets || !Array.isArray(viewport.overlays || [])) {
              return reply(false, { error: { code: 'invalid_arguments', message: 'viewport 形状不符合契约' } });
            }
            if (!this.hostViewport || viewport.layoutRevision > this.hostViewport.layoutRevision) {
              this.hostViewport = viewport;
              const vp = this.viewport();
              if (vp && typeof vp.setHostViewport === 'function') vp.setHostViewport(viewport);
              const docToolbar = this.doc && this.doc.getElementById && this.doc.getElementById('molstudio-document-toolbar');
              if (docToolbar && docToolbar.style) {
                const safeTop = Math.max(48, Math.ceil(Number(viewport.safeAreaInsets.top || 0) + 8));
                docToolbar.style.top = safeTop + 'px';
                const toolOv = Array.isArray(viewport.overlays) ? viewport.overlays.find(o => o && o.id === 'toolPalette') : null;
                if (toolOv && Number.isFinite(toolOv.y) && Number.isFinite(toolOv.width) && toolOv.y < safeTop + 44) {
                  docToolbar.style.left = Math.max(56, Math.ceil((toolOv.x || 0) + toolOv.width + 12)) + 'px';
                } else {
                  docToolbar.style.left = '';
                }
              }
              const paper = documentController;
              if (paper?.active && paper.state?.mode === 'paper') {
                if (paper.paperFitMode) paper.fit(paper.paperFitMode);
                else { paper.clampPaperViewport(); paper.render(); paper.emit(); }
              }
              this.markState();
            }
          }
          if (args.windowKey !== undefined) this.hostContext.windowKey = !!args.windowKey;
          if (args.focusOwner !== undefined) this.hostContext.focusOwner = typeof args.focusOwner === 'string' ? args.focusOwner : this.hostContext.focusOwner;
          if (args.inspectorVisible !== undefined) this.hostContext.inspectorVisible = !!args.inspectorVisible;
          this.markState();
          return reply(true, { result: { appliedHostLayoutRevision: this.hostViewport ? this.hostViewport.layoutRevision : 0 } });
        }
        case 'tool.set': {
          const result = this.applyTool(args && args.id);
          return result === true ? reply(true) : reply(false, result);
        }
        case 'template.set': {
          const result = this.applyTemplate(args && args.id);
          return result === true ? reply(true) : reply(false, result);
        }
        case 'element.set': {
          const symbol = args && args.symbol;
          if (typeof symbol !== 'string' || !ELEMENTS.has(symbol)) {
            return reply(false, { error: { code: 'unsupported', message: '未验证的元素符号：' + symbol } });
          }
          const ed = app.adapter.ed;
          const controller = app.controller;
          const documentController = app.documentController;
          if (controller && controller.tool && controller.tool !== 'select') controller.setTool('select');
          if (documentController && documentController.tool && documentController.tool !== 'select') {
            documentController.tool = 'select';
            documentController.emit();
          }
          this.stopForManualEdit();
          const switched = ed.tool('atom', { label: symbol }); // Verified: hotkey map uses {tool:'atom',opts:{label:F}}.
          if (!switched) {
            // Ketcher's AtomTool applies an immediate label replacement and returns
            // null when atom(s) are already selected, keeping the active tool unchanged.
            this.noteCommittedEdit();
          } else {
            this.markState();
          }
          return reply(true);
        }
        case 'zoom.by': {
          const factor = args && args.factor;
          if (!Number.isFinite(factor) || factor <= 0) return reply(false, { error: { code: 'invalid_arguments', message: 'factor 无效' } });
          const vp = this.viewport();
          const ok = vp.zoomBy(factor, args.anchor ? { x: args.anchor.x, y: args.anchor.y } : undefined);
          return ok ? reply(true) : reply(false, { error: { code: 'failed', message: '锚点不在可见画布上' } });
        }
        case 'zoom.toPercent': {
          const percent = args && args.percent;
          if (!Number.isFinite(percent)) return reply(false, { error: { code: 'invalid_arguments', message: 'percent 无效' } });
          const paper = documentController && documentController.active && documentController.state.mode === 'paper';
          if (!paper) return reply(false, { error: { code: 'unsupported', message: '普通画布尚未核实绝对印刷百分比' } });
          documentController.setPaperZoom(percent);
          this.markState();
          return reply(true);
        }
        case 'zoom.fit': {
          const target = args && args.target;
          const paper = documentController && documentController.active && documentController.state.mode === 'paper';
          if (paper && (target === 'page' || target === 'width')) {
            if (target === 'page') documentController.fitPage(); else documentController.fitWidth();
            this.markState();
            return reply(true);
          }
          return reply(false, { error: { code: 'unsupported', message: '该 fit 目标尚未实现' } });
        }
        case 'edit.undo': case 'edit.redo': case 'edit.selectAll': case 'edit.delete': {
          if (this.hostContext.focusOwner !== 'canvas') {
            return reply(false, { error: { code: 'failed', message: '当前焦点由原生文本持有，编辑命令应由 AppKit responder 处理' } });
          }
          if (id === 'edit.undo') { this.stopForManualEdit(); root.k3dAPI.undo(); }
          else if (id === 'edit.redo') { this.stopForManualEdit(); root.k3dAPI.redo(); }
          else if (id === 'edit.selectAll') { root.k3dAPI.selectAll(); }
          else { this.stopForManualEdit(); root.k3dAPI.deleteSel(); }
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'selection.setProperty': {
          const result = await this.applySelectionProperty(args, command);
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          return result === true ? reply(true, { result: { selectionRevision: this.selectionRevision } }) : reply(false, result);
        }
        case 'selection.replan': {
          const app2 = this.app();
          const arrows = app2.controller.selectedArrows();
          if (!arrows.length) return reply(false, { error: { code: 'unsupported', message: '重新排布只对机理弯箭头启用' } });
          this.stopForManualEdit();
          app2.controller.replanSelection();
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'selection.toggleBondComponent': {
          const app3 = this.app();
          const arrows = app3.controller.selectedArrows();
          const single = arrows.length === 1 && ['source', 'target'].some(s => arrows[0][s] && arrows[0][s].type === 'bond');
          if (!single) return reply(false, { error: { code: 'unsupported', message: '只在单个带键端点的弯箭头上启用' } });
          this.stopForManualEdit();
          app3.controller.toggleBondComponent();
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'agent.send': {
          const agentAPI = this.agentAPI();
          const text = args && args.text;
          if (typeof text !== 'string' || !text.trim()) return reply(false, { error: { code: 'invalid_arguments', message: 'text 不能为空' } });
          if (agentAPI && agentAPI.isRunning && agentAPI.isRunning()) {
            return reply(false, { error: { code: 'busy', message: '正在执行中' } });
          }
          agentAPI.send(text); // Accepts and returns fast; completion arrives via events.
          this.markState();
          return reply(true, { result: { accepted: true } });
        }
        case 'agent.stop': {
          this.agentAPI().stop('user');
          this.markState();
          return reply(true);
        }
        case 'agent.continue': {
          const agentAPI = this.agentAPI();
          if (!this.isAgentContinuable(agentAPI) || (agentAPI.isRunning && agentAPI.isRunning())) {
            return reply(false, { error: { code: 'busy', message: '当前没有可继续的任务' } });
          }
          agentAPI.continue();
          this.markState();
          return reply(true, { result: { accepted: true } });
        }
        case 'agent.reset': {
          const agentAPI = this.agentAPI();
          if (agentAPI.isRunning()) return reply(false, { error: { code: 'busy', message: '正在执行中，沿用产品的禁止重置策略' } });
          this.canContinue = false;
          agentAPI.reset();
          this.markState();
          return reply(true);
        }
        case 'agent.settings.load': {
          const agentAPI = this.agentAPI();
          const config = await agentAPI.loadSettings();
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          return reply(true, { result: { config: publicConfig(config) } });
        }
        case 'agent.settings.save': {
          const agentAPI = this.agentAPI();
          const values = {
            provider: 'openai-compatible',
            model: String(args.model || '').trim(),
            baseUrl: String(args.baseUrl || '').trim(),
            generation: args.generation || undefined
          };
          // apiKey is a transient argument: forwarded once, never stored in
          // state, never echoed back, never logged.
          if (typeof args.apiKey === 'string' && args.apiKey) values.apiKey = args.apiKey;
          const result = await agentAPI.saveSettings(values);
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          return reply(true, { result: { config: publicConfig(result && result.config ? result.config : result) } });
        }
        /* ---------------- document layer (real native parity) ----------------
         * Every command below calls the existing document controller methods.
         * No hidden web button is clicked, no toolbar is revealed, and each
         * mutation goes through the controller's single-undo commit path. */
        case 'document.state': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const state = dc.getState();
          const page = state.page || {};
          const margins = page.margins || {};
          const ids = Array.from(dc.selection || []);
          const selected = ids.map(i => dc.object(i)).filter(Boolean);
          return reply(true, { result: {
            active: !!dc.active, mode: state.mode, tool: dc.tool,
            pageCount: state.pages ? state.pages.length : (state.pageCount || 1),
            size: page.size || null, orientation: page.orientation || null,
            marginMm: Number.isFinite(margins.top) ? Number((margins.top * 25.4 / 72).toFixed(1)) : null,
            selectedId: selected.length === 1 ? selected[0].id : null,
            selectedKind: selected.length === 1 ? selected[0].kind : null
          } });
        }
        case 'document.tool': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const tool = args && args.id;
          if (typeof tool !== 'string' || !DOCUMENT_TOOLS.has(tool)) {
            return reply(false, { error: { code: 'unsupported', message: '未验证的文档工具：' + tool } });
          }
          if (tool === 'image') {
            // Real native image insertion: the host reads bytes and passes a
            // data URL; there is no hidden <input type=file> or web toolbar.
            return reply(false, { error: { code: 'invalid_arguments', message: '图片请使用 document.addImage' } });
          }
          this.stopForManualEdit();
          dc.setTool(tool);           // real controller tool; canvas drag creates the object
          this.markState();
          return reply(true);
        }
        case 'document.insert3d': {
          const dc = documentController;
          if (!dc || typeof dc.insertMolecule3DPreview !== 'function') {
            return reply(false, { error: { code: 'not_ready', message: '3D 分子预览层尚未就绪' } });
          }
          this.stopForManualEdit();
          const result = await this.runInsertMolecule3D();
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          if (!result || result.ok !== true) {
            if (result && result.cancelled) return reply(true, { result: { cancelled: true } });
            return reply(false, { error: { code: 'failed', message: (result && result.error) || '插入 3D 分子预览失败' } });
          }
          return reply(true, { result: { id: result.id } });
        }
        case 'document.addImage': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const dataUrl = args && args.dataUrl;
          if (typeof dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(dataUrl)) {
            return reply(false, { error: { code: 'invalid_arguments', message: '仅支持 PNG / JPEG / WebP / GIF 图片数据' } });
          }
          const point = args.point && Number.isFinite(args.point.x) && Number.isFinite(args.point.y)
            ? { x: Number(args.point.x), y: Number(args.point.y) } : { x: 4, y: 4 };
          this.stopForManualEdit();
          const id = await dc.addImage({ dataUrl, ...point, replaceId: args.replaceId,
            w: Number(args.w) || 12, h: Number(args.h) || 8 });
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          this.noteCommittedEdit();
          return reply(true, { result: { id } });
        }
        case 'document.addText': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const text = args && args.text;
          if (typeof text !== 'string' || !text.trim()) return reply(false, { error: { code: 'invalid_arguments', message: 'text 不能为空' } });
          const point = args.point && Number.isFinite(args.point.x) && Number.isFinite(args.point.y)
            ? { x: Number(args.point.x), y: Number(args.point.y) } : { x: 4, y: 4 };
          this.stopForManualEdit();
          const id = dc.addText({ text, ...point, ...(args.rich && typeof args.rich === 'object' ? { rich: args.rich } : {}) });
          this.noteCommittedEdit();
          return reply(true, { result: { id } });
        }
        case 'document.addShape': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const shape = args && args.shape;
          const shapes = { 'document.bracket': 'bracket', 'document.arrow': 'arrow',
            'document.polygon': 'polygon', 'document.roundRect': 'roundRect',
            'shape.rect': 'rect', 'shape.ellipse': 'ellipse', 'shape.line': 'line' };
          if (typeof shape !== 'string' || !shapes[shape]) {
            return reply(false, { error: { code: 'unsupported', message: '未验证的形状：' + shape } });
          }
          const point = args.point && Number.isFinite(args.point.x) && Number.isFinite(args.point.y)
            ? { x: Number(args.point.x), y: Number(args.point.y) } : { x: 4, y: 4 };
          const w = Number.isFinite(args.w) ? Number(args.w) : 8, h = Number.isFinite(args.h) ? Number(args.h) : 5;
          this.stopForManualEdit();
          const id = dc.addShape({ shape: shapes[shape], ...point, w, h,
            ...(args.fill && typeof args.fill === 'string' ? { fill: args.fill } : {}),
            ...(args.stroke && typeof args.stroke === 'object' ? { stroke: args.stroke } : {}) });
          this.noteCommittedEdit();
          return reply(true, { result: { id } });
        }
        case 'document.object.update': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const objectId = args && args.objectId;
          const patch = args && args.patch;
          if (typeof objectId !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return reply(false, { error: { code: 'invalid_arguments', message: 'objectId / patch 无效' } });
          }
          if (command.expectedSelectionRevision !== undefined && command.expectedSelectionRevision !== null) {
            const check = this.checkSelectionStale(command);
            if (check === 'stale') return reply(false, { error: { code: 'stale_selection', message: '选区已变化，请重新读取 state' } });
          }
          // Only verified, bounded fields: never accept id/kind/asset or raw HTML.
          const allowed = {};
          for (const key of ['x','y','w','h','rotation','band','crop','rich','stroke','fill','line']) {
            if (patch[key] === undefined) continue;
            const v = patch[key];
            if (typeof v === 'number' && !Number.isFinite(v)) continue;
            if (typeof v === 'string' && v.length > 4096) continue;
            if (v && typeof v === 'object' && !(key === 'rich' || key === 'stroke' || key === 'crop' || key === 'line')) continue;
            allowed[key] = v;
          }
          if (!Object.keys(allowed).length) return reply(false, { error: { code: 'invalid_arguments', message: '没有可写字段' } });
          this.stopForManualEdit();
          const ok = dc.updateObject(objectId, allowed);
          if (!ok) return reply(false, { error: { code: 'stale_selection', message: '对象已不存在' } });
          this.noteCommittedEdit();
          return reply(true, { result: { selectionRevision: this.selectionRevision } });
        }
        case 'document.object.duplicate': {
          const dc = documentController;
          if (!dc || !dc.selection || !dc.selection.size) return reply(false, { error: { code: 'invalid_arguments', message: '请先选择文档对象' } });
          this.stopForManualEdit();
          const ids = dc.duplicateSelection();
          this.noteCommittedEdit();
          return reply(true, { result: { ids } });
        }
        case 'document.object.delete': {
          const dc = documentController;
          if (!dc || !dc.selection || !dc.selection.size) return reply(false, { error: { code: 'invalid_arguments', message: '请先选择文档对象' } });
          this.stopForManualEdit();
          dc.deleteSelection();
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'document.object.editText': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          // An omitted/empty objectId resolves to the current single selection,
          // so a native popover never has to guess an id from a label.
          const ids = Array.from(dc.selection || []);
          const objectId = (args && args.objectId) || (ids.length === 1 ? ids[0] : null);
          const o = objectId ? dc.object(objectId) : null;
          if (!o || o.kind !== 'text') return reply(false, { error: { code: 'invalid_arguments', message: '所选对象不是文字框' } });
          dc.editText(objectId);
          return reply(true);
        }
        case 'document.page.setup': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const setup = {};
          const mode = args && args.mode;
          if (mode === 'paper' || mode === 'canvas') setup.mode = mode;
          const size = args && args.size;
          if (size === 'A4' || size === 'Letter') setup.size = size;
          const orientation = args && args.orientation;
          if (orientation === 'portrait' || orientation === 'landscape') setup.orientation = orientation;
          if (Number.isFinite(args.marginMm)) {
            const pt = Math.max(0, Math.min(200, Number(args.marginMm))) * 72 / 25.4;
            setup.margins = { top: pt, right: pt, bottom: pt, left: pt };
          } else if (args.margins && typeof args.margins === 'object') {
            // Real per-edge margins in points (document-model units).
            const out = {};
            for (const key of ['top', 'right', 'bottom', 'left']) {
              const v = Number(args.margins[key]);
              if (Number.isFinite(v)) out[key] = Math.max(0, Math.min(400, v));
            }
            if (Object.keys(out).length === 4) setup.margins = out;
          }
          this.stopForManualEdit();
          if (mode === 'canvas' && !dc.active) dc.init({ mode: 'canvas' });
          else dc.setPageSetup(setup);
          if (setup.mode === 'paper' || (dc.active && dc.state.mode === 'paper')) dc.fitPage();
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'document.page.add': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          this.stopForManualEdit();
          const id = dc.addPage();
          this.noteCommittedEdit();
          return reply(true, { result: { id } });
        }
        case 'document.page.removeLastBlank': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const pages = dc.state && dc.state.pages;
          if (!pages || pages.length < 2) return reply(false, { error: { code: 'failed', message: '仅有单页，未删除' } });
          this.stopForManualEdit();
          dc.removePage(pages[pages.length - 1].id);
          this.noteCommittedEdit();
          return reply(true);
        }
        case 'document.importFile': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const text = args && args.text;
          if (typeof text !== 'string' || !text.trim()) return reply(false, { error: { code: 'invalid_arguments', message: '文件内容为空' } });
          const name = typeof args.name === 'string' ? args.name.slice(0, 200) : '插入文件';
          this.stopForManualEdit();
          const result = await dc.importFile(text, { name });
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          if (!result || result.ok !== true) {
            return reply(false, { error: { code: 'failed', message: (result && result.error) || '插入失败' } });
          }
          this.noteCommittedEdit();
          return reply(true, { result: { staged: !!result.staged, counts: result.counts || null } });
        }
        case 'document.exportPages': {
          const dc = documentController;
          if (!dc) return reply(false, { error: { code: 'not_ready', message: '文档层尚未就绪' } });
          const pageIds = Array.isArray(args.pageIds) ? args.pageIds.filter(x => typeof x === 'string') : undefined;
          const result = await dc.exportPages(pageIds);
          if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
          if (!result || result.ok !== true) return reply(false, { error: { code: 'failed', message: (result && result.error) || '导出失败' } });
          return reply(true, { result: { pages: result.pages, warnings: result.warnings || [] } });
        }
        default:
          return reply(false, { error: { code: 'unsupported', message: '未知命令：' + id } });
      }
    } catch (error) {
      if (!isCurrentEpoch()) return reply(false, { error: { code: 'stale_epoch', message: 'epoch 已失效' } });
      return reply(false, { error: { code: 'failed', message: (error && error.message) || String(error) } });
    }
  };

  NativeUIBridge.prototype.applyTool = function (productId) {
    const app = this.app();
    const ed = app.adapter.ed;
    const controller = app.controller;
    const documentController = app.documentController;
    const resetSemanticTools = () => {
      if (controller.tool !== 'select') controller.setTool('select');
      if (documentController && documentController.tool && documentController.tool !== 'select') {
        if (typeof documentController.setTool === 'function') documentController.setTool('select');
        else { documentController.tool = 'select'; documentController.emit(); }
      }
    };
    if (productId === 'select') { resetSemanticTools(); ed.tool('select'); this.markState(); return true; }
    if (productId === 'lasso') { resetSemanticTools(); ed.tool('select', 'lasso'); this.markState(); return true; }
    if (productId === 'select.structure') { resetSemanticTools(); ed.tool('select', 'fragment'); this.markState(); return true; }
    if (productId === 'select.fragment') { resetSemanticTools(); ed.tool('fragmentSelection'); this.markState(); return true; }
    if (productId === 'hand') { resetSemanticTools(); ed.tool('hand'); this.markState(); return true; }
    if (productId === 'erase') { resetSemanticTools(); ed.tool('eraser'); this.markState(); return true; }
    if (productId === 'chain') { resetSemanticTools(); ed.tool('chain'); this.markState(); return true; }
    if (productId === 'chargePlus' || productId === 'chargeMinus') {
      resetSemanticTools(); ed.tool('charge', productId === 'chargePlus' ? 1 : -1); this.markState(); return true;
    }
    if (productId === 'reactionPlus') { resetSemanticTools(); ed.tool('reactionplus'); this.markState(); return true; }
    if (productId === 'radical') {
      // Persistent tool (choose-function-first): each canvas click on an atom
      // toggles its radical mark through the mechanism controller's single
      // undo commit. No selection required, no modal error.
      if (!controller || typeof controller.setTool !== 'function') return { error: { code: 'not_ready', message: '机理层未就绪' } };
      resetSemanticTools();
      controller.setTool('radical');
      this.markState();
      return true;
    }
    if (productId === 'text') { resetSemanticTools(); ed.tool('text'); this.markState(); return true; }
    if (BOND_OPTS[productId]) { resetSemanticTools(); ed.tool('bond', { ...BOND_OPTS[productId] }); this.markState(); return true; }
    if (ARROW_MODES[productId]) { resetSemanticTools(); ed.tool('reactionarrow', ARROW_MODES[productId]); this.markState(); return true; }
    if (SHAPE_MODES[productId]) {
      const shapeTools = { 'shape.rect': 'rect', 'shape.ellipse': 'ellipse', 'shape.line': 'line' };
      if (!documentController || typeof documentController.setTool !== 'function') return { error: { code: 'not_ready', message: '文档形状层尚未就绪' } };
      resetSemanticTools();
      this.stopForManualEdit();
      if (typeof documentController.select === 'function') documentController.select([]);
      documentController.setTool(shapeTools[productId]);
      this.markState();
      return true;
    }
    if (productId === 'ketcher.image') {
      // Real Ketcher image tool (IMAGE_KEY = 'images'); the native host reads
      // the file bytes itself. No hidden web toolbar button is simulated.
      resetSemanticTools(); ed.tool(IMAGE_TOOL); this.markState(); return true;
    }
    if (productId === 'document.image') {
      // Document image insertion is host-driven: Swift shows an NSOpenPanel,
      // then dispatches document.addImage with the bytes. There is no web
      // <input type=file> and no web-toolbar fallback.
      return { error: { code: 'invalid_arguments', message: '图片请使用 document.addImage' } };
    }
    if (productId === 'insert.view3d') {
      // 3D molecule preview is not a persistent canvas tool: the click keeps
      // the current tool and triggers an async insertion (candidate picking
      // and stereo confirmation may open dialogs). The synchronous applyTool
      // contract cannot await a reply, so the insert runs through the shared
      // document.insert3d path; failures surface as canvas status text.
      const dc = documentController;
      if (!dc || typeof dc.insertMolecule3DPreview !== 'function') {
        return { error: { code: 'not_ready', message: '3D 分子预览层尚未就绪' } };
      }
      if (controller && controller.tool && controller.tool !== 'select') controller.setTool('select');
      Promise.resolve(this.runInsertMolecule3D()).catch(() => { /* status already shown */ });
      return true;
    }
    if (typeof productId === 'string' && productId.startsWith('document.')) {
      // Document-layer drawing tools are real drag tools on the same canvas.
      const map = {
        'document.text': 'text',
        'document.bracket': 'bracket', 'document.arrow': 'arrow', 'document.polygon': 'polygon',
        'document.roundRect': 'roundRect'
      };
      const tool = map[productId];
      if (!tool || !documentController || typeof documentController.setTool !== 'function') {
        return { error: { code: 'unsupported', message: '未验证的文档工具 ID：' + productId } };
      }
      if (controller.tool !== 'select') controller.setTool('select');
      this.stopForManualEdit();
      if (tool !== 'text' && typeof documentController.select === 'function') documentController.select([]);
      documentController.setTool(tool);
      this.markState();
      return true;
    }
    if (productId === 'electronPairArrow' || productId === 'fishhookArrow' || productId === 'lonePair') {
      // Verified semantic layer entry point (main.js installAPI).
      const mech = productId === 'electronPairArrow' ? 'arrow2' : productId === 'fishhookArrow' ? 'arrow1' : 'lonePair';
      resetSemanticTools();
      root.k3dAPI.setMechanismTool(mech);
      this.markState();
      return true;
    }
    if (productId === 'template.set' || typeof productId === 'string' && productId.startsWith('template.')) {
      return { error: { code: 'unsupported', message: '未验证的模板工具 ID：' + productId } };
    }
    return { error: { code: 'unsupported', message: '未验证的工具 ID：' + productId } };
  };

  NativeUIBridge.prototype.applyTemplate = function (templateId) {
    if (typeof templateId !== 'string' || !templateId) {
      return { error: { code: 'invalid_arguments', message: 'template.set 缺少 id' } };
    }
    const entries = this.templateRegistry();
    const match = entries.find(entry => entry.productId === templateId || entry.rawId === templateId);
    if (!match) {
      return { error: { code: 'unsupported', message: '未验证的模板 ID：' + templateId } };
    }
    const app = this.app();
    const ed = app.adapter.ed;
    const controller = app.controller;
    const documentController = app.documentController;
    if (controller.tool !== 'select') controller.setTool('select');
    if (documentController && documentController.tool && documentController.tool !== 'select') {
      documentController.tool = 'select';
      documentController.emit();
    }
    ed.tool('template', { struct: match.struct });
    this.markState();
    return true;
  };

  /* Shared async 3D preview insertion. Returns the raw controller result;
   * command replies wrap it, the fire-and-forget tool path surfaces failures
   * via the canvas status text. */
  NativeUIBridge.prototype.runInsertMolecule3D = async function () {
    const app = this.app();
    const dc = app && app.documentController;
    if (!dc || typeof dc.insertMolecule3DPreview !== 'function') {
      const message = '3D 分子预览层尚未就绪';
      if (app && app.controller && typeof app.controller.status === 'function') app.controller.status(message);
      return { ok: false, error: message };
    }
    let result = null;
    try {
      result = await dc.insertMolecule3DPreview({});
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    if (!result || result.ok !== true) {
      if (result && result.cancelled) return result; // user declined: not an error
      const message = (result && result.error) || '插入 3D 分子预览失败';
      if (app.controller && typeof app.controller.status === 'function') app.controller.status(message);
      return result || { ok: false, error: message };
    }
    this.noteCommittedEdit();
    return result;
  };

  /* Native attach-only dialog hooks for the 3D preview core layer. WKWebView
   * implements window.confirm/prompt via WKUIDelegate, so they are the honest
   * fallback: single candidate asks yes/no, multiple candidates ask for an
   * ordinal via prompt (throwing a Chinese error when prompt is unavailable,
   * e.g. when the host has not implemented the UI delegate). */
  NativeUIBridge.prototype.installMolecule3DDialogs = function () {
    const app = this.app();
    const dc = app && app.documentController;
    if (!dc) return;
    if (this._molecule3DDialogs && this._molecule3DDialogs.dc === dc) return; // already installed on this controller
    this.removeMolecule3DDialogs();
    const describe = (c, i) => '分子 ' + (i + 1) + '（' + (Number(c && (c.size ?? c.atomCount)) || 0) + ' 个原子）';
    const chooseTarget = async (candidates) => {
      const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
      if (!list.length) return null;
      if (list.length === 1) {
        const ok = root.confirm('插入 3D 分子预览？\n' + describe(list[0], 0) + '\n将使用示例构型。');
        return ok ? list[0] : null;
      }
      if (typeof root.prompt !== 'function') {
        throw new Error('请在画布中仅选择一个分子后重试');
      }
      const names = list.map((c, i) => describe(c, i)).join('\n');
      const raw = root.prompt('画布中有多个分子，请输入序号选择要插入 3D 分子预览的分子：\n' + names);
      if (raw == null) return null;
      const idx = Number(String(raw).trim()) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
        throw new Error('请在画布中仅选择一个分子后重试（或输入 1 到 ' + list.length + ' 的序号）');
      }
      return list[idx];
    };
    const summary = (v) => {
      if (v == null) return '';
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x && (x.label || x.id)) || '').filter(Boolean).join('、');
      if (typeof v === 'object') {
        return Object.entries(v).filter(([, n]) => !Number.isFinite(Number(n)) || Number(n) > 0)
          .map(([k, n]) => k + ' ' + n).join('，');
      }
      return '';
    };
    const stereoChoice = async (stereo) => {
      const s = stereo || {};
      const detail = [summary(s.counts), summary(s.molecules)].filter(Boolean).join('\n');
      return !!root.confirm('3D 构象需要立体化学信息。\n' + (detail ? detail + '\n' : '') + '使用示例构型？');
    };
    // The document UI supplies working HTML dialogs in WKWebView. Native
    // confirm/prompt are only fallbacks for controllers without that UI.
    this._molecule3DDialogs = { dc, prevChoose: dc.onChooseMolecule3DTarget, prevStereo: dc.onStereoChoiceRequired, chooseTarget, stereoChoice };
    if (typeof dc.onChooseMolecule3DTarget !== 'function') dc.onChooseMolecule3DTarget = chooseTarget;
    if (typeof dc.onStereoChoiceRequired !== 'function') dc.onStereoChoiceRequired = stereoChoice;
  };

  NativeUIBridge.prototype.removeMolecule3DDialogs = function () {
    const rec = this._molecule3DDialogs;
    if (!rec) return;
    if (rec.dc) {
      if (rec.dc.onChooseMolecule3DTarget === rec.chooseTarget) rec.dc.onChooseMolecule3DTarget = rec.prevChoose;
      if (rec.dc.onStereoChoiceRequired === rec.stereoChoice) rec.dc.onStereoChoiceRequired = rec.prevStereo;
    }
    this._molecule3DDialogs = null;
  };

  /* Release-only single commit: native slider sends exactly one setProperty on
   * release; the engine call is the existing setBendForSelection whose internal
   * begin/finish already joins one undo entry. */
  NativeUIBridge.prototype.applySelectionProperty = async function (args, command) {
    const app = this.app();
    const controller = app.controller;
    const documentController = app.documentController;
    const propertyId = args && args.propertyId;
    const props = this.buildSelection().properties;
    const prop = props.find(p => p.id === propertyId);
    const selectedDocIds = Array.from((documentController && documentController.selection) || []);
    const selectedDoc = selectedDocIds.length === 1 && documentController.object ? documentController.object(selectedDocIds[0]) : null;
    const legacyShapeFillAlias = propertyId === 'fill' && selectedDoc?.kind === 'shape' &&
      props.some(item => item.id === 'fill.mode') && props.some(item => item.id === 'fillColor');
    if (!prop && !legacyShapeFillAlias) return { error: { code: 'unsupported', message: '未公开的可写属性：' + propertyId } };
    if (prop && prop.enabled === false) return { error: { code: 'failed', message: '该属性当前不可写' } };
    if (propertyId === 'bend') {
      const value = Number(args.value);
      if (!Number.isFinite(value) || value < prop.min || value > prop.max) return { error: { code: 'invalid_arguments', message: 'bend 超出范围' } };
      if (!controller.selectedArrows().length) return { error: { code: 'stale_selection', message: '选区已不含弯箭头' } };
      this.stopForManualEdit();
      controller.setBendForSelection(value);
      this.noteCommittedEdit();
      return true;
    }
    if (propertyId === 'bondComponent') {
      const value = args.value === 'pi' ? 'pi' : args.value === 'sigma' ? 'sigma' : null;
      if (!value) return { error: { code: 'invalid_arguments', message: 'bondComponent 取值必须是 sigma 或 pi' } };
      const arrows = controller.selectedArrows();
      if (arrows.length !== 1) return { error: { code: 'stale_selection', message: '该属性只在单个弯箭头上有效' } };
      const ar = arrows[0];
      const side = ['source', 'target'].find(s => ar[s] && ar[s].type === 'bond');
      if (!side) return { error: { code: 'stale_selection', message: '选区已不含键端点' } };
      if (ar[side].component === value) return true; // Already the requested component: no-op, no history entry.
      this.stopForManualEdit();
      controller.toggleBondComponent();
      const after = controller.selectedArrows()[0];
      const afterSide = ['source', 'target'].find(s => after && after[s] && after[s].type === 'bond');
      if (!after || !afterSide || after[afterSide].component !== value) {
        return { error: { code: 'failed', message: '键电子成分切换未生效（π 电子可能不可用）' } };
      }
      this.noteCommittedEdit();
      return true;
    }
    if (propertyId === 'scale.preset') {
      const dc = documentController;
      const value = Number(args.value);
      if (!dc || typeof dc.applyScalePercent !== 'function' || typeof dc.beginScaleSession !== 'function') {
        return { error: { code: 'not_ready', message: '选区缩放层尚未就绪' } };
      }
      if (!dc.state || dc.state.mode !== 'paper') {
        return { error: { code: 'unsupported', message: '选区缩放仅在纸页模式可用' } };
      }
      if (!Number.isFinite(value) || value <= 0 || value > 800) {
        return { error: { code: 'invalid_arguments', message: 'scale.preset 需要有效的数字百分比' } };
      }
      if (typeof dc.hasScaleSelection === 'function' && dc.hasScaleSelection() !== true) {
        return { error: { code: 'stale_selection', message: '当前选区不支持缩放' } };
      }
      if (command.expectedSelectionRevision !== undefined && command.expectedSelectionRevision !== null) {
        const check = this.checkSelectionStale(command);
        if (check === 'stale') return { error: { code: 'stale_selection', message: '选区已变化，请重新读取 state' } };
      }
      this.stopForManualEdit();
      // applyScalePercent internally reuses an open session; beginScaleSession
      // first so the percent is always measured against session start.
      dc.beginScaleSession();
      dc.applyScalePercent(value);
      this.noteCommittedEdit();
      return true;
    }
    // Drawing defaults are app-local preferences: applying them updates only
    // the next shape and never creates history or marks the document dirty.
    const dc = documentController;
    const docIds = Array.from((dc && dc.selection) || []);
    if (propertyId.startsWith('shapeStyle.')) {
      if (!dc || !['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'bracket'].includes(dc.tool) || typeof dc.setShapeStyle !== 'function') {
        return { error: { code: 'stale_selection', message: '当前未选择形状绘图工具' } };
      }
      const id = propertyId.slice('shapeStyle.'.length), value = args.value, style = dc.shapeStyle || {};
      const unit = Number(dc.state && dc.state.ptPerBond) > 0 ? Number(dc.state.ptPerBond) : 14.4;
      const validColor = v => typeof v === 'string' && (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^(transparent|black|white|red|blue|green|gray)$/i.test(v));
      let patch = {};
      if (id === 'stroke.color' || id === 'fillColor') {
        if (!validColor(value)) return { error: { code: 'invalid_arguments', message: '颜色请使用标准 HEX' } };
        if (id === 'stroke.color') patch.stroke = { color: value };
        else patch = { fillColor: value, ...(style.fill !== 'none' ? { fill: value } : {}) };
      } else if (id === 'stroke.width') {
        const raw = Number(value);
        if (!Number.isFinite(raw) || raw < 0.1 || raw > 72) return { error: { code: 'invalid_arguments', message: '边框宽度 (pt) 应为 0.1–72' } };
        patch.stroke = { width: raw / unit };
      } else if (id === 'stroke.dash') {
        if (!['solid', 'dashed'].includes(String(value))) return { error: { code: 'invalid_arguments', message: '线型无效' } };
        patch.stroke = { dash: String(value) };
      } else if (id === 'fill.mode') {
        if (!['filled', 'none'].includes(String(value))) return { error: { code: 'invalid_arguments', message: '填充状态无效' } };
        const fillColor = style.fillColor || (style.fill && style.fill !== 'none' ? style.fill : '#ffffff');
        patch = String(value) === 'none' ? { fill: 'none', fillColor } : { fill: fillColor, fillColor };
      } else if (id === 'cornerRadius' && ['rect', 'roundRect'].includes(dc.tool)) {
        const raw = Number(value);
        if (!Number.isFinite(raw) || raw < 0 || raw > 1000) return { error: { code: 'invalid_arguments', message: '圆角半径 (pt) 应为 0–1000' } };
        patch.cornerRadius = raw / unit;
      } else return { error: { code: 'unsupported', message: '未公开的可写属性：' + propertyId } };
      this.stopForManualEdit();
      dc.setShapeStyle(patch);
      this.noteCommittedEdit();
      return true;
    }
    // Document object fields: only verified updateObject fields. Release-only
    // commits (native slider/text) produce exactly one undo entry each.
    const direct = {
      width: v => ({ w: Number(v) }), height: v => ({ h: Number(v) }),
      rotation: v => ({ rotation: Number(v) }), band: v => ({ band: v === 'front' ? 'front' : 'back' })
    };
    if (docIds.length === 1 && direct[propertyId]) {
      const patch = direct[propertyId](args.value);
      for (const key of Object.keys(patch)) {
        if (!Number.isFinite(patch[key]) && typeof patch[key] !== 'string') return { error: { code: 'invalid_arguments', message: propertyId + ' 取值无效' } };
      }
      this.stopForManualEdit();
      dc.updateObject(docIds[0], patch);
      this.noteCommittedEdit();
      return true;
    }
    /* Extended real object properties: rich text, shape stroke/fill, image crop.
     * Each commit goes through updateObject's single-history commit. */
    if (docIds.length === 1 && (/^(rich|stroke|fill|crop)\./.test(propertyId) || ['fill', 'fillColor', 'fill.mode', 'cornerRadius'].includes(propertyId))) {
      const current = dc.object(docIds[0]);
      if (!current) return { error: { code: 'stale_selection', message: '选区已不含该对象' } };
      if ((propertyId.startsWith('stroke.') || propertyId.startsWith('fill') || propertyId === 'cornerRadius') && current.kind !== 'shape') {
        return { error: { code: 'unsupported', message: '形状属性只适用于形状对象' } };
      }
      let patch = {};
      const value = args.value;
      const boolish = v => v === 'true' || v === true;
      if (propertyId === 'rich.text') patch.rich = { ...(current.rich || {}), text: String(value == null ? '' : value).slice(0, 262144) };
      else if (propertyId === 'rich.fontFamily') patch.rich = { ...(current.rich || {}), fontFamily: String(value) };
      else if (propertyId === 'rich.fontSize') patch.rich = { ...(current.rich || {}), fontSize: Math.max(2, Math.min(300, Number(value) || 12)) };
      else if (propertyId === 'rich.color') patch.rich = { ...(current.rich || {}), color: /^#[0-9a-f]{3,8}$/i.test(String(value)) ? String(value) : '#1c1c1e' };
      else if (propertyId === 'rich.bold') patch.rich = { ...(current.rich || {}), bold: boolish(value) };
      else if (propertyId === 'rich.italic') patch.rich = { ...(current.rich || {}), italic: boolish(value) };
      else if (propertyId === 'rich.align') patch.rich = { ...(current.rich || {}), align: ['left','center','right'].includes(String(value)) ? String(value) : 'left' };
      else if (propertyId === 'stroke.color') {
        const color = String(value), valid = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) || /^(transparent|black|white|red|blue|green|gray)$/i.test(color);
        if (!valid) return { error: { code: 'invalid_arguments', message: '描边颜色请使用标准 HEX' } };
        patch.stroke = { ...(current.stroke || {}), color };
      } else if (propertyId === 'stroke.width') {
        const pt = Number(value), unit = Number(dc.state && dc.state.ptPerBond) > 0 ? Number(dc.state.ptPerBond) : 14.4;
        if (!Number.isFinite(pt) || pt < 0.1 || pt > 72) return { error: { code: 'invalid_arguments', message: '边框宽度 (pt) 应为 0.1–72' } };
        patch.stroke = { ...(current.stroke || {}), width: pt / unit };
      } else if (propertyId === 'stroke.dash') {
        if (!['dashed', 'solid'].includes(String(value))) return { error: { code: 'invalid_arguments', message: '线型无效' } };
        patch.stroke = { ...(current.stroke || {}), dash: String(value) };
      } else if (propertyId === 'fill.mode') {
        if (current.kind !== 'shape' || !['filled', 'none'].includes(String(value))) return { error: { code: 'invalid_arguments', message: '填充状态无效' } };
        const fillColor = current.fillColor || (current.fill && current.fill !== 'none' ? current.fill : '#ffffff');
        patch = String(value) === 'none' ? { fill: 'none', fillColor } : { fill: fillColor, fillColor };
      } else if (propertyId === 'fillColor') {
        const color = String(value), valid = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) || /^(transparent|black|white|red|blue|green|gray)$/i.test(color);
        if (current.kind !== 'shape' || !valid) return { error: { code: 'invalid_arguments', message: '填充颜色请使用标准 HEX' } };
        patch = { fillColor: color, ...(current.fill !== 'none' ? { fill: color } : {}) };
      } else if (propertyId === 'cornerRadius') {
        const pt = Number(value), unit = Number(dc.state && dc.state.ptPerBond) > 0 ? Number(dc.state.ptPerBond) : 14.4;
        const max = Math.min(current.w, current.h) / 2 * unit;
        if (current.kind !== 'shape' || !['rect', 'roundRect'].includes(current.shape) || !Number.isFinite(pt) || pt < 0 || pt > max + 1e-8) {
          return { error: { code: 'invalid_arguments', message: '圆角半径超出该形状范围' } };
        }
        patch.cornerRadius = pt / unit;
      } else if (propertyId === 'fill') {
        const color = String(value);
        if (color !== 'none' && !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return { error: { code: 'invalid_arguments', message: '填充颜色请使用标准 HEX 或 none' } };
        patch = color === 'none' ? { fill: color } : { fill: color, fillColor: color };
      } else if (propertyId.startsWith('crop.')) {
        const key = propertyId.slice(5), raw = Number(value);
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
          return { error: { code: 'invalid_arguments', message: '裁剪范围应在 0–1 内' } };
        }
        const crop = { x: 0, y: 0, w: 1, h: 1, ...(current.crop || {}), [key]: raw };
        if (crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1.0001 || crop.y + crop.h > 1.0001) {
          return { error: { code: 'invalid_arguments', message: '裁剪范围应在 0–1 内且完整' } };
        }
        patch.crop = crop;
      } else return { error: { code: 'unsupported', message: '未公开的可写属性：' + propertyId } };
      if (command.expectedSelectionRevision !== undefined && command.expectedSelectionRevision !== null) {
        const check = this.checkSelectionStale(command);
        if (check === 'stale') return { error: { code: 'stale_selection', message: '选区已变化，请重新读取 state' } };
      }
      this.stopForManualEdit();
      dc.updateObject(docIds[0], patch);
      this.noteCommittedEdit();
      return true;
    }
    return { error: { code: 'unsupported', message: '未公开的可写属性：' + propertyId } };
  };

  /* ---------------- lifecycle ---------------- */
  NativeUIBridge.prototype.destroy = function () {
    if (this.disposed) return;
    this.disposed = true;
    if (this.attached) this.detach(this.epoch);
  };

  function publicConfig(config) {
    const src = config && config.config ? config.config : config;
    if (!src || typeof src !== 'object') return { configured: false };
    // sessionToken and any credential stay inside JS; never published.
    const out = {};
    for (const key of ['provider', 'baseUrl', 'model', 'configured', 'generation', 'generationCapabilities', 'notice']) {
      if (src[key] === undefined) continue;
      if (key === 'generationCapabilities' && src[key] && typeof src[key] === 'object') {
        const rawModels = src[key].openaiModels;
        if (rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
          const allowed = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
          const openaiModels = {};
          for (const [model, efforts] of Object.entries(rawModels)) {
            if (Array.isArray(efforts)) openaiModels[model] = efforts.filter(v => allowed.has(v));
          }
          out.generationCapabilities = { openaiModels };
        }
        continue;
      }
      out[key] = src[key];
    }
    return out;
  }

  /* ---------------- install ---------------- */
  let instance = null;
  MW.nativeUI = {
    create(deps) {
      instance = new NativeUIBridge(deps);
      return instance;
    },
    current() { return instance; },
    install(deps) {
      if (instance) return instance;
      const bridge = this.create(deps);
      const api = root.k3dAPI = root.k3dAPI || {};
      api.nativeUI = {
        attach: options => bridge.attach(options),
        dispatch: command => bridge.dispatch(command),
        getState: () => bridge.getState(),
        detach: epoch => bridge.detach(epoch)
      };
      return bridge;
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = { NativeUIBridge, create: MW.nativeUI.create, SURFACES, PROTOCOL };
})(typeof window === 'object' ? window : globalThis);
