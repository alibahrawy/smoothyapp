// Real Electron renderer + update service, with release/download/install adapters only.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-update-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
app.once('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const servicePath = path.join(scratch, 'update-service.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/update-service.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: servicePath });
const { createUpdateService } = require(servicePath);
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(match => match[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>ipcRenderer.on(name,(_e,data)=>fn(data)):(...args)=>ipcRenderer.invoke('fixture-call',name,args)]));contextBridge.exposeInMainWorld('electronAPI',api);`);
const saved = new Map(), updater = new EventEmitter(), calls = [], errors = [];
const notes = '## Bug fixes\n- Preserve **clip effects** and continuous audio.\n## New features\n- Review release notes and skip any version.\n- <img src=x onerror=alert(1)> is text, not executable markup.';
let win, release = '2.0.1', externalFailure = false;
updater.checkForUpdates = async () => { calls.push({name:'release-check'}); updater.emit('checking-for-update'); updater.emit('update-available', {version:release}); };
updater.downloadUpdate = async () => { calls.push({name:'download'}); updater.emit('download-progress',{percent:45}); };
updater.quitAndInstall = () => calls.push({name:'restart'});
const service = createUpdateService({updater,store:{get:key=>saved.get(key),set:(key,value)=>saved.set(key,value),delete:key=>saved.delete(key)},packaged:true,fetchNotes:async()=>notes,send:state=>win?.webContents.send('onUpdateStatus',state)});
ipcMain.handle('fixture-call', (_event, name, args) => {
  calls.push({name,args});
  if(name==='openExternal' && externalFailure)throw Error('No email handler');
  const canned = {getAuthState:{user:null},getStatus:{connected:false},getWebsiteConnectionStatus:{connected:false},getAppVersion:'2.0.0',getCaptionModels:[],getCaptionLanguages:[],getCaptionEngine:'cpu',getBridgeStatus:{cep:{installed:true}},assetsGetOutputFolder:'/fixture/assets',audioLibraryState:{success:true,tracks:[],candidates:[],watching:false},audioArchiveSearch:{success:true,tracks:[],categories:[],moods:[],total:0,hasMore:false},stockGetSettings:{pixabayEnabled:true,folder:'/fixture/stock'}};
  if(name==='getUpdateState')return service.snapshot();
  if(name==='checkForUpdates')return service.check(true);
  if(name==='skipUpdate')return service.skip(...args);
  if(name==='installUpdate')return service.install(...args);
  return canned[name] ?? {};
});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  win=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const js = code=>win.webContents.executeJavaScript(code);
  const click = async id=>{await js(`document.getElementById(${JSON.stringify(id)}).focus();document.getElementById(${JSON.stringify(id)}).click()`);await pause(40);};
  const hidden = id=>js(`document.getElementById(${JSON.stringify(id)}).classList.contains('hidden')`);
  const captures=process.env.SMOOTHY_REVIEW_DIR || path.join(root,'..','docs','reviews','smoothyapp-v2');fs.mkdirSync(captures,{recursive:true});
  try{
    await win.loadFile(process.env.SMOOTHY_TEST_RENDERER || path.join(root,'out/renderer/index.html'));await pause(250);
    await service.check();await pause(40);
    assert.equal(await hidden('update-bar'),false);assert.equal(await hidden('update-modal'),true);assert.equal(calls.filter(c=>c.name==='download').length,0);
    for(const windows of [false,true])for(const [width,height]of[[900,700],[600,500]]){
      win.setSize(width,height);win.webContents.send('onPlatformInfo',{isMac:!windows,isWindows:windows,isExpanded:false});await pause(70);
      await click('update-bar-btn');await pause(450);assert.equal(await hidden('update-modal'),false);
      assert.match(await js(`document.getElementById('update-modal-body').textContent`),/Bug fixes/);assert.match(await js(`document.getElementById('update-modal-body').textContent`),/New features/);
      assert.equal(await js(`document.querySelector('#update-modal-body img')`),null);
      assert.equal(await js(`document.activeElement.id`),'update-modal-close');
      const bounds=await js(`(()=>{const el=document.getElementById('update-modal-install'),r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,right:r.right,width:innerWidth,height:innerHeight}})()`);
      assert.ok(bounds.top>=0 && bounds.bottom<=bounds.height && bounds.right<=bounds.width,JSON.stringify(bounds));
      if(!windows)fs.writeFileSync(path.join(captures,`update-details-${width}x${height}.png`),(await win.webContents.capturePage()).toPNG());
      await click('update-modal-close');assert.equal(await hidden('update-modal'),true);
      assert.equal(await js(`document.activeElement.id`),'update-bar-btn');
    }
    await click('update-bar-btn');release='2.0.2';await service.check(true);await pause(40);
    assert.equal(await js(`document.getElementById('update-modal-version').textContent`),'2.0.2');
    release='2.0.1';await service.check(true);await pause(40);
    await click('update-modal-later');assert.equal(service.snapshot().status,'skipped');assert.equal(await hidden('update-bar'),true);assert.equal(calls.filter(c=>c.name==='download').length,0);
    await win.reload();await pause(250);assert.equal(await hidden('update-bar'),true);
    await click('settings-btn');assert.match(await js(`document.getElementById('settings-update-status').textContent`),/Skipped v2.0.1/);
    await click('settings-install-update-btn');assert.equal(await hidden('update-modal'),false);
    await click('update-modal-install');assert.equal(service.snapshot().status,'downloading');assert.equal(await js(`document.getElementById('update-modal-later').disabled`),true);assert.equal(calls.filter(c=>c.name==='restart').length,0);
    updater.emit('error',new Error('Network disconnected'));await pause(40);assert.match(await js(`document.getElementById('update-modal-status').textContent`),/Network disconnected/);
    await click('update-modal-install');assert.equal(calls.filter(c=>c.name==='download').length,2);
    updater.emit('update-downloaded',{version:'2.0.1'});await pause(40);assert.match(await js(`document.getElementById('update-modal-install').textContent`),/Restart & Install/);assert.equal(calls.filter(c=>c.name==='restart').length,0);
    await click('update-modal-later');assert.equal(service.snapshot().status,'skipped');
    await click('check-update-btn');assert.equal(service.snapshot().status,'available');
    await click('settings-install-update-btn');await click('update-modal-install');assert.equal(calls.filter(c=>c.name==='restart').length,1);
    await click('update-modal-close');
    // A real updater failure with an unbroken path must stay within its card.
    updater.emit('error',new Error("ENOENT: no such file or directory, open '/Users/fixture/"+'long-directory-name/'.repeat(35)+"app-update.yml'"));await pause(40);
    const layouts=[];
    for(const windows of [false,true])for(const [width,height]of[[600,500],[1000,740],[1680,1050],[2560,1440]]){
      win.setSize(width,height);win.webContents.send('onPlatformInfo',{isMac:!windows,isWindows:windows,isExpanded:width>1000});await pause(100);
      await click('settings-btn');
      const bounds=await js(`(()=>{const body=document.getElementById('settings-body'),header=document.querySelector('#settings-modal .modal-header'),hr=header.getBoundingClientRect(),sr=document.getElementById('settings-update-status').getBoundingClientRect(),ur=document.querySelector('#settings-update-section .update-status-row').getBoundingClientRect();return{width:innerWidth,height:innerHeight,headerHeight:hr.height,headerTop:hr.top,bodyWidth:body.clientWidth,bodyOverflow:body.scrollWidth>body.clientWidth,columns:getComputedStyle(body).gridTemplateColumns.split(' ').length,sectionOverflow:[...body.querySelectorAll('.settings-section')].filter(e=>e.getClientRects().length).some(e=>e.scrollWidth>e.clientWidth),statusFits:sr.left>=ur.left&&sr.right<=ur.right&&sr.bottom<=ur.bottom,titleSize:getComputedStyle(document.getElementById('settings-title')).fontSize}})()`);
       assert.equal(bounds.bodyOverflow,false,JSON.stringify(bounds));assert.equal(bounds.sectionOverflow,false,JSON.stringify(bounds));assert.equal(bounds.statusFits,true,JSON.stringify(bounds));assert.ok(bounds.headerHeight<=50,JSON.stringify(bounds));assert.ok(bounds.bodyWidth<=1600,JSON.stringify(bounds));assert.equal(bounds.titleSize,'16px');assert.equal(bounds.columns,width<=800?1:2);
       const spacing=await js(`(()=>{const body=document.getElementById('settings-body'),columns=[...body.querySelectorAll(':scope > .settings-column')],stacks=columns.length?columns:[body],gaps=stacks.flatMap(column=>{const items=[...column.children].filter(section=>section.classList.contains('settings-section')&&section.getClientRects().length);return items.slice(1).map((section,index)=>section.getBoundingClientRect().top-items[index].getBoundingClientRect().bottom)}),widths=columns.flatMap(column=>[...column.children].filter(section=>section.classList.contains('settings-section')&&section.getClientRects().length).map(section=>section.getBoundingClientRect().width-column.getBoundingClientRect().width));return{columns:columns.length,gaps,widths}})()`);
       assert.equal(spacing.columns,width<=800?0:2,JSON.stringify(spacing));assert.ok(spacing.gaps.every(gap=>gap>=0&&gap<=20),JSON.stringify(spacing));assert.ok(spacing.widths.every(delta=>Math.abs(delta)<=1),JSON.stringify(spacing));
      await js(`document.getElementById('settings-update-section').scrollIntoView({block:'center'})`);await pause(60);
      fs.writeFileSync(path.join(captures,`settings-${windows?'windows':'mac'}-${width}x${height}-long-error.png`),(await win.webContents.capturePage()).toPNG());
      const top=await js(`document.querySelector('#settings-modal .modal-header').getBoundingClientRect().top`);assert.equal(top,bounds.headerTop,'only Settings body scrolls');
      layouts.push({windows,...bounds});
    }
    const checksBefore=calls.filter(c=>c.name==='release-check').length;
    const preview=createUpdateService({updater,store:{get:key=>saved.get(key),set:(key,value)=>saved.set(key,value),delete:key=>saved.delete(key)},packaged:true,configured:false,fetchNotes:async()=>notes,send:()=>{}});
    await preview.check();await preview.check(true);assert.equal(calls.filter(c=>c.name==='release-check').length,checksBefore);
    win.webContents.send('onUpdateStatus',preview.snapshot());await pause(80);
    assert.match(await js(`document.getElementById('settings-update-status').textContent`),/Local preview/);assert.equal(await hidden('check-update-btn'),true);assert.match(await js(`document.getElementById('settings-update-help').textContent`),/does not receive automatic updates/);
    await click('settings-smoothy-twitter-btn');assert.equal(calls.at(-1).args[0],'https://x.com/smoothyedit');
    await click('settings-twitter-btn');assert.equal(calls.at(-1).args[0],'https://x.com/alibahrawy34');
    for(const [kind,subject]of [['feedback','SmoothyEdit feedback'],['feature','SmoothyEdit feature request'],['bug','SmoothyEdit bug report']]){
      await js(`document.querySelector('[data-feedback-kind="${kind}"]').click()`);await pause(40);
      const url=new URL(calls.at(-1).args[0]);assert.equal(url.protocol,'mailto:');assert.equal(url.pathname,'support@smoothyedit.com');assert.equal(url.searchParams.get('subject'),subject);assert.match(url.searchParams.get('body'),/SmoothyEdit v2.0.0/);assert.doesNotMatch(url.searchParams.get('body'),/\/Users\/|fixture|@/);
      assert.equal(await hidden('settings-feedback-status'),true);
    }
    externalFailure=true;await js(`document.querySelector('[data-feedback-kind="feedback"]').click()`);await pause(80);assert.equal(await hidden('settings-feedback-status'),false);assert.match(await js(`document.getElementById('settings-feedback-status').textContent`),/Could not open/);assert.equal(await js(`document.querySelector('[data-feedback-kind="feedback"]').disabled`),false);
    externalFailure=false;await js(`document.querySelector('[data-feedback-kind="feedback"]').click()`);await pause(40);assert.equal(await hidden('settings-feedback-status'),true);
    for(const [width,height]of[[600,500],[1000,740],[1680,1050]]){
      win.setSize(width,height);win.webContents.send('onPlatformInfo',{isMac:true,isWindows:false,isExpanded:width>1000});await pause(80);await click('settings-btn');
      fs.writeFileSync(path.join(captures,`settings-mac-${width}x${height}-top.png`),(await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('settings-feedback-section').scrollIntoView({block:'center'})`);await pause(60);fs.writeFileSync(path.join(captures,`settings-mac-${width}x${height}-feedback.png`),(await win.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('#settings-modal .settings-body').scrollTop=0;document.getElementById('settings-close-btn').focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`);assert.equal(await js(`document.activeElement.id`),'show-logs-toggle');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);assert.equal(await hidden('settings-modal'),true);assert.equal(await js(`document.activeElement.id`),'settings-btn');
    assert.equal(calls.some(c=>/track|telemetry|featureUsage|sendFeedback/i.test(c.name)),false,'navigation creates no feature/submission events');
    fs.writeFileSync(path.join(captures,'settings-verification.json'),JSON.stringify({layouts,externalLinks:calls.filter(c=>c.name==='openExternal'),preview:preview.snapshot(),noRealMessages:true},null,2));
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Real Electron update lifecycle, local-preview guard, long-error containment, compact fixed header, 8 Mac/Windows layouts to 2560×1440, both X accounts, 3 feedback drafts/failure recovery, focus/Escape and zero submission/feature events passed.');
    win.destroy();app.quit();
  }catch(error){console.error(error);win.destroy();app.exit(1);}
});
