import fs from 'node:fs/promises';
import path from 'node:path';
import tagIndex from './data/audio-archive-tags.json';

export const AUDIO_ARCHIVE_URL = 'https://thibaultjanbeyer.github.io/YouTube-Free-Audio-Library-API/api.json';
export const AUDIO_ARCHIVE_DATE = '2020-06-13';
const MAX_CATALOG = 4 * 1024 * 1024;
const MAX_MP3 = 256 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{20,100}$/;
const hosts = new Set(['drive.usercontent.google.com', 'docs.google.com', 'drive.google.com']);
interface ArchiveTrack { id: string; title: string; genre?: string; mood?: string; artist?: string; duration?: number }
const genres = [
  ['cinematic', 'Cinematic'], ['ambient', 'Ambient'], ['electronic', 'Dance & Electronic'], ['hip-hop', 'Hip Hop & Rap'],
  ['jazz-blues', 'Jazz & Blues'], ['rock', 'Rock'], ['pop', 'Pop'], ['classical', 'Classical'], ['country-folk', 'Country & Folk'],
  ['soul', 'R&B & Soul'], ['alternative', 'Alternative & Punk'], ['reggae', 'Reggae'], ['world', 'World'], ['holiday', 'Holiday'], ['children', "Children's"],
];
const moods = ['Calm', 'Happy', 'Bright', 'Dramatic', 'Dark', 'Funky', 'Inspirational', 'Sad', 'Romantic', 'Angry'];
const tags: Record<string, (string | number)[]> = tagIndex.tracks;
export function enrichArchive(tracks: ArchiveTrack[]): ArchiveTrack[] {
  return tracks.map(track => {
    const entry = tags[track.id];
    if (!entry || entry[0] !== track.title) return track;
    // Archive IDs and titles must both match. No title/genre guesses or license inference.
    return { ...track, ...(genres.some(([, label]) => label === entry[1]) ? { genre: String(entry[1]) } : {}), ...(moods.includes(String(entry[2])) ? { mood: String(entry[2]) } : {}),
      ...(typeof entry[3] === 'string' && entry[3] ? { artist: entry[3] } : {}), ...(typeof entry[4] === 'number' && entry[4] > 0 ? { duration: entry[4] } : {}) };
  });
}

