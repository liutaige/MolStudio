/* 纸页内 3D 分子预览对象（纯逻辑模块，无 DOM 依赖，可被 node --test 直接加载）。
 *
 * 对象字段契约（document-model 校验照此实现）：
 * {
 *   kind: 'molecule3d',
 *   x, y, w, h: 有限数（默认 DEFAULT_W=16, DEFAULT_H=12）,
 *   rotation?: 有限数（默认 0）,
 *   band?: 'front' | 'back' | 'inline'（默认 'front'）,
 *   pageId?: string | null,
 *   molfile: string —— SDF（V2000）文本，1..262144 字符,
 *   style: 'ballstick' | 'stick' | 'line' | 'sphere',
 *   camera: { px, py, pz, distance, qx?, qy?, qz?, qw? } —— 全部有限数（NGL viewerControls 位置 + 相机距离）,
 *   notes: {
 *     stereoExample?: boolean,
 *     warnings?: string[]（≤8 条，每条 ≤400 字）,
 *     notes?: string[]（≤8 条，每条 ≤400 字）,
 *     geometryNote?: string（≤400 字）,
 *     sourceSummary?: string（≤400 字）
 *   },
 *   previewAsset?: string（assets 资源引用，接线时由调用方填）,
 *   updatedAt?: number
 * }
 *
 * NGL vendor（fusion/vendor/ngl.js，UMD 全局 NGL）证据：
 * - Stage.makeImage(params) → Promise<Blob>（PNG），见 vendor 内
 *   `makeImage(e={}){return new Promise(...this.viewer.makeImage(e)...)}`，
 *   viewer.makeImage 内部 canvas.toBlob(..., "image/png")。
 * - ViewerControls（class Mu，stage.viewerControls）：
 *   `get position(){return this.viewer.translationGroup.position}`（Vector3，可读 x/y/z），
 *   `getCameraDistance()` / `distance(e)`，
 *   `spin(axis, angle)`、`rotate(q)`、`center(e)`、`changed()`。
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});

  const KIND = 'molecule3d';
  const STYLES = ['ballstick', 'stick', 'line', 'sphere'];
  const BANDS = ['front', 'back', 'inline'];
  const DEFAULT_W = 16;
  const DEFAULT_H = 12;
  const MOLFILE_MAX = 262144;
  const NOTE_MAX_COUNT = 8;
  const NOTE_MAX_LEN = 400;

  function finite(v) { return typeof v === 'number' && isFinite(v); }

  function clampNotes(list) {
    if (!Array.isArray(list)) return undefined;
    return list
      .filter(s => typeof s === 'string' && s.length > 0)
      .map(s => s.length > NOTE_MAX_LEN ? s.slice(0, NOTE_MAX_LEN) : s)
      .slice(0, NOTE_MAX_COUNT);
  }

  /* ---------- molblock 规范化 ---------- */

  // 保留 MOL 三行头（空标题也是有效字段）；仅去行尾空白和尾部空行。
  function normalizeMolblock(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: 'molfile 不能为空' };
    }
    if (text.length > MOLFILE_MAX) {
      return { ok: false, error: `molfile 超长（${text.length} > ${MOLFILE_MAX} 字符）` };
    }
    const lines = text.split(/\r\n|\r|\n/)
      .map(line => line.replace(/[ \t]+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const molblock = lines.join('\n');
    if (!molblock) return { ok: false, error: 'molfile 不能为空' };
    if (molblock.length > MOLFILE_MAX) {
      return { ok: false, error: `molfile 超长（${molblock.length} > ${MOLFILE_MAX} 字符）` };
    }
    return { ok: true, molblock };
  }

  /* ---------- 对象创建与校验 ---------- */

  function createObject(input) {
    const src = input || {};
    const norm = normalizeMolblock(src.molblock || src.molfile || '');
    if (!norm.ok) throw new Error(norm.error);
    const style = STYLES.includes(src.style) ? src.style : 'ballstick';
    const obj = {
      kind: KIND,
      x: finite(src.x) ? src.x : 0,
      y: finite(src.y) ? src.y : 0,
      w: finite(src.w) ? src.w : DEFAULT_W,
      h: finite(src.h) ? src.h : DEFAULT_H,
      rotation: finite(src.rotation) ? src.rotation : 0,
      band: BANDS.includes(src.band) ? src.band : 'front',
      pageId: src.pageId !== undefined ? src.pageId : null,
      molfile: norm.molblock,
      style,
      camera: normalizeCamera(src.camera) || { px: 0, py: 0, pz: 0, distance: 40 },
      notes: normalizeNotes(src.notes),
      previewAsset: typeof src.previewAsset === 'string' ? src.previewAsset : '',
      updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : Date.now()
    };
    return obj;
  }

  // 只保留有限数并四舍五入到 1e-4；无效输入返回 null
  function normalizeCamera(cam) {
    if (!cam || typeof cam !== 'object') return null;
    const { px, py, pz, distance } = cam;
    if (![px, py, pz, distance].every(finite)) return null;
    const out = { px: round4(px), py: round4(py), pz: round4(pz), distance: round4(distance) };
    const keys = ['qx', 'qy', 'qz', 'qw'];
    if (keys.some(key => cam[key] !== undefined)) {
      if (!keys.every(key => finite(cam[key]))) return null;
      const length = Math.hypot(...keys.map(key => cam[key]));
      if (length < 1e-8) return null;
      for (const key of keys) out[key] = cam[key] / length;
    }
    return out;
  }

  function round4(v) { return Math.round(v * 10000) / 10000; }

  function normalizeNotes(src) {
    const notes = src && typeof src === 'object' ? src : {};
    const out = {};
    if (typeof notes.stereoExample === 'boolean') out.stereoExample = notes.stereoExample;
    const warnings = clampNotes(notes.warnings);
    if (warnings && warnings.length) out.warnings = warnings;
    const noteList = clampNotes(notes.notes);
    if (noteList && noteList.length) out.notes = noteList;
    if (typeof notes.geometryNote === 'string' && notes.geometryNote) {
      out.geometryNote = notes.geometryNote.slice(0, NOTE_MAX_LEN);
    }
    if (typeof notes.sourceSummary === 'string' && notes.sourceSummary) {
      out.sourceSummary = notes.sourceSummary.slice(0, NOTE_MAX_LEN);
    }
    return out;
  }

  function validateObject(obj) {
    const errors = [];
    const fail = msg => { if (errors.length < 50) errors.push(msg); };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: ['对象必须是普通对象'] };
    }
    if (obj.kind !== KIND) fail('对象类型必须是 molecule3d');
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!finite(obj[key])) fail(`${key} 必须是有限数`);
    }
    if (obj.w !== undefined && finite(obj.w) && obj.w <= 0) fail('w 必须大于 0');
    if (obj.h !== undefined && finite(obj.h) && obj.h <= 0) fail('h 必须大于 0');
    if (obj.rotation !== undefined && obj.rotation !== null && !finite(obj.rotation)) fail('rotation 必须是有限数');
    if (obj.band !== undefined && obj.band !== null && !BANDS.includes(obj.band)) fail('band 无效');
    if (obj.pageId !== undefined && obj.pageId !== null && (typeof obj.pageId !== 'string' || !obj.pageId)) fail('pageId 必须是非空字符串或 null');
    const norm = normalizeMolblock(obj.molfile);
    if (!norm.ok) fail(norm.error);
    if (!STYLES.includes(obj.style)) fail('样式必须是 ballstick / stick / line / sphere 之一');
    const cam = normalizeCamera(obj.camera);
    if (!cam) fail('camera 必须包含有限的 px/py/pz/distance');
    else if (finite(cam.distance) && cam.distance <= 0) fail('camera.distance 必须大于 0');
    const notes = obj.notes;
    if (notes === undefined || notes === null) {
      // 允许省略 notes（空说明）
    } else if (typeof notes !== 'object' || Array.isArray(notes)) {
      fail('notes 必须是对象');
    } else {
      for (const key of ['warnings', 'notes']) {
        if (notes[key] !== undefined) {
          if (!Array.isArray(notes[key])) fail(`notes.${key} 必须是数组`);
          else if (notes[key].length > NOTE_MAX_COUNT) fail(`notes.${key} 最多 ${NOTE_MAX_COUNT} 条`);
          else if (notes[key].some(s => typeof s !== 'string' || s.length === 0 || s.length > NOTE_MAX_LEN)) {
            fail(`notes.${key} 每条必须是非空字符串且不超过 ${NOTE_MAX_LEN} 字`);
          }
        }
      }
      for (const key of ['geometryNote', 'sourceSummary']) {
        if (notes[key] !== undefined && (typeof notes[key] !== 'string' || notes[key].length > NOTE_MAX_LEN)) {
          fail(`notes.${key} 必须是不超过 ${NOTE_MAX_LEN} 字的字符串`);
        }
      }
      if (notes.stereoExample !== undefined && typeof notes.stereoExample !== 'boolean') {
        fail('notes.stereoExample 必须是布尔值');
      }
    }
    if (obj.previewAsset !== undefined && obj.previewAsset !== null && obj.previewAsset !== '' &&
        (typeof obj.previewAsset !== 'string' || !obj.previewAsset)) {
      fail('previewAsset 必须是非空字符串');
    }
    if (obj.updatedAt !== undefined && !finite(obj.updatedAt)) fail('updatedAt 必须是数字');
    return { ok: errors.length === 0, errors };
  }

  /* ---------- 3D 生成服务 ---------- */

  // input: { ket, keys, identity?, allowExample? }
  // options: { base?, signal?, fetch? }（fetch 可注入便于单测）
  async function generate3D(input, options) {
    const opts = options || {};
    const base = typeof opts.base === 'string' ? opts.base : '';
    const doFetch = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    if (!doFetch) return { ok: false, code: 'no_fetch', message: '环境缺少 fetch' };
    try {
      const resp = await doFetch(`${base}/api/gen3d`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ket: input && input.ket,
          keys: input && input.keys,
          identity: input && input.identity,
          allowExample: input && input.allowExample
        }),
        signal: opts.signal
      });
      let data = null;
      try { data = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
      if (resp.status === 409 && data && data.code === 'stereo_choice_required') {
        // 立体构型需用户确认：原样透出供 UI 确认流程
        return {
          ok: false, code: 'stereo_choice_required',
          message: data.message || '需要确认立体构型',
          stereo: data.extra && data.extra.stereo ? data.extra.stereo : data.stereo
        };
      }
      if (!resp.ok || !data || data.ok !== true || typeof data.molblock !== 'string') {
        return {
          ok: false, code: `http_${resp.status}`,
          message: (data && (data.message || data.error)) || `请求失败（HTTP ${resp.status}）`
        };
      }
      return {
        ok: true,
        molblock: data.molblock,
        smiles: data.smiles,
        natoms: data.natoms,
        stereo: data.stereo,
        stereoVerified: data.stereoVerified,
        warnings: data.warnings || [],
        notes: data.notes || [],
        geometry: data.geometry,
        identity: data.identity
      };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, code: 'aborted', message: '请求已取消' };
      }
      return { ok: false, code: 'network_error', message: String((err && err.message) || err) };
    }
  }

  /* ---------- 相机 JSON（经 viewerControls 真实 API） ---------- */

  // stage: NGL.Stage；读 translationGroup.position（get position）与 getCameraDistance()
  function cameraJson(stage) {
    if (!stage || !stage.viewerControls) return null;
    try {
      const vc = stage.viewerControls;
      const pos = vc.position; // getter → viewer.translationGroup.position (Vector3)
      const dist = typeof vc.getCameraDistance === 'function'
        ? vc.getCameraDistance()
        : (vc.viewer && vc.viewer.cameraDistance);
      if (!pos || !finite(pos.x) || !finite(pos.y) || !finite(pos.z) || !finite(dist)) return null;
      const q = vc.rotation;
      return normalizeCamera({ px: pos.x, py: pos.y, pz: pos.z, distance: dist,
        ...(q ? { qx: q.x, qy: q.y, qz: q.z, qw: q.w } : {}) });
    } catch (e) {
      return null;
    }
  }

  function applyCameraJson(stage, camera) {
    const cam = normalizeCamera(camera);
    if (!stage || !stage.viewerControls || !cam || cam.distance <= 0) return false;
    try {
      const vc = stage.viewerControls;
      // position 是 getter（返回 translationGroup.position 的引用），直接原地写回
      if (cam.qw !== undefined && typeof vc.rotate === 'function') vc.rotate([cam.qx, cam.qy, cam.qz, cam.qw]);
      vc.position.set(cam.px, cam.py, cam.pz);
      if (typeof vc.distance === 'function') vc.distance(cam.distance);
      else { vc.viewer.cameraDistance = cam.distance; vc.viewer.updateZoom(); }
      if (typeof vc.changed === 'function') vc.changed();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- postMessage 协议（encode/decode 便于单测） ---------- */

  const EMBED_HOST_TYPE = 'k3d-embed';
  const EMBED_RESULT_TYPE = 'k3d-embed-result';
  const EMBED_ACTIONS = ['hello', 'show', 'style', 'reset', 'spin', 'snapshot', 'camera-get', 'camera-set', 'dispose'];

  // 宿主 → iframe
  function encodeRequest(id, action, params) {
    if (!EMBED_ACTIONS.includes(action)) {
      throw new Error(`未知的 embed action：${action}`);
    }
    return Object.assign({ type: EMBED_HOST_TYPE, id, action }, params || {});
  }

  // iframe → 宿主
  function encodeResult(id, ok, extra) {
    return Object.assign({ type: EMBED_RESULT_TYPE, id, ok: !!ok }, extra || {});
  }

  // 校验并解包一条消息；不是协议消息返回 null，未知 action 抛错（调用方应回错误）
  function decodeMessage(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.type === EMBED_HOST_TYPE) {
      if (!EMBED_ACTIONS.includes(data.action)) {
        throw new Error(`未知的 embed action：${data.action}`);
      }
      return { direction: 'request', id: data.id, action: data.action, message: data };
    }
    if (data.type === EMBED_RESULT_TYPE) {
      return { direction: 'result', id: data.id, ok: !!data.ok, message: data };
    }
    return null;
  }

  /* ---------- InteractionSession ---------- */

  const DEFAULT_TIMEOUT = 20000;
  const SNAPSHOT_TIMEOUT = 30000;
  let activeSession = null;

  // 单实例约束抽成可注入纯函数，便于单测
  function claimActiveSession(current, newInstance) {
    if (current && !current.__disposed) return { ok: false, active: current };
    return { ok: true, active: newInstance };
  }

  class InteractionSession {
    constructor(opts) {
      const o = opts || {};
      if (!o.host || typeof o.host.appendChild !== 'function') {
        throw new Error('host 必须是可挂载 iframe 的 DOM 容器');
      }
      this.host = o.host;
      this.serverBase = typeof o.serverBase === 'string' ? o.serverBase : '';
      this.molblock = o.molblock || '';
      this.style = STYLES.includes(o.style) ? o.style : 'ballstick';
      this.camera = normalizeCamera(o.camera) || null;
      this.onReady = typeof o.onReady === 'function' ? o.onReady : null;
      this.onError = typeof o.onError === 'function' ? o.onError : null;
      this.timeoutMs = finite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT;
      this.iframe = null;
      this.__disposed = false;
      this.__seq = 0;
      this.__pending = new Map(); // id → { resolve, timer }
      this.__onMessage = this.__handleMessage.bind(this);
    }

    mount() {
      const claim = claimActiveSession(activeSession, this);
      if (!claim.ok) {
        return Promise.reject(new Error('已有一个活跃的 3D 交互会话，请先 dispose'));
      }
      activeSession = this;
      root.addEventListener && root.addEventListener('message', this.__onMessage);
      const iframe = root.document.createElement('iframe');
      iframe.setAttribute('title', '3D 分子预览');
      iframe.style.border = '0';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.src = `${this.serverBase}/threed.html?embed=1`;
      this.iframe = iframe;
      this.__ready = new Promise((resolve, reject) => {
        this.__readyResolve = resolve;
        this.__readyReject = reject;
        this.__readyTimer = setTimeout(() => {
          reject(new Error('3D 预览加载超时'));
          this.__notifyError('3D 预览加载超时');
        }, this.timeoutMs);
      });
      this.host.appendChild(iframe);
      return this.__ready;
    }

    __notifyError(message) {
      if (this.onError) this.onError(new Error(message));
    }

    __handleMessage(event) {
      if (this.__disposed || !this.iframe || event?.source !== this.iframe.contentWindow) return;
      const data = event && event.data;
      let decoded;
      try { decoded = decodeMessage(data); } catch (e) {
        // hello 带未知 action 之类：按协议错误回执
        if (data && data.type === EMBED_HOST_TYPE) this.__post(data.id, false, { error: e.message });
        return;
      }
      if (!decoded) return;
      if (decoded.direction === 'request') {
        if (decoded.action === 'hello' && !this.__handshakeStarted) {
          this.__handshakeStarted = true;
          this.__post(decoded.id, true);
          this._completeHandshake().then(() => {
            clearTimeout(this.__readyTimer);
            this.__readyResolve(this);
          }, err => {
            clearTimeout(this.__readyTimer);
            this.__readyReject(err);
          });
        } else if (decoded.action === 'dispose-result') {
          // iframe 内部释放完成的回执，无需处理
        }
        return;
      }
      const pending = this.__pending.get(decoded.id);
      if (!pending) return; // dispose 后的迟到回包 / 未知 id：丢弃
      clearTimeout(pending.timer);
      this.__pending.delete(decoded.id);
      const msg = decoded.message;
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.error || 'embed 操作失败'));
    }

    __post(id, ok, extra) {
      const win = this.iframe && this.iframe.contentWindow;
      if (win) win.postMessage(Object.assign({ type: EMBED_RESULT_TYPE, id, ok }, extra || {}), '*');
    }

    __request(action, params, timeout) {
      if (this.__disposed || !this.iframe || !this.iframe.contentWindow) {
        return Promise.reject(new Error('会话已释放'));
      }
      const id = ++this.__seq;
      const req = encodeRequest(id, action, params);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.__pending.delete(id);
          reject(new Error(`embed ${action} 超时`));
        }, timeout || this.timeoutMs);
        this.__pending.set(id, { resolve, reject, timer });
        this.iframe.contentWindow.postMessage(req, '*');
      });
    }

    // mount() 内部用：等待 iframe 的 hello 握手
    __awaitHello() { return this.__ready; }

    setStyle(style) {
      if (!STYLES.includes(style)) return Promise.reject(new Error('样式无效'));
      return this.__request('style', { style }).then(() => { this.style = style; });
    }

    resetView() { return this.__request('reset'); }

    spin(on) { return this.__request('spin', { on: !!on }); }

    applyCameraJson(cam) {
      const normalized = normalizeCamera(cam);
      if (!normalized) return Promise.reject(new Error('camera 数据无效'));
      return this.__request('camera-set', { camera: normalized });
    }

    cameraJson() {
      return this.__request('camera-get').then(msg => msg.camera || null);
    }

    snapshot(opts) {
      const o = opts || {};
      const width = finite(o.width) && o.width > 0 ? Math.round(o.width) : undefined;
      const height = finite(o.height) && o.height > 0 ? Math.round(o.height) : undefined;
      return this.__request('snapshot', { width, height, trim: o.trim === true }, SNAPSHOT_TIMEOUT)
        .then(msg => {
          if (typeof msg.dataURL !== 'string' || !msg.dataURL.startsWith('data:image/')) {
            throw new Error('快照数据无效');
          }
          return msg.dataURL;
        });
    }

    dispose() {
      if (this.__disposed) return;
      this.__disposed = true;
      clearTimeout(this.__readyTimer);
      this.__readyReject?.(new Error('会话已释放'));
      for (const [id, pending] of Array.from(this.__pending)) {
        clearTimeout(pending.timer);
        pending.reject(new Error('会话已释放'));
      }
      this.__pending.clear();
      root.removeEventListener && root.removeEventListener('message', this.__onMessage);
      // 请求 iframe 内自行释放 WebGL 上下文（尽力而为），再移除节点
      try {
        if (this.iframe && this.iframe.contentWindow) {
          this.iframe.contentWindow.postMessage(encodeRequest(0, 'dispose'), '*');
        }
      } catch (e) { /* ignore */ }
      if (this.iframe && this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
      if (activeSession === this) activeSession = null;
    }

  }

  // mount() 里等待 hello 并完成首帧 show；拆成独立入口便于单测单实例逻辑
  InteractionSession.prototype._completeHandshake = function () {
    return this.__request('show', {
      molblock: this.molblock, style: this.style
    }).then(() => {
      if (this.camera) return this.__request('camera-set', { camera: this.camera });
    }).then(() => {
      if (this.onReady) this.onReady(this);
      return this;
    }).catch(err => {
      this.__notifyError(String((err && err.message) || err));
      throw err;
    });
  };

  MW.documentObject3D = {
    KIND, STYLES, BANDS, DEFAULT_W, DEFAULT_H,
    MOLFILE_MAX, NOTE_MAX_COUNT, NOTE_MAX_LEN,
    EMBED_HOST_TYPE, EMBED_RESULT_TYPE, EMBED_ACTIONS,
    DEFAULT_TIMEOUT, SNAPSHOT_TIMEOUT,
    createObject, validateObject, normalizeMolblock,
    generate3D, normalizeCamera, cameraJson, applyCameraJson,
    encodeRequest, encodeResult, decodeMessage,
    claimActiveSession,
    InteractionSession,
    getActiveSession: () => activeSession
  };
})(typeof window !== 'undefined' ? window : globalThis);
