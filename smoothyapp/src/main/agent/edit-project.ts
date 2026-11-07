/**
 * Headless Smoothy edit project.
 *
 * A compact, NLE-free timeline an agent can build with a handful of cheap
 * operations. Everything is plain JSON, in seconds, snapped to project frames.
 * Nothing here touches ffmpeg or the disk; see edit-render.ts and edit-store.ts.
 */

import { randomUUID } from 'node:crypto';

export type EditAsset = {
  id: string;
  name: string;
  path: string;
  kind: 'video' | 'audio' | 'image';
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Where the file came from, so licences and credits travel with it. */
  source?: { provider?: string; license?: string; credit?: string; url?: string };
};

export type TextStyle = {
  size?: number;
  color?: string;
  background?: string;
  position?: 'top' | 'center' | 'bottom';
  bold?: boolean;
};

export type EditClip = {
  id: string;
  /** Track name such as V1, V2, A1, A2, T1 (text over video). */
  track: string;
  kind: 'video' | 'audio' | 'image' | 'text';
  asset?: string;
  text?: string;
  style?: TextStyle;
  /** Timeline start in seconds. */
  start: number;
  /** Source range in seconds. For text and images only the length matters. */
  in: number;
  out: number;
  speed: number;
  /** Volume in dB. 0 keeps the level. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  mute: boolean;
  opacity: number;
  fit: 'cover' | 'contain';
  /** Clips created together (video + its audio) move and trim together. */
  link?: string;
};

export type EditProject = {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  assets: Record<string, EditAsset>;
  clips: EditClip[];
};

export type EditError = { code: 'E_BAD_REQUEST' | 'E_NOT_FOUND'; message: string };

export class EditOpError extends Error {
  code: EditError['code'];
  constructor(message: string, code: EditError['code'] = 'E_BAD_REQUEST') {
    super(message);
    this.code = code;
  }
}

const MAX_CLIPS = 4000;
const MAX_OPS = 500;
export const DEFAULT_FPS = 30;

export function snap(project: Pick<EditProject, 'fps'>, seconds: number): number {
  const fps = project.fps || DEFAULT_FPS;
  return Math.round(Math.max(0, seconds) * fps) / fps;
}

