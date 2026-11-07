import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/main/update-service.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { createUpdateService } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture({ saved = new Map(), packaged = true, configured = packaged, fetchNotes = async () => '## Fixed\n- Camera clips preserved\n## New\n- Update choices' } = {}) {
  const updater = new EventEmitter(), calls = { checks: 0, downloads: 0, installs: [] }, events = [];
  let release = '2.0.1', downloadError = false;
  updater.checkForUpdates = async () => { calls.checks++; updater.emit('checking-for-update'); updater.emit('update-available', { version: release }); };
  updater.downloadUpdate = async () => { calls.downloads++; if (downloadError) throw new Error('Network disconnected'); updater.emit('download-progress', { percent: 45.4 }); updater.emit('update-downloaded', { version: release }); return ['verified-update.zip']; };
  updater.quitAndInstall = (...args) => calls.installs.push(args);
  const service = createUpdateService({ updater, packaged, configured, store: { get: key => saved.get(key), set: (key, value) => saved.set(key, value), delete: key => saved.delete(key) }, fetchNotes, send: state => events.push(state) });
  return { service, updater, saved, calls, events, release: version => { release = version; }, failDownload: value => { downloadError = value; } };
}
test('discovery never downloads, installs or enables install-on-quit', async () => {
  const f = fixture(); await f.service.check();
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false); assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.service.snapshot().status, 'available'); assert.equal(f.calls.downloads, 0); assert.deepEqual(f.calls.installs, []);
  f.updater.emit('update-downloaded', { version: '2.0.1' }); assert.equal(f.service.snapshot().status, 'available');
});
test('skip survives restart and suppresses just the selected release', async () => {
  const f = fixture(); await f.service.check(); assert.equal(f.service.skip('2.0.1').success, true);
  const restarted = fixture({ saved: f.saved }); await restarted.service.check(); assert.equal(restarted.service.snapshot().status, 'skipped'); assert.equal(restarted.calls.downloads, 0);
  restarted.release('2.0.2'); await restarted.service.check(); assert.equal(restarted.service.snapshot().status, 'available'); assert.equal(restarted.service.snapshot().version, '2.0.2');
});
test('manual check reveals a skipped release without downloading', async () => {
  const f = fixture({ saved: new Map([['skippedUpdateVersion', '2.0.1']]) }); await f.service.check(true);
  assert.equal(f.service.snapshot().status, 'available'); assert.equal(f.saved.get('skippedUpdateVersion'), '2.0.1'); assert.equal(f.calls.downloads, 0);
});
test('Install downloads once and waits for an explicit restart to install', async () => {
  const f = fixture(); await f.service.check(); assert.equal((await f.service.install('2.0.1')).success, true);
  assert.equal(f.calls.downloads, 1); assert.equal(f.service.snapshot().status, 'downloaded'); assert.equal(f.service.snapshot().percent, 100); assert.deepEqual(f.calls.installs, []);
  await f.service.check(); assert.equal(f.service.snapshot().status, 'downloaded'); assert.equal(f.calls.checks, 1);
  await f.service.install('2.0.1'); assert.deepEqual(f.calls.installs, [[false, true]]);
});
test('a downloaded release can be skipped and reconsidered without automatic installation', async () => {
  const f = fixture(); await f.service.check(); await f.service.install('2.0.1'); f.service.skip('2.0.1');
  assert.equal(f.service.snapshot().status, 'skipped'); assert.deepEqual(f.calls.installs, []);
  await f.service.install('2.0.1'); assert.equal(f.saved.has('skippedUpdateVersion'), false); assert.equal(f.calls.downloads, 1); assert.deepEqual(f.calls.installs, [[false, true]]);
});
test('stale or malformed actions never download or install', async () => {
  const f = fixture(); assert.equal((await f.service.install('2.0.1')).success, false); await f.service.check();
  for (const value of [null, undefined, {}, '1.5.1', '2.0.2']) { assert.equal((await f.service.install(value)).success, false); assert.equal(f.service.skip(value).success, false); }
  assert.equal(f.calls.downloads, 0); assert.deepEqual(f.calls.installs, []);
});
test('repeated Install, Check and Skip cannot overlap an active download', async () => {
  const f = fixture(); await f.service.check(); let finish;
  f.updater.downloadUpdate = () => { f.calls.downloads++; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.service.install('2.0.1'); assert.equal((await f.service.install('2.0.1')).success, false); assert.equal(f.service.skip('2.0.1').success, false);
  await f.service.check(true); assert.equal(f.calls.checks, 1); f.updater.emit('update-downloaded', { version: '2.0.1' }); finish([]); await pending; assert.equal(f.calls.downloads, 1);
});
test('failed download retries only on another Install click', async () => {
  const f = fixture(); await f.service.check(); f.failDownload(true); assert.equal((await f.service.install('2.0.1')).success, false);
  assert.equal(f.service.snapshot().status, 'error'); assert.match(f.service.snapshot().error, /Network disconnected/); assert.deepEqual(f.calls.installs, []);
  f.failDownload(false); await f.service.install('2.0.1'); assert.equal(f.service.snapshot().status, 'downloaded'); assert.equal(f.calls.downloads, 2);
});
test('late notes for an older release cannot overwrite the new release', async () => {
  const resolve = {}, f = fixture({ fetchNotes: version => new Promise(done => { resolve[version] = done; }) });
  await f.service.check(); f.release('2.0.2'); await f.service.check(); resolve['2.0.2']('New release'); await new Promise(done => setImmediate(done));
  resolve['2.0.1']('Old release'); await new Promise(done => setImmediate(done)); assert.equal(f.service.snapshot().notes, 'New release'); assert.equal(f.service.snapshot().version, '2.0.2');
});
test('unavailable release notes do not block skipping', async () => {
  const f = fixture({ fetchNotes: async () => { throw new Error('Offline'); } }); await f.service.check(); await new Promise(done => setImmediate(done));
  assert.equal(f.service.snapshot().notes, null); assert.equal(f.service.snapshot().notesLoading, false); assert.equal(f.service.skip('2.0.1').success, true);
});
test('old deferred download marker does not block discovery or enable installation on quit', async () => {
  const f = fixture({ saved: new Map([['lastDownloadedUpdateVersion', '1.5.1']]) }); assert.equal(f.saved.has('lastDownloadedUpdateVersion'), false);
  await f.service.check(); assert.equal(f.service.snapshot().status, 'available'); assert.equal(f.updater.autoInstallOnAppQuit, false);
});
test('development mode never requests or installs updates', async () => {
  const f = fixture({ packaged: false }); await f.service.check(true); assert.equal(f.service.snapshot().status, 'dev-build');
  assert.equal((await f.service.install('2.0.1')).success, false); assert.equal(f.calls.checks, 0); assert.equal(f.calls.downloads, 0);
});
test('packaged local preview without release configuration never checks, downloads or installs', async () => {
  const f = fixture({ packaged: true, configured: false });
  assert.equal(f.service.snapshot().status, 'dev-build');
  await f.service.check(); await f.service.check(true);
  assert.equal((await f.service.install('2.0.1')).success, false);
  assert.equal(f.service.skip('2.0.1').success, false);
  assert.equal(f.service.snapshot().status, 'dev-build');
  assert.equal(f.calls.checks, 0); assert.equal(f.calls.downloads, 0); assert.deepEqual(f.calls.installs, []);
});
