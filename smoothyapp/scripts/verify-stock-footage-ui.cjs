// Full Electron renderer checks with native/Commons/audio fixtures and blocked remote requests.
// Run after npm run build: node node_modules/electron/cli.js scripts/verify-stock-footage-ui.cjs
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
fs.writeFileSync(preload, `const { contextBridge } = require('electron');
const callbacks = {}, calls = []; let resolveDownload,resolveArchive,pixabayEnabled=false;
const api = Object.fromEntries(${JSON.stringify(methods)}.map(name => [name, name.startsWith('on') ? callback => { (callbacks[name] ||= []).push(callback); } : async (...args) => { calls.push({name,args}); return {}; }]));
let audioState={tracks:[],candidates:[],watching:false,watchFolder:'/fixture/Downloads',folder:'/fixture/Audio Library'};
const emitAudio=()=>{for(const callback of callbacks.onAudioLibraryChanged||[])callback(audioState);};
Object.assign(api, {
 getAuthState: async()=>({user:null}),getStatus:async()=>({connected:false}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '1.5.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getShowLogs:async()=>false,getAlwaysOnTop:async()=>false,getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 audioArchiveSearch:async input=>{calls.push({name:'audioArchiveSearch',args:[input]});if(input.query==='error')return {success:false,error:'Archive unavailable'};if(input.query==='empty')return {success:true,tracks:[],total:0,hasMore:false,offset:0};return {success:true,tracks:Array.from({length:input.offset?3:40},(_,i)=>({id:'archive-'+(input.offset+i),title:i===0?'<script>Jazz</script>':'Archive Track '+(input.offset+i),previewUrl:'data:audio/mpeg;base64,AA=='})),total:43,hasMore:input.offset===0,offset:input.offset,category:input.category,mood:input.mood,categories:[{id:'all',label:'All tracks',count:43},{id:'cinematic',label:'Cinematic',count:43},{id:'jazz-blues',label:'Jazz & Blues',count:43},{id:'uncategorized',label:'Uncategorized',count:1}],moods:[{label:'Calm',count:20},{label:'Dramatic',count:23}]};},
 audioArchiveDownload:input=>{calls.push({name:'audioArchiveDownload',args:[input]});return new Promise(resolve=>resolveArchive=resolve);},
 audioArchiveCancel:async()=>{resolveArchive?.({success:true,canceled:true});return {success:true};},
 __archiveProgress:data=>{for(const callback of callbacks.onAudioArchiveProgress||[])callback(data);},
 __finishArchive:()=>{const track={id:'saved-archive',title:'Archive Track',artist:'',license:'unverified',credit:'Archive license not supplied',archiveId:'archive-0',previewUrl:'data:audio/mpeg;base64,AA=='};audioState.tracks.push(track);emitAudio();resolveArchive?.({success:true,...audioState,savedId:track.id});},
 audioLibraryState:async()=>({success:true,...audioState}),
 audioLibraryOpen:async()=>{calls.push({name:'audioLibraryOpen',args:[]});audioState.watching=true;return {success:true,...audioState};},
 audioLibraryStop:async()=>{audioState.watching=false;emitAudio();return {success:true};},
 audioLibrarySelectFolder:async()=>{audioState.watchFolder='/fixture/New Downloads';return {success:true,...audioState};},
 audioLibraryPick:async()=>{audioState.candidates=[{id:'pending-1',name:'<script>Track</script> - Artist.mp3'}];return {success:true,...audioState};},
 audioLibraryDismiss:async id=>{audioState.candidates=audioState.candidates.filter(item=>item.id!==id);return {success:true};},
 audioLibraryKeep:async options=>{calls.push({name:'audioLibraryKeep',args:[options]});if(options.license==='cc-by'&&!options.credit.trim())return {success:false,error:'Paste the attribution text from YouTube'};audioState.candidates=[];audioState.tracks.push({...options,id:'saved-1',previewUrl:'data:audio/mpeg;base64,AA=='});return {success:true,...audioState};},
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
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async()=>{
 const failures=[];
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
 const win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')failures.push(event.message);});
 try {
 await win.loadFile(path.join(root,'out/renderer/index.html'));await pause(150);
 const js=code=>win.webContents.executeJavaScript(code);
 await js(`document.querySelector('[data-tab="stock"]').click()`);
 assert.equal(await js(`document.getElementById('stock-search-btn').disabled`),false);
 assert.equal(await js(`document.getElementById('stock-provider').value`),'all');
 assert.equal(await js(`document.getElementById('stock-powered').classList.contains('hidden')`),true);
 await js(`document.getElementById('stock-provider').value='commons';document.getElementById('stock-provider').dispatchEvent(new Event('change'))`);
 const captures=path.resolve(root,'..','docs/reviews/smoothyapp-1.5.1');fs.mkdirSync(captures,{recursive:true});
 const snap=async name=>{await pause(600);fs.writeFileSync(path.join(captures,name+'.png'),(await win.webContents.capturePage()).toPNG());};
 await js(`document.getElementById('stock-query').value='nature';document.getElementById('stock-orientation').value='portrait';document.getElementById('stock-size').value='medium';document.getElementById('stock-search-form').requestSubmit()`);await pause(50);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),6);
 assert.equal(await js(`document.querySelector('.stock-result-info a').textContent`),'<script>Ocean</script> ↗');
 assert.equal(await js(`document.querySelectorAll('#stock-results script').length`),0);
 const query=await js(`window.electronAPI.__calls().filter(call=>call.name==='stockSearch').at(-1).args[0]`);
 assert.equal(query.orientation,'portrait');assert.equal(query.size,'medium');
 await js(`document.querySelector('.stock-result-info a').click();document.querySelector('.stock-powered').click()`);
 assert.equal((await js(`window.electronAPI.__calls().filter(call=>call.name==='openExternal')`)).length,2);
 await snap('stock-results');
 await js(`document.querySelector('.stock-thumbnail').click()`);await pause(30);
 assert.equal(await js(`document.getElementById('stock-premiere-btn').disabled`),true);
 assert.equal(await js(`document.getElementById('stock-resolution').value`),'10');
 await js(`window.electronAPI.__emitConnection(true)`);await pause(30);
 assert.equal(await js(`document.getElementById('stock-premiere-btn').disabled`),false);
 await snap('stock-preview');
 await js(`document.getElementById('stock-download-btn').click()`);await pause(20);
 assert.equal(await js(`document.getElementById('stock-resolution').disabled`),true);
 await js(`window.electronAPI.__progress({received:50,total:100})`);
 assert.match(await js(`document.getElementById('stock-action-status').textContent`),/50%/);
 await js(`document.getElementById('stock-cancel-btn').click()`);await pause(20);
 assert.match(await js(`document.getElementById('stock-action-status').textContent`),/canceled/);
 await js(`document.getElementById('stock-premiere-btn').click()`);await pause(20);
 await js(`window.electronAPI.__progress({importing:true})`);
 assert.equal(await js(`document.getElementById('stock-cancel-btn').classList.contains('hidden')`),true);
 await js(`window.electronAPI.__finishDownload({success:true,imported:true,path:'/fixture/video.mp4'})`);await pause(20);
 assert.match(await js(`document.getElementById('stock-action-status').textContent`),/Imported into Premiere/);
 for(const platform of ['mac','windows']){
  await js(`document.body.classList.remove('platform-mac','platform-windows');document.body.classList.add('platform-${platform}')`);
  for(const size of [[900,700],[600,500]]){
   win.setContentSize(...size);await pause(50);
   for(const collapsed of [false,true]){
    await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);await pause(230);
    assert.equal(await js(`document.documentElement.scrollWidth<=window.innerWidth`),true);
    assert.equal(await js(`document.querySelector('#tab-stock .content-scroll').scrollWidth<=document.querySelector('#tab-stock .content-scroll').clientWidth`),true);
   }
  }
 }
 await snap('stock-minimum');
 await js(`document.getElementById('stock-close-preview').click();document.getElementById('stock-load-more').click()`);await pause(30);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),12);
 assert.equal(await js(`document.getElementById('stock-load-more').classList.contains('hidden')`),true);
 await js(`document.getElementById('stock-change-folder').click()`);await pause(20);
 assert.equal(await js(`document.getElementById('stock-folder-path').textContent`),'/fixture/New Stock Folder');
 for(const query of ['empty','error']){
  await js(`document.getElementById('stock-query').value='${query}';document.getElementById('stock-search-form').requestSubmit()`);await pause(30);
  assert.match(await js(`document.getElementById('stock-search-status').textContent`),query==='empty'?/No CC0/:/limit reached/);
 }
 for(const provider of ['archive','nasa']){
  await js(`document.getElementById('stock-query').value='nature';document.getElementById('stock-provider').value='${provider}';document.getElementById('stock-provider').dispatchEvent(new Event('change'))`);await pause(40);
  const request=await js(`window.electronAPI.__calls().filter(call=>call.name==='stockSearch').at(-1).args[0]`);
  assert.equal(request.provider,provider);assert.equal(request.page,1);assert.equal(await js(`document.querySelectorAll('.stock-result').length`),6);
  assert.match(await js(`document.getElementById('stock-source-status').textContent`),provider==='archive'?/Internet Archive/:/NASA/);
  assert.equal(await js(`document.getElementById('stock-size').disabled`),provider==='nasa');
  if(provider==='nasa')assert.equal(request.size,'');
  await js(`document.querySelector('.stock-thumbnail').click()`);await pause(20);
  assert.equal(await js(`document.querySelector('.stock-result').classList.contains('selected')`),true);
  assert.match(await js(`document.getElementById('stock-preview-license').href`),provider==='nasa'?/nasa.gov\/nasa-brand-center/:/creativecommons.org/);
  if(provider==='nasa'){
   assert.equal(await js(`document.getElementById('stock-resolution').selectedOptions[0].textContent`),'Medium MP4');
   assert.match(await js(`document.getElementById('stock-preview-title').textContent`),/Duration unavailable/);
  }
  await js(`document.getElementById('stock-download-btn').click()`);await pause(20);
  assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='stockDownload').at(-1).args[0].videoId`),provider+':clip-0');
  await js(`window.electronAPI.__finishDownload({success:true,path:'/fixture/new-source.mp4'})`);await pause(20);
  await snap('stock-'+provider);
 }
 win.setContentSize(900,700);
 await js(`document.getElementById('stock-close-preview').click();document.querySelector('#tab-stock .content-scroll').scrollTop=0`);await snap('stock-sources');
 await js(`document.getElementById('stock-orientation').value='';document.getElementById('stock-provider').value='all';document.getElementById('stock-provider').dispatchEvent(new Event('change'))`);await pause(40);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),18);
 const labels=await js(`Array.from(document.querySelectorAll('.stock-result-info span')).slice(0,3).map(node=>node.textContent)`);
 assert.match(labels[0],/Wikimedia Commons/);assert.match(labels[1],/Internet Archive/);assert.match(labels[2],/NASA/);
 assert.equal(await js(`document.getElementById('stock-size').disabled`),false);
 assert.equal(await js(`document.getElementById('stock-powered').classList.contains('hidden')`),true);
 await js(`document.querySelectorAll('.stock-thumbnail')[2].click()`);await pause(20);
 assert.match(await js(`document.getElementById('stock-preview-credit').textContent`),/NASA/);
 await js(`document.getElementById('stock-download-btn').click()`);await pause(20);
 assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='stockDownload').at(-1).args[0].videoId`),'nasa:clip-0');
 await js(`window.electronAPI.__finishDownload({success:true,path:'/fixture/mixed-nasa.mp4'})`);await pause(20);
 await js(`document.getElementById('stock-close-preview').click();document.getElementById('stock-load-more').click()`);await pause(40);
 const allRequests=await js(`window.electronAPI.__calls().filter(call=>call.name==='stockSearch'&&call.args[0].provider==='all')`);
 assert.equal(allRequests.at(-1).args[0].page,2);
 assert.equal(allRequests.at(-1).args[0].sourceCursors.commons.cursor,40);
 assert.equal(allRequests.at(-1).args[0].sourceCursors.archive.page,2);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),36);
 assert.equal(await js(`document.getElementById('stock-load-more').classList.contains('hidden')`),true);
 for(const query of ['partial','empty','error']){
  await js(`document.getElementById('stock-query').value='${query}';document.getElementById('stock-search-form').requestSubmit()`);await pause(40);
  assert.match(await js(`document.getElementById('stock-search-status').textContent`),query==='partial'?/NASA could not be searched/:query==='empty'?/No matching/:/limit reached/);
  if(query==='partial')assert.equal(await js(`document.querySelectorAll('.stock-result').length`),12);
 }
 await js(`document.getElementById('stock-query').value='nature';document.getElementById('stock-search-form').requestSubmit()`);await pause(40);
 for(const platform of ['mac','windows'])for(const size of [[900,700],[600,500]]){
  win.setContentSize(...size);await pause(50);
  await js(`document.body.classList.remove('platform-mac','platform-windows');document.body.classList.add('platform-${platform}')`);
  for(const collapsed of [false,true]){
   await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);await pause(230);
   assert.equal(await js(`document.querySelector('#tab-stock .content-scroll').scrollWidth<=document.querySelector('#tab-stock .content-scroll').clientWidth`),true);
  }
 }
 await snap('stock-all-minimum');win.setContentSize(900,700);
 await js(`if(document.querySelector('.app-container').classList.contains('sidebar-collapsed'))document.getElementById('sidebar-toggle-btn').click();document.querySelector('#tab-stock .content-scroll').scrollTop=0`);await snap('stock-all-sources');
 assert.equal(await js(`document.getElementById('stock-pixabay-key')`),null);
 assert.equal(await js(`document.getElementById('stock-provider').querySelector('[value="pixabay"]').hidden`),true);
 // Simulate availability for provider-specific action checks.
 await js(`window.electronAPI.__enablePixabay();document.getElementById('stock-provider').querySelector('[value="pixabay"]').hidden=false;document.getElementById('stock-provider').value='pixabay';document.getElementById('stock-provider').dispatchEvent(new Event('change'))`);await pause(40);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),6);
 await snap('stock-pixabay-shared');
 await js(`document.querySelector('.stock-thumbnail').click();document.getElementById('stock-download-btn').click()`);await pause(20);
 assert.equal(await js(`window.electronAPI.__calls().filter(call=>call.name==='stockDownload').at(-1).args[0].videoId`),'pixabay:clip-0');
 await js(`window.electronAPI.__finishDownload({success:true,path:'/fixture/pixabay.mp4'})`);await pause(20);
 await js(`document.getElementById('stock-close-preview').click();document.getElementById('stock-provider').value='all';document.getElementById('stock-provider').dispatchEvent(new Event('change'))`);await pause(40);
 assert.equal(await js(`document.querySelectorAll('.stock-result').length`),24);
 const unexpected=failures.filter(message=>!message.includes('ERR_BLOCKED_BY_CLIENT')&&!message.includes('fixture.webm'));
 assert.deepEqual(unexpected.filter(message=>!message.includes('data:audio')&&!message.includes('MEDIA_ERR')),[]);
 const officialPreload=path.join(scratch,'official-preload.cjs');
 fs.writeFileSync(officialPreload,fs.readFileSync(preload,'utf8').replace('pixabayEnabled=false','pixabayEnabled=true'));
 const official=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload:officialPreload,contextIsolation:true,nodeIntegration:false}});
 try {
  await official.loadFile(path.join(root,'out/renderer/index.html'));await pause(150);
  const run=code=>official.webContents.executeJavaScript(code);
  await run(`document.querySelector('[data-tab="stock"]').click()`);
  assert.equal(await run(`document.getElementById('stock-pixabay-key')`),null);
  assert.equal(await run(`document.getElementById('stock-provider').querySelector('[value="pixabay"]').hidden`),false);
  assert.match(await run(`document.getElementById('stock-source-note').textContent`),/Pixabay/);
  await run(`document.getElementById('stock-query').value='nature';document.getElementById('stock-search-form').requestSubmit()`);await pause(40);
  assert.equal(await run(`document.querySelectorAll('.stock-result').length`),24);
  fs.writeFileSync(path.join(captures,'stock-shared-all.png'),(await official.webContents.capturePage()).toPNG());
 } finally {official.destroy();}

 console.log('PASS: All sources + individual providers full renderer: mixed source labels, source cursor pagination, provider failure warnings, filters, safe credits, external links, preview, disconnected/connected actions, download/cancel/import progress, folder selection, empty/error states; Audio Library renderer has dedicated checks in verify-audio-ui.cjs; 900x700 and 600x500, Mac/Windows, expanded/collapsed.');
 }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.quit();}
});
