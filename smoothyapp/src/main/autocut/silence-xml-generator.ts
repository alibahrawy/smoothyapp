/**
 * Silence Removal XML Generator - Creates Premiere-compatible XML with silence removed
 */

import type { SpeechSegment } from './silence-detector';

export interface ClipInfo {
  name: string;
  path?: string;
}

interface XmlOptions {
  sequenceName?: string;
  fps?: number;
  width?: number;
  height?: number;
}

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pathToFileURL(filePath: string): string {
  if (!filePath) return '';
  if (filePath.startsWith('file://')) {
    filePath = filePath.replace('file://localhost', '').replace('file://', '');
  }
  const encoded = filePath.split('/').map(c => encodeURIComponent(c)).join('/');
  return 'file://localhost' + encoded;
}

function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16).toUpperCase();
  });
}

export function generateSilenceRemovalXML(
  clips: ClipInfo[],
  speechSegments: SpeechSegment[],
  options: XmlOptions = {}
): string {
  const fps = options.fps || 23.976;
  const timebase = Math.round(fps);
  const ntsc = (fps === 29.97 || fps === 23.976 || fps === 59.94) ? 'TRUE' : 'FALSE';
  const width = options.width || 1920;
  const height = options.height || 1080;
  const sequenceName = options.sequenceName || 'Silence Removed';

  // Calculate total duration of output (sum of speech segments)
  const totalOutputDuration = speechSegments.reduce((sum, seg) => sum + seg.duration, 0);
  const totalOutputFrames = secondsToFrames(totalOutputDuration, fps);

  // Original duration (end of last segment or last clip)
  const originalDuration = speechSegments.length > 0
    ? Math.max(...speechSegments.map(s => s.end))
    : 0;
  const originalDurationFrames = secondsToFrames(originalDuration, fps);

  // Build file definitions
  let filesXml = '';
  clips.forEach((clip, index) => {
    const fileId = `file-${index + 1}`;
    const masterClipId = `masterclip-${index + 1}`;

    filesXml += `
      <clip id="${masterClipId}" explodedTracks="true">
        <uuid>${generateUUID()}</uuid>
        <masterclipid>${masterClipId}</masterclipid>
        <name>${escapeXml(clip.name)}</name>
        <duration>${originalDurationFrames}</duration>
        <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
        <file id="${fileId}">
          <name>${escapeXml(clip.name)}</name>
          <pathurl>${pathToFileURL(clip.path || '')}</pathurl>
          <duration>${originalDurationFrames}</duration>
          <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
          <media>
            <video><duration>${originalDurationFrames}</duration><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></video>
            <audio><duration>${originalDurationFrames}</duration><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></audio>
          </media>
        </file>
      </clip>`;
  });

  // Pre-calculate all frame positions to avoid floating point issues
  // Track timeline position in FRAMES to ensure clips are exactly back-to-back
  const segmentFrames = speechSegments.map(segment => ({
    inFrame: secondsToFrames(segment.start, fps),
    outFrame: secondsToFrames(segment.end, fps),
    durationFrames: secondsToFrames(segment.end, fps) - secondsToFrames(segment.start, fps)
  }));

  // Build video clips - all clips placed sequentially with no gaps
  let videoClipItems = '';
  let timelineFrame = 0;

  segmentFrames.forEach((seg, index) => {
    const startFrame = timelineFrame;
    const endFrame = startFrame + seg.durationFrames;

    // Use first clip for video track
    const clip = clips[0];
    const fileId = 'file-1';
    const masterClipId = 'masterclip-1';

    videoClipItems += `
          <clipitem id="video-${index + 1}">
            <masterclipid>${masterClipId}</masterclipid>
            <name>${escapeXml(clip.name)}</name>
            <duration>${seg.durationFrames}</duration>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>${seg.inFrame}</in>
            <out>${seg.outFrame}</out>
            <file id="${fileId}"/>
          </clipitem>`;

    // Move timeline position forward by exact frame count
    timelineFrame = endFrame;
  });

  // Build audio tracks (one per clip) - same sequential placement
  let audioTracksXml = '';
  clips.forEach((clip, clipIndex) => {
    const fileId = `file-${clipIndex + 1}`;
    const masterClipId = `masterclip-${clipIndex + 1}`;

    let trackClipItems = '';
    let audioTimelineFrame = 0;

    segmentFrames.forEach((seg, index) => {
      const startFrame = audioTimelineFrame;
      const endFrame = startFrame + seg.durationFrames;

      trackClipItems += `
              <clipitem id="audio-${clipIndex + 1}-${index + 1}">
                <masterclipid>${masterClipId}</masterclipid>
                <name>${escapeXml(clip.name)}</name>
                <duration>${seg.durationFrames}</duration>
                <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
                <start>${startFrame}</start>
                <end>${endFrame}</end>
                <in>${seg.inFrame}</in>
                <out>${seg.outFrame}</out>
                <file id="${fileId}"/>
                <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
              </clipitem>`;

      audioTimelineFrame = endFrame;
    });

    audioTracksXml += `
            <track>${trackClipItems}
            </track>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <project>
    <name>SmoothyEdit Project</name>
    <children>
      <bin>
        <name>Media</name>
        <children>${filesXml}
        </children>
      </bin>
      <sequence id="sequence-1">
        <uuid>${generateUUID()}</uuid>
        <name>${escapeXml(sequenceName)}</name>
        <duration>${totalOutputFrames}</duration>
        <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
        <timecode>
          <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
          <string>00:00:00:00</string>
          <frame>0</frame>
          <displayformat>NDF</displayformat>
        </timecode>
        <media>
          <video>
            <format>
              <samplecharacteristics>
                <width>${width}</width>
                <height>${height}</height>
                <pixelaspectratio>square</pixelaspectratio>
                <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
              </samplecharacteristics>
            </format>
            <track>${videoClipItems}
            </track>
          </video>
          <audio>
            <format>
              <samplecharacteristics>
                <depth>16</depth>
                <samplerate>48000</samplerate>
              </samplecharacteristics>
            </format>${audioTracksXml}
          </audio>
        </media>
      </sequence>
    </children>
  </project>
</xmeml>`;
}
