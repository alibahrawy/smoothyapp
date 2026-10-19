// Development convenience; the shipped app exposes the same installer in Multicam.
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = buildSync({ entryPoints: [path.join(root, 'src/main/resolve/handoff.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
const bundled = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, bundled, bundled.exports);
const { createResolveHandoff, resolveScriptDirectory } = bundled.exports;
const appData = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
if (!appData) throw new Error('Could not locate the application data folder. Install from SmoothyApp instead.');
const directory = path.join(appData, 'SmoothyEdit-2.1-Resolve-Dev', 'resolve-handoff');
fs.mkdirSync(directory, { recursive: true });
const helper = createResolveHandoff({ directory, scriptDirectory: resolveScriptDirectory(process.platform, appData, os.homedir()), receive: () => false });
const status = helper.install();
console.log('Installed:', status.scriptPath);
console.log('Resolve menu:', status.menu);
console.log('The native Free-edition export still needs testing in Resolve.');
