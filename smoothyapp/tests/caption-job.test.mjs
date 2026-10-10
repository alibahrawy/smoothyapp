import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercise the real registered IPC handlers. Every native dependency is mocked;
// this never opens Premiere, starts Whisper, downloads a model or spends credits.
const fixture = { handlers: new Map(), values: {}, sequence: null, transcriptions: 0, loading: null, mode: 'ready', cleaned: [], whisperCancels: 0, shortsSignal: null, tracked: [], extractionError: null };
const fakeElectron = `const f = globalThis.__captionFixture; export const ipcMain = {handle:(name,fn)=>f.handlers.set(name,fn)}; export const app={getPath:()=>'/tmp',isPackaged:false,whenReady:()=>({then(){}}),on(){}}; export class BrowserWindow {} export const shell={},dialog={showSaveDialog:async()=>({canceled:f.saveCanceled,filePath:f.savePath})},Menu={},clipboard={};`;
const stubs = {
  './telemetry': `const f=globalThis.__captionFixture;export const initTelemetry=()=>{},trackEvent=()=>{},trackTool=id=>f.tracked.push(id),trackAssetsAction=()=>{},startHeartbeat=()=>{},stopHeartbeat=()=>{};`,
  './assets-image-ipc': 'export {};',
  electron: fakeElectron,
  './audio-library-ipc': 'export async function registerAudioLibrary() {}',
  './photo-ipc': 'export function registerPhotos() {}',
  './stock-footage-ipc': 'export const registerStockFootage=()=>{};',
  'electron-store': `const f=globalThis.__captionFixture;export default class Store {get(key){return f.values[key]}set(key,value){f.values[key]=value}delete(key){delete f.values[key]}}`,
  './nle-router': `const f=globalThis.__captionFixture;export const getSequenceInfo=()=>f.sequence; export const startNLEServers=()=>{}, stopNLEServers=()=>{},setCallbacks=()=>{},requestSequenceInfo=()=>{},runAutoCut=()=>{},runSilenceRemoval=()=>{},getConnectionStatus=()=>true,getActiveNLE=()=>null,setActiveNLE=()=>{},exportAudio=()=>f.exportedAudioPromise||Promise.resolve({success:true,audioBase64:'fixture'}),addMarkersToSequence=()=>{},clearMarkersFromSequence=()=>{},exportSubtitles=()=>{},sendCaptionsToNLE=async file=>{f.importedPaths.push(file);return {success:f.captionImportSuccess};},importImageToNLE=()=>{},importAudioLibraryToNLE=()=>{},importStockFootageToNLE=()=>{};`,
  './captions/whisper-service': `const f=globalThis.__captionFixture;export const setEnginePreference=()=>{},isModelLoaded=()=>f.mode==='ready',getCurrentModelId=()=>f.values.captionModel||'ggml-base.bin',getActiveBackend=()=> 'cpu',cancelTranscription=async()=>{f.whisperCancels++},unloadModel=async()=>{},getEnginePreference=()=> 'auto'; export const loadModel=async(id,progress,signal)=> {f.loading=signal;if(signal.aborted)throw Error('TRANSCRIPTION_CANCELLED');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('TRANSCRIPTION_CANCELLED')),{once:true}));};export const transcribe=async()=>{f.transcriptions++;return {text:'hello',chunks:[{text:'hello',timestamp:[0,1]}]}};`,
  './auth-service': `export const getAuthState=()=>({user:{id:'fixture-user'}}),initializeTrial=()=>{},login=()=>{},signup=()=>{},logout=()=>{},refreshUserData=()=>{},getTrialStatus=()=>{},canUseFeature=()=>{},setAuthChangeCallback=()=>{},generateConnectionToken=()=>{},getStoredUserId=()=>null,getAuthHeaders=()=>({});`,
  './shorts-service': `const f=globalThis.__captionFixture;export const runShortsAnalysis=async(config,deps)=>{f.shortsSignal=deps.signal;await new Promise((resolve,reject)=>deps.signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}));};`,
  './autocut/audio-extractor': `const f=globalThis.__captionFixture;export const resetAudioExtractionCancel=()=>{},cancelAudioExtraction=()=>{},cleanupTempFile=file=>f.cleaned.push(file),extractAudioTrack=async()=>{if(f.extractionError)throw Error(f.extractionError);return '/tmp/fixture-normalized.wav';},stitchTimelineAudio=async()=>({path:'/tmp/fixture-timeline.wav',durationSeconds:10});`
};
const output = await build({ entryPoints: [new URL('../src/main/index.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [{ name:'fixture', setup(builder) {
  builder.onResolve({filter:/.*/}, args => args.path in stubs ? {path:args.path,namespace:'fixture'} : undefined);
  builder.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:stubs[args.path]}));
}}] });
const require = createRequire(import.meta.url);
const context = { require, module:{exports:{}}, exports:{}, __dirname:new URL('../src/main',import.meta.url).pathname, __filename:new URL('../src/main/index.ts',import.meta.url).pathname, process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, fetch, __captionFixture:fixture };
vm.createContext(context); vm.runInContext(output.outputFiles[0].text, context, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
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

test('Studio off rejects Shorts before local transcription while keeping local Captions usable', async () => {
  const preferences = fixture.handlers.get('set-studio-enabled');
  assert.equal((await preferences(null, false)).success, true);
  const before = fixture.transcriptions;
  const denied = await fixture.handlers.get('analyze-shorts')(null, { source: 'audio', audioPath: '/tmp/fixture.wav' });
  assert.equal(denied.success, false); assert.match(denied.error, /turned off/); assert.equal(fixture.transcriptions, before);
  fixture.mode = 'ready'; fixture.values.captionModel = 'ggml-base.bin'; fixture.values.captionLanguage = 'ar';
  assert.equal((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).success, true);
  assert.equal(fixture.transcriptions, before + 1);
  assert.equal((await preferences(null, true)).success, true);
});

test('turning Studio off during a Premiere audio export prevents its later cloud handoff', async () => {
  let finish; fixture.sequence = { hasSequence: true, name: 'Fixture', duration: 10 };
  fixture.exportedAudioPromise = new Promise(resolve => { finish = resolve; });
  const handoff = fixture.handlers.get('export-audio-to-website')(null);
  await new Promise(resolve => setImmediate(resolve));
  await fixture.handlers.get('set-studio-enabled')(null, false);
  finish({ success: true, audioBase64: 'fixture' });
  assert.equal((await handoff).success, false);
  fixture.exportedAudioPromise = null;
  await fixture.handlers.get('set-studio-enabled')(null, true);
});

test('failed audio preparation never transcribes the original file, counts only one start and releases the job', async () => {
  const before = fixture.transcriptions; fixture.tracked = []; fixture.extractionError = 'Invalid audio stream';
  const failed = await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} });
  assert.equal(failed.success, false); assert.match(failed.error, /Invalid audio stream/);
  assert.equal(fixture.transcriptions, before); assert.deepEqual(fixture.tracked, ['captions']);
  fixture.extractionError = null;
  assert.equal((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).success, true);
  assert.equal(fixture.transcriptions, before + 1); assert.deepEqual(fixture.tracked, ['captions', 'captions']);
});

