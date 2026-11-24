import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}
const pro = await load('../src/main/captions/pro-captions.ts');
const formatter = await load('../src/main/captions/caption-formatter.ts');
const host = await readFile(new URL('../../smoothyapp-cep/jsx/host.jsx', import.meta.url), 'utf8');

const words = list => list.map(([text, start, end]) => ({ text, start, end }));

test('word timings are relative to the caption and hold until the next word starts', () => {
  const caption = { index: 1, startTime: 10, endTime: 12, text: 'Hello big world', words: words([['Hello', 10, 10.4], ['big', 10.6, 11], ['world', 11.2, 11.8]]) };
  assert.deepEqual(pro.wordTimingsFor(caption), [[0, 0.6], [0.6, 1.2], [1.2, 2]]);
});

test('edited text that no longer matches the transcription spreads words by length', () => {
  const caption = { index: 1, startTime: 0, endTime: 3, text: 'one two\nthree', words: words([['one', 0, 1], ['two', 1, 2]]) };
  const timings = pro.wordTimingsFor(caption);
  assert.equal(timings.length, 3);
  assert.equal(timings[0][0], 0);
  assert.equal(timings.at(-1)[1], 3);
  for (let i = 1; i < timings.length; i++) assert.equal(timings[i][0], timings[i - 1][1]);
});

test('timings are clamped into the caption and never go backwards', () => {
  const caption = { index: 1, startTime: 5, endTime: 6, text: 'a b c', words: words([['a', 4.5, 5.2], ['b', 5.6, 5.8], ['c', 5.4, 7]]) };
  const timings = pro.wordTimingsFor(caption);
  assert.deepEqual(timings.map(pair => pair[0]), [0, 0.6, 0.6]);
  assert.equal(timings.at(-1)[1], 1);
});

test('payload skips empty or invalid captions and normalizes the style', () => {
  const payload = pro.buildProCaptionPayload([
    { index: 1, startTime: 0, endTime: 1, text: 'Hi there' },
    { index: 2, startTime: 2, endTime: 2, text: 'zero length' },
    { index: 3, startTime: 3, endTime: 4, text: '   ' },
  ], { textColor: '#00ff80', boxColor: 'red', boxHeight: 999, size: 1, verticalPosition: 50 });
  assert.equal(payload.captions.length, 1);
  assert.equal(payload.captions[0].timings.split(';').length, 2);
  const { textColor, boxColor, boxHeight, size, verticalPosition } = payload.style;
  assert.deepEqual({ textColor, boxColor, boxHeight, size, verticalPosition },
    { textColor: [0, 255, 128], boxColor: [146, 243, 136], boxHeight: 240, size: 25, verticalPosition: 50 });
  assert.equal(payload.template, 'box-highlight');
  assert.throws(() => pro.buildProCaptionPayload([]), /No captions/);
});

test('formatter keeps per-word timings that match each caption', () => {
  const chunks = [['Hello', 0, 0.4], ['world.', 0.5, 1], ['Next', 1.2, 1.5], ['line', 1.6, 2]]
    .map(([text, start, end]) => ({ text, timestamp: [start, end] }));
  const captions = formatter.formatCaptions({ text: '', chunks }, { minDurationSeconds: 0.1 });
  assert.equal(captions.length, 2);
  assert.deepEqual(captions[0].words.map(word => word.text), ['Hello', 'world.']);
  assert.deepEqual(captions[1].words.map(word => [word.start, word.end]), [[1.2, 1.5], [1.6, 2]]);
  for (const caption of captions) assert.equal(pro.splitCaptionWords(caption.text).length, caption.words.length);
});

