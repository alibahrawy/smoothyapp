/**
 * smoothy_edit / smoothy_render: the agent-facing tools for the headless editor.
 * smoothy_edit builds and changes a project; smoothy_render previews and exports it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  EditOpError,
  applyOps,
  createProject,
  lintProject,
  projectDuration,
  type EditAsset,
  type EditProject
} from './edit-project';
import { EditStore } from './edit-store';
import { exportProject, renderFrame, type RenderPreset } from './edit-render';
import { formatTimecode, mediaKind, probeMedia, resolveMediaPath } from './media';
import {
  analyzeWav,
  multicamOps,
  planMulticam,
  renderAudioMix,
  silenceCuts,
  summarizeShots,
  type Camera,
  type LibraryService,
  type SpeechService
} from './edit-features';
import type { AgentResult } from './types';

export type EditEngineDeps = {
  root: string;
  ffmpeg: string;
  ffprobe: string;
  home: string;
  userData: string;
  requestApproval: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  startJob: (kind: string, runner: (progress: (percent: number, message: string) => void, signal: AbortSignal, jobId: string) => Promise<any>) => { id: string; status: string };
  trackTool?: (id: string) => void;
  speech?: SpeechService | null;
  library?: LibraryService | null;
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const MAX_IMPORT = 40;
const ok = (data: unknown, imageDataUrl?: string): AgentResult => ({ ok: true, data, imageDataUrl });
const fail = (code: any, message: string, next?: string): AgentResult => ({ ok: false, error: { code, message, next } });
const safeName = (value: string): string => value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'edit';

export class EditEngine {
  readonly store: EditStore;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EditEngineDeps) {
    this.store = new EditStore(deps.root);
  }

  /** Project changes run one at a time so concurrent agent calls cannot interleave. */
  private locked<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async importFiles(paths: unknown[], source?: EditAsset['source']): Promise<{ project: EditProject; assets: EditAsset[] }> {
    const project = await this.store.active();
    const next: EditProject = JSON.parse(JSON.stringify(project));
    const added: EditAsset[] = [];
    for (const input of paths.slice(0, MAX_IMPORT)) {
      const file = await resolveMediaPath(input, this.deps.home, this.deps.userData);
      const existing = Object.values(next.assets).find(asset => asset.path === file);
      if (existing) { added.push(existing); continue; }
      const kind = mediaKind(file);
      if (!kind) throw new EditOpError('That file type is not supported.');
      const probe = await probeMedia(this.deps.ffprobe, file);
      if (kind !== 'image' && !(probe.duration > 0)) throw new EditOpError(`${path.basename(file)} has no readable duration.`);
      if (kind === 'video' && !probe.video) throw new EditOpError(`${path.basename(file)} has no video stream.`);
      if (kind === 'audio' && !probe.audio) throw new EditOpError(`${path.basename(file)} has no audio stream.`);
      let id = '';
      for (let n = Object.keys(next.assets).length + 1; ; n += 1) {
        id = `a${n}`;
        if (!next.assets[id]) break;
      }
      const asset: EditAsset = {
        id,
        name: path.basename(file),
        path: file,
        kind,
        duration: kind === 'image' ? 0 : probe.duration,
        width: probe.video?.width || 0,
        height: probe.video?.height || 0,
        fps: probe.video?.fps || 0,
        hasVideo: Boolean(probe.video) && kind !== 'audio',
        hasAudio: Boolean(probe.audio) && kind !== 'image',
        source
      };
      next.assets[id] = asset;
      added.push(asset);
    }
    next.revision += 1;
    next.updatedAt = new Date().toISOString();
    await this.store.commit(project, next);
    return { project: next, assets: added };
  }

  async edit(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'show');
    try {
      return await this.locked(() => this.editAction(action, input));
    } catch (error: any) {
      if (error instanceof EditOpError) return fail(error.code, error.message, error.code === 'E_NOT_FOUND' ? 'Call smoothy_edit action "show" to see valid ids.' : undefined);
      throw error;
    }
  }

  private summary(project: EditProject): any {
    return { id: project.id, revision: project.revision, duration: Number(projectDuration(project).toFixed(3)), clips: project.clips.length, size: `${project.width}x${project.height}@${project.fps}` };
  }

  private async editAction(action: string, input: any): Promise<AgentResult> {
    switch (action) {
      case 'new': {
        const project = await this.store.create(createProject({ name: input?.name, width: input?.width, height: input?.height, fps: input?.fps }));
        this.deps.trackTool?.('agent_edit_project');
        return ok({ action, project: this.summary(project), name: project.name, next: 'Import media with action "import", then build with action "ops".' });
      }
      case 'list':
        return ok({ action, current: this.store.currentId(), projects: await this.store.list() });
      case 'open': {
        const project = await this.store.open(String(input?.id || ''));
        return ok({ action, ...this.store.describe(project) });
      }
      case 'show': {
        const project = await this.store.active();
        return ok({ action, ...this.store.describe(project, input?.clips !== false), warnings: lintProject(project) });
      }
      case 'import': {
        const paths = Array.isArray(input?.paths) ? input.paths : input?.path ? [input.path] : [];
        if (!paths.length) return fail('E_BAD_REQUEST', 'Provide paths: ["/absolute/file.mp4", ...].');
        const { assets } = await this.importFiles(paths);
        return ok({
          action,
          assets: assets.map(asset => ({ id: asset.id, name: asset.name, kind: asset.kind, duration: Number(asset.duration.toFixed(2)), size: asset.kind === 'audio' ? undefined : `${asset.width}x${asset.height}`, audio: asset.hasAudio || undefined }))
        });
      }
      case 'ops':
      case 'apply': {
        const project = await this.store.active();
        const { project: next, results } = applyOps(project, input?.ops);
        await this.store.commit(project, next);
        return ok({ action: 'ops', ...this.summary(next), results: results.map(item => (item.clips && item.clips.length <= 8 ? item : { op: item.op, clips: item.clips?.length, note: item.note })), warnings: lintProject(next) });
      }
      case 'cut_silence': return this.cutSilence(input);
      case 'multicam': return this.multicam(input);
      case 'transcribe': return this.transcribe(input);
      case 'undo':
      case 'redo': {
        const project = action === 'undo' ? await this.store.undo() : await this.store.redo();
        return ok({ action, ...this.summary(project), warnings: lintProject(project) });
      }
      default:
        return fail('E_BAD_REQUEST', `Unknown edit action: ${action}`, 'Use new, list, open, show, import, ops, cut_silence, multicam, transcribe, undo or redo.');
    }
  }

  async render(input: any): Promise<AgentResult> {
    const action = String(input?.action || 'frame');
    try {
      const project = await this.store.active();
      if (action === 'frame') return await this.frame(project, input);
      if (action === 'sheet') return await this.sheet(project, input);
      if (action === 'export') return await this.export(project, input);
      if (action === 'analyze') return await this.analyze(project, input);
      return fail('E_BAD_REQUEST', `Unknown render action: ${action}`, 'Use frame, sheet, export or analyze.');
    } catch (error: any) {
      if (error instanceof EditOpError) return fail(error.code, error.message);
      throw error;
    }
  }

  private cacheDir(project: EditProject): string {
    return path.join(this.deps.root, project.id, 'cache');
  }

  private async frameBuffer(project: EditProject, time: number, width: number): Promise<Buffer> {
    const dir = this.cacheDir(project);
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const file = await renderFrame(project, this.deps.ffmpeg, time, width, dir, tag);
    try {
      return await fs.readFile(file);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(path.join(dir, `graph-${tag}.txt`), { force: true });
    }
  }

  private requireContent(project: EditProject): void {
    if (projectDuration(project) <= 0) throw new EditOpError('The timeline is empty. Add clips with smoothy_edit action "ops".');
  }

  private async frame(project: EditProject, input: any): Promise<AgentResult> {
    this.requireContent(project);
    const width = Math.max(160, Math.min(1920, Math.round(Number(input?.width) || 960)));
    const time = Math.max(0, Number(input?.time) || 0);
    const buffer = await this.frameBuffer(project, time, width);
    const meta = await sharp(buffer).metadata();
    this.deps.trackTool?.('agent_edit_preview');
    return ok({ action: 'frame', time, timecode: formatTimecode(time, project.fps), width: meta.width, height: meta.height }, `data:image/jpeg;base64,${buffer.toString('base64')}`);
  }

  private async sheet(project: EditProject, input: any): Promise<AgentResult> {
    this.requireContent(project);
    const total = projectDuration(project);
    let times: number[] = Array.isArray(input?.times) ? input.times.map(Number).filter((value: number) => Number.isFinite(value) && value >= 0) : [];
    if (!times.length) {
      const from = Math.max(0, Number(input?.from) || 0);
      const to = Math.min(total, Number(input?.to) || total);
      const count = Math.max(1, Math.min(24, Math.round(Number(input?.count) || 8)));
      times = Array.from({ length: count }, (_, i) => from + ((to - from) * (i + 0.5)) / count);
    }
    times = times.slice(0, 24);
    const cell = Math.max(160, Math.min(480, Math.round(Number(input?.width) || 320)));
    const cellH = Math.round((cell * project.height) / project.width);
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(times.length))));
    const rows = Math.ceil(times.length / columns);
    const gap = 8;
    const label = 22;
    const layers: sharp.OverlayOptions[] = [];
    let text = '';
    for (let i = 0; i < times.length; i += 1) {
      const buffer = await this.frameBuffer(project, times[i], cell);
      const image = await sharp(buffer).resize(cell, cellH, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
      const col = i % columns;
      const row = Math.floor(i / columns);
      const left = gap + col * (cell + gap);
      const top = gap + row * (cellH + label + gap);
      layers.push({ input: image, left, top });
      text += `<text x="${left + 6}" y="${top + cellH + 16}" fill="#f5f3ec" font-family="Helvetica, Arial, sans-serif" font-size="13">${formatTimecode(times[i], project.fps)}</text>`;
    }
    const width = columns * cell + (columns + 1) * gap;
    const height = rows * (cellH + label) + (rows + 1) * gap;
    const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${text}</svg>`);
    const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } } })
      .composite([...layers, { input: overlay, left: 0, top: 0 }])
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer();
    this.deps.trackTool?.('agent_edit_preview');
    return ok({ action: 'sheet', frames: times.length, width, height, times: times.map(time => Number(time.toFixed(2))) }, `data:image/jpeg;base64,${buffer.toString('base64')}`);
  }

  private async export(project: EditProject, input: any): Promise<AgentResult> {
    this.requireContent(project);
    const preset: RenderPreset = input?.preset === 'draft' || input?.preset === 'high' ? input.preset : 'standard';
    const name = safeName(String(input?.name || project.name));
    const from = input?.from !== undefined ? Math.max(0, Number(input.from) || 0) : undefined;
    const to = input?.to !== undefined ? Math.max(0, Number(input.to) || 0) : undefined;
    const width = input?.width ? Math.max(320, Math.min(7680, Math.round(Number(input.width)))) : undefined;
    const approved = await this.deps.requestApproval('smoothy_render.export', {
      action: 'export',
      project: project.name,
      preset,
      duration: Number(((to ?? projectDuration(project)) - (from ?? 0)).toFixed(1)),
      note: 'Renders the project to an MP4 inside Smoothy\'s agent folder. Your original media is not changed.'
    });
    if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve this export.', 'Open the Agentic tab and approve the export request.');
    const snapshot: EditProject = JSON.parse(JSON.stringify(project));
    const output = path.join(this.deps.root, project.id, 'exports', `${name}-r${project.revision}-${preset}.mp4`);
    const job = this.deps.startJob('render.export', async (progress, signal, jobId) => {
      const workDir = path.join(this.deps.root, project.id, 'work', jobId.slice(0, 8));
      try {
        const result = await exportProject(snapshot, { ffmpeg: this.deps.ffmpeg, workDir, output, preset, width, from, to, loudnorm: input?.loudnorm === true, signal, onProgress: progress });
        const stat = await fs.stat(result.output);
        if (!stat.size) throw new Error('The render produced an empty file.');
        progress(100, 'Export ready');
        this.deps.trackTool?.('agent_edit_export');
        return { path: result.output, duration: Number(result.duration.toFixed(2)), bytes: stat.size, preset, chunks: result.chunks };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ok({ action: 'export', jobId: job.id, status: job.status, output, note: 'Poll smoothy_jobs with action "wait". The result holds the MP4 path.' });
  }

  // ---- Smoothy features ------------------------------------------------------

  private async withWorkDir<T>(project: EditProject, tag: string, task: (dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(this.deps.root, project.id, 'work', `${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      return await task(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async analyze(project: EditProject, input: any): Promise<AgentResult> {
    this.requireContent(project);
    const thresholdDb = clamp(input?.thresholdDb, -70, -10, -35);
    const minSilence = clamp(input?.minSilence, 0.2, 10, 0.5);
    const from = input?.from !== undefined ? Math.max(0, Number(input.from) || 0) : 0;
    const tracks = Array.isArray(input?.tracks) ? input.tracks.map((track: unknown) => String(track).toUpperCase()) : undefined;
    return this.withWorkDir(project, 'analyze', async dir => {
      const mix = await renderAudioMix(project, this.deps.ffmpeg, dir, { from, to: input?.to !== undefined ? Number(input.to) : undefined, tracks, tag: 'analyze' });
      const result = await analyzeWav(this.deps.ffmpeg, mix.wav, { thresholdDb, minSilence });
      const silences = result.silences.map(item => ({ start: Number((item.start + from).toFixed(2)), end: Number((Math.min(item.end, mix.duration) + from).toFixed(2)) }));
      const silentSeconds = Number(silences.reduce((sum, item) => sum + (item.end - item.start), 0).toFixed(1));
      return ok({ action: 'analyze', duration: Number(mix.duration.toFixed(2)), loudness: result.loudness, silentSeconds, silenceCount: silences.length, silences: silences.slice(0, 40), thresholdDb, minSilence });
    });
  }

  private async cutSilence(input: any): Promise<AgentResult> {
    const project = await this.store.active();
    this.requireContent(project);
    const thresholdDb = clamp(input?.thresholdDb, -70, -10, -35);
    const minSilence = clamp(input?.minSilence, 0.2, 10, 0.6);
    const padding = clamp(input?.padding, 0, 1, 0.12);
    const tracks = Array.isArray(input?.tracks) ? input.tracks.map((track: unknown) => String(track).toUpperCase()) : undefined;
    this.deps.trackTool?.('silence');
    return this.withWorkDir(project, 'silence', async dir => {
      const before = projectDuration(project);
      const mix = await renderAudioMix(project, this.deps.ffmpeg, dir, { tracks, tag: 'silence' });
      const analysis = await analyzeWav(this.deps.ffmpeg, mix.wav, { thresholdDb, minSilence });
      const cuts = silenceCuts(analysis.silences, before, padding, project.fps);
      if (!cuts.length) return ok({ action: 'cut_silence', removed: 0, duration: Number(before.toFixed(2)), note: `No silence longer than ${minSilence}s below ${thresholdDb} dB. Try a higher thresholdDb (for example -30) or a shorter minSilence.` });
      const ops = [...cuts].sort((a, b) => b.start - a.start).map(cut => ({ op: 'cut', from: cut.start, to: cut.end }));
      const { project: next } = applyOps(project, ops);
      await this.store.commit(project, next);
      const after = projectDuration(next);
      return ok({ action: 'cut_silence', removed: cuts.length, seconds: Number((before - after).toFixed(2)), duration: Number(after.toFixed(2)), revision: next.revision, note: 'Every track was cut together so sync is kept. Add music after cutting, or undo.', warnings: lintProject(next) });
    });
  }

  private async multicam(input: any): Promise<AgentResult> {
    const project = await this.store.active();
    const cameras: Camera[] = (Array.isArray(input?.cameras) ? input.cameras : []).map((camera: any) => ({ asset: String(camera?.asset || ''), mic: camera?.mic ? String(camera.mic) : undefined, speaker: camera?.speaker ? String(camera.speaker) : undefined }));
    if (cameras.length < 2) throw new EditOpError('multicam needs cameras: [{asset, mic?, speaker?}, ...] with at least two synced videos.');
    if (project.clips.some(clip => clip.track === 'V1')) throw new EditOpError('multicam builds V1 itself. Use an empty project, or remove the V1 clips first.');
    const wide = input?.wide !== undefined ? Number(input.wide) : undefined;
    const audio: 'mics' | 'first' | 'none' = input?.audio === 'none' || input?.audio === 'first' || input?.audio === 'mics' ? input.audio : cameras.some(camera => camera.mic) ? 'mics' : 'first';
    this.deps.trackTool?.('multicam');
    const job = this.deps.startJob('edit.multicam', async (progress, signal, jobId) => {
      const dir = path.join(this.deps.root, project.id, 'work', `mc-${jobId.slice(0, 8)}`);
      try {
        progress(5, 'Reading cameras');
        const plan = await planMulticam(project, cameras, { ffmpeg: this.deps.ffmpeg, workDir: dir, signal, wide, minShot: input?.minShot ? Number(input.minShot) : undefined, hold: input?.hold ? Number(input.hold) : undefined, reaction: input?.reaction !== undefined ? Number(input.reaction) : undefined, from: input?.from ? Number(input.from) : undefined, to: input?.to ? Number(input.to) : undefined, onProgress: progress });
        progress(85, 'Building the timeline');
        return await this.locked(async () => {
          const current = await this.store.load(project.id);
          if (current.revision !== project.revision) throw new EditOpError('The project changed while multicam was running. Run it again.');
          const { project: next } = applyOps(current, multicamOps(current, cameras, plan.shots, audio, plan.total));
          await this.store.commit(current, next);
          progress(100, 'Multicam ready');
          return { ...this.summary(next), ...summarizeShots(next, cameras, plan.shots), speechSegments: plan.speech, firstCuts: plan.shots.slice(0, 8).map(shot => ({ at: Number(shot.start.toFixed(2)), camera: shot.camera })), warnings: lintProject(next) };
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ok({ action: 'multicam', jobId: job.id, status: job.status, note: 'Cameras must be synced and start together. Poll smoothy_jobs with action "wait"; the job result summarises the cuts. Then check with smoothy_render sheet.' });
  }

  private async transcribe(input: any): Promise<AgentResult> {
    const speech = this.deps.speech;
    if (!speech) return fail('E_NOT_IMPLEMENTED', 'Speech transcription is not available in this build.');
    const project = await this.store.active();
    this.requireContent(project);
    if (!speech.isReady()) {
      const approved = await this.deps.requestApproval('smoothy_edit.transcribe', { action: 'transcribe', model: speech.describe(), note: 'Downloads the speech engine and model once (can be several hundred MB). Audio stays on this computer.' });
      if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve the speech engine download.', 'Open the Agentic tab and approve the request.');
    }
    const from = input?.from !== undefined ? Math.max(0, Number(input.from) || 0) : 0;
    const to = input?.to !== undefined ? Number(input.to) : undefined;
    const tracks = Array.isArray(input?.tracks) ? input.tracks.map((track: unknown) => String(track).toUpperCase()) : undefined;
    const language = typeof input?.language === 'string' && input.language.trim() ? input.language.trim().slice(0, 12) : undefined;
    const place = input?.captions === true;
    this.deps.trackTool?.('captions');
    const job = this.deps.startJob('edit.transcribe', async (progress, signal, jobId) => {
      const dir = path.join(this.deps.root, project.id, 'work', `tx-${jobId.slice(0, 8)}`);
      try {
        if (!speech.isReady()) {
          progress(5, 'Preparing speech engine');
          await speech.prepare((percent, message) => progress(5 + percent * 0.25, message), signal);
        }
        progress(32, 'Mixing dialogue');
        const mix = await renderAudioMix(project, this.deps.ffmpeg, dir, { from, to, tracks, tag: 'speech' }, signal);
        progress(38, 'Transcribing');
        const result = await speech.transcribe(mix.wav, language, signal, (percent, message) => progress(38 + percent * 0.52, message));
        const text = result.chunks.map(chunk => chunk.text).join(' ').trim();
        const captions = speech.format({ text, chunks: result.chunks, language: result.language }, { maxCharsPerLine: clamp(input?.maxChars, 12, 80, 38), maxLines: input?.lines === 1 ? 1 : 2, minDurationSeconds: 0.8, maxDurationSeconds: 6, gapBetweenCaptions: 0.04 })
          .map(item => ({ start: Number((item.startTime + from).toFixed(2)), end: Number((item.endTime + from).toFixed(2)), text: item.text.replace(/\s+/g, ' ').trim() }));
        let placed = 0;
        if (place && captions.length) {
          progress(94, 'Adding captions');
          await this.locked(async () => {
            const current = await this.store.load(project.id);
            const { project: next, results } = applyOps(current, [{ op: 'captions', items: captions, style: input?.style }]);
            await this.store.commit(current, next);
            placed = results[0].clips?.length || 0;
          });
        }
        progress(100, 'Transcript ready');
        return { language: result.language, lines: captions.length, placedOnT1: placed, transcript: captions.slice(0, 300).map(item => `${item.start.toFixed(1)}-${item.end.toFixed(1)} ${item.text}`), truncated: captions.length > 300 || undefined };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ok({ action: 'transcribe', jobId: job.id, status: job.status, note: 'Poll smoothy_jobs with action "wait". The result lists timeline-timed lines you can cut by. Pass captions:true to also place them on T1.' });
  }

  // ---- library ---------------------------------------------------------------

  async library(input: any): Promise<AgentResult> {
    const service = this.deps.library;
    if (!service) return fail('E_NOT_IMPLEMENTED', 'The music and stock library is not available in this build.');
    const action = String(input?.action || 'music');
    const limit = Math.round(clamp(input?.limit, 1, 20, 8));
    const controller = new AbortController();
    try {
      if (action === 'music') {
        const hits = await service.musicSearch({ query: typeof input?.query === 'string' ? input.query.slice(0, 120) : undefined, mood: typeof input?.mood === 'string' ? input.mood : undefined, genre: typeof input?.genre === 'string' ? input.genre : undefined, limit });
        return ok({ action, count: hits.length, tracks: hits, note: 'YouTube Audio Library archive. Licence is not verified by the archive; tell the editor to check it before publishing.', next: 'smoothy_library action "add" kind "music" id <id>' });
      }
      if (action === 'stock') {
        const query = String(input?.query || '').trim();
        if (!query) return fail('E_BAD_REQUEST', 'Provide a search query.');
        const hits = await service.stockSearch({ query, provider: typeof input?.provider === 'string' ? input.provider : 'all', orientation: typeof input?.orientation === 'string' ? input.orientation : undefined, limit }, controller.signal);
        return ok({ action, count: hits.length, clips: hits, next: 'smoothy_library action "add" kind "stock" id <ref>' });
      }
      if (action === 'add') {
        const kind = input?.kind === 'stock' ? 'stock' : input?.kind === 'music' ? 'music' : '';
        const id = String(input?.id || '');
        if (!kind || !id) return fail('E_BAD_REQUEST', 'Provide kind ("music" or "stock") and the id/ref from a search.');
        await this.store.active();
        const approved = await this.deps.requestApproval('smoothy_library.add', { action, kind, id: id.slice(0, 60), note: kind === 'music' ? 'Downloads this track into your Smoothy Audio Library and adds it to the edit project.' : 'Downloads this footage into your Smoothy Stock Footage folder and adds it to the edit project.' });
        if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve this download.', 'Open the Agentic tab and approve the request.');
        const job = this.deps.startJob(`library.${kind}`, async (progress, signal) => {
          const fetched = kind === 'music' ? await service.musicFetch(id, signal, progress) : await service.stockFetch(id, signal, progress);
          progress(92, 'Adding to the project');
          const { assets } = await this.locked(() => this.importFiles([fetched.path], { provider: fetched.provider || (kind === 'music' ? 'YouTube Audio Library' : 'stock'), license: fetched.license, credit: fetched.credit, url: fetched.url }));
          const asset = assets[0];
          return { asset: { id: asset.id, name: asset.name, kind: asset.kind, duration: Number(asset.duration.toFixed(2)) }, title: fetched.title, license: fetched.license, credit: fetched.credit, url: fetched.url };
        });
        return ok({ action, jobId: job.id, status: job.status, note: 'Poll smoothy_jobs with action "wait"; the result holds the asset id to use in smoothy_edit ops, plus its licence and credit.' });
      }
      return fail('E_BAD_REQUEST', `Unknown library action: ${action}`, 'Use music, stock or add.');
    } catch (error: any) {
      if (error instanceof EditOpError) return fail(error.code, error.message);
      return fail('E_INTERNAL', error?.message || 'The library request failed.');
    }
  }
}
