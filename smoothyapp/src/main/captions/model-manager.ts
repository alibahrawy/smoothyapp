/**
 * Model Manager - Handles GGML Whisper model download and storage
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { downloadFile, checkCancellation } from './download-file';
import { MOULSOT_MODEL_ID, DARIJA_WHISPER_MODEL_ID } from './languages';

export type ModelEngine = 'whisper' | 'moulsot';

export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  speed: string;
  downloaded: boolean;
  filePath?: string;
  engine?: ModelEngine;
  custom?: boolean;
  englishOnly?: boolean;
  /** Language this model was specifically fine-tuned for. */
  specialistLanguage?: 'ary';
}

// Available local models. Whisper `.en` files are English-only; the plain
// files are multilingual. MoulSot is a separate llama.cpp Darija engine.
const AVAILABLE_MODELS: Omit<ModelInfo, 'downloaded' | 'filePath'>[] = [
  {
    id: MOULSOT_MODEL_ID,
    name: 'MoulSot v0.3 (Moroccan Darija)',
    size: '1.6 GB',
    sizeBytes: 1_613_586_464,
    speed: 'Recommended for Darija — local',
    engine: 'moulsot',
    specialistLanguage: 'ary'
  },
  {
    id: DARIJA_WHISPER_MODEL_ID,
    name: 'Whisper Small Darija (DoRA)',
    size: '488 MB',
    sizeBytes: 487_601_984,
    speed: 'Compact Darija fine-tune — local',
    engine: 'whisper',
    specialistLanguage: 'ary'
  },
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
    speed: 'Fast — lower accuracy for non-English speech'
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
// Author-published merged DoRA weights in whisper.cpp format, pinned to a
// specific revision. This is a Darija fine-tune, not the generic Small model.
const DARIJA_WHISPER_URL = 'https://huggingface.co/ehyoussef/whisper-small-darija-ext/resolve/82308efe18186f28fde594a8dd66e50d23cdd0bf/ggml/ggml-model.bin';
const DARIJA_WHISPER_SHA256 = '5e3f5482426311edcc522108c10b31f0075ec610312c105151f0a1aba933c0d0';
const VAD_MODEL_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin';
const VAD_MODEL_FILENAME = 'ggml-silero-v6.2.0.bin';

// MoulSot v0.3 (Qwen3-ASR fine-tuned for Moroccan Darija) for llama.cpp.
const MOULSOT_MODEL_BASE_URL = 'https://huggingface.co/mradermacher/moulsot.v0.3-GGUF/resolve/main/';
export const MOULSOT_MAIN_FILENAME = 'moulsot.v0.3.Q5_K_M.gguf';
export const MOULSOT_MMPROJ_FILENAME = 'moulsot.v0.3.mmproj-Q8_0.gguf';

// SHA-256 published by the model repository (LFS object IDs).
const MOULSOT_SHA256: Record<string, string> = {
  [MOULSOT_MAIN_FILENAME]: '791719156ed819009020a6c9a34b0f109b47de4dcdab610e8a969096dde1123b',
  [MOULSOT_MMPROJ_FILENAME]: 'd530672efeaee3a0dad721334019e9155d2cea6184eeb126834fa6df2a8aa26c'
};

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

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

/** User-provided Whisper GGML files. Discovery reads the header, not the weights;
 * whisper.cpp still validates the complete model when transcription starts. */
function getCustomModels(): ModelInfo[] {
  const root = getModelsDir();
  const models: ModelInfo[] = [];
  // One level of optional folders is for organization only. Folder names do
  // not imply a model's language or change the user's language selection.
  const subfolders = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name);
  for (const subfolder of ['', ...subfolders]) {
    const directory = path.join(root, subfolder);
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.') || !/\.bin$/i.test(entry.name)) continue;
      if (!subfolder && (AVAILABLE_MODELS.some(model => model.id === entry.name) || entry.name === VAD_MODEL_FILENAME)) continue;
      const filePath = path.join(directory, entry.name);
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        const header = Buffer.alloc(48);
        if (stat.size <= header.length || fs.readSync(fd, header, 0, header.length, 0) !== header.length) continue;
        const fields = Array.from({ length: 12 }, (_, i) => header.readInt32LE(i * 4));
        if (fields[0] !== 0x67676d6c || ![51864, 51865, 51866].includes(fields[1]) ||
            fields.slice(2, 10).some(value => value <= 0) || ![80, 128].includes(fields[10])) continue;
        const englishOnly = fields[1] === 51864;
        models.push({
          id: `local:${subfolder ? `${subfolder}/` : ''}${entry.name}`,
          name: `Custom · ${subfolder ? `${subfolder}/` : ''}${entry.name.replace(/\.bin$/i, '')}`,
          size: stat.size >= 1e9 ? `${(stat.size / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(stat.size / 1e6))} MB`,
          sizeBytes: stat.size,
          speed: 'User-provided local model',
          downloaded: true, filePath, engine: 'whisper', custom: true, englishOnly
        });
      } catch {
        // A file can be moved, removed or still copying during a scan.
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get the full path for a model file
 */
export function getModelFilePath(modelId: string): string {
  if (modelId === MOULSOT_MODEL_ID) return path.join(getModelsDir(), MOULSOT_MAIN_FILENAME);
  if (modelId.startsWith('local:')) {
    const model = getCustomModels().find(model => model.id === modelId);
    if (!model?.filePath) throw new Error('Local model is missing or unsupported. Restore the file, refresh models, or select another model.');
    return model.filePath;
  }
  if (!AVAILABLE_MODELS.some(model => model.id === modelId)) throw new Error('Unknown caption model');
  return path.join(getModelsDir(), modelId);
}

/** Multimodal projector required by the MoulSot llama.cpp model. */
export function getMoulsotMmprojPath(): string {
  return path.join(getModelsDir(), MOULSOT_MMPROJ_FILENAME);
}

/**
 * Get the full path for the VAD model
 */
export function getVadModelPath(): string {
  return path.join(getModelsDir(), VAD_MODEL_FILENAME);
}

export function isMoulsotModel(modelId: string): boolean {
  return modelId === MOULSOT_MODEL_ID;
}

/**
 * Check if a model file is downloaded
 */
function isModelDownloaded(modelId: string): boolean {
  if (modelId === MOULSOT_MODEL_ID) {
    return fs.existsSync(getModelFilePath(modelId)) && fs.existsSync(getMoulsotMmprojPath());
  }
  return fs.existsSync(getModelFilePath(modelId));
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
  return [...AVAILABLE_MODELS.map(model => ({
    ...model,
    engine: model.engine || 'whisper',
    downloaded: isModelDownloaded(model.id),
    filePath: isModelDownloaded(model.id) ? getModelFilePath(model.id) : undefined,
    englishOnly: /\.en\.bin$/i.test(model.id)
  })), ...getCustomModels()];
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
 * Builtin English models end in `.en.bin`; custom files use the header's vocab
 * size so renaming a file cannot bypass the English-only language guard.
 */
export function isEnglishOnlyModel(modelId: string): boolean {
  if (modelId.startsWith('local:')) return getModelById(modelId)?.englishOnly === true;
  return !isMoulsotModel(modelId) && /\.en\.bin$/i.test(modelId);
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

  // Local IDs resolve only to freshly discovered files, never to a download URL.
  if (modelId.startsWith('local:')) return filePath;

  if (isMoulsotModel(modelId)) {
    const files = [
      { path: filePath, name: MOULSOT_MAIN_FILENAME, label: 'Darija model (1/2)' },
      { path: getMoulsotMmprojPath(), name: MOULSOT_MMPROJ_FILENAME, label: 'Darija model (2/2)' }
    ];
    for (const file of files) {
      checkCancellation(signal);
      if (fs.existsSync(file.path)) continue;
      console.log(`[ModelManager] Downloading ${file.name}...`);
      await downloadFile(
        MOULSOT_MODEL_BASE_URL + file.name,
        file.path,
        onProgress,
        file.label,
        signal
      );
      checkCancellation(signal);
      const expected = MOULSOT_SHA256[file.name];
      const actual = await sha256File(file.path);
      if (expected && actual !== expected) {
        fs.rmSync(file.path, { force: true });
        throw new Error(`Checksum mismatch for ${file.name} — download it again.`);
      }
      console.log(`[ModelManager] ${file.name} downloaded to ${file.path}`);
    }
    return filePath;
  }

  if (fs.existsSync(filePath)) {
    console.log(`[ModelManager] Model ${modelId} already downloaded at ${filePath}`);
    return filePath;
  }

  if (modelId === DARIJA_WHISPER_MODEL_ID) {
    await downloadFile(DARIJA_WHISPER_URL, filePath, onProgress, 'Whisper Small Darija (DoRA)', signal);
    checkCancellation(signal);
    const actual = await sha256File(filePath);
    if (actual !== DARIJA_WHISPER_SHA256) {
      fs.rmSync(filePath, { force: true });
      throw new Error('Checksum mismatch for Whisper Small Darija — download it again.');
    }
    checkCancellation(signal);
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