function premiereFixture({ addTrackWorks = true, frame = [1920, 1080], templateDefaults = null, copies = false, copyBreaksAt = Infinity } = {}) {
  const calls = { imports: [], text: {}, colors: {}, numbers: {}, history: {}, clips: [], writes: [] };
  const track = () => {
    const t = { clips: { numItems: 0 }, name: '' };
    if (copies) t.overwriteClip = (item, ticks) => {
      calls.copies = (calls.copies || 0) + 1;
      if (item !== templateItem || calls.copies >= copyBreaksAt) throw new Error('overwrite failed');
      placeClip(ticks, videoTracks.indexOf(t));
    };
    return t;
  };
  const templateItem = { nodeId: 'template' };
  const videoTracks = [track(), track()];
  Object.defineProperty(videoTracks, 'numTracks', { get: () => videoTracks.length });
  const param = (name, kind) => {
    const initial = templateDefaults?.[name];
    const p = {
      getValue: () => kind === 'text' ? JSON.stringify({ textEditValue: 'x', fontTextRunLength: [1], fontEditValue: ['Arial-BoldMT'] }) : (initial ?? 0),
      setValue: (value, updateUI) => { calls.writes.push([calls.clips.length, name, updateUI]); if (kind === 'text') calls.text[name] = (calls.text[name] || []).concat(JSON.parse(value).textEditValue); else { calls.numbers[name] = value; (calls.history[name] ||= []).push(value); } },
      setColorValue: (a, r, g, b, updateUI) => { calls.writes.push([calls.clips.length, name, updateUI]); calls.colors[name] = [a, r, g, b]; },
    };
    if (kind === 'color' && initial) p.getColorValue = () => initial;
    return p;
  };
  const seq = {
    sequenceID: 'seq-1',
    frameSizeHorizontal: frame[0],
    frameSizeVertical: frame[1],
    videoTracks,
    importMGT(path, ticks, trackIndex) {
      calls.imports.push({ path, seconds: Number(ticks) / 254016000000, trackIndex });
      return placeClip(ticks, trackIndex);
    },
  };
  function placeClip(ticks, trackIndex) {
    const params = { 'Caption Text': param('Caption Text', 'text'), 'Word Timings': param('Word Timings', 'text') };
    for (const name of ['Text Color', 'Box Color']) params[name] = param(name, 'color');
    for (const name of ['Upcoming Word Opacity', 'Box Opacity', 'Box Radius', 'Box Padding', 'Box Height', 'Shadow Opacity', 'Caption Size', 'Vertical Position', 'Pop In']) params[name] = param(name, 'number');
    const scaleProp = { displayName: 'Scale', setValue: value => { (calls.history.motionScale ||= []).push(value); } };
    const components = [{ displayName: 'Opacity', properties: [] }, { displayName: 'Motion', properties: [{ displayName: 'Position' }, scaleProp] }];
    for (const component of components) component.properties.numItems = component.properties.length;
    components.numItems = components.length;
    const clip = { name: 'Smoothy Box Highlight', end: 0, start: { ticks: String(ticks) }, components, getMGTComponent: () => ({ properties: { getParamForDisplayName: name => params[name] } }) };
    if (copies) clip.projectItem = templateItem;
    calls.lastClip = clip;
    calls.clips.push(clip);
    const target = videoTracks[trackIndex];
    if (copies && target) { target.clips[target.clips.numItems] = clip; target.clips.numItems++; }
    return clip;
  }
  const context = {
    JSON, Math, Date, Number, String, Error,
    File: class { constructor(path) { this.fsName = path; this.exists = path.endsWith('.mogrt'); } },
    app: { project: { activeSequence: seq }, enableQE() {} },
    qe: { project: { getActiveSequence: () => ({ addTracks: () => { if (addTrackWorks) videoTracks.push(track()); } }) } },
  };
  vm.createContext(context);
  vm.runInContext(host, context);
  return { context, calls, videoTracks };
}

test('host places one template clip per caption on a fresh top track', () => {
  const f = premiereFixture();
  const payload = {
    sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt',
    style: { textColor: [21, 21, 21], boxColor: [146, 243, 136], boxHeight: 120, size: 100, verticalPosition: 78 },
    captions: [{ start: 1, end: 2.5, text: 'Two words', timings: '0,0.7;0.7,1.5' }, { start: 3, end: 4, text: 'line one\nline two', timings: '0,0.25;0.25,0.5;0.5,0.75;0.75,1' }],
  };
  const result = JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload)));
  assert.equal(result.success, true, result.error);
  assert.equal(result.count, 2);
  assert.equal(result.track, 3);
  assert.equal(f.videoTracks[2].name, 'Smoothy Captions');
  assert.deepEqual(f.calls.imports.map(call => [call.seconds, call.trackIndex]), [[1, 2], [3, 2]]);
  assert.equal(f.calls.lastClip.end, 4);
  assert.deepEqual(f.calls.text['Caption Text'], ['Two words', 'line one\rline two']);
  assert.deepEqual(f.calls.text['Word Timings'], ['0,0.7;0.7,1.5', '0,0.25;0.25,0.5;0.5,0.75;0.75,1']);
  assert.deepEqual(f.calls.colors['Box Color'], [255, 146, 243, 136]);
  assert.equal(f.calls.numbers['Box Height'], 120);
});

