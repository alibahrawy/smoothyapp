/**
 * Community avatars: a crisp initials monogram on a chosen colour tile, or an
 * uploaded square picture. Everyone gets a stable default colour derived from
 * their id so the feed never shows an empty slot.
 *
 * The wire format keeps the same `{ kind: 'gen', style, shape, eyes, color }`
 * and `{ kind: 'img', data }` schema validated by `AVATAR_CHOICES` in
 * `web/src/lib/community-chat.ts` so existing profiles stay compatible.
 */

export type AvatarStyle = 'flat' | 'plush';

export type CommunityAvatar =
  | { kind: 'gen'; style: AvatarStyle; shape: number; eyes: number; color: number | null }
  | { kind: 'img'; data: string };

export const AVATAR_COLORS = [
  '#18181B', '#FF6B6B', '#FF9636', '#FFD23F', '#92F388', '#34C759', '#22B8CF', '#4BC6FA',
  '#3B82F6', '#6366F1', '#7C5CFC', '#9B6BFF', '#D946EF', '#FF8AC6', '#F43F5E', '#F59E0B', '#64748B',
] as const;

/** Names for the editor's accessible labels. */
export const AVATAR_COLOR_NAMES = [
  'Ink', 'Watermelon', 'Papaya', 'Mango', 'Lime', 'Mint', 'Teal', 'Sky',
  'Blueberry', 'Indigo', 'Violet', 'Grape', 'Dragonfruit', 'Rose', 'Berry', 'Amber', 'Graphite',
] as const;

/** Design Bible §11 p.31: the nine flavors + Graphite for the Settings picker. */
export const AVATAR_BRAND_INDICES = [4, 3, 2, 1, 13, 12, 11, 8, 7, 16] as const;

/** Automatic avatar colors stay within the nine vibrant Smoothy flavors. */
const AUTO_AVATAR_INDICES = [4, 3, 2, 1, 13, 12, 11, 8, 7] as const;

const SHAPE_COUNT = 10;
const EYE_COUNT = 16;

function hash(value: string): number {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable look for anyone who has not picked a colour or photo yet. */
export function defaultAvatar(id: string): CommunityAvatar {
  const h = hash(id || '?');
  return { kind: 'gen', style: 'flat', shape: h % SHAPE_COUNT, eyes: (h >>> 4) % EYE_COUNT, color: null };
}

export function colorFor(avatar: Extract<CommunityAvatar, { kind: 'gen' }>, id: string): string {
  const index = avatar.color ?? AUTO_AVATAR_INDICES[hash(`${id}:color`) % AUTO_AVATAR_INDICES.length];
  return AVATAR_COLORS[Math.min(Math.max(index, 0), AVATAR_COLORS.length - 1)];
}

function relativeLuminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  const linear = (shift: number) => {
    const channel = ((value >> shift) & 255) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] || character);
}

function firstChar(word: string): string {
  const cleaned = word.replace(/^[^\p{L}\p{N}]+/u, '');
  const chars = [...(cleaned || word)];
  return (chars[0] || '').toUpperCase();
}

/**
 * Derive 1–2 crisp initials from a display name. Strips a leading "Guest "
 * prefix when another word follows so auto-generated guest handles show a
 * distinct letter instead of "GO" for every guest.
 */
export function avatarInitials(name = '', id = ''): string {
  let trimmed = String(name || '').trim();
  if (/^guest\s+\S/i.test(trimmed)) trimmed = trimmed.replace(/^guest\s+/i, '').trim();
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const meaningful = words.filter((word) => /\p{L}/u.test(word));
  const source = meaningful.length ? meaningful : words;
  if (source.length >= 2) {
    const pair = `${firstChar(source[0])}${firstChar(source[source.length - 1])}`;
    if (pair) return pair;
  }
  if (source.length === 1) {
    const single = firstChar(source[0]);
    if (single) return single;
  }
  if (id) return String.fromCharCode(65 + (hash(`${id}:initial`) % 26));
  return 'S';
}

/**
 * Clean monogram tile SVG (Linear / Slack style). `id` seeds the automatic
 * colour and fallback letter; `name` supplies the 1–2 character initials.
 */
export function avatarSvg(
  avatar: Extract<CommunityAvatar, { kind: 'gen' }>,
  id = '',
  size = 32,
  name = '',
): string {
  const bg = colorFor(avatar, id);
  const luminance = relativeLuminance(bg);
  const fg = luminance > 0.36 ? '#141414' : '#FFFFFF';
  const stroke = luminance < 0.05 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';
  const initials = avatarInitials(name, id);
  const fontSize = initials.length > 1 ? 38 : 45;
  const letterSpacing = initials.length > 1 ? '-1' : '0';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + `<rect width="100" height="100" rx="28" fill="${bg}"/>`
    + `<rect x="1.5" y="1.5" width="97" height="97" rx="26.5" fill="none" stroke="${stroke}" stroke-width="3"/>`
    + `<text x="50" y="52" text-anchor="middle" dominant-baseline="central" fill="${fg}" font-family="-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="${letterSpacing}">${escapeXml(initials)}</text>`
    + `</svg>`;
}

export const AVATAR_SHAPE_COUNT = SHAPE_COUNT;
export const AVATAR_EYE_COUNT = EYE_COUNT;

/** Same rule as the server: a 128px WebP/JPEG data URL under 24 KB. */
export const AVATAR_IMAGE_MAX_CHARS = 24_000;

/** Only a data URL of a raster picture may become an `<img src>`. */
export function isAvatarDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= AVATAR_IMAGE_MAX_CHARS
    && /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Validate a profile avatar coming off the wire. */
export function cleanAvatar(value: unknown): CommunityAvatar | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.kind === 'img') return isAvatarDataUrl(input.data) ? { kind: 'img', data: input.data } : null;
  if (input.kind !== 'gen') return null;
  const style = input.style === 'plush' ? 'plush' : input.style === 'flat' ? 'flat' : null;
  const shape = Number.isInteger(input.shape) && (input.shape as number) >= 0 && (input.shape as number) < SHAPE_COUNT ? (input.shape as number) : null;
  const eyes = Number.isInteger(input.eyes) && (input.eyes as number) >= 0 && (input.eyes as number) < EYE_COUNT ? (input.eyes as number) : null;
  const color = input.color === null ? null
    : Number.isInteger(input.color) && (input.color as number) >= 0 && (input.color as number) < AVATAR_COLORS.length ? (input.color as number) : undefined;
  if (!style || shape === null || eyes === null || color === undefined) return null;
  return { kind: 'gen', style, shape, eyes, color };
}
