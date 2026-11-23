import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
Error.stackTraceLimit=2;
const buildResult=await build({entryPoints:[fileURLToPath(new URL('../src/main/local-audio-service.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {LocalAudioService,runAudioCommand}=await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles[0].text).toString('base64')}`);
const wav=()=>{const bytes=Buffer.alloc(128);bytes.write('RIFF');bytes.write('WAVE',8);return bytes;};
async function fixture(action){
 const root=await mkdtemp(path.join(os.tmpdir(),'smoothy-audio-test-')),usage=[],commands=[];let behavior='ok';
 await writeFile(path.join(root,'ready-v2'),JSON.stringify({version:2,backend:'cpu'}));const source=path.join(root,'source.wav');await writeFile(source,wav());
 const run=async(command,args,signal,progress)=>{
  commands.push({command,args});
  if(args.includes('prepare'))return '';
  if(command==='ffmpeg'){
   if(behavior==='missing-decoder')throw Object.assign(Error('spawn decoder ENOENT'),{code:'ENOENT'});
   if(behavior==='decoder-fail')throw Error('Decoder failed');
   if(behavior==='decoder-cancel'){progress('decoder-running');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Canceled')),{once:true}));}
   await writeFile(args.at(-1),behavior==='decoder-invalid'?Buffer.alloc(10):wav());return '';
  }
  if(behavior==='fail')throw Error('Model failed');
  if(behavior==='cancel'){progress('running');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Canceled')),{once:true}));}
  const output=args[3],mode=args[1];
  const items=mode==='denoise'
   ?[{label:'Clean audio',kind:'speech',path:path.join(output,'clean.wav')},{label:'Removed noise',kind:'noise',path:path.join(output,'noise.wav')}]
   :mode==='separate'
   ?[{label:'Voice',kind:'speech',path:path.join(output,'speech.wav')},{label:'Music',kind:'music',path:path.join(output,'music.wav')}]
   :[{label:'Clean voice',kind:'speech',path:path.join(output,'speech.wav')},{label:'Music & noise',kind:'background',path:path.join(output,'background.wav')}];
  if(behavior==='incomplete')items.pop();
  if(behavior==='duplicate')items[1].kind=items[0].kind;
  for(const item of items)await writeFile(item.path,behavior==='invalid'?Buffer.alloc(10):wav());
  if(behavior==='escape')items[0].path=source;
  await writeFile(path.join(output,'result.json'),JSON.stringify(items));return '';
 };
 const service=new LocalAudioService({root,ffmpeg:'ffmpeg',track:id=>usage.push(id),run});
 try{await action({service,root,source,usage,commands,behavior:value=>behavior=value});}finally{await service.dispose();await rm(root,{recursive:true,force:true});}
}

test('standalone denoise works directly without separation, supports aggression and strength-blended save',async()=>fixture(async({service,source,usage,commands,root})=>{
 const selected=await service.select(source);assert.deepEqual(usage,[]);
 const denoised=await service.process({source:selected.id,mode:'denoise',aggression:9},()=>{});
 assert.equal(denoised.length,2);
 assert.deepEqual(denoised.map(item=>item.kind),['speech','noise']);
 assert.equal('file' in denoised[0],false);
 assert.deepEqual(usage,['audio_noise_remove']);
 const workerCall=commands.find(c=>c.command!=='ffmpeg');
 assert.equal(workerCall.args[1],'denoise');
 assert.deepEqual(JSON.parse(workerCall.args[5]),{aggression:9});

 // Full-strength save copies directly without invoking ffmpeg
 const fullDest=path.join(root,'full.wav');
 await service.save(denoised[0].id,fullDest,{strength:100});
 assert.deepEqual(await readFile(fullDest),wav());
 assert.equal(commands.filter(c=>c.command==='ffmpeg').length,1);
 assert.deepEqual(usage,['audio_noise_remove','audio_tools_save']);

 // Partial-strength save blends clean + residual via ffmpeg
 const blendDest=path.join(root,'blend.wav');
 await service.save(denoised[0].id,blendDest,{strength:75});
 assert.deepEqual(await readFile(blendDest),wav());
 const blendCall=commands.filter(c=>c.command==='ffmpeg').at(-1);
 assert.ok(blendCall.args.includes('-filter_complex'));
 assert.match(blendCall.args[blendCall.args.indexOf('-filter_complex')+1],/volume=0\.2500/);
 assert.deepEqual(usage,['audio_noise_remove','audio_tools_save','audio_tools_save']);

 // Internal agent materialization (track:false) adds no UI save event
 const internalDest=path.join(root,'internal.wav');
 await service.save(denoised[0].id,internalDest,{strength:80,track:false});
 assert.equal(usage.filter(id=>id==='audio_tools_save').length,2);
}));

test('separate and isolate count accurately and isolate reuses cached separation',async()=>fixture(async({service,source,usage,commands,root})=>{
 const selected=await service.select(source);assert.deepEqual(usage,[]);
 // Standalone isolate without prior separate runs both passes and counts both IDs
 const standalone=await service.process({source:selected.id,mode:'isolate'},()=>{});
 assert.deepEqual(standalone.map(item=>item.kind),['speech','background']);
 assert.deepEqual(usage,['audio_music_separate','audio_noise_remove']);
 const firstWorker=commands.filter(c=>c.command!=='ffmpeg').at(-1);
 assert.equal(JSON.parse(firstWorker.args[5]).separatedSpeech,undefined);

 // Now run separate, then isolate (and legacy enhance alias): reuses cached speech and counts only noise removal
 const separated=await service.process({source:selected.id,mode:'separate'},()=>{});
 assert.deepEqual(separated.map(item=>item.kind),['speech','music']);
 service.preview(separated[0].id);service.preview(separated[0].id);service.preview(separated[1].id);
 assert.deepEqual(usage.slice(2),['audio_music_separate','audio_tools_preview','audio_tools_preview']);

 const isolated=await service.process({source:selected.id,mode:'enhance'},()=>{});
 assert.deepEqual(isolated.map(item=>item.kind),['speech','background']);
 const reusedWorker=commands.filter(c=>c.command!=='ffmpeg').at(-1);
 assert.equal(reusedWorker.args[1],'isolate');
 assert.ok(JSON.parse(reusedWorker.args[5]).separatedSpeech);
 assert.deepEqual(usage.slice(5),['audio_noise_remove']);

 const destination=path.join(root,'saved.wav');await service.save(separated[0].id,destination);assert.deepEqual(await readFile(destination),wav());
 assert.equal(usage.at(-1),'audio_tools_save');
 await assert.rejects(service.save(separated[0].id,path.join(root,'missing','saved.wav')));assert.equal(usage.filter(id=>id==='audio_tools_save').length,1);
 assert.throws(()=>service.preview('../../source'),/Run/);
}));

test('select supports time ranges and rejects empty ranges',async()=>fixture(async({service,source,commands})=>{
 await assert.rejects(service.select(source,()=>{},{from:10,to:10}),/empty/);
 await service.select(source,()=>{},{from:2,to:7});
 const ffmpegArgs=commands.at(-1).args;
 assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-ss')+1],'2');
 assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-t')+1],'5');
}));

test('mode-specific results, missing inputs, invalid WAV and escaping output paths',async()=>fixture(async({service,source,usage,behavior})=>{
 const selected=await service.select(source);
 await assert.rejects(service.process({source:selected.id,mode:'invalid'},()=>{}),/Choose/);
 await assert.rejects(service.process({source:'bad',mode:'denoise'},()=>{}),/Choose/);
 for(const value of ['fail','invalid','escape','incomplete','duplicate']){behavior(value);await assert.rejects(service.process({source:selected.id,mode:'denoise'},()=>{}));assert.deepEqual(usage,[]);assert.throws(()=>service.original(),/Process audio/);}
 behavior('ok');await service.process({source:selected.id,mode:'separate'},()=>{});
 for(const value of ['fail','invalid','escape','incomplete','duplicate']){behavior(value);await assert.rejects(service.process({source:selected.id,mode:'isolate'},()=>{}));assert.deepEqual(usage,['audio_music_separate']);}
 behavior('ok');const isolated=await service.process({source:selected.id,mode:'isolate'},()=>{});
 assert.equal(isolated.length,2);assert.deepEqual(usage,['audio_music_separate','audio_noise_remove']);
}));

test('cancel settles before retry, rejects overlap and counts no completed run',async()=>fixture(async({service,source,usage,behavior})=>{
 const selected=await service.select(source);behavior('cancel');let started;const ready=new Promise(resolve=>started=resolve);
 const pending=service.process({source:selected.id,mode:'denoise'},message=>{if(message==='running')started();});await ready;
 await assert.rejects(service.process({source:selected.id,mode:'denoise'},()=>{}),/Wait/);
 service.cancel();await assert.rejects(pending,/Canceled/);assert.deepEqual(usage,[]);
 behavior('ok');assert.equal((await service.process({source:selected.id,mode:'denoise'},()=>{})).length,2);
 assert.deepEqual(usage,['audio_noise_remove']);
}));

test('unready engine does not process or count',async()=>fixture(async({service,root,source,usage})=>{
 await rm(path.join(root,'ready-v2'));const selected=await service.select(source);
 await assert.rejects(service.process({source:selected.id,mode:'denoise'},()=>{}),/Set up/);assert.deepEqual(usage,[]);
}));

test('missing decoder prevents original preparation, gives repair guidance and permits retry without counts',async()=>fixture(async({service,source,usage,behavior})=>{
 behavior('missing-decoder');
 await assert.rejects(service.select(source),/audio decoder.*FFmpeg.*missing/);
 assert.deepEqual(usage,[]);assert.equal((await service.state()).busy,false);
 behavior('ok');const selected=await service.select(source);assert.equal((await service.process({source:selected.id,mode:'denoise'},()=>{})).length,2);
 assert.deepEqual(usage,['audio_noise_remove']);
}));

test('Original is playable before processing, decoded once, and preview stays deduplicated',async()=>fixture(async({service,source,usage,commands})=>{
 const selected=await service.select(source);assert.equal(selected.kind,'original');assert.match(selected.url,/smoothy-local-audio:\/\/result\/[0-9a-f-]{36}/);assert.equal('file' in selected,false);
 assert.deepEqual(usage,[]);assert.deepEqual(await readFile(service.output(selected.id).file),wav());
 service.preview(selected.id);service.preview(selected.id);assert.deepEqual(usage,['audio_tools_preview']);
 await service.process({source:selected.id,mode:'denoise'},()=>{});
 assert.equal(service.original().id,selected.id);
 service.preview(service.original().id);assert.equal(usage.filter(id=>id==='audio_tools_preview').length,1);
 assert.equal(commands.filter(c=>c.command==='ffmpeg').length,1);
 assert.deepEqual(usage,['audio_tools_preview','audio_noise_remove']);
}));

test('failed or canceled source preparation preserves the old selected file/results with zero extra success events',async()=>fixture(async({service,source,usage,behavior})=>{
 const selected=await service.select(source);await service.process({source:selected.id,mode:'separate'},()=>{});const original=service.original(),before=[...usage];
 for(const failure of ['decoder-fail','decoder-invalid']){behavior(failure);await assert.rejects(service.select(source));assert.deepEqual(service.original(),original);assert.deepEqual(usage,before);}
 behavior('decoder-cancel');let started;const ready=new Promise(resolve=>started=resolve);
 const pending=service.select(source,message=>{if(message==='decoder-running')started();});await ready;
 await assert.rejects(service.select(source),/Wait/);service.cancel();await assert.rejects(pending,/Canceled/);
 assert.deepEqual(usage,before);assert.ok(service.output(original.id));assert.equal((await service.state()).busy,false);
 behavior('ok');await service.process({source:selected.id,mode:'separate'},()=>{});assert.equal(service.original().id,selected.id);
}));

test('a telemetry exception never blocks audio processing',async()=>{
 await fixture(async({service,source})=>{service.deps.track=()=>{throw Error('offline');};const selected=await service.select(source);assert.equal((await service.process({source:selected.id,mode:'denoise'},()=>{})).length,2);});
});

test('failed reprocessing keeps the previous original comparison and output capabilities',async()=>fixture(async({service,source,usage,behavior})=>{
 const selected=await service.select(source),outputs=await service.process({source:selected.id,mode:'separate'},()=>{}),original=service.original();
 behavior('incomplete');await assert.rejects(service.process({source:selected.id,mode:'isolate'},()=>{}));
 assert.deepEqual(service.original(),original);assert.ok(service.output(outputs[0].id));assert.ok(service.output(original.id));
 assert.deepEqual(usage,['audio_music_separate']);
}));

test('real subprocess cancellation terminates and rejects',async()=>{
 const controller=new AbortController();
 const pending=runAudioCommand(process.execPath,['-e',"console.log('SMOOTHY_PROGRESS:running');setInterval(()=>{},1000)"],controller.signal,()=>{controller.abort();});
 await assert.rejects(pending,/Canceled/);
});

test('progress survives interleaved partial logs and split UTF-8 markers',async()=>{
 const messages=[];
 const script=`
  process.stderr.write('partial engine log');
  setTimeout(()=>process.stdout.write('SMOOTHY_PRO'),20);
  setTimeout(()=>process.stdout.write('GRESS:Loading noise removal model…\\n'),40);
  setTimeout(()=>process.stderr.write('\\rSMOOTHY_PROGRESS:Removing background noise…\\r'),60);
  setTimeout(()=>{const bytes=Buffer.from('SMOOTHY_PROGRESS:Checking output tracks…\\n');process.stdout.write(bytes.subarray(0,bytes.length-3));setTimeout(()=>process.stdout.write(bytes.subarray(bytes.length-3)),10)},80);
 `;
 await runAudioCommand(process.execPath,['-e',script],new AbortController().signal,message=>messages.push(message));
 assert.deepEqual(messages,['Loading noise removal model…','Removing background noise…','Checking output tracks…']);
});

test('structured completed-work progress validates counters and ignores malformed engine lines',async()=>{
 const messages=[];
 const lines=[
  'SMOOTHY_AUDIO_EVENT:{invalid',
  'SMOOTHY_AUDIO_EVENT:'+JSON.stringify({message:'Denoising',stage:'denoise',completed:3,total:12,unit:'windows'}),
  'SMOOTHY_AUDIO_EVENT:'+JSON.stringify({message:'Invalid counters',stage:'denoise',completed:-1,total:0}),
  'SMOOTHY_AUDIO_EVENT:'+JSON.stringify({message:'Using CUDA',stage:'device',backend:'cuda'}),
  'SMOOTHY_AUDIO_EVENT:'+JSON.stringify({total:12}),
 ];
 await runAudioCommand(process.execPath,['-e',`for(const line of ${JSON.stringify(lines)})console.log(line)`],new AbortController().signal,data=>messages.push(data));
 assert.deepEqual(messages,[{message:'Denoising',stage:'denoise',completed:3,total:12,unit:'windows'},{message:'Invalid counters',stage:'denoise'},{message:'Using CUDA',stage:'device',backend:'cuda'}]);
});

test('a cached CPU engine requests one GPU migration, not historical feature activity',async()=>fixture(async({service,root,usage})=>{
 await rm(path.join(root,'ready-v2'));
 await writeFile(path.join(root,'ready-v1'),'old CPU engine');
 service.deps.backend=async()=> 'cuda';
 assert.deepEqual(await service.state(),{ready:false,busy:false,backend:'cuda'});
 await writeFile(path.join(root,'ready-v2'),JSON.stringify({version:2,backend:'cuda'}));
 assert.deepEqual(await service.state(),{ready:true,busy:false,backend:'cuda'});
 assert.deepEqual(usage,[]);
}));

test('GPU setup reuses model files, cancellation leaves no ready marker and no usage',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'smoothy-audio-migration-')),usage=[],commands=[];
 const python=path.join(root,'runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const {mkdir}=await import('node:fs/promises');
 await mkdir(path.dirname(python),{recursive:true});await writeFile(python,'fixture');
 await mkdir(path.join(root,'models'));await writeFile(path.join(root,'models','cached-model'),'existing weights');
 let service,cancel=false;
 const run=async(command,args,signal)=>{
  commands.push(args);
  if(args.includes('-c'))return '26.2.1';
  if(args[1]==='prepare'){
   assert.equal(await readFile(path.join(args[4],'cached-model'),'utf8'),'existing weights');
   if(cancel){service.cancel();signal.throwIfAborted();}
  }
  return '';
 };
 service=new LocalAudioService({root,ffmpeg:'ffmpeg',backend:async()=> 'cuda',track:id=>usage.push(id),run});
 try{
  await service.setup(()=>{});assert.equal((await service.state()).ready,true);
  assert.ok(commands.some(args=>args.includes('torch==2.5.1+cu124')&&args.includes('https://download.pytorch.org/whl/cu124')));
  assert.ok(commands.some(args=>args.includes('onnxruntime-gpu==1.20.2')));
  cancel=true;await assert.rejects(service.setup(()=>{}),{name:'AbortError'});
  assert.equal((await service.state()).ready,false);
  assert.equal(await readFile(path.join(root,'models','cached-model'),'utf8'),'existing weights');
  assert.deepEqual(usage,[]);
 }finally{await service.dispose();await rm(root,{recursive:true,force:true});}
});
