import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
Error.stackTraceLimit=0;
const f={handlers:new Map(),choice:{canceled:true},saves:[],preview:[],protocol:null,failed:false,ffmpeg:null};globalThis.__localAudio=f;
const result=await build({entryPoints:[fileURLToPath(new URL('../src/main/local-audio-ipc.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false,define:{__dirname:JSON.stringify(fileURLToPath(new URL('../out/main',import.meta.url)))},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^(electron|\.\/local-audio-service|\.\/telemetry)$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='electron'?`const f=globalThis.__localAudio;export const app={getPath:()=>'/fixture',on(){}};export const ipcMain={handle:(name,fn)=>f.handlers.set(name,fn)};export const dialog={showSaveDialog:async()=>f.choice,showOpenDialog:async()=>f.choice};export const protocol={registerSchemesAsPrivileged(){},handle:(name,fn)=>f.protocol=fn};export const net={fetch:async()=>new Response('wav')};`:path==='ffmpeg-static'?`export default 'ffmpeg';`:path==='./telemetry'?`export const trackTool=()=>{};`:`const f=globalThis.__localAudio;export class LocalAudioService{constructor(deps){f.ffmpeg=deps.ffmpeg}output(id){if(id!=='valid')throw Error('Unknown result');return {label:'Voice',file:'/fixture/voice.wav'}}async save(id,file){if(f.failed)throw Error('Disk full');f.saves.push({id,file})}preview(id){this.output(id);f.preview.push(id)}async state(){return {ready:true}}async dispose(){} cancel(){} }`}));
}}]});
const {registerLocalAudio}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
registerLocalAudio(()=>({isDestroyed:()=>false,webContents:{send(){}}}));
const sender=new EventEmitter();
const invoke=(name,input)=>f.handlers.get('local-audio-'+name)({sender},input);

test('Audio Cleanup resolves a real bundled decoder from the compiled main location',()=>{
 const binary=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
 assert.equal(f.ffmpeg,path.resolve(fileURLToPath(new URL('../node_modules/ffmpeg-static/',import.meta.url)),binary));
 assert.ok(fs.statSync(f.ffmpeg).isFile());
 assert.notEqual(f.ffmpeg,path.resolve(fileURLToPath(new URL('../out/main/',import.meta.url)),binary));
});
test('save dialog cancellation, invalid results and failed writes are not successful saves',async()=>{
 assert.equal((await invoke('save','valid')).canceled,true);assert.equal(f.saves.length,0);
 assert.equal((await invoke('save','bad')).success,false);assert.equal(f.saves.length,0);
 f.choice={canceled:false,filePath:'/fixture/chosen.wav'};f.failed=true;
 assert.equal((await invoke('save','valid')).success,false);assert.equal(f.saves.length,0);
 f.failed=false;assert.equal((await invoke('save','valid')).success,true);assert.equal(f.saves.length,1);
});
test('source cancellation is uncounted and playback/protocol only accepts generated output IDs',async()=>{
 f.choice={canceled:true};assert.equal((await invoke('pick')).canceled,true);
 assert.equal(sender.listenerCount('destroyed'),0);
 assert.equal((await invoke('preview','bad')).success,false);assert.deepEqual(f.preview,[]);
 assert.equal((await invoke('preview','valid')).success,true);assert.deepEqual(f.preview,['valid']);
 for(const url of ['smoothy-local-audio://result/../../secret','smoothy-local-audio://other/00000000-0000-0000-0000-000000000000'])assert.equal((await f.protocol({url,headers:{}})).status,404);
});
