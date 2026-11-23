/**
 * Caption Formatter - Formats transcription into captions with user settings
 */

import { TranscriptionChunk, TranscriptionResult } from './whisper-service';

export interface CaptionSettings {
  maxCharsPerLine: number;   // Default: 42
  maxLines: number;          // 1 or 2, default: 2
  minDurationSeconds: number; // Default: 1.0
  maxDurationSeconds: number; // Default: 7.0
  gapBetweenCaptions: number; // Default: 0.08 (2 frames at 24fps)
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface FormattedCaption {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  /** Per-word timings (absolute seconds) for Pro animated captions. */
  words?: CaptionWord[];
}

const DEFAULT_SETTINGS: CaptionSettings = {
  maxCharsPerLine: 42,
  maxLines: 2,
  minDurationSeconds: 1.0,
  maxDurationSeconds: 7.0,
  gapBetweenCaptions: 0.08
};

/**
 * Format transcription chunks into captions based on settings
 */
export function formatCaptions(
  result: TranscriptionResult,
  settings: Partial<CaptionSettings> = {}
): FormattedCaption[] {
  const opts = { ...DEFAULT_SETTINGS, ...settings };
  const maxCharsTotal = opts.maxCharsPerLine * opts.maxLines;
  // Never slice ordinary words into letters when maxCharsPerLine is small (e.g. 1 for 1-word captions).
  // Only hard-split genuinely massive unbroken tokens (such as unspaced CJK sentences or long URLs).
  const hardSplitLimit = Math.max(maxCharsTotal, 20);

  if (!result.chunks || result.chunks.length === 0) {
    // If no word-level timestamps, create single caption
    if (result.text) {
      return splitTextIntoCaptions(result.text, 0, 30, opts);
    }
    return [];
  }

  const captions: FormattedCaption[] = [];
  let currentCaption: { words: TranscriptionChunk[]; text: string } = { words: [], text: '' };
  let captionIndex = 1;

  // Split oversized tokens without losing characters; distribute their timing.
  const chunks = result.chunks.flatMap(chunk => {
    const characters = Array.from(chunk.text.trim());
    if (characters.length <= hardSplitLimit) return [chunk];
    const parts: TranscriptionChunk[] = [];
    const chunkStep = Math.max(maxCharsTotal, 1);
    for (let offset = 0; offset < characters.length; offset += chunkStep) {
      const end = Math.min(characters.length, offset + chunkStep);
      const duration = chunk.timestamp[1] - chunk.timestamp[0];
      parts.push({ text: characters.slice(offset, end).join(''), timestamp: [
        chunk.timestamp[0] + duration * offset / characters.length,
        chunk.timestamp[0] + duration * end / characters.length
      ] });
    }
    return parts;
  });
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const wordText = chunk.text.trim();

    if (!wordText) continue;

    // Check if adding this word would exceed limits
    const newText = currentCaption.text ? currentCaption.text + ' ' + wordText : wordText;

    const firstWordTime = currentCaption.words[0]?.timestamp[0] ?? chunk.timestamp[0];
    const newDuration = chunk.timestamp[1] - firstWordTime;

    // Conditions to start a new caption
    const exceedsLength = wrapText(newText, opts.maxCharsPerLine).length > opts.maxLines;
    const exceedsDuration = newDuration > opts.maxDurationSeconds;
    const isEndOfSentence = /[.!?]$/.test(currentCaption.text) && currentCaption.words.length > 0;

    if ((exceedsLength || exceedsDuration || isEndOfSentence) && currentCaption.words.length > 0) {
      // Finalize current caption without stretching past the next spoken word
      const caption = finalizeCaption(currentCaption, captionIndex, opts, captions[captions.length - 1], chunk.timestamp[0]);
      if (caption) {
        captions.push(caption);
        captionIndex++;
      }

      // Start new caption with current word
      currentCaption = { words: [chunk], text: wordText };
    } else {
      // Add word to current caption
      currentCaption.words.push(chunk);
      currentCaption.text = newText;
    }
  }

  // Finalize last caption
  if (currentCaption.words.length > 0) {
    const caption = finalizeCaption(currentCaption, captionIndex, opts, captions[captions.length - 1]);
    if (caption) {
      captions.push(caption);
    }
  }

