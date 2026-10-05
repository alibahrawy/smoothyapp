import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getFFmpegPath } from './ffmpeg-path';
import { searchOtherStockSources } from './stock-footage-sources';
import { PixabayStockSource } from './stock-footage-pixabay';

export type StockProvider = 'commons' | 'archive' | 'nasa' | 'pixabay';
export interface StockSourceCursor { page: number; cursor: number; done: boolean }
export type StockSourceCursors = Partial<Record<StockProvider, StockSourceCursor>>;
export interface StockFile { id: number; width: number; height: number; fps: number; link: string; format: string; label?: string }
export interface StockVideo { id: number | string; provider?: StockProvider; title: string; license: string; licenseUrl: string; usage?: string; width: number; height: number; duration: number; url: string; image: string; creator: string; creatorUrl: string; files: StockFile[] }
export interface StockSearch { query: string; provider?: StockProvider | 'all'; orientation?: string; size?: string; page?: number; cursor?: number; sourceCursors?: StockSourceCursors }
export interface StockResults { videos: StockVideo[]; page: number; hasMore: boolean; nextOffset: number; sourceCursors?: StockSourceCursors; warning?: string }

export function httpsUrl(value: unknown, hosts: string[]): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && hosts.includes(url.hostname)) return url.href;
  } catch {}
  return '';
}
export function text(value: unknown): string {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 300);
}
const positive = (value: unknown) => Number.isFinite(value) && Number(value) > 0;

/** Fail closed: CC BY / BY-SA material is deliberately excluded. */
export function normalizeStockVideo(raw: any): StockVideo | null {
  const info = raw?.videoinfo?.[0];
  const metadata = info?.extmetadata || {};
  const license = text(metadata.LicenseShortName?.value);
  if (!Number.isSafeInteger(raw?.pageid) || raw.pageid <= 0 || !info || !['CC0', 'Public domain'].includes(license)
    || String(metadata.AttributionRequired?.value).toLowerCase() !== 'false' || text(metadata.Restrictions?.value)) return null;
  let licenseUrl = String(metadata.LicenseUrl?.value || '').replace(/^http:/, 'https:');
  licenseUrl = httpsUrl(licenseUrl, ['creativecommons.org']);
  if (license === 'CC0' && !licenseUrl.startsWith('https://creativecommons.org/publicdomain/zero/1.0')) return null;
  const url = httpsUrl(info.descriptionurl, ['commons.wikimedia.org']);
  const image = httpsUrl(info.thumburl, ['upload.wikimedia.org', 'thumb.wikimedia.org']);
  const files: StockFile[] = (Array.isArray(info.derivatives) ? info.derivatives : []).flatMap((file: any, index: number) => {
    const link = httpsUrl(file.src, ['upload.wikimedia.org']);
    const format = /^video\/webm(?:;|$)/.test(file.type) ? 'webm' : /^video\/ogg(?:;|$)/.test(file.type) ? 'ogv' : /^video\/mp4(?:;|$)/.test(file.type) ? 'mp4' : '';
    return link && format && positive(file.width) && positive(file.height)
      ? [{ id: index + 1, width: file.width, height: file.height, fps: 0, link, format }] : [];
  }).sort((a: StockFile, b: StockFile) => b.width * b.height - a.width * a.height);
  const distinct = files.filter((file, index) => files.findIndex(other => other.width === file.width && other.height === file.height) === index);
  if (!url || !image || !distinct.length || !positive(info.duration)) return null;
  return { id: raw.pageid, provider: 'commons', title: text(metadata.ObjectName?.value) || text(raw.title).replace(/^File:/, ''), license, licenseUrl,
    width: info.width, height: info.height, duration: info.duration, url, image,
    creator: text(metadata.Artist?.value) || 'Wikimedia Commons contributor', creatorUrl: url, files: distinct };
}

export async function convertStockVideo(source: string, destination: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(getFFmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', '-n', destination], { windowsHide: true });
    let errors = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    const cleanup = () => { signal.removeEventListener('abort', abort); clearTimeout(killTimer); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error('Could not convert this video to MP4. Try another resolution. ' + errors.slice(-300)));
      else resolve();
    });
  });
}

/** Only main-process search results supply media URLs. Provider keys stay in main. */
export class StockFootageService {
  private cache = new Map<string, { expires: number; results: StockResults }>();
  private videos = new Map<number | string, StockVideo>();
  private pixabay: PixabayStockSource;
  constructor(private request: typeof fetch = fetch, private convert = convertStockVideo) { this.pixabay = new PixabayStockSource(request); }
  configurePixabayService(endpoint: string, cacheFolder?: string) { this.pixabay.configure(endpoint, cacheFolder); this.clear(); }
  get pixabayEnabled() { return this.pixabay.configured; }
  clear() { this.cache.clear(); this.videos.clear(); }

