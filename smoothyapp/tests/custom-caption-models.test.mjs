import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-custom-models-'));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/main/captions/model-manager.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'profile', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'profile' }));
    builder.onResolve({ filter: /^\.\/download-file$/ }, () => ({ path: 'download', namespace: 'download' }));
    builder.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({ contents:
      `export const app={getPath:()=>${JSON.stringify(profile)}};` }));
    builder.onLoad({ filter: /.*/, namespace: 'download' }, () => ({ contents: `
      export function checkCancellation(signal) { if(signal?.aborted) throw new Error('TRANSCRIPTION_CANCELLED'); }
      export async function downloadFile() { throw new Error('Unexpected network download'); }
    ` }));
  } }]
});
const models = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function header(englishOnly = false) {
  const bytes = Buffer.alloc(64);
  [0x67676d6c, englishOnly ? 51864 : 51865, 1500, 512, 8, 6, 448, 512, 8, 6, 80, 1]
    .forEach((value, i) => bytes.writeInt32LE(value, i * 4));
  return bytes;
}

test('custom catalog rescans native GGML, keeps builtin downloads unique and identifies renamed English weights', async () => {
  try {
    const directory = models.getModelsDir();
    fs.mkdirSync(path.join(directory, 'darija'));
    fs.writeFileSync(path.join(directory, 'My model.bin'), header());
    fs.writeFileSync(path.join(directory, 'Renamed English.bin'), header(true));
    fs.writeFileSync(path.join(directory, 'ggml-base.bin'), header());
    fs.writeFileSync(path.join(directory, 'darija', 'Existing model.bin'), header());
    fs.writeFileSync(path.join(directory, 'darija', 'English.bin'), header(true));
    fs.writeFileSync(path.join(directory, 'invalid.bin'), 'not a whisper model');
    fs.writeFileSync(path.join(directory, 'truncated.bin'), header().subarray(0, 40));
    fs.writeFileSync(path.join(directory, '.hidden.bin'), header());
    fs.writeFileSync(path.join(directory, 'copy.bin.part'), header());
    fs.writeFileSync(path.join(directory, 'other.gguf'), header());
    fs.writeFileSync(path.join(directory, 'ggml-silero-v6.2.0.bin'), header());
    fs.symlinkSync(path.join(directory, 'My model.bin'), path.join(directory, 'symlink.bin'));
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.writeFileSync(path.join(directory, 'nested', 'French model.bin'), header());
    fs.mkdirSync(path.join(directory, 'nested', 'deeper'));
    fs.writeFileSync(path.join(directory, 'nested', 'deeper', 'ignored.bin'), header());
    const catalog = models.getAvailableModels();
    assert.equal(catalog.filter(model => model.id === 'ggml-base.bin').length, 1);
    assert.deepEqual(catalog.filter(model => model.custom).map(model => model.id).sort(),
      ['local:My model.bin', 'local:Renamed English.bin', 'local:darija/English.bin', 'local:darija/Existing model.bin', 'local:nested/French model.bin']);
    const custom = models.getModelById('local:darija/Existing model.bin');
    assert.equal(custom.specialistLanguage, undefined);
    assert.equal(models.isEnglishOnlyModel('local:darija/English.bin'), true);
    assert.ok(catalog.filter(model => model.custom).every(model => !model.specialistLanguage));
    assert.equal(custom.engine, 'whisper');
    assert.equal(custom.downloaded, true);
    assert.equal(models.isEnglishOnlyModel('local:Renamed English.bin'), true);
    assert.equal(models.isEnglishOnlyModel('local:My model.bin'), false);
    assert.equal(await models.ensureModelDownloaded(custom.id), custom.filePath);

    // A removed selection fails clearly, never downloads a similarly named file.
    fs.rmSync(custom.filePath);
    assert.equal(models.getModelById(custom.id), undefined);
    await assert.rejects(models.ensureModelDownloaded(custom.id), /Local model is missing/);
    for (const id of ['local:../outside.bin', 'local:darija/../../outside.bin', '../outside.bin', '/outside.bin']) {
      await assert.rejects(models.ensureModelDownloaded(id), /missing or unsupported|Unknown caption model/);
    }
    const abort = new AbortController(); abort.abort();
    await assert.rejects(models.ensureModelDownloaded('local:My model.bin', undefined, abort.signal), /TRANSCRIPTION_CANCELLED/);
    fs.writeFileSync(path.join(directory, 'Added later.bin'), header());
    assert.ok(models.getModelById('local:Added later.bin'));
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
