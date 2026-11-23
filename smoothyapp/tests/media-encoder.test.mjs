import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const load = async (relative) => {
  const entry = fileURLToPath(new URL(relative, import.meta.url));
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    packages: 'external'
  });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    __dirname: path.dirname(entry),
    process,
    Buffer,
    console,
    setImmediate,
    setTimeout,
    clearTimeout
  });
  return module.exports;
};

const {
  videoCompressor,
  resolveMediaEncoderFeatureId,
  getOutputExtension,
  getCodecTargetForSettings,
  buildVideoScaleFilter,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS
} = await load('../src/main/compressor/video-compressor.ts');

const { getFFmpegPath } = await load('../src/main/ffmpeg-path.ts');
const ffmpegBin = getFFmpegPath();

const runFfmpeg = (args) => {
  execFileSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
};

test('feature tracking IDs, output extensions, and codec targets map accurately', () => {
  assert.equal(resolveMediaEncoderFeatureId(undefined), 'compressor');
  assert.equal(resolveMediaEncoderFeatureId('compress'), 'compressor');
  assert.equal(resolveMediaEncoderFeatureId('convert'), 'media_convert');
  assert.equal(resolveMediaEncoderFeatureId('extract_audio'), 'media_extract_audio');

  assert.equal(getOutputExtension({ mode: 'compress' }), '.mp4');
  assert.equal(getOutputExtension({ mode: 'convert', videoFormat: 'mp4_h264' }), '.mp4');
  assert.equal(getOutputExtension({ mode: 'convert', videoFormat: 'mov_prores' }), '.mov');
  assert.equal(getOutputExtension({ mode: 'convert', videoFormat: 'webm_vp9' }), '.webm');
  assert.equal(getOutputExtension({ mode: 'convert', videoFormat: 'mp4_remux' }), '.mp4');
  assert.equal(getOutputExtension({ mode: 'extract_audio', audioFormat: 'mp3' }), '.mp3');
  assert.equal(getOutputExtension({ mode: 'extract_audio', audioFormat: 'wav' }), '.wav');
  assert.equal(getOutputExtension({ mode: 'extract_audio', audioFormat: 'm4a' }), '.m4a');
  assert.equal(getOutputExtension({ mode: 'extract_audio', audioFormat: 'flac' }), '.flac');

  assert.equal(getCodecTargetForSettings({ mode: 'compress' }), 'hevc');
  assert.equal(getCodecTargetForSettings({ mode: 'convert', videoFormat: 'mp4_h264' }), 'h264');
  assert.equal(getCodecTargetForSettings({ mode: 'convert', videoFormat: 'mp4_hevc' }), 'hevc');
  assert.equal(getCodecTargetForSettings({ mode: 'convert', videoFormat: 'mov_prores' }), 'prores');
  assert.equal(getCodecTargetForSettings({ mode: 'convert', videoFormat: 'webm_vp9' }), 'vp9');
  assert.equal(getCodecTargetForSettings({ mode: 'convert', videoFormat: 'mp4_remux' }), 'remux');
  assert.equal(getCodecTargetForSettings({ mode: 'extract_audio' }), 'audio');
});

test('web feature catalog and groups register all Media Encoder IDs', () => {
  const catalogPath = fileURLToPath(new URL('../../web/src/lib/feature-catalog.ts', import.meta.url));
  const groupsPath = fileURLToPath(new URL('../../web/src/lib/feature-groups.ts', import.meta.url));
  if (!fs.existsSync(catalogPath) || !fs.existsSync(groupsPath)) return; // standalone smoothyapp checkout

  const catalog = fs.readFileSync(catalogPath, 'utf8');
  const groups = fs.readFileSync(groupsPath, 'utf8');
  for (const id of ['compressor', 'media_convert', 'media_extract_audio']) {
    assert.match(catalog, new RegExp(`\\b${id}:`));
    assert.match(groups, new RegExp(`\\b${id}:\\s*"editing"`));
  }
});

