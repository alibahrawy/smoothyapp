// Live public catalog/MP3 + native FFmpeg and Electron preview. No user library changes.
const { app, BrowserWindow, ipcMain } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-archive-live-'));
for (const name of ['music', 'userData', 'temp']) { const dir = path.join(scratch, name); fs.mkdirSync(dir); app.setPath(name, dir); }
buildSync({ entryPoints: [path.join(root, 'src/main/audio-library-ipc.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(scratch, 'audio.cjs') });
const { registerAudioLibrary } = require(path.join(scratch, 'audio.cjs'));
const handlers = new Map(); const original = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, handler) => { handlers.set(name, handler); original(name, handler); };
const invoke = (name, input) => handlers.get(name)(null, input);
let win;
app.once('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const values = new Map(); let imported;
  await registerAudioLibrary({ store: { get: key => values.get(key), set: (key, value) => values.set(key, value) }, window: () => win,
   connected: () => true, importToPremiere: async file => { imported = file; return { success: true }; } });
  const all = await invoke('audio-archive-search', {}); assert.equal(all.success, true, all.error); assert.ok(all.total >= 5000);
  const result = await invoke('audio-archive-search', { query: 'Sky Skating' }); assert.equal(result.success, true, result.error);
  const track = result.tracks.find(track => track.id === '1KAk_m-PLFD8oT5EJ2JDBqx_Q0TqCeSEx'); assert.ok(track);
  const html = path.join(scratch, 'preview.html'); fs.writeFileSync(html, '<!doctype html><audio id="player" controls></audio>'); await win.loadFile(html);
  const preview = async url => win.webContents.executeJavaScript(`new Promise(resolve => {
   const a = document.getElementById('player'); a.pause(); let timer = setTimeout(() => resolve({error:'timeout'}), 45000);
   a.addEventListener('loadedmetadata', () => {clearTimeout(timer);resolve({duration:a.duration});}, {once:true});
   a.addEventListener('error', () => {clearTimeout(timer);resolve({error:a.error.message});}, {once:true});a.src=${JSON.stringify(url)};
  })`);
  const remote = await preview(track.previewUrl); assert.ok(remote.duration > 30, JSON.stringify(remote));
  const seek = await win.webContents.executeJavaScript(`new Promise(resolve => {const a = document.getElementById('player');let timer=setTimeout(()=>resolve(false),45000);a.addEventListener('seeked',()=>{clearTimeout(timer);resolve(a.currentTime>9);},{once:true});a.currentTime=10;})`); assert.equal(seek, true);
  console.log('Live archive preview + seek:', track.title, remote.duration, 'seconds; catalog:', all.total, 'tracks');
  const saved = await invoke('audio-archive-download', { id: track.id, premiere: true }); assert.equal(saved.success, true, saved.error);
  assert.equal(saved.tracks[0].license, 'unverified'); assert.equal(saved.tracks[0].archiveId, track.id); assert.equal(saved.candidates.length, 0);
  const bytes = fs.statSync(imported).size; assert.ok(bytes > 100000); assert.equal(fs.readdirSync(app.getPath('temp')).length, 0);
  const local = await preview(saved.tracks[0].previewUrl); assert.ok(Math.abs(local.duration - remote.duration) < 1, JSON.stringify(local));
  console.log('PASS: live no-key archive search, remote audio metadata + seeking, complete MP3 download (' + bytes + ' bytes), native FFmpeg validation, permanent library/source notes and local preview. Premiere import mocked.');
 } catch (error) { console.error(error); process.exitCode = 1; }
 finally { win?.destroy(); app.quit(); }
});
