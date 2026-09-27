/**
 * Model Manager - Handles GGML Whisper model download and storage
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';

export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  speed: string;
  downloaded: boolean;
  filePath?: string;
}

// Available GGML Whisper models
const AVAILABLE_MODELS: Omit<ModelInfo, 'downloaded' | 'filePath'>[] = [
  {
    id: 'ggml-tiny.en.bin',
    name: 'Tiny (English)',
    size: '75 MB',
    sizeBytes: 75_000_000,
    speed: 'Fastest — lowest accuracy'
  },
  {
    id: 'ggml-base.en.bin',
    name: 'Base (English)',
    size: '142 MB',
    sizeBytes: 142_000_000,
    speed: 'Fast — good for most videos'
  },
  {
    id: 'ggml-small.en.bin',
    name: 'Small (English)',
    size: '466 MB',
    sizeBytes: 466_000_000,
    speed: 'Balanced — better accuracy'
  },
  {
    id: 'ggml-medium.en.bin',
    name: 'Medium (English)',
    size: '1.5 GB',
    sizeBytes: 1_500_000_000,
    speed: 'Accurate — slower'
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
  return 'ggml-base.en.bin';
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
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: DownloadProgressCallback,
  label?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempPath = destPath + '.tmp';
    const file = fs.createWriteStream(tempPath);

    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        file.close();
        fs.unlinkSync(tempPath);
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = requestUrl.startsWith('https') ? https : http;

      protocol.get(requestUrl, (response) => {
        // Handle redirects
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume(); // Consume response to free memory
          doRequest(response.headers.location, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(tempPath);
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;

        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          if (onProgress && totalSize > 0) {
            onProgress({
              status: 'downloading',
              progress: Math.round((downloadedSize / totalSize) * 100),
              file: label || path.basename(destPath),
              loaded: downloadedSize,
              total: totalSize
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            // Rename temp file to final path
            fs.renameSync(tempPath, destPath);
            resolve();
          });
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        reject(err);
      });
    };

    file.on('error', (err) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      reject(err);
    });

    doRequest(url, 0);
  });
}

/**
 * Download a Whisper model if not already present
 */
export async function ensureModelDownloaded(
  modelId: string,
  onProgress?: DownloadProgressCallback
): Promise<string> {
  const filePath = getModelFilePath(modelId);

  if (fs.existsSync(filePath)) {
    console.log(`[ModelManager] Model ${modelId} already downloaded at ${filePath}`);
    return filePath;
  }

  console.log(`[ModelManager] Downloading model ${modelId}...`);
  const url = WHISPER_MODEL_BASE_URL + modelId;
  await downloadFile(url, filePath, onProgress, modelId);
  console.log(`[ModelManager] Model ${modelId} downloaded to ${filePath}`);
  return filePath;
}

/**
 * Download the VAD model if not already present
 */
export async function ensureVadModelDownloaded(
  onProgress?: DownloadProgressCallback
): Promise<string> {
  const filePath = getVadModelPath();

  if (fs.existsSync(filePath)) {
    console.log(`[ModelManager] VAD model already downloaded at ${filePath}`);
    return filePath;
  }

  console.log(`[ModelManager] Downloading VAD model...`);
  await downloadFile(VAD_MODEL_URL, filePath, onProgress, 'VAD model');
  console.log(`[ModelManager] VAD model downloaded to ${filePath}`);
  return filePath;
}
