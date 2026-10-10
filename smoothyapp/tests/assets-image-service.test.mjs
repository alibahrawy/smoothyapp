import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';

async function load(source) {
  const result = await build({ entryPoints: [new URL('../src/main/' + source, import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['sharp'] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const { createAssetsImageService } = await load('assets-image-service.ts');
const { ASSET_MODELS, ensureAssetModel } = await load('assets-models.ts');
const image = new Uint8Array(await sharp({ create: { width: 20, height: 12, channels: 4, background: { r: 200, g: 90, b: 30, alpha: 0.5 } } }).png().toBuffer());
function fixture(overrides = {}) {
  const events = [], jobs = [], downloads = [];
  const service = createAssetsImageService({ modelRoot: () => '/fixture', track: id => events.push(id),
    ensureModel: async op => { downloads.push(op); return '/fixture/model.onnx'; },
    spawn: async job => { jobs.push(job); await sharp(job.input).resize(job.operation === 'upscale' ? 20 * job.factor : 20, job.operation === 'upscale' ? 12 * job.factor : 12).png().toFile(job.output); }, ...overrides });
  return { service, events, jobs, downloads, run: (operation = 'remove-background', factor = 2) => service.process({ operation, factor, bytes: image }, () => {}) };
}
test('successful local processing reports a separate action after a verified output, and cleans image scratch files', async () => {
  const f = fixture();
  for (const [op, factor] of [['remove-background', 2], ['upscale', 2], ['upscale', 4]]) {
    const result = await f.run(op, factor);
    assert.equal(result.success, true);
    assert.equal(result.width, op === 'upscale' ? 20 * factor : 20);
    assert.equal((await sharp(result.bytes).metadata()).hasAlpha, true);
    await assert.rejects(fs.access(path.dirname(f.jobs.at(-1).input)));
  }
  assert.deepEqual(f.events, ['assets_remove_background', 'assets_upscale', 'assets_upscale']);
});
test('invalid operation, empty/invalid image, output limits and invalid scale never download or count', async () => {
  const f = fixture();
  const large = new Uint8Array(await sharp({ create: { width: 2200, height: 4, channels: 3, background: '#fff' } }).png().toBuffer());
  for (const input of [null, {}, { operation: 'cloud', bytes: image }, { operation: 'upscale', factor: 3, bytes: image }, { operation: 'upscale', factor: 4, bytes: large }, { operation: 'remove-background', bytes: new Uint8Array() }, { operation: 'remove-background', bytes: new Uint8Array([1, 2, 3]) }]) {
    assert.equal((await f.service.process(input, () => {})).success, false);
  }
  assert.deepEqual(f.downloads, []); assert.deepEqual(f.events, []);
});
test('download failures, worker crashes, invalid output and analytics errors cannot report false successes', async () => {
  for (const overrides of [
    { ensureModel: async () => { throw new Error('Offline'); } },
    { spawn: async () => { throw new Error('Worker stopped'); } },
    { spawn: async job => fs.writeFile(job.output, 'invalid output') },
  ]) { const f = fixture(overrides); assert.equal((await f.run()).success, false); assert.deepEqual(f.events, []); }
  const f = fixture({ track: () => { throw new Error('Analytics blocked'); } });
  assert.equal((await f.run()).success, true);
});
test('canceling download and native work returns canceled, cleans scratch, permits retry and rejects duplicate work', async () => {
  for (const boundary of ['ensureModel', 'spawn']) {
    let release, started;
    const ready = new Promise(resolve => started = resolve);
    const f = fixture({ [boundary]: async (...args) => {
      const signal = boundary === 'ensureModel' ? args[2] : args[2];
      if (boundary === 'spawn') f.jobs.push(args[0]);
      started();
      await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }); });
      return '/fixture/model.onnx';
    } });
    const pending = f.run(); await ready;
    assert.match((await f.run()).error, /already/);
    f.service.cancel(); const result = await pending;
    assert.equal(result.canceled, true); assert.deepEqual(f.events, []);
    for (const job of f.jobs) await assert.rejects(fs.access(path.dirname(job.input)));
    release();
  }
});
test('pinned download is atomic, verifies size/hash, reuses a valid offline model, and rejects corruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-model-test-'));
  const model = ASSET_MODELS['remove-background'];
  const original = { ...model }; const bytes = Buffer.from('trusted model fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  Object.assign(model, { size: bytes.length, sha256: hash, files: [{ name: 'model.onnx', size: bytes.length, sha256: hash }] });
  const signal = new AbortController().signal;
  let requests = 0;
  const download = async () => { requests++; return new Response(bytes); };
  try {
    const file = await ensureAssetModel('remove-background', root, signal, () => {}, download);
    assert.deepEqual(await fs.readFile(file), bytes);
    await ensureAssetModel('remove-background', root, signal, () => {}, async () => { throw new Error('Must work offline'); });
    assert.equal(requests, 1);
    await fs.writeFile(file, 'corrupted');
    await assert.rejects(ensureAssetModel('remove-background', root, signal, () => {}, async () => new Response('tampered bytes')), /verification|size/);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('download-')), []);
    await ensureAssetModel('remove-background', root, signal, () => {}, download);
    const cancel = new AbortController(); cancel.abort();
    await assert.rejects(ensureAssetModel('remove-background', root, cancel.signal, () => {}, download));
  } finally { Object.assign(model, original); await fs.rm(root, { recursive: true, force: true }); }
});
