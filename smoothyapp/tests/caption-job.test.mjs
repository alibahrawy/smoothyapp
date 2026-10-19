import { fileURLToPath } from 'node:url';
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
const fakeElectron = `const f = globalThis.__captionFixture; export const ipcMain = {handle:(name,fn)=>f.handlers.set(name,fn)}; export const app={getPath:()=>f.userData||'/tmp',disableDomainBlockingFor3DAPIs(){},commandLine:{appendSwitch(){}},isPackaged:false,whenReady:()=>({then(){}}),on(){}}; export class BrowserWindow {} export const shell={openPath:async folder=>{f.openedFolder=folder;return f.openFolderError||''}},dialog={showSaveDialog:async()=>({canceled:f.saveCanceled,filePath:f.savePath})},Menu={},clipboard={},protocol={registerSchemesAsPrivileged(){},handle(){}};`;
const stubs = {
  './telemetry': `const f=globalThis.__captionFixture;export const initTelemetry=()=>{},trackEvent=()=>{},trackTool=id=>f.tracked.push(id),trackAssetsAction=()=>{},startHeartbeat=()=>{},stopHeartbeat=()=>{};`,
  './assets-image-ipc': 'export {};',
  electron: fakeElectron,
  './audio-library-ipc': 'export async function registerAudioLibrary() {}',
  './photo-ipc': 'export function registerPhotos() {}',
  './stock-footage-ipc': 'export const registerStockFootage=()=>{};',
  'electron-store': `const f=globalThis.__captionFixture;export default class Store {get(key){return f.values[key]}set(key,value){f.values[key]=value}delete(key){delete f.values[key]}}`,
  './nle-router': `const f=globalThis.__captionFixture;export const getSequenceInfo=()=>f.sequence; export const startNLEServers=()=>{}, stopNLEServers=()=>{},setCallbacks=()=>{},requestSequenceInfo=()=>{},runAutoCut=()=>{},runSilenceRemoval=()=>{},getConnectionStatus=()=>true,getActiveNLE=()=>f.editor||null,setActiveNLE=()=>{},loadResolveTimeline=()=>{},getResolveOutput=()=>{},cancelResolveMulticam=()=>{},cancelTimelineJob=()=>{},configureResolveReceiver=()=>{},prepareResolveAudio=async(indices,signal)=>{f.resolveAudio={indices,signal};return {path:"/tmp/resolve.wav",durationSeconds:10,clipCount:2};},exportAudio=()=>f.exportedAudioPromise||Promise.resolve({success:true,audioBase64:'fixture'}),addMarkersToSequence=()=>{},clearMarkersFromSequence=()=>{},exportSubtitles=()=>{},sendCaptionsToNLE=async file=>{f.importedPaths.push(file);return {success:f.captionImportSuccess,nle:f.importNLE};},importImageToNLE=()=>{},importAudioLibraryToNLE=()=>{},importStockFootageToNLE=()=>{};`,
  './captions/whisper-service': `const f=globalThis.__captionFixture;export const setEnginePreference=()=>{},isModelLoaded=()=>f.mode==='ready',getCurrentModelId=()=>f.values.captionModel||'ggml-base.bin',getActiveBackend=()=> 'cpu',cancelTranscription=async()=>{f.whisperCancels++},unloadModel=async()=>{},getEnginePreference=()=> 'auto'; export const loadModel=async(id,progress,signal)=> {f.loading=signal;if(signal.aborted)throw Error('TRANSCRIPTION_CANCELLED');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('TRANSCRIPTION_CANCELLED')),{once:true}));};export const transcribe=async()=>{f.transcriptions++;return {text:'hello',chunks:[{text:'hello',timestamp:[0,1]}]}};`,
  './auth-service': `export const getAuthState=()=>({user:{id:'fixture-user'}}),initializeTrial=()=>{},login=()=>{},signup=()=>{},logout=()=>{},refreshUserData=()=>{},getTrialStatus=()=>{},canUseFeature=()=>{},setAuthChangeCallback=()=>{},generateConnectionToken=()=>{},getStoredUserId=()=>null,getAuthHeaders=()=>({});`,
  './shorts-service': `const f=globalThis.__captionFixture;export const runShortsAnalysis=async(config,deps)=>{f.shortsSignal=deps.signal;await new Promise((resolve,reject)=>deps.signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}));};`,
  './autocut/audio-extractor': `const f=globalThis.__captionFixture;export const resetAudioExtractionCancel=()=>{},cancelAudioExtraction=()=>{},cleanupTempFile=file=>f.cleaned.push(file),extractAudioTrack=async()=>{if(f.extractionError)throw Error(f.extractionError);return '/tmp/fixture-normalized.wav';},stitchTimelineAudio=async()=>({path:'/tmp/fixture-timeline.wav',durationSeconds:10});`
};
const output = await build({ entryPoints: [fileURLToPath(new URL('../src/main/index.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', plugins: [{ name:'fixture', setup(builder) {
  builder.onResolve({filter:/.*/}, args => args.path in stubs ? {path:args.path,namespace:'fixture'} : undefined);
  builder.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:stubs[args.path]}));
}}] });
const require = createRequire(import.meta.url);
const context = { require, module:{exports:{}}, exports:{}, __dirname:fileURLToPath(new URL('../src/main',import.meta.url)), __filename:fileURLToPath(new URL('../src/main/index.ts',import.meta.url)), process, Buffer, console, setTimeout, clearTimeout, setImmediate, AbortController, setInterval, clearInterval, fetch, __captionFixture:fixture };
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

