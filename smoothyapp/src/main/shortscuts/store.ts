import { randomUUID } from 'crypto';
import { isShortsCutColor, isShortsCutIcon } from '../../shared/shortscuts-icons';
import {
  DEFAULT_SERVER_PORT,
  MAX_DECK_ITEMS,
  MAX_FOLDERS,
  MAX_MULTI_STEPS,
  MAX_PRESET_BYTES,
  PHONE_COLUMNS,
  TABLET_COLUMNS,
  SHORTSCUT_KINDS,
  type ShortsCutEdge,
  type ShortsCutFolder,
  type ShortsCutItem,
  type ShortsCutKeyframe,
  type ShortsCutKind,
  type ShortsCutPreset,
  type ShortsCutPresetComponent,
  type ShortsCutPresetProperty,
  type ShortsCutValue,
  type ShortsCutsConfig,
  type ShortsCutsLayout,
} from './types';

interface PreferencesStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export const SHORTSCUTS_STORE_KEY = 'shortscuts';

const EDGES: ShortsCutEdge[] = ['start', 'end', 'both'];
const DEFAULT_DECK: ShortsCutItem[] = [
  {
    id: 'default-transition-video',
    label: 'Video transition',
    kind: 'video-transition',
    target: '',
    edge: 'end',
    duration: 0.5,
    shortcut: 'CommandOrControl+Alt+1',
  },
  {
    id: 'default-transition-audio',
    label: 'Audio transition',
    kind: 'audio-transition',
    target: '',
    edge: 'end',
    duration: 0.5,
    shortcut: 'CommandOrControl+Alt+2',
  },
  {
    id: 'default-effect-crop',
    label: 'Crop',
    kind: 'video-effect',
    target: 'Crop',
    shortcut: 'CommandOrControl+Alt+3',
  },
  {
    id: 'default-effect-gaussian-blur',
    label: 'Gaussian Blur',
    kind: 'video-effect',
    target: 'Gaussian Blur',
    shortcut: 'CommandOrControl+Alt+4',
  },
  {
    id: 'default-effect-mosaic',
    label: 'Mosaic',
    kind: 'video-effect',
    target: 'Mosaic',
    shortcut: 'CommandOrControl+Alt+5',
  },
  {
    id: 'default-effect-mirror',
    label: 'Mirror',
    kind: 'video-effect',
    target: 'Mirror',
    shortcut: 'CommandOrControl+Alt+6',
  },
];

function defaultLayout(): ShortsCutsLayout {
  return { phoneColumns: PHONE_COLUMNS.default, tabletColumns: TABLET_COLUMNS.default };
}

export function defaultShortsCutsConfig(): ShortsCutsConfig {
  return {
    deck: DEFAULT_DECK.map((item) => ({ ...item })),
    folders: [],
    layout: defaultLayout(),
    serverEnabled: false,
    serverPort: DEFAULT_SERVER_PORT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value: unknown, max: number): string {
  return text(value).slice(0, max);
}

function kind(value: unknown): ShortsCutKind | null {
  return SHORTSCUT_KINDS.includes(value as ShortsCutKind) ? (value as ShortsCutKind) : null;
}

function edge(value: unknown): ShortsCutEdge {
  return EDGES.includes(value as ShortsCutEdge) ? (value as ShortsCutEdge) : 'end';
}

function duration(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(10, Math.max(0.05, Math.round(numeric * 100) / 100));
}

function shortcut(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9+,_\-.\s]{1,60}$/.test(raw)) return undefined;
  return raw.replace(/\s+/g, '');
}

function presetValue(value: unknown): ShortsCutValue | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return value.slice(0, 16) as number[];
  }
  return undefined;
}

function presetKeyframes(value: unknown): ShortsCutKeyframe[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keyframes: ShortsCutKeyframe[] = [];
  for (const entry of value.slice(0, 1000)) {
    if (!isRecord(entry)) continue;
    const time = Number(entry.time);
    const sanitized = presetValue(entry.value);
    if (!Number.isFinite(time) || sanitized === undefined) continue;
    keyframes.push({ time, value: sanitized });
  }
  return keyframes.length ? keyframes : undefined;
}

function presetProperty(value: unknown): ShortsCutPresetProperty | null {
  if (!isRecord(value)) return null;
  const name = boundedText(value.name, 160);
  const sanitized = presetValue(value.value);
  if (!name || sanitized === undefined) return null;
  const keyframes = presetKeyframes(value.keyframes);
  return { name, value: sanitized, ...(keyframes ? { keyframes } : {}) };
}

