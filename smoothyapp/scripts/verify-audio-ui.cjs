// Full Electron renderer checks with native/Commons/audio fixtures and blocked remote requests.
// Run after npm run build: node node_modules/electron/cli.js scripts/verify-audio-ui.cjs
const { app, BrowserWindow, session, protocol } = require('electron');
protocol.registerSchemesAsPrivileged([{scheme:'smoothy-audio',privileges:{standard:true,secure:true,stream:true}}]);
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
const callbacks = {}, calls = []; const fixtureAudio='${fixtureAudio}'; let resolveDownload,resolveArchive,pixabayEnabled=false,previewOverride='';
const api = Object.fromEntries(${JSON.stringify(methods)}.map(name => [name, name.startsWith('on') ? callback => { (callbacks[name] ||= []).push(callback); } : async (...args) => { calls.push({name,args}); return {}; }]));
let community={favorites:[],counts:{'archive-0':9},staffPicks:['archive-2'],sharing:true,online:true};
let audioState={tracks:[],candidates:[],watching:false,watchFolder:'/fixture/Downloads',folder:'/fixture/Audio Library'};
const emitAudio=()=>{for(const callback of callbacks.onAudioLibraryChanged||[])callback(audioState);};
Object.assign(api, {
 getAuthState: async()=>({user:null}),getStatus:async()=>({connected:false}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '1.5.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getShowLogs:async()=>false,getAlwaysOnTop:async()=>false,getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioCommunityState:async()=>({success:true,...community}),
 audioFavoriteSharing:async enabled=>{calls.push({name:'audioFavoriteSharing',args:[enabled]});community.sharing=enabled;for(const cb of callbacks.onAudioCommunityChanged||[])cb(community);return {success:true,...community};},
 audioFavoriteSet:async input=>{calls.push({name:'audioFavoriteSet',args:[input]});community.favorites=input.active?[...new Set([...community.favorites,input.id])]:community.favorites.filter(id=>id!==input.id);for(const cb of callbacks.onAudioCommunityChanged||[])cb(community);return {success:true,...community};},
 __community:data=>{community={...community,...data};for(const cb of callbacks.onAudioCommunityChanged||[])cb(community);},
 audioArchiveSearch:async input=>{
  calls.push({name:'audioArchiveSearch',args:[input]});if(input.query==='error')return {success:false,error:'Archive unavailable'};
  let tracks=Array.from({length:43},(_,i)=>({id:'archive-'+i,title:i===0?'<script>Jazz</script>':'Archive Track '+i,artist:i===1?'Artist B':'Artist A',genre:i%2?'Cinematic':'Jazz & Blues',mood:i%2?'Dramatic':'Calm',duration:160+i,previewUrl:i===0&&previewOverride?previewOverride:'data:audio/wav;base64,'+fixtureAudio}));
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
 __useFlakyAudio:()=>{previewOverride='smoothy-audio://preview/retry';},
 __enablePixabay:()=>{pixabayEnabled=true;},
 __emitConnection:connected=>{for(const callback of callbacks.onConnectionChange||[])callback({connected,nle:'premiere'});},
 __finishDownload:result=>resolveDownload?.(result),
 __progress:data=>{for(const callback of callbacks.onStockDownloadProgress||[])callback(data);}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async()=>{
 let previewRequests=0;protocol.handle('smoothy-audio',()=>++previewRequests===1?new Response('',{status:404,headers:{'cache-control':'no-store'}}):new Response(pcm,{headers:{'content-type':'audio/wav','cache-control':'no-store'}}));
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const win=new BrowserWindow({width:1100,height:750,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 const js=code=>win.webContents.executeJavaScript(code), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const snap=async name=>{const dest=path.resolve(root,'../docs/reviews/smoothyapp-1.5.1/audio-refresh');fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 try {
 await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(150);
 await js(`document.querySelector('[data-tab="audio"]').click()`);await pause(80);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),40);
 const initialSeed=await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').at(-1).args[0].shuffleSeed`);
 assert.ok(Number.isInteger(initialSeed)&&initialSeed>=0&&initialSeed<=0xFFFFFFFF);
 assert.deepEqual(await js(`Array.from(document.querySelectorAll('#audio-archive-panel th')).slice(2).map(el=>el.textContent)`),['Track title','Genre','Mood','Artist','Duration','License type']);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results script').length`),0);
 await js(`document.getElementById('audio-info-open').click()`);
 assert.equal(await js(`document.getElementById('audio-info-dialog').open`),true);
 assert.equal(await js(`document.activeElement.id`),'audio-info-close');
 assert.equal(await js(`document.getElementById('audio-info-copy').disabled`),true);
 await js(`document.getElementById('audio-share-favorites').click()`);await pause(50);
 assert.equal(await js(`document.getElementById('audio-share-favorites').checked`),false);
 assert.match(await js(`document.getElementById('audio-sharing-status').textContent`),/Previously shared votes/);
 await js(`document.getElementById('audio-share-favorites').click()`);await pause(50);
 assert.equal(await js(`document.getElementById('audio-share-favorites').checked`),true);
 await js(`document.getElementById('audio-info-close').click()`);await pause(50);
 assert.equal(await js(`document.activeElement.id`),'audio-info-open');
 const bottom=await js(`(()=>{const row=document.querySelector('#audio-archive-results tr:last-child');row.scrollIntoView({block:'center'});const button=row.querySelector('.audio-row-play');button.focus({preventScroll:true});window.bottomRow=row;window.bottomButton=button;const before={scroll:document.querySelector('#tab-audio .content-scroll').scrollTop,height:document.querySelector('.audio-player-dock').getBoundingClientRect().height};button.click();return before;})()`);
 assert.ok(bottom.scroll>500);
 assert.equal(await js(`window.bottomRow.isConnected&&document.activeElement===window.bottomButton`),true);
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),bottom.scroll);
 assert.equal(await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().height`),bottom.height);
 for(let i=0;i<50;i++){if(await js(`document.getElementById('audio-dock-player').currentTime>.1`))break;await pause(50);}
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),bottom.scroll);
 assert.equal(await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().height`),bottom.height);
 const searchesBeforeStar=await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').length`);
 await js(`window.bottomStar=bottomRow.querySelector('.audio-star');bottomStar.focus({preventScroll:true});bottomStar.click()`);await pause(50);
 assert.equal(await js(`bottomRow.isConnected&&document.activeElement===bottomStar`),true);
 assert.equal(await js(`bottomStar.getAttribute('aria-pressed')`),'true');
 assert.equal(await js(`document.getElementById('audio-dock-star').getAttribute('aria-pressed')`),'true');
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),bottom.scroll);
 await js(`window.electronAPI.__community({counts:{'archive-39':12},staffPicks:['archive-39']})`);await pause(50);
 assert.equal(await js(`bottomRow.isConnected&&document.activeElement===bottomStar`),true);
 assert.equal(await js(`bottomStar.title`),'12 community favorites');
 assert.equal(await js(`bottomRow.querySelector('.audio-pick-badge').textContent`),'Staff pick');
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),bottom.scroll);
 await js(`bottomStar.click()`);await pause(50);
 await js(`window.electronAPI.__community({counts:{'archive-0':9},staffPicks:['archive-2']})`);await pause(50);
 assert.equal(await js(`bottomRow.isConnected&&document.activeElement===bottomStar`),true);
 assert.equal(await js(`bottomStar.getAttribute('aria-pressed')`),'false');
 assert.equal(await js(`bottomRow.querySelector('.audio-pick-badge')===null`),true);
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),bottom.scroll);
 assert.equal(await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().height`),bottom.height);
 assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').length`),searchesBeforeStar);
 assert.ok(await js(`document.getElementById('audio-dock-volume').getBoundingClientRect().width>=100`));
 await js(`document.getElementById('audio-dock-volume').value=.35;document.getElementById('audio-dock-volume').dispatchEvent(new Event('input'))`);
 assert.equal(await js(`document.getElementById('audio-dock-player').volume`),.35);
 await js(`document.getElementById('audio-dock-volume').value=1;document.getElementById('audio-dock-volume').dispatchEvent(new Event('input'));document.querySelector('#tab-audio .content-scroll').scrollTop=0`);
 await js(`document.querySelector('#audio-archive-results .audio-row-play').click()`);await pause(200);
 assert.equal(await js(`document.getElementById('audio-dock-title').textContent`),'<script>Jazz</script>');
 await js(`document.getElementById('audio-info-open').click()`);
 assert.equal(await js(`document.getElementById('audio-info-title').textContent`),'<script>Jazz</script>');
 assert.equal(await js(`document.querySelectorAll('#audio-info-dialog script').length`),0);
 assert.equal(await js(`document.getElementById('audio-info-license').textContent`),'Not supplied');
 await pause(100);await snap('licenses');await js(`document.getElementById('audio-info-close').click()`);
 assert.equal(await js(`document.querySelectorAll('#tab-audio audio').length`),1);
 assert.ok(await js(`document.getElementById('audio-dock-player').duration>7`));
 for(let i=0;i<50;i++){if(await js(`document.getElementById('audio-dock-player').currentTime>.1`))break;await pause(50);}
 assert.equal(await js(`document.querySelector('#audio-archive-results .audio-row-play').dataset.icon`),'pause');
 assert.equal(await js(`document.getElementById('audio-dock-play').dataset.icon`),'pause');
 await js(`document.querySelector('#audio-archive-results .audio-row-play').click()`);await pause(50);
 assert.equal(await js(`document.getElementById('audio-dock-player').paused`),true);
 assert.equal(await js(`document.querySelector('#audio-archive-results .audio-row-play').dataset.icon`),'play');
 await js(`document.getElementById('audio-dock-play').click()`);await pause(100);
 for(let i=0;i<50;i++){if(await js(`document.getElementById('audio-dock-play').dataset.icon==='pause'`))break;await pause(50);}
 assert.equal(await js(`document.querySelector('#audio-archive-results .audio-row-play').dataset.icon`),'pause');
 await js(`document.getElementById('audio-dock-seek').value=3;document.getElementById('audio-dock-seek').dispatchEvent(new Event('input'))`);await pause(50);
 assert.ok(await js(`document.getElementById('audio-dock-player').currentTime>=3`));
 const before=await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().y`);
 await js(`document.querySelector('#tab-audio .content-scroll').scrollTop=500`);await pause(50);
 assert.equal(await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().y`),before);
 const source=await js(`document.getElementById('audio-dock-player').src`);
 await js(`document.querySelector('#audio-archive-results .audio-star').click()`);await pause(50);
 assert.equal(await js(`document.querySelector('#audio-archive-results .audio-star').getAttribute('aria-pressed')`),'true');
 assert.equal(await js(`document.getElementById('audio-dock-star').getAttribute('aria-pressed')`),'true');
 await js(`document.getElementById('audio-view-favorites').click()`);await pause(50);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),1);
 assert.equal(await js(`document.getElementById('audio-dock-player').src`),source);
 await js(`document.getElementById('audio-dock-star').click()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),0);
 await js(`window.electronAPI.__community({favorites:Array.from({length:43},(_,i)=>'archive-'+i)})`);await pause(50);
 await js(`document.getElementById('audio-archive-more').click()`);await pause(50);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),43);
 const favoritesScroll=await js(`(()=>{window.retainedFavorite=document.querySelector('#audio-archive-results tr[data-id="archive-30"]');retainedFavorite.scrollIntoView({block:'center'});window.retainedStar=retainedFavorite.querySelector('.audio-star');retainedStar.focus({preventScroll:true});const top=document.querySelector('#tab-audio .content-scroll').scrollTop;document.querySelector('#audio-archive-results tr[data-id="archive-34"] .audio-star').click();return top;})()`);await pause(50);
 assert.ok(favoritesScroll>500);
 assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollTop`),favoritesScroll);
 assert.equal(await js(`retainedFavorite.isConnected&&document.activeElement===retainedStar`),true);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),42);
 assert.equal(await js(`document.querySelector('#audio-archive-results tr[data-id="archive-34"]')===null`),true);
 assert.equal(await js(`document.querySelector('#audio-archive-results tr:last-child').dataset.id`),'archive-42');
 await js(`window.electronAPI.__community({favorites:[]})`);await pause(50);
 await js(`document.getElementById('audio-view-staff').click()`);await pause(50);assert.equal(await js(`document.querySelector('#audio-archive-results .audio-pick-badge').textContent`),'Staff pick');
 await js(`document.getElementById('audio-view-all').click()`);await pause(50);
 const refreshedSeed=await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').at(-1).args[0].shuffleSeed`);
 assert.notEqual(refreshedSeed,initialSeed);
 await js(`document.getElementById('audio-archive-genre').value='cinematic';document.getElementById('audio-archive-genre').dispatchEvent(new Event('change'))`);await pause(50);
 assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').at(-1).args[0].shuffleSeed`),refreshedSeed);
 assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),21);
 await js(`document.getElementById('audio-archive-mood').value='Calm';document.getElementById('audio-archive-mood').dispatchEvent(new Event('change'))`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),0);
 await js(`document.getElementById('audio-view-all').click()`);await pause(50);await js(`document.getElementById('audio-archive-query').value='Artist B';document.getElementById('audio-archive-form').requestSubmit()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),1);
 await js(`document.getElementById('audio-view-all').click()`);await pause(50);
 const pageSeed=await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').at(-1).args[0].shuffleSeed`);
 await js(`document.getElementById('audio-archive-more').click()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),43);
 assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='audioArchiveSearch').at(-1).args[0].shuffleSeed`),pageSeed);
 await js(`document.querySelector('#audio-archive-results .audio-row-play').click();window.electronAPI.__emitConnection(false)`);await pause(50);assert.equal(await js(`document.getElementById('audio-dock-send').disabled`),true);
 await js(`document.getElementById('audio-dock-save').click();window.electronAPI.__archiveProgress({id:'archive-0',received:50,total:100,phase:'downloading'})`);await pause(50);assert.match(await js(`document.getElementById('audio-archive-status').textContent`),/50%/);
 await js(`document.getElementById('audio-archive-cancel').click()`);await pause(50);assert.match(await js(`document.getElementById('audio-archive-status').textContent`),/canceled/);
 await js(`document.getElementById('audio-dock-save').click();window.electronAPI.__finishArchive()`);await pause(50);assert.match(await js(`document.getElementById('audio-archive-status').textContent`),/Saved MP3s/);
 await js(`document.getElementById('audio-view-saved').click()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-results tr').length`),1);
 await js(`window.savedRow=document.querySelector('#audio-results tr');savedRow.querySelector('.audio-row-play').click()`);
 assert.equal(await js(`window.savedRow.isConnected`),true);
 await js(`window.savedStar=savedRow.querySelector('.audio-star');savedStar.focus({preventScroll:true});savedStar.click()`);await pause(50);
 assert.equal(await js(`savedRow.isConnected&&document.activeElement===savedStar`),true);
 assert.equal(await js(`savedStar.getAttribute('aria-pressed')`),'true');
 await js(`savedStar.click()`);await pause(50);
 assert.equal(await js(`savedRow.isConnected&&document.activeElement===savedStar`),true);
 assert.equal(await js(`savedStar.getAttribute('aria-pressed')`),'false');
 await js(`document.getElementById('audio-dock-details').click()`);await pause(50);assert.equal(await js(`document.getElementById('audio-license').value`),'unverified');
 await js(`document.getElementById('audio-close').click();document.getElementById('audio-pick').click()`);await pause(50);await js(`document.querySelector('.audio-download button').click();document.getElementById('audio-license').value='cc-by';document.getElementById('audio-details-form').requestSubmit()`);await pause(50);assert.match(await js(`document.getElementById('audio-status').textContent`),/attribution text/);
 await js(`document.getElementById('audio-credit').value='CC BY credit';document.getElementById('audio-genre').value='Rock';document.getElementById('audio-mood').value='Happy';document.getElementById('audio-details-form').requestSubmit()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-results tr').length`),2);
 await js(`document.querySelectorAll('#audio-results .audio-star')[1].click();document.getElementById('audio-view-favorites').click()`);await pause(50);assert.equal(await js(`document.querySelectorAll('#audio-archive-results tr').length`),1);
 await js(`document.querySelector('#audio-archive-results .audio-row-play').click();document.getElementById('audio-info-open').click()`);
 assert.equal(await js(`document.getElementById('audio-info-license').textContent`),'Creative Commons · saved by you');
 assert.equal(await js(`document.getElementById('audio-info-credit').textContent`),'CC BY credit');
 assert.equal(await js(`document.getElementById('audio-info-copy').disabled`),false);
 await js(`window.copiedCredit='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedCredit=text;}}});document.getElementById('audio-info-copy').click()`);await pause(50);
 assert.equal(await js(`window.copiedCredit`),'CC BY credit');
 await js(`document.getElementById('audio-info-close').click()`);
 await js(`document.getElementById('audio-view-all').click()`);await pause(50);await js(`document.querySelector('#audio-archive-results .audio-row-play').click()`);await pause(100);
 for(const platform of ['mac','windows']){
  await js(`document.body.classList.remove('platform-mac','platform-windows');document.body.classList.add('platform-${platform}')`);
  for(const size of [[1100,750],[900,700],[600,500]]){
   win.setContentSize(...size);await pause(50);
   for(const collapsed of [false,true]){
    await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);await pause(230);
    assert.equal(await js(`document.documentElement.scrollWidth<=window.innerWidth`),true);
    assert.equal(await js(`document.querySelector('#tab-audio .content-scroll').scrollWidth<=document.querySelector('#tab-audio .content-scroll').clientWidth`),true);
    assert.ok(await js(`document.querySelector('.audio-player-dock').getBoundingClientRect().bottom<=window.innerHeight+1`));
    assert.ok(await js(`document.querySelector('#tab-audio .content-scroll').clientHeight>140`));
    await js(`document.getElementById('audio-info-open').click()`);
    assert.equal(await js(`document.getElementById('audio-info-dialog').getBoundingClientRect().width<=window.innerWidth-30`),true);
    assert.equal(await js(`document.getElementById('audio-info-dialog').scrollWidth<=document.getElementById('audio-info-dialog').clientWidth`),true);
    assert.ok(await js(`document.getElementById('audio-info-dialog').getBoundingClientRect().bottom<=window.innerHeight`));
    await js(`document.getElementById('audio-info-close').click()`);
   }
  }
 }
 await snap('minimum');win.setContentSize(1100,750);await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed'))document.getElementById('sidebar-toggle-btn').click();document.querySelector('#tab-audio .content-scroll').scrollTop=0`);await pause(250);await snap('library');
 await js(`document.getElementById('audio-view-all').focus();document.getElementById('audio-view-all').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);await pause(50);assert.equal(await js(`document.activeElement.id`),'audio-view-favorites');
 await js(`document.querySelector('[data-tab="stock"]').click()`);await pause(50);assert.equal(await js(`document.getElementById('audio-dock-player').paused`),true);
 assert.deepEqual(errors.filter(message=>!message.includes('ERR_BLOCKED_BY_CLIENT')&&!message.includes('Failed to load resource')),[]);
 await js(`window.electronAPI.__useFlakyAudio();document.querySelector('[data-tab="audio"]').click();document.getElementById('audio-view-all').click()`);await pause(100);
 await js(`document.querySelector('#audio-archive-results .audio-row-play').click();window.wasLoading=document.getElementById('audio-dock-play').getAttribute('aria-busy')==='true'`);
 for(let i=0;i<50;i++){if(await js(`document.getElementById('audio-dock-player').error!==null`))break;await pause(50);}
 assert.equal(await js(`window.wasLoading`),true);
 assert.match(await js(`document.getElementById('audio-dock-status').textContent`),/retry/);
 assert.equal(await js(`document.getElementById('audio-dock-play').getAttribute('aria-label')`),'Retry playback');
 await js(`document.getElementById('audio-dock-play').click()`);
 for(let i=0;i<50;i++){if(await js(`document.getElementById('audio-dock-player').currentTime>.2`))break;await pause(50);}
 console.log('Retry fixture:',previewRequests,await js(`(()=>{const a=document.getElementById('audio-dock-player');return {time:a.currentTime,paused:a.paused,error:a.error?.message,status:document.getElementById('audio-dock-status').textContent};})()`));
 assert.ok(await js(`document.getElementById('audio-dock-player').currentTime>.2`));
 assert.equal(previewRequests,2);assert.equal(await js(`document.getElementById('audio-dock-status').textContent`),'');assert.equal(await js(`document.getElementById('audio-archive-status').textContent`),'');
 console.log('PASS: full Electron audio rows, metadata, persistent bottom player, native playback/seek, favorite/community scroll and focus retention, paginated Favorites refresh, saved stars, Staff picks, search/filters/pagination, cancellation/saves/credits and keyboard/minimum Mac/Windows layouts. Native APIs and community server mocked.');
 }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();fs.rmSync(scratch,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
