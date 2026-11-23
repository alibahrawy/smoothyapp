import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

async function load(entry) {
  const output = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['sharp'],
    plugins: [{
      name: 'stubs',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        builder.onResolve({ filter: /^\.\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: args.path === 'electron'
            ? `export const app={getVersion:()=>'t',on(){},getPath:()=>'/tmp'};export const ipcMain={handle(){}};export const clipboard={writeText(){}};export const dialog={};export const shell={};export const protocol={registerSchemesAsPrivileged(){},handle(){}};export class BrowserWindow{}`
            : `export const getShortsCutsCatalog=async()=>({videoEffects:[],audioEffects:[],videoTransitions:[],audioTransitions:[]});`,
          loader: 'js'
        }));
      }
    }]
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', output.outputFiles[0].text)(module, module.exports, require, path.join(root, path.dirname(entry)), path.join(root, entry));
  return module.exports;
}

const cut = await load('src/main/agent/cut.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// Speech islands (start, end, word) on a quiet floor; one word per island.
const ISLANDS = [
  [1.0, 1.4, 'Hello'], [1.6, 1.9, 'um,'], [2.0, 2.4, 'world.'],
  [4.0, 4.3, 'This'], [4.35, 4.5, 'is'], [4.6, 5.0, 'great.'],
  [5.3, 5.6, 'Skip'], [5.65, 5.8, 'me.'], [6.8, 7.2, 'End.']
];
function fixtureData() {
  const db = Array.from({ length: 900 }, () => -80);
  for (const [a, b] of ISLANDS) for (let k = Math.round(a * 100); k < Math.round(b * 100); k += 1) db[k] = -20;
  const words = ISLANDS.map(([a], i) => ({ w: ISLANDS[i][2], a, b: i + 1 < ISLANDS.length ? ISLANDS[i + 1][0] : a + 0.4, p: 0.9, ...(ISLANDS[i][2] === 'um,' ? { filler: true } : {}) }));
  return { words, env: { from: 0, binMs: 10, db } };
}
const SETTINGS = { fps: 24, ...{ thresholdDb: -50, quietDb: -45, lead: 0.08, tail: 0.14, maxGap: 0.62, keepGap: 0.3, fillerMax: 0.55, removeFillers: true } };

test('cut_phrases resolves phrases into frame-accurate clips cut in silence', () => {
  const { words, env } = fixtureData();
  const rows = [
    { chapter: 'INTRO', sub: 'Hello' },
    { id: 'a', near: '0:01', from: 'hello', to: 'world' },
    { chapter: 'MAIN', sub: '' },
    { id: 'b', near: 4, from: 'this is', to: 'end', skip: ['skip me'] },
    { id: 'c', from: '@5.3', to: '@7.4' },
    { id: 'x', from: 'nowhere to be found' }
  ];
  const { clips, problems } = cut.resolveCutList(words, env, rows, SETTINGS);
  assert.deepEqual(clips.map(clip => clip.id), ['a.0', 'a.1', 'b.0', 'b.1', 'c-0', 'c-1']);
  assert.deepEqual(problems, ['x: FROM not found "nowhere to be found"']);
  for (const clip of clips) {
    assert.ok(Number.isInteger(clip.fIn) && Number.isInteger(clip.fOut), 'frames');
    assert.ok(clip.rmsIn < -45 && clip.rmsOut < -45, `${clip.id} cuts in silence (${clip.rmsIn}, ${clip.rmsOut})`);
  }
  const [a0, a1, b0, b1, c0, c1] = clips;
  assert.equal(a0.text, 'Hello');
  assert.equal(a1.text, 'world.', 'the um between them is cut out');
  assert.equal(a0.chapter, 'INTRO');
  assert.equal(b0.chapter, 'MAIN');
  assert.ok(a0.srcIn >= 0.9 && a0.srcIn <= 1.0, `lead before the first syllable: ${a0.srcIn}`);
  assert.ok(a0.srcOut >= 1.4 && a0.srcOut <= 1.6, `tail after the last syllable: ${a0.srcOut}`);
  assert.equal(b0.text, 'This is great.');
  assert.equal(b1.text, 'End.', 'skip phrase removed');
  // The 1 s pause between "me." and "End." is tightened to about 0.3 s.
  assert.equal(c0.text, 'Skip me.');
  const kept = (c0.srcOut - 5.8) + (6.8 - c1.srcIn);
  assert.ok(kept > 0.2 && kept < 0.45, `pause kept ${kept.toFixed(3)} s`);

  // A heard filler inside a range becomes a hole.
  const { clips: heard } = cut.resolveCutList(words, env, [{ id: 'h', from: 'this', to: 'great', near: 4 }], SETTINGS, [4.37]);
  assert.ok(heard.length >= 1);
  assert.equal(cut.roundHalfEven(2.5), 2);
  assert.equal(cut.roundHalfEven(3.5), 4);
  assert.equal(cut.roundHalfEven(-2.5), -2);
  assert.equal(cut.parseNear('1:02:03.5'), 3723.5);
});

test('SequenceMatcher matches Python difflib', () => {
  const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
  const b = 'the quick red fox jumped over the the lazy dog today'.split(' ');
  const matcher = new cut.SequenceMatcher(a, b);
  assert.deepEqual(matcher.opcodes(), [['equal', 0, 2, 0, 2], ['replace', 2, 3, 2, 3], ['equal', 3, 4, 3, 4], ['replace', 4, 5, 4, 5], ['equal', 5, 6, 5, 6], ['insert', 6, 6, 6, 7], ['equal', 6, 9, 7, 10], ['insert', 9, 9, 10, 11]]);
  assert.equal(Number(matcher.ratio().toFixed(6)), 0.7);
});

test('captions and chapters follow the timeline with inserts', () => {
  const { words } = fixtureData();
  const clips = [
    cut.normalizeClip({ id: 'co', ch: 'COLD OPEN', src_in: 4.0, src_out: 5.0, wr: [3, 5] }, 0),
    cut.normalizeClip({ id: 'a', ch: 'WHY WALK-IN TUBS VS. SHOWERS', src_in: 0.9, src_out: 2.5, wr: [0, 2] }, 1),
    cut.normalizeClip({ id: 'b', ch: 'THE END', src_in: 6.7, src_out: 7.3, wr: [8, 8] }, 2)
  ];
  const placed = cut.layoutClips(clips, [{ before: 'a', seconds: 6 }, { before: 'a', seconds: 2 }, { before: 'b', seconds: 2 }]);
  assert.deepEqual(placed.map(item => [item.id, item.start, item.chapterAt]), [['co', 0, 0], ['a', 9, 7], ['b', 12.6, 10.6]]);
  const { srt, cues } = cut.buildCaptions(words, placed, { fps: 24, corrections: [{ find: 'world', replace: 'World' }], skipChapters: ['COLD OPEN'] });
  // The cut um leaves a 0.4 s (> 8 frame) gap, so Hello and world. are separate cues.
  assert.deepEqual(cues.map(cue => cue.text), ['Hello', 'World.', 'End.']);
  assert.match(srt, /^1\n00:00:09,100 --> 00:00:\d\d,\d{3}\nHello\n\n2\n/);
  const chapters = cut.buildChapters(placed, { skipChapters: ['COLD OPEN'] });
  assert.equal(chapters.text, '0:00 Intro\n0:07 Why Walk-In Tubs vs. Showers\n0:10 The End\n');
  assert.ok(chapters.warnings.some(item => /10 s/.test(item)));
});

test('compareEdit reports clipped and leaked words by clip', () => {
  const words = 'so this is the walk in tub checklist that we use every time'.split(' ').map((w, i) => ({ w, a: i, b: i + 1, p: 1 }));
  const clips = [
    cut.normalizeClip({ id: 'c1', src_in: 0, src_out: 6, wr: [0, 5] }, 0),
    cut.normalizeClip({ id: 'c2', src_in: 6, src_out: 14, wr: [6, 12] }, 1)
  ];
  const heard = [...'so this is the walk in'.split(' ').map(w => ({ w, clip: 'c1' })), ...'tub checklist that we really really use every time'.split(' ').map(w => ({ w, clip: 'c2' }))];
  const report = cut.compareEdit(words, clips, heard);
  assert.equal(report.issues.length, 1);
  assert.deepEqual(report.issues[0], { type: 'leaked', clip: 'c2', expected: '', heard: 'really really', context: 'tub checklist that we [really really] use every time' });
  const clipped = cut.compareEdit(words, clips, heard.filter(item => !['checklist', 'that', 'really'].includes(item.w)));
  assert.equal(clipped.issues[0].type, 'clipped');
  assert.equal(clipped.issues[0].expected, 'checklist that');
});

function service(userData, whisper) {
  const tracked = [];
  const store = { values: { 'agent.port': 4850, 'agent.enabled': true }, get(key, fallback) { return key in this.values ? this.values[key] : fallback; }, set(key, value) { this.values[key] = value; } };
  const svc = new AgentService({
    store, appVersion: '3.1.0-test', userData, ffmpeg, ffprobe,
    getSequenceInfo: () => null, requestSequenceInfo: () => {}, getActiveNLE: () => null, isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }), clearMarkers: async () => ({ success: false }), window: () => null,
    trackTool: id => tracked.push(id),
    engines: { whisper }
  });
  return { svc, tracked };
}

