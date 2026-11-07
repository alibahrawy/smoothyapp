export const SHORTSCUT_KINDS = [
  'video-effect',
  'audio-effect',
  'video-transition',
  'audio-transition',
  'preset',
  'multi',
] as const;

export type ShortsCutKind = (typeof SHORTSCUT_KINDS)[number];
export type ShortsCutEdge = 'start' | 'end' | 'both';
export type ShortsCutValue = number | boolean | string | number[];

export interface ShortsCutKeyframe {
  /** Ticks relative to the preset’s original clip. */
  time: number;
  value: ShortsCutValue;
}

export interface ShortsCutPresetProperty {
  name: string;
  value: ShortsCutValue;
  keyframes?: ShortsCutKeyframe[];
}

export interface ShortsCutPresetComponent {
  matchName: string;
  displayName: string;
  properties: ShortsCutPresetProperty[];
}

export interface ShortsCutPreset {
  mediaType: 'video' | 'audio';
  components: ShortsCutPresetComponent[];
  animated?: boolean;
  source?: 'captured' | 'premiere';
}

export interface ShortsCutItem {
  id: string;
  label: string;
  kind: ShortsCutKind;
  /** QE effect/transition name. Empty means Premiere's default transition. */
  target: string;
  shortcut?: string;
  edge?: ShortsCutEdge;
  duration?: number;
  preset?: ShortsCutPreset;
  /** Icon id from SHORTSCUT_ICONS; empty means guessed from the name. */
  icon?: string;
  /** Colour id from SHORTSCUT_COLORS; empty means the kind's colour. */
  color?: string;
  /** Remote folder holding this key; empty means the top level. */
  folderId?: string;
  /** For `multi`: ids of other deck keys, applied in this order. */
  steps?: string[];
}

export interface ShortsCutFolder {
  id: string;
  label: string;
  icon?: string;
  color?: string;
}

export interface ShortsCutsLayout {
  /** Key columns on a phone-sized screen. */
  phoneColumns: number;
  /** Key columns on a tablet-sized screen. */
  tabletColumns: number;
}

export interface ShortsCutsConfig {
  deck: ShortsCutItem[];
  folders: ShortsCutFolder[];
  layout: ShortsCutsLayout;
  serverEnabled: boolean;
  serverPort: number;
}

export interface ShortsCutsCatalog {
  videoEffects: string[];
  audioEffects: string[];
  videoTransitions: string[];
  audioTransitions: string[];
}

export interface ShortsCutsApplyResult {
  success: boolean;
  applied?: number;
  failed?: number;
  message?: string;
  error?: string;
  details?: string[];
  nle?: string;
}

export interface ShortsCutsCapturedPreset {
  success: boolean;
  name?: string;
  mediaType?: 'video' | 'audio';
  components?: ShortsCutPresetComponent[];
  error?: string;
}

export interface ShortsCutsServerState {
  running: boolean;
  port: number | null;
  urls: string[];
  pageUrl: string | null;
  token: string | null;
  qrDataUrl: string | null;
  clients: number;
  lastAction: string | null;
  lastClientAt: number | null;
  error: string | null;
}

/** Not a product limit: only a guard against corrupt or runaway settings. */
export const MAX_DECK_ITEMS = 2000;
/** Keys that work without Smoothy Pro: the first six in deck order. Pro is unlimited. */
export const FREE_DECK_KEYS = 6;
export const MAX_FOLDERS = 500;
export const MAX_MULTI_STEPS = 16;
export const PHONE_COLUMNS = { min: 2, max: 5, default: 3 } as const;
export const TABLET_COLUMNS = { min: 3, max: 8, default: 5 } as const;
export const MAX_PRESET_BYTES = 512 * 1024;
export const DEFAULT_SERVER_PORT = 4789;
