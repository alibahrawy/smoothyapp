/**
 * Whisper Service - Handles transcription using @fugood/whisper.node (whisper.cpp native binding)
 *
 * Uses Metal GPU on macOS for 10-40x faster transcription than ONNX CPU.
 * Natural segments from whisper.cpp (accurate boundaries), then words are
 * interpolated proportionally within each segment for the caption formatter.
 */

import { initWhisper, LibVariant } from '@fugood/whisper.node';
import { execFileSync } from 'child_process';
import os from 'os';
import {
  ensureModelDownloaded
} from './model-manager';

let whisperContext: any = null;
let currentModelId: string | null = null;
let activeBackend: 'metal' | 'cuda' | 'vulkan' | 'cpu' = 'cpu';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function hasNvidiaGpu(): boolean {
  if (!isWindows && process.platform !== 'linux') return false;
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the best available whisper.cpp backend once per process. The native
 * module is cached globally, so changing backends requires an app restart.
 */
function resolveBackends(): { variants: (LibVariant | undefined)[]; labels: string[] } {
  if (isMac) {
    // macOS arm64 default package ships Metal.
    return { variants: [undefined], labels: ['metal'] };
  }
  if (hasNvidiaGpu()) {
    return { variants: ['cuda', undefined], labels: ['cuda', 'vulkan'] };
  }
  return { variants: ['vulkan'], labels: ['vulkan'] };
}

export function getActiveBackend(): string {
  return activeBackend;
}

export interface TranscriptionChunk {
  text: string;
  timestamp: [number, number]; // [start, end] in seconds
}

export interface TranscriptionResult {
  text: string;
  chunks: TranscriptionChunk[];
  language: string;
}

export type ProgressCallback = (progress: {
  status: string;
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
}) => void;

// Handle for the in-flight transcription job, so it can be cancelled.
let activeTranscribe: { stop: () => Promise<void> } | null = null;

/**
 * Load or get the Whisper model using whisper.cpp native binding
 */
export async function loadModel(
  modelId: string,
  onProgress?: ProgressCallback
): Promise<void> {
  // If same model already loaded, skip
  if (whisperContext && currentModelId === modelId) {
    console.log(`[Whisper] Model ${modelId} already loaded`);
    return;
  }

  // Unload previous model
  if (whisperContext) {
    await whisperContext.release();
    whisperContext = null;
    currentModelId = null;
  }

  console.log(`[Whisper] Loading model: ${modelId}`);

  // Ensure model is downloaded
  const modelPath = await ensureModelDownloaded(modelId, onProgress);

  if (onProgress) {
    onProgress({ status: 'initializing', progress: 95 });
  }

  // Initialize whisper.cpp context, preferring the best GPU backend for this
  // machine (Metal on macOS, CUDA on NVIDIA, Vulkan otherwise). Falls back to
  // CPU when no GPU backend can be initialized.
  const { variants, labels } = resolveBackends();
  const errors: string[] = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const label = labels[i];
    try {
      whisperContext = await initWhisper(
        { filePath: modelPath, useGpu: true },
        variant
      );
      activeBackend = label as typeof activeBackend;
      console.log(`[Whisper] Model loaded successfully using ${activeBackend} backend`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}: ${message}`);
      console.warn(`[Whisper] Failed to initialize ${label} backend:`, message);
      whisperContext = null;
    }
  }

  if (!whisperContext) {
    console.warn(`[Whisper] No GPU backend available (${errors.join(' | ')}). Falling back to CPU.`);
    whisperContext = await initWhisper({ filePath: modelPath, useGpu: false });
    activeBackend = 'cpu';
    console.log('[Whisper] Model loaded successfully using CPU backend');
  }

  currentModelId = modelId;

  if (onProgress) {
    onProgress({ status: 'ready', progress: 100 });
  }
}

/**
 * Check if a model is currently loaded
 */
export function isModelLoaded(): boolean {
  return whisperContext !== null;
}

/**
 * Get the currently loaded model ID
 */
export function getCurrentModelId(): string | null {
  return currentModelId;
}

/**
 * Transcribe a single combined WAV file and return word-level chunks.
 * Uses tokenTimestamps + maxLen:50 for short phrase-level segments (~8-10 words)
 * with accurate whisper.cpp boundaries. Words within each segment get
 * proportionally interpolated timestamps. Short segments keep interpolation
 * error small and prevent cumulative drift.
 */
export async function transcribe(
  audioPath: string,
  onProgress?: ProgressCallback
): Promise<TranscriptionResult> {
  if (!whisperContext) {
    throw new Error('No model loaded. Call loadModel() first.');
  }

  console.log(`[Whisper] Transcribing: ${audioPath}`);

  const cpuThreads = Math.max(4, Math.min(os.cpus().length, 16));
  const maxThreads = activeBackend === 'cpu' ? cpuThreads : 4;

  const { promise, stop } = whisperContext.transcribeFile(audioPath, {
    language: 'en',
    tokenTimestamps: true,
    maxLen: 50,
    temperature: 0.0,
    maxThreads,
    onProgress: (progress: number) => {
      if (onProgress) {
        onProgress({
          status: `Transcribing — ${progress}%`,
          progress: Math.min(95, Math.round(progress * 0.95))
        });
      }
    }
  });

  activeTranscribe = { stop };

  let result: any;
  try {
    result = await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('cancel')) {
      console.log('[Whisper] Transcription cancelled by user');
      throw new Error('TRANSCRIPTION_CANCELLED');
    }
    throw err;
  } finally {
    activeTranscribe = null;
  }

  if (!result || !result.segments) {
    console.log(`[Whisper] No segments returned`);
    return { text: '', chunks: [], language: 'en' };
  }

  // Split each segment into individual words with interpolated timestamps.
  // With maxLen:50, segments are short phrases (~8-10 words, ~3-4 seconds).
  // Segment boundaries are accurate (whisper.cpp token-level analysis),
  // so interpolation error within each segment stays small and can't accumulate.
  //
  // whisper.cpp occasionally returns a segment whose t1 <= t0 (or t0 before the
  // previous segment's end). Left unchecked, that produces a word whose end time
  // is before its start, which corrupts the SRT downstream. We drop degenerate
  // segments and force every emitted word to be strictly non-decreasing.
  const chunks: TranscriptionChunk[] = [];
  let minStart = 0;

  for (const seg of result.segments) {
    if (!seg.text || !seg.text.trim()) continue;

    const segText = seg.text.trim();
    const words = segText.split(/\s+/).filter((w: string) => w.length > 0);
    if (words.length === 0) continue;

    let segStart = seg.t0 / 1000;
    let segEnd = seg.t1 / 1000;

    // Drop zero/negative-length segments outright.
    if (!(segEnd > segStart)) {
      console.warn(`[Whisper] Skipping degenerate segment (t0=${seg.t0}, t1=${seg.t1}): "${segText.slice(0, 40)}"`);
      continue;
    }

    // Never let a segment start before the previous segment finished.
    if (segStart < minStart) segStart = minStart;
    if (segEnd <= segStart) segEnd = segStart + 0.01;
    const segDuration = segEnd - segStart;

    if (words.length === 1) {
      chunks.push({
        text: words[0],
        timestamp: [round2(segStart), round2(segEnd)]
      });
      minStart = round2(segEnd);
      continue;
    }

    // Distribute time proportionally by character length
    const totalChars = words.reduce((sum: number, w: string) => sum + w.length, 0);
    let charOffset = 0;

    for (const word of words) {
      let wordStart = segStart + (charOffset / totalChars) * segDuration;
      charOffset += word.length;
      let wordEnd = segStart + (charOffset / totalChars) * segDuration;

      // Enforce monotonic, non-zero-length word spans.
      if (wordStart < minStart) wordStart = minStart;
      if (wordEnd <= wordStart) wordEnd = wordStart + 0.01;

      wordStart = round2(wordStart);
      wordEnd = round2(wordEnd);
      if (wordEnd <= wordStart) wordEnd = round2(wordStart + 0.01);

      chunks.push({
        text: word,
        timestamp: [wordStart, wordEnd]
      });
      minStart = wordEnd;
    }
  }

  const text = result.result || chunks.map((c: TranscriptionChunk) => c.text).join(' ');

  if (onProgress) {
    onProgress({ status: 'complete', progress: 100 });
  }

  console.log(`[Whisper] Transcription complete — ${result.segments.length} segments → ${chunks.length} words, ${text.length} chars`);

  return {
    text,
    chunks,
    language: 'en'
  };
}

/**
 * Cancel the in-flight transcription, if any. The underlying job rejects with
 * "Transcription cancelled", which transcribe() maps to TRANSCRIPTION_CANCELLED.
 */
export async function cancelTranscription(): Promise<void> {
  if (activeTranscribe) {
    console.log('[Whisper] Cancelling transcription...');
    try {
      await activeTranscribe.stop();
    } catch (err) {
      console.warn('[Whisper] Error while cancelling:', err);
    }
    activeTranscribe = null;
  }
}

export function isTranscribing(): boolean {
  return activeTranscribe !== null;
}

/**
 * Unload the current model to free memory
 */
export async function unloadModel(): Promise<void> {  if (whisperContext) {
    await whisperContext.release();
    whisperContext = null;
    currentModelId = null;
    console.log('[Whisper] Model unloaded');
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
