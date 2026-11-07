import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = await build({ stdin: { contents: "export * from './src/main/stock-footage'; export * from './src/main/stock-footage-pixabay';", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'esm', write: false });
const { StockFootageService, normalizePixabayVideo } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const endpoint = 'https://stock.example/api/stock/pixabay';
const hit = { id: 12, type: 'film', tags: 'ocean, <b>waves</b>', duration: 10, user: 'Creator', pageURL: 'https://pixabay.com/videos/id-12/', videos: {
  large: { url: 'https://cdn.pixabay.com/video/2026/ocean.mp4', thumbnail: 'https://cdn.pixabay.com/video/2026/ocean.jpg', width: 3840, height: 2160, size: 1000 },
  tiny: { url: 'https://cdn.pixabay.com/video/2026/ocean-tiny.mp4', thumbnail: 'https://cdn.pixabay.com/video/2026/ocean-tiny.jpg', width: 640, height: 360, size: 100 }
} };
const data = () => Response.json({ totalHits: 30, hits: [hit] });
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(60)]);
const service = request => new StockFootageService(request, (a,b)=>copyFile(a,b));
const temporary = async action => { const folder=await mkdtemp(path.join(os.tmpdir(),'smoothy-pixabay-'));try{await action(folder);}finally{await rm(folder,{recursive:true,force:true});} };