test('scale filter preserves orientation, avoids upscaling, and fixes odd dimensions', () => {
  assert.equal(buildVideoScaleFilter(3840, 2160, '1080', true), 'scale=-2:1080');
  assert.equal(buildVideoScaleFilter(2160, 3840, '1080', true), 'scale=1080:-2');
  assert.equal(buildVideoScaleFilter(1280, 720, '1080', true), null);
  assert.equal(buildVideoScaleFilter(641, 361, 'original', true), 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  assert.equal(buildVideoScaleFilter(640, 360, 'original', true), null);
  assert.equal(buildVideoScaleFilter(641, 361, 'original', false), null);
});

test('scanSources supports weird single files, multi-file lists, and mode-aware folder scans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-encoder-scan-'));
  try {
    const webm = path.join(dir, 'clip.webm');
    const flv = path.join(dir, 'old.flv');
    const opus = path.join(dir, 'voice.opus');
    const weird = path.join(dir, 'camera.dav');
    const txt = path.join(dir, 'notes.txt');
    for (const f of [webm, flv, opus, weird, txt]) fs.writeFileSync(f, 'fixture');

    assert.ok(VIDEO_EXTENSIONS.includes('.webm'));
    assert.ok(VIDEO_EXTENSIONS.includes('.flv'));
    assert.ok(VIDEO_EXTENSIONS.includes('.mxf'));
    assert.ok(AUDIO_EXTENSIONS.includes('.opus'));

    // Folder in convert mode picks videos only
    const folderVideo = videoCompressor.scanSources([dir], 'convert');
    assert.equal(folderVideo.sourceType, 'folder');
    assert.deepEqual(Array.from(folderVideo.files.map((f) => f.name)), ['clip.webm', 'old.flv']);
    assert.ok(folderVideo.outputFolder.endsWith(' converted'));

    // Folder in extract_audio mode picks videos + audio files
    const folderAudio = videoCompressor.scanSources([dir], 'extract_audio');
    assert.deepEqual(Array.from(folderAudio.files.map((f) => f.name)), ['clip.webm', 'old.flv', 'voice.opus']);
    assert.ok(folderAudio.outputFolder.endsWith(' audio'));

    // Explicitly selected single file with weird extension is accepted
    const weirdScan = videoCompressor.scanSources([weird], 'convert');
    assert.equal(weirdScan.sourceType, 'file');
    assert.equal(weirdScan.files.length, 1);
    assert.equal(weirdScan.files[0].name, 'camera.dav');

    // Multi-file selection
    const multi = videoCompressor.scanSources([webm, weird], 'extract_audio');
    assert.equal(multi.sourceType, 'files');
    assert.equal(multi.files.length, 2);
    assert.ok(multi.outputFolder.endsWith('Extracted audio'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg: WebM (VP9+Opus) -> MP4 (H.264+AAC), HEVC -> H.264, AV1 -> H.264, and ProRes MOV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-encoder-video-'));
  try {
    const webmIn = path.join(dir, 'sample.webm');
    const hevcIn = path.join(dir, 'clip_hevc.mkv');
    const av1In = path.join(dir, 'clip_av1.mkv');
    const oddIn = path.join(dir, 'odd_size.mp4');

    // Generate 0.6s fixtures
    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
      '-c:a', 'libopus', webmIn
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000:duration=0.6',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
      '-c:a', 'aac', hevcIn
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000:duration=0.5',
      '-c:v', 'libsvtav1', '-preset', '12',
      '-c:a', 'libopus', av1In
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=321x241:rate=24:duration=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-preset', 'ultrafast',
      '-c:a', 'aac', oddIn
    ]);

    // 1. Convert WebM + HEVC + AV1 -> MP4 (H.264) in one batch
    const h264OutDir = path.join(dir, 'out_h264');
    const batch = await videoCompressor.compressBatch(
      [webmIn, hevcIn, av1In].map((p) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size })),
      {
        mode: 'convert',
        videoFormat: 'mp4_h264',
        quality: 'fast',
        encoder: 'auto',
        outputFolder: h264OutDir
      }
    );

    assert.equal(batch.stats.completed, 3);
    assert.equal(batch.stats.failed, 0);
    for (const r of batch.results) {
      assert.equal(r.success, true, r.error);
      assert.ok(r.outputPath.endsWith('.mp4'));
      const info = await videoCompressor.probeFile(r.outputPath);
      assert.equal(info?.videoCodec, 'h264');
      assert.equal(info?.audioCodec, 'aac');
      assert.equal(info?.pixFmt, 'yuv420p');
    }

    // 2. Odd-dimension video + muteAudio -> MP4 (H.264) with even dimensions and no audio
    const oddOutDir = path.join(dir, 'out_odd');
    const oddBatch = await videoCompressor.compressBatch(
      [{ path: oddIn, name: path.basename(oddIn), size: fs.statSync(oddIn).size }],
      {
        mode: 'convert',
        videoFormat: 'mp4_h264',
        quality: 'fast',
        muteAudio: true,
        fps: '30',
        encoder: 'libx264',
        outputFolder: oddOutDir
      }
    );
    assert.equal(oddBatch.results[0].success, true, oddBatch.results[0].error);
    const oddInfo = await videoCompressor.probeFile(oddBatch.results[0].outputPath);
    assert.equal(oddInfo?.width, 320);
    assert.equal(oddInfo?.height, 240);
    assert.equal(oddInfo?.hasAudio, false);

    // 3. Convert WebM -> MOV (ProRes 422)
    const proresOutDir = path.join(dir, 'out_prores');
    const proresBatch = await videoCompressor.compressBatch(
      [{ path: webmIn, name: path.basename(webmIn), size: fs.statSync(webmIn).size }],
      {
        mode: 'convert',
        videoFormat: 'mov_prores',
        quality: 'fast',
        encoder: 'auto',
        outputFolder: proresOutDir
      }
    );
    assert.equal(proresBatch.results[0].success, true, proresBatch.results[0].error);
    assert.ok(proresBatch.results[0].outputPath.endsWith('.mov'));
    const proresInfo = await videoCompressor.probeFile(proresBatch.results[0].outputPath);
    assert.equal(proresInfo?.videoCodec, 'prores');
    assert.equal(proresInfo?.audioCodec, 'pcm_s16le');

    // 4. Convert HEVC MKV -> WebM (VP9 + Opus)
    const webmOutDir = path.join(dir, 'out_webm');
    const webmBatch = await videoCompressor.compressBatch(
      [{ path: hevcIn, name: path.basename(hevcIn), size: fs.statSync(hevcIn).size }],
      {
        mode: 'convert',
        videoFormat: 'webm_vp9',
        quality: 'fast',
        encoder: 'auto',
        outputFolder: webmOutDir
      }
    );
    assert.equal(webmBatch.results[0].success, true, webmBatch.results[0].error);
    assert.ok(webmBatch.results[0].outputPath.endsWith('.webm'));
    const webmInfo = await videoCompressor.probeFile(webmBatch.results[0].outputPath);
    assert.equal(webmInfo?.videoCodec, 'vp9');
    assert.equal(webmInfo?.audioCodec, 'opus');

    // 5. Default Compress mode (HEVC MP4) still works identically
    const compressOutDir = path.join(dir, 'out_compress');
    const compressBatch = await videoCompressor.compressBatch(
      [{ path: webmIn, name: path.basename(webmIn), size: fs.statSync(webmIn).size }],
      {
        mode: 'compress',
        quality: 'fast',
        encoder: 'auto',
        outputFolder: compressOutDir
      }
    );
    assert.equal(compressBatch.results[0].success, true, compressBatch.results[0].error);
    const hevcOut = await videoCompressor.probeFile(compressBatch.results[0].outputPath);
    assert.equal(hevcOut?.videoCodec, 'hevc');
    assert.equal(hevcOut?.audioCodec, 'aac');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real FFmpeg: Extract Audio (MP3, WAV, M4A, FLAC), Remux, and clear validation errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-encoder-audio-'));
  try {
    const mkvH264 = path.join(dir, 'obs_recording.mkv');
    const webmVp9 = path.join(dir, 'browser_clip.webm');
    const silentMp4 = path.join(dir, 'no_audio.mp4');
    const audioOnly = path.join(dir, 'voice.ogg');

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', mkvH264
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
      '-c:a', 'libopus', webmVp9
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-an', silentMp4
    ]);

    runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-c:a', 'libopus', audioOnly
    ]);

    // 1. Extract MP3, WAV, M4A, FLAC from MKV video
    for (const [audioFormat, expectedCodec, expectedExt] of [
      ['mp3', 'mp3', '.mp3'],
      ['wav', 'pcm_s16le', '.wav'],
      ['m4a', 'aac', '.m4a'],
      ['flac', 'flac', '.flac']
    ]) {
      const outDir = path.join(dir, `audio_${audioFormat}`);
      const res = await videoCompressor.compressBatch(
        [{ path: mkvH264, name: path.basename(mkvH264), size: fs.statSync(mkvH264).size }],
        {
          mode: 'extract_audio',
          audioFormat,
          audioBitrate: '192k',
          quality: 'balanced',
          encoder: 'auto',
          outputFolder: outDir
        }
      );
      assert.equal(res.results[0].success, true, res.results[0].error);
      assert.ok(res.results[0].outputPath.endsWith(expectedExt));
      const info = await videoCompressor.probeFile(res.results[0].outputPath);
      assert.equal(info?.hasVideo, false);
      assert.equal(info?.hasAudio, true);
      assert.equal(info?.audioCodec, expectedCodec);
    }

    // 2. Convert audio-only .ogg -> .mp3
    const oggOut = await videoCompressor.compressBatch(
      [{ path: audioOnly, name: path.basename(audioOnly), size: fs.statSync(audioOnly).size }],
      {
        mode: 'extract_audio',
        audioFormat: 'mp3',
        audioBitrate: '320k',
        quality: 'high',
        encoder: 'auto',
        outputFolder: path.join(dir, 'ogg_to_mp3')
      }
    );
    assert.equal(oggOut.results[0].success, true, oggOut.results[0].error);
    assert.equal((await videoCompressor.probeFile(oggOut.results[0].outputPath))?.audioCodec, 'mp3');

    // 3. Remux MKV (H.264 + Opus) -> MP4 (video copied, audio transcoded to AAC)
    const remuxOk = await videoCompressor.compressBatch(
      [{ path: mkvH264, name: path.basename(mkvH264), size: fs.statSync(mkvH264).size }],
      {
        mode: 'convert',
        videoFormat: 'mp4_remux',
        quality: 'high',
        encoder: 'auto',
        outputFolder: path.join(dir, 'remux_ok')
      }
    );
    assert.equal(remuxOk.results[0].success, true, remuxOk.results[0].error);
    const remuxInfo = await videoCompressor.probeFile(remuxOk.results[0].outputPath);
    assert.equal(remuxInfo?.videoCodec, 'h264');
    assert.equal(remuxInfo?.audioCodec, 'aac');

    // 4. Remux VP9 WebM -> MP4 fails clearly without cryptic ffmpeg error
    const remuxBad = await videoCompressor.compressBatch(
      [{ path: webmVp9, name: path.basename(webmVp9), size: fs.statSync(webmVp9).size }],
      {
        mode: 'convert',
        videoFormat: 'mp4_remux',
        quality: 'high',
        encoder: 'auto',
        outputFolder: path.join(dir, 'remux_bad')
      }
    );
    assert.equal(remuxBad.results[0].success, false);
    assert.match(remuxBad.results[0].error || '', /cannot be remuxed into MP4/i);

    // 5. Extract audio from silent video fails clearly
    const silentRes = await videoCompressor.compressBatch(
      [{ path: silentMp4, name: path.basename(silentMp4), size: fs.statSync(silentMp4).size }],
      {
        mode: 'extract_audio',
        audioFormat: 'mp3',
        quality: 'high',
        encoder: 'auto',
        outputFolder: path.join(dir, 'silent_err')
      }
    );
    assert.equal(silentRes.results[0].success, false);
    assert.match(silentRes.results[0].error || '', /no audio track/i);

    // 6. Video convert on audio-only file fails clearly without CPU fallback
    const audioInVideoMode = await videoCompressor.compressBatch(
      [{ path: audioOnly, name: path.basename(audioOnly), size: fs.statSync(audioOnly).size }],
      {
        mode: 'convert',
        videoFormat: 'mp4_h264',
        quality: 'fast',
        encoder: 'auto',
        outputFolder: path.join(dir, 'audio_in_video')
      }
    );
    assert.equal(audioInVideoMode.results[0].success, false);
    assert.equal(audioInVideoMode.fallbackUsed, false);
    assert.match(audioInVideoMode.results[0].error || '', /no video track/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
