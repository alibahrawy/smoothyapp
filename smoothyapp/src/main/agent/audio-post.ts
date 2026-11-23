/**
 * Music bed and sound effects for the headless edit (port of the Video 01 mix).
 *
 * Music bed: the track is looped with crossfades, set to a target loudness under
 * speech (−33.5 LUFS, about 18 dB under a −16 LUFS voice), lifted to −24 LUFS in
 * the windows without speech (logo, titles, chapter slates, end card), and faded
 * in and out. Lift windows come from the caller or from gaps in the dialogue track.
 *
 * SFX: cues from the bundled library (by id, title or tags) or from files,
 * level-matched (peak −18 dBFS, sustained sounds capped at −32 dBFS RMS) and
 * packed onto as few audio tracks as possible above the dialogue.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { clipEnd, type EditProject } from './edit-project';

export type Window = { from: number; to: number };

/** Merges windows that touch or nearly touch (logo + title become one lift). */
export function mergeWindows(windows: Window[], join = 0.2): Window[] {
  const sorted = windows.filter(item => item.to > item.from).sort((a, b) => a.from - b.from);
  const merged: Window[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.from - last.to < join) last.to = Math.max(last.to, item.to);
    else merged.push({ ...item });
  }
  return merged;
}

/** Timeline ranges with no clip on the dialogue track, at least minGap long. */
export function speechGaps(project: EditProject, track: string, total: number, minGap = 1.5): Window[] {
  const spans = project.clips.filter(clip => clip.track === track && !clip.mute).map(clip => ({ from: clip.start, to: clipEnd(clip) })).sort((a, b) => a.from - b.from);
  const gaps: Window[] = [];
  let t = 0;
  for (const span of spans) {
    if (span.from - t >= minGap) gaps.push({ from: t, to: span.from });
    t = Math.max(t, span.to);
  }
  if (total - t >= minGap) gaps.push({ from: t, to: total });
  return gaps;
}

export type BedOptions = {
  total: number;
  sourceSeconds: number;
  sourceLufs: number;
  targetLufs: number;
  liftLufs: number;
  lifts: Window[];
  crossfade: number;
  fadeIn: number;
  fadeOut: number;
};

/**
 * The filter graph for the bed. The music is passed as `loops` separate inputs
 * (0…loops-1): on ffmpeg 6.0 an asplit feeding chained acrossfades collapses to
 * one loop, while separate inputs loop correctly on every version.
 * Same level expression as music_bed.py.
 */
export function musicBedGraph(o: BedOptions): { graph: string; loops: number; windows: Window[] } {
  const usable = o.sourceSeconds - o.crossfade;
  if (!(usable > 1)) throw Object.assign(new Error('The music is too short for a looping bed with that crossfade.'), { code: 'E_BAD_REQUEST' });
  const loops = Math.min(400, Math.floor(o.total / usable) + 2);
  const baseDb = o.targetLufs - o.sourceLufs;
  const lift = Math.pow(10, (o.liftLufs - o.targetLufs) / 20);
  const windows = mergeWindows(o.lifts).slice(0, 300);
  const r = 0.6;
  const bump = windows.map(w => `clip((t-${(w.from - 0.2).toFixed(3)})/${r},0,1)*clip((${(w.to + 0.3).toFixed(3)}-t)/${r},0,1)`).join('+');
  const expr = windows.length ? `pow(10,${baseDb.toFixed(2)}/20)*(1+${(lift - 1).toFixed(4)}*min(1,${bump}))` : `pow(10,${baseDb.toFixed(2)}/20)`;
  let graph = '';
  let chain = '[0:a]';
  for (let i = 1; i < loops; i += 1) {
    graph += `${chain}[${i}:a]acrossfade=d=${o.crossfade}:c1=tri:c2=tri[x${i}];`;
    chain = `[x${i}]`;
  }
  const out = Math.max(0, o.total - o.fadeOut);
  graph += `${chain}atrim=0:${o.total.toFixed(3)},aresample=48000,volume='${expr}':eval=frame`;
  if (o.fadeIn > 0) graph += `,afade=t=in:st=0:d=${o.fadeIn}`;
  if (o.fadeOut > 0) graph += `,afade=t=out:st=${out.toFixed(3)}:d=${o.fadeOut}`;
  graph += '[o]';
  return { graph, loops, windows };
}

