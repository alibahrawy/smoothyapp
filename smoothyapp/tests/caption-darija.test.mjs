import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const electronStub = `
export const app = { getPath: () => '/tmp' };
export const ipcMain = { handle: () => {} };
export const dialog = {};
export const protocol = { registerSchemesAsPrivileged: () => {}, handle: () => {} };
export class BrowserWindow {}
`;

const output = await build({
  entryPoints: [fileURLToPath(new URL('../src/main/captions/moulsot-service.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  packages: 'external',
  plugins: [{
    name: 'stub-electron',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: electronStub }));
    }
  }]
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`;
const { assignTimings, parseAsrText } = await import(moduleUrl);

const languageOutput = await build({
  entryPoints: [fileURLToPath(new URL('../src/main/captions/languages.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  packages: 'external'
});
const languages = await import(
  `data:text/javascript;base64,${Buffer.from(languageOutput.outputFiles[0].text).toString('base64')}`
);

test('Moroccan Darija selects MoulSot and maps to Whisper Arabic', () => {
  assert.equal(languages.isSupportedLanguage('ary'), true);
  assert.equal(languages.getLanguageName('ary'), 'Moroccan Darija');
  assert.equal(languages.getWhisperLanguageCode('ary'), 'ar');
  assert.equal(languages.getPreferredModelForLanguage('ary'), languages.MOULSOT_MODEL_ID);
  assert.equal(languages.getPreferredModelForLanguage('en'), undefined);
  assert.equal(languages.isDarijaModel(languages.MOULSOT_MODEL_ID), true);
  assert.equal(languages.isDarijaModel(languages.DARIJA_WHISPER_MODEL_ID), true);
  assert.equal(languages.isDarijaModel('ggml-large-v3-turbo.bin'), false);
  assert.equal(languages.isDarijaModel('local:darija/My model.bin'), false);
});

test('Darija specialists have pinned downloads and reject corrupt weights', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profile = mkdtempSync(join(tmpdir(), 'smoothy-darija-catalog-'));
  try {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../src/main/captions/model-manager.ts', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{ name: 'profile', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'profile' }));
        builder.onResolve({ filter: /^\.\/download-file$/ }, () => ({ path: 'download-file', namespace: 'bad-download' }));
        builder.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({ contents:
          `export const app={getPath:()=>${JSON.stringify(profile)}};` }));
        builder.onLoad({ filter: /.*/, namespace: 'bad-download' }, () => ({ contents: `
          import fs from 'node:fs';
          export function checkCancellation(signal) { if(signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED'); }
          export async function downloadFile(url, target) {
            globalThis.__darijaModelDownloadUrl=url;
            fs.writeFileSync(target, 'corrupt weights');
          }
        ` }));
      } }]
    });
    const catalog = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
    const models = catalog.getAvailableModels();
    assert.deepEqual(models.filter(m => m.specialistLanguage === 'ary').map(m => m.id),
      [languages.MOULSOT_MODEL_ID, languages.DARIJA_WHISPER_MODEL_ID]);
    const whisper = catalog.getModelById(languages.DARIJA_WHISPER_MODEL_ID);
    assert.equal(whisper.engine, 'whisper');
    assert.equal(whisper.sizeBytes, 487601984);
    assert.equal(whisper.downloaded, false);
    assert.equal(catalog.isEnglishOnlyModel(whisper.id), false);
    assert.ok(models.some(m => m.id === 'ggml-large-v3-turbo.bin' && !m.specialistLanguage));
    await assert.rejects(catalog.ensureModelDownloaded(whisper.id), /Checksum mismatch/);
    assert.match(globalThis.__darijaModelDownloadUrl, /ehyoussef\/whisper-small-darija-ext\/resolve\/[a-f0-9]{40}\/ggml\/ggml-model\.bin$/);
    assert.equal(catalog.getModelById(whisper.id).downloaded, false);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(catalog.ensureModelDownloaded(whisper.id, undefined, cancelled.signal), /TRANSCRIPTION_CANCELLED/);
  } finally { delete globalThis.__darijaModelDownloadUrl; rmSync(profile, { recursive: true, force: true }); }
});

test('Darija ASR output strips the language marker', () => {
  assert.equal(
    parseAsrText('\nlanguage Arabic<asr_text>  واش نبداو دابا؟  \n'),
    'واش نبداو دابا؟'
  );
  assert.equal(parseAsrText('language Arabic<asr_text>salam'), 'salam');
});

test('word timings stay inside speech segments and skip pauses', () => {
  const segments = [
    { start: 1, end: 3, duration: 2 },
    { start: 10, end: 12, duration: 2 }
  ];
  const words = ['salam', 'bghit', 'nqol', 'lik', 'shi', 'haja'];
  const chunks = assignTimings(words, segments, 20);

  assert.equal(chunks.length, words.length);
  assert.deepEqual(chunks.map((chunk) => chunk.text), words);
  assert.ok(chunks[0].timestamp[0] >= 1);
  assert.ok(chunks[2].timestamp[1] <= 3 + 0.01);
  assert.ok(chunks[3].timestamp[0] >= 10);
  assert.ok(chunks[5].timestamp[1] <= 12 + 0.01);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].timestamp[0] >= chunks[i - 1].timestamp[0]);
  }
});
