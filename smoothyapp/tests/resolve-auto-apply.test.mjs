import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import vm from 'node:vm';
import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {build} from 'esbuild';
const require=createRequire(import.meta.url),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-apply-'));
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('actual Multicam IPC autosaves to unique existing SmoothyEdit Assets destinations without opening Save As',async()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../src/main/index.ts',import.meta.url)),'utf8');
 const code=source.slice(source.indexOf('function resolveAutoDestination'),source.indexOf('let resolveSourceLoading'))
   .replace('tool:string','tool').replace('let destination: string | undefined;','let destination;');
 const handlers=new Map(),destinations=[];let dialogs=0;
 const context={getAssetsOutputFolder:()=>path.join(scratch,'SmoothyEdit Assets'),path,fs,randomBytes:crypto.randomBytes,app:{getPath:key=>{assert.equal(key,'desktop');return scratch;}},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},getActiveNLE:()=> 'resolve',runAutoCut:async(config,start,dest)=>{start();destinations.push(dest);return {success:true};},trackTool:()=>{},dialog:{showSaveDialog:()=>{dialogs++;throw Error('Unexpected dialog')}},mainWindow:{webContents:{send(){}}}};
 vm.runInNewContext(code,context);const apply=handlers.get('start-autocut');
 assert.equal((await apply(null,{})).success,true);assert.equal((await apply(null,{})).success,true);
 assert.equal(dialogs,0);assert.notEqual(destinations[0],destinations[1]);
 for(const destination of destinations){assert.equal(path.dirname(destination),path.join(scratch,'SmoothyEdit Assets','Resolve'));assert.equal(path.extname(destination),'.xml');}
});

test('Resolve Apply waits for native import, emits one result, retains a saved recovery file on cancellation, and preserves Premiere',async()=>{
 const f={tracked:[],results:[],jobs:[],starts:0,output:'',mode:'success'};globalThis.__autoApply=f;
 const wsMethods=['startWebSocketServer','stopWebSocketServer','setCallbacks','requestSequenceInfo','runAutoCut','runSilenceRemoval','cancelTimelineOperation','exportAudio','addMarkersToSequence','clearMarkersFromSequence','exportSubtitles','sendCaptionsToPremiere','sendImageToPremiere','sendStockFootageToPremiere','sendAudioLibraryToPremiere'];
 const ws=wsMethods.map(name=>`export const ${name}=async()=>({success:true,nle:'premiere'});`).join('\n')+'export const getConnectionStatus=()=>true,getSequenceInfo=()=>null;';
 const service=`const f=globalThis.__autoApply;export function createResolveService(deps){async function run(config,destination,start){start?.();if(f.mode==='failure'){const result={success:false,nle:'resolve',error:'Analysis failed'};deps.result(result);return result;}f.output=destination;const result={success:true,nle:'resolve',handoff:true,sequenceName:'Interview - Edit',stats:{shots:4}};deps.result(result);return result;}return {run,removeSilence:run,load:()=>({hasSequence:true,id:'source'}),getOutput:()=>f.output,getInfo:()=>null,getTimeline:()=>null,cancel(){}}}`;
 const output=await build({entryPoints:[fileURLToPath(new URL('../src/main/nle-router.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',packages:'external',write:false,plugins:[{name:'native-adapters',setup(b){
  const stubs={'./websocket-server':ws,'./resolve/service':service,'./telemetry':"export const trackTool=id=>globalThis.__autoApply.tracked.push(id);"};
  b.onResolve({filter:/.*/},a=>a.path in stubs?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs[a.path]}));
 }}]});
 const mod={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(require,mod,mod.exports);const api=mod.exports;
 api.setCallbacks({onResult:r=>f.results.push(r)});api.setActiveNLE('resolve');
 api.loadResolveTimeline('source.xml','snapshot',false);assert.equal(f.tracked.length,0);
 api.loadResolveTimeline('source.xml','snapshot');assert.deepEqual(f.tracked,['resolve_timeline_import']);f.tracked.length=0;
 let finish;api.configureResolveReceiver(job=>{f.jobs.push(job);return new Promise(resolve=>finish=resolve);},()=>false);
 const pending=api.runAutoCut({},()=>f.starts++,path.join(scratch,'saved.xml'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.jobs.length,1);assert.equal(f.results.length,0);assert.equal(f.starts,1);assert.equal(f.tracked.length,0);
 finish({success:true,nle:'resolve'});assert.equal((await pending).imported,true);assert.equal(f.results.length,1);assert.deepEqual(f.tracked,['resolve_timeline_send']);
 const canceled=api.runSilenceRemoval({},()=>f.starts++,path.join(scratch,'silence.xml'));await new Promise(resolve=>setImmediate(resolve));
 finish({success:false,canceled:true,error:'Canceled'});const result=await canceled;
 assert.equal(result.success,false);assert.equal(result.canceled,true);assert.equal(result.exported,true);assert.equal(result.operation,'silence');assert.equal(result.path,path.join(scratch,'silence.xml'));assert.equal(f.results.length,2);assert.equal(f.tracked.length,1);
 f.mode='failure';assert.equal((await api.runAutoCut({},()=>f.starts++,'failed.xml')).success,false);assert.equal(f.jobs.length,2);assert.equal(f.results.length,3);
 api.setActiveNLE('premiere');assert.equal((await api.runAutoCut({})).nle,'premiere');assert.equal(f.jobs.length,2);
 delete globalThis.__autoApply;
});