test('Pixabay normalization retains provider/license terms and rejects unsafe media/metadata',()=>{
 const video=normalizePixabayVideo(hit);assert.equal(video.id,'pixabay:12');assert.equal(video.title,'ocean, waves');assert.equal(video.license,'Pixabay Content License');assert.equal(video.files.length,2);assert.equal(video.width,3840);assert.match(video.usage,/standalone/);
 for(const fields of [{id:-1},{type:'photo'},{pageURL:'https://attacker.example/'},{duration:0},{videos:{tiny:{...hit.videos.tiny,url:'https://127.0.0.1/video/x.mp4'}}},{videos:{tiny:{...hit.videos.tiny,url:'https://a:b@cdn.pixabay.com/video/x.mp4'}}},{videos:{tiny:{...hit.videos.tiny,size:2**31}}},{videos:{tiny:{...hit.videos.tiny,thumbnail:'http://cdn.pixabay.com/video/x.jpg'}}}]) assert.equal(normalizePixabayVideo({...hit,...fields}),null);
});
test('Pixabay uses a service endpoint without a provider key, source pages and local filters',async()=>{
 const calls=[];const stock=service(async(url,options)=>{calls.push({url:new URL(url),options});return data();});
 await assert.rejects(stock.search({query:'ocean',provider:'pixabay'}),/unavailable in this build/);assert.equal(calls.length,0);
 stock.configurePixabayService(endpoint);const input={query:'ocean & waves',provider:'pixabay',size:'large'};const result=await stock.search(input);
 assert.equal(result.videos.length,1);assert.equal(result.hasMore,true);assert.equal(result.nextOffset,12);
 assert.equal(calls[0].url.origin+calls[0].url.pathname,endpoint);assert.equal(calls[0].url.searchParams.get('key'),null);assert.equal(calls[0].url.searchParams.get('q'),input.query);assert.equal(calls[0].url.searchParams.get('size'),'large');assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Authorization,undefined);
 assert.equal(JSON.stringify(result).includes('fixture-secret'),false);await stock.search(input);assert.equal(calls.length,1);
 assert.equal((await stock.search({...input,orientation:'portrait'})).videos.length,0);
 await stock.search({...input,page:2});assert.equal(calls.at(-1).url.searchParams.get('page'),'2');
 await assert.rejects(stock.search({query:'x'.repeat(101),provider:'pixabay'}),/100 characters/);
});
test('Pixabay service responses cache for 24 hours across restarts without provider credentials',async()=>temporary(async folder=>{
 let calls=0;const request=async()=>{calls++;return data();};
 const first=service(request);first.configurePixabayService(endpoint,folder);await first.search({query:'ocean',provider:'pixabay'});
 const second=service(request);second.configurePixabayService(endpoint,folder);const result=await second.search({query:'ocean',provider:'pixabay'});assert.equal(result.videos.length,1);assert.equal(calls,1);
 const files=await readdir(folder);assert.equal(files.length,1);assert.equal(files[0].includes(endpoint),false);
 const cached=await readFile(path.join(folder,files[0]),'utf8');assert.equal(cached.includes(endpoint),false);const expires=JSON.parse(cached).expires;assert.ok(expires>Date.now()+23*3600000);
 second.configurePixabayService(endpoint+'-alternate',folder);await second.search({query:'ocean',provider:'pixabay'});assert.equal(calls,2);
}));
test('Pixabay errors redact keys and provider bodies while respecting cancellation',async()=>{
 for(const request of [async()=>new Response('provider-secret',{status:400}),async()=>new Response('provider-secret',{status:429}),async()=>{throw new TypeError('Failed to fetch service URL');},async()=>Response.json({invalid:true})]){
  const stock=service(request);stock.configurePixabayService(endpoint);await assert.rejects(stock.search({query:'ocean',provider:'pixabay'}),error=>!error.message.includes('provider-secret')&&/(Pixabay|stock footage)/i.test(error.message));
 }
 const abort=new AbortController();abort.abort();const stock=service(async()=>data());stock.configurePixabayService(endpoint);await assert.rejects(stock.search({query:'ocean',provider:'pixabay'},abort.signal),{name:'AbortError'});
});
test('All sources includes Pixabay only in service-enabled builds and preserves its independent cursor',async()=>{
 let pixabayCalls=0;
 const stock=service(async url=>{const parsed=new URL(url);if(parsed.hostname==='stock.example'){pixabayCalls++;return data();}if(parsed.hostname==='commons.wikimedia.org')return Response.json({batchcomplete:true});if(parsed.hostname==='archive.org')return Response.json({response:{numFound:0,docs:[]}});return Response.json({collection:{metadata:{total_hits:0},items:[]}});});
 const initial=await stock.search({query:'ocean',provider:'all'});assert.equal(pixabayCalls,0);assert.equal(initial.sourceCursors.pixabay,undefined);
 stock.configurePixabayService(endpoint);const first=await stock.search({query:'ocean',provider:'all'});assert.deepEqual(first.videos.map(video=>video.provider),['pixabay']);assert.equal(first.sourceCursors.pixabay.page,2);
 const next=await stock.search({query:'ocean',provider:'all',page:2,sourceCursors:first.sourceCursors});assert.equal(pixabayCalls,2);assert.equal(next.sourceCursors.pixabay.page,3);
 stock.configurePixabayService('');const removed=await stock.search({query:'ocean',provider:'all'});assert.equal(removed.sourceCursors.pixabay,undefined);assert.equal(removed.hasMore,false);
});
test('Pixabay downloads persist license records and reject cross-provider redirects',async()=>temporary(async folder=>{
 const stock=service(async url=>new URL(url).hostname==='stock.example'?data():new Response(mp4));stock.configurePixabayService(endpoint);
 const video=(await stock.search({query:'ocean',provider:'pixabay'})).videos[0];const saved=await stock.download(video.id,video.files[0].id,folder,new AbortController().signal,()=>{});
 assert.deepEqual(await readFile(saved),mp4);assert.equal(JSON.parse(await readFile(saved+'.source.json','utf8')).license,'Pixabay Content License');
 const bad=service(async url=>new URL(url).hostname==='stock.example'?data():new Response(null,{status:302,headers:{location:'https://upload.wikimedia.org/video.webm'}}));bad.configurePixabayService(endpoint);await bad.search({query:'ocean',provider:'pixabay'});await assert.rejects(bad.download(video.id,video.files[0].id,folder,new AbortController().signal,()=>{}),/unsupported video URL/);
}));
