#!/usr/bin/env node
'use strict';

// Ketcher 3.18: keep its clipboard serializers, selection semantics, and PasteTool.
// WKWebView exposes async Clipboard methods that reject even during a trusted paste
// event. The host opts into Ketcher's existing event-data (legacy/Safari) handlers.
// Only Copy/Cut/their dropdown recognise an external arrow selection. Other tools
// continue to use Ketcher's own selection predicate.
//
// Reapply after replacing this pinned upstream bundle:
//   node fusion/patch-ketcher-clipboard.cjs
// Both exact before/after anchors and the original SHA-256 are checked. An upstream
// upgrade or partial application fails before any file is written; reruns are safe.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const bundlePath = path.resolve(__dirname, '../ketcher-local/static/js/main.e47c48ad.js');
const upstreamSha256 = 'b8716a39486e7259e7c2cfcd29278044768d22cb60018589b1d5c1175c27f583';
const preferEvents = '(window.molstudioClipboard&&window.molstudioClipboard.preferEvents)';
const externalSelection = '(window.molstudioClipboard&&typeof window.molstudioClipboard.hasSelection==="function"&&window.molstudioClipboard.hasSelection())';
const callHook = (name, args) => 'window.molstudioClipboard&&typeof window.molstudioClipboard.'+name+'==="function"&&window.molstudioClipboard.'+name+'('+args+')';
const placementMeta = (struct, origin, target, rotation) => '{token:'+struct+'.molstudioClipboardToken,scale:'+struct+'.molstudioClipboardScale||1,origin:{x:'+origin+'.x,y:'+origin+'.y},target:{x:'+target+'.x,y:'+target+'.y},offset:{x:'+target+'.x-'+origin+'.x,y:'+target+'.y-'+origin+'.y},rotation:'+rotation+'}';

