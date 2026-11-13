/* MolStudio agent conversation panel. Plain DOM; transport and credentials belong to app.js/server. */
(function (root) {
  'use strict';
  const PREF_KEY = 'molstudio.agent.panel.v1';
  const MAX_WIDTH = 560;
  const MIN_WIDTH = 300;
  let nextPanel = 0;

  const drawingPhases = new Map([
    ['decode', '读取绘图指令'], ['validate', '校验绘图指令'], ['prepare', '准备结构'],
    ['layout', '排布对象'], ['apply', '写入画布'],
  ]);
  const drawingErrors = new Map([
    ['wrong_arrow_type', '这项操作只支持电子流弯箭头'],
    ['missing_reference', '引用的对象不在当前画布上'],
    ['arrow_pi_unavailable', '所引用的键没有可用的 π 电子，请核对实际键级'],
    ['arrow_endpoint_invalid', '电子流端点引用无效，请核对当前对象'],
    ['arrow_endpoints_overlap', '电子流的起点与终点重合'],
    ['operation_conflict', '已执行的指令不能用同一个编号修改'],
    ['step_version_conflict', '反应步骤版本已变化，请读取当前版本后修改'],
    ['reaction_reagent_layout_failed', '试剂排布失败，本批次已撤回'],
    ['reaction_curve_readability_failed', '电子流弯箭头尚不清晰，本批次已撤回'],
    ['completion_check_failed', '绘图已提交，完成核对尚未通过'],
    ['invalid_tool_arguments', '绘图参数未通过校验'],
    ['structure_failed', '分子结构未能解析'],
    ['smiles_syntax', 'SMILES 语法有误'],
    ['smiles_valence', 'SMILES 中有原子价态不合法'],
    ['smiles_sanitization', '分子结构未通过化学检查'],
    ['partial_atom_mapping', 'SMILES 原子映射不完整'],
    ['duplicate_atom_mapping', 'SMILES 原子映射重复'],
    ['duplicate_two_electron_target', '重复或多余的双电子箭头'],
    ['duplicate_lone_pair_donation', '同一孤对电子被重复使用'],
    ['proton_transfer_sigma_to_base', '质子转移的弯箭头方向有误'],
    ['proton_transfer_sigma_wrong_target', '质子转移的键电子应回到供体原子'],
    ['isolated_hydride_dithionite_source', '连二亚硫酸盐步骤缺少合理的电子来源'],
    ['layout_failed', '无法整理这些对象'],
    ['reaction_arrow_gap', '反应物和产物之间缺少直箭头空间'],
    ['step_unsealed', '这一步尚未封口，可以继续补齐'],
    ['stale_canvas', '画布版本已更新，请从当前内容继续'],
    ['viewport_full', '可见画布空间不足'],
  ]);
  const runEndMessages = new Map([
    ['user', '已停止（手动），已完成内容保留'],
    ['canvas_changed', '画布有新编辑，已暂停，可从当前内容继续'],
    ['canvas_stale', '画布版本已更新，已暂停，可从当前内容继续'],
    ['manual_edit', '画布已手动编辑，已暂停，可从当前内容继续'],
    ['document_changed', '已切换文档，绘图已停止'],
    ['interrupted', '执行中断，已完成内容保留'],
    ['transport_interrupted', '模型连接中断，已完成内容保留，可继续执行'],
    ['upstream_stream_error', '上游连接中断，已完成内容保留，可继续执行'],
    ['model_failed', '模型请求失败，已完成内容保留，可继续执行'],
    ['no_progress', '连续尝试未推进，已暂停，可从当前内容继续'],
    ['mechanism_incomplete', '机理尚未画完整，可从当前内容继续'],
    ['drawing_failed', '有绘图操作未完成，可从当前内容继续'],
    ['viewport_full', '可见画布空间不足，调整视图后继续'],
    ['provider_length', '模型响应截断，可从当前进度继续'],
    ['external_cancel', '外部请求已取消，已完成内容保留'],
  ]);

  function text(value, fallback) { return typeof value === 'string' ? value : (fallback || ''); }
  function publicDiagnostic(value) {
    const compact = root.MolStudioAgentRuntime?.compactToolDiagnostic;
    if (typeof compact === 'function') return compact(value);
    // An older/missing runtime bundle may not expose the shared helper yet.
    // Keep a conservative public subset rather than dumping an exception.
    const out = {};
    for (const key of ['code', 'phase', 'errorName', 'operationType', 'operationId', 'field', 'stepId']) {
      if (typeof value?.[key] === 'string' && /^[A-Za-z0-9_.:[\]-]{1,160}$/.test(value[key]) && !/^sk[-_]/i.test(value[key])) out[key] = value[key];
    }
    for (const key of ['operationIndex', 'atomIndex', 'atomMap', 'expectedVersion', 'actualVersion', 'currentVersion']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) out[key] = value[key];
    return out;
  }
  function failureText(value, fallback) {
    let message = text(value).trim();
    if (!message || /json parse|unable to parse json/i.test(message)) return fallback;
    const compact = root.MolStudioAgentRuntime?.compactFailureText;
    if (typeof compact === 'function') message = compact(message);
    else message = message.split(/\n\s*Received arguments\s*:/i)[0].replace(/Bearer\s+\S+|\bsk[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
    if (message.startsWith('{')) {
      try { const detail = publicDiagnostic(JSON.parse(message)); message = text(detail.reason) || drawingErrors.get(detail.code) || fallback; }
      catch { return fallback; }
    }
    message = message.replace(/^(?:Invalid arguments|Validation failed) for tool "[^\"]+":\s*/i, '').replace(/\s+/g, ' ').trim();
    if (!message || /[{}]/.test(message)) return fallback;
    return message.length > 320 ? message.slice(0, 319) + '…' : message;
  }
  function finite(value) { return Number.isFinite(value) ? value : null; }
  function icon(doc, name) {
    const paths = {
      sparkle: ['M10 2l2.1 5.9L18 10l-5.9 2.1L10 18l-2.1-5.9L2 10l5.9-2.1z', 'M17 2v4M15 4h4'],
      settings: ['M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6', 'M8 2h4l.6 2 1.5.9 2-.5 2 3.4-1.5 1.5v1.7l1.5 1.5-2 3.4-2-.5-1.5.9-.6 2H8l-.6-2-1.5-.9-2 .5-2-3.4 1.5-1.5V9.3L1.9 7.8l2-3.4 2 .5L7.4 4z'],
      close: ['M5 5l10 10M15 5L5 15'],
      send: ['M10 16V4M5 9l5-5 5 5'],
      stop: ['M5 5h10v10H5z'],
      reset: ['M4 9a6 6 0 1 1 1 5M4 4v5h5'],
      chevron: ['M8 5l5 5-5 5']
    };
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.45');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of paths[name] || paths.sparkle) {
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); svg.appendChild(path);
    }
    return svg;
  }

  class MolStudioAgentPanel {
    constructor(options) {
      this.options = options || {};
      this.doc = this.options.document || root.document;
      if (!this.doc) throw new Error('Agent panel requires a document');
      this.win = this.doc.defaultView || root;
      this.container = this.options.container || this.doc.body;
      this.id = 'mol-agent-panel-' + (++nextPanel);
      this.running = false;
      this.open = false;
      this.disposed = false;
      this.composing = false;
      this._imeEnter = false;
      this._serial = 0;
      this._sendGeneration = 0;
      this._stopRequested = false;
      this._runs = new Map();
      this._ignoredRuns = new Set();
      this._messages = new Map();
      this._currentRun = null;
      this._settingsBusy = false;
      this._settingsGeneration = 0;
      this._following = true;
      this._config = { configured: false, provider: 'openai-compatible', model: '', baseUrl: '', generation: { profile: 'provider-default', effort: 'default', maxOutputTokens: null } };
      this._listeners = [];
      const prefs = this._readPrefs();
      this._preferredWidth = prefs.width;
      this._build();
      this.mount(this.container);
      this._bind();
      this._layout();
      this.setOpen(typeof this.options.open === 'boolean' ? this.options.open : prefs.open, { notify: false });
      this.win.queueMicrotask ? this.win.queueMicrotask(() => { if (!this.disposed) this._notifyLayout(); }) : Promise.resolve().then(() => { if (!this.disposed) this._notifyLayout(); });
    }

    _el(tag, className, value) {
      const node = this.doc.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    }
    _button(label, className, iconName) {
      const button = this._el('button', 'mol-agent-button ' + (className || ''));
      button.type = 'button'; button.setAttribute('aria-label', label); button.title = label;
      if (iconName) button.appendChild(icon(this.doc, iconName));
      return button;
    }
    _listen(target, name, fn, options) {
      target.addEventListener(name, fn, options);
      this._listeners.push(() => target.removeEventListener(name, fn, options));
    }
    _readPrefs() {
      try {
        const old = JSON.parse(this.win.localStorage.getItem(PREF_KEY) || '{}');
        const width = finite(old.width) === null ? finite(old.panelWidth) : old.width;
        return { open: old.open === true || (old.open === undefined && old.isOpen === true), width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width === null ? 360 : width)) };
      } catch (_) { return { open: false, width: 360 }; }
    }
    _savePrefs() {
      try { this.win.localStorage.setItem(PREF_KEY, JSON.stringify({ version: 1, open: this.open, width: this._preferredWidth })); } catch (_) { /* View preferences are optional. */ }
    }

    _build() {
      const d = this.doc;
      this.element = this._el('aside', 'mol-agent-panel');
      this.element.id = this.id;
      this.element.tabIndex = -1;
      this.element.setAttribute('aria-label', 'AI 助手');
      this.element.dataset.agentPanel = 'true';
      this.resizeHandle = this._el('div', 'mol-agent-resize');
      this.resizeHandle.setAttribute('role', 'separator');
      this.resizeHandle.setAttribute('aria-label', '调整 AI 助手宽度');
      this.resizeHandle.setAttribute('aria-orientation', 'vertical');
      this.resizeHandle.tabIndex = 0;
      const header = this._el('header', 'mol-agent-header');
      const heading = this._el('div', 'mol-agent-heading');
      heading.append(icon(d, 'sparkle'), this._el('strong', '', 'AI 助手'));
      this.modelLabel = this._el('span', 'mol-agent-model', '设置模型');
      heading.appendChild(this.modelLabel);
      const actions = this._el('div', 'mol-agent-header-actions');
      this.resetButton = this._button('新对话', 'mol-agent-icon', 'reset');
      this.settingsButton = this._button('模型设置', 'mol-agent-icon', 'settings');
      this.closeButton = this._button('收起 AI 助手', 'mol-agent-icon', 'close');
      actions.append(this.resetButton, this.settingsButton, this.closeButton);
      header.append(heading, actions);

      this.errorBox = this._el('div', 'mol-agent-error');
      this.errorBox.hidden = true; this.errorBox.setAttribute('role', 'alert');
      this.errorText = this._el('span');
      this.dismissErrorButton = this._button('关闭提示', 'mol-agent-icon', 'close');
      this.errorBox.append(this.errorText, this.dismissErrorButton);
      this.configNotice = this._el('div', 'mol-agent-config-notice');
      this.configNotice.append(this._el('span', '', '配置模型后即可开始。'));
      this.configureButton = this._button('打开模型设置', 'mol-agent-link');
      this.configureButton.textContent = '打开设置'; this.configNotice.appendChild(this.configureButton);

      this.chat = this._el('div', 'mol-agent-chat');
      this.chat.setAttribute('role', 'log'); this.chat.setAttribute('aria-label', '与 AI 助手的对话'); this.chat.setAttribute('aria-live', 'off');
      this.empty = this._el('div', 'mol-agent-empty');
      this.empty.append(this._el('strong', '', '一起画，或先聊想法'), this._el('p', '', '可以讨论机理、制定计划，也可以直接让我在画布上操作。'));
      this.chat.appendChild(this.empty);
      this.newMessagesButton = this._button('滚动到最新消息', 'mol-agent-new-messages');
      this.newMessagesButton.textContent = '查看新消息 ↓'; this.newMessagesButton.hidden = true;
      this.footer = this._el('div', 'mol-agent-footer');
      this.status = this._el('div', 'mol-agent-status', '就绪');
      this.status.setAttribute('aria-live', 'polite');
      this.usage = this._el('span', 'mol-agent-usage');
      this.elapsed = this._el('span', 'mol-agent-elapsed'); this.elapsed.hidden = true;
      const statusRow = this._el('div', 'mol-agent-status-row'); statusRow.append(this.status, this.elapsed, this.usage);
      this.transportProgress = this._el('div', 'mol-agent-transport-progress'); this.transportProgress.hidden = true;
      this.taskProgress = this._el('div', 'mol-agent-task-progress'); this.taskProgress.hidden = true;
      this.taskProgress.setAttribute('aria-live', 'polite');
      this.continueButton = this._button('继续执行', 'mol-agent-continue');
      this.continueButton.textContent = '继续执行'; this.continueButton.hidden = true;
      this.input = this._el('textarea', 'mol-agent-input');
      this.input.rows = 3; this.input.placeholder = '描述想法，或让我修改当前画布…';
      this.input.setAttribute('aria-label', '发送给 AI 助手的消息');
      this.input.setAttribute('spellcheck', 'false');
      const composer = this._el('div', 'mol-agent-compose');
      composer.appendChild(this.input);
      const composerActions = this._el('div', 'mol-agent-compose-actions');
      this.inputHint = this._el('span', 'mol-agent-input-hint', 'Enter 发送 · Shift+Enter 换行');
      this.sendButton = this._button('发送消息', 'mol-agent-send', 'send');
      this.sendButton.appendChild(this._el('span', '', '发送'));
      this.stopButton = this._button('停止当前任务', 'mol-agent-stop', 'stop');
      this.stopButton.appendChild(this._el('span', '', '停止')); this.stopButton.hidden = true;
      composerActions.append(this.inputHint, this.sendButton, this.stopButton);
      composer.appendChild(composerActions);
      this.footer.append(statusRow, this.taskProgress, this.transportProgress, this.continueButton, composer);

      this.settingsView = this._el('section', 'mol-agent-settings'); this.settingsView.hidden = true;
      this.settingsView.setAttribute('aria-label', '模型设置');
      this._buildSettings();
      this.element.append(this.resizeHandle, header, this.errorBox, this.configNotice, this.chat, this.newMessagesButton, this.footer, this.settingsView);

      this.toggleButton = this._button('展开 AI 助手', 'mol-agent-toggle', 'sparkle');
      this.toggleButton.appendChild(this._el('span', '', 'AI'));
      this.toggleButton.setAttribute('aria-controls', this.id);
    }

    _buildSettings() {
      this.settingsBack = this._button('返回对话', 'mol-agent-settings-back'); this.settingsBack.textContent = '← 返回对话';
      const title = this._el('h2', '', '模型设置');
      this.settingsForm = this._el('form', 'mol-agent-settings-form');
      this.settingsForm.autocomplete = 'off';
      const field = (label, name, type, placeholder) => {
        const wrap = this._el('label', 'mol-agent-field');
        wrap.appendChild(this._el('span', '', label));
        const input = this._el('input'); input.name = name; input.type = type || 'text';
        if (placeholder) input.placeholder = placeholder;
        input.autocomplete = 'off'; input.spellcheck = false;
        wrap.appendChild(input); return { wrap, input };
      };
      const provider = this._el('p', 'mol-agent-settings-note', '支持 OpenAI 兼容接口。密钥只保存到本机服务。');
      const model = field('模型', 'model', 'text', '服务提供商的模型名称');
      this.modelInput = model.input; this.modelInput.required = true; this.modelInput.maxLength = 200;
      const base = field('接口地址', 'baseUrl', 'url', 'https://api.example.com/v1');
      this.baseUrlInput = base.input; this.baseUrlInput.required = true;
      const key = field('API 密钥', 'apiKey', 'password', '输入 API 密钥');
      this.apiKeyInput = key.input;
      const keyHelp = this._el('span', 'mol-agent-field-help', '留空保留已保存的密钥。保存后不会显示密钥。');
      key.wrap.appendChild(keyHelp);
      const select = (label, name, entries) => {
        const wrap = this._el('label', 'mol-agent-field'); wrap.appendChild(this._el('span', '', label));
        const input = this._el('select'); input.name = name;
        for (const [value, title] of entries) { const option = this._el('option', '', title); option.value = value; input.appendChild(option); }
        wrap.appendChild(input); return { wrap, input };
      };
      const profile = select('思考参数格式', 'generationProfile', [['provider-default', '服务默认（不发送思考参数）'], ['deepseek', 'DeepSeek 兼容'], ['openai', 'OpenAI（按模型核实档位）']]);
      this.generationProfileInput = profile.input;
      this.generationHelp = this._el('span', 'mol-agent-field-help'); profile.wrap.appendChild(this.generationHelp);
      const effort = select('思考强度', 'generationEffort', [['default', '服务默认']]); this.generationEffortInput = effort.input;
      const cap = field('每次请求总输出上限（tokens，可选）', 'maxOutputTokens', 'number', '留空使用服务默认');
      this.maxOutputTokensInput = cap.input; this.maxOutputTokensInput.min = '1'; this.maxOutputTokensInput.step = '1';
      cap.wrap.appendChild(this._el('span', 'mol-agent-field-help', '总输出包含服务计入的思考与回答 token，不是独立思考预算，也不保证响应秒数。过低可能截断绘图指令。'));
      this.settingsSaveButton = this._button('保存模型设置', 'mol-agent-send'); this.settingsSaveButton.type = 'submit'; this.settingsSaveButton.textContent = '保存设置';
      this.settingsStatus = this._el('p', 'mol-agent-settings-status'); this.settingsStatus.setAttribute('aria-live', 'polite');
      this.settingsForm.append(provider, model.wrap, base.wrap, key.wrap, profile.wrap, effort.wrap, cap.wrap, this.settingsSaveButton, this.settingsStatus);
      this.settingsView.append(this.settingsBack, title, this.settingsForm);
      this._refreshGenerationControls();
    }

    mount(container) {
      if (this.disposed) return this;
      this.container = container || this.doc.body;
      this.container.append(this.element, this.toggleButton);
      return this;
    }
    _bind() {
      this._listen(this.toggleButton, 'click', () => this.toggle());
      this._listen(this.closeButton, 'click', () => this.setOpen(false));
      this._listen(this.sendButton, 'click', () => this._send());
      this._listen(this.stopButton, 'click', () => this._stop());
      this._listen(this.continueButton, 'click', () => this._continue());
      this._listen(this.resetButton, 'click', () => this._reset());
      this._listen(this.settingsButton, 'click', () => this.showSettings());
      this._listen(this.configureButton, 'click', () => this.showSettings());
      this._listen(this.settingsBack, 'click', () => this.showSettings(false));
      this._listen(this.settingsForm, 'submit', event => { event.preventDefault(); this._saveSettings(); });
      this._listen(this.generationProfileInput, 'change', () => this._refreshGenerationControls());
      this._listen(this.modelInput, 'input', () => this._refreshGenerationControls());
      this._listen(this.dismissErrorButton, 'click', () => { this.errorBox.hidden = true; });
      this._listen(this.input, 'input', () => this._updateButtons());
      this._listen(this.input, 'compositionstart', () => { this.composing = true; this._imeEnter = true; });
      this._listen(this.input, 'compositionend', () => {
        this.composing = false; this._imeEnter = true;
        this.win.clearTimeout(this._imeTimer);
        this._imeTimer = this.win.setTimeout(() => { this._imeEnter = false; }, 0);
      });
      this._listen(this.input, 'keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        if (event.isComposing || this.composing || this._imeEnter || event.keyCode === 229) return;
        event.preventDefault(); this._send();
      });
      this._listen(this.chat, 'scroll', () => {
        this._following = this._nearBottom();
        if (this._following) this.newMessagesButton.hidden = true;
      });
      this._listen(this.newMessagesButton, 'click', () => this._scrollBottom());
      this._listen(this.element, 'pointerdown', event => {
        if (!event.target.closest('input,textarea,select,button,a,summary,[role="separator"]')) this.element.focus({ preventScroll: true });
      });
      for (const name of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste', 'beforeinput', 'wheel']) {
        this._listen(this.element, name, event => {
          event.stopPropagation();
          if (name === 'keydown' && event.key === 'Escape' && !event.isComposing && !this.composing) {
            event.preventDefault();
            if (!this.settingsView.hidden) this.showSettings(false);
            else this.setOpen(false);
          }
        });
      }
      this._listen(this.win, 'resize', () => { this._layout(); this._notifyLayout(); });
      this._listen(this.resizeHandle, 'pointerdown', event => this._startResize(event));
      this._listen(this.resizeHandle, 'keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Home') this._preferredWidth = MIN_WIDTH;
        else if (event.key === 'End') this._preferredWidth = MAX_WIDTH;
        else this._preferredWidth += event.key === 'ArrowLeft' ? 20 : -20;
        this._preferredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this._preferredWidth));
        this._layout(); this._savePrefs(); this._notifyLayout();
      });
      this._updateButtons();
    }

    _layout() {
      const viewport = this.win.innerWidth || 1360;
      this.drawer = viewport <= 900;
      this.width = this.drawer ? Math.min(this._preferredWidth, viewport) : Math.min(this._preferredWidth, Math.max(MIN_WIDTH, viewport - 520));
      this.doc.documentElement.style.setProperty('--mol-agent-panel-width', this.width + 'px');
      this.element.style.width = this.width + 'px';
      this.element.classList.toggle('is-drawer', this.drawer);
      this.resizeHandle.setAttribute('aria-valuemin', String(MIN_WIDTH));
      this.resizeHandle.setAttribute('aria-valuemax', String(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewport - 520))));
      this.resizeHandle.setAttribute('aria-valuenow', String(this.width));
    }
    getLayout() { return { open: this.open, width: this.width, drawer: this.drawer }; }
    _notifyLayout() {
      if (typeof this.options.onToggle === 'function') this.options.onToggle(this.open, this.getLayout());
    }
    setOpen(open, options) {
      if (this.disposed) return;
      const hadFocus = this.ownsFocus();
      this.open = !!open;
      this.element.hidden = !this.open;
      this.toggleButton.hidden = this.open;
      this.toggleButton.setAttribute('aria-expanded', String(this.open));
      this.doc.body.classList.toggle('mol-agent-open', this.open);
      this._layout(); this._savePrefs();
      if (this.open && this._following) this._scrollBottom();
      if (!this.open && hadFocus) this.toggleButton.focus({ preventScroll: true });
      if (!options || options.notify !== false) this._notifyLayout();
    }
    toggle() { this.setOpen(!this.open); }
    ownsFocus() {
      const active = this.doc.activeElement;
      if (this.element && this.element.contains(active)) return true;
      if (active && active.tagName === 'IFRAME') return false;
      const selection = this.win.getSelection && this.win.getSelection();
      return !!(selection && !selection.isCollapsed && this.element && this.element.contains(selection.anchorNode));
    }
    _startResize(event) {
      if (this.drawer || event.button !== 0) return;
      event.preventDefault();
      const initial = this.width, startX = event.clientX;
      this.doc.body.classList.add('mol-agent-is-resizing');
      const move = e => {
        this._preferredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, initial + startX - e.clientX));
        this._layout(); this._notifyLayout();
      };
      const end = () => {
        this.doc.removeEventListener('pointermove', move);
        this.doc.removeEventListener('pointerup', end);
        this.doc.removeEventListener('pointercancel', end);
        this.win.removeEventListener('blur', end);
        this.doc.body.classList.remove('mol-agent-is-resizing');
        this._resizeCleanup = null; this._savePrefs();
      };
      this._resizeCleanup && this._resizeCleanup();
      this._resizeCleanup = end;
      this.doc.addEventListener('pointermove', move);
      this.doc.addEventListener('pointerup', end, { once: true });
      this.doc.addEventListener('pointercancel', end, { once: true });
      this.win.addEventListener('blur', end, { once: true });
    }

    _nearBottom() { return this.chat.scrollHeight - this.chat.clientHeight - this.chat.scrollTop <= 48; }
    _scrollBottom() {
      this.chat.scrollTop = this.chat.scrollHeight;
      this._following = true; this.newMessagesButton.hidden = true;
    }
    _chatUpdate(fn, force) {
      const following = force || this._nearBottom();
      fn(); this.empty.hidden = true;
      if (following) this._scrollBottom();
      else { this._following = false; this.newMessagesButton.hidden = false; }
    }
    _setStatus(value) { if (this.status.textContent !== value) this.status.textContent = value; }
    _updateButtons() {
      this.sendButton.disabled = this.running || !this.input.value.trim();
      this.stopButton.hidden = !this.running;
      this.stopButton.disabled = this._stopRequested;
      this.sendButton.hidden = this.running;
      this.resetButton.disabled = this.running;
      this.settingsSaveButton.disabled = this.running || this._settingsBusy;
      for (const input of [this.modelInput, this.baseUrlInput, this.apiKeyInput, this.generationProfileInput, this.maxOutputTokensInput]) input.disabled = this.running || this._settingsBusy;
      this.generationEffortInput.disabled = this.running || this._settingsBusy || this.generationEffortInput.options.length < 2;
      this.input.setAttribute('aria-busy', String(this.running));
    }
    setRunning(running) {
      this.running = !!running;
      if (!this.running) this._stopRequested = false;
      if (this.running) this.continueButton.hidden = true;
      this._updateButtons();
    }
    showError(message) {
      this.errorText.textContent = failureText(message, '操作失败，请重试。');
      this.errorBox.hidden = false;
    }

    async _send() {
      if (this.running || this.composing || this.disposed) return;
      const value = this.input.value.trim();
      if (!value) return;
      this.errorBox.hidden = true;
      this._chatUpdate(() => {
        const entry = this._el('div', 'mol-agent-message mol-agent-user-message');
        entry.append(this._el('span', 'mol-agent-role', '你'), this._el('div', 'mol-agent-message-text', value));
        this.chat.appendChild(entry);
      }, true);
      this.input.value = ''; this._currentRun = null;
      const generation = ++this._sendGeneration;
      this.setRunning(true); this._setStatus('正在开始…');
      try {
        if (typeof this.options.onSend !== 'function') throw new Error('助手尚未连接，请稍后重试。');
        const accepted = await this.options.onSend(value);
        if (this.disposed || generation !== this._sendGeneration) return;
        if (accepted === false) { this.setRunning(false); this._setStatus('尚未开始'); }
      } catch (error) {
        if (this.disposed || generation !== this._sendGeneration) return;
        this.setRunning(false); this._setStatus('未能开始'); this.showError(error && error.message);
      }
    }
    async _stop() {
      if (!this.running || this._stopRequested) return;
      this._stopRequested = true; this._updateButtons(); this._setStatus('正在停止，已完成内容将保留…');
      try {
        if (typeof this.options.onStop !== 'function') throw new Error('无法发送停止请求');
        await this.options.onStop();
      } catch (error) { this._stopRequested = false; this._updateButtons(); this.showError(error && error.message); }
    }
    async _continue() {
      if (this.running || typeof this.options.onContinue !== 'function') return;
      const generation = ++this._sendGeneration;
      this.setRunning(true); this._setStatus('正在继续…');
      try {
        const accepted = await this.options.onContinue();
        if (this.disposed || generation !== this._sendGeneration) return;
        if (accepted === false) { this.setRunning(false); this._setStatus('尚未继续'); }
      } catch (error) {
        if (this.disposed || generation !== this._sendGeneration) return;
        this.setRunning(false); this.showError(error && error.message);
      }
    }
    async _reset() {
      if (this.running) return;
      try {
        if (typeof this.options.onReset === 'function' && await this.options.onReset() === false) return;
        this.clear(); this.input.focus();
      } catch (error) { this.showError(error && error.message); }
    }
    clear() {
      this._sendGeneration++;
      for (const id of this._runs.keys()) this._ignoredRuns.add(id);
      for (const message of this._messages.values()) this.win.clearTimeout(message.renderTimer);
      for (const run of this._runs.values()) this._releaseThinking(run);
      this._runs.clear(); this._messages.clear(); this._currentRun = null;
      this.chat.replaceChildren(this.empty); this.empty.hidden = false;
      this.newMessagesButton.hidden = true; this.errorBox.hidden = true; this.continueButton.hidden = true;
      this.usage.textContent = ''; this._following = true;
      this.elapsed.textContent = ''; this.elapsed.hidden = true; this.transportProgress.textContent = ''; this.transportProgress.hidden = true;
      this.taskProgress.textContent = ''; this.taskProgress.hidden = true;
      this.setRunning(false); this._setStatus('就绪');
    }

    _startRun(event) {
      const id = text(event.runId || event.id) || 'local-run-' + (++this._serial);
      if (this._ignoredRuns.has(id)) return null;
      if (this._runs.has(id)) return this._currentRun && this._currentRun.id === id && !this._currentRun.finished ? this._currentRun : null;
      this.errorBox.hidden = true;
      const section = this._el('section', 'mol-agent-turn');
      const external = !!event.external;
      const clientName = text(event.clientName) || 'MCP';
      section.setAttribute('aria-label', external ? '外部助手操作' : 'AI 助手回复');
      if (external) {
        section.classList.add('is-external');
        section.appendChild(this._el('div', 'mol-agent-external-badge', '外部协同 · ' + clientName));
      }
      const run = { id, node: section, external, clientName, activeMessage: null, activeTool: null, tools: new Map(), plan: null, finished: false, requests: 0, tokens: null };
      this._runs.set(id, run); this._currentRun = run;
      this._chatUpdate(() => this.chat.appendChild(section));
      this.setRunning(true);
      this._setStatus(external ? '外部助手正在操作画布…' : (event.recoveryAttempt ? '正在从断点续跑（' + event.recoveryAttempt + '/2）' : '正在处理…'));
      this.usage.textContent = '';
      if (external) {
        this.elapsed.textContent = ''; this.elapsed.hidden = true;
        this.transportProgress.textContent = ''; this.transportProgress.hidden = true;
      } else {
        this._showProgress(run, { elapsedMs: 0, receivedBytes: 0, phase: 'processing' });
      }
      return run;
    }
    _showProgress(run, event) {
      const bytes = Math.max(0, finite(event.receivedBytes) || 0), seconds = Math.max(0, Math.floor((finite(event.elapsedMs) || 0) / 1000));
      const size = bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      let state = event.final ? '接收已结束' : event.phase === 'receiving' ? '持续接收中' : event.phase === 'waiting_first_byte' ? '等待本次首批数据'
        : event.phase === 'waiting' ? '等待新数据' : bytes ? '正在处理已接收内容' : '正在准备模型请求';
      if (event.phase === 'waiting' && finite(event.lastByteAgoMs) !== null) state += '（' + Math.floor(event.lastByteAgoMs / 1000) + '秒无新数据）';
      this.elapsed.textContent = '· 累计 ' + seconds + '秒'; this.elapsed.hidden = false;
      this.elapsed.title = '当前这段执行的累计耗时，可能包含多次模型请求；自动续跑会重新计时';
      this.transportProgress.textContent = (bytes ? '已接收 ' + size : event.final ? '未收到模型数据' : '尚未收到模型数据') + ' · ' + state;
      this.transportProgress.hidden = false;
      run.progress = { ...event, receivedBytes: bytes, elapsedMs: seconds * 1000 };
    }
    _appendModelThinking(run, delta) {
      if (!delta) return;
      if (!run.thinking) {
        const node = this._el('details', 'mol-agent-thinking');
        node.appendChild(this._el('summary', '', '查看原始思考'));
        const body = this._el('pre', 'mol-agent-thinking-text');
        const content = this.doc.createTextNode(''); body.appendChild(content); node.appendChild(body);
        const toggle = () => { if (node.open) this._flushThinking(run); };
        run.thinking = { node, content, pending: [], timer: null, toggle };
        node.addEventListener('toggle', toggle); this._chatUpdate(() => run.node.appendChild(node));
      }
      run.thinking.pending.push(delta);
      if (run.thinking.node.open && run.thinking.timer === null) run.thinking.timer = this.win.setTimeout(() => this._flushThinking(run), 100);
    }
    _flushThinking(run) {
      const thinking = run.thinking;
      if (!thinking) return;
      this.win.clearTimeout(thinking.timer); thinking.timer = null;
      if (thinking.node.open && thinking.pending.length) { thinking.content.appendData(thinking.pending.join('')); thinking.pending.length = 0; }
    }
    _releaseThinking(run) {
      if (!run.thinking) return;
      this.win.clearTimeout(run.thinking.timer); run.thinking.node.removeEventListener('toggle', run.thinking.toggle);
      run.thinking.pending.length = 0; run.thinking.content.data = ''; run.thinking = null;
    }
    _getRun(event) {
      if (event.runId && this._ignoredRuns.has(event.runId)) return null;
      if (event.runId && this._currentRun && event.runId !== this._currentRun.id) return null;
      if (!this._currentRun) {
        if (!this.running) return null;
        return this._startRun({ runId: event.runId });
      }
      if (this._currentRun.finished) return null;
      return this._currentRun;
    }
    _assistant(run, messageId) {
      const id = text(messageId) || run.activeMessage || ('assistant-' + (++this._serial));
      const key = run.id + ':' + id;
      let message = this._messages.get(key);
      if (!message) {
        const node = this._el('div', 'mol-agent-message mol-agent-assistant-message');
        const body = this._el('div', 'mol-agent-message-text');
        const content = this.doc.createTextNode(''); body.appendChild(content);
        node.append(this._el('span', 'mol-agent-role', 'AI 助手'), body);
        this._chatUpdate(() => run.node.appendChild(node));
        message = { body, content, source: '', renderedLength: 0, renderTimer: null }; this._messages.set(key, message);
      }
      run.activeMessage = id;
      return message;
    }
    _renderAssistant(message) {
      if (!message) return;
      this.win.clearTimeout(message.renderTimer);
      message.renderTimer = null;
      const render = this.win.MolStudioAgentRuntime?.renderMessage;
      if (this.disposed || !render || message.renderedLength === message.source.length) return;
      let html;
      try { html = render(message.source); } catch (_) { return; }
      this._chatUpdate(() => {
        message.body.innerHTML = html;
        message.body.classList.add('mol-agent-markdown');
        message.content = this.doc.createTextNode('');
        message.body.appendChild(message.content);
        message.renderedLength = message.source.length;
      });
    }
    _flushAssistant(run, messageId) {
      const id = text(messageId) || run.activeMessage;
      if (id) this._renderAssistant(this._messages.get(run.id + ':' + id));
    }
    _toolLabel(name) {
      const value = text(name).toLowerCase();
      if (/arrow|electron/.test(value)) return '绘制电子箭头';
      if (/molecule|structure/.test(value)) return '处理分子结构';
      if (/selection|scene|read|inspect/.test(value)) return '读取画布';
      if (/draw|operation/.test(value)) return '更新画布';
      if (/complete_phase/.test(value)) return '核对阶段';
      if (/complete_layout/.test(value)) return '核对排版';
      if (/plan/.test(value)) return '更新计划';
      return '执行操作';
    }
    _renderToolChanges(tool, changes) {
      if (!Array.isArray(changes)) return;
      if (!changes.length) {
        if (tool.changesList) {
          tool.changesList.replaceChildren();
          tool.changesList.hidden = true;
        }
        return;
      }
      if (!tool.changesList) {
        tool.changesList = this._el('ul', 'mol-agent-tool-changes');
        if (tool.diagnosticDetails) tool.detail.insertBefore(tool.changesList, tool.diagnosticDetails);
        else tool.detail.appendChild(tool.changesList);
      }
      tool.changesList.replaceChildren();
      for (const item of changes) {
        const line = typeof item === 'string' ? item : text(item?.text || item?.label || item?.summary);
        if (!line) continue;
        const kind = line.startsWith('+ ') ? 'is-add' : (line.startsWith('- ') ? 'is-delete' : (/^(✎|⇄) /.test(line) ? 'is-edit' : ''));
        tool.changesList.appendChild(this._el('li', kind, line));
      }
      tool.changesList.hidden = tool.changesList.childElementCount === 0;
    }
    _tool(run, event) {
      const id = text(event.toolCallId || event.id) || (event.type !== 'tool_start' && run.activeTool) || 'tool-' + (++this._serial);
      let tool = run.tools.get(id);
      if (!tool) {
        const node = this._el('div', 'mol-agent-tool');
        const mark = this._el('span', 'mol-agent-tool-mark', '○');
        const detail = this._el('div', 'mol-agent-tool-detail');
        const label = this._el('strong', '', text(event.label) || this._toolLabel(event.name || event.toolName));
        const summary = this._el('span', 'mol-agent-tool-summary');
        detail.append(label, summary); node.append(mark, detail);
        tool = { id, node, mark, label, summary, detail, changesList: null, state: 'running' };
        if (Array.isArray(event.changes)) this._renderToolChanges(tool, event.changes);
        this._chatUpdate(() => run.node.appendChild(node));
        run.tools.set(id, tool);
      } else if (Array.isArray(event.changes)) {
        this._chatUpdate(() => this._renderToolChanges(tool, event.changes));
      }
      run.activeTool = id;
      return tool;
    }
    _showPlan(run, steps) {
      if (!Array.isArray(steps)) return;
      if (!run.plan) {
        run.plan = this._el('div', 'mol-agent-plan');
        this._chatUpdate(() => run.node.appendChild(run.plan));
      }
      this._chatUpdate(() => {
        run.plan.replaceChildren(); run.plan.hidden = steps.length === 0;
        run.plan.appendChild(this._el('strong', 'mol-agent-plan-title', '计划'));
        const list = this._el('ol');
        for (const step of steps) {
          const label = typeof step === 'string' ? step : text(step && (step.text || step.label));
          if (!label) continue;
          const status = typeof step === 'object' && step ? text(step.status) : '';
          const done = /^(done|complete|completed)$/.test(status) || (step && step.done === true);
          const active = /^(running|in_progress|executing)$/.test(status);
          const failed = /^(failed|error)$/.test(status);
          const li = this._el('li', done ? 'is-complete' : active ? 'is-active' : failed ? 'is-failed' : '');
          li.append(this._el('span', 'mol-agent-plan-mark', done ? '✓' : active ? '●' : failed ? '!' : '○'), this._el('span', '', label));
          list.appendChild(li);
        }
        run.plan.appendChild(list);
      });
    }
    _showUsage(run, event) {
      const usage = event.usage && typeof event.usage === 'object' ? event.usage : event;
      const requests = finite(event.requests) !== null ? event.requests : finite(event.turns);
      if (requests !== null) run.requests = Math.max(0, Math.floor(requests));
      const total = finite(usage.totalTokens) !== null ? usage.totalTokens : (finite(usage.inputTokens) !== null && finite(usage.outputTokens) !== null ? usage.inputTokens + usage.outputTokens : null);
      if (total !== null) run.tokens = Math.max(0, Math.floor(total));
      const parts = [];
      if (run.requests) parts.push(run.requests + (finite(event.httpRequests) === null ? ' 次请求' : ' 轮'));
      if (run.tokens !== null) parts.push(run.tokens.toLocaleString() + ' tokens');
      this.usage.textContent = parts.join(' · ');
      if (finite(event.httpRequests) !== null) {
        const detail = [event.httpRequests + ' 次本机请求'];
        if (event.transportRetries) detail.push(event.transportRetries + ' 次重连');
        if (usage.input) detail.push('未缓存输入 ' + usage.input.toLocaleString());
        if (usage.cacheRead) detail.push('缓存读取 ' + usage.cacheRead.toLocaleString());
        if (usage.output) detail.push('输出 ' + usage.output.toLocaleString());
        if (usage.reasoning) detail.push('其中思考 ' + usage.reasoning.toLocaleString());
        this.usage.title = detail.join(' · ');
      } else this.usage.title = '';
    }

    handleEvent(event) {
      if (this.disposed || !event || typeof event !== 'object') return false;
      const type = text(event.type || event.event);
      if (type === 'run_start') return !!this._startRun(event);
      if (type === 'task_checkpoint') {
        if (event.runId && this._ignoredRuns.has(event.runId)) return false;
        this._showTaskCheckpoint(event.checkpoint); return true;
      }
      if (type === 'resume_available') {
        if (!this.running) {
          this.continueButton.hidden = typeof this.options.onContinue !== 'function';
          this._setStatus('已载入保存的任务，点击继续执行');
        }
        return true;
      }
      if (type === 'resume_unavailable') {
        this.continueButton.hidden = true;
        if (event.reason === 'document_changed') { this.taskProgress.textContent = ''; this.taskProgress.hidden = true; }
        if (!this.running && event.reason === 'document_changed') this._setStatus('已切换文档，上一个任务已结束');
        return true;
      }
      if (event.runId && this._ignoredRuns.has(event.runId)) return false;
      if (/^recovery_(scheduled|started|exhausted|cancelled)$/.test(type)) {
        // Recovery is coordinated after the interrupted run has finished.
        // A late event must not change a newer run or a cleared document.
        if (!this._currentRun || event.runId !== this._currentRun.id) return false;
        const attempts = Number.isSafeInteger(event.attempt) ? event.attempt : event.recoveryAttempts;
        const suffix = '（' + (Number.isSafeInteger(attempts) ? attempts : 0) + '/2）';
        if (type === 'recovery_scheduled' || type === 'recovery_started') {
          this.errorBox.hidden = true; this.continueButton.hidden = true; this.setRunning(true);
          const seconds = Math.max(0, Math.ceil((finite(event.delayMs) || 0) / 1000));
          this._setStatus(type === 'recovery_started' ? '正在从断点续跑' + suffix
            : '上游中断，' + seconds + '秒后从断点续跑' + suffix);
        } else {
          this.setRunning(false);
          this.continueButton.hidden = event.canContinue === false || typeof this.options.onContinue !== 'function';
          if (type === 'recovery_exhausted') {
            const message = '上游连续中断，自动续跑已达 2 次，已完成内容保留，可手动继续';
            this._setStatus(message); this.showError(message);
          } else {
            this._setStatus(event.reason === 'document_changed' ? '已切换文档，自动续跑已取消'
              : event.reason === 'reset' ? '自动续跑已取消'
                : event.reason === 'config_changed' ? '模型设置已变化，自动续跑已取消，可手动继续'
                  : event.reason === 'manual_edit' || event.reason === 'canvas_changed' ? '画布已编辑，自动续跑已取消，可从当前内容继续'
                    : '自动续跑已停止，已完成内容保留');
          }
        }
        return true;
      }
      const run = this._getRun(event);
      if (!run) {
        if (type === 'error' && !event.runId) { this.setRunning(false); this.showError(text(event.message) || text(event.error && event.error.message)); return true; }
        return false;
      }
      if (type === 'assistant_start') {
        this._flushAssistant(run);
        run.activeMessage = text(event.messageId) || 'assistant-' + (++this._serial);
        this._setStatus('正在回复…');
      } else if (type === 'assistant_end') {
        this._flushAssistant(run, event.messageId);
      } else if (type === 'text_delta') {
        if (/^(analysis|reasoning|thinking)$/.test(text(event.channel)) || event.hidden === true) { this._setStatus('正在思考…'); return true; }
        const delta = text(event.delta);
        if (delta) {
          const message = this._assistant(run, event.messageId);
          message.source += delta;
          this._chatUpdate(() => message.content.appendData(delta));
          // Show text immediately and reparse its markup at most once per interval.
          if (message.renderTimer === null && this.win.MolStudioAgentRuntime?.renderMessage) {
            message.renderTimer = this.win.setTimeout(() => this._renderAssistant(message), 80);
          }
          this._setStatus('正在回复…');
        }
      } else if (type === 'thinking') {
        this._setStatus(event.active === false ? '正在处理…' : '正在思考…');
      } else if (type === 'thinking_delta') {
        if (event.source === 'model') this._appendModelThinking(run, text(event.delta));
      } else if (type === 'transport_progress') {
        this._showProgress(run, event);
      } else if (type === 'tool_start' || type === 'tool_progress') {
        if (run.external && !this.running) this.setRunning(true);
        const tool = this._tool(run, event);
        if (tool.state !== 'running') return true;
        let summary = text(event.summary || event.message || event.progress);
        if (!summary && event.progress && typeof event.progress === 'object') {
          if (event.progress.phase === 'committed' && finite(event.progress.count) !== null) summary = '已完成 ' + Math.max(0, Math.floor(event.progress.count)) + ' 项绘图操作';
          else if (event.progress.phase === 'applying') summary = '正在绘制…';
        }
        this._chatUpdate(() => {
          tool.node.classList.add('is-running'); tool.mark.textContent = '●';
          if (summary) tool.summary.textContent = summary;
          if (Array.isArray(event.changes)) this._renderToolChanges(tool, event.changes);
        });
        this._setStatus(run.external ? '外部助手正在操作画布…' : (text(event.label) || tool.label.textContent));
      } else if (type === 'tool_end') {
        const tool = this._tool(run, event);
        const success = event.success !== false && event.isError !== true && !event.error && !/^(error|failed)$/.test(text(event.status));
        const message = text(event.summary || event.message) || text(event.error) || text(event.error?.message);
        const result = event.result?.result || event.result;
        const incomplete = success && !!(event.finishRejected || result?.finishRejected || event.diagnostic?.code === 'completion_check_failed');
        let source = event.diagnostic;
        if (!source && !success && message.trim().startsWith('{')) { try { source = JSON.parse(message); } catch { /* Ordinary error text is handled below. */ } }
        if (incomplete) source = { ...source, code: 'completion_check_failed', phase: source?.phase || 'validate',
          reason: source?.reason || event.finishRejected || result?.finishRejected,
          missingElectronFlowSteps: source?.missingElectronFlowSteps || result?.missingElectronFlowSteps,
          invalidReactionSteps: source?.invalidReactionSteps || result?.invalidReactionSteps };
        const diagnostic = (!success || incomplete) && source ? publicDiagnostic(source) : null;
        const phase = drawingPhases.get(diagnostic?.phase);
        const location = diagnostic && [
          Number.isInteger(diagnostic.operationIndex) ? '第 ' + (diagnostic.operationIndex + 1) + ' 项' : '',
          text(diagnostic.operationType), text(diagnostic.operationId), text(diagnostic.field),
          Number.isInteger(diagnostic.atomMap) ? '原子 :' + diagnostic.atomMap : '',
        ].filter(Boolean).join(' ');
        tool.state = incomplete ? 'incomplete' : success ? 'complete' : 'failed';
        this._chatUpdate(() => {
          tool.node.classList.remove('is-running'); tool.node.classList.toggle('is-complete', success && !incomplete); tool.node.classList.toggle('is-failed', !success);
          tool.node.classList.toggle('is-incomplete', incomplete); tool.mark.textContent = success && !incomplete ? '✓' : '!';
          if (Array.isArray(event.changes)) this._renderToolChanges(tool, event.changes);
          if (diagnostic) {
            const description = drawingErrors.get(diagnostic.code) || failureText(diagnostic.reason || message, phase ? phase + '失败' : '这次绘图未能应用');
            const reason = failureText(diagnostic.reason, '');
            tool.summary.textContent = [description, diagnostic.code, location, reason && reason !== description ? reason : ''].filter(Boolean).join(' · ');
            tool.summary.title = [phase, text(diagnostic.errorName), text(diagnostic.code)].filter(Boolean).join(' · ');
            if (!tool.diagnosticDetails) {
              tool.diagnosticDetails = this._el('details', 'mol-agent-tool-diagnostic');
              tool.diagnosticDetails.appendChild(this._el('summary', '', '查看诊断详情'));
              tool.diagnosticBody = this._el('pre'); tool.diagnosticDetails.appendChild(tool.diagnosticBody); tool.detail.appendChild(tool.diagnosticDetails);
            }
            tool.diagnosticBody.textContent = JSON.stringify(diagnostic, null, 2);
            tool.diagnosticDetails.hidden = false;
          } else {
            tool.summary.textContent = success ? (message || '已完成') : failureText(message,
              event.toolName === 'draw_operations' ? '这次绘图未能应用' : '操作未完成');
            if (tool.diagnosticDetails) tool.diagnosticDetails.hidden = true;
          }
          if (!success || incomplete) run.lastDiagnostic = { code: diagnostic?.code || '', summary: tool.summary.textContent };
        });
        this._setStatus(incomplete ? '绘图已提交，完成核对尚未通过' : success ? '操作已完成，继续处理…' : '操作未完成' + (diagnostic?.code ? ' · ' + diagnostic.code : ''));
      } else if (type === 'external_idle') {
        this._flushAssistant(run);
        this.setRunning(false);
        const failed = event.isError === true || event.ok === false || event.success === false;
        this._setStatus(failed ? ('外部操作未完成' + (event.error ? ' · ' + failureText(event.error, '') : ''))
          : event.taskCompleted ? '外部任务已完成' : '外部操作已应用');
      } else if (type === 'plan') {
        this._showPlan(run, event.steps);
      } else if (type === 'phase_start' || type === 'phase_end') {
        const index = Number.isInteger(event.phaseIndex) ? event.phaseIndex + 1 : null;
        const count = Number.isInteger(event.phaseCount) ? event.phaseCount : null;
        const label = index === null ? '当前阶段' : '阶段 ' + index + (count === null ? '' : '/' + count);
        const detail = text(type === 'phase_start' ? event.objective : event.summary).slice(0, 500);
        this.taskProgress.textContent = label + (type === 'phase_end' ? '已核对' : '') + (detail ? ' · ' + detail : '');
        this.taskProgress.hidden = false;
        this._setStatus(type === 'phase_start' ? '正在执行' + label : label + '已完成，继续处理…');
      } else if (type === 'generation_applied') {
        const requested = event.generation?.requested || event.requested;
        if (requested && typeof requested === 'object') {
          const labels = { default: '服务默认', none: '关闭思考', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
          const cap = Number.isInteger(requested.maxOutputTokens) ? ' · 总输出上限 ' + requested.maxOutputTokens : '';
          this.modelLabel.title = this._config.model + ' · 思考：' + (labels[requested.effort] || '服务默认') + cap;
        }
      } else if (type === 'step_commit') {
        const count = finite(event.completedOperations);
        this._setStatus(count === null ? '已提交一步，继续生成…' : '已提交 ' + count + ' 项绘图操作，继续生成…');
      } else if (type === 'usage') {
        this._showUsage(run, event);
      } else if (type === 'transport_retry') {
        this._setStatus('模型连接失败，正在重连…');
      } else if (type === 'error') {
        this.showError(text(event.message) || text(event.error && event.error.message));
        if (event.fatal !== false) { this.setRunning(false); this._setStatus('执行遇到问题，已完成内容保留'); }
      } else if (type === 'run_end') {
        this._flushAssistant(run);
        this._flushThinking(run);
        if (run.progress && !run.progress.final) this._showProgress(run, { ...run.progress, phase: 'ended', final: true });
        run.finished = true; this.setRunning(false); this._showUsage(run, event);
        const stopped = /^(stopped|cancelled|canceled|aborted)$/.test(text(event.status));
        const setup = event.status === 'setup_required';
        const failed = /^(failed|error)$/.test(text(event.status)) || setup;
        const more = event.canContinue === true || /max.?turn|limit|needs_continue|paused|budget/.test((text(event.status) + ' ' + text(event.reason)).toLowerCase());
        this._chatUpdate(() => {
          for (const tool of run.tools.values()) {
            if (tool.state !== 'running') continue;
            tool.state = stopped ? 'stopped' : 'failed';
            tool.node.classList.remove('is-running'); tool.node.classList.add(stopped ? 'is-stopped' : 'is-failed');
            tool.mark.textContent = stopped ? '○' : '!'; tool.summary.textContent = stopped ? '已停止' : '未完成';
          }
          if (run.plan) for (const step of run.plan.querySelectorAll('.is-active')) { step.classList.remove('is-active'); step.querySelector('.mol-agent-plan-mark').textContent = '○'; }
        });
        const reasonMessage = runEndMessages.get(event.reason);
        this._setStatus((reasonMessage || (setup ? '请先配置模型'
          : stopped ? '已停止，已完成内容保留'
            : failed ? '执行结束，部分操作未完成'
              : more ? '可从当前进度继续' : '已完成')) + (event.reason === 'no_progress' && run.lastDiagnostic?.code ? ' · 最近错误：' + run.lastDiagnostic.code : ''));
        this.continueButton.hidden = !more || typeof this.options.onContinue !== 'function';
      } else return false;
      return true;
    }

    _showTaskCheckpoint(checkpoint) {
      if (!checkpoint || typeof checkpoint !== 'object') { this.taskProgress.textContent = ''; this.taskProgress.hidden = true; return; }
      const phases = Array.isArray(checkpoint.phases) ? checkpoint.phases : [];
      const complete = phases.filter(phase => phase?.status === 'completed').length;
      const phase = phases[checkpoint.phaseIndex];
      const parts = [text(checkpoint.goal).slice(0, 240)];
      if (phases.length) parts.push('阶段 ' + complete + '/' + phases.length + ' 已完成');
      if (phase && checkpoint.status !== 'completed') parts.push(text(phase.objective).slice(0, 240));
      if (checkpoint.status === 'completed') parts.push('任务已完成');
      this.taskProgress.textContent = parts.filter(Boolean).join(' · '); this.taskProgress.hidden = !this.taskProgress.textContent;
    }

    _refreshGenerationControls(preferredEffort) {
      const profile = this.generationProfileInput.value || 'provider-default';
      const previous = preferredEffort || this.generationEffortInput.value;
      const caps = this._config.generationCapabilities;
      const model = this.modelInput.value.trim().replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const listed = profile === 'openai' ? caps?.openaiModels?.[model] : caps?.profiles?.[profile]?.efforts;
      const safeEfforts = new Set(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
      const efforts = ['default', ...(profile === 'deepseek' ? ['none', 'low', 'high', 'max'] : Array.isArray(listed) ? listed.filter(value => value !== 'default' && safeEfforts.has(value)) : [])];
      const labels = { default: '服务默认', none: '关闭思考', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
      this.generationEffortInput.replaceChildren();
      for (const value of efforts) { const option = this._el('option', '', labels[value]); option.value = value; this.generationEffortInput.appendChild(option); }
      this.generationEffortInput.value = efforts.includes(previous) ? previous : 'default';
      this.maxOutputTokensInput.max = String(profile === 'deepseek' ? 393216 : 2000000);
      this.generationHelp.textContent = profile === 'provider-default'
        ? '不发送思考开关或强度，实际模式由服务（含本机反代）决定。'
        : profile === 'deepseek' ? '仅在服务支持 DeepSeek 参数时选择。关闭、低、高、最高分别发送 none、low、high、max；反代或远端可能另有限制。'
          : efforts.length < 2 ? '此模型尚无已核实的思考档位，仅可使用服务默认。' : '只显示当前模型已核实的思考档位；服务默认不发送强度。';
      this._updateButtons();
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') return;
      for (const key of ['provider', 'model', 'baseUrl']) if (typeof config[key] === 'string') this._config[key] = config[key];
      if (typeof config.configured === 'boolean') this._config.configured = config.configured;
      if (config.generation && typeof config.generation === 'object') {
        const value = config.generation;
        this._config.generation = { profile: ['provider-default', 'deepseek', 'openai'].includes(value.profile) ? value.profile : 'provider-default',
          effort: ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort) ? value.effort : 'default',
          maxOutputTokens: Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 ? value.maxOutputTokens : null };
      }
      if (config.generationCapabilities && typeof config.generationCapabilities === 'object') {
        const caps = config.generationCapabilities;
        const openaiModels = {};
        for (const [model, efforts] of Object.entries(caps.openaiModels || {})) if (Array.isArray(efforts)) openaiModels[model] = efforts.filter(value => ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value));
        this._config.generationCapabilities = { openaiModels };
      }
      this.modelLabel.textContent = this._config.model || '设置模型'; this.modelLabel.title = this._config.model || '模型设置';
      this.configNotice.hidden = this._config.configured || !this.settingsView.hidden;
      this.modelInput.value = this._config.model;
      this.baseUrlInput.value = this._config.baseUrl;
      this.apiKeyInput.value = '';
      this.apiKeyInput.placeholder = this._config.configured ? '已配置；留空保留原密钥' : '输入 API 密钥';
      this.generationProfileInput.value = this._config.generation.profile;
      this.maxOutputTokensInput.value = this._config.generation.maxOutputTokens === null ? '' : String(this._config.generation.maxOutputTokens);
      this._refreshGenerationControls(this._config.generation.effort);
    }
    async showSettings(show) {
      const visible = show !== false;
      this.settingsView.hidden = !visible; this.chat.hidden = visible; this.footer.hidden = visible;
      this.newMessagesButton.hidden = true; this.configNotice.hidden = visible || this._config.configured;
      this.settingsButton.setAttribute('aria-pressed', String(visible));
      const generation = ++this._settingsGeneration;
      this.apiKeyInput.value = '';
      if (!visible) { this.settingsButton.focus({ preventScroll: true }); return; }
      this.settingsStatus.textContent = '';
      if (typeof this.options.onSettingsLoad === 'function') {
        this.settingsStatus.textContent = '读取设置…';
        try {
          const config = await this.options.onSettingsLoad();
          if (this.disposed || generation !== this._settingsGeneration) return;
          this.setConfig(config && config.config ? config.config : config);
          this.settingsStatus.textContent = this.running ? '当前正在执行，结束后可保存设置。' : '';
        } catch (error) { if (!this.disposed && generation === this._settingsGeneration) this.settingsStatus.textContent = text(error && error.message, '无法读取设置，请重试。'); }
      }
      if (!this.disposed && !this.settingsView.hidden) this.modelInput.focus();
    }
    async _saveSettings() {
      if (this.running || this._settingsBusy || !this.settingsForm.checkValidity()) { if (!this.running) this.settingsForm.reportValidity(); return; }
      const values = { provider: 'openai-compatible', model: this.modelInput.value.trim(), baseUrl: this.baseUrlInput.value.trim(), apiKey: this.apiKeyInput.value.trim(),
        generation: { profile: this.generationProfileInput.value, effort: this.generationEffortInput.value,
          maxOutputTokens: this.maxOutputTokensInput.value.trim() ? Number(this.maxOutputTokensInput.value) : null } };
      const secret = values.apiKey;
      this.apiKeyInput.value = ''; this._settingsBusy = true; this._updateButtons(); this.settingsStatus.textContent = '正在保存…';
      try {
        if (typeof this.options.onSettingsSave !== 'function') throw new Error('设置保存尚未连接，请稍后重试。');
        const result = await this.options.onSettingsSave(values);
        if (this.disposed) return;
        if (result && typeof result === 'object') this.setConfig(result.config || result);
        this.settingsStatus.textContent = text(result && result.notice, '设置已保存。');
      } catch (error) {
        if (!this.disposed) {
          let message = text(error && error.message, '设置未保存，请重试。');
          if (secret) message = message.split(secret).join('••••');
          this.settingsStatus.textContent = message;
        }
      } finally { this._settingsBusy = false; if (!this.disposed) this._updateButtons(); }
    }

    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      this._sendGeneration++;
      this._settingsGeneration++;
      this.win.clearTimeout(this._imeTimer);
      for (const message of this._messages.values()) this.win.clearTimeout(message.renderTimer);
      for (const run of this._runs.values()) this._releaseThinking(run);
      if (this._resizeCleanup) this._resizeCleanup();
      for (const remove of this._listeners.splice(0)) remove();
      this.element.remove(); this.toggleButton.remove();
      this.doc.body.classList.remove('mol-agent-open', 'mol-agent-is-resizing');
      this.doc.documentElement.style.removeProperty('--mol-agent-panel-width');
    }
  }
  root.MolStudioAgentPanel = MolStudioAgentPanel;
  if (typeof module === 'object' && module.exports) module.exports = MolStudioAgentPanel;
})(typeof window === 'object' ? window : globalThis);
