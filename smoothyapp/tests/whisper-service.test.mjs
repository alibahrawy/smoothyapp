import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const output = await build({ entryPoints: [new URL('../src/main/captions/whisper-service.ts', import.meta.url).pathname], bundle: true,
  format: 'cjs', platform: 'node', packages: 'external', write: false, plugins: [{ name: 'native-fixture', setup(builder) {
    const stubs = {
      './model-manager': `export const ensureModelDownloaded=async()=>globalThis.fixture.model,getModelFilePath=()=>globalThis.fixture.model;`,
      './whisper-bin-manager': `export const ensureBinary=async v=>v,isBinaryInstalled=()=>true,getVariantOrder=()=>[globalThis.fixture.backend],clearBinary=()=>{},setEnginePreference=()=>{},getEnginePreference=()=> 'auto';`,
      child_process: `export const spawn=(...args)=>globalThis.fixture.spawn(...args);`
    };
    builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path] }));
  } }] });

async function fixture({ backend = 'cpu', gpuFail = false, hold = false, malformed = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-whisper-test-'));
  const state = { model: path.join(dir, 'model.bin'), backend, calls: [], kills: 0 };
  fs.writeFileSync(state.model, 'local fixture');
  state.spawn = (binary, args) => {
    state.calls.push({ binary, args });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { state.kills++; setImmediate(() => child.emit('close', null)); };
    if (!hold) setImmediate(() => {
      if (gpuFail && binary !== 'cpu') { child.stderr.emit('data', Buffer.from('GPU unavailable')); child.emit('close', 1); return; }
      const outputPath = args[args.indexOf('-of') + 1] + '.json';
      fs.writeFileSync(outputPath, malformed ? '{broken' : JSON.stringify({ result: { language: 'ar' }, transcription: [
        { text: ' أعزائي المشاهدين فيديو جديد', offsets: { from: 0, to: 1800 } },
        { text: ' هنا على قناة من غير مونتاج', offsets: { from: 1800, to: 4200 } }
      ] }));
      child.emit('close', 0);
    });
    return child;
  };
  const module = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url),
    fixture: state, process, console: { log() {}, warn() {} }, AbortController });
  const api = module.exports; await api.loadModel('ggml-base.bin');
  return { state, api, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Arabic words are preserved and CLI splits on words rather than subword tokens', async () => {
  const f = await fixture(); try {
    const result = await f.api.transcribe('/fixture.wav', undefined, 'ggml-base.bin', 'ar');
    assert.equal(result.text, 'أعزائي المشاهدين فيديو جديد هنا على قناة من غير مونتاج');
    assert.equal(result.language, 'ar');
    assert.ok(f.state.calls[0].args.includes('-sow'));
    assert.equal(f.state.calls[0].args[f.state.calls[0].args.indexOf('-mc') + 1], '0');
    assert.equal(f.state.calls[0].args[f.state.calls[0].args.indexOf('-l') + 1], 'ar');
    assert.ok(!f.state.calls[0].args.includes('-tr'));
    assert.ok(result.chunks.every((chunk, i) => chunk.timestamp[1] > chunk.timestamp[0] && (!i || chunk.timestamp[0] >= result.chunks[i - 1].timestamp[1])));
    assert.ok(!fs.existsSync(f.state.calls[0].args[f.state.calls[0].args.indexOf('-of') + 1] + '.json'));
  } finally { f.close(); }
});

test('omitted language defaults to auto-detect while explicit English is retained', async () => {
  const f = await fixture(); try {
    for (const language of [undefined, '  ', 'en']) await f.api.transcribe('/fixture.wav', undefined, 'ggml-base.bin', language);
    assert.deepEqual(f.state.calls.map(call => call.args[call.args.indexOf('-l') + 1]), ['auto', 'auto', 'en']);
  } finally { f.close(); }
});

test('GPU retry retains Arabic word splitting and language', async () => {
  const f = await fixture({ backend: 'metal', gpuFail: true }); try {
    const result = await f.api.transcribe('/fixture.wav', undefined, 'ggml-base.bin', 'ar');
    assert.ok(result.text.includes('جديد')); assert.equal(f.state.calls.length, 2);
    for (const { args } of f.state.calls) { assert.ok(args.includes('-sow')); assert.equal(args[args.indexOf('-mc') + 1], '0'); assert.equal(args[args.indexOf('-l') + 1], 'ar'); }
    assert.ok(f.state.calls[1].args.includes('-ng'));
  } finally { f.close(); }
});

test('cancellation kills native work without a CPU retry or completed response', async () => {
  const f = await fixture({ backend: 'metal', hold: true }); try {
    const controller = new AbortController();
    const job = f.api.transcribe('/fixture.wav', undefined, 'ggml-base.bin', 'ar', controller.signal);
    controller.abort(); await assert.rejects(job, /TRANSCRIPTION_CANCELLED/);
    assert.equal(f.state.kills, 1); assert.equal(f.state.calls.length, 1); assert.equal(f.api.isTranscribing(), false);
  } finally { f.close(); }
});

test('malformed native output fails cleanly instead of producing captions', async () => {
  const f = await fixture({ malformed: true }); try {
    await assert.rejects(f.api.transcribe('/fixture.wav'), /Could not parse/);
    assert.equal(f.api.isTranscribing(), false);
  } finally { f.close(); }
});
