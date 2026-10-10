import { app, ipcMain, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { StockFootageService, type StockSearch } from './stock-footage';
import { stockServiceURL } from './stock-footage-pixabay';
import { trackTool } from './telemetry';

export function registerStockFootage(deps: {
  store: { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void };
  window: () => BrowserWindow | null;
  connected: () => boolean;
  importToPremiere: (filePath: string) => Promise<any>;
}) {
  const service = new StockFootageService();
  let searchController: AbortController | null = null;
  let downloadController: AbortController | null = null;
  service.configurePixabayService(stockServiceURL(), path.join(app.getPath('userData'), 'stock-pixabay-cache'));
  // Retire the previous local-only key preference.
  try { deps.store.delete('stockPixabayKeyEncrypted'); } catch {}
  const getFolder = () => String(deps.store.get('stockFootageFolder') || path.join(app.getPath('downloads'), 'SmoothyEdit Stock Footage'));
  const failure = (error: unknown) => ({ success: false, error: error instanceof Error
    ? error.name === 'TimeoutError' ? 'The footage source took too long to respond. Please try again.'
      : error instanceof TypeError ? 'Could not reach the footage source. Check your internet connection and retry.' : error.message
    : 'The stock footage action failed. Please try again.' });

  ipcMain.handle('stock-get-settings', () => ({ folder: getFolder(), pixabayEnabled: service.pixabayEnabled }));
  ipcMain.handle('stock-select-folder', async () => {
    const window = deps.window();
    if (!window) return { canceled: true };
    const result = await dialog.showOpenDialog(window, { title: 'Choose a stock footage folder', defaultPath: getFolder(), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    deps.store.set('stockFootageFolder', result.filePaths[0]);
    return { success: true, folder: result.filePaths[0] };
  });
  ipcMain.handle('stock-search', async (_, input: StockSearch) => {
    searchController?.abort();
    const controller = new AbortController(); searchController = controller;
    try {
      const results = await service.search(input, controller.signal);
      if (!controller.signal.aborted) trackTool('stock_search');
      return { success: true, ...results };
    } catch (error) { return controller.signal.aborted ? { canceled: true } : failure(error); }
    finally { if (searchController === controller) searchController = null; }
  });
  ipcMain.handle('stock-download', async (_, options: { videoId: number | string; fileId: number; premiere?: boolean }) => {
    if (downloadController) return failure(new Error('Wait for the current stock footage action to finish.'));
    if (options?.premiere && !deps.connected()) return failure(new Error('Connect Premiere before sending stock footage.'));
    const controller = new AbortController(); downloadController = controller;
    let lastProgress = 0;
    try {
      const filePath = await service.download(options?.videoId, options?.fileId, getFolder(), controller.signal, (received, total, phase) => {
        if (!phase && Date.now() - lastProgress < 150 && received !== total) return;
        lastProgress = Date.now();
        deps.window()?.webContents.send('stock-download-progress', { received, total, phase });
      });
      // Keep the original file: Premiere references its permanent location.
      trackTool('stock_download');
      if (options.premiere) {
        deps.window()?.webContents.send('stock-download-progress', { importing: true });
        const result = await deps.importToPremiere(filePath);
        if (!result.success) return { ...failure(new Error(result.error || 'Premiere could not import this video.')), path: filePath };
        trackTool('stock_premiere');
        return { success: true, path: filePath, imported: true };
      }
      return { success: true, path: filePath };
    } catch (error) { return controller.signal.aborted ? { canceled: true } : failure(error); }
    finally { downloadController = null; }
  });
  ipcMain.handle('stock-cancel-download', () => { downloadController?.abort(); return { success: true }; });
  app.on('before-quit', () => { searchController?.abort(); downloadController?.abort(); });
}
