/**
 * Resolves ffmpeg/ffprobe binaries shipped inside the app.
 *
 * The compressor already used the bundled `ffmpeg-static`/`ffprobe-static`
 * binaries, but the autocut (Multicam) and silence-removal flows only looked on
 * the system PATH — so a user without Homebrew got "No speech detected" or
 * "Failed to extract audio". This module is the single resolver all of those
 * flows share.
 */

import fs from 'fs';
import path from 'path';

function appRootCandidates(): string[] {
  const candidates: string[] = [];

  // Packaged: binaries live outside the asar archive.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
  }

  // Dev: process.cwd() is the project root.
  candidates.push(process.cwd());

  // Dev (compiled output lives in out/main): walk back to the project root.
  candidates.push(path.join(__dirname, '..', '..'));
  candidates.push(path.join(__dirname, '..', '..', '..'));

  return candidates;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the bundled ffmpeg/ffprobe path, or null when neither static package
 * ships a binary for this platform/arch.
 */
export function getBundledBinaryPath(binaryName: 'ffmpeg' | 'ffprobe'): string | null {
  const binaryFile = process.platform === 'win32' ? `${binaryName}.exe` : binaryName;

  if (binaryName === 'ffmpeg') {
    for (const root of appRootCandidates()) {
      const candidate = path.join(root, 'node_modules', 'ffmpeg-static', binaryFile);
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  }

  const platformDir = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64';
  for (const root of appRootCandidates()) {
    const candidate = path.join(root, 'node_modules', 'ffprobe-static', 'bin', platformDir, archDir, binaryFile);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

const SYSTEM_FFMPEG_PATHS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg'
];

const SYSTEM_FFPROBE_PATHS = [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe'
];

/**
 * Bundled binary first, then a few common system locations, then bare `ffmpeg`
 * so a PATH lookup still works as a last resort.
 */
export function getFFmpegPath(): string {
  const bundled = getBundledBinaryPath('ffmpeg');
  if (bundled) return bundled;

  if (process.platform === 'darwin') {
    for (const p of SYSTEM_FFMPEG_PATHS) {
      if (fs.existsSync(p)) return p;
    }
  }

  return 'ffmpeg';
}

export function getFFprobePath(): string {
  const bundled = getBundledBinaryPath('ffprobe');
  if (bundled) return bundled;

  if (process.platform === 'darwin') {
    for (const p of SYSTEM_FFPROBE_PATHS) {
      if (fs.existsSync(p)) return p;
    }
  }

  return 'ffprobe';
}
