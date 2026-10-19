import { renderResolveSource } from './resolve/source-audio';
/**
 * Premiere live bridge and Resolve Free's local XML Multicam handoff.
 *
 * Premiere Pro uses a WebSocket server (websocket-server.ts) with the CEP bridge.
 *
 * Resolve Free does not expose external scripting. Never route its actions to CEP.
 */

import {
  startWebSocketServer,
  stopWebSocketServer,
  setCallbacks as wsSetCallbacks,
  requestSequenceInfo as wsRequestSequenceInfo,
  runAutoCut as wsRunAutoCut,
  runSilenceRemoval as wsRunSilenceRemoval,
  cancelTimelineOperation,
  getConnectionStatus as getPremiereConnectionStatus,
  getSequenceInfo as wsGetSequenceInfo,
  exportAudio as wsExportAudio,
  addMarkersToSequence as wsAddMarkersToSequence,
  clearMarkersFromSequence as wsClearMarkersFromSequence,
  exportSubtitles as wsExportSubtitles,
  sendCaptionsToPremiere,
  sendImageToPremiere,
  sendStockFootageToPremiere,
  sendAudioLibraryToPremiere
} from './websocket-server';
import { createResolveService } from './resolve/service';
import { trackTool } from './telemetry';

let activeNLE: 'premiere' | 'resolve' | null = process.env.SMOOTHY_RESOLVE_DEV === '1' ? 'resolve' : null;
let multicamBusy = false;
let resolveApplyActive = false;
let callbacks: any = {};
let resolveImportSource: 'file' | 'script' | 'snapshot' = 'file';
const resolveService = createResolveService({
  progress: (progress, message) => callbacks.onProgress?.(progress, message),
  result: result => { if(!resolveApplyActive)callbacks.onResult?.(result); },
  exported: () => trackTool('resolve_multicam_export')
});
export const getResolveOutput = () => resolveService.getOutput();
export const cancelResolveMulticam = () => resolveService.cancel();
export function loadResolveTimeline(filePath: string, source: 'file' | 'script' | 'snapshot' = 'file', trackImport=true) {
  if (multicamBusy) throw new Error('Wait for the current timeline job to finish before loading another timeline.');
  const info = { ...resolveService.load(filePath), handoffSource: source };
  resolveImportSource = source;
  activeNLE = 'resolve';
  callbacks.onConnectionChange?.(true);
  callbacks.onSequenceInfo?.(info);
  if(trackImport)trackTool('resolve_timeline_import');
  return info;
}
let receiveInResolve: ((job:any)=>Promise<any>) | null=null;
let resolveReceiveBusy=()=>false;
export function configureResolveReceiver(send:(job:any)=>Promise<any>,busy:()=>boolean){receiveInResolve=send;resolveReceiveBusy=busy;}
export function prepareResolveAudio(indices:number[]|undefined,signal:AbortSignal){const timeline=resolveService.getTimeline();if(!timeline)throw new Error('Load a Resolve timeline first.');return renderResolveSource(timeline,indices,signal);}
function premiereOnly() {
  if (activeNLE === 'resolve') throw new Error('Resolve Free currently supports Multicam XML handoff here. Select Premiere for this editor action.');
}

export function startNLEServers() {
  startWebSocketServer();
}

export function stopNLEServers() {
  resolveService.cancel();
  stopWebSocketServer();
}

export function setCallbacks(cbs: any) {
  callbacks = cbs;
  wsSetCallbacks({ ...cbs,
    onConnectionChange: (connected: boolean) => { if (activeNLE !== 'resolve') cbs.onConnectionChange?.(connected); },
    onSequenceInfo: (info: any) => { if (activeNLE !== 'resolve') cbs.onSequenceInfo?.(info); }
  });
}

export function requestSequenceInfo() {
  if (activeNLE === 'resolve') { callbacks.onSequenceInfo?.(getSequenceInfo()); return; }
  wsRequestSequenceInfo();
}

async function finishResolveApply(result:any) {
  if(!result.success)return result;
  const file=resolveService.getOutput();
  callbacks.onProgress?.(95,'Sending your new timeline to Resolve…');
  let imported;
  try{imported=receiveInResolve && file ? await receiveInResolve({kind:'timeline',file,timelineName:result.sequenceName}) : {success:false,error:'Resolve Connector is unavailable.'};}
  catch(error){imported={success:false,error:error instanceof Error?error.message:'Could not send the saved timeline to Resolve.'};}
  if(imported.success){try{trackTool('resolve_timeline_send');}catch{};return {...result,imported:true,path:file};}
  return {...result,success:false,canceled:!!imported.canceled,exported:true,path:file,error:imported.error || 'Timeline saved, but Resolve did not confirm its import.'};
}

