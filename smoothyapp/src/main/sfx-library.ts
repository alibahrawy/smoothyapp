import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getFFmpegPath } from './ffmpeg-path';
import { validateMP3 } from './audio-library';

export interface SfxEntry { id: string; title: string; category: string; tags: string[]; file: string; license: string; author: string; sourceUrl: string; origin: 'cc0' | 'synth'; duration: number }

/** Only licenses that allow redistribution inside the app may be bundled. */
export const SFX_LICENSES = ['CC0', 'Public domain', 'SmoothyEdit original'];
const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const PAGE = 60;

/** Validates the bundled catalog. Anything malformed is dropped rather than shown. */
export function normalizeSfxLibrary(raw: unknown): SfxEntry[] {
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error('The sound effects catalog is invalid.');
  const seen = new Set<string>(), entries: SfxEntry[] = [];
  for (const item of raw as any[]) {
    const file = clean(item?.file, 200), license = clean(item?.license, 40);
    if (typeof item?.id !== 'string' || !ID.test(item.id) || seen.has(item.id) || !SFX_LICENSES.includes(license)
      || !/^[a-z0-9][a-z0-9/_-]*\.wav$/i.test(file) || file.includes('..') || file.includes('//')
      || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 30
      || !clean(item.title, 120) || !clean(item.category, 60) || (item.origin !== 'cc0' && item.origin !== 'synth')) continue;
    seen.add(item.id);
    entries.push({ id: item.id, title: clean(item.title, 120), category: clean(item.category, 60),
      tags: Array.isArray(item.tags) ? item.tags.filter((tag: unknown) => typeof tag === 'string').map((tag: string) => clean(tag, 40).toLowerCase()).filter(Boolean).slice(0, 12) : [],
      file, license, author: clean(item.author, 100), sourceUrl: /^https:\/\//.test(clean(item.sourceUrl, 300)) ? clean(item.sourceUrl, 300) : '', origin: item.origin, duration: item.duration });
  }
  return entries;
}

const filename = (entry: SfxEntry) => entry.title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ') + ' - SmoothyEdit SFX';

export type Mp3Encoder = (input: string, output: string) => Promise<void>;
const encodeMp3: Mp3Encoder = async (input, output) => {
  await promisify(execFile)(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', output],
    { timeout: 60000, windowsHide: true, maxBuffer: 256 * 1024 });
};

/** Read-only catalog of bundled sounds plus copies into the user's own library folder. */
export class SfxLibrary {
  private entries: SfxEntry[] = [];
  constructor(readonly sourceFolder: string, readonly saveFolder: string, private encode: Mp3Encoder = encodeMp3, private validate: (file: string) => Promise<unknown> = validateMP3) {}
  async load() {
    this.entries = normalizeSfxLibrary(JSON.parse(await fs.readFile(path.join(this.sourceFolder, 'library.json'), 'utf8')));
    const present: SfxEntry[] = [];
    for (const entry of this.entries) { if (await this.exists(entry)) present.push(entry); }
    this.entries = present;
  }
  private async exists(entry: SfxEntry) {
    try { return (await fs.lstat(path.join(this.sourceFolder, entry.file))).isFile(); } catch { return false; }
  }
  get(id: unknown) {
    const entry = typeof id === 'string' ? this.entries.find(item => item.id === id) : undefined;
    if (!entry) throw new Error('Choose a sound effect from the library.');
    return entry;
  }
  /** Absolute path of the bundled WAV, confined to the bundle folder. */
  async file(id: unknown) {
    const entry = this.get(id), root = await fs.realpath(this.sourceFolder), full = await fs.realpath(path.join(this.sourceFolder, entry.file));
    if (!full.startsWith(root + path.sep)) throw new Error('This sound effect is unavailable.');
    return full;
  }
  search(input: any) {
    const query = input?.query ?? '', category = input?.category ?? 'all', offset = input?.offset ?? 0;
    if (typeof query !== 'string' || query.length > 100 || typeof category !== 'string' || category.length > 60 || !Number.isInteger(offset) || offset < 0 || offset > 5000) throw new Error('Enter up to 100 characters to search sound effects.');
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const categories = [...new Set(this.entries.map(entry => entry.category))].sort().map(label => ({ id: label, label, count: this.entries.filter(entry => entry.category === label).length }));
    if (category !== 'all' && !categories.some(item => item.id === category)) throw new Error('Choose an available sound category.');
    const matches = this.entries.filter(entry => (category === 'all' || entry.category === category)
      && words.every(word => [entry.title, entry.category, ...entry.tags].join(' ').toLocaleLowerCase().includes(word)))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    return { sounds: matches.slice(offset, offset + PAGE).map(entry => ({ ...entry, previewUrl: `smoothy-audio://sfx/${entry.id}` })),
      total: matches.length, offset, hasMore: offset + PAGE < matches.length, category, categories: [{ id: 'all', label: 'All sounds', count: this.entries.length }, ...categories] };
  }
  private async copyOnce(destination: string, make: (partial: string) => Promise<void>) {
    await fs.mkdir(this.saveFolder, { recursive: true });
    try { if ((await fs.lstat(destination)).isFile()) return; } catch { /* Not saved yet. */ }
    const partial = destination + '.' + randomUUID() + '.part';
    try { await make(partial); await fs.rename(partial, destination); }
    finally { await fs.rm(partial, { force: true }); }
  }
  /** Lossless WAV copy in the user's library. An existing copy is reused. */
  async saveWav(id: unknown) {
    const entry = this.get(id), source = await this.file(id), destination = path.join(this.saveFolder, filename(entry) + '.wav');
    await this.copyOnce(destination, partial => fs.copyFile(source, partial, 1));
    return { entry, path: destination };
  }
  /** Premiere's audio import accepts MP3 only, so it gets a 320 kbps copy of the same sound. */
  async saveMp3(id: unknown) {
    const entry = this.get(id), source = await this.file(id), destination = path.join(this.saveFolder, filename(entry) + '.mp3');
    await this.copyOnce(destination, async partial => { await this.encode(source, partial); await this.validate(partial); });
    return { entry, path: destination };
  }
}
