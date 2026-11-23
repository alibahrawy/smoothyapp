/**
 * smoothy_cut: editing the way an AI edits, by phrase.
 *
 * - cut_phrases: a phrase cut list → frame-accurate source clips whose in/out
 *   points sit in real silence of the 10 ms envelope (port of the Video 01
 *   resolver: speech −50 dB, quiet −45 dB, lead 0.08 s, tail 0.14 s, pauses over
 *   0.62 s tightened to 0.30 s, safe filler removal, frames at the source fps).
 * - verify_edit: renders the cut audio with 0.6 s gaps, transcribes it and diffs
 *   it against the expected words, reporting clipped/leaked words by clip id and
 *   the fillers still heard (feed them back to cut_phrases as `fillers`).
 * - captions: SRT from word timings (≤ 5 words, breaks on punctuation or gaps).
 * - chapters: YouTube chapter text from the cut list's chapter rows.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILLERS, FILLER_PROMPT, DTW_SHIFT, wordsFromDtw, type Word } from './analysis';
import { dtwPreset, runEngine, within, type WhisperInfo } from './engine';
import { probeMedia } from './media';
import { fileStamp, hashKey, type ResultCache } from './results';
import type { AgentJob, AgentResult } from './types';

export const normPhrase = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const isFiller = (word: Word) => Boolean(word.filler) || FILLERS.has(normPhrase(word.w));

export type Envelope = { from: number; binMs: number; db: number[] };

export type CutSettings = {
  fps: number;
  thresholdDb: number;
  quietDb: number;
  lead: number;
  tail: number;
  maxGap: number;
  keepGap: number;
  fillerMax: number;
  removeFillers: boolean;
};

export const DEFAULT_CUT: Omit<CutSettings, 'fps'> = { thresholdDb: -50, quietDb: -45, lead: 0.08, tail: 0.14, maxGap: 0.62, keepGap: 0.3, fillerMax: 0.55, removeFillers: true };

export type CutRow = { id?: string; near?: string | number; from?: string; to?: string; skip?: string[]; angle?: string; chapter?: string; sub?: string; chapterSub?: string };

export type CutClip = {
  id: string;
  seg: string;
  angle?: string;
  chapter: string | null;
  chapterSub: string | null;
  fIn: number;
  fOut: number;
  srcIn: number;
  srcOut: number;
  snapIn: boolean;
  snapOut: boolean;
  words: [number, number];
  rmsIn: number;
  rmsOut: number;
  text: string;
};

/** "15:02", "1:02:03.5" or seconds → seconds. */
export function parseNear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return null;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

