/* MolStudio 工作台 · Ketcher 适配器
 * 所有对 Ketcher 内部结构的访问都集中在这里，别处不再猜内部对象。
 *
 * 适配边界由 tests/test_workbench_model.js 与 test_workbench_mechanism.js 回归覆盖：
 *   - 结构：editor.struct() → atoms/bonds（Map），原子坐标 atom.pp（键长≈1，y 向下）
 *   - 变换：user = pp * options.bondLength + options.offset；client = svg.getScreenCTM() · user
 *     zoom 只改 svg 的 viewBox/CTM，不改 pp 与 bondLength → 缩放/平移天然跟随
 *   - 事件：editor.event.change.add(handler)（单参数！）；undo 会触发 change，redo 不一定
 *   - 历史：editor.update(action) 把动作压栈，undo() 时才执行 perform 并把返回值当逆动作
 *   - 自建 <g> 追加到画布 svg 末尾可存活于重绘，但 setMolecule 会重建（需重新挂载）
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const M = MW.model;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function invertMatrix(m) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    return {
      a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det
    };
  }

  class KetcherAdapter {
    constructor(ketcher, doc) {
      this.k = ketcher;
      this.doc = doc;                       // iframe 的 document
      this.ed = ketcher.editor;
      this.listeners = new Set();
      this.atomLast = new Map();            // 运行时 id → 最后已知属性（undo 恢复身份用）
      this.pendingHistory = null;           // 'undo' | 'redo'：只有历史动作才允许"复活"身份
      this.atomUuid = new Map();            // 运行时 id → uuid（跨删除保留，供撤销恢复）
      this.uuidAtom = new Map();            // uuid → 运行时 id（只含当前存在的）
      this.atomSig = new Map();             // 运行时 id → 结构签名（防 id 复用串绑）
      this.bondUuid = new Map();
      this.uuidBond = new Map();
      this.bondSig = new Map();
      this.activeAtoms = null;              // 上次同步时的活跃运行时原子集合
      this.activeBonds = null;              // 上次同步时的活跃运行时键集合
      this.bondEndpoints = new Map();       // 运行时键 id → 端点原子稳定ID对 (u1--u2)
      this.pending = { struct: false, transform: false, history: false };
      this.rafId = 0;
      this.disposers = [];
      this.layerEl = null;
      this.mounted = false;
      this._svg = null;
      this._svgObserver = null;
      this._lastGeom = '';
    }

    /* ---------------- 基础读取 ---------------- */
    struct() { return this.ed.struct(); }
    options() { return this.ed.render.options; }
    bondLength() { const o = this.options(); return (o && M.finite(o.bondLength) && o.bondLength > 0) ? o.bondLength : 40; }
    offset() { const o = this.options(); return { x: (o && o.offset && M.finite(o.offset.x)) ? o.offset.x : 0, y: (o && o.offset && M.finite(o.offset.y)) ? o.offset.y : 0 }; }
    zoom() {
      const z = typeof this.ed.zoom === 'function' ? this.ed.zoom() : 1;
      return M.finite(z) && z > 0 ? z : 1;
    }

    canvasSvg() {
      const ca = this.ed.render && this.ed.render.clientArea;
      if (!ca) return null;
      const svg = ca.querySelector('svg');
      return svg || null;
    }

    /* ---------------- 坐标变换 ---------------- */
    modelToUser(p) {
      const bl = this.bondLength();
      const off = this.offset();
      return { x: p.x * bl + off.x, y: p.y * bl + off.y };
    }

    userToModel(p) {
      const bl = this.bondLength();
      const off = this.offset();
      return { x: (p.x - off.x) / bl, y: (p.y - off.y) / bl };
    }

    clientToUser(client) {
      const svg = this.canvasSvg();
      if (!svg) return null;
      const m = svg.getScreenCTM();
      if (!m) return null;
      const inv = invertMatrix({ a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });
      if (!inv) return null;
      return { x: inv.a * client.x + inv.c * client.y + inv.e, y: inv.b * client.x + inv.d * client.y + inv.f };
    }

    clientToModel(client) {
      const u = this.clientToUser(client);
      return u ? this.userToModel(u) : null;
    }

    /* 1 CSS 像素对应多少结构坐标（命中半径用，避免设备像素混算） */
    modelPerPixel() {
      const z = this.zoom();
      return 1 / (this.bondLength() * (z || 1));
    }

    /* ---------------- 结构快照 ---------------- */
    atomPos(runtimeId) {
      const a = this.struct().atoms.get(runtimeId);
      return a && a.pp ? { x: a.pp.x, y: a.pp.y } : null;
    }

    atomIds() { return Array.from(this.struct().atoms.keys()); }

    bondIds() { return Array.from(this.struct().bonds.keys()); }

    bondInfo(runtimeId) {
      const st = this.struct();
      const b = st.bonds.get(runtimeId);
      if (!b) return null;
      const a = st.atoms.get(b.begin);
      const c = st.atoms.get(b.end);
      if (!a || !c) return null;
      return {
        id: runtimeId, begin: { x: a.pp.x, y: a.pp.y }, end: { x: c.pp.x, y: c.pp.y },
        type: b.type, stereo: b.stereo || 0, beginId: b.begin, endId: b.end
      };
    }

    /* ---------------- 身份（稳定 ID ↔ 运行时 ID） ---------------- */
    /* 原子自身属性（不含邻居！）：删掉相邻原子不该让本原子"换个身份"，
       否则撤销删除后 C 的 uuid 变了，箭头就断了。id 复用由 Ketcher 单调分配 +
       undo 专用 reconcile 兜底，不靠邻居列表。 */
    atomSignature(a) {
      return [a.label, a.charge || 0, a.radical || 0, a.isotope || 0, a.stereoLabel || '', a.alias || ''].join('|');
    }

    syncIdentity() {
      const st = this.struct();
      const freshAtoms = new Set();
      const freshBonds = new Set();
      this._freshAtoms = freshAtoms;
      this._freshBonds = freshBonds;
      const seenAtoms = new Set();
      for (const [id, a] of st.atoms) {
        seenAtoms.add(id);
        a.id = id;
        const sig = this.atomSignature(a);
        let uuid = this.atomUuid.get(id);

        const wasActive = this.activeAtoms && this.activeAtoms.has(id);
        if (uuid && this.activeAtoms !== null && !wasActive && !this.pendingHistory) {
          // 该 runtime id 曾被删除，现已被新原子复用：旧 uuid 作废，重新分配
          this.uuidAtom.delete(uuid);
          this.atomUuid.delete(id);
          uuid = null;
        }

        if (!uuid) {
          uuid = M.newId('at');
          this.atomUuid.set(id, uuid);
          freshAtoms.add(uuid);
        }
        this.atomSig.set(id, sig);
        this.atomLast.set(id, {
          label: a.label, charge: a.charge || 0, isotope: a.isotope || 0,
          x: a.pp ? a.pp.x : 0, y: a.pp ? a.pp.y : 0
        });
      }
      this.uuidAtom = new Map();
      for (const [id, uuid] of this.atomUuid) {
        if (seenAtoms.has(id)) this.uuidAtom.set(uuid, id);
      }

      const seenBonds = new Set();
      for (const [id, b] of st.bonds) {
        seenBonds.add(id);
        const bu = this.atomUuid.get(b.begin);
        const eu = this.atomUuid.get(b.end);
        const pairKey = bu && eu ? (bu < eu ? bu + '--' + eu : eu + '--' + bu) : null;
        const sig = (bu || '?') + '>' + (eu || '?') + ':' + (b.type || 1);
        let uuid = this.bondUuid.get(id);

        const wasBondActive = this.activeBonds && this.activeBonds.has(id);
        const prevPairKey = this.bondEndpoints.get(id);
        const sameEndpoints = wasBondActive && pairKey && prevPairKey === pairKey;

        if (uuid && this.activeBonds !== null && !sameEndpoints && !this.pendingHistory) {
          if (!wasBondActive || !prevPairKey || prevPairKey !== pairKey) {
            this.uuidBond.delete(uuid);
            this.bondUuid.delete(id);
            uuid = null;
          }
        }

        if (!uuid) {
          uuid = M.newId('bd');
          this.bondUuid.set(id, uuid);
          freshBonds.add(uuid);
        }
        this.bondSig.set(id, sig);
        if (pairKey) this.bondEndpoints.set(id, pairKey);
      }
      this.uuidBond = new Map();
      for (const [id, uuid] of this.bondUuid) {
        if (seenBonds.has(id)) this.uuidBond.set(uuid, id);
      }

      this.activeAtoms = seenAtoms;
      this.activeBonds = seenBonds;

      if (this.pendingHistory) this.reconcileRetired();
    }

    /* 撤销/重做专用：把"被撤销删除"的对象认回原来的稳定 ID。
       只在历史动作后执行（正常编辑绝不做这种匹配，否则新画的同位置原子会抢走旧绑定）。
       要求唯一解：标签/电荷/同位素/坐标全部吻合，且候选只有一个，多解一律放弃。 */
    reconcileRetired() {
      const st = this.struct();
      const live = new Set(this.uuidAtom.keys());
      const fresh = this._freshAtoms || new Set();
      const pool = [];
      for (const [id, a] of st.atoms) {
        const uuid = this.atomUuid.get(id);
        if (uuid && live.has(uuid) && !fresh.has(uuid)) continue;   // 老身份的原子不参与
        pool.push({ id: id, a: a, uuid: uuid });
      }
      if (pool.length) {
        for (const [rid, uuid] of Array.from(this.atomUuid)) {
          if (live.has(uuid)) continue;
          const last = this.atomLast.get(rid);
          if (!last) continue;
          const hit = pool.filter(p => p.a.label === last.label &&
            (p.a.charge || 0) === last.charge && (p.a.isotope || 0) === last.isotope &&
            p.a.pp && Math.abs(p.a.pp.x - last.x) < 1e-3 && Math.abs(p.a.pp.y - last.y) < 1e-3);
          this.lastReconcile = {
            retiredRid: rid, uuid: uuid, last: last,
            pool: pool.map(p => ({ id: p.id, label: p.a.label, x: p.a.pp ? p.a.pp.x : null, y: p.a.pp ? p.a.pp.y : null })),
            hits: hit.length
          };
          if (hit.length !== 1) continue;          // 无解或多解：不猜
          const target = hit[0];
          const existing = this.atomUuid.get(target.id);
          if (existing && existing !== uuid) this.uuidAtom.delete(existing);
          this.atomUuid.set(target.id, uuid);
          this.uuidAtom.set(uuid, target.id);
          this.recomputeSignatures();
          pool.splice(pool.indexOf(target), 1);
        }
      }

      // 键：按「两端 uuid + 键级」唯一匹配
      const liveBonds = new Set(this.uuidBond.keys());
      const freshB = this._freshBonds || new Set();
      const bondPool = [];
      for (const [id, b] of st.bonds) {
        const uuid = this.bondUuid.get(id);
        if (uuid && liveBonds.has(uuid) && !freshB.has(uuid)) continue;
        bondPool.push({ id: id, b: b });
      }
      if (bondPool.length) {
        for (const [rid, uuid] of Array.from(this.bondUuid)) {
          if (liveBonds.has(uuid)) continue;
          const sig = this.bondSig.get(rid);
          if (!sig) continue;
          const hit = bondPool.filter(p => {
            const bu = this.atomUuid.get(p.b.begin);
            const eu = this.atomUuid.get(p.b.end);
            return ((bu || '?') + '>' + (eu || '?') + ':' + (p.b.type || 1)) === sig;
          });
          if (hit.length !== 1) continue;
          const target = hit[0];
          const existing = this.bondUuid.get(target.id);
          if (existing && existing !== uuid) this.uuidBond.delete(existing);
          this.bondUuid.set(target.id, uuid);
          this.uuidBond.set(uuid, target.id);
          this.recomputeSignatures();
          bondPool.splice(bondPool.indexOf(target), 1);
        }
      }
    }

    /* 整份替换画布后，运行时 id 与旧 uuid 的对应关系全部作废 */
    resetIdentity() {
      this.atomUuid.clear();
      this.uuidAtom.clear();
      this.atomSig.clear();
      this.bondUuid.clear();
      this.uuidBond.clear();
      this.bondSig.clear();
      this.activeAtoms = null;
      this.activeBonds = null;
      this.bondEndpoints.clear();
    }

    uuidOfAtom(runtimeId) { return this.atomUuid.get(runtimeId) || null; }
    uuidOfBond(runtimeId) { return this.bondUuid.get(runtimeId) || null; }
    atomIdOf(uuid) { return this.uuidAtom.has(uuid) ? this.uuidAtom.get(uuid) : null; }
    bondIdOf(uuid) { return this.uuidBond.has(uuid) ? this.uuidBond.get(uuid) : null; }

    // 完整标签、元素字形、隐式 H 是不同的命中区域。CH₃ 的盒子并不以 C 为中心。
    atomLabelBox(uuid, options = {}) {
      const id = this.atomIdOf(uuid);
      if (id === null) return null;
      const a = this.struct().atoms.get(id);
      const ctab = this.ed.render && this.ed.render.ctab;
      const vis = ctab && ctab.atoms && ctab.atoms.get(id);
      if (!a || !a.pp || (vis && vis.showLabel === false)) {
        return { hasLabel: false, hwCss: 0, hhCss: 0 };
      }
      const fromBox = (bb) => {
        if (!bb) return null;
        const p0 = bb.p0 || { x: bb.x, y: bb.y };
        const p1 = bb.p1 || { x: bb.x + bb.width, y: bb.y + bb.height };
        if (![p0.x, p0.y, p1.x, p1.y].every(Number.isFinite)) return null;
        const lo = this.userToModel(p0), hi = this.userToModel(p1);
        return { x1: Math.min(lo.x, hi.x), y1: Math.min(lo.y, hi.y),
          x2: Math.max(lo.x, hi.x), y2: Math.max(lo.y, hi.y) };
      };
      // Raphael/visel boxes are cached at the last atom redraw. A viewport
      // zoom can change SVG glyph measurements without invalidating them.
      // Measure attached native SVG nodes in their own coordinates, then
      // transform all four corners through the real node/root CTMs.
      const svg = this.canvasSvg();
      const transformedBox = (bb, node) => {
        const n = node.getScreenCTM(), s = svg.getScreenCTM();
        if (!bb || !n || !s || ![bb.x, bb.y, bb.width, bb.height, n.a, n.b, n.c, n.d, n.e, n.f,
          s.a, s.b, s.c, s.d, s.e, s.f].every(Number.isFinite) || bb.width <= 0 || bb.height <= 0) return null;
        const inv = invertMatrix(s);
        if (!inv) return null;
        const points = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height],
          [bb.x + bb.width, bb.y + bb.height]].map(([x, y]) => {
          const cx = n.a * x + n.c * y + n.e, cy = n.b * x + n.d * y + n.f;
          return this.userToModel({ x: inv.a * cx + inv.c * cy + inv.e, y: inv.b * cx + inv.d * cy + inv.f });
        });
        return { x1: Math.min(...points.map(p => p.x)), y1: Math.min(...points.map(p => p.y)),
          x2: Math.max(...points.map(p => p.x)), y2: Math.max(...points.map(p => p.y)) };
      };
      const domBox = (path) => {
        const node = path && path.node;
        if (!svg || !node || node.isConnected !== true || !svg.contains(node) ||
            typeof node.getBBox !== 'function' || typeof node.getScreenCTM !== 'function' ||
            typeof svg.getScreenCTM !== 'function') return null;
        try {
          return transformedBox(node.getBBox(), node);
        } catch (e) { return null; }
      };
      const fallbackRect = fromBox(vis && vis.visel && vis.visel.boundingBox);
      const paths = Array.from((vis && vis.visel && vis.visel.paths) || []);
      const measured = paths.map(domBox), liveRects = measured.filter(Boolean);
      // If a glyph is temporarily detached while Ketcher is redrawing, keep
      // the cached union as a conservative fallback for that incomplete set.
      if (liveRects.length && liveRects.length < paths.length && fallbackRect) liveRects.push(fallbackRect);
      const rect = liveRects.length ? {
        x1: Math.min(...liveRects.map(r => r.x1)), y1: Math.min(...liveRects.map(r => r.y1)),
        x2: Math.max(...liveRects.map(r => r.x2)), y2: Math.max(...liveRects.map(r => r.y2))
      } : fallbackRect;
      if (rect && rect.x2 > rect.x1 && rect.y2 > rect.y1) {
        let atomRect = null;
        const hydrogenRects = [];
        try {
          atomRect = domBox(vis.label && vis.label.path) || fromBox(vis.label && vis.label.path && vis.label.path.getBBox());
          if (a.implicitH > 0 && a.label !== 'H') {
            for (const path of vis.visel.paths) {
              const text = path.node && path.node.textContent;
              // 同一 visel 内，H 和氢下标可点击；电荷/同位素仍归属元素。
              if (path.type === 'text' && (text === 'H' || text === String(a.implicitH))) {
                const hr = domBox(path) || fromBox(path.getBBox());
                if (hr) hydrogenRects.push(hr);
              }
            }
          }
        } catch (e) { /* 重绘期间子字形可能已被替换，完整标签盒仍可用 */ }
        const scale = this.bondLength() * this.zoom();
        const result = { hasLabel: true, rect: rect, atomRect: atomRect || rect,
          hydrogenRects: hydrogenRects,
          hwCss: (rect.x2 - rect.x1) * scale / 2,
          hhCss: (rect.y2 - rect.y1) * scale / 2 };
        if (options.planning === true || Number.isFinite(options.planningZoom)) {
          // Browser text hinting changes actual glyph extents slightly with
          // viewport zoom. Measure a same-style offscreen clone at representative
          // scales without changing the user's camera. Cache only normalized
          // local glyph bounds, never the atom position or either CTM.
          const planning = [rect], zoomRects = [], zoomHydrogens = [];
          let zoomAtom = null;
          for (const path of paths) {
            const node = path && path.node;
            if (!node || node.isConnected !== true || !svg || !svg.contains(node) ||
                String(node.tagName).toLowerCase() !== 'text' || typeof node.cloneNode !== 'function' ||
                typeof node.getScreenCTM !== 'function' || !this.doc?.body || !this.doc?.defaultView?.getComputedStyle ||
                node.querySelector?.('[x], [y]')) continue;
            if (!node.hasAttribute('x') || !node.hasAttribute('y')) continue;
            const x = Number(node.getAttribute('x')), y = Number(node.getAttribute('y'));
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            try {
              const style = this.doc.defaultView.getComputedStyle(node), clone = node.cloneNode(true);
              // Atom glyphs have a single tspan whose dy can differ by tiny
              // layout-rounding noise at every position. Normalize that local
              // translation as well, then add it back after the cache lookup.
              const spans = clone.querySelectorAll('tspan');
              if (spans.length > 1 || spans[0]?.hasAttribute('dx')) continue;
              const dy = spans.length && spans[0].hasAttribute('dy') ? Number(spans[0].getAttribute('dy')) : 0;
              if (!Number.isFinite(dy)) continue;
              if (spans.length) spans[0].setAttribute('dy', '0');
              for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
                'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'wordSpacing',
                'textAnchor', 'direction', 'dominantBaseline', 'alignmentBaseline']) clone.style[key] = style[key];
              clone.setAttribute('x', '0'); clone.setAttribute('y', '0'); clone.removeAttribute('transform');
              for (const element of [clone, ...clone.querySelectorAll('*')]) for (const attr of [...element.attributes]) {
                if (attr.name === 'id' || attr.name.startsWith('data-')) element.removeAttribute(attr.name);
              }
              if (!this._glyphEnvelopeCache) this._glyphEnvelopeCache = new Map();
              if (!this._glyphMeasureSvg || !this._glyphMeasureSvg.isConnected) {
                const holder = this.doc.createElementNS(SVG_NS, 'svg');
                holder.setAttribute('width', '800'); holder.setAttribute('height', '600');
                Object.assign(holder.style, { position: 'fixed', left: '-10000px', top: '-10000px', opacity: '0',
                  pointerEvents: 'none', overflow: 'visible' });
                this.doc.body.appendChild(holder); this._glyphMeasureSvg = holder;
                const fonts = this.doc.fonts;
                if (!this._glyphFontCleanup && fonts?.addEventListener) {
                  const clear = () => this._glyphEnvelopeCache?.clear();
                  fonts.addEventListener('loadingdone', clear); fonts.addEventListener('loadingerror', clear);
                  this._glyphFontCleanup = () => { fonts.removeEventListener('loadingdone', clear); fonts.removeEventListener('loadingerror', clear); };
                }
              }
              const key = clone.outerHTML;
              let bounds = this._glyphEnvelopeCache.get(key);
              if (!bounds) {
                const holder = this._glyphMeasureSvg, boxes = [], byZoom = {};
                holder.appendChild(clone);
                try {
                  for (const z of [0.41, 0.54, 1, 1.5]) {
                    holder.setAttribute('viewBox', `0 0 ${800 / z} ${600 / z}`);
                    const b = clone.getBBox();
                    if ([b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0) {
                      byZoom[z] = { x: b.x, y: b.y, width: b.width, height: b.height };
                      if (z !== 1.5) boxes.push(b);
                    }
                  }
                } finally { clone.remove(); }
                if (!boxes.length) continue;
                const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
                bounds = { x: minX, y: minY, width: Math.max(...boxes.map(b => b.x + b.width)) - minX,
                  height: Math.max(...boxes.map(b => b.y + b.height)) - minY, byZoom };
                if (this._glyphEnvelopeCache.size >= 512) this._glyphEnvelopeCache.clear();
                this._glyphEnvelopeCache.set(key, bounds);
              }
              const measured = transformedBox({ ...bounds, x: bounds.x + x, y: bounds.y + y + dy }, node);
              if (measured) planning.push(measured);
              const atZoom = bounds.byZoom?.[options.planningZoom];
              if (atZoom) {
                const scaled = transformedBox({ ...atZoom, x: atZoom.x + x, y: atZoom.y + y + dy }, node);
                if (scaled) {
                  zoomRects.push(scaled);
                  if (path === vis.label?.path) zoomAtom = scaled;
                  const text = path.node?.textContent;
                  if (a.implicitH > 0 && a.label !== 'H' && path.type === 'text' &&
                      (text === 'H' || text === String(a.implicitH))) zoomHydrogens.push(scaled);
                }
              }
            } catch (e) { /* The current live box remains a safe local fallback. */ }
          }
          result.planningRect = { x1: Math.min(...planning.map(r => r.x1)), y1: Math.min(...planning.map(r => r.y1)),
            x2: Math.max(...planning.map(r => r.x2)), y2: Math.max(...planning.map(r => r.y2)) };
          if (Number.isFinite(options.planningZoom) && zoomRects.length === paths.length) {
            result.rect = { x1: Math.min(...zoomRects.map(r => r.x1)), y1: Math.min(...zoomRects.map(r => r.y1)),
              x2: Math.max(...zoomRects.map(r => r.x2)), y2: Math.max(...zoomRects.map(r => r.y2)) };
            result.atomRect = zoomAtom || result.rect;
            result.hydrogenRects = zoomHydrogens;
            const zoomScale = this.bondLength() * options.planningZoom;
            result.hwCss = (result.rect.x2 - result.rect.x1) * zoomScale / 2;
            result.hhCss = (result.rect.y2 - result.rect.y1) * zoomScale / 2;
          }
        }
        return result;
      }
      if (a.label && a.label !== 'C') {
        const z = this.zoom(), len = a.label.length + (a.implicitH ? 1.2 : 0) + (a.charge ? 0.8 : 0);
        return { hasLabel: true, hwCss: Math.max(5, len * 4.6 * z), hhCss: Math.max(6, 7.2 * z) };
      }
      return { hasLabel: false, hwCss: 0, hhCss: 0 };
    }

    /* 供模型使用的解析上下文 */
    context(model) {
      const self = this;
      return {
        atomPos: (uuid) => {
          const id = self.atomIdOf(uuid);
          return id === null ? null : self.atomPos(id);
        },
        bondInfo: (uuid) => {
          const id = self.bondIdOf(uuid);
          const bond = id === null ? null : self.bondInfo(id);
          return bond && { ...bond, beginAtom: self.atomUuid.get(bond.beginId) || null,
            endAtom: self.atomUuid.get(bond.endId) || null };
        },
        /* 自动排布的障碍来源（mechanism-route.buildScene）：原子标签盒与键线。
           之前没提供 atoms()/bonds()，真实画布上场景一直是空的 —— 障碍从未生效。 */
        atoms: () => {
          const out = [];
          try {
            const st = self.struct();
            for (const [id, a] of st.atoms) {
              const uuid = self.atomUuid.get(id);
              if (!uuid || !a.pp) continue;
              out.push({ uuid: uuid, label: a.label, charge: Number.isFinite(a.charge) ? a.charge : 0, pos: { x: a.pp.x, y: a.pp.y } });
            }
          } catch (e) { /* 载入期 struct 短暂不可用 */ }
          return out;
        },
        bonds: () => {
          const out = [];
          try {
            const st = self.struct();
            for (const [id, b] of st.bonds) {
              const uuid = self.bondUuid.get(id);
              const pa = b.pp || (st.atoms.get(b.begin) || {}).pp;
              const pb = b.pp || (st.atoms.get(b.end) || {}).pp;
              if (!uuid || !pa || !pb) continue;
              out.push({
                uuid: uuid, type: b.type || 1,
                begin: { x: pa.x, y: pa.y }, end: { x: pb.x, y: pb.y },
                beginAtom: self.atomUuid.get(b.begin) || null,
                endAtom: self.atomUuid.get(b.end) || null
              });
            }
          } catch (e) { /* 同上 */ }
          return out;
        },
        reactionArrows: () => Array.from(self.struct().rxnArrows?.values() || [], arrow => arrow.pos),
        lonePair: (slotId) => (model ? model.lonePair(slotId) : null),
        atomLabel: (uuid) => {
          const id = self.atomIdOf(uuid);
          const a = id === null ? null : self.struct().atoms.get(id);
          return a ? a.label : null;
        },
        atomLabelBox: (uuid, options) => self.atomLabelBox(uuid, options),
        planningContextAtZoom: (z) => {
          const context = self.context(model), bl = self.bondLength() || 40;
          if (!Number.isFinite(z) || z <= 0) return context;
          return { ...context, atomLabelBox: uuid => self.atomLabelBox(uuid, { planningZoom: z }), unit: () => 1 / (z * bl) };
        },
        unit: () => {
          const z = self.zoom() || 1;
          const bl = self.bondLength() || 40;
          return 1 / (z * bl);
        }
      };
    }

    /* 化学快照：只给孤对建议用的纯数据 */
    chemSnapshot() {
      const st = this.struct();
      this.syncIdentity();
      const atoms = [];
      for (const [id, a] of st.atoms) {
        const uuid = this.atomUuid.get(id);
        const neighbors = [];
        let aromatic = false;
        for (const [, b] of st.bonds) {
          if (b.begin !== id && b.end !== id) continue;
          const other = b.begin === id ? b.end : b.begin;
          const otherAtom = st.atoms.get(other);
          const type = b.type || 1;
          const isArom = type === 4;
          if (isArom) aromatic = true;
          neighbors.push({
            uuid: this.atomUuid.get(other) || null,
            order: isArom ? 1.5 : (type >= 1 && type <= 3 ? type : 1),
            aromatic: isArom,
            angle: otherAtom && otherAtom.pp && a.pp
              ? (Math.atan2(otherAtom.pp.y - a.pp.y, otherAtom.pp.x - a.pp.x) * 180 / Math.PI)
              : 0
          });
        }
        const qp = a.queryProperties || {};
        const hasQuery = !!(a.atomList || a.alias || a.rglabel || a.pseudo ||
          Object.keys(qp).some(k => qp[k] !== null && qp[k] !== undefined));
        atoms.push({
          uuid: uuid,
          label: a.label,
          charge: M.finite(a.charge) ? a.charge : 0,
          radical: a.radical || 0,
          aromatic: aromatic,
          hasQuery: hasQuery,
          isotope: a.isotope || 0,
          implicitH: M.finite(a.implicitH) ? a.implicitH : 0,
          neighbors: neighbors
        });
      }
      return { atoms: atoms };
    }

    /* ---------------- KET ↔ 运行时身份对照 ---------------- */
    /* 当前画布导出 KET，同时给出 uuid → 快照定位器（只对这份 KET 有效） */
    async exportKetWithBindings() {
      const ketText = await this.k.getKet();
      let doc;
      try { doc = JSON.parse(ketText); } catch (e) { throw new Error('KET 导出无法解析'); }
      this.syncIdentity();
      const map = this.mapRuntimeToKet(doc);
      if (map.error) return { ok: false, error: map.error, ketText: ketText };
      return {
        ok: true,
        ketText: ketText,
        ket: doc,
        bindings: { atoms: map.atoms, bonds: map.bonds }
      };
    }

    /* 运行时原子 → KET 里的 (mol, index)：按坐标精确匹配 + 双射校验，不做最近邻猜测 */
    mapRuntimeToKet(doc) {
      const st = this.struct();
      const molKeys = orderedMoleculeKeys(doc);
      const byCoord = new Map();
      for (const [id, a] of st.atoms) {
        if (!a.pp) return { error: '画布原子缺少坐标' };
        const key = coordKey(a.pp.x, a.pp.y);
        if (byCoord.has(key)) return { error: '画布上有重合的原子，无法建立稳定对照' };
        byCoord.set(key, id);
      }
      const atomBindings = [];
      const bondBindings = [];
      const uuidByMolIndex = new Map();
      const used = new Set();
      for (const mol of molKeys) {
        const sec = doc[mol] || {};
        const atomIds = [];
        (sec.atoms || []).forEach((at, idx) => {
          const loc = at.location || [0, 0, 0];
          const rid = byCoord.get(coordKey(loc[0], -loc[1]));
          if (rid === undefined) { atomIds.push(null); return; }
          if (used.has(rid)) { atomIds.push(null); return; }
          used.add(rid);
          atomIds.push(rid);
          const uuid = this.atomUuid.get(rid);
          if (!uuid) return;
          atomBindings.push({ id: uuid, mol: mol, index: idx });
          uuidByMolIndex.set(mol + '#' + idx, uuid);
        });
        (sec.bonds || []).forEach((bd, idx) => {
          const pair = bd.atoms || [];
          const r1 = atomIds[pair[0]];
          const r2 = atomIds[pair[1]];
          if (r1 === undefined || r2 === undefined || r1 === null || r2 === null) return;
          const found = this.findBondBetween(r1, r2);
          if (found === null || found === undefined) return;   // 运行时 id 可以是 0，不能用真值判断
          const uuid = this.bondUuid.get(found);
          if (!uuid) return;
          bondBindings.push({
            id: uuid, mol: mol, index: idx,
            begin: this.atomUuid.get(r1) || null,
            end: this.atomUuid.get(r2) || null
          });
        });
      }
      if (used.size !== st.atoms.size) {
        return { error: '有原子没有出现在导出数据里，无法建立完整对照' };
      }
      return { atoms: atomBindings, bonds: bondBindings };
    }

    findBondBetween(a, b) {
      for (const [id, bd] of this.struct().bonds) {
        if ((bd.begin === a && bd.end === b) || (bd.begin === b && bd.end === a)) return id;
      }
      return null;
    }

    /* 只重算结构签名，不改 uuid 分配（恢复绑定后调用） */
    recomputeSignatures() {
      const st = this.struct();
      for (const [id, a] of st.atoms) {
        a.id = id;
        this.atomSig.set(id, this.atomSignature(a));
      }
      for (const [id, b] of st.bonds) {
        const bu = this.atomUuid.get(b.begin);
        const eu = this.atomUuid.get(b.end);
        this.bondSig.set(id, (bu || '?') + '>' + (eu || '?') + ':' + (b.type || 1));
        if (bu && eu) {
          this.bondEndpoints.set(id, bu < eu ? bu + '--' + eu : eu + '--' + bu);
        }
      }
    }

    /* 载入 KET 后，用 bindings 恢复 uuid。
       定位器 (mol,index) → 运行时 id 的解析有两条路，都要求可校验、多解即失败：
         1) 顺序：Ketcher 按 KET 里的顺序建原子，逐位比对标签；全部一致才采用（载入会重新居中坐标，
            所以坐标法在载入后不可靠）；
         2) 坐标：仅在顺序校验失败时使用（同一份画布内导出/对照时有效）。 */
    locatorMap(ket) {
      const st = this.struct();
      const entries = [];
      for (const mol of orderedMoleculeKeys(ket)) {
        const sec = ket[mol] || {};
        (sec.atoms || []).forEach((at, idx) => entries.push({ mol: mol, index: idx, label: at.label, loc: at.location }));
      }
      const ids = Array.from(st.atoms.keys()).sort((a, b) => a - b);
      const map = new Map();     // "mol#index" → runtime id

      // 空结构也有唯一对应：纯机理箭头或原生形状不需要任何原子绑定。
      if (ids.length === 0 && entries.length === 0) return { ok: true, map: map, how: 'empty' };

      if (ids.length === entries.length && entries.length) {
        let ok = true;
        for (let i = 0; i < entries.length; i++) {
          const a = st.atoms.get(ids[i]);
          if (!a) { ok = false; break; }
          const want = entries[i].label;
          if (want && a.label !== want) { ok = false; break; }
        }
        if (ok) {
          for (let i = 0; i < entries.length; i++) map.set(entries[i].mol + '#' + entries[i].index, ids[i]);
          return { ok: true, map: map, how: 'order' };
        }
      }

      // 回退：坐标精确匹配（含整体平移修正），要求双射
      const byCoord = new Map();
      for (const [id, a] of st.atoms) {
        if (!a.pp) return { ok: false, error: '画布原子缺少坐标' };
        const key = coordKey(a.pp.x, a.pp.y);
        if (byCoord.has(key)) return { ok: false, error: '画布上有重合的原子，无法恢复绑定' };
        byCoord.set(key, id);
      }
      // 用第一个能匹配上的原子估计整体平移
      let dx = 0, dy = 0, found = false;
      for (const e of entries) {
        if (!e.loc) continue;
        const want = { x: e.loc[0], y: -e.loc[1] };
        let best = null;
        for (const [id, a] of st.atoms) {
          if (!a.pp) continue;
          const d = Math.hypot(a.pp.x - want.x, a.pp.y - want.y);
          if (!best || d < best.d) best = { d: d, dx: a.pp.x - want.x, dy: a.pp.y - want.y, label: a.label };
        }
        if (best && best.label === e.label) { dx = best.dx; dy = best.dy; found = true; break; }
      }
      if (!found) return { ok: false, error: '无法建立载入内容与原画布的对应关系' };
      const used = new Set();
      for (const e of entries) {
        if (!e.loc) continue;
        const id = byCoord.get(coordKey(e.loc[0] + dx, -e.loc[1] + dy));
        if (id === undefined || used.has(id)) return { ok: false, error: '载入内容的原子对应不唯一' };
        used.add(id);
        map.set(e.mol + '#' + e.index, id);
      }
      return { ok: true, map: map, how: 'coords' };
    }

    applyBindings(bindings) {
      const ket = this._loadedKet;
      if (!ket) return { ok: false, error: '缺少 KET 内容，无法恢复绑定' };
      const located = this.locatorMap(ket);
      if (!located.ok) return { ok: false, error: located.error };
      const loc = located.map;

      let restored = 0;
      for (const b of (bindings && bindings.atoms) || []) {
        const rid = loc.get(b.mol + '#' + b.index);
        if (rid === undefined) continue;
        const temp = this.atomUuid.get(rid);
        if (temp && temp !== b.id) this.uuidAtom.delete(temp);
        this.atomUuid.set(rid, b.id);
        this.uuidAtom.set(b.id, rid);
        restored += 1;
      }

      let restoredBonds = 0;
      for (const b of (bindings && bindings.bonds) || []) {
        const sec = ket[b.mol];
        const bd = sec && Array.isArray(sec.bonds) ? sec.bonds[b.index] : null;
        if (!bd || !Array.isArray(bd.atoms)) continue;
        const r1 = loc.get(b.mol + '#' + bd.atoms[0]);
        const r2 = loc.get(b.mol + '#' + bd.atoms[1]);
        if (r1 === undefined || r2 === undefined) continue;
        const rid = this.findBondBetween(r1, r2);
        if (rid === null) continue;
        const temp = this.bondUuid.get(rid);
        if (temp && temp !== b.id) this.uuidBond.delete(temp);
        this.bondUuid.set(rid, b.id);
        this.uuidBond.set(b.id, rid);
        restoredBonds += 1;
      }
      this._loadedKet = null;
      if (this.activeAtoms === null) this.activeAtoms = new Set();
      if (this.activeBonds === null) this.activeBonds = new Set();
      for (const rid of this.uuidAtom.values()) this.activeAtoms.add(rid);
      for (const rid of this.uuidBond.values()) this.activeBonds.add(rid);
      // 关键：签名要用"恢复后的 uuid"重算。否则下一次 syncIdentity 会把刚恢复的身份
      // 当成"运行时 id 被新对象复用"，把箭头绑定的 uuid 换掉（实测会导致载入后引用失效）
      this.recomputeSignatures();
      return { ok: true, atoms: restored, bonds: restoredBonds, how: located.how };
    }

    /* ---------------- 变更订阅 ---------------- */
    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    notify(kind) {
      for (const fn of Array.from(this.listeners)) {
        try { fn(kind); } catch (e) { if (root.console) console.error('[adapter] listener', e); }
      }
    }

    schedule(kind) {
      if (kind === 'transform') this.pending.transform = true;
      else if (kind === 'history') this.pending.history = true;
      else this.pending.struct = true;
      if (this.rafId) return;
      const win = this.doc.defaultView;
      let done = false;
      const flush = () => {
        if (done) return;
        done = true;
        this.rafId = 0;
        if (this._fallback) { clearTimeout(this._fallback); this._fallback = 0; }
        const p = this.pending;
        this.pending = { struct: false, transform: false, history: false };
        const which = p.struct ? 'struct' : (p.transform ? 'transform' : 'history');
        // 用历史栈深度判断这次变化是不是撤销/重做：比"包 undo/redo"更可靠
        //（菜单、快捷键、脚本调用最后都改这两个计数）
        try {
          const h = this.ed.historySize ? this.ed.historySize() : null;
          if (h && this._lastHistory) {
            if (h.undo < this._lastHistory.undo) this.pendingHistory = 'undo';
            else if (h.undo > this._lastHistory.undo && h.redo < this._lastHistory.redo) this.pendingHistory = 'redo';
          }
          if (h) this._lastHistory = { undo: h.undo, redo: h.redo };
        } catch (e) { /* 没有历史接口就退回包装信号 */ }
        this.syncIdentity();
        this.pendingHistory = null;
        this.ensureLayer();
        this.notify(which);
      };
      const raf = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null;
      this.rafId = raf ? raf(flush) : setTimeout(flush, 16);
      // 窗口被遮挡/后台时浏览器会把 rAF 节流到不触发（实测窗口不可见时 rAF 永不回调），
      // 没有兜底就会一直停在旧画面：用定时器保证最多 120ms 内一定刷新一次
      this._fallback = setTimeout(flush, 120);
    }

    /* 挂载：事件订阅 + 观察器。返回卸载函数（重载/切模式后不重复注册） */
    mount() {
      if (this.mounted) return () => {};
      this.mounted = true;
      const win = this.doc.defaultView;
      const self = this;

      // 1) Ketcher 的 change 事件（单参数 add(handler) 已在 p22 实测）
      try {
        if (this.ed.event && this.ed.event.change && typeof this.ed.event.change.add === 'function') {
          const handler = () => self.schedule('struct');
          this.ed.event.change.add(handler);
          this.disposers.push(() => {
            try { this.ed.event.change.remove(handler); } catch (e) { /* 已卸载 */ }
          });
        }
      } catch (e) { if (root.console) console.warn('[adapter] change 事件不可用', e); }

      // 2) setMolecule = 整份替换画布：这是"新文档"，机理层必须清空（第 9.4 节）。
      //    loadWorkbench 自己会注入机理层，用 suppressReset 跳过这次重置。
      try {
        const k = this.k;
        const origSet = k.setMolecule;
        if (typeof origSet === 'function') {
          const self2 = this;
          let replacement = 0;
          k.setMolecule = function () {
            const version = ++replacement, suppressed = self2.suppressReset;
            const p = origSet.apply(this, arguments);
            const after = value => {
              if (version !== replacement || !self2.mounted || suppressed) return value;
              self2.resetIdentity();
              self2.syncIdentity();
              if (typeof self2.onStructureReplaced === 'function') self2.onStructureReplaced();
              return value;
            };
            return p && typeof p.then === 'function' ? p.then(after) : after(p);
          };
          this.disposers.push(() => { try { k.setMolecule = origSet; } catch (e) { /* 只读 */ } });
        }
      } catch (e) { if (root.console) console.warn('[adapter] 无法包装 setMolecule', e); }

      // 2.5) ed.update：有的编辑（如删除、直接改结构后 update(true)）不派发 change，
      //      统一在这里补一次刷新
      try {
        const origUpdate = this.ed.update;
        if (typeof origUpdate === 'function') {
          const self2 = this;
          this.ed.update = function () {
            const r = origUpdate.apply(this, arguments);
            self2.schedule('struct');
            return r;
          };
          this.disposers.push(() => { try { this.ed.update = origUpdate; } catch (e) { /* 只读 */ } });
        }
      } catch (e) { if (root.console) console.warn('[adapter] 无法包装 update', e); }

      // 2.6) render.update：Ketcher 的删除/重画最终都会走到这里；有的路径既不发 change
      //      也不走 editor.update（实测删除原子后两者都没触发），只能盯住重绘入口
      try {
        const R = this.ed.render;
        if (R && typeof R.update === 'function') {
          const origRenderUpdate = R.update;
          const self2 = this;
          R.update = function () {
            const r = origRenderUpdate.apply(this, arguments);
            self2.schedule('struct');
            return r;
          };
          this.disposers.push(() => { try { R.update = origRenderUpdate; } catch (e) { /* 只读 */ } });
        }
      } catch (e) { if (root.console) console.warn('[adapter] 无法包装 render.update', e); }

      // 3) undo / redo：Ketcher 的 redo 不一定派发 change，包一层保证刷新
      for (const name of ['undo', 'redo']) {
        try {
          const orig = this.ed[name];
          if (typeof orig === 'function') {
            this.ed[name] = function () {
              self.pendingHistory = name;      // undo/redo：允许把被撤销删除的对象认回原身份
              const r = orig.apply(this, arguments);
              self.schedule('history');
              return r;
            };
            this.disposers.push(() => { this.ed[name] = orig; });
          }
        } catch (e) { /* 只读属性：忽略 */ }
      }

      // 3) 画布 svg：viewBox/尺寸变化 = 缩放或 resize；childList 变化 = 重绘/重建
      const attachSvg = () => {
        const svg = this.canvasSvg();
        if (!svg || svg === this._svg) return;
        if (this._svgObserver) { this._svgObserver.disconnect(); this._svgObserver = null; }
        this._svg = svg;
        this.layerEl = null;
        const Obs = win.MutationObserver;
        if (Obs) {
          this._svgObserver = new Obs((records) => {
            let structural = false;
            for (const r of records) {
              if (r.type === 'attributes') { self.schedule('transform'); continue; }
              if (r.type !== 'childList') continue;
              if (!self.layerEl || !self.layerEl.isConnected) { structural = true; continue; }
              const t = r.target;
              // 跳过我们自己的绘制（否则会自激循环）
              if (t === self.layerEl || (self.layerEl.contains && self.layerEl.contains(t))) continue;
              structural = true;
            }
            if (structural) self.schedule('struct');
          });
          this._svgObserver.observe(svg, { attributes: true, attributeFilter: ['viewBox', 'width', 'height', 'style'], childList: true });
        }
        this.schedule('struct');
      };
      attachSvg();
      // setMolecule 会换掉/重建 svg：用 document 级观察器兜底重新挂载
      const Obs = win.MutationObserver;
      if (Obs) {
        const docObs = new Obs(() => {
          const svg = this.canvasSvg();
          if (svg && svg !== this._svg) attachSvg();
          else if (this.layerEl && !this.layerEl.isConnected) this.schedule('struct');
        });
        docObs.observe(this.doc.body || this.doc.documentElement, { childList: true, subtree: true });
        this.disposers.push(() => docObs.disconnect());
      }

      // 4) 平移/滚动 + 窗口尺寸
      const ca = this.ed.render && this.ed.render.clientArea;
      if (ca) {
        const onScroll = () => self.schedule('transform');
        ca.addEventListener('scroll', onScroll, true);
        this.disposers.push(() => ca.removeEventListener('scroll', onScroll, true));
        if (win.ResizeObserver) {
          const ro = new win.ResizeObserver(() => self.schedule('transform'));
          ro.observe(ca);
          this.disposers.push(() => ro.disconnect());
        }
      }
      const onResize = () => self.schedule('transform');
      win.addEventListener('resize', onResize);
      this.disposers.push(() => win.removeEventListener('resize', onResize));

      return () => this.unmount();
    }

    unmount() {
      if (this._fallback) { clearTimeout(this._fallback); this._fallback = 0; }
      for (const d of this.disposers) { try { d(); } catch (e) { /* 忽略重复卸载 */ } }
      this.disposers = [];
      if (this._glyphFontCleanup) this._glyphFontCleanup();
      this._glyphFontCleanup = null;
      if (this._glyphMeasureSvg) this._glyphMeasureSvg.remove();
      this._glyphMeasureSvg = null;
      this._glyphEnvelopeCache?.clear();
      if (this._svgObserver) { this._svgObserver.disconnect(); this._svgObserver = null; }
      this.mounted = false;
    }

    /* ---------------- 自建 SVG 层 ---------------- */
    ensureLayer() {
      const svg = this.canvasSvg();
      if (!svg) return null;
      if (!this.layerEl || !this.layerEl.isConnected || this.layerEl.ownerSVGElement !== svg) {
        let g = svg.querySelector('#molstudio-mech-layer');
        if (!g) {
          g = this.doc.createElementNS(SVG_NS, 'g');
          g.setAttribute('id', 'molstudio-mech-layer');
          g.setAttribute('data-mech-ui', '0');
        }
        this.layerEl = g;
      }
      // 保持在最上层（Ketcher 重绘会追加新元素）
      if (svg.lastElementChild !== this.layerEl) svg.appendChild(this.layerEl);
      return this.layerEl;
    }

    /* ---------------- 历史接入 ---------------- */
    /* 压入「撤销时执行」的动作；perform 返回重做动作（Ketcher 语义，见 p8/p20 实测） */
    pushAction(undoFn, redoFn) {
      const self = this;
      const mk = (fn, opposite) => ({
        operations: [],
        isDummy: function () { return false; },
        perform: function () {
          try { fn(); } catch (e) {
            if (root.console) console.error('[adapter] 历史动作执行失败', e);
          }
          self.schedule('history');
          return mk(opposite, fn);
        }
      });
      this.ed.update(mk(undoFn, redoFn));
      this.schedule('history');
    }

    /* ---------------- 选区 ---------------- */
    selection() {
      try {
        const sel = this.ed.selection ? this.ed.selection() : null;
        if (!sel || typeof sel !== 'object') return { atoms: [], bonds: [], others: 0 };
        let others = 0;
        for (const key of Object.keys(sel)) {
          if (key === 'atoms' || key === 'bonds' || key === 'enhancedFlags') continue;
          const v = sel[key];
          if (Array.isArray(v) && v.length) others += v.length;
        }
        return {
          atoms: Array.isArray(sel.atoms) ? sel.atoms.slice() : [],
          bonds: Array.isArray(sel.bonds) ? sel.bonds.slice() : [],
          others: others
        };
      } catch (e) { return { atoms: [], bonds: [], others: 0 }; }
    }

    clearSelection() { try { this.ed.selection(null); } catch (e) { /* 无选区 */ } }

    clearHover() { try { this.ed.hover(null); } catch (e) { /* 重建期间无活动工具 */ } }

    /* ---------------- 原子标签半径（结构坐标，用于命中与避让） ---------------- */
    atomLabelRadius() { return M.LABEL_CLEARANCE; }
  }

  function coordKey(x, y) {
    const component = n => { const s = (+n).toFixed(6); return s === '-0.000000' ? '0.000000' : s; };
    return component(x) + ',' + component(y);
  }

  function orderedMoleculeKeys(doc) {
    const out = [];
    const nodes = (doc.root && doc.root.nodes) || [];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const ref = n.$ref;
      if (ref && doc[ref] && doc[ref].type === 'molecule') out.push(ref);
    }
    if (!out.length) {
      for (const key of Object.keys(doc)) {
        if (doc[key] && doc[key].type === 'molecule') out.push(key);
      }
    }
    return out;
  }

  MW.adapter = {
    KetcherAdapter: KetcherAdapter,
    orderedMoleculeKeys: orderedMoleculeKeys,
    coordKey: coordKey,
    invertMatrix: invertMatrix,
    SVG_NS: SVG_NS
  };
})(typeof window !== 'undefined' ? window : globalThis);
