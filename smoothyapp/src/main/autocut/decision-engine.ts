/**
 * Decision Engine - Transforms speech segments into camera shot decisions
 */

import type { SpeechSegment } from './vad-runner';

export interface ShotDecision {
  start: number;
  end: number;
  camera: number;
  speaker: string;
  reason: string;
}

export interface OverlapRegion {
  start: number;
  end: number;
  duration: number;
}

export interface AutocutResult {
  mainShots: ShotDecision[];
  wideShots: ShotDecision[];
}

interface DecisionOptions {
  totalDuration: number;
  minSegmentDuration?: number;
  paddingBefore?: number;
  paddingAfter?: number;
  minShotDuration?: number;
  holdTimeBeforeSwitch?: number;
  wideCameraIndex?: number;
  // New options for overlap-based wide shots
  useOverlapWideShots?: boolean;
  minOverlapDuration?: number;      // Minimum overlap duration to trigger wide shot (0.5s)
  wideShowDuration?: number;        // How long to show wide shot (5s)
}

// Default configuration - matches original Carrot node-orchestrator
const DEFAULT_CONFIG = {
  minSegmentDuration: 1.0,    // Filter segments < 1 second (node-vad produces longer segments)
  paddingBefore: -0.4,        // Negative = reaction cut (hear 0.4s then see speaker)
  paddingAfter: 0.3,          // Hold on speaker briefly after they stop
  minShotDuration: 0.8,       // Min time on any camera (from UI slider default)
  holdTimeBeforeSwitch: 1.0,  // Min time before switching cameras
  maxGapToBridge: 0.5,        // Bridge gaps within same speaker
  wideCameraIndex: -1,
  // Overlap-based wide shot settings
  useOverlapWideShots: false, // Enable overlap-triggered wide shots
  minOverlapDuration: 0.5,    // Minimum overlap duration to trigger/extend wide shot
  wideShowDuration: 5.0       // Wide shot shows for 5 seconds (extends if more overlaps)
};

function filterShortSegments(segments: SpeechSegment[], minDuration: number): SpeechSegment[] {
  return segments.filter(seg => (seg.end - seg.start) >= minDuration);
}

