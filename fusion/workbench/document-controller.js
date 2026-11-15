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
  const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const rectOf = o => ({ x: o.x, y: o.y, w: o.w, h: o.h });
  const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
  class DocumentController {
    constructor(options) {
      Object.assign(this, options);
      this.state = MW.documentModel.createDocument();
      this.active = false; this.generation = 0;
      this.selection = new Set(); this.tool = 'select'; this.listeners = new Set();
      this.drag = null; this.editor = null; this.layers = {}; this.preview = null;
      this.mechanism.documentController = this;
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(reason) {
      root.__documentSelectionCount = this.selection.size;
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
    export() { if (this.editor?.composing) throw new Error('请先完成输入法输入，再保存文档'); this.finishTextEdit(); return this.active ? this.getState() : undefined; }
    capture() {
      return { document: this.getState(), active: this.active, mechanism: this.mechanism.model.cloneState(),
        nativeObjects: this.captureNativeObjects(), nativeSelection: clone(this.adapter.ed.selection?.() || {}),
        reactionSteps: MW.app?.reactionSteps?.captureRuntime?.(),
        coords: this.selectedAtomIds().map(id => { const p = this.adapter.atomPos(id); return [id, p.x, p.y]; }) };
    }
    apply(snapshot) {
      this.active = snapshot.active; this.state = clone(snapshot.document);
      this.mechanism.model.setState(clone(snapshot.mechanism), 'history');
      this.setNativeObjects(snapshot.nativeObjects); this.setAtomCoords(snapshot.coords);
      if (snapshot.reactionSteps) MW.app?.reactionSteps?.restoreRuntime?.(snapshot.reactionSteps, false);
      this.prune(); this.clampPaperViewport(); this.render(); this.mechanism.render(); this.emit();
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
      this.mutate(() => { this.state.objects.push(item); this.selection = new Set([item.id]); }, '已插入' + ({ text: '文字', shape: '形状', image: '图片' }[item.kind] || '对象'));
      return item.id;
    }
    textLines(object) {
      const rich = object.rich || {}, fs = number(rich.fontSize, 12, 2, 300) / this.state.ptPerBond;
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
      return fs + (this.textLines(object).length - 1) * fs * number(rich.lineHeight, 1.4, .5, 5) + fs * .3;
    }
    addText(options) {
      const o = options || {}, rich = { text: o.text ?? o.rich?.text ?? '双击编辑文字', fontFamily: 'Arial, PingFang SC, sans-serif', fontSize: 12, color: '#1c1c1e', lineHeight: 1.4, align: 'left', ...o.rich };
      for (const key of ['fontSize', 'fontFamily', 'color', 'bold', 'italic', 'align', 'lineHeight']) if (o[key] !== undefined) rich[key] = o[key];
      const object = { w: 12, h: 3, ...o, kind: 'text', rich }; object.h = Math.max(object.h, this.textHeight(object));
      return this.addObject(object);
    }
    addShape(options) { return this.addObject({ w: 8, h: 5, shape: 'rect', fill: 'none', stroke: { color: '#3b5665', width: 0.05 }, ...options, kind: 'shape' }); }
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
      for (const o of objects) { delete o.pageId; if (o.kind === 'image' && this.state.assets[o.asset]) assets[o.asset] = clone(this.state.assets[o.asset]); }
      return objects.length ? { objects, assets } : null;
    }
    prepareFragment(fragment) {
      if (!fragment?.objects?.length) return null;
      const doc = MW.documentModel.createDocument(); doc.objects = clone(fragment.objects); doc.assets = clone(fragment.assets || {});
      this.validate(doc);
      const assets = {}, assetIds = new Map();
      for (const [id, value] of Object.entries(doc.assets)) { const key = uid('asset'); assetIds.set(id, key); assets[key] = value; }
      const objects = doc.objects.map(o => { const next = { ...o, id: uid('obj') }; delete next.pageId; if (next.asset) next.asset = assetIds.get(next.asset); return next; });
      return { sourceObjects: objects, objects: clone(objects), assets };
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
      const after = { active: this.active, state: this.getState() };
      this.wrapDocumentHistory(action, before, after); this.prune(); this.render(); this.emit(); this.onDirtyHint?.(); return action;
    }
    cutFragment(payload) {
      const ids = payload.document?.objects?.map(o => o.id) || [], mechIds = payload.selectedMechanismIds || [];
      if (!ids.length) return false;
      const before = this.capture(); this.state.objects = this.state.objects.filter(o => !ids.includes(o.id));
      for (const id of mechIds) if (!this.mechanism.model.removeArrow(id)) this.mechanism.model.removeLonePair(id);
      this.prune(); this.mechanism.pruneSelection(); return this.commit(before, '已剪切所选内容');
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
      if (this.editor) this.positionEditor();
      this.lastViewportPageId = this.active && this.state.mode === 'paper' ? this.getActivePage()?.id : null;
    }
    rotation(o) { return `rotate(${o.rotation || 0} ${o.x + o.w / 2} ${o.y + o.h / 2})`; }
    renderObject(o, parent) {
      const g = this.el('g', { 'data-doc-id': o.id, 'data-doc-kind': o.kind, 'data-selected': this.selection.has(o.id) ? '1' : '0', transform: this.rotation(o) }, parent);
      if (o.kind === 'text') {
        const rich = o.rich || {}, fs = number(rich.fontSize, 12, 2, 300) / this.state.ptPerBond, lineHeight = fs * number(rich.lineHeight, 1.4, .5, 5);
        const lines = this.textLines(o);
        const anchor = rich.align === 'center' ? 'middle' : rich.align === 'right' ? 'end' : 'start', x = anchor === 'middle' ? o.x + o.w / 2 : anchor === 'end' ? o.x + o.w : o.x;
        const t = this.el('text', { x, y: o.y + fs, 'font-family': typeof rich.fontFamily === 'string' && /^[\w\s,\-"']{1,160}$/.test(rich.fontFamily) ? rich.fontFamily : 'Arial, PingFang SC, sans-serif', 'font-size': fs, 'font-weight': rich.bold ? '700' : '400', 'font-style': rich.italic ? 'italic' : 'normal', fill: color(rich.color, '#1c1c1e'), 'text-anchor': anchor, 'xml:space': 'preserve' }, g);
        for (let i = 0; i < lines.length; i++) this.el('tspan', { x, y: o.y + fs + i * lineHeight }, t, lines[i] || ' ');
        if (this.editor?.id === o.id) g.setAttribute('visibility', 'hidden');
      } else if (o.kind === 'image') {
        const asset = this.state.assets[o.asset] || this.previewAssets?.[o.asset]; if (!asset) return;
        const crop = o.crop || { x: 0, y: 0, w: 1, h: 1 };
        const nested = this.el('svg', { x: o.x, y: o.y, width: o.w, height: o.h, viewBox: `${crop.x || 0} ${crop.y || 0} ${crop.w || 1} ${crop.h || 1}`, preserveAspectRatio: 'none', overflow: 'hidden' }, g);
        this.el('image', { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', href: `data:${asset.mime};base64,${asset.data}` }, nested);
      } else if (o.kind === 'shape') {
        const attrs = { fill: color(o.fill, 'none'), stroke: color(o.stroke?.color, '#3b5665'), 'stroke-width': number(o.stroke?.width, .05, .005, 5), 'stroke-dasharray': o.stroke?.dash === 'dashed' ? '0.25 0.15' : undefined, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        if (o.shape === 'ellipse') this.el('ellipse', { ...attrs, cx: o.x + o.w / 2, cy: o.y + o.h / 2, rx: o.w / 2, ry: o.h / 2 }, g);
        else if (o.shape === 'line' || o.shape === 'arrow') {
          const line = o.line || { x1: 0, y1: 0, x2: 1, y2: 1 };
          const start = { x: o.x + number(line.x1, 0, 0, 1) * o.w, y: o.y + number(line.y1, 0, 0, 1) * o.h }, end = { x: o.x + number(line.x2, 1, 0, 1) * o.w, y: o.y + number(line.y2, 1, 0, 1) * o.h };
          this.el('path', { ...attrs, fill: 'none', d: `M${start.x} ${start.y} L${end.x} ${end.y}` }, g);
          if (o.shape === 'arrow') { const angle = Math.atan2(end.y - start.y, end.x - start.x), len = Math.min(.5, Math.hypot(end.x - start.x, end.y - start.y) / 3); this.el('path', { ...attrs, fill: 'none', d: `M${end.x - len * Math.cos(angle - .45)} ${end.y - len * Math.sin(angle - .45)} L${end.x} ${end.y} L${end.x - len * Math.cos(angle + .45)} ${end.y - len * Math.sin(angle + .45)}` }, g); }
        } else if (o.shape === 'bracket') this.el('path', { ...attrs, fill: 'none', d: `M${o.x + .5} ${o.y} H${o.x} V${o.y + o.h} H${o.x + .5} M${o.x + o.w - .5} ${o.y} H${o.x + o.w} V${o.y + o.h} H${o.x + o.w - .5}` }, g);
        else if (o.shape === 'polygon') this.el('polygon', { ...attrs, points: `${o.x + o.w / 2},${o.y} ${o.x + o.w},${o.y + o.h} ${o.x},${o.y + o.h}` }, g);
        else this.el('rect', { ...attrs, x: o.x, y: o.y, width: o.w, height: o.h, rx: o.shape === 'roundRect' ? Math.min(.5, o.h / 4) : 0 }, g);
      }
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
      listen('dblclick', e => { if (editable(e.target) || !this.nativeSelectionMode()) return; const p = this.adapter.clientToModel({ x: e.clientX, y: e.clientY }); const o = p && this.hit(p); if (o?.kind === 'text') { stop(e); this.editText(o.id); } });
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
      if (object || handle || mixedNative) {
        stop(e); this.suppressMouse = true;
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
      else {
        this.state = clone(d.before.document); const o = this.object(d.objectId), old = d.before.document.objects.find(o => o.id === d.objectId);
        const localStart = this.localPoint(d.start, old), localEnd = this.localPoint(p, old), resizeDx = localEnd.x - localStart.x, resizeDy = localEnd.y - localStart.y;
        if (d.handle.includes('e')) o.w = Math.max(.3, old.w + resizeDx); else { o.x = Math.min(old.x + old.w - .3, old.x + resizeDx); o.w = old.x + old.w - o.x; }
        if (d.handle.includes('s')) o.h = Math.max(.3, old.h + resizeDy); else { o.y = Math.min(old.y + old.h - .3, old.y + resizeDy); o.h = old.y + old.h - o.y; }
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
      } else if (d.moved) this.commit(d.before, '已移动或调整所选内容');
      this.render(); this.emit();
    }
    cancelDrag() { if (this.drag?.before) this.apply(this.drag.before); this.drag = null; this.suppressMouse = false; this.render(); }
    onKey(e) {
      if (this.mechanism.nativePasteSession || this.mechanism.pastePreview) return;
      if (this.nativeDeleteBypass || editable(e.target) || e.isComposing) return;
      const key = e.key.toLowerCase(), meta = e.metaKey || e.ctrlKey;
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
      div.textContent = o.rich?.text || ''; div.style.cssText = 'position:fixed;box-sizing:border-box;z-index:1000;outline:2px solid #147da5;background:#ffffffed;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;padding:0;transform-origin:center;';
      this.editor = { id, div, before, composing: false }; this.doc.body.appendChild(div); this.positionEditor();
      div.addEventListener('compositionstart', () => { if (this.editor) this.editor.composing = true; });
      div.addEventListener('compositionend', () => { if (this.editor) { this.editor.composing = false; if (this.editor.pendingFinish) this.finishTextEdit(); } });
      div.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.isComposing || this.editor?.composing) return;
        if (e.key === 'Escape') { e.preventDefault(); this.finishTextEdit(true); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.finishTextEdit(); }
      });
      div.addEventListener('paste', e => { e.preventDefault(); e.stopPropagation(); const text = e.clipboardData?.getData('text/plain') || ''; this.doc.execCommand('insertText', false, text); });
      div.addEventListener('blur', () => this.finishTextEdit());
      this.render(); div.focus(); const selection = this.win.getSelection(), range = this.doc.createRange(); range.selectNodeContents(div); range.collapse(false); selection.removeAllRanges(); selection.addRange(range); return true;
    }
    positionEditor() {
      const current = this.editor, o = current && this.object(current.id); if (!o) return;
      const point = this.modelToClient({ x: o.x, y: o.y }), frame = this.iframe.getBoundingClientRect(), scale = this.adapter.zoom() * this.adapter.bondLength(), rich = o.rich || {};
      Object.assign(current.div.style, { left: point.x - frame.left + 'px', top: point.y - frame.top + 'px', width: o.w * scale + 'px', height: o.h * scale + 'px', fontFamily: rich.fontFamily || 'Arial, PingFang SC, sans-serif', fontSize: (rich.fontSize || 12) / this.state.ptPerBond * scale + 'px', lineHeight: String(rich.lineHeight || 1.4), fontWeight: rich.bold ? '700' : '400', fontStyle: rich.italic ? 'italic' : 'normal', color: color(rich.color, '#1c1c1e'), textAlign: rich.align || 'left', transform: `rotate(${o.rotation || 0}deg)` });
    }
    textCommand(command) {
      if (!this.editor || this.editor.composing) return false;
      this.editor.div.focus(); return this.doc.execCommand(command);
    }
    finishTextEdit(cancel) {
      const current = this.editor; if (!current) return false;
      if (current.composing && !cancel) { current.pendingFinish = true; return false; }
      this.editor = null; const text = current.div.innerText ?? current.div.textContent; current.div.remove();
      if (!cancel) { const o = this.object(current.id); if (o) { o.rich = { ...o.rich, text }; o.h = Math.max(o.h, this.textHeight(o)); this.commit(current.before, '已编辑文字'); } }
      this.render(); return true;
    }
  }
  MW.documentController = { DocumentController };
  if (typeof module === 'object' && module.exports) module.exports = MW.documentController;
})(typeof window === 'object' ? window : globalThis);
