/**
 * Picture analysis for smoothy_analyze:
 * - vision_faces: eye midpoint (normalized in the frame or crop) per sample and a
 *   median anchor per clip, for eye-anchored punch-ins (macOS Vision helper).
 * - vision_hands_on_face: time ranges where a hand covers the upper face
 *   (eye rubbing, face covered), to cover with a graphic (macOS Vision helper).
 * - layout_scan: time ranges classified per screen region (any platform):
 *   brightness (whiteboard ≈ 245, blank, app), colour fraction (a speaker's
 *   shirt), or histogram match against a reference frame (same person in the tile).
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeMedia, resolveMediaPath } from './media';
import { fileStamp, hashKey, type ResultCache } from './results';
import type { AgentJob, AgentResult } from './types';

const exec = promisify(execFile);
const ok = (data: unknown): AgentResult => ({ ok: true, data });
const fail = (code: any, message: string, next?: string): AgentResult => ({ ok: false, error: { code, message, next } });
const num = (value: unknown, min: number, max: number, fallback: number) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
const r3 = (value: number) => Number(value.toFixed(3));
export const DEFAULT_ANCHOR = { x: 0.5, y: 0.44 };

export type Rect = [number, number, number, number];

export type ClipRange = { id: string; srcIn: number; srcOut: number };

/** Sample times: explicit, two per clip (at 1/3 and 2/3), or every 1/fps over a range. */
export function sampleTimes(input: { times?: number[]; clips?: ClipRange[]; from: number; to: number; fps: number; perClip?: number }): { t: number; clip?: string }[] {
  if (input.times?.length) return input.times.filter(Number.isFinite).slice(0, 5000).map(t => ({ t }));
  if (input.clips?.length) {
    const per = Math.max(1, Math.min(8, Math.round(input.perClip || 2)));
    return input.clips.flatMap(clip => Array.from({ length: per }, (_, k) => ({ t: r3(clip.srcIn + ((k + 1) / (per + 1)) * (clip.srcOut - clip.srcIn)), clip: clip.id }))).slice(0, 5000);
  }
  const out: { t: number }[] = [];
  for (let t = input.from; t < input.to && out.length < 20000; t += 1 / input.fps) out.push({ t: r3(t) });
  return out;
}

/** Groups flagged samples into spans: neighbours closer than 1.5 sample steps join. */
export function flaggedSpans(samples: { t: number; flag: boolean }[], step: number, minSpan: number): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | null = null;
  for (const sample of samples) {
    if (!sample.flag) continue;
    if (open && sample.t - open.to <= step * 1.5) open.to = sample.t;
    else { if (open) spans.push(open); open = { from: sample.t, to: sample.t }; }
  }
  if (open) spans.push(open);
  return spans.map(span => ({ from: r3(span.from), to: r3(span.to + step) })).filter(span => span.to - span.from >= minSpan - 1e-9);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---- layout scan measures ---------------------------------------------------------------

export type RegionSpec = {
  name: string;
  rect: Rect;
  measure: 'brightness' | 'color' | 'match';
  color?: { r: [number, number]; g: [number, number]; b: [number, number] };
  reference?: number;
  classes?: { label: string; min?: number; max?: number }[];
};

/** Mean of (r+g+b)/3 over a grid inside rect (frame is rgb24, width w). */
export function brightness(frame: Buffer, w: number, rect: Rect, step = 4): number {
  let sum = 0; let n = 0;
  for (let y = rect[1]; y < rect[1] + rect[3]; y += step) for (let x = rect[0]; x < rect[0] + rect[2]; x += step) {
    const o = (y * w + x) * 3; sum += (frame[o] + frame[o + 1] + frame[o + 2]) / 3; n += 1;
  }
  return n ? sum / n : 0;
}

