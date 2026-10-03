import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = await build({ entryPoints: [new URL('../src/main/stock-footage.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { StockFootageService } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const providers = ['commons', 'archive', 'nasa'];
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(60)]);
const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(80)]);
const commons = (id, licensed = true) => ({ pageid: id, index: 1, title: 'File:Earth.webm', videoinfo: [{
  width: 1920, height: 1080, duration: 15, descriptionurl: `https://commons.wikimedia.org/wiki/File:Earth${id}.webm`, thumburl: 'https://thumb.wikimedia.org/earth.jpg',
  extmetadata: { LicenseShortName: { value: licensed ? 'CC0' : 'CC BY' }, AttributionRequired: { value: 'false' }, LicenseUrl: { value: 'https://creativecommons.org/publicdomain/zero/1.0/' } },
  derivatives: [{ src: `https://upload.wikimedia.org/earth${id}.webm`, type: 'video/webm', width: 1920, height: 1080 }] }] });
function fixtures(calls = [], intercept = () => undefined) {
  return async (value, options) => {
    const url = new URL(value); calls.push(url);
    options.signal.throwIfAborted();
    const custom = await intercept(url, options); if (custom !== undefined) return custom;
    if (url.hostname === 'commons.wikimedia.org') {
      const offset = Number(url.searchParams.get('gsroffset'));
      return Response.json({ batchcomplete: true, query: { pages: offset === 0 ? [commons(100, false)] : [commons(100 + offset)] }, ...(offset < 80 ? { continue: { gsroffset: offset + 40 } } : {}) });
    }
    if (url.pathname === '/advancedsearch.php') return Response.json({ response: { numFound: 16, docs: [{ identifier: 'earth' + url.searchParams.get('page') }] } });
    if (url.pathname.startsWith('/metadata/')) {
      const id = url.pathname.split('/').at(-1);
      return Response.json({ metadata: { identifier: id, title: 'Earth', mediatype: 'movies', collection: 'stock_footage', licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/' }, files: ['a', 'b'].map(name => ({ name: name + '.mp4', width: 1920, height: 1080, length: 15 })) });
    }
    if (url.hostname === 'images-api.nasa.gov') {
      const id = 'Earth_' + url.searchParams.get('page');
      return Response.json({ collection: { metadata: { total_hits: 24 }, items: [{ data: [{ nasa_id: id, title: 'Earth', media_type: 'video', center: 'GSFC' }], links: [{ rel: 'preview', href: `https://images-assets.nasa.gov/video/${id}/thumb.jpg` }] }] } });
    }
    if (url.pathname.endsWith('/collection.json')) return Response.json([url.href.replace('collection.json', url.pathname.split('/')[2] + '~small.mp4')]);
    if (url.pathname.endsWith('/metadata.json')) return Response.json({ 'QuickTime:ImageWidth': 1920, 'QuickTime:ImageHeight': 1080, 'QuickTime:Duration': 15 });
    return new Response(url.hostname === 'upload.wikimedia.org' ? webm : mp4);
  };
}
const service = request => new StockFootageService(request, (source, destination) => copyFile(source, destination));

test('All sources search concurrently, interleave providers and retain clip-specific terms', async () => {
  const calls = [], started = new Set();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const stock = service(fixtures(calls, async url => {
    if (['commons.wikimedia.org', 'archive.org', 'images-api.nasa.gov'].includes(url.hostname) && !url.pathname.startsWith('/metadata/')) {
      started.add(url.hostname); if (started.size === 3) release(); await gate;
    }
  }));
  const result = await stock.search({ query: 'earth', provider: 'all' });
  assert.equal(started.size, 3); assert.equal(result.videos.length, 5);
  assert.deepEqual(result.videos.map(video => video.provider), ['commons', 'archive', 'nasa', 'commons', 'archive']);
  assert.match(result.videos[2].usage, /Acknowledge NASA/);
  assert.equal(new Set(result.videos.map(video => video.id)).size, 5);
  const count = calls.length; assert.deepEqual(await stock.search({ query: 'earth', provider: 'all' }), result); assert.equal(calls.length, count);
});
test('mixed pagination preserves filtered Commons offsets, stops exhausted providers and advances independent pages', async () => {
  const calls = [], stock = service(fixtures(calls));
  const first = await stock.search({ query: 'earth', provider: 'all' });
  assert.deepEqual(first.sourceCursors, { commons: { page: 2, cursor: 80, done: true }, archive: { page: 2, cursor: 8, done: false }, nasa: { page: 2, cursor: 8, done: false } });
  const second = await stock.search({ query: 'earth', provider: 'all', page: 2, sourceCursors: first.sourceCursors });
  assert.deepEqual(second.videos.map(video => video.provider), ['archive', 'nasa', 'archive']);
  assert.equal(second.sourceCursors.archive.done, true); assert.equal(second.hasMore, true);
  const third = await stock.search({ query: 'earth', provider: 'all', page: 3, sourceCursors: second.sourceCursors });
  assert.deepEqual(third.videos.map(video => video.provider), ['nasa']); assert.equal(third.hasMore, false);
  assert.equal(calls.filter(url => url.hostname === 'commons.wikimedia.org').length, 3);
  assert.deepEqual(calls.filter(url => url.pathname === '/advancedsearch.php').map(url => url.searchParams.get('page')), ['1', '2']);
  assert.deepEqual(calls.filter(url => url.hostname === 'images-api.nasa.gov').map(url => url.searchParams.get('page')), ['1', '2', '3']);
});
test('failed providers preserve their cursor and recover without repeating successful pages', async () => {
  const calls = []; let unavailable = true;
  const stock = service(fixtures(calls, url => url.hostname === 'images-api.nasa.gov' && unavailable ? new Response('', { status: 503 }) : undefined));
  const first = await stock.search({ query: 'earth', provider: 'all' });
  assert.equal(first.videos.length, 4); assert.match(first.warning, /NASA.*Load more to retry/);
  assert.deepEqual(first.sourceCursors.nasa, { page: 1, cursor: 0, done: false });
  unavailable = false;
  const second = await stock.search({ query: 'earth', provider: 'all', page: 2, sourceCursors: first.sourceCursors });
  assert.equal(second.warning, undefined); assert.ok(second.videos.some(video => video.id === 'nasa:Earth_1'));
  assert.ok(second.videos.some(video => String(video.id).startsWith('archive:earth2:')));
  assert.equal(second.videos.some(video => first.videos.some(old => old.id === video.id)), false);
  assert.deepEqual(calls.filter(url => url.hostname === 'images-api.nasa.gov').map(url => url.searchParams.get('page')), ['1', '1']);
});
test('failed providers keep Load more available even when the other sources are exhausted', async () => {
  const stock = service(fixtures([], url => url.hostname === 'images-api.nasa.gov' ? new Response('', { status: 429 }) : undefined));
  const result = await stock.search({ query: 'earth', provider: 'all', sourceCursors: { commons: { page: 4, cursor: 80, done: true }, archive: { page: 2, cursor: 8, done: false } } });
  assert.ok(result.videos.length); assert.equal(result.hasMore, true); assert.equal(result.sourceCursors.archive.done, true); assert.equal(result.sourceCursors.nasa.page, 1);
});
test('all-provider failures and caller cancellation fail clearly, including cached pages', async () => {
  await assert.rejects(service(async () => new Response('', { status: 503 })).search({ query: 'earth', provider: 'all' }), /All footage sources.*unavailable/);
  const abort = new AbortController(), stock = service(fixtures());
  await stock.search({ query: 'earth', provider: 'all' }); abort.abort();
  await assert.rejects(stock.search({ query: 'earth', provider: 'all' }, abort.signal), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(service(fixtures([], () => { during.abort(); during.signal.throwIfAborted(); })).search({ query: 'earth', provider: 'all' }, during.signal), { name: 'AbortError' });
});
test('mixed search applies filters without inventing NASA dimensions and preserves empty-page continuation', async () => {
  const stock = service(fixtures());
  const quality = await stock.search({ query: 'earth', provider: 'all', size: 'medium' });
  assert.deepEqual([...new Set(quality.videos.map(video => video.provider))], ['commons', 'archive']);
  const empty = await stock.search({ query: 'earth', provider: 'all', orientation: 'portrait' });
  assert.equal(empty.videos.length, 0); assert.equal(empty.hasMore, true); assert.equal(empty.sourceCursors.nasa.page, 2);
});
test('malformed provider cursors are rejected before network access', async () => {
  let calls = 0; const stock = service(async () => { calls++; throw new Error('Unexpected request'); });
  for (const sourceCursors of [null, [], 'bad', { unknown: {} }, { commons: null }, { commons: { page: 0, cursor: 0, done: false } }, { nasa: { page: 1, cursor: -1, done: false } }, { archive: { page: 1, cursor: 0, done: 'false' } }]) {
    await assert.rejects(stock.search({ query: 'earth', provider: 'all', sourceCursors }), /Invalid source pagination/);
  }
  assert.equal(calls, 0);
});
test('clips from mixed results still download by registered provider ID with their own source records', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'smoothy-all-'));
  try {
    const stock = service(fixtures()), result = await stock.search({ query: 'earth', provider: 'all' });
    for (const provider of providers) {
      const video = result.videos.find(video => video.provider === provider);
      const saved = await stock.download(video.id, video.files[0].id, folder, new AbortController().signal, () => {});
      const source = JSON.parse(await readFile(saved + '.source.json', 'utf8'));
      assert.equal(source.provider, provider); assert.equal(source.license, video.license); assert.equal(source.source, video.url);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
