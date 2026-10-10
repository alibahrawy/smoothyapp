import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const stubs = {
  electron: `const f=globalThis.fixture;export const app={getPath:()=>f.folder},ipcMain={handle:(name,fn)=>f.handlers.set(name,fn)},protocol={registerSchemesAsPrivileged(){},handle:(_name,fn)=>{f.preview=fn}},dialog={showSaveDialog:async()=>f.dialog},clipboard={writeImage:image=>{f.copied.push(image.toPNG())}},nativeImage={createFromBuffer:bytes=>({getSize:()=>({width:1,height:1}),isEmpty:()=>f.invalidImage,toPNG:()=>bytes})};`,
  './auth-service': `export const getStoredUserId=()=>globalThis.fixture.user;`,
  './web-api': `const f=globalThis.fixture;export const requestPhotoRoute=async()=>({imageUrl:'data:image/png;base64,'+f.png.toString('base64'),savedReactionId:'history-id'}),fetchPhotoBytes=async()=>f.png;`,
  './telemetry': `export const trackTool=id=>globalThis.fixture.usage.push(id);`,
};
const bundle = await build({ entryPoints: [new URL('../src/main/photo-ipc.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'adapters', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path] }));
} }] });
async function fixture(run) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'smoothy-photo-ipc-'));
  const f = { folder, png, user: 'account-a', usage: [], handlers: new Map(), copied: [], invalidImage: false, dialog: { canceled: true }, connected: true, imports: [], importResult: { success: true } };
  const module = { exports: {} }; vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, Response, URL, fixture: f });
  module.exports.registerPhotos({ window: () => ({}), connected: () => f.connected, importToPremiere: async file => { f.imports.push(file); return f.importResult; } });
  const invoke = (name, input) => f.handlers.get(`photos-${name}`)(null, input);
  try { const result = await invoke('run', { action: 'generate', aspectRatio: '1:1', prompt: 'A sky' }); assert.equal(result.success, true); f.id = result.photo.id; f.usage = []; await run(f, invoke); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
test('canceling PNG save writes nothing and counts nothing; successful save writes PNG once', async () => fixture(async (f, invoke) => {
  assert.equal((await invoke('save', f.id)).canceled, true); assert.deepEqual(await readdir(f.folder), []); assert.deepEqual(f.usage, []);
  f.dialog = { canceled: false, filePath: path.join(f.folder, 'saved.png') };
  assert.equal((await invoke('save', f.id)).success, true); assert.deepEqual(await readFile(f.dialog.filePath), png); assert.deepEqual(f.usage, ['photos_save']);
}));
test('invalid IDs, images and failed writes do not count exports or clipboard copies', async () => fixture(async (f, invoke) => {
  f.dialog = { canceled: false, filePath: path.join(f.folder, 'missing', 'image.png') };
  assert.equal((await invoke('save', f.id)).success, false);
  assert.equal((await invoke('copy', '../../private-file')).success, false);
  await invoke('reset'); f.invalidImage = true;
  const generated = await invoke('run', { action: 'generate', aspectRatio: '1:1', prompt: 'Sky' }); f.usage = [];
  assert.equal((await invoke('copy', generated.photo.id)).success, false); assert.deepEqual(f.copied, []); assert.deepEqual(f.usage, []);
}));
test('Premiere import requires a connection, keeps permanent PNG media and counts only a successful import', async () => fixture(async (f, invoke) => {
  f.connected = false; assert.equal((await invoke('premiere', f.id)).success, false); assert.deepEqual(f.imports, []); assert.deepEqual(f.usage, []);
  f.connected = true; f.importResult = { success: false, error: 'No open project' };
  assert.match((await invoke('premiere', f.id)).error, /No open project/); assert.deepEqual(f.usage, []);
  assert.deepEqual(await readFile(f.imports[0]), png); assert.equal(path.dirname(f.imports[0]), path.join(f.folder, 'SmoothyEdit AI Photos'));
  f.importResult = { success: true }; assert.equal((await invoke('premiere', f.id)).success, true); assert.deepEqual(f.usage, ['photos_premiere']);
}));
test('copy and explicit preview validate issued image IDs; protocol reads remain uncounted and expire on sign-out', async () => fixture(async (f, invoke) => {
  assert.equal((await invoke('copy', f.id)).success, true); assert.deepEqual(f.copied, [png]);
  assert.equal((await invoke('preview', 'private-path')).success, false);
  assert.equal((await invoke('preview', f.id)).success, true);
  assert.equal((await f.preview({ url: `smoothy-photo://image/${f.id}` })).status, 200);
  assert.deepEqual(f.usage, ['photos_copy', 'photos_preview']);
  f.user = null; assert.equal((await f.preview({ url: `smoothy-photo://image/${f.id}` })).status, 404); assert.equal((await invoke('copy', f.id)).success, false);
}));
