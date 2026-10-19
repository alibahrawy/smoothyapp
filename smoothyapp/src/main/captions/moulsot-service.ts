/**
 * MoulSot v0.3 Darija transcription through llama.cpp.
 *
 * Qwen3-ASR emits text but no word timestamps. We split the audio at speech /
 * silence boundaries and distribute words across each speech segment, keeping
 * captions aligned to the spoken parts of the timeline.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { checkCancellation } from './download-file';
import {
  ensureModelDownloaded,
  getModelFilePath,
  getMoulsotMmprojPath,
  isMoulsotModel
} from './model-manager';
import { ensureLlamaBinary } from './llama-bin-manager';
import type { CaptionBackend } from './caption-engine';
import { detectSilenceCancelable, readWavFile, type SpeechSegment } from '../autocut/silence-detector';
import type { ProgressCallback, TranscriptionChunk, TranscriptionResult } from './whisper-service';

const SAMPLE_RATE = 16000;
const MAX_CHUNK_SECONDS = 28;
const MIN_SPEECH_SECONDS = 0.2;

let activeCli: string | null = null;
let activeBackend: CaptionBackend = 'cpu';
let activeLibraryDirs: string[] = [];
let currentModelId: string | null = null;
let enginePreference: 'auto' | 'cuda' | 'cpu' = 'auto';
let activeProcess: ChildProcessWithoutNullStreams | null = null;

export function setEnginePreference(pref: 'auto' | 'cuda' | 'cpu'): void {
  enginePreference = pref === 'cuda' || pref === 'cpu' ? pref : 'auto';
}

export function getEnginePreference(): 'auto' | 'cuda' | 'cpu' {
  return enginePreference;
}

export function getActiveBackend(): CaptionBackend {
  return activeBackend;
}

export function getCurrentModelId(): string | null {
  return currentModelId;
}

export function isModelLoaded(): boolean {
  return activeCli !== null;
}

export async function loadModel(
  modelId: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<void> {
  checkCancellation(signal);
  if (!isMoulsotModel(modelId)) throw new Error(`Not a Darija model: ${modelId}`);

  await ensureModelDownloaded(modelId, onProgress, signal);
  checkCancellation(signal);

  const binary = await ensureLlamaBinary(enginePreference, onProgress, signal);
  checkCancellation(signal);

  activeCli = binary.cli;
  activeBackend = binary.backend;
  activeLibraryDirs = binary.libraryDirs;
  currentModelId = modelId;
  onProgress?.({ status: 'ready', progress: 100 });
  console.log(`[MoulSot] Ready (${activeBackend})`);
}

export async function transcribe(
  audioPath: string,
  onProgress?: ProgressCallback,
  modelId?: string,
  _language?: string,
  signal?: AbortSignal
): Promise<TranscriptionResult> {
  checkCancellation(signal);
  if (!activeCli) throw new Error('No Darija engine loaded. Call loadModel() first.');

  const model = modelId || currentModelId;
  if (!model || !isMoulsotModel(model)) throw new Error('No Darija model selected.');
  const modelPath = getModelFilePath(model);
  const mmprojPath = getMoulsotMmprojPath();
  if (!fs.existsSync(modelPath) || !fs.existsSync(mmprojPath)) {
    throw new Error('Darija model files are missing — re-open Captions to download them again.');
  }

  const samples = readWavFile(audioPath);
  if (samples.length === 0) throw new Error('Audio file is empty.');
  const duration = samples.length / SAMPLE_RATE;

  onProgress?.({ status: 'Finding speech segments…', progress: 1 });
  const { speechSegments } = await detectSilenceCancelable(samples, -40, 0.35, 0.12, signal);
  checkCancellation(signal);

  const chunks = buildChunks(speechSegments, samples, duration);
  if (chunks.length === 0) {
    onProgress?.({ status: 'complete', progress: 100 });
    return { text: '', chunks: [], language: 'ary' };
  }

  const tempFiles: string[] = [];
  const resultChunks: TranscriptionChunk[] = [];
  const textParts: string[] = [];
  let minStart = 0;

  try {
    for (let i = 0; i < chunks.length; i++) {
      checkCancellation(signal);
      const chunk = chunks[i];
      const wavPath = path.join(os.tmpdir(), `smoothyedit-darija-${randomUUID()}.wav`);
      writeWavSlice(wavPath, samples, chunk.startSample, chunk.endSample);
      tempFiles.push(wavPath);

      onProgress?.({
        status: `Transcribing Darija — ${i + 1}/${chunks.length}`,
        progress: Math.min(95, Math.round((i / chunks.length) * 95))
      });

      const output = await runCli(wavPath, modelPath, mmprojPath, signal);
      const text = parseAsrText(output);
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const wordChunks = assignTimings(words, chunk.segments, duration);
        for (const word of wordChunks) {
          const start = Math.max(word.timestamp[0], minStart);
          const end = Math.max(word.timestamp[1], start + 0.01);
          resultChunks.push({
            text: word.text,
            timestamp: [round2(start), round2(end)]
          });
          minStart = end;
        }
        textParts.push(text);
      }

      fs.rmSync(wavPath, { force: true });
    }
  } finally {
    tempFiles.forEach((file) => {
      try { fs.rmSync(file, { force: true }); } catch {}
    });
    activeProcess = null;
  }

  checkCancellation(signal);
  onProgress?.({ status: 'complete', progress: 100 });

  const text = textParts.join(' ').replace(/\s+/g, ' ').trim();
  console.log(`[MoulSot] Transcription complete — ${resultChunks.length} words, ${text.length} chars`);
  return { text, chunks: resultChunks, language: 'ary' };
}

export async function cancelTranscription(): Promise<void> {
  if (!activeProcess) return;
  const child = activeProcess;
  activeProcess = null;
  try { child.kill('SIGTERM'); } catch {}
}

export function isTranscribing(): boolean {
  return activeProcess !== null;
}

export async function unloadModel(): Promise<void> {
  activeCli = null;
  currentModelId = null;
  console.log('[MoulSot] Model unloaded');
}

interface AudioChunk {
  startSample: number;
  endSample: number;
  segments: SpeechSegment[];
}

function buildChunks(
  speechSegments: SpeechSegment[],
  samples: Int16Array,
  duration: number
): AudioChunk[] {
  const merged: SpeechSegment[] = [];
  for (const segment of speechSegments) {
    if (!(segment.duration >= MIN_SPEECH_SECONDS)) continue;
    const start = Math.max(0, segment.start - 0.12);
    const end = Math.min(duration, segment.end + 0.12);
    const previous = merged[merged.length - 1];
    if (previous && start - previous.end <= 0.4) {
      previous.end = Math.max(previous.end, end);
      previous.duration = previous.end - previous.start;
    } else {
      merged.push({ start, end, duration: end - start });
    }
  }

  const split: SpeechSegment[] = [];
  for (const segment of merged) {
    let start = segment.start;
    while (segment.end - start > MAX_CHUNK_SECONDS) {
      const target = start + 20;
      const from = Math.max(start + 6, target - 2);
      const to = Math.min(segment.end - 2, target + 2);
      const cut = to > from ? findQuietestCut(samples, from, to) : target;
      if (cut <= start + 1) break;
      split.push({ start, end: cut, duration: cut - start });
      start = cut;
    }
    if (segment.end - start >= MIN_SPEECH_SECONDS) {
      split.push({ start, end: segment.end, duration: segment.end - start });
    }
  }

  const chunks: AudioChunk[] = [];
  let current: { start: number; end: number; segments: SpeechSegment[] } | null = null;
  for (const segment of split) {
    if (!current) {
      current = { start: segment.start, end: segment.end, segments: [segment] };
    } else if (segment.end - current.start <= MAX_CHUNK_SECONDS && segment.start - current.end <= 2) {
      current.end = Math.max(current.end, segment.end);
      current.segments.push(segment);
    } else {
      chunks.push(toAudioChunk(current, samples.length));
      current = { start: segment.start, end: segment.end, segments: [segment] };
    }
  }
  if (current) chunks.push(toAudioChunk(current, samples.length));
  return chunks;
}

function toAudioChunk(
  chunk: { start: number; end: number; segments: SpeechSegment[] },
  totalSamples: number
): AudioChunk {
  return {
    startSample: Math.max(0, Math.floor(chunk.start * SAMPLE_RATE)),
    endSample: Math.min(totalSamples, Math.ceil(chunk.end * SAMPLE_RATE)),
    segments: chunk.segments
  };
}

/** Find the quietest 0.3 s window between `from` and `to` seconds. */
function findQuietestCut(samples: Int16Array, from: number, to: number): number {
  const window = Math.round(0.3 * SAMPLE_RATE);
  const step = Math.round(0.1 * SAMPLE_RATE);
  const fromSample = Math.max(0, Math.round(from * SAMPLE_RATE));
  const toSample = Math.min(samples.length - window, Math.round(to * SAMPLE_RATE));
  let best = fromSample;
  let bestEnergy = Infinity;
  for (let start = fromSample; start <= toSample; start += step) {
    let energy = 0;
    for (let i = start; i < start + window; i += 8) {
      const value = samples[i] / 32768;
      energy += value * value;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start;
    }
  }
  return best / SAMPLE_RATE;
}

