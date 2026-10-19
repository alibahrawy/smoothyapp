import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const module={exports:{}};const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/main/resolve/receiver.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
new Function('require','module','exports',bundle.outputFiles[0].text)(require,module,module.exports);
const {receiveScript,createResolveReceiver,readReceiveReceipt}=module.exports;
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
const id='11111111-1111-4111-8111-111111111111';
function runLua(job,setup='',check=''){
 const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
 const base=`io=nil;os=nil;package=nil;require=nil;print=function()end
 local values={};local calls=0;local mode='ok';local importedName='Interview';local markers={}
 local prefs={GetPrefs=function(self,k)return values[k]end,SetPrefs=function(self,k,v)values[k]=v end,SavePrefs=function()return true end}
 local timeline={GetTrackCount=function(self,kind)return kind=='video' and 1 or 0 end,GetItemListInTrack=function()return {{GetMediaPoolItem=function()return {}end}}end,GetName=function()return importedName end,GetUniqueId=function()return 'native-1'end,GetSetting=function()return '25'end,GetMarkers=function()return markers end,AddMarker=function(self,frame,color,name,note,duration,data)calls=calls+1;markers[frame]={customData=data};return true end,DeleteMarkerAtFrame=function(self,frame)markers[frame]=nil;return true end}
 local folder={GetSubFolderList=function()return {__flags=1}end};local pool={GetRootFolder=function()return folder end,ImportMedia=function(self,files)calls=calls+1;if mode=='reject'then return {}end;assert(#files==1);return {{}}end,ImportTimelineFromFile=function(self,file,options)assert(options.importSourceClips==false);assert(options.sourceClipsFolders[1]==folder);calls=calls+1;importedName=options.timelineName;return timeline end}
 local project={GetTimelineCount=function()return calls+1 end,GetMediaPool=function()return pool end,GetCurrentTimeline=function()return timeline end}
 local manager={GetCurrentProject=function()if mode=='noProject'then return nil end;return project end}
 resolve={GetProjectManager=function()return manager end};fusion=prefs;
 ${setup}
 do ${receiveScript({id,...job})} end
 ${check}`;
 const result=lauxlib.luaL_dostring(L,to_luastring(base));if(result!==lua.LUA_OK)assert.fail(to_jsstring(lua.lua_tostring(L,-1)));
 lua.lua_close(L);
}
for(const extension of ['png','mp4','mp3','srt'])test(`Lua native Media Pool handoff for ${extension} confirms only a returned item`,()=>runLua({kind:'media',file:`C:/Example space/Arabic أهلا/file.${extension}`},'',`assert(calls==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|done')`));
test('Lua refusal and missing project never report done',()=>{
 runLua({kind:'media',file:'C:/sample.png'},"mode='reject'",`assert(calls==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|rejected')`);
 runLua({kind:'media',file:'C:/sample.png'},"mode='noProject'",`assert(calls==0);assert(values['Global.SmoothyEditReceiveV1']=='${id}|noProject')`);
});
test('native receipt prevents a second import when the helper is run twice',()=>runLua({kind:'media',file:'C:/sample.png'},'',`do ${receiveScript({id,kind:'media',file:'C:/sample.png'})} end;assert(calls==1)`));
test('timeline handoff imports a uniquely named timeline without modifying source clips',()=>runLua({kind:'timeline',file:'C:/sample.xml'},"local prior=pool.ImportTimelineFromFile;pool.ImportTimelineFromFile=function(self,file,options)assert(options.timelineName=='Smoothy timeline - 11111111');return prior(self,file,options)end",`assert(calls==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|done')`));
test('a returned timeline with offline audio is rolled back and never reports done',()=>runLua({kind:'timeline',file:'C:/sample.xml'},"local removed=0;timeline.GetTrackCount=function()return 1 end;timeline.GetItemListInTrack=function(self,kind)if kind=='audio'then return {{GetMediaPoolItem=function()return nil end}}end;return {{GetMediaPoolItem=function()return {}end}}end;pool.DeleteTimelines=function(self,items)assert(items[1]==timeline);removed=removed+1;return true end",`assert(calls==1);assert(removed==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|offlineRemoved')`));
test('a stale returned timeline cannot masquerade as a new successful import',()=>{
 runLua({kind:'timeline',file:'C:/sample.xml'},"project.GetTimelineCount=function()return 3 end;pool.DeleteTimelines=function()error('Must not delete an existing timeline')end",`assert(calls==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|rejected')`);
});
test('timeline conform searches nested Media Pool bins and never retries a refused import',()=>{
 runLua({kind:'timeline',file:'C:/sample.xml'},"local sub={GetSubFolderList=function()return {}end};folder.GetSubFolderList=function()return {sub,__flags=1}end;pool.ImportTimelineFromFile=function(self,file,options)calls=calls+1;assert(options.importSourceClips==false);assert(#options.sourceClipsFolders==2);assert(options.sourceClipsFolders[2]==sub);return nil end",`assert(calls==1);assert(values['Global.SmoothyEditReceiveV1']=='${id}|rejected')`);
});
test('markers require matching native identity and never overwrite existing markers',()=>{
 runLua({kind:'markers',timelineName:'Interview',nativeId:'wrong',markers:[{start:1,duration:1,name:'A',note:''}]},'',`assert(calls==0);assert(values['Global.SmoothyEditReceiveV1']=='${id}|wrongTimeline')`);
 runLua({kind:'markers',timelineName:'Interview',nativeId:'native-1',markers:[{start:1,duration:1,name:'A',note:''}]},"markers[25]={customData='user'}",`assert(calls==0);assert(values['Global.SmoothyEditReceiveV1']=='${id}|markerCollision')`);
 runLua({kind:'markers',timelineName:'Interview',nativeId:'native-1',markers:[{start:1,duration:1,name:'A',note:''}]},'',`assert(calls==1);assert(markers[25].customData=='SmoothyEdit:${id}')`);
});
test('clear removes only Smoothy markers on the bound timeline',()=>runLua({kind:'clear-markers',nativeId:'native-1',timelineName:'Interview'},"markers[25]={customData='user'};markers[50]={customData='SmoothyEdit:earlier'}",`assert(markers[25]);assert(not markers[50]);assert(values['Global.SmoothyEditReceiveV1']=='${id}|done')`));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-receive-tests-'));
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){let phase=null;const events=[];const directory=fs.mkdtempSync(path.join(scratch,'case-')),file=path.join(directory,'media.png');fs.writeFileSync(file,'fixture');
 const receiver=createResolveReceiver({scriptDirectory:path.join(directory,'scripts'),profiles:path.join(directory,'profiles'),changed:v=>events.push(v),interval:5,timeout:50,receipt:()=>phase});return {receiver,file,events,setPhase:value=>phase=value};}
