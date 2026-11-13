/* MolStudio 工作台 · 机理层数据模型（纯数据，不依赖 DOM / Ketcher）
 *
 * 数据约定：
 *   - 稳定 ID：本模型里的 uuid，用于持久绑定；运行时 id（Ketcher 结构池索引）只存在于适配器。
 *   - 坐标一律使用「结构坐标」= Ketcher 的 pp 空间：键长约 1，y 轴向下（与 KET 的 y 轴相反）。
 *   - 曲线的化学含义（端点引用）与几何（bend 曲率）分开保存，几何只存相对量，不存屏幕像素。
 *
 * 载入顺序：本文件 → workbench-storage.js → ketcher-adapter.js → mechanism-layer.js
 *          → mechanism-controller.js → mechanism-ui.js → mechanism-export.js → main.js
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});

  const FORMAT = 'molstudio-workbench';
  const VERSION = 1;
  const DEFAULT_STEP = 'step-1';

  // 自动排布算法版本：写进 geometry.routeVersion。算法升级后旧文件按保存结果原样打开，
  // 不因新版本或当前视口重新选路线（用户主动「重新自动排布」才会重算）。
  const ROUTE_VERSION = 4;

  // 主族元素价电子数：只用于「已核验的常见非芳香主族环境」，超价/芳香/查询原子一律不猜
  const VALENCE = {
    H: 1, He: 2, B: 3, C: 4, N: 5, O: 6, F: 7, Ne: 8,
    Si: 4, P: 5, S: 6, Cl: 7, Ar: 8,
    As: 5, Se: 6, Br: 7, Kr: 8, Te: 6, I: 7, Xe: 8
  };

  let idCounter = 0;
  function newId(prefix) {
    idCounter += 1;
    const rnd = (root.crypto && typeof root.crypto.randomUUID === 'function')
      ? root.crypto.randomUUID()
      : (Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    return (prefix || 'id') + '-' + rnd;
  }

  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }

  function emptyState() {
    return {
      steps: [{ id: DEFAULT_STEP, label: '步骤 1' }],
      lonePairs: [],
      arrows: []
    };
  }

  function finite(n) { return typeof n === 'number' && Number.isFinite(n); }

  /* ---------------- 几何工具（结构坐标，y 向下） ---------------- */
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function norm(a) { const d = Math.hypot(a.x, a.y) || 1; return { x: a.x / d, y: a.y / d }; }
  function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
  function perp(v) { return { x: -v.y, y: v.x }; }
  function angleOf(v) { return Math.atan2(v.y, v.x); }

  /* 两点之间的二次贝塞尔：bend 是相对弦长的有符号法向偏移（正=屏幕顺时针一侧） */
  function controlPoint(a, b, bend) {
    const chord = { x: b.x - a.x, y: b.y - a.y };
    const len = Math.hypot(chord.x, chord.y);
    if (!(len > 1e-9)) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = perp({ x: chord.x / len, y: chord.y / len });
    const k = (bend || 0) * len;
    return { x: (a.x + b.x) / 2 + n.x * k, y: (a.y + b.y) / 2 + n.y * k };
  }

  function quadPoint(a, c, b, t) {
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
    };
  }

  function quadTangent(a, c, b, t) {
    const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
    const dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }

  /* ---------------- 端点 ---------------- */

  /* 端点类型（第 4.4 节）：lonePair / radical / bond / atom / formingBond / free */
  function endpointKind(ep) {
    return ep && typeof ep.type === 'string' ? ep.type : null;
  }

  function validateEndpoint(ep, errs, where) {
    const bad = (msg) => errs.push(where + ': ' + msg);
    if (!ep || typeof ep !== 'object') return bad('缺少端点');
    switch (ep.type) {
      case 'lonePair':
        if (typeof ep.ownerAtomId !== 'string') bad('lonePair.ownerAtomId 必须是字符串');
        if (typeof ep.slotId !== 'string') bad('lonePair.slotId 必须是字符串');
        break;
      case 'radical':
        if (typeof ep.ownerAtomId !== 'string') bad('radical.ownerAtomId 必须是字符串');
        break;
      case 'bond':
        if (typeof ep.bondId !== 'string') bad('bond.bondId 必须是字符串');
        if (ep.component !== 'sigma' && ep.component !== 'pi') bad('bond.component 必须是 sigma 或 pi');
        break;
      case 'atom':
        if (typeof ep.atomId !== 'string') bad('atom.atomId 必须是字符串');
        break;
      case 'formingBond':
        if (typeof ep.atomA !== 'string' || typeof ep.atomB !== 'string') bad('formingBond 需要两个原子 ID');
        if (ep.atomA === ep.atomB) bad('formingBond 两端不能是同一个原子');
        break;
      case 'free':
        if (!finite(ep.x) || !finite(ep.y)) bad('free 端点需要有限坐标');
        break;
      default:
        bad('未知端点类型 ' + String(ep.type));
    }
    if (ep.last !== undefined && (!finite(ep.last && ep.last.x) || !finite(ep.last && ep.last.y))) {
      bad('last 位置必须是有限坐标');
    }
  }

  /* 端点引用的原子 ID 列表（用于身份/失效判断） */
  function endpointAtomIds(ep) {
    if (!ep) return [];
    if (ep.type === 'lonePair' || ep.type === 'radical') return [ep.ownerAtomId];
    if (ep.type === 'atom') return [ep.atomId];
    if (ep.type === 'formingBond') return [ep.atomA, ep.atomB];
    return [];
  }

  function endpointBondIds(ep) {
    return ep && ep.type === 'bond' ? [ep.bondId] : [];
  }

  /* ---------------- 孤对 ---------------- */

  /* 单个孤对槽位：方位以「相对参考邻居的方向」保存，旋转分子时随原子一起转 */
  function makeLonePair(ownerAtomId, opts) {
    const o = opts || {};
    return {
      id: newId('lp'),
      ownerAtomId: ownerAtomId,
      origin: o.origin === 'manual' ? 'manual' : 'auto',
      electronCount: 2,
      angle: finite(o.angle) ? o.angle : 0,          // 度，结构坐标（y 向下，顺时针为正）
      radius: finite(o.radius) ? o.radius : 0.42,     // 相对键长
      refAtomId: typeof o.refAtomId === 'string' ? o.refAtomId : null, // 角度参考邻居
      angleRel: finite(o.angleRel) ? o.angleRel : null,                // 相对参考邻居的角度
      visible: o.visible !== false
    };
  }

  /* 实际绘制角度：优先「参考邻居 + 相对角」，参考邻居没了就退回绝对角 */
  function lonePairAngle(lp, ctx) {
    if (lp.refAtomId && ctx && ctx.atomPos) {
      const owner = ctx.atomPos(lp.ownerAtomId);
      const ref = ctx.atomPos(lp.refAtomId);
      if (owner && ref) {
        const base = angleOf({ x: ref.x - owner.x, y: ref.y - owner.y });
        const relRad = finite(lp.angleRel) ? (lp.angleRel * Math.PI / 180) : 0;
        return base + relRad;
      }
    }
    return (lp.angle || 0) * Math.PI / 180;
  }

  function lonePairPosition(lp, ctx) {
    const owner = ctx && ctx.atomPos ? ctx.atomPos(lp.ownerAtomId) : null;
    if (!owner) return null;
    const ang = lonePairAngle(lp, ctx);
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };

    // 如果 ctx 提供了真实标签边界与屏幕尺度（真实渲染/交互）
    if (ctx && typeof ctx.atomLabelBox === 'function' && typeof ctx.unit === 'function') {
      const box = ctx.atomLabelBox(lp.ownerAtomId);
      const u = ctx.unit(); // 1 CSS px 对应多少模型坐标
      const dotR = 2.1;     // 点半径 (CSS px)
      const gap = 1.5;      // 标签边缘到点边缘固定约 1.5 CSS px（贴近原子，用户反馈）
      let rEdgeCss = 0;
      if (box && box.hasLabel && box.hwCss > 0 && box.hhCss > 0) {
        rEdgeCss = labelRayDistance(owner, box, dir, u) / u;
      } else {
        rEdgeCss = 2.2;     // 无标签骨架原子避让
      }
      const distCss = rEdgeCss + gap + dotR;
      const rModel = distCss * u;
      return { x: owner.x + dir.x * rModel, y: owner.y + dir.y * rModel };
    }

    // 纯模型/无DOM环境：使用 lp.radius 或基准 0.42
    const r = finite(lp.radius) ? lp.radius : 0.42;
    return { x: owner.x + dir.x * r, y: owner.y + dir.y * r };
  }

  /* 待成键箭头落点：
     - 两电子箭头：贴近受体字形/骨架顶点，保留少量待成键间隙。
       不再按供受体距离退开 1/4，避免分子离远后箭头尖也离 C 很远。
     - 单电子鱼钩：落在两原子中间附近（两根鱼钩在中点汇合）。 */
  function formingBondLanding(targetEp, sourceEp, electronCount, ctx) {
    if (!targetEp || targetEp.type !== 'formingBond') return null;
    const posA = ctx && ctx.atomPos ? ctx.atomPos(targetEp.atomA) : null;
    const posB = ctx && ctx.atomPos ? ctx.atomPos(targetEp.atomB) : null;
    if (!posA || !posB) return null;

    let donor = targetEp.atomA, acceptor = targetEp.atomB;
    let pDonor = posA, pAcceptor = posB;
    const srcOwner = sourceEp && (sourceEp.type === 'lonePair' || sourceEp.type === 'radical')
      ? sourceEp.ownerAtomId
      : (sourceEp && sourceEp.type === 'atom' ? sourceEp.atomId : null);

    if (srcOwner === targetEp.atomB) {
      donor = targetEp.atomB; acceptor = targetEp.atomA;
      pDonor = posB; pAcceptor = posA;
    } else if (srcOwner === targetEp.atomA) {
      donor = targetEp.atomA; acceptor = targetEp.atomB;
      pDonor = posA; pAcceptor = posB;
    }

    const d = dist(pDonor, pAcceptor);
    if (!(d > 1e-6)) return { x: (pDonor.x + pAcceptor.x) / 2, y: (pDonor.y + pAcceptor.y) / 2 };
    const dir = { x: (pAcceptor.x - pDonor.x) / d, y: (pAcceptor.y - pDonor.y) / d };

    if (electronCount === 1) {
      return { x: pDonor.x + dir.x * (d * 0.5), y: pDonor.y + dir.y * (d * 0.5) };
    }

    const box = readAtomLabelBox(ctx, acceptor);
    const hydrogenLabel = hasHydrogenGlyphs(box) ? box : null;
    const clearance = atomLabelClearance(pAcceptor, box, ctx, { x: -dir.x, y: -dir.y }, !!hydrogenLabel);
    const distFromAcceptor = clearance + FORMING_BOND_GAP;
    const targetDist = Math.max(0, d - distFromAcceptor);
    return {
      x: pDonor.x + dir.x * targetDist,
      y: pDonor.y + dir.y * targetDist,
      donor: donor,
      acceptor: acceptor,
      pDonor: pDonor,
      pAcceptor: pAcceptor,
      hydrogenLabel: hydrogenLabel
    };
  }

  /* ---------------- 端点锚点（渲染与命中都用同一套规则） ---------------- */

  const LABEL_CLEARANCE = 0.34;   // 原子标签半径（结构坐标），箭头端点刻意避让，不算漂移
  const BOND_OFFSET = 0.08;       // 键端点从键中心法向偏移，避免与键线重合（贴近键线，用户反馈）
  const ATOM_LABEL_GAP = 0.11;    // 字形边缘留白：100% 下约 4.4px，较之前增加 1.2px
  const FORMING_BOND_GAP = 0.06;

  /* 返回 {x, y, ok, reason, atomId?}；ok=false 表示引用已失效（有 last 时用 last） */
  function endpointAnchor(ep, ctx) {
    const miss = (reason) => {
      const last = ep && ep.last && finite(ep.last.x) ? { x: ep.last.x, y: ep.last.y } : null;
      return { x: last ? last.x : 0, y: last ? last.y : 0, ok: false, reason: reason, hasLast: !!last };
    };
    if (!ep || !ctx) return miss('missing');
    switch (ep.type) {
      case 'lonePair': {
        const lp = ctx.lonePair ? ctx.lonePair(ep.slotId) : null;
        if (!lp || lp.ownerAtomId !== ep.ownerAtomId) return miss('lonePair');
        const pos = lonePairPosition(lp, ctx);
        return pos ? { x: pos.x, y: pos.y, ok: true, atomId: ep.ownerAtomId, lonePairId: lp.id }
                   : miss('lonePair');
      }
      case 'radical': {
        const pos = ctx.atomPos(ep.ownerAtomId);
        if (!pos) return miss('radical');
        // 自由基电子默认落在原子右上方，避开标签中心
        return { x: pos.x + 0.3, y: pos.y - 0.3, ok: true, atomId: ep.ownerAtomId };
      }
      case 'bond': {
        const b = ctx.bondInfo ? ctx.bondInfo(ep.bondId) : null;
        if (!b) return miss('bond');
        if (ep.component === 'pi' && b.type < 2) return miss('piUnavailable');
        // 键电子起笔/落笔直接放在键正中间（用户规则：和键有关系的放在键中间）；
        // 弧线由 bend 自然离开键线，不需要法向预偏移
        const mid = lerp(b.begin, b.end, 0.5);
        return { x: mid.x, y: mid.y, ok: true, bond: b };
      }
      case 'atom': {
        const pos = ctx.atomPos(ep.atomId);
        return pos ? { x: pos.x, y: pos.y, ok: true, atomId: ep.atomId } : miss('atom');
      }
      case 'formingBond': {
        const a = ctx.atomPos(ep.atomA);
        const b = ctx.atomPos(ep.atomB);
        if (!a || !b) return miss('formingBond');
        const mid = lerp(a, b, 0.5);
        return { x: mid.x, y: mid.y, ok: true, atomIds: [ep.atomA, ep.atomB], a: a, b: b };
      }
      case 'free':
        return finite(ep.x) && finite(ep.y) ? { x: ep.x, y: ep.y, ok: true, free: true } : miss('free');
      default:
        return miss('unknown');
    }
  }

  /* 箭头两端的「实际绘制点」：起点从来源向外让开标签，终点向目标缩进让开标签。
     避让量按真实标签盒计算（裸碳没有标签就只留很小间隙），不写死屏幕像素。 */
  // 从元素位置沿指定方向射到标签边缘；保留 CH₃ / H₃C / OH 的真实偏心位置。
  function labelRayDistance(owner, box, dir, unit) {
    const r = box.rect || { x1: owner.x - box.hwCss * unit, x2: owner.x + box.hwCss * unit,
      y1: owner.y - box.hhCss * unit, y2: owner.y + box.hhCss * unit };
    const exits = [];
    if (Math.abs(dir.x) > 1e-9) exits.push(((dir.x > 0 ? r.x2 : r.x1) - owner.x) / dir.x);
    if (Math.abs(dir.y) > 1e-9) exits.push(((dir.y > 0 ? r.y2 : r.y1) - owner.y) / dir.y);
    const valid = exits.filter(finite);
    return valid.length ? Math.max(0, Math.min(...valid)) : 0;
  }

  function readAtomLabelBox(ctx, uuid) {
    try {
      return ctx.atomLabelBox ? ctx.atomLabelBox(uuid) : null;
    } catch (e) { return null; /* 重绘期间标签盒可能不可用 */ }
  }

  function hasHydrogenGlyphs(box) {
    return box && box.atomRect && box.hydrogenRects && box.hydrogenRects.length > 0;
  }

  function atomLabelClearance(owner, box, ctx, dir, nucleusOnly) {
    if (!box || !box.hasLabel || !(box.hwCss > 0)) return 0.12;
    const unit = typeof ctx.unit === 'function' ? ctx.unit() : 1 / 40;
    const used = nucleusOnly && box.atomRect ? Object.assign({}, box, { rect: box.atomRect }) : box;
    return labelRayDistance(owner, used, dir, unit) + ATOM_LABEL_GAP;
  }

  function dockAtGlyph(atom, control, box, ctx, extraGap = 0) {
    const dir = norm({ x: control.x - atom.x, y: control.y - atom.y });
    const clear = atomLabelClearance(atom, box, ctx, dir, true) + extraGap;
    return { point: { x: atom.x + dir.x * clear, y: atom.y + dir.y * clear }, valid: clear < dist(atom, control) };
  }

  // 用控制多边形的包围盒快速排除，再细分剩下的一小段弧线。
  function curveTouchesRect(a, c, b, r, depth = 0) {
    const pad = 0.035; // 线宽的一半和少量字形留白
    if (Math.max(a.x, c.x, b.x) < r.x1 - pad || Math.min(a.x, c.x, b.x) > r.x2 + pad ||
        Math.max(a.y, c.y, b.y) < r.y1 - pad || Math.min(a.y, c.y, b.y) > r.y2 + pad) return false;
    if (depth === 8) return true;
    const left = lerp(a, c, 0.5), right = lerp(c, b, 0.5), mid = lerp(left, right, 0.5);
    return curveTouchesRect(a, left, mid, r, depth + 1) || curveTouchesRect(mid, right, b, r, depth + 1);
  }

  function touchesHydrogen(a, c, b, rects, electronCount) {
    // V 形尖端按规范绘图尺度预留足迹，短弧的尖端也按比例收小。
    const head = Math.min(0.30, 0.40 * (dist(a, c) + dist(c, b)));
    const dir = norm({ x: c.x - b.x, y: c.y - b.y });
    const barbs = electronCount === 1 ? [-1] : [-1, 1];
    return rects.some(r => curveTouchesRect(a, c, b, r) || barbs.some(side => {
      const p = { x: b.x + (dir.x * 0.89 - side * dir.y * 0.46) * head,
        y: b.y + (dir.y * 0.89 + side * dir.x * 0.46) * head };
      return curveTouchesRect(b, lerp(b, p, 0.5), p, r);
    }));
  }

  function arrowGeometry(arrow, ctx) {
    const s = endpointAnchor(arrow.source, ctx);
    const t = endpointAnchor(arrow.target, ctx);
    const bend = finite(arrow.geometry && arrow.geometry.bend) ? arrow.geometry.bend : 0;

    let a = { x: s.x, y: s.y };
    let b = { x: t.x, y: t.y };
    let acceptor = null;

    // 起点：从原子/孤对向外让开一点，避免压住标签（贴近原子，用户反馈）
    if (s.ok && (arrow.source.type === 'lonePair' || arrow.source.type === 'radical')) {
      const dir = norm({ x: b.x - a.x, y: b.y - a.y });
      a = { x: a.x + dir.x * 0.06, y: a.y + dir.y * 0.06 };
    }
    if (t.ok && arrow.target.type === 'formingBond') {
      const fbPt = formingBondLanding(arrow.target, arrow.source, arrow.electronCount, ctx);
      if (fbPt) {
        b = { x: fbPt.x, y: fbPt.y };
        if (fbPt.hydrogenLabel) acceptor = { atom: fbPt.pAcceptor, box: fbPt.hydrogenLabel, gap: FORMING_BOND_GAP };
      } else {
        const dir = norm({ x: b.x - a.x, y: b.y - a.y });
        b = { x: b.x - dir.x * 0.06, y: b.y - dir.y * 0.06 };
      }
    }

    // 弦长下限：短于 0.5（键长≈1 的结构坐标）时画不出可辨认的弧（验收 A05/A06）。
    // 仅键来源沿键退向另一端（C—Br 中段→Br 的自然画法）。
    // 原子/孤对不后撤，避免把真正的起点移到别处。
    if (s.ok && t.ok && arrow.source.type === 'bond' && s.bond) {
      const D = dist(a, b);
      if (D > 1e-6 && D < 0.5) {
        const dir = norm({ x: b.x - a.x, y: b.y - a.y });
        const other = dist(a, s.bond.begin) > dist(a, s.bond.end) ? s.bond.begin : s.bond.end;
        const maxBack = Math.max(0, dist(a, other) - 0.12);
        const back = Math.min(0.5 - D, maxBack);
        a = { x: a.x - dir.x * back, y: a.y - dir.y * back };
      }
    }

    const routingStart = { x: a.x, y: a.y }, routingEnd = { x: b.x, y: b.y };
    let c = controlPoint(a, b, bend);
    // A detached copy has already been docked around its original labels. Its
    // control point need not lie above the midpoint of the shortened chord.
    // Keep the complete curve in a chord-local frame so moving/zooming a free
    // copy preserves both tangents without retaining references to source atoms.
    const frame = arrow.geometry && arrow.geometry.controlFrame;
    if (arrow.source.type === 'free' && arrow.target.type === 'free' &&
        frame && finite(frame.along) && finite(frame.normal)) {
      const dx = b.x - a.x, dy = b.y - a.y;
      c = { x: a.x + frame.along * dx - frame.normal * dy,
            y: a.y + frame.along * dy + frame.normal * dx };
    }
    if (t.ok && arrow.target.type === 'atom') {
      acceptor = { atom: b, box: readAtomLabelBox(ctx, arrow.target.atomId), gap: 0 };
    }
    const sourceIsAtom = s.ok && arrow.source.type === 'atom';
    const sourceBox = sourceIsAtom ? readAtomLabelBox(ctx, arrow.source.atomId) : null;
    const dockSource = control => sourceIsAtom ? dockAtGlyph(a, control, sourceBox, ctx) : { point: a, valid: true };
    const dockTarget = control => acceptor
      ? dockAtGlyph(acceptor.atom, control, acceptor.box, ctx, acceptor.gap) : { point: b, valid: true };
    let start = dockSource(c), end = dockTarget(c);

    // H 和下标遮住入射切线时，从原来弧线的同侧绕到元素字形旁。只改绘制坐标。
    if (acceptor && hasHydrogenGlyphs(acceptor.box)) {
      const { atom, box } = acceptor;
      const rects = box.hydrogenRects;
      const touches = (from, control, to) => touchesHydrogen(from.point, control, to.point, rects, arrow.electronCount);
      if (touches(start, c, end)) {
        const side = c.y >= atom.y ? 1 : -1;
        const height = 2 * Math.max(...rects.map(r => Math.max(atom.y - r.y1, r.y2 - atom.y))) + 0.22;
        const xDir = a.x < atom.x ? -1 : (a.x > atom.x ? 1 : 0);

        // 优先在原来的绕行侧尝试少量斜向控制点，让末段逐渐转向元素字形
        let bestOblique = null;
        if (xDir !== 0) {
          let maxObstacleAngle = 0;
          for (const r of rects) {
            const y = side > 0 ? r.y2 : r.y1;
            const x = xDir > 0 ? r.x1 : r.x2;
            const dx = Math.abs(x - atom.x), dy = Math.abs(y - atom.y);
            if (dx > 1e-4) {
              const deg = Math.atan2(dy, dx) * 180 / Math.PI;
              if (deg > maxObstacleAngle) maxObstacleAngle = deg;
            }
          }
          const baseDeg = maxObstacleAngle > 0 ? maxObstacleAngle : 60;
          const candidateDegs = [
            Math.max(45, baseDeg - 4),
            baseDeg,
            baseDeg + 6,
            baseDeg + 14,
            baseDeg + 22
          ].filter(d => d < 88);

          const chordDist = dist(a, atom);
          // 弧高优先更饱满均匀的曲率（弯多点），避免前半段偏平、末端急转
          const targetR = Math.max(height * 1.45, Math.min(chordDist * 0.95, height * 1.8));
          const radii = [targetR, targetR * 0.85, height * 1.25, height * 1.0];

          const passed = [];
          for (const deg of candidateDegs) {
            const rad = deg * Math.PI / 180;
            for (const R of radii) {
              const control = {
                x: atom.x + xDir * R * Math.cos(rad),
                y: atom.y + side * R * Math.sin(rad)
              };
              const from = dockSource(control), to = dockTarget(control);
              if (from.valid && to.valid && !touches(from, control, to)) {
                const leg1 = dist(from.point, control);
                const leg2 = dist(control, to.point);
                const balance = Math.max(leg1, leg2) / Math.min(leg1, leg2);
                const tan0 = quadTangent(from.point, control, to.point, 0);
                const tan1 = quadTangent(from.point, control, to.point, 1);
                let delta = Math.abs(Math.atan2(tan1.y, tan1.x) - Math.atan2(tan0.y, tan0.x));
                if (delta > Math.PI) delta = 2 * Math.PI - delta;
                // 偏角差 + 控制臂对称度（越接近 1 曲线各段曲率越均匀，告别折钩）
                passed.push({ control, from, to, score: delta + (balance - 1.0) * 0.45 });
                break;
              }
            }
          }
          if (passed.length > 0) {
            passed.sort((p1, p2) => p1.score - p2.score);
            bestOblique = passed[0];
          }
        }

        if (bestOblique) {
          c = bestOblique.control;
          start = bestOblique.from;
          end = bestOblique.to;
        } else {
          // 现有竖直方案作最后兜底
          for (const lift of [side, 1.8 * side, -side, -1.8 * side]) {
            const control = { x: atom.x, y: atom.y + height * lift };
            const from = dockSource(control), to = dockTarget(control);
            if (from.valid && to.valid && !touches(from, control, to)) {
              c = control;
              start = from;
              end = to;
              break;
            }
          }
        }
      }
    }
    return {
      start: start.point, end: end.point, control: c, bend: bend,
      routingStart: routingStart, routingEnd: routingEnd,
      sourceOk: s.ok, targetOk: t.ok,
      sourceReason: s.reason || null, targetReason: t.reason || null,
      sourceAnchor: s, targetAnchor: t,
      degenerate: !start.valid || !end.valid || dist(start.point, end.point) < 1e-3
    };
  }

  /* ---------------- 自动孤对建议 ---------------- */

  /* chem 快照由适配器提供（纯数据）：
     { atoms: [{ uuid, label, charge, radical, aromatic, hasQuery, neighbors: [{ uuid, order, aromatic }] }] }
     返回 { slots: [{ ownerAtomId, count, angles: [deg], refAtomId }], unsupported: [{ ownerAtomId, reason }] } */
  function suggestLonePairs(chem) {
    const out = { slots: [], unsupported: [] };
    const atoms = (chem && chem.atoms) || [];
    const byId = new Map(atoms.map(a => [a.uuid, a]));

    for (const a of atoms) {
      const label = a.label;
      if (!label || !Object.prototype.hasOwnProperty.call(VALENCE, label)) {
        if (label && label !== 'C' && label !== 'H') out.unsupported.push({ ownerAtomId: a.uuid, reason: '元素未覆盖' });
        continue;
      }
      if (a.hasQuery || a.aromatic) {
        out.unsupported.push({ ownerAtomId: a.uuid, reason: a.aromatic ? '芳香环境' : '查询原子/R 基' });
        continue;
      }
      const nb = a.neighbors || [];
      let order = 0;
      let aromatic = false;
      for (const n of nb) {
        if (n.aromatic) aromatic = true;
        order += (typeof n.order === 'number' && Number.isFinite(n.order)) ? n.order : 1;
      }
      // 隐式氢也是成键电子来源：不把隐式氢算进来，水/氨会被算成 3 对/2 对
      if (Number.isFinite(a.implicitH) && a.implicitH > 0) order += a.implicitH;
      if (aromatic) { out.unsupported.push({ ownerAtomId: a.uuid, reason: '芳香环境' }); continue; }
      if (order > 4) { out.unsupported.push({ ownerAtomId: a.uuid, reason: '超价/异常价态' }); continue; }
      const charge = Number.isFinite(a.charge) ? a.charge : 0;
      if (Math.abs(charge) > 3) { out.unsupported.push({ ownerAtomId: a.uuid, reason: '电荷超出覆盖范围' }); continue; }
      const radical = a.radical ? 1 : 0;
      const electrons = VALENCE[label] - charge - order - radical;
      if (electrons < 0) { out.unsupported.push({ ownerAtomId: a.uuid, reason: '价态异常（电子数为负）' }); continue; }
      if (electrons % 2 !== 0) { out.unsupported.push({ ownerAtomId: a.uuid, reason: '电子数为奇数，未覆盖' }); continue; }
      const count = electrons / 2;
      if (!count) continue;   // 0 对：不需要标记

      const angles = slotAngles(a, count, byId);
      out.slots.push({
        ownerAtomId: a.uuid,
        count: count,
        angles: angles.angles,
        refAtomId: angles.refAtomId,
        refAngle: angles.refAngle
      });
    }
    return out;
  }

  /* 把 count 个孤对摆到「邻居之间的空隙」里：按空隙大小分配，空隙内均匀展开。
     目标：不压在键上、不互相重叠、旋转分子时整体跟着转（角度按参考邻居保存）。 */
  function slotAngles(atom, count, byId) {
    const nbAngles = [];
    for (const n of atom.neighbors || []) {
      if (!finite(n.angle)) continue;
      nbAngles.push(((n.angle % 360) + 360) % 360);
    }
    nbAngles.sort((x, y) => x - y);
    const refNb = (atom.neighbors && atom.neighbors.length) ? atom.neighbors[0] : null;
    const refAtomId = refNb ? refNb.uuid : null;
    const refAngle = refNb && finite(refNb.angle) ? ((refNb.angle % 360) + 360) % 360 : (nbAngles.length ? nbAngles[0] : 0);

    if (!nbAngles.length) {
      // 没有邻居（如卤离子）：均匀分布，从右侧开始
      const angles = [];
      for (let i = 0; i < count; i++) angles.push((360 / count) * i);
      return { angles: angles, refAtomId: null, refAngle: 0 };
    }

    // 空隙（含跨越 0 度的缺口），按大小降序
    const gaps = [];
    for (let i = 0; i < nbAngles.length; i++) {
      const a0 = nbAngles[i];
      const a1 = (i + 1 < nbAngles.length) ? nbAngles[i + 1] : nbAngles[0] + 360;
      gaps.push({ start: a0, size: a1 - a0 });
    }
    gaps.sort((x, y) => y.size - x.size);
    const total = gaps.reduce((s, g) => s + g.size, 0) || 1;

    // 先填最大空隙：一个空隙能放几对由它的大小决定（每对至少 80°），
    // 这样水（H-O-H 之间的小空隙）不会把孤对塞到两个氢中间
    const alloc = gaps.map(() => 0);
    let remaining = count;
    for (let gi = 0; gi < gaps.length && remaining > 0; gi++) {
      const cap = Math.max(1, Math.floor(gaps[gi].size / 80));
      const n = Math.min(cap, remaining);
      alloc[gi] = n;
      remaining -= n;
    }
    if (remaining > 0) alloc[0] += remaining;

    const angles = [];
    for (let gi = 0; gi < gaps.length; gi++) {
      const n = alloc[gi];
      if (!n) continue;
      const g = gaps[gi];
      const mid = g.start + g.size / 2;
      // 空隙内均匀展开，但总跨度不超过 70°，且两端各留 20° 避让邻居键
      const usable = Math.max(18, Math.min(60, g.size - 40));
      const step = n > 1 ? usable / (n - 1) : 0;
      for (let i = 0; i < n; i++) {
        const off = n > 1 ? (i - (n - 1) / 2) * step : 0;
        angles.push(mid + off);
      }
    }
    return {
      angles: angles.map(a => ((a % 360) + 360) % 360),
      refAtomId: refAtomId,
      refAngle: refAngle
    };
  }

  /* 建议槽位 → 具体孤对对象（同一原子第 i 对的角度 = angles[i]） */
  function lonePairsFromSuggestions(suggestion, existing) {
    const out = [];
    for (const slot of suggestion.slots) {
      for (let i = 0; i < slot.count; i++) {
        const angle = slot.angles[i] === undefined ? (360 / slot.count) * i : slot.angles[i];
        const lp = makeLonePair(slot.ownerAtomId, {
          origin: 'auto',
          angle: angle,
          refAtomId: slot.refAtomId || null,
          angleRel: slot.refAtomId ? normalizeDelta(angle - (slot.refAngle || 0)) : null
        });
        // 若已有同原子、同角度的孤对（用户手工标记），不重复生成
        const dup = (existing || []).some(e => e.ownerAtomId === lp.ownerAtomId && Math.abs(normalizeDelta(e.angle - lp.angle)) < 12);
        if (!dup) out.push(lp);
      }
    }
    return out;
  }

  function normalizeDelta(deg) {
    let d = ((deg % 360) + 360) % 360;
    if (d > 180) d -= 360;
    return d;
  }

  /* ---------------- 模型对象 ---------------- */

  class MechanismModel {
    constructor(state) {
      this.state = normalizeState(state || emptyState());
      this.listeners = new Set();
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(reason) { for (const fn of Array.from(this.listeners)) { try { fn(reason || 'change', this); } catch (e) { if (root.console) console.error('[mechanism] listener error', e); } } }

    cloneState() { return clone(this.state); }
    setState(next, reason) { this.state = normalizeState(next); this.emit(reason || 'set'); }

    lonePair(id) { return this.state.lonePairs.find(x => x.id === id) || null; }
    arrow(id) { return this.state.arrows.find(x => x.id === id) || null; }

    lonePairsOf(atomId) { return this.state.lonePairs.filter(x => x.ownerAtomId === atomId); }

    /* 每个原子已持久化的孤对数量（自动显示时用来判断是否需要建议） */
    isVisible(id) {
      const lp = this.lonePair(id);
      return !!(lp && lp.visible !== false);
    }

    addLonePair(lp) { this.state.lonePairs.push(lp); return lp; }
    removeLonePair(id) {
      const i = this.state.lonePairs.findIndex(x => x.id === id);
      if (i < 0) return null;
      const [lp] = this.state.lonePairs.splice(i, 1);
      return lp;
    }
    addArrow(a) { this.state.arrows.push(a); return a; }
    removeArrow(id) {
      const i = this.state.arrows.findIndex(x => x.id === id);
      if (i < 0) return null;
      const [a] = this.state.arrows.splice(i, 1);
      return a;
    }

    /* 箭头引用某个孤对槽位时，删除该槽位会把箭头标为待重绑（不静默删除箭头） */
    arrowsUsingLonePair(lpId) {
      return this.state.arrows.filter(a => a.source && a.source.type === 'lonePair' && a.source.slotId === lpId);
    }

    counts() {
      return { lonePairs: this.state.lonePairs.length, arrows: this.state.arrows.length };
    }

    isEmpty() { return !this.state.lonePairs.length && !this.state.arrows.length; }
  }

  function normalizeState(s) {
    const out = {
      steps: Array.isArray(s.steps) && s.steps.length ? s.steps.map(x => ({ id: String(x.id || DEFAULT_STEP), label: String(x.label || '步骤') })) : [{ id: DEFAULT_STEP, label: '步骤 1' }],
      lonePairs: Array.isArray(s.lonePairs) ? s.lonePairs : [],
      arrows: Array.isArray(s.arrows) ? s.arrows : []
    };
    // 箭头几何补齐 mode/routeVersion：**缺字段的旧数据按 manual 读入**，
    // 这样打开旧 .molwork 或旧内存快照都不会被新算法悄悄改掉外观。
    for (const ar of out.arrows) {
      if (!ar || typeof ar !== 'object') continue;
      if (!ar.geometry || typeof ar.geometry !== 'object') ar.geometry = { bend: 0 };
      if (!finite(ar.geometry.bend)) ar.geometry.bend = 0;
      if (ar.geometry.mode !== 'auto' && ar.geometry.mode !== 'manual') ar.geometry.mode = 'manual';
      if (!Number.isInteger(ar.geometry.routeVersion) || ar.geometry.routeVersion < 0) ar.geometry.routeVersion = 0;
    }
    return out;
  }

  /* ---------------- 箭头工厂 ---------------- */

  /* geometry：{ bend, mode, routeVersion, controlFrame? }
     - mode = 'auto'：bend 由自动排布算出；端点重绑后允许重新规划
     - mode = 'manual'：用户拖过曲率手柄/滑杆；重绑时保留原曲率与侧向
     旧文件只有 { bend }：读入时一律按 manual 处理，绝不静默改图。 */
  function makeArrow(source, target, opts) {
    const o = opts || {};
    const mode = o.mode === 'manual' ? 'manual' : (o.mode === 'auto' ? 'auto' : 'auto');
    return {
      id: newId('ar'),
      electronCount: o.electronCount === 1 ? 1 : 2,
      source: source,
      target: target,
      geometry: {
        bend: finite(o.bend) ? o.bend : 0,
        mode: mode,
        ...(o.controlFrame && finite(o.controlFrame.along) && finite(o.controlFrame.normal)
          ? { controlFrame: { along: o.controlFrame.along, normal: o.controlFrame.normal } } : {}),
        routeVersion: Number.isInteger(o.routeVersion) && o.routeVersion >= 0
          ? o.routeVersion
          : (mode === 'auto' ? ROUTE_VERSION : 0)
      },
      stepId: o.stepId || DEFAULT_STEP,
      pairId: o.pairId || null
    };
  }

  function arrowMode(arrow) {
    const g = arrow && arrow.geometry;
    return g && g.mode === 'auto' ? 'auto' : 'manual';
  }

  /* ---------------- 机理层校验（供 workbench-storage 调用） ---------------- */
  function validateMechanism(mech, errs) {
    if (!mech || typeof mech !== 'object') { errs.push('缺少 mechanism'); return; }
    const lpIds = new Set();
    const arIds = new Set();
    const lps = Array.isArray(mech.lonePairs) ? mech.lonePairs : [];
    const arrows = Array.isArray(mech.arrows) ? mech.arrows : [];
    if (!Array.isArray(mech.lonePairs)) errs.push('mechanism.lonePairs 必须是数组');
    if (!Array.isArray(mech.arrows)) errs.push('mechanism.arrows 必须是数组');

    for (const lp of lps) {
      if (!lp || typeof lp.id !== 'string' || !lp.id) { errs.push('孤对缺少 id'); continue; }
      if (lpIds.has(lp.id)) errs.push('孤对 ID 重复：' + lp.id);
      lpIds.add(lp.id);
      if (typeof lp.ownerAtomId !== 'string') errs.push('孤对 ' + lp.id + ' 缺少 ownerAtomId');
      if (lp.origin !== 'auto' && lp.origin !== 'manual') errs.push('孤对 ' + lp.id + ' 的 origin 非法');
      if (lp.electronCount !== 2) errs.push('孤对 ' + lp.id + ' 的 electronCount 必须是 2');
      if (!finite(lp.angle) || !finite(lp.radius)) errs.push('孤对 ' + lp.id + ' 的几何非法');
      if (lp.radius < 0.05 || lp.radius > 2) errs.push('孤对 ' + lp.id + ' 的半径超出范围');
    }

    for (const ar of arrows) {
      if (!ar || typeof ar.id !== 'string' || !ar.id) { errs.push('箭头缺少 id'); continue; }
      if (arIds.has(ar.id)) errs.push('箭头 ID 重复：' + ar.id);
      arIds.add(ar.id);
      if (ar.electronCount !== 1 && ar.electronCount !== 2) errs.push('箭头 ' + ar.id + ' 的 electronCount 必须是 1 或 2');
      validateEndpoint(ar.source, errs, '箭头 ' + ar.id + ' 起点');
      validateEndpoint(ar.target, errs, '箭头 ' + ar.id + ' 终点');
      if (!ar.geometry || !finite(ar.geometry.bend)) errs.push('箭头 ' + ar.id + ' 的 geometry.bend 非法');
      if (ar.geometry && Math.abs(ar.geometry.bend) > 3) errs.push('箭头 ' + ar.id + ' 的曲率超出范围');
      if (ar.geometry && ar.geometry.mode !== undefined &&
          ar.geometry.mode !== 'auto' && ar.geometry.mode !== 'manual') {
        errs.push('箭头 ' + ar.id + ' 的 geometry.mode 必须是 auto 或 manual');
      }
      if (ar.geometry && ar.geometry.routeVersion !== undefined &&
          (!Number.isInteger(ar.geometry.routeVersion) || ar.geometry.routeVersion < 0)) {
        errs.push('箭头 ' + ar.id + ' 的 geometry.routeVersion 非法');
      }
      if (ar.geometry && ar.geometry.controlFrame !== undefined &&
          (!ar.geometry.controlFrame || !finite(ar.geometry.controlFrame.along) ||
           !finite(ar.geometry.controlFrame.normal))) {
        errs.push('箭头 ' + ar.id + ' 的 geometry.controlFrame 非法');
      }
      if (typeof ar.stepId !== 'string') errs.push('箭头 ' + ar.id + ' 缺少 stepId');
    }
    if (mech.steps !== undefined) {
      if (!Array.isArray(mech.steps)) errs.push('mechanism.steps 必须是数组');
      else {
        const seen = new Set();
        for (const st of mech.steps) {
          if (!st || typeof st.id !== 'string') { errs.push('步骤缺少 id'); continue; }
          if (seen.has(st.id)) errs.push('步骤 ID 重复：' + st.id);
          seen.add(st.id);
        }
      }
    }
    return errs;
  }

  /* 稳定序列化：字段顺序固定、不含时间戳、不含运行时 id */
  function serializeMechanism(mech) {
    const lps = (mech.lonePairs || []).map(lp => ({
      id: lp.id,
      ownerAtomId: lp.ownerAtomId,
      origin: lp.origin,
      electronCount: 2,
      angle: round(lp.angle),
      radius: round(lp.radius),
      refAtomId: lp.refAtomId || null,
      angleRel: lp.angleRel === null || lp.angleRel === undefined ? null : round(lp.angleRel),
      visible: lp.visible !== false
    }));
    const arrows = (mech.arrows || []).map(ar => ({
      id: ar.id,
      electronCount: ar.electronCount,
      source: serializeEndpoint(ar.source),
      target: serializeEndpoint(ar.target),
      geometry: {
        bend: round(ar.geometry.bend),
        mode: arrowMode(ar),
        ...(ar.geometry.controlFrame ? { controlFrame: {
          along: round(ar.geometry.controlFrame.along), normal: round(ar.geometry.controlFrame.normal)
        } } : {}),
        routeVersion: Number.isInteger(ar.geometry.routeVersion) ? ar.geometry.routeVersion : 0
      },
      stepId: ar.stepId || DEFAULT_STEP,
      pairId: ar.pairId || null
    }));
    const steps = (mech.steps || []).map(s => ({ id: s.id, label: s.label }));
    return { lonePairs: lps, arrows: arrows, steps: steps };
  }

  function serializeEndpoint(ep) {
    if (!ep) return null;
    const out = { type: ep.type };
    if (ep.type === 'lonePair') { out.ownerAtomId = ep.ownerAtomId; out.slotId = ep.slotId; }
    else if (ep.type === 'radical') { out.ownerAtomId = ep.ownerAtomId; }
    else if (ep.type === 'bond') { out.bondId = ep.bondId; out.component = ep.component; }
    else if (ep.type === 'atom') { out.atomId = ep.atomId; }
    else if (ep.type === 'formingBond') { out.atomA = ep.atomA; out.atomB = ep.atomB; }
    else if (ep.type === 'free') { out.x = round(ep.x); out.y = round(ep.y); }
    if (ep.last && finite(ep.last.x) && finite(ep.last.y)) out.last = { x: round(ep.last.x), y: round(ep.last.y) };
    return out;
  }

  function round(n) {
    if (!finite(n)) return 0;
    return Math.round(n * 1e6) / 1e6;
  }

  MW.model = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    DEFAULT_STEP: DEFAULT_STEP,
    ROUTE_VERSION: ROUTE_VERSION,
    VALENCE: VALENCE,
    LABEL_CLEARANCE: LABEL_CLEARANCE,
    BOND_OFFSET: BOND_OFFSET,
    newId: newId,
    clone: clone,
    emptyState: emptyState,
    normalizeState: normalizeState,
    MechanismModel: MechanismModel,
    makeLonePair: makeLonePair,
    makeArrow: makeArrow,
    arrowMode: arrowMode,
    lonePairPosition: lonePairPosition,
    lonePairAngle: lonePairAngle,
    formingBondLanding: formingBondLanding,
    endpointAnchor: endpointAnchor,
    endpointAtomIds: endpointAtomIds,
    endpointBondIds: endpointBondIds,
    endpointKind: endpointKind,
    arrowGeometry: arrowGeometry,
    suggestLonePairs: suggestLonePairs,
    lonePairsFromSuggestions: lonePairsFromSuggestions,
    controlPoint: controlPoint,
    quadPoint: quadPoint,
    quadTangent: quadTangent,
    normalizeDelta: normalizeDelta,
    validateMechanism: validateMechanism,
    serializeMechanism: serializeMechanism,
    serializeEndpoint: serializeEndpoint,
    dist: dist,
    norm: norm,
    lerp: lerp,
    perp: perp,
    angleOf: angleOf,
    finite: finite
  };
})(typeof window !== 'undefined' ? window : globalThis);
