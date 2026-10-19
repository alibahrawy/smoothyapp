// Real Electron custom-protocol playback; synthetic WAV by default, or an explicit
// existing local WAV via SMOOTHY_AUDIO_PROTOCOL_FILE. No model/provider/telemetry.
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-audio-protocol-'));
app.setPath('userData', path.join(scratch, 'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'smoothy-local-audio',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
const sampleRate=44100,samples=sampleRate*64,wav=Buffer.alloc(44+samples*4);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*4,40);
const fixture=path.join(scratch,'fixture.wav');fs.writeFileSync(fixture,wav);
const file=process.env.SMOOTHY_AUDIO_PROTOCOL_FILE || fixture;
const report={requests:[],events:[]};
app.whenReady().then(async()=>{
 const built=await require('esbuild').build({entryPoints:[path.join(__dirname,'../src/main/local-audio-response.ts')],bundle:true,platform:'node',format:'cjs',write:false});
 const modulePath=path.join(scratch,'response.cjs');fs.writeFileSync(modulePath,built.outputFiles[0].text);
 const {localAudioResponse}=require(modulePath);
 protocol.handle('smoothy-local-audio',async request=>{
  const item={headers:Object.fromEntries(request.headers)};report.requests.push(item);
  try {const response=await localAudioResponse(file,request);item.status=response.status;item.responseHeaders=Object.fromEntries(response.headers);return response;}
  catch(error){item.error=error.message;throw error;}
 });
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.setAudioMuted(true);
  const html=path.join(scratch,'index.html');
  fs.writeFileSync(html,`<audio preload="metadata" src="smoothy-local-audio://result/00000000-0000-0000-0000-000000000000"></audio>`);
  try {
    await win.loadFile(html);
    await new Promise(resolve=>setTimeout(resolve,1500));
    report.before=await win.webContents.executeJavaScript(`(()=>{const a=document.querySelector('audio');return {duration:a.duration,ready:a.readyState,network:a.networkState,error:a.error?.message};})()`);
    await win.webContents.executeJavaScript(`window.playResult='pending';document.querySelector('audio').play().then(()=>window.playResult='playing',e=>window.playResult=e.message);`);
    await new Promise(resolve=>setTimeout(resolve,2000));
    report.after=await win.webContents.executeJavaScript(`(()=>{const a=document.querySelector('audio');return {playResult:window.playResult,duration:a.duration,time:a.currentTime,ready:a.readyState,network:a.networkState,error:a.error?.message};})()`);
    assert.ok(Number.isFinite(report.before.duration) && report.before.duration>60);
    assert.equal(report.after.playResult,'playing');assert.ok(report.after.time>0.5);
    await win.webContents.executeJavaScript(`document.querySelector('audio').currentTime=40;`);
    await new Promise(resolve=>setTimeout(resolve,700));
    report.seek=await win.webContents.executeJavaScript(`(()=>{const a=document.querySelector('audio');return {duration:a.duration,time:a.currentTime,seeking:a.seeking,paused:a.paused,error:a.error?.message};})()`);
    assert.ok(report.seek.time>=40 && report.seek.time<43);assert.equal(report.seek.seeking,false);assert.equal(report.seek.paused,false);
    assert.ok(report.requests.some(r=>r.status===206 && r.responseHeaders['content-range']));
    report.passed=true;
    console.log(JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(process.env.SMOOTHY_REVIEW_DIR || scratch,'protocol-control.json'),JSON.stringify(report,null,2));
  } finally {win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