// Each anchor is intentionally scoped to one native handler/action. In particular,
// do not change LS(), OS(), isClipboardAPIAvailable(), or the global Yt() predicate.
const patches = [
  {
    name: 'native toolbar entry: optional host transport, then prepare its real clipboard receiver',
    before: 'function _S(U){var F=document.queryCommandSupported(U);if(F)try{var Q=window;',
    // WKWebView's script paste command displays a contextual permission popup.
    // Its host can send the standard AppKit paste action instead. Returning false
    // leaves the existing toolbar command/help behavior intact (copy/cut, browsers).
    after: 'function _S(U){if(window.molstudioClipboard&&typeof window.molstudioClipboard.execute==="function"&&window.molstudioClipboard.execute(U))return!0;var F=document.queryCommandSupported(U);if(F)try{window.molstudioClipboard&&typeof window.molstudioClipboard.prepare==="function"&&window.molstudioClipboard.prepare(U);var Q=window;'
  },
  {
    name: 'copy: use the existing synchronous event-data branch',
    before: 'copy:function(F){if(U.props.focused()&&!wS())if(LS())',
    after: 'copy:function(F){if(U.props.focused()&&!wS())if(LS()&&!'+preferEvents+')'
  },
  {
    name: 'copy: recognise event-data hosts alongside Safari',
    before: 'else if(OS()){var Q=U.props.onLegacyCopy();',
    after: 'else if(OS()||'+preferEvents+'){var Q=U.props.onLegacyCopy();'
  },
  {
    name: 'cut: use the existing synchronous event-data branch',
    before: 'cut:function(F){if(U.props.focused()&&!wS())if(LS())',
    after: 'cut:function(F){if(U.props.focused()&&!wS())if(LS()&&!'+preferEvents+')'
  },
  {
    name: 'paste: consume the real paste event through native onLegacyPaste',
    before: 'paste:function(F){if(U.props.focused()&&!wS())if((0,Z.isClipboardAPIAvailable)())',
    after: 'paste:function(F){if(U.props.focused()&&!wS())if((0,Z.isClipboardAPIAvailable)()&&!'+preferEvents+')'
  },
  ...['copy', 'cut', 'copies'].map(name => ({
    name: name+': allow the mechanism extension to enable the native clipboard action',
    before: 'disabled:function(U){return!Yt(U)},hidden:function(U){return vS(U,"'+name+'")}',
    after: 'disabled:function(U){return!Yt(U)&&!'+externalSelection+'},hidden:function(U){return vS(U,"'+name+'")}'
  })),
  {
    name: 'native copy: expose the exact selected Struct without reserializing it',
    before: 'R=new Z.MolSerializer;try{var V=(new Z.KetSerializer).serialize(Q);',
    after: 'R=new Z.MolSerializer;try{'+callHook('nativeCopySource', 'Q')+';var V=(new Z.KetSerializer).serialize(Q);'
  },
  {
    name: 'native paste: capture the event transaction before asynchronous parsing',
    before: '!Q&&_X.test(U["text/plain"])||R(Q,F?{fragment:!0,isPaste:!0,"input-format":Z.ChemicalMimeType.DaylightSmarts}:{fragment:!0,isPaste:!0})',
    after: '!Q&&_X.test(U["text/plain"])||R(Q,Object.assign(F?{fragment:!0,isPaste:!0,"input-format":Z.ChemicalMimeType.DaylightSmarts}:{fragment:!0,isPaste:!0},{molstudioClipboardToken:'+callHook('nativePasteToken', '')+'}))'
  },
  {
    name: 'native loader: keep the extension token out of parser/server options',
    before: '_k=["rescale","fragment"],$k=["isPaste","method","preserveViewport"]',
    after: '_k=["rescale","fragment"],$k=["isPaste","method","preserveViewport","molstudioClipboardToken"]'
  },
  {
    name: 'native loader: carry this request token onto its parsed Struct before native rescale',
    before: 'case 12:if(C=Q.sent,D=e.fragment',
    after: 'case 12:if(C=Q.sent,C.molstudioClipboardToken=F.molstudioClipboardToken,C.molstudioClipboardScale=1,D=e.fragment'
  },
  {
    name: 'native loader: reject obsolete tagged results before they replace a newer native PasteTool; clean up blank input',
    before: 'C.markFragments(),C.applyMonomersTransformations(),D?C.isBlank()?B(Rt()):B(Qt({tool:"paste",opts:C}))',
    after: 'C.markFragments(),C.applyMonomersTransformations();if(C.molstudioClipboardToken&&window.molstudioClipboard&&typeof window.molstudioClipboard.nativePasteToken==="function"&&C.molstudioClipboardToken!==window.molstudioClipboard.nativePasteToken()){B(Bk(!1)),'+callHook('nativePasteCancel','C.molstudioClipboardToken,!1')+';return Q.abrupt("return")}D?C.isBlank()?(C.molstudioClipboardToken&&('+callHook('nativePasteCancel','C.molstudioClipboardToken,!1')+'),B(Rt())):B(Qt({tool:"paste",opts:C}))'
  },
  {
    name: 'native loader: cancel only the failed request sidecar while retaining its native catch/finally cleanup',
    before: 'case 38:Q.prev=38,Q.t0=Q.catch(9),Z.KetcherLogger.error("shared.ts::load",Q.t0),B(Bk(!1)),Q.t0&&(null===S||void 0===S||S(Q.t0.message));case 43:',
    after: 'case 38:Q.prev=38,Q.t0=Q.catch(9),F.molstudioClipboardToken&&('+callHook('nativePasteCancel','F.molstudioClipboardToken,!1')+'),Z.KetcherLogger.error("shared.ts::load",Q.t0),B(Bk(!1)),Q.t0&&(null===S||void 0===S||S(Q.t0.message));case 43:'
  },
  {
    name: 'native scale: record its actual factor for this clipboard Struct only',
    before: 'key:"scale",value:function(U){1!==U&&(this.atoms.forEach',
    after: 'key:"scale",value:function(U){this.molstudioClipboardToken&&(this.molstudioClipboardScale=(this.molstudioClipboardScale||1)*U);1!==U&&(this.atoms.forEach'
  },
  {
    name: 'native fromPaste: expose its exact transform as an additional result',
    before: 'l.operations.reverse(),[l,N,Z]}function bX',
    after: 'l.operations.reverse(),[l,N,Z,'+placementMeta('F', 'V', 'Q', 'B')+']}function bX'
  },
  {
    name: 'native template-on-atom: expose its exact transform for contracted-group paste',
    before: 'l.mergeWith(Ai(U,U.molecule.bonds.get(T.bonds[0]))),[l,T]}function VY',
    after: 'l.mergeWith(Ai(U,U.molecule.bonds.get(T.bonds[0]))),[l,T,'+placementMeta('J', 't', 'W.pp', 'V')+']}function VY'
  },
  {
    name: 'native PasteTool: begin external overlay after its native preview is ready',
    before: 'Fz(this.editor,a,this,!0)}return',
    after: 'Fz(this.editor,a,this,!0),'+callHook('nativePasteStart', 'E[3]')+'}return'
  },
  {
    name: 'native PasteTool: move external overlay with the actual native fragment transform',
    before: 'this.action=k,this.editor.update(this.action,!0);var a=ms(t,this.editor.struct());',
    after: 'this.action=k,this.editor.update(this.action,!0),'+callHook('nativePasteMove', 'S[3]')+';var a=ms(t,this.editor.struct());'
  },
  {
    name: 'native PasteTool: follow the contracted-group template transform',
    before: 'this.dragCtx.action=W,this.editor.update(this.dragCtx.action,!0)}else{var S=(0,Z.fromPaste)',
    after: 'this.dragCtx.action=W,this.editor.update(this.dragCtx.action,!0),'+callHook('nativePasteMove', 'N[2]')+'}else{var S=(0,Z.fromPaste)'
  },
  {
    name: 'native PasteTool: follow the native mousedown replacement preview',
    before: 'var n=(0,Z.fromPaste)(this.restruct,this.struct,Z.CoordinateTransformation.pageToModel(U,this.editor.render)),l=(0,R.A)(n,1)[0];this.action=l}}}',
    after: 'var n=(0,Z.fromPaste)(this.restruct,this.struct,Z.CoordinateTransformation.pageToModel(U,this.editor.render)),l=(0,R.A)(n,1)[0];this.action=l,'+callHook('nativePasteMove', 'n[3]')+'}}}'
  },
  {
    name: 'native PasteTool: expose the exact committed history action after native fusion/push',
    before: 'var B=this.action;delete this.action,this.isSingleContractedGroup&&this.mergeItems||js(this.editor,this.mergeItems,B),this.editor.tool("select")',
    after: 'var B=this.action;delete this.action;var molstudioAction=this.isSingleContractedGroup&&this.mergeItems?null:js(this.editor,this.mergeItems,B);this.molstudioClipboardCommitted=!0,molstudioAction&&('+callHook('nativePasteCommit', 'molstudioAction,this.struct.molstudioClipboardToken')+'),this.editor.tool("select")'
  },
  {
    name: 'native PasteTool: expose the committed contracted-group history action',
    before: 'this.editor.update(Q.action),this.editor.event.message.dispatch({info:!1})}else{var B=this.action;',
    after: 'this.editor.update(Q.action),this.molstudioClipboardCommitted=!0,'+callHook('nativePasteCommit', 'Q.action,this.struct.molstudioClipboardToken')+',this.editor.event.message.dispatch({info:!1})}else{var B=this.action;'
  },
  {
    name: 'native PasteTool: distinguish temporary leave from permanent cancellation',
    before: '{key:"cancel",value:function(){var U=this.editor.render;this.editor.hover(null),this.action&&(this.action.perform(U.ctab),delete this.action,U.update())}},{key:"mouseleave",value:function(){this.cancel()}},{key:"mouseLeaveClientArea",value:function(){this.cancel()}}',
    after: '{key:"cancel",value:function(){var U=this.editor.render;this.editor.hover(null),this.action&&(this.action.perform(U.ctab),delete this.action,U.update()),this.molstudioClipboardCommitted||('+callHook('nativePasteCancel', 'this.struct.molstudioClipboardToken,arguments[0]===!0')+')}},{key:"mouseleave",value:function(){this.cancel(!0)}},{key:"mouseLeaveClientArea",value:function(){this.cancel(!0)}}'
  },
  {
    name: 'native legacy cut: capture this event transaction before its debounce',
    before: 'return Q?B({tool:"eraser",opts:1}):U.selection(null),Q',
    after: 'return Q?B({tool:"eraser",opts:1},'+callHook('nativeCutToken', '')+'):U.selection(null),Q'
  },
  {
    name: 'native cut dispatch: scope its captured transaction to this exact eraser action',
    before: 'B=(0,D.debounce)(0,function(F){return U(Qt(F))}),R=(0,D.debounce)(0,function(F,Q){return U(Vt(F,Q))})',
    after: 'B=(0,D.debounce)(0,function(V,n){var l=F().editor;l.molstudioClipboardCutToken=n;try{return U(Qt(V))}finally{delete l.molstudioClipboardCutToken;'+callHook('nativeCutEnd', 'n')+'}}),R=(0,D.debounce)(0,function(F,Q){return U(Vt(F,Q))})'
  },
  {
    name: 'native history: allow a pending clipboard cut to augment its existing real action',
    before: 'F||U.isDummy(this.render.ctab)||(this.historyStack.splice(this.historyPtr,33,U)',
    after: 'F||U.isDummy(this.render.ctab)||('+callHook('nativeClipboardHistory', 'U,this.molstudioClipboardCutToken')+',this.historyStack.splice(this.historyPtr,33,U)'
  }
];

