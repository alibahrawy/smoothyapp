/**
 * Smoothy Pro and social reminders.
 *
 * Counts finished free tools on this device (nothing leaves the machine) and
 * asks the renderer to show at most one reminder:
 *  - Smoothy Pro after 5 finished tools; each skip waits 10, then 20, then 20
 *    more tools. Never shown to Pro members.
 *  - Social (Discord, X, Instagram, Threads, LinkedIn) after 3 finished tools;
 *    each skip waits longer (15 tools and 7 days, then 30/14, then 50/30). Opening
 *    any link or "I already follow" stops it for good.
 * Never more than one reminder per launch, and at least 20 hours between any two.
 * The renderer waits until the user is idle (no progress, dialog or busy tool)
 * before showing it, so a reminder never interrupts work.
 */

export type NudgeKind = 'pro' | 'social';
export const SOCIAL_LINKS = ['discord', 'x', 'instagram', 'threads', 'linkedin'] as const;
export type SocialLink = (typeof SOCIAL_LINKS)[number];
export type NudgeAction = 'upgrade' | 'skip' | 'already' | SocialLink;

interface Track { nextAt: number; skips: number; notBefore?: number; done?: boolean }
interface NudgeState { runs: number; lastShownAt: number; pro: Track; social: Track }
export interface NudgePayload { kind: NudgeKind; runs: number; preview?: boolean }

interface KeyValueStore { get(key: string): unknown; set(key: string, value: unknown): void }
export interface NudgeDeps {
  store: KeyValueStore;
  isPro: () => boolean;
  notify: (payload: NudgePayload) => void;
  track: (feature: string) => void;
  now?: () => number;
}

const KEY = 'nudges';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const NUDGE_COOLDOWN_MS = 20 * HOUR;
export const PRO_FIRST = 5;
export const PRO_GAPS = [10, 20];
export const SOCIAL_FIRST = 3;
export const SOCIAL_GAPS = [15, 30, 50];
export const SOCIAL_WAIT_DAYS = [7, 14, 30];

/**
 * Finished work that counts toward a reminder. Searches, previews, copies,
 * sign-ins, Community, ShortsCuts key presses and agent calls do not: a
 * reminder should follow something the user just made, not a click.
 */
export const NUDGE_TOOL_IDS = new Set([
  'multicam', 'silence', 'captions', 'captions_export', 'captions_premiere', 'captions_resolve',
  'subtitles_export', 'compressor', 'media_convert', 'media_extract_audio', 'bestshorts', 'shorts_markers',
  'resolve_shorts_markers', 'resolve_silence_export', 'resolve_multicam_export', 'resolve_timeline_send',
  'studio_audio_export', 'audio_noise_remove', 'audio_music_separate', 'audio_tools_save',
  'stock_download', 'stock_premiere', 'stock_resolve', 'audio_save', 'audio_premiere', 'audio_resolve',
  'sfx_save', 'sfx_premiere', 'sfx_resolve', 'assets_export', 'assets_premiere', 'assets_resolve',
  'photos_save', 'photos_premiere', 'photos_resolve',
]);

const gapAt = (gaps: number[], skips: number) => gaps[Math.min(Math.max(skips - 1, 0), gaps.length - 1)];

function fresh(): NudgeState {
  return { runs: 0, lastShownAt: 0, pro: { nextAt: PRO_FIRST, skips: 0 }, social: { nextAt: SOCIAL_FIRST, skips: 0 } };
}

function read(store: KeyValueStore): NudgeState {
  const saved = store.get(KEY) as Partial<NudgeState> | undefined;
  const base = fresh();
  if (!saved || typeof saved !== 'object') return base;
  const num = (value: unknown, fallback: number) => (Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback);
  const track = (value: Partial<Track> | undefined, fallback: Track): Track => ({
    nextAt: num(value?.nextAt, fallback.nextAt),
    skips: num(value?.skips, 0),
    notBefore: num(value?.notBefore, 0),
    done: value?.done === true,
  });
  return { runs: num(saved.runs, 0), lastShownAt: num(saved.lastShownAt, 0), pro: track(saved.pro, base.pro), social: track(saved.social, base.social) };
}

export function createNudges(deps: NudgeDeps) {
  const now = deps.now ?? Date.now;
  let state = read(deps.store);
  let shownThisLaunch = false;
  let pending: NudgeKind | null = null;
  const save = () => deps.store.set(KEY, state);

  function due(): NudgeKind | null {
    if (shownThisLaunch || pending) return null;
    if (now() - state.lastShownAt < NUDGE_COOLDOWN_MS) return null;
    if (state.runs >= state.pro.nextAt && !deps.isPro()) return 'pro';
    const social = state.social;
    if (!social.done && state.runs >= social.nextAt && now() >= (social.notBefore ?? 0)) return 'social';
    return null;
  }

  function offer() {
    const kind = due();
    if (!kind) return;
    pending = kind;
    deps.notify({ kind, runs: state.runs });
  }

  return {
    /** Called for every trackTool ID; only finished tools count. */
    recordRun(tool: string) {
      if (!NUDGE_TOOL_IDS.has(tool)) return;
      state.runs += 1;
      save();
      offer();
    },
    /** The renderer put the reminder on screen. */
    shown(kind: NudgeKind, preview = false) {
      if (preview) return;
      if (pending === kind) pending = null;
      shownThisLaunch = true;
      state.lastShownAt = now();
      save();
      deps.track(`nudge_${kind}_shown`);
    },
    /** The renderer gave up waiting for an idle moment; try again after the next tool. */
    dropped(kind: NudgeKind) {
      if (pending === kind) pending = null;
    },
    action(kind: NudgeKind, action: NudgeAction, preview = false) {
      if (preview) return;
      if (kind === 'pro') {
        if (action !== 'upgrade' && action !== 'skip') return;
        // Opening pricing without subscribing waits like a skip.
        state.pro.skips += 1;
        state.pro.nextAt = state.runs + gapAt(PRO_GAPS, state.pro.skips);
        deps.track(action === 'upgrade' ? 'nudge_pro_upgrade' : 'nudge_pro_skip');
      } else {
        if (action === 'skip') {
          state.social.skips += 1;
          state.social.nextAt = state.runs + gapAt(SOCIAL_GAPS, state.social.skips);
          state.social.notBefore = now() + gapAt(SOCIAL_WAIT_DAYS, state.social.skips) * DAY;
          deps.track('nudge_social_skip');
        } else if (action === 'already' || (SOCIAL_LINKS as readonly string[]).includes(action)) {
          state.social.done = true;
          deps.track(`nudge_social_${action}`);
        } else return;
      }
      save();
    },
    /** Development preview: SMOOTHY_NUDGE_PREVIEW=pro|social shows one without changing the schedule. */
    preview(kind: NudgeKind) { deps.notify({ kind, runs: state.runs, preview: true }); },
    snapshot: () => ({ ...state, pro: { ...state.pro }, social: { ...state.social } }),
    /** For the Dev tab: the schedule plus whether a reminder could show right now. */
    status() {
      return { ...this.snapshot(), shownThisLaunch, cooldownMs: Math.max(0, state.lastShownAt + NUDGE_COOLDOWN_MS - now()) };
    },
  };
}
