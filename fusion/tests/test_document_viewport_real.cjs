'use strict';
// Current fusion/canvas.html, real Ketcher navigation, no model or clipboard.
// Start the isolated service first, then run with matching MOLSTUDIO_PORT:
// MOLSTUDIO_PORT=49078 MOLSTUDIO_TEST_BUILD='source checkout: fusion/canvas.html' \
//   MOLSTUDIO_AGENT_TEST_OUT=/absolute/ignored/artifact/path \
//   env -u ELECTRON_RUN_AS_NODE fusion/node_modules/.bin/electron fusion/tests/test_document_viewport_real.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.env.MOLSTUDIO_PORT) || 49078;
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8462) throw new Error('Use a valid isolated canvas service port');
const out = path.resolve(process.env.MOLSTUDIO_AGENT_TEST_OUT || path.join(__dirname, '../../.jez/artifacts/document-viewport-real'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-document-viewport-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', profile);
const report = {
  application: 'MolStudio current canvas', page: 'fusion/canvas.html',
  pageURL: `http://127.0.0.1:${port}/canvas.html`,
  build: process.env.MOLSTUDIO_TEST_BUILD || 'current source checkout, isolated Electron window',
  fixture: 'F01 chemistry on A4 paper, then three-page continuous document',
  modelCalls: 0, checks: [], browserErrors: [], artifacts: {}, startedAt: new Date().toISOString(),
};
let win;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
function check(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, detail });
  if (!pass) throw new Error(name + ': ' + JSON.stringify(detail));
}
function viewBoxDeltaCSS(before, after) {
  const a = before.viewBox.split(/[\s,]+/).map(Number), b = after.viewBox.split(/[\s,]+/).map(Number);
  if (a.length !== 4 || b.length !== 4 || ![...a, ...b, before.rawZoom, after.rawZoom].every(Number.isFinite)) return Infinity;
  return Math.max(...a.map((value, i) => Math.abs(value - b[i]))) * Math.max(before.rawZoom, after.rawZoom);
}
function sameViewBox(before, after) {
  // The product ignores corrections below .01 CSS px. Compare on-screen
  // movement, since one SVG user unit covers far less than one px at overview.
  return viewBoxDeltaCSS(before, after) < .03;
}
function checkGeometry(name, state) {
  const near = (a, b) => Math.abs(a - b) < .3;
  const x = state.doc.width < state.area.width * .6
    ? near(state.doc.left + state.doc.width / 2, state.area.left + state.area.width / 2)
    : state.blank.left <= .2003 && state.blank.right <= .2003;
  const y = state.doc.height < state.area.height * .6
    ? near(state.doc.top + state.doc.height / 2, state.area.top + state.area.height / 2)
    : state.blank.top <= .2003 && state.blank.bottom <= .2003;
  check(name, x && y, state);
}
const watchdog = setTimeout(() => {
  report.ok = false; report.error = 'Paper viewport acceptance watchdog expired';
  writeReport(); win?.destroy(); app.exit(2);
}, 90_000);

