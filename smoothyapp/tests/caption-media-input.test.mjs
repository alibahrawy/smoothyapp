import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const output = await build({ entryPoints: [new URL('../src/main/captions/media-input.ts', import.meta.url).pathname], bundle: true,
  format: 'esm', platform: 'node', write: false });
const { validateCaptionMediaPath } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('picker and drops accept readable nonempty media with canonical Unicode paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-media-'));
  try {
    const file = path.join(dir, 'تسجيل صوتي.MP3'); fs.writeFileSync(file, 'fixture');
    const link = path.join(dir, 'linked.mp3'); fs.symlinkSync(file, link);
    assert.equal(await validateCaptionMediaPath(file), fs.realpathSync(file));
    assert.equal(await validateCaptionMediaPath(link), fs.realpathSync(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid inputs, folders, empty/unsupported/missing files cannot replace a source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-caption-media-'));
  try {
    const empty = path.join(dir, 'empty.wav'), text = path.join(dir, 'captions.srt'), folder = path.join(dir, 'folder.mp3');
    fs.writeFileSync(empty, ''); fs.writeFileSync(text, 'fixture'); fs.mkdirSync(folder);
    for (const input of [undefined, {}, 'relative.mp3', 'https://example.test/audio.mp3', empty, text, folder, path.join(dir, 'missing.wav')]) {
      await assert.rejects(validateCaptionMediaPath(input));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
