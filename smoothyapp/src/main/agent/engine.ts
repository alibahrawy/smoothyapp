/**
 * smoothy_engine: lets an agent run Smoothy's bundled ffmpeg, ffprobe and
 * whisper-cli with its own arguments, so it never installs media tools.
 *
 * There is no shell. Arguments are passed straight to the binary after a guard:
 * - no network: no URLs, no ffmpeg protocol prefixes (concat:, tee:, fd: ...);
 * - no plugin loading: ladspa, lv2, frei0r and zmq filters are refused;
 * - reads stay inside the media locations Smoothy can read;
 * - writes (outputs, logs, stats files) stay inside writable roots: Smoothy's
 *   agent folder, the temp folder, the open edit project's folder, or a folder
 *   the editor approved for this session.
 * Paths inside filter graphs (lavfi inputs, -vf, -filter_complex and filter
 * script files) are checked with the same rules.
 */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync, readdirSync, statSync, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type EngineTool = 'ffmpeg' | 'ffprobe' | 'whisper';
export type PathRole = 'read' | 'write';
export type CheckedPath = { arg: number; role: PathRole; path: string };

export class EngineGuardError extends Error {
  code: 'E_BAD_REQUEST' | 'E_PATH_DENIED';
  constructor(message: string, code: 'E_BAD_REQUEST' | 'E_PATH_DENIED' = 'E_PATH_DENIED') {
    super(message);
    this.code = code;
  }
}

export type GuardContext = {
  cwd: string;
  home: string;
  /** Folders an agent may read from (resolved, real paths). */
  readRoots: string[];
  /** Folders an agent may write into without asking (resolved, real paths). */
  writeRoots: string[];
  /** Reads a filter script file so its graph can be checked too. */
  readText?: (file: string) => Promise<string>;
};

export type GuardResult = {
  args: string[];
  paths: CheckedPath[];
  /** Folders outside the write roots that this command wants to write into. */
  needsWrite: string[];
};

const MAX_ARGS = 400;
const MAX_ARG_CHARS = 200000;

/** ffmpeg options whose value is a file that is only read. */
const FFMPEG_READ_OPTIONS = new Set(['-i', '-attach', '-filter_complex_script', '-filter_script', '-fpre', '-vpre', '-apre', '-spre']);
/** ffmpeg options whose value is plain text and never a path (metadata can hold anything). */
const FFMPEG_TEXT_OPTIONS = /^-metadata(?::|$)/;
/** whisper-cli options whose value is a file that is only read. */
const WHISPER_READ_OPTIONS = new Set(['-m', '--model', '-f', '--file', '-vm', '--vad-model', '--openvino-encode-device']);
/** whisper-cli options whose value is text (prompts, language, DTW preset). */
const WHISPER_TEXT_OPTIONS = new Set(['--prompt', '-l', '--language', '-dtw', '--dtw', '--suppress-regex', '--grammar', '--grammar-rule']);
/** whisper-cli options that write files next to the input unless -of is given. */
const WHISPER_OUTPUT_FLAGS = /^(?:-o(?:txt|vtt|srt|lrc|wts|csv|j|jf)|--output-(?:txt|vtt|srt|lrc|words|csv|json|json-full))$/;

