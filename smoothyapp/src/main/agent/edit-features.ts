/**
 * Smoothy features as headless-edit tools: analysis, silence cut, multicam,
 * speech captions and the music/stock library. These are the same engines the
 * app UI uses (bundled ffmpeg, the energy VAD and shot decision engine, whisper,
 * the audio archive and stock sources), exposed through short agent actions.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateShotDecisions, type ShotDecision } from '../autocut/decision-engine';
import { runVad } from '../autocut/vad-runner';
import { EditOpError, applyOps, clipEnd, projectDuration, snap, type EditAsset, type EditProject } from './edit-project';
import { planRender, runFfmpeg } from './edit-render';

const exec = promisify(execFile);

export type SpeechService = {
  isReady(): boolean;
  describe(): string;
  prepare(onProgress: (percent: number, message: string) => void, signal: AbortSignal): Promise<void>;
  transcribe(wav: string, language: string | undefined, signal: AbortSignal, onProgress: (percent: number, message: string) => void): Promise<{ chunks: { text: string; timestamp: [number, number] }[]; language: string }>;
  format(result: { text: string; chunks: { text: string; timestamp: [number, number] }[]; language: string }, settings: Record<string, number>): { startTime: number; endTime: number; text: string }[];
};

export type MusicHit = { id: string; title: string; artist?: string; genre?: string; mood?: string; duration?: number };
export type StockHit = { ref: string; title: string; provider?: string; duration?: number; width?: number; height?: number; license?: string };
export type FetchedAsset = { path: string; title: string; license?: string; credit?: string; url?: string; provider?: string };

export type LibraryService = {
  musicSearch(input: { query?: string; mood?: string; genre?: string; limit: number }): Promise<MusicHit[]>;
  musicFetch(id: string, signal: AbortSignal, progress: (percent: number, message: string) => void): Promise<FetchedAsset>;
  stockSearch(input: { query: string; provider?: string; orientation?: string; limit: number }, signal: AbortSignal): Promise<StockHit[]>;
  stockFetch(ref: string, signal: AbortSignal, progress: (percent: number, message: string) => void): Promise<FetchedAsset>;
};

// ---- analysis ---------------------------------------------------------------

export async function renderAudioMix(project: EditProject, ffmpeg: string, workDir: string, options: { from?: number; to?: number; tracks?: string[]; tag: string }, signal?: AbortSignal): Promise<{ wav: string; duration: number }> {
  const wav = path.join(workDir, `mix-${options.tag}.wav`);
  const plan = await planRender(project, { workDir, from: options.from, to: options.to, mode: 'audio', audioTracks: options.tracks, output: wav, tag: options.tag });
  if (plan.empty || plan.duration <= 0) throw new EditOpError('There is no audio in that range.');
  await runFfmpeg(ffmpeg, plan.args, { signal });
  return { wav, duration: plan.duration };
}

export type Silence = { start: number; end: number };

export function parseAnalysis(stderr: string): { silences: Silence[]; loudness: { integrated: number | null; range: number | null; peak: number | null } } {
  const silences: Silence[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) open = Math.max(0, Number(start[1]));
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && open !== null) {
      silences.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const pick = (re: RegExp): number | null => {
    const match = re.exec(summary);
    return match ? Number(match[1]) : null;
  };
  return {
    silences,
    loudness: { integrated: pick(/I:\s+(-?[\d.]+)\s+LUFS/), range: pick(/LRA:\s+(-?[\d.]+)\s+LU/), peak: pick(/Peak:\s+(-?[\d.]+)\s+dBFS/) }
  };
}

export async function analyzeWav(ffmpeg: string, wav: string, options: { thresholdDb: number; minSilence: number }): Promise<ReturnType<typeof parseAnalysis>> {
  const { stderr } = await exec(ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=n=${options.thresholdDb}dB:d=${options.minSilence},ebur128=peak=true`, '-f', 'null', '-'], { maxBuffer: 32 * 1024 * 1024 });
  return parseAnalysis(stderr);
}

/** Shrinks each silence by `padding` so speech keeps a natural breath on both sides. */
export function silenceCuts(silences: Silence[], total: number, padding: number, fps: number, max = 400): Silence[] {
  const cuts: Silence[] = [];
  for (const silence of silences) {
    const start = silence.start + padding;
    const end = Math.min(silence.end, total) - padding;
    if (end - start >= 2 / fps) cuts.push({ start, end });
  }
  return cuts.slice(0, max);
}

// ---- multicam ---------------------------------------------------------------

export type Camera = { asset: string; mic?: string; speaker?: string };
export type CameraShot = { start: number; end: number; camera: number };

/** Main shots with wide (overlap) shots layered on top, snapped to frames and merged. */
export function composeShots(main: ShotDecision[], wide: ShotDecision[], total: number, fps: number): CameraShot[] {
  const frame = (time: number) => Math.max(0, Math.min(Math.round(total * fps), Math.round(time * fps)));
  const bounds = [...new Set([0, Math.round(total * fps), ...main.flatMap(shot => [frame(shot.start), frame(shot.end)]), ...wide.flatMap(shot => [frame(shot.start), frame(shot.end)])])].sort((a, b) => a - b);
  const out: CameraShot[] = [];
  let previous = main[0]?.camera ?? 0;
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    if (b <= a) continue;
    const covers = (shot: ShotDecision) => frame(shot.start) <= a && frame(shot.end) >= b;
    const camera = wide.find(covers)?.camera ?? main.find(covers)?.camera ?? previous;
    previous = camera;
    const last = out[out.length - 1];
    if (last && last.camera === camera) last.end = b / fps;
    else out.push({ start: a / fps, end: b / fps, camera });
  }
  return out;
}

