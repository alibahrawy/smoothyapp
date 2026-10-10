import fs from 'node:fs';
import path from 'node:path';

export const CAPTION_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'];
export const CAPTION_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg'];

// Picker and Electron drops share validation. Choosing an input is uncounted;
// generation retains its existing native run-start counter.
export async function validateCaptionMediaPath(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new Error('Choose a local audio or video file.');
  }
  const extension = path.extname(input).slice(1).toLowerCase();
  if (![...CAPTION_AUDIO_EXTENSIONS, ...CAPTION_VIDEO_EXTENSIONS].includes(extension)) {
    throw new Error('Choose a supported audio or video file, such as MP3, WAV, M4A, MP4 or MOV.');
  }
  const resolved = await fs.promises.realpath(input);
  const info = await fs.promises.stat(resolved);
  if (!info.isFile() || info.size === 0) throw new Error('Choose a nonempty audio or video file.');
  await fs.promises.access(resolved, fs.constants.R_OK);
  return resolved;
}
