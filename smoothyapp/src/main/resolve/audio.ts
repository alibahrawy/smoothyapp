import { spawn } from 'child_process';
import fs from 'fs';
import { getFFmpegPath, getFFprobePath } from '../ffmpeg-path';
import type { ResolveTrack } from './timeline';

export function executeMedia(executable: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const process = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const abort = () => { process.kill(); };
    signal.addEventListener('abort', abort, { once: true });
    process.stdout.on('data', data => { output = (output + data).slice(-1024 * 1024); });
    process.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
    process.on('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    process.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Error('Multicam canceled. No result was exported.'));
      else if (code !== 0) reject(new Error(`Could not decode microphone media (${code}). Check that all source files are available and use supported audio codecs. ${errors.slice(-250)}`));
      else resolve(output);
    });
    if (signal.aborted) abort();
  });
}

/** Analyze the exported source channel, never downmix two microphones together. */
export async function renderResolveMicrophone(track: ResolveTrack, destination: string, duration: number, signal: AbortSignal) {
  const clips = track.clips.filter(clip => !clip.disabled);
  if (!clips.length || clips.length > 128) throw new Error('Choose a microphone track with 1–128 source clips for this development build.');
  const args: string[] = ['-y', '-v', 'error'];
  const filters: string[] = [];
  const cache = new Map<string, any[]>();
  for (const [i, clip] of clips.entries()) {
    signal.throwIfAborted();
    if (!fs.existsSync(clip.path)) throw new Error(`Media for ${clip.name} is offline. Relink it in Resolve and export the XML again.`);
    let streams = cache.get(clip.path);
    if (!streams) {
      const probe = JSON.parse(await executeMedia(getFFprobePath(), ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=channels', '-of', 'json', clip.path], signal));
      streams = probe.streams || [];
      cache.set(clip.path, streams!);
    }
    let channel = clip.channel - 1, stream = 0;
    while (stream < streams!.length && channel >= streams![stream].channels) channel -= streams![stream++].channels;
    if (channel < 0 || stream >= streams!.length) throw new Error(`The source microphone channel for ${clip.name} is unavailable. Check the track channel mapping in Resolve.`);
    args.push('-i', clip.path);
    filters.push(`[${i}:a:${stream}]pan=mono|c0=c${channel},atrim=start=${clip.inPoint}:duration=${clip.end - clip.start},asetpts=PTS-STARTPTS,adelay=${Math.round(clip.start * 1000)}:all=1[a${i}]`);
  }
  const inputs = clips.map((_, i) => `[a${i}]`).join('');
  filters.push(`${inputs}${clips.length === 1 ? 'anull' : `amix=inputs=${clips.length}:duration=longest:normalize=0`},apad,atrim=duration=${duration}[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', destination);
  await executeMedia(getFFmpegPath(), args, signal);
  return destination;
}
