/* MolStudio agent: bounded semantic commands over Ketcher's native actions.
 * Model parameters never execute JavaScript. Previews are a separate SVG UI
 * layer; only a validated, complete tool call can enter source/history.
 */
(function (root) {
  'use strict';
  const MAX_OPERATIONS = 40;
  const TYPES = new Set(['molecule.add', 'lonePair.add', 'arrow.add', 'reactionArrow.add', 'text.add',
    'reactionStep.create', 'reactionStep.modify', 'reactionStep.delete',
    'molecule.move', 'molecule.delete', 'hydrogen.makeExplicit',
    'atom.modify', 'atom.delete',
    'bond.add', 'bond.modify', 'bond.delete',
    'arrow.modify', 'arrow.delete',
    'lonePair.modify', 'lonePair.delete',
    'text.delete',
    'layout.tidy']);
  const DELETE_TYPES = new Set(['molecule.delete', 'atom.delete', 'bond.delete', 'arrow.delete', 'lonePair.delete', 'text.delete']);
  const MAX_TARGET_ATOMS = 200;
  const ELEMENT = /^[A-Z][a-z]?$/;
  const copy = value => JSON.parse(JSON.stringify(value));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const fail = (message, code = 'invalid_operation') => { const error = new Error(message); error.code = code; throw error; };
  function operationError(error, phase, op) {
    const failure = error && typeof error === 'object' ? error : new Error(String(error));
    failure.phase = phase;
    if (op) { failure.operationId = op.id; failure.operationType = op.type; }
    return failure;
  }
  const ref = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  function bondObservation(bond, record = {}) {
    const nativeType = bond?.type;
    if (!Number.isInteger(nativeType) || nativeType < 1 || nativeType > 10 ||
        (own(record, 'nativeType') && record.nativeType !== nativeType)) fail('结构键类型与原生片段不一致');
    const nativeOrder = nativeType === 4 ? 1.5 : [1, 2, 3].includes(nativeType) ? nativeType : null;
    if (own(record, 'order') && (!Number.isFinite(record.order) || record.order < 0 || record.order > 6 ||
        (nativeOrder !== null && record.order !== nativeOrder && !(record.order === 1.5 && [1, 2].includes(nativeType))))) {
      fail('结构键级与原生片段不一致');
    }
    // RDKit may describe an aromatic bond with order 1.5 while the native
    // depiction uses alternating single/double bonds. Preserve both facts.
    return { ...(own(record, 'order') || nativeOrder !== null ? { order: record.order ?? nativeOrder } : {}), nativeType };
  }
  /* 纸页实际尺寸缩放：把一条反应步骤记录的坐标类字段绕 anchor 缩放（纯数据，可单测）。
     whole=false 时原样返回克隆。字段语义与 translateStepRuntime 的平移完全镜像。 */
  function scaleStepRecord(record, options) {
    const { factor, anchor, whole } = options || {};
    const data = JSON.parse(JSON.stringify(record));
    if (!whole) return data;
    const px = value => anchor.x + (value - anchor.x) * factor;
    const py = value => anchor.y + (value - anchor.y) * factor;
    const point = p => ({ ...p, x: px(p.x), y: py(p.y) });
    data.start = point(data.start);
    data.end = point(data.end);
    if (data.flow) {
      for (const name of ['rowLeft', 'rowRight', 'arrowStartX', 'arrowEndX']) if (Number.isFinite(data.flow[name])) data.flow[name] = px(data.flow[name]);
      for (const name of ['rowY', 'rowBottom', 'sourceRowY', 'arrowStartY', 'arrowEndY']) if (Number.isFinite(data.flow[name])) data.flow[name] = py(data.flow[name]);
      if (Number.isFinite(data.flow.rowWidth)) data.flow.rowWidth *= factor;
      if (Array.isArray(data.flow.anchors)) data.flow.anchors = data.flow.anchors.map(point);
    }
    for (const label of data.labels || []) if (label.role === 'graphPort') {
      label.layoutX = px(label.layoutX);
      label.layoutY = py(label.layoutY);
      if (Number.isFinite(label.anchorDx)) label.anchorDx *= factor;
      if (Number.isFinite(label.anchorDy)) label.anchorDy *= factor;
    }
    return data;
  }
  function validateArrowAnchors(M, source, target, ctx, input = {}) {
    const start = M.endpointAnchor(source, ctx), end = M.endpointAnchor(target, ctx);
    const distance = M.dist(start, end);
    if (start.ok && end.ok && !(distance < 0.05)) return;
    // Preserve the semantic cause before routing or glyph clipping. In
    // particular, a single bond has no pi source even when its coordinates are
    // perfectly valid. Never replace an invalid pi source with sigma electrons.
    const describe = (endpoint, supplied, anchor) => {
      const result = { type: endpoint.type };
      if (!anchor.ok) result.reason = anchor.reason || 'missing';
      if (endpoint.type === 'bond') {
        const bond = ctx.bondInfo?.(endpoint.bondId);
        result.bondId = endpoint.bondId; result.component = endpoint.component;
        if (bond) { result.bondOrder = bond.type; result.atomIds = [bond.beginAtom, bond.endAtom].filter(ref); }
        if (supplied?.bondId) result.bondRef = supplied.bondId;
      } else if (endpoint.type === 'atom') result.atomIds = [endpoint.atomId];
      else if (endpoint.type === 'formingBond') result.atomIds = [endpoint.atomA, endpoint.atomB];
      else if (endpoint.type === 'lonePair') {
        result.lonePairId = endpoint.slotId; result.atomIds = [endpoint.ownerAtomId];
      }
      const atomRefs = [supplied?.atomId, supplied?.atom1, supplied?.atom2].filter(ref);
      if (atomRefs.length) result.atomRefs = atomRefs;
      return result;
    };
    const piUnavailable = !start.ok && start.reason === 'piUnavailable';
    const invalid = !start.ok || !end.ok;
    const message = piUnavailable ? '箭头来源键没有可用的 π 电子；请核对源键及当前键级，本批次已撤销。'
      : invalid ? '箭头' + (!start.ok ? '起点' : '终点') + '引用已失效；请重新读取画布后修正，本批次已撤销。'
        : '箭头起点与终点重合或过近；请核对语义端点，本批次已撤销。';
    throw Object.assign(new Error(message), {
      code: piUnavailable ? 'arrow_pi_unavailable' : invalid ? 'arrow_endpoint_invalid' : 'arrow_endpoints_overlap',
      field: piUnavailable ? 'source.component' : !start.ok ? 'source' : !end.ok ? 'target' : 'source',
      sourceEndpoint: describe(source, input.source, start), targetEndpoint: describe(target, input.target, end),
      ...(start.ok && end.ok && Number.isFinite(distance) && { endpointDistance: distance })
    });
  }
  const isStepOperation = op => op.type.startsWith('reactionStep.');
  const isStepDeclaration = op => op.type === 'reactionArrow.add' || op.type === 'reactionStep.create';
  function fields(value, allowed, where) {
    if (!plain(value)) fail(where + ' 必须是对象');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where + ' 不支持字段：' + key);
  }
  function endpoint(value, source) {
    if (!plain(value)) fail('箭头端点不完整');
    if (value.type === 'lonePair' && source) { fields(value, ['type', 'id'], '孤对端点'); if (!ref(value.id)) fail('孤对引用无效'); }
    else if (value.type === 'atom') { fields(value, ['type', 'atomId'], '原子端点'); if (!ref(value.atomId)) fail('原子引用无效'); }
    else if (value.type === 'bond' && source) {
      const byId = own(value, 'bondId'), byAtoms = own(value, 'atom1') || own(value, 'atom2');
      if (byId === byAtoms) fail('键端点需要 bondId 或 atom1/atom2');
      if (byId) { fields(value, ['type', 'bondId', 'component'], '键端点'); if (!ref(value.bondId)) fail('键引用无效'); }
      else { fields(value, ['type', 'atom1', 'atom2', 'component'], '键端点'); if (!ref(value.atom1) || !ref(value.atom2) || value.atom1 === value.atom2) fail('键端点需要两个不同原子'); }
      if (!['sigma', 'pi'].includes(value.component)) fail('键端点需要明确的 σ/π');
    }
    else if (value.type === 'formingBond' && !source) { fields(value, ['type', 'atom1', 'atom2'], '成键端点'); if (!ref(value.atom1) || !ref(value.atom2) || value.atom1 === value.atom2) fail('成键端点需要两个不同原子'); }
    else fail('不支持的箭头端点');
  }
  /* 编辑目标：{molecule: handle} 或 {atoms: [ref...]}，字段白名单，长度有界。 */
  function targetScope(value, where) {
    if (!plain(value)) fail(where + ' 必须是对象');
    if (own(value, 'molecule')) {
      fields(value, ['molecule'], where);
      if (!ref(value.molecule)) fail(where + '.molecule 引用无效');
    } else if (own(value, 'atoms')) {
      fields(value, ['atoms'], where);
      if (!Array.isArray(value.atoms) || !value.atoms.length || value.atoms.length > MAX_TARGET_ATOMS) fail(where + '.atoms 需要 1–' + MAX_TARGET_ATOMS + ' 个原子引用');
      for (const item of value.atoms) if (!ref(item)) fail(where + '.atoms 引用无效');
    } else fail(where + ' 需要 molecule 或 atoms 目标');
  }
  function validateOperations(input) {
    if (!Array.isArray(input) || input.length > MAX_OPERATIONS) fail('每次最多提交 40 个完整操作');
    const ids = new Set();
    for (const op of input) {
      if (!plain(op) || !ref(op.id) || !TYPES.has(op.type)) fail('操作需要有效 id 和支持的 type');
      if (ids.has(op.id)) fail('同一批中操作 id 重复：' + op.id);
      ids.add(op.id);
      if (op.type === 'molecule.add') {
        fields(op, ['id', 'type', 'smiles', 'x', 'y'], '分子操作');
        if (typeof op.smiles !== 'string' || !op.smiles.trim() || op.smiles.length > 4096 || /[\u0000-\u001f]/.test(op.smiles)) fail('需要完整的 SMILES');
      } else if (op.type === 'hydrogen.makeExplicit') {
        fields(op, ['id', 'type', 'parentAtomId'], '显式氢操作');
        if (!ref(op.parentAtomId)) fail('显式氢需要有效 parentAtomId');
      } else if (op.type === 'lonePair.add') {
        fields(op, ['id', 'type', 'atom', 'angle'], '孤对操作');
        if (!ref(op.atom) || (own(op, 'angle') && !finite(op.angle))) fail('孤对需要有效原子及有限角度');
      } else if (op.type === 'arrow.add') {
        fields(op, ['id', 'type', 'source', 'target', 'electronCount'], '箭头操作');
        if (op.electronCount !== 1 && op.electronCount !== 2) fail('电子数必须明确为 1 或 2');
        endpoint(op.source, true); endpoint(op.target, false);
      } else if (isStepDeclaration(op) || op.type === 'reactionStep.modify' || op.type === 'reactionStep.delete') {
        const modify = op.type === 'reactionStep.modify', remove = op.type === 'reactionStep.delete';
        fields(op, remove ? ['id', 'type', 'stepId', 'expectedVersion'] : modify
          ? ['id', 'type', 'stepId', 'expectedVersion', 'reactants', 'products', 'layout']
          : ['id', 'type', 'reactants', 'products', 'layout'], '反应步骤');
        if (modify || remove) {
          if (!ref(op.stepId) || !Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 1) fail('反应步骤需要稳定 stepId 和正整数 expectedVersion');
          if (modify && !['reactants', 'products', 'layout'].some(key => own(op, key))) fail('修改步骤需要至少一项变更');
        }
        for (const key of ['reactants', 'products']) {
          if ((modify || remove) && !own(op, key)) continue;
          const side = op[key];
          if (!Array.isArray(side) || side.length < 1 || side.length > 16 || new Set(side).size !== side.length || side.some(item => !ref(item))) {
            fail('反应箭头每侧需要 1–16 个有效且不重复的分子代表原子');
          }
        }
        if (op.reactants && op.products && op.reactants.some(atom => op.products.includes(atom))) fail('反应箭头两侧需要不同分子');
        if (own(op, 'layout')) {
          const { layout } = op;
          fields(layout, ['reactantPlacement', 'reagentPlacement', 'breakBefore', 'conditions'], '反应排布');
          if (own(layout, 'reactantPlacement') && !['auto', 'horizontal', 'vertical'].includes(layout.reactantPlacement)) fail('反应物排布需要 auto、horizontal 或 vertical');
          if (own(layout, 'reagentPlacement') && !['auto', 'left', 'right', 'above', 'below'].includes(layout.reagentPlacement)) fail('试剂停靠需要 auto、left、right、above 或 below');
          if (own(layout, 'breakBefore') && typeof layout.breakBefore !== 'boolean') fail('换行设置需要布尔值');
          if (own(layout, 'conditions') && (typeof layout.conditions !== 'string' || (!modify && !layout.conditions.trim()) || layout.conditions.length > 64 || /[\u0000-\u001f]/.test(layout.conditions))) fail('反应条件需要单行文字');
        }
      } else if (op.type === 'text.add') {
        fields(op, ['id', 'type', 'text', 'x', 'y'], '文字操作');
        if (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.text)) fail('文字内容无效或过长');
      } else if (op.type === 'molecule.move') {
        fields(op, ['id', 'type', 'target', 'x', 'y', 'dx', 'dy', 'orientTowardAtomId'], '移动操作');
        targetScope(op.target, 'molecule.move.target');
        const absolute = own(op, 'x') || own(op, 'y'), relative = own(op, 'dx') || own(op, 'dy');
        const orient = own(op, 'orientTowardAtomId');
        if (orient) {
          if (!ref(op.orientTowardAtomId)) fail('orientTowardAtomId 需要原子引用');
          if (absolute || relative) fail('orientTowardAtomId 不能同时指定 x/y/dx/dy');
          if (!op.target.atoms || op.target.atoms.length !== 1) fail('orientTowardAtomId 只支持 target.atoms 中一个已有末端 H');
        } else if (absolute === relative) fail('molecule.move 需要 x/y（绝对中心）或 dx/dy（相对位移）二者其一');
        if (absolute && (!own(op, 'x') || !own(op, 'y'))) fail('molecule.move 绝对定位需要 x 和 y');
        if (relative && (!own(op, 'dx') || !own(op, 'dy'))) fail('molecule.move 相对位移需要 dx 和 dy');
      } else if (op.type === 'molecule.delete') {
        fields(op, ['id', 'type', 'target'], '删除分子操作');
        targetScope(op.target, 'molecule.delete.target');
      } else if (op.type === 'atom.modify') {
        fields(op, ['id', 'type', 'atomId', 'label', 'charge', 'isotope', 'radical'], '修改原子操作');
        if (!ref(op.atomId)) fail('atom.modify.atomId 引用无效');
        if (!own(op, 'label') && !own(op, 'charge') && !own(op, 'isotope') && !own(op, 'radical')) fail('atom.modify 需要 label/charge/isotope/radical 至少一项');
        if (own(op, 'label') && (typeof op.label !== 'string' || !ELEMENT.test(op.label))) fail('atom.modify.label 需要元素符号');
        if (own(op, 'charge') && (!Number.isInteger(op.charge) || Math.abs(op.charge) > 6)) fail('atom.modify.charge 需要整数且绝对值 ≤ 6');
        if (own(op, 'isotope') && (!Number.isInteger(op.isotope) || op.isotope < 0 || op.isotope > 254)) fail('atom.modify.isotope 需要非负整数');
        if (own(op, 'radical') && (!Number.isInteger(op.radical) || op.radical < 0 || op.radical > 3)) fail('atom.modify.radical 需要 0 到 3 之间的整数');
      } else if (op.type === 'atom.delete') {
        fields(op, ['id', 'type', 'atomId'], '删除原子操作');
        if (!ref(op.atomId)) fail('atom.delete.atomId 引用无效');
      } else if (op.type === 'bond.add') {
        fields(op, ['id', 'type', 'begin', 'end', 'order'], '添加键操作');
        if (!ref(op.begin) || !ref(op.end) || op.begin === op.end) fail('bond.add 需要两个不同的原子引用');
        if (own(op, 'order') && ![1, 2, 3].includes(op.order)) fail('bond.add.order 只支持 1/2/3');
      } else if (op.type === 'bond.modify') {
        fields(op, ['id', 'type', 'bondId', 'order'], '修改键操作');
        if (!ref(op.bondId)) fail('bond.modify.bondId 引用无效');
        if (!own(op, 'order') || ![1, 2, 3].includes(op.order)) fail('bond.modify.order 只支持 1/2/3');
      } else if (op.type === 'bond.delete') {
        fields(op, ['id', 'type', 'bondId'], '删除键操作');
        if (!ref(op.bondId)) fail('bond.delete.bondId 引用无效');
      } else if (op.type === 'arrow.modify') {
        fields(op, ['id', 'type', 'arrowId', 'source', 'target', 'electronCount', 'bend', 'mode'], '修改箭头操作');
        if (!ref(op.arrowId)) fail('arrow.modify.arrowId 引用无效');
        if (!own(op, 'source') && !own(op, 'target') && !own(op, 'electronCount') && !own(op, 'bend') && !own(op, 'mode')) fail('arrow.modify 需要至少一项修改');
        if (own(op, 'source')) endpoint(op.source, true);
        if (own(op, 'target')) endpoint(op.target, false);
        if (own(op, 'electronCount') && op.electronCount !== 1 && op.electronCount !== 2) fail('电子数必须是 1 或 2');
        if (own(op, 'bend') && !finite(op.bend)) fail('arrow.modify.bend 必须是有限曲率');
        if (own(op, 'mode') && op.mode !== 'auto' && op.mode !== 'manual') fail('arrow.modify.mode 只支持 auto/manual');
        if (own(op, 'mode') && op.mode === 'manual' && !own(op, 'bend') && !own(op, 'source') && !own(op, 'target') && !own(op, 'electronCount')) fail('手动模式至少要给出 bend 或端点/电子数');
      } else if (op.type === 'arrow.delete') {
        fields(op, ['id', 'type', 'arrowId'], '删除箭头操作');
        if (!ref(op.arrowId)) fail('arrow.delete.arrowId 引用无效');
      } else if (op.type === 'lonePair.modify') {
        fields(op, ['id', 'type', 'lonePairId', 'angle', 'aim'], '修改孤对操作');
        if (!ref(op.lonePairId)) fail('lonePair.modify.lonePairId 引用无效');
        if (own(op, 'aim') && !['auto', 'manual'].includes(op.aim)) fail('lonePair.modify.aim 只支持 auto/manual');
        if (op.aim === 'auto' && own(op, 'angle')) fail('自动瞄准不能同时指定 angle');
        if (!own(op, 'aim') && !own(op, 'angle') || own(op, 'angle') && !finite(op.angle)) fail('lonePair.modify 需要 aim 或有限角度');
      } else if (op.type === 'lonePair.delete') {
        fields(op, ['id', 'type', 'lonePairId'], '删除孤对操作');
        if (!ref(op.lonePairId)) fail('lonePair.delete.lonePairId 引用无效');
      } else if (op.type === 'text.delete') {
        fields(op, ['id', 'type', 'textId'], '删除文字操作');
        if (!ref(op.textId)) fail('text.delete.textId 引用无效');
      } else if (op.type === 'layout.tidy') {
        fields(op, ['id', 'type'], '整理操作');
      }
      if (own(op, 'x') && !finite(op.x) || own(op, 'y') && !finite(op.y)) fail('坐标必须是有限模型坐标');
      if (own(op, 'dx') && !finite(op.dx) || own(op, 'dy') && !finite(op.dy)) fail('位移必须是有限模型坐标');
      if (own(op, 'bend') && Math.abs(op.bend) > 3) fail('曲率超出范围');
    }
    if (JSON.stringify(input).length > 100000) fail('操作数据过大');
    return copy(input);
  }
  /* 批内依赖排序：op 引用批内另一个 op 的别名 ⇒ 必须排在其后。
     拒绝环与自引用；无依赖时保持输入顺序（确定性，不按类型重排）。 */
  function dependencyOrder(ops) {
    const ids = new Set(ops.map(op => op.id));
    const deps = new Map();
    // Only fields interpreted as references participate. Literal SMILES, text,
    // element labels, modes and operation type names may equal operation IDs.
    const endpointRefs = value => value ? ['id', 'atomId', 'bondId', 'atom1', 'atom2']
      .filter(key => own(value, key)).map(key => value[key]) : [];
    const referenceFields = {
      'lonePair.add': ['atom'], 'atom.modify': ['atomId'], 'atom.delete': ['atomId'],
      'hydrogen.makeExplicit': ['parentAtomId'],
      'bond.add': ['begin', 'end'], 'bond.modify': ['bondId'], 'bond.delete': ['bondId'],
      'arrow.modify': ['arrowId'], 'arrow.delete': ['arrowId'],
      'lonePair.modify': ['lonePairId'], 'lonePair.delete': ['lonePairId'], 'text.delete': ['textId']
    };
    const dependency = value => {
      if (ids.has(value)) return value;
      // Aliases themselves may contain colons. Prefer the longest complete ID
      // before the atom/bond suffix, matching the resolver's exact-alias rule.
      return [...ids].filter(id => value.startsWith(id + ':')).sort((a, b) => b.length - a.length)[0];
    };
    for (const op of ops) {
      const refs = (referenceFields[op.type] || []).map(key => op[key]);
      if (op.type === 'arrow.add' || op.type === 'arrow.modify') refs.push(...endpointRefs(op.source), ...endpointRefs(op.target));
      if (isStepDeclaration(op) || op.type === 'reactionStep.modify') refs.push(...(op.reactants || []), ...(op.products || []));
      if (op.type === 'molecule.move' || op.type === 'molecule.delete') refs.push(...(op.target.atoms || []));
      if (op.type === 'molecule.move' && own(op, 'orientTowardAtomId')) refs.push(op.orientTowardAtomId);
      const list = [...new Set(refs.map(dependency).filter(Boolean))];
      if ((op.type === 'reactionStep.modify' || op.type === 'reactionStep.delete') &&
          ops.some(candidate => isStepDeclaration(candidate) && candidate.id === op.stepId)) list.push(op.stepId);
      if (list.includes(op.id)) fail('操作不能引用自身：' + op.id, 'ambiguous_batch');
      deps.set(op.id, list);
    }
    const byId = new Map(ops.map(op => [op.id, op]));
    const ordered = [], done = new Set(), inProgress = new Set();
    const visit = op => {
      if (done.has(op.id)) return;
      if (inProgress.has(op.id)) fail('操作引用形成环：' + op.id, 'ambiguous_batch');
      inProgress.add(op.id);
      for (const dep of deps.get(op.id) || []) {
        const target = byId.get(dep);
        if (target) visit(target);
      }
      inProgress.delete(op.id);
      done.add(op.id);
      ordered.push(op);
    };
    for (const op of ops) visit(op);
    return ordered;
  }
  function abort(signal) { if (signal && signal.aborted) fail('绘图已停止', 'aborted'); }
  function resolveLonePairAimTarget(lp, arrows, ctx) {
    const sources = arrows.filter(arrow => arrow.source?.type === 'lonePair' && arrow.source.slotId === lp.id);
    if (!sources.length) fail('孤对没有已有进攻箭头，无法自动确定目标；请先创建箭头或显式指定 angle', 'lone_pair_aim_target_missing');
    const targets = new Set();
    for (const arrow of sources) {
      const target = arrow.target || {};
      const ids = target.type === 'atom' ? [target.atomId] : target.type === 'formingBond' ? [target.atomA, target.atomB] : [];
      const attacked = [...new Set(ids.filter(id => id && id !== lp.ownerAtomId && ctx.atomPos(id)))];
      if (!attacked.length) fail('已有箭头缺少有效的受攻原子，无法自动瞄准孤对', 'lone_pair_aim_target_missing');
      if (attacked.length !== 1) fail('已有箭头的受攻原子不唯一，请修改箭头目标或显式指定 angle', 'lone_pair_aim_target_conflict');
      targets.add(attacked[0]);
    }
    if (targets.size !== 1) fail('该孤对的已有箭头指向不同原子，请明确箭头目标或显式指定 angle', 'lone_pair_aim_target_conflict');
    return sources[0];
  }
  function orientTerminalHydrogen(input) {
    const atoms = new Map(input.atoms.map(atom => [atom.id, atom])), h = atoms.get(input.hydrogenId), toward = atoms.get(input.towardAtomId);
    if (!h || !toward) fail('氢定向引用的原子不存在', 'missing_reference');
    const bonds = input.bonds.filter(bond => bond.begin === h.id || bond.end === h.id);
    if (h.label !== 'H' || h.charge || h.radical || h.isotope || h.hasQuery || h.alias || bonds.length !== 1 ||
        bonds[0].order !== 1 || bonds[0].aromatic) fail('定向只支持已有普通末端 H 及其唯一单键', 'hydrogen_orientation_unsupported');
    const parentId = bonds[0].begin === h.id ? bonds[0].end : bonds[0].begin, parent = atoms.get(parentId);
    if (!parent) fail('氢的母原子不存在', 'missing_reference');
    const stereo = atom => atom.stereoLabel || atom.stereoParity || atom.stereoGroup || atom.enhancedStereo;
    const enhanced = new Set(input.stereoAtomIds || []);
    if (stereo(h) || stereo(parent) || enhanced.has(h.id) || enhanced.has(parent.id) || input.bonds.some(bond =>
      (bond.begin === h.id || bond.end === h.id || bond.begin === parent.id || bond.end === parent.id) && bond.stereo)) {
      fail('氢或母原子涉及已定义立体化学，不能自动定向', 'hydrogen_orientation_stereo');
    }
    if (!['O', 'N'].includes(parent.label) || parent.hasQuery || parent.alias) fail('氢定向目前只支持非立体 O/N 母原子', 'hydrogen_orientation_unsupported');
    if (toward.id === h.id || toward.id === parent.id) fail('定向目标不能是该 H 或其母原子', 'hydrogen_orientation_target_invalid');
    if (![h.x, h.y, parent.x, parent.y, toward.x, toward.y].every(finite)) fail('氢定向坐标无效', 'hydrogen_orientation_geometry_invalid');
    const length = Math.hypot(h.x - parent.x, h.y - parent.y), distance = Math.hypot(toward.x - parent.x, toward.y - parent.y);
    if (length < 1e-8) fail('原 H–母原子键长无效', 'hydrogen_orientation_geometry_invalid');
    if (distance < 1e-8) fail('定向目标与母原子重合', 'hydrogen_orientation_target_invalid');
    const from = { x: h.x, y: h.y }, to = { x: parent.x + (toward.x - parent.x) * length / distance,
      y: parent.y + (toward.y - parent.y) * length / distance };
    if (![to.x, to.y].every(finite)) fail('氢定向结果超出坐标范围', 'hydrogen_orientation_geometry_invalid');
    return { atomId: h.id, parentAtomId: parent.id, towardAtomId: toward.id, from, to,
      bondLengthBefore: length, bondLengthAfter: Math.hypot(to.x - parent.x, to.y - parent.y),
      displacement: { dx: to.x - from.x, dy: to.y - from.y } };
  }
  function makeExplicitHydrogenPlan(input) {
    const parent = input.atoms.find(atom => atom.id === input.parentAtomId);
    if (!parent) fail('显式氢的母原子不存在', 'missing_reference');
    if (!['C', 'N', 'O'].includes(parent.label) || parent.hasQuery || parent.alias || parent.aromatic || parent.radical) {
      fail('显式氢只支持普通非芳香 C/N/O 母原子', 'hydrogen_explicit_unsupported');
    }
    if (parent.stereoLabel || parent.stereoParity || parent.stereoGroup || parent.enhancedStereo ||
        (input.stereoAtomIds || []).includes(parent.id) || input.bonds.some(bond =>
          (bond.begin === parent.id || bond.end === parent.id) && bond.stereo)) {
      fail('母原子涉及已定义立体化学，不能自动显氢', 'hydrogen_explicit_stereo');
    }
    const count = parent.implicitH;
    if (!Number.isInteger(count) || count < 1) fail('该原子没有可显式化的隐氢', 'hydrogen_explicit_none');
    const total = input.atoms.reduce((sum, atom) => sum + (atom.label === 'H' ? 1 : 0) + (Number(atom.implicitH) || 0), 0);
    return { parentAtomId: parent.id, implicitBefore: count, implicitAfter: count - 1,
      implicitHCountBefore: parent.implicitHCount ?? null, hydrogenTotalBefore: total, hydrogenTotalAfter: total };
  }
  function resolveMoleculeHandle(handle, membersByHandle, components) {
    const members = membersByHandle.get(handle);
    if (!members) fail('分子句柄不存在或已变化，请重新 read_canvas：' + handle, 'missing_reference');
    // Labels such as mol:2 belong to the batch's input canvas. Earlier deletes
    // can renumber components; resolve the saved stable members, never the label.
    const expected = members.slice().sort();
    const found = components.find(part => part.uuids.length === expected.length &&
      part.uuids.slice().sort().every((uuid, i) => uuid === expected[i]));
    if (!found) fail('分子成员已变化，请重新 read_canvas：' + handle, 'missing_reference');
    return { ...found, handle };
  }
  function revisionSource(value) {
    if (Array.isArray(value)) return value.map(revisionSource);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const key of Object.keys(value)) if (key !== 'selected' && key !== 'initiallySelected') {
      if (value.type === 'text' && key === 'boundingBox' && plain(value[key])) {
        // KET text width/height are renderer measurements, unlike its authored
        // anchor x/y and rich-text paragraphs. Repainting after a rollback or
        // zoom may change those measurements without editing the document.
        result[key] = Object.fromEntries(Object.entries(value[key]).filter(([field]) => field !== 'width' && field !== 'height')
          .map(([field, item]) => [field, revisionSource(item)]));
      } else result[key] = revisionSource(value[key]);
    }
    return result;
  }
  function automaticViewportPlan({ zoom, view, bounds, readingBounds = bounds, focusBounds = bounds, minimumZoom }) {
    const size = box => box && ({ width: box.x2 - box.x1, height: box.y2 - box.y1 });
    const visible = size(view), content = size(bounds), reading = size(readingBounds);
    if (!(zoom > 0) || !visible || !content || !reading ||
        ![visible.width, visible.height, content.width, content.height, reading.width, reading.height].every(n => Number.isFinite(n) && n > 0)) return null;
    const fitted = box => zoom * Math.min(visible.width / (box.width + 1.6), visible.height / (box.height + 1.6));
    const readable = Number.isFinite(minimumZoom) && minimumZoom >= 0.2 && minimumZoom <= 4 && fitted(reading) < minimumZoom;
    return { zoom: readable ? minimumZoom : Math.max(0.2, Math.min(zoom, fitted(content))),
      bounds: readable ? focusBounds : bounds, reading: readable };
  }
  function restorePoolOrder(struct, order) {
    for (const [key, ids] of order || []) {
      const pool = struct[key];
      if (pool.size !== ids.length || ids.some(id => !pool.has(id))) continue;
      const entries = ids.map(id => [id, pool.get(id)]);
      pool.clear();
      for (const [id, item] of entries) pool.set(id, item);
    }
  }
  function inverseGroup(actions, afterPerform, order) {
    return {
      operations: actions.flatMap(action => action.operations || []),
      isDummy: () => false,
      perform(ctab) {
        const completed = [], nextOrder = order?.map(([key]) => [key, [...ctab.molecule[key].keys()]]);
        try { for (let i = actions.length - 1; i >= 0; i--) completed.push(actions[i].perform(ctab)); }
        catch (error) {
          for (let i = completed.length - 1; i >= 0; i--) completed[i].perform(ctab);
          throw error;
        }
        if (order) restorePoolOrder(ctab.molecule, order);
        if (afterPerform) afterPerform();
        return inverseGroup(completed, afterPerform, nextOrder);
      }
    };
  }
  /* 布局距离使用模型坐标（键长约 1），独立于缩放。 */
  const LAYOUT = Object.freeze({
    reactionGap: 1.5,
    groupGap: 0.20,
    stepGap: 1.85,
    arrowLength: 1.45,
    rowSteps: 5,
    readingRowWidth: 37,
    independentRowWidth: 76,
    readingRowGap: 2.3,
    continuationLane: 2.9,
    labelPad: 0.45,
    minReactionGap: 1.1,
    maxReactionGap: 2.6,
    searchRings: 48,
    searchRingStep: 1.0
  });
  function fragmentBounds(fragment) {
    const atoms = Array.from(fragment.atoms.values());
    if (!atoms.length) return { width: 1, height: 1, center: { x: 0, y: 0 } };
    const xs = atoms.map(atom => atom.pp.x), ys = atoms.map(atom => atom.pp.y);
    return {
      width: Math.max(...xs) - Math.min(...xs) + 2 * LAYOUT.labelPad,
      height: Math.max(...ys) - Math.min(...ys) + 2 * LAYOUT.labelPad,
      center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    };
  }
  function reactionStages(connectors, owners) {
    if (!connectors.length) return [];
    const edges = [], known = new Set();
    const stage = refs => [...new Set(refs.map(ref => owners.get(ref)))];
    for (const arrow of connectors) {
      const from = stage(arrow.reactants), to = stage(arrow.products);
      if ([...from, ...to].includes(undefined) || from.some(id => to.includes(id))) return [];
      const key = canonical([from.slice().sort(), to.slice().sort()]);
      if (!known.has(key)) edges.push({ from, to });
      known.add(key);
    }
    const next = new Map(), incoming = new Set();
    for (const edge of edges) {
      const successors = edges.filter(candidate => candidate !== edge && candidate.from.some(id => edge.to.includes(id)));
      if (successors.length > 1 || (successors.length && incoming.has(successors[0]))) return [];
      if (successors.length) { next.set(edge, successors[0]); incoming.add(successors[0]); }
    }
    const starts = edges.filter(edge => !incoming.has(edge));
    if (starts.length !== 1) return [];
    const ordered = [starts[0].from], visited = new Set();
    for (let edge = starts[0]; edge && !visited.has(edge); edge = next.get(edge)) {
      visited.add(edge);
      ordered.push([...new Set([...edge.to, ...(next.get(edge)?.from || [])])]);
    }
    const all = ordered.flat();
    return visited.size === edges.length && new Set(all).size === all.length ? ordered : [];
  }
  function orderByAnchors(group, links, sizes, axis, gap) {
    const members = new Set(group);
    const local = links.filter(([from, to]) => members.has(from.id) && members.has(to.id));
    if (!local.length) return group;
    const dimension = axis === 'x' ? 'width' : 'height';
    const score = order => {
      const shifts = new Map();
      let cursor = 0;
      for (const id of order) {
        const size = sizes.get(id);
        shifts.set(id, cursor + size[dimension] / 2 - size.center[axis]);
        cursor += size[dimension] + gap;
      }
      return local.reduce((sum, [from, to]) => sum + Math.abs(
        from.point[axis] + shifts.get(from.id) - to.point[axis] - shifts.get(to.id)), 0);
    };
    let order = group, cost = score(group);
    // Deterministic, bounded insertion search. Keep the original order on ties.
    for (let pass = 0; pass < 3; pass++) {
      let best = order;
      for (let i = 0; i < order.length; i++) {
        for (let j = 0; j < order.length; j++) {
          if (i === j) continue;
          const candidate = order.slice();
          candidate.splice(j, 0, candidate.splice(i, 1)[0]);
          const candidateCost = score(candidate);
          if (candidateCost < cost - 1e-6) { best = candidate; cost = candidateCost; }
        }
      }
      if (best === order) break;
      order = best;
    }
    return order;
  }
  function createBridge(app, options = {}) {
    const MW = root.MolWorkbench, M = MW.model, a = app.adapter, ed = a.ed, model = app.model, controller = app.controller;
    const doc = a.doc, native = options.native || doc.defaultView.molstudioNativeActions;
    if (!native || native.version !== 1) fail('当前 Ketcher 缺少受支持的 Agent action bridge', 'bridge_unavailable');
    const uid = () => root.crypto.randomUUID();
    let sessionId = uid(), revision = 0, signature = null, writeDepth = 0, pendingScan = null, tail = Promise.resolve(), currentRun = null, disposed = false;
    let replacement = null, workbenchLoadDepth = 0, taskCheckpoint = null, taskCheckpointOwner = null;
    let reactionGlyphOffsets = new Map();
    const runs = new Map(), cache = new Map(), reactionConnectors = new Map(), stepOperations = new Map();
    function documentState() { return app.documentController?.active ? app.documentController.state : null; }
    function documentSignature() {
      const state = documentState();
      return state && { ...state, assets: Object.fromEntries(Object.entries(state.assets).map(([id, asset]) =>
        [id, { mime: asset.mime, bytes: asset.data.length }])) };
    }
    function documentSnapshot() {
      const state = documentState();
      if (!state) return null;
      return { mode: state.mode, page: state.page, ptPerBond: state.ptPerBond,
        pages: MW.documentModel.pageRects(state), regions: state.regions,
        objects: state.objects.map(object => ({ id: object.id, kind: object.kind, x: object.x, y: object.y,
          w: object.w, h: object.h, rotation: object.rotation || 0,
          ...(object.pageId && { pageId: object.pageId }), ...(object.kind === 'text' && { text: object.rich.text }) })) };
    }
    function paperTarget() {
      const state = documentState();
      if (state?.mode !== 'paper') return null;
      const pages = MW.documentModel.pageRects(state), active = app.documentController.getActivePage?.();
      return pages.find(page => page.id === (typeof active === 'string' ? active : active?.id)) || pages[0];
    }
    function paperBounds() {
      const rect = paperTarget()?.content;
      return rect && { x1: rect.x, y1: rect.y, x2: rect.x + rect.w, y2: rect.y + rect.h };
    }
    function readingWidth(fallback = LAYOUT.readingRowWidth) { return paperTarget()?.content.w ?? fallback; }
    function refreshReactionGlyphs() {
      const offsets = new Map();
      for (const [rid] of ed.struct().atoms) {
        const id = a.uuidOfAtom(rid), point = a.atomPos(rid), rect = id && a.atomLabelBox?.(id)?.rect;
        if (!point || !rect || ![rect.x1, rect.x2, rect.y1, rect.y2].every(Number.isFinite)) continue;
        offsets.set(id, { x1: rect.x1 - point.x, x2: rect.x2 - point.x, y1: rect.y1 - point.y, y2: rect.y2 - point.y });
      }
      reactionGlyphOffsets = offsets;
    }
    function signatureNow() { const ket = JSON.parse(native.serialize(ed.struct())); return canonical({ ket: revisionSource(ket), mechanism: M.serializeMechanism(model.state), reactionSteps: exportReactionSteps(ket), reactionStepOperations: [...stepOperations.values()], ...(documentState() && { document: documentSignature() }) }); }
    function event(source, reason) {
      if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent('molstudio:agent-canvas-change', { detail: { sessionId, revision, source, reason } }));
    }
    function clearPreview(runId) {
      const run = runs.get(runId); if (!run) return;
      run.previewVersion++; run.previewAbort?.abort(); run.previewAbort = null;
      run.preview?.remove(); run.preview = null;
    }
    function invalidate(run, reason) { if (!run || run.state !== 'active') return; run.state = 'invalid'; run.reason = reason; clearPreview(run.id); }
    function scan(source = pendingScan?.source || 'unknown', reason = pendingScan?.reason || 'unattributed') {
      // PasteTool temporarily adds its moving preview to the native Struct.
      // It is not authored content until commit and must not consume a revision.
      if (disposed || writeDepth || replacement || nativePasteInProgress()) return;
      const next = signatureNow();
      if (signature === null) { signature = next; return; }
      if (next === signature) return;
      signature = next; revision++;
      if (source !== 'agent') for (const run of runs.values()) {
        invalidate(run, source === 'manual' ? '画布已被手动修改' : '画布状态已变化，请核对当前内容');
      }
      event(source, reason);
    }
    function scheduleScan(source = 'unknown', reason = 'unattributed') {
      if (disposed || writeDepth || replacement) return;
      if (pendingScan) {
        if (source === 'manual') pendingScan = { source, reason };
        return;
      }
      pendingScan = { source, reason };
      Promise.resolve().then(() => {
        const next = pendingScan;
        pendingScan = null;
        try { scan(next.source, next.reason); } catch (_) { /* loading may temporarily replace the Struct */ }
      });
    }
    function replaceSession(reason) {
      for (const run of runs.values()) invalidate(run, '工作台会话已替换');
      sessionId = uid(); revision = 0; signature = null; currentRun = null; taskCheckpointOwner = null; cache.clear(); if (reason !== 'load') { reactionConnectors.clear(); stepOperations.clear(); taskCheckpoint = null; }
      event('manual', reason);
    }
    function duringReplacement(reason, replace) {
      if (!replacement) {
        let resolve;
        const settled = new Promise(done => { resolve = done; });
        replacement = { count: 0, settled, resolve };
      }
      const pending = replacement;
      pending.count++;
      const settle = () => {
        if (--pending.count) return;
        try { if (!disposed) signature = signatureNow(); }
        catch (_) { signature = null; } // A failed load can temporarily leave no Struct.
        replacement = null;
        pending.resolve();
      };
      try {
        if (reason) replaceSession(reason);
        const value = replace();
        if (value && typeof value.then === 'function') return Promise.resolve(value).finally(settle);
        settle();
        return value;
      } catch (error) {
        settle();
        throw error;
      }
    }
    function withSettledCanvas(action, signal) {
      abort(signal);
      if (replacement) return replacement.settled.then(() => withSettledCanvas(action, signal));
      return action();
    }
    function getRun(id, create = false) {
      assertCommittedSource();
      if (!ref(id)) fail('runId 无效', 'invalid_run');
      let run = runs.get(id);
      if (!run && create) {
        if (replacement) fail('画布正在载入，请在载入完成后继续', 'stale_canvas');
        scan();
        if (currentRun && currentRun !== id) invalidate(runs.get(currentRun), '已开始新的运行');
        run = { id, sessionId, revision, state: 'active', applied: new Map(), atoms: new Map(), bonds: new Map(), entities: new Map(), steps: new Map(), automaticPairs: new Set(), placements: new Map(), stageOrigins: new Map(), looseAtoms: new Set(), anchor: null, previewFrames: new Map(), previewVersion: 0, preview: null, previewAbort: null };
        runs.set(id, run); currentRun = id;
        if (runs.size > 80) for (const [key, previous] of runs) if (previous.state !== 'active' && key !== id) { runs.delete(key); break; }
      }
      if (!run) fail('绘图运行尚未开始', 'invalid_run');
      return run;
    }
    function checkRun(run, signal) {
      abort(signal);
      assertCommittedSource();
      if (disposed || run.state !== 'active' || run.sessionId !== sessionId || run.revision !== revision) fail(run.reason || '画布已改变，请读取当前内容后继续', 'stale_canvas');
    }
    function nativePasteInProgress() {
      return !!(controller.nativePasteSession || doc.defaultView?.molstudioClipboard?.nativePreviewActive);
    }
    function assertCommittedSource() {
      if (nativePasteInProgress()) fail('请先放置或取消正在预览的片段，再使用 AI 或读取画布。', 'edit_in_progress');
    }
    function visibleModelBounds() {
      const win = doc.defaultView;
      const rect = ed.render.clientArea.getBoundingClientRect();
      const visible = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(win.innerWidth, rect.right), bottom: Math.min(win.innerHeight, rect.bottom) };
      const frame = win.frameElement?.getBoundingClientRect();
      const panel = root.molstudioAgent?.getPanel?.()?.element;
      if (frame && panel && !panel.hidden) {
        const overlay = panel.getBoundingClientRect();
        if (overlay.width > 0 && overlay.right > frame.left) {
          visible.right = Math.min(visible.right, overlay.left - frame.left);
        }
      }
      // Ketcher's toolbars may overlap its client area. Exclude those strips.
      for (const [side, edge] of [['left', 'right'], ['right', 'left'], ['top', 'bottom'], ['bottom', 'top']]) {
        const bar = doc.querySelector('[data-testid="' + side + '-toolbar"]')?.getBoundingClientRect();
        if (!bar || !bar.width || !bar.height || bar.right <= visible.left || bar.left >= visible.right ||
            bar.bottom <= visible.top || bar.top >= visible.bottom) continue;
        if (side === 'left' || side === 'top') visible[side] = Math.max(visible[side], bar[edge]);
        else visible[side] = Math.min(visible[side], bar[edge]);
      }
      // Native tool/zoom palettes and the safe area live outside the DOM. They
      // share the exact effective region (same layoutRevision) computed by the
      // canvas viewport, so generated graphics, fit and paste placement cannot
      // land behind a native overlay.
      const nativeInsets = win.parent?.molCanvasViewport?.nativeInsetsFrame?.()
        || win.molCanvasViewport?.nativeInsetsFrame?.()
        || win.parent?.MolCanvasViewport?.nativeInsetsFrame?.()
        || win.MolCanvasViewport?.nativeInsetsFrame?.();
      if (nativeInsets) {
        visible.left = Math.max(visible.left, nativeInsets.left);
        visible.top = Math.max(visible.top, nativeInsets.top);
        if (nativeInsets.right > 0) visible.right = Math.min(visible.right, (win.innerWidth - nativeInsets.right));
        if (nativeInsets.bottom > 0) visible.bottom = Math.min(visible.bottom, (win.innerHeight - nativeInsets.bottom));
      }
      const margin = 12;
      if (visible.right - visible.left <= 2 * margin || visible.bottom - visible.top <= 2 * margin) return null;
      const lo = a.clientToModel({ x: visible.left + margin, y: visible.top + margin });
      const hi = a.clientToModel({ x: visible.right - margin, y: visible.bottom - margin });
      if (!lo || !hi || ![lo.x, lo.y, hi.x, hi.y].every(Number.isFinite)) return null;
      return { x1: Math.min(lo.x, hi.x), x2: Math.max(lo.x, hi.x), y1: Math.min(lo.y, hi.y), y2: Math.max(lo.y, hi.y) };
    }
    function viewport() {
      const ca = ed.render.clientArea, rect = ca.getBoundingClientRect(), center = a.clientToModel({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      return { zoom: a.zoom(), offset: a.offset(), viewBox: a.canvasSvg()?.getAttribute('viewBox') || '', center: center || { x: 0, y: 0 }, width: rect.width, height: rect.height, visibleBounds: visibleModelBounds() };
    }
    function getContext() {
      return withSettledCanvas(() => { assertCommittedSource(); scan(); a.syncIdentity(); refreshReactionGlyphs(); return snapshotContext(); });
    }
    function snapshotContext(pendingConnectors = new Map()) {
      assertCommittedSource();
      a.syncIdentity();
      const st = ed.struct(), chem = a.chemSnapshot(), props = new Map(chem.atoms.map(atom => [atom.uuid, atom]));
      const atoms = Array.from(st.atoms, ([id, atom]) => ({ id: a.uuidOfAtom(id), ...props.get(a.uuidOfAtom(id)), x: atom.pp.x, y: atom.pp.y, stereoLabel: atom.stereoLabel || null, stereoParity: atom.stereoParity || null, alias: typeof atom.alias === 'string' ? atom.alias : null })).map(atom => { delete atom.uuid; return atom; });
      const bonds = Array.from(st.bonds, ([id, bond]) => ({ id: a.uuidOfBond(id), begin: a.uuidOfAtom(bond.begin), end: a.uuidOfAtom(bond.end), order: bond.type === 4 ? 1.5 : bond.type || 1, nativeType: bond.type || 1, aromatic: bond.type === 4, stereo: bond.stereo || 0 }));
      const selection = a.selection();
      // 连通组件：给模型「分子句柄」（mol:N，含成员清单）。句柄只在本次 context/revision
      // 内有效；桥端执行时按当前结构重算组件并校验成员一致，画布一变即 stale_canvas。
      const adjacency = new Map(), atomUuid = new Map();
      for (const [id, atom] of st.atoms) { const uuid = a.uuidOfAtom(id); if (uuid && atom.pp) { atomUuid.set(id, uuid); adjacency.set(uuid, []); } }
      for (const { id, begin, end } of bonds) {
        if (!adjacency.has(begin) || !adjacency.has(end)) continue;
        adjacency.get(begin).push({ atom: end, bond: id });
        adjacency.get(end).push({ atom: begin, bond: id });
      }
      const seen = new Set(), molecules = [];
      const atomPosOf = uuid => { const id = a.atomIdOf(uuid); return id === null ? null : a.atomPos(id); };
      for (const id of Array.from(st.atoms.keys())) {
        const uuid = atomUuid.get(id);
        if (!uuid || seen.has(uuid)) continue;
        const stack = [uuid], members = [], componentBonds = new Set();
        seen.add(uuid);
        while (stack.length) {
          const current = stack.pop();
          members.push(current);
          for (const { atom, bond } of adjacency.get(current)) {
            if (bond) componentBonds.add(bond);
            if (!seen.has(atom)) { seen.add(atom); stack.push(atom); }
          }
        }
        const points = members.map(key => atomPosOf(key)).filter(Boolean);
        molecules.push({ id: 'mol:' + (molecules.length + 1), atoms: members.sort(), bonds: [...componentBonds].sort(), center: points.length ? { x: (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2, y: (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2 } : { x: 0, y: 0 } });
      }
      const stepLabels = new Map([...reactionConnectors.values(), ...pendingConnectors.values()]
        .flatMap(record => (record.labels || []).map(label => [label.id, label])));
      const texts = Array.from(st.texts, ([id, text]) => ({ id: String(id),
        text: stepLabels.get(id)?.nativeContent === text.content ? stepLabels.get(id).text : typeof text.content === 'string' ? text.content : '',
        x: text.position?.x ?? null, y: text.position?.y ?? null }));
      const knownArrows = new Map([...reactionConnectors.values(), ...pendingConnectors.values()]
        .filter(connectorStillDrawn).map(record => [record.id, record]));
      const reactionArrows = Array.from(st.rxnArrows, ([id, arrow]) => {
        const record = knownArrows.get(id);
        return { id: String(id), mode: arrow.mode, start: arrow.pos[0], end: arrow.pos[1],
          ...(record && { stepId: record.stepId, version: record.version, reactants: record.reactants.filter(ref => adjacency.has(ref)), products: record.products.filter(ref => adjacency.has(ref)),
            ...(record.conditions && { conditions: record.conditions }) }) };
      });
      const observationRecords = [...knownArrows.values()];
      const reactionSteps = observationRecords.map(record => stepObservation(record, observationRecords));
      return copy({ sessionId, revision, coordinateSystem: 'Ketcher model coordinates: x right, y down; bond length approximately 1', atoms, bonds, molecules, texts, lonePairs: model.state.lonePairs, arrows: model.state.arrows, reactionArrows, reactionSteps, steps: model.state.steps,
        selection: { atoms: selection.atoms.map(id => a.uuidOfAtom(id)).filter(Boolean), bonds: selection.bonds.map(id => a.uuidOfBond(id)).filter(Boolean), mechanism: Array.from(controller.selection), otherCount: selection.others,
          ...(documentState() && { document: [...app.documentController.selection] }) },
        ...(documentState() && { document: { ...documentSnapshot(), activePageId: paperTarget()?.id || null,
          layoutPolicy: 'Keep automatic drawings inside the active page content rectangle; if it is full, ask for another page. Do not shrink chemistry or change page settings.' } }),
        viewport: viewport(), limits: { operationsPerCall: MAX_OPERATIONS, nativeHistory: 32 }, supportedOperations: Array.from(TYPES) });
    }
    function atomId(value, aliases = null) {
      const uuid = aliases?.get(value) || value;
      if (a.atomIdOf(uuid) === null) fail('原子引用不存在：' + value, 'missing_reference');
      return uuid;
    }
    function bondId(value, aliases = null) {
      const uuid = aliases?.get(value) || aliases?.get(value.replace(':bond:', ':')) || value;
      if (a.bondIdOf(uuid) === null) fail('键引用不存在：' + value, 'missing_reference');
      return uuid;
    }
    function matchingBonds(bonds, atomA, atomB) {
      return bonds.filter(bond => (bond.beginAtom === atomA && bond.endAtom === atomB) ||
        (bond.beginAtom === atomB && bond.endAtom === atomA));
    }
    function resolveEndpoint(value, tables, ctx = null) {
      const resolveAtom = reference => ctx ? ctx.resolveAtom(reference) : atomId(reference, tables.atoms);
      const resolveBondAtoms = (first, second) => {
        const atomA = resolveAtom(first), atomB = resolveAtom(second);
        const matches = matchingBonds(ctx ? ctx.bonds() : controller.ctx().bonds(), atomA, atomB);
        if (!matches.length) fail('原子之间不存在键：' + first + '—' + second, 'missing_reference');
        if (matches.length !== 1) fail('原子之间的键引用有歧义：' + first + '—' + second, 'ambiguous_reference');
        return matches[0].uuid || matches[0].id;
      };
      if (value.type === 'atom') return { type: 'atom', atomId: resolveAtom(value.atomId) };
      if (value.type === 'formingBond') {
        const atomA = resolveAtom(value.atom1), atomB = resolveAtom(value.atom2);
        if (atomA === atomB) fail('成键两端不能是同一原子');
        return { type: 'formingBond', atomA, atomB };
      }
      if (value.type === 'bond') return { type: 'bond', bondId: own(value, 'bondId') ? (ctx ? ctx.resolveBond(value.bondId) : bondId(value.bondId, tables.bonds)) : resolveBondAtoms(value.atom1, value.atom2), component: value.component };
      const id = tables.entities.get(value.id) || value.id, lp = ctx ? ctx.lonePair(id) : model.lonePair(id);
      if (!lp) fail('孤对引用不存在：' + value.id, 'missing_reference');
      return { type: 'lonePair', slotId: id, ownerAtomId: lp.ownerAtomId };
    }
    function orientAutomaticPair(source, target, automaticPairs, ctx, pairs) {
      if (source.type !== 'lonePair' || !automaticPairs.has(source.slotId)) return;
      const lp = ctx.lonePair(source.slotId), owner = ctx.atomPos(source.ownerAtomId);
      const destination = M.endpointAnchor(target, ctx);
      if (!lp || !owner || !destination.ok || M.dist(owner, destination) < 1e-6) return;
      const angleTo = p => Math.atan2(p.y - owner.y, p.x - owner.x) * 180 / Math.PI;
      const outgoing = angleTo(destination), occupied = [];
      for (const bond of ctx.bonds()) {
        if (bond.beginAtom === source.ownerAtomId) occupied.push(angleTo(bond.end));
        else if (bond.endAtom === source.ownerAtomId) occupied.push(angleTo(bond.begin));
      }
      for (const other of pairs) {
        if (other.id !== lp.id && other.ownerAtomId === lp.ownerAtomId && other.visible !== false) {
          occupied.push(M.lonePairAngle(other, ctx) * 180 / Math.PI);
        }
      }
      const box = typeof ctx.atomLabelBox === 'function' ? ctx.atomLabelBox(source.ownerAtomId) : null;
      if (box && Array.isArray(box.hydrogenRects)) {
        for (const hr of box.hydrogenRects) {
          const hc = { x: (hr.x1 + hr.x2) / 2, y: (hr.y1 + hr.y2) / 2 };
          if (M.dist(owner, hc) > 1e-6) occupied.push(angleTo(hc));
        }
      }
      let best = outgoing, cost = Infinity;
      for (const offset of [0, -24, 24, -48, 48]) {
        const angle = outgoing + offset;
        const clearance = Math.min(...occupied.map(other => Math.abs(M.normalizeDelta(angle - other))));
        const score = Math.abs(offset) + 3 * Math.max(0, 28 - clearance);
        if (score < cost) { best = angle; cost = score; }
      }
      lp.angle = (best + 360) % 360;
      // An automatically aimed pair follows the atom it attacks while the
      // executor docks that reagent. Explicit angle edits clear this binding.
      const targetAtoms = target.type === 'bond' ? (() => {
        const bond = ctx.bondInfo(target.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
      })() : M.endpointAtomIds(target);
      const reference = targetAtoms.find(id => id && id !== source.ownerAtomId && ctx.atomPos(id));
      if (reference) {
        lp.refAtomId = reference;
        lp.angleRel = M.normalizeDelta(best - angleTo(ctx.atomPos(reference)));
      }
      automaticPairs.delete(source.slotId);
    }
    function modifyLonePairAim(lp, op, ctx, pairs, arrows) {
      if (op.aim === 'auto') {
        const arrow = resolveLonePairAimTarget(lp, arrows, ctx);
        const aimedContext = { ...ctx, lonePair: id => id === lp.id ? lp : ctx.lonePair(id) };
        orientAutomaticPair(arrow.source, arrow.target, new Set([lp.id]), aimedContext, pairs);
      } else {
        const actualAngle = M.lonePairAngle(lp, ctx) * 180 / Math.PI;
        lp.angle = own(op, 'angle') ? op.angle : (actualAngle + 360) % 360;
        lp.refAtomId = null; lp.angleRel = null;
      }
      lp.origin = 'manual';
    }
    async function structure(smiles, signal) {
      const key = smiles.trim();
      let value = cache.get(key);
      if (!value) {
        value = await (async () => {
          const response = await (options.fetch || root.fetch)('/api/agent/structure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ smiles: key }), signal });
          const json = await response.json();
          if (!response.ok || json.ok === false) {
            const error = new Error(typeof json.error === 'string' ? json.error : '结构解析失败');
            error.code = typeof json.code === 'string' ? json.code : 'structure_failed';
            if (json.field === 'smiles') error.field = 'smiles';
            // Keep bounded attribution metadata; never attach request arguments.
            for (const key of ['atomIndex', 'atomMap', 'mappedAtomIndices', 'unmappedAtomIndices', 'duplicateAtomMaps']) {
              if (own(json, key)) error[key] = json[key];
            }
            throw error;
          }
          const ket = typeof json.ket === 'string' ? JSON.parse(json.ket) : json.ket;
          const sections = Object.values(ket || {}).filter(item => item?.type === 'molecule');
          if (sections.length !== 1 || !Array.isArray(sections[0].atoms) || !Array.isArray(sections[0].bonds) || !sections[0].atoms.length || sections[0].atoms.length > 500) fail('结构超出 Agent 支持范围');
          if (!Array.isArray(json.atoms) || !Array.isArray(json.bonds) || json.atoms.length !== sections[0].atoms.length || json.bonds.length !== sections[0].bonds.length) fail('结构身份清单不完整');
          for (const [records, count] of [[json.atoms, sections[0].atoms.length], [json.bonds, sections[0].bonds.length]]) {
            const refs = new Set(), indices = new Set();
            for (const record of records) {
              const reference = String(record.ref);
              if (!ref(reference) || !Number.isInteger(record.index) || record.index < 0 || record.index >= count || refs.has(reference) || indices.has(record.index)) fail('结构身份清单无效');
              refs.add(reference); indices.add(record.index);
            }
          }
          // The general MOL→KET service omits the standard carbon label. The
          // native serializer requires an explicit one; use the corresponding
          // verified source atom record rather than inventing an element.
          for (const record of json.atoms) {
            const atom = sections[0].atoms[record.index];
            if (typeof record.label !== 'string' || !/^[A-Z][a-z]?$/.test(record.label) || !Array.isArray(atom.location) || atom.location.length < 2 || !atom.location.every(Number.isFinite)) fail('结构原子数据无效');
            if (!atom.label) atom.label = record.label;
            if (atom.label !== record.label) fail('结构原子的元素对照不一致');
          }
          const fragment = native.prepareKet(JSON.stringify(ket));
          const ids = Array.from(fragment.atoms.keys());
          if (ids.length !== json.atoms.length || ids.some((id, index) => id !== index) || json.atoms.some(record => fragment.atoms.get(record.index)?.label !== record.label)) fail('Ketcher 原子对照不明确');
          const atomRefs = new Map(json.atoms.map(record => [record.index, String(record.ref)]));
          const bonds = json.bonds.map(record => {
            const bond = fragment.bonds.get(record.index);
            // Ketcher may reverse a bond to preserve its wedge orientation;
            // these stable references identify the unordered atom pair.
            if (!bond || JSON.stringify([String(record.begin), String(record.end)].sort()) !==
                JSON.stringify([atomRefs.get(bond.begin), atomRefs.get(bond.end)].sort())) fail('Ketcher 键端点对照不明确');
            return { ...record, ref: String(record.ref), ...bondObservation(bond, record) };
          });
          return { ket, atoms: json.atoms.map(record => ({ ...record, ref: String(record.ref) })), bonds };
        })();
        abort(signal); cache.set(key, value);
        if (cache.size > 80) cache.delete(cache.keys().next().value);
      }
      abort(signal); return value;
    }
    async function inspectStructures(input, settings = {}) {
      if (!Array.isArray(input) || input.length < 1 || input.length > 12) fail('结构检查需要 1–12 个项目');
      const seen = new Set();
      for (const item of input) {
        if (!plain(item)) fail('结构检查项目必须是对象');
        fields(item, ['id', 'smiles'], '结构检查项目');
        if (!ref(item.id) || seen.has(item.id)) fail('结构检查 ID 无效或重复');
        if (typeof item.smiles !== 'string' || !item.smiles.trim() || item.smiles.length > 12000) fail('结构检查 SMILES 无效');
        seen.add(item.id);
      }
      const signal = settings?.signal;
      abort(signal);
      return Promise.all(input.map(async item => {
        abort(signal);
        try {
          const result = await structure(item.smiles, signal);
          abort(signal);
          return { id: item.id, ok: true, atoms: result.atoms, bonds: result.bonds };
        } catch (error) {
          abort(signal);
          const record = { id: item.id, ok: false,
            error: typeof error?.message === 'string' ? error.message.slice(0, 300) : '结构解析失败',
            code: typeof error?.code === 'string' ? error.code : 'structure_failed' };
          if (error?.field === 'smiles') record.field = 'smiles';
          for (const key of ['atomIndex', 'atomMap', 'mappedAtomIndices', 'unmappedAtomIndices', 'duplicateAtomMaps']) if (own(error, key)) record[key] = error[key];
          return record;
        }
      }));
    }
    /* 已有内容的包围盒（按键长归一化的模型坐标），用于新分子的紧凑摆放。
       分组按连通组件；文本按小盒处理；外扩 labelPad 覆盖标签与孤对的空间。 */
    function occupiedBoxes(excludeAtoms) {
      const st = ed.struct(), pad = LAYOUT.labelPad;
      const boxes = [];
      const atoms = new Map();
      for (const [id, atom] of st.atoms) {
        if (!atom.pp) continue;
        if (excludeAtoms && excludeAtoms.has(id)) continue;
        atoms.set(id, atom.pp);
      }
      const bonds = [];
      for (const [, bond] of st.bonds) {
        if (atoms.has(bond.begin) && atoms.has(bond.end)) bonds.push([bond.begin, bond.end]);
      }
      const adjacency = new Map();
      for (const [a, b] of bonds) {
        if (!adjacency.has(a)) adjacency.set(a, []);
        if (!adjacency.has(b)) adjacency.set(b, []);
        adjacency.get(a).push(b); adjacency.get(b).push(a);
      }
      const seen = new Set();
      for (const id of atoms.keys()) {
        if (seen.has(id)) continue;
        const stack = [id], group = [];
        seen.add(id);
        while (stack.length) {
          const current = stack.pop();
          group.push(current);
          for (const next of adjacency.get(current) || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
        const xs = group.map(key => atoms.get(key).x), ys = group.map(key => atoms.get(key).y);
        boxes.push({ x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad });
      }
      for (const [, text] of st.texts) {
        const p = text.position;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        boxes.push({ x1: p.x - 1, y1: p.y - 0.4, x2: p.x + 1, y2: p.y + 0.4 });
      }
      for (const arrow of st.rxnArrows.values()) {
        const [from, to] = arrow.pos;
        if (from && to) boxes.push({ x1: Math.min(from.x, to.x) - 0.15, y1: Math.min(from.y, to.y) - 0.15,
          x2: Math.max(from.x, to.x) + 0.15, y2: Math.max(from.y, to.y) + 0.15 });
      }
      for (const object of documentState()?.objects || []) {
        const angle = (object.rotation || 0) * Math.PI / 180,
          w = Math.abs(Math.cos(angle)) * object.w + Math.abs(Math.sin(angle)) * object.h,
          h = Math.abs(Math.sin(angle)) * object.w + Math.abs(Math.cos(angle)) * object.h;
        boxes.push(boxAt({ x: object.x + object.w / 2, y: object.y + object.h / 2 }, { width: w, height: h }));
      }
      return boxes;
    }
    function boxesOverlap(box, occupied, gap) {
      const g = gap / 2;
      return occupied.some(other => box.x1 - g < other.x2 && box.x2 + g > other.x1 && box.y1 - g < other.y2 && box.y2 + g > other.y1);
    }
    function boxAt(center, size) {
      return { x1: center.x - size.width / 2, y1: center.y - size.height / 2,
        x2: center.x + size.width / 2, y2: center.y + size.height / 2 };
    }
    function inside(point, rect) {
      return point && point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2;
    }
    function clampPoint(point, rect) {
      return { x: Math.max(rect.x1, Math.min(rect.x2, point.x)), y: Math.max(rect.y1, Math.min(rect.y2, point.y)) };
    }
    function centerLimits(view, size) {
      return { x1: view.x1 + size.width / 2, x2: view.x2 - size.width / 2,
        y1: view.y1 + size.height / 2, y2: view.y2 - size.height / 2 };
    }
    function midpoint(rect) {
      return { x: (rect.x1 + rect.x2) / 2, y: (rect.y1 + rect.y2) / 2 };
    }
    function nearestFreeCenter(start, size, occupied, gap, limits) {
      if (!boxesOverlap(boxAt(start, size), occupied, gap)) return start;
      for (let ring = 1; ring <= LAYOUT.searchRings; ring++) {
        const radius = ring * LAYOUT.searchRingStep;
        const steps = 8 + ring * 4;
        for (let i = 0; i < steps; i++) {
          const angle = (i / steps) * Math.PI * 2 + (ring % 2) * Math.PI / steps;
          const candidate = clampPoint({ x: start.x + Math.cos(angle) * radius, y: start.y + Math.sin(angle) * radius * 0.62 }, limits);
          if (!boxesOverlap(boxAt(candidate, size), occupied, gap)) return candidate;
        }
      }
      return null;
    }
    function layoutViewport() {
      const paper = paperBounds();
      if (paper) return paper;
      const { visibleBounds, center } = viewport();
      return visibleBounds || boxAt(center, { width: 24, height: 16 });
    }
    function clearAlong(seed, size, occupied, gap, axis, direction) {
      const cross = axis === 'x' ? 'y' : 'x';
      const box = boxAt(seed, size), pad = gap / 2;
      const half = (box[axis + '2'] - box[axis + '1']) / 2 + pad;
      const intervals = occupied.filter(other => box[cross + '1'] - pad < other[cross + '2'] && box[cross + '2'] + pad > other[cross + '1'])
        .map(other => direction > 0 ? [other[axis + '1'] - half, other[axis + '2'] + half]
          : [-other[axis + '2'] - half, -other[axis + '1'] + half]).sort((a, b) => a[0] - b[0]);
      let value = direction * seed[axis];
      for (const [lo, hi] of intervals) if (value >= lo && value < hi) value = hi + 1e-6;
      return { ...seed, [axis]: direction * value };
    }
    function openCanvasCenter(seed, size, occupied, gap, divider = null) {
      if (!boxesOverlap(boxAt(seed, size), occupied, gap)) return seed;
      const candidates = ['x', 'y'].flatMap(axis => (axis === divider?.axis ? [divider.direction] : [1, -1])
        .map(direction => clearAlong(seed, size, occupied, gap, axis, direction)));
      return candidates.reduce((best, point) => M.dist(seed, point) < M.dist(seed, best) ? point : best);
    }
    function revealNewStage(layout) {
      const view = visibleModelBounds();
      if (!view) return;
      const outside = [...Array.from(layout.positions, ([id, pos]) => boxAt(pos, fragmentBounds(layout.fragments.get(id)))), ...layout.follow]
        .findLast(box => box.x1 < view.x1 - 1e-6 || box.x2 > view.x2 + 1e-6 || box.y1 < view.y1 - 1e-6 || box.y2 > view.y2 + 1e-6);
      if (!outside) return;
      const shift = axis => {
        const lo = axis + '1', hi = axis + '2';
        if (outside[hi] - outside[lo] > view[hi] - view[lo]) return (outside[lo] + outside[hi] - view[lo] - view[hi]) / 2;
        return outside[lo] < view[lo] ? outside[lo] - view[lo] - 0.6 : outside[hi] > view[hi] ? outside[hi] - view[hi] + 0.6 : 0;
      };
      const dx = shift('x') * a.bondLength(), dy = shift('y') * a.bondLength();
      ed.render.setViewBox(box => ({ ...box, minX: box.minX + dx, minY: box.minY + dy }));
    }
    function stepReadingBounds(record, includeReactants) {
      if (!record) return null;
      const boxes = reactionMoleculeBoxes(), refs = includeReactants ? [...record.reactants, ...record.products] : record.products;
      const members = refs.map(id => boxes.get(id)).filter(Boolean), arrow = ed.struct().rxnArrows.get(record.id);
      if (arrow) for (const point of arrow.pos) members.push({ x1: point.x, x2: point.x, y1: point.y - 0.5, y2: point.y + 0.5 });
      return members.length ? unionBoxes(members) : null;
    }
    function automaticReadingZoom() {
      return options.automaticReadingZoom ?? root.MolWorkbenchOptions?.automaticReadingZoom;
    }
    function showAutomaticView(plan) {
      let view = visibleModelBounds();
      if (!view || !plan?.bounds) return;
      if (Math.abs(plan.zoom - a.zoom()) > 1e-6 && typeof ed.zoom === 'function') {
        ed.zoom(plan.zoom);
        ed.event?.zoomChanged?.dispatch?.();
        view = visibleModelBounds();
        if (!view) return;
      }
      const bounds = plan.bounds;
      const dx = (bounds.x1 + bounds.x2 - view.x1 - view.x2) / 2 * a.bondLength();
      const dy = (bounds.y1 + bounds.y2 - view.y1 - view.y2) / 2 * a.bondLength();
      ed.render.setViewBox(box => ({ ...box, minX: box.minX + dx, minY: box.minY + dy }));
      controller.render();
    }
    function revealCompletedGraph(bounds, run) {
      const view = visibleModelBounds();
      if (!view || !bounds) return;
      const records = [...reactionConnectors.values()].filter(connectorStillDrawn);
      const owned = new Set(run?.steps.values()), last = records.filter(record => owned.has(record.stepId)).at(-1) || records.at(-1);
      const readingBounds = completedDrawingBounds({ steps: new Map(records.map(record => [record.stepId, record.stepId])) }) || bounds;
      showAutomaticView(automaticViewportPlan({ zoom: a.zoom(), view, bounds, readingBounds,
        focusBounds: stepReadingBounds(last, false) || bounds, minimumZoom: automaticReadingZoom() }));
    }
    function revealLoadedReadingGraph() {
      const records = [...reactionConnectors.values()].filter(connectorStillDrawn), view = visibleModelBounds();
      if (!records.length || !view) return;
      const bounds = completedDrawingBounds({ steps: new Map(records.map(record => [record.stepId, record.stepId])) });
      if (!bounds) return;
      const plan = automaticViewportPlan({ zoom: a.zoom(), view, bounds,
        focusBounds: stepReadingBounds(records[0], true) || bounds, minimumZoom: automaticReadingZoom() });
      if (plan?.reading) showAutomaticView(plan);
    }
    function completedDrawingBounds(run) {
      const owned = new Set(run.steps.values()), records = [...reactionConnectors.values()]
        .filter(record => owned.has(record.stepId) && connectorStillDrawn(record));
      if (!records.length) return run.graphBounds;
      const boxes = reactionMoleculeBoxes(), members = [...new Set(records.flatMap(record =>
        [...record.reactants, ...record.products].map(id => boxes.get(id)).filter(Boolean)))];
      const components = new Set(members.map(box => box.component)), ctx = controller.ctx();
      const bounds = members.slice();
      for (const record of records) for (const label of record.labels || []) {
        const text = ed.struct().texts.get(label.id), p = text?.position;
        if (p) bounds.push({ x1: p.x, x2: p.x + conditionWidth(label.text), y1: p.y - 0.2, y2: p.y + 0.7 });
      }
      const atoms = endpoint => endpoint.type === 'bond' ? (() => {
        const bond = ctx.bondInfo(endpoint.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
      })() : M.endpointAtomIds(endpoint);
      for (const flow of model.state.arrows) {
        const refs = [...atoms(flow.source), ...atoms(flow.target)];
        if (!refs.length || refs.some(id => !components.has(boxes.get(id)?.component))) continue;
        const geometry = M.arrowGeometry(flow, ctx);
        if (geometry.sourceOk && geometry.targetOk && MW.route?.sampleCurve) {
          const points = MW.route.sampleCurve(geometry.start, geometry.control, geometry.end, 0.12, 12, 40).points;
          bounds.push({ x1: Math.min(...points.map(p => p.x)), x2: Math.max(...points.map(p => p.x)),
            y1: Math.min(...points.map(p => p.y)), y2: Math.max(...points.map(p => p.y)) });
        }
      }
      return bounds.length ? unionBoxes(bounds) : run.graphBounds;
    }
    function stagePack(group, links, sizes, axis) {
      const along = axis === 'x' ? 'width' : 'height', across = axis === 'x' ? 'y' : 'x', acrossDim = axis === 'x' ? 'height' : 'width';
      const members = new Set(group), positions = new Map();
      const related = links.filter(([from, to]) => members.has(from.id) && members.has(to.id));
      let cursor = 0;
      for (const id of orderByAnchors(group, related, sizes, axis, LAYOUT.groupGap)) {
        const size = sizes.get(id), pos = { [axis]: cursor + size[along] / 2, [across]: 0 };
        const neighbor = related.map(link => link[0].id === id ? link : [link[1], link[0]])
          .find(([current, prior]) => current.id === id && positions.has(prior.id));
        if (neighbor) {
          const [current, prior] = neighbor;
          const shift = positions.get(prior.id)[across] + prior.point[across] - sizes.get(prior.id).center[across]
            - current.point[across] + size.center[across];
          const maxAcross = Math.max(1.25, Math.min(2.2, (size[acrossDim] + sizes.get(prior.id)[acrossDim]) / 2));
          pos[across] = Math.max(-maxAcross, Math.min(maxAcross, shift));
        }
        positions.set(id, pos);
        cursor += size[along] + LAYOUT.groupGap;
      }
      const box = unionBoxes(group.map(id => boxAt(positions.get(id), sizes.get(id))));
      const center = midpoint(box);
      for (const p of positions.values()) { p.x -= center.x; p.y -= center.y; }
      const anchor = end => {
        const p = positions.get(end.id), c = sizes.get(end.id).center;
        return { x: p.x + end.point.x - c.x, y: p.y + end.point.y - c.y };
      };
      return { positions, width: box.x2 - box.x1, height: box.y2 - box.y1,
        cost: related.reduce((sum, [from, to]) => sum + M.dist(anchor(from), anchor(to)), 0) };
    }
    function preferredStagePack(group, links, sizes) {
      const row = stagePack(group, links, sizes, 'x');
      if (group.length !== 2 || row.cost === 0) return row;
      const stack = stagePack(group, links, sizes, 'y');
      // A second level pays for itself when it brings the reacting sites closer.
      return stack.cost + 0.20 * Math.max(0, stack.height - row.height) + 0.25 < row.cost ? stack : row;
    }
    function placePackedStage(stage, center, layout) {
      for (const [id, p] of stage.positions) {
        layout.positions.set(id, { x: center.x + p.x, y: center.y + p.y, warnings: [] });
      }
    }
    function reserveStageChain(groups, links, layout, view, occupied) {
      const sizes = new Map(groups.flat().map(id => [id, fragmentBounds(layout.fragments.get(id))]));
      const stages = groups.map(group => preferredStagePack(group, links, sizes));
      const viewWidth = view.x2 - view.x1;
      // Longer schemes use a printable-width lane even when the on-screen window is narrower.
      const rowWidth = Math.max(viewWidth, 38, ...stages.map(stage => stage.width));
      const rows = [];
      let row;
      for (const stage of stages) {
        if (!row || row.stages.length > LAYOUT.rowSteps || row.width + LAYOUT.stepGap + stage.width > rowWidth) {
          row = { stages: [], width: 0, height: 0 };
          rows.push(row);
        }
        if (row.stages.length) row.width += LAYOUT.stepGap;
        row.stages.push(stage);
        row.width += stage.width;
        row.height = Math.max(row.height, stage.height);
      }
      let x = 0, y = 0;
      const placements = [];
      rows.forEach((row, index) => {
        const direction = index % 2 ? -1 : 1;
        let previous;
        for (const stage of row.stages) {
          if (previous) x += direction * ((previous.width + stage.width) / 2 + LAYOUT.stepGap);
          placements.push({ stage, point: { x, y: y + row.height / 2 } });
          previous = stage;
        }
        y += row.height + LAYOUT.stepGap;
      });
      const bounds = unionBoxes(placements.map(({ stage, point }) => boxAt(point, stage)));
      const localCenter = midpoint(bounds);
      const size = { width: bounds.x2 - bounds.x1, height: bounds.y2 - bounds.y1 };
      const limits = centerLimits(view, size);
      let center = limits.x1 <= limits.x2 && limits.y1 <= limits.y2
        ? nearestFreeCenter(midpoint(limits), size, occupied, LAYOUT.minReactionGap, limits) : null;
      center ||= openCanvasCenter(midpoint(view), size, occupied, LAYOUT.minReactionGap);
      for (const { stage, point } of placements) {
        const at = { x: point.x + center.x - localCenter.x, y: point.y + center.y - localCenter.y };
        placePackedStage(stage, at, layout);
      }
      layout.reserved.push(boxAt(center, size));
    }
    function reserveStageGroup(group, links, layout, view, occupied, anchor = null) {
      const sizes = new Map(group.map(id => [id, fragmentBounds(layout.fragments.get(id))]));
      const attempts = [['x', 'x'], ['y', 'y']];
      if (anchor) attempts.splice(1, 0, ['y', 'x']);
      const obstacles = occupied.concat(layout.reserved);
      let fallback;
      for (const [axis, packAxis] of attempts) {
        if (axis === 'x' && anchor?.wrap) continue;
        const size = packAxis === 'x' ? preferredStagePack(group, links, sizes) : stagePack(group, links, sizes, 'y');
        const direction = axis === 'y' ? (anchor?.verticalDirection || 1) : anchor?.direction;
        const limits = centerLimits(view, size);
        let seed = midpoint(limits);
        if (anchor) {
          const positive = direction > 0;
          const near = axis + (positive ? '1' : '2'), far = axis + (positive ? '2' : '1');
          const halfSize = (axis === 'x' ? size.width : size.height) / 2;
          const boundary = anchor.box[far] + direction * (LAYOUT.stepGap + halfSize);
          limits[near] = positive ? Math.max(limits[near], boundary) : Math.min(limits[near], boundary);
          seed = { ...midpoint(anchor.box), [axis]: boundary };
        }
        fallback ||= { size, seed, axis, direction };
        if (limits.x1 > limits.x2 || limits.y1 > limits.y2) continue;
        const start = clampPoint(seed, limits);
        if (anchor && !inside(midpoint(anchor.box), view) && M.dist(start, seed) > 3) continue;
        const center = nearestFreeCenter(start, size, obstacles, LAYOUT.minReactionGap, limits);
        if (!center) continue;
        placePackedStage(size, center, layout);
        layout.reserved.push(boxAt(center, size));
        return;
      }
      const { size, seed, axis, direction } = fallback;
      const center = anchor ? clearAlong(seed, size, obstacles, LAYOUT.minReactionGap, axis, direction)
        : openCanvasCenter(midpoint(view), size, obstacles, LAYOUT.minReactionGap);
      placePackedStage(size, center, layout);
      layout.reserved.push(boxAt(center, size));
    }
    function reserveReactionStages(connectors, atomOwners, links, layout, view, occupied, run) {
      if (!connectors.length) return;
      const existing = reactionMoleculeBoxes();
      const plannedFlow = new Map();
      const side = refs => refs.map(ref => {
        const id = atomOwners.get(ref);
        return id ? { id } : { box: existing.get(run.atoms.get(ref) || ref) };
      });
      const boxFor = (member, positions) => {
        const center = member.id && positions.get(member.id);
        return center ? boxAt(center, fragmentBounds(layout.fragments.get(member.id))) : member.box;
      };
      const pending = connectors.map(op => ({ op, from: side(op.reactants), to: side(op.products) }))
        .filter(({ from, to }) => [...from, ...to].every(member => member.id || member.box) &&
          !from.some(a => to.some(b => a.id ? a.id === b.id : a.box === b.box)));
      while (pending.length) {
        const fixed = member => boxFor(member, layout.positions);
        const anchored = pending.findIndex(({ from, to }) => [...from, ...to].some(fixed));
        if (anchored < 0) {
          // Pack each independent chain. An ambiguous branch can still start from a single edge.
          const group = [pending.shift()];
          const members = new Set([...group[0].from, ...group[0].to].map(member => member.id));
          for (let i = 0; i < pending.length;) {
            const edge = pending[i], ids = [...edge.from, ...edge.to].map(member => member.id);
            if (!ids.some(id => members.has(id))) { i++; continue; }
            group.push(...pending.splice(i, 1));
            for (const id of ids) members.add(id);
            i = 0;
          }
          const stages = reactionStages(group.map(({ op }) => op), atomOwners);
          if (stages.length) reserveStageChain(stages, links, layout, view, occupied.concat(layout.reserved));
          else {
            const [first, ...rest] = group;
            reserveStageChain([first.from, first.to].map(side => [...new Set(side.map(member => member.id))]),
              links, layout, view, occupied.concat(layout.reserved));
            pending.unshift(...rest);
          }
          continue;
        }
        const [{ from, to }] = pending.splice(anchored, 1);
        const fromFixed = from.some(member => boxFor(member, layout.positions));
        const toFixed = to.some(member => boxFor(member, layout.positions));
        const anchor = fromFixed ? from : to;
        const unplaced = fromFixed ? to : from;
        const placeNewMembers = members => {
          const anchorCenter = midpoint(unionBoxes(members.map(fixed).filter(Boolean)));
          const fixedBoxes = members.map(member => member.box).filter(Boolean);
          const incoming = incomingStage(fixedBoxes);
          const divider = incomingStageDivider(fixedBoxes, incoming);
          for (const member of members) {
            if (fixed(member)) continue;
            const size = fragmentBounds(layout.fragments.get(member.id)), limits = centerLimits(view, size);
            const seed = { ...(layout.preferred.get(member.id) || anchorCenter) };
            const obstacles = occupied.concat(layout.reserved), gap = 2 * LAYOUT.groupGap;
            if (divider) {
              const { axis, direction, boundary } = divider;
              const half = (axis === 'x' ? size.width : size.height) / 2;
              const edge = boundary + direction * (0.2 + half);
              if (direction > 0) limits[axis + '1'] = Math.max(limits[axis + '1'], edge);
              else limits[axis + '2'] = Math.min(limits[axis + '2'], edge);
              seed[axis] = direction > 0 ? Math.max(seed[axis], edge) : Math.min(seed[axis], edge);
            }
            let pos = limits.x1 <= limits.x2 && limits.y1 <= limits.y2 && inside(seed, view)
              ? nearestFreeCenter(clampPoint(seed, limits), size, obstacles, gap, limits) : null;
            if (!pos || M.dist(seed, pos) > 3) {
              const nearby = openCanvasCenter(seed, size, obstacles, gap, divider);
              if (!pos || M.dist(seed, nearby) < M.dist(seed, pos)) pos = nearby;
            }
            layout.positions.set(member.id, { ...pos, warnings: [] });
            layout.reserved.push(boxAt(pos, size));
          }
          return incoming;
        };
        const incoming = placeNewMembers(anchor);
        if (fromFixed && toFixed) { placeNewMembers(unplaced); continue; }
        const boxes = anchor.map(fixed);
        const group = [...new Set(unplaced.map(member => member.id))];
        const box = unionBoxes(boxes), flow = fromFixed
          ? incoming?.flow || anchor.map(member => plannedFlow.get(member.id)).find(Boolean) : null;
        const direction = flow?.direction || (fromFixed ? 1 : -1);
        const nextView = { ...view };
        if (flow) {
          const room = view.x2 - view.x1;
          if (direction > 0) nextView.x2 = Math.max(view.x2, box.x2 + room);
          else nextView.x1 = Math.min(view.x1, box.x1 - room);
          nextView.y2 = Math.max(view.y2, box.y2 + view.y2 - view.y1);
        }
        reserveStageGroup(group, links, layout, nextView, occupied, {
          box, direction, verticalDirection: fromFixed ? 1 : -1, wrap: flow?.steps >= LAYOUT.rowSteps
        });
        if (fromFixed) {
          const continuation = nextStageFlow(flow, midpoint(box), midpoint(unionBoxes(unplaced.map(fixed))));
          for (const member of unplaced) plannedFlow.set(member.id, continuation);
        }
      }
    }
    function reserveDeclaredStages(connectors, atomAnchors, links, arrowRoutes, ops, layout, view, occupied, run) {
      if (!connectors.length) return;
      const existing = reactionMoleculeBoxes(), plannedFlow = new Map(), waitingProducts = new Set(), independentRows = new Map();
      const ctx = controller.ctx(), curves = [];
      for (const arrow of model.state.arrows) {
        const geometry = M.arrowGeometry(arrow, ctx);
        if (!geometry.sourceOk || !geometry.targetOk || geometry.degenerate) continue;
        const { points } = MW.route.sampleCurve(geometry.start, geometry.control, geometry.end, 0.35, 5, 16);
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          curves.push({ x1: Math.min(a.x, b.x) - 0.15, y1: Math.min(a.y, b.y) - 0.15,
            x2: Math.max(a.x, b.x) + 0.15, y2: Math.max(a.y, b.y) + 0.15 });
        }
      }
      const stageObstacles = occupied.concat(curves);
      const sizes = new Map([...layout.fragments].map(([id, fragment]) => [id, fragmentBounds(fragment)]));
      const explicit = new Set(ops.filter(op => !run.readingOrder && (own(op, 'x') || own(op, 'y'))).map(op => op.id));
      const side = refs => refs.map(ref => {
        const fresh = atomAnchors.get(ref);
        if (fresh) return fresh;
        const atomId = run.atoms.get(ref) || ref, rid = a.atomIdOf(atomId);
        return { box: existing.get(atomId), point: rid === null ? null : a.atomPos(rid) };
      });
      const componentKey = ref => atomAnchors.get(ref)?.id || existing.get(run.atoms.get(ref) || ref)?.component || ref;
      const pending = connectors.map(op => ({
        op, reactants: op.reactants.map(componentKey), products: new Set(op.products.map(componentKey))
      }));
      const ordered = [];
      while (pending.length) {
        const next = pending.findIndex(stage => !pending.some(other => other !== stage &&
          stage.reactants.some(member => other.products.has(member))));
        if (next < 0) { ordered.push(...pending); break; }
        ordered.push(pending.splice(next, 1)[0]);
      }
      const boxFor = member => member.box || (layout.positions.has(member.id) && boxAt(layout.positions.get(member.id), sizes.get(member.id)));
      const boxesFor = members => members.map(boxFor).filter(Boolean);
      const segsCross = (a, b, c, d) => {
        const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        const d1 = cross(c, d, a), d2 = cross(c, d, b);
        const d3 = cross(a, b, c), d4 = cross(a, b, d);
        return (((d1 > 1e-5 && d2 < -1e-5) || (d1 < -1e-5 && d2 > 1e-5)) &&
                ((d3 > 1e-5 && d4 < -1e-5) || (d3 < -1e-5 && d4 > 1e-5)));
      };
      const pointSegDist = (p, a, b) => {
        const vx = b.x - a.x, vy = b.y - a.y;
        const wx = p.x - a.x, wy = p.y - a.y;
        const len2 = vx * vx + vy * vy;
        const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
        return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
      };
      const segDist = (a, b, c, d) => {
        if (segsCross(a, b, c, d)) return 0;
        return Math.min(
          pointSegDist(a, c, d), pointSegDist(b, c, d),
          pointSegDist(c, a, b), pointSegDist(d, a, b)
        );
      };
      const getHostBonds = (hostId, hostCenter, hostSize, anchorBox) => {
        const bonds = [];
        if (hostId && layout.fragments.has(hostId)) {
          const frag = layout.fragments.get(hostId);
          if (frag?.bonds && frag?.atoms) {
            const size = hostSize || fragmentBounds(frag);
            const center = hostCenter || { x: 0, y: 0 };
            for (const [, bond] of frag.bonds) {
              const a1 = frag.atoms.get(bond.begin), a2 = frag.atoms.get(bond.end);
              if (!a1?.pp || !a2?.pp) continue;
              bonds.push([
                { x: a1.pp.x - size.center.x + center.x, y: a1.pp.y - size.center.y + center.y },
                { x: a2.pp.x - size.center.x + center.x, y: a2.pp.y - size.center.y + center.y }
              ]);
            }
          }
        } else if (anchorBox && ed && typeof ed.struct === 'function') {
          const st = ed.struct();
          if (st?.bonds && st?.atoms) {
            for (const [, bond] of st.bonds) {
              const a1 = st.atoms.get(bond.begin), a2 = st.atoms.get(bond.end);
              if (!a1?.pp || !a2?.pp) continue;
              const inBox = p => p.x >= anchorBox.x1 - 0.35 && p.x <= anchorBox.x2 + 0.35 &&
                                 p.y >= anchorBox.y1 - 0.35 && p.y <= anchorBox.y2 + 0.35;
              if (inBox(a1.pp) && inBox(a2.pp)) {
                bonds.push([{ x: a1.pp.x, y: a1.pp.y }, { x: a2.pp.x, y: a2.pp.y }]);
              }
            }
          }
        }
        return bonds;
      };
      const evaluateHostCrossings = (target, site, hostBonds, anchorBox) => {
        let bondCrossings = 0;
        for (const [p1, p2] of hostBonds) {
          if (M.dist(target, p1) > 0.15 && M.dist(target, p2) > 0.15) {
            if (segDist(target, site, p1, p2) < 0.08) {
              bondCrossings++;
            }
          }
        }
        let heartlandCrossings = 0;
        if (anchorBox) {
          const c = midpoint(anchorBox);
          if (Math.min(target.x, site.x) < c.x && Math.max(target.x, site.x) > c.x) {
            const y_at_c = target.y + (site.y - target.y) * ((c.x - target.x) / (site.x - target.x));
            if (y_at_c > anchorBox.y1 + 0.15 && y_at_c < anchorBox.y2 - 0.15) heartlandCrossings++;
          }
          if (Math.min(target.y, site.y) < c.y && Math.max(target.y, site.y) > c.y) {
            const x_at_c = target.x + (site.x - target.x) * ((c.y - target.y) / (site.y - target.y));
            if (x_at_c > anchorBox.x1 + 0.15 && x_at_c < anchorBox.x2 - 0.15) heartlandCrossings++;
          }
        }
        return bondCrossings + heartlandCrossings;
      };
      // Preview the pending electron flow together for each possible reagent position.
      // Local transfers are routed first, so an incoming reagent must also clear them.
      const routeCost = (positions, movingId) => {
        if (!MW.route?.planArrow || !MW.route?.sampleCurve) return 0;
        const point = end => {
          if (!end.id) return end.point;
          const center = positions.get(end.id), size = sizes.get(end.id);
          return center && size ? { x: center.x + end.point.x - size.center.x,
            y: center.y + end.point.y - size.center.y } : null;
        };
        const routes = arrowRoutes.filter(r => r.from.id === movingId || r.to.id === movingId ||
          (r.from.id === r.to.id && r.from.id && positions.has(r.from.id)) ||
          (!r.from.id && !r.to.id)).slice(0, 12);
        routes.sort((a, b) => Number(a.from.id !== a.to.id) - Number(b.from.id !== b.to.id));
        const scene = { labels: [], bonds: [], lonePairs: [], arrows: [], L: 1 };
        let crossings = 0;
        for (const route of routes) {
          const a = point(route.from), b = point(route.to);
          if (!a || !b || M.dist(a, b) < 0.05) continue;
          const plan = MW.route.planArrow({ a, b, scene, preferClearArrows: true });
          if (!plan.ranked?.length) continue;
          const control = M.controlPoint(a, b, plan.bend);
          const sampled = MW.route.sampleCurve(a, control, b, 0.2, 8, 24);
          const points = sampled.points;
          for (const previous of scene.arrows) {
            let crossed = false;
            for (let i = 1; i < points.length && !crossed; i++) {
              for (let j = 1; j < previous.points.length; j++) {
                if (segsCross(points[i - 1], points[i], previous.points[j - 1], previous.points[j])) {
                  crossed = true; break;
                }
              }
            }
            if (crossed) crossings++;
          }
          scene.arrows.push({ points, length: sampled.length || M.dist(a, b) });
        }
        return crossings;
      };
      const findBestDockPosition = (anchor, target, size, offset, hostBonds, obstacles, dockGap, placement, divider, movingId, positions) => {
        const halfX = size.width / 2, halfY = size.height / 2;
        const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
        const candidates = [];
        const topY = anchor.y1 - (dockGap + halfY);
        candidates.push(
          { axis: 'y', direction: -1, seed: { x: clamp(target.x - offset.x, anchor.x1 - halfX * 0.4, anchor.x2 + halfX * 0.4), y: topY } },
          { axis: 'y', direction: -1, seed: { x: anchor.x1 + halfX, y: topY } },
          { axis: 'y', direction: -1, seed: { x: anchor.x2 - halfX, y: topY } },
          { axis: 'y', direction: -1, seed: { x: (anchor.x1 + anchor.x2) / 2, y: topY } }
        );
        const bottomY = anchor.y2 + (dockGap + halfY);
        candidates.push(
          { axis: 'y', direction: 1, seed: { x: clamp(target.x - offset.x, anchor.x1 - halfX * 0.4, anchor.x2 + halfX * 0.4), y: bottomY } },
          { axis: 'y', direction: 1, seed: { x: anchor.x1 + halfX, y: bottomY } },
          { axis: 'y', direction: 1, seed: { x: anchor.x2 - halfX, y: bottomY } },
          { axis: 'y', direction: 1, seed: { x: (anchor.x1 + anchor.x2) / 2, y: bottomY } }
        );
        const leftX = anchor.x1 - (dockGap + halfX);
        candidates.push(
          { axis: 'x', direction: -1, seed: { x: leftX, y: clamp(target.y - offset.y, anchor.y1 - halfY * 0.4, anchor.y2 + halfY * 0.4) } },
          { axis: 'x', direction: -1, seed: { x: leftX, y: anchor.y1 + halfY } },
          { axis: 'x', direction: -1, seed: { x: leftX, y: anchor.y2 - halfY } },
          { axis: 'x', direction: -1, seed: { x: leftX, y: (anchor.y1 + anchor.y2) / 2 } },
          { axis: 'x', direction: -1, seed: { x: leftX, y: anchor.y2 + halfY } }
        );
        const rightX = anchor.x2 + (dockGap + halfX);
        candidates.push(
          { axis: 'x', direction: 1, seed: { x: rightX, y: clamp(target.y - offset.y, anchor.y1 - halfY * 0.4, anchor.y2 + halfY * 0.4) } },
          { axis: 'x', direction: 1, seed: { x: rightX, y: anchor.y1 + halfY } },
          { axis: 'x', direction: 1, seed: { x: rightX, y: anchor.y2 - halfY } },
          { axis: 'x', direction: 1, seed: { x: rightX, y: (anchor.y1 + anchor.y2) / 2 } }
        );

        let best = null;
        for (const cand of candidates) {
          if (cand.axis === 'x' && cand.direction < 0 && cand.seed.x < divider) continue;
          const startSeed = { ...cand.seed, x: Math.max(cand.seed.x, divider) };
          const center = clearAlong(startSeed, size, obstacles, dockGap, cand.axis, cand.direction);
          if (center.x < divider) continue;

          const site = { x: center.x + offset.x, y: center.y + offset.y };
          const hostCrossings = evaluateHostCrossings(target, site, hostBonds, anchor);
          const otherCrossings = obstacles.filter(box => box !== anchor && !inside(target, box) &&
            MW.route && typeof MW.route.segRectDistance === 'function' &&
            MW.route.segRectDistance(target, site, box) < 0.08).length;

          let axisMismatchPenalty = 0;
          if (placement === 'horizontal' && cand.axis === 'y') axisMismatchPenalty = 0.45;
          if (placement === 'vertical' && cand.axis === 'x') axisMismatchPenalty = 0.45;

          const candidatePositions = new Map(positions);
          candidatePositions.set(movingId, center);
          const curveCrossings = routeCost(candidatePositions, movingId);
          const cost = M.dist(target, site) + hostCrossings * 8 + otherCrossings * 3 +
            curveCrossings * 20 + axisMismatchPenalty;
          if (!best || cost < best.cost) {
            best = { center, cost };
          }
        }
        return best;
      };
      const dockReactant = (members, placement) => {
        const fresh = members.filter(member => !boxFor(member) && !explicit.has(member.id));
        if (!fresh.length) return false;
        const fixed = members.filter(member => boxFor(member));
        if (!fixed.length) return false;
        const matchesFixed = (endpoint, member) => {
          if (endpoint.id && member.id) return endpoint.id === member.id;
          if (member.box && endpoint.atomId) return member.box === existing.get(endpoint.atomId);
          return false;
        };
        if (fresh.length > 1) {
          const hasLinks = fresh.some(local => links.some(pair =>
            (pair[0].id === local.id && fixed.some(m => matchesFixed(pair[1], m))) ||
            (pair[1].id === local.id && fixed.some(m => matchesFixed(pair[0], m)))
          ));
          if (!hasLinks) return false;
        }
        const sortedFresh = fresh.slice().sort((a, b) => {
          const aHas = links.some(pair => (pair[0].id === a.id && fixed.some(m => matchesFixed(pair[1], m))) || (pair[1].id === a.id && fixed.some(m => matchesFixed(pair[0], m))));
          const bHas = links.some(pair => (pair[0].id === b.id && fixed.some(m => matchesFixed(pair[1], m))) || (pair[1].id === b.id && fixed.some(m => matchesFixed(pair[0], m))));
          return (bHas ? 1 : 0) - (aHas ? 1 : 0);
        });

        for (const local of sortedFresh) {
          const size = sizes.get(local.id);
          const linked = links.map(pair => pair[0].id === local.id ? pair : [pair[1], pair[0]])
            .find(([near, far]) => near.id === local.id && fixed.some(member => matchesFixed(far, member)));
          const [near, far] = linked || [local, fixed[0]];
          const anchor = far.box || existing.get(far.atomId) || boxFor(far);
          const incoming = incomingStage([anchor]);
          const priorFlow = plannedFlow.get(far.id) || incoming?.flow;
          const divider = run.readingOrder && priorFlow?.reading
            ? (incomingStageDivider([anchor], incoming)?.boundary ?? anchor.x1 - 0.25) + size.width / 2 : -Infinity;
          const anchorCenter = midpoint(anchor);
          const target = far.id ? { x: anchorCenter.x + far.point.x - sizes.get(far.id).center.x,
            y: anchorCenter.y + far.point.y - sizes.get(far.id).center.y } : far.point || anchorCenter;
          const offset = { x: near.point.x - size.center.x, y: near.point.y - size.center.y };
          const obstacles = stageObstacles.concat(layout.reserved);
          const dockGap = Math.max(2 * LAYOUT.groupGap, 0.95);
          const hostBonds = far.id && layout.fragments.has(far.id)
            ? getHostBonds(far.id, layout.positions.get(far.id) || anchorCenter, sizes.get(far.id), anchor)
            : getHostBonds(null, null, null, anchor);

          const best = findBestDockPosition(anchor, target, size, offset, hostBonds, obstacles, dockGap, placement, divider, local.id, layout.positions);
          if (!best) return false;
          layout.positions.set(local.id, { ...best.center, warnings: [] });
          layout.reserved.push(boxAt(best.center, size));
        }
        return true;
      };
      const packDominantOrStage = (fresh, relatedLinks, sizes, packingAxis) => {
        if (fresh.length < 2) return stagePack(fresh, relatedLinks, sizes, packingAxis);
        const sorted = fresh.slice().sort((a, b) => {
          const fragA = layout.fragments.get(a), fragB = layout.fragments.get(b);
          const countA = fragA?.atoms?.size || 0, countB = fragB?.atoms?.size || 0;
          if (countA !== countB) return countB - countA;
          const sizeA = sizes.get(a), sizeB = sizes.get(b);
          return (sizeB.width * sizeB.height) - (sizeA.width * sizeA.height);
        });
        const hostId = sorted[0];
        const hostFrag = layout.fragments.get(hostId);
        const hostAtoms = hostFrag?.atoms?.size || 0;
        const hostSize = sizes.get(hostId);
        const hostArea = hostSize.width * hostSize.height;
        const others = sorted.slice(1);

        const isDominant = hostAtoms >= 5 && others.length >= 1 && others.every(oId => {
          const oFrag = layout.fragments.get(oId);
          const oAtoms = oFrag?.atoms?.size || 0;
          const oArea = sizes.get(oId).width * sizes.get(oId).height;
          return hostAtoms > oAtoms && hostArea >= 1.8 * oArea;
        });

        const linkedOthers = others.filter(oId => relatedLinks.some(([a, b]) => (a.id === oId && b.id === hostId) || (b.id === oId && a.id === hostId)));

        if (!isDominant || !linkedOthers.length) {
          return stagePack(fresh, relatedLinks, sizes, packingAxis);
        }

        const hostBox = boxAt({ x: 0, y: 0 }, hostSize);
        const positions = new Map([[hostId, { x: 0, y: 0 }]]);
        const reserved = [hostBox];
        const hostBonds = getHostBonds(hostId, { x: 0, y: 0 }, hostSize, hostBox);
        const dockGap = Math.max(LAYOUT.groupGap, 0.90);
        const placement = packingAxis === 'y' ? 'vertical' : 'horizontal';

        const orderedOthers = others.slice().sort((a, b) => {
          const aLinked = linkedOthers.includes(a), bLinked = linkedOthers.includes(b);
          return (bLinked ? 1 : 0) - (aLinked ? 1 : 0);
        });

        for (const oId of orderedOthers) {
          const oSize = sizes.get(oId);
          const linked = relatedLinks.find(([a, b]) => (a.id === oId && b.id === hostId) || (b.id === oId && a.id === hostId));
          let target, offset;
          if (linked) {
            const [near, far] = linked[0].id === oId ? [linked[0], linked[1]] : [linked[1], linked[0]];
            target = { x: far.point.x - hostSize.center.x, y: far.point.y - hostSize.center.y };
            offset = { x: near.point.x - oSize.center.x, y: near.point.y - oSize.center.y };
          } else {
            target = { x: 0, y: 0 };
            offset = { x: 0, y: 0 };
          }
          const best = findBestDockPosition(hostBox, target, oSize, offset, hostBonds, reserved, dockGap, placement, -Infinity, oId, positions);
          if (!best) return stagePack(fresh, relatedLinks, sizes, packingAxis);
          positions.set(oId, best.center);
          reserved.push(boxAt(best.center, oSize));
        }

        const box = unionBoxes(fresh.map(id => boxAt(positions.get(id), sizes.get(id))));
        const center = midpoint(box);
        for (const p of positions.values()) { p.x -= center.x; p.y -= center.y; }

        const anchor = end => {
          const p = positions.get(end.id), c = sizes.get(end.id).center;
          return { x: p.x + end.point.x - c.x, y: p.y + end.point.y - c.y };
        };
        return {
          positions,
          width: box.x2 - box.x1,
          height: box.y2 - box.y1,
          cost: relatedLinks.reduce((sum, [from, to]) => sum + M.dist(anchor(from), anchor(to)), 0)
        };
      };
      const placeSide = (members, packingAxis, anchor, axis, direction, gap, { stageId, rowY, stageWidth = 0, breakBefore = false } = {}) => {
        const fresh = [...new Set(members.filter(member => !boxFor(member)).map(member => member.id))];
        if (!fresh.length) return;
        const freshSet = new Set(fresh);
        const relatedLinks = links.filter(([from, to]) => freshSet.has(from.id) && freshSet.has(to.id));
        let packed;
        if (relatedLinks.length > 0) {
          packed = packDominantOrStage(fresh, relatedLinks, sizes, packingAxis);
        } else {
          let fallbackLinks = [];
          if (fresh.length >= 2) {
            const hostCandidates = fresh.filter(id => {
              const frag = layout.fragments.get(id);
              return (frag?.atoms?.size || 0) >= 5;
            });
            if (hostCandidates.length === 1) {
              const hostId = hostCandidates[0];
              const hostFrag = layout.fragments.get(hostId);
              const hostAtoms = hostFrag?.atoms?.size || 0;
              const hostSize = sizes.get(hostId);
              const hostArea = hostSize.width * hostSize.height;
              const others = fresh.filter(id => id !== hostId);
              const allSmall = others.length >= 1 && others.every(oId => {
                const oFrag = layout.fragments.get(oId);
                const oAtoms = oFrag?.atoms?.size || 0;
                const oArea = sizes.get(oId).width * sizes.get(oId).height;
                return oAtoms < hostAtoms && hostArea >= 1.8 * oArea;
              });
              const hostMember = members.find(m => m.id === hostId && m.point);
              if (allSmall && hostMember && Math.hypot(hostMember.point.x - hostSize.center.x, hostMember.point.y - hostSize.center.y) > 0.75) {
                fallbackLinks = others.map(oId => {
                  const oMember = members.find(m => m.id === oId && m.point) || { id: oId, point: sizes.get(oId).center };
                  return [oMember, hostMember];
                });
              }
            }
          }
          packed = fallbackLinks.length > 0
            ? packDominantOrStage(fresh, fallbackLinks, sizes, packingAxis)
            : stagePack(fresh, [], sizes, packingAxis);
        }
        const obstacles = stageObstacles.concat(layout.reserved);
        const origin = run.stageOrigins.get(stageId);
        const center = anchor ? midpoint(anchor) : (origin ? { ...origin } : {
          x: paperTarget() ? view.x1 + packed.width / 2 : view.x1 + (view.x2 - view.x1) * 0.28,
          y: paperTarget() ? view.y1 + packed.height / 2 : (view.y1 + view.y2) / 2
        });
        if (anchor) {
          const half = (axis === 'x' ? packed.width : packed.height) / 2;
          center[axis] = anchor[axis + (direction > 0 ? '2' : '1')] + direction * (gap + half);
          if (rowY !== undefined) center.y = rowY;
        } else if (!run.stageOrigins.has(stageId) || run.readingOrder) {
          if (run.readingOrder) {
            const previousRows = [...layout.stageFlow.values(), ...[...reactionConnectors.values()]
              .filter(connectorStillDrawn).map(record => record.flow)].filter(flow => flow?.reading);
            if (previousRows.length) {
              const previous = previousRows.reduce((best, flow) =>
                !best || flow.rowY > best.rowY || (flow.rowY === best.rowY && (flow.rowRight || 0) > (best.rowRight || 0)) ? flow : best, null);
              const rowLeft = run.separatePaths ? Math.min(...previousRows.map(flow => flow.rowLeft)) : previous.rowLeft;
              const rowRight = previous.rowRight ?? rowLeft;
              const nextLeft = rowRight + LAYOUT.groupGap;
              const wrap = run.separatePaths || breakBefore || previous.steps >= LAYOUT.rowSteps ||
                nextLeft + packed.width + stageWidth > rowLeft + readingWidth(LAYOUT.independentRowWidth);
              center.x = (wrap ? rowLeft : nextLeft) + packed.width / 2;
              const bottom = run.separatePaths ? Math.max(...previousRows.map(flow => flow.rowBottom)) : previous.rowBottom;
              center.y = wrap ? bottom + LAYOUT.readingRowGap + packed.height / 2 : previous.rowY;
              independentRows.set(stageId, wrap ? null : previous);
            }
          }
          run.stageOrigins.set(stageId, center);
        }
        let placed = anchor ? clearAlong(center, packed, obstacles, gap, axis, direction)
          : run.readingOrder ? clearAlong(center, packed, obstacles, LAYOUT.minReactionGap, independentRows.get(stageId) ? 'x' : 'y', 1)
          : openCanvasCenter(center, packed, obstacles, LAYOUT.minReactionGap);
        const previousRow = independentRows.get(stageId);
        if (!anchor && previousRow && placed.x + packed.width / 2 + stageWidth > previousRow.rowLeft + readingWidth(LAYOUT.independentRowWidth)) {
          const nextRow = { x: previousRow.rowLeft + packed.width / 2,
            y: previousRow.rowBottom + LAYOUT.readingRowGap + packed.height / 2 };
          placed = clearAlong(nextRow, packed, obstacles, LAYOUT.minReactionGap, 'y', 1);
          independentRows.set(stageId, null);
        }
        placePackedStage(packed, placed, layout);
        layout.reserved.push(boxAt(placed, packed));
      };
      const placeNewRow = (members, rowLeft, rowBottom, gap) => {
        const ids = [...new Set(members.map(member => member.id))];
        const packed = stagePack(ids, [], sizes, 'x');
        const row = continuationPosition(packed, rowLeft, rowBottom, gap, stageObstacles.concat(layout.reserved));
        placePackedStage(packed, row.center, layout);
        layout.reserved.push(row.box);
      };
      for (const { op } of ordered) {
        const from = side(op.reactants), to = side(op.products);
        if (from.concat(to).some(member => explicit.has(member.id))) continue;
        for (const { id } of from.concat(to)) if (id) layout.waiting.add(id);
        const fromReady = from.every(member => member.box || (member.id && !waitingProducts.has(member.id)));
        const toReady = to.every(member => member.id || member.box);
        if (!fromReady || !toReady) for (const { id } of to) if (id && !layout.positions.has(id)) waitingProducts.add(id);
        if (!fromReady) continue;
        const fixed = boxesFor(from), fixedTargets = boxesFor(to);
        const packingAxis = op.layout.reactantPlacement === 'vertical' ? 'y' : 'x';
        const gap = op.layout.conditions ? Math.max(LAYOUT.stepGap, conditionWidth(op.layout.conditions) + 0.7) : LAYOUT.stepGap;
        if (fixed.length) {
          if (!dockReactant(from, op.layout.reactantPlacement)) {
            placeSide(from, packingAxis, unionBoxes(fixed), packingAxis, packingAxis === 'y' ? -1 : 1, 2 * LAYOUT.groupGap);
          }
        }
        else {
          const targetIds = [...new Set(to.filter(member => member.id && sizes.has(member.id)).map(member => member.id))];
          const targetWidth = targetIds.length ? stagePack(targetIds, [], sizes, 'x').width : 0;
          placeSide(from, packingAxis, fixedTargets.length ? unionBoxes(fixedTargets) : null, 'x', -1, gap,
            { stageId: op.id, stageWidth: gap + targetWidth, breakBefore: op.layout.breakBefore });
        }
        if (!toReady) continue;
        const incoming = incomingStage(from.map(member => member.box).filter(Boolean));
        const linkedPrevious = from.map(member => plannedFlow.get(member.id)).find(Boolean) || incoming?.flow;
        const previous = linkedPrevious || independentRows.get(op.id);
        const previousSteps = previous?.steps || 0;
        const source = unionBoxes(boxesFor(from));
        const targetBox = fixedTargets.length ? unionBoxes(fixedTargets) : source;
        let wraps = op.layout.breakBefore ?? (previousSteps >= LAYOUT.rowSteps);
        let flow;
        if (run.readingOrder) {
          const rowLeft = previous?.rowLeft ?? source.x1, sourceRowY = previous?.rowY ?? midpoint(source).y;
          const targetWidth = to.reduce((sum, member) => sum + (sizes.get(member.id)?.width || 0) + LAYOUT.groupGap, 0);
          const rowWidth = paperTarget() ? readingWidth() : linkedPrevious ? (previous?.rowWidth ?? LAYOUT.readingRowWidth)
            : !run.separatePaths && independentRows.has(op.id) ? LAYOUT.independentRowWidth : LAYOUT.readingRowWidth;
          const tooWide = source.x2 + gap + targetWidth > rowLeft + rowWidth;
          wraps = !!linkedPrevious && !fixedTargets.length && previousSteps > 0 && (wraps || tooWide);
          if (wraps) placeNewRow(to, rowLeft, Math.max(previous?.rowBottom ?? source.y2, source.y2), gap);
          else placeSide(to, 'x', targetBox, 'x', 1, fixedTargets.length ? 2 * LAYOUT.groupGap : gap,
            { rowY: fixedTargets.length ? undefined : sourceRowY });
          const products = unionBoxes(boxesFor(to)), rowBottom = products.y2;
          const continuation = wraps ? nextContinuation(layout.stageFlow) : undefined;
          flow = { reading: true, forward: !fixedTargets.length, axis: 'x', direction: 1, rowLeft,
            rowY: wraps ? midpoint(products).y : sourceRowY,
            rowBottom: wraps ? rowBottom : Math.max(rowBottom, previous?.rowBottom ?? source.y2, source.y2),
            rowRight: products.x2, rowWidth,
            steps: wraps ? 1 : previousSteps + 1, ...(wraps && { continuation, sourceRowY }) };
        } else {
          placeSide(to, 'x', targetBox, fixedTargets.length || !wraps ? 'x' : 'y', 1, fixedTargets.length ? 2 * LAYOUT.groupGap : wraps ? LAYOUT.stepGap : gap);
          flow = { direction: 1, steps: wraps ? 0 : previousSteps + 1, axis: wraps ? 'y' : 'x' };
        }
        layout.stageFlow.set(op.id, flow);
        for (const { id } of to) if (id) { waitingProducts.delete(id); plannedFlow.set(id, flow); }
      }
    }
    function planAdditions(ops, prepared, view, occupied, run) {
      const fragments = new Map();
      const layout = { fragments, positions: new Map(), preferred: new Map(), reserved: [], follow: [],
        waiting: new Set(), stageFlow: new Map() };
      const atoms = new Map(), atomAnchors = new Map(), bondAnchors = new Map(), bondPairAnchors = new Map(), pairs = new Map();
      const bondPairKey = (first, second) => first < second ? first + '|' + second : second + '|' + first;
      for (const op of ops) {
        if (op.type === 'lonePair.add') pairs.set(op.id, op.atom);
        if (op.type !== 'molecule.add') continue;
        const data = prepared.get(op.id);
        const fragment = native.prepareKet(JSON.stringify(data.ket));
        fragments.set(op.id, fragment);
        for (const atom of data.atoms) {
          const key = op.id + ':' + atom.ref;
          atoms.set(key, op.id);
          atomAnchors.set(key, { id: op.id, point: fragment.atoms.get(atom.index).pp });
        }
        for (const record of data.bonds) {
          const bond = fragment.bonds.get(record.index);
          const point = M.lerp(fragment.atoms.get(bond.begin).pp, fragment.atoms.get(bond.end).pp, 0.5);
          const anchor = { id: op.id, point };
          bondAnchors.set(op.id + ':bond:' + record.ref, anchor);
          bondAnchors.set(op.id + ':' + record.ref, anchor);
          bondPairAnchors.set(bondPairKey(op.id + ':' + record.begin, op.id + ':' + record.end), anchor);
        }
      }
      // A mixed editing batch allocates against live geometry after each edit.
      if (!view || !fragments.size || (!run.readingOrder && ops.some(op => !op.type.endsWith('.add')))) return layout;
      const ctx = controller.ctx(), links = [], arrowRoutes = [];
      const atomAnchor = ref => {
        if (atomAnchors.has(ref)) return atomAnchors.get(ref);
        const atomId = run.atoms.get(ref) || ref, point = ctx.atomPos(atomId);
        return point && { point, atomId };
      };
      for (const op of ops) {
        if (op.type !== 'arrow.add') continue;
        const { source, target } = op;
        let from;
        if (source.type === 'bond') {
          if (source.bondId) {
            const id = run.bonds.get(source.bondId) || source.bondId, bond = ctx.bondInfo(id);
            from = bondAnchors.get(source.bondId) || (bond && { point: M.lerp(bond.begin, bond.end, 0.5), atomId: bond.beginAtom });
          } else {
            from = bondPairAnchors.get(bondPairKey(source.atom1, source.atom2));
            if (!from) {
              const atomA = run.atoms.get(source.atom1) || source.atom1, atomB = run.atoms.get(source.atom2) || source.atom2;
              const [bond] = matchingBonds(ctx.bonds(), atomA, atomB);
              if (bond) from = { point: M.lerp(bond.begin, bond.end, 0.5), atomId: bond.beginAtom };
            }
          }
        } else if (source.type === 'lonePair') {
          const pair = model.lonePair(run.entities.get(source.id) || source.id);
          const owner = pairs.get(source.id) || pair?.ownerAtomId;
          from = owner && atomAnchor(owner);
        } else from = atomAnchor(source.atomId);
        if (!from) continue;
        const refs = target.type === 'atom' ? [target.atomId] : [target.atom1, target.atom2];
        for (const ref of refs) {
          const to = atomAnchor(ref);
          if (to) {
            arrowRoutes.push({ from, to });
            if (from.id !== to.id) links.push([from, to]);
          }
        }
      }
      const connectors = ops.filter(isStepDeclaration);
      const declared = run.readingOrder ? connectors.map(op => ({ ...op, layout: op.layout || {} })) : connectors.filter(op => op.layout);
      reserveDeclaredStages(declared, atomAnchors, links, arrowRoutes, ops, layout, view, occupied, run);
      // Keep unresolved declared sides out of the free-placement fallback in preview.
      const looseLinks = links.filter(pair => pair.every(member => !layout.waiting.has(member.id) || layout.positions.has(member.id)));
      const preferRelated = () => {
        for (const [from, to] of looseLinks) {
          for (const [fresh, placed] of [[from, to], [to, from]]) {
            if (!fresh.id || layout.positions.has(fresh.id) || layout.preferred.has(fresh.id)) continue;
            const oldCenter = placed.id ? layout.positions.get(placed.id) : placed.point;
            if (!oldCenter) continue;
            const freshCenter = fragmentBounds(fragments.get(fresh.id)).center;
            const placedCenter = placed.id && fragmentBounds(fragments.get(placed.id)).center;
            const goal = placedCenter ? { x: oldCenter.x + placed.point.x - placedCenter.x, y: oldCenter.y + placed.point.y - placedCenter.y } : oldCenter;
            layout.preferred.set(fresh.id, { x: goal.x + freshCenter.x - fresh.point.x, y: goal.y + freshCenter.y - fresh.point.y });
          }
        }
      };
      preferRelated();
      // Reaction stages take precedence over proximity links between reacting atoms.
      if (!run.readingOrder) reserveReactionStages(connectors.filter(op => !op.layout), atoms, looseLinks, layout, view, occupied, run);

      const linked = [];
      for (const [from, to] of looseLinks) {
        if (!from.id || !to.id || layout.positions.has(from.id) || layout.positions.has(to.id)) continue;
        const members = new Set([from.id, to.id]);
        for (let i = linked.length - 1; i >= 0; i--) {
          if (!linked[i].some(id => members.has(id))) continue;
          for (const id of linked[i]) members.add(id);
          linked.splice(i, 1);
        }
        linked.push([...fragments.keys()].filter(id => members.has(id)));
      }
      for (const group of linked) reserveStageGroup(group, links, layout, view, occupied);
      preferRelated();
      return layout;
    }
    function placement(op, run, view, fragment, occupied = occupiedBoxes(), layout) {
      const planned = layout?.positions.get(op.id);
      if (planned) return planned;
      const textLines = op.type === 'text.add' ? op.text.split('\n') : null;
      const size = fragment ? fragmentBounds(fragment) : textLines
        ? { width: Math.max(...textLines.map(conditionWidth)), height: Math.max(0.8, textLines.length * 0.55) }
        : { width: 2, height: 0.8 };
      const limits = centerLimits(view, size);
      if (!inside(run.anchor, view)) run.anchor = midpoint(view);
      const explicit = own(op, 'x') || own(op, 'y');
      const preferred = layout?.preferred.get(op.id);
      const requested = { x: op.x ?? preferred?.x ?? run.anchor.x, y: op.y ?? preferred?.y ?? run.anchor.y };
      const hash = canonical(op), prior = run.placements.get(op.id);
      const cached = prior?.hash === hash ? prior : null;
      const obstacles = layout ? occupied.concat(layout.reserved) : occupied;
      const gap = preferred ? 2 * LAYOUT.groupGap : LAYOUT.minReactionGap;
      let pos = !preferred && !explicit && inside(cached, limits) && !boxesOverlap(boxAt(cached, size), obstacles, gap) ? cached : null;
      if (explicit || (preferred && !inside(requested, view))) {
        pos = openCanvasCenter(requested, size, obstacles, gap);
      } else if (!pos && limits.x1 <= limits.x2 && limits.y1 <= limits.y2) {
        const start = clampPoint(requested, limits);
        pos = nearestFreeCenter(start, size, obstacles, preferred ? gap : LAYOUT.reactionGap, limits)
          || nearestFreeCenter(start, size, obstacles, gap, limits);
      }
      if (!pos || (preferred && !explicit && M.dist(requested, pos) > 3)) {
        const nearby = openCanvasCenter(requested, size, obstacles, gap);
        if (!pos || M.dist(requested, nearby) < M.dist(requested, pos)) pos = nearby;
      }
      const adjusted = explicit && (pos.x !== requested.x || pos.y !== requested.y);
      const warnings = adjusted ? ['位置与已有内容重叠，已在附近避让'] : [];
      const result = { x: pos.x, y: pos.y, adjusted, warnings };
      run.placements.set(op.id, { x: pos.x, y: pos.y, hash });
      const box = boxAt(pos, size);
      occupied.push(box);
      if (!explicit && !inside(pos, limits)) layout?.follow.push(box);
      return result;
    }
    function textAnchor(op, placed) {
      // Native text positions are the top-left anchor, while automatic space
      // allocation reserves a centred box. Preserve explicit coordinates and
      // the existing infinite-canvas contract.
      if (!paperTarget() || own(op, 'x') || own(op, 'y')) return placed;
      const lines = op.text.split('\n');
      return { ...placed, x: placed.x - Math.max(...lines.map(conditionWidth)) / 2,
        y: placed.y - Math.max(0.8, lines.length * 0.55) / 2 };
    }
    async function prepare(ops, signal) {
      const data = new Map();
      await Promise.all(ops.map(async op => {
        try {
          if (op.type === 'molecule.add') data.set(op.id, await structure(op.smiles, signal));
        } catch (error) { throw operationError(error, 'prepare', op); }
      }));
      return data;
    }
    // Capture staged topology synchronously, then request layout only after
    // the staging transaction has restored the input canvas in full.
    function captureTidySnapshot() {
      try { return JSON.parse(native.serialize(ed.struct())); }
      catch (error) { fail('无法读取画布内容进行整理', 'layout_failed'); }
    }
    async function tidySnapshot(signal, doc = captureTidySnapshot()) {
      const ketText = JSON.stringify(doc);
      const keys = (MW.adapter.orderedMoleculeKeys || orderedMoleculeKeysLocal)(doc);
      if (!keys.length) fail('画布上没有分子', 'layout_failed');
      abort(signal);
      const response = await (options.fetch || root.fetch)('/api/layout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ket: ketText, mode: 'preserve' }), signal
      });
      const json = await response.json();
      if (!response.ok || json.ok !== true) return { ok: false, error: (json && json.error) || '整理失败', code: 'layout_failed' };
      for (const molecule of json.molecules || []) {
        if (!Array.isArray(molecule.atoms) || !molecule.atoms.every(entry => Array.isArray(entry) && Number.isFinite(entry[0]) && Number.isFinite(entry[1]))) {
          return { ok: false, error: '整理结果坐标无效', code: 'layout_failed' };
        }
      }
      return { ok: true, doc, molecules: json.molecules || [], keys, coordinateScale: json.coordinateScale, warnings: json.warnings || [], skipped: json.skipped || [] };
    }
    function orderedMoleculeKeysLocal(doc) {
      const out = [];
      const nodes = (doc.root && doc.root.nodes) || [];
      for (const node of nodes) if (node && node.$ref && doc[node.$ref] && doc[node.$ref].type === 'molecule') out.push(node.$ref);
      return out;
    }
    function inheritRun(run, resumeRunId) {
      const previous = runs.get(resumeRunId);
      if (!previous || previous.sessionId !== run.sessionId || previous === run) return undefined;
      a.syncIdentity();
      run.atoms = new Map([...previous.atoms].filter(([, id]) => a.atomIdOf(id) !== null));
      run.bonds = new Map([...previous.bonds].filter(([, id]) => a.bondIdOf(id) !== null));
      run.entities = new Map([...previous.entities].filter(([, id]) => model.arrow(id) || model.lonePair(id)));
      run.steps = new Map([...previous.steps].filter(([, id]) => findStep(id)));
      run.automaticPairs = new Set([...previous.automaticPairs].filter(id => model.lonePair(id)));
      // Keep the ledger even after a user undo. Replaying a committed ID
      // must never resurrect the objects that the user removed.
      run.applied = new Map(previous.applied);
      return { atoms: Object.fromEntries(run.atoms), bonds: Object.fromEntries(run.bonds), entities: Object.fromEntries(run.entities) };
    }
    function tablesFor(run) { return { atoms: new Map(run.atoms), bonds: new Map(run.bonds), entities: new Map(run.entities), steps: new Map(run.steps),
      molecules: new Map(connectedComponents().map(part => [part.handle, part.uuids.slice()])) }; }
    function response(run, result, summary) {
      const mapping = Object.create(null);
      for (const [key, value] of run.bonds) { mapping[key] = value; if (!key.includes(':bond:')) mapping[key.replace(/:([^:]*)$/, ':bond:$1')] = value; }
      for (const [key, value] of run.atoms) mapping[key] = value;
      for (const [key, value] of run.entities) mapping[key] = value;
      const st = ed.struct();
      return { sessionId, revision, created: copy(result.created), updated: copy(result.updated), deleted: copy(result.deleted),
        cascaded: copy(result.cascaded), warnings: copy(result.warnings), mapping,
        steps: copy(result.steps || []), stepMapping: Object.fromEntries(run.steps), ...(result.replayed && { replayed: true }),
        canvas: { atoms: st.atoms.size, bonds: st.bonds.size, molecules: connectedComponents().length,
          lonePairs: model.state.lonePairs.length, arrows: model.state.arrows.length, reactionArrows: st.rxnArrows.size },
        atomMapping: Object.fromEntries(run.atoms), bondMapping: Object.fromEntries(run.bonds), summary };
    }
    /* 受限结构编辑操作桥（v2 patch）。只有真正用到编辑操作时才要求存在，
       add-only 的旧包不受影响。 */
    function structOpsRequired() {
      const so = (doc.defaultView && doc.defaultView.molstudioNativeStructOps) || null;
      if (!so || so.version !== 1) fail('当前 Ketcher 缺少受支持的结构编辑 action bridge（需要 v2 补丁）', 'struct_ops_unavailable');
      return so;
    }
    function markMovedAtoms(ctab, rids) {
      for (const rid of rids) {
        if (typeof ctab.markAtom === 'function') ctab.markAtom(rid, 1);
        const reAtom = ctab.atoms ? ctab.atoms.get(rid) : null;
        const neighbors = reAtom && reAtom.a && Array.isArray(reAtom.a.neighbors) ? reAtom.a.neighbors : [];
        for (const hbId of neighbors) {
          const hb = ctab.molecule.halfBonds.get(hbId);
          if (hb && typeof ctab.markBond === 'function') ctab.markBond(hb.bid, 1);
        }
      }
    }
    /* 坐标移动动作：perform 执行新坐标并返回恢复旧坐标的动作（Ketcher 逆动作约定，
       与 canvas.html 的 makeUndoAction 同一模式；markItem 保证重绘）。 */
    function coordinateMoveAction(entries) {
      return {
        operations: entries.map(entry => ({ atomId: entry[0] })),
        isDummy: () => false,
        perform(ctab) {
          const st = ctab.molecule;
          const undo = [];
          for (const [rid] of entries) { const atom = st.atoms.get(rid); if (atom && atom.pp) undo.push([rid, atom.pp.x, atom.pp.y]); }
          for (const [rid, x, y] of entries) { const atom = st.atoms.get(rid); if (atom && atom.pp) { atom.pp.x = x; atom.pp.y = y; } }
          markMovedAtoms(ctab, entries.map(entry => entry[0]));
          return coordinateMoveAction(undo);
        }
      };
    }
    /* Ketcher Operation 逆动作包装：forwardOps 已在事务里立即执行，
       返回的动作 perform 时按相反顺序执行它们的逆操作。
       recalcRids：undo/redo 后需要重算隐氢与立体标签的原子（双向都补算）。 */
    function inverseOpsAction(inverses, recalcRids) {
      return {
        operations: inverses.slice(),
        isDummy: () => false,
        perform(ctab) {
          const redos = [];
          for (let i = inverses.length - 1; i >= 0; i--) redos.push(inverses[i].perform(ctab));
          if (recalcRids && recalcRids.length) structOpsRequired().recalc(ctab.molecule, recalcRids);
          return inverseOpsAction(redos, recalcRids);
        }
      };
    }
    /* 每组操作的已执行部分也要参与事务回滚，包括最后重算失败的情况。 */
    function forwardOps(so, specs, ctab, signal, actions, forwardRecalc) {
      const inverses = [];
      try {
        for (const spec of specs) {
          abort(signal);
          inverses.push(spec.make().perform(ctab));
        }
        if (forwardRecalc && forwardRecalc.length) so.recalc(ctab.molecule, forwardRecalc);
      } finally {
        if (inverses.length) actions.push(inverseOpsAction(inverses, forwardRecalc));
      }
    }
    function sanitizeHypervalentRadicals(so, ctab, rids, signal, actions, opId, warnings) {
      if (!ctab?.molecule?.atoms) return;
      for (const rid of rids) {
        const at = ctab.molecule.atoms.get(rid);
        if (at && (at.radical || 0) > 0 && at.badConn) {
          forwardOps(so, [{ make: () => new so.atomAttr(rid, 'radical', 0) }], ctab, signal, actions, [rid]);
          if (warnings && opId) warnings.push(opId + ': 已自动清除超价原子上的残留自由基标记');
        }
      }
    }
    function captureAtomCoords(st, rids) { return rids.map(rid => { const atom = st.atoms.get(rid); return atom && atom.pp ? [rid, atom.pp.x, atom.pp.y] : null; }).filter(Boolean); }
    function placeLooseHydrogen(begin, end, ctx, canMove) {
      const beginIsH = ctx.atomLabel(begin) === 'H', endIsH = ctx.atomLabel(end) === 'H';
      if (beginIsH === endIsH) return null;
      const id = beginIsH ? begin : end, owner = beginIsH ? end : begin;
      if (!canMove(id)) return null;
      const old = ctx.atomPos(id), origin = ctx.atomPos(owner);
      if (!old || !origin) return null;
      const span = M.dist(old, origin);
      if (span >= 0.75 && span <= 1.25) return null;
      const bonds = ctx.bonds();
      if (bonds.some(bond => bond.beginAtom === id || bond.endAtom === id)) return null;
      const angleTo = point => Math.atan2(point.y - origin.y, point.x - origin.x) * 180 / Math.PI;
      const preferred = angleTo(old);
      const neighbors = bonds.flatMap(bond => bond.beginAtom === owner ? [angleTo(bond.end)]
        : bond.endAtom === owner ? [angleTo(bond.begin)] : []);
      const obstacles = ctx.atoms().filter(atom => atom.uuid !== owner && atom.uuid !== id && M.dist(origin, atom.pos) < 2);
      const reference = neighbors[0] ?? preferred;
      let best, score = -Infinity;
      for (let i = 0; i < 24; i++) {
        const degrees = reference + i * 15, angle = degrees * Math.PI / 180;
        const position = { x: origin.x + Math.cos(angle), y: origin.y + Math.sin(angle) };
        const angleGap = other => Math.abs(M.normalizeDelta(degrees - other));
        const clearance = Math.min(1, ...obstacles.map(atom => M.dist(position, atom.pos)));
        const openAngle = Math.min(120, ...neighbors.map(angleGap));
        const ideal = neighbors.length === 1 ? Math.abs(angleGap(reference) - 120) : 0;
        const rating = clearance + openAngle / 120 - ideal / 360 - angleGap(preferred) / 3600;
        if (rating > score) { best = position; score = rating; }
      }
      return { id, position: best };
    }
    function captureBondState(st, bids) {
      return bids.map(bid => {
        const bond = st.bonds.get(bid);
        return bond ? [bid, bond.begin, bond.end, bond.stereo || 0, bond.hb1, bond.hb2] : null;
      }).filter(Boolean);
    }
    function applyAtomCoords(st, entries) {
      for (const [rid, x, y] of entries) { const atom = st.atoms.get(rid); if (atom && atom.pp) { atom.pp.x = x; atom.pp.y = y; } }
    }
    function applyBondState(st, entries) {
      for (const [bid, begin, end, stereo, hb1, hb2] of entries) {
        const bond = st.bonds.get(bid);
        if (!bond) continue;
        bond.begin = begin; bond.end = end; bond.stereo = stereo;
        if (hb1 !== undefined) bond.hb1 = hb1;
        if (hb2 !== undefined) bond.hb2 = hb2;
      }
    }
    function tidyAction(coords, bonds) {
      return {
        operations: coords.map(entry => ({ atomId: entry[0] })),
        isDummy: () => false,
        perform(ctab) {
          const st = ctab.molecule;
          const nowCoords = captureAtomCoords(st, coords.map(entry => entry[0]));
          const nowBonds = captureBondState(st, bonds.map(entry => entry[0]));
          applyAtomCoords(st, coords); applyBondState(st, bonds);
          markMovedAtoms(ctab, coords.map(entry => entry[0]));
          for (const entry of bonds) if (typeof ctab.markBond === 'function') ctab.markBond(entry[0], 1);
          return tidyAction(nowCoords, nowBonds);
        }
      };
    }
    /* 目标解析：冻结批次开始时的分子成员，随后按稳定成员校验；或显式原子集合。 */
    function resolveTargetAtoms(target, tables, warnings) {
      if (target.molecule !== undefined) {
        const found = resolveMoleculeHandle(target.molecule, tables.molecules, connectedComponents());
        const rids = found.rids;
        const uuids = rids.map(rid => a.uuidOfAtom(rid)).filter(Boolean);
        for (const uuid of uuids) if (a.atomIdOf(uuid) === null) fail('分子成员引用失效：' + uuid, 'missing_reference');
        if (uuids.length > MAX_TARGET_ATOMS) fail('目标分子超出单次操作范围');
        return { rids, uuids, handle: found.handle };
      }
      const rids = [], uuids = [];
      for (const value of target.atoms) {
        const uuid = tables.atoms.get(value) || value;
        const rid = a.atomIdOf(uuid);
        if (rid === null) fail('原子引用不存在：' + value, 'missing_reference');
        if (!rids.includes(rid)) { rids.push(rid); uuids.push(uuid); }
      }
      if (!rids.length) fail('目标为空', 'missing_reference');
      if (warnings) warnings.push('目标按原子集合处理，未自动扩展为完整分子');
      return { rids, uuids, handle: null };
    }
    function hydrogenEnvironment(ctx) {
      const st = ed.struct(), props = new Map(a.chemSnapshot().atoms.map(atom => [atom.uuid, atom]));
      const atoms = Array.from(st.atoms, ([rid, atom]) => {
        const id = a.uuidOfAtom(rid), point = ctx ? ctx.atomPos(id) : a.atomPos(rid);
        return { id, ...props.get(id), label: atom.label, x: point?.x, y: point?.y,
          stereoLabel: atom.stereoLabel, stereoParity: atom.stereoParity, alias: atom.alias, implicitHCount: atom.implicitHCount };
      });
      const bonds = Array.from(st.bonds, ([bid, bond]) => ({ id: a.uuidOfBond(bid), begin: a.uuidOfAtom(bond.begin), end: a.uuidOfAtom(bond.end),
        order: bond.type, aromatic: bond.type === 4, stereo: bond.stereo || 0 }));
      const stereoAtomIds = [];
      for (const fragment of st.frags?.values() || []) for (const rid of fragment?.stereoAtoms || []) {
        const id = a.uuidOfAtom(rid); if (id) stereoAtomIds.push(id);
      }
      if (ctx) {
        const known = new Set(atoms.map(atom => atom.id));
        for (const atom of ctx.atoms()) if (!known.has(atom.uuid)) {
          const point = ctx.atomPos(atom.uuid); atoms.push({ ...atom, id: atom.uuid, x: point?.x, y: point?.y });
        }
        const knownBonds = new Set(bonds.map(bond => bond.id));
        for (const bond of ctx.bonds()) if (!knownBonds.has(bond.uuid)) bonds.push({ id: bond.uuid, begin: bond.beginAtom, end: bond.endAtom,
          order: bond.type, aromatic: bond.type === 4, stereo: bond.stereo || 0 });
      }
      return { atoms, bonds, stereoAtomIds };
    }
    function hydrogenOrientation(op, tables, ctx) {
      const hydrogenId = tables.atoms.get(op.target.atoms[0]) || op.target.atoms[0];
      const towardAtomId = tables.atoms.get(op.orientTowardAtomId) || op.orientTowardAtomId;
      return orientTerminalHydrogen({ hydrogenId, towardAtomId, ...hydrogenEnvironment(ctx) });
    }
    function explicitHydrogenPosition(parentId, newId, ctx) {
      const parent = ctx.atomPos(parentId);
      if (!parent) fail('显式氢的母原子坐标不存在', 'missing_reference');
      const seed = { x: parent.x + 3, y: parent.y };
      const virtual = Object.assign({}, ctx, {
        atomPos: id => id === newId ? seed : ctx.atomPos(id),
        atomLabel: id => id === newId ? 'H' : ctx.atomLabel(id),
        atoms: () => ctx.atoms().concat([{ uuid: newId, label: 'H', pos: seed }])
      });
      const placed = placeLooseHydrogen(parentId, newId, virtual, id => id === newId);
      if (!placed) fail('不能为显式氢确定局部位置', 'hydrogen_explicit_geometry');
      return placed.position;
    }
    function connectedComponents() {
      const st = ed.struct();
      const adjacency = new Map();
      const rids = Array.from(st.atoms.keys());
      for (const rid of rids) adjacency.set(rid, []);
      for (const [, bond] of st.bonds) {
        if (!adjacency.has(bond.begin) || !adjacency.has(bond.end)) continue;
        adjacency.get(bond.begin).push(bond.end);
        adjacency.get(bond.end).push(bond.begin);
      }
      const seen = new Set(), components = [];
      const pointsOf = group => group.map(rid => a.atomPos(rid)).filter(Boolean);
      for (const rid of rids) {
        if (seen.has(rid)) continue;
        const stack = [rid], group = [];
        seen.add(rid);
        while (stack.length) {
          const current = stack.pop();
          group.push(current);
          for (const next of adjacency.get(current) || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
        }
        const points = pointsOf(group);
        components.push({
          handle: 'mol:' + (components.length + 1),
          rids: group.slice().sort((x, y) => x - y),
          uuids: group.map(id => a.uuidOfAtom(id)).filter(Boolean).sort(),
          center: points.length ? { x: (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2, y: (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2 } : { x: 0, y: 0 }
        });
      }
      return components;
    }
    function reactionMoleculeBoxes(draftPositions, draftBonds) {
      const result = new Map(), pad = LAYOUT.labelPad;
      const register = (ids, points) => {
        if (!points.length) return;
        const box = { x1: Math.min(...points.map(p => p.x)) - pad, y1: Math.min(...points.map(p => p.y)) - pad,
          x2: Math.max(...points.map(p => p.x)) + pad, y2: Math.max(...points.map(p => p.y)) + pad,
          component: [...ids].sort().join('|') };
        box.anchorBox = { x1: box.x1, x2: box.x2, y1: box.y1, y2: box.y2 };
        // Native methyl/hydrogen labels are asymmetric and can extend well
        // beyond a fixed atom padding. Keep their measured offsets while the
        // executor translates structures before the next native repaint.
        for (const id of ids) {
          const glyph = reactionGlyphOffsets.get(id), rid = a.atomIdOf(id);
          const point = draftPositions?.get(id) || (rid === null ? null : a.atomPos(rid));
          if (!glyph || !point) continue;
          box.x1 = Math.min(box.x1, point.x + glyph.x1 - 0.08); box.x2 = Math.max(box.x2, point.x + glyph.x2 + 0.08);
          box.y1 = Math.min(box.y1, point.y + glyph.y1 - 0.08); box.y2 = Math.max(box.y2, point.y + glyph.y2 + 0.08);
        }
        box.inkBox = { x1: box.x1, x2: box.x2, y1: box.y1, y2: box.y2 };
        // Reserve enough room for asymmetric labels while keeping the chemical
        // skeleton's centre as the alignment and translation anchor.
        const center = midpoint(box.anchorBox), halfWidth = Math.max(center.x - box.x1, box.x2 - center.x),
          halfHeight = Math.max(center.y - box.y1, box.y2 - center.y);
        box.x1 = center.x - halfWidth; box.x2 = center.x + halfWidth;
        box.y1 = center.y - halfHeight; box.y2 = center.y + halfHeight;
        for (const id of ids) result.set(id, box);
      };
      for (const part of connectedComponents()) register(part.uuids, part.rids.map(rid => a.atomPos(rid)).filter(Boolean));
      if (!draftPositions) return result;
      const neighbors = new Map([...draftPositions.keys()].map(id => [id, []]));
      for (const bond of draftBonds.values()) {
        neighbors.get(bond.beginId).push(bond.endId);
        neighbors.get(bond.endId).push(bond.beginId);
      }
      for (const id of neighbors.keys()) {
        if (result.has(id)) continue;
        const members = new Set([id]), stack = [id];
        while (stack.length) for (const next of neighbors.get(stack.pop())) {
          if (members.has(next)) continue;
          members.add(next);
          stack.push(next);
        }
        register(members, Array.from(members, key => draftPositions.get(key)));
      }
      return result;
    }
    function reactionSides(op, boxes, resolve) {
      const side = refs => [...new Set(refs.map(ref => {
        const box = boxes.get(resolve(ref));
        if (!box) fail('反应箭头引用的分子不存在', 'missing_reference');
        return box;
      }))];
      const reactants = side(op.reactants), products = side(op.products);
      if (reactants.some(box => products.includes(box))) fail('反应箭头两侧需要不同分子');
      const key = canonical([reactants.map(box => box.component).sort(), products.map(box => box.component).sort()]);
      return { reactants, products, key };
    }
    function knownConnector(key, pending) {
      const record = pending?.get(key) || reactionConnectors.get(key);
      return connectorStillDrawn(record);
    }
    function connectorStillDrawn(record) {
      if (!record) return false;
      const nativeArrow = ed.struct().rxnArrows.get(record.id);
      // Geometry is editable; the stable semantic step owns the native object,
      // not its old endpoint coordinates. Native IDs are rebound after reload/history.
      return nativeArrow === record.nativeArrow && !!nativeArrow;
    }
    function matchesConnector(arrow, record) {
      return arrow?.mode === record.mode && arrow.pos.length === 2 &&
        M.dist(arrow.pos[0], record.start) < 1e-5 && M.dist(arrow.pos[1], record.end) < 1e-5;
    }
    // Runtime IDs and native object references cannot survive KET reloads.
    // Persist locators into the exported KET and rebuild runtime references only
    // after stable atom bindings have been restored by the workbench loader.
    function exportReactionSteps(ket) {
      const nodes = ket.root?.nodes || [], arrows = nodes.map((node, i) => node.type === 'arrow' ? i : -1).filter(i => i >= 0);
      const texts = nodes.map((node, i) => node.type === 'text' ? i : -1).filter(i => i >= 0);
      const arrowIds = [...ed.struct().rxnArrows.keys()], textIds = [...ed.struct().texts.keys()];
      const steps = [];
      for (const record of reactionConnectors.values()) {
        if (!connectorStillDrawn(record) || ![...record.reactants, ...record.products].every(id => a.atomIdOf(id) !== null)) continue;
        const arrow = arrows[arrowIds.indexOf(record.id)];
        if (arrow === undefined) fail('反应步骤无法对应导出箭头', 'snapshot_failed');
        const labels = (record.labels || []).filter(label => ed.struct().texts.get(label.id)?.content === label.nativeContent).map(label => {
          const node = texts[textIds.indexOf(label.id)];
          if (node === undefined) fail('反应步骤无法对应导出标签', 'snapshot_failed');
          return { node, role: label.role, text: label.text, ...(label.role === 'graphPort' && {
            token: label.token, kind: label.kind, side: label.side, at: label.at, anchorRefs: label.anchorRefs.slice(),
            layoutX: label.layoutX, layoutY: label.layoutY,
            ...(label.at === 'molecule' && { anchorDx: label.anchorDx, anchorDy: label.anchorDy }) }) };
        });
        steps.push({ arrow, stepId: record.stepId, version: record.version, reactants: record.reactants.slice(), products: record.products.slice(),
          ...(record.layout && { layout: copy(record.layout) }),
          ...(record.flow && { flow: copy(record.flow) }), ...(record.conditions && { conditions: record.conditions }), ...(labels.length && { labels }) });
      }
      return steps;
    }
    function restoreReactionSteps(steps, ket, operations = []) {
      refreshReactionGlyphs();
      const nodes = ket.root.nodes, arrowIds = [...ed.struct().rxnArrows.keys()], textIds = [...ed.struct().texts.keys()];
      const index = (node, type) => nodes.slice(0, node + 1).filter(item => item.type === type).length - 1;
      const restored = new Map(), boxes = reactionMoleculeBoxes();
      for (const step of steps) {
        const id = arrowIds[index(step.arrow, 'arrow')], nativeArrow = ed.struct().rxnArrows.get(id);
        if (!nativeArrow || nativeArrow.pos.length !== 2) fail('反应步骤箭头恢复失败', 'load_failed');
        const sides = reactionSides(step, boxes, ref => ref);
        // Native import recentres/rescales the entire KET. Rebase the saved
        // layout using that import transform, retaining any displacement that
        // already existed between the source geometry and its saved anchors.
        const source = nodes[step.arrow].data?.pos?.map(point => ({ x: point.x, y: -point.y }));
        let scale = 1, dx = 0, dy = 0;
        if (source?.length === 2 && M.dist(source[0], source[1]) > 1e-8) {
          scale = M.dist(nativeArrow.pos[0], nativeArrow.pos[1]) / M.dist(source[0], source[1]);
          dx = nativeArrow.pos[0].x - scale * source[0].x; dy = nativeArrow.pos[0].y - scale * source[0].y;
        }
        const flow = step.flow && copy(step.flow);
        if (flow) {
          for (const key of ['rowLeft', 'rowRight', 'arrowStartX', 'arrowEndX']) if (Number.isFinite(flow[key])) flow[key] = flow[key] * scale + dx;
          for (const key of ['rowY', 'rowBottom', 'sourceRowY', 'arrowStartY', 'arrowEndY']) if (Number.isFinite(flow[key])) flow[key] = flow[key] * scale + dy;
          if (Number.isFinite(flow.rowWidth)) flow.rowWidth *= scale;
          if (flow.anchors) flow.anchors = flow.anchors.map(anchor => ({ atomId: anchor.atomId, x: anchor.x * scale + dx, y: anchor.y * scale + dy }));
        }
        const labels = (step.labels || []).map(label => {
          const id = textIds[index(label.node, 'text')], nativeText = ed.struct().texts.get(id);
          if (!nativeText) fail('反应步骤标签恢复失败', 'load_failed');
          const { node, ...data } = label;
          if (data.role === 'graphPort') {
            data.layoutX = data.layoutX * scale + dx; data.layoutY = data.layoutY * scale + dy;
            if (Number.isFinite(data.anchorDx)) data.anchorDx *= scale;
            if (Number.isFinite(data.anchorDy)) data.anchorDy *= scale;
          }
          return { ...data, id, nativeContent: nativeText.content };
        });
        if (restored.has(sides.key)) fail('反应步骤分子关联重复', 'load_failed');
        restored.set(sides.key, { id, nativeArrow, mode: nativeArrow.mode, stepId: step.stepId || 'rs-' + uid(), version: step.version || 1,
          ...(step.layout && { layout: copy(step.layout) }),
          reactants: step.reactants.slice(), products: step.products.slice(),
          productComponents: sides.products.map(box => box.component),
          start: { ...nativeArrow.pos[0] }, end: { ...nativeArrow.pos[1] }, labels,
          ...(flow && { flow }), ...(step.conditions && { conditions: step.conditions }) });
      }
      reactionConnectors.clear();
      for (const [key, record] of restored) reactionConnectors.set(key, record);
      stepOperations.clear();
      for (const operation of operations) stepOperations.set(operation.id, copy(operation));
    }
    function cloneConnector(record) {
      const { nativeArrow, ...data } = record;
      return { ...copy(data), nativeArrow };
    }
    function captureStepRuntime() {
      return { connectors: new Map([...reactionConnectors].map(([key, record]) => [key, cloneConnector(record)])),
        operations: new Map([...stepOperations].map(([key, value]) => [key, copy(value)])) };
    }
    function restoreStepRuntime(state, restoreOperations = true) {
      const records = state instanceof Map ? state : state.connectors;
      reactionConnectors.clear();
      for (const [key, value] of records) {
        const record = cloneConnector(value);
        record.nativeArrow = ed.struct().rxnArrows.get(record.id);
        reactionConnectors.set(key, record);
      }
      if (restoreOperations && state.operations) {
        stepOperations.clear();
        for (const [key, value] of state.operations) stepOperations.set(key, copy(value));
      }
    }
    function translateStepRuntime(state, options) {
      const { dx, dy } = options || {};
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail('步骤移动坐标无效', 'invalid_operation');
      const selected = options.nativeSelection || {}, atoms = new Set(options.atomIds || selected.atoms || []);
      const arrows = new Set(selected.rxnArrows || []), texts = new Set(selected.texts || []);
      const components = new Map();
      for (const part of connectedComponents()) for (const id of part.uuids) components.set(id, part.rids);
      const connectors = new Map();
      const shift = point => ({ ...point, x: point.x + dx, y: point.y + dy });
      for (const [key, source] of state.connectors) {
        const record = cloneConnector(source);
        const whole = arrows.has(record.id) && [...record.reactants, ...record.products].every(id =>
          components.get(id)?.every(rid => atoms.has(rid))) && (record.labels || []).every(label => texts.has(label.id));
        if (whole) {
          record.start = shift(record.start); record.end = shift(record.end);
          if (record.flow) {
            for (const name of ['rowLeft', 'rowRight', 'arrowStartX', 'arrowEndX']) if (Number.isFinite(record.flow[name])) record.flow[name] += dx;
            for (const name of ['rowY', 'rowBottom', 'sourceRowY', 'arrowStartY', 'arrowEndY']) if (Number.isFinite(record.flow[name])) record.flow[name] += dy;
            if (record.flow.anchors) record.flow.anchors = record.flow.anchors.map(shift);
            for (const value of Object.values(record.flow)) if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 10000)) fail('步骤移动超出可保存范围', 'invalid_operation');
          }
          for (const label of record.labels || []) if (label.role === 'graphPort') {
            label.layoutX += dx; label.layoutY += dy;
          }
        }
        connectors.set(key, record);
      }
      return { connectors, operations: new Map(state.operations || []) };
    }
    function scaleStepRuntime(state, options) {
      const { factor, anchor } = options || {};
      if (!Number.isFinite(factor) || factor <= 0) fail('步骤缩放比例无效', 'invalid_operation');
      if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) fail('步骤缩放锚点无效', 'invalid_operation');
      const selected = options.nativeSelection || {}, atoms = new Set(options.atomIds || selected.atoms || []);
      const arrows = new Set(selected.rxnArrows || []), texts = new Set(selected.texts || []);
      const components = new Map();
      for (const part of connectedComponents()) for (const id of part.uuids) components.set(id, part.rids);
      const connectors = new Map();
      for (const [key, source] of state.connectors) {
        const record = cloneConnector(source);
        const whole = arrows.has(record.id) && [...record.reactants, ...record.products].every(id =>
          components.get(id)?.every(rid => atoms.has(rid))) && (record.labels || []).every(label => texts.has(label.id));
        const { nativeArrow, ...data } = record;
        const scaled = scaleStepRecord(data, { factor, anchor, whole });
        for (const value of Object.values(scaled.flow || {})) if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 10000)) fail('步骤缩放超出可保存范围', 'invalid_operation');
        connectors.set(key, { ...scaled, nativeArrow });
      }
      return { connectors, operations: new Map(state.operations || []) };
    }
    function checkedStepClipboard(data) {
      const planner = MW.reactionStepClipboard;
      if (!planner) fail('当前构建缺少反应步骤复制模块', 'clipboard_steps_unavailable');
      const result = planner.validate(data);
      if (!result.ok) fail(result.errors.join('；'), 'clipboard_steps_invalid');
      return data;
    }
    function clipboardStepRecord(record) {
      const arrow = ed.struct().rxnArrows.get(record.id);
      const labels = (record.labels || []).map(label => {
        const text = ed.struct().texts.get(label.id);
        if (!text?.position || text.content !== label.nativeContent) fail('步骤标签已变化，请先整理原步骤再复制', 'clipboard_steps_invalid');
        const { id, nativeContent, ...metadata } = label;
        return { ...copy(metadata), nativeContent: text.content, position: { x: text.position.x, y: text.position.y } };
      });
      return { stepId: record.stepId, reactants: record.reactants.slice(), products: record.products.slice(),
        ...(record.layout && { layout: copy(record.layout) }), ...(record.flow && { flow: copy(record.flow) }),
        ...(record.conditions && { conditions: record.conditions }),
        arrow: { mode: arrow.mode, start: { x: arrow.pos[0].x, y: arrow.pos[0].y }, end: { x: arrow.pos[1].x, y: arrow.pos[1].y } }, labels };
    }
    function captureClipboardSteps() {
      const selection = ed.selection() || {}, arrowIds = new Set(selection.rxnArrows || []);
      const records = [...reactionConnectors.values()].filter(record => arrowIds.has(record.id) && connectorStillDrawn(record));
      if (!records.length) return null;
      const atomIds = new Set(selection.atoms || []), textIds = new Set(selection.texts || []);
      for (const id of selection.bonds || []) { const bond = ed.struct().bonds.get(id); if (bond) { atomIds.add(bond.begin); atomIds.add(bond.end); } }
      const copied = new Set([...atomIds].map(id => a.uuidOfAtom(id))), components = new Map();
      for (const part of connectedComponents()) for (const id of part.uuids) components.set(id, part.uuids);
      for (const record of records) {
        if ([...record.reactants, ...record.products].some(id => !components.get(id)?.every(member => copied.has(member)))) {
          fail('复制反应步骤需要同时选择完整的反应物和产物', 'clipboard_steps_incomplete');
        }
        if ((record.labels || []).some(label => !textIds.has(label.id))) fail('复制反应步骤需要同时选择条件和续接标签', 'clipboard_steps_incomplete');
      }
      return checkedStepClipboard({ version: 1, steps: records.map(clipboardStepRecord) });
    }
    function prepareClipboardImport(workbench) {
      const parsed = MW.storage.parseWorkbench(typeof workbench === 'string' ? workbench : JSON.stringify(workbench));
      if (!parsed.ok) fail(parsed.error, parsed.code);
      const source = parsed.doc;
      if (!source.reactionSteps?.length) return null;
      const nodes = source.ket.root.nodes, fragment = native.prepareKet(JSON.stringify(source.ket));
      const textNodes = nodes.map((node, index) => node.type === 'text' ? index : -1).filter(index => index >= 0);
      const nativeTexts = [...fragment.texts.values()];
      const steps = source.reactionSteps.map((step, stepIndex) => {
        const arrow = nodes[step.arrow]?.data;
        if (!arrow?.pos || arrow.pos.length !== 2) fail('导入步骤缺少直箭头坐标', 'clipboard_steps_invalid');
        const point = p => ({ x: p.x, y: -p.y });
        const labels = (step.labels || []).map(label => {
          const node = nodes[label.node], text = nativeTexts[textNodes.indexOf(label.node)], box = node?.boundingBox;
          if (!box || !text) fail('导入步骤缺少标签', 'clipboard_steps_invalid');
          const { node: locator, ...metadata } = label;
          return { ...copy(metadata), nativeContent: text.content, position: { x: box.x, y: -box.y } };
        });
        return { stepId: step.stepId || 'legacy-step-' + stepIndex, reactants: step.reactants.slice(), products: step.products.slice(),
          ...(step.layout && { layout: copy(step.layout) }), ...(step.flow && { flow: copy(step.flow) }),
          ...(step.conditions && { conditions: step.conditions }),
          arrow: { mode: arrow.mode, start: point(arrow.pos[0]), end: point(arrow.pos[1]) }, labels };
      });
      return checkedStepClipboard({ version: 1, steps });
    }
    function appendClipboardSteps(data, resolved, meta) {
      checkedStepClipboard(data);
      if (!resolved?.ok || !meta?.beforeNativePools || typeof resolved.session?.transform !== 'function') fail('粘贴步骤缺少原子或原生对象对应关系', 'clipboard_steps_invalid');
      const before = captureStepRuntime(), inverses = [], stepIdMap = new Map();
      const usedTokens = new Set([...reactionConnectors.values()].flatMap(record => (record.labels || [])
        .filter(label => ['graphPort', 'previousRow', 'nextRow'].includes(label.role)).map(label => label.token || label.text)));
      const planned = MW.reactionStepClipboard.plan(data, { atomMap: resolved.atomMap, transform: resolved.session.transform,
        scale: meta.scale ?? 1, rotation: meta.rotation ?? 0, usedTokens, newId: () => 'rs-' + uid() });
      if (!planned.ok) fail(planned.error || '无法恢复复制的反应步骤', 'clipboard_steps_invalid');
      const st = ed.struct(), arrows = [...st.rxnArrows].filter(([id]) => !meta.beforeNativePools.rxnArrows.has(id));
      const texts = [...st.texts].filter(([id]) => !meta.beforeNativePools.texts.has(id));
      const usedArrows = new Set(), usedTexts = new Set();
      const close = (p, q) => p && q && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.hypot(p.x - q.x, p.y - q.y) < 1e-4;
      const sameContent = (first, second) => { try { return canonical(JSON.parse(first)) === canonical(JSON.parse(second)); } catch (_) { return first === second; } };
      try {
        const prepared = planned.steps.map(step => {
          const matches = arrows.filter(([id, arrow]) => !usedArrows.has(id) && arrow.mode === step.arrow.mode && close(arrow.pos[0], step.arrow.start) && close(arrow.pos[1], step.arrow.end));
          if (matches.length !== 1) fail('复制的反应直箭头无法唯一对应，已取消整份粘贴', 'clipboard_steps_ambiguous');
          const [id, nativeArrow] = matches[0]; usedArrows.add(id);
          const labels = step.labels.map(label => {
            const matches = texts.filter(([id, text]) => !usedTexts.has(id) && sameContent(text.content, label.sourceContent) && close(text.position, label.position));
            if (matches.length !== 1) fail('复制的步骤标签无法唯一对应，已取消整份粘贴', 'clipboard_steps_ambiguous');
            const [id, text] = matches[0]; usedTexts.add(id);
            return { label, id, text };
          });
          return { step, id, nativeArrow, labels };
        });
        for (const entry of prepared) {
          const { step, id, nativeArrow } = entry, labels = [];
          for (const found of entry.labels) {
            const { label } = found;
            let labelId = found.id, nativeText = found.text;
            const sourceLabel = data.steps.find(source => source.stepId === step.sourceStepId)?.labels
              .find(source => source.nativeContent === label.sourceContent && close(source.position, label.sourcePosition));
            if (label.desiredText !== sourceLabel?.text) {
              if (['graphPort', 'previousRow', 'nextRow'].includes(label.role)) {
                const so = structOpsRequired();
                inverses.push(new so.textDelete(labelId).perform(ed.render.ctab));
                const existing = new Set(st.texts.keys());
                inverses.push(native.createText(ed.render.ctab, label.desiredText, label.position));
                labelId = [...st.texts.keys()].find(key => !existing.has(key)); nativeText = st.texts.get(labelId);
                if (!nativeText) fail('无法创建新的续接标签', 'clipboard_steps_invalid');
              }
            }
            const { sourceContent, sourcePosition, position, desiredText, nativeContent, ...metadata } = label;
            labels.push({ ...copy(metadata), text: desiredText, id: labelId, nativeContent: nativeText.content });
          }
          const sides = reactionSides(step, reactionMoleculeBoxes(), ref => ref);
          if (reactionConnectors.has(sides.key)) fail('复制步骤与已有步骤身份重合，已取消粘贴', 'clipboard_steps_ambiguous');
          reactionConnectors.set(sides.key, { id, nativeArrow, mode: nativeArrow.mode,
            stepId: step.stepId, version: 1, reactants: step.reactants.slice(), products: step.products.slice(),
            productComponents: sides.products.map(box => box.component), start: { ...nativeArrow.pos[0] }, end: { ...nativeArrow.pos[1] }, labels,
            ...(step.layout && { layout: copy(step.layout) }), ...(step.flow && { flow: copy(step.flow) }), ...(step.conditions && { conditions: step.conditions }) });
          stepIdMap.set(step.sourceStepId, step.stepId);
        }
        return { before, after: captureStepRuntime(), inverses, stepIdMap };
      } catch (error) {
        for (let i = inverses.length - 1; i >= 0; i--) inverses[i].perform(ed.render.ctab);
        restoreStepRuntime(before, false); rebindConnectors();
        throw error;
      }
    }
    function wrapClipboardHistory(action, outcome) {
      if (!action || typeof action.perform !== 'function') fail('粘贴缺少可撤销的原生动作', 'clipboard_steps_invalid');
      const original = action.perform;
      function half(performNative, postActions, targetSteps, undoing) {
        return { operations: [], isDummy: () => false, perform(ctab) {
          const oppositeSteps = captureStepRuntime(), oppositePost = [];
          let oppositeNative;
          const post = () => { for (let i = postActions.length - 1; i >= 0; i--) oppositePost.push(postActions[i].perform(ctab)); };
          if (undoing) { post(); oppositeNative = performNative(ctab); }
          else { oppositeNative = performNative(ctab); post(); }
          restoreStepRuntime(targetSteps, false); rebindConnectors();
          return half(next => oppositeNative.perform(next), oppositePost, oppositeSteps, !undoing);
        } };
      }
      const wrapper = half(ctab => original.call(action, ctab), outcome.inverses, outcome.before, true);
      action.perform = wrapper.perform;
      return action;
    }
    function stepStateAction(state) {
      return { operations: [], isDummy: () => false, perform() {
        const inverse = captureStepRuntime();
        // Accepted operation IDs remain consumed after Undo, just like run.applied.
        // A transport retry must never resurrect something the user undid.
        restoreStepRuntime(state, false);
        return stepStateAction(inverse);
      } };
    }
    function rebindConnectors() {
      for (const record of reactionConnectors.values()) {
        record.nativeArrow = ed.struct().rxnArrows.get(record.id);
        if (record.nativeArrow) {
          record.mode = record.nativeArrow.mode;
          record.start = { ...record.nativeArrow.pos[0] }; record.end = { ...record.nativeArrow.pos[1] };
        }
      }
    }
    function findStep(id, pending = new Map()) {
      return [...pending.values(), ...reactionConnectors.values()].find(record => record.stepId === id && connectorStillDrawn(record));
    }
    function stepObservation(record, graphRecords) {
      const arrow = ed.struct().rxnArrows.get(record.id);
      const continuation = record.flow?.continuation || null;
      const horizontal = arrow && Math.abs(arrow.pos[0].y - arrow.pos[1].y) < 0.02 && arrow.pos[1].x > arrow.pos[0].x;
      const paired = record.flow?.graph || !continuation || ['previousRow', 'nextRow'].every(role =>
        (record.labels || []).some(label => label.role === role && ed.struct().texts.get(label.id)?.content === label.nativeContent));
      const issues = !horizontal ? [{ code: 'reaction_step_layout_required', message: '步骤直箭头尚未按路线水平排布' }]
        : !paired ? [{ code: 'reaction_step_continuation_missing', message: '跨行衔接标签不完整' }] : [];
      const boxes = reactionMoleculeBoxes(), participants = new Set([...record.reactants, ...record.products].map(id => boxes.get(id)?.component).filter(Boolean));
      if ([...record.reactants, ...record.products].some(id => !boxes.has(id))) {
        issues.push({ code: 'reaction_step_participant_missing', message: '步骤引用的结构已被删除，请修改或删除原步骤' });
      }
      if (record.flow?.graph && record.flow.anchors?.some(anchor => {
        const point = a.atomPos(a.atomIdOf(anchor.atomId));
        return !point || M.dist(point, anchor) > 0.05;
      })) issues.push({ code: 'reaction_step_structure_displaced', message: '步骤结构已移离路线，请重新排布原步骤' });
      try {
        const expected = record.flow?.graph ? { start: { x: record.flow.arrowStartX, y: record.flow.arrowStartY },
          end: { x: record.flow.arrowEndX, y: record.flow.arrowEndY } } : connectorLine(reactionSides(record, boxes, id => id), boxes, record.flow);
        if (!arrow || M.dist(expected.start, arrow.pos[0]) > 2 * LAYOUT.arrowLength || M.dist(expected.end, arrow.pos[1]) > 2 * LAYOUT.arrowLength) {
          issues.push({ code: 'reaction_step_connector_detached', message: '直箭头已远离该步骤结构，请重新排布原步骤' });
        }
      } catch (_) { issues.push({ code: 'reaction_step_connector_blocked', message: '步骤结构之间缺少有效连接通道' }); }
      if (record.flow?.graph) {
        const records = Array.isArray(graphRecords) ? graphRecords : [...reactionConnectors.values()].filter(connectorStillDrawn);
        const ports = records.flatMap(step => (step.labels || []).filter(label => label.role === 'graphPort'));
        for (const label of (record.labels || []).filter(label => label.role === 'graphPort')) {
          const pair = ports.filter(port => port.token === label.token);
          const nativeText = ed.struct().texts.get(label.id);
          if (pair.length !== 2 || new Set(pair.map(port => port.id)).size !== 2 ||
              new Set(pair.map(port => port.at)).size !== 2 || pair.some(port => port.kind !== label.kind ||
                canonical(port.anchorRefs.slice().sort()) !== canonical(label.anchorRefs.slice().sort()) ||
                ed.struct().texts.get(port.id)?.content !== port.nativeContent)) {
            issues.push({ code: 'reaction_step_port_unpaired', token: label.token, message: label.token + ' 的两端衔接不完整' });
          }
          if (!nativeText?.position || nativeText.content !== label.nativeContent ||
              M.dist(nativeText.position, { x: label.layoutX, y: label.layoutY }) > 0.03) {
            issues.push({ code: 'reaction_step_port_displaced', token: label.token, message: label.token + ' 的衔接标记已被移开' }); continue;
          }
          if (label.at === 'molecule') {
            const anchors = label.anchorRefs.map(id => boxes.get(id));
            if (anchors.some(box => !box)) issues.push({ code: 'reaction_step_port_anchor_missing', token: label.token, message: label.token + ' 的结构引用失效' });
            else {
              const center = midpoint(unionBoxes(anchors.map(box => box.anchorBox || box)));
              if (M.dist(nativeText.position, { x: center.x + label.anchorDx, y: center.y + label.anchorDy }) > 0.05) {
                issues.push({ code: 'reaction_step_port_anchor_moved', token: label.token, message: label.token + ' 与所指结构已错位，请重新排布该路线' });
              }
            }
          }
        }
      }
      const ctx = controller.ctx(), points = ctx.atoms();
      const requiredSide = record.layout?.reagentPlacement;
      if (requiredSide && requiredSide !== 'auto') {
        const reagents = [...new Set(record.reactants.map(id => boxes.get(id)).filter(Boolean))];
        const main = reagents.slice().sort((a, b) => b.component.split('|').length - a.component.split('|').length)[0];
        const endpointComponents = endpoint => (endpoint.type === 'bond' ? (() => {
          const bond = ctx.bondInfo(endpoint.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
        })() : M.endpointAtomIds(endpoint)).map(id => boxes.get(id)?.component);
        for (const reagent of reagents) {
          if (reagent === main || !model.state.arrows.some(flow => {
            const members = new Set([...endpointComponents(flow.source), ...endpointComponents(flow.target)]);
            return members.has(main.component) && members.has(reagent.component) && [...members].every(id => reagents.some(box => box.component === id));
          })) continue;
          const r = reagent.inkBox || reagent, m = main.inkBox || main;
          const matches = requiredSide === 'left' ? r.x2 <= m.x1 + 0.05 : requiredSide === 'right' ? r.x1 >= m.x2 - 0.05
            : requiredSide === 'above' ? r.y2 <= m.y1 + 0.05 : r.y1 >= m.y2 - 0.05;
          if (!matches) issues.push({ code: 'reaction_step_reagent_placement_changed', placement: requiredSide,
            message: '试剂实际位置与步骤保存的 ' + requiredSide + ' 排布不一致，请用 reactionStep.modify 更新原步骤的 reagentPlacement' });
        }
      }
      for (let i = 0; i < points.length; i++) {
        const first = boxes.get(points[i].uuid)?.component;
        if (!participants.has(first)) continue;
        for (let j = i + 1; j < points.length; j++) {
          const second = boxes.get(points[j].uuid)?.component;
          if (!second || first === second || M.dist(points[i].pos, points[j].pos) >= 0.4) continue;
          issues.push({ code: 'reaction_step_molecule_overlap', message: '步骤结构与另一分子的原子重叠，请调整相关结构位置' });
          break;
        }
        if (issues.some(issue => issue.code === 'reaction_step_molecule_overlap')) break;
      }
      const checkedArrowIds = [];
      if (MW.route?.planArrow) {
        const reactants = new Set(record.reactants.map(id => boxes.get(id)?.component));
        for (const flow of model.state.arrows) {
          const endpointAtoms = ep => ep.type === 'bond' ? (() => {
            const bond = ctx.bondInfo(ep.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
          })() : M.endpointAtomIds(ep);
          const refs = [...endpointAtoms(flow.source), ...endpointAtoms(flow.target)];
          if (!refs.length || refs.some(id => !reactants.has(boxes.get(id)?.component))) continue;
          checkedArrowIds.push(flow.id);
          const geometry = M.arrowGeometry(flow, ctx);
          if (geometry.degenerate || !geometry.sourceOk || !geometry.targetOk) {
            issues.push({ code: 'reaction_step_electron_geometry', arrowId: flow.id, message: '电子流端点或曲线几何无效' }); continue;
          }
          const scene = MW.route.buildScene(ctx, model, { planning: false }); MW.route.addArrowObstacles(scene, model, ctx, flow.id);
          const requireCurvature = M.arrowMode(flow) === 'auto';
          const result = MW.route.planArrow({ a: geometry.routingStart || geometry.start, b: geometry.routingEnd || geometry.end,
            scene, source: flow.source, target: flow.target, electronCount: flow.electronCount, fixedGeometry: geometry, requireCurvature });
          if (!result.feasible) issues.push({ code: 'reaction_step_electron_crowding', arrowId: flow.id, message: '电子流曲线压到原子标签或化学键' });
          else if (result.ranked?.[0]?.arrowHits) issues.push({ code: 'reaction_step_electron_crossing', arrowId: flow.id, message: '同一步的电子流仍有交叉' });
          const endpointComponents = new Set(refs.map(id => boxes.get(id)?.component).filter(Boolean));
          const readability = MW.route.assessReadability?.({ ...geometry, L: scene.L || 1, intermolecular: endpointComponents.size > 1, requireCurvature });
          if (readability?.readable === false) {
            issues.push({ code: 'reaction_step_electron_unreadable', arrowId: flow.id, ...readability,
              message: readability.reasons?.includes('curve_flat') ? '自动电子流接近直线，弧度不足；请重新自动排布或调整反应位点附近的位置' :
                '电子流跨度或绕行过大，请调整试剂停靠侧别、位置或孤对朝向，让曲线靠近反应位点' });
          }
        }
      }
      return { stepId: record.stepId, version: record.version, reactionArrowId: String(record.id),
        reactants: record.reactants.slice(), products: record.products.slice(), conditions: record.conditions || '',
        layout: copy(record.layout || {}), layoutStatus: { status: issues.length ? 'failed' : 'passed', continuation,
          ...(record.flow?.graph && { routeId: record.flow.routeId, laneId: record.flow.laneId }) },
        ...(record.flow?.graph && { ports: (record.labels || []).filter(label => label.role === 'graphPort').map(label => ({
          token: label.token, kind: label.kind, side: label.side, at: label.at, anchorRefs: label.anchorRefs.slice(),
          position: copy(ed.struct().texts.get(label.id)?.position || null) })) }),
        checks: { layout: { status: issues.length ? 'failed' : 'passed', issues, checkedArrowIds }, chemistry: { status: 'pending', issues: [] } } };
    }
    function stepReplay(op, run) {
      const applied = stepOperations.get(op.id);
      if (!applied) return null;
      if (applied.signature !== canonical(op)) fail('步骤操作 id 已用于不同内容：' + op.id, 'operation_conflict');
      const resolved = resolvedStepSignature(op, run, applied.stepId);
      if (applied.resolvedSignature && resolved && applied.resolvedSignature !== resolved) {
        fail('相同操作 id 中的结构或步骤引用已指向其他对象，请读取当前状态并使用新的操作 id', 'operation_conflict');
      }
      if (op.type === 'reactionStep.create') run.steps.set(op.id, applied.stepId);
      const current = findStep(applied.stepId), after = current ? stepObservation(current) : null;
      return { operationId: op.id, stepId: applied.stepId, version: after?.version || applied.version,
        action: applied.action, replayed: true, before: null, after,
        layout: after?.layoutStatus || { status: 'passed', continuation: null },
        checks: after?.checks || { layout: { status: 'passed', issues: [] }, chemistry: { status: 'pending', issues: [] } } };
    }
    function resolvedStepSignature(op, tables, knownStepId) {
      const resolved = { ...op };
      if (op.stepId) {
        resolved.stepId = tables.steps.get(op.stepId) || (op.stepId === knownStepId ? op.stepId : findStep(op.stepId)?.stepId);
        if (!resolved.stepId) return null; // A historical run alias may no longer exist after reopening.
      }
      for (const side of ['reactants', 'products']) if (op[side]) {
        resolved[side] = op[side].map(id => tables.atoms.get(id) || id);
        if (resolved[side].some(id => a.atomIdOf(id) === null)) return null;
      }
      return canonical(resolved);
    }
    function removeStepLabels(record, actions, signal) {
      const so = structOpsRequired();
      for (const label of record.labels || []) {
        if (ed.struct().texts.get(label.id)?.content !== label.nativeContent) continue;
        forwardOps(so, [{ make: () => new so.textDelete(label.id) }], ed.render.ctab, signal, actions);
      }
      record.labels = [];
    }
    function createStepLabels(record, sides, boxes, line, actions) {
      const labels = connectorLabels(record.conditions || '', line, sides, boxes, record.flow);
      record.labels = labels.map(label => {
        const before = new Set(ed.struct().texts.keys());
        actions.push(native.createText(ed.render.ctab, label.text, label));
        const id = [...ed.struct().texts.keys()].find(id => !before.has(id));
        if (id === undefined) fail('反应步骤标签创建失败', 'reaction_step_layout_failed');
        return { id, role: label.role, text: label.text, nativeContent: ed.struct().texts.get(id).content };
      });
    }
    function packSemanticGroup(keys, parts, boxes, layout = {}) {
      const ctx = controller.ctx(), R = MW.route;
      const sizes = new Map(keys.map(key => {
        const box = boxes.get(parts.get(key).uuids[0]);
        return [key, { width: box.x2 - box.x1, height: box.y2 - box.y1, center: midpoint(box) }];
      }));
      const main = keys.reduce((best, key) => parts.get(key).uuids.length > parts.get(best).uuids.length ? key : best, keys[0]);
      const owners = new Map(keys.flatMap(key => parts.get(key).uuids.map(id => [id, key])));
      const atomIdsOf = endpoint => endpoint.type === 'bond' ? (() => {
        const bond = ctx.bondInfo(endpoint.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
      })() : M.endpointAtomIds(endpoint);
      const pointOf = (endpoint, key) => {
        const ids = atomIdsOf(endpoint).filter(id => owners.get(id) === key);
        const points = ids.map(id => ctx.atomPos(id)).filter(Boolean);
        return points.length ? { x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
          y: points.reduce((sum, p) => sum + p.y, 0) / points.length } : null;
      };
      const flows = model.state.arrows.filter(flow => {
        const ids = [...atomIdsOf(flow.source), ...atomIdsOf(flow.target)];
        return ids.length && ids.every(id => owners.has(id));
      });
      const links = [];
      for (const flow of flows) {
        const sourceKey = owners.get(atomIdsOf(flow.source)[0]);
        const targetKey = atomIdsOf(flow.target).map(id => owners.get(id)).find(key => key && key !== sourceKey);
        if (sourceKey && targetKey) links.push([{ id: sourceKey, point: pointOf(flow.source, sourceKey) },
          { id: targetKey, point: pointOf(flow.target, targetKey) }]);
      }
      const groupBox = unionBoxes(keys.map(key => boxes.get(parts.get(key).uuids[0])));
      const compact = groupBox.x2 - groupBox.x1 <= keys.reduce((sum, key) => sum + sizes.get(key).width, 0) + 3 &&
        groupBox.y2 - groupBox.y1 <= Math.max(...keys.map(key => sizes.get(key).height)) + 4 &&
        keys.every((key, i) => keys.slice(i + 1).every(other => {
          const first = boxes.get(parts.get(key).uuids[0]), second = boxes.get(parts.get(other).uuids[0]);
          return first.x2 + LAYOUT.groupGap <= second.x1 || second.x2 + LAYOUT.groupGap <= first.x1 ||
            first.y2 + LAYOUT.groupGap <= second.y1 || second.y2 + LAYOUT.groupGap <= first.y1;
        }));
      const placement = layout.reactantPlacement || 'auto';
      const initial = placement === 'auto' ? preferredStagePack(keys, links, sizes) : stagePack(keys, links, sizes, placement === 'vertical' ? 'y' : 'x');
      const mainCenter = sizes.get(main).center;
      const centers = new Map(keys.map(key => [key, placement === 'auto' && links.length
        ? { ...sizes.get(key).center } : { x: mainCenter.x + initial.positions.get(key).x - initial.positions.get(main).x,
          y: mainCenter.y + initial.positions.get(key).y - initial.positions.get(main).y }]));
      const shiftOf = (id, candidateKey, candidatePosition) => {
        const key = owners.get(id), old = key && sizes.get(key).center;
        const next = key === candidateKey ? candidatePosition : key && centers.get(key);
        return old && next ? { dx: next.x - old.x, dy: next.y - old.y } : { dx: 0, dy: 0 };
      };
      const localIds = new Set(owners.keys());
      const evaluator = (movingKey, candidate, preserveOnly = false) => {
        const movePoint = (point, id) => { const d = shiftOf(id, movingKey, candidate.position); return { x: point.x + d.dx, y: point.y + d.dy }; };
        const moveRect = (rect, id) => {
          if (!rect) return rect;
          const d = shiftOf(id, movingKey, candidate.position);
          return { x1: rect.x1 + d.dx, x2: rect.x2 + d.dx, y1: rect.y1 + d.dy, y2: rect.y2 + d.dy };
        };
        const moveBond = bond => bond && ({ ...bond, begin: movePoint(bond.begin, bond.beginAtom), end: movePoint(bond.end, bond.endAtom) });
        const translatedLabels = base => (id, options) => {
          const box = base.atomLabelBox(id, options);
          return box && { ...box, rect: moveRect(box.rect, id), planningRect: moveRect(box.planningRect, id), atomRect: moveRect(box.atomRect, id),
            hydrogenRects: box.hydrogenRects?.map(rect => moveRect(rect, id)) };
        };
        const virtual = { ...ctx, atomPos: id => { const point = ctx.atomPos(id); return point && movePoint(point, id); },
          atoms: () => ctx.atoms().filter(atom => localIds.has(atom.uuid)).map(atom => ({ ...atom, pos: movePoint(atom.pos, atom.uuid) })),
          bonds: () => ctx.bonds().filter(bond => localIds.has(bond.beginAtom) && localIds.has(bond.endAtom)).map(moveBond),
          bondInfo: id => moveBond(ctx.bondInfo(id)), reactionArrows: () => [],
          atomLabelBox: translatedLabels(ctx) };
        if (typeof ctx.planningContextAtZoom === 'function') virtual.planningContextAtZoom = zoom => {
          const measured = ctx.planningContextAtZoom(zoom);
          return measured && { ...measured, atomLabelBox: translatedLabels(measured) };
        };
        const localModel = { state: { lonePairs: model.state.lonePairs.filter(pair => localIds.has(pair.ownerAtomId)), arrows: [] } };
        const scene = R.buildScene(virtual, localModel);
        const ordered = flows.slice().sort((a, b) => {
          const cross = flow => new Set([...atomIdsOf(flow.source), ...atomIdsOf(flow.target)].map(id => owners.get(id))).size > 1;
          return Number(cross(a)) - Number(cross(b));
        });
        const metrics = { feasible: true, length: 0, chord: 0, maxBend: 0, arcRatio: 1, labelHits: 0, bondHits: 0, arrowHits: 0, failures: [] };
        for (const flow of ordered) {
          let result = controller.planFor(flow.source, flow.target, flow.electronCount,
            { ctx: virtual, scene, preferClearArrows: true, onlyBend: flow.geometry.bend });
          if (!preserveOnly && (!result?.plan.feasible || !result.plan.readable || result.plan.ranked[0]?.arrowHits)) {
            result = controller.planFor(flow.source, flow.target, flow.electronCount, { ctx: virtual, scene, preferClearArrows: true });
          }
          const intermolecular = new Set([...atomIdsOf(flow.source), ...atomIdsOf(flow.target)].map(id => owners.get(id))).size > 1;
          const sourcePair = flow.source.type === 'lonePair' && virtual.lonePair(flow.source.slotId);
          const sourceLonePair = sourcePair ? { sourceLonePair: { id: sourcePair.id, ownerAtomId: sourcePair.ownerAtomId,
            angle: M.lonePairAngle(sourcePair, virtual) * 180 / Math.PI,
            ...(sourcePair.refAtomId && { refAtomId: sourcePair.refAtomId }) } } : {};
          if (!result?.plan?.ranked?.length) return { ...metrics, feasible: false, labelHits: 100, bondHits: 100,
            failures: metrics.failures.concat({ arrowId: flow.id, code: 'no_route_candidate', intermolecular, ...sourceLonePair }) };
          const plan = result.plan, geometry = M.arrowGeometry({ ...flow, geometry: { bend: plan.bend, mode: 'auto' } }, virtual);
          const length = R.arcLength(geometry.start, geometry.control, geometry.end), chord = M.dist(geometry.start, geometry.end);
          metrics.length += length; metrics.chord += chord; metrics.maxBend = Math.max(metrics.maxBend, Math.abs(plan.bend));
          metrics.arcRatio = Math.max(metrics.arcRatio, length / Math.max(chord, 0.05));
          metrics.labelHits += plan.ranked[0].labelHits || 0; metrics.bondHits += plan.ranked[0].bondHits || 0;
          metrics.arrowHits += plan.ranked[0].arrowHits || 0; metrics.feasible = metrics.feasible && plan.feasible && plan.readable !== false;
          if (!plan.feasible || plan.readable === false) metrics.failures.push({ arrowId: flow.id,
            code: plan.readable === false ? 'unreadable_electron_flow' : 'electron_flow_crowding', intermolecular,
            ...sourceLonePair,
            endpointMovesWithReagent: [...atomIdsOf(flow.source), ...atomIdsOf(flow.target)].some(id => owners.get(id) === movingKey),
            obstacleMovesWithReagent: (plan.collisions?.labels || []).some(id => owners.get(id) === movingKey) ||
              (plan.collisions?.bonds || []).some(id => atomIdsOf({ type: 'bond', bondId: id }).some(atom => owners.get(atom) === movingKey)),
            reasons: plan.readability?.reasons || [], atomIds: plan.collisions?.labels || [], bondIds: plan.collisions?.bonds || [] });
          scene.arrows.push({ id: flow.id, points: R.sampleCurve(geometry.start, geometry.control, geometry.end, 0.1, 12, 40).points, length });
        }
        return metrics;
      };
      const desiredSide = layout.reagentPlacement || 'auto';
      const currentSideMatches = keys.every(key => {
        if (key === main || desiredSide === 'auto') return true;
        const host = boxes.get(parts.get(main).uuids[0]), reagent = boxes.get(parts.get(key).uuids[0]);
        return desiredSide === 'left' ? reagent.x2 <= host.x1 + 0.05
          : desiredSide === 'right' ? reagent.x1 >= host.x2 - 0.05
            : desiredSide === 'above' ? reagent.y2 <= host.y1 + 0.05 : reagent.y1 >= host.y2 - 0.05;
      });
      const currentGroupsSeparate = keys.every((key, i) => keys.slice(i + 1).every(other => {
        const first = boxes.get(parts.get(key).uuids[0]), second = boxes.get(parts.get(other).uuids[0]);
        return first.x2 <= second.x1 || second.x2 <= first.x1 || first.y2 <= second.y1 || second.y2 <= first.y1;
      }));
      // Keep a valid compact depiction when a later semantic edit only moves
      // the route. Verify every existing bend in every reading geometry first;
      // an incomplete, crowded, crossing or newly requested side still searches.
      const existing = placement === 'auto' && links.length && currentSideMatches && currentGroupsSeparate
        ? evaluator(main, { position: centers.get(main) }, true) : null;
      const preserveDock = existing?.feasible && !existing.arrowHits;
      if (!preserveDock && !compact) for (const key of keys) centers.set(key,
        { x: mainCenter.x + initial.positions.get(key).x - initial.positions.get(main).x,
          y: mainCenter.y + initial.positions.get(key).y - initial.positions.get(main).y });
      if (!preserveDock && keys.length > 1 && R?.buildScene && MW.reactionReagentPlacement?.plan) for (const key of keys) {
        if (key === main) continue;
        const contacts = links.filter(pair => pair.some(end => end.id === main) && pair.some(end => end.id === key)).map(pair => {
          const host = pair.find(end => end.id === main).point, reagent = pair.find(end => end.id === key).point;
          const current = centers.get(key), old = sizes.get(key).center;
          return { host, reagent: { x: reagent.x + current.x - old.x, y: reagent.y + current.y - old.y } };
        });
        if (!contacts.length) continue;
        const center = centers.get(key), size = sizes.get(key), hostSize = sizes.get(main);
        const obstacles = keys.filter(other => other !== key && other !== main).map(other => boxAt(centers.get(other), sizes.get(other)));
        const desired = layout.reagentPlacement || (placement === 'auto' ? 'auto' : placement);
        const hostAnchor = boxes.get(parts.get(main).uuids[0]).anchorBox;
        const dock = MW.reactionReagentPlacement.plan({ host: { id: main, ...mainCenter, width: hostSize.width, height: hostSize.height,
          ...(hostAnchor && { siteWidth: hostAnchor.x2 - hostAnchor.x1, siteHeight: hostAnchor.y2 - hostAnchor.y1 }) },
          reagent: { id: key, ...center, width: size.width, height: size.height }, contacts, obstacles,
          placement: desired, evaluate: candidate => evaluator(key, candidate) });
        if (!dock.ok) {
          if (layout.reagentPlacement && layout.reagentPlacement !== 'auto') fail(dock.diagnostic.message, dock.diagnostic.code);
          continue;
        }
        if (!dock.feasible) {
          const error = new Error('试剂在 ' + desired + ' 侧排布失败；layoutFailures 列出最佳候选中仍被遮挡或过长的电子流。请按其中的箭头和碰撞对象修正原操作；本批次已完整撤销。');
          error.code = 'reaction_reagent_layout_failed';
          error.layoutFailures = (dock.metrics?.failures || []).slice(0, 4);
          throw error;
        }
        centers.set(key, dock.position);
      }
      const bounds = unionBoxes(keys.map(key => boxAt(centers.get(key), sizes.get(key)))), center = midpoint(bounds);
      return { keys, main, width: bounds.x2 - bounds.x1, height: bounds.y2 - bounds.y1,
        offsets: new Map(keys.map(key => [key, { x: centers.get(key).x - center.x, y: centers.get(key).y - center.y }])),
        mainOffsets: new Map(keys.map(key => [key, { x: centers.get(key).x - centers.get(main).x, y: centers.get(key).y - centers.get(main).y }])) };
    }
    function isPreparationStepLink(from, to, boxes) {
      if (!MW.reactionGraphLayout?.isPreparationLink || from === to) return false;
      const side = refs => [...new Set(refs.map(id => boxes.get(id)?.component).filter(Boolean))];
      return MW.reactionGraphLayout.isPreparationLink(
        { reactants: side(from.reactants), products: side(from.products) },
        { reactants: side(to.reactants), products: side(to.products) }, id => id.split('|').length);
    }
    // Reflow the connected route touched by a semantic edit, including former
    // neighbours. Short chains retain their stable packing; long/branched DAGs
    // use explicit home/reference ports instead of remote diagonal connectors.
    function reflowSemanticSteps(edits, pending, actions, movedAtoms, signal) {
      if (!edits.length) return [];
      let boxes = reactionMoleculeBoxes();
      const records = [...new Map([...reactionConnectors, ...pending]).values()].filter(connectorStillDrawn);
      const components = refs => new Set(refs.map(id => boxes.get(id)?.component).filter(Boolean));
      const members = record => components([...record.reactants, ...record.products]);
      const touched = new Set(edits.flatMap(edit => [...(edit.before?.reactants || []), ...(edit.before?.products || []),
        ...(edit.record?.reactants || []), ...(edit.record?.products || [])]).map(id => boxes.get(id)?.component).filter(Boolean));
      const selected = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of records) if (!selected.has(record) && [...members(record)].some(id => touched.has(id))) {
          selected.add(record); for (const id of members(record)) touched.add(id); changed = true;
        }
      }
      if (!selected.size) return [];
      const list = [...selected], from = new Map(list.map(r => [r, components(r.reactants)])), to = new Map(list.map(r => [r, components(r.products)]));
      const intersects = (a, b) => [...a].some(id => b.has(id));
      const next = new Map(), previous = new Map();
      let complex = list.length >= 8 || list.some(record => record.flow?.graph);
      for (const r of list) {
        const outgoing = list.filter(s => s !== r && intersects(to.get(r), from.get(s)));
        const incoming = list.filter(s => s !== r && intersects(to.get(s), from.get(r)));
        if (outgoing.length > 1 || incoming.length > 1 || list.some(s => s !== r &&
          (intersects(from.get(r), from.get(s)) || intersects(to.get(r), to.get(s))))) {
          complex = true;
        }
        // A small prepared reagent can dock above the next step's large host.
        // It needs the DAG planner's paired output port, not a short-chain
        // connector that either leaves the row baseline or points at the host.
        if (outgoing.some(s => isPreparationStepLink(r, s, boxes))) complex = true;
        next.set(r, outgoing[0]); previous.set(r, incoming[0]);
      }
      if (complex) return reflowGraphSelection(list, records, boxes, pending, actions, movedAtoms, signal);
      const roots = list.filter(r => !previous.get(r));
      const chains = [], visited = new Set();
      for (const rootStep of roots) {
        const chain = [];
        for (let r = rootStep; r && !visited.has(r); r = next.get(r)) { chain.push(r); visited.add(r); }
        chains.push(chain);
      }
      if (visited.size !== list.length) fail('环形路线暂不支持自动换行，请拆分路线后重试', 'reaction_step_layout_unsupported');
      for (const record of list) removeStepLabels(record, actions, signal);
      const parts = connectedComponents(), byComponent = new Map(parts.map(part => [part.uuids.join('|'), part]));
      const routeMembers = new Set(list.flatMap(record => [...members(record)]));
      const moving = new Set([...routeMembers].flatMap(id => byComponent.get(id)?.rids || []));
      // Ignore owned native arrows and labels while packing the route.
      const obstacles = occupiedBoxes(moving).filter(box => !list.some(record => {
        const line = ed.struct().rxnArrows.get(record.id)?.pos;
        return line && Math.abs(box.x1 - (Math.min(line[0].x, line[1].x) - 0.15)) < 1e-5 &&
          Math.abs(box.y1 - (Math.min(line[0].y, line[1].y) - 0.15)) < 1e-5;
      }));
      let continuation = Math.max(0, ...records.filter(r => !selected.has(r)).map(r => r.flow?.continuation || 0));
      const placements = new Map(), flows = new Map();
      const group = (ids, layout = {}) => packSemanticGroup([...new Set(ids)], byComponent, boxes, layout);
      const place = (packed, center) => {
        const box = boxAt(center, packed); obstacles.push(box);
        for (const key of packed.keys) {
          if (placements.has(key)) fail('同一结构跨越了多个非相邻阶段，请为重用试剂创建局部结构', 'reaction_step_layout_unsupported');
          const offset = packed.offsets.get(key);
          placements.set(key, { x: center.x + offset.x, y: center.y + offset.y });
        }
        return box;
      };
      chains.sort((a, b) => unionBoxes([...from.get(a[0])].map(id => boxes.get(byComponent.get(id).uuids[0]))).y1 -
        unionBoxes([...from.get(b[0])].map(id => boxes.get(byComponent.get(id).uuids[0]))).y1);
      for (const chain of chains) {
        const stages = [group(from.get(chain[0]), chain[0].layout || {})];
        for (let i = 0; i < chain.length; i++) stages.push(group(new Set([...to.get(chain[i]), ...(i + 1 < chain.length ? from.get(chain[i + 1]) : [])]),
          chain[i + 1]?.layout || {}));
        const startBox = unionBoxes([...from.get(chain[0])].map(id => boxes.get(byComponent.get(id).uuids[0])));
        const target = paperTarget(), rowLeft = target?.content.x ?? chain[0].flow?.rowLeft ?? startBox.x1, rowWidth = readingWidth();
        let rowY = midpoint(boxes.get(byComponent.get(stages[0].main).uuids[0])).y, rowBottom = startBox.y2, count = 0;
        const anchorY = stage => stage.offsets.get(stage.main).y;
        const lane = { width: rowWidth, height: 2 * Math.max(...stages.map(stage => stage.height / 2 + Math.abs(anchorY(stage)))) + 2 * LAYOUT.minReactionGap };
        if (target) rowY = Math.max(rowY, target.content.y + lane.height / 2);
        const lanes = [];
        // Reserve the reading corridor, not merely the destination molecule.
        // A former product must never sit between the arrow and its new target.
        const laneAt = clearAlong({ x: rowLeft + rowWidth / 2, y: rowY }, lane, obstacles, LAYOUT.minReactionGap, 'y', 1);
        rowY = laneAt.y; lanes.push(boxAt(laneAt, lane));
        const first = stages[0];
        const origin = clearAlong({ x: rowLeft + first.width / 2, y: rowY - anchorY(first) }, first, obstacles, LAYOUT.minReactionGap, 'y', 1);
        let prior = place(first, origin); rowY = origin.y + anchorY(first); rowBottom = prior.y2;
        for (let i = 0; i < chain.length; i++) {
          abort(signal);
          const record = chain[i], packed = stages[i + 1], conditions = record.conditions || '';
          const gap = conditions ? Math.max(LAYOUT.stepGap, conditionWidth(conditions) + 0.7) : LAYOUT.stepGap;
          if (packed.width + LAYOUT.continuationLane > rowWidth) fail('步骤产物组宽度超出单行范围，请拆分该步骤的展示组', 'reaction_step_layout_failed');
          let wraps = !!record.layout?.breakBefore || count >= LAYOUT.rowSteps || prior.x2 + gap + packed.width > rowLeft + rowWidth;
          const sourceRowY = rowY;
          let at;
          if (!wraps) {
            at = clearAlong({ x: prior.x2 + gap + packed.width / 2, y: rowY - anchorY(packed) }, packed, obstacles, LAYOUT.minReactionGap, 'x', 1);
            wraps = at.x + packed.width / 2 > rowLeft + rowWidth;
          }
          if (wraps) {
            const y = rowBottom + LAYOUT.readingRowGap + lane.height / 2;
            const laneCenter = clearAlong({ x: rowLeft + rowWidth / 2, y }, lane, obstacles, LAYOUT.minReactionGap, 'y', 1);
            rowY = laneCenter.y; lanes.push(boxAt(laneCenter, lane));
            at = { x: rowLeft + LAYOUT.continuationLane + packed.width / 2, y: rowY - anchorY(packed) }; count = 0;
          }
          prior = place(packed, at); rowBottom = wraps ? prior.y2 : Math.max(rowBottom, prior.y2); count++;
          flows.set(record, { reading: true, forward: true, axis: 'x', direction: 1, rowLeft, rowWidth,
            rowY, rowBottom, rowRight: prior.x2, steps: count,
            ...(wraps && { continuation: ++continuation, sourceRowY }) });
        }
        obstacles.push(...lanes);
      }
      const coords = [], oldCoords = [];
      for (const [component, center] of placements) {
        const part = byComponent.get(component), old = boxes.get(part.uuids[0]), current = midpoint(old);
        for (const rid of part.rids) {
          const point = a.atomPos(rid); oldCoords.push([rid, point.x, point.y]);
          coords.push([rid, point.x + center.x - current.x, point.y + center.y - current.y]);
        }
        for (const id of part.uuids) movedAtoms.add(id);
      }
      applyAtomCoords(ed.struct(), coords); markMovedAtoms(ed.render.ctab, [...moving]); actions.push(coordinateMoveAction(oldCoords));
      boxes = reactionMoleculeBoxes();
      const entries = [];
      for (const record of list) {
        const sides = reactionSides(record, boxes, id => id);
        let line;
        try { line = connectorLine(sides, boxes, flows.get(record)); }
        catch (error) {
          if (error?.code !== 'reaction_arrow_gap') throw error;
          // A short chain can dock its shared small product beside the next
          // reactant and leave no direct chemical-side corridor. The DAG
          // planner can reserve a complete stage or paired reference port.
          // Both coordinate plans remain in this one undo/rollback action
          // group; never commit the failed short plan or relax collisions.
          return reflowGraphSelection(list, records, boxes, pending, actions, movedAtoms, signal);
        }
        if (Math.abs(line.start.y - line.end.y) > 0.02 || line.end.x <= line.start.x) fail('步骤无法形成完整水平衔接', 'reaction_step_layout_failed');
        entries.push({ record, ...line, labelPoints: {} });
      }
      for (const record of list) record.flow = flows.get(record);
      actions.push(connectorGeometryAction(entries).perform(ed.render.ctab));
      for (const record of list) createStepLabels(record, reactionSides(record, boxes, id => id), boxes,
        { start: record.start, end: record.end }, actions);
      return list;
    }
    function reflowGraphSelection(list, allRecords, boxes, pending, actions, movedAtoms, signal) {
      const planner = MW.reactionGraphLayout;
      if (!planner?.plan) fail('当前构建缺少复杂路线排版器', 'reaction_graph_unavailable');
      const selected = new Set(list);
      const parts = connectedComponents(), byComponent = new Map(parts.map(part => [part.uuids.join('|'), part]));
      const ids = new Set(list.flatMap(record => [...record.reactants, ...record.products]).map(id => boxes.get(id)?.component));
      if (ids.has(undefined)) fail('复杂路线包含失效结构引用', 'missing_reference');
      const members = [...ids].map(id => byComponent.get(id)), partById = new Map(members.map(part => [part.uuids[0], part]));
      const idByComponent = new Map(members.map(part => [part.uuids.join('|'), part.uuids[0]]));
      const sideIds = refs => [...new Set(refs.map(id => idByComponent.get(boxes.get(id).component)))];
      const steps = list.map(record => ({ id: record.stepId, reactants: sideIds(record.reactants), products: sideIds(record.products),
        layout: { ...(record.layout || {}), ...(record.conditions && { conditions: record.conditions }) } }));
      const molecules = members.map(part => {
        const box = boxes.get(part.uuids[0]);
        return { id: part.uuids[0], width: box.x2 - box.x1, height: box.y2 - box.y1, weight: part.uuids.length };
      });
      const homePlan = planner.plan({ molecules, steps, rowWidth: LAYOUT.readingRowWidth, maxRowWidth: 10000 });
      if (!homePlan.ok) fail(homePlan.diagnostic.message, homePlan.diagnostic.code);
      const homes = new Map(homePlan.homes.map(home => [home.moleculeId, home.stageId]));
      const parent = new Map(molecules.map(molecule => [molecule.id, molecule.id]));
      const find = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
      const join = ids => {
        const roots = [...new Set(ids.map(find))]; if (roots.length < 2) return true;
        const rootSet = new Set(roots), mapped = id => rootSet.has(find(id)) ? roots[0] : find(id);
        if (steps.some(other => other.reactants.some(a => other.products.some(b => mapped(a) === mapped(b))))) return false;
        for (const root of roots.slice(1)) parent.set(root, roots[0]); return true;
      };
      const ctx = controller.ctx(), flowAtoms = endpoint => endpoint.type === 'bond' ? (() => {
        const bond = ctx.bondInfo(endpoint.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
      })() : M.endpointAtomIds(endpoint);
      // Reacting atoms must share one physical local scene, including two
      // branches that consume the same skeleton and a prepared merge reagent.
      for (const step of steps) for (const flow of model.state.arrows) {
        const refs = [...flowAtoms(flow.source), ...flowAtoms(flow.target)];
        const contacts = [...new Set(refs.map(id => idByComponent.get(boxes.get(id)?.component)))];
        if (!contacts.length || contacts.some(id => !id || !step.reactants.includes(id))) continue;
        if (!join(contacts)) fail('复用试剂的电子流无法同时靠近不同化学阶段，请分别创建对应阶段的试剂实例', 'reaction_graph_contact_conflict');
      }
      // Combine compatible same-stage partners, but do not collapse a shared
      // reagent's different chemical stages into a self-cycle.
      for (const step of steps) for (const wholeSide of [step.reactants, step.products]) {
        const homeSides = new Map();
        for (const id of wholeSide) {
          const home = homes.get(id); if (!homeSides.has(home)) homeSides.set(home, []); homeSides.get(home).push(id);
        }
        for (const side of homeSides.values()) {
        join(side);
        }
      }
      const grouped = new Map();
      for (const molecule of molecules) {
        const root = find(molecule.id); if (!grouped.has(root)) grouped.set(root, []); grouped.get(root).push(molecule.id);
      }
      let groups = [...grouped.values()].filter(group => group.length > 1).map(keys => {
        const keySet = new Set(keys);
        const owners = steps.filter(step => step.reactants.filter(id => keySet.has(id)).length > 1);
        const owner = owners.find(step => step.layout.reagentPlacement && step.layout.reagentPlacement !== 'auto') || owners[0];
        const packed = packSemanticGroup(keys, partById, boxes, owner?.layout || {});
        return { id: 'group-' + packed.main, mainId: packed.main, coLocate: true, moleculeIds: keys,
          offsets: keys.map(id => ({ id, ...packed.mainOffsets.get(id) })) };
      });
      const moving = new Set(members.flatMap(part => part.rids));
      for (const record of list) removeStepLabels(record, actions, signal);
      const obstacles = occupiedBoxes(moving).filter(box => !list.some(record => {
        const line = ed.struct().rxnArrows.get(record.id)?.pos;
        return line && Math.abs(box.x1 - (Math.min(line[0].x, line[1].x) - 0.15)) < 1e-5 &&
          Math.abs(box.y1 - (Math.min(line[0].y, line[1].y) - 0.15)) < 1e-5;
      }));
      const seed = unionBoxes(members.map(part => boxes.get(part.uuids[0])));
      const priorRows = list.map(record => record.flow).filter(flow => Number.isFinite(flow?.rowLeft) && Number.isFinite(flow?.rowY));
      const target = paperTarget();
      const anchor = { x: target?.content.x ?? (priorRows.length ? Math.min(...priorRows.map(flow => flow.rowLeft)) : seed.x1),
        y: target ? Math.max(target.content.y + Math.max(...molecules.map(molecule => molecule.height)) / 2 + 1,
          priorRows.length ? Math.min(...priorRows.map(flow => flow.rowY)) : target.content.y)
          : priorRows.length ? Math.min(...priorRows.map(flow => flow.rowY)) : seed.y1 + Math.min(...molecules.map(molecule => molecule.height)) / 2 };
      let planned;
      for (;;) {
        planned = planner.plan({ molecules, steps, groups, anchor, rowWidth: readingWidth(), ...(target && { maxRowWidth: target.content.w }), obstacles });
        if (planned.ok || planned.diagnostic?.code !== 'reaction_graph_group_conflict') break;
        const next = groups.filter(group => group.id !== planned.diagnostic.groupId);
        if (next.length === groups.length) break;
        groups = next;
      }
      if (!planned.ok) {
        const diagnostic = planned.diagnostic || {};
        const error = new Error('复杂路线无法排布：' + (diagnostic.message || '未知布局错误'));
        error.code = diagnostic.code || 'reaction_graph_layout_failed';
        error.relatedStepIds = diagnostic.stepIds; throw error;
      }
      const positions = new Map(planned.positions.map(position => [position.id, position]));
      const beforeCoords = captureAtomCoords(ed.struct(), [...moving]), coords = [];
      for (const [id, part] of partById) {
        const old = midpoint(boxes.get(id)), target = positions.get(id);
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) fail('复杂路线缺少结构位置', 'reaction_graph_layout_failed');
        for (const rid of part.rids) { const point = a.atomPos(rid); coords.push([rid, point.x + target.x - old.x, point.y + target.y - old.y]); }
        for (const uuid of part.uuids) movedAtoms.add(uuid);
      }
      applyAtomCoords(ed.struct(), coords); markMovedAtoms(ed.render.ctab, [...moving]); actions.push(coordinateMoveAction(beforeCoords));
      boxes = reactionMoleculeBoxes();
      const byId = new Map(list.map(record => [record.stepId, record])), namespace = list.map(record => record.stepId).sort()[0];
      const used = new Set();
      for (const record of allRecords) if (!selected.has(record)) for (const label of record.labels || []) used.add(label.text.replace(/\s+/g, ''));
      let wrap = 0, bridge = 0;
      const tokens = new Map(planned.cues.map(cue => {
        let token;
        do { token = cue.kind === 'wrap' ? '续 ' + (++wrap) : '接 B' + (++bridge); } while (used.has(token.replace(/\s+/g, '')));
        used.add(token.replace(/\s+/g, '')); return [cue.token, token];
      }));
      const entries = [];
      for (const step of planned.steps) {
        const record = byId.get(step.id), f = step.flow, continuation = tokens.get(f.continuation)?.match(/^续\s*(\d+)$/);
        record.flow = { reading: true, forward: true, axis: 'x', direction: 1, graph: true,
          routeId: namespace + ':' + f.routeId, laneId: namespace + ':' + f.laneId,
          rowLeft: f.rowLeft, rowWidth: f.rowWidth, rowY: f.rowY, rowBottom: f.rowBottom, rowRight: f.rowRight, steps: f.steps,
          arrowStartX: step.arrow.start.x, arrowStartY: step.arrow.start.y, arrowEndX: step.arrow.end.x, arrowEndY: step.arrow.end.y,
          anchors: [...new Set([...record.reactants, ...record.products])].map(atomId => {
            const point = a.atomPos(a.atomIdOf(atomId)); return { atomId, x: point.x, y: point.y };
          }),
          ...(continuation && { continuation: Number(continuation[1]) }) };
        entries.push({ record, ...step.arrow, labelPoints: {} });
      }
      actions.push(connectorGeometryAction(entries).perform(ed.render.ctab));
      for (const record of list) if (record.conditions) {
        const line = { start: record.start, end: record.end }, label = { role: 'conditions', text: record.conditions,
          ...reactionLabelPosition(record.conditions, line, boxes) };
        const before = new Set(ed.struct().texts.keys());
        actions.push(native.createText(ed.render.ctab, label.text, label));
        const id = [...ed.struct().texts.keys()].find(id => !before.has(id));
        record.labels.push({ id, role: label.role, text: label.text, nativeContent: ed.struct().texts.get(id).content });
      }
      for (const cue of planned.cues) for (const end of cue.ends) {
        const record = byId.get(end.stepId), text = tokens.get(cue.token);
        if (!record || record.labels.length >= 129 || cue.moleculeIds.some(id => !partById.has(id))) fail('复杂路线衔接端口超出保存范围', 'reaction_graph_port_limit');
        const anchorRefs = cue.moleculeIds.slice(), labelPoint = { x: end.x - conditionWidth(text) / 2, y: end.y - 0.25 };
        const before = new Set(ed.struct().texts.keys());
        actions.push(native.createText(ed.render.ctab, text, labelPoint));
        const id = [...ed.struct().texts.keys()].find(id => !before.has(id)), nativeText = ed.struct().texts.get(id);
        const anchorBox = unionBoxes(anchorRefs.map(ref => boxes.get(ref).anchorBox || boxes.get(ref))), center = midpoint(anchorBox);
        record.labels.push({ id, role: 'graphPort', text, token: text, kind: cue.kind,
          side: end.side === 'reactants' ? 'source' : 'target', at: end.at, anchorRefs,
          layoutX: nativeText.position.x, layoutY: nativeText.position.y,
          ...(end.at === 'molecule' && { anchorDx: nativeText.position.x - center.x, anchorDy: nativeText.position.y - center.y }),
          nativeContent: nativeText.content });
      }
      list.graphBounds = planned.bounds;
      return list;
    }
    app.reactionSteps = { export: exportReactionSteps, restore: restoreReactionSteps,
      exportOperations: () => copy([...stepOperations.values()]), captureRuntime: captureStepRuntime, restoreRuntime: restoreStepRuntime,
      translateRuntime: translateStepRuntime, scaleRuntime: scaleStepRuntime,
      captureClipboard: captureClipboardSteps, prepareClipboardImport, appendClipboard: appendClipboardSteps, wrapClipboardHistory };
    // Task metadata is saved with the drawing, but never enters native drawing
    // history or the canvas revision fence. A checkpoint write must not make
    // its own in-flight chemical transaction stale.
    app.agentTask = {
      export: () => copy(taskCheckpoint),
      restore: value => { taskCheckpoint = MW.storage.validateAgentTask(value); taskCheckpointOwner = null; },
      captureFence: () => signatureNow() + '\n' + canonical(taskCheckpoint)
    };
    function checkpointDirty() { root.__mechDirtyTick = (root.__mechDirtyTick || 0) + 1; }
    function getTaskCheckpoint() {
      return withSettledCanvas(() => copy(taskCheckpoint));
    }
    function setTaskCheckpoint(runId, value) {
      return withSettledCanvas(() => {
        scan();
        const run = getRun(runId);
        checkRun(run);
        let next = MW.storage.validateAgentTask(value);
        if (next && taskCheckpoint?.taskId === next.taskId) {
          // A successful drawing transaction records IDs before returning its
          // receipt. A concurrently stopped runtime may still hold an earlier
          // metadata copy; it must never erase that committed history.
          const previous = new Map(taskCheckpoint.phases.map(phase => [phase.id, phase]));
          next = MW.storage.validateAgentTask({ ...next,
            completedOperationIds: [...new Set([...taskCheckpoint.completedOperationIds, ...next.completedOperationIds])].slice(-4096),
            phases: next.phases.map(phase => ({ ...phase,
              operationIds: [...new Set([...(previous.get(phase.id)?.operationIds || []), ...phase.operationIds])].slice(-160) })) });
        }
        taskCheckpointOwner = runId;
        if (canonical(next) !== canonical(taskCheckpoint)) {
          taskCheckpoint = next;
          checkpointDirty();
        }
        return copy(taskCheckpoint);
      });
    }
    function pauseTaskCheckpoint(runId, reason = 'interrupted') {
      // Cancellation can arrive after the AbortSignal was set. Only this
      // document's current run may mark its own checkpoint paused; late work
      // from a replaced document or an earlier task cannot touch it.
      const run = runs.get(runId);
      if (disposed || replacement || !run || run.sessionId !== sessionId || currentRun !== runId || taskCheckpointOwner !== runId || !taskCheckpoint || taskCheckpoint.status === 'completed') return copy(taskCheckpoint);
      taskCheckpoint = MW.storage.validateAgentTask({ ...taskCheckpoint, status: 'paused',
        checks: { status: 'pending', issues: [] }, pauseReason: String(reason || 'interrupted').slice(0, 160), updatedAt: Date.now() });
      checkpointDirty();
      return copy(taskCheckpoint);
    }
    function checkpointCommittedOperations(run, operations) {
      if (taskCheckpointOwner !== run.id || !taskCheckpoint || taskCheckpoint.status === 'completed') return;
      const index = taskCheckpoint.phaseIndex, phase = taskCheckpoint.phases[index];
      if (!phase) return;
      const ids = operations.map(op => op.id);
      const next = { ...taskCheckpoint,
        phases: taskCheckpoint.phases.map((item, i) => i === index ? { ...item,
          operationIds: [...new Set([...item.operationIds, ...ids])].slice(-160) } : item),
        completedOperationIds: [...new Set([...taskCheckpoint.completedOperationIds, ...ids])].slice(-4096),
        updatedAt: Date.now() };
      taskCheckpoint = MW.storage.validateAgentTask(next);
      checkpointDirty();
    }
    function incomingStage(boxes, pending = new Map()) {
      const incoming = [...reactionConnectors.values(), ...pending.values()].filter(record =>
        boxes.some(box => record.productComponents.includes(box.component)) && connectorStillDrawn(record));
      return incoming.length === 1 ? incoming[0] : null;
    }
    function incomingStageDivider(boxes, record) {
      if (!record) return null;
      const { start, end } = record;
      const dx = end.x - start.x, dy = end.y - start.y;
      const axis = Math.abs(dy) < 0.01 ? 'x' : Math.abs(dx) < 0.01 ? 'y' : null;
      if (!axis) return null;
      const direction = Math.sign(end[axis] - start[axis]), boundary = end[axis];
      const separated = boxes.every(box => direction * (box[axis + (direction > 0 ? '1' : '2')] - boundary) > 0);
      return separated ? { axis, direction, boundary } : null;
    }
    function unionBoxes(parts) {
      return { x1: Math.min(...parts.map(p => p.x1)), y1: Math.min(...parts.map(p => p.y1)),
        x2: Math.max(...parts.map(p => p.x2)), y2: Math.max(...parts.map(p => p.y2)) };
    }
    function nextStageFlow(previous, from, to) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const direction = Math.sign(dx) || 1;
      return Math.abs(dx) >= Math.abs(dy) ? { direction, steps: (previous?.direction === direction ? previous.steps : 0) + 1 }
        : { direction: -(previous?.direction || 1), steps: 0 };
    }
    function conditionWidth(text) {
      return Math.max(0.6, Array.from(text || '').reduce((width, char) => width + (/^[\x20-\x7e]$/.test(char) ? 0.23 : 0.45), 0));
    }
    function reactionLabel(op, vertical) {
      if (!op.layout) return '';
      const conditions = op.layout.conditions?.trim() || '';
      return vertical ? ['续', conditions].filter(Boolean).join(' · ') : conditions;
    }
    function reactionLabelPosition(text, line, boxes, vertical = Math.abs(line.end.y - line.start.y) > Math.abs(line.end.x - line.start.x)) {
      const center = M.lerp(line.start, line.end, 0.5);
      const size = { width: conditionWidth(text), height: 0.5 };
      const seed = vertical ? { x: center.x + 0.32 + size.width / 2, y: center.y }
        : { x: center.x, y: center.y - 0.4 };
      const obstacles = [...new Set(boxes.values())];
      const placed = openCanvasCenter(seed, size, obstacles, 0.15, { axis: vertical ? 'x' : 'y', direction: vertical ? 1 : -1 });
      return { x: placed.x - size.width / 2, y: placed.y - size.height / 2 };
    }
    function connectorLine(sides, boxes, flow) {
      if (!flow?.continuation) return reactionLine(sides, boxes, flow?.axis, flow?.forward, flow?.rowY);
      const products = unionBoxes(sides.products), y = midpoint(products).y;
      // The cue is a visual proxy. The connector still refers to the true
      // reactant structures in the previous row.
      const x = products.x1 - LAYOUT.arrowLength - 0.42;
      return reactionLine({ reactants: [{ x1: x - 0.9, x2: x, y1: y - 0.25, y2: y + 0.25 }],
        products: sides.products }, boxes, 'x', true, flow.rowY ?? y);
    }
    function connectorLabels(conditions, line, sides, boxes, flow) {
      const labels = [];
      if (conditions) labels.push({ role: 'conditions', text: conditions, ...reactionLabelPosition(conditions, line, boxes) });
      if (flow?.continuation) {
        const text = '续 ' + flow.continuation, width = conditionWidth(text), source = unionBoxes(sides.reactants);
        const y = flow.sourceRowY >= source.y1 && flow.sourceRowY <= source.y2 ? flow.sourceRowY : midpoint(source).y;
        const cue = openCanvasCenter({ x: source.x2 + 0.4 + width / 2, y },
          { width, height: 0.5 }, [...new Set(boxes.values())], 0.18, { axis: 'x', direction: 1 });
        labels.push({ role: 'previousRow', text, x: cue.x - width / 2, y: cue.y - 0.25 },
          { role: 'nextRow', text, x: line.start.x - width - 0.22, y: line.start.y - 0.25 });
      }
      return labels;
    }
    function continuationPosition(size, rowLeft, rowBottom, gap, obstacles) {
      const lead = LAYOUT.continuationLane + Math.max(0, gap - LAYOUT.stepGap);
      const row = { width: size.width + lead, height: Math.max(size.height, 1.6) };
      const seed = { x: rowLeft + row.width / 2, y: rowBottom + LAYOUT.readingRowGap + row.height / 2 };
      const at = clearAlong(seed, row, obstacles, LAYOUT.minReactionGap, 'y', 1);
      return { center: { x: at.x + lead / 2, y: at.y }, box: boxAt(at, row) };
    }
    function nextContinuation(stages, pending = new Map()) {
      const drawn = [...reactionConnectors.values(), ...pending.values()].filter(connectorStillDrawn);
      return 1 + Math.max(0, ...drawn.map(record => record.flow?.continuation || 0),
        ...[...stages.values()].map(stage => stage.continuation || 0));
    }
    function alignUnconnectedProducts(op, sides, boxes, run, stages, pending, actions, movedAtoms) {
      // A model may supply the connector after committing its molecules.
      // Only settle loose products created by this run. A user's objects and
      // structures already in a committed reaction stay where they are.
      const products = new Set(sides.products);
      const components = connectedComponents().filter(part => products.has(boxes.get(part.uuids[0])));
      if (components.length !== products.size || components.some(part => !part.uuids.every(id => run.looseAtoms.has(id)))) return null;
      const connected = new Set([...reactionConnectors.values(), ...pending.values()].filter(connectorStillDrawn)
        .flatMap(record => [...record.reactants, ...record.products].map(id => boxes.get(id))));
      if ([...products].some(box => connected.has(box))) return null;
      const source = unionBoxes(sides.reactants), target = unionBoxes(sides.products);
      const gap = op.layout?.conditions ? Math.max(LAYOUT.stepGap, conditionWidth(op.layout.conditions) + 0.7) : LAYOUT.stepGap;
      const groups = components.map(part => ({ ...part, box: boxes.get(part.uuids[0]) }));
      const width = groups.reduce((sum, part) => sum + part.box.x2 - part.box.x1, 0) + (groups.length - 1) * LAYOUT.groupGap;
      const height = Math.max(...groups.map(part => part.box.y2 - part.box.y1));
      const rids = groups.flatMap(part => part.rids), size = { width, height };
      const previous = incomingStage(sides.reactants, pending)?.flow;
      const steps = previous?.steps || 0, rowLeft = previous?.rowLeft ?? source.x1;
      const sourceRowY = previous?.rowY ?? midpoint(source).y;
      const rowBottom = Math.max(previous?.rowBottom ?? source.y2, source.y2);
      const rowWidth = paperTarget() ? readingWidth() : previous?.rowWidth ?? LAYOUT.readingRowWidth;
      const tooWide = source.x2 + gap + width > rowLeft + rowWidth;
      const wraps = steps > 0 && (tooWide || (op.layout?.breakBefore ?? steps >= LAYOUT.rowSteps));
      if (!wraps && target.x1 >= source.x2 + 0.95 && Math.abs(midpoint(target).y - sourceRowY) <= 0.18) return null;
      const obstacles = occupiedBoxes(new Set(rids));
      const seed = { x: source.x2 + gap + width / 2, y: sourceRowY };
      const at = wraps ? continuationPosition(size, rowLeft, rowBottom, gap, obstacles).center
        : clearAlong(seed, size, obstacles, LAYOUT.minReactionGap, 'x', 1);
      let left = at.x - width / 2;
      const coords = [];
      for (const part of groups) {
        const dx = left - part.box.x1, dy = at.y - midpoint(part.box).y;
        coords.push(...part.rids.map(rid => {
          const point = a.atomPos(rid);
          return [rid, point.x + dx, point.y + dy];
        }));
        for (const id of part.uuids) movedAtoms.add(id);
        left += part.box.x2 - part.box.x1 + LAYOUT.groupGap;
      }
      const old = captureAtomCoords(ed.struct(), rids);
      applyAtomCoords(ed.struct(), coords);
      markMovedAtoms(ed.render.ctab, rids);
      actions.push(coordinateMoveAction(old));
      return { reading: true, forward: true, axis: 'x', direction: 1, rowLeft, rowY: at.y,
        rowBottom: wraps ? at.y + height / 2 : Math.max(rowBottom, at.y + height / 2),
        rowRight: at.x + width / 2, rowWidth,
        steps: wraps ? 1 : steps + 1, ...(wraps && { continuation: nextContinuation(stages, pending), sourceRowY }) };
    }
    function reactionLine({ reactants, products }, moleculeBoxes, preferredAxis, forwardOnly = false, rowY) {
      const obstacles = [...new Set(moleculeBoxes.values())];
      const margin = 0.12, minLength = 0.55;
      const fit = (a, b) => {
        const available = M.dist(a, b);
        if (available < minLength) return null;
        const shaft = Math.min(1, LAYOUT.arrowLength / available), slack = 1 - shaft;
        for (const weight of slack > 0.01 ? [0.5, 0.2, 0.8, 0, 1] : [0.5]) {
          const offset = slack * weight;
          const start = M.lerp(a, b, offset), end = M.lerp(a, b, offset + shaft);
          const blocked = obstacles.some(box => Math.min(start.x, end.x) < box.x2 + margin &&
            Math.max(start.x, end.x) > box.x1 - margin && Math.min(start.y, end.y) < box.y2 + margin &&
            Math.max(start.y, end.y) > box.y1 - margin && MW.route.segRectDistance(start, end, box) < margin);
          if (!blocked) return { start, end };
        }
        return null;
      };
      const between = (from, to) => {
        const source = midpoint(from), target = midpoint(to);
        const distance = M.dist(source, target);
        let diagonal;
        if (!forwardOnly && distance > 0) {
          const dx = (target.x - source.x) / distance, dy = (target.y - source.y) / distance;
          const clearance = box => Math.min((box.x2 - box.x1) / (2 * Math.abs(dx)),
            (box.y2 - box.y1) / (2 * Math.abs(dy))) + 0.2;
          const begin = clearance(from), finish = clearance(to);
          if (distance - begin - finish >= minLength) {
            diagonal = fit({ x: source.x + dx * begin, y: source.y + dy * begin },
              { x: target.x - dx * finish, y: target.y - dy * finish });
            if (diagonal && !preferredAxis) return diagonal;
          }
        }
        for (const axis of forwardOnly ? ['x'] : preferredAxis === 'y' ? ['y', 'x'] : ['x', 'y']) {
          const cross = axis === 'x' ? 'y' : 'x';
          const direction = Math.sign(target[axis] - source[axis]);
          if (forwardOnly && direction !== 1) continue;
          const start = from[axis + (direction > 0 ? '2' : '1')] + direction * 0.2;
          const end = to[axis + (direction > 0 ? '1' : '2')] - direction * 0.2;
          if (direction * (end - start) < minLength) continue;
          const lo = Math.max(from[cross + '1'], to[cross + '1']), hi = Math.min(from[cross + '2'], to[cross + '2']);
          if (lo > hi) continue;
          for (const weight of [0.5, 0.2, 0.8]) {
            const offset = lo + (hi - lo) * weight;
            const line = fit({ [axis]: start, [cross]: offset }, { [axis]: end, [cross]: offset });
            if (line) return line;
          }
        }
        return diagonal || null;
      };
      // Dispersed spectators can make stage unions overlap while the main molecules still face a clear gap.
      const area = box => (box.x2 - box.x1) * (box.y2 - box.y1);
      const sources = reactants.slice().sort((a, b) => area(b) - area(a));
      const targets = products.slice().sort((a, b) => area(b) - area(a));
      const source = unionBoxes(reactants), target = unionBoxes(products);
      const findLine = makeLine => {
        const groupLine = makeLine(source, target);
        if (groupLine) return groupLine;
        for (const from of sources) for (const to of targets) {
          const line = makeLine(from, to);
          if (line) return line;
        }
      };
      const laneBlocks = obstacles.filter(box => rowY > box.y1 - margin && rowY < box.y2 + margin)
        .sort((a, b) => a.x1 - b.x1);
      const aligned = Number.isFinite(rowY) && findLine((from, to) => {
        const start = from.x2 + 0.2, end = to.x1 - 0.2;
        if (end - start < minLength || rowY < Math.max(from.y1, to.y1) || rowY > Math.min(from.y2, to.y2)) return null;
        // Fit the arrow inside the longest clear part of this row's lane.
        // A spectator grazing one end should shorten it before it changes height.
        let left = start, best = null, length = minLength;
        const remember = right => {
          if (right - left < length) return;
          best = [left, right]; length = right - left;
        };
        for (const box of laneBlocks) {
          const lo = box.x1 - margin - 1e-6, hi = box.x2 + margin + 1e-6;
          if (hi <= left) continue;
          if (lo >= end) break;
          remember(lo);
          left = hi;
          if (left >= end) break;
        }
        remember(end);
        return best && fit({ x: best[0], y: rowY }, { x: best[1], y: rowY });
      });
      const line = aligned || findLine(between);
      if (line) return line;
      fail('反应组分之间没有无碰撞的直箭头通道，请移动相关分子后继续', 'reaction_arrow_gap');
    }
    function insertReactionArrow(line) {
      const { start, end } = line;
      const ket = { root: { nodes: [{ type: 'arrow', data: { mode: 'open-angle',
        pos: [start, end].map(p => ({ x: p.x, y: -p.y, z: 0 })) } }] } };
      const fragment = native.prepareKet(JSON.stringify(ket));
      return native.paste(ed.render.ctab, fragment, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
    }
    function connectorGeometryAction(entries) {
      return {
        operations: [],
        isDummy: () => false,
        perform(ctab) {
          const inverse = [];
          for (const { record, start, end, labelPoints } of entries) {
            const arrow = ctab.molecule.rxnArrows.get(record.id);
            if (!arrow) continue;
            const priorPoints = {};
            inverse.push({ record, start: { ...arrow.pos[0] }, end: { ...arrow.pos[1] },
              labelPoints: priorPoints });
            Object.assign(arrow.pos[0], start);
            Object.assign(arrow.pos[1], end);
            record.start = { ...start }; record.end = { ...end }; record.nativeArrow = arrow;
            ctab.markItem('rxnArrows', record.id, 1);
            for (const label of record.labels || []) {
              const text = ctab.molecule.texts.get(label.id), point = labelPoints[label.role];
              if (!point || !text?.position || text.content !== label.nativeContent) continue;
              priorPoints[label.role] = { x: text.position.x, y: text.position.y };
              Object.assign(text.position, { x: point.x, y: point.y });
              ctab.markItem('texts', label.id, 1);
            }
          }
          return connectorGeometryAction(inverse);
        }
      };
    }
    function reflowMovedConnectors(movedAtoms, pending, actions) {
      if (!movedAtoms.size) return;
      const boxes = reactionMoleculeBoxes();
      const moved = new Set([...movedAtoms].map(id => boxes.get(id)).filter(Boolean));
      const entries = [];
      for (const record of new Set([...reactionConnectors.values(), ...pending.values()])) {
        const refs = [...record.reactants, ...record.products];
        if (!connectorStillDrawn(record) || !refs.every(id => boxes.has(id)) || !refs.some(id => moved.has(boxes.get(id)))) continue;
        if (record.flow?.graph) continue;
        const sides = reactionSides(record, boxes, id => id);
        // Respect an explicit move even if a normal same-row connector has
        // to go diagonal. A wrap still uses its continuation cue.
        const line = connectorLine(sides, boxes, record.flow && { ...record.flow, forward: false });
        const conditions = record.labels?.find(label => label.role === 'conditions')?.text;
        const labels = connectorLabels(conditions, line, sides, boxes, record.flow);
        entries.push({ record, ...line, labelPoints: Object.fromEntries(labels.map(label => [label.role, label])) });
      }
      if (entries.length) actions.push(connectorGeometryAction(entries).perform(ed.render.ctab));
    }
    function entityRef(op, field, aliases, verify) {
      const raw = op[field];
      const resolved = aliases.get(raw) || raw;
      if (!verify(resolved)) {
        const straight = field === 'arrowId' && /^(0|[1-9][0-9]*)$/.test(raw) && ed.struct().rxnArrows.has(Number(raw));
        throw Object.assign(new Error(straight
          ? '这根是直反应箭头。请从 arrows 列表引用电子流弯箭头。'
          : field + ' 引用不存在：' + raw), { code: straight ? 'wrong_arrow_type' : 'missing_reference', field });
      }
      return { input: raw, id: resolved };
    }
    /* 级联依赖（规范 6）：删除原子/分子时，移除指向被删对象的孤对与箭头（直接依赖，有界）。 */
    function mechanismCascade(removedAtomUuids, removedBondUuids, removedLonePairIds) {
      const atoms = new Set(removedAtomUuids), bonds = new Set(removedBondUuids), lps = new Set(removedLonePairIds);
      const lonePairs = model.state.lonePairs.filter(lp => atoms.has(lp.ownerAtomId)).map(lp => lp.id);
      for (const id of lonePairs) lps.add(id);
      const arrows = [];
      for (const arrow of model.state.arrows) {
        const refs = [arrow.source, arrow.target];
        const orphaned = refs.some(endpointValue => {
          if (!endpointValue) return false;
          if (endpointValue.type === 'atom' || endpointValue.type === 'formingBond') {
            const ids = M.endpointAtomIds(endpointValue);
            return ids.some(entry => atoms.has(entry));
          }
          if (endpointValue.type === 'bond') return bonds.has(endpointValue.bondId);
          if (endpointValue.type === 'lonePair') return lps.has(endpointValue.slotId);
          return false;
        });
        const formingBond = arrow.target && arrow.target.type === 'formingBond' ? arrow.target : null;
        if (orphaned || (formingBond && (atoms.has(formingBond.atomA) || atoms.has(formingBond.atomB)))) arrows.push(arrow.id);
      }
      return { lonePairs, arrows };
    }
    function applyMechanismCascade(cascade) {
      for (const id of cascade.arrows) model.removeArrow(id);
      for (const id of cascade.lonePairs) model.removeLonePair(id);
    }
    async function applyOperations(input, settings = {}) {
      const ops = validateOperations(input), run = getRun(settings.runId, true);
      checkRun(run, settings.signal);
      const newAliases = ops.filter(op => op.type === 'molecule.add' && !run.applied.has(op.id)).map(op => op.id);
      for (const op of ops) if (isStepOperation(op) && stepOperations.has(op.id) &&
          [...(op.reactants || []), ...(op.products || [])].some(ref => newAliases.some(id => ref.startsWith(id + ':')))) {
        fail('已消费步骤操作中的分子别名被重新创建，请使用当前稳定引用和新的步骤操作 id', 'operation_conflict');
      }
      const fresh = ops.filter(op => {
        if (isStepOperation(op) && stepOperations.has(op.id)) { stepReplay(op, run); return false; }
        const previous = run.applied.get(op.id);
        if (!previous && taskCheckpointOwner === run.id && taskCheckpoint?.completedOperationIds.includes(op.id)) fail('此操作编号已在保存任务中提交；请读取当前对象，后续修改使用新编号：' + op.id, 'operation_conflict');
        if (previous && previous.hash !== canonical(op)) fail('操作 id 已用于不同内容：' + op.id, 'operation_conflict');
        return !previous;
      });
      if (!fresh.length) return response(run, replayReceipts(ops, run), '这些操作已经完成，没有重复执行。');
      const prepared = await prepare(fresh, settings.signal);
      const execute = () => {
        scan(); checkRun(run, settings.signal); a.syncIdentity(); refreshReactionGlyphs();
        // A retry may have entered the queue before the first call committed.
        // Recheck at the mutation boundary, not only before asynchronous parsing.
        const actualFresh = fresh.filter(op => {
          if (isStepOperation(op) && stepOperations.has(op.id)) { stepReplay(op, run); return false; }
          const previous = run.applied.get(op.id);
          if (!previous && taskCheckpointOwner === run.id && taskCheckpoint?.completedOperationIds.includes(op.id)) fail('此操作编号已在保存任务中提交；请读取当前对象，后续修改使用新编号：' + op.id, 'operation_conflict');
          if (previous && previous.hash !== canonical(op)) fail('操作 id 已用于不同内容：' + op.id, 'operation_conflict');
          return !previous;
        });
        if (!actualFresh.length) return response(run, replayReceipts(ops, run), '这些操作已经完成，没有重复执行。');
        const ordered = dependencyOrder(actualFresh);
        const view = ordered.some(op => op.type === 'molecule.add' || op.type === 'text.add') ? layoutViewport() : null;
        const oldStageOrigins = new Map(run.stageOrigins), oldPlacements = new Map(run.placements), oldAnchor = run.anchor && { ...run.anchor }, oldGraphBounds = run.graphBounds && { ...run.graphBounds };
        let drawingLayout;
        try { drawingLayout = planAdditions(ordered, prepared, view, occupiedBoxes(), run); }
        catch (error) {
          run.stageOrigins = oldStageOrigins; run.placements = oldPlacements; run.anchor = oldAnchor;
          throw operationError(error, 'layout');
        }
        const oldMech = model.cloneState(), oldSelection = new Set(controller.selection), tables = tablesFor(run);
        const oldStepRuntime = captureStepRuntime();
        const pendingConnectors = new Map();
        const automaticPairs = new Set(run.automaticPairs);
        const actions = [], movedAtoms = new Set(), newRoutes = new Map(), failedExistingRoutes = new Map();
        const created = [], updated = [], deleted = [], cascaded = [], warnings = [];
        const stepEdits = [], stepReceipts = [], layoutSeeds = [];
        const mapNames = ['atomUuid', 'uuidAtom', 'atomSig', 'atomLast', 'bondUuid', 'uuidBond', 'bondSig', 'bondEndpoints'];
        const identities = Object.fromEntries(mapNames.map(key => [key, new Map(a[key])]));
        const activeAtoms = a.activeAtoms && new Set(a.activeAtoms), activeBonds = a.activeBonds && new Set(a.activeBonds);
        const oldHistoryPtr = ed.historyPtr, oldHistoryStack = ed.historyStack.slice();
        const poolOrder = ['atoms', 'bonds', 'frags', 'texts', 'rxnArrows', 'rxnPluses', 'simpleObjects', 'images'].filter(key => ed.struct()[key]).map(key => [key, [...ed.struct()[key].keys()]]);
        let nativeGeometryChanged = false, routeRevision = 0, activeOperation;
        const flushNativeGeometry = () => {
          if (!nativeGeometryChanged) return;
          // Render native glyphs for clearance checks without adding a history entry.
          ed.render.update();
          refreshReactionGlyphs();
          nativeGeometryChanged = false;
        };
        writeDepth++;
        try {
          for (const op of ordered) {
            if (['molecule.add', 'molecule.move', 'molecule.delete', 'hydrogen.makeExplicit', 'atom.modify', 'atom.delete',
              'bond.add', 'bond.modify', 'bond.delete', 'layout.tidy'].includes(op.type)) nativeGeometryChanged = true;
            activeOperation = op;
            abort(settings.signal);
            if (/^(molecule|atom|bond|hydrogen)\./.test(op.type)) {
              nativeGeometryChanged = true;
              routeRevision++;
            }
            if (op.type === 'molecule.add') {
              const data = prepared.get(op.id), fragment = drawingLayout.fragments.get(op.id);
              const placed = placement(op, run, view, fragment, occupiedBoxes(), drawingLayout);
              warnings.push(...placed.warnings.map(text => op.id + ': ' + text));
              const paste = native.paste(ed.render.ctab, fragment, placed), inserted = paste[1];
              actions.push(paste[0]); a.syncIdentity();
              if (inserted.atoms.length !== data.atoms.length || inserted.bonds.length !== data.bonds.length) fail('新增片段身份无法对照');
              const atoms = data.atoms.map(record => {
                const id = a.uuidOfAtom(inserted.atoms[record.index]);
                if (!id) fail('新增原子缺少稳定身份');
                tables.atoms.set(op.id + ':' + record.ref, id);
                return { ref: record.ref, id, label: record.label };
              });
              const bonds = data.bonds.map(record => {
                const rid = inserted.bonds[record.index], id = a.uuidOfBond(rid);
                if (!id) fail('新增键缺少稳定身份');
                tables.bonds.set(op.id + ':' + record.ref, id); tables.bonds.set(op.id + ':bond:' + record.ref, id);
                return { ref: record.ref, id, begin: String(record.begin), end: String(record.end), ...bondObservation(ed.struct().bonds.get(rid)) };
              });
              created.push({ id: op.id, type: op.type, atoms, bonds, entityIds: atoms.concat(bonds).map(item => item.id), x: placed.x, y: placed.y });
            } else if (op.type === 'hydrogen.makeExplicit') {
              const so = structOpsRequired(), st = ed.struct(), ctab = ed.render.ctab;
              const parentId = atomId(op.parentAtomId, tables.atoms), parentRid = a.atomIdOf(parentId);
              const plan = makeExplicitHydrogenPlan({ parentAtomId: parentId, ...hydrogenEnvironment() });
              const position = explicitHydrogenPosition(parentId, 'new-hydrogen-' + op.id, controller.ctx());
              const oldIds = new Set(st.atoms.keys());
              forwardOps(so, [{ make: () => new so.atomAttr(parentRid, 'implicitHCount', plan.implicitAfter) },
                { make: () => new so.atomAdd({ label: 'H', charge: 0, radical: 0, implicitHCount: 0,
                  fragment: st.atoms.get(parentRid).fragment }, new so.vec(position.x, position.y)) }], ctab, settings.signal, actions, [parentRid]);
              const added = [...st.atoms.keys()].filter(rid => !oldIds.has(rid));
              if (added.length !== 1) fail('新增显式氢身份不明确');
              const hydrogenRid = added[0];
              forwardOps(so, [{ make: () => new so.bondAdd(parentRid, hydrogenRid, { type: 1 }) }], ctab, settings.signal, actions, [parentRid, hydrogenRid]);
              a.syncIdentity();
              const hydrogenId = a.uuidOfAtom(hydrogenRid);
              const bondRid = [...st.bonds].find(([, bond]) => bond.begin === parentRid && bond.end === hydrogenRid ||
                bond.begin === hydrogenRid && bond.end === parentRid)?.[0], bondId = bondRid === undefined ? null : a.uuidOfBond(bondRid);
              if (!hydrogenId || !bondId) fail('显式氢或新键缺少稳定身份');
              tables.atoms.set(op.id + ':1', hydrogenId); tables.bonds.set(op.id + ':1', bondId); tables.bonds.set(op.id + ':bond:1', bondId);
              const after = hydrogenEnvironment(), total = after.atoms.reduce((sum, atom) => sum + (atom.label === 'H' ? 1 : 0) + (Number(atom.implicitH) || 0), 0);
              if (after.atoms.find(atom => atom.id === parentId)?.implicitH !== plan.implicitAfter || total !== plan.hydrogenTotalBefore) {
                fail('显式化后氢总数不守恒，已取消操作', 'hydrogen_explicit_conservation');
              }
              movedAtoms.add(parentId); movedAtoms.add(hydrogenId);
              created.push({ id: op.id, type: op.type, ...plan, hydrogenTotalAfter: total,
                atoms: [{ ref: '1', id: hydrogenId, label: 'H' }],
                bonds: [{ ref: '1', id: bondId, begin: parentId, end: hydrogenId }], entityIds: [hydrogenId, bondId] });
              updated.push({ id: op.id, type: op.type, atomIds: [parentId, hydrogenId], parentAtomId: parentId,
                implicitBefore: plan.implicitBefore, implicitAfter: plan.implicitAfter, entityIds: [parentId] });
            } else if (op.type === 'lonePair.add') {
              const ownerAtomId = atomId(op.atom, tables.atoms);
              const lp = M.makeLonePair(ownerAtomId, { origin: 'manual', angle: own(op, 'angle') ? op.angle : 0 });
              model.addLonePair(lp); tables.entities.set(op.id, lp.id);
              if (!own(op, 'angle')) automaticPairs.add(lp.id);
              created.push({ id: op.id, type: op.type, entityIds: [lp.id], atom: ownerAtomId });
            } else if (op.type === 'arrow.add') {
              flushNativeGeometry();
              const source = resolveEndpoint(op.source, tables), target = resolveEndpoint(op.target, tables);
              const arrow = M.makeArrow(source, target, { electronCount: op.electronCount });
              const ctx = controller.ctx();
              orientAutomaticPair(source, target, automaticPairs, ctx, model.state.lonePairs);
              validateArrowAnchors(M, source, target, ctx, op);
              model.addArrow(arrow);
              const plan = controller.replanArrowInPlace(arrow, true, { preferClearArrows: true });
              if (!plan) fail('箭头无法排布');
              if (M.arrowGeometry(arrow, controller.ctx()).degenerate) fail('箭头无法避开原子标签');
              tables.entities.set(op.id, arrow.id);
              const entry = { id: op.id, type: op.type, entityIds: [arrow.id] };
              newRoutes.set(arrow.id, { op, entry, plan, revision: routeRevision });
              created.push(entry);
            } else if (op.type === 'reactionStep.modify' || op.type === 'reactionStep.delete') {
              const stepId = tables.steps.get(op.stepId) || op.stepId;
              const record = findStep(stepId, pendingConnectors);
              if (!record) fail('步骤不存在或已删除，请重新 read_canvas：' + op.stepId, 'missing_reference');
              if (record.version !== op.expectedVersion) fail('步骤 ' + stepId + ' 版本已变化（当前 ' + record.version + '，请求 ' + op.expectedVersion + '），请重新读取后修改', 'step_version_conflict');
              const before = stepObservation(record), replacement = cloneConnector(record);
              replacement.version++;
              if (!Number.isSafeInteger(replacement.version)) fail('步骤版本已超出范围', 'step_version_conflict');
              removeStepLabels(replacement, actions, settings.signal);
              for (const map of [reactionConnectors, pendingConnectors]) for (const [key, value] of map) if (value.stepId === stepId) map.delete(key);
              if (op.type === 'reactionStep.delete') {
                const so = structOpsRequired();
                if (!so.rxnArrowDelete) fail('当前编辑器缺少直箭头删除操作，请更新构建', 'struct_ops_unavailable');
                forwardOps(so, [{ make: () => new so.rxnArrowDelete(record.id) }], ed.render.ctab, settings.signal, actions);
                deleted.push({ id: op.id, type: op.type, stepId, version: replacement.version, reactionArrowId: String(record.id), entityIds: [] });
                stepEdits.push({ op, before, record: null, version: replacement.version });
              } else {
                if (op.reactants) replacement.reactants = op.reactants.map(ref => atomId(ref, tables.atoms));
                if (op.products) replacement.products = op.products.map(ref => atomId(ref, tables.atoms));
                replacement.layout = { ...(record.conditions ? { conditions: record.conditions } : {}), ...(record.layout || {}), ...(op.layout || {}) };
                replacement.conditions = replacement.layout.conditions?.trim() || '';
                const boxes = reactionMoleculeBoxes(), sides = reactionSides(replacement, boxes, id => id);
                if (knownConnector(sides.key, pendingConnectors)) fail('该连接属于另一反应步骤，请读取并修改该步骤', 'reaction_step_exists');
                replacement.productComponents = sides.products.map(box => box.component);
                reactionConnectors.set(sides.key, replacement);
                updated.push({ id: op.id, type: op.type, stepId, version: replacement.version, reactionArrowId: String(record.id), before, entityIds: [] });
                stepEdits.push({ op, before, record: replacement, version: replacement.version });
              }
              nativeGeometryChanged = true; routeRevision++;
            } else if (isStepDeclaration(op)) {
              flushNativeGeometry();
              let boxes = reactionMoleculeBoxes();
              let sides = reactionSides(op, boxes, ref => atomId(ref, tables.atoms));
              if (knownConnector(sides.key, pendingConnectors)) {
                if (op.type === 'reactionStep.create') fail('该连接已有稳定步骤，请读取后修改原步骤', 'reaction_step_exists');
                warnings.push(op.id + ': 该反应步骤已有直箭头，已复用');
                continue;
              }
              let stageFlow = drawingLayout.stageFlow.get(op.id);
              if (run.readingOrder && !stageFlow?.forward && !stageFlow?.continuation) {
                const aligned = alignUnconnectedProducts(op, sides, boxes, run, drawingLayout.stageFlow, pendingConnectors, actions, movedAtoms);
                if (aligned) {
                  stageFlow = aligned;
                  boxes = reactionMoleculeBoxes();
                  sides = reactionSides(op, boxes, ref => atomId(ref, tables.atoms));
                  nativeGeometryChanged = true;
                }
              }
              const line = op.type === 'reactionStep.create'
                ? { start: { x: unionBoxes(sides.reactants).x2 + 0.2, y: midpoint(unionBoxes(sides.reactants)).y },
                  end: { x: unionBoxes(sides.reactants).x2 + 0.2 + LAYOUT.arrowLength, y: midpoint(unionBoxes(sides.reactants)).y } }
                : connectorLine(sides, boxes, stageFlow);
              const [action, , added] = insertReactionArrow(line);
              actions.push(action);
              routeRevision++;
              const reactionArrowId = added?.rxnArrows?.[0];
              if (reactionArrowId === undefined) fail('未能创建原生反应箭头');
              const vertical = line.end.y - line.start.y > Math.abs(line.end.x - line.start.x);
              const conditions = reactionLabel(op, vertical);
              const labels = connectorLabels(conditions, line, sides, boxes, stageFlow).map(label => {
                const beforeIds = new Set(ed.struct().texts.keys());
                actions.push(native.createText(ed.render.ctab, label.text, label));
                const id = [...ed.struct().texts.keys()].find(id => !beforeIds.has(id));
                return { id, role: label.role, text: label.text, nativeContent: ed.struct().texts.get(id)?.content };
              });
              const flow = stageFlow || nextStageFlow(incomingStage(sides.reactants, pendingConnectors)?.flow, line.start, line.end);
              const nativeArrow = ed.struct().rxnArrows.get(reactionArrowId);
              const record = { id: reactionArrowId, nativeArrow, mode: nativeArrow.mode, stepId: 'rs-' + uid(), version: 1, layout: copy(op.layout || {}),
                reactants: [...new Set(op.reactants.map(ref => atomId(ref, tables.atoms)))],
                products: [...new Set(op.products.map(ref => atomId(ref, tables.atoms)))],
                productComponents: sides.products.map(box => box.component), flow, ...line, labels,
                conditions: op.layout?.conditions?.trim() };
              pendingConnectors.set(sides.key, record);
              tables.steps.set(op.id, record.stepId);
              if (op.type === 'reactionStep.create') stepEdits.push({ op, before: null, record, version: 1 });
              created.push({ id: op.id, type: op.type, stepId: record.stepId, version: record.version, reactionArrowId: String(reactionArrowId), ...line,
                ...(conditions && { label: conditions }), entityIds: [] });
            } else if (op.type === 'text.add') {
              const beforeIds = new Set(ed.struct().texts.keys());
              const placed = placement(op, run, view, null, occupiedBoxes(), drawingLayout);
              actions.push(native.createText(ed.render.ctab, op.text, textAnchor(op, placed)));
              const nativeId = Array.from(ed.struct().texts.keys()).find(id => !beforeIds.has(id));
              created.push({ id: op.id, type: op.type, entityIds: [], text: op.text, nativeTextId: nativeId });
            } else if (op.type === 'molecule.move') {
              structOpsRequired();
              const warningsLocal = [];
              const target = resolveTargetAtoms(op.target, tables, warningsLocal);
              warnings.push(...warningsLocal.map(text => op.id + ': ' + text));
              const points = target.rids.map(rid => a.atomPos(rid));
              const xs = points.map(p => p.x), ys = points.map(p => p.y);
              const from = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
              const orientation = own(op, 'orientTowardAtomId') ? hydrogenOrientation(op, tables) : null;
              const dx = orientation ? orientation.displacement.dx : own(op, 'x') ? op.x - from.x : op.dx,
                dy = orientation ? orientation.displacement.dy : own(op, 'y') ? op.y - from.y : op.dy;
              if (!Number.isFinite(dx) || !Number.isFinite(dy)) fail('molecule.move 位移无效');
              // 立即落新坐标（事务内），入栈的动作用旧坐标做撤销/重做（与 paste 同约定）
              const oldEntries = target.rids.map(rid => { const p = a.atomPos(rid); return [rid, p.x, p.y]; });
              const newEntries = oldEntries.map(([rid, x, y]) => [rid, x + dx, y + dy]);
              applyAtomCoords(ed.struct(), newEntries);
              markMovedAtoms(ed.render.ctab, target.rids);
              actions.push(coordinateMoveAction(oldEntries));
              for (const uuid of target.uuids) movedAtoms.add(uuid);
              updated.push({ id: op.id, type: op.type, atomIds: target.uuids, molecule: target.handle, from, to: { x: from.x + dx, y: from.y + dy },
                entityIds: target.uuids, ...(orientation || {}) });
              controller.onDirtyHint('AI 移动分子');
            } else if (op.type === 'molecule.delete' || op.type === 'atom.delete') {
              const so = structOpsRequired(), ctab = ed.render.ctab, st = ed.struct();
              const warningsLocal = [];
              let target;
              if (op.type === 'molecule.delete') {
                target = resolveTargetAtoms(op.target, tables, warningsLocal);
                warnings.push(...warningsLocal.map(text => op.id + ': ' + text));
              } else {
                const uuid = tables.atoms.get(op.atomId) || op.atomId;
                const rid = a.atomIdOf(uuid);
                if (rid === null) fail('原子引用不存在：' + op.atomId, 'missing_reference');
                target = { rids: [rid], uuids: [uuid], handle: null };
              }
              const rids = new Set(target.rids);
              const fragments = new Set(target.rids.map(id => st.atoms.get(id).fragment));
              const bondRids = [];
              for (const [id, bond] of st.bonds) if (rids.has(bond.begin) || rids.has(bond.end)) bondRids.push(id);
              const cascade = mechanismCascade(target.uuids, bondRids.map(id => a.uuidOfBond(id)).filter(Boolean), []);
              const neighborRids = new Set();
              for (const [, bond] of st.bonds) {
                if (rids.has(bond.begin)) neighborRids.add(bond.end);
                if (rids.has(bond.end)) neighborRids.add(bond.begin);
              }
              const recalcRids = Array.from(neighborRids).filter(id => !rids.has(id));
              const specs = [];
              for (const bid of bondRids) specs.push({ make: () => new so.bondDelete(bid) });
              for (const aid of target.rids) specs.push({ make: () => new so.atomDelete(aid) });
              forwardOps(so, specs, ctab, settings.signal, actions, recalcRids);
              for (const fragment of fragments) if (st.frags.has(fragment)) actions.push(so.repartitionFragment(ctab, fragment));
              applyMechanismCascade(cascade);
              a.syncIdentity();
              deleted.push({ id: op.id, type: op.type, atomIds: target.uuids, molecule: target.handle, bondIds: bondRids.map(id => a.uuidOfBond(id)).filter(Boolean), entityIds: target.uuids.concat(cascade.arrows, cascade.lonePairs) });
              if (cascade.arrows.length || cascade.lonePairs.length) cascaded.push({ id: op.id, arrows: cascade.arrows.slice(), lonePairs: cascade.lonePairs.slice() });
            } else if (op.type === 'atom.modify') {
              const so = structOpsRequired(), ctab = ed.render.ctab, st = ed.struct();
              const uuid = tables.atoms.get(op.atomId) || op.atomId;
              const rid = a.atomIdOf(uuid);
              if (rid === null) fail('原子引用不存在：' + op.atomId, 'missing_reference');
              const atom = st.atoms.get(rid);
              if (!atom) fail('原子引用不存在：' + op.atomId, 'missing_reference');
              const before = { label: atom.label, charge: atom.charge || 0, isotope: atom.isotope || 0, radical: atom.radical || 0 };
              const specs = [];
              if (own(op, 'label') && op.label !== before.label) specs.push({ make: () => new so.atomAttr(rid, 'label', op.label) });
              if (own(op, 'charge') && op.charge !== before.charge) specs.push({ make: () => new so.atomAttr(rid, 'charge', op.charge) });
              if (own(op, 'isotope') && op.isotope !== before.isotope) specs.push({ make: () => new so.atomAttr(rid, 'isotope', op.isotope) });
              if (own(op, 'radical') && op.radical !== before.radical) specs.push({ make: () => new so.atomAttr(rid, 'radical', op.radical) });
              if (!specs.length) { updated.push({ id: op.id, type: op.type, atomId: uuid, unchanged: true, entityIds: [uuid] }); continue; }
              forwardOps(so, specs, ctab, settings.signal, actions, [rid]);
              if (!own(op, 'radical')) {
                sanitizeHypervalentRadicals(so, ctab, [rid], settings.signal, actions, op.id, warnings);
              }
              a.syncIdentity();
              const afterAtom = st.atoms.get(rid);
              updated.push({ id: op.id, type: op.type, atomId: uuid, before, after: { label: afterAtom.label, charge: afterAtom.charge || 0, isotope: afterAtom.isotope || 0, radical: afterAtom.radical || 0 }, entityIds: [uuid] });
            } else if (op.type === 'bond.add') {
              const so = structOpsRequired(), ctab = ed.render.ctab, st = ed.struct();
              const beginUuid = tables.atoms.get(op.begin) || op.begin, endUuid = tables.atoms.get(op.end) || op.end;
              const begin = a.atomIdOf(beginUuid), end = a.atomIdOf(endUuid);
              if (begin === null || end === null) fail('bond.add 原子引用不存在', 'missing_reference');
              for (const [, bond] of st.bonds) {
                if ((bond.begin === begin && bond.end === end) || (bond.begin === end && bond.end === begin)) fail('两个原子之间已存在键', 'bond_exists');
              }
              const order = op.order ?? 1;
              const local = order === 1 && placeLooseHydrogen(beginUuid, endUuid, controller.ctx(), id =>
                run.looseAtoms.has(id) || created.some(item => item.type === 'molecule.add' && item.atoms.some(atom => atom.id === id)));
              if (local) {
                // Only the loose H moves. Bond and coordinates share the same history entry.
                const rid = a.atomIdOf(local.id), { x, y } = local.position;
                actions.push(coordinateMoveAction([[rid, x, y]]).perform(ctab));
                movedAtoms.add(local.id);
              }
              forwardOps(so, [{ make: () => new so.bondAdd(begin, end, { type: order }) }], ctab, settings.signal, actions, [begin, end]);
              sanitizeHypervalentRadicals(so, ctab, [begin, end], settings.signal, actions, op.id, warnings);
              const beginFragment = st.atoms.get(begin).fragment, endFragment = st.atoms.get(end).fragment;
              if (beginFragment !== endFragment) {
                if (!so.mergeFragments || !st.frags.has(beginFragment) || !st.frags.has(endFragment)) {
                  fail('无法合并成键原子所在的片段', 'struct_ops_unavailable');
                }
                // Native KET serialization needs both ends of the new bond in the same fragment.
                const hydrogenFirst = st.atoms.get(begin).label === 'H' && st.atoms.get(end).label !== 'H';
                actions.push(so.mergeFragments(ctab, hydrogenFirst ? end : begin, hydrogenFirst ? begin : end));
              }
              a.syncIdentity();
              let newBondUuid = null;
              for (const [id, bond] of st.bonds) {
                if ((bond.begin === begin && bond.end === end) || (bond.begin === end && bond.end === begin)) { newBondUuid = a.uuidOfBond(id); tables.bonds.set(op.id, newBondUuid); tables.bonds.set(op.id + ':bond:1', newBondUuid); break; }
              }
              if (!newBondUuid) fail('新增键缺少稳定身份');
              created.push({ id: op.id, type: op.type, atoms: [], bonds: [{ ref: '1', id: newBondUuid, begin: beginUuid, end: endUuid }], entityIds: [newBondUuid] });
            } else if (op.type === 'bond.modify') {
              const so = structOpsRequired(), ctab = ed.render.ctab, st = ed.struct();
              const uuid = tables.bonds.get(op.bondId) || op.bondId;
              const rid = a.bondIdOf(uuid);
              if (rid === null) fail('键引用不存在：' + op.bondId, 'missing_reference');
              const bond = st.bonds.get(rid);
              if (!bond) fail('键引用不存在：' + op.bondId, 'missing_reference');
              const before = bond.type;
              if (before === op.order) { updated.push({ id: op.id, type: op.type, bondId: uuid, unchanged: true, entityIds: [uuid] }); continue; }
              forwardOps(so, [{ make: () => new so.bondAttr(rid, 'type', op.order) }], ctab, settings.signal, actions, [bond.begin, bond.end]);
              sanitizeHypervalentRadicals(so, ctab, [bond.begin, bond.end], settings.signal, actions, op.id, warnings);
              a.syncIdentity();
              updated.push({ id: op.id, type: op.type, bondId: uuid, before, after: op.order, entityIds: [uuid] });
            } else if (op.type === 'bond.delete') {
              const so = structOpsRequired(), ctab = ed.render.ctab, st = ed.struct();
              const uuid = tables.bonds.get(op.bondId) || op.bondId;
              const rid = a.bondIdOf(uuid);
              if (rid === null) fail('键引用不存在：' + op.bondId, 'missing_reference');
              const bond = st.bonds.get(rid);
              if (!bond) fail('键引用不存在：' + op.bondId, 'missing_reference');
              const cascade = mechanismCascade(new Set(), new Set([uuid]), new Set());
              const fragment = st.atoms.get(bond.begin)?.fragment;
              forwardOps(so, [{ make: () => new so.bondDelete(rid) }], ctab, settings.signal, actions, [bond.begin, bond.end]);
              if (st.frags.has(fragment)) actions.push(so.repartitionFragment(ctab, fragment));
              applyMechanismCascade(cascade);
              a.syncIdentity();
              deleted.push({ id: op.id, type: op.type, bondIds: [uuid], entityIds: [uuid].concat(cascade.arrows) });
              if (cascade.arrows.length) cascaded.push({ id: op.id, arrows: cascade.arrows.slice(), lonePairs: [] });
            } else if (op.type === 'arrow.modify') {
              const resolved = entityRef(op, 'arrowId', tables.entities, id => !!model.arrow(id));
              const arrow = model.arrow(resolved.id);
              const before = { source: copy(arrow.source), target: copy(arrow.target), electronCount: arrow.electronCount, bend: arrow.geometry.bend, mode: M.arrowMode(arrow) };
              if (own(op, 'source')) arrow.source = resolveEndpoint(op.source, tables);
              if (own(op, 'target')) arrow.target = resolveEndpoint(op.target, tables);
              if (own(op, 'electronCount')) arrow.electronCount = op.electronCount;
              let layout = null;
              const endpointsChanged = own(op, 'source') || own(op, 'target');
              const requestedMode = own(op, 'mode') ? op.mode : own(op, 'bend') ? 'manual' : M.arrowMode(arrow);
              if (requestedMode === 'auto' && (own(op, 'mode') || endpointsChanged || own(op, 'electronCount'))) {
                flushNativeGeometry();
                orientAutomaticPair(arrow.source, arrow.target, automaticPairs, controller.ctx(), model.state.lonePairs);
                const plan = controller.replanArrowInPlace(arrow, true, { preferClearArrows: true });
                if (!plan) fail('箭头无法按新端点排布');
                layout = { feasible: !!plan.feasible, note: plan.note || null, collisions: plan.collisions || null };
                if (!plan.feasible || plan.readable === false) failedExistingRoutes.set(arrow.id, { op, plan });
                if (!plan.feasible) warnings.push(op.id + ': 修改后的箭头路线拥挤（' + describeCollisions(plan) + '）');
              } else if (own(op, 'bend')) {
                arrow.geometry.bend = op.bend;
                arrow.geometry.mode = 'manual';
                arrow.geometry.routeVersion = 0;
                delete arrow.geometry.controlFrame;
              }
              arrow.geometry.mode = requestedMode;
              if (M.arrowGeometry(arrow, controller.ctx()).degenerate) fail('修改后的箭头几何无效');
              updated.push({ id: op.id, type: op.type, arrowId: resolved.id, before, after: { source: copy(arrow.source), target: copy(arrow.target), electronCount: arrow.electronCount, bend: arrow.geometry.bend, mode: M.arrowMode(arrow) }, entityIds: [resolved.id], layout });
            } else if (op.type === 'arrow.delete') {
              const resolved = entityRef(op, 'arrowId', tables.entities, id => !!model.arrow(id));
              model.removeArrow(resolved.id);
              deleted.push({ id: op.id, type: op.type, arrowIds: [resolved.id], entityIds: [resolved.id] });
            } else if (op.type === 'lonePair.modify') {
              const resolved = entityRef(op, 'lonePairId', tables.entities, id => !!model.lonePair(id));
              const lp = model.lonePair(resolved.id);
              const ownerPos = controller.ctx().atomPos(lp.ownerAtomId);
              if (!ownerPos) fail('孤对所属原子不存在：' + lp.ownerAtomId, 'missing_reference');
              const before = { angle: lp.angle, refAtomId: lp.refAtomId, angleRel: lp.angleRel };
              modifyLonePairAim(lp, op, controller.ctx(), model.state.lonePairs, model.state.arrows);
              automaticPairs.delete(lp.id);
              if (own(op, 'aim')) movedAtoms.add(lp.ownerAtomId);
              updated.push({ id: op.id, type: op.type, lonePairId: resolved.id, before,
                after: { angle: lp.angle, refAtomId: lp.refAtomId, angleRel: lp.angleRel }, entityIds: [resolved.id] });
            } else if (op.type === 'lonePair.delete') {
              const resolved = entityRef(op, 'lonePairId', tables.entities, id => !!model.lonePair(id));
              const cascade = mechanismCascade(new Set(), new Set(), new Set([resolved.id]));
              model.removeLonePair(resolved.id);
              applyMechanismCascade(cascade);
              deleted.push({ id: op.id, type: op.type, lonePairIds: [resolved.id], entityIds: [resolved.id].concat(cascade.arrows) });
              if (cascade.arrows.length) cascaded.push({ id: op.id, arrows: cascade.arrows.slice(), lonePairs: [] });
            } else if (op.type === 'text.delete') {
              const so = structOpsRequired(), ctab = ed.render.ctab;
              const resolved = entityRef(op, 'textId', tables.entities, id => ed.struct().texts.has(Number(id)) || ed.struct().texts.has(id));
              const nativeId = Number(resolved.id);
              forwardOps(so, [{ make: () => new so.textDelete(Number.isNaN(nativeId) ? resolved.id : nativeId) }], ctab, settings.signal, actions);
              deleted.push({ id: op.id, type: op.type, textIds: [String(resolved.id)], entityIds: [] });
            } else if (op.type === 'layout.tidy') {
              const data = prepared.get(op.id);
              if (!data) {
                const request = new Error('准备当前步骤的布局');
                request.tidyRequest = { op, doc: captureTidySnapshot() };
                throw request;
              }
              if (data.ok !== true) fail('整理失败：' + ((data && data.error) || '布局服务返回失败'), 'layout_failed');
              const result = applyTidyResult(data, settings.signal);
              if (result.action) actions.push(result.action);
              if (!result.unchanged) nativeGeometryChanged = true;
              // Local cleanup must not seed a reaction-graph reflow: the
              // existing stages, row breaks and native connectors stay in place.
              if (data.coordinateScale !== 'preserved') {
                const drawn = [...reactionConnectors.values(), ...pendingConnectors.values()].filter(connectorStillDrawn);
                const boxes = reactionMoleculeBoxes();
                for (const record of drawn) if (record.flow?.graph || drawn.some(next => isPreparationStepLink(record, next, boxes))) layoutSeeds.push({ op, record });
              }
              updated.push({ id: op.id, type: op.type, molecules: result.molecules, arrowsReplanned: result.replanned, unchanged: !!result.unchanged, entityIds: [] });
              if (result.crowded.length) warnings.push(op.id + ': 整理后 ' + result.crowded.length + ' 根自动箭头仍拥挤');
              for (const warning of result.warnings || []) warnings.push(op.id + ': ' + warning.message);
              if (Array.isArray(result.skipped) && result.skipped.length) warnings.push(op.id + ': 已跳过 ' + result.skipped.length + ' 个化学校验未通过的结构');
              // The final commit emits the dirty hint once. Staging must stay silent.
            }
          }
          flushNativeGeometry();
          const flowBoxes = reactionMoleculeBoxes(), flowContext = controller.ctx();
          const flowAtoms = endpoint => endpoint.type === 'bond' ? (() => {
            const bond = flowContext.bondInfo(endpoint.bondId); return bond ? [bond.beginAtom, bond.endAtom] : [];
          })() : M.endpointAtomIds(endpoint);
          for (const op of actualFresh.filter(op => op.type === 'arrow.add' || op.type === 'arrow.modify' &&
              ['source', 'target', 'electronCount'].some(key => own(op, key)))) {
            const entry = [...created, ...updated].find(entry => entry.id === op.id);
            const flow = model.arrow(entry?.entityIds?.[0]); if (!flow) continue;
            const refs = [...flowAtoms(flow.source), ...flowAtoms(flow.target)];
            for (const record of new Set([...reactionConnectors.values(), ...pendingConnectors.values()])) {
              if (!connectorStillDrawn(record) || !refs.length) continue;
              const components = new Set(record.reactants.map(id => flowBoxes.get(id)?.component));
              if (!refs.every(id => components.has(flowBoxes.get(id)?.component))) continue;
              const semantic = stepEdits.some(edit => edit.record?.stepId === record.stepId) ||
                [...stepOperations.values()].some(operation => operation.type === 'reactionStep.create' && operation.stepId === record.stepId);
              if (semantic || stepObservation(record).checks.layout.status === 'failed') layoutSeeds.push({ op, record });
            }
          }
          if (stepEdits.length || layoutSeeds.length) {
            activeOperation = stepEdits.at(-1)?.op || layoutSeeds.at(-1).op;
            flushNativeGeometry();
            const reflowed = reflowSemanticSteps([...stepEdits, ...layoutSeeds], pendingConnectors, actions, movedAtoms, settings.signal);
            if (reflowed.graphBounds) {
              run.graphBounds = copy(reflowed.graphBounds);
              drawingLayout.follow.push(reflowed.graphBounds);
            }
            nativeGeometryChanged = true; routeRevision++;
          }
          activeOperation = null;
          if (typeof settings.validateMechanism === 'function') {
            const validation = settings.validateMechanism(snapshotContext(pendingConnectors),
              { operations: actualFresh, created: copy(created), updated: copy(updated) });
            if (validation && typeof validation.then === 'function') fail('机理校验必须同步完成');
          }
          const moveOperation = actualFresh.findLast(op => op.type === 'molecule.move');
          activeOperation = moveOperation;
          reflowMovedConnectors(movedAtoms, pendingConnectors, actions);
          if (newRoutes.size || movedAtoms.size) {
            flushNativeGeometry();
            const ctx = controller.ctx();
            const touchesMoved = ep => {
              if (ep.type !== 'bond') return M.endpointAtomIds(ep).some(id => movedAtoms.has(id));
              const bond = ctx.bondInfo(ep.bondId);
              return bond && (movedAtoms.has(bond.beginAtom) || movedAtoms.has(bond.endAtom));
            };
            const plans = new Map();
            for (const arrow of model.state.arrows) {
              if (M.arrowMode(arrow) !== 'auto') continue;
              const added = newRoutes.get(arrow.id);
              if (added) activeOperation = added.op;
              const replan = (added && added.revision !== routeRevision) ||
                (movedAtoms.size && (touchesMoved(arrow.source) || touchesMoved(arrow.target)));
              const plan = (replan && controller.replanArrowInPlace(arrow, false, { preferClearArrows: true })) || added?.plan;
              if (plan) plans.set(arrow.id, plan);
            }
            const preserveValid = !actualFresh.some(op => ['arrow.add', 'arrow.modify', 'lonePair.add', 'lonePair.modify'].includes(op.type));
            for (const [id, plan] of controller.replanConcertedArrows(plans.keys(), { ctx, preferClearArrows: true, preserveValid })) plans.set(id, plan);
            for (const [id, plan] of plans) {
              const added = newRoutes.get(id);
              if (added) added.entry.layout = { feasible: !!plan.feasible, note: plan.note || null, collisions: plan.collisions || null };
              if (!plan.feasible || plan.readable === false) {
                if (oldMech.arrows.some(arrow => arrow.id === id)) failedExistingRoutes.set(id,
                  { op: added?.op || moveOperation || stepEdits.at(-1)?.op || actualFresh.at(-1), plan });
                warnings.push((added?.op.id || moveOperation?.id || '') +
                  ': 自动箭头没有可行且可读的候选（' + describeCollisions(plan) + '），未覆盖原有曲线');
              }
              else if (plan.ranked?.[0]?.arrowHits) warnings.push((added?.op.id || moveOperation?.id || '') +
                ': 局部弯箭头仍有交叉，可调整相关试剂的位置');
            }
          }
          const automaticLayout = stepEdits.length || layoutSeeds.length ||
            actualFresh.some(op => op.type === 'arrow.modify' && op.mode !== 'manual' && !own(op, 'bend'));
          for (const [id, failed] of automaticLayout ? failedExistingRoutes : []) {
            const arrow = model.arrow(id); if (!arrow || M.arrowMode(arrow) !== 'auto') continue;
            const current = controller.planFor(arrow.source, arrow.target, arrow.electronCount,
              { exceptId: id, preferClearArrows: true, onlyBend: arrow.geometry.bend })?.plan;
            if (current?.feasible && current.readable && !current.ranked[0]?.arrowHits) continue;
            activeOperation = failed.op;
            const plan = current || failed.plan, error = new Error('已有自动箭头没有可行且可读的路线；未覆盖原有曲线，本批次已完整撤销。');
            error.code = 'electron_route_infeasible';
            error.layoutFailures = [{ arrowId: id, code: error.code, reasons: plan.readability?.reasons || [],
              atomIds: plan.collisions?.labels || [], bondIds: plan.collisions?.bonds || [] }];
            throw error;
          }
          activeOperation = null;
          const errors = []; M.validateMechanism(model.state, errors);
          if (errors.length) fail(errors[0]);
          // Width-based wrapping does not constrain page height. Reject a
          // complete automatic batch before entering history if its chemistry
          // would leave the active page; retain the user's previous work.
          const printable = paperBounds();
          const automaticPaperLayout = printable && ordered.some(op => isStepDeclaration(op) ||
            op.type === 'layout.tidy' || op.type === 'reactionStep.modify' ||
            ['text.add', 'arrow.add', 'arrow.modify'].includes(op.type) ||
            (op.type === 'molecule.add' && !own(op, 'x') && !own(op, 'y')));
          if (automaticPaperLayout) {
            const affected = new Set([...movedAtoms, ...created.filter(item => item.type === 'molecule.add')
              .flatMap(item => (item.atoms || []).map(atom => atom.id))]);
            const moleculeBoxes = reactionMoleculeBoxes();
            const bounds = [...new Set([...affected].map(id => moleculeBoxes.get(id)).filter(Boolean))];
            const changedFlows = new Set([...created, ...updated].flatMap(item => item.entityIds || []));
            const endpointAtoms = ep => ep.type === 'bond' ? (() => { const b = controller.ctx().bondInfo(ep.bondId); return b ? [b.beginAtom, b.endAtom] : []; })() : M.endpointAtomIds(ep);
            for (const arrow of model.state.arrows) if (changedFlows.has(arrow.id) ||
                [...endpointAtoms(arrow.source), ...endpointAtoms(arrow.target)].some(id => affected.has(id))) {
              const geometry = M.arrowGeometry(arrow, controller.ctx());
              if (!geometry?.start || !geometry.control || !geometry.end) continue;
              const points = [geometry.start, geometry.end];
              for (const axis of ['x', 'y']) {
                const { start, control, end } = geometry, denominator = start[axis] - 2 * control[axis] + end[axis];
                const t = denominator ? (start[axis] - control[axis]) / denominator : -1;
                if (t > 0 && t < 1) points.push(M.quadPoint(start, control, end, t));
              }
              bounds.push({ x1: Math.min(...points.map(p => p.x)) - 0.08, y1: Math.min(...points.map(p => p.y)) - 0.08,
                x2: Math.max(...points.map(p => p.x)) + 0.08, y2: Math.max(...points.map(p => p.y)) + 0.08 });
            }
            const textItems = created.filter(item => item.type === 'text.add');
            if (textItems.length) ed.render.update();
            for (const item of textItems) {
              const text = ed.struct().texts.get(item.nativeTextId), paths = ed.render.ctab.texts?.get(item.nativeTextId)?.visel?.paths || [];
              const measured = [];
              for (const path of paths) {
                const rect = path.node?.getBoundingClientRect?.();
                if (!rect || !rect.width || !rect.height) continue;
                const lo = a.clientToModel({ x: rect.left, y: rect.top }), hi = a.clientToModel({ x: rect.right, y: rect.bottom });
                if (lo && hi) measured.push({ x1: Math.min(lo.x, hi.x), x2: Math.max(lo.x, hi.x), y1: Math.min(lo.y, hi.y), y2: Math.max(lo.y, hi.y) });
              }
              if (measured.length) bounds.push(...measured);
              else if (text?.position) {
                const lines = item.text.split('\n'), p = text.position;
                bounds.push({ x1: p.x, x2: p.x + Math.max(...lines.map(conditionWidth)), y1: p.y, y2: p.y + Math.max(0.8, lines.length * 0.55) });
              }
            }
            const pending = [...new Map([...reactionConnectors, ...pendingConnectors]).values()];
            for (const record of pending) if ([...record.reactants, ...record.products].some(id => affected.has(id))) {
              for (const p of ed.struct().rxnArrows.get(record.id)?.pos || []) bounds.push({ x1: p.x, x2: p.x, y1: p.y - 0.2, y2: p.y + 0.2 });
              for (const label of record.labels || []) {
                const p = ed.struct().texts.get(label.id)?.position;
                if (p) bounds.push({ x1: p.x, x2: p.x + conditionWidth(label.text), y1: p.y - 0.5, y2: p.y + 0.5 });
              }
            }
            const outside = bounds.find(box => box.x1 < printable.x1 - 1e-4 || box.y1 < printable.y1 - 1e-4 ||
              box.x2 > printable.x2 + 1e-4 || box.y2 > printable.y2 + 1e-4);
            if (outside) fail('当前纸页的可用区域不足；请新增一页或腾出空间后重试。本批次已撤销，已有内容保持不变。', 'paper_region_full');
          }
          const limits = MW.storage.LIMITS;
          if (ed.struct().atoms.size > limits.atoms || ed.struct().bonds.size > limits.bonds || model.state.arrows.length > limits.arrows || model.state.lonePairs.length > limits.lonePairs) fail('工作台内容超过可保存的格式上限');
          if (created.length || updated.some(item => item.type !== 'layout.tidy' || !item.unchanged) || deleted.length || actions.length) {
            for (const [key, record] of pendingConnectors) reactionConnectors.set(key, record);
            // Semantic metadata shares the native geometry's history item.
            // Restore it after native Undo and rebind after both Undo and Redo.
            actions.unshift(stepStateAction(oldStepRuntime));
            const afterMech = model.cloneState(), newSelection = new Set(created.filter(item => item.type === 'arrow.add' || item.type === 'lonePair.add').flatMap(item => item.entityIds));
            const restoreConnectors = rebindConnectors;
            const action = controller.wrapNativeHistory(inverseGroup(actions, restoreConnectors, poolOrder), oldMech, afterMech, oldSelection, newSelection);
            ed.update(action);
            controller.selection = newSelection; controller.refreshAutoSlots(); controller.emitSelection(); controller.render();
            controller.onDirtyHint('AI 绘图');
          }
          for (const [key, record] of pendingConnectors) reactionConnectors.set(key, record);
          for (const item of created) if (item.type === 'molecule.add') {
            for (const atom of item.atoms) run.looseAtoms.add(atom.id);
          }
          run.atoms = tables.atoms; run.bonds = tables.bonds; run.entities = tables.entities; run.steps = tables.steps;
          run.automaticPairs = automaticPairs;
          for (const edit of stepEdits) {
            const { op, before, record, version } = edit;
            const current = record && findStep(record.stepId), after = current ? stepObservation(current) : null, action = op.type.slice('reactionStep.'.length);
            const stepId = record?.stepId || before.stepId;
            const entry = { operationId: op.id, stepId, version: after?.version || version, action, before, after,
              layout: after?.layoutStatus || { status: 'passed', continuation: null },
              checks: after?.checks || { layout: { status: 'passed', issues: [] }, chemistry: { status: 'pending', issues: [] } } };
            stepReceipts.push(entry);
            const item = [...created, ...updated, ...deleted].find(item => item.id === op.id);
            if (item && after) { item.after = after; if (item.type === 'reactionStep.create') {
              const arrow = ed.struct().rxnArrows.get(record.id); item.start = { ...arrow.pos[0] }; item.end = { ...arrow.pos[1] };
            } }
            const signature = canonical(op);
            if (signature.length > 8192) fail('步骤操作过长，无法保存幂等记录', 'invalid_operation');
            const resolvedSignature = resolvedStepSignature(op, tables, stepId);
            stepOperations.set(op.id, { id: op.id, type: op.type, signature, ...(resolvedSignature && { resolvedSignature }), stepId, version, action });
          }
          for (const op of actualFresh.filter(op => op.type === 'molecule.move' || op.type === 'layout.tidy' || op.type === 'hydrogen.makeExplicit')) {
            const moved = new Set(updated.find(entry => entry.id === op.id)?.atomIds || []), boxes = reactionMoleculeBoxes();
            const components = new Set([...moved].map(id => boxes.get(id)?.component));
            for (const record of reactionConnectors.values()) {
              if (!connectorStillDrawn(record) || stepReceipts.some(entry => entry.stepId === record.stepId) ||
                  (op.type !== 'layout.tidy' && ![...record.reactants, ...record.products].some(id => components.has(boxes.get(id)?.component)))) continue;
              const after = stepObservation(record);
              stepReceipts.push({ operationId: op.id, stepId: record.stepId, version: record.version, action: 'observe',
                before: null, after, layout: after.layoutStatus, checks: after.checks });
            }
          }
          for (const { op, record } of layoutSeeds) {
            if (!connectorStillDrawn(record) || stepReceipts.some(entry => entry.stepId === record.stepId)) continue;
            const after = stepObservation(record);
            stepReceipts.push({ operationId: op.id, stepId: record.stepId, version: record.version, action: 'observe',
              before: null, after, layout: after.layoutStatus, checks: after.checks });
          }
          while (stepOperations.size > 2048) stepOperations.delete(stepOperations.keys().next().value);
          for (const op of actualFresh) {
            const receipt = {
              created: created.filter(item => item.id === op.id),
              updated: updated.filter(item => item.id === op.id),
              deleted: deleted.filter(item => item.id === op.id),
              cascaded: cascaded.filter(item => item.id === op.id),
              warnings: warnings.filter(text => text === op.id || text.startsWith(op.id + '：') || text.startsWith(op.id + ':')),
              steps: stepReceipts.filter(item => item.operationId === op.id)
            };
            run.applied.set(op.id, { hash: canonical(op), created: copy(receipt.created.find(item => item.type === 'molecule.add' || item.type === 'bond.add') || null), receipt });
            run.placements.delete(op.id);
          }
        } catch (error) {
          if (Array.isArray(error.layoutFailures)) {
            error.layoutFailures = error.layoutFailures.map(failure => {
              const entry = [...created, ...updated].find(item => item.entityIds?.includes(failure.arrowId));
              return { ...failure, ...(entry && { operationId: entry.id }) };
            });
            error.relatedOperationIds = [...new Set(error.layoutFailures.map(failure => failure.operationId).filter(Boolean))];
          }
          run.stageOrigins = oldStageOrigins; run.placements = oldPlacements; run.anchor = oldAnchor;
          run.graphBounds = oldGraphBounds;
          for (let i = actions.length - 1; i >= 0; i--) actions[i].perform(ed.render.ctab);
          restoreStepRuntime(oldStepRuntime);
          // Native inverses reinsert deleted IDs at the end of their maps. Keep
          // the original KET order and molecule handles after a failed batch.
          restorePoolOrder(ed.struct(), poolOrder);
          model.setState(oldMech, 'silent'); controller.selection = oldSelection;
          for (const key of mapNames) a[key] = identities[key];
          a.activeAtoms = activeAtoms; a.activeBonds = activeBonds;
          ed.historyStack = oldHistoryStack; ed.historyPtr = oldHistoryPtr;
          // An unrendered native insertion followed immediately by its inverse
          // can leave deleted IDs in ReStruct's dirty maps. Do not let a later
          // user render call updateHalfBonds() on an atom that no longer exists.
          for (const [pool, dirty] of [['atoms', 'atomsChanged'], ['bonds', 'bondsChanged']]) {
            const marks = ed.render.ctab[dirty];
            if (marks && typeof marks.keys === 'function') for (const id of Array.from(marks.keys())) if (!ed.struct()[pool].has(id)) marks.delete(id);
          }
          a.syncIdentity(); ed.update(true); controller.refreshAutoSlots(); controller.emitSelection(); controller.render();
          throw operationError(error, error?.phase === 'validate' ? 'validate' : 'apply', activeOperation);
        } finally { writeDepth--; }
        checkpointCommittedOperations(run, actualFresh);
        scan('agent', 'operations'); run.revision = revision;
        clearPreview(run.id);
        try { revealNewStage(drawingLayout); highlight(created); } catch (_) { /* Presentation cannot invalidate committed edits. */ }
        const replayed = ops.filter(op => isStepOperation(op) && !actualFresh.some(fresh => fresh.id === op.id)).map(op => stepReplay(op, run)).filter(Boolean);
        const operationOrder = new Map(ops.map((op, index) => [op.id, index]));
        const steps = stepReceipts.concat(replayed).sort((first, second) => operationOrder.get(first.operationId) - operationOrder.get(second.operationId));
        const committed = { created, updated, deleted, cascaded, warnings, steps, ...(replayed.length && { replayed: true }) };
        const changedUpdates = updated.filter(item => item.type !== 'layout.tidy' || !item.unchanged).length;
        const count = created.length + changedUpdates + deleted.length;
        return response(run, committed, count ? '已在画布完成 ' + count + ' 个操作（新增 ' + created.length + '、修改 ' + changedUpdates + '、删除 ' + deleted.length + '）；这一步可以撤销。' :
          updated.some(item => item.type === 'layout.tidy') ? (warnings.length ? '结构已检查并保留原有位置与画法；部分结构仍需进一步调整，详见提示。' : '结构已检查，保留原有位置与画法；无需修改。') : '对应反应步骤已有直箭头。');
      };
      const prepareAndExecute = async () => {
        for (;;) {
          try { return execute(); }
          catch (error) {
            if (!error.tidyRequest) throw error;
            const { op, doc } = error.tidyRequest;
            try { prepared.set(op.id, await tidySnapshot(settings.signal, doc)); }
            catch (failure) { throw operationError(failure, 'prepare', op); }
          }
        }
      };
      const result = tail.then(prepareAndExecute); tail = result.catch(() => {}); return result;
    }
    function replayReceipts(ops, run) {
      const created = [], updated = [], deleted = [], cascaded = [], warnings = [], steps = [];
      for (const op of ops) {
        if (isStepOperation(op)) {
          const step = stepReplay(op, run);
          if (step) { steps.push(step); continue; }
        }
        const record = run.applied.get(op.id);
        if (!record || !record.receipt) continue;
        created.push(...copy(record.receipt.created || []));
        updated.push(...copy(record.receipt.updated || []));
        deleted.push(...copy(record.receipt.deleted || []));
        cascaded.push(...copy(record.receipt.cascaded || []));
        warnings.push(...copy(record.receipt.warnings || []));
      }
      return { created, updated, deleted, cascaded, warnings, steps, replayed: true };
    }
    function describeCollisions(plan) {
      const parts = [];
      if (plan.collisions) {
        if (plan.collisions.labels && plan.collisions.labels.length) parts.push('压到标签 ' + plan.collisions.labels.join(', '));
        if (plan.collisions.bonds && plan.collisions.bonds.length) parts.push('穿过键 ' + plan.collisions.bonds.join(', '));
      }
      return parts.join('；') || '无可用无遮挡路线';
    }
    /* 整理：把 /api/layout 的局部修正坐标落回画布，并重排受影响的
       auto 箭头；manual 箭头保留 bend。坐标与箭头几何合成同一历史动作。
       KET 与画布的对照沿用 adapter 的双射校验映射（多解/重合一律失败，不猜）。 */
    function applyTidyResult(data, signal) {
      const so = structOpsRequired();
      void so;
      const st = ed.struct(), ctab = ed.render.ctab;
      const doc = data.doc;
      const bindings = a.mapRuntimeToKet(doc);
      if (bindings.error) fail('整理无法建立原子对照：' + bindings.error, 'layout_failed');
      const ridByMolIndex = new Map();
      for (const binding of bindings.atoms) ridByMolIndex.set(binding.mol + '#' + binding.index, a.atomIdOf(binding.id));
      const moleculeKeys = [];
      const newCoords = [];
      const affectedBondKeys = new Set();
      for (const molecule of data.molecules) {
        moleculeKeys.push(molecule.key);
        const ids = (molecule.atoms || []).map((atom, index) => ridByMolIndex.get(molecule.key + '#' + index));
        if (ids.some(id => id === null || id === undefined)) fail('整理结果与画布原子无法对照', 'layout_failed');
        for (let i = 0; i < ids.length; i++) newCoords.push([ids[i], molecule.atoms[i][0], -molecule.atoms[i][1]]);
        for (const bond of molecule.bonds || []) {
          const i1 = ids[bond.i], i2 = ids[bond.j];
          if (i1 === undefined || i2 === undefined) continue;
          affectedBondKeys.add(Math.min(i1, i2) + ':' + Math.max(i1, i2));
        }
      }
      const affectedRids = Array.from(new Set(newCoords.map(entry => entry[0])));
      const affectedBids = [];
      for (const [id, bond] of st.bonds) {
        if (affectedBondKeys.has(Math.min(bond.begin, bond.end) + ':' + Math.max(bond.begin, bond.end))) affectedBids.push(id);
      }
      // 撤销快照：旧坐标 + 旧键方向/立体
      const beforeCoords = captureAtomCoords(st, affectedRids);
      const beforeBonds = captureBondState(st, affectedBids);
      const undo = tidyAction(beforeCoords, beforeBonds);
      try {
        // 应用新坐标（KET y 轴向上，画布 y 轴向下）
        const layoutCoords = data.coordinateScale === 'preserved' ? newCoords : (a.scaleLayoutCoordinates?.(newCoords) || newCoords);
        const movedUuids = new Set(layoutCoords.filter(([rid, x, y]) => {
          const p = st.atoms.get(rid)?.pp;
          return p && Math.hypot(p.x - x, p.y - y) > 1e-8;
        }).map(([rid]) => a.atomUuid.get(rid)).filter(Boolean));
        if (data.coordinateScale === 'preserved' && !movedUuids.size) {
          return { action: null, unchanged: true, molecules: moleculeKeys, replanned: [], crowded: [], warnings: data.warnings || [], skipped: data.skipped || [] };
        }
        applyAtomCoords(st, layoutCoords);
        // 楔键方向翻转规则与 canvas.html applyLayout 一致：KET 的 atoms[0] 是窄端。
        for (const molecule of data.molecules) {
          const ids = (molecule.atoms || []).map((atom, index) => ridByMolIndex.get(molecule.key + '#' + index));
          for (const bond of molecule.bonds || []) {
            const i1 = ids[bond.i], i2 = ids[bond.j];
            if (i1 === undefined || i2 === undefined) continue;
            const bid = (() => {
              for (const [id, native] of st.bonds) {
                if (Math.min(native.begin, native.end) === Math.min(i1, i2) && Math.max(native.begin, native.end) === Math.max(i1, i2)) return id;
              }
              return null;
            })();
            const native = bid === null ? null : st.bonds.get(bid);
            if (!native) continue;
            if (native.begin !== i1) {
              const tb = native.begin, th = native.hb1;
              native.begin = native.end; native.end = tb;
              native.hb1 = native.hb2; native.hb2 = th;
            }
            native.stereo = bond.stereo || 0;
          }
        }
        markMovedAtoms(ctab, affectedRids);
        for (const bid of affectedBids) if (typeof ctab.markBond === 'function') ctab.markBond(bid, 1);
        ed.render.update();
        // 重排受影响的 auto 箭头（manual 保留 bend），拥挤如实记录
        const replanned = [], crowded = [];
        a.syncIdentity();
        const planMap = new Map();
        const ctx = controller.ctx();
        const touchesMoved = endpoint => {
          if (endpoint.type !== 'bond') return M.endpointAtomIds(endpoint).some(id => movedUuids.has(id));
          const bond = ctx.bondInfo(endpoint.bondId);
          return bond && (movedUuids.has(bond.beginAtom) || movedUuids.has(bond.endAtom));
        };
        for (const arrow of model.state.arrows) {
          if (M.arrowMode(arrow) !== 'auto' || (!touchesMoved(arrow.source) && !touchesMoved(arrow.target))) continue;
          const plan = controller.replanArrowInPlace(arrow, true);
          if (plan) { replanned.push(arrow.id); planMap.set(arrow.id, plan); }
        }
        if (replanned.length && typeof controller.replanConcertedArrows === 'function') {
          const concerted = controller.replanConcertedArrows(replanned);
          if (concerted) {
            const entries = concerted instanceof Map ? concerted.entries() : Array.isArray(concerted) ? concerted : Object.entries(concerted);
            for (const [id, plan] of entries) {
              if (plan) planMap.set(id, plan);
            }
          }
        }
        for (const id of replanned) {
          const plan = planMap.get(id);
          if (plan && !plan.feasible) crowded.push(id);
        }
        abort(signal);
        return { action: undo, molecules: moleculeKeys, replanned, crowded, warnings: data.warnings || [], ...(Array.isArray(data.skipped) && data.skipped.length ? { skipped: data.skipped } : {}) };
      } catch (error) {
        // The outer transaction can only undo actions which have returned.
        undo.perform(ctab);
        throw error;
      }
    }
    function uiGroup(kind, runId) {
      const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('data-mech-ui', '1'); group.setAttribute('data-agent-' + kind, runId || ''); group.setAttribute('pointer-events', 'none');
      app.layer.ensure().appendChild(group); return group;
    }
    function element(group, name, attributes, text) {
      const node = doc.createElementNS('http://www.w3.org/2000/svg', name);
      for (const key of Object.keys(attributes)) node.setAttribute(key, String(attributes[key]));
      if (text !== undefined) node.textContent = text;
      group.appendChild(node); return node;
    }
    function highlight(created) {
      const group = uiGroup('entrance', currentRun), scale = 1 / a.bondLength();
      for (const item of created) for (const id of item.entityIds) {
        const rid = a.atomIdOf(id), position = rid === null ? null : a.atomPos(rid);
        if (position) element(group, 'circle', { cx: position.x, cy: position.y, r: 12 * scale, stroke: '#0a7ea4', 'stroke-width': 1.6 * scale, fill: 'none' });
        const arrow = model.arrow(id);
        if (arrow) {
          const geometry = M.arrowGeometry(arrow, controller.ctx());
          element(group, 'path', { d: 'M ' + geometry.start.x + ' ' + geometry.start.y + ' Q ' + geometry.control.x + ' ' + geometry.control.y + ' ' + geometry.end.x + ' ' + geometry.end.y, fill: 'none', stroke: '#0a7ea4', 'stroke-width': 2.8 * scale });
        }
      }
      if (!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches && group.animate) group.animate([{ opacity: 0.65 }, { opacity: 0 }], { duration: 240, fill: 'forwards' });
      root.setTimeout(() => group.remove(), 260);
    }
    async function previewOperations(input, settings = {}) {
      const ops = validateOperations(input), run = getRun(settings.runId, true);
      scan(); checkRun(run);
      const pending = ops.filter(op => {
        const previous = run.applied.get(op.id);
        if (previous && previous.hash !== canonical(op)) fail('已完成操作的内容不能在预览中更改');
        const frame = run.previewFrames.get(op.id);
        if (frame && frame.hash !== canonical(op)) fail('已预览操作的参数发生了变化：' + op.id, 'operation_conflict');
        return !previous;
      });
      if (!pending.length) { clearPreview(run.id); return { previewed: 0, revision, sessionId }; }
      // Keep the last complete prefix visible while the next complete object is
      // being prepared. Only swap layers after its replacement is fully built.
      run.previewAbort?.abort(); run.previewVersion++;
      const version = run.previewVersion, cancellation = new AbortController(); run.previewAbort = cancellation;
      const prepared = await prepare(pending, cancellation.signal);
      if (pending.length === 1 && pending[0].type === 'layout.tidy') prepared.set(pending[0].id, await tidySnapshot(cancellation.signal));
      checkRun(run, cancellation.signal);
      if (version !== run.previewVersion) return { previewed: 0, superseded: true };
      const tables = tablesFor(run), positions = new Map(), bondInfo = new Map(), lps = new Map(), arrows = [], moleculeViews = [], textViews = [], lpViews = [], arrowViews = [], reactionViews = [];
      const automaticPairs = new Set(run.automaticPairs), draftAtoms = [], explicitViews = [], explicitCounts = new Map();
      for (const id of automaticPairs) {
        const lp = model.lonePair(id);
        if (lp) lps.set(id, M.clone(lp));
      }
      const base = controller.ctx();
      const ctx = Object.assign({}, base, {
        atomPos: id => positions.get(id) || base.atomPos(id),
        atomLabel: id => positions.get(id)?.label || base.atomLabel(id),
        bondInfo: id => bondInfo.get(id) || base.bondInfo(id),
        atoms: () => base.atoms().concat(draftAtoms),
        bonds: () => base.bonds().concat([...bondInfo.values()]),
        lonePair: id => lps.get(id) || model.lonePair(id),
        atomLabelBox: (id, options) => positions.has(id) ? { hasLabel: true, hwCss: 7, hhCss: 8 } : base.atomLabelBox(id, options)
      });
      const resolveAtom = value => { const id = tables.atoms.get(value) || value; if (!ctx.atomPos(id)) fail('预览依赖的原子尚未出现：' + value, 'missing_reference'); return id; };
      const resolveBond = value => { const id = tables.bonds.get(value) || value; if (!ctx.bondInfo(id)) fail('预览依赖的键尚未出现：' + value, 'missing_reference'); return id; };
      const previewContext = { resolveAtom, resolveBond, bonds: ctx.bonds, lonePair: ctx.lonePair };
      const viewBounds = layoutViewport(), previewOccupied = occupiedBoxes();
      const ordered = dependencyOrder(pending);
      const drawingLayout = planAdditions(ordered, prepared, viewBounds, previewOccupied, run);
      for (const op of ordered.filter(op => op.type === 'molecule.add')) {
        if (drawingLayout.waiting.has(op.id) && !drawingLayout.positions.has(op.id)) continue;
        const data = prepared.get(op.id), fragment = drawingLayout.fragments.get(op.id);
        const pos = placement(op, run, viewBounds, fragment, previewOccupied, drawingLayout), atoms = Array.from(fragment.atoms.values());
        const xs = atoms.map(atom => atom.pp.x), ys = atoms.map(atom => atom.pp.y), dx = pos.x - (Math.min(...xs) + Math.max(...xs)) / 2, dy = pos.y - (Math.min(...ys) + Math.max(...ys)) / 2;
        const view = { op, atoms: [], bonds: [] };
        for (const record of data.atoms) {
          const atom = fragment.atoms.get(record.index), id = 'preview-' + op.id + '-' + record.ref;
          const position = { x: atom.pp.x + dx, y: atom.pp.y + dy, label: atom.label, charge: atom.charge || 0 };
          positions.set(id, position); tables.atoms.set(op.id + ':' + record.ref, id);
          draftAtoms.push({ uuid: id, label: atom.label, pos: position, charge: atom.charge || 0, radical: atom.radical || 0,
            isotope: atom.isotope || 0, implicitH: atom.implicitH || 0, implicitHCount: atom.implicitHCount,
            stereoLabel: atom.stereoLabel, stereoParity: atom.stereoParity, hasQuery: atom.isQuery?.() || false,
            aromatic: Array.from(fragment.bonds.values()).some(bond => bond.type === 4 && (bond.begin === record.index || bond.end === record.index)) });
          view.atoms.push(position);
        }
        for (const record of data.bonds) {
          const bond = fragment.bonds.get(record.index), beginRecord = data.atoms.find(atom => atom.index === bond.begin), endRecord = data.atoms.find(atom => atom.index === bond.end);
          if (!beginRecord || !endRecord) fail('预览键的身份不明确');
          const beginId = tables.atoms.get(op.id + ':' + beginRecord.ref), endId = tables.atoms.get(op.id + ':' + endRecord.ref), id = 'preview-' + op.id + '-bond-' + record.ref;
          const info = { uuid: id, begin: positions.get(beginId), end: positions.get(endId), type: bond.type || 1,
            beginAtom: beginId, endAtom: endId, beginId, endId };
          bondInfo.set(id, info); tables.bonds.set(op.id + ':' + record.ref, id); tables.bonds.set(op.id + ':bond:' + record.ref, id); view.bonds.push(info);
        }
        moleculeViews.push(view);
      }
      for (const op of ordered.filter(op => op.type === 'hydrogen.makeExplicit')) {
        const parentId = resolveAtom(op.parentAtomId), environment = hydrogenEnvironment(ctx);
        for (const atom of environment.atoms) if (explicitCounts.has(atom.id)) atom.implicitH = atom.implicitHCount = explicitCounts.get(atom.id);
        const plan = makeExplicitHydrogenPlan({ parentAtomId: parentId, ...environment });
        const id = 'preview-' + op.id + '-1', bondId = 'preview-' + op.id + '-bond-1', point = explicitHydrogenPosition(parentId, id, ctx);
        positions.set(id, { ...point, label: 'H', charge: 0 }); tables.atoms.set(op.id + ':1', id);
        tables.bonds.set(op.id + ':1', bondId); tables.bonds.set(op.id + ':bond:1', bondId);
        draftAtoms.push({ uuid: id, label: 'H', pos: point, charge: 0, radical: 0, implicitH: 0, implicitHCount: 0 });
        bondInfo.set(bondId, { uuid: bondId, begin: ctx.atomPos(parentId), end: point, beginAtom: parentId, endAtom: id, type: 1, stereo: 0 });
        explicitCounts.set(parentId, plan.implicitAfter); explicitViews.push({ op, parent: ctx.atomPos(parentId), point });
      }
      for (const op of pending.filter(op => op.type === 'lonePair.add')) {
        let owner;
        try { owner = resolveAtom(op.atom); }
        catch (error) { if (drawingLayout.waiting.size && error.code === 'missing_reference') continue; throw error; }
        const lp = M.makeLonePair(owner, { origin: 'manual', angle: own(op, 'angle') ? op.angle : 0 });
        lps.set(lp.id, lp); tables.entities.set(op.id, lp.id);
        if (!own(op, 'angle')) automaticPairs.add(lp.id);
        lpViews.push({ op, lp });
      }
      const previewModel = { state: { lonePairs: model.state.lonePairs.filter(lp => !lps.has(lp.id)).concat([...lps.values()]),
        arrows: model.state.arrows.map(ar => ({ ...ar, geometry: { ...ar.geometry } })) } };
      for (const op of pending.filter(op => op.type === 'arrow.add')) {
        let source, target;
        try { source = resolveEndpoint(op.source, tables, previewContext); target = resolveEndpoint(op.target, tables, previewContext); }
        catch (error) { if (drawingLayout.waiting.size && error.code === 'missing_reference') continue; throw error; }
        const arrow = M.makeArrow(source, target, { electronCount: op.electronCount, bend: 0.25 });
        orientAutomaticPair(source, target, automaticPairs, ctx, previewModel.state.lonePairs);
        const scene = MW.route.buildScene(ctx, previewModel);
        MW.route.addArrowObstacles(scene, previewModel, ctx);
        const plan = controller.planFor(source, target, op.electronCount, { ctx, scene, preferClearArrows: true });
        if (plan) arrow.geometry.bend = plan.plan.bend;
        const geometry = M.arrowGeometry(arrow, ctx);
        if (!geometry.sourceOk || !geometry.targetOk || geometry.degenerate) fail('预览箭头端点无效：' + op.id);
        arrows.push(arrow); arrowViews.push({ op, arrow }); previewModel.state.arrows.push(arrow);
      }
      if (arrows.length) controller.replanConcertedArrows(arrows.map(ar => ar.id), { ctx, model: previewModel, preferClearArrows: true });
      const connectors = pending.filter(isStepDeclaration);
      if (connectors.length) {
        const boxes = reactionMoleculeBoxes(positions, bondInfo);
        const shown = new Set();
        for (const op of connectors) {
          try {
            const sides = reactionSides(op, boxes, resolveAtom);
            if (shown.has(sides.key) || knownConnector(sides.key)) continue;
            const flow = drawingLayout.stageFlow.get(op.id), line = connectorLine(sides, boxes, flow);
            const vertical = line.end.y - line.start.y > Math.abs(line.end.x - line.start.x);
            reactionViews.push({ op, ...line, labels: connectorLabels(reactionLabel(op, vertical), line, sides, boxes, flow) });
            shown.add(sides.key);
          }
          catch (error) {
            if (!['missing_reference', 'reaction_arrow_gap', 'invalid_operation'].includes(error.code)) throw error;
          }
        }
      }
      for (const op of ordered.filter(op => op.type === 'text.add')) textViews.push({ op, text: op.text,
        ...textAnchor(op, placement(op, run, viewBounds, null, previewOccupied, drawingLayout)) });
      /* 修改/删除/整理的 ghost/diff 预览：独立覆盖层，绝不提前改正式源（规范 7）。
         目标可以指向已有对象，也可以指向本流中刚预览过的对象（伪 id）。 */
      const ghostViews = [], draftedBondAtoms = new Set();
      for (const view of explicitViews) {
        ghostViews.push({ op: view.op, kind: 'bond', begin: view.parent, end: view.point, count: 1 });
        ghostViews.push({ op: view.op, kind: 'label', x: view.point.x, y: view.point.y, text: 'H', charge: 0 });
      }
      const previewPos = value => {
        const id = tables.atoms.get(value) || value;
        const p = positions.get(id) || ctx.atomPos(id);
        if (!p) fail('预览引用的原子尚未出现：' + value, 'missing_reference');
        return { id, p };
      };
      const previewBond = value => {
        const id = tables.bonds.get(value) || value.replace(/^(.*):bond:(.*)$/, '$1:$2');
        const info = bondInfo.get(id) || bondInfo.get(value) || ctx.bondInfo(id);
        if (!info) fail('预览引用的键尚未出现：' + value, 'missing_reference');
        return info;
      };
      const previewLp = raw => lps.get(raw) || model.lonePair(raw);
      const previewArrow = raw => model.arrow(raw) || arrows.find(item => item.id === raw) || null;
      const boxOfPoints = pts => pts.length ? { x1: Math.min(...pts.map(p => p.x)) - 0.35, y1: Math.min(...pts.map(p => p.y)) - 0.35, x2: Math.max(...pts.map(p => p.x)) + 0.35, y2: Math.max(...pts.map(p => p.y)) + 0.35 } : null;
      const resolveTargetAtomsPreview = (target, previewPosFn) => {
        if (target.molecule !== undefined) {
          const components = connectedComponents();
          const found = components.find(list => list.handle === target.molecule);
          if (!found) fail('分子句柄不存在或已变化：' + target.molecule, 'missing_reference');
          return { points: found.rids.map(rid => ctx.atomPos(rid)).filter(Boolean) };
        }
        const points = [];
        for (const value of target.atoms) points.push(previewPosFn(value).p);
        return { points };
      };
      for (const op of pending) {
        try {
          if (op.type === 'atom.modify') {
            const { p } = previewPos(op.atomId);
            ghostViews.push({ op, kind: 'label', x: p.x, y: p.y, text: op.label || '', charge: own(op, 'charge') ? op.charge : null });
          } else if (op.type === 'atom.delete') {
            const { p } = previewPos(op.atomId);
            ghostViews.push({ op, kind: 'cross', points: [p] });
          } else if (op.type === 'molecule.move') {
            const target = resolveTargetAtomsPreview(op.target, previewPos);
            const orientation = own(op, 'orientTowardAtomId') ? hydrogenOrientation(op, tables, ctx) : null;
            const delta = orientation ? orientation.displacement : own(op, 'x') && own(op, 'y')
              ? { dx: op.x - (Math.min(...target.points.map(p => p.x)) + Math.max(...target.points.map(p => p.x))) / 2, dy: op.y - (Math.min(...target.points.map(p => p.y)) + Math.max(...target.points.map(p => p.y))) / 2 }
              : { dx: op.dx, dy: op.dy };
            ghostViews.push({ op, kind: 'move', points: target.points, delta, destination: target.points.map(p => ({ x: p.x + delta.dx, y: p.y + delta.dy })) });
            if (orientation) positions.set(orientation.atomId, { ...positions.get(orientation.atomId), ...orientation.to });
          } else if (op.type === 'molecule.delete') {
            const target = resolveTargetAtomsPreview(op.target, previewPos);
            ghostViews.push({ op, kind: 'cross', points: target.points, box: boxOfPoints(target.points) });
          } else if (op.type === 'bond.add' || op.type === 'bond.modify') {
            if (op.type === 'bond.add') {
              const begin = previewPos(op.begin), end = previewPos(op.end);
              const count = op.order ?? 1;
              const local = count === 1 && placeLooseHydrogen(begin.id, end.id, ctx, id =>
                !draftedBondAtoms.has(id) && (positions.has(id) || run.looseAtoms.has(id)));
              const hydrogen = local && positions.get(local.id);
              if (hydrogen) Object.assign(hydrogen, local.position);
              ghostViews.push({ op, kind: 'bond', count,
                begin: local && local.id === begin.id ? local.position : begin.p,
                end: local && local.id === end.id ? local.position : end.p,
                hydrogen: local && !hydrogen ? local.position : null });
              draftedBondAtoms.add(begin.id);
              draftedBondAtoms.add(end.id);
            } else {
              const info = previewBond(op.bondId);
              ghostViews.push({ op, kind: 'bond', begin: info.begin, end: info.end, count: op.order || info.type || 1 });
            }
          } else if (op.type === 'bond.delete') {
            const info = previewBond(op.bondId);
            ghostViews.push({ op, kind: 'cross', points: [{ x: (info.begin.x + info.end.x) / 2, y: (info.begin.y + info.end.y) / 2 }] });
          } else if (op.type === 'arrow.modify') {
            const raw = tables.entities.get(op.arrowId) || op.arrowId;
            const existing = previewArrow(raw);
            if (!existing) fail('预览引用的箭头尚未出现：' + op.arrowId, 'missing_reference');
            const draft = M.clone(existing);
            if (own(op, 'source')) draft.source = resolveEndpoint(op.source, tables, previewContext);
            if (own(op, 'target')) draft.target = resolveEndpoint(op.target, tables, previewContext);
            if (own(op, 'electronCount')) draft.electronCount = op.electronCount;
            if (own(op, 'mode') && op.mode === 'auto') { const plan = controller.planFor(draft.source, draft.target, draft.electronCount, { ctx }); if (plan) draft.geometry.bend = plan.plan.bend; }
            else if (own(op, 'bend')) { draft.geometry.bend = op.bend; draft.geometry.mode = 'manual'; draft.geometry.routeVersion = 0; delete draft.geometry.controlFrame; }
            if (own(op, 'mode')) draft.geometry.mode = op.mode;
            const geometry = M.arrowGeometry(draft, ctx);
            if (geometry.sourceOk && geometry.targetOk && !geometry.degenerate) ghostViews.push({ op, kind: 'arrow', geometry });
          } else if (op.type === 'arrow.delete') {
            const raw = tables.entities.get(op.arrowId) || op.arrowId;
            const existing = previewArrow(raw);
            if (existing) {
              const geometry = M.arrowGeometry(existing, ctx);
              ghostViews.push({ op, kind: 'cross-arrow', geometry });
            }
          } else if (op.type === 'lonePair.modify') {
            const raw = tables.entities.get(op.lonePairId) || op.lonePairId;
            const existing = previewLp(raw);
            if (existing) {
              const draft = M.clone(existing);
              modifyLonePairAim(draft, op, ctx, previewModel.state.lonePairs, previewModel.state.arrows);
              lps.set(raw, draft);
              ghostViews.push({ op, kind: 'lp', lp: draft });
            }
          } else if (op.type === 'lonePair.delete') {
            const raw = tables.entities.get(op.lonePairId) || op.lonePairId;
            const existing = previewLp(raw);
            if (existing) { const p = M.lonePairPosition(existing, ctx); if (p) ghostViews.push({ op, kind: 'cross', points: [p] }); }
          } else if (op.type === 'text.delete') {
            const raw = tables.entities.get(op.textId) || op.textId;
            const textRecord = textViews.find(item => String(item.op.id) === String(raw));
            const structText = ed.struct().texts.get(Number(raw)) || ed.struct().texts.get(raw);
            const position = textRecord ? { x: textRecord.x, y: textRecord.y } : structText && structText.position ? { x: structText.position.x, y: structText.position.y } : null;
            if (position) ghostViews.push({ op, kind: 'cross-text', position, text: structText && typeof structText.content === 'string' ? structText.content : (textRecord ? textRecord.text : '') });
          } else if (op.type === 'layout.tidy') {
            const data = prepared.get(op.id);
            if (data && data.ok === true) {
              const bindings = a.mapRuntimeToKet(data.doc);
              if (bindings.ok) {
                const ridByMolIndex = new Map();
                for (const binding of bindings.atoms) ridByMolIndex.set(binding.mol + '#' + binding.index, a.atomIdOf(binding.id));
                for (const molecule of data.molecules) {
                  const rids = (molecule.atoms || []).map((atom, index) => ridByMolIndex.get(molecule.key + '#' + index)).filter(Boolean);
                  const current = rids.map(rid => ctx.atomPos(rid)).filter(Boolean);
                  if (!current.length) continue;
                  const newCenter = { x: molecule.atoms.reduce((s, c) => s + c[0], 0) / molecule.atoms.length, y: -molecule.atoms.reduce((s, c) => s + c[1], 0) / molecule.atoms.length };
                  const width = Math.max(...current.map(p => p.x)) - Math.min(...current.map(p => p.x)) + 0.9;
                  const height = Math.max(...current.map(p => p.y)) - Math.min(...current.map(p => p.y)) + 0.9;
                  ghostViews.push({ op, kind: 'move', box: { x1: newCenter.x - width / 2, y1: newCenter.y - height / 2, x2: newCenter.x + width / 2, y2: newCenter.y + height / 2 }, points: current, delta: { dx: 0, dy: 0 }, destination: current.map(p => ({ x: p.x + (newCenter.x - (Math.min(...current.map(q => q.x)) + Math.max(...current.map(q => q.x))) / 2), y: p.y + (newCenter.y - (Math.min(...current.map(q => q.y)) + Math.max(...current.map(q => q.y))) / 2) })) });
                }
              }
            }
          }
        } catch (error) {
          if (error && (error.code === 'missing_reference' || error.code === 'invalid_operation')) ghostViews.push({ op, kind: 'pending', message: error.message });
          else throw error;
        }
      }
      checkRun(run, cancellation.signal);
      if (version !== run.previewVersion) return { previewed: 0, superseded: true };
      const group = uiGroup('preview', run.id), scale = 1 / a.bondLength(); group.setAttribute('opacity', '0.76');
      const reduced = root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      function operationGroup(op, kind) {
        const node = element(group, 'g', { 'data-agent-op': op.id, 'data-agent-kind': kind });
        const hash = canonical(op), previous = run.previewFrames.get(op.id);
        if (previous && previous.hash !== hash) fail('已预览操作的参数发生了变化：' + op.id, 'operation_conflict');
        const frame = previous || { hash, started: Date.now() };
        run.previewFrames.set(op.id, frame);
        return { node, elapsed: Date.now() - frame.started };
      }
      function animate(node, keyframes, duration, elapsed) {
        if (reduced || doc.hidden || !node.animate || elapsed >= duration) return;
        const animation = node.animate(keyframes, { duration, easing: 'ease-out', fill: 'both' });
        animation.currentTime = Math.max(0, elapsed);
        // WebKit can suspend a window's animation timeline while JavaScript
        // timers and streaming continue (occluded/background native windows).
        // The complete object must never remain at its first opacity=0 frame.
        const fallback = root.setTimeout(() => animation.cancel(), Math.max(0, duration - elapsed) + 80);
        animation.finished.then(() => { root.clearTimeout(fallback); animation.cancel(); }, () => root.clearTimeout(fallback));
      }
      for (const view of moleculeViews) {
        const entry = operationGroup(view.op, 'molecule'), target = entry.node;
        for (const bond of view.bonds) {
          const count = bond.type >= 1 && bond.type <= 3 ? bond.type : 1, dx = bond.end.x - bond.begin.x, dy = bond.end.y - bond.begin.y, length = Math.hypot(dx, dy) || 1;
          for (let i = 0; i < count; i++) { const offset = (i - (count - 1) / 2) * 0.12; element(target, 'line', { x1: bond.begin.x - dy / length * offset, y1: bond.begin.y + dx / length * offset, x2: bond.end.x - dy / length * offset, y2: bond.end.y + dx / length * offset, stroke: '#0a7ea4', 'stroke-width': 1.6 * scale, 'stroke-dasharray': bond.type === 4 ? '0.1 0.08' : 'none' }); }
        }
        for (const atom of view.atoms) {
          const charge = atom.charge === -1 ? '⁻' : atom.charge === 1 ? '⁺' : atom.charge ? String(Math.abs(atom.charge)) + (atom.charge > 0 ? '⁺' : '⁻') : '';
          element(target, 'text', { x: atom.x, y: atom.y, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'Arial,sans-serif', 'font-size': 13 * scale, fill: '#0a7ea4', stroke: '#fff', 'stroke-width': 5 * scale, 'paint-order': 'stroke' }, atom.label + charge);
        }
        target.style.transformBox = 'fill-box'; target.style.transformOrigin = 'center';
        animate(target, [{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: 'scale(1)' }], 180, entry.elapsed);
      }
      for (const item of reactionViews) {
        const entry = operationGroup(item.op, 'reactionArrow');
        const { start, end } = item;
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length;
        const base = { x: end.x - dx * 0.24, y: end.y - dy * 0.24 };
        const left = { x: base.x - dy * 0.12, y: base.y + dx * 0.12 };
        const right = { x: base.x + dy * 0.12, y: base.y - dx * 0.12 };
        element(entry.node, 'path', { d: `M ${start.x} ${start.y} L ${end.x} ${end.y} M ${left.x} ${left.y} L ${end.x} ${end.y} L ${right.x} ${right.y}`,
          fill: 'none', stroke: '#0a7ea4', 'stroke-width': 1.8 * scale });
        for (const label of item.labels) {
          element(entry.node, 'text', { x: label.x, y: label.y + 0.28, 'font-size': 13 * scale, fill: '#0a7ea4' }, label.text);
        }
        animate(entry.node, [{ opacity: 0 }, { opacity: 1 }], 180, entry.elapsed);
      }
      for (const item of lpViews) {
        const entry = operationGroup(item.op, 'lonePair');
        app.layer.renderLonePairs({ state: { lonePairs: [item.lp], arrows: [] } }, ctx, app.layer.unit(), new Set(), {}, entry.node);
        animate(entry.node, [{ opacity: 0 }, { opacity: 1 }], 140, entry.elapsed);
      }
      for (const item of arrowViews) {
        const entry = operationGroup(item.op, 'arrow');
        app.layer.renderArrows({ state: { lonePairs: [], arrows: [item.arrow] } }, ctx, app.layer.canonical(), new Set(), {}, entry.node, app.layer.unit());
        const paths = Array.from(entry.node.querySelectorAll('path'));
        if (paths[0]) {
          paths[0].setAttribute('pathLength', '1'); paths[0].setAttribute('stroke-dasharray', '1'); paths[0].setAttribute('stroke-dashoffset', '0');
          animate(paths[0], [{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], 260, entry.elapsed);
        }
        for (const head of paths.slice(1)) animate(head, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1, offset: 1 }], 260, entry.elapsed);
      }
      for (const item of textViews) {
        const entry = operationGroup(item.op, 'text');
        item.text.split('\n').forEach((line, index) => element(entry.node, 'text', { x: item.x, y: item.y + index * 0.45, 'font-size': 14 * scale, fill: '#0a7ea4' }, line));
        animate(entry.node, [{ opacity: 0 }, { opacity: 1 }], 130, entry.elapsed);
      }
      /* ghost/diff 渲染：虚线覆盖层。删除=橙色 ×/虚框；修改=青色 ghost；
         不写入源、不进入历史、不影响选区。 */
      for (const ghost of ghostViews) {
        const entry = operationGroup(ghost.op, 'ghost-' + ghost.kind), node = entry.node;
        const dash = { stroke: '#b45309', 'stroke-width': 1.5 * scale, fill: 'none', 'stroke-dasharray': (0.14 * scale) + ' ' + (0.1 * scale) };
        const ghostStroke = { stroke: '#0a7ea4', 'stroke-width': 1.6 * scale, fill: 'none', 'stroke-dasharray': (0.16 * scale) + ' ' + (0.12 * scale) };
        if (ghost.kind === 'cross' || ghost.kind === 'cross-arrow') {
          if (ghost.box) element(node, 'rect', { x: ghost.box.x1, y: ghost.box.y1, width: ghost.box.x2 - ghost.box.x1, height: ghost.box.y2 - ghost.box.y1, ...dash });
          for (const p of ghost.points || []) {
            const r = 0.24;
            element(node, 'line', { x1: p.x - r, y1: p.y - r, x2: p.x + r, y2: p.y + r, ...dash });
            element(node, 'line', { x1: p.x - r, y1: p.y + r, x2: p.x + r, y2: p.y - r, ...dash });
          }
          if (ghost.kind === 'cross-arrow' && ghost.geometry) {
            element(node, 'path', { d: 'M ' + ghost.geometry.start.x + ' ' + ghost.geometry.start.y + ' Q ' + ghost.geometry.control.x + ' ' + ghost.geometry.control.y + ' ' + ghost.geometry.end.x + ' ' + ghost.geometry.end.y, ...dash });
          }
        } else if (ghost.kind === 'cross-text') {
          const width = Math.max(1, (ghost.text || '').length) * 0.22, height = 0.5;
          element(node, 'rect', { x: ghost.position.x - width / 2, y: ghost.position.y - height / 2, width, height, ...dash });
        } else if (ghost.kind === 'label') {
          const charge = ghost.charge === null || ghost.charge === undefined ? '' : (ghost.charge > 0 ? '⁺' : ghost.charge < 0 ? '⁻' : '');
          element(node, 'text', { x: ghost.x, y: ghost.y, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'Arial,sans-serif', 'font-size': 13 * scale, fill: '#0a7ea4', stroke: '#fff', 'stroke-width': 5 * scale, 'paint-order': 'stroke' }, ghost.text + charge);
          element(node, 'circle', { cx: ghost.x, cy: ghost.y, r: 0.42, ...ghostStroke });
        } else if (ghost.kind === 'move') {
          if (ghost.box) element(node, 'rect', { x: ghost.box.x1, y: ghost.box.y1, width: ghost.box.x2 - ghost.box.x1, height: ghost.box.y2 - ghost.box.y1, ...ghostStroke });
          else for (const p of ghost.destination || []) element(node, 'circle', { cx: p.x, cy: p.y, r: 0.16, ...ghostStroke });
          if (ghost.points && ghost.points.length && (ghost.destination || []).length === ghost.points.length) {
            const from = ghost.points[Math.floor(ghost.points.length / 2)], to = ghost.destination[Math.floor(ghost.points.length / 2)];
            if (Math.hypot(to.x - from.x, to.y - from.y) > 0.25) {
              element(node, 'line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: '#0a7ea4', 'stroke-width': 1.2 * scale, 'stroke-dasharray': (0.1 * scale) + ' ' + (0.08 * scale) });
              const angle = Math.atan2(to.y - from.y, to.x - from.x);
              element(node, 'path', { d: 'M ' + (to.x - Math.cos(angle - 0.5) * 0.22) + ' ' + (to.y - Math.sin(angle - 0.5) * 0.22) + ' L ' + to.x + ' ' + to.y + ' L ' + (to.x - Math.cos(angle + 0.5) * 0.22) + ' ' + (to.y - Math.sin(angle + 0.5) * 0.22), stroke: '#0a7ea4', 'stroke-width': 1.2 * scale, fill: 'none' });
            }
          }
        } else if (ghost.kind === 'bond') {
          const count = Math.max(1, Math.min(3, ghost.count || 1)), dx = ghost.end.x - ghost.begin.x, dy = ghost.end.y - ghost.begin.y, length = Math.hypot(dx, dy) || 1;
          for (let i = 0; i < count; i++) {
            const offset = (i - (count - 1) / 2) * 0.12;
            element(node, 'line', { x1: ghost.begin.x - dy / length * offset, y1: ghost.begin.y + dx / length * offset, x2: ghost.end.x - dy / length * offset, y2: ghost.end.y + dx / length * offset, ...ghostStroke, 'stroke-dasharray': 'none', opacity: 0.8 });
          }
          if (ghost.hydrogen) element(node, 'text', { x: ghost.hydrogen.x, y: ghost.hydrogen.y,
            'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 13 * scale,
            fill: '#0a7ea4', stroke: '#fff', 'stroke-width': 5 * scale, 'paint-order': 'stroke' }, 'H');
        } else if (ghost.kind === 'arrow') {
          const geometry = ghost.geometry;
          element(node, 'path', { d: 'M ' + geometry.start.x + ' ' + geometry.start.y + ' Q ' + geometry.control.x + ' ' + geometry.control.y + ' ' + geometry.end.x + ' ' + geometry.end.y, ...ghostStroke });
          const tan = M.quadTangent(geometry.start, geometry.control, geometry.end, 1);
          const angle = Math.atan2(tan.y, tan.x);
          element(node, 'path', { d: 'M ' + (geometry.end.x + Math.cos(angle - Math.PI + 0.45) * 0.3) + ' ' + (geometry.end.y + Math.sin(angle - Math.PI + 0.45) * 0.3) + ' L ' + geometry.end.x + ' ' + geometry.end.y + ' L ' + (geometry.end.x + Math.cos(angle - Math.PI - 0.45) * 0.3) + ' ' + (geometry.end.y + Math.sin(angle - Math.PI - 0.45) * 0.3), stroke: '#0a7ea4', 'stroke-width': 1.6 * scale, fill: 'none' });
        } else if (ghost.kind === 'lp') {
          app.layer.renderLonePairs({ state: { lonePairs: [ghost.lp], arrows: [] } }, ctx, app.layer.unit(), new Set(), {}, node);
        } else if (ghost.kind === 'pending') {
          element(node, 'text', { x: viewport().center.x, y: viewport().center.y - 1.2, 'text-anchor': 'middle', 'font-size': 12 * scale, fill: '#b45309' }, ghost.message);
        }
        animate(node, [{ opacity: 0 }, { opacity: 1 }], 140, entry.elapsed);
      }
      run.preview?.remove();
      run.preview = group;
      return { previewed: pending.length, revision, sessionId };
    }
    const originalUpdate = ed.update;
    ed.update = function () { const result = originalUpdate.apply(this, arguments); scheduleScan('manual', 'edit'); return result; };
    const originalSetMolecule = a.k.setMolecule;
    a.k.setMolecule = function () {
      return duringReplacement(workbenchLoadDepth ? null : 'replace', () => originalSetMolecule.apply(this, arguments));
    };
    const originalLoad = root.k3dAPI.loadWorkbench;
    if (originalLoad) root.k3dAPI.loadWorkbench = function () {
      return duringReplacement('load', async () => {
        workbenchLoadDepth++;
        try {
          const result = await originalLoad.apply(this, arguments);
          if (result?.ok) revealLoadedReadingGraph();
          return result;
        }
        finally { workbenchLoadDepth--; }
      });
    };
    const offAdapter = a.onChange(kind => {
      if (kind === 'history') scheduleScan('manual', 'history');
      else if (kind !== 'transform' && kind !== 'pan') scheduleScan();
    });
    const offModel = model.onChange(() => scheduleScan('manual', 'edit'));
    signature = signatureNow();
    return {
      getContext,
      inspectStructures,
      applyOperations,
      previewOperations,
      clearPreview,
      getTaskCheckpoint,
      setTaskCheckpoint,
      pauseTaskCheckpoint,
      beginRun(id, settings = {}) {
        return withSettledCanvas(() => {
          if (settings.expectedSessionId && settings.expectedSessionId !== sessionId) {
            fail('已切换画布，不能继续旧文档中的任务', 'document_changed');
          }
          const run = getRun(id, true);
          checkRun(run, settings.signal);
          a.syncIdentity(); refreshReactionGlyphs();
          if (own(settings, 'readingOrder')) run.readingOrder = settings.readingOrder === true;
          if (own(settings, 'separatePaths')) run.separatePaths = settings.separatePaths === true;
          const resumeAliases = settings.resumeRunId ? inheritRun(run, settings.resumeRunId) : undefined;
          return { sessionId, revision, runId: id, taskCheckpoint: copy(taskCheckpoint),
            ...(settings.includeContext && { context: snapshotContext() }), ...(resumeAliases && { resumeAliases }) };
        }, settings.signal);
      },
      endRun(id, settings = {}) { const run = runs.get(id); if (!run) return; clearPreview(id);
        if (settings.status === 'completed' && run.readingOrder) revealCompletedGraph(completedDrawingBounds(run), run);
        if (run.state === 'active') run.state = 'ended'; if (currentRun === id) currentRun = null; },
      dispose() { disposed = true; for (const id of runs.keys()) clearPreview(id); offAdapter(); offModel(); ed.update = originalUpdate; a.k.setMolecule = originalSetMolecule; delete app.reactionSteps; delete app.agentTask; if (originalLoad) root.k3dAPI.loadWorkbench = originalLoad; }
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { validateOperations, validateArrowAnchors, bondObservation, inverseGroup, createBridge, dependencyOrder, resolveMoleculeHandle, resolveLonePairAimTarget, orientTerminalHydrogen, makeExplicitHydrogenPlan, revisionSource, automaticViewportPlan, scaleStepRecord, LAYOUT };
  if (!root.document) return;
  const MW = root.MolWorkbench = root.MolWorkbench || {};
  MW.agentBridge = { createBridge, validateOperations, dependencyOrder, LAYOUT };
  // Diagnostics for the native shell's layer wait: createBridge runs after an
  // async poll, and a rejection here is permanent (app.reactionSteps never
  // installs). Publish the settle state so the native wait can fail with the
  // real cause instead of polling blind. No credentials or payloads here.
  MW.agentBridge.bridgeReady = false;
  MW.agentBridge.bridgeFailure = null;
  let bridge = null;
  const ready = new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (MW.app?.ready && root.k3dAPI?.workbenchReady?.()) {
        try { bridge = createBridge(MW.app); MW.agentBridge.bridgeReady = true; resolve(bridge); }
        catch (error) {
          MW.agentBridge.bridgeFailure = (error && error.message) ? error.message : String(error);
          reject(error);
        }
      } else if (Date.now() - started > 45000) {
        MW.agentBridge.bridgeFailure = '化学工作台尚未就绪';
        reject(new Error('化学工作台尚未就绪'));
      } else root.setTimeout(poll, 100);
    };
    poll();
  });
  ready.catch(() => {});
  const api = {};
  for (const name of ['getContext', 'inspectStructures', 'applyOperations', 'previewOperations', 'clearPreview', 'beginRun', 'endRun', 'getTaskCheckpoint', 'setTaskCheckpoint', 'pauseTaskCheckpoint']) api[name] = async function () { const instance = bridge || await ready; return instance[name].apply(instance, arguments); };
  root.k3dAPI = root.k3dAPI || {}; root.k3dAPI.agent = api;
})(typeof window !== 'undefined' ? window : globalThis);
