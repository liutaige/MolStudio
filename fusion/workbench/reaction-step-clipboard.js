/* Pure reaction-step clipboard planner. It never changes native objects,
 * document history, inputs, usedTokens, or a task/operation ledger.
 */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  const LIMITS = { steps: 200, side: 16, labels: 129, anchors: 64, coordinate: 10000, nativeContent: 262144 };
  const flowNumbers = ['direction', 'steps', 'rowLeft', 'rowY', 'rowBottom', 'rowRight', 'rowWidth', 'continuation', 'sourceRowY',
    'arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY'];
  const xKeys = ['rowLeft', 'rowRight', 'arrowStartX', 'arrowEndX'];
  const yKeys = ['rowY', 'rowBottom', 'sourceRowY', 'arrowStartY', 'arrowEndY'];
  const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const only = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate;
  const point = value => only(value, ['x', 'y']) && finite(value.x) && finite(value.y);
  const uniqueIds = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(id) && new Set(value).size === value.length;
  const copy = value => JSON.parse(JSON.stringify(value));
  const normalize = value => value.replace(/\s+/g, '');
  const tokenPattern = /^(?:续\s*[1-9]\d*|接\s*B[1-9]\d*)$/;
  const tokenText = text => typeof text === 'string' && text.length <= 64 && tokenPattern.test(text);
  const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value));
  function validate(data) {
    const errors = [], add = text => { if (errors.length < 32) errors.push(text); };
    if (!only(data, ['version', 'steps']) || data.version !== 1 || !Array.isArray(data.steps) || data.steps.length > LIMITS.steps)
      return { ok: false, errors: ['反应步骤剪贴板版本或数量无效'] };
    const stepIds = new Set(), ports = new Map(), legacyPorts = new Map();
    for (const step of data.steps) {
      if (!only(step, ['stepId', 'reactants', 'products', 'layout', 'flow', 'conditions', 'arrow', 'labels'])) { add('反应步骤含未知字段或不是对象'); continue; }
      if (!id(step.stepId) || stepIds.has(step.stepId)) add('反应步骤 ID 无效或重复');
      stepIds.add(step.stepId);
      if (!uniqueIds(step.reactants, LIMITS.side) || !uniqueIds(step.products, LIMITS.side) || step.reactants.some(ref => step.products.includes(ref))) add('反应步骤参与者无效');
      const participants = new Set([...(Array.isArray(step.reactants) ? step.reactants : []), ...(Array.isArray(step.products) ? step.products : [])]);
      if (!only(step.arrow, ['mode', 'start', 'end']) || typeof step.arrow.mode !== 'string' || !step.arrow.mode || step.arrow.mode.length > 160 ||
          !point(step.arrow.start) || !point(step.arrow.end) || (point(step.arrow.start) && point(step.arrow.end) && Math.hypot(step.arrow.start.x - step.arrow.end.x, step.arrow.start.y - step.arrow.end.y) < 1e-9)) add('反应箭头几何无效');
      if (step.conditions !== undefined && (typeof step.conditions !== 'string' || step.conditions.length > 64)) add('反应条件无效');
      if (step.layout !== undefined && (!only(step.layout, ['reactantPlacement', 'reagentPlacement', 'breakBefore', 'conditions']) ||
          (step.layout.reactantPlacement !== undefined && !['auto', 'horizontal', 'vertical'].includes(step.layout.reactantPlacement)) ||
          (step.layout.reagentPlacement !== undefined && !['auto', 'left', 'right', 'above', 'below'].includes(step.layout.reagentPlacement)) ||
          (step.layout.breakBefore !== undefined && typeof step.layout.breakBefore !== 'boolean') ||
          (step.layout.conditions !== undefined && (typeof step.layout.conditions !== 'string' || step.layout.conditions.length > 64)))) add('反应步骤布局无效');
      if (step.flow !== undefined) {
        const f = step.flow;
        if (!only(f, [...flowNumbers, 'axis', 'reading', 'forward', 'graph', 'routeId', 'laneId', 'anchors']) ||
            flowNumbers.some(key => f?.[key] !== undefined && !finite(f[key])) ||
            ['reading', 'forward', 'graph'].some(key => f?.[key] !== undefined && typeof f[key] !== 'boolean') ||
            (f?.axis !== undefined && !['x', 'y'].includes(f.axis)) ||
            ['routeId', 'laneId'].some(key => f?.[key] !== undefined && !id(f[key])) ||
            (f?.rowWidth !== undefined && f.rowWidth <= 0) ||
            (f?.continuation !== undefined && (!Number.isSafeInteger(f.continuation) || f.continuation < 1)) ||
            (f?.graph === true && (!id(f.routeId) || !id(f.laneId) || ['arrowStartX', 'arrowStartY', 'arrowEndX', 'arrowEndY'].some(key => !finite(f[key]))))) add('反应步骤流向数据无效');
        if (f?.anchors !== undefined && (f.graph !== true || !Array.isArray(f.anchors) || !f.anchors.length || f.anchors.length > LIMITS.anchors ||
            new Set(f.anchors.map(a => a?.atomId)).size !== f.anchors.length || f.anchors.some(a => !only(a, ['atomId', 'x', 'y']) || !id(a.atomId) || !participants.has(a.atomId) || !finite(a.x) || !finite(a.y)))) add('反应步骤定位锚点无效或悬空');
        if (f?.graph !== true && Number.isSafeInteger(f?.continuation) && f.continuation > 0) {
          const key = normalize('续 ' + f.continuation);
          if (!legacyPorts.has(key)) legacyPorts.set(key, []);
        }
      }
      if (!Array.isArray(step.labels) || step.labels.length > LIMITS.labels) { add('反应步骤标签数量无效'); continue; }
      for (const label of step.labels) {
        if (!only(label, ['role', 'text', 'nativeContent', 'position', 'token', 'kind', 'side', 'at', 'anchorRefs', 'layoutX', 'layoutY', 'anchorDx', 'anchorDy']) ||
            !['conditions', 'previousRow', 'nextRow', 'graphPort'].includes(label.role) || typeof label.text !== 'string' || label.text.length > 100 ||
            typeof label.nativeContent !== 'string' || label.nativeContent.length > LIMITS.nativeContent || !point(label.position)) { add('反应步骤标签无效'); continue; }
        const graphKeys = ['token', 'kind', 'side', 'at', 'anchorRefs', 'layoutX', 'layoutY', 'anchorDx', 'anchorDy'];
        if (label.role !== 'graphPort') {
          if (graphKeys.some(key => Object.prototype.hasOwnProperty.call(label, key)) ||
              (['previousRow', 'nextRow'].includes(label.role) && (!tokenText(label.text) || !normalize(label.text).startsWith('续')))) add('续行标签无效');
          else if (['previousRow', 'nextRow'].includes(label.role)) {
            const key = normalize(label.text);
            if (!legacyPorts.has(key)) legacyPorts.set(key, []);
            legacyPorts.get(key).push(label.role);
          }
          continue;
        }
        if (!tokenText(label.token) || label.text !== label.token || !['wrap', 'branch', 'merge', 'reuse'].includes(label.kind) ||
            !['source', 'target'].includes(label.side) || !['molecule', 'port'].includes(label.at) ||
            !uniqueIds(label.anchorRefs, 32) || !finite(label.layoutX) || !finite(label.layoutY) ||
            (label.at === 'molecule' && (!finite(label.anchorDx) || !finite(label.anchorDy))) ||
            (label.anchorDx !== undefined && !finite(label.anchorDx)) || (label.anchorDy !== undefined && !finite(label.anchorDy)) ||
            (label.kind === 'wrap' ? !normalize(label.token).startsWith('续') : !normalize(label.token).startsWith('接B'))) {
          add('反应步骤引用端口无效'); continue;
        }
        const key = normalize(label.token);
        if (!ports.has(key)) ports.set(key, []);
        ports.get(key).push(label);
      }
    }
    for (const group of ports.values()) {
      if (group.length !== 2 || group[0].kind !== group[1].kind || group[0].at === group[1].at || !sameSet(group[0].anchorRefs, group[1].anchorRefs))
        add('复制需包含完整续接/引用端口');
    }
    for (const group of legacyPorts.values()) {
      if (group.length !== 2 || group.filter(role => role === 'previousRow').length !== 1 || group.filter(role => role === 'nextRow').length !== 1)
        add('复制需包含完整续接/引用端口');
    }
    return { ok: errors.length === 0, errors };
  }
  function plan(data, options) {
    try {
      const checked = validate(data);
      if (!checked.ok) throw new Error(checked.errors.join('；'));
      const o = options || {}, { atomMap, transform, scale, rotation, usedTokens, newId } = o;
      if (!(atomMap instanceof Map) || typeof transform !== 'function' || !finite(scale) || scale <= 0 || !finite(rotation) ||
          !(usedTokens instanceof Set) || usedTokens.size > 100000 || [...usedTokens].some(t => typeof t !== 'string' || t.length > 160) || typeof newId !== 'function') throw new Error('反应步骤复制参数无效');
      const transformPoint = p => {
        const v = transform({ x: p.x, y: p.y });
        if (!v || !finite(v.x) || !finite(v.y)) throw new Error('反应步骤变换后坐标无效');
        return { x: v.x, y: v.y };
      };
      const origin = transformPoint({ x: 0, y: 0 }), ux = transformPoint({ x: 1, y: 0 }), uy = transformPoint({ x: 0, y: 1 });
      const c = Math.cos(rotation) * scale, s = Math.sin(rotation) * scale, eps = 1e-7 * Math.max(1, scale);
      if (Math.abs(ux.x - origin.x - c) > eps || Math.abs(ux.y - origin.y - s) > eps ||
          Math.abs(uy.x - origin.x + s) > eps || Math.abs(uy.y - origin.y - c) > eps) throw new Error('反应步骤变换与比例/旋转不一致');
      const mapAtom = source => {
        const mapped = atomMap.get(source);
        if (!id(mapped)) throw new Error('反应步骤参与者或锚点缺少新原子映射');
        return mapped;
      };
      const refs = new Set();
      for (const step of data.steps) {
        for (const a of [...step.reactants, ...step.products]) refs.add(a);
        for (const a of step.flow?.anchors || []) refs.add(a.atomId);
        for (const label of step.labels) for (const a of label.anchorRefs || []) refs.add(a);
      }
      const mappedRefs = [...refs].map(mapAtom);
      if (new Set(mappedRefs).size !== mappedRefs.length) throw new Error('多个源原子映射到同一目标原子');
      const generated = new Set(), oldIds = new Set(data.steps.flatMap(step => [step.stepId, step.flow?.routeId, step.flow?.laneId].filter(Boolean)));
      function fresh(prefix) {
        const value = newId(prefix);
        if (!id(value) || oldIds.has(value) || generated.has(value)) throw new Error('复制生成的步骤或路线 ID 无效或重复');
        generated.add(value); return value;
      }
      const sourceTokens = new Map();
      const addToken = token => { const key = normalize(token); if (!sourceTokens.has(key)) sourceTokens.set(key, token); };
      for (const step of data.steps) {
        for (const label of step.labels) if (label.role === 'graphPort') addToken(label.token); else if (['previousRow', 'nextRow'].includes(label.role)) addToken(label.text);
        if (step.flow?.continuation !== undefined) addToken('续 ' + step.flow.continuation);
      }
      const existing = new Set([...usedTokens].map(normalize)), reserved = new Set([...existing, ...sourceTokens.keys()]), tokenMap = new Map();
      for (const [key, original] of sourceTokens) {
        let result = original;
        if (existing.has(key)) {
          const prefix = key.startsWith('续') ? '续 ' : '接 B';
          let n = 1; while (reserved.has(normalize(prefix + n))) { n++; if (n > 200000) throw new Error('续接标号已用尽'); }
          result = prefix + n;
        }
        reserved.add(normalize(result)); tokenMap.set(key, result);
      }
      const routes = new Map(), lanes = new Map();
      const mappedNamespace = (table, key, prefix) => { if (!table.has(key)) table.set(key, fresh(prefix)); return table.get(key); };
      const noRotation = Math.abs(Math.atan2(Math.sin(rotation), Math.cos(rotation))) <= 1e-7;
      const result = data.steps.map(step => {
        const labels = step.labels.map(label => {
          const desiredText = label.role === 'graphPort' ? tokenMap.get(normalize(label.token)) :
            ['previousRow', 'nextRow'].includes(label.role) ? tokenMap.get(normalize(label.text)) : label.text;
          const next = { role: label.role, text: desiredText, desiredText, nativeContent: label.nativeContent, sourceContent: label.nativeContent,
            sourcePosition: copy(label.position), position: transformPoint(label.position) };
          if (label.role === 'graphPort') {
            const p = transformPoint({ x: label.layoutX, y: label.layoutY });
            Object.assign(next, { token: desiredText, kind: label.kind, side: label.side, at: label.at,
              anchorRefs: label.anchorRefs.map(mapAtom), layoutX: p.x, layoutY: p.y });
            if (label.anchorDx !== undefined || label.anchorDy !== undefined) {
              if (!noRotation && (label.anchorDx === undefined || label.anchorDy === undefined)) throw new Error('旋转的端口相对坐标不完整');
              const delta = transformPoint({ x: label.anchorDx ?? 0, y: label.anchorDy ?? 0 });
              if (label.anchorDx !== undefined) next.anchorDx = delta.x - origin.x;
              if (label.anchorDy !== undefined) next.anchorDy = delta.y - origin.y;
              if ((next.anchorDx !== undefined && !finite(next.anchorDx)) || (next.anchorDy !== undefined && !finite(next.anchorDy))) throw new Error('端口相对坐标超出范围');
            }
          }
          return next;
        });
        const output = { sourceStepId: step.stepId, stepId: fresh('rs'), version: 1,
          reactants: step.reactants.map(mapAtom), products: step.products.map(mapAtom),
          ...(step.layout !== undefined && { layout: copy(step.layout) }), ...(step.conditions !== undefined && { conditions: step.conditions }),
          sourceArrow: copy(step.arrow), arrow: { mode: step.arrow.mode, start: transformPoint(step.arrow.start), end: transformPoint(step.arrow.end) }, labels };
        if (step.flow && noRotation) {
          const flow = copy(step.flow);
          for (const key of xKeys) if (flow[key] !== undefined) flow[key] = transformPoint({ x: flow[key], y: 0 }).x;
          for (const key of yKeys) if (flow[key] !== undefined) flow[key] = transformPoint({ x: 0, y: flow[key] }).y;
          if (flow.rowWidth !== undefined) flow.rowWidth *= scale;
          if (flow.continuation !== undefined) {
            const mapped = tokenMap.get(normalize('续 ' + flow.continuation));
            flow.continuation = Number(normalize(mapped).slice(1));
          }
          if (flow.routeId) flow.routeId = mappedNamespace(routes, flow.routeId, 'route');
          if (flow.laneId) flow.laneId = mappedNamespace(lanes, flow.laneId, 'lane');
          if (flow.anchors) flow.anchors = flow.anchors.map(a => ({ atomId: mapAtom(a.atomId), ...transformPoint({ x: a.x, y: a.y }) }));
          if (flowNumbers.some(key => flow[key] !== undefined && !finite(flow[key]))) throw new Error('反应步骤流向变换超出范围');
          output.flow = flow;
        }
        return output;
      });
      return { ok: true, steps: result, tokenMap, allocatedTokens: [...tokenMap.values()] };
    } catch (error) { return { ok: false, error: error.message || String(error) }; }
  }
  MW.reactionStepClipboard = { LIMITS, validate, plan };
  if (typeof module === 'object' && module.exports) module.exports = MW.reactionStepClipboard;
})(typeof window === 'object' ? window : globalThis);
