'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { bundlePath, patches, patchSource, legacyCommitAfter } = require('../patch-ketcher-clipboard.cjs');
const source = fs.readFileSync(bundlePath, 'utf8');

// Execute the actual pinned native handlers, rather than a second implementation
// of the clipboard router. These bodies contain no template literals or regexes
// with braces; the scanner skips quoted strings while balancing their braces.
function bodyAt(text, start) {
  const open = text.indexOf('{', start);
  assert.ok(open >= 0);
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw Error('Unterminated native function');
}
function nativeFunction(marker, start = 0) {
  const index = source.indexOf(marker, start);
  assert.ok(index >= 0, marker);
  const fn = source.indexOf('function', index);
  return bodyAt(source, fn);
}
const clipStart = source.indexOf('this.listeners={mouseup:function');
assert.ok(clipStart >= 0);
const clipObject = bodyAt(source, source.indexOf('{', clipStart));
const propsStart = source.indexOf('function $X(', clipStart);
const nativeBodies = ['function UY(', 'function BY('].map(marker => nativeFunction(marker, propsStart))
  .concat(nativeFunction('function gS(', clipStart));
const legacyCopy = nativeFunction('onLegacyCopy:function', propsStart);
const legacyCut = nativeFunction('onLegacyCut:function', propsStart);
const legacyPaste = nativeFunction('onLegacyPaste:function', propsStart);