test('host refuses a changed sequence, a missing template or a failed track add', () => {
  const base = { sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', style: {}, captions: [{ start: 0, end: 1, text: 'Hi', timings: '0,1' }] };
  let f = premiereFixture();
  assert.match(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify({ ...base, sequenceId: 'other' }))).error, /active sequence changed/);
  assert.equal(f.calls.imports.length, 0);
  assert.match(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify({ ...base, mogrtPath: '/missing.txt' }))).error, /template is missing/);
  f = premiereFixture({ addTrackWorks: false });
  assert.match(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(base))).error, /could not add an empty video track/);
  assert.equal(f.calls.imports.length, 0);
});

test('CEP bridge stages a large Unicode caption request and points at the bundled template', async () => {
  const bridgeSource = await readFile(new URL('../../smoothyapp-cep/js/bridge.js', import.meta.url), 'utf8');
  const hostContext = { JSON, Math, Date, Number, String, Error, decodeURIComponent };
  vm.createContext(hostContext);
  let received;
  hostContext.$ = { global: {}, evalFile() {
    vm.runInContext(host, hostContext);
    hostContext.smoothyImportProCaptions = value => { received = JSON.parse(value); return JSON.stringify({ success: true, count: received.captions.length }); };
  } };
  const scripts = [], replies = []; let socket;
  class CSInterface {
    getSystemPath() { return '/Library/CEP/extensions/com.smoothyedit.panel'; }
    evalScript(script, callback) { scripts.push(script); callback(String(vm.runInContext(script, hostContext))); }
  }
  class WebSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send(value) { replies.push(JSON.parse(value)); }
  }
  const context = { CSInterface, WebSocket, SystemPath: { EXTENSION: 'extension' }, window: {}, document: { getElementById: () => ({}) }, console: { log() {}, error() {} }, setInterval() {}, clearInterval() {} };
  vm.createContext(context); vm.runInContext(bridgeSource, context);
  const captions = Array.from({ length: 400 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `مرحبا world ${i} "quoted" \\ back`, timings: '0,0.5;0.5,1;1,1.5;1.5,1.5;1.5,1.5;1.5,1.5' }));
  socket.onmessage({ data: JSON.stringify({ type: 'importProCaptions', requestId: 'pro-1', sequenceId: 'seq-1', captions, style: { size: 100 } }) });
  assert.equal(received.captions.length, 400);
  assert.equal(received.captions[7].text, captions[7].text);
  assert.equal(received.mogrtPath, '/Library/CEP/extensions/com.smoothyedit.panel/mogrt/smoothy-box-highlight.mogrt');
  assert.ok(scripts.filter(script => script.includes('SMOOTHY_STAGED_PAYLOAD +=')).every(script => script.length < 8200));
  assert.ok(replies.some(reply => reply.type === 'proCaptionsImported' && reply.requestId === 'pro-1' && reply.success && reply.count === 400));
});

