import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFFmpegPath, getFFprobePath } from './ffmpeg-path';

export interface AudioTrack { id: string; title: string; artist: string; license: string; credit: string; added: number; archiveId?: string; genre?: string; mood?: string; duration?: number }
interface Candidate { id: string; name: string; path: string; fingerprint: string }
const licenses = ['unverified', 'youtube-standard', 'cc-by'];
const fingerprint = (stat: any) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export async function validateMP3(filePath: string) {
  // Decode the whole MP3 using the native bundled binary before keeping it.
  try {
    await promisify(execFile)(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-f', 'mp3', '-i', filePath, '-map', '0:a:0', '-f', 'null', '-'], { timeout: 60000, windowsHide: true, maxBuffer: 256 * 1024 });
  } catch { throw new Error('This MP3 could not be read completely. Wait for the download to finish, then choose it again.'); }
  try {
    const { stdout } = await promisify(execFile)(getFFprobePath(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mp3', '-show_entries', 'format=duration', '-of', 'json', filePath], { timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 });
    const duration = Number(JSON.parse(stdout).format?.duration);
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch { /* A fully decoded file remains usable when its duration cannot be probed. */ }
}

/** A download session only offers new files. Nothing is kept or imported automatically. */
export class AudioLibrary {
  private tracks: AudioTrack[] = [];
  private candidates = new Map<string, Candidate>();
  private baseline = new Set<string>();
  private settling = new Map<string, { fingerprint: string; since: number }>();
  private busy = false;
  private generation = 0;
  watchFolder = '';
  watching = false;
  constructor(readonly folder: string, private validate = validateMP3, private now = () => Date.now()) {}
  async load() {
    await fs.mkdir(this.folder, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.folder, 'library.json'), 'utf8'));
      if (!Array.isArray(data)) throw new Error('The audio library index is invalid.');
      this.tracks = data.filter(track => /^[0-9a-f-]{36}$/.test(track?.id) && typeof track.title === 'string' && licenses.includes(track.license))
        .map(track => ({ id: track.id, title: clean(track.title, 300), artist: clean(track.artist, 300), license: track.license, credit: clean(track.credit, 10000), added: Number(track.added) || 0,
          genre: clean(track.genre, 100), mood: clean(track.mood, 100), ...(Number.isFinite(track.duration) && track.duration > 0 ? { duration: track.duration } : {}),
          ...(typeof track.archiveId === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(track.archiveId) ? { archiveId: track.archiveId } : {}) }));
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() {
    return { tracks: this.tracks.map(track => ({ ...track, previewUrl: `smoothy-audio://library/${track.id}` })),
      candidates: [...this.candidates.values()].map(({ id, name }) => ({ id, name })), watching: this.watching, watchFolder: this.watchFolder, folder: this.folder };
  }
  async start(folder: string) {
    this.stop();
    this.watchFolder = folder;
    this.baseline = new Set(await fs.readdir(folder));
    this.settling.clear(); this.candidates.clear(); this.watching = true;
    return this.snapshot();
  }
  stop() { this.generation++; this.watching = false; this.settling.clear(); }
  async poll() {
    if (!this.watching || this.candidates.size >= 100) return false;
    const generation = this.generation;
    const names = await fs.readdir(this.watchFolder);
    let changed = false;
    for (const name of names) {
      if (this.baseline.has(name) || !/\.mp3$/i.test(name) || names.some(part => part === name + '.crdownload' || part === name + '.part' || part === name + '.download')) continue;
      const filePath = path.join(this.watchFolder, name);
      let stat;
      try { stat = await fs.lstat(filePath); } catch { continue; }
      if (!stat.isFile() || stat.size < 128 || stat.size > 256 * 1024 * 1024) continue;
      if (generation !== this.generation || !this.watching) return false;
      const mark = fingerprint(stat);
      const previous = this.settling.get(name);
      if (!previous || previous.fingerprint !== mark) { this.settling.set(name, { fingerprint: mark, since: this.now() }); continue; }
      if (this.now() - previous.since < 4000) continue;
      const id = randomUUID();
      this.candidates.set(id, { id, name, path: filePath, fingerprint: mark });
      this.baseline.add(name); this.settling.delete(name); changed = true;
      if (this.candidates.size >= 100) break;
    }
    return changed;
  }
  async offer(filePaths: string[]) {
    const ids: string[] = [];
    for (const filePath of filePaths.slice(0, 100)) {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || !/\.mp3$/i.test(filePath) || stat.size < 128 || stat.size > 256 * 1024 * 1024) throw new Error('Choose a complete MP3 smaller than 256 MB.');
      const id = randomUUID(); this.candidates.set(id, { id, name: path.basename(filePath), path: filePath, fingerprint: fingerprint(stat) }); ids.push(id);
    }
    return ids;
  }
  dismiss(id: string) { this.candidates.delete(id); }
  async file(id: string) {
    if (!this.tracks.some(track => track.id === id)) throw new Error('Select a saved audio track first.');
    const filePath = path.join(this.folder, id + '.mp3');
    if (!(await fs.lstat(filePath)).isFile()) throw new Error('This audio file is missing from your library.');
    return filePath;
  }
  private metadata(input: any) {
    const title = clean(input?.title, 300);
    const license = licenses.includes(input?.license) ? input.license : 'unverified';
    const credit = clean(input?.credit, 10000);
    if (!title) throw new Error('Enter a track title.');
    if (license === 'cc-by' && !credit) throw new Error('Paste the attribution text from YouTube for this Creative Commons track.');
    return { title, artist: clean(input?.artist, 300), genre: clean(input?.genre, 100), mood: clean(input?.mood, 100), license, credit };
  }
  private async persist(tracks: AudioTrack[]) {
    const partial = path.join(this.folder, 'library.' + randomUUID() + '.part');
    try { await fs.writeFile(partial, JSON.stringify(tracks, null, 2), { flag: 'wx' }); await fs.rename(partial, path.join(this.folder, 'library.json')); }
    finally { await fs.rm(partial, { force: true }); }
    this.tracks = tracks;
  }
  async keep(id: string, input: any, archive?: { id: string; signal: AbortSignal }) {
    if (this.busy) throw new Error('Wait for the current audio action to finish.');
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error('Choose a downloaded audio file first.');
    const metadata = this.metadata(input);
    this.busy = true;
    const track = { id: randomUUID(), ...metadata, added: this.now(), ...(archive ? { archiveId: archive.id } : {}), ...(Number.isFinite(input?.duration) && input.duration > 0 ? { duration: input.duration } : {}) };
    const destination = path.join(this.folder, track.id + '.mp3');
    const partial = destination + '.part';
    let source: Awaited<ReturnType<typeof fs.open>> | undefined;
    let target: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      source = await fs.open(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await source.stat();
      if (!stat.isFile() || fingerprint(stat) !== candidate.fingerprint) throw new Error('This download changed. Choose it again after it finishes.');
      target = await fs.open(partial, 'wx');
      const buffer = Buffer.alloc(1024 * 1024);
      let position = 0;
      while (position < stat.size) {
        archive?.signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) throw new Error('The download is incomplete. Choose it again.');
        await target.writeFile(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (fingerprint(await source.stat()) !== candidate.fingerprint) throw new Error('This download changed. Choose it again after it finishes.');
      await target.close(); target = undefined;
      const measured = await this.validate(partial);
      if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) track.duration = measured;
      archive?.signal.throwIfAborted();
      await fs.rename(partial, destination);
      await this.persist([...this.tracks, track]);
      this.candidates.delete(id);
      return track;
    } catch (error) { await fs.rm(destination, { force: true }); throw error; }
    finally { await source?.close(); await target?.close(); await fs.rm(partial, { force: true }); this.busy = false; }
  }
  async keepArchive(filePath: string, title: string, id: string, signal: AbortSignal, metadata: { artist?: string; genre?: string; mood?: string; duration?: number } = {}) {
    const [candidate] = await this.offer([filePath]);
    try { return await this.keep(candidate, { ...metadata, title, license: 'unverified', credit: 'YouTube Audio Library unofficial archive (catalog: 2020-06-13). Track license was not supplied by this archive. Verify current terms in YouTube Studio.' }, { id, signal }); }
    finally { this.dismiss(candidate); }
  }
  async update(id: string, input: any) {
    if (this.busy) throw new Error('Wait for the current audio action to finish.');
    const track = this.tracks.find(track => track.id === id);
    if (!track) throw new Error('Select a saved audio track first.');
    const next = { ...track, ...this.metadata(input) };
    this.busy = true;
    try { await this.persist(this.tracks.map(track => track.id === id ? next : track)); }
    finally { this.busy = false; }
    return next;
  }
}
