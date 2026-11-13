// Use only for the reserved final-report phase. Drafts remain in the model
// transcript; the host publishes one completed draft after its phase commits.
export function createFinalReportBuffer() {
  let active = null, completed = null, closed = false, serial = 0;
  return {
    startMessage(messageId) {
      if (closed) return false;
      active = { messageId: typeof messageId === 'string' ? messageId : `final-report-${++serial}`, text: '' };
      return true;
    },
    append(delta) {
      if (closed || !active || typeof delta !== 'string') return false;
      active.text += delta;
      return true;
    },
    endMessage() {
      if (closed || !active) return false;
      if (active.text.trim()) completed = active;
      active = null;
      return true;
    },
    hasReport() { return !closed && !active && completed !== null; },
    publish() {
      if (closed || active || !completed) return null;
      closed = true;
      const result = { ...completed };
      completed = null;
      return result;
    },
    cancel() {
      closed = true;
      active = null;
      completed = null;
    },
  };
}
