import { globalShortcut } from 'electron';
import type { ShortsCutItem } from './types';

export interface ShortcutRegistration {
  id: string;
  label: string;
  accelerator: string;
  registered: boolean;
  error?: string;
}

export interface ShortcutRegistrationResult {
  success: boolean;
  error?: string;
  registrations: ShortcutRegistration[];
}

type ActiveShortcut = { accelerator: string; item: ShortsCutItem };

/**
 * Owns every global accelerator. Registration is atomic: if one accelerator is
 * unavailable, the previous working set is restored so an edit cannot leave the
 * user with a half-working deck.
 */
export function createShortcutManager(onTrigger: (item: ShortsCutItem) => void) {
  let active = new Map<string, ActiveShortcut>();
  let registrations: ShortcutRegistration[] = [];
  let suspended = false;
  // Keys are only held system-wide while Premiere (or Smoothy) has focus, so a
  // deck shortcut never fires, or steals the key, in another app.
  let focusAllowed = true;

  function releaseGlobals() {
    for (const entry of active.values()) {
      try {
        globalShortcut.unregister(entry.accelerator);
      } catch {
        // Best effort.
      }
    }
  }

  function grabGlobals() {
    for (const [id, entry] of active) {
      let ok = false;
      try {
        ok = globalShortcut.register(entry.accelerator, () => onTrigger(entry.item));
      } catch {
        ok = false;
      }
      const row = registrations.find((item) => item.id === id);
      if (row) {
        row.registered = ok;
        row.error = ok ? undefined : `${entry.accelerator} was taken by another app.`;
      }
    }
  }

  function setFocusAllowed(allowed: boolean) {
    if (allowed === focusAllowed) return;
    focusAllowed = allowed;
    if (suspended) return;
    if (allowed) grabGlobals();
    else releaseGlobals();
  }

  const snapshot = () => registrations.map((entry) => ({ ...entry }));

  function unregisterAll() {
    for (const entry of active.values()) {
      try {
        globalShortcut.unregister(entry.accelerator);
      } catch {
        // Best effort while quitting.
      }
    }
    active.clear();
    registrations = [];
  }

  function register(deck: ShortsCutItem[]): ShortcutRegistrationResult {
    if (suspended) {
      registrations = [];
      return { success: true, registrations: [] };
    }
    const wanted = deck.filter((item) => item.shortcut);
    const previous = new Map(active);
    const previousRegistrations = snapshot();

    if (!wanted.length) {
      unregisterAll();
      return { success: true, registrations: [] };
    }

    unregisterAll();
    const failures: ShortcutRegistration[] = [];
    const next = new Map<string, ActiveShortcut>();
    const nextRegistrations: ShortcutRegistration[] = [];

    for (const item of wanted) {
      const accelerator = item.shortcut!;
      let registered = false;
      try {
        registered = globalShortcut.register(accelerator, () => onTrigger(item));
      } catch {
        registered = false;
      }
      const entry: ShortcutRegistration = {
        id: item.id,
        label: item.label,
        accelerator,
        registered,
      };
      if (registered) {
        next.set(item.id, { accelerator, item });
      } else {
        entry.error = `${accelerator} is already used by another app or is not supported on this system.`;
        failures.push(entry);
      }
      nextRegistrations.push(entry);
    }

    if (failures.length) {
      for (const entry of next.values()) {
        try {
          globalShortcut.unregister(entry.accelerator);
        } catch {
          // Ignore rollback failures.
        }
      }
      active = new Map();
      registrations = [];
      for (const [id, entry] of previous) {
        try {
          globalShortcut.register(entry.accelerator, () => onTrigger(entry.item));
          active.set(id, entry);
        } catch {
          // The previous shortcut was already working; keep going.
        }
      }
      registrations = previousRegistrations;
      if (!focusAllowed) releaseGlobals();
      return {
        success: false,
        error: failures.map((entry) => entry.error).join(' '),
        registrations: snapshot(),
      };
    }

    active = next;
    registrations = nextRegistrations;
    if (!focusAllowed) releaseGlobals();
    return { success: true, registrations: snapshot() };
  }

  function suspend() {
    if (suspended) return;
    unregisterAll();
    suspended = true;
  }

  function resume(deck: ShortsCutItem[]): ShortcutRegistrationResult {
    suspended = false;
    return register(deck);
  }

  return {
    register,
    unregisterAll,
    suspend,
    resume,
    setFocusAllowed,
    snapshot,
    isSuspended: () => suspended,
  };
}
