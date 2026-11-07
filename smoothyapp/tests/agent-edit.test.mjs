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

async function load(entry, stubs = {}) {
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
        builder.onResolve({ filter: /^\.\/websocket-server$/ }, () => ({ path: 'websocket', namespace: 'stub' }));
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
  new Function('module', 'exports', 'require', '__dirname', output.outputFiles[0].text)(module, module.exports, require, path.dirname(path.join(root, entry)));
  return module.exports;
}

const project = await load('src/main/agent/edit-project.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');

const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

const asset = (id, kind, duration, hasAudio = true) => ({ id, name: `${id}.mp4`, path: `/x/${id}.mp4`, kind, duration, width: 1280, height: 720, fps: 30, hasVideo: kind !== 'audio', hasAudio });

function base() {
  const p = project.createProject({ width: 1280, height: 720, fps: 30 });
  p.assets.a1 = asset('a1', 'video', 10);
  p.assets.m1 = { ...asset('m1', 'audio', 20), hasVideo: false };
  return p;
}

test('add links a video clip with its audio and appends after the last clip', () => {
  const { project: p, results } = project.applyOps(base(), [
    { op: 'add', asset: 'a1', in: 0, out: 4 },
    { op: 'add', asset: 'a1', in: 5, out: 8 }
  ]);
  assert.equal(p.clips.length, 4);
  assert.equal(results[0].clips.length, 2);
  const v = p.clips.filter(c => c.track === 'V1');
  assert.equal(v[1].start, 4);
  assert.equal(project.projectDuration(p), 7);
  assert.equal(project.lintProject(p).length, 0);
});

test('split, trim, move and remove keep linked clips in step', () => {
  let { project: p } = project.applyOps(base(), [{ op: 'add', asset: 'a1', in: 0, out: 10 }]);
  const video = p.clips.find(c => c.track === 'V1');
  ({ project: p } = project.applyOps(p, [{ op: 'split', clip: video.id, at: 4 }]));
  assert.equal(p.clips.length, 4);
  const right = p.clips.filter(c => c.start === 4);
  assert.equal(right.length, 2);
  assert.ok(right.every(c => Math.abs(c.in - 4) < 1e-6));
  ({ project: p } = project.applyOps(p, [{ op: 'move', clip: right[0].id, to: 6 }]));
  assert.ok(p.clips.filter(c => c.id !== video.id && c.start === 6).length >= 2, 'audio moved with video');
  ({ project: p } = project.applyOps(p, [{ op: 'remove', clip: video.id }]));
  assert.equal(p.clips.filter(c => c.start === 0).length, 0, 'linked audio removed too');
});

test('trim ripple closes the gap and head trims keep the picture in place', () => {
  let { project: p } = project.applyOps(base(), [
    { op: 'add', asset: 'a1', in: 0, out: 4, audio: false },
    { op: 'add', asset: 'a1', in: 0, out: 4, audio: false }
  ]);
  const [first, second] = p.clips;
  ({ project: p } = project.applyOps(p, [{ op: 'trim', clip: first.id, out: 2, ripple: true }]));
  assert.equal(p.clips.find(c => c.id === second.id).start, 2);
  ({ project: p } = project.applyOps(p, [{ op: 'trim', clip: second.id, in: 1 }]));
  const moved = p.clips.find(c => c.id === second.id);
  assert.equal(moved.in, 1);
  assert.equal(moved.start, 3, 'head trim advances the start so the picture stays aligned');
});

test('cut removes a time range from every track and closes the gap', () => {
  let { project: p } = project.applyOps(base(), [
    { op: 'add', asset: 'a1', in: 0, out: 10 },
    { op: 'add', asset: 'm1', at: 0, out: 10, track: 'A2' }
  ]);
  ({ project: p } = project.applyOps(p, [{ op: 'cut', from: 3, to: 5 }]));
  assert.equal(project.projectDuration(p), 8);
  const v = p.clips.filter(c => c.track === 'V1').sort((a, b) => a.start - b.start);
  assert.equal(v.length, 2);
  assert.equal(v[0].out, 3);
  assert.equal(v[1].start, 3);
  assert.equal(v[1].in, 5);
});

test('a failing op leaves the project untouched and names the op', () => {
  const p = base();
  assert.throws(
    () => project.applyOps(p, [{ op: 'add', asset: 'a1', in: 0, out: 3 }, { op: 'remove', clip: 'nope' }]),
    /ops\[1\] \(remove\)/
  );
  assert.equal(p.clips.length, 0);
  assert.equal(p.revision, 0);
});

