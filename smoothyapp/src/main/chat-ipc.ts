import { app, ipcMain, dialog, clipboard, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChatService } from './chat-service';
import { getStoredUserId } from './auth-service';
import { requestStudioText, requestChatHistory } from './web-api';
import { trackTool } from './telemetry';
import { assertStudioEnabled } from './app-preferences';
import { createChatHistoryService } from './chat-history';
import { randomUUID } from 'node:crypto';
import { readChatAttachment, chatFileExtensions } from './chat-attachments';
import catalog from '../shared/chat-catalog.json';

export function registerChat(window: () => BrowserWindow | null, enabled: () => boolean, writingStyle: () => string | undefined = () => undefined, historyStore: { get: (key: string) => unknown; set: (key: string, value: unknown) => unknown }) {
  let attachmentOwner: string | null = null, epoch = 0;
  const attachments = new Map<string, Awaited<ReturnType<typeof readChatAttachment>>>();
  const owner = () => { assertStudioEnabled(); const id = getStoredUserId(); if (!id) throw new Error('Sign in to use Chat.'); return id; };
  const scope = () => { const id = owner(); if (id !== attachmentOwner) { attachments.clear(); attachmentOwner = id; epoch++; } return id; };
  const service = createChatService({ owner: getStoredUserId, enabled, writingStyle, request: requestStudioText, track: trackTool, attachment: id => {
    scope(); const file = attachments.get(id); if (!file) throw new Error('This attachment expired. Add it again.'); return file;
  } });
  const history = createChatHistoryService({ owner: getStoredUserId, request: requestChatHistory, get: key => historyStore.get(key), set: (key, value) => { historyStore.set(key, value); } });
  const wrap = async (fn: () => Promise<any>) => { try { return { success: true, ...await fn() }; } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Chat failed.' }; } };
  ipcMain.handle('chat-run', (event, input) => wrap(async () => {
    const requestId = input?.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId))) throw new Error('Invalid chat request.');
    if (requestId && event.sender !== window()?.webContents) throw new Error('Chat window changed. Try again.');
    return service.run(input, delta => {
      if (!requestId) return;
      if (event.sender.isDestroyed() || event.sender !== window()?.webContents) throw new Error('Chat window changed. Try again.');
      event.sender.send('chat-chunk', { requestId, delta });
    });
  }));
  ipcMain.handle('chat-cancel', () => { service.cancel(); return { success: true }; });
  const reset = () => { service.cancel(); history.reset(); epoch++; attachments.clear(); attachmentOwner = null; };
  ipcMain.handle('chat-reset', () => { reset(); return { success: true }; });
  ipcMain.handle('chat-history-list', () => wrap(async () => ({ items: await history.list(owner()) })));
  ipcMain.handle('chat-history-save', (_, conversationId, turns) => wrap(async () => history.save(owner(), conversationId, turns)));
  ipcMain.handle('chat-history-load', (_, conversationId) => wrap(async () => ({ conversation: await history.load(owner(), conversationId) })));
  ipcMain.handle('chat-history-delete', (_, conversationId) => wrap(async () => history.remove(owner(), conversationId)));
  ipcMain.handle('chat-attach', (_, kind, slots = catalog.maxAttachmentsPerMessage) => wrap(async () => {
    if (!['image', 'file'].includes(kind) || !Number.isInteger(slots) || slots < 1 || slots > catalog.maxAttachmentsPerMessage) throw new Error('Choose an attachment type.');
    const id = scope(), stamp = epoch, win = window();
    if (!win) return { canceled: true };
    const choice = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: kind === 'image' ? 'Images' : 'Documents and images', extensions: kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp', 'gif'] : chatFileExtensions }] });
    if (choice.canceled || !choice.filePaths?.length) return { canceled: true };
    if (choice.filePaths.length > slots || attachments.size + choice.filePaths.length > 32) throw new Error('Add up to four files at once, or start a new chat.');
    // Prepare the entire selection first: invalid/canceled/stale imports count nothing.
    const prepared = [];
    for (const file of choice.filePaths) prepared.push(await readChatAttachment(file));
    if (owner() !== id || epoch !== stamp) throw new Error('Attachment canceled.');
    const added = prepared.map(file => { const key = randomUUID(); attachments.set(key, file); return { id: key, name: file.name, type: file.type, ...(file.type === 'image' ? { preview: file.data } : { characters: file.text.length }) }; });
    for (const _ of added) { try { trackTool('chat_attach'); } catch { /* Never block imports. */ } }
    return { attachments: added };
  }));
  ipcMain.handle('chat-release', (_, ids) => { if (Array.isArray(ids)) ids.forEach(id => { if (typeof id === 'string') attachments.delete(id); }); return { success: true }; });
  const text = (value: unknown) => { assertStudioEnabled(); if (!getStoredUserId()) throw new Error('Sign in to use Chat.'); if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw new Error('No conversation to export.'); return value; };
  ipcMain.handle('chat-copy', (_, value) => wrap(async () => { clipboard.writeText(text(value)); trackTool('chat_copy'); return {}; }));
  ipcMain.handle('chat-save', (_, input) => wrap(async () => {
    const value = text(input), owner = getStoredUserId(), win = window(); if (!win) return { canceled: true };
    const choice = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), 'SmoothyEdit-chat.txt'), filters: [{ name: 'Chat transcript', extensions: ['txt'] }] });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    text(value); if (getStoredUserId() !== owner) throw new Error('Account changed. Save canceled.');
    await fs.writeFile(choice.filePath, value, 'utf8'); trackTool('chat_save'); return {};
  }));
  return { ...service, reset };
}
