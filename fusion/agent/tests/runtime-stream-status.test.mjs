import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamStatusObserver } from '../stream-status.js';

test('only a complete explicit upstream-error frame emits a safe structured source', () => {
  const failures = [], observe = createStreamStatusObserver(value => failures.push(value));
  const body = 'data: {"choices":[{"delta":{"reasoning_content":"private upstream_stream_error 内容"}}]}\r\n\r\n' +
    'data: {"error":{"message":"private body with key=secret","type":"upstream_error","code":"upstream_stream_error"}}\r\n\r\n';
  for (const byte of new TextEncoder().encode(body)) observe(Uint8Array.of(byte));
  assert.deepEqual(failures, [{ layer: 'upstream', code: 'upstream_stream_error' }]);
  assert.doesNotMatch(JSON.stringify(failures), /private|secret|内容/);
});

test('oversized model text cannot grow status memory or conceal a later error frame', () => {
  const failures = [], observe = createStreamStatusObserver(value => failures.push(value));
  observe(new TextEncoder().encode('data: ' + 'x'.repeat(80000) + '\n\ndata: {"error":{"type":"stream_interrupted"}}\n\n'));
  assert.deepEqual(failures, [{ layer: 'gateway', code: 'stream_interrupted' }]);
});

test('incomplete or unknown error frames do not invent a failure source', () => {
  const failures = [], observe = createStreamStatusObserver(value => failures.push(value));
  observe(new TextEncoder().encode('data: {"error":{"type":"unrecognized","message":"private"}}\n\n'));
  observe(new TextEncoder().encode('data: {"error":{"code":"upstream_stream_error"}}\n'));
  assert.deepEqual(failures, []);
});
