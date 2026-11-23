import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = path.join(root, 'resources', 'sfx');

async function load(entry, stubs = {}) {
  const output = await build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter: /.*/ }, args => { const key = Object.keys(stubs).find(name => args.path === name || args.path.endsWith(`/${name}`)); return key ? { path: key, namespace: 'stub' } : undefined; });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

const sfx = await load('src/main/sfx-library.ts', {
  'ffmpeg-path': 'export const getFFmpegPath = () => "ffmpeg";',
  'audio-library': 'export const validateMP3 = async () => 1;',
});
const raw = JSON.parse(fs.readFileSync(path.join(bundled, 'library.json'), 'utf8'));

/** Reads a 16-bit PCM WAV: duration in seconds and peak amplitude (0..1). */
function wav(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF'); assert.equal(data.toString('ascii', 8, 12), 'WAVE');
  let offset = 12, format, body;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: data.readUInt16LE(offset + 10), rate: data.readUInt32LE(offset + 12), bits: data.readUInt16LE(offset + 22) };
    if (id === 'data') { body = data.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size % 2);
  }
  assert.equal(format.bits, 16);
  let peak = 0;
  for (let i = 0; i + 1 < body.length; i += 2) peak = Math.max(peak, Math.abs(body.readInt16LE(i)));
  return { duration: body.length / (format.rate * format.channels * 2), peak: peak / 32768, ...format };
}

test('the bundled catalog is fully valid and every entry is redistributable', () => {
  const entries = sfx.normalizeSfxLibrary(raw);
  assert.equal(entries.length, raw.length, 'no catalog entry may be dropped as invalid');
  assert.ok(entries.length >= 20);
  for (const entry of entries) {
    assert.ok(sfx.SFX_LICENSES.includes(entry.license), entry.id);
    if (entry.origin === 'cc0') assert.match(entry.sourceUrl, /^https:\/\//, entry.id + ' needs a source page to prove its license');
    if (entry.origin === 'synth') assert.equal(entry.license, 'SmoothyEdit original');
    assert.ok(entry.tags.length >= 2, entry.id);
  }
  assert.ok(entries.some(entry => entry.origin === 'cc0') && entries.some(entry => entry.origin === 'synth'));
});

test('every cataloged WAV exists, matches its duration and is neither silent nor clipped', () => {
  const files = new Set();
  for (const entry of raw) {
    const file = path.join(bundled, entry.file);
    assert.ok(fs.existsSync(file), entry.file); files.add(entry.file);
    const info = wav(file);
    assert.ok(Math.abs(info.duration - entry.duration) < 0.02, `${entry.id}: catalog ${entry.duration}s vs file ${info.duration}s`);
    assert.ok(info.peak > 0.2, `${entry.id} is nearly silent`);
    assert.ok(info.peak < 0.9999, `${entry.id} clips`);
  }
  // Nothing is shipped without being cataloged: an uncataloged file would have no license on record.
  const onDisk = [];
  (function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else if (item.name.endsWith('.wav')) onDisk.push(path.relative(bundled, full).split(path.sep).join('/')); } })(bundled);
  assert.deepEqual(onDisk.filter(file => !files.has(file)), []);
});

test('invalid catalog entries are dropped instead of shown', () => {
  const good = raw[0];
  const bad = [
    { ...good, id: 'Bad ID' }, { ...good, id: 'dup-a' }, { ...good, id: 'dup-a' },
    { ...good, id: 'escape', file: '../outside.wav' }, { ...good, id: 'absolute', file: '/etc/passwd.wav' }, { ...good, id: 'mp3', file: 'x.mp3' },
    { ...good, id: 'unverified', license: 'unverified' }, { ...good, id: 'cc-by', license: 'CC BY' }, { ...good, id: 'long', duration: 99 }, { ...good, id: 'zero', duration: 0 },
    { ...good, id: 'origin', origin: 'youtube' }, { ...good, id: 'notitle', title: '  ' },
  ];
  assert.deepEqual(sfx.normalizeSfxLibrary(bad).map(entry => entry.id), ['dup-a']);
  assert.throws(() => sfx.normalizeSfxLibrary({}));
});

async function library(extra = {}) {
  const save = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-save-'));
  const instance = new sfx.SfxLibrary(bundled, path.join(save, 'Sound Effects'), extra.encode, extra.validate);
  await instance.load();
  return { instance, save };
}

