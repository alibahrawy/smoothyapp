// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-tool-cancellation'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const clip = name => ({ name, path: '/fixture/media.wav', start: 0, end: 60, inPoint: 0, outPoint: 60 });
const sequence = { hasSequence: true, nle: 'premiere', multicamTimelineVersion: 7, id: 'fixture-resolve', timelineRevision: 'fixture-resolve', name: 'Synced interview', duration: 60, fps: 25, width: 1920, height: 1080,
  capabilities: { multicam: true, live: false },
  audioTracks: [{ index: 0, name: 'Microphone Alice', clips: [clip('Alice')] }, { index: 1, name: 'Microphone Bob', clips: [clip('Bob')] }],
  videoTracks: [{ index: 0, name: 'Camera Alice', clips: [clip('Camera Alice')] }, { index: 1, name: 'Camera Bob', clips: [clip('Camera Bob')] }] };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');const calls=[],callbacks={};let editor='premiere',loaded=true;
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
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(600);
    await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    win.showInactive();
    await js(`document.querySelector('[data-tab="silence"]').click();document.getElementById('edit-in-place').checked=false;document.getElementById('silence-remove-btn').click()`); await pause(50);
    assert.equal(await js(`document.getElementById('progress-cancel-btn').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('multicam-editor').disabled`), true);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='startSilenceRemoval').length,1);
    for(const [width,height] of [[900,700],[600,500]]) {
      win.setSize(width,height);await pause(100);
      assert.equal(await js(`(()=>{const r=document.getElementById('progress-cancel-btn').getBoundingClientRect();return r.height>0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`),true);
      fs.writeFileSync(path.join(captures, 'silence-cancel-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
    }
    await js(`document.getElementById('progress-cancel-btn').click()`);await pause(30);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='cancelTimelineJob').length,1);
    assert.equal(await js(`document.getElementById('progress-overlay').classList.contains('hidden')`),false);
    assert.equal(await js(`document.getElementById('progress-cancel-btn').disabled`),true);
    // Results stay attached to their originating tool, even if visible tabs change.
    await js(`document.querySelector('[data-tab="multicam"]').click();window.electronAPI.__emit('onAutoCutResult',{success:false,canceled:true,operation:'silence',error:'Canceled. No timeline edit was submitted.'})`);await pause(30);
    assert.equal(await js(`document.getElementById('progress-overlay').classList.contains('hidden')`),true);
    assert.equal(await js(`document.getElementById('error-modal').classList.contains('hidden')`),true);
    assert.equal(await js(`document.getElementById('silence-status-text').textContent`),'Canceled');
    assert.equal(await js(`document.getElementById('multicam-editor').disabled`),false);
    await js(`document.querySelector('[data-tab="silence"]').click();document.getElementById('silence-remove-btn').click()`);await pause(30);
    await js(`window.electronAPI.__emit('onProgress',{progress:90,message:'Premiere is applying cuts. Finishing safely...',cancelable:false})`);
    assert.equal(await js(`document.getElementById('progress-cancel-btn').disabled`),true);
    assert.match(await js(`document.getElementById('progress-cancel-btn').textContent`),/Finishing/);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:true,operation:'silence',stats:{originalDuration:60,newDuration:45,silenceRemoved:15,cuts:4}})`);await pause(30);
    assert.match(await js(`document.getElementById('silence-status-text').textContent`),/Done/);
    await js(`document.querySelector('[data-tab="multicam"]').click();document.getElementById('autocut-btn').click()`);await pause(30);
    assert.equal(await js(`document.getElementById('progress-cancel-btn').classList.contains('hidden')`),false);
    await js(`document.getElementById('progress-cancel-btn').click()`);await pause(30);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='cancelTimelineJob').length,2);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:false,canceled:true,error:'Canceled.'})`);
    assert.equal(await js(`document.getElementById('progress-overlay').classList.contains('hidden')`),true);
    assert.equal(failures.length,0,failures.join('\n'));
    console.log('Cancellation UI passed: Silence Removal, Premiere Multicam, source-tool result ownership, pending state, safe commit boundary, retry, 900x700 / 600x500.');
    win.destroy();app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
app.once('will-quit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });
