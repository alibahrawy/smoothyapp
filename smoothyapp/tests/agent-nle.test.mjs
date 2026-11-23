import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
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

const transform = await load('src/main/agent/transform.ts');
const nle = await load('src/main/agent/nle.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('Basic Motion math: scale 200×zoom and the calibrated eye-anchored center', () => {
  const cam = { width: 1920, height: 1080 };
  for (const [z, ex, ey] of [[1, 0.5, 0.5], [1.25, 0.47, 0.38], [1.6, 0.61, 0.44]]) {
    const p = transform.placement(cam, { zoom: z, anchor: { x: ex, y: ey }, fit: 'cover' }, 3840, 2160);
    const m = transform.motionValues(cam, p, 3840, 2160);
    assert.ok(close(m.scale, 200 * z), `scale ${m.scale}`);
    assert.ok(close(m.horiz, 2 * (z - 1) * (0.5 - ex)), `horiz ${m.horiz}`);
    assert.ok(close(m.vert, 2 * (z - 1) * (0.5 - ey)), `vert ${m.vert}`);
    assert.equal(m.crop, null);
  }
  // A region (a meeting speaker tile): centered at zoom 1, and the anchor stays put when zooming.
  const tile = { width: 1920, height: 1080, crop: { x: 1484, y: 407, w: 410, h: 230 } };
  const at = (p, sx, sy) => [1920 + p.dx + (sx - 960) * p.scale, 1080 + p.dy + (sy - 540) * p.scale];
  const p1 = transform.placement(tile, { fit: 'cover' }, 3840, 2160);
  assert.ok(close(p1.scale, Math.max(3840 / 410, 2160 / 230)));
  const [cx, cy] = at(p1, 1484 + 205, 407 + 115);
  assert.ok(close(cx, 1920, 1e-6) && close(cy, 1080, 1e-6), 'region center at canvas center');
  const anchor = { x: 0.5, y: 0.4 };
  const before = at(transform.placement(tile, { fit: 'cover', anchor }, 3840, 2160), 1484 + 205, 407 + 92);
  const after = at(transform.placement(tile, { fit: 'cover', anchor, zoom: 1.3 }, 3840, 2160), 1484 + 205, 407 + 92);
  assert.ok(close(before[0], after[0], 1e-6) && close(before[1], after[1], 1e-6), 'the anchor does not move');
  const m = transform.motionValues(tile, p1, 3840, 2160);
  assert.ok(close(m.crop.left, 1484 / 1920 * 100) && close(m.crop.top, 407 / 1080 * 100));
  assert.ok(close(m.crop.right, (1920 - 1894) / 1920 * 100) && close(m.crop.bottom, (1080 - 637) / 1080 * 100));
});

test('live diff matches clips by name: trims, removals, splits and J/L cuts', () => {
  const exported = [
    { name: 'CAM 1a', track: 'V1', kind: 'video', path: '/m/a.mp4', start: 0, end: 2, srcIn: 10, srcOut: 12, clipId: 'c1', asset: 'a1', meta: { cutId: '1a', chapter: 'ONE', text: 'hello there' } },
    { name: 'CAM 1b', track: 'V1', kind: 'video', path: '/m/a.mp4', start: 2, end: 4, srcIn: 20, srcOut: 22, clipId: 'c2', asset: 'a1', meta: { cutId: '1b' } },
    { name: 'CAM 1c', track: 'V1', kind: 'video', path: '/m/a.mp4', start: 4, end: 5, srcIn: 30, srcOut: 31, clipId: 'c3', asset: 'a1' }
  ];
  const sequence = {
    hasSequence: true, name: 'Edit (v1)', fps: 24,
    videoTracks: [{ index: 0, clips: [
      { name: 'CAM 1a', path: '/m/a.mp4', start: 0, end: 1.5, inPoint: 10.5, outPoint: 12 },
      { name: 'CAM 1b', path: '/m/a.mp4', start: 1.5, end: 2.5, inPoint: 20, outPoint: 21 },
      { name: 'CAM 1b', path: '/m/a.mp4', start: 2.5, end: 3, inPoint: 21.5, outPoint: 22 },
      { name: 'Broll', path: '/m/b.mp4', start: 3, end: 4, inPoint: 0, outPoint: 1 }
    ] }],
    audioTracks: [{ index: 0, clips: [{ name: 'CAM 1a', path: '/m/a.mp4', start: 0, end: 1.5, inPoint: 10.25, outPoint: 11.75 }] }]
  };
  const tracks = nle.liveTracks(sequence);
  const diff = nle.diffTrack('V1', tracks[0].clips, exported, 24);
  assert.deepEqual(diff.trimmed, [{ name: 'CAM 1a', inBy: 0.5, outBy: 0 }, { name: 'CAM 1b', inBy: 0, outBy: -1 }]);
  assert.deepEqual(diff.removed.map(item => item.name), ['CAM 1c']);
  assert.deepEqual(diff.added.map(item => item.name), ['Broll']);
  assert.deepEqual(diff.splits, ['CAM 1b']);
  const list = nle.liveClipList(diff, tracks[1], 24);
  assert.deepEqual(list.clips.map(clip => clip.id), ['1a', '1b', '1b#1', 'Broll']);
  assert.equal(list.clips[0].chapter, 'ONE');
  assert.equal(list.clips[0].text, 'hello there');
  assert.deepEqual(list.avMismatch, [{ name: 'CAM 1a', video: [10.5, 12], audio: [10.25, 11.75] }]);
});