test('captions batch creates text clips and overlap warnings are reported', () => {
  let { project: p, results } = project.applyOps(base(), [
    { op: 'captions', items: [{ start: 0, end: 1, text: 'one' }, { start: 1, end: 2.5, text: 'two' }, { start: 3, end: 3.01, text: 'skip' }] }
  ]);
  assert.equal(results[0].clips.length, 2);
  assert.equal(p.clips.every(c => c.kind === 'text' && c.track === 'T1'), true);
  ({ project: p } = project.applyOps(p, [{ op: 'add', asset: 'a1', in: 0, out: 5, audio: false, track: 'V1' }, { op: 'add', asset: 'a1', in: 0, out: 5, audio: false, track: 'V1', at: 3 }]));
  assert.ok(project.lintProject(p).some(line => line.includes('overlaps')));
});

async function fixtureMedia() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-edit-test-'));
  const run = args => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args]);
  run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', path.join(dir, 'a.mp4')]);
  run(['-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:a', 'libmp3lame', path.join(dir, 'music.mp3')]);
  return dir;
}

function makeService(dir, extra = {}) {
  const values = { 'agent.port': 4810 + Math.floor(Math.random() * 100), 'agent.enabled': true, 'agent.autoApprove': true };
  return new AgentService({
    store: { get(key, fallback) { return key in values ? values[key] : fallback; }, set(key, value) { values[key] = value; } },
    appVersion: '3.0.0-test',
    userData: dir,
    ffmpeg,
    ffprobe,
    getSequenceInfo: () => null,
    requestSequenceInfo: () => {},
    getActiveNLE: () => null,
    isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }),
    clearMarkers: async () => ({ success: false }),
    audioService: null,
    window: () => null,
    ...extra
  });
}