test('smoothy_cut end to end: cut, place, captions, chapters and verify', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-cut-')));
  const media = path.join(dir, 'source.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=9', media]);
  const { words, env } = fixtureData();
  const wordsFile = path.join(dir, 'words.json');
  const envFile = path.join(dir, 'envelope.json');
  await fs.writeFile(wordsFile, JSON.stringify({ source: media, words }));
  await fs.writeFile(envFile, JSON.stringify(env));

  // A stand-in whisper-cli that "hears" the cut minus one word and with one um.
  const models = path.join(dir, 'models');
  await fs.mkdir(models);
  await fs.writeFile(path.join(models, 'ggml-small.en.bin'), 'x');
  const heardFile = path.join(dir, 'heard.json');
  const fake = path.join(dir, 'whisper-cli');
  await fs.writeFile(fake, `#!/bin/sh\nprev=""; out=""\nfor a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done\ncp "${heardFile}" "$out.json"\n`, { mode: 0o755 });
  const whisper = () => ({ path: fake, variant: 'metal', modelsDir: models, models: [{ id: 'ggml-small.en.bin', path: path.join(models, 'ggml-small.en.bin'), englishOnly: true }] });
  const { svc, tracked } = service(dir, whisper);
  try {
    const folder = path.join(dir, 'Video');
    await svc.callTool('smoothy_edit', { action: 'new', name: 'Cut test', folder, fps: 24 }, 'mcp');
    const rows = [{ chapter: 'INTRO', sub: '' }, { id: 'a', near: 1, from: 'hello', to: 'world' }, { chapter: 'MAIN', sub: '' }, { id: 'b', near: 4, from: 'this', to: 'great' }];
    const result = await svc.callTool('smoothy_cut', { action: 'cut_phrases', words: wordsFile, envelope: envFile, rows, fps: 24, name: 'v1', place: true }, 'mcp');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.clips, 3);
    assert.ok(result.data.files.clips.startsWith(path.join(folder, 'Work', 'edit')));
    assert.equal(result.data.placed.added, 3);
    const shown = await svc.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.ok(shown.data.duration > 1.5);
    const clipsFile = result.data.files.clips;
    const saved = JSON.parse(await fs.readFile(clipsFile, 'utf8'));

    const again = await svc.callTool('smoothy_cut', { action: 'cut_phrases', words: wordsFile, envelope: envFile, rows, fps: 24, name: 'v1' }, 'mcp');
    assert.notEqual(again.data.files.clips, clipsFile, 'a second cut never overwrites the first');

    const captions = await svc.callTool('smoothy_cut', { action: 'captions', clips: clipsFile, words: wordsFile, name: 'V01 captions' }, 'mcp');
    assert.equal(captions.ok, true, JSON.stringify(captions));
    assert.equal(captions.data.file, path.join(folder, 'Edit', 'V01 captions.srt'));
    const chapters = await svc.callTool('smoothy_cut', { action: 'chapters', clips: clipsFile, name: 'V01 chapters' }, 'mcp');
    assert.match(chapters.data.text, /^0:00 Intro\n0:0\d Main\n$/);

    // Gapped timeline: clip i starts at sum(previous durations + 0.6 s).
    let t = 0;
    const tokens = [];
    const said = [['Hello'], ['world.'], ['This', 'um,', 'great.']];
    saved.clips.forEach((clip, i) => {
      said[i].forEach((w, j) => tokens.push({ text: ` ${w}`, t_dtw: Math.round((t + 0.15 + 0.1 * j) * 100), p: 0.9 }));
      t += clip.srcOut - clip.srcIn + 0.6;
    });
    await fs.writeFile(heardFile, JSON.stringify({ transcription: [{ tokens }] }));
    const verify = await svc.callTool('smoothy_cut', { action: 'verify_edit', clips: clipsFile, words: wordsFile }, 'mcp');
    assert.equal(verify.ok, true, JSON.stringify(verify));
    assert.ok(verify.data.similarity < 1 && verify.data.similarity > 0.8);
    assert.deepEqual(verify.data.issues.map(issue => [issue.type, issue.expected]), [['clipped', 'is']]);
    assert.equal(verify.data.heardFillerCount, 1);
    assert.equal(verify.data.heardFillers[0].clip, 'b');
    assert.ok(verify.data.heardFillers[0].source > 4 && verify.data.heardFillers[0].source < 5);
    assert.deepEqual(verify.data.silentClips, []);

    const recut = await svc.callTool('smoothy_cut', { action: 'cut_phrases', words: wordsFile, envelope: envFile, rows, fps: 24, fillers: verify.data.files.report }, 'mcp');
    assert.equal(recut.data.heardFillersUsed, 1);

    assert.deepEqual(tracked.filter(id => id.startsWith('agent_cut_')), ['agent_cut_phrases', 'agent_cut_phrases', 'agent_cut_captions', 'agent_cut_chapters', 'agent_cut_verify', 'agent_cut_phrases']);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
