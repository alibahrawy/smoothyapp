/**
 * Smoothy Agent Bridge.
 *
 * A loopback-only MCP + JSON API that lets an external coding agent inspect the
 * current edit, pull cheap preview frames, run Smoothy's local media engines, and
 * leave timecoded review notes. It never exposes a shell or raw ffmpeg.
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
};

type PendingApproval = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
};

const schema = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true
});

const string = (description: string): Record<string, unknown> => ({ type: 'string', description });
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
    description: 'Discover Smoothy capabilities. Pass a tool name for its actions and arguments, or skill=true for the full agent playbook.',
    inputSchema: schema({ tool: string('Tool name, for example smoothy_media.'), skill: boolean('Return the complete agent skill/playbook.') }),
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
    description: 'Run Smoothy Audio Cleanup locally: set up the one-time engine, split speech/music, or denoise/enhance speech. Long actions return a job id; poll with smoothy_jobs.',
    inputSchema: schema({
      action: { type: 'string', enum: ['state', 'setup', 'separate', 'enhance'], description: 'state | setup | separate | enhance' },
      path: string('Absolute audio or video path. Required for separate/enhance.')
    }),
    annotations: { title: 'Audio cleanup', readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'smoothy_edit',
    description: 'Build a video edit with no editor and no ffmpeg install. Actions: new, list, open, show, import {paths}, ops {ops:[...]}, undo, redo. Ops (batch many per call): add {asset,at?,in?,out?,duration?,track?,volume?,speed?,fadeIn?,fadeOut?,only?:audio}, trim {clip,in?,out?,ripple?}, split {clip,at}, move {clip,to,track?}, remove {clip,ripple?}, set {clip,volume?,speed?,mute?,fadeIn?,fadeOut?,opacity?,fit?,text?}, text {text,at,duration,style?}, captions {items:[{start,end,text}]}, cut {from,to} (ripple-removes a time range), ripple_gaps {track?}. Times are seconds on the timeline. Smoothy features as actions: cut_silence {tracks?,thresholdDb?,minSilence?,padding?} removes dead air; multicam {cameras:[{asset,mic?,speaker?}],wide?,audio?} (job) cuts synced cameras by who speaks; transcribe {tracks?,language?,captions?} (job) returns a timed transcript and can place captions. A video clip and its audio are linked and edit together.',
    inputSchema: schema({
      action: { type: 'string', enum: ['new', 'list', 'open', 'show', 'import', 'ops', 'cut_silence', 'multicam', 'transcribe', 'undo', 'redo'], description: 'new | list | open | show | import | ops | cut_silence | multicam | transcribe | undo | redo' },
      name: string('Project name for new.'),
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
    description: 'Preview and export the edit project with the bundled ffmpeg. frame {time,width?} returns one composited image, sheet {count? | times? | from,to,width?} returns a labelled contact sheet, analyze {from?,to?,tracks?,thresholdDb?,minSilence?} returns loudness and silent ranges (you cannot hear, so use this), export {name?,preset?,from?,to?,width?,loudnorm?} renders an MP4 after the editor approves (job, poll smoothy_jobs).',
    inputSchema: schema({
      action: { type: 'string', enum: ['frame', 'sheet', 'export', 'analyze'], description: 'frame | sheet | export | analyze' },
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
    description: 'Find music and stock footage and add them to the edit project. music {query?,mood?,genre?,limit?} searches the YouTube Audio Library archive; stock {query,provider?,orientation?,limit?} searches Wikimedia, Internet Archive, NASA and Pixabay; add {kind:"music"|"stock",id} downloads after the editor approves (job) and returns an asset id plus its licence and credit. Always pass the licence/credit on to the editor.',
    inputSchema: schema({
      action: { type: 'string', enum: ['music', 'stock', 'add'], description: 'music | stock | add' },
      query: string('Search words.'),
      mood: string('Music mood, for example Happy or Calm.'),
      genre: string('Music genre.'),
      provider: { type: 'string', enum: ['all', 'commons', 'archive', 'nasa', 'pixabay'], description: 'Stock source. Default all.' },
      orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'], description: 'Stock orientation.' },
      limit: number('Results to return. Default 8, max 20.'),
      kind: { type: 'string', enum: ['music', 'stock'], description: 'What add downloads.' },
      id: string('Track id (music) or ref (stock) from a search.')
    }),
    annotations: { title: 'Library', readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'smoothy_jobs',
    description: 'Check, wait for, or cancel a long-running Smoothy job started by another tool.',
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
    '1. Call `smoothy_status` first. It tells you the app version, editor connection, sequence and engines.',
    '2. Read the sequence with `smoothy_project` before proposing a cut. Use clip refs and source ranges; do not guess timing.',
    '3. Use `smoothy_media` for preview frames and contact sheets. Never dump raw logs or base64 media into the conversation.',
    '4. Audio Cleanup runs locally through `smoothy_audio`. If it returns E_MODEL_MISSING, call smoothy_audio with action "setup"; the person must approve the multi-GB download in the app. Poll with `smoothy_jobs` wait.',
    '5. The editor leaves timecoded notes for you in the app. Read them with `smoothy_review` action "list" (or "wait" for new ones), fix what each note asks, then reply on that note with what you changed. You do not write notes and you do not mark them fixed; the editor does. When working headless, point the app preview at the file with action "preview" {path,time,name}.',
    '6. Marker edits are mutating and require approval in the Smoothy window. Never assume they ran.',
    '6b. No editor? Build the edit yourself: `smoothy_edit` new → import {paths} → ops (batch many per call, times in seconds) → `smoothy_render` frame/sheet to check it → export (the editor approves) → `smoothy_jobs` wait. Originals are never changed. Check `warnings` after every ops call and fix overlaps and gaps.',
    '6c. You cannot hear: use `smoothy_render` analyze for loudness and silence, `smoothy_edit` transcribe to read the speech with timecodes, cut_silence for dead air and multicam to cut synced cameras by speaker. Music and stock come from `smoothy_library` (the editor approves downloads); always tell the editor each asset\'s licence and credit.',
    '7. Keep replies short. Return timecodes in HH:MM:SS:FF and paths only when the next action needs them.',
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
  private readonly jobs = new Map<string, PendingJob>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly activity: Activity[] = [];
  private previewTarget: any = null;
  private readonly clients = new Map<string, number>();
  /** Agent sessions already counted as `agent_session_start` (bounded, newest kept). */
  private readonly countedSessions = new Set<string>();
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly events = new EventEmitter();

  constructor(private readonly deps: AgentServiceDeps) {
    this.agentDir = path.join(deps.userData, 'agent');
    this.artifactsDir = path.join(this.agentDir, 'artifacts');
    this.frameCacheDir = path.join(this.agentDir, 'cache', 'frames');
    this.discoveryFile = path.join(this.agentDir, 'agent.json');
    this.review = new ReviewStore(path.join(this.agentDir, 'review.json'));
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
      library: deps.edit?.library || null
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
      approval.resolve(false);
    }
    this.approvals.clear();
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
      activity: this.activity.slice(-20)
    };
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
    const url = new URL(req.url || '/', `http://${host || '127.0.0.1'}`);
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
      const result = await this.dispatch(tool.name, input, source);
      const ms = Date.now() - started;
      if (source !== 'ui') this.logActivity(name, Boolean(result.ok), ms, source, result.ok ? this.summary(name, result.data) : result.error?.code || 'error');
      if (source !== 'ui' && result.ok) this.countSession(session || source, name);
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
        engines: { ffmpeg: true, ffprobe: true, audio },
        edit: { project: this.edit.store.currentId() },
        preview: this.previewTarget,
        review: this.review.count(),
        limits: { markerBatch: MAX_MARKERS, previewWidth: 1920, requestBytes: MAX_BODY }
      }
    };
  }

  private toolHelp(input: any): AgentResult {
    if (input?.skill === true) return { ok: true, data: { markdown: skillMarkdown(), tools: AGENT_TOOLS.map(tool => tool.name) } };
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
        rules: [
          'Call smoothy_status first.',
          'Read with smoothy_project before proposing edits.',
          'Preview with smoothy_media; do not dump raw logs or base64.',
          'Use smoothy_review for human feedback.',
          'Timeline actions require approval in the Smoothy window.'
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
    if (!audio) return this.error('E_NOT_IMPLEMENTED', 'Audio Cleanup is not available in this build.');
    const state = await audio.state();
    if (action === 'state') return { ok: true, data: { action, state } };
    if (action === 'setup') {
      if (state.ready) return { ok: true, data: { action, alreadyReady: true, state } };
      if (state.busy) return this.error('E_BUSY', 'The audio engine is already busy.', 'Wait with smoothy_jobs, then retry setup.');
      const approved = await this.requestApproval('smoothy_audio.setup', {
        action: 'setup',
        note: 'Creates a Python 3.12 runtime and downloads PyTorch, ONNX and the separation/enhancement models. This can be several GB.'
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
    if (action !== 'separate' && action !== 'enhance') return this.error('E_BAD_REQUEST', `Unknown audio action: ${action}`);
    if (!state.ready) return this.error('E_MODEL_MISSING', 'The local audio engine is not set up.', 'Call smoothy_audio with action "setup" and have the person approve the one-time download.');
    if (state.busy) return this.error('E_BUSY', 'Another audio job is already running.', 'Wait for it with smoothy_jobs, then retry.');
    const file = await resolveMediaPath(input?.path, os.homedir(), this.deps.userData);
    const job = this.startJob(`audio.${action}`, async (progress, signal, jobId) => {
      progress(4, 'Preparing original audio');
      const source = await audio.select(file, (data: any) => progress(10, typeof data === 'string' ? data : data?.message || 'Preparing audio'));
      signal.throwIfAborted();
      progress(20, 'Separating speech from music and noise');
      const separated = await audio.process({ source: source.id, mode: 'separate' }, (data: any) => progress(45, typeof data === 'string' ? data : data?.message || 'Separating audio'));
      signal.throwIfAborted();
      let outputs = separated;
      if (action === 'enhance') {
        progress(72, 'Enhancing speech');
        outputs = await audio.process({ source: source.id, mode: 'enhance' }, (data: any) => progress(82, typeof data === 'string' ? data : data?.message || 'Enhancing speech'));
        signal.throwIfAborted();
      }
      progress(94, 'Saving results');
      const outputDir = path.join(this.agentDir, 'outputs', jobId);
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      const files = [];
      for (const output of outputs) {
        const target = path.join(outputDir, `${output.kind}-${path.basename(output.file)}`);
        await fs.copyFile(output.file, target);
        files.push({ id: output.id, label: output.label, kind: output.kind, path: target, bytes: (await fs.stat(target)).size });
      }
      progress(100, 'Audio ready');
      return { source: { name: source.name, path: file }, files };
    });
    return { ok: true, data: { action, jobId: job.id, status: job.status } };
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
      listeners: new Set()
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
        this.emit('job', this.publicJob(job));
        for (const listener of job.listeners) listener();
        job.listeners.clear();
      }
    })();
    return job;
  }

  private publicJob(job: PendingJob): AgentJob {
    return {
      id: job.id, kind: job.kind, status: job.status, progress: job.progress, message: job.message,
      createdAt: job.createdAt, finishedAt: job.finishedAt, result: job.result, error: job.error
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
      try { this.deps.audioService?.cancel(); } catch {}
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

  private requestApproval(tool: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.deps.store.get('agent.autoApprove', false) === true) return Promise.resolve(true);
    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(false);
      }, 120000);
      this.approvals.set(id, { id, tool, args, createdAt: new Date().toISOString(), resolve, timer });
      this.emit('approval', { id, tool, args, createdAt: new Date().toISOString() });
    });
  }

  clearPreview(): void {
    this.previewTarget = null;
  }

  decideApproval(id: string, allow: boolean): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    approval.resolve(Boolean(allow));
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
    ipcMain.handle('agent-approve', (_event, input: any) => ({ success: this.decideApproval(String(input?.id || ''), Boolean(input?.allow)) }));
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