test('headless edit: import, build, preview and export through the agent tools', async () => {
  const dir = await fixtureMedia();
  const tracked = [];
  const service = makeService(dir, { trackTool: id => tracked.push(id) });
  try {
    const none = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(none.ok, false);
    assert.equal(none.error.code, 'E_NOT_FOUND');

    const created = await service.callTool('smoothy_edit', { action: 'new', name: 'Test cut', width: 640, height: 360 }, 'mcp');
    assert.equal(created.ok, true);

    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(dir, 'a.mp4'), path.join(dir, 'music.mp3'), path.join(dir, 'a.mp4')] }, 'mcp');
    assert.equal(imported.ok, true);
    assert.equal(imported.data.assets[0].id, imported.data.assets[2].id, 'same file is not imported twice');
    const [video, music] = imported.data.assets;

    const outside = await service.callTool('smoothy_edit', { action: 'import', paths: ['/etc/hosts'] }, 'mcp');
    assert.equal(outside.ok, false);

    const ops = await service.callTool('smoothy_edit', {
      action: 'ops',
      ops: [
        { op: 'add', asset: video.id, in: 0, out: 2 },
        { op: 'add', asset: video.id, in: 2, out: 4, fadeIn: 0.3 },
        { op: 'add', asset: music.id, at: 0, duration: 4, volume: -10, fadeOut: 1, track: 'A2' },
        { op: 'text', text: 'Hello', at: 0.2, duration: 1.5 },
        { op: 'captions', items: [{ start: 2, end: 3.5, text: 'A caption' }] }
      ]
    }, 'mcp');
    assert.equal(ops.ok, true, JSON.stringify(ops));
    assert.equal(ops.data.duration, 4);
    assert.deepEqual(ops.data.warnings, []);

    const shown = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.ok(shown.data.tracks.V1.length === 2 && shown.data.tracks.T1.length === 2);

    const undone = await service.callTool('smoothy_edit', { action: 'undo' }, 'mcp');
    assert.equal(undone.data.clips, 0);
    const redone = await service.callTool('smoothy_edit', { action: 'redo' }, 'mcp');
    assert.ok(redone.data.clips > 0);

    const frame = await service.callTool('smoothy_render', { action: 'frame', time: 1, width: 480 }, 'mcp');
    assert.equal(frame.ok, true, JSON.stringify(frame));
    assert.match(frame.imageDataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(frame.data.width, 480);

    const sheet = await service.callTool('smoothy_render', { action: 'sheet', count: 4, width: 200 }, 'mcp');
    assert.equal(sheet.ok, true);
    assert.equal(sheet.data.frames, 4);

    const started = await service.callTool('smoothy_render', { action: 'export', preset: 'draft', name: 'My Cut!' }, 'mcp');
    assert.equal(started.ok, true, JSON.stringify(started));
    const waited = await service.callTool('smoothy_jobs', { action: 'wait', id: started.data.jobId, timeoutMs: 60000 }, 'mcp');
    assert.equal(waited.data.job.status, 'done', JSON.stringify(waited.data.job));
    const result = waited.data.job.result;
    assert.ok(result.bytes > 1000);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', result.path]).toString());
    assert.equal(probe.streams.some(s => s.codec_type === 'video'), true);
    assert.equal(probe.streams.some(s => s.codec_type === 'audio'), true);
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.2, `duration ${probe.format.duration}`);
    assert.ok(path.basename(result.path).startsWith('My-Cut'));

    assert.deepEqual(tracked.filter(id => id === 'agent_edit_export'), ['agent_edit_export']);
    assert.equal(tracked.includes('agent_edit_project'), true);
    assert.equal(tracked.filter(id => id === 'agent_edit_preview').length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('export waits for editor approval and a denial renders nothing', async () => {
  const dir = await fixtureMedia();
  const service = makeService(dir);
  service.deps.store.set('agent.autoApprove', false);
  try {
    await service.callTool('smoothy_edit', { action: 'new', width: 640, height: 360 }, 'mcp');
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(dir, 'a.mp4')] }, 'mcp');
    await service.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'add', asset: imported.data.assets[0].id, in: 0, out: 1 }] }, 'mcp');
    const pending = service.callTool('smoothy_render', { action: 'export', preset: 'draft' }, 'mcp');
    await new Promise(resolve => setTimeout(resolve, 50));
    const approvals = [...service.approvals.values()];
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'smoothy_render.export');
    service.decideApproval(approvals[0].id, false);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'E_APPROVAL_TIMEOUT');
    assert.equal(service.jobs.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('long timelines export in chunks that join cleanly', async () => {
  const dir = await fixtureMedia();
  const render = await load('src/main/agent/edit-render.ts');
  try {
    const p = project.createProject({ width: 320, height: 180, fps: 30 });
    p.assets.a1 = { ...asset('a1', 'video', 4), path: path.join(dir, 'a.mp4'), width: 640, height: 360 };
    const ops = [];
    for (let i = 0; i < 12; i += 1) ops.push({ op: 'add', asset: 'a1', in: i % 3, out: (i % 3) + 0.5 });
    const built = project.applyOps(p, ops).project;
    const bounds = render.chunkBoundaries(built, 0, project.projectDuration(built), 4);
    assert.ok(bounds.length >= 2);
    const out = path.join(dir, 'chunked.mp4');
    const originalLimit = render.MAX_ARG_CHARS;
    assert.ok(originalLimit > 1000);
    const result = await render.exportProject(built, { ffmpeg, workDir: path.join(dir, 'work'), output: out, preset: 'draft', chunkClips: 2 });
    assert.ok(result.chunks > 1, `expected chunks, got ${result.chunks}`);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', out]).toString());
    assert.ok(Math.abs(Number(probe.format.duration) - 6) < 0.25, `duration ${probe.format.duration}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- Smoothy features as edit tools -----------------------------------------

async function toneMedia(dir) {
  const run = args => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args]);
  // Speaker A talks 0-4 and 8-12, speaker B talks 4-8 (pure tones stand in for voices).
  const expr = (mod) => `aevalsrc=0.6*sin(2*PI*300*t)*${mod}:d=12:s=16000`;
  run(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=12', '-f', 'lavfi', '-i', expr('lt(mod(t\\,8)\\,4)'), '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', path.join(dir, 'camA.mp4')]);
  run(['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=12', '-f', 'lavfi', '-i', `aevalsrc=0.6*sin(2*PI*500*t)*gte(mod(t\\,8)\\,4):d=12:s=16000`, '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', path.join(dir, 'camB.mp4')]);
  // Tone 0-3s, silence 3-6s, tone 6-9s.
  run(['-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*440*t)*(lt(t\\,3)+gte(t\\,6)):d=9:s=16000`, '-c:a', 'libmp3lame', path.join(dir, 'gappy.mp3')]);
}

async function started(service, tool, args) {
  const first = await service.callTool(tool, args, 'mcp');
  assert.equal(first.ok, true, JSON.stringify(first));
  const done = await service.callTool('smoothy_jobs', { action: 'wait', id: first.data.jobId, timeoutMs: 60000 }, 'mcp');
  assert.equal(done.data.job.status, 'done', JSON.stringify(done.data.job));
  return done.data.job.result;
}

test('analyze reports loudness and silent ranges; cut_silence removes dead air on every track', async () => {
  const dir = await fixtureMedia();
  await toneMedia(dir);
  const tracked = [];
  const service = makeService(dir, { trackTool: id => tracked.push(id) });
  try {
    await service.callTool('smoothy_edit', { action: 'new', width: 320, height: 180 }, 'mcp');
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(dir, 'gappy.mp3'), path.join(dir, 'camA.mp4')] }, 'mcp');
    const [gappy, cam] = imported.data.assets;
    await service.callTool('smoothy_edit', { action: 'ops', ops: [
      { op: 'add', asset: cam.id, in: 0, out: 9, audio: false },
      { op: 'add', asset: gappy.id, at: 0, out: 9, track: 'A1' }
    ] }, 'mcp');

    const analysis = await service.callTool('smoothy_render', { action: 'analyze' }, 'mcp');
    assert.equal(analysis.ok, true, JSON.stringify(analysis));
    assert.equal(analysis.data.silenceCount, 1);
    assert.ok(Math.abs(analysis.data.silences[0].start - 3) < 0.3 && Math.abs(analysis.data.silences[0].end - 6) < 0.3, JSON.stringify(analysis.data.silences));
    assert.equal(typeof analysis.data.loudness.integrated, 'number');

    const cut = await service.callTool('smoothy_edit', { action: 'cut_silence', tracks: ['A1'] }, 'mcp');
    assert.equal(cut.ok, true, JSON.stringify(cut));
    assert.equal(cut.data.removed, 1);
    assert.ok(cut.data.seconds > 2.3 && cut.data.seconds < 3, `removed ${cut.data.seconds}s`);
    assert.ok(Math.abs(cut.data.duration - (9 - cut.data.seconds)) < 0.05);
    const shown = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(shown.data.tracks.V1.length, 2, 'the picture was cut with the audio');
    assert.deepEqual(tracked.filter(id => id === 'silence'), ['silence']);

    const again = await service.callTool('smoothy_edit', { action: 'cut_silence', tracks: ['A1'] }, 'mcp');
    assert.equal(again.data.removed, 0, 'nothing left to cut');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('multicam cuts synced cameras to whoever is speaking', async () => {
  const dir = await fixtureMedia();
  await toneMedia(dir);
  const tracked = [];
  const service = makeService(dir, { trackTool: id => tracked.push(id) });
  try {
    await service.callTool('smoothy_edit', { action: 'new', width: 320, height: 180 }, 'mcp');
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(dir, 'camA.mp4'), path.join(dir, 'camB.mp4')] }, 'mcp');
    const [a, b] = imported.data.assets;

    const tooFew = await service.callTool('smoothy_edit', { action: 'multicam', cameras: [{ asset: a.id }] }, 'mcp');
    assert.equal(tooFew.ok, false);

    const result = await started(service, 'smoothy_edit', { action: 'multicam', cameras: [{ asset: a.id, speaker: 'Ana' }, { asset: b.id, speaker: 'Ben' }] });
    assert.ok(result.cuts >= 1, JSON.stringify(result));
    assert.ok(result.seconds.Ana > 4 && result.seconds.Ben > 2, JSON.stringify(result.seconds));
    const shown = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    const v1 = shown.data.tracks.V1;
    assert.ok(v1.length >= 2);
    assert.ok(v1[0].includes('camA') && v1.some(line => line.includes('camB')), v1.join('\n'));
    assert.equal(shown.data.tracks.A1.length, 1, 'one continuous audio bed');
    assert.deepEqual(tracked.filter(id => id === 'multicam'), ['multicam']);

    const blocked = await service.callTool('smoothy_edit', { action: 'multicam', cameras: [{ asset: a.id }, { asset: b.id }] }, 'mcp');
    assert.equal(blocked.ok, false, 'V1 must be empty');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcribe returns a timeline transcript, asks approval to prepare and can place captions', async () => {
  const dir = await fixtureMedia();
  const calls = [];
  let ready = false;
  const speech = {
    isReady: () => ready,
    describe: () => 'ggml-test.bin',
    prepare: async progress => { calls.push('prepare'); progress(100, 'ready'); ready = true; },
    transcribe: async (wav, language, signal, progress) => {
      calls.push(`transcribe:${language || 'auto'}`);
      assert.ok((await fs.stat(wav)).size > 1000, 'a real mix was rendered');
      progress(100, 'done');
      return { language: 'en', chunks: [{ text: 'Hello there.', timestamp: [0.2, 1.5] }, { text: 'Second line here.', timestamp: [2, 3.4] }] };
    },
    format: (result) => result.chunks.map(chunk => ({ startTime: chunk.timestamp[0], endTime: chunk.timestamp[1], text: chunk.text }))
  };
  const tracked = [];
  const service = makeService(dir, { edit: { speech }, trackTool: id => tracked.push(id) });
  try {
    await service.callTool('smoothy_edit', { action: 'new', width: 320, height: 180 }, 'mcp');
    const imported = await service.callTool('smoothy_edit', { action: 'import', paths: [path.join(dir, 'a.mp4')] }, 'mcp');
    await service.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'add', asset: imported.data.assets[0].id, in: 0, out: 4 }] }, 'mcp');
    const result = await started(service, 'smoothy_edit', { action: 'transcribe', language: 'en', captions: true });
    assert.deepEqual(calls, ['prepare', 'transcribe:en']);
    assert.equal(result.lines, 2);
    assert.equal(result.placedOnT1, 2);
    assert.match(result.transcript[0], /^0\.2-1\.5 Hello there\.$/);
    const shown = await service.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(shown.data.tracks.T1.length, 2);
    assert.deepEqual(tracked.filter(id => id === 'captions'), ['captions']);

    const none = makeService(dir);
    const missing = await none.callTool('smoothy_edit', { action: 'transcribe' }, 'mcp');
    assert.equal(missing.ok, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('library search and add download after approval and keep licence and credit on the asset', async () => {
  const dir = await fixtureMedia();
  const fetched = [];
  const library = {
    musicSearch: async input => { fetched.push(['search', input.query]); return [{ id: 'trk1', title: 'Sunny Day', artist: 'Someone', mood: 'Happy', duration: 6 }]; },
    musicFetch: async (id, signal, progress) => { progress(50, 'x'); fetched.push(['music', id]); return { path: path.join(dir, 'music.mp3'), title: 'Sunny Day', provider: 'YouTube Audio Library', license: 'unverified', credit: 'Someone' }; },
    stockSearch: async input => [{ ref: '7|3', title: 'Clouds', provider: 'pixabay', duration: 4, width: 640, height: 360, license: 'Pixabay' }],
    stockFetch: async ref => { fetched.push(['stock', ref]); return { path: path.join(dir, 'a.mp4'), title: 'Clouds', provider: 'pixabay', license: 'Pixabay Content License', credit: 'Maker', url: 'https://example.com' }; }
  };
  const service = makeService(dir, { edit: { library } });
  try {
    const none = await makeService(dir).callTool('smoothy_library', { action: 'music' }, 'mcp');
    assert.equal(none.ok, false);
    assert.equal(none.error.code, 'E_NOT_IMPLEMENTED');

    await service.callTool('smoothy_edit', { action: 'new' }, 'mcp');
    const music = await service.callTool('smoothy_library', { action: 'music', query: 'sunny', mood: 'Happy' }, 'mcp');
    assert.equal(music.data.tracks[0].id, 'trk1');
    assert.deepEqual(fetched[0], ['search', 'sunny']);
    const stock = await service.callTool('smoothy_library', { action: 'stock', query: 'clouds' }, 'mcp');
    assert.equal(stock.data.clips[0].ref, '7|3');

    const addedMusic = await started(service, 'smoothy_library', { action: 'add', kind: 'music', id: 'trk1' });
    assert.equal(addedMusic.asset.kind, 'audio');
    const addedStock = await started(service, 'smoothy_library', { action: 'add', kind: 'stock', id: '7|3' });
    assert.equal(addedStock.license, 'Pixabay Content License');
    const shown = await service.callTool('smoothy_edit', { action: 'show', clips: false }, 'mcp');
    const sources = shown.data.assets.map(asset => asset.source);
    assert.ok(sources.includes('YouTube Audio Library') && sources.includes('pixabay'), JSON.stringify(shown.data.assets));
    assert.deepEqual(fetched.filter(item => item[0] !== 'search'), [['music', 'trk1'], ['stock', '7|3']]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('library add waits for editor approval and a denial downloads nothing', async () => {
  const dir = await fixtureMedia();
  let downloads = 0;
  const library = { musicSearch: async () => [], musicFetch: async () => { downloads += 1; return { path: path.join(dir, 'music.mp3'), title: 't' }; }, stockSearch: async () => [], stockFetch: async () => { downloads += 1; return { path: '', title: '' }; } };
  const service = makeService(dir, { edit: { library } });
  service.deps.store.set('agent.autoApprove', false);
  try {
    await service.callTool('smoothy_edit', { action: 'new' }, 'mcp');
    const pending = service.callTool('smoothy_library', { action: 'add', kind: 'music', id: 'trk1' }, 'mcp');
    await new Promise(resolve => setTimeout(resolve, 50));
    const [approval] = [...service.approvals.values()];
    assert.equal(approval.tool, 'smoothy_library.add');
    service.decideApproval(approval.id, false);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(downloads, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
