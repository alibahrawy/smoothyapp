/**
 * Audio Extraction Module - Extracts mono WAV from video files using ffmpeg
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';

const SAMPLE_RATE = 16000;

function getFFmpegPath(): string {
  // In development, use system ffmpeg
  if (!app.isPackaged) {
    const systemPaths = [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg'
    ];
    for (const p of systemPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
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