/** Python's round(): ties go to the even number (the resolver was calibrated with it). */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Resolves a phrase cut list against word timings and a 10 ms envelope. */
export function resolveCutList(W: Word[], env: Envelope, rows: CutRow[], s: CutSettings, heardFillers: number[] = []): { clips: CutClip[]; problems: string[] } {
  if (Math.round(env.binMs) !== 10) throw Object.assign(new Error('cut_phrases needs a 10 ms envelope (smoothy_analyze envelope with binMs 10).'), { code: 'E_BAD_REQUEST' });
  const OFF = env.from;
  const R = env.db;
  const N = R.length;
  const FPS = s.fps;
  const NW = W.map(word => normPhrase(word.w));
  const LEAD = Math.round(s.lead * 100);
  const TAIL = Math.round(s.tail * 100);
  const at = (k: number) => R[Math.max(0, Math.min(N - 1, k))];
  const kq = (t: number) => roundHalfEven((t - OFF) * 100);
  const E = (t: number) => at(kq(t));
  const quietRun = (k: number, n = 3) => { for (let d = 0; d < n; d += 1) if (!(at(k + d) < s.quietDb)) return false; return true; };
  const bestFrame = (x: number) => {
    const f0 = Math.floor(x * FPS);
    const f1 = Math.ceil(x * FPS);
    const score = (f: number) => Math.max(E(f / FPS - 0.01), E(f / FPS), E(f / FPS + 0.01));
    return score(f1) < score(f0) ? f1 : f0;
  };
  const quietest = (from: number, to: number) => {
    let best = from;
    for (let k = from; k < to; k += 1) if (at(k) < at(best)) best = k;
    return best;
  };

  const find = (phrase: string, near: number | null, afterIdx: number | null = null, span = 25): [number, number] | null => {
    const target = normPhrase(phrase);
    if (!target) return null;
    let best: { d: number; i: number; j: number } | null = null;
    for (let i = afterIdx ?? 0; i < W.length; i += 1) {
      if (afterIdx === null && near !== null && Math.abs(W[i].a - near) > span) continue;
      if (afterIdx !== null && W[i].a - W[afterIdx].a > 120) break;
      let acc = '';
      for (let j = i; j < Math.min(i + 60, W.length); j += 1) {
        acc += NW[j];
        if (acc === target) {
          const d = afterIdx === null ? Math.abs(W[i].a - (near ?? 0)) : 0;
          if (!best || d < best.d) best = { d, i, j };
          break;
        }
        if (!target.startsWith(acc)) break;
      }
      if (afterIdx !== null && best) break;
    }
    return best ? [best.i, best.j] : null;
  };

  // Speech islands from the envelope; blips under 30 ms do not count.
  const speech = R.map(value => value > s.thresholdDb);
  for (let i = 0; i < N;) {
    if (!speech[i]) { i += 1; continue; }
    let j = i;
    while (j < N && speech[j]) j += 1;
    if (j - i < 3) for (let k = i; k < j; k += 1) speech[k] = false;
    i = j;
  }
  const gaps: [number, number][] = [];
  for (let i = 0; i < N;) {
    if (speech[i]) { i += 1; continue; }
    let j = i;
    while (j < N && !speech[j]) j += 1;
    gaps.push([OFF + i / 100, OFF + j / 100]);
    i = j;
  }

  const cutIn = (x: number, hardLo: number | null): [number, boolean] => {
    let t = W[x].a;
    let lo = Math.max(t - 0.6, x > 0 ? W[x - 1].a + 0.12 : t - 0.6);
    if (hardLo !== null) { lo = Math.max(lo, hardLo); t = Math.max(t, hardLo); }
    const hi = t + 0.12;
    for (const need of [7, 3]) {
      for (let k = kq(hi); k > kq(lo); k -= 1) {
        if (quietRun(k - need + 1, need)) {
          let on = k;
          while (on < N - 1 && at(on) < s.thresholdDb) on += 1;
          return [bestFrame(OFF + Math.max(k - need + 1, on - LEAD) / 100), true];
        }
      }
    }
    return [bestFrame(OFF + quietest(kq(lo), Math.max(kq(lo) + 1, kq(hi))) / 100), false];
  };

  const cutOut = (y: number, hardHi: number | null): [number, boolean] => {
    const t0 = W[y].a;
    const lim = y + 1 < W.length ? W[y + 1].a + 0.06 : t0 + 1.0;
    const lo = t0 + 0.1;
    let hi = Math.min(lim, t0 + 1.4);
    if (hardHi !== null) hi = Math.min(hi, hardHi);
    if (hi <= lo) hi = lo + 0.1;
    for (let k = kq(lo); k < kq(hi); k += 1) {
      if (quietRun(k)) {
        let e = k;
        while (e < N - 1 && at(e) < s.thresholdDb && e - k < TAIL * 2) e += 1;
        return [bestFrame(OFF + (k + Math.min(TAIL, Math.floor((e - k) / 2))) / 100), true];
      }
    }
    return [bestFrame(OFF + quietest(kq(lo), kq(hi) + 1) / 100), false];
  };

  const clips: CutClip[] = [];
  const problems: string[] = [];
  let chapter: { title: string; sub: string } | null = null;
  rows.forEach((row, index) => {
    if (row && row.chapter && !row.from && !row.to) { chapter = { title: String(row.chapter), sub: String(row.sub ?? row.chapterSub ?? '') }; return; }
    const cid = String(row?.id || `r${index + 1}`);
    const fp = String(row?.from || '');
    const tp = String(row?.to || fp);
    if (!fp) { problems.push(`${cid}: needs from (a phrase, or "@seconds")`); return; }
    let loH: number | null = null;
    let hiH: number | null = null;
    let a: [number, number] | null;
    if (fp.startsWith('@')) {
      const t = Number(fp.slice(1));
      const i0 = W.findIndex(word => word.a >= t - 0.05);
      a = Number.isFinite(t) && i0 >= 0 ? [i0, i0] : null;
      loH = t - 0.12;
    } else {
      a = find(fp, parseNear(row.near));
    }
    if (!a) { problems.push(`${cid}: FROM not found "${fp}"${row.near !== undefined ? ` near ${row.near}` : ''}`); return; }
    let b: [number, number] | null;
    if (tp.startsWith('@')) {
      const t = Number(tp.slice(1));
      let i1 = -1;
      W.forEach((word, i) => { if (word.a < t) i1 = i; });
      b = Number.isFinite(t) && i1 >= 0 ? [i1, i1] : null;
      hiH = t + 0.12;
    } else {
      b = normPhrase(tp) !== normPhrase(fp) ? find(tp, null, a[0] + 1) : a;
    }
    if (!b) { problems.push(`${cid}: TO not found "${tp}"`); return; }
    let ranges: [number, number, number | null, number | null][] = [[a[0], b[1], loH, hiH]];
    for (const sp of Array.isArray(row.skip) ? row.skip.map(String) : []) {
      let s0: number; let s1: number; let hl: number | null; let hh: number | null;
      if (sp.startsWith('@')) {
        const [ta, tb] = sp.slice(1).split('-').map(Number);
        const idx: number[] = [];
        for (let i = a[0]; i <= b[1]; i += 1) if (W[i].a >= ta && W[i].a <= tb) idx.push(i);
        if (!idx.length) { problems.push(`${cid}: SKIP time has no words "${sp}"`); continue; }
        [s0, s1, hl, hh] = [idx[0], idx[idx.length - 1], ta + 0.1, tb - 0.1];
      } else {
        const f = find(sp, null, a[0]);
        if (!f || f[1] > b[1]) { problems.push(`${cid}: SKIP not found "${sp}"`); continue; }
        [s0, s1, hl, hh] = [f[0], f[1], null, null];
      }
      const next: typeof ranges = [];
      for (const [x, y, l, h] of ranges) {
        if (x <= s0 && s1 <= y) {
          if (s0 - 1 >= x) next.push([x, s0 - 1, l, hl]);
          if (s1 + 1 <= y) next.push([s1 + 1, y, hh, h]);
        } else next.push([x, y, l, h]);
      }
      ranges = next;
    }
    if (s.removeFillers) {
      const next: typeof ranges = [];
      for (const [x, y, l, h] of ranges) {
        let cur = x;
        let cl = l;
        for (let k = x; k <= y; k += 1) {
          if (isFiller(W[k])) {
            if (k - 1 >= cur) next.push([cur, k - 1, cl, null]);
            cur = k + 1;
            cl = null;
          }
        }
        if (cur <= y) next.push([cur, y, cl, h]);
      }
      ranges = next;
    }
    if (!ranges.length) { problems.push(`${cid}: only fillers, dropped`); return; }
    ranges.forEach(([x, y, l, h], ri) => {
      let [fi, gi] = cutIn(x, l);
      let [fo, go] = cutOut(y, h);
      if (fo <= fi) { problems.push(`${cid}: empty range`); return; }
      // Fillers heard in a verification pass (not in the transcript) become holes.
      const islands: [number, number][] = [];
      for (const ft of heardFillers) {
        if (!(fi / FPS - 0.15 < ft && ft < fo / FPS + 0.15)) continue;
        let k = kq(ft);
        if (quietRun(k, 3)) {
          let j = k;
          while (j < k + 45 && j < N - 1 && at(j) < s.thresholdDb) j += 1;
          if (j >= k + 45) continue;
          k = j + 2;
        }
        let s0 = k;
        let e0 = k;
        while (s0 > 0 && !quietRun(s0 - 3, 3) && k - s0 < 60) s0 -= 1;
        while (e0 < N - 3 && !quietRun(e0, 3) && e0 - k < 80) e0 += 1;
        const u = OFF + (s0 - 2) / 100;
        const v = OFF + (e0 + 2) / 100;
        const real = W.some(word => u - 0.02 < word.a && word.a < v + 0.02 && !isFiller(word));
        if (e0 - s0 <= Math.round(s.fillerMax * 100) && !real) islands.push([u, v]);
      }
      const holes: [number, number][] = [];
      for (const g of gaps) {
        if (fi / FPS + 0.05 < g[0] && g[1] < fo / FPS - 0.05 && g[1] - g[0] > s.maxGap) {
          holes.push([Math.ceil(Math.min(g[0] + s.keepGap / 2 + 0.02, g[1]) * FPS), Math.floor(Math.max(g[1] - s.keepGap / 2, g[0]) * FPS)]);
        }
      }
      for (const [u, v] of islands) holes.push([bestFrame(u), bestFrame(v)]);
      holes.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      // A filler island at the very start or end just moves the in/out point.
      for (const hole of [...holes]) {
        const [o, n] = hole;
        if (o <= fi + 3 && n > fi) { fi = n; holes.splice(holes.indexOf(hole), 1); }
        else if (n >= fo - 3 && o < fo) { fo = o; holes.splice(holes.indexOf(hole), 1); }
      }
      if (fo <= fi) { problems.push(`${cid}: empty after filler trim`); return; }
      const pieces: [number, number][] = [];
      let cur = fi;
      for (const [o, n] of holes) {
        if (n > o && o > cur && n < fo) { pieces.push([cur, o]); cur = n; }
        else if (n > cur && o <= cur) cur = Math.max(cur, n);
      }
      pieces.push([cur, fo]);
      pieces.forEach(([p0, p1], pi) => {
        const ws: Word[] = [];
        for (let i = x; i <= y; i += 1) if (W[i].b > p0 / FPS + 0.03 && W[i].a < p1 / FPS - 0.03) ws.push(W[i]);
        const id = `${cid}${ranges.length > 1 ? `.${ri}` : ''}${pieces.length > 1 ? `-${pi}` : ''}`;
        if (!ws.some(word => !isFiller(word))) { problems.push(`${id}: no words left (filler-only or silent piece), dropped`); return; }
        const ch = chapter as { title: string; sub: string } | null;
        clips.push({
          id, seg: cid, angle: row.angle, chapter: ch?.title ?? null, chapterSub: ch?.sub ?? null,
          fIn: p0, fOut: p1, srcIn: Number((p0 / FPS).toFixed(5)), srcOut: Number((p1 / FPS).toFixed(5)),
          snapIn: gi, snapOut: go, words: [x, y],
          rmsIn: Number(E(p0 / FPS).toFixed(1)), rmsOut: Number(E(p1 / FPS).toFixed(1)),
          text: ws.map(word => word.w).join(' ')
        });
      });
    });
  });
  return { clips, problems };
}

