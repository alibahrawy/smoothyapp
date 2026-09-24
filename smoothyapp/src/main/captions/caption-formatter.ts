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

  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    const wordText = chunk.text.trim();

    if (!wordText) continue;

    // Check if adding this word would exceed limits
    const newText = currentCaption.text ? currentCaption.text + ' ' + wordText : wordText;
    const newLength = newText.length;

    const firstWordTime = currentCaption.words[0]?.timestamp[0] || chunk.timestamp[0];
    const newDuration = chunk.timestamp[1] - firstWordTime;

    // Conditions to start a new caption
    const exceedsLength = newLength > maxCharsTotal;
    const exceedsDuration = newDuration > opts.maxDurationSeconds;
    const isEndOfSentence = /[.!?]$/.test(currentCaption.text) && currentCaption.words.length > 0;

    if ((exceedsLength || exceedsDuration || isEndOfSentence) && currentCaption.words.length > 0) {
      // Finalize current caption
      const caption = finalizeCaption(currentCaption, captionIndex, opts);
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
    const caption = finalizeCaption(currentCaption, captionIndex, opts);
    if (caption) {
      captions.push(caption);
    }
  }

  // Apply gap between captions
  return applyGaps(captions, opts.gapBetweenCaptions);
}

/**
 * Finalize a caption from collected words
 */
function finalizeCaption(
  caption: { words: TranscriptionChunk[]; text: string },
  index: number,
  settings: CaptionSettings
): FormattedCaption | null {
  if (caption.words.length === 0) return null;

  const startTime = caption.words[0].timestamp[0];
  let endTime = caption.words[caption.words.length - 1].timestamp[1];

  // Ensure minimum duration
  if (endTime - startTime < settings.minDurationSeconds) {
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
function formatTextWithLineBreaks(text: string, settings: CaptionSettings): string {
  if (settings.maxLines === 1 || text.length <= settings.maxCharsPerLine) {
    return text;
  }

  // Split into two lines at a natural break point
  const words = text.split(' ');
  let line1 = '';
  let line2 = '';

  for (const word of words) {
    if (line1.length + word.length + 1 <= settings.maxCharsPerLine) {
      line1 = line1 ? line1 + ' ' + word : word;
    } else {
      line2 = line2 ? line2 + ' ' + word : word;
    }
  }

  // If line2 is too long, truncate
  if (line2.length > settings.maxCharsPerLine) {
    line2 = line2.substring(0, settings.maxCharsPerLine - 3) + '...';
  }

  return line2 ? line1 + '\n' + line2 : line1;
}

/**
 * Apply gaps between captions
 */
function applyGaps(captions: FormattedCaption[], gap: number): FormattedCaption[] {
  if (gap <= 0) return captions;

  return captions.map((caption, i) => {
    if (i === 0) return caption;

    const prevEnd = captions[i - 1].endTime;
    const currentStart = caption.startTime;

    // If captions overlap or are too close, adjust
    if (currentStart < prevEnd + gap) {
      return {
        ...caption,
        startTime: prevEnd + gap
      };
    }

    return caption;
  });
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

  return applyGaps(captions, settings.gapBetweenCaptions);
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
