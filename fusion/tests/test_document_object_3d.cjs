/* 纯逻辑单测：document-object-3d（node --test） */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = undefined;
require(path.join(__dirname, '..', 'workbench', 'document-object-3d.js'));
const d3 = globalThis.MolWorkbench.documentObject3D;

const MOLBLOCK = [
  'test',
  '  Mrv  0',
  '',
  '  3  2  0  0  0  0            999 V2000',
  '    0.0000    0.0000    0.0000 C   0  0',
  '    1.5000    0.0000    0.0000 C   0  0',
  '    2.0000    1.0000    0.0000 O   0  0',
  '  1  2  1  0',
  '  2  3  1  0',
  'M  END',
  '$$$$'
].join('\n');

test('normalizeMolblock 去尾随空白并限长', () => {
  const r = d3.normalizeMolblock(MOLBLOCK + '  \n\n');
  assert.ok(r.ok);
  assert.ok(!r.molblock.includes('  \n'));
  assert.equal(r.molblock.endsWith('$$$$'), true);
  const empty = d3.normalizeMolblock('');
  assert.equal(empty.ok, false);
  assert.ok(empty.error.length > 0);
  const tooLong = d3.normalizeMolblock('x'.repeat(262145));
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.error.includes('262144'));
  // CRLF 归一
  const crlf = d3.normalizeMolblock('a\r\nb\r\n');
  assert.equal(crlf.molblock, 'a\nb');
});

test('createObject 规范化骨架与默认值', () => {
  const obj = d3.createObject({ molblock: MOLBLOCK, style: 'stick', camera: { px: 1.23456, py: 2, pz: -3, distance: 42.00001 } });
  assert.equal(obj.kind, 'molecule3d');
  assert.equal(obj.w, 16);
  assert.equal(obj.h, 12);
  assert.equal(obj.rotation, 0);
  assert.equal(obj.band, 'front');
  assert.equal(obj.style, 'stick');
  assert.equal(obj.camera.px, 1.2346); // 1e-4 舍入
  assert.equal(obj.camera.distance, 42);
  assert.equal(typeof obj.updatedAt, 'number');
  const bad = (() => { try { d3.createObject({ molblock: '' }); return 'no-throw'; } catch (e) { return e.message; } })();
  assert.notEqual(bad, 'no-throw');
});

test('validateObject 全字段边界', () => {
  const good = d3.createObject({ molblock: MOLBLOCK });
  assert.equal(d3.validateObject(good).ok, true);
  const base = () => d3.createObject({ molblock: MOLBLOCK });
  const cases = [
    [Object.assign(base(), { kind: 'image' }), '对象类型'],
    [Object.assign(base(), { x: NaN }), 'x'],
    [Object.assign(base(), { w: 0 }), 'w'],
    [Object.assign(base(), { h: -1 }), 'h'],
    [Object.assign(base(), { rotation: 'x' }), 'rotation'],
    [Object.assign(base(), { band: 'middle' }), 'band'],
    [Object.assign(base(), { pageId: '' }), 'pageId'],
    [Object.assign(base(), { molfile: '' }), 'molfile'],
    [Object.assign(base(), { style: 'wireframe' }), '样式'],
    [Object.assign(base(), { camera: { px: 0, py: 0, pz: 0 } }), 'camera'],
    [Object.assign(base(), { camera: { px: 0, py: 0, pz: 0, distance: -2 } }), 'distance'],
    [Object.assign(base(), { notes: [] }), 'notes'],
    [Object.assign(base(), { notes: { warnings: ['a'.repeat(401)] } }), '400'],
    [Object.assign(base(), { notes: { warnings: Array(9).fill('x') } }), '8'],
    [Object.assign(base(), { notes: { geometryNote: 'x'.repeat(401) } }), 'geometryNote'],
    [Object.assign(base(), { notes: { stereoExample: 'yes' } }), 'stereoExample'],
    [Object.assign(base(), { updatedAt: 'now' }), 'updatedAt']
  ];
  for (const [obj, hint] of cases) {
    const r = d3.validateObject(obj);
    assert.equal(r.ok, false, hint);
    assert.ok(r.errors.some(e => e.includes(hint) || /molfile|camera|distance|band|样式/.test(e)), `错误信息应包含提示: ${hint} -> ${r.errors.join(';')}`);
  }
  // 空 notes 合法；有效 notes 合法
  assert.equal(d3.validateObject(Object.assign(base(), { notes: {} })).ok, true);
  assert.equal(d3.validateObject(Object.assign(base(), {
    notes: { stereoExample: true, warnings: ['w1'], notes: ['n1'], geometryNote: 'g', sourceSummary: 's' }
  })).ok, true);
  assert.equal(d3.validateObject(null).ok, false);
});