test('duplicate Generate is rejected without an extra start; cancellation is a start, never an export/import success', async () => {
  fixture.mode = 'loading'; fixture.loading = null; fixture.tracked = [];
  const job = generate(null, { audioPath: '/tmp/fixture.wav', settings: {} });
  while (!fixture.loading) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).success, false);
  await cancel(); assert.equal((await job).cancelled, true);
  assert.deepEqual(fixture.tracked, ['captions']); fixture.mode = 'ready';
});

test('Arabic caption saves/imports count native successes only; canceled/failed actions add none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-actions-'));
  fixture.tracked = []; fixture.importedPaths = [];
  const save = fixture.handlers.get('save-captions'), send = fixture.handlers.get('import-captions-to-premiere');
  const content = '1\n00:00:00,000 --> 00:00:02,000\nأعزائي المشاهدين\n';
  try {
    fixture.savePath = path.join(dir, 'captions.srt'); fixture.saveCanceled = false;
    assert.equal((await save(null, { format: 'srt', content })).success, true);
    assert.equal(fs.readFileSync(fixture.savePath, 'utf8'), content);
    fixture.saveCanceled = true; assert.equal((await save(null, { format: 'srt', content })).canceled, true);
    fixture.saveCanceled = false; fixture.savePath = path.join(dir, 'missing', 'captions.srt');
    assert.equal((await save(null, { format: 'srt', content })).success, false);
    fixture.captionImportSuccess = false;
    assert.equal((await send(null, [{ index: 1, startTime: 0, endTime: 2, text: 'أعزائي المشاهدين' }])).success, false);
    // Distinct native calls use the same SRT name if the clock has not advanced.
    await new Promise(resolve => setTimeout(resolve, 2));
    fixture.captionImportSuccess = true;
    assert.equal((await send(null, [{ index: 1, startTime: 0, endTime: 2, text: 'أعزائي المشاهدين' }])).success, true);
    assert.match(fs.readFileSync(fixture.importedPaths.at(-1), 'utf8'), /أعزائي المشاهدين/);
    assert.deepEqual(fixture.tracked, ['captions_export', 'captions_premiere']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const file of fixture.importedPaths) fs.rmSync(file, { force: true });
  }
});
