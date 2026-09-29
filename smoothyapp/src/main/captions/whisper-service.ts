/**
 * Whisper Service - Runs transcription via the whisper.cpp CLI.
 *
 * Why the CLI and not @fugood/whisper.node: the native binding's GPU packages
 * target the wrong CUDA architecture and omit the CUDA runtime DLLs, so they
 * silently report "no GPU found" and run on CPU with only 4 threads. Driving the
 * whisper.cpp CLI with a CUDA build (bundled runtime) gives real GPU speed
 * (~2.5x over a fully-threaded CPU build on the same machine).
 *
 * The CLI is downloaded on demand by whisper-bin-manager and selected per
 * platform (CUDA -> CPU on Windows/Linux, Metal/CPU on macOS).
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ensureModelDownloaded,
  getModelFilePath
} from './model-manager';
import {
  ensureBinary,
  isBinaryInstalled,
  getVariantOrder,
  clearBinary,
  setEnginePreference as setBinEnginePreference,
  getEnginePreference as getBinEnginePreference,
  WhisperVariant
} from './whisper-bin-manager';

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

let currentModelId: string | null = null;
let activeBackend: WhisperVariant = 'cpu';
let activeBinary: string | null = null;
let enginePrefSetting: 'auto' | 'cuda' | 'cpu' = 'auto';
let activeTranscribe: {
  process: ChildProcessWithoutNullStreams;
  cancel: () => void;
} | null = null;

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

export function getActiveBackend(): string {
  return activeBackend;
}

/**
 * Choose which engine the next transcription uses: 'auto' (best detected),
 * 'cuda' (force GPU), or 'cpu' (force CPU with every thread).
 */
export function setEnginePreference(pref: 'auto' | 'cuda' | 'cpu'): void {
  const normalized = pref === 'cuda' || pref === 'cpu' ? pref : 'auto';
  const changed = normalized !== enginePrefSetting;
  enginePrefSetting = normalized;
  setBinEnginePreference(normalized);
  if (changed) {
    activeBinary = null;
    console.log('[Whisper] Engine preference changed — engine will reload on next use');
  }
}

export function getEnginePreference(): 'auto' | 'cuda' | 'cpu' {
  return enginePrefSetting;
}

/**
 * Resolve (downloading if needed) a working whisper.cpp binary for this
 * machine, preferring the best variant and falling back to CPU.
 */
