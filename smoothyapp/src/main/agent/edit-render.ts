/**
 * Renders a headless edit project with the ffmpeg bundled in the app.
 *
 * One pass builds a filter graph: a black canvas, every visible picture/text
 * clip overlaid in track order, and every audio clip delayed, levelled, faded and
 * mixed. Long timelines are split into chunks that are each a final-quality
 * encode, then joined without re-encoding.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { clipEnd, projectDuration, type EditClip, type EditProject, type TextStyle } from './edit-project';

export type RenderPreset = 'draft' | 'standard' | 'high';

const PRESETS: Record<RenderPreset, { preset: string; crf: number; audio: string; scale: number }> = {
  draft: { preset: 'ultrafast', crf: 30, audio: '96k', scale: 0.5 },
  standard: { preset: 'veryfast', crf: 21, audio: '192k', scale: 1 },
  high: { preset: 'medium', crf: 17, audio: '256k', scale: 1 }
};

export const MAX_ARG_CHARS = process.platform === 'win32' ? 24000 : 180000;
const CHUNK_CLIPS = 90;

export type PlanOptions = {
  workDir: string;
  from?: number;
  to?: number;
  /** Output width in pixels; height follows the project aspect ratio. */
  width?: number;
  mode: 'video' | 'frame' | 'audio';
  audio?: boolean;
  /** Audio mode only: mix just these tracks (for example ['A1']). */
  audioTracks?: string[];
  preset?: RenderPreset;
  loudnorm?: boolean;
  output: string;
  tag?: string;
};

export type RenderPlan = { args: string[]; duration: number; inputs: number; argChars: number; empty: boolean };

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
const fixed = (value: number): string => Number(value.toFixed(4)).toString();

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines.slice(0, 6) : [''];
}