export async function planMulticam(project: EditProject, cameras: Camera[], ctx: { ffmpeg: string; workDir: string; signal?: AbortSignal; wide?: number; minShot?: number; hold?: number; reaction?: number; from?: number; to?: number; onProgress?: (p: number, m: string) => void }): Promise<{ shots: CameraShot[]; total: number; speech: number }> {
  if (cameras.length < 2 || cameras.length > 8) throw new EditOpError('multicam needs 2 to 8 cameras.');
  const videos = cameras.map(camera => {
    const asset = project.assets[camera.asset];
    if (!asset || asset.kind !== 'video') throw new EditOpError(`Camera asset "${camera.asset}" must be an imported video.`);
    return asset;
  });
  const total = Math.min(ctx.to ?? Infinity, ...videos.map(asset => asset.duration));
  const from = ctx.from ?? 0;
  if (!(total - from > 1)) throw new EditOpError('The cameras are too short for a multicam edit.');
  await fs.mkdir(ctx.workDir, { recursive: true });
  const sources: { path: string; speaker: string }[] = [];
  const speakerToCamera: Record<string, number> = {};
  for (let i = 0; i < cameras.length; i += 1) {
    const camera = cameras[i];
    const speaker = (camera.speaker || `S${i + 1}`).slice(0, 24);
    speakerToCamera[speaker] = i;
    if (ctx.wide === i && !camera.mic) continue; // A wide camera without its own mic has no speaker.
    const audioAsset: EditAsset | undefined = camera.mic ? project.assets[camera.mic] : videos[i];
    if (!audioAsset?.hasAudio) throw new EditOpError(`${camera.mic ? `Mic asset "${camera.mic}"` : `Camera "${camera.asset}"`} has no audio for speaker detection.`);
    const wav = path.join(ctx.workDir, `vad-${i}.wav`);
    await exec(ctx.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(total - from), '-i', audioAsset.path, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', '-y', wav], { maxBuffer: 4 * 1024 * 1024 });
    sources.push({ path: wav, speaker });
    ctx.onProgress?.(10 + (i / cameras.length) * 30, `Extracted audio ${i + 1} of ${cameras.length}`);
  }
  if (!sources.length) throw new EditOpError('No camera has audio to detect speakers from.');
  ctx.onProgress?.(45, 'Detecting who is speaking');
  const segments = await runVad(sources, 3, true, ctx.signal);
  ctx.signal?.throwIfAborted();
  const wideIndex = ctx.wide !== undefined && ctx.wide >= 0 && ctx.wide < cameras.length ? ctx.wide : -1;
  const decisions = generateShotDecisions(segments, speakerToCamera, {
    totalDuration: total - from,
    wideCameraIndex: wideIndex,
    useOverlapWideShots: wideIndex >= 0,
    ...(ctx.minShot ? { minShotDuration: ctx.minShot } : {}),
    ...(ctx.hold ? { holdTimeBeforeSwitch: ctx.hold } : {}),
    ...(ctx.reaction !== undefined ? { paddingBefore: -Math.abs(ctx.reaction) } : {})
  });
  const shots = composeShots(decisions.mainShots, decisions.wideShots, total - from, project.fps).map(shot => ({ ...shot, start: shot.start + from, end: shot.end + from }));
  return { shots, total, speech: segments.length };
}

export function multicamOps(project: EditProject, cameras: Camera[], shots: CameraShot[], audio: 'mics' | 'first' | 'none', total: number): any[] {
  const ops: any[] = shots.map(shot => ({ op: 'add', asset: cameras[shot.camera].asset, at: shot.start, in: shot.start, out: shot.end, track: 'V1', audio: false }));
  if (audio !== 'none') {
    const chosen = audio === 'mics' ? cameras.map(camera => camera.mic).filter(Boolean) as string[] : [cameras[0].asset];
    [...new Set(chosen)].forEach((asset, index) => ops.push({ op: 'add', asset, only: 'audio', at: 0, in: 0, out: Math.min(total, project.assets[asset].duration), track: `A${index + 1}` }));
  }
  return ops;
}

export function summarizeShots(project: EditProject, cameras: Camera[], shots: CameraShot[]): any {
  const seconds: Record<string, number> = {};
  for (const shot of shots) {
    const name = cameras[shot.camera].speaker || project.assets[cameras[shot.camera].asset].name;
    seconds[name] = Number(((seconds[name] || 0) + shot.end - shot.start).toFixed(1));
  }
  return { cuts: Math.max(0, shots.length - 1), seconds };
}

// ---- helpers shared by the engine -------------------------------------------

export { applyOps, clipEnd, projectDuration, snap };
