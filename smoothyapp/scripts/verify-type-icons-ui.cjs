// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-desktop-type-icons'); fs.mkdirSync(captures, { recursive: true });
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
    await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(500);
    win.showInactive();
    await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    await pause(150);
    await js(`document.body.classList.add('platform-windows')`);
    await js(`Promise.all([400,500,600,700].map(weight=>document.fonts.load(weight+' 14px Bunch')))`);
    await js(`document.fonts.ready`);
    assert.equal(await js(`document.querySelectorAll('.sidebar-nav .nav-icon svg[data-icon]').length`),12);
    const families=await js(`['body','.nav-label','#autocut-btn','select','input'].map(selector=>({selector,family:getComputedStyle(document.querySelector(selector)).fontFamily}))`);
    for(const item of families) assert.match(item.family,/^Bunch|^"Bunch"/);
    const client=win.webContents.debugger;client.attach('1.3');await client.sendCommand('DOM.enable');await client.sendCommand('CSS.enable');
    const {root:dom}=await client.sendCommand('DOM.getDocument');
    for(const selector of ['.nav-label','#autocut-btn']){
      const {nodeId}=await client.sendCommand('DOM.querySelector',{nodeId:dom.nodeId,selector});
      const {fonts}=await client.sendCommand('CSS.getPlatformFontsForNode',{nodeId});
      assert.ok(fonts.some(font=>font.isCustomFont && /Bunch/i.test(font.familyName)),JSON.stringify(fonts));
      console.log(selector,JSON.stringify(fonts));
    }
    client.detach();
    for(const [width,height] of [[900,700],[600,500]]){
      win.setSize(width,height);await pause(120);
      assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`),false);
      fs.writeFileSync(path.join(captures,'windows-bunch-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('sidebar-toggle-btn').click()`);await pause(50);
      fs.writeFileSync(path.join(captures,'windows-bunch-collapsed-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('sidebar-toggle-btn').click()`);
    }
    assert.equal(failures.length,0,failures.join('\n'));
    console.log('Windows typography and sidebar layouts passed; Chromium confirms bundled Bunch renders text.');win.destroy();app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
app.once('will-quit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} });
