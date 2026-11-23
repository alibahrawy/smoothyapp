/**
 * Smoothy Pro animated captions (Premiere only).
 *
 * Turns formatted captions into the payload for the CEP host function
 * `smoothyImportProCaptions`, which places one Motion Graphics Template clip
 * per caption. Templates read "Word Timings" as "start,end;start,end;…" in
 * seconds from the clip start, one pair per space/newline-separated word.
 *
 * Templates (smoothyapp-cep/mogrt/, built by scripts/pro-captions/build-mogrt.mjs):
 *   box-highlight  "Smoothy Box Highlight": one line on a rounded colour box;
 *                  upcoming words are dimmed and light up as they are spoken.
 *                  Spec: docs/caption-pro/box-highlight. Default colours are
 *                  Smoothy Lime (#92F388) with Ink (#151515) text.
 * More styles are added as new templates with the same contract.
 */
import type { FormattedCaption } from './caption-formatter';

export type ProCaptionTemplate = 'box-highlight';
export const PRO_CAPTION_TEMPLATES: ProCaptionTemplate[] = ['box-highlight'];

export interface ProCaptionStyle {
  template: ProCaptionTemplate;
  textColor: string;       // #rrggbb
  size: number;            // percent, 25–300
  verticalPosition: number; // percent of frame height, 0–100
  upcomingOpacity: number; // percent, 0–100: words not spoken yet
  boxColor: string;        // #rrggbb
  boxOpacity: number;      // percent, 0–100
  boxRadius: number;       // px at 1080p, 0–60
  boxPadding: number;      // px at 1080p, 0–80
  boxHeight: number;       // px at 1080p, 40–240
  shadowOpacity: number;   // percent, 0–100 (0 = no shadow)
  popIn: boolean;          // box pops in when a line follows a pause
}

export interface ProCaptionClip {
  start: number;
  end: number;
  text: string;
  timings: string;
  /** Pop the box in (the line follows a gap); otherwise it swaps in. */
  popIn: boolean;
}

type Rgb = [number, number, number];
export interface ProCaptionPayload {
  template: ProCaptionTemplate;
  captions: ProCaptionClip[];
  style: {
    textColor: Rgb;
    size: number;
    verticalPosition: number;
    upcomingOpacity: number;
    boxColor: Rgb;
    boxOpacity: number;
    boxRadius: number;
    boxPadding: number;
    boxHeight: number;
    shadowOpacity: number;
  };
}

/** Defaults per template; box-highlight matches docs/caption-pro/box-highlight/presets/box-highlight.json. */
const TEMPLATE_DEFAULTS: Record<ProCaptionTemplate, ProCaptionStyle> = {
  'box-highlight': {
    template: 'box-highlight',
    textColor: '#151515',
    size: 100,
    verticalPosition: 93.1,
    upcomingOpacity: 42,
    boxColor: '#92f388',
    boxOpacity: 100,
    boxRadius: 7,
    boxPadding: 20,
    boxHeight: 95,
    shadowOpacity: 0,
    popIn: true,
  },
};

export const DEFAULT_PRO_CAPTION_STYLE: ProCaptionStyle = TEMPLATE_DEFAULTS['box-highlight'];

export function defaultProCaptionStyle(template: ProCaptionTemplate = 'box-highlight'): ProCaptionStyle {
  return { ...TEMPLATE_DEFAULTS[template] };
}

export function proCaptionTemplateOf(style: Partial<ProCaptionStyle> = {}): ProCaptionTemplate {
  return PRO_CAPTION_TEMPLATES.includes(style.template as ProCaptionTemplate) ? style.template as ProCaptionTemplate : 'box-highlight';
}

/** A line pops in when more than one frame (30 fps) passes since the previous line ended. */
const POP_GAP_SECONDS = 1 / 30 + 0.001;

/** Hard cap so one request cannot freeze Premiere for an unbounded time. */
export const MAX_PRO_CAPTIONS = 2000;

