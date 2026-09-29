/**
 * Silence Detector - Detects and removes silence from audio
 * Uses dB-based threshold for silence detection
 */

import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { getFFmpegPath } from '../ffmpeg-path';

export interface SilenceSegment {
  start: number;
  end: number;
  duration: number;
}

export interface SpeechSegment {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceAnalysisResult {
  originalDuration: number;
  silenceRemoved: number;
  newDuration: number;
  cutsCount: number;
  speechSegments: SpeechSegment[];
  silenceSegments: SilenceSegment[];
}

const FRAME_SIZE = 480; // 30ms at 16kHz
const SAMPLE_RATE = 16000;

function getTempDir(): string {
  const tempDir = path.join(os.tmpdir(), 'smoothyedit-temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

function runFFmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), args);
    let stdout = '';
    let stderr = '';

    ffmpeg.stdout.on('data', (data) => { stdout += data.toString(); });
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Combine multiple audio files into a single WAV for analysis
 */
export async function combineAudioTracks(inputPaths: string[]): Promise<string> {
  const tempDir = getTempDir();
  const outputPath = path.join(tempDir, `combined_${Date.now()}.wav`);

  if (inputPaths.length === 1) {
    // Single file - just convert to WAV
    await runFFmpeg([
      '-y',
      '-i', inputPaths[0],
      '-ac', '1',
      '-ar', SAMPLE_RATE.toString(),
      '-sample_fmt', 's16',
      '-f', 'wav',
      outputPath
    ]);
  } else {
    // Multiple files - mix together
    const inputs = inputPaths.flatMap(p => ['-i', p]);
    const filterComplex = inputPaths.map((_, i) => `[${i}:a]`).join('') +
      `amix=inputs=${inputPaths.length}:duration=longest:normalize=0[aout]`;

    await runFFmpeg([
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[aout]',
      '-ac', '1',
      '-ar', SAMPLE_RATE.toString(),
      '-sample_fmt', 's16',
      '-f', 'wav',
      outputPath
    ]);
  }

  return outputPath;
}

function readWavFile(filePath: string): Int16Array {
  const buffer = fs.readFileSync(filePath);

  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file');
  }

