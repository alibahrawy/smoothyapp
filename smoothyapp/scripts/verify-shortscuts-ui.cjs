// Native Electron UI fixture for ShortsCuts: no Premiere, network or real shortcuts are touched.
// Run: npm run build && npx electron scripts/verify-shortscuts-ui.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-shortscuts-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-shortscuts-deck'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const deck = [
  { id: 'vt', label: 'Video transition', kind: 'video-transition', target: '', edge: 'end', duration: 0.5, shortcut: 'CommandOrControl+Alt+1' },
  { id: 'at', label: 'Audio transition', kind: 'audio-transition', target: '', edge: 'end', duration: 0.5 },
  { id: 'crop', label: 'Crop', kind: 'video-effect', target: 'Crop', shortcut: 'CommandOrControl+Alt+3' },
  { id: 'blur', label: 'Gaussian Blur', kind: 'video-effect', target: 'Gaussian Blur' },
  { id: 'mosaic', label: 'Mosaic', kind: 'video-effect', target: 'Mosaic' },
  { id: 'lumetri', label: 'Lumetri Color', kind: 'video-effect', target: 'Lumetri Color', folderId: 'looks' },
  { id: 'denoise', label: 'DeNoise', kind: 'audio-effect', target: 'DeNoise', folderId: 'audio' },
  { id: 'eq', label: 'Parametric EQ', kind: 'audio-effect', target: 'Parametric Equalizer', folderId: 'audio' },
];
const config = { deck, folders: [{ id: 'looks', label: 'Looks' }, { id: 'audio', label: 'Audio', color: 'sky' }], layout: { phoneColumns: 3, tabletColumns: 5 }, serverEnabled: false, serverPort: 4789 };
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');const calls=[],callbacks={};
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?fn=>{(callbacks[name]||=[]).push(fn)}:async(...args)=>{calls.push({name,args});return {}}]));
let config=${JSON.stringify(config)};let pro=true;
const st=()=>({config,server:{running:false,port:null,urls:[],pageUrl:null,token:null,qrDataUrl:null,clients:0,lastAction:null,lastClientAt:null,error:null},shortcuts:[],connected:true,editor:'premiere',busy:false,locked:false,pro,freeKeys:6,lastResult:null});
Object.assign(api,{
 getAuthState:async()=>({user:{id:'pro',email:'pro@example.test',tier:'pro'}}),canUseFeature:async()=>({allowed:true}),getStatus:async()=>({connected:true,nle:'premiere'}),getActiveNLE:async()=>({activeNLE:'premiere'}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=>'2.2.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getBridgeStatus:async()=>({cep:{installed:true}}),
 shortscutsState:async()=>st(),
 shortscutsSaveDeck:async(v)=>{calls.push({name:'save',v});config={...config,deck:v.deck,folders:v.folders,layout:v.layout};return {success:true,state:st()}},
 shortscutsCatalog:async()=>({success:true,catalog:{videoEffects:['Crop','Gaussian Blur','Lumetri Color','Mirror','Mosaic','Ultra Key','Warp Stabilizer'],audioEffects:['DeNoise','Hard Limiter','Parametric Equalizer'],videoTransitions:['Cross Dissolve','Dip to Black','Push','Iris Round'],audioTransitions:['Constant Power','Exponential Fade']}}),
 shortscutsPresets:async()=>({success:true,presets:[{id:'p1',name:'Punch in 110%',folder:'My presets',animated:false},{id:'p2',name:'Zoom bounce',folder:'My presets',animated:true}]}),
 shortscutsApply:async()=>({success:true,message:'Applied.'}),
 __setPro:(value)=>{pro=value;for(const fn of callbacks.onShortsCutsState||[])fn(st())},
 __calls:()=>calls,__emit:(name,value)=>{for(const fn of callbacks[name]||[])fn(value)}
});contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(captures, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(500); win.showInactive();
    await win.webContents.insertCSS('* { animation: none !important; transition: none !important; }');
    await js(`document.querySelector('[data-tab="shortscuts"]').click()`); await pause(200);
    // Removed: connection pill, counts, three add buttons.
    for (const id of ['shortscuts-connection', 'shortscuts-count-assigned', 'shortscuts-add-effect', 'shortscuts-add-transition', 'shortscuts-add-preset']) assert.equal(await js(`!!document.getElementById('${id}')`), false, id);
    assert.doesNotMatch(await js(`document.getElementById('tab-shortscuts').innerText`), /Premiere connected|assigned/i);
    assert.equal(await js(`document.querySelectorAll('.shortscuts-row').length`), 8);
    // Root preview: 2 folders + 5 top-level keys.
    assert.equal(await js(`document.querySelectorAll('#shortscuts-device-grid .shortscuts-dkey').length`), 7);
    await shot('deck-phone');
    await js(`document.querySelector('#tab-shortscuts .content-scroll').scrollTop=document.getElementById('shortscuts-device').offsetTop-80`); await pause(80);
    await shot('layout-phone');
    // Select a key and customise it.
    await js(`document.querySelector('.shortscuts-dkey[data-id="blur"]').click()`); await pause(60);
    await js(`document.querySelector('[data-pick-icon="sparkle"]').click()`); await pause(60);
    await js(`document.querySelector('[data-pick-color="red"]').click()`); await pause(60);
    let saved = await js(`window.electronAPI.__calls().filter(c=>c.name==='save').at(-1).v.deck.find(i=>i.id==='blur')`);
    assert.equal(saved.icon, 'sparkle'); assert.equal(saved.color, 'red');
    await shot('inspector');
    // Open a folder.
    await js(`document.querySelector('.shortscuts-dkey[data-id="audio"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await pause(60);
    assert.equal(await js(`document.getElementById('shortscuts-device-title').textContent`), 'Audio');
    assert.equal(await js(`document.querySelectorAll('#shortscuts-device-grid .shortscuts-dkey').length`), 2);
    await js(`document.getElementById('shortscuts-device-back').click()`); await pause(40);
    // New multi-action.
    await js(`document.getElementById('shortscuts-new-multi').click()`); await pause(80);
    const multi = await js(`window.electronAPI.__calls().filter(c=>c.name==='save').at(-1).v.deck.at(-1)`);
    assert.equal(multi.kind, 'multi'); assert.equal(multi.steps.length, 1);
    await shot('multi-action');
    // Tablet preview with more columns.
    await js(`document.querySelector('.shortscuts-segmented [data-device="tablet"]').click()`); await pause(60);
    await js(`document.getElementById('shortscuts-cols-up').click()`); await pause(60);
    assert.equal(await js(`window.electronAPI.__calls().filter(c=>c.name==='save').at(-1).v.layout.tabletColumns`), 6);
    await shot('layout-tablet');
    // One Add picker with All / Effects / Transitions / Presets.
    await js(`document.getElementById('shortscuts-add').click()`); await pause(150);
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-catalog-tab]')].map(t=>t.textContent)`), ['All', 'Effects', 'Transitions', 'Presets']);
    assert.match(await js(`document.getElementById('shortscuts-catalog-list').innerText`), /Video effects[\s\S]*Audio effects[\s\S]*Video transitions[\s\S]*Premiere presets/i);
    await shot('add-all');
    await js(`document.querySelector('[data-catalog-tab="presets"]').click()`); await pause(60);
    assert.equal(await js(`document.getElementById('shortscuts-capture').classList.contains('hidden')`), false);
    await shot('add-presets');
    await js(`document.querySelector('[data-catalog-tab="effects"]').click();document.querySelector('.shortscuts-catalog-item[data-name="Ultra Key"]').click()`); await pause(80);
    assert.ok(await js(`window.electronAPI.__calls().filter(c=>c.name==='save').at(-1).v.deck.some(i=>i.target==='Ultra Key')`));
    assert.equal(await js(`document.getElementById('shortscuts-catalog-modal').classList.contains('hidden')`), false, 'picker stays open for more adds');
    await js(`document.getElementById('shortscuts-catalog-close').click()`); await pause(60);
    // Free plan: the first six keys work, the rest stay saved but off, and Add nudges to Pro.
    assert.equal(await js(`document.getElementById('shortscuts-plan').classList.contains('hidden')`), true, 'no plan bar on Pro');
    await js(`window.electronAPI.__setPro(false)`); await pause(120);
    assert.equal(await js(`document.getElementById('shortscuts-plan').classList.contains('hidden')`), false);
    assert.match(await js(`document.getElementById('shortscuts-plan-text').textContent`), /6 of 10 keys work/);
    assert.equal(await js(`document.querySelectorAll('.shortscuts-row.is-inactive').length`), 4);
    assert.equal(await js(`document.querySelectorAll('.shortscuts-row.is-inactive [data-action="apply"]:not([disabled])').length`), 0);
    await js(`document.getElementById('shortscuts-add').click()`); await pause(80);
    assert.equal(await js(`document.getElementById('shortscuts-catalog-modal').classList.contains('hidden')`), true, 'Add does not open past the free limit');
    await js(`document.querySelector('#tab-shortscuts .content-scroll').scrollTop=0`); await pause(60);
    await shot('free-plan');
    await js(`document.querySelector('#tab-shortscuts .content-scroll').scrollTop=document.getElementById('shortscuts-device').offsetTop-80`); await pause(80);
    await shot('free-plan-layout');
    await js(`window.electronAPI.__setPro(true)`); await pause(80);
    // Narrow window: no horizontal scroll.
    win.setSize(640, 760); await pause(150);
    assert.equal(await js(`document.documentElement.scrollWidth>innerWidth`), false);
    await shot('narrow');
    assert.deepEqual(errors, []);
    console.log('SHORTSCUTS UI OK', captures);
    app.exit(0);
  } catch (error) {
    console.error(error); await shot('failure').catch(() => {}); console.error('console errors:', errors); app.exit(1);
  }
});
