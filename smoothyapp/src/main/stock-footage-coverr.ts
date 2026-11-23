import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { httpsUrl, text, type StockFile, type StockSearch, type StockVideo, type StockResults } from './stock-footage';

const DAY = 24 * 60 * 60 * 1000;
export const COVERR_USAGE = 'Free for personal and commercial projects under the Coverr License. Credit Coverr when you publish. Do not redistribute the unedited clip as standalone stock media. Recognizable people, brands and places can need separate permission.';
const ID = /^[A-Za-z0-9]{6,32}$/;

export function normalizeCoverrVideo(raw: any): StockVideo | null {
  const pageUrl = httpsUrl(raw?.pageURL, ['coverr.co']);
  if (typeof raw?.id !== 'string' || !ID.test(raw.id) || !pageUrl || !Number.isFinite(raw.duration) || raw.duration <= 0 || !Array.isArray(raw.files)) return null;
  const files: StockFile[] = raw.files.flatMap((file: any, index: number) => {
    const link = httpsUrl(file?.url, ['cdn.coverr.co']);
    if (!link || !new URL(link).pathname.startsWith('/videos/') || !/\.mp4$/i.test(new URL(link).pathname)
      || !Number.isSafeInteger(file.width) || file.width < 1 || file.width > 16384
      || !Number.isSafeInteger(file.height) || file.height < 1 || file.height > 16384) return [];
    return [{ id: index + 1, width: file.width, height: file.height, fps: Number.isFinite(raw.fps) && raw.fps > 0 ? raw.fps : 0, link, format: 'mp4', label: text(file.label) || 'MP4' }];
  }).sort((a: StockFile, b: StockFile) => b.width * b.height - a.width * a.height);
  const image = httpsUrl(raw.thumbnail, ['cdn.coverr.co']);
  if (!files.length || !image) return null;
  return { id: 'coverr:' + raw.id, provider: 'coverr', title: text(raw.title) || text(raw.tags) || 'Coverr video ' + raw.id,
    license: 'Coverr License', licenseUrl: 'https://coverr.co/license', usage: COVERR_USAGE,
    width: files[0].width, height: files[0].height, duration: raw.duration, url: pageUrl, image,
    creator: 'Coverr contributor', creatorUrl: pageUrl, files };
}

/** Official builds search through the Smoothy server. Provider credentials never enter the app. */
export class CoverrStockSource {
  private search_ = '';
  private report_ = '';
  constructor(private request: typeof fetch, private cacheFolder?: string) {}
  /** Derived from the shared stock service URL, e.g. https://smoothyedit.com/api/stock/pixabay → .../coverr. */
  configure(endpoint: string, cacheFolder?: string) {
    this.search_ = ''; this.report_ = '';
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
          this.search_ = new URL('coverr', url).href;
          this.report_ = new URL('coverr-download', url).href;
        }
      } catch {}
    }
    this.cacheFolder = cacheFolder;
  }
  get configured() { return Boolean(this.search_); }
  async search(input: StockSearch, signal?: AbortSignal): Promise<StockResults> {
    if (!this.search_) throw new Error('Coverr is unavailable in this build.');
    if (input.query.length > 100) throw new Error('Coverr searches can contain up to 100 characters.');
    const page = input.page || 1, perPage = 12;
    const id = createHash('sha256').update(JSON.stringify(['coverr', this.search_, input.query, page])).digest('hex');
    const cacheFile = this.cacheFolder && path.join(this.cacheFolder, id + '.json');
    let data: any;
    if (cacheFile) {
      try {
        const stat = await fs.stat(cacheFile);
        if (stat.size <= 2 * 1024 * 1024) {
          const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
          if (Number.isFinite(cached.expires) && cached.expires > Date.now() && cached.expires <= Date.now() + DAY) data = cached.data;
        }
      } catch {}
    }
    const valid = (value: any) => Array.isArray(value?.hits) && value.hits.length <= 12 && Number.isSafeInteger(value.total) && value.total >= 0;
    if (!valid(data)) {
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const params = new URLSearchParams({ ...(input.query ? { q: input.query } : { browse: '1' }), page: String(page) });
      try {
        const response = await this.request(this.search_ + '?' + params, {
          headers: { Accept: 'application/json', 'User-Agent': 'SmoothyEdit/3.0 (stock footage search)' }, redirect: 'error', signal: combined
        });
        if (response.status === 429) throw new Error('Stock footage search limit reached. Please try again shortly.');
        if (!response.ok) throw new Error('Coverr search is temporarily unavailable. Please try again.');
        try { data = await response.json(); } catch { throw new Error('Coverr returned an invalid search response.'); }
        if (!valid(data)) throw new Error('Coverr returned an invalid search response.');
      } catch (error) {
        combined.throwIfAborted();
        if (error instanceof Error && /^(Stock footage search limit|Coverr search is temporarily|Coverr returned an invalid)/.test(error.message)) throw error;
        throw new Error('Could not reach the stock footage service. Check your internet connection and retry.');
      }
      if (cacheFile) {
        const temporary = cacheFile + '.' + randomUUID() + '.tmp';
        try {
          await fs.mkdir(this.cacheFolder!, { recursive: true });
          await fs.writeFile(temporary, JSON.stringify({ expires: Date.now() + DAY, data: { total: data.total, pages: data.pages, hits: data.hits } }), { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, cacheFile);
        } catch {} finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
    }
    signal?.throwIfAborted();
    const minimum = { small: 720, medium: 1080, large: 2160 }[input.size || ''] || 0;
    const videos = data.hits.map(normalizeCoverrVideo).filter((video: StockVideo | null): video is StockVideo => Boolean(video)).filter((video: StockVideo) => {
      const ratio = video.width / video.height;
      return (!input.orientation || (input.orientation === 'landscape' ? ratio > 1.05 : input.orientation === 'portrait' ? ratio < .95 : ratio >= .95 && ratio <= 1.05))
        && (!minimum || video.files.some(file => Math.min(file.width, file.height) >= minimum));
    });
    return { videos, page, nextOffset: page * perPage, hasMore: page * perPage < Math.min(data.total, 10000) };
  }
  /** Coverr requires each download to be reported. Best effort: a failure never affects the saved clip. */
  async reportDownload(videoId: string): Promise<void> {
    const id = videoId.replace(/^coverr:/, '');
    if (!this.report_ || !ID.test(id)) return;
    try {
      const response = await this.request(this.report_ + '?' + new URLSearchParams({ id }), {
        method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'User-Agent': 'SmoothyEdit/3.0 (stock footage download)' }, redirect: 'error', signal: AbortSignal.timeout(10000)
      });
      await response.body?.cancel();
    } catch {}
  }
}
