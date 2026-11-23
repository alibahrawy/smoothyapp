import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const vision = await load('src/main/agent/vision.ts');
const photos = await load('src/main/agent/photos.ts');
const { AgentService } = await load('src/main/agent/agent-service.ts');
const ffprobe = path.join(root, 'node_modules/ffprobe-static/bin', process.platform === 'darwin' ? 'darwin' : 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const ffmpeg = path.join(root, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const realHelper = path.join(root, 'resources/vision/smoothy-vision');

test('sampling, spans and region measures', () => {
  assert.deepEqual(vision.sampleTimes({ clips: [{ id: 'a', srcIn: 10, srcOut: 13 }], from: 0, to: 0, fps: 1 }), [{ t: 11, clip: 'a' }, { t: 12, clip: 'a' }]);
  assert.equal(vision.sampleTimes({ from: 0, to: 2, fps: 2 }).length, 4);
  const flags = [0, 0.33, 0.67, 1, 1.33, 1.67, 2, 2.33].map((t, i) => ({ t, flag: [2, 3, 4, 7].includes(i) }));
  assert.deepEqual(vision.flaggedSpans(flags, 1 / 3, 0.4), [{ from: 0.67, to: 1.663 }]);
  assert.equal(vision.median([3, 1, 2]), 2);

  const w = 8; const frame = Buffer.alloc(w * 4 * 3);
  for (let i = 0; i < w * 4; i += 1) { const red = i % w >= 4; frame[i * 3] = red ? 220 : 250; frame[i * 3 + 1] = red ? 20 : 250; frame[i * 3 + 2] = red ? 20 : 250; }
  assert.equal(vision.brightness(frame, w, [0, 0, 4, 4], 1), 250);
  assert.equal(vision.colorFraction(frame, w, [0, 0, 8, 4], { r: [110, 255], g: [0, 75], b: [0, 85] }, 1), 0.5);
  const h = vision.histogram(frame, w, [0, 0, 8, 4], 1);
  assert.equal(vision.intersection(h, h), 1);
  assert.equal(vision.intersection(vision.histogram(frame, w, [0, 0, 4, 4], 1), vision.histogram(frame, w, [4, 0, 4, 4], 1)), 0);
  assert.equal(vision.classify(245, [{ label: 'board', min: 200 }, { label: 'not', max: 200 }]), 'board');
  assert.deepEqual(vision.labelSpans([{ t: 0, label: 'a' }, { t: 0.25, label: 'a' }, { t: 0.5, label: 'b' }], 0.25), [{ label: 'a', from: 0, to: 0.5 }, { label: 'b', from: 0.5, to: 0.75 }]);
});

test('Commons licences fail closed; stock attribution classes; credit lines', () => {
  const page = (id, license, extra = {}) => ({ pageid: id, index: id, title: `File:Photo ${id}.jpg`, imageinfo: [{ mime: 'image/jpeg', width: 5000, height: 3000, url: `https://upload.wikimedia.org/o/${id}.jpg`, thumburl: `https://upload.wikimedia.org/t/3840px-${id}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${id}`, extmetadata: { LicenseShortName: { value: license }, AttributionRequired: { value: license.startsWith('CC BY') ? 'true' : 'false' }, Artist: { value: '<a href="x">Jane Doe</a>' }, ObjectName: { value: `Walk-in tub ${id}` }, ...extra } }] });
  assert.equal(photos.normalizePhoto(page(1, 'CC0'), 'pd').download, 'https://upload.wikimedia.org/t/3840px-1.jpg', 'oversized originals use the 3840 px rendition');
  assert.equal(photos.normalizePhoto(page(2, 'CC BY 4.0'), 'pd'), null);
  assert.equal(photos.normalizePhoto(page(2, 'CC BY 4.0'), 'cc-by').author, 'Jane Doe');
  assert.equal(photos.normalizePhoto(page(3, 'CC BY-SA 4.0'), 'cc-by'), null, 'share-alike is never offered');
  assert.equal(photos.normalizePhoto(page(4, 'CC BY-NC 2.0'), 'cc-by'), null);
  const svg = page(5, 'CC0'); svg.imageinfo[0].mime = 'image/svg+xml';
  assert.equal(photos.normalizePhoto(svg, 'pd'), null);
  assert.equal(photos.stockAttribution('Pixabay Content License'), 'none');
  assert.equal(photos.stockAttribution('NASA media guidelines'), 'credit recommended');
  assert.equal(photos.stockAttribution('Something else'), 'unknown');
  assert.equal(photos.creditLine({ name: 'x.jpg', source: { provider: 'Wikimedia Commons', license: 'CC BY 4.0', credit: '"Tub" by Jane', url: 'https://commons.wikimedia.org/wiki/File:1' } }), '"Tub" by Jane — CC BY 4.0 — Wikimedia Commons — https://commons.wikimedia.org/wiki/File:1');
  assert.equal(photos.creditLine({ name: 'x.wav' }), null);
});

function service(dir, extra = {}) {
  const tracked = [];
  const store = { values: { 'agent.port': 4880, 'agent.enabled': true, 'agent.autoApprove': true }, get(key, fallback) { return key in this.values ? this.values[key] : fallback; }, set(key, value) { this.values[key] = value; } };
  const svc = new AgentService({
    store, appVersion: '3.1.0-test', userData: dir, ffmpeg, ffprobe,
    getSequenceInfo: () => null, requestSequenceInfo: () => {}, getActiveNLE: () => null, isEditorConnected: () => false,
    addMarkers: async () => ({ success: false }), clearMarkers: async () => ({ success: false }), window: () => null,
    trackTool: id => tracked.push(id), ...extra
  });
  return { svc, tracked };
}

const finish = async (svc, result) => {
  if (result.data?.status !== 'running') return result;
  const waited = await svc.callTool('smoothy_jobs', { action: 'wait', id: result.data.jobId, timeoutMs: 60000 }, 'mcp');
  return { ok: waited.data.job.status === 'done', data: waited.data.job.result, error: waited.data.job.error };
};

test('layout_scan finds when the share area stops being a whiteboard and a tile changes', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-layout-')));
  const video = path.join(dir, 'meeting.mp4');
  // 0–2 s: white share area, red speaker tile. 2–4 s: gray share area, blue tile (someone else).
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=12:d=2,drawbox=x=480:y=40:w=140:h=80:color=0xdd2020:t=fill[a];color=c=gray:s=640x360:r=12:d=2,drawbox=x=480:y=40:w=140:h=80:color=0x2040dd:t=fill[b];[a][b]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', video]);
  const { svc, tracked } = service(dir);
  try {
    const result = await finish(svc, await svc.callTool('smoothy_analyze', { action: 'layout_scan', path: video, fps: 4, clips: [{ id: 'A1', src_in: 0, src_out: 1.5 }, { id: 'B2', src_in: 2.5, src_out: 3.5 }], regions: [
      { name: 'share', rect: [0, 140, 440, 200], measure: 'brightness', classes: [{ label: 'whiteboard', min: 200 }, { label: 'no board', max: 200 }] },
      { name: 'tile', rect: [480, 40, 140, 80], measure: 'match', reference: 0.5, classes: [{ label: 'speaker', min: 0.6 }, { label: 'someone else', max: 0.6 }] }
    ] }, 'mcp'));
    assert.equal(result.ok, true, JSON.stringify(result));
    const [share, tile] = result.data.regions;
    assert.deepEqual(share.seconds, { whiteboard: 2, 'no board': 2 });
    assert.deepEqual(tile.spans.map(span => [span.label, span.from, span.to]), [['someone else', 2, 4]]);
    assert.deepEqual(share.clipsWith, { 'no board': ['B2'] });
    assert.ok(tracked.includes('agent_vision_layout'));
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('vision_faces anchors per clip and applies them; hands spans; real helper smoke test', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-faces-')));
  const video = path.join(dir, 'speaker.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=6', '-pix_fmt', 'yuv420p', video]);
  // A stand-in helper: the eye drifts with the frame number; frames 5-10 of the hands scan are "covered".
  const fake = path.join(dir, 'vision');
  await fs.writeFile(fake, `#!/bin/sh
cmd="$1"; shift; i=0
for f in "$@"; do
  if [ "$cmd" = "faces" ]; then echo "{\\"path\\":\\"$f\\",\\"faces\\":1,\\"eye\\":[0.$((40 + i)),0.30],\\"width\\":0.2}";
  else c=false; if [ $i -ge 5 ] && [ $i -le 10 ]; then c=true; fi; echo "{\\"path\\":\\"$f\\",\\"face\\":true,\\"covered\\":$c,\\"points\\":5}"; fi
  i=$((i + 1))
done
`, { mode: 0o755 });
  const { svc, tracked } = service(dir, { engines: { visionHelper: fake } });
  try {
    if (process.platform !== 'darwin') {
      const refused = await svc.callTool('smoothy_analyze', { action: 'vision_faces', path: video }, 'mcp');
      assert.equal(refused.error.code, 'E_NOT_IMPLEMENTED');
      return;
    }
    await svc.callTool('smoothy_edit', { action: 'new', name: 'Faces', fps: 24, width: 640, height: 360 }, 'mcp');
    const asset = (await svc.callTool('smoothy_edit', { action: 'import', paths: [video] }, 'mcp')).data.assets[0].id;
    await svc.callTool('smoothy_edit', { action: 'ops', ops: [{ op: 'add', asset, in: 0, out: 3, name: '1a', meta: { cutId: '1a' } }, { op: 'add', asset, in: 3, out: 6, name: '1b' }] }, 'mcp');
    const clips = [{ id: '1a', srcIn: 0, srcOut: 3 }, { id: '1b', srcIn: 3, srcOut: 6 }];
    const faces = await finish(svc, await svc.callTool('smoothy_analyze', { action: 'vision_faces', path: video, clips, perClip: 3, apply: true, zoom: 1.25 }, 'mcp'));
    assert.equal(faces.ok, true, JSON.stringify(faces));
    assert.equal(faces.data.samples, 6);
    assert.deepEqual(faces.data.anchors['1a'], { x: 0.41, y: 0.3, samples: 3 });
    assert.deepEqual(faces.data.anchors['1b'], { x: 0.44, y: 0.3, samples: 3 });
    assert.equal(faces.data.applied.applied, 2);
    const shown = await svc.callTool('smoothy_edit', { action: 'show' }, 'mcp');
    assert.ok(shown.data.tracks.V1[0].includes('zoom1.25@0.41,0.30'), shown.data.tracks.V1[0]);

    const hands = await finish(svc, await svc.callTool('smoothy_analyze', { action: 'vision_hands_on_face', path: video, from: 0, to: 6, fps: 3 }, 'mcp'));
    assert.equal(hands.ok, true, JSON.stringify(hands));
    assert.equal(hands.data.samples, 18);
    assert.equal(hands.data.spans.length, 1);
    assert.ok(Math.abs(hands.data.spans[0].from - 1.667) < 0.002 && Math.abs(hands.data.spans[0].to - 3.667) < 0.002, JSON.stringify(hands.data.spans));

    if (existsSync(realHelper)) {
      // The real Apple Vision helper on a frame with no face.
      const out = execFileSync(realHelper, ['faces', path.join(root, 'build/icon.png')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      assert.equal(JSON.parse(out).faces, 0);
    }
    assert.ok(tracked.includes('agent_vision_faces') && tracked.includes('agent_vision_hands'));
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('photos: licence-filtered search, approved download capped at 3840 px, credits file; oversized imports', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoothy-photos-')));
  const big = await sharp({ create: { width: 5000, height: 3000, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.startsWith('https://commons.wikimedia.org/w/api.php')) {
      const page = (id, license) => ({ pageid: id, index: id, title: `File:Tub ${id}.jpg`, imageinfo: [{ mime: 'image/jpeg', width: 5000, height: 3000, url: `https://upload.wikimedia.org/o/${id}.jpg`, thumburl: `https://upload.wikimedia.org/t/${id}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:Tub_${id}.jpg`, extmetadata: { LicenseShortName: { value: license }, AttributionRequired: { value: license === 'CC0' ? 'false' : 'true' }, Artist: { value: 'Jane Doe' }, ObjectName: { value: `Walk-in tub ${id}` } } }] });
      return { ok: true, status: 200, json: async () => ({ query: { pages: { 1: page(1, 'CC0'), 2: page(2, 'CC BY 4.0'), 3: page(3, 'CC BY-SA 3.0') } } }) };
    }
    return { ok: true, status: 200, headers: { get: () => String(big.length) }, arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length) };
  };
  const { svc, tracked } = service(dir, { fetcher });
  try {
    const folder = path.join(dir, 'Video');
    await svc.callTool('smoothy_edit', { action: 'new', name: 'Photos', folder }, 'mcp');
    const pd = await svc.callTool('smoothy_library', { action: 'photo', query: 'walk-in tub' }, 'mcp');
    assert.deepEqual(pd.data.photos.map(photo => photo.license), ['CC0']);
    assert.match(calls[0], /gsrsearch=filetype%3Abitmap\+walk-in\+tub/);
    const by = await svc.callTool('smoothy_library', { action: 'photo', query: 'walk-in tub', license: 'cc-by' }, 'mcp');
    assert.deepEqual(by.data.photos.map(photo => photo.license), ['CC0', 'CC BY 4.0']);

    const add = await svc.callTool('smoothy_library', { action: 'add', kind: 'photo', id: '2' }, 'mcp');
    const done = await svc.callTool('smoothy_jobs', { action: 'wait', id: add.data.jobId, timeoutMs: 30000 }, 'mcp');
    assert.equal(done.data.job.status, 'done', JSON.stringify(done.data.job));
    const result = done.data.job.result;
    assert.equal(result.asset.size, '3840x2304');
    assert.equal(result.resized, true);
    assert.equal(result.credit, '"Walk-in tub 2" by Jane Doe');
    const credits = await fs.readFile(path.join(folder, 'Edit', 'CREDITS.txt'), 'utf8');
    assert.equal(credits, '"Walk-in tub 2" by Jane Doe — CC BY 4.0 — Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Tub_2.jpg\n');
    assert.ok((await fs.stat(path.join(folder, 'Media', 'Photos', 'Walk-in-tub-2.jpg'))).size > 0);

    // A photo imported from disk: oversized → a 3840 px copy in Media/Photos; importing it again reuses the asset.
    const local = path.join(dir, 'product shot.jpg');
    await fs.writeFile(local, big);
    const imported = await svc.callTool('smoothy_edit', { action: 'import', paths: [local] }, 'mcp');
    assert.equal(imported.data.assets[0].size, '3840x2304');
    const again = await svc.callTool('smoothy_edit', { action: 'import', paths: [local] }, 'mcp');
    assert.equal(again.data.assets[0].id, imported.data.assets[0].id);

    const rewritten = await svc.callTool('smoothy_library', { action: 'credits' }, 'mcp');
    assert.equal(rewritten.data.count, 1);
    const music = await svc.callTool('smoothy_library', { action: 'music', license: 'claim-clear' }, 'mcp');
    assert.equal(music.error.code, 'E_BAD_REQUEST');
    assert.match(music.error.message, /does not state licences/);
    assert.deepEqual(tracked.filter(id => id.startsWith('agent_photo') || id === 'agent_credits_written'), ['agent_photo_search', 'agent_photo_search', 'agent_photo_add', 'agent_credits_written']);
  } finally {
    await svc.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
