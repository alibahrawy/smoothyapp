/**
 * Client for the Smoothy web API — the Studio cloud features.
 *
 * Everything here talks to the server (analytics, AI, history, credits).
 * The app's local tools (multicam, silence removal, captions, compressor)
 * never call this and never use credits.
 */

import { getAuthHeaders, getStoredUserId } from './auth-service';
import { assertStudioEnabled, studioSignal } from './app-preferences';
import { studioModes } from './studio-service';
import chatCatalog from '../shared/chat-catalog.json';

const isDev = process.env.NODE_ENV === 'development';
export const CLOUD_API_BASE = process.env.SMOOTHY_API_URL || (isDev ? 'http://localhost:4321' : 'https://smoothyedit.com');
const API_BASE = CLOUD_API_BASE;

export interface StudioCredits {
  tier: 'free' | 'pro';
  credits: number;
  creditsUsed: number;
  totalCredits: number;
  percentage: number;
  daysRemaining: number | null;
  periodEnd: string | null;
  formatted?: { credits: string; creditsUsed: string };
}

export interface StudioShort {
  title?: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  reason?: string;
  hook?: string;
  hashtags?: string[];
  [key: string]: unknown;
}

export interface ShortsHistoryItem {
  id: string;
  mode: string;
  result: string;
  fileName: string | null;
  createdAt: string;
}

export interface ShortsHistoryPage {
  items: ShortsHistoryItem[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
}

/** Thrown when the user isn't signed in to Studio. */
export class NotSignedInError extends Error {
  constructor(message = 'Sign in to Studio to use this feature.') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

function requireAuth(): Record<string, string> {
  assertStudioEnabled();
  if (!getStoredUserId()) {
    throw new NotSignedInError();
  }
  return getAuthHeaders();
}

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return data.message || data.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

/** Fixed Studio endpoints; renderer cannot supply URLs or authentication. */
export async function requestStudioText(route: string, body: unknown, signal: AbortSignal, onChunk?: (delta: string) => void): Promise<string> {
  if (!['/api/analyze', '/api/follow-up', '/api/chat'].includes(route)) throw new Error('Unsupported Studio endpoint.');
  const requestSignal = AbortSignal.any([signal, studioSignal(), AbortSignal.timeout(240000)]);
  const response = await fetch(`${API_BASE}${route}`, {
    method: 'POST', headers: requireAuth(), body: JSON.stringify(body),
    signal: requestSignal,
  });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error('Studio returned an empty response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const limit = route === '/api/chat' ? chatCatalog.maxMessageChars : 2_000_000;
  let raw = '';
  const append = (delta: string) => {
    requestSignal.throwIfAborted();
    if (raw.length + delta.length > limit) throw new Error('Studio result is too large.');
    raw += delta;
    if (delta) onChunk?.(delta);
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode()); return raw;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original stream error. */ }
    throw error;
  } finally { reader.releaseLock(); }
}

export async function saveStudioHistory(mode: string, result: string, fileName: string): Promise<void> {
  if (!studioModes.includes(mode)) throw new Error('Unsupported Studio tool.');
  const response = await fetch(`${API_BASE}/api/history`, { method: 'POST', headers: requireAuth(), body: JSON.stringify({ mode, result, fileName }), signal: studioSignal() });
  if (!response.ok) throw new Error(await readError(response));
}

/** Authenticated Chat History; credentials and fixed endpoint stay in main. */
export async function requestChatHistory(body?: unknown): Promise<any> {
  const owner = getStoredUserId(), headers = requireAuth();
  if (process.env.SMOOTHY_TELEMETRY === '0') headers['X-Smoothy-Telemetry'] = '0';
  const signal = AbortSignal.any([studioSignal(), AbortSignal.timeout(30000)]);
  const response = await fetch(`${API_BASE}/api/chat/history`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  if (getStoredUserId() !== owner) throw new Error('Account changed. Chat History request canceled.');
  signal.throwIfAborted();
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  const result = await response.json();
  signal.throwIfAborted();
  if (getStoredUserId() !== owner) throw new Error('Account changed. Chat History request canceled.');
  return result;
}

export async function listStudioHistory(mode: string, page = 1) {
  if (!studioModes.includes(mode)) throw new Error('Unsupported Studio tool.');
  const response = await fetch(`${API_BASE}/api/history?mode=${mode}&page=${page}&limit=20`, { headers: requireAuth(), signal: studioSignal() });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  const data: any = await response.json();
  return { items: Array.isArray(data.history) ? data.history : [], totalPages: data.totalPages || 1 };
}

/**
 * Remaining Studio credits for the signed-in user. Free accounts start at 100
 * and Pro at 2,000 per month; credits are only spent on cloud calls.
 */
export async function getCredits(): Promise<StudioCredits> {
  const response = await fetch(`${API_BASE}/api/credits`, { headers: requireAuth(), signal: studioSignal() });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<StudioCredits>;
}

/** Server-side shorts history, shared with the web dashboard. */
export async function listShortsHistory(page = 1, limit = 30): Promise<ShortsHistoryPage> {
  const response = await fetch(`${API_BASE}/api/history?mode=shorts&page=${page}&limit=${limit}`, {
    headers: requireAuth(), signal: studioSignal()
  });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));

