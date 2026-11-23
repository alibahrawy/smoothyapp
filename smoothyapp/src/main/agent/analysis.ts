/**
 * smoothy_analyze: the things an agent cannot see or hear, measured on source
 * files with the bundled engines.
 *
 * - transcribe_words: whisper-cli with DTW token timestamps and a filler prompt.
 *   Word onsets are shifted −0.15 s (DTW runs 0.15–0.2 s late) and returned in
 *   source seconds, with um/uh flagged. A readable transcript is written too.
 * - envelope: a 10 ms RMS dB envelope plus a silence map at a threshold.
 * - loudness: integrated LUFS, loudness range and true peak per file or range.
 * - scene_cuts: shot boundaries from ffmpeg's scene score.
 * - models / install_model: whisper models for word timings (small.en, medium.en …).
 *
 * Every analysis is a job, cached by file stamp and settings, and writes its
 * full output to files; replies carry counts, paths and a short preview.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dtwPreset, runEngine, type WhisperInfo } from './engine';
import { fileStamp, hashKey, type ResultCache } from './results';
import { probeMedia, resolveMediaPath } from './media';
import type { AgentJob, AgentResult } from './types';

// ---- words ------------------------------------------------------------------------

export type Word = { w: string; a: number; b: number; p: number; filler?: true };

export const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'uhm', 'ah', 'er', 'erm', 'hmm', 'mm', 'mhm']);
export const FILLER_PROMPT = 'Um, uh, so, like, you know. I mean, uh, okay.';
export const DTW_SHIFT = -0.15;

const normWord = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}%]/gu, '');

/**
 * Turns whisper-cli full JSON (-ojf with -dtw) into words in source seconds.
 * A token that starts with a space begins a new word; others extend the last one.
 * A word ends at the next word's onset, at most 1.2 s after its own (0.4 s for the last).
 */
export function wordsFromDtw(json: any, offset: number, shift = DTW_SHIFT): Word[] {
  const words: { w: string; a: number; p: number }[] = [];
  for (const segment of Array.isArray(json?.transcription) ? json.transcription : []) {
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      const text = String(token?.text ?? '');
      const dtw = Number(token?.t_dtw);
      if (!text || text.startsWith('[_') || !(dtw >= 0)) continue;
      const p = Number.isFinite(Number(token?.p)) ? Number(token.p) : 1;
      if (text.startsWith(' ') || !words.length) words.push({ w: text.trim(), a: Math.max(0, dtw / 100 + offset + shift), p });
      else {
        const last = words[words.length - 1];
        last.w += text;
        last.p = Math.min(last.p, p);
      }
    }
  }
  const kept = words.filter(word => normWord(word.w));
  return kept.map((word, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].a : word.a + 0.4;
    const out: Word = { w: word.w, a: Number(word.a.toFixed(3)), b: Number(Math.max(word.a + 0.02, Math.min(next, word.a + 1.2)).toFixed(3)), p: Number(word.p.toFixed(3)) };
    if (FILLERS.has(normWord(word.w))) out.filler = true;
    return out;
  });
}

export function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

/** Lines broken on pauses over 0.6 s, after 28 words, or at a sentence end after 6 words. */
export function readableTranscript(words: Word[]): string[] {
  const out: string[] = [];
  let line: Word[] = [];
  let prev = 0;
  const flush = () => {
    if (line.length) out.push(`[${clock(line[0].a)}] ${line.map(word => word.w).join(' ')}`);
    line = [];
  };
  for (const word of words) {
    if (line.length && (word.a - prev > 0.6 || line.length > 28)) flush();
    line.push(word);
    prev = word.b;
    if (/[.?!]$/.test(word.w) && line.length > 6) flush();
  }
  flush();
  return out;
}

// ---- envelope ------------------------------------------------------------------------

/**
 * Streams 48 kHz float audio from ffmpeg and returns RMS dB per bin (−120 for
 * digital silence). Power is averaged over the file's own channels, like
 * astats "Overall": downmixing with -ac 1 would read identical stereo channels
 * 3 dB hot (0.707·(L+R)), and the cut thresholds were calibrated without that.
 */
