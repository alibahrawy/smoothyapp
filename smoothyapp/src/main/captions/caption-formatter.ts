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

export interface FormattedCaption {
  index: number;
  startTime: number;
  endTime: number;
  text: string;
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
    if (characters.length <= maxCharsTotal) return [chunk];
    const parts: TranscriptionChunk[] = [];
    for (let offset = 0; offset < characters.length; offset += maxCharsTotal) {
      const end = Math.min(characters.length, offset + maxCharsTotal);
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
    const newLength = newText.length;

    const firstWordTime = currentCaption.words[0]?.timestamp[0] ?? chunk.timestamp[0];
    const newDuration = chunk.timestamp[1] - firstWordTime;

    // Conditions to start a new caption
    const exceedsLength = newLength > maxCharsTotal || wrapText(newText, opts.maxCharsPerLine).length > opts.maxLines;
    const exceedsDuration = newDuration > opts.maxDurationSeconds;
    const isEndOfSentence = /[.!?]$/.test(currentCaption.text) && currentCaption.words.length > 0;

    if ((exceedsLength || exceedsDuration || isEndOfSentence) && currentCaption.words.length > 0) {
      // Finalize current caption
      const caption = finalizeCaption(currentCaption, captionIndex, opts, captions[captions.length - 1]);
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
  previous?: FormattedCaption
): FormattedCaption | null {
  if (caption.words.length === 0) return null;

  const prevEnd = previous ? previous.endTime : 0;

  let startTime = caption.words[0].timestamp[0];
  if (!(startTime >= prevEnd)) {
    startTime = prevEnd;
  }

  let endTime = caption.words[caption.words.length - 1].timestamp[1];

  // Ensure minimum duration (measured from the clamped start).
  if (endTime - startTime < settings.minDurationSeconds) {
    endTime = startTime + settings.minDurationSeconds;
  }

  // Never emit a backwards or zero-length cue.
  if (!(endTime > startTime)) {
    endTime = startTime + settings.minDurationSeconds;
  }

  // Format text with line breaks if needed
  const formattedText = formatTextWithLineBreaks(caption.text, settings);

  return {
    index,
    startTime,
    endTime,
    text: formattedText
  };
}

/**
 * Format text with line breaks based on settings
 */
function wrapText(text: string, limit: number): string[] {
  const lines: string[] = [];
  let remaining = Array.from(text.trim());
  while (remaining.length > limit) {
    let split = limit;
    for (let index = limit; index > 0; index--) {
      if (/\s/.test(remaining[index])) { split = index; break; }
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

    const minStart = gap > 0 ? prev.endTime + gap : prev.endTime;
    const startTime = Math.max(caption.startTime, minStart);
    let endTime = caption.endTime;

    // If clamping would collapse or invert the cue, merge it into the previous one.
    if (!(endTime > startTime)) {
      prev.text = prev.text ? `${prev.text}\n${caption.text}` : caption.text;
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

    if (newText.length > maxCharsTotal && currentText) {
      // Calculate timing based on character position
      const charStart = text.indexOf(currentText);
      const charEnd = charStart + currentText.length;
      const captionStart = startTime + (charStart / text.length) * totalDuration;
      const captionEnd = startTime + (charEnd / text.length) * totalDuration;

      captions.push({
        index: captionIndex++,
        startTime: captionStart,
        endTime: Math.max(captionEnd, captionStart + settings.minDurationSeconds),
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
