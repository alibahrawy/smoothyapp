import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ entryPoints: [new URL('../src/renderer/caption-text-tools.js', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { findCaptionMatches, replaceCaptionMatches } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const caption = (text, index = 1) => ({ index, text, startTime: (index - 1) * 3, endTime: index * 3 });

test('finds repeated words across captions without matching inside other words', () => {
  const captions = [caption('Word word words sword.'), caption('WORD\nword', 2)];
  const matches = findCaptionMatches(captions, 'word', { wholeWords: true });
  assert.deepEqual(matches.map(match => [match.captionIndex, match.start]), [[0, 0], [0, 5], [1, 0], [1, 5]]);
  assert.equal(findCaptionMatches(captions, 'word', { wholeWords: true, matchCase: true }).length, 2);
  assert.equal(findCaptionMatches(captions, 'word').length, 6);
});

test('search and replacement treat special characters and dollar signs literally', () => {
  const captions = [caption('a.b [word] a.b aXb')];
  const matches = findCaptionMatches(captions, 'a.b');
  assert.equal(matches.length, 2);
  assert.equal(replaceCaptionMatches(captions, matches, '$& $1')[0].text, '$& $1 [word] $& $1 aXb');
  assert.equal(findCaptionMatches(captions, '[word]').length, 1);
});

test('whole-word search respects Arabic letters, accents and combining marks', () => {
  assert.equal(findCaptionMatches([caption('خطأ خطأ وخطأ')], 'خطأ', { wholeWords: true }).length, 2);
  assert.equal(findCaptionMatches([caption('café cafétéria CAFÉ')], 'café', { wholeWords: true }).length, 2);
  assert.equal(findCaptionMatches([caption('cafe\u0301 cafe')], 'cafe', { wholeWords: true }).length, 1);
  assert.equal(findCaptionMatches([caption('字幕字幕')], '字幕').length, 2);
});

test('Replace all keeps timings, metadata and source text intact', () => {
  const captions = [caption('wrong wrong.'), caption('wrong again', 2)];
  const originals = structuredClone(captions);
  const replaced = replaceCaptionMatches(captions, findCaptionMatches(captions, 'wrong'), 'correct phrase');
  assert.deepEqual(replaced.map(cap => cap.text), ['correct phrase correct phrase.', 'correct phrase again']);
  assert.deepEqual(captions, originals);
  assert.deepEqual(replaced.map(({ text, ...metadata }) => metadata), originals.map(({ text, ...metadata }) => metadata));
});

test('Replace changes only the selected occurrence and empty replacement removes it', () => {
  const captions = [caption('wrong wrong'), caption('wrong', 2)];
  const matches = findCaptionMatches(captions, 'wrong');
  assert.deepEqual(replaceCaptionMatches(captions, [matches[1]], '').map(cap => cap.text), ['wrong ', 'wrong']);
  assert.deepEqual(findCaptionMatches(captions, ''), []);
  assert.deepEqual(replaceCaptionMatches(captions, [], 'anything'), captions);
});
