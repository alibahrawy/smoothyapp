import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

async function load(entry) {
  const output = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['sharp'],
    plugins: [{
      name: 'stubs',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        builder.onResolve({ filter: /^\.\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: args.path === 'electron'
            ? `export const app={getVersion:()=>'t',on(){},getPath:()=>'/tmp'};export const ipcMain={handle(){}};export const clipboard={writeText(){}};export const dialog={};export const shell={};export const protocol={registerSchemesAsPrivileged(){},handle(){}};export class BrowserWindow{}`
            : `export const getShortsCutsCatalog=async()=>({videoEffects:[],audioEffects:[],videoTransitions:[],audioTransitions:[]});`,
          loader: 'js'
        }));
      }
    }]
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', output.outputFiles[0].text)(module, module.exports, require, path.join(root, path.dirname(entry)), path.join(root, entry));
  return module.exports;
}

const analysis = await load('src/main/agent/analysis.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

test('DTW tokens become words in source seconds with fillers flagged', () => {
  const json = {
    transcription: [{
      tokens: [
        { text: '[_BEG_]', t_dtw: 0, p: 1 },
        { text: ' Um', t_dtw: 100, p: 0.9 },
        { text: ',', t_dtw: 120, p: 0.95 },
        { text: ' the', t_dtw: 160, p: 0.99 },
        { text: ' walk', t_dtw: 190, p: 0.8 },
        { text: '-in', t_dtw: 210, p: 0.6 },
        { text: ' tub', t_dtw: 280, p: 0.97 },
        { text: '.', t_dtw: 300, p: 0.99 },
        { text: ' ...', t_dtw: 310, p: 0.5 },
        { text: ' skipped', t_dtw: -1, p: 0.5 }
      ]
    }]
  };
  const words = analysis.wordsFromDtw(json, 840, -0.15);
  assert.deepEqual(words.map(word => word.w), ['Um,', 'the', 'walk-in', 'tub.']);
  assert.equal(words[0].a, 840.85);
  assert.equal(words[0].filler, true);
  assert.equal(words[1].filler, undefined);
  assert.equal(words[2].p, 0.6, 'a word keeps its lowest token probability');
  assert.equal(words[2].b, words[3].a, 'a word ends at the next onset');
  assert.equal(words[3].b, Number((words[3].a + 0.4).toFixed(3)), 'the last word gets 0.4 s');
  const long = analysis.wordsFromDtw({ transcription: [{ tokens: [{ text: ' so', t_dtw: 0 }, { text: ' then', t_dtw: 500 }] }] }, 0, 0);
  assert.equal(long[0].b, 1.2, 'word length is capped at 1.2 s');

  const lines = analysis.readableTranscript([
    ...Array.from({ length: 8 }, (_, i) => ({ w: i === 7 ? 'end.' : `w${i}`, a: i * 0.3, b: i * 0.3 + 0.25, p: 1 })),
    { w: 'after', a: 5, b: 5.3, p: 1 },
    { w: 'pause', a: 6.5, b: 6.8, p: 1 }
  ]);
  assert.deepEqual(lines, ['[00:00:00.00] w0 w1 w2 w3 w4 w5 w6 end.', '[00:00:05.00] after', '[00:00:06.50] pause']);
});

test('silence map, ebur128 summary and scene cut parsing', () => {
  const db = [-30, -30, -60, -60, -60, -30, -70, -30];
  assert.deepEqual(analysis.silenceMap(db, 0.1, -50, 0.25, 10), [{ start: 10.2, end: 10.5 }]);
  assert.deepEqual(analysis.silenceMap(db, 0.1, -50, 0.05, 0).length, 2);

  const summary = `[Parsed_ebur128_0 @ 0x1] Summary:
  Integrated loudness:
    I:         -16.3 LUFS
    Threshold: -26.5 LUFS
  Loudness range:
    LRA:         5.1 LU
    Threshold: -36.4 LUFS
  True peak:
    Peak:       -1.4 dBFS`;
  assert.deepEqual(analysis.parseEbur128(summary), { integrated: -16.3, threshold: -26.5, lra: 5.1, truePeak: -1.4 });

  const scenes = 'frame:0    pts:12  pts_time:0.5\nlavfi.scene_score=0.61\nframe:1 pts:13 pts_time:0.7\nlavfi.scene_score=0.40\nframe:2 pts:40 pts_time:3.25\nlavfi.scene_score=0.9\n';
  assert.deepEqual(analysis.parseSceneCuts(scenes, 100, 0.5), [{ t: 100.5, score: 0.61 }, { t: 103.25, score: 0.9 }]);
  assert.equal(analysis.modelFileId('small.en'), 'ggml-small.en.bin');
  assert.equal(analysis.modelFileId('ggml-medium.en.bin'), 'ggml-medium.en.bin');
});

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-analyze-')));
  const wav = path.join(dir, 'speech.wav');
  // 1 s tone, 1 s silence, 1 s tone.
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3:sample_rate=48000:samples_per_frame=480', '-af', "volume=enable='between(t,1,2)':volume=0", '-ar', '48000', '-ac', '1', wav]);
  const video = path.join(dir, 'shots.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1:r=25[a];color=c=blue:s=160x120:d=1:r=25[b];[a][b]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video]);
  return { dir, wav, video };
}

function service(userData, options = {}) {
  const tracked = [];
  const store = {
    values: { 'agent.port': 4840, 'agent.enabled': true, ...(options.store || {}) },
    get(key, fallback) { return key in this.values ? this.values[key] : fallback; },
    set(key, value) { this.values[key] = value; }
  };
  const svc = new AgentService({
    store,
    appVersion: '3.1.0-test',
    userData,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => null,
    requestSequenceInfo: () => {},
    getActiveNLE: () => null,
    isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }),
    clearMarkers: async () => ({ success: false }),
    window: () => null,
    trackTool: id => tracked.push(id),
    engines: { whisper: options.whisper || (() => null), installer: options.installer || null }
  });
  return { svc, tracked };
}