/** Fraction of pixels in rect whose r, g and b fall inside the ranges. */
export function colorFraction(frame: Buffer, w: number, rect: Rect, color: NonNullable<RegionSpec['color']>, step = 2): number {
  let hit = 0; let n = 0;
  for (let y = rect[1]; y < rect[1] + rect[3]; y += step) for (let x = rect[0]; x < rect[0] + rect[2]; x += step) {
    const o = (y * w + x) * 3; n += 1;
    if (frame[o] >= color.r[0] && frame[o] <= color.r[1] && frame[o + 1] >= color.g[0] && frame[o + 1] <= color.g[1] && frame[o + 2] >= color.b[0] && frame[o + 2] <= color.b[1]) hit += 1;
  }
  return n ? hit / n : 0;
}

/** 8×8×8 colour histogram of rect, normalized. */
export function histogram(frame: Buffer, w: number, rect: Rect, step = 2): Float64Array {
  const bins = new Float64Array(512); let n = 0;
  for (let y = rect[1]; y < rect[1] + rect[3]; y += step) for (let x = rect[0]; x < rect[0] + rect[2]; x += step) {
    const o = (y * w + x) * 3; bins[((frame[o] >> 5) << 6) | ((frame[o + 1] >> 5) << 3) | (frame[o + 2] >> 5)] += 1; n += 1;
  }
  if (n) for (let i = 0; i < 512; i += 1) bins[i] /= n;
  return bins;
}

/** Histogram intersection: 1 = identical colour mix, 0 = nothing in common. */
export function intersection(a: Float64Array, b: Float64Array): number {
  let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.min(a[i], b[i]); return s;
}

export function classify(value: number, classes: RegionSpec['classes']): string {
  for (const item of classes || []) if ((item.min === undefined || value >= item.min) && (item.max === undefined || value < item.max)) return item.label;
  return 'other';
}

/** Consecutive samples with the same label become one span. */
export function labelSpans(samples: { t: number; label: string }[], step: number): { label: string; from: number; to: number }[] {
  const spans: { label: string; from: number; to: number }[] = [];
  for (const sample of samples) {
    const last = spans[spans.length - 1];
    if (last && last.label === sample.label && sample.t - last.to <= step * 1.5) last.to = sample.t;
    else spans.push({ label: sample.label, from: sample.t, to: sample.t });
  }
  return spans.map(span => ({ ...span, from: r3(span.from), to: r3(span.to + step) }));
}

/** Streams rgb24 frames at fps from a range, calling onFrame(t, buffer). */
function streamFrames(ffmpeg: string, file: string, o: { from: number; to: number; fps: number; width: number; height: number; signal?: AbortSignal; onFrame: (t: number, frame: Buffer) => void; onProgress?: (p: number) => void }): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-v', 'error', ...(o.from > 0 ? ['-ss', String(o.from)] : []), '-t', String(o.to - o.from), '-i', file, '-an', '-sn', '-vf', `fps=${o.fps},scale=${o.width}:${o.height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const size = o.width * o.height * 3;
    let pending: Buffer = Buffer.alloc(0);
    let i = 0;
    let stderr = '';
    const total = Math.max(1, (o.to - o.from) * o.fps);
    const kill = () => { try { child.kill('SIGTERM'); } catch {} };
    o.signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        o.onFrame(r3(o.from + i / o.fps), pending.subarray(0, size));
        pending = pending.subarray(size);
        i += 1;
        if (i % 20 === 0) o.onProgress?.(Math.min(99, (i / total) * 100));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', code => {
      o.signal?.removeEventListener('abort', kill);
      if (o.signal?.aborted) return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      if (code !== 0) return reject(new Error(`Could not read frames: ${stderr.trim().split('\n').slice(-1)[0] || code}`));
      resolve(i);
    });
  });
}

// ---- engine --------------------------------------------------------------------------------

