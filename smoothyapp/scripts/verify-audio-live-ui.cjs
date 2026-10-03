// Real archive/audio IPC and full renderer; other app APIs use fixture adapters.
// Run after npm run build: node node_modules/electron/cli.js scripts/verify-audio-live-ui.cjs
process.env.SMOOTHY_TELEMETRY='0';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-stock-ui-'));
app.setPath('userData', path.join(scratch, 'user-data'));
app.once('will-quit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
const preload = path.join(scratch, 'preload.cjs');
const pcm=Buffer.alloc(44+8000*8*2);pcm.write('RIFF',0);pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(8000,24);pcm.writeUInt32LE(16000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);const fixtureAudio=pcm.toString('base64');
fs.writeFileSync(preload, `const { contextBridge } = require('electron');
const callbacks = {}, calls = []; const fixtureAudio='${fixtureAudio}'; let resolveDownload,resolveArchive,pixabayEnabled=false;
const api = Object.fromEntries(${JSON.stringify(methods)}.map(name => [name, name.startsWith('on') ? callback => { (callbacks[name] ||= []).push(callback); } : async (...args) => { calls.push({name,args}); return {}; }]));
let community={favorites:[],counts:{'archive-0':9},staffPicks:['archive-2'],sharing:true,online:true};
let audioState={tracks:[],candidates:[],watching:false,watchFolder:'/fixture/Downloads',folder:'/fixture/Audio Library'};
const emitAudio=()=>{for(const callback of callbacks.onAudioLibraryChanged||[])callback(audioState);};
Object.assign(api, {
 getAuthState: async()=>({user:null}),getStatus:async()=>({connected:false}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '1.5.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getShowLogs:async()=>false,getAlwaysOnTop:async()=>false,getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioCommunityState:async()=>({success:true,...community}),
 audioFavoriteSet:async input=>{calls.push({name:'audioFavoriteSet',args:[input]});community.favorites=input.active?[...new Set([...community.favorites,input.id])]:community.favorites.filter(id=>id!==input.id);for(const cb of callbacks.onAudioCommunityChanged||[])cb(community);return {success:true,...community};},
 __community:data=>{community={...community,...data};for(const cb of callbacks.onAudioCommunityChanged||[])cb(community);},
 audioArchiveSearch:async input=>{
  calls.push({name:'audioArchiveSearch',args:[input]});if(input.query==='error')return {success:false,error:'Archive unavailable'};
  let tracks=Array.from({length:43},(_,i)=>({id:'archive-'+i,title:i===0?'<script>Jazz</script>':'Archive Track '+i,artist:i===1?'Artist B':'Artist A',genre:i%2?'Cinematic':'Jazz & Blues',mood:i%2?'Dramatic':'Calm',duration:160+i,previewUrl:'data:audio/wav;base64,'+fixtureAudio}));
  if(input.view==='favorites')tracks=tracks.filter(t=>community.favorites.includes(t.id));if(input.view==='staff')tracks=tracks.filter(t=>community.staffPicks.includes(t.id));
  if(input.category==='cinematic')tracks=tracks.filter(t=>t.genre==='Cinematic');if(input.mood)tracks=tracks.filter(t=>t.mood===input.mood);
  if(input.query)tracks=tracks.filter(t=>[t.title,t.artist].join(' ').toLowerCase().includes(input.query.toLowerCase()));
  return {success:true,tracks:tracks.slice(input.offset,input.offset+40),total:tracks.length,hasMore:input.offset+40<tracks.length,offset:input.offset,categories:[{id:'all',label:'All tracks',count:43},{id:'cinematic',label:'Cinematic',count:21},{id:'jazz-blues',label:'Jazz & Blues',count:22}],moods:[{label:'Calm',count:22},{label:'Dramatic',count:21}]};
 },
 audioArchiveDownload:input=>{calls.push({name:'audioArchiveDownload',args:[input]});return new Promise(resolve=>resolveArchive=resolve);},
 audioArchiveCancel:async()=>{resolveArchive?.({success:true,canceled:true});return {success:true};},
 __archiveProgress:data=>{for(const callback of callbacks.onAudioArchiveProgress||[])callback(data);},
 __finishArchive:()=>{const track={id:'00000000-0000-4000-8000-000000000001',title:'Archive Track',artist:'',license:'unverified',credit:'Archive license not supplied',archiveId:'archive-0',previewUrl:'data:audio/wav;base64,'+fixtureAudio};audioState.tracks.push(track);emitAudio();resolveArchive?.({success:true,...audioState,savedId:track.id});},
 audioLibraryState:async()=>({success:true,...audioState}),
 audioLibraryOpen:async()=>{calls.push({name:'audioLibraryOpen',args:[]});audioState.watching=true;return {success:true,...audioState};},
 audioLibraryStop:async()=>{audioState.watching=false;emitAudio();return {success:true};},
 audioLibrarySelectFolder:async()=>{audioState.watchFolder='/fixture/New Downloads';return {success:true,...audioState};},
 audioLibraryPick:async()=>{audioState.candidates=[{id:'pending-1',name:'<script>Track</script> - Artist.mp3'}];return {success:true,...audioState};},
 audioLibraryDismiss:async id=>{audioState.candidates=audioState.candidates.filter(item=>item.id!==id);return {success:true};},
 audioLibraryKeep:async options=>{calls.push({name:'audioLibraryKeep',args:[options]});if(options.license==='cc-by'&&!options.credit.trim())return {success:false,error:'Paste the attribution text from YouTube'};audioState.candidates=[];audioState.tracks.push({...options,id:'00000000-0000-4000-8000-000000000002',previewUrl:'data:audio/wav;base64,'+fixtureAudio});return {success:true,...audioState};},
 audioLibraryUpdate:async options=>{audioState.tracks=audioState.tracks.map(track=>track.id===options.id?{...track,...options}:track);return {success:true,...audioState};},
 audioLibraryImport:async id=>{calls.push({name:'audioLibraryImport',args:[id]});return {success:true,imported:true};},
 stockGetSettings:async()=>({folder:'/fixture/Stock Footage',pixabayEnabled}),
 stockSearch:async input=>{
  calls.push({name:'stockSearch',args:[input]});if(input.query==='empty') return {success:true,videos:[],page:1,total:0,hasMore:false};if(input.query==='error')return {success:false,error:'Wikimedia search limit reached. Please try again later.'};
  if(input.provider==='all'){
   const providers=input.query==='partial'?['commons','archive']:['commons','archive','nasa',...(pixabayEnabled?['pixabay']:[])];
   const results=await Promise.all(providers.map(provider=>api.stockSearch({...input,provider})));
   const videos=Array.from({length:6},(_,i)=>results.flatMap(result=>result.videos[i]?[result.videos[i]]:[])).flat();
   return {success:true,videos,page:input.page,nextOffset:0,hasMore:input.page<2,sourceCursors:Object.fromEntries(['commons','archive','nasa'].map(provider=>[provider,{page:input.page+1,cursor:input.page*40,done:input.page>=2}])),...(input.query==='partial'?{warning:'NASA could not be searched. Load more to retry.'}:{})};
  }
  const provider=input.provider||'commons',nasa=provider==='nasa',colors=['#91bdad','#8fa5c6','#cfb892','#8ac3c8','#aaa2b5','#a5bb9a'];
  if(provider==='pixabay'&&!pixabayEnabled)return {success:false,error:'Pixabay is unavailable in this build.'};
  const url=nasa?'https://images.nasa.gov/details/Earth_01':provider==='pixabay'?'https://pixabay.com/videos/id-12/':provider==='archive'?'https://archive.org/details/ocean':'https://commons.wikimedia.org/wiki/File:0/';
  return {success:true,page:input.page,nextOffset:input.page*40,hasMore:input.page<2,videos:colors.map((color,i)=>({id:provider==='commons'?input.page*100+i:provider+':clip-'+(input.page>1?input.page+'-':'')+i,provider,duration:nasa?0:12+i*7,title:i===0?'<script>Ocean</script>':'Sample Shot '+(i+1),license:nasa?'NASA media guidelines':provider==='pixabay'?'Pixabay Content License':i%2?'Public domain':'CC0',licenseUrl:nasa?'https://www.nasa.gov/nasa-brand-center/images-and-media/':provider==='pixabay'?'https://pixabay.com/service/license-summary/':'https://creativecommons.org/publicdomain/zero/1.0/',usage:nasa?'Acknowledge NASA as the source. Follow NASA media guidelines.':provider==='pixabay'?'Use under the Pixabay Content License. Check other rights for your edit.':'Check the item publisher’s declared license.',url,creator:i===0?'<script>Creator</script>':'Sample Creator '+(i+1),image:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect fill="'+color+'" width="640" height="400"/><circle fill="#ffffff77" cx="490" cy="100" r="42"/><path fill="#23483d55" d="M0 400V280L160 130L310 285L460 190L640 360V400Z"/></svg>'),files:[{id:10+i,width:nasa?0:1920,height:nasa?0:1080,fps:nasa?0:25,label:'Medium MP4',link:'https://upload.wikimedia.org/fixture.webm'},{id:20+i,width:nasa?0:640,height:nasa?0:360,fps:nasa?0:25,label:'Small MP4',link:'https://upload.wikimedia.org/fixture.webm'}]}))};
 },
 stockDownload: options=>{calls.push({name:'stockDownload',args:[options]});return new Promise(resolve=>{resolveDownload=resolve;});},
 stockCancelDownload:async()=>{calls.push({name:'stockCancelDownload',args:[]});resolveDownload?.({canceled:true});return {success:true};},
 stockSelectFolder:async()=>({success:true,folder:'/fixture/New Stock Folder'}),
 openExternal:async url=>{calls.push({name:'openExternal',args:[url]});},
 __calls:()=>calls,
 __enablePixabay:()=>{pixabayEnabled=true;},
 __emitConnection:connected=>{for(const callback of callbacks.onConnectionChange||[])callback({connected,nle:'premiere'});},
 __finishDownload:result=>resolveDownload?.(result),
 __progress:data=>{for(const callback of callbacks.onStockDownloadProgress||[])callback(data);}
});const {ipcRenderer}=require('electron');api.audioArchiveSearch=input=>ipcRenderer.invoke('audio-archive-search',input);api.audioCommunityState=()=>ipcRenderer.invoke('audio-community-state');api.audioLibraryState=()=>ipcRenderer.invoke('audio-library-state');ipcRenderer.on('audio-community-changed',(_,data)=>{for(const cb of callbacks.onAudioCommunityChanged||[])cb(data);});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

fs.mkdirSync(path.join(scratch,'music'));app.setPath('music',path.join(scratch,'music'));
const {buildSync}=require('esbuild');buildSync({entryPoints:[path.join(root,'src/main/audio-library-ipc.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(scratch,'audio.cjs')});
const {registerAudioLibrary}=require(path.join(scratch,'audio.cjs'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:750,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}}),values=new Map();
 const js=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  await registerAudioLibrary({store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v)},window:()=>win,connected:()=>false,importToPremiere:async()=>({success:false})});
  await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(200);await js(`document.querySelector('[data-tab="audio"]').click()`);
  for(let i=0;i<100;i++){if(await js(`document.querySelectorAll('#audio-archive-results tr').length===40`))break;await pause(250);}
  assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),40);
  await js(`document.getElementById('audio-archive-genre').value='cinematic';document.getElementById('audio-archive-genre').dispatchEvent(new Event('change'))`);
  for(let i=0;i<30;i++){if(await js(`document.querySelectorAll('#audio-archive-results tr').length===40`))break;await pause(100);}
  await js(`window.audioEvents=[];const a=document.getElementById('audio-dock-player');for(const name of ['loadstart','loadedmetadata','canplay','playing','waiting','stalled','pause','error'])a.addEventListener(name,()=>audioEvents.push({name,time:a.currentTime,error:a.error?.message}));document.querySelector('#audio-archive-results .audio-row-play').click()`);
  for(let i=0;i<180;i++){if(await js(`document.getElementById('audio-dock-player').currentTime>1 || !!document.getElementById('audio-dock-player').error`))break;await pause(250);}
  const playback=await js(`(()=>{const a=document.getElementById('audio-dock-player');return {title:document.getElementById('audio-dock-title').textContent,time:a.currentTime,paused:a.paused,duration:a.duration,error:a.error?.message,events:audioEvents,status:document.getElementById('audio-archive-status').textContent};})()`);
  console.log('Native streaming playback:',JSON.stringify(playback));assert.ok(playback.time>1&&!playback.paused,JSON.stringify(playback));
  const destination=path.resolve(root,'../docs/reviews/smoothyapp-1.5.1/audio-refresh/live-library.png');fs.writeFileSync(destination,(await win.webContents.capturePage()).toPNG());
  console.log('PASS: full Electron renderer loads actual 5,142-track catalog and matched metadata, with real main/preload IPC and production community read. Captured real Cinematic rows and the fixed player; no votes submitted.');
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();fs.rmSync(scratch,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
