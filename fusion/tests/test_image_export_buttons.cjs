/* Run with the development server on MOLSTUDIO_PORT (default 8879):
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/test_image_export_buttons.cjs */
const { app, BrowserWindow } = require('electron');
const assert = require('assert');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820 });
  try {
    await win.loadURL(`http://127.0.0.1:${process.env.MOLSTUDIO_PORT || 8879}/canvas.html`);
    const js = source => win.webContents.executeJavaScript(source);
    for (let i = 0; i < 100 && !(await js('!!(window.k3dAPI && window.k3dAPI.workbenchReady && window.k3dAPI.workbenchReady())')); i++) await wait(250);
    assert(await js('window.k3dAPI.workbenchReady()'), 'workbench did not start');
    await js("window.k3dAPI.setMolecule('CCO')");
    await wait(500);

    // Both actual toolbar buttons must forward their format to the native host.
    await js(`window.__exportMessages = []; window.webkit = { messageHandlers: { k3d: { postMessage: m => window.__exportMessages.push(m) } } }; true`);
    for (const kind of ['svg', 'png']) {
      await js(`document.getElementById('k').contentDocument.querySelector('[data-mech-action="export-${kind}"]').click()`);
    }
    assert.deepStrictEqual(await js('window.__exportMessages'), [
      { act: 'exportMechanismImage', kind: 'svg' },
      { act: 'exportMechanismImage', kind: 'png' }
    ]);
    await js('delete window.webkit');

    for (const kind of ['svg', 'png']) {
      const download = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${kind} download did not start`)), 10000);
        win.webContents.session.once('will-download', (event, item) => {
          clearTimeout(timer);
          const dataUrl = item.getURL();
          event.preventDefault();
          resolve(dataUrl);
        });
      });
      await js(`document.getElementById('k').contentDocument.querySelector('[data-mech-action="export-${kind}"]').click()`);
      const dataUrl = await download;
      const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
      assert(bytes.length > 100, `${kind} is empty`);
      if (kind === 'png') assert(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'invalid PNG');
      else {
        const svg = bytes.toString('utf8');
        assert(svg.includes('<svg') && svg.includes('<text'), 'missing SVG content');
        assert(await js(`!new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml').querySelector('parsererror')`), 'invalid SVG');
      }
      console.log(`${kind}: toolbar download valid (${bytes.length} bytes)`);
    }
    console.log('native toolbar bridge: both formats passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
