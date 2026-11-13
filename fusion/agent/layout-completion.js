// Only an explicit request to preserve chemistry while arranging existing work
// may use a host-authored completion. Ordinary chemistry answers remain model text.
export function isExplicitLayoutOnly(text) {
  const value = String(text || '');
  // Explicit local depiction commands use the ordinary edit interface, even
  // when the user also asks to preserve chemical identities.
  if (/orientTowardAtomId|molecule\.move|\b(?:d?[xy])\s*[:=]\s*-?\d|移(?:动)?到\s*[（(]?\s*-?\d|(?:旋转|转向|朝向)[^。！？\n]{0,20}(?:显式氢|末端氢|\bH\b)|(?:显式氢|末端氢)[^。！？\n]{0,20}(?:旋转|转向|朝向)|\b(?:orient|rotate)\b[^.!?\n]{0,30}(?:hydrogen|\bH\b)|\bbend\s*[:=]?\s*-?\d|曲率|弯曲系数|(?:手动|手工)[^。！？\n]{0,12}(?:箭头|曲线)|\bmanual\b[^.!?\n]{0,20}(?:arrow|curve)/i.test(value)) return false;
  return /整理|排版|重排|布局|\blayout\b|\brearrang|\breflow/i.test(value) &&
    /(?:只|仅)(?:做|需|要)?(?:整理|重排|调整|排版|重新排版)|\blayout[- ]only\b|\bonly\s+(?:rearrange|reflow|adjust\s+(?:the\s+)?layout)/i.test(value) &&
    /(?:保留|保持)[^。！？\n]*(?:身份|化学连接)|\bpreserve\b[^.!?\n]*(?:identit|chemical\s+(?:connect|structure))/i.test(value) &&
    /不(?:增加|新增|添加)[^。！？\n]*删除[^。！？\n]*(?:改写|修改)|\b(?:do not|don't)\b[^.!?\n]*add[^.!?\n]*(?:delete|remove)[^.!?\n]*(?:change|alter|modify)/i.test(value) &&
    !/为什么|为何|(?:解释|讲解|分析)[^。！？\n]{0,30}(?:化学|机理|机制)|核对[^。！？\n]*(?:守恒|电荷|键级|化学正确)|\b(?:why|explain|analy[sz]e|review)\b[^.!?\n]*(?:chemistry|mechanism|reaction|charge|balance)/i.test(value);
}

const allowed = {
  'layout.tidy': ['id', 'type'],
  'lonePair.modify': ['id', 'type', 'lonePairId', 'aim'],
  'arrow.modify': ['id', 'type', 'arrowId', 'mode'],
  'reactionStep.modify': ['id', 'type', 'stepId', 'expectedVersion', 'layout'],
};
const geometryKeys = ['reactantPlacement', 'reagentPlacement', 'breakBefore'];
export function semanticLayoutOperationSchema(fullSchema) {
  return { oneOf: fullSchema.oneOf.filter(schema => allowed[schema.properties.type.const]).map(schema => {
    const type = schema.properties.type.const;
    const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => allowed[type].includes(key)));
    const required = schema.required.slice();
    if (type === 'reactionStep.modify') {
      properties.layout = { ...properties.layout,
        properties: Object.fromEntries(Object.entries(properties.layout.properties).filter(([key]) => geometryKeys.includes(key))) };
      required.push('layout');
    }
    for (const key of ['aim', 'mode']) if (properties[key]) {
      properties[key] = { ...properties[key], const: 'auto', enum: ['auto'] };
      required.push(key);
    }
    return { ...schema, properties, required };
  }) };
}
export function assertLayoutOperations(operations) {
  for (const op of operations) {
    if (!allowed[op.type] || Object.keys(op).some(key => !allowed[op.type].includes(key)) ||
        op.type === 'reactionStep.modify' && !op.layout ||
        op.layout && Object.keys(op.layout).some(key => !geometryKeys.includes(key)) ||
        op.type === 'lonePair.modify' && op.aim !== 'auto' || op.type === 'arrow.modify' && op.mode !== 'auto') {
      throw Object.assign(new Error('本次由排版器整理整张画布。请使用 layout.tidy、步骤的 layout 修改或现有孤对/箭头的 auto 模式；不要逐个移动原子或分子，也不要指定手工角度或弯曲。'),
        { code: 'layout_scope_violation', operationId: op.id, operationType: op.type });
    }
  }
}

