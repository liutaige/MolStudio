// Read-only status observation alongside the SDK reader. No messages or model
// text leave this bounded parser; only known stream-error identifiers do.
export function createStreamStatusObserver(onFailure) {
  const decoder = new TextDecoder(), limit = 16384;
  let line = '', data = '', longLine = false, longEvent = false, afterCR = false;
  const flushLine = () => {
    if (!longLine && line === '') {
      if (!longEvent && data) {
        try {
          const error = JSON.parse(data)?.error;
          if (error?.code === 'upstream_stream_error') onFailure({ layer: 'upstream', code: 'upstream_stream_error' });
          else if (error?.type === 'stream_interrupted') onFailure({ layer: 'gateway', code: 'stream_interrupted' });
        } catch { /* Non-JSON frames and observer failures never change transport. */ }
      }
      data = ''; longEvent = false;
    } else if (longLine) longEvent = true;
    else if (!longEvent && line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      if (data.length + value.length + 1 > limit) { data = ''; longEvent = true; }
      else data += (data ? '\n' : '') + value;
    }
    line = ''; longLine = false;
  };
  return chunk => {
    const text = decoder.decode(chunk, { stream: true }); let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      if (afterCR) { afterCR = false; if (char === 10) { start = i + 1; continue; } }
      if (char !== 10 && char !== 13) continue;
      if (!longLine && line.length + i - start <= limit) line += text.slice(start, i);
      else { line = ''; longLine = true; }
      flushLine(); afterCR = char === 13; start = i + 1;
    }
    if (!longLine && line.length + text.length - start <= limit) line += text.slice(start);
    else { line = ''; longLine = true; }
  };
}
