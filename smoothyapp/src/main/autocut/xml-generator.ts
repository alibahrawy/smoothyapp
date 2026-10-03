/** Timeline-aware multicam reconstruction with continuous selected microphone audio. */
import type { ShotDecision } from './decision-engine';
import { createTimelineXml, type TimelineTrack, type TimelineXmlOptions } from './timeline-xml';

interface XmlOptions extends TimelineXmlOptions { jcutOffset?: number }

export function generateMulticamSequenceXML(
  tracks: TimelineTrack[], shots: ShotDecision[], options: XmlOptions = {}, wideShots: ShotDecision[] = []
): string {
  if (!tracks.length) throw new Error('Select at least one camera.');
  const duration = options.duration ?? Math.max(0, ...shots.map(shot => shot.end), ...wideShots.map(shot => shot.end));
  const xml = createTimelineXml(tracks, options.audioTracks ?? [], options);
  const offset = Math.max(0, options.jcutOffset ?? 0);
  // Microphone audio remains synced. Delay the visual switch after a speaker's
  // onset by the selected offset; the first and final boundaries stay fixed.
  const delayed = shots.map((shot, index) => ({ ...shot,
    start: index === 0 ? shot.start : Math.min(duration, shot.start + offset),
    end: index === shots.length - 1 ? shot.end : Math.min(duration, shot.end + offset)
  }));
  const rangesFor = (list: ShotDecision[], camera: number) => list.filter(shot => shot.camera === camera && shot.end > shot.start)
    .map(shot => ({ start: shot.start, end: shot.end, destination: shot.start }));
  for (const shot of [...shots, ...wideShots]) {
    if (!Number.isInteger(shot.camera) || !tracks[shot.camera]) throw new Error('Choose a valid camera for every speaker.');
  }
  // The upper track is the selected cut. The lower track retains alternates.
  const main = xml.renderCombinedTrack(tracks.map((track, camera) => ({ track, ranges: rangesFor(delayed, camera) })), 'video');
  const alternatives = xml.renderCombinedTrack(tracks.map((track, camera) => ({ track,
    ranges: delayed.filter(shot => tracks.length > 1 && (shot.camera + 1) % tracks.length === camera)
      .map(shot => ({ start: shot.start, end: shot.end, destination: shot.start })) })), 'video');
  const video = [alternatives, main];
  if (wideShots.length) video.push(xml.renderCombinedTrack(tracks.map((track, camera) => ({ track,
    ranges: rangesFor(wideShots.map(shot => ({ ...shot, start: Math.min(duration, shot.start + offset), end: Math.min(duration, shot.end + offset) })), camera) })), 'video'));
  const audio = (options.audioTracks ?? []).map(track => xml.renderTrack(track, [{ start: 0, end: duration, destination: 0 }], 'audio'));
  return xml.render(options.sequenceName ?? 'Auto-Switch Sequence', xml.frame(duration), video, audio);
}
