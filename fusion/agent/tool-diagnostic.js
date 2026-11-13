// A small public diagnostic, not an exception dump. Preserve actionable causes
// before bounded lists so model and UI never depend on an arbitrary JSON prefix.
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,160}$/.test(value) && !/^sk[-_]/i.test(value);
const refs = (value, count = 8) => Array.isArray(value) ? [...new Set(value.filter(reference))].slice(0, count) : [];
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function safeReason(value, limit = 420) {
  if (typeof value !== 'string') return '';
  let message = value.split(/\n\s*Received arguments\s*:/i)[0];
  message = message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:api[-_ ]?key|authorization|session[-_ ]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, '[redacted URL]');
  // Raw arguments, exception stacks and JSON belong neither in the UI nor the
  // model's repair hint. Structured fields are copied independently below.
  message = message.split(/\n\s*(?:at\s+|Traceback\b)/)[0].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return message.length > limit ? message.slice(0, limit - 1) + '…' : message;
}

export function compactToolDiagnostic(value) {
  if (!record(value)) return {};
  const out = {};
  for (const key of ['code', 'phase', 'errorName', 'operationType', 'operationId', 'field', 'stepId', 'arrowId',
    'sourceBondId', 'protonAtomId', 'correctTargetAtomId', 'actualTargetAtomId', 'companionArrowId',
    'correctTargetRef', 'protonRef', 'sourceBondRef', 'sourceArrowOperationId']) {
    if (reference(value[key])) out[key] = value[key];
  }
  const reason = safeReason(value.reason || value.message);
  if (reason) out.reason = reason;
  if (typeof value.graphSnapshotDiscarded === 'boolean') out.graphSnapshotDiscarded = value.graphSnapshotDiscarded;
  for (const key of ['sourceEndpoint', 'targetEndpoint']) {
    if (!record(value[key])) continue;
    const endpoint = value[key], item = {};
    for (const name of ['type', 'reason', 'bondId', 'bondRef', 'component', 'lonePairId']) {
      if (reference(endpoint[name])) item[name] = endpoint[name];
    }
    for (const name of ['atomIds', 'atomRefs']) if (Array.isArray(endpoint[name])) item[name] = refs(endpoint[name], 2);
    if (Number.isSafeInteger(endpoint.bondOrder) && endpoint.bondOrder >= 0 && endpoint.bondOrder <= 10) item.bondOrder = endpoint.bondOrder;
    out[key] = item;
  }
  if (Number.isFinite(value.endpointDistance) && value.endpointDistance >= 0 && value.endpointDistance <= 20000) out.endpointDistance = value.endpointDistance;
  for (const key of ['operationIndex', 'atomIndex', 'atomMap', 'expectedVersion', 'actualVersion', 'currentVersion']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  for (const key of ['relatedOperationIds', 'mappedAtomIndices', 'unmappedAtomIndices']) {
    if (!Array.isArray(value[key])) continue;
    out[key] = key === 'relatedOperationIds' ? refs(value[key], 12) : value[key].filter(Number.isSafeInteger).slice(0, 8);
  }
  if (record(value.duplicateAtomMaps)) out.duplicateAtomMaps = Object.fromEntries(Object.entries(value.duplicateAtomMaps)
    .filter(([map, indices]) => /^\d+$/.test(map) && Array.isArray(indices)).slice(0, 6)
    .map(([map, indices]) => [map, indices.filter(Number.isSafeInteger).slice(0, 8)]));
  if (Array.isArray(value.layoutFailures)) {
    out.layoutFailures = value.layoutFailures.filter(record).slice(0, 4).map(item => {
      const failure = {};
      for (const key of ['arrowId', 'operationId', 'code']) if (reference(item[key])) failure[key] = item[key];
      for (const key of ['reasons', 'atomIds', 'bondIds']) if (Array.isArray(item[key])) failure[key] = refs(item[key], 6);
      for (const key of ['intermolecular', 'endpointMovesWithReagent', 'obstacleMovesWithReagent']) {
        if (typeof item[key] === 'boolean') failure[key] = item[key];
      }
      if (record(item.sourceLonePair)) {
        const pair = {};
        for (const key of ['id', 'ownerAtomId', 'refAtomId']) if (reference(item.sourceLonePair[key])) pair[key] = item.sourceLonePair[key];
        if (item.sourceLonePair.refAtomId === null) pair.refAtomId = null;
        if (Number.isFinite(item.sourceLonePair.angle) && Math.abs(item.sourceLonePair.angle) <= 10000) pair.angle = item.sourceLonePair.angle;
        failure.sourceLonePair = pair;
      }
      return failure;
    });
  }
  for (const key of ['missingElectronFlowSteps', 'invalidReactionSteps']) {
    if (!Array.isArray(value[key])) continue;
    out[key] = value[key].filter(record).slice(0, 4).map(step => {
      const item = {};
      for (const name of ['stepId', 'id', 'connectorId', 'operationId']) if (reference(step[name])) item[name] = step[name];
      for (const name of ['version', 'expectedVersion', 'currentVersion']) if (Number.isSafeInteger(step[name]) && step[name] >= 0) item[name] = step[name];
      for (const name of ['missing', 'operationIds', 'reactants', 'products']) if (Array.isArray(step[name])) item[name] = refs(step[name], 6);
      if (typeof step.message === 'string') item.message = safeReason(step.message, 200);
      return item;
    });
  }
  return out;
}

export function compactFailureText(message) {
  if (typeof message !== 'string') return '';
  const clean = message.split(/\n\s*Received arguments\s*:/i)[0].trim();
  try {
    const value = JSON.parse(clean);
    if (record(value)) return JSON.stringify(compactToolDiagnostic(value));
  } catch { /* SDK argument errors are ordinary text, not structured JSON. */ }
  return safeReason(clean, 600);
}
