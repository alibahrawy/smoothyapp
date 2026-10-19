const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, NODE_ENV: 'production', SMOOTHY_RESOLVE_DEV: '1', SMOOTHY_TELEMETRY: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [root], { cwd: root, env, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