test('queued requests do not report import success before native confirmation and reject overlap',async()=>{
 const f=fixture(),pending=f.receiver.send({kind:'media',file:f.file});assert.equal(f.events.some(x=>x.success),false);
 assert.equal((await f.receiver.send({kind:'media',file:f.file})).success,false);f.setPhase('done');await pause(15);assert.equal((await pending).success,true);assert.equal(f.events.filter(x=>x.success).length,1);f.receiver.close();
});
test('canceled and timed-out handoffs never return successful imports',async()=>{
 const f=fixture(),pending=f.receiver.send({kind:'media',file:f.file});f.receiver.cancel();assert.equal((await pending).canceled,true);assert.match(fs.readFileSync(f.receiver.snapshot().scriptPath,'utf8'),/Request canceled/);
 const timeout=f.receiver.send({kind:'media',file:f.file});await pause(75);assert.equal((await timeout).success,false);f.receiver.close();
});
test('a running native action cannot be claimed canceled and refusal releases the guard',async()=>{
 const f=fixture(),pending=f.receiver.send({kind:'media',file:f.file});f.setPhase('started');await pause(10);assert.equal(f.receiver.cancel().success,false);f.setPhase('rejected');await pause(10);assert.equal((await pending).success,false);assert.equal(f.receiver.isBusy(),false);f.receiver.close();
});
test('receipt parser accepts only the matching namespaced ID and bounded regular prefs files',()=>{
 const directory=path.join(scratch,'prefs'),profile=path.join(directory,'Default');fs.mkdirSync(profile,{recursive:true});const file=path.join(profile,'Fusion.prefs');fs.writeFileSync(file,`SmoothyEditReceiveV1 = "${id}|done"`);assert.equal(readReceiveReceipt(directory,id),'done');assert.equal(readReceiveReceipt(directory,'22222222-2222-4222-8222-222222222222'),null);
 fs.writeFileSync(file,'x'.repeat(2*1024*1024+1));assert.equal(readReceiveReceipt(directory,id),null);
});

