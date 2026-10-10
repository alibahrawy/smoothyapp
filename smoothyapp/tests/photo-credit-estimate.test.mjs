import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
const bundle = await build({ entryPoints: [new URL('../src/renderer/photo-credit-estimate.js', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url) });
const { estimatePhotoCredits: estimate, formatPhotoEstimate: format } = module.exports;
const catalog = JSON.parse(fs.readFileSync(new URL('../src/shared/photo-catalog.json', import.meta.url)));
const imagePricing = JSON.parse(fs.readFileSync(new URL('../src/shared/photo-image-pricing.json', import.meta.url)));

test('every model with a published tariff has a nonzero estimate and unknown tariffs stay unavailable', () => {
  assert.equal(catalog.DEFAULT_IMAGE_MODEL, 'openai/gpt-image-2.5-flare');
  for (const { id } of catalog.IMAGE_MODELS) {
    const range = estimate({ model: id, imageSize: '1K' });
    const hasTariff = Boolean(catalog.IMAGE_TOKEN_PRICING[id] || imagePricing.models[id]);
    if (hasTariff) assert.ok(range?.low > 0 && range.high >= range.low, id);
    else assert.equal(range, null, id);
  }
});
test('flat-price models round each image to five credits before totaling a reaction batch', () => {
  const range = estimate({ model: 'bytedance-seed/seedream-5-0-flash', count: 3 });
  assert.equal(range.low, 60); assert.equal(range.high, 60); assert.equal(format(range), '≈ 60 credits total');
  assert.equal(estimate({ model: 'bytedance-seed/seedream-4.5', imageSize: '4K' }).low, 40);
});
test('published resolution tariffs and reference input charges affect the estimate', () => {
  assert.equal(estimate({ model: 'black-forest-labs/flux-3-image', imageSize: '4K' }).low, 610);
  const noRef = estimate({ model: 'x-ai/grok-imagine-image-2.0', imageSize: '2K' });
  const withRef = estimate({ model: 'x-ai/grok-imagine-image-2.0', imageSize: '2K', references: 2 });
  assert.equal(noRef.low, 60); assert.equal(noRef.high, 80);
  assert.equal(withRef.low, 80); assert.equal(withRef.high, 100);
  assert.ok(estimate({ model: 'black-forest-labs/flux.2-flex', references: 2 }).high > estimate({ model: 'black-forest-labs/flux.2-flex' }).high);
});
test('chat-image estimates follow existing app token billing and ignore hidden size choices', () => {
  assert.equal(estimate({ model: 'google/gemini-3.1-flash-image', imageSize: '1K' }).low, 40);
  assert.equal(estimate({ model: 'google/gemini-3.1-flash-image', imageSize: '4K' }).low, 90);
  const lite = estimate({ model: 'google/gemini-3.1-flash-lite-image', imageSize: '4K' });
  assert.equal(lite.low, estimate({ model: 'google/gemini-3.1-flash-lite-image', imageSize: '1K' }).low);
});
test('unpublished prices and unknown models show unavailable, without inventing zero cost', () => {
  assert.equal(estimate({ model: 'krea/krea-2-medium' }), null);
  assert.equal(estimate({ model: 'sourceful/riverflow-v2-fast', imageSize: '4K' }), null);
  assert.equal(estimate({ model: 'unknown' }), null); assert.equal(format(null), 'Estimate unavailable');
});