export function computeEnvelope(ffmpeg: string, file: string, options: { from: number; duration?: number; binMs: number; channels?: number; signal?: AbortSignal; onProgress?: (percent: number) => void }): Promise<number[]> {
  const rate = 48000;
  const channels = Math.max(1, Math.min(8, Math.round(options.channels || 1)));
  const binSamples = Math.max(16, Math.round((rate * options.binMs) / 1000)) * channels;
  const args = ['-nostdin', '-hide_banner', '-v', 'error'];
  if (options.from > 0) args.push('-ss', String(options.from));
  if (options.duration && options.duration > 0) args.push('-t', String(options.duration));
  args.push('-i', file, '-vn', '-map', '0:a:0', '-ac', String(channels), '-ar', String(rate), '-f', 'f32le', 'pipe:1');
  const expected = options.duration ? options.duration * rate * channels : 0;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: number[] = [];
    let sum = 0;
    let count = 0;
    let total = 0;
    let carry: Buffer = Buffer.alloc(0);
    let stderr = '';
    let lastReport = 0;
    const kill = () => { try { child.kill('SIGTERM'); } catch {} };
    options.signal?.addEventListener('abort', kill, { once: true });
    const push = () => {
      out.push(sum > 0 ? Math.max(-120, Number((10 * Math.log10(sum / count)).toFixed(1))) : -120);
      sum = 0;
      count = 0;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - (data.length % 4);
      for (let i = 0; i < usable; i += 4) {
        const v = data.readFloatLE(i);
        sum += v * v;
        count += 1;
        if (count === binSamples) push();
      }
      total += usable / 4;
      carry = data.subarray(usable);
      if (expected && options.onProgress && total - lastReport > rate * channels * 5) {
        lastReport = total;
        options.onProgress(Math.min(99, (total / expected) * 100));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', error => reject(error));
    child.on('close', code => {
      options.signal?.removeEventListener('abort', kill);
      if (options.signal?.aborted) return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      if (code !== 0) return reject(Object.assign(new Error(`Could not read the audio: ${stderr.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited ${code}`}`), { code: 'E_UNSUPPORTED_MEDIA' }));
      if (count >= binSamples / 2) push();
      resolve(out);
    });
  });
}

export type Span = { start: number; end: number };

/** Runs of bins below thresholdDb lasting at least minSilence seconds, in source seconds. */
export function silenceMap(db: number[], binSeconds: number, thresholdDb: number, minSilence: number, offset = 0): Span[] {
  const spans: Span[] = [];
  let start = -1;
  for (let i = 0; i <= db.length; i += 1) {
    const quiet = i < db.length && db[i] < thresholdDb;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if ((i - start) * binSeconds >= minSilence) spans.push({ start: Number((offset + start * binSeconds).toFixed(3)), end: Number((offset + i * binSeconds).toFixed(3)) });
      start = -1;
    }
  }
  return spans;
}

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

// ---- loudness and scenes ------------------------------------------------------------------

export type Loudness = { integrated: number | null; lra: number | null; truePeak: number | null; threshold: number | null };

/** Reads the ebur128 summary block from ffmpeg stderr. */
export function parseEbur128(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const pick = (pattern: RegExp) => {
    const match = pattern.exec(summary);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    integrated: pick(/I:\s*(-?[\d.]+|-inf)\s*LUFS/),
    threshold: pick(/Integrated loudness:[\s\S]*?Threshold:\s*(-?[\d.]+)\s*LUFS/),
    lra: pick(/LRA:\s*(-?[\d.]+)\s*LU\b/),
    truePeak: pick(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/)
  };
}

/** Reads metadata=print output: a frame line with pts_time followed by lavfi.scene_score. */
export function parseSceneCuts(text: string, offset: number, minGap: number): { t: number; score: number }[] {
  const cuts: { t: number; score: number }[] = [];
  let time: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const frame = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (frame) { time = Number(frame[1]); continue; }
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && time !== null) {
      const t = Number((time + offset).toFixed(3));
      if (!cuts.length || t - cuts[cuts.length - 1].t >= minGap) cuts.push({ t, score: Number(Number(score[1]).toFixed(3)) });
      time = null;
    }
  }
  return cuts;
}

// ---- glitch check ----------------------------------------------------------------------------

const GW = 192;
const GH = 108;

/** Mean absolute difference over every third pixel (as qa_renders.py). */
export function frameDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length / 3);
}

/**
 * Frames that jump away from both neighbours while the neighbours agree:
 * half-painted or blank frames in rendered graphics. Frames are composited over
 * mid-gray at 192x108 so transparent overlays are judged by what will show.
 */
export function glitchFrames(ffmpeg: string, file: string, options: { threshold: number; ratio: number; signal?: AbortSignal }): Promise<{ frames: number; glitches: number[] }> {
  const graph = `color=c=0x808080:s=${GW}x${GH}:r=24[bg];[0:v]scale=${GW}:${GH},format=rgba,setpts=N/24/TB[fg];[bg][fg]overlay=shortest=1:eof_action=endall,format=gray`;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-filter_complex', graph, '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const size = GW * GH;
    let pending: Buffer = Buffer.alloc(0);
    const recent: Buffer[] = [];
    const diffs: number[] = [];
    const glitches: number[] = [];
    let index = 0;
    let stderr = '';
    const kill = () => { try { child.kill('SIGTERM'); } catch {} };
    options.signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        const frame = Buffer.from(pending.subarray(0, size));
        pending = pending.subarray(size);
        recent.push(frame);
        if (recent.length > 3) recent.shift();
        diffs.push(index ? frameDiff(recent[recent.length - 2], frame) : 0);
        // Frame i = index-1 can be judged once frame i+1 has arrived.
        const i = index - 1;
        if (i >= 1 && recent.length === 3) {
          const di = diffs[i];
          const dn = diffs[i + 1];
          if (di > options.threshold && dn > options.threshold && frameDiff(recent[0], recent[2]) < options.ratio * Math.min(di, dn)) glitches.push(i);
        }
        index += 1;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => {
      options.signal?.removeEventListener('abort', kill);
      if (options.signal?.aborted) return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      if (code !== 0) return reject(new Error(`Could not read ${path.basename(file)}: ${stderr.trim().split('\n').slice(-1)[0] || `ffmpeg exited ${code}`}`));
      resolve({ frames: index, glitches });
    });
  });
}

// ---- tool ----------------------------------------------------------------------------------

export type ModelInstaller = {
  /** Catalog ids that can be downloaded, e.g. ggml-small.en.bin. */
  catalog: () => { id: string; name: string; size: string; downloaded: boolean }[];
  ensureBinary: (signal: AbortSignal, progress: (percent: number, message: string) => void) => Promise<string>;
  ensureModel: (id: string, signal: AbortSignal, progress: (percent: number, message: string) => void) => Promise<string>;
};

export type AnalysisDeps = {
  ffmpeg: string;
  ffprobe: string;
  home: string;
  userData: string;
  whisper: () => WhisperInfo | null;
  installer?: ModelInstaller | null;
  cache: ResultCache;
  /** Folder for analysis files: the open project's Work folder, else Smoothy's agent folder. */
  outDir: () => Promise<string>;
  startJob: (kind: string, runner: (progress: (percent: number, message: string) => void, signal: AbortSignal, jobId: string) => Promise<any>) => { id: string; status: string };
  waitJob: (id: string, ms: number) => Promise<AgentJob | null>;
  requestApproval: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  trackTool?: (id: string) => void;
  /** Face, hand and layout scans (vision.ts). */
  vision?: { run(action: string, input: any): Promise<AgentResult> } | null;
};

const ok = (data: unknown): AgentResult => ({ ok: true, data });
const fail = (code: any, message: string, next?: string): AgentResult => ({ ok: false, error: { code, message, next } });
const clampNum = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const safeBase = (file: string) => path.basename(file, path.extname(file)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'media';

/** Model preference for word timings when none is named. */
const MODEL_ORDER = ['ggml-small.en.bin', 'ggml-medium.en.bin', 'ggml-large-v3-turbo.bin', 'ggml-small.bin', 'ggml-medium.bin', 'ggml-base.en.bin', 'ggml-base.bin', 'ggml-tiny.en.bin', 'ggml-tiny.bin'];

export function modelFileId(value: string): string {
  const trimmed = value.trim().replace(/^ggml-/, '').replace(/\.bin$/, '');
  return `ggml-${trimmed}.bin`;
}

export class AnalysisEngine {
  constructor(private readonly deps: AnalysisDeps) {}

  async run(input: any): Promise<AgentResult> {
    const action = String(input?.action || '');
    switch (action) {
      case 'models': return this.models();
      case 'install_model': return this.installModel(input);
      case 'transcribe_words': return this.transcribeWords(input);
      case 'envelope': return this.envelope(input);
      case 'loudness': return this.loudness(input);
      case 'scene_cuts': return this.sceneCuts(input);
      case 'glitch_check': return this.glitchCheck(input);
      case 'vision_faces':
      case 'vision_hands_on_face':
      case 'layout_scan':
        return this.deps.vision ? this.deps.vision.run(action, input) : fail('E_NOT_IMPLEMENTED', 'Picture scans are not available in this build.');
      default: return fail('E_BAD_REQUEST', `Unknown analyze action: ${action || '(none)'}`, 'Use transcribe_words, envelope, loudness, scene_cuts, glitch_check, vision_faces, vision_hands_on_face, layout_scan, models or install_model.');
    }
  }

  private models(): AgentResult {
    const info = this.deps.whisper();
    const installed = (info?.models || []).map(model => ({ id: model.id, path: model.path, dtwPreset: dtwPreset(model.path) || undefined, mb: model.bytes ? Math.round(model.bytes / 1e6) : undefined }));
    const catalog = this.deps.installer?.catalog().filter(item => /^ggml-/.test(item.id)).map(item => ({ id: item.id.replace(/^ggml-|\.bin$/g, ''), name: item.name, size: item.size, installed: item.downloaded })) || [];
    return ok({ action: 'models', whisperCli: info?.path || null, installed, catalog, recommended: 'small.en for English word timings (about 466 MB); medium.en for hard audio (1.5 GB).' });
  }

  private async installModel(input: any): Promise<AgentResult> {
    const installer = this.deps.installer;
    if (!installer) return fail('E_NOT_IMPLEMENTED', 'Model downloads are not available in this build.');
    const id = modelFileId(String(input?.model || 'small.en'));
    const entry = installer.catalog().find(item => item.id === id);
    if (!entry) return fail('E_NOT_FOUND', `Unknown model ${input?.model}.`, 'Call smoothy_analyze action "models" for the list.');
    const binary = this.deps.whisper()?.path;
    if (entry.downloaded && binary) return ok({ action: 'install_model', model: id, alreadyInstalled: true });
    const approved = await this.deps.requestApproval('smoothy_analyze.install', {
      action: 'install whisper model',
      model: entry.name,
      size: entry.size,
      note: `Downloads ${binary ? '' : 'the whisper.cpp engine and '}the ${entry.name} speech model (${entry.size}) once. Audio is transcribed on this computer.`
    });
    if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve the model download.', 'Open the Agentic tab and approve the request.');
    const job = this.deps.startJob('analyze.install', async (progress, signal) => {
      if (!this.deps.whisper()?.path) await installer.ensureBinary(signal, (p, m) => progress(p * 0.15, m));
      const file = await installer.ensureModel(id, signal, (p, m) => progress(15 + p * 0.85, m));
      progress(100, 'Model ready');
      return { model: id, path: file, dtwPreset: dtwPreset(file) };
    });
    return ok({ action: 'install_model', jobId: job.id, status: job.status, note: 'Downloading. Wait with smoothy_jobs action "wait"; the job reports an ETA.' });
  }

  private async source(input: any, needAudio = true): Promise<{ file: string; from: number; to: number; duration: number; total: number; stamp: any; channels: number }> {
    const file = await resolveMediaPath(input?.path, this.deps.home, this.deps.userData);
    const probe = await probeMedia(this.deps.ffprobe, file);
    const total = Number(probe.duration) || 0;
    const from = Math.max(0, Number(input?.from) || 0);
    const to = input?.to !== undefined && Number(input.to) > from ? Math.min(Number(input.to), total || Number(input.to)) : total;
    if (!(to > from)) throw Object.assign(new Error('The range is empty. Check from/to against the file length.'), { code: 'E_BAD_REQUEST' });
    if (needAudio && !probe.audio) throw Object.assign(new Error('That file has no audio stream.'), { code: 'E_UNSUPPORTED_MEDIA' });
    return { file, from, to, duration: to - from, total, stamp: await fileStamp(file), channels: probe.audio?.channels || 1 };
  }

  private async finish(job: { id: string; status: string }, input: any, action: string): Promise<AgentResult> {
    const waitMs = Math.max(0, Math.min(120000, input?.waitMs === undefined ? 20000 : Number(input.waitMs) || 0));
    const view = await this.deps.waitJob(job.id, waitMs);
    if (view?.status === 'done') return ok({ action, jobId: job.id, ...(view.result as any) });
    if (view && view.status !== 'running') return fail('E_INTERNAL', view.error || `${action} failed.`);
    return ok({
      action, jobId: job.id, status: 'running', progress: view?.progress ?? 0, etaSeconds: view?.etaSeconds ?? null,
      next: `Still running. Call smoothy_jobs action "wait" id "${job.id}"${view?.etaSeconds ? ` with timeoutMs about ${Math.min(120000, Math.max(5000, view.etaSeconds * 1000))}` : ''}.`
    });
  }

  private async cached(kind: string, key: string): Promise<any | null> {
    const hit = await this.deps.cache.get<any>(kind, key);
    if (!hit) return null;
    for (const file of Object.values(hit.files || {})) {
      if (typeof file === 'string' && !(await fileStamp(file))) return null;
    }
    return { ...hit, cached: true };
  }

  private async outFolder(sub: string): Promise<string> {
    const dir = path.join(await this.deps.outDir(), sub);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private rangeTag(src: { from: number; to: number; total: number }): string {
    return src.from > 0 || (src.total && src.to < src.total - 0.01) ? `-${Math.round(src.from)}-${Math.round(src.to)}s` : '';
  }

  // ---- transcribe_words -------------------------------------------------------------------

  private pickModel(requested: unknown, language: string | undefined): WhisperInfo['models'][number] | null {
    const models = this.deps.whisper()?.models || [];
    if (typeof requested === 'string' && requested.trim()) {
      const id = modelFileId(requested);
      return models.find(model => path.basename(model.path) === id || model.id === requested || model.id === id) || null;
    }
    const english = !language || language === 'en';
    for (const id of MODEL_ORDER) {
      if (!english && id.includes('.en.')) continue;
      const found = models.find(model => path.basename(model.path) === id);
      if (found) return found;
    }
    return models.find(model => english || !model.englishOnly) || null;
  }

  private async transcribeWords(input: any): Promise<AgentResult> {
    const info = this.deps.whisper();
    const language = typeof input?.language === 'string' && input.language.trim() ? input.language.trim().toLowerCase().slice(0, 8) : undefined;
    if (!info?.path) return fail('E_MODEL_MISSING', 'whisper-cli is not installed yet.', 'Call smoothy_analyze action "install_model" model "small.en" (the editor approves the download).');
    const model = this.pickModel(input?.model, language);
    if (!model) return fail('E_MODEL_MISSING', input?.model ? `The ${input.model} model is not installed.` : 'No whisper model is installed.', `Call smoothy_analyze action "install_model" model "${input?.model || 'small.en'}".`);
    const preset = dtwPreset(model.path);
    if (!preset) return fail('E_BAD_REQUEST', `${model.id} has no DTW preset, so word timings would be loose.`, 'Use a standard model such as small.en or medium.en.');
    if (language && language !== 'en' && model.englishOnly) return fail('E_BAD_REQUEST', `${model.id} is English-only.`, 'Pick a multilingual model, for example small or large-v3-turbo.');
    const src = await this.source(input);
    const terms = Array.isArray(input?.terms) ? input.terms.map((term: unknown) => String(term).trim()).filter(Boolean).slice(0, 40) : [];
    const prompt = typeof input?.prompt === 'string' && input.prompt.trim() ? input.prompt.trim().slice(0, 800) : `${FILLER_PROMPT}${terms.length ? ` ${terms.join(', ')}.` : ''}`;
    const shift = clampNum(input?.shift, -1, 1, DTW_SHIFT);
    const settings = { stamp: src.stamp, from: src.from, to: src.to, model: model.id, prompt, language: language || (model.englishOnly ? 'en' : 'auto'), shift };
    const key = hashKey(settings);
    this.deps.trackTool?.('agent_analyze_words');
    const hit = await this.cached('words', key);
    if (hit) return ok({ action: 'transcribe_words', ...hit });

    const job = this.deps.startJob('analyze.words', async (progress, signal, jobId) => {
      const dir = await this.outFolder('transcript');
      const base = `${safeBase(src.file)}${this.rangeTag(src)}-${key.slice(0, 6)}`;
      const work = path.join(os.tmpdir(), `smoothy-words-${jobId.slice(0, 8)}`);
      await fs.mkdir(work, { recursive: true });
      try {
        progress(1, 'Extracting 16 kHz audio');
        const wav = path.join(work, 'audio.wav');
        const extract = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-y', ...(src.from > 0 ? ['-ss', String(src.from)] : []), '-t', String(src.duration), '-i', src.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
          cwd: work, signal, timeoutMs: 3600000, expected: src.duration, onProgress: p => progress(1 + p * 0.09, 'Extracting audio')
        });
        if (extract.exitCode !== 0) throw new Error(`Audio extraction failed: ${extract.stderrTail.slice(-2).join(' ')}`);
        progress(10, `Transcribing with ${model.id.replace(/^ggml-|\.bin$/g, '')}`);
        const prefix = path.join(work, 'dtw');
        const args = ['-m', model.path, '-f', wav, '-t', String(Math.max(1, Math.min(8, os.cpus().length))), '-l', settings.language, '-nfa', '-dtw', preset, '-oj', '-ojf', '-of', prefix, '--prompt', prompt, '-pp'];
        if (info.variant === 'cpu') args.push('-ng');
        const run = await runEngine(info.path as string, 'whisper', args, { cwd: work, signal, timeoutMs: 6 * 3600000, onProgress: p => progress(10 + p * 0.85, `Transcribing ${Math.round(p)}%`) });
        if (run.exitCode !== 0) throw new Error(`whisper-cli failed: ${run.stderrTail.slice(-3).join(' ')}`);
        const raw = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'));
        const words = wordsFromDtw(raw, src.from, shift);
        const readable = readableTranscript(words);
        const files = {
          words: path.join(dir, `${base}-words.json`),
          readable: path.join(dir, `${base}-readable.txt`),
          raw: path.join(dir, `${base}-dtw.json`)
        };
        await fs.writeFile(files.words, JSON.stringify({ source: src.file, from: src.from, to: src.to, model: model.id, dtwPreset: preset, shift, prompt, language: settings.language, words }));
        await fs.writeFile(files.readable, `${readable.join('\n')}\n`);
        await fs.copyFile(`${prefix}.json`, files.raw);
        const fillers = words.filter(word => word.filler);
        const result = {
          source: src.file, from: src.from, to: src.to, model: model.id, shift,
          words: words.length, fillers: fillers.length,
          lowConfidence: words.filter(word => word.p < 0.4).length,
          files,
          preview: readable.slice(0, 10),
          fillerSample: fillers.slice(0, 8).map(word => ({ w: word.w, a: word.a })),
          format: 'words.json → words[]: {w, a (onset, source s), b (end), p (min token probability), filler?}'
        };
        await this.deps.cache.set('words', key, result).catch(() => {});
        progress(100, 'Words ready');
        return result;
      } finally {
        await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
    return this.finish(job, input, 'transcribe_words');
  }

  // ---- envelope -----------------------------------------------------------------------------

  private async envelope(input: any): Promise<AgentResult> {
    const src = await this.source(input);
    const binMs = Math.round(clampNum(input?.binMs, 5, 100, 10));
    const thresholdDb = clampNum(input?.thresholdDb, -90, -10, -50);
    const minSilence = clampNum(input?.minSilence, 0.05, 10, 0.3);
    const key = hashKey({ v: 2, stamp: src.stamp, from: src.from, to: src.to, binMs });
    this.deps.trackTool?.('agent_analyze_envelope');
    const summarize = async (envFile: string, db: number[], cached: boolean) => {
      const binSeconds = binMs / 1000;
      const silences = silenceMap(db, binSeconds, thresholdDb, minSilence, src.from);
      const dir = path.dirname(envFile);
      const silenceFile = path.join(dir, `${path.basename(envFile, '-envelope.json')}-silence${Math.round(-thresholdDb)}db-${Math.round(minSilence * 1000)}ms.json`);
      await fs.writeFile(silenceFile, JSON.stringify({ source: src.file, thresholdDb, minSilence, silences }));
      const voiced = db.filter(value => value >= thresholdDb).sort((a, b) => a - b);
      return {
        source: src.file, from: src.from, to: src.to, binMs, bins: db.length, thresholdDb, minSilence,
        speechSeconds: Number((voiced.length * binSeconds).toFixed(2)),
        silenceSeconds: Number(silences.reduce((sum, span) => sum + span.end - span.start, 0).toFixed(2)),
        silenceCount: silences.length,
        speechLevelDb: { p10: percentile(voiced, 0.1), median: percentile(voiced, 0.5), p90: percentile(voiced, 0.9) },
        silences: silences.slice(0, 15),
        files: { envelope: envFile, silences: silenceFile },
        format: 'envelope.json → {from, binMs, db[]}: db[i] is RMS dB for source time from + i*binMs/1000 (−120 = digital silence).',
        cached: cached || undefined
      };
    };
    const hit = await this.cached('envelope', key);
    if (hit?.files?.envelope) {
      const saved = JSON.parse(await fs.readFile(hit.files.envelope, 'utf8'));
      return ok({ action: 'envelope', ...(await summarize(hit.files.envelope, saved.db, true)) });
    }
    const job = this.deps.startJob('analyze.envelope', async (progress, signal) => {
      progress(1, 'Reading audio');
      const db = await computeEnvelope(this.deps.ffmpeg, src.file, { from: src.from, duration: src.duration, binMs, channels: src.channels, signal, onProgress: p => progress(p, `Measuring ${Math.round(p)}%`) });
      const dir = await this.outFolder('audio');
      const envFile = path.join(dir, `${safeBase(src.file)}${this.rangeTag(src)}-rms${binMs}ms-${key.slice(0, 6)}-envelope.json`);
      await fs.writeFile(envFile, JSON.stringify({ source: src.file, from: src.from, to: src.to, binMs, db }));
      await this.deps.cache.set('envelope', key, { files: { envelope: envFile } }).catch(() => {});
      progress(100, 'Envelope ready');
      return summarize(envFile, db, false);
    });
    return this.finish(job, input, 'envelope');
  }

  // ---- loudness -----------------------------------------------------------------------------

  private async loudness(input: any): Promise<AgentResult> {
    const src = await this.source(input);
    const requested: { from: number; to: number }[] = Array.isArray(input?.ranges) && input.ranges.length
      ? input.ranges.slice(0, 20).map((range: any) => ({ from: Math.max(0, Number(range?.from) || 0), to: Math.min(src.total || Infinity, Number(range?.to) || 0) })).filter((range: any) => range.to > range.from)
      : [{ from: src.from, to: src.to }];
    if (!requested.length) return fail('E_BAD_REQUEST', 'Each range needs from < to inside the file.');
    this.deps.trackTool?.('agent_analyze_loudness');
    const keyFor = (range: { from: number; to: number }) => hashKey({ stamp: src.stamp, ...range });
    const known = await Promise.all(requested.map(range => this.deps.cache.get<Loudness>('loudness', keyFor(range))));
    const shape = (rows: (Loudness & { from: number; to: number })[]) => ({ source: src.file, ranges: rows, note: 'integrated/threshold in LUFS, lra in LU, truePeak in dBTP.' });
    if (known.every(Boolean)) return ok({ action: 'loudness', ...shape(requested.map((range, i) => ({ ...range, ...(known[i] as Loudness) }))), cached: true });
    const total = requested.reduce((sum, range) => sum + range.to - range.from, 0);
    const job = this.deps.startJob('analyze.loudness', async (progress, signal) => {
      const rows: (Loudness & { from: number; to: number })[] = [];
      let done = 0;
      for (let i = 0; i < requested.length; i += 1) {
        const range = requested[i];
        let value = known[i];
        if (!value) {
          const run = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', ...(range.from > 0 ? ['-ss', String(range.from)] : []), '-t', String(range.to - range.from), '-i', src.file, '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], {
            cwd: os.tmpdir(), signal, timeoutMs: 3600000, tailLines: 40, expected: range.to - range.from,
            onProgress: p => progress(((done + (p / 100) * (range.to - range.from)) / total) * 100, `Measuring range ${i + 1}/${requested.length}`)
          });
          if (run.exitCode !== 0) throw new Error(`Loudness failed: ${run.stderrTail.slice(-2).join(' ')}`);
          value = parseEbur128(run.stderrTail.join('\n'));
          await this.deps.cache.set('loudness', keyFor(range), value).catch(() => {});
        }
        rows.push({ ...range, ...value });
        done += range.to - range.from;
      }
      progress(100, 'Loudness ready');
      return shape(rows);
    });
    return this.finish(job, input, 'loudness');
  }

  // ---- glitch_check -------------------------------------------------------------------------

  private async glitchCheck(input: any): Promise<AgentResult> {
    const files: string[] = [];
    const wanted = Array.isArray(input?.paths) ? input.paths : input?.path ? [input.path] : [];
    for (const item of wanted.slice(0, 500)) files.push(await resolveMediaPath(item, this.deps.home, this.deps.userData));
    if (input?.folder) {
      const folder = await fs.realpath(String(input.folder)).catch(() => '');
      if (!folder) return fail('E_NOT_FOUND', 'That folder was not found.');
      const exts = new Set((Array.isArray(input?.extensions) ? input.extensions : ['mov', 'mp4', 'webm', 'mkv']).map((ext: unknown) => `.${String(ext).replace(/^\./, '').toLowerCase()}`));
      const names = (await fs.readdir(folder)).filter(name => exts.has(path.extname(name).toLowerCase())).sort();
      for (const name of names.slice(0, 500 - files.length)) files.push(await resolveMediaPath(path.join(folder, name), this.deps.home, this.deps.userData));
    }
    if (!files.length) return fail('E_BAD_REQUEST', 'Provide path, paths or folder with rendered graphics.');
    const threshold = clampNum(input?.threshold, 0.5, 50, 3);
    const ratio = clampNum(input?.ratio, 0.05, 0.9, 0.35);
    this.deps.trackTool?.('agent_analyze_glitch');
    const job = this.deps.startJob('analyze.glitch', async (progress, signal) => {
      const results: { file: string; frames: number; glitches: number[]; cached?: boolean; error?: string }[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        progress((i / files.length) * 100, `Checking ${i + 1}/${files.length}: ${path.basename(file)}`);
        const key = hashKey({ v: 1, stamp: await fileStamp(file), threshold, ratio });
        const hit = await this.deps.cache.get<{ frames: number; glitches: number[] }>('glitch', key);
        if (hit) { results.push({ file, ...hit, cached: true }); continue; }
        try {
          const found = await glitchFrames(this.deps.ffmpeg, file, { threshold, ratio, signal });
          await this.deps.cache.set('glitch', key, found).catch(() => {});
          results.push({ file, ...found });
        } catch (error: any) {
          if (signal.aborted) throw error;
          results.push({ file, frames: 0, glitches: [], error: error?.message || 'unreadable' });
        }
      }
      const bad = results.filter(item => item.glitches.length);
      const dir = await this.outFolder('analysis');
      const report = path.join(dir, `glitch-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.writeFile(report, JSON.stringify({ threshold, ratio, results }, null, 1));
      progress(100, 'Checked');
      return {
        checked: results.length, withGlitches: bad.length, unreadable: results.filter(item => item.error).map(item => path.basename(item.file)),
        glitches: bad.slice(0, 20).map(item => ({ file: path.basename(item.file), frames: item.glitches.slice(0, 12) })),
        files: { report },
        next: bad.length ? 'Re-render the listed files (lower concurrency), then check them again.' : 'No glitch frames found.'
      };
    });
    return this.finish(job, input, 'glitch_check');
  }

  // ---- scene_cuts ---------------------------------------------------------------------------

  private async sceneCuts(input: any): Promise<AgentResult> {
    const src = await this.source(input, false);
    const threshold = clampNum(input?.threshold, 0.05, 0.9, 0.3);
    const minGap = clampNum(input?.minGap, 0, 30, 0.5);
    const key = hashKey({ stamp: src.stamp, from: src.from, to: src.to, threshold, minGap });
    this.deps.trackTool?.('agent_analyze_scenes');
    const hit = await this.cached('scenes', key);
    if (hit) return ok({ action: 'scene_cuts', ...hit });
    const job = this.deps.startJob('analyze.scenes', async (progress, signal) => {
      const run = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', ...(src.from > 0 ? ['-ss', String(src.from)] : []), '-t', String(src.duration), '-i', src.file, '-an', '-sn', '-vf', `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`, '-f', 'null', '-'], {
        cwd: os.tmpdir(), signal, timeoutMs: 6 * 3600000, expected: src.duration, onProgress: p => progress(p, `Scanning ${Math.round(p)}%`)
      });
      if (run.exitCode !== 0) throw new Error(`Scene scan failed: ${run.stderrTail.slice(-2).join(' ')}`);
      const cuts = parseSceneCuts(run.stdout, src.from, minGap);
      const dir = await this.outFolder('analysis');
      const file = path.join(dir, `${safeBase(src.file)}${this.rangeTag(src)}-scenes-${key.slice(0, 6)}.json`);
      await fs.writeFile(file, JSON.stringify({ source: src.file, threshold, minGap, cuts }));
      const result = { source: src.file, from: src.from, to: src.to, threshold, count: cuts.length, cuts: cuts.slice(0, 20), files: { cuts: file } };
      await this.deps.cache.set('scenes', key, result).catch(() => {});
      progress(100, 'Scene cuts ready');
      return result;
    });
    return this.finish(job, input, 'scene_cuts');
  }
}
