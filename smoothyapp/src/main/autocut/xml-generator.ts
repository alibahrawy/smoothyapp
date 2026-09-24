/**
 * FCP XML Generator - Creates Premiere-compatible XML with multicam cuts
 */

import type { ShotDecision } from './decision-engine';

export interface ClipInfo {
  name: string;
  path?: string;
}

interface XmlOptions {
  sequenceName?: string;
  fps?: number;
  width?: number;
  height?: number;
  jcutOffset?: number; // seconds that audio leads video
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

export function generateMulticamSequenceXML(
  clips: ClipInfo[],
  shots: ShotDecision[],
  options: XmlOptions = {},
  wideShots: ShotDecision[] = []
): string {
  const fps = options.fps || 23.976;
  const timebase = Math.round(fps);
  const ntsc = (fps === 29.97 || fps === 23.976 || fps === 59.94) ? 'TRUE' : 'FALSE';
  const width = options.width || 1920;
  const height = options.height || 1080;
  const sequenceName = options.sequenceName || 'Auto-Switch Sequence';

  // Calculate max duration from both main shots and wide shots
  const allShots = [...shots, ...wideShots];
  const maxEndTime = allShots.length > 0 ? Math.max(...allShots.map(s => s.end)) : 0;
  const totalDurationFrames = secondsToFrames(maxEndTime, fps);

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
        <duration>${totalDurationFrames}</duration>
        <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
        <file id="${fileId}">
          <name>${escapeXml(clip.name)}</name>
          <pathurl>${pathToFileURL(clip.path || '')}</pathurl>
          <duration>${totalDurationFrames}</duration>
          <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
          <media>
            <video><duration>${totalDurationFrames}</duration><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></video>
            <audio><duration>${totalDurationFrames}</duration><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></audio>
          </media>
        </file>
      </clip>`;
  });

  // Build video track clips
  let videoClipItems = '';
  let alternateVideoClipItems = '';
  const numCameras = clips.length;

  shots.forEach((shot, index) => {
    const startFrame = secondsToFrames(shot.start, fps);
    const endFrame = secondsToFrames(shot.end, fps);
    const durationFrames = endFrame - startFrame;

    if (durationFrames <= 0) return;

    const cameraIndex = shot.camera;
    const fileId = `file-${cameraIndex + 1}`;
    const masterClipId = `masterclip-${cameraIndex + 1}`;
    const clipName = clips[cameraIndex]?.name || `Camera ${cameraIndex + 1}`;

    videoClipItems += `
          <clipitem id="video-main-${index + 1}">
            <masterclipid>${masterClipId}</masterclipid>
            <name>${escapeXml(clipName)}</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>${startFrame}</in>
            <out>${endFrame}</out>
            <file id="${fileId}"/>
          </clipitem>`;

    // Alternate track shows the other camera
    const altCameraIndex = numCameras === 2 ? (1 - cameraIndex) : ((cameraIndex + 1) % numCameras);
    const altFileId = `file-${altCameraIndex + 1}`;
    const altMasterClipId = `masterclip-${altCameraIndex + 1}`;
    const altClipName = clips[altCameraIndex]?.name || `Camera ${altCameraIndex + 1}`;

    alternateVideoClipItems += `
          <clipitem id="video-alt-${index + 1}">
            <masterclipid>${altMasterClipId}</masterclipid>
            <name>${escapeXml(altClipName)}</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>${startFrame}</in>
            <out>${endFrame}</out>
            <file id="${altFileId}"/>
          </clipitem>`;
  });

  // Build wide shot track (V3) - only for overlap-triggered wide shots
  let wideVideoClipItems = '';
  if (wideShots.length > 0) {
    wideShots.forEach((shot, index) => {
      const startFrame = secondsToFrames(shot.start, fps);
      const endFrame = secondsToFrames(shot.end, fps);
      const durationFrames = endFrame - startFrame;

      if (durationFrames <= 0) return;

      const cameraIndex = shot.camera;
      const fileId = `file-${cameraIndex + 1}`;
      const masterClipId = `masterclip-${cameraIndex + 1}`;
      const clipName = clips[cameraIndex]?.name || `Wide Camera`;

      wideVideoClipItems += `
          <clipitem id="video-wide-${index + 1}">
            <masterclipid>${masterClipId}</masterclipid>
            <name>${escapeXml(clipName)} (Wide)</name>
            <duration>${durationFrames}</duration>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>${startFrame}</in>
            <out>${endFrame}</out>
            <file id="${fileId}"/>
          </clipitem>`;
    });
  }

  // Build audio tracks - one continuous track per clip (no cuts)
  // Only video tracks get cuts, audio plays continuously from all cameras
  let audioTracksXml = '';
  clips.forEach((clip, clipIndex) => {
    const fileId = `file-${clipIndex + 1}`;
    const masterClipId = `masterclip-${clipIndex + 1}`;

    audioTracksXml += `
            <track>
              <clipitem id="audio-track${clipIndex + 1}">
                <masterclipid>${masterClipId}</masterclipid>
                <name>${escapeXml(clip.name)}</name>
                <duration>${totalDurationFrames}</duration>
                <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
                <start>0</start>
                <end>${totalDurationFrames}</end>
                <in>0</in>
                <out>${totalDurationFrames}</out>
                <file id="${fileId}"/>
                <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
              </clipitem>
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
        <duration>${totalDurationFrames}</duration>
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
            <track>${alternateVideoClipItems}
            </track>
            <track>${videoClipItems}
            </track>${wideVideoClipItems ? `
            <track>${wideVideoClipItems}
            </track>` : ''}
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
