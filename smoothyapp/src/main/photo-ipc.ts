import { app, ipcMain, protocol, dialog, clipboard, nativeImage, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PhotoService } from './photo-service';
import { getStoredUserId } from './auth-service';
import { requestPhotoRoute, fetchPhotoBytes } from './web-api';
import { trackTool } from './telemetry';
import { assertStudioEnabled } from './app-preferences';

protocol.registerSchemesAsPrivileged([{ scheme: 'smoothy-photo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

export function registerPhotos(deps: { window: () => BrowserWindow | null; connected: () => boolean; importToPremiere: (file: string) => Promise<any> }) {
  const service = new PhotoService({ owner: getStoredUserId, request: requestPhotoRoute, imageBytes: fetchPhotoBytes, track: trackTool, png: bytes => {
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 50_000_000) throw new Error('This image is invalid or too large to open.');
    return image.toPNG();
  } });
  const result = async (action: () => Promise<any>) => {
    try { assertStudioEnabled(); return { success: true, ...(await action()) }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'The image action failed. Please retry.' }; }
  };
  protocol.handle('smoothy-photo', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'image' || !/^\/[0-9a-f-]{36}$/.test(url.pathname)) return new Response('', { status: 404 });
      return new Response(await service.bytes(url.pathname.slice(1)), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
    } catch { return new Response('', { status: 404 }); }
  });
  ipcMain.handle('photos-run', (_, input) => result(() => service.run(input)));
  ipcMain.handle('photos-history', (_, input) => result(() => service.history(input?.page || 1, input?.favorites === true)));
  ipcMain.handle('photos-favorite', (_, input) => result(async () => { await service.favorite(input?.id, input?.active); return {}; }));
  ipcMain.handle('photos-delete', (_, id) => result(async () => { await service.remove(id); return {}; }));
  ipcMain.handle('photos-reset', () => { service.reset(); return { success: true }; });
  ipcMain.handle('photos-preview', (_, id) => result(async () => { service.label(id); trackTool('photos_preview'); return {}; }));
  ipcMain.handle('photos-copy', (_, id) => result(async () => {
    clipboard.writeImage(nativeImage.createFromBuffer(await service.bytes(id))); trackTool('photos_copy'); return {};
  }));
  ipcMain.handle('photos-save', (_, id) => result(async () => {
    const window = deps.window(); if (!window) return { canceled: true };
    const name = service.label(id).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 80) || 'Image';
    const choice = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('downloads'), `${name}.png`), filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    await fs.writeFile(choice.filePath, await service.bytes(id)); trackTool('photos_save'); return {};
  }));
  ipcMain.handle('photos-premiere', (_, id) => result(async () => {
    if (!deps.connected()) throw new Error('Connect Premiere before sending an image.');
    const bytes = await service.bytes(id);
    const folder = path.join(app.getPath('pictures'), 'SmoothyEdit AI Photos');
    await fs.mkdir(folder, { recursive: true });
    // Permanent media: Premiere references this file after the app closes.
    const file = path.join(folder, `${id}.png`); await fs.writeFile(file, bytes);
    const imported = await deps.importToPremiere(file);
    if (!imported?.success) throw new Error(imported?.error || 'Image saved. Premiere could not import it; please retry.');
    trackTool('photos_premiere'); return {};
  }));
  return service;
}
