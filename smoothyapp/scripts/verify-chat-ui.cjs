// Real Electron renderer with mocked providers, files and accounts; no API credits.
const {app,BrowserWindow,session,ipcMain}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-chat-ui-'));
app.setPath('userData',path.join(scratch,'profile'));
const methods=[...fs.readFileSync(path.join(root,'src/preload/index.ts'),'utf8').matchAll(/^  (\w+):/gm)].map(x=>x[1]);
const preload=path.join(scratch,'preload.cjs');fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('electronAPI',Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>ipcRenderer.on(name,(_e,data)=>fn(data)):(...args)=>ipcRenderer.invoke('fixture',name,args)])));`);
let user=null,enabled=true,win,hold=false,release,reject=false,saveCanceled=false,preferenceFail=false,historyWriteFail=false,savedPreferences={studioEnabled:true,naturalWritingEnabled:true,chatWritingPrompt:'Retired natural style'};let attachCanceled=false,attachFail=false,streamFailure=false,replyOverride=null;const attachmentStore=new Map(),historyStore=new Map(),calls=[],events=[],historyEvents=[],errors=[];const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let resetCalls=0;
const writing=JSON.parse(fs.readFileSync(path.join(root,'src/shared/chat-writing.json'),'utf8'));
require('esbuild').buildSync({stdin:{contents:`export {createChatService} from './src/main/chat-service';export {createAppPreferences} from './src/main/app-preferences';export {createChatHistoryService} from './src/main/chat-history';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:path.join(scratch,'service.cjs')});
const {createChatService,createAppPreferences,createChatHistoryService}=require(path.join(scratch,'service.cjs'));
const preferences=createAppPreferences({get:()=>savedPreferences,set:(_key,value)=>{if(preferenceFail)throw Error('Disk full');savedPreferences=value;}},()=>win?.webContents.send('onAppPreferencesChanged',{...preferences.snapshot(),studioEnabled:enabled}),id=>events.push(id));
const cloudHistories=new Map();
const chatHistory=createChatHistoryService({owner:()=>user?.id,get:key=>historyStore.get(key),set:(key,value)=>historyStore.set(key,value),createId:(()=>{let id=0;return()=>`history-${++id}`})(),request:async body=>{
 const rows=cloudHistories.get(user.id)||[];
 if(!body)return {items:rows.map(({id,title,updatedAt,turns})=>({id,title,updatedAt,turnCount:turns.length}))};
 if(historyWriteFail)throw Error('History server unavailable');
 if(body.action==='save'){const existing=rows.find(row=>row.id===body.conversationId),conversation={id:body.conversationId,title:existing?.title||body.turns[0].prompt,createdAt:existing?.createdAt||Date.now(),updatedAt:Date.now(),turns:body.turns};cloudHistories.set(user.id,[conversation,...rows.filter(row=>row.id!==conversation.id)]);historyEvents.push('chat_history_save');return {id:conversation.id};}
 if(body.action==='load'){const conversation=rows.find(row=>row.id===body.conversationId);if(!conversation)throw Error('Missing chat');historyEvents.push('chat_history_restore');return {conversation};}
 if(body.action==='delete'){const next=rows.filter(row=>row.id!==body.conversationId),deleted=next.length!==rows.length;cloudHistories.set(user.id,next);if(deleted)historyEvents.push('chat_history_delete');return {deleted};}
 throw Error('Unexpected transfer');
}});
const service=createChatService({owner:()=>user?.id,enabled:()=>enabled,writingStyle:()=>{const p=preferences.snapshot();return p.chatWritingPrompt||undefined;},track:id=>events.push(id),attachment:id=>{const file=attachmentStore.get(id);if(!file)throw Error('Expired attachment');return file;},request:async(route,body,signal,emit)=>{
 calls.push({route,body});if(reject){reject=false;throw Error('No credits remaining');}
 const reply=replyOverride||'A helpful reply 🌟\n<img src=x onerror=alert(1)>\n\n1. **Next action**\n2. Use `I am`.';
 const cut=reply.indexOf('reply')>0?reply.indexOf('reply'):Math.floor(reply.length/2);
 emit(reply.slice(0,cut));
 if(hold){hold=false;await new Promise(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});}
 else await new Promise(resolve=>setTimeout(resolve,25));
 if(streamFailure){streamFailure=false;throw Error('Connection lost');}
 emit(reply.slice(cut));return reply;
}});
ipcMain.handle('fixture',async(_,name,args)=>{
 try{
   if(name==='chatRun')return {success:true,...await service.run(args[0],delta=>win.webContents.send('onChatChunk',{requestId:args[0].requestId,delta}))};
   if(name==='chatReset'){resetCalls++;service.cancel();attachmentStore.clear();return {success:true};}
   if(name==='chatHistoryList')return user&&enabled?{success:true,items:await chatHistory.list(user.id)}:{success:false,error:'Sign in to use Chat History.'};
   if(name==='chatHistorySave')return user&&enabled?{success:true,...await chatHistory.save(user.id,args[0],args[1])}:{success:false,error:'Sign in to use Chat History.'};
   if(name==='chatHistoryLoad')return user&&enabled?{success:true,conversation:await chatHistory.load(user.id,args[0])}:{success:false,error:'Sign in to use Chat History.'};
   if(name==='chatHistoryDelete')return user&&enabled?{success:true,...await chatHistory.remove(user.id,args[0])}:{success:false,error:'Sign in to use Chat History.'};
  if(name==='chatRelease'){args[0].forEach(id=>attachmentStore.delete(id));return {success:true};}
  if(name==='chatAttach'){if(attachCanceled)return {success:true,canceled:true};if(attachFail)return {success:false,error:'Unreadable document'};const id='file-'+attachmentStore.size,file=args[0]==='image'?{type:'image',name:'frame.png',data:png}:{type:'text',name:'brief.txt',text:'A local brief'};attachmentStore.set(id,file);return {success:true,attachments:[{id,name:file.name,type:file.type,...(file.type==='image'?{preview:file.data}:{characters:file.text.length})}]};}
  if(name==='chatCancel'){service.cancel();return {success:true};}
  if(name==='chatCopy'||name==='chatSave'){calls.push({name,args});return {success:true,canceled:name==='chatSave'&&saveCanceled};}
  if(name==='getAppPreferences')return {...preferences.snapshot(),studioEnabled:enabled};
  if(name==='saveChatWritingPrompt')return {success:true,...preferences.saveChatWritingPrompt(args[0]),studioEnabled:enabled};
  if(name==='resetChatWritingPrompt')return {success:true,...preferences.resetChatWritingPrompt(),studioEnabled:enabled};
  if(name==='setStudioEnabled'){enabled=args[0];if(!enabled)service.cancel();return {success:true,studioEnabled:enabled};}
  const canned={getAuthState:{user},getStatus:{connected:false},getWebsiteConnectionStatus:{connected:false},getAppVersion:'2.0.0',getCaptionModels:[],getCaptionLanguages:[],getCaptionEngine:'cpu',getBridgeStatus:{cep:{installed:true}},assetsGetOutputFolder:'/fixture/assets',audioLibraryState:{success:true,tracks:[],candidates:[],watching:false},audioArchiveSearch:{success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false},stockGetSettings:{pixabayEnabled:true,folder:'/fixture/stock'},getStudioCredits:{success:true,credits:{credits:1950}}};return canned[name]??{};
 }catch(error){return {success:false,error:error.message};}
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,cb)=>cb({cancel:/^https?:/.test(d.url)}));
 win=new BrowserWindow({width:1000,height:740,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const js=code=>win.webContents.executeJavaScript(code),click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await pause(100);};
 const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await pause(30);}throw Error('Timeout '+code);};
 const prompt=async value=>js(`document.getElementById('chat-prompt').value=${JSON.stringify(value)};document.getElementById('chat-prompt').dispatchEvent(new Event('input'));`);
 const proof=process.env.CHAT_REVIEW_DIR||path.join(root,'../docs/reviews/smoothyapp-v2-chat-assets');fs.mkdirSync(proof,{recursive:true});
 const capture=async name=>fs.writeFileSync(path.join(proof,name+'.png'),(await win.webContents.capturePage()).toPNG());
 try{
  await win.loadFile(process.env.CHAT_RENDERER_FILE||path.join(root,'out/renderer/index.html'));await pause(300);
  await click('.nav-item[data-tab="chat"]');assert.equal(await js(`document.getElementById('chat-signin').classList.contains('hidden')`),false);assert.equal(calls.length+events.length,0);
  await click('#chat-signin-btn');assert.equal(await js(`document.getElementById('login-modal').classList.contains('hidden')`),false);await click('#login-close-btn');
   user={id:'a',tier:'free',email:'fixture@example.test'};win.webContents.send('onAuthStateChange',{user});await pause(100);await click('.nav-item[data-tab="chat"]');
   const composerStyle=await js(`(()=>{const read=selector=>{const style=getComputedStyle(document.querySelector(selector));return{background:style.backgroundColor,shadow:style.boxShadow,radius:style.borderRadius,padding:style.padding}};return{photo:read('#tab-photos .photo-composer'),chat:read('#tab-chat .photo-composer')}})()`);
   assert.deepEqual(composerStyle.chat,composerStyle.photo);assert.notEqual(composerStyle.chat.shadow,'none');
  assert.equal(await js(`document.getElementById('chat-model')`),null);assert.equal(await js(`document.getElementById('chat-model-menu')`),null);assert.equal(await js(`document.querySelectorAll('#tab-chat select').length`),0);
  assert.equal(await js(`document.getElementById('chat-empty').textContent`),'Ask anything');
  assert.equal(await js(`document.getElementById('chat-thinking').getAttribute('aria-checked')`),'false');
  assert.equal(await js(`document.querySelector('#tab-chat .photo-composer-note')`),null);assert.equal(await js(`getComputedStyle(document.getElementById('chat-status')).display`),'none');
  assert.equal(await js(`document.getElementById('chat-thinking').getAttribute('role')`),'switch');assert.equal(await js(`document.getElementById('chat-nonthinking')`),null);
  await capture('chat-empty');
  for(let i=0;i<3;i++){
   await prompt('Help with my edit '+i);await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);
   assert.equal('model' in calls.filter(x=>x.route).at(-1).body,false);assert.equal(calls.filter(x=>x.route).at(-1).body.thinking,false);
  }
  assert.equal(calls.filter(x=>x.route).at(-1).body.messages.length,5);assert.equal(events.length,3);assert.equal(historyEvents.filter(id=>id==='chat_history_save').length,3);assert.equal(await js(`document.querySelectorAll('.chat-response img').length`),0);assert.match(await js(`document.getElementById('chat-credits').textContent`),/1,950/);
  const requestsBeforeHistory=calls.filter(x=>x.route).length,historyEventsBeforeList=historyEvents.length;await click('#chat-history');assert.equal(await js(`document.getElementById('chat-history-view').classList.contains('hidden')`),false);assert.equal(await js(`document.getElementById('chat-composer-dock').classList.contains('hidden')`),true);assert.equal(await js(`document.querySelectorAll('.chat-history-item').length`),1);assert.equal(historyEvents.length,historyEventsBeforeList);
  const exportsBeforeHistory=calls.filter(x=>x.name==='chatCopy'||x.name==='chatSave').length;
  for(const action of ['copy','save']){assert.equal(await js(`document.getElementById('chat-${action}').disabled`),true);await click('#chat-'+action);}
  assert.equal(calls.filter(x=>x.name==='chatCopy'||x.name==='chatSave').length,exportsBeforeHistory);
  await click('.chat-history-open');assert.equal(await js(`document.getElementById('chat-history-view').classList.contains('hidden')`),true);assert.equal(await js(`document.querySelectorAll('.chat-turn').length`),3);assert.equal(calls.filter(x=>x.route).length,requestsBeforeHistory);assert.equal(historyEvents.at(-1),'chat_history_restore');
  assert.match(await js(`document.querySelector('.chat-response p').textContent`),/A helpful reply 🌟/);await capture('chat-results');await click('#chat-copy');assert.match(calls.at(-1).args[0],/You: Help/);saveCanceled=true;await click('#chat-save');assert.equal(await js(`document.getElementById('chat-status').textContent`),'');assert.equal(await js(`getComputedStyle(document.getElementById('chat-status')).display`),'none');saveCanceled=false;
  await prompt('New line');await js(`document.getElementById('chat-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}))`);assert.equal(events.length,3);
  await js(`document.getElementById('chat-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(events.length,4);
  reject=true;await prompt('Please help');await click('#chat-send');assert.equal(events.length,4);assert.match(await js(`document.getElementById('chat-status').textContent`),/credits/);assert.notEqual(await js(`getComputedStyle(document.getElementById('chat-status')).display`),'none');assert.equal(await js(`document.getElementById('chat-prompt').value`),'Please help');
  hold=true;await click('#chat-send');assert.equal(await js(`document.getElementById('chat-thinking').disabled`),true);await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(events.length,4);assert.equal(await js(`document.getElementById('chat-status').textContent`),'');
  const resetsBeforeNew=resetCalls;await click('#chat-new');assert.equal(resetCalls-resetsBeforeNew,1);assert.equal(await js(`document.querySelectorAll('.chat-response').length`),0);await click('#chat-history');assert.equal(await js(`document.querySelectorAll('.chat-history-item').length`),1);await click('.chat-history-delete');assert.equal(await js(`document.querySelectorAll('.chat-history-item').length`),0);assert.equal(historyEvents.at(-1),'chat_history_delete');await click('#chat-history');
  hold=true;await prompt('Private message');await click('#chat-send');user={id:'b',tier:'pro',email:'other@example.test'};win.webContents.send('onAuthStateChange',{user});await pause(100);release?.();await pause(100);assert.equal(await js(`document.getElementById('chat-results').textContent`),'');assert.equal(await js(`document.getElementById('chat-prompt').value`),'');assert.equal(events.length,4);
  // Mode changes are local input; sends share the existing completed-reply count.
  for(const thinking of [true,false]){
   await click('#chat-new');
   const before=events.length;if(await js(`document.getElementById('chat-thinking').getAttribute('aria-checked')`)!==String(thinking))await click('#chat-thinking');assert.equal(await js(`document.getElementById('chat-thinking').getAttribute('aria-checked')`),String(thinking));assert.equal(events.length,before);
   await prompt('Mode check');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);
   assert.equal(calls.filter(x=>x.route).at(-1).body.thinking,thinking);assert.equal(events.length,before+1);
  }
  await click('#chat-new');
  // Real chunk arrival, paced word reveal, the same animated Send/Stop control and opposite alignment.
  replyOverride=Array.from({length:100},(_,i)=>'word'+i).join(' ');hold=true;
  const streamEvents=events.length;await prompt('Show me a clear streaming answer');
  const sendBox=await js(`(()=>{const r=document.getElementById('chat-send').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);
  await click('#chat-send');await until(`document.querySelector('.chat-reply').textContent.length>0`);
  assert.equal(events.length,streamEvents);assert.equal(await js(`document.getElementById('chat-send').disabled`),false);
  assert.equal(await js(`document.getElementById('chat-send').getAttribute('aria-label')`),'Stop generating');
  const streaming=await js(`(()=>{const b=document.getElementById('chat-send'),r=b.getBoundingClientRect(),u=document.querySelector('.chat-user-message').getBoundingClientRect(),a=document.querySelector('.chat-response').getBoundingClientRect(),row=document.querySelector('.chat-turn').getBoundingClientRect();return {box:{x:r.x,y:r.y,width:r.width,height:r.height},sendOpacity:getComputedStyle(b.querySelector('.chat-send-icon')).opacity,stopOpacity:getComputedStyle(b.querySelector('.chat-stop-icon')).opacity,transition:getComputedStyle(b.querySelector('svg')).transitionDuration,loader:getComputedStyle(document.querySelector('.chat-loading')).display,dots:document.querySelectorAll('.chat-loading span').length,pulse:getComputedStyle(document.querySelector('.chat-loading span')).animationName,rightGap:row.right-u.right,leftGap:a.left-row.left,rowWidth:row.width,viewWidth:document.getElementById('chat-view-panel').clientWidth,wordAnimation:getComputedStyle(document.querySelector('.chat-word')).animationName};})()`);
  assert.deepEqual(streaming.box,sendBox);assert.equal(streaming.dots,3);assert.equal(streaming.pulse,'chat-loading-pulse');assert.notEqual(streaming.loader,'none');assert.equal(streaming.wordAnimation,'chat-word-reveal');assert.equal(streaming.rightGap,0);assert.equal(streaming.leftGap,0);assert.equal(streaming.rowWidth,Math.min(840,streaming.viewWidth-48));assert.notEqual(streaming.transition,'0s');
  await capture('chat-streaming');const partial=await js(`document.querySelector('.chat-reply').textContent`);assert.ok(partial.length<replyOverride.length);
  release();await pause(25);assert.ok((await js(`document.querySelector('.chat-reply').textContent`)).length<replyOverride.length);await until(`!document.getElementById('chat-prompt').disabled`);
  assert.equal(events.length,streamEvents+1);assert.equal(await js(`document.querySelector('.chat-reply').textContent`),replyOverride);assert.equal(await js(`getComputedStyle(document.querySelector('.chat-loading')).display`),'none');assert.equal(await js(`document.getElementById('chat-send').getAttribute('aria-label')`),'Send message');
  await pause(200);assert.equal(await js(`getComputedStyle(document.querySelector('.chat-send-icon')).opacity`),'1');assert.equal(await js(`getComputedStyle(document.querySelector('.chat-stop-icon')).opacity`),'0');await capture('chat-streamed');
  await click('#chat-new');hold=true;await prompt('Stop this answer');await click('#chat-send');await until(`document.querySelector('.chat-reply').textContent.length>0`);
  const beforeStop=events.length;await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);const frozen=await js(`document.querySelector('.chat-reply').textContent`);assert.ok(frozen.length>0&&frozen.length<replyOverride.length);await pause(200);assert.equal(await js(`document.querySelector('.chat-reply').textContent`),frozen);assert.equal(events.length,beforeStop);assert.match(await js(`document.querySelector('.chat-reply-status').textContent`),/stopped/);await capture('chat-stopped');
  replyOverride=null;await prompt('Continue with a new reply');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(calls.filter(x=>x.route).at(-1).body.messages.length,1); // Partial replies stay out of context.
  await click('#chat-new');replyOverride=Array.from({length:100},(_,i)=>'queued'+i).join(' ');
  const queuedBefore=events.length;await prompt('Stop the visual queue');await click('#chat-send');assert.equal(events.length,queuedBefore+1);assert.equal(await js(`document.getElementById('chat-prompt').disabled`),true);
  await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(events.length,queuedBefore+1);assert.ok((await js(`document.querySelector('.chat-reply').textContent`)).length<replyOverride.length);assert.equal(await js(`document.getElementById('chat-status').textContent`),'');
  replyOverride=null;
  await click('#chat-new');streamFailure=true;const failedBefore=events.length;await prompt('A failing stream');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(events.length,failedBefore);assert.match(await js(`document.querySelector('.chat-reply-status').textContent`),/Connection lost/);assert.equal(await js(`document.getElementById('chat-prompt').value`),'A failing stream');
  await click('#chat-new');
  // Real saved preferences through Settings; these reads/toggles never generate provider work.
  const requestsBefore=calls.filter(x=>x.route).length;
  await click('#settings-btn');assert.equal(await js(`document.getElementById('natural-writing-toggle')`),null);
  assert.equal(await js(`document.getElementById('chat-writing-prompt').value`),writing.defaultPrompt);
  const edit=async text=>js(`document.getElementById('chat-writing-prompt').value=${JSON.stringify(text)};document.getElementById('chat-writing-prompt').dispatchEvent(new Event('input'));`);
  await edit('Keep paragraphs short. Use full forms.');win.webContents.send('onAppPreferencesChanged',{...preferences.snapshot(),studioEnabled:enabled});await pause(100);
  assert.equal(await js(`document.getElementById('chat-writing-prompt').value`),'Keep paragraphs short. Use full forms.');
  assert.equal(preferences.snapshot().chatWritingPrompt,writing.defaultPrompt); // Unsaved edits survive preference events.
  preferenceFail=true;const failedEvents=events.length;await click('#chat-writing-save');
  assert.match(await js(`document.getElementById('chat-writing-status').textContent`),/Disk full/);assert.equal(events.length,failedEvents);
  assert.equal(await js(`document.getElementById('chat-writing-prompt').value`),'Keep paragraphs short. Use full forms.');
  preferenceFail=false;await click('#chat-writing-save');assert.equal(preferences.snapshot().chatWritingPrompt,'Keep paragraphs short. Use full forms.');assert.equal(events.at(-1),'chat_writing_save');
  await edit(' ');assert.equal(await js(`document.getElementById('chat-writing-save').disabled`),false);
  await edit('x'.repeat(4001));assert.equal(await js(`document.getElementById('chat-writing-save').disabled`),true);
  await edit(preferences.snapshot().chatWritingPrompt);await click('#settings-close-btn');
  assert.equal(calls.filter(x=>x.route).length,requestsBefore);
  const naturalEvents=events.length;await prompt('Writing check');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);
  assert.equal(calls.filter(x=>x.route).at(-1).body.writingStyle,'Keep paragraphs short. Use full forms.');assert.equal(events.length,naturalEvents+2);assert.equal(events.at(-1),'chat_natural_reply');
  assert.equal(await js(`document.querySelectorAll('.chat-reply strong').length>0`),true);assert.equal(await js(`document.querySelectorAll('.chat-reply ol li').length`),2);assert.equal(await js(`document.querySelectorAll('.chat-reply img').length`),0);
  await click('#settings-btn');await click('#chat-writing-reset');assert.equal(preferences.snapshot().chatWritingPrompt,writing.defaultPrompt);
  const offEvents=events.length;await click('#settings-close-btn');await prompt('Ordinary reply');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);
  assert.equal('writingStyle' in calls.filter(x=>x.route).at(-1).body,false);assert.equal(events.length,offEvents+1);
  await click('#chat-new');
  attachCanceled=true;const before=calls.filter(x=>x.route).length;await click('#chat-add');await click('#chat-add-file');assert.equal(await js(`document.querySelectorAll('#chat-attachments .chat-attachment').length`),0);
  attachCanceled=false;attachFail=true;await click('#chat-add');await click('#chat-add-file');assert.match(await js(`document.getElementById('chat-status').textContent`),/Unreadable/);attachFail=false;
  await click('#chat-add');await click('#chat-add-file');await click('#chat-add');await click('#chat-add-image');assert.equal(calls.filter(x=>x.route).length,before);assert.equal(await js(`document.querySelectorAll('#chat-attachments .chat-attachment').length`),2);
  await capture('chat-attachments');await click('.chat-attachment-remove');assert.equal(await js(`document.querySelectorAll('#chat-attachments .chat-attachment').length`),1);
  await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(calls.filter(x=>x.route).at(-1).body.messages[0].attachments[0].type,'image');
  await prompt('A follow-up');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.equal(calls.filter(x=>x.route).at(-1).body.messages[0].attachments[0].type,'image');
  await click('#chat-new');await click('#chat-add');await click('#chat-add-file');reject=true;await click('#chat-send');assert.equal(await js(`document.querySelectorAll('#chat-attachments .chat-attachment').length`),1);
  await click('#chat-new');
  for(const platform of ['macos','windows'])for(const size of [[1000,740],[600,500]])for(const collapsed of [false,true]){
   win.setContentSize(...size);await js(`document.body.classList.remove('platform-macos','platform-windows');document.body.classList.add('platform-${platform}');if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);await pause(250);
   const layout=await js(`(()=>{const t=document.getElementById('tab-chat'),c=document.getElementById('chat-composer-dock').getBoundingClientRect(),p=document.getElementById('chat-view-panel').getBoundingClientRect();return {overflow:t.scrollWidth>t.clientWidth,controlsBottom:document.querySelector('.chat-thinking-toggle').getBoundingClientRect().bottom,left:c.left,right:c.right,bottom:c.bottom,top:c.top,viewBottom:p.bottom,width:innerWidth,height:innerHeight};})()`);assert.equal(layout.overflow,false);assert.ok(layout.controlsBottom<=layout.bottom);assert.ok(layout.left>=0&&layout.right<=layout.width+1&&layout.bottom<=layout.height+1&&layout.viewBottom<=layout.top+1);
   await click('#chat-add');const add=await js(`(()=>{const r=document.getElementById('chat-add-menu').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);assert.ok(add.left>=0&&add.right<=size[0]+1&&add.top>=0&&add.bottom<=size[1]+1);await js(`document.getElementById('chat-add-menu').hidePopover()`);await pause(50);
  }
  win.setContentSize(600,500);await capture('chat-narrow');
  for(const platform of ['macos','windows'])for(const size of [[1000,740],[600,500]]) {
   win.setContentSize(...size);await js(`document.body.classList.remove('platform-macos','platform-windows');document.body.classList.add('platform-${platform}')`);
   await click('#settings-btn');await js(`document.getElementById('chat-writing-settings').scrollIntoView({block:'start'})`);await pause(100);
   const box=await js(`(()=>{const r=document.getElementById('chat-writing-prompt').getBoundingClientRect(),body=document.getElementById('settings-body');return {left:r.left,right:r.right,width:innerWidth,overflow:body.scrollWidth>body.clientWidth};})()`);assert.ok(box.left>=0&&box.right<=box.width+1);assert.equal(box.overflow,false);
   await capture('writing-settings-'+platform+'-'+size[0]);await click('#settings-close-btn');
  }
  hold=true;await prompt('Clear this reply when AI is disabled');await click('#chat-send');const aiOffEvents=events.length;
  enabled=false;service.cancel();win.webContents.send('onAppPreferencesChanged',{studioEnabled:false});await pause(100);assert.equal(await js(`getComputedStyle(document.querySelector('[data-channel-group="studio"]')).display`),'none');assert.equal(await js(`document.getElementById('tab-chat').classList.contains('active')`),false);
   enabled=true;win.webContents.send('onAppPreferencesChanged',{studioEnabled:true});await pause(100);await click('.nav-item[data-tab="chat"]');assert.equal(await js(`document.getElementById('chat-results').textContent`),'');assert.equal(events.length,aiOffEvents);
   historyWriteFail=true;const savesBeforeFailure=historyEvents.filter(id=>id==='chat_history_save').length;await prompt('Keep this reply even if history storage fails');await click('#chat-send');await until(`!document.getElementById('chat-prompt').disabled`);assert.match(await js(`document.getElementById('chat-status').textContent`),/Chat History could not be saved/);assert.equal(historyEvents.filter(id=>id==='chat_history_save').length,savesBeforeFailure);historyWriteFail=false;
   assert.deepEqual(errors,[]);console.log('Chat real Electron UI: cloud History save/list/restore/delete/server failure, real streaming/paced words, animated Send/Stop, loading dots, right user/left AI, stopped partial freeze/context exclusion, failed streams, empty custom system prompt/edit/save/clear/failure/unsaved preservation, safe formatting, Thinking, Admin model delegation, attachments/context/credits/cancel/account/AI-off, 16 Chat and 4 Settings layouts passed.');app.exit(0);
 }catch(e){console.error(e);console.error('Renderer errors:',errors);app.exit(1);}
});
