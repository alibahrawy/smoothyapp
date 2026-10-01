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
import { downloadFile, checkCancellation } from './download-file';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

export type WhisperVariant = 'cuda' | 'cpu' | 'metal';

const BIN_RELEASE_BASE =
  'https://github.com/alibahrawy/smoothyapp/releases/download/whisper-cpp-bins-v1.0.0';

// Fallback mirror (the source these binaries were mirrored from). Used when an
// asset is missing from our own release — e.g. the macOS builds.
const UPSTREAM_BIN_RELEASE_BASE =
  'https://github.com/sjoerdteunisse/whisper.cpp/releases/download/v1.0.0';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/**
 * SHA-256 of every asset we are willing to execute, keyed by filename. These
 * are the digests published by the GitHub release that hosts each archive.
 * Downloads are verified against this map before extraction; an asset without
 * a pinned digest is refused rather than run.
 */
const SHA256_BY_ASSET: Record<string, string> = {
  'whisper-cpp-win32-x64-cpu.zip':
    '80f6b6481794825f65043001e408e70aea4257918b15906b7e070d2c7b205da5',
  'whisper-cpp-win32-x64-cuda.zip':
    '8526fec5594bfd0dfbefcfe1036a3a2f0dd02630760fd9a0418b8b96f4c1be2d',
  'whisper-cpp-darwin-arm64.zip':
    'd033bd3f590cad50f39957bf86354f87b44394cb001e3f78a7b47264358103e3',
  'whisper-cpp-darwin-x64.zip':
    'f0f2ab6c2e92b7022ac02f0759a7a38f3ea110764e00b05a6f0d6c1dcadd571c',
  'whisper-cpp-linux-x64-cpu.zip':
    'e59d97d05bf7fc0361ad621e2a08e9541862f80dc071b265b2fa6d0ff3d85c08',
  'whisper-cpp-linux-x64-cuda.zip':
    '286ad85d70ef9dd753b313f5d82c2ee3ce9015a1286e523f029fe215fdd7da61',
};

/** Hash a file without loading it fully into memory. */
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Asset filename for a variant on the current platform. */
function getAssetName(variant: WhisperVariant): string | null {
  const platform = isMac ? 'darwin' : isWindows ? 'win32' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  // Only the variants we mirror are listed.
  if (platform === 'win32' && arch === 'x64') {
    if (variant === 'cuda') return 'whisper-cpp-win32-x64-cuda.zip';
    if (variant === 'cpu') return 'whisper-cpp-win32-x64-cpu.zip';
  }
  if (platform === 'darwin' && arch === 'arm64' && (variant === 'metal' || variant === 'cpu')) {
    // Apple Silicon ships one Metal-capable binary; CPU mode reuses it with
    // `-ng` (no-GPU), so there is no separate CPU download.
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

/**
 * User-chosen engine. 'cuda' means "force GPU" and resolves to whatever GPU
 * backend this machine actually has (CUDA on Windows/Linux with an NVIDIA card,
 * Metal on Apple Silicon). 'cpu' forces CPU. 'auto' picks the best available.
 */
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
    // Forced GPU: use this machine's actual GPU backend (CUDA on Windows/Linux
    // with an NVIDIA card, Metal on Apple Silicon), with CPU as a safety net so
    // a forced choice never blocks transcription entirely.
    const gpu = getPreferredVariant();
    return gpu === 'cpu' ? ['cpu'] : [gpu, 'cpu'];
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
  onProgress?: BinProgressCallback,
  signal?: AbortSignal
): Promise<string> {
  checkCancellation(signal);
  const existing = findExe(getVariantDir(variant), variant);
  if (existing) return existing;

  const asset = getAssetName(variant);
  if (!asset) {
    throw new Error(`No whisper.cpp binary available for ${process.platform}/${process.arch} (${variant})`);
  }

  const urls = [
    `${BIN_RELEASE_BASE}/${asset}`,
    `${UPSTREAM_BIN_RELEASE_BASE}/${asset}`
  ];
  const variantDir = getVariantDir(variant);
  const zipPath = path.join(getBinDir(), asset);

  if (onProgress) {
    onProgress({ status: 'downloading', progress: 0, file: asset });
  }

  const expectedSha256 = SHA256_BY_ASSET[asset];
  if (!expectedSha256) {
    throw new Error(`No pinned checksum for ${asset}; refusing to run an unverified binary`);
  }

  let lastError: unknown = null;
  for (const url of urls) {
    try {
      await downloadFile(url, zipPath, onProgress, asset, signal);
      checkCancellation(signal);

      // Verify the archive before extracting or executing anything from it.
      const actualSha256 = await sha256File(zipPath);
      if (actualSha256 !== expectedSha256) {
        fs.rmSync(zipPath, { force: true });
        throw new Error(
          `Checksum mismatch for ${asset} (expected ${expectedSha256}, got ${actualSha256})`
        );
      }

      checkCancellation(signal);
      extractZip(zipPath, variantDir);
      checkCancellation(signal);
      fs.rmSync(zipPath, { force: true });

      const exe = findExe(variantDir, variant);
      if (!exe) throw new Error('Executable not found after extraction');
      if (!isWindows) {
        try { fs.chmodSync(exe, 0o755); } catch {}
      }
      if (onProgress) onProgress({ status: 'ready', progress: 100 });
      return exe;
    } catch (err) {
      checkCancellation(signal);
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
