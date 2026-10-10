import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const output = await build({ entryPoints: [new URL('../src/renderer/audio-player.js', import.meta.url).pathname], bundle: true, format: 'cjs', write: false });
function fixture() {
  const nodes = new Map(), reports = [], handlers = new Map(), documentEvents = new Map();
  const mediaSession = { metadata: null, playbackState: 'none', setActionHandler: (name, fn) => handlers.set(name, fn), setPositionState(state) { this.position = state; } };
  const get = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      nodes.set(id, { dataset: {}, paused: true, currentTime: 0, duration: 100, error: null,
        classList: { toggle() {} }, setAttribute() {},
        addEventListener(event, callback) { const list = listeners.get(event) || []; list.push(callback); listeners.set(event, list); },
        emit(event) { for (const callback of listeners.get(event) || []) callback(); },
        pause() { this.paused = true; this.emit('pause'); }, load() { this.ended = false; }, play() { this.paused = false; this.ended = false; return Promise.resolve(); },
      });
    }
    return nodes.get(id);
  };
  const module = { exports: {} };
  const nav = get('nav'); nav.dataset.tab = 'audio';
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, URL,
    navigator: { mediaSession }, MediaMetadata: class { constructor(data) { Object.assign(this, data); } },
    document: { getElementById: get, querySelectorAll: selector => selector === '.nav-item' ? [nav] : [], addEventListener: (name, fn) => documentEvents.set(name, fn) },
    window: { electronAPI: { onConnectionChange() {}, trackMediaPreview: kind => { reports.push(kind); return Promise.resolve(); } } },
  });
  const player = module.exports.initAudioPlayer({ isConnected: () => false, onFavorite() {} });
  return { player, audio: get('audio-dock-player'), reports, handlers, mediaSession, nav, key(key, repeat = false) { let prevented = false; documentEvents.get('keydown')({ key, repeat, preventDefault: () => prevented = true }); return prevented; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const song = id => ({ id, title: id, artist: 'Fixture Artist', previewUrl: 'smoothy-audio://archive/' + id });
test('OS media actions and keyboard buttons share the queue and play/pause stay idempotent', async () => {
  const f = fixture(); let next = 0, previous = 0;
  f.player.show(song('first'), { next: () => { next++; f.player.show(song('second'), {}); }, previous: () => previous++ }, false);
  assert.equal(f.mediaSession.metadata.title, 'first'); assert.equal(f.mediaSession.metadata.artist, 'Fixture Artist');
  f.handlers.get('play')(); f.handlers.get('play')(); assert.equal(f.audio.paused, false);
  f.handlers.get('pause')(); f.handlers.get('pause')(); assert.equal(f.audio.paused, true);
  f.key('MediaPlayPause'); assert.equal(f.audio.paused, false); f.key('MediaPlayPause'); assert.equal(f.audio.paused, true);
  assert.equal(f.key('MediaTrackPrevious'), true); await tick(); assert.equal(previous, 1);
  f.handlers.get('nexttrack')(); await tick(); assert.equal(next, 1); assert.equal(f.player.current().id, 'second');
  assert.equal(f.handlers.get('nexttrack'), null); assert.deepEqual(f.reports, []);
  f.audio.emit('playing'); f.handlers.get('stop')(); assert.equal(f.audio.currentTime, 0); assert.equal(f.audio.paused, true);
  assert.deepEqual(f.reports, ['audio']);
});
test('a natural track end advances once, and stops at the end of the queue', async () => {
  const f = fixture(); let calls = 0;
  f.player.show(song('first'), { next: () => { calls++; f.player.show(song('second'), {}); } });
  f.audio.emit('playing'); f.audio.ended = true; f.audio.emit('ended'); await tick();
  assert.equal(calls, 1); assert.equal(f.player.current().id, 'second'); f.audio.emit('playing');
  f.audio.ended = true; f.audio.emit('ended'); await tick(); assert.equal(calls, 1);
  assert.deepEqual(f.reports, ['audio', 'audio']);
});
test('busy downloads defer automatic next, while explicit pause or leaving the library cancels it', async () => {
  for (const cancel of [false, 'pause', 'leave']) {
    const f = fixture(); let calls = 0;
    f.player.show(song('first'), { next: () => calls++ }); f.player.busy(true);
    assert.equal(f.handlers.get('nexttrack'), null); f.audio.ended = true; f.audio.emit('ended'); await tick(); assert.equal(calls, 0);
    if (cancel === 'pause') f.player.pause();
    if (cancel === 'leave') { f.nav.dataset.tab = 'stock'; f.nav.emit('click'); assert.equal(f.mediaSession.playbackState, 'none'); assert.equal(f.mediaSession.metadata, null); assert.equal(f.key('MediaTrackNext'), false); }
    f.player.busy(false); await tick(); assert.equal(calls, cancel ? 0 : 1);
  }
});
test('failed playback does not advance or count a preview and repeated next waits for its pending page', async () => {
  const f = fixture(); let calls = 0, release;
  f.player.show(song('first'), { next: () => { calls++; return new Promise(resolve => release = resolve); } }, false);
  f.audio.emit('error'); f.audio.emit('ended'); await tick(); assert.equal(calls, 0); assert.deepEqual(f.reports, []);
  f.key('MediaTrackNext'); f.key('MediaTrackNext'); await tick(); assert.equal(calls, 1);
  release(); await tick(); f.key('MediaTrackNext', true); assert.equal(calls, 1);
});
test('a preview counts only after actual playback, once per selected track across buffering/resumes', () => {
  const f = fixture(); const track = { id: 'first', title: 'First', previewUrl: 'smoothy-audio://archive/first' };
  f.player.show(track, {}, false);
  f.audio.emit('loadedmetadata'); f.audio.emit('waiting'); f.audio.emit('error');
  assert.deepEqual(f.reports, []);
  f.audio.emit('playing'); f.audio.emit('waiting'); f.audio.emit('playing'); f.audio.emit('pause'); f.audio.emit('playing'); f.audio.emit('timeupdate');
  f.player.show(track, {}, false); f.audio.emit('playing');
  assert.deepEqual(f.reports, ['audio']);
  f.player.show({ id: 'second', title: 'Second', previewUrl: 'smoothy-audio://archive/second' }, {}, false);
  f.audio.emit('playing'); assert.deepEqual(f.reports, ['audio', 'audio']);
});
test('the preview IPC rejects arbitrary feature names and accepts audio/stock/assets signals', async () => {
  const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('track-media-preview'");
  const end = main.indexOf('\n});', start) + 4;
  const code = (await transform(main.slice(start, end), { loader: 'ts' })).code;
  const reports = []; let handler;
  vm.runInNewContext(code, { ipcMain: { handle: (_name, callback) => handler = callback }, trackTool: id => reports.push(id) });
  for (const value of ['multicam', 'private-file-path', null, {}, 42]) assert.equal(handler(null, value).success, false);
  assert.equal(handler(null, 'audio').success, true); assert.equal(handler(null, 'stock').success, true);
  assert.equal(handler(null, 'assets').success, true);
  assert.deepEqual(reports, ['audio_preview', 'stock_preview', 'assets_preview']);
});