function mergeAdjacentSegments(segments: SpeechSegment[], maxGap: number): SpeechSegment[] {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: SpeechSegment[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.speaker === current.speaker && next.start - current.end <= maxGap) {
      current.end = next.end;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

function resolveOverlaps(segments: SpeechSegment[]): Array<{ start: number; end: number; speaker: string }> {
  if (segments.length === 0) return [];

  const events: Array<{ time: number; type: 'start' | 'end'; segment: SpeechSegment }> = [];
  for (const seg of segments) {
    events.push({ time: seg.start, type: 'start', segment: seg });
    events.push({ time: seg.end, type: 'end', segment: seg });
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.type === 'end' ? -1 : 1;
  });

  const activeSegments = new Set<SpeechSegment>();
  const resolved: Array<{ start: number; end: number; speaker: string }> = [];
  let lastTime = 0;

  for (const event of events) {
    if (event.time > lastTime && activeSegments.size > 0) {
      const active = Array.from(activeSegments);
      // Simple: first one wins (or could compare by loudness if available)
      resolved.push({
        start: lastTime,
        end: event.time,
        speaker: active[0].speaker
      });
    }

    if (event.type === 'start') {
      activeSegments.add(event.segment);
    } else {
      activeSegments.delete(event.segment);
    }

    lastTime = event.time;
  }

  return resolved;
}

function mergeConsecutive(intervals: Array<{ start: number; end: number; speaker: string }>): typeof intervals {
  if (intervals.length === 0) return [];

  const merged: typeof intervals = [];
  let current = { ...intervals[0] };

  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];
    if (next.speaker === current.speaker) {
      current.end = next.end;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

function enforceMinShotDuration(shots: ShotDecision[], minDuration: number): ShotDecision[] {
  const adjusted: ShotDecision[] = [];

  for (let i = 0; i < shots.length; i++) {
    const shot = { ...shots[i] };
    const duration = shot.end - shot.start;

    if (duration < minDuration && i < shots.length - 1) {
      shot.end = Math.min(shot.end + (minDuration - duration), shots[i + 1].end);
    } else if (duration < minDuration) {
      shot.end = shot.start + minDuration;
    }

    if (adjusted.length > 0 && shot.start < adjusted[adjusted.length - 1].end) {
      shot.start = adjusted[adjusted.length - 1].end;
    }

    if (shot.end > shot.start) {
      adjusted.push(shot);
    }
  }

  return adjusted;
}

function enforceHoldTime(shots: ShotDecision[], holdTime: number): ShotDecision[] {
  if (shots.length === 0) return [];

  const adjusted: ShotDecision[] = [shots[0]];

  for (let i = 1; i < shots.length; i++) {
    const prev = adjusted[adjusted.length - 1];
    const current = { ...shots[i] };
    const timeSinceLastCut = current.start - prev.start;

    if (timeSinceLastCut < holdTime && prev.camera !== current.camera) {
      prev.end = current.end;
    } else {
      adjusted.push(current);
    }
  }

  return adjusted;
}

function fillGaps(shots: ShotDecision[], totalDuration: number, wideCameraIndex: number): ShotDecision[] {
  if (shots.length === 0) {
    return wideCameraIndex >= 0 ? [{
      start: 0,
      end: totalDuration,
      camera: wideCameraIndex,
      speaker: 'none',
      reason: 'silence'
    }] : [];
  }

  const filled: ShotDecision[] = [];

  if (shots[0].start > 0) {
    const gapCam = wideCameraIndex >= 0 ? wideCameraIndex : shots[0].camera;
    filled.push({ start: 0, end: shots[0].start, camera: gapCam, speaker: 'none', reason: 'gap_start' });
  }

  for (let i = 0; i < shots.length; i++) {
    filled.push(shots[i]);
    if (i < shots.length - 1 && shots[i + 1].start > shots[i].end) {
      const gapCam = wideCameraIndex >= 0 ? wideCameraIndex : shots[i].camera;
      filled.push({ start: shots[i].end, end: shots[i + 1].start, camera: gapCam, speaker: 'none', reason: 'gap' });
    }
  }

  const last = shots[shots.length - 1];
  if (last.end < totalDuration) {
    const gapCam = wideCameraIndex >= 0 ? wideCameraIndex : last.camera;
    filled.push({ start: last.end, end: totalDuration, camera: gapCam, speaker: 'none', reason: 'gap_end' });
  }

  return filled;
}

/**
 * Detect overlapping speech regions where multiple speakers talk simultaneously
 */
function detectOverlaps(segments: SpeechSegment[], minOverlapDuration: number): OverlapRegion[] {
  if (segments.length < 2) return [];

  // Create timeline events
  const events: Array<{ time: number; type: 'start' | 'end'; speaker: string }> = [];
  for (const seg of segments) {
    events.push({ time: seg.start, type: 'start', speaker: seg.speaker });
    events.push({ time: seg.end, type: 'end', speaker: seg.speaker });
  }

  // Sort events by time
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // Process ends before starts at same time
    return a.type === 'end' ? -1 : 1;
  });

  const overlaps: OverlapRegion[] = [];
  const activeSpeakers = new Set<string>();
  let overlapStart: number | null = null;

  for (const event of events) {
    const wasOverlapping = activeSpeakers.size >= 2;

    if (event.type === 'start') {
      activeSpeakers.add(event.speaker);
    } else {
      activeSpeakers.delete(event.speaker);
    }

    const isOverlapping = activeSpeakers.size >= 2;

    // Overlap just started
    if (!wasOverlapping && isOverlapping) {
      overlapStart = event.time;
    }
    // Overlap just ended
    else if (wasOverlapping && !isOverlapping && overlapStart !== null) {
      const duration = event.time - overlapStart;
      if (duration >= minOverlapDuration) {
        overlaps.push({
          start: overlapStart,
          end: event.time,
          duration
        });
      }
      overlapStart = null;
    }
  }

  console.log(`Detected ${overlaps.length} overlap regions (min duration: ${minOverlapDuration}s)`);
  return overlaps;
}

/**
 * Generate wide shot decisions based on overlaps with 5-second rule
 * - Each overlap triggers a wide shot for `wideShowDuration` seconds
 * - If another overlap (>= minOverlapDuration) occurs within that window, extend the wide shot
 */
function generateWideShotDecisions(
  overlaps: OverlapRegion[],
  wideCameraIndex: number,
  wideShowDuration: number,
  minOverlapDuration: number,
  totalDuration: number
): ShotDecision[] {
  if (overlaps.length === 0 || wideCameraIndex < 0) return [];

  const wideShots: ShotDecision[] = [];
  let currentWideStart: number | null = null;
  let currentWideEnd: number | null = null;

  for (const overlap of overlaps) {
    // Check if this overlap is within the current wide shot window
    if (currentWideStart !== null && currentWideEnd !== null) {
      // If overlap starts within the current wide shot window AND is long enough
      if (overlap.start <= currentWideEnd && overlap.duration >= minOverlapDuration) {
        // Extend the wide shot from this overlap's start
        currentWideEnd = Math.min(overlap.start + wideShowDuration, totalDuration);
        continue;
      } else if (overlap.start > currentWideEnd) {
        // Current wide shot is done, save it
        wideShots.push({
          start: currentWideStart,
          end: currentWideEnd,
          camera: wideCameraIndex,
          speaker: 'overlap',
          reason: 'overlap_wide'
        });
        currentWideStart = null;
        currentWideEnd = null;
      }
    }

    // Start a new wide shot region
    if (currentWideStart === null) {
      currentWideStart = overlap.start;
      currentWideEnd = Math.min(overlap.start + wideShowDuration, totalDuration);
    }
  }

  // Don't forget the last wide shot
  if (currentWideStart !== null && currentWideEnd !== null) {
    wideShots.push({
      start: currentWideStart,
      end: currentWideEnd,
      camera: wideCameraIndex,
      speaker: 'overlap',
      reason: 'overlap_wide'
    });
  }

  console.log(`Generated ${wideShots.length} wide shot decisions from overlaps`);
  return wideShots;
}

