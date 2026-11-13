import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMessage } from '../message-render.js';

test('bare chemistry from the actual final report renders through existing restricted math', () => {
  const text = '得到质子化的醛（\\ce{CH3CH=O+H}），最终反应为 \\ce{CH3CHO + CH3OH -> CH3CH(OH)OCH3}。';
  const html = renderMessage(text);
  assert.equal((html.match(/<math\b/g) || []).length, 2);
  assert.match(html, /<msub>|<msubsup>/);
  assert.doesNotMatch(html, /katex-error/);
});

test('nested mhchem braces, existing math and escaped literals retain their boundaries', () => {
  const html = renderMessage('裸写 \\ce{H_{2}O}；已有 $\\ce{H3O+}$；括号 \\(\\ce{OH-}\\)；字面量 \\\\ce{H2O}。');
  assert.equal((html.match(/<math\b/g) || []).length, 3);
  assert.match(html, /字面量 \\ce\{H2O\}/);
  assert.doesNotMatch(html, /katex-error/);
});

test('chemistry examples inside inline and fenced code remain literal', () => {
  const tick = String.fromCharCode(96);
  const html = renderMessage(tick + '\\ce{H2O}' + tick + '\n\n' + tick.repeat(3) + 'text\n\\ce{OH-}\n' + tick.repeat(3));
  assert.equal((html.match(/<math\b/g) || []).length, 0);
  assert.match(html, /<code>\\ce\{H2O\}<\/code>/);
  assert.match(html, /<pre><code[^>]*>\\ce\{OH-\}/);
});

test('incomplete macros stay visible and rendering does not activate unsafe HTML or links', () => {
  assert.match(renderMessage('未完成 \\ce{CH3CH(OH)'), /\\ce\{CH3CH\(OH\)/);
  const html = renderMessage('<script>alert(1)</script> \\ce{H2O} [bad](javascript:alert(1))');
  assert.doesNotMatch(html, /<script|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/<math\b/g) || []).length, 1);
});
