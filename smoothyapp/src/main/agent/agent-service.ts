/**
 * Smoothy Agent Bridge.
 *
 * A loopback-only MCP + JSON API that lets an external coding agent inspect the
 * current edit, pull cheap preview frames, run Smoothy's local media engines, and
 * leave timecoded review notes. There is no shell: smoothy_engine runs only the
 * bundled ffmpeg, ffprobe and whisper-cli, behind a path and network guard.
 */

import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import type { LocalAudioService } from '../local-audio-service';
import { getShortsCutsCatalog } from '../websocket-server';
import {
  contactSheet,
  extractFrame,
  allowedRoots,
  formatTimecode,
  parseDataUrl,
  probeMedia,
  resolveMediaPath,
  sequenceFrameAt,
  toDataUrl,
  type ProbeResult
} from './media';
import { ReviewStore } from './review-store';
import { EditEngine } from './edit-tools';
import { installPreviewProtocol } from './preview-protocol';
import {
  EngineGuardError,
  describeEngines,
  dtwPreset,
  expandHome,
  expectedSeconds,
  finalArgs,
  guardArgs,
  runEngine,
  tmpRoots,
  within,
  type EngineInfo,
  type EngineTool,
  type WhisperInfo
} from './engine';
import { DETAIL_LIMIT, RESULT_LIMIT, ResultCache, compactData, fileStamp, hashKey } from './results';
import { HELP_TOPICS, topicList } from './help-topics';
import { AnalysisEngine, type ModelInstaller } from './analysis';
import { CutEngine } from './cut';
import { NleEngine } from './nle';
import { VisionEngine } from './vision';
import { normalizeClip } from './cut';
import { downloadPhoto, searchCommonsPhotos, type Fetcher } from './photos';
import { uniquePath } from './edit-tools';
import {
  applyVoiceChain,
  classifyAudioQuality,
  compareAudioStats,
  measureAudioStats,
  muxCleanedVideo,
  normalizeStrengthPercent,
  type AudioComparison
} from './audio-cleanup';
import type {
  AgentJob,
  AgentResult,
  AgentToolDefinition,
  AgentToolError,
  ReviewScreenshot,
  ReviewThread
} from './types';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const DEFAULT_PORT = 3778;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_MARKERS = 200;

export type AgentServiceDeps = {
  store: any;
  appVersion: string;
  userData: string;
  ffmpeg: string;
  ffprobe: string;
  getSequenceInfo: () => any;
  requestSequenceInfo: () => void;
  getActiveNLE: () => 'premiere' | 'resolve' | null;
  isEditorConnected: () => boolean;
  addMarkers: (markers: any[]) => Promise<any>;
  clearMarkers: (scope: 'smoothy' | 'all', sequenceId?: string) => Promise<any>;
  audioService?: LocalAudioService | null;
  window: () => BrowserWindow | null;
  trackTool?: (id: string) => void;
  /** Speech and library services behind the headless editor. Optional. */
  edit?: { speech?: import('./edit-features').SpeechService | null; library?: import('./edit-features').LibraryService | null };
  /** The Agent Bridge is a Pro feature. Omitted means allowed (tests). */
  allowed?: () => boolean;
  /** Engines beyond ffmpeg/ffprobe: the installed whisper-cli and the SFX library. */
  engines?: { whisper?: () => WhisperInfo | null; installer?: ModelInstaller | null; sfxDir?: string | null; visionHelper?: string | null };
  /** Imports an XML into the open Premiere project as a new sequence. */
  importXml?: (file: string) => Promise<{ success?: boolean; error?: string }>;
  /** HTTP client for photo search (defaults to global fetch; tests pass a stub). */
  fetcher?: Fetcher;
  /** Whether the system temp folder is writable without approval. Default true; tests turn it off. */
  tempWritable?: boolean;
};

type Activity = {
  id: string;
  tool: string;
  ok: boolean;
  ms: number;
  source: 'mcp' | 'http' | 'ui';
  summary: string;
  at: string;
};

type PendingJob = AgentJob & {
  controller: AbortController;
  listeners: Set<() => void>;
  startedMs: number;
  finishedMs: number | null;
};

type ApprovalDecision = 'once' | 'session' | null;

type PendingApproval = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
  session: boolean;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

/** Approvals the editor may grant for the rest of the session instead of per call. */
const SESSION_APPROVALS = new Set(['smoothy_render.export', 'smoothy_library.add', 'smoothy_engine.write', 'smoothy_edit.folder', 'smoothy_analyze.install', 'smoothy_nle.import']);

const schema = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true
});

const string = (description: string): Record<string, unknown> => ({ type: 'string', description });
const DETAIL = { type: 'boolean', description: 'Return up to 96 KB inline instead of 16 KB. Larger results always go to a file (resultFile).' };
const number = (description: string): Record<string, unknown> => ({ type: 'number', description });
const boolean = (description: string): Record<string, unknown> => ({ type: 'boolean', description });