/** Filters that load native plugins or open network sockets. */
const BLOCKED_FILTERS = /(?:^|[\s,;\]'"])(ladspa|lv2|frei0r|frei0r_src|zmq|azmq)\s*(?=$|[=,;\[\s'"])/i;
/** ffmpeg protocols besides plain files and pipes. Anything with :// is refused separately. */
const PROTOCOL_PREFIX = /^(?!file:|pipe:)([a-z][a-z0-9+.-]{1,}):/i;

/** filter.key pairs (or filter names taking a file as first argument) that only read the file. */
const READ_FILTER_KEYS = new Set([
  'movie.filename', 'amovie.filename', 'movie.movie', 'amovie.amovie',
  'subtitles.filename', 'subtitles.f', 'subtitles.subtitles', 'ass.filename', 'ass.f', 'ass.ass',
  'lut3d.file', 'lut3d.lut3d', 'lut1d.file', 'lut1d.lut1d',
  'sendcmd.filename', 'sendcmd.f', 'asendcmd.filename', 'asendcmd.f',
  'vidstabtransform.input', 'arnndn.model', 'arnndn.m', 'sofalizer.sofa',
  'afir.file', 'firequalizer.gain_entry'
]);
const READ_ANY_FILTER_KEYS = new Set(['fontfile', 'textfile', 'sofa', 'model']);

export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/** An argument is treated as a path when it is absolute, home-relative or has a directory part. */
export function looksLikePath(value: string): boolean {
  if (!value || value === '-' || value.startsWith('-')) return false;
  if (/^[\d.]+\/[\d.]+$/.test(value)) return false; // frame rates and ratios such as 30000/1001
  if (value.startsWith('/') || value.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.includes('=')) return false;
  return value.includes('/') || value.includes('\\');
}

/** Bare file names (no folder) with a media/data extension, resolved against cwd. */
function looksLikeBareFile(value: string): boolean {
  if (!value || value.startsWith('-') || value.includes('=') || /^[\d.:+-]+$/.test(value)) return false;
  return /^[^\s/\\:]+\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(value);
}

async function realOrNearest(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = await fs.realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

export function within(file: string, roots: string[]): boolean {
  const norm = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = norm(path.resolve(file));
  return roots.some(root => {
    const base = norm(path.resolve(root));
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}

function checkNetwork(value: string, label: string): void {
  if (/:\/\//.test(value)) throw new EngineGuardError(`${label} uses a network address. smoothy_engine only works with local files.`);
}

type FilterPath = { value: string; role: PathRole };

/** Finds file paths inside a filter graph string and decides whether each is read or written. */
export function filterPaths(graph: string): FilterPath[] {
  if (BLOCKED_FILTERS.test(graph)) {
    const name = BLOCKED_FILTERS.exec(graph)?.[1] || 'that filter';
    throw new EngineGuardError(`The ${name} filter is not available through the Agent Bridge (it loads plugins or opens sockets).`);
  }
  checkNetwork(graph, 'A filter');
  const found: FilterPath[] = [];
  // A value starts right after "=" or ":" and runs to the next separator.
  const pattern = /(?<=[=:])\s*'?((?:[^:=,;'\[\]\\]|\\.)+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(graph))) {
    const raw = match[1].replace(/\\(.)/g, '$1').trim();
    const pathish = raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('./') || raw.startsWith('../') || /^[a-zA-Z]:[\\/]/.test(raw) || (raw.includes('/') && !/^[\d.]+\/[\d.]+$/.test(raw)) || raw.includes('\\');
    if (!pathish) continue;
    const delimiter = graph[match.index - 1];
    const before = graph.slice(0, match.index - 1);
    const segment = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf(']')) + 1);
    const filter = (segment.split('=')[0] || '').trim().toLowerCase();
    const key = delimiter === '=' ? (/([A-Za-z_][\w]*)\s*$/.exec(before)?.[1] || filter).toLowerCase() : filter;
    const role: PathRole = READ_FILTER_KEYS.has(`${filter}.${key}`) || READ_ANY_FILTER_KEYS.has(key) ? 'read' : 'write';
    found.push({ value: raw, role });
  }
  return found;
}

/**
 * Validates arguments for one engine run. Returns the final argument list and
 * the paths it touches; throws EngineGuardError for anything refused.
 */
