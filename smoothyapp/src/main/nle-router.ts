/**
 * NLE Router - Unified interface for Premiere Pro.
 *
 * Premiere Pro uses a WebSocket server (websocket-server.ts) with the CEP bridge.
 *
 * The DaVinci Resolve bridge and the Premiere UXP extension were removed in
 * v1.3.3 to focus on the core editing workflow. They will return once they can
 * reach parity with the CEP extension.
 */

import {
  startWebSocketServer,
  stopWebSocketServer,
  setCallbacks as wsSetCallbacks,
  requestSequenceInfo as wsRequestSequenceInfo,
  runAutoCut as wsRunAutoCut,
  runSilenceRemoval as wsRunSilenceRemoval,
  getConnectionStatus as getPremiereConnectionStatus,
  getSequenceInfo as wsGetSequenceInfo,
  exportAudio as wsExportAudio,
  addMarkersToSequence as wsAddMarkersToSequence,
  clearMarkersFromSequence as wsClearMarkersFromSequence,
  exportSubtitles as wsExportSubtitles,
  sendCaptionsToPremiere,
  sendImageToPremiere
} from './websocket-server';

let activeNLE: 'premiere' | null = null;

export function startNLEServers() {
  startWebSocketServer();
}

export function stopNLEServers() {
  stopWebSocketServer();
}

export function setCallbacks(cbs: any) {
  wsSetCallbacks(cbs);
}

export function requestSequenceInfo() {
  wsRequestSequenceInfo();
}

export function runAutoCut(config: any) {
  return wsRunAutoCut(config);
}

export function runSilenceRemoval(config: any) {
  return wsRunSilenceRemoval(config);
}

export function getConnectionStatus() {
  return getPremiereConnectionStatus();
}

export function getSequenceInfo() {
  return wsGetSequenceInfo();
}

export function getActiveNLE() {
  return activeNLE;
}

export function setActiveNLE(nle: 'premiere' | null) {
  activeNLE = nle;
}

export function exportAudio() {
  return wsExportAudio();
}

export function addMarkersToSequence(markers: any[]) {
  return wsAddMarkersToSequence(markers);
}

export function clearMarkersFromSequence(scope: 'smoothy' | 'all' = 'smoothy', sequenceId?: string) {
  return wsClearMarkersFromSequence(scope, sequenceId);
}

export function exportSubtitles() {
  return wsExportSubtitles();
}

export function sendCaptionsToNLE(srtPath: string) {
  return sendCaptionsToPremiere(srtPath);
}

export function importImageToNLE(imagePath: string, durationSeconds = 5) {
  return sendImageToPremiere(imagePath, durationSeconds);
}
