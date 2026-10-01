import fs from 'fs';
import http from 'http';
import https from 'https';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED');
}

/** Abort the network request and stream, then remove only this download's temp file. */
export async function downloadFile(url: string, destination: string, onProgress?: (progress: any) => void, label?: string, signal?: AbortSignal): Promise<void> {
  checkCancellation(signal);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    let current = url;
    for (let redirects = 0; redirects <= 6; redirects++) {
      checkCancellation(signal);
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const transport = current.startsWith('https:') ? https : http;
        const request = transport.get(current, { signal }, resolve);
        request.on('error', reject);
      });
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        current = new URL(response.headers.location, current).href;
        continue;
      }
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`Download failed with status ${response.statusCode}`);
      }
      const total = Number(response.headers['content-length']) || 0;
      let loaded = 0;
      response.on('data', (chunk: Buffer) => {
        loaded += chunk.length;
        onProgress?.({ status: 'downloading', file: label, loaded, total, progress: total ? Math.round(loaded / total * 100) : undefined });
      });
      await pipeline(response, fs.createWriteStream(temporary), { signal });
      checkCancellation(signal);
      await fs.promises.rename(temporary, destination);
      return;
    }
    throw new Error('Too many redirects');
  } catch (error) {
    checkCancellation(signal);
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
