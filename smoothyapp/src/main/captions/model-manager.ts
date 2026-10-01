/**
 * Model Manager - Handles GGML Whisper model download and storage
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { downloadFile, checkCancellation } from './download-file';

export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  speed: string;
  downloaded: boolean;
  filePath?: string;
}

// Available GGML Whisper models. The `.en` files are English-only; the plain
// files are multilingual and required for every other language.
const AVAILABLE_MODELS: Omit<ModelInfo, 'downloaded' | 'filePath'>[] = [
  {
    id: 'ggml-tiny.en.bin',
    name: 'Tiny (English)',
    size: '75 MB',
    sizeBytes: 75_000_000,
    speed: 'Fastest — lowest accuracy'
  },
  {
    id: 'ggml-tiny.bin',
    name: 'Tiny (multilingual)',
    size: '75 MB',
    sizeBytes: 75_000_000,
    speed: 'Fastest — any language'
  },
  {
    id: 'ggml-base.en.bin',
    name: 'Base (English)',
    size: '142 MB',
    sizeBytes: 142_000_000,
    speed: 'Fast — good for most videos'
  },
  {
    id: 'ggml-base.bin',
    name: 'Base (multilingual)',
    size: '142 MB',
    sizeBytes: 142_000_000,
    speed: 'Fast — any language'
  },
  {
    id: 'ggml-small.en.bin',
    name: 'Small (English)',
    size: '466 MB',
    sizeBytes: 466_000_000,
    speed: 'Balanced — better accuracy'
  },
  {
    id: 'ggml-small.bin',
    name: 'Small (multilingual)',
    size: '466 MB',
    sizeBytes: 466_000_000,
    speed: 'Balanced — any language'
  },
  {
    id: 'ggml-medium.en.bin',
    name: 'Medium (English)',
    size: '1.5 GB',
    sizeBytes: 1_500_000_000,
    speed: 'Accurate — slower'
  },
  {
    id: 'ggml-medium.bin',
    name: 'Medium (multilingual)',
    size: '1.5 GB',
    sizeBytes: 1_500_000_000,
    speed: 'Accurate — any language'
  },
  {
    id: 'ggml-large-v3-turbo.bin',
    name: 'Large v3 Turbo (multilingual)',
    size: '1.6 GB',
    sizeBytes: 1_600_000_000,
    speed: 'Most accurate — detects any language'
  }
];

const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const VAD_MODEL_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin';
const VAD_MODEL_FILENAME = 'ggml-silero-v6.2.0.bin';

/**
 * Get the models directory path
 */
export function getModelsDir(): string {
  const modelsDir = path.join(app.getPath('userData'), 'whisper-models');
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  return modelsDir;
}

/**
 * Get the full path for a model file
 */
export function getModelFilePath(modelId: string): string {
  return path.join(getModelsDir(), modelId);
}

/**
 * Get the full path for the VAD model
 */
export function getVadModelPath(): string {
  return path.join(getModelsDir(), VAD_MODEL_FILENAME);
}

/**
 * Check if a model file is downloaded
 */
function isModelDownloaded(modelId: string): boolean {
  const filePath = getModelFilePath(modelId);
  return fs.existsSync(filePath);
}

/**
 * Check if the VAD model is downloaded
 */
export function isVadModelDownloaded(): boolean {
  return fs.existsSync(getVadModelPath());
}

/**
 * Get list of available models with download status
 */
export function getAvailableModels(): ModelInfo[] {
  return AVAILABLE_MODELS.map(model => ({
    ...model,
    downloaded: isModelDownloaded(model.id),
    filePath: isModelDownloaded(model.id) ? getModelFilePath(model.id) : undefined
  }));
}

/**
 * Get model info by ID
 */
export function getModelById(modelId: string): ModelInfo | undefined {
  const models = getAvailableModels();
  return models.find(m => m.id === modelId);
}

/**
 * Get the default model ID
 */
export function getDefaultModelId(): string {
  return 'ggml-base.bin';
}

/**
 * English-only GGML models end in `.en.bin` and cannot transcribe any other
 * language, regardless of the `-l` value passed to whisper.cpp.
 */
export function isEnglishOnlyModel(modelId: string): boolean {
  return /\.en\.bin$/i.test(modelId);
}

export type DownloadProgressCallback = (progress: {
  status: string;
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
}) => void;

/**
 * Download a file from a URL with progress callback, following redirects
 */
/**
 * Download a Whisper model if not already present
 */
export async function ensureModelDownloaded(
  modelId: string,
  onProgress?: DownloadProgressCallback,
  signal?: AbortSignal
): Promise<string> {
  checkCancellation(signal);
  const filePath = getModelFilePath(modelId);

  if (fs.existsSync(filePath)) {
    console.log(`[ModelManager] Model ${modelId} already downloaded at ${filePath}`);
    return filePath;
  }

  console.log(`[ModelManager] Downloading model ${modelId}...`);
  const url = WHISPER_MODEL_BASE_URL + modelId;
  await downloadFile(url, filePath, onProgress, modelId, signal);
  console.log(`[ModelManager] Model ${modelId} downloaded to ${filePath}`);
  return filePath;
}

/**
 * Download the VAD model if not already present
 */
export async function ensureVadModelDownloaded(
  onProgress?: DownloadProgressCallback,
  signal?: AbortSignal
): Promise<string> {
  checkCancellation(signal);
  const filePath = getVadModelPath();

  if (fs.existsSync(filePath)) {
    console.log(`[ModelManager] VAD model already downloaded at ${filePath}`);
    return filePath;
  }

  console.log(`[ModelManager] Downloading VAD model...`);
  await downloadFile(VAD_MODEL_URL, filePath, onProgress, 'VAD model', signal);
  console.log(`[ModelManager] VAD model downloaded to ${filePath}`);
  return filePath;
}
