import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { build, transform } from 'esbuild';

const stubs = {
  electron: `export const app={getVersion:()=> '2.0.0'};`,
  'electron-store': `export default class Store {}`,
  './autocut/premiere-multicam': `export async function runPremiereMulticam(){const f=globalThis.fixture;f.jobs++;if(f.hold)await new Promise(resolve=>f.release=resolve);if(f.error)throw Error(f.error);return {success:true};}`,
  './autocut/vad-runner': `export const runVad=()=>{};`,
  './autocut/decision-engine': `export const generateShotDecisions=()=>{};`,
  './autocut/audio-extractor': `export const extractAudioTrack=()=>{},stitchTimelineAudio=()=>{},cleanupTempFile=()=>{},resetAudioExtractionCancel=()=>{};`,
  './autocut/silence-detector': `export const combineAudioTracks=()=>{},analyzeSilence=()=>{},cleanupTempFile=()=>{},alignSegmentsToFrames=()=>{};`,
  './autocut/silence-xml-generator': `export const generateSilenceRemovalXML=()=>{};`,
};
const bundle = await build({
  stdin: { contents: `export {runAutoCut,startNLEServers,setCallbacks} from './src/main/nle-router';export {initTelemetry,trackTool} from './src/main/telemetry';`, resolveDir: new URL('..', import.meta.url).pathname },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['ws'],
  plugins: [{ name: 'native-adapters', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path] }));
  } }],
});
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const start = main.indexOf("ipcMain.handle('start-autocut'");
const handlerCode = (await transform(main.slice(start, main.indexOf('\n});', start) + 4), { loader: 'ts' })).code;

function fixture(disabled = false, version = 7) {
  const f = { jobs: 0, hold: false, error: null, events: [], results: [] };
  class Socket extends EventEmitter { static OPEN = 1; readyState = 1; send() {} }
  Socket.Server = class extends EventEmitter { constructor() { super(); f.server = this; } close() {} };
  const realRequire = createRequire(import.meta.url), module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, fixture: f,
    require: name => name === 'ws' ? Socket : realRequire(name),
    process: { platform: 'darwin', env: disabled ? { SMOOTHY_TELEMETRY: '0' } : {} }, Buffer, URL,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (_url, options) => { f.events.push(JSON.parse(options.body)); return {}; },
    setTimeout, clearTimeout,
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const api = module.exports;
  api.initTelemetry({ get: () => 'fixture-install', set() {} });
  api.setCallbacks({ onResult: result => f.results.push(result) });
  api.startNLEServers();
  const socket = new Socket(); f.server.emit('connection', socket, { url: '/' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'sequenceInfo', multicamTimelineVersion: version })));
  let handler;
  vm.runInNewContext(handlerCode, { ipcMain: { handle: (_name, callback) => { handler = callback; } }, runAutoCut: api.runAutoCut, trackTool: api.trackTool });
  return { f, api, start: () => handler(null, { fixture: true }) };
}

test('real Multicam IPC counts one accepted native start and rejects overlapping starts without events', async () => {
  const { f, start } = fixture(); f.hold = true;
  const pending = start(); await start(); await start();
  assert.equal(f.jobs, 1); assert.equal(f.events.length, 1); assert.equal(f.events[0].tool, 'multicam');
  assert.deepEqual(Object.keys(f.events[0]).sort(), ['appVersion', 'event', 'installId', 'platform', 'tool']);
  f.release(); await pending;
  f.hold = false; await start(); assert.equal(f.jobs, 2); assert.equal(f.events.length, 2);
});

test('failed and canceled accepted jobs retain start counts and release the busy guard', async () => {
  for (const error of ['Native camera edit failed', 'Canceled']) {
    const { f, start } = fixture(); f.error = error; await start();
    assert.equal(f.events.length, 1); assert.equal(f.results[0].success, false);
    f.error = null; await start(); assert.equal(f.events.length, 2); assert.equal(f.results[1].success, true);
  }
  const { f, start } = fixture(false, 0); await start();
  assert.equal(f.jobs, 0); assert.equal(f.events.length, 1); assert.equal(f.results[0].success, false);
});

test('telemetry opt-out and failed analytics never block accepted Multicam jobs', async () => {
  const optedOut = fixture(true); await optedOut.start();
  assert.equal(optedOut.f.jobs, 1); assert.deepEqual(optedOut.f.events, []);
  const failing = fixture(); await failing.api.runAutoCut({}, () => { throw Error('Analytics unavailable'); });
  assert.equal(failing.f.jobs, 1); assert.equal(failing.f.results[0].success, true);
});
