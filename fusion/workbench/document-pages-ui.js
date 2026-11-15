/* Paper page navigator and bounded, visible-page thumbnail cache. */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  const PREF_KEY = 'molstudio.documentPages.collapsed.v1';
  const MAX_THUMBNAILS = 8;

  class DocumentPagesUI {
    constructor(options) { Object.assign(this, options); }

    mount() {
      const doc = this.doc, c = this.controller;
      if (!doc || !c || this.root) return;
      this.root = doc.createElement('aside');
      this.root.id = 'molstudio-document-pages';
      this.root.dataset.documentUi = '1';
      this.root.setAttribute('aria-label', '文档页面');

      const style = doc.createElement('style');
      style.dataset.documentPagesStyle = '1';
      style.textContent = `
        #molstudio-document-pages{position:fixed;left:58px;top:94px;bottom:64px;z-index:23;width:158px;display:flex;flex-direction:column;box-sizing:border-box;padding:7px;background:#fffffff5;border:1px solid #d7dde2;border-radius:9px;box-shadow:0 3px 14px #20304414;color:#34424d;font:12px -apple-system,PingFang SC,sans-serif;transition:width .16s ease;overflow:hidden}
        #molstudio-document-pages[hidden]{display:none}
        #molstudio-document-pages[data-collapsed="true"]{width:34px;padding:4px}
        #molstudio-document-pages .doc-pages-head{display:flex;align-items:center;justify-content:space-between;gap:4px;min-height:28px;padding:0 2px 5px;font-weight:600;white-space:nowrap}
        #molstudio-document-pages[data-collapsed="true"] .doc-pages-head{justify-content:center;padding:0}
        #molstudio-document-pages .doc-pages-title{overflow:hidden;text-overflow:ellipsis}
        #molstudio-document-pages[data-collapsed="true"] .doc-pages-title{display:none}
        #molstudio-document-pages button{font:inherit;color:inherit;cursor:pointer}
        #molstudio-document-pages .doc-pages-toggle{flex:none;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:transparent;font-size:16px;line-height:1}
        #molstudio-document-pages .doc-pages-toggle:hover{background:#e7f1f5;color:#086c91}
        #molstudio-document-pages .doc-pages-list{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;display:flex;flex-direction:column;align-items:center;gap:8px;padding:2px 1px 5px}
        #molstudio-document-pages[data-collapsed="true"] .doc-pages-list{display:none}
        #molstudio-document-pages .doc-page-card{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;padding:6px 4px;border:1px solid #e0e5e9;border-radius:7px;background:#fff;text-align:center;transition:border-color .12s,box-shadow .12s}
        #molstudio-document-pages .doc-page-card:hover{border-color:#8ebdce}
        #molstudio-document-pages .doc-page-card[aria-current="page"]{border-color:#147da5;box-shadow:0 0 0 1px #147da533;background:#f8fcfe}
        #molstudio-document-pages .doc-page-preview{position:relative;display:flex;align-items:center;justify-content:center;width:105px;height:148px;overflow:hidden;background:#f1f3f5;border:1px solid #e4e7eb;box-shadow:0 1px 3px #20304412}
        #molstudio-document-pages .doc-page-preview img{display:none;width:100%;height:100%;object-fit:contain;background:#fff}
        #molstudio-document-pages .doc-page-preview[data-ready="true"] img{display:block}
        #molstudio-document-pages .doc-page-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:8px;color:#9aa5ae;font-size:10px;line-height:1.35}
        #molstudio-document-pages .doc-page-preview[data-ready="true"] .doc-page-placeholder{display:none}
        #molstudio-document-pages .doc-page-label{color:#687784;font-size:11px;white-space:nowrap}
        #molstudio-document-pages .doc-page-card[aria-current="page"] .doc-page-label{color:#086c91;font-weight:600}
        @media(max-width:800px){#molstudio-document-pages{left:58px;top:88px;bottom:100px;width:min(158px,calc(100vw - 100px))}#molstudio-document-pages[data-collapsed="true"]{width:32px}}
      `;
      doc.head.appendChild(style);

      const head = doc.createElement('div'); head.className = 'doc-pages-head';
      this.title = doc.createElement('span'); this.title.className = 'doc-pages-title'; this.title.textContent = '页面';
      this.toggle = doc.createElement('button'); this.toggle.type = 'button'; this.toggle.className = 'doc-pages-toggle';
      this.toggle.dataset.docAction = 'toggle-pages'; this.toggle.title = '折叠页面缩略栏'; this.toggle.setAttribute('aria-label', '折叠页面缩略栏');
      this.toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
      head.append(this.title, this.toggle);
      this.list = doc.createElement('div'); this.list.className = 'doc-pages-list'; this.list.setAttribute('role', 'list');
      this.list.addEventListener('scroll', () => this.updateVisible());
      this.root.append(head, this.list); doc.body.appendChild(this.root);

      const saved = this.readPreference();
      this.collapsed = saved === null ? (root.innerWidth <= 800) : saved;
      this.cards = new Map(); this.cache = new Map(); this.visibleIds = new Set();
      this.generation = 0; this.renderTimer = null; this.rendering = false; this.pendingRender = false;
      this.signature = ''; this.visualRevision = 0;
      this.setCollapsed(this.collapsed, false);
      const Observer = root.IntersectionObserver;
      if (Observer) {
        this.intersection = new Observer(entries => {
          for (const entry of entries) {
            const id = entry.target.dataset.pageId;
            if (entry.isIntersecting) this.visibleIds.add(id); else this.visibleIds.delete(id);
          }
          this.applyVisibleCache(); this.scheduleThumbnails();
        }, { root: this.list, rootMargin: '80px 0px', threshold: 0.01 });
      }
      this.unsubscribe = c.subscribe(() => this.refresh());
      this.unsubscribeMechanism = c.mechanism?.model?.onChange?.(() => {
        this.visualRevision++; this.refresh();
      });
      this.resizeHandler = () => { this.applyResponsiveWidth(); this.updateViewportInsets(); };
      root.addEventListener('resize', this.resizeHandler);
      this.frameEvents = [];
      try {
        const frame = c.iframe?.contentWindow;
        if (frame) for (const name of ['wheel', 'pointerup', 'mouseup', 'click']) {
          const handler = () => this.refreshActivePage();
          frame.addEventListener(name, handler, { passive: true }); this.frameEvents.push([frame, name, handler]);
        }
      } catch (_) {}
      this.refresh();
    }

    syncNativeZoomMode() {
      try {
        const frameDoc = this.controller.iframe?.contentDocument;
        if (!frameDoc?.documentElement) return;
        let style = frameDoc.getElementById('molstudio-paper-native-zoom-style');
        if (!style) {
          style = frameDoc.createElement('style'); style.id = 'molstudio-paper-native-zoom-style';
          style.textContent = 'html.molstudio-paper-mode button[data-testid="zoom-selector"]{display:none!important}';
          frameDoc.head?.appendChild(style);
        }
        const paperMode = !!this.controller.active && this.controller.state?.mode === 'paper';
        frameDoc.documentElement.classList.toggle('molstudio-paper-mode', paperMode);
      } catch (_) {}
    }

    readPreference() {
      try { const v = root.localStorage.getItem(PREF_KEY); return v === 'true' ? true : v === 'false' ? false : null; }
      catch (_) { return null; }
    }
    setCollapsed(value, persist = true) {
      this.collapsed = !!value;
      if (!this.root) return;
      this.root.dataset.collapsed = String(this.collapsed);
      this.applyResponsiveWidth();
      this.toggle.textContent = this.collapsed ? '›' : '‹';
      this.toggle.title = this.collapsed ? '展开页面缩略栏' : '折叠页面缩略栏';
      this.toggle.setAttribute('aria-label', this.toggle.title);
      this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
      if (persist) try { root.localStorage.setItem(PREF_KEY, String(this.collapsed)); } catch (_) {}
      this.updateViewportInsets();
      if (!this.collapsed) { this.updateVisible(); this.scheduleThumbnails(); }
    }

    applyResponsiveWidth() {
      if (!this.root) return;
      const mobile = root.innerWidth <= 800;
      const width = this.collapsed ? (mobile ? 32 : 34)
        : Math.min(158, mobile ? Math.max(0, root.innerWidth - 100) : 158);
      this.root.style.width = `${width}px`;
      this.root.style.padding = this.collapsed ? '4px' : '7px';
    }

    stateSignature() {
      const state = this.controller.state;
      if (!state) return '';
      // Object presentation (shape/fill/stroke/line and image crop included)
      // is part of the thumbnail. Asset bytes stay out of the signature: an
      // image replacement gets a new asset id, while crop and geometry live
      // on the object itself.
      const objects = state.objects || [];
      const assets = Object.entries(state.assets || {}).map(([id, a]) => [id, a.mime, a.data?.length]);
      return JSON.stringify([this.controller.active, state.mode, state.page, state.pages, objects, assets, this.visualRevision]);
    }

    refresh() {
      const c = this.controller, state = c.state;
      this.root.hidden = !c.active || state?.mode !== 'paper';
      this.syncNativeZoomMode();
      this.updateViewportInsets();
      if (this.root.hidden) return;
      const pages = state.pages || [], existing = new Set(pages.map(p => p.id));
      for (const [id, card] of this.cards) if (!existing.has(id)) {
        this.intersection?.unobserve(card); this.cards.delete(id); card.remove();
        this.visibleIds.delete(id); this.dropCache(id);
      }
      pages.forEach((page, index) => {
        let card = this.cards.get(page.id);
        if (!card) { card = this.createCard(page.id); this.cards.set(page.id, card); this.intersection?.observe(card); }
        card.dataset.pageIndex = String(index);
        card.setAttribute('aria-label', `跳转到第 ${index + 1} 页`);
        card.querySelector('.doc-page-label').textContent = `第 ${index + 1} 页`;
        const size = state.page || {}, width = size.width || 595.28, height = size.height || 841.89;
        const preview = card.querySelector('.doc-page-preview');
        preview.style.height = `${Math.min(148, 105 * height / width)}px`;
        if (this.list.children[index] !== card) this.list.insertBefore(card, this.list.children[index] || null);
      });
      const active = c.getActivePage?.();
      for (const [id, card] of this.cards) {
        if (id === active?.id) card.setAttribute('aria-current', 'page'); else card.removeAttribute('aria-current');
      }
      const signature = this.stateSignature();
      if (signature !== this.signature) { this.signature = signature; this.generation++; }
      this.updateVisible(); this.applyVisibleCache();
      if (signature !== this.lastRenderedSignature) this.scheduleThumbnails();
    }

    createCard(pageId) {
      const card = this.doc.createElement('button'); card.type = 'button'; card.className = 'doc-page-card';
      card.dataset.pageId = pageId; card.dataset.docAction = 'go-to-page'; card.setAttribute('role', 'listitem');
      const preview = this.doc.createElement('span'); preview.className = 'doc-page-preview'; preview.dataset.ready = 'false'; preview.dataset.docPagePreview = '1';
      const img = this.doc.createElement('img'); img.alt = ''; img.draggable = false;
      const placeholder = this.doc.createElement('span'); placeholder.className = 'doc-page-placeholder'; placeholder.textContent = '页面预览';
      preview.append(img, placeholder);
      const label = this.doc.createElement('span'); label.className = 'doc-page-label';
      card.append(preview, label);
      card.addEventListener('click', () => {
        try { this.controller.scrollToPage(pageId); this.refreshActivePage(); }
        catch (error) { this.controller.status(error.message); }
      });
      return card;
    }

    refreshActivePage() {
      if (this.root?.hidden) return;
      const active = this.controller.getActivePage?.();
      for (const [id, card] of this.cards) {
        if (id === active?.id) card.setAttribute('aria-current', 'page'); else card.removeAttribute('aria-current');
      }
    }

    updateViewportInsets() {
      const c = this.controller;
      if (typeof c.setPaperViewportInsets !== 'function') return;
      const next = { left: 0, right: 0, top: 0, bottom: 0 };
      if (!this.root.hidden && c.active && c.state?.mode === 'paper') {
        try {
          const frame = c.iframe.getBoundingClientRect();
          const area = c.adapter.ed.render.clientArea.getBoundingClientRect();
          const viewport = { left: frame.left + area.left, right: frame.left + area.right,
            top: frame.top + area.top, bottom: frame.top + area.bottom };
          const sidebar = this.root.getBoundingClientRect();
          const mobile = root.innerWidth <= 800;
          const intendedWidth = this.collapsed ? (mobile ? 32 : 34)
            : Math.min(158, mobile ? Math.max(0, root.innerWidth - 100) : 158);
          next.left = Math.max(0, sidebar.left + intendedWidth - viewport.left);
          const visible = element => element && !element.hidden && root.getComputedStyle(element).display !== 'none';
          const panel = this.insetElements?.panel;
          if (visible(panel)) {
            const r = panel.getBoundingClientRect();
            if (r.left < viewport.right && r.right > viewport.left && r.bottom > viewport.top && r.top < viewport.bottom)
              next.right = Math.max(0, viewport.right - r.left);
          }
          const toolbar = this.insetElements?.toolbar;
          if (visible(toolbar)) {
            const r = toolbar.getBoundingClientRect();
            if (r.top <= viewport.top + 8 && r.right > viewport.left && r.left < viewport.right)
              next.top = Math.max(0, r.bottom - viewport.top);
          }
          const status = this.insetElements?.status;
          if (visible(status)) {
            const r = status.getBoundingClientRect();
            if (r.bottom >= viewport.bottom - 8 && r.right > viewport.left && r.left < viewport.right)
              next.bottom = Math.max(0, viewport.bottom - r.top);
          }
          next.left = Math.min(next.left, Math.max(0, area.width - 80));
          next.right = Math.min(next.right, Math.max(0, area.width - next.left - 80));
          next.top = Math.min(next.top, Math.max(0, area.height - 80));
          next.bottom = Math.min(next.bottom, Math.max(0, area.height - next.top - 80));
        } catch (_) {}
      }
      if (this.lastInsets && ['left', 'right', 'top', 'bottom'].every(key => Math.abs(this.lastInsets[key] - next[key]) < 0.5)) return;
      this.lastInsets = next;
      try { c.setPaperViewportInsets(next); } catch (_) {}
    }

    updateVisible() {
      if (!this.list || this.collapsed || this.root.hidden) { this.visibleIds.clear(); return; }
      if (this.intersection) return;
      const r = this.list.getBoundingClientRect();
      for (const [id, card] of this.cards) {
        const cr = card.getBoundingClientRect();
        if (cr.bottom >= r.top - 80 && cr.top <= r.bottom + 80) this.visibleIds.add(id); else this.visibleIds.delete(id);
      }
      this.applyVisibleCache(); this.scheduleThumbnails();
    }

    applyVisibleCache() {
      for (const id of this.visibleIds) {
        const card = this.cards.get(id), cached = this.cache.get(id);
        if (!card) continue;
        const preview = card.querySelector('.doc-page-preview'), img = preview.querySelector('img');
        if (cached && cached.signature === this.signature) {
          cached.used = Date.now(); img.src = cached.src; preview.dataset.ready = 'true';
        } else {
          if (img.src && cached?.src !== img.src) img.removeAttribute('src');
          preview.dataset.ready = 'false';
          preview.querySelector('.doc-page-placeholder').textContent = '页面预览';
        }
      }
    }

    scheduleThumbnails() {
      if (!this.root || this.root.hidden || this.collapsed || !this.visibleIds.size) return;
      clearTimeout(this.renderTimer);
      const generation = this.generation;
      this.renderTimer = root.setTimeout(() => this.renderVisibleThumbnails(generation), 500);
    }

    async renderVisibleThumbnails(generation) {
      if (this.rendering) { this.pendingRender = true; return; }
      const pageIds = [...this.visibleIds].filter(id => {
        const entry = this.cache.get(id); return !entry || entry.signature !== this.signature;
      });
      if (!pageIds.length || this.root.hidden || this.collapsed) return;
      const signature = this.signature;
      this.rendering = true;
      try {
        const c = this.controller;
        const renderer = typeof c.previewPages === 'function' ? c.previewPages : c.exportPages;
        if (typeof renderer !== 'function') throw new Error('页面预览接口不可用');
        const result = await renderer.call(c, pageIds);
        if (generation !== this.generation || signature !== this.signature || !result?.ok) return;
        const allowed = new Set(this.visibleIds);
        for (const page of result.pages || []) {
          if (!allowed.has(page.id) || !pageIds.includes(page.id)) continue;
          const src = root.URL?.createObjectURL ? root.URL.createObjectURL(new root.Blob([page.svg], { type: 'image/svg+xml;charset=utf-8' }))
            : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(page.svg)}`;
          this.dropCache(page.id);
          this.cache.set(page.id, { signature, src, used: Date.now() });
        }
        this.lastRenderedSignature = signature;
        this.trimCache(); this.applyVisibleCache();
      } catch (_) {
        for (const id of pageIds) {
          const card = this.cards.get(id); if (card) card.querySelector('.doc-page-placeholder').textContent = '预览不可用';
        }
      } finally {
        this.rendering = false;
        if (this.pendingRender) { this.pendingRender = false; this.scheduleThumbnails(); }
      }
    }

    trimCache() {
      while (this.cache.size > MAX_THUMBNAILS) {
        const candidate = [...this.cache.entries()].filter(([id]) => !this.visibleIds.has(id)).sort((a, b) => a[1].used - b[1].used)[0]
          || [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (!candidate) break;
        this.dropCache(candidate[0]);
      }
    }

    dropCache(id) {
      const old = this.cache?.get(id); if (!old) return;
      const card = this.cards?.get(id);
      if (card) {
        const img = card.querySelector('img');
        if (img.src === old.src) { img.removeAttribute('src'); card.querySelector('.doc-page-preview').dataset.ready = 'false'; }
      }
      if (old.src.startsWith('blob:')) try { root.URL.revokeObjectURL(old.src); } catch (_) {}
      this.cache.delete(id);
    }
  }

  MW.documentPagesUI = { DocumentPagesUI };
})(typeof window === 'object' ? window : globalThis);
