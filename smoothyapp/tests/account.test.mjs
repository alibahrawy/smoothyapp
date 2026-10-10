import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const bundle = await build({entryPoints:[new URL('../src/main/auth-service.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'store',setup(b){b.onResolve({filter:/^electron-store$/},()=>({path:'store',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export default class Store {get(k){return globalThis.saved.get(k)}set(k,v){globalThis.saved.set(k,v)}delete(k){globalThis.saved.delete(k)}}`}));}}]});
function fixture(respond) {
  const saved=new Map(), calls=[];
  const context={module:{exports:{}},saved,process:{env:{}},AbortSignal,console:{log(){},error(){}},fetch:async(url,options={})=>{calls.push({url,options});return respond(new URL(url).pathname,options);}};
  vm.createContext(context);vm.runInContext(bundle.outputFiles[0].text,context);
  return {api:context.module.exports,saved,calls};
}
const user={id:'fixture',email:'person@gmail.com',name:'Person',tier:'free',isAdmin:false};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
test('signup creates a free account, obtains a signed session and reads server verification without storing passwords',async()=>{
  const f=fixture(route=>route==='/api/auth/register'?json({user}):route==='/api/auth/login'?json({user,sessionToken:'signed-token'}):json({user:{...user,emailVerified:false}}));
  const result=await f.api.signup({email:' Person@gmail.com ',name:' Person ',password:'password-for-test'});
  assert.equal(result.success,true);assert.equal(result.accountCreated,true);assert.equal(result.user.emailVerified,false);
  assert.deepEqual(f.calls.map(c=>new URL(c.url).pathname),['/api/auth/register','/api/auth/login','/api/auth/me']);
  assert.equal(JSON.parse(f.calls[0].options.body).email,'person@gmail.com');assert.equal(f.calls[2].options.headers.Authorization,'Bearer signed-token');
  assert.ok(f.calls.every(c=>c.options.redirect==='error'&&c.options.signal));assert.ok(!JSON.stringify([...f.saved]).includes('password-for-test'));
});
test('invalid signup and existing-account rejection do not obtain sessions or report a created account',async()=>{
  const f=fixture(()=>json({error:'User already exists'},409));
  assert.equal((await f.api.signup({email:'bad',password:'12345678'})).success,false);assert.equal((await f.api.signup({email:user.email,password:'short'})).success,false);assert.equal(f.calls.length,0);
  const result=await f.api.signup({email:user.email,password:'password-for-test'});assert.equal(result.accountCreated,undefined);assert.match(result.error,/exists/);assert.equal(f.calls.length,1);assert.equal(f.saved.size,0);
});
test('account creation survives an automatic sign-in error and missing signed tokens cannot authenticate',async()=>{
  const f=fixture(route=>route==='/api/auth/register'?json({user}):json({user}));
  const result=await f.api.signup({email:user.email,password:'password-for-test'});assert.equal(result.success,false);assert.equal(result.accountCreated,true);assert.match(result.error,/account was created/);assert.equal(f.saved.size,0);
});
test('verification reflects the server; 2FA stays supported and logout drops a stale sign-in response',async()=>{
  const f=fixture(route=>route==='/api/auth/login'?json({user,sessionToken:'signed-token'}):json({user:{...user,emailVerified:true}}));
  assert.equal((await f.api.login(user.email,'password-for-test')).user.emailVerified,true);
  const two=fixture(()=>json({requires2FA:true},403));assert.equal((await two.api.login(user.email,'password-for-test')).requires2FA,true);assert.equal(two.saved.size,0);
  let finish;const late=fixture(()=>new Promise(resolve=>{finish=resolve;}));const job=late.api.login(user.email,'password-for-test');late.api.logout();finish(json({user,sessionToken:'signed-token'}));assert.equal((await job).success,false);assert.equal(late.saved.size,0);
});
const main=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8');
const handlers=(await transform(main.slice(main.indexOf("ipcMain.handle('auth-login'"),main.indexOf('// Deprecated: trials removed',main.indexOf("ipcMain.handle('auth-login'"))),{loader:'ts'})).code;
function ipcFixture() {
  const f={handlers:new Map(),events:[],opened:[],enabled:true,result:{success:true,accountCreated:true},failure:false};
  vm.runInNewContext(handlers,{ipcMain:{handle:(id,fn)=>f.handlers.set(id,fn)},appPreferences:{snapshot:()=>({studioEnabled:f.enabled})},signup:async()=>f.result,login:async()=>f.result,trackTool:id=>f.events.push(id),generateConnectionToken:async()=>null,saveConnectionToken(){},connectToWebsite:async()=>{},getAuthState:()=>({}),logout(){},disconnectFromWebsite(){},refreshUserData:async()=>false,shell:{openExternal:async url=>{if(f.failure)throw Error('Offline');f.opened.push(url);}}});
  return f;
}
test('signup, explicit sign-in and inbox counts describe successful main-process actions only',async()=>{
  const f=ipcFixture();await f.handlers.get('auth-signup')(null,{});await f.handlers.get('auth-login')(null,{email:user.email,password:'fixture'});await f.handlers.get('auth-open-inbox')(null,'gmail');assert.deepEqual(f.events,['auth_signup','auth_login','auth_open_inbox']);assert.equal(f.opened[0],'https://mail.google.com/mail/u/0/#inbox');
  f.events=[];f.result={success:false};await f.handlers.get('auth-signup')(null,{});await f.handlers.get('auth-login')(null,{});f.failure=true;await f.handlers.get('auth-open-inbox')(null,'gmail');assert.deepEqual(f.events,[]);
  f.result={success:false,accountCreated:true};await f.handlers.get('auth-signup')(null,{});assert.deepEqual(f.events,['auth_signup']);
});
test('AI-off rejects new account requests; inbox opening cannot accept arbitrary URLs or transmit an email',async()=>{
  const f=ipcFixture();f.enabled=false;assert.equal((await f.handlers.get('auth-signup')(null,{})).success,false);assert.equal((await f.handlers.get('auth-login')(null,{})).success,false);assert.equal((await f.handlers.get('auth-open-inbox')(null,'https://evil.test')).success,false);assert.equal((await f.handlers.get('auth-open-inbox')(null,'__proto__')).success,false);assert.deepEqual(f.opened,[]);assert.deepEqual(f.events,[]);
});
