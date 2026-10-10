import { app, ipcMain, utilityProcess } from 'electron';
import path from 'node:path';
import { trackTool } from './telemetry';
import { createAssetsImageService } from './assets-image-service';

const service = createAssetsImageService({
  modelRoot: () => path.join(app.getPath('userData'), 'image-models'),
  track: trackTool,
  spawn: (job, progress, signal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const child = utilityProcess.fork(path.join(__dirname, 'assets-worker.js'), [], { serviceName: 'SmoothyEdit image processing', stdio: 'ignore' });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      child.kill();
      error ? reject(error) : resolve();
    };
    const cancel = () => finish(new Error('Canceled'));
    signal.addEventListener('abort', cancel, { once: true });
    child.on('spawn', () => { if (signal.aborted) cancel(); else child.postMessage(job); });
    child.on('message', message => {
      if (settled) return;
      if (message.type === 'progress') progress({ message: message.message, percent: message.percent });
      else if (message.type === 'done') finish();
      else if (message.type === 'error') finish(new Error(message.error));
    });
    child.on('exit', code => finish(new Error(`Local image processing stopped (${code}). Try a smaller image.`)));
    if (signal.aborted) cancel();
  }),
});

ipcMain.handle('assets-process-image', async (event, options) => {
  const cancel = () => service.cancel();
  event.sender.once('destroyed', cancel);
  try {
    return await service.process(options, data => {
      if (!event.sender.isDestroyed()) event.sender.send('assets-processing-progress', data);
    });
  } finally { event.sender.removeListener('destroyed', cancel); }
});
ipcMain.handle('assets-cancel-processing', () => service.cancel());
app.on('before-quit', () => service.cancel());