export function normalizeArchive(data: any): ArchiveTrack[] {
  if (!Array.isArray(data?.all) || data.all.length > 10000) throw new Error('The audio archive catalog could not be read.');
  const tracks = new Map<string, ArchiveTrack>();
  for (const item of data.all) {
    if (typeof item?.id !== 'string' || !ID.test(item.id) || typeof item.name !== 'string' || item.name.length > 350 || !/\.mp3$/i.test(item.name) || item.mimeType !== 'audio/mpeg') continue;
    const title = item.name.replace(/\.mp3$/i, '').replace(/_/g, ' ').trim();
    if (title) tracks.set(item.id, { id: item.id, title });
  }
  if (!tracks.size) throw new Error('The audio archive catalog is empty.');
  return [...tracks.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

function shuffleTracks(tracks: ArchiveTrack[], seed: number) {
  const shuffled = [...tracks];
  // A seeded Fisher–Yates shuffle keeps filtering and every page in the same order.
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const index = Math.floor(((value ^ (value >>> 14)) >>> 0) / 4294967296 * (i + 1));
    [shuffled[i], shuffled[index]] = [shuffled[index], shuffled[i]];
  }
  return shuffled;
}

/** Public archive metadata only. Renderer-supplied URLs are never fetched. */
export class AudioArchive {
  private tracks: ArchiveTrack[] | undefined;
  private loading: Promise<ArchiveTrack[]> | undefined;
  private cached = false;
  private readonly shuffleSeed = Math.floor(Math.random() * 4294967296);
  constructor(private cacheFolder: string, private request: typeof fetch = fetch) {}
  private async catalog() {
    if (this.tracks) return this.tracks;
    if (!this.loading) this.loading = this.load().then(tracks => this.tracks = enrichArchive(tracks)).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async load() {
    const cachePath = path.join(this.cacheFolder, 'audio-archive.json');
    let cached: { tracks: ArchiveTrack[]; savedAt: number } | undefined;
    try {
      const stat = await fs.stat(cachePath);
      if (stat.size <= MAX_CATALOG) {
        const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        cached = { tracks: normalizeArchive(data), savedAt: Number(data.savedAt) || 0 };
        if (Date.now() - cached.savedAt < 7 * 86400000 && cached.savedAt <= Date.now()) { this.cached = true; return cached.tracks; }
      }
    } catch { /* A missing or damaged cache can be rebuilt from the public catalog. */ }
    try {
      const response = await this.request(AUDIO_ARCHIVE_URL, { signal: AbortSignal.timeout(20000), credentials: 'omit', redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('The audio archive is unavailable. Retry when you are online.');
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_CATALOG) { await response.body.cancel(); throw new Error('The audio archive catalog is too large.'); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > MAX_CATALOG) throw new Error('The audio archive catalog is too large.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const tracks = normalizeArchive(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // Cache failure must not prevent browsing an otherwise available catalog.
      try {
        await fs.mkdir(this.cacheFolder, { recursive: true });
        const partial = cachePath + '.part';
        await fs.writeFile(partial, JSON.stringify({ savedAt: Date.now(), all: tracks.map(track => ({ id: track.id, name: track.title + '.mp3', mimeType: 'audio/mpeg' })) }));
        await fs.rename(partial, cachePath);
      } catch { await fs.rm(cachePath + '.part', { force: true }).catch(() => {}); }
      return tracks;
    } catch (error) {
      if (cached) { this.cached = true; return cached.tracks; }
      throw error;
    }
  }
  async search(input: any, community: { favorites: string[]; staffPicks: string[]; counts: Record<string, number> } = { favorites: [], staffPicks: [], counts: {} }) {
    const query = input?.query ?? ''; const offset = input?.offset ?? 0;
    const category = input?.category ?? 'all'; const mood = input?.mood ?? '';
    const view = input?.view ?? 'all';
    const shuffleSeed = input?.shuffleSeed ?? this.shuffleSeed;
    if (!['all', 'favorites', 'staff'].includes(view)) throw new Error('Choose an available library view.');
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Enter a title of up to 200 characters.');
    if (!['all', 'uncategorized', ...genres.map(([id]) => id)].includes(category) || (mood !== '' && !moods.includes(mood))) throw new Error('Choose an available audio type or mood.');
    if (!Number.isInteger(shuffleSeed) || shuffleSeed < 0 || shuffleSeed > 0xFFFFFFFF) throw new Error('Invalid library shuffle. Reopen Music to retry.');
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const catalog = shuffleTracks(await this.catalog(), shuffleSeed);
    const categories = [{ id: 'all', label: 'All tracks', count: catalog.length },
      ...genres.map(([id, label]) => ({ id, label, count: catalog.filter(track => track.genre === label).length })).filter(item => item.count),
      { id: 'uncategorized', label: 'Uncategorized', count: catalog.filter(track => !track.genre).length }];
    const genre = genres.find(([id]) => id === category)?.[1];
    const typed = catalog.filter(track => category === 'all' || (category === 'uncategorized' ? !track.genre : track.genre === genre));
    const favorites = new Set(community.favorites), staff = new Set(community.staffPicks);
    const tracks = typed.filter(track => (view !== 'favorites' || favorites.has(track.id)) && (view !== 'staff' || staff.has(track.id)) && (!mood || track.mood === mood) && words.every(word => [track.title, track.artist].join(' ').toLocaleLowerCase().includes(word)));
    return { tracks: tracks.slice(offset, offset + 40).map(track => ({ ...track, favorite: favorites.has(track.id), staffPick: staff.has(track.id), favoriteCount: community.counts[track.id] || 0, previewUrl: `smoothy-audio://archive/${track.id}` })),
      total: tracks.length, offset, hasMore: offset + 40 < tracks.length, archiveDate: AUDIO_ARCHIVE_DATE, cached: this.cached, category, mood, categories,
      moods: moods.map(label => ({ label, count: typed.filter(track => track.mood === label).length })) };
  }
  async track(id: unknown) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Choose a track from the audio archive.');
    const track = (await this.catalog()).find(track => track.id === id);
    if (!track) throw new Error('This track is not in the audio archive.');
    return track;
  }
  private async media(id: string, signal: AbortSignal, range?: string) {
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new Error('Invalid audio preview range.');
    let url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`;
    for (let count = 0; count < 5; count++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('The archive returned an unsupported download link.');
      const response = await this.request(url, { signal, redirect: 'manual', credentials: 'omit', headers: range ? { Range: range } : undefined });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) break;
        url = new URL(location, url).href; continue;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !response.body || !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(type)) {
        await response.body?.cancel(); throw new Error('This archived track is unavailable. Try another track or retry later.');
      }
      if (Number(response.headers.get('content-length')) > MAX_MP3) { await response.body.cancel(); throw new Error('This archived MP3 exceeds 256 MB.'); }
      return response;
    }
    throw new Error('The archived download redirected too many times.');
  }
  async preview(id: string, signal: AbortSignal, range?: string) {
    await this.track(id);
    const response = await this.media(id, AbortSignal.any([signal, AbortSignal.timeout(10 * 60000)]), range);
    const headers = new Headers({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
    for (const name of ['content-length', 'content-range', 'accept-ranges']) { const value = response.headers.get(name); if (value) headers.set(name, value); }
    return new Response(response.body, { status: response.status, headers });
  }
  async download(id: string, destination: string, signal: AbortSignal, progress: (received: number, total: number) => void) {
    const track = await this.track(id);
    const response = await this.media(id, AbortSignal.any([signal, AbortSignal.timeout(10 * 60000)]));
    if (response.status !== 200) { await response.body!.cancel(); throw new Error('The archived download is incomplete. Please retry.'); }
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body!.getReader(); let file: Awaited<ReturnType<typeof fs.open>> | undefined; let received = 0; let created = false;
    let prefix = Buffer.alloc(0);
    try {
      signal.throwIfAborted(); file = await fs.open(destination, 'wx'); created = true;
      for (;;) {
        signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
        received += value.length;
        if (received > MAX_MP3) throw new Error('This archived MP3 exceeds 256 MB.');
        if (prefix.length < 3) prefix = Buffer.concat([prefix, value]).subarray(0, 3);
        await file.writeFile(value); progress(received, total);
      }
      signal.throwIfAborted();
      if (received < 128 || (total && received !== total) || !(prefix.toString('ascii', 0, 3) === 'ID3' || (prefix[0] === 255 && (prefix[1] & 224) === 224))) throw new Error('The archived MP3 is incomplete or invalid. Please retry.');
      return track;
    } catch (error) { await file?.close(); file = undefined; if (created) await fs.rm(destination, { force: true }); throw error; }
    finally { await file?.close(); await reader.cancel().catch(() => {}); }
  }
}
