/**
 * Community links. The lobby keeps a short allow-list of links (the server
 * strips everything else); the app re-checks every link before it makes it
 * clickable or opens it, so a hostile or buggy server cannot push an arbitrary
 * address into the feed. Keep the host lists in step with
 * `web/src/lib/community-chat.ts`.
 */

export const COMMUNITY_LINK_HOSTS = [
  'youtube.com', 'youtu.be',
  'x.com', 'twitter.com',
  'drive.google.com', 'docs.google.com',
  'frame.io', 'f.io',
  'instagram.com',
  'reddit.com', 'redd.it',
] as const;

/** Direct picture hosts that may be previewed inline. */
export const COMMUNITY_IMAGE_HOSTS = [
  'i.redd.it', 'preview.redd.it', 'external-preview.redd.it',
  'pbs.twimg.com', 'i.ytimg.com', 'lh3.googleusercontent.com',
] as const;

const MAX_LENGTH = 300;
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const URL_IN_TEXT = /https:\/\/[^\s]+/g;

function hostMatches(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** The link if it is https, on the allow-list and free of credentials; otherwise null. */
export function safeCommunityLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!hostMatches(host, COMMUNITY_LINK_HOSTS) && !hostMatches(host, COMMUNITY_IMAGE_HOSTS)) return null;
  return url.href;
}

/** True for a direct picture on a preview-safe host. */
export function isCommunityImage(link: string): boolean {
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !hostMatches(host, COMMUNITY_IMAGE_HOSTS)) return false;
    return IMAGE_PATH.test(url.pathname)
      || ['i.redd.it', 'pbs.twimg.com', 'i.ytimg.com', 'lh3.googleusercontent.com'].includes(host);
  } catch {
    return false;
  }
}

/** A YouTube thumbnail for a watch/short/youtu.be link, or null. */
export function youtubeThumbnail(link: string): string | null {
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      id = url.searchParams.get('v') || '';
      const short = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,20})/);
      if (!id && short) id = short[1];
    }
    return /^[\w-]{6,20}$/.test(id) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
  } catch {
    return null;
  }
}

const SITES: Array<[readonly string[], string]> = [
  [['youtube.com', 'youtu.be'], 'YouTube'],
  [['x.com', 'twitter.com'], 'X'],
  [['drive.google.com', 'docs.google.com'], 'Google Drive'],
  [['frame.io', 'f.io'], 'Frame.io'],
  [['instagram.com'], 'Instagram'],
  [['reddit.com', 'redd.it', 'i.redd.it', 'preview.redd.it', 'external-preview.redd.it'], 'Reddit'],
];

/** Friendly site name for a link chip. */
export function communitySiteName(link: string): string {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return SITES.find(([hosts]) => hostMatches(host, hosts))?.[1] ?? host.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

export type MessagePart = { type: 'text'; text: string } | { type: 'link'; url: string };

/** Split a message into text and links, keeping only links that pass {@link safeCommunityLink}. */
export function splitCommunityMessage(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of body.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const trailing = match[0].match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const core = trailing ? match[0].slice(0, -trailing.length) : match[0];
    const safe = safeCommunityLink(core);
    if (!safe) continue;
    if (start > last) parts.push({ type: 'text', text: body.slice(last, start) });
    parts.push({ type: 'link', url: safe });
    last = start + core.length;
  }
  if (last < body.length) parts.push({ type: 'text', text: body.slice(last) });
  return parts;
}
