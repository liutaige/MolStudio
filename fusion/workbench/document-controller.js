/* MolStudio mixed document objects live directly in Ketcher's structure space.
 * Geometry uses bond lengths, positive y down. Every edit joins editor history.
 */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  const NS = 'http://www.w3.org/2000/svg';
  const PAPER_PAN_BLANK_RATIO = 0.2;
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => prefix + '-' + (root.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const editable = target => target?.closest?.('input,textarea,select,[contenteditable="true"]') && !target.closest('.cliparea');
  const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  const color = (value, fallback) => typeof value === 'string' && (/^#[0-9a-f]{3,8}$/i.test(value) || /^(none|transparent|black|white|red|blue|green|gray)$/i.test(value)) ? value : fallback;
  const validShapeColor = value => typeof value === 'string' &&
    (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ||
      /^(transparent|black|white|red|blue|green|gray)$/i.test(value));
  const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const rectOf = o => ({ x: o.x, y: o.y, w: o.w, h: o.h });
  const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
  class DocumentController {
    constructor(options) {
      Object.assign(this, options);
      this.state = MW.documentModel.createDocument();
      this.active = false; this.generation = 0;
      this.selection = new Set(); this.tool = 'select'; this.listeners = new Set();
      // Defaults for newly drawn document shapes; these are app-local drawing
      // preferences, not document content, so changing them does not dirty or
      // create history until the user actually draws a shape.
      this.shapeStyle = { fill: 'none', fillColor: '#ffffff', stroke: { color: '#3b5665', width: 0.05, dash: 'solid' } };
      this.drag = null; this.editor = null; this.layers = {}; this.preview = null;
      this.insert3DInteractionActive = false;
      this.scaleMode = false; // 悬浮工具条缩放模式：开启后渲染化学选框与控制点，Esc/再点退出
      this.mechanism.documentController = this;
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(reason) {
      root.__documentSelectionCount = this.selection.size;
      if (this.scaleMode && this.state.mode !== 'paper') { this.scaleMode = false; this.endScaleSession(); }
      if (reason !== 'pan') this.lastViewportPageId = this.active && this.state.mode === 'paper' ? this.getActivePage()?.id : null;
      for (const fn of this.listeners) fn(this.state, this, reason);
    }
    validate(state) {
      const result = MW.documentModel.validateDocument(state);
      if (!result.ok) throw new Error(result.errors.join('；'));
    }
    restore(value, reason) {
      this.finishTextEdit(); this.generation++; this.active = !!value;
      this.state = value ? clone(value) : MW.documentModel.createDocument();
      this.syncPageMembership();
      this.selection.clear(); this.tool = 'select'; this.clampPaperViewport(); this.render(); this.emit();
      this.scaleMode = false; this.scaleSession = null;
      this.adapter.syncVisualScalesFromDocument?.(this.state);
    }
    getState() { return clone(this.state); }
    getSelection() { return { objects: [...this.selection], mechanism: [...this.mechanism.selection], atoms: this.selectedAtomIds().map(id => this.adapter.uuidOfAtom(id)) }; }
    usablePaperArea() {
      const area = this.adapter.ed.render.clientArea?.getBoundingClientRect();
      if (!area) return null;
      const web = this.paperViewportInsets || {}, native = root.molCanvasViewport?.nativeInsetsFrame?.() || {};
      // Native insets start at the iframe edge, whereas web paper insets start
      // at Ketcher's clientArea. Intersect them without counting either twice.
      const frameWidth = this.win.innerWidth || area.left + area.width, frameHeight = this.win.innerHeight || area.top + area.height;
      const i = {
        left: Math.max(web.left || 0, (native.left || 0) - area.left),
        top: Math.max(web.top || 0, (native.top || 0) - area.top),
        right: Math.max(web.right || 0, (native.right || 0) - (frameWidth - area.left - area.width)),
        bottom: Math.max(web.bottom || 0, (native.bottom || 0) - (frameHeight - area.top - area.height))
      };
      const left = Math.min(i.left, Math.max(0, area.width - 80)), top = Math.min(i.top, Math.max(0, area.height - 80));
      const right = Math.min(i.right || 0, Math.max(0, area.width - left - 80)), bottom = Math.min(i.bottom || 0, Math.max(0, area.height - top - 80));
      return { left: area.left + left, top: area.top + top, width: area.width - left - right, height: area.height - top - bottom };
    }
    setPaperViewportInsets(insets) {
      const next = { left: 0, right: 0, top: 0, bottom: 0, ...this.paperViewportInsets };
      for (const key of ['left', 'right', 'top', 'bottom']) if (insets[key] !== undefined) {
        if (!Number.isFinite(insets[key]) || insets[key] < 0) throw new Error('可见区域边距无效');
        next[key] = Math.min(10000, insets[key]);
      }
      if (JSON.stringify(next) === JSON.stringify(this.paperViewportInsets)) return { ...next };
      this.paperViewportInsets = next;
      if (this.active && this.state.mode === 'paper' && this.paperFitMode) this.fit(this.paperFitMode);
      else { this.clampPaperViewport(); this.emit(); }
      return { ...next };
    }
    getActivePage() {
      const area = this.usablePaperArea();
      const pages = MW.documentModel.pageRects(this.state);
      if (!area) return pages.find(page => page.id === this.viewPageId) || pages[0];
      const point = this.adapter.clientToModel({ x: area.left + area.width / 2, y: area.top + area.height / 2 });
      if (!point) return pages.find(page => page.id === this.viewPageId) || pages[0];
      let chosen = null, best = Infinity;
      for (const page of pages) {
        const dx = Math.max(page.x - point.x, 0, point.x - page.x - page.w), dy = Math.max(page.y - point.y, 0, point.y - page.y - page.h);
        const distance = dx * dx + dy * dy;
        if (distance < best - 1e-10 || (Math.abs(distance - best) <= 1e-10 && page.id === this.viewPageId)) { chosen = page; best = distance; }
      }
      this.viewPageId = chosen?.id; return chosen || pages[0];
    }
    bounds(object) {
      const angle = (object.rotation || 0) * Math.PI / 180, cx = object.x + object.w / 2, cy = object.y + object.h / 2;
      const points = [[object.x, object.y], [object.x + object.w, object.y], [object.x, object.y + object.h], [object.x + object.w, object.y + object.h]].map(([x, y]) => ({ x: cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle), y: cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle) }));
      const xs = points.map(p => p.x), ys = points.map(p => p.y); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    syncPageMembership() {
      const pages = this.state.mode === 'paper' ? MW.documentModel.pageRects(this.state) : [];
      for (const object of this.state.objects.concat(this.state.regions || [])) {
        const b = this.bounds(object), page = pages.find(p => b.x >= p.x - 1e-8 && b.y >= p.y - 1e-8 && b.x + b.w <= p.x + p.w + 1e-8 && b.y + b.h <= p.y + p.h + 1e-8);
        object.pageId = page?.id || null;
      }
    }
    hasPaperOverflow() {
      if (this.state.mode !== 'paper') return false;
      const areas = MW.documentModel.pageRects(this.state).map(page => page.content);
      const inside = p => p && areas.some(r => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h);
      if (this.state.objects.some(object => { const b = this.bounds(object); return !areas.some(r => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h); })) return true;
      const st = this.adapter.struct();
      if ([...st.atoms.values()].some(atom => !inside(atom.pp))) return true;
      for (const arrow of this.mechanism.model.state.arrows) { const g = MW.model.arrowGeometry(arrow, this.mechanism.ctx()); if (Array.from({ length: 25 }, (_, i) => MW.model.quadPoint(g.start, g.control, g.end, i / 24)).some(p => !inside(p))) return true; }
      return false;
    }
    async exportPages(pageIds) { return this.buildPages(pageIds, true); }
    async previewPages(pageIds) { return this.buildPages(pageIds, false); }
    async buildPages(pageIds, commitText) {
      if (this.mechanism.nativePasteSession || this.win.molstudioClipboard?.nativePreviewActive) return { ok: false, error: '请先放置或取消正在粘贴的片段，再导出文档' };
      if (commitText && this.editor?.composing) return { ok: false, error: '请先完成输入法输入，再导出文档' };
      if (commitText) this.finishTextEdit();
      this.render();
      if (!this.active || this.state.mode !== 'paper') return { ok: false, error: '请先切换到纸页模式' };
      const source = this.adapter.canvasSvg(); if (!source) return { ok: false, error: '画布未就绪' };
      const bl = this.adapter.bondLength(), off = this.adapter.offset(), pages = [], warnings = [];
      const pageRects = MW.documentModel.pageRects(this.state);
      if (pageIds !== undefined && (!Array.isArray(pageIds) || pageIds.some(id => typeof id !== 'string' || !pageRects.some(p => p.id === id)))) return { ok: false, error: '页面列表无效' };
      const requested = pageIds === undefined ? pageRects : pageRects.filter(page => pageIds.includes(page.id));
      if (commitText) {
      const inPage = point => pageRects.some(p => point.x >= p.x && point.y >= p.y && point.x <= p.x + p.w && point.y <= p.y + p.h);
      for (const object of this.state.objects) { const b = this.bounds(object); if (!pageRects.some(p => b.x >= p.x && b.y >= p.y && b.x + b.w <= p.x + p.w && b.y + b.h <= p.y + p.h)) warnings.push('有文档对象位于纸页之外，超出部分不会打印'); }
      for (const ar of this.mechanism.model.state.arrows) { const g = MW.model.arrowGeometry(ar, this.mechanism.ctx()); if (Array.from({ length: 25 }, (_, i) => MW.model.quadPoint(g.start, g.control, g.end, i / 24)).some(p => !inPage(p))) { warnings.push('有电子流箭头位于纸页之外，超出部分不会打印'); break; } }
      const st = this.adapter.struct();
      for (const map of ['rxnArrows', 'rxnPluses', 'texts', 'simpleObjects', 'images']) for (const o of st[map]?.values() || []) { const points = o.getCornerPositions?.() || o.pos || [o.pp || o.position].filter(Boolean); if (points.some(p => !inPage(p))) { warnings.push('有原生标注或图像位于纸页之外，超出部分不会打印'); break; } }
      for (const point of [...this.adapter.struct().atoms.values()].map(a => a.pp)) if (!pageRects.some(p => point.x >= p.x && point.y >= p.y && point.x <= p.x + p.w && point.y <= p.y + p.h)) { warnings.push('有分子结构位于纸页之外，超出部分不会打印'); break; }
      }
      for (const page of requested) {
        const svg = MW.exporter.cloneContent(source);
        if (!commitText && this.editor) for (const node of svg.querySelectorAll('[data-doc-id]')) if (node.getAttribute('data-doc-id') === this.editor.id) node.removeAttribute('visibility');
        svg.querySelectorAll('[data-mech-ui="1"]').forEach(n => n.remove());
        svg.setAttribute('xmlns', NS); svg.setAttribute('width', this.state.page.width + 'pt'); svg.setAttribute('height', this.state.page.height + 'pt');
        svg.setAttribute('viewBox', `${page.x * bl + off.x} ${page.y * bl + off.y} ${page.w * bl} ${page.h * bl}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.style.cssText = 'background:white;display:block';
        const paper = this.doc.createElementNS(NS, 'rect');
        for (const [k, value] of Object.entries({ x: page.x * bl + off.x, y: page.y * bl + off.y, width: page.w * bl, height: page.h * bl, fill: '#ffffff' })) paper.setAttribute(k, value);
        svg.insertBefore(paper, svg.firstChild);
        pages.push({ id: page.id, widthPt: this.state.page.width, heightPt: this.state.page.height, svg: new this.win.XMLSerializer().serializeToString(svg) });
      }
      return { ok: true, pages, warnings: [...new Set(warnings)] };
    }
    export(options = {}) {
      if (this.editor?.composing) throw new Error('请先完成输入法输入，再保存文档');
      if (!options.preserveTextEditing) { this.finishTextEdit(); return this.active ? this.getState() : undefined; }
      if (!this.active) return undefined;
      // Native dirty tracking reads a snapshot every 1.5 seconds. Reading the
      // open draft must not blur its editor, create history, or end the session.
      const snapshot = this.getState(), current = this.editor;
      const object = current && snapshot.objects.find(o => o.id === current.id);
      if (object) {
        object.rich = this.readTextEditRich(current);
        object.h = Math.max(object.h, this.textHeight(object));
        const b = this.bounds(object), pages = snapshot.mode === 'paper' ? MW.documentModel.pageRects(snapshot) : [];
        object.pageId = pages.find(p => b.x >= p.x - 1e-8 && b.y >= p.y - 1e-8 && b.x + b.w <= p.x + p.w + 1e-8 && b.y + b.h <= p.y + p.h + 1e-8)?.id || null;
      }
      return snapshot;
    }
    capture() {
      return { document: this.getState(), active: this.active, mechanism: this.mechanism.model.cloneState(),
        nativeObjects: this.captureNativeObjects(), nativeSelection: clone(this.adapter.ed.selection?.() || {}),
        reactionSteps: MW.app?.reactionSteps?.captureRuntime?.(),
        // 缩放会沿键扩展到整个连通分量：快照必须覆盖全部受影响原子，撤销/重做才能完整还原
        coords: [...this.expandToComponents(new Set(this.selectedAtomIds()))].map(id => { const p = this.adapter.atomPos(id); return [id, p.x, p.y]; }) };
    }
    apply(snapshot) {
      this.active = snapshot.active; this.state = clone(snapshot.document);
      this.mechanism.model.setState(clone(snapshot.mechanism), 'history');
      this.setNativeObjects(snapshot.nativeObjects); this.setAtomCoords(snapshot.coords);
      if (snapshot.reactionSteps) MW.app?.reactionSteps?.restoreRuntime?.(snapshot.reactionSteps, false);
      this.prune(); this.clampPaperViewport(); this.render(); this.mechanism.render(); this.emit();
      this.adapter.syncVisualScalesFromDocument?.(this.state);
    }
    commit(before, label) {
      this.syncPageMembership();
      try { this.validate(this.state); } catch (e) { this.apply(before); throw e; }
      const after = this.capture();
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      this.adapter.pushAction(() => this.apply(before), () => this.apply(after));
      this.clampPaperViewport(); this.render(); this.emit(); this.onDirtyHint?.(); this.status(label || '已更新文档'); return true;
    }
    mutate(fn, label) {
      if (this.editor?.composing) throw new Error('请先完成输入法输入');
      this.finishTextEdit(); const before = this.capture(); this.active = true;
      try { fn(); return this.commit(before, label); } catch (e) { this.apply(before); this.status(e.message); throw e; }
    }
    status(text) { this.onStatus?.(text); }
    init(options) {
      this.mutate(() => { const next = MW.documentModel.createDocument({ mode: 'paper', ...options?.pageSetup, ...options });
        next.pages = next.pages.map((page, index) => this.state.pages[index] || page);
        next.objects = this.state.objects; next.assets = this.state.assets; next.regions = this.state.regions;
        for (const item of next.objects.concat(next.regions)) if (item.pageId && !next.pages.some(p => p.id === item.pageId)) delete item.pageId;
        this.state = next;
      }, '已设置页面');
      if (this.state.mode === 'paper') this.fitPage();
      return this.getState();
    }
    setPageSetup(options) {
      if (options?.pageCount < this.state.pageCount) throw new Error('减少页数请使用删除空白末页');
      const changed = this.mutate(() => {
        const next = MW.documentModel.createDocument({ ...this.state.page, mode: this.state.mode, ptPerBond: this.state.ptPerBond,
          pageCount: this.state.pageCount, ...options });
        next.pages = this.state.pages; next.objects = this.state.objects; next.assets = this.state.assets; next.regions = this.state.regions;
        if (options?.pageCount !== undefined) {
          next.pages = this.state.pages.slice(0, options.pageCount);
          while (next.pages.length < options.pageCount) next.pages.push({ id: uid('page') });
          next.pageCount = next.pages.length;
          for (const item of next.objects) if (item.pageId && !next.pages.some(p => p.id === item.pageId)) delete item.pageId;
        }
        this.state = next;
      }, '已更新页面设置');
      if (changed && this.hasPaperOverflow()) this.status('页面设置已更新；有内容超出页边距，可调整位置或新增页面');
      return changed;
    }
    addPage() { this.mutate(() => { this.state = MW.documentModel.addPage(this.state); }, '已新增一页'); return this.state.pages.at(-1).id; }
    removePage(id) {
      const pages = MW.documentModel.pageRects(this.state), page = pages.at(-1);
      if (id !== page.id || pages.length < 2) throw new Error('仅可删除空白末页');
      const hit = p => p && p.x >= page.x && p.x <= page.x + page.w && p.y >= page.y && p.y <= page.y + page.h;
      const st = this.adapter.struct(), ctx = this.mechanism.ctx();
      const nativeContent = ['rxnArrows', 'rxnPluses', 'texts', 'simpleObjects', 'images'].some(map => [...(st[map]?.values() || [])].some(o => (o.getCornerPositions?.() || o.pos || [o.pp || o.position].filter(Boolean)).some(hit)));
      if (this.state.objects.some(o => intersects(this.bounds(o), page)) || [...st.atoms.values()].some(a => hit(a.pp)) || nativeContent ||
          this.mechanism.model.state.lonePairs.some(lp => hit(MW.model.lonePairPosition(lp, ctx))) ||
          this.mechanism.model.state.arrows.some(ar => { const g = MW.model.arrowGeometry(ar, ctx); return Array.from({ length: 25 }, (_, i) => MW.model.quadPoint(g.start, g.control, g.end, i / 24)).some(hit); })) throw new Error('末页含有内容，请先移走或删除内容');
      return this.mutate(() => { this.state = MW.documentModel.removePage(this.state, id); }, '已删除空白末页');
    }
    object(id) { return this.state.objects.find(o => o.id === id); }
    addObject(object) {
      const item = { id: uid('obj'), band: object.kind === 'text' ? 'front' : 'back', x: 4, y: 4, w: 12, h: 3, rotation: 0, ...clone(object) };
      const page = MW.documentModel.pageAt(this.state, item); if (page) item.pageId = page.id;
      this.mutate(() => { this.state.objects.push(item); this.selection = new Set([item.id]); }, '已插入' + ({ text: '文字', shape: '形状', image: '图片', molecule3d: '3D 分子预览' }[item.kind] || '对象'));
      return item.id;
    }
    richTextLayout(object) {
      const rich = object.rich || {}, base = number(rich.fontSize, 12, 2, 300), fs = base / this.state.ptPerBond;
      let measure;
      // Large inline runs need their real glyph advances when wrapping. Keep
      // the existing ordinary-text metrics for documents without size changes.
      if (rich.runs?.some(run => Number.isFinite(run.fontSize) && run.fontSize !== base) && typeof this.win.CanvasRenderingContext2D === 'function') {
        const ctx = this.textMeasureContext || (this.textMeasureContext = this.doc.createElement('canvas').getContext('2d'));
        if (ctx) measure = (ch, seg) => {
          const size = number(seg?.fontSize, base, 2, 300), family = seg?.fontFamily || rich.fontFamily || 'Arial, PingFang SC, sans-serif';
          ctx.font = `${seg?.italic ? 'italic ' : ''}${seg?.bold ? '700 ' : ''}${size}px ${family}`;
          return ctx.measureText(ch).width / (size * .55);
        };
      }
      return MW.documentRichText.layoutLines(rich, object.w, fs, measure);
    }
    textLines(object) {
      const rich = object.rich || {}, fs = number(rich.fontSize, 12, 2, 300) / this.state.ptPerBond;
      if (rich.runs?.length && MW.documentRichText) {
        const layout = this.richTextLayout(object);
        return layout.lines.map(line => line.text);
      }
      const chars = Math.max(1, Math.floor(object.w / (fs * .55))), lines = [];
      for (const paragraph of String(rich.text || '').split('\n')) {
        if (!paragraph) { lines.push(''); continue; }
        let line = '', n = 0;
        for (const char of paragraph) { const units = /[^\x00-\xff]/.test(char) ? 2 : 1; if (n && n + units > chars) { lines.push(line); line = ''; n = 0; } line += char; n += units; }
        lines.push(line);
      }
      return lines;
    }
    textHeight(object) {
      const rich = object.rich || {}, fs = number(rich.fontSize, 12, 2, 300) / this.state.ptPerBond;
      if (rich.runs?.length && MW.documentRichText) return this.richTextLayout(object).heights;
      return fs + (this.textLines(object).length - 1) * fs * number(rich.lineHeight, 1.4, .5, 5) + fs * .3;
    }
    /* 编辑器/渲染共用的 pt → px 比例（跟随画布缩放）。 */
    editorPxPerPt() {
      const bl = this.adapter.bondLength?.() || this.state.ptPerBond, zoom = this.adapter.zoom?.() ?? 1;
      return bl * zoom / this.state.ptPerBond;
    }
    addText(options) {
      const o = options || {}, rich = { text: o.text ?? o.rich?.text ?? '双击编辑文字', fontFamily: 'Arial, PingFang SC, sans-serif', fontSize: 12, color: '#1c1c1e', lineHeight: 1.4, align: 'left', ...o.rich };
      for (const key of ['fontSize', 'fontFamily', 'color', 'bold', 'italic', 'align', 'lineHeight']) if (o[key] !== undefined) rich[key] = o[key];
      const object = { w: 12, h: 3, ...o, kind: 'text', rich }; object.h = Math.max(object.h, this.textHeight(object));
      return this.addObject(object);
    }
    setShapeStyle(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('形状默认样式无效');
      const previous = this.shapeStyle || { fill: 'none', fillColor: '#ffffff', stroke: { color: '#3b5665', width: 0.05, dash: 'solid' } };
      const next = { ...previous, ...clone(patch), stroke: { ...(previous.stroke || {}), ...(patch.stroke || {}) } };
      if (Object.prototype.hasOwnProperty.call(patch, 'fill') && patch.fill !== 'none' && !validShapeColor(patch.fill)) throw new Error('填充颜色请使用标准 HEX 或无填充');
      if (Object.prototype.hasOwnProperty.call(patch, 'fillColor') && !validShapeColor(patch.fillColor)) throw new Error('填充颜色请使用标准 HEX');
      if (patch.stroke && Object.prototype.hasOwnProperty.call(patch.stroke, 'color') && !validShapeColor(patch.stroke.color)) throw new Error('描边颜色请使用标准 HEX');
      if (patch.stroke && Object.prototype.hasOwnProperty.call(patch.stroke, 'width') && (!Number.isFinite(patch.stroke.width) || patch.stroke.width < 0.005 || patch.stroke.width > 5)) throw new Error('边框宽度应在有效范围内');
      if (patch.stroke && Object.prototype.hasOwnProperty.call(patch.stroke, 'dash') && !['solid', 'dashed'].includes(patch.stroke.dash)) throw new Error('线型无效');
      if (Object.prototype.hasOwnProperty.call(patch, 'cornerRadius') && (!Number.isFinite(patch.cornerRadius) || patch.cornerRadius < 0 || patch.cornerRadius > 100000)) throw new Error('圆角半径必须是有效的非负数字');
      this.shapeStyle = next;
      this.render(); this.emit('shape-style');
      return clone(next);
    }
    addShape(options) {
      const o = options || {}, style = this.shapeStyle || {};
      const shape = o.shape || 'rect';
      const defaults = {
        w: 8, h: 5, shape: 'rect', fill: style.fill || 'none', fillColor: style.fillColor || '#ffffff',
        stroke: clone(style.stroke || { color: '#3b5665', width: 0.05, dash: 'solid' }),
        ...(Number.isFinite(style.cornerRadius) ? { cornerRadius: style.cornerRadius } : {})
      };
      const object = { ...defaults, ...clone(o), kind: 'shape', stroke: { ...defaults.stroke, ...(o.stroke || {}) } };
      if (['line', 'arrow', 'bracket'].includes(shape)) {
        delete object.fill; delete object.fillColor;
      } else if (o.fill !== undefined && o.fill !== 'none' && o.fillColor === undefined) object.fillColor = o.fill;
      // Radius is a rounded-rectangle property. Other shapes ignore it even
      // when the previous drawing tool had a nonzero default radius.
      if (!['rect', 'roundRect'].includes(shape)) delete object.cornerRadius;
      else if (o.cornerRadius === undefined && !Number.isFinite(style.cornerRadius)) delete object.cornerRadius;
      return this.addObject(object);
    }
    async addImage(options) {
      const o = options || {}, match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(o.dataUrl || '');
      if (!match) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
      const id = uid('asset'); const item = { id: uid('obj'), kind: 'image', band: 'back', x: o.x ?? 4, y: o.y ?? 4, w: o.w ?? 12, h: o.h ?? 8, rotation: 0, asset: id, crop: { x: 0, y: 0, w: 1, h: 1 } };
      const replaced = o.replaceId ? this.object(o.replaceId) : null;
      if (o.replaceId && replaced?.kind !== 'image') throw new Error('被替换的图片不存在');
      this.mutate(() => {
        this.state.assets[id] = { mime: match[1], data: match[2].replace(/\s/g, '') };
        if (replaced) { const previousAsset = replaced.asset; replaced.asset = id; replaced.crop = item.crop;
          if (!this.state.objects.some(o => o.asset === previousAsset)) delete this.state.assets[previousAsset];
        } else this.state.objects.push(item);
        this.selection = new Set([replaced?.id || item.id]);
      }, replaced ? '已替换图片' : '已插入图片');
      return replaced?.id || item.id;
    }
    async insertImageFile(file, point, replaceId) {
      if (file.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MB 资源上限');
      const generation = this.generation;
      const reader = new this.win.FileReader();
      const url = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      const img = new this.win.Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
      let dataUrl = url;
      if (Math.max(img.naturalWidth, img.naturalHeight) > 2400) {
        const canvas = this.doc.createElement('canvas'), scale = 2400 / Math.max(img.naturalWidth, img.naturalHeight);
        canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height); dataUrl = canvas.toDataURL('image/png');
      }
      if (generation !== this.generation) throw new Error('文档已切换，未插入图片');
      return this.addImage({ dataUrl, ...point, replaceId, w: 12, h: 12 * img.naturalHeight / img.naturalWidth });
    }
    updateObject(id, patch) {
      if (!this.object(id)) return false;
      if ((patch.id !== undefined && patch.id !== id) || (patch.kind !== undefined && patch.kind !== this.object(id).kind)) throw new Error('对象身份和类型不能修改');
      return this.mutate(() => { const object = this.object(id); Object.assign(object, clone(patch)); if (object.kind === 'text') object.h = Math.max(object.h, this.textHeight(object)); }, '已更新对象');
    }
    prune() { this.selection = new Set([...this.selection].filter(id => this.object(id))); }
    /* 删除/替换对象后，清理不再被任何对象引用的图片与 3D 预览资源。 */
    pruneUnreferencedAssets() {
      const referenced = new Set();
      for (const o of this.state.objects) {
        if (o.kind === 'image' && o.asset) referenced.add(o.asset);
        if (o.kind === 'molecule3d' && o.previewAsset) referenced.add(o.previewAsset);
      }
      for (const key of Object.keys(this.state.assets)) if (!referenced.has(key)) delete this.state.assets[key];
    }
    select(ids, options) {
      this.finishTextEdit(); const additive = !!options?.additive;
      if (!additive) { this.selection.clear(); this.mechanism.selection.clear(); this.adapter.clearSelection(); }
      const native = this.adapter.ed.selection() || {}, atoms = new Set(native.atoms || []);
      for (const id of ids || []) {
        if (this.object(id)) this.selection.add(id);
        else if (this.mechanism.model.arrow(id) || this.mechanism.model.lonePair(id)) this.mechanism.selection.add(id);
        else { const rid = this.adapter.atomIdOf(id); if (rid !== null && rid !== undefined) atoms.add(rid); }
      }
      if (atoms.size) this.adapter.ed.selection({ ...native, atoms: [...atoms] });
      this.mechanism.emitSelection(); this.mechanism.render(); this.render(); this.emit(); return [...this.selection];
    }
    selectAll() { this.tool = 'select'; this.mechanism.selectAll(); this.selection = new Set(this.state.objects.map(o => o.id)); this.render(); this.emit(); return true; }
    selectInBox(box, additive) {
      const r = { x: Math.min(box.x1, box.x2), y: Math.min(box.y1, box.y2), w: Math.abs(box.x2 - box.x1), h: Math.abs(box.y2 - box.y1) };
      if (!additive) this.selection.clear();
      for (const item of this.state.objects) if (intersects(r, this.bounds(item))) this.selection.add(item.id);
      this.render(); this.emit();
    }
    selectedAtomIds() {
      const selection = this.adapter.ed.selection?.() || {}, ids = new Set(selection.atoms || []), st = this.adapter.struct();
      for (const bid of selection.bonds || []) { const b = st.bonds.get(bid); if (b) { ids.add(b.begin); ids.add(b.end); } }
      return [...ids].filter(id => st.atoms.has(id));
    }
    captureNativeObjects() {
      const selection = this.adapter.ed.selection?.() || {}, st = this.adapter.struct(), result = [];
      for (const map of ['rxnArrows', 'rxnPluses', 'texts', 'simpleObjects', 'images', 'multitailArrows']) {
        for (const id of selection[map] || []) { const item = st[map]?.get(id); if (item?.clone) result.push({ map, id, object: item.clone() }); }
      }
      return result;
    }
    setNativeObjects(entries) {
      const st = this.adapter.struct(), ctab = this.adapter.ed.render.ctab;
      for (const entry of entries || []) if (st[entry.map]?.has(entry.id)) { Object.assign(st[entry.map].get(entry.id), entry.object.clone()); ctab.markItem(entry.map, entry.id, 1); }
      if (entries?.length) this.adapter.ed.update(true);
    }
    translatedNativeObjects(entries, dx, dy) {
      if (!entries?.length) return [];
      const Vec = this.win.molstudioNativeStructOps.vec;
      return (entries || []).map(entry => {
        const object = entry.object.clone(), vector = new Vec(dx, dy);
        if (typeof object.addPositionOffset === 'function') object.addPositionOffset(vector);
        else {
          let moved = false;
          if (Array.isArray(object.pos)) { object.pos = object.pos.map(p => new Vec(p.x + dx, p.y + dy)); moved = true; }
          for (const key of ['pp', 'position']) if (object[key] && Number.isFinite(object[key].x)) { object[key] = new Vec(object[key].x + dx, object[key].y + dy); moved = true; }
          if (!moved) throw new Error('当前所选原生对象不能安全混合移动，请先取消该对象的选择');
        }
        return { ...entry, object };
      });
    }
    /* ---------------- 纸页实际尺寸缩放（分子 / 完整机理 / 反应步骤） ----------------
     * 坐标 bake 缩放（非视口 zoom）；锚点默认为选区中心；一个撤销动作一次缩放。 */
    expandToComponents(rids) {
      const st = this.adapter.struct();
      const out = new Set();
      const neighbors = new Map();
      for (const [, b] of st.bonds) {
        if (!st.atoms.has(b.begin) || !st.atoms.has(b.end)) continue;
        if (!neighbors.has(b.begin)) neighbors.set(b.begin, new Set());
        if (!neighbors.has(b.end)) neighbors.set(b.end, new Set());
        neighbors.get(b.begin).add(b.end); neighbors.get(b.end).add(b.begin);
      }
      for (const seed of rids || []) {
        if (out.has(seed) || !st.atoms.has(seed)) continue;
        const queue = [seed]; out.add(seed);
        while (queue.length) { const id = queue.pop(); for (const nb of neighbors.get(id) || []) if (!out.has(nb)) { out.add(nb); queue.push(nb); } }
      }
      return out;
    }
    selectionTargets() {
      const atoms = this.expandToComponents(new Set(this.selectedAtomIds()));
      const atomUuids = new Set([...atoms].map(id => this.adapter.uuidOfAtom(id)).filter(Boolean));
      const model = this.mechanism.model.state;
      const lonePairIds = model.lonePairs.filter(lp => atomUuids.has(lp.ownerAtomId)).map(lp => lp.id);
      const arrowIds = new Set(this.mechanism.selection);
      for (const ar of model.arrows) {
        if (arrowIds.has(ar.id)) continue;
        for (const ep of [ar.source, ar.target]) {
          if (MW.model.endpointAtomIds(ep).some(uuid => atomUuids.has(uuid))) { arrowIds.add(ar.id); break; }
        }
      }
      return { atoms: [...atoms], atomUuids: [...atomUuids], lonePairIds, arrowIds: [...arrowIds],
        nativeObjects: this.captureNativeObjects(), documentIds: [...this.selection] };
    }
    hasScaleTargets(targets) {
      const t = targets || this.selectionTargets();
      return t.atoms.length > 0 || t.lonePairIds.length > 0 || t.arrowIds.length > 0 || t.nativeObjects.length > 0 || t.documentIds.length > 0;
    }
    hasScaleSelection() {
      if (this.drag) return false;
      // 缩放语义是"纸面上的实际尺寸"，只在纸页文档模式提供；无边画布禁用。
      if (this.state.mode !== 'paper') return false;
      const t = this.selectionTargets();
      return t.atoms.length > 0 || t.lonePairIds.length > 0 || t.arrowIds.length > 0 || t.nativeObjects.length > 0;
    }
    selectionChemistryBounds(targets) {
      const t = targets || this.selectionTargets();
      const xs = [], ys = [];
      const push = p => { if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { xs.push(p.x); ys.push(p.y); } };
      for (const rid of t.atoms) push(this.adapter.atomPos(rid));
      for (const entry of t.nativeObjects || []) {
        for (const p of entry.object.getCornerPositions?.() || entry.object.pos || [entry.object.pp || entry.object.position].filter(Boolean)) push(p);
      }
      const ctx = this.mechanism.ctx?.();
      for (const id of t.arrowIds || []) { const ar = this.mechanism.model.arrow(id); if (ar) for (const ep of [ar.source, ar.target]) push(MW.model.endpointAnchor(ep, ctx)); }
      for (const id of t.documentIds || []) { const o = this.object(id); if (o) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); } }
      if (!xs.length) return null;
      const x1 = Math.min(...xs), y1 = Math.min(...ys);
      return { x: x1, y: y1, w: Math.max(...xs) - x1, h: Math.max(...ys) - y1 };
    }
    scaledNativeObjects(entries, factor, anchor) {
      if (!entries?.length) return [];
      const Vec = this.win.molstudioNativeStructOps?.vec;
      if (!Vec) throw new Error('当前环境缺少结构向量接口，无法缩放所选原生对象');
      const sp = p => ({ x: anchor.x + (p.x - anchor.x) * factor, y: anchor.y + (p.y - anchor.y) * factor });
      return entries.map(entry => {
        const object = entry.object.clone();
        let scaled = false;
        if (Array.isArray(object.pos) && object.pos.length) { object.pos = object.pos.map(p => { const q = sp(p); return new Vec(q.x, q.y); }); scaled = true; }
        for (const key of ['pp', 'position']) if (object[key] && Number.isFinite(object[key].x)) { const q = sp(object[key]); object[key] = new Vec(q.x, q.y); scaled = true; }
        if (!scaled) throw new Error('当前所选原生对象不能安全缩放，请先取消该对象的选择');
        return { ...entry, object };
      });
    }
    applyScaleSnapshot(before, factor, anchor, targets) {
      const t = targets || this.selectionTargets();
      const sp = p => ({ x: anchor.x + (p.x - anchor.x) * factor, y: anchor.y + (p.y - anchor.y) * factor });
      this.state = clone(before.document);
      if (!this.state.atomScales || typeof this.state.atomScales !== 'object') this.state.atomScales = {};
      for (const id of t.documentIds) {
        const o = this.object(id); if (!o) continue;
        const center = sp({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
        o.x = center.x - o.w * factor / 2; o.y = center.y - o.h * factor / 2; o.w *= factor; o.h *= factor;
        if (o.kind === 'text' && o.rich) o.rich = { ...o.rich, fontSize: Math.min(300, Math.max(2, (o.rich.fontSize || 12) * factor)) };
      }
      for (const uuid of t.atomUuids) {
        const next = (this.state.atomScales[uuid] || 1) * factor;
        if (Math.abs(next - 1) < 1e-9) delete this.state.atomScales[uuid];
        else this.state.atomScales[uuid] = next;
      }
      const mech = clone(before.mechanism);
      const uuidSet = new Set(t.atomUuids), arrowSet = new Set(t.arrowIds);
      for (const lp of mech.lonePairs) if (uuidSet.has(lp.ownerAtomId)) lp.radius = lp.radius * factor;
      for (const ar of mech.arrows) if (arrowSet.has(ar.id)) {
        for (const key of ['source', 'target']) {
          const ep = ar[key];
          if (ep?.type === 'free') { const q = sp(ep); ep.x = q.x; ep.y = q.y; }
          if (ep?.last) { const q = sp(ep.last); ep.last = { x: q.x, y: q.y }; }
        }
        ar.scale = (MW.model.finite(ar.scale) && ar.scale > 0 ? ar.scale : 1) * factor;
      }
      this.mechanism.model.setState(mech, 'silent');
      const nativeObjects = this.scaledNativeObjects(before.nativeObjects, factor, anchor);
      const reactionSteps = before.reactionSteps && MW.app?.reactionSteps?.scaleRuntime?.(before.reactionSteps, { factor, anchor, atomIds: t.atoms, nativeSelection: before.nativeSelection });
      this.setNativeObjects(nativeObjects);
      this.setAtomCoords(before.coords.map(([id, x, y]) => { const q = sp({ x, y }); return [id, q.x, q.y]; }));
      if (reactionSteps) MW.app.reactionSteps.restoreRuntime(reactionSteps, false);
      for (const uuid of t.atomUuids) this.adapter.setAtomVisualScale?.(uuid, this.state.atomScales[uuid] || 1);
      this.adapter.applyVisualScales?.();
      this.render(); this.mechanism.render();
    }
    scaleSelection(factor, options) {
      if (!Number.isFinite(factor) || factor <= 0) throw new Error('缩放比例无效');
      if (this.state.mode !== 'paper') throw new Error('选区缩放仅在纸页模式可用');
      const targets = this.selectionTargets();
      if (!this.hasScaleTargets(targets)) throw new Error('请先选择要缩放的化学内容');
      const bounds = this.selectionChemistryBounds(targets);
      if (!bounds) throw new Error('请先选择要缩放的化学内容');
      const anchor = options?.anchor && Number.isFinite(options.anchor.x) && Number.isFinite(options.anchor.y)
        ? { ...options.anchor } : { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
      const before = this.capture(); this.active = true;
      try { this.applyScaleSnapshot(before, factor, anchor, targets); }
      catch (error) { this.apply(before); throw error; }
      return this.commit(before, '已缩放所选内容');
    }
    /* 百分比会话：面板打开时确定基准；每次确认应用「目标% / 当前会话值」的增量，不累乘。 */
    beginScaleSession() {
      if (this.scaleSession) return true; // 幂等：工具条按钮与内联输入共用会话
      if (this.state.mode !== 'paper') throw new Error('选区缩放仅在纸页模式可用');
      const targets = this.selectionTargets();
      if (!this.hasScaleTargets(targets)) throw new Error('请先选择要缩放的化学内容');
      const bounds = this.selectionChemistryBounds(targets);
      if (!bounds) throw new Error('请先选择要缩放的化学内容');
      this.scaleSession = { targets, applied: 1, anchor: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 } };
      return true;
    }
    applyScalePercent(percent) {
      if (!this.scaleSession) this.beginScaleSession();
      if (!Number.isFinite(percent) || percent <= 0) throw new Error('缩放百分比无效');
      const factor = percent / 100 / this.scaleSession.applied;
      if (!Number.isFinite(factor) || factor <= 0) throw new Error('缩放百分比无效');
      const before = this.capture(); this.active = true;
      try {
        this.applyScaleSnapshot(before, factor, this.scaleSession.anchor, this.scaleSession.targets);
        this.scaleSession.applied = percent / 100;
      } catch (error) { this.apply(before); throw error; }
      return this.commit(before, '已缩放所选内容');
    }
    currentSessionPercent() { return this.scaleSession ? this.scaleSession.applied * 100 : null; }
    endScaleSession() { this.scaleSession = null; }
    /* 悬浮工具条缩放按钮的开关：开启需要纸页模式且当前选区可缩放；关闭同时结束百分比会话。 */
    setScaleMode(on) {
      if (on) {
        if (this.state.mode !== 'paper' || !this.hasScaleSelection()) return false;
        this.scaleMode = true;
      } else {
        this.scaleMode = false;
        this.endScaleSession();
      }
      this.render(); this.emit(); return this.scaleMode;
    }
    deleteNativeMixed() {
      const mech = this.mechanism, ed = this.adapter.ed;
      if (!mech.selection.size) {
        const sequence = ++mech.nativePasteSequence, token = 'native-delete-' + sequence;
        mech.pendingNativeCuts.set(token, { ids: [], documentIds: [...this.selection], stepRuntime: MW.app?.reactionSteps?.captureRuntime?.(), sequence, token, consumed: false });
        ed.molstudioClipboardCutToken = token;
        setTimeout(() => { if (ed.molstudioClipboardCutToken === token) delete ed.molstudioClipboardCutToken; mech.pendingNativeCuts.delete(token); }, 0);
      }
      this.nativeDeleteBypass = true;
      try {
        const target = this.doc.activeElement || this.doc.body;
        target.dispatchEvent(new this.win.KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }));
      } finally { this.nativeDeleteBypass = false; }
      return true;
    }
    setAtomCoords(entries) {
      const st = this.adapter.struct(), ctab = this.adapter.ed.render.ctab;
      for (const [id, x, y] of entries || []) { const atom = st.atoms.get(id); if (atom?.pp) { atom.pp.x = x; atom.pp.y = y; ctab.markAtom?.(id, 1); } }
      if (entries?.length) { for (const [id] of st.bonds) ctab.markBond?.(id, 1); this.adapter.ed.update(true); }
    }
    translateSnapshot(before, dx, dy) {
      const nativeObjects = this.translatedNativeObjects(before.nativeObjects, dx, dy);
      const reactionSteps = before.reactionSteps && MW.app?.reactionSteps?.translateRuntime?.(before.reactionSteps, { dx, dy, atomIds: before.coords.map(([id]) => id), nativeSelection: before.nativeSelection });
      this.state = clone(before.document);
      for (const object of this.state.objects) if (this.selection.has(object.id)) { object.x += dx; object.y += dy; }
      const mech = clone(before.mechanism), atomUuids = new Set(before.coords.map(([id]) => this.adapter.uuidOfAtom(id)));
      for (const ar of mech.arrows) if (this.mechanism.selection.has(ar.id)) {
        for (const key of ['source', 'target']) if (ar[key]?.type === 'free') { ar[key].x += dx; ar[key].y += dy; }
        if (ar.geometry?.control) { ar.geometry.control.x += dx; ar.geometry.control.y += dy; }
      }
      this.mechanism.model.setState(mech, 'silent');
      this.setNativeObjects(nativeObjects);
      this.setAtomCoords(before.coords.map(([id, x, y]) => [id, x + dx, y + dy]));
      if (reactionSteps) MW.app.reactionSteps.restoreRuntime(reactionSteps, false);
      this.render(); this.mechanism.render();
    }
    moveSelection(dx, dy) {
      if (![dx, dy].every(Number.isFinite)) throw new Error('移动坐标无效');
      const before = this.capture(); this.translateSnapshot(before, dx, dy); return this.commit(before, '已移动所选内容');
    }
    deleteSelection() {
      this.finishTextEdit(); const before = this.capture(), selected = new Set(this.selection), st = this.adapter.struct(), ed = this.adapter.ed;
      const nativeSelection = ed.selection() || {};
      if (Object.entries(nativeSelection).some(([key, value]) => !['atoms', 'bonds', 'enhancedFlags'].includes(key) && Array.isArray(value) && value.length)) return this.deleteNativeMixed();
      const rids = new Set(nativeSelection.atoms || []), bids = new Set(nativeSelection.bonds || []);
      for (const [id, b] of st.bonds) if (rids.has(b.begin) || rids.has(b.end)) bids.add(id);
      const so = this.win.molstudioNativeStructOps, inverses = [];
      const mechIds = new Set(this.mechanism.selection);
      const removedAtoms = new Set([...rids].map(id => this.adapter.uuidOfAtom(id)));
      const removedBonds = new Set([...bids].map(id => this.adapter.uuidOfBond(id)));
      for (const lp of this.mechanism.model.state.lonePairs) if (removedAtoms.has(lp.ownerAtomId)) mechIds.add(lp.id);
      for (const ar of this.mechanism.model.state.arrows) for (const ep of [ar.source, ar.target]) {
        if (removedAtoms.has(ep.atomId) || removedAtoms.has(ep.ownerAtomId) || removedBonds.has(ep.bondId) || mechIds.has(ep.slotId)) mechIds.add(ar.id);
      }
      if (!selected.size && !mechIds.size && !rids.size && !bids.size) return false;
      try {
        if ((rids.size || bids.size) && !so) throw new Error('结构编辑接口未就绪');
        const fragments = new Set([...rids].map(id => st.atoms.get(id)?.fragment));
        for (const id of bids) if (st.bonds.has(id)) inverses.push(new so.bondDelete(id).perform(ed.render.ctab));
        for (const id of rids) if (st.atoms.has(id)) inverses.push(new so.atomDelete(id).perform(ed.render.ctab));
        for (const fragment of fragments) if (st.frags.has(fragment)) inverses.push(so.repartitionFragment(ed.render.ctab, fragment));
        so?.recalc(st);
        this.state.objects = this.state.objects.filter(o => !selected.has(o.id));
        this.pruneUnreferencedAssets();
        for (const id of mechIds) if (!this.mechanism.model.removeArrow(id)) this.mechanism.model.removeLonePair(id);
        const after = this.capture(); this.selection.clear(); this.mechanism.selection.clear(); this.adapter.clearSelection();
        if (inverses.length) {
          const self = this;
          const make = (operations, target, opposite) => ({ operations, isDummy: () => false, perform(ctab) {
            const inverse = []; for (let i = operations.length - 1; i >= 0; i--) inverse.push(operations[i].perform(ctab));
            so.recalc(ctab.molecule); self.apply({ ...target, coords: [] }); return make(inverse, opposite, target);
          } });
          ed.update(make(inverses, before, after));
        } else this.commit(before, '已删除所选内容');
        this.onDirtyHint?.(); this.adapter.schedule('struct'); this.mechanism.emitSelection(); this.mechanism.render(); this.render(); this.emit(); return true;
      } catch (error) {
        for (let i = inverses.length - 1; i >= 0; i--) inverses[i].perform(ed.render.ctab);
        this.apply(before); throw error;
      }
    }
    duplicateSelection() {
      const before = this.capture(), ids = [];
      for (const o of before.document.objects) if (this.selection.has(o.id)) { const item = { ...clone(o), id: uid('obj'), x: o.x + 1, y: o.y + 1 }; this.state.objects.push(item); ids.push(item.id); }
      this.selection = new Set(ids); this.commit(before, '已复制文档对象'); return ids;
    }
    /* ---------------- molecule3d 文档对象 ---------------- */
    addMolecule3D(payload) {
      const o3 = MW.documentObject3D; if (!o3) throw new Error('3D 分子预览模块未加载');
      const src = payload || {};
      const obj = o3.createObject(src);
      const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof src.previewDataUrl === 'string' ? src.previewDataUrl : '');
      if (src.previewDataUrl && !match) throw new Error('3D 预览图数据无效');
      const assetId = match ? uid('asset') : null;
      const at = src.at && [src.at.x, src.at.y].every(Number.isFinite) ? src.at : null;
      const item = { ...obj, id: uid('obj'),
        ...(assetId ? { previewAsset: assetId } : {}),
        ...(Array.isArray(src.atomUuids) && src.atomUuids.length ? { source: { atomUuids: [...src.atomUuids] } } : {}) };
      if (at) { item.x = at.x - item.w / 2; item.y = at.y - item.h / 2; }
      this.mutate(() => {
        if (assetId) this.state.assets[assetId] = { mime: 'image/png', data: match[2].replace(/\s/g, '') };
        const page = MW.documentModel.pageAt(this.state, item); if (page) item.pageId = page.id;
        this.state.objects.push(item); this.selection = new Set([item.id]);
      }, '已插入3D 分子预览');
      return item.id;
    }
    /* 化学选区 → 候选分子（按连通分量分组）。 */
    molecule3DCandidates() {
      const targets = this.selectionTargets();
      if (!targets.atoms.length) return [];
      const st = this.adapter.struct(), selected = new Set(targets.atoms);
      const neighbors = new Map();
      for (const [, b] of st.bonds) {
        if (!selected.has(b.begin) || !selected.has(b.end)) continue;
        if (!neighbors.has(b.begin)) neighbors.set(b.begin, new Set());
        if (!neighbors.has(b.end)) neighbors.set(b.end, new Set());
        neighbors.get(b.begin).add(b.end); neighbors.get(b.end).add(b.begin);
      }
      const seen = new Set(), groups = [];
      for (const seed of targets.atoms) {
        if (seen.has(seed)) continue;
        const component = [], queue = [seed]; seen.add(seed);
        while (queue.length) { const id = queue.pop(); component.push(id); for (const nb of neighbors.get(id) || []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); } }
        groups.push(component);
      }
      return groups.map(ids => ({ size: ids.length, atomUuids: ids.map(id => this.adapter.uuidOfAtom(id)).filter(Boolean) }))
        .filter(candidate => candidate.atomUuids.length);
    }
    locateMolecule3DKeys(ket, bindings, atomUuids) {
      const wanted = new Set(atomUuids), hit = new Set();
      for (const entry of bindings?.atoms || []) if (entry?.mol !== undefined && wanted.has(entry.id)) hit.add(entry.mol);
      const keys = [...hit].filter(key => ket[key]?.type === 'molecule');
      return keys.length ? keys : Object.keys(ket || {}).filter(key => ket[key]?.type === 'molecule');
    }
    assembleMolecule3DNotes(result) {
      const notes = {};
      if (result.stereoExample === true || result.stereo?.example === true) notes.stereoExample = true;
      if (Array.isArray(result.warnings) && result.warnings.length) notes.warnings = result.warnings.map(String);
      if (Array.isArray(result.notes) && result.notes.length) notes.notes = result.notes.map(String);
      const geometryNote = typeof result.geometry === 'string' ? result.geometry : typeof result.geometry?.note === 'string' ? result.geometry.note : null;
      if (geometryNote) notes.geometryNote = geometryNote;
      if (typeof result.sourceSummary === 'string' && result.sourceSummary) notes.sourceSummary = result.sourceSummary;
      else if (typeof result.identity === 'string' && result.identity) notes.sourceSummary = result.identity;
      else if (typeof result.smiles === 'string' && result.smiles) notes.sourceSummary = 'SMILES: ' + result.smiles;
      return notes;
    }
    /* 共享生成链路：KET 定位 → generate3D（409 立体确认钩子）→ 离屏快照。
     * 返回 { molblock, previewDataUrl, camera, notes, atomUuids, cancelled?, error? }。 */
    async generateMolecule3D(atomUuids, generation, options = {}) {
      const o3 = MW.documentObject3D;
      const abort = new AbortController();
      const stale = result => {
        if (generation === undefined || generation === this.generation) return false;
        abort.abort(); if (result) { result.cancelled = true; result.error = result.error || '文档已切换，未插入 3D 预览'; }
        return true;
      };
      if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
      const ex = await this.adapter.exportKetWithBindings();
      if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
      if (!ex?.ok) return { ok: false, error: ex?.error || '无法导出当前画布结构' };
      const keys = this.locateMolecule3DKeys(ex.ket, ex.bindings, atomUuids);
      if (!keys.length) return { ok: false, error: '无法在导出结构中定位所选分子' };
      const ketText = typeof ex.ketText === 'string' && ex.ketText ? ex.ketText : JSON.stringify(ex.ket);
      let result = await o3.generate3D({ ket: ketText, keys, allowExample: false }, { signal: abort.signal });
      if (!result.ok && result.code === 'stereo_choice_required') {
        const allowExample = this.onStereoChoiceRequired ? await this.onStereoChoiceRequired(result.stereo) : false;
        if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
        if (!allowExample) return { ok: false, cancelled: true };
        result = await o3.generate3D({ ket: ketText, keys, allowExample }, { signal: abort.signal });
      }
      if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
      if (!result.ok) return { ok: false, error: result.message || '3D 结构生成失败' };
      const payload = { molfile: result.molblock, style: options.style || 'ballstick', camera: options.camera,
        notes: this.assembleMolecule3DNotes(result), atomUuids: [...atomUuids] };
      if (options.preview) {
        if (!this.onPreviewMolecule3D) return { ok: false, error: '3D 预览面板尚未就绪' };
        const confirmed = await this.onPreviewMolecule3D(payload, { generation });
        if (stale()) return { ok: false, cancelled: true };
        if (!confirmed?.ok) return confirmed || { ok: false, cancelled: true };
        return { ...payload, ...confirmed, molblock: result.molblock };
      }
      // 离屏 host 必须建在顶层文档：InteractionSession 在顶层窗口监听 k3d-embed-result，
      // threed.html 校验 event.source === window.parent；建在画布 iframe 文档会让 parent
      // 变成画布 iframe 窗口，握手被全部拒收。fixed 定位移出视口，不拦截事件。
      // this.win 是画布 iframe 的 window，顶层文档经 window.top 取（与 document-ui 同源）。
      const topWin = this.win.top && this.win.top.document ? this.win.top : this.win;
      const host = topWin.document.createElement('div');
      host.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:480px;pointer-events:none;';
      topWin.document.body.appendChild(host);
      let session = null;
      try {
        session = new o3.InteractionSession({ host, serverBase: this.threedBase || '', molblock: result.molblock, style: payload.style, camera: payload.camera, onError() {} });
        await session.mount();
        if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
        const width = Number.isFinite(options.snapshotWidth) && options.snapshotWidth > 0 ? Math.round(options.snapshotWidth) : 640;
        const height = Number.isFinite(options.snapshotHeight) && options.snapshotHeight > 0 ? Math.round(options.snapshotHeight) : 480;
        const previewDataUrl = await session.snapshot({ width, height, trim: true });
        const camera = await session.cameraJson();
        if (stale()) return { ok: false, cancelled: true, error: '文档已切换，未插入 3D 预览' };
        return { ...payload, ok: true, molblock: result.molblock, previewDataUrl, camera };
      } finally { try { session?.dispose(); } catch (e) { /* ignore */ } host.remove(); }
    }
    async insertMolecule3DPreview(options = {}) {
      if (this.state.mode !== 'paper') throw new Error('3D 分子预览仅在纸页模式可用');
      const o3 = MW.documentObject3D; if (!o3) throw new Error('3D 分子预览模块未加载');
      if (this.pendingMolecule3DInsert) return { ok: false, cancelled: true };
      const request = {}; this.pendingMolecule3DInsert = request;
      const generation = this.generation;
      const cancelled = () => generation !== this.generation || this.state.mode !== 'paper';
      try {
        const candidates = this.molecule3DCandidates();
        if (!candidates.length) throw new Error('请先选择要生成 3D 预览的完整分子');
        let target = candidates[0];
        if (candidates.length > 1) {
          if (!this.onChooseMolecule3DTarget) throw new Error('请选择其中一个分子');
          target = await this.onChooseMolecule3DTarget(candidates);
          if (!target || cancelled()) return { ok: false, cancelled: true };
        }
        const generated = await this.generateMolecule3D(target.atomUuids, generation, { preview: true });
        if (cancelled()) return { ok: false, cancelled: true };
        if (!generated.ok) return { ok: false, ...(generated.cancelled ? { cancelled: true } : {}), error: generated.error };
        const id = this.addMolecule3D({ molfile: generated.molblock, style: generated.style || 'ballstick', camera: generated.camera || undefined,
          previewDataUrl: generated.previewDataUrl, atomUuids: generated.atomUuids, notes: generated.notes,
          ...(options.at ? { at: options.at } : {}) });
        return { ok: true, id };
      } finally {
        if (this.pendingMolecule3DInsert === request) this.pendingMolecule3DInsert = null;
      }
    }
    finishMolecule3DInteraction(id, options = {}) {
      const o = this.object(id); if (!o || o.kind !== 'molecule3d') throw new Error('3D 分子对象不存在');
      const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof options.previewDataUrl === 'string' ? options.previewDataUrl : '');
      if (options.previewDataUrl && !match) throw new Error('3D 预览图数据无效');
      const cam = options.camera ? MW.documentObject3D.normalizeCamera(options.camera) : null;
      if (options.camera && (!cam || cam.distance <= 0)) throw new Error('相机数据无效');
      if (options.style && !MW.documentObject3D.STYLES.includes(options.style)) throw new Error('3D 样式无效');
      const newAssetId = match ? uid('asset') : null;
      this.mutate(() => {
        if (newAssetId) this.state.assets[newAssetId] = { mime: 'image/png', data: match[2].replace(/\s/g, '') };
        const previous = o.previewAsset;
        if (newAssetId) o.previewAsset = newAssetId;
        if (cam) o.camera = cam;
        if (options.style) o.style = options.style;
        if (previous && previous !== o.previewAsset) {
          const stillUsed = this.state.objects.some(other => other !== o && (other.previewAsset === previous || other.asset === previous));
          if (!stillUsed) delete this.state.assets[previous];
        }
      }, '已更新 3D 预览');
      return true;
    }
    async updateMolecule3DFromSource(id) {
      const o = this.object(id); if (!o || o.kind !== 'molecule3d') throw new Error('3D 分子对象不存在');
      const uuids = Array.isArray(o.source?.atomUuids) ? o.source.atomUuids : [];
      if (!uuids.length) throw new Error('该对象没有源结构信息，无法更新');
      const st = this.adapter.struct();
      const missing = uuids.some(u => { const rid = this.adapter.atomIdOf(u); return rid === null || rid === undefined || !st.atoms.has(rid); });
      if (missing) throw new Error('源结构已删除或不完整，无法更新');
      const generation = this.generation;
      const signature = obj => JSON.stringify([obj.molfile, obj.source, obj.style, obj.camera, obj.previewAsset]);
      const previousSignature = signature(o);
      const generated = await this.generateMolecule3D(uuids, generation, { style: o.style, camera: o.camera, snapshotWidth: 640, snapshotHeight: Math.round(640 * o.h / o.w) });
      if (!generated.ok) throw new Error(generated.error || (generated.cancelled ? '已取消更新 3D 预览' : '3D 结构生成失败'));
      const current = this.object(id);
      if (generation !== this.generation || !current || current.kind !== 'molecule3d' || signature(current) !== previousSignature) {
        throw new Error('文档或 3D 对象已变化，未覆盖当前预览');
      }
      const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof generated.previewDataUrl === 'string' ? generated.previewDataUrl : '');
      const newAssetId = match ? uid('asset') : null;
      this.mutate(() => {
        if (newAssetId) this.state.assets[newAssetId] = { mime: 'image/png', data: match[2].replace(/\s/g, '') };
        const previous = current.previewAsset;
        if (newAssetId) current.previewAsset = newAssetId;
        current.molfile = generated.molblock; current.notes = generated.notes || {};
        if (generated.camera) current.camera = generated.camera;
        if (generated.style) current.style = generated.style;
        if (previous && previous !== current.previewAsset) {
          const stillUsed = this.state.objects.some(other => other !== current && (other.previewAsset === previous || other.asset === previous));
          if (!stillUsed) delete this.state.assets[previous];
        }
      }, '已更新 3D 预览');
      return true;
    }
    /* 选中文档对象按选区整体 bbox 对齐（一个撤销）。 */
    alignSelection(mode) {
      if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) throw new Error('对齐方式无效');
      const objects = [...this.selection].map(id => this.object(id)).filter(Boolean);
      if (!objects.length) throw new Error('请先选择要对齐的文档对象');
      const before = this.capture();
      const x1 = Math.min(...objects.map(o => o.x)), y1 = Math.min(...objects.map(o => o.y));
      const x2 = Math.max(...objects.map(o => o.x + o.w)), y2 = Math.max(...objects.map(o => o.y + o.h));
      this.mutate(() => {
        for (const o of objects) {
          if (mode === 'left') o.x = x1; else if (mode === 'right') o.x = x2 - o.w; else if (mode === 'center') o.x = (x1 + x2) / 2 - o.w / 2;
          else if (mode === 'top') o.y = y1; else if (mode === 'bottom') o.y = y2 - o.h; else o.y = (y1 + y2) / 2 - o.h / 2;
        }
      }, '已对齐所选对象');
      return true;
    }
    async importFile(file, options = {}) {
      const generation = this.generation, request = (this.importSequence || 0) + 1; this.importSequence = request;
      let stagedToken = null;
      try {
        if (this.editor?.composing) throw new Error('请先完成输入法输入，再插入文件');
        const name = typeof file === 'string' ? (options.name || '插入文件') : file?.name || options.name || '插入文件';
        const text = typeof file === 'string' ? file : typeof file?.text === 'function' ? await file.text() : file?.text ?? file?.content;
        if (request !== this.importSequence) return { ok: false, cancelled: true, error: '已有更新的插入请求' };
        if (generation !== this.generation) throw new Error('文档已切换，未插入文件');
        if (typeof text !== 'string') throw new Error('无法读取插入文件');
        let input; try { input = JSON.parse(text); } catch (_) { throw new Error('请选择有效的 .molwork 或 .ket 文件'); }
        const isWorkbench = input?.format === 'molstudio-workbench';
        const parsed = MW.storage.parseWorkbench(isWorkbench ? text : MW.storage.serializeWorkbench({ ket: input, mechanism: MW.model.emptyState() }));
        if (!parsed.ok) throw new Error(parsed.error);
        const source = parsed.doc, carrier = MW.documentClipboard.fromWorkbench(source, { includeMechanismSteps: isWorkbench });
        if (source.reactionSteps?.length) {
          const bridge = MW.app?.reactionSteps;
          if (!bridge?.prepareClipboardImport || !bridge?.appendClipboard) throw new Error('反应步骤导入模块尚未就绪');
          carrier.reactionSteps = bridge.prepareClipboardImport(source);
        }
        const native = this.win.molstudioNativeActions, fragment = MW.documentClipboard.prepareNativeFragment(native, source.ket);
        const nativeContent = !fragment.isBlank();
        if (!nativeContent && !carrier.arrows.length && !carrier.document?.objects.length) throw new Error('文件没有可插入内容');
        this.finishTextEdit(); this.adapter.ed.tool('select'); this.mechanism.cancelDraft(); this.mechanism.cancelNativePaste();
        const counts = { atoms: carrier.identity?.atoms.length || 0, arrows: carrier.arrows.length, objects: carrier.document?.objects.length || 0, steps: carrier.reactionSteps?.steps.length || 0 };
        if (!nativeContent) {
          carrier.native = false; delete carrier.nativeOnly;
          // Returning focus from the host file picker can synchronously blur the
          // iframe window. Finish that transition before creating its draft.
          this.iframe.focus?.(); this.adapter.ed.focusCliparea?.();
          if (!this.mechanism.beginPasteText(JSON.stringify(carrier))) throw new Error(this.mechanism.lastStatusText || '无法预览导入内容');
          if (options.at) { this.mechanism.finishPastePreview(options.at); return { ok: true, staged: false, name, counts }; }
          return { ok: true, staged: true, name, counts };
        }
        const token = this.mechanism.stageNativePaste(JSON.stringify(carrier));
        if (!token) throw new Error(this.mechanism.lastStatusText || '无法预览导入内容');
        stagedToken = token;
        fragment.molstudioClipboardToken = token; fragment.molstudioClipboardScale = 1;
        if (options.at) {
          if (![options.at.x, options.at.y].every(Number.isFinite)) throw new Error('插入位置无效');
          const result = native.paste(this.adapter.ed.render.ctab, fragment, options.at), action = result[0];
          if (!result[3]) { action.perform(this.adapter.ed.render.ctab); this.mechanism.cancelNativePaste(); throw new Error('当前原生构建缺少插入坐标回执'); }
          this.mechanism.startNativePaste(result[3]); this.adapter.ed.update(action); this.mechanism.commitNativePaste(action, token);
          const committed = this.mechanism.lastNativePasteResult;
          if (!committed?.ok || committed.token !== token) throw new Error(committed?.error || '插入内容未能完整提交');
          return { ok: true, staged: false, token, name, counts };
        }
        this.adapter.ed.tool('paste', fragment);
        this.iframe.focus?.(); this.adapter.ed.focusCliparea?.();
        this.status('移动鼠标放置 ' + name + '，点击确认，Esc 取消');
        return { ok: true, staged: true, token, name, counts };
      } catch (error) {
        if (stagedToken && this.mechanism.nativePasteToken() === stagedToken) { this.adapter.ed.tool('select'); this.mechanism.cancelNativePaste(); }
        this.status('插入失败：' + error.message); return { ok: false, error: error.message };
      }
    }
    clipboardFragment() {
      const objects = this.state.objects.filter(o => this.selection.has(o.id)).map(clone);
      const assets = {};
      for (const o of objects) { delete o.pageId;
        if (o.kind === 'image' && this.state.assets[o.asset]) assets[o.asset] = clone(this.state.assets[o.asset]);
        if (o.kind === 'molecule3d' && o.previewAsset && this.state.assets[o.previewAsset]) assets[o.previewAsset] = clone(this.state.assets[o.previewAsset]); }
      return objects.length ? { objects, assets } : null;
    }
    prepareFragment(fragment) {
      if (!fragment?.objects?.length) return null;
      const doc = MW.documentModel.createDocument(); doc.objects = clone(fragment.objects); doc.assets = clone(fragment.assets || {});
      this.validate(doc);
      // 默认复用源资产 id：appendFragment 以 Object.assign 合并，同源粘贴天然幂等，不再逐次复制字节。
      // 仅当目标文档已存在同 id 但内容不同的资产时，才回退到新 id 并重映射引用。
      const assets = {}, assetIds = new Map();
      for (const [id, value] of Object.entries(doc.assets)) {
        const existing = this.state.assets[id];
        if (!existing || (existing.mime === value.mime && existing.data === value.data)) assetIds.set(id, id);
        else assetIds.set(id, uid('asset'));
        assets[assetIds.get(id)] = value;
      }
      const objects = doc.objects.map(o => { const next = { ...o, id: uid('obj') }; delete next.pageId;
        if (next.asset) next.asset = assetIds.get(next.asset);
        if (next.previewAsset) next.previewAsset = assetIds.get(next.previewAsset); return next; });
      return { sourceObjects: objects, objects: clone(objects), assets };
    }
    remapFragmentSources(fragment, atomMap) {
      if (!fragment || !atomMap?.has || !atomMap?.get) return;
      // A copied preview follows copied chemistry only when its complete source
      // is present. Preview-only and partial-source copies keep the old link.
      for (const objects of [fragment.sourceObjects, fragment.objects]) for (const object of objects || []) {
        const ids = object.kind === 'molecule3d' ? object.source?.atomUuids : null;
        if (Array.isArray(ids) && ids.length && ids.every(id => atomMap.has(id))) {
          object.source = { ...object.source, atomUuids: ids.map(id => atomMap.get(id)) };
        }
      }
    }
    transformFragment(fragment, meta) {
      if (!fragment) return;
      const scale = meta.scale ?? 1, rotation = meta.rotation || 0, origin = meta.origin || { x: 0, y: 0 }, target = meta.target || meta.offset || { x: 0, y: 0 };
      const transform = p => { const x = p.x * scale - origin.x, y = p.y * scale - origin.y; return { x: x * Math.cos(rotation) - y * Math.sin(rotation) + target.x, y: x * Math.sin(rotation) + y * Math.cos(rotation) + target.y }; };
      fragment.objects = fragment.sourceObjects.map(o => { const center = transform({ x: o.x + o.w / 2, y: o.y + o.h / 2 }); return { ...clone(o), x: center.x - o.w * scale / 2, y: center.y - o.h * scale / 2, w: o.w * scale, h: o.h * scale, rotation: (o.rotation || 0) + rotation * 180 / Math.PI }; });
      this.preview = fragment.objects; this.previewAssets = fragment.assets; this.render();
    }
    clearFragmentPreview() { this.preview = null; this.previewAssets = null; this.render(); }
    appendFragment(fragment) {
      if (!fragment) return;
      this.active = true; Object.assign(this.state.assets, clone(fragment.assets));
      for (const item of fragment.objects) { const o = clone(item), page = MW.documentModel.pageAt(this.state, o); if (page) o.pageId = page.id; this.state.objects.push(o); }
      this.selection = new Set(fragment.objects.map(o => o.id)); this.clearFragmentPreview();
    }
    pasteFragment(fragment, arrows, lonePairs, mechanismSteps) {
      const before = this.capture(); this.appendFragment(fragment);
      for (const step of mechanismSteps || []) this.mechanism.model.state.steps.push(clone(step));
      for (const lp of lonePairs || []) this.mechanism.model.addLonePair(clone(lp));
      for (const ar of arrows || []) this.mechanism.model.addArrow(clone(ar));
      this.mechanism.selection = new Set((arrows || []).map(ar => ar.id).concat((lonePairs || []).map(lp => lp.id)));
      this.commit(before, '已粘贴所选内容'); this.mechanism.emitSelection(); this.mechanism.render(); return true;
    }
    wrapDocumentHistory(action, before, after) {
      const self = this, original = action.perform;
      action.perform = function () {
        const inverse = original.apply(this, arguments);
        self.active = before.active; self.state = clone(before.state); self.prune(); self.render(); self.emit();
        return self.wrapDocumentHistory(inverse, after, before);
      };
      return action;
    }
    commitNativeFragment(action, fragment) {
      if (!fragment) return action;
      const before = { active: this.active, state: this.getState() }, beforeSelection = new Set(this.selection);
      try { this.appendFragment(fragment); this.syncPageMembership(); this.validate(this.state); } catch (error) { this.active = before.active; this.state = clone(before.state); this.selection = beforeSelection; this.prune(); this.clearFragmentPreview(); this.render(); this.emit(); throw error; }
      const after = { active: this.active, state: this.getState() }; this.wrapDocumentHistory(action, before, after); this.render(); this.emit(); this.onDirtyHint?.(); return action;
    }
    commitNativeCut(action, ids) {
      if (!ids?.length) return action;
      const before = { active: this.active, state: this.getState() };
      this.state.objects = this.state.objects.filter(o => !ids.includes(o.id));
      // 清孤儿资产必须发生在 after 快照之前，撤销对才包含资产清理（对齐 deleteSelection）。
      this.pruneUnreferencedAssets();
      const after = { active: this.active, state: this.getState() };
      this.wrapDocumentHistory(action, before, after); this.prune(); this.render(); this.emit(); this.onDirtyHint?.(); return action;
    }
    cutFragment(payload) {
      const ids = payload.document?.objects?.map(o => o.id) || [], mechIds = payload.selectedMechanismIds || [];
      if (!ids.length) return false;
      const before = this.capture(); this.state.objects = this.state.objects.filter(o => !ids.includes(o.id));
      for (const id of mechIds) if (!this.mechanism.model.removeArrow(id)) this.mechanism.model.removeLonePair(id);
      // 与 deleteSelection 相同：删除对象后、提交撤销对之前清孤儿资产，让撤销/重做各自完整。
      this.pruneUnreferencedAssets(); this.prune(); this.mechanism.pruneSelection(); return this.commit(before, '已剪切所选内容');
    }
    setTool(tool) {
      this.finishTextEdit(); this.tool = tool; this.mechanism.setTool('select');
      this.adapter.ed.tool?.('select');
      this.render(); this.emit(); return tool;
    }
    modelToClient(point) {
      const svg = this.adapter.canvasSvg(), m = svg?.getScreenCTM(), p = this.adapter.modelToUser(point), frame = this.iframe.getBoundingClientRect();
      return m ? { x: m.a * p.x + m.c * p.y + m.e + frame.left, y: m.b * p.x + m.d * p.y + m.f + frame.top } : null;
    }
    paperZoomBase() { return this.state.ptPerBond * (96 / 72) / this.adapter.bondLength(); }
    getPaperZoom() { return this.adapter.zoom() / this.paperZoomBase() * 100; }
    setPaperZoom(percent, hostAnchor) {
      if (!Number.isFinite(percent) || percent <= 0) throw new Error('缩放百分比无效');
      const raw = Math.max(.08, Math.min(4, percent / 100 * this.paperZoomBase()));
      this.paperFitMode = null;
      const frame = this.iframe.getBoundingClientRect(), area = this.usablePaperArea();
      const anchor = hostAnchor && Number.isFinite(hostAnchor.x) && Number.isFinite(hostAnchor.y)
        ? { clientX: hostAnchor.x - frame.left, clientY: hostAnchor.y - frame.top }
        : area ? { clientX: area.left + area.width / 2, clientY: area.top + area.height / 2 } : undefined;
      this.adapter.ed.zoom(raw, anchor); this.adapter.ed.event?.zoomChanged?.dispatch?.();
      this.render(); this.emit(); return this.getPaperZoom();
    }
    scrollToPage(pageId) {
      const page = MW.documentModel.pageRects(this.state).find(page => page.id === pageId);
      if (!page) throw new Error('页面不存在');
      const area = this.usablePaperArea();
      const center = this.adapter.clientToModel({ x: area.left + area.width / 2, y: area.top + area.height / 2 });
      if (!center) return false;
      const height = area.height / (this.adapter.bondLength() * this.adapter.zoom());
      this.viewPageId = page.id;
      const target = { x: page.x + page.w / 2, y: page.y + Math.min(page.h / 2, Math.max(1, height / 2 - 1)) };
      this.adapter.ed.render.setViewBox(v => ({ ...v, minX: v.minX + (target.x - center.x) * this.adapter.bondLength(), minY: v.minY + (target.y - center.y) * this.adapter.bondLength() }));
      this.render(); this.emit(); return true;
    }
    fitPage(pageId) { return this.fit('page', pageId); }
    fitWidth(pageId) { return this.fit('width', pageId); }
    fit(mode, pageId) {
      this.paperFitMode = mode;
      const pages = MW.documentModel.pageRects(this.state), r = this.usablePaperArea();
      const center = this.adapter.clientToModel({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const page = pages.find(page => page.id === pageId) || this.getActivePage() || pages[0];
      const z = Math.max(0.08, Math.min(4, (r.width - 80) / (page.w * this.adapter.bondLength()), mode === 'width' ? 4 : (r.height - 70) / (page.h * this.adapter.bondLength())));
      this.adapter.ed.zoom(z); this.adapter.ed.event?.zoomChanged?.dispatch?.();
      const next = this.adapter.clientToModel({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      this.adapter.ed.render.setViewBox(v => ({ ...v, minX: v.minX + (page.x + page.w / 2 - next.x) * this.adapter.bondLength(),
        minY: v.minY + ((mode === 'width' ? page.y + Math.min(page.h / 2, r.height / (z * this.adapter.bondLength()) / 2 - 1) : page.y + page.h / 2) - next.y) * this.adapter.bondLength() }));
      this.render(); this.emit(); return true;
    }
    /* Keep outer blank space within 20% of the usable viewport on each edge.
     * If the whole document is smaller than the remaining 60%, center that axis
     * instead. Page gaps belong to the document, so multi-page scrolling stays
     * continuous. Only the view changes; document coordinates/history do not. */
    clampPaperViewport() {
      if (!this.active || this.state.mode !== 'paper' || this._clampingPaperViewport) return;
      const area = this.usablePaperArea();
      if (!area || area.width <= 0 || area.height <= 0) return;
      const svg = this.adapter.canvasSvg();
      const pages = MW.documentModel.pageRects(this.state);
      if (!svg || !pages.length) return;
      // Use the actual SVG transform: Ketcher may have a nonzero render offset,
      // and thumbnail/settings panels reserve part of its client area.
      const start = this.adapter.clientToModel({ x: area.left, y: area.top });
      const end = this.adapter.clientToModel({ x: area.left + area.width, y: area.top + area.height });
      if (!start || !end || ![start.x, start.y, end.x, end.y].every(Number.isFinite)) return;
      const width = end.x - start.x, height = end.y - start.y;
      if (width <= 0 || height <= 0) return;
      const first = pages[0], last = pages[pages.length - 1];
      const constrain = (value, length, docStart, docEnd) => {
        const margin = length * PAPER_PAN_BLANK_RATIO;
        const min = docStart - margin, max = docEnd + margin - length;
        return min > max ? (docStart + docEnd - length) / 2 : Math.max(min, Math.min(max, value));
      };
      const dx = constrain(start.x, width, first.x, last.x + last.w) - start.x;
      const dy = constrain(start.y, height, first.y, last.y + last.h) - start.y;
      const u = this.adapter.bondLength();
      if (!Number.isFinite(u) || u <= 0 || Math.max(Math.abs(dx), Math.abs(dy)) * u * this.adapter.zoom() < 0.01) return;
      this._clampingPaperViewport = true;
      try {
        this.adapter.ed.render.setViewBox(v => ({ ...v, minX: v.minX + dx * u, minY: v.minY + dy * u }));
      } finally { this._clampingPaperViewport = false; }
    }

    ensureLayers() {      const svg = this.adapter.canvasSvg(); if (!svg) return false;
      let changed = false;
      for (const [key, id] of Object.entries({ page: 'molstudio-page-layer', back: 'molstudio-document-back', front: 'molstudio-document-front', overlay: 'molstudio-document-overlay' })) {
        if (!this.layers[key]?.isConnected || this.layers[key].ownerSVGElement !== svg) {
          const g = this.doc.createElementNS(NS, 'g'); g.id = id; g.setAttribute('pointer-events', 'none');
          if (key === 'page' || key === 'overlay') g.setAttribute('data-mech-ui', '1');
          this.layers[key] = g; changed = true;
        }
        const off = this.adapter.offset();
        if (key === 'page' || key === 'back') this.layers[key].setAttribute('transform', `translate(${off.x},${off.y}) scale(${this.adapter.bondLength()})`);
        else this.layers[key].removeAttribute('transform');
      }
      const { page, back, front, overlay } = this.layers;
      if (svg.firstElementChild !== page) svg.insertBefore(page, svg.firstChild);
      if (page.nextElementSibling !== back) svg.insertBefore(back, page.nextSibling);
      const mech = this.adapter.ensureLayer();
      // Front and interaction groups are inside the mechanism root. Its adapter
      // can keep that root last without competing with a second SVG observer.
      if (mech) { if (front.parentNode !== mech) mech.appendChild(front); if (overlay.parentNode !== mech || mech.lastElementChild !== overlay) mech.appendChild(overlay); }
      return changed || true;
    }
    el(tag, attrs, parent, text) { const n = this.doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; parent?.appendChild(n); return n; }
    updatePaperBackground() {
      const rect = this.paperBackground, vb = this.adapter.canvasSvg()?.viewBox?.baseVal;
      if (!rect || !vb) return;
      const off = this.adapter.offset(), bl = this.adapter.bondLength();
      for (const [key, value] of Object.entries({ x: (vb.x - off.x) / bl - 20, y: (vb.y - off.y) / bl - 20, width: vb.width / bl + 40, height: vb.height / bl + 40 })) {
        if (rect.getAttribute(key) !== String(value)) rect.setAttribute(key, String(value));
      }
    }
    onAdapterChange(kind) {
      this.clampPaperViewport();
      if (kind === 'pan') {
        // Objects already share Ketcher's viewBox. Only the viewport-sized
        // paper surround and a live HTML text editor need to move separately.
        if (this.active && this.state.mode === 'paper') {
          this.updatePaperBackground();
          const pageId = this.getActivePage()?.id;
          if (pageId !== this.lastViewportPageId) {
            this.lastViewportPageId = pageId;
            this.emit('pan');
          }
        }
        if (this.editor) this.positionEditor();
        return;
      }
      this.render(); this.emit(kind);
    }
    render() {
      if (!this.ensureLayers()) return;
      const { page, back, front, overlay } = this.layers;
      page.textContent = ''; back.textContent = ''; front.textContent = ''; overlay.textContent = '';
      this.paperBackground = null;
      if (this.active && this.state.mode === 'paper') {
        this.paperBackground = this.el('rect', { fill: '#e7eaee', 'data-document-background': '1' }, page);
        this.updatePaperBackground();
        for (const p of MW.documentModel.pageRects(this.state)) {
          this.el('rect', { x: p.x + 0.18, y: p.y + 0.2, width: p.w, height: p.h, fill: '#00000016', rx: 0.05 }, page);
          this.el('rect', { 'data-page-id': p.id, 'data-page-index': p.index, x: p.x, y: p.y, width: p.w, height: p.h, fill: '#fff', stroke: '#cdd3da', 'stroke-width': 0.03 }, page);
          this.el('rect', { 'data-page-content': p.id, x: p.content.x, y: p.content.y, width: p.content.w, height: p.content.h, fill: 'none', stroke: '#dce2e8', 'stroke-width': 0.025, 'stroke-dasharray': '0.18 0.18' }, page);
          this.el('text', { x: p.x + p.w / 2, y: p.y + p.h + 0.9, 'text-anchor': 'middle', 'font-size': 0.55, fill: '#697582' }, page, `${p.index + 1} / ${this.state.pageCount}`);
        }
      }
      const objects = this.state.objects.concat(this.preview || []);
      for (const object of objects) {
        const parent = object.band === 'front' ? front : back;
        this.renderObject(object, parent);
        if (this.selection.has(object.id)) {
          const g = this.el('g', { transform: this.rotation(object) }, overlay), u = this.adapter.modelPerPixel();
          this.el('rect', { x: object.x, y: object.y, width: object.w, height: object.h, fill: 'none', stroke: '#147da5', 'stroke-width': u, 'stroke-dasharray': `${4 * u} ${2 * u}` }, g);
          for (const [name, x, y] of [['nw', object.x, object.y], ['ne', object.x + object.w, object.y], ['sw', object.x, object.y + object.h], ['se', object.x + object.w, object.y + object.h]])
            this.el('rect', { 'data-doc-handle': name, 'data-doc-owner': object.id, x: x - 3 * u, y: y - 3 * u, width: 6 * u, height: 6 * u, fill: '#fff', stroke: '#147da5', 'stroke-width': u }, g);
        }
      }
      if (this.drag?.kind === 'draw') this.el('rect', { x: Math.min(this.drag.start.x, this.drag.end.x), y: Math.min(this.drag.start.y, this.drag.end.y), width: Math.abs(this.drag.end.x - this.drag.start.x), height: Math.abs(this.drag.end.y - this.drag.start.y), fill: '#147da51a', stroke: '#147da5', 'stroke-width': this.adapter.modelPerPixel() }, overlay);
      // 缩放选框与控制点只在缩放模式（或缩放拖拽进行中）出现；仅纸页模式。
      const scaleUI = this.state.mode === 'paper' && (this.scaleMode || this.drag?.kind === 'scale');
      const chem = scaleUI ? this.selectionChemistryBounds() : null;
      if (chem && (chem.w > 1e-6 || chem.h > 1e-6)) {
        const u = this.adapter.modelPerPixel();
        this.el('rect', { x: chem.x, y: chem.y, width: chem.w, height: chem.h, fill: 'none', stroke: '#147da5', 'stroke-width': u, 'stroke-dasharray': `${4 * u} ${2 * u}` }, overlay);
        for (const [name, x, y] of [['nw', chem.x, chem.y], ['ne', chem.x + chem.w, chem.y], ['sw', chem.x, chem.y + chem.h], ['se', chem.x + chem.w, chem.y + chem.h]])
          this.el('rect', { 'data-scale-handle': name, x: x - 4 * u, y: y - 4 * u, width: 8 * u, height: 8 * u, fill: '#fff', stroke: '#147da5', 'stroke-width': u }, overlay);
      }
      if (this.editor) this.positionEditor();
      this.lastViewportPageId = this.active && this.state.mode === 'paper' ? this.getActivePage()?.id : null;
    }
    rotation(o) { return `rotate(${o.rotation || 0} ${o.x + o.w / 2} ${o.y + o.h / 2})`; }
    renderObject(o, parent) {
      const g = this.el('g', { 'data-doc-id': o.id, 'data-doc-kind': o.kind, 'data-selected': this.selection.has(o.id) ? '1' : '0', transform: this.rotation(o) }, parent);
      if (o.kind === 'text') {
        const rich = o.rich || {}, fs = number(rich.fontSize, 12, 2, 300) / this.state.ptPerBond, lineHeight = fs * number(rich.lineHeight, 1.4, .5, 5);
        const anchor = rich.align === 'center' ? 'middle' : rich.align === 'right' ? 'end' : 'start', x = anchor === 'middle' ? o.x + o.w / 2 : anchor === 'end' ? o.x + o.w : o.x;
        const t = this.el('text', { x, y: o.y + fs, 'font-family': typeof rich.fontFamily === 'string' && /^[\w\s,\-"']{1,160}$/.test(rich.fontFamily) ? rich.fontFamily : 'Arial, PingFang SC, sans-serif', 'font-size': fs, 'font-weight': rich.bold ? '700' : '400', 'font-style': rich.italic ? 'italic' : 'normal', fill: color(rich.color, '#1c1c1e'), 'text-anchor': anchor, 'xml:space': 'preserve' }, g);
        if (rich.runs?.length && MW.documentRichText) {
          const lines = this.richTextLayout(o).lines;
          for (let i = 0; i < lines.length; i++) this.renderRichLine(t, lines[i], { x, y: o.y + lines[i].baseline, fs, anchor, base: rich });
        } else {
          const lines = this.textLines(o);
          for (let i = 0; i < lines.length; i++) this.el('tspan', { x, y: o.y + fs + i * lineHeight }, t, lines[i] || ' ');
        }
        if (this.editor?.id === o.id) g.setAttribute('visibility', 'hidden');
      } else if (o.kind === 'molecule3d') {
        const asset = o.previewAsset ? (this.state.assets[o.previewAsset] || this.previewAssets?.[o.previewAsset]) : null;
        this.el('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: 'transparent', stroke: this.selection.has(o.id) ? '#cdd3da' : 'none', 'stroke-width': 0.03 }, g);
        if (asset) {
          this.el('image', { x: o.x, y: o.y, width: o.w, height: o.h, preserveAspectRatio: 'xMidYMid meet', href: `data:${asset.mime};base64,${asset.data}` }, g);
        }
      } else if (o.kind === 'image') {
        const asset = this.state.assets[o.asset] || this.previewAssets?.[o.asset]; if (!asset) return;
        const crop = o.crop || { x: 0, y: 0, w: 1, h: 1 };
        const nested = this.el('svg', { x: o.x, y: o.y, width: o.w, height: o.h, viewBox: `${crop.x || 0} ${crop.y || 0} ${crop.w || 1} ${crop.h || 1}`, preserveAspectRatio: 'none', overflow: 'hidden' }, g);
        this.el('image', { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', href: `data:${asset.mime};base64,${asset.data}` }, nested);
      } else if (o.kind === 'shape') {
        const attrs = { fill: o.fill === 'none' ? 'none' : color(o.fillColor || o.fill, 'none'), stroke: color(o.stroke?.color, '#3b5665'), 'stroke-width': number(o.stroke?.width, .05, .005, 5), 'stroke-dasharray': o.stroke?.dash === 'dashed' ? '0.25 0.15' : undefined, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        if (o.shape === 'ellipse') this.el('ellipse', { ...attrs, cx: o.x + o.w / 2, cy: o.y + o.h / 2, rx: o.w / 2, ry: o.h / 2 }, g);
        else if (o.shape === 'line' || o.shape === 'arrow') {
          const line = o.line || { x1: 0, y1: 0, x2: 1, y2: 1 };
          const start = { x: o.x + number(line.x1, 0, 0, 1) * o.w, y: o.y + number(line.y1, 0, 0, 1) * o.h }, end = { x: o.x + number(line.x2, 1, 0, 1) * o.w, y: o.y + number(line.y2, 1, 0, 1) * o.h };
          this.el('path', { ...attrs, fill: 'none', d: `M${start.x} ${start.y} L${end.x} ${end.y}` }, g);
          if (o.shape === 'arrow') { const angle = Math.atan2(end.y - start.y, end.x - start.x), len = Math.min(.5, Math.hypot(end.x - start.x, end.y - start.y) / 3); this.el('path', { ...attrs, fill: 'none', d: `M${end.x - len * Math.cos(angle - .45)} ${end.y - len * Math.sin(angle - .45)} L${end.x} ${end.y} L${end.x - len * Math.cos(angle + .45)} ${end.y - len * Math.sin(angle + .45)}` }, g); }
        } else if (o.shape === 'bracket') this.el('path', { ...attrs, fill: 'none', d: `M${o.x + .5} ${o.y} H${o.x} V${o.y + o.h} H${o.x + .5} M${o.x + o.w - .5} ${o.y} H${o.x + o.w} V${o.y + o.h} H${o.x + o.w - .5}` }, g);
        else if (o.shape === 'polygon') this.el('polygon', { ...attrs, points: `${o.x + o.w / 2},${o.y} ${o.x + o.w},${o.y + o.h} ${o.x},${o.y + o.h}` }, g);
        else {
          const fallbackRadius = o.shape === 'roundRect' ? Math.min(.5, o.h / 4) : 0;
          const radius = Number.isFinite(o.cornerRadius) ? o.cornerRadius : fallbackRadius;
          const rx = ['rect', 'roundRect'].includes(o.shape) ? Math.max(0, Math.min(radius, o.w / 2, o.h / 2)) : 0;
          this.el('rect', { ...attrs, x: o.x, y: o.y, width: o.w, height: o.h, rx }, g);
        }
      }
    }
    /* run-aware 渲染：每行一个 tspan，行内按 run 切子 tspan（上下标用 baseline-shift + 0.6 字号）。 */
    renderRichLine(parent, line, info) {
      const tspan = this.el('tspan', { x: info.x, y: info.y }, parent);
      if (!line.segments.length) tspan.textContent = ' ';
      for (const seg of line.segments) this.renderRichSegment(tspan, seg, info);
    }
    renderRichSegment(tspan, seg, info) {
      const base = info.base || {};
      const differs = key => seg[key] !== undefined && seg[key] !== base[key];
      // 每个 segment 一律创建独立子 tspan（无格式段也是纯 tspan）：
      // 绝不向父级行 tspan 累积 textContent——textContent 赋值会清空
      // 之前 appendChild 的上下标子 tspan（H₂O 行中下标被吞的根因）。
      const target = this.el('tspan', {}, tspan);
      const attrs = {};
      if (seg.bold !== undefined) attrs['font-weight'] = seg.bold ? '700' : '400';
      if (seg.italic !== undefined) attrs['font-style'] = seg.italic ? 'italic' : 'normal';
      if (seg.underline === true) attrs['text-decoration'] = 'underline';
      if (typeof seg.color === 'string') attrs.fill = color(seg.color, color(base.color, '#1c1c1e'));
      if (typeof seg.fontFamily === 'string') attrs['font-family'] = seg.fontFamily;
      if (seg.sub === true || seg.sup === true) { attrs['baseline-shift'] = seg.sub === true ? 'sub' : 'super'; attrs['font-size'] = info.fs * 0.6; }
      else if (differs('fontSize')) attrs['font-size'] = number(seg.fontSize, 12, 2, 300) / this.state.ptPerBond;
      for (const [key, value] of Object.entries(attrs)) if (value !== undefined) target.setAttribute(key, String(value));
      target.textContent = seg.text;
    }
    localPoint(p, o) { const angle = -(o.rotation || 0) * Math.PI / 180, x = p.x - o.x - o.w / 2, y = p.y - o.y - o.h / 2; return { x: x * Math.cos(angle) - y * Math.sin(angle) + o.x + o.w / 2, y: x * Math.sin(angle) + y * Math.cos(angle) + o.y + o.h / 2 }; }
    hit(p) {
      const objects = this.state.objects.filter(o => o.band !== 'front').concat(this.state.objects.filter(o => o.band === 'front')).reverse();
      const tolerance = 5 * this.adapter.modelPerPixel();
      for (const object of objects) { const q = this.localPoint(p, object); if (q.x >= object.x - tolerance && q.x <= object.x + object.w + tolerance && q.y >= object.y - tolerance && q.y <= object.y + object.h + tolerance) return object; }
      return null;
    }
    hitSelectedNative(p) {
      const ids = new Set(this.selectedAtomIds()), tolerance = 10 * this.adapter.modelPerPixel();
      for (const id of ids) { const q = this.adapter.atomPos(id); if (Math.hypot(p.x - q.x, p.y - q.y) < tolerance) return true; }
      for (const [, b] of this.adapter.struct().bonds) if (ids.has(b.begin) && ids.has(b.end)) {
        const a = this.adapter.atomPos(b.begin), c = this.adapter.atomPos(b.end), dx = c.x - a.x, dy = c.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < tolerance) return true;
      }
      for (const entry of this.captureNativeObjects()) {
        const o = entry.object, points = o.getCornerPositions?.() || o.pos || [o.pp || o.position].filter(Boolean);
        if (points.length) { const xs = points.map(p => p.x), ys = points.map(p => p.y); if (p.x >= Math.min(...xs) - tolerance && p.x <= Math.max(...xs) + tolerance && p.y >= Math.min(...ys) - tolerance && p.y <= Math.max(...ys) + tolerance) return true; }
      }
      const hit = this.mechanism.hitTest(p, { includeArrows: true });
      return hit?.arrow && this.mechanism.selection.has(hit.arrow.id);
    }
    nativeSelectionMode() {
      const tool = this.adapter.ed.tool?.();
      return !tool || typeof tool.isSelectionRunning === 'function';
    }
    mount() {
      const doc = this.doc;
      const listen = (name, fn, options = true) => doc.addEventListener(name, fn, options);
      listen('pointerdown', e => this.onDown(e)); listen('pointermove', e => this.onMove(e)); listen('pointerup', e => this.onUp(e));
      listen('pointercancel', () => this.cancelDrag());
      for (const name of ['mousedown', 'mousemove', 'mouseup', 'click']) listen(name, e => {
        if ((this.drag || this.suppressMouse || this.tool !== 'select') && this.mechanism.isCanvasTarget(e.target) && !editable(e.target)) stop(e);
      });
      listen('dblclick', e => { if (editable(e.target) || !this.nativeSelectionMode()) return; const p = this.adapter.clientToModel({ x: e.clientX, y: e.clientY }); const o = p && this.hit(p);
        if (o?.kind === 'text') { stop(e); this.editText(o.id); }
        else if (o?.kind === 'molecule3d') { stop(e); if (this.onMolecule3DActivate) this.onMolecule3DActivate(o.id); else this.status('3D 交互面板尚未就绪'); } });
      listen('keydown', e => this.onKey(e));
      listen('click', e => { const button = e.target.closest?.('button'); if (button && !button.closest('[data-document-ui]') && !button.hasAttribute('data-doc-tool')) { this.tool = 'select'; this.emit(); } });
      const supportedFile = file => /^image\//.test(file.type) || /\.(molwork|ket)$/i.test(file.name);
      listen('dragover', e => { if ([...(e.dataTransfer?.files || [])].some(supportedFile)) e.preventDefault(); });
      listen('drop', e => { const files = [...(e.dataTransfer?.files || [])].filter(supportedFile); if (!files.length) return; stop(e); const p = this.adapter.clientToModel({ x: e.clientX, y: e.clientY });
        if (/\.(molwork|ket)$/i.test(files[0].name)) this.importFile(files[0], { at: p });
        else this.insertImageFile(files[0], p).catch(error => this.status(error.message)); });
      this.adapter.onChange(kind => this.onAdapterChange(kind));
      // 源头拦截：所有平移（Ketcher hand 拖、滚轮、scrollToPage/fit）最终都调
      // render.setViewBox。包一层，纸页模式下每次调用后同步钳制。MutationObserver
      // 的间接通知在部分 pan 路径上不可靠（实测页面可被拖到只剩一角），这层保证
      // 每次视口变化立刻收敛。
      const render = this.adapter.ed?.render;
      if (render && typeof render.setViewBox === 'function' && !this._setViewBoxPatched) {
        const original = render.setViewBox.bind(render);
        const controller = this;
        render.setViewBox = function (update) {
          const result = original(update);
          controller.clampPaperViewport();
          return result;
        };
        this._setViewBoxPatched = true;
      }
      this.win.addEventListener('blur', () => this.cancelDrag());
      this.render();
    }
    onDown(e) {
      if (e.button !== 0 || editable(e.target) || !this.mechanism.isCanvasTarget(e.target)) return;
      if (this.editor?.composing) { stop(e); return; }
      this.mechanism.flushNativeMarquee(); this.finishTextEdit();
      const p = this.adapter.clientToModel({ x: e.clientX, y: e.clientY }); if (!p) return;
      if (this.mechanism.tool !== 'select' || this.mechanism.nativePasteSession || this.mechanism.pastePreview) { if (this.selection.size) { this.selection.clear(); this.render(); this.emit(); } return; }
      if (this.tool !== 'select') { stop(e); this.drag = { kind: 'draw', start: p, end: p, tool: this.tool }; this.suppressMouse = true; return; }
      // Native chemistry and navigation tools own their gestures even over a
      // document background. Only Ketcher's selection tool mixes object types.
      if (!this.nativeSelectionMode()) {
        if (this.selection.size) { this.selection.clear(); this.render(); this.emit(); }
        return;
      }
      let object = this.hit(p);
      const mixedNative = this.selection.size && this.hitSelectedNative(p);
      if (object && object.band !== 'front' && !mixedNative) {
        const chemicalHit = this.mechanism.hitTest(p, { includeArrows: true });
        if (chemicalHit && !chemicalHit.ghost) object = null;
      }
      const u = 8 * this.adapter.modelPerPixel();
      let handle = null;
      if (this.selection.size === 1) { const o = this.object([...this.selection][0]); const q = this.localPoint(p, o); for (const [name, x, y] of [['nw', o.x, o.y], ['ne', o.x + o.w, o.y], ['sw', o.x, o.y + o.h], ['se', o.x + o.w, o.y + o.h]]) if (Math.hypot(q.x - x, q.y - y) < u) handle = name; }
      // 化学缩放手柄/框内拖拽：只在缩放模式下出现并响应；仅纸页模式。
      let scaleHandle = null;
      if (this.state.mode === 'paper' && this.scaleMode && !object && !handle && !mixedNative) {
        const chem = this.selectionChemistryBounds();
        if (chem) {
          for (const [name, x, y] of [['nw', chem.x, chem.y], ['ne', chem.x + chem.w, chem.y], ['sw', chem.x, chem.y + chem.h], ['se', chem.x + chem.w, chem.y + chem.h]])
            if (Math.hypot(p.x - x, p.y - y) < u) scaleHandle = name;
          // 虚线框内部空白按下：未命中原子/键/孤对/文档对象时也进入拖拽缩放
          if (!scaleHandle && p.x >= chem.x && p.x <= chem.x + chem.w && p.y >= chem.y && p.y <= chem.y + chem.h) {
            const chemicalHit = this.mechanism.hitTest?.(p, { includeArrows: true });
            if (!chemicalHit || chemicalHit.ghost) scaleHandle = 'inner';
          }
        }
      }
      if (object || handle || mixedNative || scaleHandle) {
        stop(e); this.suppressMouse = true;
        if (scaleHandle) {
          const targets = this.selectionTargets(), before = this.capture(), chem = this.selectionChemistryBounds(targets);
          if (!chem) { this.suppressMouse = false; return; }
          this.drag = { kind: 'scale', handle: scaleHandle, start: p, before, targets, anchor: { x: chem.x + chem.w / 2, y: chem.y + chem.h / 2 }, moved: false };
          this.render(); this.emit(); return;
        }
        if (object && !handle) {
          if (e.shiftKey) { if (this.selection.has(object.id)) this.selection.delete(object.id); else this.selection.add(object.id); }
          else if (!this.selection.has(object.id)) this.select([object.id]);
        }
        this.drag = { kind: handle ? 'resize' : 'move', handle, objectId: handle ? [...this.selection][0] : null, start: p, before: this.capture(), moved: false };
        this.render(); this.emit(); return;
      }
      if (!e.shiftKey && this.selection.size) { this.selection.clear(); this.render(); this.emit(); }
    }
    onMove(e) {
      if (!this.drag) return;
      stop(e); const p = this.adapter.clientToModel({ x: e.clientX, y: e.clientY }); if (!p) return;
      const d = this.drag; d.end = p;
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (d.kind === 'draw') { this.render(); return; }
      if (!d.moved && Math.hypot(dx, dy) <= 2 * this.adapter.modelPerPixel()) return;
      d.moved = true;
      if (d.kind === 'move') this.translateSnapshot(d.before, dx, dy);
      else if (d.kind === 'scale') {
        if (!d.moved && Math.hypot(dx, dy) <= 2 * this.adapter.modelPerPixel()) return;
        d.moved = true;
        const base = Math.hypot(d.start.x - d.anchor.x, d.start.y - d.anchor.y);
        const now = Math.hypot(p.x - d.anchor.x, p.y - d.anchor.y);
        const factor = base > 1e-9 ? now / base : 1;
        this.applyScaleSnapshot(d.before, factor, d.anchor, d.targets);
      }
      else {
        this.state = clone(d.before.document); const o = this.object(d.objectId), old = d.before.document.objects.find(o => o.id === d.objectId);
        const localStart = this.localPoint(d.start, old), localEnd = this.localPoint(p, old), resizeDx = localEnd.x - localStart.x, resizeDy = localEnd.y - localStart.y;
        if (d.handle.includes('e')) o.w = Math.max(.3, old.w + resizeDx); else { o.x = Math.min(old.x + old.w - .3, old.x + resizeDx); o.w = old.x + old.w - o.x; }
        if (d.handle.includes('s')) o.h = Math.max(.3, old.h + resizeDy); else { o.y = Math.min(old.y + old.h - .3, old.y + resizeDy); o.h = old.y + old.h - o.y; }
        if (e.shiftKey && old.w > 0 && old.h > 0) {
          // 等比锁：以拖动主轴为准保持宽高比，未拖动的对边作为锚点
          const ratio = old.w / old.h;
          if (d.handle.includes('e') || d.handle.includes('w')) {
            o.h = Math.max(.3, o.w / ratio);
            if (!d.handle.includes('s')) o.y = old.y + old.h - o.h;
          } else {
            o.w = Math.max(.3, o.h * ratio);
            if (!d.handle.includes('e')) o.x = old.x + old.w - o.w;
          }
        }
        if (o.kind === 'text') o.h = Math.max(o.h, this.textHeight(o));
        this.render();
      }
    }
    onUp(e) {
      if (!this.drag) return;
      this.onMove(e); const d = this.drag; this.drag = null; stop(e);
      setTimeout(() => { this.suppressMouse = false; }, 0);
      if (d.kind === 'draw') {
        const w = Math.abs(d.end.x - d.start.x), h = Math.abs(d.end.y - d.start.y), position = { x: Math.min(d.start.x, d.end.x), y: Math.min(d.start.y, d.end.y), w: Math.max(.3, w), h: Math.max(.3, h) };
        this.tool = 'select';
        if (d.tool === 'text') { const id = this.addText({ ...position, w: w < .5 ? 15 : w, h: h < .5 ? 3 : h, text: '' }); this.editText(id); }
        else this.addShape({ ...position, shape: d.tool, ...(['line', 'arrow'].includes(d.tool) ? { line: { x1: (d.start.x - position.x) / position.w, y1: (d.start.y - position.y) / position.h, x2: (d.end.x - position.x) / position.w, y2: (d.end.y - position.y) / position.h } } : {}) });
      } else if (d.moved) this.commit(d.before, d.kind === 'scale' ? '已缩放所选内容' : '已移动或调整所选内容');
      this.render(); this.emit();
    }
    cancelDrag() { if (this.drag?.before) this.apply(this.drag.before); this.drag = null; this.suppressMouse = false; this.render(); }
    onKey(e) {
      if (this.mechanism.nativePasteSession || this.mechanism.pastePreview) return;
      if (this.nativeDeleteBypass || editable(e.target) || e.isComposing) return;
      const key = e.key.toLowerCase(), meta = e.metaKey || e.ctrlKey;
      if (key === 'escape' && this.scaleMode && !this.drag) { stop(e); this.setScaleMode(false); return; }
      if (key === 'escape' && (this.drag || this.selection.size || this.tool !== 'select')) { stop(e); if (this.drag) this.cancelDrag(); else { this.selection.clear(); this.tool = 'select'; this.render(); this.emit(); } return; }
      if (meta && key === 'a') { stop(e); this.selectAll(); return; }
      if (this.selection.size && (key === 'delete' || key === 'backspace')) { stop(e); this.deleteSelection(); return; }
      if (this.selection.size && meta && key === 'd') { stop(e); this.duplicateSelection(); return; }
      if (this.selection.size && !meta && !e.altKey && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        stop(e); const unit = e.shiftKey ? 1 : .1; this.moveSelection(key === 'arrowleft' ? -unit : key === 'arrowright' ? unit : 0, key === 'arrowup' ? -unit : key === 'arrowdown' ? unit : 0);
      }
    }
    editText(id) {
      if (this.editor?.composing) return false;
      this.finishTextEdit(); const o = this.object(id); if (o?.kind !== 'text') return false;
      this.select([id]); const before = this.capture();
      const div = this.doc.createElement('div'); div.id = 'molstudio-document-editor'; div.contentEditable = 'true'; div.setAttribute('role', 'textbox'); div.setAttribute('aria-label', '编辑文本框');
      div.style.cssText = 'position:fixed;box-sizing:border-box;z-index:1000;outline:2px solid #147da5;background:#ffffffed;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;padding:0;transform-origin:center;';
      if (MW.documentRichText) {
        // run-aware 编辑器 DOM（sub/sup 用标签包裹）；composition 期间绝不重建
        const built = MW.documentRichText.buildEditorDom(o.rich || {}, this.doc, this.editorPxPerPt());
        while (built.firstChild) div.appendChild(built.firstChild);
      } else div.textContent = o.rich?.text || '';
      this.editor = { id, div, before, composing: false, pxPerPt: this.editorPxPerPt() };
      this.doc.body.appendChild(div); this.positionEditor();
      div.addEventListener('compositionstart', () => { if (this.editor) this.editor.composing = true; });
      div.addEventListener('compositionend', () => { if (this.editor) { this.editor.composing = false; if (this.editor.pendingFinish) this.finishTextEdit(); } });
      div.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.isComposing || this.editor?.composing) return;
        if (e.key === 'Escape') { e.preventDefault(); this.finishTextEdit(true); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.finishTextEdit(); }
      });
      div.addEventListener('paste', e => {
        e.preventDefault(); e.stopPropagation();
        if (this.editor?.composing || e.isComposing) return;
        const html = e.clipboardData?.getData('text/html');
        const plain = e.clipboardData?.getData('text/plain') || '';
        if (html && MW.documentRichText) {
          try {
            const parsed = new this.win.DOMParser().parseFromString(html, 'text/html');
            const clean = MW.documentRichText.sanitizeClipboardFragment(parsed.body || parsed.documentElement, this.doc, this.editorPxPerPt());
            if (clean.text) { this.insertRichFragment(clean); return; }
          } catch (error) { /* 清洗失败按纯文本降级 */ }
        }
        this.doc.execCommand('insertText', false, plain);
      });
      div.addEventListener('blur', () => {
        const current = this.editor;
        // Host-document controls focus after the iframe blur event. Wait for
        // that transition before deciding whether the shared edit has ended.
        setTimeout(() => {
          if (this.editor === current && this.doc.activeElement !== div && !this.preserveTextEditOnBlur?.(current)) this.finishTextEdit();
        }, 0);
      });
      this.render(); div.focus(); const selection = this.win.getSelection(), range = this.doc.createRange(); range.selectNodeContents(div); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); return true;
    }
    positionEditor() {
      const current = this.editor, o = current && this.object(current.id); if (!o) return;
      const point = this.modelToClient({ x: o.x, y: o.y }), frame = this.iframe.getBoundingClientRect(), scale = this.adapter.zoom() * this.adapter.bondLength(), rich = o.rich || {};
      Object.assign(current.div.style, { left: point.x - frame.left + 'px', top: point.y - frame.top + 'px', width: o.w * scale + 'px', height: o.h * scale + 'px', fontFamily: rich.fontFamily || 'Arial, PingFang SC, sans-serif', fontSize: (rich.fontSize || 12) / this.state.ptPerBond * scale + 'px', lineHeight: String(rich.lineHeight || 1.4), fontWeight: rich.bold ? '700' : '400', fontStyle: rich.italic ? 'italic' : 'normal', color: color(rich.color, '#1c1c1e'), textAlign: rich.align || 'left', transform: `rotate(${o.rotation || 0}deg)` });
    }
    /* 把 sanitizeClipboardFragment 的 {text, runs} 以 DOM 节点插入光标处；绝不 innerHTML 外部 HTML。 */
    insertRichFragment(clean) {
      const rt = MW.documentRichText, sel = this.win.getSelection();
      if (!rt || !sel?.rangeCount) return;
      const range = sel.getRangeAt(0); range.deleteContents();
      const px = this.editorPxPerPt();
      for (const seg of rt.segments(clean)) {
        const wrap = seg.sub === true || seg.sup === true ? this.doc.createElement(seg.sub === true ? 'sub' : 'sup') : null;
        const span = this.doc.createElement('span');
        if (seg.bold === true) span.style.fontWeight = '700';
        if (seg.italic === true) span.style.fontStyle = 'italic';
        if (seg.underline === true) span.style.textDecoration = 'underline';
        if (typeof seg.color === 'string') span.style.color = seg.color;
        if (typeof seg.fontSize === 'number' && Number.isFinite(seg.fontSize)) span.style.fontSize = seg.fontSize * px + 'px';
        if (typeof seg.fontFamily === 'string') span.style.fontFamily = seg.fontFamily;
        span.appendChild(this.doc.createTextNode(seg.text));
        if (wrap) wrap.appendChild(span);
        range.insertNode(wrap || span);
        if (wrap) range.setStartAfter(wrap); else range.setStartAfter(span);
        range.collapse(true);
      }
      sel.removeAllRanges(); sel.addRange(range);
    }
    textCommand(command) {
      if (!this.editor || this.editor.composing) return false;
      this.editor.div.focus(); return this.doc.execCommand(command);
    }
    readTextEditRich(current) {
      const base = this.object(current.id)?.rich || {};
      const read = MW.documentRichText
        ? MW.documentRichText.readEditorDom(current.div, base, current.pxPerPt || this.editorPxPerPt())
        : { text: (current.div.innerText ?? current.div.textContent) || '', runs: [] };
      // Keep run boundaries aligned when removing inline-style placeholders.
      // The same conversion serves snapshots and the final history commit.
      const raw = read.text || '', text = raw.replace(/\u200b/g, '');
      const boundary = new Array(raw.length + 1);
      let kept = 0;
      for (let i = 0; i <= raw.length; i++) { boundary[i] = kept; if (i < raw.length && raw[i] !== '\u200b') kept++; }
      const shifted = (read.runs || [])
        .map(run => ({ ...run, start: boundary[Math.max(0, Math.min(run.start, raw.length))], end: boundary[Math.max(0, Math.min(run.end, raw.length))] }))
        .filter(run => run.end > run.start);
      const runs = MW.documentRichText ? MW.documentRichText.normalizeRuns(shifted, text) : [];
      const rich = { ...base, text };
      if (runs.length) rich.runs = runs; else delete rich.runs;
      return rich;
    }
    finishTextEdit(cancel) {
      const current = this.editor; if (!current) return false;
      if (current.composing && !cancel) { current.pendingFinish = true; return false; }
      const rich = cancel ? null : this.readTextEditRich(current);
      this.editor = null;
      current.div.remove();
      if (cancel) {
        const o = this.object(current.id), original = current.before?.document?.objects.find(item => item.id === current.id);
        if (o && original) { o.rich = clone(original.rich); o.h = original.h; }
      }
      if (!cancel) { const o = this.object(current.id); if (o) {
        o.rich = rich;
        o.h = Math.max(o.h, this.textHeight(o)); this.commit(current.before, '已编辑文字'); } }
      this.render(); return true;
    }
    /* 编辑器未打开时的对象级格式补丁（一个撤销）。编辑器打开时请用浮动格式条（UI 层职责）。 */
    applyTextFormat(objectId, range, patch) {
      if (this.editor && this.editor.id === objectId) throw new Error('编辑器打开时请在浮动格式条中设置选区格式');
      const o = this.object(objectId); if (!o || o.kind !== 'text') throw new Error('文本对象不存在');
      const rt = MW.documentRichText; if (!rt) throw new Error('富文本模块未加载');
      this.mutate(() => { o.rich = rt.applyFormat(o.rich || { text: '' }, range, patch); o.h = Math.max(o.h, this.textHeight(o)); }, '已设置文字格式');
      return true;
    }
    /* 属性面板便捷查询：offset 处生效格式（run 覆盖整框默认）。 */
    formatAtOffset(objectId, offset) {
      const o = this.object(objectId); if (!o || o.kind !== 'text') throw new Error('文本对象不存在');
      const rt = MW.documentRichText; if (!rt) throw new Error('富文本模块未加载');
      return rt.formatAt(o.rich || { text: '' }, offset);
    }
  }
  MW.documentController = { DocumentController };
  if (typeof module === 'object' && module.exports) module.exports = MW.documentController;
})(typeof window === 'object' ? window : globalThis);
