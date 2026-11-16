'use strict';
// Real Electron acceptance for Chinese IME composition + rich text selection
// formatting in the paper document editor (Wave2 wiring).
// Uses the isolated local canvas service; no model calls and no OS dialogs.
//   MOLSTUDIO_PORT=49181 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
//     MOLSTUDIO_AGENT_TEST_OUT=/absolute/out \
//     env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_ime_rich_real.cjs
// NOTE: do NOT add --disable-gpu here (same convention as the wire-ui regression).
//
// Boundary note (recorded in the report as well): Electron cannot synthesize real
// OS-level IME keystrokes. The IME scenario is simulated by dispatching the real
// DOM composition event sequence (compositionstart / input(insertCompositionText) /
// compositionupdate / compositionend) on the contentEditable editor and mutating a
// text node exactly as a system IME would. That exercises the app-side guards
// (editor.composing, format bar disabling, finishTextEdit deferral) but not the
// OS IME pipeline itself.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49181;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-ime-rich-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-ime-rich-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);

const report = {
  application: 'MolStudio current canvas',
  page: 'fusion/canvas.html',
  pageURL: `http://127.0.0.1:${port}/canvas.html`,
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  modelCalls: 0,
  imeBoundaryNote: 'Electron 无法合成真实系统 IME 键击；IME 场景用真实 DOM composition 事件序列（compositionstart → input(insertCompositionText) → compositionupdate → compositionend）加文本节点手动写入模拟。事件路径与守卫逻辑为真，OS 输入法管线本身不在覆盖范围内。',
  checks: [],
  browserErrors: [],
  artifacts: {},
  startedAt: new Date().toISOString(),
};
let win;
const watchdog = setTimeout(() => {
  report.ok = false; report.error = 'Electron document IME/rich regression watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 180_000);
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_event, details) => report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`));
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('Current canvas did not become ready');

    const result = await js(`(async()=>{
      const checks=window.__documentImeRichChecks=[];
      const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});return pass;};
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const controller=MolWorkbench.app.documentController,paper=controller,ui=MolWorkbench.app.documentUI,rt=MolWorkbench.documentRichText;
      let P=paper,C=controller;
      const rebind=()=>{P=MolStudio.document;C=MolWorkbench.app.documentController;};
      const hostDoc=document,frameDoc=hostDoc.getElementById('k').contentDocument,frameWin=hostDoc.getElementById('k').contentWindow;
      const refresh=()=>({paper:MolStudio.document,ui:MolWorkbench.app.documentUI,controller:MolWorkbench.app.documentController});
      const editorDiv=()=>frameDoc.getElementById('molstudio-document-editor');
      const formatBar=()=>hostDoc.getElementById('molstudio-text-format-bar');
      const barDisabledState=bar=>({ariaDisabled:bar?.getAttribute('aria-disabled'),buttons:bar?[...bar.querySelectorAll('button,input,select')].map(n=>n.disabled):[]});
      const barAllDisabled=bar=>{const s=barDisabledState(bar);return s.ariaDisabled==='true'&&s.buttons.length>0&&s.buttons.every(Boolean);};
      const barEnabled=bar=>{const s=barDisabledState(bar);return s.ariaDisabled!=='true'&&s.buttons.length>0&&s.buttons.every(v=>!v);};
      const textObject=id=>paper.getState().objects.find(o=>o.id===id);
      const serialize=async()=>{try{return await k3dAPI.serializeWorkbench();}catch(e){return {threw:String(e?.message||e)};}};
      const openEditor=async id=>{paper.finishTextEdit();const ok=paper.editText(id);const immediate=!!frameDoc.getElementById('molstudio-document-editor');await wait(120);return {ok,immediate,div:editorDiv(),bar:formatBar()};};
      const closeEditor=async()=>{paper.finishTextEdit();await wait(120);};
      const setCaretOffset=(div,offset)=>{let pos=0,target=null,targetOffset=0;const visit=node=>{if(target)return;if(node.nodeType===3){if(pos+node.nodeValue.length>=offset){target=node;targetOffset=offset-pos;return;}pos+=node.nodeValue.length;}else for(const child of node.childNodes)visit(child);};visit(div);if(!target){target=div.lastChild;targetOffset=target?.nodeType===3?target.nodeValue.length:0;}if(!target)return;const range=frameDoc.createRange();range.setStart(target,targetOffset);range.collapse(true);const sel=frameWin.getSelection();sel.removeAllRanges();sel.addRange(range);};
      const selectOffsets=(div,start,end)=>{let pos=0,n1=null,o1=0,n2=null,o2=0;const visit=node=>{if(node.nodeType===3){if(!n1&&pos+node.nodeValue.length>=start){n1=node;o1=start-pos;}if(!n2&&pos+node.nodeValue.length>=end){n2=node;o2=end-pos;}pos+=node.nodeValue.length;}else for(const child of node.childNodes)visit(child);};visit(div);if(!n1||!n2)return false;const range=frameDoc.createRange();range.setStart(n1,o1);range.setEnd(n2,o2);const sel=frameWin.getSelection();sel.removeAllRanges();sel.addRange(range);return true;};
      const textTspans=id=>[...frameDoc.querySelectorAll('[data-doc-id="'+id+'"] text > tspan')];
      const richOf=id=>textObject(id)?.rich;

      /* 准备：纸页模式（插入菜单路径见 check 1） */
      paper.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      await wait(200);

      /* ---------- check 1：纸页插入文本框 → 编辑器 + 浮条 ---------- */
      {
        const btn=hostDoc.querySelector('#molstudio-document-toolbar [data-doc-action="insert-menu"]');
        btn.click(); await wait(60);
        const menu=hostDoc.getElementById('molstudio-document-insert-menu');
        const textItem=menu?[...menu.querySelectorAll('button')].find(b=>b.textContent==='文本框'):null;
        const menuOk=!!menu&&!menu.hidden&&!!textItem;
        textItem?.click(); await wait(60);
        const toolSet=paper.tool==='text';
        window.__toolAfterMenu=paper.tool;
        // 菜单里的“文本框”设置 text 工具后需拖拽出框；此处以 addText 建框（拖拽模拟边界），随后走真实 editText。
        const textId=paper.addText({x:20,y:20,w:24,h:4,text:''});
        paper.setTool('select');
        const opened=await openEditor(textId);
        const bar=opened.bar;
        const pass=check('纸页插入文本框后 editText 出现编辑器 div 且格式浮条随之出现',
          menuOk&&toolSet&&!!opened.ok&&!!opened.div&&opened.div.contentEditable==='true'&&!!bar&&!bar.hidden&&bar.getAttribute('aria-label')==='文字格式'&&bar.querySelectorAll('[data-doc-format]').length>=8,
          {menuOk,toolSet,tool:window.__toolAfterMenu,toolDebug:String(paper.tool),editTextOk:opened.ok,editorImmediate:opened.immediate,editor:!!opened.div,contentEditable:opened.div?.contentEditable,bar:!!bar,barHidden:bar?.hidden,barControls:bar?bar.querySelectorAll('[data-doc-format]').length:0});
        window.__imeTextId=textId;
      }
      const textId=window.__imeTextId;

      /* ---------- check 2 + 7：IME composition 模拟（守卫采样） ---------- */
      {
        const opened=await openEditor(textId);
        const div=opened.div,bar=opened.bar;
        const divRef=div;
        const sig=node=>node.nodeType+':'+(node.nodeType===3?node.nodeValue:n.nodeName);
        const baseChildren=[...div.childNodes].map(sig);
        // IME 合成期：系统输入法每轮都会替换 composition 文本节点（真实 childList 变化），
        // 这里用同样的方式插入/移除一个专用文本节点，其余子节点应保持不变（应用不重建 DOM）。
        let imeNode=null;
        const setComposition=text=>{if(imeNode)imeNode.remove();imeNode=frameDoc.createTextNode(text);div.appendChild(imeNode);};
        setCaretOffset(div,0);
        div.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
        await wait(30);
        const samples=[];let serializeThrew=null;
        for(let i=0;i<16;i++){
          setComposition(i<8?'':'氮');
          div.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:i<8?undefined:'氮'}));
          if(i===3)div.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'n'}));
          const snapshot={
            sameDiv:editorDiv()===divRef&&div.isConnected,
            stableChildren:JSON.stringify([...div.childNodes].filter(n=>n!==imeNode).map(sig))===JSON.stringify(baseChildren),
            bar:barDisabledState(bar),
            composing:paper.editor?.composing===true,
            objectText:richOf(textId)?.text??null,
          };
          if(i%4===3){const s=await serialize();if(typeof s==='string'){snapshot.savedTextHasDan=s.includes('氮');}else{serializeThrew=s.threw;snapshot.savedTextHasDan=false;}}
          samples.push(snapshot);
          await wait(10);
        }
        const domRebuilt=samples.some(s=>!s.sameDiv||!s.stableChildren);
        const barDisabledThroughout=samples.every(s=>s.bar.ariaDisabled==='true'&&s.bar.buttons.every(Boolean));
        const noCommitDuring=samples.every(s=>!(s.objectText||'').includes('氮'))&&samples.every(s=>s.savedTextHasDan!==true);
        div.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'氮'}));
        div.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'氮'}));
        await wait(80);
        const afterEnd={
          textInEditor:div.textContent.includes('氮'),
          composingStillTrue:paper.editor?.composing===true,
          editorStillOpen:!!editorDiv(),
          objectTextStillClean:!(richOf(textId)?.text||'').includes('氮'),
          barEnabledAgain:barEnabled(bar),
        };
        await closeEditor();
        const saved=await serialize();
        const savedHasDan=typeof saved==='string'&&saved.includes('氮');
        const pass2=check('IME 合成期间编辑器 DOM 不重建、浮条禁用、无提交；compositionend 后文本进入编辑器且保存含“氮”',
          !domRebuilt&&barDisabledThroughout&&noCommitDuring&&afterEnd.textInEditor&&!afterEnd.composingStillTrue&&afterEnd.objectTextStillClean&&savedHasDan,
          {domRebuilt,barDisabledThroughout,noCommitDuring,serializeThrewDuringComposition:serializeThrew,afterEnd,savedHasDan,sampleCount:samples.length,
            defectNote:barDisabledThroughout?undefined:'缺陷：浮条 aria-disabled/disabled 在 composition 期间从未生效（16 个 10ms 采样全部 false）。watchEditorForBar 的 MutationObserver 只 observe iframe body 的 childList（无 subtree），编辑器 div 内部的 composition 文本变化不触发；ensureTextFormatBar 只在 update() 轮询时运行，composition 期间无 emit/render。守卫只存在于各 handler 的 textBarUsable()，视觉禁用态从未应用。'});
        const pass7=check('composing 期间浮条按钮全部 disabled/aria-disabled，compositionend 后恢复可用',
          barDisabledThroughout&&afterEnd.barEnabledAgain,{barDisabledThroughout,afterEnd,samples:samples.map(s=>s.bar.ariaDisabled)});      }

      /* ---------- check 3：选区加粗 → runs → 重开还原 ---------- */
      {
        const opened=await openEditor(textId);
        const div=opened.div,bar=opened.bar;
        const selected=selectOffsets(div,0,1);
        const boldBtn=bar.querySelector('[data-doc-format="bold"]');
        boldBtn.click(); await wait(120);
        const runs=richOf(textId)?.runs;
        const validation=rt.validateRuns(runs||[],richOf(textId)?.text||'');
        await closeEditor();
        const reopened=await openEditor(textId);
        const nodeWeight=[...reopened.div.childNodes].filter(n=>n.nodeType===1).map(el=>({text:el.textContent,weight:frameWin.getComputedStyle(el).fontWeight}));
        const danWeight=(nodeWeight.find(x=>x.text.includes('氮'))||{}).weight;
        await closeEditor();
        const pass=check('选区加粗写入 runs、validateRuns 通过且重开编辑器后该字 fontWeight>=600',
          selected&&Array.isArray(runs)&&runs.some(r=>r.bold===true&&r.start===0&&r.end===1)&&validation.ok&&Number(danWeight)>=600,
          {selected,runs,validation,nodeWeight,danWeight});
      }

      /* ---------- check 4：上下标（applyTextFormat）+ 保存重开保留 ---------- */
      let idW,idS;
      {
        idW=paper.addText({x:50,y:20,w:16,h:4,text:'H2O'});
        idS=paper.addText({x:50,y:28,w:16,h:4,text:'SO42-'});
        paper.applyTextFormat(idW,{start:1,end:2},{sub:true});
        paper.applyTextFormat(idS,{start:3,end:5},{sup:true});
        await wait(150);
        const subTspans=textTspans(idW).map(t=>({shift:t.getAttribute('baseline-shift'),text:t.textContent,children:[...t.querySelectorAll('tspan')].map(c=>({shift:c.getAttribute('baseline-shift'),text:c.textContent}))}));
        const supTspans=textTspans(idS).map(t=>({children:[...t.querySelectorAll('tspan')].map(c=>({shift:c.getAttribute('baseline-shift'),text:c.textContent}))}));
        const hasSub=subTspans.some(t=>[t,...t.children].some(c=>c.shift==='sub'&&c.text==='2'));
        const hasSup=supTspans.some(t=>t.children.some(c=>c.shift==='super'&&c.text==='2-'));
        const runsW=JSON.stringify(richOf(idW)?.runs||[]),runsS=JSON.stringify(richOf(idS)?.runs||[]);
        window.__idW=idW; window.__idS=idS;
        const saved=await serialize();
        await k3dAPI.loadWorkbench(saved); await wait(400);
        const refs=refresh();
        const hasSub2=textTspans(idW).some(t=>[t,...t.querySelectorAll('tspan')].some(c=>c.getAttribute('baseline-shift')==='sub'&&c.textContent==='2'));
        const hasSup2=textTspans(idS).some(t=>[t,...t.querySelectorAll('tspan')].some(c=>c.getAttribute('baseline-shift')==='super'&&c.textContent==='2-'));
        const runsW2=JSON.stringify(textObject(idW)?.rich?.runs||[]),runsS2=JSON.stringify(textObject(idS)?.rich?.runs||[]);
        const pass=check('H2O/SO42- 上下标 tspan baseline-shift 正确，保存重开保留且 rich.runs 原样',
          hasSub&&hasSup&&hasSub2&&hasSup2&&runsW===runsW2&&runsS===runsS2,
          {hasSub,hasSup,hasSub2,hasSup2,runsW,runsW2,runsS,runsS2,subTspans,
            gW:frameDoc.querySelector('[data-doc-id="'+idW+'"]')?.outerHTML,gS:frameDoc.querySelector('[data-doc-id="'+idS+'"]')?.outerHTML,
            defectNote:(hasSub&&hasSup)?undefined:'renderObject/renderRichLine 缺陷：样式化子 tspan 后若同一行还有未样式化段，renderRichSegment 会用 target.textContent+= 续写父级行 tspan，textContent 赋值清空了先前 appendChild 的子 tspan（下标/上标被吞并进父级文本）。SO4 的 2- 恰为行尾段所以幸存；H2O 的 2 后跟 O 被吞。详见 gW/gS 对比。'});
      }

      /* ---------- check 5：折叠光标延续格式（零宽 span） ---------- */
      {
        const idC=paper.addText({x:20,y:40,w:16,h:4,text:'氮'});
        const opened=await openEditor(idC);
        const div=opened.div,bar=opened.bar;
        setCaretOffset(div,1); // 光标置于末尾
        const colorInput=bar.querySelector('[data-doc-format="color"]');
        colorInput.value='#ff0000';
        colorInput.dispatchEvent(new Event('input',{bubbles:true}));
        await wait(80);
        const zeroSpanInserted=div.innerHTML.includes('\\u200B');
        frameDoc.execCommand('insertText',false,'红');
        await wait(60);
        const editorText=div.textContent;
        await closeEditor();
        const rich=richOf(idC)||{};
        const richRuns=rich.runs||[];
        const redRun=richRuns.find(r=>r.color==='#ff0000');
        const redCovered=!!redRun&&rich.text.indexOf('红')>=redRun.start&&rich.text.indexOf('红')<redRun.end;
        const validation=rt.validateRuns(richRuns,rich.text||'');
        const noZwsp=!(rich.text||'').includes('\u200b');
        const pass=check('折叠光标选红色后新输入字符 run.color=红，零宽字符被剥离',
          editorText.includes('红')&&noZwsp&&redCovered&&validation.ok,
          {editorText,zeroSpanInserted,text:rich.text,runs:richRuns,redRun,redCovered,validation,defectNote:redCovered?undefined:'finishTextEdit 先剥离 \\u200b 再 normalizeRuns：红色 run 偏移未随剥离左移，越界 run 被丢弃（如实记录）'});
        window.__idC=idC;
      }

      /* ---------- check 6：中文换行 textLines/layoutLines/重排 ---------- */
      {
        const longText='纸页文本框中文自动换行回归测试段落需要足够长的连续中文内容才能触发断行行为验证';
        const idN=paper.addText({x:20,y:50,w:8,h:10,text:longText});
        await wait(120);
        const o=()=>textObject(idN);
        const fs=number(richOf(idN).fontSize)/paper.state.ptPerBond;
        function number(v){return typeof v==='number'&&Number.isFinite(v)?v:12;}
        const lines1=paper.textLines(o());
        const layout1=rt.layoutLines(richOf(idN),o().w,fs);
        const narrowOk=lines1.length>1&&lines1.length===layout1.lines.length;
        const narrowLines=lines1.length;
        paper.updateObject(idN,{w:32});
        await wait(150);
        const lines2=paper.textLines(o());
        const layout2=rt.layoutLines(richOf(idN),o().w,fs);
        const reflowOk=lines2.length<narrowLines&&lines2.length===layout2.lines.length;
        const tspans=textTspans(idN).map(t=>({x:t.getAttribute('x'),y:t.getAttribute('y')}));
        const xs=[...new Set(tspans.map(t=>t.x))];
        const xOk=xs.length===1&&Math.abs(Number(xs[0])-o().x)<0.01;
        const pass=check('窄框长中文按 textLines=layoutLines 断行；加宽后重排且各行 tspan x 同一起点',
          narrowOk&&reflowOk&&xOk,
          {narrowLines,wideLines:lines2.length,narrowOk,reflowOk,xs,objectX:o().x,xOk,tspans,narrowText:lines1,wideText:lines2});
        window.__idN=idN;
      }

      /* ---------- check 8：复制粘贴 + sanitize ---------- */
      {
        const idP=paper.addText({x:20,y:70,w:30,h:4,text:'普通'});
        await wait(100);
        const opened=await openEditor(idP);
        const div=opened.div;
        setCaretOffset(div,2);
        const evilScript='window.__imePastePwned=1';
        const html='<span style="font-weight:700">粗</span><span style="color:#00aa00">绿</span><script>'+evilScript+'<\\/script><style>p{color:red}</style>';
        const dt=new DataTransfer();
        dt.setData('text/html',html); dt.setData('text/plain','粗绿');
        let ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});
        if(!ev.clipboardData){ev=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(ev,'clipboardData',{value:dt});}
        div.dispatchEvent(ev);
        await wait(120);
        const insertedText=div.textContent;
        const scriptRan=frameWin.__imePastePwned===1;
        await closeEditor();
        const rich=richOf(idP)||{};
        const text=rich.text||'';
        const boldOk=(rich.runs||[]).some(r=>r.bold===true&&text.slice(r.start,r.end)==='粗');
        const greenOk=(rich.runs||[]).some(r=>r.color==='#00aa00'&&text.slice(r.start,r.end)==='绿');
        const pass=check('粘贴 text/html 走 sanitize：runs 正确、script/style 剥离',
          insertedText.includes('粗绿')&&!insertedText.includes(evilScript)&&!scriptRan&&boldOk&&greenOk,
          {insertedText,scriptRan,text,runs:rich.runs,boldOk,greenOk});
        window.__idP=idP;
      }

      /* ---------- check 9：保存重开总验证 ---------- */
      {
        // 整框排版属性（对齐/行距）通过 rich 直接更新（浮条 applyTextParagraph 同一落点）
        const idN=window.__idN;
        paper.updateObject(idN,{rich:{...richOf(idN),align:'center',lineHeight:1.8}});
        await wait(120);
        const saved=await serialize();
        await k3dAPI.loadWorkbench(saved); await wait(400);
        const ctrl=MolWorkbench.app.documentController;
        const obj=id=>ctrl.getState().objects.find(o=>o.id===id);
        const textId=window.__imeTextId;
        const richText=obj(textId)?.rich||{},richW=obj(window.__idW)?.rich||{},richS=obj(window.__idS)?.rich||{},richN=obj(idN)?.rich||{},richP=obj(window.__idP)?.rich||{},richC=obj(window.__idC)?.rich||{};
        const boldKept=(richText.runs||[]).some(r=>r.bold===true);
        const subKept=(richW.runs||[]).some(r=>r.sub===true),supKept=(richS.runs||[]).some(r=>r.sup===true);
        const colorKept=(richC.runs||[]).some(r=>r.color==='#ff0000'&&(richC.text||'').slice(r.start,r.end)==='红');
        const paraKept=richN.align==='center'&&richN.lineHeight===1.8;
        const subSvg=textTspans(window.__idW).some(t=>[t,...t.querySelectorAll('tspan')].some(c=>c.getAttribute('baseline-shift')==='sub'));
        const reopen=await new Promise(async resolve=>{const r=ctrl.editText(textId);await wait(120);resolve({r,div:frameDoc.getElementById('molstudio-document-editor'),bar:hostDoc.getElementById('molstudio-text-format-bar')});});
        const reEditable=!!reopen.r&&!!reopen.div&&reopen.div.contentEditable==='true';
        ctrl.finishTextEdit(); await wait(100);
        const pass=check('保存重开后 bold/sub/sup/color/对齐/行距全部保留且可继续编辑',
          boldKept&&subKept&&supKept&&colorKept&&paraKept&&subSvg&&reEditable,
          {boldKept,subKept,supKept,colorKept,paraKept,subSvg,reEditable,richText,richN,richP,
            defectNote:(boldKept&&subKept&&supKept&&colorKept&&paraKept&&subSvg)?undefined:'colorKept/subSvg 为 False 由 check5（红色 run 被剥离零宽字符后偏移越界丢弃）与 check4（sub tspan 被吞）两个缺陷传导，非保存/重开本身丢失。'});
      }

      return {checks,sample:{textId,w:window.__idW,s:window.__idS,n:window.__idN,p:window.__idP},source:await k3dAPI.serializeWorkbench()};
    })()`);
    report.checks = result.checks;
    report.artifacts.editableSample = path.join(out, 'ime-rich-sample.molwork');
    fs.writeFileSync(report.artifacts.editableSample, result.source);
    await wait(120);
    report.artifacts.canvasScreenshot = path.join(out, 'canvas.png');
    fs.writeFileSync(report.artifacts.canvasScreenshot, (await win.capturePage()).toPNG());
    report.ok = report.checks.every(check => check.pass);
  } catch (error) {
    report.ok = false; report.error = String(error?.stack || error);
    if (win && !win.isDestroyed()) {
      const checks = await win.webContents.executeJavaScript('window.__documentImeRichChecks || []').catch(() => []);
      if (checks.length > report.checks.length) report.checks = checks;
    }
  } finally {
    if (win && !win.isDestroyed()) {
      try {
        if (!report.artifacts.canvasScreenshot) {
          report.artifacts.failureScreenshot = path.join(out, 'failure.png');
          fs.writeFileSync(report.artifacts.failureScreenshot, (await win.capturePage()).toPNG());
        }
      } catch (error) { report.captureError = String(error?.message || error); }
    }
    report.finishedAt = new Date().toISOString(); report.artifactDirectory = out; writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(check => check.pass).length,
      total: report.checks.length, failures: report.checks.filter(check => !check.pass), error: report.error,
      browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main).catch(error => {
  report.ok = false; report.error = String(error?.stack || error); report.finishedAt = new Date().toISOString();
  report.artifactDirectory = out; writeReport(); console.error(report.error); app.exit(1);
});