const round = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
};

function hexToRgb(value: unknown, fallback: string): [number, number, number] {
  const hex = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

export function normalizeProCaptionStyle(style: Partial<ProCaptionStyle> = {}): ProCaptionPayload['style'] {
  const d = TEMPLATE_DEFAULTS[proCaptionTemplateOf(style)];
  return {
    textColor: hexToRgb(style.textColor, d.textColor),
    size: clamp(style.size, 25, 300, d.size),
    verticalPosition: clamp(style.verticalPosition, 0, 100, d.verticalPosition),
    upcomingOpacity: clamp(style.upcomingOpacity, 0, 100, d.upcomingOpacity),
    boxColor: hexToRgb(style.boxColor, d.boxColor),
    boxOpacity: clamp(style.boxOpacity, 0, 100, d.boxOpacity),
    boxRadius: clamp(style.boxRadius, 0, 60, d.boxRadius),
    boxPadding: clamp(style.boxPadding, 0, 80, d.boxPadding),
    boxHeight: clamp(style.boxHeight, 40, 240, d.boxHeight),
    shadowOpacity: clamp(style.shadowOpacity, 0, 100, d.shadowOpacity),
  };
}

/** Words as After Effects counts them for a text selector "Based on: Words". */
export function splitCaptionWords(text: string): string[] {
  return String(text).split(/\s+/).filter(Boolean);
}

/**
 * Per-word [start, end] pairs relative to the caption start. Uses the
 * transcription's word timings when they still match the (possibly edited)
 * text word for word; otherwise spreads the words over the caption by length.
 * Each word stays highlighted until the next one starts, so there is no
 * flicker in pauses between words.
 */
export function wordTimingsFor(caption: FormattedCaption): Array<[number, number]> {
  const words = splitCaptionWords(caption.text);
  const duration = Math.max(0, caption.endTime - caption.startTime);
  if (!words.length || duration <= 0) return [];

  let starts: number[];
  const source = caption.words ?? [];
  if (source.length === words.length) {
    starts = source.map(word => word.start - caption.startTime);
  } else {
    const weights = words.map(word => Array.from(word).length + 1);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let offset = 0;
    starts = weights.map(weight => { const start = offset / total * duration; offset += weight; return start; });
  }

  const clamped = starts.map(start => Math.min(duration, Math.max(0, start)));
  // Keep starts non-decreasing even if the transcription reports overlaps.
  for (let i = 1; i < clamped.length; i++) clamped[i] = Math.max(clamped[i], clamped[i - 1]);
  return clamped.map((start, i) => [round(start), round(i + 1 < clamped.length ? clamped[i + 1] : duration)]);
}

export function buildProCaptionPayload(captions: FormattedCaption[], style: Partial<ProCaptionStyle> = {}): ProCaptionPayload {
  if (!Array.isArray(captions)) throw new Error('No captions to place.');
  const template = proCaptionTemplateOf(style);
  const popInEnabled = style.popIn ?? TEMPLATE_DEFAULTS[template].popIn;
  const clips: ProCaptionClip[] = [];
  let previousEnd = -Infinity;
  for (const caption of captions) {
    const start = Number(caption?.startTime), end = Number(caption?.endTime);
    const text = String(caption?.text ?? '').trim();
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) continue;
    const timings = wordTimingsFor({ ...caption, text, startTime: start, endTime: end });
    clips.push({
      start: round(start), end: round(end), text, timings: timings.map(pair => pair.join(',')).join(';'),
      popIn: popInEnabled !== false && start - previousEnd > POP_GAP_SECONDS,
    });
    previousEnd = end;
  }
  if (!clips.length) throw new Error('No captions to place.');
  if (clips.length > MAX_PRO_CAPTIONS) throw new Error(`Pro captions support up to ${MAX_PRO_CAPTIONS} captions per send. Split the sequence and try again.`);
  return { template, captions: clips, style: normalizeProCaptionStyle(style) };
}
