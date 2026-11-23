/**
 * Disk storage for headless edit projects: userData/agent/projects/<id>/project.json.
 * Undo/redo history is kept in memory per session; the saved file is always the
 * latest state. Media is referenced by path and never copied or modified.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { EditOpError, describeProject, projectDuration, type EditProject } from './edit-project';

const HISTORY_LIMIT = 40;
const ID_PATTERN = /^[a-f0-9-]{4,36}$/;

type History = { undo: string[]; redo: string[] };

export class EditStore {
  private current: string | null = null;
  private readonly cache = new Map<string, EditProject>();
  private readonly history = new Map<string, History>();

  constructor(private readonly root: string) {}

  dir(id: string): string {
    if (!ID_PATTERN.test(id)) throw new EditOpError('That project id is not valid.', 'E_BAD_REQUEST');
    return path.join(this.root, id);
  }

  currentId(): string | null {
    return this.current;
  }

  async create(project: EditProject): Promise<EditProject> {
    await this.save(project);
    this.current = project.id;
    return project;
  }

  async save(project: EditProject): Promise<void> {
    const dir = this.dir(project.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'project.json');
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(project));
    await fs.rename(temp, file);
    this.cache.set(project.id, project);
  }

  async load(id: string): Promise<EditProject> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir(id), 'project.json'), 'utf8');
    } catch {
      throw new EditOpError(`Project "${id}" was not found. List projects with smoothy_edit action "list".`, 'E_NOT_FOUND');
    }
    const project = JSON.parse(text) as EditProject;
    if (project?.version !== 1 || !Array.isArray(project.clips)) throw new EditOpError('That project file is not a Smoothy edit.', 'E_BAD_REQUEST');
    this.cache.set(id, project);
    return project;
  }

  async open(id: string): Promise<EditProject> {
    const project = await this.load(id);
    this.current = id;
    return project;
  }

  async active(): Promise<EditProject> {
    if (!this.current) throw new EditOpError('No project is open. Call smoothy_edit action "new" first, or "open" an existing one.', 'E_NOT_FOUND');
    return this.load(this.current);
  }

  /** Replaces the project with `next`, remembering the previous state for undo. */
  async commit(previous: EditProject, next: EditProject): Promise<void> {
    const history = this.history.get(next.id) || { undo: [], redo: [] };
    history.undo.push(JSON.stringify(previous));
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo = [];
    this.history.set(next.id, history);
    await this.save(next);
  }

  async undo(): Promise<EditProject> {
    const project = await this.active();
    const history = this.history.get(project.id);
    const snapshot = history?.undo.pop();
    if (!history || !snapshot) throw new EditOpError('Nothing to undo.');
    history.redo.push(JSON.stringify(project));
    const restored = JSON.parse(snapshot) as EditProject;
    restored.revision = project.revision + 1;
    await this.save(restored);
    return restored;
  }

  async redo(): Promise<EditProject> {
    const project = await this.active();
    const history = this.history.get(project.id);
    const snapshot = history?.redo.pop();
    if (!history || !snapshot) throw new EditOpError('Nothing to redo.');
    history.undo.push(JSON.stringify(project));
    const restored = JSON.parse(snapshot) as EditProject;
    restored.revision = project.revision + 1;
    await this.save(restored);
    return restored;
  }

  async list(): Promise<any[]> {
    let names: string[] = [];
    try { names = await fs.readdir(this.root); } catch { return []; }
    const rows: any[] = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        const project = await this.load(name);
        rows.push({
          id: project.id,
          name: project.name,
          size: `${project.width}x${project.height}@${project.fps}`,
          duration: Number(projectDuration(project).toFixed(2)),
          clips: project.clips.length,
          updatedAt: project.updatedAt,
          current: project.id === this.current || undefined
        });
      } catch {
        // Skip unreadable folders.
      }
    }
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 30);
  }

  /** Where saved versions live: the project folder's Edit/versions, else the project's own folder. */
  versionsDir(project: EditProject): string {
    return project.folder ? path.join(project.folder, 'Edit', 'versions') : path.join(this.dir(project.id), 'versions');
  }

  async versions(project: EditProject): Promise<{ version: number; label: string; revision: number; clips: number; duration: number; savedAt: string; file: string }[]> {
    const dir = this.versionsDir(project);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const rows = [];
    for (const name of names) {
      const match = /^v(\d+)\.json$/.exec(name);
      if (!match) continue;
      try {
        const saved = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (saved?.project?.id !== project.id) continue;
        rows.push({ version: Number(match[1]), label: String(saved.label || ''), revision: Number(saved.project.revision) || 0, clips: saved.project.clips?.length || 0, duration: Number(projectDuration(saved.project).toFixed(2)), savedAt: String(saved.savedAt || ''), file: path.join(dir, name) });
      } catch {
        // Skip unreadable files.
      }
    }
    return rows.sort((a, b) => a.version - b.version);
  }

  /** Saves the project as the next version (v1, v2 …). Existing versions are never overwritten. */
  async snapshot(project: EditProject, label = ''): Promise<{ version: number; file: string }> {
    const dir = this.versionsDir(project);
    await fs.mkdir(dir, { recursive: true });
    const existing = await this.versions(project);
    let version = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
    for (;; version += 1) {
      const file = path.join(dir, `v${version}.json`);
      try {
        await fs.writeFile(file, JSON.stringify({ label: String(label).slice(0, 120), savedAt: new Date().toISOString(), project }, null, 1), { flag: 'wx' });
        return { version, file };
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }

  /** Makes a saved version the current state. The change can be undone, and versions are kept. */
  async restore(version: number): Promise<EditProject> {
    const project = await this.active();
    const row = (await this.versions(project)).find(item => item.version === version);
    if (!row) throw new EditOpError(`Version v${version} was not found. List versions with smoothy_edit action "versions".`, 'E_NOT_FOUND');
    const saved = JSON.parse(await fs.readFile(row.file, 'utf8')).project as EditProject;
    const next: EditProject = { ...saved, id: project.id, folder: project.folder, revision: project.revision + 1, updatedAt: new Date().toISOString() };
    await this.commit(project, next);
    return next;
  }

  describe(project: EditProject, clips = true): any {
    return describeProject(project, { clips });
  }
}