export async function guardArgs(tool: EngineTool, input: unknown, ctx: GuardContext): Promise<GuardResult> {
  if (!Array.isArray(input) || !input.length) throw new EngineGuardError('Provide args as an array of strings, for example ["-i", "/path/in.mp4", "out.wav"].', 'E_BAD_REQUEST');
  if (input.length > MAX_ARGS) throw new EngineGuardError(`At most ${MAX_ARGS} arguments.`, 'E_BAD_REQUEST');
  const args = input.map(value => (typeof value === 'number' ? String(value) : value));
  if (args.some(value => typeof value !== 'string')) throw new EngineGuardError('Every argument must be a string.', 'E_BAD_REQUEST');
  if (args.reduce((sum, value) => sum + value.length, 0) > MAX_ARG_CHARS) throw new EngineGuardError('The arguments are too long. Use a filter script file (-filter_complex_script) for big graphs.', 'E_BAD_REQUEST');
  if (args.some(value => value.includes('\0'))) throw new EngineGuardError('Arguments cannot contain null bytes.', 'E_BAD_REQUEST');

  const paths: CheckedPath[] = [];
  const pending: { arg: number; role: PathRole; value: string }[] = [];
  const readOptions = tool === 'whisper' ? WHISPER_READ_OPTIONS : FFMPEG_READ_OPTIONS;

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    const option = i > 0 ? args[i - 1] : '';
    const textValue = tool === 'whisper' ? WHISPER_TEXT_OPTIONS.has(option) : FFMPEG_TEXT_OPTIONS.test(option);
    if (textValue) continue;
    if (tool !== 'whisper') {
      checkNetwork(value, `Argument ${i + 1}`);
      if (PROTOCOL_PREFIX.test(value) && !/^[a-zA-Z]:[\\/]/.test(value) && !value.includes('=')) {
        throw new EngineGuardError(`Argument ${i + 1} uses the ${PROTOCOL_PREFIX.exec(value)?.[1]}: protocol. Only local files and pipes are allowed.`);
      }
      if (value.includes('=') || /^-(?:vf|af|filter|lavfi|filter_complex)(?::|$)/.test(option)) {
        for (const found of filterPaths(value)) pending.push({ arg: i, role: found.role, value: found.value });
      }
      if (/^-(?:filter_complex_script|filter_script)(?::|$)/.test(option) || option.startsWith('-/')) {
        const file = path.resolve(ctx.cwd, expandHome(value.replace(/^file:/, ''), ctx.home));
        pending.push({ arg: i, role: 'read', value: file });
        if (ctx.readText) {
          const real = await realOrNearest(file);
          if (!within(real, ctx.readRoots)) throw new EngineGuardError('That filter script is outside the folders Smoothy can read.');
          const text = await ctx.readText(real).catch(() => '');
          for (const found of filterPaths(text)) pending.push({ arg: i, role: found.role, value: found.value });
        }
        continue;
      }
    }
    if (!looksLikePath(value) && !looksLikeBareFile(value)) continue;
    const role: PathRole = tool === 'whisper'
      ? (option === '-of' || option === '--output-file' ? 'write' : 'read')
      : tool === 'ffprobe'
        ? (option === '-o' ? 'write' : 'read')
        : readOptions.has(option) || option.startsWith('-/') ? 'read' : 'write';
    pending.push({ arg: i, role, value: value.replace(/^file:/, '') });
  }

  if (tool === 'whisper' && args.some(value => WHISPER_OUTPUT_FLAGS.test(value)) && !args.some(value => value === '-of' || value === '--output-file')) {
    throw new EngineGuardError('Pass -of <path prefix> with whisper output flags, so results are written where you choose and not next to the source.', 'E_BAD_REQUEST');
  }

  // A concat demuxer list names more files to read; check each entry too.
  if (tool !== 'whisper' && ctx.readText) {
    for (let i = 1; i < args.length; i += 1) {
      if (args[i - 1] !== '-i') continue;
      const format = args.lastIndexOf('-f', i - 1);
      if (format < 0 || args[format + 1] !== 'concat' || args.slice(format, i - 1).includes('-i')) continue;
      const list = await realOrNearest(path.resolve(ctx.cwd, expandHome(args[i], ctx.home)));
      if (!within(list, ctx.readRoots)) continue; // reported by the main check below
      const text = await ctx.readText(list).catch(() => '');
      for (const line of text.split(/\r?\n/)) {
        const entry = /^\s*file\s+(?:'((?:[^'\\]|\\.)*)'|(\S+))/.exec(line);
        if (!entry) continue;
        const value = (entry[1] ?? entry[2] ?? '').replace(/\\(.)/g, '$1');
        checkNetwork(value, 'A concat list entry');
        pending.push({ arg: i, role: 'read', value: path.resolve(path.dirname(list), expandHome(value, ctx.home)) });
      }
    }
  }

  const needsWrite = new Set<string>();
  for (const item of pending) {
    const absolute = path.resolve(ctx.cwd, expandHome(item.value, ctx.home));
    const real = await realOrNearest(absolute);
    if (!within(real, ctx.readRoots)) throw new EngineGuardError(`${item.value} is outside the folders Smoothy can use (your home folder, external volumes and the temp folder).`);
    if (item.role === 'write' && !within(real, ctx.writeRoots)) needsWrite.add(path.dirname(real));
    paths.push({ arg: item.arg, role: item.role, path: real });
    // Pass the expanded path through so "~/x" works without a shell.
    if (args[item.arg] === item.value && item.value.startsWith('~')) args[item.arg] = absolute;
  }

  return { args, paths, needsWrite: [...needsWrite] };
}

/** Adds the flags every agent run needs: no stdin, no banner, progress output. */
export function finalArgs(tool: EngineTool, args: string[]): string[] {
  if (tool === 'ffmpeg') {
    const out = [...args];
    if (!out.includes('-nostdin')) out.unshift('-nostdin');
    if (!out.includes('-hide_banner')) out.unshift('-hide_banner');
    return out;
  }
  if (tool === 'ffprobe') return args.includes('-hide_banner') ? args : ['-hide_banner', ...args];
  return args.includes('-pp') || args.includes('--print-progress') ? args : [...args, '-pp'];
}

