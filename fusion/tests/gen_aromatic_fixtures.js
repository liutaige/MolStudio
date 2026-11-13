/* 真实 Ketcher 交互生成"芳香三元碳正离子"夹具（真实指针点击，不用手拼 KET 冒充画布导出）。
   用法：
     .venv-rdkit/bin/python fusion/server.py 8899
     cd fusion && env -u ELECTRON_RUN_AS_NODE MOLSTUDIO_PORT=8899 \
       ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/gen_aromatic_fixtures.js
   输出：tests/fixtures/aromatic/*.ket / *.mol / *.json / *.png
   用例：
     a01 芳香圆圈三元环 + C+（先画明确的单/双键正离子，再用 Aromatize 按钮芳香化）
     a02 a01 用 Dearomatize 按钮改回一条双键 + 两条单键
     a03 苯（芳香体系回归）
     a04 已画好的芳香键三元环，再用电荷工具点碳（Ketcher 认为该碳 0 氢）
     a05 1-甲基环丙烯正离子：正电碳有取代基、没有氢（不应补氢）
*/
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures', 'aromatic');
const PORT = process.env.MOLSTUDIO_PORT || '8899';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); process.exit(2); }, 240000);
const wait = ms => new Promise(r => setTimeout(r, ms));

const AROMATIC_RING3 = {
  root: { nodes: [{ $ref: 'mol0' }], connections: [], templates: [] },
  mol0: {
    type: 'molecule',
    atoms: [
      { label: 'C', location: [0, 1, 0] },
      { label: 'C', location: [-0.866, -0.5, 0] },
      { label: 'C', location: [0.866, -0.5, 0] },
    ],
    bonds: [{ type: 4, atoms: [0, 1] }, { type: 4, atoms: [1, 2] }, { type: 4, atoms: [2, 0] }],
  },
};
const AROMATIC_RING3_METHYL = {
  root: { nodes: [{ $ref: 'mol0' }], connections: [], templates: [] },
  mol0: {
    type: 'molecule',
    atoms: [
      { label: 'C', location: [0, 1, 0] },
      { label: 'C', location: [-0.866, -0.5, 0] },
      { label: 'C', location: [0.866, -0.5, 0] },
      { label: 'C', location: [0, 2.2, 0] },
    ],
    bonds: [{ type: 4, atoms: [0, 1] }, { type: 4, atoms: [1, 2] },
            { type: 4, atoms: [2, 0] }, { type: 1, atoms: [0, 3] }],
  },
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1280, height: 860 });
  await win.loadURL(`http://127.0.0.1:${PORT}/ketcher/index.html`);
  await wait(4500);
  win.focus();
  const js = c => win.webContents.executeJavaScript(c);

  const clickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    await wait(60);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y),
                                     button: 'left', clickCount: 1 });
    await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y),
                                     button: 'left', clickCount: 1 });
    await wait(300);
  };
  const clickTestId = async (tid) => {
    const r = await js(`(() => {
      const el = document.querySelector('[data-testid=${JSON.stringify(tid)}]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!r) throw new Error('missing testid ' + tid);
    await clickAt(r.x, r.y);
  };
  const clickAtom = async (id) => {
    const r = await js(`(() => {
      const el = document.querySelector('[data-testid="atom"][data-atom-id="${id}"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!r) throw new Error('missing atom ' + id);
    await clickAt(r.x, r.y);
  };
  const snap = async (name) => {
    win.focus();
    await wait(300);
    const res = await js(`(async () => {
      const k = window.ketcher;
      const out = {};
      try { out.ket = await k.getKet(); } catch (e) { out.ketErr = String(e); }
      try { out.mol = await k.getMolfile(); } catch (e) { out.molErr = String(e); }
      try { out.smiles = await k.getSmiles(); } catch (e) { out.smilesErr = String(e); }
      const st = k.editor.struct();
      out.atoms = [];
      st.atoms.forEach((a, id) => out.atoms.push({ id, label: a.label, charge: a.charge,
        implicitH: a.implicitH }));
      return out;
    })()`);
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(res, null, 2));
    if (res.ket) fs.writeFileSync(path.join(OUT, name + '.ket'), res.ket);
    if (res.mol) fs.writeFileSync(path.join(OUT, name + '.mol'), res.mol);
    const ket = res.ket ? JSON.parse(res.ket) : null;
    const mol = ket && Object.values(ket).find(s => s && s.type === 'molecule');
    console.log(`-- ${name}: smiles=${res.smiles} ketErr=${res.ketErr} molErr=${res.molErr}`);
    console.log('   editor atoms:', JSON.stringify(res.atoms));
    if (mol) console.log('   ket atoms:', JSON.stringify(mol.atoms), '\n   ket bonds:', JSON.stringify(mol.bonds));
    return res;
  };
  const shot = async (name) => {
    win.focus();
    await wait(500);
    fs.writeFileSync(path.join(OUT, name + '.png'), (await win.capturePage()).toPNG());
  };

  // ---- a01：明确单/双键的环丙烯正离子 → 真实点击 Aromatize ----
  await js(`window.ketcher.setMolecule('C1=C[CH+]1')`);
  await wait(800);
  await shot('a01-1-kekule-input');
  await clickTestId('Aromatize button');
  await wait(700);
  await shot('a01-2-aromatized');
  const a01 = await snap('a01-aromatic-cyclopropenyl-cation');

  // ---- a02：同一结构真实点击 Dearomatize ----
  await clickTestId('Dearomatize button');
  await wait(700);
  await shot('a02-1-dearomatized');
  const a02 = await snap('a02-kekule-cyclopropenyl-cation');

  // ---- a03：苯 ----
  await js(`window.ketcher.setMolecule('c1ccccc1')`);
  await wait(800);
  const a03 = await snap('a03-benzene');

  // ---- a04：芳香键三元环 → 电荷工具点碳 ----
  await js(`window.ketcher.setMolecule(${JSON.stringify(JSON.stringify(AROMATIC_RING3))})`);
  await wait(900);
  await shot('a04-1-aromatic-bonds');
  await clickTestId('charge-plus');
  await clickAtom(0);
  await wait(500);
  await shot('a04-2-charged');
  const a04 = await snap('a04-aromatic-ring-charged-after');

  // ---- a05：1-甲基（正电碳有取代基）----
  await js(`window.ketcher.setMolecule(${JSON.stringify(JSON.stringify(AROMATIC_RING3_METHYL))})`);
  await wait(900);
  await clickTestId('charge-plus');
  await clickAtom(0);
  await wait(500);
  await shot('a05-1-methyl-charged');
  const a05 = await snap('a05-methyl-aromatic-cation');

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
    note: '真实 Ketcher 3.18 画布导出：芳香化/去芳香化/电荷工具均为真实指针点击',
    cases: [
      { id: 'a01', file: 'a01-aromatic-cyclopropenyl-cation.ket',
        note: '芳香圆圈三元环 + C+（KET 带 implicitHCount:1）', smiles: a01.smiles },
      { id: 'a02', file: 'a02-kekule-cyclopropenyl-cation.ket',
        note: 'a01 去芳香化：一条双键 + 两条单键', smiles: a02.smiles },
      { id: 'a03', file: 'a03-benzene.ket', note: '苯（芳香回归）', smiles: a03.smiles },
      { id: 'a04', file: 'a04-aromatic-ring-charged-after.ket',
        note: '先画芳香键再加电荷：KET 无 implicitHCount（编辑器认为该碳 0 氢）', smiles: a04.smiles },
      { id: 'a05', file: 'a05-methyl-aromatic-cation.ket',
        note: '1-甲基环丙烯正离子：正电碳有取代基，不应补氢', smiles: a05.smiles },
    ],
  }, null, 2));
  console.log('done');
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