test('Resolve sequence captions use isolated source-audio preparation, clean it and keep the normal start count',async()=>{
 fixture.editor='resolve';fixture.mode='ready';fixture.tracked=[];fixture.cleaned=[];
 fixture.sequence={hasSequence:true,audioTracks:[{index:1,clips:[{path:'/fixture.wav',start:0,end:10,inPoint:0,outPoint:10}]}]};
 try{const result=await generate(null,{settings:{},trackIndices:[1]});assert.equal(result.success,true,result.error);assert.deepEqual(Array.from(fixture.resolveAudio.indices),[1]);assert.equal(fixture.resolveAudio.signal.aborted,false);assert.ok(fixture.cleaned.includes('/tmp/resolve.wav'));assert.deepEqual(fixture.tracked,['captions']);}
 finally{fixture.editor=null;fixture.sequence=null;}
});
test('native-confirmed Resolve caption sends count separately without invented Premiere successes',async()=>{
 fixture.importNLE='resolve';fixture.captionImportSuccess=true;fixture.tracked=[];fixture.importedPaths=[];
 try{const result=await fixture.handlers.get('import-captions-to-premiere')(null,[{index:1,startTime:0,endTime:1,text:'Hello'}]);assert.equal(result.success,true);assert.deepEqual(fixture.tracked,['captions_resolve']);}
 finally{fixture.importNLE=undefined;for(const file of fixture.importedPaths)fs.rmSync(file,{force:true});}
});

test('both Darija specialists preserve the earlier model and count only Generate', async () => {
  const setLanguage = fixture.handlers.get('set-caption-language');
  const setModel = fixture.handlers.get('set-selected-caption-model');
  fixture.mode = 'ready'; fixture.tracked = [];
  fixture.values.captionModel = 'ggml-base.en.bin'; fixture.values.captionLanguage = 'en';
  assert.equal((await setLanguage(null, 'ary')).modelId, 'moulsot-v0.3-darija');
  assert.equal(fixture.values.captionModelBeforeDarija, 'ggml-base.en.bin');
  assert.equal((await setModel(null, 'ggml-small-darija-dora.bin')).language, 'ary');
  assert.equal(fixture.values.captionModelBeforeDarija, 'ggml-base.en.bin');
  assert.equal((await setLanguage(null, 'ary')).modelId, 'ggml-small-darija-dora.bin');
  assert.deepEqual(fixture.tracked, []);
  assert.equal((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).success, true);
  assert.deepEqual(fixture.tracked, ['captions']);
  assert.equal((await setLanguage(null, 'en')).modelId, 'ggml-base.en.bin');
  assert.equal((await setModel(null, 'ggml-small-darija-dora.bin')).language, 'ary');
  assert.equal((await setLanguage(null, 'en')).modelId, 'ggml-base.en.bin');
  assert.deepEqual(fixture.tracked, ['captions']);
});

