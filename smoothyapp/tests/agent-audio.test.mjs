import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const electronStub = `
export const app = { getVersion: () => '3.1.0-test', on() {}, getPath: () => '/tmp' };
export const ipcMain = { handle() {} };
export const clipboard = { writeText() {} };
export const dialog = {};
export const shell = { showItemInFolder() {} };
export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
export class BrowserWindow {}
`;

const websocketStub = `
export const getShortsCutsCatalog = async () => ({ videoEffects: [], audioEffects: [], videoTransitions: [], audioTransitions: [] });
`;

async function bundleCjs(entry) {
  const output = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['sharp'],
    plugins: [{
      name: 'agent-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'agent-stub' }));
        builder.onResolve({ filter: /^\.\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'agent-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'agent-stub' }, args => ({
          contents: args.path === 'electron' ? electronStub : websocketStub,
          loader: 'js'
        }));
      }
    }]
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', output.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
    path.dirname(path.join(root, entry)),
    path.join(root, entry)
  );
  return mod.exports;
}

const { AgentService } = await bundleCjs('src/main/agent/agent-service.ts');
const { LocalAudioService } = await bundleCjs('src/main/local-audio-service.ts');
const {
  summarizeEnvelope,
  classifyAudioQuality,
  compareAudioStats,
  normalizeStrengthPercent
} = await bundleCjs('src/main/agent/audio-cleanup.ts');

const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

test('audio quality classification and before/after comparison are accurate', () => {
  // Noisy speech: pauses around -34 dB, speech around -18 dB
  const noisyBins = [...Array(40).fill(-34), ...Array(60).fill(-18)];
  const noisyEnv = summarizeEnvelope(noisyBins);
  assert.equal(noisyEnv.noiseFloorDb, -34);
  assert.equal(noisyEnv.speechLevelDb, -18);
  assert.equal(noisyEnv.snrDb, 16);

  const noisyDiag = classifyAudioQuality({ ...noisyEnv, lufs: -21, lra: 8, truePeakDb: -2.5, lowEndDb: -25 });
  assert.equal(noisyDiag.verdict, 'very_noisy');
  assert.equal(noisyDiag.needsDenoise, true);
  assert.equal(noisyDiag.recommendedStrength, 1);
  assert.ok(noisyDiag.issues.includes('high_noise_floor'));
  assert.ok(noisyDiag.issues.includes('low_end_rumble'));
  assert.equal(noisyDiag.recommendedVoiceChain, true);

  // Clean speech: pauses around -62 dB, speech around -18 dB
  const cleanBins = [...Array(40).fill(-62), ...Array(60).fill(-18)];
  const cleanEnv = summarizeEnvelope(cleanBins);
  const cleanDiag = classifyAudioQuality({ ...cleanEnv, lufs: -16.5, lra: 6, truePeakDb: -1.8, lowEndDb: -48 });
  assert.equal(cleanDiag.verdict, 'clean');
  assert.equal(cleanDiag.needsDenoise, false);

  const cmp = compareAudioStats(noisyDiag.stats, cleanDiag.stats);
  assert.equal(cmp.verdict, 'improved');
  assert.equal(cmp.delta.noiseReductionDb, 28);
  assert.equal(cmp.delta.speechDeltaDb, 0);
  assert.equal(cmp.delta.snrGainDb, 28);

  // Over-processed detection when speech drops sharply
  const crushed = compareAudioStats(
    { silent: false, noiseFloorDb: -38, speechLevelDb: -18, snrDb: 20, speechRatio: 0.6, lufs: -19, lra: 6, truePeakDb: -2, lowEndDb: -40 },
    { silent: false, noiseFloorDb: -60, speechLevelDb: -25, snrDb: 35, speechRatio: 0.5, lufs: -26, lra: 6, truePeakDb: -8, lowEndDb: -55 }
  );
  assert.equal(crushed.verdict, 'over_processed');

  assert.equal(normalizeStrengthPercent(0.8), 80);
  assert.equal(normalizeStrengthPercent(1), 100);
  assert.equal(normalizeStrengthPercent(75), 75);
  assert.equal(normalizeStrengthPercent(undefined, 90), 90);
});

