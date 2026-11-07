import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const run = promisify(execFile);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg']);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aif', '.aiff', '.wma']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

export type SequenceFrame = {
  path: string;
  sourceTime: number;
  clip: any;
  trackIndex: number;
  fps: number;
};

export function mediaKind(file: string): 'video' | 'audio' | 'image' | null {
  const extension = path.extname(file).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return null;
}

export function mimeForMedia(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

function allowedRoots(home: string, userData: string): string[] {
  const roots = [home, userData, os.tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/Volumes'];
  return roots.filter(Boolean).map(root => path.resolve(root));
}

/**
 * Agents may only touch existing media under normal user locations. This is not
 * a sandbox for a hostile local process (the bearer token is the auth boundary)
 * but it prevents a prompt-injected agent from probing arbitrary system files.
 */
export async function resolveMediaPath(input: unknown, home: string, userData: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) throw Object.assign(new Error('Choose a media file path.'), { code: 'E_BAD_REQUEST' });
  const candidate = path.resolve(input.trim());
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw Object.assign(new Error('That media file does not exist.'), { code: 'E_NOT_FOUND' });
  }
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error('That path is not a file.'), { code: 'E_BAD_REQUEST' });
  if (!mediaKind(real)) throw Object.assign(new Error('That file type is not supported.'), { code: 'E_UNSUPPORTED_MEDIA' });
  const roots = allowedRoots(home, userData);
  const allowed = process.platform === 'win32'
    ? /^[a-zA-Z]:\\/.test(real) || roots.some(root => real === root || real.startsWith(root + path.sep))
    : roots.some(root => real === root || real.startsWith(root + path.sep));
  if (!allowed) throw Object.assign(new Error('That folder is outside the media locations Smoothy can read.'), { code: 'E_PATH_DENIED' });
  return real;
}

export function formatTimecode(seconds: number, fps = 30): string {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const nominal = Math.max(1, Math.round(rate));
  const totalFrames = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
  const frames = totalFrames % nominal;
  const totalSeconds = Math.floor(totalFrames / nominal);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, mins, secs, frames].map(value => String(value).padStart(2, '0')).join(':');
}

export function sequenceFrameAt(sequence: any, time: number): SequenceFrame | null {
  if (!sequence?.hasSequence) return null;
  const fps = Number(sequence.fps) || 30;
  const duration = Number(sequence.duration) || 0;
  const at = Math.max(0, Math.min(Number(time) || 0, Math.max(0, duration - 0.001)));
  const tracks = Array.isArray(sequence.videoTracks) ? [...sequence.videoTracks] : [];
  tracks.sort((a, b) => Number(b.index) - Number(a.index));
  for (const track of tracks) {
    for (const clip of track.clips || []) {
      if (!clip || clip.disabled || !clip.path) continue;
      const start = Number(clip.start) || 0;
      const end = Number(clip.end) || 0;
      if (at + 0.0001 < start || at >= end) continue;
      const offset = at - start;
      const inPoint = Number(clip.inPoint) || 0;
      const outPoint = Number(clip.outPoint) || 0;
      const sourceTime = clip.reversed ? Math.max(0, outPoint - offset) : Math.max(0, inPoint + offset);
      return { path: clip.path, sourceTime, clip, trackIndex: Number(track.index) || 0, fps };
    }
  }
  return null;
}

export type ProbeResult = {
  path: string;
  duration: number;
  size: number;
  format: string;
  video: null | { codec: string; width: number; height: number; fps: number; duration: number };
  audio: null | { codec: string; channels: number; sampleRate: number; duration: number };
};

function ratio(value: unknown): number {
  const text = String(value || '');
  const [numerator, denominator] = text.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator) return numerator / denominator;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

export async function probeMedia(ffprobe: string, file: string): Promise<ProbeResult> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream: any) => stream.codec_type === 'video');
  const audioStream = streams.find((stream: any) => stream.codec_type === 'audio');
  return {
    path: file,
    duration: Number(parsed.format?.duration) || Number(videoStream?.duration) || Number(audioStream?.duration) || 0,
    size: Number(parsed.format?.size) || 0,
    format: String(parsed.format?.format_name || ''),
    video: videoStream ? {
      codec: String(videoStream.codec_name || ''),
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
      fps: ratio(videoStream.r_frame_rate || videoStream.avg_frame_rate),
      duration: Number(videoStream.duration) || 0
    } : null,
    audio: audioStream ? {
      codec: String(audioStream.codec_name || ''),
      channels: Number(audioStream.channels) || 0,
      sampleRate: Number(audioStream.sample_rate) || 0,
      duration: Number(audioStream.duration) || 0
    } : null
  };
}

export type FrameResult = {
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
  sourceTime: number;
  path: string;
  cached: boolean;
};

function frameKey(file: string, mtimeMs: number, time: number, width: number): string {
  return createHash('sha1').update(`${file}\0${mtimeMs}\0${time.toFixed(3)}\0${width}`).digest('hex');
}

