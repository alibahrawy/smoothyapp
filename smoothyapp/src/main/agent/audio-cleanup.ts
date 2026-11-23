/**
 * Agentic audio cleanup helpers:
 * - Acoustic diagnosis (noise floor, speech level, SNR, LUFS, true peak, low-end rumble)
 *   so an AI agent that cannot hear knows whether audio is noisy and whether denoising worked.
 * - Optional broadcast voice chain (highpass + compressor + loudnorm to -16 LUFS).
 * - Lossless video remuxing (-c:v copy) with cleaned audio, never modifying the original.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { computeEnvelope, parseEbur128 } from './analysis';
import { runEngine } from './engine';

export const VOICE_CHAIN_FILTER =
  'highpass=f=80,acompressor=threshold=-22dB:ratio=2.5:attack=8:release=150:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9';

export type AudioStats = {
  silent: boolean;
  noiseFloorDb: number;
  speechLevelDb: number;
  snrDb: number;
  speechRatio: number;
  lufs: number | null;
  lra: number | null;
  truePeakDb: number | null;
  lowEndDb: number | null;
};

export type AudioDiagnosis = {
  verdict: 'silent' | 'clean' | 'mild_noise' | 'noisy' | 'very_noisy';
  needsDenoise: boolean;
  issues: string[];
  recommendedStrength: number;
  recommendedVoiceChain: boolean;
  summary: string;
  stats: AudioStats;
};

export type AudioComparison = {
  before: AudioStats;
  after: AudioStats;
  delta: {
    noiseReductionDb: number;
    speechDeltaDb: number;
    snrGainDb: number;
    lufsDelta: number | null;
  };
  verdict: 'improved' | 'over_processed' | 'minimal_change';
  note: string;
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -120;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Summarizes 10 ms RMS dB bins into noise floor, speech level, and SNR.
 * Speech level is measured over active bins (> -65 dB); noise floor is the median
 * of pause bins (< speech - 14 dB) including digitally quiet pauses (clamped at
 * -85 dB so studio/denoised silence reads as clean rather than being dropped).
 */
export function summarizeEnvelope(bins: number[]): Pick<AudioStats, 'silent' | 'noiseFloorDb' | 'speechLevelDb' | 'snrDb' | 'speechRatio'> {
  const finite = bins.filter(db => Number.isFinite(db));
  const active = finite.filter(db => db > -65).sort((a, b) => a - b);
  if (active.length < 5) {
    return { silent: true, noiseFloorDb: -120, speechLevelDb: -120, snrDb: 0, speechRatio: 0 };
  }
  const speechLevelDb = Number(percentile(active, 0.85).toFixed(1));
  const pauseCutoff = speechLevelDb - 14;
  const pauses = finite.filter(db => db < pauseCutoff).sort((a, b) => a - b);
  const sortedAll = [...finite].sort((a, b) => a - b);
  const rawFloor = pauses.length >= Math.max(5, Math.floor(finite.length * 0.05))
    ? percentile(pauses, 0.5)
    : percentile(sortedAll, 0.1);
  const noiseFloorDb = Number(Math.max(-85, rawFloor).toFixed(1));
  const snrDb = Number(Math.max(0, speechLevelDb - noiseFloorDb).toFixed(1));
  const speechBins = finite.filter(db => db >= speechLevelDb - 18).length;
  const speechRatio = Number((speechBins / Math.max(1, finite.length)).toFixed(2));
  return { silent: false, noiseFloorDb, speechLevelDb, snrDb, speechRatio };
}

