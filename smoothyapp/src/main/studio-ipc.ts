import { app, ipcMain, dialog, clipboard, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStudioService, studioModes, studioProModes } from './studio-service';
import { getStoredUserId } from './auth-service';
import { requestStudioText, saveStudioHistory, listStudioHistory, getCredits } from './web-api';
import { trackTool } from './telemetry';
import { assertStudioEnabled } from './app-preferences';

export function registerStudioTools(window: () => BrowserWindow | null, enabled: () => boolean) {
  const service = createStudioService({ owner: getStoredUserId, enabled, request: requestStudioText, saveHistory: saveStudioHistory, track: trackTool,
    verifyAccess: async mode => { if (studioProModes.includes(mode) && (await getCredits()).tier !== 'pro') throw new Error('This tool requires Studio Pro. See the plan at smoothyedit.com/pricing.'); },
  });
  const wrap = async (fn: () => Promise<any>) => { try { return { success: true, ...await fn() }; } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Studio request failed.' }; } };
  ipcMain.handle('studio-tools-run', (_, input) => wrap(() => service.run(input)));
  ipcMain.handle('studio-tools-cancel', () => { service.cancel(); return { success: true }; });
  ipcMain.handle('studio-tools-history', (_, input) => wrap(async () => {
    if (!studioModes.includes(input?.mode)) throw new Error('Choose a Studio tool.');
    const page = Number.isSafeInteger(input?.page) && input.page > 0 ? Math.min(input.page, 10000) : 1;
    return listStudioHistory(input.mode, page);
  }));
  const text = (value: unknown) => { assertStudioEnabled(); if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000) throw new Error('No result to export.'); return value; };
  ipcMain.handle('studio-tools-copy', (_, value) => wrap(async () => { clipboard.writeText(text(value)); trackTool('studio_copy'); return {}; }));
  ipcMain.handle('studio-tools-save', (_, input) => wrap(async () => {
    const value = text(input?.text), win = window(); if (!win) return { canceled: true };
    const name = studioModes.includes(input?.mode) ? input.mode : 'studio-draft';
    const choice = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), `${name}.txt`), filters: [{ name: 'Text draft', extensions: ['txt'] }] });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    assertStudioEnabled(); await fs.writeFile(choice.filePath, value, 'utf8'); trackTool('studio_save'); return {};
  }));
  return service;
}
