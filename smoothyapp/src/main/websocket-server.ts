/**
 * WebSocket Server - Communicates with the Premiere Pro CEP bridge plugin.
 *
 * The UXP plugin was removed in v1.3.3; the CEP extension is the only bridge.
 */

import { runVad } from './autocut/vad-runner';
import { generateShotDecisions } from './autocut/decision-engine';
import { runPremiereMulticam } from './autocut/premiere-multicam';
import { extractAudioTrack, stitchTimelineAudio, cleanupTempFile, resetAudioExtractionCancel, cancelAudioExtraction } from './autocut/audio-extractor';
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
  onProgress: (progress: number, message: string, cancelable?: boolean) => {},
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
export function sendStockFootageToPremiere(filePath: string): Promise<any> {
  return bridgeRequests.request('importStockFootage', 'stockFootageImported', { filePath }, 60000);
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

let multicamRunning = false;
let timelineController: AbortController | null = null;
let timelineCommitting = false;
export function cancelTimelineOperation() {
  if (!timelineController) return { success: false, error: 'No timeline job is running.' };
  if (timelineCommitting) return { success: false, error: 'Premiere is applying the edit. Wait for it to finish; use Undo in Premiere afterward if needed.' };
  timelineController.abort(new Error('Canceled. No timeline edit was submitted.'));
  cancelAudioExtraction();
  return { success: true };
}

export async function runAutoCut(config: any, onStart?: () => void) {
  if (timelineController) return { success: false, error: 'Wait for the current timeline job to finish.' };
  multicamRunning = true;
  const controller = timelineController = new AbortController();
  timelineCommitting = false;
  try {
    // Count accepted starts once; analytics must never block the timeline job.
    try { onStart?.(); } catch {}
    if ((Number(currentSequenceInfo?.multicamTimelineVersion) || 0) < 7) throw new Error('Restart Premiere and reopen the SmoothyEdit panel to load the updated Multicam bridge, then refresh the sequence.');
    // The host resolves the captured sequence ID and verifies its revision.
    // Live sequence-info updates may now describe a different visible tab.
    resetAudioExtractionCancel();
    const result = await runPremiereMulticam(config, {
      signal: controller.signal,
      request: (type, response, payload, timeout) => bridgeRequests.request(type, response, payload, timeout),
      normalizeAudio: (file, speaker) => extractAudioTrack(file, speaker, 0),
      detectSpeech: (file, speaker) => runVad([{ path: file, speaker }], 3, true, controller.signal),
      decideShots: generateShotDecisions,
      cleanup: cleanupTempFile,
      progress: (percent, message) => {
        if (percent >= 85) timelineCommitting = true;
        callbacks.onProgress(percent, message, !timelineCommitting);
      }
    });
    callbacks.onResult(result);
  } catch (error) {
    console.error('[Multicam] Error:', error);
    callbacks.onResult({ success: false, canceled: controller.signal.aborted, operation: 'multicam', error: error instanceof Error ? error.message : 'Multicam failed' });
  } finally { multicamRunning = false; timelineController = null; timelineCommitting = false; }
}

export async function runSilenceRemoval(config: any, onStart?: () => void) {
  if (timelineController) return { success: false, error: 'Wait for the current timeline job to finish.' };
  const controller = timelineController = new AbortController();
  const signal = controller.signal;
  timelineCommitting = false;
  const temporaryFiles: string[] = [];
  const result = (value: any) => { const output = { ...value, operation: 'silence' }; callbacks.onResult(output); return output; };
  try {
    const { sources, options } = config;
    const sequenceId = options.sequenceId;
    if (!sequenceId || String(currentSequenceInfo?.id) !== String(sequenceId)) throw new Error('The active sequence changed. Refresh and analyze it again.');
    validateTimelineTracks([...(options.videoTracks || []), ...sources], options.fps || 23.976);
    try { onStart?.(); } catch {}
    resetAudioExtractionCancel();
    callbacks.onProgress(5, 'Starting silence analysis...', true);
    const timelineClips: TimelineAudioClip[] = sources.flatMap(sourceTimelineClips);
    let combinedPath: string;
    if (timelineClips.length) {
      callbacks.onProgress(20, 'Preparing timeline audio...', true);
      combinedPath = (await stitchTimelineAudio(timelineClips, `silence_timeline_${Date.now()}`)).path;
      temporaryFiles.push(combinedPath);
    } else {
      const audioPaths: string[] = [];
      for (let i = 0; i < sources.length; i++) {
        signal.throwIfAborted();
        callbacks.onProgress(10 + i / sources.length * 20, `Extracting audio ${i + 1}/${sources.length}`, true);
        const wav = await extractAudioTrack(sources[i].path, `silence_${Date.now()}_${i}`, 0);
        audioPaths.push(wav); temporaryFiles.push(wav);
      }
      signal.throwIfAborted();
      combinedPath = await combineAudioTracks(audioPaths, signal);
      temporaryFiles.push(combinedPath);
    }
    signal.throwIfAborted();
    callbacks.onProgress(50, 'Detecting silence...', true);
    const analysis = await analyzeSilence(combinedPath, options.thresholdDb ?? -40, options.minSilenceDuration ?? 0.5, options.padding ?? 0.1, signal);
    signal.throwIfAborted();
    if (!analysis.speechSegments.length) throw new Error('No speech detected - entire audio is silence');
    let xmlPath: string | undefined;
    if (!options.editInPlace) {
      callbacks.onProgress(75, 'Generating XML...', true);
      const xml = generateSilenceRemovalXML(options.videoTracks || [], analysis.speechSegments, {
        sequenceName: options.sequenceName || 'Silence Removed', audioTracks: sources,
        fps: options.fps || 23.976, width: options.width || 1920, height: options.height || 1080
      });
      xmlPath = path.join(os.tmpdir(), `SmoothyEdit_SilenceRemoved_${Date.now()}.xml`);
      fs.writeFileSync(xmlPath, xml, 'utf-8');
    }
    // Drain a queued Cancel before submitting any irreversible editor operation.
    await new Promise<void>(resolve => setImmediate(resolve));
    try { signal.throwIfAborted(); }
    catch (error) { if (xmlPath) cleanupTempFile(xmlPath); throw error; }
    timelineCommitting = true;
    callbacks.onProgress(90, options.editInPlace ? 'Premiere is applying cuts. Finishing this edit safely...' : 'Premiere is importing the timeline. Finishing safely...', false);
    const edited = options.editInPlace ? await removeSilenceInPremiere(analysis.silenceSegments, sequenceId) : await importXMLToPremiere(xmlPath!);
    if (!edited.success) throw new Error(edited.error || 'Premiere could not complete the edit');
    callbacks.onProgress(100, 'Done!', false);
    return result({ success: true, stats: { originalDuration: analysis.originalDuration, silenceRemoved: analysis.silenceRemoved,
      newDuration: analysis.newDuration, cuts: options.editInPlace ? analysis.silenceSegments.length : analysis.cutsCount },
      ...(options.editInPlace ? { editedInPlace: true } : { xmlPath }) });
  } catch (error) {
    return result({ success: false, canceled: signal.aborted, error: signal.aborted ? 'Canceled. No timeline edit was submitted.' : error instanceof Error ? error.message : 'Silence removal failed' });
  } finally {
    temporaryFiles.forEach(cleanupTempFile);
    timelineController = null; timelineCommitting = false;
  }
}

export function sendAudioLibraryToPremiere(filePath: string): Promise<any> {
  return bridgeRequests.request('importAudioLibrary', 'audioLibraryImported', { filePath }, 60000);
}
