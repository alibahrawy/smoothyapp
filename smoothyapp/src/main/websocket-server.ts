/**
 * WebSocket Server - Communicates with the Premiere Pro CEP bridge plugin.
 *
 * The UXP plugin was removed in v1.3.3; the CEP extension is the only bridge.
 */

import { runVad } from './autocut/vad-runner';
import { generateShotDecisions } from './autocut/decision-engine';
import { generateMulticamSequenceXML } from './autocut/xml-generator';
import { extractAudioTrack, stitchTimelineAudio, cleanupTempFile } from './autocut/audio-extractor';
import type { TimelineAudioClip } from './autocut/audio-extractor';
import { combineAudioTracks, analyzeSilence, cleanupTempFile as cleanupSilenceTemp, alignSegmentsToFrames } from './autocut/silence-detector';
import { generateSilenceRemovalXML } from './autocut/silence-xml-generator';
import path from 'path';
import os from 'os';
import fs from 'fs';

// @ts-ignore
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;

const PORT = 3456;

let wss: any = null;
let pluginSocket: any = null;
let pluginSocketType: string | null = null;
const pluginSockets: Record<string, any> = {};
const pluginVersions: Record<string, string> = {};
let isConnected = false;
let currentSequenceInfo: any = null;

// Callbacks
let callbacks = {
  onConnectionChange: (connected: boolean) => {},
  onSequenceInfo: (info: any) => {},
  onProgress: (progress: number, message: string) => {},
  onResult: (result: any) => {}
};

export function setCallbacks(cbs: typeof callbacks) {
  callbacks = { ...callbacks, ...cbs };
}

export function getConnectionStatus() {
  return isConnected;
}

export function getSequenceInfo() {
  return currentSequenceInfo;
}

function sendToPlugin(message: any) {
  const target = selectPluginSocketForMessage(message);
  if (target && target.socket.readyState === WebSocket.OPEN) {
    pluginSocket = target.socket;
    pluginSocketType = target.type;
    isConnected = true;
    console.log(`[WebSocket] Sending ${message.type} via ${target.type}`);
    target.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function isOpenSocket(socket: any) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function selectActivePluginSocket() {
  const preferredTypes = ['cep', 'unknown'];
  for (const type of preferredTypes) {
    if (isOpenSocket(pluginSockets[type])) {
      pluginSocket = pluginSockets[type];
      pluginSocketType = type;
      isConnected = true;
      return;
    }
  }

  pluginSocket = null;
  pluginSocketType = null;
  isConnected = false;
}

function getPreferredTypesForMessage(_message: any) {
  // CEP is the only supported bridge since v1.3.3.
  return ['cep', 'unknown'];
}

function selectPluginSocketForMessage(message: any): { socket: any; type: string } | null {
  const preferredTypes = getPreferredTypesForMessage(message);
  for (const type of preferredTypes) {
    const socket = pluginSockets[type];
    if (isOpenSocket(socket)) {
      console.log(`[WebSocket] Selected ${type} plugin for ${message?.type}`);
      return { socket, type };
    }
  }

  selectActivePluginSocket();
  return pluginSocket ? { socket: pluginSocket, type: pluginSocketType || 'unknown' } : null;
}

function getPluginTypeForSocket(socket: any): string | null {
  for (const [type, plugin] of Object.entries(pluginSockets)) {
    if (plugin === socket) return type;
  }

  return null;
}

export function requestSequenceInfo() {
  sendToPlugin({ type: 'getSequenceInfo' });
}

// Pending promises for async Premiere bridge responses
let pendingExportAudio: { resolve: (value: any) => void; reject: (error: any) => void; attemptedTypes: string[] } | null = null;
let pendingAddMarkers: {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  markers: any[];
  attemptedTypes: string[];
} | null = null;
let pendingClearMarkers: { resolve: (value: any) => void; reject: (error: any) => void } | null = null;
let pendingExportSubtitles: { resolve: (value: any) => void; reject: (error: any) => void; attemptedTypes: string[] } | null = null;
let pendingImportCaptions: { resolve: (value: any) => void; reject: (error: any) => void } | null = null;
let pendingImportXml: { resolve: (value: any) => void; reject: (error: any) => void } | null = null;
let pendingRemoveSilence: { resolve: (value: any) => void; reject: (error: any) => void } | null = null;

/**
 * Ask Premiere to ripple-delete the silence segments, resolving only when the
 * bridge reports back. Previously the UI said "Done" as soon as the message was
 * sent, even if the edit failed.
 */
export function removeSilenceInPremiere(silenceSegments: any[]): Promise<{ success: boolean; error?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    pendingRemoveSilence = { resolve, reject };
    const sent = sendToPlugin({ type: 'removeSilence', silenceSegments });
    if (!sent) {
      pendingRemoveSilence = null;
      reject(new Error('Not connected to Premiere'));
      return;
    }

    setTimeout(() => {
      if (pendingRemoveSilence) {
        pendingRemoveSilence = null;
        reject(new Error('Timed out - Premiere did not confirm the edit'));
      }
    }, 180000);
  });
}

