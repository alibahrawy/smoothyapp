// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-2.1-resolve'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const clip = name => ({ name, path: '/fixture/media.wav', start: 0, end: 60, inPoint: 0, outPoint: 60 });
const sequence = { hasSequence: true, nle: 'resolve', id: 'fixture-resolve', timelineRevision: 'fixture-resolve', name: 'Synced interview', duration: 60, fps: 25, width: 1920, height: 1080,
  capabilities: { multicam: true, live: false },
  audioTracks: [{ index: 0, name: 'Microphone Alice', clips: [clip('Alice')] }, { index: 1, name: 'Microphone Bob', clips: [clip('Bob')] }],
  videoTracks: [{ index: 0, name: 'Camera Alice', clips: [clip('Camera Alice')] }, { index: 1, name: 'Camera Bob', clips: [clip('Camera Bob')] }] };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');const calls=[],callbacks={};let editor='resolve',loaded=false;
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async(...args)=>{calls.push({name,args});return {}}]));
const seq=${JSON.stringify(sequence)};
Object.assign(api,{
 getAuthState:async()=>({user:null}),getStatus:async()=>({connected:loaded,nle:editor,sequenceInfo:loaded?seq:null}),getActiveNLE:async()=>({activeNLE:editor}),setActiveNLE:async(nle)=>{editor=nle;return {success:true}},
 resolveLoadTimeline:async()=>{loaded=true;calls.push({name:'resolveLoadTimeline'});return {success:true,sequenceInfo:seq}},
 resolveShowResult:async()=>({success:true}),resolveCancelMulticam:async()=>{calls.push({name:'resolveCancelMulticam'});return {success:true}},
 resolveHandoffStatus:async()=>({installed:true,watching:true}),resolveInstallHandoff:async()=>({success:true,installed:true,watching:true}),resolveCopyHelperCommand:async()=>({success:true}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const failures = []; win.webContents.on('console-message', event => { if (event.level === 'error') failures.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(700);
    await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    win.showInactive();
    await pause(200);
    assert.equal(await js(`document.getElementById('multicam-editor').value`), 'resolve');
    assert.equal(await js(`document.getElementById('multicam-editor').closest('#connection-status') !== null`), true);
    assert.equal(await js(`Promise.all([...document.querySelectorAll('.editor-logo img, .nle-icon img')].map(img => img.decode().then(() => img.naturalWidth > 0))).then(results => results.length === 4 && results.every(Boolean))`), true);
    await js(`document.getElementById('sidebar-toggle-btn').click()`); await pause(100);
    assert.equal(await js(`(()=>{const logo=document.querySelector('.editor-logo-resolve');const select=document.getElementById('multicam-editor');const r=select.getBoundingClientRect();return logo.getClientRects().length>0 && r.width>20 && r.height>20})()`), true);
    await js(`document.getElementById('sidebar-toggle-btn').click()`);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), true);
    assert.match(await js(`document.getElementById('connection-state-label').textContent`), /Load XML/);
    assert.equal(await js(`document.querySelector('[data-premiere-guide]').classList.contains('hidden')`), true);
    assert.match(await js(`document.getElementById('resolve-helper-status').textContent`), /Workspace → Scripts → Send to Smoothy/);
    assert.equal(await js(`document.getElementById('resolve-copy-helper-command').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('resolve-check-helper').classList.contains('hidden')`), false);
    await js(`window.electronAPI.__emit('onResolveHandoffStatus',{installed:true,phase:'waiting'})`);
    assert.match(await js(`document.getElementById('resolve-helper-status').textContent`), /Waiting for Resolve/);
    await js(`window.electronAPI.__emit('onResolveHandoffStatus',{installed:true,phase:'failed',error:'The script ran, but no timeline is open in Resolve.'})`);
    assert.match(await js(`document.getElementById('resolve-helper-status').textContent`), /no timeline is open/);
    await js(`window.electronAPI.__emit('onResolveHandoffStatus',{installed:true,phase:'exporting'})`);
    assert.match(await js(`document.getElementById('resolve-helper-status').textContent`), /exporting its XML/);
    await js(`window.electronAPI.__emit('onResolveHandoffStatus',{installed:true,phase:'reading'})`);
    assert.match(await js(`document.getElementById('resolve-helper-status').textContent`), /Reading source clips directly/);
    await js(`window.electronAPI.__emit('onResolveHandoffStatus',{installed:true,watching:true})`);
    fs.writeFileSync(path.join(captures, 'resolve-free-empty.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('resolve-load-btn').click()`); await pause(50);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), false);
    assert.equal(await js(`document.getElementById('silence-remove-btn').disabled`), false);
    assert.equal(await js(`document.getElementById('connection-state-label').textContent`), 'XML loaded');
    assert.match(await js(`document.getElementById('audio-tracks-list').textContent`), /Microphone Alice/);
    await js(`window.electronAPI.__emit('onSequenceInfo',${JSON.stringify({ ...sequence, handoffSource: 'script' })})`);
    assert.match(await js(`document.getElementById('resolve-workflow-status').textContent`), /Received Synced interview from Resolve/);
    assert.equal(await js(`document.getElementById('resolve-handoff-instructions').open`), false);
    await js(`window.electronAPI.__emit('onSequenceInfo',${JSON.stringify({ ...sequence, handoffSource: 'snapshot' })})`);
    assert.match(await js(`document.getElementById('resolve-workflow-status').textContent`), /Source-only: grades, transforms, effects/);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), false);
    for (const [width, height] of [[900, 700], [600, 500]]) {
      win.setSize(width, height); await pause(500);
      const bounds = await js(`(()=>{const b=document.getElementById('autocut-btn').getBoundingClientRect();return {bottom:b.bottom,right:b.right,height:innerHeight,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.equal(bounds.overflow, false); assert.ok(bounds.bottom <= bounds.height + 1 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
      fs.writeFileSync(path.join(captures, 'resolve-free-loaded-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('.speaker-camera[data-track-index="0"]').value='1';document.querySelector('.speaker-camera[data-track-index="1"]').value='0';document.getElementById('autocut-btn').click()`); await pause(40);
    const config = (await js(`window.electronAPI.__calls()`)).find(c => c.name === 'startAutoCut').args[0];
    assert.equal(config.options.sequenceId, sequence.id); assert.deepEqual(config.sources.map(s => s.camera), [1, 0]);
    assert.equal(await js(`document.getElementById('resolve-cancel-btn').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('multicam-editor').disabled`), true);
    await js(`document.getElementById('resolve-cancel-btn').click()`); await pause(20);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c => c.name === 'resolveCancelMulticam').length, 1);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:false,error:'Multicam canceled. No result was exported.'})`); await pause(20);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`), false);
    await js(`document.getElementById('error-ok-btn')?.click();window.electronAPI.__emit('onAutoCutResult',{success:true,handoff:true,nle:'resolve',stats:{shots:12},warnings:['Review <camera> & audio']})`); await pause(30);
    assert.equal(await js(`document.getElementById('resolve-result-btn').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('multicam-review-warnings').querySelector('camera')`), null);
    assert.match(await js(`document.getElementById('status-text').textContent`), /import the XML in Resolve/);
    assert.match(await js(`document.getElementById('resolve-workflow-status').textContent`), /File → Import → Timeline/);
    await js(`document.getElementById('multicam-editor').value='premiere';document.getElementById('multicam-editor').dispatchEvent(new Event('change'))`); await pause(50);
    assert.equal(await js(`document.getElementById('resolve-workflow').classList.contains('hidden')`), true);
    assert.match(await js(`document.getElementById('multicam-action-note').textContent`), /duplicate/);
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('Resolve Free UI passed: honest XML status, mapping/reversal, export guidance, cancel, editor isolation, 900×700 and 600×500 layouts.');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
app.once('will-quit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });
