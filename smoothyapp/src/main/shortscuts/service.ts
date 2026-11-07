import { randomUUID } from 'crypto';
import { resolveShortsCutIcon, shortsCutColorValue } from '../../shared/shortscuts-icons';
import {
  createShortsCutsStore,
  mergeDeck,
  sanitizeShortsCutsConfig,
  validateShortsCutsConfig,
} from './store';
import { createShortcutManager, type ShortcutRegistration } from './shortcuts';
import { getFrontmostAppName, shortcutsAllowedFor } from './frontmost';
import { ShortsCutsServer, type ShortsCutsApplyResponse, type ShortsCutsMobileState } from './server';
import {
  FREE_DECK_KEYS,
  MAX_DECK_ITEMS,
  type ShortsCutItem,
  type ShortsCutsApplyResult,
  type ShortsCutsCapturedPreset,
  type ShortsCutsCatalog,
  type ShortsCutsConfig,
  type ShortsCutsServerState,
} from './types';

interface PreferencesStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ShortsCutsState {
  config: ShortsCutsConfig;
  server: ShortsCutsServerState;
  shortcuts: ShortcutRegistration[];
  connected: boolean;
  editor: string;
  busy: boolean;
  /** Always false: ShortsCuts works on every plan, with FREE_DECK_KEYS keys without Pro. */
  locked: boolean;
  /** True when the account has Smoothy Pro (unlimited keys). */
  pro: boolean;
  /** How many keys work without Pro. Keys past this stay saved but inactive. */
  freeKeys: number;
  lastResult: {
    success: boolean;
    message: string;
    source: 'keyboard' | 'phone' | 'panel';
    at: number;
  } | null;
}

interface ServiceOptions {
  store: PreferencesStore;
  applyToPremiere: (item: ShortsCutItem) => Promise<ShortsCutsApplyResult>;
  readCatalog: () => Promise<ShortsCutsCatalog>;
  capturePreset: () => Promise<ShortsCutsCapturedPreset>;
  connected: () => boolean;
  editor: () => string;
  /** Smoothy Pro: unlimited keys. Without it only the first FREE_DECK_KEYS keys work. */
  allowed: () => boolean;
  track: (id: string) => void;
  onState: (state: ShortsCutsState) => void;
}

function publicItem(item: ShortsCutItem) {
  return {
    kind: item.kind,
    target: item.target,
    edge: item.edge,
    duration: item.duration,
    preset: item.preset,
  };
}

const FREE_LIMIT = `The free plan includes ${FREE_DECK_KEYS} ShortsCuts keys. Upgrade to Smoothy Pro for unlimited keys.`;

function trackId(item: ShortsCutItem): string {
  if (item.kind === 'multi') return 'shortscuts_multi';
  if (item.kind === 'preset') return 'shortscuts_preset';
  if (item.kind.endsWith('transition')) return 'shortscuts_transition';
  return 'shortscuts_effect';
}

