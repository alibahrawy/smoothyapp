import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const bundle = await build({entryPoints:[new URL('../src/main/audio-favorites.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const { AudioFavorites } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const id='1KAk_m-PLFD8oT5EJ2JDBqx_Q0TqCeSEx', second='track'.padEnd(30,'b'), local='local:00000000-0000-4000-8000-000000000000';
const store = () => {const values=new Map();return {get:k=>structuredClone(values.get(k)),set:(k,v)=>values.set(k,structuredClone(v))};};
const response=()=>Response.json({counts:{[id]:2},staffPicks:[id]});
test('stars survive offline restarts and retry with the same anonymous install, without files or metadata',async()=>{
 const s=store();const offline=new AudioFavorites(s,()=>{},async()=>{throw Error('offline')},'https://fixture',true,()=>1000);
 offline.set(id,true);await offline.sync();assert.deepEqual(offline.snapshot().favorites,[id]);assert.equal(offline.snapshot().pending,1);
 const install=s.get('installId'), calls=[];
 const online=new AudioFavorites(s,()=>{},async(url,options)=>{calls.push({url,options});return options.method==='POST'?Response.json({ok:true}):response();},'https://fixture',true);
 await online.sync();assert.equal(online.snapshot().pending,0);assert.deepEqual(online.snapshot().staffPicks,[id]);
 const sent=JSON.parse(calls[0].options.body);assert.equal(sent.installId,install);assert.deepEqual(sent.favorites,[{trackId:id,active:true,updatedAt:1000}]);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
 online.set(id,false);await online.sync();assert.deepEqual(online.snapshot().favorites,[]);assert.equal(JSON.parse(calls.filter(c=>c.options.method==='POST').at(-1).options.body).favorites[0].active,false);
});
test('rapid star/unstar while a request is in flight retains the latest state and monotonic revision',async()=>{
 const s=store(),posts=[];let release;const gate=new Promise(r=>release=r);
 const service=new AudioFavorites(s,()=>{},async(url,options)=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));if(posts.length===1)await gate;return Response.json({ok:true});}return response();},'https://fixture',true,()=>100);
 service.set(id,true);service.set(id,false);release();await service.sync();
 assert.equal(posts.length,2);assert.equal(posts[0].favorites[0].updatedAt,100);assert.equal(posts[1].favorites[0].updatedAt,101);assert.equal(posts[1].favorites[0].active,false);assert.equal(service.snapshot().pending,0);
});
test('telemetry opt-out keeps favorites local and never sends a vote; local MP3 IDs are never shared',async()=>{
 const s=store();let requests=0;const privateFavorites=new AudioFavorites(s,()=>{},async()=>{requests++;return response();},'https://fixture',false);
 privateFavorites.set(id,true);privateFavorites.set(local,true);await privateFavorites.sync();assert.equal(requests,0);assert.equal(privateFavorites.snapshot().sharing,false);
 const posted=[];const enabled=new AudioFavorites(s,()=>{},async(url,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return Response.json({ok:true});}return response();},'https://fixture',true);await enabled.sync();assert.equal(posted[0].favorites.length,1);assert.equal(posted[0].favorites[0].trackId,id);
});
test('sync batches retained updates and rejects malformed local data without losing valid stars',async()=>{
 const s=store();s.set('audioCommunityCache',{invalid:true});s.set('audioFavorites',{[id]:{active:true,updatedAt:1},bad:{active:true,updatedAt:1}});
 const service=new AudioFavorites(s,()=>{},async()=>response(),'https://fixture',false);assert.deepEqual(service.snapshot().favorites,[id]);
 assert.throws(()=>service.set('../../etc/passwd',true));assert.throws(()=>service.set(id,'true'));
 service.set(second,true);assert.equal(service.snapshot().favorites.length,2);
});
test('the sharing switch persists, keeps local stars working and resumes only the latest archive states',async()=>{
 const s=store(),posts=[];
 const request=async(url,options)=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return Response.json({ok:true});}return response();};
 const service=new AudioFavorites(s,()=>{},request,'https://fixture',true,()=>1000);
 assert.equal(service.setSharing(false).sharing,false);service.set(id,true);service.set(id,false);service.set(second,true);service.set(local,true);
 await service.sync();assert.equal(posts.length,0);assert.equal(s.get('audioFavoriteSharing'),false);
 const restarted=new AudioFavorites(s,()=>{},request,'https://fixture',true);
 assert.equal(restarted.snapshot().sharing,false);assert.deepEqual(restarted.snapshot().favorites,[second,local]);
 restarted.setSharing(true);await restarted.sync();assert.equal(posts.length,1);assert.equal(restarted.snapshot().pending,0);
 assert.deepEqual(posts[0].favorites.map(item=>[item.trackId,item.active]),[[id,false],[second,true]]);
 assert.equal(posts[0].installId,s.get('installId'));assert.equal(new AudioFavorites(s,()=>{},request,'https://fixture',true).snapshot().sharing,true);
});
test('turning sharing off aborts an in-flight vote and a quick re-enable retries the latest state',async()=>{
 const s=store(),posts=[];let aborted=false;
 const service=new AudioFavorites(s,()=>{},async(url,options)=>{
  if(options.method!=='POST')return response();posts.push(JSON.parse(options.body));
  if(posts.length===1)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
  return Response.json({ok:true});
 },'https://fixture',true,()=>100);
 service.set(id,true);service.set(second,true);service.setSharing(false);assert.equal(aborted,true);
 service.set(id,false);service.setSharing(true);await service.sync();
 for(let i=0;i<10&&service.snapshot().pending;i++)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(posts.length,2);assert.equal(service.snapshot().pending,0);
 assert.deepEqual(posts[1].favorites.map(item=>[item.trackId,item.active]),[[id,false],[second,true]]);
});
test('the installation telemetry opt-out cannot be overridden by the sharing switch',()=>{
 const s=store();s.set('audioFavoriteSharing',true);
 const service=new AudioFavorites(s,()=>{},async()=>{throw Error('Unexpected request');},'https://fixture',false);
 assert.equal(service.snapshot().sharingLocked,true);assert.equal(service.snapshot().sharing,false);
 assert.throws(()=>service.setSharing(true),/disabled for this installation/);
 for(const invalid of ['true',1,null,{}])assert.throws(()=>service.setSharing(invalid),/Choose whether/);
 assert.equal(service.setSharing(false).sharing,false);
});