export function generateShotDecisions(
  segments: SpeechSegment[],
  speakerToCameraMap: Record<string, number>,
  options: DecisionOptions
): AutocutResult {
  const opts = { ...DEFAULT_CONFIG, ...options };

  console.log('Decision Engine starting...');
  console.log('  Input segments:', segments.length);
  console.log('  Total duration:', opts.totalDuration, 'seconds');
  console.log('  Speaker to Camera Map:', JSON.stringify(speakerToCameraMap));
  console.log('  Use Overlap Wide Shots:', opts.useOverlapWideShots);
  console.log('  Wide Camera Index:', opts.wideCameraIndex);

  // Detect overlaps BEFORE processing (on raw merged segments)
  // We need to do this early to capture true overlaps
  let wideShots: ShotDecision[] = [];

  if (segments.length === 0) {
    // For gap filling, use the old wideCameraIndex behavior (not overlap-based)
    const gapWideCam = opts.useOverlapWideShots ? -1 : opts.wideCameraIndex;
    return {
      mainShots: fillGaps([], opts.totalDuration, gapWideCam),
      wideShots: []
    };
  }

  // Filter short segments
  let processed = filterShortSegments(segments, opts.minSegmentDuration);
  console.log(`After min duration filter: ${processed.length} segments`);

  // Merge adjacent from same speaker
  processed = mergeAdjacentSegments(processed, opts.maxGapToBridge);
  console.log(`After merging adjacent: ${processed.length} segments`);

  // Detect overlaps BEFORE resolving them (this is where we find simultaneous speech)
  if (opts.useOverlapWideShots && opts.wideCameraIndex >= 0) {
    const overlaps = detectOverlaps(processed, opts.minOverlapDuration);
    wideShots = generateWideShotDecisions(
      overlaps,
      opts.wideCameraIndex,
      opts.wideShowDuration,
      opts.minOverlapDuration,
      opts.totalDuration
    );
  }

  // Apply padding
  // paddingBefore is negative (-0.4) means cut 0.4s AFTER speech starts (reaction cut)
  // So we SUBTRACT paddingBefore: start - (-0.4) = start + 0.4
  processed = processed.map(seg => ({
    ...seg,
    start: Math.max(0, seg.start - opts.paddingBefore),
    end: seg.end + opts.paddingAfter
  }));

  // Resolve overlaps (for main track, first speaker wins)
  const resolved = resolveOverlaps(processed);
  console.log(`After overlap resolution: ${resolved.length} intervals`);

  // Merge consecutive same-speaker
  const merged = mergeConsecutive(resolved);
  console.log(`After merging consecutive: ${merged.length} intervals`);

  // Convert to shots with camera indices
  let shots: ShotDecision[] = merged.map(interval => ({
    start: interval.start,
    end: interval.end,
    camera: speakerToCameraMap[interval.speaker] ?? 0,
    speaker: interval.speaker,
    reason: 'speech'
  }));

  // Enforce minimum shot duration
  shots = enforceMinShotDuration(shots, opts.minShotDuration);
  console.log(`After min shot duration: ${shots.length} shots`);

  // Enforce hold time
  shots = enforceHoldTime(shots, opts.holdTimeBeforeSwitch);
  console.log(`After hold time: ${shots.length} shots`);

  // Fill gaps - if using overlap wide shots, don't use wide cam for gaps
  const gapWideCam = opts.useOverlapWideShots ? -1 : opts.wideCameraIndex;
  shots = fillGaps(shots, opts.totalDuration, gapWideCam);
  console.log(`After filling gaps: ${shots.length} shots`);

  // Final merge of consecutive same-camera
  const final: ShotDecision[] = [];
  for (const shot of shots) {
    if (final.length > 0 && final[final.length - 1].camera === shot.camera) {
      final[final.length - 1].end = shot.end;
    } else {
      final.push(shot);
    }
  }

  console.log(`Final main shot count: ${final.length}`);
  console.log(`Final wide shot count: ${wideShots.length}`);

  return {
    mainShots: final,
    wideShots
  };
}
