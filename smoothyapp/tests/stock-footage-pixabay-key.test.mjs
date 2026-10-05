import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const key = '12345678-1234567890abcdef12345678';
const endpoint = 'https://stock.example/api/stock/pixabay';
const hit = { id: 12, type: 'film', tags: 'ocean', duration: 10, user: 'Creator', pageURL: 'https://pixabay.com/videos/id-12/', videos: {
  large: { url: 'https://cdn.pixabay.com/video/2026/ocean.mp4', thumbnail: 'https://cdn.pixabay.com/video/2026/ocean.jpg', width: 3840, height: 2160, size: 1000 }
} };
const data = () => Response.json({ totalHits: 30, hits: [hit] });
const bundle = (apiKey) => build({ stdin: { contents: "export * from './src/main/stock-footage';", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'esm', write: false,
  define: { __SMOOTHY_STOCK_SERVICE_URL__: JSON.stringify(''), __SMOOTHY_PIXABAY_API_KEY__: JSON.stringify(apiKey) } });
const load = async (apiKey) => { const output = await bundle(apiKey); return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)).StockFootageService; };

test('A build-injected Pixabay key enables direct search without a service', async () => {
  const calls = [];
  const Service = await load(key);
  const stock = new Service(async (url, options) => { calls.push({ url: new URL(url), options }); return data(); });
  assert.equal(stock.pixabayEnabled, true);
  const result = await stock.search({ query: 'ocean & waves', provider: 'pixabay', size: 'large' });
  assert.equal(result.videos.length, 1); assert.equal(result.nextOffset, 12);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://pixabay.com/api/videos/');
  assert.equal(calls[0].url.searchParams.get('key'), key);
  assert.equal(calls[0].url.searchParams.get('per_page'), '12');
  assert.equal(calls[0].url.searchParams.get('q'), 'ocean & waves');
  assert.equal(calls[0].url.searchParams.get('size'), 'large');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('A malformed or missing key leaves Pixabay unavailable', async () => {
  for (const apiKey of ['', 'short', 'has space in key 1234567890']) {
    const Service = await load(apiKey);
    const stock = new Service(async () => data());
    assert.equal(stock.pixabayEnabled, false);
    await assert.rejects(stock.search({ query: 'ocean', provider: 'pixabay' }), /unavailable in this build/);
  }
});

test('A configured service endpoint takes precedence over the injected key', async () => {
  const calls = [];
  const Service = await load(key);
  const stock = new Service(async (url) => { calls.push(new URL(url)); return data(); });
  stock.configurePixabayService(endpoint);
  await stock.search({ query: 'ocean', provider: 'pixabay' });
  assert.equal(calls[0].origin + calls[0].pathname, endpoint);
  assert.equal(calls[0].searchParams.get('key'), null);
});