// ---- difflib SequenceMatcher (no junk heuristic) ----------------------------------------

export type Opcode = ['equal' | 'replace' | 'delete' | 'insert', number, number, number, number];

export class SequenceMatcher {
  private readonly b2j = new Map<string, number[]>();
  constructor(private readonly a: string[], private readonly b: string[]) {
    b.forEach((item, j) => { const list = this.b2j.get(item); if (list) list.push(j); else this.b2j.set(item, [j]); });
  }

  private longest(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    let besti = alo; let bestj = blo; let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  }

  matchingBlocks(): [number, number, number][] {
    const la = this.a.length; const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const [i, j, k] = this.longest(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const merged: [number, number, number][] = [];
    for (const block of blocks) {
      const last = merged[merged.length - 1];
      if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2];
      else merged.push([...block]);
    }
    merged.push([la, lb, 0]);
    return merged;
  }

  opcodes(): Opcode[] {
    let i = 0; let j = 0;
    const out: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      const tag = i < ai && j < bj ? 'replace' : i < ai ? 'delete' : j < bj ? 'insert' : '';
      if (tag) out.push([tag as Opcode[0], i, ai, j, bj]);
      i = ai + size; j = bj + size;
      if (size) out.push(['equal', ai, i, bj, j]);
    }
    return out;
  }

  ratio(): number {
    const matches = this.matchingBlocks().reduce((sum, block) => sum + block[2], 0);
    const total = this.a.length + this.b.length;
    return total ? (2 * matches) / total : 1;
  }
}

