import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

// These files are already validated, immutable result capabilities. Supplying
// their length and real byte ranges lets Chromium determine WAV duration and seek
// without buffering the complete recording in either process.
export async function localAudioResponse(file: string, request: Request): Promise<Response> {
  const method = request.method || 'GET';
  if (!['GET', 'HEAD'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Missing audio result.');
  const size = info.size;
  const headers = new Headers({ 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  let start = 0, end = size - 1, status = 200;
  const range = new Headers(request.headers).get('range');
  // HEAD describes the complete representation and does not open a stream.
  if (range && method !== 'HEAD') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => { headers.set('content-range', `bytes */${size}`); return new Response(null, { status: 416, headers }); };
    if (!match || (!match[1] && !match[2])) return invalid();
    const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
    if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return invalid();
    if (first === null) { if (!last) return invalid(); start = Math.max(0, size - last); }
    else { start = first; if (last !== null) end = Math.min(end, last); }
    if (start > end || start >= size) return invalid();
    status = 206; headers.set('content-range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('content-length', String(Math.max(0, end - start + 1)));
  if (method === 'HEAD' || size === 0) return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end, signal: request.signal });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}
