/* 芳香三元碳正离子：真实画布层集成验收（Electron + 真实 Ketcher iframe + 真实后端）。
   用法：
     .venv-rdkit/bin/python fusion/server.py 8899
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8899 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/test_aromatic_canvas.js
   验证：画布 KET → k3dAPI.stereoTargets() → /api/stereocheck → /api/gen3d，
   并确认生成 3D 不改动画布（KET 前后一致）。截图存 tests/artifacts/aromatic-cation/。
*/
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'artifacts', 'aromatic-cation');
const FIX = path.join(__dirname, 'fixtures', 'aromatic');
const PORT = process.env.MOLSTUDIO_PORT || '8899';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 240000);
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; failures.push(name); console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1280, height: 880 });
  await win.loadURL(`http://127.0.0.1:${PORT}/canvas.html`);
  await wait(5000);
  win.focus();
  const js = c => win.webContents.executeJavaScript(c);
  const ready = await js(`(async () => { for (let i = 0; i < 80; i++) {
      if (window.k3dAPI && window.k3dAPI.ready && window.k3dAPI.ready()) return true;
      await new Promise(r => setTimeout(r, 250));
    } return false; })()`);
  check('画布与 Ketcher 就绪', ready === true);
  if (!ready) { console.log('汇总：' + pass + ' PASS / ' + fail + ' FAIL'); app.quit(); return; }

  const shot = async (name) => {
    win.focus(); await wait(600);
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.capturePage()).toPNG());
  };

  async function runCase(id, file, opts) {
    const ket = fs.readFileSync(path.join(FIX, file + '.ket'), 'utf8');
    const set = await js(`window.k3dAPI.setMolecule(${JSON.stringify(ket)})`);
    await wait(1200);
    if (opts && opts.shot) await shot(opts.shot);
    const ketBefore = await js(`window.k3dAPI.getKet()`);
    const targets = await js(`window.k3dAPI.stereoTargets()`);
    check(`${id} 画布能取到目标清单`, targets && targets.ok === true, JSON.stringify(targets && targets.message));
    const payload = { ket: targets.ket, keys: targets.keys, identity: targets.identity };
    const checkResp = await js(`(async () => {
      const r = await fetch('/api/stereocheck', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(payload))} });
      return { status: r.status, body: await r.json() };
    })()`);
    check(`${id} 生成前检查通过`, checkResp.status === 200 && checkResp.body.ok === true,
          JSON.stringify(checkResp.body).slice(0, 200));

    const genPayload = Object.assign({}, payload, { allowExample: false });
    const genResp = await js(`(async () => {
      const r = await fetch('/api/gen3d', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(genPayload))} });
      return { status: r.status, body: await r.json() };
    })()`);
    check(`${id} 生成 3D 成功`, genResp.status === 200 && genResp.body.ok === true,
          JSON.stringify(genResp.body).slice(0, 300));
    if (genResp.status === 200) {
      check(`${id} 原子数（含 H）`, genResp.body.natoms === opts.natoms,
            String(genResp.body.natoms));
      check(`${id} SMILES`, genResp.body.smiles === opts.smiles, String(genResp.body.smiles));
      if (opts.notes) {
        const notes = genResp.body.notes || [];
        check(`${id} 返回补氢说明`, notes.length === 1 && notes[0].indexOf('C3H3+') >= 0,
              JSON.stringify(notes));
      } else {
        check(`${id} 无补氢说明`, !genResp.body.notes, JSON.stringify(genResp.body.notes));
      }
      fs.writeFileSync(path.join(OUT, id + '-3d.mol'), genResp.body.molblock || '');
    }
    const ketAfter = await js(`window.k3dAPI.getKet()`);
    check(`${id} 生成不改动画布`, ketAfter === ketBefore,
          'len ' + (ketBefore || '').length + ' -> ' + (ketAfter || '').length);
    return { genResp, targets };
  }

  await runCase('a01', 'a01-aromatic-cyclopropenyl-cation',
    { natoms: 6, smiles: 'c1c[cH+]1', shot: 'a01-canvas-aromatic-cation' });
  await runCase('a04', 'a04-aromatic-ring-charged-after',
    { natoms: 6, smiles: 'c1c[cH+]1', notes: true, shot: 'a04-canvas-charge-last' });
  await runCase('a05', 'a05-methyl-aromatic-cation',
    { natoms: 9, smiles: 'C[c+]1cc1', shot: 'a05-canvas-methyl' });

  // 整理（⌘L 走同一入口）：芳香键/电荷/implicitHCount 不能被改写
  const ket = fs.readFileSync(path.join(FIX, 'a01-aromatic-cyclopropenyl-cation.ket'), 'utf8');
  await js(`window.k3dAPI.setMolecule(${JSON.stringify(ket)})`);
  await wait(1000);
  const layout = await js(`(async () => {
    const t = await window.k3dAPI.stereoTargets();
    const r = await fetch('/api/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ket: t.ket, targets: t.keys, identity: t.identity }) });
    return { status: r.status, body: await r.json() };
  })()`);
  check('整理（芳香正离子）成功', layout.status === 200 && layout.body.ok === true,
        JSON.stringify(layout.body).slice(0, 200));
  if (layout.status === 200) {
    const mol = layout.body.molecules[0];
    check('整理返回 3 个原子坐标', (mol.atoms || []).length === 3, String((mol.atoms || []).length));
    check('整理不产生楔键', (mol.bonds || []).every(b => !b.stereo), JSON.stringify(mol.bonds));
  }

  console.log('---- 汇总 ----');
  console.log('TOTAL=' + (pass + fail) + ' PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) console.log('FAILED: ' + failures.join(' | '));
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