const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'smoothy_status',
    description: 'What Smoothy sees right now: app version, editor connection, current sequence, local engines, review notes and Agent Bridge URL. Call this first.',
    inputSchema: schema(),
    annotations: { title: 'Smoothy status', readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'smoothy_help',
    description: 'Discover Smoothy capabilities. Pass a tool name for its arguments, skill=true for the playbook, or topic for focused notes loaded on demand: engine (running ffmpeg/whisper), gotchas (known pitfalls), workflow-longform, premiere, audio.',
    inputSchema: schema({
      tool: string('Tool name, for example smoothy_media.'),
      skill: boolean('Return the complete agent skill/playbook.'),
      topic: { type: 'string', enum: ['engine', 'gotchas', 'workflow-longform', 'premiere', 'audio'], description: 'Help topic.' }
    }),
    annotations: { title: 'Smoothy help', readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'smoothy_project',
    description: 'Read the current sequence map (tracks, clips, source ranges, markers) or refresh it from Premiere/Resolve. Also lists native Premiere effects when connected.',
    inputSchema: schema({
      action: { type: 'string', enum: ['inspect', 'refresh', 'effects_catalog'], description: 'inspect | refresh | effects_catalog' },
      query: string('Filter effect names for effects_catalog.'),
      limit: number('Maximum names per effect category. Default 40, max 200.')
    }),
    annotations: { title: 'Project map', readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'smoothy_media',
    description: 'Probe media, extract a frame at a timeline/source time, or build a contact sheet. Uses the bundled ffmpeg and returns a compact image, never a command line.',
    inputSchema: schema({
      action: { type: 'string', enum: ['probe', 'frame', 'contact_sheet'], description: 'probe | frame | contact_sheet' },
      path: string('Absolute media path. For sequence times, omit and use the current sequence.'),
      time: number('Timeline time in seconds for frame.'),
      times: { type: 'array', items: { type: 'number' }, description: 'Timeline/source times for contact_sheet. Max 24.' },
      width: number('Preview width in pixels. Default 960 for a frame, 320 per cell for a sheet.')
    }),
    annotations: { title: 'Media preview', readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'smoothy_review',
    description: 'The editor writes timecoded notes for you to fix. List the open notes, make the fix, then reply on the note with what you changed. You cannot write notes or mark them fixed; the editor does that. Also: point the preview at a headless file, open a timecode, or wait for new notes.',
    inputSchema: schema({
      action: { type: 'string', enum: ['preview', 'list', 'reply', 'open', 'wait'], description: 'preview | list | reply | open | wait. Notes are written and resolved by the editor.' },
      id: string('Review note id to reply to.'),
      body: string('Reply text: what you changed for this note.'),
      time: number('Timeline time in seconds for preview/open.'),
      name: string('Optional display name for an agent preview file.'),
      path: string('Media path for preview instead of the current sequence.'),
      since: string('ISO timestamp for incremental list/wait.'),
      timeoutMs: number('Wait timeout in milliseconds, max 120000. Default 25000.'),
      includeResolved: boolean('Include fixed notes in list.')
    }),
    annotations: { title: 'Review notes', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_timeline',
    description: 'Safe timeline actions through the editor bridge. Marker edits require explicit approval in the Smoothy window. Effects use the Premiere ShortsCuts catalog.',
    inputSchema: schema({
      action: { type: 'string', enum: ['markers_add', 'markers_clear'], description: 'markers_add | markers_clear' },
      markers: { type: 'array', items: { type: 'object' }, description: 'Markers: {time,endTime,name,comment,color?}.' },
      scope: { type: 'string', enum: ['smoothy', 'all'], description: 'Marker clear scope.' },
      sequenceId: string('Optional sequence id for marker clear.')
    }),
    annotations: { title: 'Timeline actions', readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  {
    name: 'smoothy_audio',
    description: 'Local neural audio cleanup & diagnostics for agentic editing (no cloud upload, no credits). Actions: diagnose {path|asset, from?, to?} measures noise floor, speech level, SNR, LUFS, true peak and low-end rumble using bundled ffmpeg (works even before engine setup — use it first since you cannot hear). denoise {path|asset, from?, to?, strength?:1, aggression?:5, voiceChain?:false, keepNoise?:false, muxVideo?:false, apply?:false, output?} removes background noise directly WITHOUT music separation and returns before/after SNR and noise-reduction metrics. separate {path|asset, from?, to?} splits Voice and Music into two WAVs. isolate {path|asset, ...} strips BOTH background music and noise in one step to get clean dialogue (enhance is an alias). state / setup: check or install the one-time local audio engine. Supports waitMs (default 20000) and cache (default true).',
    inputSchema: schema({
      action: { type: 'string', enum: ['state', 'setup', 'diagnose', 'denoise', 'separate', 'isolate', 'enhance'], description: 'state | setup | diagnose | denoise | separate | isolate (enhance is an alias for isolate)' },
      path: string('Absolute audio or video path (or omit and pass asset for an open smoothy_edit project asset).'),
      asset: string('Asset id in the open smoothy_edit project (alternative to path).'),
      from: number('Optional range start in source seconds (great for testing a 15 s noisy slice first).'),
      to: number('Optional range end in source seconds.'),
      strength: number('Noise/background removal strength: 0–1 (or 0–100%). Default 1 (100%). Use 0.7–0.85 to keep natural room tone.'),
      aggression: number('Optional neural model aggression integer 1–20. Default 5; raise (8–12) for stubborn noise.'),
      voiceChain: boolean('denoise/isolate: also apply broadcast dialogue polish (80 Hz highpass, light compression, -16 LUFS loudnorm). Default false.'),
      keepNoise: boolean('denoise/isolate: also save the removed noise/background WAV. Default false.'),
      muxVideo: boolean('denoise/isolate (full video only): also write a lossless-video copy (-c:v copy) with the cleaned audio track. Default false.'),
      apply: boolean('denoise/isolate (full file only): snapshot the open smoothy_edit project, import the cleaned WAV, and swap matching audio clips to it. Default false.'),
      output: string('Optional output WAV path inside a writable root (never overwrites existing files).'),
      waitMs: number('How long to wait before returning a job id. Default 20000, max 120000.'),
      cache: boolean('Reuse an identical earlier run if its outputs still exist on disk. Default true.')
    }),
    annotations: { title: 'Audio cleanup', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_edit',
    description: 'Build a video edit with no editor and no ffmpeg install. Actions: new {name,folder?} (folder creates Edit/, Media/, Graphics/, Work/ there; exports and versions go to Edit/), list, open, show, import {paths}, ops {ops:[...]}, snapshot {label?} saves v1, v2 …, versions, restore {version}, undo, redo. region {asset, name, crop:[x,y,w,h]} makes a virtual source (same file and timecode). music_bed {asset|path, targetLufs?:-33.5, liftLufs?:-24, lifts?:[{from,to}]} loops the music with crossfades under the voice and lifts it where nobody speaks (default: gaps in A1), as a job. sfx {cues:[{at, name|path, gainDb?}]} places level-matched sounds from the bundled library (sfx_search {query}) on packed tracks. Ops (batch many per call): add {asset,at?,in?,out?,duration?,track?,volume?,speed?,fadeIn?,fadeOut?,only?:audio}, trim {clip,in?,out?,ripple?}, split {clip,at}, move {clip,to,track?}, remove {clip,ripple?}, set {clip,volume?,speed?,mute?,fadeIn?,fadeOut?,opacity?,fit?,text?}, text {text,at,duration,style?}, captions {items:[{start,end,text}]}, cut {from,to} (ripple-removes a time range), ripple_gaps {track?}. Times are seconds on the timeline. Smoothy features as actions: cut_silence {tracks?,thresholdDb?,minSilence?,padding?} removes dead air; multicam {cameras:[{asset,mic?,speaker?}],wide?,audio?} (job) cuts synced cameras by who speaks; transcribe {tracks?,language?,captions?} (job) returns a timed transcript and can place captions. A video clip and its audio are linked and edit together.',
    inputSchema: schema({
      action: { type: 'string', enum: ['new', 'list', 'open', 'show', 'import', 'region', 'ops', 'cut_silence', 'multicam', 'transcribe', 'music_bed', 'sfx', 'sfx_search', 'snapshot', 'versions', 'restore', 'undo', 'redo'], description: 'new | list | open | show | import | region | ops | cut_silence | multicam | transcribe | music_bed | sfx | sfx_search | snapshot | versions | restore | undo | redo' },
      asset: string('region: the asset to crop. music_bed: the music asset.'),
      crop: { type: 'array', items: { type: 'number' }, description: 'region: [x, y, w, h] in source pixels.' },
      path: string('music_bed: a music file instead of an asset.'),
      targetLufs: number('music_bed: loudness under speech. Default -33.5.'),
      liftLufs: number('music_bed: loudness where nobody speaks. Default -24.'),
      lifts: { type: 'array', items: { type: 'object' }, description: 'music_bed: [{from, to}] timeline windows to lift. Default: gaps of 1.5 s+ on voiceTrack.' },
      voiceTrack: string('music_bed: dialogue track for automatic lifts. Default A1.'),
      crossfade: number('music_bed: loop crossfade seconds. Default 3.'),
      cues: { type: 'array', items: { type: 'object' }, description: 'sfx: [{at, name | path, gainDb?, level?}].' },
      query: string('sfx_search: words to match.'),
      name: string('Project name for new.'),
      folder: string('Absolute project folder for new. Created with Edit/, Media/, Graphics/ and Work/ after the editor approves.'),
      label: string('Label for snapshot.'),
      version: number('Version number for restore, for example 2.'),
      detail: DETAIL,
      width: number('Project width for new. Default 1920.'),
      height: number('Project height for new. Default 1080.'),
      fps: number('Project frame rate for new. Default 30.'),
      id: string('Project id for open.'),
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute media paths for import. Max 40.' },
      ops: { type: 'array', items: { type: 'object' }, description: 'Edit operations applied in order, atomically.' },
      clips: boolean('Set false for show to skip the per-clip lines.'),
      cameras: { type: 'array', items: { type: 'object' }, description: 'multicam cameras: [{asset, mic?, speaker?}]. Synced, same start.' },
      tracks: { type: 'array', items: { type: 'string' }, description: 'Audio tracks used by cut_silence/transcribe, for example ["A1"].' },
      thresholdDb: number('cut_silence threshold in dB. Default -35.'),
      minSilence: number('cut_silence shortest silence in seconds. Default 0.6.'),
      padding: number('cut_silence breathing room kept around speech. Default 0.12.'),
      wide: number('multicam: index of the wide camera shown on overlapping speech.'),
      audio: { type: 'string', enum: ['mics', 'first', 'none'], description: 'multicam audio source.' },
      language: string('transcribe language code, default auto.'),
      captions: boolean('transcribe: also place captions on T1.')
    }),
    annotations: { title: 'Edit project', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_render',
    description: 'Preview and export the edit project with the bundled ffmpeg. proxy {width?:640, from?, to?} renders a small draft MP4 for a watch-through (no approval, job). frame {time,width?} returns one composited image (regions, zoom and alpha overlays drawn as in the Premiere XML), sheet {count? | times? | from,to,width?} returns a labelled contact sheet, analyze {from?,to?,tracks?,thresholdDb?,minSilence?} returns loudness and silent ranges (you cannot hear, so use this), export {name?,preset?,from?,to?,width?,loudnorm?} renders an MP4 after the editor approves (job, poll smoothy_jobs).',
    inputSchema: schema({
      action: { type: 'string', enum: ['frame', 'sheet', 'proxy', 'export', 'analyze'], description: 'frame | sheet | proxy | export | analyze' },
      time: number('Timeline time in seconds for frame.'),
      times: { type: 'array', items: { type: 'number' }, description: 'Timeline times for sheet. Max 24.' },
      count: number('Evenly spaced frames for sheet. Default 8, max 24.'),
      from: number('Range start in seconds.'),
      to: number('Range end in seconds.'),
      width: number('Output width in pixels.'),
      name: string('Export file name.'),
      preset: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'draft | standard | high. Default standard.' },
      loudnorm: boolean('Normalize loudness to -14 LUFS on export.'),
      tracks: { type: 'array', items: { type: 'string' }, description: 'Audio tracks to analyze/transcribe/cut by, for example ["A1"].' },
      thresholdDb: number('Silence threshold in dB. Default -35.'),
      minSilence: number('Shortest silence in seconds. Default 0.5.')
    }),
    annotations: { title: 'Render', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_library',
    description: 'Find music, stock footage and photos and add them to the edit project. music {query?,mood?,genre?,limit?} searches the YouTube Audio Library archive (it does not state licences, so it cannot be filtered for Claim Clear/Content ID). stock {query,provider?,orientation?,license?:"no-attribution"} searches Wikimedia, Internet Archive, NASA, Pixabay and Coverr; each hit says whether attribution is needed. photo {query, license?:"pd"|"cc-by", orientation?} searches Wikimedia Commons (pd = CC0/public domain; cc-by adds CC BY with the author; share-alike/NC/ND never). add {kind:"music"|"stock"|"photo", id} downloads after the editor approves (job; photos at most 3840 px wide) and writes the credit to the project credits file. credits rewrites Edit/CREDITS.txt from every sourced asset. Always pass licences and credits on to the editor.',
    inputSchema: schema({
      action: { type: 'string', enum: ['music', 'stock', 'photo', 'add', 'credits'], description: 'music | stock | photo | add | credits' },
      license: string('stock: "no-attribution". photo: "pd" (default) or "cc-by".'),
      query: string('Search words.'),
      mood: string('Music mood, for example Happy or Calm.'),
      genre: string('Music genre.'),
      provider: { type: 'string', enum: ['all', 'commons', 'archive', 'nasa', 'pixabay', 'coverr'], description: 'Stock source. Default all.' },
      orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'], description: 'Stock orientation.' },
      limit: number('Results to return. Default 8, max 20.'),
      kind: { type: 'string', enum: ['music', 'stock', 'photo'], description: 'What add downloads.' },
      id: string('Track id (music) or ref (stock) from a search.')
    }),
    annotations: { title: 'Library', readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'smoothy_engine',
    description: 'Run the bundled ffmpeg, ffprobe or whisper-cli with your own arguments (no shell, no install). Reads must be inside the home folder, external volumes or temp. Writes go to the open project folder, Smoothy\'s agent folder, temp, or a folder the editor approves (pass workspace once to ask for a whole folder). URLs and plugin filters are refused. Waits up to waitMs, then returns a job id with progress and ETA. Returns exit code, stderr tail, files written and a log path; large stdout goes to a file. cache:true reuses an identical earlier run. Read smoothy_help topic "engine" first.',
    inputSchema: schema({
      tool: { type: 'string', enum: ['ffmpeg', 'ffprobe', 'whisper'], description: 'ffmpeg | ffprobe | whisper (whisper-cli).' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments, without the program name. Use absolute paths or paths relative to cwd; ~ is expanded.' },
      cwd: string('Working folder. Default: the open project\'s Work folder, or workspace, or Smoothy\'s agent work folder.'),
      workspace: string('A folder to write into for this session. The editor approves it once.'),
      waitMs: number('How long to wait before returning a job id. Default 20000, max 120000.'),
      timeoutMs: number('Kill the run after this long. Default 2 hours, max 6 hours.'),
      expectedSeconds: number('Output duration in seconds, for an accurate ETA when ffmpeg cannot read one.'),
      tailLines: number('stderr lines to return. Default 30, max 200.'),
      cache: boolean('Reuse the result of an identical earlier run if its outputs still exist.'),
      detail: DETAIL
    }, ['tool', 'args']),
    annotations: { title: 'Run engine', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_analyze',
    description: 'Measure what you cannot see or hear, on a source file (optionally from/to in source seconds). transcribe_words {path, model?, terms?, prompt?, language?, shift?}: whisper DTW word timings in source seconds, onsets shifted −0.15 s, a filler prompt so um/uh are written and flagged; writes words.json + readable.txt. envelope {path, binMs?, thresholdDb?, minSilence?}: 10 ms RMS dB envelope + silence map. loudness {path, ranges?}: integrated LUFS, LRA, true peak. scene_cuts {path, threshold?}: shot boundaries. glitch_check {path|paths|folder}: rendered graphics composited over gray, frames that jump away from both neighbours (half-painted or blank). vision_faces {path, crop?, clips?|times?|fps?, apply?, zoom?} (macOS): eye midpoint per sample and a median anchor per clip (default 0.50, 0.44), apply:true sets them on matching edit clips. vision_hands_on_face {path, crop?, clips?|from/to, fps?:3}: spans where a hand covers the upper face. layout_scan {path, regions:[{name, rect, measure:brightness|color|match, color?, reference?, classes:[{label,min?,max?}]}], fps?:4, clips?}: time ranges per region state (whiteboard or not, another person in the tile). models / install_model {model:"small.en"}: whisper models (the editor approves downloads). Jobs with ETA, cached by file and settings; full output goes to files in the project Work/ folder.',
    inputSchema: schema({
      action: { type: 'string', enum: ['transcribe_words', 'envelope', 'loudness', 'scene_cuts', 'glitch_check', 'vision_faces', 'vision_hands_on_face', 'layout_scan', 'models', 'install_model'], description: 'transcribe_words | envelope | loudness | scene_cuts | glitch_check | vision_faces | vision_hands_on_face | layout_scan | models | install_model' },
      paths: { type: 'array', items: { type: 'string' }, description: 'glitch_check: files to check.' },
      crop: { type: 'array', items: { type: 'number' }, description: 'vision: [x, y, w, h] region to scan (e.g. the speaker tile); results are normalized in it.' },
      clips: { description: 'vision/layout: clips.json path or clip array; samples per clip and per-clip results.' },
      times: { type: 'array', items: { type: 'number' }, description: 'vision_faces: source times to sample.' },
      fps: number('Samples per second. Default 1 (faces), 3 (hands), 4 (layout).'),
      perClip: number('vision_faces: samples per clip. Default 2.'),
      apply: boolean('vision_faces: set the anchors on matching smoothy_edit clips.'),
      zoom: number('vision_faces with apply: also set this punch-in zoom.'),
      minSpan: number('vision_hands_on_face: shortest span kept, seconds. Default 0.4.'),
      regions: { type: 'array', items: { type: 'object' }, description: 'layout_scan regions.' },
      folder: string('glitch_check: a folder of renders (.mov/.mp4/.webm/.mkv).'),
      path: string('Absolute source media path.'),
      from: number('Range start in source seconds. Default 0.'),
      to: number('Range end in source seconds. Default the end of the file.'),
      model: string('Whisper model, for example small.en, medium.en or large-v3-turbo. Default: the best installed.'),
      terms: { type: 'array', items: { type: 'string' }, description: 'Product words and names added to the filler prompt so whisper spells them right.' },
      prompt: string('Replace the whole prompt (the default writes um/uh so they can be cut).'),
      language: string('Language code. Default en for .en models, else auto.'),
      shift: number('Seconds added to every DTW onset. Default -0.15.'),
      binMs: number('Envelope bin size in ms. Default 10.'),
      thresholdDb: number('Silence threshold in dB for the envelope silence map. Default -50.'),
      minSilence: number('Shortest silence in seconds. Default 0.3.'),
      ranges: { type: 'array', items: { type: 'object' }, description: 'loudness: up to 20 {from, to} ranges in source seconds.' },
      threshold: number('scene_cuts: scene score 0.05-0.9. Default 0.3.'),
      minGap: number('scene_cuts: drop cuts closer than this many seconds. Default 0.5.'),
      waitMs: number('How long to wait before returning a job id. Default 20000, max 120000.'),
      detail: DETAIL
    }, ['action']),
    annotations: { title: 'Analyze media', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_cut',
    description: 'Cut by phrase on the waveform. cut_phrases {words, envelope, rows, place?}: rows are {chapter, sub} or {id, near:"mm:ss", from:"phrase"|"@seconds", to:"phrase"|"@seconds", skip?:[phrase|"@a-b"], angle?}; returns frame-accurate source clips whose cuts sit in real silence (lead 0.08 s, tail 0.14 s, pauses over 0.62 s tightened to 0.30 s, fillers removed only when safe) and writes clips.json; place:true appends them to the open edit project. verify_edit {clips, words}: renders the cut with 0.6 s gaps, transcribes it and lists clipped/leaked words by clip id plus fillers still heard (pass the report back as fillers). captions {clips, words, corrections?, inserts?}: SRT, ≤ 5 words per cue. chapters {clips, inserts?}: YouTube chapters. words/envelope come from smoothy_analyze.',
    inputSchema: schema({
      action: { type: 'string', enum: ['cut_phrases', 'verify_edit', 'captions', 'chapters'], description: 'cut_phrases | verify_edit | captions | chapters' },
      words: string('Path to words.json from smoothy_analyze transcribe_words.'),
      envelope: string('Path to envelope.json (10 ms) from smoothy_analyze envelope.'),
      rows: { type: 'array', items: { type: 'object' }, description: 'Cut list rows, in story order.' },
      clips: { description: 'Path to clips.json from cut_phrases (or an inline clip array).' },
      fillers: { description: 'Source times of fillers to cut, or the path of a verify_edit report.' },
      source: string('Source media path (default: from words.json).'),
      name: string('Base name for written files.'),
      fps: number('Frame rate for cut points. Default: the source video fps.'),
      place: boolean('cut_phrases: also append the clips to the open smoothy_edit project.'),
      thresholdDb: number('Speech threshold in dB. Default -50.'),
      quietDb: number('Quiet threshold in dB. Default -45.'),
      lead: number('Seconds kept before the first syllable. Default 0.08.'),
      tail: number('Seconds kept after the last syllable. Default 0.14.'),
      maxGap: number('Pauses longer than this are tightened. Default 0.62.'),
      keepGap: number('...to about this much. Default 0.30.'),
      removeFillers: boolean('Cut um/uh found in the transcript. Default true.'),
      fillerMax: number('Longest filler island cut, in seconds. Default 0.55.'),
      inserts: { type: 'array', items: { type: 'object' }, description: 'captions/chapters: [{before: clipId, seconds}] for logo, title and slates placed between clips. Several may precede one clip; a chapter starts at the last one (its slate).' },
      corrections: { type: 'array', items: { type: 'object' }, description: 'captions: [{find, replace, regex?}] fixes for product terms.' },
      skipChapters: { type: 'array', items: { type: 'string' }, description: 'Chapters to leave out of captions/chapters, e.g. ["COLD OPEN"].' },
      maxWords: number('captions: words per cue. Default 5.'),
      gapFrames: number('captions: break on gaps over this many frames. Default 8.'),
      waitMs: number('verify_edit: how long to wait before returning a job id. Default 20000.'),
      detail: DETAIL
    }, ['action']),
    annotations: { title: 'Cut by phrase', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_nle',
    description: 'Round-trip with Premiere. export_xml {name?, markers?, pack?}: the open smoothy_edit project → FCP7 XML in Edit/ as "<name> (vN)" (never overwrites), at the project frame rate, with calibrated Basic Motion (scale 200×zoom for 1920 in 3840, eye-anchored center), regions as Crop on the original file, upper tracks packed, chapters as markers. import_xml {xml?}: checks no media is offline, the editor approves, then it becomes a new sequence (earlier versions untouched). live_diff {version?, apply?}: reads the editor\'s live sequence and diffs it with your last export (trims, removed, added, splits, order, J/L cuts); writes their cut as a clip list; apply:true rebuilds the headless edit from it after a snapshot. Open the editor\'s sequence in Premiere first.',
    inputSchema: schema({
      action: { type: 'string', enum: ['export_xml', 'import_xml', 'live_diff'], description: 'export_xml | import_xml | live_diff' },
      name: string('Sequence base name. Default: the project name.'),
      version: { description: 'export_xml: version number (default next). live_diff: the .smoothy.json (or .xml) of the export to compare with (default the newest).' },
      markers: { description: 'Chapter markers: [{title, at}] or the chapters JSON from smoothy_cut chapters.' },
      pack: boolean('Pack V2+ and A2+ onto as few tracks as possible. Default true.'),
      xml: string('import_xml: the exported XML (default the newest export of the open project).'),
      track: string('live_diff: main track to rebuild from. Default V1.'),
      apply: boolean('live_diff: rebuild the headless edit from the editor\'s cut (a snapshot is saved first).'),
      settleMs: number('live_diff: wait for the editor to report the sequence. Default 800.'),
      detail: DETAIL
    }, ['action']),
    annotations: { title: 'Premiere round-trip', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_jobs',
    description: 'Check, wait for, or cancel a long-running Smoothy job started by another tool. Running jobs report progress and etaSeconds: wait about that long instead of polling.',
    inputSchema: schema({
      action: { type: 'string', enum: ['list', 'status', 'wait', 'cancel'], description: 'list | status | wait | cancel' },
      id: string('Job id.'),
      timeoutMs: number('Wait timeout in milliseconds, max 120000. Default 25000.')
    }),
    annotations: { title: 'Jobs', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];

function skillMarkdown(): string {
  const lines = [
    '# Smoothy Agent Bridge',
    '',
    'You are working inside a running SmoothyEdit app. Smoothy owns the media engines,',
    'the editor bridge, preview frames and the human review surface. Use it instead of',
    'installing ffmpeg, whisper, demucs or any other media dependency.',
    '',
    '## Rules',
    '',
    '1. Call `smoothy_status` first. It tells you the app version, editor connection, sequence and the engines (ffmpeg/ffprobe/whisper-cli paths, versions, encoders, filters, whisper models, SFX folder).',
    '1a. Word timings, envelopes, loudness and shot cuts come from `smoothy_analyze` (transcribe_words gives DTW words in source seconds with fillers flagged). If it reports E_MODEL_MISSING, call install_model "small.en".',
    '1b. Need a custom filter graph, probe or transcript? Use `smoothy_engine` with the bundled ffmpeg, ffprobe or whisper-cli. Do not install media tools. Read `smoothy_help` topic "engine" once; topics "gotchas", "workflow-longform", "premiere" and "audio" hold known pitfalls and recipes.',
    '1c. Cut by phrase with `smoothy_cut`: cut_phrases (rows of near/from/to phrases → clips snapped into silence), then verify_edit, fix, repeat; captions and chapters from the same clips. See topic "workflow-longform".',
    '1d. Hand off to Premiere with `smoothy_nle`: export_xml (versioned, never overwrites), import_xml (new sequence), and before every new version live_diff so you start from the editor\'s cut. Read topic "premiere".',
    '2. Read the sequence with `smoothy_project` before proposing a cut. Use clip refs and source ranges; do not guess timing.',
    '3. Use `smoothy_media` for preview frames and contact sheets. Never dump raw logs or base64 media into the conversation.',
    '4. Removing noise is hard when you cannot hear: call `smoothy_audio` action "diagnose" first to measure noise floor, speech level, SNR and rumble (works immediately with bundled ffmpeg). Then run `smoothy_audio` action "denoise" for direct neural noise removal (no music split!), "separate" to split voice & music, or "isolate" to strip both music and noise. Check the returned before/after metrics (noiseReductionDb, speechDeltaDb, snrGainDb), use from/to to test a short slice first, adjust strength (0.7–1.0) or voiceChain:true, and pass apply:true to swap cleaned audio directly onto your headless edit project. If it returns E_MODEL_MISSING, call smoothy_audio action "setup" (the person approves the one-time download).',
    '5. The editor leaves timecoded notes for you in the app. Read them with `smoothy_review` action "list" (or "wait" for new ones), fix what each note asks, then reply on that note with what you changed. You do not write notes and you do not mark them fixed; the editor does. When working headless, point the app preview at the file with action "preview" {path,time,name}.',
    '6. Marker edits are mutating and require approval in the Smoothy window. Never assume they ran.',
    '6b. No editor? Build the edit yourself: `smoothy_edit` new → import {paths} → ops (batch many per call, times in seconds) → `smoothy_render` frame/sheet to check it → export (the editor approves) → `smoothy_jobs` wait. Originals are never changed. Check `warnings` after every ops call and fix overlaps and gaps.',
    '6c. You cannot hear: use `smoothy_render` analyze for loudness and silence, `smoothy_edit` transcribe to read the speech with timecodes, cut_silence for dead air and multicam to cut synced cameras by speaker. Music and stock come from `smoothy_library` (the editor approves downloads); always tell the editor each asset\'s licence and credit.',
    '7. Keep replies short. Return timecodes in HH:MM:SS:FF and paths only when the next action needs them. Large results come back as a preview plus `resultFile` (full JSON on disk); pass detail:true for more inline.',
    '7b. Long work runs as jobs with an ETA. Wait with `smoothy_jobs` wait (timeoutMs about the ETA) instead of polling. Never overwrite a previous version\'s output; use `smoothy_edit` snapshot before big changes.',
    '8. If an editor is offline, use preview/media/review tools and say what needs Premiere or Resolve.',
    '',
    '## Tool map',
    ''
  ];
  for (const tool of AGENT_TOOLS) lines.push(`- \`${tool.name}\` — ${tool.description}`);
  lines.push('', '## Typical review loop', '', '1. list the editor\'s open notes', '2. inspect the sequence and pull 3–6 frames around each timecode', '3. make the fix on a copy, never the original timeline', '4. reply on the note with what you changed', '5. wait for new notes or a reply', '');
  return lines.join('\n');
}

class AgentService {
  private server: http.Server | null = null;
  private port = DEFAULT_PORT;
  private enabled = true;
  private startedAt: string | null = null;
  private readonly token: string;
  private readonly agentDir: string;
  private readonly artifactsDir: string;
  private readonly frameCacheDir: string;
  private readonly discoveryFile: string;
  private readonly review: ReviewStore;
  private readonly edit: EditEngine;
  private readonly analysis: AnalysisEngine;
  private readonly cut: CutEngine;
  private readonly nle: NleEngine;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly activity: Activity[] = [];
  private previewTarget: any = null;
  private readonly clients = new Map<string, number>();
  /** Agent sessions already counted as `agent_session_start` (bounded, newest kept). */
  private readonly countedSessions = new Set<string>();
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly events = new EventEmitter();
  /** Approval kinds the editor allowed for the rest of this session. */
  private readonly sessionGrants = new Set<string>();
  /** Folders the editor allowed the agent to write into this session. */
  private readonly writeGrants = new Set<string>();
  private readonly resultsDir: string;
  private readonly resultCache: ResultCache;
  private engineInfo: Promise<EngineInfo> | null = null;

  constructor(private readonly deps: AgentServiceDeps) {
    this.agentDir = path.join(deps.userData, 'agent');
    this.artifactsDir = path.join(this.agentDir, 'artifacts');
    this.frameCacheDir = path.join(this.agentDir, 'cache', 'frames');
    this.discoveryFile = path.join(this.agentDir, 'agent.json');
    this.review = new ReviewStore(path.join(this.agentDir, 'review.json'));
    this.resultsDir = path.join(this.agentDir, 'results');
    this.resultCache = new ResultCache(path.join(this.agentDir, 'cache', 'results'));
    this.edit = new EditEngine({
      root: path.join(this.agentDir, 'projects'),
      ffmpeg: deps.ffmpeg,
      ffprobe: deps.ffprobe,
      home: os.homedir(),
      userData: deps.userData,
      requestApproval: (tool, args) => this.requestApproval(tool, args),
      startJob: (kind, runner) => this.startJob(kind, runner),
      trackTool: id => deps.trackTool?.(id),
      speech: deps.edit?.speech || null,
      library: deps.edit?.library || null,
      cache: this.resultCache,
      sfxDir: deps.engines?.sfxDir || null,
      photos: {
        search: (query, signal) => searchCommonsPhotos(deps.fetcher || (globalThis.fetch as unknown as Fetcher), query, signal),
        download: (hit, file, maxWidth, signal) => downloadPhoto(deps.fetcher || (globalThis.fetch as unknown as Fetcher), hit, file, maxWidth, signal)
      },
      prepareFolder: folder => this.prepareFolder(folder, 'smoothy_edit.folder')
    });
    this.analysis = new AnalysisEngine({
      ffmpeg: deps.ffmpeg,
      ffprobe: deps.ffprobe,
      home: os.homedir(),
      userData: deps.userData,
      whisper: () => deps.engines?.whisper?.() || null,
      installer: deps.engines?.installer || null,
      cache: this.resultCache,
      outDir: async () => {
        const folder = await this.edit.activeFolder();
        return folder ? path.join(folder, 'Work') : path.join(this.agentDir, 'analysis');
      },
      startJob: (kind, runner) => this.startJob(kind, runner),
      waitJob: (id, ms) => this.waitJob(id, ms),
      requestApproval: (tool, args) => this.requestApproval(tool, args),
      trackTool: id => deps.trackTool?.(id),
      vision: new VisionEngine({
        ffmpeg: deps.ffmpeg,
        ffprobe: deps.ffprobe,
        home: os.homedir(),
        userData: deps.userData,
        visionHelper: () => (process.platform === 'darwin' ? deps.engines?.visionHelper || null : null),
        cache: this.resultCache,
        outDir: async () => {
          const folder = await this.edit.activeFolder();
          return folder ? path.join(folder, 'Work') : path.join(this.agentDir, 'analysis');
        },
        readClips: async value => {
          let list: any = value;
          if (typeof value === 'string') {
            const real = await fs.realpath(path.resolve(value)).catch(() => '');
            if (!real || !within(real, this.readRoots())) throw Object.assign(new Error('clips must be a readable clips.json path or an array.'), { code: 'E_BAD_REQUEST' });
            const data = JSON.parse(await fs.readFile(real, 'utf8'));
            list = Array.isArray(data) ? data : data?.clips;
          }
          if (!Array.isArray(list)) throw Object.assign(new Error('clips must be a clips.json path or an array.'), { code: 'E_BAD_REQUEST' });
          return list.slice(0, 3000).map((clip: any, i: number) => normalizeClip(clip, i)).filter(clip => clip.srcOut > clip.srcIn).map(clip => ({ id: clip.id, srcIn: clip.srcIn, srcOut: clip.srcOut }));
        },
        applyOps: ops => this.edit.edit({ action: 'ops', ops }),
        projectClips: async () => {
          const project = await this.edit.store.active();
          return project.clips.map(clip => ({ id: clip.id, kind: clip.kind, name: clip.name, meta: clip.meta, assetPath: clip.asset ? project.assets[clip.asset]?.path : undefined, srcIn: clip.in, srcOut: clip.out }));
        },
        startJob: (kind, runner) => this.startJob(kind, runner),
        waitJob: (id, ms) => this.waitJob(id, ms),
        trackTool: id => deps.trackTool?.(id)
      })
    });
    this.cut = new CutEngine({
      ffmpeg: deps.ffmpeg,
      ffprobe: deps.ffprobe,
      readRoots: () => this.readRoots(),
      whisper: () => deps.engines?.whisper?.() || null,
      cache: this.resultCache,
      workDir: async () => {
        const folder = await this.edit.activeFolder();
        return folder ? path.join(folder, 'Work') : path.join(this.agentDir, 'analysis');
      },
      editDir: async () => {
        const folder = await this.edit.activeFolder();
        return folder ? path.join(folder, 'Edit') : path.join(this.agentDir, 'analysis', 'deliverables');
      },
      uniquePath,
      placeClips: (source, clips) => this.edit.appendClips(source, clips),
      startJob: (kind, runner) => this.startJob(kind, runner),
      waitJob: (id, ms) => this.waitJob(id, ms),
      trackTool: id => deps.trackTool?.(id)
    });
    this.nle = new NleEngine({
      activeProject: () => this.edit.store.active(),
      exportDir: project => project.folder ? path.join(project.folder, 'Edit') : path.join(this.agentDir, 'exports', project.id),
      workDir: async () => {
        const folder = await this.edit.activeFolder();
        return folder ? path.join(folder, 'Work') : path.join(this.agentDir, 'analysis');
      },
      uniquePath,
      readRoots: () => this.readRoots(),
      within,
      getActiveNLE: () => deps.getActiveNLE(),
      isEditorConnected: () => deps.isEditorConnected(),
      getSequenceInfo: () => deps.getSequenceInfo(),
      requestSequenceInfo: () => deps.requestSequenceInfo(),
      importXml: deps.importXml,
      applyWithSnapshot: (ops, label) => this.edit.applyWithSnapshot(ops, label),
      requestApproval: (tool, args) => this.requestApproval(tool, args),
      trackTool: id => deps.trackTool?.(id)
    });
    this.token = String(deps.store.get('agent.token') || '') || randomBytes(32).toString('hex');
    if (deps.store.get('agent.token') !== this.token) deps.store.set('agent.token', this.token);
    this.enabled = deps.store.get('agent.enabled', true) !== false;
    this.events.setMaxListeners(50);
  }

  async start(): Promise<void> {
    await this.review.load();
    installPreviewProtocol(this.deps.userData);
    if (!this.enabled || this.server) return;
    await this.listen();
  }

  private async listen(): Promise<void> {
    const start = Math.max(1024, Number(this.deps.store.get('agent.port', DEFAULT_PORT)) || DEFAULT_PORT);
    for (let port = start; port < start + 20; port += 1) {
      try {
        await this.listenOn(port);
        this.port = port;
        this.deps.store.set('agent.port', port);
        this.startedAt = new Date().toISOString();
        await this.writeDiscovery();
        this.emit('status', this.state());
        console.log(`[Agent] MCP listening on http://127.0.0.1:${port}/mcp`);
        return;
      } catch (error: any) {
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('Could not find a free loopback port for the Agent Bridge.');
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { void this.handleRequest(req, res); });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', error => console.error('[Agent] Server error:', error.message));
        this.server = server;
        resolve();
      });
    });
  }

  private async writeDiscovery(): Promise<void> {
    await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.agentDir, 'token'), this.token, { mode: 0o600 });
    await fs.writeFile(this.discoveryFile, JSON.stringify({
      app: 'SmoothyEdit',
      version: this.deps.appVersion,
      protocolVersion: MCP_PROTOCOL_VERSION,
      port: this.port,
      url: this.url(),
      pid: process.pid,
      startedAt: this.startedAt
    }, null, 2), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    for (const approval of this.approvals.values()) {
      clearTimeout(approval.timer);
      approval.resolve(null);
    }
    this.approvals.clear();
    this.revokeGrants();
    for (const job of this.jobs.values()) job.controller.abort();
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
    const server = this.server;
    this.server = null;
    this.startedAt = null;
    await fs.rm(this.discoveryFile, { force: true }).catch(() => {});
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  private clientCount(): number {
    const now = Date.now();
    return [...this.clients.values()].filter(last => now - last < 120000).length;
  }

  state(): any {
    const sequence = this.deps.getSequenceInfo();
    const activeNLE = this.deps.getActiveNLE();
    return {
      enabled: this.enabled,
      locked: Boolean(this.deps.allowed && !this.deps.allowed()),
      running: Boolean(this.server),
      port: this.port,
      url: this.url(),
      healthUrl: `http://127.0.0.1:${this.port}/health`,
      token: this.token,
      protocolVersion: MCP_PROTOCOL_VERSION,
      startedAt: this.startedAt,
      clients: this.clientCount(),
      tools: AGENT_TOOLS.map(tool => ({ name: tool.name, description: tool.description, annotations: tool.annotations })),
      editor: {
        active: activeNLE,
        connected: this.deps.isEditorConnected(),
        sequence: sequence?.hasSequence ? {
          name: sequence.name,
          id: sequence.id,
          duration: Number(sequence.duration) || 0,
          fps: Number(sequence.fps) || 30,
          revision: Number(sequence.timelineRevision) || 0
        } : null
      },
      preview: this.previewTarget,
      review: this.review.count(),
      grants: this.grantsSummary(),
      activity: this.activity.slice(-20)
    };
  }

  private grantsSummary(): { approvals: string[]; folders: string[] } {
    return { approvals: [...this.sessionGrants], folders: [...this.writeGrants] };
  }

  revokeGrants(): void {
    this.sessionGrants.clear();
    this.writeGrants.clear();
    this.emit('status', this.state());
  }

  async setEnabled(enabled: boolean): Promise<any> {
    this.enabled = Boolean(enabled);
    this.deps.store.set('agent.enabled', this.enabled);
    if (this.enabled) await this.start();
    else await this.stop();
    this.emit('status', this.state());
    return this.state();
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) && host) {
      this.send(res, 403, { error: 'Forbidden host.' });
      return;
    }
    if (req.headers.origin) {
      this.send(res, 403, { error: 'Browser origins are not allowed.' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${host || '127.0.0.1'}`);
    } catch {
      this.send(res, 400, { error: 'Malformed request URL.' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      this.send(res, 200, { ok: true, app: 'SmoothyEdit', protocolVersion: MCP_PROTOCOL_VERSION });
      return;
    }
    if (!this.authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      this.send(res, 401, { error: 'Missing or invalid Agent Bridge token.' });
      return;
    }
    this.clients.set(req.socket.remoteAddress || 'local', Date.now());
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        this.send(res, 200, await this.callTool('smoothy_status', {}, 'http'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        this.send(res, 200, this.state());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/call') {
        const body = await this.readJson(req);
        const result = await this.callTool(String(body?.tool || ''), body?.args && typeof body.args === 'object' ? body.args : {}, 'http');
        this.send(res, 200, result);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        await this.handleMcp(req, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/mcp') {
        // Streamable HTTP clients may open the optional server-to-client stream.
        this.openEvents(req, res);
        return;
      }
      if (req.method === 'DELETE' && url.pathname === '/mcp') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        this.openEvents(req, res);
        return;
      }
      this.send(res, 404, { error: 'Not found.' });
    } catch (error: any) {
      const status = error?.code === 'E_BAD_REQUEST' ? 400 : 500;
      this.send(res, status, { ok: false, error: error?.message || 'Agent request failed.' });
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = String(req.headers.authorization || '');
    const bearer = header.replace(/^Bearer\s+/i, '').trim();
    const alternate = String(req.headers['x-smoothy-agent-token'] || '').trim();
    const matches = (candidate: string) => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(this.token);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    return matches(bearer) || matches(alternate);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Request body is too large.'), { code: 'E_BAD_REQUEST' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const text = await this.readBody(req);
    if (!text.trim()) return {};
    try { return JSON.parse(text); }
    catch { throw Object.assign(new Error('Invalid JSON body.'), { code: 'E_BAD_REQUEST' }); }
  }

  private send(res: http.ServerResponse, status: number, value: unknown): void {
    if (res.headersSent) return;
    const text = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private openEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');
    this.sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(keepAlive); this.sseClients.delete(res); });
  }

  private emit(type: string, data: unknown): void {
    const payload = { type, data, at: new Date().toISOString() };
    const win = this.deps.window();
    if (win && !win.isDestroyed()) win.webContents.send('agent-event', payload);
    for (const client of this.sseClients) {
      try { client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    }
  }

  private logActivity(tool: string, ok: boolean, ms: number, source: Activity['source'], summary: string): void {
    const entry: Activity = { id: randomUUID(), tool, ok, ms, source, summary: summary.slice(0, 240), at: new Date().toISOString() };
    this.activity.push(entry);
    if (this.activity.length > 100) this.activity.shift();
    this.emit('activity', entry);
  }

  private error(code: AgentToolError['code'], message: string, next?: string): AgentResult {
    return { ok: false, error: { code, message, next } };
  }

  private normalizeError(error: any): AgentToolError {
    const code = typeof error?.code === 'string' && error.code.startsWith('E_') ? error.code : 'E_INTERNAL';
    const message = error?.message || 'Agent tool failed.';
    const next = /editor|premiere|resolve/i.test(message) ? 'Open the editor and refresh the sequence, then retry.' : undefined;
    return { code: code as AgentToolError['code'], message, next };
  }

  async callTool(name: string, args: any = {}, source: 'mcp' | 'http' | 'ui' = 'http', session = ''): Promise<AgentResult> {
    const started = Date.now();
    const tool = AGENT_TOOLS.find(item => item.name === name);
    if (this.deps.allowed && !this.deps.allowed()) return this.error('E_PRO_REQUIRED', 'The Smoothy Agent Bridge is part of Smoothy Pro.', 'Upgrade at smoothyedit.com/pricing, then sign in to the app with that account.');
    if (!tool) return this.error('E_NOT_FOUND', `Unknown tool: ${name}`, 'Call smoothy_help to list tools.');
    try {
      const input = args && typeof args === 'object' ? args : {};
      if (tool.name === 'smoothy_timeline' && source !== 'ui') {
        const approved = await this.requestApproval(tool.name, input);
        if (!approved) return this.error('E_APPROVAL_TIMEOUT', 'The editor did not approve this timeline action.', 'Open the Agentic tab and approve or deny the request.');
      }
      let result = await this.dispatch(tool.name, input, source);
      const ms = Date.now() - started;
      if (source !== 'ui') this.logActivity(name, Boolean(result.ok), ms, source, result.ok ? this.summary(name, result.data) : result.error?.code || 'error');
      if (source !== 'ui' && result.ok) this.countSession(session || source, name);
      if (source !== 'ui' && result.ok && name !== 'smoothy_help' && result.data !== undefined) {
        // Keep the agent's context small: big results become a preview plus a file.
        const compact = await compactData(result.data, { limit: input.detail === true ? DETAIL_LIMIT : RESULT_LIMIT, dir: this.resultsDir, name }).catch(() => null);
        if (compact?.truncated) result = { ...result, data: compact.data, meta: { ...(result.meta || {}), truncated: true } };
      }
      return { ...result, meta: { ...(result.meta || {}), ms, tool: name } };
    } catch (error: any) {
      const ms = Date.now() - started;
      const normalized = this.normalizeError(error);
      this.logActivity(name, false, ms, source, normalized.code);
      return { ok: false, error: normalized, meta: { ms, tool: name } };
    }
  }

  /**
   * `agent_session_start`: one agent session that made its first successful
   * working tool call. MCP sessions are keyed by their Mcp-Session-Id; direct
   * HTTP callers (no session) count once per app run. Discovery calls
   * (status/help), failed or Pro-locked calls and the app's own UI add none.
   */
  private countSession(key: string, name: string): void {
    if (name === 'smoothy_status' || name === 'smoothy_help') return;
    if (this.countedSessions.has(key)) return;
    if (this.countedSessions.size >= 200) {
      const oldest = this.countedSessions.values().next().value;
      if (oldest !== undefined) this.countedSessions.delete(oldest);
    }
    this.countedSessions.add(key);
    try {
      this.deps.trackTool?.('agent_session_start');
    } catch {
      // Analytics never blocks an agent call.
    }
  }

  private summary(name: string, data: any): string {
    if (name === 'smoothy_media') return `${data?.action || 'media'} ${data?.width || ''}x${data?.height || ''}`.trim();
    if (name === 'smoothy_project') return data?.sequence?.name || data?.action || 'project';
    if (name === 'smoothy_review') return `${data?.action || 'review'} ${data?.thread?.timecode || data?.threads?.length || ''}`.trim();
    if (name === 'smoothy_audio') return `${data?.action || 'audio'} ${data?.jobId || ''}`.trim();
    if (name === 'smoothy_edit') return `${data?.action || 'edit'} ${data?.clips ?? ''}`.trim();
    if (name === 'smoothy_render') return `${data?.action || 'render'} ${data?.timecode || data?.frames || data?.jobId || ''}`.trim();
    if (name === 'smoothy_library') return `${data?.action || 'library'} ${data?.count ?? data?.jobId ?? ''}`.trim();
    if (name === 'smoothy_jobs') return `${data?.action || 'job'} ${data?.job?.status || ''}`.trim();
    if (name === 'smoothy_nle') return `${data?.action || 'nle'} ${data?.sequenceName || data?.liveSequence || ''}`.trim();
    if (name === 'smoothy_cut') return `${data?.action || 'cut'} ${data?.clips ?? data?.similarity ?? data?.cues ?? data?.count ?? data?.status ?? ''}`.trim();
    if (name === 'smoothy_analyze') return `${data?.action || 'analyze'} ${data?.words ?? data?.bins ?? data?.count ?? data?.status ?? ''}`.trim();
    if (name === 'smoothy_engine') return `${data?.tool || 'engine'} ${data?.exitCode !== undefined ? `exit ${data.exitCode}` : data?.status || ''}`.trim();
    return typeof data === 'object' ? 'ok' : String(data ?? 'ok');
  }

  private async dispatch(name: string, input: any, source: 'mcp' | 'http' | 'ui'): Promise<AgentResult> {
    switch (name) {
      case 'smoothy_status': return this.toolStatus();
      case 'smoothy_help': return this.toolHelp(input);
      case 'smoothy_project': return this.toolProject(input);
      case 'smoothy_media': return this.toolMedia(input);
      case 'smoothy_review': return this.toolReview(input, source);
      case 'smoothy_timeline': return this.toolTimeline(input);
      case 'smoothy_audio': return this.toolAudio(input);
      case 'smoothy_edit': return this.edit.edit(input);
      case 'smoothy_render': return this.edit.render(input);
      case 'smoothy_library': return this.edit.library(input);
      case 'smoothy_jobs': return this.toolJobs(input);
      case 'smoothy_engine': return this.toolEngine(input);
      case 'smoothy_analyze': return this.analysis.run(input);
      case 'smoothy_cut': return this.cut.run(input);
      case 'smoothy_nle': return this.nle.run(input);
      default: return this.error('E_NOT_FOUND', `Unknown tool: ${name}`);
    }
  }

  private async toolStatus(): Promise<AgentResult> {
    const sequence = this.deps.getSequenceInfo();
    let audio: any = null;
    try { audio = this.deps.audioService ? await this.deps.audioService.state() : null; } catch {}
    return {
      ok: true,
      data: {
        app: { name: 'SmoothyEdit', version: this.deps.appVersion, platform: process.platform },
        agent: { enabled: this.enabled, running: Boolean(this.server), url: this.url(), protocolVersion: MCP_PROTOCOL_VERSION, tools: AGENT_TOOLS.length, clients: this.clientCount() },
        editor: {
          active: this.deps.getActiveNLE(),
          connected: this.deps.isEditorConnected(),
          sequence: sequence?.hasSequence ? {
            name: sequence.name,
            id: sequence.id,
            duration: Number(sequence.duration) || 0,
            fps: Number(sequence.fps) || 30,
            revision: Number(sequence.timelineRevision) || 0,
            markerCount: Number(sequence.markerCount) || 0
          } : null
        },
        engines: { ...(await this.engines()), audio },
        edit: { project: this.edit.store.currentId(), folder: await this.edit.activeFolder() },
        approvals: this.grantsSummary(),
        help: topicList().map(item => item.topic),
        preview: this.previewTarget,
        review: this.review.count(),
        limits: { markerBatch: MAX_MARKERS, previewWidth: 1920, requestBytes: MAX_BODY }
      }
    };
  }

  private toolHelp(input: any): AgentResult {
    if (input?.skill === true) return { ok: true, data: { markdown: skillMarkdown(), tools: AGENT_TOOLS.map(tool => tool.name), topics: topicList() } };
    const topic = typeof input?.topic === 'string' ? input.topic.trim().toLowerCase() : '';
    if (topic) {
      const entry = HELP_TOPICS[topic];
      if (!entry) return this.error('E_NOT_FOUND', `Unknown help topic: ${topic}`, `Topics: ${Object.keys(HELP_TOPICS).join(', ')}.`);
      return { ok: true, data: { topic, title: entry.title, markdown: entry.markdown } };
    }
    const requested = typeof input?.tool === 'string' ? input.tool.trim() : '';
    if (requested) {
      const tool = AGENT_TOOLS.find(item => item.name === requested);
      if (!tool) return this.error('E_NOT_FOUND', `Unknown tool: ${requested}`);
      return { ok: true, data: { tool } };
    }
    return {
      ok: true,
      data: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        tools: AGENT_TOOLS,
        topics: topicList(),
        rules: [
          'Call smoothy_status first.',
          'Read with smoothy_project before proposing edits.',
          'Preview with smoothy_media; do not dump raw logs or base64.',
          'Use smoothy_review for human feedback.',
          'Timeline actions require approval in the Smoothy window.',
          'Run ffmpeg/ffprobe/whisper-cli through smoothy_engine; never install them. Read topic "engine" first.'
        ]
      }
    };
  }

  private compactSequence(sequence: any, maxClips = 500): any {
    if (!sequence?.hasSequence) {
      return { hasSequence: false, editor: { active: this.deps.getActiveNLE(), connected: this.deps.isEditorConnected() } };
    }
    const videoTracks = (Array.isArray(sequence.videoTracks) ? sequence.videoTracks : []).map((track: any) => ({
      index: Number(track.index) || 0,
      name: track.name || '',
      clips: (track.clips || []).slice(0, maxClips).map((clip: any, index: number) => ({
        ref: `v${Number(track.index) || 0}c${index}`,
        name: clip.name || '',
        path: clip.path || '',
        start: Number(clip.start) || 0,
        end: Number(clip.end) || 0,
        in: Number(clip.inPoint) || 0,
        out: Number(clip.outPoint) || 0,
        reversed: Boolean(clip.reversed),
        disabled: Boolean(clip.disabled)
      }))
    }));
    const audioTracks = (Array.isArray(sequence.audioTracks) ? sequence.audioTracks : []).map((track: any) => ({
      index: Number(track.index) || 0,
      name: track.name || '',
      clips: (track.clips || []).slice(0, maxClips).map((clip: any, index: number) => ({
        ref: `a${Number(track.index) || 0}c${index}`,
        name: clip.name || '',
        path: clip.path || '',
        start: Number(clip.start) || 0,
        end: Number(clip.end) || 0,
        in: Number(clip.inPoint) || 0,
        out: Number(clip.outPoint) || 0,
        disabled: Boolean(clip.disabled)
      }))
    }));
    return {
      hasSequence: true,
      name: sequence.name,
      id: sequence.id,
      duration: Number(sequence.duration) || 0,
      fps: Number(sequence.fps) || 30,
      width: Number(sequence.width) || 0,
      height: Number(sequence.height) || 0,
      markerCount: Number(sequence.markerCount) || 0,
      revision: Number(sequence.timelineRevision) || 0,
      videoTracks,
      audioTracks,
      counts: {
        videoTracks: videoTracks.length,
        audioTracks: audioTracks.length,
        videoClips: videoTracks.reduce((sum: number, track: any) => sum + track.clips.length, 0),
        audioClips: audioTracks.reduce((sum: number, track: any) => sum + track.clips.length, 0)
      }
    };
  }

  private async toolProject(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'inspect');
    if (action === 'refresh') {
      this.deps.requestSequenceInfo();
      await new Promise(resolve => setTimeout(resolve, 600));
      return { ok: true, data: { action, sequence: this.compactSequence(this.deps.getSequenceInfo(), 800) } };
    }
    if (action === 'effects_catalog') {
      if (!this.deps.isEditorConnected()) return this.error('E_EDITOR_OFFLINE', 'Connect Premiere to read its effect catalog.', 'Open Premiere, load the Smoothy panel, then retry.');
      const catalog = await getShortsCutsCatalog();
      const query = String(input?.query || '').toLowerCase();
      const limit = Math.max(1, Math.min(200, Number(input?.limit) || 40));
      const filter = (items: unknown) => (Array.isArray(items) ? items : [])
        .map((item: any) => typeof item === 'string' ? item : item?.name)
        .filter((name): name is string => typeof name === 'string' && (!query || name.toLowerCase().includes(query)))
        .slice(0, limit);
      return {
        ok: true,
        data: {
          action,
          query,
          counts: {
            videoEffects: Array.isArray(catalog?.videoEffects) ? catalog.videoEffects.length : 0,
            audioEffects: Array.isArray(catalog?.audioEffects) ? catalog.audioEffects.length : 0,
            videoTransitions: Array.isArray(catalog?.videoTransitions) ? catalog.videoTransitions.length : 0,
            audioTransitions: Array.isArray(catalog?.audioTransitions) ? catalog.audioTransitions.length : 0
          },
          videoEffects: filter(catalog?.videoEffects),
          audioEffects: filter(catalog?.audioEffects),
          videoTransitions: filter(catalog?.videoTransitions),
          audioTransitions: filter(catalog?.audioTransitions)
        }
      };
    }
    return { ok: true, data: { action: 'inspect', sequence: this.compactSequence(this.deps.getSequenceInfo()) } };
  }

  private async toolMedia(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'frame');
    const sequence = this.deps.getSequenceInfo();
    const fps = Number(sequence?.fps) || 30;
    const time = Number(input?.time) || 0;
    const width = Math.max(160, Math.min(1920, Number(input?.width) || 960));
    if (action === 'probe') {
      const file = await resolveMediaPath(input?.path, os.homedir(), this.deps.userData);
      const probe: ProbeResult = await probeMedia(this.deps.ffprobe, file);
      return { ok: true, data: { action, probe } };
    }
    if (action === 'contact_sheet') {
      const file = await resolveMediaPath(input?.path, os.homedir(), this.deps.userData);
      const times = Array.isArray(input?.times) ? input.times.map(Number) : [];
      if (!times.length) return this.error('E_BAD_REQUEST', 'Provide times for the contact sheet.', 'Pass times as seconds, up to 24 values.');
      const sheet = await contactSheet({ ffmpeg: this.deps.ffmpeg, file, times, width: Math.max(160, Math.min(480, Number(input?.width) || 320)), cacheDir: this.frameCacheDir, fps });
      return {
        ok: true,
        data: { action, file, times: times.slice(0, 24), width: sheet.width, height: sheet.height, bytes: sheet.buffer.length, cached: sheet.cached, path: sheet.path },
        imageDataUrl: await toDataUrl(sheet.buffer, sheet.mime)
      };
    }
    let file = typeof input?.path === 'string' && input.path.trim() ? await resolveMediaPath(input.path, os.homedir(), this.deps.userData) : '';
    let sourceTime = time;
    let clipRef: string | null = null;
    if (!file) {
      const frame = sequenceFrameAt(sequence, time);
      if (!frame) return this.error('E_NO_MEDIA_AT_TIME', `No enabled video clip at ${formatTimecode(time, fps)}.`, 'Refresh the sequence or pass an explicit media path.');
      file = await resolveMediaPath(frame.path, os.homedir(), this.deps.userData);
      sourceTime = frame.sourceTime;
      clipRef = `v${frame.trackIndex}`;
    }
    const frame = await extractFrame({ ffmpeg: this.deps.ffmpeg, file, time: sourceTime, width, cacheDir: this.frameCacheDir });
    return {
      ok: true,
      data: {
        action: 'frame',
        file,
        sourceTime,
        time,
        timecode: formatTimecode(time, fps),
        clipRef,
        width: frame.width,
        height: frame.height,
        bytes: frame.buffer.length,
        cached: frame.cached,
        path: frame.path
      },
      imageDataUrl: await toDataUrl(frame.buffer, frame.mime)
    };
  }

  private async saveScreenshot(buffer: Buffer, mime: string, extension: string, width?: number, height?: number): Promise<ReviewScreenshot> {
    await fs.mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const file = path.join(this.artifactsDir, `${id}.${extension}`);
    await fs.writeFile(file, buffer, { mode: 0o600 });
    return { id, path: file, mime, width, height, bytes: buffer.length };
  }

  private async captureForReview(input: any): Promise<ReviewScreenshot | null> {
    try {
      if (typeof input?.screenshotDataUrl === 'string' && input.screenshotDataUrl.trim()) {
        const parsed = parseDataUrl(input.screenshotDataUrl);
        const metadata = await sharp(parsed.buffer).metadata();
        return await this.saveScreenshot(parsed.buffer, parsed.mime, parsed.extension, metadata.width, metadata.height);
      }
      if (input?.capture !== true && !input?.captureFrame) return null;
      const sequence = this.deps.getSequenceInfo();
      const fps = Number(sequence?.fps) || 30;
      const time = Number(input?.time) || 0;
      let file = typeof input?.path === 'string' && input.path.trim() ? await resolveMediaPath(input.path, os.homedir(), this.deps.userData) : '';
      let sourceTime = time;
      if (!file && this.previewTarget?.path) {
        file = await resolveMediaPath(this.previewTarget.path, os.homedir(), this.deps.userData);
        sourceTime = time;
      }
      if (!file) {
        const frame = sequenceFrameAt(sequence, time);
        if (!frame) return null;
        file = await resolveMediaPath(frame.path, os.homedir(), this.deps.userData);
        sourceTime = frame.sourceTime;
      }
      const frame = await extractFrame({ ffmpeg: this.deps.ffmpeg, file, time: sourceTime, width: 960, cacheDir: this.frameCacheDir });
      return await this.saveScreenshot(frame.buffer, frame.mime, 'jpg', frame.width, frame.height);
    } catch {
      return null;
    }
  }

  private async toolReview(input: any, source: 'mcp' | 'http' | 'ui'): Promise<AgentResult> {
    const action = String(input?.action || 'list');
    const sequence = this.deps.getSequenceInfo();
    const fps = Number(sequence?.fps) || Number(this.previewTarget?.fps) || 30;
    const author = source === 'ui' ? 'user' : 'agent';
    if (action === 'preview') {
      if (!input?.path) return this.error('E_BAD_REQUEST', 'Provide a media path for the agent preview.');
      const file = await resolveMediaPath(input.path, os.homedir(), this.deps.userData);
      const probe = await probeMedia(this.deps.ffprobe, file);
      const preview = {
        path: file,
        name: String(input?.name || path.basename(file)).slice(0, 200),
        time: Math.max(0, Number(input?.time) || 0),
        duration: Number(probe.duration) || 0,
        fps: Number(probe.video?.fps) || Number(sequence?.fps) || 30,
        width: Number(probe.video?.width) || 0,
        height: Number(probe.video?.height) || 0,
        source: 'agent'
      };
      this.previewTarget = preview;
      this.emit('preview', preview);
      return { ok: true, data: { action, preview } };
    }
    if (action === 'list') {
      // Only the editor's notes are tasks; older agent-written notes are not shown.
      const threads = this.review.list({ since: input?.since, includeResolved: Boolean(input?.includeResolved) }).filter(thread => thread.author !== 'agent');
      return {
        ok: true,
        data: {
          action,
          threads: threads.map(thread => ({
            id: thread.id,
            time: thread.time,
            timecode: thread.timecode,
            frame: thread.frame,
            author: thread.author,
            status: thread.status,
            body: thread.body,
            createdAt: thread.createdAt,
            screenshot: thread.screenshot ? { id: thread.screenshot.id, path: thread.screenshot.path, mime: thread.screenshot.mime, width: thread.screenshot.width, height: thread.screenshot.height } : null,
            replies: thread.replies,
            drawing: thread.drawing
          })),
          latest: this.review.latestStamp(),
          counts: this.review.count()
        }
      };
    }
    if ((action === 'add' || action === 'resolve') && source !== 'ui') {
      return this.error('E_BAD_REQUEST', action === 'add' ? 'Notes are written by the editor. Reply to a note with what you changed instead.' : 'Only the editor marks a note as fixed. Reply with what you changed.', 'Use smoothy_review action "reply" with the note id.');
    }
    if (action === 'add') {
      const time = Math.max(0, Number(input?.time) || 0);
      const screenshot = await this.captureForReview(input);
      const drawing = Array.isArray(input?.drawing) ? input.drawing : [];
      const thread = await this.review.add({
        time,
        timecode: formatTimecode(time, fps),
        frame: Math.round(time * fps),
        body: String(input?.body || ''),
        author,
        sequenceId: sequence?.id || null,
        sequenceName: sequence?.name || null,
        revision: Number(sequence?.timelineRevision) || null,
        drawing,
        screenshot
      });
      if (source === 'ui') this.deps.trackTool?.('agent_review_note');
      this.emit('review', { action: 'add', thread });
      return { ok: true, data: { action, thread, counts: this.review.count() } };
    }
    if (action === 'reply') {
      const thread = await this.review.reply(String(input?.id || ''), String(input?.body || ''), author);
      this.emit('review', { action: 'reply', thread });
      return { ok: true, data: { action, thread } };
    }
    if (action === 'resolve') {
      const thread = await this.review.resolve(String(input?.id || ''), input?.resolved !== false);
      this.emit('review', { action: 'resolve', thread });
      return { ok: true, data: { action, thread } };
    }
    if (action === 'open') {
      const time = Math.max(0, Number(input?.time) || 0);
      if (this.previewTarget) this.previewTarget = { ...this.previewTarget, time };
      this.emit('seek', { time, timecode: formatTimecode(time, fps) });
      return { ok: true, data: { action, time, timecode: formatTimecode(time, fps) } };
    }
    if (action === 'wait') {
      const threads = await this.review.waitForChange(String(input?.since || ''), Number(input?.timeoutMs) || 25000);
      return { ok: true, data: { action, threads: threads.map(thread => ({ id: thread.id, time: thread.time, timecode: thread.timecode, author: thread.author, status: thread.status, body: thread.body, createdAt: thread.createdAt, replies: thread.replies })), latest: this.review.latestStamp() } };
    }
    return this.error('E_BAD_REQUEST', `Unknown review action: ${action}`);
  }

  private async toolTimeline(input: any): Promise<AgentResult> {
    const action = String(input?.action || '');
    if (action === 'markers_add') {
      if (!this.deps.isEditorConnected()) return this.error('E_EDITOR_OFFLINE', 'Connect Premiere or Resolve before adding markers.');
      const markers = (Array.isArray(input?.markers) ? input.markers : []).slice(0, MAX_MARKERS).map((marker: any) => ({
        time: Math.max(0, Number(marker?.time) || 0),
        endTime: Math.max(0, Number(marker?.endTime) || Number(marker?.time) || 0),
        name: String(marker?.name || 'Smoothy note').slice(0, 120),
        comment: String(marker?.comment || '').slice(0, 500)
      }));
      if (!markers.length) return this.error('E_BAD_REQUEST', 'Provide at least one marker.');
      const result = await this.deps.addMarkers(markers);
      if (result?.success ?? true) this.deps.trackTool?.('agent_marker_apply');
      return { ok: Boolean(result?.success ?? true), data: { action, markers: markers.length, result } };
    }
    if (action === 'markers_clear') {
      if (!this.deps.isEditorConnected()) return this.error('E_EDITOR_OFFLINE', 'Connect Premiere or Resolve before clearing markers.');
      const scope = input?.scope === 'all' ? 'all' : 'smoothy';
      const result = await this.deps.clearMarkers(scope, input?.sequenceId);
      return { ok: Boolean(result?.success ?? true), data: { action, scope, result } };
    }
    return this.error('E_BAD_REQUEST', `Unknown timeline action: ${action}`);
  }

  private async toolAudio(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'state');
    const audio = this.deps.audioService;
    if (action === 'state') {
      if (!audio) return this.error('E_NOT_IMPLEMENTED', 'Audio Cleanup is not available in this build.');
      const state = await audio.state();
      return {
        ok: true,
        data: {
          action,
          state,
          actions: ['diagnose', 'denoise', 'separate', 'isolate', 'setup'],
          note: state.ready
            ? 'Engine ready. Use diagnose first (no model needed), then denoise (direct noise removal), separate (voice & music), or isolate (strip music + noise).'
            : 'Engine not installed yet. diagnose works immediately; denoise/separate/isolate need action "setup" first.'
        }
      };
    }

    if (action === 'setup') {
      if (!audio) return this.error('E_NOT_IMPLEMENTED', 'Audio Cleanup is not available in this build.');
      const state = await audio.state();
      if (state.ready) return { ok: true, data: { action, alreadyReady: true, state } };
      if (state.busy) return this.error('E_BUSY', 'The audio engine is already busy.', 'Wait with smoothy_jobs, then retry setup.');
      const approved = await this.requestApproval('smoothy_audio.setup', {
        action: 'setup',
        note: 'Creates a Python 3.12 runtime and downloads PyTorch, ONNX and the noise-removal/separation models. This can be several GB.'
      });
      if (!approved) return this.error('E_APPROVAL_TIMEOUT', 'The editor did not approve the audio engine download.', 'Open the Agentic tab and approve the setup request.');
      let percent = 5;
      const job = this.startJob('audio.setup', async (progress, signal) => {
        progress(percent, 'Preparing local audio engine');
        const result = await audio.setup((data: any) => {
          const message = typeof data === 'string' ? data : data?.message || 'Setting up audio engine';
          if (data && Number(data.total) > 0 && Number(data.completed) >= 0) {
            percent = Math.max(percent, Math.min(94, 10 + Math.round((Number(data.completed) / Number(data.total)) * 78)));
          } else if (/install|download|prepar/i.test(message)) {
            percent = Math.max(percent, 24);
          }
          progress(percent, message);
        });
        signal.throwIfAborted();
        progress(100, 'Audio engine ready');
        return result;
      });
      return {
        ok: true,
        data: {
          action, jobId: job.id, status: job.status, state,
          note: 'The engine install runs as a background job. Poll smoothy_jobs with action "wait"; the person must leave Smoothy open.'
        }
      };
    }

    // Resolve input media from either `asset` (open smoothy_edit project) or `path`.
    const resolveAudioInput = async (): Promise<{ file: string; assetId?: string }> => {
      if (typeof input?.asset === 'string' && input.asset.trim()) {
        const asset = await this.edit.resolveAsset(input.asset.trim());
        const file = await resolveMediaPath(asset.path, os.homedir(), this.deps.userData);
        return { file, assetId: asset.id };
      }
      const file = await resolveMediaPath(input?.path, os.homedir(), this.deps.userData);
      return { file };
    };

    const parseRange = (fileDuration: number) => {
      const hasFrom = input?.from !== undefined && input?.from !== null && input?.from !== '';
      const hasTo = input?.to !== undefined && input?.to !== null && input?.to !== '';
      if (!hasFrom && !hasTo) return { hasRange: false, from: 0, to: fileDuration, duration: fileDuration };
      const from = Math.max(0, Number(input?.from ?? 0));
      const to = hasTo ? Number(input.to) : fileDuration;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 0.1) {
        throw Object.assign(new Error('Invalid audio time range. Ensure from < to (at least 0.1 s).'), { code: 'E_BAD_REQUEST' });
      }
      return { hasRange: true, from, to: Math.min(to, fileDuration || to), duration: Math.min(to, fileDuration || to) - from };
    };

    const waitMs = Math.max(0, Math.min(120_000, Number.isFinite(Number(input?.waitMs)) ? Number(input.waitMs) : 20_000));
    const useCache = input?.cache !== false;

    if (action === 'diagnose') {
      const { file, assetId } = await resolveAudioInput();
      const probe = await probeMedia(this.deps.ffprobe, file);
      if (!probe.audio) return this.error('E_BAD_REQUEST', `${path.basename(file)} has no audio stream.`);
      const range = parseRange(probe.duration);
      const stamp = await fileStamp(file);
      const key = hashKey({ stamp, from: range.hasRange ? range.from : 0, to: range.hasRange ? range.to : 0 });
      if (useCache) {
        const hit = await this.resultCache.get<any>('audio-diagnose', key);
        if (hit) {
          this.deps.trackTool?.('agent_audio_diagnose');
          return { ok: true, data: { action, cached: true, ...hit } };
        }
      }
      const job = this.startJob('audio.diagnose', async (progress, signal) => {
        progress(15, 'Measuring noise floor, loudness and rumble');
        const stats = await measureAudioStats(this.deps.ffmpeg, file, {
          from: range.hasRange ? range.from : 0,
          duration: range.hasRange ? range.duration : undefined,
          channels: probe.audio?.channels || 2,
          signal
        });
        signal.throwIfAborted();
        const diagnosis = classifyAudioQuality(stats);
        const payload = {
          source: { name: path.basename(file), path: file, ...(assetId ? { asset: assetId } : {}), duration: Number(probe.duration.toFixed(2)), channels: probe.audio?.channels || 2 },
          ...(range.hasRange ? { range: { from: range.from, to: range.to } } : {}),
          ...diagnosis
        };
        await this.resultCache.set('audio-diagnose', key, payload);
        this.deps.trackTool?.('agent_audio_diagnose');
        progress(100, 'Diagnosis complete');
        return payload;
      });
      const waited = await this.waitJob(job.id, waitMs);
      if (waited?.status === 'done') return { ok: true, data: { action, jobId: job.id, status: 'done', ...waited.result } };
      if (waited?.status === 'error' || waited?.status === 'canceled') return this.error('E_ENGINE_FAILED', waited.error || 'Audio diagnosis failed.');
      return { ok: true, data: { action, jobId: job.id, status: waited?.status || job.status, progress: waited?.progress ?? 0, etaSeconds: waited?.etaSeconds } };
    }

    if (!['denoise', 'separate', 'isolate', 'enhance'].includes(action)) {
      return this.error('E_BAD_REQUEST', `Unknown audio action: ${action}. Use state, setup, diagnose, denoise, separate or isolate.`);
    }
    if (!audio) return this.error('E_NOT_IMPLEMENTED', 'Audio Cleanup is not available in this build.');
    const state = await audio.state();
    if (!state.ready) return this.error('E_MODEL_MISSING', 'The local audio engine is not set up.', 'Call smoothy_audio with action "setup" and have the person approve the one-time download.');
    if (state.busy) return this.error('E_BUSY', 'Another audio job is already running.', 'Wait for it with smoothy_jobs, then retry.');

    const mode = (action === 'enhance' ? 'isolate' : action) as 'denoise' | 'separate' | 'isolate';
    const { file, assetId } = await resolveAudioInput();
    const probe = await probeMedia(this.deps.ffprobe, file);
    if (!probe.audio) return this.error('E_BAD_REQUEST', `${path.basename(file)} has no audio stream.`);
    const range = parseRange(probe.duration);
    const strengthPct = normalizeStrengthPercent(input?.strength, 100);
    const aggression = Number.isFinite(Number(input?.aggression)) ? Math.max(1, Math.min(20, Math.round(Number(input.aggression)))) : 5;
    const voiceChain = Boolean(input?.voiceChain) && mode !== 'separate';
    const keepNoise = Boolean(input?.keepNoise) && mode !== 'separate';
    const muxVideo = Boolean(input?.muxVideo) && mode !== 'separate';
    const applyToProject = Boolean(input?.apply) && mode !== 'separate';

    if (muxVideo && range.hasRange) return this.error('E_BAD_REQUEST', 'muxVideo requires the full file (omit from/to).');
    if (muxVideo && !probe.video) return this.error('E_BAD_REQUEST', 'muxVideo requires a video input file.');
    if (applyToProject && range.hasRange) return this.error('E_BAD_REQUEST', 'apply requires cleaning the full file (omit from/to).');
    if (applyToProject) {
      // Fail fast if no open project exists.
      try { await this.edit.store.active(); }
      catch { return this.error('E_NOT_FOUND', 'No open smoothy_edit project to apply cleaned audio to.', 'Open or create a project with smoothy_edit first, or omit apply:true.'); }
    }

    let explicitOutput: string | null = null;
    if (typeof input?.output === 'string' && input.output.trim()) {
      const candidate = path.resolve(expandHome(input.output.trim(), os.homedir()));
      const roots = await this.writeRoots();
      const parentReal = await fs.realpath(path.dirname(candidate)).catch(() => path.dirname(candidate));
      if (!within(parentReal, roots)) {
        return this.error('E_PATH_DENIED', 'output must be inside the open project folder, agent folder, temp, or an approved write folder.');
      }
      explicitOutput = candidate.toLowerCase().endsWith('.wav') ? candidate : `${candidate}.wav`;
    }

    const stamp = await fileStamp(file);
    const cacheKey = hashKey({
      kind: 'audio.cleanup',
      mode,
      stamp,
      from: range.hasRange ? range.from : 0,
      to: range.hasRange ? range.to : 0,
      strengthPct,
      aggression,
      voiceChain,
      keepNoise,
      muxVideo,
      explicitOutput
    });

    if (useCache) {
      const hit = await this.resultCache.get<any>('audio-cleanup', cacheKey);
      if (hit && Array.isArray(hit.files) && hit.files.length) {
        const exists = await Promise.all(hit.files.map((item: any) => fs.stat(item.path).then(() => true).catch(() => false)));
        if (exists.every(Boolean)) {
          let applied: any;
          if (applyToProject) {
            const primaryFile = hit.files.find((item: any) => item.kind === 'speech')?.path || hit.files[0].path;
            applied = await this.edit.replaceAssetAudio({ assetId, sourcePath: file }, primaryFile, `before smoothy_audio ${mode}`);
          }
          return { ok: true, data: { action, cached: true, ...hit, ...(applied ? { applied } : {}) } };
        }
      }
    }

    const job = this.startJob(`audio.${mode}`, async (progress, signal, jobId) => {
      let beforeStats: any = null;
      if (mode !== 'separate') {
        progress(3, 'Measuring input noise floor and loudness');
        beforeStats = await measureAudioStats(this.deps.ffmpeg, file, {
          from: range.hasRange ? range.from : 0,
          duration: range.hasRange ? range.duration : undefined,
          channels: probe.audio?.channels || 2,
          signal
        }).catch(() => null);
        signal.throwIfAborted();
      }

      progress(8, 'Preparing original audio');
      const source = await audio.select(
        file,
        (data: any) => progress(12, typeof data === 'string' ? data : data?.message || 'Preparing audio'),
        range.hasRange ? { from: range.from, to: range.to } : undefined
      );
      signal.throwIfAborted();

      let pct = 15;
      progress(pct, mode === 'denoise' ? 'Removing background noise' : mode === 'separate' ? 'Separating voice and music' : 'Isolating clean voice');
      const outputs = await audio.process({ source: source.id, mode, aggression }, (data: any) => {
        const msg = typeof data === 'string' ? data : data?.message || 'Processing audio';
        if (data && Number(data.total) > 0 && Number(data.completed) >= 0) {
          const frac = Math.min(1, Number(data.completed) / Number(data.total));
          const spanStart = mode === 'isolate' && data.stage === 'denoise' ? 55 : 15;
          const spanWidth = mode === 'isolate' ? 35 : 65;
          pct = Math.max(pct, Math.min(84, Math.round(spanStart + frac * spanWidth)));
        }
        progress(pct, msg);
      });
      signal.throwIfAborted();

      progress(86, 'Saving output audio');
      const projectFolder = await this.edit.activeFolder();
      const baseStem = path.parse(file).name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'audio';
      const rangeTag = range.hasRange ? `-${Math.round(range.from)}s-${Math.round(range.to)}s` : '';
      const outputDir = explicitOutput
        ? path.dirname(explicitOutput)
        : projectFolder
          ? path.join(projectFolder, range.hasRange ? path.join('Work', 'audio') : path.join('Media', 'Audio'))
          : path.join(this.agentDir, 'outputs', jobId);
      await fs.mkdir(outputDir, { recursive: true });

      const files: { id?: string; label: string; kind: string; path: string; bytes: number }[] = [];
      let primaryPath = '';

      if (mode === 'separate') {
        for (const output of outputs) {
          const defaultTarget = path.join(outputDir, `${baseStem}${rangeTag}-${output.kind}.wav`);
          const target = await uniquePath(defaultTarget);
          await audio.save(output.id, target, { track: false });
          files.push({ id: output.id, label: output.label, kind: output.kind, path: target, bytes: (await fs.stat(target)).size });
        }
      } else {
        const speech = outputs.find(item => item.kind === 'speech');
        const residual = outputs.find(item => item.kind === 'noise' || item.kind === 'background');
        if (!speech) throw new Error('Audio engine did not return a cleaned audio track.');
        const tag = mode === 'denoise' ? 'clean' : 'isolated-voice';
        const strengthTag = strengthPct < 100 ? `-${strengthPct}pct` : '';
        const chainTag = voiceChain ? '-polished' : '';
        const desired = explicitOutput || path.join(outputDir, `${baseStem}${rangeTag}-${tag}${strengthTag}${chainTag}.wav`);
        primaryPath = await uniquePath(desired);
        await audio.save(speech.id, primaryPath, { strength: strengthPct, track: false });
        if (voiceChain) {
          progress(90, 'Applying broadcast voice chain');
          await applyVoiceChain(this.deps.ffmpeg, primaryPath, primaryPath, signal);
        }
        files.push({ id: speech.id, label: voiceChain ? `${speech.label} (polished)` : speech.label, kind: 'speech', path: primaryPath, bytes: (await fs.stat(primaryPath)).size });

        if (keepNoise && residual) {
          const noiseTarget = await uniquePath(path.join(outputDir, `${baseStem}${rangeTag}-${residual.kind}.wav`));
          await audio.save(residual.id, noiseTarget, { track: false });
          files.push({ id: residual.id, label: residual.label, kind: residual.kind, path: noiseTarget, bytes: (await fs.stat(noiseTarget)).size });
        }

        if (muxVideo && primaryPath) {
          progress(92, 'Muxing cleaned audio onto video copy');
          const ext = ['.mp4', '.mov', '.mkv'].includes(path.extname(file).toLowerCase()) ? path.extname(file) : '.mp4';
          const videoTarget = await uniquePath(path.join(outputDir, `${baseStem}-${tag}${chainTag}${ext}`));
          await muxCleanedVideo(this.deps.ffmpeg, file, primaryPath, videoTarget, signal);
          files.push({ label: 'Video with cleaned audio', kind: 'video', path: videoTarget, bytes: (await fs.stat(videoTarget)).size });
        }
      }

      let metrics: AudioComparison | undefined;
      if (beforeStats && primaryPath) {
        progress(95, 'Verifying before/after noise reduction');
        const afterStats = await measureAudioStats(this.deps.ffmpeg, primaryPath, { channels: 2, signal }).catch(() => null);
        if (afterStats) metrics = compareAudioStats(beforeStats, afterStats);
      }

      const resultPayload = {
        mode,
        source: { name: source.name, path: file, ...(assetId ? { asset: assetId } : {}) },
        ...(range.hasRange ? { range: { from: range.from, to: range.to } } : {}),
        ...(mode !== 'separate' ? { strength: Number((strengthPct / 100).toFixed(2)), aggression, voiceChain } : {}),
        files,
        ...(metrics ? { metrics } : {})
      };
      await this.resultCache.set('audio-cleanup', cacheKey, resultPayload);

      let applied: any;
      if (applyToProject && primaryPath) {
        progress(98, 'Applying cleaned audio to open project');
        applied = await this.edit.replaceAssetAudio({ assetId, sourcePath: file }, primaryPath, `before smoothy_audio ${mode}`);
      }

      progress(100, 'Audio ready');
      return { ...resultPayload, ...(applied ? { applied } : {}) };
    });

    const waited = await this.waitJob(job.id, waitMs);
    if (waited?.status === 'done') return { ok: true, data: { action, jobId: job.id, status: 'done', ...waited.result } };
    if (waited?.status === 'error' || waited?.status === 'canceled') return this.error('E_ENGINE_FAILED', waited.error || 'Audio cleanup failed.');
    return {
      ok: true,
      data: {
        action,
        jobId: job.id,
        status: waited?.status || job.status,
        progress: waited?.progress ?? 0,
        message: waited?.message,
        etaSeconds: waited?.etaSeconds,
        note: 'Audio processing is running in the background. Wait with smoothy_jobs action "wait".'
      }
    };
  }

  // ---- engines -------------------------------------------------------------

  /** Engine details for smoothy_status. ffmpeg capabilities are read once; whisper models are rescanned each call. */
  private async engines(): Promise<any> {
    if (!this.engineInfo) {
      this.engineInfo = describeEngines({ ffmpeg: this.deps.ffmpeg, ffprobe: this.deps.ffprobe, sfxDir: this.deps.engines?.sfxDir || null });
      this.engineInfo.catch(() => { this.engineInfo = null; });
    }
    const info = await this.engineInfo;
    let whisper: any = null;
    try {
      const found = this.deps.engines?.whisper?.() || null;
      if (found) {
        whisper = {
          path: found.path,
          variant: found.variant,
          installed: Boolean(found.path),
          modelsDir: found.modelsDir,
          models: found.models.map(model => ({ id: model.id, path: model.path, englishOnly: model.englishOnly, mb: model.bytes ? Math.round(model.bytes / 1e6) : undefined, dtwPreset: dtwPreset(model.path) || undefined })),
          note: found.path ? 'Run it with smoothy_engine tool "whisper". Word timings: -nfa -dtw <dtwPreset> -ojf (topic audio).' : 'Not installed yet. It installs with the first caption run (Settings → Captions) or smoothy_edit transcribe.'
        };
      }
    } catch {
      whisper = null;
    }
    const helper = process.platform === 'darwin' ? this.deps.engines?.visionHelper || null : null;
    const vision = { faces: Boolean(helper), hands: Boolean(helper), layoutScan: true, helper, note: helper ? undefined : process.platform === 'darwin' ? 'Vision helper missing: npm run build:vision.' : 'Face and hand scans need macOS; layout_scan works everywhere.' };
    return { ffmpeg: info.ffmpeg, ffprobe: info.ffprobe, whisper, sfx: info.sfx, vision, python: null };
  }

  private readRoots(): string[] {
    if (process.platform === 'win32') return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
    return allowedRoots(os.homedir(), this.deps.userData);
  }

  private async writeRoots(extra: string[] = []): Promise<string[]> {
    const folder = await this.edit.activeFolder();
    const roots = [this.agentDir, ...(this.deps.tempWritable === false ? [] : tmpRoots()), ...(folder ? [folder] : []), ...this.writeGrants, ...extra];
    const real = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.resolve(root))));
    return [...new Set(real)];
  }

  /**
   * Resolves a folder the agent wants to write into. Inside a writable root it is
   * used directly; otherwise the editor approves it (once or for the session).
   */
  private async prepareFolder(input: unknown, kind: 'smoothy_edit.folder' | 'smoothy_engine.write'): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) throw Object.assign(new Error('Provide an absolute folder path.'), { code: 'E_BAD_REQUEST' });
    const expanded = expandHome(input.trim(), os.homedir());
    if (!path.isAbsolute(expanded)) throw Object.assign(new Error('The folder must be an absolute path.'), { code: 'E_BAD_REQUEST' });
    const resolved = path.resolve(expanded);
    let real = resolved;
    try { real = await fs.realpath(resolved); } catch { real = resolved; }
    if (!within(real, this.readRoots())) throw Object.assign(new Error('That folder is outside the locations Smoothy can use (your home folder, external volumes and the temp folder).'), { code: 'E_PATH_DENIED' });
    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    const rootDir = path.parse(real).root;
    const isTopLevelSystemDir = process.platform === 'win32'
      ? /^(?:[a-z]:\\)(?:windows|users|program files(?: \(x86\))?|programdata)$/i.test(real)
      : path.dirname(real) === rootDir;
    if (real === home || real === rootDir || isTopLevelSystemDir || /^\/Volumes\/[^/]+$/.test(real)) {
      throw Object.assign(new Error('Choose a project folder, not a whole home folder or drive.'), { code: 'E_PATH_DENIED' });
    }
    if (!within(real, await this.writeRoots())) {
      const decision = await this.askApproval(kind, {
        action: kind === 'smoothy_edit.folder' ? 'project folder' : 'write folder',
        folder: real,
        note: kind === 'smoothy_edit.folder'
          ? 'Creates Edit/, Media/, Graphics/ and Work/ here. The agent can write its files inside this folder; your existing files are not changed.'
          : 'Lets the agent write ffmpeg/whisper outputs inside this folder. It refuses to overwrite files unless the command says -y.'
      });
      if (!decision) throw Object.assign(new Error('The editor did not approve writing into that folder.'), { code: 'E_APPROVAL_TIMEOUT' });
      // A project folder stays writable while its project is open; an engine
      // workspace approved once covers only the current run.
      if (decision === 'session' || kind === 'smoothy_edit.folder') {
        this.writeGrants.add(real);
        this.emit('status', this.state());
      }
    }
    await fs.mkdir(real, { recursive: true });
    return fs.realpath(real).catch(() => real);
  }

  private async toolEngine(input: any): Promise<AgentResult> {
    const requested = String(input?.tool || '').toLowerCase();
    const tool: EngineTool | null = requested === 'ffmpeg' ? 'ffmpeg' : requested === 'ffprobe' ? 'ffprobe' : requested === 'whisper' || requested === 'whisper-cli' ? 'whisper' : null;
    if (!tool) return this.error('E_BAD_REQUEST', 'tool must be ffmpeg, ffprobe or whisper.');
    let binary = tool === 'ffmpeg' ? this.deps.ffmpeg : tool === 'ffprobe' ? this.deps.ffprobe : '';
    if (tool === 'whisper') {
      binary = this.deps.engines?.whisper?.()?.path || '';
      if (!binary) return this.error('E_MODEL_MISSING', 'whisper-cli is not installed yet.', 'Run smoothy_edit transcribe once (the editor approves the download), or install it from Settings → Captions.');
    }

    let workspace: string | null = null;
    if (input?.workspace) workspace = await this.prepareFolder(input.workspace, 'smoothy_engine.write');
    const projectFolder = await this.edit.activeFolder();
    const fallback = workspace || (projectFolder ? path.join(projectFolder, 'Work') : path.join(this.agentDir, 'work'));
    let cwd = typeof input?.cwd === 'string' && input.cwd.trim() ? path.resolve(fallback, expandHome(input.cwd.trim(), os.homedir())) : fallback;
    const runRoots = workspace ? [workspace] : [];
    let writeRoots = await this.writeRoots(runRoots);
    const cwdReal = await fs.realpath(cwd).catch(() => cwd);
    if (!within(cwdReal, writeRoots)) {
      runRoots.push(await this.prepareFolder(cwdReal, 'smoothy_engine.write'));
      writeRoots = await this.writeRoots(runRoots);
    }
    await fs.mkdir(cwd, { recursive: true });
    cwd = await fs.realpath(cwd);

    let guarded;
    try {
      guarded = await guardArgs(tool, input?.args, {
        cwd,
        home: os.homedir(),
        readRoots: this.readRoots(),
        writeRoots,
        readText: async file => {
          const stat = await fs.stat(file);
          if (stat.size > 1024 * 1024) throw new Error('too large');
          return fs.readFile(file, 'utf8');
        }
      });
    } catch (error: any) {
      if (error instanceof EngineGuardError) return this.error(error.code, error.message, 'See smoothy_help topic "engine" for the path and network rules.');
      throw error;
    }
    if (guarded.needsWrite.length) {
      const decision = await this.askApproval('smoothy_engine.write', {
        action: 'write files',
        tool,
        folders: guarded.needsWrite.slice(0, 6),
        note: 'The agent wants ffmpeg/whisper to write into these folders. "Allow for this session" also covers later runs.'
      });
      if (!decision) return this.error('E_APPROVAL_TIMEOUT', 'The editor did not approve writing into that folder.', 'Write inside the project folder or Smoothy\'s agent folder, or pass workspace and ask the editor to approve it.');
      // "Approve" covers this run only; "Allow for this session" also covers later runs.
      if (decision === 'session') {
        for (const folder of guarded.needsWrite) this.writeGrants.add(folder);
        this.emit('status', this.state());
      }
    }

    const args = finalArgs(tool, guarded.args);
    const reads: string[] = guarded.paths.filter(item => item.role === 'read').map(item => String(item.path));
    const writes: string[] = [...new Set<string>(guarded.paths.filter(item => item.role === 'write').map(item => String(item.path)))];
    const cacheKey = input?.cache === true
      ? hashKey({ tool, args, cwd, reads: await Promise.all([...new Set<string>(reads)].map(file => fileStamp(file))) })
      : '';
    if (cacheKey) {
      const cached = await this.resultCache.get<any>('engine', cacheKey);
      if (cached?.ok && Array.isArray(cached.outputs)) {
        const stamps = await Promise.all(cached.outputs.map((item: any) => fileStamp(item.path)));
        if (stamps.every((stamp, i) => stamp && stamp.size === cached.outputs[i].bytes)) {
          this.deps.trackTool?.('agent_engine_run');
          return { ok: true, data: { action: 'run', ...cached, cached: true } };
        }
      }
    }

    const timeoutMs = Math.max(1000, Math.min(6 * 3600000, Number(input?.timeoutMs) || 2 * 3600000));
    const tailLines = Math.max(5, Math.min(200, Math.round(Number(input?.tailLines) || 30)));
    const expected = Number(input?.expectedSeconds) > 0 ? Number(input.expectedSeconds) : expectedSeconds(guarded.args);
    const whisperPrefix = tool === 'whisper' ? guarded.paths.find(item => item.role === 'write')?.path : undefined;
    this.deps.trackTool?.('agent_engine_run');
    const job = this.startJob(`engine.${tool}`, async (progress, signal, jobId) => {
      const logDir = path.join(this.agentDir, 'logs');
      await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
      const log = path.join(logDir, `${tool}-${new Date().toISOString().replace(/[:.]/g, '-')}-${jobId.slice(0, 6)}.log`);
      await fs.writeFile(log, `${tool} ${JSON.stringify(args)}\ncwd ${cwd}\n\n`);
      progress(1, `Running ${tool}`);
      const run = await runEngine(binary, tool, args, { cwd, signal, timeoutMs, tailLines, expected, logFile: log, onProgress: progress });
      const outputs: { path: string; bytes: number }[] = [];
      const seen = new Set<string>();
      const candidates = [...writes];
      if (whisperPrefix) {
        const dir = path.dirname(whisperPrefix);
        const base = path.basename(whisperPrefix);
        try { for (const name of await fs.readdir(dir)) if (name.startsWith(`${base}.`)) candidates.push(path.join(dir, name)); } catch {}
      }
      for (const file of candidates) {
        if (seen.has(file)) continue;
        seen.add(file);
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isFile() && stat.mtimeMs >= job.startedMs - 2000) outputs.push({ path: file, bytes: stat.size });
      }
      const result: any = {
        tool,
        ok: run.exitCode === 0,
        exitCode: run.exitCode,
        seconds: run.seconds,
        outputs,
        stderrTail: run.stderrTail,
        log,
        cwd
      };
      if (run.signal) result.signal = run.signal;
      if (run.stdoutBytes) {
        if (run.stdout.includes('\u0000')) {
          result.stdoutBytes = run.stdoutBytes;
          result.stdoutNote = 'Binary output on stdout was discarded. Write media to a file instead of pipe:1.';
        } else if (run.stdout.length > 6000 || run.stdoutBytes > run.stdout.length) {
          await fs.mkdir(this.resultsDir, { recursive: true, mode: 0o700 });
          const trimmed = run.stdout.trimStart();
          const ext = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'txt';
          const file = path.join(this.resultsDir, `${tool}-stdout-${jobId.slice(0, 8)}.${ext}`);
          await fs.writeFile(file, run.stdout);
          result.stdoutFile = file;
          result.stdoutBytes = run.stdoutBytes;
          result.stdoutHead = run.stdout.slice(0, 1200);
        } else {
          result.stdout = run.stdout;
        }
      }
      if (!result.ok) result.error = run.stderrTail.slice(-3).join(' ').slice(0, 400) || `${tool} exited ${run.exitCode}`;
      if (cacheKey && result.ok) await this.resultCache.set('engine', cacheKey, result).catch(() => {});
      progress(100, result.ok ? 'Done' : `Exited ${run.exitCode}`);
      return result;
    });

    const waitMs = Math.max(0, Math.min(120000, input?.waitMs === undefined ? 20000 : Number(input.waitMs) || 0));
    const view = (await this.waitJob(job.id, waitMs)) || this.publicJob(job);
    if (job.status === 'done') return { ok: true, data: { action: 'run', jobId: job.id, ...(job.result as any) } };
    if (job.status !== 'running') return this.error('E_INTERNAL', job.error || `${tool} failed.`);
    return {
      ok: true,
      data: {
        action: 'run', tool, jobId: job.id, status: 'running', progress: view.progress, etaSeconds: view.etaSeconds ?? null, elapsedSeconds: view.elapsedSeconds,
        next: `Still running. Call smoothy_jobs action "wait" id "${job.id}"${view.etaSeconds ? ` with timeoutMs about ${Math.min(120000, Math.max(5000, view.etaSeconds * 1000))}` : ''}.`
      }
    };
  }

  private startJob(kind: string, runner: (progress: (percent: number, message: string) => void, signal: AbortSignal, jobId: string) => Promise<any>): PendingJob {
    const jobId = randomUUID();
    const controller = new AbortController();
    const job: PendingJob = {
      id: jobId,
      kind,
      status: 'running',
      progress: 0,
      message: 'Starting',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
      controller,
      listeners: new Set(),
      startedMs: Date.now(),
      finishedMs: null
    };
    this.jobs.set(jobId, job);
    if (this.jobs.size > 40) {
      for (const [id, entry] of this.jobs) {
        if (entry.status === 'running') continue;
        this.jobs.delete(id);
        if (this.jobs.size <= 30) break;
      }
    }
    const progress = (percent: number, message: string) => {
      if (controller.signal.aborted) return;
      job.progress = Math.max(0, Math.min(100, Math.round(percent)));
      job.message = message.slice(0, 200);
      this.emit('job', this.publicJob(job));
    };
    void (async () => {
      try {
        const result = await runner(progress, controller.signal, jobId);
        if (controller.signal.aborted) throw Object.assign(new Error('Canceled'), { canceled: true });
        job.status = 'done'; job.progress = 100; job.message = 'Done'; job.result = result;
      } catch (error: any) {
        job.status = controller.signal.aborted || error?.canceled ? 'canceled' : 'error';
        job.error = job.status === 'canceled' ? 'Canceled' : error?.message || 'Job failed';
        job.message = job.error;
      } finally {
        job.finishedAt = new Date().toISOString();
        job.finishedMs = Date.now();
        this.emit('job', this.publicJob(job));
        for (const listener of job.listeners) listener();
        job.listeners.clear();
      }
    })();
    return job;
  }

  /** Waits up to `ms` for a job to finish and returns its public view (null if unknown). */
  private async waitJob(id: string, ms: number): Promise<AgentJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (ms > 0 && job.status === 'running') {
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); job!.listeners.delete(done); resolve(); }
        job.listeners.add(done);
        if (job.status !== 'running') done();
      });
    }
    return this.publicJob(job);
  }

  private publicJob(job: PendingJob): AgentJob {
    const elapsed = ((job.finishedMs ?? Date.now()) - job.startedMs) / 1000;
    let eta: number | null = null;
    if (job.status === 'running' && job.progress >= 2 && job.progress < 100 && elapsed >= 1.5) eta = Math.round((elapsed * (100 - job.progress)) / job.progress);
    return {
      id: job.id, kind: job.kind, status: job.status, progress: job.progress, message: job.message,
      createdAt: job.createdAt, finishedAt: job.finishedAt, result: job.result, error: job.error,
      elapsedSeconds: Number(elapsed.toFixed(1)),
      ...(job.status === 'running' ? { etaSeconds: eta } : {})
    };
  }

  private async toolJobs(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'list');
    if (action === 'list') return { ok: true, data: { action, jobs: [...this.jobs.values()].slice(-30).map(job => this.publicJob(job)) } };
    const job = this.jobs.get(String(input?.id || ''));
    if (!job) return this.error('E_NOT_FOUND', 'Job not found.');
    if (action === 'status') return { ok: true, data: { action, job: this.publicJob(job) } };
    if (action === 'cancel') {
      job.controller.abort();
      if (job.kind.startsWith('audio.')) {
        try { this.deps.audioService?.cancel(); } catch {}
      }
      return { ok: true, data: { action, job: this.publicJob(job) } };
    }
    if (action === 'wait') {
      const timeout = Math.max(1000, Math.min(120000, Number(input?.timeoutMs) || 25000));
      if (job.status === 'running') {
        await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout | null = null;
          const done = () => { if (timer) clearTimeout(timer); job.listeners.delete(done); resolve(); };
          job.listeners.add(done);
          timer = setTimeout(done, timeout);
          // The job may have finished between the status check and addEventListener.
          if (job.status !== 'running') done();
        });
      }
      return { ok: true, data: { action, job: this.publicJob(job) } };
    }
    return this.error('E_BAD_REQUEST', `Unknown jobs action: ${action}`);
  }

  private async requestApproval(tool: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.sessionGrants.has(tool)) return true;
    const decision = await this.askApproval(tool, args);
    if (decision === 'session') this.sessionGrants.add(tool);
    return decision !== null;
  }

  /** Shows an approval in the Smoothy window. Session-capable kinds offer "Allow for this session". */
  private askApproval(tool: string, args: Record<string, unknown>): Promise<ApprovalDecision> {
    if (this.deps.store.get('agent.autoApprove', false) === true) return Promise.resolve('once');
    const id = randomUUID();
    const session = SESSION_APPROVALS.has(tool);
    return new Promise<ApprovalDecision>(resolve => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(null);
      }, 120000);
      this.approvals.set(id, { id, tool, args, createdAt: new Date().toISOString(), session, resolve, timer });
      this.emit('approval', { id, tool, args, session, createdAt: new Date().toISOString() });
    });
  }

  clearPreview(): void {
    this.previewTarget = null;
  }

  decideApproval(id: string, allow: boolean, session = false): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    approval.resolve(allow ? (session && approval.session ? 'session' : 'once') : null);
    if (allow && session && approval.session) setTimeout(() => this.emit('status', this.state()), 0);
    return true;
  }

  // ---- MCP transport -------------------------------------------------------

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const messages = Array.isArray(body) ? body : [body];
    const responses: any[] = [];
    let sessionId = String(req.headers['mcp-session-id'] || '');
    for (const message of messages) {
      if (!message || message.jsonrpc !== '2.0') {
        responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      if (message.id === undefined || message.id === null) {
        // Notifications (initialized, cancelled) do not receive a response.
        continue;
      }
      try {
        const result = await this.mcpMethod(String(message.method || ''), message.params || {}, sessionId ? `mcp:${sessionId}` : 'mcp');
        responses.push({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'initialize' && !sessionId) sessionId = randomUUID();
      } catch (error: any) {
        const code = error?.code === 'E_NOT_FOUND' ? -32601 : error?.code === 'E_BAD_REQUEST' ? -32602 : -32603;
        responses.push({ jsonrpc: '2.0', id: message.id, error: { code, message: error?.message || 'MCP request failed.' } });
      }
    }
    if (!responses.length) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      const text = `event: message\ndata: ${JSON.stringify(responses.length === 1 ? responses[0] : responses)}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(text);
      return;
    }
    this.send(res, 200, responses.length === 1 ? responses[0] : responses);
  }

  private async mcpMethod(method: string, params: any, session = 'mcp'): Promise<any> {
    switch (method) {
      case 'initialize': {
        const requested = String(params?.protocolVersion || '');
        return {
          protocolVersion: MCP_SUPPORTED_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: { name: 'smoothyedit-agent', version: this.deps.appVersion },
          instructions: skillMarkdown()
        };
      }
      case 'ping': return {};
      case 'logging/setLevel': return {};
      case 'tools/list': return { tools: AGENT_TOOLS };
      case 'tools/call': {
        const name = String(params?.name || '');
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const result = await this.callTool(name, args, 'mcp', session);
        const { imageDataUrl, ...rest } = result;
        const content: any[] = [{ type: 'text', text: JSON.stringify(rest) }];
        if (imageDataUrl) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(imageDataUrl);
          if (match) content.push({ type: 'image', data: match[2], mimeType: match[1] });
        }
        return { content, structuredContent: rest, isError: !result.ok };
      }
      case 'resources/list': return { resources: this.resources() };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'resources/read': {
        if (this.deps.allowed && !this.deps.allowed()) {
          throw Object.assign(new Error('The Smoothy Agent Bridge is part of Smoothy Pro.'), { code: 'E_PRO_REQUIRED' });
        }
        const uri = String(params?.uri || '');
        const text = await this.resourceText(uri);
        return { contents: [{ uri, mimeType: 'application/json', text }] };
      }
      case 'prompts/list': return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: 'E_NOT_FOUND' });
    }
  }

  private resources(): any[] {
    return [
      { uri: 'smoothy://status', name: 'Smoothy status', description: 'App, editor, engines and review counts.', mimeType: 'application/json' },
      { uri: 'smoothy://project', name: 'Current sequence', description: 'Compact timeline map.', mimeType: 'application/json' },
      { uri: 'smoothy://capabilities', name: 'Capabilities', description: 'Tools, arguments and playbook.', mimeType: 'application/json' },
      { uri: 'smoothy://review', name: 'Review notes', description: 'Timecoded notes and replies.', mimeType: 'application/json' }
    ];
  }

  private async resourceText(uri: string): Promise<string> {
    if (uri === 'smoothy://status') return JSON.stringify((await this.toolStatus()).data);
    if (uri === 'smoothy://project') return JSON.stringify(this.compactSequence(this.deps.getSequenceInfo()));
    if (uri === 'smoothy://capabilities') return JSON.stringify({ protocolVersion: MCP_PROTOCOL_VERSION, tools: AGENT_TOOLS, skill: skillMarkdown() });
    if (uri === 'smoothy://review') return JSON.stringify({ threads: this.review.list({ includeResolved: true }), counts: this.review.count() });
    throw Object.assign(new Error('Unknown resource.'), { code: 'E_NOT_FOUND' });
  }

  // ---- IPC for the Agentic tab --------------------------------------------

  registerIpc(): void {
    ipcMain.handle('agent-state', () => this.state());
    ipcMain.handle('agent-set-enabled', async (_event, enabled: boolean) => this.setEnabled(Boolean(enabled)));
    ipcMain.handle('agent-tools', () => AGENT_TOOLS);
    ipcMain.handle('agent-skill', () => skillMarkdown());
    ipcMain.handle('agent-copy', (_event, text: string) => { clipboard.writeText(String(text || '')); return { success: true }; });
    ipcMain.handle('agent-project', async (_event, input: any) => this.callTool('smoothy_project', input || {}, 'ui'));
    ipcMain.handle('agent-media', async (_event, input: any) => this.callTool('smoothy_media', input || {}, 'ui'));
    ipcMain.handle('agent-frame', async (_event, input: any) => this.callTool('smoothy_media', { action: 'frame', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-probe', async (_event, input: any) => this.callTool('smoothy_media', { action: 'probe', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-review-list', async (_event, input: any) => this.callTool('smoothy_review', { action: 'list', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-review-add', async (_event, input: any) => this.callTool('smoothy_review', { action: 'add', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-review-reply', async (_event, input: any) => this.callTool('smoothy_review', { action: 'reply', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-review-resolve', async (_event, input: any) => this.callTool('smoothy_review', { action: 'resolve', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-review-open', async (_event, input: any) => this.callTool('smoothy_review', { action: 'open', ...(input || {}) }, 'ui'));
    ipcMain.handle('agent-preview-clear', () => { this.clearPreview(); return { success: true }; });
    ipcMain.handle('agent-pick-file', async () => {
      const win = this.deps.window();
      if (!win) return { canceled: true };
      const choice = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
      const file = await resolveMediaPath(choice.filePaths[0], os.homedir(), this.deps.userData);
      return { canceled: false, path: file };
    });
    ipcMain.handle('agent-approve', (_event, input: any) => ({ success: this.decideApproval(String(input?.id || ''), Boolean(input?.allow), input?.session === true) }));
    ipcMain.handle('agent-revoke-grants', () => { this.revokeGrants(); return { success: true, grants: this.grantsSummary() }; });
    ipcMain.handle('agent-open-artifact', async (_event, file: string) => {
      const target = path.resolve(String(file || ''));
      if (!target.startsWith(this.artifactsDir + path.sep)) return { success: false, error: 'That file is not a review artifact.' };
      shell.showItemInFolder(target);
      return { success: true };
    });
    ipcMain.handle('agent-artifact-data', async (_event, file: string) => {
      const target = path.resolve(String(file || ''));
      if (!target.startsWith(this.artifactsDir + path.sep)) return { success: false, error: 'That file is not a review artifact.' };
      const data = await fs.readFile(target);
      const mime = target.endsWith('.png') ? 'image/png' : target.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return { success: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    });
    ipcMain.handle('agent-job-list', async () => this.callTool('smoothy_jobs', { action: 'list' }, 'ui'));
  }
}

export function registerAgentic(deps: AgentServiceDeps): AgentService {
  const service = new AgentService(deps);
  service.registerIpc();
  app.on('before-quit', () => { void service.stop(); });
  void service.start().catch(error => console.error('[Agent] Could not start:', error));
  return service;
}

export { AgentService, AGENT_TOOLS, skillMarkdown };
