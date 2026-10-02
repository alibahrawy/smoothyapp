import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';

// Run the real IPC handlers with local filesystem/dialog/bridge adapters.
// No files are imported to Premiere and no production telemetry is submitted.
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const start = main.indexOf("ipcMain.handle('assets-save-png'");
const end = main.indexOf("ipcMain.handle('assets-read-clipboard'", start);
assert.ok(start >= 0 && end > start);
const handlersCode = (await transform(main.slice(start, end), { loader: 'ts' })).code;
function fixture({ canceled = false, diskError = false, importSuccess = true } = {}) {
  const handlers = new Map();
  const events = [];
  const writes = [];
  const write = file => {
    if (diskError) throw new Error('Disk full');
    writes.push(file);
  };
  vm.runInNewContext(handlersCode, {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow: {}, Buffer, path, console: { error() {} },
    dialog: { showSaveDialog: async () => ({ canceled, filePath: canceled ? undefined : '/fixture/private-logo.png' }) },
    fs: { mkdirSync() {}, writeFileSync: write },
    sanitizePngName: () => 'private-logo.png',
    getAssetsOutputFolder: () => '/fixture',
    writePngFile: folder => { const file = folder + '/private-logo.png'; write(file); return file; },
    importImageToNLE: async () => ({ success: importSuccess, error: importSuccess ? undefined : 'Premiere rejected image' }),
    trackTool: event => events.push(event),
  });
  return { events, writes, save: handlers.get('assets-save-png'), send: handlers.get('assets-send-to-premiere') };
}
const image = { fileName: 'private-logo.svg', bytes: new Uint8Array([137, 80, 78, 71]) };

test('PNG exports count each successful image, including Save As', async () => {
  const f = fixture();
  for (const options of [image, image, { ...image, saveAs: true }]) {
    assert.equal((await f.save(null, options)).success, true);
  }
  assert.equal(f.writes.length, 3);
  assert.deepEqual(f.events, ['assets_export', 'assets_export', 'assets_export']);
});

test('canceling Save As does not count an export', async () => {
  const f = fixture({ canceled: true });
  assert.equal((await f.save(null, { ...image, saveAs: true })).canceled, true);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.writes, []);
});

test('empty images and failed writes do not report successful actions', async () => {
  const empty = fixture();
  const input = { ...image, bytes: new Uint8Array() };
  assert.equal((await empty.save(null, input)).success, false);
  assert.equal((await empty.send(null, input)).success, false);
  assert.deepEqual(empty.events, []);
  const full = fixture({ diskError: true });
  assert.equal((await full.save(null, image)).success, false);
  assert.equal((await full.send(null, image)).success, false);
  assert.deepEqual(full.events, []);
});

test('a rejected Premiere import counts neither a send nor an export', async () => {
  const f = fixture({ importSuccess: false });
  assert.equal((await f.send(null, image)).success, false);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.events, []);
});

test('a successful Premiere import counts once without counting its temporary PNG as an export', async () => {
  const f = fixture();
  assert.equal((await f.send(null, image)).success, true);
  assert.deepEqual(f.events, ['assets_premiere']);
});

async function telemetry(disabled = false) {
  const bundle = await build({
    entryPoints: [new URL('../src/main/telemetry.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'node', write: false,
    define: { 'process.env.SMOOTHY_TELEMETRY': JSON.stringify(disabled ? '0' : '1') },
    plugins: [{ name: 'fixture-electron', setup(builder) {
      builder.onResolve({ filter: /^(electron|electron-store)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'electron'
        ? "export const app = { getVersion: () => 'test-next-release' };"
        : 'export default class Store {}' }));
    } }],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  module.initTelemetry({ get: () => 'anonymous-fixture-install', set() { throw new Error('Unexpected store write'); } });
  return module;
}

test('Assets telemetry contains only the anonymous install and action metadata', async () => {
  const original = globalThis.fetch;
  const payloads = [];
  try {
    globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body)); return new Response(); };
    const client = await telemetry();
    client.trackTool('assets_export'); client.trackTool('assets_premiere');
    assert.deepEqual(payloads.map(p => p.tool), ['assets_export', 'assets_premiere']);
    for (const payload of payloads) {
      assert.deepEqual(Object.keys(payload).sort(), ['appVersion', 'event', 'installId', 'platform', 'tool']);
      assert.equal(payload.event, 'tool_run');
      assert.equal(payload.installId, 'anonymous-fixture-install');
    }
  } finally { globalThis.fetch = original; }
});

test('Assets actions respect the existing telemetry opt-out', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Telemetry must not send'); };
    const client = await telemetry(true);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(); };
    client.trackTool('assets_export'); client.trackTool('assets_premiere');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('an offline telemetry request does not fail an Assets action', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Offline'); };
    const client = await telemetry();
    assert.doesNotThrow(() => client.trackTool('assets_export'));
    await new Promise(resolve => setImmediate(resolve));
  } finally { globalThis.fetch = original; }
});