  // Apply gap between captions
  const gapped = applyGaps(captions, opts.gapBetweenCaptions);
  validateCaptions(gapped);
  return gapped;
}

/**
 * Finalize a caption from collected words. `previous` is the last already-emitted
 * caption; start/end times are clamped so they can never go backwards relative to
 * it. Returns null when the caption can't be placed after the previous one.
 */
function finalizeCaption(
  caption: { words: TranscriptionChunk[]; text: string },
  index: number,
  settings: CaptionSettings,
  previous?: FormattedCaption,
  nextStart?: number
): FormattedCaption | null {
  if (caption.words.length === 0) return null;

  const prevEnd = previous ? previous.endTime : 0;

  let startTime = caption.words[0].timestamp[0];
  if (!(startTime >= prevEnd)) {
    startTime = prevEnd;
  }

  let endTime = caption.words[caption.words.length - 1].timestamp[1];
  const minDuration = Math.min(settings.minDurationSeconds, settings.maxDurationSeconds);

  // Ensure minimum duration (measured from the clamped start), without pushing
  // into the next spoken word so fast 1-word captions stay locked to audio.
  if (endTime - startTime < minDuration) {
    const desiredEnd = startTime + minDuration;
    if (nextStart !== undefined && Number.isFinite(nextStart)) {
      const ceiling = Math.max(endTime, nextStart - settings.gapBetweenCaptions);
      endTime = Math.min(desiredEnd, ceiling);
    } else {
      endTime = desiredEnd;
    }
  }

  // Never emit a backwards or zero-length cue.
  if (!(endTime > startTime)) {
    endTime = startTime + Math.min(0.1, minDuration);
  }

  // Format text with line breaks if needed
  const formattedText = formatTextWithLineBreaks(caption.text, settings);

  return {
    index,
    startTime,
    endTime,
    text: formattedText,
    words: caption.words.map(word => ({ text: word.text.trim(), start: word.timestamp[0], end: word.timestamp[1] }))
  };
}

/**
 * Format text with line breaks based on settings.
 * Keeps individual normal words (<= 20 chars) intact even when `limit` is small
 * (e.g. `1` for 1-word-per-line captions), while still wrapping massive unbroken
 * tokens such as unspaced CJK sentences.
 */
function wrapText(text: string, limit: number): string[] {
  const safeLimit = Math.max(1, limit);
  const hardWordLimit = Math.max(safeLimit, 20);
  const lines: string[] = [];
  let remaining = Array.from(text.trim());
  while (remaining.length > safeLimit) {
    let split = -1;
    for (let index = safeLimit; index > 0; index--) {
      if (/\s/.test(remaining[index])) { split = index; break; }
    }
    if (split === -1) {
      // First word is longer than `safeLimit`: keep it whole unless it's an oversized unbroken token.
      let nextSpace = remaining.length;
      for (let index = safeLimit; index < remaining.length; index++) {
        if (/\s/.test(remaining[index])) { nextSpace = index; break; }
      }
      split = nextSpace <= hardWordLimit ? nextSpace : safeLimit;
    }
    lines.push(remaining.slice(0, split).join(''));
    remaining = Array.from(remaining.slice(split).join('').trimStart());
  }
  if (remaining.length) lines.push(remaining.join(''));
  return lines;
}

function formatTextWithLineBreaks(text: string, settings: CaptionSettings): string {
  return wrapText(text, settings.maxCharsPerLine).join('\n');
}

/**
 * Apply gaps between captions and enforce a strictly increasing timeline.
 *
 * If a caption still can't be placed after the previous one without collapsing
 * its own duration (i.e. the requested start would land at or past its end),
 * its text is merged into the previous caption instead of emitting a broken cue.
 */
