/**
 * llama.cpp binary manager for the MoulSot (Qwen3-ASR) Darija engine.
 *
 * MoulSot is distributed as GGUF, which whisper.cpp cannot load. We use the
 * official llama.cpp `llama-mtmd-cli` build and verify every archive against a
 * pinned SHA-256 before extracting or executing it.
 *
 * Platform backends:
 * - macOS: the Metal-capable build (CPU mode uses `-ngl 0`).
 * - Windows/Linux with an NVIDIA GPU: CUDA build + bundled CUDA runtime.
 * - Otherwise: the CPU build.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { downloadFile, checkCancellation } from './download-file';
import { decideCaptionBackend, type CaptionBackend } from './caption-engine';

const BIN_VERSION = 'b11738';
const BIN_RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${BIN_VERSION}`;

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

interface ArchiveSpec {
  name: string;
  sha256: string;
}

type InstallKey = 'mac' | 'cpu' | 'cuda';

export interface LlamaBinary {
  cli: string;
  backend: CaptionBackend;
  libraryDirs: string[];
}

const WINDOWS_CPU: ArchiveSpec = {
  name: `llama-${BIN_VERSION}-bin-win-cpu-x64.zip`,
  sha256: 'ccb97cc6c188425c0f56679d7ba433e05e8c1b7e0201ad3134f2f876db362b75'
};
const WINDOWS_CUDA: ArchiveSpec[] = [
  {
    name: `llama-${BIN_VERSION}-bin-win-cuda-12.4-x64.zip`,
    sha256: 'b9d4f37d8ef9757c7f590852138c7334889a9a47b00802c76e5a64be644c6cfe'
  },
  {
    name: `cudart-llama-${BIN_VERSION}-bin-win-cuda-12.4-x64.zip`,
    sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'
  }
];
const LINUX_CPU_X64: ArchiveSpec = {
  name: `llama-${BIN_VERSION}-bin-ubuntu-x64.tar.gz`,
  sha256: '4d4101b8a51eace7fee64f6dbaec8e536221567ef6d8b99563345cbab7b4f2a8'
};
const LINUX_CPU_ARM64: ArchiveSpec = {
  name: `llama-${BIN_VERSION}-bin-ubuntu-arm64.tar.gz`,
  sha256: '1ee64aea979ef9219c8d1e38374265313c45013ee7cd57047a74a6a588d99f21'
};
const LINUX_CUDA_X64: ArchiveSpec[] = [
  {
    name: `llama-${BIN_VERSION}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
    sha256: '6bed1e4e7d0744952da044eb0950bb4b2226f5b2a7db1c1d20653536acb4528d'
  },
  {
    name: `cudart-llama-${BIN_VERSION}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
    sha256: 'f0565fb68f090ccccb045055efda038b576f1bfb2b57d31c2c33ce91d555681c'
  }
];

export type LlamaProgressCallback = (progress: {
  status: string;
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
}) => void;

function hasNvidiaGpu(): boolean {
  if (isMac) return false;
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/** Both mac backends share one Metal-capable archive. */
function getInstallKey(backend: CaptionBackend): InstallKey {
  if (isMac) return 'mac';
  return backend === 'cuda' ? 'cuda' : 'cpu';
}

function getArchives(key: InstallKey): ArchiveSpec[] {
  if (key === 'mac') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return [{
      name: `llama-${BIN_VERSION}-bin-macos-${arch}.tar.gz`,
      sha256: arch === 'arm64'
        ? '412e1aa1806d798cd4b74a0a3901f2703d0ec230fd0eeaae1d3adf5bcbb0e078'
        : '5d451ccb09ffa597e6afd3a30e43d710612d636358dac93d3a8a255002dd634a'
    }];
  }
  if (isWindows) {
    if (process.arch !== 'x64') return [];
    return key === 'cuda' ? WINDOWS_CUDA : [WINDOWS_CPU];
  }
  if (process.arch === 'arm64') return key === 'cuda' ? [] : [LINUX_CPU_ARM64];
  return key === 'cuda' ? LINUX_CUDA_X64 : [LINUX_CPU_X64];
}