export type VisionDeps = {
  ffmpeg: string;
  ffprobe: string;
  home: string;
  userData: string;
  /** The macOS Vision helper, or null where it is not available. */
  visionHelper: () => string | null;
  cache: ResultCache;
  outDir: () => Promise<string>;
  readClips: (value: unknown) => Promise<ClipRange[]>;
  /** Applies edit ops to the open project (anchors, zoom). */
  applyOps?: (ops: any[]) => Promise<AgentResult>;
  /** Clips of the open project (to map cut ids to project clips). */
  projectClips?: () => Promise<{ id: string; kind: string; name?: string; meta?: any; assetPath?: string; srcIn: number; srcOut: number }[]>;
  startJob: (kind: string, runner: (progress: (percent: number, message: string) => void, signal: AbortSignal, jobId: string) => Promise<any>) => { id: string; status: string };
  waitJob: (id: string, ms: number) => Promise<AgentJob | null>;
  trackTool?: (id: string) => void;
};

export class VisionEngine {
  constructor(private readonly deps: VisionDeps) {}

  async run(action: string, input: any): Promise<AgentResult> {
    if (action === 'layout_scan') return this.layoutScan(input);
    const helper = this.deps.visionHelper();
    if (!helper) return fail('E_NOT_IMPLEMENTED', process.platform === 'darwin' ? 'The Vision helper is missing from this build.' : 'Face and hand scans use Apple Vision and need macOS.', process.platform === 'darwin' ? 'Run npm run build:vision (needs Xcode command line tools).' : 'Use layout_scan, or run the scan on a Mac.');
    if (action === 'vision_faces') return this.faces(input, helper);
    return this.hands(input, helper);
  }

  private async source(input: any) {
    const file = await resolveMediaPath(input?.path, this.deps.home, this.deps.userData);
    const probe = await probeMedia(this.deps.ffprobe, file);
    if (!probe.video) throw Object.assign(new Error('That file has no picture.'), { code: 'E_UNSUPPORTED_MEDIA' });
    const crop = Array.isArray(input?.crop) && input.crop.length === 4 ? input.crop.map((v: unknown) => Math.round(Number(v))) as Rect : null;
    if (crop && (crop.some(v => !Number.isFinite(v)) || crop[0] < 0 || crop[1] < 0 || crop[0] + crop[2] > probe.video.width || crop[1] + crop[3] > probe.video.height || crop[2] < 16 || crop[3] < 16)) {
      throw Object.assign(new Error(`crop must be [x, y, w, h] inside ${probe.video.width}x${probe.video.height}.`), { code: 'E_BAD_REQUEST' });
    }
    const from = Math.max(0, Number(input?.from) || 0);
    const to = Number(input?.to) > from ? Math.min(Number(input.to), probe.duration) : probe.duration;
    return { file, probe, crop, from, to, stamp: await fileStamp(file) };
  }

  /** Extracts JPEG frames at the given times (cropped, ≤ 960 px wide) into dir. */
  private async extract(file: string, times: number[], crop: Rect | null, dir: string, signal: AbortSignal, progress: (p: number) => void): Promise<string[]> {
    const out: string[] = [];
    const vf = [crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}` : '', "scale='min(960,iw)':-2"].filter(Boolean).join(',');
    for (let i = 0; i < times.length; i += 1) {
      signal.throwIfAborted();
      const target = path.join(dir, `f${String(i).padStart(6, '0')}.jpg`);
      await exec(this.deps.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-ss', String(Math.max(0, times[i])), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '3', target], { windowsHide: true, signal } as any);
      out.push(target);
      if (i % 10 === 0) progress((i / times.length) * 100);
    }
    return out;
  }

  /** Extracts frames at fps across one range in a single ffmpeg run; frame i is at from + i/fps. */
  private async extractRange(file: string, from: number, to: number, fps: number, crop: Rect | null, dir: string, prefix: string, signal: AbortSignal): Promise<string[]> {
    const vf = [`fps=${fps}`, crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}` : '', "scale='min(960,iw)':-2"].filter(Boolean).join(',');
    await exec(this.deps.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-ss', String(from), '-t', String(Math.max(1 / fps, to - from)), '-i', file, '-an', '-vf', vf, '-q:v', '3', path.join(dir, `${prefix}-%06d.jpg`)], { windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 } as any);
    return (await fs.readdir(dir)).filter(name => name.startsWith(`${prefix}-`)).sort().map(name => path.join(dir, name));
  }

