import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';

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

const post = await load('src/main/agent/audio-post.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const sfxDir = path.join(root, 'resources/sfx');

test('music bed graph, lift windows, SFX lookup, levels and lanes', async () => {
  assert.deepEqual(post.mergeWindows([{ from: 5, to: 6 }, { from: 0, to: 2 }, { from: 2.1, to: 3 }]), [{ from: 0, to: 3 }, { from: 5, to: 6 }]);
  const bed = post.musicBedGraph({ total: 600, sourceSeconds: 236, sourceLufs: -8.7, targetLufs: -33.5, liftLufs: -24, lifts: [{ from: 10, to: 15 }], crossfade: 3, fadeIn: 1.2, fadeOut: 3 });
  assert.equal(bed.loops, 4);
  assert.match(bed.graph, /^\[0:a\]\[1:a\]acrossfade=d=3:c1=tri:c2=tri\[x1\];\[x1\]\[2:a\]acrossfade/);
  assert.match(bed.graph, /volume='pow\(10,-24\.80\/20\)\*\(1\+1\.9854\*min\(1,clip\(\(t-9\.800\)\/0\.6,0,1\)\*clip\(\(15\.300-t\)\/0\.6,0,1\)\)\)':eval=frame,afade=t=in:st=0:d=1\.2,afade=t=out:st=597\.000:d=3\[o\]$/);
  assert.throws(() => post.musicBedGraph({ total: 60, sourceSeconds: 3, sourceLufs: -10, targetLufs: -33.5, liftLufs: -24, lifts: [], crossfade: 3, fadeIn: 0, fadeOut: 0 }), /too short/);

  assert.equal(post.levelGain(-3, -18.6), -15);
  assert.equal(post.levelGain(-1, -10), -22, 'a sustained sound is capped by RMS');
  assert.deepEqual(post.parseAstats('Peak level dB: -3.0\nRMS level dB: -18.5\n'), { peak: -3, rms: -18.5 });
  const library = await post.loadSfx(sfxDir);
  assert.ok(library.length >= 20);
  assert.equal(post.findSfx(library, 'whoosh').id, 'cc0-whoosh');
  assert.equal(post.findSfx(library, 'Notification chime').id, 'chime-notification');
  assert.equal(post.findSfx(library, 'nothing like this'), null);

  const project = { clips: [
    { id: 'v', track: 'A1', start: 0, in: 0, out: 10, speed: 1, meta: undefined },
    { id: 'm', track: 'A2', start: 0, in: 0, out: 10, speed: 1, meta: { kind: 'music' } },
    { id: 's', track: 'A3', start: 4, in: 0, out: 1, speed: 1, meta: { kind: 'sfx' } }
  ] };
  assert.deepEqual(post.packCues(project, [{ at: 1, length: 1 }, { at: 1.5, length: 1 }, { at: 4.5, length: 0.2 }]), ['A3', 'A4', 'A4']);
  assert.deepEqual(post.speechGaps({ clips: [{ track: 'A1', start: 2, in: 0, out: 3, speed: 1 }, { track: 'A1', start: 7, in: 0, out: 1, speed: 1 }] }, 'A1', 12, 1.5), [{ from: 0, to: 2 }, { from: 5, to: 7 }, { from: 8, to: 12 }]);
});

function service(dir) {
  const tracked = [];
  const store = { values: { 'agent.port': 4870, 'agent.enabled': true }, get(key, fallback) { return key in this.values ? this.values[key] : fallback; }, set(key, value) { this.values[key] = value; } };
  const svc = new AgentService({
    store, appVersion: '3.1.0-test', userData: dir, ffmpeg, ffprobe,
    getSequenceInfo: () => null, requestSequenceInfo: () => {}, getActiveNLE: () => null, isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }), clearMarkers: async () => ({ success: false }), window: () => null,
    trackTool: id => tracked.push(id),
    engines: { sfxDir }
  });
  return { svc, tracked };
}

const rms = (file, from, length) => {
  return spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(length), '-i', file, '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level', '-f', 'null', '-']).stderr.toString();
};

