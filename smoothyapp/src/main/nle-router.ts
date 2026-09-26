/**
 * NLE Router - Unified interface for Premiere Pro and DaVinci Resolve
 * 
 * Routes calls to the appropriate NLE backend based on the active selection.
 * Premiere Pro uses a WebSocket server (websocket-server.ts).
 * DaVinci Resolve uses a Lua bridge script with file/HTTP communication.
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
  createShortsAssembly as wsCreateShortsAssembly,
  sendCaptionsToPremiere
} from './websocket-server';

import { getResolveConnectionStatus } from './resolve-bridge';

let activeNLE: 'premiere' | 'resolve' | null = null;

export function startNLEServers() {
  startWebSocketServer();
  // DaVinci Resolve bridge doesn't need a persistent server -
  // it's polled via HTTP or file-based communication from the Lua script.
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
  // If resolve is explicitly selected, return resolve status
  if (activeNLE === 'resolve') {
    return getResolveConnectionStatus();
  }
  // Otherwise return Premiere status (default)
  return getPremiereConnectionStatus();
}

export function getSequenceInfo() {
  return wsGetSequenceInfo();
}

export function getActiveNLE() {
  return activeNLE;
}

export function setActiveNLE(nle: 'premiere' | 'resolve' | null) {
  activeNLE = nle;
}

export function exportAudio() {
  return wsExportAudio();
}

export function addMarkersToSequence(markers: any[]) {
  return wsAddMarkersToSequence(markers);
}

export function clearMarkersFromSequence() {
  return wsClearMarkersFromSequence();
}

export function exportSubtitles() {
  return wsExportSubtitles();
}

export function createShortsAssembly(markers: any[], options?: any) {
  return wsCreateShortsAssembly(markers, options);
}

export function sendCaptionsToNLE(srtPath: string) {
  return sendCaptionsToPremiere(srtPath);
}
