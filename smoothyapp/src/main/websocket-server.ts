/**
 * WebSocket Server - Communicates with the Premiere Pro CEP bridge plugin.
 *
 * The UXP plugin was removed in v1.3.3; the CEP extension is the only bridge.
 */

import { runVad } from './autocut/vad-runner';
import { generateShotDecisions } from './autocut/decision-engine';
import { generateMulticamSequenceXML } from './autocut/xml-generator';
import { extractAudioTrack, stitchTimelineAudio, cleanupTempFile, resetAudioExtractionCancel } from './autocut/audio-extractor';
import type { TimelineAudioClip } from './autocut/audio-extractor';
import { combineAudioTracks, analyzeSilence, cleanupTempFile as cleanupSilenceTemp, alignSegmentsToFrames } from './autocut/silence-detector';
import { generateSilenceRemovalXML } from './autocut/silence-xml-generator';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { BridgeRequests } from './bridge-requests';
import { validateTimelineTracks } from './autocut/timeline-xml';

// @ts-ignore
const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;

const PORT = 3456;
// Bind to loopback only so other devices on the network cannot impersonate the
// Premiere bridge.
const HOST = '127.0.0.1';

// Shared secret written into the installed CEP panel. When set, clients must
// present it to connect, so another local process cannot pose as the bridge.
let bridgeToken: string | null = null;

export function setBridgeToken(token: string | null): void {
  bridgeToken = token && token.trim() ? token.trim() : null;
}

let wss: any = null;
let pluginSocket: any = null;
let pluginSocketType: string | null = null;
const pluginSockets: Record<string, any> = {};
const pluginVersions: Record<string, string> = {};
const pluginProtocols: Record<string, number> = {};
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
    if (message.requestId && (pluginProtocols[target.type] || 0) < 2) {
      throw new Error('Restart Premiere and reopen Window → Extensions → SmoothyEdit to load the updated bridge.');
    }
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

const bridgeRequests = new BridgeRequests(sendToPlugin);

export function removeSilenceInPremiere(silenceSegments: any[], sequenceId: string): Promise<any> {
  if (!sequenceId) return Promise.reject(new Error('Refresh the sequence before removing silence.'));
  return bridgeRequests.request('removeSilence', 'silenceRemoved', { silenceSegments, sequenceId }, 180000);
}
export function importXMLToPremiere(xmlPath: string): Promise<any> {
  return bridgeRequests.request('importXML', 'xmlImported', { xmlPath }, 120000);
}
export function sendImageToPremiere(imagePath: string, durationSeconds = 5): Promise<any> {
  return bridgeRequests.request('importImage', 'imageImported', { imagePath, atPlayhead: true, durationSeconds }, 60000);
}
export function exportAudio(): Promise<any> {
  return bridgeRequests.request('exportAudio', 'audioExported', {}, 60000);
}
export function addMarkersToSequence(markers: any[]): Promise<any> {
  return bridgeRequests.request('addMarkers', 'markersAdded', { markers }, 30000);
}
export function clearMarkersFromSequence(scope: 'smoothy' | 'all' = 'smoothy', sequenceId?: string): Promise<any> {
  return bridgeRequests.request('clearMarkers', 'markersCleared', { scope, sequenceId }, 30000);
}
export function exportSubtitles(): Promise<any> {
  return bridgeRequests.request('exportSubtitles', 'subtitlesExported', {}, 30000);
}
export function createShortsAssembly(_markers: any[], _options: any = {}): Promise<any> {
  return Promise.reject(new Error('Building a vertical sequence is coming back soon with the Premiere plugin.'));
}
export function sendCaptionsToPremiere(srtPath: string): Promise<any> {
  return bridgeRequests.request('importCaptions', 'captionsImported', { srtPath }, 60000);
}

/**
 * Every clip on a track, with timeline offsets and source in/out points. The
 * renderer sends these so Multicam and Silence Removal analyse the whole
 * timeline instead of only the first clip of each track.
 */
function sourceTimelineClips(source: any): TimelineAudioClip[] {
  const clips = Array.isArray(source?.clips) ? source.clips : [];
  return clips
    .filter((clip: any) => clip && clip.path && !clip.disabled)
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

  wss = new WebSocketServer({ port: PORT, host: HOST });

  wss.on('listening', () => {
    console.log(`[WebSocket] Server listening on ws://${HOST}:${PORT}`);
  });

  wss.on('error', (err: Error) => {
    console.error('[WebSocket] Server error:', err.message);
  });

  wss.on('connection', (ws: any, req: any) => {
    if (bridgeToken) {
      let provided: string | null = null;
      try {
        provided = new URL(req?.url || '', `ws://${HOST}`).searchParams.get('token');
      } catch {
        provided = null;
      }
      if (provided !== bridgeToken) {
        console.warn('[WebSocket] Rejected connection with an invalid bridge token');
        try { ws.close(1008, 'Unauthorized'); } catch {}
        return;
      }
    }

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
          delete pluginProtocols[type];
        }
      }

      const previousSocket = pluginSocket;
      selectActivePluginSocket();

      if (previousSocket === ws) {
        bridgeRequests.disconnect();
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
  bridgeRequests.disconnect();
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
      delete pluginProtocols[type];
    }
    isConnected = false;
  }
}

async function handleMessage(msg: any, ws?: any) {
  if (ws && pluginSocket && ws !== pluginSocket && msg.requestId) return;
  if (bridgeRequests.receive(msg)) return;
  console.log('[WebSocket] Received:', msg.type);

  switch (msg.type) {
    case 'pluginConnected':
      {
        const newType = msg.pluginType || 'unknown';
        pluginProtocols[newType] = Number(msg.protocolVersion) || 0;
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


  }
}

export async function runAutoCut(config: any) {
  const { sources, options } = config;

  try {
    resetAudioExtractionCancel();
    validateTimelineTracks([...(options.videoTracks || []), ...sources], options.fps || 23.976);
    if (!options.videoTracks?.length) throw new Error('Select camera tracks and refresh the Premiere bridge.');
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

    const clips = options.videoTracks;

    const sequenceName = options.sequenceName || 'Auto-Switch Sequence';

    console.log(`[AutoSwitch] Generating XML with ${mainShots.length} main cuts, ${wideShots.length} wide cuts, J-cut offset: ${jcutOffset}s`);

    // Pass wideShots to XML generator - they'll be placed on V3
    const xml = generateMulticamSequenceXML(clips, mainShots, {
      sequenceName: sequenceName,
      fps: options.fps || 23.976,
      width: options.width || 1920,
      height: options.height || 1080,
      duration: options.duration,
      audioTracks: sources,
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
    resetAudioExtractionCancel();
    const sequenceId = options.sequenceId;
    if (!sequenceId || String(currentSequenceInfo?.id) !== String(sequenceId)) throw new Error('The active sequence changed. Refresh and analyze it again.');
    validateTimelineTracks([...(options.videoTracks || []), ...sources], options.fps || 23.976);
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
      options.padding ?? 0.1
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
      const editResult = await removeSilenceInPremiere(analysis.silenceSegments, sequenceId);
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
      const clips = options.videoTracks || [];

      const xml = generateSilenceRemovalXML(clips, analysis.speechSegments, {
        sequenceName: options.sequenceName || 'Silence Removed',
        audioTracks: sources,
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
