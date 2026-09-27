/**
 * Whisper Binary Manager - Downloads and manages the whisper.cpp CLI binaries.
 *
 * The @fugood/whisper.node native binding ships GPU builds that target the wrong
 * CUDA architecture and omit the CUDA runtime, so they silently fall back to CPU.
 * We instead drive the whisper.cpp CLI, using a CUDA build with bundled CUDA
 * runtime DLLs (compute capability 7.5+ incl. RTX 20/30/40 series).
 *
 * Binaries are mirrored to our own GitHub release so availability is under our
 * control. See `docs/PROJECT-STATUS.md`.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { execFileSync } from 'child_process';

export type WhisperVariant = 'cuda' | 'cpu' | 'metal';

const BIN_RELEASE_BASE =
  'https://github.com/alibahrawy/smoothyapp/releases/download/whisper-cpp-bins-v1.0.0';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/** Asset filename for a variant on the current platform. */
function getAssetName(variant: WhisperVariant): string | null {
  const platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  // Only the variants we mirror are listed.
  if (platform === 'win32' && arch === 'x64') {
    if (variant === 'cuda') return 'whisper-cpp-win32-x64-cuda.zip';
    if (variant === 'cpu') return 'whisper-cpp-win32-x64-cpu.zip';
  }
  if (platform === 'darwin' && arch === 'arm64' && variant === 'metal') {
    return 'whisper-cpp-darwin-arm64.zip';
  }
  if (platform === 'darwin' && arch === 'x64' && variant === 'cpu') {
    return 'whisper-cpp-darwin-x64.zip';
  }
  if (platform === 'linux' && arch === 'x64') {
    if (variant === 'cuda') return 'whisper-cpp-linux-x64-cuda.zip';
    if (variant === 'cpu') return 'whisper-cpp-linux-x64-cpu.zip';
  }
  return null;
}

