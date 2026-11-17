/**
 * document-rich-text 纯逻辑模块测试。
 * 运行：node --test fusion/tests/test_document_rich_text.cjs（在仓库根目录）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const rt = require('../workbench/document-rich-text.js');

const doc = new JSDOM('<!doctype html><body></body>').window.document;

function segsText(list) { return list.map(s => s.text).join(''); }

// ---------- normalizeRuns / validateRuns ----------
test('normalizeRuns: 排序、重叠取先者截断、合并同格式、剔除空', () => {
  const text = 'abcdef';
  const out = rt.normalizeRuns([
    { start: 3, end: 6, bold: true },
    { start: 0, end: 4, bold: true },
    { start: 2, end: 4, bold: true },
    { start: 5, end: 5, bold: true },
    { start: 6, end: 7, bold: true },
  ], text);
  // 同格式相邻合并为一条；截断后 [0,4] 与 [4,6] 同格式连成 [0,6]
  assert.deepStrictEqual(out, [{ start: 0, end: 6, bold: true }]);
});

test('normalizeRuns: 同格式相邻合并、不同格式保留', () => {
  const text = 'abcd';
  const out = rt.normalizeRuns([
    { start: 0, end: 2, bold: true },
    { start: 2, end: 4, bold: true },
    { start: 1, end: 3, italic: true },
  ], text);
  // italic run 与 bold 重叠：先者截断 -> bold[0,2] 保留，italic 截为 [2,3]，bold[2,4] 截为 [3,4]
  assert.deepStrictEqual(out, [
    { start: 0, end: 2, bold: true },
    { start: 2, end: 3, italic: true },
    { start: 3, end: 4, bold: true },
  ]);
});

test('validateRuns: 合法 runs 通过', () => {
  const r = rt.validateRuns([{ start: 0, end: 2, bold: true, color: '#ff0000', fontSize: 8, fontFamily: 'Arial, "PingFang SC"' }], 'abc');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.errors, []);
});

test('validateRuns: 边界与非法值拒绝（中文错误、有界）', () => {
  const text = 'abc';
  const bad = [
    { start: -1, end: 2 },
    { start: 1, end: 1 },
    { start: 0, end: 4 },
    { start: 0, end: 1, bold: 'yes' },
    { start: 0, end: 1, color: 'purple' },
    { start: 0, end: 1, color: 'javascript:alert(1)' },
    { start: 0, end: 1, fontSize: 1 },
    { start: 0, end: 1, fontSize: 999 },
    { start: 0, end: 1, fontFamily: '<script>' },
    { start: 0, end: 1, fontFamily: '' },
    { start: 0, end: 1, url: 'http://x' },
    'not-an-object',
  ];
  const r = rt.validateRuns(bad, text);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.length <= 32);
  for (const e of r.errors) assert.ok(/[\u4e00-\u9fff]/.test(e), '错误消息应为中文: ' + e);
});

test('validateRuns: 超过 512 条上限拒绝', () => {
  const runs = [];
  for (let i = 0; i < 513; i++) runs.push({ start: 0, end: 1, bold: true });
  const r = rt.validateRuns(runs, 'ab');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length <= 32);
  const okRuns = [];
  for (let i = 0; i < 512; i++) okRuns.push({ start: i, end: i + 1, bold: true });
  assert.strictEqual(rt.validateRuns(okRuns, 'ab'.repeat(512)).ok, true);
});

test('H2O / SO4^2- 场景: sub/sup 混排 runs 构造与 segments 逐字还原', () => {
  const rich = { text: 'H2O + SO42- 离子', fontSize: 12, color: '#1c1c1e', runs: [
    { start: 1, end: 2, sub: true },
    { start: 7, end: 9, sup: true, fontSize: 8 },
  ] };
  const v = rt.validateRuns(rich.runs, rich.text);
  assert.strictEqual(v.ok, true);
  const segs = rt.segments(rich);
  assert.strictEqual(segsText(segs), rich.text);
  // 逐字偏移连续无缝
  for (let i = 0; i < segs.length; i++) {
    assert.strictEqual(segs[i].start, i === 0 ? 0 : segs[i - 1].end);
    assert.strictEqual(segs[i].end - segs[i].start, segs[i].text.length);
  }
  assert.strictEqual(segs[1].sub, true);           // H2O 的 2
  assert.strictEqual(segs[0].sub, undefined);
  assert.strictEqual(segs[3].sup, true);           // SO4^2 的 2
  assert.strictEqual(segs[3].fontSize, 8);
  assert.strictEqual(segs[4].sup, undefined);      // "-" 不带 sup
});

// ---------- applyFormat ----------
test('applyFormat: 切开选区并合并 patch', () => {
  const rich = { text: 'hello world', fontSize: 12 };
  const out = rt.applyFormat(rich, { start: 6, end: 11 }, { bold: true, color: 'red' });
  assert.strictEqual(out.text, 'hello world');
  assert.deepStrictEqual(out.runs, [
    { start: 6, end: 11, bold: true, color: 'red' },
  ]);
  // 与已有 run 边界对齐
  const out2 = rt.applyFormat(out, { start: 6, end: 8 }, { color: '#00ff00' });
  assert.deepStrictEqual(out2.runs, [
    { start: 6, end: 8, bold: true, color: '#00ff00' },
    { start: 8, end: 11, bold: true, color: 'red' },
  ]);
});

test('applyFormat: 显式关（false）与清除（undefined）语义', () => {
  const rich = { text: 'abcdef', bold: false };
  const bolded = rt.applyFormat(rich, { start: 0, end: 6 }, { bold: true });
  // 显式关：保留显式 false
  const off = rt.applyFormat(bolded, { start: 2, end: 4 }, { bold: false });
  assert.deepStrictEqual(off.runs, [
    { start: 0, end: 2, bold: true },
    { start: 2, end: 4, bold: false },
    { start: 4, end: 6, bold: true },
  ]);
  assert.strictEqual(rt.formatAt(off, 1).bold, true);
  assert.strictEqual(rt.formatAt(off, 3).bold, false);
  // 清除：undefined 移除显式值，恢复整框默认
  const cleared = rt.applyFormat(off, { start: 2, end: 4 }, { bold: undefined });
  assert.deepStrictEqual(cleared.runs, [
    { start: 0, end: 2, bold: true },
    { start: 4, end: 6, bold: true },
  ]);
  assert.strictEqual(rt.formatAt(cleared, 3).bold, false);
  // 清除无 run 覆盖的区间是 no-op
  const noop = rt.applyFormat(rich, { start: 0, end: 6 }, { bold: undefined });
  assert.deepStrictEqual(noop.runs, []);
});

test('formatAt: 边界偏移与继承', () => {
  const rich = { text: 'xyz', fontSize: 12, italic: true, runs: [{ start: 1, end: 2, bold: true }] };
  assert.deepStrictEqual(rt.formatAt(rich, 0), { fontSize: 12, italic: true });
  assert.deepStrictEqual(rt.formatAt(rich, 1), { fontSize: 12, italic: true, bold: true });
  assert.deepStrictEqual(rt.formatAt(rich, 2), { fontSize: 12, italic: true });
  assert.deepStrictEqual(rt.formatAt(rich, 3), { fontSize: 12, italic: true });
});

// ---------- buildEditorDom / readEditorDom 往返 ----------
const pxPerPt = 4;

test('往返: 整框样式', () => {
  const rich = { text: '整框样式 Text', fontFamily: 'Arial, "PingFang SC", sans-serif', fontSize: 14, bold: true, italic: true, color: '#112233' };
  const el = rt.buildEditorDom(rich, doc, pxPerPt);
  assert.strictEqual(el.tagName, 'DIV');
  const back = rt.readEditorDom(el, rich, pxPerPt);
  assert.strictEqual(back.text, rich.text);
  assert.strictEqual(back.runs.length, 0); // 与整框默认一致则无显式 runs
});

test('往返: 部分加粗与颜色', () => {
  const rich = { text: '普通加粗部分', fontSize: 12 };
  const withRuns = rt.applyFormat(rich, { start: 2, end: 5 }, { bold: true, color: 'blue' });
  const el = rt.buildEditorDom(withRuns, doc, pxPerPt);
  const back = rt.readEditorDom(el, withRuns, pxPerPt);
  assert.strictEqual(back.text, withRuns.text);
  assert.deepStrictEqual(back.runs, withRuns.runs);
});

test('往返: 上下标（H2O / SO4^2-）', () => {
  const rich = { text: 'H2O + SO42-', fontSize: 12, runs: [
    { start: 1, end: 2, sub: true },
    { start: 8, end: 10, sup: true, fontSize: 8 },
  ] };
  const el = rt.buildEditorDom(rich, doc, pxPerPt);
  assert.ok(el.querySelector('sub'), '下标应使用 sub 标签');
  assert.ok(el.querySelector('sup'), '上标应使用 sup 标签');
  const back = rt.readEditorDom(el, rich, pxPerPt);
  assert.strictEqual(back.text, rich.text);
  assert.deepStrictEqual(back.runs, rich.runs);
});

test('往返: 多段 \\n 与 pxPerPt 换算', () => {
  const rich = { text: '第一段\n\n第三段', fontSize: 12, runs: [{ start: 0, end: 3, bold: true }] };
  const el = rt.buildEditorDom(rich, doc, pxPerPt);
  assert.strictEqual(el.querySelectorAll('br').length, 2);
  const back = rt.readEditorDom(el, rich, pxPerPt);
  assert.strictEqual(back.text, rich.text);
  assert.deepStrictEqual(back.runs, rich.runs);
  // pxPerPt 换算：fontSize 8pt @ pxPerPt=2 -> 16px -> 读回 8pt
  const rich2 = { text: '字号', fontSize: 12, runs: [{ start: 0, end: 2, fontSize: 8 }] };
  const back2 = rt.readEditorDom(rt.buildEditorDom(rich2, doc, 2), rich2, 2);
  assert.deepStrictEqual(back2.runs, rich2.runs);
  // span 内联样式确实使用 px 值 = pt * pxPerPt
  const span = rt.buildEditorDom(rich2, doc, 2).querySelector('span');
  assert.strictEqual(span.style.getPropertyValue('font-size'), '16px');
});

test('readEditorDom: b/i/u/标签与 span style 混合可读回', () => {
  const div = doc.createElement('div');
  const b = doc.createElement('b'); b.textContent = '加粗';
  const i = doc.createElement('i'); i.textContent = '斜体';
  const span = doc.createElement('span');
  span.style.setProperty('color', '#ff0000');
  span.style.setProperty('font-size', (13 * pxPerPt) + 'px');
  span.style.setProperty('font-weight', '700');
  span.style.setProperty('text-decoration', 'underline');
  span.textContent = '样式';
  div.append(b, doc.createElement('br'), span, i);
  const base = { text: '', fontSize: 12 };
  const back = rt.readEditorDom(div, base, pxPerPt);
  assert.strictEqual(back.text, '加粗\n样式斜体');
  const byStart = back.runs.map(r => [r.start, r.end, r]);
  assert.deepStrictEqual(byStart[0].slice(0, 2), [0, 2]);
  assert.strictEqual(byStart[0][2].bold, true);
  const styleRun = back.runs.find(r => r.start === 3);
  assert.ok(styleRun);
  assert.strictEqual(styleRun.color, '#ff0000');
  assert.strictEqual(styleRun.bold, true);
  assert.strictEqual(styleRun.underline, true);
  assert.strictEqual(styleRun.fontSize, 13);
  const italicRun = back.runs.find(r => r.start === 5);
  assert.ok(italicRun && italicRun.italic === true);
});

// ---------- layoutLines ----------
test('layoutLines: 与 textLines 公式一致（同输入对照）', () => {
  const ptPerBond = 10;
  const object = { rich: { text: '化学结构与机理排版测试 Chemical structure layout', fontSize: 12, lineHeight: 1.4 }, w: 30 };
  const fs = object.rich.fontSize / ptPerBond;
  const chars = Math.max(1, Math.floor(object.w / (fs * 0.55)));
  const expected = [];
  for (const paragraph of object.rich.text.split('\n')) {
    if (!paragraph) { expected.push(''); continue; }
    let line = '', n = 0;
    for (const ch of paragraph) { const u = /[^\x00-\xff]/.test(ch) ? 2 : 1; if (n && n + u > chars) { expected.push(line); line = ''; n = 0; } line += ch; n += u; }
    expected.push(line);
  }
  const out = rt.layoutLines(object.rich, object.w, object.rich.fontSize / ptPerBond);
  assert.deepStrictEqual(out.lines.map(l => l.text), expected);
  assert.strictEqual(out.heights, fs + (expected.length - 1) * fs * 1.4 + fs * 0.3);
  // segments 覆盖全文本且格式段偏移与 runs 对齐
  const rich2 = { text: 'AABB中文长文本\n第二行', fontSize: 12, runs: [{ start: 2, end: 4, bold: true }] };
  const out2 = rt.layoutLines(rich2, 4, 12 / 5);
  const flat = out2.lines.flatMap(l => l.segments.map(s => s.text)).join('');
  assert.strictEqual(flat, rich2.text.replace('\n', ''));
});

test('layoutLines: 中文断行、\\n、空段、自定义 measure', () => {
  const rich = { text: '你好世界\n\n尾', fontSize: 12 };
  const out = rt.layoutLines(rich, 20, 10); // chars = floor(20/5.5) = 3 -> CJK 宽2，每行最多 1 字
  assert.deepStrictEqual(out.lines.map(l => l.text), ['你', '好', '世', '界', '', '尾']);
  const rich2 = { text: 'aaaa', fontSize: 12 };
  const out2 = rt.layoutLines(rich2, 20, 10); // chars=3, ASCII 宽1
  assert.deepStrictEqual(out2.lines.map(l => l.text), ['aaa', 'a']);
  const out3 = rt.layoutLines(rich2, 20, 10, () => 2); // 自定义 measure：宽2 -> chars=3，每行只能放 1 个字符
  assert.deepStrictEqual(out3.lines.map(l => l.text), ['a', 'a', 'a', 'a']);
  // lineHeight 参数覆盖 rich.lineHeight
  const h1 = rt.layoutLines(rich, 20, 10, null, 2).heights;
  const h2 = rt.layoutLines(rich, 20, 10, null, 1).heights;
  const fs = 10, n = 6;
  assert.strictEqual(h1, fs + (n - 1) * fs * 2 + fs * 0.3);
  assert.strictEqual(h2, fs + (n - 1) * fs * 1 + fs * 0.3);
});

test('layoutLines: 行内 segments 保留 run 格式且偏移正确', () => {
  const rich = { text: 'bold部分normal', fontSize: 12, runs: [{ start: 0, end: 4, bold: true }] };
  const out = rt.layoutLines(rich, 40, 12);
  const all = out.lines.flatMap(l => l.segments);
  assert.strictEqual(all.map(s => s.text).join(''), 'bold部分normal');
  assert.strictEqual(all[0].bold, true);
  assert.strictEqual(all[1].bold, undefined);
  assert.strictEqual(all[0].start, 0);
  assert.strictEqual(all[all.length - 1].end, rich.text.length);
});

// ---------- sanitizeClipboardFragment ----------
test('sanitizeClipboardFragment: 丢弃 script/style/img 及恶意属性', () => {
  const html = '<div id="src">' +
    '<script>window.evil = 1;</scr' + 'ipt>' +
    '<style>body { display: none; }</style>' +
    '<img src="http://evil/x.png" alt="x">' +
    '<a href="javascript:alert(1)">链接文字丢弃</a>' +
    '<span style="color: #ff0000; font-size: 24px; background-image: url(http://evil/bg)">安全<span>' +
    '</div>';
  const host = doc.createElement('div');
  host.innerHTML = html;
  const out = rt.sanitizeClipboardFragment(host.querySelector('#src'), doc, pxPerPt);
  assert.strictEqual(out.text, '安全');
  assert.strictEqual(out.runs.length, 1);
  assert.strictEqual(out.runs[0].color, '#ff0000');
  assert.strictEqual(out.runs[0].fontSize, 6);
  assert.ok(!JSON.stringify(out).includes('http://evil'));
  assert.ok(!JSON.stringify(out).includes('evil'));
});

test('sanitizeClipboardFragment: 合法标签与样式保留，非法颜色/字号剔除', () => {
  const host = doc.createElement('div');
  host.innerHTML = '<div id="src"><b>粗</b><i>斜</i><u>下</u><sub>sub</sub><sup>sup</sup>' +
    '<span style="color: green;">绿色</span>' +
    '<span style="color: expression(alert(1)); font-size: 500px;">丢弃</span>' +
    '<br><p><strong>段</strong></p></div>';
  const src = host.querySelector('#src');
  const out = rt.sanitizeClipboardFragment(src, doc, 2);
  // BR 换行 + P 块边界，与 readEditorDom 的块语义一致（块边界不再丢失也不再翻倍叠加）
  assert.strictEqual(out.text, '粗斜下subsup绿色丢弃\n\n段');
  const colors = out.runs.filter(r => r.color === 'green');
  assert.strictEqual(colors.length, 1);
  assert.strictEqual(colors[0].start, 9);
  assert.strictEqual(colors[0].end, 11);
  const bad = out.runs.filter(r => typeof r.color === 'string' && r.color.includes('expression'));
  assert.strictEqual(bad.length, 0);
  assert.ok(out.runs.every(r => r.fontSize === undefined || (r.fontSize >= 2 && r.fontSize <= 300)));
  assert.ok(out.runs.some(r => r.bold === true));
  assert.ok(out.runs.some(r => r.sub === true));
  assert.ok(out.runs.some(r => r.sup === true));
  assert.ok(out.runs.some(r => r.italic === true));
  assert.ok(out.runs.some(r => r.underline === true));
});

// ---------- sanitizeClipboardFragment 块级换行（D3 回归） ----------
test('sanitizeClipboardFragment: 块级标签保留换行，开头不补空行且连续边界折叠为一行', () => {
  const host = doc.createElement('div');
  host.innerHTML = '<div id="src"><p>Hello</p><p>World</p></div>';
  const out = rt.sanitizeClipboardFragment(host.querySelector('#src'), doc, pxPerPt);
  assert.strictEqual(out.text, 'Hello\nWorld');
  assert.deepStrictEqual(out.runs, []);
  // H1-H6/LI/BLOCKQUOTE/PRE 同样是块边界；连续边界（空 div、块结束+块开始）只折一行
  host.innerHTML = '<div id="src"><h1>标题</h1><div><div></div></div>' +
    '<ul><li>甲</li><li>乙</li></ul><blockquote>引用<p>内段</p></blockquote><pre>code</pre></div>';
  const mixed = rt.sanitizeClipboardFragment(host.querySelector('#src'), doc, pxPerPt);
  assert.strictEqual(mixed.text, '标题\n甲\n乙\n引用\n内段\ncode');
  // 空块的 caret 占位 BR 与 readEditorDom 一样不重复计数：块序列间恰好一个空行
  host.innerHTML = '<div id="src"><p>a</p><p><br></p><p>b</p></div>';
  const blank = rt.sanitizeClipboardFragment(host.querySelector('#src'), doc, pxPerPt);
  assert.strictEqual(blank.text, 'a\n\nb');
  // 尾随块边界被丢弃，显式 BR 换行保留
  host.innerHTML = '<div id="src">行<br>text<br></div>';
  const br = rt.sanitizeClipboardFragment(host.querySelector('#src'), doc, pxPerPt);
  assert.strictEqual(br.text, '行\ntext\n');
});

// ---------- 兼容辅助 ----------
test('applyToPlainRich / plainFromText', () => {
  const rich = { text: 't', fontSize: 12, runs: [{ start: 0, end: 1, bold: true }] };
  const plain = rt.applyToPlainRich(rich);
  assert.deepStrictEqual(plain, { text: 't', fontSize: 12 });
  assert.deepStrictEqual(rt.plainFromText('新文本'), { text: '新文本', runs: [] });
  assert.deepStrictEqual(rt.plainFromText(undefined), { text: '', runs: [] });
});

// Browser-authored paragraph and selection offset regressions.
function readEditorFixture(html,base={text:'',fontSize:12}){const div=doc.createElement('div');div.innerHTML=html;return rt.readEditorDom(div,base,1);}
test('Enter block boundaries separate text without adding a final newline',()=>{
  for(const [html,text] of [['base<div>second</div>','base\nsecond'],['<div>base</div><div>second</div>','base\nsecond'],['a<div>b</div>c','a\nb\nc'],['a<p>b</p>','a\nb']])assert.equal(readEditorFixture(html).text,text,html);
});
test('sole BR placeholders preserve the number of Enter keys and empty lines',()=>{
  for(const [html,text] of [['base<div><br></div>','base\n'],['base<div><br></div><div><br></div>','base\n\n'],['base<div><br></div><div>second</div>','base\n\nsecond'],['<div><br></div><div>second</div>','\nsecond'],['<div><br></div>','']])assert.equal(readEditorFixture(html).text,text,html);
});
test('run boundaries include the inserted block separator',()=>{
 const result=readEditorFixture('a<div><b>bc</b></div>');assert.equal(result.text,'a\nbc');assert.deepEqual(result.runs,[{start:2,end:4,bold:true}]);
});
test('ordinary BR sequences still round trip explicitly stored newlines',()=>{
 for(const text of ['a\n','a\n\n','\n','\n\nb','']){const rich={text,fontSize:12};assert.equal(rt.readEditorDom(rt.buildEditorDom(rich,doc,1),rich,1).text,text);}
});
test('CSSOM font-family quotation cannot dirty an untouched draft',()=>{
 const rich={text:'base',fontFamily:'Arial, PingFang SC, sans-serif',fontSize:12};assert.deepEqual(rt.readEditorDom(rt.buildEditorDom(rich,doc,1),rich,1),{text:'base',runs:[]});
 assert.deepEqual(readEditorFixture('base',rich),{text:'base',runs:[]});
});
test('a different font-family remains a persisted run',()=>{
 const rich={text:'base',fontFamily:'Arial, PingFang SC, sans-serif',fontSize:12};const result=readEditorFixture('<span style="font-family: monospace">base</span>',rich);assert.deepEqual(result.runs,[{start:0,end:4,fontFamily:'monospace'}]);
});
test('styled inline wrappers around the sole caret BR are still placeholders',()=>{
 assert.equal(readEditorFixture('base<div><span style="color:red"><br></span></div>').text,'base\n');
 assert.equal(readEditorFixture('base<div><span><b><br></b></span></div><div>second</div>').text,'base\n\nsecond');
});
test('DOM offsets count BR and block separators and preserve the live DOM',()=>{
 for(const html of ['first<br>second','first<div>second</div>','<div>first</div><div>second</div>']){
  const div=doc.createElement('div');div.innerHTML=html;const last=div.lastChild.nodeType===3?div.lastChild:div.lastChild.firstChild;const before=div.outerHTML;
  assert.equal(rt.editorTextOffset(div,last,0),6,html);assert.equal(rt.editorTextOffset(div,last,6),12,html);
  assert.equal(rt.editorTextOffset(div,div,div.childNodes.length),12,html);assert.equal(div.outerHTML,before);
 }
});
test('DOM element boundary offsets distinguish a line end from the next line start',()=>{
 const div=doc.createElement('div');div.innerHTML='a<div>b</div>';
 assert.equal(rt.editorTextOffset(div,div,1),1);assert.equal(rt.editorTextOffset(div,div.lastChild,0),2);assert.equal(rt.editorTextOffset(div,div.lastChild,1),3);assert.equal(rt.editorTextOffset(div,div,2),3);
});
test('DOM offsets inside empty placeholder blocks map to their empty line',()=>{
 const div=doc.createElement('div');div.innerHTML='a<div><span><br></span></div><div>c</div>';
 const empty=div.children[0],span=empty.firstChild;
 assert.equal(rt.readEditorDom(div,{},1).text,'a\n\nc');
 for(const [node,offset] of [[empty,0],[empty,1],[span,0],[span,1]])assert.equal(rt.editorTextOffset(div,node,offset),2);
 assert.equal(rt.editorTextOffset(div,div.lastChild.firstChild,0),3);
 assert.equal(rt.editorTextOffset(div,doc.createElement('div'),0),null);
});

test('large font runs supply the first baseline and total height instead of the object base size', () => {
  const rich = { text: 'large', fontSize: 12, runs: [{ start: 0, end: 5, fontSize: 28 }] };
  const layout = rt.layoutLines(rich, 200, 12);
  assert.equal(layout.lines[0].fontSize, 28);
  assert.equal(layout.lines[0].baseline, 28);
  assert.equal(layout.heights, 28 * 1.3);
});
test('increasing a run font size makes it wrap within the available width', () => {
  const text = 'size grows and wraps';
  const plain = rt.layoutLines({ text, fontSize: 12 }, 60, 12);
  const enlarged = rt.layoutLines({ text, fontSize: 12, runs: [{ start: 0, end: text.length, fontSize: 28 }] }, 60, 12);
  assert.ok(enlarged.lines.length > plain.lines.length);
  assert.ok(enlarged.lines.every(line => line.text.length * 28 * .55 <= 60));
  assert.equal(enlarged.lines.map(line => line.text).join(''), text);
});
test('mixed font-size lines use their own baseline and do not overlap at normal line spacing', () => {
  const layout = rt.layoutLines({ text: 'small\nBIG\nsmall', fontSize: 12, lineHeight: 1.4, runs: [{ start: 6, end: 9, fontSize: 28 }] }, 200, 12);
  assert.deepEqual(layout.lines.map(line => line.fontSize), [12, 28, 12]);
  for (let i = 1; i < layout.lines.length; i++) {
    const previous = layout.lines[i - 1], current = layout.lines[i];
    assert.ok(current.baseline - current.fontSize >= previous.baseline + previous.fontSize * .3);
  }
  assert.equal(layout.heights, layout.lines.at(-1).baseline + 12 * .3);
});

test('ordinary multi-line run metrics preserve the exact legacy height arithmetic', () => {
  const text = Array(25).fill('same size').join('\n'), fs = 12 / 14.4, lh = 1.4;
  const layout = rt.layoutLines({ text, fontSize: 12, lineHeight: lh, runs: [{ start: 0, end: text.length, bold: true }] }, 50, fs);
  assert.equal(layout.heights, fs + 24 * fs * lh + fs * .3);
  assert.equal(layout.lines[24].baseline, fs + 24 * fs * lh);
});
