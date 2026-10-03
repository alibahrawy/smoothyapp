import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const f={handlers:new Map(),protocol:null,folder:'',choice:{canceled:true},events:[],quit:null,opened:[],imports:[],connected:true};globalThis.__audioIpcFixture=f;
const output=await build({entryPoints:[new URL('../src/main/audio-library-ipc.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'audio-fixture',setup(b){
 b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`const f=globalThis.__audioIpcFixture;export const app={getPath:()=>f.folder,on:(name,fn)=>{f.quit=fn}};export const ipcMain={handle:(name,fn)=>f.handlers.set(name,fn)};export const dialog={showOpenDialog:async()=>f.choice};export const shell={openExternal:async url=>f.opened.push(url),openPath:async()=>''};export const protocol={registerSchemesAsPrivileged(){},handle:(name,fn)=>{f.protocol=fn}};export const net={fetch:async url=>new Response(url)};`}));
 b.onLoad({filter:/audio-library\.ts$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('private validate = validateMP3','private validate = async () => {}'),loader:'ts'}));
}}]});
const {registerAudioLibrary}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
async function fixture(action,archive){f.folder=await mkdtemp(path.join(os.tmpdir(),'smoothy-audio-ipc-'));f.handlers.clear();f.choice={canceled:true};f.events=[];f.opened=[];f.imports=[];f.connected=true;f.importError=null;const values=new Map();await registerAudioLibrary({archive,store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v)},window:()=>({webContents:{send:(type,data)=>f.events.push({type,data})}}),connected:()=>f.connected,importToPremiere:async file=>{f.imports.push(file);return f.importError?{success:false,error:f.importError}:{success:true};}});const invoke=(name,input)=>f.handlers.get('audio-library-'+name)(null,input);try{await action(invoke);}finally{f.quit?.();await rm(f.folder,{recursive:true,force:true});}}
test('audio search opens the official Studio page and starts/stops an explicit download session',async()=>fixture(async invoke=>{
 const state=await invoke('state');assert.equal(state.watching,false);assert.deepEqual(state.tracks,[]);assert.equal((await invoke('open')).watching,true);assert.deepEqual(f.opened,['https://studio.youtube.com/channel/UC/music']);await invoke('stop');assert.equal((await invoke('state')).watching,false);
}));
test('the sharing IPC returns persisted local mode and rejects non-boolean choices',async()=>fixture(async()=>{
 const share=f.handlers.get('audio-favorite-sharing');
 const disabled=await share(null,false);assert.equal(disabled.success,true);assert.equal(disabled.sharing,false);assert.deepEqual(disabled.favorites,[]);
 const invalid=await share(null,'false');assert.equal(invalid.success,false);assert.match(invalid.error,/Choose whether/);
}));
test('native-picked MP3s need review, and only saved IDs can be previewed or imported',async()=>fixture(async invoke=>{
 const file=path.join(f.folder,'Test.mp3');const bytes=Buffer.alloc(512,1);await writeFile(file,bytes);f.choice={canceled:false,filePaths:[file]};const choice=await invoke('pick');assert.equal(choice.candidates.length,1);assert.equal(f.imports.length,0);assert.equal((await invoke('import','../../file')).success,false);
 const saved=await invoke('keep',{id:choice.candidates[0].id,title:'Test',license:'youtube-standard',credit:'Downloaded from Studio'});const id=saved.tracks[0].id;assert.equal(saved.candidates.length,0);assert.equal(saved.tracks[0].credit,'Downloaded from Studio');
 assert.equal((await f.protocol({url:'smoothy-audio://library/'+id,headers:{}})).status,200);assert.equal((await f.protocol({url:'smoothy-audio://other/'+id,headers:{}})).status,404);assert.equal((await f.protocol({url:'smoothy-audio://library/../../etc/passwd',headers:{}})).status,404);
 f.connected=false;assert.match((await invoke('import',id)).error,/Connect Premiere/);f.connected=true;assert.equal((await invoke('import',id)).imported,true);assert.match(f.imports[0],/SmoothyEdit Audio Library/);assert.deepEqual(await readFile(f.imports[0]),bytes);
}));
const archiveId='1KAk_m-PLFD8oT5EJ2JDBqx_Q0TqCeSEx';
const archiveInvoke=(name,input)=>f.handlers.get('audio-archive-'+name)(null,input);
const archiveFixture=(download)=>({
 search:async()=>({tracks:[{id:archiveId,title:'Sky Skating'}],total:1}),
 track:async id=>{if(id!==archiveId)throw Error('Choose a track from the audio archive.');return {id,title:'Sky Skating'};},
 download:download||(async(id,file,signal,progress)=>{await writeFile(file,Buffer.concat([Buffer.from('ID3'),Buffer.alloc(512,1)]));progress(515,515);}),
 preview:async(id,signal,range)=>{assert.equal(id,archiveId);assert.equal(range,'bytes=0-63');return new Response('preview',{status:206});}
});
test('archive search and direct save stay in-app and persist unverified license/source metadata',async()=>fixture(async invoke=>{
 assert.equal((await archiveInvoke('search',{query:'Sky'})).total,1);assert.deepEqual(f.opened,[]);
 assert.equal((await archiveInvoke('download',{id:'../../file'})).success,false);
 const saved=await archiveInvoke('download',{id:archiveId});assert.equal(saved.success,true);assert.equal(saved.tracks.length,1);assert.equal(saved.candidates.length,0);assert.equal(saved.tracks[0].license,'unverified');assert.equal(saved.tracks[0].archiveId,archiveId);assert.equal(saved.savedId,saved.tracks[0].id);assert.match(saved.tracks[0].credit,/not supplied/);
 assert.equal((await readdir(f.folder)).some(name=>name.startsWith('smoothy-audio-')),false);
 assert.equal((await f.protocol({url:'smoothy-audio://archive/'+archiveId,headers:{Range:'bytes=0-63'}})).status,206);
 assert.ok(f.events.some(event=>event.type==='audio-library-changed'));assert.ok(f.events.some(event=>event.type==='audio-archive-progress'&&event.data.phase==='validating'));
},archiveFixture()));
test('archive send requires Premiere; failed import preserves the saved MP3',async()=>fixture(async invoke=>{
 f.connected=false;assert.match((await archiveInvoke('download',{id:archiveId,premiere:true})).error,/Connect Premiere/);assert.equal((await invoke('state')).tracks.length,0);
 f.connected=true;f.importError='No open project';const result=await archiveInvoke('download',{id:archiveId,premiere:true});assert.match(result.error,/MP3 saved.*No open project/);
 const saved=await invoke('state');assert.equal(saved.tracks.length,1);assert.equal(saved.tracks[0].license,'unverified');assert.equal((await readFile(f.imports[0])).subarray(0,3).toString(),'ID3');
},archiveFixture()));
test('archive cancellation cleans temporary files, rejects overlap, and leaves no saved track',async()=>{
 let started;const ready=new Promise(resolve=>started=resolve);
 await fixture(async invoke=>{
  const pending=archiveInvoke('download',{id:archiveId});await ready;
  assert.match((await archiveInvoke('download',{id:archiveId})).error,/Wait/);
  await archiveInvoke('cancel');assert.equal((await pending).canceled,true);assert.equal((await invoke('state')).tracks.length,0);assert.equal((await readdir(f.folder)).some(name=>name.startsWith('smoothy-audio-')),false);
 },archiveFixture(async(id,file,signal)=>{await writeFile(file,Buffer.alloc(512));started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('canceled')),{once:true}));}));
});
