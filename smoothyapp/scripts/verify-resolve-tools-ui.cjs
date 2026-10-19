// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-resolve-all-tools'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const clip = name => ({ name, path: '/fixture/media.wav', start: 0, end: 60, inPoint: 0, outPoint: 60 });
const sequence = { hasSequence: true, nle: 'resolve', id: 'fixture-resolve', nativeId:'fixture-native', timelineRevision: 'fixture-resolve', name: 'Synced interview', duration: 60, fps: 25, width: 1920, height: 1080,
  capabilities: { multicam: true, live: false },
  audioTracks: [{ index: 0, name: 'Microphone Alice', clips: [clip('Alice')] }, { index: 1, name: 'Microphone Bob', clips: [clip('Bob')] }],
  videoTracks: [{ index: 0, name: 'Camera Alice', clips: [clip('Camera Alice')] }, { index: 1, name: 'Camera Bob', clips: [clip('Camera Bob')] }] };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');const calls=[],callbacks={},replies={};let editor='resolve',loaded=false;
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async(...args)=>{calls.push({name,args});return replies[name] || {}}]));
const seq=${JSON.stringify(sequence)};
Object.assign(api,{
 getAuthState:async()=>({user:null}),getStatus:async()=>({connected:loaded,nle:editor,sequenceInfo:loaded?seq:null}),getActiveNLE:async()=>({activeNLE:editor}),setActiveNLE:async(nle)=>{editor=nle;return {success:true}},
 resolveLoadTimeline:async(...args)=>{loaded=true;calls.push({name:'resolveLoadTimeline',args});return replies.resolveLoadTimeline || {success:true,sequenceInfo:seq}},
 resolveShowResult:async()=>({success:true}),resolveCancelMulticam:async()=>{calls.push({name:'resolveCancelMulticam'});return {success:true}},
 resolveHandoffStatus:async()=>({installed:true,watching:true}),resolveInstallHandoff:async()=>({success:true,installed:true,watching:true}),resolveCopyHelperCommand:async()=>({success:true}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 __reply:(name,value)=>{replies[name]=value},__calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const failures = []; win.webContents.on('console-message', event => { if (event.level === 'error') failures.push(event.message); });
  let lastCode='';
  const js = code => {lastCode=code;return win.webContents.executeJavaScript(code);};
  try {
    await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(500);win.showInactive();
    await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    for(const id of ['photos-viewer-premiere','audio-send','audio-dock-send','stock-premiere-btn','import-captions-btn','assets-send-btn']){
      assert.match(await js(`document.getElementById('${id}').textContent`),/DaVinci Resolve/);
    }
    assert.equal(await js(`document.getElementById('captions-source-sequence').textContent`),'DaVinci Resolve Timeline');
    assert.equal(await js(`document.querySelector('[data-shorts-source=sequence]').textContent`),'DaVinci Resolve');
    assert.equal(await js(`document.getElementById('edit-in-place').closest('.form-group').classList.contains('hidden')`),true);
    assert.equal(await js(`document.getElementById('assets-duration').closest('.form-group').classList.contains('hidden')`),true);
    assert.equal(await js(`document.getElementById('autocut-btn').disabled`),false);
    await js(`document.getElementById('autocut-btn').click()`);await pause(100);
    const automatic=await js(`window.electronAPI.__calls()`);
    const read=automatic.findIndex(c=>c.name==='resolveLoadTimeline'),apply=automatic.findIndex(c=>c.name==='startAutoCut');
    assert.ok(read>=0 && apply>read,'Apply must read the current source before generating');
    assert.deepEqual(automatic[read].args,[false,true]);
    assert.equal(automatic.some(c=>c.name==='resolveSendResult'),false);
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:true,nle:'resolve',handoff:true,imported:true,stats:{shots:4},warnings:[]})`);
    assert.equal(await js(`document.getElementById('resolve-result-btn').classList.contains('hidden')`),true);
    await js(`document.querySelector('.speaker-camera[data-track-index="0"]').value='1';document.getElementById('autocut-btn').click()`);await pause(80);
    const refreshed=(await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='startAutoCut');
    assert.equal(refreshed[1].args[0].sources[0].camera,1,'Refresh must retain the microphone mapping on the same source layout');
    await js(`window.electronAPI.__emit('onAutoCutResult',{success:true,nle:'resolve',handoff:true,imported:true,stats:{shots:4},warnings:[]})`);
    await js(`window.electronAPI.__reply('resolveLoadTimeline',{canceled:true});document.getElementById('autocut-btn').click()`);await pause(50);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='startAutoCut').length,2);
    await js(`window.electronAPI.__reply('resolveLoadTimeline',null)`);
    await js(`document.getElementById('resolve-load-btn').click()`);await pause(30);
    assert.equal(await js(`document.getElementById('silence-remove-btn').disabled`),false);
    await js(`document.querySelector('[data-tab="captions"]').click()`);await pause(30);
    assert.equal(await js(`document.getElementById('generate-captions-btn').disabled`),false);
    await js(`window.electronAPI.__reply('generateCaptions',{success:true,captions:[{text:'A caption',startTime:0,endTime:1}],srt:'',transcription:{chunks:[{text:'A caption',timestamp:[0,1]}]}});window.electronAPI.__reply('importCaptionsToPremiere',{success:true,nle:'resolve'});document.getElementById('generate-captions-btn').click()`);await pause(60);
    await js(`document.getElementById('import-captions-btn').click()`);await pause(30);
    assert.equal((await js(`window.electronAPI.__calls()`)).filter(c=>c.name==='importCaptionsToPremiere').length,1);
    assert.match(await js(`document.getElementById('captions-status-text').textContent`),/Resolve.*Media Pool/);
    await js(`window.electronAPI.__emit('onResolveReceiveStatus',{active:true,phase:'waiting',file:'fixture.png'})`);
    assert.equal(await js(`document.getElementById('resolve-receive-banner').classList.contains('hidden')`),false);
    assert.equal(await js(`document.getElementById('multicam-editor').disabled`),true);
    assert.match(await js(`document.getElementById('resolve-receive-message').textContent`),/Smoothy Connector/);
    await js(`document.getElementById('resolve-receive-copy').click();document.getElementById('resolve-receive-cancel').click()`);await pause(30);
    assert.ok((await js(`window.electronAPI.__calls()`)).some(c=>c.name==='resolveReceiveCopyCommand'));
    await js(`window.electronAPI.__emit('onResolveReceiveStatus',{active:false,success:false,canceled:true,error:'Canceled'})`);
    assert.equal(await js(`document.getElementById('multicam-editor').disabled`),false);
    await js(`window.electronAPI.__emit('onResolveReceiveStatus',{active:true,phase:'started'})`);
    assert.equal(await js(`document.getElementById('resolve-receive-cancel').classList.contains('hidden')`),true);
    await js(`window.electronAPI.__emit('onResolveReceiveStatus',{active:false,success:true})`);
    for(const [width,height] of [[900,700],[600,500]]){
      win.setSize(width,height);await pause(100);assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`),false);
      fs.writeFileSync(path.join(captures,'resolve-handoff-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await js(`document.getElementById('multicam-editor').value='premiere';document.getElementById('multicam-editor').dispatchEvent(new Event('change'))`);await pause(50);
    assert.equal(await js(`document.getElementById('captions-source-sequence').textContent`),'Premiere Sequence');
    for(const id of ['photos-viewer-premiere','audio-send','audio-dock-send','stock-premiere-btn','import-captions-btn','assets-send-btn'])assert.match(await js(`document.getElementById('${id}').textContent`),/Send to Premiere/);
    assert.equal(await js(`document.getElementById('assets-duration').closest('.form-group').classList.contains('hidden')`),false);
    assert.equal(failures.length,0,failures.join('\n'));
    console.log('Automatic Apply source refresh, retained mappings, canceled-source stop and editor-aware native UI passed: six send controls, two source selectors, Resolve source captions, receive/pending/cancel/commit, Premiere restore, 900x700 and 600x500.');win.destroy();app.exit(0);
  } catch (error) { console.error(error,lastCode,failures); win.destroy(); app.exit(1); }
});
app.once('will-quit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });
