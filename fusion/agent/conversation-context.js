const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const calls = message => message.role === 'assistant' && Array.isArray(message.content)
  ? message.content.filter(part => part.type === 'toolCall') : [];

// The UI keeps its complete transcript. Model requests keep user constraints
// verbatim, a fresh authoritative canvas, and the latest complete tool exchanges.
// Historical model explanations are not promoted into a chemical fact summary.
export function boundedConversation(messages, { canvas, activeSince = 0, resumeAliases } = {}) {
  const units = [];
  for (let i = 0; i < messages.length; i++) {
    const toolCalls = calls(messages[i]);
    if (!toolCalls.length || ['error', 'aborted', 'length'].includes(messages[i].stopReason)) continue;
    const results = [];
    for (let j = i + 1; j < messages.length && messages[j].role !== 'assistant'; j++) {
      if (messages[j].role === 'toolResult' && toolCalls.some(call => call.id === messages[j].toolCallId)) results.push(j);
    }
    if (toolCalls.every(call => results.some(j => messages[j].toolCallId === call.id))) units.push([i, ...results]);
  }
  const retained = new Set(units.slice(-2).flat());
  // Preserve the recent answer for normal follow-up questions; older answers and
  // thinking remain in local UI history, rather than growing every model request.
  const lastAnswer = messages.findLastIndex(message => message.role === 'assistant' && !calls(message).length &&
    !['error', 'aborted', 'length'].includes(message.stopReason) && message.content?.some(part => part.type === 'text' && part.text.trim()));
  if (lastAnswer >= 0) retained.add(lastAnswer);

  const live = new Set(['atoms', 'bonds', 'lonePairs', 'arrows', 'reactionSteps'].flatMap(key =>
    (canvas?.[key] || []).map(item => item.id ?? item.stepId)));
  const aliases = new Map();
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'draw_operations' || message.isError || !(message.timestamp >= activeSince)) continue;
    for (const part of message.content || []) {
      if (part.type !== 'text') continue;
      let receipt;
      try { receipt = JSON.parse(part.text); } catch { continue; }
      for (const item of receipt.created || []) {
        const entry = { id: item.id, type: item.type };
        if (item.atoms) entry.atoms = item.atoms.filter(atom => live.has(atom.id));
        if (item.bonds) entry.bonds = item.bonds.filter(bond => live.has(bond.id));
        if (item.entityIds) entry.entityIds = item.entityIds.filter(id => live.has(id));
        if (item.stepId && live.has(item.stepId)) entry.stepId = item.stepId;
        if (entry.stepId || entry.atoms?.length || entry.bonds?.length || entry.entityIds?.length) aliases.set(entry.id, entry);
      }
    }
  }
  const current = { ...canvas, ...(resumeAliases && { resumeAliases }),
    ...(aliases.size && { activeOperationAliases: [...aliases.values()] }) };
  const snapshotReference = snapshot => ({
    sessionId: snapshot.sessionId, revision: snapshot.revision, available: snapshot.available,
    counts: Object.fromEntries(['atoms', 'bonds', 'molecules', 'lonePairs', 'arrows', 'reactionSteps']
      .filter(key => Array.isArray(snapshot[key])).map(key => [key, snapshot[key].length])),
    selection: snapshot.selection, resumeAliases: snapshot.resumeAliases, activeOperationAliases: snapshot.activeOperationAliases,
    snapshotOmitted: true,
    currentCanvas: { sessionId: canvas?.sessionId, revision: canvas?.revision,
      source: 'Use the fresh Current canvas context in the system message for current IDs, versions and geometry.' },
  });
  let omittedSnapshots = 0;
  const marker = '\n\nCurrent canvas context (JSON):\n';
  const output = messages.flatMap((message, i) => {
    if (message.role === 'system') {
      if (typeof message.content !== 'string' || !message.content.includes(marker)) return [message];
      return [{ ...message, content: message.content.slice(0, message.content.indexOf(marker)) + marker + JSON.stringify(current) }];
    }
    if (message.role === 'user') return [message];
    if (!retained.has(i)) return [];
    if (message.role === 'toolResult' && !message.isError && ['read_canvas', 'draw_operations'].includes(message.toolName)) {
      return [{ ...message, content: message.content.map(part => {
        if (part.type !== 'text') return part;
        let result;
        try { result = JSON.parse(part.text); } catch { return part; }
        if (message.toolName === 'read_canvas' && Array.isArray(result?.atoms)) {
          omittedSnapshots++; return { ...part, text: JSON.stringify(snapshotReference(result)) };
        }
        if (message.toolName === 'draw_operations' && Array.isArray(result?.canvas?.atoms)) {
          omittedSnapshots++; return { ...part, text: JSON.stringify({ ...result, canvas: snapshotReference(result.canvas) }) };
        }
        return part;
      }) }];
    }
    if (i === lastAnswer && !calls(message).length) return [{ ...message, content: message.content.filter(part => part.type === 'text') }];
    return [message];
  });
  return { messages: output, metrics: { inputMessages: messages.length, outputMessages: output.length,
    inputBytes: bytes(messages), outputBytes: bytes(output), retainedToolExchanges: Math.min(2, units.length),
    userMessages: output.filter(message => message.role === 'user').length, activeAliasOperations: aliases.size, omittedSnapshots } };
}
