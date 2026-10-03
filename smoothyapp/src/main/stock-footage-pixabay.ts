import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { httpsUrl, text, type StockFile, type StockSearch, type StockVideo, type StockResults } from './stock-footage';

const DAY = 24 * 60 * 60 * 1000;
export const PIXABAY_USAGE = 'Use under the Pixabay Content License. Do not redistribute the unedited clip as standalone stock media. Check the source for other rights relevant to your edit.';
export function normalizePixabayVideo(raw: any): StockVideo | null {
  const url = httpsUrl(raw?.pageURL, ['pixabay.com']);
  if (!Number.isSafeInteger(raw?.id) || raw.id < 1 || !['film', 'animation'].includes(raw.type) || !url
    || !new URL(url).pathname.startsWith('/videos/') || !Number.isFinite(raw.duration) || raw.duration <= 0) return null;
  const files: StockFile[] = ['large', 'medium', 'small', 'tiny'].flatMap((name, index) => {
    const file = raw.videos?.[name];
    const link = httpsUrl(file?.url, ['cdn.pixabay.com']);
    if (!link || !new URL(link).pathname.startsWith('/video/') || !/\.mp4$/i.test(new URL(link).pathname)
      || !Number.isSafeInteger(file.width) || file.width < 1 || file.width > 16384
      || !Number.isSafeInteger(file.height) || file.height < 1 || file.height > 16384
      || !Number.isFinite(file.size) || file.size <= 0 || file.size > 1024 * 1024 * 1024) return [];
    return [{ id: index + 1, width: file.width, height: file.height, fps: 0, link, format: 'mp4', label: name + ' MP4' }];
  }).sort((a, b) => b.width * b.height - a.width * a.height);
  const image = ['small', 'tiny', 'medium', 'large'].map(name => httpsUrl(raw.videos?.[name]?.thumbnail, ['cdn.pixabay.com'])).find(Boolean);
  if (!files.length || !image) return null;
  const largest = files[0];
  return { id: 'pixabay:' + raw.id, provider: 'pixabay', title: text(raw.tags) || 'Pixabay video ' + raw.id,
    license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', usage: PIXABAY_USAGE,
    width: largest.width, height: largest.height, duration: raw.duration, url, image,
    creator: text(raw.user) || 'Pixabay contributor', creatorUrl: url, files };
}

declare const __SMOOTHY_STOCK_SERVICE_URL__: string;
export function stockServiceURL(): string {
  return typeof __SMOOTHY_STOCK_SERVICE_URL__ === 'string' ? __SMOOTHY_STOCK_SERVICE_URL__ : '';
}

/** Official builds use a server service. Provider credentials never enter the app. */
export class PixabayStockSource {
  private endpoint = '';
  constructor(private request: typeof fetch, private cacheFolder?: string) { this.configure(stockServiceURL(), cacheFolder); }
  configure(endpoint: string, cacheFolder?: string) {
    this.endpoint = '';
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) this.endpoint = url.href;
      } catch {}
    }
    this.cacheFolder = cacheFolder;
  }
  get configured() { return Boolean(this.endpoint); }
  async search(input: StockSearch, signal?: AbortSignal): Promise<StockResults> {
    if (!this.endpoint) throw new Error('Pixabay is unavailable in this build.');
    if (input.query.length > 100) throw new Error('Pixabay searches can contain up to 100 characters.');
    const page = input.page || 1, perPage = 12;
    const id = createHash('sha256').update(JSON.stringify([this.endpoint, input.query, page, input.size || ''])).digest('hex');
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
    const valid = (value: any) => Array.isArray(value?.hits) && value.hits.length <= 12 && Number.isSafeInteger(value.totalHits) && value.totalHits >= 0;
    if (!valid(data)) {
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const params = new URLSearchParams({ q: input.query, page: String(page), ...(input.size ? { size: input.size } : {}) });
      try {
        const response = await this.request(this.endpoint + '?' + params, {
          headers: { Accept: 'application/json', 'User-Agent': 'SmoothyEdit/1.5.1 (stock footage search)' }, redirect: 'error', signal: combined
        });
        if (response.status === 429) throw new Error('Stock footage search limit reached. Please try again shortly.');
        if (!response.ok) throw new Error('Pixabay search is temporarily unavailable. Please try again.');
        try { data = await response.json(); } catch { throw new Error('Pixabay returned an invalid search response.'); }
        if (!valid(data)) throw new Error('Pixabay returned an invalid search response.');
      } catch (error) {
        combined.throwIfAborted();
        if (error instanceof Error && /^(Stock footage search limit|Pixabay search is temporarily|Pixabay returned an invalid)/.test(error.message)) throw error;
        throw new Error('Could not reach the stock footage service. Check your internet connection and retry.');
      }
      if (cacheFile) {
        const temporary = cacheFile + '.' + randomUUID() + '.tmp';
        try {
          await fs.mkdir(this.cacheFolder!, { recursive: true });
          await fs.writeFile(temporary, JSON.stringify({ expires: Date.now() + DAY, data: { totalHits: data.totalHits, hits: data.hits } }), { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, cacheFile);
        } catch {} finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
    }
    signal?.throwIfAborted();
    const minimum = { small: 720, medium: 1080, large: 2160 }[input.size || ''] || 0;
    const videos = data.hits.map(normalizePixabayVideo).filter((video: StockVideo | null): video is StockVideo => Boolean(video)).filter((video: StockVideo) => {
      const ratio = video.width / video.height;
      return (!input.orientation || (input.orientation === 'landscape' ? ratio > 1.05 : input.orientation === 'portrait' ? ratio < .95 : ratio >= .95 && ratio <= 1.05))
        && (!minimum || video.files.some(file => Math.min(file.width, file.height) >= minimum));
    });
    return { videos, page, nextOffset: page * perPage, hasMore: page * perPage < Math.min(data.totalHits, 10000) };
  }
}