function presetComponent(value: unknown): ShortsCutPresetComponent | null {
  if (!isRecord(value)) return null;
  const matchName = boundedText(value.matchName, 160);
  const displayName = boundedText(value.displayName, 160);
  if (!matchName) return null;
  const properties = Array.isArray(value.properties)
    ? value.properties.map(presetProperty).filter((entry): entry is ShortsCutPresetProperty => Boolean(entry)).slice(0, 250)
    : [];
  return { matchName, displayName: displayName || matchName, properties };
}

function preset(value: unknown): ShortsCutPreset | undefined {
  if (!isRecord(value)) return undefined;
  const mediaType = value.mediaType === 'audio' ? 'audio' : 'video';
  const components = Array.isArray(value.components)
    ? value.components.map(presetComponent).filter((entry): entry is ShortsCutPresetComponent => Boolean(entry)).slice(0, 80)
    : [];
  if (!components.length) return undefined;
  const sanitized: ShortsCutPreset = {
    mediaType,
    components,
    ...(value.animated === true ? { animated: true } : {}),
    ...(value.source === 'premiere' || value.source === 'captured' ? { source: value.source } : {}),
  };
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_PRESET_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return sanitized;
}

function deckItem(value: unknown, index: number, usedIds: Set<string>): ShortsCutItem | null {
  if (!isRecord(value)) return null;
  const itemKind = kind(value.kind);
  if (!itemKind) return null;
  const label = boundedText(value.label, 60);
  if (!label) return null;
  const target = itemKind === 'multi' ? '' : boundedText(value.target, 160);
  if ((itemKind === 'video-effect' || itemKind === 'audio-effect') && !target) return null;
  const sanitizedPreset = itemKind === 'preset' ? preset(value.preset) : undefined;
  if (itemKind === 'preset' && !sanitizedPreset) return null;
  let id = boundedText(value.id, 80) || randomUUID();
  if (usedIds.has(id)) id = `${id}-${index}`;
  usedIds.add(id);
  const steps = itemKind === 'multi' && Array.isArray(value.steps)
    ? value.steps.map((step) => boundedText(step, 80)).filter(Boolean).slice(0, MAX_MULTI_STEPS)
    : undefined;
  const folderId = boundedText(value.folderId, 80);
  return {
    id,
    label,
    kind: itemKind,
    target,
    shortcut: shortcut(value.shortcut),
    edge: itemKind.endsWith('transition') ? edge(value.edge) : undefined,
    duration: itemKind.endsWith('transition') ? duration(value.duration) : undefined,
    preset: sanitizedPreset,
    icon: isShortsCutIcon(value.icon) ? value.icon : undefined,
    color: isShortsCutColor(value.color) ? value.color : undefined,
    folderId: folderId || undefined,
    steps,
  };
}

function folder(value: unknown, usedIds: Set<string>): ShortsCutFolder | null {
  if (!isRecord(value)) return null;
  const label = boundedText(value.label, 40);
  if (!label) return null;
  let id = boundedText(value.id, 80) || randomUUID();
  if (usedIds.has(id)) id = `${id}-${usedIds.size}`;
  usedIds.add(id);
  return {
    id,
    label,
    icon: isShortsCutIcon(value.icon) ? value.icon : undefined,
    color: isShortsCutColor(value.color) ? value.color : undefined,
  };
}

function columns(value: unknown, range: { min: number; max: number; default: number }): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return range.default;
  return Math.min(range.max, Math.max(range.min, numeric));
}

function layout(value: unknown): ShortsCutsLayout {
  const record = isRecord(value) ? value : {};
  return {
    phoneColumns: columns(record.phoneColumns, PHONE_COLUMNS),
    tabletColumns: columns(record.tabletColumns, TABLET_COLUMNS),
  };
}

function folders(value: unknown): ShortsCutFolder[] {
  const usedIds = new Set<string>();
  return Array.isArray(value)
    ? value.slice(0, MAX_FOLDERS).map((entry) => folder(entry, usedIds)).filter((entry): entry is ShortsCutFolder => Boolean(entry))
    : [];
}

/** Drops links to missing folders or keys so a stale reference never breaks the deck. */
function linkDeck(deck: ShortsCutItem[], folderList: ShortsCutFolder[]): ShortsCutItem[] {
  const folderIds = new Set(folderList.map((entry) => entry.id));
  const stepIds = new Set(deck.filter((item) => item.kind !== 'multi').map((item) => item.id));
  return deck.map((item) => ({
    ...item,
    folderId: item.folderId && folderIds.has(item.folderId) ? item.folderId : undefined,
    steps: item.kind === 'multi' ? (item.steps || []).filter((step) => stepIds.has(step)) : undefined,
  }));
}

