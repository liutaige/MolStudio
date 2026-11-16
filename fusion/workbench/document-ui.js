/* Compact document controls. Chemistry stays in the native Ketcher toolbar. */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  class DocumentUI {
    constructor(options) { Object.assign(this, options); }
    mount() {
      const doc = this.doc, c = this.controller;
      const style = doc.createElement('style'); style.textContent = `
      #molstudio-document-toolbar{position:fixed;top:48px;left:56px;z-index:25;display:flex;gap:3px;align-items:center;padding:4px 5px;background:#fffffff5;border:1px solid #d7dde2;border-radius:8px;box-shadow:0 2px 8px #20304412;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d}
      #molstudio-document-toolbar button,#molstudio-document-toolbar select{height:26px;border:0;border-radius:4px;background:transparent;color:inherit;padding:0 7px;font:inherit;cursor:pointer}
      #molstudio-document-toolbar button:hover,#molstudio-document-toolbar button[aria-pressed=true]{background:#e4f2f8;color:#086c91}
      #molstudio-document-toolbar .doc-separator{height:18px;border-left:1px solid #d7dde2;margin:0 3px}
      #molstudio-document-panel{position:fixed;right:18px;top:100px;z-index:26;width:210px;padding:14px;background:#fffffff5;border:1px solid #d7dde2;border-radius:10px;box-shadow:0 5px 24px #20304418;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d}
      #molstudio-document-panel[hidden]{display:none}#molstudio-document-panel label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:9px 0}#molstudio-document-panel input,#molstudio-document-panel select{box-sizing:border-box;width:112px;height:27px;border:1px solid #d2d9e0;border-radius:4px;background:white;padding:3px 5px;font:inherit}#molstudio-document-panel input[type=color]{width:40px;padding:2px}#molstudio-document-panel button{font:inherit;border:1px solid #d2d9e0;border-radius:5px;background:#f8fafc;padding:5px 8px;cursor:pointer}#molstudio-document-panel .doc-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}#molstudio-document-panel .doc-section-title{margin:15px 0 4px;font-weight:600;color:#44535e}
      #molstudio-document-status{position:fixed;bottom:10px;left:340px;z-index:24;display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:6px;background:#fffffff0;font:11px -apple-system,PingFang SC,sans-serif;color:#687784}#molstudio-document-status[hidden]{display:none}#molstudio-document-status button{border:0;border-radius:4px;background:transparent;padding:3px 5px;color:#327994;font:inherit;cursor:pointer;white-space:nowrap}#molstudio-document-status button:hover{background:#e7f1f5}#molstudio-document-status .doc-zoom-input{box-sizing:border-box;width:48px;height:23px;border:1px solid #d2d9e0;border-radius:4px;background:#fff;color:#34424d;padding:2px 4px;font:inherit;text-align:right}#molstudio-document-status .doc-zoom-suffix{margin-left:-6px}
      @media(max-width:800px){#molstudio-document-status{left:58px;bottom:46px;max-width:calc(100vw - 66px);overflow:auto;white-space:nowrap}#molstudio-document-toolbar{left:50px;top:48px;max-width:calc(100vw - 115px);overflow:auto}#molstudio-document-toolbar button{white-space:nowrap;padding:0 5px}}
      /* 插入下拉菜单（放在现有工具栏内部；原生侧入口由原生面板负责） */
      #molstudio-document-insert-menu{position:fixed;z-index:10005;min-width:160px;padding:5px;background:#fffffff5;border:1px solid #d7dde2;border-radius:8px;box-shadow:0 5px 24px #20304418;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d;display:flex;flex-direction:column}
      #molstudio-document-insert-menu[hidden]{display:none}
      #molstudio-document-insert-menu button{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;box-sizing:border-box;height:27px;border:0;border-radius:4px;background:transparent;color:inherit;padding:0 8px;font:inherit;text-align:left;cursor:pointer}
      #molstudio-document-insert-menu button:hover,#molstudio-document-insert-menu button[aria-expanded=true]{background:#e4f2f8;color:#086c91}
      #molstudio-document-insert-menu .doc-menu-sub{margin:2px 0 2px 14px;padding:3px;border-left:1px solid #d7dde2;display:flex;flex-direction:column}
      #molstudio-document-insert-menu .doc-menu-sub[hidden]{display:none}
      .doc-menu-caret{display:inline-block;width:0;height:0;margin-left:5px;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;vertical-align:middle}
      /* 文字格式浮条（编辑器打开时出现；不带 data-document-ui） */
      #molstudio-text-format-bar{position:fixed;z-index:1001;display:flex;gap:4px;align-items:center;padding:4px 6px;background:#fffffff5;border:1px solid #d7dde2;border-radius:8px;box-shadow:0 2px 8px #20304412;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d;user-select:none}
      #molstudio-text-format-bar[hidden]{display:none}
      #molstudio-text-format-bar button,#molstudio-text-format-bar select,#molstudio-text-format-bar input{height:25px;border:1px solid #d2d9e0;border-radius:4px;background:#fff;color:inherit;padding:0 5px;font:inherit;cursor:pointer}
      #molstudio-text-format-bar button{border:0;background:transparent;min-width:24px}
      #molstudio-text-format-bar button:hover{background:#e4f2f8;color:#086c91}
      #molstudio-text-format-bar input[type=number]{width:48px;text-align:right}
      #molstudio-text-format-bar input[type=color]{width:32px;padding:1px}
      #molstudio-text-format-bar[aria-disabled=true]{opacity:.45;pointer-events:none}
      /* 3D 分子交互浮层与候选/立体化学对话框（不带 data-document-ui） */
      .molstudio-3d-host canvas{display:block}
      `; doc.head.appendChild(style);
      const bar = this.bar = doc.createElement('div'); bar.id = 'molstudio-document-toolbar'; bar.dataset.documentUi = '1'; bar.setAttribute('aria-label', '纸页与混排工具');
      const button = (text, attr, value, fn, title) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute(attr, value); b.title = title || text; b.addEventListener('click', fn); bar.appendChild(b); return b; };
      button('页面', 'data-doc-action', 'page-setup', () => this.showPageSetup());
      const separator = () => { const s = doc.createElement('span'); s.className = 'doc-separator'; bar.appendChild(s); }; separator();
      button('↖', 'data-doc-tool', 'select', () => c.setTool('select'), '选择文档对象；拖框可同时选择结构与文档');
      button('文字', 'data-doc-tool', 'text', () => c.setTool('text'), '拖出文本框，双击编辑');
      button('图片', 'data-doc-action', 'image', () => this.pickImage(), '插入图片，也可拖放图片文件');
      const shapes = doc.createElement('select'); shapes.setAttribute('aria-label', '形状工具'); shapes.dataset.docAction = 'shape';
      for (const [value, text] of [['', '形状…'], ['rect', '矩形'], ['roundRect', '圆角矩形'], ['ellipse', '椭圆'], ['line', '直线'], ['arrow', '普通箭头'], ['polygon', '三角形'], ['bracket', '方括号']]) { const o = doc.createElement('option'); o.value = value; o.textContent = text; shapes.appendChild(o); }
      shapes.addEventListener('change', () => { if (shapes.value) { c.setTool(shapes.value); shapes.value = ''; } }); bar.appendChild(shapes);
      this.mountInsertMenu(c);
      separator(); button('属性', 'data-doc-action', 'properties', () => this.showProperties());
      doc.body.appendChild(bar);
      this.panel = doc.createElement('div'); this.panel.id = 'molstudio-document-panel'; this.panel.dataset.documentUi = '1'; this.panel.hidden = true; doc.body.appendChild(this.panel);
      this.status = doc.createElement('div'); this.status.id = 'molstudio-document-status'; this.status.dataset.documentUi = '1';
      this.statusText = doc.createElement('span'); this.status.appendChild(this.statusText);
      this.status.appendChild(doc.createTextNode(' · 纸页'));
      this.zoomInput = doc.createElement('input'); this.zoomInput.className = 'doc-zoom-input'; this.zoomInput.type = 'number'; this.zoomInput.step = '1'; this.zoomInput.min = '16.7'; this.zoomInput.max = '833.3'; this.zoomInput.setAttribute('aria-label', '纸页缩放百分比'); this.zoomInput.title = '纸页显示比例；100%按当前印刷尺寸显示'; this.zoomInput.dataset.docAction = 'paper-zoom';
      const commitZoom = () => { try { c.setPaperZoom(Number(this.zoomInput.value)); } catch (e) { c.status(e.message); this.refresh(); } };
      this.zoomInput.addEventListener('change', commitZoom); this.zoomInput.addEventListener('keydown', e => { if (e.key === 'Enter') { commitZoom(); this.zoomInput.blur(); } });
      this.status.appendChild(this.zoomInput);
      const suffix = doc.createElement('span'); suffix.className = 'doc-zoom-suffix'; suffix.textContent = '%'; this.status.appendChild(suffix);
      const zoom100 = doc.createElement('button'); zoom100.textContent = '100%'; zoom100.title = '按印刷比例显示'; zoom100.dataset.docAction = 'paper-zoom-100'; zoom100.onclick = () => c.setPaperZoom(100); this.status.appendChild(zoom100);
      for (const [label, action, fn] of [['适合页面', 'fit-page', () => c.fitPage()], ['适合宽度', 'fit-width', () => c.fitWidth()]]) { const b = doc.createElement('button'); b.textContent = label; b.dataset.docAction = action; b.onclick = fn; this.status.appendChild(b); }
      doc.body.appendChild(this.status); c.subscribe(() => this.refresh());
      this.mountScaleToolbar(c);
      this.mountMolecule3DInjections(c);
      this.recordContractAvailability(c);
      this.watchEditorForBar(c);
      try { for (const name of ['wheel', 'pointerup', 'mouseup', 'click']) c.iframe?.contentWindow?.addEventListener(name, () => this.refresh(), { passive: true }); } catch (_) {}
      this.refresh();
      if (MW.documentPagesUI?.DocumentPagesUI) { this.pagesUI = new MW.documentPagesUI.DocumentPagesUI({ doc, controller: c, insetElements: { toolbar: this.bar, panel: this.panel, status: this.status } }); this.pagesUI.mount(); }
    }
    /* ---------------- 选区缩放：注入 Ketcher 悬浮工具条 ----------------
     * 悬浮条是 Ketcher iframe 内 React 渲染的 div[data-testid="floating-tools"]
     * （实测类名 FloatingTools-module_wrapper__OFeE9），子按钮依次为
     * transform-flip-h / transform-flip-v / float-delete。用 MutationObserver
     * 跟随其出现，紧跟垃圾桶按钮注入「缩放」按钮与百分比输入。 */
    mountScaleToolbar(c) {
      const iframeDoc = c.iframe?.contentDocument, Observer = this.doc.defaultView.MutationObserver;
      if (!iframeDoc || typeof Observer !== 'function') return;
      let timer = null;
      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; try { this.syncScaleToolbar(c); } catch (_) {} }, 60);
      };
      this.scaleToolbarObserver = new Observer(schedule);
      this.scaleToolbarObserver.observe(iframeDoc.documentElement, { childList: true, subtree: true });
      schedule();
    }
    scaleToolbarUsable(c) { return c.hasScaleSelection?.() === true || c.scaleMode === true; }
    syncScaleToolbar(c) {
      const iframeDoc = c.iframe?.contentDocument;
      if (!iframeDoc) return;
      const bar = iframeDoc.querySelector('[data-testid="floating-tools"]');
      const btn = iframeDoc.querySelector('[data-doc-scale-control="button"]');
      const wrap = iframeDoc.querySelector('[data-doc-scale-control="wrap"]');
      // 悬浮条不在时只清理注入节点：scaleMode 的开关始终由按钮/Esc/模式复位负责，
      // 不能在这里反向关闭（refresh 会在 setScaleMode 内部被触发，造成互相打架）。
      if (!bar) return;
      if (!this.scaleToolbarUsable(c)) { btn?.remove(); wrap?.remove(); return; }
      const input = wrap?.querySelector('input');
      if (!btn || !btn.isConnected || !wrap || !wrap.isConnected) {
        btn?.remove(); wrap?.remove();
        const next = this.buildScaleToolbarControls(c, iframeDoc);
        const trash = bar.querySelector('[data-testid="float-delete"]') || bar.lastElementChild;
        if (trash?.after) { trash.after(next.wrap); trash.after(next.btn); }
        else { bar.append(next.btn, next.wrap); }
        return;
      }
      const active = c.scaleMode === true;
      btn.setAttribute('aria-pressed', String(active));
      wrap.hidden = !active;
      if (!active && input && iframeDoc.activeElement !== input) input.value = '100';
      if (active && input && iframeDoc.activeElement !== input) {
        const percent = c.currentSessionPercent?.();
        if (Number.isFinite(percent)) input.value = Number(percent).toFixed(0);
      }
    }
    buildScaleToolbarControls(c, iframeDoc) {
      const btn = iframeDoc.createElement('button');
      btn.type = 'button'; btn.dataset.docScaleControl = 'button';
      btn.setAttribute('aria-label', '缩放选区'); btn.setAttribute('aria-pressed', 'false');
      btn.title = '点击后拖动控制点缩放；再点或 Esc 退出';
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:48px;height:48px;border:0;background:transparent;color:inherit;cursor:pointer;padding:0';
      btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 20 4"/><path d="M14 4h6v6"/><path d="M10 20H4v-6"/></svg>';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        try { c.setScaleMode(!c.scaleMode); } catch (err) { c.status(err.message); }
        this.syncScaleToolbar(c);
      });
      const wrap = iframeDoc.createElement('label');
      wrap.dataset.docScaleControl = 'wrap'; wrap.hidden = true;
      wrap.style.cssText = 'display:flex;align-items:center;gap:1px;height:48px;padding:0 10px;color:inherit;white-space:nowrap';
      const input = iframeDoc.createElement('input');
      input.type = 'number'; input.step = '1'; input.min = '1'; input.max = '1000'; input.value = '100';
      input.setAttribute('aria-label', '选区缩放百分比');
      input.title = '以本次缩放会话开始时的选区为基准的百分比；回车或失焦应用';
      input.style.cssText = 'box-sizing:border-box;width:54px;height:30px;border:1px solid #d2d9e0;border-radius:4px;background:#fff;color:#34424d;padding:2px 4px;font:12px -apple-system,PingFang SC,sans-serif;text-align:right';
      const suffix = iframeDoc.createElement('span'); suffix.textContent = '%'; suffix.style.cssText = 'font:12px -apple-system,PingFang SC,sans-serif;margin-left:-4px';
      const apply = () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0) { c.status('缩放百分比无效'); return; }
        try { c.beginScaleSession(); c.applyScalePercent(value); } catch (err) { c.status(err.message); }
        this.syncScaleToolbar(c);
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { apply(); input.blur(); }
        else if (e.key === 'Escape') { e.stopPropagation(); input.blur(); try { c.setScaleMode(false); } catch (_) {} }
      });
      input.addEventListener('change', apply);
      wrap.append(input, suffix);
      btn.addEventListener('mousedown', e => e.preventDefault());
      return { btn, wrap };
    }
    /* ---------------- 任务 A：插入菜单（下拉） ---------------- */
    mountInsertMenu(c) {
      const doc = this.doc;
      const btn = this.insertMenuButton = doc.createElement('button');
      btn.type = 'button'; btn.dataset.docAction = 'insert-menu';
      btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
      btn.title = '插入文本框、图片、形状或 3D 分子预览';
      const label = doc.createElement('span'); label.textContent = '插入';
      const caret = doc.createElement('span'); caret.className = 'doc-menu-caret'; caret.setAttribute('aria-hidden', 'true');
      btn.append(label, caret);
      btn.addEventListener('click', () => this.toggleInsertMenu());
      this.bar.appendChild(btn);
      const menu = this.insertMenu = doc.createElement('div');
      menu.id = 'molstudio-document-insert-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '插入菜单'); menu.hidden = true;
      const item = (text, fn, title) => {
        const b = doc.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
        b.textContent = text; b.title = title || text;
        b.addEventListener('click', () => { this.closeInsertMenu(); fn(); });
        menu.appendChild(b); return b;
      };
      item('文本框', () => c.setTool('text'), '插入文本框：拖出区域后直接输入');
      item('图片…', () => this.pickImage(), '插入图片文件');
      const shapeHost = item('形状', () => this.toggleShapeSubmenu(), '选择形状类型');
      shapeHost.dataset.docAction = 'insert-shape';
      const caretShape = doc.createElement('span'); caretShape.className = 'doc-menu-caret'; caretShape.setAttribute('aria-hidden', 'true');
      shapeHost.append(caretShape);
      const sub = this.insertShapeSubmenu = doc.createElement('div'); sub.className = 'doc-menu-sub'; sub.setAttribute('role', 'menu'); sub.hidden = true;
      for (const [value, text] of [['rect', '矩形'], ['roundRect', '圆角矩形'], ['ellipse', '椭圆'], ['line', '直线'], ['arrow', '普通箭头'], ['polygon', '三角形'], ['bracket', '方括号']]) {
        const b = doc.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.dataset.docShape = value; b.textContent = text;
        b.addEventListener('click', () => { this.closeInsertMenu(); c.setTool(value); });
        sub.appendChild(b);
      }
      menu.appendChild(sub);
      item('3D 分子预览', () => this.insert3DFlow(), '根据当前源结构插入可交互的 3D 分子预览');
      doc.body.appendChild(menu);
      doc.addEventListener('pointerdown', e => {
        if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) this.closeInsertMenu();
      }, true);
      doc.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); this.closeInsertMenu(); btn.focus(); }
      }, true);
    }
    toggleInsertMenu() {
      const menu = this.insertMenu, btn = this.insertMenuButton;
      if (!menu || !btn) return;
      if (!menu.hidden) { this.closeInsertMenu(); return; }
      const rect = btn.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(rect.left, this.doc.defaultView.innerWidth - 180)) + 'px';
      menu.style.top = rect.bottom + 4 + 'px';
      menu.hidden = false; this.insertShapeSubmenu.hidden = true;
      btn.setAttribute('aria-expanded', 'true');
      const first = menu.querySelector('button'); first?.focus();
    }
    toggleShapeSubmenu() { if (this.insertShapeSubmenu) this.insertShapeSubmenu.hidden = !this.insertShapeSubmenu.hidden; }
    closeInsertMenu() {
      if (this.insertMenu) { this.insertMenu.hidden = true; if (this.insertShapeSubmenu) this.insertShapeSubmenu.hidden = true; }
      this.insertMenuButton?.setAttribute('aria-expanded', 'false');
    }
    async insert3DFlow() {
      const c = this.controller;
      if (typeof c.insertMolecule3DPreview !== 'function') { c.status('3D 分子预览插入功能尚未就绪'); return; }
      c.status('正在生成 3D 模型…');
      try {
        const result = await c.insertMolecule3DPreview({});
        if (result?.ok) c.status('已插入 3D 分子预览，双击可交互');
        else if (result?.cancelled) c.status('已取消插入 3D 分子预览');
        else c.status(result?.error || '插入 3D 分子预览失败');
        return result;
      } catch (e) { c.status('插入 3D 分子预览失败：' + e.message); return { ok: false, error: e.message }; }
    }
    /* ---------------- 接口契约可用性审计（报告用） ---------------- */
    recordContractAvailability(c) {
      const names = ['insertMolecule3DPreview', 'onChooseMolecule3DTarget', 'onStereoChoiceRequired', 'onMolecule3DActivate',
        'finishMolecule3DInteraction', 'updateMolecule3DFromSource', 'applyTextFormat', 'alignSelection',
        'addMolecule3D', 'textCommand', 'editText', 'updateObject', 'modelToClient', 'buildEditorDom', 'rebuildEditorFromRich', 'positionEditor'];
      const availability = Object.fromEntries(names.map(name => [name, typeof c[name] === 'function']));
      availability.insert3DInteractionActive = c.insert3DInteractionActive === true;
      availability.documentRichText = typeof MW.documentRichText?.applyFormat === 'function';
      availability.documentObject3D = typeof MW.documentObject3D?.InteractionSession === 'function';
      this.contractAvailability = availability;
      MW.documentUI.contractAvailability = availability;
    }
    /* ---------------- 任务 B：3D 对象回调注入 ---------------- */
    mountMolecule3DInjections(c) {
      c.onChooseMolecule3DTarget = candidates => this.chooseMolecule3DTarget(candidates);
      c.onStereoChoiceRequired = stereo => this.confirmStereoExample(stereo);
      c.onMolecule3DActivate = id => this.open3DInteraction(id);
      c.onPreviewMolecule3D = (draft, options) => this.open3DInteraction(null, draft, options);
    }
    /* 通用小型对话框：返回 Promise<boolean>；Esc/取消为 false */
    openModalDialog(options) {
      const doc = this.doc, c = this.controller;
      const backdrop = doc.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:10020;background:#20304422;display:flex;align-items:center;justify-content:center';
      const box = doc.createElement('div');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      box.style.cssText = 'max-width:460px;min-width:300px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #d7dde2;border-radius:10px;box-shadow:0 8px 32px #20304433;padding:16px;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d';
      if (options.title) { const h = doc.createElement('div'); h.style.cssText = 'font-weight:600;margin-bottom:8px'; h.textContent = options.title; box.appendChild(h); }
      if (options.body) box.appendChild(options.body);
      const actions = doc.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px';
      const mk = (text, value, primary) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = 'font:inherit;border:1px solid #d2d9e0;border-radius:5px;background:#f8fafc;padding:5px 10px;cursor:pointer' + (primary ? ';background:#086c91;color:#fff;border-color:#086c91' : ''); b.onclick = () => settle(value); actions.appendChild(b); return b; };
      for (const b of options.buttons || []) mk(b.text, b.value, b.primary);
      box.appendChild(actions); backdrop.appendChild(box); doc.body.appendChild(backdrop);
      let done = false;
      const settle = value => { if (done) return; done = true; doc.removeEventListener('keydown', keyHandler, true); backdrop.remove(); this.modalDialogOpen = false; resolve(value); };
      const keyHandler = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(options.escapeValue ?? false); } };
      doc.addEventListener('keydown', keyHandler, true);
      this.modalDialogOpen = true;
      let resolve;
      const promise = new Promise(res => { resolve = res; });
      actions.querySelector('button')?.focus();
      return promise;
    }
    async chooseMolecule3DTarget(candidates) {
      const list = Array.isArray(candidates) ? candidates : [];
      if (!list.length) { this.controller.status('未找到可生成 3D 预览的分子'); return null; }
      const doc = this.doc;
      const backdrop = doc.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:10020;background:#20304422;display:flex;align-items:center;justify-content:center';
      const box = doc.createElement('div');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '选择分子');
      box.style.cssText = 'min-width:320px;background:#fff;border:1px solid #d7dde2;border-radius:10px;box-shadow:0 8px 32px #20304433;padding:16px;font:12px -apple-system,PingFang SC,sans-serif;color:#34424d';
      const title = doc.createElement('div'); title.style.cssText = 'font-weight:600;margin-bottom:4px'; title.textContent = '选择分子';
      const note = doc.createElement('p'); note.textContent = '画布上有多个分子，请选择要生成 3D 预览的一个：'; note.style.cssText = 'margin:0 0 8px;color:#7a8790';
      box.append(title, note);
      let chosen = null, resolve = null;
      const promise = new Promise(res => { resolve = res; });
      const settle = value => { if (!resolve) return; const r = resolve; resolve = null; doc.removeEventListener('keydown', keyHandler, true); backdrop.remove(); r(value); };
      const rows = list.map((candidate, index) => {
        const row = doc.createElement('button'); row.type = 'button'; row.dataset.docMoleculeCandidate = String(index);
        row.setAttribute('role', 'option');
        row.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;border:1px solid #d2d9e0;border-radius:5px;background:#f8fafc;padding:6px 8px;margin:4px 0;cursor:pointer';
        const size = candidate && (candidate.size ?? (Array.isArray(candidate.atomUuids) ? candidate.atomUuids.length : null));
        row.textContent = `分子 ${index + 1}（${Number.isFinite(size) ? size : '?'} 个原子）`;
        row.onclick = () => { chosen = candidate; for (const r of rows) r.style.borderColor = '#d2d9e0'; row.style.borderColor = '#086c91'; confirmBtn.disabled = false; };
        box.appendChild(row); return row;
      });
      const actions = doc.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
      const cancelBtn = doc.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'font:inherit;border:1px solid #d2d9e0;border-radius:5px;background:#f8fafc;padding:5px 10px;cursor:pointer';
      cancelBtn.onclick = () => settle(null);
      const confirmBtn = doc.createElement('button'); confirmBtn.type = 'button'; confirmBtn.textContent = '确认'; confirmBtn.disabled = true;
      confirmBtn.style.cssText = 'font:inherit;border:1px solid #086c91;border-radius:5px;background:#086c91;color:#fff;padding:5px 10px;cursor:pointer';
      confirmBtn.onclick = () => settle(chosen);
      actions.append(cancelBtn, confirmBtn); box.appendChild(actions);
      backdrop.appendChild(box); doc.body.appendChild(backdrop);
      const keyHandler = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(null); } };
      doc.addEventListener('keydown', keyHandler, true);
      rows[0]?.focus();
      return promise;
    }
    async confirmStereoExample(stereo) {
      const doc = this.doc, body = doc.createElement('div');
      const p = doc.createElement('p');
      p.textContent = '该结构缺少立体标注，无法唯一确定 3D 构型。可以使用一套示例构型继续，或取消。';
      p.style.cssText = 'margin:0 0 8px'; body.appendChild(p);
      const pre = doc.createElement('pre');
      pre.style.cssText = 'margin:0;padding:8px;background:#f4f7f9;border-radius:6px;white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace;color:#44535e';
      const lines = [];
      if (stereo?.counts) for (const [key, value] of Object.entries(stereo.counts)) lines.push(`${key}: ${value}`);
      if (stereo?.molecules !== undefined) lines.push(`molecules: ${typeof stereo.molecules === 'string' ? stereo.molecules : JSON.stringify(stereo.molecules)}`);
      pre.textContent = lines.join('\n') || '（无详细立体信息）';
      body.appendChild(pre);
      return this.openModalDialog({ title: '立体化学提示', body, escapeValue: false,
        buttons: [ { text: '取消', value: false }, { text: '使用示例构型', value: true, primary: true } ] });
    }
    /* ---------------- 3D 插入预览与视角编辑 ---------------- */
    async open3DInteraction(id, draft, options = {}) {
      const c = this.controller, doc = this.doc, o = draft || c.object(id);
      if (!o || (!draft && o.kind !== 'molecule3d')) { c.status('3D 对象不存在'); return false; }
      if (typeof MW.documentObject3D?.InteractionSession !== 'function') throw new Error('3D 交互模块未就绪');
      if (this.active3D) {
        if (id && this.active3D.id === id) return true;
        c.status('请先确认或取消当前 3D 预览');
        return draft ? { ok: false, cancelled: true } : false;
      }
      const backdrop = doc.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:10010;background:#20304433;display:flex;align-items:center;justify-content:center';
      const overlay = doc.createElement('div');
      overlay.id = 'molstudio-3d-interaction'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', draft ? '插入 3D 分子预览' : '调整 3D 视角');
      overlay.style.cssText = 'background:#fff;border:1px solid #cdd8df;border-radius:12px;box-shadow:0 8px 32px #20304433;display:flex;flex-direction:column;padding:14px;box-sizing:border-box;font:13px -apple-system,PingFang SC,sans-serif;color:#34424d;max-height:calc(100vh - 24px);overflow:auto';
      const title = doc.createElement('strong'); title.textContent = draft ? '插入 3D 分子预览' : '调整 3D 视角';
      const hint = doc.createElement('p'); hint.textContent = '拖动旋转 · 双指滑动平移 · 捏合缩放。确认后保存透明背景预览。';
      hint.style.cssText = 'margin:8px 0 12px;color:#687784;font-size:12px;line-height:1.5';
      const host = doc.createElement('div'); host.className = 'molstudio-3d-host';
      host.style.cssText = 'width:100%;flex-shrink:0;position:relative;background-color:#fff;background-image:conic-gradient(#edf1f4 25%,transparent 0 50%,#edf1f4 0 75%,transparent 0);background-size:20px 20px;border-radius:6px;overflow:hidden';
      const controls = doc.createElement('div'); controls.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap';
      const styleSel = doc.createElement('select'); styleSel.setAttribute('aria-label', '3D 样式');
      for (const [value, text] of [['ballstick', '球棍'], ['stick', '棍状'], ['line', '线框'], ['sphere', '空间填充']]) { const op = doc.createElement('option'); op.value = value; op.textContent = text; styleSel.appendChild(op); }
      styleSel.value = o.style || 'ballstick';
      const resetBtn = doc.createElement('button'); resetBtn.type = 'button'; resetBtn.textContent = '重置视角';
      const cancelBtn = doc.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = '取消'; cancelBtn.style.marginLeft = 'auto';
      const finishBtn = doc.createElement('button'); finishBtn.type = 'button'; finishBtn.textContent = draft ? '确认插入' : '确认保存';
      for (const control of [styleSel, resetBtn, cancelBtn, finishBtn]) control.style.cssText += ';font:inherit;padding:6px 10px;border:1px solid #cbd5dd;border-radius:5px;background:#f8fafc;color:#34424d;cursor:pointer';
      finishBtn.style.cssText += ';background:#147da5;color:#fff;border-color:#147da5';
      controls.append(styleSel, resetBtn, cancelBtn, finishBtn);
      overlay.append(title, hint, host, controls); backdrop.appendChild(overlay); doc.body.appendChild(backdrop);
      const st = { id, draft: !!draft, object: o, overlay, backdrop, host, controls, session: null, done: false,
        generation: options.generation ?? c.generation, signature: draft ? null : this.molecule3DContentSignature(o),
        previousFocus: doc.activeElement, ready: false, operation: Promise.resolve() };
      st.result = new Promise(resolve => { st.resolve = resolve; });
      this.active3D = st; c.insert3DInteractionActive = true;
      this.position3DOverlay(st, o);
      const queue = action => {
        st.operation = st.operation.then(action).catch(err => { if (!st.done) c.status('3D 预览操作失败：' + err.message); });
      };
      styleSel.onchange = () => { const style = styleSel.value; queue(() => st.session.setStyle(style)); };
      resetBtn.onclick = () => queue(() => st.session.resetView());
      cancelBtn.onclick = () => this.cancel3DInteraction();
      finishBtn.onclick = () => this.finish3DInteraction();
      st.wheelBlock = e => { if (!overlay.contains(e.target)) e.preventDefault(); };
      doc.addEventListener('wheel', st.wheelBlock, { passive: false, capture: true });
      st.keyHandler = e => {
        if (this.active3D !== st) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel3DInteraction(); }
        if (e.key === 'Tab') {
          const focusables = [st.session?.iframe, ...controls.children].filter(el => el && !el.disabled);
          const first = focusables[0], last = focusables[focusables.length - 1];
          if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      };
      doc.addEventListener('keydown', st.keyHandler, true);
      st.embedCancel = e => { if (e.source === st.session?.iframe?.contentWindow && e.data?.type === 'k3d-embed-cancel') this.cancel3DInteraction(); };
      doc.defaultView.addEventListener('message', st.embedCancel);
      st.resize = () => this.position3DOverlay(st, o);
      doc.defaultView.addEventListener('resize', st.resize);
      styleSel.disabled = resetBtn.disabled = finishBtn.disabled = true;
      cancelBtn.focus();
      try {
        const session = st.session = new MW.documentObject3D.InteractionSession({ host, serverBase: c.threedBase || '', molblock: o.molfile || o.molblock, style: o.style, camera: o.camera });
        await session.mount();
        if (!st.done) {
          st.ready = true;
          styleSel.disabled = resetBtn.disabled = finishBtn.disabled = false;
          c.status(draft ? '调整 3D 视角后，点击“确认插入”' : '调整 3D 视角后，点击“确认保存”');
        }
      } catch (err) {
        if (!st.done) { c.status('3D 预览启动失败：' + err.message); this.cleanup3DOverlay(st, { ok: false, error: err.message }); }
        return draft ? st.result : false;
      }
      return draft ? st.result : !st.done;
    }
    position3DOverlay(st, o) {
      const win = this.doc.defaultView;
      const ratio = o.w > 0 && o.h > 0 ? o.w / o.h : 4 / 3;
      const width = Math.max(160, Math.min(640, win.innerWidth - 56, Math.max(120, win.innerHeight - 210) * ratio));
      st.overlay.style.width = (width + 28) + 'px';
      st.host.style.height = (width / ratio) + 'px';
    }
    molecule3DContentSignature(o) {
      return o?.kind === 'molecule3d' ? JSON.stringify([o.molfile, o.source, o.style, o.camera, o.previewAsset]) : null;
    }
    is3DInteractionCurrent(st) {
      if (st.done) return false;
      const c = this.controller;
      const contentChanged = !st.draft && this.molecule3DContentSignature(c.object(st.id)) !== st.signature;
      if (st.generation !== c.generation || contentChanged) {
        this.cleanup3DOverlay(st, { ok: false, cancelled: true });
        c.status(contentChanged ? '3D 对象已更改，已取消此次视角编辑' : '文档已切换，已取消 3D 预览');
        return false;
      }
      return true;
    }
    reposition3DOverlay() {
      const st = this.active3D; if (!st || st.committing) return;
      if (!this.is3DInteractionCurrent(st)) return;
      this.position3DOverlay(st, st.draft ? st.object : this.controller.object(st.id));
    }
    cancel3DInteraction() {
      const st = this.active3D; if (!st) return false;
      this.cleanup3DOverlay(st, { ok: false, cancelled: true });
      return true;
    }
    async finish3DInteraction() {
      const st = this.active3D; if (!st || !st.ready || st.finishing) return st?.finishing ?? false;
      const c = this.controller;
      if (!this.is3DInteractionCurrent(st)) return false;
      st.finishing = (async () => {
        for (const control of st.controls.children) control.disabled = true;
        st.host.style.pointerEvents = 'none';
        try {
          await st.operation;
          await st.session.spin(false);
          const camera = await st.session.cameraJson();
          const ratio = st.object.w > 0 && st.object.h > 0 ? st.object.w / st.object.h : 4 / 3;
          const previewDataUrl = await st.session.snapshot({ width: 640, height: Math.round(640 / ratio), trim: true });
          if (!this.is3DInteractionCurrent(st)) return false;
          const result = { ok: true, camera, style: st.session.style, previewDataUrl };
          if (!st.draft) {
            // Our own synchronous commit changes this signature during controller render.
            st.committing = true;
            c.finishMolecule3DInteraction(st.id, result);
          }
          this.cleanup3DOverlay(st, result);
          return true;
        } catch (err) {
          if (!st.done) {
            c.status('保存 3D 视角失败：' + err.message + '；可以重试或取消');
            for (const control of st.controls.children) control.disabled = false;
            st.host.style.pointerEvents = '';
          }
          return false;
        } finally { st.committing = false; st.finishing = null; }
      })();
      return st.finishing;
    }
    cleanup3DOverlay(st, result = { ok: false, cancelled: true }) {
      if (st.done) return;
      st.done = true;
      const doc = this.doc;
      if (st.wheelBlock) doc.removeEventListener('wheel', st.wheelBlock, { capture: true });
      if (st.keyHandler) doc.removeEventListener('keydown', st.keyHandler, { capture: true });
      if (st.embedCancel) doc.defaultView.removeEventListener('message', st.embedCancel);
      if (st.resize) doc.defaultView.removeEventListener('resize', st.resize);
      try { st.session?.dispose(); } catch (_) {}
      st.backdrop?.remove();
      if (this.active3D === st) { this.active3D = null; this.controller.insert3DInteractionActive = false; }
      st.resolve?.(result);
      st.previousFocus?.focus?.();
    }
    /* 属性面板换样式：快照、样式和相机同一次提交。 */
    async update3DStyle(id, style) {
      const c = this.controller, o = c.object(id), generation = c.generation;
      if (!o || o.kind !== 'molecule3d') throw new Error('3D 对象不存在');
      if (this.active3D) throw new Error('请先确认或取消当前 3D 预览');
      if (typeof MW.documentObject3D?.InteractionSession !== 'function') throw new Error('3D 交互模块未就绪');
      const host = this.doc.createElement('div');
      host.style.cssText = `position:fixed;left:-10000px;top:0;width:640px;height:${Math.round(640 * o.h / o.w)}px;overflow:hidden`;
      this.doc.body.appendChild(host);
      const session = new MW.documentObject3D.InteractionSession({ host, serverBase: c.threedBase || '', molblock: o.molfile, style, camera: o.camera });
      try {
        await session.mount();
        const previewDataUrl = await session.snapshot({ width: 640, height: Math.round(640 * o.h / o.w), trim: true });
        const camera = await session.cameraJson();
        if (generation !== c.generation || c.object(id) !== o) return false;
        c.finishMolecule3DInteraction(id, { camera, style, previewDataUrl });
        c.status('已更新 3D 样式');
      } finally { try { session.dispose(); } catch (_) {} host.remove(); }
      return true;
    }

    refresh() {
      const c = this.controller;
      for (const b of this.bar.querySelectorAll('[data-doc-tool]')) b.setAttribute('aria-pressed', String(b.dataset.docTool === c.tool));
      this.status.hidden = !c.active || c.state.mode !== 'paper'; const page = c.getActivePage();
      this.statusText.textContent = `第 ${(page?.index || 0) + 1} / ${c.state.pageCount} 页 · ${c.state.page.size} ${c.state.page.orientation === 'portrait' ? '纵向' : '横向'}`;
      if (this.doc.activeElement !== this.zoomInput) this.zoomInput.value = Number(c.getPaperZoom?.() || 100).toFixed(0);
      if (this.removeLastPageButton) this.removeLastPageButton.disabled = c.state.pages.length <= 1;
      this.syncScaleToolbar(c);
      if (this.panelMode === 'properties' && !this.panel.contains(this.doc.activeElement)) this.showProperties(true);
      this.ensureTextFormatBar();
      if (this.active3D) this.reposition3DOverlay();
    }
    clearPanel(title) {
      this.panel.textContent = ''; this.panel.hidden = false; const heading = this.doc.createElement('div'); heading.style.cssText = 'font-weight:600;display:flex;justify-content:space-between;align-items:center'; heading.textContent = title;
      const close = this.doc.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', '关闭属性面板'); close.onclick = () => { this.panel.hidden = true; this.panelMode = null; this.pagesUI?.updateViewportInsets(); }; heading.appendChild(close); this.panel.appendChild(heading);
      this.pagesUI?.updateViewportInsets();
    }
    field(label, type, value, handler, options) {
      const row = this.doc.createElement('label'); row.textContent = label; const input = this.doc.createElement(type === 'select' ? 'select' : 'input'); input.setAttribute('aria-label', label);
      if (type === 'select') for (const [v, label] of options || []) { const o = this.doc.createElement('option'); o.value = v; o.textContent = label; input.appendChild(o); }
      else { input.type = type; if (type === 'number') { input.step = '.1'; input.min = '0.1'; } }
      if (type === 'checkbox') { input.checked = !!value; input.style.width = '20px'; } else input.value = value ?? '';
      input.onchange = () => { try { handler(type === 'checkbox' ? input.checked : type === 'number' ? Number(input.value) : input.value); } catch (e) { this.controller.status(e.message); } };
      row.appendChild(input); this.panel.appendChild(row); return input;
    }
    action(label, fn) { const b = this.doc.createElement('button'); b.textContent = label; b.onclick = () => { try { fn(); } catch (e) { this.controller.status(e.message); } }; this.panel.appendChild(b); return b; }
    showPageSetup() {
      this.panelMode = 'page'; const c = this.controller; this.clearPanel('页面设置');
      this.field('文档模式', 'select', c.state.mode, mode => { c.setPageSetup({ mode }); if (mode === 'paper') c.fitPage(); }, [['canvas', '无边画布'], ['paper', '纸页']]);
      this.field('纸张', 'select', c.state.page.size, size => { c.setPageSetup({ size }); c.fitPage(); }, [['A4', 'A4'], ['Letter', 'Letter']]);
      this.field('方向', 'select', c.state.page.orientation, orientation => { c.setPageSetup({ orientation }); c.fitPage(); }, [['portrait', '纵向'], ['landscape', '横向']]);
      this.action('新增一页', () => { c.addPage(); this.showPageSetup(); });
      this.removeLastPageButton = this.action('删除空白末页', () => { c.removePage(c.state.pages.at(-1).id); this.showPageSetup(); });
      const importFileButton = this.action('插入文件…', () => this.pickDocumentFile());
      importFileButton.dataset.docAction = 'import-file';
      const marginTitle = this.doc.createElement('div'); marginTitle.className = 'doc-section-title'; marginTitle.textContent = '页边距 (mm)'; this.panel.appendChild(marginTitle);
      const margins = c.state.page.margins, factor = 25.4 / 72;
      for (const key of ['top', 'right', 'bottom', 'left']) {
        const label = ({ top: '上', right: '右', bottom: '下', left: '左' })[key];
        const input = this.field(label, 'number', (margins[key] * factor).toFixed(1), mm => {
          const next = { ...c.state.page.margins, [key]: mm * 72 / 25.4 };
          c.setPageSetup({ margins: next });
        });
        input.step = '.5'; input.min = '0'; input.max = ((key === 'left' || key === 'right' ? c.state.page.width : c.state.page.height) * factor - 0.5).toFixed(1); input.dataset.docMargin = key;
      }
      const text = this.doc.createElement('p'); text.textContent = `共 ${c.state.pageCount} 页。页面设置可撤销；缩放与页面导航不会标记文档为已修改。`; text.style.cssText = 'color:#7a8790;line-height:1.6'; this.panel.appendChild(text);
      this.action('导出 PDF', () => { const native = root.webkit?.messageHandlers?.k3d; if (native) native.postMessage({ act: 'exportDocumentPDF' }); else c.status('PDF 导出请在 MolStudio 原生应用中使用'); });
    }
    shapeStyleFields(shape, objectId) {
      const c = this.controller, defaults = !objectId;
      const current = () => defaults ? (c.shapeStyle || {}) : (c.object(objectId) || {});
      const apply = patch => defaults ? c.setShapeStyle(patch) : c.updateObject(objectId, patch);
      const shapeStyle = current(), stroke = shapeStyle.stroke || {};
      const ptPerBond = Number(c.state?.ptPerBond) > 0 ? Number(c.state.ptPerBond) : 14.4;
      const fillColor = shapeStyle.fillColor || (shapeStyle.fill && shapeStyle.fill !== 'none' ? shapeStyle.fill : '#ffffff');
      this.field('描边颜色', 'color', stroke.color || '#3b5665', value => apply({ stroke: { ...(current().stroke || {}), color: value } }));
      const widthPt = (Number(stroke.width) || 0.05) * ptPerBond;
      const width = this.field('边框宽度 (pt)', 'number', widthPt, value => apply({ stroke: { ...(current().stroke || {}), width: value / ptPerBond } }));
      width.min = '0.1'; width.max = '72'; width.step = '0.1';
      this.field('线型', 'select', stroke.dash || 'solid', dash => apply({ stroke: { ...(current().stroke || {}), dash } }), [['solid', '实线'], ['dashed', '虚线']]);
      const fillMode = shapeStyle.fill === 'none' || !shapeStyle.fill ? 'none' : 'filled';
      if (!['line', 'arrow', 'bracket'].includes(shape)) {
        this.field('填充', 'select', fillMode, mode => {
          const now = current(), lastColor = now.fillColor || (now.fill && now.fill !== 'none' ? now.fill : '#ffffff');
          apply(mode === 'none' ? { fill: 'none', fillColor: lastColor } : { fill: lastColor, fillColor: lastColor });
        }, [['filled', '有填充'], ['none', '无填充']]);
        this.field('填充颜色', 'color', fillColor, value => {
          const now = current(), patch = { fillColor: value };
          if (now.fill !== 'none') patch.fill = value;
          apply(patch);
        });
      }
      if (shape === 'rect' || shape === 'roundRect') {
        const now = current(), radius = Number.isFinite(now.cornerRadius) ? now.cornerRadius
          : shape === 'roundRect' ? Math.min(0.5, (Number(now.h) || 5) / 4) : 0;
        const maxRadiusPt = defaults ? 1000 : Math.min(Number(now.w) || 0, Number(now.h) || 0) / 2 * ptPerBond;
        const field = this.field('圆角半径 (pt)', 'number', radius * ptPerBond, value => apply({ cornerRadius: value / ptPerBond }));
        field.min = '0'; field.max = String(Math.max(0, maxRadiusPt)); field.step = '0.1';
      }
    }
    showProperties(refresh) {
      this.panelMode = 'properties'; const c = this.controller, items = [...c.selection].map(id => c.object(id)).filter(Boolean); this.clearPanel(items.length === 1 ? '对象属性' : '所选内容');
      const shapeTools = new Set(['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'bracket']);
      if (items.length === 0 && shapeTools.has(c.tool)) {
        this.clearPanel('形状样式');
        const hint = this.doc.createElement('p'); hint.textContent = '新建形状将使用以下样式。边框宽度和圆角半径以 pt 显示。';
        hint.style.cssText = 'color:#7a8790;line-height:1.6;margin:0 0 8px'; this.panel.appendChild(hint);
        this.shapeStyleFields(c.tool, null);
        return;
      }
      if (items.length !== 1) {
        const p = this.doc.createElement('p');
        p.textContent = items.length ? `已选择 ${items.length} 个文档对象，可与结构一起拖动。` : '选择文字、图片或形状以调整属性。';
        this.panel.appendChild(p);
        if (items.length > 1) {
          const title = this.doc.createElement('div'); title.className = 'doc-section-title'; title.textContent = '对齐'; this.panel.appendChild(title);
          const group = this.doc.createElement('div'); group.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap'; this.panel.appendChild(group);
          for (const [mode, label] of [['left', '左'], ['center', '水平居中'], ['right', '右'], ['top', '上'], ['middle', '垂直居中'], ['bottom', '下']]) {
            const b = this.doc.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.docAlign = mode; b.title = label + '对齐所选对象';
            b.onclick = () => {
              if (typeof c.alignSelection === 'function') { try { c.alignSelection(mode); } catch (e) { c.status(e.message); } }
              else c.status('对齐功能尚未就绪');
            };
            group.appendChild(b);
          }
        }
        return;
      }
      const o = items[0], update = patch => c.updateObject(o.id, patch);
      this.field('宽度', 'number', o.w, w => update({ w })); this.field('高度', 'number', o.h, h => update({ h })); this.field('旋转角度', 'number', o.rotation || 0, rotation => update({ rotation })).min = '-360';
      this.field('图层', 'select', o.band, band => update({ band }), [['back', '结构下方'], ['front', '结构上方']]);
      if (o.kind === 'text') {
        const r = o.rich || {}, rich = patch => update({ rich: { ...c.object(o.id).rich, ...patch } });
        this.field('字体', 'select', r.fontFamily || 'Arial, PingFang SC, sans-serif', fontFamily => rich({ fontFamily }), [['Arial, PingFang SC, sans-serif', 'Arial / 苹方'], ['Times New Roman, Songti SC, serif', 'Times / 宋体'], ['Helvetica, sans-serif', 'Helvetica'], ['monospace', '等宽']]);
        this.field('字号 (pt)', 'number', r.fontSize || 12, fontSize => rich({ fontSize })); this.field('文字颜色', 'color', r.color || '#1c1c1e', color => rich({ color }));
        this.field('粗体', 'checkbox', r.bold, bold => rich({ bold })); this.field('斜体', 'checkbox', r.italic, italic => rich({ italic }));
        this.field('对齐', 'select', r.align || 'left', align => rich({ align }), [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']]);
        this.action('编辑文字', () => c.editText(o.id));
      } else if (o.kind === 'shape') {
        this.shapeStyleFields(o.shape, o.id);
      } else if (o.kind === 'image') {
        this.action('替换图片', () => this.pickImage(o.id));
        this.action('重置裁剪', () => update({ crop: { x: 0, y: 0, w: 1, h: 1 } }));
        for (const key of ['x', 'y', 'w', 'h']) this.field('裁剪 ' + key, 'number', o.crop?.[key] ?? (key === 'w' || key === 'h' ? 1 : 0), value => { const crop = { x: 0, y: 0, w: 1, h: 1, ...c.object(o.id).crop, [key]: value }; if (crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('裁剪范围应在 0–1 内'); update({ crop }); });
        const tip = this.doc.createElement('p'); tip.textContent = '拖动角点时按住 Shift 等比缩放。'; tip.style.cssText = 'color:#7a8790;line-height:1.6;margin:8px 0 0'; this.panel.appendChild(tip);
      } else if (o.kind === 'molecule3d') {
        this.field('样式', 'select', o.style || 'ballstick', style => { this.update3DStyle(o.id, style).catch(e => c.status(e.message)); }, [['ballstick', '球棍'], ['stick', '棍状'], ['line', '线框'], ['sphere', '空间填充']]);
        this.action('从源结构更新', () => {
          if (typeof c.updateMolecule3DFromSource === 'function') c.updateMolecule3DFromSource(o.id);
          else c.status('从源结构更新功能尚未就绪');
        });
        const hint = this.doc.createElement('p'); hint.textContent = '双击对象进入 3D 交互，可旋转视角并保存纸面预览。'; hint.style.cssText = 'color:#7a8790;line-height:1.6;margin:8px 0 0'; this.panel.appendChild(hint);
        const notes = o.notes;
        if (notes && (notes.sourceSummary || (Array.isArray(notes.warnings) && notes.warnings.length) || notes.geometryNote)) {
          const title = this.doc.createElement('div'); title.className = 'doc-section-title'; title.textContent = '生成说明'; this.panel.appendChild(title);
          const pre = this.doc.createElement('pre');
          pre.style.cssText = 'margin:0;padding:8px;background:#f4f7f9;border-radius:6px;white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace;color:#44535e';
          const lines = [];
          if (notes.sourceSummary !== undefined) lines.push(String(notes.sourceSummary));
          if (Array.isArray(notes.warnings)) for (const warning of notes.warnings) lines.push(String(warning));
          if (notes.geometryNote !== undefined) lines.push(String(notes.geometryNote));
          pre.textContent = lines.join('\n');
          this.panel.appendChild(pre);
        }
      }
      const actions = this.doc.createElement('div'); actions.className = 'doc-actions'; this.panel.appendChild(actions);
      const copy = this.action('复制', () => c.duplicateSelection()), del = this.action('删除', () => c.deleteSelection()); actions.append(copy, del);
    }
    /* 编辑器 div 挂在 Ketcher iframe 文档里；editText 不触发 emit，用 MutationObserver 跟随浮条显隐 */
    watchEditorForBar(c) {
      const body = c.iframe?.contentDocument?.body;
      if (!body || typeof this.doc.defaultView.MutationObserver !== 'function') return;
      const Observer = this.doc.defaultView.MutationObserver;
      // 给编辑器 div 直接挂 composition 监听：组合开始立即禁用浮条全部控件，
      // 组合结束立即恢复（以 controller.editor.composing 真值防竞态）。
      // The toolbar lives in the host document while the editor lives inside
      // Ketcher's iframe. Native selects/colour panels must be allowed to take
      // focus without turning the text draft into a finished edit.
      c.preserveTextEditOnBlur = current => this.textBarInteraction === current || !!this.formatBar?.contains(this.doc.activeElement);
      const leaveToolbar = event => {
        if (this.formatBar?.contains(event.target)) return;
        this.textBarInteraction = null;
        const ed = c.editor;
        if (ed && event.target !== ed.div && !ed.div.contains(event.target) && (this.doc.activeElement !== c.iframe || c.doc.activeElement !== ed.div)) c.finishTextEdit();
      };
      this.doc.addEventListener('pointerdown', leaveToolbar, true);
      c.doc.addEventListener('pointerdown', leaveToolbar, true);
      c.doc.addEventListener('selectionchange', () => {
        if (c.editor && c.doc.activeElement === c.editor.div && !this.textBarInteraction) {
          this.rememberTextSelection(); this.syncTextFormatValues();
        }
      });
      const armEditor = editorDiv => {
        if (!editorDiv || editorDiv.dataset.docBarArmed) return;
        editorDiv.dataset.docBarArmed = '1';
        editorDiv.addEventListener('compositionstart', () => { if (c.editor?.div === editorDiv) this.setTextBarDisabled(true); });
        editorDiv.addEventListener('compositionend', () => {
          if (c.editor?.div === editorDiv && !c.editor.composing) this.ensureTextFormatBar();
        });
      };
      const observer = new Observer(() => {
        const editorDiv = c.editor?.div?.isConnected ? c.editor.div : null;
        armEditor(editorDiv);
        if (editorDiv && (!this.formatBar || !this.formatBar.isConnected)) this.ensureTextFormatBar();
        else if (!editorDiv && this.formatBar?.isConnected) this.removeTextFormatBar();
      });
      observer.observe(body, { childList: true, subtree: true });
      this.armTextEditorForBar = armEditor;
    }
    /* ---------------- 任务 C：文字格式浮条（编辑器打开时出现；不带 data-document-ui） ---------------- */
    textBarUsable() { const c = this.controller; return !!(c.editor && !c.editor.composing); }
    setTextBarDisabled(disabled) {
      if (!this.formatBar?.isConnected) return;
      this.formatBar.setAttribute('aria-disabled', String(disabled));
      for (const node of this.formatBar.querySelectorAll('button,input,select')) node.disabled = disabled;
    }
    ensureTextFormatBar() {
      const c = this.controller;
      const editorDiv = c.editor?.div?.isConnected ? c.editor.div : null;
      if (!editorDiv) { this.removeTextFormatBar(); return; }
      this.armTextEditorForBar?.(editorDiv);
      if (!this.formatBar || !this.formatBar.isConnected) this.buildTextFormatBar();
      this.setTextBarDisabled(!!c.editor.composing);
      this.positionTextFormatBar(editorDiv);
    }
    removeTextFormatBar() { this.formatBar?.remove(); this.textBarInteraction = null; this.textSelection = null; }
    rememberTextSelection() {
      const c = this.controller, ed = c.editor, sel = c.win.getSelection();
      if (!ed || !sel?.rangeCount || this.doc.activeElement !== c.iframe || c.doc.activeElement !== ed.div) return null;
      const range = sel.getRangeAt(0);
      if (!ed.div.contains(range.startContainer) || !ed.div.contains(range.endContainer)) return null;
      const start = this.textOffsetOf(ed.div, range.startContainer, range.startOffset), end = this.textOffsetOf(ed.div, range.endContainer, range.endOffset);
      if (start === null || end === null) return null;
      return this.textSelection = { editor: ed, start, end };
    }
    editorSelection(ed) {
      if (this.textBarInteraction === ed && this.textSelection?.editor === ed) return this.textSelection;
      return this.rememberTextSelection() || (this.textSelection?.editor === ed ? this.textSelection : null);
    }
    syncTextFormatValues() {
      const ed = this.controller.editor;
      if (!ed || !this.formatBar?.isConnected) return;
      const selection = this.editorSelection(ed), rich = this.readEditorRich(ed);
      const fmt = MW.documentRichText?.formatAt?.(rich, selection?.start || 0) || rich;
      for (const [input, value] of [[this.fontSelect, fmt.fontFamily || 'Arial, PingFang SC, sans-serif'], [this.sizeInput, fmt.fontSize || 12], [this.colorInput, fmt.color || '#1c1c1e']]) {
        if (input && this.doc.activeElement !== input) input.value = String(value);
      }
    }
    buildTextFormatBar() {
      const doc = this.doc, c = this.controller;
      const bar = this.formatBar = doc.createElement('div');
      bar.id = 'molstudio-text-format-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '文字格式');
      bar.addEventListener('pointerdown', () => { this.rememberTextSelection(); this.textBarInteraction = c.editor; });
      bar.addEventListener('mousedown', e => {
        this.rememberTextSelection(); this.textBarInteraction = c.editor;
        // Only command buttons should retain the iframe's focus. Cancelling
        // mousedown on select/input prevents their native menus and editing.
        if (e.target.closest('button')) e.preventDefault();
      });
      bar.addEventListener('focusin', () => { this.rememberTextSelection(); this.textBarInteraction = c.editor; });
      bar.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); const ed = c.editor, selected = ed && this.editorSelection(ed); this.textBarInteraction = null; if (ed) { this.focusEditorForCommand(ed); if (selected) this.setSelectionOffsets(ed.div, selected.start, selected.end); } }
        if (e.key === 'Tab') setTimeout(() => {
          const ed = c.editor;
          if (ed && !bar.contains(doc.activeElement) && c.doc.activeElement !== ed.div) { this.textBarInteraction = null; c.finishTextEdit(); }
        }, 0);
      });
      const styleBtn = (label, command, runKey, title) => {
        const b = doc.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title || label; b.dataset.docFormat = command;
        b.addEventListener('click', () => this.applyTextStyle(command, runKey));
        bar.appendChild(b); return b;
      };
      styleBtn('粗', 'bold', 'bold', '粗体（选区或后续输入）');
      styleBtn('斜', 'italic', 'italic', '斜体（选区或后续输入）');
      styleBtn('下', 'underline', 'underline', '下划线（选区或后续输入）');
      styleBtn('下标', 'subscript', 'sub', '下标');
      styleBtn('上标', 'superscript', 'sup', '上标');
      const mkSelect = (label, options, handler, datasetKey) => {
        const sel = doc.createElement('select'); sel.setAttribute('aria-label', label); if (datasetKey) sel.dataset.docFormat = datasetKey;
        for (const [value, text] of options) { const op = doc.createElement('option'); op.value = value; op.textContent = text; sel.appendChild(op); }
        sel.addEventListener('change', () => { if (this.textBarUsable()) handler(sel.value); });
        bar.appendChild(sel); return sel;
      };
      this.fontSelect = mkSelect('字体', [
        ['Arial, PingFang SC, sans-serif', 'Arial / 苹方'], ['Times New Roman, Songti SC, serif', 'Times / 宋体'],
        ['Helvetica, sans-serif', 'Helvetica'], ['monospace', '等宽']
      ], value => this.applySelectionRich({ fontFamily: value }), 'font');
      const sizeInput = this.sizeInput = doc.createElement('input');
      sizeInput.type = 'number'; sizeInput.min = '4'; sizeInput.max = '300'; sizeInput.step = '1'; sizeInput.value = '12';
      sizeInput.setAttribute('aria-label', '字号 (pt)'); sizeInput.dataset.docFormat = 'font-size';
      const applySize = () => { if (!this.textBarUsable()) return; const value = Number(sizeInput.value); if (!(value >= 4 && value <= 300)) { c.status('字号应在 4–300 pt 之间'); return; } this.applySelectionRich({ fontSize: value }); };
      sizeInput.addEventListener('change', applySize);
      sizeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applySize(); } });
      bar.appendChild(sizeInput);
      const colorInput = this.colorInput = doc.createElement('input');
      colorInput.type = 'color'; colorInput.value = '#1c1c1e'; colorInput.setAttribute('aria-label', '文字颜色'); colorInput.dataset.docFormat = 'color';
      const applyColor = () => { if (this.textBarUsable()) this.applySelectionRich({ color: colorInput.value }); };
      colorInput.addEventListener('input', applyColor);
      colorInput.addEventListener('change', applyColor);
      bar.appendChild(colorInput);
      mkSelect('对齐', [['', '对齐'], ['left', '左对齐'], ['center', '居中'], ['right', '右对齐']], value => { if (value) this.applyTextParagraph({ align: value }); }, 'align');
      mkSelect('行距', [['', '行距'], ['1', '1.0'], ['1.15', '1.15'], ['1.4', '1.4'], ['1.8', '1.8'], ['2.2', '2.2']], value => { if (value) this.applyTextParagraph({ lineHeight: Number(value) }); }, 'line-height');
      doc.body.appendChild(bar); this.syncTextFormatValues();
    }
    positionTextFormatBar(editorDiv) {
      if (!this.formatBar) return;
      // 编辑器 div 在 Ketcher iframe 文档内：其 rect 相对 iframe 视口，浮条挂在顶层文档，需要加上 frame 偏移
      const frame = this.controller.iframe?.getBoundingClientRect() || { left: 0, top: 0 };
      const rect = editorDiv.getBoundingClientRect(), win = this.doc.defaultView;
      const barRect = this.formatBar.getBoundingClientRect();
      let left = Math.max(4, Math.min(frame.left + rect.left, win.innerWidth - barRect.width - 4));
      let top = frame.top + rect.top - barRect.height - 6;
      if (top < 8) top = frame.top + rect.bottom + 6;
      this.formatBar.style.left = left + 'px';
      this.formatBar.style.top = top + 'px';
    }
    /* B/I/U/下标/上标：execCommand 走编辑器视觉；非折叠选区同时把 runs 写回对象 rich。
     * execCommand 需要编辑器真正获得焦点：宿主窗口失焦时 iframe 内 execCommand 会静默
     * 失败——先固化选区、确保焦点，视觉命令失败时直接以 runs 重建编辑器，保证持久化。 */
    focusEditorForCommand(ed) {
      // 注意：不能聚焦宿主 <iframe> 元素——那会把焦点从 iframe 内的编辑器 div 抢走，
      // 触发 blur → finishTextEdit，格式化在持久化之前就把编辑器销毁了。
      try { this.controller.iframe?.contentWindow?.focus?.(); } catch (_) {}
      try { ed.div.focus({ preventScroll: true }); } catch (_) { try { ed.div.focus(); } catch (_) {} }
    }
    readEditorRich(ed) {
      const c = this.controller, base = c.object(ed.id)?.rich || {};
      const read = MW.documentRichText?.readEditorDom
        ? MW.documentRichText.readEditorDom(ed.div, base, ed.pxPerPt || c.editorPxPerPt())
        : { text: ed.div.innerText ?? ed.div.textContent ?? '', runs: [] };
      return { ...base, ...read };
    }
    applyTextStyle(command, runKey) {
      const c = this.controller;
      if (!this.textBarUsable()) return;
      if (typeof c.textCommand !== 'function') { c.status('文字格式命令尚未就绪'); return; }
      const ed = c.editor, div = ed.div, win = this.controller.doc.defaultView;
      const selected = this.editorSelection(ed);
      this.focusEditorForCommand(ed);
      if (selected) this.setSelectionOffsets(div, selected.start, selected.end);
      const offsets = selected && selected.start !== selected.end ? [selected.start, selected.end] : null;
      const draft = this.readEditorRich(ed);
      let visual = false;
      try { visual = !!c.textCommand(command); } catch (_) { visual = false; }
      const canPersist = offsets && offsets.every(v => v !== null) && typeof MW.documentRichText?.applyFormat === 'function';
      if (!visual && !canPersist) { c.status('格式命令未生效'); return; }
      if (!canPersist) return;
      const o = c.object(ed.id);
      if (o) {
        const norm = { start: Math.min(offsets[0], offsets[1]), end: Math.max(offsets[0], offsets[1]) };
        const rich = visual ? this.readEditorRich(ed) : MW.documentRichText.applyFormat(draft, norm, { [runKey]: true });
        this.persistEditorRich(ed.id, rich, norm.end, norm);
      }
    }
    /* 字体/字号/颜色：有选区走 applyFormat+重建编辑器；折叠光标插零宽样式 span */
    applySelectionRich(patch) {
      const c = this.controller;
      if (!this.textBarUsable()) return;
      const ed = c.editor, div = ed.div, o = c.object(ed.id);
      if (!o) return;
      const selected = this.editorSelection(ed);
      if (!selected) return;
      if (selected.start === selected.end) { this.insertInlineStyleSpan(patch); return; }
      if (typeof MW.documentRichText?.applyFormat !== 'function') { c.status('富文本格式模块未就绪'); return; }
      const { start, end } = selected;
      const next = MW.documentRichText.applyFormat(this.readEditorRich(ed), { start: Math.min(start, end), end: Math.max(start, end) }, patch);
      this.persistEditorRich(ed.id, next, Math.max(start, end), { start, end });
    }
    persistEditorRich(id, rich, caretOffset, selection) {
      const c = this.controller, ed = c.editor, o = c.object(id);
      if (!o || !ed || ed.id !== id) return;
      const previous = o.rich;
      if (JSON.stringify(previous) === JSON.stringify(rich)) return;
      o.rich = rich;
      try { c.validate(c.state); } catch (e) { o.rich = previous; c.status(e.message); return; }
      // Formatting and typing belong to the same open text session. Its final
      // commit owns the undo entry; field changes must not add duplicate edits.
      this.rebuildEditorDom(id, rich, caretOffset);
      if (selection) {
        this.textSelection = { editor: ed, start: selection.start, end: selection.end };
        if (c.doc.activeElement === ed.div) this.setSelectionOffsets(ed.div, selection.start, selection.end);
      }
      c.render(); c.emit(); c.status('已设置文字格式');
    }
    rebuildEditorDom(id, rich, caretOffset) {
      const c = this.controller, ed = c.editor;
      if (!ed || ed.id !== id) return;
      const div = ed.div;
      let caret = typeof caretOffset === 'number' ? caretOffset : null;
      if (caret === null) {
        const sel = this.controller.doc.defaultView.getSelection();
        if (sel.rangeCount) { const r = sel.getRangeAt(0); caret = this.textOffsetOf(div, r.endContainer, r.endOffset); }
      }
      if (typeof c.rebuildEditorFromRich === 'function') { c.rebuildEditorFromRich(id, rich, caret); return; }
      div.innerHTML = '';
      let built = null;
      if (typeof c.buildEditorDom === 'function') { try { built = c.buildEditorDom(rich); } catch (_) { built = null; } }
      if (built) div.appendChild(built);
      else if (MW.documentRichText?.buildEditorDom) {
        built = MW.documentRichText.buildEditorDom(rich, c.doc, ed.pxPerPt || c.editorPxPerPt());
        while (built.firstChild) div.appendChild(built.firstChild);
      } else div.textContent = rich.text || '';
      if (caret !== null && c.doc.activeElement === div && this.doc.activeElement === c.iframe) this.setCaretOffset(div, Math.min(Math.max(0, caret), (rich.text || '').length));
    }
    setCaretOffset(div, offset) { this.setSelectionOffsets(div, offset, offset); }
    setSelectionOffsets(div, start, end) {
      const doc = this.controller.doc;
      const locate = offset => {
        let target = null, targetOffset = 0;
        const visit = node => {
          if (target) return;
          if (node.nodeType === 3) {
            const from = this.textOffsetOf(div, node, 0), to = this.textOffsetOf(div, node, node.nodeValue.length);
            if (from !== null && to !== null && offset >= from && offset <= to) { target = node; targetOffset = offset - from; }
          } else if (node.nodeName === 'BR') {
            const parent = node.parentNode, index = Array.prototype.indexOf.call(parent.childNodes, node);
            for (const at of [index, index + 1]) if (this.textOffsetOf(div, parent, at) === offset) { target = parent; targetOffset = at; break; }
          } else for (const child of node.childNodes) visit(child);
        };
        visit(div); return [target || div, target ? targetOffset : div.childNodes.length];
      };
      const range = doc.createRange(); range.setStart(...locate(Math.min(start, end))); range.setEnd(...locate(Math.max(start, end)));
      const sel = this.controller.doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
    textOffsetOf(div, container, offset) {
      // Selection offsets use the same BR/paragraph rules as saved text.
      if (MW.documentRichText?.editorTextOffset) return MW.documentRichText.editorTextOffset(div, container, offset);
      let pos = 0, hit = null;
      const visit = node => {
        if (hit) return;
        if (node === container) { hit = pos; return; }
        if (node.nodeType === 3) { pos += node.nodeValue.length; return; }
        for (const child of node.childNodes) visit(child);
      };
      visit(div);
      if (hit === null) return null;
      if (container.nodeType === 3) return hit + offset;
      let extra = 0;
      for (let i = 0; i < offset && i < container.childNodes.length; i++) {
        const child = container.childNodes[i];
        extra += child.nodeType === 3 ? child.nodeValue.length : (child.textContent || '').length;
      }
      return hit + extra;
    }
    insertInlineStyleSpan(patch) {
      const c = this.controller, doc = c.doc;
      const ed = c.editor, selected = ed && this.editorSelection(ed);
      if (!ed || !selected) return;
      this.focusEditorForCommand(ed); this.setSelectionOffsets(ed.div, selected.start, selected.end);
      const span = doc.createElement('span'), pxPerPt = ed.pxPerPt || c.editorPxPerPt();
      if (patch.fontFamily) span.style.fontFamily = patch.fontFamily;
      if (patch.fontSize != null) span.style.fontSize = patch.fontSize * pxPerPt + 'px';
      if (patch.color) span.style.color = patch.color;
      const text = doc.createTextNode('\u200b'); span.appendChild(text);
      const sel = c.win.getSelection(), range = sel.getRangeAt(0); range.deleteContents(); range.insertNode(span);
      range.setStart(text, 1); range.collapse(true); sel.removeAllRanges(); sel.addRange(range);
      this.textSelection = null; this.textBarInteraction = null; this.rememberTextSelection();
    }

    /* 对齐/行距是整框属性：不进 runs，直接更新对象 rich 并同步编辑器样式 */
    applyTextParagraph(patch) {
      const c = this.controller, ed = c.editor;
      if (!this.textBarUsable() || !ed) return;
      const o = c.object(ed.id);
      if (!o) return;
      const previous = o.rich;
      o.rich = { ...this.readEditorRich(ed), ...patch };
      try { c.validate(c.state); } catch (e) { o.rich = previous; c.status(e.message); return; }
      c.positionEditor?.(); c.render(); c.emit(); c.status('已更新文字排版');
    }
    pickImage(replaceId) {
      const input = this.doc.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      input.onchange = async () => { if (!input.files[0]) return; try {
        const c = this.controller; await c.insertImageFile(input.files[0], undefined, replaceId);
      } catch (e) { this.controller.status(e.message); } };
      input.click();
    }
    pickDocumentFile() {
      this.importInput?.remove();
      const input = this.doc.createElement('input');
      input.type = 'file'; input.accept = '.molwork,.ket,application/json';
      input.dataset.docFileInput = 'import'; input.setAttribute('aria-label', '选择要插入的 MolStudio 文件');
      input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
      this.doc.body.appendChild(input); this.importInput = input;
      input.addEventListener('cancel', () => {
        input.remove(); if (this.importInput === input) this.importInput = null;
      }, { once: true });
      input.onchange = () => {
        const file = input.files?.[0]; input.remove();
        if (this.importInput === input) this.importInput = null;
        if (!file) return;
        this.lastImportPromise = Promise.resolve(this.controller.importFile(file)).then(result => {
          if (!result?.ok) { this.controller.status(result?.error || '插入失败'); return result; }
          if (result.staged) this.controller.status(`移动鼠标放置 ${result.name || file.name}，点击确认，Esc 取消`);
          else this.controller.status(`已插入 ${result.name || file.name}`);
          return result;
        }).catch(error => { this.controller.status('插入失败：' + error.message); return { ok: false, error: error.message }; });
      };
      input.click();
    }
  }
  MW.documentUI = { DocumentUI };
})(typeof window === 'object' ? window : globalThis);