  async search(input: StockSearch, signal?: AbortSignal): Promise<StockResults> {
    signal?.throwIfAborted();
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > 200) throw new Error('Enter a search of 1–200 characters.');
    const page = input.page ?? 1;
    let offset = input.cursor ?? 0;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid search page.');
    for (const [name, allowed] of [['orientation', ['landscape', 'portrait', 'square']], ['size', ['small', 'medium', 'large']]] as const) {
      if (input[name] && !allowed.includes(input[name] as never)) throw new Error('Invalid search filter.');
    }
    const provider = input.provider || 'commons';
    if (!['all', 'commons', 'archive', 'nasa', 'pixabay'].includes(provider)) throw new Error('Invalid footage source.');
    if (provider === 'all') return this.searchAll({ ...input, query, page }, signal);
    const cacheId = JSON.stringify([provider, query, input.orientation || '', input.size || '', page, offset]);
    const cached = this.cache.get(cacheId);
    if (cached && cached.expires > Date.now()) { this.registerVideos(cached.results.videos); return cached.results; }
    if (provider === 'pixabay') return this.remember(cacheId, await this.pixabay.search({ ...input, query, page }, signal), 24 * 3600000);
    if (provider !== 'commons') return this.remember(cacheId, await searchOtherStockSources({ ...input, query, provider, page, cursor: offset }, this.request, signal));
    const videos: StockVideo[] = [];
    let hasMore = false;
    for (let batch = 0; batch < 3; batch++) {
      const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: query + ' filetype:video',
        gsrnamespace: '6', gsrlimit: '40', gsroffset: String(offset), prop: 'videoinfo', viprop: 'url|size|extmetadata|derivatives', viurlwidth: '320' });
      const response = await this.request('https://commons.wikimedia.org/w/api.php?' + params, {
        headers: { Accept: 'application/json', 'User-Agent': 'SmoothyEdit/1.5.2 (https://smoothyedit.com; stock footage search)' }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      });
      if (response.status === 429) throw new Error('Wikimedia search limit reached. Please try again later.');
      if (!response.ok) throw new Error('Wikimedia Commons is unavailable right now. Please try again.');
      const data = await response.json() as any;
      if (data.error || (!Array.isArray(data.query?.pages) && data.batchcomplete !== true)) throw new Error('Wikimedia returned an invalid search response.');
      const pages = (data.query?.pages || []).sort((a: any, b: any) => a.index - b.index);
      for (const raw of pages) {
        const video = normalizeStockVideo(raw);
        if (!video) continue;
        const ratio = video.width / video.height;
        if ((input.orientation === 'landscape' && ratio <= 1.05) || (input.orientation === 'portrait' && ratio >= 0.95) || (input.orientation === 'square' && (ratio < 0.95 || ratio > 1.05))) continue;
        const min = { small: 720, medium: 1080, large: 2160 }[input.size || ''] || 0;
        if (Math.min(video.width, video.height) < min || videos.some(item => item.id === video.id)) continue;
        videos.push(video);
      }
      const next = data.continue?.gsroffset;
      hasMore = Number.isSafeInteger(next) && next > offset && next <= 100000;
      if (hasMore) offset = next;
      if (!hasMore || videos.length >= 12) break;
    }
    return this.remember(cacheId, { videos, page, hasMore, nextOffset: offset });
  }

  private async searchAll(input: StockSearch, signal?: AbortSignal): Promise<StockResults> {
    const available: StockProvider[] = ['commons', 'archive', 'nasa', 'pixabay'];
    const providers = available.filter(provider => provider !== 'pixabay' || this.pixabay.configured);
    const labels = { commons: 'Wikimedia Commons', archive: 'Internet Archive', nasa: 'NASA', pixabay: 'Pixabay' };
    const supplied = input.sourceCursors;
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || Object.keys(supplied).some(key => !available.includes(key as StockProvider)))) throw new Error('Invalid source pagination.');
    const sourceCursors: StockSourceCursors = {};
    for (const provider of providers) {
      const state = supplied && Object.hasOwn(supplied, provider) ? supplied[provider] : { page: 1, cursor: 0, done: false };
      if (!state || typeof state !== 'object' || !Number.isSafeInteger(state.page) || state.page < 1 || state.page > 10001
        || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor > 100000 || typeof state.done !== 'boolean'
        || (!state.done && state.page > 10000)) throw new Error('Invalid source pagination.');
      sourceCursors[provider] = { page: state.page, cursor: state.cursor, done: state.done };
    }
    const active = providers.filter(provider => !sourceCursors[provider]!.done);
    const results = await Promise.allSettled(active.map(provider => {
      const state = sourceCursors[provider]!;
      return this.search({ ...input, provider, page: state.page, cursor: state.cursor, sourceCursors: undefined }, signal);
    }));
    signal?.throwIfAborted();
    const batches: StockVideo[][] = [];
    const warnings: string[] = [];
    for (let index = 0; index < active.length; index++) {
      const provider = active[index], result = results[index];
      if (result.status === 'rejected') {
        // Preserve this source's position so Load more can retry it.
        warnings.push(`${labels[provider]} could not be searched. Load more to retry.`);
        continue;
      }
      const data = result.value;
      sourceCursors[provider] = { page: data.page + 1, cursor: data.nextOffset, done: !data.hasMore };
      batches.push(data.videos);
      if (data.warning) warnings.push(`${labels[provider]}: ${data.warning}`);
    }
    if (active.length && !batches.length) throw new Error('All footage sources are unavailable right now. Please try again.');
    // Alternate providers while retaining each provider's own result order.
    const videos: StockVideo[] = [], seen = new Set<number | string>();
    for (let index = 0; index < Math.max(0, ...batches.map(batch => batch.length)); index++) {
      for (const batch of batches) {
        const video = batch[index];
        if (video && !seen.has(video.id)) { seen.add(video.id); videos.push(video); }
      }
    }
    this.registerVideos(videos);
    // Individual successful pages are cached; partial aggregate failures remain retryable.
    return { videos, page: input.page!, nextOffset: 0, sourceCursors,
      hasMore: providers.some(provider => !sourceCursors[provider]!.done), ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }

  private remember(cacheId: string, results: StockResults, ttl = 3600000): StockResults {
    this.registerVideos(results.videos);
    this.cache.set(cacheId, { expires: Date.now() + ttl, results });
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return results;
  }

  private registerVideos(videos: StockVideo[]) {
    for (const video of videos) { this.videos.delete(video.id); this.videos.set(video.id, video); }
    while (this.videos.size > 2000) this.videos.delete(this.videos.keys().next().value!);
  }

  async download(videoId: number | string, fileId: number, folder: string, signal: AbortSignal, progress: (received: number, total: number, phase?: string) => void): Promise<string> {
    const video = this.videos.get(videoId);
    const file = video?.files.find(item => item.id === fileId);
    if (!file || !video) throw new Error('Search again and select a video before downloading.');
    const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
    let link = file.link;
    const provider = video.provider || 'commons';
    const mediaUrlAllowed = (value: string) => provider === 'archive' ? archiveMediaUrl(value)
      : httpsUrl(value, provider === 'pixabay' ? ['cdn.pixabay.com'] : provider === 'nasa' ? ['images-assets.nasa.gov'] : ['upload.wikimedia.org']);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!mediaUrlAllowed(link)) throw new Error('The source returned an unsupported video URL.');
      response = await this.request(link, { redirect: 'manual', signal: timeoutSignal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('The video download redirected too many times.');
      link = new URL(location, link).href;
    }
    if (!response?.ok || !response.body) throw new Error('The video could not be downloaded. Search again and retry.');
    const total = Number(response.headers.get('content-length')) || 0;
    const limit = 1024 * 1024 * 1024;
    if (total > limit) { await response.body.cancel(); throw new Error('This video is larger than the 1 GB download limit. Choose a smaller resolution.'); }
    await fs.mkdir(folder, { recursive: true });
    const sourceId = provider === 'commons' ? video.id : createHash('sha256').update(String(video.id)).digest('hex').slice(0, 16);
    const base = `${provider}-${sourceId}-${file.width && file.height ? file.width + 'x' + file.height : 'variant-' + file.id}`;
    let destination = path.join(folder, base + '.mp4');
    for (let suffix = 1; ; suffix++) {
      try { await fs.access(destination); destination = path.join(folder, `${base}-${suffix}.mp4`); } catch { break; }
    }
    const partial = destination + '.' + randomUUID() + '.part';
    const converted = partial + '.mp4';
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const reader = response.body.getReader();
    let received = 0;
    let header = Buffer.alloc(0);
    try {
      handle = await fs.open(partial, 'wx');
      while (true) {
        timeoutSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > limit) throw new Error('This video exceeds the 1 GB download limit. Choose a smaller resolution.');
        if (header.length < 32) header = Buffer.concat([header, Buffer.from(value)]).subarray(0, 32);
        await handle.writeFile(value);
        progress(received, total);
      }
      timeoutSignal.throwIfAborted();
      const valid = file.format === 'webm' ? header.subarray(0, 4).toString('hex') === '1a45dfa3' : file.format === 'ogv' ? header.subarray(0, 4).toString() === 'OggS' : header.subarray(4, 8).toString() === 'ftyp';
      if (!received || (total && received !== total) || !valid) throw new Error('The download is incomplete or is not a video. Please retry.');
      await handle.close(); handle = undefined;
      progress(received, total, 'converting');
      await this.convert(partial, converted, timeoutSignal);
      timeoutSignal.throwIfAborted();
      await fs.writeFile(destination + '.source.json', JSON.stringify({ provider, title: video.title, creator: video.creator, source: video.url, license: video.license, licenseUrl: video.licenseUrl, usage: video.usage }, null, 2), { flag: 'wx' });
      try { await fs.rename(converted, destination); } catch (error) { await fs.rm(destination + '.source.json', { force: true }); throw error; }
      return destination;
    } finally {
      await handle?.close();
      await reader.cancel().catch(() => {});
      await fs.rm(partial, { force: true });
      await fs.rm(converted, { force: true });
    }
  }
}

/** Archive downloads redirect to numbered Archive.org storage hosts. */
export function archiveMediaUrl(value: string): string {
  try {
    const host = new URL(value).hostname;
    return httpsUrl(value, host === 'archive.org' || /^(?:ia|dn)\d+\.(?:us|ca)\.archive\.org$/.test(host) ? [host] : []);
  } catch { return ''; }
}
