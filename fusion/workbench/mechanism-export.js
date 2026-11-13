/* MolStudio 工作台 · 机理图导出（SVG / PNG）
 * 用「同一份内容快照」合成底图与机理层：机理层本来就画在 Ketcher 画布 svg 里，
 * 所以克隆同一个 svg 天然对齐，不需要把坐标再算一遍。
 * 包围盒来自可见内容，并统一换算到根 SVG 坐标；视口坐标不参与文档裁切。
 * 导出剔除编辑态 UI（选择手柄、悬停高亮、未提交草稿、失效提示文字）。
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});

  const STRIP_CLASS = /(selection|hover|lasso|preview|warningsLayer|indicesLayer|dataLayer|additionalInfoLayer)/i;
  const FULLSIZE_RECT = /(backgroundLayer|imagesLayer|selectionPlateLayer|selectionPointsLayer|hoveringLayer|bondSkeletonLayer|warningsLayer|dataLayer|additionalInfoLayer|indicesLayer)/;
  const CONTENT = 'text,path,line,circle,ellipse,polygon,polyline,rect,image,use,foreignObject';
  const DEFINITION = /^(defs|clipPath|mask|marker|pattern|symbol)$/i;

  function isUiNode(el) {
    if (!el || !el.getAttribute) return false;
    if (el.getAttribute('data-mech-ui') === '1') return true;
    if (el.getAttribute('data-molstudio-ui') === 'scrollbar') return true;
    if (/^(horizontal|vertical)-bar$/.test(el.getAttribute('data-testid') || '')) return true;
    const cls = el.getAttribute('class') || '';
    if (STRIP_CLASS.test(cls) || /\bmech-(overlay|ghost)\b/.test(cls)) return true;
    if (String(el.tagName).toLowerCase() === 'rect' && FULLSIZE_RECT.test(cls)) return true;
    return false;
  }

  const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  const validMatrix = m => m && ['a', 'b', 'c', 'd', 'e', 'f'].every(key => Number.isFinite(m[key]));
  function multiply(a, b) {
    return { a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b,
      c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d,
      e: a.a * b.e + a.c * b.f + a.e, f: a.b * b.e + a.d * b.f + a.f };
  }
  function inverse(m) {
    if (!validMatrix(m)) return null;
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) return null;
    return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
  }
  function relativeMatrix(el, svg) {
    // getBBox is local to its element. Cancel the root's viewBox transform so
    // camera pan/zoom cannot be mistaken for document geometry.
    try {
      const rootInverse = inverse(svg.getCTM()), matrix = el.getCTM();
      if (rootInverse && validMatrix(matrix)) return multiply(rootInverse, matrix);
    } catch (_) { /* Detached/test SVGs can still expose their transform lists. */ }
    let matrix = identity();
    for (let node = el; node && node !== svg; node = node.parentElement) {
      const list = node.transform?.baseVal;
      let local = identity();
      for (let i = 0; i < (list?.numberOfItems || 0); i++) {
        const item = list.getItem(i).matrix;
        if (validMatrix(item)) local = multiply(local, item);
      }
      matrix = multiply(local, matrix);
    }
    return matrix;
  }
  function styleOf(el) {
    try { return el.ownerDocument?.defaultView?.getComputedStyle(el) || null; }
    catch (_) { return null; }
  }
  function styleValue(el, style, property) {
    return style?.getPropertyValue?.(property) || el.style?.getPropertyValue?.(property) || el.getAttribute(property) || '';
  }
  function drawable(el, svg, styles) {
    const style = node => {
      if (!styles.has(node)) styles.set(node, styleOf(node));
      return styles.get(node);
    };
    for (let node = el; node; node = node.parentElement) {
      if (isUiNode(node) || DEFINITION.test(node.tagName || '')) return false;
      const s = style(node);
      if (styleValue(node, s, 'display') === 'none' || styleValue(node, s, 'opacity') !== '' && Number(styleValue(node, s, 'opacity')) === 0) return false;
      if (node === svg) break;
    }
    const s = style(el), visibility = styleValue(el, s, 'visibility');
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    if (String(el.tagName).toLowerCase() === 'text' && !(el.textContent || '').trim()) return false;
    const tag = String(el.tagName).toLowerCase();
    if (!['image', 'foreignobject', 'use'].includes(tag)) {
      const fill = styleValue(el, s, 'fill') || 'black', stroke = styleValue(el, s, 'stroke') || 'none';
      const fillOpacity = styleValue(el, s, 'fill-opacity'), strokeOpacity = styleValue(el, s, 'stroke-opacity');
      if ((fill === 'none' || fillOpacity !== '' && Number(fillOpacity) === 0) &&
          (stroke === 'none' || strokeOpacity !== '' && Number(strokeOpacity) === 0)) return false;
    }
    return true;
  }

  /* 由模型算包围盒（结构坐标 → 用户坐标）：覆盖所有原子、箭头起点/控制点/终点、孤对点。
     留白按键长给（原子标签的大小），这样不依赖 DOM 的 getBBox。 */
  function modelBBox(adapter, model, ctx, extraPad) {
    const bl = adapter.bondLength() || 40;
    const off = adapter.offset();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (p) => {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    };
    const st = adapter.struct();
    for (const [, a] of st.atoms) if (a.pp) add({ x: a.pp.x, y: a.pp.y });
    for (const lp of (model ? model.state.lonePairs : [])) {
      if (lp.visible === false) continue;
      const p = MW.model.lonePairPosition(lp, ctx);
      if (p) add(p);
    }
    for (const ar of (model ? model.state.arrows : [])) {
      const g = MW.model.arrowGeometry(ar, ctx);
      add(g.start); add(g.end); add(g.control);
    }
    if (!isFinite(x1)) return null;
    const padModel = 0.9 + (extraPad || 0) / bl;
    return {
      x: x1 * bl + off.x - padModel * bl,
      y: y1 * bl + off.y - padModel * bl,
      width: (x2 - x1) * bl + padModel * bl * 2,
      height: (y2 - y1) * bl + padModel * bl * 2
    };
  }

  /* Visible painted leaves, transformed from their own coordinates to root SVG. */
  function contentBBox(svg) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const add = (b) => {
      if (!b || !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)) return;
      if (b.width <= 0 && b.height <= 0) return;
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
    };
    const styles = new Map();
    for (const el of Array.from(svg.querySelectorAll(CONTENT))) {
      if (!drawable(el, svg, styles)) continue;
      try {
        const box = el.getBBox(), matrix = relativeMatrix(el, svg), s = styles.get(el);
        const stroke = styleValue(el, s, 'stroke');
        const halfStroke = stroke && stroke !== 'none' ? Math.max(0, parseFloat(styleValue(el, s, 'stroke-width')) || 0) / 2 : 0;
        const corners = [[box.x - halfStroke, box.y - halfStroke], [box.x + box.width + halfStroke, box.y - halfStroke],
          [box.x - halfStroke, box.y + box.height + halfStroke], [box.x + box.width + halfStroke, box.y + box.height + halfStroke]]
          .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
        const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
        add({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
      } catch (_) { /* Unrendered/invalid SVG leaves have no usable geometry. */ }
    }
    if (!isFinite(x1)) return null;
    return { x: x1, y: y1, width: Math.max(x2 - x1, 1), height: Math.max(y2 - y1, 1) };
  }

  /* Rendered content is authoritative, including native annotations and legends.
     Model control points are not painted extents and can add large blank areas. */
  function fullExportBBox(svg, adapter, model, ctx, extraPad) {
    return contentBBox(svg);
  }

  function cloneContent(svg) {
    const clone = svg.cloneNode(true);
    for (const el of Array.from(clone.querySelectorAll('*'))) {
      if (!el.parentNode) continue;
      if (isUiNode(el)) { el.remove(); continue; }
      const tag = el.tagName;
      const cls = el.getAttribute('class') || '';
      if (tag === 'rect' && FULLSIZE_RECT.test(cls)) { el.remove(); continue; }
      if (tag === 'desc') { el.remove(); continue; }
    }
    return clone;
  }

  function measuredCloneBBox(clone, source) {
    // Browsers only guarantee useful text geometry for attached SVGs. Measure
    // the export copy offscreen; the live editor DOM, source and history stay intact.
    const doc = source.ownerDocument, host = doc.body || doc.documentElement;
    if (!host?.appendChild) return contentBBox(source);
    // Measure at one SVG unit per CSS pixel. Some engines quantize text bounds
    // at the current viewBox scale, even though the serialized geometry is equal.
    const width = parseFloat(source.getAttribute('width')) || 1024;
    const height = parseFloat(source.getAttribute('height')) || 768;
    clone.setAttribute('width', width); clone.setAttribute('height', height);
    clone.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const holder = doc.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:-100000px;opacity:0;pointer-events:none;';
    holder.appendChild(clone); host.appendChild(holder);
    try { return contentBBox(clone); }
    finally { clone.remove(); holder.remove(); }
  }

  /* 生成独立 SVG 字符串：白底 + 指定包围盒 + 留白 */
  function buildSvg(svgEl, opts) {
    const o = opts || {};
    const pad = o.padding === undefined ? 16 : o.padding;
    const clone = cloneContent(svgEl);

    // R06 规范化出版尺度：重渲染 clone 中的 .mech-body，使其使用 zoom=1 的出版尺度
    const mechBody = clone.querySelector('.mech-body');
    if (mechBody && o.layer && o.model && o.adapter) {
      mechBody.textContent = '';
      const bl = o.adapter.bondLength() || 40;
      const uExport = 1 / bl; // 规范化 1.0 缩放，不受活画布视口 zoom 污染
      const pubCtx = Object.assign({}, o.ctx, {
        unit: () => uExport,
        atomLabelBox: (uuid) => {
          const box = o.ctx && o.ctx.atomLabelBox ? o.ctx.atomLabelBox(uuid) : null;
          if (!box) return { hasLabel: false, hwCss: 0, hhCss: 0 };
          // 模型坐标的真实字形边界不随视口变；仅把兼容的 CSS 尺寸还原到 100%。
          const z = o.adapter.zoom() || 1;
          return Object.assign({}, box, { hwCss: box.hwCss / z, hhCss: box.hhCss / z });
        }
      });
      o.layer.renderLonePairs(o.model, pubCtx, uExport, new Set(), {}, mechBody);
      o.layer.renderArrows(o.model, pubCtx, uExport, new Set(), {}, mechBody);
    }
    // Re-measure the normalized export copy: lone-pair publication sizing must
    // not inherit the live camera zoom or be clipped by its former screen bounds.
    const measured = measuredCloneBBox(clone, svgEl);
    const bbox = o.layer && o.model && o.adapter ? measured : o.bbox || measured;
    if (!bbox) return { ok: false, code: 'empty', error: '画布是空的，没有可导出的内容' };
    const vb = { x: bbox.x - pad, y: bbox.y - pad,
      width: Math.max(bbox.width + pad * 2, 8), height: Math.max(bbox.height + pad * 2, 8) };
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.width + ' ' + vb.height);
    clone.setAttribute('width', Math.round(vb.width));
    clone.setAttribute('height', Math.round(vb.height));
    clone.removeAttribute('style');
    clone.removeAttribute('class');

    const NS = 'http://www.w3.org/2000/svg';
    const bg = svgEl.ownerDocument.createElementNS(NS, 'rect');
    bg.setAttribute('x', vb.x);
    bg.setAttribute('y', vb.y);
    bg.setAttribute('width', vb.width);
    bg.setAttribute('height', vb.height);
    bg.setAttribute('fill', '#ffffff');
    const style = svgEl.ownerDocument.createElementNS(NS, 'style');
    style.textContent = 'text{font-family:Arial,"PingFang SC",sans-serif;}.mech-lone-pair circle{stroke:none;}';
    clone.insertBefore(bg, clone.firstChild);
    clone.insertBefore(style, clone.firstChild);

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    return { ok: true, svg: xml, width: Math.round(vb.width), height: Math.round(vb.height) };
  }

  /* PNG：把上面的 SVG 画进 canvas（默认 2 倍分辨率，高分屏不糊） */
  function svgToPng(svgText, width, height, scale, win) {
    return new Promise((resolve, reject) => {
      const doc = win.document;
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const s = scale || 2;
          const canvas = doc.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * s));
          canvas.height = Math.max(1, Math.round(height * s));
          const g = canvas.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve({ ok: true, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height });
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 渲染为图片失败')); };
      img.src = url;
    });
  }

  MW.exporter = {
    contentBBox: contentBBox,
    modelBBox: modelBBox,
    fullExportBBox: fullExportBBox,
    buildSvg: buildSvg,
    svgToPng: svgToPng,
    cloneContent: cloneContent
  };
})(typeof window !== 'undefined' ? window : globalThis);
