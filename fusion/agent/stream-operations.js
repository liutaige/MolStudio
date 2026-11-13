const MAX_BYTES = 100_000;
const MAX_OPERATIONS = 40;
const TYPES = new Set(['molecule.add', 'lonePair.add', 'arrow.add', 'reactionArrow.add',
  'reactionStep.create', 'reactionStep.modify', 'reactionStep.delete', 'text.add',
  'molecule.move', 'molecule.delete',
  'atom.modify', 'atom.delete', 'hydrogen.makeExplicit',
  'bond.add', 'bond.modify', 'bond.delete',
  'arrow.modify', 'arrow.delete',
  'lonePair.modify', 'lonePair.delete',
  'text.delete',
  'layout.tidy', 'step.seal']);
const EDIT_TARGET_MAX = 200;
const ELEMENT = /^[A-Z][a-z]?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (message, field) => { throw Object.assign(new Error(message), field && { field }); };
const record = (v, label) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} 必须是对象`);
  return v;
};
const string = (v, label, max = 20_000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${label} 必须是非空字符串`);
  return v;
};
const ref = (v, label) => {
  if (typeof v !== 'string' || !ID.test(v) || ['__proto__', 'constructor', 'prototype'].includes(v)) fail(`${label} 不是有效引用`, label);
};
const finite = (v, label) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10_000) fail(`${label} 必须是有限坐标`);
};
function fields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} 含未知字段 ${key}`);
}
function reactionSide(side, label) {
  if (!Array.isArray(side) || side.length < 1 || side.length > 16 || new Set(side).size !== side.length) fail(`${label} 需要 1–16 个不同的分子代表原子`);
  for (const item of side) ref(item, label);
}
function reactionLayout(value, { allowEmptyConditions = false } = {}) {
  const layout = record(value, 'layout');
  fields(layout, ['reactantPlacement', 'reagentPlacement', 'breakBefore', 'conditions'], 'layout');
  if (own(layout, 'reactantPlacement') && !['auto', 'horizontal', 'vertical'].includes(layout.reactantPlacement)) fail('反应物排布需要 auto、horizontal 或 vertical', 'layout.reactantPlacement');
  if (own(layout, 'reagentPlacement') && !['auto', 'left', 'right', 'above', 'below'].includes(layout.reagentPlacement)) fail('试剂相对位置需要 auto、left、right、above 或 below', 'layout.reagentPlacement');
  if (own(layout, 'breakBefore') && typeof layout.breakBefore !== 'boolean') fail('换行设置需要布尔值', 'layout.breakBefore');
  if (own(layout, 'conditions')) {
    const conditions = allowEmptyConditions && layout.conditions === '' ? '' : string(layout.conditions, 'layout.conditions', 64);
    if (/[\u0000-\u001f]/.test(conditions)) fail('反应条件需要单行文字', 'layout.conditions');
  }
}
function validateTarget(value) {
  record(value, 'target');
  if (own(value, 'molecule')) {
    fields(value, ['molecule'], 'target');
    ref(value.molecule, 'target.molecule');
  } else if (own(value, 'atoms')) {
    fields(value, ['atoms'], 'target');
    if (!Array.isArray(value.atoms) || !value.atoms.length || value.atoms.length > EDIT_TARGET_MAX) fail('target.atoms 需要 1–200 个原子引用');
    for (const item of value.atoms) ref(item, 'target.atoms[]');
  } else fail('target 需要 molecule 或 atoms');
}

function endpoint(value, source) {
  record(value, source ? 'source' : 'target');
  if (value.type === 'atom') {
    fields(value, ['type', 'atomId'], 'atom endpoint');
    ref(value.atomId, 'atomId');
  } else if (source && value.type === 'lonePair') {
    fields(value, ['type', 'id'], 'lonePair endpoint');
    ref(value.id, 'lonePair id');
  } else if (source && value.type === 'bond') {
    const byId = own(value, 'bondId');
    const byAtoms = own(value, 'atom1') || own(value, 'atom2');
    if (byId === byAtoms) fail('bond endpoint 需要 bondId 或 atom1/atom2');
    if (byId) { fields(value, ['type', 'bondId', 'component'], 'bond endpoint'); ref(value.bondId, 'bondId'); }
    else {
      fields(value, ['type', 'atom1', 'atom2', 'component'], 'bond endpoint');
      ref(value.atom1, 'atom1'); ref(value.atom2, 'atom2');
      if (value.atom1 === value.atom2) fail('bond endpoint 需要两个不同的原子');
    }
    if (!['sigma', 'pi'].includes(value.component)) fail('component 必须是 sigma 或 pi');
  } else if (!source && value.type === 'formingBond') {
    fields(value, ['type', 'atom1', 'atom2'], 'formingBond endpoint');
    ref(value.atom1, 'atom1'); ref(value.atom2, 'atom2');
    if (value.atom1 === value.atom2) fail('formingBond 需要两个不同的原子');
  } else fail(`不支持的 ${source ? 'source' : 'target'} 类型`);
}

const SCOPE_TYPES = new Set(['completeMechanism', 'partialStep', 'singleMolecule', 'edit', 'annotation']);
function validateTaskScope(value) {
  if (value === undefined || value === null) return undefined;
  record(value, 'taskScope');
  fields(value, ['type', 'stages', 'notes'], 'taskScope');
  if (!SCOPE_TYPES.has(value.type)) fail('taskScope.type 非法');
  if (own(value, 'notes')) {
    if (typeof value.notes !== 'string' || value.notes.length > 500) fail('taskScope.notes 过长');
  }
  if (own(value, 'stages')) {
    if (!Array.isArray(value.stages) || value.stages.length > 12) fail('taskScope.stages 最多 12 项');
    for (const stage of value.stages) {
      record(stage, 'taskScope.stages[]');
      fields(stage, ['label', 'operationIds'], 'taskScope.stages[]');
      if (typeof stage.label !== 'string' || !stage.label.trim() || stage.label.length > 120) fail('taskScope.stages[].label 非法');
      if (own(stage, 'operationIds') && (!Array.isArray(stage.operationIds) || stage.operationIds.length > 40)) fail('taskScope.stages[].operationIds 非法', 'taskScope.stages[].operationIds');
      for (const id of stage.operationIds || []) ref(id, 'taskScope.stages[].operationIds[]');
    }
  }
  return JSON.parse(JSON.stringify(value));
}

export function validateOperation(operation, { allowText = true } = {}) {
  const op = record(operation, 'operation');
  ref(op.id, 'operation.id');
  if (!TYPES.has(op.type)) fail(`不支持的绘图操作 ${String(op.type)}`);
  if (op.type === 'step.seal') {
    fields(op, ['id', 'type'], op.type);
  } else if (op.type === 'molecule.add') {
    fields(op, ['id', 'type', 'smiles', 'x', 'y'], op.type);
    string(op.smiles, 'smiles', 4_096);
    if (/[\u0000-\u001f]/.test(op.smiles)) fail('smiles 不能含控制字符');
  } else if (op.type === 'lonePair.add') {
    fields(op, ['id', 'type', 'atom', 'angle'], op.type);
    ref(op.atom, 'atom');
    if (own(op, 'angle')) finite(op.angle, 'angle');
  } else if (op.type === 'arrow.add') {
    fields(op, ['id', 'type', 'source', 'target', 'electronCount'], op.type);
    endpoint(op.source, true); endpoint(op.target, false);
    if (![1, 2].includes(op.electronCount)) fail('electronCount 必须是 1 或 2');
  } else if (op.type === 'reactionArrow.add' || op.type === 'reactionStep.create' || op.type === 'reactionStep.modify') {
    const modifying = op.type === 'reactionStep.modify';
    fields(op, ['id', 'type', ...(modifying ? ['stepId', 'expectedVersion'] : []), 'reactants', 'products', 'layout'], op.type);
    if (modifying) {
      ref(op.stepId, 'stepId');
      if (!Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 1) fail('expectedVersion 需要 ≥ 1 的整数', 'expectedVersion');
      if (!['reactants', 'products', 'layout'].some(key => own(op, key))) fail('reactionStep.modify 需要 reactants/products/layout 至少一项');
    }
    for (const key of ['reactants', 'products']) if (!modifying || own(op, key)) reactionSide(op[key], key);
    if (op.reactants?.some(atom => op.products?.includes(atom))) fail('反应箭头两侧需要不同分子');
    if (own(op, 'layout')) reactionLayout(op.layout, { allowEmptyConditions: modifying });
  } else if (op.type === 'reactionStep.delete') {
    fields(op, ['id', 'type', 'stepId', 'expectedVersion'], op.type);
    ref(op.stepId, 'stepId');
    if (!Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 1) fail('expectedVersion 需要 ≥ 1 的整数', 'expectedVersion');
  } else if (op.type === 'text.add') {
    fields(op, ['id', 'type', 'text', 'x', 'y'], op.type);
    if (!allowText) fail('只有用户明确要求画布文字或标注时，才能添加 text.add；解释请直接在对话中回答');
    string(op.text, 'text', 2_000);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.text)) fail('text 不能含控制字符');
    if (!own(op, 'x') || !own(op, 'y')) fail('text.add 需要 x 和 y');
  } else if (op.type === 'molecule.move') {
    fields(op, ['id', 'type', 'target', 'x', 'y', 'dx', 'dy', 'orientTowardAtomId'], op.type);
    validateTarget(op.target);
    const absolute = own(op, 'x') || own(op, 'y'), relative = own(op, 'dx') || own(op, 'dy');
    if (own(op, 'orientTowardAtomId')) {
      ref(op.orientTowardAtomId, 'orientTowardAtomId');
      if (absolute || relative) fail('orientTowardAtomId 与 x/y/dx/dy 互斥', 'orientTowardAtomId');
      if (op.target.atoms?.length !== 1) fail('orientTowardAtomId 的 target.atoms 需要单个末端显式 H', 'target.atoms');
      if (op.target.atoms[0] === op.orientTowardAtomId) fail('朝向目标必须是另一个原子', 'orientTowardAtomId');
    } else {
      if (absolute === relative) fail('molecule.move 需要 x/y 或 dx/dy 二者其一');
      if (absolute && (!own(op, 'x') || !own(op, 'y'))) fail('molecule.move 绝对定位需要 x 和 y');
      if (relative && (!own(op, 'dx') || !own(op, 'dy'))) fail('molecule.move 相对位移需要 dx 和 dy');
    }
  } else if (op.type === 'molecule.delete') {
    fields(op, ['id', 'type', 'target'], op.type);
    validateTarget(op.target);
  } else if (op.type === 'hydrogen.makeExplicit') {
    fields(op, ['id', 'type', 'parentAtomId'], op.type);
    ref(op.parentAtomId, 'parentAtomId');
  } else if (op.type === 'atom.modify') {
    fields(op, ['id', 'type', 'atomId', 'label', 'charge', 'isotope', 'radical'], op.type);
    ref(op.atomId, 'atomId');
    if (!own(op, 'label') && !own(op, 'charge') && !own(op, 'isotope') && !own(op, 'radical')) fail('atom.modify 需要 label/charge/isotope/radical 至少一项');
    if (own(op, 'label') && (typeof op.label !== 'string' || !ELEMENT.test(op.label))) fail('atom.modify.label 需要元素符号');
    if (own(op, 'charge') && (!Number.isInteger(op.charge) || Math.abs(op.charge) > 6)) fail('atom.modify.charge 需要整数且绝对值 ≤ 6');
    if (own(op, 'isotope') && (!Number.isInteger(op.isotope) || op.isotope < 0 || op.isotope > 254)) fail('atom.modify.isotope 需要非负整数');
    if (own(op, 'radical') && (!Number.isInteger(op.radical) || op.radical < 0 || op.radical > 3)) fail('atom.modify.radical 需要 0–3 的整数');
  } else if (op.type === 'atom.delete') {
    fields(op, ['id', 'type', 'atomId'], op.type);
    ref(op.atomId, 'atomId');
  } else if (op.type === 'bond.add') {
    fields(op, ['id', 'type', 'begin', 'end', 'order'], op.type);
    ref(op.begin, 'begin'); ref(op.end, 'end');
    if (op.begin === op.end) fail('bond.add 需要两个不同的原子引用');
    if (own(op, 'order') && ![1, 2, 3].includes(op.order)) fail('bond.add.order 只支持 1/2/3');
  } else if (op.type === 'bond.modify') {
    fields(op, ['id', 'type', 'bondId', 'order'], op.type);
    ref(op.bondId, 'bondId');
    if (!own(op, 'order') || ![1, 2, 3].includes(op.order)) fail('bond.modify.order 只支持 1/2/3');
  } else if (op.type === 'bond.delete') {
    fields(op, ['id', 'type', 'bondId'], op.type);
    ref(op.bondId, 'bondId');
  } else if (op.type === 'arrow.modify') {
    fields(op, ['id', 'type', 'arrowId', 'source', 'target', 'electronCount', 'bend', 'mode'], op.type);
    ref(op.arrowId, 'arrowId');
    if (!own(op, 'source') && !own(op, 'target') && !own(op, 'electronCount') && !own(op, 'bend') && !own(op, 'mode')) fail('arrow.modify 需要至少一项修改');
    if (own(op, 'source')) endpoint(op.source, true);
    if (own(op, 'target')) endpoint(op.target, false);
    if (own(op, 'electronCount') && op.electronCount !== 1 && op.electronCount !== 2) fail('electronCount 必须是 1 或 2');
    if (own(op, 'bend') && (typeof op.bend !== 'number' || !Number.isFinite(op.bend) || Math.abs(op.bend) > 3)) fail('arrow.modify.bend 必须是有限曲率且绝对值 ≤ 3');
    if (own(op, 'mode') && op.mode !== 'auto' && op.mode !== 'manual') fail('arrow.modify.mode 只支持 auto/manual');
    if (own(op, 'mode') && op.mode === 'manual' && !own(op, 'bend') && !own(op, 'source') && !own(op, 'target') && !own(op, 'electronCount')) fail('手动模式至少要给出 bend 或端点/电子数');
  } else if (op.type === 'arrow.delete') {
    fields(op, ['id', 'type', 'arrowId'], op.type);
    ref(op.arrowId, 'arrowId');
  } else if (op.type === 'lonePair.modify') {
    fields(op, ['id', 'type', 'lonePairId', 'angle', 'aim'], op.type);
    ref(op.lonePairId, 'lonePairId');
    if (!own(op, 'angle') && !own(op, 'aim')) fail('lonePair.modify 需要 angle 或 aim');
    if (own(op, 'angle') && (typeof op.angle !== 'number' || !Number.isFinite(op.angle) || Math.abs(op.angle) > 10_000)) fail('lonePair.modify 需要有限角度');
    if (own(op, 'aim') && !['auto', 'manual'].includes(op.aim)) fail('lonePair.modify.aim 只支持 auto/manual');
    if (op.aim === 'auto' && own(op, 'angle')) fail('自动朝向不能同时指定 angle');
  } else if (op.type === 'lonePair.delete') {
    fields(op, ['id', 'type', 'lonePairId'], op.type);
    ref(op.lonePairId, 'lonePairId');
  } else if (op.type === 'text.delete') {
    fields(op, ['id', 'type', 'textId'], op.type);
    ref(op.textId, 'textId');
  } else if (op.type === 'layout.tidy') {
    fields(op, ['id', 'type'], op.type);
  }
  for (const key of ['x', 'y', 'dx', 'dy']) if (own(op, key)) finite(op[key], key);
  return JSON.parse(JSON.stringify(op));
}

function indexedOperation(operation, index, options) {
  try { return validateOperation(operation, options); }
  catch (error) {
    throw Object.assign(error, { operationType: operation?.type, operationId: operation?.id, operationIndex: index });
  }
}

export function validateOperations(operations, options) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS) fail('operations 需要 1–40 项操作');
  if (JSON.stringify(operations).length > MAX_BYTES) fail('操作数据超出大小限制');
  const ids = new Set();
  return operations.map((operation, index) => {
    const op = indexedOperation(operation, index, options);
    if (ids.has(op.id)) fail(`重复 operation id: ${op.id}`);
    ids.add(op.id);
    return op;
  });
}

export function operationHash(operation) {
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(operation));
}

function stringEnd(text, start) {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') return i + 1;
  }
  return null;
}
function containerEnd(text, start) {
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end === null) return null;
      i = end - 1;
    } else if (c === '{' || c === '[') {
      stack.push(c);
      if (stack.length > 48) fail('JSON 嵌套过深');
    } else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) fail('JSON 括号不匹配');
      if (!stack.length) return i + 1;
    }
  }
  return null;
}

/** JSON.parse alone discards duplicate keys; check the original tokens first. */
export function parseStrictJson(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) fail('JSON 超出大小限制');
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
  const quoted = () => {
    if (text[i] !== '"') fail('JSON key 必须是字符串');
    const end = stringEnd(text, i);
    if (end === null) fail('JSON 字符串未结束');
    const value = JSON.parse(text.slice(i, end)); i = end; return value;
  };
  function value(depth = 0) {
    if (depth > 48) fail('JSON 嵌套过深');
    ws();
    if (text[i] === '"') { quoted(); return; }
    if (text[i] === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); const key = quoted();
        if (keys.has(key)) fail(`重复 JSON key: ${key}`);
        keys.add(key); ws();
        if (text[i++] !== ':') fail('JSON 缺少冒号');
        value(depth + 1); ws();
        const separator = text[i++];
        if (separator === '}') return;
        if (separator !== ',') fail('JSON 对象未结束');
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) {
        value(depth + 1); ws(); const separator = text[i++];
        if (separator === ']') return;
        if (separator !== ',') fail('JSON 数组未结束');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!token) fail('JSON 值未结束');
    i += token[0].length;
  }
  value(); ws(); if (i !== text.length) fail('JSON 有多余内容');
  return JSON.parse(text);
}

/** Emits only closed operations. A complete root can tolerate one redundant closing brace. */
export class OperationStreamDecoder {
  constructor({ onOperation = () => {}, allowText = true, maxBytes = MAX_BYTES } = {}) {
    this.onOperation = onOperation; this.allowText = allowText; this.maxBytes = maxBytes;
    this.text = ''; this.position = 0; this.state = 'start'; this.keys = new Set(); this.operations = [];
    this.error = null;
  }
  push(delta) {
    if (this.error) throw this.error;
    try {
      if (typeof delta !== 'string') fail('参数 delta 必须是字符串');
      this.text += delta;
      if (this.text.length > this.maxBytes) fail('绘图参数超出大小限制');
      this._scan();
      return this.operations.slice();
    } catch (error) { this.error = error; throw error; }
  }
  _scan() {
    const text = this.text;
    const ws = () => { while (this.position < text.length && /\s/.test(text[this.position])) this.position++; };
    for (;;) {
      ws(); if (this.position >= text.length) return;
      const c = text[this.position];
      if (this.state === 'start') {
        if (c !== '{') fail('绘图参数必须是 JSON 对象');
        this.position++; this.state = 'key';
      } else if (this.state === 'key' || this.state === 'key-required') {
        if (c === '}' && this.state === 'key') { this.position++; this.state = 'done'; continue; }
        if (c !== '"') fail('参数 key 必须是字符串');
        const end = stringEnd(text, this.position); if (end === null) return;
        this.key = JSON.parse(text.slice(this.position, end));
        if (this.keys.has(this.key)) fail(`重复 JSON key: ${this.key}`);
        if (!['operations', 'finish', 'taskScope'].includes(this.key)) fail(`未知绘图参数 ${this.key}`);
        this.keys.add(this.key); this.position = end; this.state = 'colon';
      } else if (this.state === 'colon') {
        if (c !== ':') fail('参数缺少冒号');
        this.position++; this.state = 'value';
      } else if (this.state === 'value') {
        if (this.key === 'operations') {
          if (c !== '[') fail('operations 必须是数组');
          this.position++; this.state = 'operation';
        } else if (this.key === 'taskScope') {
          if (c !== '{') fail('taskScope 必须是对象');
          const end = containerEnd(text, this.position);
          if (end === null) return;
          this.taskScope = validateTaskScope(parseStrictJson(text.slice(this.position, end)));
          this.position = end; this.state = 'after-value';
        } else {
          const match = /^(true|false)(?=\s*[,}])/.exec(text.slice(this.position));
          if (!match) {
            if (/^(?:t|tr|tru|true|f|fa|fal|fals|false)\s*$/.test(text.slice(this.position))) return;
            fail('finish 必须是 boolean');
          }
          this.position += match[0].length; this.state = 'after-value';
        }
      } else if (this.state === 'operation' || this.state === 'operation-required') {
        if (c === ']' && this.state === 'operation') { this.position++; this.state = 'after-value'; continue; }
        if (c !== '{') fail('operation 必须是完整 JSON 对象');
        const end = containerEnd(text, this.position); if (end === null) return;
        const operation = indexedOperation(parseStrictJson(text.slice(this.position, end)), this.operations.length, { allowText: this.allowText });
        if (this.operations.some(op => op.id === operation.id)) fail(`重复 operation id: ${operation.id}`);
        if (this.operations.length >= MAX_OPERATIONS) fail('operations 过多');
        this.operations.push(operation); this.position = end; this.state = 'after-operation';
        this.onOperation(operation, this.operations.slice());
      } else if (this.state === 'after-operation') {
        this.position++;
        if (c === ',') this.state = 'operation-required';
        else if (c === ']') this.state = 'after-value';
        else fail('operation 后需要逗号或数组结尾');
      } else if (this.state === 'after-value') {
        this.position++;
        if (c === ',') this.state = 'key-required';
        else if (c === '}') { this.rootEnd = this.position; this.state = 'done'; }
        else fail('参数值后需要逗号或对象结尾');
      } else if (this.state === 'done' && c === '}' && this.rootEnd && !this.redundantClose) {
        this.redundantClose = true;
        this.position++;
      } else fail('JSON 参数有多余内容');
    }
  }
  finish() {
    this.push('');
    if (this.state !== 'done') fail('绘图参数未完整结束');
    const result = record(parseStrictJson(this.text.slice(0, this.rootEnd)), '绘图参数');
    fields(result, ['operations', 'finish', 'taskScope'], '绘图参数');
    if (own(result, 'finish') && typeof result.finish !== 'boolean') fail('finish 必须是 boolean');
    return { operations: validateOperations(result.operations, { allowText: this.allowText }),
      taskScope: validateTaskScope(result.taskScope), finish: result.finish === true };
  }
}
