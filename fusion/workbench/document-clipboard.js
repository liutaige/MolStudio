/* Clipboard sidecar for semantic identities. No mutations or history actions:
 * caller captures before Ketcher paste, resolves only after native commit, then
 * adds returned lone pairs and endpoints in the same native history action.
 */
(function (root) {
  'use strict';
  const MW = root.MolWorkbench = root.MolWorkbench || {}, M = MW.model;
  const LIMITS = { atoms: 20000, bonds: 40000, lonePairs: 4000, tolerance: 1e-4, coordinate: 100000 };
  const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= LIMITS.coordinate;
  const id = x => typeof x === 'string' && x.length > 0 && x.length <= 160;
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = text => { throw new Error(text); };

  // Capture *all* saved lone pairs on copied atoms, not only selected dots.
  // Selected lone pairs without their owner cannot be represented as chemistry.
  function capture(controller) {
    const a = controller.adapter, st = a.struct(), selection = a.ed.selection() || {};
    a.syncIdentity();
    const atoms = new Set(selection.atoms || []);
    for (const bid of selection.bonds || []) { const bond = st.bonds.get(bid); if (bond) { atoms.add(bond.begin); atoms.add(bond.end); } }
    const sourceAtoms = [...atoms].map(rid => {
      const atom = st.atoms.get(rid), stable = a.uuidOfAtom(rid), point = a.atomPos(rid);
      if (!atom || !id(stable) || !point || !finite(point.x) || !finite(point.y)) fail('无法确定复制原子的稳定身份和坐标');
      return { id: stable, x: point.x, y: point.y, label: typeof atom.label === 'string' ? atom.label : '' };
    });
    const selected = new Set(sourceAtoms.map(atom => atom.id));
    const lonePairs = [];
    for (const lp of controller.model.state.lonePairs) {
      if (controller.selection.has(lp.id) && !selected.has(lp.ownerAtomId)) fail('复制孤对需要同时选择所属原子');
      if (!selected.has(lp.ownerAtomId)) continue;
      const actualAngle = M.lonePairAngle(lp, controller.ctx()) * 180 / Math.PI;
      if (!finite(actualAngle)) fail('无法确定孤对方向');
      lonePairs.push({ lonePair: clone(lp), actualAngle });
    }
    if (!sourceAtoms.length) return null;
    const bonds = [];
    for (const [rid, bond] of st.bonds) {
      const begin = a.uuidOfAtom(bond.begin), end = a.uuidOfAtom(bond.end);
      if (!selected.has(begin) || !selected.has(end)) continue;
      const stable = a.uuidOfBond(rid);
      if (!id(stable)) fail('无法确定复制键的稳定身份');
      bonds.push({ id: stable, begin, end, type: bond.type });
    }
    const data = { version: 1, atoms: sourceAtoms, bonds, lonePairs,
      selectedMechanismIds: lonePairs.map(item => item.lonePair.id) };
    validate(data);
    return data;
  }
  // Build a carrier from an already-validated file without ever loading it into
  // the destination editor. All source identities stay local to this carrier.
  function fromWorkbench(workbench, options = {}) {
    const ket = workbench.ket, mechanism = workbench.mechanism || M.emptyState();
    const atomBindings = new Map((workbench.bindings?.atoms || []).map(b => [b.mol + '#' + b.index, b.id]));
    const bondBindings = new Map((workbench.bindings?.bonds || []).map(b => [b.mol + '#' + b.index, b.id]));
    const sourceAtoms = [], sourceBonds = [], atoms = new Map(), bonds = new Map(), locators = new Map();
    const keys = Object.keys(ket).filter(key => ket[key]?.type === 'molecule');
    for (const key of keys) for (const [index, atom] of (ket[key].atoms || []).entries()) {
      const stable = atomBindings.get(key + '#' + index) || M.newId('at'), p = atom.location;
      if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) fail('导入文件的原子坐标无效');
      const item = { id: stable, x: p[0], y: -p[1], label: atom.label || 'C' };
      sourceAtoms.push(item); atoms.set(stable, item); locators.set(key + '#' + index, stable);
    }
    for (const key of keys) for (const [index, bond] of (ket[key].bonds || []).entries()) {
      const stable = bondBindings.get(key + '#' + index) || M.newId('bd'), begin = locators.get(key + '#' + bond.atoms[0]), end = locators.get(key + '#' + bond.atoms[1]);
      const item = { id: stable, begin, end, type: bond.type || 1 }; sourceBonds.push(item); bonds.set(stable, item);
    }
    const pairs = new Map(mechanism.lonePairs.map(lp => [lp.id, lp]));
    const ctx = { atomPos: id => atoms.get(id) || null, atomLabel: id => atoms.get(id)?.label || '', lonePair: id => pairs.get(id) || null,
      bondInfo: id => { const b = bonds.get(id); return b ? { type: b.type, begin: atoms.get(b.begin), end: atoms.get(b.end), beginAtom: b.begin, endAtom: b.end } : null; }, unit: () => 1 / 40 };
    const lonePairs = mechanism.lonePairs.map(lp => ({ lonePair: clone(lp), actualAngle: M.lonePairAngle(lp, ctx) * 180 / Math.PI }));
    const identity = sourceAtoms.length ? { version: 1, atoms: sourceAtoms, bonds: sourceBonds, lonePairs, selectedMechanismIds: lonePairs.map(item => item.lonePair.id) } : null;
    if (identity) validate(identity);
    else if (lonePairs.length) fail('导入孤对缺少所属原子，请先修复源文件');
    const arrows = mechanism.arrows.map(arrow => {
      const copy = clone(arrow), geometry = M.arrowGeometry(copy, ctx);
      for (const [side, point, valid] of [['source', geometry.start, geometry.sourceOk], ['target', geometry.end, geometry.targetOk]]) {
        if (copy[side].type === 'free') continue;
        if (!valid && !(finite(copy[side].last?.x) && finite(copy[side].last?.y))) fail('导入箭头引用已失效，请先修复源文件');
        if (valid) copy[side].last = { x: point.x, y: point.y };
      }
      return copy;
    });
    const document = workbench.document?.objects?.length ? { objects: clone(workbench.document.objects), assets: clone(workbench.document.assets || {}) } : null;
    for (const object of document?.objects || []) delete object.pageId;
    return { kind: 'molstudio-mechanism', version: 2, native: true, nativeOnly: !arrows.length && !document && !lonePairs.length,
      arrows, lonePairs: lonePairs.map(item => item.lonePair), selectedMechanismIds: arrows.map(a => a.id).concat(lonePairs.map(item => item.lonePair.id)),
      ...(identity && { identity }), ...(document && { document }),
      ...(options.includeMechanismSteps !== false && mechanism.steps?.length && { mechanismSteps: clone(mechanism.steps) }) };
  }
  function prepareNativeFragment(native, ket) {
    const fragment = native.prepareKet(JSON.stringify(ket));
    const refs = (ket.root?.nodes || []).filter(node => node.$ref).map(node => node.$ref), keys = refs.length ? refs : Object.keys(ket);
    const source = keys.filter(key => ket[key]?.type === 'molecule').flatMap(key => ket[key].atoms || []), runtime = [...fragment.atoms.values()];
    if (source.length !== runtime.length) fail('导入原子坐标清单不完整');
    const restore = () => source.forEach((atom, index) => { if (!finite(atom.location?.[0]) || !finite(atom.location?.[1])) fail('导入原子坐标无效'); runtime[index].pp.x = atom.location[0]; runtime[index].pp.y = -atom.location[1]; });
    restore(); const length = fragment.getAvgBondLength();
    if (length >= .001 && Math.abs(length - 1) > 1e-12) fragment.scale(length);
    restore(); return fragment;
  }
  function validate(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.atoms) || !data.atoms.length || data.atoms.length > LIMITS.atoms ||
        !Array.isArray(data.bonds) || data.bonds.length > LIMITS.bonds || !Array.isArray(data.lonePairs) || data.lonePairs.length > LIMITS.lonePairs) fail('复制片段的身份数据无效');
    const atoms = new Set(), bonds = new Set(), pairs = new Set();
    for (const atom of data.atoms) {
      if (!atom || !id(atom.id) || atoms.has(atom.id) || !finite(atom.x) || !finite(atom.y) || typeof atom.label !== 'string' || atom.label.length > 160) fail('复制片段的原子身份无效');
      atoms.add(atom.id);
    }
    for (const bond of data.bonds) {
      if (!bond || !id(bond.id) || bonds.has(bond.id) || !atoms.has(bond.begin) || !atoms.has(bond.end) || bond.begin === bond.end || !Number.isFinite(bond.type)) fail('复制片段的键身份无效');
      bonds.add(bond.id);
    }
    for (const item of data.lonePairs) {
      const lp = item?.lonePair;
      if (!lp || !id(lp.id) || pairs.has(lp.id) || !atoms.has(lp.ownerAtomId) || !finite(item.actualAngle) ||
          (lp.refAtomId !== undefined && lp.refAtomId !== null && !id(lp.refAtomId)) ||
          (lp.angleRel !== undefined && lp.angleRel !== null && !finite(lp.angleRel))) fail('复制片段的孤对身份无效');
      const errors = []; M.validateMechanism({ lonePairs: [lp], arrows: [] }, errors);
      if (errors.length) fail('复制片段的孤对无效：' + errors[0]);
      pairs.add(lp.id);
    }
    if (!Array.isArray(data.selectedMechanismIds) || data.selectedMechanismIds.length !== pairs.size ||
        new Set(data.selectedMechanismIds).size !== pairs.size || data.selectedMechanismIds.some(value => !pairs.has(value))) fail('复制片段的孤对选择无效');
    return true;
  }
  // Call before the native paste tool inserts its temporary preview atoms.
  function stage(data, controller) {
    validate(data);
    const st = controller.adapter.struct();
    return { data: clone(data), beforeAtoms: new Set(st.atoms.keys()), beforeBonds: new Set(st.bonds.keys()), transformed: null, rotation: 0 };
  }
  function move(session, meta) {
    const scale = meta?.scale === undefined ? 1 : meta.scale, rotation = meta?.rotation === undefined ? 0 : meta.rotation;
    const origin = meta?.origin || { x: 0, y: 0 }, target = meta?.target || meta?.offset;
    if (!finite(scale) || scale <= 0 || !finite(rotation) || !origin || !target || ![origin.x, origin.y, target.x, target.y].every(finite)) fail('复制片段的变换无效');
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    function transform(point) {
      const x = point.x * scale - origin.x, y = point.y * scale - origin.y;
      const result = { x: x * cos - y * sin + target.x, y: x * sin + y * cos + target.y };
      if (!finite(result.x) || !finite(result.y)) fail('复制片段的坐标超出范围');
      return result;
    }
    session.transformed = session.data.atoms.map(atom => ({ ...atom, ...transform(atom) }));
    session.rotation = rotation; session.transform = transform;
    return session;
  }
  // Call after Ketcher commits the paste. Existing atoms are NEVER candidates:
  // fusion, coincident new atoms, missing atoms or ambiguous bonds fail closed.
  function resolve(controller, session) {
    try {
      if (!session?.transformed) fail('复制片段尚未定位');
      const a = controller.adapter, st = a.struct();
      a.syncIdentity();
      const candidates = [...st.atoms].filter(([rid]) => !session.beforeAtoms.has(rid));
      const atomMap = new Map(), runtimeMap = new Map(), used = new Set();
      for (const source of session.transformed) {
        const matches = candidates.filter(([rid, atom]) => !used.has(rid) && atom?.pp && atom.label === source.label &&
          finite(atom.pp.x) && finite(atom.pp.y) && Math.abs(atom.pp.x - source.x) <= LIMITS.tolerance && Math.abs(atom.pp.y - source.y) <= LIMITS.tolerance);
        if (matches.length !== 1) fail('粘贴原子无法唯一匹配；可能与已有结构融合或重叠');
        const [rid] = matches[0], stable = a.uuidOfAtom(rid);
        if (!id(stable)) fail('新原子没有稳定身份');
        used.add(rid); atomMap.set(source.id, stable); runtimeMap.set(source.id, rid);
      }
      const bondMap = new Map();
      for (const source of session.data.bonds) {
        const begin = runtimeMap.get(source.begin), end = runtimeMap.get(source.end);
        const matches = [...st.bonds].filter(([rid, bond]) => !session.beforeBonds.has(rid) &&
          ((bond.begin === begin && bond.end === end) || (bond.begin === end && bond.end === begin)) && bond.type === source.type);
        if (matches.length > 1) fail('粘贴键无法唯一匹配');
        // An unselected bond may not be included by Ketcher. Remapping an arrow
        // that depends on it will explicitly fail; it must not attach elsewhere.
        if (matches.length === 1) { const stable = a.uuidOfBond(matches[0][0]); if (!id(stable)) fail('新键没有稳定身份'); bondMap.set(source.id, stable); }
      }
      const lonePairMap = new Map(), lonePairs = [];
      for (const item of session.data.lonePairs) {
        const source = item.lonePair, owner = atomMap.get(source.ownerAtomId), pairId = M.newId('lp');
        const ref = source.refAtomId && atomMap.get(source.refAtomId);
        const copy = { ...clone(source), id: pairId, ownerAtomId: owner,
          angle: item.actualAngle + session.rotation * 180 / Math.PI,
          refAtomId: ref || null, angleRel: ref ? source.angleRel : null };
        lonePairMap.set(source.id, pairId); lonePairs.push(copy);
      }
      const errors = []; M.validateMechanism({ lonePairs, arrows: [] }, errors);
      if (errors.length) fail('粘贴孤对无效：' + errors[0]);
      return { ok: true, atomMap, bondMap, lonePairMap, lonePairs, session };
    } catch (error) { return { ok: false, error: error.message || String(error) }; }
  }
  // Returns null when this endpoint belongs to material outside the copied
  // fragment; the caller may keep its separately-computed free endpoint.
  function remapEndpoint(endpoint, resolved) {
    if (!resolved?.ok || !endpoint) return null;
    const out = clone(endpoint), atoms = resolved.atomMap, pairs = resolved.lonePairMap, bonds = resolved.bondMap;
    if (out.type === 'atom') { if (!atoms.has(out.atomId)) return null; out.atomId = atoms.get(out.atomId); }
    else if (out.type === 'radical') { if (!atoms.has(out.ownerAtomId)) return null; out.ownerAtomId = atoms.get(out.ownerAtomId); }
    else if (out.type === 'lonePair') { if (!atoms.has(out.ownerAtomId) || !pairs.has(out.slotId)) return null; out.ownerAtomId = atoms.get(out.ownerAtomId); out.slotId = pairs.get(out.slotId); }
    else if (out.type === 'formingBond') { if (!atoms.has(out.atomA) || !atoms.has(out.atomB)) return null; out.atomA = atoms.get(out.atomA); out.atomB = atoms.get(out.atomB); }
    else if (out.type === 'bond') {
      if (!resolved.session.data.bonds.some(bond => bond.id === out.bondId)) return null;
      if (!bonds.has(out.bondId)) fail('复制箭头依赖的键未能唯一映射');
      out.bondId = bonds.get(out.bondId);
    } else return null;
    if (out.last && resolved.session.transform) out.last = resolved.session.transform(out.last);
    return out;
  }
  MW.documentClipboard = { LIMITS, capture, fromWorkbench, prepareNativeFragment, validate, stage, move, resolve, remapEndpoint };
  if (typeof module === 'object' && module.exports) module.exports = MW.documentClipboard;
})(typeof window === 'object' ? window : globalThis);
