'use strict';

// Node-side acceptance deadline. Independent review is explicitly idle time;
// retain the remaining active budget and the native window/history while idle.
function createActiveDeadline(limitMs, onExpire, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let remainingMs = limitMs, activeSince = null, pausedSince = null, reviewWaitMs = 0;
  let timer = null, expired = false, cancelled = false;
  const remaining = () => Math.max(0, remainingMs - (activeSince === null ? 0 : Math.max(0, now() - activeSince)));
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const consume = () => { remainingMs = remaining(); activeSince = null; };
  const expire = () => {
    if (cancelled || expired || activeSince === null) return;
    consume();
    if (remainingMs > 0) { activeSince = now(); timer = setTimer(expire, remainingMs); return; }
    expired = true; timer = null; onExpire();
  };
  const resume = () => {
    if (cancelled || expired) return false;
    if (activeSince !== null) return true;
    if (pausedSince !== null) { reviewWaitMs += Math.max(0, now() - pausedSince); pausedSince = null; }
    activeSince = now();
    if (remainingMs <= 0) { expire(); return false; }
    timer = setTimer(expire, remainingMs); return true;
  };
  const pause = () => {
    if (cancelled || expired || activeSince === null) return;
    consume(); clear();
    if (remainingMs <= 0) { activeSince = now(); expire(); return; }
    pausedSince = now();
  };
  const cancel = () => {
    if (activeSince !== null) consume();
    if (pausedSince !== null) { reviewWaitMs += Math.max(0, now() - pausedSince); pausedSince = null; }
    clear(); cancelled = true;
  };
  const snapshot = () => ({ limitMs, remainingMs: remaining(), activeElapsedMs: limitMs - remaining(),
    reviewWaitMs: reviewWaitMs + (pausedSince === null ? 0 : Math.max(0, now() - pausedSince)),
    state: expired ? 'expired' : cancelled ? 'cancelled' : activeSince === null ? 'awaiting_independent_review' : 'active' });
  resume();
  return { pause, resume, cancel, snapshot };
}

function modelRequestMetrics(rawBody, body) {
  const size = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const roles = {};
  for (const message of messages) {
    const role = ['system', 'developer', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'other';
    const entry = roles[role] ||= { count: 0, bytes: 0 };
    entry.count++; entry.bytes += size(message);
  }
  let canvas, fullCanvasSnapshots = 0;
  for (const message of messages) {
    const texts = typeof message.content === 'string' ? [message.content] :
      Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text) : [];
    for (const text of texts) {
      const marker = '\n\nCurrent canvas context (JSON):\n';
      let value;
      try { value = JSON.parse(message.role === 'system' && text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text); }
      catch { continue; }
      const snapshot = Array.isArray(value?.atoms) ? value : Array.isArray(value?.canvas?.atoms) ? value.canvas : null;
      if (snapshot) fullCanvasSnapshots++;
      if (message.role === 'system' && snapshot) canvas = {
        revision: Number.isInteger(snapshot.revision) ? snapshot.revision : null,
        atoms: snapshot.atoms.length, bonds: Array.isArray(snapshot.bonds) ? snapshot.bonds.length : null,
        steps: Array.isArray(snapshot.reactionSteps) ? snapshot.reactionSteps.length : null,
        activeAliasOperations: Array.isArray(snapshot.activeOperationAliases) ? snapshot.activeOperationAliases.length : 0,
        hasResumeAliases: !!snapshot.resumeAliases,
      };
    }
  }
  return { requestBytes: size(rawBody), messages: messages.length, messageBytes: size(messages), roles,
    fullCanvasSnapshots, ...(canvas && { canvas }) };
}