/** Unknown/corrupt fields fall back to safe values; the deck can intentionally be empty. */
export function sanitizeShortsCutsConfig(value: unknown): ShortsCutsConfig {
  const record = isRecord(value) ? value : {};
  const usedIds = new Set<string>();
  const deck = Array.isArray(record.deck)
    ? record.deck
        .slice(0, MAX_DECK_ITEMS)
        .map((item, index) => deckItem(item, index, usedIds))
        .filter((item): item is ShortsCutItem => Boolean(item))
    : [];
  const port = Number(record.serverPort);
  const folderList = folders(record.folders);
  return {
    deck: linkDeck(deck, folderList),
    folders: folderList,
    layout: layout(record.layout),
    serverEnabled: record.serverEnabled === true,
    serverPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_SERVER_PORT,
  };
}

/** Throws for invalid edits so the UI can explain what is wrong. */
export function validateShortsCutsConfig(value: unknown): ShortsCutsConfig {
  if (!isRecord(value)) throw new Error('ShortsCuts settings are invalid.');
  if (!Array.isArray(value.deck)) throw new Error('The ShortsCuts deck is invalid.');
  if (value.deck.length > MAX_DECK_ITEMS) throw new Error('The deck is too large. Remove a few keys first.');
  const usedIds = new Set<string>();
  const usedShortcuts = new Map<string, string>();
  const deck: ShortsCutItem[] = [];
  for (let index = 0; index < value.deck.length; index++) {
    const raw = value.deck[index];
    const item = deckItem(raw, index, usedIds);
    if (!item) throw new Error(`Shortcut ${index + 1} is invalid. Remove it or choose an effect again.`);
    if (item.shortcut) {
      const key = item.shortcut.toLowerCase();
      if (usedShortcuts.has(key)) throw new Error(`${item.shortcut} is already assigned to “${usedShortcuts.get(key)}”.`);
      usedShortcuts.set(key, item.label);
    }
    deck.push(item);
  }
  if (Array.isArray(value.folders) && value.folders.length > MAX_FOLDERS) throw new Error('There are too many folders.');
  const folderList = folders(value.folders);
  const plainIds = new Set(deck.filter((item) => item.kind !== 'multi').map((item) => item.id));
  for (const item of deck) {
    if (item.kind !== 'multi') continue;
    const steps = (item.steps || []).filter((step) => plainIds.has(step));
    if (!steps.length) throw new Error(`“${item.label}” needs at least one effect, transition or preset.`);
    item.steps = steps;
  }
  const port = Number(value.serverPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
  return {
    deck: linkDeck(deck, folderList),
    folders: folderList,
    layout: layout(value.layout),
    serverEnabled: value.serverEnabled === true,
    serverPort: port,
  };
}

/** Applies a deck save (array or `{ deck, folders, layout }`) on top of the current config. */
export function mergeDeck(config: ShortsCutsConfig, value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { ...config, deck: value };
  if (!isRecord(value)) return { ...config, deck: null };
  return {
    ...config,
    deck: value.deck,
    folders: value.folders === undefined ? config.folders : value.folders,
    layout: value.layout === undefined ? config.layout : value.layout,
  };
}

export function createShortsCutsStore(
  store: PreferencesStore,
  changed: (config: ShortsCutsConfig) => void = () => {}
) {
  let config: ShortsCutsConfig;
  const saved = store.get(SHORTSCUTS_STORE_KEY);
  config = saved === undefined ? defaultShortsCutsConfig() : sanitizeShortsCutsConfig(saved);

  const persist = (next: ShortsCutsConfig) => {
    config = next;
    store.set(SHORTSCUTS_STORE_KEY, next);
    try {
      changed(next);
    } catch {
      // A closed renderer must not undo saved settings.
    }
    return config;
  };

  return {
    get: (): ShortsCutsConfig => config,
    /** Accepts a deck array, or `{ deck, folders?, layout? }` to save the remote layout too. */
    saveDeck(value: unknown) {
      return persist(validateShortsCutsConfig(mergeDeck(config, value)));
    },
    setServer(value: unknown) {
      if (!isRecord(value)) throw new Error('Choose whether the phone remote is enabled.');
      const next = validateShortsCutsConfig({
        ...config,
        serverEnabled: value.enabled === true,
        serverPort: value.port ?? config.serverPort,
      });
      return persist(next);
    },
  };
}
