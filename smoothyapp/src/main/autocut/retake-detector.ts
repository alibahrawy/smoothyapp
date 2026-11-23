/**
 * Deterministic repeated-sentence / retake detector for Silence Removal.
 *
 * Uses local word timestamps from whisper.cpp (no LLM, no cloud API) to find
 * repeated takes and stumbled false starts, always keeping the final take.
 */

import type { SilenceAnalysisResult, SilenceSegment, SpeechSegment } from './silence-detector';

export type RetakeSensitivity = 'conservative' | 'balanced' | 'aggressive';

export interface WordChunk {
  text: string;
  timestamp: [number, number];
}

export interface RemovedRetake {
  start: number;
  end: number;
  duration: number;
  text: string;
  matchedText: string;
  reason: 'repeat' | 'false-start';
  similarity: number;
}

export interface RetakeDetectionOptions {
  sensitivity?: RetakeSensitivity;
  padding?: number;
}

export interface RetakeDetectionResult {
  speechSegments: SpeechSegment[];
  silenceSegments: SilenceSegment[];
  removedRetakes: RemovedRetake[];
  retakesRemoved: number;
  retakesCount: number;
  newDuration: number;
  cutsCount: number;
}

export type RetakeTranscribeProgress = (progress: { status: string; progress?: number }) => void;

export type RetakeTranscriber = (
  audioPath: string,
  onProgress?: RetakeTranscribeProgress,
  signal?: AbortSignal
) => Promise<WordChunk[]>;

interface NormalizedWord {
  raw: string;
  norm: string;
  start: number;
  end: number;
  endsSentence: boolean;
}

interface Utterance {
  segmentIndex: number;
  start: number;
  end: number;
  words: NormalizedWord[];
  matchWords: string[];
  rawText: string;
  numbers: string[];
}

interface SensitivityProfile {
  /** Minimum fuzzy ordered-LCS F1 score for a full/near-duplicate repeat. */
  repeatF1: number;
  /** Minimum fraction of A's words matching the start of B for a false start. */
  prefixCoverage: number;
  /** Maximum seconds between the end of take A and start of take B. */
  maxGapSeconds: number;
  /** Minimum matched words for a non-exact repeat. */
  minRepeatWords: number;
  /** Maximum lead-in words skipped on A or B during prefix alignment. */
  maxLeadSkip: number;
  /** Pause duration (seconds) inside a speech segment that splits candidate utterances. */
  internalPauseSeconds: number;
}

const PROFILES: Record<RetakeSensitivity, SensitivityProfile> = {
  conservative: {
    repeatF1: 0.82,
    prefixCoverage: 0.85,
    maxGapSeconds: 20,
    minRepeatWords: 3,
    maxLeadSkip: 1,
    internalPauseSeconds: 0.5,
  },
  balanced: {
    repeatF1: 0.72,
    prefixCoverage: 0.75,
    maxGapSeconds: 25,
    minRepeatWords: 2,
    maxLeadSkip: 2,
    internalPauseSeconds: 0.42,
  },
  aggressive: {
    repeatF1: 0.62,
    prefixCoverage: 0.65,
    maxGapSeconds: 35,
    minRepeatWords: 2,
    maxLeadSkip: 2,
    internalPauseSeconds: 0.35,
  },
};

/** Pure hesitation sounds ignored during comparison (never dropped on their own). */
const FILLER_WORDS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'er', 'erm', 'ah', 'ahh', 'hm', 'hmm', 'mm',
]);