test('box highlight payload: template defaults, clamped box style, pop-in only after a gap', () => {
  const payload = pro.buildProCaptionPayload([
    { index: 1, startTime: 0.1, endTime: 1.36, text: 'So in this episode we' },
    { index: 2, startTime: 1.36, endTime: 2.32, text: 'are going to build' },
    { index: 3, startTime: 2.32, endTime: 4.2, text: 'a scroll position button' },
    { index: 4, startTime: 4.4, endTime: 5.7, text: "Let's get started" },
  ], { template: 'box-highlight', boxColor: '#ff5a1f', boxRadius: 999, upcomingOpacity: -5 });
  assert.equal(payload.template, 'box-highlight');
  assert.deepEqual(payload.captions.map(clip => clip.popIn), [true, false, false, true]);
  assert.deepEqual(payload.style.boxColor, [255, 90, 31]);
  assert.equal(payload.style.boxRadius, 60);
  assert.equal(payload.style.upcomingOpacity, 0);
  assert.equal(payload.style.verticalPosition, 93.1);
  assert.equal(payload.style.boxHeight, 95);
  assert.equal(payload.style.shadowOpacity, 0);
  assert.equal(pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi' }]).style.textColor.join(), '21,21,21');
  assert.deepEqual(pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi' }], { template: 'box-highlight', popIn: false }).captions[0].popIn, false);
  assert.equal(pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi' }], { template: 'nope' }).template, 'box-highlight');
});

test('host sets the box highlight parameters and pop-in per caption', () => {
  const f = premiereFixture();
  const style = pro.normalizeProCaptionStyle({ template: 'box-highlight', boxColor: '#2a62ff', shadowOpacity: 40 });
  const payload = {
    sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', template: 'box-highlight', style,
    captions: [{ start: 0, end: 1, text: 'One two', timings: '0,0.5;0.5,1', popIn: true }, { start: 1, end: 2, text: 'three four', timings: '0,0.5;0.5,1', popIn: false }],
  };
  const result = JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload)));
  assert.equal(result.success, true, result.error);
  assert.deepEqual(f.calls.colors['Box Color'], [255, 42, 98, 255]);
  assert.equal(f.calls.numbers['Upcoming Word Opacity'], 42);
  assert.equal(f.calls.numbers['Box Height'], 95);
  assert.equal(f.calls.numbers['Vertical Position'], 93.1);
  assert.equal(f.calls.numbers['Shadow Opacity'], 40);
  assert.deepEqual(f.calls.history['Pop In'], [true, false]);
});

test('CEP bridge picks the box highlight template file', async () => {
  const bridgeSource = await readFile(new URL('../../smoothyapp-cep/js/bridge.js', import.meta.url), 'utf8');
  assert.match(bridgeSource, /'box-highlight': 'smoothy-box-highlight\.mogrt'/);
});

test('bundled box highlight template exposes every parameter the host sets', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const mogrt = fileURLToPath(new URL('../../smoothyapp-cep/mogrt/smoothy-box-highlight.mogrt', import.meta.url));
  if (!existsSync(mogrt)) return t.skip('smoothy-box-highlight.mogrt not built yet (node scripts/pro-captions/build-mogrt.mjs --template box-highlight)');
  const definition = JSON.parse(execFileSync('unzip', ['-p', mogrt, 'definition.json'], { encoding: 'utf8' }));
  const names = new Map();
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.capPropUIName) names.set(node.capPropUIName, node);
    Object.values(node).forEach(visit);
  };
  visit(definition);
  for (const name of ['Caption Text', 'Word Timings', 'Text Color', 'Upcoming Word Opacity', 'Box Color', 'Box Opacity', 'Box Radius',
    'Box Padding', 'Box Height', 'Shadow Opacity', 'Caption Size', 'Vertical Position', 'Pop In']) assert.ok(names.has(name), name);
  assert.deepEqual([names.get('Box Height').capPropMin, names.get('Box Height').capPropMax], [40, 240]);
});

test('box highlight style clamps every slider to the template range', () => {
  for (const [name, [min, max]] of Object.entries({ size: [25, 300], verticalPosition: [0, 100], upcomingOpacity: [0, 100], boxRadius: [0, 60], boxPadding: [0, 80], boxHeight: [40, 240], shadowOpacity: [0, 100] })) {
    assert.equal(pro.normalizeProCaptionStyle({ [name]: -1e9 })[name], min, name);
    assert.equal(pro.normalizeProCaptionStyle({ [name]: 1e9 })[name], max, name);
  }
});

test('host scales the 4K-authored template to the sequence frame', () => {
  const payload = { sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', style: {}, captions: [{ start: 0, end: 1, text: 'Hi', timings: '0,1', popIn: true }] };
  let f = premiereFixture();
  assert.equal(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload))).success, true);
  assert.deepEqual(f.calls.history.motionScale, [50]);
  f = premiereFixture({ frame: [3840, 2160] });
  assert.equal(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload))).success, true);
  assert.equal(f.calls.history.motionScale, undefined);
  f = premiereFixture({ frame: [1280, 720] });
  JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload)));
  assert.equal(Math.round(f.calls.history.motionScale[0] * 1000) / 1000, 33.333);
});

