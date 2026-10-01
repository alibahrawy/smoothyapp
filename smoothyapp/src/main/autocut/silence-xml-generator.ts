/** Ripple every selected media track through the same frame-aligned edit map. */
import type { SpeechSegment } from './silence-detector';
import { createTimelineXml, type TimelineTrack, type TimelineXmlOptions, type EditRange } from './timeline-xml';

export function generateSilenceRemovalXML(
  tracks: TimelineTrack[], segments: SpeechSegment[], options: TimelineXmlOptions = {}
): string {
  const xml = createTimelineXml(tracks, options.audioTracks ?? [], options);
  const fps = options.fps ?? 23.976;
  const ranges: EditRange[] = [];
  let destination = 0;
  let previousEnd = 0;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const start = Math.max(previousEnd, xml.frame(segment.start));
    const end = xml.frame(segment.end);
    if (end <= start) continue;
    ranges.push({ start: start / fps, end: end / fps, destination: destination / fps });
    destination += end - start;
    previousEnd = end;
  }
  const video = tracks.map(track => xml.renderTrack(track, ranges, 'video'));
  const audio = (options.audioTracks ?? []).map(track => xml.renderTrack(track, ranges, 'audio'));
  return xml.render(options.sequenceName ?? 'Silence Removed', destination, video, audio);
}
