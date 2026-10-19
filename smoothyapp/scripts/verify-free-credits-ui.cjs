// Native Electron UI fixtures: no Resolve project or external service is touched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-resolve-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-free-credits'); fs.mkdirSync(captures, { recursive: true });
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
 getAuthState:async()=>({user:{id:'fixture-free',email:'fixture@example.test',tier:'free'}}),getStatus:async()=>({connected:loaded,nle:editor,sequenceInfo:loaded?seq:null}),getActiveNLE:async()=>({activeNLE:editor}),setActiveNLE:async(nle)=>{editor=nle;return {success:true}},
 resolveLoadTimeline:async()=>{loaded=true;calls.push({name:'resolveLoadTimeline'});return {success:true,sequenceInfo:seq}},
 resolveShowResult:async()=>({success:true}),resolveCancelMulticam:async()=>{calls.push({name:'resolveCancelMulticam'});return {success:true}},
 resolveHandoffStatus:async()=>({installed:true,watching:true}),resolveInstallHandoff:async()=>({success:true,installed:true,watching:true}),resolveCopyHelperCommand:async()=>({success:true}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 getStudioCredits:async()=>({success:true,credits:{tier:'free',credits:100,totalCredits:100,creditsUsed:0,percentage:100,daysRemaining:30}}),
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const win=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 const js=code=>win.webContents.executeJavaScript(code);
 const calls=async()=> (await js(`window.electronAPI.__calls()`)).filter(c=>['photosRun','chatRun','studioToolsRun','analyzeShorts'].includes(c.name));
 try{
  await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(500);win.showInactive();await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');await pause(100);
  await js(`window.electronAPI.__emit('onAuthStateChange',{user:null})`);await pause(80);
  for(const tab of ['photos','chat','studio-text']){
   await js(`document.querySelector('[data-tab="${tab}"]').click()`);await pause(40);
   const prompt=tab==='photos'?'photos-prompt':tab==='chat'?'chat-prompt':'studio-text-input';const button=tab==='photos'?'photos-generate':tab==='chat'?'chat-send':'studio-text-run';
   await js(`document.getElementById('${prompt}').value='A sample prompt';document.getElementById('${prompt}').dispatchEvent(new Event('input',{bubbles:true}))`);
   assert.equal(await js(`document.getElementById('${button}').disabled`),true);
   const notice=tab==='photos'?'#photos-composer-dock':tab==='chat'?'#chat-composer-dock':'#studio-text-composer';
   assert.match(await js(`document.querySelector('${notice} .studio-access-notice').textContent`),/100 AI credits every month/);
   await js(`document.getElementById('${button}').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('${prompt}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`);await pause(20);assert.equal((await calls()).length,0);
   await js(`document.querySelector('${notice} .studio-access-notice button').click()`);await pause(40);
   assert.equal(await js(`document.getElementById('account-heading').textContent`),'Create your SmoothyEdit account');
   assert.equal(await js(`document.getElementById('account-signup-credits').classList.contains('hidden')`),false);
   assert.match(await js(`document.getElementById('account-signup-credits').textContent`),/100 AI credits every month/);
   fs.writeFileSync(path.join(captures,`signup-from-${tab}.png`),(await win.webContents.capturePage()).toPNG());
   await js(`document.getElementById('login-close-btn').click()`);
  }
  await js(`window.electronAPI.__emit('onAuthStateChange',{user:{id:'free',email:'free@example.test',tier:'free'}})`);await pause(70);
  for(const [tab,prompt,button,method] of [['photos','photos-prompt','photos-generate','photosRun'],['chat','chat-prompt','chat-send','chatRun'],['studio-text','studio-text-input','studio-text-run','studioToolsRun']]){
   await js(`document.querySelector('[data-tab="${tab}"]').click()`);await pause(40);
   if(tab==='studio-text')await js(`document.querySelector('[data-studio-mode="title"]').click()`);
   await js(`document.getElementById('${prompt}').value='A signed in free prompt or transcript';document.getElementById('${prompt}').dispatchEvent(new Event('input',{bubbles:true}))`);
   if(tab==='studio-text')await js(`document.querySelector('[data-shorts-source="transcript"]').click()`);
   assert.equal(await js(`document.getElementById('${button}').disabled`),false,tab);
   await js(`document.getElementById('${button}').click()`);await pause(80);
   assert.equal((await calls()).filter(call=>call.name===method).length,1,`${tab} accepts a free request`);
  }
  for(const mode of ['shorts','condense','hook','title','description']){
   await js(`document.querySelector('[data-studio-mode="${mode}"]').click();document.getElementById('studio-text-input').value='Free transcript';document.querySelector('[data-shorts-source="transcript"]').click()`);await pause(20);
   assert.equal(await js(`document.getElementById('${mode==='shorts'?'analyze-shorts-btn':'studio-text-run'}').disabled`),false,mode);
  }
  for(const mode of ['thumbnail','broll','twitter','blog','sfx']){
   await js(`document.querySelector('[data-studio-mode="${mode}"]').click()`);await pause(15);
   assert.equal(await js(`document.getElementById('studio-text-run').disabled`),true,`${mode} retains its Pro requirement`);
  }
  for(const [width,height] of [[1000,740],[600,500]]){
   win.setSize(width,height);await js(`document.querySelector('[data-tab="photos"]').click()`);await pause(100);
   assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`),false);
   assert.match(await js(`document.getElementById('photos-credits').textContent`),/100 credits/);
   fs.writeFileSync(path.join(captures,`free-photos-${width}.png`),(await win.webContents.capturePage()).toPNG());
   await js(`window.electronAPI.__emit('onAuthStateChange',{user:null});document.querySelector('#photos-composer-dock .studio-access-notice button').click()`);await pause(50);
   const bounds=await js(`(()=>{const r=document.querySelector('.login-modal').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()`);assert.ok(bounds.top>=0&&bounds.bottom<=bounds.height);
   await js(`document.getElementById('login-close-btn').click();window.electronAPI.__emit('onAuthStateChange',{user:{id:'free',email:'free@example.test',tier:'free'}})`);await pause(30);
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS: monthly 100-credit signup copy and direct signup CTA in all three workspaces; visitors cannot generate; Free requests work for Photos/Chat/core Studio; credit display, existing Pro modes and 1000/600px layouts. Fixtures spend zero real credits.');win.destroy();app.exit(0);
 }catch(error){console.error(error,errors);win.destroy();app.exit(1);}
});
app.once('will-quit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});