import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import vm from 'node:vm';
const bundle = await build({ stdin: { contents: "export * from './web-api';export * from './app-preferences';", resolveDir: new URL('../src/main', import.meta.url).pathname, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'auth', setup(builder) {
  builder.onResolve({filter:/^\.\/auth-service$/}, () => ({path:'auth',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'}, () => ({contents: "export const getStoredUserId=()=>globalThis.fixture.user;export const getAuthHeaders=()=>({'Content-Type':'application/json',Authorization:'Bearer fixture-token'});"}));
} }] });
function fixture() {
  const f = { user: 'a', enabled: true, calls: [], response: () => new Response('{"titles":["A useful idea"]}') }, module = {exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text, {module, exports:module.exports, process:{env:{}}, Buffer, URL, AbortSignal, AbortController, TextDecoder, fetch: async (...args) => {f.calls.push(args);return f.response();}, fixture:f});
  module.exports.configureStudioPreference(() => f.enabled); return {f, api:module.exports};
}
test('native Studio text uses signed fixed endpoints and reads streamed Unicode without exposing credentials to the result', async () => {
  const {f,api} = fixture(); const bytes = new TextEncoder().encode('A 🌟 idea');
  f.response = () => new Response(new ReadableStream({start(c) {c.enqueue(bytes.slice(0,4));c.enqueue(bytes.slice(4));c.close();}}));
  assert.equal(await api.requestStudioText('/api/analyze', {analysisMode:'title',subtitleText:'Speech'}, new AbortController().signal), 'A 🌟 idea');
  assert.equal(f.calls[0][0], 'https://smoothyedit.com/api/analyze'); assert.equal(f.calls[0][1].headers.Authorization, 'Bearer fixture-token'); assert.match(f.calls[0][1].body, /analysisMode/);
  await assert.rejects(api.requestStudioText('https://evil.test', {}, new AbortController().signal), /Unsupported/); assert.equal(f.calls.length,1);
});
test('all cloud AI entrypoints reject disabled settings before fetching; free local services are not involved', async () => {
  const {f,api} = fixture(); f.enabled=false;
  for (const request of [()=>api.getCredits(),()=>api.listShortsHistory(),()=>api.saveShortsToHistory('{}'),()=>api.getYoutubeTranscript('https://youtube.com/watch?v=example'),()=>api.analyzeShorts('Text'),()=>api.requestPhotoRoute('/api/generate-reaction'),()=>api.requestStudioText('/api/analyze',{},new AbortController().signal),()=>api.listStudioHistory('title'),()=>api.saveStudioHistory('title','Draft','Transcript')]) await assert.rejects(request(), /turned off/);
  assert.equal(f.calls.length,0);
});
test('401/402 errors have no automatic retries; oversized drafts cancel the stream', async () => {
  for (const [code,message] of [[401,'Sign in'],[402,'No credits remaining']]) {
    const {f,api}=fixture(); f.response=()=>new Response(JSON.stringify({error:'No credits remaining'}),{status:code});
    await assert.rejects(api.requestStudioText('/api/analyze',{},new AbortController().signal),new RegExp(message)); assert.equal(f.calls.length,1);
  }
  const {f,api}=fixture(); let canceled=false;
  f.response=()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('x'.repeat(2_000_001)));},cancel(){canceled=true;}}));
  await assert.rejects(api.requestStudioText('/api/analyze',{},new AbortController().signal),/too large/); assert.equal(canceled,true);
});
test('history modes are allowlisted and fixed signed history writes preserve the actual tool and filename', async () => {
  const {f,api}=fixture(); f.response=()=>new Response('{}');
  await api.saveStudioHistory('description','Description draft','interview.srt'); assert.equal(JSON.parse(f.calls[0][1].body).mode,'description');
  f.response=()=>new Response('{"history":[{"result":"Saved"}],"totalPages":2}');
  const page=await api.listStudioHistory('description',2); assert.equal(page.items[0].result,'Saved');assert.equal(page.totalPages,2); assert.match(f.calls[1][0],/mode=description&page=2/);
  await assert.rejects(api.listStudioHistory('title&user=someone'),/Unsupported/); assert.equal(f.calls.length,2);
});

test('native Chat sends a signed fixed request with approved model and conversation context', async () => {
  const {f,api}=fixture(); f.response=()=>new Response('A useful reply 🌟');
  const body={model:'openai/gpt-6-luna',messages:[{role:'user',content:'Hello'}]};
  assert.equal(await api.requestStudioText('/api/chat',body,new AbortController().signal),'A useful reply 🌟');
  assert.equal(f.calls[0][0],'https://smoothyedit.com/api/chat');assert.equal(f.calls[0][1].headers.Authorization,'Bearer fixture-token');assert.deepEqual(JSON.parse(f.calls[0][1].body),body);
  f.enabled=false;await assert.rejects(api.requestStudioText('/api/chat',body,new AbortController().signal),/turned off/);assert.equal(f.calls.length,1);
});
test('Chat delivers decoded chunks before EOF and rejects oversized output before forwarding it', async () => {
 const {f,api}=fixture(); let stream, canceled=false; const chunks=[],bytes=new TextEncoder().encode('Hello 🌟 there');
 f.response=()=>new Response(new ReadableStream({start(c){stream=c;},cancel(){canceled=true;}}));
 const job=api.requestStudioText('/api/chat',{},new AbortController().signal,delta=>chunks.push(delta));
 stream.enqueue(bytes.slice(0,8)); await new Promise(resolve=>setTimeout(resolve,0)); assert.deepEqual(chunks,['Hello ']);
 stream.enqueue(bytes.slice(8)); stream.close(); assert.equal(await job,'Hello 🌟 there'); assert.equal(chunks.join(''),'Hello 🌟 there');
 chunks.length=0; const oversized=api.requestStudioText('/api/chat',{},new AbortController().signal,delta=>chunks.push(delta));
 stream.enqueue(new TextEncoder().encode('x'.repeat(10001)));
 await assert.rejects(oversized,/too large/); assert.equal(canceled,true); assert.deepEqual(chunks,[]);
});
test('canceled requests discard late network chunks and release the reader without retrying', async () => {
 const {f,api}=fixture(); const controller=new AbortController(); let stream,canceled=false; const chunks=[];
 f.response=()=>new Response(new ReadableStream({start(c){stream=c;},cancel(){canceled=true;}}));
 const job=api.requestStudioText('/api/chat',{},controller.signal,delta=>chunks.push(delta));
 stream.enqueue(new TextEncoder().encode('First ')); await new Promise(resolve=>setTimeout(resolve,0)); controller.abort();
 stream.enqueue(new TextEncoder().encode('Late ')); await assert.rejects(job,/abort/i);
 assert.deepEqual(chunks,['First ']); assert.equal(canceled,true); assert.equal(f.calls.length,1);
});
