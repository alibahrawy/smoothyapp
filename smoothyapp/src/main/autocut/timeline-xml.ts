import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';

export interface TimelineClip {
  name: string;
  path: string;
  start: number;
  end: number;
  inPoint: number;
  outPoint: number;
  reversed?: boolean;
  disabled?: boolean;
  mediaFps?: number;
}
export interface TimelineTrack {
  name: string;
  index?: number;
  clips: TimelineClip[];
}
export interface TimelineXmlOptions {
  sequenceName?: string;
  fps?: number;
  width?: number;
  height?: number;
  duration?: number;
  audioTracks?: TimelineTrack[];
}
export interface EditRange { start: number; end: number; destination: number }

export function escapeXml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Rebuild only media whose linear source timing is known. Never guess trims. */
export function validateTimelineTracks(tracks: TimelineTrack[], fps: number): void {
  for (const track of tracks) {
    if (!Array.isArray(track.clips)) throw new Error('Refresh the Premiere bridge to load clip timing.');
    for (const clip of track.clips) {
      if (clip.disabled) continue;
      if (!clip.path || ![clip.start, clip.end, clip.inPoint, clip.outPoint].every(Number.isFinite)) {
        throw new Error(`Refresh the Premiere bridge: source timing or media is missing for ${clip.name}.`);
      }
      if (clip.reversed || clip.start < 0 || clip.end <= clip.start || clip.inPoint < 0 ||
          Math.abs((clip.outPoint - clip.inPoint) - (clip.end - clip.start)) > 1.1 / fps) {
        throw new Error(`Cannot rebuild ${clip.name}: use normal-speed media with valid source in/out points.`);
      }
    }
  }
}

/** Shared frame arithmetic for multicam and ripple reconstruction. */
export function createTimelineXml(videoTracks: TimelineTrack[], audioTracks: TimelineTrack[], options: TimelineXmlOptions) {
  const fps = options.fps ?? 23.976;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Invalid sequence frame rate.');
  validateTimelineTracks([...videoTracks, ...audioTracks], fps);
  const frame = (seconds: number) => Math.round(seconds * fps);
  const rateFor = (value: number) => `<rate><timebase>${Math.round(value)}</timebase><ntsc>${Math.abs(value - Math.round(value) * 1000 / 1001) < 0.01 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const rate = rateFor(fps);
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const files = new Map<string, { id: string; clip: TimelineClip; end: number; fps: number; video: boolean; audio: boolean }>();
  for (const [tracks, kind] of [[videoTracks, 'video'], [audioTracks, 'audio']] as const) {
    for (const track of tracks) for (const clip of track.clips) {
      if (clip.disabled) continue;
      const entry = files.get(clip.path) ?? { id: `file-${files.size + 1}`, clip, end: 0, fps: clip.mediaFps && clip.mediaFps > 0 ? clip.mediaFps : fps, video: false, audio: false };
      entry.end = Math.max(entry.end, Math.round(clip.outPoint * entry.fps));
      entry[kind] = true;
      files.set(clip.path, entry);
    }
  }
  let itemId = 0;
  function renderTrack(track: TimelineTrack, ranges: EditRange[], kind: 'video' | 'audio') {
    let items = '';
    for (const range of ranges) for (const clip of track.clips) {
      const clipStart = frame(clip.start);
      const start = Math.max(clipStart, frame(range.start));
      const end = Math.min(frame(clip.end), frame(range.end));
      if (end <= start || clip.disabled) continue;
      const file = files.get(clip.path)!;
      const sourceIn = Math.round(clip.inPoint * file.fps) + Math.round((start - clipStart) / fps * file.fps);
      const sourceOut = sourceIn + Math.round((end - start) / fps * file.fps);
      const destination = frame(range.destination) + start - frame(range.start);
      items += `<clipitem id="${kind}-${++itemId}"><name>${escapeXml(clip.name)}</name>
        <duration>${file.end}</duration>${rateFor(file.fps)}<start>${destination}</start><end>${destination + end - start}</end>
        <in>${sourceIn}</in><out>${sourceOut}</out><file id="${file.id}"/>
        <sourcetrack><mediatype>${kind}</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
    }
    return `<track>${items}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  }
  function render(name: string, durationFrames: number, video: string[], audio: string[]) {
    const definitions = [...files.values()].map(file => `<clip id="master-${file.id}"><name>${escapeXml(file.clip.name)}</name>
      <duration>${file.end}</duration>${rateFor(file.fps)}<file id="${file.id}"><name>${escapeXml(file.clip.name)}</name>
      <pathurl>${escapeXml(pathToFileURL(file.clip.path).href)}</pathurl><duration>${file.end}</duration>${rateFor(file.fps)}
      <media>${file.video ? `<video><duration>${file.end}</duration><samplecharacteristics><width>${width}</width><height>${height}</height>${rateFor(file.fps)}</samplecharacteristics></video>` : ''}
      ${file.audio ? `<audio><duration>${file.end}</duration><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></audio>` : ''}</media></file></clip>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml><xmeml version="5"><project><name>SmoothyEdit Project</name><children>
<bin><name>Media</name><children>${definitions}</children></bin><sequence id="sequence-1">
<uuid>${randomUUID()}</uuid><name>${escapeXml(name)}</name><duration>${durationFrames}</duration>${rate}
<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
<media><video><format><samplecharacteristics><width>${width}</width><height>${height}</height><pixelaspectratio>square</pixelaspectratio>${rate}</samplecharacteristics></format>${video.join('')}</video>
<audio><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio.join('')}</audio></media>
</sequence></children></project></xmeml>`;
  }
  return { frame, renderTrack, render };
}
