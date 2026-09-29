/**
 * Client for the Smoothy web API — the Studio cloud features.
 *
 * Everything here talks to the server (analytics, AI, history, credits).
 * The app's local tools (multicam, silence removal, captions, compressor)
 * never call this and never use credits.
 */

import { getAuthHeaders, getStoredUserId } from './auth-service';

const isDev = process.env.NODE_ENV === 'development';
const API_BASE = isDev ? 'http://localhost:3000' : 'https://smoothyedit.com';

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

/**
 * Remaining Studio credits for the signed-in user. Free accounts start at 100
 * and Pro at 5,000 per month; credits are only ever spent on Studio cloud calls.
 */
export async function getCredits(): Promise<StudioCredits> {
  const response = await fetch(`${API_BASE}/api/credits`, { headers: requireAuth() });
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<StudioCredits>;
}

/** Server-side shorts history, shared with the web dashboard. */
export async function listShortsHistory(page = 1, limit = 30): Promise<ShortsHistoryPage> {
  const response = await fetch(`${API_BASE}/api/history?mode=shorts&page=${page}&limit=${limit}`, {
    headers: requireAuth()
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
    body: JSON.stringify({ mode: 'shorts', result: resultText, fileName })
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
  duration: number,
  shortsMode: 'multiple' | 'best' = 'multiple'
): Promise<{ shorts: StudioShort[]; raw: string }> {
  const response = await fetch(`${API_BASE}/api/analyze`, {
    method: 'POST',
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
