import type { ShotDecision } from './decision-engine';

export interface CameraTrack {
  index: number;
  clips: { start: number; end: number; disabled?: boolean }[];
}
export interface CameraRange { startFrame: number; endFrame: number; trackIndex: number }

/** Select existing timeline objects. Paths, source trims and nest contents are irrelevant. */
export function createMulticamPlan(tracks: CameraTrack[], shots: ShotDecision[], wideShots: ShotDecision[], fps: number, duration: number, offset = 0): CameraRange[] {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Refresh Premiere to load the sequence duration and frame rate.');
  if (!tracks.length || new Set(tracks.map(track => track.index)).size !== tracks.length || tracks.some(track => !Number.isInteger(track.index) || track.index < 0 || !Array.isArray(track.clips))) throw new Error('Choose valid camera tracks.');
  if (!Number.isFinite(offset) || offset < 0) throw new Error('Invalid J-cut offset.');
  const last = Math.round(duration * fps);
  const frame = (time: number) => Math.max(0, Math.min(last, Math.round(time * fps)));
  const shotRange = (shot: ShotDecision, delay: boolean, index: number, count: number) => {
    if (![shot.start, shot.end].every(Number.isFinite) || shot.end <= shot.start || !Number.isInteger(shot.camera) || !tracks[shot.camera]) throw new Error('Invalid camera decision.');
    return { start: frame(shot.start + (delay && index > 0 ? offset : 0)), end: frame(shot.end + (delay && index < count - 1 ? offset : 0)), camera: shot.camera };
  };
  const main = shots.map((shot, index) => shotRange(shot, true, index, shots.length)).filter(shot => shot.end > shot.start);
  const wide = wideShots.map(shot => shotRange({ ...shot, start: shot.start + offset, end: shot.end + offset }, false, 0, 1)).filter(shot => shot.end > shot.start);
  if (!main.length) throw new Error('No usable camera decisions were generated.');
  const clips = tracks.map(track => track.clips.filter(clip => !clip.disabled).map(clip => {
    if (![clip.start, clip.end].every(Number.isFinite) || clip.start < 0 || clip.end <= clip.start) throw new Error('Refresh Premiere to load valid camera clip positions.');
    return { start: frame(clip.start), end: frame(clip.end) };
  }));
  const boundaries = [...new Set([0, last, ...main.flatMap(shot => [shot.start, shot.end]), ...wide.flatMap(shot => [shot.start, shot.end]), ...clips.flatMap(track => track.flatMap(clip => [clip.start, clip.end]))])].sort((a, b) => a - b);
  const plan: CameraRange[] = [];
  let previousCamera = main[0].camera;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    const available = (camera: number) => clips[camera].some(clip => clip.start <= start && clip.end >= end);
    const wideShot = wide.find(shot => shot.start <= start && shot.end >= end);
    const mainShot = main.find(shot => shot.start <= start && shot.end >= end);
    const preferred = wideShot && available(wideShot.camera) ? wideShot.camera : mainShot?.camera ?? previousCamera;
    const camera = available(preferred) ? preferred : available(previousCamera) ? previousCamera : clips.findIndex((_, index) => available(index));
    const trackIndex = camera < 0 ? -1 : tracks[camera].index;
    const prev = plan[plan.length - 1];
    if (prev && prev.trackIndex === trackIndex && prev.endFrame === start) prev.endFrame = end;
    else plan.push({ startFrame: start, endFrame: end, trackIndex });
    if (camera >= 0) previousCamera = camera;
  }
  return plan;
}
