/**
 * Video Compressor Module
 * Hardware-accelerated HEVC compression using FFmpeg.
 * Supports: NVIDIA NVENC/CUDA, Apple VideoToolbox, AMD AMF, Intel QSV, CPU libx265.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

export type SourceType = 'file' | 'folder';
export type CompressionQuality = 'high' | 'balanced' | 'fast';
export type HevcEncoder = 'hevc_nvenc' | 'hevc_videotoolbox' | 'hevc_amf' | 'hevc_qsv' | 'libx265';

export interface CompressionSettings {
  encoder: 'auto' | HevcEncoder;
  quality: CompressionQuality;
  outputFolder?: string;
  sourcePath?: string;
  sourceType?: SourceType;
}

export interface VideoFile {
  path: string;
  name: string;
  size: number;
  resolution?: {
    width: number;
    height: number;
  };
}

export interface CompressionSource {
  sourcePath: string;
  sourceType: SourceType;
  sourceName: string;
  outputFolder: string;
  files: VideoFile[];
}

export interface CompressionProgress {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  progress: number;
  overallProgress?: number;
  fps?: number;
  time?: string;
  speed?: string;
  status: 'queued' | 'analyzing' | 'compressing' | 'completed' | 'error' | 'skipped' | 'cancelled';
  error?: string;
  encoderName?: string;
  encoder?: HevcEncoder;
  isHardwareAccelerated?: boolean;
  fallbackUsed?: boolean;
}

export interface CompressionResult {
  success: boolean;
  skipped?: boolean;
  canceled?: boolean;
  inputPath: string;
  outputPath: string;
  outputName?: string;
  inputSize: number;
  outputSize: number;
  compressionRatio: number;
  duration?: number;
  elapsedMs?: number;
  encoder?: HevcEncoder;
  encoderName?: string;
  isHardwareAccelerated?: boolean;
  fallbackUsed?: boolean;
  error?: string;
}

export interface HardwareInfo {
  available: boolean;
  type: 'nvenc' | 'videotoolbox' | 'amf' | 'qsv' | 'none';
  encoder: HevcEncoder;
  name: string;
  systemName: string;
  encoderName: string;
  isHardwareAccelerated: boolean;
  fallbackUsed?: boolean;
}

export interface CompressionStats {
  totalFiles: number;
  completed: number;
  failed: number;
  skipped: number;
  totalInputSize: number;
  totalOutputSize: number;
  bytesSaved: number;
  totalCompressionRatio: number;
  elapsedMs: number;
}

export interface CompressionBatchResult {
  results: CompressionResult[];
  stats: CompressionStats;
  hardware: HardwareInfo;
  outputFolder: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  fallbackUsed: boolean;
  canceled: boolean;
}

interface VideoInfo {
  width: number;
  height: number;
  duration?: number;
  bitRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
}

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts', '.mpg', '.mpeg'];

const QUALITY_PRESETS: Record<CompressionQuality, { cq: number; crf: number; preset: string; sourceRatio: number }> = {
  high: { cq: 18, crf: 17, preset: 'slow', sourceRatio: 0.92 },
  balanced: { cq: 20, crf: 19, preset: 'medium', sourceRatio: 0.86 },
  fast: { cq: 23, crf: 21, preset: 'fast', sourceRatio: 0.78 }
};

const RESOLUTION_SETTINGS: Record<number, { cqOffset: number; crfOffset: number }> = {
  2160: { cqOffset: -1, crfOffset: -1 },
  1440: { cqOffset: 0, crfOffset: 0 },
  1080: { cqOffset: 0, crfOffset: 0 },
  720: { cqOffset: 1, crfOffset: 1 }
};

const VIDEOTOOLBOX_BITRATE_TARGETS: Record<number, Record<CompressionQuality, number>> = {
  2160: { high: 45_000_000, balanced: 35_000_000, fast: 28_000_000 },
  1440: { high: 28_000_000, balanced: 22_000_000, fast: 16_000_000 },
  1080: { high: 16_000_000, balanced: 12_000_000, fast: 9_000_000 },
  720: { high: 8_000_000, balanced: 6_000_000, fast: 4_500_000 },
  480: { high: 5_000_000, balanced: 3_500_000, fast: 2_500_000 }
};

class VideoCompressor extends EventEmitter {
  private isRunning = false;
  private shouldStop = false;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private encoderListCache: string | null = null;
  private currentStats: CompressionStats = {
    totalFiles: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    totalInputSize: 0,
    totalOutputSize: 0,
    bytesSaved: 0,
    totalCompressionRatio: 0,
    elapsedMs: 0
  };

  private getBundledBinaryPath(binaryName: string): string | null {
    const platform = process.platform;
    const isWindows = platform === 'win32';
    const isMac = platform === 'darwin';
    const arch = process.arch;
    const binaryFile = isWindows ? `${binaryName}.exe` : binaryName;
    const appRoot = process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : process.cwd();

    if (binaryName === 'ffmpeg') {
      const possiblePaths = [
        path.join(process.cwd(), 'node_modules', 'ffmpeg-static', binaryFile),
        path.join(appRoot, 'node_modules', 'ffmpeg-static', binaryFile),
        path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', binaryFile),
        path.join(__dirname, '..', '..', '..', 'node_modules', 'ffmpeg-static', binaryFile),
      ];

      for (const p of possiblePaths) {
        try {
          if (fs.existsSync(p)) {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
          }
        } catch {
          // Try the next candidate.
        }
      }
    } else if (binaryName === 'ffprobe') {
      const platformDir = isWindows ? 'win32' : isMac ? 'darwin' : 'linux';
      const archDir = arch === 'arm64' ? 'arm64' : 'x64';
      const possiblePaths = [
        path.join(process.cwd(), 'node_modules', 'ffprobe-static', 'bin', platformDir, archDir, binaryFile),
        path.join(appRoot, 'node_modules', 'ffprobe-static', 'bin', platformDir, archDir, binaryFile),
        path.join(__dirname, '..', '..', 'node_modules', 'ffprobe-static', 'bin', platformDir, archDir, binaryFile),
        path.join(__dirname, '..', '..', '..', 'node_modules', 'ffprobe-static', 'bin', platformDir, archDir, binaryFile),
      ];

      for (const p of possiblePaths) {
        try {
          if (fs.existsSync(p)) {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
          }
        } catch {
          // Try the next candidate.
        }
      }
    }

    return null;
  }

  private getFFmpegPath(): string {
    const bundledPath = this.getBundledBinaryPath('ffmpeg');
    if (bundledPath) return bundledPath;

    if (process.platform === 'darwin') {
      const paths = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    }

    return 'ffmpeg';
  }

  private getFFprobePath(): string {
    const bundledPath = this.getBundledBinaryPath('ffprobe');
    if (bundledPath) return bundledPath;

    if (process.platform === 'darwin') {
      const paths = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    }

    return 'ffprobe';
  }

  private async getEncoderList(): Promise<string> {
    if (this.encoderListCache) return this.encoderListCache;

    return new Promise((resolve) => {
      const ffmpeg = spawn(this.getFFmpegPath(), ['-encoders']);
      let output = '';

      ffmpeg.stdout.on('data', (data) => { output += data.toString(); });
      ffmpeg.stderr.on('data', (data) => { output += data.toString(); });
      ffmpeg.on('close', () => {
        this.encoderListCache = output;
        resolve(output);
      });
      ffmpeg.on('error', () => { resolve(''); });
    });
  }

  private async checkEncoder(encoder: string): Promise<boolean> {
    const output = await this.getEncoderList();
    return output.includes(encoder);
  }

  async detectHardware(): Promise<HardwareInfo> {
    const platform = process.platform;
    const isAppleSilicon = platform === 'darwin' && process.arch === 'arm64';

    if (platform === 'darwin' && await this.checkEncoder('hevc_videotoolbox')) {
      const systemName = isAppleSilicon ? 'Apple Silicon' : 'macOS';
      return {
        available: true,
        type: 'videotoolbox',
        encoder: 'hevc_videotoolbox',
        name: `${systemName} VideoToolbox HEVC`,
        systemName,
        encoderName: 'VideoToolbox HEVC',
        isHardwareAccelerated: true
      };
    }

    if (await this.checkEncoder('hevc_nvenc')) {
      return {
        available: true,
        type: 'nvenc',
        encoder: 'hevc_nvenc',
        name: 'NVIDIA CUDA/NVENC HEVC',
        systemName: 'NVIDIA CUDA',
        encoderName: 'NVENC HEVC',
        isHardwareAccelerated: true
      };
    }

    if (platform === 'win32' && await this.checkEncoder('hevc_amf')) {
      return {
        available: true,
        type: 'amf',
        encoder: 'hevc_amf',
        name: 'AMD AMF HEVC',
        systemName: 'AMD GPU',
        encoderName: 'AMF HEVC',
        isHardwareAccelerated: true
      };
    }

    if (await this.checkEncoder('hevc_qsv')) {
      return {
        available: true,
        type: 'qsv',
        encoder: 'hevc_qsv',
        name: 'Intel Quick Sync HEVC',
        systemName: 'Intel GPU',
        encoderName: 'Quick Sync HEVC',
        isHardwareAccelerated: true
      };
    }

    return this.getCpuHardwareInfo();
  }

  private getCpuHardwareInfo(fallbackUsed = false): HardwareInfo {
    return {
      available: true,
      type: 'none',
      encoder: 'libx265',
      name: fallbackUsed ? 'CPU libx265 HEVC fallback' : 'CPU libx265 HEVC',
      systemName: 'CPU',
      encoderName: 'libx265 HEVC',
      isHardwareAccelerated: false,
      fallbackUsed
    };
  }

  private async getVideoInfo(filePath: string): Promise<VideoInfo | null> {
    return new Promise((resolve) => {
      const ffprobe = spawn(this.getFFprobePath(), [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath
      ]);
      let output = '';

      ffprobe.stdout.on('data', (data) => { output += data.toString(); });
      ffprobe.on('close', () => {
        try {
          const data = JSON.parse(output);
          const streams = Array.isArray(data.streams) ? data.streams : [];
          const videoStream = streams.find((s: any) => s.codec_type === 'video');
          const audioStream = streams.find((s: any) => s.codec_type === 'audio');

          if (!videoStream) {
            resolve(null);
            return;
          }

          const streamDuration = videoStream.duration ? parseFloat(videoStream.duration) : undefined;
          const formatDuration = data.format?.duration ? parseFloat(data.format.duration) : undefined;
          const streamBitRate = videoStream.bit_rate ? parseInt(videoStream.bit_rate, 10) : undefined;
          const formatBitRate = data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : undefined;

          resolve({
            width: videoStream.width,
            height: videoStream.height,
            duration: streamDuration || formatDuration,
            bitRate: streamBitRate || formatBitRate,
            videoCodec: videoStream.codec_name,
            audioCodec: audioStream?.codec_name,
            hasAudio: Boolean(audioStream)
          });
        } catch {
          resolve(null);
        }
      });
      ffprobe.on('error', () => { resolve(null); });
    });
  }

  private getVideoToolboxTargetBitrate(height: number, quality: CompressionQuality, sourceBitrate?: number): number {
    const sortedResolutions = Object.keys(VIDEOTOOLBOX_BITRATE_TARGETS)
      .map(Number)
      .sort((a, b) => b - a);
    let defaultTarget = VIDEOTOOLBOX_BITRATE_TARGETS[480][quality];

    for (const res of sortedResolutions) {
      if (height >= res) {
        defaultTarget = VIDEOTOOLBOX_BITRATE_TARGETS[res][quality];
        break;
      }
    }

    if (!sourceBitrate || sourceBitrate <= 0) {
      return defaultTarget;
    }

    const sourceBasedTarget = Math.round(sourceBitrate * QUALITY_PRESETS[quality].sourceRatio);
    return Math.max(800_000, Math.min(defaultTarget, sourceBasedTarget));
  }

  private formatBitrate(bitsPerSecond: number): string {
    return `${Math.max(1, Math.round(bitsPerSecond / 1000))}k`;
  }

  private chooseSettings(height: number, encoder: HevcEncoder, quality: CompressionQuality, sourceBitrate?: number): string[] {
    const qualityPreset = QUALITY_PRESETS[quality];
    let cqOffset = 1;
    let crfOffset = 1;
    const sortedResolutions = Object.keys(RESOLUTION_SETTINGS)
      .map(Number)
      .sort((a, b) => b - a);

    for (const res of sortedResolutions) {
      if (height >= res) {
        cqOffset = RESOLUTION_SETTINGS[res].cqOffset;
        crfOffset = RESOLUTION_SETTINGS[res].crfOffset;
        break;
      }
    }

    const cq = Math.max(18, qualityPreset.cq + cqOffset);
    const crf = Math.max(16, qualityPreset.crf + crfOffset);
    const args: string[] = ['-c:v', encoder];

    if (encoder === 'hevc_nvenc') {
      const nvencPreset = quality === 'high' ? 'p7' : quality === 'balanced' ? 'p5' : 'p3';
      args.push('-preset:v', nvencPreset, '-tune', 'hq', '-rc', 'vbr', '-cq', cq.toString(), '-b:v', '0');
    } else if (encoder === 'hevc_videotoolbox') {
      const targetBitrate = this.getVideoToolboxTargetBitrate(height, quality, sourceBitrate);
      args.push(
        '-allow_sw', '0',
        '-b:v', this.formatBitrate(targetBitrate),
        '-maxrate', this.formatBitrate(Math.round(targetBitrate * 1.4)),
        '-bufsize', this.formatBitrate(targetBitrate * 2),
        '-prio_speed', quality === 'fast' ? '1' : '0'
      );
    } else if (encoder === 'hevc_amf') {
      const amfQuality = quality === 'high' ? 'quality' : quality === 'balanced' ? 'balanced' : 'speed';
      args.push('-quality', amfQuality, '-rc', 'cqp', '-qp_i', cq.toString(), '-qp_p', cq.toString());
    } else if (encoder === 'hevc_qsv') {
      args.push('-preset', qualityPreset.preset, '-global_quality', cq.toString());
    } else {
      args.push('-preset', qualityPreset.preset, '-crf', crf.toString(), '-x265-params', 'log-level=error');
    }

    args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
    return args;
  }

  private getOutputFolderForSource(sourcePath: string, sourceType?: SourceType): string {
    const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const resolvedType = sourceType || (stat?.isDirectory() ? 'folder' : 'file');
    const parentDir = path.dirname(sourcePath);
    const sourceName = resolvedType === 'folder'
      ? path.basename(sourcePath)
      : path.parse(sourcePath).name;

    return path.join(parentDir, `${sourceName} compress`);
  }

  private getAvailableOutputPath(outputDir: string, inputName: string): string {
    const parsed = path.parse(inputName);
    const baseName = parsed.name || inputName;
    let candidate = path.join(outputDir, `${baseName}.mp4`);
    let index = 2;

    while (fs.existsSync(candidate)) {
      candidate = path.join(outputDir, `${baseName} ${index}.mp4`);
      index++;
    }

    return candidate;
  }

  private isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
  }

  private emitProgress(progress: CompressionProgress): void {
    this.emit('progress', progress);
  }

  private async compressFile(
    inputPath: string,
    outputPath: string,
    hardware: HardwareInfo,
    quality: CompressionQuality,
    fileIndex: number,
    totalFiles: number,
    fallbackUsed: boolean
  ): Promise<CompressionResult> {
    const startedAt = Date.now();
    const inputSize = fs.statSync(inputPath).size;

    this.emitProgress({
      fileIndex,
      totalFiles,
      fileName: path.basename(inputPath),
      progress: 0,
      overallProgress: Math.round((fileIndex / totalFiles) * 100),
      status: 'analyzing',
      encoderName: hardware.name,
      encoder: hardware.encoder,
      isHardwareAccelerated: hardware.isHardwareAccelerated,
      fallbackUsed
    });

    const videoInfo = await this.getVideoInfo(inputPath);

    if (!videoInfo) {
      return {
        success: false,
        inputPath,
        outputPath,
        outputName: path.basename(outputPath),
        inputSize,
        outputSize: 0,
        compressionRatio: 0,
        elapsedMs: Date.now() - startedAt,
        encoder: hardware.encoder,
        encoderName: hardware.name,
        isHardwareAccelerated: hardware.isHardwareAccelerated,
        fallbackUsed,
        error: 'Could not read video info - ffprobe may not be available or this file is not a valid video'
      };
    }

    const args = [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-map_metadata', '0'
    ];

    args.push(...this.chooseSettings(videoInfo.height, hardware.encoder, quality, videoInfo.bitRate));

    if (videoInfo.hasAudio) {
      if (videoInfo.audioCodec === 'aac') {
        args.push('-c:a', 'copy');
      } else {
        args.push('-c:a', 'aac', '-b:a', '192k');
      }
    }

    args.push('-movflags', '+faststart', outputPath);

    return new Promise((resolve) => {
      const ffmpeg = spawn(this.getFFmpegPath(), args);
      this.activeProcess = ffmpeg;
      let errorOutput = '';
      const duration = videoInfo.duration || 0;

      ffmpeg.stderr.on('data', (data) => {
        const line = data.toString();
        errorOutput += line;

        if (line.includes('time=')) {
          const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          const fpsMatch = line.match(/fps=\s*(\d+)/);
          const speedMatch = line.match(/speed=\s*([\d.]+x)/);

          if (timeMatch && duration > 0) {
            const hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2]);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;
            const fileProgress = Math.min((currentTime / duration) * 100, 99);
            const overallProgress = ((fileIndex + (fileProgress / 100)) / totalFiles) * 100;

            this.emitProgress({
              fileIndex,
              totalFiles,
              fileName: path.basename(inputPath),
              progress: Math.round(fileProgress),
              overallProgress: Math.round(overallProgress),
              fps: fpsMatch ? parseInt(fpsMatch[1]) : undefined,
              time: timeMatch[0].replace('time=', ''),
              speed: speedMatch ? speedMatch[1] : undefined,
              status: 'compressing',
              encoderName: hardware.name,
              encoder: hardware.encoder,
              isHardwareAccelerated: hardware.isHardwareAccelerated,
              fallbackUsed
            });
          }
        }
      });

      ffmpeg.on('close', (code) => {
        this.activeProcess = null;

        if (this.shouldStop) {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          this.emitProgress({
            fileIndex,
            totalFiles,
            fileName: path.basename(inputPath),
            progress: 0,
            overallProgress: Math.round((fileIndex / totalFiles) * 100),
            status: 'cancelled',
            encoderName: hardware.name,
            encoder: hardware.encoder,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed
          });

          resolve({
            success: false,
            canceled: true,
            inputPath,
            outputPath,
            outputName: path.basename(outputPath),
            inputSize,
            outputSize: 0,
            compressionRatio: 0,
            elapsedMs: Date.now() - startedAt,
            encoder: hardware.encoder,
            encoderName: hardware.name,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed,
            error: 'Cancelled'
          });
          return;
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          const outputSize = fs.statSync(outputPath).size;
          const compressionRatio = ((inputSize - outputSize) / inputSize) * 100;

          this.emitProgress({
            fileIndex,
            totalFiles,
            fileName: path.basename(inputPath),
            progress: 100,
            overallProgress: Math.round(((fileIndex + 1) / totalFiles) * 100),
            status: 'completed',
            encoderName: hardware.name,
            encoder: hardware.encoder,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed
          });

          resolve({
            success: true,
            inputPath,
            outputPath,
            outputName: path.basename(outputPath),
            inputSize,
            outputSize,
            compressionRatio,
            duration: videoInfo.duration,
            elapsedMs: Date.now() - startedAt,
            encoder: hardware.encoder,
            encoderName: hardware.name,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed
          });
        } else {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          const error = errorOutput.slice(-1000) || `ffmpeg exited with code ${code}`;

          this.emitProgress({
            fileIndex,
            totalFiles,
            fileName: path.basename(inputPath),
            progress: 0,
            overallProgress: Math.round((fileIndex / totalFiles) * 100),
            status: 'error',
            error,
            encoderName: hardware.name,
            encoder: hardware.encoder,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed
          });

          resolve({
            success: false,
            inputPath,
            outputPath,
            outputName: path.basename(outputPath),
            inputSize,
            outputSize: 0,
            compressionRatio: 0,
            elapsedMs: Date.now() - startedAt,
            encoder: hardware.encoder,
            encoderName: hardware.name,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed,
            error
          });
        }
      });

      ffmpeg.on('error', (err) => {
        this.activeProcess = null;
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

        this.emitProgress({
          fileIndex,
          totalFiles,
          fileName: path.basename(inputPath),
          progress: 0,
          overallProgress: Math.round((fileIndex / totalFiles) * 100),
          status: 'error',
          error: err.message,
          encoderName: hardware.name,
          encoder: hardware.encoder,
          isHardwareAccelerated: hardware.isHardwareAccelerated,
          fallbackUsed
        });

        resolve({
          success: false,
          inputPath,
          outputPath,
          outputName: path.basename(outputPath),
          inputSize,
          outputSize: 0,
          compressionRatio: 0,
          elapsedMs: Date.now() - startedAt,
          encoder: hardware.encoder,
          encoderName: hardware.name,
          isHardwareAccelerated: hardware.isHardwareAccelerated,
          fallbackUsed,
          error: err.message
        });
      });
    });
  }

  async compressBatch(
    files: VideoFile[],
    settings: CompressionSettings
  ): Promise<CompressionBatchResult> {
    if (this.isRunning) {
      throw new Error('Compression already in progress');
    }

    this.isRunning = true;
    this.shouldStop = false;
    const startedAt = Date.now();
    const results: CompressionResult[] = [];
    const outputFolder = settings.outputFolder
      || (settings.sourcePath ? this.getOutputFolderForSource(settings.sourcePath, settings.sourceType) : path.join(path.dirname(files[0]?.path || process.cwd()), 'compress'));

    let hardware = settings.encoder === 'auto'
      ? await this.detectHardware()
      : await this.getHardwareInfoForEncoder(settings.encoder);

    this.emit('hardware-detected', hardware);

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    this.currentStats = {
      totalFiles: files.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      totalInputSize: 0,
      totalOutputSize: 0,
      bytesSaved: 0,
      totalCompressionRatio: 0,
      elapsedMs: 0
    };

    let fallbackUsed = false;

    try {
      for (let i = 0; i < files.length; i++) {
        if (this.shouldStop) break;

        const file = files[i];
        const outputPath = this.getAvailableOutputPath(outputFolder, file.name);

        this.emitProgress({
          fileIndex: i,
          totalFiles: files.length,
          fileName: file.name,
          progress: 0,
          overallProgress: Math.round((i / files.length) * 100),
          status: 'queued',
          encoderName: hardware.name,
          encoder: hardware.encoder,
          isHardwareAccelerated: hardware.isHardwareAccelerated,
          fallbackUsed
        });

        let result = await this.compressFile(
          file.path,
          outputPath,
          hardware,
          settings.quality,
          i,
          files.length,
          fallbackUsed
        );

        if (!result.success && !result.canceled && hardware.isHardwareAccelerated) {
          fallbackUsed = true;
          hardware = this.getCpuHardwareInfo(true);
          this.emit('hardware-detected', hardware);
          const fallbackOutputPath = this.getAvailableOutputPath(outputFolder, file.name);

          result = await this.compressFile(
            file.path,
            fallbackOutputPath,
            hardware,
            settings.quality,
            i,
            files.length,
            fallbackUsed
          );
        }

        results.push(result);

        if (result.success) {
          this.currentStats.completed++;
          this.currentStats.totalInputSize += result.inputSize;
          this.currentStats.totalOutputSize += result.outputSize;
        } else if (result.canceled) {
          this.currentStats.skipped++;
        } else {
          this.currentStats.failed++;
        }

        this.currentStats.bytesSaved = this.currentStats.totalInputSize - this.currentStats.totalOutputSize;
        this.currentStats.totalCompressionRatio = this.currentStats.totalInputSize > 0
          ? (this.currentStats.bytesSaved / this.currentStats.totalInputSize) * 100
          : 0;
        this.currentStats.elapsedMs = Date.now() - startedAt;
        this.emit('stats-update', this.currentStats);

        if (result.canceled) break;
      }
    } finally {
      const endedAt = Date.now();
      this.currentStats.elapsedMs = endedAt - startedAt;
      this.isRunning = false;
      this.activeProcess = null;

      const batchResult: CompressionBatchResult = {
        results,
        stats: { ...this.currentStats },
        hardware,
        outputFolder,
        startedAt,
        endedAt,
        elapsedMs: endedAt - startedAt,
        fallbackUsed,
        canceled: this.shouldStop
      };

      this.emit('complete', batchResult);
      return batchResult;
    }
  }

  private async getHardwareInfoForEncoder(encoder: HevcEncoder): Promise<HardwareInfo> {
    if (encoder === 'libx265') return this.getCpuHardwareInfo();
    if (encoder === 'hevc_videotoolbox') {
      const systemName = process.arch === 'arm64' ? 'Apple Silicon' : 'macOS';
      return {
        available: await this.checkEncoder(encoder),
        type: 'videotoolbox',
        encoder,
        name: `${systemName} VideoToolbox HEVC`,
        systemName,
        encoderName: 'VideoToolbox HEVC',
        isHardwareAccelerated: true
      };
    }
    if (encoder === 'hevc_nvenc') {
      return {
        available: await this.checkEncoder(encoder),
        type: 'nvenc',
        encoder,
        name: 'NVIDIA CUDA/NVENC HEVC',
        systemName: 'NVIDIA CUDA',
        encoderName: 'NVENC HEVC',
        isHardwareAccelerated: true
      };
    }
    if (encoder === 'hevc_amf') {
      return {
        available: await this.checkEncoder(encoder),
        type: 'amf',
        encoder,
        name: 'AMD AMF HEVC',
        systemName: 'AMD GPU',
        encoderName: 'AMF HEVC',
        isHardwareAccelerated: true
      };
    }
    return {
      available: await this.checkEncoder(encoder),
      type: 'qsv',
      encoder,
      name: 'Intel Quick Sync HEVC',
      systemName: 'Intel GPU',
      encoderName: 'Quick Sync HEVC',
      isHardwareAccelerated: true
    };
  }

  stop(): void {
    this.shouldStop = true;
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill('SIGTERM');
    }
  }

  isCompressing(): boolean {
    return this.isRunning;
  }

  getStats(): CompressionStats {
    return { ...this.currentStats };
  }

  scanSource(sourcePath: string): CompressionSource {
    if (!fs.existsSync(sourcePath)) {
      return {
        sourcePath,
        sourceType: 'folder',
        sourceName: path.basename(sourcePath),
        outputFolder: this.getOutputFolderForSource(sourcePath, 'folder'),
        files: []
      };
    }

    const stats = fs.statSync(sourcePath);
    const sourceType: SourceType = stats.isDirectory() ? 'folder' : 'file';
    const sourceName = sourceType === 'folder' ? path.basename(sourcePath) : path.parse(sourcePath).name;
    const outputFolder = this.getOutputFolderForSource(sourcePath, sourceType);
    const files = sourceType === 'folder'
      ? this.scanDirectory(sourcePath)
      : this.isVideoFile(sourcePath)
        ? [{ path: sourcePath, name: path.basename(sourcePath), size: stats.size }]
        : [];

    return {
      sourcePath,
      sourceType,
      sourceName,
      outputFolder,
      files
    };
  }

  scanDirectory(dirPath: string): VideoFile[] {
    const files: VideoFile[] = [];

    if (!fs.existsSync(dirPath)) {
      return files;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(dirPath, entry.name);
        if (this.isVideoFile(filePath)) {
          const stats = fs.statSync(filePath);
          files.push({
            path: filePath,
            name: entry.name,
            size: stats.size
          });
        }
      }
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static formatDuration(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  async checkFFmpeg(): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpeg = spawn(this.getFFmpegPath(), ['-version']);
      ffmpeg.on('close', (code) => {
        resolve(code === 0);
      });
      ffmpeg.on('error', () => {
        resolve(false);
      });
    });
  }
}

export const videoCompressor = new VideoCompressor();
export default videoCompressor;
