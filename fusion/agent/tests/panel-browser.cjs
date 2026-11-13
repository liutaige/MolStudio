'use strict';
/* Isolated component smoke: run with Electron, never opens the MolStudio application. */
if (!process.versions.electron) {
  require('node:test').test('panel browser smoke (explicit Electron run)', { skip: 'Run with fusion/node_modules/.bin/electron fusion/agent/tests/panel-browser.cjs' }, () => {});
} else {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { app, BrowserWindow } = require(require.resolve('electron', { paths: [path.resolve(__dirname, '../..')] }));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-agent-panel-'));
  app.setPath('userData', path.join(out, 'profile'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const results = [], errors = [];
  let win;
  async function inspect(label, settings) {
    await sleep(50);
    const result = await win.webContents.executeJavaScript(`(() => {
      const panel=window.componentPanel,root=panel.element,rect=root.getBoundingClientRect();
      const overflow=[...root.querySelectorAll('button,input,textarea,.mol-agent-message-text,.mol-agent-field')].filter(n=>{
        if(!n.getClientRects().length)return false;
        const b=n.getBoundingClientRect();return b.right>rect.right+1||b.left<rect.left-1;
      }).map(n=>n.className);
      return {label:${JSON.stringify(label)},layout:panel.getLayout(),overflow,frameWidth:document.getElementById('k').getBoundingClientRect().width,panelHeight:rect.height,settings:${!!settings}};
    })()`);
    if (result.overflow.length) throw new Error('Panel overflow: ' + JSON.stringify(result));
    results.push(result);
    const rect = await win.webContents.executeJavaScript(`(()=>{const b=window.componentPanel.element.getBoundingClientRect();return {x:Math.floor(b.x),y:Math.floor(b.y),width:Math.ceil(b.width),height:Math.ceil(b.height)}})()`);
    const image = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(out, label + '.png'), image.toPNG());
  }
  app.whenReady().then(async () => {
    app.dock && app.dock.hide();
    win = new BrowserWindow({ show: false, width: 1360, height: 860, webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'agent-panel-smoke-' + Date.now() } });
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><style>html,body{margin:0;height:100%;overflow:hidden}#k{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id="k"></iframe></body></html>'));
    await win.webContents.insertCSS(fs.readFileSync(path.resolve(__dirname, '../panel.css'), 'utf8'));
    await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../dist/agent-runtime.js'), 'utf8'));
    await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname, '../panel.js'), 'utf8'));
    const reply = '**机理**\n\n- 式子 ' + String.raw`\(\ce{H2O + H+ -> H3O+}\)` + '\n- `CCBr`\n\n' + String.raw`\[\frac{k_1}{k_2}\]`;
    await win.webContents.executeJavaScript(`window.componentPanel=new MolStudioAgentPanel({open:true,onSend(){},onStop(){},onContinue(){},onSettingsLoad(){return {configured:true,model:'example-reasoning-model-long-name',baseUrl:'https://model.example/v1',maxTurns:24}}});
      const p=window.componentPanel;p.setConfig({configured:true,model:'example-reasoning-model-long-name',baseUrl:'https://model.example/v1',maxTurns:24});p.input.value='先讨论这步反应，再帮我补全机理。';p._send();
      p.handleEvent({type:'run_start',runId:'component-fixture'});p.handleEvent({type:'assistant_start',runId:'component-fixture'});p.handleEvent({type:'text_delta',runId:'component-fixture',delta:${JSON.stringify(reply)}});p.handleEvent({type:'assistant_end',runId:'component-fixture'});p.handleEvent({type:'plan',runId:'component-fixture',steps:[{id:'one',text:'读取选中的结构',status:'completed'},{id:'two',text:'补全推电子箭头',status:'running'}]});p.handleEvent({type:'tool_start',runId:'component-fixture',toolCallId:'t',toolName:'draw_operations'});p.handleEvent({type:'tool_progress',runId:'component-fixture',toolCallId:'t',progress:{phase:'committed',count:2}});`);
    const rendered = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.mol-agent-markdown');
      return body?.querySelector('strong')?.textContent === '机理' && body.querySelector('code')?.textContent === 'CCBr' &&
        body.querySelector('math msub')?.getBoundingClientRect().width > 0 &&
        body.querySelector('math[display="block"] mfrac')?.getBoundingClientRect().height > 0;
    })()`);
    if (!rendered) throw new Error('Markdown and MathML did not render in the browser');
    await inspect('desktop-conversation', false);
    win.setContentSize(960, 800); await inspect('compact-desktop', false);
    win.setContentSize(375, 850); await inspect('drawer-conversation', false);
    await win.webContents.executeJavaScript(`window.componentPanel.handleEvent({type:'run_end',runId:'component-fixture',status:'needs_continue',reason:'provider_length',turns:24,canContinue:true});window.componentPanel.showSettings();`);
    await inspect('drawer-settings', true);
    win.setContentSize(320, 800); await inspect('small-settings', true);
    await win.webContents.executeJavaScript(`window.componentPanel.setOpen(false)`);
    const restored = await win.webContents.executeJavaScript(`document.getElementById('k').getBoundingClientRect().width===window.innerWidth`);
    if (!restored) throw new Error('Closed panel did not restore canvas width');
    if (errors.length) throw new Error('Console errors: ' + errors.join('; '));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ scope: 'Isolated component fixture with synthetic UI events, not a real model or Ketcher session', results, errors, restored }, null, 2));
    console.log(JSON.stringify({ output: out, views: results.length, errors: errors.length, restored }));
    win.destroy(); app.quit();
  }).catch(error => { console.error(error.stack); if (win) win.destroy(); app.exit(1); });
}
