/**
 * Audio Extraction Module - Extracts mono WAV from video files using ffmpeg
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getFFmpegPath } from '../ffmpeg-path';

const SAMPLE_RATE = 16000;

// Handle for the running ffmpeg process so extraction can be cancelled.
let activeFFmpeg: import('child_process').ChildProcess | null = null;
let cancelRequested = false;

/**
 * Kill the in-flight ffmpeg extraction, if any. The pending promise rejects with
 * AUDIO_EXTRACTION_CANCELLED.
 */
export function cancelAudioExtraction(): void {
  cancelRequested = true;
  if (activeFFmpeg && !activeFFmpeg.killed) {
    console.log('[AudioExtractor] Cancelling ffmpeg...');
    try { activeFFmpeg.kill('SIGTERM'); } catch {}
  }
}

export function resetAudioExtractionCancel(): void {
  cancelRequested = false;
}

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
    let cancelled = false;

    activeFFmpeg = ffmpeg;
    cancelRequested = false;

    ffmpeg.stdout.on('data', (data) => { stdout += data.toString(); });
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

    ffmpeg.on('close', (code) => {
      if (activeFFmpeg === ffmpeg) activeFFmpeg = null;
      if (cancelled || cancelRequested) {
        reject(new Error('AUDIO_EXTRACTION_CANCELLED'));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      if (activeFFmpeg === ffmpeg) activeFFmpeg = null;
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    // If a cancel came in just before the process was registered, kill it now.
    if (cancelRequested) {
      cancelled = true;
      try { ffmpeg.kill('SIGTERM'); } catch {}
    }
  });
}

export async function extractAudioTrack(
  inputPath: string,
  speakerId: string,
  trackIndex: number = 0
): Promise<string> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const tempDir = getTempDir();
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(tempDir, `${baseName}_${speakerId}.wav`);

  const args = [
    '-y',
    '-i', inputPath,
    '-map', `0:a:${trackIndex}`,
    '-ac', '1',
    '-ar', SAMPLE_RATE.toString(),
    '-sample_fmt', 's16',
    '-f', 'wav',
    outputPath
  ];

  console.log(`Extracting track ${trackIndex} from ${path.basename(inputPath)}...`);
  await runFFmpeg(args);

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to create output file: ${outputPath}`);
  }

  console.log(`  -> ${outputPath}`);
  return outputPath;
}

export interface TimelineAudioClip {
  path: string;
  start: number;
  end: number;
  inPoint?: number | null;
  outPoint?: number | null;
}

export interface StitchedAudio {
  path: string;
  durationSeconds: number;
  clipCount: number;
}

/**
 * Build a single WAV that matches the sequence timeline by trimming every clip
 * to its source in/out range and placing it at its timeline offset, then mixing
 * all selected tracks. This replaces the old "first clip of each track" logic
 * that silently truncated long sequences (e.g. a 1 hour podcast to 14 minutes).
 */
export async function stitchTimelineAudio(
  clips: TimelineAudioClip[],
  outputName: string = 'caption_timeline'
): Promise<StitchedAudio> {
  const usable: { input: string; sourceStart: number; duration: number; delayMs: number }[] = [];
  const seen = new Set<string>();

  for (const clip of clips) {
    if (!clip || !clip.path) continue;

    if (!fs.existsSync(clip.path)) {
      console.warn(`[AudioExtractor] Skipping missing media: ${clip.path}`);
      continue;
    }

    const timelineStart = Math.max(0, Number(clip.start) || 0);
    const timelineEnd = Number(clip.end) || 0;
    let duration = timelineEnd - timelineStart;
    if (!(duration > 0.05)) continue;

    const sourceStart = Math.max(0, Number(clip.inPoint) || 0);
    const outPoint = Number(clip.outPoint) || 0;
    if (outPoint > sourceStart) {
      duration = Math.min(duration, outPoint - sourceStart);
    }
    if (!(duration > 0.05)) continue;

    const key = `${clip.path}|${sourceStart.toFixed(3)}|${duration.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    usable.push({
      input: clip.path,
      sourceStart,
      duration,
      delayMs: Math.round(timelineStart * 1000)
    });
  }

  if (usable.length === 0) {
    throw new Error('No usable audio clips found on the selected tracks');
  }

  const tempDir = getTempDir();
  const outputPath = path.join(tempDir, `${outputName}.wav`);

  const args = ['-y'];
  for (const clip of usable) {
    args.push('-i', clip.input);
  }

  const filters = usable.map((clip, i) => {
    const parts = [
      `atrim=start=${clip.sourceStart.toFixed(3)}:duration=${clip.duration.toFixed(3)}`,
      'asetpts=PTS-STARTPTS'
    ];
    if (clip.delayMs > 0) {
      parts.push(`adelay=${clip.delayMs}:all=1`);
    }
    return `[${i}:a]${parts.join(',')}[a${i}]`;
  });

  let outputLabel = '[a0]';
  if (usable.length > 1) {
    const refs = usable.map((_, i) => `[a${i}]`).join('');
    filters.push(`${refs}amix=inputs=${usable.length}:duration=longest:normalize=0[mix]`);
    outputLabel = '[mix]';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', outputLabel,
    '-ac', '1',
    '-ar', SAMPLE_RATE.toString(),
    '-sample_fmt', 's16',
    '-f', 'wav',
    outputPath
  );

  console.log(`[AudioExtractor] Stitching ${usable.length} clip(s) into timeline audio...`);
  await runFFmpeg(args);

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Failed to create stitched audio: ${outputPath}`);
  }

  const durationSeconds = getWavDurationSeconds(outputPath);
  console.log(`[AudioExtractor] Stitched audio: ${outputPath} (${durationSeconds.toFixed(1)}s)`);

  return { path: outputPath, durationSeconds, clipCount: usable.length };
}

/**
 * Duration of a PCM 16-bit mono 16 kHz WAV, derived from file size.
 */
export function getWavDurationSeconds(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    const audioBytes = Math.max(0, stats.size - 44);
    return audioBytes / (SAMPLE_RATE * 2);
  } catch {
    return 0;
  }
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

export { getTempDir };
