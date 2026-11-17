/* MolStudio agent composition: UI, browser runtime and the existing workbench. */
(function (root) {
  'use strict';
  if (new URLSearchParams(root.location.search).get('documentPrototype') === '1') return;
  if (root.molstudioAgent) return;
  let panel, runtime, config, setupPromise, requestGeneration = 0, pendingStart = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const EXTERNAL_OPEN_TOOLS = new Set([
    'read_canvas',
    'inspect_structures',
    'draw_operations',
    'plan_task',
    'write_plan',
    'complete_phase',
    'complete_layout',
    'post_message',
  ]);
  const externalClientId = root.crypto?.randomUUID?.() || `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const cancelledExternalRequests = new Set();
  let externalBridgeActive = false;
  let externalEventSource = null;
  let externalHeartbeatTimer = null;
  let externalBridgeUnsubscribers = [];
  let activeExternalRequestId = null;
  let lastKnownSessionId = '';

  async function loadConfig() {
    const response = await fetch('/api/agent/config', { cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '无法读取模型设置');
    config = value;
    panel?.setConfig?.(value);
    return value;
  }

  async function saveConfig(values) {
    const current = config || await loadConfig();
    const response = await fetch('/api/agent/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MolStudio-Agent-Token': current.sessionToken },
      body: JSON.stringify(values),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '模型设置保存失败');
    config = value;
    panel?.setConfig?.(value);
    return value;
  }

  function updateLayout() {
    if (!panel) return;
    const { open, width, drawer } = panel.getLayout();
    const dock = open && !drawer ? width : 0;
    const bar = document.getElementById('mech-sel-bar');
    if (bar) {
      bar.style.left = `calc((100% - ${dock}px) / 2)`;
      bar.style.maxWidth = `calc(100vw - ${dock + 110}px)`;
    }
    const help = document.getElementById('helpBtn');
    if (help) help.style.right = `${dock + 16}px`;
    const iframe = document.getElementById('k');
    try { iframe?.contentWindow?.dispatchEvent(new Event('resize')); } catch { /* Frame still loading. */ }
    root.MolWorkbench?.app?.controller?.render?.();
  }

  function isNativePanel(target) {
    return typeof root.MolStudioAgentNativeRenderer === 'function' && target instanceof root.MolStudioAgentNativeRenderer;
  }
  function isBrowserPanel(target) {
    return typeof root.MolStudioAgentPanel === 'function' && target instanceof root.MolStudioAgentPanel;
  }

  function ownsFocus() {
    if (panel?.ownsFocus?.()) return true;
    // Native AI input: the host reports windowKey + focusOwner through
    // host.context; browser "blur" must not mean the app is inactive.
    if (isNativePanel(panel)) return panel.ownsFocus();
    return false;
  }
  function nativeHostWindowKey() {
    try {
      const state = root.k3dAPI?.nativeUI?.getState?.();
      return !!(state && state.host && state.host.windowKey);
    } catch { return false; }
  }
  function textCommand(name) {
    const active = document.activeElement;
    if (name === 'selectAll' && active && panel?.element.contains(active) && typeof active.select === 'function') {
      active.select(); return true;
    }
    try { document.execCommand(name, false); } catch { /* Never fall through to canvas editing. */ }
    return true;
  }

  function installFocusRouting() {
    const api = root.k3dAPI;
    if (!api || api.__agentFocusRouting) return;
    api.__agentFocusRouting = true;
    for (const [name, command] of [['undo', 'undo'], ['redo', 'redo'], ['selectAll', 'selectAll'], ['deleteSel', 'delete']]) {
      const previous = api[name];
      if (typeof previous !== 'function') continue;
      api[name] = function () {
        if (ownsFocus()) return textCommand(command);
        if (name === 'undo' || name === 'redo' || name === 'deleteSel') runtime?.stop?.('manual_edit');
        return previous.apply(this, arguments);
      };
    }
    for (const name of ['prepareNativeClipboard', 'focusedIsEditable']) {
      const previous = api[name];
      api[name] = function () { return ownsFocus() || !!previous?.apply(this, arguments); };
    }
    const zoomBy = api.zoomBy;
    if (typeof zoomBy === 'function') api.zoomBy = function (factor, anchor) {
      if (ownsFocus() && !anchor) return false;
      if (anchor && panel?.element && !panel.element.hidden) {
        const rect = panel.element.getBoundingClientRect();
        if (anchor.x >= rect.left && anchor.x <= rect.right && anchor.y >= rect.top && anchor.y <= rect.bottom) return false;
      }
      return zoomBy.apply(this, arguments);
    };
  }

  async function setup() {
    if (runtime) return runtime;
    if (setupPromise) return setupPromise;
    setupPromise = (async () => {
      const start = Date.now();
      while (!root.k3dAPI?.agent?.getContext) {
        if (Date.now() - start > 25_000) throw new Error('化学工作台尚未就绪，请稍后重试');
        await sleep(100);
      }
      if (!root.MolStudioAgentRuntime?.Runtime) throw new Error('AI 运行组件未加载，请重新构建应用');
      // agent-bridge installs deferred wrappers before Ketcher finishes booting.
      // Wait for the real bridge: main.installAPI otherwise overwrites these
      // text-focus routes after the assistant has already mounted.
      await root.k3dAPI.agent.getContext();
      installFocusRouting();
      runtime = new root.MolStudioAgentRuntime.Runtime({
        bridge: () => root.k3dAPI.agent,
        getConfig: loadConfig,
        onEvent: event => {
          panel?.handleEvent(event);
          root.dispatchEvent(new CustomEvent('molstudio:agent-event', { detail: event }));
          if (event.type === 'error' && event.code === 'SETUP_REQUIRED') panel?.showSettings?.();
        },
      });
      // Restore the saved task as a resume affordance only. Opening a document
      // never starts a model request; the user must click Continue.
      await runtime.restoreTaskCheckpoint?.();
      return runtime;
    })();
    try { return await setupPromise; } finally { setupPromise = null; }
  }

  async function startRequest(action) {
    const generation = ++requestGeneration;
    pendingStart = true;
    panel?.onStateChange?.();
    try {
      const activeRuntime = await setup();
      if (generation !== requestGeneration) return { status: 'stopped' };
      pendingStart = false;
      panel?.onStateChange?.();
      const result = await action(activeRuntime);
      if (generation === requestGeneration && result.status === 'setup_required') panel?.showSettings?.();
      return result;
    } finally {
      if (generation === requestGeneration) pendingStart = false;
      panel?.onStateChange?.();
    }
  }
  const send = text => {
    if (isNativePanel(panel)) {
      panel.handleEvent({ type: 'user_message', text });
    }
    return startRequest(activeRuntime => activeRuntime.run(text));
  };
  function stop(reason = 'user') {
    const wasPending = pendingStart;
    requestGeneration++; pendingStart = false;
    if (wasPending && !runtime?.isRunning) panel?.handleEvent({ type: 'run_end', status: 'stopped', reason, canContinue: false });
    panel?.onStateChange?.();
    return runtime?.stop(reason);
  }

  async function refreshExternalSessionId() {
    try {
      const ctx = await root.k3dAPI?.agent?.getContext?.();
      if (ctx?.sessionId) lastKnownSessionId = String(ctx.sessionId);
    } catch { /* Canvas may still be booting. */ }
    if (runtime?._externalRun?.sessionId) lastKnownSessionId = String(runtime._externalRun.sessionId);
    return lastKnownSessionId;
  }

  function postExternalStatus() {
    if (!externalBridgeActive || panel?.disposed || typeof root.fetch !== 'function') return Promise.resolve();
    const focused = ((typeof document.hasFocus === 'function' ? document.hasFocus() : true) || nativeHostWindowKey()) && document.visibilityState !== 'hidden';
    const busy = !!(pendingStart || runtime?.isRunning || activeExternalRequestId);
    const sessionId = String(runtime?._externalRun?.sessionId || lastKnownSessionId || '');
    return root.fetch('/api/agent/external/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: externalClientId, sessionId, focused, busy }),
    }).catch(() => {});
  }

  function postExternalResult(requestId, result) {
    if (!requestId || typeof root.fetch !== 'function') return Promise.resolve();
    const payload = {
      requestId,
      ok: result?.ok !== false,
      isError: result?.isError === true,
      text: typeof result?.text === 'string' ? result.text : '',
      data: result?.data ?? null,
      changes: Array.isArray(result?.changes) ? result.changes : [],
      ...(result?.error !== undefined && { error: result.error }),
      ...(result?.diagnostic !== undefined && { diagnostic: result.diagnostic }),
    };
    return root.fetch('/api/agent/external/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  async function handleExternalCommand(command) {
    if (!command || typeof command !== 'object') {
      return { ok: false, isError: true, text: '无效的外部指令', error: '无效的外部指令', changes: [] };
    }
    if (command.type === 'cancel') {
      if (command.requestId) {
        // FIFO cap: the newest marks stay paired with late SSE tool calls;
        // a blanket clear() would let cancelled requests revive and execute.
        cancelledExternalRequests.add(command.requestId);
        while (cancelledExternalRequests.size > 64) {
          cancelledExternalRequests.delete(cancelledExternalRequests.values().next().value);
        }
      }
      if ((command.requestId && activeExternalRequestId === command.requestId) || (!command.requestId && runtime?._externalActive)) {
        runtime?.stop?.('external_cancel');
      }
      return { ok: true, cancelled: true };
    }

    const toolName = command.tool || command.toolName;
    const requestId = command.requestId;
    if (!toolName || typeof toolName !== 'string') {
      return { ok: false, isError: true, text: '缺少工具名称', error: '缺少工具名称', changes: [] };
    }
    if (requestId && cancelledExternalRequests.delete(requestId)) {
      return { ok: true, isError: true, text: '外部请求已取消', error: '外部请求已取消', changes: [] };
    }
    if (EXTERNAL_OPEN_TOOLS.has(toolName)) {
      panel?.setOpen?.(true);
      try { root.webkit?.messageHandlers?.k3d?.postMessage?.({ act: 'revealCanvas' }); } catch { /* Browser mode. */ }
    }

    const activeRuntime = await setup();
    if (requestId && cancelledExternalRequests.delete(requestId)) {
      return { ok: true, isError: true, text: '外部请求已取消', error: '外部请求已取消', changes: [] };
    }
    const token = requestId || toolName;
    activeExternalRequestId = token;
    postExternalStatus();
    try {
      const result = await activeRuntime.executeExternalTool(toolName, command.args || {}, {
        clientName: command.clientName,
        requestId,
      });
      await refreshExternalSessionId();
      return result;
    } finally {
      if (activeExternalRequestId === token) activeExternalRequestId = null;
      postExternalStatus();
    }
  }

  function stopExternalBridge() {
    externalBridgeActive = false;
    for (const remove of externalBridgeUnsubscribers) {
      try { remove(); } catch { /* Ignore removal errors. */ }
    }
    externalBridgeUnsubscribers = [];
    if (externalHeartbeatTimer) {
      clearInterval(externalHeartbeatTimer);
      externalHeartbeatTimer = null;
    }
    if (externalEventSource) {
      try { externalEventSource.close(); } catch { /* Ignore close errors. */ }
      externalEventSource = null;
    }
  }

  function startExternalBridge() {
    if (externalBridgeActive) return;
    if (typeof root.EventSource !== 'function') return;
    if (!/^https?:$/i.test(root.location?.protocol || '')) return;
    externalBridgeActive = true;
    const url = `/api/agent/external/events?clientId=${encodeURIComponent(externalClientId)}&sessionId=${encodeURIComponent(lastKnownSessionId)}`;
    const es = new root.EventSource(url);
    externalEventSource = es;

    es.addEventListener('connected', () => {
      refreshExternalSessionId().then(() => postExternalStatus());
    });
    es.addEventListener('message', event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'cancel') {
        handleExternalCommand(payload);
        return;
      }
      if (payload.type === 'tool_call') {
        Promise.resolve().then(async () => {
          let result;
          try {
            result = await handleExternalCommand(payload);
          } catch (error) {
            const msg = error?.message || String(error);
            result = { ok: false, isError: true, text: msg, error: msg, changes: [] };
          }
          await postExternalResult(payload.requestId, result);
        });
      }
    });

    const onStatusTrigger = () => postExternalStatus();
    const onCanvasChange = () => { refreshExternalSessionId().then(() => postExternalStatus()); };
    const onAgentEvent = event => {
      const type = event?.detail?.type;
      if (type === 'run_start' || type === 'run_end' || type === 'external_idle') postExternalStatus();
    };
    // Collect the unsubscribers so stopExternalBridge can detach every listener.
    externalBridgeUnsubscribers = [
      () => root.removeEventListener('focus', onStatusTrigger),
      () => root.removeEventListener('blur', onStatusTrigger),
      () => document.removeEventListener('visibilitychange', onStatusTrigger),
      () => root.removeEventListener('molstudio:agent-canvas-change', onCanvasChange),
      () => root.removeEventListener('molstudio:agent-event', onAgentEvent),
    ];
    for (const [target, type, handler] of [
      [root, 'focus', onStatusTrigger],
      [root, 'blur', onStatusTrigger],
      [document, 'visibilitychange', onStatusTrigger],
      [root, 'molstudio:agent-canvas-change', onCanvasChange],
      [root, 'molstudio:agent-event', onAgentEvent],
    ]) target.addEventListener(type, handler);
    externalHeartbeatTimer = setInterval(() => {
      if (panel?.disposed) { stopExternalBridge(); return; }
      postExternalStatus();
    }, 10000);
    externalHeartbeatTimer.unref?.();
    postExternalStatus();
  }

  function createPanel() {
    return new root.MolStudioAgentPanel({
      container: document.body,
      onSend: send,
      onStop: () => stop(),
      onContinue: () => startRequest(activeRuntime => activeRuntime.continue()),
      onReset: () => { requestGeneration++; pendingStart = false; runtime?.reset(); },
      onSettingsLoad: loadConfig,
      onSettingsSave: saveConfig,
      onToggle: () => updateLayout(),
    });
  }

  /* Native renderer lifecycle (contract §6): swap the presentation interface
   * only. The single runtime, the pending request, checkpoints and the external
   * bridge are untouched; toggling the native panel never destroys the runtime
   * and never shrinks the iframe (renderer getLayout width is 0). */
  function useNativeRenderer(renderer) {
    if (!isNativePanel(renderer)) return false;
    if (panel === renderer) return true;
    if (panel && typeof panel.destroy === 'function' && !isNativePanel(panel)) panel.destroy();
    panel = renderer;
    if (config) panel.setConfig(config);
    if (runtime) {
      if (runtime.checkpoint) panel.handleEvent({ type: 'task_checkpoint', checkpoint: runtime.checkpoint });
      if (runtime.canContinue && !runtime.isRunning) panel.handleEvent({ type: 'resume_available', reason: 'saved_task' });
    }
    updateLayout();
    return true;
  }
  function restoreBrowserRenderer() {
    if (root.MolStudioAgentPanel && !isBrowserPanel(panel)) {
      const renderer = isNativePanel(panel) ? panel : null;
      panel = createPanel();
      if (renderer) {
        renderer.disposed = true;
        const config = renderer.config;
        if (config && Object.keys(config).length) panel.setConfig(config);
        panel.showError(renderer.error ? renderer.error.message : '原生 AI 视图已断开，已恢复网页面板');
      }
      updateLayout();
      return true;
    }
    return false;
  }

  function mount() {
    if (!root.MolStudioAgentPanel) return;
    panel = createPanel();
    root.molstudioAgent = {
      toggle: () => panel.toggle?.() ?? (() => { if (isNativePanel(panel)) panel.setOpen(!panel.open); })(),
      open: () => { if (isNativePanel(panel)) panel.setOpen(true); else panel.setOpen(true); },
      ownsFocus,
      stop,
      isRunning: () => pendingStart || !!runtime?.isRunning,
      pendingStart: () => pendingStart,
      getRuntime: () => runtime,
      getPanel: () => panel,
      send,
      continue: () => startRequest(activeRuntime => activeRuntime.continue()),
      reset: () => {
        requestGeneration++; pendingStart = false;
        runtime?.reset();
        panel?.clear?.();
      },
      loadSettings: loadConfig,
      saveSettings: saveConfig,
      useNativeRenderer,
      restoreBrowserRenderer,
      handleExternalCommand,
    };
    loadConfig().catch(error => panel.showError(error.message || String(error)));
    setup().then(() => {
      updateLayout();
      return refreshExternalSessionId();
    }).then(() => postExternalStatus()).catch(error => panel.showError(error.message || String(error)));
    startExternalBridge();
    root.addEventListener('resize', updateLayout);
    root.addEventListener('beforeunload', () => { stop('navigation'); stopExternalBridge(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(window);
