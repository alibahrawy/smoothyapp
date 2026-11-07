/**
 * Streams a validated local media file to the Agentic review <video> element.
 *
 * Chromium cannot load arbitrary file:// paths from the renderer under the app's
 * security model, so this tiny privileged scheme supplies byte ranges instead.
 * The handler is loopback-app-internal: the URL is a base64 path that is
 * re-validated against the same media roots as the Agent Bridge.
 */

import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { resolveMediaPath } from './media';

protocol.registerSchemesAsPrivileged([{
  scheme: 'smoothy-preview',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
}]);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mxf': 'application/mxf',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function streamFile(file: string, request: Request): Promise<Response> {
  const method = request.method || 'GET';
  if (!['GET', 'HEAD'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const info = await stat(file);
  if (!info.isFile()) return new Response(null, { status: 404 });
  const size = info.size;
  const headers = new Headers({
    'content-type': contentType(file),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, content-length, accept-ranges'
  });
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = new Headers(request.headers).get('range');
  if (range && method !== 'HEAD') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => {
      headers.set('content-range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    };
    if (!match || (!match[1] && !match[2])) return invalid();
    const first = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;
    if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return invalid();
    if (first === null) {
      if (!last) return invalid();
      start = Math.max(0, size - last);
    } else {
      start = first;
      if (last !== null) end = Math.min(end, last);
    }
    if (start > end || start >= size) return invalid();
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('content-length', String(Math.max(0, end - start + 1)));
  if (method === 'HEAD' || size === 0) return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end, signal: request.signal });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}

let installed = false;

export function installPreviewProtocol(userData: string): void {
  if (installed) return;
  installed = true;
  protocol.handle('smoothy-preview', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'media') return new Response(null, { status: 404 });
      const encoded = url.pathname.replace(/^\/+/, '');
      if (!encoded || encoded.length > 20000) return new Response(null, { status: 400 });
      const candidate = Buffer.from(encoded, 'base64url').toString('utf8');
      const file = await resolveMediaPath(candidate, os.homedir(), userData);
      return await streamFile(file, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