test('locked/replaced helper cleanup cannot escape the polling timer as an uncaught main-process exception',async()=>{
 const f=fixture(),pending=f.receiver.send({kind:'media',file:f.file});fs.writeFileSync(f.receiver.snapshot().scriptPath,'Unrelated user script');await pause(75);assert.equal((await pending).success,false);assert.equal(f.receiver.isBusy(),false);f.receiver.close();
});

test('resident source requests create executable mailbox chunks and cancellation revokes them',async()=>{
 const directory=fs.mkdtempSync(path.join(scratch,'resident-'));let receipt=null;
 const receiver=createResolveReceiver({scriptDirectory:directory,profiles:directory,changed:()=>{},sourceScript:()=>"sourceRuns=sourceRuns+1;return",receipt:()=>receipt,interval:5});receiver.install();
 const pending=receiver.send({kind:'source'});const mailbox=path.join(directory,'.smoothy-connector-request.lua');
 const L=lauxlib.luaL_newstate();lualib.luaL_openlibs(L);
 const code=`local values={};sourceRuns=0;fusion={SetPrefs=function(self,k,v)values[k]=v end,SavePrefs=function()end};local chunk=function() ${fs.readFileSync(mailbox,'utf8')} end;local request=chunk();request.run();assert(sourceRuns==1);assert(values['Global.SmoothyEditReceiveV1']==request.id..'|done')`;
 const result=lauxlib.luaL_dostring(L,to_luastring(code));if(result!==lua.LUA_OK)assert.fail(to_jsstring(lua.lua_tostring(L,-1)));lua.lua_close(L);
 receipt='done';await pause(15);assert.equal((await pending).success,true);
 receipt=null;const canceled=receiver.send({kind:'source'});receiver.cancel();assert.equal((await canceled).canceled,true);assert.match(fs.readFileSync(mailbox,'utf8'),/return nil/);receiver.close();
});

test('actual router uses the captured Resolve destination after UI switches, never sends those imports to CEP, and restores Premiere',async()=>{
 const f={cep:[],jobs:[],busy:false};globalThis.__resolveRouteFixture=f;
 const methods=['startWebSocketServer','stopWebSocketServer','setCallbacks','requestSequenceInfo','runAutoCut','runSilenceRemoval','cancelTimelineOperation','exportAudio','addMarkersToSequence','clearMarkersFromSequence','exportSubtitles','sendCaptionsToPremiere','sendImageToPremiere','sendStockFootageToPremiere','sendAudioLibraryToPremiere'];
 const mock=methods.map(name=>`export function ${name}(...args){globalThis.__resolveRouteFixture.cep.push('${name}');return {success:true};}`).join('\n')+'\nexport const getConnectionStatus=()=>true;export const getSequenceInfo=()=>null;';
 const output=await build({entryPoints:[fileURLToPath(new URL('../src/main/nle-router.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,packages:'external',plugins:[{name:'route-native-adapters',setup(b){
  b.onResolve({filter:/^\.\/websocket-server$/},()=>({path:'ws',namespace:'fixture'}));b.onResolve({filter:/^\.\/telemetry$/},()=>({path:'telemetry',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='ws'?mock:'export const trackTool=()=>{};'}));
 }}]});
 const mod={exports:{}};new Function('require','module','exports','__dirname',output.outputFiles[0].text)(require,mod,mod.exports,fileURLToPath(new URL('../src/main',import.meta.url)));
 const api=mod.exports;api.configureResolveReceiver(async job=>{f.jobs.push(job);return {success:true,nle:'resolve'};},()=>f.busy);
 api.setActiveNLE('premiere');f.cep=[];
 await api.importImageToNLE('image.png',5,'resolve');await api.importStockFootageToNLE('video.mp4','resolve');await api.importAudioLibraryToNLE('audio.mp3','resolve');
 assert.deepEqual(f.jobs.map(j=>j.file),['image.png','video.mp4','audio.mp3']);assert.deepEqual(f.cep,[]);assert.equal(api.getActiveNLE(),'premiere');
 api.setActiveNLE('resolve');await api.sendCaptionsToNLE('captions.srt');assert.equal(f.jobs.at(-1).file,'captions.srt');f.busy=true;assert.throws(()=>api.setActiveNLE('premiere'),/Finish or cancel/);f.busy=false;
 api.setActiveNLE('premiere');await api.importImageToNLE('image.png');await api.sendCaptionsToNLE('captions.srt');assert.ok(f.cep.includes('sendImageToPremiere'));assert.ok(f.cep.includes('sendCaptionsToPremiere'));
 delete globalThis.__resolveRouteFixture;
});