export async function loadModel(
  modelId: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const modelPath = await ensureModelDownloaded(modelId, (p) => {
    if (onProgress) {
      onProgress({ status: 'downloading', progress: p.progress, file: p.file });
    }
  });

  const order = getVariantOrder();
  const errors: string[] = [];

  for (const variant of order) {
    try {
      if (!isBinaryInstalled(variant)) {
        if (onProgress) {
          onProgress({
            status: 'downloading-bin',
            progress: 0,
            file: variant === 'cuda'
              ? 'Downloading GPU engine (one-time setup)'
              : 'Downloading transcription engine (one-time setup)'
          });
        }
      }
      const exe = await ensureBinary(variant, (p) => {
        if (onProgress) {
          onProgress({
            status: 'downloading-bin',
            progress: p.progress,
            file: variant === 'cuda'
              ? 'Downloading GPU engine (one-time setup)'
              : 'Downloading transcription engine (one-time setup)'
          });
        }
      });
      activeBinary = exe;
      activeBackend = variant;
      currentModelId = modelId;
      console.log(`[Whisper] Using whisper.cpp binary: ${exe} (${variant})`);
      if (onProgress) onProgress({ status: 'ready', progress: 100 });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${variant}: ${message}`);
      console.warn(`[Whisper] Could not prepare ${variant} binary:`, message);
      // A broken download shouldn't wedge the app — clear and let CPU be tried.
      try { clearBinary(variant); } catch {}
    }
  }

  throw new Error(`Could not prepare a transcription engine (${errors.join(' | ')})`);
}

export function isModelLoaded(): boolean {
  return activeBinary !== null;
}

export function getCurrentModelId(): string | null {
  return currentModelId;
}

interface CliToken {
  text: string;
  offsets?: { from: number; to: number };
}

interface CliSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens?: CliToken[];
}

interface CliJson {
  result?: { language?: string };
  transcription: CliSegment[];
}

/** Special tokens whisper.cpp emits that must never reach the captions. */
const SPECIAL_TOKEN = /^\[_.*\]$|^<\|.*\|>$/;

/**
 * Turn whisper.cpp JSON segments into word-level chunks. We prefer per-token
 * offsets (accurate) and fall back to proportional interpolation within a
 * segment when token timing is missing. Times are forced monotonic.
 */
function segmentsToChunks(segments: CliSegment[]): TranscriptionChunk[] {
  const chunks: TranscriptionChunk[] = [];
  let minStart = 0;

  for (const seg of segments) {
    if (!seg || !seg.text || !seg.text.trim()) continue;

    const segStart = Math.max(0, (seg.offsets?.from ?? 0) / 1000);
    const segEnd = Math.max(segStart, (seg.offsets?.to ?? 0) / 1000);

    // Build words from tokens when available.
    const tokens = (seg.tokens || [])
      .filter((t) => t && t.text && !SPECIAL_TOKEN.test(t.text.trim()))
      .map((t) => ({
        text: t.text,
        start: Math.max(0, (t.offsets?.from ?? 0) / 1000),
        end: Math.max(0, (t.offsets?.to ?? 0) / 1000)
      }));

    if (tokens.length > 0) {
      for (const tok of tokens) {
        // Tokens can be sub-word pieces; text is usually space-prefixed.
        const isNewWord = /^\s/.test(tok.text) || chunks.length === 0;
        let text = tok.text.trim();
        if (!text) continue;

        if (!isNewWord && chunks.length > 0) {
          // Continuation of the previous word – merge text, extend end time.
          const prev = chunks[chunks.length - 1];
          prev.text += text;
          prev.timestamp[1] = Math.max(prev.timestamp[1], round2(Math.max(tok.end, minStart)));
          minStart = prev.timestamp[1];
          continue;
        }

        let start = Math.max(tok.start, minStart);
        let end = Math.max(tok.end, start + 0.01);
        start = round2(start);
        end = round2(end);
        if (end <= start) end = round2(start + 0.01);

        chunks.push({ text, timestamp: [start, end] });
        minStart = end;
      }
      continue;
    }

    // Fallback: interpolate words across the segment.
    const words = seg.text.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) continue;
    const duration = Math.max(0.01, segEnd - segStart);
    const totalChars = words.reduce((s, w) => s + w.length, 0) || 1;
    let charOffset = 0;
    for (const word of words) {
      let start = segStart + (charOffset / totalChars) * duration;
      charOffset += word.length;
      let end = segStart + (charOffset / totalChars) * duration;
      if (start < minStart) start = minStart;
      if (end <= start) end = start + 0.01;
      start = round2(start);
      end = round2(end);
      if (end <= start) end = round2(start + 0.01);
      chunks.push({ text: word, timestamp: [start, end] });
      minStart = end;
    }
  }

  return chunks;
}

/**
 * Transcribe an audio file. `audioPath` should be WAV/MP3/FLAC/OGG — the CLI
 * decodes these directly. `language` is a whisper language code, or `auto` to
 * let whisper detect the spoken language.
 */
export async function transcribe(
  audioPath: string,
  onProgress?: ProgressCallback,
  modelId?: string,
  language?: string
): Promise<TranscriptionResult> {
  if (!activeBinary) {
    throw new Error('No transcription engine loaded. Call loadModel() first.');
  }

  const model = modelId || currentModelId;
  if (!model) {
    throw new Error('No model selected.');
  }
  const modelPath = getModelFilePath(model);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file missing: ${modelPath}`);
  }

  const lang = language && language.trim() ? language.trim() : 'en';

  const outBase = path.join(os.tmpdir(), `smoothyedit-whisper-${Date.now()}`);
  const threads = os.cpus().length;
  const jsonPath = `${outBase}.json`;

  const runOnce = (binary: string, backend: WhisperVariant, onProgressCb?: ProgressCallback): Promise<string> => {
    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-l', lang,
      '-oj',            // JSON output
      '-of', outBase,
      '-t', String(threads),
      '-ml', '50',      // max segment length (chars) -> short phrases
      '-pp'             // print progress
    ];

    // Force CPU when we deliberately loaded the CPU build.
    if (backend === 'cpu') args.push('-ng');

    console.log(`[Whisper] Running CLI (${backend}, ${threads} threads): ${path.basename(binary)}`);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true });
      let stderr = '';
      let lastReported = -1;

      const cleanup = () => {
        activeTranscribe = null;
        for (const ext of ['.txt', '.srt', '.vtt', '.json']) {
          try { const p = outBase + ext; if (fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch {}
        }
      };

      activeTranscribe = {
        process: child,
        cancel: () => {
          try { child.kill('SIGTERM'); } catch {}
        }
      };

      const reportProgress = (text: string) => {
        const m = [...text.matchAll(/progress\s*=\s*(\d+)%/g)];
        if (m.length > 0 && onProgressCb) {
          const pct = parseInt(m[m.length - 1][1], 10);
          if (pct !== lastReported) {
            lastReported = pct;
            onProgressCb({
              status: `Transcribing — ${pct}%`,
              progress: Math.min(95, Math.round(pct * 0.95))
            });
          }
        }
      };

      child.stdout.on('data', (d) => reportProgress(d.toString()));
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        reportProgress(d.toString());
      });

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to start whisper.cpp: ${err.message}`));
      });

      child.on('close', (code) => {
        const cancelled = activeTranscribe === null && code !== 0;
        if (code === 0 && fs.existsSync(jsonPath)) {
          // Read the output BEFORE cleanup deletes it.
          let raw = '';
          try {
            raw = fs.readFileSync(jsonPath, 'utf-8');
          } catch (err) {
            cleanup();
            reject(new Error(`Could not read whisper.cpp output: ${err instanceof Error ? err.message : String(err)}`));
            return;
          }
          cleanup();
          resolve(raw);
        } else if (cancelled) {
          cleanup();
          reject(new Error('TRANSCRIPTION_CANCELLED'));
        } else {
          cleanup();
          const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
          reject(new Error(`whisper.cpp exited with code ${code}${tail ? ': ' + tail : ''}`));
        }
      });
    });
  };

  // Run the job; if a GPU build fails at runtime (driver/runtime problems,
  // unsupported card, VRAM exhaustion) retry once on CPU so the user still
  // gets captions instead of an error.
  let result: string;
  try {
    result = await runOnce(activeBinary as string, activeBackend, onProgress);
  } catch (err) {
    if (err instanceof Error && err.message === 'TRANSCRIPTION_CANCELLED') throw err;
    if (activeBackend === 'cuda') {
      console.warn('[Whisper] GPU engine failed — retrying on CPU:', err instanceof Error ? err.message : err);
      if (onProgress) onProgress({ status: 'GPU engine failed — retrying on CPU…' });
      const cpuExe = await ensureBinary('cpu');
      activeBinary = cpuExe;
      activeBackend = 'cpu';
      result = await runOnce(cpuExe, 'cpu', onProgress);
    } else {
      throw err;
    }
  }

  let parsed: CliJson;
  try {
    parsed = JSON.parse(result) as CliJson;
  } catch {
    throw new Error('Could not parse whisper.cpp output');
  }

  const segments = parsed.transcription || [];
  const chunks = segmentsToChunks(segments);
  const text = chunks.map((c) => c.text).join(' ');
  const detectedLanguage = parsed.result?.language || lang;

  if (onProgress) onProgress({ status: 'complete', progress: 100 });

  console.log(`[Whisper] Transcription complete — ${segments.length} segments → ${chunks.length} words, ${text.length} chars`);

  return { text, chunks, language: detectedLanguage };
}

/**
 * Cancel the in-flight transcription. The promise rejects with
 * TRANSCRIPTION_CANCELLED.
 */
export async function cancelTranscription(): Promise<void> {
  if (activeTranscribe) {
    console.log('[Whisper] Cancelling transcription...');
    const child = activeTranscribe.process;
    activeTranscribe = null;
    try { child.kill('SIGTERM'); } catch {}
  }
}

export function isTranscribing(): boolean {
  return activeTranscribe !== null;
}

/** Release the loaded engine reference (nothing to free for the CLI). */
export async function unloadModel(): Promise<void> {
  activeBinary = null;
  currentModelId = null;
  console.log('[Whisper] Model unloaded');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