/** Classifies acoustic quality and gives the agent concrete next parameters. */
export function classifyAudioQuality(stats: AudioStats): AudioDiagnosis {
  if (stats.silent || stats.speechLevelDb < -65) {
    return {
      verdict: 'silent',
      needsDenoise: false,
      issues: ['silent_or_very_quiet'],
      recommendedStrength: 0,
      recommendedVoiceChain: false,
      summary: 'Audio is silent or nearly inaudible; check the input track or time range.',
      stats
    };
  }
  const issues: string[] = [];
  if (stats.noiseFloorDb > -42 || stats.snrDb < 20) issues.push('high_noise_floor');
  else if (stats.noiseFloorDb > -52 || stats.snrDb < 30) issues.push('noticeable_noise_floor');
  if (stats.snrDb < 22) issues.push('low_snr');
  if (stats.lowEndDb !== null && stats.lowEndDb > stats.speechLevelDb - 12 && stats.lowEndDb > -45) issues.push('low_end_rumble');
  if (stats.truePeakDb !== null && stats.truePeakDb > -0.5) issues.push('clipping_risk');
  if (stats.lufs !== null && stats.lufs < -24) issues.push('quiet_dialogue');
  if (stats.lufs !== null && stats.lufs > -11) issues.push('loud_dialogue');

  let verdict: AudioDiagnosis['verdict'] = 'clean';
  if (stats.noiseFloorDb > -35 || stats.snrDb < 15) verdict = 'very_noisy';
  else if (stats.noiseFloorDb > -45 || stats.snrDb < 24) verdict = 'noisy';
  else if (stats.noiseFloorDb > -54 || stats.snrDb < 32) verdict = 'mild_noise';

  const needsDenoise = verdict !== 'clean';
  const recommendedStrength =
    verdict === 'very_noisy' ? 1 : verdict === 'noisy' ? 0.9 : verdict === 'mild_noise' ? 0.75 : 0;
  const recommendedVoiceChain =
    issues.includes('low_end_rumble') ||
    issues.includes('quiet_dialogue') ||
    issues.includes('loud_dialogue') ||
    (stats.lra !== null && stats.lra > 12);

  const lufsText = stats.lufs !== null ? `, ${stats.lufs} LUFS` : '';
  const summary = !needsDenoise
    ? `Audio is clean (noise floor ${stats.noiseFloorDb} dB, SNR ${stats.snrDb} dB${lufsText}). Skip denoising unless you hear specific background music.`
    : `${verdict.replace('_', ' ')} audio (noise floor ${stats.noiseFloorDb} dB, speech ${stats.speechLevelDb} dB, SNR ${stats.snrDb} dB${lufsText}). Run smoothy_audio action "denoise" with strength ${recommendedStrength}${recommendedVoiceChain ? ' and voiceChain:true' : ''}.`;

  return { verdict, needsDenoise, issues, recommendedStrength, recommendedVoiceChain, summary, stats };
}

/** Compares before and after audio stats so the agent can verify noise removal objectively. */
export function compareAudioStats(before: AudioStats, after: AudioStats): AudioComparison {
  const noiseReductionDb = Number((before.noiseFloorDb - after.noiseFloorDb).toFixed(1));
  const speechDeltaDb = Number((after.speechLevelDb - before.speechLevelDb).toFixed(1));
  const snrGainDb = Number((after.snrDb - before.snrDb).toFixed(1));
  const lufsDelta =
    before.lufs !== null && after.lufs !== null ? Number((after.lufs - before.lufs).toFixed(1)) : null;

  let verdict: AudioComparison['verdict'] = 'minimal_change';
  let note = 'Little measurable change in the noise floor. Audio may already be clean, or background sound may be music/chatter (try action "isolate" or higher aggression).';
  if (speechDeltaDb < -4.5 && (before.lufs === null || after.lufs === null || Math.abs(after.lufs - before.lufs) > 4)) {
    verdict = 'over_processed';
    note = `Speech level dropped by ${Math.abs(speechDeltaDb)} dB. Retry with lower strength (for example 0.7) to keep the voice fuller.`;
  } else if (noiseReductionDb >= 3 || snrGainDb >= 3) {
    verdict = 'improved';
    note = noiseReductionDb >= 3
      ? `Noise floor dropped by ${noiseReductionDb} dB (SNR ${before.snrDb} → ${after.snrDb} dB, speech Δ ${speechDeltaDb >= 0 ? '+' : ''}${speechDeltaDb} dB).`
      : `SNR improved by +${snrGainDb} dB (${before.snrDb} → ${after.snrDb} dB; loudness Δ ${lufsDelta !== null ? `${lufsDelta >= 0 ? '+' : ''}${lufsDelta} LUFS` : 'adjusted'}).`;
  }

  return { before, after, delta: { noiseReductionDb, speechDeltaDb, snrGainDb, lufsDelta }, verdict, note };
}

/** Parses Overall RMS level dB from ffmpeg astats output. */
export function parseOverallRmsDb(stderr: string): number | null {
  const overall = stderr.slice(stderr.lastIndexOf('Overall'));
  const match = overall.match(/RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)/i);
  if (!match) return null;
  if (match[1].toLowerCase() === '-inf') return -120;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

