import type { AppUpdater } from 'electron-updater';
import type Store from 'electron-store';

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'skipped' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error' | 'dev-build';
  version: string | null;
  percent: number;
  notes: string | null;
  notesLoading: boolean;
  error?: string;
};

/** Checking is automatic; downloading and restarting always require a user action. */
export function createUpdateService({ updater, store, packaged, configured = packaged, send, fetchNotes }: {
  updater: AppUpdater;
  store: Pick<Store, 'get' | 'set' | 'delete'>;
  packaged: boolean;
  configured?: boolean;
  send: (state: UpdateState) => void;
  fetchNotes: (version: string) => Promise<string | null>;
}) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  // This old marker treated an intentionally deferred restart as a broken update.
  store.delete('lastDownloadedUpdateVersion');

  // Local --dir packages have no app-update.yml. They must never call the release updater.
  const updatesEnabled = packaged && configured;
  let state: UpdateState = { status: updatesEnabled ? 'idle' : 'dev-build', version: null, percent: 0, notes: null, notesLoading: false };
  let checking = false;
  let manual = false;
  let downloadedVersion: string | null = null;
  const snapshot = () => ({ ...state });
  const publish = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; send(snapshot()); };
  const fail = (error: unknown) => publish({ status: 'error', error: error instanceof Error ? error.message : 'Update service unavailable' });

  updater.on('checking-for-update', () => publish({ status: 'checking', version: null, percent: 0, notes: null, notesLoading: false, error: undefined }));
  updater.on('update-available', info => {
    const skipped = !manual && store.get('skippedUpdateVersion') === info.version;
    publish({ status: skipped ? 'skipped' : 'available', version: info.version, percent: downloadedVersion === info.version ? 100 : 0, notes: null, notesLoading: true, error: undefined });
    void fetchNotes(info.version).catch(() => null).then(notes => {
      if (state.version === info.version) publish({ notes, notesLoading: false });
    });
  });
  updater.on('update-not-available', () => publish({ status: 'up-to-date', version: null, percent: 0, notes: null, notesLoading: false, error: undefined }));
  updater.on('download-progress', progress => {
    if (state.status === 'downloading') publish({ percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
  });
  updater.on('update-downloaded', info => {
    if (state.status !== 'downloading' || info.version !== state.version) return;
    downloadedVersion = info.version;
    publish({ status: 'downloaded', percent: 100, error: undefined });
  });
  updater.on('error', fail);

  async function check(userRequested = false) {
    if (!updatesEnabled) return snapshot();
    if (checking || ['downloading', 'downloaded', 'installing'].includes(state.status)) return snapshot();
    checking = true;
    manual = userRequested;
    try { await updater.checkForUpdates(); } catch (error) { fail(error); }
    finally { checking = false; manual = false; }
    return snapshot();
  }

  function skip(version: unknown) {
    if (typeof version !== 'string' || version !== state.version || !['available', 'downloaded', 'error'].includes(state.status)) {
      return { success: false, error: 'This update cannot be skipped right now.' };
    }
    store.set('skippedUpdateVersion', version);
    publish({ status: 'skipped', error: undefined });
    return { success: true };
  }

  async function install(version: unknown) {
    if (!updatesEnabled || typeof version !== 'string' || version !== state.version || !['available', 'skipped', 'downloaded', 'error'].includes(state.status)) {
      return { success: false, error: 'Check for updates and choose an available release first.' };
    }
    store.delete('skippedUpdateVersion');
    if (downloadedVersion === version) {
      publish({ status: 'installing', error: undefined });
      try { updater.quitAndInstall(false, true); } catch (error) { fail(error); return { success: false }; }
      return { success: true };
    }
    publish({ status: 'downloading', percent: 0, error: undefined });
    try {
      await updater.downloadUpdate();
      return { success: true };
    } catch (error) {
      fail(error);
      return { success: false };
    }
  }

  return { snapshot, check, skip, install };
}
