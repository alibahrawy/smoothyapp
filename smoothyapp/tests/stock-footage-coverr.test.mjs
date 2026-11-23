import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const output = await build({ stdin: { contents: "export * from './src/main/stock-footage'; export * from './src/main/stock-footage-coverr';", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, platform: 'node', format: 'esm', write: false });
const { StockFootageService, normalizeCoverrVideo } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const endpoint = 'https://stock.example/api/stock/pixabay';
const hit = { id: 'i1yZBtUcPT', title: 'Waves crashing', tags: 'ocean, water', duration: 10, fps: 24, pageURL: 'https://coverr.co/videos/waves-i1yzbtucpt', thumbnail: 'https://cdn.coverr.co/videos/coverr-waves/thumbnail?width=640',
  files: [{ label: '1080p MP4', url: 'https://cdn.coverr.co/videos/coverr-waves/1080p.mp4', width: 1920, height: 1080 }, { label: '360p MP4', url: 'https://cdn.coverr.co/videos/coverr-waves/360p.mp4', width: 640, height: 360 }] };
const data = () => Response.json({ total: 30, pages: 3, hits: [hit] });
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(60)]);
const service = request => new StockFootageService(request, (a, b) => copyFile(a, b));
const temporary = async action => { const folder = await mkdtemp(path.join(os.tmpdir(), 'smoothy-coverr-')); try { await action(folder); } finally { await rm(folder, { recursive: true, force: true }); } };

