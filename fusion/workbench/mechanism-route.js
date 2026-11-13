/* MolStudio 工作台 · 弯箭头自动排布（纯几何，不依赖 DOM / Ketcher）
 *
 * 职责：给定「来源锚点 A、目标锚点 B、周边障碍」，在两侧 × 多个弧高的候选里选一条最自然的曲线，
 * 输出一个 bend（相对弦长的有符号法向偏移，正 = 结构坐标 y 向下那一侧）。
 *
 * 与渲染/命中的关系：本模块只产出 bend；真正画出来的曲线由 mechanism-model.js 的
 * controlPoint(a, b, bend) 生成 —— 预览、提交、导出、命中都用同一个函数，不会出现第二套路径。
 *
 * 单位：全部用结构坐标（键长≈1）。候选高度用「局部键长 L」归一化，评分不依赖 zoom/DPR。
 * 二次贝塞尔：control = M + side * 2h * N ⇒ 曲线中点实际弧高 = h（不是 2h）。
 *
 * 载入顺序：mechanism-model.js → 本文件 → mechanism-layer.js → mechanism-controller.js
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const M = MW.model;

  const ROUTE_VERSION = 4;

  /* 评分权重：优先级 标签 > 键 > 已有箭头 > 切线 > 间隙 > 简洁。
     数量级刻意拉开，保证「有候选不遮挡」时一定淘汰遮挡路线，而不是靠调参凑。 */
  const W = {
    label: 1000,       // 压到无关原子标签（最高代价）
    labelDepth: 320,   // 压入深度（每 L）
    bond: 480,         // 穿过无关化学键（用户规则：尽量最大程度避免经过/覆盖键）
    bondNear: 70,      // 贴着键走（未穿过）
    arrow: 130,        // 与已有箭头交叉
    arrowNear: 26,     // 与已有箭头长距离贴近
    tangent: 95,       // 起止切线不自然（扎回标签、背离目标）
    clear: 46,         // 离障碍过近（按安全间隙）
    height: 13,        // 弧高（简洁性）
    length: 34         // 绕路过长
  };

  const DEFAULTS = {
    heights: [0.15, 0.25, 0.40, 0.60, 0.90, 1.20],   // h / L
    chordFractions: [0.15, 0.25],                    // h = f · D
    maxCandidates: 20,
    // Extra midpoint probes are reserved for a failed coarse search. Normal
    // routing keeps its original budget; narrow native-glyph channels can
    // otherwise fall between two candidates that hit different obstacles.
    maxRefinementCandidates: 24,
    refinementMinBendStep: 0.01,
    maxBend: 2.4,          // 与校验上限（3）留余量
    minChord: 0.08,        // 比这更短就不规划（避免无穷大 bend）
    headLen: 0.30,         // 箭头尖名义长度（结构坐标），用于遮挡足迹
    strokeHalf: 0.026,     // 线宽一半（结构坐标）
    labelGap: 0.05,        // 标签外扩安全间隙
    bondGap: 0.05,
    arrowGap: 0.075,
    startZone: 0.24,       // 端部豁免：曲线参数 t < startZone 才允许贴近来源相关对象
    endZone: 0.76,
    // 端部豁免的空间界限：只有落在这个局部距离内的接触才按「必要接触」放宽。
    // 长箭头也只豁免端点附近的一小段。
    endContactFraction: 0.45,
    step: 0.03,            // 采样步长（按 L 归一化）
    minSamples: 24,
    maxSamples: 160,
    switchMargin: 0.18,    // 迟滞：新候选要好这么多才换侧
    switchFloor: 60
  };

  // 键中点 → 端原子、直接相连原子之间的短转移：弯箭头与鱼钩共用可辨认的弧高。
  // 碰撞仍是更高优先级；拥挤时允许回退到较平的路线。数值均相对局部键长 L。
  const LOCAL_TRANSFER = { minHeight: 0.50, preferredHeight: 0.50, flatPenalty: 40 };

  function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---------------- 基础几何 ---------------- */

  function quadPoint(a, c, b, t) {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  }

  function controlOf(a, b, bend) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const nx = -dy / len, ny = dx / len;              // 弦的法向（y 向下时指向屏幕顺时针一侧）
    const k = (bend || 0) * len;                      // 控制点法向偏移 = bend·D，实际弧高 = 它的一半
    return { x: (a.x + b.x) / 2 + nx * k, y: (a.y + b.y) / 2 + ny * k };
  }

  function sideOfBond(point, bond) {
    const dx = bond.end.x - bond.begin.x, dy = bond.end.y - bond.begin.y;
    const offset = (dx * (point.y - bond.begin.y) - dy * (point.x - bond.begin.x)) / Math.hypot(dx, dy);
    return Math.abs(offset) > 0.025 ? Math.sign(offset) : 0;
  }

  /* 数值弧长（48 段折线）：用于采样密度、箭头尖收敛、绕路惩罚 */
  function arcLength(a, c, b) {
    const N = 48;
    let px = a.x, py = a.y, total = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const q = quadPoint(a, c, b, t);
      total += Math.hypot(q.x - px, q.y - py);
      px = q.x; py = q.y;
    }
    return total;
  }

  // Assess the curve actually drawn, including its clipped endpoint positions.
  // Bend alone cannot distinguish a short leaving-group arc from a giant U.
  function assessReadability(input) {
    const { start, control, end } = input || {};
    const L = finite(input && input.L) && input.L > 0 ? input.L : 1;
    if (![start, control, end].every(p => p && finite(p.x) && finite(p.y))) {
      return { readable: false, chord: Infinity, length: Infinity, sag: Infinity, L, reasons: ['invalid_geometry'] };
    }
    const chord = M.dist(start, end), length = arcLength(start, control, end);
    const midpoint = quadPoint(start, control, end, 0.5);
    const sag = M.dist(midpoint, M.lerp(start, end, 0.5));
    // Glyph docking can shorten one end and shift the control point along the
    // chord. That changes the midpoint's distance without visibly bending the
    // line, so the lower bound uses its perpendicular distance to the chord.
    const normalSag = chord > 1e-9 ? Math.abs(cross(start, end, midpoint)) / chord : 0;
    const limits = { chord: input.intermolecular ? 4.5 * L : Infinity,
      length: Math.max(3.6 * L, 1.85 * chord), sag: Math.max(1.4 * L, 0.4 * chord) };
    if (input.requireCurvature === true) {
      // A modest visible arc: 8% of a longer chord, capped at 0.4 bond lengths.
      // Short transfers use at most a quarter chord rather than a large U.
      limits.minSag = Math.min(0.4 * L, Math.max(0.1 * L, 0.08 * chord), 0.25 * chord);
    }
    const reasons = [];
    if (chord > limits.chord) reasons.push('intermolecular_span');
    if (length > limits.length) reasons.push('curve_length');
    if (sag > limits.sag) reasons.push('curve_sag');
    if (limits.minSag !== undefined && normalSag + 1e-9 < limits.minSag) reasons.push('curve_flat');
    return { readable: reasons.length === 0, chord, length, sag, normalSag, L, limits, reasons };
  }

  /* 采样：按弧长自适应，不用固定 5 点 */
  function sampleCurve(a, c, b, step, minN, maxN) {
    const len = arcLength(a, c, b);
    const n = clamp(Math.ceil(len / Math.max(step, 1e-4)), minN || 24, maxN || 160);
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(quadPoint(a, c, b, i / n));
    return { points: pts, length: len, count: n };
  }

  function segSegDistance(p1, p2, q1, q2) {
    if (segmentsIntersect(p1, p2, q1, q2)) return 0;
    return Math.min(
      pointSegDistance(p1, q1, q2), pointSegDistance(p2, q1, q2),
      pointSegDistance(q1, p1, p2), pointSegDistance(q2, p1, p2)
    );
  }

  function pointSegDistance(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }

  function segmentsIntersect(p1, p2, q1, q2) {
    const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2);
    const d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return false;
  }

  function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

  /* 轴对齐矩形：先判端点在内，再逐边求线段距离（凸矩形上这是精确解） */
  function segRectDistance(p, q, rect) {
    const inside = (pt) => pt.x >= rect.x1 && pt.x <= rect.x2 && pt.y >= rect.y1 && pt.y <= rect.y2;
    if (inside(p) || inside(q)) return 0;
    const c1 = { x: rect.x1, y: rect.y1 }, c2 = { x: rect.x2, y: rect.y1 };
    const c3 = { x: rect.x2, y: rect.y2 }, c4 = { x: rect.x1, y: rect.y2 };
    return Math.min(
      segSegDistance(p, q, c1, c2), segSegDistance(p, q, c2, c3),
      segSegDistance(p, q, c3, c4), segSegDistance(p, q, c4, c1)
    );
  }

  function pointRectDepth(p, rect) {
    // 返回「点落在矩形内多深」（正数向内），不在内部返回 0
    if (p.x < rect.x1 || p.x > rect.x2 || p.y < rect.y1 || p.y > rect.y2) return 0;
    return Math.min(p.x - rect.x1, rect.x2 - p.x, p.y - rect.y1, rect.y2 - p.y);
  }

  function expandRect(rect, m) {
    return { x1: rect.x1 - m, y1: rect.y1 - m, x2: rect.x2 + m, y2: rect.y2 + m };
  }

  /* ---------------- 候选 ---------------- */

  /* side = +1 表示曲线鼓向弦的法向（y 向下坐标里是屏幕顺时针一侧），-1 相反。
     实际弧高 h 与 bend 的关系：bend = side · 2h / D */
  function buildCandidates(a, b, L, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const D = M.dist(a, b);
    if (!(D > o.minChord)) return [];
    const out = [];
    const push = (side, h, source) => {
      if (!finite(h) || h <= 0) return;
      const bend = side * 2 * h / D;
      if (Math.abs(bend) > o.maxBend) return;
      if (out.some(c => Math.abs(c.bend - bend) < 1e-6)) return;
      out.push({ bend: bend, side: side, h: h, hOverL: h / L, source: source });
    };
    for (const side of [1, -1]) {
      for (const f of o.heights) push(side, f * L, 'h/L=' + f);
      // 随弦长变化的候选只对长弦有意义（指令 4.2「随较长 D 变化」）；
      // 短弦上 0.15D 远小于可读弧高，只会选出几像素的小鼓包
      if (D > 1.5 * L) for (const f of o.chordFractions) push(side, f * D, 'h=' + f + 'D');
    }
    // 控制候选数量：按弧高从小到大（先简单后复杂），保持两侧交替的确定性顺序
    out.sort((x, y) => (x.h - y.h) || (y.side - x.side));
    return out.slice(0, o.maxCandidates);
  }

  /* ---------------- 场景（障碍） ---------------- */

  /* ctx 需要：atoms() / bonds() / atomPos / atomLabelBox / unit；模型提供孤对与已有箭头。
     返回的坐标全部是结构坐标。原生文字测量会受缩放下的像素量化影响；
     adapter 可另给稳定保守的 planningRect，真实命中框仍由 rect 提供。 */
  function buildScene(ctx, model, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const scene = { labels: [], bonds: [], lonePairs: [], arrows: [], L: 1 };
    if (!ctx) return scene;

    const unit = typeof ctx.unit === 'function' ? ctx.unit() : 1 / 40;

    if (typeof ctx.atoms === 'function') {
      let list = [];
      try { list = ctx.atoms() || []; } catch (e) { list = []; }
      for (const at of list) {
        if (!at || !at.pos) continue;
        let box = null;
        try { box = typeof ctx.atomLabelBox === 'function' ? ctx.atomLabelBox(at.uuid, { planning: o.planning !== false }) : null; } catch (e) { box = null; }
        const hasLabel = !!(box && box.hasLabel && box.hwCss > 0 && box.hhCss > 0);
        // 裸顶点（无字，如链中间的碳）不是文字障碍：跳过，箭头尖本该贴到它。
        // 造 0.2 的假盒子会把每条合法的弧都判成「压字」。
        if (!hasLabel) continue;
        const planningRect = box.planningRect;
        const hasPlanningRect = o.planning !== false && planningRect &&
          ['x1', 'y1', 'x2', 'y2'].every(key => Number.isFinite(planningRect[key])) &&
          planningRect.x2 > planningRect.x1 && planningRect.y2 > planningRect.y1;
        const hw = hasPlanningRect ? (planningRect.x2 - planningRect.x1) / 2 : box.hwCss * unit;
        const hh = hasPlanningRect ? (planningRect.y2 - planningRect.y1) / 2 : box.hhCss * unit;
        const rect = hasPlanningRect ? planningRect : box.rect ||
          { x1: at.pos.x - hw, y1: at.pos.y - hh, x2: at.pos.x + hw, y2: at.pos.y + hh };
        scene.labels.push({
          id: at.uuid,
          atomId: at.uuid,
          label: at.label,
          cx: (rect.x1 + rect.x2) / 2, cy: (rect.y1 + rect.y2) / 2,
          hw: hw, hh: hh,
          rect: rect
        });
      }
    }

    if (typeof ctx.bonds === 'function') {
      let list = [];
      try { list = ctx.bonds() || []; } catch (e) { list = []; }
      const lengths = [];
      for (const bd of list) {
        if (!bd || !bd.begin || !bd.end) continue;
        lengths.push(M.dist(bd.begin, bd.end));
        scene.bonds.push({
          id: bd.uuid, a: bd.begin, b: bd.end, type: bd.type || 1,
          atomIds: [bd.beginAtom || null, bd.endAtom || null].filter(Boolean)
        });
      }
      // 局部标准键长：附近正常键长的中位数（Ketcher 里通常就是 1）
      const sane = lengths.filter(x => x > 0.2 && x < 3).sort((x, y) => x - y);
      if (sane.length) scene.L = sane[Math.floor(sane.length / 2)];
    }

    if (typeof ctx.reactionArrows === 'function') {
      for (const [start, end] of ctx.reactionArrows()) {
        if (start && end) scene.arrows.push({ points: [start, end], length: M.dist(start, end) });
      }
    }

    if (model && model.state) {
      for (const lp of model.state.lonePairs) {
        if (lp.visible === false) continue;
        const p = M.lonePairPosition(lp, ctx);
        if (!p) continue;
        scene.lonePairs.push({ id: lp.id, p: p, ownerAtomId: lp.ownerAtomId, r: 0.05 });
      }
    }
    return scene;
  }

  /* 把已有箭头（除 exceptId）采样成折线，供「避让已有箭头」使用 */
  function addArrowObstacles(scene, model, ctx, exceptId, step) {
    if (!model || !model.state) return;
    for (const ar of model.state.arrows) {
      if (ar.id === exceptId) continue;
      let geo = null;
      try { geo = M.arrowGeometry(ar, ctx); } catch (e) { geo = null; }
      if (!geo || geo.degenerate) continue;
      const s = sampleCurve(geo.start, geo.control, geo.end, (step || 0.03) * 2, 12, 40);
      scene.arrows.push({ id: ar.id, points: s.points, length: s.length });
    }
  }

  /* ---------------- 评分 ---------------- */

  /* 端点豁免：来源/目标自己的关联对象只在端部小段内放宽，整根键/整块标签不豁免 */
  function relatedSets(source, target) {
    const startLabels = new Set();
    const endLabels = new Set();
    const startBonds = new Set();
    const endBonds = new Set();
    const atomsOf = (ep, into) => {
      if (!ep) return;
      if (ep.type === 'lonePair' || ep.type === 'radical') { if (ep.ownerAtomId) into.add(ep.ownerAtomId); }
      else if (ep.type === 'atom') { if (ep.atomId) into.add(ep.atomId); }
      else if (ep.type === 'formingBond') { if (ep.atomA) into.add(ep.atomA); if (ep.atomB) into.add(ep.atomB); }
    };
    atomsOf(source, startLabels);
    atomsOf(target, endLabels);
    if (source && source.type === 'bond' && source.bondId) startBonds.add(source.bondId);
    if (target && target.type === 'bond' && target.bondId) endBonds.add(target.bondId);
    return {
      startLabels: startLabels, endLabels: endLabels,
      startBonds: startBonds, endBonds: endBonds,
      // 键端点的「自己的原子」由 planArrow 在拿到 scene 后补齐（键两端原子的标签不算无关障碍）
      bondAtomsPending: true
    };
  }

  function evaluateGeometry(cand, ctxIn) {
    const { scene, rel, opts } = ctxIn;
    const geometry = ctxIn.geometry ? ctxIn.geometry(cand.bend) : null;
    if (geometry && (geometry.degenerate || !geometry.sourceOk || !geometry.targetOk)) return null;
    const a = geometry ? geometry.start : ctxIn.a;
    const b = geometry ? geometry.end : ctxIn.b;
    const o = opts;
    const c = geometry ? geometry.control : controlOf(a, b, cand.bend);
    const s = sampleCurve(a, c, b, o.step, o.minSamples, o.maxSamples);
    const pts = s.points;
    const D = M.dist(a, b);
    const parts = { label: 0, bond: 0, arrow: 0, tangent: 0, clear: 0, shape: 0 };
    const tOf = (i) => i / s.count;
    // 碰撞足迹按「实际绘制」建模：曲线主体 = 线宽 + 渲染余量；终点附近最后一段加上
    // V 形箭头尖（barb 从尖端向后扫约 headLen，半宽≈headLen·sin25°≈0.5·headLen）的
    // 足迹。只检查裸弦或裸原子中心是规范 9.2 明确禁止的。
    const bodyMargin = o.strokeHalf + 0.045;
    const tipMargin = o.strokeHalf + o.headLen * 0.35;
    const tipZone = o.headLen * 1.2;
    const marginAt = (p) => M.dist(p, b) <= tipZone ? tipMargin : bodyMargin;
    const margin = bodyMargin;
    const L = Math.max(ctxIn.L || scene.L || 1, 1e-6);
    // 端部豁免的局部距离界限：来源/目标「自己」的对象只在这个距离内允许必要接触。
    const endContact = clamp((o.endContactFraction || 0.45) * D, 0.55 * L, 0.8 * L);
    const collisions = { labels: [], bonds: [] };
    let labelHits = 0;
    let bondHits = 0;
    let arrowHits = 0;

    // 1) 无关原子标签（最高优先级）。
    //    端部豁免按「对象身份 + 局部距离」双重限定：只有来源/目标自己的标签、且接触点
    //    落在距对应端点 endContact 内，才按必要接触放宽。邻居簇（如 C+ 旁的 CH3）不再
    //    被整簇豁免——它们是真实障碍（规范 9.3 / 9.4）。
    for (const lb of scene.labels) {
      const bodyRect = expandRect(lb.rect, bodyMargin + o.labelGap);
      const tipRect = expandRect(lb.rect, tipMargin + o.labelGap);
      let minD = Infinity;
      let worstDepth = 0;
      for (let i = 1; i < pts.length; i++) {
        const m = marginAt(pts[i]);
        const rect = m === tipMargin ? tipRect : bodyRect;
        const dd = segRectDistance(pts[i - 1], pts[i], rect);
        if (dd < minD) minD = dd;
        if (dd === 0) {
          const depth = Math.max(pointRectDepth(pts[i - 1], rect), pointRectDepth(pts[i], rect));
          if (depth > worstDepth) worstDepth = depth;
        }
      }
      if (minD === 0) {
        const exemptStart = rel.startLabels.has(lb.atomId);
        const exemptEnd = rel.endLabels.has(lb.atomId);
        let violation = true;
        if (exemptStart || exemptEnd) {
          let worst = 0;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (exemptStart && M.dist(p, a) <= endContact) continue;
            if (exemptEnd && M.dist(p, b) <= endContact) continue;
            const depth = pointRectDepth(p, expandRect(lb.rect, marginAt(p) + o.labelGap));
            if (depth > worst) worst = depth;
          }
          violation = worst > 0.01;
          worstDepth = Math.max(worstDepth, worst);
        }
        // 孤对点已在字形之外。贴近自己的标签可以，折回穿过标签仍是冲突。
        if (!violation && ctxIn.lonePairOwner && lb.atomId === ctxIn.lonePairOwner) {
          const ink = expandRect(lb.rect, o.strokeHalf);
          violation = pts.some((p, i) => i > 0 && segRectDistance(pts[i - 1], p, ink) === 0);
        }
        if (violation) {
          labelHits += 1;
          collisions.labels.push(lb.atomId);
          parts.label += W.label + W.labelDepth * Math.max(worstDepth, 0.02);
        }
      } else if (minD < o.labelGap) {
        parts.clear += W.clear * (1 - minD / o.labelGap);
      }
    }

    // 2) 化学键（穿过 > 贴近）。端部豁免按「端点自身键」与「仅共享原子的邻接键」严格区分：
    //    来源/目标自己的键只在距对应端点 endContact 内允许接触/贴近；
    //    仅共享顶点的邻接键只在紧贴共享顶点的顶点帽范围内豁免，绝不豁免键杆中段；
    //    无关系的键一律按「尽量最大程度避免经过/覆盖键」重罚。
    let midBondDist = Infinity;
    const midPts = [quadPoint(a, c, b, 0.3), quadPoint(a, c, b, 0.5), quadPoint(a, c, b, 0.7)];
    for (const bd of scene.bonds) {
      const rectPad = o.strokeHalf + 0.02;
      const isStartBond = rel.startBonds.has(bd.id);
      const isEndBond = rel.endBonds.has(bd.id);
      const touchesStart = bd.atomIds && bd.atomIds.some(id => rel.startLabels.has(id));
      const touchesEnd = bd.atomIds && bd.atomIds.some(id => rel.endLabels.has(id));
      let vStart = null;
      if (touchesStart && !isStartBond) {
        if (bd.atomIds && bd.atomIds.length === 2) {
          if (rel.startLabels.has(bd.atomIds[0])) vStart = bd.a;
          else if (rel.startLabels.has(bd.atomIds[1])) vStart = bd.b;
          else vStart = M.dist(bd.a, a) <= M.dist(bd.b, a) ? bd.a : bd.b;
        } else {
          vStart = (bd.a && bd.b) ? (M.dist(bd.a, a) <= M.dist(bd.b, a) ? bd.a : bd.b) : (bd.a || bd.b || null);
        }
      }
      let vEnd = null;
      if (touchesEnd && !isEndBond) {
        if (bd.atomIds && bd.atomIds.length === 2) {
          if (rel.endLabels.has(bd.atomIds[0])) vEnd = bd.a;
          else if (rel.endLabels.has(bd.atomIds[1])) vEnd = bd.b;
          else vEnd = M.dist(bd.a, b) <= M.dist(bd.b, b) ? bd.a : bd.b;
        } else {
          vEnd = (bd.a && bd.b) ? (M.dist(bd.a, b) <= M.dist(bd.b, b) ? bd.a : bd.b) : (bd.a || bd.b || null);
        }
      }

      if (!isStartBond && !isEndBond) {
        for (const pt of midPts) {
          const d = segSegDistance(pt, pt, bd.a, bd.b);
          if (d < midBondDist) midBondDist = d;
        }
      }

      let minD = Infinity;
      let minDt = 0;
      let minPoint = null;
      let crossed = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = segSegDistance(pts[i - 1], pts[i], bd.a, bd.b);
        if (d < minD) { minD = d; minDt = tOf(i); minPoint = pts[i - 1]; }
        if (d === 0) {
          const p = pts[i];
          const t = tOf(i);
          const exemptStart = isStartBond && t <= 0.5 && M.dist(p, a) <= endContact;
          const exemptEnd = isEndBond && t >= 0.5 && M.dist(p, b) <= endContact;
          const exemptIncidentStart = vStart && t <= 0.25 && M.dist(p, vStart) <= 0.25 * L;
          const exemptIncidentEnd = vEnd && t >= 0.75 && M.dist(p, vEnd) <= 0.25 * L;
          if (!exemptStart && !exemptEnd && !exemptIncidentStart && !exemptIncidentEnd) crossed += 1;
        }
      }
      if (crossed) {
        bondHits += 1;
        collisions.bonds.push(bd.id);
        parts.bond += W.bond * (1 + Math.min(crossed, 4) * 0.25);
      } else if (minD < rectPad + o.bondGap) {
        // 来源/目标自己的键在对应端部局部距离内的必要贴近不惩罚（4.3 节例外），
        // 否则弧永远贴着弦走，长不成一「旁弧」
        const nearStart = isStartBond && minDt <= 0.6 &&
          minPoint && M.dist(minPoint, a) <= endContact * 1.3;
        const nearEnd = isEndBond && minDt >= 0.4 &&
          minPoint && M.dist(minPoint, b) <= endContact * 1.3;
        const nearIncidentStart = vStart && minDt <= 0.30 &&
          minPoint && M.dist(minPoint, vStart) <= 0.32 * L;
        const nearIncidentEnd = vEnd && minDt >= 0.70 &&
          minPoint && M.dist(minPoint, vEnd) <= 0.32 * L;
        if (!nearStart && !nearEnd && !nearIncidentStart && !nearIncidentEnd) {
          parts.clear += W.clear * 0.8 * (1 - minD / (rectPad + o.bondGap));
          if (minD < rectPad) parts.bond += W.bondNear * 0.35;
        }
      }
    }
    if (Number.isFinite(midBondDist) && midBondDist < 1.1 * L) {
      parts.clear += 3.0 * Math.pow(1 - midBondDist / (1.1 * L), 2);
    }

    // 3) 孤对点
    for (const lp of scene.lonePairs) {
      if (ctxIn.sourceLonePairId && lp.id === ctxIn.sourceLonePairId) continue;
      let minD = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const d = segSegDistance(pts[i - 1], pts[i], lp.p, lp.p);
        if (d < minD) minD = d;
      }
      const need = (lp.r || 0.05) + o.strokeHalf + o.labelGap;
      if (minD < need) parts.clear += W.clear * 1.2 * (1 - minD / need);
    }

    // 4) 已有箭头。两根箭头在同一受点上汇合时尖端相触是正常画法，
    //    只有中段（0.06 < t < 0.94）相交才算交叉；长距离贴线另计，推动新箭头避让。
    for (const ar of scene.arrows) {
      let minD = Infinity;
      let crossed = false;
      let hugSegs = 0;
      for (let i = 1; i < pts.length; i++) {
        const t = tOf(i);
        let segMin = Infinity;
        for (let j = 1; j < ar.points.length; j++) {
          const d = segSegDistance(pts[i - 1], pts[i], ar.points[j - 1], ar.points[j]);
          if (d < segMin) segMin = d;
        }
        if (segMin < minD) minD = segMin;
        if (segMin === 0 && t > 0.06 && t < 0.94) crossed = true;
        if (segMin < o.arrowGap) hugSegs += 1;
      }
      const hug = hugSegs / Math.max(1, pts.length - 1);
      if (crossed) { arrowHits += 1; parts.arrow += W.arrow; }
      else if (minD < o.arrowGap) {
        parts.arrow += W.arrowNear * (1 - minD / o.arrowGap) + W.arrowNear * 2 * hug;
      }
    }

    // 5) 起止切线是否自然
    const chord = { x: (b.x - a.x) / D, y: (b.y - a.y) / D };
    const startTan = normalize({ x: c.x - a.x, y: c.y - a.y });
    const endTan = normalize({ x: b.x - c.x, y: b.y - c.y });
    if (startTan && endTan) {
      const along = startTan.x * chord.x + startTan.y * chord.y;
      if (along < 0) parts.tangent += W.tangent * Math.min(2, -along * 2);   // 起笔向后甩/回勾
      // 短转移的尖端沿成品曲线贴到接收原子，不强迫高弧仍按零曲率时的键方向进入。
      const targetDir = ctxIn.localAtomTarget && geometry && geometry.targetAnchor
        ? normalize({ x: geometry.targetAnchor.x - b.x, y: geometry.targetAnchor.y - b.y })
        : ctxIn.targetDir;
      if (targetDir) {
        const d2 = endTan.x * targetDir.x + endTan.y * targetDir.y;
        if (d2 < 0.55) parts.tangent += W.tangent * Math.min(2, (0.55 - d2) * 1.6);  // 箭头尖背离目标
      }
      // 绕回自己标签：中段落进来源/目标标签框
      for (const lb of scene.labels) {
        const isStart = rel.startLabels.has(lb.atomId);
        const isEnd = rel.endLabels.has(lb.atomId);
        if (!isStart && !isEnd) continue;
        for (let i = 1; i < pts.length - 1; i++) {
          const t = tOf(i);
          if (isStart && t > o.startZone && t < 0.5 && pointRectDepth(pts[i], lb.rect) > 0) {
            parts.tangent += W.tangent * 0.5; break;
          }
          if (isEnd && t < o.endZone && t > 0.5 && pointRectDepth(pts[i], lb.rect) > 0) {
            parts.tangent += W.tangent * 0.5; break;
          }
        }
      }
    }

    // 6) 简洁性：弧高与绕路。弧高有可读下限（0.15L，短弧要能辨认出是一条弧，A05/A06），
    //    也有随弦长变化的舒适高度（约 18% 弦长，原版拖拽弧的自然比例）；偏离舒适值越远越差
    const hAbs = Math.abs(cand.h);
    const hRel = hAbs / L;
    // 舒适弧高按原始锚点间距计算，不被字形贴附在两侧造成的微小长度差带偏方向。
    const routingD = M.dist(ctxIn.a, ctxIn.b);
    const hSweet = ctxIn.localTransfer ? Math.max(LOCAL_TRANSFER.preferredHeight, 0.18 * routingD / L) : Math.max(0.25, 0.18 * routingD / L);
    parts.shape += W.height * 0.6 * Math.pow((hRel - hSweet) / hSweet, 2);
    const minHeight = ctxIn.localTransfer ? LOCAL_TRANSFER.minHeight : 0.15;
    const flatPenalty = ctxIn.localTransfer ? LOCAL_TRANSFER.flatPenalty : 4;
    if (hRel < minHeight) parts.shape += W.height * flatPenalty * Math.pow((minHeight - hRel) / minHeight, 2);
    parts.shape += W.length * Math.max(0, s.length / D - 1.22);

    const total = parts.label + parts.bond + parts.arrow + parts.tangent + parts.clear + parts.shape;
    const preferred = ctxIn.preferredBondSide;
    const readability = assessReadability({ start: a, control: c, end: b, L, intermolecular: ctxIn.intermolecular,
      requireCurvature: ctxIn.requireCurvature });
    return {
      bend: cand.bend, side: cand.side, h: cand.h, hOverL: cand.hOverL,
      score: total, parts: parts, length: s.length, arcRatio: s.length / D,
      labelHits: labelHits, bondHits: bondHits, arrowHits: arrowHits,
      feasible: labelHits === 0 && bondHits === 0,
      readable: readability.readable, readability,
      wrongSide: preferred && sideOfBond(quadPoint(a, c, b, preferred.t ?? 0.5), preferred.bond) !== preferred.side ? 1 : 0,
      collisions: collisions,
      control: c
    };
  }

  function evaluate(cand, ctxIn) {
    const primary = evaluateGeometry(cand, ctxIn);
    if (!primary) return null;
    const variants = ctxIn.geometryVariants || [];
    if (!variants.length || !primary.feasible || !primary.readable) return primary;
    const results = [primary];
    for (const geometry of variants) {
      const result = evaluateGeometry(cand, { ...ctxIn, geometry });
      if (!result) return null;
      results.push(result);
      if (!result.feasible || !result.readable) break;
    }
    // One persisted bend must work for every actual endpoint geometry. A
    // source LP has a CSS-sized offset, so changing reading zoom can move its
    // start even when atom coordinates and chemical endpoints stay identical.
    const worst = results.reduce((a, b) => a.score > b.score ? a : b);
    const unreadable = results.find(result => !result.readable);
    return { ...primary, score: worst.score, parts: worst.parts,
      feasible: results.every(result => result.feasible), readable: !unreadable,
      readability: unreadable?.readability || primary.readability,
      length: Math.max(...results.map(result => result.length)),
      arcRatio: Math.max(...results.map(result => result.arcRatio)),
      labelHits: Math.max(...results.map(result => result.labelHits)),
      bondHits: Math.max(...results.map(result => result.bondHits)),
      arrowHits: Math.max(...results.map(result => result.arrowHits)),
      wrongSide: Math.max(...results.map(result => result.wrongSide || 0)),
      collisions: Object.fromEntries(['labels', 'bonds'].map(key =>
        [key, [...new Set(results.flatMap(result => result.collisions[key]))]])),
      geometryCount: results.length };
  }

  function normalize(v) {
    const d = Math.hypot(v.x, v.y);
    if (!(d > 1e-9)) return null;
    return { x: v.x / d, y: v.y / d };
  }

  /* ---------------- 对外：规划 ---------------- */

  /* input: { a, b, scene, source, target, targetDir?, L?, opts? }
     返回 { bend, score, feasible, ranked, count, note } —— 纯函数，同样输入必得同样输出 */
  function planArrow(input) {
    const o = Object.assign({}, DEFAULTS, (input && input.opts) || {});
    const a = input && input.a;
    const b = input && input.b;
    const scene = (input && input.scene) || { labels: [], bonds: [], lonePairs: [], arrows: [], L: 1 };
    const L = finite(input && input.L) && input.L > 0.2 ? input.L : (scene.L || 1);
    const empty = { bend: 0, score: Infinity, feasible: false, readable: false, ranked: [], count: 0, note: 'no-candidate' };
    if (!a || !b || !finite(a.x) || !finite(a.y) || !finite(b.x) || !finite(b.y)) return empty;
    const D = M.dist(a, b);
    if (!(D > o.minChord)) return empty;

    const source = input.source, target = input.target;
    const sourceBond = source && source.type === 'bond' && scene.bonds
      ? scene.bonds.find(bd => bd.id === source.bondId) : null;
    const bondToEnd = target && target.type === 'atom' && sourceBond &&
      sourceBond.atomIds && sourceBond.atomIds.includes(target.atomId);
    const sourceOwner = source && (source.type === 'atom' ? source.atomId : source.ownerAtomId);
    const targetOwner = target && (target.type === 'atom' ? target.atomId :
      target.type === 'formingBond' ? [target.atomA, target.atomB].find(id => id !== sourceOwner) : null);
    const adjacentAtoms = sourceOwner && targetOwner && sourceOwner !== targetOwner && scene.bonds &&
      scene.bonds.some(bd => bd.atomIds && bd.atomIds.includes(sourceOwner) && bd.atomIds.includes(targetOwner));
    const localTransfer = (bondToEnd && D <= 0.8 * L) || (adjacentAtoms && D <= 1.15 * L);

    const rel = relatedSets(input.source, input.target);
    // Increasing an existing bond's order may use either endpoint spelling.
    // Its own sigma bond receives the same finite end-contact allowance as a
    // target.type='bond'; no neighbouring bond or curve midsection is exempt.
    if (target?.type === 'formingBond' && target.atomA !== target.atomB) {
      for (const bond of scene.bonds || []) if (bond.atomIds?.length === 2 &&
          bond.atomIds.includes(target.atomA) && bond.atomIds.includes(target.atomB)) rel.endBonds.add(bond.id);
    }
    // 键端点的「自己的原子」：来源/目标键两端原子的标签不算无关障碍
    // （弧从键中间起笔必然擦过自己两端原子的字），在这里拿到 scene 后补齐。
    // 注意：不再把端部原子的整个邻居簇加入豁免（旧 neighborLabelsOf）。指向带正电
    // 中心碳的箭头尖退让到相邻 CH3 标签上，正是这个过宽豁免造成的（规范 9.3/9.4）；
    // 邻居标签现在是不折不扣的障碍，必要接触只按局部距离在 evaluate 内放宽。
    const bondAtomsOf = (ep, into) => {
      if (!ep || ep.type !== 'bond' || !ep.bondId || !scene.bonds) return;
      const bd = scene.bonds.find(x => x.id === ep.bondId);
      if (bd && bd.atomIds) for (const aid of bd.atomIds) if (aid) into.add(aid);
    };
    bondAtomsOf(input.source, rel.startLabels);
    bondAtomsOf(input.target, rel.endLabels);
    const parents = new Map();
    const component = id => {
      if (!parents.has(id)) parents.set(id, id);
      let key = id;
      while (parents.get(key) !== key) key = parents.get(key);
      return key;
    };
    for (const bond of scene.bonds || []) {
      const ids = bond.atomIds || [];
      for (const id of ids.slice(1)) parents.set(component(id), component(ids[0]));
    }
    const endpointComponents = new Set([...rel.startLabels, ...rel.endLabels].map(component));
    const intermolecular = typeof input.intermolecular === 'boolean' ? input.intermolecular : endpointComponents.size > 1;
    const candidateOpts = localTransfer ? Object.assign({}, o, { heights: o.heights.concat(0.50) }) : o;
    // Read-only assessment uses the curve actually on the canvas rather than
    // treating the existence of some better candidate as a successful layout.
    const fixedHeight = input.fixedGeometry ? M.dist(input.fixedGeometry.control, M.lerp(input.fixedGeometry.start, input.fixedGeometry.end, 0.5)) : 0;
    const onlyBend = finite(input.onlyBend) ? input.onlyBend : null;
    const cands = input.fixedGeometry ? [{ bend: 0, h: fixedHeight, hOverL: fixedHeight / L, side: 1 }]
      : onlyBend !== null ? [{ bend: onlyBend, h: Math.abs(onlyBend) * D / 2,
        hOverL: Math.abs(onlyBend) * D / (2 * L), side: Math.sign(onlyBend) || 1 }]
        : buildCandidates(a, b, L, candidateOpts);
    if (!cands.length) return empty;

    const ctxIn = { a: a, b: b, L, intermolecular, scene: scene, rel: rel, opts: o, targetDir: input.targetDir || null,
      // Searches and preservation checks plan automatic curves. A fixed
      // read-only diagnostic can opt in when its stored arrow is automatic;
      // explicitly manual straight lines retain their original meaning.
      requireCurvature: input.fixedGeometry ? input.requireCurvature === true : input.requireCurvature !== false,
      geometry: input.fixedGeometry ? () => input.fixedGeometry : input.geometry || null, localTransfer: !!localTransfer,
      geometryVariants: input.fixedGeometry ? [] : (input.geometryVariants || []).filter(geometry => typeof geometry === 'function'),
      preferredBondSide: input.preferredBondSide || null,
      localAtomTarget: !!localTransfer && target.type === 'atom',
      lonePairOwner: source?.type === 'lonePair' ? source.ownerAtomId : null,
      sourceLonePairId: source?.type === 'lonePair' ? source.slotId : null };
    const ranked = cands.map(c => evaluate(c, ctxIn)).filter(Boolean);
    const slots = o.maxCandidates - cands.length;
    if (!input.fixedGeometry && onlyBend === null && slots > 0 && !ranked.some(c => c.feasible)) {
      // 常规弧都被挡住时，才尝试从分子外侧多绕一点。
      const tallest = cands[cands.length - 1].h;
      const heights = [Math.max(1.6, 0.32 * D / L), Math.max(2.9, 0.58 * D / L)];
      const outer = buildCandidates(a, b, L, { ...candidateOpts, heights, chordFractions: [] })
        .filter(c => c.h > tallest + 1e-6).slice(0, slots);
      ranked.push(...outer.map(c => evaluate(c, ctxIn)).filter(Boolean));
    }
    if (!ranked.length) return empty;
    let refinementCount = 0;
    if (!input.fixedGeometry && onlyBend === null && !ranked.some(candidate => candidate.feasible && candidate.readable)) {
      const budget = clamp(Math.floor(finite(o.maxRefinementCandidates) ? o.maxRefinementCandidates : 24), 0, 48);
      const minStep = Math.max(0.001, finite(o.refinementMinBendStep) ? o.refinementMinBendStep : 0.01);
      const intervals = [];
      const collisionKey = candidate => JSON.stringify([
        candidate.collisions.labels.slice().sort(), candidate.collisions.bonds.slice().sort()]);
      const enqueue = (left, right) => {
        if (right.bend - left.bend <= minStep) return;
        const leftHits = left.labelHits + left.bondHits, rightHits = right.labelHits + right.bondHits;
        intervals.push({ left, right,
          changed: leftHits && rightHits && collisionKey(left) !== collisionKey(right) ? 0 : 1,
          hits: Math.min(leftHits, rightHits), score: Math.min(left.score, right.score) });
      };
      for (const side of [-1, 1]) {
        const sameSide = ranked.filter(candidate => Math.sign(candidate.bend) === side).sort((a, b) => a.bend - b.bend);
        for (let i = 1; i < sameSide.length; i++) enqueue(sameSide[i - 1], sameSide[i]);
      }
      while (intervals.length && refinementCount < budget) {
        intervals.sort((a, b) => a.changed - b.changed || a.hits - b.hits || a.score - b.score ||
          (b.right.bend - b.left.bend) - (a.right.bend - a.left.bend) || a.left.bend - b.left.bend);
        const { left, right } = intervals.shift(), bend = (left.bend + right.bend) / 2;
        const h = Math.abs(bend) * D / 2;
        const candidate = evaluate({ bend, side: Math.sign(bend), h, hOverL: h / L }, ctxIn);
        refinementCount++;
        if (!candidate) continue;
        ranked.push(candidate);
        if (candidate.feasible && candidate.readable) break;
        enqueue(left, candidate); enqueue(candidate, right);
      }
    }
    // Label and bond clearance comes first. AI drawing may then prefer the
    // fewest crossings among the clear curves without changing other callers.
    ranked.sort((x, y) => (Number(y.feasible) - Number(x.feasible)) ||
      (Number(y.readable) - Number(x.readable)) ||
      (x.feasible && (input.preferredBondSide || input.preferClearArrows)
        ? x.arrowHits - y.arrowHits || x.wrongSide - y.wrongSide : 0) ||
      (x.score - y.score) || (x.h - y.h) || (y.side - x.side));
    const best = ranked[0];
    return {
      bend: best.bend, score: best.score, feasible: best.feasible, readable: best.readable, readability: best.readability,
      ranked: ranked, count: ranked.length, refinementCount,
      parts: best.parts, arcRatio: best.arcRatio,
      collisions: best.collisions || { labels: [], bonds: [] },
      feasibleCount: ranked.filter(c => c.feasible).length,
      note: !best.readable ? 'unreadable' : best.feasible ? 'ok' : 'crowded'
    };
  }

  /* 迟滞：预览时小幅抖动不换侧，只有明显更好或当前严重遮挡才切 */
  function chooseWithHysteresis(plan, prevBend, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!plan || !plan.ranked || !plan.ranked.length) return plan;
    if (!finite(prevBend)) return plan;
    const prev = plan.ranked.find(c => Math.abs(c.bend - prevBend) <= 0.035);
    if (!prev) return plan;
    const best = plan.ranked[0];
    if (prev === best) return plan;
    const need = Math.max(o.switchFloor, Math.abs(prev.score) * o.switchMargin);
    if (best.score < prev.score - need) return plan;
    if (!prev.feasible && best.feasible) return plan;
    if (!prev.readable && best.readable) return plan;
    return Object.assign({}, plan, {
      bend: prev.bend, score: prev.score, feasible: prev.feasible,
      readable: prev.readable, readability: prev.readability,
      parts: prev.parts, arcRatio: prev.arcRatio, collisions: prev.collisions, note: prev.readable === false ? 'unreadable' : 'kept', kept: true
    });
  }

  /* 目标的自然朝向：终点切线应大致指向这里 */
  function targetDirection(target, ctx) {
    if (!target || !ctx) return null;
    try {
      if (target.type === 'atom') {
        const p = ctx.atomPos(target.atomId);
        return p ? { to: p } : null;
      }
      if (target.type === 'formingBond') {
        const pa = ctx.atomPos(target.atomA);
        const pb = ctx.atomPos(target.atomB);
        if (!pa || !pb) return null;
        const d = normalize({ x: pb.x - pa.x, y: pb.y - pa.y });
        return d ? { along: d } : null;
      }
    } catch (e) { return null; }
    return null;
  }

  /* 把「终点该朝哪」换算成单位向量（终点在 b 处时） */
  function resolveTargetDir(target, ctx, b) {
    const info = targetDirection(target, ctx);
    if (!info) return null;
    if (info.along) return info.along;
    if (info.to && b) {
      const d = normalize({ x: info.to.x - b.x, y: info.to.y - b.y });
      if (d) return d;
      // 终点已经压在标签边缘：改用「从曲线中点指向目标」
      return null;
    }
    return null;
  }

  MW.route = {
    ROUTE_VERSION: ROUTE_VERSION,
    WEIGHTS: W,
    DEFAULTS: DEFAULTS,
    buildScene: buildScene,
    addArrowObstacles: addArrowObstacles,
    buildCandidates: buildCandidates,
    evaluate: evaluate,
    planArrow: planArrow,
    chooseWithHysteresis: chooseWithHysteresis,
    resolveTargetDir: resolveTargetDir,
    controlOf: controlOf,
    sideOfBond: sideOfBond,
    arcLength: arcLength,
    assessReadability: assessReadability,
    sampleCurve: sampleCurve,
    segRectDistance: segRectDistance,
    relatedSets: relatedSets
  };
})(typeof window !== 'undefined' ? window : globalThis);
