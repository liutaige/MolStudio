/* 生成真实画布导出的 KET 测试夹具（在 Electron + 真实 Ketcher 里跑）。
   用法： cd fusion && env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu tests/gen_fixtures.js
   输出：fusion/tests/fixtures/*.ket + fixtures/index.json（SMILES 与说明） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
const PORT = process.env.MOLSTUDIO_PORT || '8470';
setTimeout(() => { console.log('WATCHDOG'); app.quit(); }, 240000);

const ALL_SAMPLES = [
  ['M01', 'CC(C)(C)C', '新戊烷'],
  ['M02', 'FC(Cl)(Br)I', '未指定四面体'],
  ['M03', 'F[C@](Cl)(Br)I', '已指定四面体 S'],
  ['M04', 'F[C@@](Cl)(Br)I', '已指定四面体 R'],
  ['M05', 'C[C@H](O)CC', '隐含氢的手性中心'],
  ['M06', 'C[C@H](F)[C@@H](Cl)C', '两个已指定中心'],
  ['M07', 'C/C=C/C', 'E 双键'],
  ['M08', 'C/C=C\\C', 'Z 双键'],
  ['M09', 'CC=CC', '未指定双键'],
  ['M10', '[2H][C@](F)(Cl)Br', '含同位素的手性中心'],
  ['M11', 'C[C@H](O)[C@H](F)Cl |o1:1,3|', 'OR 组'],
  ['M12', 'C[C@H](O)[C@H](F)Cl |&1:1,3|', 'AND 组'],
  ['R01', 'C[C@H]1CC[C@@H](C)CC1', '顺式二甲基环己烷（环上立体）'],
  ['R02', 'C1CC[C@H]2CCCC[C@H]2C1', '顺式十氢萘（稠环）'],
  ['D11', 'C[C@H](O)C(F)(Cl)Br', '同分子含已指定与未指定中心'],
];
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const SAMPLES = ONLY.length ? ALL_SAMPLES.filter(s => ONLY.includes(s[0])) : ALL_SAMPLES;

const run = async (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1400, height: 900 });
  await win.loadURL(`http://127.0.0.1:${PORT}/ketcher/index.html`);
  await new Promise(r => setTimeout(r, 4000));

  const index = [];
  const save = (id, ket, note) => {
    fs.writeFileSync(path.join(OUT, id + '.ket'), ket);
    index.push({ id, file: id + '.ket', note });
    console.log('saved', id, ket.length, 'bytes');
  };

  for (const [id, smiles, note] of SAMPLES) {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule(${JSON.stringify(smiles)});
      await new Promise(r => setTimeout(r, 400));
      return window.ketcher.getKet();
    })()`);
    save(id, ket, note + ' | ' + smiles);
  }

  // W01：M02 的中心画显式波浪键（stereo 4），由画布重新导出
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('FC(Cl)(Br)I');
      await new Promise(r => setTimeout(r, 400));
      const d = JSON.parse(await window.ketcher.getKet());
      const m = Object.keys(d).find(k => d[k] && d[k].type === 'molecule');
      // 找中心原子（度 4），给它的一条键打上"未知/波浪"
      const deg = {};
      d[m].bonds.forEach(b => b.atoms.forEach(a => deg[a] = (deg[a] || 0) + 1));
      const center = Object.keys(deg).find(k => deg[k] === 4);
      const b0 = d[m].bonds.find(b => b.atoms[0] == center || b.atoms[1] == center);
      const other = b0.atoms[0] == center ? b0.atoms[1] : b0.atoms[0];
      b0.atoms = [Number(center), other];
      b0.stereo = 4;
      await window.ketcher.setMolecule(JSON.stringify(d));
      await new Promise(r => setTimeout(r, 400));
      return window.ketcher.getKet();
    })()`);
    save('W01', ket, 'M02 中心显式波浪键（未知）');
  }

  // W02：新戊烷人为画楔形 + ABS 旗标
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('CC(C)(C)C');
      await new Promise(r => setTimeout(r, 400));
      const d = JSON.parse(await window.ketcher.getKet());
      const m = Object.keys(d).find(k => d[k] && d[k].type === 'molecule');
      const deg = {};
      d[m].bonds.forEach(b => b.atoms.forEach(a => deg[a] = (deg[a] || 0) + 1));
      const center = Number(Object.keys(deg).find(k => deg[k] === 4));
      d[m].atoms[center].stereoLabel = 'abs';
      const b0 = d[m].bonds.find(b => b.atoms[0] === center || b.atoms[1] === center);
      const other = b0.atoms[0] === center ? b0.atoms[1] : b0.atoms[0];
      b0.atoms = [center, other];
      b0.stereo = 1;
      await window.ketcher.setMolecule(JSON.stringify(d));
      await new Promise(r => setTimeout(r, 400));
      return window.ketcher.getKet();
    })()`);
    save('W02', ket, '新戊烷 + 人为楔键 + ABS（不得据此判定手性）');
  }

  // W06：交叉双键（E/Z 显式未知），由画布重新导出
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('C/C=C/C');
      await new Promise(r => setTimeout(r, 500));
      const d = JSON.parse(await window.ketcher.getKet());
      const m = Object.keys(d).find(k => d[k] && d[k].type === 'molecule');
      const db = d[m].bonds.find(b => b.type === 2);
      db.stereo = 3;                 // Ketcher PATTERN.STEREO.CIS_TRANS：顺反未定
      await window.ketcher.setMolecule(JSON.stringify(d));
      await new Promise(r => setTimeout(r, 500));
      return window.ketcher.getKet();
    })()`);
    save('W06', ket, '交叉双键（E/Z 显式未知）');
  }

  // W04/W05：甲基、F、Cl、Br 四取代、四条键全显式、一实心一虚线（S / R）
  {
    const mk = (upIdx, downIdx) => ({
      ket_version: '2.0.0',
      root: { nodes: [{ $ref: 'mol0' }], connections: [], templates: [] },
      mol0: {
        type: 'molecule',
        atoms: [
          { label: 'C', location: [0.0, 0.0, 0.0] },
          { label: 'C', location: [1.0, 0.0, 0.0] },
          { label: 'F', location: [0.5, 0.866, 0.0] },
          { label: 'Cl', location: [-0.866, 0.5, 0.0] },
          { label: 'Br', location: [0.0, -1.0, 0.0] },
        ],
        bonds: [1, 2, 3, 4].map(k => {
          const b = { type: 1, atoms: [0, k] };
          if (k === upIdx) b.stereo = 1;
          if (k === downIdx) b.stereo = 6;
          return b;
        }),
      },
    });
    for (const [id, up, down, note] of [
      ['W04', 1, 2, '四取代一实一虚 S（甲基实心 / F 虚线）'],
      ['W05', 2, 1, '四取代一实一虚 R（F 实心 / 甲基虚线）'],
    ]) {
      const ket = await run(win, `(async () => {
        await window.ketcher.setMolecule(${JSON.stringify(JSON.stringify(mk(up, down)))});
        await new Promise(r => setTimeout(r, 500));
        return window.ketcher.getKet();
      })()`);
      save(id, ket, note);
    }
  }

  // W03：双键共线画法（构型不明确），由画布重新导出
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('CC=CC');
      await new Promise(r => setTimeout(r, 400));
      const d = JSON.parse(await window.ketcher.getKet());
      const m = Object.keys(d).find(k => d[k] && d[k].type === 'molecule');
      const atoms = d[m].atoms;
      // 四个原子排成一条直线：双键构型无法判定
      atoms.forEach((a, i) => { a.location = [-1.5 + i * 1.0, 0, 0]; });
      await window.ketcher.setMolecule(JSON.stringify(d));
      await new Promise(r => setTimeout(r, 500));
      return window.ketcher.getKet();
    })()`);
    save('W03', ket, '双键共线画法（构型未确定）');
  }

  // C01：M02 + M03 + 文字 + 反应箭头 + 图形（由画布导出）
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('FC(Cl)(Br)I.F[C@](Cl)(Br)I');
      await new Promise(r => setTimeout(r, 500));
      const d = JSON.parse(await window.ketcher.getKet());
      d.root.nodes.push({ type: 'text', boundingBox: { x: 4, y: -12, width: 3, height: 1 }, paragraphs: [{ parts: [{ text: '测试文字' }] }] });
      d.root.nodes.push({ type: 'arrow', data: { mode: 'open-angle', pos: [{ x: 10, y: -14, z: 0 }, { x: 14, y: -14, z: 0 }] } });
      d.root.nodes.push({ type: 'simpleObject', data: { mode: 'ellipse', pos: [{ x: 16, y: -16, z: 0 }, { x: 20, y: -12, z: 0 }] } });
      await window.ketcher.setMolecule(JSON.stringify(d));
      await new Promise(r => setTimeout(r, 600));
      return window.ketcher.getKet();
    })()`);
    save('C01', ket, 'M02 + M03 + 文字 + 箭头 + 图形');
  }

  // C02：两个完全相同的分子实例 + 一个其他分子
  {
    const ket = await run(win, `(async () => {
      await window.ketcher.setMolecule('FC(Cl)(Br)I');
      await new Promise(r => setTimeout(r, 400));
      await window.ketcher.addFragment('FC(Cl)(Br)I');
      await new Promise(r => setTimeout(r, 400));
      await window.ketcher.addFragment('CCO');
      await new Promise(r => setTimeout(r, 400));
      return window.ketcher.getKet();
    })()`);
    save('C02', ket, '两个相同实例 + 乙醇');
  }

  // index.json 始终写全量清单（含本次未重生成的样本）
  const full = ALL_SAMPLES.map(([id, smiles, note]) => ({ id, file: id + '.ket', note: note + ' | ' + smiles }));
  full.push({ id: 'W01', file: 'W01.ket', note: 'M02 中心显式波浪键（未知）' });
  full.push({ id: 'W02', file: 'W02.ket', note: '新戊烷 + 人为楔键 + ABS（不得据此判定手性）' });
  full.push({ id: 'W03', file: 'W03.ket', note: '双键共线画法（构型未确定）' });
  full.push({ id: 'W06', file: 'W06.ket', note: '交叉双键（E/Z 显式未知）' });
  full.push({ id: 'W04', file: 'W04.ket', note: '四取代一实一虚 S（甲基实心 / F 虚线）' });
  full.push({ id: 'W05', file: 'W05.ket', note: '四取代一实一虚 R（F 实心 / 甲基虚线）' });
  full.push({ id: 'C01', file: 'C01.ket', note: 'M02 + M03 + 文字 + 箭头 + 图形' });
  full.push({ id: 'C02', file: 'C02.ket', note: '两个相同实例 + 乙醇' });
  const existing = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.ket')));
  const keep = full.filter(x => existing.has(x.file));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(keep, null, 1));
  index.length = 0; index.push(...keep);
  console.log('done', index.length, 'fixtures ->', OUT);
  app.quit();
});
