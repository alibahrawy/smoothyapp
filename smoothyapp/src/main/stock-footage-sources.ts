import { httpsUrl, text, type StockFile, type StockVideo, type StockSearch, type StockResults } from './stock-footage';

const NASA_USAGE = 'Acknowledge NASA as the source. Follow NASA media guidelines; no implied endorsement. Third-party material and identifiable people can require permission.';
const NASA_LICENSE = 'https://www.nasa.gov/nasa-brand-center/images-and-media/';
const ARCHIVE_USAGE = 'The item publisher declares this license. Check its source page for credits and other rights relevant to your use.';
const licenses = ['https://creativecommons.org/publicdomain/zero/1.0/', 'https://creativecommons.org/publicdomain/mark/1.0/',
  'https://creativecommons.org/publicdomain/', 'https://creativecommons.org/licenses/publicdomain/'];
const idAllowed = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(id);
const nasaIdAllowed = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\/\\\x00-\x1f]/.test(id) && id !== '.' && id !== '..';
const number = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
function seconds(value: unknown): number {
  const parts = String(value || '').replace(/\s*s$/, '').split(':').map(Number);
  return parts.length <= 3 && parts.every(n => Number.isFinite(n) && n >= 0) ? parts.reduce((n, part) => n * 60 + part, 0) : 0;
}
function archiveLicense(value: unknown): { license: string; licenseUrl: string } | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1 || typeof values[0] !== 'string') return null;
  const url = httpsUrl(values[0].replace(/^http:/, 'https:'), ['creativecommons.org']);
  if (!licenses.includes(url)) return null;
  return { license: url.includes('/zero/') ? 'CC0' : 'Public domain', licenseUrl: url };
}

