/* MolStudio native AI renderer adapter (contract v1 §6).
 *
 * Replaces the DOM panel interface inside the SAME agent app: it never creates
 * a second runtime, a hidden DOM panel, or a second transport. The app keeps
 * calling the same send/startRequest/stop functions; this object only converts
 * public runtime events into a filtered JSON presentation published on the
 * single `kind:"agent"` nativeUI channel.
 *
 * What is filtered out: hidden channels (analysis/reasoning/thinking text),
 * private runtime internals, provider raw payloads, sessionToken / apiKey.
 */
(function (root) {
  'use strict';

  function text(value, fallback) { return typeof value === 'string' ? value : (fallback || ''); }

  function compactDiagnostic(value) {
    const compact = root.MolStudioAgentRuntime && root.MolStudioAgentRuntime.compactToolDiagnostic;
    if (typeof compact === 'function') return compact(value);
    const out = {};
    for (const key of ['code', 'phase', 'errorName', 'operationType', 'operationId', 'field', 'stepId']) {
      if (value && typeof value[key] === 'string' && /^[A-Za-z0-9_.:[\]-]{1,160}$/.test(value[key]) && !/^sk[-_]/i.test(value[key])) out[key] = value[key];
    }
    for (const key of ['operationIndex', 'atomIndex', 'atomMap', 'expectedVersion', 'actualVersion', 'currentVersion']) {
      if (value && Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
    }
    return out;
  }

  function sanitizeToolProgress(progress) {
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return undefined;
    const out = {};
    if (typeof progress.phase === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(progress.phase) && !/^sk[-_]/i.test(progress.phase)) {
      out.phase = progress.phase;
    }
    for (const key of ['count', 'completed', 'total']) {
      if (Number.isSafeInteger(progress[key]) && progress[key] >= 0) out[key] = progress[key];
    }
    return Object.keys(out).length ? out : undefined;
  }

  function sanitizeCheckpoint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowedStatuses = new Set(['pending', 'active', 'running', 'completed', 'failed', 'cancelled', 'paused', 'stopped']);
    const out = {};
    if (typeof value.goal === 'string') out.goal = value.goal.slice(0, 240);
    if (typeof value.status === 'string' && allowedStatuses.has(value.status)) out.status = value.status;
    if (Number.isSafeInteger(value.phaseIndex) && value.phaseIndex >= 0) out.phaseIndex = value.phaseIndex;
    if (Array.isArray(value.phases)) {
      out.phases = value.phases.slice(0, 64).map(phase => {
        if (!phase || typeof phase !== 'object') return {};
        const item = {};
        if (typeof phase.objective === 'string') item.objective = phase.objective.slice(0, 240);
        if (typeof phase.status === 'string' && allowedStatuses.has(phase.status)) item.status = phase.status;
        return item;
      });
    }
    return Object.keys(out).length ? out : null;
  }

  function sanitizeGenerationFields(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
    const out = {};
    if (fields.thinking && typeof fields.thinking === 'object' && !Array.isArray(fields.thinking)) {
      const t = {};
      if (['enabled', 'disabled', 'adaptive'].includes(fields.thinking.type)) t.type = fields.thinking.type;
      if (Number.isSafeInteger(fields.thinking.budget_tokens) && fields.thinking.budget_tokens > 0) t.budget_tokens = fields.thinking.budget_tokens;
      if (Object.keys(t).length) out.thinking = t;
    }
    if (typeof fields.reasoning_effort === 'string' && ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(fields.reasoning_effort)) {
      out.reasoning_effort = fields.reasoning_effort;
    }
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      if (Number.isSafeInteger(fields[key]) && fields[key] > 0) out[key] = fields[key];
    }
    return Object.keys(out).length ? out : null;
  }

  function sanitizeFinishRejected(value) {
    if (value === undefined || value === null || value === false) return undefined;
    if (value === true) return true;
    if (typeof value === 'string') return value.slice(0, 240);
    if (typeof value === 'object' && typeof value.reason === 'string') return value.reason.slice(0, 240);
    return true;
  }

  function sanitizeGeneration(value) {
    if (!value || typeof value !== 'object') return { profile: 'provider-default', effort: 'default', maxOutputTokens: null };
    return {
      profile: ['provider-default', 'deepseek', 'openai'].includes(value.profile) ? value.profile : 'provider-default',
      effort: ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort) ? value.effort : 'default',
      maxOutputTokens: Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 ? value.maxOutputTokens : null
    };
  }

  function sanitizeCapabilities(caps) {
    if (!caps || typeof caps !== 'object') return null;
    const openaiModels = {};
    const allowed = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const [model, efforts] of Object.entries(caps.openaiModels || {})) {
      if (Array.isArray(efforts)) openaiModels[model] = efforts.filter(v => allowed.has(v));
    }
    return { openaiModels };
  }

  function toolDisplayLabel(name) {
    const value = text(name).toLowerCase();
    if (value.includes('arrow') || value.includes('electron')) return '绘制电子箭头';
    if (value.includes('molecule') || value.includes('structure')) return '处理分子结构';
    if (value.includes('selection') || value.includes('scene') || value.includes('read') || value.includes('inspect')) return '读取画布';
    if (value.includes('draw') || value.includes('operation')) return '更新画布';
    if (value.includes('complete_phase')) return '核对阶段';
    if (value.includes('complete_layout')) return '核对排版';
    if (value.includes('plan') || value.includes('write_plan')) return '规划步骤';
    return text(name) || '执行工具';
  }

  function parseChanges(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return text(item.text || item.label || item.summary);
      return '';
    }).filter(Boolean);
  }

  function normalizePlanSteps(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.slice(0, 64).map(step => {
      if (typeof step === 'string') return { text: step, status: 'pending' };
      const label = text(step && (step.text || step.label));
      const raw = text(step && step.status).toLowerCase();
      let status = 'pending';
      if (raw === 'done' || raw === 'complete' || raw === 'completed' || (step && step.done === true)) status = 'completed';
      else if (raw === 'running' || raw === 'in_progress' || raw === 'executing') status = 'running';
      else if (raw === 'failed' || raw === 'error') status = 'failed';
      return { text: label, status };
    });
  }

  class NativeAgentRenderer {
    constructor(options) {
      this.options = options || {};
      this.disposed = false;
      this.rendererRevision = 0;
      this.resetGeneration = 0;
      this.open = false; // Logical visibility of the native AI surface.
      this.settingsBusy = false;
      this.canContinue = false;
      this.running = false;
      this.messages = [];  // Public messages only: {key, id, messageId, runId, role, text, renderedHtml, createdAt}
      this.runs = [];      // Complete WorkspacePublicRun records for snapshot parity
      this.runMap = new Map();
      this.activeRunId = null;
      this.localMessageSeq = 0;
      this.messageKeys = new Set();
      this.retiredRuns = new Set(); // Runs cleared by reset: their late events never resurrect content.
      this.config = { configured: false, provider: 'openai-compatible', model: '', baseUrl: '', generation: sanitizeGeneration(null) };
      this.status = '';
      this.error = null;
      this.settingsVisible = false;
      this.checkpoint = null;
      this.transport = null;
    }

    onStateChange() {
      if (this.options && typeof this.options.onStateChange === 'function') {
        try { this.options.onStateChange(); } catch { /* Listener errors must not affect runtime events. */ }
      }
    }

    hostContext() { return this.options.hostContext ? this.options.hostContext() : { windowKey: true, focusOwner: 'none' }; }

    /* Focus: the native input has focus when the host window is key AND
     * Swift reports focusOwner === 'nativeText' (or 'agent' in unit tests). */
    ownsFocus() {
      const host = this.hostContext();
      return !this.disposed && !!host.windowKey && (host.focusOwner === 'agent' || host.focusOwner === 'nativeText');
    }

    /* Native mode: the in-page dock width is 0. The real inspector width is
     * owned by NSSplitViewController, so the iframe must never shrink again. */
    getLayout() { return { open: this.open, width: 0, drawer: false }; }

    setOpen(open) {
      this.open = !!open;
      this.publish({ type: 'layout', open: this.open });
    }

    showSettings(show) {
      this.settingsVisible = show !== false;
      this.publish({ type: 'settings_visible', visible: this.settingsVisible });
    }

    showError(publicMessage) {
      this.error = { message: text(publicMessage, '发生错误'), at: Date.now() };
      this.publish({ type: 'error_shown', message: this.error.message });
    }

    clear() {
      // reset / clear display history: bump resetGeneration so late events of
      // old runs can never resurrect cleared content.
      this.resetGeneration += 1;
      for (const runId of this.runMap.keys()) {
        if (this.retiredRuns.size > 256) this.retiredRuns.clear();
        this.retiredRuns.add(runId);
      }
      this.messages = [];
      this.runs = [];
      this.runMap.clear();
      this.activeRunId = null;
      this.messageKeys.clear();
      this.canContinue = false;
      this.running = false;
      this.status = '';
      this.error = null;
      this.checkpoint = null;
      this.publishSnapshot(true);
      this.onStateChange();
    }

    /* ---- runtime event intake (same events the DOM panel receives) ---- */
    handleEvent(event) {
      if (this.disposed || !event || typeof event !== 'object') return false;
      const type = text(event.type || event.event);
      // Late events of a cleared run must not restore cleared content.
      if (event.runId && this.retiredRuns.has(event.runId) && type !== 'task_checkpoint') return false;
      if (type === 'user_message') {
        const body = text(event.text);
        if (!body) return false;
        const msgId = text(event.messageId) || ('user-' + (++this.localMessageSeq));
        const msg = this.appendMessage(event.runId || null, msgId, 'user', body, undefined, event.createdAt);
        this.error = null;
        this.publishEvent(event, { messageId: msg.messageId, text: body, ...(Number.isFinite(msg.createdAt) ? { createdAt: msg.createdAt } : {}) });
        return true;
      }
      if (type === 'run_start') {
        const prevRunning = this.running, prevContinue = this.canContinue;
        this.running = true;
        this.canContinue = false;
        const run = this.ensureRun(event);
        if (run) {
          this.activeRunId = run.id;
          run.finished = false;
          run.status = 'running';
          if (event.external === true) {
            run.external = true;
            run.clientName = text(event.clientName) || 'MCP';
          }
        }
        this.publishEvent(event, {
          status: 'running',
          external: !!(run && run.external),
          ...(run && run.external ? { clientName: run.clientName || 'MCP' } : {}),
          ...(Number.isSafeInteger(event.recoveryAttempt) ? { recoveryAttempt: event.recoveryAttempt } : {})
        });
        if (prevRunning !== this.running || prevContinue !== this.canContinue) this.onStateChange();
        return true;
      }
      if (type === 'task_checkpoint') {
        this.checkpoint = sanitizeCheckpoint(event.checkpoint);
        this.publishEvent(event, { checkpoint: this.checkpoint });
        return true;
      }
      if (type === 'resume_available') {
        const prevContinue = this.canContinue;
        this.canContinue = true;
        this.status = '已载入保存的任务，点击继续执行';
        this.publishEvent(event, { canContinue: true, ...(event.reason ? { reason: text(event.reason) } : {}) });
        if (prevContinue !== this.canContinue) this.onStateChange();
        return true;
      }
      if (type === 'resume_unavailable') {
        const prevContinue = this.canContinue;
        this.canContinue = false;
        this.publishEvent(event, { canContinue: false, ...(event.reason ? { reason: text(event.reason) } : {}) });
        if (prevContinue !== this.canContinue) this.onStateChange();
        return true;
      }
      if (/^recovery_(scheduled|started|exhausted|cancelled)$/.test(type)) {
        const prevRunning = this.running, prevContinue = this.canContinue;
        this.running = type === 'recovery_scheduled' || type === 'recovery_started';
        if (type === 'recovery_exhausted') this.canContinue = event.canContinue !== false;
        else if (type === 'recovery_cancelled') {
          this.running = false;
          this.canContinue = event.canContinue !== false;
        } else {
          this.canContinue = false;
        }
        this.publishEvent(event, {
          recovery: type,
          canContinue: this.canContinue,
          ...(Number.isSafeInteger(event.attempt) ? { attempt: event.attempt } : {}),
          ...(Number.isSafeInteger(event.recoveryAttempts) ? { recoveryAttempts: event.recoveryAttempts } : {}),
          ...(Number.isFinite(event.delayMs) ? { delayMs: event.delayMs } : {}),
          ...(event.reason ? { reason: text(event.reason) } : {})
        });
        if (prevRunning !== this.running || prevContinue !== this.canContinue) this.onStateChange();
        return true;
      }
      switch (type) {
        case 'assistant_start': {
          const run = this.resolveRun(event);
          const msgId = text(event.messageId) || ('assistant-' + (run ? (++run.messageSeq) : (++this.localMessageSeq)));
          if (run) run.activeMessageId = msgId;
          this.appendMessage(run ? run.id : (event.runId || null), msgId, 'assistant', '');
          this.status = '正在回复…';
          this.publishEvent(event, { messageId: msgId });
          return true;
        }
        case 'text_delta': {
          // Hidden channels never enter the public answer.
          if (/^(analysis|reasoning|thinking)$/.test(text(event.channel)) || event.hidden === true) {
            this.status = '正在思考…';
            this.publishEvent(event, { hidden: true, ...(event.channel ? { channel: text(event.channel) } : {}) });
            return true;
          }
          const delta = typeof event.delta === 'string' ? event.delta : (typeof event.text === 'string' ? event.text : '');
          if (!delta) return false;
          const run = this.resolveRun(event);
          const msgId = text(event.messageId)
            || (run && run.activeMessageId)
            || ('assistant-' + (run ? (++run.messageSeq) : (++this.localMessageSeq)));
          if (run && !run.activeMessageId) run.activeMessageId = msgId;
          const renderedHtml = typeof event.renderedHtml === 'string' ? event.renderedHtml : undefined;
          const message = this.appendMessage(run ? run.id : (event.runId || null), msgId, 'assistant', delta, renderedHtml);
          this.publishEvent(event, {
            messageId: msgId,
            delta,
            ...(renderedHtml !== undefined ? { renderedHtml } : {})
          });
          return !!message;
        }
        case 'thinking':
          this.status = event.active === false ? '正在处理…' : '正在思考…';
          this.publishEvent(event, { statusOnly: true, active: event.active !== false });
          return true;
        case 'thinking_delta': {
          this.status = '正在思考…';
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (event.source === 'model' && delta) {
            const run = this.resolveRun(event);
            if (run) run.thinkingText = (run.thinkingText + delta).slice(-32768);
            this.publishEvent(event, { source: 'model', delta });
          } else {
            this.publishEvent(event, { statusOnly: true });
          }
          return true;
        }
        case 'assistant_end': {
          const run = this.resolveRun(event);
          if (run) run.activeMessageId = null;
          this.publishEvent(event, { ...(event.messageId ? { messageId: text(event.messageId) } : {}) });
          return true;
        }
        case 'transport_progress': {
          this.transport = { phase: text(event.phase) || 'progress', requests: event.requests ?? event.turns ?? null, final: event.final === true };
          this.publishEvent(event, {
            phase: text(event.phase) || 'progress',
            final: event.final === true,
            ...(Number.isFinite(event.elapsedMs) ? { elapsedMs: event.elapsedMs } : {}),
            ...(Number.isFinite(event.receivedBytes) ? { receivedBytes: event.receivedBytes } : {}),
            ...(Number.isFinite(event.lastByteAgoMs) ? { lastByteAgoMs: event.lastByteAgoMs } : {}),
            ...(Number.isSafeInteger(event.requests) ? { requests: event.requests } : {}),
            transport: this.transport
          });
          return true;
        }
        case 'transport_retry':
          this.status = '模型连接失败，正在重连…';
          this.publishEvent(event, {});
          return true;
        case 'tool_start': case 'tool_progress': case 'tool_end': {
          const run = this.resolveRun(event);
          const callId = text(event.toolCallId || event.id) || (run ? 'tool-' + (++run.toolSeq) : 'tool-' + (++this.localMessageSeq));
          const toolName = text(event.toolName || event.name);
          const explicitLabel = text(event.label);
          const rawStatus = text(event.status);
          const success = event.success !== false && event.isError !== true && !event.error && !/^(error|failed)$/.test(rawStatus);
          const incomplete = type === 'tool_end' && success && (event.finishRejected === true || typeof event.finishRejected === 'string');
          const state = type === 'tool_end' ? (incomplete ? 'incomplete' : (success ? 'complete' : 'failed')) : 'running';
          const summary = text(event.summary || event.message || (typeof event.progress === 'string' ? event.progress : '') || (typeof event.error === 'string' ? event.error : '')).slice(0, 400);
          const changes = Array.isArray(event.changes) ? parseChanges(event.changes) : undefined;
          const diagnostic = (type === 'tool_end' && (!success || incomplete) && event.diagnostic) ? compactDiagnostic(event.diagnostic) : undefined;
          if (run) {
            if (run.external && !this.running) {
              this.running = true;
              this.onStateChange();
            }
            let entry = run.tools.find(t => t.id === callId);
            if (!entry) {
              entry = { id: callId, name: toolName || null, label: explicitLabel || toolDisplayLabel(toolName), state: 'running', summary: '', changes: [], diagnostic: null };
              run.tools.push(entry);
            }
            entry.state = state;
            if (summary) entry.summary = summary;
            if (changes) entry.changes = changes;
            if (diagnostic) {
              entry.diagnostic = diagnostic;
              if (diagnostic.code) run.lastDiagnosticCode = diagnostic.code;
            }
          }
          const safeProgress = sanitizeToolProgress(event.progress);
          const safeFinishRejected = sanitizeFinishRejected(event.finishRejected);
          this.publishEvent(event, {
            toolCallId: callId,
            toolName,
            ...(toolName ? { name: toolName } : {}),
            ...(explicitLabel ? { label: explicitLabel } : {}),
            state,
            status: rawStatus || undefined,
            success: type === 'tool_end' ? success : undefined,
            isError: event.isError === true ? true : undefined,
            ...(safeFinishRejected !== undefined ? { finishRejected: safeFinishRejected } : {}),
            ...(safeProgress ? { progress: safeProgress } : {}),
            ...(Number.isSafeInteger(event.completedOperations) ? { completedOperations: event.completedOperations } : {}),
            summary,
            ...(changes ? { changes } : {}),
            ...(diagnostic ? { diagnostic } : {})
          });
          return true;
        }
        case 'external_idle': {
          const prevRunning = this.running;
          this.running = false;
          const run = this.resolveRun(event);
          if (run) run.finished = true;
          this.publishEvent(event, {
            external: true,
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
            ...(event.ok !== undefined ? { ok: event.ok } : {}),
            ...(event.success !== undefined ? { success: event.success } : {}),
            ...(event.taskCompleted !== undefined ? { taskCompleted: event.taskCompleted } : {}),
            ...(event.error ? { error: text(event.error) } : {})
          });
          if (prevRunning !== this.running) this.onStateChange();
          return true;
        }
        case 'plan': {
          const steps = normalizePlanSteps(event.steps);
          const run = this.resolveRun(event);
          if (run) run.plan = steps;
          this.publishEvent(event, { steps });
          return true;
        }
        case 'phase_start': case 'phase_end':
          this.publishEvent(event, {
            ...(Number.isSafeInteger(event.phaseIndex) ? { phaseIndex: event.phaseIndex } : {}),
            ...(Number.isSafeInteger(event.phaseCount) ? { phaseCount: event.phaseCount } : {}),
            ...(event.objective ? { objective: text(event.objective).slice(0, 500) } : {}),
            ...(event.summary ? { summary: text(event.summary).slice(0, 500) } : {})
          });
          return true;
        case 'generation_applied': {
          const requested = event.generation?.requested || event.requested || null;
          const effective = event.generation?.effective || event.effective || null;
          const fields = sanitizeGenerationFields(event.generation?.fields || event.fields);
          this.publishEvent(event, {
            generation: {
              ...(requested ? { requested: { profile: requested.profile, effort: requested.effort, maxOutputTokens: requested.maxOutputTokens ?? null } } : {}),
              ...(fields ? { fields } : {}),
              ...(effective ? { effective: { model: effective.model || null, effort: effective.effort || null } } : {})
            },
            ...(requested ? { requested: { profile: requested.profile, effort: requested.effort, maxOutputTokens: requested.maxOutputTokens ?? null } } : {})
          });
          return true;
        }
        case 'step_commit':
          this.publishEvent(event, {
            ...(Number.isSafeInteger(event.count) ? { count: event.count } : {}),
            ...(Number.isSafeInteger(event.completedOperations) ? { completedOperations: event.completedOperations } : {})
          });
          return true;
        case 'usage': {
          const usage = publicUsage(event);
          this.applyUsageToRun(this.resolveRun(event), usage);
          this.publishEvent(event, { ...usage, usage });
          return true;
        }
        case 'error': {
          const msg = text(event.message) || text(event.error && event.error.message);
          if (!event.runId) { this.showError(msg); return true; }
          const prevRunning = this.running;
          if (event.fatal !== false) this.running = false;
          this.publishEvent(event, {
            message: msg,
            ...(event.code ? { code: text(event.code) } : {}),
            fatal: event.fatal !== false
          });
          if (prevRunning !== this.running) this.onStateChange();
          return true;
        }
        case 'run_end': {
          const prevRunning = this.running, prevContinue = this.canContinue;
          this.running = false;
          const run = this.resolveRun(event);
          const status = text(event.status) || 'finished';
          const reason = text(event.reason);
          const stopped = /^(stopped|cancelled|canceled|aborted)$/.test(status);
          const more = event.canContinue === true || /max.?turn|limit|needs_continue|paused|budget/.test((status + ' ' + reason).toLowerCase());
          this.canContinue = !!more;
          const usage = publicUsage(event);
          if (run) {
            run.finished = true;
            run.status = status;
            run.reason = reason || null;
            run.activeMessageId = null;
            for (const tool of run.tools) {
              if (tool.state === 'running') {
                tool.state = stopped ? 'stopped' : 'failed';
                tool.summary = stopped ? '已停止' : '未完成';
              }
            }
            for (const step of run.plan) {
              if (step.status === 'running') step.status = 'pending';
            }
            this.applyUsageToRun(run, usage);
          }
          this.publishEvent(event, { status, reason, canContinue: this.canContinue, ...usage, usage });
          if (prevRunning !== this.running || prevContinue !== this.canContinue) this.onStateChange();
          return true;
        }
        default:
          return false;
      }
    }

    resolveRun(event) {
      if (event && event.runId) return this.ensureRun(event);
      if (this.activeRunId && this.runMap.has(this.activeRunId)) return this.runMap.get(this.activeRunId);
      return this.runs.length ? this.runs[this.runs.length - 1] : null;
    }

    ensureRun(event) {
      if (!event || !event.runId) return null;
      let run = this.runMap.get(event.runId);
      if (!run) {
        run = {
          id: event.runId,
          runId: event.runId,
          external: event.external === true,
          clientName: event.external === true ? (text(event.clientName) || 'MCP') : null,
          finished: false,
          status: 'active',
          reason: null,
          label: text(event.label) || '',
          thinkingText: '',
          plan: [],
          tools: [],
          lastDiagnosticCode: null,
          requests: 0,
          tokens: null,
          activeMessageId: null,
          messageSeq: 0,
          toolSeq: 0
        };
        this.runMap.set(event.runId, run);
        this.runs.push(run);
        this.activeRunId = run.id;
      }
      return run;
    }

    applyUsageToRun(run, usage) {
      if (!run || !usage) return;
      const reqs = Number.isSafeInteger(usage.requests) ? usage.requests : (Number.isSafeInteger(usage.turns) ? usage.turns : null);
      if (reqs !== null) run.requests = Math.max(0, reqs);
      const total = Number.isSafeInteger(usage.totalTokens) ? usage.totalTokens
        : (Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) ? usage.inputTokens + usage.outputTokens : null);
      if (total !== null) run.tokens = Math.max(0, total);
    }

    appendMessage(runId, messageId, role, delta, renderedHtml, createdAt) {
      const id = text(messageId);
      if (!id) return null;
      const key = (runId || '') + '/' + id;
      let message = this.messages.find(m => m.key === key);
      if (!message) {
        message = {
          key,
          id,
          messageId: id,
          runId: runId || null,
          role: role || 'assistant',
          text: '',
          renderedHtml: typeof renderedHtml === 'string' ? renderedHtml : null,
          createdAt: Number.isFinite(createdAt) ? createdAt : null
        };
        this.messages.push(message);
      }
      if (delta) message.text += delta;
      if (typeof renderedHtml === 'string') message.renderedHtml = renderedHtml;
      return message;
    }

    setConfig(publicConfigValue) {
      // Public fields only; sessionToken / apiKey never stored here.
      const caps = sanitizeCapabilities(publicConfigValue && publicConfigValue.generationCapabilities);
      this.config = {
        configured: !!(publicConfigValue && publicConfigValue.configured),
        provider: text(publicConfigValue && publicConfigValue.provider, 'openai-compatible'),
        model: text(publicConfigValue && publicConfigValue.model),
        baseUrl: text(publicConfigValue && publicConfigValue.baseUrl),
        generation: sanitizeGeneration(publicConfigValue && publicConfigValue.generation),
        ...(caps ? { generationCapabilities: caps } : {}),
        ...(text(publicConfigValue && publicConfigValue.notice) ? { notice: text(publicConfigValue.notice) } : {})
      };
      this.publish({ type: 'config', config: this.config });
    }

    snapshot() {
      return {
        messages: this.messages.map(m => ({
          id: m.messageId,
          messageId: m.messageId,
          ...(m.runId ? { runId: m.runId } : {}),
          role: m.role,
          text: m.text,
          ...(m.renderedHtml ? { renderedHtml: m.renderedHtml } : {}),
          ...(Number.isFinite(m.createdAt) ? { createdAt: m.createdAt } : {})
        })),
        runs: this.runs.map(r => ({
          id: r.id,
          runId: r.id,
          external: !!r.external,
          ...(r.clientName ? { clientName: r.clientName } : {}),
          finished: !!r.finished,
          ...(r.status ? { status: r.status } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
          label: r.label || '',
          thinkingText: r.thinkingText || '',
          plan: r.plan.slice(),
          tools: r.tools.map(t => ({
            id: t.id,
            ...(t.name ? { name: t.name } : {}),
            label: t.label,
            state: t.state,
            summary: t.summary || '',
            changes: t.changes.slice(),
            ...(t.diagnostic ? { diagnostic: t.diagnostic } : {})
          })),
          ...(r.lastDiagnosticCode ? { lastDiagnosticCode: r.lastDiagnosticCode } : {}),
          requests: r.requests || 0,
          ...(Number.isSafeInteger(r.tokens) ? { tokens: r.tokens } : {})
        })),
        config: this.config,
        status: this.status,
        error: this.error && this.error.message || null,
        running: this.running,
        canContinue: this.canContinue,
        settingsVisible: this.settingsVisible,
        checkpoint: this.checkpoint,
        transport: this.transport
      };
    }

    publishSnapshot(reset) {
      this.rendererRevision += 1;
      this.options.publish && this.options.publish({
        rendererRevision: this.rendererRevision,
        resetGeneration: this.resetGeneration,
        mode: 'snapshot',
        snapshot: this.snapshot(),
        ...(reset ? { reset: true } : {})
      });
    }

    publishEvent(event, extra) {
      this.rendererRevision += 1;
      this.options.publish && this.options.publish({
        rendererRevision: this.rendererRevision,
        resetGeneration: this.resetGeneration,
        mode: 'event',
        event: { type: text(event.type || event.event), ...(event.runId ? { runId: event.runId } : {}), ...extra }
      });
    }

    publish(payload) {
      this.rendererRevision += 1;
      this.options.publish && this.options.publish({
        rendererRevision: this.rendererRevision,
        resetGeneration: this.resetGeneration,
        mode: 'event',
        event: payload
      });
    }
  }

  function publicUsage(event) {
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : {};
    const out = {};
    for (const key of ['requests', 'turns', 'totalTokens', 'inputTokens', 'outputTokens', 'httpRequests', 'transportRetries']) {
      if (Number.isSafeInteger(event[key])) out[key] = event[key];
    }
    for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'input', 'cacheRead', 'output', 'reasoning']) {
      if (Number.isSafeInteger(usage[key])) out[key] = usage[key];
    }
    return out;
  }

  root.MolStudioAgentNativeRenderer = NativeAgentRenderer;
  if (typeof module === 'object' && module.exports) module.exports = NativeAgentRenderer;
})(typeof window === 'object' ? window : globalThis);