/**
 * Import an FCP XML into Premiere and resolve only once Premiere reports the
 * result. The autocut/silence flows used to fire-and-forget, telling the user
 * "Done" before Premiere had imported anything.
 */
export function importXMLToPremiere(xmlPath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    pendingImportXml = { resolve, reject };
    const sent = sendToPlugin({ type: 'importXML', xmlPath });
    if (!sent) {
      pendingImportXml = null;
      reject(new Error('Not connected to Premiere'));
      return;
    }

    setTimeout(() => {
      if (pendingImportXml) {
        pendingImportXml = null;
        reject(new Error('Import timed out - Premiere did not confirm the import'));
      }
    }, 120000);
  });
}

export function exportAudio(): Promise<any> {
  return new Promise((resolve, reject) => {
    pendingExportAudio = { resolve, reject, attemptedTypes: [] };
    const sent = sendToPlugin({ type: 'exportAudio' });
    if (!sent) {
      pendingExportAudio = null;
      reject(new Error('Not connected to Premiere'));
    }
    pendingExportAudio?.attemptedTypes.push(pluginSocketType || 'unknown');

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingExportAudio) {
        pendingExportAudio = null;
        reject(new Error('Export timeout'));
      }
    }, 60000);
  });
}

export function addMarkersToSequence(markers: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    pendingAddMarkers = { resolve, reject, markers, attemptedTypes: [] };
    const sent = sendToPlugin({ type: 'addMarkers', markers });
    if (!sent) {
      pendingAddMarkers = null;
      reject(new Error('Not connected to Premiere'));
      return;
    }

    pendingAddMarkers.attemptedTypes.push(pluginSocketType || 'unknown');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingAddMarkers) {
        pendingAddMarkers = null;
        reject(new Error('Add markers timeout'));
      }
    }, 30000);
  });
}

export function clearMarkersFromSequence(): Promise<any> {
  return new Promise((resolve, reject) => {
    pendingClearMarkers = { resolve, reject };
    const sent = sendToPlugin({ type: 'clearMarkers' });
    if (!sent) {
      pendingClearMarkers = null;
      reject(new Error('Not connected to Premiere'));
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingClearMarkers) {
        pendingClearMarkers = null;
        reject(new Error('Clear markers timeout'));
      }
    }, 30000);
  });
}

export function exportSubtitles(): Promise<any> {
  return new Promise((resolve, reject) => {
    pendingExportSubtitles = { resolve, reject, attemptedTypes: [] };
    const sent = sendToPlugin({ type: 'exportSubtitles' });
    if (!sent) {
      pendingExportSubtitles = null;
      reject(new Error('Not connected to Premiere'));
    }
    pendingExportSubtitles?.attemptedTypes.push(pluginSocketType || 'unknown');

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingExportSubtitles) {
        pendingExportSubtitles = null;
        reject(new Error('Export subtitles timeout'));
      }
    }, 30000);
  });
}

export function createShortsAssembly(_markers: any[], _options: any = {}): Promise<any> {
  // Vertical-sequence assembly required the Premiere UXP plugin, which was
  // removed in v1.3.3. Kept as a clear error so callers degrade gracefully.
  return Promise.reject(new Error('Building a vertical sequence is coming back soon with the Premiere plugin.'));
}