// These standalone functions are also serialized into the acceptance renderer.
// The probe observes transport only; it must not create an error when the model
// parser cancels a response after consuming its terminal event.
function observeModelResponse(response, request, emit, now) {
  if (!response.body) { request.finishedAt = now(); return response; }
  const reader = response.body.getReader();
  // This function is serialized into the browser, so keep the observer local.
  // Only complete SSE events are considered; neither data nor messages are saved.
  const metadata = request.sse = { done: false, finishReasons: [], errorEvent: false };
  const counts = request.sseCounts = { events: 0, contentBytes: 0, reasoningBytes: 0, toolArgumentBytes: 0, toolCalls: 0, oversizedEvents: 0 };
  const encoder = new TextEncoder(), calls = new Set();
  const decoder = new TextDecoder(), limit = 65536;
  const finishReasons = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
  const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
  let line = '', lineTooLong = false, eventData = '', eventType = '', eventTooLong = false, afterCR = false;
  function consumeLine() {
    if (!lineTooLong && line === '') {
      if (eventData || eventType || eventTooLong) counts.events++;
      if (eventTooLong) counts.oversizedEvents++;
      if (!eventTooLong) {
        if (eventData === '[DONE]') metadata.done = true;
        else if (eventData) {
          try {
            const data = JSON.parse(eventData);
            for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
              const reason = choice?.finish_reason;
              if (finishReasons.has(reason) && !metadata.finishReasons.includes(reason)) metadata.finishReasons.push(reason);
              const delta = choice?.delta;
              if (typeof delta?.content === 'string') counts.contentBytes += encoder.encode(delta.content).byteLength;
              for (const key of ['reasoning_content', 'reasoning', 'thinking']) if (typeof delta?.[key] === 'string') counts.reasoningBytes += encoder.encode(delta[key]).byteLength;
              for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
                if (Number.isInteger(call?.index) && call.index >= 0) calls.add((Number.isInteger(choice.index) ? choice.index : 0) + ':' + call.index);
                if (typeof call?.function?.arguments === 'string') counts.toolArgumentBytes += encoder.encode(call.function.arguments).byteLength;
              }
              counts.toolCalls = calls.size;
            }
            const error = data?.error;
            if (eventType === 'error' || error != null) {
              metadata.errorEvent = true;
              const type = identifier(error?.type ?? (eventType === 'error' ? data?.type : undefined));
              const code = identifier(error?.code ?? (eventType === 'error' ? data?.code : undefined));
              if (type) metadata.errorType = type;
              if (code) metadata.errorCode = code;
            }
          } catch (_) { if (eventType === 'error') metadata.errorEvent = true; }
        } else if (eventType === 'error') metadata.errorEvent = true;
      } else if (eventType === 'error') metadata.errorEvent = true;
      eventData = ''; eventType = ''; eventTooLong = false;
    } else if (lineTooLong) eventTooLong = true;
    else if (!eventTooLong) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventType = value === 'error' ? 'error' : '';
      if (field === 'data') {
        if (eventData.length + value.length + 1 > limit) { eventData = ''; eventTooLong = true; }
        else eventData += (eventData ? '\n' : '') + value;
      }
    }
    line = ''; lineTooLong = false;
  }
  function observe(value) {
    const text = decoder.decode(value, { stream: true });
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      if (afterCR) { afterCR = false; if (char === 10) { start = i + 1; continue; } }
      if (char !== 10 && char !== 13) continue;
      if (!lineTooLong && line.length + i - start <= limit) line += text.slice(start, i);
      else { line = ''; lineTooLong = true; }
      consumeLine(); afterCR = char === 13; start = i + 1;
    }
    if (!lineTooLong && line.length + text.length - start <= limit) line += text.slice(start);
    else { line = ''; lineTooLong = true; }
  }
  return new Response(new ReadableStream({
    async pull(controller) {
      let next; const readStarted = Date.now();
      try { next = await reader.read(); }
      catch (error) {
        if (request.cancelled) return;
        request.errorCode = error?.name || 'stream_error';
        request.errorPhase = 'read'; request.transportError = true;
        request.errorAt = now(); request.finishedAt = request.errorAt; controller.error(error); emit(); return;
      }
      if (request.cancelled) return;
      request.maxReadWaitMs = Math.max(request.maxReadWaitMs || 0, Date.now() - readStarted);
      if (next.done) { request.bodyEOF = true; request.finishedAt = now(); controller.close(); }
      else { request.bytes += next.value.byteLength; request.chunks++; request.lastChunkAt = now();
        request.firstChunkAt ||= request.lastChunkAt;
        try { observe(next.value); } catch (_) { /* Diagnostic parsing never alters transport. */ }
        controller.enqueue(next.value); }
      emit();
    },
    async cancel(reason) {
      request.cancelled = true; request.cancelledAfterSSETerminal = metadata.done || metadata.finishReasons.length > 0;
      request.finishedAt = now(); emit();
      await reader.cancel(reason);
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}

function enforceModelRequestBudget(requests, budget, now, runId = null) {
  if (requests.length < budget.limit) return;
  const at = now();
  budget.exhausted = true; budget.deniedAttempts = (budget.deniedAttempts || 0) + 1;
  budget.firstDeniedAt ||= at; budget.lastDeniedAt = at; budget.sentRequests = requests.length;
  (budget.denials ||= []).push({ id: 'request-budget-' + budget.deniedAttempts, sequence: budget.deniedAttempts,
    runId, at, nextRequestNumber: requests.length + 1, limit: budget.limit });
  throw Object.assign(new Error('Long-route request budget reached; no upstream call sent'), { code: 'test_request_limit' });
}

function assessModelRequestBudget(audit) {
  const budget = audit?.requestBudget, denials = (audit?.events || []).filter(event => event.type === 'request_budget_exhausted' && event.code === 'test_request_limit');
  return { exhausted: !!(budget?.exhausted && budget.deniedAttempts > 0 || denials.length),
    limit: budget?.limit ?? denials[0]?.limit ?? null,
    sentRequests: budget?.sentRequests ?? audit?.requests?.length ?? 0,
    deniedAttempts: Math.max(budget?.deniedAttempts || 0, denials.length),
    firstDeniedAt: budget?.firstDeniedAt ?? denials[0]?.at ?? null };
}

function zeroOutputStopDecision(audit, limitMs, nowMs) {
  if (!Number.isFinite(limitMs) || limitMs <= 0 || audit?.runStatus !== 'running') return null;
  const request = audit.requests?.findLast(item => !item.finishedAt && !item.cancelled);
  if (!request || request.responseStatus >= 400 || request.transportError || request.errorCode || request.sse?.errorEvent ||
      request.sse?.done || request.sse?.finishReasons?.length) return null;
  const counts = request.sseCounts || {};
  if (counts.contentBytes || counts.toolArgumentBytes || counts.toolCalls || counts.oversizedEvents) return null;
  const started = Date.parse(request.startedAt), elapsedMs = nowMs - started;
  if (!Number.isFinite(started) || elapsedMs < limitMs) return null;
  return { request: request.number, runId: request.runId, trigger: 'zero_output_test_budget', limitMs,
    elapsedMs, receivedBytes: request.bytes || 0, reasoningBytes: counts.reasoningBytes || 0 };
}

function assessModelTransport(audit) {
  const reasons = [], denials = [...(audit?.requestBudget?.denials || []), ...(audit?.events || [])
    .filter(event => event.type === 'request_budget_exhausted' && event.code === 'test_request_limit')
    .map(event => ({ id: event.denialId, runId: event.runId }))];
  for (const event of audit?.events || []) {
    const code = event.type === 'error' ? event.code : event.type === 'run_end' ? event.reason : null;
    // The product can wrap the harness's local request-limit rejection as a
    // model/transport error. Only an observed denial (never just reaching the
    // numeric cap) explains a wrapper explicitly linked to that denial/run.
    // Unrelated or earlier runtime errors and HTTP/fetch/read evidence remain.
    const localBudgetRejection = event.localCause === 'test_request_limit' && event.budgetDenialId &&
      denials.some(denial => denial.id === event.budgetDenialId && denial.runId === event.runId);
    if (['transport_interrupted', 'upstream_stream_error', 'model_failed'].includes(code) && !localBudgetRejection) reasons.push({ source: 'runtime', code });
  }
  for (const request of audit?.requests || []) {
    if (request.responseStatus >= 400) reasons.push({ source: 'http', request: request.number, status: request.responseStatus });
    if (request.sse?.errorEvent && ['upstream_stream_error', 'stream_interrupted'].includes(request.sse.errorCode)) {
      reasons.push({ source: 'sse', request: request.number, code: request.sse.errorCode });
    }
    // A failed fetch/read remains evidence even if cleanup subsequently cancels
    // the stream. A legacy cancellation-only error without that evidence does not.
    const cancellation = request.intentionalCancellation;
    const errorAt = Date.parse(request.errorAt), cancelledAt = Date.parse(cancellation?.at);
    const intentionalAbort = request.errorCode === 'AbortError' && ['fetch', 'read'].includes(request.errorPhase) &&
      cancellation?.reason === 'task_refinement' && /^task-refinement-\d+$/.test(cancellation.id || '') &&
      cancellation.runId === request.runId && Number.isFinite(errorAt) && Number.isFinite(cancelledAt) && errorAt >= cancelledAt;
    if ((request.transportError || request.errorCode && !request.cancelled) && !intentionalAbort) reasons.push({ source: 'request',
      request: request.number, phase: request.errorPhase || 'unknown', code: request.errorCode || 'transport_error' });
  }
  return { failed: reasons.length > 0, reasons };
}

function safeRuntimeErrorMessage(code, message) {
  // Only local validation messages are copied. Model/provider failures use fixed
  // text so an upstream error body can never become a saved provider payload.
  if (!['MECHANISM_INCOMPLETE', 'OUTPUT_TRUNCATED', 'EMPTY_RESPONSE'].includes(code)) {
    return code === 'test_request_limit' ? '验收请求预算已耗尽；本次尝试未发送至上游。'
      : code === 'upstream_stream_error' ? '上游连接中断，已完成内容保留，可继续执行。'
      : code === 'transport_interrupted' ? '模型连接中断，已完成内容保留。'
      : code === 'model_failed' ? '模型请求失败，provider 详细内容未记录。' : '运行时错误，详细内容未记录。';
  }
  if (typeof message !== 'string') return undefined;
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._~+\/-]+/gi, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1000);
}

module.exports = { observeModelResponse, enforceModelRequestBudget, assessModelRequestBudget, assessModelTransport, safeRuntimeErrorMessage, zeroOutputStopDecision, modelRequestMetrics, createActiveDeadline };