async function main() {
  win = new BrowserWindow({ show: true, width: 1460, height: 1160, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.browserErrors.push(String(message)); });
  win.webContents.on('render-process-gone', (_event, details) => report.browserErrors.push(`renderer process gone: ${JSON.stringify(details)}`));
  const js = code => win.webContents.executeJavaScript(code);
  const snapshot = () => js('window.__paperViewportAcceptance.snapshot()');
  const screenshot = async (key, filename) => {
    report.artifacts[key] = path.join(out, filename);
    fs.writeFileSync(report.artifacts[key], (await win.capturePage()).toPNG());
  };
  const wheel = async (dx, dy, shift = false) => {
    await js(`window.__paperViewportAcceptance.wheel(${dx},${dy},${shift})`); await wait(100);
  };
  try {
    await win.loadURL(report.pageURL);
    const ready = await js(`(async()=>{const start=Date.now();while(Date.now()-start<30000){if(k3dAPI?.workbenchReady?.()&&MolStudio?.document)return true;await new Promise(r=>setTimeout(r,100));}return false;})()`);
    if (!ready) throw new Error('Current canvas/document controller did not become ready');
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/workbench-mechanism/F01.molwork'), 'utf8');
    const loaded = await js(`k3dAPI.loadWorkbench(${JSON.stringify(fixture)})`);
    if (!loaded?.ok) throw new Error('F01 failed to load: ' + JSON.stringify(loaded));
    await js(`(()=>{
      const app=MolWorkbench.app,c=app.documentController,a=app.adapter,ed=a.ed,paper=MolStudio.document;
      const frame=document.getElementById('k');
      paper.init({mode:'paper',pageSetup:{size:'A4',orientation:'portrait'}});
      for(const atom of a.struct().atoms.values()){atom.pp.x+=7;atom.pp.y+=24;}
      ed.update(true);app.controller.render();
      paper.addText({x:7,y:7,w:27,h:3,text:'Paper navigation: 20% outer blank limit'});
      paper.addShape({x:7,y:12,w:27,h:5,shape:'rect',fill:'#e0f2fe',stroke:{color:'#147da5',width:.07}});
      window.__paperViewportAcceptance={
        snapshot(){
          const pages=MolWorkbench.documentModel.pageRects(c.state),first=pages[0],last=pages.at(-1);
          const f=frame.getBoundingClientRect(),r=c.usablePaperArea();
          const start=c.modelToClient({x:first.x,y:first.y}),end=c.modelToClient({x:last.x+last.w,y:last.y+last.h});
          const area={left:r.left+f.left,top:r.top+f.top,width:r.width,height:r.height};
          const doc={left:start.x,top:start.y,width:end.x-start.x,height:end.y-start.y};
          return {area,doc,blank:{left:Math.max(0,doc.left-area.left)/area.width,
            right:Math.max(0,area.left+area.width-doc.left-doc.width)/area.width,
            top:Math.max(0,doc.top-area.top)/area.height,
            bottom:Math.max(0,area.top+area.height-doc.top-doc.height)/area.height},
            viewStart:a.clientToModel({x:r.left,y:r.top}),viewBox:a.canvasSvg().getAttribute('viewBox'),
            zoom:paper.getPaperZoom(),rawZoom:a.zoom(),activePage:c.getActivePage().id,history:ed.historySize(),dirty:window.__mechDirtyTick||0};
        },
        wheel(dx,dy,shift){const r=c.usablePaperArea();
          const point={clientX:r.left+r.width/2,clientY:r.top+r.height/2};
          const target=frame.contentDocument.elementFromPoint(point.clientX,point.clientY);
          target.dispatchEvent(new frame.contentWindow.WheelEvent('wheel',{...point,deltaX:dx,deltaY:dy,
            shiftKey:shift,bubbles:true,cancelable:true}));},
        pan(dx,dy){ed.render.setViewBox(v=>({...v,minX:v.minX+dx,minY:v.minY+dy}));},
        ed,c,a,paper,frame
      };
      paper.setPaperZoom(100);paper.fitPage();
    })()`);
    await wait(500);
    const initialSource = await js('k3dAPI.serializeWorkbench()');
    const initialState = await snapshot();
    checkGeometry('fit page keeps paper within the blank limit or centered on a small axis', initialState);

    await js('MolStudio.document.setPaperZoom(125)'); await wait(100);
    checkGeometry('paper zoom corrects pan to preserve the blank limit', await snapshot());
    await wheel(-100000, -100000);
    let state = await snapshot();
    checkGeometry('ordinary diagonal wheel stops at the first-page top and left boundaries', state);
    check('top and left outer blank space stop at 20%', Math.abs(state.blank.left - .2) < .001 && Math.abs(state.blank.top - .2) < .001, state.blank);
    const topLeft = state;
    await wheel(-100000, -100000);
    const repeatedTopLeft = await snapshot();
    check('continued outward wheel input does not move the page', sameViewBox(repeatedTopLeft, topLeft),
      { before: topLeft.viewBox, after: repeatedTopLeft.viewBox, movementCSS: viewBoxDeltaCSS(repeatedTopLeft, topLeft) });
    await screenshot('topLeftBoundaryScreenshot', 'paper-top-left-limit.png');

    await wheel(100000, 100000);
    state = await snapshot();
    checkGeometry('ordinary diagonal wheel stops at the last-page bottom and right boundaries', state);
    check('bottom and right outer blank space stop at 20%', Math.abs(state.blank.right - .2) < .001 && Math.abs(state.blank.bottom - .2) < .001, state.blank);
    await wheel(0, -100000, true);
    state = await snapshot();
    checkGeometry('Shift-wheel uses the same horizontal boundary', state);
    check('Shift-wheel reaches the left 20% boundary', Math.abs(state.blank.left - .2) < .001, state.blank);
    await screenshot('bottomBoundaryScreenshot', 'paper-bottom-limit.png');

    // Real mouse events must reach Ketcher's hand tool, not only a test-only pan.
    await js(`(()=>{const t=__paperViewportAcceptance;t.paper.setPaperZoom(125);t.paper.scrollToPage(t.paper.getState().pages[0].id);t.ed.tool('hand');})()`);
    await wait(100);
    const beforeHand = await snapshot();
    const start = { x: Math.round(beforeHand.area.left + beforeHand.area.width * .4), y: Math.round(beforeHand.area.top + beforeHand.area.height * .35) };
    const end = { x: Math.round(beforeHand.area.left + beforeHand.area.width * .9), y: Math.round(beforeHand.area.top + beforeHand.area.height * .85) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...start }); await wait(30);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
    for (let step = 1; step <= 8; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left',
        x: Math.round(start.x + (end.x - start.x) * step / 8), y: Math.round(start.y + (end.y - start.y) * step / 8) });
      await wait(20);
    }
    await wait(150);
    const afterHand = await snapshot();
    check('real hand drag changes the viewport', !sameViewBox(afterHand, beforeHand),
      { before: beforeHand.viewBox, after: afterHand.viewBox, movementCSS: viewBoxDeltaCSS(afterHand, beforeHand) });
    checkGeometry('real hand drag stops at the same 20% bounds', afterHand);
    check('real hand drag reaches an outer boundary', Math.abs(afterHand.blank.left - .2) < .001 || Math.abs(afterHand.blank.top - .2) < .001, afterHand.blank);
    // Reverse while the same mouse gesture is still held down, after moving
    // well beyond the boundary. Even a short reverse movement must take effect.
    const reverse = { x: end.x - 32, y: end.y - 32 };
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', ...reverse }); await wait(100);
    const afterReverse = await snapshot();
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...reverse }); await wait(80);
    const reversedX = afterReverse.doc.left - afterHand.doc.left, reversedY = afterReverse.doc.top - afterHand.doc.top;
    const touchedLeft = Math.abs(afterHand.blank.left - .2) < .001, touchedTop = Math.abs(afterHand.blank.top - .2) < .001;
    check('a short reverse hand movement immediately returns from the boundary',
      (!touchedLeft || reversedX < -10) && (!touchedTop || reversedY < -10),
      { touchedLeft, touchedTop, requestedCSS: { x: -32, y: -32 }, actualCSS: { x: reversedX, y: reversedY } });
    checkGeometry('reverse hand movement remains inside the paper bounds', afterReverse);

    await js('MolStudio.document.setPaperZoom(20)'); await wait(100);
    await wheel(100000, -100000); state = await snapshot();
    check('zoomed-out document is smaller than 60% on both axes', state.doc.width < state.area.width * .6 && state.doc.height < state.area.height * .6, state);
    checkGeometry('small paper stays centered instead of drifting into blank space', state);
    const smallView = state;
    await wheel(-100000, 100000);
    const repeatedSmall = await snapshot();
    check('small centered paper ignores further outward movement', sameViewBox(repeatedSmall, smallView),
      { before: smallView.viewBox, after: repeatedSmall.viewBox, movementCSS: viewBoxDeltaCSS(repeatedSmall, smallView) });
    await screenshot('smallPaperScreenshot', 'paper-small-centered.png');

    // View-only navigation must not alter chemistry, document state or history.
    const viewSource = await js('k3dAPI.serializeWorkbench()');
    const viewState = await snapshot();
    check('single-page navigation and zoom leave document/history/dirty state unchanged',
      viewSource === initialSource && JSON.stringify(viewState.history) === JSON.stringify(initialState.history) && viewState.dirty === initialState.dirty,
      { sourceUnchanged: viewSource === initialSource, historyBefore: initialState.history, historyAfter: viewState.history, dirtyBefore: initialState.dirty, dirtyAfter: viewState.dirty });

    await js(`(()=>{const t=__paperViewportAcceptance;t.ed.tool('select');t.paper.addPage();t.paper.addPage();t.paper.setPaperZoom(100);t.paper.scrollToPage(t.paper.getState().pages[0].id);})()`);
    await wait(200);
    const multipleSource = await js('k3dAPI.serializeWorkbench()');
    const multiBefore = await snapshot();
    await wheel(0, 1000); const mid = await snapshot();
    check('multi-page wheel scrolls continuously past the first page', mid.viewStart.y > multiBefore.viewStart.y + 5, { before: multiBefore.viewStart, after: mid.viewStart });
    checkGeometry('multi-page intermediate scroll retains horizontal paper bounds', mid);
    await wheel(0, 100000); const last = await snapshot();
    checkGeometry('multi-page document stops at the bottom of the final page', last);
    check('final page bottom blank is 20%', Math.abs(last.blank.bottom - .2) < .001, last.blank);
    const lastView = last;
    await wheel(0, 100000);
    const repeatedLast = await snapshot();
    check('continued scroll cannot leave the final page behind', sameViewBox(repeatedLast, lastView),
      { before: lastView.viewBox, after: repeatedLast.viewBox, movementCSS: viewBoxDeltaCSS(repeatedLast, lastView) });
    await js(`(()=>{const t=__paperViewportAcceptance;t.paper.scrollToPage(t.paper.getState().pages[1].id);})()`); await wait(100);
    state = await snapshot();
    check('page navigation still reaches the middle page', state.activePage === await js('MolStudio.document.getState().pages[1].id'), state);
    checkGeometry('page navigation respects the same document bounds', state);

    await js('MolWorkbench.app.documentUI.showPageSetup()'); await wait(100);
    await wheel(100000, -100000); state = await snapshot();
    checkGeometry('opening page settings recomputes the bounds using its reserved viewport', state);
    await js(`document.querySelector('#molstudio-document-panel [aria-label="关闭属性面板"]').click()`); await wait(100);
    checkGeometry('closing page settings recomputes the bounds again', await snapshot());
    win.setSize(900, 900); await wait(250);
    checkGeometry('resizing the actual editor preserves bounded navigation', await snapshot());
    win.setSize(1460, 1160); await wait(250);
    await js(`(()=>{const t=__paperViewportAcceptance;t.paper.fitPage(t.paper.getState().pages[1].id);})()`); await wait(150);
    const multiAfter = await snapshot();
    const multiAfterSource = await js('k3dAPI.serializeWorkbench()');
    check('multi-page navigation/settings/resize leave document/history/dirty state unchanged',
      multiAfterSource === multipleSource && JSON.stringify(multiAfter.history) === JSON.stringify(multiBefore.history) && multiAfter.dirty === multiBefore.dirty,
      { sourceUnchanged: multiAfterSource === multipleSource, historyBefore: multiBefore.history, historyAfter: multiAfter.history, dirtyBefore: multiBefore.dirty, dirtyAfter: multiAfter.dirty });
    report.artifacts.editableSample = path.join(out, 'paper-viewport-sample.molwork');
    fs.writeFileSync(report.artifacts.editableSample, multiAfterSource);
    await screenshot('multiPageScreenshot', 'paper-multi-page.png');

    await js(`(()=>{const t=__paperViewportAcceptance;t.paper.setPageSetup({mode:'canvas'});t.pan(100000,100000);})()`); await wait(100);
    const canvasView = await js(`(()=>{const t=__paperViewportAcceptance,r=t.c.usablePaperArea();return t.a.clientToModel({x:r.left,y:r.top});})()`);
    check('unbounded canvas mode still permits movement far outside the former paper', canvasView.x > 1000 && canvasView.y > 1000, canvasView);
    report.ok = report.checks.every(item => item.pass);
  } catch (error) {
    report.ok = false; report.error = String(error?.stack || error);
    if (win && !win.isDestroyed()) try { await screenshot('failureScreenshot', 'paper-viewport-failure.png'); } catch (_) {}
  } finally {
    report.finishedAt = new Date().toISOString(); report.artifactDirectory = out; writeReport();
    console.log(JSON.stringify({ ok: report.ok, passed: report.checks.filter(item => item.pass).length, total: report.checks.length,
      failures: report.checks.filter(item => !item.pass), error: report.error, browserErrors: report.browserErrors, artifacts: report.artifacts, out }, null, 2));
    clearTimeout(watchdog); win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(report.ok ? 0 : 1);
  }
}
app.whenReady().then(main).catch(error => {
  report.ok = false; report.error = String(error?.stack || error); report.finishedAt = new Date().toISOString();
  writeReport(); console.error(report.error); clearTimeout(watchdog); app.exit(1);
});