export function getLlamaBinDir(): string {
  const dir = path.join(app.getPath('userData'), 'llama-bin');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getInstallDir(key: InstallKey): string {
  return path.join(getLlamaBinDir(), `${BIN_VERSION}-${key}`);
}

function getMarkerPath(key: InstallKey): string {
  return path.join(getInstallDir(key), '.complete');
}

function findCli(dir: string, depth = 0): string | null {
  if (!fs.existsSync(dir) || depth > 3) return null;
  const exe = isWindows ? 'llama-mtmd-cli.exe' : 'llama-mtmd-cli';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === exe) return full;
    if (entry.isDirectory()) {
      const found = findCli(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Directories containing runtime libraries, added to PATH/LD_LIBRARY_PATH. */
function findLibraryDirs(dir: string): string[] {
  const dirs = new Set<string>();
  const visit = (current: string, depth: number) => {
    if (!fs.existsSync(current) || depth > 4) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (/\.(dll|so|dylib)(\.\d+)*$/i.test(entry.name)) {
        dirs.add(current);
      }
    }
  };
  visit(dir, 0);
  return [...dirs];
}

export function isLlamaInstalled(backend: CaptionBackend): boolean {
  return findCli(getInstallDir(getInstallKey(backend))) !== null;
}

export function getLlamaCliPath(backend: CaptionBackend): string | null {
  return findCli(getInstallDir(getInstallKey(backend)));
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function extractArchive(archive: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  if (archive.endsWith('.zip')) {
    const escapedArchive = archive.replace(/'/g, "''");
    const escapedDestination = destination.replace(/'/g, "''");
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`
      ],
      { timeout: 600_000 }
    );
    return;
  }
  execFileSync('tar', ['-xzf', archive, '-C', destination], { timeout: 600_000 });
}

async function ensureInstall(
  key: InstallKey,
  backend: CaptionBackend,
  onProgress?: LlamaProgressCallback,
  signal?: AbortSignal
): Promise<LlamaBinary> {
  checkCancellation(signal);
  const installDir = getInstallDir(key);
  const existing = findCli(installDir);
  if (existing && fs.existsSync(getMarkerPath(key))) {
    return {
      cli: existing,
      backend,
      libraryDirs: findLibraryDirs(installDir)
    };
  }

  const archives = getArchives(key);
  if (archives.length === 0) {
    throw new Error(`No llama.cpp build available for ${process.platform}/${process.arch}`);
  }

  // A partial or incomplete extraction is rebuilt from scratch.
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });

  for (let i = 0; i < archives.length; i++) {
    const archive = archives[i];
    checkCancellation(signal);
    const archivePath = path.join(getLlamaBinDir(), archive.name);
    const label = backend === 'cuda'
      ? `Downloading Darija GPU engine (${i + 1}/${archives.length})`
      : 'Downloading Darija engine (one-time setup)';

    onProgress?.({ status: 'downloading-bin', progress: 0, file: label });
    await downloadFile(
      `${BIN_RELEASE_BASE}/${archive.name}`,
      archivePath,
      (progress) => onProgress?.({
        status: 'downloading-bin',
        progress: progress.progress,
        file: label,
        loaded: progress.loaded,
        total: progress.total
      }),
      archive.name,
      signal
    );
    checkCancellation(signal);

    const actual = await sha256File(archivePath);
    if (actual !== archive.sha256) {
      fs.rmSync(archivePath, { force: true });
      throw new Error(`Checksum mismatch for ${archive.name} (expected ${archive.sha256}, got ${actual})`);
    }

    checkCancellation(signal);
    extractArchive(archivePath, installDir);
    fs.rmSync(archivePath, { force: true });
  }

  const cli = findCli(installDir);
  if (!cli) throw new Error('llama-mtmd-cli was not found after extraction');
  if (!isWindows) {
    try { fs.chmodSync(cli, 0o755); } catch {}
  }
  fs.writeFileSync(getMarkerPath(key), `${BIN_VERSION}\n${backend}\n`, 'utf-8');

  onProgress?.({ status: 'ready', progress: 100 });
  console.log(`[LlamaBin] Using ${cli} (${backend})`);
  return {
    cli,
    backend,
    libraryDirs: findLibraryDirs(installDir)
  };
}

/**
 * Ensure a working llama.cpp CLI for the requested engine preference.
 * Requests for CUDA fall back to CPU when no NVIDIA GPU or CUDA archive is
 * available, so a build never fails just because a GPU is missing.
 */
export async function ensureLlamaBinary(
  preference: 'auto' | 'cuda' | 'cpu',
  onProgress?: LlamaProgressCallback,
  signal?: AbortSignal
): Promise<LlamaBinary> {
  checkCancellation(signal);
  let backend = decideCaptionBackend(preference, process.platform, hasNvidiaGpu());
  let key = getInstallKey(backend);

  if (getArchives(key).length === 0) {
    console.warn(`[LlamaBin] No ${backend} build for ${process.platform}/${process.arch} — using CPU`);
    backend = 'cpu';
    key = getInstallKey(backend);
  }

  try {
    return await ensureInstall(key, backend, onProgress, signal);
  } catch (error) {
    checkCancellation(signal);
    if (key !== 'cuda') throw error;
    console.warn('[LlamaBin] CUDA engine unavailable — falling back to CPU:', error);
    onProgress?.({ status: 'downloading-bin', progress: 0, file: 'GPU engine unavailable — preparing CPU engine' });
    return ensureInstall('cpu', 'cpu', onProgress, signal);
  }
}

export function clearLlamaBinary(backend?: CaptionBackend): void {
  const keys: InstallKey[] = backend ? [getInstallKey(backend)] : isMac ? ['mac'] : ['cpu', 'cuda'];
  for (const key of new Set(keys)) {
    const dir = getInstallDir(key);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