function occurrences(source, anchor) { return source.split(anchor).length - 1; }
function digest(source) { return crypto.createHash('sha256').update(source).digest('hex'); }

function patchSource(source) {
  const states = patches.map(patch => {
    const before = occurrences(source, patch.before), after = occurrences(source, patch.after);
    if (before === 1 && after === 0) return 'upstream';
    if (before === 0 && after === 1) return 'patched';
    throw new Error('Ketcher clipboard anchor changed: '+patch.name+' (before='+before+', after='+after+')');
  });
  if (!states.every(state => state === states[0])) throw new Error('Ketcher clipboard patch is only partially applied');
  const alreadyPatched = states[0] === 'patched';
  let upstream = source;
  if (alreadyPatched) for (const patch of patches) upstream = upstream.replace(patch.after, patch.before);
  for (const patch of require('./patch-ketcher-valence.cjs').patches) upstream = upstream.replace(patch.after, patch.before);
  for (const patch of require('./patch-ketcher-agent.cjs').patches) upstream = upstream.replace(patch.after, patch.before);
  for (const patch of require('./patch-ketcher-label-spacing.cjs').patches) upstream = upstream.replace(patch.after, patch.before);
  if (digest(upstream) !== upstreamSha256) throw new Error('Unsupported Ketcher bundle SHA-256; review the upstream change before updating this patch');
  if (alreadyPatched) return { source, changed: false };
  let patched = source;
  for (const patch of patches) patched = patched.replace(patch.before, patch.after);
  return { source: patched, changed: true };
}

if (require.main === module) {
  try {
    const result = patchSource(fs.readFileSync(bundlePath, 'utf8'));
    if (result.changed) fs.writeFileSync(bundlePath, result.source);
    process.stdout.write(result.changed ? 'Patched Ketcher native clipboard hooks.\n' : 'Ketcher native clipboard hooks already applied.\n');
  } catch (error) {
    process.stderr.write(error.message+'\n');
    process.exitCode = 1;
  }
}

module.exports = { bundlePath, upstreamSha256, patches, patchSource };
