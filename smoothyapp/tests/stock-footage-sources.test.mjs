import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = await build({ stdin: { contents: "export * from './src/main/stock-footage'; export * from './src/main/stock-footage-sources';", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'esm', write: false });
const { StockFootageService, normalizeArchiveVideos, normalizeNasaVideo, archiveMediaUrl } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const archive = { metadata: { identifier: 'ocean', mediatype: 'movies', collection: ['stock_footage'], title: 'Ocean <b>shot</b>', creator: 'Director', licenseurl: 'http://creativecommons.org/publicdomain/zero/1.0/' },
  files: [{ name: 'ocean.mp4', source: 'original', width: '1920', height: '1080', length: '30.5', size: '64' }, { name: 'ocean-small.mp4', original: 'ocean.mp4', width: '640', height: '360', length: '30.5' }, { name: 'waves.mp4', width: '1280', height: '720', length: '12' }] };
const nasaItem = { data: [{ nasa_id: 'Earth_01', media_type: 'video', title: 'Earth', center: 'GSFC', description: 'Earth orbit footage' }], links: [{ rel: 'preview', href: 'https://images-assets.nasa.gov/video/Earth_01/thumb.jpg' }] };
const nasaFiles = ['http://images-assets.nasa.gov/video/Earth_01/Earth_01~medium.mp4', 'https://images-assets.nasa.gov/video/Earth_01/Earth_01~small.mp4'];
const nasaMeta = { 'QuickTime:ImageWidth': 1920, 'QuickTime:ImageHeight': 1080, 'QuickTime:Duration': '0:01:30', 'File:MIMEType': 'video/quicktime' };
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(60)]);
const fixture = (calls = [], download = async () => new Response(mp4)) => async (value, options) => {
  const url = new URL(value); calls.push({url,options});
  if (url.pathname === '/advancedsearch.php') return Response.json({ response: { numFound: 20, docs: [{ identifier: 'ocean' }] } });
  if (url.pathname === '/metadata/ocean') return Response.json(archive);
  if (url.hostname === 'images-api.nasa.gov') return Response.json({ collection: { metadata: { total_hits: 10 }, items: [nasaItem] } });
  if (url.pathname.endsWith('/collection.json')) return Response.json(nasaFiles);
  if (url.pathname.endsWith('/metadata.json')) return Response.json(nasaMeta);
  return download(url, options);
};
const service = (request = fixture()) => new StockFootageService(request, (source,destination)=>copyFile(source,destination));