// ---- running ------------------------------------------------------------------

export type EngineRunResult = {
  exitCode: number | null;
  signal: string | null;
  seconds: number;
  stdout: string;
  stdoutBytes: number;
  stderrTail: string[];
  stderrLines: number;
};

const parseClock = (value: string): number => {
  const match = /(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
};

/** Pulls a 0–100 progress value out of ffmpeg/whisper stderr. */
export class ProgressReader {
  private total = 0;
  constructor(private readonly tool: EngineTool, expected?: number) {
    if (expected && expected > 0) this.total = expected;
  }
  read(line: string): number | null {
    if (this.tool === 'whisper') {
      const match = /progress\s*=\s*(\d+)%/.exec(line);
      return match ? Number(match[1]) : null;
    }
    if (this.tool !== 'ffmpeg') return null;
    if (!this.total) {
      const duration = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
      if (duration) this.total = parseClock(duration[1]);
    }
    const time = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
    if (time && this.total > 0) return Math.max(0, Math.min(99, (parseClock(time[1]) / this.total) * 100));
    return null;
  }
}

/** Seconds of output the command will produce, from -t / -to when given. */
export function expectedSeconds(args: string[]): number | undefined {
  for (let i = args.length - 2; i >= 0; i -= 1) {
    if (args[i] === '-t' || args[i] === '-to') {
      const value = args[i + 1];
      const seconds = value.includes(':') ? parseClock(value) : Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  }
  return undefined;
}

export function runEngine(binary: string, tool: EngineTool, args: string[], options: {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  stdoutLimit?: number;
  tailLines?: number;
  logFile?: string;
  expected?: number;
  onProgress?: (percent: number, message: string) => void;
}): Promise<EngineRunResult> {
  const started = Date.now();
  const stdoutLimit = options.stdoutLimit ?? 8 * 1024 * 1024;
  const tailLines = Math.max(5, Math.min(400, options.tailLines ?? 40));
  const env = { ...process.env };
  delete env.FFREPORT;
  delete env.AV_LOG_FORCE_NOCOLOR;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const reader = new ProgressReader(tool, options.expected);
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const tail: string[] = [];
    let lines = 0;
    let partial = '';
    let log: WriteStream | null = null;
    if (options.logFile) {
      try { log = createWriteStream(options.logFile, { flags: 'a' }); log.on('error', () => { log = null; }); } catch { log = null; }
    }
    const kill = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref(); };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= stdoutLimit) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      log?.write(chunk);
      const text = partial + chunk.toString('utf8');
      const parts = text.split(/\r\n|\r|\n/);
      partial = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        lines += 1;
        tail.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
        if (tail.length > tailLines) tail.shift();
        const percent = reader.read(line);
        if (percent !== null) options.onProgress?.(percent, tool === 'whisper' ? `Transcribing ${Math.round(percent)}%` : `Processing ${Math.round(percent)}%`);
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      log?.end();
      reject(Object.assign(new Error(`Could not start ${tool}: ${error.message}`), { code: 'E_INTERNAL' }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      if (partial.trim()) { tail.push(partial.slice(0, 400)); if (tail.length > tailLines) tail.shift(); lines += 1; }
      log?.end();
      if (options.signal?.aborted) {
        reject(Object.assign(new Error('Canceled'), { canceled: true }));
        return;
      }
      resolve({
        exitCode: code,
        signal: signal || null,
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stdoutBytes,
        stderrTail: tail,
        stderrLines: lines
      });
    });
  });
}

// ---- discovery -------------------------------------------------------------------

export type WhisperInfo = {
  path: string | null;
  variant?: string;
  modelsDir: string;
  models: { id: string; path: string; englishOnly?: boolean; bytes?: number }[];
};

export type EngineInfo = {
  ffmpeg: { path: string; version: string | null; encoders: Record<string, boolean>; filters: Record<string, boolean> };
  ffprobe: { path: string; version: string | null };
  whisper: (WhisperInfo & { version?: string | null; dtw: boolean }) | null;
  sfx: { path: string; sounds: number } | null;
  python: null;
};

