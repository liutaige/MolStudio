const shortWarning = value => value.length > 240 ? value.slice(0, 239) + '…' : value;

function modelCreated({ atoms, bonds, entityIds, text, label, ...entry }) {
  if (atoms?.length) entry.atoms = atoms;
  if (bonds?.length) entry.bonds = bonds;
  if (entityIds?.length && !atoms?.length && !bonds?.length) entry.entityIds = entityIds;
  return entry;
}

// The bridge exposes cumulative aliases to local callers. Each model turn only
// needs new or replayed aliases in created, with their atom and bond types.
export function modelDrawReceipt(receipt) {
  return {
    sessionId: receipt.sessionId,
    revision: receipt.revision,
    created: (receipt.created || []).map(modelCreated),
    updated: receipt.updated,
    deleted: receipt.deleted,
    cascaded: receipt.cascaded,
    warnings: receipt.warnings?.map(shortWarning),
    steps: receipt.steps,
    stepMapping: receipt.stepMapping,
    replayed: receipt.replayed,
    canvas: receipt.canvas,
    summary: receipt.summary,
    finishAccepted: receipt.finishAccepted,
    finishRejected: receipt.finishRejected,
    missingElectronFlowSteps: receipt.missingElectronFlowSteps,
    invalidReactionSteps: receipt.invalidReactionSteps,
    completionDiagnostic: receipt.completionDiagnostic,
    phase: receipt.phase,
    taskScope: receipt.taskScope ? { type: receipt.taskScope.type } : undefined,
    finalChatReplyRequired: receipt.finalChatReplyRequired,
    nextAction: receipt.nextAction,
  };
}

export function withoutEchoedDrawArguments(message) {
  if (message.role !== 'toolResult' || message.toolName !== 'draw_operations' || !message.isError) return message;
  let changed = false;
  const content = message.content.map(part => {
    if (part.type !== 'text' || !/^(?:Invalid arguments|Validation failed) for tool "draw_operations":/.test(part.text)) return part;
    const echo = part.text.indexOf('\n\nReceived arguments:\n');
    if (echo < 0) return part;
    changed = true;
    return { ...part, text: part.text.slice(0, echo) };
  });
  return changed ? { ...message, content } : message;
}