test('Coverr normalization carries the license, credit link and rejects unsafe media',()=>{
 const video=normalizeCoverrVideo(hit);assert.equal(video.id,'coverr:i1yZBtUcPT');assert.equal(video.provider,'coverr');assert.equal(video.license,'Coverr License');assert.equal(video.licenseUrl,'https://coverr.co/license');assert.match(video.usage,/Credit Coverr/);
 assert.equal(video.width,1920);assert.equal(video.files.length,2);assert.equal(video.files[0].fps,24);assert.equal(video.url,'https://coverr.co/videos/waves-i1yzbtucpt');
 for(const fields of [{id:'../x'},{pageURL:'https://attacker.example/'},{duration:0},{thumbnail:'https://attacker.example/t.jpg'},{files:[{...hit.files[0],url:'https://127.0.0.1/videos/x.mp4'}]},{files:[{...hit.files[0],url:'https://cdn.coverr.co/other/x.mp4'}]},{files:[{...hit.files[0],url:'https://a:b@cdn.coverr.co/videos/x.mp4'}]},{files:[]}]) assert.equal(normalizeCoverrVideo({...hit,...fields}),null,JSON.stringify(fields));
});
test('Coverr is unavailable without the stock service, then searches beside Pixabay with local filters and caching',async()=>{
 const calls=[];const stock=service(async(url)=>{calls.push(new URL(url));return data();});
 assert.equal(stock.coverrEnabled,false);await assert.rejects(stock.search({query:'ocean',provider:'coverr'}),/unavailable in this build/);assert.equal(calls.length,0);
 stock.configurePixabayService(endpoint);assert.equal(stock.coverrEnabled,true);
 const input={query:'ocean',provider:'coverr',size:'medium'};const result=await stock.search(input);
 assert.equal(result.videos.length,1);assert.equal(result.hasMore,true);assert.equal(result.nextOffset,12);
 assert.equal(calls[0].origin+calls[0].pathname,'https://stock.example/api/stock/coverr');assert.equal(calls[0].searchParams.get('q'),'ocean');assert.equal(calls[0].searchParams.get('page'),'1');assert.equal(calls[0].searchParams.get('key'),null);
 await stock.search(input);assert.equal(calls.length,1);
 assert.equal((await stock.search({...input,size:'large'})).videos.length,0);
 assert.equal((await stock.search({...input,orientation:'portrait'})).videos.length,0);
 await assert.rejects(stock.search({query:'x'.repeat(101),provider:'coverr'}),/100 characters/);
});
test('Coverr results join All sources and a failing source is reported without hiding the others',async()=>{
 const stock=service(async url=>{const target=new URL(url);if(target.pathname.endsWith('/coverr'))return data();return new Response('',{status:503});});
 stock.configurePixabayService(endpoint);const result=await stock.search({query:'ocean',provider:'all'});
 assert.ok(result.videos.some(video=>video.provider==='coverr'));assert.ok(result.sourceCursors.coverr&&result.sourceCursors.coverr.page===2);
});
test('Coverr downloads use the CDN allow-list, store the license, and report the download once saved',async()=>temporary(async folder=>{
 const reports=[];const stock=service(async(url,options)=>{const target=new URL(url);
  if(target.hostname==='stock.example'&&target.pathname.endsWith('/coverr-download')){reports.push({id:target.searchParams.get('id'),method:options.method,type:options.headers['Content-Type']});return new Response(null,{status:204});}
  if(target.hostname==='stock.example')return data();
  assert.equal(target.hostname,'cdn.coverr.co');return new Response(mp4,{headers:{'content-length':String(mp4.length)}});});
 stock.configurePixabayService(endpoint);const found=await stock.search({query:'ocean',provider:'coverr'});
 const file=await stock.download(found.videos[0].id,found.videos[0].files[0].id,folder,new AbortController().signal,()=>{});
 assert.match(path.basename(file),/^coverr-[0-9a-f]{16}-1920x1080\.mp4$/);
 const meta=JSON.parse(await readFile(file+'.source.json','utf8'));assert.equal(meta.provider,'coverr');assert.equal(meta.license,'Coverr License');assert.equal(meta.source,hit.pageURL);
 await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(reports,[{id:'i1yZBtUcPT',method:'POST',type:'application/json'}]);
 // Failed or aborted downloads are never reported, and a failing report never fails the saved clip.
 const failing=service(async(url)=>{const target=new URL(url);if(target.pathname.endsWith('/coverr-download'))throw new Error('offline');if(target.hostname==='stock.example')return data();return new Response(mp4,{headers:{'content-length':String(mp4.length)}});});
 failing.configurePixabayService(endpoint);const again=await failing.search({query:'waves',provider:'coverr'});
 assert.ok(await failing.download(again.videos[0].id,again.videos[0].files[0].id,folder,new AbortController().signal,()=>{}));
 const bad=service(async(url)=>{const target=new URL(url);if(target.pathname.endsWith('/coverr-download'))reports.push('unexpected');if(target.hostname==='stock.example')return data();return new Response('not a video',{headers:{'content-length':'11'}});});
 bad.configurePixabayService(endpoint);const broken=await bad.search({query:'tide',provider:'coverr'});
 await assert.rejects(bad.download(broken.videos[0].id,broken.videos[0].files[0].id,folder,new AbortController().signal,()=>{}),/not a video|incomplete/);assert.equal(reports.length,1);
}));
test('browse lists popular clips from Coverr and Pixabay only, never as a user search',async()=>{
 const calls=[];const stock=service(async url=>{const target=new URL(url);calls.push(target);if(target.pathname.endsWith('/coverr'))return data();return Response.json({totalHits:30,hits:[{id:12,type:'film',tags:'ocean',duration:10,user:'U',pageURL:'https://pixabay.com/videos/id-12/',videos:{tiny:{url:'https://cdn.pixabay.com/video/o.mp4',thumbnail:'https://cdn.pixabay.com/video/o.jpg',width:1280,height:720,size:10}}}]});});
 await assert.rejects(stock.search({query:'',provider:'all',browse:true}),/Enter a search/);
 stock.configurePixabayService(endpoint);
 await assert.rejects(stock.search({query:'',provider:'all'}),/Enter a search/);
 await assert.rejects(stock.search({query:'',provider:'nasa',browse:true}),/Enter a search/);
 const all=await stock.search({query:'',provider:'all',browse:true});
 assert.deepEqual(all.videos.map(video=>video.provider).sort(),['coverr','pixabay']);assert.equal(calls.length,2);
 for(const call of calls){assert.equal(call.searchParams.get('browse'),'1');assert.equal(call.searchParams.has('q'),false);}
 assert.deepEqual(Object.keys(all.sourceCursors).sort(),['coverr','pixabay']);
 const only=await stock.search({query:'',provider:'coverr',browse:true});assert.equal(only.videos.length,1);
 const more=await stock.search({query:'',provider:'all',browse:true,page:2,sourceCursors:all.sourceCursors});assert.equal(more.sourceCursors.coverr.page,3);
});