export function createShortsCutsService(options: ServiceOptions) {
  let busy = false;
  let focusTimer: ReturnType<typeof setInterval> | null = null;
  let focusChecking = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let remoteSince = Date.now();
  let lastAllowed = true;

  /** Keys that work on the current plan: all of them with Pro, otherwise the first FREE_DECK_KEYS. */
  function activeDeck(deck: ShortsCutItem[] = store.get().deck): ShortsCutItem[] {
    return options.allowed() ? deck : deck.slice(0, FREE_DECK_KEYS);
  }
  let lastResult: ShortsCutsState['lastResult'] = null;
  const store = createShortsCutsStore(options.store, () => notify());
  let manager = createShortcutManager((item) => {
    void apply(item.id, 'keyboard');
  });
  const server = new ShortsCutsServer({
    getState: (): ShortsCutsMobileState => ({
      connected: options.connected() && options.editor() === 'premiere',
      editor: options.editor(),
      deck: activeDeck().map((item) => ({
        id: item.id,
        label: item.label,
        kind: item.kind,
        icon: resolveShortsCutIcon(item),
        color: shortsCutColorValue(item.color, item.kind),
        folderId: item.folderId || null,
      })),
      folders: store.get().folders.map((folder) => ({
        id: folder.id,
        label: folder.label,
        icon: resolveShortsCutIcon({ ...folder, kind: 'folder' }),
        color: shortsCutColorValue(folder.color, 'folder'),
      })),
      layout: store.get().layout,
      lastAction: lastResult?.message || null,
    }),
    apply: (id) => apply(id, 'phone'),
    onAction: () => notify(),
  });

  function state(): ShortsCutsState {
    return {
      config: store.get(),
      server: server.state(),
      shortcuts: manager.snapshot(),
      connected: options.connected(),
      editor: options.editor(),
      busy,
      locked: false,
      pro: options.allowed(),
      freeKeys: FREE_DECK_KEYS,
      lastResult,
    };
  }

  function notify() {
    try {
      options.onState(state());
    } catch {
      // The desktop window may be closed while the phone remote keeps running.
    }
  }

  function setLast(success: boolean, message: string, source: 'keyboard' | 'phone' | 'panel') {
    lastResult = { success, message, source, at: Date.now() };
    notify();
  }

  async function apply(id: string, source: 'keyboard' | 'phone' | 'panel'): Promise<ShortsCutsApplyResponse> {
    if (busy) return { success: false, error: 'Wait for the current ShortsCut to finish.' };
    const item = store.get().deck.find((entry) => entry.id === id);
    if (!item) return { success: false, error: 'That shortcut is no longer in the deck.' };
    if (!activeDeck().some((entry) => entry.id === id)) return { success: false, error: FREE_LIMIT };
    if (options.editor() !== 'premiere') {
      return { success: false, error: 'ShortsCuts works with Premiere Pro. Switch the editor to Premiere first.' };
    }
    if (!options.connected()) {
      return { success: false, error: 'Connect Premiere and open a sequence first.' };
    }
    busy = true;
    notify();
    try {
      const result = item.kind === 'multi' ? await applySteps(item) : await options.applyToPremiere(item);
      if (result.success) {
        try {
          options.track(trackId(item));
        } catch {
          // Analytics never blocks the edit.
        }
        const message = result.message || `Applied ${item.label}.`;
        setLast(true, message, source);
        return { success: true, message };
      }
      const error = [result.error || 'Premiere did not apply that shortcut.', ...(result.details || [])].join(' ');
      setLast(false, error, source);
      return { success: false, error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Premiere did not apply that shortcut.';
      setLast(false, message, source);
      return { success: false, error: message };
    } finally {
      busy = false;
      notify();
    }
  }

  /** Runs a multi-action's keys in order; one failed step does not stop the rest. */
  async function applySteps(item: ShortsCutItem): Promise<ShortsCutsApplyResult> {
    const deck = store.get().deck;
    const steps = (item.steps || [])
      .map((id) => deck.find((entry) => entry.id === id))
      .filter((entry): entry is ShortsCutItem => Boolean(entry) && entry!.kind !== 'multi');
    if (!steps.length) return { success: false, error: `“${item.label}” has no actions. Add some on your computer.` };
    const failed: string[] = [];
    let applied = 0;
    for (const step of steps) {
      try {
        const result = await options.applyToPremiere(step);
        if (result.success) applied++;
        else failed.push(`${step.label}: ${result.error || 'not applied'}`);
      } catch (error) {
        failed.push(`${step.label}: ${error instanceof Error ? error.message : 'not applied'}`);
      }
    }
    if (!applied) return { success: false, error: `${item.label} did not apply.`, details: failed };
    return {
      success: true,
      message: failed.length
        ? `Applied ${applied} of ${steps.length} in ${item.label}. ${failed.join(' ')}`
        : `Applied ${item.label} (${applied} action${applied === 1 ? '' : 's'}).`,
    };
  }

  // Keep deck keys active only while Premiere (or Smoothy) is in front.
  function startFocusWatch() {
    if (focusTimer || process.platform !== 'darwin') return;
    const check = async () => {
      if (focusChecking) return;
      focusChecking = true;
      try {
        manager.setFocusAllowed(shortcutsAllowedFor(await getFrontmostAppName()));
      } finally {
        focusChecking = false;
      }
    };
    focusTimer = setInterval(() => void check(), 800);
    focusTimer.unref?.();
    void check();
  }

  // The phone remote listens on the local network, so switch it off after two
  // idle hours instead of leaving it open indefinitely.
  const REMOTE_IDLE_MS = 2 * 60 * 60 * 1000;
  /** Without Pro the deck may not grow past FREE_DECK_KEYS (a downgraded deck can still shrink or be edited). */
  function checkFreeLimit(nextLength: number) {
    if (options.allowed()) return;
    if (nextLength > FREE_DECK_KEYS && nextLength > store.get().deck.length) throw new Error(FREE_LIMIT);
  }

  /** Registers the keys the current plan includes (sign-in, upgrade, grace expiry). */
  function applyEntitlement() {
    lastAllowed = options.allowed();
    const result = manager.register(activeDeck());
    if (!result.success) console.warn('[ShortsCuts] Some shortcuts could not be registered:', result.error);
    if (store.get().serverEnabled && !server.running) {
      remoteSince = Date.now();
      void server.start(store.get().serverPort).then(() => notify()).catch((error) => {
        console.error('[ShortsCuts] Could not start the phone remote:', error);
        notify();
      });
    }
    notify();
  }

  function startIdleWatch() {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      if (options.allowed() !== lastAllowed) applyEntitlement();
      if (!server.running) return;
      const last = Math.max(server.state().lastClientAt || 0, remoteSince);
      if (Date.now() - last < REMOTE_IDLE_MS) return;
      server.stop();
      store.setServer({ enabled: false, port: store.get().serverPort });
      notify();
    }, 60_000);
    idleTimer.unref?.();
  }

  return {
    init() {
      startFocusWatch();
      startIdleWatch();
      applyEntitlement();
    },

    /** Call after the signed-in plan may have changed. */
    refreshEntitlement: applyEntitlement,

    dispose() {
      if (focusTimer) clearInterval(focusTimer);
      focusTimer = null;
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      manager.unregisterAll();
      server.stop();
    },

    state,

    notify,

    async saveDeck(value: unknown): Promise<ShortsCutsState> {
      const previous = new Set(store.get().deck.map((item) => item.id));
      const next = validateShortsCutsConfig(mergeDeck(store.get(), value));
      checkFreeLimit(next.deck.length);
      const registration = manager.register(activeDeck(next.deck));
      if (!registration.success) throw new Error(registration.error || 'Those keyboard shortcuts are not available.');
      store.saveDeck(next);
      // One event per key that this successful save added. Edits, reorders,
      // folders, layout changes and removals are configuration and add none.
      for (const item of next.deck) {
        if (previous.has(item.id)) continue;
        try {
          options.track('shortscuts_key_add');
        } catch {
          // Analytics never blocks saving the deck.
        }
      }
      notify();
      return state();
    },

    async setServer(value: unknown): Promise<ShortsCutsState> {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const enabled = record.enabled === true;
      const port = Number(record.port ?? store.get().serverPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
      if (enabled) {
        if (server.running && server.port === port) {
          store.setServer({ enabled: true, port });
          notify();
          return state();
        }
        await server.start(port);
        remoteSince = Date.now();
      } else {
        server.stop();
      }
      store.setServer({ enabled, port });
      notify();
      return state();
    },

    async rotateToken(): Promise<ShortsCutsState> {
      await server.rotateToken();
      notify();
      return state();
    },

    async catalog(): Promise<ShortsCutsCatalog> {
      if (options.editor() !== 'premiere') throw new Error('Switch the editor to Premiere and connect the panel to load effects.');
      if (!options.connected()) throw new Error('Connect Premiere and open a sequence first.');
      const catalog = await options.readCatalog();
      if ((catalog as any).success === false) throw new Error((catalog as any).error || 'Premiere could not list effects.');
      return catalog;
    },

    setCapturing(value: unknown): ShortsCutsState {
      if (value === true) manager.suspend();
      else manager.resume(activeDeck());
      notify();
      return state();
    },

    async capturePreset(): Promise<ShortsCutsState> {
      if (busy) throw new Error('Wait for the current ShortsCut to finish.');
      if (options.editor() !== 'premiere') throw new Error('Switch the editor to Premiere first.');
      if (!options.connected()) throw new Error('Connect Premiere and select a clip first.');
      if (store.get().deck.length >= MAX_DECK_ITEMS) throw new Error('The deck is too large. Remove a few keys first.');
      checkFreeLimit(store.get().deck.length + 1);
      busy = true;
      notify();
      try {
        const captured = await options.capturePreset();
        if (!captured.success || !captured.components?.length) {
          throw new Error(captured.error || 'Select a clip with at least one effect to capture a preset.');
        }
        const label = `Preset · ${(captured.name || 'Selected clip').slice(0, 48)}`;
        const item: ShortsCutItem = {
          id: randomUUID(),
          label,
          kind: 'preset',
          target: '',
          preset: { mediaType: captured.mediaType || 'video', components: captured.components },
        };
        const nextDeck = [...store.get().deck, item];
        const registration = manager.register(activeDeck(nextDeck));
        if (!registration.success) throw new Error(registration.error || 'Those keyboard shortcuts are not available.');
        store.saveDeck(nextDeck);
        try {
          options.track('shortscuts_preset_save');
        } catch {
          // Analytics never blocks saving a preset.
        }
        setLast(true, `Captured ${label}.`, 'panel');
        return state();
      } finally {
        busy = false;
        notify();
      }
    },

    async applyFromPanel(id: string): Promise<ShortsCutsApplyResponse> {
      return apply(id, 'panel');
    },

    sanitize: sanitizeShortsCutsConfig,
  };
}
