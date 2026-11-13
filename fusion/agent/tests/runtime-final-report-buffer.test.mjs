import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinalReportBuffer } from '../final-report-buffer.js';

test('two completed report drafts publish only the latest text once after host acceptance', () => {
  const buffer = createFinalReportBuffer();
  assert.equal(buffer.hasReport(), false);
  buffer.startMessage('first'); buffer.append('第一版完整报告。'); buffer.endMessage();
  assert.equal(buffer.hasReport(), true);
  buffer.startMessage('revised'); buffer.append('第二版'); buffer.append('完整报告。'); buffer.endMessage();
  assert.deepEqual(buffer.publish(), { messageId: 'revised', text: '第二版完整报告。' });
  assert.equal(buffer.hasReport(), false);
  assert.equal(buffer.publish(), null);
  assert.equal(buffer.startMessage('late'), false); assert.equal(buffer.append('迟到文本'), false);
  assert.equal(buffer.endMessage(), false); assert.equal(buffer.publish(), null);
});

test('a final tool-only message retains the latest completed nonempty report without adding text', () => {
  const buffer = createFinalReportBuffer();
  buffer.startMessage('report'); buffer.append('已完成报告。'); buffer.endMessage();
  buffer.startMessage('complete-phase-tool'); buffer.endMessage();
  assert.equal(buffer.hasReport(), true);
  assert.deepEqual(buffer.publish(), { messageId: 'report', text: '已完成报告。' });
});

test('unicode and arbitrary chunks are joined exactly, with draft whitespace preserved', () => {
  const buffer = createFinalReportBuffer(), text = '  最后说明：\n甲醇进攻 🙂，形成 \\ce{C-O}。\n';
  buffer.startMessage('unicode');
  for (let index = 0; index < text.length; index++) buffer.append(text[index]);
  buffer.endMessage();
  assert.equal(buffer.publish().text, text);
});

test('unfinished or empty assistant text cannot publish a final report', () => {
  const buffer = createFinalReportBuffer();
  assert.equal(buffer.publish(), null); assert.equal(buffer.append('no active message'), false);
  buffer.startMessage('empty'); buffer.append(' \n\t'); buffer.endMessage();
  assert.equal(buffer.publish(), null);
  buffer.startMessage('complete'); buffer.append('先前已结束的报告'); buffer.endMessage();
  buffer.startMessage('unfinished'); buffer.append('尚未完整接收');
  assert.equal(buffer.hasReport(), false);
  assert.equal(buffer.publish(), null, 'an active newer message must be ended or cancelled by the host');
  buffer.endMessage(); assert.equal(buffer.publish().text, '尚未完整接收');
});

test('cancelled or interrupted final phases discard every draft and cannot publish later', () => {
  const buffer = createFinalReportBuffer();
  buffer.startMessage('completed-draft'); buffer.append('尚未通过宿主核对'); buffer.endMessage();
  buffer.startMessage('interrupted'); buffer.append('未完成的改稿'); buffer.cancel();
  assert.equal(buffer.hasReport(), false);
  assert.equal(buffer.publish(), null); assert.equal(buffer.endMessage(), false);
  assert.equal(buffer.startMessage('late-message'), false);
  buffer.cancel(); assert.equal(buffer.publish(), null);
});

test('separate final-report buffers do not share phase state or mutate returned reports', () => {
  const first = createFinalReportBuffer(), second = createFinalReportBuffer();
  first.startMessage(); first.append('第一项任务'); first.endMessage();
  const report = first.publish(); first.cancel();
  assert.equal(report.text, '第一项任务'); assert.equal(second.publish(), null);
  second.startMessage('other'); second.append('第二项任务'); second.endMessage();
  assert.deepEqual(second.publish(), { messageId: 'other', text: '第二项任务' });
});