export const tokens = (value: string) => value.toLowerCase().replace(/'/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);

export type VerifyIssue = { type: 'clipped' | 'leaked' | 'changed'; clip: string; expected: string; heard: string; context: string };

/** Compares expected words (per cut range) with what the edit actually says. */
export function compareEdit(W: Word[], clips: CutClip[], heard: { w: string; clip: string }[]): { similarity: number; expected: number; heardWords: number; issues: VerifyIssue[] } {
  const exp: string[] = []; const expClip: string[] = [];
  const seen = new Set<string>();
  for (const clip of clips) {
    const key = `${clip.seg}|${clip.words[0]}|${clip.words[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let k = clip.words[0]; k <= clip.words[1]; k += 1) {
      for (const token of tokens(W[k]?.w || '')) if (!FILLERS.has(token)) { exp.push(token); expClip.push(clip.id); }
    }
  }
  const got: string[] = []; const gotClip: string[] = [];
  for (const item of heard) for (const token of tokens(item.w)) if (!FILLERS.has(token)) { got.push(token); gotClip.push(item.clip); }
  const matcher = new SequenceMatcher(exp, got);
  const issues: VerifyIssue[] = [];
  for (const [tag, i1, i2, j1, j2] of matcher.opcodes()) {
    if (tag === 'equal') continue;
    const e = exp.slice(i1, i2); const g = got.slice(j1, j2);
    if (tag === 'replace' && e.length === g.length && e.length <= 2) continue; // recognition variants
    if (tag === 'replace' && Math.abs(e.length - g.length) <= 1 && e.length >= 1) continue;
    const clip = j1 < gotClip.length && tag !== 'delete' ? gotClip[j1] : expClip[Math.min(i1, expClip.length - 1)] || '?';
    issues.push({
      type: tag === 'delete' ? 'clipped' : tag === 'insert' ? 'leaked' : 'changed',
      clip,
      expected: e.join(' '),
      heard: g.join(' '),
      context: `${got.slice(Math.max(0, j1 - 4), j1).join(' ')} [${g.join(' ')}] ${got.slice(j2, j2 + 4).join(' ')}`.trim()
    });
  }
  return { similarity: Number(matcher.ratio().toFixed(4)), expected: exp.length, heardWords: got.length, issues };
}

// ---- captions and chapters -----------------------------------------------------------------

/** `chapterAt`: where the clip's chapter would begin: the start of the last insert (its slate) before it. */
export type Placed = { id: string; chapter: string | null; srcIn: number; srcOut: number; start: number; chapterAt: number };

/**
 * Lays clips end to end from `start`, adding inserted seconds before named clips
 * (logo, title, slates). Several inserts may precede one clip; the last one is
 * treated as the chapter slate, so the chapter starts there.
 */
export function layoutClips(clips: CutClip[], inserts: { before: string; seconds: number }[] = [], start = 0): Placed[] {
  let t = start;
  return clips.map(clip => {
    let chapterAt = t;
    for (const insert of inserts) {
      if (insert.before !== clip.id) continue;
      chapterAt = t;
      t += Math.max(0, Number(insert.seconds) || 0);
    }
    if (!inserts.some(insert => insert.before === clip.id)) chapterAt = t;
    const placed = { id: clip.id, chapter: clip.chapter, srcIn: clip.srcIn, srcOut: clip.srcOut, start: t, chapterAt };
    t += clip.srcOut - clip.srcIn;
    return placed;
  });
}

export type Correction = { find: string; replace: string; regex?: boolean };

const srtTime = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

/** SRT cues: ≤ maxWords per cue, break after punctuation (≥ 2 words) or a gap over gapFrames. */
export function buildCaptions(W: Word[], placed: Placed[], options: { fps: number; maxWords?: number; gapFrames?: number; corrections?: Correction[]; skipChapters?: string[] }): { srt: string; cues: { start: number; end: number; text: string }[] } {
  const fps = options.fps;
  const maxWords = Math.max(1, Math.min(12, Math.round(options.maxWords || 5)));
  const gapFrames = options.gapFrames ?? 8;
  const skip = new Set((options.skipChapters || []).map(name => name.toLowerCase()));
  const timed: [number, number, string][] = [];
  for (const clip of placed) {
    if (clip.chapter && skip.has(clip.chapter.toLowerCase())) continue;
    for (const word of W) {
      if (clip.srcIn - 0.02 <= word.a && word.a < clip.srcOut - 0.04 && !isFiller(word)) {
        timed.push([(clip.start + word.a - clip.srcIn) * fps, (clip.start + Math.min(word.b, clip.srcOut) - clip.srcIn) * fps, word.w]);
      }
    }
  }
  timed.sort((p, q) => p[0] - q[0]);
  const groups: [number, number, string][][] = [];
  let cur: [number, number, string][] = [];
  timed.forEach((item, i) => {
    cur.push(item);
    const gap = i + 1 < timed.length ? timed[i + 1][0] - item[1] : 99;
    if (cur.length >= maxWords || (/[.?!,]$/.test(item[2]) && cur.length >= 2) || gap > gapFrames) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  const fixes = (options.corrections || []).slice(0, 200).map(item => {
    const source = item.regex ? item.find : `\\b${item.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    try { return [new RegExp(source, 'gi'), item.replace] as const; } catch { return null; }
  }).filter(Boolean) as (readonly [RegExp, string])[];
  const cues: { start: number; end: number; text: string }[] = [];
  let sentenceStart = true;
  groups.forEach((group, n) => {
    const a = group[0][0];
    let b = Math.max(group[group.length - 1][1], a + 12);
    if (n + 1 < groups.length) b = Math.min(b + 4, groups[n + 1][0][0] - 1);
    let text = group.map(item => item[2]).join(' ').trim();
    for (const [pattern, replacement] of fixes) text = text.replace(pattern, replacement);
    if (sentenceStart && text) text = text[0].toUpperCase() + text.slice(1);
    sentenceStart = /[.?!]$/.test(text);
    cues.push({ start: Number((a / fps).toFixed(3)), end: Number((b / fps).toFixed(3)), text });
  });
  const srt = cues.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
  return { srt, cues };
}

const titleCase = (value: string) => value.toLowerCase().replace(/(^|[^a-z'])([a-z])/g, (_, lead, letter) => `${lead}${letter.toUpperCase()}`).replace(/\bVs\./g, 'vs.');
const ytClock = (seconds: number) => {
  const s = Math.floor(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** YouTube chapters: the first starts at 0:00 (an "Intro" line is added if needed). */
export function buildChapters(placed: Placed[], options: { skipChapters?: string[]; titleCase?: boolean; intro?: string } = {}): { text: string; chapters: { title: string; at: number }[]; warnings: string[] } {
  const skip = new Set((options.skipChapters || []).map(name => name.toLowerCase()));
  const chapters: { title: string; at: number }[] = [];
  let current: string | null = null;
  for (const clip of placed) {
    if (clip.chapter === current) continue;
    current = clip.chapter;
    if (!current || skip.has(current.toLowerCase())) continue;
    chapters.push({ title: options.titleCase === false ? current : titleCase(current), at: Number(clip.chapterAt.toFixed(3)) });
  }
  const lines = chapters.map(chapter => `${ytClock(chapter.at)} ${chapter.title}`);
  if (!chapters.length || chapters[0].at >= 1) lines.unshift(`0:00 ${options.intro || 'Intro'}`);
  const warnings: string[] = [];
  if (lines.length < 3) warnings.push('YouTube needs at least 3 chapters.');
  const starts = [0, ...chapters.map(chapter => chapter.at)];
  for (let i = 1; i < starts.length; i += 1) if (starts[i] - starts[i - 1] < 10 && starts[i] > 0) warnings.push(`A chapter at ${ytClock(starts[i])} is under 10 s after the previous one; YouTube needs 10 s.`);
  return { text: `${lines.join('\n')}\n`, chapters, warnings };
}

// ---- tool --------------------------------------------------------------------------------

/** Accepts cut_phrases clips and older snake_case lists (src_in, f_in, ch, chsub, wr). */
export function normalizeClip(raw: any, index: number): CutClip {
  const srcIn = Number(raw?.srcIn ?? raw?.src_in);
  const srcOut = Number(raw?.srcOut ?? raw?.src_out);
  const words = Array.isArray(raw?.words) ? raw.words : Array.isArray(raw?.wr) ? raw.wr : [0, -1];
  return {
    id: String(raw?.id ?? `c${index + 1}`),
    seg: String(raw?.seg ?? raw?.id ?? `c${index + 1}`),
    angle: raw?.angle,
    chapter: raw?.chapter ?? raw?.ch ?? null,
    chapterSub: raw?.chapterSub ?? raw?.chsub ?? null,
    fIn: Number(raw?.fIn ?? raw?.f_in ?? 0),
    fOut: Number(raw?.fOut ?? raw?.f_out ?? 0),
    srcIn, srcOut,
    snapIn: Boolean(raw?.snapIn ?? raw?.snap_in),
    snapOut: Boolean(raw?.snapOut ?? raw?.snap_out),
    words: [Number(words[0]), Number(words[1])],
    rmsIn: Number(raw?.rmsIn ?? raw?.rms_in ?? 0),
    rmsOut: Number(raw?.rmsOut ?? raw?.rms_out ?? 0),
    text: String(raw?.text ?? '')
  };
}

export type CutDeps = {
  ffmpeg: string;
  ffprobe: string;
  readRoots: () => string[];
  whisper: () => WhisperInfo | null;
  cache: ResultCache;
  /** Work folder for clip lists and verification (project Work/, else Smoothy's agent folder). */
  workDir: () => Promise<string>;
  /** Deliverables folder for captions and chapters (project Edit/, else Smoothy's agent folder). */
  editDir: () => Promise<string>;
  uniquePath: (file: string) => Promise<string>;
  /** Imports the source into the open headless project and lays the clips end to end. */
  placeClips?: (source: string, clips: { srcIn: number; srcOut: number }[]) => Promise<any>;
  startJob: (kind: string, runner: (progress: (percent: number, message: string) => void, signal: AbortSignal, jobId: string) => Promise<any>) => { id: string; status: string };
  waitJob: (id: string, ms: number) => Promise<AgentJob | null>;
  trackTool?: (id: string) => void;
};

const ok = (data: unknown): AgentResult => ({ ok: true, data });
const fail = (code: any, message: string, next?: string): AgentResult => ({ ok: false, error: { code, message, next } });
const num = (value: unknown, min: number, max: number, fallback: number) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
const safeName = (value: string) => value.replace(/[^\w .()-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'edit';

export class CutEngine {
  constructor(private readonly deps: CutDeps) {}

  async run(input: any): Promise<AgentResult> {
    const action = String(input?.action || '');
    try {
      switch (action) {
        case 'cut_phrases': return await this.cutPhrases(input);
        case 'verify_edit': return await this.verify(input);
        case 'captions': return await this.captions(input);
        case 'chapters': return await this.chapters(input);
        default: return fail('E_BAD_REQUEST', `Unknown cut action: ${action || '(none)'}`, 'Use cut_phrases, verify_edit, captions or chapters.');
      }
    } catch (error: any) {
      if (typeof error?.code === 'string' && error.code.startsWith('E_')) return fail(error.code, error.message);
      throw error;
    }
  }

  private async readJson(value: unknown, label: string): Promise<any> {
    if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`Provide ${label} as an absolute file path.`), { code: 'E_BAD_REQUEST' });
    let real: string;
    try { real = await fs.realpath(path.resolve(value.trim())); } catch { throw Object.assign(new Error(`${label} was not found: ${value}`), { code: 'E_NOT_FOUND' }); }
    if (!within(real, this.deps.readRoots())) throw Object.assign(new Error(`${label} is outside the folders Smoothy can read.`), { code: 'E_PATH_DENIED' });
    const stat = await fs.stat(real);
    if (stat.size > 80 * 1024 * 1024) throw Object.assign(new Error(`${label} is too large.`), { code: 'E_BAD_REQUEST' });
    try { return JSON.parse(await fs.readFile(real, 'utf8')); } catch { throw Object.assign(new Error(`${label} is not valid JSON.`), { code: 'E_BAD_REQUEST' }); }
  }

  private async words(input: any): Promise<{ words: Word[]; source: string | null }> {
    const data = await this.readJson(input?.words, 'words (words.json from smoothy_analyze transcribe_words)');
    const list = Array.isArray(data) ? data : data?.words;
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error('words.json has no words.'), { code: 'E_BAD_REQUEST' });
    const words = list.map((word: any) => ({ w: String(word.w ?? ''), a: Number(word.a), b: Number(word.b ?? word.a), p: Number(word.p ?? 1), ...(word.filler ? { filler: true as const } : {}) }))
      .filter((word: Word) => Number.isFinite(word.a));
    return { words, source: typeof data?.source === 'string' ? data.source : null };
  }

  private async clipsFrom(input: any): Promise<{ clips: CutClip[]; fps: number | null; source: string | null; file: string | null }> {
    if (Array.isArray(input?.clips)) return { clips: input.clips.map(normalizeClip), fps: Number(input?.fps) || null, source: null, file: null };
    const data = await this.readJson(input?.clips, 'clips (clips.json from cut_phrases)');
    const clips = Array.isArray(data) ? data : data?.clips;
    if (!Array.isArray(clips) || !clips.length) throw Object.assign(new Error('The clip list is empty.'), { code: 'E_BAD_REQUEST' });
    return { clips: clips.map(normalizeClip), fps: Number(data?.fps) || null, source: typeof data?.source === 'string' ? data.source : null, file: String(input.clips) };
  }

  private async sourceFps(source: string | null): Promise<number> {
    if (!source) return 30;
    try {
      const probe = await probeMedia(this.deps.ffprobe, source);
      return Number(probe.video?.fps) || 30;
    } catch {
      return 30;
    }
  }

  private async cutPhrases(input: any): Promise<AgentResult> {
    const { words, source } = await this.words(input);
    const envData = await this.readJson(input?.envelope, 'envelope (envelope.json from smoothy_analyze envelope)');
    const env: Envelope = { from: Number(envData?.from) || 0, binMs: Number(envData?.binMs) || 10, db: Array.isArray(envData?.db) ? envData.db : [] };
    if (!env.db.length) return fail('E_BAD_REQUEST', 'The envelope has no samples.');
    const rows: CutRow[] = Array.isArray(input?.rows) ? input.rows : [];
    if (!rows.length) return fail('E_BAD_REQUEST', 'Provide rows: [{chapter, sub}] and [{id, near:"mm:ss", from:"phrase", to:"phrase", skip?:[...], angle?}].');
    if (rows.length > 2000) return fail('E_BAD_REQUEST', 'At most 2000 rows.');
    let heard: number[] = [];
    if (Array.isArray(input?.fillers)) heard = input.fillers.map(Number).filter(Number.isFinite);
    else if (typeof input?.fillers === 'string') {
      const report = await this.readJson(input.fillers, 'fillers (verify report)');
      heard = (report?.heardFillers || []).map((item: any) => Number(item?.source ?? item)).filter(Number.isFinite);
    }
    const fps = Number(input?.fps) > 0 ? Number(input.fps) : await this.sourceFps(source);
    const settings: CutSettings = {
      fps,
      thresholdDb: num(input?.thresholdDb, -90, -10, DEFAULT_CUT.thresholdDb),
      quietDb: num(input?.quietDb, -90, -10, DEFAULT_CUT.quietDb),
      lead: num(input?.lead, 0, 1, DEFAULT_CUT.lead),
      tail: num(input?.tail, 0, 1, DEFAULT_CUT.tail),
      maxGap: num(input?.maxGap, 0.1, 10, DEFAULT_CUT.maxGap),
      keepGap: num(input?.keepGap, 0, 5, DEFAULT_CUT.keepGap),
      fillerMax: num(input?.fillerMax, 0.1, 2, DEFAULT_CUT.fillerMax),
      removeFillers: input?.removeFillers !== false
    };
    const { clips, problems } = resolveCutList(words, env, rows, settings, heard);
    const dir = path.join(await this.deps.workDir(), 'edit');
    await fs.mkdir(dir, { recursive: true });
    const name = safeName(String(input?.name || 'cut'));
    const file = await this.deps.uniquePath(path.join(dir, `${name}-clips.json`));
    const total = clips.reduce((sum, clip) => sum + (clip.fOut - clip.fIn), 0) / fps;
    await fs.writeFile(file, JSON.stringify({ source, fps, settings, heardFillers: heard.length, problems, clips }, null, 1));
    this.deps.trackTool?.('agent_cut_phrases');
    let placed: any;
    if (input?.place === true && clips.length) {
      if (!source) return fail('E_BAD_REQUEST', 'words.json has no source path, so the clips cannot be placed.');
      if (!this.deps.placeClips) return fail('E_NOT_IMPLEMENTED', 'Placing clips is not available in this build.');
      placed = await this.deps.placeClips(source, clips);
    }
    const loud = clips.filter(clip => clip.rmsIn > -40 || clip.rmsOut > -40).map(clip => ({ id: clip.id, rmsIn: clip.rmsIn, rmsOut: clip.rmsOut }));
    return ok({
      action: 'cut_phrases', clips: clips.length, seconds: Number(total.toFixed(2)), fps, problems: problems.slice(0, 30), problemCount: problems.length,
      cutsOnSpeech: loud.slice(0, 20), heardFillersUsed: heard.length || undefined,
      first: clips.slice(0, 5).map(clip => ({ id: clip.id, in: clip.srcIn, out: clip.srcOut, text: clip.text.slice(0, 80) })),
      files: { clips: file },
      placed,
      next: 'Check it with smoothy_cut verify_edit {clips, words}. Fix rows for each reported issue, pass the verify report as fillers, and cut again.'
    });
  }

  private pickModel(): { path: string; preset: string; info: WhisperInfo } | null {
    const info = this.deps.whisper();
    if (!info?.path) return null;
    const order = ['ggml-small.en.bin', 'ggml-medium.en.bin', 'ggml-large-v3-turbo.bin', 'ggml-small.bin', 'ggml-base.en.bin', 'ggml-medium.bin', 'ggml-base.bin'];
    for (const id of order) {
      const model = info.models.find(item => path.basename(item.path) === id);
      const preset = model ? dtwPreset(model.path) : null;
      if (model && preset) return { path: model.path, preset, info };
    }
    return null;
  }

  private async verify(input: any): Promise<AgentResult> {
    const { words, source: wordsSource } = await this.words(input);
    const list = await this.clipsFrom(input);
    const clips = list.clips.filter(clip => Number(clip.srcOut) > Number(clip.srcIn));
    const source = typeof input?.source === 'string' && input.source ? input.source : list.source || wordsSource;
    if (!source) return fail('E_BAD_REQUEST', 'Provide source (the media file the clips cut).');
    if (!clips.length) return fail('E_BAD_REQUEST', 'No clips to verify.');
    if (clips.length > 1500) return fail('E_BAD_REQUEST', 'At most 1500 clips per verification.');
    const model = this.pickModel();
    if (!model) return fail('E_MODEL_MISSING', 'whisper-cli or a whisper model is missing.', 'Call smoothy_analyze action "install_model" model "small.en".');
    const real = await fs.realpath(source).catch(() => '');
    if (!real || !within(real, this.deps.readRoots())) return fail('E_PATH_DENIED', 'The source is missing or outside the folders Smoothy can read.');
    const key = hashKey({ stamp: await fileStamp(real), clips: clips.map(clip => [clip.id, clip.srcIn, clip.srcOut]), model: model.path });
    this.deps.trackTool?.('agent_cut_verify');
    const name = safeName(String(input?.name || (list.file ? path.basename(list.file, '.json').replace(/-clips$/, '') : 'cut')));
    const job = this.deps.startJob('cut.verify', async (progress, signal) => {
      const dir = path.join(await this.deps.workDir(), 'verify', `${name}-${key.slice(0, 6)}`);
      await fs.mkdir(dir, { recursive: true });
      const gapped = path.join(dir, 'gapped.wav');
      const lo = Math.max(0, Math.min(...clips.map(clip => clip.srcIn)) - 1);
      const hi = Math.max(...clips.map(clip => clip.srcOut)) + 1;
      const starts: [number, number][] = [];
      let t = 0;
      for (const clip of clips) { const d = clip.srcOut - clip.srcIn; starts.push([t, t + d]); t += d + 0.6; }
      let raw: any = await this.deps.cache.get('verify-dtw', key);
      if (!raw) {
        progress(2, 'Extracting the source audio');
        const section = path.join(dir, 'section.wav');
        const extract = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-y', '-ss', String(lo), '-t', String(hi - lo), '-i', real, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', section], { cwd: dir, signal, timeoutMs: 3600000, expected: hi - lo, onProgress: p => progress(2 + p * 0.08, 'Extracting audio') });
        if (extract.exitCode !== 0) throw new Error(`Audio extraction failed: ${extract.stderrTail.slice(-2).join(' ')}`);
        progress(11, 'Rendering the cut with 0.6 s gaps');
        let graph = '';
        clips.forEach((clip, i) => { graph += `[0:a]atrim=${(clip.srcIn - lo).toFixed(5)}:${(clip.srcOut - lo).toFixed(5)},asetpts=PTS-STARTPTS[a${i}];anullsrc=r=16000:cl=mono,atrim=0:0.6[g${i}];`; });
        graph += `${clips.map((_, i) => `[a${i}][g${i}]`).join('')}concat=n=${2 * clips.length}:v=0:a=1[out]`;
        const script = path.join(dir, 'graph.txt');
        await fs.writeFile(script, graph);
        const render = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-y', '-i', section, '-filter_complex_script', script, '-map', '[out]', '-ar', '16000', '-ac', '1', gapped], { cwd: dir, signal, timeoutMs: 3600000, expected: t, onProgress: p => progress(11 + p * 0.09, 'Rendering the cut') });
        if (render.exitCode !== 0) throw new Error(`Rendering the cut failed: ${render.stderrTail.slice(-2).join(' ')}`);
        await fs.rm(section, { force: true });
        progress(20, 'Transcribing the edit');
        const prefix = path.join(dir, 'gapped');
        const args = ['-m', model.path, '-f', gapped, '-t', String(Math.max(1, Math.min(8, os.cpus().length))), '-l', /\.en\.bin$/.test(model.path) ? 'en' : 'auto', '-nfa', '-dtw', model.preset, '-oj', '-ojf', '-of', prefix, '--prompt', FILLER_PROMPT, '-pp'];
        if (model.info.variant === 'cpu') args.push('-ng');
        const run = await runEngine(model.info.path as string, 'whisper', args, { cwd: dir, signal, timeoutMs: 6 * 3600000, onProgress: p => progress(20 + p * 0.75, `Transcribing ${Math.round(p)}%`) });
        if (run.exitCode !== 0) throw new Error(`whisper-cli failed: ${run.stderrTail.slice(-3).join(' ')}`);
        raw = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'));
        await this.deps.cache.set('verify-dtw', key, raw).catch(() => {});
      }
      const heardWords = wordsFromDtw(raw, 0, DTW_SHIFT);
      const located = heardWords.map(word => {
        const mid = (word.a + word.b) / 2;
        const index = starts.findIndex(([a, b]) => a - 0.1 <= mid && mid <= b + 0.35);
        return { word, index };
      });
      const heard = located.map(({ word, index }) => ({ w: word.w, clip: index >= 0 ? clips[index].id : '?' }));
      const report = compareEdit(words, clips as CutClip[], heard);
      const heardFillers = located.filter(item => item.index >= 0 && item.word.filler).map(({ word, index }) => ({
        clip: clips[index].id,
        word: word.w,
        source: Number((clips[index].srcIn + Math.max(0, word.a - starts[index][0])).toFixed(3))
      }));
      const counts = new Map<number, number>();
      for (const item of located) if (item.index >= 0 && !item.word.filler) counts.set(item.index, (counts.get(item.index) || 0) + 1);
      const silent = clips.filter((clip, i) => !counts.get(i) && clip.srcOut - clip.srcIn > 0.25).map(clip => clip.id);
      const file = path.join(dir, 'verify.json');
      await fs.writeFile(file, JSON.stringify({ source: real, similarity: report.similarity, expected: report.expected, heard: report.heardWords, issues: report.issues, heardFillers, silentClips: silent, gapped, starts: clips.map((clip, i) => ({ id: clip.id, at: Number(starts[i][0].toFixed(3)) })) }, null, 1));
      progress(100, 'Verified');
      return {
        similarity: report.similarity, expectedWords: report.expected, heardWords: report.heardWords,
        issueCount: report.issues.length, issues: report.issues.slice(0, 15),
        heardFillerCount: heardFillers.length, heardFillers: heardFillers.slice(0, 10),
        silentClips: silent,
        files: { report: file, gapped },
        next: report.issues.length || heardFillers.length
          ? `Fix the rows behind each issue. To cut the heard fillers, run cut_phrases again with fillers:"${file}".`
          : 'The cut says exactly what the cut list expects.'
      };
    });
    const waitMs = Math.max(0, Math.min(120000, input?.waitMs === undefined ? 20000 : Number(input.waitMs) || 0));
    const view = await this.deps.waitJob(job.id, waitMs);
    if (view?.status === 'done') return ok({ action: 'verify_edit', jobId: job.id, ...(view.result as any) });
    if (view && view.status !== 'running') return fail('E_INTERNAL', view.error || 'Verification failed.');
    return ok({ action: 'verify_edit', jobId: job.id, status: 'running', progress: view?.progress ?? 0, etaSeconds: view?.etaSeconds ?? null, next: `Wait with smoothy_jobs action "wait" id "${job.id}".` });
  }

  private inserts(input: any): { before: string; seconds: number }[] {
    return (Array.isArray(input?.inserts) ? input.inserts : []).slice(0, 500).map((item: any) => ({ before: String(item?.before || ''), seconds: Number(item?.seconds) || 0 })).filter((item: any) => item.before && item.seconds > 0);
  }

  private async captions(input: any): Promise<AgentResult> {
    const { words } = await this.words(input);
    const list = await this.clipsFrom(input);
    const fps = Number(input?.fps) > 0 ? Number(input.fps) : list.fps || 30;
    const placed = layoutClips(list.clips, this.inserts(input), Number(input?.start) || 0);
    const corrections: Correction[] = (Array.isArray(input?.corrections) ? input.corrections : [])
      .map((item: any) => ({ find: String(item?.find ?? ''), replace: String(item?.replace ?? ''), regex: item?.regex === true }))
      .filter((item: Correction) => item.find);
    const result = buildCaptions(words, placed, { fps, maxWords: input?.maxWords, gapFrames: input?.gapFrames !== undefined ? Number(input.gapFrames) : 8, corrections, skipChapters: Array.isArray(input?.skipChapters) ? input.skipChapters.map(String) : [] });
    if (!result.cues.length) return fail('E_BAD_REQUEST', 'No caption words fall inside these clips.');
    const file = await this.deps.uniquePath(path.join(await this.deps.editDir(), `${safeName(String(input?.name || 'captions'))}.srt`));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, result.srt);
    this.deps.trackTool?.('agent_cut_captions');
    return ok({ action: 'captions', cues: result.cues.length, seconds: result.cues[result.cues.length - 1].end, file, first: result.cues.slice(0, 5) });
  }

  private async chapters(input: any): Promise<AgentResult> {
    const list = await this.clipsFrom(input);
    const placed = layoutClips(list.clips, this.inserts(input), Number(input?.start) || 0);
    const result = buildChapters(placed, { skipChapters: Array.isArray(input?.skipChapters) ? input.skipChapters.map(String) : [], titleCase: input?.titleCase !== false, intro: typeof input?.intro === 'string' ? input.intro : undefined });
    if (!result.chapters.length) return fail('E_BAD_REQUEST', 'The clips carry no chapters. Add {chapter, sub} rows to the cut list.');
    const dir = await this.deps.editDir();
    await fs.mkdir(dir, { recursive: true });
    const file = await this.deps.uniquePath(path.join(dir, `${safeName(String(input?.name || 'chapters'))}.txt`));
    await fs.writeFile(file, result.text);
    const json = file.replace(/\.txt$/, '.json');
    await fs.writeFile(json, JSON.stringify({ chapters: result.chapters }, null, 1));
    this.deps.trackTool?.('agent_cut_chapters');
    return ok({ action: 'chapters', count: result.chapters.length, text: result.text, warnings: result.warnings, files: { text: file, markers: json } });
  }
}
