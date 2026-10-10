// Native Electron renderer checks; mocked adapters never call remote services or Premiere.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-assets-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');const callbacks={},calls=[];let clipboardData;
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?callback=>{(callbacks[name]||=[]).push(callback);}:async(...args)=>{calls.push({name,args});return {};} ]));
Object.assign(api,{getAuthState:async()=>({user:null}),getStatus:async()=>({connected:false}),getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=> '2.0.0',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getCaptionEngine:async()=> 'cpu',getShowLogs:async()=>false,getAlwaysOnTop:async()=>false,getBridgeStatus:async()=>({cep:{installed:true}}),assetsGetOutputFolder:async()=>'/fixture/assets',
 assetsProcessImage:input=>ipcRenderer.invoke('fixture-process',input),assetsCancelProcessing:()=>ipcRenderer.invoke('fixture-cancel'),trackMediaPreview:async kind=>{calls.push({name:'trackMediaPreview',args:[kind]});},__calls:()=>calls,
 __progress:data=>{for(const callback of callbacks.onAssetsProcessingProgress||[])callback(data);},
 assetsReadClipboard:async()=>clipboardData,__clipboard:input=>{clipboardData=input;},
 assetsSavePng:async input=>{calls.push({name:'assetsSavePng',args:[input]});return {success:true};}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = process.env.ASSETS_REVIEW_DIR || path.resolve(root, '../docs/reviews/smoothyapp-v2-assets-local');
let mode = 'success', resolveProcess;
ipcMain.handle('fixture-process', async (_, input) => {
  if (mode === 'failure') return { success: false, error: 'Fixture model failed' };
  if (mode === 'pending') return new Promise(resolve => resolveProcess = resolve);
  const source = sharp(Buffer.from(input.bytes)); const info = await source.metadata();
  const factor = input.operation === 'upscale' ? input.factor : 1;
  return { success: true, bytes: new Uint8Array(await source.resize(info.width * factor, info.height * factor).png().toBuffer()) };
});
ipcMain.handle('fixture-cancel', () => { resolveProcess?.({ canceled: true }); return { success: true }; });
app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({ width: 1000, height: 740, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const until = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await pause(30); } throw new Error('Timeout: ' + code); };
  try {
    await win.loadFile(process.env.ASSETS_RENDERER_FILE || path.join(root, 'out/renderer/index.html')); await pause(250);
    await js(`document.querySelector('[data-tab="assets"]').click()`); await pause(350);
    assert.equal(await js(`document.getElementById('assets-input-section').classList.contains('hidden')`), false);
    assert.equal(await js(`document.querySelector('.assets-tools-section').getBoundingClientRect().height > 0`), true);
    for (const id of ['assets-remove-background-btn', 'assets-upscale-btn']) {
      assert.equal(await js(`document.getElementById('${id}').disabled`), true);
      assert.equal(await js(`document.getElementById('${id}').getBoundingClientRect().width > 0`), true);
    }
    assert.match(await js(`document.getElementById('assets-empty-guide').textContent`), /Remove background/);
    assert.match(await js(`document.getElementById('assets-empty-guide').textContent`), /Upscale 2× or 4×/);
    for (const platform of ['macos', 'windows']) for (const size of [[1000, 740], [600, 500]]) for (const collapsed of [false, true]) {
      win.setContentSize(...size);
      await js(`document.body.classList.remove('platform-macos','platform-windows');document.body.classList.add('platform-${platform}');if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);
      await pause(250);
      for (const id of ['assets-remove-background-btn', 'assets-upscale-btn']) assert.equal(await js(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return r.top>=38&&r.bottom<innerHeight&&r.left>=0&&r.right<=innerWidth;})()`), true);
    }
    win.setContentSize(1000, 740); await pause(250);
    fs.mkdirSync(proof, { recursive: true }); fs.writeFileSync(path.join(proof, 'assets-empty-ui.png'), (await win.webContents.capturePage()).toPNG());
    const source = process.env.ASSETS_MODEL_FIXTURE ? await sharp(path.join(process.env.ASSETS_MODEL_FIXTURE, 'sample.jpg')).resize({ width: 335 }).png().toBuffer()
      : await sharp({ create: { width: 335, height: 597, channels: 4, background: '#db943c' } }).png().toBuffer();
    await js(`window.electronAPI.__clipboard({hasImage:true,name:'image.png',base64:${JSON.stringify(source.toString('base64'))},mime:'image/png'});document.getElementById('assets-paste-btn').click()`);
    await until(`document.getElementById('assets-preview-img').naturalWidth > 0`);
    assert.equal(await js(`document.getElementById('assets-input-section').classList.contains('hidden')`), true);
    assert.equal(await js(`document.getElementById('assets-preview-section').classList.contains('hidden')`), false);
    assert.equal(await js(`window.electronAPI.__calls().filter(x=>x.name==='trackMediaPreview').length`), 1);
    for (const platform of ['macos', 'windows']) for (const size of [[1000, 740], [600, 500], [1920, 1080]]) for (const collapsed of [false, true]) {
      win.setContentSize(...size);
      await js(`document.body.classList.remove('platform-macos','platform-windows');document.body.classList.add('platform-${platform}');if(document.querySelector('.app-container').classList.contains('sidebar-collapsed')!==${collapsed})document.getElementById('sidebar-toggle-btn').click()`);
      await pause(250);
      const layout = await js(`(()=>{const frame=document.querySelector('.assets-preview-frame').getBoundingClientRect(),img=document.getElementById('assets-preview-img').getBoundingClientRect(),scroll=document.querySelector('#tab-assets .content-scroll');return {width:frame.width,height:frame.height,imgWidth:img.width,imgHeight:img.height,overflow:scroll.scrollWidth>scroll.clientWidth};})()`);
      assert.equal(layout.overflow, false); assert.ok(layout.width > 150 && layout.height >= 220); assert.equal(layout.imgWidth, layout.width - 2); assert.equal(layout.imgHeight, layout.height - 2);
    }
    win.setContentSize(1000, 740); await pause(100);
    fs.mkdirSync(proof, { recursive: true }); fs.writeFileSync(path.join(proof, 'assets-preview-ui.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await js(`window.electronAPI.__calls().filter(x=>x.name==='trackMediaPreview').length`), 1);
    mode = 'pending';
    await js(`document.getElementById('assets-remove-background-btn').click()`);
    await until(`!document.getElementById('assets-process-cancel-btn').classList.contains('hidden')`);
    await js(`window.electronAPI.__progress({message:'Downloading BiRefNet · 50%',percent:50})`);
    assert.equal(await js(`document.getElementById('assets-process-progress').value`), 50);
    assert.equal(await js(`document.getElementById('assets-clear-btn').disabled`), true);
    assert.equal(await js(`document.getElementById('assets-replace-btn').disabled`), true);
    await pause(50); await js(`document.getElementById('assets-process-cancel-btn').click()`);
    await until(`document.getElementById('assets-process-status').textContent.includes('Canceled')`);
    assert.equal(await js(`document.getElementById('assets-file-name').textContent`), 'image.png');
    mode = 'failure'; await js(`document.getElementById('assets-upscale-btn').click()`);
    await until(`document.getElementById('assets-process-status').textContent.includes('failed')`);
    assert.equal(await js(`document.getElementById('assets-file-name').textContent`), 'image.png');
    mode = 'success'; await js(`document.getElementById('assets-upscale-factor').value='4';document.getElementById('assets-upscale-btn').click()`);
    await until(`document.getElementById('assets-file-name').textContent.includes('-4x')`);
    assert.equal(await js(`document.getElementById('assets-preview-img').naturalWidth`), 1340);
    await js(`document.getElementById('assets-saveas-btn').click()`);
    await until(`window.electronAPI.__calls().some(x=>x.name==='assetsSavePng')`);
    assert.equal(await js(`window.electronAPI.__calls().find(x=>x.name==='assetsSavePng').args[0].fileName`), 'image-4x.png');
    await until(`!document.getElementById('assets-restore-btn').disabled`);
    await js(`document.getElementById('assets-restore-btn').click()`);
    await until(`document.getElementById('assets-preview-img').naturalWidth === 335`);
    assert.equal(await js(`document.getElementById('assets-file-name').textContent`), 'image.png');
    await js(`document.getElementById('assets-background').value='white';document.getElementById('assets-remove-background-btn').click()`);
    await until(`document.getElementById('assets-file-name').textContent.includes('-cutout')`);
    assert.equal(await js(`document.getElementById('assets-background').value`), 'transparent');
    await until(`!document.getElementById('assets-clear-btn').disabled`);
    await js(`document.getElementById('assets-clear-btn').click()`);
    assert.equal(await js(`document.getElementById('assets-input-section').classList.contains('hidden')`), false);
    assert.equal(await js(`document.getElementById('assets-preview-section').classList.contains('hidden')`), true);
    assert.deepEqual(errors, []);
    console.log('Assets native UI: paste/replacement, 24 layouts, decoded preview count, progress/cancel/failure, 4× result/export, restore, transparency and clear passed.');
  } catch (error) { console.error(error, errors); process.exitCode = 1; }
  finally { win.destroy(); fs.rmSync(scratch, { recursive: true, force: true }); app.quit(); }
});
