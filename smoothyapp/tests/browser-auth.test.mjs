import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { build, transform } from 'esbuild';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const scratch=await mkdtemp(path.join(os.tmpdir(),'smoothy-browser-auth-test-'));
globalThis.__smoothyAuthSaved=new Map();
const output=await build({stdin:{contents:`export * from './src/main/auth-service';export * from './src/main/browser-auth';`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false,define:{'process.env.SMOOTHY_API_URL':'"https://smoothyedit.test"'},plugins:[{name:'store-fixture',setup(b){b.onResolve({filter:/^electron-store$/},()=>({path:'store',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default class Store {get(k){return globalThis.__smoothyAuthSaved.get(k)}set(k,v){globalThis.__smoothyAuthSaved.set(k,v)}delete(k){globalThis.__smoothyAuthSaved.delete(k)}}'}));}}]});
await writeFile(path.join(scratch,'api.mjs'),output.outputFiles[0].text);const api=await import(pathToFileURL(path.join(scratch,'api.mjs')).href);
const user={id:'fixture-user',email:'editor@example.test',name:'Editor',tier:'pro',isAdmin:false,emailVerified:true};
const saved=globalThis.__smoothyAuthSaved;const realFetch=globalThis.fetch;let available=true,opened=[],nextParams,callbackUri,mode='',requests=[],releaseToken;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);if(url.origin!=='https://smoothyedit.test')return realFetch(input,options);
 requests.push({path:url.pathname,options});
 if(url.pathname==='/api/auth/providers')return Response.json({google:available});
 if(url.pathname==='/api/desktop-link/token'){
  const body=JSON.parse(options.body);assert.equal(body.code,'one-time-fixture-code');assert.equal(body.redirect_uri,callbackUri);
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'),nextParams.get('code_challenge'));
  assert.equal(body.code_verifier.length,43);assert.equal(options.redirect,'error');
  if(mode==='exchange-fail')return Response.json({error:'expired'},{status:400});
  if(mode==='late-token')await new Promise(resolve=>{releaseToken=resolve;});
  return Response.json({access_token:mode==='bad-token'?'':'signed-fixture-session',token_type:'Bearer',user:{id:user.id}});
 }
 if(url.pathname==='/api/auth/me'){
  assert.equal(options.headers.Authorization,'Bearer signed-fixture-session');
  return Response.json({user:{...user,...(mode==='wrong-user'?{id:'other-user'}:{})}});
 }
 throw Error('Unexpected API request');
};
async function openBrowser(url){opened.push(url);const parsed=new URL(url);assert.equal(parsed.origin,'https://smoothyedit.test');assert.equal(parsed.pathname,'/api/auth/google');assert.equal(parsed.searchParams.has('client_secret'),false);nextParams=new URL(parsed.searchParams.get('next'),'https://smoothyedit.test').searchParams;callbackUri=nextParams.get('redirect_uri');assert.equal(new URL(callbackUri).hostname,'127.0.0.1');assert.equal(nextParams.get('code_challenge_method'),'S256');}
async function returnCode(params={}){const query=new URLSearchParams({code:'one-time-fixture-code',state:nextParams.get('state'),...params});return realFetch(callbackUri+'?'+query);}
async function authenticate(){return api.loginWithGoogle(async url=>{await openBrowser(url);assert.equal((await returnCode()).status,200);});}
beforeEach(()=>{api.cancelGoogleSignIn();saved.clear();available=true;opened=[];mode='';requests=[];releaseToken=undefined;api.setAuthChangeCallback(()=>{});});
after(async()=>{api.cancelGoogleSignIn();globalThis.fetch=realFetch;delete globalThis.__smoothyAuthSaved;await rm(scratch,{recursive:true,force:true});});

test('Google uses the system browser and real loopback PKCE; persists only a server-verified signed account',async()=>{
 let changes=0;api.setAuthChangeCallback(()=>{changes++;});const result=await authenticate();assert.equal(result.success,true);assert.equal(result.user.id,user.id);assert.equal(saved.get('sessionToken'),'signed-fixture-session');assert.equal(changes,1);assert.equal(opened.length,1);assert.deepEqual(requests.map(r=>r.path),['/api/auth/providers','/api/desktop-link/token','/api/auth/me']);assert.ok(!JSON.stringify([...saved]).includes('code_verifier'));await assert.rejects(()=>realFetch(callbackUri));
});
test('unconfigured Google never opens a browser, stores credentials or attempts token exchange',async()=>{available=false;const result=await api.loginWithGoogle(openBrowser);assert.equal(result.success,false);assert.match(result.error,/not available/);assert.equal(opened.length,0);assert.equal(saved.size,0);assert.deepEqual(requests.map(r=>r.path),['/api/auth/providers']);});
test('wrong state, unicode state, missing code and unrelated requests do not authenticate or terminate a valid flow',async()=>{
 const result=await api.loginWithGoogle(async url=>{await openBrowser(url);assert.equal((await returnCode({state:'wrong'})).status,400);assert.equal((await returnCode({state:'é'.repeat(43)})).status,400);assert.equal((await realFetch(callbackUri+'?'+new URLSearchParams({state:nextParams.get('state')}))).status,400);assert.equal((await realFetch(callbackUri.replace('/callback','/favicon.ico'))).status,404);assert.equal((await realFetch(callbackUri,{method:'POST'})).status,400);assert.equal((await returnCode()).status,200);});assert.equal(result.success,true);
});
test('browser launch failure leaves no session and closes the loopback listener',async()=>{const result=await api.loginWithGoogle(async url=>{await openBrowser(url);throw Error('Browser could not open');});assert.equal(result.success,false);assert.match(result.error,/Browser/);assert.equal(saved.size,0);await assert.rejects(()=>realFetch(callbackUri));});
test('closing/canceling Google sign-in prevents late callback acceptance and leaves current account intact',async()=>{
 saved.set('user',{...user,id:'previous'});saved.set('sessionToken','previous-session');saved.set('jwt','previous');
 const result=await api.loginWithGoogle(async url=>{await openBrowser(url);api.cancelGoogleSignIn();});assert.equal(result.success,false);assert.match(result.error,/canceled/);assert.equal(saved.get('sessionToken'),'previous-session');await assert.rejects(()=>returnCode());
});
test('browser cancellation with the correct state emits no successful authentication',async()=>{const result=await api.loginWithGoogle(async url=>{await openBrowser(url);const response=await returnCode({error:'access_denied'});assert.equal(response.status,200);});assert.equal(result.success,false);assert.match(result.error,/canceled/);assert.equal(saved.size,0);assert.ok(!requests.some(r=>r.path.endsWith('/token')));});
test('timeout and cancellation clean up even if opening the browser never resolves',async()=>{
 for(const cancel of [false,true]){const controller=new AbortController();let url;const job=api.browserGoogleSignIn({apiBase:'https://smoothyedit.test',signal:controller.signal,timeoutMs:40,openExternal:async value=>{url=value;if(cancel)controller.abort();return new Promise(()=>{});}});await assert.rejects(job,cancel?/canceled/:/timed out/);const uri=new URL(new URL(url).searchParams.get('next'),'https://smoothyedit.test').searchParams.get('redirect_uri');await assert.rejects(()=>realFetch(uri));}
});
test('expired codes, invalid token responses and mismatched account identities cannot replace auth state',async()=>{for(const failure of ['exchange-fail','bad-token','wrong-user']){mode=failure;const result=await authenticate();assert.equal(result.success,false,failure);assert.equal(saved.size,0,failure);}});
test('signing out during token exchange prevents a late signed session from restoring the account',async()=>{
 mode='late-token';const job=authenticate();for(let i=0;i<100&&!releaseToken;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(releaseToken);api.logout();releaseToken();const result=await job;assert.equal(result.success,false);assert.equal(saved.size,0);
});
test('native auth never opens insecure remote hosts or credential-bearing URLs',async()=>{for(const base of ['http://evil.test','file:///tmp/app','https://user:password@example.test'])await assert.rejects(api.browserGoogleSignIn({apiBase:base,openExternal:async()=>assert.fail('Must not open browser'),signal:new AbortController().signal}),/secure/);});
const main=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');const handlers=(await transform(main.slice(main.indexOf("ipcMain.handle('auth-get-providers'"),main.indexOf("ipcMain.handle('auth-login'")),{loader:'ts'})).code;
function ipcFixture(){const f={handlers:new Map(),events:[],enabled:true,result:{success:true},cancels:0,focused:0};vm.runInNewContext(handlers,{ipcMain:{handle:(id,fn)=>f.handlers.set(id,fn)},appPreferences:{snapshot:()=>({studioEnabled:f.enabled})},getAuthProviders:async()=>({google:true}),cancelGoogleSignIn:()=>{f.cancels++;},loginWithGoogle:async()=>f.result,trackTool:id=>f.events.push(id),mainWindow:{show(){},focus(){f.focused++;}},generateConnectionToken:async()=>null,saveConnectionToken(){},connectToWebsite:async()=>{},shell:{openExternal:async()=>{}}});return f;}
test('Google IPC counts exactly one completed sign-in and focuses the app, with zero on failure/cancel',async()=>{const f=ipcFixture();await f.handlers.get('auth-google-login')();assert.deepEqual(f.events,['auth_login']);assert.equal(f.focused,1);f.events=[];f.result={success:false,error:'Canceled'};await f.handlers.get('auth-google-login')();f.handlers.get('auth-google-cancel')();assert.deepEqual(f.events,[]);assert.equal(f.cancels,1);});
test('Studio AI off blocks provider lookups and Google starts with zero runs',async()=>{const f=ipcFixture();f.enabled=false;assert.equal((await f.handlers.get('auth-get-providers')()).google,false);assert.equal((await f.handlers.get('auth-google-login')()).success,false);assert.deepEqual(f.events,[]);});