test('envelope, loudness and scene cuts run as cached jobs and write files', async () => {
  const { dir, wav, video } = await fixture();
  const { svc, tracked } = service(dir);
  try {
    const env = await svc.callTool('smoothy_analyze', { action: 'envelope', path: wav, thresholdDb: -50, minSilence: 0.3 }, 'mcp');
    assert.equal(env.ok, true, JSON.stringify(env));
    assert.equal(env.data.bins, 300);
    assert.equal(env.data.silenceCount, 1);
    assert.ok(Math.abs(env.data.silences[0].start - 1) <= 0.02 && Math.abs(env.data.silences[0].end - 2) <= 0.02, JSON.stringify(env.data.silences));
    assert.ok(Math.abs(env.data.speechLevelDb.median - -21.1) < 0.3, String(env.data.speechLevelDb.median)); // lavfi sine is 1/8 amplitude: 20·log10(0.125/√2)
    const saved = JSON.parse(await fs.readFile(env.data.files.envelope, 'utf8'));
    assert.equal(saved.db.length, 300);
    assert.ok(env.data.files.envelope.startsWith(path.join(dir, 'agent', 'analysis', 'audio')));

    const again = await svc.callTool('smoothy_analyze', { action: 'envelope', path: wav, thresholdDb: -40, minSilence: 0.5, from: 0 }, 'mcp');
    assert.equal(again.data.cached, true, 'a new threshold reuses the cached envelope');
    assert.equal(again.data.silenceCount, 1);

    const ranged = await svc.callTool('smoothy_analyze', { action: 'envelope', path: wav, from: 1.5, to: 3 }, 'mcp');
    assert.equal(ranged.data.bins, 150);
    assert.ok(Math.abs(ranged.data.silences[0].start - 1.5) < 0.02, 'silences are in source seconds');

    // Identical stereo channels must read like the mono file, not 3 dB hot from a -ac 1 downmix.
    const stereo = path.join(dir, 'stereo.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-i', wav, '-af', 'pan=stereo|c0=c0|c1=c0', stereo]);
    const env2 = await svc.callTool('smoothy_analyze', { action: 'envelope', path: stereo }, 'mcp');
    assert.ok(Math.abs(env2.data.speechLevelDb.median - env.data.speechLevelDb.median) < 0.1, `${env2.data.speechLevelDb.median} vs ${env.data.speechLevelDb.median}`);

    const loud = await svc.callTool('smoothy_analyze', { action: 'loudness', path: wav, ranges: [{ from: 0, to: 1 }, { from: 2, to: 3 }] }, 'mcp');
    assert.equal(loud.ok, true, JSON.stringify(loud));
    assert.equal(loud.data.ranges.length, 2);
    for (const row of loud.data.ranges) {
      assert.equal(typeof row.integrated, 'number');
      assert.equal(typeof row.truePeak, 'number');
    }
    const loudAgain = await svc.callTool('smoothy_analyze', { action: 'loudness', path: wav, ranges: [{ from: 0, to: 1 }, { from: 2, to: 3 }] }, 'mcp');
    assert.equal(loudAgain.data.cached, true);

    const scenes = await svc.callTool('smoothy_analyze', { action: 'scene_cuts', path: video }, 'mcp');
    assert.equal(scenes.ok, true, JSON.stringify(scenes));
    assert.equal(scenes.data.count, 1);
    assert.ok(Math.abs(scenes.data.cuts[0].t - 1) < 0.05);

    const missing = await svc.callTool('smoothy_analyze', { action: 'transcribe_words', path: wav }, 'mcp');
    assert.equal(missing.error.code, 'E_MODEL_MISSING');
    const outside = await svc.callTool('smoothy_analyze', { action: 'envelope', path: '/etc/hosts' }, 'mcp');
    assert.equal(outside.ok, false);

    assert.deepEqual(tracked.filter(id => id.startsWith('agent_analyze_')), ['agent_analyze_envelope', 'agent_analyze_envelope', 'agent_analyze_envelope', 'agent_analyze_envelope', 'agent_analyze_loudness', 'agent_analyze_loudness', 'agent_analyze_scenes']);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribe_words drives whisper-cli with DTW and the filler prompt, then caches', { skip: process.platform === 'win32' }, async () => {
  const { dir, wav } = await fixture();
  const models = path.join(dir, 'whisper-models');
  await fs.mkdir(models);
  await fs.writeFile(path.join(models, 'ggml-small.en.bin'), 'x');
  const argsFile = path.join(dir, 'whisper-args.txt');
  const fake = path.join(dir, 'whisper-cli');
  // A stand-in whisper-cli: records its arguments and writes DTW JSON to <-of>.json.
  await fs.writeFile(fake, `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
prev=""; out=""
for a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done
echo "whisper_print_progress_callback: progress = 50%" 1>&2
cat > "$out.json" <<'JSON'
{"transcription":[{"tokens":[{"text":" Um","t_dtw":20,"p":0.9},{"text":" hello","t_dtw":60,"p":0.95},{"text":" there.","t_dtw":220,"p":0.9}]}]}
JSON
exit 0
`, { mode: 0o755 });
  const whisper = () => ({ path: fake, variant: 'metal', modelsDir: models, models: [{ id: 'ggml-small.en.bin', path: path.join(models, 'ggml-small.en.bin'), englishOnly: true, bytes: 1 }] });
  const { svc, tracked } = service(dir, { whisper });
  try {
    const result = await svc.callTool('smoothy_analyze', { action: 'transcribe_words', path: wav, from: 1, to: 3, terms: ['Re-Bath', 'P-trap'] }, 'mcp');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.words, 3);
    assert.equal(result.data.fillers, 1);
    const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
    const after = flag => args[args.indexOf(flag) + 1];
    assert.ok(args.includes('-nfa') && args.includes('-ojf') && args.includes('-pp'));
    assert.equal(after('-dtw'), 'small.en');
    assert.equal(after('-l'), 'en');
    assert.equal(after('--prompt'), 'Um, uh, so, like, you know. I mean, uh, okay. Re-Bath, P-trap.');
    const saved = JSON.parse(await fs.readFile(result.data.files.words, 'utf8'));
    assert.deepEqual(saved.words.map(word => [word.w, word.a]), [['Um', 1.05], ['hello', 1.45], ['there.', 3.05]]);
    assert.equal(saved.words[0].filler, true);
    assert.match(await fs.readFile(result.data.files.readable, 'utf8'), /^\[00:00:01\.05\] Um hello/);

    await fs.rm(argsFile);
    const again = await svc.callTool('smoothy_analyze', { action: 'transcribe_words', path: wav, from: 1, to: 3, terms: ['Re-Bath', 'P-trap'] }, 'mcp');
    assert.equal(again.data.cached, true);
    await assert.rejects(fs.access(argsFile), 'a cached transcript does not run whisper again');

    const other = await svc.callTool('smoothy_analyze', { action: 'transcribe_words', path: wav, model: 'medium.en' }, 'mcp');
    assert.equal(other.error.code, 'E_MODEL_MISSING');
    assert.match(other.error.next, /install_model/);
    assert.equal(tracked.filter(id => id === 'agent_analyze_words').length, 2);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('install_model asks first, then downloads as a job', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-install-')));
  const installed = new Set();
  const calls = [];
  const installer = {
    catalog: () => [{ id: 'ggml-small.en.bin', name: 'Small (English)', size: '466 MB', downloaded: installed.has('ggml-small.en.bin') }],
    ensureBinary: async () => { calls.push('binary'); return '/fake/whisper'; },
    ensureModel: async (id, _signal, progress) => { progress(50, 'Downloading'); installed.add(id); calls.push(id); return path.join(dir, id); }
  };
  const { svc } = service(dir, { installer, whisper: () => ({ path: '/fake/whisper', modelsDir: dir, models: [] }), store: { 'agent.autoApprove': true } });
  try {
    const listed = await svc.callTool('smoothy_analyze', { action: 'models' }, 'mcp');
    assert.equal(listed.data.catalog[0].id, 'small.en');
    const started = await svc.callTool('smoothy_analyze', { action: 'install_model', model: 'small.en' }, 'mcp');
    assert.ok(started.data.jobId);
    const waited = await svc.callTool('smoothy_jobs', { action: 'wait', id: started.data.jobId, timeoutMs: 5000 }, 'mcp');
    assert.equal(waited.data.job.status, 'done');
    assert.equal(waited.data.job.result.dtwPreset, 'small.en');
    assert.deepEqual(calls, ['ggml-small.en.bin'], 'whisper-cli already present, so only the model downloads');
    const again = await svc.callTool('smoothy_analyze', { action: 'install_model', model: 'small.en' }, 'mcp');
    assert.equal(again.data.alreadyInstalled, true);
    const unknown = await svc.callTool('smoothy_analyze', { action: 'install_model', model: 'gigantic' }, 'mcp');
    assert.equal(unknown.error.code, 'E_NOT_FOUND');
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