  const data: any = await response.json();
  return {
    items: Array.isArray(data.history) ? data.history : [],
    totalItems: data.totalItems ?? 0,
    totalPages: data.totalPages ?? 0,
    currentPage: data.currentPage ?? page
  };
}

/**
 * Persist a shorts result to the server so it shows up in Smoothy history on
 * both the app and the web dashboard.
 */
export async function saveShortsToHistory(resultText: string, fileName?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/history`, {
    method: 'POST',
    headers: requireAuth(),
    body: JSON.stringify({ mode: 'shorts', result: resultText, fileName }), signal: studioSignal()
  });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
}

function extractJsonObject(text: string): any | null {
  if (!text) return null;

  // Strip common markdown fences.
  const cleaned = text.replace(/```(?:json)?/gi, '');

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Run Best Shorts on the server. The transcript is produced locally (see the
 * whisper flow in the main process) so only text is uploaded — cheaper in
 * credits and no audio size limit.
 */
export async function analyzeShorts(
  subtitleText: string,
  duration: number | undefined,
  shortsMode: 'multiple' | 'best' = 'multiple',
  signal?: AbortSignal
): Promise<{ shorts: StudioShort[]; raw: string }> {
  const response = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
    signal: AbortSignal.any([studioSignal(), ...(signal ? [signal] : [])]),
    headers: requireAuth(),
    body: JSON.stringify({
      subtitleText,
      analysisMode: 'shorts',
      duration,
      shortsMode
    })
  });

  if (response.status === 401) throw new NotSignedInError();

  const text = await response.text();
  if (!response.ok) {
    // Error responses are JSON; success is a text stream of JSON.
    const parsed = extractJsonObject(text);
    throw new Error(parsed?.message || parsed?.error || `Analysis failed (${response.status})`);
  }

  const parsed = extractJsonObject(text);
  const shorts: StudioShort[] = Array.isArray(parsed?.shorts) ? parsed.shorts : [];
  return { shorts, raw: text };
}

/** Use the same authenticated YouTube transcript endpoint as the dashboard. */
export async function getYoutubeTranscript(url: string): Promise<{ transcript: string; fileName: string }> {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { throw new Error('Enter a valid YouTube URL.'); }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'];
  if (!['http:', 'https:'].includes(parsed.protocol) || !hosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error('Enter a YouTube video URL.');
  }
  const response = await fetch(`${API_BASE}/api/youtube-transcript`, {
    method: 'POST', headers: requireAuth(), body: JSON.stringify({ url: parsed.href }), signal: studioSignal()
  });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  const data: any = await response.json();
  if (typeof data.transcript !== 'string' || !data.transcript.trim()) {
    throw new Error('No transcript is available for this video.');
  }
  return { transcript: data.transcript, fileName: data.videoTitle || `YouTube ${data.videoId || 'video'}` };
}

/** Internal fixed-route client. Credentials stay in the main process. */
export async function requestPhotoRoute(route: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  if (!/^\/api\/(generate-reaction|reactions(?:\/[A-Za-z0-9%-]+)?)(?:\?[^#]*)?$/.test(route)) throw new Error('Unsupported photo endpoint.');
  const response = await fetch(`${API_BASE}${route}`, {
    headers: requireAuth(), method: options.method || 'GET',
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    signal: AbortSignal.any([studioSignal(), AbortSignal.timeout(240000)]),
  });
  if (response.status === 401) throw new NotSignedInError('Your session expired. Sign in again to use AI Photos.');
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/** Only server-managed media or inline raster output; no arbitrary remote URLs or redirects. */
export async function fetchPhotoBytes(value: string): Promise<Buffer> {
  const max = 25 * 1024 * 1024;
  if (value.startsWith('data:')) {
    if (value.length > max * 1.4 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Unsupported image response.');
    const bytes = Buffer.from(value.split(',')[1], 'base64');
    if (bytes.length > max) throw new Error('Image exceeds 25 MB.');
    return bytes;
  }
  const url = new URL(value, API_BASE), base = new URL(API_BASE);
  if (![base.origin, 'https://smoothyedit.com'].includes(url.origin) || !url.pathname.startsWith('/media/') || url.username || url.password) throw new Error('Unsupported image location. Reload image history.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error('Could not download this image. Please retry.');
  if (Number(response.headers.get('content-length')) > max) throw new Error('Image exceeds 25 MB.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('Image exceeds 25 MB.'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