export async function extractFrame(options: {
  ffmpeg: string;
  file: string;
  time: number;
  width?: number;
  cacheDir: string;
  cache?: boolean;
}): Promise<FrameResult> {
  const width = Math.max(160, Math.min(1920, Math.round(options.width || 960)));
  const stat = await fs.stat(options.file);
  const key = frameKey(options.file, stat.mtimeMs, options.time, width);
  const target = path.join(options.cacheDir, `${key}.jpg`);
  await fs.mkdir(options.cacheDir, { recursive: true });
  let cached = true;
  try {
    await fs.access(target);
  } catch {
    cached = false;
  }
  if (!cached || options.cache === false) {
    const kind = mediaKind(options.file);
    if (kind === 'image') {
      await sharp(options.file, { limitInputPixels: 16384 * 16384 })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 86, mozjpeg: true })
        .toFile(target);
    } else {
      await run(options.ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, options.time)),
        '-i', options.file,
        '-frames:v', '1',
        '-vf', `scale=${width}:-2:force_original_aspect_ratio=decrease`,
        '-q:v', '3',
        '-y', target
      ], { maxBuffer: 8 * 1024 * 1024 });
    }
  }
  const metadata = await sharp(target).metadata();
  return {
    buffer: await fs.readFile(target),
    mime: 'image/jpeg',
    width: metadata.width || width,
    height: metadata.height || 0,
    sourceTime: options.time,
    path: target,
    cached
  };
}

export async function contactSheet(options: {
  ffmpeg: string;
  file: string;
  times: number[];
  width?: number;
  cacheDir: string;
  fps?: number;
}): Promise<FrameResult> {
  const times = options.times.filter(value => Number.isFinite(value) && value >= 0).slice(0, 24);
  if (!times.length) throw Object.assign(new Error('Choose at least one timestamp.'), { code: 'E_BAD_REQUEST' });
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(times.length))));
  const rows = Math.ceil(times.length / columns);
  const cellWidth = Math.max(160, Math.min(480, Math.round(options.width || 320)));
  const cellHeight = Math.round(cellWidth * 9 / 16);
  const labelHeight = 22;
  const gap = 8;
  const canvasWidth = columns * cellWidth + (columns + 1) * gap;
  const canvasHeight = rows * (cellHeight + labelHeight) + (rows + 1) * gap;
  await fs.mkdir(options.cacheDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(options.cacheDir, 'sheet-'));
  try {
    const layers: sharp.OverlayOptions[] = [];
    for (let index = 0; index < times.length; index += 1) {
      const frame = await extractFrame({ ...options, time: times[index], width: cellWidth, cacheDir: options.cacheDir });
      const image = await sharp(frame.buffer)
        .resize(cellWidth, cellHeight, { fit: 'cover' })
        .jpeg({ quality: 84 })
        .toBuffer();
      const column = index % columns;
      const row = Math.floor(index / columns);
      layers.push({
        input: image,
        left: gap + column * (cellWidth + gap),
        top: gap + row * (cellHeight + labelHeight + gap)
      });
    }
    let labels = '';
    for (let index = 0; index < times.length; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = gap + column * (cellWidth + gap) + 6;
      const y = gap + row * (cellHeight + labelHeight + gap) + cellHeight + 16;
      labels += `<text x="${x}" y="${y}" fill="#f5f3ec" font-family="Helvetica, Arial, sans-serif" font-size="13">${formatTimecode(times[index], options.fps || 30)}</text>`;
    }
    const labelLayer = Buffer.from(`<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`);
    const buffer = await sharp({
      create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 20, g: 20, b: 20 } }
    })
      .composite([...layers, { input: labelLayer, left: 0, top: 0 }])
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    const key = createHash('sha1').update(`${options.file}\0${times.join(',')}\0${cellWidth}`).digest('hex');
    const target = path.join(options.cacheDir, `sheet-${key}.jpg`);
    await fs.writeFile(target, buffer);
    return { buffer, mime: 'image/jpeg', width: canvasWidth, height: canvasHeight, sourceTime: times[0], path: target, cached: false };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

export function parseDataUrl(dataUrl: unknown): { buffer: Buffer; mime: string; extension: string } {
  if (typeof dataUrl !== 'string') throw Object.assign(new Error('A screenshot image is required.'), { code: 'E_BAD_REQUEST' });
  const match = /^data:(image\/(png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) throw Object.assign(new Error('The screenshot must be a PNG or JPEG data URL.'), { code: 'E_BAD_REQUEST' });
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const buffer = Buffer.from(match[3].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw Object.assign(new Error('The screenshot is empty or larger than 12 MB.'), { code: 'E_BAD_REQUEST' });
  return { buffer, mime, extension };
}

export async function toDataUrl(buffer: Buffer, mime: string): Promise<string> {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