/** Common function words — a 2-word match needs at least one word outside this set. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your',
  'so', 'now', 'just', 'well', 'yeah', 'yes', 'no', 'okay', 'ok', 'oh',
  // Common Arabic function words
  'في', 'من', 'على', 'الي', 'عن', 'مع', 'و', 'او', 'ان', 'ما', 'لا', 'هذا', 'هذه', 'هو', 'هي',
]);

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5',
  '6th': '6', '7th': '7', '8th': '8', '9th': '9', '10th': '10',
};

const CONTRACTION_ALIASES: Record<string, string> = {
  gonna: 'going',
  wanna: 'want',
  gotta: 'got',
  kinda: 'kind',
  sorta: 'sort',
  im: 'i',
  ive: 'i',
  ill: 'i',
  id: 'i',
  youre: 'you',
  weve: 'we',
  were: 'we',
  theyre: 'they',
  dont: 'do',
  doesnt: 'does',
  didnt: 'did',
  cant: 'can',
  wont: 'will',
  isnt: 'is',
  arent: 'are',
  wasnt: 'was',
  werent: 'were',
  thats: 'that',
  whats: 'what',
  heres: 'here',
  theres: 'there',
  lets: 'let',
  its: 'it',
};

const SENTENCE_END_RE = /[.!?؟。…]+\s*$/;
const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u0640]/g;

export function normalizeRetakeSensitivity(value: unknown): RetakeSensitivity {
  if (value === 'conservative' || value === 'aggressive') return value;
  return 'balanced';
}

/**
 * Normalize a spoken token for deterministic cross-take comparison.
 * Preserves Unicode letters and digits across Latin, Arabic, CJK, etc.
 */
