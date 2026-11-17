/**
 * document-rich-text.js — 纸页文本框"选区级富文本"纯逻辑模块（阶段二地基）。
 *
 * Runs 持久化契约：
 * - runs 是文本对象 rich 上的"可选新字段"：{runs: [{start, end, bold?, ...}]}。
 *   旧文本对象（无 runs）必须继续可用；旧构建的 validateDocument 白名单不含 runs，
 *   会拒绝含 runs 的文件 —— 这是刻意的 fail closed：宁拒勿静默丢弃格式数据。
 *   接线方在升级校验白名单时同步放行本模块 validateRuns 通过的 runs。
 *
 * IME 安全约束（接线方必读）：
 * - 在 compositionstart/compositionend 期间绝不重建编辑器 DOM；
 *   只在 finishTextEdit（composition 结束后）调用 readEditorDom 取回 {text, runs}。
 *
 * 实现约束：全部为纯函数；DOM 以参数传入（doc / 元素），不访问全局 document/window；
 * 绝不做 HTML 字符串解析渲染（buildEditorDom 仅用 DOM API 构造；
 * sanitizeClipboardFragment 只遍历已解析好的 DOM）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.MolWorkbench = root.MolWorkbench || {}; root.MolWorkbench.documentRichText = api; }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  var MAX_RUNS = 512;
  var BOOL_KEYS = ['bold', 'italic', 'underline', 'sub', 'sup'];
  var VALUE_KEYS = ['color', 'fontSize', 'fontFamily'];
  var RUN_KEYS = BOOL_KEYS.concat(VALUE_KEYS).concat(['start', 'end']);
  var NAMED_COLORS = ['black', 'white', 'red', 'blue', 'green', 'gray'];
  var COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  var FAMILY_RE = /^[\w\s,\-"']{1,160}$/;
  var MAX_ERRORS = 32;

  function isPlain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function validColor(v) { return typeof v === 'string' && (COLOR_RE.test(v) || NAMED_COLORS.includes(v)); }
  function validFontSize(v) { return finite(v) && v >= 2 && v <= 300; }
  function validFamily(v) { return typeof v === 'string' && FAMILY_RE.test(v); }

  /** 浏览器会把内联颜色序列化为 rgb()/rgba()，读回时归一为 #hex；无法识别则返回 null。 */
  function parseColor(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    if (validColor(s)) return s;
    var m = s.match(/^rgba?\(\s*(\d{1,3})\s*[\s,]+(\d{1,3})\s*[\s,]+(\d{1,3})\s*(?:[,\/][\s]*(\d{1,3}%?)?\s*)?\)$/);
    if (!m) return null;
    function h(x) { var n = parseInt(x, 10); return n > 255 ? null : ('0' + n.toString(16)).slice(-2); }
    var r = h(m[1]), g = h(m[2]), b = h(m[3]);
    if (!r || !g || !b) return null;
    return '#' + r + g + b;
  }

  function runShapeOk(run) {
    if (!isPlain(run)) return false;
    return Object.keys(run).every(function (k) { return RUN_KEYS.includes(k); }) &&
      Number.isInteger(run.start) && Number.isInteger(run.end) &&
      run.start >= 0 && run.start < run.end;
  }

  /** 规范 runs：排序、重叠取先者截断、剔除空/越界、同格式相邻合并、512 条上限截断。 */
  function normalizeRuns(runs, text) {
    var len = typeof text === 'string' ? text.length : 0;
    var list = Array.isArray(runs) ? runs.filter(function (r) {
      return runShapeOk(r) && r.end <= len;
    }) : [];
    list.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      var cur = { start: list[i].start, end: Math.min(list[i].end, len) };
      for (var k = 0; k < RUN_KEYS.length; k++) {
        var key = RUN_KEYS[k];
        if (key !== 'start' && key !== 'end' && list[i][key] !== undefined) cur[key] = list[i][key];
      }
      var prev = kept[kept.length - 1];
      if (prev && cur.start < prev.end) { cur.start = prev.end; if (cur.start >= cur.end) continue; }
      // 无任何格式键的 run 等价于整框默认，不保留
      var hasFmt = false;
      for (var fk = 0; fk < RUN_KEYS.length; fk++) if (RUN_KEYS[fk] !== 'start' && RUN_KEYS[fk] !== 'end' && cur[RUN_KEYS[fk]] !== undefined) { hasFmt = true; break; }
      if (!hasFmt) continue;
      kept.push(cur);
    }
    var merged = [];
    for (var j = 0; j < kept.length; j++) {
      var r = kept[j], last = merged[merged.length - 1];
      if (last && last.end === r.start && sameFormat(last, r)) last.end = r.end;
      else merged.push(r);
    }
    return merged.slice(0, MAX_RUNS);
  }

  function sameFormat(a, b) {
    for (var i = 0; i < BOOL_KEYS.length; i++)
      if (!!a[BOOL_KEYS[i]] !== !!b[BOOL_KEYS[i]]) return false;
    for (var k = 0; k < VALUE_KEYS.length; k++)
      if (a[VALUE_KEYS[k]] !== b[VALUE_KEYS[k]]) return false;
    return true;
  }

  /** 校验 runs：中文错误消息、有界（≤32 条）。 */
  function validateRuns(runs, text) {
    var errors = [];
    function fail(msg) { if (errors.length < MAX_ERRORS) errors.push(msg); }
    var len = typeof text === 'string' ? text.length : 0;
    if (!Array.isArray(runs)) { fail('runs 必须是数组'); return { ok: false, errors: errors }; }
    if (runs.length > MAX_RUNS) fail('runs 数量超过 512 条上限');
    for (var i = 0; i < Math.min(runs.length, MAX_RUNS + 1); i++) {
      var run = runs[i];
      if (!runShapeOk(run)) { fail('第 ' + (i + 1) + ' 条 run 结构无效'); continue; }
      if (run.end > len) { fail('第 ' + (i + 1) + ' 条 run 超出文本长度'); continue; }
      for (var b = 0; b < BOOL_KEYS.length; b++)
        if (run[BOOL_KEYS[b]] !== undefined && typeof run[BOOL_KEYS[b]] !== 'boolean') fail('第 ' + (i + 1) + ' 条 run 的 ' + BOOL_KEYS[b] + ' 必须是布尔值');
      if (run.color !== undefined && !validColor(run.color)) fail('第 ' + (i + 1) + ' 条 run 的颜色无效');
      if (run.fontSize !== undefined && !validFontSize(run.fontSize)) fail('第 ' + (i + 1) + ' 条 run 的字号必须在 2..300 之间');
      if (run.fontFamily !== undefined && !validFamily(run.fontFamily)) fail('第 ' + (i + 1) + ' 条 run 的字体名无效');
    }
    if (normalizeRuns(runs, text).length !== Math.min(runs.length, MAX_RUNS + 1) && runs.length <= MAX_RUNS && errors.length === 0 && !strictlyOrdered(runs, len))
      fail('runs 必须有序且互不重叠');
    return { ok: errors.length === 0, errors: errors };
  }

  function strictlyOrdered(runs, len) {
    var prevEnd = -1;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!runShapeOk(r) || r.end > len || r.start < prevEnd) return false;
      prevEnd = r.end;
    }
    return true;
  }

  function baseFormat(rich) {
    rich = isPlain(rich) ? rich : {};
    var out = {};
    for (var i = 0; i < BOOL_KEYS.length; i++) if (typeof rich[BOOL_KEYS[i]] === 'boolean') out[BOOL_KEYS[i]] = rich[BOOL_KEYS[i]];
    for (var k = 0; k < VALUE_KEYS.length; k++) if (rich[VALUE_KEYS[k]] !== undefined) out[VALUE_KEYS[k]] = rich[VALUE_KEYS[k]];
    return out;
  }

  function mergeFormat(base, run) {
    var out = {};
    var keys = BOOL_KEYS.concat(VALUE_KEYS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (run && run[k] !== undefined) out[k] = run[k];
      else if (base[k] !== undefined) out[k] = base[k];
    }
    return out;
  }

  /** 该偏移生效格式（run 覆盖整框默认；未指定键即整框默认/未定义）。 */
  function formatAt(rich, offset) {
    var text = isPlain(rich) ? String(rich.text || '') : '';
    var i = clamp(offset | 0, 0, text.length);
    var runs = normalizeRuns(isPlain(rich) ? rich.runs : [], text);
    var hit = null;
    for (var r = 0; r < runs.length; r++) if (i >= runs[r].start && i < runs[r].end) { hit = runs[r]; break; }
    return mergeFormat(baseFormat(rich), hit);
  }

  /** 全文本分段：[{text, start, end, ...生效格式}]，无缝覆盖 0..text.length。 */
  function segments(rich) {
    var text = isPlain(rich) ? String(rich.text || '') : '';
    var base = baseFormat(rich);
    var runs = normalizeRuns(isPlain(rich) ? rich.runs : [], text);
    var out = [], pos = 0;
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (run.start > pos) out.push(seg(text, pos, run.start, base));
      if (run.end > pos) { out.push(seg(text, Math.max(pos, run.start), run.end, mergeFormat(base, run))); pos = run.end; }
    }
    if (pos < text.length) out.push(seg(text, pos, text.length, base));
    return out;

    function seg(t, s, e, f) {
      var o = { text: t.slice(s, e), start: s, end: e };
      for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k)) o[k] = f[k];
      return o;
    }
  }

  function patchKeys(patch) {
    var out = {};
    if (!isPlain(patch)) return out;
    var keys = BOOL_KEYS.concat(VALUE_KEYS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var v = patch[k];
      if (BOOL_KEYS.includes(k)) { if (typeof v === 'boolean' || v === undefined) out[k] = v; }
      else if (v === undefined) out[k] = undefined;
      else if (k === 'color' && validColor(v)) out[k] = v;
      else if (k === 'fontSize' && validFontSize(v)) out[k] = v;
      else if (k === 'fontFamily' && validFamily(v)) out[k] = v;
    }
    return out;
  }

  /** 在 [start,end) 应用格式补丁：先按边界切开，再逐段合并；undefined 清除恢复整框默认；text 不变。 */
  /** 在 [start,end) 应用格式补丁：先按边界切开，再逐段合并；undefined 清除恢复整框默认；text 不变。 */
  function applyFormat(rich, range, patch) {
    var src = isPlain(rich) ? rich : {};
    var text = String(src.text || '');
    var s = clamp(isPlain(range) ? range.start | 0 : 0, 0, text.length);
    var e = clamp(isPlain(range) ? range.end | 0 : 0, s, text.length);
    var p = patchKeys(patch);
    var runs = normalizeRuns(src.runs, text);
    var hasPatch = false;
    for (var pk in p) if (Object.prototype.hasOwnProperty.call(p, pk)) { hasPatch = true; break; }
    var cut = [], covered = [];
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var pieces = [
        [Math.max(r.start, s), Math.min(r.end, e), true],
        [r.start, Math.min(r.end, s), false],
        [Math.max(r.start, e), r.end, false]
      ].sort(function (a, b) { return a[0] - b[0]; });
      for (var pc = 0; pc < pieces.length; pc++) {
        var segStart = pieces[pc][0], segEnd = pieces[pc][1], inside = pieces[pc][2];
        if (segStart >= segEnd) continue;
        var piece = { start: segStart, end: segEnd };
        // 先继承该 run 已有格式，选区内再应用补丁（undefined = 删除恢复默认）
        for (var rk in r) if (Object.prototype.hasOwnProperty.call(r, rk) && rk !== 'start' && rk !== 'end') piece[rk] = r[rk];
        if (inside) {
          for (var pk in p) if (Object.prototype.hasOwnProperty.call(p, pk)) {
            if (p[pk] === undefined) delete piece[pk]; else piece[pk] = p[pk];
          }
        }
        cut.push(piece);
        if (inside) covered.push([segStart, segEnd]);
      }
    }
    if (hasPatch && e > s) {
      // 未被任何 run 覆盖的选区内区段：用补丁生成新 run（补丁全为 undefined 时跳过）
      var anySet = false;
      for (var pk2 in p) if (Object.prototype.hasOwnProperty.call(p, pk2) && p[pk2] !== undefined) { anySet = true; break; }
      if (anySet) {
        covered.sort(function (a, b) { return a[0] - b[0]; });
        var y = s;
        var gaps = [];
        for (var c = 0; c < covered.length; c++) {
          if (covered[c][0] > y) gaps.push([y, covered[c][0]]);
          y = Math.max(y, covered[c][1]);
        }
        if (y < e) gaps.push([y, e]);
        for (var g = 0; g < gaps.length; g++) {
          var piece2 = { start: gaps[g][0], end: gaps[g][1] };
          for (var pk3 in p) if (Object.prototype.hasOwnProperty.call(p, pk3) && p[pk3] !== undefined) piece2[pk3] = p[pk3];
          cut.push(piece2);
        }
      }
    }
    var out = {};
    for (var key in src) if (Object.prototype.hasOwnProperty.call(src, key) && key !== 'runs') out[key] = src[key];
    out.text = text;
    out.runs = normalizeRuns(cut, text);
    return out;
  }

  /**
   * 断行：与 document-controller textLines 语义一致
   * （CJK 宽 2、ASCII 宽 1，逐字符断行，尊重 \n）。
   * chars = max(1, floor(boxWidthUnits / (fontSizeUnits * 0.55)))。
   * measure?(char) 返回该字符宽度单位，默认同上。
   * lineHeight 缺省取 rich.lineHeight（默认 1.4）。
   * 返回 { lines, heights }：lines 每项 {segments, text}；heights 为总高
   *   fs + (n-1)*fs*lineHeight + fs*0.3，与 textHeight 一致。
   */
  function layoutLines(rich, boxWidthUnits, fontSizeUnits, measure, lineHeight) {
    var src = isPlain(rich) ? rich : {};
    var text = String(src.text || '');
    var width = finite(boxWidthUnits) ? boxWidthUnits : 0;
    var fs = finite(fontSizeUnits) && fontSizeUnits > 0 ? fontSizeUnits : 12;
    var lh = finite(lineHeight) && lineHeight > 0 ? lineHeight : (finite(src.lineHeight) && src.lineHeight > 0 ? src.lineHeight : 1.4);
    var mf = typeof measure === 'function' ? measure : function (ch) { return /[^\x00-\xff]/.test(ch) ? 2 : 1; };
    var chars = Math.max(1, Math.floor(width / (fs * 0.55)));
    var segs = segments(src);
    var basePt = validFontSize(src.fontSize) ? src.fontSize : 12;
    function sizeRatio(seg) { return seg && validFontSize(seg.fontSize) ? seg.fontSize / basePt : 1; }
    function segAt(i) { for (var s = 0; s < segs.length; s++) if (i >= segs[s].start && i < segs[s].end) return segs[s]; return null; }
    var lines = [], lineCount = 0, offset = 0;
    var paragraphs = text.split('\n');
    for (var pi = 0; pi < paragraphs.length; pi++) {
      var para = paragraphs[pi];
      if (!para) { lines.push({ segments: [], text: '', fontSize: fs }); lineCount++; offset++; continue; }
      var pieces = [], curPiece = null, n = 0, lineStart = offset;
      for (var c = 0; c < para.length; c++) {
        var s2 = segAt(offset + c);
        var u = mf(para[c], s2) * sizeRatio(s2);
        if (n && n + u > chars) {
          lines.push(makeLine(pieces, lineStart)); lineCount++;
          pieces = []; curPiece = null; n = 0;
          lineStart = offset + c;
        }
        if (!curPiece || curPiece.seg !== s2) { curPiece = { seg: s2, text: para[c] }; pieces.push(curPiece); }
        else curPiece.text += para[c];
        n += u;
      }
      lines.push(makeLine(pieces, lineStart)); lineCount++;
      offset += para.length + 1;
    }
    function makeLine(pieces, startAt) {
      var segList = [], startIdx = startAt;
      for (var b = 0; b < pieces.length; b++) {
        var piece = pieces[b];
        var segObj = { text: piece.text, start: startIdx, end: startIdx + piece.text.length };
        if (piece.seg) for (var fk in piece.seg) if (Object.prototype.hasOwnProperty.call(piece.seg, fk) && ['text', 'start', 'end'].indexOf(fk) === -1) segObj[fk] = piece.seg[fk];
        segList.push(segObj);
        startIdx += piece.text.length;
      }
      var maximum = segList.reduce(function (height, seg) { return Math.max(height, fs * sizeRatio(seg)); }, fs);
      return { segments: segList, text: segList.map(function (x) { return x.text; }).join(''), fontSize: maximum };
    }
    if (lines.every(function (line) { return line.fontSize === fs; })) {
      // Preserve the original arithmetic as well as the geometry: tiny float
      // differences must not dirty an untouched existing multi-line object.
      for (var plainLine = 0; plainLine < lines.length; plainLine++) lines[plainLine].baseline = fs + plainLine * fs * lh;
      return { lines: lines, heights: fs + (lineCount - 1) * fs * lh + fs * 0.3 };
    }
    var top = 0;
    for (var li = 0; li < lines.length; li++) {
      lines[li].baseline = top + lines[li].fontSize;
      top += lines[li].fontSize * lh;
    }
    var last = lines[lines.length - 1];
    return { lines: lines, heights: last ? last.baseline + last.fontSize * 0.3 : fs * 1.3 };
  }

  /** 去掉 runs 的整框 rich（旧渲染回退）。 */
  function applyToPlainRich(rich) {
    var out = {};
    if (isPlain(rich)) for (var k in rich) if (Object.prototype.hasOwnProperty.call(rich, k) && k !== 'runs') out[k] = rich[k];
    return out;
  }

  /** {text, runs:[]}。 */
  function plainFromText(text) {
    return { text: typeof text === 'string' ? text : String(text == null ? '' : text), runs: [] };
  }

  // ---------- 编辑器 DOM ----------

  function setStyle(el, k, v) { el.style.setProperty(k, v); }

  function styleForFormat(f, pxPerPt) {
    var px = finite(pxPerPt) && pxPerPt > 0 ? pxPerPt : 1;
    var css = {};
    if (f.bold === true) css['font-weight'] = '700'; else if (f.bold === false) css['font-weight'] = '400';
    if (f.italic === true) css['font-style'] = 'italic'; else if (f.italic === false) css['font-style'] = 'normal';
    if (f.underline === true) css['text-decoration'] = 'underline';
    if (typeof f.color === 'string') css['color'] = f.color;
    if (validFontSize(f.fontSize)) css['font-size'] = (f.fontSize * px) + 'px';
    if (typeof f.fontFamily === 'string') css['font-family'] = f.fontFamily;
    return css;
  }

  /**
   * 构建编辑 DOM：div + 段间 br；run 渲染为 span（sub/sup 用 <sub>/<sup> 标签包裹便于 read 识别）。
   * 仅 DOM API，绝不 innerHTML。
   */
  function buildEditorDom(rich, doc, pxPerPt) {
    var px = finite(pxPerPt) && pxPerPt > 0 ? pxPerPt : 1;
    var div = doc.createElement('div');
    var segs = segments(rich);
    // 预切段：按 \n 展开为段落（段内 piece 保持 run 格式与全局偏移）
    var paras = [[]];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], pos = 0;
      while (pos <= s.text.length) {
        var nl = s.text.indexOf('\n', pos);
        var stop = nl === -1 ? s.text.length : nl;
        if (stop > pos) paras[paras.length - 1].push({ text: s.text.slice(pos, stop), start: s.start + pos, fmt: s });
        if (nl === -1) break;
        paras.push([]);
        pos = nl + 1;
      }
    }
    if (!segs.length) paras = [[], []]; // 保持与旧编辑器空内容两个空行观感一致的最小结构：单个空段
    if (!segs.length) paras = [[]];
    for (var p = 0; p < paras.length; p++) {
      if (p > 0) div.appendChild(doc.createElement('br'));
      appendPara(paras[p]);
    }
    return div;

    function appendPara(pieces) {
      for (var j = 0; j < pieces.length; j++) {
        var piece = pieces[j];
        var wrap = piece.fmt && (piece.fmt.sub === true || piece.fmt.sup === true)
          ? doc.createElement(piece.fmt.sub === true ? 'sub' : 'sup') : null;
        var span = doc.createElement('span');
        var css = styleForFormat(piece.fmt || {}, px);
        for (var k in css) if (Object.prototype.hasOwnProperty.call(css, k)) setStyle(span, k, css[k]);
        span.appendChild(doc.createTextNode(piece.text));
        if (wrap) { wrap.appendChild(span); div.appendChild(wrap); }
        else div.appendChild(span);
      }
    }
  }

  function fmtFromNode(node, state) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    var out = { bold: state.bold, italic: state.italic, underline: state.underline, sub: state.sub, sup: state.sup,
      color: state.color, fontSize: state.fontSize, fontFamily: state.fontFamily };
    var chain = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== state.root) { chain.unshift(cur); cur = cur.parentNode; }
    for (var i = 0; i < chain.length; i++) applyEl(chain[i], out, state.pxPerPt);
    return out;
  }

  function applyEl(el, out, pxPerPt) {
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'B' || tag === 'STRONG') out.bold = true;
    if (tag === 'I' || tag === 'EM') out.italic = true;
    if (tag === 'U') out.underline = true;
    if (tag === 'SUB') out.sub = true;
    if (tag === 'SUP') out.sup = true;
    if (tag === 'SPAN') {
      var st = el.style;
      if (st) {
        var fw = st.getPropertyValue('font-weight');
        if (fw === '700' || fw === 'bold') out.bold = true; else if (fw === '400' || fw === 'normal') out.bold = false;
        var fsy = st.getPropertyValue('font-style');
        if (fsy === 'italic') out.italic = true; else if (fsy === 'normal') out.italic = false;
        var td = st.getPropertyValue('text-decoration') || '';
        if (td.indexOf('underline') !== -1) out.underline = true;
        var color = parseColor(st.getPropertyValue('color'));
        if (color) out.color = color;
        var pxStr = st.getPropertyValue('font-size');
        if (pxStr && /px$/.test(pxStr.trim())) {
          var pt = round2(parseFloat(pxStr) / (pxPerPt || 1));
          if (validFontSize(pt)) out.fontSize = pt;
        }
        var fam = st.getPropertyValue('font-family');
        if (validFamily(fam)) out.fontFamily = fam;
      }
    }
  }

  function fmtKey(f) {
    return JSON.stringify([f.bold, f.italic, f.underline, f.sub, f.sup, f.color, f.fontSize, f.fontFamily]);
  }

  /**
   * 读取编辑 DOM → {text, runs}：遍历文本节点，br→\n，按祖先链计算格式；px→pt（2 位舍入）。
   */
  // Empty editable blocks may wrap their caret BR in one or more styled spans.
  function editorPlaceholderBr(block) {
    var node = block;
    while (node && node.childNodes.length === 1) {
      node = node.firstChild;
      if (node.nodeType !== 1) return null;
      if (node.tagName === 'BR') return node;
      if (node.tagName === 'DIV' || node.tagName === 'P') return null;
    }
    return null;
  }

  function readEditorDom(rootEl, baseRich, pxPerPt, boundary) {
    var base = isPlain(baseRich) ? baseRich : {};
    var px = finite(pxPerPt) && pxPerPt > 0 ? pxPerPt : 1;
    var state = { root: rootEl, pxPerPt: px };
    var baseFmt = baseFormat(base);
    var pieces = [], tokens = []; // {text, fmt} or a required block boundary
    var text = '';
    function mark(node, offset) {
      if (boundary && boundary.container === node && boundary.offset === offset) tokens.push({ marker: true });
    }
    (function walk(node, inherited) {
      var childIndex = 0;
      for (var child = node.firstChild; child; child = child.nextSibling) {
        mark(node, childIndex++);
        if (child.nodeType === 3) {
          var t = child.nodeValue || '';
          if (!t) { mark(child, 0); continue; }
          var fmt = fmtFromNode(child, { root: rootEl, pxPerPt: px, bold: inherited.bold, italic: inherited.italic, underline: inherited.underline, sub: inherited.sub, sup: inherited.sup, color: inherited.color, fontSize: inherited.fontSize, fontFamily: inherited.fontFamily });
          if (boundary && boundary.container === child) {
            if (boundary.offset) tokens.push({ text: t.slice(0, boundary.offset), fmt: fmt });
            tokens.push({ marker: true });
            if (boundary.offset < t.length) tokens.push({ text: t.slice(boundary.offset), fmt: fmt });
          } else tokens.push({ text: t, fmt: fmt });
        } else if (child.nodeType === 1) {
          var tag = (child.tagName || '').toUpperCase();
          if (tag === 'BR') { tokens.push({ text: '\n', fmt: baseFmt }); continue; }
          if (tag === 'SCRIPT' || tag === 'STYLE') continue;
          var block = tag === 'P' || tag === 'DIV';
          if (block) tokens.push({ breaks: 1 });
          // Chromium keeps a sole BR in an empty block as its caret placeholder.
          // The block boundary already supplies that line; do not count it twice.
          if (block && editorPlaceholderBr(child)) {
            if (boundary && (boundary.container === child || child.contains(boundary.container))) tokens.push({ marker: true });
            tokens.push({ text: '', fmt: baseFmt });
          } else walk(child, inherited);
          if (block) tokens.push({ breaks: 1 });
        }
      }
      mark(node, childIndex);
    })(rootEl, Object.assign({}, baseFmt));
    // Adjacent block boundaries share one newline. Keep explicit empty blocks,
    // but discard a trailing boundary after a nonempty final block.
    var pendingBreaks = 0, sawContent = false, boundaryOffset = null, pendingMarker = false;
    for (var ti = 0; ti < tokens.length; ti++) {
      var token = tokens[ti];
      if (token.breaks) { pendingBreaks = Math.max(pendingBreaks, token.breaks); continue; }
      if (token.marker) {
        if (pendingBreaks && sawContent) pendingMarker = true;
        else boundaryOffset = text.length;
        continue;
      }
      if (pendingBreaks && sawContent) {
        pieces.push({ text: '\n', fmt: baseFmt }); text += '\n';
      }
      if (pendingMarker) { boundaryOffset = text.length; pendingMarker = false; }
      pendingBreaks = 0; sawContent = true;
      pieces.push(token); text += token.text;
    }
    if (pendingMarker) boundaryOffset = text.length;
    // CSSOM adds quotes to multiword family names. Compare canonical CSS values
    // so merely opening an editor does not introduce a run and dirty the file.
    var familyProbe = rootEl.ownerDocument && rootEl.ownerDocument.createElement('span');
    function sameValue(key, a, b) {
      if (key !== 'fontFamily' || typeof a !== 'string' || typeof b !== 'string' || !familyProbe) return a === b;
      familyProbe.style.setProperty('font-family', a);
      var ca = familyProbe.style.getPropertyValue('font-family');
      familyProbe.style.setProperty('font-family', b);
      return ca === familyProbe.style.getPropertyValue('font-family');
    }
    // 折叠为 runs（相对整框默认不同的显式格式）
    var runs = [], cur = null;
    var pos = 0;
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      for (var j = 0; j < piece.text.length; j++) {
        var eff = effective(piece.fmt, j, piece.text, base);
        if (cur && fmtKey(cur.fmt) === fmtKey(eff) && pos === cur.end) cur.end = pos + 1;
        else { if (cur) pushRun(cur); cur = { fmt: eff, start: pos, end: pos + 1 }; }
        pos++;
      }
    }
    if (cur) pushRun(cur);
    function pushRun(c) {
      var run = { start: c.start, end: c.end };
      for (var k = 0; k < BOOL_KEYS.length; k++) if (c.fmt[BOOL_KEYS[k]] !== undefined && c.fmt[BOOL_KEYS[k]] !== base[BOOL_KEYS[k]]) run[BOOL_KEYS[k]] = c.fmt[BOOL_KEYS[k]];
      for (var v = 0; v < VALUE_KEYS.length; v++) if (c.fmt[VALUE_KEYS[v]] !== undefined && !sameValue(VALUE_KEYS[v], c.fmt[VALUE_KEYS[v]], base[VALUE_KEYS[v]])) run[VALUE_KEYS[v]] = c.fmt[VALUE_KEYS[v]];
      if (Object.keys(run).length > 2) runs.push(run);
    }
    var result = { text: text, runs: normalizeRuns(runs, text) };
    if (boundary) result.offset = boundaryOffset;
    return result;

    function effective(fmt, idx, pieceText, baseRich2) {
      // piece 末尾换行等不影响；直接返回该 piece 的格式（同 piece 内格式一致）
      var out = {};
      for (var k in fmt) if (Object.prototype.hasOwnProperty.call(fmt, k)) out[k] = fmt[k];
      // 值等于整框默认的键不显式保留（pushRun 已按差异过滤）
      return out;
    }
  }

  // Count the same BR/block separators as persistence, without mutating the DOM.
  function editorTextOffset(rootEl, container, offset) {
    if (!rootEl || !container || !(rootEl === container || rootEl.contains(container)) || !Number.isInteger(offset) || offset < 0) return null;
    var length = container.nodeType === 3 ? (container.nodeValue || '').length : container.childNodes.length;
    if (offset > length) return null;
    return readEditorDom(rootEl, {}, 1, { container: container, offset: offset }).offset;
  }

  /** 粘贴清洗：白名单标签与基础样式；丢弃 script/style/img/a 等及一切 URL 属性。返回 {text, runs}。 */
  function sanitizeClipboardFragment(sourceEl, doc, pxPerPt) {
    void doc;
    var px = finite(pxPerPt) && pxPerPt > 0 ? pxPerPt : 1;
    var pieces = [], text = '';
    // 块级标签与 readEditorDom 的块语义对齐：块边界压换行；输出开头不补空行，连续边界只折一行。
    var BLOCK_TAGS = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE'];
    var pendingBreaks = 0, sawContent = false;
    function flushBreak() {
      if (pendingBreaks && sawContent) { pieces.push({ text: '\n', fmt: {} }); text += '\n'; }
      pendingBreaks = 0;
    }
    (function walk(node, fmt) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          var t = child.nodeValue || '';
          if (!t) continue;
          flushBreak(); sawContent = true;
          pieces.push({ text: t, fmt: fmt }); text += t;
        } else if (child.nodeType === 1) {
          var tag = (child.tagName || '').toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IMG' || tag === 'A' ||
              tag === 'IFRAME' || tag === 'OBJECT' || tag === 'SVG') continue;
          var next = Object.assign({}, fmt);
          if (tag === 'B' || tag === 'STRONG') next.bold = true;
          else if (tag === 'I' || tag === 'EM') next.italic = true;
          else if (tag === 'U') next.underline = true;
          else if (tag === 'SUB') next.sub = true;
          else if (tag === 'SUP') next.sup = true;
          else if (tag === 'BR') { flushBreak(); sawContent = true; pieces.push({ text: '\n', fmt: next }); text += '\n'; continue; }
          else if (BLOCK_TAGS.indexOf(tag) !== -1) {
            // Chromium keeps a sole BR in an empty block as its caret placeholder.
            // The block boundary already supplies that line; do not count it twice.
            if (editorPlaceholderBr(child)) { flushBreak(); sawContent = true; pieces.push({ text: '', fmt: next }); }
            else { pendingBreaks = 1; walk(child, next); pendingBreaks = 1; }
            continue;
          }
          else if (tag === 'SPAN') {
            var st = child.style;
            if (st) {
              var fw = st.getPropertyValue('font-weight');
              if (fw === '700' || fw === 'bold') next.bold = true; else if (fw === '400' || fw === 'normal') next.bold = false;
              var fsy = st.getPropertyValue('font-style');
              if (fsy === 'italic') next.italic = true; else if (fsy === 'normal') next.italic = false;
              var td = st.getPropertyValue('text-decoration') || '';
              if (td.indexOf('underline') !== -1) next.underline = true;
              var color = parseColor(st.getPropertyValue('color'));
              if (color) next.color = color;
              var pxStr = (st.getPropertyValue('font-size') || '').trim();
              if (/px$/.test(pxStr)) {
                var pt = clamp(round2(parseFloat(pxStr) / px), 2, 300);
                next.fontSize = pt;
              } else if (/pt$/.test(pxStr)) {
                next.fontSize = clamp(round2(parseFloat(pxStr)), 2, 300);
              }
              var fam = (st.getPropertyValue('font-family') || '').trim();
              if (validFamily(fam)) next.fontFamily = fam;
            }
          }
          walk(child, next);
        }
      }
    })(sourceEl, {});
    var runs = [], cur = null, pos = 0;
    for (var i = 0; i < pieces.length; i++) {
      var piece = pieces[i];
      for (var j = 0; j < piece.text.length; j++) {
        var f = piece.fmt;
        var key = fmtKey(f);
        if (cur && cur.key === key && pos === cur.end) cur.end++;
        else { if (cur) runs.push(toRun(cur)); cur = { key: key, fmt: f, start: pos, end: pos + 1 }; }
        pos++;
      }
    }
    if (cur) runs.push(toRun(cur));
    function toRun(c) {
      var run = { start: c.start, end: c.end };
      for (var k = 0; k < BOOL_KEYS.length; k++) if (c.fmt[BOOL_KEYS[k]] === true) run[BOOL_KEYS[k]] = true;
      for (var v = 0; v < VALUE_KEYS.length; v++) if (c.fmt[VALUE_KEYS[v]] !== undefined) run[VALUE_KEYS[v]] = c.fmt[VALUE_KEYS[v]];
      return run;
    }
    return { text: text, runs: normalizeRuns(runs, text) };
  }

  return {
    normalizeRuns: normalizeRuns,
    validateRuns: validateRuns,
    segments: segments,
    applyFormat: applyFormat,
    formatAt: formatAt,
    buildEditorDom: buildEditorDom,
    readEditorDom: readEditorDom,
    editorTextOffset: editorTextOffset,
    layoutLines: layoutLines,
    applyToPlainRich: applyToPlainRich,
    sanitizeClipboardFragment: sanitizeClipboardFragment,
    plainFromText: plainFromText
  };
});