test('search matches title, tags and category, filters by category and pages', async () => {
  const { instance } = await library();
  const all = instance.search({});
  assert.equal(all.total, raw.length); assert.equal(all.categories[0].id, 'all'); assert.equal(all.categories[0].count, raw.length);
  assert.deepEqual(instance.search({ query: 'riser' }).sounds.every(sound => /riser/i.test([sound.title, sound.category, ...sound.tags].join(' '))), true);
  assert.ok(instance.search({ query: 'whoosh' }).total >= 3);
  assert.ok(instance.search({ query: 'HIT   impact' }).total >= 1, 'every word must match, case-insensitively');
  assert.equal(instance.search({ query: 'zzzz-nothing' }).total, 0);
  const category = all.categories[1].id;
  assert.ok(instance.search({ category }).sounds.every(sound => sound.category === category));
  assert.ok(all.sounds.every(sound => /^smoothy-audio:\/\/sfx\/[a-z0-9-]+$/.test(sound.previewUrl)));
  assert.throws(() => instance.search({ category: 'Nope' }), /category/);
  assert.throws(() => instance.search({ query: 'x'.repeat(101) }));
  assert.throws(() => instance.search({ offset: -1 }));
  assert.equal(instance.search({ offset: 5000 }).sounds.length, 0);
});

test('saving copies the WAV once and never overwrites an existing copy', async () => {
  const { instance, save } = await library();
  const first = await instance.saveWav('pop');
  assert.match(path.basename(first.path), /^Pop - SmoothyEdit SFX\.wav$/);
  assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(path.join(bundled, 'synth/pop.wav')));
  fs.writeFileSync(first.path, 'user edited');
  await instance.saveWav('pop');
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'user edited');
  assert.deepEqual(fs.readdirSync(path.join(save, 'Sound Effects')).filter(name => name.endsWith('.part')), []);
  await assert.rejects(() => instance.saveWav('../etc/passwd'), /Choose a sound effect/);
  await assert.rejects(() => instance.saveWav(undefined), /Choose a sound effect/);
});

test('the MP3 copy for Premiere is encoded and validated, and a failure leaves nothing behind', async () => {
  const calls = [];
  const ok = await library({ encode: async (input, output) => { calls.push(input); fs.writeFileSync(output, 'mp3'); }, validate: async file => { calls.push('validate:' + path.basename(file).endsWith('.part')); } });
  const saved = await ok.instance.saveMp3('whoosh-fast');
  assert.match(saved.path, /Fast whoosh - SmoothyEdit SFX\.mp3$/);
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'mp3');
  assert.deepEqual(calls, [path.join(fs.realpathSync(bundled), 'synth/whoosh-fast.wav'), 'validate:true']);
  await ok.instance.saveMp3('whoosh-fast');
  assert.equal(calls.length, 2, 'an existing MP3 is reused, not re-encoded');

  const failing = await library({ encode: async (input, output) => { fs.writeFileSync(output, 'half'); }, validate: async () => { throw new Error('This MP3 could not be read completely.'); } });
  await assert.rejects(() => failing.instance.saveMp3('pop'), /could not be read/);
  assert.deepEqual(fs.readdirSync(path.join(failing.save, 'Sound Effects')), []);
});

test('a symlink inside the bundle cannot expose files outside it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-src-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-out-'));
  fs.writeFileSync(path.join(outside, 'secret.wav'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.wav'), path.join(folder, 'link.wav'));
  fs.writeFileSync(path.join(folder, 'library.json'), JSON.stringify([{ ...raw[0], id: 'linked', file: 'link.wav' }]));
  const instance = new sfx.SfxLibrary(folder, path.join(folder, 'out'));
  await instance.load();
  assert.equal(instance.search({}).total, 0, 'symlinks are not treated as bundled files');
  await assert.rejects(() => instance.file('linked'));
});

test('entries whose file is missing are hidden', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-src-'));
  fs.copyFileSync(path.join(bundled, 'synth/pop.wav'), path.join(folder, 'pop.wav'));
  fs.writeFileSync(path.join(folder, 'library.json'), JSON.stringify([{ ...raw[0], id: 'present', file: 'pop.wav' }, { ...raw[0], id: 'missing', file: 'gone.wav' }]));
  const instance = new sfx.SfxLibrary(folder, path.join(folder, 'out'));
  await instance.load();
  assert.deepEqual(instance.search({}).sounds.map(sound => sound.id), ['present']);
});