/**
 * Map words onto the speech segments of a chunk. Words are placed by character
 * position across the chunk's speech time, so pauses do not consume caption
 * time.
 */
export function assignTimings(
  words: string[],
  segments: SpeechSegment[],
  totalDuration: number
): TranscriptionChunk[] {
  const usable = segments.filter((segment) => segment.duration > 0);
  const totalSpeech = usable.reduce((sum, segment) => sum + segment.duration, 0);
  const totalChars = words.reduce((sum, word) => sum + Array.from(word).length, 0) || 1;

  if (usable.length === 0 || totalSpeech <= 0) {
    return distributeEvenly(words, totalDuration);
  }

  const segmentIndexAt = (speechTime: number): number => {
    let elapsed = 0;
    for (let i = 0; i < usable.length; i++) {
      if (speechTime <= elapsed + usable[i].duration || i === usable.length - 1) return i;
      elapsed += usable[i].duration;
    }
    return usable.length - 1;
  };

  const toAbsolute = (speechTime: number): number => {
    let elapsed = 0;
    for (let i = 0; i < usable.length; i++) {
      const segment = usable[i];
      if (speechTime <= elapsed + segment.duration || i === usable.length - 1) {
        return segment.start + Math.min(segment.duration, Math.max(0, speechTime - elapsed));
      }
      elapsed += segment.duration;
    }
    return usable[usable.length - 1].end;
  };

  const output: TranscriptionChunk[] = [];
  let charCursor = 0;
  let minStart = 0;
  for (const word of words) {
    const length = Array.from(word).length;
    const startSpeech = (charCursor / totalChars) * totalSpeech;
    charCursor += length;
    const endSpeech = (charCursor / totalChars) * totalSpeech;

    let start = Math.max(toAbsolute(startSpeech), minStart);
    let end = Math.max(toAbsolute(endSpeech), start + 0.01);

    // If the word crosses a pause, keep it inside the speech segment where it
    // starts instead of stretching the caption over the silence.
    const startSegment = segmentIndexAt(startSpeech);
    const endSegment = segmentIndexAt(endSpeech);
    if (startSegment !== endSegment) {
      end = Math.max(start + 0.01, usable[startSegment].end);
    }

    output.push({ text: word, timestamp: [round2(start), round2(end)] });
    minStart = end;
  }
  return output;
}

