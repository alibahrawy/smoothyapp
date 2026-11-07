import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const output = await build({ entryPoints: [new URL('../src/main/audio-archive.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { AudioArchive, normalizeArchive, enrichArchive, AUDIO_ARCHIVE_URL } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const id = '1KAk_m-PLFD8oT5EJ2JDBqx_Q0TqCeSEx';
const catalog = { all: [{ id, name: 'Sky_Skating.mp3', mimeType: 'audio/mpeg' }] };
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(512, 1)]);
const audio = (body = mp3, options = {}) => new Response(body, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(body.length) }, ...options });
async function fixture(work) { const dir = await mkdtemp(path.join(os.tmpdir(), 'smoothy-archive-')); try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test('catalog normalization keeps titles/known IDs, rejects unsafe entries, and never invents licenses', () => {
 const tracks = normalizeArchive({ ...catalog, all: [...catalog.all, catalog.all[0], { id: '../../etc/passwd', name: 'Bad.mp3', mimeType: 'audio/mpeg' }, { id: 'b'.repeat(33), name: 'bad.html', mimeType: 'audio/mpeg' }] });
 assert.deepEqual(tracks, [{ id, title: 'Sky Skating' }]);
 assert.throws(() => normalizeArchive({ all: [] }));
});
test('browsing uses matched archive genre/mood tags and never guesses from titles or changes licenses', () => {
 const tracks = enrichArchive([{ id, title: 'Sky Skating' }, { id, title: 'A different file' }, { id: 'unknown-id', title: 'Sky Skating' }, { id: 'unknown-jazz', title: 'Jazz Blues Piano' }]);
 assert.equal(tracks[0].genre, 'Dance & Electronic'); assert.equal(tracks[0].mood, 'Inspirational'); assert.equal(tracks[0].license, undefined);
 assert.equal(tracks[0].artist, 'Geographer'); assert.equal(tracks[0].duration, 216);
 for (const track of tracks.slice(1)) { assert.equal(track.genre, undefined); assert.equal(track.mood, undefined); }
});
test('favorites and staff views filter the entire catalog before pagination, and search includes known artists', async () => fixture(async dir => {
 const other = 'track'.padEnd(30, 'b');
 const service = new AudioArchive(dir, async () => Response.json({all:[...catalog.all,{id:other,name:'Another.mp3',mimeType:'audio/mpeg'}]}));
 const community = {favorites:[id],staffPicks:[other],counts:{[id]:12}};
 const favorites = await service.search({view:'favorites'},community);assert.equal(favorites.total,1);assert.equal(favorites.tracks[0].id,id);assert.equal(favorites.tracks[0].favoriteCount,12);assert.equal(favorites.tracks[0].favorite,true);
 const staff = await service.search({view:'staff'},community);assert.equal(staff.tracks[0].id,other);assert.equal(staff.tracks[0].staffPick,true);assert.equal(staff.tracks[0].favorite,false);
 const artist = await service.search({query:'Geographer'},community);assert.equal(artist.total,1);assert.equal(artist.tracks[0].id,id);
 await assert.rejects(service.search({view:'forged'}));
}));
test('genre browsing works without a query, combines mood/search, and keeps counts/pagination scoped correctly', async () => fixture(async dir => {
 const index = JSON.parse(await readFile(new URL('../src/main/data/audio-archive-tags.json', import.meta.url), 'utf8')).tracks;
 const movies = Object.entries(index).filter(([, entry]) => entry[1] === 'Cinematic').slice(0, 45);
 const all = [...movies.map(([id, entry]) => ({ id, name: entry[0] + '.mp3', mimeType: 'audio/mpeg' })), ...catalog.all, { id: 'unknown'.padEnd(25, 'a'), name: 'Unknown_Jazz.mp3', mimeType: 'audio/mpeg' }];
 const service = new AudioArchive(dir, async () => Response.json({ all }));
 const first = await service.search({ category: 'cinematic' }); assert.equal(first.total, 45); assert.equal(first.tracks.length, 40); assert.ok(first.tracks.every(track => track.genre === 'Cinematic')); assert.equal(first.hasMore, true);
 const next = await service.search({ category: 'cinematic', offset: 40 }); assert.equal(next.tracks.length, 5); assert.equal(next.hasMore, false); assert.ok(next.tracks.every(track => !first.tracks.some(item => item.id === track.id)));
 const electronic = await service.search({ category: 'electronic', mood: 'Inspirational', query: 'skating' }); assert.equal(electronic.total, 1); assert.equal(electronic.tracks[0].id, id); assert.equal(electronic.categories.find(item => item.id === 'cinematic').count, 45); assert.equal(electronic.moods.find(item => item.label === 'Inspirational').count, 1);
 assert.equal((await service.search({ category: 'electronic', mood: 'Sad' })).total, 0);
 const unknown = await service.search({ category: 'uncategorized' }); assert.equal(unknown.total, 1); assert.equal(unknown.tracks[0].title, 'Unknown Jazz');
 assert.equal(first.categories.reduce((total, item) => total + (item.id === 'all' ? 0 : item.count), 0), all.length);
 for (const input of [{ category: '../files' }, { category: ['cinematic'] }, { mood: 'unavailable' }]) await assert.rejects(service.search(input), /available audio type/);
}));
test('exact artist filtering searches the entire catalog before pagination and excludes title-only matches', async () => fixture(async dir => {
 const index = JSON.parse(await readFile(new URL('../src/main/data/audio-archive-tags.json', import.meta.url), 'utf8')).tracks;
 const entries = Object.entries(index).filter(([, entry]) => entry[3] === 'Kevin MacLeod').slice(0, 45);
 const all = [...entries.map(([id, entry]) => ({ id, name: entry[0] + '.mp3', mimeType: 'audio/mpeg' })), ...catalog.all,
   { id: 'titlematch'.padEnd(30, 'b'), name: 'Kevin_MacLeod.mp3', mimeType: 'audio/mpeg' }];
 const service = new AudioArchive(dir, async () => Response.json({ all }));
 const first = await service.search({ artist: ' kevin macleod ', shuffleSeed: 42 });
 const last = await service.search({ artist: 'Kevin MacLeod', shuffleSeed: 42, offset: 40 });
 assert.equal(first.total, 45); assert.equal(first.tracks.length, 40); assert.equal(last.tracks.length, 5);
 assert.ok([...first.tracks, ...last.tracks].every(track => track.artist === 'Kevin MacLeod'));
 assert.equal(new Set([...first.tracks, ...last.tracks].map(track => track.id)).size, 45);
 assert.equal((await service.search({ artist: 'Kevin' })).total, 0);
 for (const artist of [3, {}, 'x'.repeat(301)]) await assert.rejects(service.search({ artist }), /Choose an artist/);
}));
test('title search, bounded pagination, cache reuse and concurrent requests use one public catalog request', async () => fixture(async dir => {
 const all = Array.from({ length: 85 }, (_, i) => ({ id: 'track'.padEnd(25, 'a') + i, name: `Jazz_Rain_${String(i).padStart(2, '0')}.mp3`, mimeType: 'audio/mpeg' }));
 let count = 0; const service = new AudioArchive(dir, async (url, options) => { count++; assert.equal(url, AUDIO_ARCHIVE_URL); assert.equal(options.credentials, 'omit'); return Response.json({ all }); });
 const [first, repeat] = await Promise.all([service.search({ query: 'rain jazz' }), service.search({ query: 'Jazz' })]);
 assert.equal(first.total, 85); assert.equal(first.tracks.length, 40); assert.equal(first.hasMore, true); assert.match(first.tracks[0].previewUrl, /^smoothy-audio:\/\/archive\//); assert.equal(count, 1);
 assert.equal((await service.search({ query: 'jazz', offset: 80 })).tracks.length, 5);
 assert.equal((await service.search({ query: 'unknown' })).total, 0);
 const cached = new AudioArchive(dir, async () => { throw Error('offline'); }); assert.equal((await cached.search({})).total, 85);
 const data = JSON.parse(await readFile(path.join(dir, 'audio-archive.json'), 'utf8')); data.savedAt = 1; await writeFile(path.join(dir, 'audio-archive.json'), JSON.stringify(data));
 assert.equal((await new AudioArchive(dir, async () => { throw Error('offline'); }).search({})).cached, true);
 for (const input of [{ query: 3 }, { query: 'x'.repeat(201) }, { offset: -1 }, { offset: 1.5 }]) await assert.rejects(service.search(input));
}));
test('fresh shuffles cover the whole catalog and preserve pagination, filtering and cached ordering', async () => fixture(async dir => {
 const all = Array.from({length:120}, (_,i) => ({id:'shuffle'.padEnd(25,'a')+i,name:`Track_${String(i).padStart(3,'0')}.mp3`,mimeType:'audio/mpeg'}));
 const service = new AudioArchive(dir, async () => Response.json({all}));
 const pages = await Promise.all([0,40,80].map(offset => service.search({shuffleSeed:123,offset})));
 const ordered = pages.flatMap(page => page.tracks.map(track => track.id));
 assert.equal(ordered.length,120); assert.equal(new Set(ordered).size,120);
 assert.deepEqual([...ordered].sort(),all.map(track=>track.id).sort());
 assert.notDeepEqual(ordered,all.map(track=>track.id));
 assert.ok(pages[0].tracks.some(track=>Number(track.id.slice(25))>=80));
 const changed = await service.search({shuffleSeed:456}); assert.notDeepEqual(changed.tracks.map(track=>track.id),ordered.slice(0,40));
 const repeat = await service.search({shuffleSeed:123}); assert.deepEqual(repeat.tracks.map(track=>track.id),ordered.slice(0,40));
 const filtered = await service.search({shuffleSeed:123,query:'Track 01'});
 const matching = [1,10,11,12,13,14,15,16,17,18,19,101].map(i=>all[i].id);
 assert.deepEqual(filtered.tracks.map(track=>track.id),ordered.filter(trackId=>matching.includes(trackId)));
 const favorites = [ordered[90],ordered[5],ordered[65]];
 const starred = await service.search({shuffleSeed:123,view:'favorites'},{favorites,staffPicks:[],counts:{}});
 assert.deepEqual(starred.tracks.map(track=>track.id),ordered.filter(trackId=>favorites.includes(trackId)));
 const cached = new AudioArchive(dir,async()=>{throw Error('offline');});
 assert.deepEqual((await cached.search({shuffleSeed:123})).tracks.map(track=>track.id),ordered.slice(0,40));
 const defaultPage = await service.search({}); assert.deepEqual((await service.search({})).tracks,defaultPage.tracks);
 for (const shuffleSeed of [-1,1.5,4294967296,'123',NaN]) await assert.rejects(service.search({shuffleSeed}),/Invalid library shuffle/);
}));
test('unknown IDs cannot cause media requests, range requests omit credentials, and renderer URLs are ignored', async () => fixture(async dir => {
 const calls = []; const service = new AudioArchive(dir, async (url, options) => { calls.push({ url, options }); return url === AUDIO_ARCHIVE_URL ? Response.json(catalog) : audio(mp3.subarray(0, 64), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-63/515', 'content-length': '64', 'set-cookie': 'secret=x' } }); });
 await service.search({});
 for (const bad of ['../../etc/passwd', 'https://example.com/x.mp3', 'a'.repeat(33)]) await assert.rejects(service.preview(bad, new AbortController().signal));
 assert.equal(calls.length, 1);
 const response = await service.preview(id, new AbortController().signal, 'bytes=0-63'); assert.equal(response.status, 206); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('content-range'), 'bytes 0-63/515');
 assert.equal(calls[1].options.credentials, 'omit'); assert.deepEqual(calls[1].options.headers, { Range: 'bytes=0-63' }); assert.equal(new URL(calls[1].url).hostname, 'drive.usercontent.google.com');
 await assert.rejects(service.preview(id, new AbortController().signal, 'bytes=0-1,4-5'));
}));
test('downloads follow only trusted HTTPS redirects and save complete MP3 bytes', async () => fixture(async dir => {
 const service = new AudioArchive(dir, async url => url === AUDIO_ARCHIVE_URL ? Response.json(catalog) : url.includes('drive.usercontent') ? new Response(null, { status: 303, headers: { location: 'https://docs.google.com/uc?id=' + id } }) : audio());
 const destination = path.join(dir, 'track.mp3'); const progress = [];
 const track = await service.download(id, destination, new AbortController().signal, (...value) => progress.push(value));
 assert.equal(track.title, 'Sky Skating'); assert.deepEqual(await readFile(destination), mp3); assert.equal(progress.at(-1)[0], mp3.length);
}));
test('unsafe redirects, HTML, truncated/partial media and oversize declarations are rejected with cleanup', async () => fixture(async dir => {
 for (const response of [new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }), new Response('<html>Confirm download</html>', { headers: { 'content-type': 'text/html' } }), audio(mp3, { headers: { 'content-type': 'audio/mpeg', 'content-length': '999' } }), audio(mp3, { status: 206 }), audio(mp3, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(257 * 1024 * 1024) } }), audio(Buffer.alloc(300))]) {
  const service = new AudioArchive(dir, async url => url === AUDIO_ARCHIVE_URL ? Response.json(catalog) : response); const destination = path.join(dir, 'bad.mp3');
  await assert.rejects(service.download(id, destination, new AbortController().signal, () => {})); assert.equal((await readdir(dir)).includes('bad.mp3'), false);
 }
}));
test('canceling a streamed download removes the temporary MP3', async () => fixture(async dir => {
 const service = new AudioArchive(dir, async url => url === AUDIO_ARCHIVE_URL ? Response.json(catalog) : audio()); const controller = new AbortController();
 await assert.rejects(service.download(id, path.join(dir, 'cancel.mp3'), controller.signal, () => controller.abort()));
 assert.equal((await readdir(dir)).includes('cancel.mp3'), false);
}));
test('unavailable or malformed catalogs fail clearly and remain retryable', async () => fixture(async dir => {
 let calls = 0; const service = new AudioArchive(dir, async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json(catalog));
 await assert.rejects(service.search({}), /unavailable/); assert.equal((await service.search({})).total, 1);
 await rm(path.join(dir, 'audio-archive.json'));
 await assert.rejects(new AudioArchive(dir, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))).search({}), /too large/);
}));
