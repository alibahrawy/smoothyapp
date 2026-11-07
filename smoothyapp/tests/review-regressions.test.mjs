import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
async function moduleAt(relative) {
  const output = await build({ entryPoints: [new URL(relative, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
const { formatCaptions } = await moduleAt('../src/main/captions/caption-formatter.ts');
const { generateMulticamSequenceXML } = await moduleAt('../src/main/autocut/xml-generator.ts');
const { generateSilenceRemovalXML } = await moduleAt('../src/main/autocut/silence-xml-generator.ts');
const { BridgeRequests } = await moduleAt('../src/main/bridge-requests.ts');
const { downloadFile } = await moduleAt('../src/main/captions/download-file.ts');
const clip = (name, start, end, inPoint, ext = 'mov') => ({ name, path: `/tmp/${name}.${ext}`, start, end, inPoint, outPoint: inPoint + end - start });
const cameras = [{ name: 'Camera 1', clips: [clip('first', 0, 5, 30), clip('later', 5, 10, 60)] }, { name: 'Camera 2', clips: [clip('second', 2, 10, 12)] }];
const microphones = [{ name: 'Mic', clips: [clip('microphone', 1, 9, 20, 'wav')] }];
const items = xml => [...xml.matchAll(/<clipitem\b[^>]*>([\s\S]*?)<\/clipitem>/g)].map(match => Object.fromEntries(['name', 'start', 'end', 'in', 'out'].map(tag => [tag, match[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1]])));
const hasItem = (xml, expected) => items(xml).some(item => Object.entries(expected).every(([key, value]) => item[key] === String(value)));

test('multicam preserves source trims, later files, camera gaps and selected microphone WAVs', () => {
  const xml = generateMulticamSequenceXML(cameras, [{ start: 0, end: 6, camera: 0 }, { start: 6, end: 10, camera: 1 }], { fps: 25, duration: 10, audioTracks: microphones });
  assert.ok(hasItem(xml, { name: 'first', start: 0, end: 125, in: 750, out: 875 }));
  assert.ok(hasItem(xml, { name: 'later', start: 125, end: 150, in: 1500, out: 1525 }));
  assert.ok(hasItem(xml, { name: 'second', start: 150, in: 400 }));
  assert.ok(hasItem(xml, { name: 'microphone', start: 25, end: 225, in: 500 }));
  assert.match(xml, /microphone\.wav/);
  assert.equal(items(xml.split('<audio><format>')[1]).some(item => item.name !== 'microphone'), false);
});
test('combined XML camera tracks remain chronological through repeated speaker switches', () => {
  const cameras = [0, 1, 2].map(index => ({ name: `Camera ${index + 1}`, clips: [clip(`camera-${index}`, 0, 12, 30)] }));
  const shots = [0, 1, 0, 1, 2, 0].map((camera, index) => ({ start: index * 2, end: (index + 1) * 2, camera }));
  const xml = generateMulticamSequenceXML(cameras, shots, { fps: 25, duration: 12 }, [{ start: 5, end: 7, camera: 2 }]);
  const tracks = [...xml.split('<video><format>')[1].split('</video>')[0].matchAll(/<track>([\s\S]*?)<\/track>/g)].map(match => match[1]);
  assert.equal(tracks.length, 3);
  for (const track of tracks) {
    let end = 0;
    for (const item of items(track)) { assert.ok(Number(item.start) >= end, 'Camera clips must not jump backwards or overlap'); end = Number(item.end); }
    assert.match(track, /<enabled>TRUE<\/enabled><locked>FALSE<\/locked>/);
  }
  assert.deepEqual(items(tracks[1]).map(item => item.name), shots.map(shot => `camera-${shot.camera}`));
  assert.equal(items(tracks[1]).at(-1).end, '300');
});
test('J-cut changes visual switches while keeping microphone sync', () => {
  const shots = [{ start: 0, end: 5, camera: 0 }, { start: 5, end: 10, camera: 1 }];
  const plain = generateMulticamSequenceXML(cameras, shots, { fps: 25, duration: 10, audioTracks: microphones });
  const delayed = generateMulticamSequenceXML(cameras, shots, { fps: 25, duration: 10, audioTracks: microphones, jcutOffset: 1 });
  assert.ok(hasItem(delayed, { name: 'second', start: 150, in: 400 }));
  assert.ok(hasItem(plain, { name: 'second', start: 125, in: 375 }));
  assert.deepEqual(items(delayed).filter(item => item.name === 'microphone'), items(plain).filter(item => item.name === 'microphone'));
});
test('silence reconstruction ripples every video and audio track through the same frame map', () => {
  const xml = generateSilenceRemovalXML(cameras, [{ start: 3, end: 7, duration: 4 }, { start: 8, end: 10, duration: 2 }], { fps: 25, audioTracks: microphones });
  assert.ok(hasItem(xml, { name: 'first', start: 0, end: 50, in: 825 }));
  assert.ok(hasItem(xml, { name: 'later', start: 50, end: 100, in: 1500 }));
  assert.ok(hasItem(xml, { name: 'later', start: 100, end: 150, in: 1575 }));
  assert.ok(hasItem(xml, { name: 'microphone', start: 0, in: 550 }));
  assert.match(xml, /<duration>150<\/duration>/);
});
test('missing timing and retimed clips fail before generating an incorrect sequence', () => {
  assert.throws(() => generateSilenceRemovalXML([{ name: 'Old bridge', clips: [{ name: 'missing', path: '/tmp/file.mov', start: 0, end: 10 }] }], [], { fps: 25 }), /timing/);
  assert.throws(() => generateSilenceRemovalXML([{ name: 'Speed change', clips: [{ ...clip('retimed', 0, 5, 0), outPoint: 10 }] }], [], { fps: 25 }), /normal-speed/);
  assert.throws(() => generateSilenceRemovalXML([{ name: 'Reverse', clips: [{ ...clip('reverse', 0, 5, 0), reversed: true }] }], [], { fps: 25 }), /normal-speed/);
});
test('mixed frame rates use source frames for trims and sequence frames for placement', () => {
  const xml = generateSilenceRemovalXML([{ name: '50fps camera', clips: [{ ...clip('high-rate', 2, 10, 30), mediaFps: 50 }] }], [{ start: 3, end: 7, duration: 4 }], { fps: 25 });
  assert.ok(hasItem(xml, { name: 'high-rate', start: 0, end: 100, in: 1550, out: 1750 }));
  assert.match(xml, /<timebase>50<\/timebase>/);
});
test('disabled media stays absent and does not block sequence generation', () => {
  const xml = generateSilenceRemovalXML([{ name: 'Camera', clips: [clip('enabled', 0, 5, 0), { name: 'offline disabled', disabled: true }] }], [{ start: 0, end: 5, duration: 5 }], { fps: 25 });
  assert.equal(items(xml).length, 1);
  assert.equal(items(xml)[0].name, 'enabled');
});
test('caption duration limit works for zero and nonzero starts', () => {
  for (const start of [0, 10]) {
    const chunks = Array.from({ length: 6 }, (_, index) => ({ text: 'word', timestamp: [start + index, start + index + 1] }));
    const captions = formatCaptions({ text: '', chunks }, { maxDurationSeconds: 3, maxCharsPerLine: 60 });
    assert.equal(captions.length, 2);
    assert.ok(captions.every(caption => caption.endTime - caption.startTime <= 3));
  }
});
test('wrapping preserves unbroken words, Japanese and Arabic without empty lines', () => {
  for (const text of ['thisisalongunbrokenwordthatmustallremainintheoutput', '日本語の長い文章でも文字を削除せず字幕のすべてを保持します', 'هذهالكلمةطويلةويجبأننحتفظبجميعحروفهابلااستثناء']) {
    const captions = formatCaptions({ text, chunks: [{ text, timestamp: [0, 4] }] }, { maxCharsPerLine: 20, maxLines: 2 });
    assert.equal(captions.map(caption => caption.text).join('').replace(/\s/g, ''), text);
    assert.ok(captions.every(caption => !caption.text.startsWith('\n') && !caption.text.includes('...') && caption.text.split('\n').length <= 2));
  }
});
test('an old bridge timer and late response cannot strand the next request', async () => {
  const sent = []; const bridge = new BridgeRequests(message => { sent.push(message); return true; });
  const first = bridge.request('importXML', 'xmlImported', {}, 15);
  bridge.receive({ type: 'xmlImported', requestId: sent[0].requestId, success: true }); await first;
  const second = bridge.request('importXML', 'xmlImported', {}, 200);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(bridge.receive({ type: 'xmlImported', requestId: sent[0].requestId, success: false }), false);
  assert.equal(bridge.receive({ type: 'xmlImported', requestId: sent[1].requestId, success: true }), true);
  assert.equal((await second).success, true);
});
test('bridge overlap, timeout, disconnect and send failures settle visibly', async () => {
  const bridge = new BridgeRequests(() => true); const first = bridge.request('image', 'imageImported', {}, 10);
  await assert.rejects(bridge.request('image', 'imageImported', {}, 10), /Wait/); await assert.rejects(first, /in time/);
  const next = bridge.request('image', 'imageImported', {}, 1000); bridge.disconnect(); await assert.rejects(next, /disconnected/);
  await assert.rejects(new BridgeRequests(() => false).request('image', 'imageImported', {}, 1000), /Not connected/);
});
test('cancel aborts a download, removes its partial file and allows a clean retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smoothy-download-test-'));
  const server = http.createServer((req, response) => { if (req.url === '/fast') { response.end('complete'); return; } response.writeHead(200, { 'content-length': 10000 }); response.write('partial'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const controller = new AbortController();
    await assert.rejects(downloadFile(url + '/slow', path.join(directory, 'model'), () => controller.abort(), 'model', controller.signal), /TRANSCRIPTION_CANCELLED/);
    assert.deepEqual(await readdir(directory), []);
    await downloadFile(url + '/fast', path.join(directory, 'model'));
    assert.equal(await readFile(path.join(directory, 'model'), 'utf8'), 'complete');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); }
});
test('the Premiere host rejects a sequence switch before any destructive edit', async () => {
  const source = await readFile(new URL('../../smoothyapp-cep/jsx/host.jsx', import.meta.url), 'utf8'); let edits = 0;
  const context = { app: { enableQE() {}, project: { activeSequence: { sequenceID: 'B' } } }, qe: { project: { getActiveSequence: () => ({ extract() { edits++; } }) } } };
  vm.createContext(context); vm.runInContext(source, context);
  const result = JSON.parse(context.removeSilenceWithQE(JSON.stringify({ sequenceId: 'A', segments: [{ start: 0, end: 2 }] })));
  assert.equal(result.success, false); assert.match(result.error, /sequence changed/); assert.equal(edits, 0);
});
test('clearing Smoothy markers preserves personal markers and guards sequence identity', async () => {
  const source = await readFile(new URL('../../smoothyapp-cep/jsx/host.jsx', import.meta.url), 'utf8');
  const markers = [{ comments: 'My edit note' }, { comments: '[SmoothyEdit] Short start' }, { comments: '[SmoothyEdit] Short end' }];
  const removed = [];
  const context = { app: { project: { activeSequence: { sequenceID: 'A', markers: {
    getFirstMarker: () => markers[0], getNextMarker: marker => markers[markers.indexOf(marker) + 1], deleteMarker: marker => removed.push(marker)
  } } } } };
  vm.createContext(context); vm.runInContext(source, context);
  assert.equal(JSON.parse(context.clearAllMarkers('all', 'B')).success, false);
  assert.equal(removed.length, 0);
  assert.equal(JSON.parse(context.clearAllMarkers('smoothy', 'A')).count, 2);
  assert.equal(removed.includes(markers[0]), false);
  removed.length = 0;
  assert.equal(JSON.parse(context.clearAllMarkers('all', 'A')).count, 3);
});
