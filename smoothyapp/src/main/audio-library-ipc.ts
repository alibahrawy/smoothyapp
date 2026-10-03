import { app, ipcMain, dialog, shell, protocol, net, type BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AudioLibrary } from './audio-library';
import { AudioArchive } from './audio-archive';
import { AudioFavorites } from './audio-favorites';

protocol.registerSchemesAsPrivileged([{ scheme: 'smoothy-audio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
export async function registerAudioLibrary(deps: {
  store: { get(key: string): unknown; set(key: string, value: unknown): void };
  window: () => BrowserWindow | null; connected: () => boolean; importToPremiere: (filePath: string) => Promise<any>;
  archive?: AudioArchive;
}) {
  const library = new AudioLibrary(path.join(app.getPath('music'), 'SmoothyEdit Audio Library'));
  await library.load();
  const archive = deps.archive || new AudioArchive(app.getPath('userData'));
  const community = new AudioFavorites(deps.store, () => deps.window()?.webContents.send('audio-community-changed', community.snapshot()));
  const communityTimer = setInterval(() => { void community.sync(); void community.refresh(); }, 5 * 60000);
  communityTimer.unref();
  if (community.snapshot().pending) void community.sync();
  let download: { controller: AbortController; committed: boolean } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const folder = () => String(deps.store.get('audioWatchFolder') || app.getPath('downloads'));
  const notify = () => deps.window()?.webContents.send('audio-library-changed', library.snapshot());
  const stop = () => { clearInterval(timer); timer = undefined; library.stop(); };
  const result = async (action: () => Promise<any>) => {
    try { return { success: true, ...(await action()) }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'The audio action failed. Please retry.' }; }
  };
  protocol.handle('smoothy-audio', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'archive' && /^\/[A-Za-z0-9_-]{20,100}$/.test(url.pathname)) {
        return await archive.preview(url.pathname.slice(1), request.signal || new AbortController().signal, new Headers(request.headers).get('range') || undefined);
      }
      if (url.hostname !== 'library' || !/^\/[0-9a-f-]{36}$/.test(url.pathname)) return new Response('', { status: 404, headers: { 'cache-control': 'no-store' } });
      const filePath = await library.file(url.pathname.slice(1));
      return net.fetch(pathToFileURL(filePath).href, { headers: request.headers });
    } catch { return new Response('', { status: 404, headers: { 'cache-control': 'no-store' } }); }
  });
  ipcMain.handle('audio-library-state', () => ({ success: true, ...library.snapshot(), watchFolder: library.watchFolder || folder() }));
  ipcMain.handle('audio-community-state', () => { void community.refresh(); return { success: true, ...community.snapshot() }; });
  ipcMain.handle('audio-favorite-sharing', (_, enabled) => result(async () => community.setSharing(enabled)));
  ipcMain.handle('audio-favorite-set', (_, input) => result(async () => {
    if (typeof input?.active !== 'boolean') throw new Error('Choose a favorite state.');
    if (typeof input?.id === 'string' && input.id.startsWith('local:')) {
      await library.file(input.id.slice(6));
    } else await archive.track(input?.id);
    return community.set(input.id, input.active);
  }));
  ipcMain.handle('audio-archive-search', (_, input) => result(() => archive.search(input, community.snapshot())));
  ipcMain.handle('audio-archive-download', (_, input) => result(async () => {
    if (download) throw new Error('Wait for the current audio download to finish.');
    if (input?.premiere && !deps.connected()) throw new Error('Connect Premiere before sending audio.');
    const job = { controller: new AbortController(), committed: false }; download = job;
    let temporary = '';
    try {
      const track = await archive.track(input?.id);
      job.controller.signal.throwIfAborted();
      const progress = (received: number, total: number, phase = 'downloading') => deps.window()?.webContents.send('audio-archive-progress', { id: track.id, received, total, phase });
      temporary = await fs.mkdtemp(path.join(app.getPath('temp'), 'smoothy-audio-'));
      const filePath = path.join(temporary, 'track.mp3');
      await archive.download(track.id, filePath, job.controller.signal, progress);
      progress(0, 0, 'validating');
      const saved = await library.keepArchive(filePath, track.title, track.id, job.controller.signal, track);
      job.committed = true; notify();
      if (input?.premiere) {
        progress(0, 0, 'importing');
        const imported = await deps.importToPremiere(await library.file(saved.id));
        if (!imported?.success) throw new Error('MP3 saved in your library. ' + (imported?.error || 'Premiere could not import it. You can retry from Track details.'));
      }
      return { ...library.snapshot(), savedId: saved.id, imported: Boolean(input?.premiere) };
    } catch (error) {
      if (job.controller.signal.aborted) return { canceled: true };
      throw error;
    } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); download = undefined; }
  }));
  ipcMain.handle('audio-archive-cancel', () => { if (download && !download.committed) download.controller.abort(); return { success: true }; });
  ipcMain.handle('audio-library-open', () => result(async () => {
    stop(); await library.start(folder());
    timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try { if (await library.poll()) notify(); }
      catch { stop(); deps.window()?.webContents.send('audio-library-changed', { ...library.snapshot(), error: 'Could not read the download folder. Choose a folder and start again.' }); }
      finally { polling = false; }
    }, 2000);
    try { await shell.openExternal('https://studio.youtube.com/channel/UC/music'); }
    catch (error) { stop(); throw error; }
    return library.snapshot();
  }));
  ipcMain.handle('audio-library-stop', () => { stop(); notify(); return { success: true }; });
  ipcMain.handle('audio-library-select-folder', () => result(async () => {
    const window = deps.window(); if (!window) return { canceled: true };
    const choice = await dialog.showOpenDialog(window, { title: 'Choose your browser download folder', defaultPath: folder(), properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
    stop(); deps.store.set('audioWatchFolder', choice.filePaths[0]); library.watchFolder = choice.filePaths[0]; notify();
    return library.snapshot();
  }));
  ipcMain.handle('audio-library-pick', () => result(async () => {
    const window = deps.window(); if (!window) return { canceled: true };
    const choice = await dialog.showOpenDialog(window, { title: 'Add downloaded Audio Library MP3s', defaultPath: folder(), filters: [{ name: 'MP3 audio', extensions: ['mp3'] }], properties: ['openFile', 'multiSelections'] });
    if (choice.canceled) return { canceled: true };
    await library.offer(choice.filePaths); notify(); return library.snapshot();
  }));
  ipcMain.handle('audio-library-keep', (_, options) => result(async () => { await library.keep(options?.id, options); notify(); return library.snapshot(); }));
  ipcMain.handle('audio-library-update', (_, options) => result(async () => { await library.update(options?.id, options); notify(); return library.snapshot(); }));
  ipcMain.handle('audio-library-dismiss', (_, id) => { library.dismiss(id); notify(); return { success: true }; });
  ipcMain.handle('audio-library-import', (_, id) => result(async () => {
    if (!deps.connected()) throw new Error('Connect Premiere before sending audio.');
    const filePath = await library.file(id);
    const imported = await deps.importToPremiere(filePath);
    if (!imported?.success) throw new Error(imported?.error || 'Premiere could not import this audio.');
    return { imported: true };
  }));
  ipcMain.handle('audio-library-show-folder', () => result(async () => { await shell.openPath(library.folder); return {}; }));
  app.on('before-quit', () => { stop(); clearInterval(communityTimer); download?.controller.abort(); });
}