test('host names each caption clip after its words', () => {
  const f = premiereFixture();
  const long = 'word '.repeat(40).trim();
  const payload = { sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', style: {}, captions: [
    { start: 0, end: 1, text: 'Hello there\nfriend', timings: '0,1', popIn: true },
    { start: 1, end: 2, text: long, timings: '0,1', popIn: false }] };
  assert.equal(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload))).success, true);
  assert.equal(f.calls.clips[0].name, 'Hello there friend');
  assert.equal(f.calls.clips[1].name.length, 120);
  assert.ok(f.calls.clips[1].name.endsWith('\u2026'));
});

test('host skips style values the template already holds and refreshes once per clip', () => {
  const f = premiereFixture({ templateDefaults: {
    'Text Color': [1, 21, 21, 21], 'Box Color': [1, 146, 243, 136], 'Caption Size': 100, 'Vertical Position': 93.1,
    'Upcoming Word Opacity': 42, 'Box Opacity': 100, 'Box Radius': 7, 'Box Padding': 20, 'Box Height': 95, 'Shadow Opacity': 0, 'Pop In': true } });
  const style = pro.normalizeProCaptionStyle({ template: 'box-highlight', upcomingOpacity: 60 });
  const payload = { sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', style, captions: [
    { start: 0, end: 1, text: 'One two', timings: '0,0.5;0.5,1', popIn: true },
    { start: 1, end: 2, text: 'three four', timings: '0,0.5;0.5,1', popIn: false }] };
  assert.equal(JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload))).success, true);
  const perClip = clip => f.calls.writes.filter(([index]) => index === clip).map(([, name, ui]) => `${name}:${ui}`);
  assert.deepEqual(perClip(1), ['Caption Text:false', 'Word Timings:false', 'Upcoming Word Opacity:true']);
  assert.deepEqual(perClip(2), ['Caption Text:false', 'Word Timings:false', 'Upcoming Word Opacity:false', 'Pop In:true']);
});

