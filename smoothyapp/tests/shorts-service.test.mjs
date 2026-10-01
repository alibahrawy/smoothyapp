import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const serviceBundle = await build({ entryPoints: [new URL('../src/main/shorts-service.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false });
const { runShortsAnalysis } = await import(`data:text/javascript;base64,${Buffer.from(serviceBundle.outputFiles[0].text).toString('base64')}`);
const shorts = [{ title: 'A useful moment', description: 'One clear idea.', startTime: '00:00:10', endTime: '00:00:55' }];
function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      prepareAudio: async config => { calls.push(['audio', config]); return { subtitleText: 'Timed transcript', fileName: 'Interview.wav', duration: 180 }; },
      analyze: async (...args) => { calls.push(['analyze', ...args]); return { shorts }; },
      saveHistory: async (...args) => { calls.push(['save', ...args]); },
      getCredits: async () => ({ credits: 95 }),
      progress: () => {},
      ...overrides
    }
  };
}

test('uploaded transcripts work without preparing Premiere or audio, and preserve Best Part mode', async () => {
  const { calls, deps } = fixture();
  const result = await runShortsAnalysis({ source: 'transcript', subtitleText: '[0:10] One clear idea.', fileName: 'Notes.txt', shortsMode: 'best' }, deps);
  assert.deepEqual(calls[0], ['analyze', '[0:10] One clear idea.', undefined, 'best']);
  assert.equal(calls.some(call => call[0] === 'audio'), false);
  assert.equal(calls[1][2], 'Notes.txt');
  assert.deepEqual(JSON.parse(calls[1][1]), { shorts });
  assert.equal(result.fileName, 'Notes.txt');
});

test('YouTube transcripts use the same analysis and history flow', async () => {
  const { calls, deps } = fixture();
  await runShortsAnalysis({ source: 'youtube', subtitleText: '[0:10] Video transcript', fileName: 'YouTube workshop' }, deps);
  assert.deepEqual(calls[0], ['analyze', '[0:10] Video transcript', undefined, 'multiple']);
  assert.equal(calls[1][2], 'YouTube workshop');
});

test('audio and Premiere sources forward their source and timing to transcription', async () => {
  for (const input of [{ source: 'audio', audioPath: '/tmp/interview.wav' }, { source: 'sequence', trackIndices: [1] }]) {
    const { calls, deps } = fixture();
    const result = await runShortsAnalysis(input, deps);
    assert.equal(calls[0][1].source, input.source);
    assert.deepEqual(calls[1], ['analyze', 'Timed transcript', 180, 'multiple']);
    assert.equal(result.duration, 180);
  }
});

test('empty, oversized, and unsupported inputs fail before cloud analysis', async () => {
  for (const input of [{ source: 'transcript', subtitleText: ' ' }, { source: 'transcript', subtitleText: 'a'.repeat(2_000_001) }, { source: 'unsupported' }, { source: 'transcript', shortsMode: 'invalid' }]) {
    const { calls, deps } = fixture();
    await assert.rejects(runShortsAnalysis(input, deps));
    assert.equal(calls.length, 0);
  }
});

test('history and credits failures preserve successful results with a visible warning', async () => {
  const { deps } = fixture({ saveHistory: async () => { throw new Error('Offline'); }, getCredits: async () => { throw new Error('Offline'); } });
  const result = await runShortsAnalysis({ source: 'transcript', subtitleText: 'A transcript' }, deps);
  assert.deepEqual(result.shorts, shorts);
  assert.match(result.warning, /could not be saved/);
  assert.equal(result.credits, null);
});

test('empty AI results never create an empty history run', async () => {
  const { calls, deps } = fixture({ analyze: async () => ({ shorts: [] }) });
  await assert.rejects(runShortsAnalysis({ source: 'transcript', subtitleText: 'A transcript' }, deps), /No shorts found/);
  assert.equal(calls.some(call => call[0] === 'save'), false);
});

// Bundle only the API client, replacing the local credential store with dummy
// credentials. All fetch calls below are intercepted; no cloud credits are used.
const bundle = await build({
  entryPoints: [new URL('../src/main/web-api.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'fixture-auth', setup(builder) {
    builder.onResolve({ filter: /^\.\/auth-service$/ }, () => ({ path: 'fixture-auth', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getStoredUserId = () => "test-user"; export const getAuthHeaders = () => ({"Content-Type":"application/json",Authorization:"Bearer test-session"});' }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('cloud analysis sends the selected mode with a signed session and omits unknown duration', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(url, /\/api\/analyze$/);
      assert.equal(options.headers.Authorization, 'Bearer test-session');
      assert.deepEqual(JSON.parse(options.body), { subtitleText: 'Transcript', analysisMode: 'shorts', shortsMode: 'best' });
      return new Response(JSON.stringify({ shorts }));
    };
    assert.deepEqual((await api.analyzeShorts('Transcript', undefined, 'best')).shorts, shorts);
  } finally { globalThis.fetch = original; }
});

test('YouTube loading validates URLs and forwards API errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.match(url, /\/api\/youtube-transcript$/);
      assert.equal(options.headers.Authorization, 'Bearer test-session');
      return new Response(JSON.stringify({ transcript: '[0:10] A video', videoTitle: 'Workshop' }));
    };
    const result = await api.getYoutubeTranscript('https://youtu.be/abcdefghijk');
    assert.equal(result.fileName, 'Workshop');
    for (const url of ['bad url', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'file:///private/tmp/video', 'https://example.com/video']) {
      await assert.rejects(api.getYoutubeTranscript(url), /YouTube/);
    }
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(api.getYoutubeTranscript('https://youtube.com/watch?v=abcdefghijk'), api.NotSignedInError);
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'No captions available' }), { status: 422 });
    await assert.rejects(api.getYoutubeTranscript('https://youtube.com/watch?v=abcdefghijk'), /No captions available/);
  } finally { globalThis.fetch = original; }
});
