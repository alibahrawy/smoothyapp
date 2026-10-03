/**
 * VAD Runner - Pure JavaScript energy-based voice activity detection
 * Tuned to match node-vad output as closely as possible
 */

import fs from 'fs';

export interface SpeechSegment {
  start: number;
  end: number;
  speaker: string;
  rms?: number;
}

interface AudioSource {
  path: string;
  speaker: string;
}

const FRAME_SIZE = 480; // 30ms at 16kHz
const SAMPLE_RATE = 16000;

// Tuned settings to match node-vad behavior
const MIN_SPEECH_DURATION_MS = 100;   // Match node-vad default
const MAX_SILENCE_BRIDGE_MS = 300;    // Match node-vad default
const POST_MERGE_GAP_MS = 500;        // Additional merging pass

function readWavFile(filePath: string): Int16Array {
  const buffer = fs.readFileSync(filePath);

  // Parse WAV header
  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file');
  }

  // Find data chunk
  let dataOffset = 12;
  while (dataOffset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
    const chunkSize = buffer.readUInt32LE(dataOffset + 4);

    if (chunkId === 'data') {
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize;
  }

  // Read PCM data as 16-bit signed integers
  const dataLength = Math.floor((buffer.length - dataOffset) / 2);
  const samples = new Int16Array(dataLength);

  for (let i = 0; i < dataLength; i++) {
    samples[i] = buffer.readInt16LE(dataOffset + i * 2);
  }

  return samples;
}

function calculateRMS(samples: Int16Array, start: number, length: number): number {
  let sum = 0;
  const end = Math.min(start + length, samples.length);
  const count = end - start;

  if (count <= 0) return 0;

  for (let i = start; i < end; i++) {
    const normalized = samples[i] / 32768;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / count);
}

/**
 * Estimate the noise floor of the audio (bottom 10th percentile of frame energies)
 */
function estimateNoiseFloor(samples: Int16Array): number {
  const frameEnergies: number[] = [];

  for (let i = 0; i < samples.length; i += FRAME_SIZE) {
    const rms = calculateRMS(samples, i, FRAME_SIZE);
    frameEnergies.push(rms);
  }

  // Sort and get 10th percentile
  frameEnergies.sort((a, b) => a - b);
  const idx = Math.floor(frameEnergies.length * 0.1);
  return frameEnergies[idx] || 0.001;
}

/**
 * Estimate speech threshold based on audio characteristics
 * Uses adaptive thresholding: noise floor + dynamic range analysis
 */
function estimateSpeechThreshold(samples: Int16Array, aggressiveness: number): number {
  const frameEnergies: number[] = [];

  for (let i = 0; i < samples.length; i += FRAME_SIZE) {
    const rms = calculateRMS(samples, i, FRAME_SIZE);
    frameEnergies.push(rms);
  }

  frameEnergies.sort((a, b) => a - b);

  // Get noise floor (10th percentile) and speech level estimate (70th percentile)
  const noiseFloorIdx = Math.floor(frameEnergies.length * 0.1);
  const speechLevelIdx = Math.floor(frameEnergies.length * 0.7);

  const noiseFloor = frameEnergies[noiseFloorIdx] || 0.001;
  const speechLevel = frameEnergies[speechLevelIdx] || 0.01;

  // Calculate threshold as a point between noise and speech
  // Aggressiveness 0-3: less aggressive = lower threshold (more sensitive)
  // Multipliers: [1.5, 2.0, 2.5, 3.0] of noise floor, capped below speech level
  const multipliers = [1.5, 2.0, 2.5, 3.0];
  const multiplier = multipliers[Math.min(aggressiveness, 3)];

  let threshold = noiseFloor * multiplier;

  // Ensure threshold is well below speech level
  const maxThreshold = noiseFloor + (speechLevel - noiseFloor) * 0.3;
  threshold = Math.min(threshold, maxThreshold);

  // Absolute minimum/maximum bounds
  threshold = Math.max(threshold, 0.005);  // Don't go below absolute minimum
  threshold = Math.min(threshold, 0.03);   // Don't go above absolute maximum

  return threshold;
}