const copyPayload = captions => JSON.stringify({ sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-box-highlight.mogrt', style: {}, captions });

test('host imports the template once and places copies for later captions', () => {
  const f = premiereFixture({ copies: true });
  const captions = [0, 1, 2, 3].map(i => ({ start: i, end: i + 1, text: `caption ${i}`, timings: '0,1', popIn: i === 0 }));
  const result = JSON.parse(f.context.smoothyImportProCaptions(copyPayload(captions)));
  assert.equal(result.success, true, result.error);
  assert.equal(result.count, 4);
  assert.equal(result.copied, 3);
  assert.equal(f.calls.imports.length, 1);
  assert.deepEqual(f.calls.text['Caption Text'], ['caption 0', 'caption 1', 'caption 2', 'caption 3']);
  assert.deepEqual(f.calls.clips.map(clip => clip.name), ['caption 0', 'caption 1', 'caption 2', 'caption 3']);
});

test('host falls back to importing the template when a copy cannot be placed', () => {
  const f = premiereFixture({ copies: true, copyBreaksAt: 2 });
  const captions = [0, 1, 2, 3].map(i => ({ start: i, end: i + 1, text: `caption ${i}`, timings: '0,1', popIn: false }));
  const result = JSON.parse(f.context.smoothyImportProCaptions(copyPayload(captions)));
  assert.equal(result.success, true, result.error);
  assert.equal(result.count, 4);
  assert.equal(result.copied, 1);
  assert.equal(f.calls.imports.length, 3);
  assert.equal(f.calls.copies, 2);
  assert.deepEqual(f.calls.text['Caption Text'], ['caption 0', 'caption 1', 'caption 2', 'caption 3']);
});

test('host never places a copy over a caption that is out of order', () => {
  const f = premiereFixture({ copies: true });
  const captions = [{ start: 5, end: 6 }, { start: 1, end: 2 }].map((c, i) => ({ ...c, text: `caption ${i}`, timings: '0,1', popIn: false }));
  const result = JSON.parse(f.context.smoothyImportProCaptions(copyPayload(captions)));
  assert.equal(result.success, true, result.error);
  assert.equal(result.copied, 0);
  assert.equal(f.calls.imports.length, 2);
});

const fonts = await load('../src/main/captions/caption-fonts.ts');

test('every caption template has a defaults shape, a bundled template file and a bundled font', async () => {
  const { existsSync } = await import('node:fs');
  const bridgeSource = await readFile(new URL('../../smoothyapp-cep/js/bridge.js', import.meta.url), 'utf8');
  for (const id of pro.PRO_CAPTION_TEMPLATES) {
    const file = bridgeSource.match(new RegExp(`'${id}': '([^']+\\.mogrt)'`))?.[1];
    assert.ok(file, `bridge maps ${id}`);
    assert.ok(existsSync(fileURLToPath(new URL(`../../smoothyapp-cep/mogrt/${file}`, import.meta.url))), file);
    for (const font of fonts.CAPTION_TEMPLATE_FONTS[id]) {
      assert.ok(existsSync(fileURLToPath(new URL(`../../smoothyapp-cep/fonts/${font.file}`, import.meta.url))), font.file);
    }
    const payload = pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi there' }], { template: id });
    assert.equal(payload.template, id);
  }
});

test('word and outline styles default to white text without a pop-in, outline clamps its stroke', () => {
  for (const id of ['word-rise', 'word-slide', 'stroke-highlight']) {
    const payload = pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi' }, { index: 2, startTime: 3, endTime: 4, text: 'again' }], { template: id });
    assert.deepEqual(payload.style.textColor, [255, 255, 255], id);
    assert.equal(payload.style.verticalPosition, 85, id);
    assert.deepEqual(payload.captions.map(clip => clip.popIn), [false, false], id);
  }
  const outline = pro.buildProCaptionPayload([{ index: 1, startTime: 0, endTime: 1, text: 'Hi' }], { template: 'stroke-highlight', strokeWidth: 99, highlightColor: '#ffd400' });
  assert.equal(outline.style.strokeWidth, 30);
  assert.deepEqual(outline.style.highlightColor, [255, 212, 0]);
  assert.deepEqual(outline.style.strokeColor, [21, 21, 21]);
});

test('host writes the outline parameters and skips ones a template lacks', () => {
  const f = premiereFixture();
  const style = pro.normalizeProCaptionStyle({ template: 'stroke-highlight', highlightColor: '#ffd400', strokeWidth: 12 });
  const payload = { sequenceId: 'seq-1', mogrtPath: '/cep/mogrt/smoothy-outline.mogrt', template: 'stroke-highlight', style,
    captions: [{ start: 0, end: 1, text: 'One two', timings: '0,0.5;0.5,1', popIn: false }] };
  const result = JSON.parse(f.context.smoothyImportProCaptions(JSON.stringify(payload)));
  assert.equal(result.success, true, result.error);
  // The fixture template has no Highlight/Stroke parameters, so nothing is written for them and nothing breaks.
  assert.equal(f.calls.colors['Highlight Color'], undefined);
  assert.equal(f.calls.numbers['Stroke Width'], undefined);
  assert.match(host, /\["Highlight Color", "color", style\.highlightColor\]/);
  assert.match(host, /\["Stroke Width", "number", style\.strokeWidth\]/);
});

test('bundled word and outline templates expose the parameters the host sets', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const expected = {
    'smoothy-word-rise.mogrt': ['Caption Text', 'Word Timings', 'Text Color', 'Shadow Opacity', 'Caption Size', 'Vertical Position'],
    'smoothy-word-slide.mogrt': ['Caption Text', 'Word Timings', 'Text Color', 'Shadow Opacity', 'Caption Size', 'Vertical Position'],
    'smoothy-outline.mogrt': ['Caption Text', 'Word Timings', 'Text Color', 'Highlight Color', 'Stroke Color', 'Stroke Width', 'Shadow Opacity', 'Caption Size', 'Vertical Position'],
  };
  for (const [file, params] of Object.entries(expected)) {
    const mogrt = fileURLToPath(new URL(`../../smoothyapp-cep/mogrt/${file}`, import.meta.url));
    if (!existsSync(mogrt)) { t.skip(`${file} not built yet`); continue; }
    const definition = JSON.parse(execFileSync('unzip', ['-p', mogrt, 'definition.json'], { encoding: 'utf8' }));
    const names = new Set();
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      if (node.capPropUIName) names.add(node.capPropUIName);
      Object.values(node).forEach(visit);
    };
    visit(definition);
    for (const name of params) assert.ok(names.has(name), `${file}: ${name}`);
  }
});

