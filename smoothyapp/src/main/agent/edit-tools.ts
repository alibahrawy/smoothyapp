/**
 * smoothy_edit / smoothy_render: the agent-facing tools for the headless editor.
 * smoothy_edit builds and changes a project; smoothy_render previews and exports it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  EditOpError,
  PROJECT_LAYOUT,
  applyOps,
  createProject,
  defineRegion,
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
import { fileStamp, hashKey, type ResultCache } from './results';
import { findSfx, levelGain, loadSfx, musicBedGraph, packCues, parseAstats, speechGaps, type Window } from './audio-post';
import { parseEbur128 } from './analysis';
import { runEngine } from './engine';
import { creditLine, savePhoto, stockAttribution, type PhotoHit, type PhotoLicense } from './photos';

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
  /** Disk cache for transcripts and analysis, keyed by input hash. */
  cache?: ResultCache | null;
  /** Resolves a project folder the editor approved for writing, or throws. */
  prepareFolder?: (folder: unknown) => Promise<string>;
  /** Bundled sound effects folder (library.json + files). */
  sfxDir?: string | null;
  /** Wikimedia Commons photo search and download. */
  photos?: { search(input: { query: string; license?: PhotoLicense; limit?: number; orientation?: string }, signal?: AbortSignal): Promise<PhotoHit[]>; download(hit: PhotoHit, file: string, maxWidth: number, signal?: AbortSignal): Promise<{ path: string; width: number; height: number; resized: boolean }> } | null;
  /** Widest image kept on import or download (wider ones get a resized copy). Default 3840. */
  maxImageWidth?: number;
};