/** Measures envelope + ebur128 loudness + sub-100Hz rumble on a media file or range. */
export async function measureAudioStats(
  ffmpeg: string,
  file: string,
  options: { from?: number; duration?: number; channels?: number; signal?: AbortSignal } = {}
): Promise<AudioStats> {
  const from = Math.max(0, Number(options.from) || 0);
  const duration = options.duration && options.duration > 0 ? options.duration : undefined;
  const trim: string[] = [];
  if (from > 0) trim.push('-ss', String(from));
  if (duration) trim.push('-t', String(duration));

  const [bins, loudRun, rumbleRun] = await Promise.all([
    computeEnvelope(ffmpeg, file, { from, duration, binMs: 10, channels: options.channels || 2, signal: options.signal }),
    runEngine(
      ffmpeg,
      'ffmpeg',
      ['-nostdin', '-hide_banner', ...trim, '-i', file, '-vn', '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
      { cwd: os.tmpdir(), signal: options.signal, timeoutMs: 300_000, tailLines: 200 }
    ),
    runEngine(
      ffmpeg,
      'ffmpeg',
      ['-nostdin', '-hide_banner', ...trim, '-i', file, '-vn', '-map', '0:a:0', '-af', 'lowpass=f=100,astats=metadata=0:reset=0', '-f', 'null', '-'],
      { cwd: os.tmpdir(), signal: options.signal, timeoutMs: 300_000, tailLines: 200 }
    ).catch(() => ({ exitCode: 1, stderrTail: [] as string[] }))
  ]);

  const env = summarizeEnvelope(bins);
  const loud = loudRun.exitCode === 0 ? parseEbur128(loudRun.stderrTail.join('\n')) : { lufs: null, lra: null, truePeak: null };
  const lowEndDb = rumbleRun.exitCode === 0 ? parseOverallRmsDb(rumbleRun.stderrTail.join('\n')) : null;
  return {
    ...env,
    lufs: loud.lufs,
    lra: loud.lra,
    truePeakDb: loud.truePeak,
    lowEndDb
  };
}

/** Applies broadcast voice polish (high-pass 80 Hz, light compression, -16 LUFS loudnorm) to a WAV. */
export async function applyVoiceChain(
  ffmpeg: string,
  inputWav: string,
  outputWav: string,
  signal?: AbortSignal
): Promise<void> {
  const tmp = path.join(path.dirname(outputWav), `.smoothy-vc-${randomUUID()}.tmp.wav`);
  try {
    const res = await runEngine(
      ffmpeg,
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', inputWav, '-af', VOICE_CHAIN_FILTER, '-ar', '48000', '-c:a', 'pcm_s16le', tmp],
      { cwd: path.dirname(outputWav), signal, timeoutMs: 600_000, tailLines: 60 }
    );
    if (res.exitCode !== 0) throw new Error(`Voice chain failed: ${res.stderrTail.join('\n').slice(-400)}`);
    await fs.rename(tmp, outputWav);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Losslessly copies the source video stream with the cleaned audio track into a new file. */
export async function muxCleanedVideo(
  ffmpeg: string,
  sourceVideo: string,
  cleanedAudio: string,
  outputVideo: string,
  signal?: AbortSignal
): Promise<void> {
  const ext = path.extname(outputVideo) || '.mp4';
  const tmp = path.join(path.dirname(outputVideo), `.smoothy-mux-${randomUUID()}.tmp${ext}`);
  try {
    const res = await runEngine(
      ffmpeg,
      'ffmpeg',
      [
        '-nostdin', '-hide_banner', '-v', 'error', '-y',
        '-i', sourceVideo, '-i', cleanedAudio,
        '-map', '0:v', '-map', '1:a:0', '-map_metadata', '0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart',
        tmp
      ],
      { cwd: path.dirname(outputVideo), signal, timeoutMs: 600_000, tailLines: 60 }
    );
    if (res.exitCode !== 0) throw new Error(`Video mux failed: ${res.stderrTail.join('\n').slice(-400)}`);
    await fs.rename(tmp, outputVideo);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Normalizes a strength input (0..1 or 0..100) into an integer percentage 0..100. */
export function normalizeStrengthPercent(raw: unknown, fallback = 100): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n >= 0 && n <= 1) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}