const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
}
const sorted = values => values.slice().sort((a, b) => canonical(a).localeCompare(canonical(b)));
const members = values => [...new Set(values || [])].sort();
export function layoutChemicalIdentity(canvas) {
  if (!canvas || canvas.available === false || !Array.isArray(canvas.atoms) || !Array.isArray(canvas.bonds)) return null;
  return canonical({
    sessionId: canvas.sessionId,
    atoms: sorted(canvas.atoms.map(atom => ({ id: atom.id, label: atom.label, charge: atom.charge || 0,
      radical: atom.radical || atom.radicalElectrons || 0, isotope: atom.isotope || 0, implicitH: atom.implicitH ?? atom.implicitHCount ?? 0,
      aromatic: !!atom.aromatic, hasQuery: !!atom.hasQuery, stereoLabel: atom.stereoLabel || null,
      stereoParity: atom.stereoParity ?? null, alias: atom.alias || null }))),
    bonds: sorted(canvas.bonds.map(bond => ({ id: bond.id, atoms: members([bond.begin, bond.end]),
      order: bond.order, aromatic: !!bond.aromatic, stereo: bond.stereo || 0,
      ...(bond.stereo && { begin: bond.begin, end: bond.end }) }))),
    molecules: sorted((canvas.molecules || []).map(molecule => members(molecule.atoms))),
    lonePairs: sorted((canvas.lonePairs || []).map(pair => ({ id: pair.id, ownerAtomId: pair.ownerAtomId,
      electronCount: pair.electronCount ?? 2 }))),
    arrows: sorted((canvas.arrows || []).map(arrow => ({ id: arrow.id, source: arrow.source, target: arrow.target,
      electronCount: arrow.electronCount }))),
    steps: sorted((canvas.reactionSteps || []).map(step => ({ stepId: step.stepId,
      reactants: members(step.reactants), products: members(step.products), conditions: step.conditions ?? step.layout?.conditions ?? '' }))),
    reactionArrows: sorted((canvas.reactionArrows || []).map(arrow => ({ id: String(arrow.id), stepId: arrow.stepId,
      reactants: members(arrow.reactants), products: members(arrow.products) }))),
  });
}

export function verifiedLayoutCompletion(baseline, canvas) {
  const fail = message => ({ ok: false, message });
  if (!baseline || baseline !== layoutChemicalIdentity(canvas)) return fail('排版后的化学身份、属性或电子流端点未能核对为保持一致，请检查当前画布。');
  const steps = canvas.reactionSteps || [], arrows = canvas.reactionArrows || [];
  if (steps.some(step => step.checks?.layout?.status !== 'passed')) return fail('仍有反应步骤的实际排布未通过核对。');
  if (arrows.some(arrow => !Number.isFinite(arrow.start?.x) || !Number.isFinite(arrow.end?.x) ||
      !Number.isFinite(arrow.start?.y) || !Number.isFinite(arrow.end?.y) ||
      Math.abs(arrow.start.y - arrow.end.y) > 0.02 || arrow.end.x <= arrow.start.x)) return fail('仍有直反应箭头未形成水平向前的衔接。');
  const labels = new Map();
  for (const { text } of canvas.texts || []) {
    if (!/^(?:续\s*\d+|接\s*B?\d+)$/.test(String(text).trim())) continue;
    const token = String(text).trim().replace(/\s+/g, '');
    labels.set(token, (labels.get(token) || 0) + 1);
  }
  const cues = new Map(), atoms = new Set(canvas.atoms.map(atom => atom.id));
  const component = new Map((canvas.molecules || []).flatMap((molecule, index) => molecule.atoms.map(atom => [atom, index])));
  for (const step of steps) for (const port of step.ports || []) {
    const token = String(port.token || '').replace(/\s+/g, '');
    if (!cues.has(token)) cues.set(token, []);
    cues.get(token).push({ ...port, ownerStep: step });
  }
  for (const [token, pair] of cues) {
    if (pair.length !== 2 || labels.get(token) !== 2 || pair[0].kind !== pair[1].kind ||
        pair.some(port => !['source', 'target'].includes(port.side)) ||
        members(pair.map(port => port.at)).join() !== 'molecule,port' ||
        !pair[0].anchorRefs?.length || canonical(members(pair[0].anchorRefs)) !== canonical(members(pair[1].anchorRefs)) ||
        pair.some(port => {
          const side = port.side === 'source' ? port.ownerStep.reactants : port.ownerStep.products;
          const owners = new Set((side || []).map(atom => component.get(atom)).filter(index => index !== undefined));
          if (port.anchorRefs.some(atom => !atoms.has(atom))) return true;
          const owned = port.anchorRefs.map(atom => owners.has(component.get(atom)));
          // A home group can contain the preceding product and the next
          // reagent. Its peer port owns the full exact group; the home label
          // must still belong to at least one of its own step participants.
          return port.at === 'port' ? !owned.every(Boolean) : !owned.some(Boolean);
        })) return fail('当前续接端口尚未成对连接同一组真实结构，请核对跨行或跨支路的衔接。');
  }
  for (const step of steps) {
    const continuation = step.layoutStatus?.continuation;
    if (!Number.isInteger(continuation) || continuation < 1) continue;
    const token = `续${continuation}`;
    if (labels.get(token) !== 2) return fail('当前续接标记尚未成对，请核对跨行衔接。');
    if (!cues.has(token)) cues.set(token, []);
  }
  const facts = { molecules: canvas.molecules?.length || 0, atoms: canvas.atoms.length, bonds: canvas.bonds.length,
    electronFlows: canvas.arrows?.length || 0, reactionSteps: steps.length, horizontalArrows: arrows.length,
    pairedTokens: [...cues.keys()].sort() };
  return { ok: true, facts, text: `排版已完成。保留原有 ${facts.molecules} 个分子、${facts.reactionSteps} 个反应步骤和 ${facts.electronFlows} 根电子流；化学属性、电子流端点及步骤连接已核对保持一致。` +
    (arrows.length ? `${arrows.length} 条直反应箭头均为水平向前。` : '') +
    (cues.size ? `续接标记 ${facts.pairedTokens.map(token => `「${token}」`).join('、')} 已成对核对。` : '') };
}
