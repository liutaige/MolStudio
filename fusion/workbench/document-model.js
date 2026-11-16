/* Pure document data in Ketcher structure coordinates (positive y is down).
 * Page sizes and margins are in points; all object geometry is in bond lengths.
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const SIZES = { A4: [595.28, 841.89], Letter: [612, 792] };
  const LIMITS = { pages: 100, objects: 10000, regions: 1000, assets: 256,
    assetBytes: 64 * 1024 * 1024, coordinate: 100000, text: 262144, atomScales: 20000,
    runs: 512, molfile: 262144, atomUuids: 512 };
  let sequence = 0;
  function id(prefix) {
    const crypto = root.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') return prefix + '-' + crypto.randomUUID();
    return prefix + '-' + Date.now().toString(36) + '-' + (++sequence).toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function cloneDocument(value) { return JSON.parse(JSON.stringify(value)); }
  function createDocument(options) {
    const o = options || {}, size = o.size || (o.page && o.page.size) || 'A4';
    const orientation = o.orientation || (o.page && o.page.orientation) || 'portrait';
    if (!Object.prototype.hasOwnProperty.call(SIZES, size) || !['portrait', 'landscape'].includes(orientation)) throw new Error('无效页面设置');
    const dims = SIZES[size], width = orientation === 'landscape' ? dims[1] : dims[0];
    const height = orientation === 'landscape' ? dims[0] : dims[1];
    const margins = Object.assign({ top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 }, o.margins || (o.page && o.page.margins));
    const count = o.pageCount === undefined ? 1 : o.pageCount;
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.pages) throw new Error('页数无效');
    const doc = { mode: o.mode || 'canvas', page: { size, orientation, width, height, margins },
      ptPerBond: o.ptPerBond === undefined ? 14.4 : o.ptPerBond, pageCount: count,
      pages: Array.from({ length: count }, () => ({ id: id('page') })), objects: [], assets: {}, regions: [] };
    const checked = validateDocument(doc);
    if (!checked.ok) throw new Error(checked.errors.join('；'));
    return doc;
  }
  function pageRects(doc) {
    const p = doc.page, unit = doc.ptPerBond, w = p.width / unit, h = p.height / unit;
    const m = p.margins;
    return doc.pages.map((page, index) => {
      const x = 0, y = index * (h + 2);
      return { id: page.id, index, x, y, w, h,
        content: { x: x + m.left / unit, y: y + m.top / unit,
          w: (p.width - m.left - m.right) / unit, h: (p.height - m.top - m.bottom) / unit } };
    });
  }
  function pageAt(doc, point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return pageRects(doc).find(p => point.x >= p.x && point.x <= p.x + p.w && point.y >= p.y && point.y <= p.y + p.h) || null;
  }
  function addPage(doc) {
    const next = cloneDocument(doc);
    if (next.pages.length >= LIMITS.pages) throw new Error('页数超过上限');
    next.pages.push({ id: id('page') }); next.pageCount = next.pages.length;
    return next;
  }
  function removePage(doc, pageId) {
    const next = cloneDocument(doc), index = next.pages.findIndex(p => p.id === pageId);
    if (index < 0 || next.pages.length <= 1) throw new Error('页面不存在或不能删除最后一页');
    next.pages.splice(index, 1); next.pageCount = next.pages.length;
    for (const item of next.objects.concat(next.regions)) if (item.pageId === pageId) item.pageId = null;
    return next;
  }
  function validateDocument(doc) {
    const errors = [], fail = message => { if (errors.length < 32) errors.push(message); };
    const plain = x => !!x && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
    const finite = x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= LIMITS.coordinate;
    const validId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(x);
    const validShapeColor = x => typeof x === 'string' &&
      (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(x) ||
        /^(transparent|black|white|red|blue|green|gray)$/i.test(x));
    if (!plain(doc)) return { ok: false, errors: ['document 必须是对象'] };
    // Reject non-JSON values, dangerous keys, excessive nesting and nonfinite numbers
    // everywhere, including future style fields. Never reinterpret raw markup as HTML.
    let visited = 0;
    function json(value, depth) {
      if (++visited > 300000 || depth > 24) return false;
      if (value === null || typeof value === 'boolean') return true;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'string') return value.length <= LIMITS.text;
      if (Array.isArray(value)) return value.length <= 10000 && value.every(v => json(v, depth + 1));
      if (!plain(value)) return false;
      return Object.keys(value).length <= 1000 && Object.keys(value).every(k => !['__proto__', 'prototype', 'constructor'].includes(k) && json(value[k], depth + 1));
    }
    // Assets are validated separately because their base64 payloads can be large.
    const withoutAssets = Object.assign({}, doc, { assets: {} });
    if (!json(withoutAssets, 0)) fail('document 含无效或过大的数据');
    if (!['canvas', 'paper'].includes(doc.mode)) fail('document.mode 无效');
    if (!finite(doc.ptPerBond) || doc.ptPerBond <= 0) fail('印刷比例无效');
    const p = doc.page;
    if (!plain(p) || !Object.prototype.hasOwnProperty.call(SIZES, p.size) || !['portrait', 'landscape'].includes(p.orientation) ||
      !finite(p.width) || p.width <= 0 || !finite(p.height) || p.height <= 0 || !plain(p.margins)) fail('页面设置无效');
    else {
      const expected = SIZES[p.size], dims = p.orientation === 'landscape' ? [expected[1], expected[0]] : expected;
      if (Math.abs(p.width - dims[0]) > 0.01 || Math.abs(p.height - dims[1]) > 0.01) fail('纸张尺寸与页面设置不一致');
      if (['top', 'right', 'bottom', 'left'].some(k => !finite(p.margins[k]) || p.margins[k] < 0) ||
          p.margins.left + p.margins.right >= p.width || p.margins.top + p.margins.bottom >= p.height) fail('页边距无效');
      if (finite(doc.ptPerBond) && doc.ptPerBond > 0 && Number.isInteger(doc.pageCount) && doc.pageCount > 0 && doc.pageCount <= LIMITS.pages) {
        const width = p.width / doc.ptPerBond, height = p.height / doc.ptPerBond;
        const bottom = (doc.pageCount - 1) * (height + 2) + height;
        if (![width, height, bottom].every(finite) || width <= 0 || height <= 0) fail('页面坐标超出范围');
      }
    }
    const ids = new Set(), pages = new Set();
    function unique(value) { if (!validId(value) || ids.has(value)) { fail('ID 无效或重复'); return; } ids.add(value); }
    if (!Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > LIMITS.pages || doc.pageCount !== doc.pages.length) fail('页面列表无效');
    else for (const page of doc.pages) { if (!plain(page)) { fail('页面无效'); continue; } unique(page.id); pages.add(page.id); }
    let assetBytes = 0;
    if (!plain(doc.assets) || Object.keys(doc.assets).length > LIMITS.assets) fail('资源列表无效');
    else for (const [key, asset] of Object.entries(doc.assets)) {
      if (!validId(key) || !plain(asset) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mime) ||
          typeof asset.data !== 'string' || asset.data.length === 0 || asset.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) ||
          Object.keys(asset).some(k => !['mime', 'data'].includes(k))) { fail('图片资源无效'); continue; }
      assetBytes += asset.data.length / 4 * 3 - (asset.data.endsWith('==') ? 2 : asset.data.endsWith('=') ? 1 : 0);
    }
    if (assetBytes > LIMITS.assetBytes) fail('图片资源超过 64MB 上限');
    function rect(item) { return ['x', 'y', 'w', 'h'].every(k => finite(item[k])) && item.w > 0 && item.h > 0; }
    if (!Array.isArray(doc.objects) || doc.objects.length > LIMITS.objects) fail('文档对象列表无效');
    else for (const obj of doc.objects) {
      if (!plain(obj)) { fail('文档对象无效'); continue; }
      unique(obj.id);
      if (!['text', 'image', 'shape', 'molecule3d'].includes(obj.kind) || !rect(obj) ||
          (obj.rotation !== undefined && !finite(obj.rotation)) ||
          (obj.band !== undefined && !['front', 'back'].concat(obj.kind === 'molecule3d' ? ['inline'] : []).includes(obj.band)) ||
          (obj.pageId !== undefined && obj.pageId !== null && !pages.has(obj.pageId))) fail('文档对象几何或类型无效');
      if (obj.kind === 'image' && (!validId(obj.asset) || !plain(doc.assets) || !Object.prototype.hasOwnProperty.call(doc.assets, obj.asset))) fail('图片资源引用不存在');
      if (obj.kind === 'text' && (obj.html !== undefined || !plain(obj.rich) ||
          typeof obj.rich.text !== 'string' || obj.rich.text.length > LIMITS.text ||
          Object.keys(obj.rich).some(key => !['text', 'fontFamily', 'fontSize', 'bold', 'italic', 'color', 'align', 'lineHeight', 'runs'].includes(key)) ||
          ['fontFamily', 'color', 'align'].some(key => obj.rich[key] !== undefined && (typeof obj.rich[key] !== 'string' || obj.rich[key].length > 160)) ||
          ['fontSize', 'lineHeight'].some(key => obj.rich[key] !== undefined && (!finite(obj.rich[key]) || obj.rich[key] <= 0)) ||
          ['bold', 'italic'].some(key => obj.rich[key] !== undefined && typeof obj.rich[key] !== 'boolean'))) fail('文本必须使用安全的结构数据');
      else if (obj.kind === 'text' && obj.rich.runs !== undefined) {
        // runs 是可选字段：模块缺失时 fail closed（宁拒勿静默丢弃格式数据）
        if (!Array.isArray(obj.rich.runs) || obj.rich.runs.length > LIMITS.runs) fail('文本 runs 无效');
        else if (!MW.documentRichText) fail('富文本模块未加载');
        else {
          const checked = MW.documentRichText.validateRuns(obj.rich.runs, obj.rich.text);
          if (!checked.ok) for (const message of checked.errors.slice(0, 3)) fail(message);
        }
      }
      if (obj.kind === 'molecule3d') {
        if (MW.documentObject3D) {
          const checked = MW.documentObject3D.validateObject(obj);
          if (!checked.ok) for (const message of checked.errors.slice(0, 3)) fail(message);
        } else {
          // 兜底基本检查：保证只加载 document-model 的 Node 环境也能拒绝非法数据
          if (typeof obj.molfile !== 'string' || obj.molfile.length === 0 || obj.molfile.length > LIMITS.molfile) fail('molfile 无效');
          if (!['ballstick', 'stick', 'line', 'sphere'].includes(obj.style)) fail('3D 样式无效');
          if (!plain(obj.camera) || ['px', 'py', 'pz', 'distance'].some(key => !finite(obj.camera[key]))) fail('camera 无效');
          if (obj.notes !== undefined && !plain(obj.notes)) fail('notes 无效');
          if (obj.updatedAt !== undefined && !finite(obj.updatedAt)) fail('updatedAt 无效');
        }
        if (typeof obj.previewAsset === 'string' && obj.previewAsset &&
            (!plain(doc.assets) || !Object.prototype.hasOwnProperty.call(doc.assets, obj.previewAsset))) fail('3D 预览资源引用不存在');
        if (obj.source !== undefined) {
          if (!plain(obj.source)) fail('molecule3d 来源信息无效');
          else if (obj.source.atomUuids !== undefined &&
              (!Array.isArray(obj.source.atomUuids) || obj.source.atomUuids.length > LIMITS.atomUuids ||
                obj.source.atomUuids.some(u => !validId(u)))) fail('molecule3d 原子引用无效');
        }
      }
      if (obj.kind === 'shape') {
        if (!['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'bracket'].includes(obj.shape)) fail('形状类型无效');
        if (obj.cornerRadius !== undefined && (!finite(obj.cornerRadius) || obj.cornerRadius < 0)) fail('圆角半径无效');
        if (obj.fillColor !== undefined && !validShapeColor(obj.fillColor)) fail('形状填充颜色无效');
      }
    }
    // 可选 atomScales：uuid → 视觉缩放因子（纸页实际尺寸缩放的持久化通道）
    if (doc.atomScales !== undefined) {
      const entries = Object.entries(doc.atomScales || {});
      if (!plain(doc.atomScales) || entries.length > LIMITS.atomScales) fail('原子缩放因子列表无效');
      else for (const [key, value] of entries) {
        if (!validId(key)) { fail('原子缩放因子键无效'); continue; }
        if (!finite(value) || value <= 0 || value > 100) fail('原子缩放因子值必须是大于 0 且不超过 100 的有限数');
      }
    }
    if (!Array.isArray(doc.regions) || doc.regions.length > LIMITS.regions) fail('区域列表无效');
    else for (const region of doc.regions) {
      if (!plain(region)) { fail('区域无效'); continue; }
      unique(region.id);
      if (!rect(region) || (region.label !== undefined && (typeof region.label !== 'string' || region.label.length > 1000)) ||
          (region.pageId !== undefined && region.pageId !== null && !pages.has(region.pageId))) fail('区域几何无效');
    }
    return { ok: errors.length === 0, errors, assetBytes };
  }
  MW.documentModel = { SIZES, LIMITS, createDocument, cloneDocument, pageRects, pageAt, addPage, removePage, validateDocument };
})(typeof window !== 'undefined' ? window : globalThis);