function num(value: unknown, label: string, fallback?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new EditOpError(`${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new EditOpError(`${label} must be a number.`);
  return n;
}

export function createProject(input: { name?: string; width?: number; height?: number; fps?: number } = {}): EditProject {
  const width = Math.round(Math.max(160, Math.min(7680, Number(input.width) || 1920)));
  const height = Math.round(Math.max(160, Math.min(4320, Number(input.height) || 1080)));
  const fps = Math.max(1, Math.min(120, Number(input.fps) || DEFAULT_FPS));
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID().slice(0, 8),
    name: String(input.name || 'Untitled edit').slice(0, 80),
    width: width - (width % 2),
    height: height - (height % 2),
    fps,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    assets: {},
    clips: []
  };
}

export function projectDuration(project: EditProject): number {
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

export function clipLength(clip: Pick<EditClip, 'in' | 'out' | 'speed'>): number {
  return Math.max(0, (clip.out - clip.in) / (clip.speed || 1));
}

export function clipEnd(clip: EditClip): number {
  return clip.start + clipLength(clip);
}

const trackKind = (track: string): 'V' | 'A' | 'T' => (track[0]?.toUpperCase() as 'V' | 'A' | 'T');

function normalizeTrack(track: unknown, fallback: string): string {
  const text = String(track || fallback).trim().toUpperCase();
  if (!/^[VAT]\d{1,2}$/.test(text)) throw new EditOpError(`Track "${text}" is not valid. Use V1, V2, A1, A2 or T1.`);
  return text;
}

function shortId(project: EditProject): string {
  let id = '';
  do id = `c${Math.floor(Math.random() * 0xffffff).toString(36)}`; while (project.clips.some(clip => clip.id === id));
  return id;
}

function findClip(project: EditProject, ref: unknown): EditClip {
  const id = String(ref || '');
  const clip = project.clips.find(item => item.id === id);
  if (!clip) throw new EditOpError(`Clip "${id}" was not found. Read the timeline with smoothy_edit action "show".`, 'E_NOT_FOUND');
  return clip;
}

function linked(project: EditProject, clip: EditClip, apply: boolean): EditClip[] {
  if (!apply || !clip.link) return [clip];
  return project.clips.filter(item => item.link === clip.link);
}

function trackDefault(project: EditProject, prefix: 'V' | 'A'): string {
  const existing = project.clips.filter(clip => clip.track[0] === prefix).map(clip => clip.track);
  return existing.sort()[0] || `${prefix}1`;
}

/** Highest-numbered free track of a kind where [start,end) fits without overlap. */
function freeTrack(project: EditProject, prefix: 'V' | 'A', start: number, end: number): string {
  for (let index = 1; index <= 8; index += 1) {
    const name = `${prefix}${index}`;
    const clash = project.clips.some(clip => clip.track === name && clip.start < end - 1e-6 && clipEnd(clip) > start + 1e-6);
    if (!clash) return name;
  }
  return `${prefix}8`;
}

export type OpResult = { op: string; clips?: string[]; note?: string };

type RawOp = Record<string, any>;

function rangeFor(project: EditProject, asset: EditAsset, raw: RawOp, speed: number): { in: number; out: number } {
  const sourceLength = asset.kind === 'image' ? 3600 : asset.duration;
  const from = Math.max(0, num(raw.in, 'in', 0));
  let to: number;
  if (raw.out !== undefined) to = num(raw.out, 'out');
  else if (raw.duration !== undefined) to = from + num(raw.duration, 'duration') * speed;
  else to = asset.kind === 'image' ? from + 5 : sourceLength;
  if (asset.kind !== 'image') to = Math.min(to, sourceLength);
  if (to - from < 1 / (project.fps * 2)) throw new EditOpError('The source range is empty. Check in/out against the asset duration.');
  return { in: from, out: to };
}

function addClips(project: EditProject, raw: RawOp): OpResult {
  const asset = project.assets[String(raw.asset || '')];
  if (!asset) throw new EditOpError(`Asset "${raw.asset}" is not in this project. Import it first.`, 'E_NOT_FOUND');
  const speed = Math.max(0.1, Math.min(8, num(raw.speed, 'speed', 1)));
  const range = rangeFor(project, asset, raw, speed);
  const length = (range.out - range.in) / speed;
  const start = snap(project, raw.at !== undefined ? num(raw.at, 'at') : projectEndOn(project, raw.track, asset, raw.only === 'audio'));
  const audioOnly = raw.only === 'audio';
  if (audioOnly && !asset.hasAudio) throw new EditOpError(`${asset.name} has no audio to add.`);
  const link = asset.kind === 'video' && asset.hasAudio && asset.hasVideo && raw.audio !== false && !audioOnly ? randomUUID().slice(0, 6) : undefined;
  const created: string[] = [];
  const base = {
    asset: asset.id,
    start,
    in: range.in,
    out: range.out,
    speed,
    volume: Math.max(-60, Math.min(24, num(raw.volume, 'volume', 0))),
    fadeIn: Math.max(0, num(raw.fadeIn, 'fadeIn', 0)),
    fadeOut: Math.max(0, num(raw.fadeOut, 'fadeOut', 0)),
    mute: Boolean(raw.mute),
    opacity: Math.max(0, Math.min(1, num(raw.opacity, 'opacity', 1))),
    fit: raw.fit === 'contain' ? 'contain' as const : 'cover' as const,
    link
  };
  if (asset.kind === 'audio' || audioOnly) {
    const track = raw.track ? normalizeTrack(raw.track, 'A1') : freeTrack(project, 'A', start, start + length);
    if (trackKind(track) !== 'A') throw new EditOpError('Audio assets go on an A track.');
    const clip: EditClip = { id: shortId(project), track, kind: 'audio', ...base, fit: 'cover', opacity: 1, link: undefined };
    project.clips.push(clip);
    created.push(clip.id);
  } else {
    const track = raw.track ? normalizeTrack(raw.track, 'V1') : freeTrack(project, 'V', start, start + length);
    if (trackKind(track) === 'A') throw new EditOpError('Video and image assets go on a V track.');
    const video: EditClip = { id: shortId(project), track, kind: asset.kind === 'image' ? 'image' : 'video', ...base };
    project.clips.push(video);
    created.push(video.id);
    if (link) {
      const audioTrack = raw.audioTrack ? normalizeTrack(raw.audioTrack, 'A1') : freeTrack(project, 'A', start, start + length);
      const audio: EditClip = { id: shortId(project), track: audioTrack, kind: 'audio', ...base, fit: 'cover', opacity: 1 };
      project.clips.push(audio);
      created.push(audio.id);
    }
  }
  if (project.clips.length > MAX_CLIPS) throw new EditOpError(`A project can hold ${MAX_CLIPS} clips.`);
  return { op: 'add', clips: created };
}

function projectEndOn(project: EditProject, track: unknown, asset: EditAsset, audioOnly = false): number {
  const prefix = asset.kind === 'audio' || audioOnly ? 'A' : 'V';
  const wanted = track ? normalizeTrack(track, `${prefix}1`) : trackDefault(project, prefix);
  return project.clips.filter(clip => clip.track === wanted).reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

function rippleAfter(project: EditProject, track: string, from: number, delta: number, skip: Set<string>): void {
  for (const clip of project.clips) {
    if (clip.track !== track || skip.has(clip.id)) continue;
    if (clip.start >= from - 1e-6) clip.start = snap(project, clip.start + delta);
  }
}

function applyOp(project: EditProject, raw: RawOp): OpResult {
  const op = String(raw?.op || '').toLowerCase();
  switch (op) {
    case 'add':
      return addClips(project, raw);

    case 'trim': {
      const clip = findClip(project, raw.clip);
      const group = linked(project, clip, raw.unlink !== true);
      const before = clipEnd(clip);
      for (const item of group) {
        const nextIn = raw.in !== undefined ? Math.max(0, num(raw.in, 'in')) : item.in;
        let nextOut = raw.out !== undefined ? num(raw.out, 'out') : item.out;
        if (raw.duration !== undefined) nextOut = nextIn + num(raw.duration, 'duration') * item.speed;
        const asset = item.asset ? project.assets[item.asset] : null;
        if (asset && asset.kind !== 'image') nextOut = Math.min(nextOut, asset.duration);
        if (nextOut - nextIn < 1 / (project.fps * 2)) throw new EditOpError('That trim leaves no media. Check in/out.');
        // Trimming the head moves the clip start so the picture stays in place.
        if (raw.in !== undefined && raw.keepStart !== true) item.start = snap(project, item.start + (nextIn - item.in) / item.speed);
        item.in = nextIn;
        item.out = nextOut;
      }
      if (raw.ripple === true) rippleAfter(project, clip.track, before, clipEnd(clip) - before, new Set(group.map(item => item.id)));
      return { op, clips: group.map(item => item.id) };
    }

    case 'split': {
      const clip = findClip(project, raw.clip);
      const at = snap(project, num(raw.at, 'at'));
      const group = linked(project, clip, raw.unlink !== true);
      const created: string[] = [];
      const link = randomUUID().slice(0, 6);
      for (const item of group) {
        if (at <= item.start + 1e-6 || at >= clipEnd(item) - 1e-6) throw new EditOpError(`Split time ${at.toFixed(2)}s is outside clip ${item.id} (${item.start.toFixed(2)}–${clipEnd(item).toFixed(2)}s).`);
        const sourceAt = item.in + (at - item.start) * item.speed;
        const right: EditClip = { ...item, id: shortId(project), start: at, in: sourceAt, fadeIn: 0, link: item.link ? link : undefined };
        item.out = sourceAt;
        item.fadeOut = 0;
        project.clips.push(right);
        created.push(right.id);
      }
      return { op, clips: created };
    }

    case 'move': {
      const clip = findClip(project, raw.clip);
      const group = linked(project, clip, raw.unlink !== true);
      const to = snap(project, num(raw.to, 'to'));
      const delta = to - clip.start;
      for (const item of group) item.start = snap(project, item.start + delta);
      if (raw.track) {
        const track = normalizeTrack(raw.track, clip.track);
        if (trackKind(track) !== trackKind(clip.track)) throw new EditOpError('A clip can only move to a track of the same kind.');
        clip.track = track;
      }
      return { op, clips: group.map(item => item.id) };
    }

    case 'remove': {
      const clip = findClip(project, raw.clip);
      const group = linked(project, clip, raw.unlink !== true);
      const ids = new Set(group.map(item => item.id));
      if (raw.ripple === true) {
        for (const item of group) rippleAfter(project, item.track, clipEnd(item), -(clipEnd(item) - item.start), ids);
      }
      project.clips = project.clips.filter(item => !ids.has(item.id));
      return { op, clips: [...ids] };
    }

    case 'set': {
      const clip = findClip(project, raw.clip);
      const audioOnly = ['volume', 'fadeIn', 'fadeOut', 'mute'];
      const group = linked(project, clip, raw.unlink !== true);
      for (const item of group) {
        if (raw.volume !== undefined && item.kind !== 'image') item.volume = Math.max(-60, Math.min(24, num(raw.volume, 'volume')));
        if (raw.fadeIn !== undefined) item.fadeIn = Math.max(0, num(raw.fadeIn, 'fadeIn'));
        if (raw.fadeOut !== undefined) item.fadeOut = Math.max(0, num(raw.fadeOut, 'fadeOut'));
        if (raw.mute !== undefined && item.kind === 'audio') item.mute = Boolean(raw.mute);
        if (raw.opacity !== undefined && item.kind !== 'audio') item.opacity = Math.max(0, Math.min(1, num(raw.opacity, 'opacity')));
        if (raw.fit !== undefined && item.kind !== 'audio') item.fit = raw.fit === 'contain' ? 'contain' : 'cover';
        if (raw.speed !== undefined) {
          const speed = Math.max(0.1, Math.min(8, num(raw.speed, 'speed')));
          item.speed = speed;
        }
      }
      if (raw.text !== undefined && clip.kind === 'text') clip.text = String(raw.text).slice(0, 400);
      if (raw.style && clip.kind === 'text') clip.style = cleanStyle({ ...clip.style, ...raw.style });
      void audioOnly;
      return { op, clips: group.map(item => item.id) };
    }

    case 'text': {
      const text = String(raw.text || '').trim();
      if (!text) throw new EditOpError('Text is required.');
      const start = snap(project, num(raw.at, 'at', 0));
      const duration = Math.max(0.2, num(raw.duration, 'duration', 3));
      const track = raw.track ? normalizeTrack(raw.track, 'T1') : 'T1';
      if (trackKind(track) !== 'T') throw new EditOpError('Text goes on a T track such as T1.');
      const clip: EditClip = {
        id: shortId(project), track, kind: 'text', text: text.slice(0, 400), style: cleanStyle(raw.style || {}),
        start, in: 0, out: duration, speed: 1, volume: 0, fadeIn: Math.max(0, num(raw.fadeIn, 'fadeIn', 0)), fadeOut: Math.max(0, num(raw.fadeOut, 'fadeOut', 0)),
        mute: false, opacity: 1, fit: 'cover'
      };
      project.clips.push(clip);
      return { op, clips: [clip.id] };
    }

    case 'captions': {
      const items = Array.isArray(raw.items) ? raw.items : [];
      if (!items.length) throw new EditOpError('captions needs items: [{start,end,text}].');
      if (items.length > 400) throw new EditOpError('Add at most 400 captions per op.');
      const created: string[] = [];
      for (const item of items) {
        const start = snap(project, num(item?.start, 'caption start'));
        const end = snap(project, num(item?.end, 'caption end'));
        if (end - start < 0.1) continue;
        const text = String(item?.text || '').trim();
        if (!text) continue;
        const clip: EditClip = {
          id: shortId(project), track: 'T1', kind: 'text', text: text.slice(0, 400), style: cleanStyle({ position: 'bottom', background: '#00000099', ...(raw.style || {}) }),
          start, in: 0, out: end - start, speed: 1, volume: 0, fadeIn: 0, fadeOut: 0, mute: false, opacity: 1, fit: 'cover'
        };
        project.clips.push(clip);
        created.push(clip.id);
      }
      if (project.clips.length > MAX_CLIPS) throw new EditOpError(`A project can hold ${MAX_CLIPS} clips.`);
      return { op, clips: created, note: `${created.length} captions on T1` };
    }

    case 'cut': {
      // Remove [from,to) from the whole timeline and close the gap.
      const from = snap(project, num(raw.from, 'from'));
      const to = snap(project, num(raw.to, 'to'));
      if (to - from < 1 / project.fps) throw new EditOpError('cut needs from < to.');
      const gap = to - from;
      const next: EditClip[] = [];
      for (const clip of project.clips) {
        const end = clipEnd(clip);
        if (end <= from + 1e-6) { next.push(clip); continue; }
        if (clip.start >= to - 1e-6) { clip.start = snap(project, clip.start - gap); next.push(clip); continue; }
        if (clip.start >= from - 1e-6 && end <= to + 1e-6) continue;
        // Overlaps the cut: keep the head and/or tail.
        if (clip.start < from - 1e-6) {
          const head: EditClip = { ...clip };
          const tailExists = end > to + 1e-6;
          head.out = clip.in + (from - clip.start) * clip.speed;
          head.fadeOut = tailExists ? 0 : clip.fadeOut;
          next.push(head);
          if (tailExists) {
            const tail: EditClip = { ...clip, id: shortId({ ...project, clips: [...project.clips, ...next] }), start: from, in: clip.in + (to - clip.start) * clip.speed, fadeIn: 0 };
            if (clip.link) tail.link = `${clip.link}x`;
            next.push(tail);
          }
        } else {
          const tail: EditClip = { ...clip, start: from, in: clip.in + (to - clip.start) * clip.speed, fadeIn: 0 };
          next.push(tail);
        }
      }
      project.clips = next;
      return { op, note: `cut ${gap.toFixed(2)}s at ${from.toFixed(2)}s` };
    }

    case 'ripple_gaps': {
      // Close every gap on a track (default V1) so clips butt together.
      const track = normalizeTrack(raw.track, 'V1');
      const clips = project.clips.filter(clip => clip.track === track).sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const clip of clips) {
        const delta = cursor - clip.start;
        if (Math.abs(delta) > 1e-6) {
          for (const item of linked(project, clip, true)) item.start = snap(project, item.start + delta);
        }
        cursor = clipEnd(clip);
      }
      return { op, note: `closed gaps on ${track}` };
    }

    default:
      throw new EditOpError(`Unknown op "${op}". Use add, trim, split, move, remove, set, text, captions, cut or ripple_gaps.`);
  }
}

export function cleanStyle(style: any): TextStyle {
  const out: TextStyle = {};
  if (style?.size !== undefined) out.size = Math.max(10, Math.min(300, Number(style.size) || 48));
  if (typeof style?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(style.color)) out.color = style.color;
  if (typeof style?.background === 'string' && /^#[0-9a-f]{3,8}$/i.test(style.background)) out.background = style.background;
  if (style?.position === 'top' || style?.position === 'center' || style?.position === 'bottom') out.position = style.position;
  if (style?.bold !== undefined) out.bold = Boolean(style.bold);
  return out;
}

/**
 * Applies a batch of operations atomically: if any op fails the project is left
 * untouched and the failing op index is reported.
 */
export function applyOps(project: EditProject, ops: unknown): { project: EditProject; results: OpResult[] } {
  if (!Array.isArray(ops) || !ops.length) throw new EditOpError('ops must be a non-empty array.');
  if (ops.length > MAX_OPS) throw new EditOpError(`Send at most ${MAX_OPS} ops per call.`);
  const draft: EditProject = JSON.parse(JSON.stringify(project));
  const results: OpResult[] = [];
  ops.forEach((raw, index) => {
    try {
      results.push(applyOp(draft, raw));
    } catch (error: any) {
      if (error instanceof EditOpError) {
        throw new EditOpError(`ops[${index}] (${String(raw?.op || '?')}): ${error.message}`, error.code);
      }
      throw error;
    }
  });
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  return { project: draft, results };
}

/** Compact timeline map: one short line per clip, grouped by track. */
export function describeProject(project: EditProject, options: { clips?: boolean } = {}): any {
  const tracks: Record<string, string[]> = {};
  const sorted = [...project.clips].sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
  for (const clip of sorted) {
    const asset = clip.asset ? project.assets[clip.asset] : null;
    const label = clip.kind === 'text' ? `"${(clip.text || '').slice(0, 24)}"` : asset?.name || clip.asset || '';
    const flags = [
      clip.speed !== 1 ? `${clip.speed}x` : '',
      clip.volume ? `${clip.volume > 0 ? '+' : ''}${clip.volume}dB` : '',
      clip.mute ? 'mute' : '',
      clip.fadeIn ? `fi${clip.fadeIn}` : '',
      clip.fadeOut ? `fo${clip.fadeOut}` : ''
    ].filter(Boolean).join(' ');
    (tracks[clip.track] ||= []).push(
      `${clip.id} ${clip.start.toFixed(2)}-${clipEnd(clip).toFixed(2)} ${label} src ${clip.in.toFixed(2)}-${clip.out.toFixed(2)}${flags ? ` ${flags}` : ''}`
    );
  }
  const counts: Record<string, number> = {};
  for (const clip of project.clips) counts[clip.track] = (counts[clip.track] || 0) + 1;
  return {
    id: project.id,
    name: project.name,
    size: `${project.width}x${project.height}@${project.fps}`,
    duration: Number(projectDuration(project).toFixed(3)),
    revision: project.revision,
    assets: Object.values(project.assets).map(asset => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      duration: Number(asset.duration.toFixed(2)),
      size: asset.kind === 'audio' ? undefined : `${asset.width}x${asset.height}`,
      audio: asset.hasAudio || undefined,
      source: asset.source?.provider
    })),
    clipCounts: counts,
    tracks: options.clips === false ? undefined : tracks
  };
}

/** Cheap sanity checks the agent sees after every change (max 6 lines). */
export function lintProject(project: EditProject): string[] {
  const warnings: string[] = [];
  const byTrack = new Map<string, EditClip[]>();
  for (const clip of project.clips) {
    const list = byTrack.get(clip.track) || [];
    list.push(clip);
    byTrack.set(clip.track, list);
  }
  for (const [track, list] of [...byTrack].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = sorted[i].start - clipEnd(sorted[i - 1]);
      if (gap < -1 / project.fps && track[0] !== 'T') warnings.push(`${track}: ${sorted[i - 1].id} overlaps ${sorted[i].id} by ${(-gap).toFixed(2)}s`);
      else if (gap > 0.05 && track === 'V1') warnings.push(`V1 has a ${gap.toFixed(2)}s gap before ${sorted[i].id} (black)`);
    }
  }
  for (const clip of project.clips) {
    const asset = clip.asset ? project.assets[clip.asset] : null;
    if (asset && asset.kind !== 'image' && clip.out > asset.duration + 0.05) warnings.push(`${clip.id} runs past the end of ${asset.name}`);
  }
  return warnings.slice(0, 6);
}