test('smoothy_audio diagnose, direct denoise, voiceChain, muxVideo, caching and apply work end to end', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-agent-audio-'));
  const audioRoot = path.join(dir, 'audio-engine');
  await fs.mkdir(audioRoot, { recursive: true });
  const noisyWav = path.join(dir, 'noisy.wav');
  const cleanWav = path.join(dir, 'clean.wav');
  const noiseOnlyWav = path.join(dir, 'noise-only.wav');
  const noisyVideo = path.join(dir, 'clip.mp4');

  try {
    // Build real 3-second synthetic audio: speech tone bursts (0.5-1.5s, 2.0-2.8s) + steady pink noise floor
    await execFileAsync(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', "sine=frequency=440:duration=3,volume='if(between(t,0.5,1.5)+between(t,2.0,2.8),0.25,0)':eval=frame",
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', cleanWav
    ]);
    await execFileAsync(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.08:duration=3',
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', noiseOnlyWav
    ]);
    await execFileAsync(ffmpeg, [
      '-y', '-v', 'error',
      '-i', cleanWav, '-i', noiseOnlyWav,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0',
      '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', noisyWav
    ]);
    await execFileAsync(ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x224466:s=320x180:d=3:r=24',
      '-i', noisyWav,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', noisyVideo
    ]);

    const workerCalls = [];
    const tracked = [];
    // Stub only the Python neural worker; ffmpeg runs for real!
    const audioService = new LocalAudioService({
      root: audioRoot,
      ffmpeg,
      track: id => tracked.push(id),
      run: async (command, args, signal, progress) => {
        if (command === ffmpeg) {
          const { stderr, stdout } = await execFileAsync(ffmpeg, args);
          return stdout + stderr;
        }
        workerCalls.push(args);
        const mode = args[1];
        const outDir = args[3];
        const cleanOut = path.join(outDir, 'clean.wav');
        const resOut = path.join(outDir, mode === 'separate' ? 'music.wav' : mode === 'denoise' ? 'noise.wav' : 'background.wav');
        await fs.copyFile(cleanWav, cleanOut);
        await fs.copyFile(noiseOnlyWav, resOut);
        const resKind = mode === 'separate' ? 'music' : mode === 'denoise' ? 'noise' : 'background';
        const items = [
          { label: mode === 'denoise' ? 'Clean audio' : mode === 'separate' ? 'Voice' : 'Clean voice', kind: 'speech', path: cleanOut },
          { label: mode === 'separate' ? 'Music' : mode === 'denoise' ? 'Removed noise' : 'Music & noise', kind: resKind, path: resOut }
        ];
        await fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(items));
        progress({ message: 'Removing background noise…', stage: 'denoise', completed: 4, total: 4, unit: 'windows' });
        return '';
      }
    });

    const values = { 'agent.port': 4855, 'agent.enabled': true };
    const store = {
      get(key, fallback) { return key in values ? values[key] : fallback; },
      set(key, value) { values[key] = value; }
    };
    const service = new AgentService({
      store,
      appVersion: '3.1.0-test',
      userData: dir,
      ffmpeg,
      ffprobe,
      getSequenceInfo: () => null,
      requestSequenceInfo: () => {},
      getActiveNLE: () => null,
      isEditorConnected: () => false,
      addMarkers: async () => ({ success: false }),
      clearMarkers: async () => ({ success: false }),
      audioService,
      trackTool: id => tracked.push(id),
      window: () => null
    });

    // 1. Diagnose works BEFORE the Python engine is set up!
    const diagNoisy = await service.callTool('smoothy_audio', { action: 'diagnose', path: noisyWav }, 'mcp');
    assert.equal(diagNoisy.ok, true, diagNoisy.error?.message);
    assert.equal(diagNoisy.data.needsDenoise, true);
    assert.ok(['noisy', 'very_noisy'].includes(diagNoisy.data.verdict), `Expected noisy verdict, got ${diagNoisy.data.verdict}`);
    assert.ok(diagNoisy.data.stats.noiseFloorDb > -45);
    assert.ok(tracked.includes('agent_audio_diagnose'));

    const diagClean = await service.callTool('smoothy_audio', { action: 'diagnose', path: cleanWav }, 'mcp');
    assert.equal(diagClean.ok, true);
    assert.equal(diagClean.data.verdict, 'clean');
    assert.equal(diagClean.data.needsDenoise, false);

    // 2. Denoise before setup returns E_MODEL_MISSING
    const unready = await service.callTool('smoothy_audio', { action: 'denoise', path: noisyWav }, 'mcp');
    assert.equal(unready.ok, false);
    assert.equal(unready.error.code, 'E_MODEL_MISSING');

    // Mark local audio engine ready
    await fs.writeFile(path.join(audioRoot, 'ready-v2'), JSON.stringify({ version: 2, backend: 'cpu' }));

    // 3. Direct denoise (NO music separation!), with strength 0.85, keepNoise, voiceChain, and before/after metrics
    const denoised = await service.callTool('smoothy_audio', {
      action: 'denoise',
      path: noisyWav,
      strength: 0.85,
      aggression: 7,
      keepNoise: true,
      voiceChain: true
    }, 'mcp');
    assert.equal(denoised.ok, true, denoised.error?.message);
    assert.equal(denoised.data.status, 'done');
    assert.equal(denoised.data.mode, 'denoise');
    assert.equal(denoised.data.strength, 0.85);
    assert.equal(denoised.data.files.length, 2);
    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0][1], 'denoise');
    assert.deepEqual(JSON.parse(workerCalls[0][5]), { aggression: 7 });
    assert.equal(denoised.data.metrics.verdict, 'improved');
    assert.ok(denoised.data.metrics.delta.snrGainDb > 10, `Expected big SNR gain, got ${denoised.data.metrics.delta.snrGainDb}`);
    // Verify no music separation or UI save telemetry was emitted
    assert.equal(tracked.filter(id => id === 'audio_music_separate').length, 0);
    assert.equal(tracked.filter(id => id === 'audio_noise_remove').length, 1);
    assert.equal(tracked.filter(id => id === 'audio_tools_save').length, 0);

    // 4. Repeat call hits cache without running worker again
    const cached = await service.callTool('smoothy_audio', {
      action: 'denoise',
      path: noisyWav,
      strength: 0.85,
      aggression: 7,
      keepNoise: true,
      voiceChain: true
    }, 'mcp');
    assert.equal(cached.ok, true);
    assert.equal(cached.data.cached, true);
    assert.equal(workerCalls.length, 1);

    // 5. Headless project + apply:true + muxVideo:true
    const created = await service.callTool('smoothy_edit', { action: 'new', name: 'Noisy Lesson', fps: 24 }, 'mcp');
    assert.equal(created.ok, true);
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [noisyVideo] }, 'mcp');
    assert.equal(imported.ok, true);
    const videoAssetId = imported.data.assets[0].id;
    const added = await service.callTool('smoothy_edit', {
      action: 'ops',
      ops: [
        { op: 'add', asset: videoAssetId, in: 0, out: 1.5 },
        { op: 'add', asset: videoAssetId, in: 1.5, out: 3.0 }
      ]
    }, 'mcp');
    assert.equal(added.ok, true);

    const applied = await service.callTool('smoothy_audio', {
      action: 'denoise',
      asset: videoAssetId,
      muxVideo: true,
      apply: true
    }, 'mcp');
    assert.equal(applied.ok, true, applied.error?.message);
    assert.equal(applied.data.applied.updatedClips, 2);
    assert.deepEqual(applied.data.applied.tracks, ['A1']);
    assert.equal(applied.data.applied.snapshot, 'v1');
    assert.ok(applied.data.files.some(f => f.kind === 'video'));
    assert.ok(tracked.includes('agent_audio_apply'));

    // Verify the project's A1 clips now point to the cleaned audio asset while V1 keeps the original video
    const shown = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(shown.ok, true);
    assert.ok(shown.data.tracks.A1.every(line => line.includes('-clean.wav')));
    assert.ok(shown.data.tracks.V1.every(line => line.includes('clip.mp4')));

    // 6. Test range slice (from/to) works cleanly
    const sliced = await service.callTool('smoothy_audio', {
      action: 'denoise',
      path: noisyWav,
      from: 0.5,
      to: 2.0
    }, 'mcp');
    assert.equal(sliced.ok, true, sliced.error?.message);
    assert.deepEqual(sliced.data.range, { from: 0.5, to: 2 });

    // 7. Separate and isolate (via enhance alias) work independently
    const sep = await service.callTool('smoothy_audio', { action: 'separate', path: noisyWav }, 'mcp');
    assert.equal(sep.ok, true, sep.error?.message);
    assert.deepEqual(sep.data.files.map(f => f.kind), ['speech', 'music']);

    const iso = await service.callTool('smoothy_audio', { action: 'enhance', path: noisyWav }, 'mcp');
    assert.equal(iso.ok, true, iso.error?.message);
    assert.equal(iso.data.mode, 'isolate');
    assert.equal(iso.data.files[0].kind, 'speech');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