async function media(dir) {
  // 1920x1080 test card: black with a red speaker tile at (1484, 407, 410, 230), 2 s at 24 fps with audio.
  const card = path.join(dir, 'card.png');
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: await sharp({ create: { width: 410, height: 230, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer(), left: 1484, top: 407 }])
    .png().toFile(card);
  const video = path.join(dir, 'meeting recording.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-loop', '1', '-framerate', '24', '-i', card, '-f', 'lavfi', '-i', 'sine=duration=2', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  return video;
}

test('regions, zoom and XML export, import, live diff and apply', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-nle-')));
  const video = await media(dir);
  const tracked = [];
  const imported = [];
  let sequence = null;
  const store = { values: { 'agent.port': 4860, 'agent.enabled': true, 'agent.autoApprove': true }, get(key, fallback) { return key in this.values ? this.values[key] : fallback; }, set(key, value) { this.values[key] = value; } };
  const svc = new AgentService({
    store, appVersion: '3.1.0-test', userData: dir, ffmpeg, ffprobe,
    getSequenceInfo: () => sequence, requestSequenceInfo: () => {}, getActiveNLE: () => 'premiere', isEditorConnected: () => true,
    addMarkers: async () => ({ success: false }), clearMarkers: async () => ({ success: false }), window: () => null,
    trackTool: id => tracked.push(id),
    importXml: async file => { imported.push(file); return { success: true }; }
  });
  try {
    const folder = path.join(dir, 'Video 02');
    await svc.callTool('smoothy_edit', { action: 'new', name: 'TAG 02', folder, width: 3840, height: 2160, fps: 24 }, 'mcp');
    const assetId = (await svc.callTool('smoothy_edit', { action: 'import', paths: [video] }, 'mcp')).data.assets[0].id;
    const region = await svc.callTool('smoothy_edit', { action: 'region', asset: assetId, name: 'speaker', crop: [1484, 407, 410, 230] }, 'mcp');
    assert.equal(region.ok, true, JSON.stringify(region));
    const speaker = region.data.asset.id;
    await svc.callTool('smoothy_edit', { action: 'ops', ops: [
      { op: 'add', asset: speaker, in: 0, out: 1, name: 'CAM 1a', meta: { cutId: '1a', chapter: 'ONE' } },
      { op: 'add', asset: assetId, in: 1, out: 2, name: 'WIDE 1b', zoom: 1.5, anchor: [0.5, 0.4] }
    ] }, 'mcp');

    // The preview uses the same geometry: the region fills the frame with the red tile.
    const frame = await svc.callTool('smoothy_render', { action: 'frame', time: 0.5, width: 640 }, 'mcp');
    const png = Buffer.from(frame.imageDataUrl.split(',')[1], 'base64');
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[5, 5], [320, 180], [634, 354]]) {
      const i = (y * info.width + x) * info.channels;
      assert.ok(data[i] > 180 && data[i + 1] < 70, `pixel ${x},${y} is red: ${data[i]},${data[i + 1]},${data[i + 2]}`);
    }

    const first = await svc.callTool('smoothy_nle', { action: 'export_xml', markers: [{ title: 'Intro', at: 0 }, { title: 'One', at: 1 }] }, 'mcp');
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.sequenceName, 'TAG 02 (v1)');
    assert.equal(first.data.file, path.join(folder, 'Edit', 'TAG 02 (v1).xml'));
    const xml = await fs.readFile(first.data.file, 'utf8');
    assert.match(xml, /<timebase>24<\/timebase><ntsc>FALSE<\/ntsc>/);
    assert.match(xml, /<name>CAM 1a<\/name>/);
    assert.match(xml, /<effectid>crop<\/effectid>[\s\S]*?<parameterid>left<\/parameterid><name>left<\/name><valuemin>0<\/valuemin><valuemax>100<\/valuemax><value>77\.2917<\/value>/);
    assert.match(xml, /<parameterid>scale<\/parameterid><name>Scale<\/name><valuemin>0<\/valuemin><valuemax>1000<\/valuemax><value>939\.130<\/value>/);
    assert.match(xml, /<parameterid>scale<\/parameterid>[^]*?<value>300\.000<\/value>[^]*?<horiz>0\.000000<\/horiz><vert>0\.100000<\/vert>/, 'wide shot: 200 × 1.5 and vert = 2(0.5)(0.1)');
    assert.equal((xml.match(/<link>/g) || []).length, 8, 'each linked clipitem lists both members (itself included), as FCP7 writes it');
    assert.equal((xml.match(/<marker>/g) || []).length, 2);
    assert.match(xml, /<pathurl>file:\/\/localhost\/[^<]*meeting%20recording\.mp4<\/pathurl>/);

    const second = await svc.callTool('smoothy_nle', { action: 'export_xml' }, 'mcp');
    assert.equal(second.data.sequenceName, 'TAG 02 (v2)', 'versions count up and never overwrite');

    const imp = await svc.callTool('smoothy_nle', { action: 'import_xml' }, 'mcp');
    assert.equal(imp.ok, true, JSON.stringify(imp));
    assert.deepEqual(imported, [second.data.file]);

    // The editor trimmed CAM 1a and deleted the wide shot in the imported v2.
    sequence = { hasSequence: true, name: 'TAG 02 (v2)', fps: 24,
      videoTracks: [{ index: 0, clips: [{ name: 'CAM 1a', path: video, start: 0, end: 0.75, inPoint: 0.25, outPoint: 1 }] }],
      audioTracks: [{ index: 0, clips: [{ name: 'CAM 1a', path: video, start: 0, end: 0.75, inPoint: 0.25, outPoint: 1 }] }] };
    const diff = await svc.callTool('smoothy_nle', { action: 'live_diff', settleMs: 0, apply: true }, 'mcp');
    assert.equal(diff.ok, true, JSON.stringify(diff));
    assert.deepEqual(diff.data.trimmed, [{ name: 'CAM 1a', inBy: 0.25, outBy: 0 }]);
    assert.deepEqual(diff.data.removed.map(item => item.name), ['WIDE 1b']);
    assert.equal(diff.data.applied.rebuilt, 1);
    const shown = await svc.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.equal(shown.data.duration, 0.75);
    assert.ok(shown.data.tracks.V1[0].includes('src 0.25-1.00') && shown.data.tracks.V1[0].includes('"CAM 1a"'), shown.data.tracks.V1[0]);
    const clips = JSON.parse(await fs.readFile(diff.data.files.clips, 'utf8')).clips;
    assert.deepEqual(clips.map(clip => [clip.id, clip.chapter, clip.srcIn]), [['1a', 'ONE', 0.25]]);
    const versions = await svc.callTool('smoothy_edit', { action: 'versions' }, 'mcp');
    assert.match(versions.data.versions[0].label, /before applying the editor's cut/);
    assert.equal((await svc.callTool('smoothy_edit', { action: 'undo' }, 'mcp')).data.duration, 2, 'one undo restores the agent version');

    // Offline media blocks the import.
    await fs.rename(video, `${video}.moved`);
    const offline = await svc.callTool('smoothy_nle', { action: 'import_xml' }, 'mcp');
    assert.equal(offline.error.code, 'E_BAD_REQUEST');
    assert.match(offline.error.message, /missing/);

    assert.deepEqual(tracked.filter(id => id.startsWith('agent_nle_')), ['agent_nle_export', 'agent_nle_export', 'agent_nle_import', 'agent_nle_live_diff']);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
