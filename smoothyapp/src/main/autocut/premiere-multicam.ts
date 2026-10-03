import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ShotDecision } from './decision-engine';
import { createMulticamPlan } from './multicam-plan';

interface Dependencies {
  request: (type: string, response: string, payload: any, timeout: number) => Promise<any>;
  normalizeAudio: (file: string, speaker: string) => Promise<string>;
  detectSpeech: (file: string, speaker: string) => Promise<any[]>;
  decideShots: (segments: any[], mapping: Record<string, number>, options: any) => { mainShots: ShotDecision[]; wideShots: ShotDecision[] };
  cleanup: (file: string) => void;
  progress: (percent: number, message: string) => void;
}

/** One snapshot, rendered microphone tracks, then edits on that snapshot only. */
export async function runPremiereMulticam(config: any, deps: Dependencies) {
  const { sources, options } = config;
  if (!options?.sequenceId || !options.timelineRevision || !sources?.length || !options.videoTracks?.length) throw new Error('Refresh Premiere and select microphone and camera tracks.');
  if (new Set(sources.map((source: any) => source.index)).size !== sources.length || sources.some((source: any) => !Number.isInteger(source.index) || source.index < 0 || !Number.isInteger(source.camera) || !options.videoTracks[source.camera])) throw new Error('Choose a valid microphone and camera for each speaker.');
  const jobId = randomUUID();
  // Premiere's TemporaryItems folder can be inaccessible to other processes
  // on macOS. Render directly into a fresh app-created directory instead.
  const audioDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothyedit-multicam-'));
  let completed = false;
  let prepared = false;
  const response = (result: any) => {
    if (!result?.success) throw new Error(result?.error || 'Premiere could not complete the multicam operation.');
    return result;
  };
  try {
    deps.progress(5, 'Duplicating your Premiere sequence…');
    // Discard also runs after an ambiguous timeout: Premiere may have cloned it.
    prepared = true;
    const snapshot = response(await deps.request('prepareMulticam', 'multicamPrepared', {
      jobId, sequenceId: options.sequenceId, timelineRevision: options.timelineRevision,
      sequenceName: options.sequenceName, audioDirectory, audioTrackIndices: sources.map((source: any) => source.index),
      videoTrackIndices: options.videoTracks.map((track: any) => track.index)
    }, 60000));
    const cameraTracks = options.videoTracks.map((track: any) => {
      const camera = snapshot.videoTracks?.find((item: any) => item.index === track.index);
      if (!camera) throw new Error('The camera tracks changed. Refresh Premiere and try again.');
      return camera;
    });
    const segments: any[] = [];
    const warnings: string[] = [];
    const mapping: Record<string, number> = {};
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      // Independent IDs prevent two speakers with identical labels from colliding.
      const speaker = `microphone_${source.index}`;
      mapping[speaker] = source.camera;
      let wav: string | undefined;
      let renderedAudioPath: string | undefined;
      try {
        deps.progress(10 + i / sources.length * 55, `Rendering A${source.index + 1}: ${source.name || source.speaker || speaker}…`);
        const audio = response(await deps.request('exportMulticamTrack', 'multicamTrackExported', { jobId, trackIndex: source.index }, 1200000));
        const extension = typeof audio.filePath === 'string' ? path.extname(audio.filePath).slice(1) : '';
        if (!/^(wav|mp3)$/.test(extension) || path.basename(audio.filePath) !== `microphone-${source.index}.${extension}` || fs.realpathSync(path.dirname(audio.filePath)) !== fs.realpathSync(audioDirectory)) throw new Error('Reopen the updated SmoothyEdit panel in Premiere to load the audio handoff fix.');
        renderedAudioPath = path.join(audioDirectory, `microphone-${source.index}.${extension}`);
        const rendered = fs.lstatSync(renderedAudioPath);
        if (!rendered.isFile() || rendered.size <= 44 || rendered.size !== audio.fileSize) throw new Error('Premiere did not pass a complete microphone audio file to SmoothyEdit.');
        wav = await deps.normalizeAudio(renderedAudioPath, `${jobId}_${speaker}`);
        deps.progress(20 + i / sources.length * 55, `Analysing A${source.index + 1}…`);
        const speech = await deps.detectSpeech(wav, speaker);
        if (!speech.length) warnings.push(`No speech detected on A${source.index + 1}. Check that microphone and its camera mapping.`);
        segments.push(...speech);
      } finally {
        if (wav) deps.cleanup(wav);
        if (renderedAudioPath) deps.cleanup(renderedAudioPath);
      }
    }
    if (!segments.length) throw new Error('No speech detected on the selected microphone tracks.');
    deps.progress(75, 'Choosing cameras…');
    const { mainShots, wideShots } = deps.decideShots(segments, mapping, {
      totalDuration: snapshot.duration, minShotDuration: options.minCutDuration ?? 0.8,
      holdTimeBeforeSwitch: options.holdTime ?? 1, wideCameraIndex: options.wideCameraIndex ?? -1,
      useOverlapWideShots: !!options.useOverlapWideShots, minOverlapDuration: 0.5, wideShowDuration: 5
    });
    const ranges = createMulticamPlan(cameraTracks, mainShots, wideShots, snapshot.fps, snapshot.duration, options.jcutOffset ?? 0);
    const emptyFrames = ranges.filter(range => range.trackIndex < 0).reduce((total, range) => total + range.endFrame - range.startFrame, 0);
    if (emptyFrames) warnings.push(`${(emptyFrames / snapshot.fps).toFixed(1)}s has no footage on any selected camera. Review those existing timeline gaps.`);
    deps.progress(85, 'Cutting the duplicate in Premiere…');
    const edited = response(await deps.request('applyMulticamCuts', 'multicamCutsApplied', { jobId, ranges }, 1200000));
    if (edited.verifiedRanges !== ranges.length) throw new Error('Premiere did not verify every camera range. Reopen the updated panel and retry from the original sequence.');
    completed = true;
    deps.progress(100, 'Your duplicate is open. Review both cameras and audio sync in Premiere.');
    return { success: true, sequenceId: edited.sequenceId, sequenceName: edited.sequenceName,
      warnings,
      stats: { segments: segments.length, shots: ranges.filter(range => range.trackIndex >= 0).length, wideShots: wideShots.length } };
  } finally {
    if (prepared) {
      try { await deps.request('discardMulticam', 'multicamDiscarded', { jobId, completed }, 30000); }
      catch (error) { console.warn('[Multicam] Could not clean up the Premiere analysis session:', error); }
    }
    fs.rmSync(audioDirectory, { recursive: true, force: true });
  }
}
