/* MolStudio 工作台 · `.molwork` 完整快照的格式校验、稳定序列化与迁移
 * 依赖：mechanism-model.js（先加载）
 *
 * 封装（第 9.1 节）：
 *   { format: "molstudio-workbench", version: 1,
 *     ket: <真实 KET 对象>, bindings: { atoms: [...], bonds: [...] },
 *     mechanism: { lonePairs: [], arrows: [], steps: [] } }
 *
 * 校验分两类，不能混为一谈：
 *   - 格式错误（重复 ID、缺字段、非有限数值、未知主版本）→ 拒绝载入，保留旧文档
 *   - 合法悬空引用（端点指向的原子/键已不存在）→ 允许载入，转成可见的「待重绑」
 */
(function (root) {
  'use strict';
  const MW = (root.MolWorkbench = root.MolWorkbench || {});
  const M = MW.model;

  const LIMITS = {
    bytes: 8 * 1024 * 1024,
    assetBytes: 64 * 1024 * 1024,
    atoms: 20000,
    bonds: 40000,
    arrows: 2000,
    lonePairs: 4000,
    steps: 200,
    reactionStepOperations: 2048
  };

  function isWorkbenchText(text) {
    if (typeof text !== 'string') return false;
    if (text.length > LIMITS.bytes + Math.ceil(LIMITS.assetBytes / 3) * 4 + 4096) return false;
    // 先做便宜的字符串判断，避免把每个 .ket 都 JSON.parse 一遍
    if (text.indexOf('molstudio-workbench') < 0) return false;
    try {
      const obj = JSON.parse(text);
      return !!obj && obj.format === M.FORMAT && (obj.version !== 1 || text.length <= LIMITS.bytes);
    } catch (e) {
      return false;
    }
  }

  function round(n) {
    if (!M.finite(n)) return 0;
    return Math.round(n * 1e6) / 1e6;
  }

  /* bindings：原子/键 uuid → 该份 KET 快照里的定位器（mol + 数组下标） */
  function serializeBindings(bindings) {
    const b = bindings || {};
    const atoms = (b.atoms || []).map(x => ({ id: x.id, mol: x.mol, index: x.index }));
    const bonds = (b.bonds || []).map(x => ({
      id: x.id, mol: x.mol, index: x.index,
      begin: x.begin === undefined ? null : x.begin,
      end: x.end === undefined ? null : x.end
    }));
    return { atoms: atoms, bonds: bonds };
  }

  /* 生成完整快照文本。ket 可以是对象，也可以是 getKet() 的字符串 */
  function serializeWorkbench(opts) {
    const o = opts || {};
    let ketObj = o.ket;
    if (typeof ketObj === 'string') {
      try { ketObj = JSON.parse(ketObj); } catch (e) { throw new Error('KET 无法解析，未生成快照'); }
    }
    if (!ketObj || typeof ketObj !== 'object') throw new Error('缺少 KET 内容，未生成快照');
    // Ketcher emits boolean selection flags in native KET entities. They are UI
    // state, not a source edit: native save/dirty tracking shares this snapshot.
    // Classify only those entity holders, rather than stripping same-name keys
    // recursively from arbitrary metadata, query properties or rich text data.
    const selectionHolders = new WeakSet();
    const mark = value => { if (value && typeof value === 'object' && !Array.isArray(value)) selectionHolders.add(value); };
    for (const section of Object.values(ketObj)) {
      if (!section || section.type !== 'molecule') continue;
      mark(section);
      for (const key of ['atoms', 'bonds']) if (Array.isArray(section[key])) section[key].forEach(mark);
    }
    const drawingTypes = new Set(['arrow', 'plus', 'text', 'image', 'simpleObject', 'multitailArrow']);
    if (Array.isArray(ketObj.root && ketObj.root.nodes)) for (const node of ketObj.root.nodes) {
      if (!node || typeof node !== 'object') continue;
      if (drawingTypes.has(node.type) || node.$ref && ketObj[node.$ref] && ketObj[node.$ref].type === 'molecule') {
        mark(node);
        if (drawingTypes.has(node.type)) mark(node.data);
      }
    }
    if (o.document !== undefined) {
      if (!MW.documentModel) throw new Error('文档模型未加载');
      const check = MW.documentModel.validateDocument(o.document);
      if (!check.ok) throw new Error('文档无效：' + check.errors.join('；'));
    }
    const doc = {
      format: M.FORMAT,
      version: o.document !== undefined ? 2 : M.VERSION,
      ket: ketObj,
      bindings: serializeBindings(o.bindings),
      mechanism: M.serializeMechanism(o.mechanism || M.emptyState()),
      ...(o.agentTask ? { agentTask: validateAgentTask(o.agentTask) } : {}),
      ...(o.reactionSteps && o.reactionSteps.length ? { reactionSteps: o.reactionSteps } : {}),
      ...(o.reactionStepOperations && o.reactionStepOperations.length ? { reactionStepOperations: o.reactionStepOperations } : {}),
      ...(o.document !== undefined ? { document: o.document } : {})
    };
    const serialized = JSON.stringify(doc, function (key, value) {
      return (key === 'selected' || key === 'initiallySelected') && typeof value === 'boolean' && selectionHolders.has(this)
        ? undefined : value;
    });
    if (o.document !== undefined && nonAssetLength(doc) > LIMITS.bytes) throw new Error('文件非资源内容超过 8MB 上限');
    return serialized;
  }

  /* 只改机理层、不重写 KET 的快速序列化（导出/内部比较用，仍走同一字段顺序） */
  function mechanismSignature(mech) {
    return JSON.stringify(M.serializeMechanism(mech || M.emptyState()));
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function nonAssetLength(obj) {
    const copy = Object.assign({}, obj, { document: Object.assign({}, obj.document, { assets: {} }) });
    const value = JSON.stringify(copy);
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : unescape(encodeURIComponent(value)).length;
  }

  // A task checkpoint is document data, never an instruction to start a model.
  // Keep the same bounded shape at save, load and bridge writes. In particular,
  // credentials, transcripts and incomplete tool arguments have no place here.
  function validateAgentTask(value) {
    if (value === null || value === undefined) return null;
    const allowed = (v, keys) => isPlainObject(v) && Object.keys(v).every(key => keys.includes(key));
    const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    const ids = (v, max) => Array.isArray(v) && v.length <= max && v.every(id => text(id, 160)) && new Set(v).size === v.length;
    const fail = () => { throw new Error('AI 任务断点格式无效或超出保存范围'); };
    if (!allowed(value, ['version', 'taskId', 'mode', 'goal', 'status', 'phaseIndex', 'requestIndex', 'phases',
      'completedOperationIds', 'checks', 'pauseReason', 'updatedAt']) || value.version !== 1 ||
        !text(value.taskId, 160) || !text(value.goal, 262144) || !['active', 'paused', 'completed'].includes(value.status) ||
        (value.mode !== undefined && !['single', 'phased'].includes(value.mode)) ||
        !Number.isSafeInteger(value.requestIndex) || value.requestIndex < 0 ||
        !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
        !Array.isArray(value.phases) || !value.phases.length || value.phases.length > 32 ||
        !Number.isSafeInteger(value.phaseIndex) || value.phaseIndex < 0 || value.phaseIndex > value.phases.length ||
        !ids(value.completedOperationIds, 4096) ||
        (value.pauseReason !== undefined && !text(value.pauseReason, 160))) fail();
    const phaseIds = new Set();
    for (const phase of value.phases) {
      if (!allowed(phase, ['id', 'objective', 'kind', 'status', 'operationIds', 'summary']) ||
          !text(phase.id, 160) || phaseIds.has(phase.id) || !text(phase.objective, 1000) ||
          (phase.kind !== undefined && !['draw', 'review'].includes(phase.kind)) ||
          !['pending', 'active', 'completed'].includes(phase.status) || !ids(phase.operationIds, 160) ||
          (phase.summary !== undefined && (typeof phase.summary !== 'string' || phase.summary.length > 2000))) fail();
      phaseIds.add(phase.id);
    }
    if (!allowed(value.checks, ['status', 'issues']) || !['pending', 'passed', 'failed'].includes(value.checks.status) ||
        !Array.isArray(value.checks.issues) || value.checks.issues.length > 32 ||
        value.checks.issues.some(issue => !text(issue, 1000))) fail();
    if (value.status === 'completed') {
      if (value.phaseIndex !== value.phases.length || value.phases.some(phase => phase.status !== 'completed') || value.checks.status !== 'passed') fail();
    } else if (value.phaseIndex === value.phases.length) fail();
    return JSON.parse(JSON.stringify(value));
  }

  /* 校验并解析；返回 { ok, doc?, error?, code? } */
  function parseWorkbench(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 'empty', error: '文件是空的' };
    }
    if (text.length > LIMITS.bytes + Math.ceil(LIMITS.assetBytes / 3) * 4 + 4096) {
      return { ok: false, code: 'too_large', error: '文件超过 ' + Math.round(LIMITS.bytes / 1024 / 1024) + 'MB 上限，已拒绝载入' };
    }
    let obj;
    try { obj = JSON.parse(text); } catch (e) {
      return { ok: false, code: 'bad_json', error: '不是有效的 JSON：' + e.message };
    }
    if (!isPlainObject(obj)) return { ok: false, code: 'bad_format', error: '顶层不是对象' };
    if (obj.format !== M.FORMAT) {
      return { ok: false, code: 'bad_format', error: '不是 MolStudio 工作台文件（format 字段不匹配）' };
    }
    const version = obj.version;
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, code: 'bad_version', error: 'version 字段非法' };
    }
    if (version > 2 || (version === 2 && !MW.documentModel)) {
      return { ok: false, code: 'newer_version',
               error: '该文件由更新版本（v' + version + '）保存，当前版本只支持 v' + (MW.documentModel ? 2 : M.VERSION) + '，已拒绝载入以免丢数据' };
    }

    if ((version === 1 && text.length > LIMITS.bytes) || (version === 2 && nonAssetLength(obj) > LIMITS.bytes)) {
      return { ok: false, code: 'too_large', error: '文件非资源内容超过 8MB 上限，已拒绝载入' };
    }

    const errs = [];
    if (version === 1 && Object.prototype.hasOwnProperty.call(obj, 'document')) errs.push('v1 文件不支持 document');
    if (version === 2) {
      if (!MW.documentModel) errs.push('文档模型未加载');
      else {
        const check = MW.documentModel.validateDocument(obj.document);
        if (!check.ok) errs.push(...check.errors);
      }
    }
    let agentTask = null;
    if (!isPlainObject(obj.ket)) errs.push('缺少 ket 对象');
    if (!isPlainObject(obj.bindings)) errs.push('缺少 bindings 对象');
    if (!isPlainObject(obj.mechanism)) errs.push('缺少 mechanism 对象');
    if (errs.length) return { ok: false, code: 'bad_format', error: errs.join('；') };
    try { agentTask = validateAgentTask(obj.agentTask); }
    catch (error) { errs.push(error.message); }

    // KET 结构：允许空画布（root.nodes 为空数组），但不接受随手写的 {}
    const ket = obj.ket;
    if (!isPlainObject(ket.root) || !Array.isArray(ket.root.nodes)) {
      errs.push('ket.root.nodes 缺失或不是数组');
    }
    const molKeys = [];
    for (const k of Object.keys(ket)) {
      const sec = ket[k];
      if (isPlainObject(sec) && sec.type === 'molecule') {
        if (!Array.isArray(sec.atoms)) errs.push('KET 分子 ' + k + ' 缺少 atoms 数组');
        else if (sec.atoms.length > LIMITS.atoms) errs.push('KET 原子数超过上限');
        if (sec.bonds !== undefined && !Array.isArray(sec.bonds)) errs.push('KET 分子 ' + k + ' 的 bonds 不是数组');
        for (const a of (Array.isArray(sec.atoms) ? sec.atoms : [])) {
          const loc = a && a.location;
          if (!isPlainObject(a) || !Array.isArray(loc) || !M.finite(loc[0]) || !M.finite(loc[1])) {
            errs.push('KET 分子 ' + k + ' 存在无效原子或非有限坐标');
          }
        }
        for (const bd of (Array.isArray(sec.bonds) ? sec.bonds : [])) {
          if (!isPlainObject(bd) || !Array.isArray(bd.atoms) || bd.atoms.length !== 2 ||
              bd.atoms.some(index => !Number.isInteger(index) || index < 0 || !Array.isArray(sec.atoms) || index >= sec.atoms.length)) {
            errs.push('KET 分子 ' + k + ' 存在无效的键端点');
          }
        }
        molKeys.push(k);
      }
    }

    // bindings
    const atomIds = new Set();
    const bondIds = new Set();
    const b = obj.bindings;
    if (!Array.isArray(b.atoms)) errs.push('bindings.atoms 必须是数组');
    if (!Array.isArray(b.bonds)) errs.push('bindings.bonds 必须是数组');
    for (const a of (Array.isArray(b.atoms) ? b.atoms : [])) {
      if (!isPlainObject(a) || typeof a.id !== 'string' || !a.id) { errs.push('bindings.atoms 存在无效条目'); continue; }
      if (atomIds.has(a.id)) errs.push('原子绑定 ID 重复：' + a.id);
      atomIds.add(a.id);
      if (typeof a.mol !== 'string') errs.push('原子绑定 ' + a.id + ' 缺少 mol');
      if (!Number.isInteger(a.index) || a.index < 0) errs.push('原子绑定 ' + a.id + ' 的 index 非法');
    }
    for (const bd of (Array.isArray(b.bonds) ? b.bonds : [])) {
      if (!isPlainObject(bd) || typeof bd.id !== 'string' || !bd.id) { errs.push('bindings.bonds 存在无效条目'); continue; }
      if (bondIds.has(bd.id)) errs.push('键绑定 ID 重复：' + bd.id);
      bondIds.add(bd.id);
      if (typeof bd.mol !== 'string') errs.push('键绑定 ' + bd.id + ' 缺少 mol');
      if (!Number.isInteger(bd.index) || bd.index < 0) errs.push('键绑定 ' + bd.id + ' 的 index 非法');
      for (const end of ['begin', 'end']) {
        if (bd[end] !== undefined && bd[end] !== null && (typeof bd[end] !== 'string' || !atomIds.has(bd[end]))) {
          errs.push('键绑定 ' + bd.id + ' 的 ' + end + ' 端点没有对应的原子绑定');
        }
      }
    }
    // 同一 (mol, index) 不能被两个 uuid 占用（否则身份多解）
    const seenLoc = new Set();
    for (const a of (Array.isArray(b.atoms) ? b.atoms : [])) {
      if (!isPlainObject(a)) continue;
      if (!Number.isInteger(a.index) || typeof a.mol !== 'string') continue;
      const key = a.mol + '#' + a.index;
      if (seenLoc.has(key)) errs.push('原子绑定定位器重复：' + key);
      seenLoc.add(key);
    }

    // Optional v1 extension: native straight-arrow semantics. Node locators
    // refer to this exact KET, while participants retain stable atom bindings.
    const reactionSteps = obj.reactionSteps || [];
    if (obj.reactionSteps !== undefined && (!Array.isArray(obj.reactionSteps) || obj.reactionSteps.length > LIMITS.arrows)) errs.push('reactionSteps 必须是有界数组');
    const usedArrows = new Set(), usedStepIds = new Set();
    const allowed = (value, keys) => isPlainObject(value) && Object.keys(value).every(key => keys.includes(key));
    const flowNumbers = ['direction', 'steps', 'rowLeft', 'rowY', 'rowBottom', 'rowRight', 'rowWidth', 'continuation', 'sourceRowY',
      'arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY'];
    for (const step of Array.isArray(reactionSteps) ? reactionSteps : []) {
      if (!allowed(step, ['stepId', 'version', 'arrow', 'reactants', 'products', 'layout', 'flow', 'conditions', 'labels'])) { errs.push('reactionSteps 存在未知字段或无效条目'); continue; }
      // Stable step identities and revisions are optional v1 extensions. Older
      // snapshots acquire them in the bridge after restoring their locators.
      if (step.stepId !== undefined) {
        if (typeof step.stepId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(step.stepId) || usedStepIds.has(step.stepId)) errs.push('reactionSteps 步骤 ID 无效或重复');
        usedStepIds.add(step.stepId);
      }
      if (step.version !== undefined && (!Number.isSafeInteger(step.version) || step.version < 1)) errs.push('reactionSteps 步骤版本无效');
      if (!Number.isInteger(step.arrow) || ket.root?.nodes?.[step.arrow]?.type !== 'arrow' || usedArrows.has(step.arrow)) errs.push('reactionSteps 箭头定位器无效或重复');
      usedArrows.add(step.arrow);
      for (const side of ['reactants', 'products']) {
        const refs = step[side];
        if (!Array.isArray(refs) || !refs.length || refs.length > 16 || new Set(refs).size !== refs.length || refs.some(id => !atomIds.has(id))) errs.push('reactionSteps 分子引用无效');
      }
      if (Array.isArray(step.reactants) && Array.isArray(step.products) && step.reactants.some(id => step.products.includes(id))) errs.push('reactionSteps 两侧分子引用重复');
      if (step.conditions !== undefined && (typeof step.conditions !== 'string' || step.conditions.length > 64)) errs.push('reactionSteps 条件文字无效');
      if (step.layout !== undefined) {
        const layout = step.layout;
        if (!allowed(layout, ['reactantPlacement', 'reagentPlacement', 'breakBefore', 'conditions']) ||
            (layout.reactantPlacement !== undefined && !['auto', 'horizontal', 'vertical'].includes(layout.reactantPlacement)) ||
            (layout.reagentPlacement !== undefined && !['auto', 'left', 'right', 'above', 'below'].includes(layout.reagentPlacement)) ||
            (layout.breakBefore !== undefined && typeof layout.breakBefore !== 'boolean') ||
            (layout.conditions !== undefined && (typeof layout.conditions !== 'string' || layout.conditions.length > 64))) errs.push('reactionSteps 排布声明无效');
      }
      if (step.flow !== undefined) {
        const flow = step.flow;
        if (!allowed(flow, [...flowNumbers, 'axis', 'reading', 'forward', 'graph', 'routeId', 'laneId', 'anchors']) || flowNumbers.some(key => flow[key] !== undefined && (!M.finite(flow[key]) || Math.abs(flow[key]) > 10000)) ||
            ['reading', 'forward', 'graph'].some(key => flow[key] !== undefined && typeof flow[key] !== 'boolean') ||
            ['routeId', 'laneId'].some(key => flow[key] !== undefined && (typeof flow[key] !== 'string' || !flow[key] || flow[key].length > 160)) ||
            (flow.axis !== undefined && !['x', 'y'].includes(flow.axis))) errs.push('reactionSteps 排布数据无效');
        if (flow?.graph === true && (['arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY'].some(key => !M.finite(flow[key])) ||
            !flow.routeId || !flow.laneId)) errs.push('reactionSteps 图排布缺少实际箭头或路线定位');
        if (flow?.anchors !== undefined && (flow.graph !== true || !Array.isArray(flow.anchors) || !flow.anchors.length || flow.anchors.length > 64 ||
            new Set(flow.anchors.map(anchor => anchor?.atomId)).size !== flow.anchors.length || flow.anchors.some(anchor =>
              !allowed(anchor, ['atomId', 'x', 'y']) || typeof anchor.atomId !== 'string' || !atomIds.has(anchor.atomId) ||
              ![...(Array.isArray(step.reactants) ? step.reactants : []), ...(Array.isArray(step.products) ? step.products : [])].includes(anchor.atomId) ||
              !M.finite(anchor.x) || !M.finite(anchor.y) || Math.abs(anchor.x) > 10000 || Math.abs(anchor.y) > 10000))) {
          errs.push('reactionSteps 图排布结构定位无效');
        }
      }
      if (step.labels !== undefined && (!Array.isArray(step.labels) || step.labels.length > 129 || step.labels.some(label =>
          !allowed(label, ['node', 'role', 'text', 'token', 'kind', 'side', 'at', 'anchorRefs', 'layoutX', 'layoutY', 'anchorDx', 'anchorDy']) || !Number.isInteger(label.node) || ket.root?.nodes?.[label.node]?.type !== 'text' ||
          !['conditions', 'previousRow', 'nextRow', 'graphPort'].includes(label.role) || typeof label.text !== 'string' || label.text.length > 100 ||
          (label.role !== 'graphPort' && ['token', 'kind', 'side', 'at', 'anchorRefs', 'layoutX', 'layoutY', 'anchorDx', 'anchorDy'].some(key => Object.prototype.hasOwnProperty.call(label, key))) ||
          ['anchorDx', 'anchorDy'].some(key => label[key] !== undefined && !M.finite(label[key])) ||
          (label.role === 'graphPort' && (typeof label.token !== 'string' || !label.token || label.token.length > 64 || label.text !== label.token ||
            !['wrap', 'branch', 'merge', 'reuse'].includes(label.kind) || !['source', 'target'].includes(label.side) || !['molecule', 'port'].includes(label.at) ||
            !Array.isArray(label.anchorRefs) || !label.anchorRefs.length || label.anchorRefs.length > 32 ||
            new Set(label.anchorRefs).size !== label.anchorRefs.length || label.anchorRefs.some(id => !atomIds.has(id)) ||
            !M.finite(label.layoutX) || !M.finite(label.layoutY) ||
            (label.at === 'molecule' && (!M.finite(label.anchorDx) || !M.finite(label.anchorDy)))))))) errs.push('reactionSteps 标签数据无效');
    }

    // Document-level step operations retain retries after a step is deleted or
    // the document is reopened. A tombstone need not have a live reactionStep.
    const reactionStepOperations = obj.reactionStepOperations || [];
    if (obj.reactionStepOperations !== undefined && (!Array.isArray(obj.reactionStepOperations) || obj.reactionStepOperations.length > LIMITS.reactionStepOperations)) errs.push('reactionStepOperations 必须是有界数组');
    const usedOperationIds = new Set();
    for (const operation of Array.isArray(reactionStepOperations) ? reactionStepOperations : []) {
      if (!allowed(operation, ['id', 'type', 'signature', 'resolvedSignature', 'stepId', 'version', 'action'])) { errs.push('reactionStepOperations 存在未知字段或无效条目'); continue; }
      if (typeof operation.id !== 'string' || !operation.id || operation.id.length > 160 || usedOperationIds.has(operation.id)) errs.push('reactionStepOperations 操作 ID 无效或重复');
      usedOperationIds.add(operation.id);
      if (!['reactionStep.create', 'reactionStep.modify', 'reactionStep.delete'].includes(operation.type) ||
          !['create', 'modify', 'delete'].includes(operation.action)) errs.push('reactionStepOperations 操作类型无效');
      if (typeof operation.signature !== 'string' || !operation.signature || operation.signature.length > 8192) errs.push('reactionStepOperations 操作签名无效');
      if (operation.resolvedSignature !== undefined && (typeof operation.resolvedSignature !== 'string' || !operation.resolvedSignature || operation.resolvedSignature.length > 8192)) errs.push('reactionStepOperations 解析后签名无效');
      if (typeof operation.stepId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(operation.stepId)) errs.push('reactionStepOperations 步骤 ID 无效');
      if (!Number.isSafeInteger(operation.version) || operation.version < 1) errs.push('reactionStepOperations 步骤版本无效');
    }

    // mechanism
    const mech = obj.mechanism;
    if (!Array.isArray(mech.lonePairs)) errs.push('mechanism.lonePairs 必须是数组');
    if (!Array.isArray(mech.arrows)) errs.push('mechanism.arrows 必须是数组');
    if ((mech.lonePairs || []).length > LIMITS.lonePairs) errs.push('孤对数量超过上限');
    if ((mech.arrows || []).length > LIMITS.arrows) errs.push('箭头数量超过上限');
    M.validateMechanism(mech, errs);

    if (errs.length) {
      return { ok: false, code: 'invalid', error: errs.slice(0, 8).join('；') };
    }

    return {
      ok: true,
      doc: {
        format: obj.format,
        version: version,
        ket: ket,
        bindings: { atoms: b.atoms, bonds: b.bonds },
        ...(agentTask && { agentTask }),
        ...(reactionSteps.length ? { reactionSteps: reactionSteps } : {}),
        ...(reactionStepOperations.length ? { reactionStepOperations: reactionStepOperations } : {}),
        ...(version === 2 ? { document: obj.document } : {}),
        mechanism: M.normalizeState({
          steps: mech.steps,
          lonePairs: mech.lonePairs,
          arrows: mech.arrows
        })
      },
      molKeys: molKeys
    };
  }

  /* 从旧 .ket / 空文档建立工作台快照（机理层为空） */
  function workbenchFromKet(ketText) {
    let ket;
    try { ket = JSON.parse(ketText); } catch (e) { throw new Error('KET 无法解析'); }
    return serializeWorkbench({ ket: ket, bindings: { atoms: [], bonds: [] }, mechanism: M.emptyState() });
  }

  MW.storage = {
    LIMITS: LIMITS,
    isWorkbenchText: isWorkbenchText,
    serializeWorkbench: serializeWorkbench,
    parseWorkbench: parseWorkbench,
    workbenchFromKet: workbenchFromKet,
    mechanismSignature: mechanismSignature,
    validateAgentTask: validateAgentTask,
    round: round
  };
})(typeof window !== 'undefined' ? window : globalThis);