test('Archive groups MP4 variants by original and preserves explicit item licenses', () => {
  const videos = normalizeArchiveVideos(archive); assert.equal(videos.length, 2); assert.equal(videos[0].files.length, 2);
  assert.equal(videos[0].width, 1920); assert.equal(videos[0].duration, 30.5); assert.equal(videos[0].license, 'CC0'); assert.equal(videos[0].provider, 'archive');
  assert.notEqual(videos[0].id, videos[1].id); assert.equal(videos[0].title, 'Ocean shot · ocean.mp4');
  const historical = normalizeArchiveVideos({...archive, metadata: {...archive.metadata, collection: 'prelinger', licenseurl: 'http://creativecommons.org/licenses/publicdomain/'}});
  assert.equal(historical[0].license, 'Public domain');
});
test('Archive excludes other collections, attribution licenses, restricted items and unsafe filenames', () => {
  for (const metadata of [{collection: 'opensource_movies'}, {licenseurl: 'https://creativecommons.org/licenses/by/4.0/'}, {licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/?other=by'}, {licenseurl: [archive.metadata.licenseurl,'https://creativecommons.org/licenses/by/4.0/']}, {nodownload: true}, {identifier: '../private'}]) {
    assert.deepEqual(normalizeArchiveVideos({...archive, metadata: {...archive.metadata,...metadata}}), []);
  }
  assert.deepEqual(normalizeArchiveVideos({...archive,is_dark: true}), []);
  for (const name of ['../private.mp4','a/../private.mp4','bad\\file.mp4','video.txt']) assert.deepEqual(normalizeArchiveVideos({...archive,files:[{name}]}), []);
});
test('NASA keeps usage conditions and variant labels without inventing resolutions', () => {
  const video = normalizeNasaVideo(nasaItem, nasaFiles, nasaMeta); assert.equal(video.id, 'nasa:Earth_01'); assert.equal(video.duration, 90);
  assert.equal(video.files[0].width, 0); assert.equal(video.files[0].label, 'Medium MP4'); assert.match(video.usage, /Acknowledge NASA/);
  assert.equal(video.files[0].link.startsWith('https:'),true); assert.equal(video.license, 'NASA media guidelines');
  const spaced = 'Seeing Earth as Only NASA Can';
  assert.equal(normalizeNasaVideo({...nasaItem,data:[{...nasaItem.data[0],nasa_id:spaced}]},[`https://images-assets.nasa.gov/video/${encodeURIComponent(spaced)}/${encodeURIComponent(spaced)}~medium.mp4`],nasaMeta).id,'nasa:'+spaced);
  assert.equal(normalizeNasaVideo({...nasaItem,data:[{...nasaItem.data[0],description:'Copyright Getty Images'}]},nasaFiles,nasaMeta),null);
  assert.equal(normalizeNasaVideo(nasaItem,nasaFiles,{...nasaMeta,'XMP-dc:Rights':'© Third party'}),null);
  for (const url of ['https://attacker.example/file~medium.mp4','https://images-assets.nasa.gov/video/Other/Other~medium.mp4','https://a:b@images-assets.nasa.gov/video/Earth_01/Earth_01~medium.mp4']) assert.equal(normalizeNasaVideo(nasaItem,[url],nasaMeta),null);
});
test('source searches are keyless, cached separately, paginated and filter only verified dimensions', async () => {
  const calls=[]; const stock=service(fixture(calls)); const input={query:'ocean',provider:'archive'};
  const result=await stock.search(input); assert.equal(result.videos.length,2); assert.equal(result.hasMore,true); assert.equal(result.nextOffset,8);
  assert.deepEqual(await stock.search(input),result); assert.equal(calls.length,2);
  assert.match(calls[0].url.searchParams.get('q'),/collection:stock_footage OR collection:prelinger/);
  assert.equal((await stock.search({...input,orientation:'portrait'})).videos.length,0);
  assert.equal((await stock.search({...input,size:'medium'})).videos.length,1);
  const nasa=await stock.search({query:'ocean',provider:'nasa',orientation:'landscape'});assert.equal(nasa.videos.length,1);assert.equal(nasa.hasMore,true);
  assert.equal((await stock.search({query:'ocean',provider:'nasa',size:'medium'})).videos.length,0);
  await stock.search({...input,page:2,cursor:8}); assert.equal(calls.at(-2).url.searchParams.get('page'),'2');
  assert.equal(calls.every(call=>!call.options.headers.Authorization),true);
  await assert.rejects(stock.search({...input,provider:'unknown'}),/Invalid footage source/);
});
test('both providers use registered IDs for persistent MP4 downloads and save their usage terms', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'smoothy-sources-'));
  try {
    const stock=service();
    for (const provider of ['archive','nasa']) {
      const result=await stock.search({query:'ocean',provider});const video=result.videos[0];
      const file=await stock.download(video.id,video.files[0].id,dir,new AbortController().signal,()=>{});
      assert.equal(file.startsWith(path.join(dir,provider+'-')),true);assert.deepEqual(await readFile(file),mp4);
      const source=JSON.parse(await readFile(file+'.source.json','utf8'));assert.equal(source.provider,provider);assert.equal(source.usage,video.usage);
    }
    await assert.rejects(stock.download('archive:attacker:file',1,dir,new AbortController().signal,()=>{}),/select a video/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('Archive storage redirects are allowed while cross-provider and unsafe redirects are rejected', async () => {
  assert.equal(Boolean(archiveMediaUrl('https://ia800123.us.archive.org/30/items/ocean/ocean.mp4')),true);
  assert.equal(Boolean(archiveMediaUrl('https://dn600205.us.archive.org/0/items/ocean/ocean.mp4')),true);
  for(const url of ['http://ia800123.us.archive.org/a','https://ia1.us.archive.org.attacker.example/a','https://a:b@archive.org/a','https://archive.org:8888/a','https://127.0.0.1/a'])assert.equal(archiveMediaUrl(url),'');
  const dir=await mkdtemp(path.join(os.tmpdir(),'smoothy-sources-'));
  try {
    let downloads=0;const stock=service(fixture([],async url=>{downloads++;return url.hostname==='archive.org'?new Response(null,{status:302,headers:{location:'https://ia800123.us.archive.org/30/items/ocean/ocean.mp4'}}):new Response(mp4);}));
    const video=(await stock.search({query:'ocean',provider:'archive'})).videos[0];await stock.download(video.id,1,dir,new AbortController().signal,()=>{});assert.equal(downloads,2);
    for(const provider of ['archive','nasa']){
      const broken=service(fixture([],async()=>new Response(null,{status:302,headers:{location:'https://upload.wikimedia.org/other.mp4'}})));
      const item=(await broken.search({query:'ocean',provider})).videos[0];await assert.rejects(broken.download(item.id,item.files[0].id,dir,new AbortController().signal,()=>{}),/unsupported video URL/);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('provider failures and canceled metadata requests do not masquerade as empty search results', async () => {
  for(const provider of ['archive','nasa']){
    for(const response of [new Response('',{status:429}),new Response('',{status:503}),Response.json({invalid:true})])await assert.rejects(service(async()=>response).search({query:'ocean',provider}));
    const stock=service(async(url,opts)=>url.includes('/metadata/')||url.endsWith('/metadata.json')||url.endsWith('/collection.json')?new Response('',{status:503}):fixture()(url,opts));
    await assert.rejects(stock.search({query:'ocean',provider}),/could not load the video details/);
    const abort=new AbortController();abort.abort();await assert.rejects(service().search({query:'ocean',provider},abort.signal));
  }
});
