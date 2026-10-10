import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/main/studio-source-service.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { createStudioSourceService } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture(overrides = {}) {
  const f = { owner: 'a', enabled: true, busy: false, events: [], reads: [], prepares: [], stop: 0, ...overrides };
  const service = createStudioSourceService({ owner: () => f.owner, enabled: () => f.enabled, busy: () => f.busy,
    pickTranscript: async () => f.pick ? f.pick() : f.canceled ? null : '/fixture/private.srt',
    readTranscript: async file => { f.reads.push(file); if (f.failure) throw Error(f.failure); return { subtitleText: f.text ?? 'A local transcript', fileName: 'private.srt' }; },
    prepareAudio: async (input, signal) => { f.prepares.push({ input, signal }); if (f.prepare) return f.prepare(input, signal); if (f.failure) throw Error(f.failure); return { subtitleText: f.text ?? 'Timestamped local speech', fileName: 'Private sequence' }; },
    stopAudio: async () => { f.stop++; }, track: id => { if (f.analyticsFailure) throw Error('Offline'); f.events.push(id); },
  }); return { f, service };
}
test('transcript/Premiere/media imports each count once only after native preparation, without paths/content in analytics', async () => {
  const { f, service } = fixture();
  for (const source of ['transcript','sequence','audio']) assert.ok((await service.importSource({ source })).subtitleText);
  assert.deepEqual(f.events, Array(3).fill('studio_transcript_import')); assert.equal(f.reads.length, 1); assert.equal(f.prepares.length, 2);
});
test('canceled dialogs, invalid/empty/oversized sources, failed reads/transcription and access/job guards count zero', async () => {
  const { f, service } = fixture({ canceled: true }); assert.equal((await service.importSource({ source: 'transcript' })).canceled, true);
  for (const source of ['',null,'youtube']) await assert.rejects(service.importSource({ source }));
  f.canceled = false;
  for (const text of ['', ' '.repeat(10), 'x'.repeat(2_000_001)]) { f.text = text; await assert.rejects(service.importSource({ source: 'transcript' })); }
  f.text = 'Speech'; f.failure = 'Disk failure'; await assert.rejects(service.importSource({ source: 'transcript' }), /Disk/); await assert.rejects(service.importSource({ source: 'sequence' }), /Disk/);
  f.failure = null; f.owner = null; await assert.rejects(service.importSource({ source: 'sequence' }), /Sign in/); f.owner = 'a'; f.enabled = false; await assert.rejects(service.importSource({ source: 'sequence' }), /turned off/); f.enabled = true; f.busy = true; await assert.rejects(service.importSource({ source: 'sequence' }), /Wait/);
  assert.deepEqual(f.events, []);
});
test('cancel/account changes/AI-off during dialog or transcription reject stale imports and allow a later job', async () => {
  for (const type of ['dialog','audio']) for (const change of ['cancel','owner','disabled']) {
    let finish; const pending = () => new Promise(resolve => { finish = resolve; }); const { f, service } = fixture(type === 'dialog' ? { pick: pending } : { prepare: pending });
    const job = service.importSource({ source: type === 'dialog' ? 'transcript' : 'sequence' }); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.importSource({ source: 'sequence' }), /Wait/);
    if (change === 'cancel') service.cancel(); else if (change === 'owner') f.owner = 'b'; else f.enabled = false;
    finish(type === 'dialog' ? '/fixture/private.srt' : { subtitleText: 'Stale speech', fileName: 'Private' }); await assert.rejects(job, /canceled/); assert.deepEqual(f.events, []);
    if (type === 'audio' && change === 'cancel') { assert.equal(f.stop, 1); assert.equal(f.prepares[0].signal.aborted, true); }
    f.enabled = true; f.pick = f.prepare = null; assert.ok((await service.importSource({ source: 'transcript' })).subtitleText);
  }
});
test('failed telemetry cannot block a valid local import', async () => { const { service } = fixture({ analyticsFailure: true }); assert.equal((await service.importSource({ source: 'transcript' })).subtitleText, 'A local transcript'); });

// Exercise the actual native Shorts copy handler, including failed writes.
test('Shorts title/description clipboard writes use the existing successful Studio copy count', async () => {
  const { readFile } = await import('node:fs/promises'), { transform } = await import('esbuild'), vm = await import('node:vm');
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'), start = main.indexOf("ipcMain.handle('copy-shorts-text'"), end = main.indexOf('\n});', start) + 4;
  const code = (await transform(main.slice(start, end), { loader: 'ts' })).code;
  let handle, enabled = true, fail = false; const events = [], writes = [];
  vm.runInNewContext(code, { ipcMain: { handle: (_, fn) => { handle = fn; } }, appPreferences: { snapshot: () => ({ studioEnabled: enabled }) }, clipboard: { writeText: text => { if (fail) throw Error('Clipboard failed'); writes.push(text); } }, trackTool: id => events.push(id) });
  assert.equal(handle(null, 'A title').success, true); assert.equal(handle(null, 'A description').success, true); assert.deepEqual(events, ['studio_copy','studio_copy']);
  for (const value of [null, '', '  ', 'x'.repeat(2_000_001)]) assert.equal(handle(null, value).success, false);
  fail = true; assert.throws(() => handle(null, 'Rejected write'), /Clipboard/); enabled = false; assert.equal(handle(null, 'Disabled').success, false);
  assert.equal(events.length, 2); assert.equal(writes.length, 2);
});