/** Transparent full-frame PNG with the text placed and boxed. Cached by content. */
export async function renderTextPng(clip: EditClip, width: number, height: number, dir: string): Promise<string> {
  const style: TextStyle = clip.style || {};
  const size = Math.round((style.size || 52) * (height / 1080));
  const key = createHash('sha1').update(JSON.stringify([clip.text, style, width, height])).digest('hex').slice(0, 16);
  const target = path.join(dir, `text-${key}.png`);
  try {
    await fs.access(target);
    return target;
  } catch {
    // Render below.
  }
  const maxChars = Math.max(8, Math.floor((width * 0.84) / (size * 0.56)));
  const lines = wrapText(clip.text || '', maxChars);
  const lineHeight = Math.round(size * 1.25);
  const textHeight = lines.length * lineHeight;
  const widest = Math.max(...lines.map(line => line.length)) * size * 0.56;
  const padX = Math.round(size * 0.5);
  const padY = Math.round(size * 0.3);
  const boxWidth = Math.min(width, Math.round(widest + padX * 2));
  const boxHeight = textHeight + padY * 2;
  const position = style.position || 'bottom';
  const top = position === 'top' ? Math.round(height * 0.07) : position === 'center' ? Math.round((height - boxHeight) / 2) : Math.round(height * 0.92 - boxHeight);
  const left = Math.round((width - boxWidth) / 2);
  const color = style.color || '#ffffff';
  const background = style.background;
  let rect = '';
  if (background) {
    const hex = background.replace('#', '');
    const rgb = hex.length >= 6 ? `#${hex.slice(0, 6)}` : `#${hex.slice(0, 3)}`;
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
    rect = `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" rx="${Math.round(size * 0.2)}" fill="${rgb}" fill-opacity="${alpha.toFixed(3)}"/>`;
  }
  const shadow = background ? '' : ' stroke="#000000" stroke-opacity="0.85" stroke-width="' + Math.max(2, Math.round(size * 0.08)) + '" paint-order="stroke"';
  const body = lines.map((line, index) => `<text x="${width / 2}" y="${top + padY + Math.round(size * 0.95) + index * lineHeight}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="${style.bold === false ? 400 : 700}" font-size="${size}" fill="${color}"${shadow}>${xml(line)}</text>`).join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${rect}${body}</svg>`;
  await fs.mkdir(dir, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(target);
  return target;
}

type Visible = { clip: EditClip; a: number; b: number; offset: number; srcIn: number; srcLen: number };

function visibleIn(project: EditProject, clip: EditClip, from: number, to: number): Visible | null {
  const start = clip.start;
  const end = clipEnd(clip);
  const a = Math.max(start, from);
  const b = Math.min(end, to);
  if (b - a < 1 / (project.fps * 2)) return null;
  return { clip, a, b, offset: a - from, srcIn: clip.in + (a - start) * clip.speed, srcLen: (b - a) * clip.speed };
}

const trackRank = (clip: EditClip): number => (clip.track[0] === 'T' ? 100 : 0) + (Number(clip.track.slice(1)) || 1);

function tempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 1e-6) return '';
  const parts: string[] = [];
  let rest = speed;
  while (rest > 2) { parts.push('atempo=2'); rest /= 2; }
  while (rest < 0.5) { parts.push('atempo=0.5'); rest /= 0.5; }
  parts.push(`atempo=${fixed(rest)}`);
  return parts.join(',') + ',';
}

export async function planRender(project: EditProject, options: PlanOptions): Promise<RenderPlan> {
  const total = projectDuration(project);
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(total, options.to ?? total);
  const duration = Math.max(0, to - from);
  const outW = even(options.width || project.width);
  const outH = even((outW * project.height) / project.width);
  const fps = project.fps;
  const preset = PRESETS[options.preset || 'standard'];
  const visible: Visible[] = [];
  for (const clip of project.clips) {
    const item = visibleIn(project, clip, from, to);
    if (item) visible.push(item);
  }
  const wantVideo = options.mode !== 'audio';
  const pictures = visible
    .filter(item => wantVideo && item.clip.kind !== 'audio')
    .sort((x, y) => trackRank(x.clip) - trackRank(y.clip) || x.a - y.a);
  const sounds = options.audio === false || options.mode === 'frame'
    ? []
    : visible.filter(item => item.clip.kind === 'audio' && !item.clip.mute && item.clip.asset && project.assets[item.clip.asset]?.hasAudio && (!options.audioTracks?.length || options.audioTracks.includes(item.clip.track)));

  const inputs: string[] = [];
  const graph: string[] = [];
  if (wantVideo) graph.push(`color=c=black:s=${outW}x${outH}:r=${fps}:d=${fixed(Math.max(duration, 1 / fps))}[base0]`);

  let index = 0;
  let layer = 0;
  for (const item of pictures) {
    const { clip } = item;
    const length = item.b - item.a;
    if (clip.kind === 'text') {
      const png = await renderTextPng(clip, outW, outH, path.join(options.workDir, 'text'));
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', fixed(length), '-i', png);
    } else {
      const asset = project.assets[clip.asset || ''];
      if (!asset) continue;
      if (asset.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', fixed(length), '-i', asset.path);
      else inputs.push('-ss', fixed(item.srcIn), '-t', fixed(item.srcLen + 0.05), '-i', asset.path);
    }
    const label = `p${layer}`;
    const filters: string[] = [];
    filters.push(clip.speed !== 1 && clip.kind === 'video' ? `setpts=(PTS-STARTPTS)/${fixed(clip.speed)}` : 'setpts=PTS-STARTPTS');
    filters.push(`fps=${fps}`);
    if (clip.kind !== 'text') {
      filters.push(clip.fit === 'contain'
        ? `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=black`
        : `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`);
      filters.push('setsar=1');
    }
    const needsAlpha = clip.kind === 'text' || clip.opacity < 1 || clip.fadeIn > 0 || clip.fadeOut > 0;
    filters.push(clip.kind === 'text' ? 'format=rgba' : needsAlpha ? 'format=yuva420p' : 'format=yuv420p');
    const startsHere = Math.abs(item.a - clip.start) < 1e-6;
    const endsHere = Math.abs(item.b - clipEnd(clip)) < 1e-6;
    if (clip.fadeIn > 0 && startsHere) filters.push(`fade=t=in:st=0:d=${fixed(Math.min(clip.fadeIn, length))}:alpha=1`);
    if (clip.fadeOut > 0 && endsHere) {
      const d = Math.min(clip.fadeOut, length);
      filters.push(`fade=t=out:st=${fixed(Math.max(0, length - d))}:d=${fixed(d)}:alpha=1`);
    }
    if (clip.opacity < 1) filters.push(`colorchannelmixer=aa=${fixed(clip.opacity)}`);
    filters.push(`setpts=PTS+${fixed(item.offset)}/TB`);
    graph.push(`[${index}:v]${filters.join(',')}[${label}]`);
    graph.push(`[base${layer}][${label}]overlay=eof_action=pass:format=auto[base${layer + 1}]`);
    index += 1;
    layer += 1;
  }
  if (wantVideo) graph.push(`[base${layer}]format=yuv420p[vout]`);

  const mixLabels: string[] = [];
  if (options.mode !== 'frame' && options.audio !== false) {
    let audioIndex = 0;
    for (const item of sounds) {
      const { clip } = item;
      const asset = project.assets[clip.asset || ''];
      inputs.push('-ss', fixed(item.srcIn), '-t', fixed(item.srcLen + 0.05), '-i', asset.path);
      const length = item.b - item.a;
      const filters = ['asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
      const tempo = tempoChain(clip.speed);
      if (tempo) filters.push(tempo.slice(0, -1));
      if (clip.volume) filters.push(`volume=${fixed(clip.volume)}dB`);
      filters.push(`atrim=duration=${fixed(length)}`, 'asetpts=PTS-STARTPTS');
      const startsHere = Math.abs(item.a - clip.start) < 1e-6;
      const endsHere = Math.abs(item.b - clipEnd(clip)) < 1e-6;
      if (clip.fadeIn > 0 && startsHere) filters.push(`afade=t=in:st=0:d=${fixed(Math.min(clip.fadeIn, length))}`);
      if (clip.fadeOut > 0 && endsHere) {
        const d = Math.min(clip.fadeOut, length);
        filters.push(`afade=t=out:st=${fixed(Math.max(0, length - d))}:d=${fixed(d)}`);
      }
      const ms = Math.round(item.offset * 1000);
      if (ms > 0) filters.push(`adelay=${ms}|${ms}`);
      const label = `s${audioIndex}`;
      graph.push(`[${index}:a]${filters.join(',')}[${label}]`);
      mixLabels.push(`[${label}]`);
      index += 1;
      audioIndex += 1;
    }
    graph.push(`anullsrc=r=48000:cl=stereo:d=${fixed(Math.max(duration, 0.1))}[sil]`);
    mixLabels.push('[sil]');
    const tail = `${options.loudnorm ? 'loudnorm=I=-14:TP=-1.5:LRA=11,' : ''}alimiter=limit=0.97`;
    graph.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=longest:dropout_transition=0,atrim=duration=${fixed(duration)},${tail}[aout]`);
  }

  const script = path.join(options.workDir, `graph-${options.tag || 'main'}.txt`);
  await fs.mkdir(options.workDir, { recursive: true });
  await fs.writeFile(script, graph.join(';\n'));

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...inputs, '-filter_complex_script', script];
  if (options.mode === 'audio') {
    args.push('-map', '[aout]', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', fixed(duration), '-y', options.output);
  } else if (options.mode === 'frame') {
    args.push('-map', '[vout]', '-frames:v', '1', '-q:v', '3', '-y', options.output);
  } else {
    args.push('-map', '[vout]');
    if (mixLabels.length) args.push('-map', '[aout]');
    args.push(
      '-c:v', 'libx264', '-preset', preset.preset, '-crf', String(preset.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
      ...(mixLabels.length ? ['-c:a', 'aac', '-b:a', preset.audio, '-ar', '48000'] : []),
      '-t', fixed(duration), '-movflags', '+faststart', '-y', options.output
    );
  }
  return { args, duration, inputs: index, argChars: args.join(' ').length, empty: visible.length === 0 };
}

export function runFfmpeg(ffmpeg: string, args: string[], options: { duration?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    let buffer = '';
    const abort = () => child.kill('SIGKILL');
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (match && options.duration && options.onProgress) options.onProgress(Math.min(1, Number(match[1]) / 1e6 / options.duration));
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', chunk => { tail = (tail + chunk.toString()).slice(-2000); });
    child.on('error', error => reject(error));
    child.on('close', code => {
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) reject(Object.assign(new Error('Canceled'), { canceled: true }));
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(`Render failed: ${tail.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}`}`), { code: 'E_INTERNAL' }));
    });
  });
}

/** One composited frame as a JPEG file. Only clips active at `time` are opened. */
export async function renderFrame(project: EditProject, ffmpeg: string, time: number, width: number, workDir: string, tag: string): Promise<string> {
  const total = projectDuration(project);
  const at = Math.max(0, Math.min(time, Math.max(0, total - 1 / project.fps)));
  const output = path.join(workDir, `frame-${tag}.jpg`);
  const plan = await planRender(project, { workDir, from: at, to: at + 1 / project.fps, width, mode: 'frame', output, tag });
  await runFfmpeg(ffmpeg, plan.args);
  return output;
}

/** Chunk boundaries so each chunk opens a bounded number of clips. */
export function chunkBoundaries(project: EditProject, from: number, to: number, maxClips = CHUNK_CLIPS): number[] {
  const events = project.clips.map(clip => clip.start).filter(time => time > from && time < to).sort((a, b) => a - b);
  const bounds = [from];
  let last = from;
  for (const time of events) {
    const open = project.clips.filter(clip => clip.start < time && clipEnd(clip) > last).length;
    if (open >= maxClips && time - last > 1) {
      bounds.push(time);
      last = time;
    }
  }
  bounds.push(to);
  return bounds;
}

export type ExportOptions = {
  ffmpeg: string;
  workDir: string;
  output: string;
  preset?: RenderPreset;
  width?: number;
  from?: number;
  to?: number;
  loudnorm?: boolean;
  /** Clips opened per chunk when a long timeline is split. Default 90. */
  chunkClips?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
};

export async function exportProject(project: EditProject, options: ExportOptions): Promise<{ output: string; duration: number; chunks: number }> {
  const total = projectDuration(project);
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(total, options.to ?? total);
  if (to - from < 1 / project.fps) throw Object.assign(new Error('The timeline is empty. Add clips before exporting.'), { code: 'E_BAD_REQUEST' });
  const base = { workDir: options.workDir, width: options.width, mode: 'video' as const, preset: options.preset, loudnorm: options.loudnorm };
  const single = await planRender(project, { ...base, from, to, output: options.output, tag: 'single' });
  const inRange = project.clips.filter(clip => clip.start < to && clipEnd(clip) > from).length;
  const chunkClips = options.chunkClips || CHUNK_CLIPS;
  const needChunks = single.argChars > MAX_ARG_CHARS || inRange > chunkClips * 2;
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  if (!needChunks) {
    options.onProgress?.(3, 'Rendering');
    await runFfmpeg(options.ffmpeg, single.args, {
      duration: single.duration,
      signal: options.signal,
      onProgress: fraction => options.onProgress?.(3 + fraction * 95, 'Rendering')
    });
    return { output: options.output, duration: single.duration, chunks: 1 };
  }
  const bounds = chunkBoundaries(project, from, to, chunkClips);
  const parts: string[] = [];
  const spans = bounds.slice(1).map((end, i) => [bounds[i], end] as const);
  const full = to - from;
  let done = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const [start, end] = spans[i];
    const part = path.join(options.workDir, `part-${i}.mp4`);
    const plan = await planRender(project, { ...base, from: start, to: end, output: part, tag: `p${i}`, loudnorm: false });
    if (plan.argChars > MAX_ARG_CHARS) throw Object.assign(new Error('This part of the timeline has too many clips to render at once. Reduce overlapping clips or export a shorter range.'), { code: 'E_BAD_REQUEST' });
    await runFfmpeg(options.ffmpeg, plan.args, {
      duration: plan.duration,
      signal: options.signal,
      onProgress: fraction => options.onProgress?.(3 + ((done + fraction * (end - start)) / full) * 90, `Rendering part ${i + 1} of ${spans.length}`)
    });
    done += end - start;
    parts.push(part);
  }
  const list = path.join(options.workDir, 'parts.txt');
  await fs.writeFile(list, parts.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  options.onProgress?.(95, 'Joining parts');
  await runFfmpeg(options.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', options.output], { signal: options.signal });
  return { output: options.output, duration: full, chunks: spans.length };
}