export async function runAutoCut(config: any, onStart?: () => void, destination?: string) {
  if (multicamBusy) return { success: false, error: 'Multicam is already running.' };
  multicamBusy = true;
  try {
    if (activeNLE === 'resolve') {
      if (!destination) throw new Error('Choose where to save the Resolve timeline.');
      resolveApplyActive=true;
      let result;
      try{result=await finishResolveApply(await resolveService.run(config,destination,onStart));}
      catch(error){result={success:false,nle:'resolve',error:error instanceof Error?error.message:'Resolve Apply failed.'};}
      callbacks.onResult?.(result);return result;
    }
    return await wsRunAutoCut(config, onStart);
  } finally { resolveApplyActive=false;multicamBusy = false; }
}

export async function runSilenceRemoval(config: any, onStart?: () => void, destination?:string) {
  if (multicamBusy) return { success: false, error: 'Wait for the current timeline job to finish.' };
  multicamBusy = true;
  try {
    if(activeNLE==='resolve'){
      if(!destination)throw new Error('Choose a destination XML.');resolveApplyActive=true;
      let result;
      try{result=await finishResolveApply(await resolveService.removeSilence(config,destination,onStart));}
      catch(error){result={success:false,nle:'resolve',error:error instanceof Error?error.message:'Resolve Apply failed.'};}
      result.operation='silence';callbacks.onResult?.(result);return result;
    }
    return await wsRunSilenceRemoval(config,onStart);
  } finally { resolveApplyActive=false;multicamBusy = false; }
}
export function cancelTimelineJob() {
  if (activeNLE === 'resolve') { resolveService.cancel(); return { success: true }; }
  return cancelTimelineOperation();
}

export function getConnectionStatus() {
  return activeNLE === 'resolve' ? !!resolveService.getInfo() : getPremiereConnectionStatus();
}

export function getSequenceInfo() {
  if (activeNLE !== 'resolve') return wsGetSequenceInfo();
  const info = resolveService.getInfo();
  return info ? { ...info, handoffSource: resolveImportSource } : null;
}

export function getActiveNLE() {
  return activeNLE;
}

export function setActiveNLE(nle: 'premiere' | 'resolve' | null) {
  if (![null, 'premiere', 'resolve'].includes(nle)) throw new Error('Choose a supported editor.');
  if (multicamBusy || resolveReceiveBusy()) throw new Error('Finish or cancel the current editor operation before switching editors.');
  // Premiere Pro does not run on Linux; Resolve is the supported editor there.
  if (process.platform === 'linux' && nle !== 'resolve') nle = 'resolve';
  activeNLE = nle;
  callbacks.onConnectionChange?.(getConnectionStatus());
  callbacks.onSequenceInfo?.(getSequenceInfo());
}

export function exportAudio() {
  premiereOnly();
  return wsExportAudio();
}

export function addMarkersToSequence(markers: any[]) {
  if(activeNLE==='resolve'){const info=getSequenceInfo();if(!info)throw new Error('Load the Resolve timeline first.');return receiveInResolve!({kind:'markers',timelineName:info.name,nativeId:info.nativeId,markers:markers.map(m=>({start:Number(m.time),duration:Math.max(0,Number(m.endTime)-Number(m.time)),name:String(m.name||'Short'),note:String(m.comment||'')}))});}
  return wsAddMarkersToSequence(markers);
}

export function clearMarkersFromSequence(scope: 'smoothy' | 'all' = 'smoothy', sequenceId?: string) {
  if(activeNLE==='resolve'){if(scope==='all')throw new Error('Resolve only clears markers created by Smoothy.');const info=getSequenceInfo();if(!info)throw new Error('Load the Resolve timeline first.');return receiveInResolve!({kind:'clear-markers',timelineName:info.name,nativeId:info.nativeId});}
  return wsClearMarkersFromSequence(scope, sequenceId);
}

export function exportSubtitles() {
  premiereOnly();
  return wsExportSubtitles();
}

export function sendCaptionsToNLE(srtPath: string) {
  if(activeNLE==='resolve')return receiveInResolve!({kind:'media',file:srtPath});
  return sendCaptionsToPremiere(srtPath);
}

export function importImageToNLE(imagePath: string, durationSeconds = 5, editor = activeNLE) {
  if(editor==='resolve')return receiveInResolve!({kind:'media',file:imagePath});
  return sendImageToPremiere(imagePath, durationSeconds);
}

export function importStockFootageToNLE(filePath: string, editor = activeNLE) {
  if(editor==='resolve')return receiveInResolve!({kind:'media',file:filePath});
  return sendStockFootageToPremiere(filePath);
}

export function importAudioLibraryToNLE(filePath: string, editor = activeNLE) {
  if(editor==='resolve')return receiveInResolve!({kind:'media',file:filePath});
  return sendAudioLibraryToPremiere(filePath);
}
