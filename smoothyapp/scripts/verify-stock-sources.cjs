// Live keyless providers, remote previews and complete native MP4 conversion.
// Run: node node_modules/electron/cli.js scripts/verify-stock-sources.cjs
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-stock-live-'));
app.setPath('userData', path.join(scratch, 'profile'));
buildSync({ entryPoints: [path.join(root, 'src/main/stock-footage.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'stock.cjs') });
const { StockFootageService } = require(path.join(scratch, 'stock.cjs'));
app.once('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
  let win;
  try {
    const stock = new StockFootageService(async (url, options) => {
      const response = await fetch(url, options);
      if (response.status >= 300 && response.status < 400) console.log('Media redirect: '+response.headers.get('location'));
      return response;
    });
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const html = path.join(scratch, 'preview.html'); fs.writeFileSync(html, '<!doctype html><video id="video" muted controls></video>'); await win.loadFile(html);
    const preview = url => win.webContents.executeJavaScript(`new Promise(resolve => {
      const v=document.getElementById('video'); v.pause();let timer=setTimeout(()=>resolve({error:'Preview timeout'}),30000);
      v.onloadedmetadata=()=>{clearTimeout(timer);resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight});};
      v.onerror=()=>{clearTimeout(timer);resolve({error:v.error?.message});};v.src=${JSON.stringify(url)};
    })`);
    for (const [provider, query] of [['archive','lava'],['nasa','earth']]) {
      const results=await stock.search({query,provider});assert.ok(results.videos.length,provider+' had no eligible videos');
      console.log(provider+': '+results.videos.length+' eligible videos; more='+results.hasMore);
      const video=[...results.videos].filter(video=>video.duration>0).sort((a,b)=>a.duration-b.duration)[0] || results.videos[0];
      const file=video.files.find(file=>file.label==='Preview MP4') || video.files.at(-1);
      const remote=await preview(file.link);assert.ok(remote.duration>0,JSON.stringify(remote));
      console.log(provider+' preview: '+video.title+'; '+JSON.stringify(remote));
      await win.webContents.executeJavaScript(`document.getElementById('video').pause();document.getElementById('video').removeAttribute('src');document.getElementById('video').load()`);
      const saved=await stock.download(video.id,file.id,path.join(scratch,'downloads'),new AbortController().signal,()=>{});
      const decoded=spawnSync(path.join(root,'node_modules/ffmpeg-static/ffmpeg'),['-hide_banner','-loglevel','error','-i',saved,'-f','null','-'],{timeout:120000,encoding:'utf8'});
      assert.equal(decoded.status,0,decoded.stderr || decoded.error?.message);
      const source=JSON.parse(fs.readFileSync(saved+'.source.json','utf8'));assert.equal(source.provider,provider);assert.equal(source.usage,video.usage);
      const local=await preview('file://'+saved);assert.ok(local.duration>0,JSON.stringify(local));assert.ok(Math.abs(local.duration-remote.duration)<1);
      console.log('PASS '+provider+': remote preview, '+fs.statSync(saved).size+'-byte persistent MP4, native full decode, usage notes and local preview.');
    }
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
  finally { win?.destroy(); fs.rmSync(scratch,{recursive:true,force:true}); }
});
