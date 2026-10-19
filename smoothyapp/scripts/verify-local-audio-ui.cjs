// Native renderer with deferred fixture IPC; no provider, engine download or telemetry.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-audio-ui-'));
app.setPath('userData',path.join(scratch,'profile'));
const captures=process.env.SMOOTHY_REVIEW_DIR||path.resolve(root,'../docs/reviews/smoothyapp-audio-redesign');fs.mkdirSync(captures,{recursive:true});
const methods=[...fs.readFileSync(path.join(root,'src/preload/index.ts'),'utf8').matchAll(/^  (\w+):/gm)].map(m=>m[1]);
const rate=8000,samples=rate*8,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
const waveUrl='data:audio/wav;base64,'+wav.toString('base64'),preload=path.join(scratch,'preload.cjs');
fs.writeFileSync(preload,`const {contextBridge}=require('electron');const calls=[],callbacks={};let selection=0,source,ready=false,active,finish,reject;
const url=${JSON.stringify(waveUrl)};
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async(...args)=>{calls.push({name,args});return {}}]));
const deferred=kind=>{active=kind;return new Promise((resolve,no)=>{finish=resolve;reject=no})};
Object.assign(api,{
 getAuthState:async()=>({user:null}),getStatus:async()=>({connected:false,nle:'resolve'}),getActiveNLE:async()=>({activeNLE:'resolve'}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.1.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 resolveHandoffStatus:async()=>({installed:true,watching:true}),audioLibraryState:async()=>({success:true,tracks:[],candidates:[],watching:false}),audioArchiveSearch:async()=>({success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false}),stockGetSettings:async()=>({pixabayEnabled:true,folder:'/fixture/stock'}),
 localAudioState:async()=>({success:true,ready}),
 localAudioPick:async()=>{calls.push({name:'localAudioPick'});return deferred('pick')},
 localAudioSetup:async()=>{calls.push({name:'localAudioSetup'});return deferred('setup')},
 localAudioRun:async input=>{calls.push({name:'localAudioRun',input});return deferred('run')},
 localAudioCancel:async()=>{calls.push({name:'localAudioCancel'});return new Promise(resolve=>api.__finishCancel=resolve)},
 localAudioSave:async id=>{calls.push({name:'localAudioSave',id});return api.__saveResult||{success:true}},
 __pick:()=>{source={id:'original-'+(++selection),kind:'original',label:'Original',name:'Interview '+selection+'.wav',url};finish({success:true,source})},
 __pickCanceled:()=>finish({success:false,canceled:true}),__pickFailed:()=>finish({success:false,error:'Could not read this recording.'}),
 __ready:()=>{ready=true;finish({success:true,ready:true})},
 __fail:()=>finish({success:false,error:active==='setup'?'Audio engine setup failed.':'Audio enhancement failed. Try again.'}),
 __throw:()=>reject(Error('Audio connection failed.')),
 __stopped:()=>{finish({success:false,canceled:true});api.__finishCancel({success:true})},
 __cancelFailed:()=>api.__finishCancel({success:false,error:'Engine cancel failed. Try again.'}),
 __separate:()=>finish({success:true,original:source,outputs:[{id:'speech-'+selection,kind:'speech',label:'Speech',url},{id:'music-'+selection,kind:'music',label:'Music',url}]}),
 __enhance:()=>finish({success:true,original:source,outputs:[{id:'enhanced-'+selection,kind:'speech',label:'Enhanced speech',url}]}),
 __setSave:result=>api.__saveResult=result,
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.setAudioMuted(true);
 const js=code=>win.webContents.executeJavaScript(code),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const until=async code=>{for(let i=0;i<120;i++){if(await js(code))return;await pause(25);}throw Error('Timed out: '+code)};
 const callCount=name=>js(`window.electronAPI.__calls().filter(c=>c.name===${JSON.stringify(name)}).length`);
 const task=()=>js(`document.getElementById('local-audio-task').textContent`);
 const emit=message=>js(`window.electronAPI.__emit('onLocalAudioProgress',${JSON.stringify({message})})`);
 const previews=()=>js(`window.electronAPI.__calls().filter(c=>c.name==='localAudioPreview').map(c=>c.args[0]).sort()`);
 const seek=time=>js(`(()=>{const s=document.querySelector('.cleanup-seek');s.value=${time};s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 const level=(kind,value)=>js(`(()=>{const s=document.querySelector('.cleanup-track-${kind} input');s.value=${value};s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 const display=selector=>js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display`);
 const capture=async name=>fs.writeFileSync(path.join(captures,name),(await win.webContents.capturePage()).toPNG());
 const layout=async name=>{for(const [w,h] of [[900,700],[600,500],[1440,900],[1600,1000],[1920,1080]]){win.setContentSize(w,h);await pause(160);assert.equal(await js(`document.querySelector('#tab-local-audio .content-scroll').scrollWidth>document.querySelector('#tab-local-audio .content-scroll').clientWidth`),false);await js(`document.querySelector('#tab-local-audio .content-scroll').scrollTop=0`);await pause(60);await capture(`${name}-${w}.png`);if(w===600){await js(`document.getElementById('local-audio-results').scrollIntoView({block:'start'})`);await pause(80);await capture(`${name}-${w}-results.png`);}}win.setContentSize(900,700);await pause(120);};
 try{
  await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(350);win.showInactive();
  await click('[data-tab="local-audio"]');await pause(120);
  assert.equal(await js(`Boolean(document.querySelector('.cleanup-track-background'))`),false);
  assert.equal(await js(`document.getElementById('local-audio-setup-note').classList.contains('hidden')`),false);
  await layout('input');
  await click('#local-audio-pick');await until(`document.getElementById('local-audio-pick').disabled`);
  await emit('Preparing your original audio…');assert.match(await js(`document.getElementById('local-audio-status').textContent`),/Preparing/);
  await js(`window.electronAPI.__pick()`);await until(`document.getElementById('local-audio-task').textContent==='Setting up audio engine'`);
  assert.equal(await callCount('localAudioSetup'),1);assert.equal(await callCount('localAudioRun'),0);
  for(const [w,h] of [[1440,900],[600,500]]){win.setContentSize(w,h);await pause(140);await js(`document.getElementById('local-audio-operation').scrollIntoView({block:'nearest'})`);await pause(80);await capture(`processing-${w}.png`);}
  win.setContentSize(900,700);await pause(100);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),1);
  assert.equal(await display('.cleanup-track-speech input'),'none');
  assert.equal(await display('.cleanup-track-music input'),'none');
  assert.equal(await js(`document.querySelectorAll('.cleanup-track:not([hidden])').length`),2);
  await click('#local-audio-cancel');await emit('Late setup stage');assert.match(await js(`document.getElementById('local-audio-status').textContent`),/Canceling/);
  await js(`window.electronAPI.__cancelFailed()`);await until(`!document.getElementById('local-audio-cancel').disabled`);
  await click('#local-audio-cancel');await js(`window.electronAPI.__stopped()`);await until(`!document.getElementById('local-audio-retry').classList.contains('hidden')`);
  assert.equal(await js(`document.getElementById('local-audio-status').getAttribute('role')`),'status');
  await click('#local-audio-retry');await until(`document.getElementById('local-audio-task').textContent==='Setting up audio engine'`);
  await js(`window.electronAPI.__fail()`);await until(`!document.getElementById('local-audio-setup').classList.contains('hidden')`);
  assert.equal(await js(`document.getElementById('local-audio-status').getAttribute('role')`),'alert');
  assert.match(await js(`document.getElementById('local-audio-status').textContent`),/setup failed/i);
  await click('#local-audio-setup');await until(`document.getElementById('local-audio-task').textContent==='Setting up audio engine'`);
  await js(`window.electronAPI.__ready()`);await until(`window.electronAPI.__calls().some(c=>c.name==='localAudioRun')`);
  assert.equal(await js(`window.electronAPI.__calls().find(c=>c.name==='localAudioRun').input.mode`),'separate');
  assert.equal(await task(),'Separating speech and music');
  for(const message of ['Loading music separation model…','Separating voice and music…','Preparing speech and music tracks…']){await emit(message);assert.equal(await js(`document.getElementById('local-audio-status').textContent`),message);}
  assert.equal(await display('#local-audio-progress'),'none');
  await js(`window.electronAPI.__emit('onLocalAudioProgress',{message:'Separating voice and music…',stage:'separate',completed:3,total:12,unit:'chunks'})`);
  assert.equal(await js(`document.getElementById('local-audio-progress').getAttribute('aria-valuenow')`),'3');
  assert.match(await js(`document.getElementById('local-audio-progress-hint').textContent`),/3 \/ 12 chunks · 25%/);
  assert.equal(await js(`document.querySelector('#local-audio-progress span').style.width`),'25%');
  await pause(600);
  assert.equal(await js(`document.getElementById('local-audio-progress').getAttribute('aria-valuenow')`),'3');
  await capture('real-progress.png');
  await emit('Writing audio…');assert.equal(await display('#local-audio-progress'),'none');
  await click('#local-audio-cancel');await js(`window.electronAPI.__stopped()`);await until(`!document.querySelector('.cleanup-compare').disabled`);
  assert.equal(await js(`document.getElementById('local-audio-status').getAttribute('role')`),'status');
  const runs=await callCount('localAudioRun');
  await click('#local-audio-retry');await until(`document.getElementById('local-audio-task').textContent==='Separating speech and music'`);
  await js(`window.electronAPI.__separate()`);await until(`!document.querySelector('.cleanup-compare').disabled`);await pause(100);
  assert.equal(await callCount('localAudioRun'),runs+1);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),3);
  assert.equal(await js(`document.querySelectorAll('.cleanup-track:not([hidden])').length`),2);
  assert.equal(await js(`Boolean(document.querySelector('.cleanup-track-background'))`),false);
  assert.equal(await js(`document.querySelector('.cleanup-track-speech .cleanup-save').disabled`),false);
  assert.equal(await js(`document.querySelector('.cleanup-track-music .cleanup-save').disabled`),false);
  assert.equal(await js(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')`),'false');
  assert.equal(await js(`getComputedStyle(document.querySelector('.cleanup-track-speech .cleanup-exact')).display`),'flex');
  await seek(2.4);
  assert.ok(Math.abs(await js(`document.querySelector('.cleanup-seek').value`)-2.4)<.05);
  assert.equal(await js(`document.querySelector('.cleanup-track-speech .cleanup-track-caption').textContent`),'The voice from your recording, unchanged.');
  assert.match(await js(`document.querySelector('.cleanup-track-music .cleanup-track-caption').textContent`),/Music, room and noise/);
  await layout('separated');
  win.setContentSize(900,700);await pause(100);
  assert.notEqual(await display('.cleanup-track-music .cleanup-mute'),'none');
  await click('.cleanup-track-speech .cleanup-solo');await pause(320);
  assert.equal(await js(`document.querySelector('audio[data-kind="music"]').muted`),true);
  assert.equal(await js(`document.querySelector('audio[data-variant="separated"][data-kind="speech"]').muted`),false);
  assert.deepEqual(await previews(),['speech-1']);
  await capture('speech-solo.png');
  const times=await js(`[...document.querySelectorAll('.cleanup-media audio[data-variant="separated"]')].map(a=>a.currentTime)`);assert.ok(times[0]>2.5);assert.ok(Math.max(...times)-Math.min(...times)<.15);
  await click('.cleanup-track-music .cleanup-solo');await pause(120);
  assert.equal(await js(`document.querySelector('audio[data-variant="separated"][data-kind="speech"]').muted`),true);
  assert.equal(await js(`document.querySelector('audio[data-kind="music"]').muted`),false);
  await capture('music-solo.png');
  await click('.cleanup-track-music .cleanup-solo');
  assert.equal(await js(`[...document.querySelectorAll('audio[data-variant="separated"]')].some(a=>a.muted)`),false);
  await click('.cleanup-track-music .cleanup-mute');
  assert.equal(await js(`document.querySelector('audio[data-kind="music"]').muted`),true);
  await click('.cleanup-track-music .cleanup-mute');
  await click('.cleanup-play');
  assert.equal(await js(`[...document.querySelectorAll('.cleanup-media audio')].every(a=>a.paused)`),true);
  assert.deepEqual(await previews(),['music-1','speech-1']);
  const enhanceSeek=Number(await js(`document.querySelector('.cleanup-seek').value`));
  await click('.cleanup-enhanced-label');await until(`document.getElementById('local-audio-task').textContent==='Enhancing speech'`);
  assert.equal(await js(`window.electronAPI.__calls().filter(c=>c.name==='localAudioRun').at(-1).input.mode`),'enhance');
  assert.equal(await js(`document.querySelector('.cleanup-compare').disabled`),true);
  await js(`window.electronAPI.__enhance()`);await until(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')==='true'`);await pause(100);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),4);
  assert.equal(await js(`document.querySelector('.cleanup-track-music').hidden`),true);
  assert.equal(await display('.cleanup-track-music'),'none');
  assert.equal(await js(`document.querySelectorAll('.cleanup-track:not([hidden])').length`),1);
  assert.notEqual(await display('.cleanup-track-speech input'),'none');
  assert.equal(await js(`document.querySelector('.cleanup-track-speech .cleanup-track-tag').hidden`),false);
  assert.equal(await js(`document.querySelector('.cleanup-track-speech output').textContent`),'100%');
  assert.equal(await js(`document.querySelector('.cleanup-track-speech .cleanup-mute').hidden`),false);
  assert.match(await js(`document.getElementById('local-audio-status').textContent`),/Speech enhanced/);
  assert.ok(Math.abs(Number(await js(`document.querySelector('.cleanup-seek').value`))-enhanceSeek)<.05);
  await layout('enhanced');
  win.setContentSize(900,700);await pause(100);
  await click('.cleanup-play');await pause(300);
  assert.ok(await js(`document.querySelector('audio[data-variant="enhanced"]').currentTime`)>2.5);
  assert.equal(await js(`document.querySelector('audio[data-kind="music"]').paused`),true);
  await click('.cleanup-play');
  await level('speech',38);assert.equal(await js(`document.querySelector('audio[data-variant="enhanced"]').volume`),.38);
  await click('.cleanup-track-speech .cleanup-mute');assert.equal(await js(`document.querySelector('audio[data-variant="enhanced"]').muted`),true);
  assert.equal(await js(`document.querySelector('.cleanup-track-speech output').textContent`),'38%');
  const enhancedRuns=await callCount('localAudioRun');
  await click('.cleanup-original-label');await pause(80);
  assert.equal(await js(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')`),'false');
  assert.equal(await js(`document.querySelectorAll('.cleanup-track:not([hidden])').length`),2);
  assert.equal(await js(`document.querySelector('audio[data-variant="enhanced"]').paused`),true);
  assert.equal(await display('.cleanup-track-speech input'),'none');
  await click('.cleanup-enhanced-label');await pause(80);
  assert.equal(await js(`document.querySelector('.cleanup-track-speech input').value`),'38');
  assert.equal(await js(`document.querySelector('audio[data-variant="enhanced"]').muted`),true);
  assert.equal(await callCount('localAudioRun'),enhancedRuns);
  await click('.cleanup-track-speech .cleanup-save');await pause(40);assert.match(await js(`document.getElementById('local-audio-playback-status').textContent`),/saved/);
  await js(`window.electronAPI.__setSave({canceled:true})`);await click('.cleanup-track-speech .cleanup-save');await pause(30);assert.match(await js(`document.getElementById('local-audio-playback-status').textContent`),/canceled/);
  await js(`window.electronAPI.__setSave({error:'Disk full'})`);await click('.cleanup-track-speech .cleanup-save');await pause(30);assert.match(await js(`document.getElementById('local-audio-playback-status').textContent`),/Disk full/);
  await js(`document.getElementById('local-audio-playback-status').classList.add('hidden')`);
  const beforeSwitch=await js(`window.electronAPI.__calls().filter(c=>c.name==='localAudioRun').length`);
  await click('.cleanup-original-label');await pause(60);await click('.cleanup-enhanced-label');await pause(60);
  assert.equal(await js(`window.electronAPI.__calls().filter(c=>c.name==='localAudioRun').length`),beforeSwitch);
  await seek(1.2);await click('.cleanup-play');await pause(150);
  await click('[data-tab="multicam"]');await pause(60);assert.equal(await js(`[...document.querySelectorAll('.cleanup-media audio')].every(a=>a.paused)`),true);
  await click('[data-tab="local-audio"]');await click('#local-audio-pick');await until(`document.getElementById('local-audio-pick').disabled`);
  await js(`window.electronAPI.__pickFailed()`);await until(`!document.getElementById('local-audio-pick').disabled`);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),4);
  assert.equal(await js(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')`),'true');
  assert.equal(await js(`document.querySelector('.cleanup-track-speech input').value`),'38');
  await click('#local-audio-pick');await until(`document.getElementById('local-audio-pick').disabled`);await js(`window.electronAPI.__pickCanceled()`);await until(`!document.getElementById('local-audio-pick').disabled`);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),4);
  await click('#local-audio-pick');await until(`document.getElementById('local-audio-pick').disabled`);await js(`window.electronAPI.__pick()`);await until(`document.getElementById('local-audio-task').textContent==='Separating speech and music'`);
  await js(`window.electronAPI.__separate()`);await until(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')==='false'`);await pause(80);
  assert.equal(await js(`document.querySelectorAll('.cleanup-media audio').length`),3);
  assert.equal(await js(`document.querySelectorAll('.cleanup-track:not([hidden])').length`),2);
  assert.equal(await display('.cleanup-track-speech input'),'none');
  assert.equal(await js(`Boolean(document.querySelector('audio[data-variant="enhanced"]'))`),false);
  await seek(1.2);await click('.cleanup-play');await pause(120);await click('.cleanup-enhanced-label');await until(`document.getElementById('local-audio-task').textContent==='Enhancing speech'`);
  await js(`window.electronAPI.__enhance()`);await until(`document.querySelector('.cleanup-compare').getAttribute('aria-checked')==='true'`);await pause(80);
  assert.equal(await js(`[...document.querySelectorAll('.cleanup-media audio')].every(a=>a.paused)`),false);
  await click('.cleanup-play');
  assert.equal(await callCount('trackFeature'),0);
  const summary='PASS: independent Speech/Music Solo and mute, global pause, synchronized playback, audible-only preview deduplication, measured chunk progress frozen until work completes, unknown-stage bar hidden; exact separation without levels, Enhanced-only speech, setup/cancel/error/retry/save controls and 900/600/1440/1600/1920 layouts.';
  fs.writeFileSync(path.join(captures,'ui-result.json'),JSON.stringify({passed:true,summary,calls:await js(`window.electronAPI.__calls().map(c=>({name:c.name,input:c.input}))`)},null,2));console.log(summary);win.destroy();app.exit(0);
 }catch(error){console.error(error);win.destroy();app.exit(1);}
});
app.once('will-quit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});