  private async runHelper(helper: string, command: 'faces' | 'hands', images: string[], signal: AbortSignal): Promise<Map<string, any>> {
    const results = new Map<string, any>();
    for (let i = 0; i < images.length; i += 150) {
      const { stdout } = await exec(helper, [command, ...images.slice(i, i + 150)], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal } as any);
      for (const line of String(stdout).split('\n')) {
        if (!line.trim()) continue;
        try { const row = JSON.parse(line); results.set(row.path, row); } catch {}
      }
    }
    return results;
  }

  private async clipsInput(input: any): Promise<ClipRange[] | undefined> {
    return input?.clips ? this.deps.readClips(input.clips) : undefined;
  }

  private async faces(input: any, helper: string): Promise<AgentResult> {
    const src = await this.source(input);
    const clips = await this.clipsInput(input);
    const times = sampleTimes({ times: Array.isArray(input?.times) ? input.times.map(Number) : undefined, clips, from: src.from, to: src.to, fps: num(input?.fps, 0.05, 10, 1), perClip: input?.perClip });
    if (!times.length) return fail('E_BAD_REQUEST', 'Nothing to sample. Give times, clips or a from/to range.');
    const key = hashKey({ v: 1, stamp: src.stamp, crop: src.crop, times });
    this.deps.trackTool?.('agent_vision_faces');
    const job = this.deps.startJob('vision.faces', async (progress, signal) => {
      let samples: any[] | null = await this.deps.cache.get('vision-faces', key);
      if (!samples) {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-faces-'));
        try {
          const images = await this.extract(src.file, times.map(item => item.t), src.crop, work, signal, p => progress(p * 0.7, 'Extracting frames'));
          progress(72, 'Finding faces');
          const found = await this.runHelper(helper, 'faces', images, signal);
          samples = times.map((item, i) => {
            const row = found.get(images[i]) || {};
            return { t: item.t, clip: item.clip, eye: row.eye || null, faces: row.faces || 0, width: row.width || 0, estimated: row.estimated || undefined };
          });
          await this.deps.cache.set('vision-faces', key, samples).catch(() => {});
        } finally {
          await fs.rm(work, { recursive: true, force: true }).catch(() => {});
        }
      }
      const anchors: Record<string, { x: number; y: number; samples: number; fallback?: true }> = {};
      for (const clip of clips || []) {
        const own = (samples as any[]).filter(item => item.clip === clip.id && item.eye);
        const x = median(own.map(item => item.eye[0]));
        const y = median(own.map(item => item.eye[1]));
        anchors[clip.id] = x === null || y === null ? { ...DEFAULT_ANCHOR, samples: 0, fallback: true } : { x: r3(x), y: r3(y), samples: own.length };
      }
      const dir = path.join(await this.deps.outDir(), 'vision');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${path.parse(src.file).name.replace(/[^\w.-]+/g, '-').slice(0, 40)}-faces-${key.slice(0, 6)}.json`);
      await fs.writeFile(file, JSON.stringify({ source: src.file, crop: src.crop, anchors, samples }, null, 1));
      let applied: any;
      if (input?.apply === true && clips?.length) applied = await this.applyAnchors(src.file, anchors, input?.zoom);
      progress(100, 'Faces found');
      const none = (samples as any[]).filter(item => !item.eye).length;
      return {
        samples: (samples as any[]).length, withFace: (samples as any[]).length - none, noFace: none,
        multipleFaces: (samples as any[]).filter(item => item.faces > 1).length,
        anchors: Object.fromEntries(Object.entries(anchors).slice(0, 15)), anchorCount: Object.keys(anchors).length,
        first: (samples as any[]).slice(0, 6), files: { faces: file }, applied,
        note: `eye = [x, y] normalized ${src.crop ? 'in the crop' : 'in the frame'}, origin top-left. Clips without a face use ${DEFAULT_ANCHOR.x}, ${DEFAULT_ANCHOR.y}. Pass anchors to smoothy_edit set {clip, zoom, anchor}, or apply:true.`
      };
    });
    return this.finish(job, input, 'vision_faces');
  }

  /** Sets anchor (and zoom) on open-project clips cut from this source whose name or cut id matches. */
  private async applyAnchors(source: string, anchors: Record<string, { x: number; y: number }>, zoom: unknown): Promise<any> {
    if (!this.deps.projectClips || !this.deps.applyOps) return { applied: 0, note: 'No project open.' };
    const clips = await this.deps.projectClips();
    const ops: any[] = [];
    for (const clip of clips) {
      if (clip.kind !== 'video' || (clip.assetPath && clip.assetPath !== source)) continue;
      const key = String(clip.meta?.cutId ?? clip.name ?? '');
      const anchor = anchors[key] || anchors[key.replace(/^\S+\s+/, '')];
      if (!anchor) continue;
      ops.push({ op: 'set', clip: clip.id, anchor: [anchor.x, anchor.y], ...(Number(zoom) > 0 ? { zoom: Number(zoom) } : {}) });
    }
    if (!ops.length) return { applied: 0, note: 'No open-project clip matched these clip ids.' };
    const result = await this.deps.applyOps(ops);
    return { applied: result.ok ? ops.length : 0, error: result.ok ? undefined : result.error?.message };
  }

  private async hands(input: any, helper: string): Promise<AgentResult> {
    const src = await this.source(input);
    const clips = await this.clipsInput(input);
    const fps = num(input?.fps, 0.5, 10, 3);
    const minSpan = num(input?.minSpan, 0, 10, 0.4);
    const ranges = (clips?.length ? clips : [{ id: '', srcIn: src.from, srcOut: src.to }]).filter(range => range.srcOut > range.srcIn).slice(0, 2000);
    if (!ranges.length) return fail('E_BAD_REQUEST', 'Nothing to sample.');
    const key = hashKey({ v: 1, stamp: src.stamp, crop: src.crop, fps, ranges: ranges.map(range => [range.id, range.srcIn, range.srcOut]) });
    this.deps.trackTool?.('agent_vision_hands');
    const job = this.deps.startJob('vision.hands', async (progress, signal) => {
      let samples: any[] | null = await this.deps.cache.get('vision-hands', key);
      if (!samples) {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-hands-'));
        try {
          const images: string[] = [];
          const meta: { t: number; clip?: string }[] = [];
          for (const [r, range] of ranges.entries()) {
            const files = await this.extractRange(src.file, range.srcIn, range.srcOut, fps, src.crop, work, `r${r}`, signal);
            files.forEach((image, i) => { images.push(image); meta.push({ t: r3(range.srcIn + i / fps), clip: range.id || undefined }); });
            progress(((r + 1) / ranges.length) * 60, 'Extracting frames');
          }
          progress(62, `Finding hands in ${images.length} frames`);
          const found = await this.runHelper(helper, 'hands', images, signal);
          samples = meta.map((item, i) => ({ t: item.t, clip: item.clip, face: Boolean(found.get(images[i])?.face), covered: Boolean(found.get(images[i])?.covered), points: found.get(images[i])?.points || 0 }));
          await this.deps.cache.set('vision-hands', key, samples).catch(() => {});
        } finally {
          await fs.rm(work, { recursive: true, force: true }).catch(() => {});
        }
      }
      const spans: { from: number; to: number; clips: string[] }[] = [];
      for (const range of ranges) {
        const own = (samples as any[]).filter(item => (item.clip || '') === (range.id || '') || !range.id);
        for (const span of flaggedSpans(own.map(item => ({ t: item.t, flag: item.covered })), 1 / fps, minSpan)) spans.push({ ...span, clips: range.id ? [range.id] : [] });
      }
      const dir = path.join(await this.deps.outDir(), 'vision');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${path.parse(src.file).name.replace(/[^\w.-]+/g, '-').slice(0, 40)}-hands-${key.slice(0, 6)}.json`);
      await fs.writeFile(file, JSON.stringify({ source: src.file, crop: src.crop, fps, minSpan, spans, samples }, null, 1));
      progress(100, 'Hands checked');
      return {
        samples: (samples as any[]).length, covered: (samples as any[]).filter(item => item.covered).length, noFace: (samples as any[]).filter(item => !item.face).length,
        spans: spans.slice(0, 25), spanCount: spans.length, files: { hands: file },
        note: 'Spans are source seconds where a hand covers the upper face. Check each one (false positives happen) and cover it with a full-screen graphic.'
      };
    });
    return this.finish(job, input, 'vision_hands_on_face');
  }

  private async layoutScan(input: any): Promise<AgentResult> {
    const src = await this.source(input);
    const regions: RegionSpec[] = (Array.isArray(input?.regions) ? input.regions : []).slice(0, 12).map((region: any, i: number) => ({
      name: String(region?.name || `region${i + 1}`),
      rect: (Array.isArray(region?.rect) ? region.rect : [0, 0, src.probe.video!.width, src.probe.video!.height]).map(Number) as Rect,
      measure: region?.measure === 'color' || region?.measure === 'match' ? region.measure : 'brightness',
      color: region?.color,
      reference: Number.isFinite(Number(region?.reference)) ? Number(region.reference) : undefined,
      classes: Array.isArray(region?.classes) ? region.classes.map((item: any) => ({ label: String(item?.label || ''), min: item?.min !== undefined ? Number(item.min) : undefined, max: item?.max !== undefined ? Number(item.max) : undefined })) : undefined
    }));
    if (!regions.length) return fail('E_BAD_REQUEST', 'Provide regions: [{name, rect:[x,y,w,h], measure:"brightness"|"color"|"match", classes:[{label,min?,max?}]}].');
    const W = src.probe.video!.width; const H = src.probe.video!.height;
    for (const region of regions) {
      const [x, y, w, h] = region.rect;
      if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || x + w > W || y + h > H || w < 4 || h < 4) return fail('E_BAD_REQUEST', `${region.name}: rect must fit inside ${W}x${H}.`);
      if (region.measure === 'color' && !(region.color?.r && region.color?.g && region.color?.b)) return fail('E_BAD_REQUEST', `${region.name}: colour needs color {r:[min,max], g:[min,max], b:[min,max]}.`);
      if (region.measure === 'match' && region.reference === undefined) return fail('E_BAD_REQUEST', `${region.name}: match needs reference (a source time where the region looks right).`);
    }
    const fps = num(input?.fps, 0.2, 10, 4);
    const scale = Math.min(1, 960 / W);
    const sw = Math.max(2, 2 * Math.round((W * scale) / 2));
    const sh = Math.max(2, 2 * Math.round((H * scale) / 2));
    const scaled = (rect: Rect): Rect => {
      const x = Math.floor(rect[0] * sw / W); const y = Math.floor(rect[1] * sh / H);
      return [x, y, Math.max(1, Math.min(sw - x, Math.round(rect[2] * sw / W))), Math.max(1, Math.min(sh - y, Math.round(rect[3] * sh / H)))];
    };
    const clips = await this.clipsInput(input);
    const key = hashKey({ v: 1, stamp: src.stamp, from: src.from, to: src.to, fps, regions });
    this.deps.trackTool?.('agent_vision_layout');
    const job = this.deps.startJob('vision.layout', async (progress, signal) => {
      let samples: { t: number; values: number[] }[] | null = await this.deps.cache.get('layout', key);
      if (!samples) {
        const refs = new Map<number, Float64Array>();
        for (const [i, region] of regions.entries()) {
          if (region.measure !== 'match') continue;
          await streamFrames(this.deps.ffmpeg, src.file, { from: region.reference as number, to: (region.reference as number) + 1 / fps, fps, width: sw, height: sh, signal, onFrame: (_t, frame) => { if (!refs.has(i)) refs.set(i, histogram(frame, sw, scaled(region.rect))); } });
          if (!refs.has(i)) throw new Error(`${region.name}: could not read the reference frame.`);
        }
        const rows: { t: number; values: number[] }[] = [];
        await streamFrames(this.deps.ffmpeg, src.file, {
          from: src.from, to: src.to, fps, width: sw, height: sh, signal, onProgress: p => progress(p, `Scanning ${Math.round(p)}%`),
          onFrame: (t, frame) => rows.push({ t, values: regions.map((region, i) => {
            const rect = scaled(region.rect);
            const value = region.measure === 'brightness' ? brightness(frame, sw, rect) : region.measure === 'color' ? colorFraction(frame, sw, rect, region.color!) : intersection(histogram(frame, sw, rect), refs.get(i)!);
            return Number(value.toFixed(4));
          }) })
        });
        samples = rows;
        await this.deps.cache.set('layout', key, samples).catch(() => {});
      }
      const step = 1 / fps;
      const report = regions.map((region, i) => {
        const labelled = (samples as any[]).map(row => ({ t: row.t, label: classify(row.values[i], region.classes) }));
        const spans = labelSpans(labelled, step);
        const share: Record<string, number> = {};
        for (const item of labelled) share[item.label] = (share[item.label] || 0) + 1;
        const common = Object.entries(share).sort((a, b) => b[1] - a[1])[0]?.[0];
        const clipsWith: Record<string, string[]> = {};
        for (const clip of clips || []) {
          const inside = labelled.filter(item => item.t >= clip.srcIn && item.t < clip.srcOut);
          for (const label of new Set(inside.map(item => item.label))) if (label !== common) (clipsWith[label] ||= []).push(clip.id);
        }
        return { name: region.name, measure: region.measure, seconds: Object.fromEntries(Object.entries(share).map(([label, n]) => [label, r3(n * step)])), mostly: common, spans, clipsWith };
      });
      const dir = path.join(await this.deps.outDir(), 'vision');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${path.parse(src.file).name.replace(/[^\w.-]+/g, '-').slice(0, 40)}-layout-${key.slice(0, 6)}.json`);
      await fs.writeFile(file, JSON.stringify({ source: src.file, fps, regions, report, samples }, null, 1));
      progress(100, 'Layout scanned');
      return {
        samples: (samples as any[]).length,
        regions: report.map(item => ({ name: item.name, mostly: item.mostly, seconds: item.seconds, spans: item.spans.filter(span => span.label !== item.mostly).slice(0, 15), clipsWith: Object.keys(item.clipsWith).length ? item.clipsWith : undefined })),
        files: { layout: file },
        note: 'Spans list the time ranges (source seconds) where a region is not in its usual state, e.g. another person in the speaker tile or no whiteboard in the share area.'
      };
    });
    return this.finish(job, input, 'layout_scan');
  }

  private async finish(job: { id: string; status: string }, input: any, action: string): Promise<AgentResult> {
    const waitMs = Math.max(0, Math.min(120000, input?.waitMs === undefined ? 20000 : Number(input.waitMs) || 0));
    const view = await this.deps.waitJob(job.id, waitMs);
    if (view?.status === 'done') return ok({ action, jobId: job.id, ...(view.result as any) });
    if (view && view.status !== 'running') return fail('E_INTERNAL', view.error || `${action} failed.`);
    return ok({ action, jobId: job.id, status: 'running', progress: view?.progress ?? 0, etaSeconds: view?.etaSeconds ?? null, next: `Wait with smoothy_jobs action "wait" id "${job.id}".` });
  }
}
