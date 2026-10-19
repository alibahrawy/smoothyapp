import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResolveTimeline } from './timeline';
import { renderResolveMicrophone } from './audio';
import { combineAudioTracks, cleanupTempFile } from '../autocut/silence-detector';

/** Source-only audio: retain XML trims, timeline offsets and isolated microphone channels. */
export async function renderResolveSource(timeline:ResolveTimeline, indices:number[]|undefined, signal:AbortSignal) {
  const selected=indices?.length ? new Set(indices) : new Set(timeline.audioTracks.filter(t=>t.enabled).map(t=>t.index));
  if(!selected.size || [...selected].some(index=>!Number.isInteger(index)||!timeline.audioTracks[index]))throw new Error('Choose valid audio tracks from the loaded Resolve timeline.');
  const tracks=timeline.audioTracks.filter(t=>selected.has(t.index));
  for(const track of tracks)if(!track.enabled || track.issues.length)throw new Error(track.issues.join('\n') || 'Choose enabled Resolve audio tracks.');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-resolve-source-'));
  let mixed:string|undefined;
  const output=path.join(os.tmpdir(),'smoothy-resolve-source-'+randomUUID()+'.wav');
  try {
    const files:string[]=[];
    for(const track of tracks){signal.throwIfAborted();const file=path.join(directory,`audio-${track.index}.wav`);await renderResolveMicrophone(track,file,timeline.duration,signal);files.push(file);}
    mixed=await combineAudioTracks(files,signal);signal.throwIfAborted();fs.copyFileSync(mixed,output);
    return {path:output,durationSeconds:timeline.duration,clipCount:tracks.reduce((n,t)=>n+t.clips.length,0)};
  }catch(error){cleanupTempFile(output);throw error;}
  finally{if(mixed)cleanupTempFile(mixed);fs.rmSync(directory,{recursive:true,force:true});}
}
