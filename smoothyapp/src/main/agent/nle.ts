/**
 * smoothy_nle: the round-trip with Premiere, so one MCP is enough.
 *
 * - export_xml: the open headless edit → FCP7 xmeml (xml-export.ts) in Edit/,
 *   versioned (v1, v2 …), never overwriting, with a sidecar of what was sent.
 * - import_xml: checks every file is on disk (no offline media), asks the
 *   editor, and imports into the open Premiere project as a new sequence.
 * - live_diff: reads the editor's live sequence (source ranges per track),
 *   diffs it against the agent's last export (trims, removed, added, splits,
 *   order, J/L cuts), writes the editor's cut as a clip list, and with
 *   apply:true rebuilds the headless edit from it (after a snapshot), so the
 *   next version starts from the human's cut.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDuration, type EditProject } from './edit-project';
import { projectToXmeml, type ExportedClip, type Sidecar } from './xml-export';
import type { AgentResult } from './types';

export type LiveClip = { name: string; path: string; start: number; end: number; srcIn: number; srcOut: number };
export type LiveTrack = { name: string; clips: LiveClip[] };

/** Smoothy's sequence info (Premiere CEP or Resolve) → V1…/A1… tracks of source ranges. */
export function liveTracks(sequence: any): LiveTrack[] {
  const tracks: LiveTrack[] = [];
  const read = (list: any[], prefix: 'V' | 'A') => {
    for (const track of Array.isArray(list) ? list : []) {
      const index = Number.isFinite(Number(track?.index)) ? Number(track.index) : tracks.filter(item => item.name[0] === prefix).length;
      const clips = (Array.isArray(track?.clips) ? track.clips : [])
        .filter((clip: any) => !clip?.disabled)
        .map((clip: any) => ({
          name: String(clip?.name ?? ''),
          path: String(clip?.path ?? ''),
          start: Number(clip?.start ?? clip?.startSeconds) || 0,
          end: Number(clip?.end ?? clip?.endSeconds) || 0,
          srcIn: Number(clip?.inPoint ?? clip?.inPointSeconds) || 0,
          srcOut: Number(clip?.outPoint ?? clip?.outPointSeconds) || 0
        }))
        .sort((a: LiveClip, b: LiveClip) => a.start - b.start);
      tracks.push({ name: `${prefix}${index + 1}`, clips });
    }
  };
  read(sequence?.videoTracks, 'V');
  read(sequence?.audioTracks, 'A');
  return tracks;
}

export type Matched = { live: LiveClip; prev: ExportedClip | null; piece: number; trimIn: number; trimOut: number };

export type TrackDiff = {
  track: string;
  live: number;
  previous: number;
  matched: Matched[];
  trimmed: { name: string; inBy: number; outBy: number }[];
  removed: { name: string; srcIn: number; srcOut: number }[];
  added: { name: string; path: string; srcIn: number; srcOut: number; start: number }[];
  splits: string[];
  reordered: number;
};

const r3 = (value: number) => Number(value.toFixed(3));

/** Matches live clips to the exported ones by name (then by file and overlapping source range). */
export function diffTrack(track: string, live: LiveClip[], previous: ExportedClip[], fps: number): TrackDiff {
  const tolerance = 0.5 / fps;
  const prev = [...previous].sort((a, b) => a.start - b.start);
  const used = new Set<number>();
  const pieces = new Map<number, number>();
  const matched: Matched[] = [];
  for (const clip of live) {
    let index = prev.findIndex((item, i) => item.name === clip.name && !used.has(i));
    let piece = 0;
    if (index < 0) {
      const again = prev.findIndex(item => item.name === clip.name);
      if (again >= 0) { index = again; piece = (pieces.get(again) || 0) + 1; }
    }
    if (index < 0) {
      index = prev.findIndex((item, i) => !used.has(i) && item.path === clip.path && item.srcIn < clip.srcOut && clip.srcIn < item.srcOut);
    }
    if (index >= 0) {
      if (piece === 0) used.add(index);
      pieces.set(index, Math.max(piece, pieces.get(index) || 0));
      const p = prev[index];
      matched.push({ live: clip, prev: p, piece, trimIn: r3(clip.srcIn - p.srcIn), trimOut: r3(clip.srcOut - p.srcOut) });
    } else {
      matched.push({ live: clip, prev: null, piece: 0, trimIn: 0, trimOut: 0 });
    }
  }
  const order = matched.filter(item => item.prev && item.piece === 0).map(item => prev.indexOf(item.prev as ExportedClip));
  let reordered = 0;
  for (let i = 1; i < order.length; i += 1) if (order[i] < order[i - 1]) reordered += 1;
  return {
    track,
    live: live.length,
    previous: prev.length,
    matched,
    trimmed: matched.filter(item => item.prev && item.piece === 0 && (Math.abs(item.trimIn) > tolerance || Math.abs(item.trimOut) > tolerance)).map(item => ({ name: item.live.name, inBy: item.trimIn, outBy: item.trimOut })),
    removed: prev.filter((_, i) => !used.has(i)).map(item => ({ name: item.name, srcIn: r3(item.srcIn), srcOut: r3(item.srcOut) })),
    added: matched.filter(item => !item.prev).map(item => ({ name: item.live.name, path: item.live.path, srcIn: r3(item.live.srcIn), srcOut: r3(item.live.srcOut), start: r3(item.live.start) })),
    splits: matched.filter(item => item.piece > 0).map(item => item.live.name),
    reordered
  };
}

