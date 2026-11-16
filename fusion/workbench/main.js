/* MolStudio 工作台 · 机理层启动与对外 API
 * 在 canvas.html 里最后加载。对外只增加职责明确的入口，不改 k3dAPI.getKet() 的标准 KET 语义。
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const S = {
    ready: false,
    error: null,
    adapter: null,
    model: null,
    layer: null,
    controller: null,
    ui: null,
    kd: null
  };

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(cond, timeoutMs, intervalMs) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = cond(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > (timeoutMs || 20000)) return null;
      await sleep(intervalMs || 120);
    }
  }

  function iframeWin() {
    const kd = S.kd;
    try { return kd.contentWindow; } catch (e) { return null; }
  }
  function iframeDoc() {
    const kd = S.kd;
    try { return kd.contentDocument; } catch (e) { return null; }
  }

  function toast(text) {
    if (root.toast) root.toast(text);
    else if (S.ui) S.ui.setStatus(text);
  }

  async function boot() {
    S.kd = root.document.getElementById('k');
    if (!S.kd) { S.error = '找不到画布 iframe'; return; }

    const ok = await waitFor(() => {
      const w = iframeWin();
      const k = w && w.ketcher;
      return !!(k && k.editor && k.editor.render && k.editor.render.clientArea && k.getKet);
    }, 25000, 150);
    if (!ok) { S.error = 'Ketcher 未就绪，机理层未启动'; return; }

    const win = iframeWin();
    const doc = iframeDoc();
    const adapter = new MW.adapter.KetcherAdapter(win.ketcher, doc);
    const model = new MW.model.MechanismModel();
    const layer = new MW.layer.MechanismLayer(adapter, doc);

    const controller = new MW.controller.MechanismController({
      adapter: adapter,
      model: model,
      layer: layer,
      doc: doc,
      win: win,
      onStatus: (t) => { if (S.ui) S.ui.setStatus(t); },
      onToolChange: (tool) => { if (S.ui) S.ui.syncToolState(); if (MW.nativeUI) MW.nativeUI.current()?.markState(); if (tool !== 'select' && S.documentController) { S.documentController.tool = 'select'; S.documentController.emit(); } },
      onSelectionChange: (n, ids) => {
        if (S.ui) S.ui.refreshSelection(n, ids);
        if (MW.nativeUI) MW.nativeUI.current()?.noteSelectionChange();
        // 让 canvas.html 的整理/3D 知道「只选中了机理对象」
        root.__mechSelectionCount = n;
        // 让原生 Copy/Cut 按钮重新计算可用性；不向原生选区伪造任何分子对象。
        const event = adapter.ed.event && adapter.ed.event.selectionChange;
        if (event && typeof event.dispatch === 'function') event.dispatch(adapter.ed.selection());
      },
      onDirtyHint: () => { root.__mechDirtyTick = (root.__mechDirtyTick || 0) + 1; }
    });

    const ui = new MW.ui.MechanismUI({
      doc: root.document,
      controller: controller,
      model: model,
      adapter: adapter,
      onExport: (kind) => {
        // WKWebView does not implement browser downloads; let the native shell
        // present its save panel and write the generated image instead.
        const native = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.k3d;
        if (native) {
          native.postMessage({ act: 'exportMechanismImage', kind: kind });
          return;
        }
        exportImage(kind).then(res => {
          if (!res.ok) { toast(res.error || '导出失败'); return; }
          const a = root.document.createElement('a');
          a.href = res.dataUrl;
          a.download = res.fileName;
          root.document.body.appendChild(a);
          a.click();
          a.remove();
          toast('已开始下载 ' + res.fileName);
        }).catch(e => toast('导出失败：' + (e && e.message ? e.message : e)));
      }
    });

    S.adapter = adapter;
    S.model = model;
    S.layer = layer;
    S.controller = controller;
    S.ui = ui;
    const documentController = new MW.documentController.DocumentController({ adapter, mechanism: controller, doc, win, iframe: S.kd,
      onStatus: toast, onDirtyHint: () => { root.__mechDirtyTick = (root.__mechDirtyTick || 0) + 1; } });
    S.documentController = documentController;
    S.documentUI = new MW.documentUI.DocumentUI({ doc: root.document, controller: documentController });

    // Ketcher 的原生按钮与宿主菜单共用真实 DOM 剪贴板事件。
    // Use one synchronous DOM transaction in browsers and WKWebView. The
    // modern async Ketcher writer replaces the event clipboard and would drop
    // the mechanism/document sidecar. Text fields keep their normal handlers.
    const clipboard = win.molstudioClipboard = win.molstudioClipboard || {};
    clipboard.preferEvents = true;
    clipboard.nativePreviewActive = false;
    clipboard.hasSelection = () => (controller.selection.size > 0 || documentController.selection.size > 0) && !controller.focusedIsEditable();
    clipboard.prepare = (command) => controller.prepareClipboardReceiver(command);
    // WK 的 JS paste 命令会弹出权限菜单；工具栏借宿主发送标准 paste:，
    // 仍由同一原生 paste 事件解析内容并进入 Ketcher 放置工具。
    clipboard.execute = (command) => command === 'paste' && controller.notifyHost({ act: 'paste' });
    // 分子与箭头的联合副本：只附加机理数据。分子仍由 Ketcher 序列化、解析和放置；
    // 这里使用它本次 PasteTool 给出的变换，并将箭头撤销接到同一个原生历史动作。
    clipboard.nativePasteToken = () => controller.nativePasteToken();
    const previewActive = (active, token) => {
      if (active) { clipboard.nativePreviewActive = true; clipboard.nativePreviewToken = token; }
      else if (clipboard.nativePreviewToken === token) clipboard.nativePreviewActive = false;
    };
    clipboard.nativePasteStart = (meta) => { previewActive(true, meta?.token); return controller.startNativePaste(meta); };
    clipboard.nativePasteMove = (meta) => { previewActive(true, meta?.token); return controller.moveNativePaste(meta); };
    clipboard.nativePasteCommit = (action, token) => { previewActive(false, token); return controller.commitNativePaste(action, token); };
    clipboard.nativePasteCancel = (token, temporary) => { previewActive(false, token); return controller.cancelNativePaste(token, temporary); };
    clipboard.nativeCutToken = () => controller.nativeCutToken();
    clipboard.nativeClipboardHistory = (action, token) => controller.nativeClipboardHistory(action, token);
    clipboard.nativeCutEnd = (token) => controller.nativeCutEnd(token);

    // 整份替换画布（setMolecule / 打开 .ket）→ 机理层归零：旧箭头不能指向已消失的原子
    adapter.onStructureReplaced = () => {
      clipboard.nativePreviewActive = false; clipboard.nativePreviewToken = undefined;
      controller.cancelDrag();
      controller.cancelNativePaste();
      controller.cancelNativeCut();
      model.setState(MW.model.emptyState(), 'replace');
      documentController.restore(null, 'replace');
      controller.selection.clear();
      controller.cancelDraft();
      controller.refreshAutoSlots();
      controller.emitSelection();
      controller.render();
    };

    adapter.mount();
    documentController.mount();
    controller.mount();
    ui.mount();
    S.documentUI.mount();
    controller.refreshAutoSlots();
    controller.render();

    S.ready = true;
    installAPI();
    // Native UI contract v1: install after the workbench API exists so attach
    // can validate real capabilities. Browser mode is untouched (no webkit
    // handler -> attach works but publishes nothing and hides nothing without
    // a successful host handshake).
    if (MW.nativeUI && !MW.nativeUI.current()) {
      MW.nativeUI.install({ app: S, doc: root.document, viewport: root.molCanvasViewport });
    }
  }

  /* ---------------- 对外 API（挂在 window.k3dAPI 上） ---------------- */
  function installAPI() {
    const api = root.k3dAPI = root.k3dAPI || {};
    const adapter = S.adapter;
    const model = S.model;
    const controller = S.controller;

    api.selectAll = function () { return S.documentController?.editor ? S.documentController.textCommand('selectAll') : S.documentController ? S.documentController.selectAll() : controller.selectAll(); };
    const documentAPI = {};
    for (const name of ['init', 'getState', 'getSelection', 'getActivePage', 'setPageSetup', 'addPage', 'removePage', 'addText', 'addShape', 'addImage', 'updateObject', 'select', 'selectAll', 'moveSelection', 'deleteSelection', 'duplicateSelection', 'importFile', 'setTool', 'editText', 'finishTextEdit', 'fitPage', 'fitWidth', 'scrollToPage', 'getPaperZoom', 'setPaperZoom', 'setPaperViewportInsets', 'modelToClient', 'exportPages', 'previewPages']) {
      documentAPI[name] = (...args) => S.documentController[name](...args);
    }
    if (S.documentController) api.document = documentAPI;
    root.MolStudio = root.MolStudio || {}; root.MolStudio.document = documentAPI;
    const nativeDelete = api.deleteSel;
    api.deleteSel = function () {
      if (S.documentController?.editor) return S.documentController.textCommand('delete');
      return S.documentController?.selection.size ? S.documentController.deleteSelection() : nativeDelete?.();
    };
    const nativeUndo = api.undo, nativeRedo = api.redo;
    api.undo = function () { return S.documentController?.editor ? S.documentController.textCommand('undo') : nativeUndo?.(); };
    api.redo = function () { return S.documentController?.editor ? S.documentController.textCommand('redo') : nativeRedo?.(); };

    /* 完整快照：KET + 绑定 + 机理层。getKet() 仍只返回标准 KET。 */
    api.serializeWorkbench = async function () {
      if (!S.ready) throw new Error('机理层未就绪');
      const requireCommitted = () => { if (controller.nativePasteSession || iframeWin()?.molstudioClipboard?.nativePreviewActive) throw new Error('请先放置或取消正在粘贴的片段，再保存文档'); };
      requireCommitted();
      for (let attempt = 0; attempt < 3; attempt++) {
        const fence = S.agentTask?.captureFence?.();
        const ex = await adapter.exportKetWithBindings();
        requireCommitted();
        if (fence !== undefined && fence !== S.agentTask?.captureFence?.()) continue;
        if (!ex.ok) throw new Error(ex.error || '无法建立稳定对照');
        return MW.storage.serializeWorkbench({
          ket: ex.ket,
          bindings: ex.bindings,
          mechanism: model.state,
          document: S.documentController?.export({ preserveTextEditing: true }),
          reactionSteps: S.reactionSteps?.export(ex.ket),
          reactionStepOperations: S.reactionSteps?.exportOperations?.(),
          agentTask: S.agentTask?.export()
        });
      }
      throw new Error('画布或任务进度正在变化，请稍后保存');
    };

    /* 事务式载入：先校验，再替换；失败恢复原内容 */
    api.loadWorkbench = async function (text) {
      if (!S.ready) return { ok: false, error: '机理层未就绪' };
      const parsed = MW.storage.parseWorkbench(text);
      if (!parsed.ok) return { ok: false, code: parsed.code, error: parsed.error };
      if ((parsed.doc.reactionSteps?.length || parsed.doc.reactionStepOperations?.length) && !S.reactionSteps) return { ok: false, code: 'bridge_unavailable', error: '反应步骤层尚未就绪，未替换画布' };
      if (parsed.doc.document && !S.documentController) return { ok: false, code: 'bridge_unavailable', error: '文档层尚未就绪，未替换画布' };
      if (parsed.doc.agentTask && !S.agentTask) return { ok: false, code: 'bridge_unavailable', error: 'AI 任务层尚未就绪，未替换画布' };

      const ketcher = iframeWin().ketcher;
      let previous;
      try {
        previous = await adapter.exportKetWithBindings();
        if (!previous.ok) throw new Error(previous.error || '无法建立稳定对照');
      } catch (e) {
        return { ok: false, code: 'snapshot_failed', error: '无法建立原内容的恢复快照，未替换画布：' + (e && e.message ? e.message : e) };
      }
      // setMolecule recentres/rescales imported KET. A failed load must restore
      // the actual original Struct, rather than importing its source a second
      // time and silently changing drawing coordinates or clearing history.
      const ed = adapter.ed;
      const prevRuntime = ed?.render?.setMolecule ? { struct: adapter.struct(),
        history: ed.historyStack.slice(), historyPtr: ed.historyPtr,
        selection: JSON.parse(JSON.stringify(ed.selection())), reactionSteps: S.reactionSteps?.captureRuntime(), offset: Object.assign(Object.create(Object.getPrototypeOf(ed.render.options.offset)), ed.render.options.offset) } : null;
      const prevSteps = S.reactionSteps?.export(previous.ket);
      const prevStepOperations = S.reactionSteps?.exportOperations?.();
      const prevAgentTask = S.agentTask?.export();
      const prevMech = model.cloneState();
      const prevDocument = S.documentController?.export();
      const prevSel = new Set(controller.selection);
      try {
        adapter.suppressReset = true;
        // Parse through the supported native bridge, then restore every source
        // atom coordinate explicitly. prepareKet normalises bond lengths; a
        // .molwork is an editing snapshot and must never normalise its drawing.
        // This works for zero/one atoms and disconnected structures as well.
        const native = iframeWin().molstudioNativeActions;
        if (native?.prepareKet && ed?.render?.setMolecule) {
        const imported = native.prepareKet(JSON.stringify(parsed.doc.ket));
        const sourceAtoms = [];
        const refs = (parsed.doc.ket.root?.nodes || []).filter(n => n.$ref).map(n => n.$ref);
        const keys = refs.length ? refs : Object.keys(parsed.doc.ket);
        for (const key of keys) if (parsed.doc.ket[key]?.type === 'molecule') sourceAtoms.push(...(parsed.doc.ket[key].atoms || []));
        const runtimeAtoms = [...imported.atoms.values()];
        if (sourceAtoms.length !== runtimeAtoms.length) throw new Error('文件原子坐标清单不完整');
        const restoreAtomCoordinates = () => sourceAtoms.forEach((atom, index) => { const loc = atom.location; if (!Array.isArray(loc) || !Number.isFinite(loc[0]) || !Number.isFinite(loc[1])) throw new Error('文件原子坐标无效'); runtimeAtoms[index].pp.x = loc[0]; runtimeAtoms[index].pp.y = -loc[1]; });
        restoreAtomCoordinates();
        // Struct.rescale() only applies 1 / getAvgBondLength(), with no
        // translation. Compute its exact original factor using the restored
        // coordinates and the same native method, invert it for every native
        // collection (texts, shapes, images, straight arrows, pluses, Sgroups),
        // then restore atoms once more. No geometric fit or anchor is involved.
        const sourceBondLength = imported.getAvgBondLength();
        if (sourceBondLength >= .001 && Math.abs(sourceBondLength - 1) > 1e-12) imported.scale(sourceBondLength);
        restoreAtomCoordinates();
        ed.render.setMolecule(imported); ed.selection(null); ed.clearHistory(); ed.update(true);
        } else {
          if (parsed.doc.document) throw new Error('保留文档坐标的原生载入接口未就绪');
          await ketcher.setMolecule(JSON.stringify(parsed.doc.ket));
        }
        await sleep(180);
        await waitFor(() => {
          const st = adapter.struct();
          return st && st.atoms && st.atoms.size >= 0;
        }, 8000, 100);
        await sleep(120);
        adapter.resetIdentity();
        adapter._loadedKet = parsed.doc.ket;
        adapter.syncIdentity();
        const rb = adapter.applyBindings(parsed.doc.bindings);
        if (!rb.ok) throw new Error(rb.error || '绑定恢复失败');
        model.setState(parsed.doc.mechanism, 'load');
        S.documentController?.restore(parsed.doc.document || null, 'load');
        S.reactionSteps?.restore(parsed.doc.reactionSteps || [], parsed.doc.ket, parsed.doc.reactionStepOperations || []);
        S.agentTask?.restore(parsed.doc.agentTask || null);
        controller.selection.clear();
        controller.emitSelection();
        controller.refreshAutoSlots();
        controller.render();
        if (S.documentController?.active && S.documentController.state.mode === 'paper') S.documentController.fitPage();
        return { ok: true, atoms: rb.atoms, bonds: rb.bonds, counts: model.counts() };
      } catch (e) {
        // 回滚必须一起恢复 KET、稳定绑定与机理层；重新导入会分配新的运行时 ID。
        let rollbackError = null;
        try {
          if (prevRuntime) {
            ed.render.setMolecule(prevRuntime.struct);
            ed.render.options.offset = prevRuntime.offset;
            ed.historyStack = prevRuntime.history;
            ed.historyPtr = prevRuntime.historyPtr;
            ed.selection(prevRuntime.selection);
            ed.update(true);
          } else {
            await ketcher.setMolecule(previous.ketText);
            await sleep(200);
          }
          adapter.resetIdentity();
          adapter._loadedKet = previous.ket;
          adapter.syncIdentity();
          const rb = adapter.applyBindings(previous.bindings);
          if (!rb.ok) throw new Error(rb.error || '原内容绑定恢复失败');
        } catch (e2) { rollbackError = e2; }
        model.setState(prevMech, 'rollback');
        S.documentController?.restore(prevDocument || null, 'rollback');
        try { if (prevRuntime?.reactionSteps) S.reactionSteps.restoreRuntime(prevRuntime.reactionSteps); else S.reactionSteps?.restore(prevSteps || [], previous.ket, prevStepOperations || []); } catch (e2) { rollbackError = rollbackError || e2; }
        try { S.agentTask?.restore(prevAgentTask || null); } catch (e2) { rollbackError = rollbackError || e2; }
        controller.selection = prevSel;
        controller.emitSelection();
        controller.refreshAutoSlots();
        controller.render();
        if (rollbackError) {
          return { ok: false, code: 'rollback_failed', error: '载入失败，原内容恢复也失败：' + (rollbackError.message || rollbackError) };
        }
        return { ok: false, code: 'load_failed', error: '载入失败，已恢复原内容：' + (e && e.message ? e.message : e) };
      } finally {
        adapter.suppressReset = false;
      }
    };

    api.hasMechanismContent = function () { return !!model && !model.isEmpty(); };

    api.mechanismCounts = function () { return model ? model.counts() : { lonePairs: 0, arrows: 0 }; };

    api.mechanismSelectionCount = function () { return controller ? controller.selection.size : 0; };

    api.setMechanismTool = function (tool) { if (controller) controller.setTool(tool); return controller ? controller.tool : null; };

    /* ---------------- 剪贴板（原生编辑菜单调用） ----------------
     * 载荷文本由 JS 打包，写入 NSPasteboard 由原生侧完成：
     * 「系统剪贴板里现在是什么」只有一个权威来源，不会出现内部缓存抢粘贴。
     * 返回空串 = 这次不该由机理层处理，原生侧转回 WebKit 原生复制/剪切。
     */
    api.mechCopyPayload = function () {
      if (!S.ready || !controller || controller.focusedIsEditable()) return '';
      let payload = null;
      try { payload = controller.buildCopyPayload(); } catch (e) { return ''; }
      if (!payload || payload.includeMolecules === true || payload.molecules) return '';
      return JSON.stringify(payload);
    };

    /* 剪切的后半段：原生侧确认载荷已经写进剪贴板之后才删 */
    api.mechCutAfterCopy = function (text) {
      if (!S.ready || !controller) return false;
      let payload;
      try { payload = JSON.parse(text); } catch (e) { return false; }
      if (!payload || payload.includeMolecules === true || payload.molecules) return false;
      return controller.cutAfterCopy(payload);
    };

    /* 原生宿主确认写入成功后再更新复制状态；写入失败时不误报成功。 */
    api.mechCopyResult = function (text, ok) {
      if (!S.ready || !controller || !ok) return false;
      let payload;
      try { payload = JSON.parse(text); } catch (e) { return false; }
      if (payload.includeMolecules === true || payload.molecules) return false;
      const arrowCount = Array.isArray(payload.arrows) ? payload.arrows.length : 0;
      const lonePairCount = Array.isArray(payload.lonePairs) ? payload.lonePairs.length : 0;
      const desc = arrowCount + ' 根箭头' + (lonePairCount ? ' / ' + lonePairCount + ' 个孤对' : '');
      controller.status('已复制 ' + desc);
      return true;
    };

    api.mechClipboardWriteResult = function (requestId, ok) {
      return controller && controller.clipboardWriteResult(requestId, ok);
    };

    /* Focus Ketcher's real clipboard receiver so AppKit's standard actions reach its DOM handlers. */
    api.prepareNativeClipboard = function (command) {
      return !!(S.ready && controller && controller.prepareClipboardReceiver(command));
    };

    api.focusedIsEditable = function () {
      return !!(controller && controller.focusedIsEditable());
    };

    api.mechPaste = function (text) {
      if (!S.ready || !controller) return false;
      return Promise.resolve(controller.beginPasteText(text)).then((r) => {
        if (root.toast && controller.lastStatusText) root.toast(controller.lastStatusText);
        return r;
      });
    };

    /* 导出：kind = 'svg' | 'png'，返回 dataURL 供原生写盘 */
    api.exportMechanismImage = async function (kind) {
      return exportImage(kind);
    };

    api.workbenchReady = function () { return S.ready; };
  }

  async function exportImage(kind) {
    if (!S.ready) return { ok: false, error: '机理层未就绪' };
    if (S.controller.nativePasteSession || iframeWin()?.molstudioClipboard?.nativePreviewActive) return { ok: false, error: '请先放置或取消正在粘贴的片段，再导出文档' };
    const svgEl = S.adapter.canvasSvg();
    if (!svgEl) return { ok: false, error: '找不到画布内容' };
    // 包围盒综合模型（原子/孤对/箭头）与渲染内容（原生文字、形状、图例），确保不裁切
    const bbox = MW.exporter.fullExportBBox(svgEl, S.adapter, S.model, S.controller.ctx(), 10);
    const built = MW.exporter.buildSvg(svgEl, {
      padding: 10,
      bbox: bbox,
      layer: S.layer,
      model: S.model,
      adapter: S.adapter,
      ctx: S.controller.ctx()
    });
    if (!built.ok) return { ok: false, error: built.error };
    if (kind === 'svg') {
      return {
        ok: true, mime: 'image/svg+xml', ext: 'svg',
        dataUrl: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(built.svg))),
        width: built.width, height: built.height, fileName: '机理图.svg'
      };
    }
    try {
      const png = await MW.exporter.svgToPng(built.svg, built.width, built.height, 2, iframeWin());
      return {
        ok: true, mime: 'image/png', ext: 'png',
        dataUrl: png.dataUrl, width: png.width, height: png.height, fileName: '机理图.png'
      };
    } catch (e) {
      return { ok: false, error: 'PNG 生成失败：' + (e && e.message ? e.message : e) };
    }
  }

  MW.app = S;
  MW.exportImage = exportImage;
  MW.boot = boot;

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', () => { boot(); });
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
