import MarkdownIt from 'markdown-it';
import { katex } from '@mdit/plugin-katex';
import '@mdit/plugin-katex/mhchem';

const markdown = new MarkdownIt({ html: false, breaks: true }).use(katex, {
  delimiters: 'all',
  mathFence: true,
  output: 'mathml',
  trust: false,
  maxSize: 10,
  maxExpand: 1000,
});

// Models sometimes return mhchem directly in prose. Parse it as an inline
// token so code spans/fences and existing math retain their normal boundaries.
// Reuse the same restricted KaTeX renderer instead of rewriting model text.
markdown.inline.ruler.before('escape', 'bare_mhchem', (state, silent) => {
  const start = state.pos;
  if (silent || !state.src.startsWith('\\ce{', start)) return false;
  let depth = 1, end = start + 4;
  for (; end < state.posMax; end++) {
    const char = state.src[end];
    if (char === '\\') { end++; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) break;
  }
  if (depth !== 0 || end === start + 4) return false;
  const token = state.push('math_inline', 'math', 0);
  token.markup = '\\ce';
  token.content = state.src.slice(start, end + 1);
  state.pos = end + 1;
  return true;
});

markdown.validateLink = url => /^https?:\/\//i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const link = tokens[index];
  link.attrSet('target', '_blank');
  link.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Show alt text without loading resources selected by the model.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export function renderMessage(text) {
  return markdown.render(text);
}
