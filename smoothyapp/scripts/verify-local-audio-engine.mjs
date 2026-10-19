// Real local CPU models; synthetic fixture only, no telemetry/provider calls.
import {build} from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),ffmpeg=require('ffmpeg-static');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'smoothy-audio-engine-proof-'));
const bundle=path.join(scratch,'service.cjs');
await build({entryPoints:['src/main/local-audio-service.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle});
const {LocalAudioService,runAudioCommand}=require(bundle);
const root=path.join(process.env.LOCALAPPDATA || os.tmpdir(),'SmoothyEdit','audio-engine'),usage=[];
const service=new LocalAudioService({root,ffmpeg,track:id=>usage.push(id),backend:async()=>process.env.SMOOTHY_AUDIO_TEST_BACKEND||'cuda'});
try{
 if(!(await service.state()).ready)await service.setup(message=>console.log(message));
 console.log('SETUP PASS');
 const fixture=path.join(scratch,'mixture.wav');
 await runAudioCommand(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=220:duration=4','-f','lavfi','-i','anoisesrc=color=pink:amplitude=0.04:duration=4','-filter_complex','[0:a][1:a]amix=inputs=2:normalize=0','-ac','2','-ar','44100',fixture],new AbortController().signal,()=>{});
 const source=await service.select(fixture);
 for(const mode of ['separate','enhance']){
  const start=Date.now(),messages=[];const results=await service.process({source:source.id,mode},message=>{messages.push(message);console.log(mode,message)});
  assert.ok(messages.includes('Starting local audio engine…'));
  assert.equal(messages.at(-1),'Checking output tracks…');
  const work=messages.filter(item=>typeof item==='object'&&item.total>0);
  assert.ok(work.some(item=>item.completed===item.total),'real stage completion');
  assert.ok(work.some(item=>item.completed>0),'completed work units');
  assert.ok(messages.some(item=>item.backend===(process.env.SMOOTHY_AUDIO_TEST_BACKEND||'cuda')&&item.message.startsWith('Processed with')),'GPU actually completed the model');
  if(mode==='separate'){
   assert.ok(messages.includes('Loading music separation model…'));
   assert.ok(messages.includes('Separating voice and music…'));
   assert.deepEqual(results.map(item=>item.kind),['speech','music']);
  }else{
   assert.ok(messages.includes('Loading noise removal model…'));
   assert.ok(messages.includes('Removing background noise…'));
   assert.deepEqual(results.map(item=>item.kind),['speech']);
  }
  for(const result of results){const output=service.output(result.id);const bytes=await fs.readFile(output.file);assert.ok(bytes.length>44);assert.equal(bytes.toString('ascii',8,12),'WAVE');console.log(mode,result.label,bytes.length,'bytes');}
  const destination=path.join(scratch,`${mode}.wav`);await service.save(results[0].id,destination);assert.ok((await fs.stat(destination)).size>44);
  console.log(mode,'PASS',Date.now()-start,'ms');
 }
 assert.deepEqual(usage,['audio_music_separate','audio_tools_save','audio_noise_remove','audio_tools_save']);
 if((process.env.SMOOTHY_AUDIO_TEST_BACKEND||'cuda')==='cuda'){
  const workerBundle=path.join(scratch,'worker-source.cjs');
  await build({entryPoints:['src/main/local-audio-worker.ts'],bundle:true,platform:'node',format:'cjs',outfile:workerBundle});
  const {AUDIO_WORKER}=require(workerBundle),faultWorker=path.join(scratch,'gpu-fault.py');
  await fs.writeFile(faultWorker,AUDIO_WORKER.replace('original_session = ort.InferenceSession',`real_session = ort.InferenceSession
def original_session(*args, **kwargs):
    if 'CUDAExecutionProvider' in kwargs.get('providers',[]):
        raise RuntimeError('Synthetic GPU initialization failure')
    return real_session(*args, **kwargs)`));
  service.deps.run=(command,args,signal,progress,env)=>runAudioCommand(command,args[1]==='separate'?[faultWorker,...args.slice(1)]:args,signal,progress,env);
  const before=usage.length,events=[];
  const fallback=await service.process({source:source.id,mode:'separate'},data=>{events.push(data);console.log('fallback',data)});
  assert.deepEqual(fallback.map(item=>item.kind),['speech','music']);
  assert.ok(events.some(item=>typeof item==='string'&&item.includes('Retrying on CPU')));
  assert.ok(events.some(item=>item.backend==='cpu'&&item.message.startsWith('Processed with')));
  assert.deepEqual(usage.slice(before),['audio_music_separate']);
  console.log('REAL GPU FAILURE → CPU FALLBACK / SINGLE SUCCESS COUNTER PASS');
 }
 const count=usage.length;
 await assert.rejects(service.process({source:source.id,mode:'enhance'},message=>{if(message==='Removing background noise…')service.cancel();}));
 assert.equal(usage.length,count);console.log('REAL MODEL CANCELLATION PASS');
 console.log('REAL MODELS / WAV SAVE / COUNTERS PASS');
}finally{await service.dispose();await fs.rm(scratch,{recursive:true,force:true});}
