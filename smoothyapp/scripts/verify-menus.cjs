// Native Electron UI check for Smoothy's own dropdown menus (custom-select.js).
// Run: npm run build && npx electron scripts/verify-menus.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoothy-menus-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const captures = path.resolve(root, '..', 'docs/reviews/smoothyapp-menus'); fs.mkdirSync(captures, { recursive: true });
const methods = [...fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8').matchAll(/^  (\w+):/gm)].map(m => m[1]);
const preload = path.join(scratch, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');
const api=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,name.startsWith('on')?()=>{}:async()=>({})]));
Object.assign(api,{getAuthState:async()=>({user:null}),canUseFeature:async()=>({allowed:true}),getStatus:async()=>({connected:true,nle:'premiere'}),getActiveNLE:async()=>({activeNLE:'premiere'}),
 getWebsiteConnectionStatus:async()=>({connected:false}),getAppVersion:async()=>'3.0.0-dev.1',getCaptionModels:async()=>[],getCaptionLanguages:async()=>[],getBridgeStatus:async()=>({cep:{installed:true}})});
contextBridge.exposeInMainWorld('electronAPI',api);`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { preload, contextIsolation: true, backgroundThrottling: false } });
  const errors = []; win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(captures, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const centre = async (selector) => js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  const click = async ({ x, y }) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await pause(150);
  };
  const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(80); };
  try {
    await win.loadFile(path.join(root, 'out/renderer/index.html')); await pause(600); win.showInactive();
    await js(`window.__changes=[];document.addEventListener('change',e=>window.__changes.push(e.target.id),true)`);

    // Editor switcher: our menu opens instead of the macOS one, with logos.
    await click(await centre('#connection-status'));
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu').length`), 1, 'menu opens on click');
    assert.deepEqual(await js(`[...document.querySelectorAll('.smoothy-menu-item .smoothy-menu-label')].map(e=>e.textContent)`), ['Premiere Pro', 'DaVinci Resolve Free', 'Agentic editing']);
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu-item .smoothy-menu-icon').length`), 3, 'each editor has its logo');
    assert.equal(await js(`document.querySelector('.smoothy-menu').matches(':popover-open')`), true);
    await shot('editor-switcher');
    await click(await centre('.smoothy-menu-item[data-index="1"]'));
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu').length`), 0, 'menu closes after choosing');
    assert.equal(await js(`document.getElementById('multicam-editor').value`), 'resolve');
    assert.deepEqual(await js(`window.__changes`), ['multicam-editor'], 'a normal change event fires once');

    // Keyboard: open with ArrowDown, move, Escape closes without changing.
    await js(`document.getElementById('multicam-editor').focus()`);
    await key('Down');
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu').length`), 1, 'keyboard opens the menu');
    await key('Down'); await key('Escape');
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu').length`), 0);
    assert.equal(await js(`document.getElementById('multicam-editor').value`), 'resolve', 'Escape keeps the value');
    await key('Down'); await key('Down'); await key('Return');
    assert.equal(await js(`document.getElementById('multicam-editor').value`), 'agentic', 'Enter chooses');

    // A form select in a tool (Captions engine).
    await js(`document.querySelector('[data-tab="captions"]').click()`); await pause(250);
    await js(`document.getElementById('caption-engine-select').scrollIntoView({block:'center'})`); await pause(100);
    await click(await centre('#caption-engine-select'));
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu .smoothy-menu-item').length`), 3);
    await shot('captions-engine');
    // Clicking outside closes it.
    await click({ x: 900, y: 120 });
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu').length`), 0, 'outside click closes');

    // A select created later by a script also gets the menu.
    await js(`(()=>{const s=document.createElement('select');s.id='late';s.innerHTML='<optgroup label="Group"><option>One</option><option disabled>Two</option></optgroup><option hidden>Hidden</option><option>Three</option>';s.style.cssText='position:fixed;top:300px;left:600px;width:200px;z-index:2147483000';document.body.append(s)})()`);
    await click(await centre('#late'));
    assert.deepEqual(await js(`[...document.querySelectorAll('.smoothy-menu-item')].map(e=>e.textContent.trim())`), ['One', 'Two', 'Three'], 'hidden options are skipped');
    assert.equal(await js(`document.querySelectorAll('.smoothy-menu-group').length`), 1);
    await key('Down'); await key('Return');
    assert.equal(await js(`document.getElementById('late').value`), 'Three', 'disabled options are skipped');

    assert.deepEqual(errors, []);
    console.log('MENUS UI OK', captures);
    app.exit(0);
  } catch (error) {
    console.error(error); await shot('failure').catch(() => {}); console.error('console errors:', errors); app.exit(1);
  }
});