export function sendCaptionsToPremiere(srtPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    pendingImportCaptions = { resolve, reject };
    const sent = sendToPlugin({ type: 'importCaptions', srtPath });
    if (!sent) {
      pendingImportCaptions = null;
      reject(new Error('Not connected to Premiere'));
    }

    // Timeout after 60 seconds (caption import can take time)
    setTimeout(() => {
      if (pendingImportCaptions) {
        pendingImportCaptions = null;
        reject(new Error('Import captions timeout'));
      }
    }, 60000);
  });
}

/**
 * Every clip on a track, with timeline offsets and source in/out points. The
 * renderer sends these so Multicam and Silence Removal analyse the whole
 * timeline instead of only the first clip of each track.
 */
function sourceTimelineClips(source: any): TimelineAudioClip[] {
  const clips = Array.isArray(source?.clips) ? source.clips : [];
  return clips
    .filter((clip: any) => clip && clip.path)
    .map((clip: any) => ({
      path: clip.path,
      start: Number(clip.start) || 0,
      end: Number(clip.end) || 0,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint
    }));
}

export function startWebSocketServer() {
  if (wss) return;

  wss = new WebSocketServer({ port: PORT });

  wss.on('listening', () => {
    console.log(`[WebSocket] Server listening on ws://localhost:${PORT}`);
  });

  wss.on('error', (err: Error) => {
    console.error('[WebSocket] Server error:', err.message);
  });

  wss.on('connection', (ws: any) => {
    console.log('[WebSocket] Plugin connected');

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(message, ws);
      } catch (e) {
        console.error('[WebSocket] Message error:', e);
      }
    });

    ws.on('close', () => {
      console.log('[WebSocket] Plugin disconnected');
      for (const [type, socket] of Object.entries(pluginSockets)) {
        if (socket === ws) {
          delete pluginSockets[type];
          delete pluginVersions[type];
        }
      }

      const previousSocket = pluginSocket;
      selectActivePluginSocket();

      if (previousSocket === ws) {
        currentSequenceInfo = null;
        callbacks.onConnectionChange(isConnected);
        if (isConnected) {
          requestSequenceInfo();
        }
      }
    });

    // Welcome and request sequence info
    ws.send(JSON.stringify({ type: 'welcome', version: '1.0.0' }));
  });
}

export function stopWebSocketServer() {
  if (wss) {
    wss.close();
    wss = null;
    pluginSocket = null;
    pluginSocketType = null;
    for (const type of Object.keys(pluginSockets)) {
      delete pluginSockets[type];
    }
    for (const type of Object.keys(pluginVersions)) {
      delete pluginVersions[type];
    }
    isConnected = false;
  }
}

