import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const bundle = await build({ entryPoints: [new URL('../src/main/photo-service.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { PhotoService, validatePhotoReferences } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
function fixture(overrides = {}) {
  const calls = [], usage = []; let user = 'account-a';
  const deps = { owner: () => user, request: async (route, options) => {
    calls.push({ route, options });
    if (route.startsWith('/api/reactions?')) return { reactions: [{ id: 'history-a', reactionLabel: '<img onerror=bad>', imageUrl, isFavorite: false }], totalPages: 2 };
    if (route === '/api/enhance-prompt') return { enhanced: 'Better image prompt' };
    return { imageUrl, savedReactionId: 'saved-a' };
  }, imageBytes: async () => png, png: bytes => bytes, track: id => usage.push(id), ...overrides };
  return { service: new PhotoService(deps), deps, calls, usage, setUser: value => { user = value; } };
}
test('all web models, aspect ratios, sizes and 18 reaction prompts stay identical to the generated desktop catalog', async t => {
  let source;
  const sourcePath = process.env.SMOOTHY_PHOTO_WEB_SOURCE ? pathToFileURL(process.env.SMOOTHY_PHOTO_WEB_SOURCE) : new URL('../../web/src/components/dashboard/lib.ts', import.meta.url);
  try { source = await readFile(sourcePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Web/desktop parity runs in the source monorepo.'); throw error; }
  const context = { module: { exports: {} } }; vm.runInNewContext((await transform(source.slice(source.indexOf('export const IMAGE_MODELS =')), { loader: 'ts', format: 'cjs' })).code, context);
  const catalog = JSON.parse(await readFile(new URL('../src/shared/photo-catalog.json', import.meta.url), 'utf8'));
  const pricing = { module: { exports: {} } };
  vm.runInNewContext((await transform(await readFile(new URL('../../lib/model-pricing.ts', sourcePath), 'utf8'), { loader: 'ts', format: 'cjs' })).code, pricing);
  for (const key of Object.keys(catalog)) {
    const expected = key === 'IMAGE_TOKEN_PRICING' ? Object.fromEntries(catalog.IMAGE_MODELS.filter(model => catalog.MODEL_CAPABILITIES[model.id].api !== 'images').map(model => [model.id, pricing.module.exports.MODEL_PRICING[model.id]])) : context.module.exports[key];
    // Desktop display names/order may differ; model identities/settings stay shared.
    assert.deepEqual(JSON.parse(JSON.stringify(key === 'IMAGE_MODELS' ? expected.map(model => model.id).sort() : expected)), key === 'IMAGE_MODELS' ? catalog[key].map(model => model.id).sort() : catalog[key]);
  }
  assert.equal(catalog.REACTION_PRESETS.length, 18);
});
test('auth, invalid actions and invalid references fail before requests or telemetry', async () => {
  const f = fixture(); f.setUser(null); await assert.rejects(f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' }), /Sign in/);
  f.setUser('account-a');
  for (const input of [{ action: 'shell' }, { action: 'generate', aspectRatio: '1:1', prompt: '' }, { action: 'edit', prompt: 'Sky' }, { action: 'preset', aspectRatio: '1:1', presetId: 'fake', references: [imageUrl] }, { action: 'upscale' }, { action: 'generate', aspectRatio: '1:1', prompt: 'Sky', references: ['not an image'] }]) await assert.rejects(f.service.run(input));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.usage, []);
  assert.throws(() => validatePhotoReferences(Array(7).fill(imageUrl)), /up to 6/);
  assert.deepEqual(validatePhotoReferences([imageUrl]), [png.toString('base64')]);
});
test('text/reference generation uses the web API, validates settings, keeps credentials/remote URLs out of returned images', async () => {
  const f = fixture();
  const result = await f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky', model: 'invalid', imageSize: '4K', aspectRatio: '1:1' });
  const body = f.calls[0].options.body;
  assert.equal(body.model, 'openai/gpt-image-2.5-flare'); assert.equal(body.imageSize, undefined); assert.equal(body.aspectRatio, '1:1'); assert.equal(body.imageType, 'text-to-image'); assert.deepEqual(body.images, []);
  assert.match(result.photo.previewUrl, /^smoothy-photo:\/\/image\/[0-9a-f-]{36}$/); assert.equal(result.photo.imageUrl, undefined);
  assert.deepEqual(f.usage, ['photos_generate']);
  await f.service.run({ action: 'edit', aspectRatio: '1:1', references: [imageUrl], prompt: 'Blue sky', model: 'openai/gpt-5-image-mini', imageSize: '4K', subject: 'A person in a red shirt' });
  assert.equal(f.calls[1].options.body.imageSize, undefined); assert.match(f.calls[1].options.body.prompt, /Subject details: A person in a red shirt/); assert.equal(f.calls[1].options.body.imageType, 'edit');
});
test('reactions retain instructions and reject the removed desktop tools without requests', async () => {
  const f = fixture();
  await f.service.run({ action: 'preset', aspectRatio: '1:1', presetId: 'curious', prompt: 'Keep the blue shirt', references: [imageUrl] });
  assert.match(f.calls[0].options.body.prompt, /thoughtfully/); assert.match(f.calls[0].options.body.prompt, /Additional instructions: Keep the blue shirt/);
  for (const action of ['enhance','upscale','remove-background','vertical']) await assert.rejects(f.service.run({ action, prompt: 'Sky', references: [imageUrl] }), /supported image action/);
  assert.equal(f.calls.length,1); assert.deepEqual(f.usage,['photos_preset']);
});
test('new models retain their exact ID and enforce reference, ratio and resolution bounds before requests', async () => {
  const f=fixture();
  await f.service.run({action:'generate',model:'black-forest-labs/flux.2-pro',prompt:'A sky'}); assert.equal(f.calls[0].options.body.model,'black-forest-labs/flux.2-pro');
  for (const input of [{model:'black-forest-labs/flux.2-klein-4b',references:Array(5).fill(imageUrl)},{model:'x-ai/grok-imagine-image-2.0',aspectRatio:'21:9'},{model:'bytedance-seed/seedream-5-0-flash',imageSize:'4K'}]) await assert.rejects(f.service.run({action:'generate',prompt:'A sky',...input}),/accepts up to|supported shape|supported resolution/);
  assert.equal(f.calls.length,1); assert.deepEqual(f.usage,['photos_generate']);
});
test('every catalog model generates with supported defaults and has matching native reference limits', async () => {
  const catalog = JSON.parse(await readFile(new URL('../src/shared/photo-catalog.json', import.meta.url), 'utf8'));
  for (const { id } of catalog.IMAGE_MODELS) {
    const f = fixture(), caps = catalog.MODEL_CAPABILITIES[id];
    await f.service.run({ action: 'generate', model: id, prompt: 'A landscape' });
    const body = f.calls[0].options.body;
    assert.equal(body.model, id);
    if (caps.aspectRatios) assert.ok(caps.aspectRatios.includes(body.aspectRatio), id);
    if (caps.supportsImageSize && caps.imageSizes) assert.ok(caps.imageSizes.includes(body.imageSize), id);
    assert.deepEqual(f.usage, ['photos_generate']);
    if (caps.maxReferences !== undefined) {
      assert.ok(caps.maxReferences <= 6, id);
      await assert.rejects(f.service.run({ action: 'generate', model: id, prompt: 'A landscape', references: Array(caps.maxReferences + 1).fill(imageUrl) }), /up to/);
      assert.equal(f.calls.length, 1, id); assert.deepEqual(f.usage, ['photos_generate']);
    }
  }
});
test('rejected/failed cloud requests and invalid results have no successful-action counts; overlap is blocked', async () => {
  let release; const f = fixture({ request: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' });
  await assert.rejects(f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' }), /Wait/);
  release({}); await assert.rejects(pending, /no image/); assert.deepEqual(f.usage, []);
  f.deps.request = async () => { throw Error('No credits remaining'); };
  await assert.rejects(f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' }), /No credits/); assert.deepEqual(f.usage, []);
});
test('history pagination is read-only, favorite changes count once, deletion invalidates image capabilities', async () => {
  const f = fixture(); const page = await f.service.history(2, true), photo = page.items[0];
  assert.equal(f.calls[0].route, '/api/reactions?page=2&limit=20&favorites=true'); assert.deepEqual(f.usage, []);
  const again = await f.service.history(2, true); assert.equal(again.items[0].id, photo.id);
  await f.service.favorite(photo.id, true); await f.service.favorite(photo.id, true);
  assert.equal(f.calls.filter(call => call.options?.method === 'PATCH').length, 1);
  await f.service.remove(photo.id); await assert.rejects(f.service.bytes(photo.id), /no longer available/);
  assert.deepEqual(f.usage, ['photos_favorite', 'photos_delete']);
});
test('account changes clear IDs and reject in-flight results before returning or counting', async () => {
  const f = fixture(); const photo = (await f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' })).photo;
  f.setUser('account-b'); await assert.rejects(f.service.bytes(photo.id), /no longer available/);
  let release; f.deps.request = () => new Promise(resolve => { release = resolve; });
  const pending = f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' }); f.setUser(null); release({ imageUrl });
  await assert.rejects(pending, /account changed/); assert.deepEqual(f.usage, ['photos_generate']);
});
test('PNG reads cache output but invalidate on logout/reset; oversized or undecodable files fail without counters', async () => {
  let reads = 0; const f = fixture({ imageBytes: async () => { reads++; return png; } });
  const photo = (await f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' })).photo;
  assert.deepEqual(await f.service.bytes(photo.id), png); await f.service.bytes(photo.id); assert.equal(reads, 1);
  f.service.reset(); await assert.rejects(f.service.bytes(photo.id));
  const bad = fixture({ imageBytes: async () => Buffer.alloc(25 * 1024 * 1024 + 1) });
  const id = (await bad.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' })).photo.id; await assert.rejects(bad.service.bytes(id), /25 MB/);
});


test('paid cloud-save failures preserve a downloadable result and one generation success', async () => {
  const f = fixture({ request: async () => ({ imageUrl, savedReactionId: null, historySaved: false, cloudStorageAvailable: true }) });
  const result = await f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' });
  assert.equal(result.historySaved, false); assert.equal(result.cloudStorageAvailable, true);
  assert.equal(result.photo.historyId, null); assert.deepEqual(await f.service.bytes(result.photo.id), png);
  await assert.rejects(f.service.favorite(result.photo.id, true), /Reload image history/);
  assert.deepEqual(f.usage, ['photos_generate']);
});
test('free cloud-image policy comes from the server while generation and downloads still succeed', async () => {
  const f = fixture({ request: async route => route.startsWith('/api/reactions?')
    ? { reactions: [], totalPages: 0, totalItems: 0, cloudStorageAvailable: false }
    : { imageUrl, savedReactionId: null, historySaved: false, cloudStorageAvailable: false } });
  const history = await f.service.history(); assert.equal(history.cloudStorageAvailable, false);
  assert.deepEqual(history.items, []); assert.deepEqual(f.usage, []);
  const result = await f.service.run({ action: 'generate', aspectRatio: '1:1', prompt: 'Sky' });
  assert.equal(result.cloudStorageAvailable, false); assert.equal(result.historySaved, false);
  assert.deepEqual(await f.service.bytes(result.photo.id), png); assert.deepEqual(f.usage, ['photos_generate']);
});