export function getBinDir(): string {
  const dir = path.join(app.getPath('userData'), 'whisper-bin');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getVariantDir(variant: WhisperVariant): string {
  return path.join(getBinDir(), variant);
}

/** Expected CLI executable name inside the extracted variant folder. */
function getExeName(): string {
  const platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux';
  return `whisper-cpp-${platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}-${'VARIANT'}`;
}

/** Find the whisper CLI executable in a directory (name varies by variant). */
function findExe(dir: string, variant: WhisperVariant): string | null {
  if (!fs.existsSync(dir)) return null;
  const exeSuffix = isWindows ? '.exe' : '';
  const entries = fs.readdirSync(dir);
  // Prefer a file that ends with -<variant>.exe, then any whisper-cpp-*.exe
  const exact = entries.find((e) => e.endsWith(`-${variant}${exeSuffix}`));
  if (exact) return path.join(dir, exact);
  const any = entries.find((e) => e.startsWith('whisper-cpp-') && e.endsWith(exeSuffix));
  return any ? path.join(dir, any) : null;
}

function hasNvidiaGpu(): boolean {
  if (isMac) return false;
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export function isBinaryInstalled(variant: WhisperVariant): boolean {
  return findExe(getVariantDir(variant), variant) !== null;
}

/** User-chosen engine: 'auto' (best detected), 'cuda' (force GPU), 'cpu' (force CPU). */
export type EnginePreference = 'auto' | 'cuda' | 'cpu';

let enginePreference: EnginePreference = 'auto';

export function setEnginePreference(pref: EnginePreference): void {
  enginePreference = pref === 'cuda' || pref === 'cpu' ? pref : 'auto';
  console.log(`[WhisperBin] Engine preference: ${enginePreference}`);
}

export function getEnginePreference(): EnginePreference {
  return enginePreference;
}

/**
 * The preferred variant for this machine: CUDA when an NVIDIA GPU is present
 * (Windows/Linux), Metal on Apple Silicon, otherwise CPU.
 */
export function getPreferredVariant(): WhisperVariant {
  if (isMac) {
    return process.arch === 'arm64' ? 'metal' : 'cpu';
  }
  return hasNvidiaGpu() ? 'cuda' : 'cpu';
}

/** Ordered list of variants to try, best first. */
export function getVariantOrder(): WhisperVariant[] {
  if (enginePreference === 'cpu') {
    return ['cpu'];
  }
  if (enginePreference === 'cuda') {
    // Forced GPU: try CUDA first, CPU as a safety net so a forced choice
    // never blocks transcription entirely.
    return ['cuda', 'cpu'];
  }
  const preferred = getPreferredVariant();
  const fallbacks: WhisperVariant[] = preferred === 'cuda' ? ['cuda', 'cpu'] : [preferred];
  return Array.from(new Set(fallbacks));
}

export type BinProgressCallback = (progress: {
  status: string;
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
}) => void;

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: BinProgressCallback,
  label?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempPath = destPath + '.tmp';
    const file = fs.createWriteStream(tempPath);

    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 6) {
        file.close();
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        reject(new Error('Too many redirects'));
        return;
      }
      const protocol = requestUrl.startsWith('https') ? https : http;
      protocol
        .get(requestUrl, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume();
            doRequest(response.headers.location, redirectCount + 1);
            return;
          }
          if (response.statusCode !== 200) {
            file.close();
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }
          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloaded = 0;
          response.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (onProgress && totalSize > 0) {
              onProgress({
                status: 'downloading',
                progress: Math.round((downloaded / totalSize) * 100),
                file: label || path.basename(destPath),
                loaded: downloaded,
                total: totalSize
              });
            }
          });
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try {
                fs.renameSync(tempPath, destPath);
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          });
        })
        .on('error', (err) => {
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

/** Extract a zip using PowerShell (Windows) or `unzip`/`ditto` (macOS/Linux). */
function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (isWindows) {
    const escapedZip = zipPath.replace(/'/g, "''");
    const escapedDest = destDir.replace(/'/g, "''");
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`
      ],
      { timeout: 600000 }
    );
    return;
  }
  try {
    execFileSync('mkdir', ['-p', destDir]);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 600000 });
  } catch {
    // Fallback for macOS without unzip
    execFileSync('ditto', ['-x', '-k', zipPath, destDir], { timeout: 600000 });
  }
}

/**
 * Ensure the whisper.cpp CLI for a variant is present, downloading if needed.
 * Returns the absolute path to the executable.
 */
export async function ensureBinary(
  variant: WhisperVariant,
  onProgress?: BinProgressCallback
): Promise<string> {
  const existing = findExe(getVariantDir(variant), variant);
  if (existing) return existing;

  const asset = getAssetName(variant);
  if (!asset) {
    throw new Error(`No whisper.cpp binary available for ${process.platform}/${process.arch} (${variant})`);
  }

  const urls = [`${BIN_RELEASE_BASE}/${asset}`];
  const variantDir = getVariantDir(variant);
  const zipPath = path.join(getBinDir(), asset);

  if (onProgress) {
    onProgress({ status: 'downloading', progress: 0, file: asset });
  }

  let lastError: unknown = null;
  for (const url of urls) {
    try {
      await downloadFile(url, zipPath, onProgress, asset);
      extractZip(zipPath, variantDir);
      fs.rmSync(zipPath, { force: true });

      const exe = findExe(variantDir, variant);
      if (!exe) throw new Error('Executable not found after extraction');
      if (!isWindows) {
        try { fs.chmodSync(exe, 0o755); } catch {}
      }
      if (onProgress) onProgress({ status: 'ready', progress: 100 });
      return exe;
    } catch (err) {
      lastError = err;
      console.warn(`[WhisperBin] Failed from ${url}:`, err);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to download whisper.cpp binary');
}

/** Remove a partially-installed variant so the next run re-downloads it. */
export function clearBinary(variant: WhisperVariant): void {
  const dir = getVariantDir(variant);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
