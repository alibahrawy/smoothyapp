import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

const retakes = await load('../src/main/autocut/retake-detector.ts');
const hasWebCatalog = existsSync(fileURLToPath(new URL('../../web/src/lib/feature-catalog.ts', import.meta.url)));
const catalog = hasWebCatalog ? await load('../../web/src/lib/feature-catalog.ts') : null;
const groups = hasWebCatalog ? await load('../../web/src/lib/feature-groups.ts') : null;
const authSource = await readFile(new URL('../src/main/auth-service.ts', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');

function makeWords(text, start, step = 0.25, gap = 0.05) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  let t = start;
  return parts.map((w) => {
    const chunk = { text: w, timestamp: [round3(t), round3(t + step)] };
    t += step + gap;
    return chunk;
  });
}

function makeAnalysis(speechPairs, totalDuration) {
  const speechSegments = speechPairs.map(([start, end]) => ({ start, end, duration: end - start }));
  const silenceSegments = retakes.complementSpeechSegments(speechSegments, totalDuration);
  const silenceRemoved = silenceSegments.reduce((s, seg) => s + seg.duration, 0);
  return {
    originalDuration: totalDuration,
    silenceRemoved,
    newDuration: totalDuration - silenceRemoved,
    cutsCount: speechSegments.length,
    speechSegments,
    silenceSegments,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

test('drops exact and near-duplicate repeated sentences and keeps the last take', () => {
  const analysis = makeAnalysis([[0, 3], [4.5, 8], [9.5, 13]], 13.5);
  const chunks = [
    ...makeWords('Today we are going to build a cool editor.', 0.1),
    ...makeWords('Today we are going to build a great editor.', 4.6),
    ...makeWords('Let us open the project first.', 9.6),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced', padding: 0.1 });
  assert.equal(result.retakesCount, 1);
  assert.equal(result.removedRetakes[0].reason, 'repeat');
  assert.equal(result.removedRetakes[0].start, 0);
  assert.equal(result.removedRetakes[0].end, 3);
  assert.match(result.removedRetakes[0].matchedText, /great editor/);
  assert.deepEqual(
    result.speechSegments.map(s => [s.start, s.end]),
    [[4.5, 8], [9.5, 13]]
  );
  // First silence merges the dropped retake [0..3] with the pause [3..4.5] into one clean cut [0..4.5].
  assert.deepEqual(
    result.silenceSegments.map(s => [round3(s.start), round3(s.end)]),
    [[0, 4.5], [8, 9.5], [13, 13.5]]
  );
});

test('catches stumbled false starts including lead-in filler shifts', () => {
  const analysis = makeAnalysis([[0, 2.2], [3.4, 7.5], [9.0, 11.0], [12.5, 16.5]], 17);
  const chunks = [
    ...makeWords('So today we are going', 0.1),
    ...makeWords('So today we are going to ship repeated takes removal.', 3.5),
    ...makeWords('Okay so first open Premiere', 9.1),
    ...makeWords('First open Premiere and load your active timeline.', 12.6),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 2);
  assert.equal(result.removedRetakes[0].reason, 'false-start');
  assert.equal(result.removedRetakes[1].reason, 'false-start');
  assert.deepEqual(
    result.speechSegments.map(s => [s.start, s.end]),
    [[3.4, 7.5], [12.5, 16.5]]
  );
});

test('handles 3-take chains and keeps only the final clean take', () => {
  const analysis = makeAnalysis([[0, 1.8], [3, 5.5], [7, 11]], 11.5);
  const chunks = [
    ...makeWords('In this video I want', 0.1),
    ...makeWords('In this video I want to show you how', 3.1),
    ...makeWords('In this video I want to show you how silence removal works.', 7.1),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 2);
  assert.deepEqual(result.speechSegments.map(s => [s.start, s.end]), [[7, 11]]);
  // Both dropped takes resolve matchedText to the final kept take.
  for (const r of result.removedRetakes) {
    assert.match(r.matchedText, /silence removal works/);
  }
});

test('handles repeated takes separated by a short pause inside one continuous speech segment', () => {
  // Pause between takes is 0.45s (shorter than a 1.0s minSilenceDuration), so both sit in one speechSegment.
  const analysis = makeAnalysis([[0, 8.5]], 9.0);
  const first = makeWords('Welcome back to the channel', 0.2, 0.25, 0.05); // ends at 1.65
  const second = makeWords('Welcome back to the channel everyone today we edit fast.', 2.2, 0.25, 0.05);
  const third = makeWords('Let us jump right into it.', 6.0, 0.25, 0.05);

  const result = retakes.detectRepeatedTakes(analysis, [...first, ...second, ...third], {
    sensitivity: 'balanced',
    padding: 0.1,
  });

  assert.equal(result.retakesCount, 1);
  assert.equal(result.removedRetakes[0].reason, 'false-start');
  // Second and third utterances are both kept inside segment 0 -> merged back into one unbroken kept segment!
  assert.equal(result.speechSegments.length, 1);
  assert.ok(result.speechSegments[0].start > 1.6 && result.speechSegments[0].start <= 2.2);
  assert.equal(result.speechSegments[0].end, 8.5);
});

test('handles immediate in-utterance restart with no pause at all', () => {
  const analysis = makeAnalysis([[0, 5.5]], 6.0);
  const chunks = makeWords(
    'Today we are going Today we are going to fix the timeline audio.',
    0.1,
    0.22,
    0.04
  );

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 1);
  assert.equal(result.speechSegments.length, 1);
  assert.ok(result.speechSegments[0].start >= 1.0, 'keeps from the restarted take onward');
});

test('protects sequential numbered/ordinal points and single-word emphasis from false positives', () => {
  const analysis = makeAnalysis([
    [0, 2.5], [3.5, 6.0],
    [7.5, 10.0], [11.0, 13.5],
    [15.0, 15.8], [16.5, 17.3],
  ], 18.0);
  const chunks = [
    ...makeWords('Step 1 open the sequence.', 0.1),
    ...makeWords('Step 2 open the sequence.', 3.6),
    ...makeWords('First we check the audio track.', 7.6),
    ...makeWords('Second we check the audio track.', 11.1),
    ...makeWords('Never.', 15.1),
    ...makeWords('Never.', 16.6),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 0);
  assert.equal(result.speechSegments.length, 6);
});

test('tolerates minor Whisper spelling variations and contractions', () => {
  const analysis = makeAnalysis([[0, 3], [4, 7.5]], 8);
  const chunks = [
    ...makeWords("We're gonna test smoothie audio cleanup", 0.1),
    ...makeWords('We are going to test smoothy audio cleanup today', 4.1),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 1);
  assert.deepEqual(result.speechSegments.map(s => [s.start, s.end]), [[4, 7.5]]);
});

test('supports Arabic normalization (diacritics, alef and teh marbuta variants)', () => {
  assert.equal(retakes.normalizeRetakeWord('أَهْلاً'), 'اهلا');
  assert.equal(retakes.normalizeRetakeWord('المدرسة'), 'المدرسه');
  assert.equal(retakes.normalizeRetakeWord('إلى'), 'الي');

  const analysis = makeAnalysis([[0, 2.5], [3.8, 7.2]], 7.5);
  const chunks = [
    ...makeWords('اليوم سوف نشرح الطريقة', 0.1),
    ...makeWords('اليوم سوف نشرح الطريقه الصحيحه للمونتاج', 3.9),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 1);
  assert.deepEqual(result.speechSegments.map(s => [s.start, s.end]), [[3.8, 7.2]]);
});

test('looks past a tiny fumble between two identical takes without cutting unrelated content', () => {
  const analysis = makeAnalysis([[0, 2.5], [3.0, 3.8], [4.5, 7.5]], 8.0);
  const chunks = [
    ...makeWords('Here is how you export faster', 0.1),
    ...makeWords('wait sorry', 3.1),
    ...makeWords('Here is how you export faster in Premiere.', 4.6),
  ];

  const result = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'balanced' });
  assert.equal(result.retakesCount, 1);
  assert.equal(result.removedRetakes[0].start, 0);
  assert.equal(result.removedRetakes[0].end, 2.5);
});

test('sensitivity levels adjust matching strictness cleanly', () => {
  const analysis = makeAnalysis([[0, 3], [4, 7.5]], 8);
  // 4 of 6 words overlap (~0.67 F1) — caught by aggressive, spared by conservative.
  const chunks = [
    ...makeWords('Today we make great fast edits', 0.1),
    ...makeWords('Today we build great fast videos', 4.1),
  ];

  const conservative = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'conservative' });
  const aggressive = retakes.detectRepeatedTakes(analysis, chunks, { sensitivity: 'aggressive' });
  assert.equal(conservative.retakesCount, 0);
  assert.equal(aggressive.retakesCount, 1);
});

test('Pro gating and mandatory feature usage catalog entries are wired', () => {
  assert.match(authSource, /PRO_FEATURES\s*=\s*\[[^\]]*'silence_retakes'/);
  assert.match(mainSource, /wantsRetakes\s*&&\s*!hasPro\(\)/);
  assert.match(mainSource, /trackTool\('silence_retakes'\)/);
  assert.match(mainSource, /feature === 'silence_retakes'/);
  if (catalog && groups) {
    assert.equal(typeof catalog.DESKTOP_FEATURES.silence_retakes, 'string');
    assert.equal(typeof catalog.DESKTOP_FEATURES.pro_upgrade_silence_retakes, 'string');
    assert.equal(groups.featureGroupId('desktop', 'silence_retakes'), 'editing');
    assert.equal(groups.featureGroupId('desktop', 'pro_upgrade_silence_retakes'), 'pro');
    assert.equal(groups.isNewFeature('desktop', 'silence_retakes'), true);
  }
});