/** The editor's cut on the main track as a clip list (cut_phrases format), with J/L cut audio ranges. */
export function liveClipList(main: TrackDiff, audio: LiveTrack | null, fps: number): { clips: any[]; avMismatch: { name: string; video: number[]; audio: number[] }[] } {
  const avMismatch: { name: string; video: number[]; audio: number[] }[] = [];
  const tolerance = 0.5 / fps;
  const clips = main.matched.map((item, i) => {
    const meta: any = item.prev?.meta || {};
    const base = meta.cutId ? String(meta.cutId) : item.live.name || `live${i + 1}`;
    const id = item.piece ? `${base}#${item.piece}` : base;
    const out: any = {
      id, seg: meta.seg ?? base, angle: meta.angle, chapter: meta.chapter ?? null, chapterSub: meta.chapterSub ?? null,
      fIn: Math.round(item.live.srcIn * fps), fOut: Math.round(item.live.srcOut * fps),
      srcIn: r3(Math.round(item.live.srcIn * fps) / fps), srcOut: r3(Math.round(item.live.srcOut * fps) / fps),
      words: meta.words ?? [0, -1], text: meta.text ?? '', source: item.live.path, name: item.live.name,
      projectClip: item.prev?.clipId, changed: !item.prev || item.piece > 0 || Math.abs(item.trimIn) > tolerance || Math.abs(item.trimOut) > tolerance
    };
    const partner = audio?.clips.find(clip => Math.abs(clip.start - item.live.start) <= tolerance && Math.abs(clip.end - item.live.end) <= tolerance * 4);
    // A J/L cut only means something when picture and sound come from the same file.
    const sameFile = Boolean(partner?.path) && partner?.path === item.live.path;
    if (partner && sameFile && (Math.abs(partner.srcIn - item.live.srcIn) > tolerance || Math.abs(partner.srcOut - item.live.srcOut) > tolerance)) {
      out.audio = [r3(partner.srcIn), r3(partner.srcOut)];
      avMismatch.push({ name: item.live.name, video: [r3(item.live.srcIn), r3(item.live.srcOut)], audio: out.audio });
    }
    return out;
  });
  return { clips, avMismatch };
}

export type NleDeps = {
  activeProject: () => Promise<EditProject>;
  /** Edit/ of the project folder, else Smoothy's agent exports folder. */
  exportDir: (project: EditProject) => string;
  workDir: () => Promise<string>;
  uniquePath: (file: string) => Promise<string>;
  readRoots: () => string[];
  within: (file: string, roots: string[]) => boolean;
  getActiveNLE: () => 'premiere' | 'resolve' | null;
  isEditorConnected: () => boolean;
  getSequenceInfo: () => any;
  requestSequenceInfo: () => void;
  importXml?: (file: string) => Promise<{ success?: boolean; error?: string }>;
  /** Snapshots the open project, then applies ops atomically. */
  applyWithSnapshot: (ops: any[], label: string) => Promise<any>;
  requestApproval: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  trackTool?: (id: string) => void;
};

const ok = (data: unknown): AgentResult => ({ ok: true, data });
const fail = (code: any, message: string, next?: string): AgentResult => ({ ok: false, error: { code, message, next } });
const safe = (value: string) => value.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Edit';

