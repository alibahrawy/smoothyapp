import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Exercise the real registered IPC handlers. Every native dependency is mocked;
// this never opens Premiere, starts Whisper, downloads a model or spends credits.
const fixture = { handlers: new Map(), values: {}, sequence: null, transcriptions: 0, loading: null, mode: 'ready', cleaned: [], whisperCancels: 0, shortsSignal: null };
const fakeElectron = `const f = globalThis.__captionFixture; export const ipcMain = {handle:(name,fn)=>f.handlers.set(name,fn)}; export const app={getPath:()=>'/tmp',isPackaged:false,whenReady:()=>({then(){}}),on(){}}; export class BrowserWindow {} export const shell={},dialog={},Menu={},clipboard={};`;
const stubs = {
  electron: fakeElectron,
  'electron-store': `const f=globalThis.__captionFixture;export default class Store {get(key){return f.values[key]}set(key,value){f.values[key]=value}delete(key){delete f.values[key]}}`,
  './nle-router': `const f=globalThis.__captionFixture;export const getSequenceInfo=()=>f.sequence; export const startNLEServers=()=>{}, stopNLEServers=()=>{},setCallbacks=()=>{},requestSequenceInfo=()=>{},runAutoCut=()=>{},runSilenceRemoval=()=>{},getConnectionStatus=()=>true,getActiveNLE=()=>null,setActiveNLE=()=>{},exportAudio=()=>{},addMarkersToSequence=()=>{},clearMarkersFromSequence=()=>{},exportSubtitles=()=>{},sendCaptionsToNLE=()=>{},importImageToNLE=()=>{};`,
  './captions/whisper-service': `const f=globalThis.__captionFixture;export const setEnginePreference=()=>{},isModelLoaded=()=>f.mode==='ready',getCurrentModelId=()=>f.values.captionModel||'ggml-base.bin',getActiveBackend=()=> 'cpu',cancelTranscription=async()=>{f.whisperCancels++},unloadModel=async()=>{},getEnginePreference=()=> 'auto'; export const loadModel=async(id,progress,signal)=> {f.loading=signal;if(signal.aborted)throw Error('TRANSCRIPTION_CANCELLED');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('TRANSCRIPTION_CANCELLED')),{once:true}));};export const transcribe=async()=>{f.transcriptions++;return {text:'hello',chunks:[{text:'hello',timestamp:[0,1]}]}};`,
  './auth-service': `export const getAuthState=()=>({user:{id:'fixture-user'}}),initializeTrial=()=>{},login=()=>{},logout=()=>{},refreshUserData=()=>{},getTrialStatus=()=>{},canUseFeature=()=>{},setAuthChangeCallback=()=>{},generateConnectionToken=()=>{},getStoredUserId=()=>null,getAuthHeaders=()=>({});`,
  './shorts-service': `const f=globalThis.__captionFixture;export const runShortsAnalysis=async(config,deps)=>{f.shortsSignal=deps.signal;await new Promise((resolve,reject)=>deps.signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}));};`,
  './autocut/audio-extractor': `const f=globalThis.__captionFixture;export const resetAudioExtractionCancel=()=>{},cancelAudioExtraction=()=>{},cleanupTempFile=file=>f.cleaned.push(file),extractAudioTrack=async()=>'/tmp/fixture-normalized.wav',stitchTimelineAudio=async()=>({path:'/tmp/fixture-timeline.wav',durationSeconds:10});`
};
const output = await build({ entryPoints: [new URL('../src/main/index.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [{ name:'fixture', setup(builder) {
  builder.onResolve({filter:/.*/}, args => args.path in stubs ? {path:args.path,namespace:'fixture'} : undefined);
  builder.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:stubs[args.path]}));
}}] });
const require = createRequire(import.meta.url);
const context = { require, module:{exports:{}}, exports:{}, __dirname:new URL('../src/main',import.meta.url).pathname, __filename:new URL('../src/main/index.ts',import.meta.url).pathname, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch, __captionFixture:fixture };
vm.createContext(context); vm.runInContext(output.outputFiles[0].text, context);
const generate = fixture.handlers.get('generate-captions');
const cancel = fixture.handlers.get('cancel-generate-captions');

test('early caption failures release the busy flag and clean temporary audio', async () => {
  fixture.sequence = null;
  assert.match((await generate(null, {settings:{}})).error, /No active sequence/);
  fixture.values.captionModel = 'ggml-base.en.bin'; fixture.values.captionLanguage = 'ar';
  assert.match((await generate(null, {audioPath:'/tmp/fixture.wav',settings:{}})).error, /only transcribe English/);
  assert.ok(fixture.cleaned.includes('/tmp/fixture-normalized.wav'));
  fixture.values.captionModel = 'ggml-base.bin'; fixture.values.captionLanguage = 'ar';
  assert.equal((await generate(null, {audioPath:'/tmp/fixture.wav',settings:{}})).success, true);
  assert.equal(fixture.transcriptions, 1);
});

test('cancel during setup prevents transcription and a later job can run', async () => {
  fixture.mode = 'loading'; fixture.loading = null;
  const job = generate(null, {audioPath:'/tmp/fixture.wav',settings:{}});
  while (!fixture.loading) await new Promise(resolve => setTimeout(resolve, 1));
  await cancel();
  assert.equal((await job).cancelled, true);
  assert.equal(fixture.transcriptions, 1);
  fixture.mode = 'ready';
  assert.equal((await generate(null, {audioPath:'/tmp/fixture.wav',settings:{}})).success, true);
  assert.equal(fixture.transcriptions, 2);
});

test('canceling transcript Shorts leaves an independent caption job running', async () => {
  fixture.mode = 'loading'; fixture.loading = null; fixture.shortsSignal = null;
  const captionJob = generate(null, {audioPath:'/tmp/fixture.wav',settings:{}});
  while (!fixture.loading) await new Promise(resolve => setTimeout(resolve, 1));
  const shortsJob = fixture.handlers.get('analyze-shorts')(null, {source:'transcript',subtitleText:'Fixture transcript'});
  while (!fixture.shortsSignal) await new Promise(resolve => setTimeout(resolve, 1));
  const before = fixture.whisperCancels;
  await fixture.handlers.get('cancel-analyze-shorts')();
  assert.equal((await shortsJob).cancelled, true);
  assert.equal(fixture.whisperCancels, before);
  assert.equal(fixture.loading.aborted, false);
  await cancel();
  assert.equal((await captionJob).cancelled, true);
  fixture.mode = 'ready';
});