test('music bed lifts where nobody speaks; SFX land level-matched on packed tracks', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-post-')));
  const voice = path.join(dir, 'voice.wav');
  const music = path.join(dir, 'music.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', voice]);
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:a=0.3', '-ac', '2', music]);
  const { svc, tracked } = service(dir);
  try {
    await svc.callTool('smoothy_edit', { action: 'new', name: 'Mix', folder: path.join(dir, 'Video'), fps: 24 }, 'mcp');
    const assets = (await svc.callTool('smoothy_edit', { action: 'import', paths: [voice, music] }, 'mcp')).data.assets;
    // Speech 0–4 s and 8–12 s; a 4 s gap (a chapter slate) in between.
    await svc.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'add', asset: assets[0].id, at: 0, track: 'A1' }, { op: 'add', asset: assets[0].id, at: 8, track: 'A1' }] }, 'mcp');
    const started = await svc.callTool('smoothy_edit', { action: 'music_bed', asset: assets[1].id, crossfade: 2 }, 'mcp');
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.data.liftWindows, 1);
    const done = await svc.callTool('smoothy_jobs', { action: 'wait', id: started.data.jobId, timeoutMs: 60000 }, 'mcp');
    assert.equal(done.data.job.status, 'done', JSON.stringify(done.data.job));
    const bed = done.data.job.result;
    assert.equal(bed.track, 'A2');
    assert.ok(bed.file.startsWith(path.join(dir, 'Video', 'Media', 'Music')));
    const level = (from, length) => Number(/RMS level dB:\s*(-?[\d.]+)/.exec(rms(bed.file, from, length))?.[1]);
    const under = level(1.5, 2);
    const lifted = level(5.2, 1.6);
    assert.ok(Math.abs(lifted - under - 9.5) < 1.5, `lift ${(lifted - under).toFixed(2)} dB (−24 vs −33.5 LUFS)`);

    const sfx = await svc.callTool('smoothy_edit', { action: 'sfx', cues: [{ at: 4, name: 'whoosh' }, { at: 4.1, name: 'mouse-click' }, { at: 6, name: 'kazoo solo' }] }, 'mcp');
    assert.equal(sfx.ok, true, JSON.stringify(sfx));
    assert.equal(sfx.data.placed, 2);
    assert.deepEqual(sfx.data.tracks, ['A3', 'A4']);
    assert.deepEqual(sfx.data.unknown, ['kazoo solo']);
    assert.equal(sfx.data.cues[0].gainDb, -15, 'whoosh peaks at −3 dBFS → −18');
    assert.ok(sfx.data.licenses.some(line => /whoosh/i.test(line)));
    const search = await svc.callTool('smoothy_edit', { action: 'sfx_search', query: 'chime' }, 'mcp');
    assert.ok(search.data.count >= 2);

    const rebuilt = await svc.callTool('smoothy_edit', { action: 'music_bed', asset: assets[1].id, crossfade: 2, waitMs: 0 }, 'mcp');
    await svc.callTool('smoothy_jobs', { action: 'wait', id: rebuilt.data.jobId, timeoutMs: 60000 }, 'mcp');
    const shown = await svc.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(shown.data.tracks.A2.length, 1, 'a new bed replaces the old one');

    assert.deepEqual(tracked.filter(id => ['agent_edit_music_bed', 'agent_edit_sfx'].includes(id)), ['agent_edit_music_bed', 'agent_edit_sfx', 'agent_edit_music_bed']);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('alpha overlays composite in the preview, proxy renders, glitch check flags blank frames', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-alpha-')));
  const base = path.join(dir, 'blue.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=2', '-pix_fmt', 'yuv420p', base]);
  const png = path.join(dir, 'lower-third.png');
  await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 160, height: 90, channels: 4, background: { r: 230, g: 20, b: 20, alpha: 1 } } }).png().toBuffer(), left: 240, top: 135 }]).png().toFile(png);
  const prores = path.join(dir, 'callout.mov');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:r=24:d=2,format=yuva444p10le,drawbox=x=40:y=40:w=80:h=60:color=yellow@1:t=fill:replace=1', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', prores]);
  const glitchy = path.join(dir, 'glitchy.mov');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=24:d=2,format=yuva444p10le,drawbox=x=100:y=60:w=120:h=60:color=white@1:t=fill', '-vf', "drawbox=enable='eq(n\\,24)':x=0:y=0:w=iw:h=ih:color=black@1:t=fill", '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', glitchy]);
  const { svc, tracked } = service(dir);
  try {
    await svc.callTool('smoothy_edit', { action: 'new', name: 'Alpha', width: 640, height: 360, fps: 24 }, 'mcp');
    const assets = (await svc.callTool('smoothy_edit', { action: 'import', paths: [base, png, prores] }, 'mcp')).data.assets;
    await svc.callTool('smoothy_edit', { action: 'ops', ops: [
      { op: 'add', asset: assets[0].id, at: 0, track: 'V1' },
      { op: 'add', asset: assets[1].id, at: 0, duration: 2, track: 'V2' },
      { op: 'add', asset: assets[2].id, at: 0, track: 'V3' }
    ] }, 'mcp');
    const frame = await svc.callTool('smoothy_render', { action: 'frame', time: 1, width: 640 }, 'mcp');
    const { data, info } = await sharp(Buffer.from(frame.imageDataUrl.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
    const [r1, g1, b1] = px(600, 330);
    assert.ok(b1 > 180 && r1 < 60, `transparent areas show V1 blue, got ${r1},${g1},${b1}`);
    const [r2, g2] = px(320, 180);
    assert.ok(r2 > 180 && g2 < 70, 'PNG overlay drawn');
    const [r3, g3, b3] = px(80, 70);
    assert.ok(r3 > 180 && g3 > 180 && b3 < 80, `ProRes 4444 overlay drawn, got ${r3},${g3},${b3}`);

    const proxy = await svc.callTool('smoothy_render', { action: 'proxy', width: 320 }, 'mcp');
    const done = await svc.callTool('smoothy_jobs', { action: 'wait', id: proxy.data.jobId, timeoutMs: 60000 }, 'mcp');
    assert.equal(done.data.job.status, 'done', JSON.stringify(done.data.job));
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=width', '-of', 'json', done.data.job.result.path]).toString());
    assert.equal(probe.streams[0].width, 320);

    const glitch = await svc.callTool('smoothy_analyze', { action: 'glitch_check', paths: [prores, glitchy] }, 'mcp');
    assert.equal(glitch.ok, true, JSON.stringify(glitch));
    assert.equal(glitch.data.checked, 2);
    assert.deepEqual(glitch.data.glitches, [{ file: 'glitchy.mov', frames: [24] }]);
    assert.ok(tracked.includes('agent_edit_proxy') && tracked.includes('agent_analyze_glitch'));
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