async function handleMessage(msg: any, ws?: any) {
  console.log('[WebSocket] Received:', msg.type);

  switch (msg.type) {
    case 'pluginConnected':
      {
        const newType = msg.pluginType || 'unknown';
        console.log(`[WebSocket] Premiere bridge type: ${newType}`);
        if (msg.bridgeVersion) {
          console.log('[WebSocket] Premiere bridge version:', msg.bridgeVersion);
          pluginVersions[newType] = msg.bridgeVersion;
        }

        if (ws) pluginSockets[newType] = ws;
        selectActivePluginSocket();
        console.log(`[WebSocket] Active Premiere bridge type: ${pluginSocketType || 'none'}`);
        callbacks.onConnectionChange(true);
      }
      requestSequenceInfo();
      break;

    case 'sequenceInfo':
      if (ws && pluginSocket && ws !== pluginSocket) {
        break;
      }
      currentSequenceInfo = msg;
      callbacks.onSequenceInfo(msg);
      break;

    case 'xmlImported':
      if (pendingImportXml) {
        pendingImportXml.resolve({ success: !!msg.success, error: msg.error });
        pendingImportXml = null;
      } else if (msg.success) {
        callbacks.onResult({ success: true, message: 'XML imported successfully' });
      } else {
        callbacks.onResult({ success: false, error: msg.error });
      }
      break;

    case 'silenceRemoved':
      if (pendingRemoveSilence) {
        pendingRemoveSilence.resolve({ success: !!msg.success, error: msg.error, message: msg.message });
        pendingRemoveSilence = null;
      } else if (msg.success) {
        callbacks.onResult({ success: true, message: msg.message || 'Silence removed from sequence' });
      } else {
        callbacks.onResult({ success: false, error: msg.error || 'Failed to remove silence' });
      }
      break;

    case 'audioExported':
      if (pendingExportAudio) {
        if (msg.success) {
          pendingExportAudio.resolve({ success: true, audioBase64: msg.audioBase64, fileName: msg.fileName, fileSize: msg.fileSize, duration: msg.duration });
        } else {
          pendingExportAudio.resolve({ success: false, error: msg.error });
        }
        pendingExportAudio = null;
      }
      break;

    case 'markersAdded':
      {
      const responseType = getPluginTypeForSocket(ws) || pluginSocketType || 'unknown';
      if (msg.bridgeVersion) {
        console.log('[WebSocket] Markers bridge version:', msg.bridgeVersion);
      }
      if (msg.debug) {
        console.log('[WebSocket] Markers debug:', JSON.stringify(msg.debug, null, 2));
      }
      if (!msg.success) {
        console.warn('[WebSocket] Markers failed:', msg.error || 'Unknown marker error');
      }
      if (pendingAddMarkers) {
        pendingAddMarkers.resolve({
          success: msg.success,
          count: msg.count,
          error: msg.error,
          debug: msg.debug,
          bridgeVersion: msg.bridgeVersion,
          pluginType: responseType,
          attemptedTypes: pendingAddMarkers.attemptedTypes
        });
        pendingAddMarkers = null;
      }
      break;
      }

    case 'markersCleared':
      if (pendingClearMarkers) {
        pendingClearMarkers.resolve({ success: msg.success, count: msg.count, error: msg.error });
        pendingClearMarkers = null;
      }
      break;

    case 'subtitlesExported':
      console.log('[WebSocket] Subtitles debug:', msg.debug);
      if (pendingExportSubtitles) {
        pendingExportSubtitles.resolve({
          success: msg.success,
          subtitles: msg.subtitles,
          srt: msg.srt,
          count: msg.count,
          sequenceName: msg.sequenceName,
          source: msg.source,
          error: msg.error,
          debug: msg.debug
        });
        pendingExportSubtitles = null;
      }
      break;

    case 'captionsImported':
      if (pendingImportCaptions) {
        pendingImportCaptions.resolve({
          success: msg.success,
          count: msg.count,
          message: msg.message,
          error: msg.error
        });
        pendingImportCaptions = null;
      }
      break;
  }
}

