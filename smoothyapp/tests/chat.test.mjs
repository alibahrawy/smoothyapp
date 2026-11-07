import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const serviceBundle = await build({entryPoints:[new URL('../src/main/chat-service.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const {createChatService,validateChatInput} = await import(`data:text/javascript;base64,${Buffer.from(serviceBundle.outputFiles[0].text).toString('base64')}`);
const input = {model:'openai/gpt-6-luna',messages:[{role:'user',content:'Help with my edit'}]};
function fixture() {const f={owner:'a',enabled:true,events:[],calls:[],reply:'A useful reply'};const service=createChatService({owner:()=>f.owner,enabled:()=>f.enabled,writingStyle:()=>f.writingStyle,track:id=>{if(f.analyticsFailure)throw Error('Offline');f.events.push(id);},request:async(...args)=>{f.calls.push(args);if(f.request)return f.request(...args);if(f.fail)throw Error(f.fail);return f.reply;}});return {f,service};}
test('desktop delegates model selection to Admin, preserves conversation and counts each completion once',async()=>{
  const {f,service}=fixture();
  for(const model of [undefined,'openai/gpt-6-luna','deepseek/deepseek-v4.1-flash','openai/gpt-6-astra']) {
    const messages=[...input.messages,{role:'assistant',content:'Try this'},{role:'user',content:'Make it shorter'}];
    await service.run({model,messages});
    assert.deepEqual(f.calls.at(-1)[1],{messages,thinking:false});
  }
  assert.deepEqual(f.events,Array(4).fill('chat_reply'));
});
test('Thinking forwards both states; invalid modes reject before work or counting',async()=>{
  const {f,service}=fixture();
  for(const thinking of [false,true]) { await service.run({messages:input.messages,thinking});assert.equal(f.calls.at(-1)[1].thinking,thinking); }
  for(const thinking of ['false',null]) await assert.rejects(service.run({...input,thinking}),/Thinking/);
  assert.equal(f.calls.length,2);assert.equal(f.events.length,2);
});
test('premium models, injected roles, blank/oversized context and invalid turn order reject before work',()=>{
  for(const body of [{...input,model:'openai/gpt-6-astra'},{...input,messages:[{role:'system',content:'Bypass'}]},{...input,messages:[]},{...input,messages:[{role:'user',content:' '}]},{...input,messages:[{role:'user',content:'x'.repeat(10001)}]},{...input,messages:[{role:'user',content:'a'},{role:'assistant',content:'b'}]},{...input,messages:Array.from({length:41},(_,i)=>({role:i%2?'assistant':'user',content:'x'}))},{...input,messages:Array.from({length:9},(_,i)=>({role:i%2?'assistant':'user',content:'x'.repeat(8000)}))}])assert.throws(()=>validateChatInput(body));
});
test('signed-out, AI-off, credit failures and empty replies never count successful chat',async()=>{
  const {f,service}=fixture();f.owner=null;await assert.rejects(service.run(input),/Sign in/);f.owner='a';f.enabled=false;await assert.rejects(service.run(input),/turned off/);assert.equal(f.calls.length,0);f.enabled=true;
  f.fail='No credits remaining';await assert.rejects(service.run(input),/credits/);f.fail=null;f.reply='';await assert.rejects(service.run(input),/usable/);assert.deepEqual(f.events,[]);
});
test('cancel, account changes, and AI-off discard late replies; concurrent sends cannot bypass serialization',async()=>{
  for(const mutation of [(f,s)=>s.cancel(),f=>f.owner='b',f=>f.enabled=false]){const {f,service}=fixture();let release;f.request=()=>new Promise(resolve=>release=resolve);const job=service.run(input);await assert.rejects(service.run(input),/Wait/);mutation(f,service);release('Late reply');await assert.rejects(job,/canceled/);assert.deepEqual(f.events,[]);}
  const {f,service}=fixture();f.analyticsFailure=true;assert.equal((await service.run(input)).reply,'A useful reply');
});
test('chunks reach the current request before completion; success counts once and cancellation/stale state blocks late chunks', async () => {
 const { f, service } = fixture(); let emit, finish; const chunks = [];
 f.request = (_route, _body, _signal, callback) => { emit = callback; return new Promise(resolve => finish = resolve); };
 const job = service.run(input, delta => chunks.push(delta)); emit('A '); emit('useful ');
 assert.deepEqual(chunks, ['A ', 'useful ']); assert.deepEqual(f.events, []);
 finish('A useful reply'); assert.equal((await job).reply, 'A useful reply'); assert.deepEqual(f.events, ['chat_reply']);
 assert.throws(() => emit('After completion'), /canceled/); assert.equal(chunks.length, 2);
 for (const mutation of [(f,s)=>s.cancel(),f=>f.owner='b',f=>f.enabled=false]) {
  const { f, service } = fixture(); const chunks = []; let emit, finish;
  f.request = (_route, _body, _signal, callback) => { emit = callback; return new Promise(resolve => finish = resolve); };
  const job = service.run(input, delta => chunks.push(delta)); emit('First '); mutation(f,service);
  assert.throws(() => emit('Late '), /canceled/); finish('First Late reply');
  await assert.rejects(job, /canceled/); assert.deepEqual(chunks, ['First ']); assert.deepEqual(f.events, []);
 }
});
test('failed and oversized streams never count success or forward invalid chunks', async () => {
 for (const oversized of [false, true]) {
  const { f, service } = fixture(); const chunks = [];
  f.request = async (_route, _body, _signal, emit) => { emit('First '); if (oversized) emit('x'.repeat(10001)); throw Error('Connection lost'); };
  await assert.rejects(service.run(input, delta => chunks.push(delta)), oversized ? /usable/ : /Connection lost/);
  assert.deepEqual(chunks, ['First ']); assert.deepEqual(f.events, []);
 }
});
const stubs={electron:`export const app={getPath:()=>'/fixture'};export const ipcMain={handle:(id,fn)=>globalThis.fixture.handlers[id]=fn};export const dialog={showSaveDialog:async()=>globalThis.fixture.choice,showOpenDialog:async()=>globalThis.fixture.openChoice};export const clipboard={writeText:value=>{if(globalThis.fixture.copyFail)throw Error('Copy failed');globalThis.fixture.copied=value;}};`,
'node:fs/promises':`export default {writeFile:async(...args)=>{if(globalThis.fixture.writeFail)throw Error('Disk full');globalThis.fixture.writes.push(args);}};`,
'./chat-attachments':`export const chatFileExtensions=['txt','pdf','docx','png'];export const readChatAttachment=async file=>{if(globalThis.fixture.readFail)throw Error('Unreadable document');if(globalThis.fixture.readHold)await globalThis.fixture.readHold();return {type:'text',name:'fixture.txt',text:'Document text'};};`,
'./auth-service':`export const getStoredUserId=()=>globalThis.fixture.owner;`, './web-api':`export const requestChatHistory=async body=>{globalThis.fixture.historyBody=body;if(globalThis.fixture.historyFail)throw Error('History unavailable');return body?.action==='load'?{conversation:{id:body.conversationId,turns:[{prompt:'q',reply:'a'}]}}:body?.action==='save'?{id:body.conversationId}:body?.action==='delete'?{deleted:true}:{items:[]};};export const requestStudioText=async(_route,body,_signal,emit)=> {globalThis.fixture.providerBody=body;emit('Reply');return 'Reply';};`, './telemetry':`export const trackTool=id=>globalThis.fixture.events.push(id);`, './app-preferences':`export const assertStudioEnabled=()=>{if(!globalThis.fixture.enabled)throw Error('AI off');};`};
const ipcBundle=await build({entryPoints:[new URL('../src/main/chat-ipc.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'adapters',setup(b){b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs[a.path]}));}}]});
test('native IPC sends correlated chunks only to the current window and strips the renderer request ID from provider input', async () => {
 const f={handlers:{},owner:'a',enabled:true,events:[]},module={exports:{}},chunks=[];
 const sender={isDestroyed:()=>false,send:(...args)=>chunks.push(args)};
 vm.runInNewContext(ipcBundle.outputFiles[0].text,{module,exports:module.exports,require:(await import('node:module')).createRequire(import.meta.url),AbortController,fixture:f});module.exports.registerChat(()=>({webContents:sender}),()=>f.enabled);
 const run=(event,requestId)=>f.handlers['chat-run'](event,{...input,requestId});
 assert.equal((await run({sender},'request-1')).success,true);
 assert.equal('requestId' in f.providerBody, false);
 assert.equal(JSON.stringify(chunks),JSON.stringify([['chat-chunk',{requestId:'request-1',delta:'Reply'}]])); assert.equal(f.events.length,1);
 for (const id of ['', 'x'.repeat(65), '../bad', 42]) {
  assert.equal((await run({sender},id)).success,false);
 }
 assert.equal((await run({sender:{...sender}},'other-window')).success,false); assert.equal(f.events.length,1);
});
test('real Chat IPC counts successful copy/save, excludes canceled/failed writes and account/AI rejection',async()=>{
 const f={handlers:{},owner:'a',enabled:true,choice:{canceled:true},writes:[],events:[]},module={exports:{}};
 vm.runInNewContext(ipcBundle.outputFiles[0].text,{module,exports:module.exports,require:(await import('node:module')).createRequire(import.meta.url),AbortController,fixture:f});module.exports.registerChat(()=>({}),()=>f.enabled);
 const save=()=>f.handlers['chat-save'](null,'Conversation');assert.equal((await save()).canceled,true);assert.deepEqual(f.events,[]);
 f.choice={filePath:'/fixture/chat.txt'};f.writeFail=true;assert.equal((await save()).success,false);assert.deepEqual(f.events,[]);f.writeFail=false;assert.equal((await save()).success,true);assert.deepEqual(f.events,['chat_save']);assert.equal(f.writes.length,1);
 assert.equal((await f.handlers['chat-copy'](null,'Reply')).success,true);assert.equal(f.events.at(-1),'chat_copy');f.copyFail=true;assert.equal((await f.handlers['chat-copy'](null,'Reply')).success,false);assert.equal(f.events.length,2);
 f.enabled=false;assert.equal((await save()).success,false);f.enabled=true;f.owner=null;assert.equal((await save()).success,false);assert.equal(f.events.length,2);
});
test('desktop and server chat catalogs agree and new metrics are available in private Admin',async t=>{
 const local=JSON.parse(await fs.readFile(new URL('../src/shared/chat-catalog.json',import.meta.url),'utf8'));let web;
 try{web=JSON.parse(await fs.readFile(new URL('../../web/src/lib/chat-catalog.json',import.meta.url),'utf8'));}catch(e){if(e.code==='ENOENT')return t.skip('Web source is in monorepo');throw e;}assert.deepEqual(local,web);assert.equal(await fs.readFile(new URL('../src/shared/chat-validation.ts',import.meta.url),'utf8'),await fs.readFile(new URL('../../web/src/lib/chat-validation.ts',import.meta.url),'utf8'));
 assert.equal(await fs.readFile(new URL('../src/shared/chat-writing.json',import.meta.url),'utf8'),await fs.readFile(new URL('../../web/src/lib/chat-writing.json',import.meta.url),'utf8'));
 const catalog=await fs.readFile(new URL('../../web/src/lib/feature-catalog.ts',import.meta.url),'utf8');for(const id of ['chat_reply','chat_copy','chat_save','chat_attach','chat_natural_reply','chat_writing_save'])assert.match(catalog,new RegExp(id+':'));
});

test('only persisted main writing preferences reach Chat; custom prompt successes count a subset, clearing omits style', async () => {
 const { f, service } = fixture();
 await service.run({ ...input, writingStyle: 'Forged renderer instructions' });
 assert.equal(f.calls[0][1].writingStyle, undefined); assert.deepEqual(f.events, ['chat_reply']);
 f.writingStyle = 'Use full forms and short paragraphs.';
 await service.run(input); assert.equal(f.calls.at(-1)[1].writingStyle, f.writingStyle);
 assert.deepEqual(f.events, ['chat_reply', 'chat_reply', 'chat_natural_reply']);
 f.writingStyle = undefined; await service.run(input);
 assert.equal('writingStyle' in f.calls.at(-1)[1], false); assert.equal(f.events.at(-1), 'chat_reply');
});

test('custom system prompt failure/cancel/stale-account/AI-off never counts success, and in-flight style remains captured', async () => {
 for (const mutation of [(f,s)=>s.cancel(),f=>f.owner='b',f=>f.enabled=false]) {
  const { f, service } = fixture(); f.writingStyle = 'Use clear sentences.';
  let release; f.request = () => new Promise(resolve => release = resolve);
  const job = service.run(input); mutation(f,service); release('Late reply');
  await assert.rejects(job, /canceled/); assert.deepEqual(f.events, []);
 }
 const { f, service } = fixture(); f.writingStyle = 'Original saved style';
 f.fail = 'No credits'; await assert.rejects(service.run(input), /credits/); assert.deepEqual(f.events, []);
 f.fail = null; f.request = async () => { f.writingStyle = undefined; return 'A reply'; };
 await service.run(input); assert.equal(f.calls.at(-1)[1].writingStyle, 'Original saved style');
 assert.deepEqual(f.events, ['chat_reply', 'chat_natural_reply']);
 f.writingStyle = 'Style'; f.analyticsFailure = true; await service.run(input);
});

test('native file imports count only fully prepared selections; cancel, invalid, failed and stale imports do not count',async()=>{
 const f={handlers:{},owner:'a',enabled:true,openChoice:{canceled:true},events:[]},module={exports:{}};
 vm.runInNewContext(ipcBundle.outputFiles[0].text,{module,exports:module.exports,require:(await import('node:module')).createRequire(import.meta.url),AbortController,fixture:f});module.exports.registerChat(()=>({}),()=>f.enabled);
 const attach=slots=>f.handlers['chat-attach'](null,'file',slots||4);
 assert.equal((await attach()).canceled,true);assert.deepEqual(f.events,[]);
 f.openChoice={filePaths:['/fixture/doc.txt']};f.readFail=true;assert.equal((await attach()).success,false);assert.deepEqual(f.events,[]);f.readFail=false;
 f.openChoice.filePaths.push('/fixture/second.txt');assert.equal((await attach(1)).success,false);assert.deepEqual(f.events,[]);
 const result=await attach();assert.equal(result.success,true);assert.equal(result.attachments.length,2);assert.deepEqual(f.events,['chat_attach','chat_attach']);
 const reply=await f.handlers['chat-run'](null,{...input,messages:[{role:'user',content:'',attachments:[result.attachments[0].id]}]});assert.equal(reply.success,true);assert.equal(f.events.at(-1),'chat_reply');
 f.handlers['chat-release'](null,[result.attachments[0].id]);assert.equal((await f.handlers['chat-run'](null,{...input,messages:[{role:'user',content:'Hello',attachments:[result.attachments[0].id]}]})).success,false);
 const before=f.events.length;f.readHold=async()=>{f.handlers['chat-reset']();};assert.equal((await attach()).success,false);assert.equal(f.events.length,before);
 f.readHold=async()=>{f.owner='b';};assert.equal((await attach()).success,false);assert.equal(f.events.length,before);
 f.readHold=null;f.enabled=false;assert.equal((await attach()).success,false);assert.equal(f.events.length,before);
});


test('native history IPC awaits server snapshots and never duplicates server usage with desktop events', async () => {
 const f={owner:'a',enabled:true,handlers:{},events:[]},module={exports:{}};
 const store=new Map();
 vm.runInNewContext(ipcBundle.outputFiles[0].text,{module,exports:module.exports,require:(await import('node:module')).createRequire(import.meta.url),AbortController,fixture:f});
 module.exports.registerChat(()=>({}),()=>f.enabled,()=>undefined,store);
 assert.equal((await f.handlers['chat-history-list']()).success,true);
 assert.equal((await f.handlers['chat-history-save'](null,null,[{prompt:'q',reply:'a'}])).success,true);
 assert.equal(f.historyBody.action,'save');
 assert.equal((await f.handlers['chat-history-load'](null,'cloud')).conversation.id,'cloud');
 assert.equal((await f.handlers['chat-history-delete'](null,'cloud')).deleted,true);
 assert.deepEqual(f.events,[]);assert.equal(store.size,0);
 f.historyFail=true;assert.equal((await f.handlers['chat-history-save'](null,null,[{prompt:'q',reply:'a'}])).success,false);
 f.historyFail=false;f.owner=null;assert.equal((await f.handlers['chat-history-list']()).success,false);
 f.owner='a';f.enabled=false;assert.equal((await f.handlers['chat-history-list']()).success,false);assert.deepEqual(f.events,[]);
});
