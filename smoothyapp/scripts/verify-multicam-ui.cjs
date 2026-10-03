// Native Electron renderer verification with nested timeline fixtures; no Premiere edits.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-multicam-ui-'));
app.setPath('userData', path.join(scratch, 'user-data'));
app.once('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
const clip = name => ({ name, path: '', start: 0, end: 600, inPoint: 20, outPoint: 620 });
const sequence = { hasSequence: true, id: 'nested-fixture', name: 'Nested interview', duration: 600, fps: 25, width: 1920, height: 1080,
  multicamTimelineVersion: 7, timelineRevision: 'fixture-revision',
  audioTracks: [{ index: 0, name: 'Audio 1', clips: [clip('Microphone nest 1')] }, { index: 1, name: 'Audio 2', clips: [clip('Microphone nest 2')] }],
  videoTracks: [{ index: 0, name: 'Video 1', clips: [clip('Camera nest 1')] }, { index: 1, name: 'Video 2', clips: [clip('Camera nest 2')] }] };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const { contextBridge } = require('electron');
const calls = [], callbacks = {};
const api = Object.fromEntries(${JSON.stringify(methods)}.map(name => [name, name.startsWith('on') ? fn => {(callbacks[name] ||= []).push(fn);} : async (...args) => {calls.push({name,args});return {};} ]));
Object.assign(api, {
 getAuthState:async()=>({user:null}),getStatus:async()=>({connected:true,nle:'premiere',sequenceInfo:${JSON.stringify(sequence)}}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '1.5.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value);}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const failures = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') failures.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(250);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), false);
    assert.match(await js(`document.getElementById('video-tracks-list').textContent`), /Camera nest 1/);
    assert.match(await js(`document.getElementById('multicam-update-notice').textContent`), /It should now work correctly in 1.5.1/);
    assert.match(await js(`document.getElementById('multicam-update-notice').textContent`), /supports source clips and nested sequences/);
    assert.equal(await js(`document.getElementById('multicam-update-notice').classList.contains('hidden')`), false);
    const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-1.5.1'); fs.mkdirSync(captures, { recursive: true });
    for (const windows of [false, true]) for (const [width, height] of [[900, 700], [600, 500]]) {
      await js(`window.electronAPI.__emit('onPlatformInfo',{isWindows:${windows},isMac:${!windows}})`);
      win.setSize(width, height); await pause(100);
      for (const collapsed of [false, true]) {
        await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`); await pause(250);
        const layout = await js(`(() => {const button=document.getElementById('autocut-btn').getBoundingClientRect(),note=document.getElementById('multicam-action-note').getBoundingClientRect();return {height:innerHeight,width:innerWidth,bottom:button.bottom,right:button.right,noteBottom:note.bottom,buttonTop:button.top,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.ok(layout.bottom <= layout.height + 1 && layout.right <= layout.width + 1 && layout.noteBottom <= layout.buttonTop, JSON.stringify(layout));
        assert.equal(layout.overflow, false);
        if (!windows && !collapsed) fs.writeFileSync(path.join(captures, `multicam-nests-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await js(`document.querySelector('[data-multicam-support]').click();document.getElementById('multicam-update-dismiss').click()`);
    assert.equal(await js(`document.getElementById('multicam-update-notice').classList.contains('hidden')`), true);
    assert.equal((await js(`window.electronAPI.__calls()`)).find(call => call.name === 'openExternal').args[0], 'https://discord.gg/KmJRqUZzDe');
    await js(`document.getElementById('autocut-btn').click()`); await pause(30);
    const request = (await js(`window.electronAPI.__calls()`)).find(call => call.name === 'startAutoCut').args[0];
    assert.equal(request.options.sequenceId, sequence.id); assert.equal(request.options.timelineRevision, sequence.timelineRevision);
    assert.deepEqual(request.sources.map(source => ({ index: source.index, camera: source.camera, path: source.path })), [{ index: 0, camera: 0, path: '' }, { index: 1, camera: 1, path: '' }]);
    assert.deepEqual(request.options.videoTracks.map(track => track.index), [0, 1]);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:true,sequenceName:'Nested interview - Auto-Switch',stats:{shots:12},warnings:['No speech detected on A2. Check <camera> & mapping.']})`); await pause(30);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), false);
    assert.equal(await js(`document.getElementById('multicam-review-warnings').textContent`), 'No speech detected on A2. Check <camera> & mapping.');
    assert.equal(await js(`document.getElementById('multicam-review-warnings').querySelector('camera')`), null);
    assert.match(await js(`document.getElementById('footer-status').textContent`), /Review the warnings/);
    assert.equal(await js(`document.getElementById('multicam-result-notice').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('multicam-update-notice').classList.contains('hidden')`), true);
    await js(`document.querySelector('.speaker-camera[data-track-index="0"]').value='1';document.querySelector('.speaker-camera[data-track-index="1"]').value='0';document.getElementById('autocut-btn').click()`); await pause(30);
    const reversed = (await js(`window.electronAPI.__calls()`)).filter(call => call.name === 'startAutoCut').at(-1).args[0];
    assert.deepEqual(reversed.sources.map(source => source.camera), [1, 0]);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:true,stats:{shots:8},warnings:[]})`); await pause(30);
    assert.equal(await js(`document.getElementById('multicam-result-notice').classList.contains('hidden')`), true);
    const button = await js(`(() => {const b=document.getElementById('autocut-btn').getBoundingClientRect();return {bottom:b.bottom,height:innerHeight};})()`);
    assert.ok(button.bottom <= button.height + 1);
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await loaded; await pause(250);
    assert.equal(await js(`document.getElementById('multicam-update-notice').classList.contains('hidden')`), true);
    if (process.env.SMOOTHY_TEST_RENDERER) {
      await win.loadFile(process.env.SMOOTHY_TEST_RENDERER); await pause(250);
      assert.equal(await js(`document.getElementById('multicam-update-notice').classList.contains('hidden')`), true);
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('Multicam update notice, external support links, dismissal/reload persistence, independent job warnings, nested/reversed mapping and Mac/Windows layouts passed at 900×700 / 600×500 with both sidebar states.');
    win.destroy(); app.quit();
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