export async function runAutoCut(config: any) {
  const { sources, options } = config;

  try {
    callbacks.onProgress(5, 'Starting analysis...');

    const allSegments: any[] = [];
    const speakerToCameraMap: Record<string, number> = {};

    // Process each audio source
    console.log('[AutoSwitch] Sources received:', JSON.stringify(sources.map((s: any) => ({ speaker: s.speaker, camera: s.camera }))));
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const speaker = source.speaker || `speaker_${i + 1}`;
      speakerToCameraMap[speaker] = source.camera;
      console.log(`[AutoSwitch] Mapping ${speaker} -> camera ${source.camera}`);

      callbacks.onProgress(10 + (i / sources.length) * 30, `Extracting audio: ${speaker}`);

      // Build a timeline-accurate WAV for this track. Using only the first
      // clip from the start of the media file put a synced multicam interview
      // on the wrong clock (and ignored every clip after the first).
      let tempWav: string;
      try {
        const timelineClips = sourceTimelineClips(source);
        if (timelineClips.length > 0) {
          const stitched = await stitchTimelineAudio(timelineClips, `multicam_${i}_${Date.now()}`);
          tempWav = stitched.path;
          console.log(`[AutoSwitch] ${speaker}: timeline audio ${stitched.durationSeconds.toFixed(1)}s from ${stitched.clipCount} clip(s)`);
        } else {
          tempWav = await extractAudioTrack(source.path, speaker, 0);
        }
      } catch (err) {
        console.warn(`Failed to extract audio from ${source.path}:`, err);
        continue;
      }

      callbacks.onProgress(40 + (i / sources.length) * 20, `Analyzing speech: ${speaker}`);

      // Run VAD
      try {
        const segments = await runVad([{ path: tempWav, speaker }]);
        allSegments.push(...segments);
        console.log(`[AutoSwitch] ${speaker}: ${segments.length} speech segments`);
      } catch (err) {
        console.warn(`VAD failed for ${speaker}:`, err);
      }

      cleanupTempFile(tempWav);
    }

    if (allSegments.length === 0) {
      callbacks.onResult({ success: false, error: 'No speech detected' });
      return;
    }

    callbacks.onProgress(70, 'Generating shot decisions...');

    // Generate shots
    // UI sliders: minCutDuration (0.5-2.0, default 0.8) and holdTime (0.5-3.0, default 1.0)
    // Wide shot options: useOverlapWideShots triggers wide camera on speaker overlaps
    const result = generateShotDecisions(allSegments, speakerToCameraMap, {
      totalDuration: options.duration || 3600,
      minShotDuration: options.minCutDuration || 0.8,
      holdTimeBeforeSwitch: options.holdTime || 1.0,
      wideCameraIndex: options.wideCameraIndex ?? -1,
      // Overlap-based wide shots (new feature)
      useOverlapWideShots: options.useOverlapWideShots || false,
      minOverlapDuration: 0.5,    // Minimum overlap to trigger wide shot
      wideShowDuration: 5.0       // Show wide for 5 seconds
    });

    const { mainShots, wideShots } = result;
    console.log(`[AutoSwitch] Generated ${mainShots.length} main shots, ${wideShots.length} wide shots`);

    const jcutOffset = options.jcutOffset || 0;

    // Generate XML with J-cut support
    callbacks.onProgress(85, 'Generating sequence with J-cuts...');

    const clips = options.clips || sources.map((s: any, i: number) => ({
      name: `Camera ${i + 1}`,
      path: s.path
    }));

    const sequenceName = options.sequenceName || 'Auto-Switch Sequence';

    console.log(`[AutoSwitch] Generating XML with ${mainShots.length} main cuts, ${wideShots.length} wide cuts, J-cut offset: ${jcutOffset}s`);

    // Pass wideShots to XML generator - they'll be placed on V3
    const xml = generateMulticamSequenceXML(clips, mainShots, {
      sequenceName: sequenceName,
      fps: options.fps || 23.976,
      width: options.width || 1920,
      height: options.height || 1080,
      jcutOffset: jcutOffset
    }, wideShots);

    // Save XML
    const xmlPath = path.join(os.tmpdir(), `SmoothyEdit_${Date.now()}.xml`);
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    console.log(`[AutoSwitch] XML saved: ${xmlPath}`);

    callbacks.onProgress(95, 'Importing into Premiere...');

    // Wait for Premiere to actually confirm the import before reporting success.
    const importResult = await importXMLToPremiere(xmlPath);
    if (!importResult.success) {
      callbacks.onResult({ success: false, error: importResult.error || 'Premiere could not import the sequence' });
      return;
    }

    callbacks.onProgress(100, `Done! Created ${mainShots.length} cuts${wideShots.length > 0 ? ` + ${wideShots.length} wide shots` : ''}`);
    callbacks.onResult({
      success: true,
      stats: {
        segments: allSegments.length,
        shots: mainShots.length,
        wideShots: wideShots.length
      },
      xmlPath
    });

  } catch (error) {
    console.error('[AutoSwitch] Error:', error);
    callbacks.onResult({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

export async function runSilenceRemoval(config: any) {
  const { sources, options } = config;

  try {
    callbacks.onProgress(5, 'Starting silence analysis...');

    // Build one timeline-accurate WAV from every clip on the selected tracks.
    // The old code extracted only the first clip of each track from the start
    // of the media file, which mis-timed synced audio and ignored later clips.
    const timelineClips: TimelineAudioClip[] = [];
    for (const source of sources) {
      timelineClips.push(...sourceTimelineClips(source));
    }

    let combinedPath: string;

    if (timelineClips.length > 0) {
      callbacks.onProgress(20, `Preparing timeline audio (${timelineClips.length} clip${timelineClips.length === 1 ? '' : 's'})...`);
      try {
        const stitched = await stitchTimelineAudio(timelineClips, `silence_timeline_${Date.now()}`);
        combinedPath = stitched.path;
        console.log(`[SilenceRemoval] Timeline audio ${stitched.durationSeconds.toFixed(1)}s from ${stitched.clipCount} clip(s)`);
      } catch (err) {
        console.error('[SilenceRemoval] Failed to prepare timeline audio:', err);
        callbacks.onResult({ success: false, error: 'Failed to extract audio' });
        return;
      }
    } else {
      // Fallback for callers that only send a single path per track.
      const audioPaths: string[] = [];

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        callbacks.onProgress(10 + (i / sources.length) * 20, `Extracting audio ${i + 1}/${sources.length}`);

        try {
          const tempWav = await extractAudioTrack(source.path, `track_${i}`, 0);
          audioPaths.push(tempWav);
        } catch (err) {
          console.warn(`Failed to extract audio from ${source.path}:`, err);
        }
      }

      if (audioPaths.length === 0) {
        callbacks.onResult({ success: false, error: 'Failed to extract audio' });
        return;
      }

      callbacks.onProgress(35, 'Combining audio tracks...');
      try {
        combinedPath = await combineAudioTracks(audioPaths);
      } catch (err) {
        audioPaths.forEach(p => cleanupTempFile(p));
        callbacks.onResult({ success: false, error: 'Failed to combine audio tracks' });
        return;
      }
      audioPaths.forEach(p => cleanupTempFile(p));
    }

    callbacks.onProgress(50, 'Detecting silence...');

    // Analyze for silence
    const analysis = await analyzeSilence(
      combinedPath,
      options.thresholdDb || -40,
      options.minSilenceDuration || 0.5,
      options.padding || 0.1
    );

    // Cleanup combined file
    cleanupSilenceTemp(combinedPath);

    console.log(`[SilenceRemoval] Found ${analysis.speechSegments.length} speech segments`);
    console.log(`[SilenceRemoval] Removing ${analysis.silenceRemoved.toFixed(1)}s of silence`);

    if (analysis.speechSegments.length === 0) {
      callbacks.onResult({ success: false, error: 'No speech detected - entire audio is silence' });
      return;
    }

    // Check if we should edit in place or create new sequence
    if (options.editInPlace) {
      callbacks.onProgress(75, 'Removing silence from current sequence...');

      console.log(`[SilenceRemoval] Sending ${analysis.silenceSegments.length} segments to Premiere for removal`);

      // CEP edits the active sequence with ExtendScript/QE. Wait for it to
      // finish before telling the user the edit is done.
      const editResult = await removeSilenceInPremiere(analysis.silenceSegments);
      if (!editResult.success) {
        callbacks.onResult({ success: false, error: editResult.error || 'Premiere could not remove the silence' });
        return;
      }

      callbacks.onProgress(100, 'Done!');
      callbacks.onResult({
        success: true,
        stats: {
          originalDuration: analysis.originalDuration,
          silenceRemoved: analysis.silenceRemoved,
          newDuration: analysis.newDuration,
          cuts: analysis.silenceSegments.length
        },
        editedInPlace: true
      });

    } else {
      callbacks.onProgress(75, 'Generating XML...');

      // Generate XML for new sequence
      const clips = options.clips || sources.map((s: any, i: number) => ({
        name: s.trackName || `Track ${i + 1}`,
        path: s.path
      }));

      const xml = generateSilenceRemovalXML(clips, analysis.speechSegments, {
        sequenceName: options.sequenceName || 'Silence Removed',
        fps: options.fps || 23.976,
        width: options.width || 1920,
        height: options.height || 1080
      });

      // Save XML
      const xmlPath = path.join(os.tmpdir(), `SmoothyEdit_SilenceRemoved_${Date.now()}.xml`);
      fs.writeFileSync(xmlPath, xml, 'utf-8');
      console.log(`[SilenceRemoval] XML saved: ${xmlPath}`);

      callbacks.onProgress(90, 'Importing into Premiere...');

      // Wait for Premiere to confirm the import before reporting success.
      const importResult = await importXMLToPremiere(xmlPath);
      if (!importResult.success) {
        callbacks.onResult({ success: false, error: importResult.error || 'Premiere could not import the sequence' });
        return;
      }

      callbacks.onProgress(100, 'Done!');
      callbacks.onResult({
        success: true,
        stats: {
          originalDuration: analysis.originalDuration,
          silenceRemoved: analysis.silenceRemoved,
          newDuration: analysis.newDuration,
          cuts: analysis.cutsCount
        },
        xmlPath
      });
    }

  } catch (error) {
    console.error('[SilenceRemoval] Error:', error);
    callbacks.onResult({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
