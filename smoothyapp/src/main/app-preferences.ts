import writing from '../shared/chat-writing.json';
interface PreferencesStore { get(key: string): unknown; set(key: string, value: unknown): void }
export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = typeof APPEARANCES[number];
const isAppearance = (value: unknown): value is Appearance => APPEARANCES.includes(value as Appearance);

/** Local cloud-tool preference; no account or network data. */
export function createAppPreferences(store: PreferencesStore, changed: () => void = () => {}, track: (id: string) => void = () => {}) {
  const read = () => {
    const saved = store.get('appPreferences') as any;
    return {
      studioEnabled: saved?.studioEnabled !== false,
      // Light, Dark or follow the operating system (default).
      appearance: isAppearance(saved?.appearance) ? saved.appearance : 'system' as Appearance,
      // The retired Natural writing preset does not become a custom system prompt.
      chatPromptVersion: 2,
      chatWritingPrompt: saved?.chatPromptVersion === 2 && typeof saved?.chatWritingPrompt === 'string' && saved.chatWritingPrompt.length <= writing.maxPromptChars ? saved.chatWritingPrompt.trim() : writing.defaultPrompt,
    };
  };
  const snapshot = read;
  const update = (value: ReturnType<typeof read>) => { store.set('appPreferences', value); try { changed(); } catch { /* A closed renderer must not undo saved preferences. */ } return snapshot(); };
  return {
    snapshot,
    setStudioEnabled(value: unknown) {
      if (typeof value !== 'boolean') throw new Error('Choose whether Studio AI is enabled.');
      return update({ ...read(), studioEnabled: value });
    },
    setAppearance(value: unknown) {
      if (!isAppearance(value)) throw new Error('Choose Light, Dark or Match system.');
      const before = read();
      if (before.appearance === value) return before;
      const result = update({ ...before, appearance: value });
      try { track(`appearance_${value}`); } catch { /* Analytics never blocks a preference. */ }
      return result;
    },
    saveChatWritingPrompt(value: unknown) {
      if (typeof value !== 'string' || value.length > writing.maxPromptChars) throw new Error('System prompt must contain at most 4,000 characters.');
      const before = read(), prompt = value.trim();
      if (prompt === before.chatWritingPrompt) return before;
      const result = update({ ...before, chatWritingPrompt: prompt });
      try { track('chat_writing_save'); } catch { /* Analytics never blocks a save. */ }
      return result;
    },
    resetChatWritingPrompt() { return this.saveChatWritingPrompt(writing.defaultPrompt); },
  };
}

let enabled = () => true;
let controller: AbortController | null = null;
export function configureStudioPreference(getEnabled: () => boolean) { enabled = getEnabled; }
export function assertStudioEnabled() {
  if (!enabled()) throw new Error('Studio AI is turned off. Enable it in Settings to use cloud tools.');
}
export function studioSignal() { assertStudioEnabled(); controller ??= new AbortController(); return controller.signal; }
export function studioPreferenceChanged() {
  controller?.abort();
  controller = null;
}