// ---- sound effects --------------------------------------------------------------------

export type SfxEntry = { id: string; title: string; category: string; tags: string[]; file: string; license: string; author: string; duration: number };

export async function loadSfx(dir: string | null | undefined): Promise<SfxEntry[]> {
  if (!dir) return [];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.sounds) ? raw.sounds : [];
    return list.filter((item: any) => item?.id && item?.file).map((item: any) => ({
      id: String(item.id), title: String(item.title || item.id), category: String(item.category || ''), tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      file: path.join(dir, String(item.file)), license: String(item.license || ''), author: String(item.author || ''), duration: Number(item.duration) || 0
    }));
  } catch {
    return [];
  }
}

/** Finds a sound by id, then title, then the best tag/title word match. */
export function findSfx(library: SfxEntry[], name: string): SfxEntry | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = library.find(item => item.id.toLowerCase() === q || item.title.toLowerCase() === q);
  if (exact) return exact;
  const words = q.split(/[\s_-]+/).filter(Boolean);
  let best: { item: SfxEntry; score: number } | null = null;
  for (const item of library) {
    const hay = [item.id, item.title, item.category, ...item.tags].join(' ').toLowerCase();
    const score = words.filter(word => hay.includes(word)).length;
    if (score && (!best || score > best.score)) best = { item, score };
  }
  return best && best.score >= Math.ceil(words.length / 2) ? best.item : null;
}

/** Gain in dB that puts a sound at the target peak, without letting its RMS exceed rmsMax. */
export function levelGain(peakDb: number, rmsDb: number, peakTarget = -18, rmsMax = -32): number {
  if (!Number.isFinite(peakDb)) return 0;
  let gain = peakTarget - peakDb;
  if (Number.isFinite(rmsDb) && rmsDb + gain > rmsMax) gain = rmsMax - rmsDb;
  return Number(Math.max(-60, Math.min(24, gain)).toFixed(1));
}

export function parseAstats(stderr: string): { peak: number; rms: number } {
  const pick = (label: string) => {
    const matches = [...stderr.matchAll(new RegExp(`${label} dB:\\s*(-?[\\d.]+|-inf)`, 'g'))];
    const last = matches[matches.length - 1];
    return last ? (last[1] === '-inf' ? -Infinity : Number(last[1])) : NaN;
  };
  return { peak: pick('Peak level'), rms: pick('RMS level') };
}

/** Places cue intervals on lanes: existing SFX tracks first, then new tracks above everything else. */
export function packCues(project: EditProject, cues: { at: number; length: number }[], kind = 'sfx'): string[] {
  const aTracks = (clips: EditProject['clips']) => clips.filter(clip => clip.track[0] === 'A').map(clip => Number(clip.track.slice(1)));
  const others = project.clips.filter(clip => (clip.meta as any)?.kind !== kind);
  const own = project.clips.filter(clip => (clip.meta as any)?.kind === kind);
  const lanes = new Map<number, { from: number; to: number }[]>();
  for (const n of [...new Set(aTracks(own))].sort((a, b) => a - b)) lanes.set(n, own.filter(clip => clip.track === `A${n}`).map(clip => ({ from: clip.start, to: clipEnd(clip) })));
  let next = Math.max(1, ...aTracks(others), ...aTracks(own)) + 1;
  const busyOther = new Set(aTracks(others));
  return cues.map(cue => {
    const span = { from: cue.at, to: cue.at + cue.length };
    for (const [n, used] of [...lanes].sort((a, b) => a[0] - b[0])) {
      if (busyOther.has(n)) continue;
      if (used.every(item => item.to <= span.from + 1e-6 || item.from >= span.to - 1e-6)) { used.push(span); return `A${n}`; }
    }
    lanes.set(next, [span]);
    return `A${next++}`;
  });
}
