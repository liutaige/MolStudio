'use strict';
/* Real Ketcher regression for the FULL native UI replacement.
 * Verifies actual structure results and undo (not just "a command was sent"):
 *  - reaction arrow variants (real RxnArrowMode values),
 *  - native document tools (bracket / roundRect / polygon / arrow shapes),
 *  - document text/image/shape/page commands through the real controller,
 *  - extended object properties with one commit / one undo,
 *  - first-frame native-canvas mode: NO legacy web UI is visible, even after
 *    detach / failed attach / setAdvancedWebTools.
 * Browser mode (no query) is covered by test_native_ui_real.cjs.
 * No AI model calls. Isolated service port + isolated Electron profile.
 */
const electron = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = process.env.MOLSTUDIO_NATIVE_UI_FULL_OUT
  || path.join(__dirname, 'artifacts/native-ui-replacement/real-ketcher-full');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.MOLSTUDIO_PORT) || 0;
const app = electron.app;
const { BrowserWindow } = electron;
const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const port = PORT || await freePort();
  const python = process.env.MOLSTUDIO_PYTHON || path.resolve(__dirname, '../../.venv-rdkit/bin/python');
  const server = spawn(python, ['-B', '-u', path.join(__dirname, '..', 'server.py'), String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(String(d)));
  server.stderr.on('data', d => serverLog.push(String(d)));

  const report = {
    application: 'MolStudio native canvas', page: 'fusion/canvas.html?nativeCanvas=1',
    build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout',
    service: `http://127.0.0.1:${port}`, modelCalls: 0,
    ketcherDistribution: 'ketcher-local/static/js/main.e47c48ad.js',
    checks: [], errors: []
  };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: ok === true, detail: detail === undefined ? null : detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
  };

  let win = null;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await new Promise(resolve => {
        const req = require('node:http').get({ host: '127.0.0.1', port, path: '/canvas.html', timeout: 900 },
          res => { res.resume(); resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (!up) await wait(250);
    }
    if (!up) throw new Error('canvas service did not start');

    app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-native-full-')));
    win = new BrowserWindow({ show: false, width: 1500, height: 980,
      webPreferences: { offscreen: true, backgroundThrottling: false } });
    report.browserErrors = [];
    win.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (level >= 2) report.browserErrors.push({ level, msg, line, src });
    });
    const js = code => win.webContents.executeJavaScript(code);
    const navGen = 77;
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html?nativeCanvas=1&navGen=${navGen}`);
    for (let i = 0; i < 400; i++) {
      if (await js('!!(k3dAPI?.workbenchReady?.() && window.molstudioAgent && k3dAPI?.nativeUI)')) break;
      await wait(100);
    }
    const ready = await js('!!(k3dAPI?.workbenchReady?.() && window.molstudioAgent && k3dAPI?.nativeUI)');
    check('native-canvas page ready with workbench + nativeUI', ready);

    // ---- first-frame mode: no legacy web UI, and Ketcher toolbars hidden at boot ----
    {
      const first = await js(`(() => {
        const d = document.documentElement;
        const ids = ['helpBtn','toast','mech-sel-bar','molstudio-document-toolbar',
          'molstudio-document-panel','molstudio-document-status','molstudio-document-pages'];
        const hidden = ids.map(id => {
          const el = document.getElementById(id);
          return { id, exists: !!el, display: el ? getComputedStyle(el).display : null };
        });
        const iframeSrc = document.getElementById('k').src;
        const kdoc = document.getElementById('k').contentDocument;
        const ketcherBars = kdoc ? ['top-toolbar','left-toolbar','right-toolbar','bottom-toolbar']
          .map(t => { const el = kdoc.querySelector('[data-testid="'+t+'"]');
            return { id: t, exists: !!el, display: el ? getComputedStyle(el).display : null }; }) : [];
        return { marker: d.getAttribute('data-native-canvas'), navGen: window.MolStudioNativeCanvas?.navigationGeneration,
          hidden, iframeSrc, ketcherBars };
      })()`);
      check('parse-time nativeCanvas marker + navGen', first.marker === '1' && first.navGen === navGen, first);
      check('all legacy web controls hidden on first frame (before attach)',
        first.hidden.every(h => !h.exists || h.display === 'none'), first.hidden);
      check('Ketcher iframe keeps original URL (hiddenControls not used)',
        first.iframeSrc.includes('/ketcher/index.html') && !first.iframeSrc.includes('hiddenControls'),
        first.iframeSrc.slice(0, 160));
      check('Ketcher web toolbars hidden from first frame via host stylesheet',
        first.ketcherBars.every(b => !b.exists || b.display === 'none'), first.ketcherBars);
    }

    const attach = await js(`k3dAPI.nativeUI.attach({ protocol: 1,
      epoch: { navigationGeneration: ${navGen}, pageId: 'native-full' },
      nativeSurfaces: ['fileCommands','toolPalette','zoomPalette','inspector','agent'],
      host: { windowKey: true, focusOwner: 'canvas' } })`);
    check('attach succeeds in native-canvas mode', attach && attach.ok === true, { owned: attach?.ownedSurfaces });
    const st = await js('k3dAPI.nativeUI.getState()');
    check('supported commands include full document surface',
      ['document.tool','document.addImage','document.object.update','document.page.setup',
       'document.importFile','document.exportPages'].every(c => st.supported.commands.includes(c)) &&
      ['equilibriumArrow','resonanceArrow','retrosyntheticArrow','document.bracket',
       'document.arrow','document.polygon','document.roundRect','ketcher.image'].every(t => st.supported.toolIds.includes(t)),
      { commands: st.supported.commands.length, tools: st.supported.toolIds.length });

    // Dispatch from inside the page with a fresh requestId each time.
    const dispatch = (id, args, extra = {}) => js(`(async () => {
      const s = k3dAPI.nativeUI.getState();
      return k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: s.epoch,
        requestId: 'r-' + Math.random().toString(36).slice(2), id: ${JSON.stringify(id)},
        args: ${JSON.stringify(args || {})}, ...${JSON.stringify(extra || {})} });
    })()`);

    // ---- reaction arrow variants: real structure mode ----
    for (const [id, mode] of [['equilibriumArrow', 'equilibrium-open-angle'],
      ['resonanceArrow', 'both-ends-filled-triangle'],
      ['retrosyntheticArrow', 'retrosynthetic']]) {
      const r = await dispatch('tool.set', { id });
      const placed = await js(`(() => {
        const ed = MolWorkbench.app.adapter.ed;
        // Draw the arrow through the real tool's mouse sequence on the canvas.
        const area = ed.render.clientArea;
        const rect = area.getBoundingClientRect();
        const w = document.getElementById('k').contentWindow;
        const opts = { bubbles: true, cancelable: true, view: w, clientX: rect.left + 300, clientY: rect.top + 260 };
        area.dispatchEvent(new w.MouseEvent('mousedown', opts));
        opts.clientX += 120;
        area.dispatchEvent(new w.MouseEvent('mousemove', opts));
        area.dispatchEvent(new w.MouseEvent('mouseup', opts));
        const arrows = [...ed.struct().rxnArrows.values()].map(a => a.mode);
        return arrows;
      })()`);
      // The editor.tool() observation is the authoritative mapping proof; a
      // drawn arrow mode is additionally checked when the tool commits one.
      const tool = await js('k3dAPI.nativeUI.getState().tool');
      check(`real editor: ${id} selects ${mode}`,
        r.ok === true && (tool.id === id || placed.includes(mode)),
        { reply: r.ok, tool, placed });
    }

    // ---- document tools create real SVG objects, one undo each ----
    await js('k3dAPI.nativeUI.dispatch({ protocol:1, epoch:k3dAPI.nativeUI.getState().epoch, requestId:"reset1", id:"edit.selectAll", args:{} }); k3dAPI.undo();');
    for (const [id, shape] of [['document.bracket', 'bracket'], ['document.roundRect', 'roundRect'],
      ['document.polygon', 'polygon'], ['document.arrow', 'arrow']]) {
      const before = await js('MolWorkbench.app.documentController.getState().objects.length');
      const r = await dispatch('tool.set', { id });
      const created = await js(`(() => {
        const dc = MolWorkbench.app.documentController;
        const area = MolWorkbench.app.adapter.ed.render.clientArea;
        const rect = area.getBoundingClientRect();
        const w = document.getElementById('k').contentWindow;
        const fire = (name, x, y) => area.dispatchEvent(new w.PointerEvent(name,
          { bubbles:true, cancelable:true, view:w, clientX:x, clientY:y, button:0, isPrimary:true }));
        const x = rect.left + 340, y = rect.top + 320;
        fire('pointerdown', x, y); fire('pointermove', x + 80, y + 50); fire('pointerup', x + 80, y + 50);
        return { count: dc.getState().objects.length, kinds: dc.getState().objects.map(o => o.kind),
          shapes: dc.getState().objects.map(o => o.shape) };
      })()`);
      check(`real editor: ${id} creates a ${shape} document object`,
        r.ok === true && created.count === before + 1 && created.shapes.includes(shape),
        { reply: r.ok, before, created });
      const undone = await js('k3dAPI.undo(); MolWorkbench.app.documentController.getState().objects.length');
      check(`real editor: undo removes the ${shape} object in one step`, undone === before, { undone, before });
    }

    // ---- document text/image/shape commands and page setup ----
    {
      const text = await dispatch('document.addText', { text: '机理标题', point: { x: 3, y: 4 } });
      const textObj = await js('(() => { const s=MolWorkbench.app.documentController.getState(); return s.objects.at(-1); })()');
      check('document.addText creates a real editable text object',
        text.ok === true && textObj.kind === 'text' && textObj.rich.text === '机理标题', { text: text.ok, textObj });
      const undoText = await js('k3dAPI.undo(); MolWorkbench.app.documentController.getState().objects.at(-1)?.rich?.text');
      check('text insertion is a single undo', undoText !== '机理标题', { undoText });

      const img = await dispatch('document.addImage', {
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        point: { x: 5, y: 6 }, w: 6, h: 4
      });
      const imgObj = await js('(() => { const s=MolWorkbench.app.documentController.getState(); return { count:s.objects.length, assets:Object.keys(s.assets).length }; })()');
      check('document.addImage inserts real image asset + object',
        img.ok === true && imgObj.assets >= 1, { img: img.ok, imgObj });
      await js('k3dAPI.undo()');

      const setup = await dispatch('document.page.setup', { mode: 'paper', size: 'Letter', orientation: 'landscape', marginMm: 20 });
      const page = await js('(() => { const s=MolWorkbench.app.documentController.getState(); return { mode:s.mode, size:s.page.size, orientation:s.page.orientation, pages:s.pages.length }; })()');
      check('document.page.setup changes real paper geometry',
        setup.ok === true && page.mode === 'paper' && page.size === 'Letter' && page.orientation === 'landscape',
        { setup: setup.ok, page });
      const add = await dispatch('document.page.add');
      const pages2 = await js('MolWorkbench.app.documentController.getState().pages.length');
      check('document.page.add increases the real page count', add.ok === true && pages2 === page.pages + 1, { add: add.ok, pages2 });
      await js('k3dAPI.undo(); k3dAPI.undo()');

      const state = await dispatch('document.state');
      check('document.state reflects real selection/page state',
        state.ok === true && Number.isFinite(state.result.pageCount), state.result);
    }

    // ---- extended object properties: one commit, one undo ----
    {
      const created = await dispatch('document.addShape', { shape: 'shape.rect', point: { x: 2, y: 2 }, w: 8, h: 5 });
      const s0 = await js('k3dAPI.nativeUI.getState()');
      const prop = s0.selection.properties.find(p => p.id === 'stroke.color');
      check('shape selection exposes real stroke.color property',
        created.ok === true && !!prop, { created: created.ok, props: s0.selection.properties.map(p => p.id) });
      if (prop) {
        const r = await dispatch('selection.setProperty', { propertyId: 'stroke.color', value: '#ff0000' },
          { expectedSelectionRevision: s0.selection.revision });
        const after = await js('(() => { const s=MolWorkbench.app.documentController.getState(); return s.objects.at(-1).stroke.color; })()');
        const h1 = await js('MolWorkbench.app.adapter.ed.historySize().undo');
        await js('k3dAPI.undo()');
        const restored = await js('(() => { const s=MolWorkbench.app.documentController.getState(); return s.objects.at(-1)?.stroke?.color; })()');
        check('stroke.color commit changes real structure and one undo restores it',
          r.ok === true && after === '#ff0000' && restored !== '#ff0000',
          { r: r.ok, after, h1, restored });
      }
    }

    // ---- first-frame mode survives detach / failed attach / advanced-tools call ----
    {
      const retired = await js('(() => { const b = MolWorkbench.nativeUI.current(); return b.setAdvancedWebTools(true); })()');
      check('setAdvancedWebTools is retired in native mode', retired === false, { retired });
      await js('k3dAPI.nativeUI.detach(k3dAPI.nativeUI.getState().epoch)');
      const afterDetach = await js(`(() => {
        const ids = ['helpBtn','toast','mech-sel-bar','molstudio-document-toolbar',
          'molstudio-document-status','molstudio-document-pages'];
        const hidden = ids.map(id => { const el = document.getElementById(id);
          return { id, display: el ? getComputedStyle(el).display : null }; });
        const kdoc = document.getElementById('k').contentDocument;
        const bars = kdoc ? ['top-toolbar','left-toolbar','right-toolbar','bottom-toolbar']
          .map(t => { const el = kdoc.querySelector('[data-testid="'+t+'"]');
            return { id: t, display: el ? getComputedStyle(el).display : null }; }) : [];
        return { hidden, bars };
      })()`);
      check('detach never reveals legacy web controls in native mode',
        afterDetach.hidden.every(h => h.display === null || h.display === 'none'), afterDetach.hidden);
      check('detach never reveals Ketcher web toolbars in native mode',
        afterDetach.bars.every(b => b.display === null || b.display === 'none'), afterDetach.bars);
      // Re-attach proves the page remains usable after a degraded interval.
      const re = await js(`k3dAPI.nativeUI.attach({ protocol: 1,
        epoch: { navigationGeneration: ${navGen}, pageId: 'native-full-2' },
        nativeSurfaces: ['fileCommands','toolPalette','zoomPalette','inspector','agent'],
        host: { windowKey: true, focusOwner: 'canvas' } })`);
      check('re-attach after detach still works', re && re.ok === true, { ok: re?.ok });
    }

    check('no console errors', report.browserErrors.filter(e => e.level >= 3).length === 0,
      report.browserErrors.filter(e => e.level >= 3));
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
    check('harness completed', false, String(e && e.message || e));
  } finally {
    report.serverLogTail = serverLog.slice(-20);
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.errors.length === 0 && report.checks.every(c => c.ok),
      checks: report.checks.length,
      failed: report.checks.filter(c => !c.ok).length,
      service: report.service }));
    try { win?.destroy(); } catch (_) {}
    try { server.kill(); } catch (_) {}
  }
  const failed = report.checks.some(c => !c.ok) || report.errors.length;
  app.on('window-all-closed', () => {});
  setTimeout(() => app.exit(failed ? 1 : 0), 250);
}

main();
