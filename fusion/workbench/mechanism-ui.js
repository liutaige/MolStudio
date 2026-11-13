/* MolStudio 工作台 · 机理层 UI
 * 统一工具入口到左侧工具栏，消除角落重复常驻面板。
 * 选中机理对象时浮现轻量属性条（曲率、σ/π、删除）；取消选中时自动隐藏。
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});

  const ICONS = {
    select: '<svg viewBox="0 0 20 20" aria-hidden="true" width="18" height="18"><path d="M4 2.5 15.2 9.1l-4.6 1.1-1.9 4.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    lonePair: '<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="7.2" cy="6.2" r="2.0" fill="currentColor"/><circle cx="16.8" cy="6.2" r="2.0" fill="currentColor"/><path d="M12 15.2v4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    arrow2: '<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><path d="M4 18c5.5 0 9.5-4.5 14.5-11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13.5 6.5h5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrow1: '<svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22"><path d="M4 18c5.5 0 9.5-4.5 14.5-11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14 6h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    eye: '<svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16"><path d="M2.5 10s2.8-4.6 7.5-4.6S17.5 10 17.5 10s-2.8 4.6-7.5 4.6S2.5 10 2.5 10z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="1.9" fill="currentColor"/></svg>',
    exportSvg: '<svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16"><path d="M10 2.8v8.6M6.8 8.4l3.2 3.4 3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 13.5v2.2a1.3 1.3 0 0 0 1.3 1.3h10.4a1.3 1.3 0 0 0 1.3-1.3v-2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    exportPng: '<svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16"><rect x="3" y="4" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="7.2" cy="8.2" r="1.4" fill="currentColor"/><path d="M4.5 14.5l3.8-3.6 2.6 2.4 2.4-2.2 2.4 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 20 20" aria-hidden="true" width="15" height="15"><path d="M4.5 6h11M8 6V4.2h4V6M6.2 6l.7 9.3h6.2L13.8 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  };

  // 保留 Ketcher 原菜单及图标，只替换这两个入口的绘图行为。
  const NATIVE_ARROWS = {
    'reaction-arrow-elliptical-arc-arrow-open-angle': {
      tool: 'arrow2', label: 'Curly：电子对弯箭头（2e⁻）'
    },
    'reaction-arrow-elliptical-arc-arrow-open-half-angle': {
      tool: 'arrow1', label: '鱼钩：单电子弯箭头（1e⁻）'
    }
  };

  const CSS = `
  /* 悬浮属性条：仅选中箭头或孤对时显示在画布底部中央 */
  #mech-sel-bar {
    position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
    display: none; align-items: center; gap: 12px;
    padding: 7px 15px; border-radius: 10px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 4px 22px rgba(0, 0, 0, 0.16);
    border: 1px solid rgba(0, 0, 0, 0.12);
    font: 12px/1.4 -apple-system, "PingFang SC", system-ui, sans-serif;
    color: #1c1c1e; z-index: 25; user-select: none;
    max-width: calc(100vw - 110px); box-sizing: border-box;
    overflow-x: auto; white-space: nowrap;
  }
  #mech-sel-bar > * { flex-shrink: 0; }
  #mech-sel-bar .msb-meta { color: #6b7280; font-weight: 500; font-size: 11.5px; }
  #mech-sel-bar .msb-group { display: flex; align-items: center; gap: 8px; }
  #mech-sel-bar input[type=range] { width: 110px; cursor: pointer; }
  #mech-sel-bar .msb-btn {
    border: 1px solid rgba(0,0,0,0.14); background: #fff; border-radius: 6px;
    padding: 3px 8px; cursor: pointer; font-size: 11.5px; color: #3a3a3c;
    transition: all .15s ease;
  }
  #mech-sel-bar .msb-btn:hover { background: #f2f7fa; border-color: #0a7ea4; color: #0a7ea4; }
  #mech-sel-bar .msb-btn.danger:hover { background: #fdecec; border-color: #c0392b; color: #c0392b; }
  `;

  class MechanismUI {
    constructor(opts) {
      this.doc = opts.doc;             // 外层页面 document
      this.controller = opts.controller;
      this.model = opts.model;
      this.adapter = opts.adapter;
      this.onExport = opts.onExport || function () {};
      this.selBar = null;
      this.statusEl = null;
    }

    mount() {
      const doc = this.doc;
      if (!doc.getElementById('mech-style')) {
        const st = doc.createElement('style');
        st.id = 'mech-style';
        st.textContent = CSS;
        doc.head.appendChild(st);
      }

      // 1. 悬浮属性条（仅选中时显示，代替常驻面板）
      let selBar = doc.getElementById('mech-sel-bar');
      if (!selBar) {
        selBar = doc.createElement('div');
        selBar.id = 'mech-sel-bar';
        selBar.setAttribute('role', 'toolbar');
        selBar.setAttribute('aria-label', '机理对象属性');
        doc.body.appendChild(selBar);
      }
      this.selBar = selBar;

      // 2. 显示孤对 / 导出：原生融入左侧工具栏（见 injectLeftToolbar），
      //    不再往页面右上角叠加浮动条（会盖住 Ketcher 原生缩放/搜索控件）。
      //    清理历史版本注入的浮动条。
      const legacy = doc.getElementById('mech-top-tools');
      if (legacy) legacy.remove();

      // 3. 注入左侧原生工具栏
      this.injectLeftToolbar();

      this.syncToolState();
      return this;
    }

    injectLeftToolbar() {
      const iframeDoc = this.adapter && this.adapter.doc ? this.adapter.doc : null;
      if (!iframeDoc) return;

      const self = this;
      const SELECTED_CLASS = 'ActionButton-module_selected__kPCxA';
      const BTN_CLASS = 'ActionButton-module_button__nfoWQ';

      // 区分普通反应箭头
      const rxnArrow = iframeDoc.querySelector('[data-testid="reaction-arrow-open-angle"]');
      if (rxnArrow) {
        rxnArrow.setAttribute('title', '普通反应箭头（反应式用）');
      }

      // 查找 Group 2（键/电荷分组）
      const chargeMinus = iframeDoc.querySelector('[data-testid="charge-minus"]');
      if (chargeMinus && !iframeDoc.querySelector('[data-mech-tool="lonePair"]')) {
        const lpContainer = iframeDoc.createElement('div');
        lpContainer.className = 'ToolbarMultiToolItem-module_root__uTaId';
        lpContainer.setAttribute('data-testid', 'mech-lonePair-item');
        const lpBtn = iframeDoc.createElement('button');
        lpBtn.type = 'button';
        lpBtn.className = BTN_CLASS;
        lpBtn.setAttribute('data-mech-tool', 'lonePair');
        lpBtn.setAttribute('data-testid', 'mech-tool-lonePair');
        lpBtn.setAttribute('title', '孤对电子 (Lone Pair)');
        lpBtn.innerHTML = ICONS.lonePair;
        lpBtn.addEventListener('click', () => {
          self.controller.setTool('lonePair');
          self.syncToolState();
        });
        lpContainer.appendChild(lpBtn);
        const parent = chargeMinus.closest('.LeftToolbar-module_group__0s41t') || chargeMinus.parentElement;
        if (parent) parent.appendChild(lpContainer);
      }

      // 机理动作组：显示孤对 / 导出 SVG / 导出 PNG —— 与原生按钮同款样式融入左侧工具栏
      const lpAnchor = iframeDoc.querySelector('[data-mech-tool="lonePair"]');
      const actionGroup = (lpAnchor && lpAnchor.closest('.LeftToolbar-module_group__0s41t')) ||
        (chargeMinus && chargeMinus.closest('.LeftToolbar-module_group__0s41t'));
      if (actionGroup && !iframeDoc.querySelector('[data-mech-actions="1"]')) {
        const actions = iframeDoc.createElement('div');
        actions.setAttribute('data-mech-actions', '1');
        actions.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px 0;';
        const mkAction = (testid, icon, title, onClick) => {
          const b = iframeDoc.createElement('button');
          b.type = 'button';
          b.className = BTN_CLASS;
          b.setAttribute('data-mech-action', testid);
          b.setAttribute('data-testid', 'mech-' + testid);
          b.setAttribute('title', title);
          b.setAttribute('aria-label', title);
          b.setAttribute('aria-pressed', 'false');
          b.innerHTML = icon;
          b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick(b);
          });
          return b;
        };
        const lpToggle = mkAction('show-lp', ICONS.eye, '显示/隐藏建议的孤对（仅显示，不写入文件）', (b) => {
          const next = b.getAttribute('aria-pressed') !== 'true';
          b.setAttribute('aria-pressed', String(next));
          b.classList.toggle(SELECTED_CLASS, next);
          this.controller.setShowAutoLonePairs(next);
          this.setStatus(next ? '已显示自动建议的孤对（仅显示，不算保存内容）' : '已隐藏自动建议的孤对');
        });
        actions.appendChild(lpToggle);
        actions.appendChild(mkAction('export-svg', ICONS.exportSvg, '导出包含孤对与箭头的 SVG', () => this.onExport('svg')));
        actions.appendChild(mkAction('export-png', ICONS.exportPng, '导出包含孤对与箭头的 PNG', () => this.onExport('png')));
        actionGroup.appendChild(actions);
      }

      this.bindNativeArrows();
    }

    bindNativeArrows() {
      const doc = this.adapter.doc;
      if (this.nativeArrowDoc === doc) return;
      this.unbindNativeArrows();
      this.nativeArrowDoc = doc;
      const win = doc.defaultView;
      this.onNativeArrowClick = (event) => {
        const button = event.target && event.target.closest && event.target.closest('button');
        if (!button || button.disabled) return;
        if (this.nativeArrowTimer) win.clearTimeout(this.nativeArrowTimer);
        this.nativeArrowTimer = null;
        const choice = NATIVE_ARROWS[button.getAttribute('data-testid')];
        if (!choice) return;
        // 原处理器先完成菜单收起和当前图标更新，再把画布交给语义工具。
        // 不拦截 React 的 click，也不改压缩 bundle；用下一任务避免被其工具切换覆盖。
        this.nativeArrowTimer = win.setTimeout(() => {
          this.nativeArrowTimer = null;
          this.controller.setTool(choice.tool);
          this.syncToolState();
          this.setStatus(choice.label + '：从电子来源拖向目标');
        }, 0);
      };
      doc.addEventListener('click', this.onNativeArrowClick, true);
      this.nativeArrowObserver = new win.MutationObserver(() => this.decorateNativeArrows());
      this.nativeArrowObserver.observe(doc.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-testid', 'title']
      });
      this.decorateNativeArrows();
    }

    decorateNativeArrows() {
      const doc = this.nativeArrowDoc;
      if (!doc) return;
      // React会重用主按钮，也会按需重建菜单；不能只绑定首次出现的两个DOM节点。
      for (const button of doc.querySelectorAll('[data-mech-native-arrow]')) {
        if (NATIVE_ARROWS[button.getAttribute('data-testid')]) continue;
        for (const attr of ['data-mech-native-arrow', 'data-mech-tool', 'aria-label', 'aria-pressed']) {
          button.removeAttribute(attr);
        }
      }
      for (const [id, choice] of Object.entries(NATIVE_ARROWS)) {
        for (const button of doc.querySelectorAll('button[data-testid="' + id + '"]')) {
          button.setAttribute('data-mech-native-arrow', '1');
          button.setAttribute('data-mech-tool', choice.tool);
          if (button.getAttribute('title') !== choice.label) button.setAttribute('title', choice.label);
          button.setAttribute('aria-label', choice.label);
          button.setAttribute('aria-pressed', String(this.controller.tool === choice.tool));
        }
      }
    }

    unbindNativeArrows() {
      if (this.nativeArrowObserver) this.nativeArrowObserver.disconnect();
      if (this.nativeArrowDoc && this.onNativeArrowClick) {
        this.nativeArrowDoc.removeEventListener('click', this.onNativeArrowClick, true);
        if (this.nativeArrowTimer) this.nativeArrowDoc.defaultView.clearTimeout(this.nativeArrowTimer);
      }
      this.nativeArrowDoc = null;
      this.nativeArrowObserver = null;
      this.nativeArrowTimer = null;
    }

    syncToolState() {
      const iframeDoc = this.adapter && this.adapter.doc ? this.adapter.doc : null;
      if (!iframeDoc) return;
      this.decorateNativeArrows();
      const current = this.controller ? this.controller.tool : 'select';
      const SELECTED_CLASS = 'ActionButton-module_selected__kPCxA';

      // 显示孤对切换按钮：跟随控制器状态（iframe 重建后按钮是新建的）
      const showLpBtn = iframeDoc.querySelector('[data-mech-action="show-lp"]');
      if (showLpBtn) {
        const on = !!(this.controller && this.controller.showAutoLonePairs);
        showLpBtn.setAttribute('aria-pressed', String(on));
        showLpBtn.classList.toggle(SELECTED_CLASS, on);
      }

      const mechBtns = iframeDoc.querySelectorAll('[data-mech-tool]');
      mechBtns.forEach(btn => {
        const tool = btn.getAttribute('data-mech-tool');
        if (tool === current) {
          btn.classList.add(SELECTED_CLASS);
          btn.setAttribute('aria-pressed', 'true');
        } else {
          btn.classList.remove(SELECTED_CLASS);
          btn.setAttribute('aria-pressed', 'false');
        }
      });

      // 如果机理工具激活，清除原生左侧工具栏的高亮并置 Ketcher 为 select 模式
      if (current !== 'select') {
        const otherBtns = iframeDoc.querySelectorAll('.LeftToolbar-module_group__0s41t button:not([data-mech-tool])');
        otherBtns.forEach(b => b.classList.remove(SELECTED_CLASS));
        try {
          if (this.adapter.ed && typeof this.adapter.ed.tool === 'function') {
            this.adapter.ed.tool('select');
          }
        } catch (e) {}
      }
    }

    setStatus(text) {
      const toast = this.doc.getElementById('toast');
      if (toast) toast.style.bottom = this.selBar && this.selBar.style.display !== 'none' ? '78px' : '28px';
      if (root.toast) root.toast(text);
    }

    /* 选中箭头或孤对时的浮动属性条：曲率单事务滑杆、σ/π 切换、删除 */
    refreshSelection(count, ids) {
      if (!this.selBar) return;
      const box = this.selBar;
      if (!count) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      const arrows = ids.map(id => this.model.arrow(id)).filter(Boolean);
      const lps = ids.map(id => this.model.lonePair(id)).filter(Boolean);

      let meta = '已选 ' + count + ' 个对象';
      let ownerLabel = '';
      let ownerLabelHtml = '';
      if (arrows.length && lps.length) meta += '（' + arrows.length + ' 箭头，' + lps.length + ' 孤对）';
      else if (arrows.length) meta += '（' + arrows.length + ' 箭头）';
      else if (lps.length) {
        ownerLabel = lps[0].ownerAtomId ? this.controller.describeAtom(lps[0].ownerAtomId) : '';
        meta += '（' + lps.length + ' 孤对';
        if (ownerLabel) {
          meta += '，所属：';
          ownerLabelHtml = '<span id="msb-owner-label"></span>';
        }
        meta += ownerLabelHtml + '）';
      }

      let html = '<span class="msb-meta">' + meta + '</span>';

      if (arrows.length >= 1) {
        const autoCount = arrows.filter(ar => ar.geometry.mode === 'auto').length;
        const modeLabel = autoCount === arrows.length ? '自动' :
          (autoCount === 0 ? '手动' : autoCount + '/' + arrows.length + ' 自动');
        html += '<span class="msb-meta" title="auto=端点重绑后可自动重排；manual=保留用户结果">曲率：' + modeLabel + '</span>';
        html += '<button type="button" class="msb-btn" id="msb-replan" title="按当前结构重新自动选择弯曲方向与弧高（可撤销）">重新排布</button>';
      }

      if (arrows.length === 1) {
        const ar = arrows[0];
        const bendVal = (ar.geometry.bend).toFixed(2);
        html += '<div class="msb-group"><span class="msb-meta">曲率</span><span class="msb-meta" id="msb-bend-val">' + bendVal + '</span>' +
                '<input type="range" id="msb-bend" min="-2.4" max="2.4" step="0.02" value="' + ar.geometry.bend + '"></div>';

        const bondSide = ['source', 'target'].find(s => ar[s] && ar[s].type === 'bond');
        if (bondSide) {
          const comp = ar[bondSide].component;
          html += '<button type="button" class="msb-btn" id="msb-toggle-comp" title="在 σ / π 之间切换">' +
                  (comp === 'pi' ? 'π' : 'σ') + ' → 切换</button>';
        }
      }

      html += '<button type="button" class="msb-btn danger" id="msb-del" title="删除所选对象">删除</button>';
      box.innerHTML = html;
      const ownerLabelEl = box.querySelector('#msb-owner-label');
      if (ownerLabelEl) ownerLabelEl.textContent = ownerLabel;
      box.style.display = 'flex';

      const del = box.querySelector('#msb-del');
      if (del) del.addEventListener('click', () => this.controller.deleteSelection());

      const toggle = box.querySelector('#msb-toggle-comp');
      if (toggle) toggle.addEventListener('click', () => this.controller.toggleBondComponent());

      const replan = box.querySelector('#msb-replan');
      if (replan) replan.addEventListener('click', () => this.controller.replanSelection());

      const bend = box.querySelector('#msb-bend');
      if (bend) {
        const val = box.querySelector('#msb-bend-val');
        let adjusting = false;
        const start = () => {
          if (!adjusting) {
            adjusting = true;
            this.controller.beginBendAdjustment();
          }
        };
        const finish = () => {
          if (adjusting) {
            adjusting = false;
            this.controller.finishBendAdjustment(parseFloat(bend.value));
          }
        };

        bend.addEventListener('pointerdown', start);
        bend.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            start();
          }
        });
        bend.addEventListener('input', () => {
          start();
          const v = parseFloat(bend.value);
          if (val) val.textContent = v.toFixed(2);
          this.controller.previewBendForSelection(v);
        });
        bend.addEventListener('change', finish);
        bend.addEventListener('pointerup', finish);
        bend.addEventListener('blur', finish);
      }
    }
  }

  MW.ui = { MechanismUI: MechanismUI, ICONS: ICONS };
})(typeof window !== 'undefined' ? window : globalThis);
