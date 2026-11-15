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
      try { for (const name of ['wheel', 'pointerup', 'mouseup', 'click']) c.iframe?.contentWindow?.addEventListener(name, () => this.refresh(), { passive: true }); } catch (_) {}
      this.refresh();
      if (MW.documentPagesUI?.DocumentPagesUI) { this.pagesUI = new MW.documentPagesUI.DocumentPagesUI({ doc, controller: c, insetElements: { toolbar: this.bar, panel: this.panel, status: this.status } }); this.pagesUI.mount(); }
    }
    refresh() {
      const c = this.controller;
      for (const b of this.bar.querySelectorAll('[data-doc-tool]')) b.setAttribute('aria-pressed', String(b.dataset.docTool === c.tool));
      this.status.hidden = !c.active || c.state.mode !== 'paper'; const page = c.getActivePage();
      this.statusText.textContent = `第 ${(page?.index || 0) + 1} / ${c.state.pageCount} 页 · ${c.state.page.size} ${c.state.page.orientation === 'portrait' ? '纵向' : '横向'}`;
      if (this.doc.activeElement !== this.zoomInput) this.zoomInput.value = Number(c.getPaperZoom?.() || 100).toFixed(0);
      if (this.removeLastPageButton) this.removeLastPageButton.disabled = c.state.pages.length <= 1;
      if (this.panelMode === 'properties' && !this.panel.contains(this.doc.activeElement)) this.showProperties(true);
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
    showProperties(refresh) {
      this.panelMode = 'properties'; const c = this.controller, items = [...c.selection].map(id => c.object(id)).filter(Boolean); this.clearPanel(items.length === 1 ? '对象属性' : '所选内容');
      if (items.length !== 1) { const p = this.doc.createElement('p'); p.textContent = items.length ? `已选择 ${items.length} 个文档对象，可与结构一起拖动。` : '选择文字、图片或形状以调整属性。'; this.panel.appendChild(p); return; }
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
        this.field('描边颜色', 'color', o.stroke?.color || '#3b5665', color => update({ stroke: { ...c.object(o.id).stroke, color } }));
        this.field('线宽', 'number', o.stroke?.width || .05, width => update({ stroke: { ...c.object(o.id).stroke, width } })).step = '.01';
        this.field('线型', 'select', o.stroke?.dash || 'solid', dash => update({ stroke: { ...c.object(o.id).stroke, dash } }), [['solid', '实线'], ['dashed', '虚线']]);
        this.field('填充颜色', 'color', o.fill === 'none' ? '#ffffff' : o.fill || '#ffffff', fill => update({ fill })); this.action('无填充', () => update({ fill: 'none' }));
      } else if (o.kind === 'image') {
        this.action('替换图片', () => this.pickImage(o.id));
        for (const key of ['x', 'y', 'w', 'h']) this.field('裁剪 ' + key, 'number', o.crop?.[key] ?? (key === 'w' || key === 'h' ? 1 : 0), value => { const crop = { x: 0, y: 0, w: 1, h: 1, ...c.object(o.id).crop, [key]: value }; if (crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('裁剪范围应在 0–1 内'); update({ crop }); });
      }
      const actions = this.doc.createElement('div'); actions.className = 'doc-actions'; this.panel.appendChild(actions);
      const copy = this.action('复制', () => c.duplicateSelection()), del = this.action('删除', () => c.deleteSelection()); actions.append(copy, del);
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
