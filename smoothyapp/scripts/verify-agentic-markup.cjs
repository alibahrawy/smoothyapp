// Native Electron check: drawing on the playing review video and adding a note sends
// the agent a screenshot of the marked frame. Uses a real video through a
// smoothy-preview:// protocol registered like the app's.
// Run: npm run build && npx electron scripts/verify-agentic-markup.cjs
const { app, BrowserWindow, session, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-agentic-markup-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-agentic-markup'); fs.mkdirSync(captures, { recursive: true });
const ffmpeg = require(path.join(root, 'node_modules/ffmpeg-static'));
const video = path.join(scratch, 'clip.mp4');
execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video]);
const framePng = path.join(scratch, 'frame.png');
execFileSync(ffmpeg, ['-loglevel', 'error', '-ss', '0', '-i', video, '-frames:v', '1', framePng]);
const frameDataUrl = `data:image/png;base64,${fs.readFileSync(framePng).toString('base64')}`;

protocol.registerSchemesAsPrivileged([{ scheme: 'smoothy-preview', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');const added=[];
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?()=>()=>{}:async()=>({})]));
Object.assign(api,{getAuthState:async()=>({user:{id:'p',email:'p@example.test',tier:'pro'}}),canUseFeature:async()=>({allowed:true}),getStatus:async()=>({connected:false}),getActiveNLE:async()=>({activeNLE:'premiere'}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=>'3.0.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getBridgeStatus:async()=>({cep:{installed:true}}),
 agentState:async()=>({enabled:true,running:true,url:'http://127.0.0.1:1',token:'t',tools:[],activity:[]}),
 agentPickFile:async()=>({path:${JSON.stringify(video)}}),agentPreviewClear:async()=>({ok:true}),
 agentProbe:async()=>({ok:true,data:{probe:{duration:4,video:{fps:30,width:1280,height:720}}}}),
 agentMedia:async()=>({ok:true,imageDataUrl:${JSON.stringify(frameDataUrl)},data:{timecode:'00:00:00:00'}}),
 agentReviewList:async()=>({ok:true,data:{threads:[],counts:{}}}),
 agentReviewAdd:async(input)=>{added.push(input);return {ok:true,data:{thread:{id:'n1'}}}},
 __added:()=>added.map(a=>({body:a.body,strokes:(a.drawing||[]).length,shot:a.screenshotDataUrl||null}))});
contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  protocol.handle('smoothy-preview', () => net.fetch(pathToFileURL(video).toString()));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { preload, contextIsolation: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(captures, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(700); win.showInactive();
    await js(`document.querySelector('[data-tab="agentic"]').click()`); await pause(300);
    await js(`document.getElementById('agentic-open-file').click()`);
    for (let i = 0; i < 40 && !(await js(`document.getElementById('agentic-preview-frame').classList.contains('video-mode')`)); i++) await pause(100);
    assert.equal(await js(`document.getElementById('agentic-preview-frame').classList.contains('video-mode')`), true, 'the video player is showing');
    await js(`document.getElementById('agentic-play').click()`); await pause(700);
    // Draw a box on the playing video.
    await js(`document.querySelector('[data-agentic-tool="rect"]').click()`); await pause(80);
    const r = await js(`(()=>{const b=document.getElementById('agentic-markup').getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`);
    const a = { x: Math.round(r.x + r.w * 0.3), y: Math.round(r.y + r.h * 0.3) }, b = { x: Math.round(r.x + r.w * 0.6), y: Math.round(r.y + r.h * 0.65) };
    mouse('mouseDown', a.x, a.y); for (let i = 1; i <= 6; i++) { mouse('mouseMove', a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6); await pause(16); } mouse('mouseUp', b.x, b.y); await pause(150);
    assert.equal(await js(`document.getElementById('agentic-video').paused`), true, 'drawing pauses the video');
    await js(`(()=>{const t=document.getElementById('agentic-note-body');t.value='Crop this out';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await shot('marked-video');
    await js(`document.getElementById('agentic-note-add').click()`);
    for (let i = 0; i < 30 && !(await js(`window.electronAPI.__added().length`)); i++) await pause(100);
    const added = await js(`window.electronAPI.__added()`);
    assert.equal(added.length, 1, 'the note reached the agent');
    assert.equal(added[0].body, 'Crop this out');
    assert.equal(added[0].strokes, 1, 'the box drawing is sent');
    assert.match(added[0].shot || '', /^data:image\/png;base64,/, 'a screenshot of the marked frame is sent');
    fs.writeFileSync(path.join(captures, 'sent-to-agent.png'), Buffer.from(added[0].shot.split(',')[1], 'base64'));
    assert.deepEqual(errors, []);
    console.log('AGENTIC MARKUP OK', captures);
    app.exit(0);
  } catch (error) {
    console.error(error); await shot('failure').catch(() => {}); console.error('console errors:', errors); app.exit(1);
  }
});