function fixture(hook) {
  const calls = { selected: 0, serialize: [], cleared: [], placements: [], erased: [], modernCopies: 0,
    modernPastes: [], asyncCuts: 0, writes: [], reads: 0, copiedNotifications: 0, prepared: [], commands: [], supported: [] };
  const selected = { tag: 'only the native selected fragment', isBlank: () => false,
    simpleObjects: new Map(), texts: new Map(), isReaction: false };
  const editor = { structSelected() { calls.selected++; return selected; }, selection(value) { calls.cleared.push(value); },
    errorHandler(message) { throw Error(message); } };
  const mime = { KET: 'chemical/x-ketcher-ket', Mol: 'chemical/x-mdl-molfile', Rxn: 'chemical/x-mdl-rxnfile' };
  const modernData = { 'text/plain': 'native modern format' };
  const props = { focused: () => true, formats: Object.values(mime),
    async onCopy() { calls.modernCopies++; return modernData; },
    async onPaste(data) { calls.modernPastes.push(data); } };
  const globals = {
    window: hook ? { molstudioClipboard: hook } : {},
    navigator: { clipboard: { read: async () => { calls.reads++; return ['native clipboard item']; } } },
    document: { queryCommandSupported: command => { calls.supported.push(command); return true; },
      execCommand: command => { calls.commands.push(command); return true; } },
    U: { props }, F: () => ({ editor }),
    LS: () => true, OS: () => false, wS: () => false, HS: undefined, CQ: { lT: false },
    KS: async data => { calls.writes.push(data); }, uS: false,
    B: action => { calls.erased.push(action); },
    R: (text, options) => { calls.placements.push({ text, options }); }, _X: /never-match/,
    // The unchanged transpiled async-cut branch is only observed for routing here.
    n: { A: () => () => { calls.asyncCuts++; } }, d: () => ({ mark: fn => fn }),
    Z: { ChemicalMimeType: mime, isClipboardAPIAvailable: () => true,
      notifyCopyCut: () => { calls.copiedNotifications++; }, notifyRequestCompleted() {},
      KetcherLogger: { error(...args) { throw Error(String(args)); } },
      KetSerializer: class { serialize(fragment) { assert.equal(fragment, selected); calls.serialize.push('ket'); return 'native selected KET'; } },
      MolSerializer: class { serialize(fragment) { assert.equal(fragment, selected); calls.serialize.push('mol'); return 'native selected MOL'; } } }
  };
  vm.createContext(globals);
  vm.runInContext(nativeBodies.join(';'), globals);
  props.onLegacyCopy = vm.runInContext('('+legacyCopy+')', globals);
  props.onLegacyCut = vm.runInContext('('+legacyCut+')', globals);
  props.onLegacyPaste = vm.runInContext('('+legacyPaste+')', globals);
  const listeners = vm.runInContext('('+clipObject+')', globals);
  const action = vm.runInContext('('+nativeFunction('function _S(', clipStart)+')', globals);
  return { calls, globals, props, listeners, action, mime, modernData };
}
function event(data = {}) {
  return { prevented: 0, clipboardData: { values: { ...data },
    getData(type) { return this.values[type] || ''; },
    setData(type, value) { this.values[type] = value; } },
    preventDefault() { this.prevented++; } };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function loaderFixture(currentToken) {
  const calls = { dispatch:[], parse:[], cancelled:[], completed:0, errors:[] };
  const pending = [];
  // Execute Vt's actual transpiled state machine. This small runtime implements
  // its one try/catch/finally table, including abrupt-return cleanup; it does not
  // replace the loader's routing/guard/cleanup code under test.
  const runtime = {
    mark: fn => fn,
    wrap(inner, outer, self, table) {
      assert.equal(JSON.stringify(table), JSON.stringify([[9,38,43,46]]));
      const ctx = { prev:0,next:0,sent:undefined,done:false,
        catch() { return this.error; },
        abrupt(type,value) { assert.equal(type,'return'); this.result=value; this.next=43; },
        finish(location) { assert.equal(location,43); this.next=46; },
        stop() { this.done=true; return this.result; } };
      return {
        next(value) { ctx.sent=value; const result=inner(ctx); return {value:result,done:ctx.done}; },
        throw(error) { ctx.error=error;ctx.next=38;return this.next(); }
      };
    }
  };
  const asyncGenerator = fn => async function(...args) {
    const iterator=fn.apply(this,args);let step=iterator.next();
    while(!step.done) {
      try { step=iterator.next(await step.value); }
      catch(error) { step=iterator.throw(error); }
    }
    return step.value;
  };
  const excluded = JSON.parse(/\$k=(\[[^\]]+\])/.exec(source)[1]);
  const canvas = { atoms:{size:0},disableInitiallySelected(){} };
  const editor = { struct:()=>canvas, zoomAccordingContent(){},centerStruct(){},
    errorHandler:message=>calls.errors.push(message) };
  const ctx = { window:{molstudioClipboard:{nativePasteToken:()=>currentToken,
    nativePasteCancel(token,temporary){calls.cancelled.push([token,temporary]);if(token===currentToken)currentToken=null;} }},
    n:{A:asyncGenerator},d:()=>runtime,$k:excluded,
    W:{A:(obj,keys)=>Object.fromEntries(Object.entries(obj).filter(([key])=>!keys.includes(key)))},Ft:Object.assign,
    Bk:loading=>({type:'LOADING',loading}),Qt:action=>({type:'NATIVE_ACTION',action}),Rt:()=>({type:'NATIVE_RESET'}),
    Bt(text,server,options){calls.parse.push({text,options});return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
    Z:{KetcherLogger:{error(...args){calls.errors.push(args);}},notifyRequestCompleted(){calls.completed++;}},
    p:{isNumber:x=>typeof x==='number'},Vk:{} };
  vm.createContext(ctx);
  const load=vm.runInContext('('+nativeFunction('function Vt(',7200000)+')',ctx);
  function run(token) {
    const options={fragment:true,isPaste:true};if(token)options.molstudioClipboardToken=token;
    return load('native KET',options)(action=>calls.dispatch.push(action),()=>({editor,server:{},options:{getServerSettings:()=>({})}}));
  }
  function parsed(blank=false) {
    return { sgroups:{some:()=>false,forEach(){}},bonds:{find(){}},rescale(){},
      findConnectedComponents(){},setImplicitHydrogen(){},setStereoLabelsToAtoms(){},markFragments(){},applyMonomersTransformations(){},isBlank:()=>blank };
  }
  return { calls,pending,run,parsed,setCurrent:token=>{currentToken=token;},current:()=>currentToken };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; process.stdout.write('PASS '+name+'\n'); }

(async () => {
  await test('guarded patch is reproducible, idempotent, and rejects upstream drift or a partial patch', () => {
    assert.equal(patchSource(source).changed, false);
    let original = source;
    for (const patch of patches) original = original.replace(patch.after, patch.before);
    assert.equal(patchSource(original).source, source);
    assert.equal(patchSource(original).changed, true);
    assert.throws(() => patchSource(source+'\n'), /SHA-256/);
    assert.throws(() => patchSource(source.replace(patches[0].after, patches[0].before)), /partially/);
    assert.throws(() => patchSource(source.replace(patches[0].after, 'changed upstream helper')), /anchor changed/);
    const commit = patches.find(p => p.name.includes('exact committed history action'));
    const legacy = source.replace(commit.after, legacyCommitAfter);
    assert.equal(patchSource(legacy).source, source);
    assert.equal(patchSource(legacy).changed, true);
    assert.throws(() => patchSource(legacy + '\n'), /SHA-256/);
  });
  await test('event-data host copies the native selected fragment through native serializers and event data', () => {
    const f = fixture({ preferEvents: true }), e = event();
    f.listeners.copy(e);
    assert.equal(f.calls.modernCopies, 0);
    assert.deepEqual(f.calls.serialize, ['ket', 'mol']);
    assert.equal(e.clipboardData.values[f.mime.KET], 'native selected KET');
    assert.equal(e.clipboardData.values['text/plain'], 'native selected MOL');
    assert.deepEqual(f.calls.cleared, [null]);
    assert.equal(e.prevented, 1);
  });
  await test('event-data cut retains native serialization and eraser action', () => {
    const f = fixture({ preferEvents: true }), e = event();
    f.listeners.cut(e);
    assert.deepEqual(f.calls.serialize, ['ket', 'mol']);
    assert.equal(e.clipboardData.values[f.mime.KET], 'native selected KET');
    assert.equal(JSON.stringify(f.calls.erased), JSON.stringify([{ tool: 'eraser', opts: 1 }]));
    assert.equal(f.calls.asyncCuts, 0);
    assert.equal(e.prevented, 1);
  });
  await test('event-data paste retains native format priority and cursor placement options without async clipboard read', () => {
    const f = fixture({ preferEvents: true });
    const e = event({ [f.mime.KET]: 'selected KET', [f.mime.Mol]: 'selected MOL', 'text/plain': 'text fallback' });
    f.listeners.paste(e);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.placements[0].text, 'selected KET');
    assert.equal(f.calls.placements[0].options.fragment, true);
    assert.equal(f.calls.placements[0].options.isPaste, true);
    assert.equal(e.prevented, 1);
    const plain = event({ 'text/plain': 'external native structure' });
    f.listeners.paste(plain);
    assert.equal(f.calls.placements[1].text, 'external native structure');
  });
  await test('browsers without the host hook retain their existing modern native paths', async () => {
    const f = fixture(), copy = event(), cut = event(), paste = event();
    f.listeners.copy(copy); f.listeners.cut(cut); f.listeners.paste(paste);
    await flush();
    assert.equal(f.calls.modernCopies, 1);
    assert.equal(f.calls.writes[0], f.modernData);
    assert.equal(f.calls.asyncCuts, 1);
    assert.equal(f.calls.reads, 1);
    assert.deepEqual(f.calls.modernPastes, [['native clipboard item']]);
    assert.deepEqual(f.calls.serialize, []);
    assert.equal(copy.prevented, 1);
  });
  await test('Safari without the host hook retains its existing synchronous native copy branch', () => {
    const f = fixture(); f.globals.OS = () => true; f.globals.LS = () => false;
    const e = event(); f.listeners.copy(e);
    assert.deepEqual(f.calls.serialize, ['ket', 'mol']);
    assert.equal(f.calls.modernCopies, 0);
  });
  await test('native modal and editable-field guards still leave clipboard operations untouched', () => {
    for (const guard of ['modal', 'input']) {
      const f = fixture({ preferEvents: true });
      if (guard === 'modal') f.props.focused = () => false;
      else f.globals.wS = () => true;
      for (const name of ['copy', 'cut', 'paste']) {
        const e = event(); f.listeners[name](e); assert.equal(e.prevented, 0);
      }
      assert.deepEqual(f.calls.serialize, []); assert.equal(f.calls.reads, 0);
    }
  });
  await test('only native clipboard action availability includes the external arrow selection', () => {
    for (const name of ['copy', 'cut', 'copies', 'copy-image', 'copy-mol', 'copy-ket']) {
      const start = source.indexOf(name+':{');
      const quotedStart = source.indexOf('"'+name+'":{');
      const marker = start >= 0 ? start : quotedStart;
      assert.ok(marker >= 0, name);
      const disabled = nativeFunction('disabled:function', marker);
      for (const nativeSelection of [false, true]) for (const arrows of [false, true]) {
        const context = { Yt: () => nativeSelection, window: { molstudioClipboard: { hasSelection: () => arrows } } };
        const result = vm.runInNewContext('('+disabled+')({})', context);
        const acceptsArrows = ['copy', 'cut', 'copies'].includes(name);
        assert.equal(result, !(nativeSelection || (acceptsArrows && arrows)), name);
      }
    }
  });
  await test('native toolbar entry prepares its receiver then executes the unchanged native command', () => {
    const f = fixture({ prepare(command) { f.calls.prepared.push(command); } });
    for (const command of ['copy', 'cut', 'paste']) assert.equal(f.action(command), true);
    assert.deepEqual(f.calls.prepared, ['copy', 'cut', 'paste']);
    assert.deepEqual(f.calls.commands, ['copy', 'cut', 'paste']);
    const withoutHook = fixture(); assert.equal(withoutHook.action('copy'), true);
    assert.deepEqual(withoutHook.calls.commands, ['copy']);
  });
  await test('host-handled toolbar paste bypasses script paste while copy and cut retain native commands', () => {
    const transports = [];
    const f = fixture({
      execute(command) { transports.push(command); return command === 'paste'; },
      prepare(command) { f.calls.prepared.push(command); }
    });
    assert.equal(f.action('paste'), true);
    assert.deepEqual(transports, ['paste']);
    assert.deepEqual(f.calls.supported, []);
    assert.deepEqual(f.calls.commands, []);
    assert.deepEqual(f.calls.prepared, []);
    assert.equal(f.action('copy'), true); assert.equal(f.action('cut'), true);
    assert.deepEqual(transports, ['paste', 'copy', 'cut']);
    assert.deepEqual(f.calls.supported, ['copy', 'cut']);
    assert.deepEqual(f.calls.prepared, ['copy', 'cut']);
    assert.deepEqual(f.calls.commands, ['copy', 'cut']);
    assert.deepEqual(f.calls.serialize, []); // The transport itself never exports molecular data.
  });
  await test('native paste captures its transaction synchronously before the deferred loader', () => {
    let token = 'paste-A';
    const f = fixture({ preferEvents: true, nativePasteToken: () => token });
    f.listeners.paste(event({ [f.mime.KET]: 'A KET' }));
    token = 'paste-B';
    f.listeners.paste(event({ [f.mime.KET]: 'B KET' }));
    assert.equal(f.calls.placements[0].options.molstudioClipboardToken, 'paste-A');
    assert.equal(f.calls.placements[1].options.molstudioClipboardToken, 'paste-B');
    const excluded = /\$k=(\[[^\]]+\])/.exec(source);
    assert.ok(excluded);
    assert.ok(JSON.parse(excluded[1]).includes('molstudioClipboardToken'));
    assert.ok(source.includes('C=Q.sent,C.molstudioClipboardToken=F.molstudioClipboardToken,C.molstudioClipboardScale=1,D=e.fragment'));
  });
  await test('native scale records the exact normalization without changing non-clipboard structures', () => {
    class Vec { constructor(x, y) { this.x = x; this.y = y; } scaled(n) { return new Vec(this.x*n, this.y*n); } }
    const ctx = { bd: class {} };
    const scale = vm.runInNewContext('('+nativeFunction('key:"scale",value:function', 1300000)+')', ctx);
    const rescale = vm.runInNewContext('('+nativeFunction('key:"rescale",value:function', 1300000)+')', ctx);
    function struct(token) {
      const st = { atoms: new Map([[0, { pp: new Vec(10, 20) }]]), getAvgBondLength: () => 2.5, scale };
      for (const name of ['rxnPluses','rxnArrows','sgroups','texts','simpleObjects','images','multitailArrows','frags']) st[name] = new Map();
      if (token) { st.molstudioClipboardToken = token; st.molstudioClipboardScale = 1; }
      return st;
    }
    const copied = struct('paste-A'); rescale.call(copied);
    assert.equal(copied.molstudioClipboardScale, .4);
    assert.deepEqual(copied.atoms.get(0).pp, new Vec(4, 8));
    scale.call(copied, 2);
    assert.equal(copied.molstudioClipboardScale, .8);
    const ordinary = struct(); rescale.call(ordinary);
    assert.equal(Object.hasOwn(ordinary, 'molstudioClipboardScale'), false);
    assert.deepEqual(ordinary.atoms.get(0).pp, new Vec(4, 8));
  });
  await test('native fromPaste reports its own exact transform alongside the existing three results', () => {
    class Vec {
      constructor(x, y) { this.x = x; this.y = y; }
      static diff(a,b) { return new Vec(a.x-b.x,a.y-b.y); }
      rotate(a) { return new Vec(this.x*Math.cos(a)-this.y*Math.sin(a), this.x*Math.sin(a)+this.y*Math.cos(a)); }
      add(p) { return new Vec(this.x+p.x, this.y+p.y); }
    }
    class Action { constructor() { this.operations = []; } addOp(op) { this.operations.push(op); return op; } mergeWith(a) { this.operations.push(...a.operations); return this; } }
    const placed = [];
    const ctx = { XU: Vec, si: Action,
      Lr: class { perform() { return { frid: 7 }; } },
      gc: class { constructor(atom, point) { placed.push(point); } perform() { return { data: { aid: 9 } }; } },
      Rm: class { perform() { return {}; } }, Ur: class { perform() { return {}; } }, pX: () => new Action() };
    const paste = vm.runInNewContext('('+nativeFunction('function iX(', 6300000)+')', ctx);
    const fragment = { atoms: new Map([[0, { pp: new Vec(10,20), fragment: 0, clone() { return { pp: this.pp }; } }]]),
      isAtomFromMacromolecule: () => false, molstudioClipboardToken: 'paste-A', molstudioClipboardScale: .4 };
    for (const name of ['sgroups','rxnArrows','rxnPluses','simpleObjects','texts','images','multitailArrows','frags','bonds','rgroups']) fragment[name] = new Map();
    const result = paste({}, fragment, new Vec(100,200));
    assert.equal(result.length, 4);
    assert.ok(result[0] instanceof Action);
    assert.equal(JSON.stringify(result[1]), JSON.stringify({ atoms:[9], bonds:[] }));
    assert.deepEqual(placed, [new Vec(100,200)]);
    assert.equal(JSON.stringify(result[3]), JSON.stringify({ token:'paste-A', scale:.4, origin:{x:10,y:20}, target:{x:100,y:200}, offset:{x:90,y:180}, rotation:0 }));
  });
  await test('native PasteTool lifecycle preserves token, native preview, exact history action, and temporary cancellation', () => {
    const events = [], history = [];
    let pos = 0;
    const token = 'paste-A', finalAction = { tag: 'native fused history action' };
    const meta = () => ({ token, scale: .4, origin: {x:4,y:8}, target: {x:100+pos,y:200}, offset: {x:96+pos,y:192}, rotation:0 });
    const action = () => ({ mergeWith() {}, perform() { events.push('undo-preview'); } });
    const editor = { selection() {}, lastEvent:{clientX:100,clientY:200}, hover() {},
      struct: () => ({}), update(a, preview) { events.push(['update',preview]); },
      render: { ctab:{}, clientArea:{clientHeight:600,clientWidth:800,getBoundingClientRect:()=>({left:0,top:0})}, update() { events.push('render'); } },
      tool(name) { events.push(['tool',name]); current.cancel(); } };
    const fragment = { isSingleGroup:()=>false, molstudioClipboardToken:token };
    const ctx = { window:{molstudioClipboard:{
      nativePasteStart(m) { events.push(['start',m]); }, nativePasteMove(m) { events.push(['move',m]); },
      nativePasteCommit(a,t) { if (a) assert.equal(history.at(-1), a); events.push(['commit',a,t]); },
      nativePasteCancel(t,temporary) { events.push(['cancel',t,temporary]); }
    }}, J:{A(){}}, B:{A(obj,key,value){obj[key]=value;}}, R:{A:a=>a},
      N:{A(C,methods){for(const m of methods)Object.defineProperty(C.prototype,m.key,{value:m.value,get:m.get,configurable:true});}},
      Z:{ CoordinateTransformation:{pageToModel:e=>({x:e.clientX,y:e.clientY})},
        fromPaste:()=>[action(),{atoms:[],bonds:[]},{},meta()], expandSGroupWithMultipleAttachmentPoint:()=>({}) },
      Fz(){}, Uz:false, requestAnimationFrame:fn=>fn(), ms:x=>x, Vs:()=>[], $Y:Object.assign,
      js(ed, merge, a){history.push(finalAction);return finalAction;} };
    // Accessor descriptors must omit "value", while ordinary methods omit "get".
    ctx.N.A = (C,methods) => { for (const m of methods) Object.defineProperty(C.prototype,m.key,
      m.get ? {get:m.get,configurable:true} : {value:m.value,configurable:true}); };
    const start = source.indexOf('Qz=function()', clipStart);
    const PasteTool = vm.runInNewContext('('+bodyAt(source,source.indexOf('function()',start))+')()',ctx);
    let current = new PasteTool(editor, fragment);
    assert.equal(events.find(e=>Array.isArray(e)&&e[0]==='start')[1].token,token);
    pos=5; current.mousemove({clientX:105,clientY:200});
    assert.equal(events.find(e=>Array.isArray(e)&&e[0]==='move')[1].offset.x,101);
    current.mouseleave();
    assert.ok(events.some(e=>Array.isArray(e)&&e[0]==='cancel'&&e[1]===token&&e[2]===true));
    current.mousemove({clientX:105,clientY:200});
    current.cancel();
    assert.ok(events.some(e=>Array.isArray(e)&&e[0]==='cancel'&&e[1]===token&&e[2]===false));
    current = new PasteTool(editor,fragment);
    const cancelCount=events.filter(e=>Array.isArray(e)&&e[0]==='cancel').length;
    current.mouseup();
    const committed=events.find(e=>Array.isArray(e)&&e[0]==='commit');
    assert.equal(committed[1],finalAction); assert.equal(committed[2],token);
    assert.equal(events.filter(e=>Array.isArray(e)&&e[0]==='cancel').length,cancelCount);
    // Execute the actual no-action completion branch as well. Untagged native
    // templates still need an end notification even though no sidecar exists.
    current = new PasteTool(editor, { ...fragment, molstudioClipboardToken: undefined });
    current.isSingleContractedGroup = true; current.mergeItems = {};
    current.mouseup();
    const noAction = events.filter(e=>Array.isArray(e)&&e[0]==='commit').at(-1);
    assert.equal(noAction[1], null); assert.equal(noAction[2], undefined);
  });
  await test('native cut token is scoped to the exact deferred eraser dispatch and cleared after noop or failure', () => {
    const history = [], observed = [], ended = [];
    const editor = { historyStack:history, historyPtr:0, render:{ctab:{},update(){}}, event:{change:{dispatch(){}}} };
    const ctx = { window:{molstudioClipboard:{nativeClipboardHistory(action,token){observed.push([action,token]);},nativeCutEnd:token=>ended.push(token)}},
      F:()=>({editor}), Qt:x=>x, _i(){},
      Z:{ ketcherProvider:{getKetcher:()=>({changeEvent:{dispatch(){}}})} } };
    vm.createContext(ctx);
    editor.update=vm.runInContext('('+nativeFunction('key:"update",value:function',source.indexOf('key:"selection",value:function',7700000))+')',ctx);
    const dispatch = vm.runInContext('('+nativeFunction('B=(0,D.debounce)(0,function',propsStart)+')',ctx);
    const act={isDummy:()=>false};
    ctx.U=()=>editor.update(act);
    dispatch({tool:'eraser',opts:1},'cut-A');
    assert.equal(observed[0][0],act); assert.equal(observed[0][1],'cut-A');
    assert.equal(editor.molstudioClipboardCutToken,undefined);
    editor.update({isDummy:()=>false});
    assert.equal(observed[1][1],undefined);
    ctx.U=()=>{};dispatch({tool:'eraser',opts:1},'cut-noop');
    ctx.U=()=>{throw Error('eraser rejected');};
    assert.throws(()=>dispatch({tool:'eraser',opts:1},'cut-fail'),/eraser rejected/);
    assert.deepEqual(ended,['cut-A','cut-noop','cut-fail']);
    assert.equal(editor.molstudioClipboardCutToken,undefined);
  });
  await test('actual native loader rejects a stale tagged parse before tool dispatch and still runs its finally cleanup', async () => {
    const f=loaderFixture('paste-A'),loading=f.run('paste-A');
    assert.equal(Object.hasOwn(f.calls.parse[0].options,'molstudioClipboardToken'),false);
    f.setCurrent('paste-B');f.pending[0].resolve(f.parsed());await loading;
    assert.equal(f.calls.dispatch.some(a=>a.type==='NATIVE_ACTION'||a.type==='NATIVE_RESET'),false);
    assert.deepEqual(f.calls.cancelled,[['paste-A',false]]);
    assert.equal(f.current(),'paste-B');
    assert.equal(f.calls.completed,1);
    assert.equal(f.calls.dispatch.at(-1).loading,false);
  });
  await test('actual native loader leaves current tagged and ordinary native paste dispatch unchanged', async () => {
    for(const token of ['paste-A',undefined]) {
      const f=loaderFixture('paste-A'),loading=f.run(token),fragment=f.parsed();
      f.pending[0].resolve(fragment);await loading;
      const placed=f.calls.dispatch.find(a=>a.type==='NATIVE_ACTION');
      assert.ok(placed);assert.equal(placed.action.tool,'paste');assert.equal(placed.action.opts,fragment);
      assert.deepEqual(f.calls.cancelled,[]);assert.equal(f.calls.completed,1);
    }
  });
  await test('actual native loader clears failed or blank sidecars by captured token without cancelling a newer session', async () => {
    for(const mode of ['failure','blank','stale-failure']) {
      const f=loaderFixture('paste-A'),loading=f.run('paste-A');
      if(mode==='stale-failure')f.setCurrent('paste-B');
      if(mode==='blank')f.pending[0].resolve(f.parsed(true));else f.pending[0].reject(Error('native parse rejected'));
      await loading;
      assert.deepEqual(f.calls.cancelled,[['paste-A',false]]);
      assert.equal(f.current(),mode==='stale-failure'?'paste-B':null);
      assert.equal(f.calls.dispatch.some(a=>a.type==='NATIVE_ACTION'),false);
      assert.equal(f.calls.completed,1);
      if(mode==='blank')assert.ok(f.calls.dispatch.some(a=>a.type==='NATIVE_RESET'));
    }
    const ordinary=loaderFixture('paste-B'),loading=ordinary.run();
    ordinary.pending[0].reject(Error('plain native parse rejected'));await loading;
    assert.deepEqual(ordinary.calls.cancelled,[]);assert.equal(ordinary.current(),'paste-B');
  });
  process.stdout.write(passed+' native Ketcher clipboard checks passed.\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
