/* MolStudio 工作台 · 机理层控制器
 * 工具状态机（第 6.1 节）：选择工具 → 悬停来源 → 已确定来源 → 预览目标 → 提交箭头 → 选择/编辑箭头
 *
 * 原则：
 *   - 草稿（draft）只是预览，不进历史、不改 dirty；一次拖拽/两次点击才产生一个历史动作
 *   - 所有持久改动都经 commit()：先改模型，再把「撤销动作」压进 Ketcher 同一条历史
 *   - 没命中机理对象的输入原样交给 Ketcher（不阻断画键、选分子、拖动）
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const M = MW.model;
  const R = MW.route;

  const HIT_PX = 12;          // 命中半径（CSS 像素，第 6.2 节建议值）
  const BOND_HIT_PX = 8;
  const LINE_HIT_PX = 6;      // 箭头线条命中（可宽于可见线宽）
  const PLAN_MIN_MOVE = 0.05; // 预览重规划的最小指针位移（按局部键长归一化）
  const CLIP_KIND = 'molstudio-mechanism';
  const CLIP_MIME = 'application/x-molstudio-mechanism';
  const CLIP_VERSION = 2;         // v2：端点带上「实际绘制位置」，只复制箭头时不会丢坐标
  const PASTE_OFFSET = 2.0;       // 每次粘贴相对原件的整体偏移（结构坐标，1 = 一个键长）

  function editableTarget(el) {
    if (!el) return false;
    // Ketcher 的零尺寸剪贴板接收器不是正在编辑的文本框；画布快捷键也会聚焦到这里。
    if (el.getAttribute && el.getAttribute('data-cliparea') === 'true') return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function applyAutoPlan(arrow, plan) {
    if (!plan?.feasible || plan.readable === false) return false;
    arrow.geometry.bend = plan.bend;
    delete arrow.geometry.controlFrame;
    arrow.geometry.mode = 'auto';
    arrow.geometry.routeVersion = M.ROUTE_VERSION;
    return true;
  }

  class MechanismController {
    constructor(opts) {
      this.adapter = opts.adapter;
      this.model = opts.model;
      this.layer = opts.layer;
      this.doc = opts.doc;
      this.win = opts.win;
      this.onStatus = opts.onStatus || function () {};
      this.onSelectionChange = opts.onSelectionChange || function () {};
      this.onToolChange = opts.onToolChange || function () {};
      this.onDirtyHint = opts.onDirtyHint || function () {};

      this.tool = 'select';
      this.selection = new Set();
      this.hover = null;
      this.draft = null;
      this.drag = null;
      this.pastePreview = null;  // 箭头粘贴的临时预览；点击前不写模型或历史
      this.suppressPasteMouse = false;
      this.nativeMarquee = null; // 只观察原生框选，不接管原生鼠标事件
      this.pendingNativeMarquee = null;
      this.nativePasteSession = null;
      this.nativePasteSequence = 0;
      this.pendingNativeCut = null;
      this.pendingNativeCuts = new Map(); // 已交给原生 debounce 的快照，独立于下一次剪贴板事件
      this.showAutoLonePairs = false;
      this.autoSlots = [];        // 建议槽位（显示为幽灵孤对）
      this.ghostSlots = [];       // 未持久化的可见槽位 {id, ownerAtomId, angle, refAtomId, angleRel}
      this.suppressedAuto = new Set();  // 用户删掉的自动槽位（按 atomUuid + 角度近似）
      this.disposers = [];
      this.lastPointer = null;
      this.structRevision = 0;
    }

    /* ---------------- 生命周期 ---------------- */
    mount() {
      if (this.disposers.length) return () => this.unmount();
      const doc = this.doc;
      const onDown = (e) => this.onPointerDown(e);
      const onMove = (e) => this.onPointerMove(e);
      const onUp = (e) => this.onPointerUp(e);
      const onKey = (e) => this.onKeyDown(e);
      const onBlur = () => {
        this.cancelDrag();
        this.cancelNativeMarquee();
        this.cancelDraft('失焦');
      };
      const onLeave = (e) => { if (e.target === doc.documentElement || e.target === doc.body) this.onPointerLeave(); };
      // Ketcher 仍监听兼容 mouse 事件；只拦 pointer 会留下整块 CH₃ 的原生悬停高亮。
      const onNativeMouse = (e) => this.onNativeMouse(e);
      const onDocClick = (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
        if (!btn) return;
        const palette = btn.closest('[class*="LeftToolbar-module"], [class*="RightToolbar-module"], [class*="BottomToolbar-module"]');
        // 缩放、撤销、导出/显示是动作，不应把正在使用的箭头工具切回选择。
        if (palette && !btn.hasAttribute('data-mech-tool') && !btn.hasAttribute('data-mech-action')) {
          if (this.tool !== 'select' || this.pastePreview) {
            this.setTool('select');
          }
        }
      };

      doc.addEventListener('pointerdown', onDown, true);
      doc.addEventListener('pointermove', onMove, true);
      doc.addEventListener('pointerup', onUp, true);
      doc.addEventListener('pointercancel', onBlur, true);
      doc.addEventListener('keydown', onKey, true);
      this.win.addEventListener('blur', onBlur);
      doc.addEventListener('mouseleave', onLeave, true);
      doc.addEventListener('click', onDocClick, true);
      for (const name of ['mousedown', 'mousemove', 'mouseup', 'click']) doc.addEventListener(name, onNativeMouse, true);

      // 分子沿用 Ketcher 的 DOM 剪贴板事件；联合选区追加箭头格式，纯箭头单独处理。
      const onPaste = (e) => this.onPasteEvent(e);
      const onCopy = (e) => this.onCopyEvent(e, false);
      const onCut = (e) => this.onCopyEvent(e, true);
      const topDoc = (root.document && root.document !== doc) ? root.document : null;
      const clipTargets = topDoc ? [doc, topDoc] : [doc];
      for (const d of clipTargets) {
        d.addEventListener('paste', onPaste, true);
        d.addEventListener('copy', onCopy, true);
        d.addEventListener('cut', onCut, true);
      }

      this.disposers.push(() => {
        doc.removeEventListener('pointerdown', onDown, true);
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onBlur, true);
        doc.removeEventListener('keydown', onKey, true);
        this.win.removeEventListener('blur', onBlur);
        doc.removeEventListener('mouseleave', onLeave, true);
        doc.removeEventListener('click', onDocClick, true);
        for (const name of ['mousedown', 'mousemove', 'mouseup', 'click']) doc.removeEventListener(name, onNativeMouse, true);
        for (const d of clipTargets) {
          d.removeEventListener('paste', onPaste, true);
          d.removeEventListener('copy', onCopy, true);
          d.removeEventListener('cut', onCut, true);
        }
      });

      this.unsubAdapter = this.adapter.onChange((kind) => this.onAdapterChange(kind));
      this.disposers.push(() => { if (this.unsubAdapter) this.unsubAdapter(); });
      return () => this.unmount();
    }

    unmount() {
      for (const d of this.disposers) { try { d(); } catch (e) { /* 已卸载 */ } }
      this.disposers = [];
      this.cancelDrag();
      this.cancelDraft();
      this.cancelNativePaste();
      this.cancelNativeCut();
      this.cancelNativeMarquee();
      if (this.pasteMouseTimer) clearTimeout(this.pasteMouseTimer);
      this.pasteMouseTimer = null;
      this.suppressPasteMouse = false;
    }

    onAdapterChange(kind) {
      // The mechanism SVG lives inside the same viewBox as the structures;
      // translating that camera already moves every arrow, dot and handle.
      if (kind === 'pan') return;
      // Label envelopes and screen-size clearances can change with zoom; drop
      // their cached scene without recomputing chemistry or rerouting arrows.
      this._scene = null;
      if (kind !== 'transform') this.refreshAutoSlots();
      if (kind === 'struct') this.pruneSelection();
      this.render();
    }

    /* ---------------- 状态 ---------------- */
    setTool(tool) {
      this.cancelDrag();
      this.cancelNativeMarquee();
      if (this.nativePasteSession) this.cancelNativePaste();
      if (this.tool === tool) {
        if (this.pastePreview) this.cancelDraft();
        return;
      }
      this.cancelDraft();
      this.tool = tool;
      if (tool !== 'select') {
        this.selection.clear();
        this.adapter.clearSelection();
        this.adapter.clearHover();
      }
      this.emitSelection();
      this.onToolChange(this.tool);
      this.render();
    }

    setShowAutoLonePairs(on) {
      this.showAutoLonePairs = !!on;
      this.refreshAutoSlots();
      this.render();          // 只改显示，不产生历史、不产生持久对象
    }

    beginBendAdjustment() {
      this._bendBefore = this.model.cloneState();
    }

    previewBendForSelection(bend) {
      const arrows = this.selectedArrows();
      if (!arrows.length) return;
      for (const ar of arrows) {
        ar.geometry.bend = bend;
        delete ar.geometry.controlFrame;
        // 用户动了曲率 → 标记为手动结果（重绑/重开都不再自动改）
        if (M.arrowMode(ar) !== 'manual') ar.geometry.mode = 'manual';
      }
      this.render();
      if (this.onDirtyHint) this.onDirtyHint();
    }

    finishBendAdjustment(finalBend) {
      const arrows = this.selectedArrows();
      if (arrows.length && M.finite(finalBend)) {
        for (const ar of arrows) {
          ar.geometry.bend = finalBend;
          delete ar.geometry.controlFrame;
          if (M.arrowMode(ar) !== 'manual') ar.geometry.mode = 'manual';
        }
      }
      if (this._bendBefore) {
        const before = this._bendBefore;
        this._bendBefore = null;
        const after = this.model.cloneState();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          this.model.setState(before, 'silent');
          this.commit(() => {
            this.model.setState(after, 'silent');
          }, '调整曲率');
        }
      }
      this.render();
    }

    setBendForSelection(bend) {
      this.beginBendAdjustment();
      this.finishBendAdjustment(bend);
    }

    selectedArrows() {
      return Array.from(this.selection).map(id => this.model.arrow(id)).filter(Boolean);
    }

    selectedLonePairs() {
      return Array.from(this.selection).map(id => this.model.lonePair(id)).filter(Boolean);
    }

    selectionCount() { return this.selection.size; }

    /* ---------------- 自动孤对建议（显示用，不落盘） ---------------- */
    refreshAutoSlots() {
      let chem;
      try { chem = this.adapter.chemSnapshot(); } catch (e) { chem = null; }
      if (!chem) { this.autoSlots = []; this.ghostSlots = []; return; }
      const sug = M.suggestLonePairs(chem);
      this.autoSlots = sug.slots;
      this.unsupported = sug.unsupported;
      this.rebuildGhosts();
    }

    rebuildGhosts() {
      const ghosts = [];
      if (!this.showAutoLonePairs) { this.ghostSlots = ghosts; return; }
      for (const slot of this.autoSlots) {
        const existing = this.model.lonePairsOf(slot.ownerAtomId);
        for (let i = 0; i < slot.count; i++) {
          const angle = slot.angles[i] === undefined ? (360 / slot.count) * i : slot.angles[i];
          const key = slot.ownerAtomId + '@' + Math.round(angle);
          if (this.suppressedAuto.has(key)) continue;
          // 已有同原子、同方向的持久孤对 → 不再画幽灵
          const dup = existing.some(lp => Math.abs(M.normalizeDelta(lp.angle - angle)) < 12);
          if (dup) continue;
          ghosts.push({
            id: 'ghost-' + key,
            ownerAtomId: slot.ownerAtomId,
            angle: angle,
            refAtomId: slot.refAtomId || null,
            angleRel: slot.refAtomId ? M.normalizeDelta(angle - (slot.refAngle || 0)) : null,
            ghost: true
          });
        }
      }
      this.ghostSlots = ghosts;
    }

    /* ---------------- 解析上下文 / 渲染 ---------------- */
    ctx() { return this.adapter.context(this.model); }

    /* 原子的视觉缩放因子（纸页实际尺寸缩放）：新画孤对/箭头继承，保持视觉一致 */
    visualFactor(uuid) {
      const f = this.adapter.effectiveAtomScale ? this.adapter.effectiveAtomScale(uuid) : 1;
      return M.finite(f) && f > 0 ? f : 1;
    }

    /* ---------------- 自动排布 ----------------
     * 只在这里调用 mechanism-route.js：新建（草稿预览/提交）、端点重绑、一键重新排布。
     * 视口 zoom/pan/resize、结构移动、撤销重做都不触发重规划（指令第 3.4 / 5 节）。
     */

    /* 端点身份：用来判断「目标没变」→ 预览可以走迟滞，不因抖动换侧 */
    endpointKey(ep) {
      if (!ep) return '-';
      switch (ep.type) {
        case 'lonePair': return 'lp:' + ep.ownerAtomId + ':' + ep.slotId;
        case 'radical': return 'rad:' + ep.ownerAtomId;
        case 'bond': return 'bd:' + ep.bondId + ':' + ep.component;
        case 'atom': return 'at:' + ep.atomId;
        case 'formingBond': return 'fb:' + ep.atomA + '>' + ep.atomB;
        case 'free': return 'free:' + Math.round((ep.x || 0) * 20) + ',' + Math.round((ep.y || 0) * 20);
        default: return String(ep.type);
      }
    }

    /* 障碍快照的缓存键：结构（含坐标）+ 机理对象（位置/曲率）都变了才重建。
       载入/整理期间 struct 可能短暂不可用：返回 null 让调用方按「无缓存」处理，绝不抛进 pointer 事件。 */
    sceneKey(exceptId) {
      let st = null;
      try { st = this.adapter.struct(); } catch (e) { return null; }
      if (!st || !st.atoms || !st.bonds) return null;
      let h = 0;
      for (const [, a] of st.atoms) {
        if (!a.pp) continue;
        h = (h * 31 + Math.round(a.pp.x * 100) + Math.round(a.pp.y * 100) * 7919) | 0;
      }
      let sig = (exceptId || '-') + '|' + st.atoms.size + '|' + st.bonds.size + '|' + h;
      for (const [id, arrow] of st.rxnArrows || []) {
        sig += '|R' + id + ':' + arrow.pos.map(p => p.x + ',' + p.y).join(';');
      }
      for (const lp of this.model.state.lonePairs) {
        sig += '|L' + lp.id + ',' + Math.round((lp.angle || 0) * 10) / 10;
      }
      for (const ar of this.model.state.arrows) {
        sig += '|A' + ar.id + ',' + Math.round((ar.geometry.bend || 0) * 1000) / 1000;
      }
      return sig;
    }

    sceneFor(ctx, exceptId) {
      const key = this.sceneKey(exceptId);
      if (key !== null && this._scene && this._scene.key === key) return this._scene.scene;
      const scene = R.buildScene(ctx, this.model, {});
      R.addArrowObstacles(scene, this.model, ctx, exceptId || null);
      if (key !== null) this._scene = { key: key, scene: scene };
      return scene;
    }

    /* 给一对端点算候选曲线。返回 { geo, plan } 或 null（端点不可解析/太近）
       opts.pendingLp：草稿期的幽灵/手工孤对（slotId='__pending__'）还没有落盘，
       规划时用它的角度合成一个临时孤对喂给解析上下文 —— 否则来源解析失败，
       预览消失、提交出来是一根直箭头（bend=null→0）。 */
    planFor(source, target, electronCount, opts) {
      const o = opts || {};
      const ctx0 = o.ctx || this.ctx();
      let ctx = ctx0;
      if (source && source.type === 'lonePair' && source.slotId === '__pending__' && o.pendingLp) {
        const pseudo = {
          ownerAtomId: o.pendingLp.ownerAtomId,
          angle: M.finite(o.pendingLp.angle) ? o.pendingLp.angle : 0,
          origin: o.pendingLp.origin || 'manual',
          refAtomId: o.pendingLp.refAtomId || null,
          angleRel: o.pendingLp.angleRel
        };
        ctx = Object.assign({}, ctx0, {
          lonePair: (slotId) => (slotId === '__pending__')
            ? pseudo
            : (ctx0.lonePair ? ctx0.lonePair(slotId) : null)
        });
      }
      let geo;
      try {
        geo = M.arrowGeometry({ source: source, target: target, electronCount: electronCount, geometry: { bend: 0 } }, ctx);
      } catch (e) { return null; }
      if (!geo || !geo.sourceOk || !geo.targetOk) return null;
      const a = geo.routingStart || geo.start, b = geo.routingEnd || geo.end;
      if (M.dist(a, b) < 1e-6) return null;
      const scene = o.scene || this.sceneFor(ctx0, o.exceptId || null);
      const targetDir = R.resolveTargetDir(target, ctx, geo.end);
      const geometryVariants = [];
      if (source?.type === 'lonePair' && typeof ctx.planningContextAtZoom === 'function') {
        for (const zoom of [0.41, 0.54, 1, 1.5]) {
          const measured = ctx.planningContextAtZoom(zoom);
          // Candidate evaluation is synchronous. Snapshot each required glyph
          // once per variant rather than re-reading native text for every bend.
          const boxes = new Map();
          const variant = measured && { ...ctx, atomLabelBox: id => {
            if (!boxes.has(id)) boxes.set(id, measured.atomLabelBox(id));
            return boxes.get(id);
          }, unit: measured.unit };
          if (variant) geometryVariants.push(bend => M.arrowGeometry({ source, target, electronCount, geometry: { bend } }, variant));
        }
      }
      const plan = R.planArrow({
        a: a, b: b, scene: scene,
        source: source, target: target, electronCount: electronCount, targetDir: targetDir, L: scene.L,
        preferredBondSide: o.preferredBondSide, preferClearArrows: o.preferClearArrows,
        geometryVariants,
        onlyBend: o.onlyBend,
        geometry: bend => M.arrowGeometry({ source: source, target: target, electronCount: electronCount, geometry: { bend: bend } }, ctx)
      });
      if (!plan || !plan.ranked.length) return null;
      return { geo: geo, plan: plan, scene: scene };
    }

    /* 草稿预览：目标变了就重排；同一目标内走迟滞，小幅抖动不换侧 */
    updateDraftPlan(force) {
      const d = this.draft;
      if (!d) return;
      if (!d.target) {
        d.preview = null;
        d.bend = null;
        d.plan = null;
        d.planKey = null;
        return;
      }
      const key = this.endpointKey(d.source) + '>' + this.endpointKey(d.target) + '#' + d.electronCount;
      const same = key === d.planKey;
      // 目标没变且指针没明显移动：沿用上次结果，不重复算
      if (!force && same && d.preview && d.lastPlanPointer && d.pointer &&
          M.dist(d.lastPlanPointer, d.pointer) < PLAN_MIN_MOVE * (this.sceneL() || 1) &&
          d.target.type !== 'free') {
        return;
      }
      const res = this.planFor(d.source, d.target, d.electronCount, {
        pendingLp: d.pending || null
      });
      d.planKey = key;
      d.lastPlanPointer = d.pointer ? { x: d.pointer.x, y: d.pointer.y } : null;
      if (!res) {
        d.preview = null;
        d.bend = null;
        d.plan = null;
        return;
      }
      let plan = res.plan;
      if (same && M.finite(d.bend)) plan = R.chooseWithHysteresis(plan, d.bend);
      const ctx0 = this.ctx();
      const ctx = d.pending ? Object.assign({}, ctx0, { lonePair: id => id === '__pending__' ? d.pending : ctx0.lonePair(id) }) : ctx0;
      const finalGeo = M.arrowGeometry({ source: d.source, target: d.target,
        electronCount: d.electronCount, geometry: { bend: plan.bend } }, ctx);
      d.bend = plan.bend;
      d.plan = plan;
      d.preview = {
        start: finalGeo.start, end: finalGeo.end, control: finalGeo.control,
        bend: plan.bend, feasible: plan.feasible, score: plan.score, note: plan.note
      };
    }

    sceneL() {
      try { return (this._scene && this._scene.scene && this._scene.scene.L) || 1; } catch (e) { return 1; }
    }

    /* 已有箭头按当前几何重新规划（只对 auto 箭头；manual 保留用户结果） */
    replanArrowInPlace(arrow, force, options) {
      if (!arrow) return null;
      if (!force && M.arrowMode(arrow) !== 'auto') return null;
      if (!force && M.finite(arrow.geometry?.bend)) {
        const current = this.planFor(arrow.source, arrow.target, arrow.electronCount,
          { ...options, exceptId: arrow.id, onlyBend: arrow.geometry.bend });
        if (current?.plan.feasible && current.plan.readable && !current.plan.ranked[0]?.arrowHits &&
            !current.plan.ranked[0]?.wrongSide) return current.plan;
      }
      const res = this.planFor(arrow.source, arrow.target, arrow.electronCount, { ...options, exceptId: arrow.id });
      if (!res) return null;
      const applied = applyAutoPlan(arrow, res.plan);
      return applied ? res.plan : { ...res.plan, applied: false, preservedBend: arrow.geometry.bend };
    }

    /* Keep a two-electron attack and the π shift at the same double bond on opposite sides. */
    replanConcertedArrows(changedIds, { ctx = this.ctx(), model = this.model, onlyChanged = false, preferClearArrows = false, preserveValid = false } = {}) {
      const arrows = model.state.arrows, changed = new Set(changedIds), plans = new Map();
      if (!changed.size || arrows.length < 2) return plans;
      const bonds = new Map((ctx.bonds?.() || []).map(bond => [bond.uuid, bond]));
      const plan = (arrow, skipId, preferredBondSide) => {
        const scene = R.buildScene(ctx, model);
        R.addArrowObstacles(scene, { state: { arrows: arrows.filter(ar => ar.id !== skipId) } }, ctx, arrow.id);
        if (preserveValid && M.finite(arrow.geometry?.bend)) {
          const current = this.planFor(arrow.source, arrow.target, arrow.electronCount,
            { ctx, scene, preferredBondSide, preferClearArrows, onlyBend: arrow.geometry.bend })?.plan;
          if (current?.feasible && current.readable && !current.ranked[0]?.arrowHits && !current.ranked[0]?.wrongSide) return current;
        }
        return this.planFor(arrow.source, arrow.target, arrow.electronCount, { ctx, scene, preferredBondSide, preferClearArrows })?.plan;
      };
      const apply = (arrow, result) => {
        if (!result) return;
        const applied = applyAutoPlan(arrow, result);
        plans.set(arrow.id, applied ? result : { ...result, applied: false, preservedBend: arrow.geometry.bend });
      };
      for (const shift of arrows) {
        if (shift.electronCount !== 2 || M.arrowMode(shift) !== 'auto' || shift.source.type !== 'bond' ||
            shift.source.component !== 'pi' || shift.target.type !== 'atom' || (onlyChanged && !changed.has(shift.id))) continue;
        const bond = bonds.get(shift.source.bondId);
        if (bond?.type !== 2 || ![bond.beginAtom, bond.endAtom].includes(shift.target.atomId)) continue;
        const acceptor = shift.target.atomId === bond.beginAtom ? bond.endAtom : bond.beginAtom;
        const attack = arrows.find(ar => {
          if (ar.electronCount !== 2 || (!changed.has(shift.id) && !changed.has(ar.id))) return false;
          const donor = ar.source.type === 'lonePair' ? ar.source.ownerAtomId : ar.source.atomId;
          if (!donor || donor === acceptor || donor === shift.target.atomId) return false;
          if (ar.target.type === 'atom') return ar.target.atomId === acceptor;
          return ar.target.type === 'formingBond' && [ar.target.atomA, ar.target.atomB].includes(donor) &&
            [ar.target.atomA, ar.target.atomB].includes(acceptor);
        });
        if (!attack) continue;
        // Finalize a newly routed attack before using its approach to choose the π shift side.
        const canMoveAttack = changed.has(attack.id) && M.arrowMode(attack) === 'auto';
        if (canMoveAttack) apply(attack, plan(attack, shift.id));
        const geo = M.arrowGeometry(attack, ctx);
        if (geo.degenerate || !geo.sourceOk || !geo.targetOk) continue;
        const approach = [0.82, 0.65].map(t => R.sideOfBond(M.quadPoint(geo.start, geo.control, geo.end, t), bond)).find(Boolean);
        if (!approach) continue;
        const shiftPlan = plan(shift, null, { bond, side: -approach });
        apply(shift, shiftPlan);
        // Docking around an attached H can leave the π arrow a single viable side.
        // In that case try the other attack approach with the π curve as an obstacle.
        if (canMoveAttack && shiftPlan?.feasible && shiftPlan.ranked[0].wrongSide) {
          const shiftGeo = M.arrowGeometry(shift, ctx);
          const shiftSide = R.sideOfBond(M.quadPoint(shiftGeo.start, shiftGeo.control, shiftGeo.end, 0.5), bond);
          if (!shiftSide) continue;
          const alternative = plan(attack, null, { bond, side: -shiftSide, t: 0.82 });
          if (alternative?.feasible && !alternative.ranked[0].wrongSide && !alternative.ranked[0].arrowHits) {
            apply(attack, alternative);
            apply(shift, plan(shift, null, { bond, side: shiftSide }));
          }
        }
      }
      return plans;
    }

    /* 一键重新自动排布：用户主动执行，恢复 auto，一条历史动作 */
    replanSelection() {
      const arrows = this.selectedArrows();
      if (!arrows.length) { this.status('请先选中要重新排布的箭头'); return false; }
      const ids = new Set(arrows.map(a => a.id));
      const plans = new Map();
      this.commit(() => {
        for (const ar of arrows) {
          const plan = this.replanArrowInPlace(ar, true);
          if (plan) plans.set(ar.id, plan);
        }
        for (const [id, plan] of this.replanConcertedArrows(plans.keys(), { onlyChanged: true })) plans.set(id, plan);
      }, '重新自动排布');
      const planned = plans.size, crowded = [...plans.values()].filter(plan => !plan.feasible).length;
      this.selection = ids;
      this.emitSelection();
      this.status(planned
        ? '已重新自动排布 ' + planned + ' 根箭头' + (crowded ? '（' + crowded + ' 根周围较拥挤，可再手调）' : '')
        : '这些箭头的端点无法解析，未重新排布');
      return planned > 0;
    }


    render() {
      this.layer.render({
        model: this.model,
        ctx: this.ctx(),
        selection: this.selection,
        hover: this.hover,
        draft: this.draft,
        pastePreview: this.pastePreview,
        nativePastePreview: this.nativePasteSession && this.nativePasteSession.active ? this.nativePasteSession : null,
        ghosts: this.ghostSlots
      });
    }

    /* ---------------- 命中测试 ---------------- */
    hitTest(modelPt, opts) {
      const o = opts || {};
      const tol = HIT_PX * this.adapter.modelPerPixel();
      const bondTol = BOND_HIT_PX * this.adapter.modelPerPixel();
      const ctx = this.ctx();

      // 先区分真正的元素字形与缩写里的 H；H₃C / CH₃ 的 H 不是中心碳。
      const st = this.adapter.struct();
      const boxes = new Map();
      const contains = (r, pad) => r && modelPt.x >= r.x1 - pad && modelPt.x <= r.x2 + pad &&
        modelPt.y >= r.y1 - pad && modelPt.y <= r.y2 + pad;
      let glyphBest = null;
      for (const [id, a] of st.atoms) {
        const uuid = this.adapter.uuidOfAtom(id);
        if (!uuid || !a.pp) continue;
        const box = ctx.atomLabelBox ? ctx.atomLabelBox(uuid) : null;
        boxes.set(id, box);
        const p = { x: a.pp.x, y: a.pp.y }, d = M.dist(p, modelPt);
        let hit = null;
        if ((box && contains(box.atomRect, 0)) || ((!box || !box.hasLabel) && d <= 5 * this.adapter.modelPerPixel())) {
          hit = { kind: 'atom', d: d, point: p, atomId: uuid, runtimeId: id, atom: a };
        } else if (box && (box.hydrogenRects || []).some(r => contains(r, 0))) {
          hit = { kind: 'implicitHydrogen', d: d, point: p, ownerAtomId: uuid };
        }
        if (hit && (!glyphBest || d < glyphBest.d)) glyphBest = hit;
      }
      if (glyphBest) return glyphBest;

      // 1) 已持久化的孤对
      let best = null;
      const lpTol = 7 * this.adapter.modelPerPixel();
      for (const lp of this.model.state.lonePairs) {
        if (lp.visible === false) continue;
        const p = M.lonePairPosition(lp, ctx);
        if (!p) continue;
        const d = M.dist(p, modelPt);
        if (d <= lpTol && (!best || d < best.d)) best = { kind: 'lonePair', d: d, point: p, lonePair: lp, ownerAtomId: lp.ownerAtomId };
      }
      if (best) return best;

      // 3) 原子（含自由基、复合标签）
      let atomBest = null;
      for (const [id, a] of st.atoms) {
        if (!a.pp) continue;
        const p = { x: a.pp.x, y: a.pp.y };
        const uuid = this.adapter.uuidOfAtom(id);
        if (!uuid) continue;
        const d = M.dist(p, modelPt);
        let hitAtom = (d <= tol);
        if (!hitAtom && ctx && typeof ctx.atomLabelBox === 'function') {
          const box = boxes.get(id);
          if (box && box.hasLabel) {
            const u = this.adapter.modelPerPixel();
            const hwModel = (box.hwCss + 4) * u;
            const hhModel = (box.hhCss + 4) * u;
            if (box.atomRect ? contains(box.atomRect, 4 * u) :
                (Math.abs(modelPt.x - p.x) <= hwModel && Math.abs(modelPt.y - p.y) <= hhModel)) {
              hitAtom = true;
            }
          }
        }
        if (hitAtom && (!atomBest || d < atomBest.d)) {
          atomBest = { kind: 'atom', d: d, point: p, atomId: uuid, runtimeId: id, atom: a };
        }
      }
      // 4) 键
      if (!o.atomsOnly) {
        let bondBest = null;
        for (const [id, b] of st.bonds) {
          const bi = this.adapter.bondInfo(id);
          if (!bi) continue;
          const d = pointSegmentDistance(modelPt, bi.begin, bi.end);
          if (d <= bondTol && (!bondBest || d < bondBest.d)) {
            const uuid = this.adapter.uuidOfBond(id);
            if (!uuid) continue;
            bondBest = { kind: 'bond', d: d, bondId: uuid, runtimeId: id, a: bi.begin, b: bi.end, type: bi.type, stereo: bi.stereo };
          }
        }
        if (bondBest && (!atomBest || bondBest.d < atomBest.d)) return bondBest;
      }
      if (atomBest) return atomBest;

      // 5) 幽灵孤对（自动建议）：排在原子/键之后——建议标记不能把键的点击抢走
      if (!o.atomsOnly) {
        let ghostBest = null;
        for (const g of this.ghostSlots) {
          const p = M.lonePairPosition(g, ctx);
          if (!p) continue;
          const d = M.dist(p, modelPt);
          if (d <= lpTol && (!ghostBest || d < ghostBest.d)) ghostBest = { kind: 'lonePair', d: d, point: p, ghost: g, ownerAtomId: g.ownerAtomId };
        }
        if (ghostBest) return ghostBest;
      }

      // 6) 已有箭头（线条命中，范围比可见线宽宽）
      if (o.includeArrows) {
        const lineTol = LINE_HIT_PX * this.adapter.modelPerPixel();
        let arrowBest = null;
        for (const ar of this.model.state.arrows) {
          const geo = M.arrowGeometry(ar, ctx);
          if (geo.degenerate) continue;
          const d = quadDistance(modelPt, geo.start, geo.control, geo.end);
          if (d <= lineTol && (!arrowBest || d < arrowBest.d)) arrowBest = { kind: 'arrow', d: d, arrow: ar, geometry: geo };
        }
        if (arrowBest) return arrowBest;
      }
      return null;
    }

    /* 选中箭头/孤对的手柄命中 */
    hitHandle(modelPt) {
      const tol = (MW.layer.PX.handleRadius + 4) * this.adapter.modelPerPixel();
      const ctx = this.ctx();
      for (const id of this.selection) {
        const ar = this.model.arrow(id);
        if (ar) {
          const geo = M.arrowGeometry(ar, ctx);
          const mid = M.quadPoint(geo.start, geo.control, geo.end, 0.5);
          if (M.dist(mid, modelPt) <= tol) return { kind: 'arrow-bend', arrow: ar, geometry: geo };
          if (M.dist(geo.start, modelPt) <= tol) return { kind: 'arrow-start', arrow: ar, geometry: geo };
          if (M.dist(geo.end, modelPt) <= tol) return { kind: 'arrow-end', arrow: ar, geometry: geo };
        }
        const lp = this.model.lonePair(id);
        if (lp) {
          const p = M.lonePairPosition(lp, ctx);
          if (p && M.dist(p, modelPt) <= tol) return { kind: 'lp-move', lonePair: lp };
        }
      }
      return null;
    }

    /* ---------------- 指针 ---------------- */
    isCanvasTarget(target) {
      if (!target || !this.doc) return false;
      if (editableTarget(target)) return false;
      if (target.closest && (
        target.closest('.toolbar') || target.closest('[role="toolbar"]') ||
        target.closest('.menu') || target.closest('[role="menu"]') ||
        target.closest('.modal') || target.closest('[role="dialog"]') ||
        target.closest('header') || target.closest('nav') ||
        target.closest('button') || target.closest('input') ||
        target.closest('select') || target.closest('textarea') ||
        target.closest('[class*="Toolbar"]') || target.closest('[class*="Menu"]') ||
        target.closest('[class*="topMenu"]') || target.closest('[class*="Header"]') ||
        target.closest('[class*="zoom"]') || target.closest('[data-testid*="button"]')
      )) {
        return false;
      }
      const svg = this.adapter.canvasSvg();
      const ca = this.adapter.ed && this.adapter.ed.render && this.adapter.ed.render.clientArea;
      if (svg && (svg === target || svg.contains(target))) return true;
      if (ca && (ca === target || ca.contains(target))) return true;
      return false;
    }

    eventModelPoint(e) {
      return this.adapter.clientToModel({ x: e.clientX, y: e.clientY });
    }

    onNativeMouse(e) {
      if (this.nativePasteSession && e.type === 'mouseup') {
        const tool = this.adapter.ed.tool?.();
        if (tool?.isSingleContractedGroup && tool.mergeItems && (this.nativePasteSession.document || this.nativePasteSession.lonePairSession || this.nativePasteSession.sourceArrows.length || this.nativePasteSession.reactionSteps)) {
          e.preventDefault(); e.stopImmediatePropagation();
          this.adapter.ed.tool('select'); this.cancelNativePaste();
          this.status('带文档对象或孤对的片段请放在空白处；此次融合粘贴已取消');
          return;
        }
      }
      if (this.nativePasteSession) return; // 混合片段的完整放置手势由原生 PasteTool 拥有
      if ((this.tool !== 'select' || this.draft || this.drag || this.pastePreview || this.suppressPasteMouse) && this.isCanvasTarget(e.target)) {
        e.preventDefault(); e.stopPropagation();
        this.adapter.clearHover();
      }
    }

    onPointerDown(e) {
      if (e.button !== 0) return;
      // 上一次 mouseup 已结束；先完成其箭头选区，避免旧定时器覆盖这次点击。
      this.flushNativeMarquee();
      if (this.pasteMouseTimer) clearTimeout(this.pasteMouseTimer);
      this.pasteMouseTimer = null;
      this.suppressPasteMouse = false;
      if (!this.isCanvasTarget(e.target)) {
        if (this.draft) this.cancelDraft('点击非画布区域');
        return;
      }
      const p = this.eventModelPoint(e);
      if (!p) return;
      this.lastPointer = { client: { x: e.clientX, y: e.clientY }, model: p };

      if (this.nativePasteSession) return;

      if (this.pastePreview) {
        e.preventDefault(); e.stopPropagation();
        // pointerdown 后仍会有 mouseup/click，不能让放置箭头的同一次点击穿透到原生工具。
        this.suppressPasteMouse = true;
        this.finishPastePreview(p);
        return;
      }

      // 正在等第二次点击：这一下确定目标
      if (this.draft) {
        e.preventDefault(); e.stopPropagation();
        this.updateDraftTarget(p, e.altKey);
        this.finishDraft(e.altKey);
        return;
      }

      if (this.tool === 'select') return this.onSelectDown(e, p);

      if (this.tool === 'lonePair') return this.onLonePairDown(e, p);

      if (this.tool === 'arrow2' || this.tool === 'arrow1') return this.onArrowDown(e, p);

      /* 自由基工具（先选功能再选目标）：单击原子 = 可撤销地切换其自由基标记。
       * 与 lonePair 相同的工具流；其他点击（键/空白/隐式 H）只给提示，不改结构。 */
      if (this.tool === 'radical') return this.onRadicalDown(e, p);
    }

    onRadicalDown(e, p) {
      const hit = this.hitTest(p, { atomsOnly: true });
      if (hit && hit.kind === 'implicitHydrogen') {
        e.preventDefault(); e.stopPropagation();
        this.status(this.implicitHydrogenHint());
        return;
      }
      if (!hit || hit.kind !== 'atom') {
        e.preventDefault(); e.stopPropagation();
        this.status('自由基工具：请点在原子上');
        return;
      }
      e.preventDefault(); e.stopPropagation();
      const runtimeId = this.adapter.atomIdOf(hit.atomId);
      const atom = runtimeId === null ? null : this.adapter.struct().atoms.get(runtimeId);
      if (!atom) { this.status('自由基工具：原子不可用'); return; }
      const so = this.win && this.win.molstudioNativeStructOps;
      const ctab = this.adapter.ed && this.adapter.ed.render && this.adapter.ed.render.ctab;
      if (!so || so.version !== 1 || !ctab || !ctab.molecule.atoms.has(runtimeId)) {
        this.status('当前编辑器不支持自由基设置');
        return;
      }
      const id = runtimeId;
      const inverse = [];
      const action = (ops) => ({ operations: ops, isDummy: () => false, perform(target) {
        const reverse = [];
        for (let i = ops.length - 1; i >= 0; i--) reverse.push(ops[i].perform(target));
        so.recalc(target.molecule, [id]);
        return action(reverse);
      } });
      this.commit(() => {
        inverse.push(new so.atomAttr(id, 'radical', atom.radical ? 0 : 2).perform(ctab));
        so.recalc(ctab.molecule, [id]);
        this.adapter.syncIdentity();
        if (typeof this.refreshAutoSlots === 'function') this.refreshAutoSlots();
      }, atom.radical ? '移除自由基' : '设置自由基');
      this.status(atom.radical ? '已移除自由基标记' : '已添加自由基标记');
      this.render();
    }

    onSelectDown(e, p) {
      // 手柄优先
      const handle = this.hitHandle(p);
      if (handle) {
        e.preventDefault(); e.stopPropagation();
        this.drag = { kind: handle.kind, handle: handle, startModel: p, moved: false, before: this.model.cloneState() };
        return;
      }
      const hit = this.hitTest(p, { includeArrows: true });
      if (hit && (hit.kind === 'arrow' || hit.kind === 'lonePair')) {
        e.preventDefault(); e.stopPropagation();
        const id = hit.kind === 'arrow' ? hit.arrow.id : (hit.lonePair ? hit.lonePair.id : null);
        if (!id) return;          // 幽灵孤对不是持久对象：选择工具下不选中它
        if (e.shiftKey) {
          if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
        } else {
          this.selection.clear();
          this.selection.add(id);
        }
        // Shift 可把箭头加入已有原生分子选区；普通单击仍只选择当前箭头。
        if (!e.shiftKey) this.adapter.clearSelection();
        this.emitSelection();
        this.render();
        return;
      }
      const nativeTool = this.adapter.ed && typeof this.adapter.ed.tool === 'function' ? this.adapter.ed.tool() : null;
      if (nativeTool && typeof nativeTool.isSelectionRunning === 'function') {
        // 空白处开始的原生矩形框选同时观察机理对象；是否真的框选由原生工具判断。
        // 原子拖动时 isSelectionRunning 为 false，绝不把分子拖动当作框选。
        this.nativeMarquee = { tool: nativeTool, startModel: p,
          startClient: { x: e.clientX, y: e.clientY }, box: null,
          previousSelection: new Set(this.selection), additive: !!e.shiftKey };
        if (!e.shiftKey && this.selection.size) { this.selection.clear(); this.emitSelection(); this.render(); }
        return;
      }
      // 无原生选择工具时保留独立机理框选（例如程序化嵌入）。
      if (e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        this.drag = { kind: 'marquee', startModel: p, startClient: { x: e.clientX, y: e.clientY }, box: null };
        this.selection.clear();
        this.emitSelection();
        return;
      }
      // 空白/结构：清掉机理选中，把事件交给 Ketcher
      if (this.selection.size) { this.selection.clear(); this.emitSelection(); this.render(); }
    }

    onLonePairDown(e, p) {
      const hit = this.hitTest(p, { atomsOnly: true });
      if (hit && hit.kind === 'implicitHydrogen') {
        e.preventDefault(); e.stopPropagation();
        this.status(this.implicitHydrogenHint());
        return;
      }
      if (!hit || (hit.kind !== 'atom' && hit.kind !== 'lonePair')) {
        e.preventDefault(); e.stopPropagation();
        this.status('孤对工具：请点在原子上');
        return;
      }
      e.preventDefault(); e.stopPropagation();
      const ctx = this.ctx();
      if (hit.kind === 'lonePair') {
        // 已有孤对：选中它（不反复点击就清空全部）
        const id = hit.lonePair ? hit.lonePair.id : null;
        if (id) {
          if (e.shiftKey) { if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id); }
          else { this.selection.clear(); this.selection.add(id); }
          this.emitSelection();
          this.render();
          return;
        }
        // 幽灵槽位：显式添加 → 持久化
        this.materializeGhost(hit.ghost, p);
        return;
      }
      // 点原子：在该方向加一对
      const owner = hit.atomId;
      const atomPos = hit.point;
      const angle = Math.atan2(p.y - atomPos.y, p.x - atomPos.x) * 180 / Math.PI;
      this.commit(() => {
        const lp = M.makeLonePair(owner, { origin: 'manual', angle: angle, radius: 0.42 * this.visualFactor(owner) });
        this.model.addLonePair(lp);
        this.selection.clear();
        this.selection.add(lp.id);
      }, '添加孤对');
      this.status('已添加手工孤对标记（未校验电子数）');
    }

    onArrowDown(e, p) {
      e.preventDefault(); e.stopPropagation();
      const source = this.resolveSource(p, e.altKey);
      if (!source) { this.status(this.resolveHint || '箭头工具：请从孤对、自由基或键上开始'); return; }
      const anchor = source.anchor || M.endpointAnchor(source.endpoint, this.ctx());
      this.draft = {
        source: source.endpoint,
        sourcePreview: this.resolveSourcePreview(p),
        pending: source.pending || null,
        sourceAnchor: anchor.ok === false ? p : { x: anchor.x, y: anchor.y },
        pointer: p,
        bend: null,
        preview: null,
        plan: null,
        planKey: null,
        lastPlanPointer: null,
        target: null,
        targetPreview: null,
        electronCount: this.tool === 'arrow1' ? 1 : 2,
        mode: 'drag',
        downClient: { x: e.clientX, y: e.clientY }
      };
      this.status('来源：' + source.label + '，移动到目标后释放');
      this.render();
    }

    /* 起点解析：孤对 > 自由基 > 键 > 原子（显式手工孤对） */
    resolveSource(p, altKey) {
      this.resolveHint = '';
      const hit = this.hitTest(p, {});
      const ctx = this.ctx();
      if (hit && hit.kind === 'implicitHydrogen') {
        this.resolveHint = this.implicitHydrogenHint();
        return null;
      }
      if (hit && hit.kind === 'lonePair') {
        if (hit.ghost) {
          // 幽灵槽位：草稿阶段不落盘，提交时与箭头一起进历史（Esc 取消后不留标记）
          const ghost = hit.ghost;
          const pos = M.lonePairPosition(ghost, ctx);
          return {
            endpoint: { type: 'lonePair', ownerAtomId: ghost.ownerAtomId, slotId: '__pending__' },
            pending: { ownerAtomId: ghost.ownerAtomId, angle: ghost.angle, refAtomId: ghost.refAtomId, angleRel: ghost.angleRel, origin: 'auto' },
            anchor: pos,
            label: this.describeAtom(ghost.ownerAtomId) + '的孤对电子'
          };
        }
        const lp = hit.lonePair;
        return { endpoint: { type: 'lonePair', ownerAtomId: lp.ownerAtomId, slotId: lp.id }, label: this.describeAtom(lp.ownerAtomId) + '的孤对电子' };
      }
      if (hit && hit.kind === 'atom') {
        const a = hit.atom;
        if (a && a.radical) {
          return { endpoint: { type: 'radical', ownerAtomId: hit.atomId }, label: this.describeAtom(hit.atomId) + '的自由基电子' };
        }
        // 点击原子 = 用它的电子对：
        // 1) 已有真实孤对 → 取离点击位置最近的一对；
        // 2) 显示中的自动建议（幽灵槽）→ 走 ghost pending 路径，电子从显示的那对出发；
        // 3) 带负电荷 → 原子本身直接起笔（不偷偷建孤对）；
        // 4) 有核验建议 → 自动孤对；其余 → 原子本身（不虚构孤对）。
        let nearestLp = null;
        let nearestD = Infinity;
        for (const lp of this.model.state.lonePairs) {
          if (lp.ownerAtomId !== hit.atomId || lp.visible === false) continue;
          const pos = M.lonePairPosition(lp, ctx);
          if (!pos) continue;
          const d = M.dist(p, pos);
          if (d < nearestD) { nearestD = d; nearestLp = lp; }
        }
        if (nearestLp) {
          return { endpoint: { type: 'lonePair', ownerAtomId: hit.atomId, slotId: nearestLp.id }, label: this.describeAtom(hit.atomId) + '的孤对电子' };
        }
        let nearestGhost = null;
        nearestD = Infinity;
        for (const g of (this.ghostSlots || [])) {
          if (g.ownerAtomId !== hit.atomId) continue;
          const pos = M.lonePairPosition(g, ctx);
          if (!pos) continue;
          const d = M.dist(p, pos);
          if (d < nearestD) { nearestD = d; nearestGhost = g; }
        }
        if (nearestGhost) {
          const pos = M.lonePairPosition(nearestGhost, ctx);
          return {
            endpoint: { type: 'lonePair', ownerAtomId: nearestGhost.ownerAtomId, slotId: '__pending__' },
            pending: { ownerAtomId: nearestGhost.ownerAtomId, angle: nearestGhost.angle, refAtomId: nearestGhost.refAtomId, angleRel: nearestGhost.angleRel, origin: 'auto' },
            anchor: pos,
            label: this.describeAtom(nearestGhost.ownerAtomId) + '的孤对电子'
          };
        }
        const charge = a && Number.isFinite(a.charge) ? a.charge : 0;
        if (charge < 0) {
          return {
            endpoint: { type: 'atom', atomId: hit.atomId },
            label: this.describeAtom(hit.atomId) + '⁻ 的电子'
          };
        }
        // 即使隐藏建议，常见 N/O 等仍可直接取核验过的孤对；不能偷偷给饱和 C 造孤对。
        const slot = this.autoSlots.find(s => s.ownerAtomId === hit.atomId && s.count > 0);
        if (slot) {
          const angle = slot.angles.reduce((best, ang) => {
            const desired = Math.atan2(p.y - hit.point.y, p.x - hit.point.x) * 180 / Math.PI;
            return Math.abs(M.normalizeDelta(ang - desired)) < Math.abs(M.normalizeDelta(best - desired)) ? ang : best;
          });
          const pending = { ownerAtomId: hit.atomId, angle: angle, origin: 'auto',
            refAtomId: slot.refAtomId || null,
            angleRel: slot.refAtomId ? M.normalizeDelta(angle - (slot.refAngle || 0)) : null };
          return { endpoint: { type: 'lonePair', ownerAtomId: hit.atomId, slotId: '__pending__' },
            pending: pending, anchor: M.lonePairPosition(pending, ctx), label: this.describeAtom(hit.atomId) + '的孤对电子' };
        }
        // 绘图工具允许从 C 等原子起笔，但不虚构孤对电子。
        return { endpoint: { type: 'atom', atomId: hit.atomId }, label: this.describeAtom(hit.atomId) + '原子' };
      }
      if (hit && hit.kind === 'bond') {
        const component = hit.type === 2 ? 'pi' : 'sigma';
        const amb = hit.type === 3 ? '（三键默认 σ，可在属性里切换）' : '';
        return {
          endpoint: { type: 'bond', bondId: hit.bondId, component: component },
          label: this.describeBond(hit.bondId) + '的 ' + (component === 'pi' ? 'π' : 'σ') + ' 电子' + amb
        };
      }
      return null;
    }

    /* 目标解析：原子（→ 待成键或原子）、键、自由端点 */
    implicitHydrogenHint() {
      return '这里是缩写中的隐式 H；要指向 H 或从 X–H 键起笔，请先用顶部「加/去显式氢」展开';
    }

    resolveTarget(p, altKey, source) {
      this.resolveHint = '';
      let hit = this.hitTest(p, { atomsOnly: false });
      const src = source || (this.draft && this.draft.source);
      if (hit && hit.kind === 'implicitHydrogen') {
        this.resolveHint = this.implicitHydrogenHint();
        return null;
      }
      // 孤对/自由基点命中 → 映射到所属原子：点就是原子的电子，指向它=指向那个原子。
      // 不做这步，原子自己的孤对点（半径 0.35）会挡住原子本身的命中（目标变「空白处」）。
      if (hit && (hit.kind === 'lonePair' || hit.kind === 'radical')) {
        const owner = hit.ownerAtomId ||
          (hit.lonePair && hit.lonePair.ownerAtomId) ||
          (hit.ghost && hit.ghost.ownerAtomId) || null;
        if (owner) {
          const pos = this.adapter.atomPos(this.adapter.atomIdOf(owner));
          hit = { kind: 'atom', atomId: owner, point: pos || (hit.point || p), atom: null };
        }
      }
      if (hit && hit.kind === 'atom') {
        const ownerAtom = src && ((src.type === 'lonePair' || src.type === 'radical') ? src.ownerAtomId :
          (src.type === 'atom' ? src.atomId : null));
        if (ownerAtom === hit.atomId) {
          this.resolveHint = '来源和目标属于同一原子，请选择另一个原子或化学键';
          return null;
        }
        const ownerRuntimeId = ownerAtom ? this.adapter.atomIdOf(ownerAtom) : null;
        const owner = ownerRuntimeId === null ? null : this.adapter.struct().atoms.get(ownerRuntimeId);
        const formsBond = src && (src.type !== 'atom' || (owner && owner.charge < 0));
        if (ownerAtom && ownerAtom !== hit.atomId && formsBond) {
          const a = this.adapter.atomPos(this.adapter.atomIdOf(ownerAtom));
          const ep = { type: 'formingBond', atomA: ownerAtom, atomB: hit.atomId };
          const landing = M.formingBondLanding(ep, src, this.tool === 'arrow1' ? 1 : 2, this.ctx());
          return {
            endpoint: ep,
            preview: {
              kind: 'formingBond',
              a: a,
              b: hit.point,
              targetPoint: landing ? { x: landing.x, y: landing.y } : M.lerp(a, hit.point, 0.75)
            },
            label: '待形成键 ' + this.describeAtom(ownerAtom) + '···' + this.describeAtom(hit.atomId)
          };
        }
        return { endpoint: { type: 'atom', atomId: hit.atomId }, preview: { kind: 'atom', point: hit.point, atomId: hit.atomId }, label: this.describeAtom(hit.atomId) + ' 原子' };
      }
      if (hit && hit.kind === 'bond') {
        return {
          endpoint: { type: 'bond', bondId: hit.bondId, component: 'sigma' },
          preview: { kind: 'bond', a: hit.a, b: hit.b },
          label: this.describeBond(hit.bondId) + '电子'
        };
      }
      if (altKey) {
        return { endpoint: { type: 'free', x: p.x, y: p.y }, preview: { kind: 'free', point: p }, label: '自由端点（未绑定）' };
      }
      return null;
    }

    onPointerMove(e) {
      if (editableTarget(e.target)) return;
      if (!this.drag && !this.draft && !this.pastePreview && !this.nativePasteSession && this.adapter.isHandTool?.()) {
        if (this.hover) { this.hover = null; this.render(); }
        return;
      }
      if (!this.isCanvasTarget(e.target) && !this.drag && !this.draft && !this.pastePreview) {
        if (this.hover) { this.hover = null; this.render(); }
        return;
      }
      const p = this.eventModelPoint(e);
      if (!p) return;
      this.lastPointer = { client: { x: e.clientX, y: e.clientY }, model: p };

      if (this.nativePasteSession) return;

      if (this.nativeMarquee && this.nativeMarquee.tool.isSelectionRunning()) {
        const start = this.nativeMarquee.startModel;
        this.nativeMarquee.box = { x1: start.x, y1: start.y, x2: p.x, y2: p.y };
      }

      if (this.pastePreview) {
        e.preventDefault(); e.stopPropagation();
        this.movePastePreview(p);
        this.render();
        return;
      }

      if (this.drag) return this.onDragMove(e, p);

      if (this.draft) {
        this.draft.pointer = p;
        this.updateDraftTarget(p, e.altKey);
        this.render();
        return;
      }

      if (this.tool === 'arrow2' || this.tool === 'arrow1') {
        const src = this.resolveSourcePreview(p);
        this.hover = src;
        this.render();
        return;
      }
      if (this.tool === 'lonePair') {
        const hit = this.hitTest(p, { atomsOnly: true });
        this.hover = (hit && hit.kind === 'atom') ? { kind: 'atom', point: hit.point, atomId: hit.atomId } : null;
        this.render();
        return;
      }
      // 选择工具：悬停时给箭头/孤对一点提示，但不拦截事件
      const hit = this.hitTest(p, { includeArrows: true });
      this.hover = (hit && (hit.kind === 'arrow' || hit.kind === 'lonePair'))
        ? (hit.kind === 'arrow' ? { kind: 'arrow', arrow: hit.arrow } : { kind: 'lonePair', point: hit.point })
        : null;
      this.render();
    }

    /* 悬停预览：不改模型（幽灵不落盘） */
    resolveSourcePreview(p) {
      const source = this.resolveSource(p, false);
      if (!source) {
        const hit = this.hitTest(p, {});
        return hit && hit.kind === 'implicitHydrogen'
          ? { kind: 'implicitHydrogen', point: p, label: '隐式 H：请先展开显式氢' } : null;
      }
      const ep = source.endpoint, label = '起点：' + source.label;
      if (ep.type === 'bond') {
        const b = this.ctx().bondInfo(ep.bondId);
        return b ? { kind: 'bond', a: b.begin, b: b.end, label: label } : null;
      }
      if (ep.type === 'atom') return { kind: 'atom', point: this.ctx().atomPos(ep.atomId), atomId: ep.atomId, label: label };
      const anchor = source.anchor || M.endpointAnchor(ep, this.ctx());
      if (anchor && anchor.ok !== false) return { kind: 'lonePair', point: anchor, ownerAtomId: ep.ownerAtomId, label: label };
      return null;
    }

    describeBond(bondId) {
      const b = this.ctx().bondInfo(bondId);
      if (!b) return '化学键';
      const st = this.adapter.struct();
      const a = st.atoms.get(b.beginId), c = st.atoms.get(b.endId);
      return (a ? a.label : '原子') + (b.type === 2 ? '=' : b.type === 3 ? '≡' : '—') + (c ? c.label : '原子') + ' 键';
    }

    updateDraftTarget(p, altKey) {
      const t = this.resolveTarget(p, altKey);
      this.draft.pointer = p;
      this.draft.target = t ? t.endpoint : null;
      this.draft.targetPreview = t ? t.preview : null;
      this.draft.targetLabel = t ? t.label : '';
      this.updateDraftPlan();
      if (t) {
        const crowded = this.draft.plan && this.draft.plan.feasible === false;
        this.status('目标：' + t.label + '（释放或再点一次提交，Esc 取消）' +
          (crowded ? ' · 周围较拥挤，已选最空的一侧' : ''));
      } else {
        this.status(this.resolveHint || '目标：空白处（按住 Option 可提交未绑定的自由端点）');
      }
    }

    onDragMove(e, p) {
      const d = this.drag;
      d.moved = true;
      if (d.kind === 'marquee') {
        d.current = p;
        d.box = { x1: d.startModel.x, y1: d.startModel.y, x2: p.x, y2: p.y };
        this.renderMarquee();
        return;
      }
      if (d.kind === 'arrow-bend') {
        const geo = d.handle.geometry;
        const mid = M.quadPoint(geo.start, geo.control, geo.end, 0.5);
        const chord = { x: geo.end.x - geo.start.x, y: geo.end.y - geo.start.y };
        const len = Math.hypot(chord.x, chord.y) || 1;
        const n = M.perp({ x: chord.x / len, y: chord.y / len });
        // The handle is at t=0.5, so moving it by one unit moves the
        // control point by two. Measure from pointer-down, not the handle
        // centre: users can grab anywhere within its hit radius.
        const start = d.startModel || mid;
        const delta = 2 * ((p.x - start.x) * n.x + (p.y - start.y) * n.y) / len;
        const original = d.before.arrows.find(a => a.id === d.handle.arrow.id).geometry;
        let appliedDelta = delta;
        if (original.controlFrame) {
          const initial = original.controlFrame.normal;
          // Imported frames may already exceed the editing limit. Preserve
          // their starting curve and permit movement back inside the limit.
          const normal = Math.max(Math.min(-2.5, initial),
            Math.min(Math.max(2.5, initial), initial + delta));
          appliedDelta = normal - initial;
          d.handle.arrow.geometry.controlFrame = { along: original.controlFrame.along, normal: normal };
        }
        const bend = Math.max(-2.5, Math.min(2.5, (original.bend || 0) + appliedDelta));
        d.pendingBend = bend;
        d.handle.arrow.geometry.bend = bend;
        this.render();
        return;
      }
      if (d.kind === 'arrow-start' || d.kind === 'arrow-end') {
        d.pendingTarget = p;
        this.hover = { kind: 'point', point: p };
        this.render();
        return;
      }
      if (d.kind === 'lp-move') {
        const lp = d.handle.lonePair;
        const owner = this.adapter.atomPos(this.adapter.atomIdOf(lp.ownerAtomId));
        if (owner) {
          if (!d.referenceChecked) {
            const chem = this.adapter.chemSnapshot?.();
            const atom = chem?.atoms?.find(atom => atom.uuid === lp.ownerAtomId);
            // A generated attack may reference an atom in another reagent.
            // Manual dragging returns to the local bond frame (or no frame).
            if (Array.isArray(atom?.neighbors) && lp.refAtomId && !atom.neighbors.some(neighbor => neighbor.uuid === lp.refAtomId)) {
              lp.refAtomId = null; lp.angleRel = null;
            }
            d.referenceChecked = true;
          }
          const newAngle = Math.atan2(p.y - owner.y, p.x - owner.x) * 180 / Math.PI;
          lp.angle = ((newAngle % 360) + 360) % 360;
          if (lp.refAtomId) {
            const ref = this.adapter.atomPos(this.adapter.atomIdOf(lp.refAtomId));
            if (ref) {
              const baseDeg = Math.atan2(ref.y - owner.y, ref.x - owner.x) * 180 / Math.PI;
              lp.angleRel = M.normalizeDelta(lp.angle - baseDeg);
            }
          } else {
            const chem = this.adapter.chemSnapshot();
            const ca = chem && chem.atoms ? chem.atoms.find(a => a.uuid === lp.ownerAtomId) : null;
            if (ca && ca.neighbors && ca.neighbors.length && ca.neighbors[0].uuid) {
              const refId = ca.neighbors[0].uuid;
              const ref = this.adapter.atomPos(this.adapter.atomIdOf(refId));
              if (ref) {
                lp.refAtomId = refId;
                const baseDeg = Math.atan2(ref.y - owner.y, ref.x - owner.x) * 180 / Math.PI;
                lp.angleRel = M.normalizeDelta(lp.angle - baseDeg);
              }
            }
          }
        }
        this.render();
        return;
      }
    }

    onPointerUp(e) {
      if (this.nativePasteSession) return;
      if (this.nativeMarquee) {
        const observed = this.nativeMarquee;
        this.nativeMarquee = null;
        // capture pointermove 可能早于同一次兼容 mousemove 启动原生框选；
        // 单次移动的拖拽也必须使用真实 pointerup 终点，不能依赖上一帧已启动。
        const end = this.eventModelPoint(e);
        if (end && observed.tool.isSelectionRunning()) {
          observed.box = { x1: observed.startModel.x, y1: observed.startModel.y, x2: end.x, y2: end.y };
          // 原生 mouseup 先完成分子选区，再补同一个矩形内的箭头。
          if (this.nativeMarqueeTimer) clearTimeout(this.nativeMarqueeTimer);
          this.pendingNativeMarquee = observed;
          this.nativeMarqueeTimer = setTimeout(() => this.flushNativeMarquee(), 0);
        }
      }
      if (this.suppressPasteMouse) {
        e.preventDefault(); e.stopPropagation();
        this.pasteMouseTimer = setTimeout(() => {
          this.pasteMouseTimer = null;
          this.suppressPasteMouse = false;
        }, 0);
        return;
      }
      const p = this.eventModelPoint(e);
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        if (d.kind === 'marquee') {
          this.finishMarquee(d);
          return;
        }
        if (d.kind === 'arrow-bend') {
          const before = d.before;
          // 拖曲率手柄是手动操作：结果标记为 manual（一条历史动作）
          if (d.handle && d.handle.arrow &&
              M.arrowMode(d.handle.arrow) !== 'manual' &&
              M.finite(d.handle.arrow.geometry.bend)) {
            d.handle.arrow.geometry.mode = 'manual';
          }
          const after = this.model.cloneState();
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            this.model.setState(before, 'silent');
            this.commitStatePair(before, after, '调整曲率');
          }
          this.render();
          return;
        }
        if (d.kind === 'arrow-start' || d.kind === 'arrow-end') {
          this.finishEndpointDrag(d, p, e.altKey);
          return;
        }
        if (d.kind === 'lp-move') {
          const before = d.before;
          const after = this.model.cloneState();
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            this.model.setState(before, 'silent');
            this.commitStatePair(before, after, '调整孤对方位');
          }
          this.render();
          return;
        }
        return;
      }
      if (this.draft && this.draft.mode === 'drag') {
        const moved = Math.hypot(e.clientX - this.draft.downClient.x, e.clientY - this.draft.downClient.y);
        if (moved < 4) {
          // 只是点了一下：转成两次点击模式，等待第二下
          this.draft.mode = 'click';
          this.status('已确定来源，再点一次确定目标（Esc 取消）');
          return;
        }
        this.updateDraftTarget(p, e.altKey);
        this.finishDraft(e.altKey);
      }
    }

    finishEndpointDrag(d, p, altKey) {
      const arrow = d.handle.arrow;
      const which = d.kind === 'arrow-start' ? 'source' : 'target';
      // 已有自由端点可直接在空白处移动；绑定端点转为自由端点仍需 Option 明确指定。
      const allowFree = which === 'target' && (altKey || arrow.target.type === 'free');
      const resolved = which === 'source' ? this.resolveSource(p, false)
                                          : this.resolveTarget(p, allowFree, arrow.source);
      if (!resolved) {
        // 无效位置：保留原绑定（不悄悄变成自由端点）
        this.status(this.resolveHint || '该位置不能作为端点，已保留原绑定');
        this.render();
        return;
      }
      if (which === 'target' && resolved.endpoint.type === 'free' && !allowFree) {
        this.status('自由端点需要按住 Option 才能提交，已保留原绑定');
        this.render();
        return;
      }
      const nextSource = which === 'source' ? resolved.endpoint : arrow.source;
      const nextTarget = which === 'target' ? resolved.endpoint : arrow.target;
      if (nextTarget.type === 'atom' && M.endpointAtomIds(nextSource).includes(nextTarget.atomId)) {
        this.status('来源和目标属于同一原子，已保留原绑定');
        this.render();
        return;
      }
      const before = this.model.cloneState();
      let ep = resolved.endpoint;
      if (resolved.pending) {
        const pendingFactor = this.visualFactor(resolved.pending.ownerAtomId);
        const lp = M.makeLonePair(resolved.pending.ownerAtomId, {
          origin: resolved.pending.origin || 'manual',
          angle: resolved.pending.angle,
          radius: 0.42 * pendingFactor,
          refAtomId: resolved.pending.refAtomId || null,
          angleRel: resolved.pending.angleRel === undefined ? null : resolved.pending.angleRel
        });
        this.model.addLonePair(lp);
        ep = Object.assign({}, ep, { slotId: lp.id });
      }
      arrow[which] = ep;
      if (ep.type !== 'free') delete arrow.geometry.controlFrame;
      // 端点重绑：auto 箭头用新端点重新规划（同一历史动作）；manual 保留原曲率与侧向
      let replanned = false;
      if (M.arrowMode(arrow) === 'auto') {
        const plan = this.replanArrowInPlace(arrow, false);
        replanned = !!plan;
        if (plan && !plan.feasible) this.status('已重绑，但周围较拥挤，可手动调整曲率');
      }
      const after = this.model.cloneState();
      this.model.setState(before, 'silent');
      this.commitStatePair(before, after, which === 'source' ? '重绑起点' : '重绑终点');
      this.status('已重绑' + (which === 'source' ? '起点' : '终点') +
                  (replanned ? '，曲率已按新端点自动调整' : ''));
    }

    finishDraft(altKey) {
      const draft = this.draft;
      if (!draft) return;
      if (!draft.target) {
        this.status(this.resolveHint || '目标无效，箭头未提交（Esc 取消）');
        return;
      }
      if (!M.finite(draft.bend)) {
        this.status('端点无法排布，箭头未提交，请重新选择目标');
        return;
      }
      const ctx = this.ctx();
      const before = this.model.cloneState();

      // 草稿阶段的「幽灵/手工孤对」在这里才落盘：与箭头同一个历史动作（Esc 取消则不留痕迹）
      let source = draft.source;
      if (draft.pending) {
        const lp = M.makeLonePair(draft.pending.ownerAtomId, {
          origin: draft.pending.origin || 'manual',
          angle: draft.pending.angle,
          radius: 0.42 * this.visualFactor(draft.pending.ownerAtomId),
          refAtomId: draft.pending.refAtomId || null,
          angleRel: draft.pending.angleRel === undefined ? null : draft.pending.angleRel
        });
        this.model.addLonePair(lp);
        source = Object.assign({}, source, { slotId: lp.id });
      }

      // 拒绝零长度/重合端点（第 7.1 节）：不提交、保留原内容
      const a = M.endpointAnchor(source, ctx);
      const b = M.endpointAnchor(draft.target, ctx);
      if (!a.ok || !b.ok || M.dist(a, b) < 1e-3) {
        this.model.setState(before, 'silent');
        this.lastDraftReject = { a: a, b: b, source: source, target: draft.target };
        this.status(!a.ok || !b.ok ? '端点无法解析，箭头未提交' : '起点与终点重合，箭头未提交');
        this.render();
        return;
      }

      const boundAtoms = M.endpointAtomIds(source).concat(M.endpointAtomIds(draft.target));
      const ar = M.makeArrow(source, draft.target, { electronCount: draft.electronCount, bend: draft.bend,
        scale: boundAtoms.length ? this.visualFactor(boundAtoms[0]) : 1 });
      this.model.addArrow(ar);
      const after = this.model.cloneState();
      this.model.setState(before, 'silent');
      this.draft = null;
      this.selection.clear();
      this.selection.add(ar.id);
      this.commitStatePair(before, after, '添加箭头');
      this.emitSelection();
      this.status('已添加' + (ar.electronCount === 1 ? '单电子（鱼钩）' : '两电子') + '箭头');
      this.render();
    }

    cancelDraft(reason) {
      if (!this.draft && !this.pastePreview) return;
      this.draft = null;
      this.pastePreview = null;
      this.documentController?.clearFragmentPreview();
      this.status(reason ? '已取消（' + reason + '）' : '已取消当前草稿');
      this.render();
    }

    // 拖动手柄时模型用于实时预览；中断手势必须恢复快照，不能留下无历史的改动。
    cancelDrag() {
      const drag = this.drag;
      if (!drag) return false;
      this.drag = null;
      if (drag.before) this.model.setState(drag.before, 'silent');
      this.hover = null;
      this.render();
      return true;
    }

    onPointerLeave() {
      if (this.draft && this.draft.mode === 'drag') return;   // 拖出窗口：保留草稿，等 pointerup/失焦收尾
      this.hover = null;
      this.render();
    }

    /* ---------------- 框选 ---------------- */
    renderMarquee() {
      const box = this.drag && this.drag.box;
      const layer = this.layer;
      if (!layer || !layer.overlay) return;
      this.render();
      if (!box) return;
      const u = layer.unit();
      const el = this.doc.createElementNS(MW.adapter.SVG_NS, 'rect');
      el.setAttribute('x', Math.min(box.x1, box.x2));
      el.setAttribute('y', Math.min(box.y1, box.y2));
      el.setAttribute('width', Math.abs(box.x2 - box.x1));
      el.setAttribute('height', Math.abs(box.y2 - box.y1));
      el.setAttribute('fill', 'rgba(10,126,164,.08)');
      el.setAttribute('stroke', '#0a7ea4');
      el.setAttribute('stroke-width', 1.2 * u);
      el.setAttribute('stroke-dasharray', (4 * u) + ' ' + (3 * u));
      el.setAttribute('data-mech-ui', '1');
      layer.overlay.appendChild(el);
    }

    finishMarquee(drag) {
      const box = (drag && drag.box) || (this.drag && this.drag.box);
      if (!box) return;
      const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2);
      const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2);
      const inside = (p) => p && p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
      const ctx = this.ctx();
      this.selection.clear();
      for (const lp of this.model.state.lonePairs) {
        if (inside(M.lonePairPosition(lp, ctx))) this.selection.add(lp.id);
      }
      for (const ar of this.model.state.arrows) {
        const geo = M.arrowGeometry(ar, ctx);
        let hit = inside(geo.start) || inside(geo.end);
        // 只按两端判断会漏掉「框住弧线中段」：沿曲线再采样几个点
        for (let i = 1; i < 8 && !hit; i++) {
          if (inside(M.quadPoint(geo.start, geo.control, geo.end, i / 8))) hit = true;
        }
        if (hit) this.selection.add(ar.id);
      }
      this.emitSelection();
      this.status(this.selection.size ? '已选中 ' + this.selection.size + ' 个机理对象' : '框选范围内没有机理对象');
      this.render();
    }

    cancelNativeMarquee() {
      if (this.nativeMarqueeTimer) clearTimeout(this.nativeMarqueeTimer);
      this.nativeMarqueeTimer = null;
      this.nativeMarquee = null;
      this.pendingNativeMarquee = null;
    }

    flushNativeMarquee() {
      const pending = this.pendingNativeMarquee;
      if (!pending) return;
      this.cancelNativeMarquee();
      this.finishNativeMarquee(pending);
    }

    finishNativeMarquee(drag) {
      const box = drag && drag.box;
      if (!box || this.tool !== 'select') return;
      const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2);
      const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2);
      const inside = p => p && p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
      this.selection = drag.additive ? new Set(drag.previousSelection) : new Set();
      const ctx = this.ctx();
      for (const lp of this.model.state.lonePairs) if (inside(M.lonePairPosition(lp, ctx))) this.selection.add(lp.id);
      for (const ar of this.model.state.arrows) {
        const geo = M.arrowGeometry(ar, ctx);
        for (let i = 0; i <= 16; i++) {
          if (inside(M.quadPoint(geo.start, geo.control, geo.end, i / 16))) { this.selection.add(ar.id); break; }
        }
      }
      this.documentController?.selectInBox(box, drag.additive);
      this.emitSelection();
      this.render();
    }

    /* ---------------- 历史提交 ---------------- */
    /* mutator 直接改模型；提交前记录 before/after 两份快照，撤销/重做都恢复到确定状态 */
    commit(mutator, label) {
      const before = this.model.cloneState();
      try {
        mutator();
      } catch (e) {
        this.model.setState(before, 'silent');
        this.status('操作失败：' + (e && e.message ? e.message : e));
        this.render();
        return false;
      }
      const after = this.model.cloneState();
      this.model.setState(after, 'silent');
      return this.commitStatePair(before, after, label);
    }

    commitStatePair(before, after, label) {
      const self = this;
      // 调用方可能先回滚到 before 再提交：这里统一切到 after，保证「提交后就是操作结果」
      this.model.setState(M.clone(after), 'silent');
      const apply = (snap) => {
        self.model.setState(M.clone(snap), 'history');
        self.pruneSelection();
        self.render();
      };
      try {
        this.adapter.pushAction(() => apply(before), () => apply(after));
      } catch (e) {
        // 历史接入失败：回滚模型，保持原状态，报错不静默
        this.model.setState(before, 'silent');
        this.render();
        this.status('无法提交到历史：' + (e && e.message ? e.message : e));
        if (root.console) console.error('[mech] 历史提交失败', e);
        return false;
      }
      this.onDirtyHint(label || '');
      this.render();
      return true;
    }

    /* ---------------- 删除 / 选择 ---------------- */
    deleteSelection() {
      if (!this.selection.size) return false;
      // The workbench delete button can be invoked with a mixed selection too.
      // Route it through the same native keyboard path as the host menu.
      if (this.doc && this.win && this.adapter.ed &&
          typeof this.adapter.ed.selection === 'function' && this.hasNativeSelection()) {
        const target = this.doc.activeElement || this.doc.body;
        const Ctor = this.win.KeyboardEvent;
        if (target && Ctor) {
          target.dispatchEvent(new Ctor('keydown', { key: 'Backspace', code: 'Backspace',
            keyCode: 8, which: 8, bubbles: true, cancelable: true }));
          return true;
        }
      }
      const ids = Array.from(this.selection);
      const oldSelection = new Set(this.selection);
      const ok = this.commit(() => {
        for (const id of ids) {
          if (!this.model.removeArrow(id)) this.model.removeLonePair(id);
        }
        this.selection.clear();
      }, '删除机理对象');
      if (!ok) {
        this.selection = oldSelection;
        this.emitSelection();
        this.render();
        return false;
      }
      this.emitSelection();
      this.status('已删除 ' + ids.length + ' 个机理对象');
      return true;
    }

    pruneSelection() {
      let changed = false;
      for (const id of Array.from(this.selection)) {
        if (!this.model.arrow(id) && !this.model.lonePair(id)) { this.selection.delete(id); changed = true; }
      }
      if (changed) this.emitSelection();
    }

    clearSelection() {
      if (!this.selection.size) return;
      this.selection.clear();
      this.emitSelection();
      this.render();
    }

    emitSelection() { this.onSelectionChange(this.selection.size, Array.from(this.selection)); }

    // 画布全选沿用原生分子选择，再补齐外置机理对象；菜单与快捷键共用此入口。
    selectAll() {
      if (this.focusedIsEditable()) return false;
      const ed = this.adapter.ed;
      if (!ed || typeof ed.selection !== 'function') return false;
      this.setTool('select');
      // 先取消尚未落下的临时预览，避免把预览分子当作已保存内容选中。
      if (typeof ed.tool === 'function') ed.tool('select');
      ed.selection('all');
      this.selection = new Set(this.model.state.arrows.map(a => a.id).concat(this.model.state.lonePairs.map(l => l.id)));
      this.emitSelection();
      this.render();
      this.prepareClipboardReceiver('copy');
      return true;
    }

    /* ---------------- 幽灵孤对持久化 ---------------- */
    materializeGhost(ghost, p, silent) {
      let made = null;
      const lp = M.makeLonePair(ghost.ownerAtomId, {
        origin: 'auto', angle: ghost.angle, refAtomId: ghost.refAtomId, angleRel: ghost.angleRel,
        radius: 0.42 * this.visualFactor(ghost.ownerAtomId)
      });
      if (silent) {
        // 与箭头同一个历史动作里提交（调用方负责）
        this.model.addLonePair(lp);
        made = lp;
        this.suppressedAuto.delete(ghost.ownerAtomId + '@' + Math.round(ghost.angle));
        this.rebuildGhosts();
        return made;
      }
      this.commit(() => {
        made = lp;
        this.model.addLonePair(lp);
        this.suppressedAuto.delete(ghost.ownerAtomId + '@' + Math.round(ghost.angle));
        this.rebuildGhosts();
      }, '标记孤对');
      if (made) {
        this.selection.clear();
        this.selection.add(made.id);
        this.emitSelection();
      }
      this.status('已标记孤对（可拖动调整方位）');
      return made;
    }

    /* ---------------- 键盘 ---------------- */
    onKeyDown(e) {
      if (editableTarget(e.target)) return;      // 文本输入框内只编辑文字
      const key = (e.key || '').toLowerCase();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && key === 'a' && !e.shiftKey && !e.altKey) {
        if (this.selectAll()) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (this.nativePasteSession) return; // 包括 Esc / 撤销：让原生放置工具按自己的语义处理

      if (key === 'escape') {
        e.preventDefault(); e.stopPropagation();
        if (this.cancelDrag()) return;
        if (this.draft || this.pastePreview) { this.cancelDraft(); return; }
        if (this.selection.size) { this.clearSelection(); return; }
        if (this.tool !== 'select') this.setTool('select');
        return;
      }
      if ((key === 'delete' || key === 'backspace') && this.selection.size) {
        this.flushNativeMarquee();
        if (this.hasNativeSelection()) {
          // The native history hook already merges clipboard cuts into the
          // exact Ketcher action. Scope this synchronous keyboard deletion to
          // the same hook, leaving the native event to delete its selection.
          const sequence = ++this.nativePasteSequence;
          const token = 'native-delete-' + sequence;
          const pending = { ids: Array.from(this.selection), documentIds: [...(this.documentController?.selection || [])], stepRuntime: MW.app?.reactionSteps?.captureRuntime?.(), sequence, token, consumed: false };
          this.pendingNativeCuts.set(token, pending);
          const ed = this.adapter.ed;
          ed.molstudioClipboardCutToken = token;
          setTimeout(() => {
            if (ed.molstudioClipboardCutToken === token) delete ed.molstudioClipboardCutToken;
            this.pendingNativeCuts.delete(token);
          }, 0);
        } else {
          e.preventDefault(); e.stopPropagation();
          this.deleteSelection();
        }
        return;
      }
      // Copy/Cut/Paste 都交给原生快捷键；箭头扩展只在真实 DOM 剪贴板事件里处理。
      if (meta && key === 'a' && this.tool === 'select') {
        // 保留浏览器中的 Shift 组合：只全选机理对象。
        if (e.shiftKey) {
          e.preventDefault(); e.stopPropagation();
          this.selection = new Set(this.model.state.arrows.map(a => a.id).concat(this.model.state.lonePairs.map(l => l.id)));
          this.emitSelection();
          this.render();
        }
        return;
      }
      if ((this.tool !== 'select' || this.pastePreview) && !meta && !e.altKey &&
          (/^[1-8hcnospfblit+=-]$/.test(key) || key === 'delete' || key === 'backspace' || key === 'tab')) {
        // 原生画键/元素/选择快捷键接管后，机理工具不能继续吞掉下一次画布点击。
        this.setTool('select');
      }
    }

    /* ---------------- 复制 / 粘贴 ----------------
     * macOS 菜单、快捷键和工具栏进入同一组真实 DOM 剪贴板事件。
     * 联合选区只追加箭头 MIME，分子的读写与放置交给 Ketcher；
     * 只有纯箭头通过宿主专用 NSPasteboard 类型（浏览器使用 navigator.clipboard）。
     * 载荷永远是「一次复制的完整快照」，粘贴以系统剪贴板的当前内容为准：
     * 用户后来复制了分子或文本，旧箭头就作废，不会被内部缓存顶上来。
     */

    // 与 Ketcher 自己的 mouseup 准备方式一致。只准备事件接收器，不序列化结构。
    prepareClipboardReceiver(command) {
      if (!['copy', 'cut', 'paste'].includes(command) || this.focusedIsEditable()) return false;
      if (command !== 'paste') this.flushNativeMarquee();
      if (command !== 'paste' && !this.selection.size && !this.documentController?.selection.size && !this.hasNativeSelection()) return false;
      const ed = this.adapter.ed;
      const cliparea = this.doc && this.doc.querySelector && this.doc.querySelector('[data-cliparea="true"]');
      if (!cliparea || !ed || typeof ed.focusCliparea !== 'function') return false;
      try {
        ed.focusCliparea();
        if (command !== 'paste') {
          cliparea.value = ' ';
          cliparea.select();
        }
        return true;
      } catch (e) { return false; }
    }

    /* 只读：把选中的机理对象打包成可粘贴的载荷（不修改文档、不进历史） */
    buildCopyPayload(options) {
      // 焦点在文本输入框里时，⌘C 必须是复制文字：机理选中还在也照样让路
      const native = this.hasNativeSelection();
      if (this.focusedIsEditable() || (native && !(options && options.allowNative))) return null;
      const arrows = this.selectedArrows().map(a => M.clone(a));
      const documentFragment = this.documentController?.clipboardFragment();
      const reactionSteps = native ? MW.app?.reactionSteps?.captureClipboard?.() : null;
      const capturedIdentity = MW.documentClipboard?.capture(this);
      const linkedPreview = documentFragment?.objects?.some(object => object.kind === 'molecule3d' && object.source?.atomUuids?.length);
      const identity = capturedIdentity && (arrows.length || capturedIdentity.lonePairs.length || reactionSteps?.steps?.length || linkedPreview) ? capturedIdentity : null;
      if (!arrows.length && !documentFragment && !identity?.lonePairs.length && !reactionSteps?.steps?.length) return null;

      // 端点的「实际绘制位置」：只复制箭头时绑定端点会转成自由端点，
      // 没有这个坐标，两端会一起落到 (0,0) 叠成一个点（看起来就是箭头消失了）。
      // 存的是画出来的那一点（已含标签避让），粘贴后偏移过去与原件同形。
      const ctx = this.ctx();
      for (const a of arrows) {
        let geo = null;
        try { geo = M.arrowGeometry(a, ctx); } catch (e) { geo = null; }
        if (geo && geo.sourceOk && a.source.type !== 'free') a.source.last = { x: geo.start.x, y: geo.start.y };
        if (geo && geo.targetOk && a.target.type !== 'free') a.target.last = { x: geo.end.x, y: geo.end.y };
        if (geo && geo.sourceOk && geo.targetOk && geo.control) {
          const dx = geo.end.x - geo.start.x, dy = geo.end.y - geo.start.y;
          const len2 = dx * dx + dy * dy;
          if (len2 > 1e-12) {
            const cx = geo.control.x - geo.start.x, cy = geo.control.y - geo.start.y;
            a.geometry.controlFrame = { along: (cx * dx + cy * dy) / len2, normal: (dx * cy - dy * cx) / len2 };
          }
        }
      }

      const payload = {
        kind: CLIP_KIND, version: CLIP_VERSION,
        arrows: arrows, lonePairs: identity?.lonePairs.map(item => M.clone(item.lonePair)) || [],
        selectedMechanismIds: [...new Set(arrows.map(a => a.id).concat(identity?.selectedMechanismIds || []))]
      };
      if (native) payload.native = true;
      if (documentFragment) payload.document = documentFragment;
      const usedSteps = new Set(arrows.map(arrow => arrow.stepId));
      const mechanismSteps = (this.model.state.steps || []).filter(step => usedSteps.has(step.id));
      if (mechanismSteps.length) payload.mechanismSteps = M.clone(mechanismSteps);
      if (identity) payload.identity = identity;
      if (reactionSteps?.steps?.length) payload.reactionSteps = reactionSteps;
      return payload;
    }

    /* 直接查询原生结构、原生箭头和文字等选区，不向其中伪造机理对象。 */
    hasNativeSelection() {
      const sel = this.adapter.selection();
      if (sel.atoms.length > 0 || sel.bonds.length > 0 || (sel.others || 0) > 0) return true;
      const raw = this.adapter.ed.selection();
      return !!raw && Object.values(raw).some(value => Array.isArray(value) && value.length > 0);
    }

    /* 兼容调用入口；这里不导出 KET、不构造分子片段。 */
    async buildCopyPayloadFresh() { try { return this.buildCopyPayload(); } catch (error) { this.status(error.message); return null; } }

    /* 打包并等待系统剪贴板确认；不修改文档。 */
    async copySelection() {
      if (this.focusedIsEditable()) return false;
      const payload = await this.buildCopyPayloadFresh();
      if (!payload) return false;
      if (!(await this.writeClipboard(JSON.stringify(payload)))) return false;
      this.status('已复制 ' + describePayload(payload));
      return true;
    }

    async cutSelection() {
      if (this.focusedIsEditable()) return false;
      const payload = await this.buildCopyPayloadFresh();
      if (!payload) return false;
      if (!(await this.writeClipboard(JSON.stringify(payload)))) return false;
      return this.cutAfterCopy(payload);
    }

    cutAfterCopy(payload) {
      if (!payload) return false;
      // 不能用异步操作完成时的当前选区代替刚复制的对象。
      if (payload.includeMolecules || payload.molecules) {
        this.status('请重新选择分子，使用原生剪切');
        return false;
      }
      if (payload.document?.objects?.length) return this.documentController?.cutFragment(payload);
      const ids = Array.isArray(payload.selectedMechanismIds) ? payload.selectedMechanismIds : (payload.arrows || []).map(a => a.id).concat((payload.lonePairs || []).map(l => l.id));
      if (!ids.length) return false;
      const ok = this.commit(() => {
        for (const id of ids) if (!this.model.removeArrow(id)) this.model.removeLonePair(id);
      }, '剪切机理对象');
      if (!ok) return false;
      this.pruneSelection();
      this.status('已剪切 ' + ids.length + ' 个机理对象（可撤销）');
      return true;
    }

    hasNativeClipboardBridge() {
      const bridge = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.k3d;
      return !!(bridge && typeof bridge.postMessage === 'function');
    }

    /* 仅写机理扩展载荷，普通复制由 WebKit / Ketcher 写系统剪贴板。 */
    async writeClipboard(text) {
      try {
        if (this.hasNativeClipboardBridge()) {
          const bridge = root.webkit.messageHandlers.k3d;
          const requestId = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          if (!this.pendingClipboardWrites) this.pendingClipboardWrites = new Map();
          const ok = await new Promise(resolve => {
            const timer = setTimeout(() => { this.pendingClipboardWrites.delete(requestId); resolve(false); }, 3000);
            this.pendingClipboardWrites.set(requestId, result => { clearTimeout(timer); resolve(result); });
            try { bridge.postMessage({ act: 'clipboardWrite', text: text, requestId: requestId }); }
            catch (e) { clearTimeout(timer); this.pendingClipboardWrites.delete(requestId); resolve(false); }
          });
          if (!ok) throw new Error('宿主未确认写入');
        } else {
          const nav = this.win && this.win.navigator;
          if (!nav || !nav.clipboard || !nav.clipboard.writeText) throw new Error('系统剪贴板不可用');
          await nav.clipboard.writeText(text);
        }
        return true;
      } catch (e) {
        this.lastClipboardError = String(e && e.message || e);
        this.status('系统剪贴板写入失败：' + this.lastClipboardError);
        return false;
      }
    }

    clipboardWriteResult(requestId, ok) {
      const pending = this.pendingClipboardWrites && this.pendingClipboardWrites.get(requestId);
      if (!pending) return false;
      this.pendingClipboardWrites.delete(requestId);
      pending(ok === true);
      return true;
    }

    /* 读系统剪贴板：以真实内容为准。
       读到的空字符串就是「剪贴板是空的」，绝不回退到旧载荷——那正是「旧缓存抢粘贴」的成因。 */
    async readClipboard() {
      try {
        const nav = this.win.navigator;
        if (nav && nav.clipboard && nav.clipboard.readText) {
          const t = await nav.clipboard.readText();
          if (typeof t === 'string') return t;
        }
      } catch (e) { /* 无权限/不支持：走下面的兜底 */ }
      // 跨应用复制不会触发本页 copy 事件；读不到系统内容时不能猜测旧缓存仍有效。
      return '';
    }

    /* 原生宿主桥（canvas.html 里的 window.webkit.messageHandlers.k3d） */
    notifyHost(msg) {
      try {
        const w = root;
        const b = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.k3d;
        if (b && typeof b.postMessage === 'function') { b.postMessage(msg); return true; }
      } catch (e) { /* 非原生宿主 */ }
      return false;
    }

    isMechanismPayload(text) {
      if (!text || typeof text !== 'string') return false;
      if (text.indexOf(CLIP_KIND) < 0) return false;      // 便宜的预筛，避免每次粘贴都 JSON.parse
      try { const o = JSON.parse(text); return !!o && o.kind === CLIP_KIND; } catch (e) { return false; }
    }

    /* 页面读不到载荷时，向原生宿主要一次（paste 事件只给得到纯文本） */
    requestNativePaste() {
      return this.notifyHost({ act: 'clipboardRead' });
    }

    /* 原生 DOM 复制/剪切的箭头扩展；联合选区仅追加格式，不接管原生内容。 */
    onCopyEvent(e, cut) {
      if (!e || editableTarget(e.target)) return false;
      this.flushNativeMarquee();
      this.pendingNativeCut = null;
      const native = this.hasNativeSelection();
      let payload;
      try { payload = this.buildCopyPayload({ allowNative: native }); } catch (error) { e.preventDefault(); e.stopPropagation(); this.status(error.message); return true; }
      if (!payload) return false;
      if (native) {
        // 仅追加箭头 sidecar，Ketcher 自己继续写入分子格式及执行原生剪切。
        // 不阻止事件、不写系统剪贴板、不读取或重建分子片段。
        if (!e.clipboardData || typeof e.clipboardData.setData !== 'function') {
          e.preventDefault(); e.stopPropagation();
          this.status('箭头无法写入剪贴板，未复制或剪切所选片段');
          return true;
        }
        try { e.clipboardData.setData(CLIP_MIME, JSON.stringify(payload)); }
        catch (err) {
          e.preventDefault(); e.stopPropagation();
          this.status('箭头无法写入剪贴板：' + err.message);
          return true;
        }
        if (cut) {
          const sequence = ++this.nativePasteSequence;
          this.pendingNativeCut = { ids: payload.selectedMechanismIds.slice(), sequence: sequence,
            token: 'native-cut-' + sequence, documentIds: payload.document?.objects?.map(o => o.id) || [], stepRuntime: MW.app?.reactionSteps?.captureRuntime?.(), consumed: false };
          this.pendingNativeCuts.set(this.pendingNativeCut.token, this.pendingNativeCut);
        }
        else setTimeout(() => {
          // 原生复制完成后会清空原生选区；同步清掉同一份箭头选区，避免再次 Cmd+C
          // 把刚复制的混合片段意外覆盖成只有箭头。异步期间的新选区不受影响。
          if (!e.defaultPrevented || this.hasNativeSelection()) return;
          const documentIds = payload.document?.objects?.map(o => o.id) || [];
          if (this.documentController && this.documentController.selection.size === documentIds.length && documentIds.every(id => this.documentController.selection.has(id))) { this.documentController.selection.clear(); this.documentController.render(); this.documentController.emit(); }
          const ids = payload.selectedMechanismIds;
          if (this.selection.size === ids.length && ids.every(id => this.selection.has(id))) {
            this.selection.clear(); this.emitSelection(); this.render();
            this.status('已复制所选内容（含 ' + ids.length + ' 根箭头）');
          }
        }, 0);
        return true;
      }
      e.preventDefault(); e.stopPropagation();
      // In browser mode, keep synchronous DataTransfer writes (avoids async
      // Clipboard permission prompts). In native WKWebView mode, route pure
      // mechanism/document copies exclusively through the Swift host bridge so
      // raw JSON never leaks into NSPasteboard .string via text/plain.
      if (!this.hasNativeClipboardBridge() && e.clipboardData && typeof e.clipboardData.setData === 'function') {
        try {
          const text = JSON.stringify(payload);
          e.clipboardData.setData(CLIP_MIME, text);
          e.clipboardData.setData('text/plain', text);
        } catch (error) { this.status('剪贴板写入失败，未剪切内容：' + error.message); return true; }
        if (cut) this.cutAfterCopy(payload);
        else this.status('已复制 ' + describePayload(payload));
        return true;
      }
      this.writeClipboard(JSON.stringify(payload)).then(ok => {
        if (!ok) return;
        if (cut) this.cutAfterCopy(payload);
        else this.status('已复制 ' + describePayload(payload));
      });
      return true;
    }

    /* DOM paste 事件：剪贴板确实是我们的载荷才接管，其余原样交给 Ketcher / 输入框 */
    onPasteEvent(e) {
      if (!e) return;
      const data = e.clipboardData;
      if (!data) return;
      let text = '';
      try { text = data.getData('text/plain') || ''; } catch (err) { text = ''; }
      let sidecar = '';
      try { sidecar = data.getData(CLIP_MIME) || ''; } catch (err) { /* WebKit 可能隐藏自定义类型 */ }
      this.pendingNativeCut = null;
      let mixed = false;
      try { mixed = this.isMechanismPayload(sidecar) && JSON.parse(sidecar).native === true; } catch (err) { /* 无效 sidecar 不能影响原生粘贴 */ }
      if (mixed && !editableTarget(e.target)) {
        // 原生分子解析与鼠标放置照常进行；箭头只等待其精确位移和同一个历史动作。
        if (!this.stageNativePaste(sidecar)) { e.preventDefault(); e.stopPropagation(); this.status(this.lastStatusText || '混合片段无效，未粘贴任何内容'); }
        return;
      }
      this.cancelNativePaste();
      // 用户重新粘贴原生内容时，把画布立即交回 Ketcher 的放置工具。
      if (this.pastePreview && !this.isMechanismPayload(text)) this.cancelDraft();
      if (!text && !editableTarget(e.target)) {
        // WebKit may hide custom pasteboard types from the event. Ask the host
        // to check its real clipboard, while leaving the native event untouched.
        this.requestNativePaste();
        return;
      }
      if (!this.isMechanismPayload(text)) return;
      if (editableTarget(e.target)) {
        // 输入框里不要把这串 JSON 插进去
        e.preventDefault();
        e.stopPropagation();
        this.status('文本框里不粘贴机理对象');
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.beginPasteText(text);
    }

    /* 焦点是否在可编辑文本里（iframe 与顶层文档都要看） */
    focusedIsEditable() {
      try {
        if (editableTarget(this.doc.activeElement)) return true;
        const top = root.document;
        if (top && top.activeElement && top.activeElement !== top.body && editableTarget(top.activeElement)) return true;
      } catch (e) { /* 跨文档不可读 */ }
      return false;
    }

    /* 浏览器路径：从系统剪贴板读一次再粘贴 */
    async pasteClipboard() {
      let text = '';
      try { text = await this.readClipboard(); } catch (e) { text = ''; }
      if (!this.isMechanismPayload(text)) return false;
      return this.beginPasteText(text);
    }

    nextPasteOffset(text) {
      if (this.pasteSourceText !== text) { this.pasteSourceText = text; this.pasteSeq = 0; }
      return PASTE_OFFSET * ((this.pasteSeq || 0) + 1);
    }

    async pasteText(text) {
      if (this.pasteBusy) { this.status('正在粘贴，请稍候'); return false; }
      this.pasteBusy = true;
      try { return await this.performPaste(text); }
      finally { this.pasteBusy = false; }
    }

    parsePastePayload(text) {
      if (!this.isMechanismPayload(text) || this.focusedIsEditable()) return false;
      let payload;
      try { payload = JSON.parse(text); } catch (e) { return false; }
      // 旧版自定义分子载荷不能继续经过坐标匹配，也不能伪装成原生分子数据。
      if (payload.molecules || payload.includeMolecules) {
        this.status('剪贴板是旧版分子副本，请重新选择分子并复制（使用原生复制粘贴）');
        return false;
      }
      const errors = [];
      if (payload.version !== CLIP_VERSION || !Array.isArray(payload.arrows) || !Array.isArray(payload.lonePairs)) return false;
      M.validateMechanism({ arrows: payload.arrows, lonePairs: payload.lonePairs }, errors);
      if (errors.length) { this.status('机理剪贴板数据无效'); return false; }
      if (!payload.arrows.length && !payload.document?.objects?.length && !payload.identity?.lonePairs?.length && !payload.nativeOnly && !payload.reactionSteps?.steps?.length) {
        this.status('孤对依附于原子；请在目标原子上用孤对工具添加');
        return false;
      }
      if (payload.mechanismSteps !== undefined) {
        const errors = []; M.validateMechanism({ arrows: [], lonePairs: [], steps: payload.mechanismSteps }, errors);
        if (errors.length || payload.mechanismSteps.length > 200 || payload.mechanismSteps.some(step => typeof step.label !== 'string' || step.label.length > 1000)) { this.status('复制片段的机理步骤无效'); return false; }
      }
      if (payload.reactionSteps) {
        const check = MW.reactionStepClipboard?.validate(payload.reactionSteps);
        if (!check?.ok || !MW.app?.reactionSteps?.appendClipboard) { this.status(check?.errors?.join('；') || '反应步骤粘贴模块尚未就绪'); return false; }
      }
      if (payload.identity) { try { MW.documentClipboard.validate(payload.identity); } catch (e) { this.status(e.message); return false; } }
      if (payload.document) { try { if (!this.documentController?.prepareFragment(payload.document)) return false; } catch (e) { this.status(e.message); return false; } }
      return payload;
    }

    prepareMechanismClipboardSteps(steps) {
      const idMap = new Map(), copies = (steps || []).map(step => { const id = M.newId('step'); idMap.set(step.id, id); return { id, label: step.label }; });
      return { steps: copies, idMap };
    }
    detachedArrows(payload, offsetX, offsetY) {
      return payload.arrows.map(ar => {
        const src = this.detachedEndpoint(ar.source, offsetX, offsetY);
        const tgt = this.detachedEndpoint(ar.target, offsetX, offsetY);
        if (!src || !tgt) throw new Error('箭头端点已失效，请重新复制');
        const g = ar.geometry || {};
        return M.makeArrow(src, tgt, { electronCount: ar.electronCount, bend: g.bend,
          mode: g.mode === 'auto' ? 'auto' : 'manual', routeVersion: g.routeVersion || 0,
          controlFrame: g.controlFrame, stepId: ar.stepId });
      });
    }

    // 分子和箭头同一次粘贴：这里只暂存箭头，分子的解析、归一化和放置均由原生执行。
    stageNativePaste(text) {
      this.cancelNativePaste();
      if (typeof this.adapter.ed.tool === 'function') this.adapter.ed.tool('select');
      this.pendingNativeCut = null;
      const payload = this.parsePastePayload(text);
      if (!payload || payload.native !== true) return false;
      let arrows;
      try { arrows = this.detachedArrows(payload, 0, 0); }
      catch (e) { this.status('箭头粘贴失败：' + e.message); return false; }
      this.cancelDraft();
      this.setTool('select');
      this.suppressPasteMouse = false;
      this.nativeMarquee = null;
      const token = 'native-paste-' + (++this.nativePasteSequence);
      this.lastNativePasteResult = null;
      const nativeStruct = this.adapter.struct?.() || {};
      const mechanismSteps = this.prepareMechanismClipboardSteps(payload.mechanismSteps);
      const beforeNativePools = Object.fromEntries(['atoms', 'bonds', 'frags', 'rxnArrows', 'texts', 'rxnPluses', 'simpleObjects', 'images', 'multitailArrows', 'sgroups'].map(map => [map, new Set(nativeStruct[map]?.keys() || [])]));
      this.nativePasteSession = { token: token, sourceArrows: arrows, arrows: [], document: this.documentController?.prepareFragment(payload.document), originalArrows: M.clone(payload.arrows),
        lonePairSession: payload.identity ? MW.documentClipboard.stage(payload.identity, this) : null, reactionSteps: payload.reactionSteps || null, mechanismSteps, beforeNativePools,
        historyPtr: this.adapter.ed.historyPtr, historyStack: this.adapter.ed.historyStack?.slice(), historyTop: this.adapter.ed.historyStack?.[this.adapter.ed.historyPtr - 1], active: false };
      return token;
    }

    nativePasteToken() { return this.nativePasteSession ? this.nativePasteSession.token : null; }

    startNativePaste(meta) {
      const session = this.nativePasteSession;
      if (!session || !meta || session.token !== meta.token) return false;
      if (!Object.prototype.hasOwnProperty.call(session, 'historyPtr')) {
        session.historyPtr = this.adapter.ed.historyPtr;
        session.historyTop = this.adapter.ed.historyStack && this.adapter.ed.historyStack[session.historyPtr - 1];
      }
      return this.moveNativePaste(meta);
    }

    moveNativePaste(meta) {
      const session = this.nativePasteSession;
      if (!session || !meta || !meta.token || session.token !== meta.token) return false;
      const scale = meta.scale === undefined ? 1 : meta.scale;
      const rotation = meta.rotation === undefined ? 0 : meta.rotation;
      if (!M.finite(scale) || scale <= 0 || !M.finite(rotation)) return false;
      const origin = meta.origin || { x: 0, y: 0 };
      const target = meta.target || meta.offset;
      if (!target || ![origin.x, origin.y, target.x, target.y].every(M.finite)) return false;
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      const transform = point => {
        const x = point.x * scale - origin.x, y = point.y * scale - origin.y;
        return { type: 'free', x: x * cos - y * sin + target.x, y: x * sin + y * cos + target.y };
      };
      session.arrows = session.sourceArrows.map(ar => {
        const copy = M.clone(ar);
        copy.source = transform(ar.source); copy.target = transform(ar.target);
        return copy;
      });
      session.active = true; session.meta = M.clone(meta);
      if (session.lonePairSession) MW.documentClipboard.move(session.lonePairSession, meta);
      this.documentController?.transformFragment(session.document, meta);
      this.render();
      return true;
    }

    cancelNativePaste(token, temporary) {
      const session = this.nativePasteSession;
      // 原生旧 PasteTool 可能没有 token；它的取消回调不能清掉新的联合粘贴。
      // 只有控制器内部的无参调用表示重置全部，原生回调必须严格匹配本次 token。
      if (!session || (arguments.length > 0 && session.token !== token)) return false;
      if (temporary) session.active = false;
      else this.nativePasteSession = null;
      this.documentController?.clearFragmentPreview();
      this.render();
      return true;
    }

    // 保留原生 action 本身及其全部字段/原型，只把箭头状态加入同一个反向动作。
    wrapNativeHistory(action, before, after, beforeSelection, afterSelection) {
      if (!action || typeof action.perform !== 'function') throw new Error('原生历史动作不可用');
      const controller = this, originalPerform = action.perform;
      action.perform = function () {
        const inverse = originalPerform.apply(this, arguments);
        controller.model.setState(M.clone(before), 'history');
        controller.selection = new Set(beforeSelection);
        controller.pruneSelection();
        controller.emitSelection(); controller.render();
        return controller.wrapNativeHistory(inverse, after, before, afterSelection, beforeSelection);
      };
      return action;
    }

    wrapNativePoolHistory(action, before, after) {
      const controller = this, original = action.perform;
      action.perform = function () {
        const inverse = original.apply(this, arguments), st = controller.adapter.struct();
        for (const [name, ids] of Object.entries(before || {})) {
          const pool = st[name]; if (!pool?.entries || !pool?.delete || !pool?.set) continue;
          const values = new Map(pool.entries()), order = [...ids].filter(id => values.has(id));
          for (const id of values.keys()) if (!order.includes(id)) order.push(id);
          for (const id of values.keys()) pool.delete(id);
          for (const id of order) pool.set(id, values.get(id));
        }
        return controller.wrapNativePoolHistory(inverse, after, before);
      };
      return action;
    }
    commitNativePaste(action, token) {
      const session = this.nativePasteSession;
      if (!session || session.token !== token || !session.active) return action;
      if (!action || typeof action.perform !== 'function') {
        this.cancelNativePaste(token);
        this.lastNativePasteResult = { ok: false, token, error: '混合内容不能融合到现有缩合组，请在空白处放置' };
        this.status(this.lastNativePasteResult.error); return action;
      }
      const before = this.model.cloneState(), beforeSelection = new Set(this.selection);
      const copies = session.arrows.map(ar => M.clone(ar));
      this.nativePasteSession = null;
      try {
        const ed = this.adapter.ed, top = ed.historyStack?.[ed.historyPtr - 1];
        let lonePairs = [], resolved = null, stepOutcome = null;
        if (session.lonePairSession) {
          resolved = MW.documentClipboard.resolve(this, session.lonePairSession);
          if (!resolved.ok) throw new Error(resolved.error);
          lonePairs = resolved.lonePairs;
          this.documentController?.remapFragmentSources?.(session.document, resolved.atomMap);
          copies.forEach((ar, index) => { for (const side of ['source', 'target']) { const endpoint = MW.documentClipboard.remapEndpoint(session.originalArrows[index][side], resolved); if (endpoint) ar[side] = endpoint; } });
        }
        if (session.reactionSteps) {
          if (top !== action || !action?.perform || !resolved) throw new Error('步骤粘贴缺少完整的原生历史或原子对应');
          const steps = MW.app.reactionSteps;
          stepOutcome = steps.appendClipboard(session.reactionSteps, resolved, { ...session.meta, beforeNativePools: session.beforeNativePools });
          steps.wrapClipboardHistory(action, stepOutcome);
          copies.forEach((arrow, index) => { const id = stepOutcome.stepIdMap.get(session.originalArrows[index].stepId); if (id) arrow.stepId = id; });
        }
        for (const step of session.mechanismSteps?.steps || []) this.model.state.steps.push(M.clone(step));
        copies.forEach((arrow, index) => { const sourceId = session.originalArrows[index].stepId; if (!stepOutcome?.stepIdMap.has(sourceId) && session.mechanismSteps?.idMap.has(sourceId)) arrow.stepId = session.mechanismSteps.idMap.get(sourceId); });
        for (const lp of lonePairs) this.model.addLonePair(lp);
        for (const ar of copies) this.model.addArrow(ar);
        const after = this.model.cloneState(), afterSelection = new Set(copies.map(ar => ar.id).concat(lonePairs.map(lp => lp.id)));
        if (top === action && action && typeof action.perform === 'function') {
          const current = this.adapter.struct(), afterPools = Object.fromEntries(Object.keys(session.beforeNativePools || {}).map(key => [key, new Set(current[key]?.keys() || [])]));
          this.wrapNativePoolHistory(action, session.beforeNativePools, afterPools);
          if (copies.length || lonePairs.length || session.mechanismSteps?.steps.length) this.wrapNativeHistory(action, before, after, beforeSelection, afterSelection);
          this.documentController?.commitNativeFragment(action, session.document);
          this.selection = afterSelection;
          this.onDirtyHint('粘贴所选内容');
        } else {
          if (ed.historyPtr !== session.historyPtr || top !== session.historyTop) throw new Error('原生历史已变化，无法合并粘贴内容');
          this.model.setState(before, 'silent'); this.selection = afterSelection;
          if (session.document) this.documentController.pasteFragment(session.document, copies, lonePairs, session.mechanismSteps?.steps);
          else if (copies.length || lonePairs.length || session.mechanismSteps?.steps.length) {
            if (!this.commitStatePair(before, after, '粘贴机理对象')) throw new Error('无法提交到历史');
          }
        }
        // Post-native step label replacement runs after Ketcher's paste update.
        // Refresh its text bounds before a save/export can observe the action.
        if (stepOutcome?.inverses.length) ed.update(true);
        this.documentController?.clearFragmentPreview(); this.emitSelection(); this.render();
        this.lastNativePasteResult = { ok: true, token };
        this.status('已粘贴所选内容（可一次撤销）');
      } catch (e) {
        const ed = this.adapter.ed, top = ed.historyStack?.[ed.historyPtr - 1];
        if (top === action) {
          try {
            action.perform(ed.render.ctab);
            if (session.historyStack) { ed.historyStack = session.historyStack; ed.historyPtr = session.historyPtr; }
            else { ed.historyStack.splice(ed.historyPtr - 1, 1); ed.historyPtr--; }
            ed.update(true);
          } catch (rollbackError) { this.status('粘贴恢复失败：' + rollbackError.message); }
        }
        this.model.setState(before, 'silent'); this.selection = beforeSelection;
        this.documentController?.clearFragmentPreview(); this.emitSelection(); this.render();
        this.lastNativePasteResult = { ok: false, token, error: e && e.message ? e.message : String(e) };
        this.status('粘贴失败，已撤回本次放置：' + (e && e.message ? e.message : e));
      }
      return action;
    }

    nativeCutToken() { return this.pendingNativeCut ? this.pendingNativeCut.token : null; }

    cancelNativeCut(token) {
      if (!token) this.pendingNativeCuts.clear();
      else this.pendingNativeCuts.delete(token);
      if (this.pendingNativeCut && (!token || this.pendingNativeCut.token === token)) this.pendingNativeCut = null;
    }

    nativeCutEnd(token) {
      // 同一原生 debounce 只执行最后一份调用；完成时比它更早的未执行快照也已被合并。
      // 无混合 token 的原生剪切完成同样意味着更早的混合调用没有执行。
      if (!token) { this.cancelNativeCut(); return; }
      const match = /^native-cut-(\d+)$/.exec(token);
      if (!match) { this.cancelNativeCut(token); return; }
      const completed = Number(match[1]);
      for (const [key, cut] of this.pendingNativeCuts) {
        if (cut.sequence <= completed) this.pendingNativeCuts.delete(key);
      }
      if (this.pendingNativeCut && this.pendingNativeCut.sequence <= completed) this.pendingNativeCut = null;
    }

    nativeClipboardHistory(action, token) {
      const cut = token && this.pendingNativeCuts.get(token);
      if (!cut || cut.consumed || !action || typeof action.perform !== 'function') return action;
      cut.consumed = true;
      if (this.pendingNativeCut && this.pendingNativeCut.token === token) this.pendingNativeCut = null;
      const before = this.model.cloneState(), beforeSelection = new Set(this.selection);
      try {
        for (const id of cut.ids) {
          if (!this.model.removeArrow(id)) this.model.removeLonePair(id);
        }
        const after = this.model.cloneState();
        const afterSelection = new Set([...beforeSelection].filter(id => !cut.ids.includes(id)));
        if (cut.stepRuntime && MW.app?.reactionSteps?.wrapClipboardHistory) MW.app.reactionSteps.wrapClipboardHistory(action, { before: cut.stepRuntime, after: MW.app.reactionSteps.captureRuntime(), inverses: [], stepIdMap: new Map() });
        this.wrapNativeHistory(action, before, after, beforeSelection, afterSelection);
        this.documentController?.commitNativeCut(action, cut.documentIds);
        this.selection = afterSelection;
        this.emitSelection(); this.render();
        const deleting = token.indexOf('native-delete-') === 0;
        this.onDirtyHint(deleting ? '删除所选内容' : '剪切分子和箭头');
        this.status((deleting ? '已删除' : '已剪切') + '所选内容（含 ' + cut.ids.length + ' 个机理对象，可撤销）');
      } catch (e) {
        this.model.setState(before, 'silent');
        this.selection = beforeSelection;
        this.emitSelection(); this.render();
        this.status('箭头剪切失败：' + (e && e.message ? e.message : e));
      }
      return action;
    }

    // UI 粘贴：只建立跟随鼠标的箭头预览，点击时才提交到现有历史。
    beginPasteText(text) {
      const payload = this.parsePastePayload(text);
      if (!payload || payload.native === true) return false;
      let arrows;
      try { arrows = this.detachedArrows(payload, 0, 0); }
      catch (e) { this.status('粘贴失败：' + e.message); return false; }
      const documentFragment = this.documentController?.prepareFragment(payload.document);
      const mechanismSteps = this.prepareMechanismClipboardSteps(payload.mechanismSteps);
      arrows.forEach((arrow, index) => { const id = mechanismSteps.idMap.get(payload.arrows[index].stepId); if (id) arrow.stepId = id; });
      const points = [];
      for (const o of documentFragment?.objects || []) points.push({ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h });
      for (const ar of arrows) {
        const geo = M.arrowGeometry(ar, this.ctx());
        points.push(geo.start, geo.control, geo.end);
      }
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const anchor = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
      this.cancelDraft();
      this.cancelNativePaste();
      this.setTool('select');
      // 取消尚未放下的原生片段；此后分子仍完全由 Ketcher 自己的 PasteTool 处理。
      if (this.adapter.ed && typeof this.adapter.ed.tool === 'function') this.adapter.ed.tool('select');
      this.adapter.clearSelection();
      this.selection.clear();
      this.hover = null;
      this.pastePreview = { sourceArrows: arrows, arrows: arrows, anchor: anchor, document: documentFragment, mechanismSteps: mechanismSteps.steps };
      let pointer = this.lastPointer && this.lastPointer.model;
      const area = this.adapter.ed && this.adapter.ed.render && this.adapter.ed.render.clientArea;
      if (!pointer && area && typeof area.getBoundingClientRect === 'function') {
        const rect = area.getBoundingClientRect();
        pointer = this.adapter.clientToModel({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }
      this.movePastePreview(pointer || anchor);
      this.emitSelection();
      this.render();
      this.status('移动鼠标放置 ' + arrows.length + ' 根箭头，点击确认，Esc 取消');
      return true;
    }

    movePastePreview(point) {
      const preview = this.pastePreview;
      if (!preview || !point || !M.finite(point.x) || !M.finite(point.y)) return;
      const dx = point.x - preview.anchor.x, dy = point.y - preview.anchor.y;
      this.documentController?.transformFragment(preview.document, { offset: { x: dx, y: dy } });
      preview.arrows = preview.sourceArrows.map(ar => {
        const copy = M.clone(ar);
        copy.source.x += dx; copy.source.y += dy;
        copy.target.x += dx; copy.target.y += dy;
        return copy;
      });
    }

    finishPastePreview(point) {
      if (!this.pastePreview) return false;
      this.movePastePreview(point);
      const arrows = this.pastePreview.arrows;
      if (this.pastePreview.document) { const fragment = this.pastePreview.document, steps = this.pastePreview.mechanismSteps; this.pastePreview = null; return this.documentController.pasteFragment(fragment, arrows, [], steps); }
      const before = this.model.cloneState(), oldSelection = new Set(this.selection), mechanismSteps = this.pastePreview.mechanismSteps || [];
      this.pastePreview = null;
      try {
        for (const step of mechanismSteps) this.model.state.steps.push(M.clone(step));
        for (const ar of arrows) this.model.addArrow(M.clone(ar));
        const after = this.model.cloneState();
        this.model.setState(before, 'silent');
        this.selection = new Set(arrows.map(ar => ar.id));
        if (!this.commitStatePair(before, after, '粘贴箭头')) throw new Error('无法提交到历史');
        this.emitSelection();
        this.status('已粘贴 ' + arrows.length + ' 根箭头（自由端点，可重新绑定）');
        return true;
      } catch (e) {
        this.model.setState(before, 'silent');
        this.selection = oldSelection;
        this.emitSelection(); this.render();
        this.status('粘贴失败：' + (e && e.message ? e.message : e));
        return false;
      }
    }

    async performPaste(text) {
      const payload = this.parsePastePayload(text);
      if (!payload) return false;
      const offset = this.nextPasteOffset(text);
      if (payload.document) { const fragment = this.documentController.prepareFragment(payload.document); this.documentController.transformFragment(fragment, { offset: { x: offset, y: offset } }); return this.documentController.pasteFragment(fragment, this.detachedArrows(payload, offset, offset)); }
      const before = this.model.cloneState(), oldSelection = new Set(this.selection);
      const madeArrows = [];
      try {
        for (const copy of this.detachedArrows(payload, offset, offset)) {
          this.model.addArrow(copy); madeArrows.push(copy.id);
        }
        const after = this.model.cloneState();
        this.model.setState(before, 'silent');
        this.selection = new Set(madeArrows);
        if (!this.commitStatePair(before, after, '粘贴箭头')) throw new Error('无法提交到历史');
        this.pasteSeq = (this.pasteSeq || 0) + 1;
        this.emitSelection();
        this.status('已粘贴 ' + madeArrows.length + ' 根箭头（自由端点，可重新绑定）');
        return true;
      } catch (e) {
        this.model.setState(before, 'silent');
        this.selection = oldSelection;
        this.emitSelection(); this.render();
        this.status('粘贴失败：' + (e && e.message ? e.message : e));
        return false;
      }
    }

    detachedEndpoint(ep, offset, offsetY) {
      if (!ep) return null;
      const p = ep.type === 'free' ? ep : ep.last;
      return p && M.finite(p.x) && M.finite(p.y)
        ? { type: 'free', x: p.x + offset, y: p.y + (offsetY === undefined ? offset : offsetY) } : null;
    }

    /* 切换选中箭头「键端点」的 σ/π 含义：改的是化学含义，不是装饰线 */
    toggleBondComponent() {
      const arrows = this.selectedArrows();
      if (arrows.length !== 1) return;
      const ar = arrows[0];
      const side = ['source', 'target'].find(x => ar[x] && ar[x].type === 'bond');
      if (!side) { this.status('该箭头没有键端点'); return; }
      const before = this.model.cloneState();
      ar[side].component = ar[side].component === 'pi' ? 'sigma' : 'pi';
      const after = this.model.cloneState();
      this.model.setState(before, 'silent');
      this.commitStatePair(before, after, '切换 σ/π');
      this.status((side === 'source' ? '来源' : '目标') + '已切换为 ' + (ar[side].component === 'pi' ? 'π' : 'σ') + ' 电子');
      this.emitSelection();
    }

    /* ---------------- 诊断 ---------------- */
    status(text) { this.lastStatusText = text; this.onStatus(text); }

    describeAtom(uuid) {
      const id = this.adapter.atomIdOf(uuid);
      const a = id === null ? null : this.adapter.struct().atoms.get(id);
      return a ? a.label : '原子';
    }

    /* 供 canvas.html 判断「只选中了机理对象」 */
    hasMechanismSelection() { return this.selection.size > 0; }
  }

  /* 状态栏文案：只数「这次复制/粘贴真的涉及到的对象」 */
  function describePayload(payload) {
    const arrows = (payload && payload.arrows) ? payload.arrows.length : 0;
    const lps = (payload && payload.lonePairs) ? payload.lonePairs.length : 0;
    if (arrows && lps) return arrows + ' 根箭头 / ' + lps + ' 个孤对';
    if (arrows) return arrows + ' 根箭头';
    if (lps) return lps + ' 个孤对';
    return '0 个机理对象';
  }

  function pointSegmentDistance(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }

  function quadDistance(p, a, c, b) {
    let best = Infinity;
    for (let i = 0; i <= 24; i++) {
      const q = M.quadPoint(a, c, b, i / 24);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best) best = d;
    }
    return best;
  }

  MW.controller = { MechanismController: MechanismController, pointSegmentDistance: pointSegmentDistance, quadDistance: quadDistance };
})(typeof window !== 'undefined' ? window : globalThis);
