// Starts the dev app against the live smoothyedit.com API so sign-in, plan
// checks and Community work without running the website locally.
// Usage: npm run dev:live   (pass extra electron-vite flags after --)
const { spawn } = require('node:child_process');
const env = { ...process.env, SMOOTHY_API_URL: process.env.SMOOTHY_API_URL || 'https://smoothyedit.com' };
const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(bin, ['electron-vite', 'dev', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