function distributeEvenly(words: string[], totalDuration: number): TranscriptionChunk[] {
  const totalChars = words.reduce((sum, word) => sum + Array.from(word).length, 0) || 1;
  const output: TranscriptionChunk[] = [];
  let cursor = 0;
  for (const word of words) {
    const start = (cursor / totalChars) * totalDuration;
    cursor += Array.from(word).length;
    const end = (cursor / totalChars) * totalDuration;
    output.push({ text: word, timestamp: [round2(start), round2(Math.max(end, start + 0.01))] });
  }
  return output;
}

function runCli(
  audioPath: string,
  modelPath: string,
  mmprojPath: string,
  signal?: AbortSignal
): Promise<string> {
  const cli = activeCli;
  if (!cli) return Promise.reject(new Error('Darija engine is not ready.'));

  const args = [
    '-m', modelPath,
    '--mmproj', mmprojPath,
    '--audio', audioPath,
    '-p', 'Transcribe the audio exactly in Moroccan Darija. Do not translate.',
    '-n', '512',
    '--temp', '0',
    '-t', String(Math.max(1, os.cpus().length)),
    '--no-warmup',
    '-ngl', activeBackend === 'cpu' ? '0' : '99'
  ];

  checkCancellation(signal);
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [path.dirname(cli), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    const child = spawn(cli, args, {
      windowsHide: true,
      cwd: path.dirname(cli),
      env
    });
    activeProcess = child;
    const abort = () => { try { child.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      if (activeProcess === child) activeProcess = null;
    };

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`Failed to start the Darija engine: ${error.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new Error('TRANSCRIPTION_CANCELLED'));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
      reject(new Error(`Darija engine exited with code ${code}${tail ? ': ' + tail : ''}`));
    });
  });
}

export function parseAsrText(stdout: string): string {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const marker = clean.lastIndexOf('<asr_text>');
  let text = marker >= 0 ? clean.slice(marker + '<asr_text>'.length) : clean;
  text = text.replace(/^\s*language\s+[^<\n]*/i, '');
  return text.replace(/\s+/g, ' ').trim();
}

function writeWavSlice(
  filePath: string,
  samples: Int16Array,
  startSample: number,
  endSample: number
): void {
  const count = Math.max(0, endSample - startSample);
  const buffer = Buffer.allocUnsafe(44 + count * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    buffer.writeInt16LE(samples[startSample + i], 44 + i * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
