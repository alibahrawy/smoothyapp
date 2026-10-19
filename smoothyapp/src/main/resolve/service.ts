import { renderResolveSource } from './source-audio';
import { analyzeSilence, cleanupTempFile } from '../autocut/silence-detector';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { parseResolveTimeline, resolveTimelineInfo, renderResolveMulticam, renderResolveSilence, type ResolveTimeline } from './timeline';
import { renderResolveMicrophone } from './audio';
import { createMulticamPlan } from '../autocut/multicam-plan';
import { generateShotDecisions } from '../autocut/decision-engine';
import { runVad } from '../autocut/vad-runner';

export function createResolveService(deps: {
  progress: (percent: number, message: string) => void;
  result: (result: any) => void;
  exported: () => void;
  renderAudio?: typeof renderResolveMicrophone;
  detectSpeech?: typeof runVad;
}) {
  let loaded: ResolveTimeline | null = null;
  let sourcePath: string | null = null;
  let outputPath: string | null = null;
  let controller: AbortController | null = null;
  return {
    getTimeline: () => loaded,
    getInfo: () => loaded ? resolveTimelineInfo(loaded) : null,
    getOutput: () => outputPath,
    isBusy: () => controller !== null,
    cancel: () => { controller?.abort(); },
    load(filePath: string) {
      if (controller) throw new Error('Wait for Multicam to finish before loading another timeline.');
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Select a Final Cut Pro 7 XML file smaller than 25 MB.');
      const parsed = parseResolveTimeline(fs.readFileSync(filePath, 'utf8'));
      loaded = parsed; sourcePath = fs.realpathSync(filePath); outputPath = null;
      return resolveTimelineInfo(parsed);
    },
    async removeSilence(config:any,destination:string,onStart?:()=>void) {
      if(controller)return {success:false,error:'A Resolve timeline job is already running.'};
      const timeline=loaded;controller=new AbortController();const signal=controller.signal;let audio:string|undefined,temp:string|undefined;
      try {
        if(!timeline || config.options?.sequenceId!==timeline.id)throw new Error('Load the Resolve timeline again.');
        if(path.resolve(destination).toLowerCase()===sourcePath?.toLowerCase())throw new Error('Save a new XML file; keep your source export.');
        for(const track of [...timeline.videoTracks,...timeline.audioTracks])if(track.issues.length)throw new Error(track.issues.join('\n'));
        if(!Array.isArray(config.sources)||!config.sources.length||config.sources.some((source:any)=>!Number.isInteger(source.trackIndex)||!timeline.audioTracks[source.trackIndex]?.enabled))throw new Error('Select enabled Resolve microphone tracks.');
        if(![config.options.thresholdDb,config.options.minSilenceDuration,config.options.padding].every(Number.isFinite)||config.options.thresholdDb>0||config.options.thresholdDb< -100||config.options.minSilenceDuration<=0||config.options.padding<0)throw new Error('Use valid silence detection settings.');
        try{onStart?.();}catch{}
        deps.progress(10,'Preparing source audio from the loaded Resolve timeline…');
        audio=(await renderResolveSource(timeline,config.sources.map((source:any)=>source.trackIndex),signal)).path;
        deps.progress(50,'Detecting silence locally…');
        const analysis=await analyzeSilence(audio,config.options.thresholdDb??-40,config.options.minSilenceDuration??0.5,config.options.padding??0.1,signal);
        signal.throwIfAborted();const xml=renderResolveSilence(timeline,analysis.speechSegments);signal.throwIfAborted();
        temp=path.join(path.dirname(destination),'.smoothy-'+randomUUID()+'.xml');fs.writeFileSync(temp,xml,{flag:'wx'});signal.throwIfAborted();fs.renameSync(temp,destination);temp=undefined;outputPath=destination;
        const result={success:true,operation:'silence',nle:'resolve',handoff:true,path:destination,warnings:timeline.warnings,stats:{originalDuration:analysis.originalDuration,silenceRemoved:analysis.silenceRemoved,newDuration:analysis.newDuration,cuts:analysis.cutsCount}};
        deps.result(result);return result;
      }catch(error){const result={success:false,operation:'silence',nle:'resolve',canceled:signal.aborted,error:signal.aborted?'Canceled. No timeline was exported.':error instanceof Error?error.message:'Resolve silence removal failed.'};deps.result(result);return result;}
      finally{if(audio)cleanupTempFile(audio);if(temp)fs.rmSync(temp,{force:true});controller=null;}
    },
    async run(config: any, destination: string, onStart?: () => void) {
      if (controller) return { success: false, error: 'Multicam is already running.' };
      controller = new AbortController();
      const signal = controller.signal;
      let directory: string | null = null;
      let temporary: string | null = null;
      try {
        const timeline = loaded;
        const { sources, options } = config || {};
        if (!timeline || options?.sequenceId !== timeline.id || options?.timelineRevision !== timeline.id) throw new Error('Load your Resolve XML again before running Multicam.');
        if (path.resolve(destination).toLowerCase() === sourcePath?.toLowerCase()) throw new Error('Save the result to a new XML file. Keep your original export.');
        const cameras: number[] = options?.videoTracks?.map((track: any) => track.index) || [];
        if (cameras.length < 2 || new Set(cameras).size !== cameras.length || cameras.some(index => !Number.isInteger(index) || !timeline.videoTracks[index])) throw new Error('Select at least two different camera tracks.');
        if (!Array.isArray(sources) || !sources.length || new Set(sources.map(s => s.index)).size !== sources.length || sources.some(s => !Number.isInteger(s.index) || !timeline.audioTracks[s.index] || !Number.isInteger(s.camera) || s.camera < 0 || s.camera >= cameras.length)) throw new Error('Choose valid microphone tracks and camera mappings.');
        for (const [value, min, max] of [[options.minCutDuration ?? 0.8, 0.1, 60], [options.holdTime ?? 1, 0, 60], [options.jcutOffset ?? 0, 0, 10]]) {
          if (!Number.isFinite(value) || value < min || value > max) throw new Error('Use valid Multicam timing settings.');
        }
        for (const track of [...cameras.map(i => timeline.videoTracks[i]), ...sources.map(s => timeline.audioTracks[s.index])]) {
          if (track.issues.length) throw new Error(track.issues.join('\n'));
          if (!track.enabled || !track.clips.some(clip => !clip.disabled)) throw new Error(`Enable ${track.name} in Resolve and export the timeline again.`);
          for (const clip of track.clips.filter(c => !c.disabled)) if (!fs.existsSync(clip.path)) throw new Error(`Media for ${clip.name} is offline. Relink it in Resolve and export the XML again.`);
        }
        try { onStart?.(); } catch {}
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-'));
        const segments: any[] = [], mapping: Record<string, number> = {};
        const warnings = [...timeline.warnings, 'Speech analysis reads the exported source microphone channels. Resolve mixer processing is not included.'];
        for (const [i, source] of sources.entries()) {
          signal.throwIfAborted();
          const speaker = `microphone_${source.index}`;
          mapping[speaker] = source.camera;
          deps.progress(5 + i / sources.length * 65, `Analyzing ${timeline.audioTracks[source.index].name} locally…`);
          const wav = path.join(directory, speaker + '.wav');
          await (deps.renderAudio || renderResolveMicrophone)(timeline.audioTracks[source.index], wav, timeline.duration, signal);
          signal.throwIfAborted();
          const speech = await (deps.detectSpeech || runVad)([{ path: wav, speaker }], 3, true, signal);
          if (!speech.length) warnings.push(`No speech detected on ${timeline.audioTracks[source.index].name}. Check its source channel and camera mapping.`);
          segments.push(...speech);
        }
        signal.throwIfAborted();
        if (!segments.length) throw new Error('No speech detected on the selected microphones. Check your isolated microphone tracks.');
        deps.progress(75, 'Choosing cameras with Smoothy Multicam…');
        const decisions = generateShotDecisions(segments, mapping, { totalDuration: timeline.duration,
          minShotDuration: options.minCutDuration ?? 0.8, holdTimeBeforeSwitch: options.holdTime ?? 1,
          wideCameraIndex: options.wideCameraIndex ?? -1, useOverlapWideShots: !!options.useOverlapWideShots,
          minOverlapDuration: 0.5, wideShowDuration: 5 });
        const tracks = cameras.map(index => timeline.videoTracks[index]);
        const ranges = createMulticamPlan(tracks, decisions.mainShots, decisions.wideShots, timeline.fps, timeline.duration, options.jcutOffset ?? 0);
        const missing = ranges.filter(range => range.trackIndex < 0).reduce((sum, range) => sum + range.endFrame - range.startFrame, 0);
        if (missing) warnings.push(`${(missing / timeline.fps).toFixed(1)}s has no footage on any selected camera. These existing gaps are retained.`);
        deps.progress(90, 'Saving your Resolve timeline…');
        const xml = renderResolveMulticam(timeline, cameras, ranges);
        signal.throwIfAborted();
        temporary = path.join(path.dirname(destination), `.smoothy-${randomUUID()}.xml`);
        fs.writeFileSync(temporary, xml, { flag: 'wx' });
        signal.throwIfAborted();
        fs.renameSync(temporary, destination); temporary = null;
        outputPath = destination;
        try { deps.exported(); } catch {}
        const result = { success: true, nle: 'resolve', handoff: true, sequenceName: timeline.name + ' - Auto-Switch',
          warnings, stats: { shots: ranges.filter(range => range.trackIndex >= 0).length, segments: segments.length } };
        deps.progress(95, 'Timeline saved. Preparing the Resolve handoff…');
        deps.result(result);
        return result;
      } catch (error) {
        const result = { success: false, nle: 'resolve', canceled:signal.aborted, error: signal.aborted ? 'Multicam canceled. No result was exported.' : error instanceof Error ? error.message : 'Resolve Multicam failed.' };
        deps.result(result); return result;
      } finally {
        if (temporary) fs.rmSync(temporary, { force: true });
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        controller = null;
      }
    }
  };
}
