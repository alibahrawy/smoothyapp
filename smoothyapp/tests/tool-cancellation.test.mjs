import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const load = async relative => {
  const entry=fileURLToPath(new URL(relative, import.meta.url));
  const bundle=await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,packages:'external'});
  const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),__dirname:path.dirname(entry),process,Buffer,console,setImmediate,setTimeout,clearTimeout,AbortController});
  return module.exports;
};
const { detectSilence, detectSilenceCancelable, combineAudioTracks } = await load('../src/main/autocut/silence-detector.ts');
const { runPremiereMulticam } = await load('../src/main/autocut/premiere-multicam.ts');
const { PhotoService } = await load('../src/main/photo-service.ts');
const samples = new Int16Array(16000 * 5); samples.fill(16000, 16000, 48000);

test('cancelable silence detection preserves thresholds, padding and boundaries', async () => {
  assert.equal(JSON.stringify(await detectSilenceCancelable(samples,-40,0.5,0.1)), JSON.stringify(detectSilence(samples,-40,0.5,0.1)));
});
test('silence analysis receives cancellation during CPU work and a retry succeeds', async () => {
  const c = new AbortController();
  const pending = detectSilenceCancelable(new Int16Array(16000 * 600),-40,0.5,0.1,c.signal);
  setImmediate(() => c.abort());
  await assert.rejects(pending, {name:'AbortError'});
  assert.ok((await detectSilenceCancelable(samples)).speechSegments.length);
});
test('Premiere Multicam canceled during preparation never exports audio or submits cuts, and discards duplicate', async () => {
  const c = new AbortController(), calls=[];
  const config = {sources:[{index:0,camera:0}],options:{sequenceId:'source',timelineRevision:'revision',videoTracks:[{index:0}]}};
  await assert.rejects(runPremiereMulticam(config, { signal:c.signal, progress(){}, request:async(type)=>{calls.push(type);if(type==='prepareMulticam'){c.abort();return {success:true};}return {success:true};} }), {name:'AbortError'});
  assert.deepEqual(calls,['prepareMulticam','discardMulticam']);
});
test('AI Photos cancels the request, reports zero successful images, releases busy and retries', async () => {
  let waiting, count=0, stopped=false;
  const service = new PhotoService({owner:()=> 'fixture',track:()=>count++,png:x=>x,imageBytes:async()=>Buffer.from(''),request:async(_route,opts)=>{
    if (stopped) return {imageUrl:'data:image/png;base64,AA=='};
    await new Promise((resolve,reject)=>{waiting=()=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});waiting();});
  }});
  const input={action:'generate',prompt:'Fixture'};
  const pending=service.run(input);service.cancel();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(count,0);
  stopped=true;assert.ok((await service.run(input)).photo);assert.equal(count,1);
});

const entry = fileURLToPath(new URL('../src/main/websocket-server.ts', import.meta.url));
const source = fs.readFileSync(entry,'utf8');
const stubs = {
 './autocut/audio-extractor': `const f=globalThis.fixture;export const resetAudioExtractionCancel=()=>{};export const cleanupTempFile=p=>f.cleaned.push(p);export const cancelAudioExtraction=()=>f.abortExtraction?.();export const extractAudioTrack=async()=>'/fixture.wav';export async function stitchTimelineAudio(){if(f.stage==='extract')await new Promise((resolve,reject)=>{f.abortExtraction=()=>reject(Error('cancel'));f.ready();});return {path:'/fixture.wav'};}`,
 './autocut/silence-detector': `const f=globalThis.fixture;export const cleanupTempFile=()=>{};export const alignSegmentsToFrames=()=>{};export const combineAudioTracks=async()=>'/fixture.wav';export async function analyzeSilence(_p,_t,_m,_padding,signal){if(f.stage==='analyze')await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});f.ready();});return {speechSegments:[{start:0,end:1,duration:1}],silenceSegments:[{start:1,end:2,duration:1}],originalDuration:2,newDuration:1,silenceRemoved:1,cutsCount:1};}`
};
const bundle = await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',packages:'external',write:false,plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:'fixture'}:undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs[a.path]}));
 b.onLoad({filter:/websocket-server\.ts$/},()=>({contents:source+`\nexport const fixtureSequence=()=>{currentSequenceInfo={id:'source'};};export const fixtureBridge=bridgeRequests;`,loader:'ts'}));
}}]});
function fixture(stage){
 const f={stage,cleaned:[],results:[],progress:[],submitted:0};
 f.atStage = new Promise(resolve=>f.ready=resolve);
 const module={exports:{}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),process,Buffer,console:{log(){},warn(){},error(){}},AbortController,setImmediate,setTimeout,clearTimeout,fixture:f});
 const api=module.exports;api.fixtureSequence();api.setCallbacks({onResult:r=>f.results.push(r),onProgress:(p,m,c)=>{f.progress.push({p,c});if(c===false)f.commitCancel=api.cancelTimelineOperation();}});
 api.fixtureBridge.request=async()=>{f.submitted++;return {success:true};};
 return {f,api};
}
const config={sources:[{path:'fixture.wav',clips:[{path:'fixture.wav',start:0,end:2,inPoint:0,outPoint:2}]}],options:{sequenceId:'source',fps:25,editInPlace:true}};
for(const stage of ['extract','analyze'])test(`Silence Removal cancels ${stage}, cleans temp files, never edits, and permits retry`, async()=>{
 const {f,api}=fixture(stage);let starts=0;
 const pending=api.runSilenceRemoval(config,()=>starts++);await f.atStage;
 assert.equal((await api.runSilenceRemoval(config,()=>starts++)).success,false);
 assert.equal(api.cancelTimelineOperation().success,true);
 const result=await pending;assert.equal(result.canceled,true);assert.equal(result.operation,'silence');assert.equal(f.submitted,0);assert.equal(starts,1);
 if(stage==='analyze')assert.ok(f.cleaned.includes('/fixture.wav'));
 f.stage='done';assert.equal((await api.runSilenceRemoval(config,()=>starts++)).success,true);assert.equal(starts,2);assert.equal(f.submitted,1);
 assert.equal(f.commitCancel.success,false);assert.match(f.commitCancel.error,/applying/);
 assert.equal(f.results.length,2);
});
test('Silence Removal validation failures never count starts and release the guard',async()=>{
 const {api}=fixture('done');let starts=0;
 assert.equal((await api.runSilenceRemoval({...config,options:{...config.options,sequenceId:'wrong'}},()=>starts++)).success,false);
 assert.equal(starts,0);assert.equal((await api.runSilenceRemoval(config,()=>starts++)).success,true);assert.equal(starts,1);
});

test('real FFmpeg audio combination stops on abort and removes its incomplete WAV', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-cancel-audio-'));
  const input=path.join(directory,'input.wav');
  const pcm=Buffer.alloc(16000*60*2), header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(input,Buffer.concat([header,pcm]));
  const temp=path.join(os.tmpdir(),'smoothyedit-temp');const before=new Set(fs.existsSync(temp)?fs.readdirSync(temp):[]);
  const c=new AbortController();
  try {
    const pending=combineAudioTracks([input,input],c.signal);c.abort();
    await assert.rejects(pending,{name:'AbortError'});
    assert.deepEqual(fs.readdirSync(temp).filter(name=>name.startsWith('combined_')&&!before.has(name)),[]);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
