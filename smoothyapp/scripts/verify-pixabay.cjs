// Real shared-service Pixabay search/preview/download; no provider key in the app.
// Set SMOOTHY_STOCK_SERVICE_URL to the service endpoint to verify.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-pixabay-live-'));
app.setPath('userData', path.join(scratch, 'profile'));
const endpoint = process.env.SMOOTHY_STOCK_SERVICE_URL || '';
buildSync({ entryPoints: [path.join(root, 'src/main/stock-footage.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'stock.cjs'), define: { __SMOOTHY_STOCK_SERVICE_URL__: JSON.stringify(endpoint) } });
const { StockFootageService } = require(path.join(scratch, 'stock.cjs'));
app.whenReady().then(async () => {
  let win, exitCode = 0;
  try {
    assert.ok(endpoint, 'Supply a stock service endpoint.');
    let apiCalls = 0;
    const request = async (url, options) => { if (new URL(url).origin === new URL(endpoint).origin) apiCalls++; return fetch(url, options); };
    const cacheFolder = path.join(scratch, 'cache');
    const stock = new StockFootageService(request); stock.configurePixabayService(endpoint, cacheFolder);
    const results = await stock.search({ query: 'ocean', provider: 'pixabay' });
    assert.ok(results.videos.length, 'No eligible Pixabay clips.');
    const restarted = new StockFootageService(request); restarted.configurePixabayService(endpoint, cacheFolder);
    assert.equal((await restarted.search({ query: 'ocean', provider: 'pixabay' })).videos.length, results.videos.length);
    assert.equal(apiCalls, 1);
    const video = [...results.videos].sort((a,b)=>a.duration-b.duration)[0], file = video.files.at(-1);
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const html = path.join(scratch, 'preview.html'); fs.writeFileSync(html, '<!doctype html><video id="video" muted controls></video>'); await win.loadFile(html);
    const preview = url => win.webContents.executeJavaScript(`new Promise(resolve => {
      const v=document.getElementById('video');v.pause();const timer=setTimeout(()=>resolve({error:'Preview timeout'}),30000);
      v.onerror=()=>{clearTimeout(timer);resolve({error:'Preview failed'});};
      v.onloadedmetadata=async()=>{try{await v.play();const deadline=Date.now()+10000;while(v.currentTime<=.05&&Date.now()<deadline)await new Promise(done=>setTimeout(done,100));clearTimeout(timer);resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight,played:v.currentTime>.05});}catch{clearTimeout(timer);resolve({error:'Playback failed'});}};
      v.src=${JSON.stringify(url)};
    })`);
    const remote = await preview(file.link); assert.ok(remote.played, JSON.stringify(remote));
    console.log(JSON.stringify({search:'passed',clips:results.videos.length,cacheAcrossRestart:'passed',id:video.id,preview:remote}));
    await win.webContents.executeJavaScript(`document.getElementById('video').pause();document.getElementById('video').removeAttribute('src');document.getElementById('video').load()`);
    const saved = await stock.download(video.id, file.id, path.join(scratch, 'downloads'), new AbortController().signal, ()=>{});
    const decoded = spawnSync(path.join(root,'node_modules/ffmpeg-static/ffmpeg'),['-hide_banner','-loglevel','error','-i',saved,'-f','null','-'],{timeout:60000,encoding:'utf8'});
    assert.equal(decoded.status,0,'Native MP4 decoding failed.');
    const source = JSON.parse(fs.readFileSync(saved+'.source.json','utf8'));assert.equal(source.provider,'pixabay');assert.equal(source.license,'Pixabay Content License');
    const local = await preview('file://'+saved); assert.ok(local.played,JSON.stringify(local));assert.ok(Math.abs(local.duration-remote.duration)<1);
    console.log(JSON.stringify({download:'passed',bytes:fs.statSync(saved).size,nativeDecode:'passed',sourceTerms:'passed',localPlayback:'passed'}));
  } catch (error) { console.error(error.message || 'Pixabay check failed.'); exitCode = 1; }
  finally { win?.destroy();fs.rmSync(scratch,{recursive:true,force:true});app.exit(exitCode); }
});
