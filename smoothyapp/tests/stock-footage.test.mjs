import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const output = await build({ entryPoints: [new URL('../src/main/stock-footage.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { StockFootageService, normalizeStockVideo } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
export const raw = { pageid: 100, index: 1, title: 'File:Ocean.webm', videoinfo: [{ width: 1920, height: 1080, duration: 15,
 descriptionurl: 'https://commons.wikimedia.org/wiki/File:Ocean.webm', thumburl: 'https://thumb.wikimedia.org/ocean.jpg',
 extmetadata: { LicenseShortName: { value: 'CC0' }, AttributionRequired: { value: 'false' }, LicenseUrl: { value: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' }, Artist: { value: '<a>Creator &amp; friends</a>' }, ObjectName: { value: 'Ocean' } },
 derivatives: [{ src: 'https://upload.wikimedia.org/ocean.webm', type: 'video/webm; codecs="vp9, opus"', width: 1920, height: 1080 }, { src: 'https://upload.wikimedia.org/ocean.480p.webm', type: 'video/webm', width: 854, height: 480 }] }] };
const results = () => Response.json({ batchcomplete: true, query: { pages: [raw] } });
const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(80)]);
async function folder(action) { const dir = await mkdtemp(path.join(os.tmpdir(), 'smoothy-stock-')); try { await action(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
const serviceWith = (request, convert = async (a,b)=>copyFile(a,b)) => new StockFootageService(request, convert);

test('Commons search needs no key, uses video metadata, filters locally, and caches repeats', async () => {
 const calls=[]; const service=serviceWith(async (url,options)=>{calls.push({url,options});return results();});
 const input={query:'city & ocean',orientation:'landscape',size:'medium'};
 const result=await service.search(input); assert.equal(result.videos.length,1); assert.equal(result.videos[0].license,'CC0');
 const url=new URL(calls[0].url); assert.equal(url.hostname,'commons.wikimedia.org');assert.equal(url.searchParams.get('gsrsearch'),'city & ocean filetype:video'); assert.match(url.searchParams.get('viprop'),/derivatives/); assert.equal(calls[0].options.headers.Authorization,undefined);
 assert.deepEqual(await service.search(input),result);assert.equal(calls.length,1);
 assert.equal((await service.search({...input,orientation:'portrait'})).videos.length,0);
 assert.equal((await service.search({...input,size:'large'})).videos.length,0);
});
test('license filtering rejects attribution, missing/ambiguous licenses and restrictions',()=>{
 const modify=fields=>({...raw,videoinfo:[{...raw.videoinfo[0],extmetadata:{...raw.videoinfo[0].extmetadata,...fields}}]});
 for(const fields of [{LicenseShortName:{value:'CC BY 4.0'}},{LicenseShortName:{value:'CC BY-SA 3.0'}},{LicenseShortName:{value:'CC0; CC BY'}},{AttributionRequired:{value:'true'}},{AttributionRequired:undefined},{Restrictions:{value:'Personality rights'}},{LicenseUrl:{value:'https://attacker.example/license'}}])assert.equal(normalizeStockVideo(modify(fields)),null);
 assert.equal(normalizeStockVideo(modify({LicenseShortName:{value:'Public domain'},LicenseUrl:undefined})).license,'Public domain');
 assert.equal(normalizeStockVideo(raw).creator,'Creator & friends');
});
test('filtered batches preserve the Commons continuation offset, including empty eligible batches',async()=>{
 const offsets=[];const restricted={...raw,videoinfo:[{...raw.videoinfo[0],extmetadata:{LicenseShortName:{value:'CC BY'}}}]};
 const service=serviceWith(async url=>{const offset=Number(new URL(url).searchParams.get('gsroffset'));offsets.push(offset);return Response.json({batchcomplete:true,query:{pages:offset===120?[raw]:[restricted]},continue:{gsroffset:offset+40}});});
 const first=await service.search({query:'ocean'});assert.equal(first.videos.length,0);assert.equal(first.nextOffset,120);assert.equal(first.hasMore,true);
 const next=await service.search({query:'ocean',page:2,cursor:first.nextOffset});assert.equal(next.videos.length,1);assert.deepEqual(offsets,[0,40,80,120,160,200]);
});
test('invalid inputs and API errors fail clearly',async()=>{
 let calls=0;const service=serviceWith(async()=>{calls++;return results();});
 for(const input of [null,{query:''},{query:'x'.repeat(201)},{query:'a',page:0},{query:'a',cursor:-1},{query:'a',orientation:'diagonal'},{query:'a',size:'unlimited'}])await assert.rejects(service.search(input));assert.equal(calls,0);
 for(const [response,pattern] of [[new Response('',{status:429}),/limit/],[new Response('',{status:500}),/unavailable/],[Response.json({error:{code:'bad'}}),/invalid search/]])await assert.rejects(serviceWith(async()=>response).search({query:'a'}),pattern);
 assert.equal((await serviceWith(async()=>Response.json({batchcomplete:true})).search({query:'none'})).videos.length,0);
});
test('normalization rejects unsafe hosts, credentials, ports and nonvideo derivatives',()=>{
 const modify=fields=>({...raw,videoinfo:[{...raw.videoinfo[0],...fields}]});
 assert.equal(normalizeStockVideo(modify({descriptionurl:'https://attacker.example/'})),null);
 assert.equal(normalizeStockVideo(modify({thumburl:'http://thumb.wikimedia.org/x'})),null);
 for(const src of ['http://upload.wikimedia.org/x','https://127.0.0.1/x','https://upload.wikimedia.org.attacker.example/x','https://a:b@upload.wikimedia.org/x','https://upload.wikimedia.org:3000/x'])assert.equal(normalizeStockVideo(modify({derivatives:[{...raw.videoinfo[0].derivatives[0],src}]})),null);
 assert.equal(normalizeStockVideo(modify({derivatives:[{...raw.videoinfo[0].derivatives[0],type:'text/html'}]})),null);
});
test('downloads validate media, convert to persistent MP4, keep source credits, and avoid overwrites',async()=>folder(async dir=>{
 const calls=[];let converted=0;const progress=[];
 const service=serviceWith(async(url,options)=>{calls.push({url,options});return url.includes('/w/api.php')?results():new Response(webm,{headers:{'content-length':String(webm.length)}});},async(a,b)=>{converted++;await copyFile(a,b);});
 await service.search({query:'ocean'});const first=await service.download(100,1,dir,new AbortController().signal,(...p)=>progress.push(p));const second=await service.download(100,1,dir,new AbortController().signal,()=>{});
 assert.notEqual(first,second);assert.match(first,/commons-100-1920x1080\.mp4$/);assert.equal(converted,2);assert.deepEqual(await readFile(first),webm);assert.equal(JSON.parse(await readFile(first+'.source.json','utf8')).license,'CC0');assert.equal(calls[1].options.headers,undefined);assert.equal(progress.at(-1)[2],'converting');assert.equal((await readdir(dir)).some(file=>file.endsWith('.part')),false);
 await assert.rejects(service.download(100,999,dir,new AbortController().signal,()=>{}),/select a video/);
}));
test('cancellation and conversion failure remove all temporary files',async()=>folder(async dir=>{
 const service=serviceWith(async url=>url.includes('/w/api.php')?results():new Response(webm));await service.search({query:'ocean'});const abort=new AbortController();await assert.rejects(service.download(100,1,dir,abort.signal,()=>abort.abort()));assert.deepEqual(await readdir(dir),[]);
 const broken=serviceWith(async url=>url.includes('/w/api.php')?results():new Response(webm),async(a,b)=>{await copyFile(a,b);throw Error('conversion failed');});await broken.search({query:'ocean'});await assert.rejects(broken.download(100,1,dir,new AbortController().signal,()=>{}),/conversion failed/);assert.deepEqual(await readdir(dir),[]);
}));
test('unsafe redirects, truncation and invalid video bodies never survive',async()=>folder(async dir=>{
 for(const response of [new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),new Response(webm,{headers:{'content-length':'500'}}),new Response('<html>Error</html>')]){const calls=[];const service=serviceWith(async url=>{calls.push(url);return url.includes('/w/api.php')?results():response;});await service.search({query:'ocean'});await assert.rejects(service.download(100,1,dir,new AbortController().signal,()=>{}));assert.equal(calls.length,2);assert.deepEqual(await readdir(dir),[]);}
}));
test('Premiere video and audio imports require a project but no active sequence or timeline edits',async()=>{
 const source=await readFile(new URL('../../smoothyapp-cep/jsx/host.jsx',import.meta.url),'utf8');const calls=[];const context={app:{project:{rootItem:{},activeSequence:null,importFiles:(...args)=>{calls.push(args);return true;}}},File:function(){this.exists=true;},JSON};vm.createContext(context);vm.runInContext(source,context);
 for(const [method,file] of [['importStockFootageToProject','video.mp4'],['importAudioLibraryToProject','track.mp3']]){assert.equal(JSON.parse(context[method](file)).success,true);assert.equal(JSON.parse(context[method]('bad.txt')).success,false);}
 assert.equal(calls.length,2);assert.equal(calls[0][1],true);assert.equal(calls[0][3],false);
 context.app.project=null;assert.match(JSON.parse(context.importAudioLibraryToProject('track.mp3')).error,/project/);
});
