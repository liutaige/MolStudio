'use strict';
// Current canvas regression: actual double click + native 1.5s dirty polling.
// Run against an isolated source/build server with MOLSTUDIO_PORT and an
// absolute MOLSTUDIO_AGENT_TEST_OUT. IME events exercise application guards;
// Electron cannot synthesize the operating system's candidate-window pipeline.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const port = Number(process.env.MOLSTUDIO_PORT) || 49189;
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(os.tmpdir(), 'molstudio-text-snapshot-real'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-text-snapshot-profile-')));
const report = { application: 'MolStudio current canvas', page: 'fusion/canvas.html', pageURL: `http://127.0.0.1:${port}/canvas.html`, build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout: fusion/canvas.html', checks: [], modelCalls: 0, imeBoundary: 'DOM composition sequence exercises application guards; OS IME candidate windows are outside this runner.' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const watchdog = setTimeout(() => { report.error = 'Text snapshot regression timed out'; finish(2); }, 45000);
function finish(code) {
  clearTimeout(watchdog);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  win?.destroy(); app.exit(code);
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadURL(report.pageURL);
    await js(`(async()=>{for(let i=0;i<300;i++){if(window.k3dAPI?.workbenchReady?.()&&window.MolStudio?.document)return;await new Promise(r=>setTimeout(r,100));}throw Error('Canvas not ready')})()`);
    const point = await js(`(()=>{const c=MolWorkbench.app.documentController;c.init({mode:'paper'});c.fitPage();window.__textSnapshotId=c.addText({x:12,y:14,w:24,h:5,text:'已有文字'});c.setTool('select');const o=c.object(__textSnapshotId);return c.modelToClient({x:o.x+2,y:o.y+1.2})})()`);
    const p = { x: Math.round(point.x), y: Math.round(point.y) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    for (let clickCount = 1; clickCount <= 2; clickCount++) {
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...p });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...p });
      await wait(70);
    }
    await win.webContents.insertText(' 中文 H₂O');
    await js(`(()=>{const c=MolWorkbench.app.documentController;window.__textSnapshotChecks=[];window.__textSnapshotEditor=c.editor?.div;window.__textSnapshotHistory=JSON.stringify(c.adapter.ed.historySize());window.__textSnapshotModel=JSON.stringify(c.getState());window.__textSnapshotPolls=[];window.__textSnapshotTimer=setInterval(async()=>{try{__textSnapshotPolls.push({ok:true,data:JSON.parse(await k3dAPI.serializeWorkbench())});}catch(e){__textSnapshotPolls.push({ok:false,error:String(e.message||e)});}},1500)})()`);
    await wait(3300);
    const result = await js(String.raw`(async()=>{
      clearInterval(__textSnapshotTimer);
      const c=MolWorkbench.app.documentController,ed=c.adapter.ed;
      const checks=__textSnapshotChecks;
      const check=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});
      const expected='已有文字 中文 H₂O';
      check('double-click text editor survives two native 1.5 second dirty snapshots',c.editor?.div===__textSnapshotEditor&&c.editor.div.isConnected&&c.doc.activeElement===c.editor.div,{polls:__textSnapshotPolls.length,editor:!!c.editor});
      check('each snapshot includes the current text draft without mutating model or history',__textSnapshotPolls.length>=2&&__textSnapshotPolls.every(p=>p.ok&&p.data.document.objects.find(o=>o.id===__textSnapshotId)?.rich.text===expected)&&JSON.stringify(c.getState())===__textSnapshotModel&&JSON.stringify(ed.historySize())===__textSnapshotHistory,{snapshots:__textSnapshotPolls.map(p=>p.ok?p.data.document.objects.find(o=>o.id===__textSnapshotId)?.rich.text:p.error),modelText:c.object(__textSnapshotId).rich.text});
      if(!c.editor)c.editText(__textSnapshotId);
      const beforeSelection=JSON.stringify(c.getSelection());
      k3dAPI.selectAll();
      check('native Select All selects editor text and preserves the canvas selection',c.win.getSelection().toString()===expected&&JSON.stringify(c.getSelection())===beforeSelection,{selected:c.win.getSelection().toString()});
      c.finishTextEdit();
      const completed=JSON.parse(await k3dAPI.serializeWorkbench());
      check('finishing the text edit commits its complete draft',completed.document.objects.find(o=>o.id===__textSnapshotId)?.rich.text===expected,{text:c.object(__textSnapshotId).rich.text});
      k3dAPI.undo();
      check('one canvas undo restores the text before the editing session',c.object(__textSnapshotId).rich.text==='已有文字',{text:c.object(__textSnapshotId).rich.text});
      k3dAPI.redo();
      check('redo restores the complete edited text',c.object(__textSnapshotId).rich.text===expected,{text:c.object(__textSnapshotId).rich.text});
      const ui=MolWorkbench.app.documentUI;
      const selectEditor=()=>{const r=c.doc.createRange();r.selectNodeContents(c.editor.div);const sel=c.win.getSelection();sel.removeAllRanges();sel.addRange(r);};
      for (const patch of [{color:'#ff0000'},{fontSize:18},{fontFamily:'Times New Roman, Songti SC, serif'}]) {
        const id=c.addText({x:12,y:22,w:24,h:5,text:'base'});c.editText(id);
        c.doc.execCommand('insertText',false,' newly typed');selectEditor();ui.applySelectionRich(patch);
        const snap=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id);
        const key=Object.keys(patch)[0];
        check('changing '+key+' preserves newly typed draft text and its selected format',c.editor?.div.textContent==='base newly typed'&&snap.rich.text==='base newly typed'&&snap.rich.runs?.some(run=>run.start===0&&run.end===16&&(key==='fontFamily'?String(run[key]).replace(/[\"'\s]/g,'')===patch[key].replace(/[\"'\s]/g,''):run[key]===patch[key])),{text:c.editor?.div.textContent,rich:snap.rich});
        c.finishTextEdit();
      }
      {
        const id=c.addText({x:12,y:30,w:24,h:5,text:'base'});c.editText(id);
        c.doc.execCommand('insertText',false,' newly typed');selectEditor();ui.applyTextStyle('bold','bold');
        const bold=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id).rich;
        selectEditor();ui.applyTextStyle('bold','bold');
        const plain=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id).rich;
        check('bold formatting keeps new draft text and toggles off consistently',bold.text==='base newly typed'&&bold.runs?.some(run=>run.bold===true)&&plain.text==='base newly typed'&&!(plain.runs||[]).some(run=>run.bold===true),{bold,plain});
        c.finishTextEdit();
      }
      {
        const id=c.addText({x:12,y:36,w:24,h:5,text:'base'});const before=JSON.stringify(c.object(id).rich),history=JSON.stringify(ed.historySize());c.editText(id);
        const snap=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id);
        c.finishTextEdit();
        check('opening and closing default text creates no font run, dirty snapshot, or undo entry',JSON.stringify(snap.rich)===before&&JSON.stringify(c.object(id).rich)===before&&JSON.stringify(ed.historySize())===history,{before,snapshot:snap.rich,history:ed.historySize()});
      }
      for (const count of [1,2]) {
        const id=c.addText({x:12,y:40,w:24,h:5,text:'base'});c.editText(id);
        for(let i=0;i<count;i++)c.doc.execCommand('insertParagraph');
        c.doc.execCommand('insertText',false,'second');
        const expectedLines='base'+'\n'.repeat(count)+'second';
        const snap=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id);
        c.finishTextEdit();
        check(count+' actual Enter paragraph(s) preserve newline order in snapshots and committed text',snap.rich.text===expectedLines&&c.object(id).rich.text===expectedLines,{expected:expectedLines,snapshot:snap.rich.text,committed:c.object(id).rich.text});
      }
      {
        const id=c.addText({x:12,y:45,w:24,h:5,text:'first\nsecond'});c.editText(id);
        const div=c.editor.div,walker=c.doc.createTreeWalker(div,c.win.NodeFilter.SHOW_TEXT);let node,last;while(node=walker.nextNode())last=node;
        const range=c.doc.createRange();range.setStart(last,0);range.setEnd(last,3);const sel=c.win.getSelection();sel.removeAllRanges();sel.addRange(range);
        ui.applySelectionRich({color:'#ff0000'});
        const selection=sel.rangeCount?[ui.textOffsetOf(div,sel.getRangeAt(0).startContainer,sel.getRangeAt(0).startOffset),ui.textOffsetOf(div,sel.getRangeAt(0).endContainer,sel.getRangeAt(0).endOffset)]:null;
        const snap=JSON.parse(await k3dAPI.serializeWorkbench()).document.objects.find(o=>o.id===id);
        check('second-line formatting counts BR and retains the selected text range',snap.rich.text==='first\nsecond'&&snap.rich.runs?.some(run=>run.start===6&&run.end===9&&run.color==='#ff0000')&&selection?.[0]===6&&selection?.[1]===9,{rich:snap.rich,selection});
        c.finishTextEdit();
      }
      c.editText(__textSnapshotId);
      const div=c.editor.div,child=div.firstChild,Composition=c.win.CompositionEvent;
      div.dispatchEvent(new Composition('compositionstart',{bubbles:true,data:'dan'}));
      div.appendChild(c.doc.createTextNode('氮'));
      let blocked=false;try{await k3dAPI.serializeWorkbench()}catch(e){blocked=/输入法/.test(e.message)}
      check('snapshots reject active IME composition without closing or committing the editor',blocked&&c.editor?.div===div&&c.editor.composing&&!c.editor.pendingFinish&&c.object(__textSnapshotId).rich.text===expected,{blocked,editor:!!c.editor,pendingFinish:!!c.editor?.pendingFinish});
      div.dispatchEvent(new Composition('compositionend',{bubbles:true,data:'氮'}));
      const confirmed=JSON.parse(await k3dAPI.serializeWorkbench());
      check('confirmed IME text appears once in a snapshot while its DOM stays intact',confirmed.document.objects.find(o=>o.id===__textSnapshotId)?.rich.text===expected+'氮'&&c.editor?.div===div&&div.firstChild===child,{text:confirmed.document.objects.find(o=>o.id===__textSnapshotId)?.rich.text});
      const saved=JSON.stringify(confirmed);
      c.finishTextEdit();await k3dAPI.loadWorkbench(saved);
      check('saving and reopening preserves the full draft including confirmed Chinese text',c.object(__textSnapshotId)?.rich.text===expected+'氮',{text:c.object(__textSnapshotId)?.rich.text});
      return checks;
    })()`);
    report.checks = result;
    report.ok = result.every(check => check.pass);
    fs.writeFileSync(path.join(out, 'canvas.png'), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(report, null, 2)); finish(report.ok ? 0 : 1);
  } catch (error) { report.error = String(error.stack || error); report.ok = false; console.error(report.error); finish(1); }
});
