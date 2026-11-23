/**
 * Media Encoder, Video Compressor & Audio Extractor
 * Supports:
 * - Compress: hardware-accelerated HEVC (H.265) MP4 compression
 * - Convert Video: WebM, MKV, AVI, MOV, FLV, WMV, AV1, HEVC, etc. -> MP4 (H.264), MP4 (HEVC), MOV (ProRes 422), WebM (VP9), MP4 Remux
 * - Extract Audio: extract/convert audio from any video or audio file -> MP3, WAV, M4A (AAC), FLAC
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { getFFmpegPath, getFFprobePath } from '../ffmpeg-path';

export type SourceType = 'file' | 'folder' | 'files';
export type EncoderMode = 'compress' | 'convert' | 'extract_audio';
export type CompressionQuality = 'high' | 'balanced' | 'fast';
export type VideoOutputFormat = 'mp4_h264' | 'mp4_hevc' | 'mov_prores' | 'webm_vp9' | 'mp4_remux';
export type AudioOutputFormat = 'mp3' | 'wav' | 'm4a' | 'flac';
export type AudioBitrate = '320k' | '192k' | '128k';
export type TargetResolution = 'original' | '2160' | '1080' | '720' | '480';
export type TargetFps = 'original' | '60' | '30' | '24';

export type HevcEncoder = 'hevc_nvenc' | 'hevc_videotoolbox' | 'hevc_amf' | 'hevc_qsv' | 'libx265';
export type H264Encoder = 'h264_nvenc' | 'h264_videotoolbox' | 'h264_amf' | 'h264_qsv' | 'libx264';
export type ProResEncoder = 'prores_videotoolbox' | 'prores_ks';
export type MediaEncoderId =
  | HevcEncoder
  | H264Encoder
  | ProResEncoder
  | 'libvpx-vp9'
  | 'copy'
  | 'libmp3lame'
  | 'pcm_s16le'
  | 'aac'
  | 'flac';

export type HardwareCodecTarget = 'hevc' | 'h264' | 'prores' | 'vp9' | 'remux' | 'audio';

export interface CompressionSettings {
  mode?: EncoderMode;
  videoFormat?: VideoOutputFormat;
  audioFormat?: AudioOutputFormat;
  audioBitrate?: AudioBitrate;
  resolution?: TargetResolution;
  fps?: TargetFps;
  muteAudio?: boolean;
  encoder: 'auto' | MediaEncoderId;
  quality: CompressionQuality;
  outputFolder?: string;
  sourcePath?: string;
  sourceType?: SourceType;
}

export interface MediaProbeInfo {
  width?: number;
  height?: number;
  duration?: number;
  bitRate?: number;
  fps?: number;
  videoCodec?: string;
  pixFmt?: string;
  audioCodec?: string;
  audioChannels?: number;
  audioSampleRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  container?: string;
}

export interface VideoFile {
  path: string;
  name: string;
  size: number;
  resolution?: {
    width: number;
    height: number;
  };
  probe?: MediaProbeInfo;
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
  encoder?: MediaEncoderId;
  isHardwareAccelerated?: boolean;
  fallbackUsed?: boolean;
  mode?: EncoderMode;
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
  encoder?: MediaEncoderId;
  encoderName?: string;
  isHardwareAccelerated?: boolean;
  fallbackUsed?: boolean;
  mode?: EncoderMode;
  outputFormat?: string;
  validationError?: boolean;
  error?: string;
}

export interface HardwareInfo {
  available: boolean;
  type: 'nvenc' | 'videotoolbox' | 'amf' | 'qsv' | 'none';
  encoder: MediaEncoderId;
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
  mode: EncoderMode;
  outputFormat: string;
}

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts',
  '.mpg', '.mpeg', '.flv', '.wmv', '.asf', '.ogv', '.ts', '.vob',
  '.3gp', '.3g2', '.f4v', '.mxf', '.rm', '.rmvb', '.divx',
  '.hevc', '.h265', '.264', '.av1', '.y4m', '.gif'
];

export const AUDIO_EXTENSIONS = [
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.wma', '.aiff', '.aif', '.caf', '.amr', '.ac3', '.mka'
];

export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

const MP4_REMUX_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'av1', 'mpeg2video', 'mjpeg']);
const MP4_REMUX_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);
const EFFICIENT_SOURCE_CODECS = new Set(['av1', 'hevc', 'vp9']);

const QUALITY_PRESETS: Record<CompressionQuality, { cq: number; crf: number; h264Crf: number; vp9Crf: number; vp9CpuUsed: number; preset: string; sourceRatio: number }> = {
  high: { cq: 18, crf: 17, h264Crf: 18, vp9Crf: 24, vp9CpuUsed: 2, preset: 'slow', sourceRatio: 0.92 },
  balanced: { cq: 20, crf: 19, h264Crf: 20, vp9Crf: 30, vp9CpuUsed: 4, preset: 'medium', sourceRatio: 0.86 },
  fast: { cq: 23, crf: 21, h264Crf: 23, vp9Crf: 34, vp9CpuUsed: 5, preset: 'fast', sourceRatio: 0.78 }
};

const RESOLUTION_SETTINGS: Record<number, { cqOffset: number; crfOffset: number }> = {
  2160: { cqOffset: -1, crfOffset: -1 },
  1440: { cqOffset: 0, crfOffset: 0 },
  1080: { cqOffset: 0, crfOffset: 0 },
  720: { cqOffset: 1, crfOffset: 1 }
};

const VIDEOTOOLBOX_HEVC_TARGETS: Record<number, Record<CompressionQuality, number>> = {
  2160: { high: 45_000_000, balanced: 35_000_000, fast: 28_000_000 },
  1440: { high: 28_000_000, balanced: 22_000_000, fast: 16_000_000 },
  1080: { high: 16_000_000, balanced: 12_000_000, fast: 9_000_000 },
  720: { high: 8_000_000, balanced: 6_000_000, fast: 4_500_000 },
  480: { high: 5_000_000, balanced: 3_500_000, fast: 2_500_000 }
};

const VIDEOTOOLBOX_H264_TARGETS: Record<number, Record<CompressionQuality, number>> = {
  2160: { high: 55_000_000, balanced: 42_000_000, fast: 32_000_000 },
  1440: { high: 34_000_000, balanced: 26_000_000, fast: 19_000_000 },
  1080: { high: 20_000_000, balanced: 15_000_000, fast: 11_000_000 },
  720: { high: 10_000_000, balanced: 7_500_000, fast: 5_500_000 },
  480: { high: 6_000_000, balanced: 4_200_000, fast: 3_000_000 }
};

function parseDurationTag(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return undefined;
  const seconds = parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseFrameRate(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.includes('/')) return undefined;
  const [numStr, denStr] = raw.split('/');
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  const value = num / den;
  if (value <= 0 || value > 1000) return undefined;
  return Math.round(value * 100) / 100;
}

function normalizeMode(mode?: EncoderMode): EncoderMode {
  if (mode === 'convert' || mode === 'extract_audio') return mode;
  return 'compress';
}

function normalizeVideoFormat(format?: VideoOutputFormat): VideoOutputFormat {
  if (format === 'mp4_h264' || format === 'mp4_hevc' || format === 'mov_prores' || format === 'webm_vp9' || format === 'mp4_remux') {
    return format;
  }
  return 'mp4_h264';
}

function normalizeAudioFormat(format?: AudioOutputFormat): AudioOutputFormat {
  if (format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'flac') {
    return format;
  }
  return 'mp3';
}

function normalizeAudioBitrate(bitrate?: AudioBitrate): AudioBitrate {
  if (bitrate === '320k' || bitrate === '192k' || bitrate === '128k') return bitrate;
  return '192k';
}

function normalizeQuality(quality?: CompressionQuality): CompressionQuality {
  if (quality === 'high' || quality === 'balanced' || quality === 'fast') return quality;
  return 'high';
}

export function resolveMediaEncoderFeatureId(mode?: EncoderMode): 'compressor' | 'media_convert' | 'media_extract_audio' {
  const resolved = normalizeMode(mode);
  if (resolved === 'extract_audio') return 'media_extract_audio';
  if (resolved === 'convert') return 'media_convert';
  return 'compressor';
}

export function getOutputExtension(settings: Pick<CompressionSettings, 'mode' | 'videoFormat' | 'audioFormat'>): string {
  const mode = normalizeMode(settings.mode);
  if (mode === 'extract_audio') {
    const audioFormat = normalizeAudioFormat(settings.audioFormat);
    return `.${audioFormat}`;
  }
  if (mode === 'convert') {
    const videoFormat = normalizeVideoFormat(settings.videoFormat);
    if (videoFormat === 'mov_prores') return '.mov';
    if (videoFormat === 'webm_vp9') return '.webm';
    return '.mp4';
  }
  return '.mp4';
}

export function getCodecTargetForSettings(settings: Pick<CompressionSettings, 'mode' | 'videoFormat'>): HardwareCodecTarget {
  const mode = normalizeMode(settings.mode);
  if (mode === 'extract_audio') return 'audio';
  if (mode === 'compress') return 'hevc';
  const videoFormat = normalizeVideoFormat(settings.videoFormat);
  if (videoFormat === 'mp4_h264') return 'h264';
  if (videoFormat === 'mp4_hevc') return 'hevc';
  if (videoFormat === 'mov_prores') return 'prores';
  if (videoFormat === 'webm_vp9') return 'vp9';
  return 'remux';
}

export function getOutputFormatLabel(settings: Pick<CompressionSettings, 'mode' | 'videoFormat' | 'audioFormat'>): string {
  const mode = normalizeMode(settings.mode);
  if (mode === 'compress') return 'MP4 (HEVC)';
  if (mode === 'extract_audio') {
    const fmt = normalizeAudioFormat(settings.audioFormat);
    if (fmt === 'mp3') return 'MP3';
    if (fmt === 'wav') return 'WAV';
    if (fmt === 'm4a') return 'M4A (AAC)';
    return 'FLAC';
  }
  const fmt = normalizeVideoFormat(settings.videoFormat);
  if (fmt === 'mp4_h264') return 'MP4 (H.264)';
  if (fmt === 'mp4_hevc') return 'MP4 (HEVC)';
  if (fmt === 'mov_prores') return 'MOV (ProRes 422)';
  if (fmt === 'webm_vp9') return 'WebM (VP9)';
  return 'MP4 (Remux)';
}

export function buildVideoScaleFilter(
  width: number | undefined,
  height: number | undefined,
  resolution: TargetResolution | undefined,
  requireEvenDimensions: boolean
): string | null {
  const w = width && width > 0 ? width : 0;
  const h = height && height > 0 ? height : 0;

  if (resolution && resolution !== 'original') {
    const targetShortEdge = parseInt(resolution, 10);
    if (Number.isFinite(targetShortEdge) && targetShortEdge > 0 && w > 0 && h > 0) {
      const shortEdge = Math.min(w, h);
      if (shortEdge > targetShortEdge) {
        if (w >= h) {
          return `scale=-2:${targetShortEdge}`;
        }
        return `scale=${targetShortEdge}:-2`;
      }
    }
  }

  if (requireEvenDimensions && w > 0 && h > 0 && (w % 2 !== 0 || h % 2 !== 0)) {
    return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  }

  return null;
}

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

  private getFFmpegPath(): string {
    return getFFmpegPath();
  }

  private getFFprobePath(): string {
    return getFFprobePath();
  }

  private async getEncoderList(): Promise<string> {
    if (this.encoderListCache) return this.encoderListCache;

    return new Promise((resolve) => {
      const ffmpeg = spawn(this.getFFmpegPath(), ['-encoders'], { windowsHide: true });
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
    return new RegExp(`\\b${encoder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(output);
  }

  async detectHardware(target: HardwareCodecTarget = 'hevc'): Promise<HardwareInfo> {
    const platform = process.platform;
    const isAppleSilicon = platform === 'darwin' && process.arch === 'arm64';
    const macSystemName = isAppleSilicon ? 'Apple Silicon' : 'macOS';

    if (target === 'remux') {
      return {
        available: true,
        type: 'none',
        encoder: 'copy',
        name: 'Stream Copy (No Re-encode)',
        systemName: 'Direct Copy',
        encoderName: 'Stream Copy',
        isHardwareAccelerated: false
      };
    }

    if (target === 'audio') {
      return {
        available: true,
        type: 'none',
        encoder: 'libmp3lame',
        name: 'FFmpeg Audio Engine',
        systemName: 'CPU',
        encoderName: 'Audio Encoder',
        isHardwareAccelerated: false
      };
    }

    if (target === 'vp9') {
      return {
        available: true,
        type: 'none',
        encoder: 'libvpx-vp9',
        name: 'CPU libvpx-vp9 WebM',
        systemName: 'CPU',
        encoderName: 'libvpx-vp9',
        isHardwareAccelerated: false
      };
    }

    if (target === 'prores') {
      if (platform === 'darwin' && await this.checkEncoder('prores_videotoolbox')) {
        return {
          available: true,
          type: 'videotoolbox',
          encoder: 'prores_videotoolbox',
          name: `${macSystemName} VideoToolbox ProRes`,
          systemName: macSystemName,
          encoderName: 'VideoToolbox ProRes',
          isHardwareAccelerated: true
        };
      }
      return this.getCpuHardwareInfoForTarget('prores', false);
    }

    if (target === 'h264') {
      if (platform === 'darwin' && await this.checkEncoder('h264_videotoolbox')) {
        return {
          available: true,
          type: 'videotoolbox',
          encoder: 'h264_videotoolbox',
          name: `${macSystemName} VideoToolbox H.264`,
          systemName: macSystemName,
          encoderName: 'VideoToolbox H.264',
          isHardwareAccelerated: true
        };
      }
      if (await this.checkEncoder('h264_nvenc')) {
        return {
          available: true,
          type: 'nvenc',
          encoder: 'h264_nvenc',
          name: 'NVIDIA CUDA/NVENC H.264',
          systemName: 'NVIDIA CUDA',
          encoderName: 'NVENC H.264',
          isHardwareAccelerated: true
        };
      }
      if (platform === 'win32' && await this.checkEncoder('h264_amf')) {
        return {
          available: true,
          type: 'amf',
          encoder: 'h264_amf',
          name: 'AMD AMF H.264',
          systemName: 'AMD GPU',
          encoderName: 'AMF H.264',
          isHardwareAccelerated: true
        };
      }
      if (await this.checkEncoder('h264_qsv')) {
        return {
          available: true,
          type: 'qsv',
          encoder: 'h264_qsv',
          name: 'Intel Quick Sync H.264',
          systemName: 'Intel GPU',
          encoderName: 'Quick Sync H.264',
          isHardwareAccelerated: true
        };
      }
      return this.getCpuHardwareInfoForTarget('h264', false);
    }

    // Default: HEVC
    if (platform === 'darwin' && await this.checkEncoder('hevc_videotoolbox')) {
      return {
        available: true,
        type: 'videotoolbox',
        encoder: 'hevc_videotoolbox',
        name: `${macSystemName} VideoToolbox HEVC`,
        systemName: macSystemName,
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

    return this.getCpuHardwareInfoForTarget('hevc', false);
  }

  private getCpuHardwareInfoForTarget(target: HardwareCodecTarget, fallbackUsed = false): HardwareInfo {
    if (target === 'h264') {
      return {
        available: true,
        type: 'none',
        encoder: 'libx264',
        name: fallbackUsed ? 'CPU libx264 H.264 fallback' : 'CPU libx264 H.264',
        systemName: 'CPU',
        encoderName: 'libx264 H.264',
        isHardwareAccelerated: false,
        fallbackUsed
      };
    }
    if (target === 'prores') {
      return {
        available: true,
        type: 'none',
        encoder: 'prores_ks',
        name: fallbackUsed ? 'CPU ProRes 422 fallback' : 'CPU ProRes 422',
        systemName: 'CPU',
        encoderName: 'prores_ks',
        isHardwareAccelerated: false,
        fallbackUsed
      };
    }
    if (target === 'vp9') {
      return {
        available: true,
        type: 'none',
        encoder: 'libvpx-vp9',
        name: 'CPU libvpx-vp9 WebM',
        systemName: 'CPU',
        encoderName: 'libvpx-vp9',
        isHardwareAccelerated: false,
        fallbackUsed
      };
    }
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

  private getAudioHardwareInfo(audioFormat: AudioOutputFormat): HardwareInfo {
    const map: Record<AudioOutputFormat, { encoder: MediaEncoderId; name: string; encoderName: string }> = {
      mp3: { encoder: 'libmp3lame', name: 'MP3 (LAME)', encoderName: 'libmp3lame' },
      wav: { encoder: 'pcm_s16le', name: 'WAV (16-bit PCM)', encoderName: 'pcm_s16le' },
      m4a: { encoder: 'aac', name: 'M4A (AAC)', encoderName: 'aac' },
      flac: { encoder: 'flac', name: 'FLAC (Lossless)', encoderName: 'flac' }
    };
    const info = map[audioFormat];
    return {
      available: true,
      type: 'none',
      encoder: info.encoder,
      name: info.name,
      systemName: 'CPU',
      encoderName: info.encoderName,
      isHardwareAccelerated: false
    };
  }

  async probeFile(filePath: string): Promise<MediaProbeInfo | null> {
    return new Promise((resolve) => {
      const ffprobe = spawn(this.getFFprobePath(), [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath
      ], { windowsHide: true });
      let output = '';

      ffprobe.stdout.on('data', (data) => { output += data.toString(); });
      ffprobe.on('close', () => {
        try {
          const data = JSON.parse(output);
          const streams = Array.isArray(data.streams) ? data.streams : [];
          const videoStream = streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const audioStream = streams.find((s: any) => s.codec_type === 'audio');

          if (!videoStream && !audioStream) {
            resolve(null);
            return;
          }

          const streamDuration = videoStream?.duration
            ? parseFloat(videoStream.duration)
            : audioStream?.duration
              ? parseFloat(audioStream.duration)
              : undefined;
          const formatDuration = data.format?.duration ? parseFloat(data.format.duration) : undefined;
          const tagDuration =
            parseDurationTag(videoStream?.tags?.DURATION) ??
            parseDurationTag(videoStream?.tags?.duration) ??
            parseDurationTag(audioStream?.tags?.DURATION) ??
            parseDurationTag(audioStream?.tags?.duration) ??
            parseDurationTag(data.format?.tags?.DURATION);

          const duration = [streamDuration, formatDuration, tagDuration].find(
            (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
          );

          const streamBitRate = videoStream?.bit_rate ? parseInt(videoStream.bit_rate, 10) : undefined;
          const formatBitRate = data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : undefined;
          const bitRate = [streamBitRate, formatBitRate].find(
            (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
          );

          const fps = parseFrameRate(videoStream?.avg_frame_rate) ?? parseFrameRate(videoStream?.r_frame_rate);

          resolve({
            width: videoStream?.width,
            height: videoStream?.height,
            duration,
            bitRate,
            fps,
            videoCodec: videoStream?.codec_name,
            pixFmt: videoStream?.pix_fmt,
            audioCodec: audioStream?.codec_name,
            audioChannels: audioStream?.channels,
            audioSampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : undefined,
            hasVideo: Boolean(videoStream),
            hasAudio: Boolean(audioStream),
            container: data.format?.format_name
          });
        } catch {
          resolve(null);
        }
      });
      ffprobe.on('error', () => { resolve(null); });
    });
  }

  async probeFiles(filePaths: string[]): Promise<Record<string, MediaProbeInfo | null>> {
    const out: Record<string, MediaProbeInfo | null> = {};
    const unique = Array.from(new Set(filePaths)).slice(0, 100);
    const concurrency = 4;
    let cursor = 0;

    const worker = async () => {
      while (cursor < unique.length) {
        const idx = cursor++;
        const filePath = unique[idx];
        out[filePath] = await this.probeFile(filePath);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
    return out;
  }

  private getVideoToolboxTargetBitrate(
    codec: 'hevc' | 'h264',
    height: number,
    quality: CompressionQuality,
    sourceBitrate?: number,
    sourceCodec?: string
  ): number {
    const table = codec === 'h264' ? VIDEOTOOLBOX_H264_TARGETS : VIDEOTOOLBOX_HEVC_TARGETS;
    const sortedResolutions = Object.keys(table).map(Number).sort((a, b) => b - a);
    let defaultTarget = table[480][quality];

    for (const res of sortedResolutions) {
      if (height >= res) {
        defaultTarget = table[res][quality];
        break;
      }
    }

    if (!sourceBitrate || sourceBitrate <= 0) {
      return defaultTarget;
    }

    // When transcoding from a more efficient codec (AV1/HEVC/VP9) to H.264, allow headroom instead of starving bitrate.
    if (codec === 'h264' && sourceCodec && EFFICIENT_SOURCE_CODECS.has(sourceCodec.toLowerCase())) {
      const expandedTarget = Math.round(sourceBitrate * 1.6);
      const minFloor = Math.round(defaultTarget * 0.45);
      return Math.max(minFloor, Math.min(defaultTarget, expandedTarget));
    }

    const sourceBasedTarget = Math.round(sourceBitrate * QUALITY_PRESETS[quality].sourceRatio);
    return Math.max(800_000, Math.min(defaultTarget, sourceBasedTarget));
  }

  private formatBitrate(bitsPerSecond: number): string {
    return `${Math.max(1, Math.round(bitsPerSecond / 1000))}k`;
  }

  private getResolutionOffsets(height: number): { cqOffset: number; crfOffset: number } {
    let cqOffset = 1;
    let crfOffset = 1;
    const sortedResolutions = Object.keys(RESOLUTION_SETTINGS).map(Number).sort((a, b) => b - a);
    for (const res of sortedResolutions) {
      if (height >= res) {
        cqOffset = RESOLUTION_SETTINGS[res].cqOffset;
        crfOffset = RESOLUTION_SETTINGS[res].crfOffset;
        break;
      }
    }
    return { cqOffset, crfOffset };
  }

  private chooseVideoCodecArgs(
    height: number,
    encoder: MediaEncoderId,
    quality: CompressionQuality,
    sourceBitrate?: number,
    sourceCodec?: string
  ): string[] {
    const qualityPreset = QUALITY_PRESETS[quality];
    const { cqOffset, crfOffset } = this.getResolutionOffsets(height);
    const cq = Math.max(18, qualityPreset.cq + cqOffset);
    const crf = Math.max(16, qualityPreset.crf + crfOffset);
    const h264Crf = Math.max(17, qualityPreset.h264Crf + crfOffset);
    const args: string[] = ['-c:v', encoder];

    // HEVC encoders
    if (encoder === 'hevc_nvenc') {
      const nvencPreset = quality === 'high' ? 'p7' : quality === 'balanced' ? 'p5' : 'p3';
      args.push('-preset:v', nvencPreset, '-tune', 'hq', '-rc', 'vbr', '-cq', cq.toString(), '-b:v', '0');
      args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
      return args;
    }
    if (encoder === 'hevc_videotoolbox') {
      const targetBitrate = this.getVideoToolboxTargetBitrate('hevc', height, quality, sourceBitrate, sourceCodec);
      args.push(
        '-allow_sw', '0',
        '-b:v', this.formatBitrate(targetBitrate),
        '-maxrate', this.formatBitrate(Math.round(targetBitrate * 1.4)),
        '-bufsize', this.formatBitrate(targetBitrate * 2),
        '-prio_speed', quality === 'fast' ? '1' : '0',
        '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'
      );
      return args;
    }
    if (encoder === 'hevc_amf') {
      const amfQuality = quality === 'high' ? 'quality' : quality === 'balanced' ? 'balanced' : 'speed';
      args.push('-quality', amfQuality, '-rc', 'cqp', '-qp_i', cq.toString(), '-qp_p', cq.toString());
      args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
      return args;
    }
    if (encoder === 'hevc_qsv') {
      args.push('-preset', qualityPreset.preset, '-global_quality', cq.toString());
      args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
      return args;
    }
    if (encoder === 'libx265') {
      args.push('-preset', qualityPreset.preset, '-crf', crf.toString(), '-x265-params', 'log-level=error');
      args.push('-profile:v', 'main', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
      return args;
    }

    // H.264 encoders
    if (encoder === 'h264_nvenc') {
      const nvencPreset = quality === 'high' ? 'p7' : quality === 'balanced' ? 'p5' : 'p3';
      args.push('-preset:v', nvencPreset, '-tune', 'hq', '-rc', 'vbr', '-cq', (cq + 1).toString(), '-b:v', '0');
      args.push('-profile:v', 'high', '-pix_fmt', 'yuv420p');
      return args;
    }
    if (encoder === 'h264_videotoolbox') {
      const targetBitrate = this.getVideoToolboxTargetBitrate('h264', height, quality, sourceBitrate, sourceCodec);
      args.push(
        '-allow_sw', '0',
        '-b:v', this.formatBitrate(targetBitrate),
        '-maxrate', this.formatBitrate(Math.round(targetBitrate * 1.4)),
        '-bufsize', this.formatBitrate(targetBitrate * 2),
        '-prio_speed', quality === 'fast' ? '1' : '0',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p'
      );
      return args;
    }
    if (encoder === 'h264_amf') {
      const amfQuality = quality === 'high' ? 'quality' : quality === 'balanced' ? 'balanced' : 'speed';
      const qp = (cq + 1).toString();
      args.push('-quality', amfQuality, '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp);
      args.push('-profile:v', 'high', '-pix_fmt', 'yuv420p');
      return args;
    }
    if (encoder === 'h264_qsv') {
      args.push('-preset', qualityPreset.preset, '-global_quality', (cq + 1).toString());
      args.push('-profile:v', 'high', '-pix_fmt', 'yuv420p');
      return args;
    }
    if (encoder === 'libx264') {
      args.push('-preset', qualityPreset.preset, '-crf', h264Crf.toString(), '-profile:v', 'high', '-pix_fmt', 'yuv420p');
      return args;
    }

    // ProRes encoders
    if (encoder === 'prores_videotoolbox') {
      const profile = quality === 'high' ? 'hq' : quality === 'balanced' ? 'standard' : 'lt';
      args.push('-allow_sw', '0', '-profile:v', profile);
      return args;
    }
    if (encoder === 'prores_ks') {
      const profile = quality === 'high' ? '3' : quality === 'balanced' ? '2' : '1';
      args.push('-profile:v', profile, '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le');
      return args;
    }

    // WebM VP9
    if (encoder === 'libvpx-vp9') {
      args.push(
        '-crf', qualityPreset.vp9Crf.toString(),
        '-b:v', '0',
        '-deadline', 'good',
        '-cpu-used', qualityPreset.vp9CpuUsed.toString(),
        '-row-mt', '1',
        '-pix_fmt', 'yuv420p'
      );
      return args;
    }

    // Stream copy fallback
    return ['-c:v', 'copy'];
  }

  buildFFmpegArgs(
    inputPath: string,
    outputPath: string,
    mediaInfo: MediaProbeInfo,
    hardware: HardwareInfo,
    settings: CompressionSettings
  ): { args: string[]; error?: string } {
    const mode = normalizeMode(settings.mode);
    const quality = normalizeQuality(settings.quality);

    // 1. Audio extraction / conversion
    if (mode === 'extract_audio') {
      if (!mediaInfo.hasAudio) {
        return { args: [], error: 'No audio track found in this file' };
      }

      const audioFormat = normalizeAudioFormat(settings.audioFormat);
      const audioBitrate = normalizeAudioBitrate(settings.audioBitrate);
      const args = [
        '-hide_banner',
        '-y',
        '-i', inputPath,
        '-map', '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-map_metadata', '0'
      ];

      if (audioFormat === 'mp3') {
        args.push('-c:a', 'libmp3lame', '-b:a', audioBitrate, '-id3v2_version', '3');
      } else if (audioFormat === 'wav') {
        args.push('-c:a', 'pcm_s16le');
      } else if (audioFormat === 'm4a') {
        args.push('-c:a', 'aac', '-b:a', audioBitrate, '-movflags', '+faststart');
      } else {
        args.push('-c:a', 'flac', '-compression_level', '5');
      }

      args.push(outputPath);
      return { args };
    }

    // 2. Video compression or conversion
    if (!mediaInfo.hasVideo) {
      return { args: [], error: 'No video track found in this file (switch to Extract Audio for audio-only files)' };
    }

    const videoFormat: VideoOutputFormat = mode === 'compress'
      ? 'mp4_hevc'
      : normalizeVideoFormat(settings.videoFormat);

    // Remux (stream copy to MP4)
    if (videoFormat === 'mp4_remux') {
      const srcCodec = (mediaInfo.videoCodec || '').toLowerCase();
      if (!MP4_REMUX_VIDEO_CODECS.has(srcCodec)) {
        const displayCodec = srcCodec ? srcCodec.toUpperCase() : 'This codec';
        return {
          args: [],
          error: `${displayCodec} cannot be remuxed into MP4 without re-encoding. Choose MP4 (H.264) instead.`
        };
      }

      const args = [
        '-hide_banner',
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-sn',
        '-dn',
        '-map_metadata', '0',
        '-c:v', 'copy'
      ];

      if (srcCodec === 'hevc') {
        args.push('-tag:v', 'hvc1');
      }

      if (settings.muteAudio || !mediaInfo.hasAudio) {
        args.push('-an');
      } else {
        args.push('-map', '0:a?');
        const srcAudio = (mediaInfo.audioCodec || '').toLowerCase();
        if (MP4_REMUX_AUDIO_CODECS.has(srcAudio)) {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'aac', '-b:a', '192k');
        }
      }

      args.push('-movflags', '+faststart', outputPath);
      return { args };
    }

    // Transcode video
    const args = [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-sn',
      '-dn',
      '-map_metadata', '0'
    ];

    if (!settings.muteAudio && mediaInfo.hasAudio) {
      args.push('-map', '0:a?');
    } else {
      args.push('-an');
    }

    const requireEvenDimensions = videoFormat !== 'mov_prores';
    const scaleFilter = buildVideoScaleFilter(
      mediaInfo.width,
      mediaInfo.height,
      settings.resolution,
      requireEvenDimensions
    );
    if (scaleFilter) {
      args.push('-vf', scaleFilter);
    }

    if (settings.fps && settings.fps !== 'original') {
      args.push('-r', settings.fps, '-vsync', 'cfr');
    }

    const effectiveHeight =
      settings.resolution && settings.resolution !== 'original' && mediaInfo.height
        ? Math.min(mediaInfo.height, parseInt(settings.resolution, 10))
        : (mediaInfo.height || 1080);

    args.push(
      ...this.chooseVideoCodecArgs(
        effectiveHeight,
        hardware.encoder,
        quality,
        mediaInfo.bitRate,
        mediaInfo.videoCodec
      )
    );

    if (!settings.muteAudio && mediaInfo.hasAudio) {
      const srcAudio = (mediaInfo.audioCodec || '').toLowerCase();
      if (videoFormat === 'webm_vp9') {
        if (srcAudio === 'opus') {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'libopus', '-b:a', '128k');
        }
      } else if (videoFormat === 'mov_prores') {
        if (srcAudio === 'pcm_s16le' || srcAudio === 'pcm_s24le') {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'pcm_s16le');
        }
      } else {
        if (srcAudio === 'aac') {
          args.push('-c:a', 'copy');
        } else {
          args.push('-c:a', 'aac', '-b:a', '192k');
        }
      }
    }

    if (videoFormat === 'mp4_h264' || videoFormat === 'mp4_hevc' || videoFormat === 'mov_prores') {
      args.push('-movflags', '+faststart');
    }

    args.push(outputPath);
    return { args };
  }

  getOutputFolderForSource(sourcePath: string, sourceType?: SourceType, mode: EncoderMode = 'compress'): string {
    const resolvedMode = normalizeMode(mode);
    const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const resolvedType: SourceType = sourceType || (stat?.isDirectory() ? 'folder' : 'file');
    const parentDir = path.dirname(sourcePath);

    if (resolvedType === 'files') {
      const folderName =
        resolvedMode === 'extract_audio'
          ? 'Extracted audio'
          : resolvedMode === 'convert'
            ? 'Converted videos'
            : 'Compressed videos';
      return path.join(parentDir, folderName);
    }

    const sourceName = resolvedType === 'folder'
      ? path.basename(sourcePath)
      : path.parse(sourcePath).name;
    const suffix =
      resolvedMode === 'extract_audio'
        ? 'audio'
        : resolvedMode === 'convert'
          ? 'converted'
          : 'compress';

    return path.join(parentDir, `${sourceName} ${suffix}`);
  }

  private getAvailableOutputPath(outputDir: string, inputName: string, extension = '.mp4'): string {
    const parsed = path.parse(inputName);
    const baseName = parsed.name || inputName;
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    let candidate = path.join(outputDir, `${baseName}${ext}`);
    let index = 2;

    while (fs.existsSync(candidate)) {
      candidate = path.join(outputDir, `${baseName} ${index}${ext}`);
      index++;
    }

    return candidate;
  }

  private isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
  }

  private isMediaFile(filePath: string): boolean {
    return MEDIA_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
  }

  private emitProgress(progress: CompressionProgress): void {
    this.emit('progress', progress);
  }

  private async processFile(
    inputPath: string,
    outputPath: string,
    hardware: HardwareInfo,
    settings: CompressionSettings,
    fileIndex: number,
    totalFiles: number,
    fallbackUsed: boolean
  ): Promise<CompressionResult> {
    const startedAt = Date.now();
    const mode = normalizeMode(settings.mode);
    const outputFormat = getOutputFormatLabel(settings);
    const inputSize = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;

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
      fallbackUsed,
      mode
    });

    const mediaInfo = await this.probeFile(inputPath);

    if (!mediaInfo) {
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
        mode,
        outputFormat,
        validationError: true,
        error: 'Could not read media info — this file may not be a valid video or audio file'
      };
    }

    const built = this.buildFFmpegArgs(inputPath, outputPath, mediaInfo, hardware, settings);
    if (built.error) {
      this.emitProgress({
        fileIndex,
        totalFiles,
        fileName: path.basename(inputPath),
        progress: 0,
        overallProgress: Math.round((fileIndex / totalFiles) * 100),
        status: 'error',
        error: built.error,
        encoderName: hardware.name,
        encoder: hardware.encoder,
        isHardwareAccelerated: hardware.isHardwareAccelerated,
        fallbackUsed,
        mode
      });
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
        mode,
        outputFormat,
        validationError: true,
        error: built.error
      };
    }

    return new Promise((resolve) => {
      const ffmpeg = spawn(this.getFFmpegPath(), built.args, { windowsHide: true });
      this.activeProcess = ffmpeg;
      let errorOutput = '';
      const duration = mediaInfo.duration || 0;

      ffmpeg.stderr.on('data', (data) => {
        const line = data.toString();
        errorOutput += line;

        if (line.includes('time=')) {
          const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          const fpsMatch = line.match(/fps=\s*(\d+)/);
          const speedMatch = line.match(/speed=\s*([\d.]+x)/);

          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseFloat(timeMatch[3]);
            const currentTime = hours * 3600 + minutes * 60 + seconds;
            const fileProgress = duration > 0 ? Math.min((currentTime / duration) * 100, 99) : 50;
            const overallProgress = ((fileIndex + (fileProgress / 100)) / totalFiles) * 100;

            this.emitProgress({
              fileIndex,
              totalFiles,
              fileName: path.basename(inputPath),
              progress: Math.round(fileProgress),
              overallProgress: Math.round(overallProgress),
              fps: fpsMatch ? parseInt(fpsMatch[1], 10) : undefined,
              time: timeMatch[0].replace('time=', ''),
              speed: speedMatch ? speedMatch[1] : undefined,
              status: 'compressing',
              encoderName: hardware.name,
              encoder: hardware.encoder,
              isHardwareAccelerated: hardware.isHardwareAccelerated,
              fallbackUsed,
              mode
            });
          }
        }
      });

      ffmpeg.on('close', (code) => {
        this.activeProcess = null;

        if (this.shouldStop) {
          if (fs.existsSync(outputPath)) {
            try { fs.unlinkSync(outputPath); } catch {}
          }
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
            fallbackUsed,
            mode
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
            mode,
            outputFormat,
            error: 'Cancelled'
          });
          return;
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          const outputSize = fs.statSync(outputPath).size;
          const compressionRatio = inputSize > 0 ? ((inputSize - outputSize) / inputSize) * 100 : 0;

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
            fallbackUsed,
            mode
          });

          resolve({
            success: true,
            inputPath,
            outputPath,
            outputName: path.basename(outputPath),
            inputSize,
            outputSize,
            compressionRatio,
            duration: mediaInfo.duration,
            elapsedMs: Date.now() - startedAt,
            encoder: hardware.encoder,
            encoderName: hardware.name,
            isHardwareAccelerated: hardware.isHardwareAccelerated,
            fallbackUsed,
            mode,
            outputFormat
          });
        } else {
          if (fs.existsSync(outputPath)) {
            try { fs.unlinkSync(outputPath); } catch {}
          }
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
            fallbackUsed,
            mode
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
            mode,
            outputFormat,
            error
          });
        }
      });

      ffmpeg.on('error', (err) => {
        this.activeProcess = null;
        if (fs.existsSync(outputPath)) {
          try { fs.unlinkSync(outputPath); } catch {}
        }

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
          fallbackUsed,
          mode
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
          mode,
          outputFormat,
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
      throw new Error('Encoding already in progress');
    }

    this.isRunning = true;
    this.shouldStop = false;
    const startedAt = Date.now();
    const mode = normalizeMode(settings.mode);
    const outputExt = getOutputExtension(settings);
    const outputFormat = getOutputFormatLabel(settings);
    const codecTarget = getCodecTargetForSettings(settings);
    const results: CompressionResult[] = [];
    const outputFolder = settings.outputFolder
      || (settings.sourcePath
        ? this.getOutputFolderForSource(settings.sourcePath, settings.sourceType, mode)
        : path.join(path.dirname(files[0]?.path || process.cwd()), mode === 'extract_audio' ? 'audio' : mode === 'convert' ? 'converted' : 'compress'));

    let hardware: HardwareInfo;
    if (mode === 'extract_audio') {
      hardware = this.getAudioHardwareInfo(normalizeAudioFormat(settings.audioFormat));
    } else if (settings.encoder === 'auto') {
      hardware = await this.detectHardware(codecTarget);
    } else {
      hardware = await this.getHardwareInfoForEncoder(settings.encoder);
    }

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
        const outputPath = this.getAvailableOutputPath(outputFolder, file.name, outputExt);

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
          fallbackUsed,
          mode
        });

        let result = await this.processFile(
          file.path,
          outputPath,
          hardware,
          settings,
          i,
          files.length,
          fallbackUsed
        );

        // Automatic CPU fallback if hardware video encoder fails (e.g., unusual pixel format/profile/driver)
        if (!result.success && !result.canceled && !result.validationError && hardware.isHardwareAccelerated && mode !== 'extract_audio') {
          fallbackUsed = true;
          hardware = this.getCpuHardwareInfoForTarget(codecTarget, true);
          this.emit('hardware-detected', hardware);
          const fallbackOutputPath = this.getAvailableOutputPath(outputFolder, file.name, outputExt);

          result = await this.processFile(
            file.path,
            fallbackOutputPath,
            hardware,
            settings,
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
        canceled: this.shouldStop,
        mode,
        outputFormat
      };

      this.emit('complete', batchResult);
      return batchResult;
    }
  }

  private async getHardwareInfoForEncoder(encoder: MediaEncoderId): Promise<HardwareInfo> {
    if (encoder === 'libx265') return this.getCpuHardwareInfoForTarget('hevc');
    if (encoder === 'libx264') return this.getCpuHardwareInfoForTarget('h264');
    if (encoder === 'prores_ks') return this.getCpuHardwareInfoForTarget('prores');
    if (encoder === 'libvpx-vp9') return this.getCpuHardwareInfoForTarget('vp9');
    if (encoder === 'copy') return this.detectHardware('remux');
    if (encoder === 'libmp3lame') return this.getAudioHardwareInfo('mp3');
    if (encoder === 'pcm_s16le') return this.getAudioHardwareInfo('wav');
    if (encoder === 'aac') return this.getAudioHardwareInfo('m4a');
    if (encoder === 'flac') return this.getAudioHardwareInfo('flac');

    const macSystemName = process.arch === 'arm64' ? 'Apple Silicon' : 'macOS';
    if (encoder === 'hevc_videotoolbox' || encoder === 'h264_videotoolbox' || encoder === 'prores_videotoolbox') {
      const label = encoder === 'h264_videotoolbox' ? 'H.264' : encoder === 'prores_videotoolbox' ? 'ProRes' : 'HEVC';
      return {
        available: await this.checkEncoder(encoder),
        type: 'videotoolbox',
        encoder,
        name: `${macSystemName} VideoToolbox ${label}`,
        systemName: macSystemName,
        encoderName: `VideoToolbox ${label}`,
        isHardwareAccelerated: true
      };
    }
    if (encoder === 'hevc_nvenc' || encoder === 'h264_nvenc') {
      const label = encoder === 'h264_nvenc' ? 'H.264' : 'HEVC';
      return {
        available: await this.checkEncoder(encoder),
        type: 'nvenc',
        encoder,
        name: `NVIDIA CUDA/NVENC ${label}`,
        systemName: 'NVIDIA CUDA',
        encoderName: `NVENC ${label}`,
        isHardwareAccelerated: true
      };
    }
    if (encoder === 'hevc_amf' || encoder === 'h264_amf') {
      const label = encoder === 'h264_amf' ? 'H.264' : 'HEVC';
      return {
        available: await this.checkEncoder(encoder),
        type: 'amf',
        encoder,
        name: `AMD AMF ${label}`,
        systemName: 'AMD GPU',
        encoderName: `AMF ${label}`,
        isHardwareAccelerated: true
      };
    }
    const label = encoder === 'h264_qsv' ? 'H.264' : 'HEVC';
    return {
      available: await this.checkEncoder(encoder),
      type: 'qsv',
      encoder,
      name: `Intel Quick Sync ${label}`,
      systemName: 'Intel GPU',
      encoderName: `Quick Sync ${label}`,
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

  scanSource(sourcePath: string, mode: EncoderMode = 'compress'): CompressionSource {
    return this.scanSources([sourcePath], mode);
  }

  scanSources(sourcePaths: string[], mode: EncoderMode = 'compress'): CompressionSource {
    const resolvedMode = normalizeMode(mode);
    const validPaths = (sourcePaths || []).filter((p) => typeof p === 'string' && p.length > 0 && fs.existsSync(p));

    if (validPaths.length === 0) {
      const fallbackPath = sourcePaths[0] || '';
      return {
        sourcePath: fallbackPath,
        sourceType: 'folder',
        sourceName: path.basename(fallbackPath),
        outputFolder: this.getOutputFolderForSource(fallbackPath, 'folder', resolvedMode),
        files: []
      };
    }

    if (validPaths.length === 1) {
      const singlePath = validPaths[0];
      const stats = fs.statSync(singlePath);
      const sourceType: SourceType = stats.isDirectory() ? 'folder' : 'file';
      const sourceName = sourceType === 'folder' ? path.basename(singlePath) : path.parse(singlePath).name;
      const outputFolder = this.getOutputFolderForSource(singlePath, sourceType, resolvedMode);
      const files = sourceType === 'folder'
        ? this.scanDirectory(singlePath, resolvedMode)
        // Explicitly selected single file: allow any file extension so weird formats work via ffprobe.
        : [{ path: singlePath, name: path.basename(singlePath), size: stats.size }];

      return {
        sourcePath: singlePath,
        sourceType,
        sourceName,
        outputFolder,
        files
      };
    }

    // Multiple files / mixed drops
    const seen = new Set<string>();
    const files: VideoFile[] = [];

    for (const p of validPaths) {
      const resolved = path.resolve(p);
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        for (const f of this.scanDirectory(resolved, resolvedMode)) {
          const fp = path.resolve(f.path);
          if (!seen.has(fp)) {
            seen.add(fp);
            files.push(f);
          }
        }
      } else if (stats.isFile() && !seen.has(resolved)) {
        seen.add(resolved);
        files.push({ path: resolved, name: path.basename(resolved), size: stats.size });
      }
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    const anchor = validPaths[0];
    const outputFolder = this.getOutputFolderForSource(anchor, 'files', resolvedMode);

    return {
      sourcePath: path.dirname(anchor),
      sourceType: 'files',
      sourceName: `${files.length} selected files`,
      outputFolder,
      files
    };
  }

  scanDirectory(dirPath: string, mode: EncoderMode = 'compress'): VideoFile[] {
    const files: VideoFile[] = [];
    const allowAudio = normalizeMode(mode) === 'extract_audio';

    if (!fs.existsSync(dirPath)) {
      return files;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(dirPath, entry.name);
        if (allowAudio ? this.isMediaFile(filePath) : this.isVideoFile(filePath)) {
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
      const ffmpeg = spawn(this.getFFmpegPath(), ['-version'], { windowsHide: true });
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