export class NleEngine {
  constructor(private readonly deps: NleDeps) {}

  async run(input: any): Promise<AgentResult> {
    const action = String(input?.action || '');
    try {
      switch (action) {
        case 'export_xml': return await this.exportXml(input);
        case 'import_xml': return await this.importXml(input);
        case 'live_diff': return await this.liveDiff(input);
        default: return fail('E_BAD_REQUEST', `Unknown nle action: ${action || '(none)'}`, 'Use export_xml, import_xml or live_diff.');
      }
    } catch (error: any) {
      if (typeof error?.code === 'string' && error.code.startsWith('E_')) return fail(error.code, error.message);
      throw error;
    }
  }

  private async sidecars(dir: string): Promise<{ file: string; data: Sidecar }[]> {
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const rows: { file: string; data: Sidecar }[] = [];
    for (const name of names.filter(item => item.endsWith('.smoothy.json'))) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (data?.kind === 'smoothy-xml-export') rows.push({ file: path.join(dir, name), data });
      } catch {
        // Skip unreadable sidecars.
      }
    }
    return rows.sort((a, b) => String(a.data.exportedAt).localeCompare(String(b.data.exportedAt)));
  }

  private async readJson(file: unknown, label: string): Promise<any> {
    if (typeof file !== 'string' || !file.trim()) throw Object.assign(new Error(`Provide ${label} as a file path.`), { code: 'E_BAD_REQUEST' });
    const real = await fs.realpath(path.resolve(file)).catch(() => '');
    if (!real) throw Object.assign(new Error(`${label} was not found.`), { code: 'E_NOT_FOUND' });
    if (!this.deps.within(real, this.deps.readRoots())) throw Object.assign(new Error(`${label} is outside the folders Smoothy can read.`), { code: 'E_PATH_DENIED' });
    return JSON.parse(await fs.readFile(real, 'utf8'));
  }

  /** The sidecar to compare with: given explicitly, else the newest export of the open project. */
  private async sidecarFor(input: any): Promise<{ file: string; data: Sidecar }> {
    if (input?.version) {
      const given = String(input.version);
      const file = given.endsWith('.xml') ? given.replace(/\.xml$/, '.smoothy.json') : given;
      const data = await this.readJson(file, 'version (the .smoothy.json written next to an exported XML)');
      if (data?.kind !== 'smoothy-xml-export') throw Object.assign(new Error('That file is not a Smoothy XML export record.'), { code: 'E_BAD_REQUEST' });
      return { file, data };
    }
    const project = await this.deps.activeProject();
    const list = (await this.sidecars(this.deps.exportDir(project))).filter(item => item.data.projectId === project.id);
    if (!list.length) throw Object.assign(new Error('This project has no XML export yet.'), { code: 'E_NOT_FOUND' });
    return list[list.length - 1];
  }

  private async exportXml(input: any): Promise<AgentResult> {
    const project = await this.deps.activeProject();
    if (!project.clips.length) return fail('E_BAD_REQUEST', 'The timeline is empty.');
    const dir = this.deps.exportDir(project);
    await fs.mkdir(dir, { recursive: true });
    const base = safe(String(input?.name || project.name));
    const previous = (await this.sidecars(dir)).map(item => /\(v(\d+)\)$/.exec(item.data.sequenceName)).filter(Boolean).map(match => Number((match as RegExpExecArray)[1]));
    const version = Number.isInteger(Number(input?.version)) && Number(input.version) > 0 ? Number(input.version) : Math.max(0, ...previous) + 1;
    const sequenceName = `${base} (v${version})`;
    const xmlPath = await this.deps.uniquePath(path.join(dir, `${sequenceName}.xml`));
    let markers: { title: string; at: number }[] = [];
    if (Array.isArray(input?.markers)) markers = input.markers;
    else if (typeof input?.markers === 'string') markers = (await this.readJson(input.markers, 'markers (chapters JSON from smoothy_cut chapters)'))?.chapters || [];
    markers = markers.map(item => ({ title: String((item as any)?.title ?? (item as any)?.name ?? ''), at: Number((item as any)?.at) || 0 })).filter(item => item.title).slice(0, 200);
    const result = projectToXmeml(project, { sequenceName, markers, pack: input?.pack !== false, xmlPath });
    const missing = [...new Set(result.sidecar.clips.map(clip => clip.path))];
    const offline: string[] = [];
    for (const file of missing) if (!(await fs.stat(file).catch(() => null))) offline.push(file);
    await fs.writeFile(xmlPath, result.xml);
    const sidecarPath = xmlPath.replace(/\.xml$/, '.smoothy.json');
    await fs.writeFile(sidecarPath, JSON.stringify(result.sidecar, null, 1));
    this.deps.trackTool?.('agent_nle_export');
    return ok({
      action: 'export_xml', sequenceName, file: xmlPath, record: sidecarPath, ...result.counts,
      seconds: Number(projectDuration(project).toFixed(2)), fps: project.fps, size: `${project.width}x${project.height}`,
      offline: offline.length ? offline : undefined, warnings: result.warnings,
      next: this.deps.getActiveNLE() !== 'resolve' && this.deps.isEditorConnected() ? 'Import it with smoothy_nle action "import_xml" (the editor approves). It becomes a new sequence.' : 'Open Premiere with the Smoothy panel to import it, or use File › Import in Premiere (Resolve: File › Import › Timeline).'
    });
  }

  private async importXml(input: any): Promise<AgentResult> {
    const record = await this.sidecarFor(input?.xml ? { version: input.xml } : input);
    const xml = record.data.xml;
    if (!(await fs.stat(xml).catch(() => null))) return fail('E_NOT_FOUND', `The XML is missing: ${xml}`);
    const offline: string[] = [];
    for (const file of new Set(record.data.clips.map(clip => clip.path))) if (!(await fs.stat(file).catch(() => null))) offline.push(file);
    if (offline.length) return fail('E_BAD_REQUEST', `${offline.length} source file(s) are missing, so the sequence would import offline: ${offline.slice(0, 3).join(', ')}`, 'Restore the files or re-export after relinking.');
    if (this.deps.getActiveNLE() === 'resolve' || !this.deps.isEditorConnected() || !this.deps.importXml) {
      return fail('E_EDITOR_OFFLINE', 'Premiere is not connected to Smoothy.', `Open Premiere with the Smoothy panel and retry, or import ${xml} with File › Import.`);
    }
    const approved = await this.deps.requestApproval('smoothy_nle.import', {
      action: 'import into Premiere', sequence: record.data.sequenceName, clips: record.data.clips.length,
      note: 'Imports the XML into the open Premiere project as a new sequence. Existing sequences are not changed.'
    });
    if (!approved) return fail('E_APPROVAL_TIMEOUT', 'The editor did not approve the import.', 'Open the Agentic tab and approve it.');
    const result = await this.deps.importXml(xml);
    if (!result?.success) return fail('E_INTERNAL', result?.error || 'Premiere could not import the XML.');
    this.deps.trackTool?.('agent_nle_import');
    this.deps.requestSequenceInfo();
    return ok({ action: 'import_xml', sequenceName: record.data.sequenceName, file: xml, offline: 0, note: 'Imported as a new sequence in the project panel. Ask the editor to open it; earlier versions stay untouched.' });
  }

  private async liveDiff(input: any): Promise<AgentResult> {
    const record = await this.sidecarFor(input);
    this.deps.requestSequenceInfo();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(5000, Number(input?.settleMs ?? 800)))));
    const sequence = this.deps.getSequenceInfo();
    if (!sequence?.hasSequence) return fail('E_NO_SEQUENCE', 'No sequence is open in the editor.', `Open "${record.data.sequenceName}" (the editor's working copy) in Premiere, then retry.`);
    const fps = record.data.fps || Number(sequence.fps) || 30;
    const tracks = liveTracks(sequence);
    const names = [...new Set([...record.data.clips.map(clip => clip.track), ...tracks.map(track => track.name)])].sort();
    const diffs = names.map(name => diffTrack(name, tracks.find(track => track.name === name)?.clips || [], record.data.clips.filter(clip => clip.track === name), fps));
    const mainName = typeof input?.track === 'string' ? input.track.toUpperCase() : record.data.clips.some(clip => clip.track === 'V1') ? 'V1' : 'A1';
    const main = diffs.find(diff => diff.track === mainName);
    if (!main) return fail('E_NOT_FOUND', `Track ${mainName} is not in the live sequence or the export.`);
    const audio = mainName.startsWith('V') ? tracks.find(track => track.name === 'A1') || null : null;
    const { clips, avMismatch } = liveClipList(main, audio, fps);
    const dir = path.join(await this.deps.workDir(), 'edit');
    await fs.mkdir(dir, { recursive: true });
    const stem = safe(`${record.data.sequenceName} live`);
    const clipsFile = await this.deps.uniquePath(path.join(dir, `${stem}-clips.json`));
    await fs.writeFile(clipsFile, JSON.stringify({ source: clips[0]?.source || null, fps, fromSequence: sequence.name, comparedWith: record.file, clips }, null, 1));
    const report = { liveSequence: sequence.name, exported: record.data.sequenceName, tracks: diffs.map(({ matched, ...rest }) => rest), avMismatch };
    const reportFile = clipsFile.replace(/-clips\.json$/, '-diff.json');
    await fs.writeFile(reportFile, JSON.stringify(report, null, 1));
    this.deps.trackTool?.('agent_nle_live_diff');
    let applied: any;
    if (input?.apply === true) applied = await this.apply(main, record.data, fps);
    const summary = diffs.map(diff => ({ track: diff.track, live: diff.live, previous: diff.previous, trimmed: diff.trimmed.length, removed: diff.removed.length, added: diff.added.length, splits: diff.splits.length, reordered: diff.reordered }))
      .filter(row => row.live || row.previous);
    const changed = clips.filter(clip => clip.changed).length;
    return ok({
      action: 'live_diff', liveSequence: sequence.name, comparedWith: record.data.sequenceName,
      sameSequenceName: sequence.name === record.data.sequenceName || undefined,
      tracks: summary, mainTrack: mainName, clips: clips.length, changedClips: changed,
      trimmed: main.trimmed.slice(0, 10), removed: main.removed.slice(0, 10), added: main.added.slice(0, 10), avMismatch: avMismatch.slice(0, 10),
      files: { clips: clipsFile, report: reportFile },
      applied,
      next: applied ? 'The headless edit now follows the editor\'s cut (a snapshot was saved first). Re-run checks, then export the next version.' : 'Start the next version from files.clips (captions, chapters, verify_edit accept it), or pass apply:true to rebuild the headless edit from the editor\'s cut.'
    });
  }

  /** Rebuilds the main track of the open project from the editor's cut, keeping each clip's asset, region, zoom and name. */
  private async apply(main: TrackDiff, sidecar: Sidecar, fps: number): Promise<any> {
    const project = await this.deps.activeProject();
    if (project.id !== sidecar.projectId) throw Object.assign(new Error('The open project is not the one this XML was exported from. Open it first.'), { code: 'E_BAD_REQUEST' });
    const onTrack = project.clips.filter(clip => clip.track === main.track);
    const ops: any[] = onTrack.map(clip => ({ op: 'remove', clip: clip.id }));
    const byId = new Map(project.clips.map(clip => [clip.id, clip]));
    const assetByPath = new Map(Object.values(project.assets).filter(asset => !asset.crop).map(asset => [asset.path, asset]));
    let t = Math.min(...onTrack.map(clip => clip.start), Infinity);
    if (!Number.isFinite(t)) t = 0;
    const skipped: string[] = [];
    for (const item of main.matched) {
      const template = item.prev ? byId.get(item.prev.clipId) : undefined;
      const asset = template?.asset ? project.assets[template.asset] : assetByPath.get(item.live.path);
      if (!asset) { skipped.push(item.live.name); continue; }
      const length = Math.round((item.live.srcOut - item.live.srcIn) * fps) / fps;
      ops.push({
        op: 'add', asset: asset.id, track: main.track, at: t, in: item.live.srcIn, out: item.live.srcIn + length,
        name: item.live.name, ...(template?.zoom ? { zoom: template.zoom } : {}), ...(template?.anchor ? { anchor: template.anchor } : {}),
        ...(template?.opacity !== undefined && template.opacity < 1 ? { opacity: template.opacity } : {}),
        ...(template?.meta ? { meta: template.meta } : {})
      });
      t += length;
    }
    const result = await this.deps.applyWithSnapshot(ops, `before applying the editor's cut of ${sidecar.sequenceName}`);
    return { ...result, rebuilt: main.matched.length - skipped.length, skipped: skipped.length ? skipped : undefined, endsAt: Number(t.toFixed(3)) };
  }
}

