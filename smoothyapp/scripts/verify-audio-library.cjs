// Real MP3 validation, session polling, persistence and Electron audio preview.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-audio-real-'));
for (const name of ['music','downloads','userData']) { const dir=path.join(scratch,name);fs.mkdirSync(dir);app.setPath(name,dir); }
const ffmpeg=path.join(root,'node_modules/ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
const sample=path.join(scratch,'sample.mp3');
execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','libmp3lame',sample]);
buildSync({entryPoints:[path.join(root,'src/main/audio-library-ipc.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(scratch,'audio.cjs')});
const {registerAudioLibrary}=require(path.join(scratch,'audio.cjs'));
const handlers=new Map();const original=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,handler)=>{handlers.set(name,handler);original(name,handler);};
const invoke=(name,options)=>handlers.get('audio-library-'+name)(null,options);
let choice={canceled:true},opened=[];dialog.showOpenDialog=async()=>choice;shell.openExternal=async url=>{opened.push(url);};
let win;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.once('will-quit',()=>fs.rmSync(scratch,{recursive:true,force:true}));
app.whenReady().then(async()=>{
 try {
  win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  const values=new Map();let imported;
  await registerAudioLibrary({store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v)},window:()=>win,connected:()=>true,importToPremiere:async file=>{imported=file;return {success:true};}});
  await invoke('open');assert.deepEqual(opened,['https://studio.youtube.com/channel/UC/music']);
  const downloaded=path.join(app.getPath('downloads'),'Test Tone.mp3');fs.copyFileSync(sample,downloaded);
  await pause(8200);const state=await invoke('state');assert.equal(state.candidates.length,1);
  const saved=await invoke('keep',{id:state.candidates[0].id,title:'Test Tone',artist:'Fixture',license:'unverified',credit:'Generated test tone'});assert.equal(saved.success,true);
  fs.unlinkSync(downloaded);const track=saved.tracks[0];assert.equal(track.credit,'Generated test tone');
  const html=path.join(scratch,'preview.html');fs.writeFileSync(html,'<!doctype html><audio id="player" controls></audio>');await win.loadFile(html);
  const result=await win.webContents.executeJavaScript(`new Promise(resolve=>{const a=document.getElementById('player');let timer=setTimeout(()=>resolve({error:'timeout'}),10000);a.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve({duration:a.duration});},{once:true});a.addEventListener('error',()=>{clearTimeout(timer);resolve({error:a.error.message});},{once:true});a.src=${JSON.stringify(track.previewUrl)};})`);
  assert.ok(result.duration>=2,JSON.stringify(result));
  const seek=await win.webContents.executeJavaScript(`new Promise(resolve=>{const a=document.getElementById('player');let timer=setTimeout(()=>resolve(false),10000);a.addEventListener('seeked',()=>{clearTimeout(timer);resolve(a.currentTime>0.9);},{once:true});a.currentTime=1;})`);assert.equal(seek,true);
  assert.equal((await invoke('import',track.id)).imported,true);assert.deepEqual(fs.readFileSync(imported),fs.readFileSync(sample));
  await invoke('stop');assert.equal((await invoke('state')).watching,false);
  console.log('PASS: actual MP3 download detection, FFmpeg validation, persistent copy/credits, audio metadata + seek through restricted Electron protocol, and import path. Studio opening and Premiere import mocked.');
 } catch(error) {console.error(error);process.exitCode=1;} finally {win?.destroy();app.quit();}
});
