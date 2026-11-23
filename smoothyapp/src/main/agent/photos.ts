/**
 * Photos and licences for the agent's sourcing.
 *
 * - Wikimedia Commons photo search with fail-closed licence filters:
 *   "pd" (default) = CC0 or public domain, no attribution; "cc-by" also allows
 *   CC BY 1.0–4.0, always with the author credit. Share-alike, non-commercial
 *   and no-derivatives licences are never returned.
 * - Downloads are capped at 3840 px wide (oversized photos caused render glitches).
 * - Stock licence classes and credit lines for the project credits file.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type PhotoLicense = 'pd' | 'cc-by';

export type PhotoHit = {
  id: string;
  title: string;
  author: string;
  license: string;
  licenseUrl: string;
  attribution: boolean;
  restrictions?: string;
  width: number;
  height: number;
  page: string;
  download: string;
  mime: string;
};

const USER_AGENT = 'SmoothyEdit/3.1 (https://smoothyedit.com; photo search)';
const MAX_BYTES = 60 * 1024 * 1024;

export const clean = (value: unknown) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, 200);

const httpsOn = (value: unknown, hosts: string[]): string => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && hosts.includes(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
};

/** Decides whether a Commons file's licence is allowed, failing closed. */
export function commonsLicense(meta: any, wanted: PhotoLicense): { license: string; licenseUrl: string; attribution: boolean } | null {
  const license = clean(meta?.LicenseShortName?.value);
  const attributionRequired = String(meta?.AttributionRequired?.value ?? '').toLowerCase() !== 'false';
  const licenseUrl = httpsOn(String(meta?.LicenseUrl?.value || '').replace(/^http:/, 'https:'), ['creativecommons.org', 'en.wikipedia.org', 'commons.wikimedia.org']);
  if (/^(CC0|Public domain)$/i.test(license) && !attributionRequired) return { license, licenseUrl, attribution: false };
  if (wanted === 'cc-by' && /^CC BY [1-4]\.0$/i.test(license)) return { license, licenseUrl, attribution: true };
  return null;
}

export function normalizePhoto(raw: any, wanted: PhotoLicense, maxWidth = 3840): PhotoHit | null {
  const info = raw?.imageinfo?.[0];
  const meta = info?.extmetadata || {};
  if (!info || !Number.isSafeInteger(raw?.pageid) || raw.pageid <= 0) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(String(info.mime || ''))) return null;
  const licence = commonsLicense(meta, wanted);
  if (!licence) return null;
  const page = httpsOn(info.descriptionurl, ['commons.wikimedia.org']);
  const original = httpsOn(info.url, ['upload.wikimedia.org']);
  const thumb = httpsOn(info.thumburl, ['upload.wikimedia.org']);
  const download = Number(info.width) > maxWidth && thumb ? thumb : original;
  const author = clean(meta.Artist?.value) || (licence.attribution ? '' : 'Wikimedia Commons contributor');
  if (!page || !download || (licence.attribution && !author)) return null;
  return {
    id: String(raw.pageid),
    title: clean(meta.ObjectName?.value) || clean(raw.title).replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
    author, ...licence,
    restrictions: clean(meta.Restrictions?.value) || undefined,
    width: Number(info.width) || 0, height: Number(info.height) || 0,
    page, download, mime: String(info.mime)
  };
}

export type Fetcher = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; headers?: { get(name: string): string | null } }>;

export async function searchCommonsPhotos(fetcher: Fetcher, input: { query: string; license?: PhotoLicense; limit?: number; orientation?: string }, signal?: AbortSignal): Promise<PhotoHit[]> {
  const wanted: PhotoLicense = input.license === 'cc-by' ? 'cc-by' : 'pd';
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '1', generator: 'search', gsrsearch: `filetype:bitmap ${input.query}`,
    gsrnamespace: '6', gsrlimit: '40', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '3840'
  });
  const response = await fetcher(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, redirect: 'error', signal });
  if (!response.ok) throw new Error(`Wikimedia Commons returned ${response.status}.`);
  const data = await response.json();
  const pages = Object.values(data?.query?.pages || {}).sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0));
  const hits = pages.map(page => normalizePhoto(page, wanted)).filter((hit): hit is PhotoHit => Boolean(hit));
  const shaped = input.orientation === 'portrait' ? hits.filter(hit => hit.height > hit.width) : input.orientation === 'landscape' ? hits.filter(hit => hit.width >= hit.height) : hits;
  return shaped.slice(0, Math.max(1, Math.min(20, input.limit || 8)));
}

/** Downloads a photo and keeps it at most maxWidth wide. Returns the saved file. */
export async function downloadPhoto(fetcher: Fetcher, hit: PhotoHit, file: string, maxWidth = 3840, signal?: AbortSignal): Promise<{ path: string; width: number; height: number; resized: boolean }> {
  if (!httpsOn(hit.download, ['upload.wikimedia.org'])) throw new Error('That photo URL is not on Wikimedia Commons.');
  const response = await fetcher(hit.download, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal });
  if (!response.ok) throw new Error(`The photo download failed (${response.status}).`);
  const length = Number(response.headers?.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error('That photo is larger than 60 MB.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('That photo is larger than 60 MB.');
  return savePhoto(buffer, file, maxWidth);
}

/** Writes image bytes, resized to maxWidth when wider. */
export async function savePhoto(buffer: Buffer, file: string, maxWidth = 3840): Promise<{ path: string; width: number; height: number; resized: boolean }> {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('That download is not a readable image.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (meta.width <= maxWidth) {
    await fs.writeFile(file, buffer, { flag: 'wx' });
    return { path: file, width: meta.width, height: meta.height, resized: false };
  }
  const info = await sharp(buffer).rotate().resize({ width: maxWidth, withoutEnlargement: true }).toFile(file);
  return { path: file, width: info.width, height: info.height, resized: true };
}

/** Licence classes for stock footage results. */
export function stockAttribution(license: string | undefined): 'none' | 'credit recommended' | 'unknown' {
  const value = String(license || '');
  if (/^(CC0|Public domain|Pixabay Content License|Coverr License)$/i.test(value)) return 'none';
  if (/^NASA/i.test(value)) return 'credit recommended';
  return 'unknown';
}

/** One credits line for a project asset's source. */
export function creditLine(asset: { name: string; source?: { provider?: string; license?: string; credit?: string; url?: string } }): string | null {
  const source = asset.source;
  if (!source || (!source.license && !source.credit && !source.url)) return null;
  const parts = [source.credit || asset.name, source.license, source.provider, source.url].filter(Boolean);
  return parts.join(' — ');
}
