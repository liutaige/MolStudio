/* MolStudio 工作台 · 机理层渲染（SVG，画在 Ketcher 画布 svg 内，结构坐标）
 * 只负责画，不修改化学结构、不写模型。缩放/平移由 group transform + 尺寸补偿跟随。
 * 依赖：mechanism-model.js、ketcher-adapter.js
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const M = MW.model;
  const NS = MW.adapter.SVG_NS;

  /* 两类尺寸，不能混用（研究/弯箭头自然缩放与自动排布-实施指令 第 3 节）：
   *
   *   1) 成品（曲线主体、线宽、箭头尖）= 规范绘图尺度 canonical()，
   *      与结构同比：放大 2 倍时线宽也变成 2 倍，和键线一样，不随 zoom 反向补偿。
   *      下面的数字是「100% 视口」下的像素值，渲染时 × canonical()。
   *   2) 交互（手柄、悬停圈、命中、草稿）= 屏幕尺度 unit()，
   *      缩放后仍保持同样的屏幕大小，且不进入导出。
   *
   * 孤对点位/点径沿用上一轮确定的「屏幕点径 + 标签固定间隙」，本轮不改。
   */
  const PX = {
    // —— 成品（规范尺度）——
    stroke: 1.9,
    arrowHeadLen: 11,
    arrowHeadAngle: 27,
    arrowHeadArcRatio: 0.34,   // 箭头尖最多占「实际弧长」的比例（不是弦长）
    arrowHeadMinLen: 4.2,      // 极短弧也不至于缩成看不清的小点
    badDash: [6, 4],
    // —— 交互（屏幕尺度）——
    dotRadius: 2.1,
    dotGap: 4.6,
    handleRadius: 5,
    draftDash: 5,
    warnRadius: 3.2
  };

  class MechanismLayer {
    constructor(adapter, doc) {
      this.adapter = adapter;
      this.doc = doc;
      this.root = null;       // <g id="molstudio-mech-layer">
      this.body = null;       // 机理内容（导出保留）
      this.overlay = null;    // 选择手柄/草稿/高亮（导出剔除）
      this.lastRender = null;
    }

    unit() {
      // 1 CSS 像素 = unit() 个结构坐标（交互尺寸：手柄/悬停/命中）
      const z = this.adapter.zoom() || 1;
      const bl = this.adapter.bondLength() || 40;
      return 1 / (z * bl);
    }

    canonical() {
      // 规范绘图尺度：1 个「100% 视口像素」= canonical() 个结构坐标。
      // 不含 zoom —— 与键线同为绘图尺度，放大缩小时同比变化；导出也用同一个值。
      const bl = this.adapter.bondLength() || 40;
      return 1 / bl;
    }

    ensure() {
      const rootG = this.adapter.ensureLayer();
      if (!rootG) return null;
      if (this.root !== rootG) {
        this.root = rootG;
        this.root.setAttribute('pointer-events', 'none');
        this.root.textContent = '';
        this.body = this.doc.createElementNS(NS, 'g');
        this.body.setAttribute('class', 'mech-body');
        this.overlay = this.doc.createElementNS(NS, 'g');
        this.overlay.setAttribute('class', 'mech-overlay');
        this.overlay.setAttribute('data-mech-ui', '1');
        this.root.appendChild(this.body);
        this.root.appendChild(this.overlay);
      }
      const off = this.adapter.offset();
      const bl = this.adapter.bondLength();
      this.root.setAttribute('transform', 'translate(' + off.x + ',' + off.y + ') scale(' + bl + ')');
      return this.root;
    }

    el(name, attrs, parent) {
      const n = this.doc.createElementNS(NS, name);
      if (attrs) for (const k of Object.keys(attrs)) {
        if (attrs[k] === undefined || attrs[k] === null) continue;
        n.setAttribute(k, String(attrs[k]));
      }
      if (parent) parent.appendChild(n);
      return n;
    }

    /* state = { model, ctx, selection:Set, hover, draft, now } */
    render(state) {
      if (!this.ensure()) return;
      const ui = this.unit();          // 交互：手柄/悬停/草稿
      const body = this.canonical();   // 成品：曲线/线宽/箭头尖
      this.lastRender = state;
      this.body.textContent = '';
      this.overlay.textContent = '';

      const model = state.model;
      const ctx = state.ctx;
      const sel = state.selection || new Set();

      this.renderLonePairs(model, ctx, ui, sel, state);
      this.renderGhosts(state, ctx, ui);
      this.renderArrows(model, ctx, body, sel, state, null, ui);
      if (state.pastePreview) {
        // 临时内容只在 overlay 里渲染；点击放置前不进入文件、导出或撤销历史。
        this.renderArrows({ state: { arrows: state.pastePreview.arrows } }, ctx, body, new Set(), state, this.overlay, ui);
      }
      if (state.nativePastePreview) {
        this.renderArrows({ state: { arrows: state.nativePastePreview.arrows } }, ctx, body, new Set(), state, this.overlay, ui);
      }
      this.renderDraft(state, ui, body);
      this.renderHover(state, ui);
    }

    /* ---------------- 孤对 ---------------- */
    /* 所属原子的视觉缩放因子：点径/间隙随所属分子的纸页实际尺寸同比 */
    atomScaleOf(uuid, ctx) {
      const f = ctx && typeof ctx.scaleOfAtom === 'function' ? ctx.scaleOfAtom(uuid) : 1;
      return M.finite(f) && f > 0 ? f : 1;
    }

    renderLonePairs(model, ctx, u, sel, state, targetGroup) {
      const parent = targetGroup || this.body;
      const forExport = !!targetGroup;
      const groups = new Map();
      for (const lp of model.state.lonePairs) {
        if (lp.visible === false) continue;
        const f = this.atomScaleOf(lp.ownerAtomId, ctx);
        const pos = M.lonePairPosition(lp, ctx);
        if (!pos) continue;                      // 所属原子不存在：不画（箭头会标失效）
        const ang = M.lonePairAngle(lp, ctx);
        const dir = { x: Math.cos(ang), y: Math.sin(ang) };
        const n = M.perp(dir);
        const gap = PX.dotGap * u * f;
        const r = PX.dotRadius * u * f;
        const selected = !forExport && sel.has(lp.id);
        const g = this.el('g', {
          class: 'mech-lone-pair',
          'data-lp': lp.id,
          'data-origin': lp.origin,
          'data-selected': selected ? '1' : '0'
        }, parent);
        for (const s of [-1, 1]) {
          this.el('circle', {
            cx: pos.x + n.x * gap * s, cy: pos.y + n.y * gap * s, r: r,
            fill: lp.origin === 'manual' ? '#0a7ea4' : '#1c1c1e'
          }, g);
        }
        if (selected) {
          const ring = this.el('circle', {
            cx: pos.x, cy: pos.y, r: 8 * u,
            fill: 'none', stroke: '#0a7ea4', 'stroke-width': 1.2 * u, 'stroke-dasharray': (3 * u) + ' ' + (2 * u)
          }, this.overlay);
          ring.setAttribute('data-mech-ui', '1');
          if (lp.ownerAtomId && ctx && ctx.atomPos) {
            const ownerPos = ctx.atomPos(lp.ownerAtomId);
            if (ownerPos) {
              this.el('circle', {
                cx: ownerPos.x, cy: ownerPos.y, r: 14 * u, fill: 'none',
                stroke: 'rgba(10,126,164,0.45)', 'stroke-width': 1.2 * u, 'stroke-dasharray': (3 * u) + ' ' + (2 * u), 'data-mech-ui': '1'
              }, this.overlay);
            }
          }
          // 方位手柄：拖动可绕原子调整
          this.el('circle', {
            cx: pos.x, cy: pos.y, r: PX.handleRadius * u,
            fill: '#fff', stroke: '#0a7ea4', 'stroke-width': 1.4 * u, 'data-mech-ui': '1', 'data-handle': 'lp-move'
          }, this.overlay);
        }
      }
    }

    /* 自动建议的孤对（幽灵）：只是显示，未持久化、不写入文件 */
    renderGhosts(state, ctx, u) {
      const ghosts = state.ghosts || [];
      if (!ghosts.length) return;
      for (const g of ghosts) {
        const f = this.atomScaleOf(g.ownerAtomId, ctx);
        const gap = PX.dotGap * u * f;
        const r = PX.dotRadius * u * 0.92 * f;
        const pos = M.lonePairPosition(g, ctx);
        if (!pos) continue;
        const ang = M.lonePairAngle(g, ctx);
        const dir = { x: Math.cos(ang), y: Math.sin(ang) };
        const n = M.perp(dir);
        const grp = this.el('g', {
          class: 'mech-lone-pair mech-ghost',
          'data-ghost': g.id,
          'data-owner': g.ownerAtomId
        }, this.body);
        for (const s of [-1, 1]) {
          this.el('circle', {
            cx: pos.x + n.x * gap * s, cy: pos.y + n.y * gap * s, r: r,
            fill: '#7a7a80', 'fill-opacity': '0.55'
          }, grp);
        }
      }
    }

    /* ---------------- 箭头 ---------------- */
    /* u     = 成品尺度（曲线主体/线宽/箭头尖，与结构同比，导出也用它）
       uUi   = 交互尺度（手柄、失效提示文字），默认与成品相同（导出时用不到交互） */
    /* 箭头视觉缩放因子：显式 arrow.scale 优先，否则取端点绑定原子的因子 */
    arrowScaleFactor(ar, ctx) {
      if (M.finite(ar.scale) && ar.scale > 0 && Math.abs(ar.scale - 1) > 1e-9) return ar.scale;
      const atoms = M.endpointAtomIds(ar.source).concat(M.endpointAtomIds(ar.target));
      for (const uuid of atoms) {
        const f = this.atomScaleOf(uuid, ctx);
        if (Math.abs(f - 1) > 1e-9) return f;
      }
      return 1;
    }

    renderArrows(model, ctx, u, sel, state, targetGroup, uUi) {
      const ui = M.finite(uUi) && uUi > 0 ? uUi : u;
      const parent = targetGroup || this.body;
      const forExport = !!targetGroup;
      for (const ar of model.state.arrows) {
        const f = this.arrowScaleFactor(ar, ctx);
        const geo = M.arrowGeometry(ar, ctx);
        const bad = !geo.sourceOk || !geo.targetOk;
        const selected = !forExport && sel.has(ar.id);
        const color = bad ? '#b45309' : (selected ? '#0a7ea4' : '#1c1c1e');
        const g = this.el('g', {
          class: 'mech-arrow',
          'data-arrow': ar.id,
          'data-electrons': ar.electronCount,
          'data-mode': (ar.geometry && ar.geometry.mode) || 'manual',
          'data-bad': bad ? '1' : '0'
        }, parent);

        if (geo.degenerate) {
          this.el('circle', { cx: geo.start.x, cy: geo.start.y, r: PX.warnRadius * ui, fill: 'none', stroke: '#b45309', 'stroke-width': 1.4 * ui }, g);
          continue;
        }
        const d = 'M ' + geo.start.x + ' ' + geo.start.y + ' Q ' + geo.control.x + ' ' + geo.control.y + ' ' + geo.end.x + ' ' + geo.end.y;
        this.el('path', {
          d: d, fill: 'none', stroke: color,
          'stroke-width': PX.stroke * u * f,
          'stroke-linecap': 'round',
          'stroke-dasharray': bad ? (PX.badDash[0] * u) + ' ' + (PX.badDash[1] * u) : null
        }, g);

        // 箭头尖：2 电子=完整 V；1 电子=半箭头（鱼钩）
        const tan = M.quadTangent(geo.start, geo.control, geo.end, 1);
        // 短箭头的尖端按「实际弧长」收敛，而不是按弦长：
        // 一条正常弧度但两端直线距离很短的箭头，不该被缩成一个小点。
        const arcLen = MW.route && MW.route.arcLength
          ? MW.route.arcLength(geo.start, geo.control, geo.end)
          : M.dist(geo.start, geo.end);
        const headLen = Math.max(
          Math.min(PX.arrowHeadLen * u * f, arcLen * PX.arrowHeadArcRatio),
          Math.min(PX.arrowHeadMinLen * u * f, arcLen * 0.5)
        );
        const ang = Math.atan2(tan.y, tan.x);
        const a1 = ang + Math.PI - (PX.arrowHeadAngle * Math.PI / 180);
        const a2 = ang + Math.PI + (PX.arrowHeadAngle * Math.PI / 180);
        const barbs = ar.electronCount === 1 ? [a1] : [a1, a2];
        for (const a of barbs) {
          this.el('path', {
            d: 'M ' + (geo.end.x + Math.cos(a) * headLen) + ' ' + (geo.end.y + Math.sin(a) * headLen) +
               ' L ' + geo.end.x + ' ' + geo.end.y,
            fill: 'none', stroke: color, 'stroke-width': PX.stroke * u * f, 'stroke-linecap': 'round'
          }, g);
        }

        // 端点失效/自由端点的提示（不属于成品，导出剔除——导出重渲染传了
        // targetGroup，文字绝不能写进副本之外的活 overlay，否则导出后残留）
        if (bad && !forExport) {
          this.el('text', {
            x: geo.end.x + 6 * ui, y: geo.end.y - 6 * ui,
            'font-size': 9 * ui, fill: '#b45309', 'data-mech-ui': '1'
          }, this.overlay).textContent = geo.targetOk ? '起点待重绑' : '终点待重绑';
        }

        if (selected) this.renderArrowHandles(ar, geo, ui);
      }
    }

    renderArrowHandles(ar, geo, u) {
      const g = this.overlay;
      const handle = (p, kind, label) => {
        const c = this.el('circle', {
          cx: p.x, cy: p.y, r: PX.handleRadius * u,
          fill: '#fff', stroke: '#0a7ea4', 'stroke-width': 1.5 * u,
          'data-mech-ui': '1', 'data-handle': kind, 'data-arrow-handle': ar.id
        }, g);
        c.setAttribute('data-label', label);
        return c;
      };
      handle(geo.start, 'arrow-start', '起点');
      handle(geo.end, 'arrow-end', '终点');
      // 曲率手柄放在曲线中点，拖它只改 bend
      const mid = M.quadPoint(geo.start, geo.control, geo.end, 0.5);
      this.el('line', {
        x1: mid.x, y1: mid.y, x2: geo.control.x, y2: geo.control.y,
        stroke: '#0a7ea4', 'stroke-width': 1 * u, 'stroke-dasharray': (3 * u) + ' ' + (3 * u), 'data-mech-ui': '1'
      }, g);
      handle(mid, 'arrow-bend', '曲率');
    }

    /* ---------------- 草稿与悬停 ---------------- */
    /* 草稿画的是「提交后会长成的样子」：曲线用成品尺度，只加虚线；端部提示用交互尺度 */
    renderDraft(state, u, uBody) {
      const d = state.draft;
      if (!d) return;
      const g = this.overlay;
      const body = M.finite(uBody) && uBody > 0 ? uBody : u;
      if (d.sourceAnchor) {
        this.el('circle', {
          cx: d.sourceAnchor.x, cy: d.sourceAnchor.y, r: PX.handleRadius * u,
          fill: '#0a7ea4', 'stroke': '#fff', 'stroke-width': 1.4 * u, 'data-mech-ui': '1'
        }, g);
      }
      const pv = d.preview;
      if (pv && pv.start && pv.end) {
        this.el('path', {
          d: 'M ' + pv.start.x + ' ' + pv.start.y + ' Q ' + pv.control.x + ' ' + pv.control.y + ' ' + pv.end.x + ' ' + pv.end.y,
          fill: 'none', stroke: '#0a7ea4', 'stroke-width': PX.stroke * body,
          'stroke-dasharray': (PX.draftDash * body) + ' ' + (4 * body), 'data-mech-ui': '1'
        }, g);
        // 预览的箭头尖（与提交后同一角度），让「松手前后一致」看得见
        const tan = M.quadTangent(pv.start, pv.control, pv.end, 1);
        const arcLen = MW.route && MW.route.arcLength ? MW.route.arcLength(pv.start, pv.control, pv.end) : M.dist(pv.start, pv.end);
        const headLen = Math.max(
          Math.min(PX.arrowHeadLen * body, arcLen * PX.arrowHeadArcRatio),
          Math.min(PX.arrowHeadMinLen * body, arcLen * 0.5)
        );
        const ang = Math.atan2(tan.y, tan.x);
        const a1 = ang + Math.PI - (PX.arrowHeadAngle * Math.PI / 180);
        const a2 = ang + Math.PI + (PX.arrowHeadAngle * Math.PI / 180);
        const barbs = d.electronCount === 1 ? [a1] : [a1, a2];
        for (const a of barbs) {
          this.el('path', {
            d: 'M ' + (pv.end.x + Math.cos(a) * headLen) + ' ' + (pv.end.y + Math.sin(a) * headLen) +
               ' L ' + pv.end.x + ' ' + pv.end.y,
            fill: 'none', stroke: '#0a7ea4', 'stroke-width': PX.stroke * body, 'data-mech-ui': '1'
          }, g);
        }
      } else if (d.pointer) {
        const a = d.sourceAnchor || d.pointer;
        const endPt = (d.targetPreview && d.targetPreview.targetPoint) ? d.targetPreview.targetPoint : d.pointer;
        const c = M.controlPoint(a, endPt, M.finite(d.bend) ? d.bend : 0);
        this.el('path', {
          d: 'M ' + a.x + ' ' + a.y + ' Q ' + c.x + ' ' + c.y + ' ' + endPt.x + ' ' + endPt.y,
          fill: 'none', stroke: '#0a7ea4', 'stroke-width': PX.stroke * body,
          'stroke-dasharray': (PX.draftDash * body) + ' ' + (4 * body), 'data-mech-ui': '1'
        }, g);
      }
      if (d.targetPreview) {
        const p = d.targetPreview;
        if (p.kind === 'formingBond' && p.a && p.b) {
          this.el('line', {
            x1: p.a.x, y1: p.a.y, x2: p.b.x, y2: p.b.y,
            stroke: '#0a7ea4', 'stroke-width': 1.4 * u, 'stroke-dasharray': (4 * u) + ' ' + (3 * u), 'data-mech-ui': '1'
          }, g);
          const tp = (pv && pv.end) || p.targetPoint || { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
          this.el('circle', {
            cx: tp.x, cy: tp.y, r: 4.5 * u, fill: '#0a7ea4', stroke: '#fff', 'stroke-width': 1.2 * u, 'data-mech-ui': '1'
          }, g);
        } else if (p.point) {
          this.el('circle', {
            cx: p.point.x, cy: p.point.y, r: 7 * u, fill: 'none',
            stroke: '#0a7ea4', 'stroke-width': 1.4 * u, 'data-mech-ui': '1'
          }, g);
        }
      }
    }

    renderHover(state, u) {
      const h = (state.draft && state.draft.sourcePreview) || state.hover;
      if (!h) return;
      const g = this.overlay;
      if (h.kind === 'lonePair' && h.point) {
        this.el('circle', { cx: h.point.x, cy: h.point.y, r: 9 * u, fill: 'rgba(10,126,164,.14)', 'data-mech-ui': '1' }, g);
        if (h.ownerAtomId && state.ctx && state.ctx.atomPos) {
          const ownerPos = state.ctx.atomPos(h.ownerAtomId);
          if (ownerPos) {
            this.el('circle', {
              cx: ownerPos.x, cy: ownerPos.y, r: 14 * u, fill: 'none',
              stroke: '#0a7ea4', 'stroke-width': 1.2 * u, 'stroke-dasharray': (3 * u) + ' ' + (2 * u), 'data-mech-ui': '1'
            }, g);
          }
        }
      } else if (h.kind === 'atom' && h.point) {
        const box = h.atomId && state.ctx.atomLabelBox ? state.ctx.atomLabelBox(h.atomId) : null;
        const rect = box && box.atomRect;
        if (rect) {
          this.el('rect', { x: rect.x1 - 3 * u, y: rect.y1 - 3 * u,
            width: rect.x2 - rect.x1 + 6 * u, height: rect.y2 - rect.y1 + 6 * u,
            rx: 4 * u, fill: 'rgba(10,126,164,.14)', stroke: '#0a7ea4', 'stroke-width': 1.6 * u,
            'data-mech-ui': '1', 'data-mech-hit': 'atom' }, g);
        } else {
          this.el('circle', { cx: h.point.x, cy: h.point.y, r: 6 * u,
            fill: 'rgba(10,126,164,.18)', stroke: '#0a7ea4', 'stroke-width': 1.6 * u,
            'data-mech-ui': '1', 'data-mech-hit': 'atom' }, g);
        }
      } else if (h.kind === 'bond' && h.a && h.b) {
        this.el('line', {
          x1: h.a.x, y1: h.a.y, x2: h.b.x, y2: h.b.y,
          stroke: 'rgba(10,126,164,.55)', 'stroke-width': 7 * u, 'stroke-linecap': 'round',
          'data-mech-ui': '1', 'data-mech-hit': 'bond'
        }, g);
      }
      if (h.label) {
        const p = h.point || (h.a && h.b ? M.lerp(h.a, h.b, 0.5) : null);
        if (p) this.renderHitLabel(h.label, p, u);
      }
    }

    renderHitLabel(label, p, u) {
      const w = Math.max(80, Math.min(340, Array.from(label).reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 11 : 6.4), 16)));
      const x = p.x + 12 * u, y = p.y - 31 * u;
      const g = this.el('g', { 'data-mech-ui': '1', 'data-mech-hit-label': '1' }, this.overlay);
      this.el('rect', { x: x, y: y, width: w * u, height: 22 * u,
        rx: 4 * u, fill: '#0a7ea4' }, g);
      this.el('text', { x: x + 7 * u, y: y + 15 * u, 'font-size': 11 * u,
        'font-family': '-apple-system, sans-serif', fill: '#fff' }, g).textContent = label;
    }

    clear() {
      if (this.body) this.body.textContent = '';
      if (this.overlay) this.overlay.textContent = '';
    }
  }

  MW.layer = { MechanismLayer: MechanismLayer, PX: PX };
})(typeof window !== 'undefined' ? window : globalThis);