function applyGaps(captions: FormattedCaption[], gap: number): FormattedCaption[] {
  if (captions.length === 0) return captions;

  const out: FormattedCaption[] = [];

  for (const caption of captions) {
    const prev = out[out.length - 1];

    if (!prev) {
      out.push({ ...caption, startTime: Math.max(0, caption.startTime) });
      continue;
    }

    const rawDuration = caption.endTime - caption.startTime;
    const effectiveGap = gap > 0 && caption.startTime >= prev.endTime && rawDuration > 0
      ? Math.min(gap, rawDuration * 0.25)
      : gap;
    const minStart = effectiveGap > 0 ? prev.endTime + effectiveGap : prev.endTime;
    const startTime = Math.max(caption.startTime, minStart);
    let endTime = caption.endTime;

    // If clamping would collapse or invert the cue, merge it into the previous one.
    if (!(endTime > startTime)) {
      prev.text = prev.text ? `${prev.text}\n${caption.text}` : caption.text;
      if (prev.words && caption.words) prev.words = [...prev.words, ...caption.words];
      else delete prev.words;
      if (endTime > prev.endTime) prev.endTime = endTime;
      continue;
    }

    out.push({ ...caption, startTime, endTime });
  }

  // Re-number sequentially in case any cues were merged away.
  out.forEach((caption, i) => { caption.index = i + 1; });
  return out;
}

/**
 * Dev-time sanity check: log any cue whose timing is non-monotonic. Runs after
 * applyGaps, which should make a violation impossible — this exists so a future
 * regression can't silently ship again.
 */
function validateCaptions(captions: FormattedCaption[]): void {
  let prevEnd = -1;
  for (const caption of captions) {
    if (!(caption.endTime > caption.startTime)) {
      console.warn(`[Captions] Invalid cue #${caption.index}: end ${caption.endTime} <= start ${caption.startTime}`);
    }
    if (caption.startTime < prevEnd) {
      console.warn(`[Captions] Non-monotonic cue #${caption.index}: start ${caption.startTime} < previous end ${prevEnd}`);
    }
    prevEnd = caption.endTime;
  }
}

/**
 * Split plain text into captions (fallback when no timestamps)
 */
function splitTextIntoCaptions(
  text: string,
  startTime: number,
  endTime: number,
  settings: CaptionSettings
): FormattedCaption[] {
  const maxCharsTotal = settings.maxCharsPerLine * settings.maxLines;
  const words = text.split(/\s+/);
  const captions: FormattedCaption[] = [];

  let currentText = '';
  let captionIndex = 1;
  const totalDuration = endTime - startTime;
  const charsPerSecond = text.length / totalDuration;

  for (const word of words) {
    const newText = currentText ? currentText + ' ' + word : word;

    if (wrapText(newText, settings.maxCharsPerLine).length > settings.maxLines && currentText) {
      // Calculate timing based on character position
      const charStart = text.indexOf(currentText);
      const charEnd = charStart + currentText.length;
      const captionStart = startTime + (charStart / text.length) * totalDuration;
      const captionEnd = startTime + (charEnd / text.length) * totalDuration;
      const minDur = Math.min(settings.minDurationSeconds, settings.maxDurationSeconds);

      captions.push({
        index: captionIndex++,
        startTime: captionStart,
        endTime: Math.max(captionEnd, captionStart + Math.min(minDur, 0.2)),
        text: formatTextWithLineBreaks(currentText, settings)
      });

      currentText = word;
    } else {
      currentText = newText;
    }
  }

  // Add last caption
  if (currentText) {
    const charStart = text.lastIndexOf(currentText);
    const captionStart = startTime + (charStart / text.length) * totalDuration;

    captions.push({
      index: captionIndex,
      startTime: captionStart,
      endTime: endTime,
      text: formatTextWithLineBreaks(currentText, settings)
    });
  }

  const gapped = applyGaps(captions, settings.gapBetweenCaptions);
  validateCaptions(gapped);
  return gapped;
}

/**
 * Convert captions to SRT format
 */
export function toSRT(captions: FormattedCaption[]): string {
  return captions.map(cap => {
    return `${cap.index}\n${formatSRTTime(cap.startTime)} --> ${formatSRTTime(cap.endTime)}\n${cap.text}\n`;
  }).join('\n');
}

/**
 * Format time for SRT (HH:MM:SS,mmm)
 */
function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

/**
 * Convert captions to VTT format
 */
export function toVTT(captions: FormattedCaption[]): string {
  const header = 'WEBVTT\n\n';
  const body = captions.map(cap => {
    return `${formatVTTTime(cap.startTime)} --> ${formatVTTTime(cap.endTime)}\n${cap.text}\n`;
  }).join('\n');

  return header + body;
}

/**
 * Format time for VTT (HH:MM:SS.mmm)
 */
function formatVTTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}
