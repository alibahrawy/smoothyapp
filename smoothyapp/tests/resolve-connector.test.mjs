import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/main/resolve/connector.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,mod,mod.exports);
const {connectorScript,createResolveConnector}=mod.exports;
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
function run(request,check,setup=''){
 const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
 const code=`local values={};local runs=0;local ticks=0;local saves=0
 io=nil;package=nil;require=nil;print=function()end
 os={time=function()return 1000 end}
 fusion={GetPrefs=function(self,k)return values[k]end,SetPrefs=function(self,k,v)values[k]=v end,SavePrefs=function()saves=saves+1 end}
 bmd={wait=function()ticks=ticks+1;if ticks>5 then values['Global.SmoothyEditConnectorOwnerV1']='replacement' end end}
 loadfile=function(file)assert(file=='C:/mailbox.lua');return function()return ${request} end end
 ${setup}
 do ${connectorScript('C:/mailbox.lua')} end
 ${check}`;
 const result=lauxlib.luaL_dostring(L,to_luastring(code));if(result!==lua.LUA_OK)assert.fail(to_jsstring(lua.lua_tostring(L,-1)));lua.lua_close(L);
}
test('resident connector executes one fresh request once across repeated polling without idle SavePrefs',()=>run("{id='job1',expires=1100,run=function()runs=runs+1 end}",'assert(runs==1);assert(saves==0)'));
test('expired and revoked mailboxes cannot execute later',()=>{
 run("{id='job1',expires=999,run=function()runs=runs+1 end}",'assert(runs==0)');
 run('nil','assert(runs==0)');
});
test('native claim persists across replacement loops and prevents duplicate execution',()=>run("{id='job1',expires=1100,run=function()runs=runs+1 end}",'assert(runs==0)',"values['Global.SmoothyEditConnectorClaimV1']='job1'"));
test('API errors cannot kill the resident loop or turn into successful imports',()=>run("{id='job1',expires=1100,run=function()runs=runs+1;error('refused')end}",'assert(runs==1);assert(ticks>5);assert(saves==0)'));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-connector-'));after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('install revokes requests from earlier app sessions; atomic queue and cancellation replace only owned files',()=>{
 const c=createResolveConnector(scratch);c.install();const mailbox=path.join(scratch,'.smoothy-connector-request.lua');
 c.queue('job1','return',Date.now()+10000);assert.match(fs.readFileSync(mailbox,'utf8'),/job1/);
 c.revoke();assert.match(fs.readFileSync(mailbox,'utf8'),/return nil/);
 c.queue('job2','return',Date.now()+10000);c.install();assert.match(fs.readFileSync(mailbox,'utf8'),/return nil/);
 fs.writeFileSync(mailbox,'user file');assert.throws(()=>c.queue('job3','return',Date.now()+10000),/not replaced/);assert.equal(fs.readFileSync(mailbox,'utf8'),'user file');
});
