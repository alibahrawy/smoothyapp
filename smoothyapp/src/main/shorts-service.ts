import { checkCancellation } from './captions/download-file';
import type { StudioCredits, StudioShort } from './web-api';

export interface ShortsAnalysisConfig {
  source?: 'sequence' | 'transcript' | 'audio' | 'youtube';
  shortsMode?: 'multiple' | 'best';
  trackIndices?: number[];
  subtitleText?: string;
  fileName?: string;
  audioPath?: string;
}

export interface ShortsTranscript {
  subtitleText: string;
  fileName: string;
  duration?: number;
}

interface ShortsDependencies {
  prepareAudio: (config: ShortsAnalysisConfig) => Promise<ShortsTranscript>;
  analyze: (text: string, duration: number | undefined, mode: 'multiple' | 'best', signal?: AbortSignal) => Promise<{ shorts: StudioShort[] }>;
  saveHistory: (text: string, fileName: string) => Promise<void>;
  getCredits: () => Promise<StudioCredits>;
  progress: (message: string) => void;
  signal?: AbortSignal;
}

/** One analysis flow for timeline audio, local files, and imported transcripts. */
export async function runShortsAnalysis(config: ShortsAnalysisConfig, deps: ShortsDependencies) {
  checkCancellation(deps.signal);
  const source = config.source || 'sequence';
  const mode = config.shortsMode || 'multiple';
  if (!['sequence', 'transcript', 'audio', 'youtube'].includes(source)) {
    throw new Error('Choose a supported Shorts source.');
  }
  if (mode !== 'multiple' && mode !== 'best') {
    throw new Error('Choose Multiple or Best Part.');
  }

  const input: ShortsTranscript = source === 'sequence' || source === 'audio'
    ? await deps.prepareAudio({ ...config, source })
    : { subtitleText: config.subtitleText || '', fileName: config.fileName || 'Transcript' };
  if (typeof input.subtitleText !== 'string' || !input.subtitleText.trim()) {
    throw new Error('No transcript found. Add a transcript or audio with speech.');
  }
  if (input.subtitleText.length > 2_000_000) {
    throw new Error('The transcript is too long (maximum 2,000,000 characters).');
  }

  checkCancellation(deps.signal);
  deps.progress(mode === 'best' ? 'Finding the single best part…' : 'Finding multiple shorts…');
  const { shorts } = await (deps.signal ? deps.analyze(input.subtitleText, input.duration, mode, deps.signal) : deps.analyze(input.subtitleText, input.duration, mode));
  checkCancellation(deps.signal);
  if (!Array.isArray(shorts) || shorts.length === 0) {
    throw new Error('No shorts found in this source.');
  }

  // Keep useful results available if saving history temporarily fails.
  let warning: string | undefined;
  deps.progress('Saving to history…');
  try {
    await deps.saveHistory(JSON.stringify({ shorts }, null, 2), input.fileName);
  } catch {
    warning = 'Your results are ready, but could not be saved to history.';
  }
  let credits: StudioCredits | null = null;
  try { credits = await deps.getCredits(); } catch { /* Results remain usable. */ }
  return { shorts, credits, warning, fileName: input.fileName, duration: input.duration, ...(warning ? { historyRetry: { text: JSON.stringify({ shorts }, null, 2), fileName: input.fileName } } : {}) };
}
