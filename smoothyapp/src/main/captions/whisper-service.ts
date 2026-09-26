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

  const { promise } = whisperContext.transcribeFile(audioPath, {
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

  const result = await promise;

  if (!result || !result.segments) {
    console.log(`[Whisper] No segments returned`);
    return { text: '', chunks: [], language: 'en' };
  }

  // Split each segment into individual words with interpolated timestamps.
  // With maxLen:50, segments are short phrases (~8-10 words, ~3-4 seconds).
  // Segment boundaries are accurate (whisper.cpp token-level analysis),
  // so interpolation error within each segment stays small and can't accumulate.
  const chunks: TranscriptionChunk[] = [];

  for (const seg of result.segments) {
    if (!seg.text || !seg.text.trim()) continue;

    const segText = seg.text.trim();
    const words = segText.split(/\s+/).filter((w: string) => w.length > 0);
    if (words.length === 0) continue;

    const segStart = seg.t0 / 1000;
    const segEnd = seg.t1 / 1000;
    const segDuration = segEnd - segStart;

    if (words.length === 1) {
      chunks.push({
        text: words[0],
        timestamp: [segStart, segEnd]
      });
      continue;
    }

    // Distribute time proportionally by character length
    const totalChars = words.reduce((sum: number, w: string) => sum + w.length, 0);
    let charOffset = 0;

    for (const word of words) {
      const wordStart = segStart + (charOffset / totalChars) * segDuration;
      charOffset += word.length;
      const wordEnd = segStart + (charOffset / totalChars) * segDuration;

      chunks.push({
        text: word,
        timestamp: [
          Math.round(wordStart * 100) / 100,
          Math.round(wordEnd * 100) / 100
        ]
      });
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
 * Unload the current model to free memory
 */
export async function unloadModel(): Promise<void> {
  if (whisperContext) {
    await whisperContext.release();
    whisperContext = null;
    currentModelId = null;
    console.log('[Whisper] Model unloaded');
  }
}
