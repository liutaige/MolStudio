'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fusionRoot = path.resolve(__dirname, '..');
const python = process.env.MOLSTUDIO_PYTHON || path.resolve(fusionRoot, '../.venv-rdkit/bin/python');
const requestedPort = process.env.MOLSTUDIO_PORT || '48975';
if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) {
  console.error('MOLSTUDIO_PORT 必须是 1–65535 的端口号。');
  process.exit(1);
}
try {
  fs.accessSync(python, fs.constants.X_OK);
} catch {
  console.error('找不到可执行的 Python：' + python);
  console.error('请设置 MOLSTUDIO_PYTHON，指向已安装 RDKit 的 Python 解释器。');
  process.exit(1);
}

const port = String(Number(requestedPort));
const child = spawn(python, ['-B', '-u', path.join(fusionRoot, 'server.py'), port], {
  cwd: fusionRoot,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
  console.error('本地画布服务启动失败：' + error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code === null ? (signal === 'SIGINT' ? 130 : 1) : code;
});