test('caption fonts install once into the user font folder and never overwrite', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const work = mkdtempSync(path.join(os.tmpdir(), 'smoothy-fonts-'));
  const bundled = path.join(work, 'bundled'), target = path.join(work, 'Fonts');
  (await import('node:fs')).mkdirSync(bundled);
  writeFileSync(path.join(bundled, 'InterDisplay-Bold.ttf'), 'font');
  let result = fonts.ensureCaptionFonts('word-rise', bundled, { platform: 'darwin', fontFolder: target });
  assert.deepEqual(result, { installed: ['Inter Display Bold'], failed: [] });
  assert.equal(readFileSync(path.join(target, 'InterDisplay-Bold.ttf'), 'utf8'), 'font');
  writeFileSync(path.join(target, 'InterDisplay-Bold.ttf'), 'mine');
  result = fonts.ensureCaptionFonts('word-slide', bundled, { platform: 'darwin', fontFolder: target });
  assert.deepEqual(result, { installed: [], failed: [] });
  assert.equal(readFileSync(path.join(target, 'InterDisplay-Bold.ttf'), 'utf8'), 'mine');
  result = fonts.ensureCaptionFonts('stroke-highlight', bundled, { platform: 'darwin', fontFolder: target });
  assert.deepEqual(result, { installed: [], failed: ['Inter Display ExtraBold'] });
  assert.equal(existsSync(path.join(target, 'InterDisplay-ExtraBold.ttf')), false);
  assert.deepEqual(fonts.ensureCaptionFonts('word-rise', bundled, { platform: 'linux' }), { installed: [], failed: [] });
  assert.equal(fonts.userFontFolder('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a').endsWith(path.join('Microsoft', 'Windows', 'Fonts')), true);
});

test('a free send places Outline in its default look while keeping position on screen', () => {
  assert.equal(pro.FREE_PRO_CAPTION_TEMPLATE, 'stroke-highlight');
  const caption = [{ index: 1, startTime: 0, endTime: 1, text: 'Hi there' }];
  const free = pro.buildProCaptionPayload(caption, pro.freeProCaptionStyle());
  const outline = pro.buildProCaptionPayload(caption, { template: 'stroke-highlight' });
  assert.equal(free.template, 'stroke-highlight');
  assert.deepEqual(free.style, outline.style);
  assert.deepEqual(free.style.textColor, [255, 255, 255]);
  assert.deepEqual(free.style.highlightColor, [146, 243, 136]);
  assert.equal(free.style.verticalPosition, 85);
  assert.equal(free.style.size, 100);

  const moved = pro.buildProCaptionPayload(caption, pro.freeProCaptionStyle({
    template: 'stroke-highlight', verticalPosition: 50, textColor: '#ff0000', highlightColor: '#0000ff', strokeWidth: 20, shadowOpacity: 100, size: 160,
  }));
  assert.equal(moved.template, 'stroke-highlight');
  assert.equal(moved.style.verticalPosition, 50);
  assert.deepEqual(moved.style.textColor, [255, 255, 255]);
  assert.deepEqual(moved.style.highlightColor, [146, 243, 136]);
  assert.equal(moved.style.strokeWidth, 9);
  assert.equal(moved.style.shadowOpacity, 35);
  assert.equal(moved.style.size, 100);

  assert.equal(pro.freeProCaptionStyle({ verticalPosition: -50 }).verticalPosition, 0);
  assert.equal(pro.freeProCaptionStyle({ verticalPosition: 250 }).verticalPosition, 100);
});

test('main process only lets a non-Pro send through for the free style, keeping position on screen', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('import-pro-captions-to-premiere'"), main.indexOf("ipcMain.handle('unload-caption-model'"));
  assert.match(handler, /!pro && proCaptionTemplateOf\(style\) !== FREE_PRO_CAPTION_TEMPLATE/);
  assert.match(handler, /buildProCaptionPayload\(captions, pro \? style : freeProCaptionStyle\(style\)\)/);
  assert.match(handler, /if \(!pro\) trackTool\('captions_animated_free'\)/);
});

test('captions UI labels Position on screen and leaves it unlocked for the free style', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../src/renderer/pro-captions.js', import.meta.url), 'utf8');
  assert.match(html, /<div class="form-group">\s*<label id="pro-captions-position-label">Position on screen<\/label>/);
  assert.doesNotMatch(html, /Height on screen/i);
  assert.match(renderer, /key === 'position'/);
});
