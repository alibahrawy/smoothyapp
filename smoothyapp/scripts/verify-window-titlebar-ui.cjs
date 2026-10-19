// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-windows-titlebar'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const clip = name => ({ name, path: '/fixture/media.wav', start: 0, end: 60, inPoint: 0, outPoint: 60 });
const sequence = { hasSequence: true, nle: 'resolve', id: 'fixture-resolve', timelineRevision: 'fixture-resolve', name: 'Synced interview', duration: 60, fps: 25, width: 1920, height: 1080,
  capabilities: { multicam: true, live: false },
  audioTracks: [{ index: 0, name: 'Microphone Alice', clips: [clip('Alice')] }, { index: 1, name: 'Microphone Bob', clips: [clip('Bob')] }],
  videoTracks: [{ index: 0, name: 'Camera Alice', clips: [clip('Camera Alice')] }, { index: 1, name: 'Camera Bob', clips: [clip('Camera Bob')] }] };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');const calls=[],callbacks={};let editor='resolve',loaded=false;
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async(...args)=>{calls.push({name,args});return {}}]));
const seq=${JSON.stringify(sequence)};
Object.assign(api,{
 getAuthState:async()=>({user:null}),getStatus:async()=>({connected:loaded,nle:editor,sequenceInfo:loaded?seq:null}),getActiveNLE:async()=>({activeNLE:editor}),setActiveNLE:async(nle)=>{editor=nle;return {success:true}},
 resolveLoadTimeline:async()=>{loaded=true;calls.push({name:'resolveLoadTimeline'});return {success:true,sequenceInfo:seq}},
 resolveShowResult:async()=>({success:true}),resolveCancelMulticam:async()=>{calls.push({name:'resolveCancelMulticam'});return {success:true}},
 resolveHandoffStatus:async()=>({installed:true,watching:true}),resolveInstallHandoff:async()=>({success:true,installed:true,watching:true}),resolveCopyHelperCommand:async()=>({success:true}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 setWindowTitlebarColor:color=>ipcRenderer.invoke('fixture-titlebar-color',color),
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chromeBundle=path.join(scratch,'window-chrome.cjs');require('esbuild').buildSync({entryPoints:[path.join(root,'src/main/window-chrome.ts')],bundle:true,platform:'node',format:'cjs',outfile:chromeBundle});
const chrome=require(chromeBundle);let nativeWindow;const colors=[];
// Keep the test alive until the asynchronous native close receipt is checked.
app.on('window-all-closed',()=>{});
ipcMain.handle('fixture-titlebar-color',(event,color)=>{if(event.sender!==nativeWindow?.webContents)return false;const result=chrome.setWindowTitlebarColor(nativeWindow,color);if(result)colors.push(color);return result;});
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const options=chrome.windowChromeOptions(process.platform);
 assert.equal(options.titleBarStyle,'hidden');assert.equal(options.frame,true);assert.equal(options.titleBarOverlay.height,38);
 assert.deepEqual(chrome.windowChromeOptions('darwin'),{titleBarStyle:'hidden',trafficLightPosition:{x:16,y:12}});assert.deepEqual(chrome.windowChromeOptions('linux'),{});
 const win=nativeWindow=new BrowserWindow({width:900,height:700,show:false,...options,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const js=code=>win.webContents.executeJavaScript(code);
 const until=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await pause(30);}throw Error('Native window state did not settle');};
 const metrics=()=>js(`(()=>{const r=navigator.windowControlsOverlay.getTitlebarAreaRect(),bar=document.querySelector('.window-titlebar').getBoundingClientRect(),active=document.querySelector('.window-titlebar [data-window-active="true"]'),style=getComputedStyle(active);return{visible:navigator.windowControlsOverlay.visible,available:{x:r.x,y:r.y,width:r.width,height:r.height},bar:{x:bar.x,y:bar.y,width:bar.width,height:bar.height},padding:parseFloat(style.paddingRight),color:getComputedStyle(document.querySelector('.window-titlebar')).backgroundColor,drag:getComputedStyle(document.querySelector('.window-titlebar')).getPropertyValue('-webkit-app-region'),width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 try{
  await win.loadFile(path.join(root,'out/renderer/index.html'));win.showInactive();await pause(500);await js(`document.body.classList.add('platform-windows')`);await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
  const proof=[];
  for(const [width,height] of [[900,700],[600,500]]){
   win.setSize(width,height);await pause(200);
   for(const tab of ['multicam','photos','chat','local-audio']){
    await js(`document.querySelector('[data-tab="${tab}"]').click()`);await pause(50);const data=await metrics();
    assert.equal(data.visible,true);assert.equal(data.bar.y,0);assert.equal(data.bar.height,38);assert.equal(data.overflow,false);assert.equal(data.drag,'drag');
    assert.ok(data.available.width<data.width-100);assert.ok(data.available.height>=36&&data.available.height<=40);assert.ok(data.padding>=data.width-data.available.width);
    const outer=win.getBounds(),content=win.getContentBounds();assert.ok(content.y-outer.y<12,`Unexpected separate native title bar: ${content.y-outer.y}`);
    proof.push({width,height,tab,...data,topInset:content.y-outer.y});
   }
   fs.writeFileSync(path.join(captures,`titlebar-${width}.png`),(await win.webContents.capturePage()).toPNG());
  }
  assert.ok(colors.length>=8);assert.ok(new Set(colors).size>=3);
  assert.equal(chrome.setWindowTitlebarColor(win,'transparent'),false);assert.equal(chrome.setWindowTitlebarColor(win,'#FFFFFF', 'darwin'),false);
  win.maximize();await until(()=>win.isMaximized());assert.equal((await metrics()).visible,true);proof.push({state:'maximized',...(await metrics())});
  win.unmaximize();await until(()=>!win.isMaximized());
  win.minimize();await until(()=>win.isMinimized());win.restore();await until(()=>!win.isMinimized());
  fs.writeFileSync(path.join(captures,'native-metrics.json'),JSON.stringify({proof,colors},null,2));
  let closed=false;win.once('closed',()=>closed=true);win.close();await until(()=>closed);
  fs.writeFileSync(path.join(captures,'native-result.json'),JSON.stringify({passed:true,checks:['native-overlay','38px-shared-bar','no-extra-titlebar','tool-accents','900px-layout','600px-layout','maximize','restore','minimize','close','Mac/Linux-options']},null,2));
  console.log('PASS: native Windows overlay shares the 38px app bar; no extra caption row; colors follow tools; reserved native control area at 900/600px; maximize/restore/minimize/close and unchanged Mac/Linux options.');app.exit(0);
 }catch(error){console.error(error);if(!win.isDestroyed())win.destroy();app.exit(1);}
});
app.once('will-quit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});