test('models folder opens only the app cache; refresh and custom selections add no usage, missing models fail with one start', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-folder-'));
  fixture.userData = profile; fixture.tracked = []; fixture.mode = 'ready';
  const open = fixture.handlers.get('open-caption-models-folder');
  const list = fixture.handlers.get('get-caption-models');
  const setModel = fixture.handlers.get('set-selected-caption-model');
  const setLanguage = fixture.handlers.get('set-caption-language');
  try {
    assert.equal((await open(null, '/untrusted/path')).success, true);
    assert.equal(fixture.openedFolder, path.join(profile, 'whisper-models'));
    assert.deepEqual(fs.readdirSync(fixture.openedFolder), []);
    fixture.openFolderError = 'Folder access denied';
    assert.equal((await open()).error, 'Folder access denied');
    fixture.openFolderError = null;
    const file = path.join(fixture.openedFolder, 'My model.bin');
    const bytes = Buffer.alloc(64);
    [0x67676d6c, 51865, 1500, 512, 8, 6, 448, 512, 8, 6, 80, 1].forEach((v, i) => bytes.writeInt32LE(v, i * 4));
    fs.writeFileSync(file, bytes);
    const id = 'local:My model.bin';
    assert.ok(list().some(model => model.id === id && model.custom && !model.specialistLanguage));
    fixture.values.captionModel = 'ggml-base.en.bin'; fixture.values.captionLanguage = 'en';
    assert.equal((await setModel(null, id)).language, 'en');
    for (const language of ['fr', 'ar', 'ary', 'en', 'auto']) {
      assert.equal((await setLanguage(null, language)).modelId, id);
      assert.equal(fixture.values.captionLanguage, language);
      assert.equal((await setModel(null, id)).language, language);
    }
    assert.deepEqual(fixture.tracked, []);
    assert.equal((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).success, true);
    // An old named subfolder is ordinary organization, never a language hint.
    const existingFolder = path.join(fixture.openedFolder, 'darija');
    fs.mkdirSync(existingFolder);
    fs.writeFileSync(path.join(existingFolder, 'Existing model.bin'), bytes);
    assert.equal((await setModel(null, 'local:darija/Existing model.bin')).language, 'auto');
    assert.equal((await setLanguage(null, 'fr')).modelId, 'local:darija/Existing model.bin');
    // Detect English-only weights by header even under a multilingual-looking name.
    const englishFile = path.join(fixture.openedFolder, 'Renamed model.bin');
    const englishBytes = Buffer.from(bytes); englishBytes.writeInt32LE(51864, 4);
    fs.writeFileSync(englishFile, englishBytes);
    await setModel(null, 'local:Renamed model.bin');
    assert.match((await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} })).error, /only transcribe English/);
    await setModel(null, id);
    fs.rmSync(file);
    const before = fixture.transcriptions;
    const failed = await generate(null, { audioPath: '/tmp/fixture.wav', settings: {} });
    assert.equal(failed.success, false);
    assert.match(failed.error, /Selected model is missing or unsupported/);
    assert.equal(fixture.transcriptions, before);
    assert.deepEqual(fixture.tracked, ['captions', 'captions', 'captions']);
  } finally {
    fixture.userData = null; fixture.openFolderError = null;
    fixture.values.captionModel = 'ggml-base.bin';
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
