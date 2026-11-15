'use strict';
/* Native UI contract v1 — real editor test (isolated Electron profile, own
 * server port, own artifacts; never touches the user's canvas or root demo
 * port 49180; no model requests are made).
 *
 * Verifies against the ACTUAL Ketcher distribution:
 * - verified tool/element mappings really drive the editor (bond type/stereo
 *   values, reaction arrow mode, atom label),
 * - active tool state follows the engine (including Escape),
 * - host.context viewport gating + shared effective region,
 * - slider-release single undo, requestId idempotency, stale selection,
 * - settings.load returns a public payload without sessionToken.
 */
const electron = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = process.env.MOLSTUDIO_NATIVE_UI_OUT
  || path.join(__dirname, 'artifacts/macos-shell-20261114/work/native-ui-real');
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
  const server = spawn(python, ['-B', '-u', path.join(__dirname, '..', 'server.py'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  server.stdout.on('data', d => serverLog.push(String(d)));
  server.stderr.on('data', d => serverLog.push(String(d)));

  const report = {
    application: 'MolStudio canvas', page: 'fusion/canvas.html',
    build: process.env.MOLSTUDIO_TEST_BUILD || 'source checkout',
    service: `http://127.0.0.1:${port}`, modelCalls: 0,
    ketcherDistribution: 'ketcher-local/static/js/main.e47c48ad.js',
    checks: [], errors: []
  };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: ok === true, detail: detail === undefined ? null : detail }); console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); };

  let win = null;
  try {
    // Wait for the canvas service to answer before loading the page.
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await new Promise(resolve => {
        const req = require('node:http').get({ host: '127.0.0.1', port, path: '/canvas.html', timeout: 900 }, res => { res.resume(); resolve(res.statusCode < 500); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (!up) await wait(250);
    }
    if (!up) throw new Error('canvas service did not start');

    app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'molstudio-native-ui-')));
    win = new BrowserWindow({ show: false, width: 1500, height: 980, webPreferences: { offscreen: true, backgroundThrottling: false } });
    report.browserErrors = [];
    win.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (level >= 2) report.browserErrors.push({ level, msg, line, src });
    });
    const js = code => win.webContents.executeJavaScript(code);
    await win.loadURL(`http://127.0.0.1:${port}/canvas.html`);
    for (let i = 0; i < 400; i++) {
      if (await js('!!(k3dAPI?.workbenchReady?.() && window.molstudioAgent && k3dAPI?.nativeUI)')) break;
      await wait(100);
    }
    const ready = await js('!!(k3dAPI?.workbenchReady?.() && window.molstudioAgent && k3dAPI?.nativeUI)');
    check('workbench + nativeUI entry points ready', ready);

    // ---- attach handshake (browser has no webkit handler: nothing publishes,
    // nothing may deadlock) ----
    const attach = await js(`k3dAPI.nativeUI.attach({ protocol: 1, epoch: { navigationGeneration: 11, pageId: 'real-test' }, nativeSurfaces: ['fileCommands','toolPalette','zoomPalette','inspector','agent'], host: { windowKey: true, focusOwner: 'canvas' } })`);
    check('attach ok with complete capabilities', attach && attach.ok === true, { ownedSurfaces: attach && attach.ownedSurfaces, sequence: attach && attach.sequence });
    check('attach returns full UIState', attach && attach.state && attach.state.protocol === 1 && attach.state.ready.canvas === true && Array.isArray(attach.state.supported.toolIds) && attach.state.supported.toolIds.length >= 15, attach && attach.state && attach.state.ready);
    const state0 = await js('k3dAPI.nativeUI.getState()');
    check('getState is read-only cached snapshot', state0 && state0.epoch.pageId === 'real-test' && typeof state0.selection.revision === 'number' && state0.viewport.mode === 'canvas', { tool: state0 && state0.tool });

    // host.context viewport: shared effective region + overlay-gated zoom anchor
    {
      const vp = { layoutRevision: 5, cssSize: { width: 1500, height: 980 }, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 }, overlays: [{ id: 'toolPalette', x: 0, y: 0, width: 56, height: 600 }] };
      const ok = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-hc', id: 'host.context', args: { windowKey: true, focusOwner: 'canvas', inspectorVisible: false, viewport: ${JSON.stringify(vp)} } })`);
      const state = await js('k3dAPI.nativeUI.getState()');
      check('host.context applies layoutRevision to state', ok.ok === true && state.viewport.appliedHostLayoutRevision === 5, { applied: state.viewport.appliedHostLayoutRevision, frame: state.host.visibleFrame });
      const blocked = await js(`(() => { try { return { ok: true, v: k3dAPI.zoomBy(1.25, { x: 20, y: 300 }) }; } catch (e) { return { ok: false, error: String(e && e.stack || e) }; } })()`);
      const allowed = await js(`(async () => {
        try {
          // Ketcher replays tool.mousemove(ed.lastEvent) after zoom; a fresh
          // pointer move at the anchor keeps that replay consistent, exactly
          // like a real gesture sequence.
          const w = document.getElementById('k').contentWindow;
          const el = MolWorkbench.app.adapter.ed.render.clientArea.querySelector('[data-testid="canvas"]');
          el.dispatchEvent(new w.MouseEvent('mousemove', { clientX: 700, clientY: 400, bubbles: true, cancelable: true, view: w }));
          await new Promise(r => setTimeout(r, 60));
          return { ok: true, v: k3dAPI.zoomBy(1.25, { x: 700, y: 400 }) };
        } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
      })()`);
      check('zoom anchor over native palette rejected; free point zooms',
        blocked && blocked.ok === true && blocked.v === false && allowed && allowed.ok === true && allowed.v === true,
        { blocked, allowed });
      const bounds = await js(`k3dAPI.agent.getContext().then(c => ({ ok: true, bounds: c.viewport.visibleBounds })).catch(e => ({ ok: false, error: String(e && e.message || e) }))`);
      check('agent visibleBounds honours the shared native overlay region',
        bounds && bounds.ok === true && bounds.bounds && Number.isFinite(bounds.bounds.x1), bounds);
      // Restore the identity zoom so later drawing probes share one coordinate scale.
      await js(`(() => { MolWorkbench.app.adapter.ed.zoom(1); MolWorkbench.app.adapter.ed.update(true); return MolWorkbench.app.adapter.ed.zoom(); })()`);
    }


    // ---- real Ketcher mapping probes ----
    const draw = `(async (spec) => {
      const ed = MolWorkbench.app.adapter.ed;
      const winK = document.getElementById('k').contentWindow;
      const docK = document.getElementById('k').contentDocument;
      const area = ed.render.clientArea;
      const canvasEl = area.querySelector('[data-testid="canvas"]') || area; // Ketcher's real event surface
      const x1 = spec.x1, y1 = spec.y1, x2 = spec.x2, y2 = spec.y2;
      const ME = winK.MouseEvent, PE = winK.PointerEvent || winK.MouseEvent;
      const opts = { clientX: x1, clientY: y1, button: 0, buttons: 1, bubbles: true, cancelable: true, view: winK, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      canvasEl.dispatchEvent(new PE('pointerdown', opts));
      canvasEl.dispatchEvent(new ME('mousedown', opts));
      if (x1 !== x2 || y1 !== y2) {
        const move = { ...opts, clientX: x2, clientY: y2 };
        canvasEl.dispatchEvent(new PE('pointermove', move));
        canvasEl.dispatchEvent(new ME('mousemove', move));
      }
      const up = { ...opts, clientX: x2, clientY: y2, buttons: 0 };
      canvasEl.dispatchEvent(new PE('pointerup', up));
      canvasEl.dispatchEvent(new ME('mouseup', up));
      await new Promise(r => setTimeout(r, 260));
      return true;
    })`;
    const structBonds = `(() => {
      const ed = MolWorkbench.app.adapter.ed;
      return Array.from(ed.struct().bonds.values()).map(b => ({ type: b.type, stereo: b.stereo }));
    })()`;
    // Verified quirk: k3dAPI.setMolecule('') does not remove reaction arrows in
    // this distribution, so the test drains the editor history with real undo
    // calls before replacing the canvas.
    const clearCanvas = `(async () => {
      const ed = MolWorkbench.app.adapter.ed;
      for (let i = 0; i < 30; i++) {
        const h = ed.historySize();
        if (!h || !h.undo) break;
        try { ed.undo(); } catch (e) { break; }
        await new Promise(r => setTimeout(r, 60));
      }
      await k3dAPI.setMolecule('');
      await new Promise(r => setTimeout(r, 260));
      return true;
    })()`;

    /* Cumulative-canvas design: one bonded scenario per region, no clearing
     * between steps. (Verified quirks of this distribution: editor.undo()
     * throws when undo === 0 && redo > 0, and k3dAPI.setMolecule('') does not
     * remove reaction arrows because agent-bridge restores reaction-step glyphs.) */
    let bondBaseline = await js('MolWorkbench.app.adapter.ed.struct().bonds.size');
    let atomBaseline = await js('MolWorkbench.app.adapter.ed.struct().atoms.size');
    const regions = {
      bonds: { x1: 420, y1: 320, x2: 480, y2: 320 },
      mech: { bond: [700, 520, 760, 520], o: [765, 520], lp: [700, 520], arrow: [700, 520, 764, 520] },
      template: [920, 420],
      element: [1000, 700],
      rxn: [620, 240, 800, 240]
    };

    for (const [productId, args, expect] of [
      ['tool.set', { id: 'bond.single' }, { type: 1, stereo: 0 }],
      ['tool.set', { id: 'bond.double' }, { type: 2, stereo: 0 }],
      ['tool.set', { id: 'bond.triple' }, { type: 3, stereo: 0 }],
      ['tool.set', { id: 'bond.wedge' }, { type: 1, stereo: 1 }],
      ['tool.set', { id: 'bond.hashed' }, { type: 1, stereo: 6 }],
      ['tool.set', { id: 'bond.wavy' }, { type: 1, stereo: 4 }]
    ]) {
      const reply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-${productId}-${args.id}', id: '${productId}', args: ${JSON.stringify(args)} })`);
      const state = await js('k3dAPI.nativeUI.getState()');
      const toolOK = state.tool.id === args.id;
      await js(`(${draw})({ x1: ${regions.bonds.x1}, y1: ${regions.bonds.y1}, x2: ${regions.bonds.x2}, y2: ${regions.bonds.y2} })`);
      const bonds = await js(structBonds);
      const grew = bonds.length === bondBaseline + 1;
      bondBaseline = bonds.length;
      const got = bonds[bonds.length - 1] || null;
      check(`real editor: ${args.id} draws type=${expect.type} stereo=${expect.stereo}`,
        reply.ok === true && toolOK && grew && !!got && got.type === expect.type && got.stereo === expect.stereo,
        { replyOk: reply.ok, tool: state.tool.id, count: bonds.length, got });
    }

    // active tool follows the engine keyboard path: a real Ketcher hotkey
    // (element 'b' -> Br atom tool, verified in the distribution action map)
    {
      await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-hand', id: 'tool.set', args: { id: 'hand' } })`);
      const before = await js('k3dAPI.nativeUI.getState().tool.id');
      await js(`(() => { const d = document.getElementById('k').contentDocument, w = document.getElementById('k').contentWindow; const Ctor = w.KeyboardEvent; (d.activeElement || d.body).dispatchEvent(new Ctor('keydown', { key: 'b', code: 'KeyB', keyCode: 66, which: 66, bubbles: true, cancelable: true })); })()`);
      await wait(250);
      const after = await js('k3dAPI.nativeUI.getState().tool');
      check('active tool follows real keyboard hotkey (b -> Br atom tool)', before === 'hand' && after && after.id === 'element.Br', { before, after });
    }

    // element.set drives the verified atom tool and really places the label
    {
      const reply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-el', id: 'element.set', args: { symbol: 'Br' } })`);
      const state = await js('k3dAPI.nativeUI.getState()');
      await js(`(${draw})({ x1: ${regions.element[0]}, y1: ${regions.element[1]}, x2: ${regions.element[0]}, y2: ${regions.element[1]} })`);
      const labels = await js(`(() => Array.from(MolWorkbench.app.adapter.ed.struct().atoms.values()).map(a => a.label))()`);
      check('real editor: element.set Br -> atom tool + Br label placed', reply.ok === true && state.tool.id === 'element.Br' && labels.length > 0 && labels[labels.length - 1] === 'Br', { tool: state.tool.id, labels: labels.slice(-3) });
    }

    // The native +/- buttons use Ketcher's real charge tool; each click must
    // change the placed atom and a real undo must restore it.
    {
      const lastAtom = `(() => { const atoms = Array.from(MolWorkbench.app.adapter.ed.struct().atoms.values()); return atoms.length ? (atoms[atoms.length - 1].charge || 0) : null; })()`;
      const baseCharge = await js(lastAtom);
      for (const [id, delta] of [['chargePlus', 1], ['chargeMinus', -1]]) {
        const reply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-${id}', id: 'tool.set', args: { id: '${id}' } })`);
        const active = await js('k3dAPI.nativeUI.getState().tool.id');
        await js(`(${draw})({ x1: ${regions.element[0]}, y1: ${regions.element[1]}, x2: ${regions.element[0]}, y2: ${regions.element[1]} })`);
        await js(`(() => { const w = document.getElementById('k').contentWindow, ed = MolWorkbench.app.adapter.ed;
          const el = ed.render.clientArea.querySelector('[data-testid="canvas"]') || ed.render.clientArea;
          el.dispatchEvent(new w.MouseEvent('click', { clientX: ${regions.element[0]}, clientY: ${regions.element[1]}, button: 0, bubbles: true, cancelable: true, view: w })); })()`);
        await wait(100);
        const charged = await js(lastAtom);
        const undo = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'undo-${id}', id: 'edit.undo', args: {} })`);
        await wait(120);
        const restored = await js(lastAtom);
        check(`real editor: ${id} changes atom charge and undo restores it`,
          reply.ok && active === id && charged === baseCharge + delta && undo.ok && restored === baseCharge,
          { active, baseCharge, charged, restored });
      }
      await js(`(() => { const ed = MolWorkbench.app.adapter.ed; const ids = Array.from(ed.struct().atoms.keys()); ed.selection({ atoms: [ids[ids.length - 1]], bonds: [] }); })()`);
      const radicalReply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-radical', id: 'tool.set', expectedSelectionRevision: k3dAPI.nativeUI.getState().selection.revision, args: { id: 'radical' } })`);
      const radical = await js(`(() => { const a = Array.from(MolWorkbench.app.adapter.ed.struct().atoms.values()); return a[a.length - 1].radical || 0; })()`);
      const undoRadical = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'undo-radical', id: 'edit.undo', args: {} })`);
      await wait(120);
      const restoredRadical = await js(`(() => { const a = Array.from(MolWorkbench.app.adapter.ed.struct().atoms.values()); return a[a.length - 1].radical || 0; })()`);
      check('real editor: radical on selected atom and undo', radicalReply.ok && radical === 2 && undoRadical.ok && restoredRadical === 0,
        { reply: radicalReply, radical, restoredRadical });
    }

    // verified built-in template placement (ring.benzene) + undo/redo + unverified unsupported
    {
      const state0T = await js('k3dAPI.nativeUI.getState()');
      const hasCaps = state0T.supported.commands.includes('template.set') && state0T.supported.templateIds.includes('ring.benzene');
      const badReply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-tmpl-bad', id: 'template.set', args: { id: 'template.unknown' } })`);
      check('unverified template ID stays unsupported', badReply.ok === false && badReply.error && badReply.error.code === 'unsupported', badReply.error);

      const atomsBefore = await js('MolWorkbench.app.adapter.ed.struct().atoms.size');
      const bondsBefore = await js('MolWorkbench.app.adapter.ed.struct().bonds.size');
      const okReply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-tmpl-ok', id: 'template.set', args: { id: 'ring.benzene' } })`);
      const toolAfter = await js('k3dAPI.nativeUI.getState().tool.id');
      await js(`(${draw})({ x1: ${regions.template[0]}, y1: ${regions.template[1]}, x2: ${regions.template[0]}, y2: ${regions.template[1]} })`);
      const atomsAfter = await js('MolWorkbench.app.adapter.ed.struct().atoms.size');
      const bondsAfter = await js('MolWorkbench.app.adapter.ed.struct().bonds.size');
      check('real editor: template.set ring.benzene places a benzene ring',
        hasCaps && okReply.ok === true && toolAfter === 'ring.benzene' && atomsAfter === atomsBefore + 6 && bondsAfter === bondsBefore + 6,
        { hasCaps, toolAfter, atomsBefore, atomsAfter, bondsBefore, bondsAfter });

      // Real edit.undo + edit.redo on the placed template
      const undoReply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-undo-1', id: 'edit.undo', args: {} })`);
      await wait(120);
      const atomsUndone = await js('MolWorkbench.app.adapter.ed.struct().atoms.size');
      const redoReply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-redo-1', id: 'edit.redo', args: {} })`);
      await wait(120);
      const atomsRedone = await js('MolWorkbench.app.adapter.ed.struct().atoms.size');
      check('real editor: edit.undo and edit.redo toggle template placement',
        undoReply.ok === true && atomsUndone === atomsBefore && redoReply.ok === true && atomsRedone === atomsAfter,
        { undoOk: undoReply.ok, atomsUndone, redoOk: redoReply.ok, atomsRedone });
      bondBaseline = atomsRedone ? await js('MolWorkbench.app.adapter.ed.struct().bonds.size') : bondsAfter;

      // Same-count selection change A -> B must bump selectionRevision
      await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-sel-tool', id: 'tool.set', args: { id: 'select' } })`);
      const selRevs = await js(`(async () => {
        const ed = MolWorkbench.app.adapter.ed;
        const ids = Array.from(ed.struct().atoms.keys());
        if (ids.length < 2) return null;
        ed.selection({ atoms: [ids[0]] });
        await new Promise(r => setTimeout(r, 150));
        const a = k3dAPI.nativeUI.getState().selection;
        ed.selection({ atoms: [ids[1]] });
        await new Promise(r => setTimeout(r, 150));
        const b = k3dAPI.nativeUI.getState().selection;
        ed.selection();
        return { a, b };
      })()`);
      check('real editor: same-count selection A -> B bumps selectionRevision',
        !!selRevs && selRevs.a.count === 1 && selRevs.b.count === 1 && selRevs.b.revision > selRevs.a.revision,
        selRevs);
    }

    // mechanism curved arrow needs a real electron source: bond -> O sink -> lone pair -> arrow
    {
      const set = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-mech', id: 'tool.set', args: { id: 'bond.single' } })`);
      await js(`(${draw})({ x1: ${regions.mech.bond[0]}, y1: ${regions.mech.bond[1]}, x2: ${regions.mech.bond[2]}, y2: ${regions.mech.bond[3]} })`);
      const bondsNow = await js('MolWorkbench.app.adapter.ed.struct().bonds.size');
      // Verified sink rule: arrows may not end on a carbon's implicit H; place
      // a real O atom (hetero sink) next to the bond end first.
      await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-mech-o', id: 'element.set', args: { symbol: 'O' } })`);
      await js(`(${draw})({ x1: ${regions.mech.o[0]}, y1: ${regions.mech.o[1]}, x2: ${regions.mech.o[0]}, y2: ${regions.mech.o[1]} })`);
      await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-mech-lp', id: 'tool.set', args: { id: 'lonePair' } })`);
      await js(`(${draw})({ x1: ${regions.mech.lp[0]}, y1: ${regions.mech.lp[1]}, x2: ${regions.mech.lp[0]}, y2: ${regions.mech.lp[1]} })`);
      const lpBefore = await js('MolWorkbench.app.controller.model.state.lonePairs.length');
      await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-mech-arrow', id: 'tool.set', args: { id: 'electronPairArrow' } })`);
      await js(`(${draw})({ x1: ${regions.mech.arrow[0]}, y1: ${regions.mech.arrow[1]}, x2: ${regions.mech.arrow[2]}, y2: ${regions.mech.arrow[3]} })`);
      const arrowsNow = await js('MolWorkbench.app.controller.model.state.arrows.length');
      check('real editor: bond -> O sink -> lone pair -> electronPairArrow commits one curved arrow',
        set.ok === true && bondsNow === bondBaseline + 1 && lpBefore >= 1 && arrowsNow === 1,
        { bonds: bondsNow, lp: lpBefore, arrows: arrowsNow });
      bondBaseline = bondsNow;

      // select the new arrow through the controller's own selection path
      await js(`(() => { const c = MolWorkbench.app.controller; const ar = c.model.state.arrows[c.model.state.arrows.length - 1]; c.selection = new Set([ar.id]); c.emitSelection(); })()`);
      await wait(120);
      const sel = await js('(() => { const s = k3dAPI.nativeUI.getState().selection; return { kind: s.kind, revision: s.revision, props: s.properties.map(p => p.id) }; })()');
      check('selection state exposes bend property with revision', sel.kind === 'electronFlow' && sel.props.includes('bend'), sel);
      const undoBefore = await js('(() => MolWorkbench.app.adapter.ed.historySize())()');
      const commit = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-bend-1', id: 'selection.setProperty', expectedSelectionRevision: ${sel.revision}, args: { propertyId: 'bend', value: 1.5 } })`);
      const undoAfter = await js('(() => MolWorkbench.app.adapter.ed.historySize())()');
      check('slider release = exactly one committed bend/undo entry',
        commit.ok === true && undoAfter.undo === undoBefore.undo + 1, { before: undoBefore, after: undoAfter });
      const replay = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-bend-1', id: 'selection.setProperty', expectedSelectionRevision: ${sel.revision}, args: { propertyId: 'bend', value: 2.0 } })`);
      const undoReplay = await js('(() => MolWorkbench.app.adapter.ed.historySize())()');
      check('same requestId returns cached reply, no second undo',
        replay.ok === true && undoReplay.undo === undoAfter.undo, { ok: replay.ok, undo: undoReplay.undo });
      const stale = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-bend-2', id: 'selection.setProperty', expectedSelectionRevision: ${sel.revision}, args: { propertyId: 'bend', value: -1.5 } })`);
      check('captured selection revision rejects late property edit', stale.ok === false && stale.error.code === 'stale_selection', stale.error);
    }

    // reaction arrow (straight): verified mode string, drawn in its own region
    {
      const rxnBefore = await js('MolWorkbench.app.adapter.ed.struct().rxnArrows.size');
      const reply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-rxn', id: 'tool.set', args: { id: 'reactionArrow' } })`);
      await js(`(${draw})({ x1: ${regions.rxn[0]}, y1: ${regions.rxn[1]}, x2: ${regions.rxn[2]}, y2: ${regions.rxn[3]} })`);
      const arrows = await js(`(() => Array.from(MolWorkbench.app.adapter.ed.struct().rxnArrows.values()))()`);
      const last = arrows[arrows.length - 1] || null;
      check('real editor: reactionArrow mode = open-angle',
        reply.ok === true && arrows.length === rxnBefore + 1 && last && last.mode === 'open-angle',
        { count: arrows.length, mode: last && last.mode });
    }

    // settings.load: public payload only
    {
      const reply = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-settings', id: 'agent.settings.load', args: {} })`);
      const json = JSON.stringify(reply);
      check('agent.settings.load returns public config without sessionToken',
        reply.ok === true && !json.includes('sessionToken'), { keys: reply.result && Object.keys(reply.result.config || {}) });
    }

    // post-draw zoom.by check: free point zooms and overlay anchor stays blocked
    {
      const overlayZoom = await js(`k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-zoom-overlay', id: 'zoom.by', args: { factor: 1.2, anchor: { x: 20, y: 200 } } })`);
      const postZoom = await js(`(async () => {
        const w = document.getElementById('k').contentWindow;
        const el = MolWorkbench.app.adapter.ed.render.clientArea.querySelector('[data-testid="canvas"]');
        el.dispatchEvent(new w.MouseEvent('mousemove', { clientX: 700, clientY: 400, bubbles: true, cancelable: true, view: w }));
        await new Promise(r => setTimeout(r, 60));
        return k3dAPI.nativeUI.dispatch({ protocol: 1, epoch: k3dAPI.nativeUI.getState().epoch, requestId: 'real-zoom-free', id: 'zoom.by', args: { factor: 1.2, anchor: { x: 700, y: 400 } } });
      })()`);
      check('post-draw zoom.by respects native overlays and zooms free canvas',
        overlayZoom.ok === false && postZoom && postZoom.ok === true,
        { overlayZoom, postZoom });
    }

    // preserved Web document toolbar & rich panel work via UI clicks while nativeUI is attached
    {
      await js(clearCanvas);
      await js(`MolWorkbench.app.controller.model.setState({ lonePairs: [], arrows: [] }, 'silent')`);
      await wait(120);
      const preserved = await js(`(async () => {
        const bar = document.getElementById('molstudio-document-toolbar');
        const panel = document.getElementById('molstudio-document-panel');
        if (!bar || !panel) return { missing: true };
        const barStyle = getComputedStyle(bar);
        const barRect = bar.getBoundingClientRect();
        const dc = MolWorkbench.app.documentController;

        // 1. Click '文字' button in preserved toolbar
        bar.querySelector('[data-doc-tool="text"]').click();
        const textToolAfterClick = dc.tool;

        // 2. Select 'roundRect' shape tool & draw via pointer events on Ketcher canvas
        const shapeSelect = bar.querySelector('select[data-doc-action="shape"]');
        shapeSelect.value = 'roundRect';
        shapeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const shapeToolAfterSelect = dc.tool;

        const w = document.getElementById('k').contentWindow;
        const area = MolWorkbench.app.adapter.ed.render.clientArea;
        const canvasEl = area.querySelector('[data-testid="canvas"]') || area;
        const PE = w.PointerEvent || w.MouseEvent;
        const base = { button: 0, buttons: 1, bubbles: true, cancelable: true, view: w, pointerId: 2, pointerType: 'mouse', isPrimary: true };
        canvasEl.dispatchEvent(new PE('pointerdown', { ...base, clientX: 480, clientY: 560 }));
        canvasEl.dispatchEvent(new PE('pointermove', { ...base, clientX: 600, clientY: 620 }));
        canvasEl.dispatchEvent(new PE('pointerup', { ...base, clientX: 600, clientY: 620, buttons: 0 }));
        await new Promise(r => setTimeout(r, 120));
        const created = dc.getState().objects.find(o => o.kind === 'shape' && o.shape === 'roundRect') || null;

        // 3. Click '属性' and edit via #molstudio-document-panel inputs
        bar.querySelector('[data-doc-action="properties"]').click();
        await new Promise(r => setTimeout(r, 60));
        const panelOpenProps = !panel.hidden && panel.dataset.nativeOwned !== '1';
        const widthInput = panel.querySelector('input[aria-label="线宽"]');
        const fillInput = panel.querySelector('input[aria-label="填充颜色"]');
        if (widthInput) {
          widthInput.value = '0.12';
          widthInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (fillInput) {
          fillInput.value = '#ddeeff';
          fillInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(r => setTimeout(r, 60));
        const edited = created ? dc.getState().objects.find(o => o.id === created.id) : null;

        // 4. Click '页面', switch to paper mode, add page, serialize & loadWorkbench
        bar.querySelector('[data-doc-action="page-setup"]').click();
        await new Promise(r => setTimeout(r, 60));
        const modeSelect = panel.querySelector('select[aria-label="文档模式"]');
        if (modeSelect) {
          modeSelect.value = 'paper';
          modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const addPageBtn = [...panel.querySelectorAll('button')].find(b => b.textContent === '新增一页');
        if (addPageBtn) addPageBtn.click();
        await new Promise(r => setTimeout(r, 120));
        const statusEl = document.getElementById('molstudio-document-status');
        const statusStillOwned = statusEl ? statusEl.dataset.nativeOwned === '1' : false;
        const serialized = await k3dAPI.serializeWorkbench();
        const loadRes = await k3dAPI.loadWorkbench(serialized);
        await new Promise(r => setTimeout(r, 120));
        const reloadedState = dc.getState();
        const reloadedShape = reloadedState.objects.find(o => o.kind === 'shape' && o.shape === 'roundRect') || null;
        panel.querySelector('[aria-label="关闭属性面板"]')?.click();

        return {
          barVisible: bar.dataset.nativeOwned !== '1' && barStyle.display !== 'none' && barStyle.visibility !== 'hidden',
          barRect: { left: barRect.left, top: barRect.top, width: barRect.width, height: barRect.height },
          textToolAfterClick,
          shapeToolAfterSelect,
          createdKind: created?.shape || null,
          panelOpenProps,
          editedWidth: edited?.stroke?.width || null,
          editedFill: edited?.fill || null,
          statusStillOwned,
          loadOk: loadRes && loadRes.ok === true,
          reloadedMode: reloadedState.mode,
          reloadedPageCount: reloadedState.pageCount,
          reloadedShapeWidth: reloadedShape?.stroke?.width || null,
          reloadedShapeFill: reloadedShape?.fill || null,
        };
      })()`);
      check(
        'preserved Web document toolbar & panel work via UI clicks while nativeUI attached',
        !preserved.missing &&
          preserved.barVisible === true &&
          preserved.barRect.left >= 56 &&
          preserved.textToolAfterClick === 'text' &&
          preserved.shapeToolAfterSelect === 'roundRect' &&
          preserved.createdKind === 'roundRect' &&
          preserved.panelOpenProps === true &&
          preserved.editedWidth === 0.12 &&
          preserved.editedFill === '#ddeeff' &&
          preserved.statusStillOwned === true &&
          preserved.loadOk === true &&
          preserved.reloadedMode === 'paper' &&
          preserved.reloadedPageCount === 2 &&
          preserved.reloadedShapeWidth === 0.12 &&
          preserved.reloadedShapeFill === '#ddeeff',
        preserved
      );
    }

    // detach restores web surfaces (no hidden web + dead native state)
    {
      const hiddenBefore = await js(`(() => { const el = document.getElementById('mech-sel-bar'); return el ? el.dataset.nativeOwned : 'missing'; })()`);
      const detach = await js(`k3dAPI.nativeUI.detach(k3dAPI.nativeUI.getState().epoch)`);
      const restored = await js(`(() => {
        const el = document.getElementById('mech-sel-bar');
        const st = document.getElementById('molstudio-document-status');
        const bar = document.getElementById('molstudio-document-toolbar');
        return {
          mech: el ? (el.dataset.nativeOwned || 'clean') : 'missing',
          status: st ? (st.dataset.nativeOwned || 'clean') : 'missing',
          barTop: bar ? bar.style.top : 'missing',
          barLeft: bar ? bar.style.left : 'missing'
        };
      })()`);
      check('detach restores web controls', detach.ok === true && hiddenBefore === '1' && restored.mech === 'clean' && restored.status === 'clean' && restored.barTop === '' && restored.barLeft === '', { hiddenBefore, restored });
    }

    check('no console level >= 3 errors in real Electron run',
      report.browserErrors.filter(e => e.level >= 3).length === 0,
      { errors: report.browserErrors.filter(e => e.level >= 3) });

    report.ok = report.checks.every(c => c.ok);
  } catch (error) {
    report.ok = false;
    report.errors.push(String(error && error.stack || error));
    console.error('ERROR', error);
  } finally {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT, 'server-log.txt'), serverLog.join('\n'));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, failed: report.checks.filter(c => !c.ok).length, service: report.service }));
    try { if (win) win.destroy(); } catch (e) {}
    try { server.kill('SIGTERM'); } catch (e) {}
    app.exit(report.ok ? 0 : 1);
  }
}

app.whenReady().then(main);