const KEY_ENCODERS = ['libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox', 'h264_nvenc', 'prores_ks', 'prores_videotoolbox', 'pcm_s24le', 'pcm_s16le', 'aac', 'libmp3lame', 'png', 'mjpeg', 'libvpx-vp9', 'libopus'];
const KEY_FILTERS = ['loudnorm', 'ebur128', 'astats', 'silencedetect', 'acompressor', 'highpass', 'afade', 'acrossfade', 'amix', 'sidechaincompress', 'overlay', 'crop', 'scale', 'unsharp', 'zoompan', 'drawtext', 'subtitles', 'ass', 'fade', 'xfade', 'tblend', 'scdet', 'select', 'tile', 'colorchannelmixer', 'lut3d', 'chromakey', 'colorkey', 'ametadata'];

function listedNames(text: string, kind: 'encoders' | 'filters'): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = kind === 'encoders' ? /^\s*[VAS.][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line) : /^\s*[T.][S.][C.]?\s+(\S+)\s+\S+->\S+/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function firstLine(binary: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await exec(binary, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const line = `${stdout}\n${stderr}`.split('\n').find(item => item.trim());
    return line ? line.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

export async function describeEngines(deps: { ffmpeg: string; ffprobe: string; whisper?: () => WhisperInfo | null; sfxDir?: string | null }): Promise<EngineInfo> {
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([firstLine(deps.ffmpeg, ['-hide_banner', '-version']), firstLine(deps.ffprobe, ['-hide_banner', '-version'])]);
  let encoders = new Set<string>();
  let filters = new Set<string>();
  try {
    const [enc, fil] = await Promise.all([
      exec(deps.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }),
      exec(deps.ffmpeg, ['-hide_banner', '-filters'], { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    ]);
    encoders = listedNames(enc.stdout, 'encoders');
    filters = listedNames(fil.stdout, 'filters');
  } catch {
    // Leave both empty; the version line still tells the agent ffmpeg exists.
  }
  let whisper: EngineInfo['whisper'] = null;
  try {
    const info = deps.whisper?.() || null;
    if (info) whisper = { ...info, dtw: Boolean(info.path), version: null };
  } catch {
    whisper = null;
  }
  let sfx: EngineInfo['sfx'] = null;
  if (deps.sfxDir && existsSync(deps.sfxDir)) {
    let sounds = 0;
    try {
      const library = JSON.parse(await fs.readFile(path.join(deps.sfxDir, 'library.json'), 'utf8'));
      sounds = Array.isArray(library) ? library.length : Array.isArray(library?.sounds) ? library.sounds.length : 0;
    } catch {
      sounds = 0;
    }
    sfx = { path: deps.sfxDir, sounds };
  }
  return {
    ffmpeg: {
      path: deps.ffmpeg,
      version: ffmpegVersion,
      encoders: Object.fromEntries(KEY_ENCODERS.map(name => [name, encoders.has(name)])),
      filters: Object.fromEntries(KEY_FILTERS.map(name => [name, filters.has(name)]))
    },
    ffprobe: { path: deps.ffprobe, version: ffprobeVersion },
    whisper,
    sfx,
    python: null
  };
}

/** Lists ggml model files in a folder (one level of subfolders). */
export function scanWhisperModels(dir: string): WhisperInfo['models'] {
  const models: WhisperInfo['models'] = [];
  const visit = (folder: string, prefix: string, depth: number) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && depth === 0) visit(full, `${prefix}${entry.name}/`, 1);
      if (!entry.isFile() || !/^ggml-.*\.bin$/i.test(entry.name) || /silero|vad/i.test(entry.name)) continue;
      let bytes: number | undefined;
      try { bytes = statSync(full).size; } catch { bytes = undefined; }
      models.push({ id: `${prefix}${entry.name}`, path: full, englishOnly: /\.en\.bin$/i.test(entry.name) || undefined, bytes });
    }
  };
  visit(dir, '', 0);
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** The DTW preset name whisper-cli expects for a ggml model file, e.g. small.en. */
export function dtwPreset(modelFile: string): string | null {
  const match = /ggml-(tiny|base|small|medium|large-v3-turbo|large-v3|large-v2|large-v1)(\.en)?(?:[-.].*)?\.bin$/i.exec(path.basename(modelFile));
  if (!match) return null;
  const size = match[1].toLowerCase().replace('large-v3-turbo', 'large.v3.turbo').replace(/large-v(\d)/, 'large.v$1');
  return `${size}${match[2] ? '.en' : ''}`;
}

export function tmpRoots(): string[] {
  const roots = [os.tmpdir()];
  if (process.platform !== 'win32') roots.push('/tmp', '/private/tmp', '/private/var/folders');
  return roots;
}