function detectSpeech(
  samples: Int16Array,
  speaker: string,
  aggressiveness: number = 3
): SpeechSegment[] {
  // Use adaptive threshold based on audio characteristics
  const threshold = estimateSpeechThreshold(samples, aggressiveness);
  console.log(`    Adaptive threshold: ${threshold.toFixed(4)}`);

  const segments: SpeechSegment[] = [];

  let inSpeech = false;
  let speechStart = 0;
  let silenceFrames = 0;
  let speechRmsSum = 0;
  let speechFrameCount = 0;

  // Calculate frame counts from millisecond settings
  const frameDurationMs = (FRAME_SIZE / SAMPLE_RATE) * 1000;
  const maxSilenceFrames = Math.ceil(MAX_SILENCE_BRIDGE_MS / frameDurationMs);

  for (let i = 0; i < samples.length; i += FRAME_SIZE) {
    const rms = calculateRMS(samples, i, FRAME_SIZE);
    const isSpeech = rms > threshold;

    if (isSpeech) {
      silenceFrames = 0;
      if (!inSpeech) {
        inSpeech = true;
        speechStart = i;
        speechRmsSum = rms;
        speechFrameCount = 1;
      } else {
        speechRmsSum += rms;
        speechFrameCount++;
      }
    } else {
      if (inSpeech) {
        silenceFrames++;
        if (silenceFrames >= maxSilenceFrames) {
          const startTime = speechStart / SAMPLE_RATE;
          const endTime = (i - (maxSilenceFrames - 1) * FRAME_SIZE) / SAMPLE_RATE;
          const duration = endTime - startTime;

          if (duration >= (MIN_SPEECH_DURATION_MS / 1000)) {
            const avgRms = speechFrameCount > 0 ? speechRmsSum / speechFrameCount : 0;
            segments.push({
              start: startTime,
              end: endTime,
              speaker,
              rms: avgRms
            });
          }

          inSpeech = false;
          silenceFrames = 0;
          speechRmsSum = 0;
          speechFrameCount = 0;
        }
      }
    }
  }

  // Handle speech at end of file
  if (inSpeech) {
    const startTime = speechStart / SAMPLE_RATE;
    const endTime = samples.length / SAMPLE_RATE;
    const duration = endTime - startTime;

    if (duration >= (MIN_SPEECH_DURATION_MS / 1000)) {
      const avgRms = speechFrameCount > 0 ? speechRmsSum / speechFrameCount : 0;
      segments.push({
        start: startTime,
        end: endTime,
        speaker,
        rms: avgRms
      });
    }
  }

  // Post-process: merge segments that are close together
  return mergeCloseSegments(segments, POST_MERGE_GAP_MS / 1000);
}

/**
 * Merge segments from the same speaker that are close together
 */
function mergeCloseSegments(segments: SpeechSegment[], maxGap: number): SpeechSegment[] {
  if (segments.length === 0) return [];

  const merged: SpeechSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    // Same speaker and gap is small enough to bridge
    if (next.speaker === current.speaker && (next.start - current.end) <= maxGap) {
      // Extend and average RMS
      const totalDuration = (current.end - current.start) + (next.end - next.start);
      const currentWeight = (current.end - current.start) / totalDuration;
      const nextWeight = (next.end - next.start) / totalDuration;
      current.rms = (current.rms || 0) * currentWeight + (next.rms || 0) * nextWeight;
      current.end = next.end;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }

  merged.push(current);
  return merged;
}

export async function runVad(
  sources: AudioSource[],
  aggressiveness: number = 3,
  failOnError: boolean = false
): Promise<SpeechSegment[]> {
  console.log('Running VAD analysis (Adaptive energy-based)...');
  console.log(`  Tracks: ${sources.length}`);
  console.log(`  Aggressiveness: ${aggressiveness}`);

  const allSegments: SpeechSegment[] = [];

  for (const source of sources) {
    console.log(`  Processing ${source.speaker}: ${source.path}`);

    try {
      const samples = readWavFile(source.path);
      const segments = detectSpeech(samples, source.speaker, aggressiveness);

      console.log(`    Found ${segments.length} speech segments`);
      allSegments.push(...segments);
    } catch (err) {
      console.error(`    Error processing ${source.speaker}:`, err);
      if (failOnError) throw new Error(`Could not analyse ${source.speaker}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sort by start time
  allSegments.sort((a, b) => a.start - b.start);

  console.log(`VAD complete: ${allSegments.length} total segments detected`);
  return allSegments;
}