test('消息 encode/decode 与未知 action 拒绝', () => {
  const req = d3.encodeRequest(7, 'snapshot', { width: 320, height: 240 });
  assert.equal(req.type, 'k3d-embed');
  assert.equal(req.id, 7);
  assert.equal(req.action, 'snapshot');
  assert.deepEqual([req.width, req.height], [320, 240]);
  assert.equal(d3.encodeRequest(8, 'snapshot', { width: 640, height: 480, trim: true }).trim, true);
  const res = d3.encodeResult(7, true, { dataURL: 'data:image/png;base64,AA' });
  assert.equal(res.type, 'k3d-embed-result');
  assert.equal(res.ok, true);
  const decReq = d3.decodeMessage(req);
  assert.deepEqual({ direction: decReq.direction, id: decReq.id, action: decReq.action },
    { direction: 'request', id: 7, action: 'snapshot' });
  const decRes = d3.decodeMessage(res);
  assert.equal(decRes.direction, 'result');
  assert.equal(decRes.ok, true);
  assert.equal(d3.decodeMessage({ type: 'other' }), null);
  assert.equal(d3.decodeMessage(null), null);
  assert.equal(d3.decodeMessage('str'), null);
  assert.throws(() => d3.encodeRequest(1, 'explode'), /未知/);
  assert.throws(() => d3.decodeMessage({ type: 'k3d-embed', id: 1, action: 'explode' }), /未知/);
  assert.deepEqual(d3.EMBED_ACTIONS,
    ['hello', 'show', 'style', 'reset', 'spin', 'snapshot', 'camera-get', 'camera-set', 'dispose']);
});

test('camera json 数值舍入与有限数约束', () => {
  const stage = {
    viewerControls: {
      position: { x: 1.00005, y: -2.00004, z: 3, set() {} },
      getCameraDistance: () => 100.00006,
      distance: () => {},
      changed: () => {}
    }
  };
  const cam = d3.cameraJson(stage);
  assert.deepEqual(cam, { px: 1.0001, py: -2, pz: 3, distance: 100.0001 });
  assert.equal(d3.applyCameraJson(stage, { px: 1, py: 2, pz: 3, distance: 4 }), true);
  const badCam = { px: Infinity, py: 0, pz: 0, distance: 1 };
  assert.equal(d3.applyCameraJson(stage, badCam), false);
  assert.equal(d3.applyCameraJson(stage, { px: 0, py: 0, pz: 0, distance: 0 }), false);
  assert.equal(d3.cameraJson(null), null);
  // NaN 距离 → null
  assert.equal(d3.cameraJson({
    viewerControls: { position: { x: 0, y: 0, z: 0 }, getCameraDistance: () => NaN }
  }), null);
});