/** Only explicitly licensed stock-footage / Prelinger items, never arbitrary video uploads. */
export function normalizeArchiveVideos(raw: any): StockVideo[] {
  const metadata = raw?.metadata;
  const id = metadata?.identifier;
  const declared = archiveLicense(metadata?.licenseurl);
  const collections = Array.isArray(metadata?.collection) ? metadata.collection : [metadata?.collection];
  if (!idAllowed(id) || !declared || metadata.mediatype !== 'movies' || raw.is_dark || raw.nodownload || metadata.nodownload
    || !collections.some((value: string) => ['stock_footage', 'prelinger'].includes(value)) || !Array.isArray(raw.files)) return [];
  const byName = new Map<string, any>(raw.files.map((file: any) => [file.name, file]));
  const groups = new Map<string, any[]>();
  for (const file of raw.files) {
    if (typeof file.name !== 'string' || file.name.length > 500 || !/\.mp4$/i.test(file.name) || file.private || file.nodownload
      || /[\\\x00-\x1f]/.test(file.name) || file.name.split('/').some((part: string) => !part || part === '.' || part === '..')
      || number(file.size) > 1024 * 1024 * 1024) continue;
    let root = file;
    const visited = new Set<string>();
    while (root.original && byName.has(root.original) && !visited.has(root.name)) { visited.add(root.name); root = byName.get(root.original); }
    const group = groups.get(root.name) || []; group.push(file); groups.set(root.name, group);
  }
  return [...groups].slice(0, 24).map(([name, group]) => {
    const files: StockFile[] = group.map((file, index) => ({ id: index + 1, width: number(file.width), height: number(file.height),
      fps: number(file.fps), link: `https://archive.org/download/${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      format: 'mp4', label: file.source === 'original' ? 'Original MP4' : 'MP4' }))
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const largest = files[0];
    const url = `https://archive.org/details/${encodeURIComponent(id)}`;
    return { id: `archive:${id}:${name}`, provider: 'archive' as const, title: text(metadata.title) + (groups.size > 1 ? ' · ' + text(name) : ''),
      ...declared, usage: ARCHIVE_USAGE, width: largest.width, height: largest.height, duration: seconds(group[0].length || metadata.runtime),
      url, image: `https://archive.org/services/img/${encodeURIComponent(id)}`, creator: text(metadata.creator) || 'Internet Archive contributor', creatorUrl: url, files };
  });
}

export function normalizeNasaVideo(item: any, manifest: any, metadata: any): StockVideo | null {
  const data = item?.data?.[0];
  const id = data?.nasa_id;
  if (!nasaIdAllowed(id) || data.media_type !== 'video' || !Array.isArray(manifest) || !metadata || typeof metadata !== 'object') return null;
  // NASA's general permission does not cover credited third-party copyrighted material.
  const rights = Object.entries(metadata).filter(([key]) => /copyright|rights|credit/i.test(key)).map(([, value]) => String(value)).join(' ');
  if (/©|copyright|all rights reserved|getty|shutterstock|associated press/i.test(rights + ' ' + data.description)) return null;
  const image = httpsUrl(item.links?.find((link: any) => link.rel === 'preview')?.href, ['images-assets.nasa.gov']);
  const width = number(metadata['QuickTime:ImageWidth'] || metadata['Composite:ImageWidth']);
  const height = number(metadata['QuickTime:ImageHeight'] || metadata['Composite:ImageHeight']);
  const files: StockFile[] = manifest.flatMap((value: any, index: number) => {
    const link = httpsUrl(typeof value === 'string' ? value.replace(/^http:/, 'https:') : '', ['images-assets.nasa.gov']);
    const match = link.match(/~(orig|large|medium|small|mobile|preview)\.mp4$/i);
    if (!match) return [];
    try { const parts = new URL(link).pathname.split('/'); if (parts.length !== 4 || parts[1] !== 'video' || decodeURIComponent(parts[2]) !== id) return []; }
    catch { return []; }
    const original = match[1] === 'orig' && metadata['File:MIMEType'] === 'video/mp4';
    return [{ id: index + 1, width: original ? width : 0, height: original ? height : 0, fps: original ? number(metadata['QuickTime:VideoFrameRate']) : 0,
      link, format: 'mp4', label: match[1][0].toUpperCase() + match[1].slice(1) + ' MP4' }];
  });
  const order = ['Orig', 'Large', 'Medium', 'Small', 'Mobile', 'Preview'];
  files.sort((a, b) => order.indexOf(a.label!.split(' ')[0]) - order.indexOf(b.label!.split(' ')[0]));
  if (!image || !files.length) return null;
  const url = `https://images.nasa.gov/details/${encodeURIComponent(id)}`;
  return { id: `nasa:${id}`, provider: 'nasa', title: text(data.title), license: 'NASA media guidelines', licenseUrl: NASA_LICENSE, usage: NASA_USAGE,
    width, height, duration: seconds(metadata['QuickTime:Duration']), url, image, creator: text(data.secondary_creator) || 'NASA / ' + text(data.center), creatorUrl: url, files };
}

function matches(video: StockVideo, input: StockSearch): boolean {
  const ratio = video.width / video.height;
  if (input.orientation && (!Number.isFinite(ratio) || !ratio || (input.orientation === 'landscape' && ratio <= 1.05)
    || (input.orientation === 'portrait' && ratio >= .95) || (input.orientation === 'square' && (ratio < .95 || ratio > 1.05)))) return false;
  const minimum = { small: 720, medium: 1080, large: 2160 }[input.size || ''] || 0;
  return !minimum || video.files.some(file => Math.min(file.width, file.height) >= minimum);
}

export async function searchOtherStockSources(input: StockSearch, request: typeof fetch, signal?: AbortSignal): Promise<StockResults> {
  const label = input.provider === 'nasa' ? 'NASA' : 'Internet Archive';
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  const json = async (url: string) => {
    const response = await request(url, { headers: { Accept: 'application/json', 'User-Agent': 'SmoothyEdit/1.5.2 (https://smoothyedit.com; stock footage search)' }, redirect: 'error', signal: combined });
    if (response.status === 429) throw new Error(`${label} search limit reached. Please try again later.`);
    if (!response.ok) throw new Error(`${label} is unavailable right now. Please try again.`);
    return response.json() as Promise<any>;
  };
  const page = input.page || 1;
  const batchSize = 8;
  if (input.provider === 'archive' && page > 1250) throw new Error('Internet Archive searches are limited to the first 10,000 items. Try a more specific search.');
  let videos: StockVideo[] = [], hasMore = false;
  let failed = 0;
  if (input.provider === 'archive') {
    const query = '"' + input.query.replace(/([\\"])/g, '\\$1') + '" AND mediatype:movies AND (collection:stock_footage OR collection:prelinger) AND licenseurl:('
      + licenses.flatMap(url => [url, url.replace(/^https:/, 'http:')]).map(url => '"' + url + '"').join(' OR ') + ')';
    const params = new URLSearchParams({ q: query, output: 'json', rows: String(batchSize), page: String(page), 'fl[]': 'identifier', 'sort[]': 'downloads desc' });
    const data = await json('https://archive.org/advancedsearch.php?' + params);
    if (!Array.isArray(data.response?.docs) || !Number.isSafeInteger(data.response.numFound) || data.response.numFound < 0) throw new Error('Internet Archive returned an invalid search response.');
    hasMore = page * batchSize < Math.min(data.response.numFound, 10000);
    for (let start = 0; start < data.response.docs.length; start += 4) {
      const items = await Promise.all(data.response.docs.slice(start, start + 4).map(async (item: any) => {
        if (!idAllowed(item.identifier)) return [];
        try {
          const details = await json('https://archive.org/metadata/' + encodeURIComponent(item.identifier));
          return details.metadata?.identifier === item.identifier ? normalizeArchiveVideos(details) : [];
        }
        catch (error) { combined.throwIfAborted(); failed++; return []; }
      }));
      videos.push(...items.flat());
    }
  } else {
    const params = new URLSearchParams({ q: input.query, media_type: 'video', page: String(page), page_size: String(batchSize) });
    const data = await json('https://images-api.nasa.gov/search?' + params);
    if (!Array.isArray(data.collection?.items) || !Number.isSafeInteger(data.collection.metadata?.total_hits)) throw new Error('NASA returned an invalid search response.');
    hasMore = page * batchSize < data.collection.metadata.total_hits;
    for (let start = 0; start < data.collection.items.length; start += 4) {
      const items = await Promise.all(data.collection.items.slice(start, start + 4).map(async (item: any) => {
        const id = item.data?.[0]?.nasa_id;
        if (!nasaIdAllowed(id)) return null;
        try {
          const root = `https://images-assets.nasa.gov/video/${encodeURIComponent(id)}/`;
          const [manifest, metadata] = await Promise.all([json(root + 'collection.json'), json(root + 'metadata.json')]);
          return normalizeNasaVideo(item, manifest, metadata);
        } catch (error) { combined.throwIfAborted(); failed++; return null; }
      }));
      videos.push(...items.filter((item): item is StockVideo => Boolean(item)));
    }
  }
  combined.throwIfAborted();
  if (failed && !videos.length) throw new Error(`${label} could not load the video details. Please retry.`);
  videos = videos.filter(video => matches(video, input));
  return { videos, page, hasMore, nextOffset: page * batchSize, ...(failed ? { warning: 'Some video details could not be loaded. Search again to retry.' } : {}) };
}