  let dataOffset = 12;
  while (dataOffset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
    const chunkSize = buffer.readUInt32LE(dataOffset + 4);

    if (chunkId === 'data') {
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  const dataLength = Math.floor((buffer.length - dataOffset) / 2);
  const samples = new Int16Array(dataLength);

  for (let i = 0; i < dataLength; i++) {
    samples[i] = buffer.readInt16LE(dataOffset + i * 2);
  }

  return samples;
}

function calculateRMS(samples: Int16Array, start: number, length: number): number {
  let sum = 0;
  const end = Math.min(start + length, samples.length);
  const count = end - start;

  if (count <= 0) return 0;

  for (let i = start; i < end; i++) {
    const normalized = samples[i] / 32768;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / count);
}

/**
 * Convert RMS to dB
 */
function rmsToDb(rms: number): number {
  if (rms <= 0) return -100;
  return 20 * Math.log10(rms);
}

/**
 * Convert dB threshold to RMS threshold
 */
function dbToRms(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Detect silence segments based on dB threshold
 */
export function detectSilence(
  samples: Int16Array,
  thresholdDb: number = -40,
  minSilenceDuration: number = 0.5,
  padding: number = 0.1
): { silenceSegments: SilenceSegment[]; speechSegments: SpeechSegment[] } {
  const threshold = dbToRms(thresholdDb);
  const silenceSegments: SilenceSegment[] = [];
  const speechSegments: SpeechSegment[] = [];

  const frameDuration = FRAME_SIZE / SAMPLE_RATE;
  const totalDuration = samples.length / SAMPLE_RATE;

  let inSilence = false;
  let silenceStart = 0;

  // First pass: detect raw silence regions
  for (let i = 0; i < samples.length; i += FRAME_SIZE) {
    const rms = calculateRMS(samples, i, FRAME_SIZE);
    const isSilent = rms < threshold;
    const currentTime = i / SAMPLE_RATE;

    if (isSilent && !inSilence) {
      inSilence = true;
      silenceStart = currentTime;
    } else if (!isSilent && inSilence) {
      inSilence = false;
      const duration = currentTime - silenceStart;
      if (duration >= minSilenceDuration) {
        silenceSegments.push({
          start: silenceStart,
          end: currentTime,
          duration
        });
      }
    }
  }

  // Handle silence at end
  if (inSilence) {
    const duration = totalDuration - silenceStart;
    if (duration >= minSilenceDuration) {
      silenceSegments.push({
        start: silenceStart,
        end: totalDuration,
        duration
      });
    }
  }

  // Apply padding to silence segments (shrink them to keep padding around speech)
  const paddedSilences = silenceSegments.map(seg => ({
    start: Math.min(seg.start + padding, seg.end),
    end: Math.max(seg.end - padding, seg.start),
    duration: Math.max(0, seg.duration - 2 * padding)
  })).filter(seg => seg.duration > 0);

  // Convert silence segments to speech segments (invert)
  if (paddedSilences.length === 0) {
    // No silence to remove
    speechSegments.push({
      start: 0,
      end: totalDuration,
      duration: totalDuration
    });
  } else {
    // Add speech segment before first silence
    if (paddedSilences[0].start > 0) {
      speechSegments.push({
        start: 0,
        end: paddedSilences[0].start,
        duration: paddedSilences[0].start
      });
    }

    // Add speech segments between silences
    for (let i = 0; i < paddedSilences.length - 1; i++) {
      const start = paddedSilences[i].end;
      const end = paddedSilences[i + 1].start;
      if (end > start) {
        speechSegments.push({
          start,
          end,
          duration: end - start
        });
      }
    }

    // Add speech segment after last silence
    const lastSilence = paddedSilences[paddedSilences.length - 1];
    if (lastSilence.end < totalDuration) {
      speechSegments.push({
        start: lastSilence.end,
        end: totalDuration,
        duration: totalDuration - lastSilence.end
      });
    }
  }

  return { silenceSegments: paddedSilences, speechSegments };
}

/**
 * Analyze audio for silence and return statistics
 */
export async function analyzeSilence(
  audioPath: string,
  thresholdDb: number = -40,
  minSilenceDuration: number = 0.5,
  padding: number = 0.1
): Promise<SilenceAnalysisResult> {
  console.log('Analyzing audio for silence...');
  console.log(`  Threshold: ${thresholdDb} dB`);
  console.log(`  Min silence duration: ${minSilenceDuration}s`);
  console.log(`  Padding: ${padding}s`);

  const samples = readWavFile(audioPath);
  const originalDuration = samples.length / SAMPLE_RATE;

  const { silenceSegments, speechSegments } = detectSilence(
    samples,
    thresholdDb,
    minSilenceDuration,
    padding
  );

  const silenceRemoved = silenceSegments.reduce((sum, seg) => sum + seg.duration, 0);
  const newDuration = originalDuration - silenceRemoved;

  console.log(`  Original duration: ${originalDuration.toFixed(1)}s`);
  console.log(`  Silence removed: ${silenceRemoved.toFixed(1)}s`);
  console.log(`  New duration: ${newDuration.toFixed(1)}s`);
  console.log(`  Cuts: ${speechSegments.length}`);

  return {
    originalDuration,
    silenceRemoved,
    newDuration,
    cutsCount: speechSegments.length,
    speechSegments,
    silenceSegments
  };
}

export function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up: ${filePath}`);
    }
  } catch (err) {
    console.warn(`Failed to clean up ${filePath}`);
  }
}

/**
 * Round a time value to the nearest video frame boundary
 */
export function roundToFrameBoundary(timeSeconds: number, fps: number): number {
  const frameDuration = 1 / fps;
  return Math.round(timeSeconds / frameDuration) * frameDuration;
}

/**
 * Align silence segments to video frame boundaries
 * This ensures audio and video cuts happen at exactly the same time
 * Adds buffer frames to ensure clean cuts through clips (no gaps)
 */
export function alignSegmentsToFrames(
  segments: SilenceSegment[],
  fps: number
): SilenceSegment[] {
  const frameDuration = 1 / fps;

  return segments.map(seg => {
    // Round start DOWN to previous frame boundary, then subtract 2 frames for buffer
    const alignedStart = Math.max(0, Math.floor(seg.start / frameDuration) * frameDuration - (2 * frameDuration));
    // Round end UP to next frame boundary, then add 2 frames for buffer
    const alignedEnd = Math.ceil(seg.end / frameDuration) * frameDuration + (2 * frameDuration);

    return {
      start: alignedStart,
      end: alignedEnd,
      duration: alignedEnd - alignedStart
    };
  }).filter(seg => seg.duration > 0); // Remove any segments that became zero-length
}