const MAX_IMAGE_WIDTH = 3840;

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
      let file = await resolveMediaPath(input, this.deps.home, this.deps.userData);
      const original = file;
      const existing = Object.values(next.assets).find(asset => (asset.path === file || asset.original === file) && !asset.crop);
      if (existing) { added.push(existing); continue; }
      let kind = mediaKind(file);
      if (!kind) throw new EditOpError('That file type is not supported.');
      let resizedFrom: string | undefined;
      if (kind === 'image') {
        // Oversized photos caused render glitches: keep a copy at most 3840 px wide; the original is untouched.
        const max = this.deps.maxImageWidth || MAX_IMAGE_WIDTH;
        const meta = await sharp(file).metadata().catch(() => null);
        if (meta?.width && meta.width > max) {
          const dir = next.folder ? path.join(next.folder, 'Media', 'Photos') : path.join(this.deps.root, next.id, 'media');
          const copy = await uniquePath(path.join(dir, `${path.parse(file).name} ${max}px${/png$/i.test(meta.format || '') ? '.png' : '.jpg'}`));
          await savePhoto(await fs.readFile(file), copy, max);
          resizedFrom = `${meta.width}x${meta.height}`;
          file = copy;
          kind = mediaKind(file) || kind;
        }
      }
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
        ...(probe.video?.alpha && kind !== 'audio' ? { alpha: true } : {}),
        ...(resizedFrom ? { resizedFrom, original } : {}),
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

  /** Imports a source and appends clips (source in/out seconds) end to end on V1 of the open project. */
  async appendClips(source: string, clips: { srcIn: number; srcOut: number; id?: string }[]): Promise<any> {
    return this.locked(async () => {
      await this.store.active();
      const { assets } = await this.importFiles([source]);
      const asset = assets[0];
      let current = await this.store.active();
      const startAt = projectDuration(current);
      const track = asset.kind === 'audio' ? 'A1' : 'V1';
      const ops = clips.map((clip: any) => ({ op: 'add', asset: asset.id, track, in: clip.srcIn, out: clip.srcOut, ...(clip.id ? { name: String(clip.id), meta: { cutId: clip.id, seg: clip.seg, chapter: clip.chapter, chapterSub: clip.chapterSub, angle: clip.angle, words: clip.words, text: typeof clip.text === 'string' ? clip.text.slice(0, 400) : undefined } } : {}) }));
      for (let i = 0; i < ops.length; i += 400) {
        const { project: next } = applyOps(current, ops.slice(i, i + 400));
        await this.store.commit(current, next);
        current = next;
      }
      return { asset: asset.id, added: clips.length, from: Number(startAt.toFixed(3)), to: Number(projectDuration(current).toFixed(3)), ...this.summary(current), warnings: lintProject(current) };
    });
  }

  /** Resolves an asset id in the open project to its file path and asset record. */
  async resolveAsset(assetId: string): Promise<EditAsset> {
    const project = await this.store.active();
    const asset = project.assets[String(assetId || '')];
    if (!asset) throw new EditOpError(`Asset "${assetId}" was not found in the open project.`, 'E_NOT_FOUND');
    return asset;
  }

  /**
   * Takes a snapshot of the open project, imports the cleaned audio WAV, and swaps
   * every audio clip referencing the source asset (or its crop regions) to the cleaned
   * audio asset, keeping all cuts, trims, links and fades intact.
   */
  async replaceAssetAudio(
    target: { assetId?: string; sourcePath?: string },
    cleanedAudioPath: string,
    label = 'before audio cleanup'
  ): Promise<{ snapshot: string; cleanedAssetId: string; updatedClips: number; tracks: string[] }> {
    return this.locked(async () => {
      const project = await this.store.active();
      const matched = new Set<string>();
      if (target.assetId) {
        const base = project.assets[target.assetId];
        if (!base) throw new EditOpError(`Asset "${target.assetId}" was not found in the open project.`, 'E_NOT_FOUND');
        const rootId = base.parent || base.id;
        matched.add(rootId);
        for (const asset of Object.values(project.assets)) {
          if (asset.id === base.id || asset.parent === rootId || asset.path === base.path) matched.add(asset.id);
        }
      } else if (target.sourcePath) {
        const wanted = await fs.realpath(target.sourcePath).catch(() => path.resolve(target.sourcePath!));
        for (const asset of Object.values(project.assets)) {
          const assetReal = await fs.realpath(asset.path).catch(() => path.resolve(asset.path));
          if (assetReal === wanted || asset.original === wanted) matched.add(asset.id);
        }
      }

      const saved = await this.store.snapshot(project, label);
      const next: EditProject = JSON.parse(JSON.stringify(project));
      const cleanFile = await resolveMediaPath(cleanedAudioPath, this.deps.home, this.deps.userData);
      let cleanedAsset = Object.values(next.assets).find(asset => asset.path === cleanFile && asset.kind === 'audio');
      if (!cleanedAsset) {
        const probe = await probeMedia(this.deps.ffprobe, cleanFile);
        if (!probe.audio || !(probe.duration > 0)) throw new EditOpError('Cleaned audio file has no readable audio stream.');
        let id = '';
        for (let n = Object.keys(next.assets).length + 1; ; n += 1) {
          id = `a${n}`;
          if (!next.assets[id]) break;
        }
        cleanedAsset = {
          id,
          name: path.basename(cleanFile),
          path: cleanFile,
          kind: 'audio',
          duration: probe.duration,
          width: 0,
          height: 0,
          fps: 0,
          hasVideo: false,
          hasAudio: true
        };
        next.assets[id] = cleanedAsset;
      }

      let updatedClips = 0;
      const tracks = new Set<string>();
      for (const clip of next.clips) {
        if (clip.kind === 'audio' && clip.asset && matched.has(clip.asset)) {
          clip.asset = cleanedAsset.id;
          updatedClips += 1;
          tracks.add(clip.track);
        }
      }

      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      await this.store.commit(project, next);
      this.deps.trackTool?.('agent_audio_apply');
      return {
        snapshot: `v${saved.version}`,
        cleanedAssetId: cleanedAsset.id,
        updatedClips,
        tracks: [...tracks].sort()
      };
    });
  }

  /** Saves a version of the open project, then applies ops as one undoable change. */
  async applyWithSnapshot(ops: any[], label: string): Promise<any> {
    return this.locked(async () => {
      const project = await this.store.active();
      const saved = await this.store.snapshot(project, label);
      let draft = project;
      for (let i = 0; i < ops.length; i += 400) draft = applyOps(draft, ops.slice(i, i + 400)).project;
      await this.store.commit(project, draft);
      return { snapshot: `v${saved.version}`, ...this.summary(draft), warnings: lintProject(draft) };
    });
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
    return { id: project.id, revision: project.revision, duration: Number(projectDuration(project).toFixed(3)), clips: project.clips.length, size: `${project.width}x${project.height}@${project.fps}`, folder: project.folder };
  }

  /** The open project's folder, if it has one. */
  async activeFolder(): Promise<string | null> {
    try { return (await this.store.active()).folder || null; } catch { return null; }
  }

  /** Cache key for the audio mix of a range: audio clips, their source files and the range. */
  private async mixKey(project: EditProject, extra: Record<string, unknown>): Promise<string> {
    const clips = project.clips.filter(clip => clip.kind === 'audio' && !clip.mute).map(clip => ({ ...clip, id: undefined, link: undefined }));
    const used = [...new Set(clips.map(clip => clip.asset).filter(Boolean))] as string[];
    const stamps = await Promise.all(used.map(id => fileStamp(project.assets[id]?.path || '')));
    return hashKey({ clips, stamps, fps: project.fps, ...extra });
  }

  private async editAction(action: string, input: any): Promise<AgentResult> {
    switch (action) {
      case 'new': {
        let folder: string | undefined;
        if (input?.folder !== undefined && input?.folder !== null && input?.folder !== '') {
          if (!this.deps.prepareFolder) return fail('E_NOT_IMPLEMENTED', 'Project folders are not available in this build.');
          folder = await this.deps.prepareFolder(input.folder);
          for (const name of PROJECT_LAYOUT) await fs.mkdir(path.join(folder, name), { recursive: true });
        }
        const project = await this.store.create(createProject({ name: input?.name, width: input?.width, height: input?.height, fps: input?.fps, folder }));
        this.deps.trackTool?.('agent_edit_project');
        return ok({
          action,
          project: this.summary(project),
          name: project.name,
          layout: folder ? Object.fromEntries(PROJECT_LAYOUT.map(name => [name, path.join(folder as string, name)])) : undefined,
          next: folder
            ? 'Import media with action "import", then build with action "ops". smoothy_engine runs in Work/ by default; exports and versions go to Edit/.'
            : 'Import media with action "import", then build with action "ops". Pass folder to also get Edit/, Media/, Graphics/ and Work/ on disk.'
        });
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
      case 'region': {
        const project = await this.store.active();
        const next: EditProject = JSON.parse(JSON.stringify(project));
        const asset = defineRegion(next, { asset: input?.asset, name: input?.name, crop: input?.crop });
        next.revision += 1;
        next.updatedAt = new Date().toISOString();
        await this.store.commit(project, next);
        return ok({ action, asset: { id: asset.id, name: asset.name, size: `${asset.crop?.w}x${asset.crop?.h}`, crop: asset.crop, of: asset.parent }, next: `Add clips with {op:"add", asset:"${asset.id}"}; they keep the source timecode. Punch in with {op:"set", clip, zoom, anchor:[ex, ey]}.` });
      }
      case 'music_bed': return this.musicBed(input);
      case 'sfx': return this.sfx(input);
      case 'sfx_search': {
        const library = await loadSfx(this.deps.sfxDir);
        const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
        const words = query.split(/\s+/).filter(Boolean);
        const hits = library.filter(item => (!input?.category || item.category === input.category) && words.every((word: string) => [item.id, item.title, item.category, ...item.tags].join(' ').toLowerCase().includes(word)));
        return ok({ action, count: hits.length, categories: [...new Set(library.map(item => item.category))], sounds: hits.slice(0, 40).map(item => ({ id: item.id, title: item.title, category: item.category, tags: item.tags.slice(0, 6), seconds: item.duration, license: item.license })) });
      }
      case 'snapshot': {
        const project = await this.store.active();
        const saved = await this.store.snapshot(project, typeof input?.label === 'string' ? input.label : '');
        this.deps.trackTool?.('agent_edit_snapshot');
        return ok({ action, version: saved.version, name: `v${saved.version}`, revision: project.revision, file: saved.file, next: 'Restore later with action "restore" version ' + saved.version + '.' });
      }
      case 'versions': {
        const project = await this.store.active();
        const versions = await this.store.versions(project);
        return ok({ action, count: versions.length, versions: versions.map(({ file, ...row }) => row), current: project.revision });
      }
      case 'restore': {
        const version = Number(String(input?.version ?? '').replace(/^v/i, ''));
        if (!Number.isInteger(version) || version < 1) return fail('E_BAD_REQUEST', 'Provide version, for example 2 or "v2".');
        const project = await this.store.restore(version);
        this.deps.trackTool?.('agent_edit_restore');
        return ok({ action, restored: `v${version}`, ...this.summary(project), note: 'Undo returns to the state before the restore. Saved versions are kept.', warnings: lintProject(project) });
      }
      case 'undo':
      case 'redo': {
        const project = action === 'undo' ? await this.store.undo() : await this.store.redo();
        return ok({ action, ...this.summary(project), warnings: lintProject(project) });
      }
      default:
        return fail('E_BAD_REQUEST', `Unknown edit action: ${action}`, 'Use new, list, open, show, import, region, ops, cut_silence, multicam, transcribe, music_bed, sfx, sfx_search, snapshot, versions, restore, undo or redo.');
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
      if (action === 'proxy') return await this.proxy(project, input);
      return fail('E_BAD_REQUEST', `Unknown render action: ${action}`, 'Use frame, sheet, proxy, export or analyze.');
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
    const output = await uniquePath(project.folder
      ? path.join(project.folder, 'Edit', `${name} r${project.revision} ${preset}.mp4`)
      : path.join(this.deps.root, project.id, 'exports', `${name}-r${project.revision}-${preset}.mp4`));
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

  /** A small draft render of the timeline for a quick watch-through. No approval: it stays in the project. */
  private async proxy(project: EditProject, input: any): Promise<AgentResult> {
    this.requireContent(project);
    const width = Math.max(320, Math.min(1280, Math.round(Number(input?.width) || 640)));
    const dir = project.folder ? path.join(project.folder, 'Work', 'proxy') : path.join(this.deps.root, project.id, 'proxy');
    await fs.mkdir(dir, { recursive: true });
    const output = await uniquePath(path.join(dir, `${safeName(project.name)} r${project.revision} proxy.mp4`));
    const from = input?.from !== undefined ? Math.max(0, Number(input.from) || 0) : undefined;
    const to = input?.to !== undefined ? Math.max(0, Number(input.to) || 0) : undefined;
    const snapshot: EditProject = JSON.parse(JSON.stringify(project));
    this.deps.trackTool?.('agent_edit_proxy');
    const job = this.deps.startJob('render.proxy', async (progress, signal, jobId) => {
      const workDir = path.join(this.deps.root, project.id, 'work', `px-${jobId.slice(0, 8)}`);
      try {
        const result = await exportProject(snapshot, { ffmpeg: this.deps.ffmpeg, workDir, output, preset: 'draft', width, from, to, loudnorm: false, signal, onProgress: progress });
        progress(100, 'Proxy ready');
        return { path: result.output, duration: Number(result.duration.toFixed(2)), bytes: (await fs.stat(result.output)).size, width };
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ok({ action: 'proxy', jobId: job.id, status: job.status, output, note: 'Draft quality for checking only. Poll smoothy_jobs with action "wait".' });
  }

  // ---- music bed and sound effects ----------------------------------------------

  private async measure(file: string, kind: 'lufs' | 'levels'): Promise<any> {
    const key = hashKey({ kind, stamp: await fileStamp(file) });
    const hit = await this.deps.cache?.get('audio-measure', key);
    if (hit) return hit;
    const filter = kind === 'lufs' ? 'ebur128=peak=true:framelog=verbose' : 'astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level';
    const run = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-i', file, '-vn', '-af', filter, '-f', 'null', '-'], { cwd: this.deps.root, timeoutMs: 600000, tailLines: 60 });
    if (run.exitCode !== 0) throw new EditOpError(`Could not measure ${path.basename(file)}.`);
    const value = kind === 'lufs' ? parseEbur128(run.stderrTail.join('\n')) : parseAstats(run.stderrTail.join('\n'));
    await this.deps.cache?.set('audio-measure', key, value).catch(() => {});
    return value;
  }

  private async musicBed(input: any): Promise<AgentResult> {
    const project = await this.store.active();
    let music = input?.asset ? project.assets[String(input.asset)] : undefined;
    if (input?.asset && !music) return fail('E_NOT_FOUND', `Asset "${input.asset}" is not in this project.`);
    let musicPath = music?.path;
    if (!music) {
      if (!input?.path) return fail('E_BAD_REQUEST', 'Provide the music as asset (from import or smoothy_library add) or path.');
      musicPath = await resolveMediaPath(input.path, this.deps.home, this.deps.userData);
    }
    if (music && !music.hasAudio) return fail('E_BAD_REQUEST', `${music.name} has no audio.`);
    const total = Number(input?.duration) > 0 ? Number(input.duration) : projectDuration(project);
    if (!(total > 1)) return fail('E_BAD_REQUEST', 'The timeline is empty; build the edit before the music bed.');
    const probe = await probeMedia(this.deps.ffprobe, musicPath as string);
    const targetLufs = clamp(input?.targetLufs, -60, -10, -33.5);
    const liftLufs = clamp(input?.liftLufs, -60, -6, -24);
    const crossfade = clamp(input?.crossfade, 0.2, 10, 3);
    const voiceTrack = typeof input?.voiceTrack === 'string' ? input.voiceTrack.toUpperCase() : 'A1';
    let lifts: Window[];
    if (Array.isArray(input?.lifts)) lifts = input.lifts.map((item: any) => ({ from: Number(item?.from), to: Number(item?.to) })).filter((item: Window) => Number.isFinite(item.from) && Number.isFinite(item.to));
    else lifts = speechGaps(project, voiceTrack, total, clamp(input?.minGap, 0.3, 30, 1.5));
    this.deps.trackTool?.('agent_edit_music_bed');
    const job = this.deps.startJob('edit.music_bed', async (progress, signal) => {
      progress(3, 'Measuring the music');
      const lufs = await this.measure(musicPath as string, 'lufs');
      if (!Number.isFinite(lufs?.integrated)) throw new EditOpError('Could not measure the music loudness.');
      const { graph, loops, windows } = musicBedGraph({ total, sourceSeconds: probe.duration, sourceLufs: lufs.integrated, targetLufs, liftLufs, lifts, crossfade, fadeIn: clamp(input?.fadeIn, 0, 10, 1.2), fadeOut: clamp(input?.fadeOut, 0, 20, 3) });
      const dir = project.folder ? path.join(project.folder, 'Media', 'Music') : path.join(this.deps.root, project.id, 'audio');
      await fs.mkdir(dir, { recursive: true });
      const output = await uniquePath(path.join(dir, `${safeName(path.parse(musicPath as string).name)} bed r${project.revision}.wav`));
      const script = `${output}.graph.txt`;
      await fs.writeFile(script, graph);
      try {
        progress(8, `Building the bed (${loops} loop${loops === 1 ? '' : 's'})`);
        const inputs = Array.from({ length: loops }, () => ['-i', musicPath as string]).flat();
        const run = await runEngine(this.deps.ffmpeg, 'ffmpeg', ['-nostdin', '-hide_banner', '-y', ...inputs, '-filter_complex_script', script, '-map', '[o]', '-ac', '2', '-c:a', 'pcm_s24le', output], { cwd: dir, signal, timeoutMs: 3600000, expected: total, onProgress: p => progress(8 + p * 0.8, 'Building the bed') });
        if (run.exitCode !== 0) throw new EditOpError(`The music bed failed: ${run.stderrTail.slice(-2).join(' ')}`);
      } finally {
        await fs.rm(script, { force: true }).catch(() => {});
      }
      progress(92, 'Adding it to the timeline');
      return this.locked(async () => {
        const { assets } = await this.importFiles([output], music?.source);
        let current = await this.store.load(project.id);
        const ops: any[] = input?.replace === false ? [] : current.clips.filter(clip => (clip.meta as any)?.kind === 'music').map(clip => ({ op: 'remove', clip: clip.id }));
        const used = new Set(current.clips.filter(clip => (clip.meta as any)?.kind !== 'music' && clip.track[0] === 'A').map(clip => clip.track));
        let track = typeof input?.track === 'string' ? input.track.toUpperCase() : '';
        if (!track) for (let n = 2; n < 40; n += 1) if (!used.has(`A${n}`)) { track = `A${n}`; break; }
        ops.push({ op: 'add', asset: assets[0].id, at: 0, track, name: 'Music bed', meta: { kind: 'music', source: path.basename(musicPath as string), license: music?.source?.license, credit: music?.source?.credit } });
        const { project: next } = applyOps(current, ops);
        await this.store.commit(current, next);
        current = next;
        progress(100, 'Music bed ready');
        return {
          file: output, track, seconds: Number(total.toFixed(2)), sourceLufs: lufs.integrated, targetLufs, liftLufs, lifts: windows.length,
          liftWindows: windows.slice(0, 12).map(w => ({ from: Number(w.from.toFixed(2)), to: Number(w.to.toFixed(2)) })),
          credit: music?.source?.credit, license: music?.source?.license, warnings: lintProject(current)
        };
      });
    });
    return ok({ action: 'music_bed', jobId: job.id, status: job.status, liftWindows: lifts.length, note: 'Poll smoothy_jobs with action "wait". Tell the editor the music licence and credit.' });
  }

  private async sfx(input: any): Promise<AgentResult> {
    const cues = Array.isArray(input?.cues) ? input.cues.slice(0, 300) : [];
    if (!cues.length) return fail('E_BAD_REQUEST', 'Provide cues: [{at, name}] (name = id, title or tags from sfx_search) or [{at, path}].');
    const library = await loadSfx(this.deps.sfxDir);
    const resolved: { at: number; file: string; title: string; entry?: any; gainDb: number; level: boolean }[] = [];
    const unknown: string[] = [];
    for (const cue of cues) {
      const at = Number(cue?.at);
      if (!Number.isFinite(at) || at < 0) { unknown.push(`at ${cue?.at}`); continue; }
      if (cue?.path) {
        const file = await resolveMediaPath(cue.path, this.deps.home, this.deps.userData);
        resolved.push({ at, file, title: path.parse(file).name, gainDb: Number(cue.gainDb) || 0, level: cue.level !== false && input?.level !== false });
        continue;
      }
      const entry = findSfx(library, String(cue?.name ?? cue?.id ?? ''));
      if (!entry) { unknown.push(String(cue?.name ?? cue?.id ?? '')); continue; }
      resolved.push({ at, file: entry.file, title: entry.title, entry, gainDb: Number(cue.gainDb) || 0, level: cue.level !== false && input?.level !== false });
    }
    if (!resolved.length) return fail('E_NOT_FOUND', `No cue matched a sound: ${unknown.slice(0, 5).join(', ')}`, 'List sounds with smoothy_edit action "sfx_search".');
    const peakTarget = clamp(input?.peakDb, -40, -1, -18);
    const rmsMax = clamp(input?.rmsMaxDb, -60, -6, -32);
    const gains = new Map<string, number>();
    for (const file of new Set(resolved.map(item => item.file))) {
      const levels = await this.measure(file, 'levels');
      gains.set(file, levelGain(levels.peak, levels.rms, peakTarget, rmsMax));
    }
    this.deps.trackTool?.('agent_edit_sfx');
    // Edit actions already hold the project lock (see edit()), so no second lock here.
    {
      const { assets } = await this.importFiles([...new Set(resolved.map(item => item.file))]);
      const byPath = new Map(assets.map(asset => [asset.path, asset]));
      const current = await this.store.active();
      const lanes = packCues(current, resolved.map(item => ({ at: item.at, length: byPath.get(item.file)?.duration || 1 })));
      const ops = resolved.map((item, i) => ({
        op: 'add', asset: byPath.get(item.file)!.id, at: item.at, track: lanes[i],
        volume: (item.level ? gains.get(item.file) || 0 : 0) + item.gainDb,
        name: item.title, meta: { kind: 'sfx', sound: item.entry?.id, license: item.entry?.license, author: item.entry?.author }
      }));
      const { project: next } = applyOps(current, ops);
      await this.store.commit(current, next);
      return ok({
        action: 'sfx', placed: ops.length, tracks: [...new Set(lanes)], unknown: unknown.length ? unknown : undefined,
        cues: ops.slice(0, 12).map((op, i) => ({ at: resolved[i].at, sound: resolved[i].title, track: op.track, gainDb: Number(op.volume.toFixed(1)) })),
        licenses: [...new Set(resolved.map(item => item.entry ? `${item.entry.title}: ${item.entry.license}${item.entry.author ? ` (${item.entry.author})` : ''}` : null).filter(Boolean))].slice(0, 20),
        warnings: lintProject(next)
      });
    }
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
    const to = input?.to !== undefined ? Number(input.to) : undefined;
    const key = this.deps.cache ? await this.mixKey(project, { from, to, tracks, thresholdDb, minSilence }) : '';
    const cached = key ? await this.deps.cache?.get<{ mix: { duration: number }; result: Awaited<ReturnType<typeof analyzeWav>> }>('analyze', key) : null;
    return this.withWorkDir(project, 'analyze', async dir => {
      let mix: { duration: number } = cached?.mix as any;
      let result = cached?.result as Awaited<ReturnType<typeof analyzeWav>>;
      if (!cached) {
        const rendered = await renderAudioMix(project, this.deps.ffmpeg, dir, { from, to, tracks, tag: 'analyze' });
        result = await analyzeWav(this.deps.ffmpeg, rendered.wav, { thresholdDb, minSilence });
        mix = { duration: rendered.duration };
        if (key) await this.deps.cache?.set('analyze', key, { mix, result }).catch(() => {});
      }
      const silences = result.silences.map(item => ({ start: Number((item.start + from).toFixed(2)), end: Number((Math.min(item.end, mix.duration) + from).toFixed(2)) }));
      const silentSeconds = Number(silences.reduce((sum, item) => sum + (item.end - item.start), 0).toFixed(1));
      return ok({ action: 'analyze', duration: Number(mix.duration.toFixed(2)), loudness: result.loudness, silentSeconds, silenceCount: silences.length, silences: silences.slice(0, 40), thresholdDb, minSilence, cached: Boolean(cached) || undefined });
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
        const key = this.deps.cache ? await this.mixKey(project, { from, to, tracks, model: speech.describe(), language: language || 'auto' }) : '';
        let result = key ? await this.deps.cache?.get<Awaited<ReturnType<SpeechService['transcribe']>>>('transcribe', key) : null;
        const cachedTranscript = Boolean(result);
        if (!result) {
          progress(32, 'Mixing dialogue');
          const mix = await renderAudioMix(project, this.deps.ffmpeg, dir, { from, to, tracks, tag: 'speech' }, signal);
          progress(38, 'Transcribing');
          result = await speech.transcribe(mix.wav, language, signal, (percent, message) => progress(38 + percent * 0.52, message));
          if (key) await this.deps.cache?.set('transcribe', key, result).catch(() => {});
        } else {
          progress(90, 'Using the cached transcript');
        }
        const text = result.chunks.map(chunk => chunk.text).join(' ').trim();
        const captions = speech.format({ text, chunks: result.chunks, language: result.language }, { maxCharsPerLine: clamp(input?.maxChars, 1, 80, 38), maxLines: input?.lines === 1 ? 1 : 2, minDurationSeconds: 0.8, maxDurationSeconds: 6, gapBetweenCaptions: 0.04 })
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
        return { language: result.language, cached: cachedTranscript || undefined, lines: captions.length, placedOnT1: placed, transcript: captions.slice(0, 300).map(item => `${item.start.toFixed(1)}-${item.end.toFixed(1)} ${item.text}`), truncated: captions.length > 300 || undefined };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    return ok({ action: 'transcribe', jobId: job.id, status: job.status, note: 'Poll smoothy_jobs with action "wait". The result lists timeline-timed lines you can cut by. Pass captions:true to also place them on T1.' });
  }

  // ---- library ---------------------------------------------------------------

  private readonly photoHits = new Map<string, PhotoHit>();

  /** The project's running credits file (Edit/CREDITS.txt in a project folder). */
  private creditsFile(project: EditProject): string {
    return project.folder ? path.join(project.folder, 'Edit', 'CREDITS.txt') : path.join(this.deps.root, project.id, 'CREDITS.txt');
  }

  private async appendCredit(project: EditProject, line: string | null): Promise<string | null> {
    if (!line) return null;
    const file = this.creditsFile(project);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    if (!current.split('\n').includes(line)) await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
    return file;
  }

  async library(input: any): Promise<AgentResult> {
    const service = this.deps.library;
    const action = String(input?.action || 'music');
    const limit = Math.round(clamp(input?.limit, 1, 20, 8));
    const controller = new AbortController();
    try {
      if (action === 'photo') {
        if (!this.deps.photos) return fail('E_NOT_IMPLEMENTED', 'Photo search is not available in this build.');
        const query = String(input?.query || '').trim().slice(0, 120);
        if (!query) return fail('E_BAD_REQUEST', 'Provide a search query.');
        const license: PhotoLicense = input?.license === 'cc-by' ? 'cc-by' : 'pd';
        const hits = await this.deps.photos.search({ query, license, limit, orientation: typeof input?.orientation === 'string' ? input.orientation : undefined }, controller.signal);
        this.deps.trackTool?.('agent_photo_search');
        for (const hit of hits) this.photoHits.set(hit.id, hit);
        while (this.photoHits.size > 300) this.photoHits.delete(this.photoHits.keys().next().value as string);
        return ok({
          action, count: hits.length, license,
          photos: hits.map(hit => ({ id: hit.id, title: hit.title, author: hit.author, license: hit.license, attribution: hit.attribution, size: `${hit.width}x${hit.height}`, restrictions: hit.restrictions, page: hit.page })),
          note: license === 'pd' ? 'CC0 and public domain only. Pass license:"cc-by" to include CC BY (the author must be credited).' : 'Includes CC BY: credit each author (the credits file is written for you). Share-alike, non-commercial and no-derivatives licences are never offered.',
          next: 'smoothy_library action "add" kind "photo" id <id>'
        });
      }
      if (action === 'music' && input?.license && input.license !== 'any') return fail('E_BAD_REQUEST', 'The music archive does not state licences, so it cannot be filtered by licence (for example Claim Clear).', 'Search without license, then confirm the track\'s licence with its provider before publishing.');
      if (!service && action !== 'add' && action !== 'credits') return fail('E_NOT_IMPLEMENTED', 'The music and stock library is not available in this build.');
      if (action === 'music') {
        const hits = await service!.musicSearch({ query: typeof input?.query === 'string' ? input.query.slice(0, 120) : undefined, mood: typeof input?.mood === 'string' ? input.mood : undefined, genre: typeof input?.genre === 'string' ? input.genre : undefined, limit });
        return ok({ action, count: hits.length, tracks: hits, note: 'YouTube Audio Library archive. The archive does not state licences, so Content ID claims are possible; tell the editor to check each track before publishing.', next: 'smoothy_library action "add" kind "music" id <id>' });
      }
      if (action === 'stock') {
        const query = String(input?.query || '').trim();
        if (!query) return fail('E_BAD_REQUEST', 'Provide a search query.');
        const hits = (await service!.stockSearch({ query, provider: typeof input?.provider === 'string' ? input.provider : 'all', orientation: typeof input?.orientation === 'string' ? input.orientation : undefined, limit: 20 }, controller.signal))
          .map(hit => ({ ...hit, attribution: stockAttribution(hit.license) }));
        const filtered = input?.license === 'no-attribution' ? hits.filter(hit => hit.attribution === 'none') : hits;
        return ok({ action, count: Math.min(limit, filtered.length), clips: filtered.slice(0, limit), filteredOut: hits.length - filtered.length || undefined, next: 'smoothy_library action "add" kind "stock" id <ref>' });
      }
      if (action === 'credits') {
        const project = await this.store.active();
        const lines = Object.values(project.assets).filter(asset => !asset.crop).map(creditLine).filter((line): line is string => Boolean(line));
        const unique = [...new Set(lines)];
        const file = this.creditsFile(project);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, unique.length ? `${unique.join('\n')}\n` : '');
        this.deps.trackTool?.('agent_credits_written');
        return ok({ action, count: unique.length, file, lines: unique.slice(0, 30), note: 'Paste these into the video description. Rewritten from every sourced asset in the project.' });
      }
      if (action === 'add') {
        const kind = input?.kind === 'stock' ? 'stock' : input?.kind === 'music' ? 'music' : input?.kind === 'photo' ? 'photo' : '';
        const id = String(input?.id || '');
        if (!kind || !id) return fail('E_BAD_REQUEST', 'Provide kind ("music", "stock" or "photo") and the id/ref from a search.');
        if (kind !== 'photo' && !service) return fail('E_NOT_IMPLEMENTED', 'The music and stock library is not available in this build.');
        const project = await this.store.active();
        const hit = kind === 'photo' ? this.photoHits.get(id) : undefined;
        if (kind === 'photo' && (!hit || !this.deps.photos)) return fail('E_NOT_FOUND', 'Search photos again and use an id from the results.');
        const approved = await this.deps.requestApproval('smoothy_library.add', { action, kind, id: id.slice(0, 60), ...(hit ? { title: hit.title, author: hit.author, license: hit.license } : {}), note: kind === 'music' ? 'Downloads this track into your Smoothy Audio Library and adds it to the edit project.' : kind === 'stock' ? 'Downloads this footage into your Smoothy Stock Footage folder and adds it to the edit project.' : 'Downloads this photo (at most 3840 px wide) into the project and adds it to the edit.' });
        if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve this download.', 'Open the Agentic tab and approve the request.');
        const job = this.deps.startJob(`library.${kind}`, async (progress, signal) => {
          let fetched: { path: string; title: string; license?: string; credit?: string; url?: string; provider?: string };
          let resized = false;
          if (kind === 'photo') {
            const dir = project.folder ? path.join(project.folder, 'Media', 'Photos') : path.join(this.deps.root, project.id, 'photos');
            const ext = hit!.mime === 'image/png' ? '.png' : hit!.mime === 'image/webp' ? '.webp' : '.jpg';
            const file = await uniquePath(path.join(dir, `${safeName(hit!.title)}${ext}`));
            progress(10, 'Downloading photo');
            const saved = await this.deps.photos!.download(hit!, file, this.deps.maxImageWidth || MAX_IMAGE_WIDTH, signal);
            resized = saved.resized;
            fetched = { path: saved.path, title: hit!.title, license: hit!.license, provider: 'Wikimedia Commons', url: hit!.page, credit: `"${hit!.title}" by ${hit!.author}` };
          } else {
            fetched = kind === 'music' ? await service!.musicFetch(id, signal, progress) : await service!.stockFetch(id, signal, progress);
          }
          progress(92, 'Adding to the project');
          const { assets } = await this.locked(() => this.importFiles([fetched.path], { provider: fetched.provider || (kind === 'music' ? 'YouTube Audio Library' : kind === 'photo' ? 'Wikimedia Commons' : 'stock'), license: fetched.license, credit: fetched.credit, url: fetched.url }));
          const asset = assets[0];
          const credits = await this.appendCredit(await this.store.active(), creditLine(asset)).catch(() => null);
          if (kind === 'photo') this.deps.trackTool?.('agent_photo_add');
          return { asset: { id: asset.id, name: asset.name, kind: asset.kind, duration: Number(asset.duration.toFixed(2)), size: asset.kind === 'audio' ? undefined : `${asset.width}x${asset.height}` }, title: fetched.title, license: fetched.license, credit: fetched.credit, url: fetched.url, resized: resized || undefined, creditsFile: credits || undefined };
        });
        return ok({ action, jobId: job.id, status: job.status, note: 'Poll smoothy_jobs with action "wait"; the result holds the asset id to use in smoothy_edit ops, plus its licence and credit (also added to the credits file).' });
      }
      return fail('E_BAD_REQUEST', `Unknown library action: ${action}`, 'Use music, stock, photo, add or credits.');
    } catch (error: any) {
      if (error instanceof EditOpError) return fail(error.code, error.message);
      return fail('E_INTERNAL', error?.message || 'The library request failed.');
    }
  }
}

/** Adds " (2)", " (3)" … so an existing file is never overwritten. */
export async function uniquePath(file: string): Promise<string> {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? file : `${base} (${n})${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return `${base} ${Date.now()}${ext}`;
}