export function normalizeRetakeWord(raw: string): string {
  let text = String(raw || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();

  if (!text) return '';
  if (CONTRACTION_ALIASES[text]) text = CONTRACTION_ALIASES[text];
  return text;
}

function extractNumberToken(norm: string): string | null {
  if (/^\d+$/.test(norm)) return norm;
  if (NUMBER_WORDS[norm]) return NUMBER_WORDS[norm];
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

export function wordsMatchFuzzy(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4 || maxLen - minLen > 2) return false;
  // Never fuzzily match distinct numbers (e.g. "1000" vs "2000").
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  const dist = levenshtein(a, b);
  return dist <= 1 || (maxLen >= 7 && dist <= 2 && 1 - dist / maxLen >= 0.75);
}

/** Longest common subsequence length under fuzzy word equality. */
function fuzzyLcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      if (wordsMatchFuzzy(a[i - 1], b[j - 1])) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function hasContentWord(words: string[]): boolean {
  return words.some(w => !STOPWORDS.has(w) && w.length >= 2);
}

function numbersConflict(aNums: string[], bNums: string[]): boolean {
  if (aNums.length === 0 || bNums.length === 0) return false;
  const minLen = Math.min(aNums.length, bNums.length);
  for (let i = 0; i < minLen; i++) {
    if (aNums[i] !== bNums[i]) return true;
  }
  return false;
}

/**
 * Detect an immediate in-utterance restart (no pause long enough to split on),
 * e.g. "So today we are going So today we are going to build a tool".
 * Returns split indices within `words` where a repeated run restarts.
 */
function findImmediateRestartSplits(words: NormalizedWord[]): number[] {
  const splits: number[] = [];
  const norms = words.map(w => w.norm);
  let start = 0;

  while (start < words.length) {
    let foundSplit = -1;
    // Scan for a prefix (from start or start+1) of >= 3 meaningful words repeating soon after.
    for (let anchor = start; anchor <= Math.min(start + 1, words.length - 4); anchor++) {
      // Gather non-filler indices from anchor.
      const anchorSeq: number[] = [];
      for (let k = anchor; k < words.length && anchorSeq.length < 6; k++) {
        if (norms[k] && !FILLER_WORDS.has(norms[k])) anchorSeq.push(k);
      }
      if (anchorSeq.length < 3) continue;

      const maxSpan = Math.min(words.length - 1, anchor + 18);
      for (let j = anchorSeq[2]; j <= maxSpan; j++) {
        if (!norms[j] || FILLER_WORDS.has(norms[j])) continue;
        if (!wordsMatchFuzzy(norms[anchorSeq[0]], norms[j])) continue;

        // Check how many consecutive non-filler words match starting at j.
        let matched = 0;
        let p = 0;
        let q = j;
        while (p < anchorSeq.length && q < words.length) {
          if (!norms[q] || FILLER_WORDS.has(norms[q])) {
            q++;
            continue;
          }
          if (wordsMatchFuzzy(norms[anchorSeq[p]], norms[q])) {
            matched++;
            p++;
            q++;
          } else {
            break;
          }
        }
        const matchedTokens = anchorSeq.slice(0, matched).map(idx => norms[idx]);
        if (matched >= 3 && hasContentWord(matchedTokens)) {
          // Ensure the earlier attempt doesn't overlap the restart index.
          if (anchorSeq[matched - 1] < j) {
            foundSplit = j;
            break;
          }
        }
      }
      if (foundSplit !== -1) break;
    }

    if (foundSplit !== -1) {
      splits.push(foundSplit);
      start = foundSplit;
    } else {
      break;
    }
  }

  return splits;
}

function buildUtterance(
  segmentIndex: number,
  start: number,
  end: number,
  words: NormalizedWord[]
): Utterance {
  const matchWords: string[] = [];
  const numbers: string[] = [];
  for (const w of words) {
    if (!w.norm || FILLER_WORDS.has(w.norm)) continue;
    matchWords.push(w.norm);
    const num = extractNumberToken(w.norm);
    if (num !== null) numbers.push(num);
  }
  return {
    segmentIndex,
    start,
    end,
    words,
    matchWords,
    rawText: words.map(w => w.raw).join(' ').replace(/\s+/g, ' ').trim(),
    numbers,
  };
}

function splitSegmentIntoUtterances(
  segmentIndex: number,
  segment: SpeechSegment,
  segmentWords: NormalizedWord[],
  profile: SensitivityProfile,
  padding: number
): Utterance[] {
  if (segmentWords.length === 0) {
    return [buildUtterance(segmentIndex, segment.start, segment.end, [])];
  }

  // First pass: split on inter-word pauses or sentence-ending punctuation.
  const coarseGroups: NormalizedWord[][] = [];
  let current: NormalizedWord[] = [segmentWords[0]];
  for (let i = 1; i < segmentWords.length; i++) {
    const prev = segmentWords[i - 1];
    const next = segmentWords[i];
    const gap = next.start - prev.end;
    const shouldSplit = gap >= profile.internalPauseSeconds || prev.endsSentence;
    if (shouldSplit && current.length > 0) {
      coarseGroups.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }
  if (current.length > 0) coarseGroups.push(current);

  // Second pass: split any immediate in-utterance restarts (no long pause).
  const groups: NormalizedWord[][] = [];
  for (const group of coarseGroups) {
    const splitPoints = findImmediateRestartSplits(group);
    if (splitPoints.length === 0) {
      groups.push(group);
    } else {
      let prevIdx = 0;
      for (const idx of splitPoints) {
        if (idx > prevIdx) groups.push(group.slice(prevIdx, idx));
        prevIdx = idx;
      }
      if (prevIdx < group.length) groups.push(group.slice(prevIdx));
    }
  }

  // Convert word groups into time-bounded utterances covering [segment.start, segment.end].
  const cutLead = Math.min(Math.max(0, padding), 0.08);
  const utterances: Utterance[] = [];
  for (let g = 0; g < groups.length; g++) {
    const words = groups[g];
    let start: number;
    let end: number;
    if (g === 0) {
      start = segment.start;
    } else {
      const prevEnd = groups[g - 1][groups[g - 1].length - 1].end;
      const nextStart = words[0].start;
      if (nextStart > prevEnd) {
        start = Math.max(prevEnd, nextStart - Math.min(cutLead, (nextStart - prevEnd) / 2));
      } else {
        start = Math.max(segment.start, nextStart);
      }
    }
    if (g === groups.length - 1) {
      end = segment.end;
    } else {
      const currEnd = words[words.length - 1].end;
      const nextStart = groups[g + 1][0].start;
      if (nextStart > currEnd) {
        end = Math.max(currEnd, nextStart - Math.min(cutLead, (nextStart - currEnd) / 2));
      } else {
        end = Math.min(segment.end, currEnd);
      }
    }
    if (end <= start) end = Math.min(segment.end, Math.max(start + 0.01, words[words.length - 1].end));
    utterances.push(buildUtterance(segmentIndex, start, end, words));
  }
  return utterances;
}

/**
 * Evaluate whether earlier utterance `a` is a repeated take or false start of later utterance `b`.
 */
function matchRetakePair(
  a: Utterance,
  b: Utterance,
  profile: SensitivityProfile
): { reason: 'repeat' | 'false-start'; similarity: number } | null {
  const aw = a.matchWords;
  const bw = b.matchWords;
  if (aw.length < 2 || bw.length < 2) return null;

  const gap = b.start - a.end;
  if (gap > profile.maxGapSeconds || gap < -0.1) return null;

  // Guard against cutting sequential numbered points ("Step 1..." vs "Step 2...").
  if (numbersConflict(a.numbers, b.numbers)) return null;

  // 1. Check full / near-duplicate repeat via fuzzy ordered LCS.
  const lcs = fuzzyLcsLength(aw, bw);
  const f1 = (2 * lcs) / (aw.length + bw.length);
  const coverageA = lcs / aw.length;
  const exactMatch = aw.length === bw.length && lcs === aw.length;

  if (exactMatch && hasContentWord(aw)) {
    // In conservative mode require >= 3 words or >= 2 content words to avoid cutting short emphasis.
    const contentCount = aw.filter(w => !STOPWORDS.has(w)).length;
    if (aw.length >= profile.minRepeatWords || contentCount >= 2) {
      return { reason: 'repeat', similarity: 1 };
    }
  }

  if (
    f1 >= profile.repeatF1 &&
    lcs >= profile.minRepeatWords &&
    coverageA >= profile.repeatF1 &&
    hasContentWord(aw)
  ) {
    // For short 2-word repeats, require at least 1 strong content word and high similarity.
    if (aw.length === 2 && (!hasContentWord(aw) || f1 < 0.8)) {
      // Fall through to prefix check below
    } else {
      return { reason: 'repeat', similarity: round3(f1) };
    }
  }

  // 2. Check stumbled false start / prefix restart:
  //    A matches the opening of B (allowing a small lead-in shift on A or B).
  if (bw.length >= aw.length && bw.length >= 3) {
    let bestPrefixCov = 0;
    let bestMatched = 0;
    let bestHasContent = false;

    for (let skipA = 0; skipA <= Math.min(profile.maxLeadSkip, aw.length - 2); skipA++) {
      const aSlice = aw.slice(skipA);
      if (aSlice.length < 2) continue;

      for (let skipB = 0; skipB <= Math.min(profile.maxLeadSkip, bw.length - 2); skipB++) {
        const bWindow = bw.slice(skipB, skipB + aSlice.length + 2);
        if (bWindow.length < 2) continue;

        const prefLcs = fuzzyLcsLength(aSlice, bWindow);
        const totalCovA = prefLcs / aw.length;
        const sliceCovA = prefLcs / aSlice.length;

        // If we skipped lead-in words on A (e.g. "Okay so today we're"), require
        // at least 3 matched words and solid coverage of A overall. Pure stopword
        // lead-ins ("Okay so...") get a slightly looser total-coverage floor.
        const minNeeded = skipA > 0 ? Math.max(3, profile.minRepeatWords) : 2;
        const skippedAreStopwords = skipA > 0 && aw.slice(0, skipA).every(w => STOPWORDS.has(w));
        const minTotalCov = skipA > 0
          ? (skippedAreStopwords ? 0.55 : Math.max(0.65, profile.prefixCoverage - 0.08))
          : profile.prefixCoverage;

        if (
          prefLcs >= minNeeded &&
          sliceCovA >= profile.prefixCoverage &&
          totalCovA >= minTotalCov
        ) {
          // Verify the matched prefix itself contains content (not just "and the").
          const matchedWords = aSlice.filter(w => bWindow.some(bwTok => wordsMatchFuzzy(w, bwTok)));
          const contentOk = prefLcs >= 3 || hasContentWord(matchedWords);
          if (contentOk && totalCovA > bestPrefixCov) {
            bestPrefixCov = totalCovA;
            bestMatched = prefLcs;
            bestHasContent = contentOk;
          }
        }
      }
    }

    if (bestHasContent && bestMatched >= 2) {
      // Conservative mode: for 2-word false starts require exact 2/2 opening match with a content word.
      if (aw.length === 2 && bestPrefixCov < 1) return null;
      return { reason: 'false-start', similarity: round3(bestPrefixCov) };
    }
  }

  return null;
}

/**
 * Invert kept speech segments over [0, totalDuration] into merged removal ranges.
 */
export function complementSpeechSegments(
  speechSegments: SpeechSegment[],
  totalDuration: number
): SilenceSegment[] {
  const total = Math.max(0, totalDuration);
  if (total <= 0) return [];

  const sorted = speechSegments
    .map(s => ({
      start: Math.max(0, Math.min(total, s.start)),
      end: Math.max(0, Math.min(total, s.end)),
    }))
    .filter(s => s.end > s.start + 0.001)
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) {
    return [{ start: 0, end: total, duration: total }];
  }

  // Merge overlapping or touching kept segments first.
  const merged: Array<{ start: number; end: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    if (sorted[i].start <= prev.end + 0.005) {
      prev.end = Math.max(prev.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }

  const removed: SilenceSegment[] = [];
  let cursor = 0;
  for (const seg of merged) {
    if (seg.start > cursor + 0.005) {
      removed.push({
        start: cursor,
        end: seg.start,
        duration: seg.start - cursor,
      });
    }
    cursor = Math.max(cursor, seg.end);
  }
  if (total > cursor + 0.005) {
    removed.push({
      start: cursor,
      end: total,
      duration: total - cursor,
    });
  }
  return removed;
}

/**
 * Detect and drop repeated takes and false starts from a silence analysis result
 * using local word-level transcription chunks.
 */
export function detectRepeatedTakes(
  analysis: SilenceAnalysisResult,
  chunks: WordChunk[],
  options: RetakeDetectionOptions = {}
): RetakeDetectionResult {
  const sensitivity = normalizeRetakeSensitivity(options.sensitivity);
  const profile = PROFILES[sensitivity];
  const padding = Number.isFinite(options.padding) ? Math.max(0, Number(options.padding)) : 0.1;

  const speechSegments = analysis.speechSegments.map(s => ({ ...s }));
  if (speechSegments.length === 0 || chunks.length === 0) {
    const silenceSegments = analysis.silenceSegments.map(s => ({ ...s }));
    return {
      speechSegments,
      silenceSegments,
      removedRetakes: [],
      retakesRemoved: 0,
      retakesCount: 0,
      newDuration: analysis.newDuration,
      cutsCount: speechSegments.length,
    };
  }

  // Normalize Whisper chunks and map each word to its containing (or nearest) speech segment.
  // Whisper timestamps often lag acoustic speech slightly (~0.1-0.25s), so bias lookup
  // slightly earlier (using start + 0.35 * duration) to avoid tail words leaking into the next take.
  const wordsBySegment: NormalizedWord[][] = speechSegments.map(() => []);
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== 'string' || !Array.isArray(chunk.timestamp)) continue;
    const raw = chunk.text.trim();
    if (!raw) continue;
    const start = Number(chunk.timestamp[0]);
    const end = Number(chunk.timestamp[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;

    const anchor = start + (end - start) * 0.35;
    let targetIdx = -1;
    let bestDist = Infinity;
    for (let s = 0; s < speechSegments.length; s++) {
      const seg = speechSegments[s];
      if (anchor >= seg.start - 0.15 && anchor <= seg.end + 0.45) {
        const dist = anchor < seg.start ? seg.start - anchor : anchor > seg.end ? (anchor - seg.end) * 0.75 : 0;
        if (dist < bestDist) {
          bestDist = dist;
          targetIdx = s;
        }
      }
    }
    if (targetIdx === -1) continue;

    // A single chunk may occasionally contain whitespace-separated words.
    const pieces = raw.split(/\s+/).filter(Boolean);
    const span = Math.max(0.01, end - start);
    pieces.forEach((piece, idx) => {
      const wStart = start + (idx / pieces.length) * span;
      const wEnd = start + ((idx + 1) / pieces.length) * span;
      wordsBySegment[targetIdx].push({
        raw: piece,
        norm: normalizeRetakeWord(piece),
        start: wStart,
        end: wEnd,
        endsSentence: SENTENCE_END_RE.test(piece),
      });
    });
  }

  for (const list of wordsBySegment) {
    list.sort((a, b) => a.start - b.start);
  }

  // Split speech segments into candidate utterances.
  const utterances: Utterance[] = [];
  for (let s = 0; s < speechSegments.length; s++) {
    utterances.push(...splitSegmentIntoUtterances(s, speechSegments[s], wordsBySegment[s], profile, padding));
  }

  // Match each utterance against the next utterance (or the one after a brief <= 3-word stumble).
  const dropMatch = new Map<number, { targetIndex: number; reason: 'repeat' | 'false-start'; similarity: number }>();
  for (let i = 0; i < utterances.length - 1; i++) {
    const a = utterances[i];
    if (a.matchWords.length < 2) continue;

    const next = matchRetakePair(a, utterances[i + 1], profile);
    if (next) {
      dropMatch.set(i, { targetIndex: i + 1, ...next });
      continue;
    }

    // Look past a single very short interjection/fumble (e.g. "wait", "sorry", "uh")
    // between two matching takes.
    if (i + 2 < utterances.length) {
      const middle = utterances[i + 1];
      const middleDuration = middle.end - middle.start;
      if (middle.matchWords.length <= 3 && middleDuration <= 2.2) {
        const skipOne = matchRetakePair(a, utterances[i + 2], profile);
        if (skipOne) {
          dropMatch.set(i, { targetIndex: i + 2, ...skipOne });
        }
      }
    }
  }

  // Safety guard: never drop every utterance.
  if (dropMatch.size >= utterances.length) {
    dropMatch.delete(utterances.length - 1);
  }

  // Resolve chained retakes (A -> B -> C) so matchedText shows the final kept take C.
  const resolveFinalTarget = (idx: number): number => {
    let curr = idx;
    const seen = new Set<number>();
    while (dropMatch.has(curr) && !seen.has(curr)) {
      seen.add(curr);
      curr = dropMatch.get(curr)!.targetIndex;
    }
    return curr;
  };

  const removedRetakes: RemovedRetake[] = [];
  const keptUtterances: Utterance[] = [];
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const match = dropMatch.get(i);
    if (match) {
      const finalTarget = utterances[resolveFinalTarget(match.targetIndex)];
      removedRetakes.push({
        start: round3(u.start),
        end: round3(u.end),
        duration: round3(Math.max(0, u.end - u.start)),
        text: u.rawText,
        matchedText: finalTarget?.rawText || '',
        reason: match.reason,
        similarity: match.similarity,
      });
    } else {
      keptUtterances.push(u);
    }
  }

  if (removedRetakes.length === 0) {
    return {
      speechSegments,
      silenceSegments: analysis.silenceSegments.map(s => ({ ...s })),
      removedRetakes: [],
      retakesRemoved: 0,
      retakesCount: 0,
      newDuration: analysis.newDuration,
      cutsCount: speechSegments.length,
    };
  }

  // Merge contiguous kept utterances from the same original speech segment back together
  // so no unnecessary cuts are introduced between kept sentences.
  const finalSpeech: SpeechSegment[] = [];
  let prevKeptSegIndex = -1;
  let prevKeptUtteranceIndex = -1;
  const keptIndexSet = new Set(keptUtterances.map(u => utterances.indexOf(u)));

  for (const u of keptUtterances) {
    const uIdx = utterances.indexOf(u);
    const contiguousInSameSegment =
      finalSpeech.length > 0 &&
      u.segmentIndex === prevKeptSegIndex &&
      uIdx === prevKeptUtteranceIndex + 1 &&
      keptIndexSet.has(prevKeptUtteranceIndex);

    if (contiguousInSameSegment) {
      const last = finalSpeech[finalSpeech.length - 1];
      last.end = Math.max(last.end, u.end);
      last.duration = last.end - last.start;
    } else {
      finalSpeech.push({
        start: u.start,
        end: u.end,
        duration: Math.max(0, u.end - u.start),
      });
    }
    prevKeptSegIndex = u.segmentIndex;
    prevKeptUtteranceIndex = uIdx;
  }

  const finalSilences = complementSpeechSegments(finalSpeech, analysis.originalDuration);
  const retakesRemoved = removedRetakes.reduce((sum, r) => sum + r.duration, 0);
  const newDuration = finalSpeech.reduce((sum, s) => sum + s.duration, 0);

  return {
    speechSegments: finalSpeech,
    silenceSegments: finalSilences,
    removedRetakes,
    retakesRemoved: round3(retakesRemoved),
    retakesCount: removedRetakes.length,
    newDuration: round3(newDuration),
    cutsCount: finalSpeech.length,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
