// Exercise actual local tool processing in normal Temp using synthetic media.
// No editor project, provider request, download, account, credits or usage events.
const {app,utilityProcess}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {build}=require('esbuild'),sharp=require('sharp');
const root=path.resolve(__dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'smoothy-tool-permission-'));
app.setPath('userData',path.join(scratch,'profile'));
const proof=process.env.SMOOTHY_REVIEW_DIR||path.resolve(root,'../docs/reviews/smoothyapp-tool-permission-audit');fs.mkdirSync(proof,{recursive:true});
const report={date:new Date().toISOString(),normalTemp:true,checks:[]};
const ffmpeg=path.join(root,'node_modules/ffmpeg-static/ffmpeg.exe');
const ffprobe=path.join(root,'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe');
const exec=(file,args,timeout=30000)=>new Promise((resolve,reject)=>{
 const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;
 const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
 const timer=setTimeout(()=>{child.kill();finish(Error('Helper timed out'));},timeout);
 child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2000));
 child.on('error',finish);child.on('close',code=>finish(code===0?undefined:Error(`Helper exit ${code}: ${stderr}`)));
});
async function moduleFor(name){
 const result=await build({entryPoints:[path.join(root,'src/main',name+'.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['electron','sharp','onnxruntime-node'],define:{__SMOOTHY_STOCK_SERVICE_URL__:'""'}});
 const output=path.join(scratch,name.replaceAll('/','-')+'.cjs');fs.writeFileSync(output,result.outputFiles[0].text);return require(output);
}
async function check(name,action){
 const start=Date.now();try{const details=await action();report.checks.push({name,passed:true,elapsedMs:Date.now()-start,...details});console.log('PASS',name);}
 catch(error){report.checks.push({name,passed:false,error:error.message});console.error('FAIL',name,error.message);}
}
async function mediaInfo(file){return JSON.parse(await exec(ffprobe,['-v','error','-show_entries','format=duration,size:stream=codec_name,channels,sample_rate,width,height','-of','json',file]));}
const signal=()=>new AbortController().signal;
const workerJob=job=>new Promise((resolve,reject)=>{
 const child=utilityProcess.fork(path.join(root,'out/main/assets-worker.js'),[],{stdio:'pipe'});let settled=false,tail='';
 const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve();};
 const timer=setTimeout(()=>finish(Error('Image utility timeout')),20000);
 child.stderr?.on('data',chunk=>tail=(tail+chunk).slice(-1000));
 child.on('spawn',()=>child.postMessage(job));
 child.on('message',message=>{if(message.type==='done')finish();else if(message.type==='error')finish(Error(message.error+' '+tail));});
 child.on('exit',code=>{if(!settled)finish(Error('Image utility exit '+code+' '+tail));});
});
app.whenReady().then(async()=>{
 try{
  const audio=path.join(scratch,'synthetic.wav'),video=path.join(scratch,'synthetic.mp4'),mp3=path.join(scratch,'synthetic.mp3');
  await exec(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-af',"volume=0:enable='between(t,1,2)'",'-ac','2','-ar','44100',audio]);
  await exec(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=3','-i',audio,'-c:v','libx264','-preset','ultrafast','-crf','5','-c:a','aac','-shortest',video]);
  await exec(ffmpeg,['-v','error','-i',audio,'-c:a','libmp3lame',mp3]);
  const extractor=await moduleFor('autocut/audio-extractor');
  let mono;
  await check('Captions/Multicam/Studio: real audio extraction to normal Temp',async()=>{
   mono=await extractor.extractAudioTrack(video,'permission-'+path.basename(scratch));const info=await mediaInfo(mono);
   assert.equal(info.streams[0].channels,1);assert.equal(info.streams[0].sample_rate,'16000');assert.ok(Number(info.format.duration)>=2.9);return {seconds:Number(info.format.duration)};
  });
  await check('Captions/Studio: real timeline audio stitch',async()=>{
   const result=await extractor.stitchTimelineAudio([{path:video,start:0,end:1,inPoint:0},{path:video,start:2,end:3,inPoint:2}],path.basename(scratch)+'-stitched');
   assert.ok((await fs.promises.stat(result.path)).size>44);assert.equal(result.clipCount,2);return {seconds:result.durationSeconds};
  });
  await check('Multicam: actual local VAD analysis',async()=>{
   assert.ok(mono);const vad=await moduleFor('autocut/vad-runner');const segments=await vad.runVad([{path:mono,speaker:'synthetic'}],3,true,signal());assert.ok(Array.isArray(segments));return {segments:segments.length};
  });
  await check('Silence Removal: native track mix and analysis',async()=>{
   const silence=await moduleFor('autocut/silence-detector');const mixed=await silence.combineAudioTracks([audio],signal());const result=await silence.analyzeSilence(mixed,-40,.4,.05,signal());assert.ok(result.originalDuration>=2.9);assert.ok(result.silenceRemoved>.5);return {seconds:result.originalDuration,silenceRemoved:result.silenceRemoved};
  });
  await check('Resolve: native source-channel microphone render',async()=>{
   const resolve=await moduleFor('resolve/audio');const output=path.join(scratch,'resolve-microphone.wav');
   await resolve.renderResolveMicrophone({clips:[{path:video,name:'Synthetic',channel:1,inPoint:0,start:0,end:3}]},output,3,signal());const info=await mediaInfo(output);assert.equal(info.streams[0].channels,1);assert.ok(Number(info.format.duration)>=2.9);return {seconds:Number(info.format.duration)};
  });
  await check('Stock Footage: native MP4 conversion/save',async()=>{
   const stock=await moduleFor('stock-footage'),output=path.join(scratch,'stock.mp4');await stock.convertStockVideo(video,output,signal());const info=await mediaInfo(output);assert.equal(info.streams[0].codec_name,'h264');assert.ok(Number(info.format.size)>0);return {seconds:Number(info.format.duration)};
  });
  await check('Audio Library: complete MP3 decode and probe',async()=>{
   const library=await moduleFor('audio-library');const duration=await library.validateMP3(mp3);assert.ok(duration>=2.9);return {seconds:duration};
  });
  await check('Compressor: real CPU HEVC output and probe',async()=>{
   const {videoCompressor}=await moduleFor('compressor/video-compressor');const result=await videoCompressor.compressBatch([{path:video,name:'synthetic.mp4',size:fs.statSync(video).size}],{encoder:'libx265',quality:'fast',outputFolder:path.join(scratch,'compressed')});
   assert.equal(result.stats.failed,0);assert.equal(result.stats.completed,1);assert.equal(result.results[0].success,true);const info=await mediaInfo(result.results[0].outputPath);assert.equal(info.streams[0].codec_name,'hevc');return {seconds:Number(info.format.duration)};
  });
  await check('Captions: cached Whisper CPU inference and JSON write in normal Temp',async()=>{
   const base=path.join(process.env.APPDATA,'smoothyedit'),binary=path.join(base,'whisper-bin/cpu/whisper-cpp-win32-x64-cpu.exe'),model=path.join(base,'whisper-models/ggml-base.bin');
   assert.ok(fs.existsSync(binary)&&fs.existsSync(model),'Cached engine/model missing; no download attempted');assert.ok(mono);
   const output=path.join(scratch,'caption-native');await exec(binary,['-m',model,'-f',mono,'-l','en','-oj','-of',output,'-t','4','-ng'],45000);const parsed=JSON.parse(fs.readFileSync(output+'.json','utf8'));assert.ok(Array.isArray(parsed.transcription));return {jsonSaved:true};
  });
  const python=path.join(process.env.LOCALAPPDATA,'SmoothyEdit/audio-engine/runtime/Scripts/python.exe');
  const generate=String.raw`import onnx,sys,os
from onnx import helper as h, TensorProto as T
root=sys.argv[1]
def save(name,shape,node,output_shape,initializers=[]):
 m=h.make_model(h.make_graph([node],name,[h.make_tensor_value_info('x',T.FLOAT,shape)],[h.make_tensor_value_info('y',T.FLOAT,output_shape)],initializer=initializers),opset_imports=[h.make_opsetid('',13)])
 m.ir_version=8
 onnx.save(m,os.path.join(root,name+'.onnx'))
save('cutout',[1,3,1024,1024],h.make_node('ReduceMean',['x'],['y'],axes=[1],keepdims=1),[1,1,1024,1024])
save('upscale',[1,3,128,128],h.make_node('Resize',['x','roi','scales'],['y'],mode='nearest'),[1,3,512,512],[h.make_tensor('roi',T.FLOAT,[0],[]),h.make_tensor('scales',T.FLOAT,[4],[1,1,4,4])])`;
  await exec(python,['-c',generate,scratch]);
  const image=path.join(scratch,'image.png');await sharp({create:{width:8,height:8,channels:4,background:'#89acbb'}}).png().toFile(image);
  for(const [operation,factor,model] of [['remove-background',1,'cutout'],['upscale',2,'upscale'],['upscale',4,'upscale']]){
   await check(`Assets: real Electron utility ${operation} ${factor}x PNG write (fixture model)`,async()=>{
    const output=path.join(scratch,operation+factor+'.png');await workerJob({operation,factor,model:path.join(scratch,model+'.onnx'),input:image,output});const info=await sharp(output).metadata();assert.equal(info.width,8*factor);assert.equal(info.height,8*factor);assert.equal(info.hasAlpha,true);return {width:info.width,height:info.height,fixtureModel:true};
   });
  }
 }catch(error){report.preparationError=error.message;console.error(error);}
 finally{report.passed=!report.preparationError&&report.checks.every(item=>item.passed);fs.writeFileSync(path.join(proof,'tool-runtime-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(report.passed?0:1);}
}).catch(error=>{console.error(error);app.exit(1);});