test('generate3D：fetch mock 成功 / 409 / 网络错误 / Abort', async () => {
  const goodBody = {
    ok: true, molblock: MOLBLOCK, smiles: 'CCO', natoms: 3,
    stereo: { example: false }, stereoVerified: true,
    warnings: ['w'], notes: ['n'], geometry: { foo: 1 }, identity: 'id-1'
  };
  let captured;
  const r1 = await d3.generate3D({ ket: '{"mol0":{}}', keys: ['mol0'], identity: 'id-1', allowExample: false },
    { base: 'http://x:1', fetch: async (url, init) => {
        captured = { url, init };
        return { status: 200, ok: true, json: async () => goodBody };
      } });
  assert.equal(r1.ok, true);
  assert.equal(r1.molblock, MOLBLOCK);
  assert.equal(r1.identity, 'id-1');
  assert.equal(captured.url, 'http://x:1/api/gen3d');
  assert.deepEqual(JSON.parse(captured.init.body),
    { ket: '{"mol0":{}}', keys: ['mol0'], identity: 'id-1', allowExample: false });
  assert.equal(captured.init.method, 'POST');

  const r2 = await d3.generate3D({ ket: 'k', keys: ['mol0'] }, {
    fetch: async () => ({ status: 409, ok: false, json: async () => ({
      code: 'stereo_choice_required', message: '需要确认', extra: { stereo: { example: true } } }) })
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'stereo_choice_required');
  assert.deepEqual(r2.stereo, { example: true });

  const r3 = await d3.generate3D({ ket: 'k', keys: ['mol0'] }, {
    fetch: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'network_error');
  assert.ok(r3.message.includes('ECONNREFUSED'));

  // Abort：signal 已中止
  const ac = new AbortController();
  ac.abort();
  const r4 = await d3.generate3D({ ket: 'k', keys: ['mol0'] }, {
    signal: ac.signal,
    fetch: async (url, init) => {
      assert.ok(init.signal.aborted);
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      throw e;
    }
  });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'aborted');

  const r5 = await d3.generate3D({ ket: 'k', keys: ['mol0'] }, {
    fetch: async () => ({ status: 500, ok: false, json: async () => ({ message: '服务器坏了' }) })
  });
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'http_500');
  assert.ok(r5.message.includes('服务器'));
});

test('模块级单实例约束（claimActiveSession 纯函数）', () => {
  const a = { __disposed: false };
  const b = { __disposed: false };
  const c = { __disposed: true };
  const d1 = d3.claimActiveSession(null, a);
  assert.equal(d1.ok, true);
  const d2 = d3.claimActiveSession(a, b);
  assert.equal(d2.ok, false);
  assert.equal(d2.active, a);
  const d3r = d3.claimActiveSession(c, b);
  assert.equal(d3r.ok, true);
  assert.equal(d3r.active, b);
  assert.equal(d3.getActiveSession(), null); // 从未 mount，active 为空
});


test('camera quaternion survives object creation and API restore; malformed rotations rejected', () => {
  const camera = { px: 1, py: 2, pz: 3, distance: 40, qx: 0, qy: Math.SQRT1_2, qz: 0, qw: Math.SQRT1_2 };
  const object = d3.createObject({ molblock: MOLBLOCK, camera });
  assert.ok(Object.keys(camera).every(key => Math.abs(object.camera[key] - camera[key]) < 1e-12));
  let rotation;
  const stage = { viewerControls: { position: { set() {} }, distance() {}, rotate(q) { rotation = q; }, changed() {} } };
  assert.equal(d3.applyCameraJson(stage, object.camera), true);
  assert.ok(rotation.every((value, i) => Math.abs(value - [0, Math.SQRT1_2, 0, Math.SQRT1_2][i]) < 1e-12));
  assert.equal(d3.normalizeCamera({ ...camera, qw: NaN }), null);
  assert.equal(d3.normalizeCamera({ ...camera, qy: 0, qw: 0 }), null);
  assert.equal(d3.normalizeCamera({ px: 0, py: 0, pz: 0, distance: 1, qx: 0 }), null);
});


test('empty MOL title remains a header line when a generated structure is stored', () => {
  const source = '\n' + MOLBLOCK.split('\n').slice(1).join('\n');
  const object = d3.createObject({ molfile: source });
  assert.equal(object.molfile.split('\n')[0], '');
  assert.ok(object.molfile.split('\n')[3].includes('V2000'));
  assert.equal(object.molfile, source);
});
